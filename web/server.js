// ============================================================
// server.js — OpenClaw Web 管理面板 (docker/web)
// - Express on 3000
// - Auth: signed cookie + PBKDF2 (docker-config.json)
// - Keep legacy APIs: status/config/restart/openclaw/logs/trading
// - WebSocket: /api/ws/logs (tail gateway log), /api/ws/terminal (interactive shell)
// - Plugins market APIs: /api/plugins/list + /api/plugins/install
// - STT config APIs: /api/stt/config
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { URL } = require('url');
const { execSync, exec, spawn } = require('child_process');
const crypto = require('crypto');
const dns = require('dns');

// ── 关键修复：让 Node.js 的 fetch() 使用 dns.lookup（读 /etc/hosts），
//    而非 dns.resolve（只走 DNS 服务器，无法读 /etc/hosts）──
// Node.js 22 内置 fetch 基于 undici，但 undici 模块不直接暴露给 require。
// 解决方案：设置 dns.setDefaultResultOrder('verbatim') 并 patch dns 模块
// 让 Node.js 的默认 DNS 解析优先使用系统 resolver（读 /etc/hosts）
dns.setDefaultResultOrder('verbatim');

// 对于 Node.js >= 20，可以通过设置环境变量来让 fetch 走 lookup
// 实际生效方式：我们用 http.Agent/https.Agent 的 lookup 来覆盖，
// 但 fetch 不支持这些 agent。所以改为：在 DoH 阶段直接写 /etc/hosts，
// 并通过子进程调用 curl 来发起外部请求作为 fetch 的降级方案。

/**
 * 当 Node.js fetch() 因 DNS 无法解析而失败时，
 * 降级使用子进程 curl（curl 读 /etc/hosts）
 */
async function fetchWithFallback(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return resp;
  } catch (fetchErr) {
    // fetch failed (likely DNS), fallback to curl
    const curlArgs = ['-sf', '--connect-timeout', '5', '--max-time', '10', '-L'];
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        curlArgs.push('-H', `${k}: ${v}`);
      }
    }
    if (options.method === 'POST') {
      curlArgs.push('-X', 'POST');
      if (options.body) curlArgs.push('-d', typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    curlArgs.push(url);

    return new Promise((resolve, reject) => {
      exec(`curl ${curlArgs.map(a => `'${a}'`).join(' ')}`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`curl fallback failed: ${stderr || err.message}`));
        // Wrap curl output to look like a fetch Response
        resolve({
          ok: true,
          status: 200,
          text: async () => stdout,
          json: async () => JSON.parse(stdout),
        });
      });
    });
  }
}
console.log('[DNS] fetchWithFallback configured (curl fallback for DNS issues)');

// ── DNS-over-HTTPS 回退：当容器 DNS 不可用时（如 V2RayN TUN 模式），
//    通过 Cloudflare DoH 解析域名并注入 /etc/hosts ──
const DOH_CACHE = new Map();

async function dohResolve(hostname) {
  if (DOH_CACHE.has(hostname)) return DOH_CACHE.get(hostname);
  try {
    const resp = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { 'accept': 'application/dns-json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const aRecord = (data.Answer || []).find(a => a.type === 1);
    if (aRecord && aRecord.data) {
      DOH_CACHE.set(hostname, aRecord.data);
      // Also add to /etc/hosts for other processes (curl, etc.)
      try {
        const hosts = fs.readFileSync('/etc/hosts', 'utf8');
        if (!hosts.includes(hostname)) {
          fs.appendFileSync('/etc/hosts', `${aRecord.data} ${hostname}\n`);
          console.log(`[DoH] Resolved ${hostname} -> ${aRecord.data} (added to /etc/hosts)`);
        }
      } catch {}
      return aRecord.data;
    }
  } catch {}
  return null;
}

// Test DNS on startup; if broken, pre-resolve GitHub domains via DoH
(async () => {
  try {
    await dns.promises.resolve4('github.com');
  } catch {
    console.log('[DNS] Traditional DNS failed, using DNS-over-HTTPS fallback...');
    const domains = ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'];
    for (const d of domains) await dohResolve(d);
  }
})();

let WebSocketServer = null;
try {
  // eslint-disable-next-line global-require
  WebSocketServer = require('ws').WebSocketServer;
} catch {
  WebSocketServer = null;
}

const app = express();
app.set('trust proxy', true);

const terminalBackendState = {
  wsEnabled: !!WebSocketServer,
  ready: !!WebSocketServer,
  mode: 'unknown',
  reason: WebSocketServer ? '' : 'ws package not available',
  updatedAt: Date.now()
};

function setTerminalBackendState(patch = {}) {
  Object.assign(terminalBackendState, patch, { updatedAt: Date.now() });
}

const terminalWsTokens = new Map();

function issueTerminalWsToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  terminalWsTokens.set(token, { username, expireAt: Date.now() + 2 * 60 * 1000 });
  return token;
}

function consumeTerminalWsToken(token) {
  const key = String(token || '');
  if (!key) return false;
  const item = terminalWsTokens.get(key);
  if (!item) return false;
  terminalWsTokens.delete(key);
  return item.expireAt > Date.now();
}

// ------------------------
// Security headers
// ------------------------
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; frame-ancestors 'self'"
  );
  next();
});

const PORT = 3000;

const CONFIG_PATH = '/root/.openclaw/openclaw.json';
const WEB_AI_CONFIG_PATH = '/root/.openclaw/web-ai-config.json';
const DOCKER_CONFIG_PATH = '/root/.openclaw/docker-config.json';
const STT_CONFIG_PATH = '/root/.openclaw/stt-config.json';
const PLUGINS_STATE_PATH = '/root/.openclaw/plugins-state.json';
const OPENCLAW_SOURCE_INSTALL_META_PATH = '/root/.openclaw/openclaw-source-install.json';
const OPENCLAW_SOURCE_REPO_DEFAULT = 'openclaw/openclaw';
const OPENCLAW_SOURCE_ROOT = '/root/.openclaw/openclaw-source';
const OPENCLAW_SOURCE_ENTRY = `${OPENCLAW_SOURCE_ROOT}/openclaw.mjs`;
const OPENCLAW_CONFIG_BACKUP_DIR = '/root/.openclaw/config-backups';
const GATEWAY_RUNTIME_LOG_FILE = '/root/.openclaw/logs/openclaw-gateway.log';
const GATEWAY_LEGACY_LOG_FILE = '/root/.openclaw/logs/gateway.log';
const GATEWAY_WATCHDOG_LOG = '/root/.openclaw/logs/gateway-watchdog.log';
const WEB_PANEL_LOG_FILE = '/root/.openclaw/logs/web-panel.log';
const OPENCLAW_INSTALL_LOG_FILE = '/root/.openclaw/logs/openclaw-install.log';
const OPENCLAW_STATE_ROOT = '/root/.openclaw';
const OPENCLAW_LOCK_DIR = `${OPENCLAW_STATE_ROOT}/locks`;

const TRADING_DIR = '/root/trading-system';
const STRATEGY_PARAMS_PATH = path.join(TRADING_DIR, 'strategy_params.json');

app.use(express.json());

// ============================================================
// Helpers: JSON read/write
// ============================================================
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function ensureGatewayControlUiAccessForRequest(req) {
  let changed = false;
  try {
    const cfg = readJson(CONFIG_PATH, {});
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { changed: false, error: 'config-invalid' };

    const hostHeader = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
    const protoHeader = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim().toLowerCase();
    const hostname = (hostHeader.split(':')[0] || '').trim();
    if (!hostname) return { changed: false, error: 'host-empty' };

    cfg.gateway = cfg.gateway || {};
    cfg.gateway.controlUi = cfg.gateway.controlUi || {};

    const currentAllowed = Array.isArray(cfg.gateway.controlUi.allowedOrigins)
      ? cfg.gateway.controlUi.allowedOrigins.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const wantedOrigins = new Set();
    const hostCandidates = new Set([hostHeader, hostname]);
    hostCandidates.forEach((h) => {
      const safeHost = String(h || '').trim();
      if (!safeHost) return;
      wantedOrigins.add(`https://${safeHost}`);
      wantedOrigins.add(`http://${safeHost}`);
    });

    if (protoHeader === 'https') wantedOrigins.add(`https://${hostHeader || hostname}`);
    if (protoHeader === 'http') wantedOrigins.add(`http://${hostHeader || hostname}`);

    for (const origin of wantedOrigins) {
      if (!origin || currentAllowed.includes(origin)) continue;
      currentAllowed.push(origin);
      changed = true;
    }
    cfg.gateway.controlUi.allowedOrigins = currentAllowed;

    const currentTrusted = Array.isArray(cfg.gateway.trustedProxies)
      ? cfg.gateway.trustedProxies.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const requiredTrusted = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.17.0.1'];
    for (const proxyIp of requiredTrusted) {
      if (currentTrusted.includes(proxyIp)) continue;
      currentTrusted.push(proxyIp);
      changed = true;
    }
    cfg.gateway.trustedProxies = currentTrusted;

    if (changed) {
      const backupPath = `${CONFIG_PATH}.bak.gateway-control-ui-${Date.now()}`;
      try { fs.copyFileSync(CONFIG_PATH, backupPath); } catch {}
      writeJson(CONFIG_PATH, cfg);
    }

    return { changed, host: hostHeader || hostname };
  } catch (e) {
    return { changed: false, error: e?.message || 'unknown' };
  }
}

function repairOpenClawConfigProviders() {
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  if (!Object.prototype.hasOwnProperty.call(cfg, 'providers')) return false;

  const backupPath = `${CONFIG_PATH}.bak.providers-${Date.now()}`;
  try {
    fs.copyFileSync(CONFIG_PATH, backupPath);
  } catch {}

  delete cfg.providers;
  writeJson(CONFIG_PATH, cfg);
  console.log('[config] removed legacy providers from openclaw.json to keep gateway schema valid');
  return true;
}

function tailFile(filePath, lines = 200, timeoutMs = 2500) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return execSync(`tail -${Math.max(1, Math.min(lines, 5000))} "${filePath}"`, { encoding: 'utf8', timeout: timeoutMs });
  } catch {
    return '';
  }
}

function resolveGatewayLogFileForStreaming() {
  try {
    if (fs.existsSync(GATEWAY_RUNTIME_LOG_FILE) && fs.statSync(GATEWAY_RUNTIME_LOG_FILE).size > 0) {
      return GATEWAY_RUNTIME_LOG_FILE;
    }
  } catch {}
  if (fs.existsSync(GATEWAY_LEGACY_LOG_FILE)) return GATEWAY_LEGACY_LOG_FILE;
  return GATEWAY_LEGACY_LOG_FILE;
}

function readOpenClawGatewayLogs(lines = 200, { includeWatchdog = false } = {}) {
  const chunks = [];
  const sanitizeBlock = (text) => String(text || '')
    .split('\n')
    .map(sanitizeLogLine)
    .join('\n')
    .trim();
  const pushLabeledChunk = (label, text) => {
    const body = sanitizeBlock(text);
    if (!body) return;
    chunks.push(`[${label}]`);
    chunks.push(body);
  };
  const runtimeLog = tailFile(GATEWAY_RUNTIME_LOG_FILE, lines, 2500);
  if (runtimeLog.trim()) {
    pushLabeledChunk('gateway-runtime', runtimeLog);
  } else {
    const legacyLog = tailFile(GATEWAY_LEGACY_LOG_FILE, lines, 2500);
    if (legacyLog.trim()) pushLabeledChunk('gateway-legacy', legacyLog);
  }

  if (includeWatchdog) {
    const watchdogLog = tailFile(GATEWAY_WATCHDOG_LOG, lines, 2500);
    if (watchdogLog.trim()) pushLabeledChunk('watchdog', watchdogLog);
  }

  return chunks.join('\n');
}

function readGatewayLogTail(lines = 200) {
  return readOpenClawGatewayLogs(lines);
}

function detectInvalidConfigKeysFromText(text) {
  const source = String(text || '');
  const keys = new Set();
  const keyRegex = /Unrecognized key:\s*"([^"]+)"/g;
  let m;
  while ((m = keyRegex.exec(source)) !== null) {
    if (m[1]) keys.add(m[1]);
  }
  if (source.includes('Unrecognized key: "providers"')) keys.add('providers');
  return Array.from(keys);
}

function isGatewayDeviceAuthDisabled() {
  try {
    const cfg = readJson(CONFIG_PATH, null);
    return cfg?.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true;
  } catch {
    return false;
  }
}

function parseBracketTimestamp(line) {
  const match = String(line || '').match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  if (!match || !match[1]) return 0;
  const ts = Date.parse(match[1].replace(' ', 'T'));
  return Number.isFinite(ts) ? ts : 0;
}

function detectGatewayPairingRequiredRecent(logText, maxAgeSec = 600) {
  const lines = String(logText || '').split('\n');
  const pairingLines = lines.filter((line) => /pairing\s+required/i.test(line));
  if (!pairingLines.length) return false;
  const latest = pairingLines[pairingLines.length - 1];
  const latestTs = parseBracketTimestamp(latest);
  if (!latestTs) return true;
  return (Date.now() - latestTs) <= (Math.max(30, Number(maxAgeSec) || 600) * 1000);
}

function deleteConfigPath(obj, pathExpr) {
  const parts = String(pathExpr || '').split('.').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cursor || typeof cursor !== 'object') return false;
    cursor = cursor[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  if (!cursor || typeof cursor !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(cursor, leaf)) return false;
  delete cursor[leaf];
  return true;
}

function repairOpenClawConfigInvalidKeys(candidates = []) {
  const cfg = readJson(CONFIG_PATH, null);
  const result = { changed: false, removed: [], backupPath: '' };
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return result;

  const keys = Array.from(new Set((candidates || []).map((k) => String(k || '').trim()).filter(Boolean)));
  if (!keys.length) return result;

  for (const key of keys) {
    if (deleteConfigPath(cfg, key) || (Object.prototype.hasOwnProperty.call(cfg, key) && delete cfg[key])) {
      result.changed = true;
      result.removed.push(key);
    }
  }

  if (result.changed) {
    const backupPath = `${CONFIG_PATH}.bak.invalid-${Date.now()}`;
    try { fs.copyFileSync(CONFIG_PATH, backupPath); result.backupPath = backupPath; } catch {}
    writeJson(CONFIG_PATH, cfg);
  }

  return result;
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// ============================================================
// Docker config
// ============================================================
function readDockerConfig() {
  const cfg = readJson(DOCKER_CONFIG_PATH, {});
  if (typeof cfg.browserEnabled !== 'boolean') cfg.browserEnabled = false;
  return cfg;
}
function writeDockerConfig(cfg) {
  if (typeof cfg.browserEnabled !== 'boolean') cfg.browserEnabled = false;
  writeJson(DOCKER_CONFIG_PATH, cfg);
}

const GATEWAY_WATCHDOG_SCRIPT = '/usr/local/bin/openclaw-gateway-watchdog.sh';

function ensureGatewayWatchdog(callback) {
  const cmd = [
    'pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1 && exit 0',
    `[ -x "${GATEWAY_WATCHDOG_SCRIPT}" ] || exit 21`,
    `nohup bash "${GATEWAY_WATCHDOG_SCRIPT}" >> "${GATEWAY_WATCHDOG_LOG}" 2>&1 &`,
    'sleep 1',
    'pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1'
  ].join('\n');
  exec(`bash --noprofile --norc -lc '${cmd}'`, { env: { ...process.env, TERM: 'dumb' } }, callback);
}

function ensureOpenClawSourceEntryCompat() {
  try {
    const srcEntry = OPENCLAW_SOURCE_ENTRY;
    const distDir = path.join(OPENCLAW_SOURCE_ROOT, 'dist');
    if (!fs.existsSync(srcEntry) || !fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
      return { checked: false, repaired: false, reason: 'source-entry-or-dist-missing' };
    }

    const entryJs = path.join(distDir, 'entry.js');
    const entryMjs = path.join(distDir, 'entry.mjs');
    if (fs.existsSync(entryJs) || fs.existsSync(entryMjs)) {
      return { checked: true, repaired: false, reason: 'entry-exists' };
    }

    const indexJs = path.join(distDir, 'index.js');
    const indexMjs = path.join(distDir, 'index.mjs');
    if (fs.existsSync(indexJs)) {
      fs.symlinkSync('index.js', entryJs);
      return { checked: true, repaired: true, target: 'entry.js', source: 'index.js' };
    }
    if (fs.existsSync(indexMjs)) {
      fs.symlinkSync('index.mjs', entryMjs);
      return { checked: true, repaired: true, target: 'entry.mjs', source: 'index.mjs' };
    }

    return { checked: true, repaired: false, reason: 'index-missing' };
  } catch (e) {
    return { checked: true, repaired: false, reason: e?.message || 'unknown' };
  }
}

function restartGatewayForeground(callback) {
  repairOpenClawConfigProviders();
  const compat = ensureOpenClawSourceEntryCompat();
  if (compat?.repaired) {
    console.log(`[openclaw][start] repaired dist/${compat.target} -> ${compat.source}`);
  }
  ensureGatewayWatchdog((watchdogErr, watchdogStdout, watchdogStderr) => {
    if (watchdogErr) {
      return callback(watchdogErr, watchdogStdout, watchdogStderr);
    }

    const killCmd = 'pkill -f "[o]penclaw.*gateway" >/dev/null 2>&1 || true';
    exec(`bash --noprofile --norc -lc '${killCmd}'`, { env: { ...process.env, TERM: 'dumb' } }, callback);
  });
}

function stripAnsi(input) {
  return String(input || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function compactOutput(input) {
  const text = stripAnsi(input)
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function runCommandOk(cmd, timeoutMs = 1500) {
  try {
    execSync(cmd, { stdio: 'ignore', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function runCommandText(cmd, timeoutMs = 2500) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs }).trim();
  } catch {
    return '';
  }
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function runOpenClawCli(command, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const escaped = String(command).replace(/'/g, `"'"'`);
    const defaultPath = '/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin';
    const mergedPath = process.env.PATH ? `${process.env.PATH}:${defaultPath}` : defaultPath;
      exec(`bash --noprofile --norc -lc '${escaped}'`, { timeout: timeoutMs, env: { ...process.env, TERM: 'dumb', PATH: mergedPath } }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const errText = String(stderr || '');
      const output = `${out}${errText}`;
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: out, stderr: errText, output, error: err });
    });
  });
}

function runOpenClawCliWithPtyInput(command, inputText = '', timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (!runCommandOk('command -v script >/dev/null 2>&1', 800)) {
      resolve({ ok: false, code: 1, output: 'script 命令不可用，无法执行需要 TTY 的登录/令牌写入流程' });
      return;
    }

    const child = spawn('script', ['-qf', '-c', command, '/dev/null'], {
      env: { ...process.env, TERM: 'xterm-256color' },
      cwd: '/root'
    });

    let output = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 1, output: `${output}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? 1, output });
    });

    if (inputText) {
      try { child.stdin.write(`${inputText}\n`); } catch {}
    }
    try { child.stdin.end(); } catch {}
  });
}

function parseOpenClawVersion(text) {
  const raw = compactOutput(text || '');
  if (!raw) return '';

  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/(?:openclaw@|version\s*)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
    if (m && m[1]) return `v${m[1]}`;
  }

  return '';
}

function readVersionFromPackageJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parseOpenClawVersion(parsed?.version || '');
  } catch {
    return '';
  }
}

function parseGitHubRepo(input) {
  const text = String(input || '').trim();
  if (!text) return '';

  const direct = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) return `${direct[1]}/${direct[2]}`;

  const gh = text.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (gh) return `${gh[1]}/${gh[2]}`;
  return '';
}

const openClawSourceRepoCache = {
  repo: parseGitHubRepo(process.env.OPENCLAW_SOURCE_REPO || '') || '',
  checkedAt: 0
};

function resolveOpenClawSourceRepo(force = false) {
  const now = Date.now();
  if (!force && openClawSourceRepoCache.repo && (now - openClawSourceRepoCache.checkedAt) < 10 * 60 * 1000) {
    return openClawSourceRepoCache.repo;
  }

  let repo = parseGitHubRepo(process.env.OPENCLAW_SOURCE_REPO || '');
  if (!repo) {
    repo = parseGitHubRepo(runCommandText('npm view openclaw repository.url --registry=https://registry.npmjs.org 2>/dev/null', 2500));
  }
  if (!repo) repo = OPENCLAW_SOURCE_REPO_DEFAULT;

  openClawSourceRepoCache.repo = repo;
  openClawSourceRepoCache.checkedAt = now;
  return repo;
}

async function getLatestOpenClawRelease(repo) {
  const safeRepo = parseGitHubRepo(repo) || OPENCLAW_SOURCE_REPO_DEFAULT;
  const apiUrl = `https://api.github.com/repos/${safeRepo}/releases/latest`;
  const resp = await fetchWithFallback(apiUrl, {
    headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'openclaw-pro' },
    timeout: 12000
  });
  if (!resp || !resp.ok) {
    throw new Error(`无法获取 ${safeRepo} release 信息`);
  }
  const release = await resp.json();
  const tag = String(release?.tag_name || '').trim();
  if (!tag) throw new Error(`release tag 为空 (${safeRepo})`);
  const assets = Array.isArray(release?.assets)
    ? release.assets
      .map((item) => ({
        name: String(item?.name || '').trim(),
        url: String(item?.browser_download_url || '').trim(),
        size: Number(item?.size || 0),
        contentType: String(item?.content_type || '').trim()
      }))
      .filter((item) => item.name && item.url)
    : [];

  const encodedTag = encodeURIComponent(tag);
  const tarballUrl = `https://codeload.github.com/${safeRepo}/tar.gz/refs/tags/${encodedTag}`;
  const binaryAsset = pickOpenClawReleaseBinaryAsset(assets);
  return {
    repo: safeRepo,
    tag,
    tarballUrl,
    assets,
    binaryAsset,
    publishedAt: release?.published_at || '',
    name: release?.name || tag
  };
}

