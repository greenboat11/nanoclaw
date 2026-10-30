# Windows-Specific Notes

This file documents Windows-specific fixes applied to NanoClaw. Review after `git pull` to ensure nothing was reverted.

---

## 1. Credential Proxy Port (Cloudflare WARP conflict)

**Problem:** Cloudflare WARP occupies `127.0.0.1:3001` on this machine, which is NanoClaw's default credential proxy port. This causes a crash loop on startup.

**Fix:** `.env` contains `CREDENTIAL_PROXY_PORT=3002`.

`src/config.ts` was patched to read `CREDENTIAL_PROXY_PORT` from `.env` via `readEnvFile` (previously it only read from `process.env`, which pm2 doesn't populate from `.env`):

```ts
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CREDENTIAL_PROXY_PORT',   // ← added for Windows
]);

export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || envConfig.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
```

**After a git pull:** Confirm `CREDENTIAL_PROXY_PORT` is still in the `readEnvFile` call in `src/config.ts`. If reverted, re-add it and rebuild.

---

## 2. PM2 isDirectRun Bug (Windows path format)

**Problem:** `index.ts` uses `new URL('file://' + process.argv[1])` to detect direct execution. On Windows, pm2 passes `argv[1]` as a backslash path (`C:\projects\nanoclaw\dist\index.js`), which makes `new URL()` throw `Invalid URL`. The process exits silently before calling `main()`, causing a pm2 crash loop.

**Fix:** `src/index.ts` uses `pathToFileURL` instead, and honours a `NANOCLAW_FORCE_RUN` env flag set by the pm2 launcher:

```ts
import { pathToFileURL } from 'url';
const isDirectRun =
  process.env.NANOCLAW_FORCE_RUN === '1' ||
  (process.argv[1] &&
    new URL(import.meta.url).pathname ===
      pathToFileURL(process.argv[1]).pathname);
```

**After a git pull:** Check the `isDirectRun` block at the bottom of `src/index.ts`. If reverted, re-apply and rebuild.

---

## 3. PM2 Launcher (start.cjs + ecosystem.config.cjs)

**Problem:** pm2 on Windows passes backslash `argv[1]` (see above) and doesn't read `.env`. Running `pm2 start dist/index.js` directly doesn't work reliably.

**Fix:** Two files in the project root handle pm2 startup:

- **`start.cjs`** — CJS wrapper launched by pm2. Sets `CREDENTIAL_PROXY_PORT` and `NANOCLAW_FORCE_RUN=1`, then dynamically imports `dist/index.js`. Also installs a synchronous crash logger to `logs/crash.log` so pre-pino errors aren't lost.
- **`ecosystem.config.cjs`** — pm2 ecosystem config. Points to `start.cjs`, sets restart delay and max restarts.

**To start/restart NanoClaw under pm2:**
```bash
cd C:\projects\nanoclaw
pm2 start ecosystem.config.cjs   # first time
pm2 restart nanoclaw              # subsequent restarts
pm2 save                          # persist after changes
```

**After a git pull:** These files are not part of upstream — they live only on this machine. Keep them.

---

## 4. container-runtime.ts — shell: line removed

**Problem:** The `ensureContainerRuntimeRunning` function had `shell: os.platform() === 'win32' ? 'cmd.exe' : undefined` added as a TypeScript fix, but the `ExecSyncOptions` type does not accept `string | undefined` for `shell` in a way that compiles cleanly.

**Fix:** The `shell:` line was removed entirely from that `execSync` call. Docker is found in PATH without needing an explicit shell on this machine.

---

## 5. Reboot Auto-Start

**How it works:** A Windows Startup shortcut at:
```
C:\Users\kylea\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\NanoClaw-PM2.lnk
```
runs `pm2 resurrect` on login, which restores all saved pm2 processes.

The pm2 process list is saved to `~/.pm2/dump.pm2`. Run `pm2 save` after any pm2 config changes.

**To recreate the shortcut** (e.g. after a fresh Windows install):
```bash
cd C:\projects\nanoclaw
node -e "require('child_process').spawnSync('powershell.exe', ['-ExecutionPolicy','Bypass','-File','setup-startup.ps1'], {stdio:'inherit'})"
```

---

## 6. .env Formatting

- No quotes around values. `ASSISTANT_NAME=radar_throgs` not `ASSISTANT_NAME="radar_throgs"` — `readEnvFile` does not strip quotes.
- `TELEGRAM_BOT_TOKEN` must be on a single line with no spaces.

---

## Quick Health Check

```bash
pm2 list                          # should show nanoclaw online, low restart count
node -e "require('net').createServer().on('error',()=>console.log('3002 IN USE')).on('listening',function(){console.log('3002 free');this.close()}).listen(3002,'127.0.0.1')"
cat logs/crash.log                # should be empty or absent
```
