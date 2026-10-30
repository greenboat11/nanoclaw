/**
 * OpenRouter Agent Runner with MCP Tool Support for NanoClaw
 *
 * Uses OpenRouter's OpenAI-compatible API with function calling.
 * Connects to:
 *   - Gmail MCP  (read/send email)
 *   - Google Calendar MCP (events)
 *   - NanoClaw IPC MCP (send Telegram notifications)
 *   - Built-in memory tools (read/write persistent memory.md)
 *
 * Gracefully degrades to no-tool mode on 402/429 from free-tier providers.
 *
 * Input:  ContainerInput JSON via stdin
 * Output: ContainerOutput JSON wrapped in OUTPUT markers on stdout
 * IPC:    Follow-up messages polled from /workspace/ipc/input/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const HISTORY_FILE = '/workspace/group/openrouter-history.json';
const MEMORY_FILE = '/workspace/group/memory.md';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_HISTORY_MESSAGES = 40;
const MAX_TOOL_ROUNDS = 15;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenRouterChoice {
  message: { content: string | null; tool_calls?: ToolCall[] };
  finish_reason?: string;
}

interface OpenRouterResponse {
  choices: OpenRouterChoice[];
  error?: { message: string };
}

// ─── Logging / output ────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[openrouter-runner] ${msg}\n`);
}

function writeOutput(output: ContainerOutput): void {
  process.stdout.write(`${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`);
}

// ─── Built-in memory tools ────────────────────────────────────────────────────

const BUILTIN_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Read the persistent memory file. Use this to recall the user\'s preferences, topics of interest, important contacts, and anything else you\'ve been asked to remember across conversations.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description: 'Overwrite the persistent memory file with updated content. Use this to record user preferences, topics of interest, important contacts, recurring tasks, or anything else that should be remembered in future conversations. Write the full updated memory each time.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The full memory content in markdown format.' },
        },
        required: ['content'],
      },
    },
  },
];

function callBuiltinTool(name: string, args: Record<string, unknown>): string {
  if (name === 'read_memory') {
    if (!fs.existsSync(MEMORY_FILE)) return '(No memory saved yet)';
    return fs.readFileSync(MEMORY_FILE, 'utf-8');
  }
  if (name === 'write_memory') {
    const content = String(args.content ?? '');
    fs.writeFileSync(MEMORY_FILE, content);
    return 'Memory updated.';
  }
  return `Unknown built-in tool: ${name}`;
}

const BUILTIN_TOOL_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.function.name));

// ─── MCP Client ──────────────────────────────────────────────────────────────

interface McpClientEntry {
  client: Client;
  toolNames: Set<string>;
  tools: OpenAITool[];
}

async function connectMcpServer(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<McpClientEntry | null> {
  try {
    const transport = new StdioClientTransport({ command, args, env, stderr: 'ignore' });
    const client = new Client({ name: 'nanoclaw-openrouter', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const { tools: mcpTools } = await client.listTools();
    const tools: OpenAITool[] = mcpTools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      },
    }));
    const toolNames = new Set(mcpTools.map((t) => t.name));
    log(`MCP connected: ${command} — ${tools.length} tools`);
    return { client, toolNames, tools };
  } catch (err) {
    log(`MCP failed (${command}): ${err}`);
    return null;
  }
}

async function callMcpTool(
  clients: McpClientEntry[],
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  for (const entry of clients) {
    if (!entry.toolNames.has(name)) continue;
    try {
      const result = await entry.client.callTool({ name, arguments: args });
      const content = result.content;
      if (Array.isArray(content)) {
        return content
          .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
          .join('\n');
      }
      return JSON.stringify(content);
    } catch (err) {
      return `Tool error: ${err}`;
    }
  }
  return `Tool '${name}' not found`;
}

// ─── OpenRouter API ───────────────────────────────────────────────────────────

async function callOpenRouter(
  messages: ChatMessage[],
  tools: OpenAITool[],
  model: string,
  apiKey: string,
): Promise<OpenRouterResponse> {
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1';
  const isOpenRouter = baseUrl.includes('openrouter.ai');

  const body: Record<string, unknown> = { messages };
  if (tools.length > 0) { body.tools = tools; body.tool_choice = 'auto'; }

  // On OpenRouter, use native fallback routing so rate-limited models automatically
  // retry with the next model in the list — no custom retry logic needed.
  const fallbackModelsStr = isOpenRouter ? (process.env.OPENROUTER_FALLBACK_MODELS ?? '') : '';
  const fallbackModels = fallbackModelsStr.split(',').map((m) => m.trim()).filter(Boolean);
  if (isOpenRouter && fallbackModels.length > 0) {
    body.models = [model, ...fallbackModels];
    body.route = 'fallback';
  } else {
    body.model = model;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  // OpenRouter-specific headers (ignored by other providers)
  if (isOpenRouter) {
    headers['HTTP-Referer'] = 'https://github.com/qwibitai/nanoclaw';
    headers['X-Title'] = 'NanoClaw';
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as OpenRouterResponse;
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${data.error?.message ?? response.statusText}`);
  }
  return data;
}

// ─── Tool-use loop ────────────────────────────────────────────────────────────

async function runWithTools(
  messages: ChatMessage[],
  tools: OpenAITool[],
  mcpClients: McpClientEntry[],
  model: string,
  apiKey: string,
): Promise<string> {
  let round = 0;
  let toolsEnabled = tools.length > 0;

  while (round < MAX_TOOL_ROUNDS) {
    round++;
    log(`Round ${round} (${messages.length} msgs, tools=${toolsEnabled})`);

    let response: OpenRouterResponse;
    try {
      response = await callOpenRouter(messages, toolsEnabled ? tools : [], model, apiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429')) {
        // Rate limit — propagate so the host retry mechanism handles it with backoff
        throw err;
      }
      if (toolsEnabled && msg.includes('402')) {
        log('Degrading to no-tools mode (provider does not support function calling)');
        toolsEnabled = false;
        response = await callOpenRouter(messages, [], model, apiKey);
      } else {
        throw err;
      }
    }

    const choice = response.choices?.[0];
    if (!choice) throw new Error('No choices in OpenRouter response');

    const { content, tool_calls } = choice.message;

    if (!tool_calls || tool_calls.length === 0) {
      const text = content ?? '';
      if (!toolsEnabled && tools.length > 0) {
        return text + '\n\n_(Note: tools unavailable on this model/tier — try prefixing with `haiku` to upgrade)_';
      }
      return text;
    }

    log(`Tool calls: ${tool_calls.map((tc) => tc.function.name).join(', ')}`);
    messages.push({ role: 'assistant', content, tool_calls });

    for (const tc of tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* ignore */ }

      let result: string;
      if (BUILTIN_TOOL_NAMES.has(tc.function.name)) {
        result = callBuiltinTool(tc.function.name, args);
      } else {
        result = await callMcpTool(mcpClients, tc.function.name, args);
      }
      log(`${tc.function.name} → ${result.slice(0, 100)}`);

      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });
    }
  }

  throw new Error(`Exceeded max tool rounds (${MAX_TOOL_ROUNDS})`);
}