function pickOpenClawReleaseBinaryAsset(assets) {
  if (!Array.isArray(assets) || !assets.length) return null;
  const candidates = assets
    .map((asset) => {
      const name = String(asset?.name || '');
      const lower = name.toLowerCase();
      if (!name || !asset?.url) return null;
      if (/(source\s*code|checksum|sha256|sig|signature|dsym|debug|symbols?)/i.test(lower)) return null;
      if (!/(\.tar\.gz|\.tgz|\.zip)$/i.test(lower)) return null;
      if (/(windows|\.exe$|\.msi$|darwin|macos|osx)/i.test(lower)) return null;
      if (!/(linux|gnu|musl)/i.test(lower)) return null;
      let score = 0;
      if (/openclaw/i.test(lower)) score += 8;
      if (/linux/i.test(lower)) score += 6;
      if (/(amd64|x64|x86_64)/i.test(lower)) score += 6;
      if (/arm64|aarch64/i.test(lower)) score -= 3;
      if (/\.tar\.gz$|\.tgz$/i.test(lower)) score += 3;
      if (/\.zip$/i.test(lower)) score += 1;
      return {
        ...asset,
        score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function getInstalledOpenClawVersion() {
  const versions = [];
  const collectVersion = (value) => {
    const parsed = parseOpenClawVersion(value || '');
    if (parsed) versions.push(parsed);
  };

  const packagePaths = [
    '/root/.openclaw/openclaw-source/package.json',
    '/root/.npm-global/lib/node_modules/openclaw/package.json',
    '/usr/local/lib/node_modules/openclaw/package.json',
    '/usr/lib/node_modules/openclaw/package.json'
  ];

  for (const packagePath of packagePaths) {
    collectVersion(readVersionFromPackageJson(packagePath));
  }

  const candidates = [
    runCommandText('node /root/.openclaw/openclaw-source/openclaw.mjs --version 2>&1 || node /root/.openclaw/openclaw-source/openclaw.mjs -v 2>&1 || true', 2600),
    runCommandText('/root/.npm-global/bin/openclaw --version 2>&1 || true', 2200),
    runCommandText('openclaw --version 2>&1 || true', 1800),
    runCommandText('bash --noprofile --norc -lc "openclaw --version 2>&1 || true"', 2000),
    runCommandText("node -e 'try{const p=require(\"/root/.npm-global/lib/node_modules/openclaw/package.json\"); console.log(p.version||\"\")}catch(e){}'", 1800),
    runCommandText("node -e 'try{const cp=require(\"child_process\");const out=cp.execSync(\"npm list -g openclaw --depth=0 --json\",{stdio:[\"ignore\",\"pipe\",\"ignore\"]}).toString();const j=JSON.parse(out||\"{}\");const v=j&&j.dependencies&&j.dependencies.openclaw&&j.dependencies.openclaw.version; if(v) console.log(v);}catch(e){}'", 2400),
    runCommandText("node -e 'try{const cp=require(\"child_process\");const root=cp.execSync(\"npm root -g\",{stdio:[\"ignore\",\"pipe\",\"ignore\"]}).toString().trim();if(!root) process.exit(0);const p=require(root+\"/openclaw/package.json\"); if(p&&p.version) console.log(p.version);}catch(e){}'", 2400)
  ];

  for (const output of candidates) {
    collectVersion(output);
  }

  if (!versions.length) return '';

  let newest = versions[0];
  for (const version of versions.slice(1)) {
    if (compareSemver(version, newest) > 0) {
      newest = version;
    }
  }

  return newest;
}

function isOpenClawInstalledByPath() {
  return runCommandOk('command -v openclaw >/dev/null 2>&1', 1500)
    || runCommandOk('bash --noprofile --norc -lc "command -v openclaw >/dev/null 2>&1"', 1800)
    || runCommandOk('test -x /root/.npm-global/bin/openclaw || test -x /usr/local/bin/openclaw || test -x /usr/bin/openclaw || test -x /opt/homebrew/bin/openclaw || test -f /root/.openclaw/openclaw-source/openclaw.mjs', 1200);
}

function isOpenClawInstalledByNpmPackage() {
  return runCommandOk('npm list -g openclaw --depth=0 >/dev/null 2>&1', 2200)
    || runCommandOk('npm root -g 2>/dev/null | xargs -I{} test -f "{}/openclaw/package.json"', 2500);
}

function getOpenClawSourceInstallMeta() {
  const meta = readJson(OPENCLAW_SOURCE_INSTALL_META_PATH, null);
  if (!meta || typeof meta !== 'object') return null;
  const tag = String(meta.tag || '').trim();
  const repo = parseGitHubRepo(meta.repo || '') || '';
  const installedAt = String(meta.installedAt || '').trim();
  const parsedVersion = parseOpenClawVersion(tag || '');
  if (!tag && !repo && !installedAt) return null;
  return {
    tag,
    repo,
    installedAt,
    version: parsedVersion || ''
  };
}

const openClawInstallCache = {
  snapshot: null,
  checkedAt: 0
};
const OPENCLAW_INSTALL_CACHE_TTL_MS = 20000;

function detectOpenClawInstallation() {
  const version = getInstalledOpenClawVersion();
  if (version) {
    return { installed: true, version, source: 'version' };
  }

  const sourceMeta = getOpenClawSourceInstallMeta();
  if (sourceMeta) {
    return { installed: true, version: sourceMeta.version || '', source: 'source' };
  }

  if (isOpenClawInstalledByPath()) {
    return { installed: true, version: '', source: 'binary' };
  }

  if (isOpenClawInstalledByNpmPackage()) {
    return { installed: true, version: '', source: 'npm' };
  }

  return { installed: false, version: '', source: 'none' };
}

function getOpenClawInstallationSnapshot(force = false) {
  const now = Date.now();
  if (!force && openClawInstallCache.snapshot && (now - openClawInstallCache.checkedAt) < OPENCLAW_INSTALL_CACHE_TTL_MS) {
    return openClawInstallCache.snapshot;
  }
  const snapshot = detectOpenClawInstallation();
  openClawInstallCache.snapshot = snapshot;
  openClawInstallCache.checkedAt = now;
  return snapshot;
}

function normalizeSemver(version) {
  const s = String(version || '').trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || ''
  };
}

function compareSemver(a, b) {
  const va = normalizeSemver(a);
  const vb = normalizeSemver(b);
  if (!va || !vb) return 0;

  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;

  if (!va.pre && vb.pre) return 1;
  if (va.pre && !vb.pre) return -1;
  if (va.pre === vb.pre) return 0;
  return va.pre > vb.pre ? 1 : -1;
}

async function getLatestOpenClawVersion(timeoutMs = 2500) {
  const repo = resolveOpenClawSourceRepo();
  const rel = await getLatestOpenClawRelease(repo);
  return parseOpenClawVersion(rel.tag || '');
}

const latestOpenClawVersionCache = {
  version: '',
  error: '',
  checking: false,
  updatedAt: 0,
  lastAttemptAt: 0
};
const LATEST_VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
const LATEST_VERSION_ATTEMPT_GAP_MS = 30 * 1000;

async function refreshLatestOpenClawVersionCache({ force = false } = {}) {
  const now = Date.now();
  if (latestOpenClawVersionCache.checking) return;
  if (!force && latestOpenClawVersionCache.updatedAt && (now - latestOpenClawVersionCache.updatedAt) < LATEST_VERSION_CACHE_TTL_MS) return;
  if (!force && latestOpenClawVersionCache.lastAttemptAt && (now - latestOpenClawVersionCache.lastAttemptAt) < LATEST_VERSION_ATTEMPT_GAP_MS) return;

  latestOpenClawVersionCache.checking = true;
  latestOpenClawVersionCache.lastAttemptAt = now;
  try {
    const version = await getLatestOpenClawVersion(2500);
    if (version) {
      latestOpenClawVersionCache.version = version;
      latestOpenClawVersionCache.error = '';
      latestOpenClawVersionCache.updatedAt = Date.now();
    } else {
      latestOpenClawVersionCache.error = '无法连接版本源';
      if (!latestOpenClawVersionCache.updatedAt) latestOpenClawVersionCache.updatedAt = Date.now();
    }
  } catch (e) {
    latestOpenClawVersionCache.error = e?.message || String(e || '版本检查失败');
    if (!latestOpenClawVersionCache.updatedAt) latestOpenClawVersionCache.updatedAt = Date.now();
  } finally {
    latestOpenClawVersionCache.checking = false;
  }
}

function createTerminalShell() {
  const hasBash = runCommandOk('command -v bash >/dev/null 2>&1', 800);
  if (!hasBash) {
    return { shell: null, mode: 'unavailable', reason: 'bash not found' };
  }

  const terminalRcPath = '/tmp/openclaw-terminal.bashrc';
  try {
    const rcContent = [
      'export TERM=xterm-256color',
      'export COLORTERM=truecolor',
      'export CLICOLOR=1',
      'export CLICOLOR_FORCE=1',
      'if command -v dircolors >/dev/null 2>&1; then',
      '  eval "$(dircolors -b 2>/dev/null)" || true',
      'fi',
      'if ls --color=always -d . >/dev/null 2>&1; then',
      "  alias ls='ls --color=always'",
      'elif ls -G -d . >/dev/null 2>&1; then',
      "  alias ls='ls -G'",
      'fi',
      'if grep --color=always "" </dev/null >/dev/null 2>&1; then',
      "  alias grep='grep --color=always'",
      "  alias egrep='egrep --color=always'",
      "  alias fgrep='fgrep --color=always'",
      'fi',
      "PS1='\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '",
      'export PS1'
    ].join('\n');
    const old = fs.existsSync(terminalRcPath) ? fs.readFileSync(terminalRcPath, 'utf8') : '';
    if (old !== rcContent) {
      fs.writeFileSync(terminalRcPath, rcContent, { mode: 0o600 });
    }
  } catch {}

  const shellEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLUMNS: '220',
    LINES: '60',
    SHELL: '/bin/bash',
    HOME: '/root',
    BASH_ENV: '',
    ENV: ''
  };

  const startupCmd = `stty cols 220 rows 60 >/dev/null 2>&1 || true; exec bash --noprofile --rcfile ${terminalRcPath} -i`;

  const useScriptPty = runCommandOk('command -v script >/dev/null 2>&1', 800);
  if (useScriptPty) {
    return {
      shell: spawn('script', ['-qf', '-c', startupCmd, '/dev/null'], {
        env: shellEnv,
        cwd: '/root'
      }),
      mode: 'pty',
      reason: ''
    };
  }

  return {
    shell: spawn('bash', ['--noprofile', '--norc', '-ic', startupCmd], {
      env: shellEnv,
      cwd: '/root'
    }),
    mode: 'fallback',
    reason: 'script not found; using bash fallback'
  };
}

function tryResizePtyShell(shell, cols, rows) {
  const c = Math.max(40, Number(cols) || 80);
  const r = Math.max(12, Number(rows) || 24);
  try {
    const shellPid = Number(shell?.pid || 0);
    if (!shellPid) return false;
    let ttyPath = '';
    try {
      const fdDir = `/proc/${shellPid}/fd`;
      const entries = fs.readdirSync(fdDir);
      for (const fd of entries) {
        try {
          const target = fs.readlinkSync(`${fdDir}/${fd}`);
          if (target && target.startsWith('/dev/pts/')) {
            ttyPath = target;
            break;
          }
        } catch {}
      }
    } catch {}
    if (!ttyPath) return false;
    try {
      execFileSync('stty', ['cols', String(c), 'rows', String(r), '-F', ttyPath], {
        stdio: 'ignore',
        timeout: 1200
      });
    } catch {
      execSync(`stty cols ${c} rows ${r} < "${ttyPath}" >/dev/null 2>&1 || true`, { stdio: 'ignore', timeout: 1200 });
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// PBKDF2 password
// ============================================================
function pbkdf2HashPassword(password, opts = {}) {
  const iter = opts.iter || 150000;
  const digest = opts.digest || 'sha256';
  const salt = opts.salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), iter, 32, digest).toString('hex');
  return { algo: 'pbkdf2', iter, digest, salt, hash };
}

function verifyPassword(password, stored) {
  if (!stored || stored.algo !== 'pbkdf2' || !stored.salt || !stored.hash || !stored.iter || !stored.digest) return false;
  const computed = crypto.pbkdf2Sync(password, Buffer.from(stored.salt, 'hex'), stored.iter, 32, stored.digest).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(stored.hash, 'hex'));
  } catch {
    return false;
  }
}

// ============================================================
// Signed cookie session
// ============================================================
const COOKIE_NAME = 'oc_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}
function sign(data, secret) {
  return base64urlEncode(crypto.createHmac('sha256', secret).update(data).digest());
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isHttpsRequest(req) {
  if (req.secure) return true;
  const proto = (req.headers['x-forwarded-proto'] || '').toString().toLowerCase();
  return proto === 'https';
}

function setSessionCookie(res, payloadObj, secret, { secure } = {}) {
  const payload = base64urlEncode(JSON.stringify(payloadObj));
  const sig = sign(payload, secret);
  const value = `${payload}.${sig}`;
  const maxAge = SESSION_TTL_MS / 1000;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${Math.floor(maxAge)}`,
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, { secure } = {}) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function getSession(req, secret) {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;

  const expected = sign(payload, secret);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let obj;
  try {
    obj = JSON.parse(base64urlDecode(payload).toString('utf8'));
  } catch {
    return null;
  }

  if (!obj || !obj.u || !obj.exp) return null;
  if (Date.now() > obj.exp) return null;
  return obj;
}

// ============================================================
// Bootstrap auth config
// ============================================================
function ensureWebAuthConfig() {
  const cfg = readDockerConfig();
  cfg.webAuth = cfg.webAuth || {};

  if (!cfg.webAuth.secret) cfg.webAuth.secret = crypto.randomBytes(32).toString('hex');
  cfg.webAuth.users = cfg.webAuth.users || {};
  // 不要写入默认弱口令：首次访问需要先完成初始化设置密码
  cfg.webAuth.setupRequired = !cfg.webAuth.users.admin;

  writeDockerConfig(cfg);
  return cfg;
}

let dockerConfig = ensureWebAuthConfig();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof xff === 'string' && xff.trim()) ip = xff.split(',')[0].trim();
  else if (Array.isArray(xff) && xff.length) ip = String(xff[0]).split(',')[0].trim();
  if (!ip) ip = req.ip || req.connection?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  if (ip === '::1') ip = '127.0.0.1';
  return ip || 'unknown';
}

// ============================================================
// Login rate limiting (per IP)
// ============================================================
const loginFailures = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

function getFailureState(ip) {
  const now = Date.now();
  let st = loginFailures.get(ip);
  if (!st) {
    st = { fails: 0, lockUntil: 0, lastAt: 0 };
    loginFailures.set(ip, st);
  }
  if (st.fails === 0 && st.lockUntil === 0 && now - st.lastAt > 60 * 60 * 1000) {
    loginFailures.delete(ip);
    return { fails: 0, lockUntil: 0, lastAt: now };
  }
  return st;
}

function recordLoginFailure(ip) {
  const st = getFailureState(ip);
  st.fails = (st.fails || 0) + 1;
  st.lastAt = Date.now();
  if (st.fails >= MAX_FAILS) st.lockUntil = Date.now() + LOCK_MS;
  loginFailures.set(ip, st);
  return st;
}

function recordLoginSuccess(ip) {
  loginFailures.delete(ip);
}

// ============================================================
// Auth gate
// ============================================================
function isAuthenticated(req) {
  dockerConfig = readDockerConfig();
  const secret = dockerConfig.webAuth?.secret;
  if (!secret) return false;
  const sess = getSession(req, secret);
  if (!sess) return false;
  return !!dockerConfig.webAuth?.users?.[sess.u];
}

function requireAuthApi(req, res, next) {
  if (req.path === '/login') return next();
  if (req.path === '/bootstrap/status') return next();
  if (req.path === '/bootstrap/setup') return next();
  // Allow hotpatch from localhost (docker exec)
  if (req.path.startsWith('/update/hotpatch')) {
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  }
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function requireAuthPage(req, res, next) {
  const allow = new Set(['/login.html', '/login.js', '/style.css']);
  if (allow.has(req.path)) return next();

  const wantsHtml = req.path === '/' || req.path.endsWith('.html');
  if (!wantsHtml) return next();

  if (!isAuthenticated(req)) return res.redirect('/login.html');
  next();
}

function gatewayProxyPathFromOriginalUrl(originalUrl) {
  const withoutPrefix = String(originalUrl || '').replace(/^\/gateway-proxy/, '');
  return withoutPrefix || '/';
}

function rewriteGatewayLocationHeader(location, gatewayPort) {
  const value = String(location || '');
  if (!value) return value;
  const localhostPrefix = `http://127.0.0.1:${gatewayPort}`;
  const localhostAltPrefix = `http://localhost:${gatewayPort}`;
  if (value.startsWith(localhostPrefix)) {
    return `/gateway-proxy${value.slice(localhostPrefix.length) || '/'}`;
  }
  if (value.startsWith(localhostAltPrefix)) {
    return `/gateway-proxy${value.slice(localhostAltPrefix.length) || '/'}`;
  }
  if (value.startsWith('/')) {
    return `/gateway-proxy${value}`;
  }
  return value;
}

function proxyGatewayRequest(req, res) {
  const cfg = readDockerConfig();
  const gatewayPort = Number(cfg.port || 18789) || 18789;
  const upstreamPath = gatewayProxyPathFromOriginalUrl(req.originalUrl || req.url);
  const externalHost = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${gatewayPort}`).split(',')[0].trim() || `127.0.0.1:${gatewayPort}`;

  const headers = { ...req.headers };
  delete headers.connection;
  delete headers['content-length'];
  headers.host = externalHost;

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: gatewayPort,
    method: req.method,
    path: upstreamPath,
    headers,
    timeout: 15000
  }, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    if (responseHeaders.location) {
      responseHeaders.location = rewriteGatewayLocationHeader(responseHeaders.location, gatewayPort);
    }
    res.writeHead(proxyRes.statusCode || 502, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error('gateway upstream timeout'));
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).send(`Gateway 不可用：${err.message}`);
      return;
    }
    try { res.end(); } catch {}
  });

  if (req.method === 'GET' || req.method === 'HEAD') {
    req.pipe(proxyReq);
    return;
  }

  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    const bodyText = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Type', 'application/json');
    proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyText));
    proxyReq.end(bodyText);
    return;
  }

  req.pipe(proxyReq);
}

function isGatewayProxyUpgradePath(url) {
  const u = String(url || '');
  return u === '/gateway-proxy' || u.startsWith('/gateway-proxy/');
}

function buildUpgradeRequestText(req, upstreamPath, gatewayPort) {
  let requestText = `${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n`;
  const externalHost = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${gatewayPort}`).split(',')[0].trim() || `127.0.0.1:${gatewayPort}`;
  const skipped = new Set(['host', 'connection', 'upgrade', 'proxy-connection']);
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (!key || value === undefined) continue;
    if (skipped.has(String(key).toLowerCase())) continue;
    requestText += `${key}: ${value}\r\n`;
  }
  requestText += `Host: ${externalHost}\r\n`;
  requestText += 'Connection: Upgrade\r\n';
  requestText += 'Upgrade: websocket\r\n\r\n';
  return requestText;
}

app.use(requireAuthPage);

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || /\.(html|js|css)$/i.test(req.path || ''))) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.get('/gateway', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login.html');
  res.redirect('/gateway-proxy/');
});

