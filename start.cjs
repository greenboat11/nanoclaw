// CJS launcher for PM2 on Windows.
// Imports the ESM dist/index.js via dynamic import after setting env vars.
'use strict';

const path = require('path');

// Ensure cwd is always the project root regardless of how PM2 invokes us
process.chdir(__dirname);

// Set port before any module initializes
process.env.CREDENTIAL_PROXY_PORT = process.env.CREDENTIAL_PROXY_PORT || '3002';

// Tell dist/index.js to call main() — isDirectRun check uses argv[1] which
// points to this wrapper when launched by PM2, not to dist/index.js itself.
process.env.NANOCLAW_FORCE_RUN = '1';

// Synchronous crash logger — writes before pino-pretty worker can lose the message
const fs = require('fs');
function syncLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(path.join(__dirname, 'logs', 'crash.log'), line); } catch {}
}

process.on('uncaughtException', (err) => {
  syncLog('UNCAUGHT EXCEPTION: ' + (err && err.stack || err));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  syncLog('UNHANDLED REJECTION: ' + (reason && reason.stack || reason));
});

import('./dist/index.js').catch((err) => {
  syncLog('IMPORT ERROR: ' + (err && err.stack || err));
  process.exit(1);
});