// ─── Conversation history ─────────────────────────────────────────────────────

function loadHistory(): ChatMessage[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as ChatMessage[];
  } catch { /* ignore */ }
  return [];
}

function saveHistory(messages: ChatMessage[]): void {
  try {
    const clean = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.tool_calls);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(clean.slice(-MAX_HISTORY_MESSAGES), null, 2));
  } catch { /* ignore */ }
}

// ─── System prompt ────────────────────────────────────────────────────────────

function loadSystemPrompt(isMain: boolean): string {
  const parts: string[] = [];
  const groupMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupMd)) parts.push(fs.readFileSync(groupMd, 'utf-8'));
  if (!isMain) {
    const globalMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalMd)) parts.push(fs.readFileSync(globalMd, 'utf-8'));
  }
  if (fs.existsSync(MEMORY_FILE)) {
    parts.push(`## Your memory (auto-loaded)\n${fs.readFileSync(MEMORY_FILE, 'utf-8')}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : 'You are a helpful assistant.';
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const msgs: string[] = [];
    for (const file of fs.readdirSync(IPC_INPUT_DIR).filter((f) => f.endsWith('.json')).sort()) {
      const fp = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8')) as { type: string; text?: string };
        fs.unlinkSync(fp);
        if (data.type === 'message' && data.text) msgs.push(data.text);
      } catch { /* ignore */ }
    }
    return msgs;
  } catch { return []; }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const msgs = drainIpcInput();
      if (msgs.length > 0) { resolve(msgs.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let input: ContainerInput;
  try {
    input = JSON.parse(await readStdin());
    log(`Input: group=${input.groupFolder}`);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err}` });
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'No API key set (OPENAI_API_KEY or OPENROUTER_API_KEY)' });
    process.exit(1);
  }

  const model = process.env.OPENROUTER_MODEL || 'gemini-2.0-flash';
  log(`Model: ${model}`);

  // ── Connect MCP servers ───────────────────────────────────────────────────
  log('Connecting MCP servers...');
  const mcpClients: McpClientEntry[] = [];

  const gmail = await connectMcpServer('npx', ['-y', '@gongrzhe/server-gmail-autoauth-mcp']);
  if (gmail) mcpClients.push(gmail);

  const gcal = await connectMcpServer(
    'npx', ['-y', '@cocal/google-calendar-mcp'],
    {
      GOOGLE_OAUTH_CREDENTIALS: '/home/node/.config/google-calendar-mcp/gcp-oauth.keys.json',
      GOOGLE_CALENDAR_MCP_TOKEN_PATH: '/home/node/.config/google-calendar-mcp/tokens.json',
    },
  );
  if (gcal) mcpClients.push(gcal);

  // NanoClaw IPC MCP — lets the agent send proactive Telegram messages
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  if (fs.existsSync(mcpServerPath)) {
    const ipc = await connectMcpServer('node', [mcpServerPath], {
      NANOCLAW_CHAT_JID: input.chatJid,
      NANOCLAW_GROUP_FOLDER: input.groupFolder,
      NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
    });
    if (ipc) mcpClients.push(ipc);
  }

  const mcpTools = mcpClients.flatMap((e) => e.tools);
  const allTools = [...BUILTIN_TOOLS, ...mcpTools];
  log(`Tools: ${allTools.length} total (${BUILTIN_TOOLS.length} built-in, ${mcpTools.length} MCP)`);

  // ── Setup ─────────────────────────────────────────────────────────────────
  const systemPrompt = loadSystemPrompt(input.isMain);
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  let prompt = input.isScheduledTask ? `[SCHEDULED TASK]\n\n${input.prompt}` : input.prompt;
  const pending = drainIpcInput();
  if (pending.length > 0) prompt += '\n' + pending.join('\n');

  // ── Message loop ──────────────────────────────────────────────────────────
  while (true) {
    log('Processing...');
    const history = loadHistory();
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: prompt },
    ];

    let reply: string;
    try {
      reply = await runWithTools(messages, allTools, mcpClients, model, apiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Error: ${msg}`);
      writeOutput({ status: 'error', result: null, error: msg });
      process.exit(1);
    }

    saveHistory([...history, { role: 'user', content: prompt }, { role: 'assistant', content: reply }]);
    log(`Reply: ${reply.length} chars`);
    writeOutput({ status: 'success', result: reply });

    const next = await waitForIpcMessage();
    if (next === null) { log('Closing'); break; }
    prompt = next;
  }
}

main();