app.use('/gateway-proxy', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login.html');
  proxyGatewayRequest(req, res);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', requireAuthApi);

app.get('/api/terminal/ws-token', (req, res) => {
  const secret = readDockerConfig().webAuth?.secret;
  const sess = secret ? getSession(req, secret) : null;
  const username = sess?.u || 'admin';
  const token = issueTerminalWsToken(username);
  res.json({ token, expiresInSec: 120 });
});

// ============================================================
// API: bootstrap (首次设置密码)
// ============================================================
app.get('/api/bootstrap/status', (req, res) => {
  dockerConfig = readDockerConfig();
  const setupRequired = !dockerConfig.webAuth?.users?.admin;
  res.json({ setupRequired });
});

app.post('/api/bootstrap/setup', (req, res) => {
  dockerConfig = readDockerConfig();
  if (dockerConfig.webAuth?.users?.admin) return res.status(409).json({ error: '已初始化' });

  const { password } = req.body || {};
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: '请设置至少8位的管理密码' });
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return res.status(400).json({ error: '密码需包含大写字母、小写字母、数字和特殊字符' });
  }

  dockerConfig.webAuth = dockerConfig.webAuth || {};
  dockerConfig.webAuth.users = dockerConfig.webAuth.users || {};
  dockerConfig.webAuth.users.admin = {
    username: 'admin',
    password: pbkdf2HashPassword(password),
    createdAt: new Date().toISOString()
  };
  dockerConfig.webAuth.setupRequired = false;
  writeDockerConfig(dockerConfig);

  // setup 后自动登录
  const secret = dockerConfig.webAuth.secret;
  setSessionCookie(res, { u: 'admin', exp: Date.now() + SESSION_TTL_MS }, secret, { secure: isHttpsRequest(req) });
  res.json({ success: true });
});

// ============================================================
// Openclaw config helpers
// ============================================================
function readConfig() {
  return readJson(WEB_AI_CONFIG_PATH, {});
}
function writeConfig(config) {
  writeJson(WEB_AI_CONFIG_PATH, config);
}

// ============================================================
// API: auth
// ============================================================
app.post('/api/login', (req, res) => {
  dockerConfig = readDockerConfig();
  const secret = dockerConfig.webAuth?.secret;
  const ip = getClientIp(req);
  const st = getFailureState(ip);

  if (st.lockUntil && Date.now() < st.lockUntil) {
    const remainSec = Math.ceil((st.lockUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `登录失败过多，已锁定。请 ${remainSec}s 后重试` });
  }

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });

  if (!dockerConfig.webAuth?.users?.admin) {
    return res.status(409).json({ error: '请先完成初始化：设置管理密码', setupRequired: true });
  }

  const user = dockerConfig.webAuth?.users?.[username];
  if (!user || !verifyPassword(password, user.password)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  recordLoginSuccess(ip);
  setSessionCookie(res, { u: username, exp: Date.now() + SESSION_TTL_MS }, secret, { secure: isHttpsRequest(req) });
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res, { secure: isHttpsRequest(req) });
  res.json({ success: true });
});

app.post('/api/password', (req, res) => {
  dockerConfig = readDockerConfig();
  const secret = dockerConfig.webAuth?.secret;
  const sess = getSession(req, secret);
  if (!sess?.u) return res.status(401).json({ error: 'unauthorized' });

  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '缺少参数' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: '新密码至少8位' });

  const user = dockerConfig.webAuth?.users?.[sess.u];
  if (!user || !verifyPassword(oldPassword, user.password)) return res.status(401).json({ error: '当前密码不正确' });

  dockerConfig.webAuth.users[sess.u].password = pbkdf2HashPassword(newPassword);
  dockerConfig.webAuth.users[sess.u].passwordChangedAt = new Date().toISOString();
  writeDockerConfig(dockerConfig);
  clearSessionCookie(res, { secure: isHttpsRequest(req) });
  res.json({ success: true });
});

// ============================================================
// API: update check
// ============================================================
const VERSION_FILE = '/etc/openclaw-version';
const DOCKERFILE_HASH_FILE = '/etc/openclaw-dockerfile-hash';
const GITHUB_REPO = 'cintia09/openclaw-pro';

function getCurrentVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch { return 'unknown'; }
}

function getLocalDockerfileHash() {
  try { return fs.readFileSync(DOCKERFILE_HASH_FILE, 'utf8').trim(); } catch { return ''; }
}

async function getRemoteDockerfileHashesByRef(ref) {
  const hashes = [];
  const candidates = ['Dockerfile', 'Dockerfile.lite'];
  for (const fileName of candidates) {
    try {
      const dfResp = await fetchWithFallback(`${GITHUB_RAW_BASE}/${ref}/${fileName}`, {
        headers: { 'User-Agent': 'openclaw-pro' },
        timeout: 10000
      });
      if (!dfResp.ok) continue;
      const dockerfileText = await dfResp.text();
      const hash = crypto.createHash('sha256').update(dockerfileText).digest('hex');
      if (hash) hashes.push(hash);
    } catch {}
  }
  return [...new Set(hashes)];
}

function normalizeVersionTag(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.replace(/^v/i, '');
}

let updateCache = { data: null, checkedAt: 0 };

app.get('/api/update/check', async (req, res) => {
  const currentVersion = getCurrentVersion();
  const force = req.query.force === '1';

  // Cache for 10 minutes unless forced
  if (!force && updateCache.data && (Date.now() - updateCache.checkedAt < 600000)) {
    return res.json({ ...updateCache.data, currentVersion, cached: true });
  }

  try {
    let release = null;
    let latestVersion = '';
    let releaseUrl = `https://github.com/${GITHUB_REPO}/releases`;
    let releaseName = '';
    let publishedAt = '';

    // --- 方式1: GitHub API ---
    try {
      const resp = await fetchWithFallback(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'openclaw-pro' },
        timeout: 10000
      });
      if (resp.ok) {
        release = await resp.json();
        latestVersion = release.tag_name || '';
        publishedAt = release.published_at || '';
        releaseUrl = release.html_url || releaseUrl;
        releaseName = release.name || latestVersion;
      }
    } catch {}

    // --- 方式2: raw.githubusercontent.com 读 version.txt (API 不可达时的后备) ---
    if (!latestVersion) {
      try {
        const rawResp = await fetchWithFallback(`${GITHUB_RAW_BASE}/main/version.txt`, {
          headers: { 'User-Agent': 'openclaw-pro' },
          timeout: 8000
        });
        if (rawResp.ok) {
          latestVersion = (await rawResp.text()).trim();
          releaseName = latestVersion;
          console.log(`[update] GitHub API unavailable, got version from version.txt: ${latestVersion}`);
        }
      } catch {}
    }

    if (!latestVersion) {
      return res.json({ currentVersion, latestVersion: null, error: '无法连接 GitHub（API 和 raw 均不可达）' });
    }
    const currentNorm = normalizeVersionTag(currentVersion);
    const latestNorm = normalizeVersionTag(latestVersion);
    // Only consider a release version increase as the primary "hasUpdate" trigger
    let hasUpdate = false;
    if (currentNorm !== 'unknown' && currentNorm !== 'dev' && !!latestNorm) {
      const currentSem = normalizeSemver(currentNorm);
      const latestSem = normalizeSemver(latestNorm);
      if (currentSem && latestSem) {
        hasUpdate = compareSemver(latestNorm, currentNorm) > 0;
      } else {
        hasUpdate = latestNorm !== currentNorm && latestNorm !== 'dev';
      }
    }

    const result = {
      currentVersion,
      latestVersion,
      hasUpdate,
      publishedAt,
      releaseUrl,
      releaseName,
      // whether the Dockerfile change requires a full image rebuild/update
      requiresFullUpdate: false,
      dockerfileChanged: false
    };

    // Check Dockerfile hash against release ref first (avoid false positives from main branch drift)
    try {
      const refs = [];
      if (latestVersion) refs.push(latestVersion);
      if (release && release.target_commitish) refs.push(release.target_commitish);

      let remoteHashes = [];
      let checkedRef = '';
      for (const ref of refs) {
        try {
          const hashes = await getRemoteDockerfileHashesByRef(ref);
          if (!hashes.length) continue;
          remoteHashes = hashes;
          checkedRef = ref;
          break;
        } catch {}
      }

      const localHash = getLocalDockerfileHash();
      if (remoteHashes.length > 0 && localHash) {
        result.dockerfileChanged = !remoteHashes.includes(localHash);
        // 仅当 release 版本有变化时，才需要展示“完整更新”或“热更新”提示
        result.requiresFullUpdate = !!hasUpdate && result.dockerfileChanged;
      } else if (remoteHashes.length > 0 && !localHash) {
        // 缺少本地 hash：尝试用“当前版本 tag 的 Dockerfile”进行对比，避免误报完整更新
        let currentRefHashes = [];
        const currentRefs = [];
        if (currentVersion) currentRefs.push(currentVersion);
        const currentNormTag = normalizeVersionTag(currentVersion);
        if (currentNormTag && !currentRefs.includes(currentNormTag)) currentRefs.push(currentNormTag);
        if (currentNormTag) {
          const currentNormWithV = `v${currentNormTag}`;
          if (!currentRefs.includes(currentNormWithV)) currentRefs.push(currentNormWithV);
        }

        for (const ref of currentRefs) {
          try {
            const hashes = await getRemoteDockerfileHashesByRef(ref);
            if (!hashes.length) continue;
            currentRefHashes = hashes;
            break;
          } catch {}
        }

        if (currentRefHashes.length > 0) {
          const currentHashSet = new Set(currentRefHashes);
          result.dockerfileChanged = !remoteHashes.some((h) => currentHashSet.has(h));
          result.requiresFullUpdate = !!hasUpdate && result.dockerfileChanged;
        } else {
          // 无法确定底层是否变更：不强制完整更新，保留热更新入口
          result.dockerfileChanged = false;
          result.requiresFullUpdate = false;
        }
      } else {
        // 无法比较 Dockerfile：不强制完整更新
        result.dockerfileChanged = false;
        result.requiresFullUpdate = false;
      }

      if (checkedRef) {
        console.log(`[update] Dockerfile hash checked against ref: ${checkedRef}`);
      }
    } catch {}

    // hasUpdate 仅由 release 版本变化触发；不会因为 Dockerfile 变化单独触发更新提示。

    updateCache = { data: { latestVersion, hasUpdate: result.hasUpdate, publishedAt, releaseUrl, releaseName, requiresFullUpdate: result.requiresFullUpdate, dockerfileChanged: result.dockerfileChanged }, checkedAt: Date.now() };
    res.json(result);
  } catch (e) {
    res.json({ currentVersion, latestVersion: null, error: e.message });
  }
});

// ============================================================
// API: hot patch (update files without rebuilding image)
// ============================================================
const HOTPATCH_FILES = [
  // [GitHub path, local path]
  ['web/public/app.js', '/opt/openclaw-web/public/app.js'],
  ['web/public/index.html', '/opt/openclaw-web/public/index.html'],
  ['web/public/login.html', '/opt/openclaw-web/public/login.html'],
  ['web/public/login.js', '/opt/openclaw-web/public/login.js'],
  ['web/public/style.css', '/opt/openclaw-web/public/style.css'],
  ['web/server.js', '/opt/openclaw-web/server.js'],
  ['start-services.sh', '/usr/local/bin/start-services.sh'],
  ['scripts/openclaw-gateway-watchdog.sh', '/usr/local/bin/openclaw-gateway-watchdog.sh'],
  ['Caddyfile.template', '/etc/caddy/Caddyfile.template'],
];

const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}`;

let hotpatchState = { status: 'idle', log: '', startedAt: 0 };

app.get('/api/update/hotpatch/status', (req, res) => {
  res.json(hotpatchState);
});

app.post('/api/update/hotpatch', async (req, res) => {
  if (hotpatchState.status === 'running') {
    return res.status(409).json({ error: '热更新正在进行中' });
  }

  const branch = (req.body && req.body.branch) || 'main';
  hotpatchState = { status: 'running', log: '', startedAt: Date.now(), updated: [], failed: [] };
  res.json({ success: true, message: '热更新已开始' });

  const log = (msg) => { hotpatchState.log += msg + '\n'; console.log('[hotpatch] ' + msg); };

  try {
    log(`从 GitHub (${branch}) 拉取最新文件...`);
    let needCaddyRestart = false;
    let needWebRestart = false;
    let needContainerRestart = false;

    for (const [ghPath, localPath] of HOTPATCH_FILES) {
      try {
        const url = `${GITHUB_RAW_BASE}/${branch}/${ghPath}`;
        const resp = await fetchWithFallback(url, {
          headers: { 'User-Agent': 'openclaw-pro' },
          timeout: 8000
        });

        if (!resp.ok) {
          log(`  ⚠ ${ghPath}: HTTP ${resp.status}, 跳过`);
          hotpatchState.failed.push(ghPath);
          continue;
        }

        const content = await resp.text();

        // Compare with existing file
        let existingContent = '';
        try { existingContent = fs.readFileSync(localPath, 'utf8'); } catch {}

        if (content === existingContent) {
          log(`  ✓ ${ghPath}: 无变化`);
          continue;
        }

        // Write new file
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, content);

        // Preserve executable permission for shell scripts
        if (localPath.endsWith('.sh')) {
          try { fs.chmodSync(localPath, 0o755); } catch {}
        }

        log(`  ✅ ${ghPath}: 已更新`);
        hotpatchState.updated.push(ghPath);

        if (ghPath === 'Caddyfile.template') needCaddyRestart = true;
        if (ghPath === 'web/server.js') needWebRestart = true;
        if (ghPath === 'start-services.sh') needContainerRestart = true;
      } catch (e) {
        log(`  ❌ ${ghPath}: ${e.message}`);
        hotpatchState.failed.push(ghPath);
      }
    }

    // Update version file (try API first, fallback to version.txt)
    try {
      let newVersion = '';
      try {
        const versionResp = await fetchWithFallback(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
          headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'openclaw-pro' },
          timeout: 10000
        });
        if (versionResp.ok) {
          const rel = await versionResp.json();
          if (rel.tag_name) newVersion = rel.tag_name;
        }
      } catch {}
      if (!newVersion) {
        // Fallback: read version.txt from raw (already in HOTPATCH_FILES or fetch directly)
        try {
          const rawVer = await fetchWithFallback(`${GITHUB_RAW_BASE}/main/version.txt`, {
            headers: { 'User-Agent': 'openclaw-pro' },
            timeout: 8000
          });
          if (rawVer.ok) newVersion = (await rawVer.text()).trim();
        } catch {}
      }
      if (newVersion) {
        fs.writeFileSync(VERSION_FILE, newVersion + '\n');
        log(`版本号更新为: ${newVersion}`);
      }
    } catch {}

    // Regenerate Caddyfile and restart Caddy if template changed
    if (needCaddyRestart) {
      log('Caddyfile 模板已更新，重新生成配置并重启 Caddy...');
      try {
        execSync('bash -c "source /usr/local/bin/start-services.sh 2>/dev/null; envsubst < /etc/caddy/Caddyfile.template > /tmp/Caddyfile" 2>/dev/null || true');
        execSync('pkill -USR1 caddy 2>/dev/null || true');
        log('Caddy 已通知重载配置');
      } catch (e) {
        log(`Caddy 重载失败 (非致命): ${e.message}`);
      }
    }

    // Clear update cache
    updateCache = { data: null, checkedAt: 0 };

    const summary = `热更新完成: ${hotpatchState.updated.length} 个文件已更新, ${hotpatchState.failed.length} 个失败`;
    log(summary);
    if (needContainerRestart) {
      log('检测到 start-services.sh 已更新：请在宿主机执行 `docker restart openclaw-pro` 以使入口脚本变更生效（仅热更新不会立即生效）');
      log('若容器名不确定：先执行 `docker ps --format "{{.Names}}"` 确认名称，再执行 `docker restart <容器名>`');
    }
    hotpatchState.status = 'done';

    // If server.js was updated, schedule a self-restart
    if (needWebRestart && hotpatchState.updated.includes('web/server.js')) {
      log('server.js 已更新，2 秒后自动重启 Web 面板...');
      setTimeout(() => {
        try { execSync('pkill -f "node server.js" 2>/dev/null || true'); } catch {}
        // The health check in start-services.sh will auto-restart the web panel
      }, 2000);
    }
  } catch (e) {
    log(`热更新失败: ${e.message}`);
    hotpatchState.status = 'error';
  }
});

// ============================================================
// API: status
// ============================================================
app.get('/api/status', (req, res) => {
  const statusStart = Date.now();
  const status = { gateway: false, web: true, caddy: false, uptime: 0, memory: {}, version: getCurrentVersion() };
  const ocSnapshot = getOpenClawInstallationSnapshot();
  status.openclawInstalled = !!ocSnapshot?.installed;
  status.openclawVersion = String(ocSnapshot?.version || '').trim();

  status.gateway = runCommandOk('curl -s --connect-timeout 1 --max-time 2 http://127.0.0.1:18789/health >/dev/null 2>&1', 2500)
    || runCommandOk('ss -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]" || netstat -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]"', 1200);
  if (!status.gateway) {
    const e = new Error('gateway not detected');
    if (req.query.debug === '1') {
      console.log(`[status] gateway check miss: ${e.message || e}`);
    }
  }

  status.caddy = runCommandOk('pgrep -f caddy >/dev/null 2>&1', 1200);
  if (!status.caddy) {
    const e = new Error('caddy not detected');
    if (req.query.debug === '1') {
      console.log(`[status] caddy check miss: ${e.message || e}`);
    }
  }

  try {
    const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    status.uptime = Math.floor(uptime);
  } catch {}

  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || 0, 10);
    const avail = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || 0, 10);
    status.memory = {
      total: Math.round(total / 1024),
      used: Math.round((total - avail) / 1024),
      percent: total ? Math.round(((total - avail) / total) * 100) : 0
    };
  } catch {}

  dockerConfig = readDockerConfig();
  status.domain = dockerConfig.domain || '';
  status.port = dockerConfig.port || 18789;
  status.browserEnabled = !!dockerConfig.browserEnabled;
  status.gatewayWatchdog = runCommandOk('pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1', 1200);

  if (status.browserEnabled) {
    status.browser = runCommandOk('pgrep -f "websockify.*6080" >/dev/null 2>&1', 1200);
    if (!status.browser) {
      const e = new Error('browser bridge not detected');
      if (req.query.debug === '1') {
        console.log(`[status] browser check miss: ${e.message || e}`);
      }
    }
  } else {
    status.browser = false;
  }

  status.terminal = {
    wsEnabled: !!terminalBackendState.wsEnabled,
    ready: !!terminalBackendState.ready,
    mode: terminalBackendState.mode || 'unknown',
    reason: terminalBackendState.reason || '',
    updatedAt: terminalBackendState.updatedAt || 0
  };

  const statusElapsed = Date.now() - statusStart;
  if (statusElapsed > 1200 || req.query.debug === '1') {
    console.log(`[status] elapsed=${statusElapsed}ms gateway=${status.gateway} caddy=${status.caddy} browser=${status.browser} version=${status.version}`);
  }

  res.json(status);
});

app.get('/api/docker-config', (req, res) => {
  const cfg = readDockerConfig();
  res.json({ browserEnabled: !!cfg.browserEnabled });
});

app.post('/api/docker-config', (req, res) => {
  try {
    const cfg = readDockerConfig();
    const updates = req.body || {};
    if (typeof updates.browserEnabled === 'boolean') {
      cfg.browserEnabled = updates.browserEnabled;
    }
    writeDockerConfig(cfg);
    res.json({ success: true, browserEnabled: !!cfg.browserEnabled, restartRequired: true });
  } catch (e) {
    const detail = e?.message || String(e || '配置恢复失败');
    console.error('[openclaw][repair] failed:', detail);
    res.status(500).json({ success: false, error: detail });
  }
});

// ============================================================
// API: config (basic; keep legacy behavior)
// ============================================================
app.get('/api/config', (req, res) => {
  repairOpenClawConfigProviders();
  const config = readConfig();
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.providers) {
    for (const [key, val] of Object.entries(safe.providers)) {
      if (val && val.apiKey) safe.providers[key].apiKey = '***';
    }
  }
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  try {
    repairOpenClawConfigProviders();
    const config = readConfig();
    const updates = req.body || {};
    deepMerge(config, updates);
    writeConfig(config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const aiAuthTasks = {};
const aiStatusCache = {
  data: null,
  checkedAt: 0,
  inFlight: null
};
const AI_STATUS_CACHE_TTL_MS = 10000;

function appendAiTaskLog(task, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  task.log += text;
  task.seq = (task.seq || 0) + 1;
  task.chunks = task.chunks || [];
  task.chunks.push(text);
  if (task.chunks.length > 3000) {
    task.chunks = task.chunks.slice(task.chunks.length - 3000);
  }
}

function runAiAuthTask(command, title) {
  const taskId = Date.now().toString();
  aiAuthTasks[taskId] = {
    status: 'running',
    log: '',
    startedAt: Date.now(),
    seq: 0,
    chunks: []
  };
  const task = aiAuthTasks[taskId];
  appendAiTaskLog(task, `[ai] ${title}\n`);
  appendAiTaskLog(task, `[ai] command: ${command}\n\n`);

  (async () => {
    const result = await runOpenClawCliWithPtyInput(command, '', 180000);
    appendAiTaskLog(task, result.output || '');
    task.status = result.ok ? 'success' : 'failed';
    task.exitCode = result.code;
    const keys = Object.keys(aiAuthTasks).sort();
    while (keys.length > 8) delete aiAuthTasks[keys.shift()];
  })();

  return taskId;
}

app.get('/api/ai/status', async (req, res) => {
  const now = Date.now();
  if (aiStatusCache.data && (now - aiStatusCache.checkedAt) < AI_STATUS_CACHE_TTL_MS) {
    return res.json(aiStatusCache.data);
  }

  if (!aiStatusCache.inFlight) {
    aiStatusCache.inFlight = (async () => {
      const statusResult = await runOpenClawCli('openclaw models status --json 2>&1', 7000);
      const parsed = extractJsonObject(statusResult.output);

      const providerHints = parsed?.auth?.oauth?.providers || [];
      const configuredProviders = providerHints
        .map((item) => item?.provider)
        .filter(Boolean);

      const payload = {
        success: statusResult.ok,
        modelsStatus: parsed || null,
        defaultModel: parsed?.defaultModel || '',
        resolvedDefault: parsed?.resolvedDefault || '',
        configuredProviders,
        raw: parsed ? '' : compactOutput(statusResult.output),
        ttySupported: runCommandOk('command -v script >/dev/null 2>&1', 800)
      };

      aiStatusCache.data = payload;
      aiStatusCache.checkedAt = Date.now();
      return payload;
    })().finally(() => {
      aiStatusCache.inFlight = null;
    });
  }

  const payload = await aiStatusCache.inFlight;
  res.json(payload);
});

app.post('/api/ai/model', async (req, res) => {
  const model = String(req.body?.model || '').trim();
  if (!model) return res.status(400).json({ error: '模型不能为空' });
  if (!/^[a-zA-Z0-9._/:\-]+$/.test(model)) return res.status(400).json({ error: '模型格式不合法' });

  const result = await runOpenClawCli(`openclaw models set "${model.replace(/"/g, '')}" 2>&1`, 15000);
  if (!result.ok) return res.status(500).json({ error: compactOutput(result.output) || '设置模型失败' });
  res.json({ success: true, output: compactOutput(result.output) });
});

app.post('/api/ai/auth/token', async (req, res) => {
  const provider = String(req.body?.provider || '').trim();
  const token = String(req.body?.token || '').trim();
  if (!provider || !/^[a-zA-Z0-9\-]+$/.test(provider)) return res.status(400).json({ error: 'provider 不合法' });
  if (!token) return res.status(400).json({ error: 'token 不能为空' });

  const command = `openclaw models auth paste-token --provider ${provider}`;
  const result = await runOpenClawCliWithPtyInput(command, token, 60000);
  if (!result.ok) return res.status(500).json({ error: compactOutput(result.output) || '保存认证失败' });
  res.json({ success: true, output: compactOutput(result.output) });
});

app.post('/api/ai/auth/copilot/login', (req, res) => {
  const taskId = runAiAuthTask('openclaw models auth login-github-copilot', 'GitHub Copilot 登录');
  res.json({ success: true, taskId });
});

app.get('/api/ai/auth/task/:taskId', (req, res) => {
  const task = aiAuthTasks[req.params.taskId];
  if (!task) return res.status(404).json({ error: 'not found' });
  const since = Math.max(0, parseInt(req.query.since || '0', 10) || 0);
  let delta = '';
  if (since <= 0) delta = task.log || '';
  else if (since < (task.seq || 0)) delta = (task.chunks || []).slice(since).join('');
  res.json({ ...task, delta });
});

// ============================================================
// API: restart gateway
// ============================================================
app.post('/api/restart', (req, res) => {
  try {
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle' && opState.type !== 'restarting_gateway') {
      return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
    }
    setOpenClawOperationState('restarting_gateway');
    restartGatewayForeground((err, stdout, stderr) => {
      clearOpenClawOperationState('restarting_gateway');
      if (!err) {
        return res.json({ success: true, message: 'Gateway 进程已终止，watchdog 将自动拉起' });
      }
      const detail = compactOutput(stderr || stdout || err.message || '');
      if (String(detail || '').includes('exit 21')) {
        return res.json({ success: false, error: 'watchdog 脚本不存在，无法自动拉起 Gateway' });
      }
      if (/Unrecognized key|Invalid config/i.test(String(detail || ''))) {
        return res.json({ success: false, error: `${detail || 'Gateway 配置无效'}；请点击“配置恢复”（内部会执行 openclaw doctor --fix）后重试` });
      }
      res.json({ success: false, error: detail || 'Gateway 重启失败，请查看 watchdog 日志' });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: OpenClaw install/status/update/start
// ============================================================
const installLogs = {};
const repairLogs = {};
let activeInstallTaskId = '';
let activeRepairTaskId = '';
const REPAIR_LOCK_FILE = '/root/.openclaw/locks/config-repair.lock';

function isTaskRunning(taskMap, taskId) {
  if (!taskId) return false;
  const task = taskMap[taskId];
  return !!(task && task.status === 'running');
}

function appendInstallLog(task, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  if (task.logFile) {
    try {
      fs.mkdirSync(path.dirname(task.logFile), { recursive: true });
      fs.appendFileSync(task.logFile, text);
    } catch {}
  }
  task.log += text;
  task.seq = (task.seq || 0) + 1;
  task.chunks = task.chunks || [];
  task.chunks.push(text);
  if (task.chunks.length > 3000) {
    task.chunks = task.chunks.slice(task.chunks.length - 3000);
  }
}

function appendRepairLog(task, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  task.log += text;
  task.seq = (task.seq || 0) + 1;
  task.chunks = task.chunks || [];
  task.chunks.push(text);
  if (task.chunks.length > 3000) {
    task.chunks = task.chunks.slice(task.chunks.length - 3000);
  }
}

function isRepairLockActive() {
  try {
    if (!fs.existsSync(REPAIR_LOCK_FILE)) return false;
    const pidText = fs.readFileSync(REPAIR_LOCK_FILE, 'utf8').trim();
    const pid = Number(pidText || 0);
    if (pid > 1) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {}
    }
    fs.unlinkSync(REPAIR_LOCK_FILE);
    return false;
  } catch {
    return false;
  }
}

function acquireRepairLock() {
  if (isRepairLockActive()) return false;
  try {
    fs.mkdirSync(path.dirname(REPAIR_LOCK_FILE), { recursive: true });
    fs.writeFileSync(REPAIR_LOCK_FILE, String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseRepairLock() {
  try { fs.unlinkSync(REPAIR_LOCK_FILE); } catch {}
}

function runOpenClawRepairTask() {
  if (!acquireRepairLock()) return null;
  if (isOpenClawOperationBusy()) {
    releaseRepairLock();
    return null;
  }
  const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  repairLogs[taskId] = {
    status: 'running',
    log: '',
    startedAt: Date.now(),
    seq: 0,
    chunks: [],
    changed: false,
    removed: [],
    detected: []
  };

  const task = repairLogs[taskId];
  activeRepairTaskId = taskId;
  setOpenClawOperationState('repairing_config', taskId);

  (async () => {
    const cleanedProviders = repairOpenClawConfigProviders();
    if (cleanedProviders) {
      appendRepairLog(task, '[repair] 已预清理无效 key: providers\n');
    }
    appendRepairLog(task, '[repair] 正在执行 openclaw doctor --fix ...\n');

    let doctorOutput = '';
    if (runCommandOk('command -v openclaw >/dev/null 2>&1 || test -x /root/.npm-global/bin/openclaw || test -x /usr/local/bin/openclaw || test -f /root/.openclaw/openclaw-source/openclaw.mjs', 1000)) {
      const doctor = await runOpenClawCli('OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; if [ -z "$OPENCLAW_BIN" ]; then for p in /root/.npm-global/bin/openclaw /usr/local/bin/openclaw /root/.openclaw/openclaw-source/openclaw.mjs; do if [ -x "$p" ] || [ -f "$p" ]; then OPENCLAW_BIN="$p"; break; fi; done; fi; if [ -z "$OPENCLAW_BIN" ]; then echo "openclaw not found"; exit 127; fi; "$OPENCLAW_BIN" doctor --fix 2>&1', 120000);
      doctorOutput = compactOutput(doctor.output || '');
      if (doctorOutput) appendRepairLog(task, `[repair] doctor 输出: ${doctorOutput}\n`);
      if (doctor.ok) appendRepairLog(task, '[repair] doctor --fix 执行完成。\n');
      else appendRepairLog(task, '[repair] doctor --fix 返回非0，继续执行兜底修复。\n');
    } else {
      appendRepairLog(task, '[repair] openclaw 命令不可用，跳过 doctor，直接执行兜底修复。\n');
    }

    const gatewayLog = readGatewayLogTail(500);
    const detected = Array.from(new Set([
      ...detectInvalidConfigKeysFromText(gatewayLog),
      ...detectInvalidConfigKeysFromText(doctorOutput)
    ]));
    if (!detected.includes('providers')) detected.push('providers');
    task.detected = detected;

    const repair = repairOpenClawConfigInvalidKeys(detected);
    appendRepairLog(task, `[repair] 检测到潜在无效 key: ${detected.length ? detected.join(', ') : '无'}\n`);

    if (!repair.changed) {
      appendRepairLog(task, '[repair] 未发现可删除项（可能已被 doctor 修复）。\n');
      appendRepairLog(task, '[repair] 请点击“重启 Gateway”验证配置是否恢复。\n');
      task.changed = false;
      task.removed = [];
      task.status = 'success';
    } else {
      appendRepairLog(task, `[repair] 已移除无效 key: ${repair.removed.join(', ')}\n`);
      if (repair.backupPath) appendRepairLog(task, `[repair] 已备份原配置: ${repair.backupPath}\n`);
      appendRepairLog(task, '[repair] 修复完成，请点击“重启 Gateway”使配置重新加载。\n');
      task.changed = true;
      task.removed = repair.removed || [];
      task.backupPath = repair.backupPath || '';
      task.status = 'success';
    }
  })().catch((e) => {
    const detail = e?.message || String(e || '配置恢复失败');
    console.error('[openclaw][repair] failed:', detail);
    appendRepairLog(task, `[repair] 失败: ${detail}\n`);
    task.status = 'failed';
    task.error = detail;
  }).finally(() => {
    if (activeRepairTaskId === taskId) activeRepairTaskId = '';
    releaseRepairLock();
    clearOpenClawOperationState('repairing_config');
    const keys = Object.keys(repairLogs).sort();
    while (keys.length > 8) delete repairLogs[keys.shift()];
  });

  return taskId;
}

function runOpenClawTask(command, title, operationType = 'installing') {
  if (isOpenClawOperationBusy()) return null;
  const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskLogFile = OPENCLAW_INSTALL_LOG_FILE;
  installLogs[taskId] = {
    status: 'running',
    log: '',
    startedAt: Date.now(),
    seq: 0,
    chunks: [],
    logFile: taskLogFile
  };

  const task = installLogs[taskId];
  appendInstallLog(task, `\n===== [${new Date().toISOString()}] task ${taskId} (${operationType}) begin =====\n`);
  activeInstallTaskId = taskId;
  setOpenClawOperationState(operationType, taskId);
  appendInstallLog(task, `[openclaw] ${title}\n`);
  appendInstallLog(task, `[openclaw] command: ${command}\n\n`);

  const escaped = String(command).replace(/'/g, `'"'"'`);
  const child = exec(`bash --noprofile --norc -lc '${escaped}'`, {
    timeout: 2700000,
    env: { ...process.env, TERM: 'dumb' }
  });
  child.on('error', (err) => {
    appendInstallLog(task, `[openclaw] 任务启动失败: ${err.message}\n`);
    task.status = 'failed';
    task.exitCode = -1;
    clearOpenClawOperationState(operationType);
  });
  child.stdout.on('data', d => appendInstallLog(task, d));
  child.stderr.on('data', d => appendInstallLog(task, d));
  child.on('close', (code, signal) => {
    if (signal) {
      appendInstallLog(task, `[openclaw] 任务被中断（signal=${signal}），可能超时或被外部终止。\n`);
    }
    task.status = code === 0 ? 'success' : 'failed';
    task.exitCode = code;
    appendInstallLog(task, `\n===== [${new Date().toISOString()}] task ${taskId} end status=${task.status} exitCode=${code ?? 'null'} signal=${signal || 'none'} =====\n`);
    if (activeInstallTaskId === taskId) activeInstallTaskId = '';
    clearOpenClawOperationState(operationType);
    const keys = Object.keys(installLogs).sort();
    while (keys.length > 5) delete installLogs[keys.shift()];
  });

  return taskId;
}

function listOpenClawConfigBackups() {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG_BACKUP_DIR)) return [];
    return fs.readdirSync(OPENCLAW_CONFIG_BACKUP_DIR)
      .filter((name) => name && name.endsWith('.json'))
      .map((name) => {
        const fullPath = path.join(OPENCLAW_CONFIG_BACKUP_DIR, name);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch {}
        return {
          name,
          path: fullPath,
          size: stat?.size || 0,
          mtimeMs: stat?.mtimeMs || 0,
          mtime: stat?.mtime || null
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function sanitizeBackupFileName(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (!/^[A-Za-z0-9._-]+\.json$/.test(value)) return '';
  return value;
}

function extractWatchdogTimestamp(line) {
  const m = String(line || '').match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  return m ? m[1] : '';
}

function getLastRollbackAtFromWatchdog() {
  const text = tailFile(GATEWAY_WATCHDOG_LOG, 3000, 3000);
  if (!text) return '';
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/rollback|回滚|restor(e|ed)|last_good/i.test(line)) {
      const ts = extractWatchdogTimestamp(line);
      if (ts) return ts;
    }
  }
  return '';
}

function getLastBackupAt() {
  const backups = listOpenClawConfigBackups();
  if (!backups.length) return '';
  const mtime = backups[0]?.mtime;
  if (!mtime) return '';
  try {
    return new Date(mtime).toISOString();
  } catch {
    return '';
  }
}

let gatewayRestartRunning = false;
const OPENCLAW_OPERATION_LOCK_FILE = `${OPENCLAW_LOCK_DIR}/operation.lock`;
let openClawOperationState = { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
const OPENCLAW_OPERATION_MAX_SEC = {
  installing: 5400,
  updating: 5400,
  restarting_gateway: 300,
  repairing_config: 900
};

function ensureOpenClawRuntimeStateDirs() {
  try {
    fs.mkdirSync(OPENCLAW_LOCK_DIR, { recursive: true });
    fs.mkdirSync(`${OPENCLAW_STATE_ROOT}/logs`, { recursive: true });
    fs.mkdirSync(`${OPENCLAW_STATE_ROOT}/cache/openclaw`, { recursive: true });
  } catch {}
}

ensureOpenClawRuntimeStateDirs();

function readOperationLockFromFile() {
  try {
    if (!fs.existsSync(OPENCLAW_OPERATION_LOCK_FILE)) return null;
    const raw = fs.readFileSync(OPENCLAW_OPERATION_LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid || 0);
    if (pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
      } catch {
        try { fs.unlinkSync(OPENCLAW_OPERATION_LOCK_FILE); } catch {}
        return null;
      }
    }
    if (!parsed?.type || parsed.type === 'idle') return null;
    return {
      type: String(parsed.type),
      taskId: String(parsed.taskId || ''),
      startedAt: Number(parsed.startedAt || 0),
      pid: Number(parsed.pid || process.pid)
    };
  } catch {
    return null;
  }
}

function writeOperationLock(state) {
  try {
    fs.mkdirSync(path.dirname(OPENCLAW_OPERATION_LOCK_FILE), { recursive: true });
    if (!state || !state.type || state.type === 'idle') {
      if (fs.existsSync(OPENCLAW_OPERATION_LOCK_FILE)) fs.unlinkSync(OPENCLAW_OPERATION_LOCK_FILE);
      return;
    }
    fs.writeFileSync(OPENCLAW_OPERATION_LOCK_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {}
}

function getOpenClawOperationState() {
  const normalizeState = (state) => {
    const type = String(state?.type || 'idle');
    const startedAt = Number(state?.startedAt || 0);
    if (!type || type === 'idle' || !startedAt) return state;
    const maxSec = Number(OPENCLAW_OPERATION_MAX_SEC[type] || 0);
    if (maxSec <= 0) return state;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (elapsedSec <= maxSec) return state;
    openClawOperationState = { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
    writeOperationLock(null);
    return { ...openClawOperationState };
  };

  if (openClawOperationState.type && openClawOperationState.type !== 'idle') {
    if (Number(openClawOperationState.pid || process.pid) === process.pid) {
      return normalizeState({ ...openClawOperationState });
    }
    const fromFile = readOperationLockFromFile();
    if (fromFile) {
      openClawOperationState = normalizeState({ ...fromFile });
      return { ...openClawOperationState };
    }
    openClawOperationState = { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
    return { ...openClawOperationState };
  }
  const lockState = readOperationLockFromFile();
  if (lockState) {
    openClawOperationState = normalizeState({ ...lockState });
    return { ...openClawOperationState };
  }
  return { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
}

function setOpenClawOperationState(type, taskId = '') {
  openClawOperationState = {
    type: String(type || 'idle') || 'idle',
    taskId: String(taskId || ''),
    startedAt: Date.now(),
    pid: process.pid
  };
  writeOperationLock(openClawOperationState);
  return { ...openClawOperationState };
}

function clearOpenClawOperationState(expectedType = '') {
  const current = getOpenClawOperationState();
  if (expectedType && current.type !== expectedType) return;
  openClawOperationState = { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
  writeOperationLock(null);
}

function isOpenClawOperationBusy() {
  const op = getOpenClawOperationState();
  return !!(op.type && op.type !== 'idle');
}

const OPENCLAW_OPERATION_ESTIMATE_SEC = {
  installing: 1200,
  updating: 900,
  restarting_gateway: 120,
  repairing_config: 240
};

function buildOpenClawOperationProgress(state) {
  const type = String(state?.type || 'idle');
  const startedAt = Number(state?.startedAt || 0);
  if (!type || type === 'idle' || !startedAt) {
    return {
      active: false,
      type,
      startedAt,
      elapsedSec: 0,
      totalSec: 0,
      remainingSec: 0
    };
  }

  const now = Date.now();
  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const totalSec = Number(OPENCLAW_OPERATION_ESTIMATE_SEC[type] || 0);
  const remainingSec = totalSec > 0 ? Math.max(0, totalSec - elapsedSec) : 0;

  return {
    active: true,
    type,
    startedAt,
    elapsedSec,
    totalSec,
    remainingSec,
    display: {
      label: type === 'installing'
        ? '安装中'
        : type === 'updating'
          ? '更新中'
          : type === 'restarting_gateway'
            ? 'Gateway 启动中'
            : type === 'repairing_config'
              ? '配置恢复中'
              : '处理中'
    }
  };
}

function auditOpenClawImageDependencies() {
  const requiredCommands = ['bash', 'node', 'npm', 'pnpm', 'git', 'curl', 'jq', 'tar', 'gzip'];
  const commands = requiredCommands.map((name) => ({
    name,
    ok: runCommandOk(`command -v ${name} >/dev/null 2>&1`, 1200),
    path: runCommandText(`command -v ${name} 2>/dev/null || true`, 1200)
  }));

  const files = [
    '/usr/local/bin/openclaw-gateway-watchdog.sh',
    '/usr/local/bin/start-services.sh',
    '/opt/openclaw-web/server.js'
  ].map((filePath) => ({
    path: filePath,
    ok: fs.existsSync(filePath)
  }));

  const dirs = [
    '/root/.openclaw',
    '/root/.openclaw/logs',
    '/root/.openclaw/cache/openclaw',
    '/root/.openclaw/locks'
  ].map((dirPath) => ({
    path: dirPath,
    ok: fs.existsSync(dirPath)
  }));

  const missingCommands = commands.filter((item) => !item.ok).map((item) => item.name);
  const missingFiles = files.filter((item) => !item.ok).map((item) => item.path);
  const missingDirs = dirs.filter((item) => !item.ok).map((item) => item.path);
  const ok = missingCommands.length === 0 && missingFiles.length === 0 && missingDirs.length === 0;

  return {
    ok,
    commands,
    files,
    dirs,
    missingCommands,
    missingFiles,
    missingDirs,
    checkedAt: new Date().toISOString()
  };
}

function buildOpenClawSourceInstallCommand({ repo, tag, tarballUrl }) {
  const safeRepo = parseGitHubRepo(repo) || OPENCLAW_SOURCE_REPO_DEFAULT;
  const safeTag = String(tag || '').trim();
  const safeTarball = String(tarballUrl || '').trim();
  if (!safeTag || !safeTarball) throw new Error('release 信息不完整，无法构建安装命令');

  return [
    'set -euo pipefail',
    `OPENCLAW_REPO="${safeRepo}"`,
    `OPENCLAW_TAG="${safeTag.replace(/"/g, '')}"`,
    `OPENCLAW_TARBALL_URL="${safeTarball.replace(/"/g, '')}"`,
    'WORK_BASE="/root/.openclaw"',
    'SRC_DIR="$WORK_BASE/openclaw"',
    'PERSIST_SRC_DIR="/root/.openclaw/openclaw-source"',
    'TMP_BASE="/root/.openclaw/tmp/openclaw-build"',
    'CACHE_BASE="/root/.openclaw/cache/openclaw"',
    'SRC_TMP="$TMP_BASE/src"',
    'CACHE_KEY="${OPENCLAW_REPO//\//_}--${OPENCLAW_TAG}.tar.gz"',
    'CACHE_TARBALL="$CACHE_BASE/$CACHE_KEY"',
    'EXTRACT_DIR=""',
    'mkdir -p "$WORK_BASE" "$TMP_BASE" "$CACHE_BASE"',
    'rm -rf "$SRC_TMP" "$TMP_BASE/openclaw.tar.gz"',
    'echo "[openclaw] 下载 release 源码: $OPENCLAW_REPO @ $OPENCLAW_TAG"',
    'if [ -s "$CACHE_TARBALL" ] && tar -tzf "$CACHE_TARBALL" >/dev/null 2>&1; then',
    '  echo "[openclaw] 使用本地缓存 tarball: $CACHE_TARBALL"',
    '  cp -f "$CACHE_TARBALL" "$TMP_BASE/openclaw.tar.gz"',
    'fi',
    'download_tarball() {',
    '  local url="$1"',
    '  local out="$2"',
    '  local tmp="$out.part"',
    '  local i=1',
    '  while [ "$i" -le 12 ]; do',
    '    echo "[openclaw] 下载尝试 $i/12: $url"',
    '    rm -f "$tmp"',
    '    if curl -fL --http1.1 --connect-timeout 10 --max-time 1800 -o "$tmp" "$url"; then',
    '      if tar -tzf "$tmp" >/dev/null 2>&1; then',
    '        mv -f "$tmp" "$out"',
    '        return 0',
    '      fi',
    '      echo "[openclaw] tarball 校验失败，重试..."',
    '    fi',
    '    rm -f "$tmp"',
    '    sleep 2',
    '    i=$((i + 1))',
    '  done',
    '  return 1',
    '}',
    'if [ -s "$TMP_BASE/openclaw.tar.gz" ] && tar -tzf "$TMP_BASE/openclaw.tar.gz" >/dev/null 2>&1; then',
    '  echo "[openclaw] 使用已准备好的 tarball"',
    '  mkdir -p "$SRC_TMP"',
    '  tar -xzf "$TMP_BASE/openclaw.tar.gz" -C "$SRC_TMP"',
    '  EXTRACT_DIR="$(find "$SRC_TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"',
    'elif download_tarball "$OPENCLAW_TARBALL_URL" "$TMP_BASE/openclaw.tar.gz"; then',
    '  cp -f "$TMP_BASE/openclaw.tar.gz" "$CACHE_TARBALL" || true',
    '  mkdir -p "$SRC_TMP"',
    '  tar -xzf "$TMP_BASE/openclaw.tar.gz" -C "$SRC_TMP"',
    '  EXTRACT_DIR="$(find "$SRC_TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"',
    'elif ALT_URL="https://github.com/$OPENCLAW_REPO/archive/refs/tags/$OPENCLAW_TAG.tar.gz" && rm -f "$TMP_BASE/openclaw.tar.gz" && download_tarball "$ALT_URL" "$TMP_BASE/openclaw.tar.gz"; then',
    '  cp -f "$TMP_BASE/openclaw.tar.gz" "$CACHE_TARBALL" || true',
    '  mkdir -p "$SRC_TMP"',
    '  tar -xzf "$TMP_BASE/openclaw.tar.gz" -C "$SRC_TMP"',
    '  EXTRACT_DIR="$(find "$SRC_TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"',
    'else',
    '  echo "[openclaw] tarball 下载失败，回退 git clone tag..."',
    '  if ! command -v git >/dev/null 2>&1; then',
    '    echo "[openclaw] 缺少镜像内依赖: git（请重新构建镜像，不在运行时安装系统依赖）"',
    '    exit 11',
    '  fi',
    '  CLONE_DIR="$SRC_TMP/repo-src"',
    '  rm -rf "$CLONE_DIR"',
    '  mkdir -p "$SRC_TMP"',
    '  i=1',
    '  while [ "$i" -le 6 ]; do',
    '    git clone --depth 1 --branch "$OPENCLAW_TAG" "https://github.com/$OPENCLAW_REPO.git" "$CLONE_DIR" && break',
    '    echo "[openclaw] git clone 失败(attempt=$i)，重试..."',
    '    rm -rf "$CLONE_DIR"',
    '    sleep 3',
    '    i=$((i + 1))',
    '  done',
    '  EXTRACT_DIR="$CLONE_DIR"',
    'fi',
    'if [ -z "$EXTRACT_DIR" ] || [ ! -d "$EXTRACT_DIR" ]; then echo "[openclaw] 未获取到源码目录"; exit 2; fi',
    'for bin in node npm pnpm git curl tar gzip; do',
    '  if ! command -v "$bin" >/dev/null 2>&1; then',
    '    echo "[openclaw] 缺少镜像内依赖: $bin（请重新构建镜像，不在运行时安装系统依赖）"',
    '    exit 11',
    '  fi',
    'done',
    'cd "$EXTRACT_DIR"',
    'npm config set fetch-retries 5',
    'npm config set fetch-retry-mintimeout 2000',
    'npm config set fetch-retry-maxtimeout 15000',
    'install_with_registry() {',
    '  local reg="$1"',
    '  npm config set registry "$reg"',
    '  local i=1',
    '  while [ "$i" -le 3 ]; do',
    '    if [ -f package-lock.json ]; then',
    '      npm ci --include=dev --no-audit --no-fund && return 0',
    '    else',
    '      npm install --include=dev --no-audit --no-fund && return 0',
    '    fi',
    '    echo "[openclaw] npm 依赖安装失败(registry=$reg, attempt=$i)，重试..."',
    '    npm cache verify >/dev/null 2>&1 || true',
    '    sleep 3',
    '    i=$((i + 1))',
    '  done',
    '  return 1',
    '}',
    'if ! install_with_registry https://registry.npmjs.org; then',
    '  echo "[openclaw] npmjs 源失败，回退到 npmmirror"',
    '  install_with_registry https://registry.npmmirror.com',
    'fi',
    'if command -v corepack >/dev/null 2>&1; then corepack disable >/dev/null 2>&1 || true; fi',
    'if ! command -v pnpm >/dev/null 2>&1; then echo "[openclaw] 缺少镜像内依赖: pnpm"; exit 11; fi',
    'PNPM_BIN_DIR="$(npm prefix -g 2>/dev/null)/bin"',
    'export PATH="$PNPM_BIN_DIR:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'if [ -x "$PNPM_BIN_DIR/pnpm" ]; then ln -sf "$PNPM_BIN_DIR/pnpm" /usr/local/bin/pnpm 2>/dev/null || true; fi',
    'if ! command -v pnpm >/dev/null 2>&1; then echo "[openclaw] pnpm 不可用，安装失败"; exit 5; fi',
    'if npm run | grep -qE "(^| )build( |$)"; then npm run build; elif npm run | grep -qE "(^| )compile( |$)"; then npm run compile; else echo "[openclaw] 未找到 build/compile 脚本"; exit 3; fi',
    'if [ ! -f dist/control-ui/index.html ]; then',
    '  echo "[openclaw] 检测到 control-ui 产物缺失，尝试执行 ui:build"',
    '  if npm run | grep -qE "(^| )ui:build( |$)"; then',
    '    pnpm ui:build || npm run ui:build || true',
    '  fi',
    'fi',
    'if [ ! -f dist/control-ui/index.html ] && [ -d control-ui ] && [ -f control-ui/package.json ]; then',
    '  echo "[openclaw] 尝试在 control-ui 子目录执行构建"',
    '  cd control-ui',
    '  pnpm install --prefer-offline --no-frozen-lockfile >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1 || true',
    '  pnpm build >/dev/null 2>&1 || npm run build >/dev/null 2>&1 || true',
    '  cd "$EXTRACT_DIR"',
    '  if [ -f control-ui/dist/index.html ]; then',
    '    mkdir -p dist/control-ui',
    '    cp -a control-ui/dist/. dist/control-ui/',
    '  fi',
    'fi',
    'if [ ! -f dist/control-ui/index.html ]; then',
    '  echo "[openclaw] WARN: control-ui 产物缺失，Gateway /health 可能返回 503（代理访问通常不受影响）"',
    'fi',
    'rm -rf "$PERSIST_SRC_DIR"',
    'mkdir -p /root/.openclaw "$WORK_BASE"',
    'cp -a "$EXTRACT_DIR" "$PERSIST_SRC_DIR"',
    'rm -rf "$SRC_DIR"',
    'ln -sfn "$PERSIST_SRC_DIR" "$SRC_DIR"',
    'if [ ! -f "$SRC_DIR/openclaw.mjs" ] && [ -f "$SRC_DIR/dist/openclaw.mjs" ]; then ln -sf "$SRC_DIR/dist/openclaw.mjs" "$SRC_DIR/openclaw.mjs"; fi',
    'if [ ! -f "$SRC_DIR/openclaw.mjs" ]; then echo "[openclaw] 编译产物缺失: $SRC_DIR/openclaw.mjs"; exit 4; fi',
    'if [ ! -f "$SRC_DIR/dist/entry.js" ] && [ ! -f "$SRC_DIR/dist/entry.mjs" ]; then',
    '  if [ -f "$SRC_DIR/dist/index.js" ]; then ln -sfn index.js "$SRC_DIR/dist/entry.js"; fi',
    '  if [ ! -f "$SRC_DIR/dist/entry.js" ] && [ ! -f "$SRC_DIR/dist/entry.mjs" ] && [ -f "$SRC_DIR/dist/index.mjs" ]; then ln -sfn index.mjs "$SRC_DIR/dist/entry.mjs"; fi',
    'fi',
    'if [ ! -f "$SRC_DIR/dist/entry.js" ] && [ ! -f "$SRC_DIR/dist/entry.mjs" ]; then echo "[openclaw] 编译产物缺失: $SRC_DIR/dist/entry.(m)js"; exit 4; fi',
    'mkdir -p /root/.openclaw',
    'printf "{\\n  \\\"repo\\\": \\\"%s\\\",\\n  \\\"tag\\\": \\\"%s\\\",\\n  \\\"tarballUrl\\\": \\\"%s\\\",\\n  \\\"installedAt\\\": \\\"%s\\\"\\n}\\n" "$OPENCLAW_REPO" "$OPENCLAW_TAG" "$OPENCLAW_TARBALL_URL" "$(date -Iseconds)" > /root/.openclaw/openclaw-source-install.json',
    'echo "[openclaw] source build install completed: $OPENCLAW_REPO@$OPENCLAW_TAG"',
    'node "$SRC_DIR/openclaw.mjs" --version 2>/dev/null || node "$SRC_DIR/openclaw.mjs" -v 2>/dev/null || true'
  ].join('\n');
}

function buildOpenClawReleaseAssetInstallCommand({ repo, tag, binaryAsset }) {
  const assetName = String(binaryAsset?.name || '').trim();
  const assetUrl = String(binaryAsset?.url || '').trim();
  if (!assetName || !assetUrl) return '';
  const safeRepo = String(repo || '').trim();
  const safeTag = String(tag || '').trim();
  return [
    'set -euo pipefail',
    `OPENCLAW_REPO="${safeRepo.replace(/"/g, '')}"`,
    `OPENCLAW_TAG="${safeTag.replace(/"/g, '')}"`,
    `OPENCLAW_ASSET_NAME="${assetName.replace(/"/g, '')}"`,
    `OPENCLAW_ASSET_URL="${assetUrl.replace(/"/g, '')}"`,
    'OPENCLAW_STATE_ROOT="/root/.openclaw"',
    'PERSIST_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source"',
    'WORK_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw"',
    'TMP_BASE="$OPENCLAW_STATE_ROOT/tmp/openclaw-asset-install"',
    'ARCHIVE_PATH="$TMP_BASE/$OPENCLAW_ASSET_NAME"',
    'EXTRACT_DIR="$TMP_BASE/extract"',
    'mkdir -p "$OPENCLAW_STATE_ROOT" "$OPENCLAW_STATE_ROOT/logs" "$TMP_BASE" "$EXTRACT_DIR"',
    'rm -rf "$EXTRACT_DIR"/*',
    'echo "[openclaw] 尝试 GitHub Release 编译包: $OPENCLAW_ASSET_NAME"',
    'download_asset() {',
    '  local i=1',
    '  local tmp="$ARCHIVE_PATH.part"',
    '  while [ "$i" -le 8 ]; do',
    '    echo "[openclaw] 下载编译包尝试 $i/8: $OPENCLAW_ASSET_URL"',
    '    rm -f "$tmp"',
    '    if curl -fL --http1.1 --connect-timeout 10 --max-time 1800 -o "$tmp" "$OPENCLAW_ASSET_URL"; then',
    '      mv -f "$tmp" "$ARCHIVE_PATH"',
    '      return 0',
    '    fi',
    '    sleep 2',
    '    i=$((i + 1))',
    '  done',
    '  return 1',
    '}',
    'download_asset',
    'case "$OPENCLAW_ASSET_NAME" in',
    '  *.tar.gz|*.tgz)',
    '    tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"',
    '    ;;',
    '  *.zip)',
    '    if ! command -v unzip >/dev/null 2>&1; then',
    '      echo "[openclaw] 编译包为 zip，但镜像缺少 unzip"',
    '      exit 12',
    '    fi',
    '    unzip -q "$ARCHIVE_PATH" -d "$EXTRACT_DIR"',
    '    ;;',
    '  *)',
    '    echo "[openclaw] 不支持的编译包格式: $OPENCLAW_ASSET_NAME"',
    '    exit 12',
    '    ;;',
    'esac',
    'ASSET_ROOT="$(find "$EXTRACT_DIR" -type f -name openclaw.mjs | head -1 | xargs -I{} dirname "{}")"',
    'if [ -z "$ASSET_ROOT" ] || [ ! -f "$ASSET_ROOT/openclaw.mjs" ]; then',
    '  echo "[openclaw] 编译包缺少 openclaw.mjs"',
    '  exit 13',
    'fi',
    'if [ ! -f "$ASSET_ROOT/dist/entry.js" ] && [ ! -f "$ASSET_ROOT/dist/entry.mjs" ]; then',
    '  if [ -f "$ASSET_ROOT/dist/index.js" ]; then ln -sfn index.js "$ASSET_ROOT/dist/entry.js"; fi',
    '  if [ ! -f "$ASSET_ROOT/dist/entry.js" ] && [ ! -f "$ASSET_ROOT/dist/entry.mjs" ] && [ -f "$ASSET_ROOT/dist/index.mjs" ]; then ln -sfn index.mjs "$ASSET_ROOT/dist/entry.mjs"; fi',
    'fi',
    'if [ ! -f "$ASSET_ROOT/dist/entry.js" ] && [ ! -f "$ASSET_ROOT/dist/entry.mjs" ]; then',
    '  echo "[openclaw] 编译包缺少 dist/entry.(m)js"',
    '  exit 13',
    'fi',
    'if [ ! -f "$ASSET_ROOT/dist/control-ui/index.html" ]; then',
    '  echo "[openclaw] WARN: 编译包缺少 control-ui 产物"',
    'fi',
    'rm -rf "$PERSIST_SRC_DIR"',
    'mkdir -p "$PERSIST_SRC_DIR"',
    'cp -a "$ASSET_ROOT"/. "$PERSIST_SRC_DIR"/',
    'ln -sfn "$PERSIST_SRC_DIR" "$WORK_SRC_DIR"',
    'printf "{\\n  \\\"repo\\\": \\\"%s\\\",\\n  \\\"tag\\\": \\\"%s\\\",\\n  \\\"assetName\\\": \\\"%s\\\",\\n  \\\"assetUrl\\\": \\\"%s\\\",\\n  \\\"installedAt\\\": \\\"%s\\\"\\n}\\n" "$OPENCLAW_REPO" "$OPENCLAW_TAG" "$OPENCLAW_ASSET_NAME" "$OPENCLAW_ASSET_URL" "$(date -Iseconds)" > /root/.openclaw/openclaw-source-install.json',
    'echo "[openclaw] GitHub 编译包安装完成: $OPENCLAW_ASSET_NAME"',
    'node "$PERSIST_SRC_DIR/openclaw.mjs" --version 2>/dev/null || node "$PERSIST_SRC_DIR/openclaw.mjs" -v 2>/dev/null || true'
  ].join('\n');
}

function buildOpenClawPreferredInstallCommand(release) {
  const assetCmd = buildOpenClawReleaseAssetInstallCommand(release);
  const npmCmd = buildOpenClawNpmInstallCommand();
  const sourceCmd = buildOpenClawSourceInstallCommand(release);
  const githubPreferBlock = assetCmd
    ? [
      'echo "[openclaw] 优先尝试 GitHub Release 编译包安装..."',
      'if (',
      assetCmd,
      '); then',
      '  echo "[openclaw] GitHub 编译包安装完成。"',
      'else',
      '  rc=$?',
      '  echo "[openclaw] GitHub 编译包安装失败(exit=${rc})，继续尝试 npm 预构建包..."',
      'fi'
    ].join('\n')
    : 'echo "[openclaw] 未找到可用 GitHub 编译包资产，跳过该步骤。"';
  return [
    'set -euo pipefail',
    githubPreferBlock,
    'if [ ! -f /root/.openclaw/openclaw-source/openclaw.mjs ] || { [ ! -f /root/.openclaw/openclaw-source/dist/entry.js ] && [ ! -f /root/.openclaw/openclaw-source/dist/entry.mjs ]; }; then',
    '  echo "[openclaw] 进入 npm 预构建安装流程（官方推荐路径）..."',
    '  if (',
    npmCmd,
    '  ); then',
    '    echo "[openclaw] npm 预构建安装完成。"',
    '    rm -f /root/.openclaw/openclaw-source-install.json >/dev/null 2>&1 || true',
    '  else',
    '    rc=$?',
    '    echo "[openclaw] npm 预构建安装失败(exit=${rc})，回退源码构建安装..."',
    sourceCmd,
    '  fi',
    'else',
    '  echo "[openclaw] 编译产物已就绪，跳过 npm/source 回退流程。"',
    'fi'
  ].join('\n');
}

app.get('/api/openclaw', async (req, res) => {
  try {
    const accessPatch = ensureGatewayControlUiAccessForRequest(req);
    if (accessPatch?.changed) {
      console.log(`[openclaw][gateway] controlUi access patched for host=${accessPatch.host || 'unknown'}`);
    }

    const forceCheck = String(req.query.force || '') === '1';
    const detected = getOpenClawInstallationSnapshot(forceCheck);
    const installed = detected.installed;
    let version = String(detected.version || '').trim();
    if (version.toLowerCase() === 'dev' || version.toLowerCase() === 'unknown') {
      version = '';
    }
    if (!version && installed) {
      const fallbackVersion = String(getInstalledOpenClawVersion() || '').trim();
      if (fallbackVersion) version = fallbackVersion;
    }

    let latestVersion = '';
    let updateCheckError = '';
    if (forceCheck) {
      await refreshLatestOpenClawVersionCache({ force: true });
    } else {
      refreshLatestOpenClawVersionCache().catch(() => {});
    }
    latestVersion = latestOpenClawVersionCache.version || '';
    updateCheckError = latestVersion ? '' : (latestOpenClawVersionCache.error || '');

    const hasUpdate = !!(installed && version && latestVersion && compareSemver(latestVersion, version) > 0);

    const gatewayLogTail = readGatewayLogTail(300);
    const invalidConfigKeys = detectInvalidConfigKeysFromText(gatewayLogTail);
    const gatewayPairingRequired = !isGatewayDeviceAuthDisabled()
      && detectGatewayPairingRequiredRecent(gatewayLogTail, 900);

    const gatewayHealthCodeText = runCommandText('curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 --max-time 2 http://127.0.0.1:18789/health 2>/dev/null || true', 3000);
    const gatewayHealthCode = Number.parseInt(String(gatewayHealthCodeText || '').trim(), 10) || 0;
    const gatewayRunning = gatewayHealthCode === 200;
    const gatewayProcessRunning = runCommandOk('pgrep -f "[o]penclaw.*gateway" >/dev/null 2>&1', 1200)
      || runCommandOk('ss -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]" || netstat -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]"', 1200);
    const gatewayWatchdogRunning = runCommandOk('pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1', 1200);
    const gatewayProcessUptimeSec = Number.parseInt(String(runCommandText('pgrep -f "[o]penclaw.*gateway" | head -1 | xargs -I{} ps -o etimes= -p {} 2>/dev/null || true', 1200) || '').trim(), 10) || 0;

    const installTaskRunning = isTaskRunning(installLogs, activeInstallTaskId);
    const repairTaskRunning = isTaskRunning(repairLogs, activeRepairTaskId) || isRepairLockActive();
    const operationState = getOpenClawOperationState();
    const operationProgress = buildOpenClawOperationProgress(operationState);
    const gatewayWarmupByProcess = !!(
      installed
      && !gatewayRunning
      && gatewayProcessRunning
      && gatewayProcessUptimeSec > 0
      && gatewayProcessUptimeSec <= 300
    );
    const gatewayRestartingByOp = !!(
      operationState?.type === 'restarting_gateway'
      && (installed || gatewayRestartRunning || gatewayProcessRunning || gatewayRunning)
    );
    const gatewayStarting = gatewayWarmupByProcess || gatewayRestartingByOp;
    const lastBackupAt = getLastBackupAt();
    const lastRollbackAt = getLastRollbackAtFromWatchdog();

    res.json({
      installed,
      version,
      latestVersion,
      hasUpdate,
      updateCheckError,
      gatewayRunning,
      gatewayProcessRunning,
      gatewayStarting,
      gatewayProcessUptimeSec,
      gatewayHealthCode,
      gatewayWatchdogRunning,
      gatewayPairingRequired,
      invalidConfigKeys,
      installSource: detected.source,
      installTaskRunning,
      repairTaskRunning,
      gatewayRestartRunning,
      operationState,
      operationProgress,
      lastBackupAt,
      lastRollbackAt
    });
  } catch (e) {
    const detail = e?.message || String(e || '状态读取失败');
    console.error('[openclaw][status] failed:', detail);
    res.status(500).json({ error: detail });
  }
});

app.get('/api/openclaw/gateway-link', (req, res) => {
  try {
    const accessPatch = ensureGatewayControlUiAccessForRequest(req);
    if (accessPatch?.changed) {
      console.log(`[openclaw][gateway-link] patched controlUi/trustedProxies for host=${accessPatch.host || 'unknown'}`);
      restartGatewayForeground(() => {});
    }

    const cfg = readJson(CONFIG_PATH, {});
    const authMode = String(cfg?.gateway?.auth?.mode || 'none').trim() || 'none';
    const rawToken = String(cfg?.gateway?.auth?.token || '').trim();
    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const protoHeader = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim().toLowerCase();
    const hostname = (hostHeader.split(':')[0] || '127.0.0.1').trim();
    const externalProto = (protoHeader === 'https' ? 'https' : 'http');

    const gatewayPort = Number(cfg?.port || 18789) || 18789;
    const directBase = `http://${hostname}:${gatewayPort}/`;
    const tokenHash = rawToken ? `#token=${encodeURIComponent(rawToken)}` : '';
    const directUrl = `${directBase}${tokenHash}`;
    const proxyUrl = `/${'gateway-proxy/'}`;
    const externalProxyUrl = `${externalProto}://${hostHeader || hostname}${proxyUrl}${tokenHash}`;
    const externalGatewayUrl = `${externalProto}://${hostHeader || hostname}/gateway${tokenHash}`;

    const preferredUrl = externalGatewayUrl;

    let hint = '';
    if (authMode === 'token' && !rawToken) {
      hint = 'Gateway 为 token 模式但未读取到 token，已回退到代理地址。';
    } else if (authMode !== 'token' && authMode !== 'none') {
      hint = `Gateway 当前认证模式为 ${authMode}，可能需要在控制台中手动输入凭据。`;
    }

    res.json({
      success: true,
      authMode,
      hasToken: !!rawToken,
      preferredUrl,
      externalGatewayUrl,
      externalProxyUrl,
      directUrl,
      proxyUrl,
      hint
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'gateway link 生成失败' });
  }
});

app.post('/api/openclaw/config/repair', (req, res) => {
  try {
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle' && opState.type !== 'repairing_config') {
      return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
    }
    if (opState.type === 'repairing_config' && opState.taskId) {
      return res.json({ success: true, taskId: opState.taskId, reused: true, message: '修复任务进行中，请勿重复触发' });
    }
    if (isRepairLockActive()) {
      const runningTaskId = isTaskRunning(repairLogs, activeRepairTaskId) ? activeRepairTaskId : '';
      return res.json({ success: true, taskId: runningTaskId, reused: true, message: '修复任务进行中，请勿重复触发' });
    }
    if (isTaskRunning(repairLogs, activeRepairTaskId)) {
      return res.json({ success: true, taskId: activeRepairTaskId, reused: true });
    }
    const taskId = runOpenClawRepairTask();
    if (!taskId) return res.status(409).json({ success: false, error: '修复任务创建失败：存在并发操作占用', operationState: getOpenClawOperationState() });
    res.json({ success: true, taskId });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '修复任务创建失败' });
  }
});

app.get('/api/openclaw/config/repair/:taskId', (req, res) => {
  const task = repairLogs[req.params.taskId];
  if (!task) return res.status(404).json({ error: 'not found' });
  const since = Math.max(0, parseInt(req.query.since || '0', 10) || 0);
  let delta = '';
  if (since <= 0) {
    delta = task.log || '';
  } else if (since < (task.seq || 0)) {
    const chunks = task.chunks || [];
    delta = chunks.slice(since).join('');
  }
  res.json({ ...task, delta });
});

app.get('/api/openclaw/config/backups', (req, res) => {
  try {
    const backups = listOpenClawConfigBackups();
    res.json({ success: true, backups });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '读取备份列表失败' });
  }
});

app.post('/api/openclaw/config/restore', (req, res) => {
  try {
    const name = sanitizeBackupFileName(req.body?.name);
    if (!name) return res.status(400).json({ success: false, error: '备份文件名无效' });

    const backupPath = path.join(OPENCLAW_CONFIG_BACKUP_DIR, name);
    if (!backupPath.startsWith(`${OPENCLAW_CONFIG_BACKUP_DIR}/`) || !fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: '备份文件不存在' });
    }

    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const keepPath = `${CONFIG_PATH}.before-restore.${Date.now()}.bak`;
        fs.copyFileSync(CONFIG_PATH, keepPath);
      } catch {}
    }

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.copyFileSync(backupPath, CONFIG_PATH);
    res.json({ success: true, restored: name });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '配置恢复失败' });
  }
});

app.post('/api/openclaw/install', async (req, res) => {
  try {
    if (isTaskRunning(installLogs, activeInstallTaskId)) {
      return res.json({ success: true, taskId: activeInstallTaskId, reused: true, logFile: installLogs[activeInstallTaskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
    }
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle') {
      if ((opState.type === 'installing' || opState.type === 'updating') && isTaskRunning(installLogs, activeInstallTaskId)) {
        return res.json({ success: true, taskId: activeInstallTaskId, reused: true, operationState: opState, logFile: installLogs[activeInstallTaskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
      }
      return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
    }

    const repo = resolveOpenClawSourceRepo(true);
    const release = await getLatestOpenClawRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release);
    const taskId = runOpenClawTask(command, `安装 OpenClaw（预构建优先，失败回退源码）(${release.tag})`, 'installing');
    if (!taskId) {
      return res.status(409).json({ success: false, error: '任务创建失败：存在并发操作占用', operationState: getOpenClawOperationState() });
    }
    res.json({ success: true, taskId, release: { repo: release.repo, tag: release.tag }, logFile: installLogs[taskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '安装任务创建失败' });
  }
});

app.get('/api/openclaw/install/:taskId', (req, res) => {
  const task = installLogs[req.params.taskId];
  if (!task) return res.status(404).json({ error: 'not found' });
  const since = Math.max(0, parseInt(req.query.since || '0', 10) || 0);
  let delta = '';
  if (since <= 0) {
    delta = task.log || '';
  } else if (since < (task.seq || 0)) {
    const chunks = task.chunks || [];
    delta = chunks.slice(since).join('');
  }
  res.json({ ...task, delta });
});

function buildOpenClawNpmInstallCommand() {
  return [
    'set -e',
    'for bin in node npm; do',
    '  if ! command -v "$bin" >/dev/null 2>&1; then',
    '    echo "[openclaw] 缺少镜像内依赖: $bin（请重新构建镜像，不在运行时安装系统依赖）"',
    '    exit 11',
    '  fi',
    'done',
    'npm config set registry https://registry.npmmirror.com',
    'NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo /usr/local)"',
    'OPENCLAW_STATE_ROOT="/root/.openclaw"',
    'PERSIST_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source"',
    'WORK_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw"',
    'mkdir -p "$OPENCLAW_STATE_ROOT" "$OPENCLAW_STATE_ROOT/logs" "$OPENCLAW_STATE_ROOT/cache/openclaw" "$OPENCLAW_STATE_ROOT/locks"',
    'OPENCLAW_LIB_DIR="${NPM_PREFIX}/lib/node_modules"',
    'OPENCLAW_BIN="${NPM_PREFIX}/bin/openclaw"',
    'MIRROR_LATEST="$(npm view openclaw version --registry=https://registry.npmmirror.com 2>/dev/null || true)"',
    'NPMJS_LATEST="$(npm view openclaw version --registry=https://registry.npmjs.org 2>/dev/null || true)"',
    'if [ -n "$NPMJS_LATEST" ] && [ "$MIRROR_LATEST" != "$NPMJS_LATEST" ]; then',
    '  echo "[openclaw] 镜像最新(${MIRROR_LATEST:-unknown})落后于 npmjs(${NPMJS_LATEST})，直接使用 npmjs 源安装..."',
    '  npm config set registry https://registry.npmjs.org',
    'fi',
    'npm uninstall -g openclaw >/dev/null 2>&1 || true',
    'rm -rf "${OPENCLAW_LIB_DIR}/openclaw" "${OPENCLAW_LIB_DIR}"/.openclaw-* >/dev/null 2>&1 || true',
    'npm cache verify >/dev/null 2>&1 || true',
    'run_npm_global_install() {',
    '  local pkg="$1"',
    '  local label="$2"',
    '  local rc=0',
    '  if command -v timeout >/dev/null 2>&1; then',
    '    echo "[openclaw] ${label}: timeout 900s npm install -g ${pkg}"',
    '    timeout 900 npm install -g "$pkg" || rc=$?',
    '  else',
    '    echo "[openclaw] ${label}: npm install -g ${pkg}"',
    '    npm install -g "$pkg" || rc=$?',
    '  fi',
    '  if [ "$rc" -eq 124 ]; then',
    '    echo "[openclaw] npm install 超时(900s): ${pkg}"',
    '  fi',
    '  return "$rc"',
    '}',
    'if ! run_npm_global_install openclaw@latest "首次安装"; then',
    '  echo "[openclaw] npm install 首次失败，尝试清理并重试..."',
    '  npm uninstall -g openclaw >/dev/null 2>&1 || true',
    '  rm -rf "${OPENCLAW_LIB_DIR}/openclaw" "${OPENCLAW_LIB_DIR}"/.openclaw-* >/dev/null 2>&1 || true',
    '  npm cache verify >/dev/null 2>&1 || true',
    '  npm config set registry https://registry.npmjs.org',
    '  run_npm_global_install openclaw@latest "重试安装"',
    'fi',
    'if [ ! -x "$OPENCLAW_BIN" ] && [ -f "${OPENCLAW_LIB_DIR}/openclaw/openclaw.mjs" ]; then',
    '  ln -sf "${OPENCLAW_LIB_DIR}/openclaw/openclaw.mjs" "$OPENCLAW_BIN" || true',
    'fi',
    'case ":$PATH:" in',
    '  *":${NPM_PREFIX}/bin:"*) ;;',
    '  *) export PATH="$PATH:${NPM_PREFIX}/bin" ;;',
    'esac',
    'sync_openclaw_pkg_to_source() {',
    '  NPM_ROOT="$(npm root -g 2>/dev/null || true)"',
    '  OPENCLAW_PKG_DIR="$NPM_ROOT/openclaw"',
    '  if [ ! -d "$OPENCLAW_PKG_DIR" ]; then',
    '    echo "[openclaw] 预构建包缺失: $OPENCLAW_PKG_DIR"',
    '    return 14',
    '  fi',
    '  rm -rf "$PERSIST_SRC_DIR"',
    '  mkdir -p "$PERSIST_SRC_DIR"',
    '  cp -a "$OPENCLAW_PKG_DIR"/. "$PERSIST_SRC_DIR"/',
    '  ln -sfn "$PERSIST_SRC_DIR" "$WORK_SRC_DIR"',
    '  if [ ! -f "$PERSIST_SRC_DIR/openclaw.mjs" ] && [ -f "$PERSIST_SRC_DIR/dist/openclaw.mjs" ]; then',
    '    ln -sfn "$PERSIST_SRC_DIR/dist/openclaw.mjs" "$PERSIST_SRC_DIR/openclaw.mjs"',
    '  fi',
    '  if [ ! -f "$PERSIST_SRC_DIR/dist/entry.js" ] && [ ! -f "$PERSIST_SRC_DIR/dist/entry.mjs" ]; then',
    '    if [ -f "$PERSIST_SRC_DIR/dist/index.js" ]; then ln -sfn index.js "$PERSIST_SRC_DIR/dist/entry.js"; fi',
    '    if [ ! -f "$PERSIST_SRC_DIR/dist/entry.js" ] && [ ! -f "$PERSIST_SRC_DIR/dist/entry.mjs" ] && [ -f "$PERSIST_SRC_DIR/dist/index.mjs" ]; then ln -sfn index.mjs "$PERSIST_SRC_DIR/dist/entry.mjs"; fi',
    '  fi',
    '  if [ ! -f "$PERSIST_SRC_DIR/openclaw.mjs" ] || { [ ! -f "$PERSIST_SRC_DIR/dist/entry.js" ] && [ ! -f "$PERSIST_SRC_DIR/dist/entry.mjs" ]; }; then',
    '    echo "[openclaw] 预构建包关键产物不完整（缺少 openclaw.mjs 或 dist/entry.(m)js），回退源码构建"',
    '    return 15',
    '  fi',
    '  return 0',
    '}',
    'CURRENT_VER=""',
    'SYNC_OK=0',
    'if sync_openclaw_pkg_to_source; then SYNC_OK=1; else SYNC_OK=0; fi',
    'if command -v openclaw >/dev/null 2>&1; then',
    '  CURRENT_VER="$(openclaw -v 2>/dev/null || openclaw --version 2>/dev/null || true)"',
    'elif [ -x "$OPENCLAW_BIN" ]; then',
    '  CURRENT_VER="$("$OPENCLAW_BIN" -v 2>/dev/null || "$OPENCLAW_BIN" --version 2>/dev/null || true)"',
    'fi',
    'CURRENT_VER="${CURRENT_VER#v}"',
    'if [ "$SYNC_OK" != "1" ] || { [ -n "$NPMJS_LATEST" ] && [ "$CURRENT_VER" != "$NPMJS_LATEST" ]; }; then',
    '  if [ "$SYNC_OK" != "1" ]; then',
    '    echo "[openclaw] 预构建包校验失败，尝试从 npmjs 重新安装一次..."',
    '  else',
    '    echo "[openclaw] 镜像版本(${CURRENT_VER:-unknown})落后于 npmjs 最新(${NPMJS_LATEST})，切换 npmjs 对齐..."',
    '  fi',
    '  npm config set registry https://registry.npmjs.org',
    '  npm uninstall -g openclaw >/dev/null 2>&1 || true',
    '  rm -rf "${OPENCLAW_LIB_DIR}/openclaw" "${OPENCLAW_LIB_DIR}"/.openclaw-* >/dev/null 2>&1 || true',
    '  npm cache verify >/dev/null 2>&1 || true',
    '  if [ -n "$NPMJS_LATEST" ]; then',
    '    run_npm_global_install "openclaw@${NPMJS_LATEST}" "npmjs对齐安装"',
    '  else',
    '    run_npm_global_install openclaw@latest "npmjs对齐安装"',
    '  fi',
    '  sync_openclaw_pkg_to_source',
    'fi',
    'if command -v openclaw >/dev/null 2>&1; then',
    '  openclaw -v || openclaw --version',
    'elif [ -x "$OPENCLAW_BIN" ]; then',
    '  "$OPENCLAW_BIN" -v || "$OPENCLAW_BIN" --version',
    'else',
    '  echo "[openclaw] update failed: openclaw binary not found under ${NPM_PREFIX}/bin"',
    '  exit 127',
    'fi'
  ].join('\n');
}

app.post('/api/openclaw/update', async (req, res) => {
  try {
    if (isTaskRunning(installLogs, activeInstallTaskId)) {
      return res.json({ success: true, taskId: activeInstallTaskId, reused: true, logFile: installLogs[activeInstallTaskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
    }
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle') {
      if ((opState.type === 'installing' || opState.type === 'updating') && isTaskRunning(installLogs, activeInstallTaskId)) {
        return res.json({ success: true, taskId: activeInstallTaskId, reused: true, operationState: opState, logFile: installLogs[activeInstallTaskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
      }
      return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
    }

    const repo = resolveOpenClawSourceRepo(true);
    const release = await getLatestOpenClawRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release);
    const taskId = runOpenClawTask(command, `更新 OpenClaw（预构建优先，失败回退源码）(${release.tag})`, 'updating');
    if (!taskId) {
      return res.status(409).json({ success: false, error: '任务创建失败：存在并发操作占用', operationState: getOpenClawOperationState() });
    }
    res.json({ success: true, taskId, release: { repo: release.repo, tag: release.tag }, logFile: installLogs[taskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '更新任务创建失败' });
  }
});

app.get('/api/openclaw/dependencies', (req, res) => {
  try {
    ensureOpenClawRuntimeStateDirs();
    const audit = auditOpenClawImageDependencies();
    res.json({ success: true, ...audit });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '依赖审计失败' });
  }
});

app.post('/api/openclaw/start', (req, res) => {
  console.log('[openclaw][start] restart requested');
  if (gatewayRestartRunning) {
    console.log('[openclaw][start] restart already running, returning reuse response');
    return res.json({
      success: true,
      message: 'Gateway 重启任务已在进行中，请稍候',
      logs: readOpenClawGatewayLogs(120, { includeWatchdog: true })
    });
  }
  const opState = getOpenClawOperationState();
  if (opState.type !== 'idle' && opState.type !== 'restarting_gateway') {
    console.log(`[openclaw][start] blocked by operation state: ${opState.type}`);
    return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
  }
  gatewayRestartRunning = true;
  setOpenClawOperationState('restarting_gateway');
  restartGatewayForeground((err, stdout, stderr) => {
    gatewayRestartRunning = false;
    clearOpenClawOperationState('restarting_gateway');
    const startupLogs = readOpenClawGatewayLogs(160, { includeWatchdog: true });
    if (!err) {
      console.log('[openclaw][start] gateway restart request finished, watchdog should relaunch');
      return res.json({ success: true, message: 'Gateway 进程已终止，watchdog 将自动拉起', logs: startupLogs });
    }
    const detail = compactOutput(stderr || stdout || err.message || '');
    console.log(`[openclaw][start] restart failed: ${detail || 'unknown error'}`);
    if (String(detail || '').includes('exit 21')) {
      return res.json({ success: false, error: 'watchdog 脚本不存在，无法自动拉起 Gateway', logs: startupLogs });
    }
    if (/Unrecognized key|Invalid config/i.test(String(detail || ''))) {
      return res.json({ success: false, error: `${detail || 'Gateway 配置无效'}；请点击“配置恢复”（内部会执行 openclaw doctor --fix）后重试`, logs: startupLogs });
    }
    res.json({ success: false, error: detail || 'Gateway 重启失败，请查看 watchdog 日志', logs: startupLogs });
  });
});

app.get('/api/openclaw/gateway/logs', (req, res) => {
  try {
    const lines = Math.max(20, Math.min(parseInt(req.query.lines || '200', 10) || 200, 1200));
    const logs = readOpenClawGatewayLogs(lines, { includeWatchdog: true });
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '读取 Gateway 日志失败' });
  }
});

// ============================================================
// Logs: sanitize + tail
// ============================================================
function sanitizeLogLine(line) {
  const keyRegexes = [
    /"(apiKey|token|secret|password)"\s*:\s*"[^"]*"/gi,
    /\b(apiKey|token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi
  ];
  let out = line;
  out = out.replace(keyRegexes[0], (m, k) => `"${k}":"***"`);
  out = out.replace(keyRegexes[1], (m, k) => `${k}=***`);
  return out;
}

function tailLogLines(lines = 200) {
  const logFile = resolveGatewayLogFileForStreaming();
  if (!fs.existsSync(logFile)) return [];
  const output = execSync(`tail -${Math.max(1, Math.min(lines, 5000))} "${logFile}"`, { encoding: 'utf8', timeout: 2500 });
  return output
    .split('\n')
    .filter(Boolean)
    .map(sanitizeLogLine);
}

function getLatestTaskLog(taskMap) {
  const items = Object.values(taskMap || {}).filter(Boolean);
  if (!items.length) return null;
  items.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  return items[0] || null;
}

function formatTaskLogBlock(title, task, lines = 200) {
  if (!task || typeof task !== 'object') return '';
  const text = String(task.log || '').trim();
  if (!text) return '';
  const safeLines = Math.max(20, Math.min(lines, 2000));
  const tail = text.split('\n').slice(-safeLines).map(sanitizeLogLine).join('\n').trim();
  if (!tail) return '';
  const status = String(task.status || 'unknown');
  const startedAt = task.startedAt ? new Date(task.startedAt).toISOString() : '';
  const header = `[${title}] status=${status}${startedAt ? ` startedAt=${startedAt}` : ''}`;
  return `${header}\n${tail}`;
}

app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 100;
  try {
    const safeLines = Math.max(20, Math.min(lines, 5000));
    const mergedBlocks = [];

    const logFile = resolveGatewayLogFileForStreaming();
    if (fs.existsSync(logFile)) {
      const output = execSync(`tail -${safeLines} "${logFile}"`, { encoding: 'utf8', timeout: 2500 });
      const gatewayLogs = output
        .split('\n')
        .map(sanitizeLogLine)
        .join('\n')
        .trim();
      if (gatewayLogs) {
        mergedBlocks.push(`[gateway]\n${gatewayLogs}`);
      }
    }

    const activeInstall = activeInstallTaskId ? installLogs[activeInstallTaskId] : null;
    const installTask = activeInstall || getLatestTaskLog(installLogs);
    const installBlock = formatTaskLogBlock('openclaw-install', installTask, Math.min(safeLines, 400));
    if (installBlock) mergedBlocks.push(installBlock);

    const activeRepair = activeRepairTaskId ? repairLogs[activeRepairTaskId] : null;
    const repairTask = activeRepair || getLatestTaskLog(repairLogs);
    const repairBlock = formatTaskLogBlock('openclaw-repair', repairTask, Math.min(safeLines, 300));
    if (repairBlock) mergedBlocks.push(repairBlock);

    const gatewayCombined = readOpenClawGatewayLogs(Math.min(safeLines, 400), { includeWatchdog: true }).trim();
    if (gatewayCombined) {
      mergedBlocks.push(gatewayCombined);
    }

    const panelLog = tailFile(WEB_PANEL_LOG_FILE, Math.min(safeLines, 220), 2500).trim();
    if (panelLog) {
      const sanitizedPanel = panelLog
        .split('\n')
        .map(sanitizeLogLine)
        .join('\n')
        .trim();
      if (sanitizedPanel) {
        mergedBlocks.push(`[web-panel]\n${sanitizedPanel}`);
      }
    }

    if (!mergedBlocks.length) {
      const hints = [
        '[logs] 当前尚未产生可展示日志。',
        `[logs] checked: ${GATEWAY_RUNTIME_LOG_FILE}`,
        `[logs] checked: ${GATEWAY_LEGACY_LOG_FILE}`,
        `[logs] checked: ${GATEWAY_WATCHDOG_LOG}`,
        `[logs] checked: ${WEB_PANEL_LOG_FILE}`
      ].join('\n');
      return res.json({ logs: hints });
    }

    res.json({ logs: mergedBlocks.join('\n\n') });
  } catch (e) {
    res.json({ logs: e.message });
  }
});

// ============================================================
// Trading system (legacy)
// ============================================================
app.get('/api/trading', (req, res) => {
  const installed = fs.existsSync(TRADING_DIR);
  const result = { installed };

  if (installed) {
    try {
      const commit = execSync(`git -C ${TRADING_DIR} log -1 --format="%h %s" 2>/dev/null`, { encoding: 'utf8' }).trim();
      result.commit = commit;
    } catch {}

    try {
      if (fs.existsSync(STRATEGY_PARAMS_PATH)) {
        result.strategyParams = JSON.parse(fs.readFileSync(STRATEGY_PARAMS_PATH, 'utf8'));
      }
    } catch {}
  }

  res.json(result);
});

app.post('/api/trading', (req, res) => {
  try {
    fs.mkdirSync(path.dirname(STRATEGY_PARAMS_PATH), { recursive: true });
    fs.writeFileSync(STRATEGY_PARAMS_PATH, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trading/install', (req, res) => {
  const { token, repo } = req.body || {};
  if (!token || !repo) return res.status(400).json({ error: '需要 GitHub Token 和仓库地址' });

  // Validate repo format to prevent shell injection
  const repoPattern = /^https:\/\/github\.com\/[\w\-]+\/[\w\-]+(?:\.git)?$/;
  if (!repoPattern.test(repo)) return res.status(400).json({ error: '仓库地址格式无效，需要 https://github.com/user/repo' });
  if (/[;&|`$(){}]/.test(token)) return res.status(400).json({ error: 'Token 格式无效' });

  const repoUrl = repo.replace('https://', `https://${token}@`);
  const { execFile } = require('child_process');
  execFile('git', ['clone', repoUrl, TRADING_DIR], (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || String(err) });
    res.json({ success: true, output: stdout });
  });
});

app.post('/api/trading/update', (req, res) => {
  const { execFile } = require('child_process');
  execFile('git', ['-C', TRADING_DIR, 'pull'], (err, stdout, stderr) => {
    res.json({ success: !err, output: stdout || stderr });
  });
});

// ============================================================
// Plugins market
// ============================================================
const PLUGINS_CATALOG = {
  skills: [
    { id: 'news-push', icon: '📰', name: '新闻推送', desc: '定时推送财经/国际/国内新闻', price: '免费' },
    { id: 'weather', icon: '🌤', name: '天气查询', desc: '查天气预报', price: '免费' },
    { id: 'scheduler', icon: '⏰', name: '定时提醒', desc: 'cron任务管理', price: '免费' },
    { id: 'image-gen', icon: '📷', name: '图片生成', desc: 'AI生成图片(Pollinations)', price: '免费' },
    { id: 'hospital', icon: '🏥', name: '医院查询', desc: '门诊挂号信息', price: '免费' }
  ],
  pro: [
    { id: 'memory-context', icon: '🧠', name: '增强记忆', desc: 'memory-context对话记忆管理', pro: true },
    { id: 'quant-trading', icon: '📈', name: '量化交易', desc: 'A股自动化交易系统', pro: true },
    { id: 'xiaomi-speaker', icon: '🔊', name: '小米音箱', desc: '智能音箱语音控制', pro: true },
    { id: 'taobao-sourcing', icon: '🛒', name: '淘宝选品', desc: '商品调研对比', pro: true },
    { id: 'xiaohongshu-post', icon: '📕', name: '小红书发帖', desc: '自动发布笔记', pro: true }
  ]
};

function readPluginState() {
  const st = readJson(PLUGINS_STATE_PATH, { installed: {}, updatedAt: null });
  st.installed = st.installed || {};
  return st;
}

function writePluginState(st) {
  st.updatedAt = new Date().toISOString();
  writeJson(PLUGINS_STATE_PATH, st);
}

app.get('/api/plugins/list', (req, res) => {
  const st = readPluginState();
  const withInstalled = (arr) => arr.map(p => ({ ...p, installed: !!st.installed[p.id] }));
  res.json({
    skills: withInstalled(PLUGINS_CATALOG.skills),
    pro: withInstalled(PLUGINS_CATALOG.pro)
  });
});

app.post('/api/plugins/install', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing id' });

  const all = [...PLUGINS_CATALOG.skills, ...PLUGINS_CATALOG.pro];
  const exists = all.some(p => p.id === id);
  if (!exists) return res.status(404).json({ error: 'plugin not found' });

  const st = readPluginState();
  st.installed[id] = { installedAt: new Date().toISOString() };
  writePluginState(st);

  // TODO: Actually install the skill — e.g. git clone the skill repo into
  // the openclaw skills directory, run any setup scripts, etc.
  // For now we only update the JSON state.
  res.json({ success: true });
});

// ============================================================
// STT config
// ============================================================
function maskSecret(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 4) return '***';
  return `***${s.slice(-4)}`;
}

app.get('/api/stt/config', (req, res) => {
  const cfg = readJson(STT_CONFIG_PATH, { provider: 'gemini', model: 'whisper-1' });
  res.json({
    provider: cfg.provider || 'gemini',
    model: cfg.model || 'whisper-1',
    apiKey: cfg.apiKey ? maskSecret(cfg.apiKey) : ''
  });
});

app.post('/api/stt/config', (req, res) => {
  const { provider, model, apiKey } = req.body || {};
  if (!provider) return res.status(400).json({ error: 'missing provider' });

  const prev = readJson(STT_CONFIG_PATH, {});
  const next = {
    provider,
    model: model || prev.model || 'whisper-1',
    apiKey: prev.apiKey
  };

  if (provider !== 'local') {
    // only overwrite when provided and not masked
    if (apiKey && apiKey !== '***' && !String(apiKey).startsWith('***')) next.apiKey = apiKey;
  } else {
    next.apiKey = '';
  }

  writeJson(STT_CONFIG_PATH, next);
  res.json({ success: true });
});

app.post('/api/stt/install-local', (req, res) => {
  // TODO: Install whisper.cpp or another local STT engine.
  // For now, return a message suggesting cloud API usage.
  try {
    exec('bash -lc "echo STT local install: not yet implemented. Use cloud API (Gemini/OpenAI) for now."', (err, stdout, stderr) => {
      res.json({ success: !err, output: stdout || stderr });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Start HTTP + WebSocket
// ============================================================
const server = http.createServer(app);
let wss = null;
let termWss = null;

if (WebSocketServer) {
  wss = new WebSocketServer({ noServer: true });
  termWss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    if (!isAuthenticated(req)) {
      try { ws.close(1008, 'unauthorized'); } catch {}
      return;
    }

    // Send recent lines on connect
    try {
      const lines = tailLogLines(120);
      ws.send(JSON.stringify({ type: 'lines', lines }));
    } catch {}

    const logFile = resolveGatewayLogFileForStreaming();

    // Track file offset for incremental reads
    let lastSize = 0;
    try { lastSize = fs.statSync(logFile).size; } catch {}

    let watcher = null;
    let debounceTimer = null;

    const sendNewLines = () => {
      if (ws.readyState !== 1) return;
      try {
        const stat = fs.statSync(logFile);
        if (stat.size === lastSize) return;
        if (stat.size < lastSize) {
          // File was truncated/rotated — re-read from start
          lastSize = 0;
        }
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        const newLines = buf.toString('utf8').split('\n').filter(Boolean).map(sanitizeLogLine);
        if (newLines.length > 0) {
          ws.send(JSON.stringify({ type: 'append', lines: newLines }));
        }
      } catch {}
    };

    try {
      watcher = fs.watch(logFile, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(sendNewLines, 300);
      });
    } catch {
      // Fallback to polling if fs.watch fails
      watcher = setInterval(sendNewLines, 2000);
    }

    const cleanup = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (watcher && typeof watcher.close === 'function') watcher.close();
      else if (watcher) clearInterval(watcher);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  termWss.on('connection', (ws, req) => {
    const reqPath = String(req?.url || '');
    let authenticated = isAuthenticated(req);
    if (!authenticated) {
      try {
        const reqUrl = new URL(String(req.url || ''), 'http://localhost');
        const token = reqUrl.searchParams.get('token');
        authenticated = consumeTerminalWsToken(token);
      } catch {}
    }

    if (!authenticated) {
      console.warn(`[terminal-ws] unauthorized connect: ${reqPath}`);
      setTerminalBackendState({ ready: false, reason: 'unauthorized websocket terminal request' });
      try { ws.close(1008, 'unauthorized'); } catch {}
      return;
    }

    const { shell, mode, reason } = createTerminalShell();

    if (!shell) {
      console.warn(`[terminal-ws] shell unavailable mode=${mode || 'unknown'} reason=${reason || 'unknown'}`);
      setTerminalBackendState({ wsEnabled: true, ready: false, mode: mode || 'unavailable', reason: reason || 'terminal shell unavailable' });
      try {
        ws.send(JSON.stringify({ type: 'output', data: `\n[terminal] ${reason || 'terminal shell unavailable'}\n` }));
      } catch {}
      try { ws.close(1011, 'terminal-unavailable'); } catch {}
      return;
    }

    console.log(`[terminal-ws] connected mode=${mode} path=${reqPath}`);
    setTerminalBackendState({ wsEnabled: true, ready: true, mode, reason: mode === 'fallback' ? (reason || '') : '' });

    const sendOutput = (data) => {
      if (ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ type: 'output', data: String(data || '') }));
      } catch {}
    };

    if (mode !== 'pty') {
      sendOutput('OpenClaw Terminal connected (fallback shell). 输入命令并回车执行。\n');
      sendOutput('[terminal] 当前环境未检测到 script，已使用兼容模式。\n');
    }

    shell.stdout.on('data', (chunk) => sendOutput(chunk.toString('utf8')));
    if (mode !== 'pty') {
      shell.stderr.on('data', (chunk) => sendOutput(chunk.toString('utf8')));
    }

    shell.on('close', (code) => {
      console.log(`[terminal-ws] shell closed code=${code ?? 0} mode=${mode}`);
      sendOutput(`\n[terminal] shell exited (code=${code ?? 0})\n`);
      if (Number(code || 0) !== 0) {
        setTerminalBackendState({ ready: false, mode, reason: `shell exited with code ${code}` });
      }
      try { ws.close(); } catch {}
    });

    shell.on('error', (err) => {
      console.warn(`[terminal-ws] shell error mode=${mode} err=${err.message}`);
      sendOutput(`\n[terminal] shell error: ${err.message}\n`);
      setTerminalBackendState({ ready: false, mode, reason: `shell error: ${err.message}` });
      try { ws.close(); } catch {}
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw || '{}'));
        if (msg.type === 'input' && typeof msg.data === 'string') {
          shell.stdin.write(msg.data);
        } else if (msg.type === 'resize') {
          if (mode === 'pty') {
            tryResizePtyShell(shell, msg.cols, msg.rows);
          }
        }
      } catch {
        // ignore invalid payload
      }
    });

    const cleanup = () => {
      try { shell.stdin.end(); } catch {}
      try { shell.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { shell.kill('SIGKILL'); } catch {}
      }, 1000);
    };

    ws.on('close', () => {
      console.log('[terminal-ws] client closed');
      cleanup();
    });
    ws.on('error', (err) => {
      console.warn(`[terminal-ws] websocket error: ${err?.message || 'unknown'}`);
      cleanup();
    });
  });
} else {
  setTerminalBackendState({ wsEnabled: false, ready: false, mode: 'unavailable', reason: 'ws package not available' });
  console.warn('[web] ws package not available: /api/ws/logs and /api/ws/terminal disabled');
}

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(String(req.url || ''), 'http://localhost').pathname;
  } catch {
    pathname = String(req.url || '').split('?')[0] || '';
  }

  if (WebSocketServer && pathname === '/api/ws/logs') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }

  if (WebSocketServer && pathname === '/api/ws/terminal') {
    termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
    return;
  }

  if (!isGatewayProxyUpgradePath(req.url)) return;

  if (!isAuthenticated(req)) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } catch {}
    socket.destroy();
    return;
  }

  const cfg = readDockerConfig();
  const gatewayPort = Number(cfg.port || 18789) || 18789;
  const upstreamPath = gatewayProxyPathFromOriginalUrl(req.url);

  const upstreamSocket = net.connect({ host: '127.0.0.1', port: gatewayPort });
  upstreamSocket.setTimeout(15000);

  upstreamSocket.on('connect', () => {
    const requestText = buildUpgradeRequestText(req, upstreamPath, gatewayPort);
    upstreamSocket.write(requestText);
    if (head && head.length > 0) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });

  upstreamSocket.on('timeout', () => {
    upstreamSocket.destroy(new Error('gateway websocket upstream timeout'));
  });

  upstreamSocket.on('error', () => {
    try {
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nGateway WebSocket unavailable');
      }
    } catch {}
    socket.destroy();
  });

  socket.on('error', () => {
    try { upstreamSocket.destroy(); } catch {}
  });
});

server.listen(PORT, '0.0.0.0', () => {
  repairOpenClawConfigProviders();
  console.log(`[web] OpenClaw Web 管理面板启动: http://0.0.0.0:${PORT}`);
});
