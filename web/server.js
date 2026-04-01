// ============================================================
// server.js — OpenClaw Web Panel (docker/web)
// - Express on 3000
// - Auth: signed cookie + PBKDF2 (docker-config.json)
// - Keep legacy APIs: status/config/restart/openclaw/logs/trading
// - WebSocket: /api/ws/logs (tail gateway log), /api/ws/terminal (interactive shell)
// - Plugins market APIs: /api/plugins/list + skill/extension install/remove
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

const baseConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console)
};

const OPENCLAW_LOG_TIMEZONE = process.env.OPENCLAW_LOG_TIMEZONE || 'Asia/Shanghai';
const LOG_TAIL_MAX_LINES = 10000;
const LOG_VIEW_DEFAULT_LINES = 300;
const LOG_VIEW_MAX_LINES = 10000;
const TASK_LOG_BLOCK_MAX_LINES = 5000;
const OPENCLAW_GATEWAY_LOG_API_MAX_LINES = 3000;
const GATEWAY_LOG_RUNTIME_MAX_LINES = 600;
const GATEWAY_LOG_WATCHDOG_MAX_LINES = 300;
const GATEWAY_LOG_INSTALL_MAX_LINES = 1200;
const LOG_VIEW_INSTALL_BLOCK_CAP = 1200;
const LOG_VIEW_REPAIR_BLOCK_CAP = 800;
const LOG_VIEW_GATEWAY_BLOCK_CAP = 1200;
const LOG_VIEW_PANEL_BLOCK_CAP = 800;
const WS_LOG_BOOTSTRAP_LINES = 400;
const RATE_LIMITED_LOG_STATE = new Map();

function getLogTimezoneOffsetMinutes(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: OPENCLAW_LOG_TIMEZONE,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(date);
    const tzLabel = String(parts.find((p) => p.type === 'timeZoneName')?.value || '');
    const match = tzLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!match) return -date.getTimezoneOffset();
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2] || 0);
    const mins = Number(match[3] || 0);
    return sign * ((hours * 60) + mins);
  } catch {
    return -date.getTimezoneOffset();
  }
}

function formatLogTimezoneOffset(value = Date.now()) {
  const totalMins = getLogTimezoneOffsetMinutes(value);
  const sign = totalMins >= 0 ? '+' : '-';
  const abs = Math.abs(totalMins);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

function formatDateTimeInLogTimezone(value = Date.now(), { withOffset = false, separator = ' ' } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: OPENCLAW_LOG_TIMEZONE,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(date).reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
    const base = `${parts.year}-${parts.month}-${parts.day}${separator}${parts.hour}:${parts.minute}:${parts.second}`;
    if (!withOffset) return base;
    return `${base}${formatLogTimezoneOffset(date)}`;
  } catch {
    const pad = (n) => String(n).padStart(2, '0');
    const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${separator}${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    if (!withOffset) return base;
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const offsetHour = pad(Math.floor(Math.abs(offsetMinutes) / 60));
    const offsetMin = pad(Math.abs(offsetMinutes) % 60);
    return `${base}${sign}${offsetHour}:${offsetMin}`;
  }
}

function parseLocalLogTimestampToMs(localText) {
  const m = String(localText || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return 0;
  const utcGuess = Date.UTC(year, month, day, hour, minute, second);
  let offset = getLogTimezoneOffsetMinutes(utcGuess);
  let ts = utcGuess - (offset * 60 * 1000);
  const adjusted = getLogTimezoneOffsetMinutes(ts);
  if (adjusted !== offset) {
    offset = adjusted;
    ts = utcGuess - (offset * 60 * 1000);
  }
  return Number.isFinite(ts) ? ts : 0;
}

function logTimestamp() {
  return formatDateTimeInLogTimezone(Date.now());
}

function wrapConsole(method) {
  return (...args) => baseConsole[method](`[${logTimestamp()}]`, ...args);
}

console.log = wrapConsole('log');
console.info = wrapConsole('info');
console.warn = wrapConsole('warn');
console.error = wrapConsole('error');
console.debug = wrapConsole('debug');

dns.setDefaultResultOrder('verbatim');

async function fetchWithFallback(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 30000);
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return resp;
  } catch (fetchErr) {
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
let activeTerminalSession = null;

function closeActiveTerminalSession(reason = 'replaced') {
  const sess = activeTerminalSession;
  if (!sess) return;
  activeTerminalSession = null;
  try {
    if (sess.ws && sess.ws.readyState === 1) {
      sess.ws.send(JSON.stringify({ type: 'output', data: `\n[terminal] session closed: ${reason}\n` }));
    }
  } catch {}
  try {
    if (typeof sess.cleanup === 'function') sess.cleanup();
  } catch {}
  try {
    if (sess.ws) sess.ws.close(1012, 'session-replaced');
  } catch {}
}

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

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Skip strict CSP for proxied apps — they load their own CDN resources
  if (!req.path.startsWith('/apps/')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; frame-ancestors 'self'"
    );
  }
  next();
});

const PORT = 3000;

const CONFIG_PATH = '/root/.openclaw/openclaw.json';
const WEB_AI_CONFIG_PATH = '/root/.openclaw/web-ai-config.json';
const DOCKER_CONFIG_PATH = '/root/.openclaw/docker-config.json';
const OPENCLAW_INSTALL_INSTANCE_ID_PATH = '/root/.openclaw/install-instance-id';
const STT_CONFIG_PATH = '/root/.openclaw/stt-config.json';
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
const DEVICE_PAIRING_PENDING_PATH = '/root/.openclaw/devices/pending.json';
const DEVICE_PAIRING_PAIRED_PATH = '/root/.openclaw/devices/paired.json';
const DEVICE_IDENTITY_PATH = '/root/.openclaw/identity/device.json';
const DEVICE_AUTH_STORE_PATH = '/root/.openclaw/identity/device-auth.json';
const NODE_STATUS_CACHE_PATH = '/root/.openclaw/node-status-cache.json';
const NODE_STATUS_POLL_INTERVAL_MS = 5000;
const NODE_STATUS_MAX_STALE_MS = 4500;
const NODE_STATUS_GATEWAY_RECONNECT_GRACE_MS = 30000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CONTROL_UI_BACKEND_CLIENT_ID = 'openclaw-control-ui';
const CONTROL_UI_BACKEND_DISPLAY_NAME = 'OpenClaw Web Panel Backend';

app.use(express.json({ limit: '20mb' }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    console.warn(`[web][warn] invalid JSON payload: ${err.message}`);
    return res.status(400).json({ error: 'invalid JSON payload' });
  }
  return next(err);
});

// ============================================================
// Helpers: JSON read/write
// ============================================================

function readJson(p, fallback) {
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

const AI_AGENT_DIR = '/root/.openclaw/agents/main/agent';
const AI_MODELS_PATH = path.join(AI_AGENT_DIR, 'models.json');
const AI_AUTH_PROFILES_PATH = path.join(AI_AGENT_DIR, 'auth-profiles.json');
const AUTH_PROFILE_META_KEYS = new Set(['version', 'profiles', 'lastGood', 'usageStats']);
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';

function normalizeAuthProfiles(raw) {
  let authProfiles = raw && typeof raw === 'object' ? { ...raw } : {};
  if (!authProfiles.profiles || typeof authProfiles.profiles !== 'object' || Array.isArray(authProfiles.profiles)) {
    const oldEntries = Object.entries(authProfiles).filter(([k]) => !AUTH_PROFILE_META_KEYS.has(k));
    authProfiles = { version: 1, profiles: {} };
    for (const [k, v] of oldEntries) {
      if (v && typeof v === 'object' && !Array.isArray(v)) authProfiles.profiles[k] = v;
    }
  }
  if (!authProfiles.version) authProfiles.version = 1;
  return authProfiles;
}

function readAiAuthProfiles() {
  return normalizeAuthProfiles(readJson(AI_AUTH_PROFILES_PATH, {}));
}

function writeAiAuthProfiles(obj) {
  writeJson(AI_AUTH_PROFILES_PATH, normalizeAuthProfiles(obj));
}

function getAuthProfileSecret(profile) {
  return profile?.apiKey || profile?.key || profile?.token || '';
}

function getAuthProfileIdentity(profile) {
  return getAuthProfileSecret(profile) || profile?.keyRef?.id || profile?.tokenRef?.id || profile?.email || '';
}

function buildConfiguredKeySignature(provider, authType, rawKey) {
  return `${provider}::${authType}::${rawKey}`;
}

function removeDuplicateProfilesBySecret(authProfiles, provider, rawSecret, keepProfileId) {
  if (!rawSecret) return;
  for (const [profileId, profile] of Object.entries(authProfiles.profiles || {})) {
    if (profileId === keepProfileId) continue;
    if (profile?.provider !== provider) continue;
    if (getAuthProfileSecret(profile) !== rawSecret) continue;
    delete authProfiles.profiles[profileId];
  }
  const topLevelProfile = authProfiles[provider];
  if (topLevelProfile?.provider === provider && getAuthProfileSecret(topLevelProfile) === rawSecret) {
    delete authProfiles[provider];
  }
}

function saveCanonicalCopilotAuthProfile(authProfiles, githubToken) {
  const profileId = 'github-copilot:github';
  authProfiles.profiles[profileId] = {
    type: 'token',
    provider: 'github-copilot',
    mode: 'token',
    token: githubToken,
    addedAt: Date.now()
  };
  removeDuplicateProfilesBySecret(authProfiles, 'github-copilot', githubToken, profileId);
  delete authProfiles.profiles['github-copilot'];
  delete authProfiles['github-copilot'];
  return profileId;
}

async function resolveCopilotProviderBaseUrl(githubToken) {
  if (!githubToken) return DEFAULT_COPILOT_API_BASE_URL;
  try {
    const tokenRes = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/json',
        'User-Agent': 'GitHubCopilotChat/0.22.2024'
      },
      signal: AbortSignal.timeout(30000)
    });
    if (!tokenRes.ok) return DEFAULT_COPILOT_API_BASE_URL;
    const tokenData = await tokenRes.json();
    const copilotApiToken = tokenData?.token || '';
    const epMatch = copilotApiToken.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
    if (!epMatch) return DEFAULT_COPILOT_API_BASE_URL;
    return `https://${epMatch[1].replace(/^proxy\./, 'api.')}`;
  } catch {
    return DEFAULT_COPILOT_API_BASE_URL;
  }
}

function readAiModels() {
  const models = readJson(AI_MODELS_PATH, { providers: {} }) || { providers: {} };
  if (!models.providers || typeof models.providers !== 'object' || Array.isArray(models.providers)) {
    models.providers = {};
  }
  return models;
}

function writeAiModels(obj) {
  const models = obj && typeof obj === 'object' ? obj : { providers: {} };
  if (!models.providers || typeof models.providers !== 'object' || Array.isArray(models.providers)) {
    models.providers = {};
  }
  writeJson(AI_MODELS_PATH, models);
}

// ============================================================
// Helpers: API Key encryption/decryption (AES-256-CBC + PBKDF2)
// ============================================================
const ENC_KEY_PATH = '/root/.openclaw/.enc_key';

function getEncryptionKey() {
  try {
    return fs.readFileSync(ENC_KEY_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function ensureEncryptionKey() {
  if (fs.existsSync(ENC_KEY_PATH)) return;
  try {
    const key = crypto.randomBytes(32).toString('base64').slice(0, 32);
    fs.mkdirSync(path.dirname(ENC_KEY_PATH), { recursive: true });
    fs.writeFileSync(ENC_KEY_PATH, key, { mode: 0o400 });
    console.log('[enc] Encryption master key auto-generated');
  } catch (e) {
    console.warn('[enc] Cannot generate encryption key:', e.message);
  }
}

function encryptValue(plaintext) {
  const key = getEncryptionKey();
  if (!key || !plaintext) return plaintext;
  try {
    const salt = crypto.randomBytes(8);
    const derived = crypto.pbkdf2Sync(key, salt, 10000, 48, 'sha256');
    const aesKey = derived.subarray(0, 32);
    const iv = derived.subarray(32, 48);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    let enc = cipher.update(plaintext, 'utf8', 'base64');
    enc += cipher.final('base64');
    return 'ENC:' + salt.toString('base64') + ':' + enc;
  } catch (e) {
    console.warn('[enc] Encryption failed:', e.message);
    return plaintext;
  }
}

function decryptValue(encrypted) {
  const key = getEncryptionKey();
  if (!key || !encrypted) return encrypted;
  if (typeof encrypted !== 'string' || !encrypted.startsWith('ENC:')) return encrypted;
  try {
    const parts = encrypted.split(':');
    if (parts.length < 3) return encrypted;
    const saltB64 = parts[1];
    const dataB64 = parts.slice(2).join(':');
    const salt = Buffer.from(saltB64, 'base64');
    const derived = crypto.pbkdf2Sync(key, salt, 10000, 48, 'sha256');
    const aesKey = derived.subarray(0, 32);
    const iv = derived.subarray(32, 48);
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    let dec = decipher.update(dataB64, 'base64', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch (e) {
    console.warn('[enc] Decryption failed:', e.message);
    return encrypted;
  }
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  const plain = key.startsWith('ENC:') ? decryptValue(key) : key;
  if (!plain || plain.length < 8) return '••••••••';
  return plain.slice(0, 5) + '•••' + plain.slice(-3);
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('ENC:');
}

// Ensure encryption key exists at startup
ensureEncryptionKey();

// Auto-fix: decrypt incorrectly encrypted API keys in models.json to plaintext
// （models.json must keep plaintext because openclaw gateway reads directly）
function repairModelsJsonApiKeys() {
  const modelsPath = '/root/.openclaw/agents/main/agent/models.json';
  try {
    if (!fs.existsSync(modelsPath)) return;
    const models = readJson(modelsPath, null);
    if (!models?.providers) return;
    let changed = false;
    for (const [pName, prov] of Object.entries(models.providers)) {
      if (prov?.apiKey && typeof prov.apiKey === 'string' && isEncrypted(prov.apiKey)) {
        const decrypted = decryptValue(prov.apiKey);
        if (decrypted && decrypted !== prov.apiKey) {
          prov.apiKey = decrypted;
          changed = true;
          console.log(`[enc] Restored ${pName} API key to plaintext (openclaw requires plaintext)`);
        }
      }
    }
    if (changed) {
      writeJson(modelsPath, models);
      console.log('[enc] models.json API key fix complete');
    }
  } catch (e) {
    console.warn('[enc] API key fix failed:', e.message);
  }
}
setTimeout(repairModelsJsonApiKeys, 3000);

// ============================================================
// OpenClaw built-in model catalog — loaded from models.generated.js at startup
// Used for auto-querying model capabilities (reasoning, contextWindow, etc.) when saving config
// ============================================================
let _openclawModelCatalog = null; // { provider: { modelId: { name, api, reasoning, input, contextWindow, maxTokens, compat } } }

// Our provider name → OpenClaw built-in provider name mapping
const PROVIDER_TO_OPENCLAW_MAP = {
  'gemini': 'google',
  'google': 'google',
  'openai': 'openai',
  'anthropic': 'anthropic',
  'github-copilot': 'github-copilot',
  'bedrock': 'amazon-bedrock',
  'amazon-bedrock': 'amazon-bedrock',
  'groq': 'groq',
  'mistral': 'mistral',
  'xai': 'xai',
  'openrouter': 'openrouter',
  'cerebras': 'cerebras',
  'huggingface': 'huggingface',
  'minimax': 'minimax',
  'minimax-cn': 'minimax-cn',
  'zai': 'zai',
  'kimi-coding': 'kimi-coding',
  'google-vertex': 'google-vertex',
};

// Load OpenClaw built-in model catalog
function loadOpenClawModelCatalog() {
  // Support multiple possible install paths：npm-global install and openclaw-source source install
  const catalogPaths = [
    '/root/.openclaw/openclaw-source/node_modules/@mariozechner/pi-ai/dist/models.generated.js',
    '/root/.npm-global/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/models.generated.js',
  ];
  const catalogPath = catalogPaths.find(p => fs.existsSync(p.replace('/dist/models.generated.js', '')));
  try {
    if (!catalogPath) {
      // Try loading from cache
      const cachePath = '/root/.openclaw/model-catalog-cache.json';
      if (fs.existsSync(cachePath)) {
        _openclawModelCatalog = readJson(cachePath, null);
        if (_openclawModelCatalog) {
          console.log(`[catalog] Loaded model catalog from cache (${Object.keys(_openclawModelCatalog).length} providers)`);
          return;
        }
      }
      console.log('[catalog] OpenClaw Model catalog not found');
      return;
    }
    // Load MODELS from ESM module via require
    const { execSync } = require('child_process');
    const json = execSync(`node -e "const m = require('${catalogPath}'); process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(m.MODELS).map(([p, models]) => [p, Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens, compat: model.compat || undefined }]))]))))"`, {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    });
    _openclawModelCatalog = JSON.parse(json);
    // Cache to file
    try {
      fs.writeFileSync('/root/.openclaw/model-catalog-cache.json', json, { encoding: 'utf8', mode: 0o600 });
    } catch {}
    const totalModels = Object.values(_openclawModelCatalog).reduce((sum, prov) => sum + Object.keys(prov).length, 0);
    console.log(`[catalog] Loaded OpenClaw model catalog: ${Object.keys(_openclawModelCatalog).length} providers, ${totalModels} models`);
  } catch (e) {
    console.warn('[catalog] Failed to load model catalog:', e.message);
  }
}
setTimeout(loadOpenClawModelCatalog, 1000);

/**
 * Add probe-verified model capabilities to built-in catalog and persist to model-catalog-cache.json
 * So next lookupModelCapabilities hits directly in step 1/2 without family inference or re-probing
 */
function addModelToCatalog(providerName, modelId, capabilities) {
  if (!_openclawModelCatalog) return;
  const provKey = providerName.toLowerCase();
  if (!_openclawModelCatalog[provKey]) _openclawModelCatalog[provKey] = {};
  // Keep only safe catalog fields, exclude internal markers and working fields
  const catalogFields = {};
  for (const field of ['name', 'api', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'compat', 'cost', 'headers']) {
    if (capabilities[field] !== undefined) catalogFields[field] = capabilities[field];
  }
  _openclawModelCatalog[provKey][modelId] = catalogFields;
  // Persist to cache file
  try {
    fs.writeFileSync('/root/.openclaw/model-catalog-cache.json',
      JSON.stringify(_openclawModelCatalog), { encoding: 'utf8', mode: 0o600 });
  } catch {}
  console.log(`[catalog] Probe results written to model catalog: ${provKey}/${modelId}`);
}

// Gateway-supported api enum values (must validate when writing openclaw.json)
const VALID_GATEWAY_API_VALUES = new Set([
  'openai-completions', 'openai-responses', 'openai-codex-responses',
  'anthropic-messages', 'google-generative-ai', 'github-copilot',
  'bedrock-converse-stream', 'ollama'
]);

/**
 * Map catalog api value to gateway-valid value
 * If value not in supported list, return safe default for provider
 */
function sanitizeApiValue(api, providerName) {
  if (!api || VALID_GATEWAY_API_VALUES.has(api)) return api;
  // Common mapping: azure-openai-responses → openai-responses
  const FALLBACK_MAP = {
    'azure-openai-responses': 'openai-responses',
    'azure-openai-completions': 'openai-completions',
  };
  if (FALLBACK_MAP[api]) return FALLBACK_MAP[api];
  // Default by provider
  const PROVIDER_DEFAULT_API = {
    'github-copilot': 'github-copilot',
    'gemini': 'google-generative-ai',
    'anthropic': 'anthropic-messages',
    'ollama': 'ollama',
    'bedrock': 'bedrock-converse-stream',
  };
  return PROVIDER_DEFAULT_API[providerName] || 'openai-completions';
}

function normalizeProviderApiForSync(currentApi, providerName, fallbackApi) {
  const normalizedCurrent = sanitizeApiValue(currentApi, providerName);
  if (normalizedCurrent && VALID_GATEWAY_API_VALUES.has(normalizedCurrent)) {
    return normalizedCurrent;
  }
  if (providerName === 'github-copilot') return 'github-copilot';
  return sanitizeApiValue(fallbackApi, providerName) || fallbackApi;
}

/**
 * Query model capabilities from OpenClaw built-in catalog
 * @param {string} providerName - Our provider name (e.g. 'gemini', 'bailian')
 * @param {string} modelId - model ID (e.g. 'gemini-3-flash-preview')
 * @returns {object|null} model capability definition, or null (when not found)
 */
function lookupModelCapabilities(providerName, modelId) {
  if (!_openclawModelCatalog) {
    loadOpenClawModelCatalog();
  }
  if (!_openclawModelCatalog) return { _catalogUnavailable: true };

  // 1. Direct lookup: try mapped provider name first
  const openclawProvider = PROVIDER_TO_OPENCLAW_MAP[providerName.toLowerCase()] || providerName.toLowerCase();
  const providerModels = _openclawModelCatalog[openclawProvider];
  if (providerModels && providerModels[modelId]) {
    return providerModels[modelId];
  }

  // 2. Fuzzy match: search by modelId across all providers (handle name mismatch)
  for (const [prov, models] of Object.entries(_openclawModelCatalog)) {
    if (models[modelId]) {
      return models[modelId];
    }
  }

  // 3. Prefix match: e.g. 'gemini-3-flash-preview-0508' matches 'gemini-3-flash-preview'
  for (const [prov, models] of Object.entries(_openclawModelCatalog)) {
    for (const [id, model] of Object.entries(models)) {
      if (modelId.startsWith(id) || id.startsWith(modelId)) {
        return model;
      }
    }
  }

  // 4. Family prefix match: extract model family prefix (alpha), match same-family models
  // e.g. 'qwen3.5-plus' → 'qwen'，'claude-sonnet-4' → 'claude'，matches any model in the same family in the OpenClaw catalog
  const familyMatch = modelId.match(/^([a-z]+)/i);
  if (familyMatch) {
    const familyPrefix = familyMatch[1].toLowerCase();
    // Search all providers for any same-family model (starting with prefix)
    for (const [prov, models] of Object.entries(_openclawModelCatalog)) {
      for (const [id, model] of Object.entries(models)) {
        // Check if model ID starts with family prefix（considering multiple naming formats：qwen-xxx, qwen/xxx, qwen_xxx）
        const idLower = id.toLowerCase();
        if (idLower.startsWith(familyPrefix + '-') ||
            idLower.startsWith(familyPrefix + '/') ||
            idLower.startsWith(familyPrefix + '_') ||
            idLower === familyPrefix) {
          // Found same-family model, marked as speculative match
          return {
            ...model,
            _inferred: true,
            _matchedFamily: familyPrefix,
            _originalId: modelId
          };
        }
      }
    }
  }

  return null;
}

/**
 * Generate complete models.json entry for specified model
 * Prefer real capabilities from OpenClaw built-in catalog，use safe defaults when not matched
 * @param {string} providerName - provider name
 * @param {string} modelId - model ID
 * @returns {object} complete model entry
 */
function buildModelEntry(providerName, modelId) {
  const catalogEntry = lookupModelCapabilities(providerName, modelId);

  if (catalogEntry?._catalogUnavailable) {
    console.log(`[catalog] Model catalog unavailable, model ${providerName}/${modelId} using safe defaults`);
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096
    };
  }

  if (catalogEntry) {
    const isInferred = catalogEntry._inferred;
    const safeApi = sanitizeApiValue(catalogEntry.api, providerName) || 'openai-completions';
    const resolvedReasoning = catalogEntry.reasoning ?? false;
    const resolvedInput = catalogEntry.input || ['text'];
    const resolvedCost = catalogEntry.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const resolvedContextWindow = catalogEntry.contextWindow || 128000;
    const resolvedMaxTokens = catalogEntry.maxTokens || 4096;
    if (catalogEntry.api != null && safeApi !== catalogEntry.api) {
      console.log(`[catalog] model ${providerName}/${modelId} api value "${catalogEntry.api}" not supported by gateway, mapped to "${safeApi}"`);
    }
    if (isInferred) {
      console.log(`[catalog] model ${providerName}/${modelId} Family match succeeded (${catalogEntry._matchedFamily}), using inferred same-family params: reasoning=${resolvedReasoning}, api=${safeApi}, ctx=${resolvedContextWindow}`);
    } else {
      console.log(`[catalog] model ${providerName}/${modelId} matched built-in catalog: reasoning=${resolvedReasoning}, api=${safeApi}, ctx=${resolvedContextWindow}`);
    }
    return {
      id: modelId,
      name: isInferred ? modelId : (catalogEntry.name || modelId),
      api: safeApi,
      ...(catalogEntry.headers ? { headers: catalogEntry.headers } : {}),
      reasoning: resolvedReasoning,
      input: resolvedInput,
      cost: resolvedCost,
      contextWindow: resolvedContextWindow,
      maxTokens: resolvedMaxTokens,
      ...(catalogEntry.compat ? { compat: catalogEntry.compat } : {})
    };
  }

  // Not found in built-in catalog — using safe defaults
  console.log(`[catalog] model ${providerName}/${modelId} not found in built-in catalog, using safe defaults (reasoning=false)`);
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  };
}

/**
 * Test if model is actually available
 * Send minimal chat completion request to provider to verify model exists
 * Use execFileSync + curl array args, inherit proxy env and avoid shell injection
 * @param {string} provider - provider name
 * @param {string} modelId - model ID
 * @param {string} apiKey - API Key
 * @param {string} baseUrl - API base URL
 * @returns {Promise<{available: boolean, error?: string}>}
 */
async function testModelAvailability(provider, modelId, apiKey, baseUrl) {
  const startTime = Date.now();
  try {
    const endpoint = baseUrl || getDefaultBaseUrl(provider);
    if (!endpoint) {
      return { available: false, error: 'API endpoint not found' };
    }

    const { execFile } = require('child_process');

    const url = `${endpoint}/chat/completions`;
    const authHeader = provider === 'anthropic' ? 'x-api-key' : 'Authorization';
    const authValue = provider === 'anthropic' ? apiKey : `Bearer ${apiKey}`;

    const body = JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5
    });

    // execFile uses array args without shell, preventing command injection
    const args = [
      '-sS', '--connect-timeout', '10', '--max-time', '20',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `${authHeader}: ${authValue}`,
      '-d', body,
      '-w', '\n%{http_code}',
      url
    ];

    const result = await new Promise((resolve, reject) => {
      execFile('curl', args, {
        encoding: 'utf8',
        timeout: 30000,
        env: process.env,
        maxBuffer: 1024 * 1024
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || err.message || 'curl failed').trim()));
          return;
        }
        resolve(String(stdout || ''));
      });
    });

    const lines = result.trim().split('\n');
    const httpCode = parseInt(lines[lines.length - 1], 10);
    const responseBody = lines.slice(0, -1).join('\n');
    const elapsed = Date.now() - startTime;

    if (httpCode >= 200 && httpCode < 300) {
      console.log(`[model-test] ${provider}/${modelId} test passed (${elapsed}ms)`);
      return { available: true };
    }

    console.log(`[model-test] ${provider}/${modelId} test failed: HTTP ${httpCode} (${elapsed}ms)`);
    return { available: false, error: `HTTP ${httpCode}: ${responseBody.slice(0, 200)}` };

  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.log(`[model-test] ${provider}/${modelId} test error: ${e.message} (${elapsed}ms)`);
    return { available: false, error: e.message };
  }
}

const INFERRED_MODEL_VALIDATION_MAX_ATTEMPTS = 8;
const INFERRED_MODEL_VALIDATION_TOTAL_TIMEOUT_MS = 3 * 60 * 1000;
const INFERRED_MODEL_VALIDATION_RETRY_DELAY_MS = 15000;
const INFERRED_MODEL_VALIDATION_BUSY_DELAY_MS = 10000;
const INFERRED_MODEL_FETCH_TIMEOUT_MS = 25000;
const pendingInferredModelValidationJobs = new Map();

function pickPositiveNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.round(num);
  }
  return undefined;
}

function pickBooleanValue(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function pickStringValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeInputModalities(...values) {
  const seen = new Set();
  const result = [];
  const pushValue = (value) => {
    if (!value) return;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return;
    const mapped = normalized === 'vision'
      ? 'image'
      : normalized === 'images'
        ? 'image'
        : normalized === 'texts'
          ? 'text'
          : normalized;
    if (!seen.has(mapped)) {
      seen.add(mapped);
      result.push(mapped);
    }
  };

  for (const value of values) {
    if (Array.isArray(value)) {
      value.forEach(pushValue);
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, enabled]) => {
        if (enabled) pushValue(key);
      });
    } else {
      pushValue(value);
    }
  }

  return result.length > 0 ? result : undefined;
}

function normalizeProviderModelId(providerName, rawId) {
  if (!rawId) return '';
  let normalized = String(rawId).trim();
  if (!normalized) return '';
  if (normalized.startsWith('models/')) normalized = normalized.slice('models/'.length);
  const prefix = `${providerName}/`;
  if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
    normalized = normalized.slice(prefix.length);
  }
  return normalized;
}

function buildRuntimeModelFieldOverrides(providerName, remoteModel) {
  if (!remoteModel || typeof remoteModel !== 'object') return null;

  const contextWindow = pickPositiveNumber(
    remoteModel.contextWindow,
    remoteModel.context_window,
    remoteModel.contextLength,
    remoteModel.context_length,
    remoteModel.maxContextTokens,
    remoteModel.max_context_tokens,
    remoteModel.inputTokenLimit,
    remoteModel.input_token_limit,
    remoteModel.architecture?.context_length,
    remoteModel.architecture?.max_context_length,
    remoteModel.top_provider?.context_length,
    remoteModel.capabilities?.contextWindow,
    remoteModel.capabilities?.context_window,
    remoteModel.limits?.contextWindow,
    remoteModel.limits?.context_window,
    remoteModel.metadata?.contextWindow,
    remoteModel.metadata?.context_window
  );

  const maxTokens = pickPositiveNumber(
    remoteModel.maxTokens,
    remoteModel.max_tokens,
    remoteModel.maxOutputTokens,
    remoteModel.max_output_tokens,
    remoteModel.outputTokenLimit,
    remoteModel.output_token_limit,
    remoteModel.top_provider?.max_completion_tokens,
    remoteModel.capabilities?.maxTokens,
    remoteModel.capabilities?.max_tokens,
    remoteModel.limits?.maxTokens,
    remoteModel.limits?.max_tokens,
    remoteModel.metadata?.maxTokens,
    remoteModel.metadata?.max_tokens
  );

  const reasoning = pickBooleanValue(
    remoteModel.reasoning,
    remoteModel.supportsReasoning,
    remoteModel.supports_reasoning,
    remoteModel.reasoning_enabled,
    remoteModel.capabilities?.reasoning,
    remoteModel.capabilities?.supportsReasoning,
    remoteModel.features?.reasoning
  );

  const api = sanitizeApiValue(
    pickStringValue(
      remoteModel.api,
      remoteModel.apiType,
      remoteModel.api_type,
      remoteModel.type
    ),
    providerName
  );

  const input = normalizeInputModalities(
    remoteModel.input,
    remoteModel.input_modalities,
    remoteModel.supported_input_modalities,
    remoteModel.modalities?.input,
    remoteModel.capabilities?.input,
    remoteModel.capabilities?.modalities,
    remoteModel.features?.input
  );

  const overrides = {
    name: pickStringValue(remoteModel.displayName, remoteModel.name),
    api,
    reasoning,
    input,
    contextWindow,
    maxTokens
  };

  return Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
}

function applyModelFieldOverrides(baseEntry, overrides) {
  if (!overrides || typeof overrides !== 'object') return baseEntry;
  const next = { ...baseEntry };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    next[key] = value;
  }
  return next;
}

function shouldRetryInferredModelValidation(errorText) {
  const text = String(errorText || '').toLowerCase();
  if (!text) return false;
  if (/http 400|http 401|http 403|http 404|invalid api key|Model unavailable|model_not_found|not found/.test(text)) return false;
  return /timeout|timed out|econn|socket|network|fetch failed|http 429|http 500|http 502|http 503|http 504|temporar|rate limit|unavailable/.test(text);
}

async function fetchRemoteProviderModels(provider, apiKey, baseUrl) {
  const endpoint = baseUrl || getDefaultBaseUrl(provider);
  if (!endpoint) return { ok: false, error: 'API endpoint not found', models: [] };
  if (provider === 'anthropic') return { ok: false, error: 'Anthropic does not support /models endpoint', models: [] };

  const modelsUrl = provider === 'ollama' ? `${endpoint}/api/tags` : `${endpoint}/models`;
  const headers = {};
  let fetchUrl = modelsUrl;

  if (provider === 'gemini') {
    if (!apiKey) return { ok: false, error: 'Gemini missing API Key', models: [] };
    fetchUrl = `${modelsUrl}?key=${encodeURIComponent(apiKey)}`;
  } else if (!['ollama', 'lmstudio', 'vllm'].includes(provider) && apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(fetchUrl, {
      headers,
      signal: AbortSignal.timeout(INFERRED_MODEL_FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, models: [] };
    }

    const data = await response.json();
    const rawModels = provider === 'ollama'
      ? (data.models || [])
      : provider === 'gemini'
        ? (data.models || [])
        : (data.data || data.models || []);

    const models = rawModels.map((rawModel) => {
      const rawId = rawModel?.id || rawModel?.name || rawModel?.model || rawModel?.slug;
      const modelId = normalizeProviderModelId(provider, rawId);
      if (!modelId) return null;
      return {
        id: modelId,
        raw: rawModel,
        overrides: buildRuntimeModelFieldOverrides(provider, rawModel)
      };
    }).filter(Boolean);

    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err?.message || 'Failed to fetch model list', models: [] };
  }
}

function formatRuntimeModelOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object') return 'No additional parameters';
  const parts = [];
  if (overrides.reasoning !== undefined) parts.push(`reasoning=${overrides.reasoning}`);
  if (overrides.api) parts.push(`api=${overrides.api}`);
  if (overrides.contextWindow) parts.push(`ctx=${overrides.contextWindow}`);
  if (overrides.maxTokens) parts.push(`max=${overrides.maxTokens}`);
  if (Array.isArray(overrides.input) && overrides.input.length > 0) parts.push(`input=${overrides.input.join(',')}`);
  return parts.length > 0 ? parts.join(', ') : 'No additional parameters';
}

const pendingDeferredGatewayRestartRequests = new Map();

function queueGatewayRestartWhenIdle(source = 'manual-deferred', options = {}) {
  const key = String(source || 'manual-deferred');
  if (pendingDeferredGatewayRestartRequests.has(key)) return;

  const pollMs = Math.max(1000, Number(options.pollMs || 5000));
  const maxWaitMs = Math.max(pollMs, Number(options.maxWaitMs || 180000));
  const startedAt = Date.now();

  const tick = () => {
    const current = getOpenClawOperationState();
    if (current.type === 'idle') {
      pendingDeferredGatewayRestartRequests.delete(key);
      queueGatewayRestart(key);
      console.log(`[openclaw][restart] deferred request activated (${key})`);
      return;
    }
    if ((Date.now() - startedAt) >= maxWaitMs) {
      pendingDeferredGatewayRestartRequests.delete(key);
      console.log(`[openclaw][restart] deferred request expired (${key}), current operation=${current.type}`);
      return;
    }
    const timer = setTimeout(tick, pollMs);
    pendingDeferredGatewayRestartRequests.set(key, { startedAt, timer });
  };

  const timer = setTimeout(tick, pollMs);
  pendingDeferredGatewayRestartRequests.set(key, { startedAt, timer });
  console.log(`[openclaw][restart] deferred request scheduled (${key})`);
}

function buildSafePendingModelEntry(modelId) {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  };
}

function collectConfiguredModelStrings(config) {
  const configuredModels = new Set();
  const defaults = config?.agents?.defaults || {};
  const primary = defaults.model?.primary;
  if (primary && primary.includes('/')) configuredModels.add(primary);
  if (Array.isArray(defaults.model?.fallbacks)) defaults.model.fallbacks.forEach(m => m && configuredModels.add(m));
  const curSub = defaults.subagents?.model;
  if (typeof curSub === 'string' && curSub) configuredModels.add(curSub);
  if (curSub?.primary) configuredModels.add(curSub.primary);
  if (Array.isArray(curSub?.fallbacks)) curSub.fallbacks.forEach(m => m && configuredModels.add(m));
  return configuredModels;
}

function getModelValidationCredentials(providerName, authProfiles = null) {
  let modelApiKey = '';
  let modelBaseUrl = '';
  try {
    const modelsCfg = readAiModels();
    modelApiKey = modelsCfg.providers?.[providerName]?.apiKey || '';
    modelBaseUrl = modelsCfg.providers?.[providerName]?.baseUrl || '';
  } catch {}

  const resolvedAuthProfiles = authProfiles || readJson('/root/.openclaw/agents/main/agent/auth-profiles.json', {});
  if (!modelApiKey) {
    for (const [, profile] of Object.entries(resolvedAuthProfiles?.profiles || {})) {
      if (profile?.provider === providerName) {
        modelApiKey = getAuthProfileSecret(profile) || '';
        break;
      }
    }
  }

  return { apiKey: modelApiKey, baseUrl: modelBaseUrl };
}

function ensureProviderShell(targetProviders, sourceProviders, provName) {
  if (targetProviders[provName]) return;
  const src = sourceProviders?.[provName] || {};
  targetProviders[provName] = {
    baseUrl: src.baseUrl || getDefaultBaseUrl(provName),
    api: src.api || 'openai-completions',
    models: []
  };
  if (src.apiKey && src.apiKey !== 'YOUR_API_KEY') {
    targetProviders[provName].apiKey = src.apiKey;
  }
}

function upsertProviderModelEntry(targetProviders, provName, modId, options = {}) {
  if (!targetProviders[provName]) return;
  if (!targetProviders[provName].models) targetProviders[provName].models = [];
  const existingIdx = targetProviders[provName].models.findIndex(m => m.id === modId);
  const catalogHit = options.resolvedCatalogHit !== undefined
    ? options.resolvedCatalogHit
    : lookupModelCapabilities(provName, modId);
  const usePendingEntry = !!options.deferInferredValidation && catalogHit && !catalogHit._catalogUnavailable && catalogHit._inferred;
  const baseEntry = options.resolvedEntry
    ? { ...options.resolvedEntry }
    : (usePendingEntry ? buildSafePendingModelEntry(modId) : buildModelEntry(provName, modId));
  const entry = applyModelFieldOverrides(baseEntry, options.fieldOverrides);
  if (existingIdx === -1) {
    targetProviders[provName].models.push(entry);
  } else {
    const existing = targetProviders[provName].models[existingIdx];
    for (const field of ['name', 'api', 'headers', 'reasoning', 'contextWindow', 'maxTokens', 'input', 'compat', 'cost']) {
      if (entry[field] !== undefined) existing[field] = entry[field];
    }
  }
  if (entry.api) {
    const desiredProvApi = normalizeProviderApiForSync(targetProviders[provName].api, provName, entry.api);
    if (desiredProvApi && desiredProvApi !== targetProviders[provName].api) {
      console.log(`[ensureModelEntry] Corrected provider ${provName}.api: ${targetProviders[provName].api} → ${desiredProvApi}`);
      targetProviders[provName].api = desiredProvApi;
    }
  }
}

async function finalizeInferredModelValidation(job, state = {}) {
  const configPath = '/root/.openclaw/openclaw.json';
  const modelsPath = '/root/.openclaw/agents/main/agent/models.json';
  let config = readJson(configPath, {});
  if (!collectConfiguredModelStrings(config).has(job.model)) {
    console.log(`[ai/config] ${job.model} no longer in current config, skipping background validation write-back`);
    return { status: 'done' };
  }

  const creds = getModelValidationCredentials(job.providerName);
  if (!creds.apiKey || creds.apiKey === 'YOUR_API_KEY') {
    console.log(`[ai/config] ${job.model} Background validation skipped: ${job.providerName} has no valid API Key configured`);
    return { status: 'done' };
  }

  console.log(`[ai/config] ${job.model} Family match succeeded (${job.matchedFamily})，starting attempt #${state.attempts || 1}  background runtime verification...`);
  const remoteModelsResult = await fetchRemoteProviderModels(job.providerName, creds.apiKey, creds.baseUrl);
  const remoteModel = remoteModelsResult.models.find((item) => item.id.toLowerCase() === String(job.modelId || '').toLowerCase()) || null;
  if (remoteModel?.overrides && Object.keys(remoteModel.overrides).length > 0) {
    console.log(`[ai/config] ${job.model} Background metadata hit, got real params: ${formatRuntimeModelOverrides(remoteModel.overrides)}`);
  } else if (remoteModelsResult.ok) {
    console.log(`[ai/config] ${job.model} Background metadata queried but provider returned no more precise params, keeping inferred values`);
  } else if (remoteModelsResult.error) {
    console.log(`[ai/config] ${job.model} Background metadata query failed: ${remoteModelsResult.error}`);
  }

  const testResult = await testModelAvailability(job.providerName, job.modelId, creds.apiKey, creds.baseUrl);
  if (!testResult.available) {
    const errorText = testResult.error || 'Model unavailable';
    const attemptCount = Number(state.attempts || 1);
    const queuedAt = Number(state.queuedAt || Date.now());
    const canRetry = attemptCount < INFERRED_MODEL_VALIDATION_MAX_ATTEMPTS
      && (Date.now() - queuedAt) < INFERRED_MODEL_VALIDATION_TOTAL_TIMEOUT_MS
      && shouldRetryInferredModelValidation(errorText);
    if (canRetry) {
      console.log(`[ai/config] ${job.model} Background runtime verification failed, will retry: ${errorText}`);
      return { status: 'retry', delayMs: INFERRED_MODEL_VALIDATION_RETRY_DELAY_MS };
    }
    console.log(`[ai/config] ${job.model} Background runtime verification failed, keeping current config: ${errorText}`);
    return { status: 'done' };
  }

  config = readJson(configPath, {});
  if (!collectConfiguredModelStrings(config).has(job.model)) {
    console.log(`[ai/config] ${job.model} Removed before background verification completed, skipping write-back`);
    return { status: 'done' };
  }

  const models = readAiModels();
  if (!models.providers) models.providers = {};
  if (!models.providers[job.providerName]) {
    models.providers[job.providerName] = {
      baseUrl: getDefaultBaseUrl(job.providerName),
      api: 'openai-completions',
      models: []
    };
  }
  if (!config.models) config.models = {};
  if (!config.models.providers) config.models.providers = {};
  ensureProviderShell(config.models.providers, models.providers, job.providerName);
  upsertProviderModelEntry(models.providers, job.providerName, job.modelId, { fieldOverrides: remoteModel?.overrides || null });
  upsertProviderModelEntry(config.models.providers, job.providerName, job.modelId, { fieldOverrides: remoteModel?.overrides || null });
  writeOpenClawConfig(config);
  const opState = getOpenClawOperationState();
  fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2), { encoding: 'utf8', mode: 0o600 });

  // Write verified real capabilities to built-in model catalog，subsequent lookup matches directly
  const finalEntry = (models.providers[job.providerName]?.models || []).find(m => m.id === job.modelId);
  if (finalEntry) {
    const { id, ...caps } = finalEntry;
    addModelToCatalog(job.providerName, job.modelId, caps);
  }

  if (opState.type === 'idle') {
    queueGatewayRestart('ai-config-async-model-validation');
    console.log(`[ai/config] ${job.model} Background runtime verification succeeded, config updated and Gateway reload requested`);
  } else if (opState.type === 'restarting_gateway') {
    queueGatewayRestartWhenIdle('ai-config-async-model-validation-post-restart');
    console.log(`[ai/config] ${job.model} Background runtime verification succeeded; Gateway reloading, registered post-reload restart`);
  } else {
    queueGatewayRestartWhenIdle('ai-config-async-model-validation-after-busy');
    console.log(`[ai/config] ${job.model} Background runtime verification succeeded; current operation ${opState.type} in progress, registered deferred reload`);
  }

  return { status: 'done' };
}

function queueInferredModelValidation(job) {
  const key = `${job.providerName}/${job.modelId}`;
  const existing = pendingInferredModelValidationJobs.get(key);
  if (existing?.timer) return;
  const state = existing || { queuedAt: Date.now(), attempts: 0, timer: null };

  const schedule = (delayMs) => {
    state.timer = setTimeout(async () => {
      state.timer = null;
      state.attempts += 1;

      if ((Date.now() - state.queuedAt) >= INFERRED_MODEL_VALIDATION_TOTAL_TIMEOUT_MS) {
        console.log(`[ai/config] ${job.model} Background verification exceeded total timeout ${Math.floor(INFERRED_MODEL_VALIDATION_TOTAL_TIMEOUT_MS / 1000)}s，stopping retries`);
        pendingInferredModelValidationJobs.delete(key);
        return;
      }

      const opState = getOpenClawOperationState();
      if (opState.type === 'installing' || opState.type === 'updating' || opState.type === 'uninstalling' || opState.type === 'repairing_config') {
        console.log(`[ai/config] ${job.model} Background verification encountered operation ${opState.type}, retrying in ${Math.floor(INFERRED_MODEL_VALIDATION_BUSY_DELAY_MS / 1000)}s`);
        schedule(INFERRED_MODEL_VALIDATION_BUSY_DELAY_MS);
        return;
      }

      if (state.attempts > INFERRED_MODEL_VALIDATION_MAX_ATTEMPTS) {
        console.log(`[ai/config] ${job.model} Background verification exceeded max attempts ${INFERRED_MODEL_VALIDATION_MAX_ATTEMPTS}，stopping retries`);
        pendingInferredModelValidationJobs.delete(key);
        return;
      }

      try {
        const result = await finalizeInferredModelValidation(job, state);
        if (result?.status === 'retry') {
          schedule(Number(result.delayMs || INFERRED_MODEL_VALIDATION_RETRY_DELAY_MS));
          return;
        }
      } catch (err) {
        if (state.attempts < INFERRED_MODEL_VALIDATION_MAX_ATTEMPTS
          && (Date.now() - state.queuedAt) < INFERRED_MODEL_VALIDATION_TOTAL_TIMEOUT_MS) {
          console.error(`[ai/config] ${job.model} Background runtime verification error, will retry:`, err?.message || err);
          schedule(INFERRED_MODEL_VALIDATION_RETRY_DELAY_MS);
          return;
        }
        console.error(`[ai/config] ${job.model} Background runtime verification error:`, err?.message || err);
      } finally {
        if (!state.timer) pendingInferredModelValidationJobs.delete(key);
      }
    }, Math.max(0, Number(delayMs || 0)));

    pendingInferredModelValidationJobs.set(key, state);
  };

  schedule(0);
}

/**
 * Get built-in provider list
 */
function getOpenClawBuiltinProviders() {
  if (!_openclawModelCatalog) return [];
  return Object.keys(_openclawModelCatalog);
}

/**
 * Get all built-in models for provider
 */
function getOpenClawProviderModels(providerName) {
  if (!_openclawModelCatalog) return [];
  const openclawProv = PROVIDER_TO_OPENCLAW_MAP[providerName.toLowerCase()] || providerName.toLowerCase();
  const models = _openclawModelCatalog[openclawProv];
  if (!models) return [];
  return Object.entries(models).map(([id, m]) => ({
    id,
    name: m.name || id,
    reasoning: m.reasoning,
    api: m.api,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    input: m.input
  }));
}

// Ensure models.json and openclaw.json models array contains configured models at startup
// Use OpenClaw built-in model catalog to auto-detect capabilities
function syncConfiguredModelsToModelsJson() {
  try {
    const modelsPath = '/root/.openclaw/agents/main/agent/models.json';
    const configPath = '/root/.openclaw/openclaw.json';
    if (!fs.existsSync(configPath)) return;
    const config = readJson(configPath, {});
    const defaults = config?.agents?.defaults || {};
    // Collect all configured models (provider/modelId)
    const configuredModels = [];
    const primary = defaults.model?.primary;
    if (primary && primary.includes('/')) configuredModels.push(primary);
    const fallbacks = defaults.model?.fallbacks || [];
    for (const fb of fallbacks) {
      if (fb && fb.includes('/')) configuredModels.push(fb);
    }
    const subPrimary = typeof defaults.subagents?.model === 'string'
      ? defaults.subagents.model
      : defaults.subagents?.model?.primary;
    if (subPrimary && subPrimary.includes('/')) configuredModels.push(subPrimary);
    const subFb = Array.isArray(defaults.subagents?.model?.fallbacks) ? defaults.subagents.model.fallbacks : [];
    for (const fb of subFb) {
      if (fb && fb.includes('/')) configuredModels.push(fb);
    }
    const uniqueConfiguredModels = Array.from(new Set(configuredModels));
    if (uniqueConfiguredModels.length === 0) return;
    const modelEntryCache = new Map();
    const modelCapsCache = new Map();
    const getCachedModelEntry = (provName, modelId) => {
      const key = `${provName}/${modelId}`;
      if (!modelEntryCache.has(key)) {
        modelEntryCache.set(key, buildModelEntry(provName, modelId));
      }
      const entry = modelEntryCache.get(key);
      return entry ? { ...entry } : entry;
    };
    const getCachedModelCapabilities = (provName, modelId) => {
      const key = `${provName}/${modelId}`;
      if (!modelCapsCache.has(key)) {
        modelCapsCache.set(key, lookupModelCapabilities(provName, modelId));
      }
      return modelCapsCache.get(key);
    };
    // Sync to openclaw.json (gateway reads this at startup to generate models.json)
    let configChanged = false;
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    for (const modelStr of uniqueConfiguredModels) {
      const [provName, modelId] = modelStr.split('/');
      const prov = config.models.providers[provName];
      if (!prov) continue;
      if (!prov.models) prov.models = [];
      const existingIdx = prov.models.findIndex(m => m.id === modelId);
      const entry = getCachedModelEntry(provName, modelId);
      // Queue family-speculative models for background runtime verification
      const caps = getCachedModelCapabilities(provName, modelId);
      if (caps && caps._inferred && caps._matchedFamily) {
        queueInferredModelValidation({
          model: modelStr,
          providerName: provName,
          modelId,
          matchedFamily: caps._matchedFamily
        });
      }
      if (existingIdx === -1) {
        prov.models.push(entry);
        configChanged = true;
        console.log(`[sync] Added model ${modelStr} to openclaw.json`);
      } else {
        // When exists, update key fields with catalog capabilities（keeping user custom value）
        const existing = prov.models[existingIdx];
        const fieldsToSync = ['name', 'api', 'headers', 'reasoning', 'contextWindow', 'maxTokens', 'input', 'compat', 'cost'];
        for (const field of fieldsToSync) {
          if (entry[field] !== undefined && JSON.stringify(existing[field]) !== JSON.stringify(entry[field])) {
            console.log(`[sync] Update ${modelStr}.${field}: ${JSON.stringify(existing[field])} → ${JSON.stringify(entry[field])}`);
            existing[field] = entry[field];
            configChanged = true;
          }
        }
      }
      // Provider-level api only corrected when current value is missing or invalid，do not flip per-model api.
      const syncedProviderApi = normalizeProviderApiForSync(prov.api, provName, entry.api);
      if (syncedProviderApi && prov.api && syncedProviderApi !== prov.api) {
        console.log(`[sync] Corrected provider ${provName}.api: ${prov.api} → ${syncedProviderApi} (from model catalog)`);
        prov.api = syncedProviderApi;
        configChanged = true;
      }
    }
    // Final consistency check: ensure all models api matches catalog
    for (const [provName, prov] of Object.entries(config.models.providers)) {
      if (!prov.models || !Array.isArray(prov.models)) continue;
      for (const m of prov.models) {
        const mCap = getCachedModelCapabilities(provName, m.id);
        const correctApi = sanitizeApiValue(mCap?.api, provName);
        if (correctApi && m.api !== correctApi) {
          console.log(`[sync] Corrected ${provName}/${m.id}.api: ${m.api} → ${correctApi}`);
          m.api = correctApi;
          configChanged = true;
        }
      }
    }
    if (configChanged) {
      writeJson(configPath, config);
      console.log('[sync] openclaw.json updated');
    }
    // Sync to models.json (if file exists)
    if (fs.existsSync(modelsPath)) {
      const models = readJson(modelsPath, { providers: {} });
      if (models?.providers) {
        let modelsChanged = false;
        for (const modelStr of uniqueConfiguredModels) {
          const [provName, modelId] = modelStr.split('/');
          const prov = models.providers[provName];
          if (!prov) continue;
          if (!prov.models) prov.models = [];
          const existingIdx = prov.models.findIndex(m => m.id === modelId);
          const entry = getCachedModelEntry(provName, modelId);
          if (existingIdx === -1) {
            prov.models.push(entry);
            modelsChanged = true;
            console.log(`[sync] Added model ${modelStr} to models.json`);
          } else {
            const existing = prov.models[existingIdx];
            const fieldsToSync = ['name', 'api', 'headers', 'reasoning', 'contextWindow', 'maxTokens', 'input', 'compat', 'cost'];
            for (const field of fieldsToSync) {
              if (entry[field] !== undefined && JSON.stringify(existing[field]) !== JSON.stringify(entry[field])) {
                existing[field] = entry[field];
                modelsChanged = true;
              }
            }
          }
          // Provider-level api only corrected when current value is missing or invalid。
          const syncedProviderApi = normalizeProviderApiForSync(prov.api, provName, entry.api);
          if (syncedProviderApi && prov.api && syncedProviderApi !== prov.api) {
            prov.api = syncedProviderApi;
            modelsChanged = true;
          }
        }
        // Final consistency check
        for (const [provName2, prov2] of Object.entries(models.providers)) {
          if (!prov2.models || !Array.isArray(prov2.models)) continue;
          for (const m of prov2.models) {
            const mCap = getCachedModelCapabilities(provName2, m.id);
            const correctApi = sanitizeApiValue(mCap?.api, provName2);
            if (correctApi && m.api !== correctApi) {
              m.api = correctApi;
              modelsChanged = true;
            }
          }
        }
        if (modelsChanged) {
          writeJson(modelsPath, models);
          console.log('[sync] models.json updated');
        }
      }
    }
  } catch (e) {
    console.warn('[sync] models.json Sync failed:', e.message);
  }
}
setTimeout(syncConfiguredModelsToModelsJson, 4000);

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

    const requiredTrusted = [
      '127.0.0.1',
      '127.0.0.0/8',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:127.0.0.0/104',
      '172.17.0.1',
      '172.17.0.0/16'
    ];
    for (const proxyIp of requiredTrusted) {
      if (currentTrusted.includes(proxyIp)) continue;
      currentTrusted.push(proxyIp);
      changed = true;
    }
    cfg.gateway.trustedProxies = currentTrusted;

    if (changed) {
      const backupPath = `${CONFIG_PATH}.bak.gateway-control-ui-${Date.now()}`;
      try { fs.copyFileSync(CONFIG_PATH, backupPath); } catch {}
      writeOpenClawConfig(cfg);
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
  writeOpenClawConfig(cfg);
  console.log('[config] removed legacy providers from openclaw.json to keep gateway schema valid');
  return true;
}

function tailFile(filePath, lines = 200, timeoutMs = 2500) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return execSync(`tail -${Math.max(1, Math.min(lines, LOG_TAIL_MAX_LINES))} "${filePath}"`, { encoding: 'utf8', timeout: timeoutMs });
  } catch {
    return '';
  }
}

function keepLastLines(text, maxLines = 200) {
  const list = String(text || '').split('\n');
  const safe = Math.max(20, Math.min(Number(maxLines || 200), LOG_VIEW_MAX_LINES));
  return list.slice(-safe).join('\n');
}

function extractLogTimestampMs(line) {
  const text = String(line || '');
  const startedAtMatch = text.match(/\bstartedAt=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?)\b/i);
  if (startedAtMatch?.[1]) {
    const startedText = String(startedAtMatch[1]);
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(startedText);
    if (hasOffset) {
      const ts = Date.parse(startedText.replace(' ', 'T'));
      if (Number.isFinite(ts)) return ts;
    } else {
      const ts = parseLocalLogTimestampToMs(startedText);
      if (Number.isFinite(ts)) return ts;
    }
  }
  const localMatch = text.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  if (localMatch?.[1]) {
    const ts = parseLocalLogTimestampToMs(localMatch[1]);
    if (Number.isFinite(ts)) return ts;
  }
  const isoMatch = text.match(/\[(\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?)\]/i);
  if (isoMatch?.[1]) {
    const ts = Date.parse(isoMatch[1]);
    if (Number.isFinite(ts)) return ts;
  }
  const plainIsoMatch = text.match(/(?:^|\s)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i);
  if (plainIsoMatch?.[1]) {
    const ts = Date.parse(plainIsoMatch[1]);
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function formatLogTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return 'Unknown time';
  return formatDateTimeInLogTimezone(ts);
}

function normalizeInlineIsoTimestamp(line) {
  const text = String(line || '');
  if (!text) return '';
  return text.replace(
    /(^|\s)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))(?=\s|$)/,
    (m, lead, iso) => {
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts)) return m;
      return `${lead}[${formatLogTime(ts)}]`;
    }
  );
}

function dedupeRepeatedSourceTag(line) {
  let text = String(line || '');
  if (!text) return '';
  text = text.replace(/^\[([a-z0-9-]+)\]\s+\[\1\]\s+/i, '[$1] ');
  text = text.replace(/^\[([a-z0-9-]+)\]\s+(\[[^\]]+\]\s+)\[\1\]\s+/i, '[$1] $2');
  return text;
}

function logLineDedupeSignature(line) {
  const raw = String(line || '').trim();
  if (!raw) return '';
  let body = raw.replace(/^\[[^\]]+\]\s+/, '').replace(/^\[[^\]]+\]\s+/, '').trim();
  body = body.replace(/^\[install\]\s+/i, '').trim();
  if (/^npm warn deprecated /i.test(body)) return `npm-warn:${body.toLowerCase()}`;
  if (/^\[openclaw\]\[progress\]/i.test(body)) return `progress:${body}`;
  if (/^\[state\]\s+operation=.*status=running/i.test(body)) return `state-running:${body}`;
  return '';
}

function dedupeNearbyLogLines(lines, maxGapMs = 12000) {
  const out = [];
  const seen = new Map();
  for (const item of (Array.isArray(lines) ? lines : [])) {
    const line = String(item || '').trim();
    if (!line) continue;
    const signature = logLineDedupeSignature(line);
    if (!signature) {
      out.push(line);
      continue;
    }
    const ts = extractLogTimestampMs(line);
    const prev = seen.get(signature);
    if (prev) {
      if (prev.ts > 0 && ts > 0 && Math.abs(ts - prev.ts) <= maxGapMs) {
        continue;
      }
      if (prev.ts <= 0 && ts <= 0 && prev.line === line) {
        continue;
      }
    }
    seen.set(signature, { ts, line });
    out.push(line);
  }
  return out;
}

function watchdogFoldSignature(line) {
  const text = String(line || '').trim();
  if (!/^\[watchdog\]\s+/i.test(text)) return '';
  const body = text
    .replace(/^\[watchdog\]\s+/i, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .trim();
  if (!body) return '';
  if (/OpenClaw (?:install\/update|operation) in progress, watchdog standby/i.test(body)) return 'standby';
  if (/OpenClaw source entry missing .*watchdog idle/i.test(body)) return `idle:${body}`;
  return '';
}

function collapseWatchdogLogLines(lines) {
  const source = Array.isArray(lines) ? lines : [];
  const out = [];
  for (let i = 0; i < source.length; i += 1) {
    const line = String(source[i] || '').trim();
    if (!line) continue;
    /* suppress heartbeat lines – they are operational noise */
    if (/\[wd\]\[heartbeat\]/i.test(line)) continue;
    const signature = watchdogFoldSignature(line);
    if (!signature) {
      out.push(line);
      continue;
    }
    let j = i + 1;
    while (j < source.length && watchdogFoldSignature(source[j]) === signature) {
      j += 1;
    }
    const count = j - i;
    out.push(line);
    if (count > 1) {
      const lastTs = extractLogTimestampMs(source[j - 1]);
      const foldType = signature === 'standby' ? 'watchdog standby' : 'watchdog idle';
      out.push(`[watchdog] [${formatLogTime(lastTs)}] [fold] ${foldType} ${count} consecutive entries folded`);
    }
    i = j - 1;
  }
  return out;
}

function collapseWatchdogLogText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const prefixed = lines.map((line) => (/^\[watchdog\]\s+/i.test(line) ? line : `[watchdog] ${line}`));
  return collapseWatchdogLogLines(prefixed)
    .map((line) => line.replace(/^\[watchdog\]\s+/i, ''))
    .join('\n');
}

function mergeLogBlocksByTimeline(blocksText, { foldWatchdog = true, maxLines = 200 } = {}) {
  const text = String(blocksText || '');
  if (!text.trim()) return '';
  const entries = [];
  const knownSourcePattern = /^(watchdog|web-panel|gateway|gateway-runtime|gateway-legacy|openclaw-install|openclaw-repair|install|logs)$/i;
  const taskStartTs = new Map();
  const sourceStartTs = new Map();
  const lastTsBySource = new Map();
  let source = 'logs';
  let seq = 0;
  for (const rawLine of text.split('\n')) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    const labelMatch = line.match(/^\[([a-z0-9-]+)\]$/i);
    if (labelMatch?.[1]) {
      source = labelMatch[1].toLowerCase();
      continue;
    }
    const prefixedSource = line.match(/^\[([a-z0-9-]+)\]\s+/i)?.[1] || '';
    if (prefixedSource && knownSourcePattern.test(prefixedSource)) {
      source = prefixedSource.toLowerCase();
    }
    let normalized = /^\[(?:watchdog|web-panel|gateway|gateway-runtime|gateway-legacy|openclaw-install|openclaw-repair|install|logs)\]\s+/i.test(line)
      ? line
      : `[${source}] ${line}`;
    normalized = dedupeRepeatedSourceTag(normalizeInlineIsoTimestamp(normalized));
    const markerMatch = normalized.match(/=====\s*\[([^\]]+)\]\s*task\s+([^\s]+)\s*\([^\)]*\)\s*begin\s*=====/i);
    if (markerMatch?.[1] && markerMatch?.[2]) {
      const ts = extractLogTimestampMs(`[${markerMatch[1]}]`);
      if (Number.isFinite(ts)) taskStartTs.set(markerMatch[2], ts);
    }
    let inferredTs = extractLogTimestampMs(normalized);
    if (inferredTs > 0 && /\bstartedAt=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/i.test(normalized) && source) {
      sourceStartTs.set(source, inferredTs);
    }
    // C10: extract task= and elapsed= independently (they may appear in either order)
    if (!inferredTs) {
      const taskIdMatch = normalized.match(/\btask=([^\s]+)/i);
      const elapsedMatch = normalized.match(/\belapsed=(\d+)s/i)
        || normalized.match(/Installation in progress[.…]*\s*(\d+)s/);
      if (elapsedMatch?.[1]) {
        const taskBaseTs = taskIdMatch?.[1] ? taskStartTs.get(taskIdMatch[1]) : 0;
        const sourceBaseTs = source ? sourceStartTs.get(source) : 0;
        const baseTs = taskBaseTs || sourceBaseTs;
        if (Number.isFinite(baseTs)) {
          inferredTs = baseTs + (Number(elapsedMatch[1]) * 1000);
        }
      }
    }
    if (!inferredTs && source && lastTsBySource.has(source)) {
      inferredTs = Number(lastTsBySource.get(source) || 0);
    }
    if (inferredTs > 0) lastTsBySource.set(source, inferredTs);
    const withTimestamp = inferredTs > 0 && !/\[\d{4}-\d{2}-\d{2}(?: |T)\d{2}:\d{2}:\d{2}/.test(normalized)
      ? normalized.replace(/^\[([^\]]+)\]\s+/, (_m, src) => `[${src}] [${formatLogTime(inferredTs)}] `)
      : normalized;
    entries.push({
      seq: seq += 1,
      ts: inferredTs,
      line: withTimestamp
    });
  }
  entries.sort((a, b) => {
    if (a.ts && b.ts) return a.ts - b.ts || a.seq - b.seq;
    if (a.ts && !b.ts) return -1;
    if (!a.ts && b.ts) return 1;
    return a.seq - b.seq;
  });
  const sortedLines = entries.map((entry) => entry.line);
  const foldedLines = foldWatchdog ? collapseWatchdogLogLines(sortedLines) : sortedLines;
  const dedupedLines = dedupeNearbyLogLines(foldedLines);
  return keepLastLines(dedupedLines.join('\n'), maxLines);
}

function readLatestInstallTaskLogSection(lines = 200) {
  const raw = tailFile(OPENCLAW_INSTALL_LOG_FILE, Math.max(400, Number(lines || 200) * 5), 5000);
  if (!raw.trim()) return '';
  const marker = /===== \[[^\]]+\] task [^\s]+ \([^\)]*\) begin =====/g;
  let match;
  let lastIndex = -1;
  while ((match = marker.exec(raw)) !== null) {
    lastIndex = match.index;
  }
  const section = lastIndex >= 0 ? raw.slice(lastIndex) : raw;
  const cleaned = section
    .split('\n')
    .filter((line) => {
      const s = String(line || '');
      const t = s.trim();
      if (!t) return false;
      if (/^=====\s*\[[^\]]+\]\s*task\s+/i.test(t)) return true;
      if (/^\[openclaw\]|^\[gateway\]|^\[progress\]|^\[watchdog\]/i.test(t)) return true;
      if (/^(npm ERR!|pnpm |curl:|tar:|unzip:|node:|Error:|fatal:)/i.test(t)) return true;
      if (/\b(exit=\d+|signal=|timeout|timeout|failed|failed|not found|EADDRINUSE|ECONN|ETIMEDOUT|EAI_AGAIN)\b/i.test(t)) return true;
      if (/^echo\s+"\[openclaw\]/.test(t)) return false;
      if (/^(set\s+-e|[A-Z_][A-Z0-9_]*=|if\s|elif\s|else$|fi$|then$|do$|done$|while\s|for\s|case\s|esac$|\{\s*$|\}\s*$|local\s|return\s+\d+)/.test(t)) return false;
      if (/^(mkdir|rm|cp|ln|cd|export|sleep|mv|cat|awk|sed|grep)\b/.test(t)) return false;
      return true;
    })
    .join('\n');
  /* ---- simplify install/update logs (like gateway restart logs) ---- */
  const simplified = collapseInstallLogLines(cleaned || section);
  return keepLastLines(simplified, lines);
}

/**
 * Simplify install/update log output for the web panel:
 * - Collapse consecutive [state] progress lines (keep first+last, summarise)
 * - Remove verbose internal lines (command prepared, log file, preflight, npm warn deprecated)
 * - Keep errors, key milestones and task begin/end markers
 */
function collapseInstallLogLines(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  const verbosePatterns = [
    /^\[openclaw\]\s+command prepared\b/i,
    /^\[openclaw\]\s+log file:/i,
    /^\[openclaw\]\s+preflight:/i,
    /^\[openclaw\]\s+Install script starting/i,
    /^npm warn deprecated/i,
    /^npm WARN deprecated/i,
    /^\[state\]\s+operation=\S+\s+status=begin\b/i,
  ];
  const progressPattern = /^\[state\]\s+operation=\S+\s+status=running\s+elapsed=(\d+)s/i;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = String(line || '').trim();
    if (!t) continue;
    /* skip verbose noise */
    if (verbosePatterns.some((p) => p.test(t))) continue;
    /* collapse consecutive progress lines */
    const pm = t.match(progressPattern);
    if (pm) {
      let j = i + 1;
      while (j < lines.length && progressPattern.test(String(lines[j] || '').trim())) {
        j += 1;
      }
      const count = j - i;
      const lastLine = String(lines[j - 1] || '').trim();
      const lastMatch = lastLine.match(progressPattern);
      const elapsed = lastMatch ? lastMatch[1] : pm[1];
      if (count <= 2) {
        out.push(line);
        if (count === 2) out.push(lines[j - 1]);
      } else {
        // C10: preserve task= so mergeLogBlocksByTimeline can infer correct timestamp
        const taskIdFromLine = String(lines[i] || '').match(/\btask=([^\s]+)/i);
        const taskSuffix = taskIdFromLine?.[1] ? ` task=${taskIdFromLine[1]}` : '';
        out.push(`[state] Installation in progress... ${elapsed}s${taskSuffix} (${count} progress entries folded)`);
      }
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
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

function readOpenClawGatewayLogs(lines = 200, { includeWatchdog = false, includeInstall = false } = {}) {
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
  const runtimeLog = tailFile(GATEWAY_RUNTIME_LOG_FILE, Math.min(lines, GATEWAY_LOG_RUNTIME_MAX_LINES), 2500);
  if (runtimeLog.trim()) {
    pushLabeledChunk('gateway-runtime', runtimeLog);
  } else {
    const legacyLog = tailFile(GATEWAY_LEGACY_LOG_FILE, Math.min(lines, GATEWAY_LOG_RUNTIME_MAX_LINES), 2500);
    if (legacyLog.trim()) pushLabeledChunk('gateway-legacy', legacyLog);
  }

  if (includeInstall) {
    const installTail = readLatestInstallTaskLogSection(Math.min(Math.max(lines, 160), GATEWAY_LOG_INSTALL_MAX_LINES));
    if (installTail.trim()) pushLabeledChunk('install', installTail);
  }

  if (includeWatchdog) {
    const watchdogLog = tailFile(GATEWAY_WATCHDOG_LOG, Math.min(lines, GATEWAY_LOG_WATCHDOG_MAX_LINES), 2500);
    const reducedWatchdog = String(watchdogLog || '')
      .split('\n')
      .filter((line) => {
        const t = String(line || '').trim();
        if (!t) return false;
        if (/\[install\]\s+\[openclaw\]\[progress\]/i.test(t)) return false;
        return true;
      })
      .join('\n');
    const foldedWatchdog = collapseWatchdogLogText(reducedWatchdog);
    if (foldedWatchdog.trim()) pushLabeledChunk('watchdog', foldedWatchdog);
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
  const ts = extractLogTimestampMs(line);
  return Number.isFinite(ts) ? ts : 0;
}

function detectDiscordConnectError(logText) {
  const lines = String(logText || '').split('\n');
  // Scan backwards from latest to find most recent Discord connection error
  let lastDiscordError = '';
  let lastDiscordErrorTs = 0;
  let lastDiscordOk = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || '');
    if (!line) continue;
    // Discord successful connection flag
    if (/\[discord\]\s+(connected|ready|logged in|Logged in as)/i.test(line)) {
      lastDiscordOk = parseBracketTimestamp(line) || Date.now();
      break;
    }
    // Discord TLS / fetch errors
    if (!lastDiscordError && /\[discord\]\s+(gateway\s+error|final reply failed|fetch failed)/i.test(line)) {
      lastDiscordErrorTs = parseBracketTimestamp(line) || 0;
      if (/Client network socket disconnected.*TLS/i.test(line) || /fetch failed/i.test(line)) {
        lastDiscordError = 'TLS connection failed (network blocked, configure HTTPS_PROXY recommended)';
      } else {
        lastDiscordError = 'Discord gateway connection failed';
      }
    }
  }
  if (!lastDiscordError) return '';
  // If last successful connection is newer than error, ignore
  if (lastDiscordOk > lastDiscordErrorTs) return '';
  // Errors older than 10 minutes are no longer shown
  if (lastDiscordErrorTs && (Date.now() - lastDiscordErrorTs) > 600000) return '';
  return lastDiscordError;
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
    writeOpenClawConfig(cfg);
  }

  return result;
}

/**
 * Sanitize openclaw.json config object in-place before writing.
 * Uses a blacklist approach: removes known-invalid keys that cause gateway startup failures.
 * Conservative to avoid breaking legitimate config keys added by OpenClaw updates.
 * Returns object with { changed, removed } for logging.
 */
function sanitizeOpenClawConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { changed: false, removed: [] };
  const removed = [];

  // Top-level: remove known-bad keys
  const BLACKLISTED_TOP_KEYS = ['providers']; // legacy / misplaced
  for (const k of BLACKLISTED_TOP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(cfg, k)) {
      delete cfg[k];
      removed.push(k);
    }
  }

  // agents.defaults: remove known-bad keys that break .strict() validation
  const BLACKLISTED_DEFAULTS_KEYS = [
    'subModel', 'subModelFallbacks', 'fallbacks'
  ];
  const defaults = cfg?.agents?.defaults;
  if (defaults && typeof defaults === 'object') {
    for (const k of BLACKLISTED_DEFAULTS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(defaults, k)) {
        delete defaults[k];
        removed.push(`agents.defaults.${k}`);
      }
    }
  }

  // models: remove known-bad keys
  const BLACKLISTED_MODELS_KEYS = ['aliases'];
  const models = cfg?.models;
  if (models && typeof models === 'object') {
    for (const k of BLACKLISTED_MODELS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(models, k)) {
        delete models[k];
        removed.push(`models.${k}`);
      }
    }
  }

  // gateway.auth.token: normalize format to avoid hidden-char mismatch during node pairing auth.
  if (cfg?.gateway?.auth && typeof cfg.gateway.auth === 'object' && Object.prototype.hasOwnProperty.call(cfg.gateway.auth, 'token')) {
    const rawToken = cfg.gateway.auth.token;
    const normalizedToken = normalizeGatewayAuthToken(rawToken);
    if (String(rawToken || '') !== normalizedToken) {
      cfg.gateway.auth.token = normalizedToken;
      removed.push('gateway.auth.token(normalized)');
    }
  }

  return { changed: removed.length > 0, removed };
}

/**
 * Write openclaw.json with pre-save sanitization.
 * Strips unrecognized keys to prevent gateway startup failures.
 */
function writeOpenClawConfig(cfg) {
  const result = sanitizeOpenClawConfig(cfg);
  if (result.changed) {
    console.log(`[config] sanitize: removed ${result.removed.length} invalid key(s): ${result.removed.join(', ')}`);
  }
  const nextContent = JSON.stringify(cfg, null, 2);
  let currentContent = '';
  try {
    currentContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {}
  if (currentContent === nextContent) {
    return { ...result, written: false };
  }
  fs.writeFileSync(CONFIG_PATH, nextContent, { encoding: 'utf8', mode: 0o600 });
  return { ...result, written: true };
}

function buildNormalizedPairedScopes(role, scopes = []) {
  const mergedScopes = Array.from(new Set((Array.isArray(scopes) ? scopes : []).filter(Boolean)));
  if (role === 'operator' || role === 'admin') {
    return Array.from(new Set([
      ...mergedScopes,
      'operator.admin',
      'operator.read',
      'operator.write',
      'operator.approvals',
      'operator.pairing'
    ]));
  }
  return mergedScopes.length > 0 ? mergedScopes : ['operator.admin'];
}

function normalizePairedDevicesScopes() {
  const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
  if (!paired || typeof paired !== 'object' || Array.isArray(paired)) {
    return { changed: false, count: 0 };
  }

  let anyChanged = false;
  let changedCount = 0;
  for (const [deviceId, rawEntry] of Object.entries(paired)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;

    const entry = rawEntry;
    const primaryRole = String(
      entry.role
      || (Array.isArray(entry.roles) ? entry.roles[0] : '')
      || (entry.clientMode === 'node' ? 'node' : 'operator')
    ).trim() || 'operator';

    const tokenScopes = Object.values(entry.tokens || {}).flatMap((tokenEntry) => (
      Array.isArray(tokenEntry?.scopes) ? tokenEntry.scopes : []
    ));

    const normalizedScopes = buildNormalizedPairedScopes(primaryRole, [
      ...(Array.isArray(entry.scopes) ? entry.scopes : []),
      ...(Array.isArray(entry.approvedScopes) ? entry.approvedScopes : []),
      ...tokenScopes
    ]);

    let entryChanged = false;
    const currentScopes = Array.isArray(entry.scopes) ? entry.scopes : [];
    const currentApprovedScopes = Array.isArray(entry.approvedScopes) ? entry.approvedScopes : [];
    if (JSON.stringify(currentScopes) !== JSON.stringify(normalizedScopes)) {
      entry.scopes = normalizedScopes;
      entryChanged = true;
    }
    if (JSON.stringify(currentApprovedScopes) !== JSON.stringify(normalizedScopes)) {
      entry.approvedScopes = normalizedScopes;
      entryChanged = true;
    }

    if (entry.tokens && typeof entry.tokens === 'object') {
      for (const tokenEntry of Object.values(entry.tokens)) {
        if (!tokenEntry || typeof tokenEntry !== 'object') continue;
        const currentTokenScopes = Array.isArray(tokenEntry.scopes) ? tokenEntry.scopes : [];
        if (JSON.stringify(currentTokenScopes) !== JSON.stringify(normalizedScopes)) {
          tokenEntry.scopes = normalizedScopes;
          entryChanged = true;
        }
      }
    }

    if (entryChanged) {
      paired[deviceId] = entry;
      anyChanged = true;
      changedCount += 1;
    }
  }

  if (!anyChanged) {
    return { changed: false, count: 0 };
  }

  fs.writeFileSync(DEVICE_PAIRING_PAIRED_PATH, JSON.stringify(paired, null, 2));
  console.log(`[pairing] Normalized scopes for ${changedCount} paired device(s)`);
  return { changed: true, count: changedCount };
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

function normalizeGatewayAuthToken(raw) {
  let token = String(raw || '');
  token = token.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!token) return '';
  token = token.replace(/^Bearer\s+/i, '').trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  return token;
}

function shellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
}

function getNodeGatewayInstanceKey(host, port) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  const normalizedPort = Number(port || 0) || 0;
  const hostSlug = normalizedHost
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'gateway';
  const hash = crypto.createHash('sha256').update(`${normalizedHost}:${normalizedPort}`).digest('hex').slice(0, 10);
  return `${hostSlug}-${normalizedPort || 'default'}-${hash}`;
}

// ============================================================
// Docker config
// ============================================================
function readDockerConfig() {
  const cfg = readJson(DOCKER_CONFIG_PATH, {});
  if (typeof cfg.browserEnabled !== 'boolean') cfg.browserEnabled = false;
  return cfg;
}

function getNodeTlsCommandMode(dcfg) {
  const rawDomain = String(dcfg?.domain || '').trim();
  const certMode = String(dcfg?.cert_mode || '').trim().toLowerCase();
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(rawDomain);
  const isIpv6 = rawDomain.includes(':') && /^[0-9a-f:]+$/i.test(rawDomain);
  const isIpHost = isIpv4 || isIpv6;

  if (rawDomain && !isIpHost && certMode === 'letsencrypt') {
    return {
      disableVerify: false,
      note: 'Domain + trusted HTTPS detected. NODE_TLS_REJECT_UNAUTHORIZED=0 omitted.'
    };
  }

  if ((rawDomain && isIpHost) || certMode === 'internal') {
    return {
      disableVerify: true,
      note: 'IP/self-signed HTTPS, command retains NODE_TLS_REJECT_UNAUTHORIZED=0。'
    };
  }

  return {
    disableVerify: true,
    note: 'Cannot reliably determine if certificate is trusted，Command conservatively keeps NODE_TLS_REJECT_UNAUTHORIZED=0.'
  };
}

function getOpenClawInstallInstanceId() {
  try {
    if (fs.existsSync(OPENCLAW_INSTALL_INSTANCE_ID_PATH)) {
      const existing = String(fs.readFileSync(OPENCLAW_INSTALL_INSTANCE_ID_PATH, 'utf8') || '').trim();
      if (existing) return existing;
    }
  } catch {}

  try {
    fs.mkdirSync(path.dirname(OPENCLAW_INSTALL_INSTANCE_ID_PATH), { recursive: true });
    const nextId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(OPENCLAW_INSTALL_INSTANCE_ID_PATH, `${nextId}\n`, { mode: 0o600 });
    return nextId;
  } catch {
    return '';
  }
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
  // Clear stale version env vars from container build，Let watchdog re-detect from package.json
  const cleanEnv = { ...process.env, TERM: 'dumb' };
  delete cleanEnv.OPENCLAW_VERSION;
  delete cleanEnv.OPENCLAW_SERVICE_VERSION;
  exec(`bash --noprofile --norc -lc '${cmd}'`, { env: cleanEnv }, (err, stdout, stderr) => {
    if (err) {
      return callback(err, stdout, stderr);
    }
    console.log('[watchdog] Watchdog started or already running');
    callback(null, 'watchdog started', '');
  });
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

function runCommandTextAsync(cmd, timeoutMs = 2500) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8', timeout: timeoutMs }, (_err, stdout) => {
      resolve((_err ? '' : (stdout || '')).trim());
    });
  });
}

function runCommandOkAsync(cmd, timeoutMs = 1500) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err) => { resolve(!err); });
  });
}

function getGatewayRuntimePid() {
  const cmd = [
    'pid="$(pgrep -x openclaw-gateway 2>/dev/null | head -1 || true)"',
    'if [ -z "$pid" ]; then pid="$(pgrep -x openclaw-gatewa 2>/dev/null | head -1 || true)"; fi',
    'if [ -z "$pid" ]; then pid="$(pgrep -f "[o]penclaw\\.mjs gateway" 2>/dev/null | head -1 || true)"; fi',
    'if [ -z "$pid" ]; then pid="$(pgrep -f "[o]penclaw[^\\n]*gateway run" 2>/dev/null | head -1 || true)"; fi',
    'if [ -z "$pid" ]; then',
    '  for candidate in $(pgrep -x openclaw 2>/dev/null || true); do',
    '    cmdline="$(cat /proc/$candidate/cmdline 2>/dev/null | tr "\\000" " ")"',
    '    comm="$(cat /proc/$candidate/comm 2>/dev/null || true)"',
    '    if [ "$comm" = "bash" ] || [ "$comm" = "sh" ] || [ "$comm" = "timeout" ]; then continue; fi',
    '    case "$cmdline" in',
    '      *"gateway run"*|*" openclaw gateway"*) pid="$candidate"; break ;;',
    '    esac',
    '  done',
    'fi',
    'printf "%s" "$pid"'
  ].join('\n');
  return String(runCommandText(cmd, 1200) || '').trim();
}

function isGatewayRuntimeProcessRunning() {
  return !!getGatewayRuntimePid();
}

async function getGatewayRuntimeProcessInfo() {
  const pid = Number.parseInt(String(getGatewayRuntimePid() || '').trim(), 10) || 0;
  if (pid <= 0) {
    return { pid: 0, uptimeSec: 0, startedAtMs: 0 };
  }

  const uptimeText = await runCommandTextAsync(`ps -o etimes= -p ${pid} 2>/dev/null || true`, 1200);
  const uptimeSec = Number.parseInt(String(uptimeText || '').trim(), 10) || 0;
  const startedAtMs = uptimeSec > 0 ? Math.max(0, Date.now() - (uptimeSec * 1000)) : 0;
  return { pid, uptimeSec, startedAtMs };
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
      resolve({ ok: false, code: 1, output: 'script command unavailable, cannot run TTY-required login/token flow' });
      return;
    }

    const defaultPath = '/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin';
    const mergedPath = process.env.PATH ? `${process.env.PATH}:${defaultPath}` : defaultPath;
    const child = spawn('script', ['-qf', '-c', command, '/dev/null'], {
      env: { ...process.env, TERM: 'xterm-256color', PATH: mergedPath },
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

const OPENCLAW_INSTALL_MODES = new Set(['auto', 'npm']);

function normalizeOpenClawInstallMode(input) {
  const mode = String(input || '').trim().toLowerCase();
  if (OPENCLAW_INSTALL_MODES.has(mode)) return mode;
  return 'auto';
}

function resolveOpenClawInstallMode(req) {
  const bodyMode = normalizeOpenClawInstallMode(req?.body?.mode || '');
  if (bodyMode !== 'auto' || String(req?.body?.mode || '').trim()) return bodyMode;
  const queryMode = normalizeOpenClawInstallMode(req?.query?.mode || '');
  if (queryMode !== 'auto' || String(req?.query?.mode || '').trim()) return queryMode;
  return normalizeOpenClawInstallMode(process.env.OPENCLAW_INSTALL_MODE || 'auto');
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
  try {
    const resp = await fetchWithFallback(apiUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'clawnook' },
      timeout: 12000
    });
    if (!resp || !resp.ok) {
      throw new Error(`Failed to fetch ${safeRepo} release info`);
    }
    const release = await resp.json();
    const tag = String(release?.tag_name || '').trim();
    if (!tag) throw new Error(`Release tag is empty (${safeRepo})`);
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
    let binaryAsset = pickOpenClawReleaseBinaryAsset(assets);
    if (!binaryAsset) {
      const npmDistAsset = resolveOpenClawNpmDistTarballAsset(tag);
      if (npmDistAsset) binaryAsset = npmDistAsset;
    }
    return {
      repo: safeRepo,
      tag,
      tarballUrl,
      assets,
      binaryAsset,
      publishedAt: release?.published_at || '',
      name: release?.name || tag
    };
  } catch (err) {
    const npmLatestNpmjs = parseOpenClawVersion(runCommandText('npm view openclaw version --registry=https://registry.npmjs.org 2>/dev/null || true', 5000));
    const npmLatestMirror = parseOpenClawVersion(runCommandText('npm view openclaw version --registry=https://registry.npmmirror.com 2>/dev/null || true', 4000));
    const cachedLatest = parseOpenClawVersion(latestOpenClawVersionCache.version || '');
    const fallbackVersion = npmLatestNpmjs || npmLatestMirror || cachedLatest;
    if (!fallbackVersion) {
      throw err;
    }
    const normalizedFallbackVersion = String(fallbackVersion || '').replace(/^v/i, '');
    const tag = `v${normalizedFallbackVersion}`;
    const encodedTag = encodeURIComponent(tag);
    const tarballUrl = `https://codeload.github.com/${safeRepo}/tar.gz/refs/tags/${encodedTag}`;
    const binaryAsset = resolveOpenClawNpmDistTarballAsset(tag);
    console.warn(`[openclaw][release] GitHub release query failed, falling back to npm metadataGenerating release: ${safeRepo}@${tag} (${err?.message || 'unknown'})`);
    return {
      repo: safeRepo,
      tag,
      tarballUrl,
      assets: [],
      binaryAsset,
      publishedAt: '',
      name: tag
    };
  }
}

function getLatestPublishedOpenClawVersion() {
  const npmLatestNpmjs = parseOpenClawVersion(runCommandText('npm view openclaw version --registry=https://registry.npmjs.org 2>/dev/null || true', 5000));
  const npmLatestMirror = parseOpenClawVersion(runCommandText('npm view openclaw version --registry=https://registry.npmmirror.com 2>/dev/null || true', 4000));
  const cachedLatest = parseOpenClawVersion(latestOpenClawVersionCache.version || '');
  return npmLatestNpmjs || npmLatestMirror || cachedLatest || '';
}

async function resolveLatestOpenClawInstallRelease(repo) {
  const safeRepo = parseGitHubRepo(repo) || OPENCLAW_SOURCE_REPO_DEFAULT;
  const publishedVersion = getLatestPublishedOpenClawVersion();
  if (!publishedVersion) {
    throw new Error('Cannot fetch published OpenClaw versions from npm');
  }
  const tag = `v${publishedVersion}`;
  return {
    repo: safeRepo,
    tag,
    tarballUrl: `https://codeload.github.com/${safeRepo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`,
    name: tag,
    binaryAsset: null,
    assets: [],
    installVersion: publishedVersion,
    installSource: 'npm'
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
        source: 'github-release',
        score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function resolveOpenClawNpmDistTarballAsset(tag) {
  const parsed = parseOpenClawVersion(tag || '');
  const version = parsed ? String(parsed).replace(/^v/i, '') : '';
  if (!version) return null;
  const metadataTimeoutMs = 12000;
  const registries = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];
  const readNpmViewWithRetry = (field) => {
    for (const registry of registries) {
      for (let i = 0; i < 3; i += 1) {
        const text = runCommandText(`npm view "openclaw@${version}" ${field} --registry=${registry} 2>/dev/null || true`, metadataTimeoutMs);
        const value = String(text || '').trim();
        if (value) return value;
      }
    }
    return '';
  };
  const tarball = readNpmViewWithRetry('dist.tarball');
  if (!/^https?:\/\//i.test(String(tarball || '').trim())) return null;
  const unpackedSizeText = readNpmViewWithRetry('dist.unpackedSize');
  const unpackedSize = Number.parseInt(String(unpackedSizeText || '').trim(), 10) || 0;
  return {
    name: `openclaw-${version}.tgz`,
    url: String(tarball || '').trim(),
    size: unpackedSize,
    contentType: 'application/gzip',
    source: 'npm-dist-tarball'
  };
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

  // Fast path: if any package.json provided a version, skip slow execSync probes
  if (versions.length > 0) {
    let newest = versions[0];
    for (const version of versions.slice(1)) {
      if (compareSemver(version, newest) > 0) newest = version;
    }
    return newest;
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

function inspectOpenClawRuntimeArtifacts() {
  const sourceEntry = '/root/.openclaw/openclaw-source/openclaw.mjs';
  const distEntryJs = '/root/.openclaw/openclaw-source/dist/entry.js';
  const distEntryMjs = '/root/.openclaw/openclaw-source/dist/entry.mjs';
  const distIndexJs = '/root/.openclaw/openclaw-source/dist/index.js';
  const distIndexMjs = '/root/.openclaw/openclaw-source/dist/index.mjs';
  const npmBinaryPaths = [
    '/root/.npm-global/bin/openclaw',
    '/usr/local/bin/openclaw',
    '/usr/bin/openclaw',
    '/opt/homebrew/bin/openclaw'
  ];

  // Use fs.existsSync instead of execSync('test -f ...') for instant file checks
  const sourceEntryOk = fs.existsSync(sourceEntry);
  const runtimeEntryOk = fs.existsSync(distEntryJs) || fs.existsSync(distEntryMjs) || fs.existsSync(distIndexJs) || fs.existsSync(distIndexMjs);
  let npmBinaryOk = npmBinaryPaths.some(p => fs.existsSync(p));
  if (!npmBinaryOk) {
    // Fallback: check PATH-based resolution (only if no known binary path found)
    npmBinaryOk = runCommandOk('command -v openclaw >/dev/null 2>&1', 1200);
  }

  const ok = npmBinaryOk || (sourceEntryOk && runtimeEntryOk);
  let issue = '';
  if (!ok) {
    if (!sourceEntryOk && !npmBinaryOk && !runtimeEntryOk) issue = 'missing-source-binary-and-runtime-entry';
    else if (!sourceEntryOk && !npmBinaryOk) issue = 'missing-source-and-binary-entry';
    else if (!runtimeEntryOk) issue = 'missing-runtime-entry';
  }
  let runtimeEntry = '';
  if (fs.existsSync(distEntryJs)) runtimeEntry = distEntryJs;
  else if (fs.existsSync(distEntryMjs)) runtimeEntry = distEntryMjs;
  else if (fs.existsSync(distIndexJs)) runtimeEntry = distIndexJs;
  else if (fs.existsSync(distIndexMjs)) runtimeEntry = distIndexMjs;

  let npmBinaryPath = '';
  for (const p of npmBinaryPaths) {
    if (fs.existsSync(p)) { npmBinaryPath = p; break; }
  }
  if (!npmBinaryPath && npmBinaryOk) {
    npmBinaryPath = runCommandText('command -v openclaw 2>/dev/null || true', 1000) || '/root/.npm-global/bin/openclaw';
  }

  return {
    ok,
    issue,
    sourceEntry,
    distEntry: runtimeEntry,
    npmBinary: npmBinaryPath
  };
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
  const runtime = inspectOpenClawRuntimeArtifacts();
  const version = getInstalledOpenClawVersion();
  if (version) {
    if (runtime.ok) return { installed: true, version, source: 'version', runtimeReady: true, runtimeIssue: '' };
    return { installed: false, version, source: 'incomplete', runtimeReady: false, runtimeIssue: runtime.issue || 'runtime-artifacts-missing' };
  }

  const sourceMeta = getOpenClawSourceInstallMeta();
  if (sourceMeta) {
    if (runtime.ok) return { installed: true, version: sourceMeta.version || '', source: 'source', runtimeReady: true, runtimeIssue: '' };
    return { installed: false, version: sourceMeta.version || '', source: 'incomplete', runtimeReady: false, runtimeIssue: runtime.issue || 'runtime-artifacts-missing' };
  }

  if (isOpenClawInstalledByPath()) {
    if (runtime.ok) return { installed: true, version: '', source: 'binary', runtimeReady: true, runtimeIssue: '' };
    return { installed: false, version: '', source: 'incomplete', runtimeReady: false, runtimeIssue: runtime.issue || 'runtime-artifacts-missing' };
  }

  if (isOpenClawInstalledByNpmPackage()) {
    if (runtime.ok) return { installed: true, version: '', source: 'npm', runtimeReady: true, runtimeIssue: '' };
    return { installed: false, version: '', source: 'incomplete', runtimeReady: false, runtimeIssue: runtime.issue || 'runtime-artifacts-missing' };
  }

  return { installed: false, version: '', source: 'none', runtimeReady: false, runtimeIssue: runtime.issue || '' };
}
const openClawRuntimeRecoveryState = {
  lastAttemptAt: 0,
  lastIssue: '',
  lastTaskId: '',
  suppressUntil: 0,
  suppressReason: ''
};
const OPENCLAW_RUNTIME_RECOVERY_GAP_MS = 3 * 60 * 1000;
const OPENCLAW_RUNTIME_RECOVERY_SUPPRESS_AFTER_UNINSTALL_MS = 5 * 60 * 1000;

async function maybeTriggerOpenClawRuntimeRecovery(issue = '') {
  const now = Date.now();
  if (openClawRuntimeRecoveryState.suppressUntil && now < openClawRuntimeRecoveryState.suppressUntil) {
    return { triggered: false, reason: openClawRuntimeRecoveryState.suppressReason || 'suppressed', taskId: '' };
  }
  if (openClawRuntimeRecoveryState.lastAttemptAt && (now - openClawRuntimeRecoveryState.lastAttemptAt) < OPENCLAW_RUNTIME_RECOVERY_GAP_MS) {
    return { triggered: false, reason: 'cooldown', taskId: '' };
  }
  openClawRuntimeRecoveryState.lastAttemptAt = now;
  openClawRuntimeRecoveryState.lastIssue = String(issue || 'runtime-artifacts-missing');
  try {
    const repo = resolveOpenClawSourceRepo(true);
    const release = await resolveLatestOpenClawInstallRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release);
    const taskId = runOpenClawTask(
      command,
      `Entry point missing(${openClawRuntimeRecoveryState.lastIssue})，auto npm install recovery（${release.tag})`,
      'installing',
      { release }
    );
    if (!taskId) return { triggered: false, reason: 'busy', taskId: '' };
    openClawRuntimeRecoveryState.lastTaskId = taskId;
    return { triggered: true, reason: 'started', taskId };
  } catch (e) {
    return { triggered: false, reason: e?.message || 'recovery-failed', taskId: '' };
  }
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

function writeJsonFileAtomic(filePath, data, mode = 0o600) {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  fs.renameSync(tmpPath, filePath);
  try { fs.chmodSync(filePath, mode); } catch {}
}

function syncOpenClawPostInstallMetadata({ operationType = 'installing', release = null } = {}) {
  const touchedAt = new Date().toISOString();
  const snapshot = getOpenClawInstallationSnapshot(true);
  const sourceMeta = getOpenClawSourceInstallMeta();
  const releaseTag = String(release?.tag || '').trim();
  const version = String(
    snapshot?.version
    || sourceMeta?.version
    || parseOpenClawVersion(releaseTag)
    || ''
  ).trim();
  const tag = String(sourceMeta?.tag || releaseTag || (version ? `v${version}` : '')).trim();

  const result = {
    version,
    tag,
    touchedAt,
    configChanged: false,
    updateCheckChanged: false
  };

  if (!version) {
    result.error = 'installed-version-unavailable';
    return result;
  }

  const cfg = readJson(CONFIG_PATH, null);
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    const nextCfg = { ...cfg, meta: { ...(cfg.meta || {}) } };
    const nextMeta = nextCfg.meta;
    let changed = false;

    if (String(nextMeta.lastTouchedVersion || '').trim() !== version) {
      nextMeta.lastTouchedVersion = version;
      changed = true;
    }
    if (String(nextMeta.lastTouchedAt || '').trim() !== touchedAt) {
      nextMeta.lastTouchedAt = touchedAt;
      changed = true;
    }

    if (changed) {
      writeOpenClawConfig(nextCfg);
      result.configChanged = true;
    }
  }

  const updateCheckPath = `${OPENCLAW_STATE_ROOT}/update-check.json`;
  const updateState = readJson(updateCheckPath, {});
  const lastNotifiedVersion = parseOpenClawVersion(updateState?.lastNotifiedVersion || updateState?.lastNotifiedTag || '');
  const shouldAdvanceNotification = !lastNotifiedVersion || compareSemver(version, lastNotifiedVersion) >= 0;
  const nextUpdateState = {
    ...(updateState && typeof updateState === 'object' && !Array.isArray(updateState) ? updateState : {}),
    lastCheckedAt: touchedAt
  };
  let updateChanged = String(updateState?.lastCheckedAt || '').trim() !== touchedAt;

  if (shouldAdvanceNotification) {
    if (String(nextUpdateState.lastNotifiedVersion || '').trim() !== version) {
      nextUpdateState.lastNotifiedVersion = version;
      updateChanged = true;
    }
    if (tag && String(nextUpdateState.lastNotifiedTag || '').trim() !== tag) {
      nextUpdateState.lastNotifiedTag = tag;
      updateChanged = true;
    }
  }

  if (updateChanged) {
    writeJsonFileAtomic(updateCheckPath, nextUpdateState);
    result.updateCheckChanged = true;
  }

  return result;
}

async function getLatestOpenClawVersion(timeoutMs = 2500) {
  const repo = resolveOpenClawSourceRepo();
  const rel = await resolveLatestOpenClawInstallRelease(repo);
  return parseOpenClawVersion(rel.tag || '');
}

const latestOpenClawVersionCache = {
  version: '',
  error: '',
  hasLinuxBinaryAsset: null,
  assetsSummary: '',
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
    const repo = resolveOpenClawSourceRepo();
    const rel = await resolveLatestOpenClawInstallRelease(repo);
    const version = parseOpenClawVersion(rel?.tag || '');
    latestOpenClawVersionCache.hasLinuxBinaryAsset = false;
    latestOpenClawVersionCache.assetsSummary = 'npm';
    if (version) {
      latestOpenClawVersionCache.version = version;
      latestOpenClawVersionCache.error = '';
      latestOpenClawVersionCache.updatedAt = Date.now();
    } else {
      latestOpenClawVersionCache.error = 'Cannot reach version source';
      if (!latestOpenClawVersionCache.updatedAt) latestOpenClawVersionCache.updatedAt = Date.now();
    }
  } catch (e) {
    latestOpenClawVersionCache.error = e?.message || String(e || 'Version check failed');
    latestOpenClawVersionCache.hasLinuxBinaryAsset = null;
    latestOpenClawVersionCache.assetsSummary = '';
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

  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const terminalRcPath = `/tmp/openclaw-terminal-${uid}.bashrc`;
  let rcReady = false;
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
    const tmpRcPath = `${terminalRcPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpRcPath, rcContent, { mode: 0o644 });
    fs.renameSync(tmpRcPath, terminalRcPath);
    try { fs.chmodSync(terminalRcPath, 0o644); } catch {}
    rcReady = true;
  } catch {}

  const homeDir = (process.env.HOME && fs.existsSync(process.env.HOME)) ? process.env.HOME : '/tmp';

  const shellEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLUMNS: '220',
    LINES: '60',
    SHELL: '/bin/bash',
    HOME: homeDir,
    BASH_ENV: '',
    ENV: ''
  };

  const startupCmd = rcReady
    ? `stty cols 220 rows 60 >/dev/null 2>&1 || true; exec bash --noprofile --rcfile ${JSON.stringify(terminalRcPath)} -i`
    : 'stty cols 220 rows 60 >/dev/null 2>&1 || true; exec bash --noprofile --norc -i';

  const useScriptPty = runCommandOk('command -v script >/dev/null 2>&1', 800);
  if (useScriptPty) {
    return {
      shell: spawn('script', ['-qf', '-c', startupCmd, '/dev/null'], {
        env: shellEnv,
        cwd: homeDir
      }),
      mode: 'pty',
      reason: rcReady ? '' : 'terminal rc unavailable; started without rcfile'
    };
  }

  return {
    shell: spawn('bash', ['--noprofile', '--norc', '-ic', startupCmd], {
      env: shellEnv,
      cwd: homeDir
    }),
    mode: 'fallback',
    reason: rcReady
      ? 'script not found; using bash fallback'
      : 'script not found and terminal rc unavailable; using bash fallback without rcfile'
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
  // Do not write default weak password: first access requires setting password
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

const statusLogState = {
  lastSnapshot: ''
};
const LOCAL_GATEWAY_HEALTH_CHECK_CMD = "curl --noproxy '*' -s -o /dev/null -w \"%{http_code}\" --connect-timeout 1 --max-time 2 http://127.0.0.1:18789/health 2>/dev/null || true";

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
  if (!sess) {
    // We don't log too much here to avoid spamming for public assets
    return false;
  }
  const user = dockerConfig.webAuth?.users?.[sess.u];
  if (!user) return false;
  return true;
}

function requireAuthApi(req, res, next) {
  if (req.path === '/login') return next();
  if (req.path === '/bootstrap/status') return next();
  if (req.path === '/bootstrap/setup') return next();
  // Allow hotpatch from localhost only (docker exec) — use socket address, not req.ip (trust proxy could spoof)
  if (req.path.startsWith('/update/hotpatch')) {
    const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  }
  // Allow app-center calls from localhost (proxied by Caddy/Gateway)
  if (req.path.startsWith('/app-center/')) {
    const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
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
    timeout: 30000
  }, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    if (responseHeaders.location) {
      responseHeaders.location = rewriteGatewayLocationHeader(responseHeaders.location, gatewayPort);
    }
    // Inject into HTML response __OPENCLAW_CONTROL_UI_BASE_PATH__, Ensure SPA WebSocket goes through /gateway-proxy proxy
    const ct = String(responseHeaders['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) {
      let body = Buffer.alloc(0);
      proxyRes.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
      proxyRes.on('end', () => {
        try {
          let html = body.toString('utf-8');
          const inject = '<script>window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = "/gateway-proxy";</script>';
          html = html.replace('<head>', '<head>' + inject);
          delete responseHeaders['content-length'];
          responseHeaders['content-length'] = Buffer.byteLength(html);
          res.writeHead(proxyRes.statusCode || 200, responseHeaders);
          res.end(html);
        } catch (e) {
          if (!res.headersSent) res.writeHead(proxyRes.statusCode || 200, responseHeaders);
          res.end(body);
        }
      });
    } else {
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error('gateway upstream timeout'));
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).send(`Gateway unavailable：${err.message}`);
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
// SSE-based terminal transport (fallback when WebSocket fails)
// ============================================================
let sseTerminalSession = null;

function ensureSseTerminalShell() {
  if (sseTerminalSession && sseTerminalSession.shell && !sseTerminalSession.shell.killed) {
    return sseTerminalSession;
  }
  closeActiveTerminalSession('sse-new-session');
  try {
    const res = createTerminalShell();
    if (!res.shell || !res.shell.stdin || !res.shell.stdout) {
      return null;
    }
    const outputListeners = new Set();
    const session = { shell: res.shell, mode: res.mode, outputListeners };

    res.shell.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const fn of outputListeners) {
        try { fn(text); } catch {}
      }
    });
    res.shell.stdout.on('error', () => {});
    if (res.mode !== 'pty' && res.shell.stderr) {
      res.shell.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        for (const fn of outputListeners) {
          try { fn(text); } catch {}
        }
      });
      res.shell.stderr.on('error', () => {});
    }
    res.shell.stdin.on('error', () => {});
    res.shell.on('close', (code) => {
      console.log(`[terminal-sse] shell closed code=${code ?? 0}`);
      for (const fn of outputListeners) {
        try { fn(`\n[terminal] shell exited (code=${code ?? 0})\n`); } catch {}
      }
      if (sseTerminalSession === session) sseTerminalSession = null;
    });
    res.shell.on('error', (err) => {
      console.warn(`[terminal-sse] shell error: ${err.message}`);
      for (const fn of outputListeners) {
        try { fn(`\n[terminal] shell error: ${err.message}\n`); } catch {}
      }
      if (sseTerminalSession === session) sseTerminalSession = null;
    });
    sseTerminalSession = session;
    setTerminalBackendState({ wsEnabled: true, ready: true, mode: res.mode, reason: 'sse-transport' });
    console.log(`[terminal-sse] session created mode=${res.mode}`);
    return session;
  } catch (err) {
    console.error('[terminal-sse] createTerminalShell failed:', err);
    return null;
  }
}

app.get('/api/terminal/stream', (req, res) => {
  const session = ensureSseTerminalShell();
  if (!session) {
    return res.status(503).json({ error: 'terminal shell unavailable' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');

  const onOutput = (text) => {
    const escaped = JSON.stringify({ type: 'output', data: text });
    res.write(`data: ${escaped}\n\n`);
  };
  session.outputListeners.add(onOutput);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 15000);

  const cleanup = () => {
    session.outputListeners.delete(onOutput);
    clearInterval(heartbeat);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

app.post('/api/terminal/input', (req, res) => {
  const session = sseTerminalSession;
  if (!session || !session.shell || session.shell.killed) {
    return res.status(503).json({ error: 'no active terminal session' });
  }
  const data = req.body?.data;
  if (typeof data !== 'string') {
    return res.status(400).json({ error: 'missing data field' });
  }
  try {
    if (session.shell.stdin && !session.shell.stdin.destroyed) {
      session.shell.stdin.write(data);
    }
  } catch {}
  res.json({ ok: true });
});

app.post('/api/terminal/resize', (req, res) => {
  const session = sseTerminalSession;
  if (!session || !session.shell || session.shell.killed) {
    return res.status(503).json({ error: 'no active terminal session' });
  }
  const cols = Number(req.body?.cols) || 80;
  const rows = Number(req.body?.rows) || 24;
  if (session.mode === 'pty') {
    tryResizePtyShell(session.shell, cols, rows);
  }
  res.json({ ok: true });
});

// ============================================================
// API: bootstrap (first-time password setup)
// ============================================================
app.get('/api/bootstrap/status', (req, res) => {
  dockerConfig = readDockerConfig();
  const setupRequired = !dockerConfig.webAuth?.users?.admin;
  res.json({ setupRequired });
});

app.post('/api/bootstrap/setup', (req, res) => {
  dockerConfig = readDockerConfig();
  if (dockerConfig.webAuth?.users?.admin) return res.status(409).json({ error: 'Already initialized' });

  const { password } = req.body || {};
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password must include uppercase, lowercase, digits and special characters' });
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

  // Auto-login after setup
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
    // Clear lockout if admin password was changed after lockout started
    const changedAt = dockerConfig.webAuth?.users?.admin?.passwordChangedAt;
    if (changedAt && new Date(changedAt).getTime() > (st.lockUntil - LOCK_MS)) {
      recordLoginSuccess(ip);
    } else {
      const remainSec = Math.ceil((st.lockUntil - Date.now()) / 1000);
      return res.status(429).json({
        error: `Too many failures, locked. Retry in ${remainSec}s`,
        locked: true,
        resetHint: 'To reset password, SSH or docker exec into container and run: openclaw-reset-password'
      });
    }
  }

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

  if (!dockerConfig.webAuth?.users?.admin) {
    return res.status(409).json({ error: 'Please complete initial setup: set admin password', setupRequired: true });
  }

  const user = dockerConfig.webAuth?.users?.[username];
  if (!user || !verifyPassword(password, user.password)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
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
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Missing parameters' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

  const user = dockerConfig.webAuth?.users?.[sess.u];
  if (!user || !verifyPassword(oldPassword, user.password)) return res.status(401).json({ error: 'Current password is incorrect' });

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
const GITHUB_REPO = 'cintia09/clawnook';

function getCurrentVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch { return 'unknown'; }
}

function getLocalDockerfileHash() {
  try { return fs.readFileSync(DOCKERFILE_HASH_FILE, 'utf8').trim(); } catch { return ''; }
}

async function getRemoteDockerfileHashesByRef(ref, timeout = 6000) {
  const candidates = ['Dockerfile.lite'];
  const results = await Promise.all(candidates.map(async (fileName) => {
    try {
      const dfResp = await fetchWithFallback(`${GITHUB_RAW_BASE}/${ref}/${fileName}`, {
        headers: { 'User-Agent': 'clawnook' },
        timeout
      });
      if (!dfResp.ok) return null;
      const dockerfileText = await dfResp.text();
      return crypto.createHash('sha256').update(dockerfileText).digest('hex') || null;
    } catch { return null; }
  }));
  return [...new Set(results.filter(Boolean))];
}

function normalizeVersionTag(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.replace(/^v/i, '');
}

let updateCache = { data: null, checkedAt: 0 };
let _dockerfileChangeLogged = false;   // Only log Dockerfile change once

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

    // --- Method 1: GitHub API ---
    try {
      const resp = await fetchWithFallback(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'clawnook' },
        timeout: 8000
      });
      if (resp.ok) {
        release = await resp.json();
        latestVersion = release.tag_name || '';
        publishedAt = release.published_at || '';
        releaseUrl = release.html_url || releaseUrl;
        releaseName = release.name || latestVersion;
      }
    } catch {}

    // --- Method 2: raw.githubusercontent.com version.txt (fallback only when API unreachable) ---
    {
      try {
        const rawResp = await fetchWithFallback(`${GITHUB_RAW_BASE}/main/version.txt`, {
          headers: { 'User-Agent': 'clawnook' },
          timeout: 6000
        });
        if (rawResp.ok) {
          const versionTxt = (await rawResp.text()).trim();
          if (!latestVersion) {
            // GitHub API unreachable: use version.txt as fallback
            latestVersion = versionTxt;
            releaseName = versionTxt;
            console.log(`[update] GitHub API unavailable, got version from version.txt: ${versionTxt}`);
          }
        }
      } catch {}
    }

    if (!latestVersion) {
      return res.json({ currentVersion, latestVersion: null, error: 'Cannot reach GitHub (both API and raw unreachable)' });
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

    // When deployed version is newer than GitHub release (pre-release / unreleased)，
    // Set latestVersion to currentVersion to avoid showing outdated release version
    let displayLatestVersion = latestVersion;
    if (!hasUpdate && currentNorm && latestNorm && currentNorm !== 'unknown' && currentNorm !== 'dev') {
      const cmp = compareSemver(currentNorm, latestNorm);
      if (cmp > 0) {
        // Current version > GitHub release → show current as latest
        displayLatestVersion = currentVersion;
      }
    }

    const result = {
      currentVersion,
      latestVersion: displayLatestVersion,
      hasUpdate,
      publishedAt,
      releaseUrl,
      releaseName,
      // whether the Dockerfile change requires a full image rebuild/update
      requiresFullUpdate: false,
      dockerfileChanged: false
    };

    // Check Dockerfile hash against release ref first (avoid false positives from main branch drift)
    // Wrap entire Dockerfile comparison in a 12s global timeout to prevent stacking
    try {
      await Promise.race([
        (async () => {
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
        // Only show "full update" or "hot update" prompts when release version changes
        result.requiresFullUpdate = !!hasUpdate && result.dockerfileChanged;
      } else if (remoteHashes.length > 0 && !localHash) {
        // Missing local hash: try comparing with "Dockerfile of current version tag" to avoid false full-update report
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
          // Cannot determine underlying changes: do not force full update, keep hot update option
          result.dockerfileChanged = false;
          result.requiresFullUpdate = false;
        }
      } else {
        // Cannot compare Dockerfile: do not force full update
        result.dockerfileChanged = false;
        result.requiresFullUpdate = false;
      }

      if (checkedRef && result.dockerfileChanged && !_dockerfileChangeLogged) {
        console.log(`[update] Dockerfile changed: local hash differs from ref ${checkedRef}`);
        _dockerfileChangeLogged = true;
      }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dockerfile check timeout')), 12000))
      ]);
    } catch (dfErr) {
      if (dfErr?.message === 'dockerfile check timeout') {
        console.log('[update] Dockerfile comparison timed out (12s), skipping');
      }
    }

    // hasUpdate only triggered by release version change, not Dockerfile change alone.

    updateCache = { data: { latestVersion: displayLatestVersion, hasUpdate: result.hasUpdate, publishedAt, releaseUrl, releaseName, requiresFullUpdate: result.requiresFullUpdate, dockerfileChanged: result.dockerfileChanged }, checkedAt: Date.now() };
    res.json(result);
  } catch (e) {
    res.json({ currentVersion, latestVersion: null, error: e.message });
  }
});

// ============================================================
// API: hot patch (update files without rebuilding image)
// ============================================================

// Fallback file list if remote manifest is unavailable
const HOTPATCH_FILES_FALLBACK = [
  // [GitHub path, local path]
  ['web/public/app.js', '/opt/openclaw-web/public/app.js'],
  ['web/public/i18n.js', '/opt/openclaw-web/public/i18n.js'],
  ['web/public/index.html', '/opt/openclaw-web/public/index.html'],
  ['web/public/login.html', '/opt/openclaw-web/public/login.html'],
  ['web/public/login.js', '/opt/openclaw-web/public/login.js'],
  ['web/public/style.css', '/opt/openclaw-web/public/style.css'],
  ['web/server.js', '/opt/openclaw-web/server.js'],
  ['web/package.json', '/opt/openclaw-web/package.json'],
  ['start-services.sh', '/usr/local/bin/start-services.sh'],
  ['scripts/openclaw-gateway-watchdog.sh', '/usr/local/bin/openclaw-gateway-watchdog.sh'],
  ['scripts/config-fixer.mjs', '/opt/clawnook/scripts/config-fixer.mjs'],
  ['Caddyfile.template', '/etc/caddy/Caddyfile.template'],
];

/**
 * Fetch the hot update manifest from GitHub.
 * Returns an array of [ghPath, localPath] pairs, or the fallback list on failure.
 */
async function fetchHotpatchManifest(branch) {
  try {
    const url = `${GITHUB_RAW_BASE}/${branch}/hotpatch-manifest.json`;
    const resp = await fetchWithFallback(url, {
      headers: { 'User-Agent': 'clawnook' },
      timeout: 8000
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const manifest = await resp.json();
    if (manifest && Array.isArray(manifest.files) && manifest.files.length > 0) {
      return { files: manifest.files, source: 'remote' };
    }
    throw new Error('Empty or invalid manifest');
  } catch (e) {
    return { files: HOTPATCH_FILES_FALLBACK, source: 'fallback', error: e.message };
  }
}

const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}`;
const WEB_PANEL_BACKUP_DIR = '/root/.openclaw/web-panel-backup';

/**
 * Backup current files before hot update，for watchdog rollback
 */
function backupCurrentHotpatchFiles(fileList) {
  try {
    fs.mkdirSync(WEB_PANEL_BACKUP_DIR, { recursive: true });
    const meta = { version: getCurrentVersion(), timestamp: Date.now(), files: {} };
    for (const [, localPath] of fileList) {
      try {
        if (fs.existsSync(localPath)) {
          const basename = path.basename(localPath);
          fs.copyFileSync(localPath, path.join(WEB_PANEL_BACKUP_DIR, basename));
          meta.files[basename] = localPath;
        }
      } catch {}
    }
    // Also backup version number
    try {
      const ver = fs.readFileSync(VERSION_FILE, 'utf8').trim();
      if (ver) meta.backupVersion = ver;
    } catch {}
    fs.writeFileSync(path.join(WEB_PANEL_BACKUP_DIR, '.backup-meta'), JSON.stringify(meta, null, 2));
    return true;
  } catch (e) {
    console.error('[hotpatch] Failed to backup current files:', e.message);
    return false;
  }
}

/**
 * Restore specified files from backup
 */
function restoreHotpatchFile(basename) {
  try {
    const metaPath = path.join(WEB_PANEL_BACKUP_DIR, '.backup-meta');
    if (!fs.existsSync(metaPath)) return false;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const localPath = meta.files && meta.files[basename];
    const backupPath = path.join(WEB_PANEL_BACKUP_DIR, basename);
    if (localPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, localPath);
      return true;
    }
  } catch {}
  return false;
}

let hotpatchState = { status: 'idle', log: '', startedAt: 0 };

app.get('/api/update/hotpatch/status', (req, res) => {
  res.json(hotpatchState);
});

app.post('/api/update/hotpatch', async (req, res) => {
  if (hotpatchState.status === 'running') {
    return res.status(409).json({ error: 'Hot update in progress' });
  }

  const branch = (req.body && req.body.branch) || 'main';
  const force = (req.body && req.body.force) || false;
  hotpatchState = { status: 'running', log: '', startedAt: Date.now(), updated: [], failed: [], force };
  res.json({ success: true, message: force ? 'Force hot update started' : 'Hot update started' });

  const log = (msg) => { hotpatchState.log += msg + '\n'; console.log('[hotpatch] ' + msg); };

  try {
    // Fetch remote manifest to determine which files to update
    const manifest = await fetchHotpatchManifest(branch);
    const fileList = manifest.files;
    if (manifest.source === 'remote') {
      log(`Loaded remote manifest: ${fileList.length} file(s)`);
    } else {
      log(`⚠ Remote manifest unavailable (${manifest.error}), using built-in file list (${fileList.length} files)`);
    }

    // Backup current version before updating for rollback
    if (backupCurrentHotpatchFiles(fileList)) {
      log('Backed up current files to web-panel-backup/');
    } else {
      log('⚠ Failed to backup current files, continuing update (rollback unavailable)');
    }

    log(`${force ? 'Force ' : ''}Pulling latest files from GitHub (${branch})...`);
    let needCaddyRestart = false;
    let needWebRestart = false;
    let needContainerRestart = false;

    for (const [ghPath, localPath] of fileList) {
      try {
        const url = `${GITHUB_RAW_BASE}/${branch}/${ghPath}`;
        const resp = await fetchWithFallback(url, {
          headers: { 'User-Agent': 'clawnook' },
          timeout: 8000
        });

        if (!resp.ok) {
          log(`  ⚠ ${ghPath}: HTTP ${resp.status}, skipped`);
          hotpatchState.failed.push(ghPath);
          continue;
        }

        const content = await resp.text();

        // Compare with existing file (skip comparison if force mode)
        if (!force) {
          let existingContent = '';
          try { existingContent = fs.readFileSync(localPath, 'utf8'); } catch {}

          if (content === existingContent) {
            log(`  ✓ ${ghPath}: no changes`);
            continue;
          }
        }

        // Write new file
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, content);

        // Preserve executable permission for shell scripts
        if (localPath.endsWith('.sh')) {
          try { fs.chmodSync(localPath, 0o755); } catch {}
        }

        log(`  ✅ ${ghPath}: updated`);
        hotpatchState.updated.push(ghPath);

        if (ghPath === 'Caddyfile.template') needCaddyRestart = true;
        if (ghPath === 'web/server.js') needWebRestart = true;
        if (ghPath === 'start-services.sh') needContainerRestart = true;
      } catch (e) {
        log(`  ❌ ${ghPath}: ${e.message}`);
        hotpatchState.failed.push(ghPath);
      }
    }

    // server.js syntax check: verify after write, rollback on failure
    if (hotpatchState.updated.includes('web/server.js')) {
      try {
        execSync('node -c /opt/openclaw-web/server.js', { timeout: 15000, stdio: 'pipe' });
        log('  ✓ server.js syntax check passed');
      } catch (syntaxErr) {
        const stderr = (syntaxErr.stderr || '').toString().trim();
        log(`  ❌ server.js syntax error! ${stderr}`);
        log('  ↩ Restoring server.js from backup...');
        if (restoreHotpatchFile('server.js')) {
          log('  ✅ server.js restored from backup, skipping this server.js update');
          hotpatchState.updated = hotpatchState.updated.filter(f => f !== 'web/server.js');
          needWebRestart = false;
        } else {
          log('  ⚠ Cannot restore from backup server.js，panel may fail to start');
        }
        hotpatchState.failed.push('web/server.js (syntax error, rolled back)');
      }
    }

    // Run npm install if package.json was updated (new dependencies)
    if (hotpatchState.updated.includes('web/package.json')) {
      try {
        log('package.json updated, running npm install...');
        execSync('cd /opt/openclaw-web && npm install --omit=dev 2>&1', { timeout: 60000, stdio: 'pipe' });
        log('  ✓ npm install completed');
      } catch (npmErr) {
        const stderr = (npmErr.stderr || '').toString().trim().slice(0, 200);
        log(`  ⚠ npm install failed (non-fatal): ${stderr}`);
      }
    }

    // Update version file ONLY if ALL files were successfully updated (no failures)
    if (hotpatchState.failed.length > 0) {
      log(`⚠️ version not updated: ${hotpatchState.failed.length} file update(s) failed, check network or GitHub access`);
      hotpatchState.status = 'error';
      return;
    } else {
      // No failures: update version number (even if files unchanged, sync latest version tag)
      try {
        let newVersion = '';
        try {
          const versionResp = await fetchWithFallback(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'clawnook' },
            timeout: 10000
          });
          if (versionResp.ok) {
            const rel = await versionResp.json();
            if (rel.tag_name) newVersion = rel.tag_name;
          }
        } catch {}
        if (!newVersion) {
          try {
            const rawVer = await fetchWithFallback(`${GITHUB_RAW_BASE}/main/version.txt`, {
              headers: { 'User-Agent': 'clawnook' },
              timeout: 8000
            });
            if (rawVer.ok) newVersion = (await rawVer.text()).trim();
          } catch {}
        }
        if (newVersion) {
          fs.writeFileSync(VERSION_FILE, newVersion + '\n');
          log(`Version updated to: ${newVersion}`);
        } else if (hotpatchState.updated.length === 0) {
          log(`All files are up to date, no changes needed`);
        }
      } catch {}
    }

    // Sync Dockerfile hash so future update checks don't report requiresFullUpdate
    if (hotpatchState.updated.length > 0) {
      try {
        const dfResp = await fetchWithFallback(`${GITHUB_RAW_BASE}/main/Dockerfile.lite`, {
          headers: { 'User-Agent': 'clawnook' },
          timeout: 8000
        });
        if (dfResp.ok) {
          const dfText = await dfResp.text();
          const newHash = crypto.createHash('sha256').update(dfText).digest('hex');
          fs.writeFileSync(DOCKERFILE_HASH_FILE, newHash + '\n');
          log(`Dockerfile hash synced: ${newHash.slice(0, 12)}...`);
        }
      } catch {}
    }

    // Regenerate Caddyfile and restart Caddy if template changed
    if (needCaddyRestart) {
      log('Caddyfile Template updated, regenerating config and restarting Caddy...');
      try {
        execSync('bash -c "source /usr/local/bin/start-services.sh 2>/dev/null; envsubst < /etc/caddy/Caddyfile.template > /tmp/Caddyfile" 2>/dev/null || true');
        execSync('pkill -USR1 caddy 2>/dev/null || true');
        log('Caddy notified to reload config');
      } catch (e) {
        log(`Caddy reload failed (non-fatal): ${e.message}`);
      }
    }

    // Clear update cache
    updateCache = { data: null, checkedAt: 0 };

    const summary = `Hot update complete: ${hotpatchState.updated.length} file(s) updated, ${hotpatchState.failed.length} failed`;
    log(summary);
    if (needContainerRestart) {
      log('Detected start-services.sh updated: please run on host machine `docker restart clawnook` to apply entry script changes (hot update alone will not take effect)');
      log('If container name is unknown: first run `docker ps --format "{{.Names}}"` to confirm name, then run `docker restart <container-name>`');
    }
    hotpatchState.status = 'done';

    // If server.js was updated, schedule a self-restart
    if (needWebRestart && hotpatchState.updated.includes('web/server.js')) {
      log('server.js updated, auto-restarting Web panel in 2 seconds...');
      setTimeout(() => {
        try { execSync('pkill -f "node server.js" 2>/dev/null || true'); } catch {}
        // The health check in start-services.sh will auto-restart the web panel
      }, 2000);
    }
  } catch (e) {
    log(`Hot update failed: ${e.message}`);
    hotpatchState.status = 'error';
  }
});

// ============================================================
// API: status
// ============================================================
app.get('/api/status', async (req, res) => {
  const statusStart = Date.now();
  const status = { gateway: false, gatewayStarting: false, web: true, caddy: false, uptime: 0, memory: {}, version: getCurrentVersion() };
  const ocSnapshot = getOpenClawInstallationSnapshot();
  status.openclawInstalled = !!ocSnapshot?.installed;
  status.openclawVersion = String(ocSnapshot?.version || '').trim();
  status.installInstanceId = getOpenClawInstallInstanceId();

  const gatewayLogTail = readGatewayLogTail(220);
  const gatewayRuntimeInfoPromise = getGatewayRuntimeProcessInfo();
  // Run shell checks in parallel (async) to avoid blocking the event loop
  const [gatewayHealthCodeText, gatewayRuntimeInfo, portListening, caddyRunning, watchdogRunning] = await Promise.all([
    runCommandTextAsync(LOCAL_GATEWAY_HEALTH_CHECK_CMD, 3000),
    gatewayRuntimeInfoPromise,
    runCommandOkAsync('ss -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]" || netstat -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]"', 1200),
    runCommandOkAsync('pgrep -f caddy >/dev/null 2>&1 || ss -ltn 2>/dev/null | grep -q ":443 " || netstat -ltn 2>/dev/null | grep -q ":443 "', 1200),
    runCommandOkAsync('pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1', 1200),
  ]);
  const gatewayHealthCode = Number.parseInt(String(gatewayHealthCodeText || '').trim(), 10) || 0;
  const gatewayPidSafe = Number(gatewayRuntimeInfo?.pid || 0);
  const gatewayProcessRunning = isGatewayRuntimeProcessRunning() || portListening;
  const gatewayProcessUptimeSec = Number(gatewayRuntimeInfo?.uptimeSec || 0);
  const gatewayPairingRequired = !isGatewayDeviceAuthDisabled()
    && detectGatewayPairingRequiredRecent(gatewayLogTail, 900);
  const opState = getOpenClawOperationState();

  status.gateway = gatewayHealthCode === 200;
  status.gatewayHealthCode = gatewayHealthCode;
  status.gatewayProcessRunning = gatewayProcessRunning;
  status.gatewayProcessUptimeSec = gatewayProcessUptimeSec;
  status.gatewayPairingRequired = gatewayPairingRequired;
  if (!status.gateway) {
    const e = new Error('gateway not detected');
    if (req.query.debug === '1') {
      console.log(`[status] gateway check miss: ${e.message || e}`);
    }
  }

  status.caddy = caddyRunning;
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
  status.gatewayWatchdog = watchdogRunning;
  const gatewayWarmupByProcess = !!(
    status.openclawInstalled
    && !status.gateway
    && status.gatewayProcessRunning
    && status.gatewayProcessUptimeSec > 0
    && status.gatewayProcessUptimeSec <= 300
  );
  const gatewayRestartingByOp = !!(
    status.openclawInstalled
    &&
    opState?.type === 'restarting_gateway'
    && (status.gatewayProcessRunning || status.gateway)
  );
  const gatewayWarmupByWatchdog = !!(
    status.openclawInstalled
    &&
    !status.gateway
    && status.gatewayWatchdog
    && isGatewayWatchdogStartupInProgress(900)
  );
  status.gatewayStarting = gatewayWarmupByProcess || gatewayRestartingByOp || gatewayWarmupByWatchdog;

  status.terminal = {
    wsEnabled: !!terminalBackendState.wsEnabled,
    ready: !!terminalBackendState.ready,
    mode: terminalBackendState.mode || 'unknown',
    reason: terminalBackendState.reason || '',
    updatedAt: terminalBackendState.updatedAt || 0
  };

  const statusElapsed = Date.now() - statusStart;
  const debugMode = req.query.debug === '1';
  const snapshot = [
    Number(status.gateway),
    Number(status.gatewayStarting),
    Number(status.caddy),
    Number(status.gatewayWatchdog),
    status.version || '',
    status.openclawVersion || '',
    status.terminal?.mode || '',
    Number(status.terminal?.ready)
  ].join('|');
  const changed = snapshot !== statusLogState.lastSnapshot;
  if (changed) {
    statusLogState.lastSnapshot = snapshot;
  }
  if (debugMode || changed) {
    const reason = debugMode ? 'debug' : 'changed';
    console.log(`[status] reason=${reason} elapsed=${statusElapsed}ms gateway=${status.gateway} caddy=${status.caddy} version=${status.version}`);
  }

  res.json(status);
});

// ============================================================
// API: config (basic; keep legacy behavior)
// ============================================================
// Messaging platform sensitive field list
const MSG_SENSITIVE_FIELDS = ['apiKey', 'secret', 'token', 'encryptKey', 'password', 'appSecret'];

function maskSensitiveFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const safe = JSON.parse(JSON.stringify(obj));
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && MSG_SENSITIVE_FIELDS.includes(k) && v && v !== '***') {
        node[k] = maskApiKey(v);
      } else if (typeof v === 'object') {
        walk(v);
      }
    }
  };
  walk(safe);
  return safe;
}

function encryptSensitiveFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && MSG_SENSITIVE_FIELDS.includes(k) && v && !isEncrypted(v) && v !== '***') {
        node[k] = encryptValue(v);
      } else if (typeof v === 'object') {
        walk(v);
      }
    }
  };
  walk(obj);
}

app.get('/api/config', async (req, res) => {
  try {
    repairOpenClawConfigProviders();
    const configPath = '/root/.openclaw/openclaw.json';

    // Read openclaw.json (native read to avoid timeout)
    let config = {};
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch {
      config = {};
    }

    // only return channels field (mask sensitive info)
    const result = { channels: config.channels || {} };
    const safe = maskSensitiveFields(result);
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    repairOpenClawConfigProviders();
    const configPath = '/root/.openclaw/openclaw.json';

    // Read existing openclaw.json
    let config = {};
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch {
      config = {};
    }

    const updates = req.body || {};

    const savedChannels = [];

    // Merge channels config into openclaw.json (stored in plaintext, read directly by openclaw)
    if (updates.channels) {
      if (!config.channels) config.channels = {};
      savedChannels.push(...Object.keys(updates.channels));
      // Before merging, strip masked values (prevent *** overwriting real keys)
      stripMaskedValues(updates.channels);
      // Compat with legacy wrong fields and align with current OpenClaw schema
      normalizeDiscordChannelConfig(updates.channels);
      normalizeDiscordChannelConfig(config.channels);
      normalizeFeishuChannelConfig(updates.channels);
      normalizeFeishuChannelConfig(config.channels);

      // Multi-server mode: clear old values first when frontend explicitly requests guilds replacement
      const replaceGuilds = !!updates.channels?.discord?.__replaceGuilds;
      if (replaceGuilds) {
        if (!config.channels.discord || typeof config.channels.discord !== 'object') {
          config.channels.discord = {};
        }
        config.channels.discord.guilds = {};
        delete updates.channels.discord.__replaceGuilds;
      }

      deepMerge(config.channels, updates.channels);
    }

    // Write back openclaw.json (auto-clean invalid keys)
    try {
      writeOpenClawConfig(config);
    } catch (err) {
      throw new Error(`Failed to write config: ${err.message}`);
    }

    res.json({ success: true, savedChannels: Array.from(new Set(savedChannels)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }

});

// Recursively remove fields matching mask pattern (***)，Prevent masked values from overwriting real keys
function stripMaskedValues(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    // UI mask values (*** or •••) should not overwrite real keys
    const looksMasked = typeof v === 'string' && (
      /^\*{3,}/.test(v) ||
      /^•+$/.test(v) ||
      v.includes('•••')
    );
    if (looksMasked) {
      delete obj[k];
    } else if (typeof v === 'object' && v !== null) {
      stripMaskedValues(v);
    }
  }
}

// Compat old/wrong fields, normalize to current OpenClaw schema
const VALID_DISCORD_STREAMING = new Set(['true', 'false', 'off', 'partial', 'block', 'progress']);

function normalizeDiscordChannelConfig(channelsObj) {
  if (!channelsObj || typeof channelsObj !== 'object') return;
  const discord = channelsObj.discord;
  if (!discord || typeof discord !== 'object') return;

  // streaming value validation: 'full' is invalid, mapped to 'progress'
  if (discord.streaming !== undefined) {
    const sv = String(discord.streaming).toLowerCase().trim();
    if (!VALID_DISCORD_STREAMING.has(sv)) {
      discord.streaming = sv === 'full' ? 'progress' : 'partial';
    } else {
      discord.streaming = sv;
    }
  }

  // Legacy field guildId not in official schema, migrated to guilds
  if (typeof discord.guildId === 'string' && discord.guildId.trim()) {
    const gid = discord.guildId.trim();
    if (!discord.guilds || typeof discord.guilds !== 'object') {
      discord.guilds = {};
    }
    if (!discord.guilds[gid] || typeof discord.guilds[gid] !== 'object') {
      discord.guilds[gid] = {};
    }
  }
  if (Object.prototype.hasOwnProperty.call(discord, 'guildId')) {
    delete discord.guildId;
  }

  // Also clean wrong fields at account level
  if (discord.accounts && typeof discord.accounts === 'object') {
    for (const accountCfg of Object.values(discord.accounts)) {
      if (!accountCfg || typeof accountCfg !== 'object') continue;
      if (typeof accountCfg.guildId === 'string' && accountCfg.guildId.trim()) {
        const gid = accountCfg.guildId.trim();
        if (!accountCfg.guilds || typeof accountCfg.guilds !== 'object') {
          accountCfg.guilds = {};
        }
        if (!accountCfg.guilds[gid] || typeof accountCfg.guilds[gid] !== 'object') {
          accountCfg.guilds[gid] = {};
        }
      }
      if (Object.prototype.hasOwnProperty.call(accountCfg, 'guildId')) {
        delete accountCfg.guildId;
      }
    }
  }
}

// Feishu channel normalization：accounts.main → accounts.default，dmPolicy=open → allowFrom
function normalizeFeishuChannelConfig(channelsObj) {
  if (!channelsObj || typeof channelsObj !== 'object') return;
  const feishu = channelsObj.feishu;
  if (!feishu || typeof feishu !== 'object') return;

  if (feishu.accounts && typeof feishu.accounts === 'object') {
    // If only main exists without default, rename main to default
    if (feishu.accounts.main && !feishu.accounts.default) {
      feishu.accounts.default = feishu.accounts.main;
      delete feishu.accounts.main;
    }
    // For each account: auto-add allowFrom: when dmPolicy=open; ["*"]；clean empty string optional fields
    for (const acct of Object.values(feishu.accounts)) {
      if (!acct || typeof acct !== 'object') continue;
      if (acct.dmPolicy === 'open' && !acct.allowFrom) {
        acct.allowFrom = ['*'];
      }
      // Remove empty string optional fields (avoid Gateway schema errors)
      for (const opt of ['verificationToken', 'encryptKey']) {
        if (acct[opt] === '') delete acct[opt];
      }
    }
  }
}

// ============================================================
// API: Remote device management (Node mode)
// ============================================================
const BROWSER_CONTROL_PORT = 18791;

function getGatewayAuthToken() {
  try {
    const cfg = readJson(CONFIG_PATH, {});
    return normalizeGatewayAuthToken(cfg?.gateway?.auth?.token || '');
  } catch { return ''; }
}

function normalizeDeviceMetadataForAuth(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').toLowerCase();
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ format: 'der', type: 'spki' });
  const raw = Buffer.isBuffer(der) && der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ? der.subarray(ED25519_SPKI_PREFIX.length)
    : Buffer.from(der);
  return base64urlEncode(raw);
}

function deriveDeviceIdFromPublicKeyPem(publicKeyPem) {
  const rawPublicKey = base64urlDecode(publicKeyRawBase64UrlFromPem(publicKeyPem));
  return crypto.createHash('sha256').update(rawPublicKey).digest('hex');
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64urlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

function ensureGatewayDeviceIdentityAuth() {
  const identity = readJson(DEVICE_IDENTITY_PATH, {});
  const authStore = readJson(DEVICE_AUTH_STORE_PATH, {});
  if (identity?.deviceId && identity?.publicKeyPem && identity?.privateKeyPem && authStore?.tokens?.operator?.token) {
    const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
    const originalDeviceId = String(identity.deviceId);
    const deviceId = deriveDeviceIdFromPublicKeyPem(String(identity.publicKeyPem));
    const scopes = Array.isArray(authStore?.tokens?.operator?.scopes)
      ? authStore.tokens.operator.scopes.map((scope) => String(scope || '').trim()).filter(Boolean)
      : buildNormalizedPairedScopes('operator', ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing']);
    const now = Date.now();
    if (originalDeviceId !== deviceId) {
      delete paired[originalDeviceId];
      writeJson(DEVICE_IDENTITY_PATH, {
        deviceId,
        publicKeyPem: String(identity.publicKeyPem),
        privateKeyPem: String(identity.privateKeyPem)
      });
    }
    const current = paired[deviceId] && typeof paired[deviceId] === 'object' ? paired[deviceId] : {};
    paired[deviceId] = {
      ...current,
      deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(String(identity.publicKeyPem)),
      displayName: current.displayName || CONTROL_UI_BACKEND_DISPLAY_NAME,
      platform: current.platform || process.platform,
      clientId: CONTROL_UI_BACKEND_CLIENT_ID,
      clientMode: 'webchat',
      role: 'operator',
      roles: ['operator'],
      scopes,
      approvedScopes: scopes,
      tokens: {
        ...(current.tokens && typeof current.tokens === 'object' ? current.tokens : {}),
        operator: {
          token: normalizeGatewayAuthToken(authStore?.tokens?.operator?.token || ''),
          role: 'operator',
          scopes,
          createdAtMs: Number(authStore?.tokens?.operator?.createdAtMs || current?.tokens?.operator?.createdAtMs || now),
          rotatedAtMs: Number(authStore?.tokens?.operator?.rotatedAtMs || now)
        }
      },
      approvedAtMs: Number(current.approvedAtMs || now),
      isRepair: false
    };
    writeJson(DEVICE_PAIRING_PAIRED_PATH, paired);
    return {
      identity: {
        deviceId,
        publicKeyPem: String(identity.publicKeyPem),
        privateKeyPem: String(identity.privateKeyPem)
      },
      deviceAuthToken: normalizeGatewayAuthToken(authStore?.tokens?.operator?.token || '')
    };
  }

  const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
  const now = Date.now();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const deviceId = deriveDeviceIdFromPublicKeyPem(publicKeyPem);
  const operatorToken = crypto.randomBytes(24).toString('hex');
  const scopes = buildNormalizedPairedScopes('operator', ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing']);

  paired[deviceId] = {
    deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(publicKeyPem),
    displayName: CONTROL_UI_BACKEND_DISPLAY_NAME,
    platform: process.platform,
    clientId: CONTROL_UI_BACKEND_CLIENT_ID,
    clientMode: 'webchat',
    role: 'operator',
    roles: ['operator'],
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: {
        token: operatorToken,
        role: 'operator',
        scopes,
        createdAtMs: now,
        rotatedAtMs: now
      }
    },
    approvedAtMs: now,
    isRepair: false
  };

  writeJson(DEVICE_PAIRING_PAIRED_PATH, paired);
  writeJson(DEVICE_IDENTITY_PATH, { deviceId, publicKeyPem, privateKeyPem });
  writeJson(DEVICE_AUTH_STORE_PATH, {
    tokens: {
      operator: {
        token: operatorToken,
        role: 'operator',
        scopes,
        createdAtMs: now,
        rotatedAtMs: now
      }
    }
  });

  return {
    identity: { deviceId, publicKeyPem, privateKeyPem },
    deviceAuthToken: operatorToken
  };
}

function buildDeviceAuthPayloadV3(params) {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token || '',
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily || '')
  ].join('|');
}

function loadGatewayDeviceIdentityAuth() {
  const state = ensureGatewayDeviceIdentityAuth();
  if (!state?.identity?.deviceId || !state?.identity?.publicKeyPem || !state?.identity?.privateKeyPem) return null;

  const deviceAuthToken = normalizeGatewayAuthToken(state?.deviceAuthToken || '');
  const authToken = deviceAuthToken || getGatewayAuthToken();
  if (!authToken) return null;

  return {
    identity: {
      deviceId: String(state.identity.deviceId),
      publicKeyPem: String(state.identity.publicKeyPem),
      privateKeyPem: String(state.identity.privateKeyPem)
    },
    authToken
  };
}

function loadGatewayOperatorTokenAuth() {
  const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
  const operatorEntry = Object.values(paired).find((entry) =>
    entry
    && typeof entry === 'object'
    && entry.clientId === 'openclaw-control-ui'
    && (entry.clientMode === 'webchat' || entry.role === 'operator')
    && entry.tokens
    && typeof entry.tokens === 'object'
    && entry.tokens.operator
  );
  if (!operatorEntry) return null;

  const operatorToken = normalizeGatewayAuthToken(operatorEntry?.tokens?.operator?.token || '');
  if (!operatorToken) return null;

  const approvedScopes = Array.isArray(operatorEntry?.approvedScopes)
    ? operatorEntry.approvedScopes.map((scope) => String(scope || '').trim()).filter(Boolean)
    : [];

  return {
    authToken: operatorToken,
    scopes: approvedScopes.length ? approvedScopes : ['operator.admin', 'operator.read', 'operator.approvals', 'operator.pairing']
  };
}

function buildControlUiConnectParams(nonce) {
  const authState = loadGatewayDeviceIdentityAuth();
  const operatorTokenState = loadGatewayOperatorTokenAuth();
  if (!nonce) return null;
  const scopes = operatorTokenState?.scopes || ['operator.admin', 'operator.read', 'operator.approvals', 'operator.pairing'];

  if (!authState) {
    if (!operatorTokenState?.authToken) return null;
    return {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: CONTROL_UI_BACKEND_CLIENT_ID,
        displayName: CONTROL_UI_BACKEND_DISPLAY_NAME,
        version: '2026.3.12',
        platform: process.platform,
        mode: 'webchat'
      },
      caps: [],
      role: 'operator',
      scopes,
      auth: { token: operatorTokenState.authToken }
    };
  }

  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: authState.identity.deviceId,
    clientId: CONTROL_UI_BACKEND_CLIENT_ID,
    clientMode: 'webchat',
    role: 'operator',
    scopes,
    signedAtMs,
    token: authState.authToken,
    nonce,
    platform: process.platform,
    deviceFamily: ''
  });

  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: CONTROL_UI_BACKEND_CLIENT_ID,
      displayName: CONTROL_UI_BACKEND_DISPLAY_NAME,
      version: '2026.3.12',
      platform: process.platform,
      mode: 'webchat'
    },
    caps: [],
    role: 'operator',
    scopes,
    auth: { token: authState.authToken },
    device: {
      id: authState.identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(authState.identity.publicKeyPem),
      signature: signDevicePayload(authState.identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce
    }
  };
}

function logNodeProbeDebug(...args) {
  if (process.env.OPENCLAW_NODE_PROBE_DEBUG === '1') {
    console.log(...args);
  }
}

function logRateLimited(key, intervalMs, ...args) {
  const now = Date.now();
  const interval = Math.max(1000, Number(intervalMs) || 1000);
  const state = RATE_LIMITED_LOG_STATE.get(key);
  if (state && (now - state.lastAt) < interval) {
    state.skipped += 1;
    return;
  }
  const skipped = state?.skipped || 0;
  RATE_LIMITED_LOG_STATE.set(key, { lastAt: now, skipped: 0 });
  if (skipped > 0) {
    baseConsole.log(...args, `(suppressed ${skipped} repeats in ${Math.round(interval / 1000)}s)`);
    return;
  }
  baseConsole.log(...args);
}

function logNodeGatewaySocketIssue(prefix, errorLike, gatewayPort) {
  const message = String(errorLike?.message || errorLike || '').trim();
  const port = Number(gatewayPort || 18789) || 18789;
  if (message && /ECONNREFUSED/i.test(message) && message.includes(`127.0.0.1:${port}`)) {
    logRateLimited(`node-gateway-refused-${port}-${prefix}`, 60000, `${prefix} ${message}`);
    return;
  }
  if (message) {
    baseConsole.log(prefix, message);
    return;
  }
  baseConsole.log(prefix, errorLike);
}

function createGatewayControlUiClient(timeoutMs = 5000) {
  // Skip if in backoff period to prevent triggering gateway rate limiter
  if (_gwAuthBackoff.backoffUntil > Date.now()) {
    return Promise.reject(new Error(`gateway auth backoff (${Math.ceil((_gwAuthBackoff.backoffUntil - Date.now()) / 1000)}s remaining)`));
  }
  return new Promise((resolve, reject) => {
    const WsClient = require('ws');
    const cfg = readDockerConfig();
    const gatewayPort = Number(cfg.port || 18789) || 18789;
    let settled = false;
    let ws = null;
    let connectId = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch {}
      reject(new Error('gateway control-ui connect timeout'));
    }, Math.max(1500, timeoutMs));

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      reject(err instanceof Error ? err : new Error(String(err || 'gateway control-ui connect failed')));
    };

    try {
      ws = new WsClient(`ws://127.0.0.1:${gatewayPort}`, {
        headers: { Origin: 'http://127.0.0.1' }
      });
    } catch (e) {
      logNodeGatewaySocketIssue('[node] control-ui WS connect failed:', e, gatewayPort);
      finishReject(e);
      return;
    }

    ws.on('close', () => {
      if (!settled) finishReject(new Error('gateway control-ui socket closed before ready'));
    });
    ws.on('error', (e) => {
      logNodeGatewaySocketIssue('[node] control-ui WS error:', e, gatewayPort);
      if (!settled) finishReject(e);
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.event === 'connect.challenge') {
          const nonce = typeof msg.payload?.nonce === 'string' ? msg.payload.nonce.trim() : '';
          const connectParams = buildControlUiConnectParams(nonce);
          if (!connectParams) {
            finishReject(new Error('gateway control-ui identity unavailable'));
            return;
          }
          connectId = crypto.randomUUID();
          ws.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: connectParams }));
          return;
        }
        if (msg.id === connectId) {
          if (!msg.ok) {
            _gwAuthBackoff.failCount++;
            const backoffSec = Math.min(300, 10 * Math.pow(2, _gwAuthBackoff.failCount - 1));
            _gwAuthBackoff.backoffUntil = Date.now() + backoffSec * 1000;
            finishReject(new Error(msg.error?.message || msg.error?.code || 'gateway connect rejected'));
            return;
          }
          _gwAuthBackoff = { failCount: 0, backoffUntil: 0 };
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const request = (method, params, requestTimeoutMs = timeoutMs) => new Promise((resolveReq, rejectReq) => {
            const id = crypto.randomUUID();
            const reqTimer = setTimeout(() => {
              handlers.delete(id);
              rejectReq(new Error(`${method} timeout`));
            }, Math.max(1500, requestTimeoutMs));
            handlers.set(id, { resolveReq, rejectReq, reqTimer });
            ws.send(JSON.stringify({ type: 'req', id, method, params }));
          });
          const close = () => { try { ws.close(); } catch {} };
          const handlers = new Map();
          const eventListeners = new Map();
          const on = (event, cb) => {
            if (!eventListeners.has(event)) eventListeners.set(event, []);
            eventListeners.get(event).push(cb);
          };
          ws.on('message', (innerData) => {
            try {
              const innerMsg = JSON.parse(String(innerData));
              const pending = handlers.get(innerMsg.id);
              if (pending) {
                handlers.delete(innerMsg.id);
                clearTimeout(pending.reqTimer);
                if (innerMsg.ok) pending.resolveReq(innerMsg.payload);
                else pending.rejectReq(new Error(innerMsg.error?.message || innerMsg.error?.code || `${innerMsg.id} failed`));
                return;
              }
              if (innerMsg.event) {
                const cbs = eventListeners.get(innerMsg.event);
                if (cbs) cbs.forEach(cb => { try { cb(innerMsg.payload); } catch {} });
              }
            } catch {}
          });
          resolve({ request, close, on });
        }
      } catch {}
    });
  });
}

async function fetchNodeIpv4Address(nodeId, platform) {
  if (!nodeId) return '';
  let client = null;
  try {
    const normalizedPlatform = String(platform || '').toLowerCase();
    client = await createGatewayControlUiClient(5000);
    const binsPayload = await client.request('node.invoke', {
      nodeId,
      command: 'system.which',
      params: { bins: ['ip', 'ifconfig', 'ipconfig'] },
      timeoutMs: 10000,
      idempotencyKey: crypto.randomUUID()
    }, 12000);
    const binsResult = binsPayload && typeof binsPayload === 'object' ? (binsPayload.payload || binsPayload) : {};
    const bins = binsResult && typeof binsResult.bins === 'object' ? binsResult.bins : binsResult;
    const ipBin = typeof bins?.ip === 'string' ? bins.ip.trim() : '';
    const ifconfigBin = typeof bins?.ifconfig === 'string' ? bins.ifconfig.trim() : '';
    const ipconfigBin = typeof bins?.ipconfig === 'string' ? bins.ipconfig.trim() : '';
    let command = null;
    if (normalizedPlatform.startsWith('darwin') && ifconfigBin) {
      command = [ifconfigBin];
    } else if (ipBin) {
      command = [ipBin, '-4', 'route', 'get', '1'];
    } else if (ipconfigBin) {
      command = [ipconfigBin];
    } else if (ifconfigBin) {
      command = [ifconfigBin];
    } else {
      return '';
    }

    const preparedPayload = await client.request('node.invoke', {
      nodeId,
      command: 'system.run.prepare',
      params: { command },
      timeoutMs: 15000,
      idempotencyKey: crypto.randomUUID()
    }, 16000);
    const prepared = preparedPayload && typeof preparedPayload === 'object' ? (preparedPayload.payload || preparedPayload) : null;
    const plan = prepared && typeof prepared.plan === 'object' ? prepared.plan : null;
    if (!plan || !Array.isArray(plan.argv)) return '';

    const runPayload = await client.request('node.invoke', {
      nodeId,
      command: 'system.run',
      params: {
        command: plan.argv,
        rawCommand: plan.commandText,
        cwd: plan.cwd,
        timeoutMs: 10000
      },
      timeoutMs: 20000,
      idempotencyKey: crypto.randomUUID()
    }, 22000);
    const run = runPayload && typeof runPayload === 'object' ? (runPayload.payload || runPayload) : {};
    const output = [run.stdout, run.stderr, run.output].filter(v => typeof v === 'string' && v.trim()).join('\n');
    if (ipBin) {
      // "ip -4 route get 1" output: "1.0.0.0 via X.X.X.X dev ethN src 10.208.168.108 ..."
      const routeMatch = String(output).match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/);
      if (routeMatch && routeMatch[1] !== '127.0.0.1') return routeMatch[1];
      // Fallback: parse "ip addr" style output
      const matches = Array.from(String(output).matchAll(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\b/g)).map((m) => m[1]);
      const picked = matches.find((ip) => ip !== '127.0.0.1' && !ip.startsWith('169.254.') && !ip.startsWith('172.17.') && !ip.startsWith('172.18.'));
      return picked || '';
    }
    if (ifconfigBin && normalizedPlatform.startsWith('darwin')) {
      const matches = Array.from(String(output).matchAll(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\b/g)).map((m) => m[1]);
      const picked = matches.find((ip) => ip !== '127.0.0.1' && !ip.startsWith('169.254.'));
      return picked || '';
    }
    if (ipconfigBin || normalizedPlatform.startsWith('win')) {
      const matches = Array.from(String(output).matchAll(/IPv4[^:\n]*[:：]\s*(\d{1,3}(?:\.\d{1,3}){3})/gi)).map((m) => m[1]);
      const picked = matches.find((ip) => ip !== '127.0.0.1' && !ip.startsWith('169.254.'));
      return picked || '';
    }
    return '';
  } catch {
    return '';
  } finally {
    try { client?.close(); } catch {}
  }
}

// GET /api/node/setup-command — Generate one-click connect command
app.get('/api/node/setup-command', (req, res) => {
  try {
    const token = getGatewayAuthToken();
    const dcfg = readDockerConfig();
    const configuredDomain = String(dcfg?.domain || '').trim();
    const certMode = String(dcfg?.cert_mode || '').trim().toLowerCase();
    const configuredDomainIsIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(configuredDomain)
      || (configuredDomain.includes(':') && /^[0-9a-f:]+$/i.test(configuredDomain));
    const requestedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
      .replace(/:\d+$/, '')
      .trim();
    const host = configuredDomain && certMode === 'letsencrypt' && !configuredDomainIsIp
      ? configuredDomain
      : (requestedHost || configuredDomain || '127.0.0.1');
    const tlsMode = getNodeTlsCommandMode(dcfg);
    const gatewayTlsPort = Number(dcfg.gateway_tls_public_port || dcfg.gateway_tls_port || 18790) || 18790;
    if (!token) {
      return res.json({ success: true, command: '# Gateway Auth Token not configured，Please configure gateway.auth.token in openclaw.json first', hasToken: false, commandWindows: '' });
    }
    const cfg = readJson(CONFIG_PATH, {});
    const execSecurity = cfg?.tools?.exec?.security || 'full';
    const tlsEnvPrefix = tlsMode.disableVerify ? 'NODE_TLS_REJECT_UNAUTHORIZED=0 ' : '';
    const tlsEnvWindows = tlsMode.disableVerify ? "$env:NODE_TLS_REJECT_UNAUTHORIZED='0'; " : '';
    const gatewayInstanceKey = getNodeGatewayInstanceKey(host, gatewayTlsPort);
    const nodeDirDisplay = `~/.openclaw/nodes/${gatewayInstanceKey}`;
    const nodeLogPathDisplay = `${nodeDirDisplay}/node-host.log`;
    const nodeStopCmd = `if [ -f ${nodeDirDisplay}/node-host.pid ]; then kill "$(cat ${nodeDirDisplay}/node-host.pid)"; fi`;
    const nodeDirWindowsDisplay = `%USERPROFILE%\\.openclaw\\nodes\\${gatewayInstanceKey}`;
    const nodeLogPathWindowsDisplay = `${nodeDirWindowsDisplay}\\node-host.log`;
    const nodeStopCmdWindows = `$pidFile = Join-Path $env:USERPROFILE '.openclaw\\nodes\\${gatewayInstanceKey}\\node-host.pid'; if (Test-Path $pidFile) { Stop-Process -Id ([int](Get-Content $pidFile | Select-Object -First 1)) -Force -ErrorAction SilentlyContinue }; schtasks /Delete /TN 'OpenClawNode_${gatewayInstanceKey.slice(0, 20)}' /F 2>$null`;

    // Linux/macOS: auto-configure node host exec security via openclaw.json before launch
    const initCmd = `mkdir -p ~/.openclaw && cat > ~/.openclaw/openclaw.json << 'NODEEOF'\n{"tools":{"exec":{"security":"${execSecurity}"}}}\nNODEEOF`;
    const runCmd = `${tlsEnvPrefix}OPENCLAW_GATEWAY_TOKEN=${shellSingleQuote(token)} openclaw node run --host ${host} --port ${gatewayTlsPort} --tls`;

    const bashRunner = [
      'set -eu',
      `node_dir="$HOME/.openclaw/nodes/${gatewayInstanceKey}"`,
      'mkdir -p "$node_dir"',
      'pid_file="$node_dir/node-host.pid"',
      'runner_file="$node_dir/node-host-runner.sh"',
      'log_file="$node_dir/node-host.log"',
      'if [ -f "$pid_file" ]; then',
      '  old_pid="$(cat "$pid_file" 2>/dev/null || true)"',
      '  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then',
      '    kill "$old_pid" 2>/dev/null || true',
      '    sleep 1',
      '    kill -9 "$old_pid" 2>/dev/null || true',
      '  fi',
      'fi',
      'pkill -f "openclaw node run --host ' + host + ' --port ' + String(gatewayTlsPort) + ' --tls" 2>/dev/null || true',
      'cat > "$runner_file" <<\'NODEBG\'',
      '#!/usr/bin/env bash',
      'set -eu',
      `node_dir="$HOME/.openclaw/nodes/${gatewayInstanceKey}"`,
      'mkdir -p "$node_dir"',
      'echo $$ > "$node_dir/node-host.pid"',
      'child=""',
      'cleanup() {',
      '  if [ -n "${child:-}" ] && kill -0 "$child" 2>/dev/null; then',
      '    kill -TERM "$child" 2>/dev/null || true',
      '    sleep 2',
      '    kill -KILL "$child" 2>/dev/null || true',
      '  fi',
      '  rm -f "$node_dir/node-host.pid"',
      '}',
      'trap cleanup EXIT INT TERM',
      'max_session="${OPENCLAW_NODE_MAX_SESSION_SEC:-900}"',
      'while true; do',
      `  ${runCmd} &`,
      '  child=$!',
      '  started_at=$(date +%s)',
      '  while kill -0 "$child" 2>/dev/null; do',
      '    now=$(date +%s)',
      '    if [[ "$max_session" =~ ^[0-9]+$ ]] && [ "$max_session" -gt 0 ] && [ $((now - started_at)) -ge "$max_session" ]; then',
      '      kill -TERM "$child" 2>/dev/null || true',
      '      sleep 2',
      '      kill -KILL "$child" 2>/dev/null || true',
      '      break',
      '    fi',
      '    sleep 5',
      '  done',
      '  wait "$child" 2>/dev/null || true',
      '  child=""',
      '  sleep 5',
      'done',
      'NODEBG',
      'chmod +x "$runner_file"',
      'nohup bash "$runner_file" > "$log_file" 2>&1 </dev/null &',
      `echo "✅ Node Started in background (multi-gateway isolation mode), log: ${nodeLogPathDisplay}"`,
      `echo "🛑 Stop current gateway: ${nodeStopCmd}"`
    ].join('\n');
    const windowsRunner = [
      `$d = Join-Path $env:USERPROFILE ".openclaw\\nodes\\${gatewayInstanceKey}"`,
      'if (!(Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }',
      '$pidFile = Join-Path $d "node-host.pid"',
      '$runnerFile = Join-Path $d "node-host-runner.ps1"',
      '$logFile = Join-Path $d "node-host.log"',
      '$errLogFile = Join-Path $d "node-host.stderr.log"',
      'if (Test-Path $pidFile) {',
      '  try { $oldPid = [int](Get-Content $pidFile -ErrorAction Stop | Select-Object -First 1); Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue } catch {}',
      '}',
      `$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "^(powershell|pwsh)(\\.exe)?$" -and $_.CommandLine -match "node-host-runner\\.ps1" -and $_.CommandLine -match [regex]::Escape("${gatewayInstanceKey}") }`,
      'foreach ($proc in @($existing)) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }',
      `$runner = @'\n$ErrorActionPreference = "Continue"\n$d = Join-Path $env:USERPROFILE ".openclaw\\nodes\\${gatewayInstanceKey}"\nif (!(Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }\n$pidFile = Join-Path $d "node-host.pid"\n$logFile = Join-Path $d "node-host.log"\n$errLogFile = Join-Path $d "node-host.stderr.log"\n$myPid = [System.Diagnostics.Process]::GetCurrentProcess().Id\nSet-Content -Path $pidFile -Value $myPid -Encoding ASCII\nfunction Resolve-OpenClawCommand {\n  $candidates = @('openclaw.cmd', 'openclaw.exe', 'openclaw')\n  foreach ($candidate in $candidates) {\n    try {\n      $cmd = Get-Command $candidate -ErrorAction Stop | Select-Object -First 1\n      if ($cmd -and $cmd.Source) { return $cmd.Source }\n    } catch {}\n  }\n  $fallbacks = @(\n    (Join-Path $env:APPDATA 'npm\\openclaw.cmd'),\n    (Join-Path $env:APPDATA 'npm\\openclaw.exe'),\n    (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs\\openclaw.cmd'),\n    (Join-Path $env:ProgramFiles 'nodejs\\openclaw.cmd')\n  )\n  foreach ($path in $fallbacks) {\n    if ($path -and (Test-Path $path)) { return $path }\n  }\n  throw 'openclaw CLI not found in PATH or common Windows install paths'\n}\nif ($env:OPENCLAW_NODE_MAX_SESSION_SEC) { $maxSession = [int]$env:OPENCLAW_NODE_MAX_SESSION_SEC } else { $maxSession = 900 }\nwhile ($true) {\n  try {\n    ${tlsMode.disableVerify ? "$env:NODE_TLS_REJECT_UNAUTHORIZED='0'\n    " : ''}$env:OPENCLAW_GATEWAY_TOKEN='${token}'\n    try {\n      $openclawCmd = Resolve-OpenClawCommand\n      $proc = Start-Process -FilePath $openclawCmd -ArgumentList 'node','run','--host','${host}','--port','${gatewayTlsPort}','--tls' -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errLogFile\n    } catch {\n      Add-Content -Path $errLogFile -Value ("[{0}] start failed: {1}" -f (Get-Date -Format s), $_.Exception.Message)\n      Start-Sleep 5\n      continue\n    }\n    $startedAt = Get-Date\n    while (-not $proc.HasExited) {\n      if ($maxSession -gt 0 -and ((Get-Date) - $startedAt).TotalSeconds -ge $maxSession) {\n        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue\n        break\n      }\n      Start-Sleep 5\n      $proc.Refresh()\n    }\n    Add-Content -Path $errLogFile -Value ("[{0}] exited code={1}, reconnecting..." -f (Get-Date -Format s), $proc.ExitCode)\n  } catch {\n    try { Add-Content -Path $errLogFile -Value ("[{0}] runner error: {1}" -f (Get-Date -Format s), $_.Exception.Message) } catch {}\n  }\n  Start-Sleep 5\n}\n'@`,
      'Set-Content -Path $runnerFile -Value $runner -Encoding UTF8',
      // Register Scheduled Task for auto-recovery on logon (schtasks works without admin)
      `$taskName = 'OpenClawNode_${gatewayInstanceKey.slice(0, 20)}'`,
      'schtasks /Delete /TN $taskName /F 2>$null',
      'try { schtasks /Create /TN $taskName /TR ("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `\"" + $runnerFile + "`\"") /SC ONLOGON /RL LIMITED /F 2>&1 | Out-Null; $taskOk = $true } catch { $taskOk = $false }',
      'if (-not $taskOk) { Write-Host "⚠️ Scheduled task registration failed, background process still running but requires manual restart after reboot" }',
      // Start the runner now
      `Start-Process -FilePath powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$runnerFile | Out-Null`,
      `Write-Host "✅ Node Started in background (multi-gateway isolation mode), log: ${nodeLogPathWindowsDisplay}"`,
      `Write-Host "⚠️ Error log: ${nodeDirWindowsDisplay}\\node-host.stderr.log"`,
      'if ($taskOk) { Write-Host "📌 Registered scheduled task \'$taskName\'，auto-starts on login" }',
      `Write-Host "🛑 Stop current gateway: ${nodeStopCmdWindows}"`
    ].join('\n');

    const command = `${initCmd}\n${runCmd}`;

    const bgCmd = `${initCmd}\n${bashRunner}`;

    // Windows PowerShell: equivalent command
    const commandWindows = `$d = "$env:USERPROFILE\\.openclaw"; if (!(Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }; '{"tools":{"exec":{"security":"${execSecurity}"}}}' | Set-Content "$d\\openclaw.json" -Encoding UTF8\n${tlsEnvWindows}$env:OPENCLAW_GATEWAY_TOKEN='${token}'; openclaw node run --host ${host} --port ${gatewayTlsPort} --tls`;

    const bgCmdWindows = `$d = "$env:USERPROFILE\\.openclaw"; if (!(Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }; '{"tools":{"exec":{"security":"${execSecurity}"}}}' | Set-Content "$d\\openclaw.json" -Encoding UTF8\n${windowsRunner}`;

    res.json({ success: true, command, commandWindows, bgCmd, bgCmdWindows, hasToken: true, host, port: gatewayTlsPort, tlsNote: tlsMode.note, tlsBypass: tlsMode.disableVerify, gatewayInstanceKey, nodeBgDir: nodeDirDisplay, nodeBgLogPath: nodeLogPathDisplay, nodeBgStopCmd: nodeStopCmd, nodeBgDirWindows: nodeDirWindowsDisplay, nodeBgLogPathWindows: nodeLogPathWindowsDisplay, nodeBgStopCmdWindows: nodeStopCmdWindows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/node/security — Get security config
app.get('/api/node/security', (req, res) => {
  try {
    const cfg = readJson(CONFIG_PATH, {});
    const autoApprove = cfg?.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true;
    const browserMode = cfg?.gateway?.nodes?.browser?.mode || 'auto';
    const denyCommands = cfg?.gateway?.nodes?.denyCommands || [];
    const execSecurity = cfg?.tools?.exec?.security || 'full';
    res.json({ success: true, autoApprove, browserMode, denyCommands, execSecurity });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/node/security — Save security config
app.post('/api/node/security', (req, res) => {
  try {
    const { autoApprove, browserMode, denyCommands, execSecurity } = req.body || {};
    const cfg = readJson(CONFIG_PATH, {});

    // auto-approve
    if (typeof autoApprove === 'boolean') {
      if (!cfg.gateway) cfg.gateway = {};
      if (!cfg.gateway.controlUi) cfg.gateway.controlUi = {};
      cfg.gateway.controlUi.dangerouslyDisableDeviceAuth = autoApprove;
    }

    // browser mode
    if (browserMode === 'auto' || browserMode === 'off') {
      if (!cfg.gateway) cfg.gateway = {};
      if (!cfg.gateway.nodes) cfg.gateway.nodes = {};
      if (!cfg.gateway.nodes.browser) cfg.gateway.nodes.browser = {};
      cfg.gateway.nodes.browser.mode = browserMode;
    }

    // deny commands
    if (Array.isArray(denyCommands)) {
      if (!cfg.gateway) cfg.gateway = {};
      if (!cfg.gateway.nodes) cfg.gateway.nodes = {};
      cfg.gateway.nodes.denyCommands = denyCommands.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim());
    }

    // exec security
    if (execSecurity === 'allowlist' || execSecurity === 'deny' || execSecurity === 'full') {
      if (!cfg.tools) cfg.tools = {};
      if (!cfg.tools.exec) cfg.tools.exec = {};
      cfg.tools.exec.security = execSecurity;
    }

    writeOpenClawConfig(cfg);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/node/unpair — Unpair
app.post('/api/node/unpair', async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ success: false, error: 'Missing deviceId' });
    if (!/^[0-9a-fA-F-]{8,64}$/.test(deviceId)) return res.status(400).json({ success: false, error: 'Invalid deviceId format' });

    const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
    if (!paired[deviceId]) return res.status(404).json({ success: false, error: 'Device not found' });

    let removedViaGateway = false;
    let gatewayError = null;
    let client = null;
    try {
      client = await createGatewayControlUiClient(5000);
      await client.request('device.pair.remove', { deviceId }, 5000);
      removedViaGateway = true;
    } catch (err) {
      gatewayError = err;
    } finally {
      try { client?.close(); } catch {}
    }

    if (!removedViaGateway) {
      delete paired[deviceId];
      fs.writeFileSync(DEVICE_PAIRING_PAIRED_PATH, JSON.stringify(paired, null, 2));
      console.warn(`[node][unpair] gateway remove failed, fallback to paired.json deviceId=${deviceId}: ${String(gatewayError?.message || gatewayError || 'unknown error')}`);
    }

    console.log(`[node][unpair] deviceId=${deviceId} via=${removedViaGateway ? 'gateway' : 'file'}`);
    res.json({ success: true, disconnected: removedViaGateway || undefined });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Gateway WebSocket — query node online status ---
// Prefer real device identity control-ui identity connection and call node.list
// Fall back to cli identity on failure, detect node online via presence snapshot
function normalizeNodePresenceKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function collectGatewayNodeLookupKeys(node) {
  const keys = new Set();
  for (const candidate of [
    node?.displayName,
    node?.clientId,
    node?.host,
    node?.instanceId,
    node?.deviceId,
    node?.nodeId
  ]) {
    const key = normalizeNodePresenceKey(candidate);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

function reconcileGatewayNodeListWithPresence(nodes, presenceNodes) {
  if (!Array.isArray(nodes)) return Array.isArray(presenceNodes) ? presenceNodes : nodes;
  if (!Array.isArray(presenceNodes)) return nodes;
  if (presenceNodes.length === 0) {
    return nodes.map((node) => ({
      ...node,
      _presenceConfirmed: false,
      _fromPresence: Boolean(node?._fromPresence)
    }));
  }

  const presenceByName = new Map();
  for (const presenceNode of presenceNodes) {
    for (const key of collectGatewayNodeLookupKeys(presenceNode)) {
      presenceByName.set(key, presenceNode);
    }
  }

  const merged = [];
  const seenPresenceKeys = new Set();
  for (const node of nodes) {
    const keys = collectGatewayNodeLookupKeys(node);
    const presenceNode = keys.map((key) => presenceByName.get(key)).find(Boolean) || null;
    for (const key of keys) {
      if (presenceByName.has(key)) seenPresenceKeys.add(key);
    }
    merged.push({
      ...node,
      _presenceConfirmed: Boolean(presenceNode),
      _fromPresence: Boolean(node?._fromPresence)
    });
  }

  for (const presenceNode of presenceNodes) {
    const keys = collectGatewayNodeLookupKeys(presenceNode);
    if (!keys.length || keys.every((key) => seenPresenceKeys.has(key))) continue;
    merged.push(presenceNode);
  }

  return merged;
}

// Rate limit backoff for gateway WS auth failures to prevent triggering gateway rate limiter
let _gwAuthBackoff = { failCount: 0, backoffUntil: 0 };
let _gwProxyWsRateMap = new Map();

function queryGatewayNodeList(timeoutMs = 5000) {
  // Skip WS auth if in backoff period (fall back to CLI directly)
  if (_gwAuthBackoff.backoffUntil > Date.now()) {
    const cfg = readDockerConfig();
    const gatewayPort = Number(cfg.port || 18789) || 18789;
    const token = getGatewayAuthToken();
    return queryGatewayNodeListFallback(gatewayPort, token, timeoutMs);
  }

  return new Promise((resolve) => {
    const WsClient = require('ws');
    const cfg = readDockerConfig();
    const gatewayPort = Number(cfg.port || 18789) || 18789;
    const token = getGatewayAuthToken();
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };

    let ws;
    try {
      ws = new WsClient(`ws://127.0.0.1:${gatewayPort}`, {
        headers: { Origin: 'http://127.0.0.1' }
      });
    } catch (e) { logNodeGatewaySocketIssue('[node] WS connect failed:', e, gatewayPort); finish(null); return; }

    const timer = setTimeout(() => { console.log('[node] queryGatewayNodeList timeout'); finish(null); try { ws.close(); } catch {} }, timeoutMs);
    let usedFallback = false;
    ws.on('close', () => { if (!usedFallback) { clearTimeout(timer); finish(null); } });
    ws.on('error', (e) => { logNodeGatewaySocketIssue('[node] WS error:', e, gatewayPort); if (!usedFallback) { clearTimeout(timer); finish(null); } try { ws.close(); } catch {} });

    let connectId, listId;
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        // 1) connect.challenge → Attempt control-ui connection with device identity
        if (msg.event === 'connect.challenge') {
          const nonce = typeof msg.payload?.nonce === 'string' ? msg.payload.nonce.trim() : '';
          const connectParams = buildControlUiConnectParams(nonce);
          if (!connectParams) {
            logRateLimited('node-control-ui-identity-unavailable-fallback', 300000, '[node] control-ui identity unavailable → cli fallback');
            usedFallback = true;
            try { ws.close(); } catch {}
            queryGatewayNodeListFallback(gatewayPort, token, timeoutMs - 1000).then(v => { clearTimeout(timer); finish(v); });
            return;
          }
          connectId = crypto.randomUUID();
          ws.send(JSON.stringify({
            type: 'req', id: connectId, method: 'connect',
            params: connectParams
          }));
          return;
        }
        // 2) connect response
        if (msg.id === connectId) {
          if (msg.ok) {
            // control-ui connection succeeded → call node.list
            _gwAuthBackoff = { failCount: 0, backoffUntil: 0 };
            listId = crypto.randomUUID();
            ws.send(JSON.stringify({ type: 'req', id: listId, method: 'node.list', params: {} }));
          } else {
            // control-ui rejected → backoff to prevent triggering gateway rate limiter
            const errCode = msg.error?.code || msg.error?.message || 'unknown';
            _gwAuthBackoff.failCount++;
            const backoffSec = Math.min(300, 10 * Math.pow(2, _gwAuthBackoff.failCount - 1));
            _gwAuthBackoff.backoffUntil = Date.now() + backoffSec * 1000;
            logNodeProbeDebug(`[node] control-ui rejected: ${errCode} → cli fallback (backoff ${backoffSec}s)`);
            usedFallback = true;
            try { ws.close(); } catch {}
            queryGatewayNodeListFallback(gatewayPort, token, timeoutMs - 1000).then(v => { clearTimeout(timer); finish(v); });
          }
          return;
        }
        // 3) node.list response
        if (msg.id === listId) {
          if (msg.ok) {
            const nodes = Array.isArray(msg.payload?.nodes) ? msg.payload.nodes : null;
            usedFallback = true;
            try { ws.close(); } catch {}
            queryGatewayNodeListFallback(gatewayPort, token, timeoutMs - 1000).then((presenceNodes) => {
              clearTimeout(timer);
              finish(reconcileGatewayNodeListWithPresence(nodes, presenceNodes));
            });
          } else {
            logNodeProbeDebug('[node] node.list failed:', msg.error?.code || 'unknown', '→ cli fallback');
            usedFallback = true;
            try { ws.close(); } catch {}
            queryGatewayNodeListFallback(gatewayPort, token, timeoutMs - 1000).then(v => { clearTimeout(timer); finish(v); });
          }
        }
      } catch {}
    });
  });
}

// Fallback: cli identity connection, infer node online from presence snapshot (no scopes needed)
function queryGatewayNodeListFallback(gatewayPort, token, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    const timer = setTimeout(() => { finish(null); try { ws.close(); } catch {} }, Math.max(timeoutMs, 2000));

    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}`);
    } catch { clearTimeout(timer); finish(null); return; }

    ws.onclose = () => { clearTimeout(timer); finish(null); };
    ws.onerror = () => { clearTimeout(timer); finish(null); try { ws.close(); } catch {} };

    let connectId;
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.event === 'connect.challenge') {
          connectId = crypto.randomUUID();
          ws.send(JSON.stringify({
            type: 'req', id: connectId, method: 'connect',
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: 'cli', version: '1.0', platform: 'linux', mode: 'backend' },
              caps: [], role: 'operator', scopes: [],
              auth: { token: token || undefined }
            }
          }));
          return;
        }
        if (msg.id === connectId) {
          clearTimeout(timer);
          if (!msg.ok) { logNodeProbeDebug('[node] cli fallback connect failed:', msg.error?.code); finish(null); try { ws.close(); } catch {} return; }
          // Extract mode=node, reason=connect entries from presence snapshot
          const presence = msg.payload?.snapshot?.presence || [];
          const nodePresence = presence.filter(p => p.mode === 'node' && p.reason === 'connect');
          logNodeProbeDebug('[node] cli fallback presence:', presence.length, 'total,', nodePresence.length, 'nodes');
          // Convert to node.list compatible format (presence only has host/mode/platform, no nodeId)
          const nodes = nodePresence.map(p => ({
            displayName: p.host || '',
            platform: p.platform || 'unknown',
            connected: true,
            _fromPresence: true
          }));
          finish(nodes.length > 0 ? nodes : []);
          try { ws.close(); } catch {}
        }
      } catch {}
    };
  });
}

function normalizeNodeStatusSnapshot(raw) {
  const snapshot = raw && typeof raw === 'object' ? raw : {};
  const nodes = snapshot.nodes && typeof snapshot.nodes === 'object' ? snapshot.nodes : {};
  return {
    checkedAt: Number(snapshot.checkedAt || 0),
    lastSuccessAt: Number(snapshot.lastSuccessAt || 0),
    gatewayPid: Number(snapshot.gatewayPid || 0),
    gatewayStartedAtMs: Number(snapshot.gatewayStartedAtMs || 0),
    nodes,
  };
}

function shouldAcceptGatewayNodeConnection(gwNode, gatewayInfo, previousGatewayPid, now) {
  if (!gwNode || gwNode.connected !== true) return false;

  const gatewayStartedAtMs = Number(gatewayInfo?.startedAtMs || 0);
  const gatewayPid = Number(gatewayInfo?.pid || 0);
  const priorGatewayPid = Number(previousGatewayPid || 0);
  const connectedAtMs = Number(gwNode?.connectedAtMs || 0);
  const freshCutoffMs = gatewayStartedAtMs > 0 ? Math.max(0, gatewayStartedAtMs - 2000) : 0;
  const gatewayPidChanged = gatewayPid > 0 && priorGatewayPid > 0 && gatewayPid !== priorGatewayPid;
  const gatewayRecentlyRestarted = gatewayStartedAtMs > 0 && (now - gatewayStartedAtMs) < NODE_STATUS_GATEWAY_RECONNECT_GRACE_MS;

  if (connectedAtMs > 0 && freshCutoffMs > 0) {
    return connectedAtMs >= freshCutoffMs;
  }

  if (gatewayPidChanged || gatewayRecentlyRestarted) {
    return false;
  }

  // Presence-only fallback nodes do not carry nodeId/connectedAtMs. Treat them as
  // online once the gateway process is stable; otherwise remote nodes appear
  // permanently offline whenever control-ui node.list is unavailable.
  if (gwNode?._fromPresence === true && !gwNode?.nodeId) {
    return true;
  }

  return true;
}

let nodeStatusSnapshot = normalizeNodeStatusSnapshot(readJson(NODE_STATUS_CACHE_PATH, {}));
let nodeStatusPollInFlight = null;

function saveNodeStatusSnapshot() {
  try {
    writeJsonFileAtomic(NODE_STATUS_CACHE_PATH, nodeStatusSnapshot, 0o600);
  } catch (e) {
    console.warn('[node] save node status snapshot failed:', e.message);
  }
}

async function refreshNodeStatusSnapshot(options = {}) {
  if (nodeStatusPollInFlight) return nodeStatusPollInFlight;
  nodeStatusPollInFlight = (async () => {
    const forceIpRefresh = options?.forceIpRefresh === true;
    const now = Date.now();
    try {
      const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
      const nodeEntries = Object.values(paired).filter(e => e.clientMode === 'node');
      const opState = getOpenClawOperationState();
      const gatewayInfo = await getGatewayRuntimeProcessInfo();
      const gwNodes = await queryGatewayNodeList(4000);
      const gwNodeMapById = new Map();
      const gwNodeMapByKey = new Map();
      if (Array.isArray(gwNodes)) {
        for (const n of gwNodes) {
          if (n.nodeId) gwNodeMapById.set(n.nodeId, n);
          for (const key of collectGatewayNodeLookupKeys(n)) {
            gwNodeMapByKey.set(key, n);
          }
        }
      }

      const nextNodes = {};
      for (const entry of nodeEntries) {
        const prev = nodeStatusSnapshot.nodes?.[entry.deviceId] || {};
        const gwNode = gwNodeMapById.get(entry.deviceId) ||
                       gwNodeMapByKey.get(normalizeNodePresenceKey(entry.deviceId)) ||
                       gwNodeMapByKey.get(normalizeNodePresenceKey(entry.displayName)) ||
                       gwNodeMapByKey.get(normalizeNodePresenceKey(entry.clientId));
        const connectedSource = gwNode?._fromPresence ? 'presence' : (gwNode ? 'node.list' : 'none');
        const connected = opState?.type === 'restarting_gateway'
          ? false
          : shouldAcceptGatewayNodeConnection(gwNode, gatewayInfo, nodeStatusSnapshot.gatewayPid, now);
        const connectedAtMs = connected
          ? (gwNode?.connectedAtMs || (prev.connected ? Number(prev.connectedAtMs || 0) : now) || now)
          : Number(prev.connectedAtMs || 0);
        const offlineAtMs = connected
          ? Number(prev.offlineAtMs || 0)
          : (prev.connected ? now : Number(prev.offlineAtMs || 0));
        let ipAddress = String(prev.ipAddress || '').trim();
        if (connected) {
          // Prefer gateway-reported remoteIp (most reliable: actual TCP connection IP)
          const gwRemoteIp = String(gwNode?.remoteIp || '').trim();
          if (gwRemoteIp && gwRemoteIp !== '127.0.0.1' && !gwRemoteIp.startsWith('::')) {
            ipAddress = gwRemoteIp;
          } else {
            const shouldRefreshIp = forceIpRefresh || !prev.connected || !ipAddress;
            if (shouldRefreshIp && gwNode?.nodeId) {
              const refreshedIp = await fetchNodeIpv4Address(gwNode.nodeId, gwNode?.platform || entry.platform || '');
              ipAddress = String(refreshedIp || prev.ipAddress || '').trim();
            }
          }
        }
        nextNodes[entry.deviceId] = {
          deviceId: entry.deviceId,
          displayName: gwNode?.displayName || entry.displayName || entry.clientId || entry.deviceId?.slice(0, 12),
          platform: gwNode?.platform || entry.platform || 'unknown',
          connected,
          connectedAtMs,
          offlineAtMs,
          ipAddress,
          approvedAtMs: entry.approvedAtMs || 0,
          connectedSource,
          lastProbeAtMs: now,
          updatedAtMs: now,
        };
      }

      nodeStatusSnapshot = {
        checkedAt: now,
        lastSuccessAt: now,
        gatewayPid: Number(gatewayInfo.pid || 0),
        gatewayStartedAtMs: Number(gatewayInfo.startedAtMs || 0),
        nodes: nextNodes,
      };
      saveNodeStatusSnapshot();
      return nodeStatusSnapshot;
    } catch (e) {
      nodeStatusSnapshot.checkedAt = now;
      console.warn('[node] refresh snapshot failed:', e.message);
      return nodeStatusSnapshot;
    } finally {
      nodeStatusPollInFlight = null;
    }
  })();
  return nodeStatusPollInFlight;
}

setTimeout(() => { void refreshNodeStatusSnapshot(); }, 1500);
setInterval(() => { void refreshNodeStatusSnapshot(); }, NODE_STATUS_POLL_INTERVAL_MS);

// Auto-approve pending gateway pairing requests from webchat Control UI browsers
// This prevents the pairing flow from failing and triggering the gateway rate limiter
setInterval(() => {
  try {
    const pending = readJson(DEVICE_PAIRING_PENDING_PATH, {});
    const pendingEntries = Object.entries(pending).filter(([, p]) =>
      p && typeof p === 'object' && p.requestId && p.clientId === 'openclaw-control-ui' && p.clientMode === 'webchat'
    );
    if (!pendingEntries.length) return;
    const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
    const now = Date.now();
    for (const [, entry] of pendingEntries) {
      const deviceId = entry.deviceId;
      const existing = paired[deviceId] || {};
      const role = (entry.role || 'operator').trim() || 'operator';
      const fullScopes = Array.from(new Set([
        ...(existing.approvedScopes || existing.scopes || []),
        ...(entry.scopes || []),
        'operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'
      ]));
      const token = crypto.randomBytes(24).toString('hex');
      const existingTokens = existing.tokens && typeof existing.tokens === 'object' ? { ...existing.tokens } : {};
      existingTokens[role] = { token, role, scopes: fullScopes, createdAtMs: existingTokens[role]?.createdAtMs || now, rotatedAtMs: now };
      paired[deviceId] = {
        ...existing, deviceId,
        publicKey: entry.publicKey || existing.publicKey,
        displayName: entry.displayName || existing.displayName || 'Auto-approved Browser',
        platform: entry.platform || existing.platform,
        clientId: entry.clientId || existing.clientId,
        clientMode: entry.clientMode || existing.clientMode,
        role, roles: Array.from(new Set([...(existing.roles || []), ...(entry.roles || [role])])),
        scopes: fullScopes, approvedScopes: fullScopes, tokens: existingTokens,
        approvedAtMs: now, isRepair: false
      };
      delete pending[entry.requestId];
      console.log(`[pairing][auto-approve] webchat device ${deviceId.slice(0, 12)}... (${entry.platform || 'unknown'})`);
    }
    fs.writeFileSync(DEVICE_PAIRING_PENDING_PATH, JSON.stringify(pending, null, 2));
    fs.writeFileSync(DEVICE_PAIRING_PAIRED_PATH, JSON.stringify(paired, null, 2));
  } catch {}
}, 3000);

// GET /api/node/connected — Get connected remote device list
app.get('/api/node/connected', async (req, res) => {
  try {
    const accessPatch = ensureGatewayControlUiAccessForRequest(req);
    if (accessPatch?.changed) {
      console.log(`[node] controlUi access patched for host=${accessPatch.host || 'unknown'}`);
    }
    const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
    const nodeEntries = Object.values(paired).filter(e => e.clientMode === 'node');
    const snapshotAgeMs = Date.now() - Number(nodeStatusSnapshot.checkedAt || 0);
    const forceRefresh = String(req.query.force || '') === '1' || accessPatch?.changed === true;
    if (forceRefresh || !nodeStatusSnapshot.lastSuccessAt || snapshotAgeMs > NODE_STATUS_MAX_STALE_MS) {
      await refreshNodeStatusSnapshot({ forceIpRefresh: forceRefresh });
    }

    const nodes = nodeEntries.map(entry => {
      const cached = nodeStatusSnapshot.nodes?.[entry.deviceId] || {};
      return {
        deviceId: entry.deviceId,
        displayName: cached.displayName || entry.displayName || entry.clientId || entry.deviceId?.slice(0, 12),
        platform: cached.platform || entry.platform || 'unknown',
        connected: cached.connected === true,
        connectedAtMs: Number(cached.connectedAtMs || 0),
        offlineAtMs: Number(cached.offlineAtMs || 0),
        ipAddress: String(cached.ipAddress || '').trim(),
        approvedAtMs: entry.approvedAtMs || 0,
        connectedSource: cached.connectedSource || 'none',
      };
    });
    res.json({ success: true, nodes });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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
    const result = await runOpenClawCliWithPtyInput(command, '', 300000);
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
      const statusResult = await runOpenClawCli('openclaw models status --json 2>&1', 30000);
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
  if (!model) return res.status(400).json({ error: 'Model cannot be empty' });
  if (!/^[a-zA-Z0-9._/:\-]+$/.test(model)) return res.status(400).json({ error: 'Invalid model format' });

  const result = await runOpenClawCli(`openclaw models set "${model.replace(/"/g, '')}" 2>&1`, 60000);
  if (!result.ok) return res.status(500).json({ error: compactOutput(result.output) || 'Set model failed' });
  res.json({ success: true, output: compactOutput(result.output) });
});

app.post('/api/ai/auth/token', async (req, res) => {
  const provider = String(req.body?.provider || '').trim();
  const token = String(req.body?.token || '').trim();
  if (!provider || !/^[a-zA-Z0-9\-]+$/.test(provider)) return res.status(400).json({ error: 'Invalid provider' });
  if (!token) return res.status(400).json({ error: 'Token cannot be empty' });

  const command = `openclaw models auth paste-token --provider ${provider}`;
  const result = await runOpenClawCliWithPtyInput(command, token, 60000);
  if (!result.ok) return res.status(500).json({ error: compactOutput(result.output) || 'Save auth failed' });
  res.json({ success: true, output: compactOutput(result.output) });
});

app.post('/api/ai/auth/copilot/login', (req, res) => {
  const taskId = runAiAuthTask('openclaw models auth login-github-copilot', 'GitHub Copilot Login');
  res.json({ success: true, taskId });
});

// Generic OAuth login entry（Directly implement GitHub Device Flow, no CLI TTY dependency）
app.post('/api/ai/auth/oauth/login', async (req, res) => {
  const provider = String(req.body?.provider || '').trim();
  if (!provider || !/^[a-zA-Z0-9\-]+$/.test(provider)) {
    return res.status(400).json({ error: 'Invalid provider' });
  }

  if (provider === 'github-copilot') {
    // Directly implement GitHub Device Flow
    const taskId = Date.now().toString();
    aiAuthTasks[taskId] = { status: 'running', log: '', startedAt: Date.now(), seq: 0, chunks: [] };
    const task = aiAuthTasks[taskId];
    appendAiTaskLog(task, `[ai] GitHub Copilot Device Auth\n`);

    // Async execute device flow
    (async () => {
      try {
        const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
        const DEVICE_CODE_URL = 'https://github.com/login/device/code';
        const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

        // Step 1: Request device code
        appendAiTaskLog(task, '[ai] Requesting GitHub device code...\n');
        const dcRes = await fetch(DEVICE_CODE_URL, {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
          signal: AbortSignal.timeout(30000)
        });
        if (!dcRes.ok) throw new Error(`GitHub device code request failed: HTTP ${dcRes.status}`);
        const dcData = await dcRes.json();
        if (!dcData.device_code || !dcData.user_code || !dcData.verification_uri) {
          throw new Error('GitHub device code response missing required fields');
        }

        appendAiTaskLog(task, `\nPlease open in browser: ${dcData.verification_uri}\n`);
        appendAiTaskLog(task, `Enter authorization code: ${dcData.user_code}\n\n`);
        appendAiTaskLog(task, `[ai] Waiting for user to complete GitHub authorization...\n`);

        // Step 2: Poll for authorization
        const expiresAt = Date.now() + (dcData.expires_in || 900) * 1000;
        const intervalMs = Math.max(5000, (dcData.interval || 5) * 1000);
        let accessToken = null;

        while (Date.now() < expiresAt) {
          await new Promise(r => setTimeout(r, intervalMs));
          try {
            const tokenRes = await fetch(ACCESS_TOKEN_URL, {
              method: 'POST',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: CLIENT_ID,
                device_code: dcData.device_code,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
              }),
              signal: AbortSignal.timeout(30000)
            });
            const tokenData = await tokenRes.json();
            if (tokenData.access_token) {
              accessToken = tokenData.access_token;
              break;
            }
            if (tokenData.error === 'authorization_pending') continue;
            if (tokenData.error === 'slow_down') {
              await new Promise(r => setTimeout(r, 5000));
              continue;
            }
            if (tokenData.error === 'expired_token') {
              throw new Error('Device code expired, please restart authorization');
            }
            if (tokenData.error === 'access_denied') {
              throw new Error('User cancelled authorization');
            }
            if (tokenData.error) {
              throw new Error(`GitHub OAuth error: ${tokenData.error}`);
            }
          } catch (pollErr) {
            if (pollErr.message?.includes('Device code expired') || pollErr.message?.includes('cancel')) throw pollErr;
            appendAiTaskLog(task, `[ai] Polling error: ${pollErr.message}, continuing to wait...\n`);
          }
        }

        if (!accessToken) throw new Error('Authorization timeout，Device code expired');

        appendAiTaskLog(task, '[ai] GitHub access token obtained successfully!\n');

        // Step 3: Save to auth-profiles.json (openclaw format compatible)
        const authProfiles = readAiAuthProfiles();
        saveCanonicalCopilotAuthProfile(authProfiles, accessToken);
        writeAiAuthProfiles(authProfiles);
        appendAiTaskLog(task, '[ai] Auth info saved to auth-profiles.json\n');

        // Step 4: Ensure models.json has github-copilot provider entry
        const modelsData = readAiModels();
        const copilotBaseUrl = await resolveCopilotProviderBaseUrl(accessToken);
        if (!modelsData.providers['github-copilot']) {
          modelsData.providers['github-copilot'] = {
            baseUrl: copilotBaseUrl,
            apiKey: accessToken,
            api: 'github-copilot',
            models: []
          };
        } else {
          modelsData.providers['github-copilot'].apiKey = accessToken;
          modelsData.providers['github-copilot'].baseUrl = copilotBaseUrl;
          modelsData.providers['github-copilot'].api = 'github-copilot';
        }
        writeAiModels(modelsData);
        appendAiTaskLog(task, '[ai] Updated github-copilot config in models.json\n');

        // Step 5: Sync models.providers in openclaw.json (ensure gateway can recognize)
        const configPath = '/root/.openclaw/openclaw.json';
        let ocConfig = {};
        try { ocConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { ocConfig = {}; }
        if (!ocConfig.models) ocConfig.models = {};
        if (!ocConfig.models.providers) ocConfig.models.providers = {};
        if (!ocConfig.models.providers['github-copilot']) {
          ocConfig.models.providers['github-copilot'] = {
            baseUrl: copilotBaseUrl,
            api: 'github-copilot',
            models: []
          };
        }
        ocConfig.models.providers['github-copilot'].baseUrl = copilotBaseUrl;
        ocConfig.models.providers['github-copilot'].api = 'github-copilot';
        // Note: apiKey not written in openclaw.json (token auth exchanged by gateway internally)
        writeOpenClawConfig(ocConfig);
        appendAiTaskLog(task, '[ai] Synced github-copilot provider in openclaw.json\n');

        task.status = 'success';
        task.exitCode = 0;
        appendAiTaskLog(task, '[ai] GitHub Copilot authorization complete ✓\n');
      } catch (err) {
        appendAiTaskLog(task, `[ai] Authorization failed: ${err.message}\n`);
        task.status = 'failed';
        task.exitCode = 1;
      }
      // Clean up old tasks
      const keys = Object.keys(aiAuthTasks).sort();
      while (keys.length > 8) delete aiAuthTasks[keys.shift()];
    })();

    return res.json({ success: true, taskId });
  }

  // Other non-copilot OAuth providers still use CLI
  const command = `openclaw models auth login --provider ${provider}`;
  const taskId = runAiAuthTask(command, `${provider} OAuth login`);
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
// API: AI Config (New)
// ============================================================

// Read AI config
app.get('/api/ai/config', async (req, res) => {
  try {
    const configPath = '/root/.openclaw/openclaw.json';
    // Read main config
    let config = {};
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch {
      config = {};
    }

    // Read models.json to get provider list
    const models = readAiModels();

    // Read auth-profiles.json
    const authProfiles = readAiAuthProfiles();

    const providers = new Set(Object.keys(models?.providers || {}));
    for (const [, profile] of Object.entries(authProfiles.profiles || {})) {
      if (profile?.provider) providers.add(profile.provider);
    }
    for (const [key, profile] of Object.entries(authProfiles || {})) {
      if (!AUTH_PROFILE_META_KEYS.has(key) && profile?.provider) providers.add(profile.provider);
    }

    // Build configuredKeys array (supports multiple keys per provider)
    const configuredKeys = [];
    const configuredKeySignatures = new Set();

    // Iterate auth-profiles.profiles to find all keys (supports multi-key: provider, provider:2, provider:3 etc.)
    const profiles = authProfiles.profiles || {};
    for (const [profileId, profile] of Object.entries(profiles)) {
      if (!profile || !profile.provider) continue;
      const pName = profile.provider;
      const prov = models.providers?.[pName] || {};

      const isApiKey = profile.mode === 'api_key' || profile.type === 'api_key';
      const isToken = profile.mode === 'token' || profile.type === 'token';
      const isOAuth = profile.mode === 'oauth' || profile.mode === 'device' || isToken;
      const rawKey = getAuthProfileSecret(profile);
      const hasKey = !!rawKey && rawKey !== 'YOUR_API_KEY';
      const signature = buildConfiguredKeySignature(pName, isOAuth ? 'oauth' : 'apikey', getAuthProfileIdentity(profile));

      if ((hasKey || isOAuth) && !configuredKeySignatures.has(signature)) {
        // Check if this key is the currently active one (matches apiKey in models.json)
        const activeKey = prov?.apiKey || '';
        const isActive = isApiKey ? (rawKey === activeKey) : true;

        configuredKeys.push({
          id: profileId,
          provider: pName,
          keyMasked: isApiKey ? maskApiKey(rawKey) : (isOAuth ? 'OAuth authorized' : ''),
          baseUrl: prov?.baseUrl || getDefaultBaseUrl(pName) || '',
          authType: isOAuth ? 'oauth' : 'apikey',
          models: (prov?.models || []).map(m => m.id || m),
          isActive
        });
        configuredKeySignatures.add(signature);
      }
    }

    // Also check legacy top-level entries and providers with keys in models.json but not in profiles
    for (const pName of providers) {
      const prov = models.providers[pName];
      const rawKey = prov?.apiKey || '';
      const hasKey = !!rawKey && rawKey !== 'YOUR_API_KEY';

      // Check if already overridden by profiles
      const alreadyHasProfile = configuredKeys.some(k => k.provider === pName);
      if (alreadyHasProfile) continue;

      // Check legacy auth-profiles top-level entries
      const topLevelProfile = authProfiles[pName];
      const isTopOAuth = topLevelProfile?.mode === 'oauth' || topLevelProfile?.mode === 'device' || topLevelProfile?.mode === 'token';
      const signature = buildConfiguredKeySignature(pName, isTopOAuth ? 'oauth' : 'apikey', getAuthProfileIdentity(topLevelProfile));

      if ((hasKey || isTopOAuth) && !configuredKeySignatures.has(signature)) {
        configuredKeys.push({
          id: pName,
          provider: pName,
          keyMasked: hasKey ? maskApiKey(rawKey) : (isTopOAuth ? 'OAuth authorized' : ''),
          baseUrl: prov?.baseUrl || getDefaultBaseUrl(pName) || '',
          authType: isTopOAuth ? 'oauth' : 'apikey',
          models: (prov?.models || []).map(m => m.id || m),
          isActive: true
        });
        configuredKeySignatures.add(signature);
      }
    }

    // --- Auto-clean orphaned model references (clear model config when provider has no valid key) ---
    const validProviders = new Set(configuredKeys.map(k => k.provider));
    const isOrphan = (modelStr) => {
      if (!modelStr) return false;
      const p = String(modelStr).split('/')[0];
      return p && !validProviders.has(p);
    };

    let configDirty = false;
    const defaults = config?.agents?.defaults || {};

    // Clean primary model
    if (defaults.model?.primary && isOrphan(defaults.model.primary)) {
      console.log(`[ai/config] Auto-clean orphaned primary model: ${defaults.model.primary}`);
      defaults.model.primary = '';
      configDirty = true;
    }

    // Clean primary fallbacks
    if (Array.isArray(defaults.model?.fallbacks)) {
      const before = defaults.model.fallbacks.length;
      defaults.model.fallbacks = defaults.model.fallbacks.filter(m => !isOrphan(m));
      if (defaults.model.fallbacks.length < before) {
        console.log(`[ai/config] Auto-clean ${before - defaults.model.fallbacks.length} orphaned primary fallback(s)`);
        configDirty = true;
      }
    }

    // Clean illegal subModel/subModelFallbacks keys (not in openclaw schema)
    if ('subModel' in defaults) {
      console.log(`[ai/config] Removing invalid key agents.defaults.subModel: ${defaults.subModel}`);
      delete defaults.subModel;
      configDirty = true;
    }
    if ('subModelFallbacks' in defaults) {
      console.log(`[ai/config] Removing invalid key agents.defaults.subModelFallbacks`);
      delete defaults.subModelFallbacks;
      configDirty = true;
    }

    // Clean subagents.model (correct path)
    const subagentModel = defaults.subagents?.model;
    if (subagentModel) {
      const subModelStr = typeof subagentModel === 'string' ? subagentModel : subagentModel?.primary;
      if (subModelStr && isOrphan(subModelStr)) {
        console.log(`[ai/config] Auto-clean orphaned subagent model: ${subModelStr}`);
        delete defaults.subagents.model;
        configDirty = true;
      }
    }

    // Write back cleaned config (auto-clean invalid keys)
    if (configDirty) {
      try {
        writeOpenClawConfig(config);
        console.log('[ai/config] Wrote back cleaned config to openclaw.json');
      } catch (writeErr) {
        console.error('[ai/config] Failed to write cleaned config:', writeErr.message);
      }
    }

    // Parse default model (cleaned values)
    const primaryModel = defaults.model?.primary || '';
    const provider = primaryModel.split('/')[0] || (validProviders.size > 0 ? [...validProviders][0] : 'anthropic');

    // Parse fallbacks (cleaned values)
    const modelFallbacks = defaults.model?.fallbacks || [];
    // Parse subagents.model fallbacks
    const rawSubModel = defaults.subagents?.model;
    const subFallbacks = (rawSubModel && typeof rawSubModel === 'object' && Array.isArray(rawSubModel.fallbacks))
      ? rawSubModel.fallbacks : [];
    const fallbackObj = {
      primary: Array.isArray(modelFallbacks) ? modelFallbacks : [],
      sub: subFallbacks
    };

    // Parse subagents.model (correct path)
    const subModel = typeof rawSubModel === 'string' ? rawSubModel : (rawSubModel?.primary || '');

    res.json({
      success: true,
      provider,
      defaultModel: primaryModel,
      subModel,
      fallbacks: fallbackObj,
      configuredKeys,
      configuredProviders: providers
    });
  } catch (err) {
    console.error('[ai/config] Error reading config:', err);
    res.status(500).json({ error: 'Failed to read config: ' + (err?.message || 'Unknown error') });
  }
});

// Save AI model config (models only; API keys via /api/ai/keys)
app.post('/api/ai/config', async (req, res) => {
  try {
    const { primaryModel, fallbacks, subModel } = req.body || {};

    if (!primaryModel) {
      return res.status(400).json({ error: 'Primary model cannot be empty' });
    }

    if (!primaryModel.includes('/')) {
      return res.status(400).json({ error: 'Model name format should be provider/model-id' });
    }

    const configPath = '/root/.openclaw/openclaw.json';
    const modelsPath = '/root/.openclaw/agents/main/agent/models.json';

    let config = {};
    let models = { providers: {} };

    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { config = {}; }

    try {
      models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
    } catch { models = { providers: {} }; }

    // ---- Validation: check if each model provider has a valid API Key / auth ----
    const authProfilesPath = '/root/.openclaw/agents/main/agent/auth-profiles.json';
    let authProfiles = {};
    try { authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf8')); } catch { authProfiles = {}; }

    // Collect all providers with valid keys
    const validProviders = new Set();
    const profiles = authProfiles.profiles || {};
    for (const [, profile] of Object.entries(profiles)) {
      if (!profile?.provider) continue;
      const rawKey = getAuthProfileSecret(profile);
      const hasKey = !!rawKey && rawKey !== 'YOUR_API_KEY';
      const isOAuth = profile.mode === 'oauth' || profile.mode === 'device' || profile.mode === 'token' || profile.type === 'token';
      if (hasKey || isOAuth) validProviders.add(profile.provider);
    }
    // Also check providers with valid keys directly configured in models.json
    for (const [pName, prov] of Object.entries(models.providers || {})) {
      const rawKey = prov?.apiKey || '';
      if (rawKey && rawKey !== 'YOUR_API_KEY') validProviders.add(pName);
      // Check legacy top-level auth-profiles
      const topProfile = authProfiles[pName];
      if (topProfile?.mode === 'oauth' || topProfile?.mode === 'device' || topProfile?.mode === 'token') {
        validProviders.add(pName);
      }
    }

    // Collect models already existing in config (skip validation for these)
    const existingModels = new Set();
    const curDefaults = config?.agents?.defaults || {};
    if (curDefaults.model?.primary) existingModels.add(curDefaults.model.primary);
    if (Array.isArray(curDefaults.model?.fallbacks)) curDefaults.model.fallbacks.forEach(m => m && existingModels.add(m));
    const curSub = curDefaults.subagents?.model;
    if (typeof curSub === 'string' && curSub) existingModels.add(curSub);
    if (curSub?.primary) existingModels.add(curSub.primary);
    if (Array.isArray(curSub?.fallbacks)) curSub.fallbacks.forEach(m => m && existingModels.add(m));

    // Collect all models to save this time
    const allModelsToSave = new Map();
    const addModelToSave = (model, role) => {
      if (!model) return;
      if (!allModelsToSave.has(model)) {
        allModelsToSave.set(model, { model, roles: new Set() });
      }
      allModelsToSave.get(model).roles.add(role);
    };
    if (primaryModel) addModelToSave(primaryModel, 'Primary model');
    if (subModel) addModelToSave(subModel, 'Sub-agent model');
    if (fallbacks) {
      const addFb = (arr, label) => {
        if (!Array.isArray(arr)) return;
        arr.filter(Boolean).forEach(m => addModelToSave(m, label));
      };
      if (Array.isArray(fallbacks)) {
        addFb(fallbacks, 'Primary Fallback');
      } else if (typeof fallbacks === 'object') {
        addFb(fallbacks.primary, 'Primary Fallback');
        addFb(fallbacks.sub, 'Sub-agent Fallback');
      }
    }

    // Validate each model
    const errors = [];
    const deferredValidationJobs = [];
    const deferredValidationModels = new Set();
    const catalogHitCache = new Map();
    const builtModelEntryCache = new Map();
    const getModelCacheKey = (provName, modId) => `${provName}/${modId}`;
    const getCachedCatalogHit = (provName, modId) => {
      const key = getModelCacheKey(provName, modId);
      if (!catalogHitCache.has(key)) {
        catalogHitCache.set(key, lookupModelCapabilities(provName, modId));
      }
      return catalogHitCache.get(key);
    };
    const getCachedModelEntry = (provName, modId) => {
      const key = getModelCacheKey(provName, modId);
      if (!builtModelEntryCache.has(key)) {
        builtModelEntryCache.set(key, buildModelEntry(provName, modId));
      }
      const cached = builtModelEntryCache.get(key);
      return cached ? { ...cached } : cached;
    };

    for (const { model, roles } of allModelsToSave.values()) {
      if (!model || !model.includes('/')) continue;
      const role = Array.from(roles).join(' / ');
      // Models already in current config skip validation
      if (existingModels.has(model)) continue;
      const [prov] = model.split('/');
      // Check if provider has a valid key
      if (!validProviders.has(prov)) {
        errors.push(`${role} "${model}" provider "${prov}" has no valid API Key configured or authorized, please add first`);
      }
      // Check if model is supported in catalog
      const [provName, modId] = model.split('/');
      const catalogHit = getCachedCatalogHit(provName, modId);

      if (!catalogHit) {
        // Not found at all - may be a new model or typo
        errors.push(`${role} "${model}" Not found in OpenClaw model catalog, verify model name`);
      } else if (catalogHit._catalogUnavailable) {
        // Model catalog not loaded (external catalog unavailable) - skip strict validation, allow save
        console.log(`[ai/config] ${model} Model catalog not loaded, skipping catalog validation`);
      } else if (catalogHit._inferred) {
        console.log(`[ai/config] ${model} Family match succeeded (${catalogHit._matchedFamily})，saving config first, deferred runtime validation later...`);
        const { apiKey: modelApiKey } = getModelValidationCredentials(provName, authProfiles);
        if (!modelApiKey || modelApiKey === 'YOUR_API_KEY') {
          errors.push(`${role} "${model}" requires runtime validation, but ${provName} has no valid API Key configured`);
        } else {
          deferredValidationJobs.push({
            model,
            providerName: provName,
            modelId: modId,
            matchedFamily: catalogHit._matchedFamily
          });
          deferredValidationModels.add(model);
        }
      }
      // Exact match succeeded - no extra validation needed
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('；') });
    }

    // ---- Update openclaw.json ----
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};

    // agents.defaults.model: { primary, fallbacks }
    const modelObj = { primary: primaryModel };
    if (fallbacks) {
      let fbArray = [];
      if (Array.isArray(fallbacks)) {
        fbArray = fallbacks;
      } else if (typeof fallbacks === 'object' && Array.isArray(fallbacks.primary)) {
        fbArray = fallbacks.primary;
      }
      if (fbArray.length > 0) {
        modelObj.fallbacks = fbArray;
      }
    }
    config.agents.defaults.model = modelObj;

    // subagents.model (correct path: agents.defaults.subagents.model)
    if (subModel) {
      if (!config.agents.defaults.subagents) config.agents.defaults.subagents = {};
      // Support fallbacks: if sub-agent fallback exists, write as { primary, fallbacks } object
      const subFbArray = (fallbacks && Array.isArray(fallbacks.sub)) ? fallbacks.sub.filter(Boolean) : [];
      if (subFbArray.length > 0) {
        config.agents.defaults.subagents.model = { primary: subModel, fallbacks: subFbArray };
      } else {
        config.agents.defaults.subagents.model = subModel;
      }
    }
    // Clean illegal top-level subModel/subModelFallbacks
    if (config.agents?.defaults?.subModel) delete config.agents.defaults.subModel;
    if (config.agents?.defaults?.subModelFallbacks) delete config.agents.defaults.subModelFallbacks;

    // Helper: ensure provider models array contains specified model entry
    // Use OpenClaw built-in model catalog to auto-detect capabilities
    const ensureModelEntry = (target, provName, modId) => {
      const cacheKey = `${provName}/${modId}`;
      const deferred = deferredValidationModels.has(cacheKey);
      upsertProviderModelEntry(target, provName, modId, {
        deferInferredValidation: deferred,
        resolvedCatalogHit: getCachedCatalogHit(provName, modId),
        resolvedEntry: deferred ? buildSafePendingModelEntry(modId) : getCachedModelEntry(provName, modId)
      });
    };

    // Ensure primary model provider exists in models.json
    const [providerName, modelId] = primaryModel.split('/');
    if (!models.providers) models.providers = {};
    if (!models.providers[providerName]) {
      models.providers[providerName] = {
        baseUrl: getDefaultBaseUrl(providerName),
        apiKey: 'YOUR_API_KEY',
        api: 'openai-completions',
        models: []
      };
    }
    ensureModelEntry(models.providers, providerName, modelId);

    // Also handle subModel
    if (subModel && subModel.includes('/')) {
      const [subProvider, subModelId] = subModel.split('/');
      if (!models.providers[subProvider]) {
        models.providers[subProvider] = {
          baseUrl: getDefaultBaseUrl(subProvider),
          apiKey: 'YOUR_API_KEY',
          api: 'openai-completions',
          models: []
        };
      }
      ensureModelEntry(models.providers, subProvider, subModelId);
    }

    // Also write to openclaw.json models.providers (ensure persistence after gateway restart)
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    // Helper: ensure specified provider exists in config.models.providers
    // Copy provider basic info from models.json (without apiKey)
    const ensureConfigProvider = (provName) => {
      if (!config.models.providers[provName]) {
        ensureProviderShell(config.models.providers, models.providers, provName);
        console.log(`[ai/config] Created provider in openclaw.json: ${provName}`);
      }
    };

    ensureConfigProvider(providerName);
    ensureModelEntry(config.models.providers, providerName, modelId);
    if (subModel && subModel.includes('/')) {
      const [subProv] = subModel.split('/');
      ensureConfigProvider(subProv);
      ensureModelEntry(config.models.providers, subProv, subModel.split('/')[1]);
    }
    // Handle fallback models (write to models.json and openclaw.json)
    const allFbModels = [];
    if (fallbacks) {
      if (Array.isArray(fallbacks)) {
        allFbModels.push(...fallbacks);
      } else if (typeof fallbacks === 'object') {
        if (Array.isArray(fallbacks.primary)) allFbModels.push(...fallbacks.primary);
        if (Array.isArray(fallbacks.sub)) allFbModels.push(...fallbacks.sub);
      }
    }
    for (const fb of allFbModels) {
      if (!fb || !fb.includes('/')) continue;
      const [fbProv, fbModel] = fb.split('/');
      ensureConfigProvider(fbProv);
      ensureModelEntry(models.providers, fbProv, fbModel);
      ensureModelEntry(config.models.providers, fbProv, fbModel);
    }

    // Write files (auto-clean invalid keys)
    writeOpenClawConfig(config);
    fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2), { encoding: 'utf8', mode: 0o600 });

    const opState = getOpenClawOperationState();
    let message = 'Model config saved';
    let nextOperationState = opState;

    if (opState.type === 'idle') {
      nextOperationState = queueGatewayRestart('ai-config-save');
      message = 'Model config saved，Gateway reload requested';
      console.log('[ai/config] Model config saved，Gateway reload requested');
    } else if (opState.type === 'restarting_gateway') {
      message = 'Model config saved, Gateway reload already in progress';
      console.log('[ai/config] Model config saved, Gateway reload already in progress');
    } else {
      message = `Model config saved，current operation in progress (${opState.type}), please reload Gateway after operation completes to apply config`;
      console.log(`[ai/config] Model config saved，but current operation ${opState.type} is in progress, not triggering extra Gateway reload`);
    }

    if (deferredValidationJobs.length > 0) {
      message += `；${deferredValidationJobs.length} family-matched model(s) being verified in background`;
      for (const job of deferredValidationJobs) {
        queueInferredModelValidation(job);
      }
    }

    res.json({ success: true, message, operationState: nextOperationState });
  } catch (err) {
    console.error('[ai/config] Error saving config:', err);
    res.status(500).json({ error: 'Save config failed: ' + (err?.message || 'Unknown error') });
  }
});

// Validate API Key
app.post('/api/ai/keys/validate', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'Provider cannot be empty' });
    if (!apiKey) return res.status(400).json({ error: 'API Key cannot be empty' });

    const endpoint = baseUrl || getDefaultBaseUrl(provider);
    if (!endpoint) return res.json({ valid: false, error: 'Unable to determine API endpoint' });

    // Try calling /models endpoint to validate key
    let modelsUrl;
    if (provider === 'ollama') {
      modelsUrl = `${endpoint}/api/tags`;
    } else {
      modelsUrl = `${endpoint}/models`;
    }

    const headers = {};
    if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (provider === 'gemini') {
      // Gemini uses query param
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let fetchUrl = modelsUrl;
    if (provider === 'gemini') {
      fetchUrl = `${endpoint}/models?key=${apiKey}`;
    }

    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30000)
    });

    if (response.ok) {
      return res.json({ valid: true });
    }

    // Some providers return 401/403 for invalid keys
    const status = response.status;
    let errMsg = `HTTP ${status}`;
    try {
      const body = await response.json();
      errMsg = body.error?.message || body.message || body.error || errMsg;
    } catch {}

    if (status === 401 || status === 403) {
      return res.json({ valid: false, error: `API Key invalid: ${errMsg}` });
    }

    // Other status codes (e.g. 429 rate limit) consider key itself valid
    if (status === 429 || status === 200 || status === 201) {
      return res.json({ valid: true });
    }

    // 404 means provider may not have /models endpoint, does not mean key is invalid
    if (status === 404) {
      return res.json({ valid: true, warning: `${provider} does not support /models endpoint validation, skipped` });
    }

    return res.json({ valid: false, error: errMsg });
  } catch (err) {
    console.error('[ai/keys/validate] Error:', err);
    // Network timeout etc. — key validity uncertain, allowing to proceed
    return res.json({ valid: true, warning: 'Unable to connect for API validation: ' + (err?.message || 'Unknown error') });
  }
});

// ============ OpenClaw Built-in model catalog query API ============

// Get built-in provider list
app.get('/api/ai/catalog/providers', (req, res) => {
  const providers = getOpenClawBuiltinProviders();
  res.json({ providers });
});

// Get built-in model list for specified provider
app.get('/api/ai/catalog/models/:provider', (req, res) => {
  const { provider } = req.params;
  const models = getOpenClawProviderModels(provider);
  res.json({ provider, models });
});

// Query single model capabilities
app.get('/api/ai/catalog/lookup/:provider/:modelId', (req, res) => {
  const { provider, modelId } = req.params;
  const caps = lookupModelCapabilities(provider, modelId);
  if (!caps) {
    return res.json({ found: false, provider, modelId, message: 'Model not found in catalog, using safe defaults' });
  }
  res.json({
    found: true,
    provider,
    modelId,
    capabilities: caps,
    entry: buildModelEntry(provider, modelId)
  });
});

// Add API Key
app.post('/api/ai/keys', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl } = req.body || {};

    if (!provider) {
      return res.status(400).json({ error: 'Provider cannot be empty' });
    }

    let models = readAiModels();

    if (!models.providers) models.providers = {};

    const provBaseUrl = baseUrl || getDefaultBaseUrl(provider);

    if (!models.providers[provider]) {
      models.providers[provider] = {
        baseUrl: provBaseUrl,
        apiKey: 'YOUR_API_KEY',
        api: 'openai-completions',
        models: []
      };
    }

    if (baseUrl) {
      models.providers[provider].baseUrl = baseUrl;
    }

    if (apiKey) {
      // Set as currently active key
      models.providers[provider].apiKey = apiKey;
      console.log(`[ai/keys] API key for ${provider} saved (active)`);
    }

    // Sync auth-profiles.json (multi-key: each key uses unique profileId)
    let authProfiles = readAiAuthProfiles();

    if (apiKey) {
      // Check if profile with same apiKey exists (avoid duplicates)
      const existingProfileId = Object.keys(authProfiles.profiles || {}).find(pid => {
        const p = authProfiles.profiles[pid];
        return p?.provider === provider && p?.apiKey === apiKey;
      });

      if (!existingProfileId) {
        // Generate new profileId
        // First key uses provider name, subsequent add :N suffix
        let profileId = provider;
        if (authProfiles.profiles[provider]) {
          let n = 2;
          while (authProfiles.profiles[`${provider}:${n}`]) n++;
          profileId = `${provider}:${n}`;
        }
        authProfiles.profiles[profileId] = {
          provider,
          mode: 'api_key',
          apiKey,
          type: 'api_key',
          key: apiKey,
          addedAt: Date.now()
        };
        console.log(`[ai/keys] Added auth profile: ${profileId}`);
      } else {
        console.log(`[ai/keys] Key already exists as profile: ${existingProfileId}`);
      }
      // Also update legacy top-level entries (compat)
      authProfiles[provider] = {
        provider,
        mode: 'api_key',
        apiKey,
        type: 'api_key',
        key: apiKey
      };
    }

    writeAiAuthProfiles(authProfiles);

    // Sync models.providers in openclaw.json
    const configPath = '/root/.openclaw/openclaw.json';
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { config = {}; }

    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    if (!config.models.providers[provider]) {
      config.models.providers[provider] = {
        baseUrl: provBaseUrl,
        api: 'openai-completions',
        models: []
      };
    }
    if (baseUrl) config.models.providers[provider].baseUrl = baseUrl;
    if (apiKey) config.models.providers[provider].apiKey = apiKey;

    writeOpenClawConfig(config);
    writeAiModels(models);

    res.json({ success: true, message: `${provider} API Key saved` });
  } catch (err) {
    console.error('[ai/keys] Error adding key:', err);
    res.status(500).json({ error: 'Add failed: ' + (err?.message || 'Unknown error') });
  }
});

// Delete API Key
app.delete('/api/ai/keys', async (req, res) => {
  try {
    const { provider, keyId } = req.body || {};

    if (!provider) {
      return res.status(400).json({ error: 'Provider cannot be empty' });
    }

    const configPath = '/root/.openclaw/openclaw.json';

    // Read auth-profiles
    let authProfiles = readAiAuthProfiles();

    // Delete specified profile (keyId is profileId)
    const profileId = keyId || provider;
    const removedProfile = authProfiles.profiles?.[profileId];
    const removedSecret = getAuthProfileSecret(removedProfile);
    if (authProfiles.profiles?.[profileId]) {
      delete authProfiles.profiles[profileId];
      console.log(`[ai/keys] Removed profile ${profileId} from auth-profiles.json`);
    }
    if (authProfiles[profileId]) {
      delete authProfiles[profileId];
    }
    if (removedProfile?.provider && removedSecret) {
      removeDuplicateProfilesBySecret(authProfiles, removedProfile.provider, removedSecret);
    }

    // Check if provider has other keys
    const remainingKeys = Object.entries(authProfiles.profiles || {}).filter(([pid, p]) => p?.provider === provider);
    const hasRemainingKeys = remainingKeys.length > 0;

    // Handle in models.json
    let models = readAiModels();

    if (!hasRemainingKeys) {
      // No remaining keys, removing provider
      if (models.providers?.[provider]) {
        delete models.providers[provider];
        console.log(`[ai/keys] Removed provider ${provider} from models.json (no remaining keys)`);
      }
      // Clear legacy top-level entries
      if (authProfiles[provider]) {
        delete authProfiles[provider];
      }
    } else {
      // Remaining keys exist, activating first one
      const [nextPid, nextProfile] = remainingKeys[0];
      const nextKey = getAuthProfileSecret(nextProfile);
      if (nextKey && models.providers?.[provider]) {
        models.providers[provider].apiKey = nextKey;
        console.log(`[ai/keys] Activated next key for ${provider}: profile ${nextPid}`);
      }
      // Update legacy top-level entries
      if (nextProfile) {
        authProfiles[provider] = { ...nextProfile };
      }
    }

    // Handle in openclaw.json
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { config = {}; }

    if (!hasRemainingKeys) {
      if (config.models?.providers?.[provider]) {
        delete config.models.providers[provider];
      }

      // Clear model config referencing this provider
      const defaults = config?.agents?.defaults || {};
      const clearIfProvider = (modelStr) => {
        const p = String(modelStr || '').split('/')[0];
        return p === provider;
      };
      if (defaults.model?.primary && clearIfProvider(defaults.model.primary)) {
        defaults.model.primary = '';
        console.log(`[ai/keys] Cleared primary model (was using ${provider})`);
      }
      if (Array.isArray(defaults.model?.fallbacks)) {
        const before = defaults.model.fallbacks.length;
        defaults.model.fallbacks = defaults.model.fallbacks.filter(m => !clearIfProvider(m));
        if (defaults.model.fallbacks.length < before) console.log(`[ai/keys] Removed ${before - defaults.model.fallbacks.length} primary fallback(s) for ${provider}`);
      }
      const subagentModelVal = defaults.subagents?.model;
      if (subagentModelVal) {
        const subStr = typeof subagentModelVal === 'string' ? subagentModelVal : subagentModelVal?.primary;
        if (subStr && clearIfProvider(subStr)) {
          delete defaults.subagents.model;
          console.log(`[ai/keys] Cleared subagent model (was using ${provider})`);
        }
      }
    }
    // Write back all files (auto-clean invalid keys)
    writeAiModels(models);
    writeAiAuthProfiles(authProfiles);
    writeOpenClawConfig(config);

    res.json({ success: true, message: `${provider} deleted` });
  } catch (err) {
    console.error('[ai/keys] Error deleting key:', err);
    res.status(500).json({ error: 'Delete failed: ' + (err?.message || 'Unknown error') });
  }
});

// Get available model list
app.post('/api/ai/models', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl } = req.body || {};

    if (!provider) {
      return res.status(400).json({ error: 'Provider cannot be empty' });
    }

    // For some providers, return built-in model list
    const builtInModels = {
      // Common
      'anthropic': [
        { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus 4' },
        { id: 'anthropic/claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
        { id: 'anthropic/claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' }
      ],
      'openai': [
        { id: 'openai/gpt-4o', name: 'GPT-4o' },
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'openai/gpt-4', name: 'GPT-4' },
        { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
        { id: 'openai/o1', name: 'o1' },
        { id: 'openai/o1-mini', name: 'o1-mini' }
      ],
      'github-copilot': [
        { id: 'github-copilot/gpt-4o', name: 'Copilot GPT-4o' },
        { id: 'github-copilot/gpt-4', name: 'Copilot GPT-4' },
        { id: 'github-copilot/claude-3.5-sonnet', name: 'Copilot Claude 3.5 Sonnet' },
        { id: 'github-copilot/claude-sonnet-4', name: 'Copilot Claude Sonnet 4' },
        { id: 'github-copilot/o1', name: 'Copilot o1' },
        { id: 'github-copilot/o3-mini', name: 'Copilot o3-mini' },
        { id: 'github-copilot/gemini-2.0-flash', name: 'Copilot Gemini 2.0 Flash' }
      ],
      'gemini': [
        { id: 'gemini/gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
        { id: 'gemini/gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
        { id: 'gemini/gemini-1.5-flash', name: 'Gemini 1.5 Flash' }
      ],
      'deepseek': [
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek/deepseek-coder', name: 'DeepSeek Coder' },
        { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner' }
      ],
      // International
      'mistral': [
        { id: 'mistral/mistral-large-latest', name: 'Mistral Large' },
        { id: 'mistral/mistral-medium-latest', name: 'Mistral Medium' },
        { id: 'mistral/codestral-latest', name: 'Codestral' }
      ],
      'xai': [
        { id: 'xai/grok-4', name: 'Grok 4' },
        { id: 'xai/grok-3', name: 'Grok 3' },
        { id: 'xai/grok-3-fast', name: 'Grok 3 Fast' }
      ],
      'groq': [
        { id: 'groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
        { id: 'groq/mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
        { id: 'groq/gemma2-9b-it', name: 'Gemma2 9B' }
      ],
      'together': [
        { id: 'together/moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
        { id: 'together/deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
        { id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B' }
      ],
      'huggingface': [
        { id: 'huggingface/deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
        { id: 'huggingface/deepseek-ai/DeepSeek-V3.1', name: 'DeepSeek V3.1' },
        { id: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' }
      ],
      'perplexity': [
        { id: 'perplexity/sonar-pro', name: 'Sonar Pro' },
        { id: 'perplexity/sonar', name: 'Sonar' },
        { id: 'perplexity/sonar-reasoning-pro', name: 'Sonar Reasoning Pro' }
      ],
      'nvidia': [
        { id: 'nvidia/meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
        { id: 'nvidia/nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B' }
      ],
      'cerebras': [
        { id: 'cerebras/llama-3.3-70b', name: 'Llama 3.3 70B' },
        { id: 'cerebras/llama-3.1-8b', name: 'Llama 3.1 8B' }
      ],
      'venice': [
        { id: 'venice/llama-3.3-70b', name: 'Llama 3.3 70B' },
        { id: 'venice/deepseek-r1-671b', name: 'DeepSeek R1 671B' }
      ],
      // China
      'bailian': [
        { id: 'bailian/qwen3.5-plus', name: 'Qwen 3.5 Plus' },
        { id: 'bailian/qwen3-max-2026-01-23', name: 'Qwen 3 Max' },
        { id: 'bailian/qwen3-coder-next', name: 'Qwen 3 Coder Next' },
        { id: 'bailian/qwen3-coder-plus', name: 'Qwen 3 Coder Plus' },
        { id: 'bailian/MiniMax-M2.5', name: 'MiniMax M2.5' },
        { id: 'bailian/glm-5', name: 'GLM-5' },
        { id: 'bailian/glm-4.7', name: 'GLM-4.7' },
        { id: 'bailian/kimi-k2.5', name: 'Kimi K2.5' }
      ],
      'zai': [
        { id: 'zai/glm-5', name: 'GLM-5' },
        { id: 'zai/glm-4.7', name: 'GLM-4.7' }
      ],
      'moonshot': [
        { id: 'moonshot/kimi-k2.5', name: 'Kimi K2.5' },
        { id: 'moonshot/moonshot-v1-128k', name: 'Moonshot v1 128K' },
        { id: 'moonshot/moonshot-v1-32k', name: 'Moonshot v1 32K' }
      ],
      'kimi-coding': [
        { id: 'kimi-coding/k2p5', name: 'Kimi K2.5 Coding' }
      ],
      'minimax': [
        { id: 'minimax/MiniMax-M2.5', name: 'MiniMax M2.5' },
        { id: 'minimax/MiniMax-M1', name: 'MiniMax M1' }
      ],
      'xiaomi': [
        { id: 'xiaomi/mimo-v2-flash', name: 'MiMo V2 Flash' }
      ],
      'qianfan': [
        { id: 'qianfan/deepseek-v3.2', name: 'DeepSeek V3.2' },
        { id: 'qianfan/ernie-4.5-8k', name: 'ERNIE 4.5 8K' }
      ],
      'volcengine': [
        { id: 'volcengine/ark-code-latest', name: 'Ark Code Latest' }
      ],
      'byteplus': [
        { id: 'byteplus/ark-code-latest', name: 'Ark Code Latest' }
      ],
      // Gateway
      'litellm': [
        { id: 'litellm/claude-opus-4-6', name: 'Claude Opus 4.6' },
        { id: 'litellm/gpt-4o', name: 'GPT-4o' }
      ],
      'opencode': [
        { id: 'opencode/claude-opus-4-6', name: 'Claude Opus 4.6' },
        { id: 'opencode/gpt-4o', name: 'GPT-4o' }
      ],
      'kilocode': [
        { id: 'kilocode/anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' }
      ]
    };

    // github-copilot: exchange Copilot API Token first, then get models
    if (provider === 'github-copilot') {
      try {
        const authProfiles = readAiAuthProfiles();
        // openclaw format compatible (profiles sub-key) and legacy format (direct top-level)
        const copilotAuth = authProfiles?.profiles?.['github-copilot:github']
          || authProfiles?.profiles?.['github-copilot']
          || authProfiles['github-copilot'];
        const githubToken = copilotAuth?.token || copilotAuth?.apiKey || '';
        if (githubToken) {
          console.log(`[ai/models] Exchanging GitHub token ${githubToken.substring(0, 8)}... for Copilot API token`);
          // Step 1: Exchange GitHub ghu_ token for Copilot API token
          const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
          const tokenRes = await fetch(COPILOT_TOKEN_URL, {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/json',
              'User-Agent': 'GitHubCopilotChat/0.22.2024'
            },
            signal: AbortSignal.timeout(30000)
          });
          if (!tokenRes.ok) {
            let copilotErrorMsg = `Copilot token exchange failed: HTTP ${tokenRes.status}`;
            let copilotErrorDetail = '';
            try {
              const errBody = await tokenRes.json();
              copilotErrorDetail = errBody?.error_details?.message || errBody?.message || '';
              if (copilotErrorDetail) copilotErrorMsg += ` — ${copilotErrorDetail}`;
            } catch {}
            console.log(`[ai/models] ${copilotErrorMsg}`);
            // Return built-in list with error info
            return res.json({ success: true, models: builtInModels['github-copilot'], source: 'builtin', error: copilotErrorDetail || `HTTP ${tokenRes.status}` });
          } else {
            const tokenData = await tokenRes.json();
            const copilotApiToken = tokenData.token;
            if (copilotApiToken) {
              console.log(`[ai/models] Copilot API token obtained, expires_at: ${tokenData.expires_at}`);
              // Extract actual API base URL from token (proxy-ep field)
              let apiBaseUrl = 'https://api.individual.githubcopilot.com';
              const epMatch = copilotApiToken.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
              if (epMatch) {
                apiBaseUrl = 'https://' + epMatch[1].replace(/^proxy\./, 'api.');
                console.log(`[ai/models] Using extracted API base: ${apiBaseUrl}`);
              }
              // Step 2: Get model list with Copilot API token
              const modelsUrl = `${apiBaseUrl}/models`;
              const modelsRes = await fetch(modelsUrl, {
                headers: {
                  'Authorization': `Bearer ${copilotApiToken}`,
                  'Copilot-Integration-Id': 'vscode-chat',
                  'Editor-Version': 'vscode/1.96.0'
                },
                signal: AbortSignal.timeout(10000)
              });
              if (modelsRes.ok) {
                const data = await modelsRes.json();
                const models = (data.data || data.models || []).map(m => ({
                  id: `github-copilot/${m.id || m.name}`,
                  name: m.name || m.id
                })).filter(m => m.id);
                if (models.length > 0) {
                  console.log(`[ai/models] Copilot API returned ${models.length} models`);
                  return res.json({ success: true, models, source: 'api' });
                }
              } else {
                console.log(`[ai/models] Copilot models API returned HTTP ${modelsRes.status}`);
              }
            }
          }
        } else {
          console.log(`[ai/models] No copilot token found in auth-profiles`);
        }
      } catch (e) {
        console.log(`[ai/models] Copilot API fetch failed: ${e.message}`);
      }
      // Fallback to built-in list
      console.log(`[ai/models] Using builtin copilot model list`);
      return res.json({ success: true, models: builtInModels['github-copilot'], source: 'builtin' });
    }

    // Try to get API key from storage (if not provided in request)
    let effectiveApiKey = apiKey;
    if (!effectiveApiKey) {
      try {
        const modelsPath = '/root/.openclaw/agents/main/agent/models.json';
        const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
        effectiveApiKey = models?.providers?.[provider]?.apiKey || '';
      } catch {}
    }

    // For providers supporting /models endpoint, try dynamic model list fetch
    const dynamicProviders = new Set([
      'openrouter', 'custom', 'ollama', 'lmstudio', 'vllm', 'litellm',
      'groq', 'together', 'nvidia', 'cerebras', 'perplexity', 'mistral',
      'opencode', 'kilocode', 'deepseek', 'openai', 'xai', 'venice',
      'anthropic', 'gemini', 'huggingface', 'moonshot', 'bailian', 'zai',
      'kimi-coding', 'minimax', 'xiaomi', 'qianfan', 'volcengine', 'byteplus'
    ]);
    if (dynamicProviders.has(provider) && (effectiveApiKey || ['ollama', 'lmstudio', 'vllm'].includes(provider))) {
      const endpoint = baseUrl || getDefaultBaseUrl(provider);
      if (endpoint) {
        try {
          // ollama uses a different API path
          const modelsUrl = provider === 'ollama'
            ? `${endpoint}/api/tags`
            : provider === 'anthropic'
              ? null  // Anthropic does not support /models endpoint
              : `${endpoint}/models`;

          if (modelsUrl) {
            const headers = {};
            if (provider === 'anthropic') {
              headers['x-api-key'] = effectiveApiKey;
              headers['anthropic-version'] = '2023-06-01';
            } else if (provider === 'gemini') {
              // Gemini uses query param
            } else {
              if (effectiveApiKey) headers['Authorization'] = `Bearer ${effectiveApiKey}`;
            }
            let fetchUrl = modelsUrl;
            if (provider === 'gemini') fetchUrl = `${modelsUrl}?key=${effectiveApiKey}`;

            const response = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(30000) });
            if (response.ok) {
              const data = await response.json();
              let models;
              if (provider === 'ollama') {
                models = (data.models || []).map(m => ({
                  id: m.name || m.model,
                  name: m.name || m.model
                }));
              } else if (provider === 'gemini') {
                models = (data.models || []).map(m => ({
                  id: (m.name || '').replace('models/', ''),
                  name: m.displayName || m.name || ''
                }));
              } else {
                models = (data.data || []).map(m => ({
                  id: m.id,
                  name: m.name || m.id
                }));
              }
              // Ensure all model IDs have provider/ prefix
              models = models.map(m => {
                const prefix = provider + '/';
                if (!m.id.startsWith(prefix)) {
                  return { ...m, id: prefix + m.id };
                }
                return m;
              });
              if (models.length > 0) {
                return res.json({ success: true, models, source: 'api' });
              }
            }
          }
        } catch (e) {
          console.log(`[ai/models] dynamic fetch for ${provider} failed: ${e.message}`);
        }
      }
    }

    // Fallback to built-in list
    if (builtInModels[provider]) {
      return res.json({ success: true, models: builtInModels[provider], source: 'builtin' });
    }

    // Return empty list by default
    res.json({ success: true, models: [] });
  } catch (err) {
    console.error('[ai/models] Error:', err);
    res.status(500).json({ error: 'Failed to fetch model list: ' + (err?.message || 'Unknown error') });
  }
});

// Helper function: get default baseUrl
function getDefaultBaseUrl(provider) {
  const urls = {
    // Common
    'anthropic': 'https://api.anthropic.com/v1',
    'openai': 'https://api.openai.com/v1',
    'github-copilot': DEFAULT_COPILOT_API_BASE_URL,
    'gemini': 'https://generativelanguage.googleapis.com/v1beta',
    'openrouter': 'https://openrouter.ai/api/v1',
    'deepseek': 'https://api.deepseek.com/v1',
    // International
    'mistral': 'https://api.mistral.ai/v1',
    'xai': 'https://api.x.ai/v1',
    'groq': 'https://api.groq.com/openai/v1',
    'together': 'https://api.together.xyz/v1',
    'huggingface': 'https://router.huggingface.co/v1',
    'perplexity': 'https://api.perplexity.ai',
    'nvidia': 'https://integrate.api.nvidia.com/v1',
    'cerebras': 'https://api.cerebras.ai/v1',
    'venice': 'https://api.venice.ai/api/v1',
    // China
    'bailian': 'https://coding.dashscope.aliyuncs.com/v1',
    'zai': 'https://open.bigmodel.cn/api/paas/v4',
    'moonshot': 'https://api.moonshot.ai/v1',
    'kimi-coding': 'https://api.kimi.com/coding/',
    'minimax': 'https://api.minimax.io/anthropic',
    'xiaomi': 'https://api.xiaomimimo.com/anthropic',
    'qianfan': 'https://qianfan.baidubce.com/v2',
    'volcengine': 'https://ark.cn-beijing.volces.com/api/v3',
    'byteplus': 'https://ark.ap-southeast.bytepluses.com/api/v3',
    // Gateway
    'litellm': 'http://localhost:4000',
    'opencode': 'https://opencode.ai/v1',
    'kilocode': 'https://api.kilo.ai/api/gateway/',
    // Local
    'ollama': 'http://localhost:11434',
    'lmstudio': 'http://127.0.0.1:1234/v1',
    'vllm': 'http://localhost:8000/v1'
  };
  return urls[provider] || 'https://api.openai.com/v1';
}

// ============================================================
// API: restart gateway
// ============================================================
app.post('/api/restart', (req, res) => {
  try {
    const opState = getOpenClawOperationState();

    if (opState.type === 'restarting_gateway') {
      return res.json({
        success: true,
        message: 'Gateway restart already in progress, please wait',
        operationState: opState
      });
    }

    if (opState.type !== 'idle') {
      return res.status(409).json({ success: false, error: `Operation in progress: ${opState.type}`, operationState: opState });
    }

    // Write operation.lock, let watchdog perform restart
    queueGatewayRestart('api-restart');

    res.json({
      success: true,
      message: 'Restart request submitted, watchdog will execute within 10 seconds',
      operationState: { ...openClawOperationState }
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
  task.lastOutputAt = Date.now();
  if (task.logFile) {
    try {
      fs.mkdirSync(path.dirname(task.logFile), { recursive: true });
      fs.appendFileSync(task.logFile, text);
    } catch {}
  }

  const formatWatchdogTime = (date = new Date()) => {
    return formatDateTimeInLogTimezone(date);
  };
  const mirrorInstallLine = (line) => {
    const raw = String(line || '');
    const trimmed = raw.trim();
    if (!trimmed) return;
    const normalized = trimmed
      .replace(/^=====\s*\[[^\]]+\]\s*task\s+/i, '===== task ')
      .replace(/\s*=====\s*$/, ' =====');
    const isBoundary = /^=====\s*(\[[^\]]+\]\s*)?task\s+/i.test(trimmed);
    const isProgress = /^\[openclaw\]\[progress\]/i.test(normalized);
    const isErrorLike = (
      /^\[openclaw\]\[(error|fatal)\]/i.test(normalized)
      || /^(npm ERR!|npm WARN|pnpm:|curl:|tar:|unzip:|fatal:|Error:)/i.test(normalized)
      || /(timeout|timeout|failed|failed|exit=\d+|not found|EAI_AGAIN|ETIMEDOUT|ECONN|EADDRINUSE)/i.test(normalized)
    );
    const isStage = /^\[openclaw\]|^\[gateway\]|^\[progress\]/i.test(normalized);
    const important = isBoundary || isStage || isErrorLike;
    if (!important) return;
    task.mirrorState = task.mirrorState || {
      watchdog: { lastLine: '', lastAt: 0 },
      panel: { lastLine: '', lastAt: 0 },
      panelLastProgressAt: 0
    };
    const now = Date.now();

    const shouldMirror = (bucket, minGapMs = 8000) => {
      const state = task.mirrorState[bucket] || { lastLine: '', lastAt: 0 };
      if (state.lastLine === normalized && (now - Number(state.lastAt || 0)) < minGapMs) {
        return false;
      }
      task.mirrorState[bucket] = { lastLine: normalized, lastAt: now };
      return true;
    };

    const mirrorToWatchdog = isBoundary || /^\[openclaw\]\[(error|fatal)\]/i.test(normalized) || /^npm ERR!/i.test(normalized);
    const mirrorToPanel = isBoundary || isErrorLike || (!isProgress && isStage);

    if (mirrorToWatchdog && shouldMirror('watchdog', 12000)) {
      try {
        fs.appendFileSync(GATEWAY_WATCHDOG_LOG, `[${formatWatchdogTime()}] [install] ${normalized}\n`);
      } catch {}
    }

    if (mirrorToPanel) {
      if (!isProgress || (now - Number(task.mirrorState.panelLastProgressAt || 0)) >= 60000) {
        if (isProgress) task.mirrorState.panelLastProgressAt = now;
        if (shouldMirror('panel', 6000)) {
          try {
            console.log(`[install] ${normalized}`);
          } catch {}
        }
      }
    }
  };
  text.split('\n').forEach(mirrorInstallLine);

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
      appendRepairLog(task, '[repair] Pre-cleaned invalid keys: providers\n');
    }
    appendRepairLog(task, '[repair] Running openclaw doctor --fix ...\n');

    let doctorOutput = '';
    if (runCommandOk('command -v openclaw >/dev/null 2>&1 || test -x /root/.npm-global/bin/openclaw || test -x /usr/local/bin/openclaw || test -f /root/.openclaw/openclaw-source/openclaw.mjs', 1000)) {
      const doctor = await runOpenClawCli('OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; if [ -z "$OPENCLAW_BIN" ]; then for p in /root/.npm-global/bin/openclaw /usr/local/bin/openclaw /root/.openclaw/openclaw-source/openclaw.mjs; do if [ -x "$p" ] || [ -f "$p" ]; then OPENCLAW_BIN="$p"; break; fi; done; fi; if [ -z "$OPENCLAW_BIN" ]; then echo "openclaw not found"; exit 127; fi; "$OPENCLAW_BIN" doctor --fix 2>&1', 120000);
      doctorOutput = compactOutput(doctor.output || '');
      if (doctorOutput) appendRepairLog(task, `[repair] doctor output: ${doctorOutput}\n`);
      if (doctor.ok) appendRepairLog(task, '[repair] doctor --fix completed.\n');
      else appendRepairLog(task, '[repair] doctor --fix returned non-zero, continuing with fallback repair.\n');
    } else {
      appendRepairLog(task, '[repair] openclaw command not available, skipping doctor, running fallback repair.\n');
    }

    const gatewayLog = readGatewayLogTail(500);
    const detected = Array.from(new Set([
      ...detectInvalidConfigKeysFromText(gatewayLog),
      ...detectInvalidConfigKeysFromText(doctorOutput)
    ]));
    if (!detected.includes('providers')) detected.push('providers');
    task.detected = detected;

    const repair = repairOpenClawConfigInvalidKeys(detected);
    appendRepairLog(task, `[repair] Detected potentially invalid keys: ${detected.length ? detected.join(', ') : 'none'}\n`);

    if (!repair.changed) {
      appendRepairLog(task, '[repair] No deletable items found (may have been fixed by doctor).\n');
      appendRepairLog(task, '[repair] Please click "Restart Gateway" to verify config recovery.\n');
      task.changed = false;
      task.removed = [];
      task.status = 'success';
    } else {
      appendRepairLog(task, `[repair] Removed invalid keys: ${repair.removed.join(', ')}\n`);
      if (repair.backupPath) appendRepairLog(task, `[repair] Original config backed up to: ${repair.backupPath}\n`);
      appendRepairLog(task, '[repair] Repair complete, please click "Restart Gateway" to reload config.\n');
      task.changed = true;
      task.removed = repair.removed || [];
      task.backupPath = repair.backupPath || '';
      task.status = 'success';
    }
  })().catch((e) => {
    const detail = e?.message || String(e || 'Config recovery failed');
    console.error('[openclaw][repair] failed:', detail);
    appendRepairLog(task, `[repair] failed: ${detail}\n`);
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

function queueGatewayRestart(source = 'manual', taskId = '') {
  const state = setOpenClawOperationState('restarting_gateway', taskId);
  const suffix = taskId ? ` task=${taskId}` : '';
  console.log(`[openclaw][restart] request submitted (${source})${suffix}`);
  return state;
}

function runOpenClawTask(command, title, operationType = 'installing', options = {}) {
  if (isOpenClawOperationBusy()) return null;
  const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskLogFile = OPENCLAW_INSTALL_LOG_FILE;
  installLogs[taskId] = {
    status: 'running',
    log: '',
    startedAt: Date.now(),
    lastOutputAt: Date.now(),
    seq: 0,
    chunks: [],
    logFile: taskLogFile
  };

  const task = installLogs[taskId];
  task.operationType = String(operationType || 'installing');
  if (options?.release && typeof options.release === 'object') {
    task.release = {
      repo: parseGitHubRepo(options.release.repo || '') || '',
      tag: String(options.release.tag || '').trim()
    };
  }
  appendInstallLog(task, `\n===== [${new Date().toISOString()}] task ${taskId} (${operationType}) begin =====\n`);
  appendInstallLog(task, `[state] operation=${operationType} status=begin task=${taskId}\n`);
  activeInstallTaskId = taskId;
  setOpenClawOperationState(operationType, taskId);
  const depAudit = auditOpenClawImageDependencies();
  appendInstallLog(task, `[openclaw] preflight: dependencies=${depAudit.ok ? 'ok' : 'missing'}\n`);
  if (!depAudit.ok) {
    if (depAudit.missingCommands?.length) appendInstallLog(task, `[openclaw] preflight: missing commands => ${depAudit.missingCommands.join(', ')}\n`);
    if (depAudit.missingFiles?.length) appendInstallLog(task, `[openclaw] preflight: missing files => ${depAudit.missingFiles.join(', ')}\n`);
    if (depAudit.missingDirs?.length) appendInstallLog(task, `[openclaw] preflight: missing dirs => ${depAudit.missingDirs.join(', ')}\n`);
  }
  if (depAudit.advisoryMissingCommands?.length) {
    appendInstallLog(task, `[openclaw] preflight: optional commands missing => ${depAudit.advisoryMissingCommands.join(', ')}\n`);
  }
  appendInstallLog(task, `[openclaw] log file: ${task.logFile || OPENCLAW_INSTALL_LOG_FILE}\n`);
  appendInstallLog(task, `[openclaw] ${title}\n`);
  appendInstallLog(task, `[openclaw] command prepared (length=${String(command || '').length})\n`);
  appendInstallLog(task, '[openclaw] Install script starting, real-time output below...\n\n');

  const escaped = String(command).replace(/'/g, `'"'"'`);
  const child = exec(`bash --noprofile --norc -lc '${escaped}'`, {
    timeout: 2700000,
    maxBuffer: 200 * 1024 * 1024,
    env: { ...process.env, TERM: 'dumb' }
  });
  task.pid = Number(child.pid || 0) || 0;
  // C7: Persist subprocess PID for post-restart orphan detection (DFMEA T2)
  try {
    fs.mkdirSync(path.dirname(OPENCLAW_TASK_PID_FILE), { recursive: true });
    fs.writeFileSync(OPENCLAW_TASK_PID_FILE, JSON.stringify({ pid: task.pid, taskId, operationType, startedAt: task.startedAt }), { mode: 0o600 });
  } catch {}
  const heartbeatTimer = setInterval(() => {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - Number(task.startedAt || Date.now())) / 1000));
    setOpenClawOperationState(operationType, taskId);
    appendInstallLog(task, `[state] operation=${operationType} status=running elapsed=${elapsedSec}s task=${taskId}\n`);
  }, 30000);
  child.on('error', (err) => {
    clearInterval(heartbeatTimer);
    appendInstallLog(task, `[openclaw] Task startup failed: ${err.message}\n`);
    task.status = 'failed';
    task.exitCode = -1;
    task.error = `Task startup failed: ${err.message}`;
    clearOpenClawOperationState(operationType);
  });
  child.stdout.on('data', d => appendInstallLog(task, d));
  child.stderr.on('data', d => appendInstallLog(task, d));
  child.on('close', (code, signal) => {
    clearInterval(heartbeatTimer);
    if (signal) {
      appendInstallLog(task, `[openclaw] Task interrupted (signal=${signal}），possibly timed out or terminated externally.\n`);
    }
    task.status = code === 0 ? 'success' : 'failed';
    task.exitCode = code;
    if (task.status === 'success' && operationType === 'uninstalling') {
      openClawRuntimeRecoveryState.suppressUntil = Date.now() + OPENCLAW_RUNTIME_RECOVERY_SUPPRESS_AFTER_UNINSTALL_MS;
      openClawRuntimeRecoveryState.suppressReason = 'uninstall-cooldown';
    }
    if (task.status === 'success' && (operationType === 'installing' || operationType === 'updating')) {
      openClawRuntimeRecoveryState.suppressUntil = 0;
      openClawRuntimeRecoveryState.suppressReason = '';
      const opLabel = operationType === 'updating' ? 'Update' : 'Install';
      const metadataSync = syncOpenClawPostInstallMetadata({ operationType, release: task.release || null });
      task.metadataSync = metadataSync;
      if (metadataSync?.error) {
        appendInstallLog(task, `[openclaw][warn] ${opLabel}post-metadata sync failed: ${metadataSync.error}\n`);
      } else if (metadataSync?.configChanged || metadataSync?.updateCheckChanged) {
        appendInstallLog(task, `[openclaw] ${opLabel}post-metadata synced: version=${metadataSync.version}${metadataSync.tag ? ` tag=${metadataSync.tag}` : ''}\n`);
      }
      // A/B swap already completed Gateway stop→start→health check in install script, no extra restart needed
      // Only ensure watchdog is alive for subsequent monitoring
      ensureGatewayWatchdog((wdErr) => {
        if (wdErr) {
          appendInstallLog(task, `[openclaw][warn] ensureGatewayWatchdog failed: ${wdErr.message}\n`);
        }
      });
      appendInstallLog(task, `[openclaw] ${opLabel}completed (A/B swap started and verified new Gateway).\n`);
    }
    if (task.status === 'failed') {
      const lines = String(task.log || '')
        .split(/\r?\n/)
        .map((line) => String(line || '').trim())
        .filter(Boolean);
      let reason = '';
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (/\[openclaw\]\[(error|fatal)\]/i.test(line)) {
          reason = line;
          break;
        }
        if (/(exit\s*=\s*\d+|timeout|failed|failed|not found|ENOENT|ECONN|EAI_AGAIN|ETIMEDOUT)/i.test(line)) {
          reason = line;
          break;
        }
      }
      task.error = reason || `Install failed (exit=${code ?? 'unknown'}${signal ? `, signal=${signal}` : ''}）`;
      appendInstallLog(task, `[openclaw][error] ${task.error}\n`);
    }
    const durationSec = Math.max(0, Math.floor((Date.now() - Number(task.startedAt || Date.now())) / 1000));
    appendInstallLog(task, `[openclaw] task duration: ${durationSec}s\n`);
    appendInstallLog(task, `[state] operation=${operationType} status=${task.status} duration=${durationSec}s task=${taskId}\n`);
    appendInstallLog(task, `\n===== [${new Date().toISOString()}] task ${taskId} end status=${task.status} exitCode=${code ?? 'null'} signal=${signal || 'none'} =====\n`);
    if (activeInstallTaskId === taskId) activeInstallTaskId = '';
    clearOpenClawOperationState(operationType);
    // C7: Clean up PID file
    try { fs.unlinkSync(OPENCLAW_TASK_PID_FILE); } catch {}
    const keys = Object.keys(installLogs).sort();
    while (keys.length > 5) delete installLogs[keys.shift()];
  });

  return taskId;
}

// C7: Detect and clean orphan install processes on service restart (DFMEA T2)
function checkOrphanInstallTask() {
  try {
    if (!fs.existsSync(OPENCLAW_TASK_PID_FILE)) return;
    const raw = fs.readFileSync(OPENCLAW_TASK_PID_FILE, 'utf8');
    const info = JSON.parse(raw);
    const pid = Number(info.pid || 0);
    if (!pid) { try { fs.unlinkSync(OPENCLAW_TASK_PID_FILE); } catch {} return; }
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive) {
      const ageSec = Math.floor((Date.now() - Number(info.startedAt || 0)) / 1000);
      console.log(`[openclaw][orphan] Detected orphan install process PID=${pid} task=${info.taskId} age=${ageSec}s，attempting to terminate...`);
      try { process.kill(pid, 'SIGTERM'); } catch {}
      setTimeout(() => {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
      }, 5000);
    } else {
      console.log(`[openclaw][orphan] PID=${pid} no longer exists, cleaning up stale PID file`);
    }
    try { fs.unlinkSync(OPENCLAW_TASK_PID_FILE); } catch {}
    // Also clean possibly stale operation.lock
    clearOpenClawOperationState(info.operationType || 'installing');
  } catch (e) {
    console.log(`[openclaw][orphan] Orphan process check failed: ${e.message}`);
  }
}

function buildOpenClawUninstallCommand() {
  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] Script exited abnormally line=$LINENO exit=$?" >&2\' ERR',
    'echo "[openclaw] Starting OpenClaw uninstall..."',
    'NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo /usr/local)"',
    'OPENCLAW_STATE_ROOT="/root/.openclaw"',
    'echo "[openclaw] npm prefix: ${NPM_PREFIX}"',
    'npm uninstall -g openclaw >/dev/null 2>&1 || true',
    'rm -f "${NPM_PREFIX}/bin/openclaw" >/dev/null 2>&1 || true',
    'rm -rf "${NPM_PREFIX}/lib/node_modules/openclaw" >/dev/null 2>&1 || true',
    'rm -rf "${OPENCLAW_STATE_ROOT}/openclaw" "${OPENCLAW_STATE_ROOT}/openclaw-source" >/dev/null 2>&1 || true',
    'rm -f "${OPENCLAW_STATE_ROOT}/openclaw-source-install.json" >/dev/null 2>&1 || true',
    'echo "[openclaw] Uninstall complete (npm global package and local source directory removed)"'
  ].join('\n');
}

function listOpenClawConfigBackups() {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG_BACKUP_DIR)) return [];
    const entries = fs.readdirSync(OPENCLAW_CONFIG_BACKUP_DIR);
    const result = [];

    // New format: snapshot-YYYYMMDD-HHMMSS directory
    for (const name of entries) {
      if (!name.startsWith('snapshot-')) continue;
      const dirPath = path.join(OPENCLAW_CONFIG_BACKUP_DIR, name);
      let stat = null;
      try { stat = fs.statSync(dirPath); } catch {}
      if (!stat || !stat.isDirectory()) continue;
      const files = [];
      try {
        for (const f of fs.readdirSync(dirPath)) {
          if (!f.endsWith('.json')) continue;
          const fp = path.join(dirPath, f);
          let fstat = null;
          try { fstat = fs.statSync(fp); } catch {}
          files.push({ name: f, size: fstat?.size || 0 });
        }
      } catch {}
      if (files.length === 0) continue;
      result.push({
        name,
        type: 'snapshot',
        path: dirPath,
        files,
        size: files.reduce((s, f) => s + f.size, 0),
        mtimeMs: stat?.mtimeMs || 0,
        mtime: stat?.mtime || null
      });
    }

    // Old format: openclaw-YYYYMMDD-HHMMSS.json single file
    for (const name of entries) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const fullPath = path.join(OPENCLAW_CONFIG_BACKUP_DIR, name);
      let stat = null;
      try { stat = fs.statSync(fullPath); } catch {}
      if (!stat || !stat.isFile()) continue;
      result.push({
        name,
        type: 'legacy',
        path: fullPath,
        files: [{ name, size: stat?.size || 0 }],
        size: stat?.size || 0,
        mtimeMs: stat?.mtimeMs || 0,
        mtime: stat?.mtime || null
      });
    }

    return result.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

/**
 * Sanitize ALL config backup files at startup.
 * Removes invalid keys from each backup JSON so that rollback doesn't restore bad config.
 */
function sanitizeAllConfigBackups() {
  try {
    const backups = listOpenClawConfigBackups();
    let cleaned = 0;
    for (const backup of backups) {
      const jsonFiles = backup.type === 'snapshot'
        ? backup.files.filter(f => f.name === 'openclaw.json').map(f => path.join(backup.path, f.name))
        : [backup.path];
      for (const filePath of jsonFiles) {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const cfg = JSON.parse(raw);
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
          const result = sanitizeOpenClawConfig(cfg);
          if (result.changed) {
            fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
            cleaned++;
            console.log(`[config] sanitized backup ${backup.name}/${path.basename(filePath)}: removed ${result.removed.join(', ')}`);
          }
        } catch {}
      }
    }
    if (cleaned > 0) {
      console.log(`[config] sanitized ${cleaned} config backup file(s) at startup`);
    }
  } catch {}
}

function sanitizeBackupFileName(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  // Support old format JSON filename and new snapshot directory name
  if (/^snapshot-[0-9-]+$/.test(value)) return value;
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

function isGatewayWatchdogStartupInProgress(maxAgeSec = 900) {
  try {
    const text = tailFile(GATEWAY_WATCHDOG_LOG, 2400, 5000);
    if (!text) return false;
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = String(lines[i] || '');
      if (!line) continue;
      if (/Gateway started and healthy|Gateway is UP|startup completed/i.test(line)) return false;
      if (/Startup timed out|Gateway failed|watchdog idle|runtime entry missing/i.test(line)) return false;
      if (/Startup in progress|Gateway process launched|Gateway is DOWN\s+—\s+restarting|Starting gateway/i.test(line)) {
        const ts = extractWatchdogTimestamp(line);
        if (!ts) return true;
        const parsed = Date.parse(ts.replace(' ', 'T'));
        if (!Number.isFinite(parsed)) return true;
        const ageSec = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
        return ageSec <= Math.max(60, Number(maxAgeSec || 900));
      }
    }
  } catch {}
  return false;
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

const OPENCLAW_OPERATION_LOCK_FILE = `${OPENCLAW_LOCK_DIR}/operation.lock`;
const OPENCLAW_TASK_PID_FILE = `${OPENCLAW_LOCK_DIR}/task.pid`;
let openClawOperationState = { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
const OPENCLAW_OPERATION_MAX_SEC = {
  installing: 5400,
  updating: 5400,
  uninstalling: 1200,
  restarting_gateway: 600,
  repairing_config: 900
};
// C9: Grace period must exceed watchdog CHECK_INTERVAL (10s) to avoid race condition
// where the reconcile clears the restarting_gateway lock before the watchdog polls it.
// Previously 5s — caused the watchdog to never see restart requests (DFMEA O4).
const OPENCLAW_RESTART_RECONCILE_GRACE_SEC = 15;

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
    const type = String(parsed?.type || '');
    if (pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
      } catch {
        if (type === 'restarting_gateway') {
          return {
            type,
            taskId: String(parsed?.taskId || ''),
            startedAt: Number(parsed?.startedAt || 0),
            pid
          };
        }
        // For install/update types, check if subprocess (task.pid) is still alive to avoid deleting lock prematurely
        if (type === 'installing' || type === 'updating') {
          try {
            if (fs.existsSync(OPENCLAW_TASK_PID_FILE)) {
              const taskPidInfo = JSON.parse(fs.readFileSync(OPENCLAW_TASK_PID_FILE, 'utf8'));
              const taskPid = Number(taskPidInfo?.pid || 0);
              if (taskPid > 1) {
                try {
                  process.kill(taskPid, 0);
                  // Subprocess still alive, keeping lock
                  return {
                    type,
                    taskId: String(parsed?.taskId || ''),
                    startedAt: Number(parsed?.startedAt || 0),
                    pid
                  };
                } catch {}
              }
            }
          } catch {}
        }
        try { fs.unlinkSync(OPENCLAW_OPERATION_LOCK_FILE); } catch {}
        return null;
      }
    }
    if (!type || type === 'idle') return null;
    return {
      type,
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
    // C6: Use atomic write to prevent reading half-written data from race conditions (DFMEA O2)
    // C9: Use compact JSON because watchdog grep patterns do not match pretty format
    const lockDir = path.dirname(OPENCLAW_OPERATION_LOCK_FILE);
    fs.mkdirSync(lockDir, { recursive: true });
    const tmpPath = `${OPENCLAW_OPERATION_LOCK_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, OPENCLAW_OPERATION_LOCK_FILE);
    try { fs.chmodSync(OPENCLAW_OPERATION_LOCK_FILE, 0o600); } catch {}
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

  const reconcileRestartingGatewayState = (state) => {
    const current = state && typeof state === 'object' ? { ...state } : { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
    if (current.type !== 'restarting_gateway') return current;

    // C9: Grace period must be long enough for the watchdog (CHECK_INTERVAL=10s) to
    // read operation.lock and initiate the actual kill+restart cycle. Only after this
    // window should we reconcile against live gateway health and clear the state.
    const elapsedSec = Math.max(0, Math.floor((Date.now() - Number(current.startedAt || 0)) / 1000));
    if (elapsedSec < OPENCLAW_RESTART_RECONCILE_GRACE_SEC) return current;

    const gatewayHealthCode = Number.parseInt(String(runCommandText(LOCAL_GATEWAY_HEALTH_CHECK_CMD, 3000) || '').trim(), 10) || 0;
    const gatewayRunning = gatewayHealthCode === 200;
    const gatewayProcessRunning = isGatewayRuntimeProcessRunning()
      || runCommandOk('ss -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]" || netstat -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]"', 1200);
    const watchdogStarting = runCommandOk('pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1', 1200)
      && isGatewayWatchdogStartupInProgress(900);

    if (gatewayRunning || (!gatewayProcessRunning && !watchdogStarting)) {
      openClawOperationState = { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
      writeOperationLock(null);
      return { ...openClawOperationState };
    }
    return current;
  };

  if (openClawOperationState.type && openClawOperationState.type !== 'idle') {
    if (Number(openClawOperationState.pid || process.pid) === process.pid) {
      return reconcileRestartingGatewayState(normalizeState({ ...openClawOperationState }));
    }
    const fromFile = readOperationLockFromFile();
    if (fromFile) {
      openClawOperationState = reconcileRestartingGatewayState(normalizeState({ ...fromFile }));
      return { ...openClawOperationState };
    }
    openClawOperationState = { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
    return { ...openClawOperationState };
  }
  const lockState = readOperationLockFromFile();
  if (lockState) {
    openClawOperationState = reconcileRestartingGatewayState(normalizeState({ ...lockState }));
    return { ...openClawOperationState };
  }
  return { type: 'idle', taskId: '', startedAt: 0, pid: process.pid };
}

function setOpenClawOperationState(type, taskId = '') {
  const nextType = String(type || 'idle') || 'idle';
  const nextTaskId = String(taskId || '');
  const current = getOpenClawOperationState();
  const forceRefreshStartedAt = nextType === 'restarting_gateway';
  const keepStartedAt = (
    !forceRefreshStartedAt
    && current
    && current.type === nextType
    && String(current.taskId || '') === nextTaskId
    && Number(current.startedAt || 0) > 0
  );
  openClawOperationState = {
    type: nextType,
    taskId: nextTaskId,
    startedAt: keepStartedAt ? Number(current.startedAt) : Date.now(),
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
  uninstalling: 420,
  restarting_gateway: 360,
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
        ? 'Installing'
        : type === 'updating'
          ? 'Updating'
          : type === 'uninstalling'
            ? 'Uninstalling'
          : type === 'restarting_gateway'
            ? 'Gateway starting'
            : type === 'repairing_config'
              ? 'Restoring config'
              : 'Processing'
    }
  };
}

function auditOpenClawImageDependencies() {
  const requiredCommands = ['bash', 'node', 'npm', 'git', 'curl', 'jq', 'tar', 'gzip', 'unzip', 'python3', 'make', 'g++'];
  const commands = requiredCommands.map((name) => ({
    name,
    ok: runCommandOk(`command -v ${name} >/dev/null 2>&1`, 1200),
    path: runCommandText(`command -v ${name} 2>/dev/null || true`, 1200)
  }));
  const pnpmReady = runCommandOk('command -v pnpm >/dev/null 2>&1 || (command -v corepack >/dev/null 2>&1 && corepack pnpm -v >/dev/null 2>&1)', 1800);
  commands.push({
    name: 'pnpm',
    ok: pnpmReady,
    required: true,
    path: pnpmReady
      ? runCommandText('command -v pnpm 2>/dev/null || echo "corepack pnpm"', 1200)
      : ''
  });

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

  const missingCommands = commands.filter((item) => item.required !== false && !item.ok).map((item) => item.name);
  const advisoryMissingCommands = commands.filter((item) => item.required === false && !item.ok).map((item) => item.name);
  const missingFiles = files.filter((item) => !item.ok).map((item) => item.path);
  const missingDirs = dirs.filter((item) => !item.ok).map((item) => item.path);
  const ok = missingCommands.length === 0 && missingFiles.length === 0 && missingDirs.length === 0;

  return {
    ok,
    commands,
    files,
    dirs,
    missingCommands,
    advisoryMissingCommands,
    missingFiles,
    missingDirs,
    checkedAt: new Date().toISOString()
  };
}

function buildOpenClawSourceInstallCommand({ repo, tag, tarballUrl }) {
  const safeRepo = parseGitHubRepo(repo) || OPENCLAW_SOURCE_REPO_DEFAULT;
  const safeTag = String(tag || '').trim();
  const safeTarball = String(tarballUrl || '').trim();
  if (!safeTag || !safeTarball) throw new Error('Release info incomplete, cannot build install command');

  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] Script exited abnormally line=$LINENO exit=$?" >&2\' ERR',
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
    'echo "[openclaw] Downloading release source code: $OPENCLAW_REPO @ $OPENCLAW_TAG"',
    'if [ -s "$CACHE_TARBALL" ] && tar -tzf "$CACHE_TARBALL" >/dev/null 2>&1; then',
    '  echo "[openclaw] Using locally cached tarball: $CACHE_TARBALL"',
    '  cp -f "$CACHE_TARBALL" "$TMP_BASE/openclaw.tar.gz"',
    'fi',
    'download_tarball() {',
    '  local url="$1"',
    '  local out="$2"',
    '  local tmp="$out.part"',
    '  local i=1',
    '  while [ "$i" -le 12 ]; do',
    '    echo "[openclaw] Download attempt $i/12: $url"',
    '    rm -f "$tmp"',
    '    if curl -fL --http1.1 --connect-timeout 10 --max-time 1800 -o "$tmp" "$url"; then',
    '      if tar -tzf "$tmp" >/dev/null 2>&1; then',
    '        mv -f "$tmp" "$out"',
    '        return 0',
    '      fi',
    '      echo "[openclaw] tarball verification failed, retrying..."',
    '    fi',
    '    rm -f "$tmp"',
    '    sleep 2',
    '    i=$((i + 1))',
    '  done',
    '  return 1',
    '}',
    'if [ -s "$TMP_BASE/openclaw.tar.gz" ] && tar -tzf "$TMP_BASE/openclaw.tar.gz" >/dev/null 2>&1; then',
    '  echo "[openclaw] Using pre-prepared tarball"',
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
    '  echo "[openclaw] tarball download failed, falling back to git clone tag..."',
    '  if ! command -v git >/dev/null 2>&1; then',
    '    echo "[openclaw] Missing image dependency: git (please rebuild image, do not install system deps at runtime)"',
    '    exit 11',
    '  fi',
    '  CLONE_DIR="$SRC_TMP/repo-src"',
    '  rm -rf "$CLONE_DIR"',
    '  mkdir -p "$SRC_TMP"',
    '  i=1',
    '  while [ "$i" -le 6 ]; do',
    '    git clone --depth 1 --branch "$OPENCLAW_TAG" "https://github.com/$OPENCLAW_REPO.git" "$CLONE_DIR" && break',
    '    echo "[openclaw] git clone failed (attempt=$i), retrying..."',
    '    rm -rf "$CLONE_DIR"',
    '    sleep 3',
    '    i=$((i + 1))',
    '  done',
    '  EXTRACT_DIR="$CLONE_DIR"',
    'fi',
    'if [ -z "$EXTRACT_DIR" ] || [ ! -d "$EXTRACT_DIR" ]; then echo "[openclaw] Failed to obtain source directory"; exit 2; fi',
    'for bin in node npm git curl tar gzip; do',
    '  if ! command -v "$bin" >/dev/null 2>&1; then',
    '    echo "[openclaw] Missing image dependency: $bin (please rebuild image, do not install system deps at runtime)"',
    '    exit 11',
    '  fi',
    'done',
    'cd "$EXTRACT_DIR"',
    'export NODE_ENV=development',
    'export NPM_CONFIG_PRODUCTION=false',
    'export npm_config_production=false',
    'export NPM_CONFIG_INCLUDE=dev',
    'export npm_config_include=dev',
    'echo "[openclaw] source build stage using dev dependency mode (NPM_CONFIG_PRODUCTION=false)"',
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
    '    echo "[openclaw] npm dependency install failed (registry=$reg, attempt=$i), retrying..."',
    '    npm cache verify >/dev/null 2>&1 || true',
    '    sleep 3',
    '    i=$((i + 1))',
    '  done',
    '  return 1',
    '}',
    'if ! install_with_registry https://registry.npmjs.org; then',
    '  echo "[openclaw] npmjs registry failed, falling back to npmmirror"',
    '  install_with_registry https://registry.npmmirror.com',
    'fi',
    'PNPM_CMD="pnpm"',
    'if command -v pnpm >/dev/null 2>&1; then',
    '  PNPM_CMD="pnpm"',
    'elif command -v corepack >/dev/null 2>&1; then',
    '  corepack prepare pnpm@10.23.0 --activate >/dev/null 2>&1 || true',
    '  if corepack pnpm -v >/dev/null 2>&1; then',
    '    PNPM_CMD="corepack pnpm"',
    '    echo "[openclaw] pnpm executable not detected, falling back to corepack pnpm"',
    '  else',
    '    echo "[openclaw] Missing image dependency: pnpm (corepack fallback not available)"',
    '    exit 11',
    '  fi',
    'else',
    '  echo "[openclaw] Missing image dependency: pnpm (please rebuild image, do not install system deps at runtime)"',
    '  exit 11',
    'fi',
    'PNPM_BIN_DIR="$(npm prefix -g 2>/dev/null)/bin"',
    'export PATH="$PNPM_BIN_DIR:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'if [ -x "$PNPM_BIN_DIR/pnpm" ]; then ln -sf "$PNPM_BIN_DIR/pnpm" /usr/local/bin/pnpm 2>/dev/null || true; fi',
    'if ! command -v pnpm >/dev/null 2>&1 && ! { command -v corepack >/dev/null 2>&1 && corepack pnpm -v >/dev/null 2>&1; }; then echo "[openclaw] pnpm not available, install failed"; exit 5; fi',
    'if npm run | grep -qE "(^| )build( |$)"; then npm run build; elif npm run | grep -qE "(^| )compile( |$)"; then npm run compile; else echo "[openclaw] build/compile script not found"; exit 3; fi',
    'if [ ! -f dist/control-ui/index.html ]; then',
    '  echo "[openclaw] control-ui assets missing, attempting ui:build"',
    '  if npm run | grep -qE "(^| )ui:build( |$)"; then',
    '    $PNPM_CMD ui:build || npm run ui:build || true',
    '  fi',
    'fi',
    'if [ ! -f dist/control-ui/index.html ] && [ -d control-ui ] && [ -f control-ui/package.json ]; then',
    '  echo "[openclaw] Attempting build in control-ui subdirectory"',
    '  cd control-ui',
    '  $PNPM_CMD install --prefer-offline --no-frozen-lockfile >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1 || true',
    '  $PNPM_CMD build >/dev/null 2>&1 || npm run build >/dev/null 2>&1 || true',
    '  cd "$EXTRACT_DIR"',
    '  if [ -f control-ui/dist/index.html ]; then',
    '    mkdir -p dist/control-ui',
    '    cp -a control-ui/dist/. dist/control-ui/',
    '  fi',
    'fi',
    'if [ ! -f dist/control-ui/index.html ] && [ -f "$PERSIST_SRC_DIR/dist/control-ui/index.html" ]; then',
    '  echo "[openclaw] Using existing installed control-ui assets as fallback"',
    '  mkdir -p dist/control-ui',
    '  cp -a "$PERSIST_SRC_DIR/dist/control-ui/." dist/control-ui/ || true',
    'fi',
    'if [ ! -f dist/control-ui/index.html ] && command -v npm >/dev/null 2>&1; then',
    '  NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"',
    '  if [ -n "$NPM_GLOBAL_ROOT" ] && [ -f "$NPM_GLOBAL_ROOT/openclaw/dist/control-ui/index.html" ]; then',
    '    echo "[openclaw] Using npm global openclaw control-ui assets as fallback"',
    '    mkdir -p dist/control-ui',
    '    cp -a "$NPM_GLOBAL_ROOT/openclaw/dist/control-ui/." dist/control-ui/ || true',
    '  fi',
    'fi',
    'if [ ! -f dist/control-ui/index.html ]; then',
    '  # C5: Enhanced control-ui missing diagnostics (DFMEA S1)',
    '  echo "[openclaw][error] control-ui assets missing, Gateway /health may not work"',
    '  echo "[openclaw][diag] ls -la dist/ :"',
    '  ls -la dist/ 2>/dev/null || echo "  (dist/ directory does not exist)"',
    '  echo "[openclaw][diag] ls -la dist/control-ui/ :"',
    '  ls -la dist/control-ui/ 2>/dev/null || echo "  (dist/control-ui/ directory does not exist)"',
    '  echo "[openclaw][diag] find . -name index.html:"',
    '  find . -name index.html -type f 2>/dev/null | head -10 || echo "  (no index.html found)"',
    '  echo "[openclaw][diag] npm run scripts:"',
    '  npm run 2>/dev/null | grep -E "ui:|build" || echo "  (no match)"',
    '  exit 4',
    'fi',
    'STAGE_SRC_DIR="$WORK_BASE/openclaw-source.stage.$$"',
    'rm -rf "$STAGE_SRC_DIR"',
    'mkdir -p /root/.openclaw "$WORK_BASE"',
    'cp -a "$EXTRACT_DIR" "$STAGE_SRC_DIR"',
    '# A/B mode: install to staging directory (Gateway uninterrupted)',
    'NEXT_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source-next"',
    'rm -rf "$NEXT_SRC_DIR" 2>/dev/null || true',
    'mv -Tf "$STAGE_SRC_DIR" "$NEXT_SRC_DIR"',
    'if [ ! -f "$NEXT_SRC_DIR/openclaw.mjs" ] && [ -f "$NEXT_SRC_DIR/dist/openclaw.mjs" ]; then ln -sf "$NEXT_SRC_DIR/dist/openclaw.mjs" "$NEXT_SRC_DIR/openclaw.mjs"; fi',
    'if [ ! -f "$NEXT_SRC_DIR/openclaw.mjs" ]; then echo "[openclaw] Build artifact missing: $NEXT_SRC_DIR/openclaw.mjs"; exit 4; fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.js" ] && [ -f "$NEXT_SRC_DIR/dist/index.js" ]; then ln -sfn index.js "$NEXT_SRC_DIR/dist/entry.js"; fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.mjs" ] && [ -f "$NEXT_SRC_DIR/dist/index.mjs" ]; then ln -sfn index.mjs "$NEXT_SRC_DIR/dist/entry.mjs"; fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.js" ] && [ ! -f "$NEXT_SRC_DIR/dist/entry.mjs" ] && [ ! -f "$NEXT_SRC_DIR/dist/index.js" ] && [ ! -f "$NEXT_SRC_DIR/dist/index.mjs" ]; then echo "[openclaw] Build artifact missing: $NEXT_SRC_DIR/dist/entry|index.(m)js"; exit 4; fi',
    'mkdir -p /root/.openclaw',
    'printf "{\\n  \\\"repo\\\": \\\"%s\\\",\\n  \\\"tag\\\": \\\"%s\\\",\\n  \\\"tarballUrl\\\": \\\"%s\\\",\\n  \\\"installedAt\\\": \\\"%s\\\"\\n}\\n" "$OPENCLAW_REPO" "$OPENCLAW_TAG" "$OPENCLAW_TARBALL_URL" "$(date -Iseconds)" > /root/.openclaw/openclaw-source-install.json',
    'echo "[openclaw] source build staging complete: $OPENCLAW_REPO@$OPENCLAW_TAG"',
    'node "$NEXT_SRC_DIR/openclaw.mjs" --version 2>/dev/null || node "$NEXT_SRC_DIR/openclaw.mjs" -v 2>/dev/null || true'
  ].join('\n');
}

function buildOpenClawReleaseAssetInstallCommand({ repo, tag, binaryAsset }) {
  const assetName = String(binaryAsset?.name || '').trim();
  const assetUrl = String(binaryAsset?.url || '').trim();
  const assetSource = String(binaryAsset?.source || 'github-release').trim() || 'github-release';
  if (!assetName || !assetUrl) return '';
  const safeRepo = String(repo || '').trim();
  const safeTag = String(tag || '').trim();
  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] Script exited abnormally line=$LINENO exit=$?" >&2\' ERR',
    `OPENCLAW_REPO="${safeRepo.replace(/"/g, '')}"`,
    `OPENCLAW_TAG="${safeTag.replace(/"/g, '')}"`,
    `OPENCLAW_ASSET_NAME="${assetName.replace(/"/g, '')}"`,
    `OPENCLAW_ASSET_URL="${assetUrl.replace(/"/g, '')}"`,
    `OPENCLAW_ASSET_SOURCE="${assetSource.replace(/"/g, '')}"`,
    'OPENCLAW_STATE_ROOT="/root/.openclaw"',
    'PERSIST_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source"',
    'WORK_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw"',
    'TMP_BASE="$OPENCLAW_STATE_ROOT/tmp/openclaw-asset-install"',
    'SESSION_DIR="$(mktemp -d "$TMP_BASE/run.XXXXXX" 2>/dev/null || true)"',
    'if [ -z "$SESSION_DIR" ]; then SESSION_DIR="$TMP_BASE/run.$(date +%s).$$"; fi',
    'ARCHIVE_PATH="$SESSION_DIR/$OPENCLAW_ASSET_NAME"',
    'EXTRACT_DIR="$SESSION_DIR/extract"',
    'mkdir -p "$OPENCLAW_STATE_ROOT" "$OPENCLAW_STATE_ROOT/logs" "$TMP_BASE" "$SESSION_DIR" "$EXTRACT_DIR"',
    'find "$TMP_BASE" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf {} + >/dev/null 2>&1 || true',
    'trap "rm -rf \"$SESSION_DIR\" >/dev/null 2>&1 || true" EXIT',
    'echo "[openclaw] Trying release prebuilt package: $OPENCLAW_ASSET_NAME (source=$OPENCLAW_ASSET_SOURCE)"',
    'echo "[openclaw] Asset direct URL: $OPENCLAW_ASSET_URL"',
    'ASSET_URL_1="$OPENCLAW_ASSET_URL"',
    'ASSET_URL_2="$OPENCLAW_ASSET_URL"',
    'ASSET_URL_3="$OPENCLAW_ASSET_URL"',
    'if [ "$OPENCLAW_ASSET_SOURCE" = "github-release" ]; then',
    '  ASSET_URL_2="https://mirror.ghproxy.com/$OPENCLAW_ASSET_URL"',
    '  ASSET_URL_3="https://ghproxy.net/$OPENCLAW_ASSET_URL"',
    'fi',
    'pick_asset_url() {',
    '  case "$1" in',
    '    1) echo "$ASSET_URL_1" ;;',
    '    2) echo "$ASSET_URL_2" ;;',
    '    *) echo "$ASSET_URL_3" ;;',
    '  esac',
    '}',
    'download_asset() {',
    '  local i=1',
    '  local max_retry=18',
    '  local tmp="$ARCHIVE_PATH.part"',
    '  while [ "$i" -le "$max_retry" ]; do',
    '    local source_idx=$(( ((i - 1) % 3) + 1 ))',
    '    local url="$(pick_asset_url "$source_idx")"',
    '    echo "[openclaw] Downloading prebuilt package attempt $i/$max_retry (source=$source_idx): $url"',
    '    rm -f "$tmp"',
    '    http_code="$(curl -fL --http1.1 --connect-timeout 12 --max-time 1200 --retry 2 --retry-delay 2 --retry-all-errors -o "$tmp" -w "%{http_code}" "$url" 2>/dev/null || true)"',
    '    if [ -s "$tmp" ] && { [ "$http_code" = "200" ] || [ "$http_code" = "206" ]; }; then',
    '      echo "[openclaw] Download succeeded(source=$source_idx, http=$http_code, bytes=$(wc -c < \"$tmp\" 2>/dev/null || echo 0))"',
    '      mv -f "$tmp" "$ARCHIVE_PATH"',
    '      return 0',
    '    fi',
    '    echo "[openclaw] Download failed(source=$source_idx, http=${http_code:-000})，preparing to retry..."',
    '    rm -f "$tmp"',
    '    sleep $(( i < 5 ? 2 : 4 ))',
    '    i=$((i + 1))',
    '  done',
    '  echo "[openclaw][error] Release asset download failed: all sources exhausted ($max_retry attempts)"',
    '  return 21',
    '}',
    'download_asset',
    'echo "[openclaw] Prebuilt package download complete: $ARCHIVE_PATH"',
    'case "$OPENCLAW_ASSET_NAME" in',
    '  *.tar.gz|*.tgz)',
    '    echo "[openclaw] Extracting tar.gz prebuilt package..."',
    '    tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"',
    '    ;;',
    '  *.zip)',
    '    if ! command -v unzip >/dev/null 2>&1; then',
    '      echo "[openclaw][error] Prebuilt package is zip, but image lacks unzip"',
    '      exit 12',
    '    fi',
    '    echo "[openclaw] Extracting zip prebuilt package..."',
    '    unzip -q "$ARCHIVE_PATH" -d "$EXTRACT_DIR"',
    '    ;;',
    '  *)',
    '    echo "[openclaw][error] Unsupported prebuilt package format: $OPENCLAW_ASSET_NAME"',
    '    exit 12',
    '    ;;',
    'esac',
    'echo "[openclaw] Locating openclaw.mjs entry point..."',
    'ASSET_ROOT="$(find "$EXTRACT_DIR" -type f -name openclaw.mjs | head -1 | xargs -I{} dirname "{}")"',
    'if [ -z "$ASSET_ROOT" ] || [ ! -f "$ASSET_ROOT/openclaw.mjs" ]; then',
    '  echo "[openclaw][error] Prebuilt package missing openclaw.mjs"',
    '  exit 13',
    'fi',
    'echo "[openclaw] Prebuilt package root directory: $ASSET_ROOT"',
    '# C4: node --check syntax validation (DFMEA R1)',
    'if command -v node >/dev/null 2>&1; then',
    '  if ! node --check "$ASSET_ROOT/openclaw.mjs" 2>/dev/null; then',
    '    echo "[openclaw][error] openclaw.mjs syntax check failed (node --check), prebuilt package may be corrupted"',
    '    exit 14',
    '  fi',
    '  echo "[openclaw] openclaw.mjs node --check syntax check passed"',
    'fi',
    'if [ ! -f "$ASSET_ROOT/dist/entry.js" ] && [ -f "$ASSET_ROOT/dist/index.js" ]; then ln -sfn index.js "$ASSET_ROOT/dist/entry.js"; fi',
    'if [ ! -f "$ASSET_ROOT/dist/entry.mjs" ] && [ -f "$ASSET_ROOT/dist/index.mjs" ]; then ln -sfn index.mjs "$ASSET_ROOT/dist/entry.mjs"; fi',
    'if [ ! -f "$ASSET_ROOT/dist/entry.js" ] && [ ! -f "$ASSET_ROOT/dist/entry.mjs" ] && [ ! -f "$ASSET_ROOT/dist/index.js" ] && [ ! -f "$ASSET_ROOT/dist/index.mjs" ]; then',
    '  echo "[openclaw][error] Prebuilt package missing dist/entry|index.(m)js"',
    '  exit 13',
    'fi',
    'if [ ! -f "$ASSET_ROOT/dist/control-ui/index.html" ]; then',
    '  echo "[openclaw] WARN: Prebuilt package missing control-ui assets"',
    'fi',
    'if [ "$OPENCLAW_ASSET_SOURCE" = "npm-dist-tarball" ]; then',
    '  if ! command -v npm >/dev/null 2>&1; then',
    '    echo "[openclaw][error] npm-dist asset lacks npm, cannot install runtime dependencies"',
    '    exit 11',
    '  fi',
    '  echo "[openclaw] npm-dist asset: installing runtime dependencies (node_modules)..."',
    '  npm config set fetch-retries 5 >/dev/null 2>&1 || true',
    '  npm config set fetch-retry-mintimeout 2000 >/dev/null 2>&1 || true',
    '  npm config set fetch-retry-maxtimeout 15000 >/dev/null 2>&1 || true',
    '  install_asset_deps() {',
    '    local reg="$1"',
    '    local i=1',
    '    npm config set registry "$reg" >/dev/null 2>&1 || true',
    '    while [ "$i" -le 3 ]; do',
    '      if (cd "$ASSET_ROOT" && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi); then',
    '        return 0',
    '      fi',
    '      echo "[openclaw] npm-dist dependency install failed (registry=$reg, attempt=$i), retrying..."',
    '      sleep 3',
    '      i=$((i + 1))',
    '    done',
    '    return 1',
    '  }',
    '  if ! install_asset_deps https://registry.npmmirror.com; then',
    '    echo "[openclaw] npm-dist dependency install falling back to npmjs registry..."',
    '    install_asset_deps https://registry.npmjs.org',
    '  fi',
    'fi',
    'echo "[openclaw] Installing prebuilt package to staging directory (A/B mode, Gateway uninterrupted)..."',
    'NEXT_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source-next"',
    'rm -rf "$NEXT_SRC_DIR" 2>/dev/null || true',
    'mv -Tf "$ASSET_ROOT" "$NEXT_SRC_DIR"',
    'printf "{\\n  \\\"repo\\\": \\\"%s\\\",\\n  \\\"tag\\\": \\\"%s\\\",\\n  \\\"assetName\\\": \\\"%s\\\",\\n  \\\"assetUrl\\\": \\\"%s\\\",\\n  \\\"installedAt\\\": \\\"%s\\\"\\n}\\n" "$OPENCLAW_REPO" "$OPENCLAW_TAG" "$OPENCLAW_ASSET_NAME" "$OPENCLAW_ASSET_URL" "$(date -Iseconds)" > /root/.openclaw/openclaw-source-install.json',
    'echo "[openclaw] Release asset staging complete: $OPENCLAW_ASSET_NAME"',
    'node "$NEXT_SRC_DIR/openclaw.mjs" --version 2>/dev/null || node "$NEXT_SRC_DIR/openclaw.mjs" -v 2>/dev/null || true'
  ].join('\n');
}

function buildOpenClawPreferredInstallCommand(release, options = {}) {
  const mode = normalizeOpenClawInstallMode(options?.mode || process.env.OPENCLAW_INSTALL_MODE || 'auto');
  const targetVersion = String(release?.installVersion || release?.tag || '').replace(/^v/i, '').trim() || 'latest';
  const npmCmd = buildOpenClawNpmInstallCommand(targetVersion);

  const safeMode = String(mode || 'auto').replace(/"/g, '');
  const safeTag = `v${targetVersion}`.replace(/"/g, '');

  const npmModeBlock = [
    'if (',
    npmCmd,
    '); then',
    '  rm -f /root/.openclaw/openclaw-source-install.json >/dev/null 2>&1 || true',
    '  if runtime_ready_and_latest; then',
    '    echo "[openclaw] npm mode install completed and verified."',
    '  else',
    '    echo "[openclaw][error] npm mode post-install version or entry verification failed."',
    '    exit 43',
    '  fi',
    'else',
    '  rc=$?',
    '  echo "[openclaw][error] npm mode install failed (exit=${rc})"',
    '  exit "$rc"',
    'fi'
  ].join('\n');

  const autoModeBlock = [
    'if current_already_at_target; then',
    '  echo "[openclaw] Current running version satisfies target version, skipping install."',
    '  exit 0',
    'fi',
    'echo "[openclaw] Auto mode: running official npm install..."',
    'if (',
    npmCmd,
    '); then',
    '  rm -f /root/.openclaw/openclaw-source-install.json >/dev/null 2>&1 || true',
    '  if runtime_ready_and_latest; then',
    '    echo "[openclaw] npm path succeeded."',
    '  else',
    '    echo "[openclaw][error] npm path post-verification failed."',
    '    exit 43',
    '  fi',
    'else',
    '  rc=$?',
    '  echo "[openclaw][error] npm path failed (exit=${rc})."',
    '  exit "$rc"',
    'fi'
  ].join('\n');

  const modeBlock = mode === 'npm' ? npmModeBlock : autoModeBlock;

  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] Script exited abnormally line=$LINENO exit=$?" >&2\' ERR',
    `INSTALL_MODE="${safeMode}"`,
    `TARGET_TAG="${safeTag}"`,
    'TARGET_VERSION="${TARGET_TAG#v}"',
    'echo "[openclaw] install mode: ${INSTALL_MODE}"',
    'echo "[openclaw] release tag: ${TARGET_TAG:-unknown}"',
    'echo "[openclaw] install source: npm"',
    'NEXT_SRC_DIR="/root/.openclaw/openclaw-source-next"',
    'PREV_SRC_DIR="/root/.openclaw/openclaw-source-prev"',
    'PERSIST_SRC_DIR="/root/.openclaw/openclaw-source"',
    'WORK_SRC_DIR="/root/.openclaw/openclaw"',
    'OPENCLAW_RUNTIME_TMP_ROOT="${OPENCLAW_RUNTIME_TMP_ROOT:-/tmp/openclaw-runtime}"',
    '# Clean up leftover staging directory',
    'rm -rf "$NEXT_SRC_DIR" 2>/dev/null || true',
    'detect_mount_fstype() {',
    '  local target="$1"',
    `  df -T "$target" 2>/dev/null | awk 'NR==2 {print $2}' | head -1`,
    '}',
    'path_requires_local_runtime() {',
    '  local fstype',
    '  fstype=$(detect_mount_fstype "$1")',
    '  case "$fstype" in',
    '    9p|drvfs|virtiofs|fuse.osxfs|fuse.portal)',
    '      return 0',
    '      ;;',
    '  esac',
    '  return 1',
    '}',
    'sync_runtime_source_to_local() {',
    '  local src="$1"',
    '  local dst="$2"',
    '  if command -v rsync >/dev/null 2>&1; then',
    '    mkdir -p "$dst"',
    '    rsync -a --delete "$src/" "$dst/"',
    '    return $? ',
    '  fi',
    '  rm -rf "$dst"',
    '  mkdir -p "$dst"',
    '  cp -a "$src/." "$dst/"',
    '}',
    'runtime_source_mirror_is_current() {',
    '  local src="$1"',
    '  local dst="$2"',
    '  [ -f "$src/package.json" ] || return 1',
    '  [ -f "$dst/package.json" ] || return 1',
    '  [ -f "$dst/openclaw.mjs" ] || return 1',
    '  cmp -s "$src/package.json" "$dst/package.json"',
    '}',
    'AB_GATEWAY_SOURCE_ROOT="$PERSIST_SRC_DIR"',
    'prepare_ab_gateway_source_root() {',
    '  local persist_root="$1"',
    '  AB_GATEWAY_SOURCE_ROOT="$persist_root"',
    '  if [ ! -f "$persist_root/openclaw.mjs" ]; then',
    '    return 0',
    '  fi',
    '  mkdir -p "$OPENCLAW_RUNTIME_TMP_ROOT/tmp"',
    '  export TMPDIR="$OPENCLAW_RUNTIME_TMP_ROOT/tmp"',
    '  if ! path_requires_local_runtime "$persist_root"; then',
    '    return 0',
    '  fi',
    '  local runtime_source_dir="$OPENCLAW_RUNTIME_TMP_ROOT/openclaw-source"',
    '  if runtime_source_mirror_is_current "$persist_root" "$runtime_source_dir"; then',
    '    AB_GATEWAY_SOURCE_ROOT="$runtime_source_dir"',
    '    echo "[openclaw][runtime] Reusing local runtime source mirror: $AB_GATEWAY_SOURCE_ROOT"',
    '    return 0',
    '  fi',
    '  if sync_runtime_source_to_local "$persist_root" "$runtime_source_dir"; then',
    '    AB_GATEWAY_SOURCE_ROOT="$runtime_source_dir"',
    '    echo "[openclaw][runtime] Using local runtime source mirror: $AB_GATEWAY_SOURCE_ROOT"',
    '    return 0',
    '  fi',
    '  echo "[openclaw][runtime] WARN: failed to mirror OpenClaw source locally, fallback to persistent source: $persist_root"',
    '  return 0',
    '}',
    'verify_runtime_entry() {',
    '  local check_dir="${1:-$NEXT_SRC_DIR}"',
    '  if [ -f "$check_dir/openclaw.mjs" ]; then',
    '    if [ ! -f "$check_dir/dist/entry.js" ] && [ ! -f "$check_dir/dist/entry.mjs" ] && [ ! -f "$check_dir/dist/index.js" ] && [ ! -f "$check_dir/dist/index.mjs" ]; then',
    '      return 1',
    '    fi',
    '    if command -v timeout >/dev/null 2>&1; then',
    '      timeout 30 node --experimental-sqlite "$check_dir/openclaw.mjs" --version >/dev/null 2>&1 || return 1',
    '    else',
    '      node --experimental-sqlite "$check_dir/openclaw.mjs" --version >/dev/null 2>&1 || return 1',
    '    fi',
    '    return 0',
    '  fi',
    '  # Only fallback to global command when checking current run directory (PERSIST_SRC_DIR)',
    '  if [ "$check_dir" = "$PERSIST_SRC_DIR" ]; then',
    '    if command -v openclaw >/dev/null 2>&1 || [ -x /root/.npm-global/bin/openclaw ] || [ -x /usr/local/bin/openclaw ]; then',
    '      return 0',
    '    fi',
    '  fi',
    '  return 1',
    '}',
    'current_openclaw_version() {',
    '  local check_dir="${1:-$NEXT_SRC_DIR}"',
    '  local raw=""',
    '  if [ -f "$check_dir/openclaw.mjs" ]; then',
    '    raw="$(node --experimental-sqlite "$check_dir/openclaw.mjs" --version 2>/dev/null || true)"',
    '  fi',
    '  if [ -z "$raw" ]; then',
    '    if [ -f "$check_dir/package.json" ]; then',
    '      raw="$(node -e "try{const p=require(\\"$check_dir/package.json\\");console.log(p.version||\\"\\")}catch(e){}" 2>/dev/null || true)"',
    '    fi',
    '  fi',
    '  # Only fallback to global command when checking current run directory',
    '  if [ -z "$raw" ] && [ "$check_dir" = "$PERSIST_SRC_DIR" ]; then',
    '    if command -v openclaw >/dev/null 2>&1; then',
    '      raw="$(openclaw --version 2>/dev/null || openclaw -v 2>/dev/null || true)"',
    '    elif [ -x /root/.npm-global/bin/openclaw ]; then',
    '      raw="$(/root/.npm-global/bin/openclaw --version 2>/dev/null || /root/.npm-global/bin/openclaw -v 2>/dev/null || true)"',
    '    elif [ -x /usr/local/bin/openclaw ]; then',
    '      raw="$(/usr/local/bin/openclaw --version 2>/dev/null || /usr/local/bin/openclaw -v 2>/dev/null || true)"',
    '    fi',
    '  fi',
    '  raw="$(printf "%s" "$raw" | tr -d "\\r" | grep -Eo "[0-9]+\\.[0-9]+\\.[0-9]+([-.][0-9A-Za-z.]+)?" | head -n1 || true)"',
    '  printf "%s" "$raw"',
    '}',
    'version_matches_target() {',
    '  local check_dir="${1:-$NEXT_SRC_DIR}"',
    '  if [ -z "$TARGET_VERSION" ]; then',
    '    return 0',
    '  fi',
    '  local current',
    '  current="$(current_openclaw_version "$check_dir")"',
    '  if [ -z "$current" ]; then',
    '    echo "[openclaw] WARN: Current version not detected, continuing as entry point is available"',
    '    return 0',
    '  fi',
    '  if [ "$current" = "$TARGET_VERSION" ]; then',
    '    echo "[openclaw] Version check passed: ${current}"',
    '    return 0',
    '  fi',
    '  echo "[openclaw] Version check failed: current=${current} target=${TARGET_VERSION}"',
    '  return 1',
    '}',
    '# Validate staging NEXT_SRC_DIR',
    'runtime_ready_and_latest() { verify_runtime_entry "$NEXT_SRC_DIR" && version_matches_target "$NEXT_SRC_DIR"; }',
    '# Validate current running version (PERSIST_SRC_DIR)',
    'current_already_at_target() { verify_runtime_entry "$PERSIST_SRC_DIR" && version_matches_target "$PERSIST_SRC_DIR"; }',
    modeBlock,
    '',
    '# ===== A/B swap: Stop Gateway → Replace → Start Gateway → Verify → Rollback =====',
    'echo "[openclaw][A/B] Install succeeded, starting version swap..."',
    'if [ ! -d "$NEXT_SRC_DIR" ]; then',
    '  echo "[openclaw][error] staging directory missing: $NEXT_SRC_DIR"',
    '  exit 50',
    'fi',
    '# Step 1: Stop Gateway process',
    'echo "[openclaw][A/B] Step 1/4: Stopping Gateway..."',
    'AB_GW_PID="$(pgrep -x openclaw-gateway 2>/dev/null || pgrep -x openclaw-gatewa 2>/dev/null || true)"',
    'AB_HAD_GATEWAY=0',
    'if [ -n "$AB_GW_PID" ]; then',
    '  AB_HAD_GATEWAY=1',
    '  echo "[openclaw][A/B] Found Gateway PID=$AB_GW_PID, stopping..."',
    '  kill -TERM "$AB_GW_PID" 2>/dev/null || true',
    '  pkill -TERM -P "$AB_GW_PID" 2>/dev/null || true',
    '  _ab_waited=0',
    '  while [ "$_ab_waited" -lt 5 ] && kill -0 "$AB_GW_PID" 2>/dev/null; do',
    '    sleep 1',
    '    _ab_waited=$((_ab_waited + 1))',
    '  done',
    'fi',
    'pkill -9 -x "openclaw-gateway" 2>/dev/null || true',
    'pkill -9 -x "openclaw-gatewa" 2>/dev/null || true',
    '# Use pgrep + grep -v to exclude self and parent, prevent pkill -f matching script command line',
    '_SELF_PIDS="^($$|$PPID)\\$"',
    'pgrep -f "openclaw.mjs gateway" 2>/dev/null | grep -vE "$_SELF_PIDS" | xargs -r kill -9 2>/dev/null || true',
    'pgrep -f "openclaw.*gateway run" 2>/dev/null | grep -vE "$_SELF_PIDS" | xargs -r kill -9 2>/dev/null || true',
    'sleep 1',
    'echo "[openclaw][A/B] Gateway stopped"',
    '',
    '# Step 2: Atomic directory swap',
    'echo "[openclaw][A/B] Step 2/4: Performing version directory swap..."',
    'rm -rf "$PREV_SRC_DIR" 2>/dev/null || true',
    'if [ -d "$PERSIST_SRC_DIR" ] || [ -L "$PERSIST_SRC_DIR" ]; then',
    '  mv -f "$PERSIST_SRC_DIR" "$PREV_SRC_DIR" 2>/dev/null || true',
    '  echo "[openclaw][A/B] Old version stashed to $PREV_SRC_DIR"',
    'fi',
    'mv -Tf "$NEXT_SRC_DIR" "$PERSIST_SRC_DIR"',
    'ln -sfn "$PERSIST_SRC_DIR" "$WORK_SRC_DIR"',
    'echo "[openclaw][A/B] Version directory swap complete: openclaw-source → new version"',
    '',
    '# Step 3: Start Gateway and verify',
    'echo "[openclaw][A/B] Step 3/4: Starting Gateway and verifying..."',
    'AB_GATEWAY_OK=0',
    'AB_LAUNCH_CMD=""',
    'prepare_ab_gateway_source_root "$PERSIST_SRC_DIR"',
    'if [ -f "$PERSIST_SRC_DIR/openclaw.mjs" ]; then',
    '  AB_LAUNCH_CMD="node --experimental-sqlite $AB_GATEWAY_SOURCE_ROOT/openclaw.mjs gateway run --force --allow-unconfigured"',
    'elif command -v openclaw >/dev/null 2>&1; then',
    '  AB_LAUNCH_CMD="openclaw gateway run --force --allow-unconfigured"',
    'elif [ -x /root/.npm-global/bin/openclaw ]; then',
    '  AB_LAUNCH_CMD="/root/.npm-global/bin/openclaw gateway run --force --allow-unconfigured"',
    'fi',
    'if [ -n "$AB_LAUNCH_CMD" ]; then',
    '  GATEWAY_LOG="/root/.openclaw/logs/openclaw-gateway.log"',
    '  mkdir -p "$(dirname "$GATEWAY_LOG")" 2>/dev/null || true',
    '  echo "" >> "$GATEWAY_LOG"',
    '  echo "===== [$(date -u +%FT%T.%3NZ)] A/B swap: starting new Gateway =====" >> "$GATEWAY_LOG"',
    '  echo "[openclaw][A/B] Startup source path: ${AB_GATEWAY_SOURCE_ROOT}"',
    '  nohup bash --noprofile --norc -lc "$AB_LAUNCH_CMD" >> "$GATEWAY_LOG" 2>&1 &',
    '  AB_GW_NEW_PID=$!',
    '  echo "[openclaw][A/B] Gateway started PID=$AB_GW_NEW_PID, waiting for health check..."',
    '  AB_HEALTH_WAIT=0',
    '  AB_HEALTH_TIMEOUT=300',
    '  AB_GW_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"',
    '  while [ "$AB_HEALTH_WAIT" -lt "$AB_HEALTH_TIMEOUT" ]; do',
    '    if curl -sf --max-time 3 "http://127.0.0.1:${AB_GW_PORT}/health" >/dev/null 2>&1; then',
    '      AB_GATEWAY_OK=1',
    '      break',
    '    fi',
    '    if ! kill -0 "$AB_GW_NEW_PID" 2>/dev/null; then',
    '      echo "[openclaw][A/B] Gateway process exited unexpectedly"',
    '      break',
    '    fi',
    '    sleep 3',
    '    AB_HEALTH_WAIT=$((AB_HEALTH_WAIT + 3))',
    '    if [ "$((AB_HEALTH_WAIT % 15))" -eq 0 ]; then',
    '      echo "[openclaw][A/B] Waiting for Gateway health check... ${AB_HEALTH_WAIT}s/${AB_HEALTH_TIMEOUT}s"',
    '    fi',
    '  done',
    'else',
    '  echo "[openclaw][A/B] Gateway start command not found, skipping health check"',
    '  AB_GATEWAY_OK=1',
    'fi',
    '',
    '# Step 4: Verify result, rollback if failed',
    'if [ "$AB_GATEWAY_OK" = "1" ]; then',
    '  echo "[openclaw][A/B] ✅ Gateway health check passed, version swap succeeded!"',
    '  rm -rf "$PREV_SRC_DIR" 2>/dev/null || true',
    '  FINAL_VER="$(current_openclaw_version "$PERSIST_SRC_DIR")"',
    '  echo "[openclaw][A/B] Current version: ${FINAL_VER:-unknown}"',
    'else',
    '  echo "[openclaw][A/B] ❌ Gateway health check failed, performing version rollback..."',
    '  # Stop new Gateway',
    '  pkill -9 -x "openclaw-gateway" 2>/dev/null || true',
    '  pkill -9 -x "openclaw-gatewa" 2>/dev/null || true',
    '  pgrep -f "openclaw.mjs gateway" 2>/dev/null | grep -vE "$_SELF_PIDS" | xargs -r kill -9 2>/dev/null || true',
    '  pgrep -f "openclaw.*gateway run" 2>/dev/null | grep -vE "$_SELF_PIDS" | xargs -r kill -9 2>/dev/null || true',
    '  sleep 1',
    '  # Rollback directory',
    '  if [ -d "$PREV_SRC_DIR" ] || [ -L "$PREV_SRC_DIR" ]; then',
    '    rm -rf "$PERSIST_SRC_DIR" 2>/dev/null || true',
    '    mv -f "$PREV_SRC_DIR" "$PERSIST_SRC_DIR"',
    '    ln -sfn "$PERSIST_SRC_DIR" "$WORK_SRC_DIR"',
    '    echo "[openclaw][A/B] Rolled back to old version"',
    '    # Restart old version Gateway',
    '    if [ "$AB_HAD_GATEWAY" = "1" ] && [ -f "$PERSIST_SRC_DIR/openclaw.mjs" ]; then',
    '      prepare_ab_gateway_source_root "$PERSIST_SRC_DIR"',
    '      ROLLBACK_CMD="node --experimental-sqlite $AB_GATEWAY_SOURCE_ROOT/openclaw.mjs gateway run --force --allow-unconfigured"',
    '      echo "" >> "$GATEWAY_LOG"',
    '      echo "===== [$(date -u +%FT%T.%3NZ)] A/B rollback: restarting old Gateway =====" >> "$GATEWAY_LOG"',
      '      echo "[openclaw][A/B] Rollback startup source path: ${AB_GATEWAY_SOURCE_ROOT}"',
    '      nohup bash --noprofile --norc -lc "$ROLLBACK_CMD" >> "$GATEWAY_LOG" 2>&1 &',
    '      echo "[openclaw][A/B] Old version Gateway restarted PID=$!"',
    '    fi',
    '  else',
    '    echo "[openclaw][A/B][warn] No old version to roll back to"',
    '  fi',
    '  echo "[openclaw][A/B] ❌ Update failed and rolled back, Gateway health check timed out"',
    '  exit 51',
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
    let installed = !!detected.installed;
    const runtimeReady = detected.runtimeReady !== false;
    const runtimeIssue = String(detected.runtimeIssue || '').trim();
    let runtimeRecoveryTriggered = false;
    let runtimeRecoveryTaskId = '';
    let runtimeRecoveryReason = '';
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
    const hasLinuxBinaryAsset = latestOpenClawVersionCache.hasLinuxBinaryAsset;
    const latestReleaseAssetsSummary = latestOpenClawVersionCache.assetsSummary || '';

    let hasUpdate = !!(installed && version && latestVersion && compareSemver(latestVersion, version) > 0);

    const gatewayLogTail = readGatewayLogTail(300);
    const invalidConfigKeys = detectInvalidConfigKeysFromText(gatewayLogTail);
    const gatewayPairingRequired = !isGatewayDeviceAuthDisabled()
      && detectGatewayPairingRequiredRecent(gatewayLogTail, 900);
    const discordConnectError = detectDiscordConnectError(gatewayLogTail);

    // Run independent shell commands in parallel to reduce response time
    const gatewayPidCmd = [
      'pid="$(pgrep -x openclaw-gateway 2>/dev/null | head -1 || true)"',
      'if [ -z "$pid" ]; then pid="$(pgrep -x openclaw-gatewa 2>/dev/null | head -1 || true)"; fi',
      'if [ -z "$pid" ]; then pid="$(pgrep -f "[o]penclaw\\.mjs gateway" 2>/dev/null | head -1 || true)"; fi',
      'if [ -z "$pid" ]; then pid="$(pgrep -f "[o]penclaw[^\\n]*gateway run" 2>/dev/null | head -1 || true)"; fi',
      'if [ -z "$pid" ]; then',
      '  for candidate in $(pgrep -x openclaw 2>/dev/null || true); do',
      '    cmdline="$(cat /proc/$candidate/cmdline 2>/dev/null | tr "\\000" " ")"',
      '    comm="$(cat /proc/$candidate/comm 2>/dev/null || true)"',
      '    if [ "$comm" = "bash" ] || [ "$comm" = "sh" ] || [ "$comm" = "timeout" ]; then continue; fi',
      '    case "$cmdline" in',
      '      *"gateway run"*|*" openclaw gateway"*) pid="$candidate"; break ;;',
      '    esac',
      '  done',
      'fi',
      'printf "%s" "$pid"'
    ].join('\n');

    const [gatewayHealthCodeText, gatewayRuntimePid, gatewayWatchdogRunning, externalInstallProcessDetected] = await Promise.all([
      runCommandTextAsync(LOCAL_GATEWAY_HEALTH_CHECK_CMD, 3000),
      runCommandTextAsync(gatewayPidCmd, 1200),
      runCommandOkAsync('pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1', 1200),
      runCommandOkAsync('pgrep -f "[i]nstall-imageonly" >/dev/null 2>&1 || pgrep -f "[n]pm.*install.*openclaw" >/dev/null 2>&1', 2000)
    ]);
    const gatewayHealthCode = Number.parseInt(String(gatewayHealthCodeText || '').trim(), 10) || 0;
    const gatewayRunning = gatewayHealthCode === 200;
    const gatewayPidSafe = Number.parseInt(String(gatewayRuntimePid || '').trim(), 10) || 0;

    // Second batch: dependent on PID result
    const [gatewayProcessUptimeText, portListening] = await Promise.all([
      gatewayPidSafe > 0
        ? runCommandTextAsync(`ps -o etimes= -p ${gatewayPidSafe} 2>/dev/null || true`, 1200)
        : Promise.resolve(''),
      !gatewayPidSafe
        ? runCommandOkAsync('ss -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]" || netstat -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]"', 1200)
        : Promise.resolve(false)
    ]);
    const gatewayProcessRunning = !!gatewayPidSafe || portListening;
    const gatewayProcessUptimeSec = Number.parseInt(String(gatewayProcessUptimeText || '').trim(), 10) || 0;

    let operationState = getOpenClawOperationState();
    let installTaskRunning = isTaskRunning(installLogs, activeInstallTaskId);
    let activeInstallTask = activeInstallTaskId ? installLogs[activeInstallTaskId] : null;

    const installRelatedOp = (type) => type === 'installing' || type === 'updating' || type === 'uninstalling';
    if (installTaskRunning && activeInstallTask && installRelatedOp(operationState.type)) {
      const taskPid = Number(activeInstallTask.pid || 0) || 0;
      const pidAlive = taskPid > 1 ? (() => {
        try {
          process.kill(taskPid, 0);
          return true;
        } catch {
          return false;
        }
      })() : false;
      const taskLastOutputAt = Number(activeInstallTask.lastOutputAt || activeInstallTask.startedAt || Date.now());
      const silentSec = Math.max(0, Math.floor((Date.now() - taskLastOutputAt) / 1000));
      if (taskPid > 1 && !pidAlive && silentSec > 25) {
        appendInstallLog(activeInstallTask, `[openclaw] Detected install subprocess has exited (pid=${taskPid}）and  ${silentSec}s no output, auto-ending task.\n`);
        activeInstallTask.status = 'failed';
        activeInstallTask.exitCode = Number.isFinite(activeInstallTask.exitCode) ? activeInstallTask.exitCode : -3;
        activeInstallTask.error = activeInstallTask.error || 'Install subprocess exited abnormally';
        installTaskRunning = false;
        activeInstallTaskId = '';
        activeInstallTask = null;
        clearOpenClawOperationState(operationState.type);
        operationState = getOpenClawOperationState();
      }
    }

    if (!installTaskRunning && installRelatedOp(operationState.type)) {
      clearOpenClawOperationState(operationState.type);
      operationState = getOpenClawOperationState();
    }

    if (installTaskRunning && operationState.type === 'idle' && installed && version) {
      const ageSec = Math.max(0, Math.floor((Date.now() - Number(activeInstallTask?.startedAt || Date.now())) / 1000));
      if (ageSec > 90) {
        appendInstallLog(activeInstallTask, `[openclaw] Detected task state inconsistent with operation lock, auto-ended task (age=${ageSec}s）。\n`);
        activeInstallTask.status = 'failed';
        activeInstallTask.exitCode = Number.isFinite(activeInstallTask.exitCode) ? activeInstallTask.exitCode : -2;
        installTaskRunning = false;
        activeInstallTaskId = '';
        activeInstallTask = null;
      }
    }

    if (!runtimeReady && operationState.type === 'idle' && !installTaskRunning) {
      // Detected external install process (e.g. user directly ran install-imageonly.sh or npm install -g openclaw),
      // skipping auto-recovery to avoid duplicate install, letting frontend show "Installing" instead of "Not Installed"
      if (externalInstallProcessDetected) {
        operationState = { type: 'installing', taskId: '', startedAt: 0, pid: 0, external: true };
        installTaskRunning = true;
      } else {
        const recovery = await maybeTriggerOpenClawRuntimeRecovery(runtimeIssue || 'runtime-artifacts-missing');
        if (recovery?.triggered && recovery.taskId) {
          runtimeRecoveryTriggered = true;
          runtimeRecoveryTaskId = recovery.taskId;
          runtimeRecoveryReason = 'auto-runtime-recovery';
          activeInstallTaskId = recovery.taskId;
          activeInstallTask = installLogs[recovery.taskId] || null;
          installTaskRunning = true;
        } else if (recovery?.reason) {
          runtimeRecoveryReason = recovery.reason;
        }
      }
    }

    if (!runtimeReady && !installTaskRunning) {
      installed = false;
    }
    hasUpdate = !!(installed && version && latestVersion && compareSemver(latestVersion, version) > 0);
    const repairTaskRunning = isTaskRunning(repairLogs, activeRepairTaskId) || isRepairLockActive();
    const operationProgress = buildOpenClawOperationProgress(operationState);
    const gatewayWarmupByProcess = !!(
      installed
      && !gatewayRunning
      && gatewayProcessRunning
      && gatewayProcessUptimeSec > 0
      && gatewayProcessUptimeSec <= 600
    );
    const gatewayRestartingByOp = !!(
      installed
      &&
      operationState?.type === 'restarting_gateway'
      && (gatewayProcessRunning || gatewayRunning)
    );
    const gatewayWarmupByWatchdog = !!(
      installed
      &&
      !gatewayRunning
      && gatewayWatchdogRunning
      && isGatewayWatchdogStartupInProgress(900)
    );
    const gatewayStarting = gatewayWarmupByProcess || gatewayRestartingByOp || gatewayWarmupByWatchdog;
    const lastBackupAt = getLastBackupAt();
    const lastRollbackAt = getLastRollbackAtFromWatchdog();

    res.json({
      installed,
      version,
      latestVersion,
      hasUpdate,
      updateCheckError,
      hasLinuxBinaryAsset,
      latestReleaseAssetsSummary,
      gatewayRunning,
      gatewayProcessRunning,
      gatewayStarting,
      gatewayProcessUptimeSec,
      gatewayHealthCode,
      gatewayWatchdogRunning,
      gatewayPairingRequired,
      discordConnectError,
      invalidConfigKeys,
      installSource: detected.source,
      runtimeReady,
      runtimeIssue,
      runtimeRecoveryTriggered,
      runtimeRecoveryTaskId,
      runtimeRecoveryReason,
      installTaskRunning,
      activeInstallTaskId,
      activeInstallLogFile: activeInstallTask?.logFile || OPENCLAW_INSTALL_LOG_FILE,
      repairTaskRunning,
      operationState,
      operationProgress,
      lastBackupAt,
      lastRollbackAt
    });
  } catch (e) {
    const detail = e?.message || String(e || 'Status read failed');
    console.error('[openclaw][status] failed:', detail);
    res.status(500).json({ error: detail });
  }
});

app.get('/api/openclaw/status', async (req, res) => {
  req.url = '/api/openclaw';
  return app._router.handle(req, res, () => {});
});

app.get('/api/openclaw/gateway-link', (req, res) => {
  try {
    const accessPatch = ensureGatewayControlUiAccessForRequest(req);
    if (accessPatch?.changed) {
      console.log(`[openclaw][gateway-link] patched controlUi/trustedProxies for host=${accessPatch.host || 'unknown'}`);
      // Trigger watchdog to restart gateway
      const opState = getOpenClawOperationState();
      if (opState.type === 'idle') {
        queueGatewayRestart('gateway-link-patch');
      }
    }

    const cfg = readJson(CONFIG_PATH, {});
    const ocSnapshot = getOpenClawInstallationSnapshot();
    const authMode = String(cfg?.gateway?.auth?.mode || 'none').trim() || 'none';
    const rawToken = normalizeGatewayAuthToken(cfg?.gateway?.auth?.token || '');
    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const protoHeader = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim().toLowerCase();
    const hostname = (hostHeader.split(':')[0] || '127.0.0.1').trim();
    const externalProto = (protoHeader === 'https' ? 'https' : 'http');
    const uiVersionStamp = String(ocSnapshot?.version || '').trim();

    const appendGatewayUiVersion = (url) => {
      const rawUrl = String(url || '').trim();
      if (!rawUrl || !uiVersionStamp) return rawUrl;
      const hashIndex = rawUrl.indexOf('#');
      const base = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
      const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : '';
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}uiVersion=${encodeURIComponent(uiVersionStamp)}${hash}`;
    };

    const gatewayPort = Number(cfg?.port || 18789) || 18789;
    const directBase = `http://${hostname}:${gatewayPort}/`;
    const tokenHash = rawToken ? `#token=${encodeURIComponent(rawToken)}` : '';
    const directUrl = appendGatewayUiVersion(`${directBase}${tokenHash}`);
    const proxyUrl = `/${'gateway-proxy/'}`;
    const externalProxyUrl = appendGatewayUiVersion(`${externalProto}://${hostHeader || hostname}${proxyUrl}${tokenHash}`);
    const externalGatewayUrl = appendGatewayUiVersion(`${externalProto}://${hostHeader || hostname}/gateway${tokenHash}`);

    const preferredUrl = externalGatewayUrl;

    let hint = '';
    const opState = getOpenClawOperationState();
    const gatewayBusy = opState.type === 'restarting_gateway' || opState.type === 'installing' || opState.type === 'updating';
    if (gatewayBusy) {
      hint = 'Gateway starting, please wait a moment before opening the console.';
    } else if (authMode === 'token' && !rawToken) {
      hint = 'Gateway is in Token mode but no token found, falling back to proxy address.';
    } else if (authMode !== 'token' && authMode !== 'none') {
      hint = `Gateway Current auth mode is ${authMode}，you may need to manually enter credentials in the console.`;
    }

    // Check gateway health status
    let gatewayReady = false;
    try {
      const healthText = runCommandText(LOCAL_GATEWAY_HEALTH_CHECK_CMD, 3000);
      gatewayReady = Number.parseInt(String(healthText || '').trim(), 10) === 200;
    } catch {}

    res.json({
      success: true,
      authMode,
      hasToken: !!rawToken,
      preferredUrl,
      externalGatewayUrl,
      externalProxyUrl,
      directUrl,
      proxyUrl,
      hint,
      gatewayReady,
      gatewayBusy
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Gateway link generation failed' });
  }
});

app.post('/api/openclaw/config/repair', (req, res) => {
  try {
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle' && opState.type !== 'repairing_config') {
      return res.status(409).json({ success: false, error: `Operation in progress: ${opState.type}`, operationState: opState });
    }
    if (opState.type === 'repairing_config' && opState.taskId) {
      return res.json({ success: true, taskId: opState.taskId, reused: true, message: 'Repair task in progress, please do not trigger again' });
    }
    if (isRepairLockActive()) {
      const runningTaskId = isTaskRunning(repairLogs, activeRepairTaskId) ? activeRepairTaskId : '';
      return res.json({ success: true, taskId: runningTaskId, reused: true, message: 'Repair task in progress, please do not trigger again' });
    }
    if (isTaskRunning(repairLogs, activeRepairTaskId)) {
      return res.json({ success: true, taskId: activeRepairTaskId, reused: true });
    }
    const taskId = runOpenClawRepairTask();
    if (!taskId) return res.status(409).json({ success: false, error: 'Repair task creation failed: concurrent operation in progress', operationState: getOpenClawOperationState() });
    res.json({ success: true, taskId });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Repair task creation failed' });
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

// --- Migration Export (full data for container migration) ---
app.get('/api/openclaw/migration/export', async (req, res) => {
  try {
    const OPENCLAW_BASE = path.dirname(CONFIG_PATH);
    const { execSync } = require('child_process');
    // Individual files to copy (openclaw app data only, no container infra)
    const FILE_MAP = {
      'openclaw.json': CONFIG_PATH,
      'openclaw.json.bak': `${CONFIG_PATH}.bak`,
      '.enc_key': path.join(OPENCLAW_BASE, '.enc_key'),
      'exec-approvals.json': path.join(OPENCLAW_BASE, 'exec-approvals.json'),
      'subagents/runs.json': path.join(OPENCLAW_BASE, 'subagents/runs.json'),
    };
    // Directories to copy recursively
    const DIR_MAP = {
      'identity': path.join(OPENCLAW_BASE, 'identity'),
      'devices': path.join(OPENCLAW_BASE, 'devices'),
      'cron': path.join(OPENCLAW_BASE, 'cron'),
      'agents': path.join(OPENCLAW_BASE, 'agents'),
      'workspace': path.join(OPENCLAW_BASE, 'workspace'),
      'feishu': path.join(OPENCLAW_BASE, 'feishu'),
      'canvas': path.join(OPENCLAW_BASE, 'canvas'),
      'delivery-queue': path.join(OPENCLAW_BASE, 'delivery-queue'),
      'skills': path.join(OPENCLAW_BASE, 'skills'),
      'config-backups': path.join(OPENCLAW_BASE, 'config-backups'),
    };
    const tmpDir = `/tmp/openclaw-migration-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    const included = [];
    // Copy individual files
    for (const [name, src] of Object.entries(FILE_MAP)) {
      if (fs.existsSync(src)) {
        const dest = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        included.push(name);
      }
    }
    // Copy directories (exclude .git inside workspace to save space)
    for (const [name, src] of Object.entries(DIR_MAP)) {
      if (fs.existsSync(src)) {
        const dest = path.join(tmpDir, name);
        fs.mkdirSync(dest, { recursive: true });
        try {
          if (name === 'workspace') {
            execSync(`cp -r ${JSON.stringify(src)}/. ${JSON.stringify(dest)}/ && rm -rf ${JSON.stringify(dest)}/.git`, { stdio: 'pipe', timeout: 30000 });
          } else {
            execSync(`cp -r ${JSON.stringify(src)}/. ${JSON.stringify(dest)}/`, { stdio: 'pipe', timeout: 30000 });
          }
          included.push(name + '/');
        } catch {}
      }
    }
    if (included.length === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return res.status(404).json({ error: 'No exportable data files' });
    }
    fs.writeFileSync(path.join(tmpDir, '_migration-meta.json'), JSON.stringify({
      exportTime: new Date().toISOString(),
      files: included,
      version: 'openclaw-migration-v1',
      sourceImage: (() => { try { return fs.readFileSync(path.join(OPENCLAW_BASE, 'image-release-tag.txt'), 'utf8').trim(); } catch { return 'unknown'; } })()
    }, null, 2));
    const tgzPath = `${tmpDir}.tar.gz`;
    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
      exec(`tar -czf ${JSON.stringify(tgzPath)} -C ${JSON.stringify(tmpDir)} .`, { timeout: 30000 }, (err) => err ? reject(err) : resolve());
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const stat = fs.statSync(tgzPath);
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="openclaw-migration-${ts}.tar.gz"`);
    const stream = fs.createReadStream(tgzPath);
    stream.pipe(res);
    res.on('close', () => { try { fs.unlinkSync(tgzPath); } catch {} });
  } catch (e) {
    console.error(`[migration-export] Export failed: ${e?.message}`);
    if (!res.headersSent) res.status(500).json({ error: e?.message || 'Migration export failed' });
  }
});

// --- Migration Import (restore full data from migration archive) ---
app.post('/api/openclaw/migration/import', (req, res) => {
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/gzip') && !contentType.includes('application/octet-stream') && !contentType.includes('application/x-gzip') && !contentType.includes('application/x-tar')) {
      return res.status(400).json({ error: 'Please upload a .tar.gz migration package' });
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 20) return res.status(400).json({ error: 'File too small, invalid archive' });
        if (buf.length > 50 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 50MB)' });
        const tmpTgz = `/tmp/openclaw-migration-import-${Date.now()}.tar.gz`;
        const tmpDir = `/tmp/openclaw-migration-import-${Date.now()}`;
        fs.writeFileSync(tmpTgz, buf);
        fs.mkdirSync(tmpDir, { recursive: true });
        const { execSync } = require('child_process');
        execSync(`tar -xzf ${JSON.stringify(tmpTgz)} -C ${JSON.stringify(tmpDir)}`, { stdio: 'pipe', timeout: 30000 });
        fs.unlinkSync(tmpTgz);
        // Verify it's a migration archive
        const metaPath = path.join(tmpDir, '_migration-meta.json');
        if (!fs.existsSync(metaPath)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return res.status(400).json({ error: 'Invalid migration package (missing _migration-meta.json)' });
        }
        const OPENCLAW_BASE = path.dirname(CONFIG_PATH);
        // Backup current state before overwrite
        const backupTs = Date.now();
        const preImportBackup = `/tmp/openclaw-pre-migration-backup-${backupTs}`;
        try {
          execSync(`cp -r ${JSON.stringify(OPENCLAW_BASE)} ${JSON.stringify(preImportBackup)}`, { stdio: 'pipe', timeout: 30000 });
        } catch {}
        // Restore individual files
        const restoredFiles = [];
        const RESTORE_FILES = {
          'openclaw.json': CONFIG_PATH,
          'openclaw.json.bak': `${CONFIG_PATH}.bak`,
          '.enc_key': path.join(OPENCLAW_BASE, '.enc_key'),
          'exec-approvals.json': path.join(OPENCLAW_BASE, 'exec-approvals.json'),
          'subagents/runs.json': path.join(OPENCLAW_BASE, 'subagents/runs.json'),
        };
        for (const [name, target] of Object.entries(RESTORE_FILES)) {
          const srcFile = path.join(tmpDir, name);
          if (!fs.existsSync(srcFile)) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(srcFile, target);
          if (name === '.enc_key') try { fs.chmodSync(target, 0o600); } catch {}
          restoredFiles.push(name);
        }
        // Restore directories
        const RESTORE_DIRS = ['identity', 'devices', 'cron', 'agents', 'workspace', 'feishu', 'canvas', 'delivery-queue', 'skills', 'config-backups'];
        for (const dirName of RESTORE_DIRS) {
          const srcDir = path.join(tmpDir, dirName);
          if (!fs.existsSync(srcDir)) continue;
          const destDir = path.join(OPENCLAW_BASE, dirName);
          fs.mkdirSync(destDir, { recursive: true });
          try {
            execSync(`cp -r ${JSON.stringify(srcDir)}/. ${JSON.stringify(destDir)}/`, { stdio: 'pipe', timeout: 30000 });
            // Fix permissions for sensitive dirs
            if (['identity', 'devices'].includes(dirName)) {
              execSync(`chmod -R 600 ${JSON.stringify(destDir)}/* 2>/dev/null || true`, { stdio: 'pipe', timeout: 5000 });
            }
            restoredFiles.push(dirName + '/');
          } catch {}
        }
        normalizePairedDevicesScopes();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log(`[migration-import] Migration import complete: ${restoredFiles.join(', ')}, pre-backup: ${preImportBackup}`);
        res.json({ success: true, restoredFiles, preImportBackup, needRestart: true });
      } catch (e) {
        console.error(`[migration-import] Import failed: ${e?.message}`);
        res.status(500).json({ error: e?.message || 'Migration import failed' });
      }
    });
  } catch (e) {
    console.error(`[migration-import] Import failed: ${e?.message}`);
    res.status(500).json({ error: e?.message || 'Migration import failed' });
  }
});

// --- Config Export (download as .tar.gz) ---
app.get('/api/openclaw/config/export', async (req, res) => {
  try {
    const OPENCLAW_BASE = path.dirname(CONFIG_PATH);
    const FILE_MAP = {
      'openclaw.json': CONFIG_PATH,
      'auth-profiles.json': path.join(OPENCLAW_BASE, 'agents/main/agent/auth-profiles.json'),
      'models.json': path.join(OPENCLAW_BASE, 'agents/main/agent/models.json'),
      'jobs.json': path.join(OPENCLAW_BASE, 'cron/jobs.json')
    };
    // Create temp dir with config files
    const tmpDir = `/tmp/openclaw-config-export-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    let fileCount = 0;
    for (const [name, src] of Object.entries(FILE_MAP)) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(tmpDir, name));
        fileCount++;
      }
    }
    if (fileCount === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return res.status(404).json({ error: '\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u914D\u7F6E\u6587\u4EF6' });
    }
    // Add metadata
    fs.writeFileSync(path.join(tmpDir, '_export-meta.json'), JSON.stringify({
      exportTime: new Date().toISOString(),
      files: Object.keys(FILE_MAP).filter(n => fs.existsSync(FILE_MAP[n])),
      version: 'clawnook-config-v1'
    }, null, 2));

    const tgzPath = `${tmpDir}.tar.gz`;
    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
      exec(`tar -czf ${JSON.stringify(tgzPath)} -C ${JSON.stringify(tmpDir)} .`, { timeout: 15000 }, (err) => err ? reject(err) : resolve());
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const stat = fs.statSync(tgzPath);
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="openclaw-config-${ts}.tar.gz"`);
    const stream = fs.createReadStream(tgzPath);
    stream.pipe(res);
    res.on('close', () => { try { fs.unlinkSync(tgzPath); } catch {} });
  } catch (e) {
    console.error(`[config-export] \u5BFC\u51FA\u5931\u8D25: ${e?.message}`);
    if (!res.headersSent) res.status(500).json({ error: e?.message || '\u914D\u7F6E\u5BFC\u51FA\u5931\u8D25' });
  }
});

// --- Config Import (upload .tar.gz or .tar) ---
app.post('/api/openclaw/config/import', (req, res) => {
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/gzip') && !contentType.includes('application/octet-stream') && !contentType.includes('application/x-gzip') && !contentType.includes('application/x-tar')) {
      return res.status(400).json({ error: '\u8BF7\u4E0A\u4F20 .tar.gz \u6216 .tar \u6587\u4EF6' });
    }
    const isPlainTar = contentType.includes('application/x-tar');
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 20) return res.status(400).json({ error: '\u6587\u4EF6\u592A\u5C0F\uFF0C\u65E0\u6548\u7684\u538B\u7F29\u5305' });
        if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: '\u6587\u4EF6\u592A\u5927\uFF08\u6700\u5927 10MB\uFF09' });

        const tmpTgz = `/tmp/openclaw-config-import-${Date.now()}.tar${isPlainTar ? '' : '.gz'}`;
        const tmpDir = `/tmp/openclaw-config-import-${Date.now()}`;
        fs.writeFileSync(tmpTgz, buf);
        fs.mkdirSync(tmpDir, { recursive: true });

        const { execSync } = require('child_process');
        const tarFlag = isPlainTar ? '-xf' : '-xzf';
        execSync(`tar ${tarFlag} ${JSON.stringify(tmpTgz)} -C ${JSON.stringify(tmpDir)}`, { stdio: 'pipe', timeout: 15000 });
        fs.unlinkSync(tmpTgz);

        // Verify it's a valid config export
        const extracted = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
        if (extracted.length === 0) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return res.status(400).json({ error: '\u538B\u7F29\u5305\u4E2D\u6CA1\u6709\u914D\u7F6E\u6587\u4EF6' });
        }

        const OPENCLAW_BASE = path.dirname(CONFIG_PATH);
        const FILE_TARGETS = {
          'openclaw.json': CONFIG_PATH,
          'auth-profiles.json': path.join(OPENCLAW_BASE, 'agents/main/agent/auth-profiles.json'),
          'models.json': path.join(OPENCLAW_BASE, 'agents/main/agent/models.json'),
          'jobs.json': path.join(OPENCLAW_BASE, 'cron/jobs.json')
        };

        // Backup current config first
        const backupName = 'snapshot-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
        const backupDir = path.join(OPENCLAW_CONFIG_BACKUP_DIR, backupName);
        fs.mkdirSync(backupDir, { recursive: true });
        for (const [name, target] of Object.entries(FILE_TARGETS)) {
          if (fs.existsSync(target)) {
            try { fs.copyFileSync(target, path.join(backupDir, name)); } catch {}
          }
        }

        // Restore from import
        const restoredFiles = [];
        for (const fileName of extracted) {
          if (fileName.startsWith('_')) continue; // Skip metadata
          const target = FILE_TARGETS[fileName];
          if (!target) continue;
          const srcFile = path.join(tmpDir, fileName);
          // Validate JSON
          try { JSON.parse(fs.readFileSync(srcFile, 'utf8')); } catch {
            continue; // Skip invalid JSON
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(srcFile, target);
          restoredFiles.push(fileName);
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });

        if (restoredFiles.length === 0) {
          return res.status(400).json({ error: '\u538B\u7F29\u5305\u4E2D\u6CA1\u6709\u53EF\u6062\u590D\u7684\u914D\u7F6E\u6587\u4EF6' });
        }

        console.log(`[config-import] \u5BFC\u5165\u5B8C\u6210: ${restoredFiles.join(', ')}, \u5DF2\u5907\u4EFD\u5230 ${backupName}`);
        res.json({ success: true, restoredFiles, backupName });
      } catch (e) {
        console.error(`[config-import] \u5BFC\u5165\u5931\u8D25: ${e?.message}`);
        res.status(500).json({ error: e?.message || '\u914D\u7F6E\u5BFC\u5165\u5931\u8D25' });
      }
    });
  } catch (e) {
    console.error(`[config-import] \u5BFC\u5165\u5931\u8D25: ${e?.message}`);
    res.status(500).json({ error: e?.message || '\u914D\u7F6E\u5BFC\u5165\u5931\u8D25' });
  }
});

app.get('/api/openclaw/config/backups', (req, res) => {
  try {
    const backups = listOpenClawConfigBackups();
    console.log(`[config-backup] Querying backup list: ${backups.length} backup(s)`);
    res.json({ success: true, backups });
  } catch (e) {
    console.error(`[config-backup] Failed to read backup list: ${e?.message}`);
    res.status(500).json({ success: false, error: e?.message || 'Failed to read backup list' });
  }
});

app.post('/api/openclaw/config/restore', (req, res) => {
  try {
    const name = sanitizeBackupFileName(req.body?.name);
    if (!name) return res.status(400).json({ success: false, error: 'Invalid backup name' });

    console.log(`[config-restore] Starting config restore, backup: ${name}, requested files: ${JSON.stringify(req.body?.files || 'all')}`);

    const backupPath = path.join(OPENCLAW_CONFIG_BACKUP_DIR, name);
    if (!backupPath.startsWith(`${OPENCLAW_CONFIG_BACKUP_DIR}/`) || !fs.existsSync(backupPath)) {
      console.warn(`[config-restore] Backup not found: ${name}`);
      return res.status(404).json({ success: false, error: 'Backup not found' });
    }

    // Specific file list to restore (empty=all)
    const requestedFiles = Array.isArray(req.body?.files) ? req.body.files : [];
    const restoredFiles = [];

    const stat = fs.statSync(backupPath);
    if (stat.isDirectory()) {
      // snapshot directory: restore selected files
      const availableFiles = fs.readdirSync(backupPath).filter(f => f.endsWith('.json'));
      const filesToRestore = requestedFiles.length > 0
        ? availableFiles.filter(f => requestedFiles.includes(f))
        : availableFiles;

      const OPENCLAW_BASE = path.dirname(CONFIG_PATH);
      const FILE_TARGETS = {
        'openclaw.json': CONFIG_PATH,
        'auth-profiles.json': path.join(OPENCLAW_BASE, 'agents/main/agent/auth-profiles.json'),
        'models.json': path.join(OPENCLAW_BASE, 'agents/main/agent/models.json'),
        'jobs.json': path.join(OPENCLAW_BASE, 'cron/jobs.json')
      };

      for (const fileName of filesToRestore) {
        const srcFile = path.join(backupPath, fileName);
        const targetPath = FILE_TARGETS[fileName];
        if (!targetPath || !fs.existsSync(srcFile)) continue;

        // Backup current files
        if (fs.existsSync(targetPath)) {
          try {
            fs.copyFileSync(targetPath, `${targetPath}.before-restore.${Date.now()}.bak`);
          } catch {}
        }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(srcFile, targetPath);
        restoredFiles.push(fileName);
      }

      if (restoredFiles.length === 0) {
        console.warn(`[config-restore] Backup ${name} has no restorable files`);
        return res.status(400).json({ success: false, error: 'No files to restore' });
      }
    } else {
      // Old format: single JSON file restored to openclaw.json
      if (fs.existsSync(CONFIG_PATH)) {
        try {
          fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.before-restore.${Date.now()}.bak`);
        } catch {}
      }
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.copyFileSync(backupPath, CONFIG_PATH);
      restoredFiles.push(name);
    }

    console.log(`[config-restore] Restore complete: ${name}, restored files: [${restoredFiles.join(', ')}]`);
    res.json({ success: true, restored: name, restoredFiles });
  } catch (e) {
    console.error(`[config-restore] Restore failed: ${e?.message}`);
    res.status(500).json({ success: false, error: e?.message || 'Config recovery failed' });
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
      return res.status(409).json({ success: false, error: `Operation in progress: ${opState.type}`, operationState: opState });
    }

    const mode = resolveOpenClawInstallMode(req);
    const repo = resolveOpenClawSourceRepo(true);
    const release = await resolveLatestOpenClawInstallRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release, { mode });
    const taskId = runOpenClawTask(
      command,
      `Install OpenClaw (mode=${mode}，npm only）(${release.tag})`,
      'installing',
      { release }
    );
    if (!taskId) {
      return res.status(409).json({ success: false, error: 'Task creation failed: concurrent operation in progress', operationState: getOpenClawOperationState() });
    }
    res.json({ success: true, taskId, mode, release: { repo: release.repo, tag: release.tag }, logFile: installLogs[taskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Install task creation failed' });
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
  res.json({ ...task, operationType: task.operationType || 'installing', delta });
});

app.post('/api/openclaw/uninstall', (req, res) => {
  try {
    if (isTaskRunning(installLogs, activeInstallTaskId)) {
      return res.json({ success: true, taskId: activeInstallTaskId, reused: true, logFile: installLogs[activeInstallTaskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
    }
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle') {
      return res.status(409).json({ success: false, error: `Operation in progress: ${opState.type}`, operationState: opState });
    }
    const taskId = runOpenClawTask(buildOpenClawUninstallCommand(), 'Uninstall OpenClaw (remove npm global package and local source directory)', 'uninstalling');
    if (!taskId) {
      return res.status(409).json({ success: false, error: 'Task creation failed: concurrent operation in progress', operationState: getOpenClawOperationState() });
    }
    res.json({ success: true, taskId, logFile: installLogs[taskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Uninstall task creation failed' });
  }
});

function buildOpenClawNpmInstallCommand(targetVersion) {
  const safeVersion = String(targetVersion || 'latest').replace(/[^a-zA-Z0-9._-]/g, '');
  const pkg = safeVersion === 'latest' ? 'openclaw@latest' : `openclaw@${safeVersion}`;
  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] Script exited abnormally line=$LINENO exit=$?" >&2\' ERR',
    'echo "[openclaw][npm] A/B Isolated install mode (Gateway uninterrupted)"',
    'for bin in node npm; do',
    '  if ! command -v "$bin" >/dev/null 2>&1; then',
    '    echo "[openclaw] Missing image dependency: $bin (please rebuild image, do not install system deps at runtime)"',
    '    exit 11',
    '  fi',
    'done',
    'npm config set fetch-retries 6',
    'npm config set fetch-retry-mintimeout 2000',
    'npm config set fetch-retry-maxtimeout 20000',
    'OPENCLAW_STATE_ROOT="/root/.openclaw"',
    'NEXT_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source-next"',
    'STAGING_PREFIX="$OPENCLAW_STATE_ROOT/npm-staging"',
    'mkdir -p "$OPENCLAW_STATE_ROOT" "$OPENCLAW_STATE_ROOT/logs" "$OPENCLAW_STATE_ROOT/cache/openclaw" "$OPENCLAW_STATE_ROOT/locks"',
    '# Clean up possibly leftover staging directory from last run',
    'rm -rf "$NEXT_SRC_DIR" "$STAGING_PREFIX" 2>/dev/null || true',
    'mkdir -p "$STAGING_PREFIX"',
    '# Choose registry',
    'MIRROR_LATEST="$(npm view openclaw version --registry=https://registry.npmmirror.com 2>/dev/null || true)"',
    'NPMJS_LATEST="$(npm view openclaw version --registry=https://registry.npmjs.org 2>/dev/null || true)"',
    'INSTALL_REGISTRY="https://registry.npmmirror.com"',
    'if [ -n "$NPMJS_LATEST" ] && [ "$MIRROR_LATEST" != "$NPMJS_LATEST" ]; then',
    '  echo "[openclaw] Mirror latest(${MIRROR_LATEST:-unknown})behind npmjs(${NPMJS_LATEST})，installing directly from npmjs..."',
    '  INSTALL_REGISTRY="https://registry.npmjs.org"',
    'fi',
    'npm cache verify >/dev/null 2>&1 || true',
    '# --- npm install to isolated prefix (does not affect running Gateway) ---',
    'OPENCLAW_NPM_LAST_ERROR=""',
    'run_npm_staging_install() {',
    '  local label="$1"',
    '  local registry="$2"',
    '  local rc=0',
    '  local tmp_log="$OPENCLAW_STATE_ROOT/logs/npm-install-${label}.log"',
    '  rm -f "$tmp_log"',
    '  set +e',
    '  if command -v timeout >/dev/null 2>&1; then',
    `    echo "[openclaw] \${label}: timeout 900s npm install -g ${pkg} --prefix $STAGING_PREFIX --registry=\${registry}"`,
    `    timeout 900 npm install -g "${pkg}" --prefix "$STAGING_PREFIX" --registry="\${registry}" --prefer-online --no-audit --no-fund 2>&1 | tee "$tmp_log"`,
    '    rc=${PIPESTATUS[0]}',
    '  else',
    `    echo "[openclaw] \${label}: npm install -g ${pkg} --prefix $STAGING_PREFIX --registry=\${registry}"`,
    `    npm install -g "${pkg}" --prefix "$STAGING_PREFIX" --registry="\${registry}" --prefer-online --no-audit --no-fund 2>&1 | tee "$tmp_log"`,
    '    rc=${PIPESTATUS[0]}',
    '  fi',
    '  set -e',
    '  if [ "$rc" -ne 0 ]; then',
    '    if [ "$rc" -eq 124 ]; then',
    `      OPENCLAW_NPM_LAST_ERROR="[openclaw][error] npm install timeout(900s): ${pkg}"`,
    '    else',
    '      tail_msg="$(tail -n 1 "$tmp_log" 2>/dev/null || true)"',
    '      [ -z "$tail_msg" ] && tail_msg="npm install exit=${rc}"',
    '      OPENCLAW_NPM_LAST_ERROR="[openclaw][error] npm install failed(exit=${rc}): ${tail_msg}"',
    '    fi',
    '    echo "$OPENCLAW_NPM_LAST_ERROR"',
    '    echo "[openclaw] npm failure log: $tmp_log"',
    '    tail -n 80 "$tmp_log" 2>/dev/null || true',
    '    return "$rc"',
    '  fi',
    '  echo "[openclaw] ${label}: Install succeeded"',
    '  return 0',
    '}',
    'if ! run_npm_staging_install "first_install" "$INSTALL_REGISTRY"; then',
    '  echo "[openclaw] npm install first attempt failed, cleaning and retrying (npmjs)..."',
    '  npm cache verify >/dev/null 2>&1 || true',
    '  rm -rf "$STAGING_PREFIX" 2>/dev/null || true',
    '  mkdir -p "$STAGING_PREFIX"',
    '  if ! run_npm_staging_install "retry_install" "https://registry.npmjs.org"; then',
    '    [ -n "$OPENCLAW_NPM_LAST_ERROR" ] && echo "$OPENCLAW_NPM_LAST_ERROR"',
    '    rm -rf "$STAGING_PREFIX" 2>/dev/null || true',
    '    exit 31',
    '  fi',
    'fi',
    '# Verify staging prefix install result',
    'STAGING_LIB_DIR="$STAGING_PREFIX/lib/node_modules/openclaw"',
    'if [ ! -f "$STAGING_LIB_DIR/package.json" ]; then',
    '  echo "[openclaw][error] package.json missing after staging prefix install"',
    '  rm -rf "$STAGING_PREFIX" 2>/dev/null || true',
    '  exit 31',
    'fi',
    '# Move staging directory to NEXT_SRC_DIR for A/B swap',
    'rm -rf "$NEXT_SRC_DIR" 2>/dev/null || true',
    'mv -f "$STAGING_LIB_DIR" "$NEXT_SRC_DIR"',
    '# Ensure entry file and compat symlink',
    'if [ ! -f "$NEXT_SRC_DIR/openclaw.mjs" ] && [ -f "$NEXT_SRC_DIR/dist/openclaw.mjs" ]; then',
    '  ln -sfn "$NEXT_SRC_DIR/dist/openclaw.mjs" "$NEXT_SRC_DIR/openclaw.mjs"',
    'fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.js" ] && [ -f "$NEXT_SRC_DIR/dist/index.js" ]; then ln -sfn index.js "$NEXT_SRC_DIR/dist/entry.js"; fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.mjs" ] && [ -f "$NEXT_SRC_DIR/dist/index.mjs" ]; then ln -sfn index.mjs "$NEXT_SRC_DIR/dist/entry.mjs"; fi',
    '# Syntax validation',
    'if [ -f "$NEXT_SRC_DIR/openclaw.mjs" ] && command -v node >/dev/null 2>&1; then',
    '  if ! node --check "$NEXT_SRC_DIR/openclaw.mjs" 2>/dev/null; then',
    '    echo "[openclaw][error] openclaw.mjs syntax check failed"',
    '    rm -rf "$NEXT_SRC_DIR" "$STAGING_PREFIX" 2>/dev/null || true',
    '    exit 31',
    '  fi',
    'fi',
    '# Version read verification',
    'STAGED_VER="$(node -e "try{console.log(require(\\"/root/.openclaw/openclaw-source-next/package.json\\").version||\\"\\")}catch(e){}" 2>/dev/null || true)"',
    'echo "[openclaw] npm staging install complete: version=${STAGED_VER:-unknown}"',
    '# Clean up staging prefix',
    'rm -rf "$STAGING_PREFIX" 2>/dev/null || true'
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
      return res.status(409).json({ success: false, error: `Operation in progress: ${opState.type}`, operationState: opState });
    }

    const mode = resolveOpenClawInstallMode(req);
    const repo = resolveOpenClawSourceRepo(true);
    const release = await resolveLatestOpenClawInstallRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release, { mode });
    const taskId = runOpenClawTask(
      command,
      `Update OpenClaw (mode=${mode}，npm only）(${release.tag})`,
      'updating',
      { release }
    );
    if (!taskId) {
      return res.status(409).json({ success: false, error: 'Task creation failed: concurrent operation in progress', operationState: getOpenClawOperationState() });
    }
    res.json({ success: true, taskId, mode, release: { repo: release.repo, tag: release.tag }, logFile: installLogs[taskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Update task creation failed' });
  }
});

app.get('/api/openclaw/dependencies', (req, res) => {
  try {
    ensureOpenClawRuntimeStateDirs();
    const audit = auditOpenClawImageDependencies();
    res.json({ success: true, ...audit });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Dependency audit failed' });
  }
});

// --- Version list API: fetch npm published versions for user to select historical version ---
app.get('/api/openclaw/versions', async (_req, res) => {
  try {
    const registries = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];
    let versions = [];
    for (const registry of registries) {
      const raw = runCommandText(`npm view openclaw versions --json --registry=${registry} 2>/dev/null || true`, 15000);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            versions = parsed.map(v => String(v).trim()).filter(Boolean);
            break;
          }
        } catch {}
      }
    }
    if (!versions.length) {
      return res.json({ success: true, versions: [], error: 'Unable to fetch version list' });
    }
    // Reverse order (newest first)
    versions.reverse();
    const installed = getInstalledOpenClawVersion();
    res.json({ success: true, versions, installedVersion: installed || '' });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to fetch version list' });
  }
});

// --- Install specified version API ---
app.post('/api/openclaw/install-version', async (req, res) => {
  try {
    const version = String(req.body?.version || '').trim();
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
      return res.status(400).json({ success: false, error: 'Invalid version format' });
    }
    if (isTaskRunning(installLogs, activeInstallTaskId)) {
      return res.json({ success: true, taskId: activeInstallTaskId, reused: true });
    }
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle') {
      return res.status(409).json({ success: false, error: `Operation in progress: ${opState.type}`, operationState: opState });
    }

    const repo = resolveOpenClawSourceRepo(true);
    // Construct release object (specified version uses npm registry)
    const tag = `v${version}`;
    const binaryAsset = resolveOpenClawNpmDistTarballAsset(tag);
    const release = {
      repo,
      tag,
      tarballUrl: `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`,
      assets: [],
      binaryAsset,
      publishedAt: '',
      name: tag
    };
    const mode = 'auto';
    const command = buildOpenClawPreferredInstallCommand(release, { mode });
    const taskId = runOpenClawTask(
      command,
      `Install OpenClaw v${version}（specified version）`,
      'installing',
      { release }
    );
    if (!taskId) {
      return res.status(409).json({ success: false, error: 'Task creation failed: concurrent operation in progress' });
    }
    res.json({ success: true, taskId, version, release: { repo, tag } });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Install task creation failed' });
  }
});

app.post('/api/openclaw/start', (req, res) => {
  console.log('[openclaw][start] restart requested');
  const opState = getOpenClawOperationState();

  if (opState.type === 'restarting_gateway') {
    console.log('[openclaw][start] restart already in progress');
    return res.json({
      success: true,
      message: 'Gateway restart already in progress, please wait',
      operationState: opState
    });
  }

  if (opState.type !== 'idle') {
    console.log(`[openclaw][start] blocked by operation state: ${opState.type}`);
    return res.status(409).json({ success: false, error: `Operation in progress: ${opState.type}`, operationState: opState });
  }

  // Write operation.lock, let watchdog perform restart
  queueGatewayRestart('openclaw-start');

  res.json({
    success: true,
    message: 'Restart request submitted, watchdog will execute within 10 seconds',
    operationState: { ...openClawOperationState }
  });
});

app.get('/api/openclaw/pairing/list', async (_req, res) => {
  try {
    const pending = readJson(DEVICE_PAIRING_PENDING_PATH, {});
    const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
    const pendingList = Object.values(pending)
      .filter((p) => p && typeof p === 'object' && p.requestId)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const pairedList = Object.values(paired)
      .filter((p) => p && typeof p === 'object' && p.deviceId)
      .sort((a, b) => (b.approvedAtMs || 0) - (a.approvedAtMs || 0));
    res.json({ success: true, pending: pendingList, paired: pairedList });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to read pairing status' });
  }
});

app.post('/api/openclaw/pairing/approve', async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId || typeof requestId !== 'string') return res.status(400).json({ success: false, error: 'Missing requestId' });
  if (!/^[0-9a-fA-F-]{8,64}$/.test(requestId)) return res.status(400).json({ success: false, error: 'Invalid requestId format' });
  try {
    const pending = readJson(DEVICE_PAIRING_PENDING_PATH, {});
    const entry = pending[requestId];
    if (!entry) return res.status(404).json({ success: false, error: 'Pairing request not found (may have expired)' });

    const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
    const deviceId = entry.deviceId;
    const existing = paired[deviceId] || {};
    const now = Date.now();
    const token = require('crypto').randomBytes(24).toString('hex');

    const role = (entry.role || 'operator').trim() || 'operator';
    // Merge requested scopes with existing to prevent scope-upgrade loops.
    // Gateway reads the top-level `scopes` field (not `approvedScopes`) to decide permissions.
    const requestedScopes = entry.scopes || [];
    const existingScopes = existing.approvedScopes || existing.scopes || [];
    const mergedScopes = Array.from(new Set([...existingScopes, ...requestedScopes]));
    // For operator/admin roles, ensure full operator scope set to prevent repeated scope-upgrade pairing
    const fullScopes = (role === 'operator' || role === 'admin')
      ? Array.from(new Set([...mergedScopes, 'operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing']))
      : (mergedScopes.length > 0 ? mergedScopes : ['operator.admin']);

    const existingTokens = existing.tokens && typeof existing.tokens === 'object' ? { ...existing.tokens } : {};
    existingTokens[role] = {
      token,
      role,
      scopes: fullScopes,
      createdAtMs: existingTokens[role]?.createdAtMs || now,
      rotatedAtMs: now
    };

    paired[deviceId] = {
      ...existing,
      deviceId,
      publicKey: entry.publicKey || existing.publicKey,
      displayName: entry.displayName || existing.displayName,
      platform: entry.platform || existing.platform,
      clientId: entry.clientId || existing.clientId,
      clientMode: entry.clientMode || existing.clientMode,
      role,
      roles: Array.from(new Set([...(existing.roles || []), ...(entry.roles || [role])])),
      scopes: fullScopes,
      approvedScopes: fullScopes,
      tokens: existingTokens,
      approvedAtMs: now,
      isRepair: entry.isRepair || false
    };

    delete pending[requestId];

    fs.writeFileSync(DEVICE_PAIRING_PENDING_PATH, JSON.stringify(pending, null, 2));
    fs.writeFileSync(DEVICE_PAIRING_PAIRED_PATH, JSON.stringify(paired, null, 2));

    console.log(`[pairing][approve] requestId=${requestId} deviceId=${deviceId} role=${role}`);
    res.json({ success: true, deviceId, role });
  } catch (e) {
    console.error(`[pairing][approve] error:`, e);
    res.status(500).json({ success: false, error: e?.message || 'Approval failed' });
  }
});

app.post('/api/openclaw/pairing/approve-discord', async (req, res) => {
  const rawCode = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!rawCode) return res.status(400).json({ success: false, error: 'Missing pairing code' });
  if (!/^[A-Z0-9]{6,32}$/.test(rawCode)) return res.status(400).json({ success: false, error: 'Invalid pairing code format' });

  try {
    const command = [
      `PAIRING_CODE="${rawCode}"`,
      'if command -v openclaw >/dev/null 2>&1; then',
      '  openclaw pairing approve discord "$PAIRING_CODE" 2>&1',
      'elif [ -x /root/.npm-global/bin/openclaw ]; then',
      '  /root/.npm-global/bin/openclaw pairing approve discord "$PAIRING_CODE" 2>&1',
      'elif [ -x /usr/local/bin/openclaw ]; then',
      '  /usr/local/bin/openclaw pairing approve discord "$PAIRING_CODE" 2>&1',
      'elif [ -x /usr/bin/openclaw ]; then',
      '  /usr/bin/openclaw pairing approve discord "$PAIRING_CODE" 2>&1',
      'elif [ -x /opt/homebrew/bin/openclaw ]; then',
      '  /opt/homebrew/bin/openclaw pairing approve discord "$PAIRING_CODE" 2>&1',
      'elif [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
      '  node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs pairing approve discord "$PAIRING_CODE" 2>&1',
      'else',
      '  echo "openclaw not found"',
      '  exit 127',
      'fi'
    ].join('\n');
    const result = await runOpenClawCli(command, 45000);
    const output = keepLastLines(String(result.output || '').trim(), 20).trim();
    if (!result.ok) {
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const errorText = lines[lines.length - 1] || 'Discord pairing approval failed';
      return res.status(500).json({ success: false, error: errorText, output });
    }

    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const message = lines[lines.length - 1] || `Discord pairing code ${rawCode} approved`;
    res.json({ success: true, code: rawCode, message, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Discord pairing approval failed' });
  }
});

// --- WeChat QR Login ---
app.post('/api/openclaw/wechat/qr', async (req, res) => {
  try {
    const command = [
      'if command -v openclaw >/dev/null 2>&1; then',
      '  openclaw channels login --channel openclaw-weixin 2>&1',
      'elif [ -x /root/.npm-global/bin/openclaw ]; then',
      '  /root/.npm-global/bin/openclaw channels login --channel openclaw-weixin 2>&1',
      'elif [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
      '  node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs channels login --channel openclaw-weixin 2>&1',
      'else',
      '  echo "openclaw not found"',
      '  exit 127',
      'fi'
    ].join('\n');
    const result = await runOpenClawCliWithPtyInput(command, '', 60000);
    const output = stripAnsi(String(result.output || '')).trim();
    // Match WeChat QR URLs: liteapp.weixin.qq.com, .png images, or data URIs
    const urlMatch = output.match(/(https?:\/\/liteapp\.weixin\.qq\.com\/[^\s]+|https?:\/\/[^\s]+\.png[^\s]*|data:image\/[^\s]+)/);
    if (urlMatch) {
      const loginUrl = urlMatch[1];
      // Generate QR code data URI for web display
      try {
        const QRCode = require('qrcode');
        const qrDataUri = await QRCode.toDataURL(loginUrl, { width: 280, margin: 2 });
        return res.json({ success: true, qrUrl: qrDataUri, loginUrl, output });
      } catch (qrErr) {
        return res.json({ success: true, qrUrl: '', loginUrl, output, error: 'QR image render failed: ' + qrErr.message });
      }
    }
    if (!result.ok) {
      return res.status(500).json({ success: false, error: output || 'Failed to generate WeChat QR code' });
    }
    // If no image URL found, return raw output for debugging
    res.json({ success: true, qrUrl: '', output, error: 'QR URL not found in output — WeChat channel may not be installed yet. Run: openclaw plugins install @tencent-weixin/openclaw-weixin' });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'WeChat QR generation failed' });
  }
});

app.post('/api/openclaw/wechat/logout', async (req, res) => {
  try {
    const command = [
      'if command -v openclaw >/dev/null 2>&1; then',
      '  openclaw channels logout --channel openclaw-weixin 2>&1',
      'elif [ -x /root/.npm-global/bin/openclaw ]; then',
      '  /root/.npm-global/bin/openclaw channels logout --channel openclaw-weixin 2>&1',
      'elif [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
      '  node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs channels logout --channel openclaw-weixin 2>&1',
      'else',
      '  echo "openclaw not found"',
      '  exit 127',
      'fi'
    ].join('\n');
    const result = await runOpenClawCli(command, 15000);
    const output = String(result.output || '').trim();
    if (!result.ok) {
      return res.status(500).json({ success: false, error: output || 'WeChat logout failed' });
    }
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'WeChat logout failed' });
  }
});

app.get('/api/openclaw/gateway/logs', (req, res) => {
  try {
    const lines = Math.max(20, Math.min(parseInt(req.query.lines || String(LOG_VIEW_DEFAULT_LINES), 10) || LOG_VIEW_DEFAULT_LINES, OPENCLAW_GATEWAY_LOG_API_MAX_LINES));
    const logs = readOpenClawGatewayLogs(lines, { includeWatchdog: true, includeInstall: true });
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to read Gateway logs' });
  }
});

// ============================================================
// Logs: sanitize + tail
// ============================================================
function sanitizeLogLine(line) {
  if (typeof line !== 'string') return null;
  if (/let me get GitHub .*data(?:and organize all data)?[:：]?/.test(line)) {
    return null;
  }
  if (/\[node\]\s+(?:control-ui\s+)?WS (?:connect failed|error):\s+connect ECONNREFUSED 127\.0\.0\.1:\d+/i.test(line)) {
    return null;
  }
  if (/\[ws\]\s+closed before connect\b/i.test(line) && /(origin=https?:\/\/(?:127\.0\.0\.1|localhost)\b|host=(?:127\.0\.0\.1|localhost):\d+\b)/i.test(line)) {
    return null;
  }
  if (/\[node\]\s+(?:control-ui identity unavailable → cli fallback|control-ui rejected:|node\.list failed:|cli fallback presence:|cli fallback connect failed:|refresh snapshot:|control-ui connect ok, calling node\.list)/i.test(line)) {
    return null;
  }
  if (/\[ws\]\s+⇄\s+res\s+✗\s+node\.invoke\b.*invalid node\.invoke params: must have required property 'idempotencyKey'/i.test(line)) {
    return null;
  }
  // Filter out frequent webchat connected/disconnected logs
  if (/\[ws\]\s+webchat\s+(connected|disconnected)/i.test(line)) {
    return null;
  }
  // Filter out high-frequency ws message logs (device.pair.list, node.list, chat.history, config.get etc.)
  if (/\[ws\]\s+⇄\s+res\s+✓\s+(device\.pair\.list|node\.list|chat\.history|device\.list|config\.get)\b/.test(line)) {
    return null;
  }
  // Filter out high-frequency successful RPC responses (node probe / skills scan cause persistent log spam)
  if (/\[ws\]\s+⇄\s+res\s+✓\s+(skills\.bins|node\.invoke)\b/.test(line)) {
    return null;
  }
  // Filter out duplicate Discord reconnection/TLS error logs (extremely frequent during network issues)
  if (/\[discord\]\s+gateway:\s+(WebSocket connection closed|Attempting resume with backoff)/i.test(line)) {
    return null;
  }
  if (/\[discord\]\s+gateway\s+error:\s+Error:\s+Client network socket disconnected/i.test(line)) {
    return null;
  }
  // Filter out duplicate invalid config lines from config reload (already handled in invalidConfigKeys detection)
  if (/\[reload\]\s+config reload skipped\s+\(invalid config\)/i.test(line)) {
    return null;
  }
  // Filter out repetitive plugin registration logs (noisy during gateway startup)
  if (/\[plugins\]\s+\w+:\s+Registered\s+/i.test(line)) {
    return null;
  }
  // Filter out Feishu/Discord channel message logs (conversation content should not leak to ops log panel)
  if (/\[(feishu|discord|telegram|signal|whatsapp|wechat|openclaw-weixin)\].*(?:received message from|DM from|dispatching to agent|group message from)/i.test(line)) {
    return null;
  }
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
  const output = execSync(`tail -${Math.max(1, Math.min(lines, LOG_TAIL_MAX_LINES))} "${logFile}"`, { encoding: 'utf8', timeout: 2500 });
  return output
    .split('\n')
    .filter(Boolean)
    .map(sanitizeLogLine)
    .filter(Boolean);
}

function getLatestTaskLog(taskMap) {
  const items = Object.values(taskMap || {}).filter(Boolean);
  if (!items.length) return null;
  items.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  return items[0] || null;
}

function formatLocalTimeWithOffset(value) {
  return formatDateTimeInLogTimezone(value, { withOffset: true, separator: 'T' });
}

function formatTaskLogBlock(title, task, lines = 200) {
  if (!task || typeof task !== 'object') return '';
  const text = String(task.log || '').trim();
  if (!text) return '';
  const safeLines = Math.max(20, Math.min(lines, TASK_LOG_BLOCK_MAX_LINES));
  const tail = text.split('\n').slice(-safeLines).map(sanitizeLogLine).filter(Boolean).join('\n').trim();
  if (!tail) return '';
  const simplified = collapseInstallLogLines(tail);
  const status = String(task.status || 'unknown');
  const startedAt = task.startedAt ? formatLocalTimeWithOffset(task.startedAt) : '';
  const header = `[${title}] status=${status}${startedAt ? ` startedAt=${startedAt}` : ''}`;
  return `${header}\n${simplified}`;
}

app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines, 10) || LOG_VIEW_DEFAULT_LINES;
  try {
    const safeLines = Math.max(20, Math.min(lines, LOG_VIEW_MAX_LINES));
    const foldWatchdog = String(req.query.fold || '1') !== '0';
    const viewMode = String(req.query.view || 'timeline').trim().toLowerCase();
    const mergedBlocks = [];

    const activeInstall = activeInstallTaskId ? installLogs[activeInstallTaskId] : null;
    const installTask = activeInstall || getLatestTaskLog(installLogs);
    const installBlock = formatTaskLogBlock('openclaw-install', installTask, Math.min(safeLines, LOG_VIEW_INSTALL_BLOCK_CAP));
    if (installBlock) {
      mergedBlocks.push(installBlock);
    } else {
      const installTailFallback = readLatestInstallTaskLogSection(Math.min(safeLines, LOG_VIEW_INSTALL_BLOCK_CAP));
      if (installTailFallback) {
        const sanitizedInstallFallback = String(installTailFallback)
          .split('\n')
          .map(sanitizeLogLine)
          .filter(Boolean)
          .join('\n')
          .trim();
        if (sanitizedInstallFallback) {
          mergedBlocks.push(`[openclaw-install]\n${sanitizedInstallFallback}`);
        }
      }
    }

    const activeRepair = activeRepairTaskId ? repairLogs[activeRepairTaskId] : null;
    const repairTask = activeRepair || getLatestTaskLog(repairLogs);
    const repairBlock = formatTaskLogBlock('openclaw-repair', repairTask, Math.min(safeLines, LOG_VIEW_REPAIR_BLOCK_CAP));
    if (repairBlock) mergedBlocks.push(repairBlock);

    const gatewayCombined = readOpenClawGatewayLogs(Math.min(safeLines, LOG_VIEW_GATEWAY_BLOCK_CAP), { includeWatchdog: true }).trim();
    if (gatewayCombined) {
      mergedBlocks.push(gatewayCombined);
    }

    const panelLog = tailFile(WEB_PANEL_LOG_FILE, Math.min(safeLines, LOG_VIEW_PANEL_BLOCK_CAP), 2500).trim();
    if (panelLog) {
      const sanitizedPanel = panelLog
        .split('\n')
        .filter((line) => {
          const t = String(line || '').trim();
          if (!t) return false;
          if (!/\[install\]/i.test(t)) return true;
          if (/\[install\].*(npm ERR!|npm WARN|\[openclaw\]\[(error|fatal)\]|failed|failed|timeout|timeout|end status=failed)/i.test(t)) return true;
          if (/\[install\].*=====\s*task\s+/i.test(t)) return true;
          return false;
        })
        .map(sanitizeLogLine)
        .join('\n')
        .trim();
      if (sanitizedPanel) {
        mergedBlocks.push(`[web-panel]\n${sanitizedPanel}`);
      }
    }

    if (!mergedBlocks.length) {
      const hints = [
        '[logs] No displayable logs generated yet.',
        `[logs] checked: ${GATEWAY_RUNTIME_LOG_FILE}`,
        `[logs] checked: ${GATEWAY_LEGACY_LOG_FILE}`,
        `[logs] checked: ${GATEWAY_WATCHDOG_LOG}`,
        `[logs] checked: ${WEB_PANEL_LOG_FILE}`
      ].join('\n');
      return res.json({ logs: hints });
    }

    const mergedText = mergedBlocks.join('\n\n');
    if (viewMode === 'grouped') {
      return res.json({ logs: keepLastLines(mergedText, safeLines) });
    }
    const timelineLogs = mergeLogBlocksByTimeline(mergedText, { foldWatchdog, maxLines: safeLines });
    res.json({ logs: timelineLogs || mergedText });
  } catch (e) {
    res.json({ logs: e.message });
  }
});

// ============================================================
// Plugins market — Skills & Extensions
// ============================================================
// Resolve the openclaw package's skills directory (bundled)
function resolveOpenclawPkgRoot() {
  const candidateRoots = [
    '/tmp/openclaw-runtime/openclaw-source',
    path.join(process.env.HOME || '/root', '.openclaw', 'openclaw-source')
  ];
  for (const candidate of candidateRoots) {
    if (fs.existsSync(path.join(candidate, 'skills'))) {
      return candidate;
    }
  }
  try {
    const npmRoot = execSync('npm root -g 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
    const candidate = path.join(npmRoot, 'openclaw');
    if (fs.existsSync(path.join(candidate, 'skills'))) return candidate;
  } catch {}
  // Fallback: common paths
  const fallbacks = ['/root/.npm-global/lib/node_modules/openclaw', '/usr/local/lib/node_modules/openclaw'];
  for (const f of fallbacks) {
    if (fs.existsSync(path.join(f, 'skills'))) return f;
  }
  return candidateRoots[0];
}
let OPENCLAW_PKG_ROOT = resolveOpenclawPkgRoot();
let OPENCLAW_BUNDLED_SKILLS_DIR = path.join(OPENCLAW_PKG_ROOT, 'skills');
let OPENCLAW_EXTENSIONS_DIR = path.join(OPENCLAW_PKG_ROOT, 'extensions');
let _pkgRootLastChecked = Date.now();
const _PKG_ROOT_RECHECK_INTERVAL = 30000; // 30s
/** Re-resolve OPENCLAW_PKG_ROOT when the current path no longer has skills/ */
function ensureOpenclawPkgRoot() {
  const valid = fs.existsSync(path.join(OPENCLAW_PKG_ROOT, 'skills'));
  if (valid) return;
  const now = Date.now();
  if (now - _pkgRootLastChecked < _PKG_ROOT_RECHECK_INTERVAL) return;
  _pkgRootLastChecked = now;
  const fresh = resolveOpenclawPkgRoot();
  if (fresh !== OPENCLAW_PKG_ROOT) {
    console.log(`[skills] PKG_ROOT re-resolved: ${OPENCLAW_PKG_ROOT} → ${fresh}`);
    OPENCLAW_PKG_ROOT = fresh;
    OPENCLAW_BUNDLED_SKILLS_DIR = path.join(fresh, 'skills');
    OPENCLAW_EXTENSIONS_DIR = path.join(fresh, 'extensions');
  }
}
const OPENCLAW_MANAGED_SKILLS_DIR = path.join(process.env.HOME || '/root', '.openclaw', 'skills');
const OPENCLAW_SKILLS_DIR = OPENCLAW_MANAGED_SKILLS_DIR; // install target = managed (~/.openclaw/skills/)
const SKILL_SCAN_TMP = '/tmp/openclaw-skill-scan';
const OPENCLAW_USER_EXTENSIONS_DIR = path.join(process.env.HOME || '/root', '.openclaw', 'extensions');

/**
 * Ensure `require('openclaw/plugin-sdk')` resolves for user-installed plugins.
 * When OpenClaw is source-installed (not npm global), plugins can't find the
 * module. We create a symlink: ~/.openclaw/node_modules/openclaw → <source-root>
 * so Node resolves it from any path under ~/.openclaw/.
 * Returns { created, path, target, error? }
 */
function ensureOpenclawModuleLink() {
  const homeDir = process.env.HOME || '/root';
  const sourceRoot = path.join(homeDir, '.openclaw', 'openclaw-source');

  // Only needed when source-installed
  if (!fs.existsSync(path.join(sourceRoot, 'skills'))) {
    return { created: false, reason: 'source-install not detected' };
  }

  // Check if openclaw is already resolvable from extensions dir
  const nodeModulesDir = path.join(homeDir, '.openclaw', 'node_modules');
  const linkPath = path.join(nodeModulesDir, 'openclaw');

  try {
    const existing = fs.lstatSync(linkPath);
    if (existing.isSymbolicLink()) {
      const target = fs.readlinkSync(linkPath);
      if (target === sourceRoot || fs.realpathSync(linkPath) === fs.realpathSync(sourceRoot)) {
        return { created: false, path: linkPath, target: sourceRoot, reason: 'symlink already exists' };
      }
      // Stale symlink — remove and recreate
      fs.unlinkSync(linkPath);
    } else if (existing.isDirectory()) {
      // Real directory — don't touch
      return { created: false, path: linkPath, reason: 'real directory exists' };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { created: false, error: e.message };
    }
  }

  try {
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.symlinkSync(sourceRoot, linkPath, 'dir');
    console.log(`[plugins] Created module symlink: ${linkPath} → ${sourceRoot}`);
    return { created: true, path: linkPath, target: sourceRoot };
  } catch (e) {
    console.error(`[plugins] Failed to create module symlink: ${e.message}`);
    return { created: false, error: e.message };
  }
}
const SKILL_SCAN_MAX_DEPTH = 8;
const SKILL_MD_MAX_SIZE = 512 * 1024; // 512KB
const SKILL_DIR_MAX_FILES = 200;
const SKILL_DANGEROUS_PATTERNS = [
  /\beval\s*\(/i, /\bexec\s*\(/i, /\bspawn\s*\(/i,
  /\brm\s+-rf\b/i, /\bsudo\b/i, /\bcurl\b.*\|\s*bash/i,
  /\bwget\b.*\|\s*bash/i, /process\.env/i,
  /child_process/i, /\brequire\s*\(/i, /\bimport\s*\(/i
];

/** Scan a skills directory and return skill entries with metadata */
function scanSkillsDir(dir, source) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillDir = path.join(dir, e.name);
      const skillMd = path.join(skillDir, 'SKILL.md');
      let description = '';
      let contentHash = '';
      let skillName = '';
      if (fs.existsSync(skillMd)) {
        const parsed = parseSkillMd(skillMd);
        if (parsed) {
          skillName = parsed.name || '';
          description = parsed.description || '';
          contentHash = crypto.createHash('md5').update(parsed.content).digest('hex');
        }
      }
      // Quick security check: look for script files
      let securityWarnings = 0;
      const securityDetails = [];
      try {
        const allFiles = fs.readdirSync(skillDir, { withFileTypes: true, recursive: true });
        const suspiciousExts = ['.js', '.ts', '.py', '.sh', '.bash', '.exe', '.bat', '.cmd', '.ps1'];
        const scriptFiles = [];
        for (const f of allFiles) {
          if (!f.isFile()) continue;
          const ext = path.extname(f.name).toLowerCase();
          if (suspiciousExts.includes(ext)) scriptFiles.push(f.name);
        }
        if (scriptFiles.length) {
          securityWarnings++;
          securityDetails.push('\u5305\u542B\u811A\u672C\u6587\u4EF6: ' + scriptFiles.slice(0, 3).join(', ') + (scriptFiles.length > 3 ? ' \u7B49' : ''));
        }
        // Check SKILL.md for dangerous patterns
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, 'utf8').slice(0, 50000);
          for (const pat of SKILL_DANGEROUS_PATTERNS) {
            if (pat.test(content)) {
              securityWarnings++;
              securityDetails.push('SKILL.md \u542B\u53EF\u7591\u6A21\u5F0F: ' + pat.source);
              break;
            }
          }
        }
      } catch {}
      results.push({ name: e.name, skillName, description, path: skillDir, contentHash, source, securityWarnings, securityDetails });
    }
  } catch {}
  return results;
}

/** List all installed skills from bundled dir, extension skills, and managed dir */
function listUserSkills() {
  ensureOpenclawPkgRoot();
  const skills = new Map(); // name → skill entry (later sources override)

  // 1) Bundled skills  (lowest priority)
  for (const s of scanSkillsDir(OPENCLAW_BUNDLED_SKILLS_DIR, 'bundled')) {
    skills.set(s.name, s);
  }

  // 2) Extension skills (under extensions/*/skills/)
  try {
    if (fs.existsSync(OPENCLAW_EXTENSIONS_DIR)) {
      const extDirs = fs.readdirSync(OPENCLAW_EXTENSIONS_DIR, { withFileTypes: true });
      for (const ext of extDirs) {
        if (!ext.isDirectory()) continue;
        const extSkillsDir = path.join(OPENCLAW_EXTENSIONS_DIR, ext.name, 'skills');
        for (const s of scanSkillsDir(extSkillsDir, `ext:${ext.name}`)) {
          skills.set(s.name, s);
        }
      }
    }
  } catch {}

  // 3) Managed skills  (highest priority — user installed)
  for (const s of scanSkillsDir(OPENCLAW_MANAGED_SKILLS_DIR, 'managed')) {
    skills.set(s.name, s);
  }

  return Array.from(skills.values());
}

/** Parse SKILL.md to extract name & description */
function parseSkillMd(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > SKILL_MD_MAX_SIZE) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let name = '';
    let description = '';
    // Try YAML frontmatter first
    let inFm = false, fmLines = [];
    for (const l of lines) {
      if (l.trim() === '---') {
        if (!inFm) { inFm = true; continue; }
        else break;
      }
      if (inFm) fmLines.push(l);
    }
    if (fmLines.length) {
      for (let fi = 0; fi < fmLines.length; fi++) {
        const fl = fmLines[fi];
        const nm = fl.match(/^name:\s*(.+)/);
        if (nm) name = nm[1].trim().replace(/^['"]|['"]$/g, '');
        const dm = fl.match(/^description:\s*(.*)/);
        if (dm) {
          const val = dm[1].trim();
          if (val === '|' || val === '>') {
            // YAML block scalar: collect indented lines
            const descLines = [];
            for (let j = fi + 1; j < fmLines.length; j++) {
              if (/^\s+/.test(fmLines[j])) descLines.push(fmLines[j].trim());
              else break;
            }
            description = descLines.join(' ').slice(0, 200);
          } else {
            description = val.replace(/^['"]|['"]$/g, '').slice(0, 200);
          }
        }
      }
    }
    // Fallback: heading for name
    if (!name) {
      for (const l of lines) {
        const hMatch = l.match(/^#{1,3}\s+(.+)/);
        if (hMatch) { name = hMatch[1].trim(); break; }
      }
    }
    // Fallback: first body line for description
    if (!description) {
      let inFrontmatter = false;
      for (const l of lines) {
        const trimmed = l.trim();
        if (trimmed === '---') { inFrontmatter = !inFrontmatter; continue; }
        if (inFrontmatter) continue;
        if (!trimmed || trimmed.startsWith('#')) continue;
        description = trimmed.slice(0, 200);
        break;
      }
    }
    return { name, description, content };
  } catch {
    return null;
  }
}

/** Recursively find all SKILL.md files up to maxDepth */
function findSkillsInDir(baseDir, maxDepth = SKILL_SCAN_MAX_DEPTH) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // Check if this dir has SKILL.md
    const skillMdPath = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const parsed = parseSkillMd(skillMdPath);
      if (parsed) {
        const relPath = path.relative(baseDir, dir);
        const dirName = path.basename(dir);
        results.push({
          name: parsed.name || dirName,
          dirName,
          relPath: relPath || '.',
          description: parsed.description,
          absPath: dir,
        });
      }
      return; // Don't recurse into skill subdirectories
    }
    // Recurse into subdirectories
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  walk(baseDir, 0);
  return results;
}

/** Security check: scan skill directory for dangerous patterns */
function validateSkillSecurity(skillDir) {
  const warnings = [];
  const errors = [];
  const skillMdPath = path.join(skillDir, 'SKILL.md');

  // 1. SKILL.md must exist
  if (!fs.existsSync(skillMdPath)) {
    errors.push('Missing SKILL.md file');
    return { valid: false, errors, warnings };
  }

  // 2. Check SKILL.md is valid markdown
  const parsed = parseSkillMd(skillMdPath);
  if (!parsed) {
    errors.push('SKILL.md file cannot be parsed');
    return { valid: false, errors, warnings };
  }

  // 3. Check SKILL.md content for dangerous patterns
  for (const pat of SKILL_DANGEROUS_PATTERNS) {
    if (pat.test(parsed.content)) {
      warnings.push(`SKILL.md contains suspicious pattern: ${pat.source}`);
    }
  }

  // 4. Check for executable files or scripts
  try {
    const allFiles = [];
    function collectFiles(dir, depth) {
      if (depth > 3 || allFiles.length > SKILL_DIR_MAX_FILES) return;
      const ents = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { collectFiles(fp, depth + 1); continue; }
        allFiles.push({ name: e.name, path: fp });
      }
    }
    collectFiles(skillDir, 0);

    if (allFiles.length > SKILL_DIR_MAX_FILES) {
      warnings.push(`Directory contains too many files (>${SKILL_DIR_MAX_FILES})`);
    }

    // Check for suspicious file types
    const suspiciousExts = ['.sh', '.bash', '.py', '.js', '.ts', '.exe', '.bat', '.cmd', '.ps1', '.rb', '.pl'];
    for (const f of allFiles) {
      const ext = path.extname(f.name).toLowerCase();
      if (suspiciousExts.includes(ext)) {
        warnings.push(`Contains script files: ${f.name}`);
      }
      // Check for large binary files
      try {
        const fstat = fs.statSync(f.path);
        if (fstat.size > 5 * 1024 * 1024) {
          warnings.push(`Large file (>${Math.round(fstat.size / 1024 / 1024)}MB): ${f.name}`);
        }
      } catch {}
    }

    // Check other .md files for dangerous patterns
    for (const f of allFiles) {
      if (path.extname(f.name).toLowerCase() !== '.md') continue;
      if (f.name === 'SKILL.md') continue;
      try {
        const content = fs.readFileSync(f.path, 'utf8').slice(0, 50000);
        for (const pat of SKILL_DANGEROUS_PATTERNS) {
          if (pat.test(content)) {
            warnings.push(`${f.name} contains suspicious pattern: ${pat.source}`);
            break;
          }
        }
      } catch {}
    }
  } catch (e) {
    warnings.push(`Directory scan error: ${e.message}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Clean up scan temp directory */
function cleanScanTmp() {
  try {
    if (fs.existsSync(SKILL_SCAN_TMP)) {
      fs.rmSync(SKILL_SCAN_TMP, { recursive: true, force: true });
    }
  } catch {}
}

/** Check if a skill is already installed in any recognized skills directory */
function isSkillInstalled(dirName) {
  ensureOpenclawPkgRoot();
  // Check bundled
  if (fs.existsSync(path.join(OPENCLAW_BUNDLED_SKILLS_DIR, dirName, 'SKILL.md'))) return true;
  // Check managed
  if (fs.existsSync(path.join(OPENCLAW_MANAGED_SKILLS_DIR, dirName, 'SKILL.md'))) return true;
  // Check extension skills
  try {
    if (fs.existsSync(OPENCLAW_EXTENSIONS_DIR)) {
      const exts = fs.readdirSync(OPENCLAW_EXTENSIONS_DIR, { withFileTypes: true });
      for (const ext of exts) {
        if (!ext.isDirectory()) continue;
        if (fs.existsSync(path.join(OPENCLAW_EXTENSIONS_DIR, ext.name, 'skills', dirName, 'SKILL.md'))) return true;
      }
    }
  } catch {}
  return false;
}

async function listUserExtensions() {
  try {
    const [json, npmRoot] = await Promise.all([
      runCommandTextAsync('npm list -g --depth=0 --json 2>/dev/null', 10000),
      runCommandTextAsync('npm root -g 2>/dev/null', 3000)
    ]);
    if (!json || !npmRoot) return [];
    const parsed = JSON.parse(json);
    const deps = parsed.dependencies || {};
    const results = [];
    for (const [name, info] of Object.entries(deps)) {
      // Skip openclaw itself and non-openclaw packages
      if (name === 'openclaw' || name === 'npm' || name === 'corepack') continue;
      const pluginJson = path.join(npmRoot, name, 'openclaw.plugin.json');
      const pkgJson = path.join(npmRoot, name, 'package.json');
      let isOpenClawExt = false;
      let description = '';
      let version = info.version || '';
      // Check openclaw.plugin.json existence
      if (fs.existsSync(pluginJson)) {
        isOpenClawExt = true;
      } else if (fs.existsSync(pkgJson)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
          if (pkg.openclaw || (pkg.keywords && pkg.keywords.includes('openclaw'))) {
            isOpenClawExt = true;
          }
          description = pkg.description || '';
          version = pkg.version || version;
        } catch {}
      }
      if (isOpenClawExt) {
        results.push({ name, version, description });
      }
    }
    return results;
  } catch {
    return [];
  }
}

// List ALL openclaw plugins (built-in + user) via CLI JSON output
async function listAllPlugins() {
  const cmd = [
    'if command -v openclaw >/dev/null 2>&1; then',
    '  openclaw plugins list --json 2>/dev/null',
    'elif [ -x /root/.npm-global/bin/openclaw ]; then',
    '  /root/.npm-global/bin/openclaw plugins list --json 2>/dev/null',
    'elif [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
    '  node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs plugins list --json 2>/dev/null',
    'else',
    '  echo "{}"',
    'fi'
  ].join('\n');
  const result = await runOpenClawCli(cmd, 30000);
  const raw = String(result.stdout || result.output || '');
  // Extract JSON (skip any [plugins] log lines before the JSON)
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) return [];
  try {
    const parsed = JSON.parse(raw.slice(jsonStart));
    const channelDescRe = /\bchannel\s+plugin\b/i;
    const providerDescRe = /\bprovider\b/i;
    return (parsed.plugins || []).map(p => {
      const desc = p.description || '';
      const hasChannel = (p.channelIds && p.channelIds.length) || channelDescRe.test(desc);
      const hasProvider = (p.providerIds && p.providerIds.length) || (!hasChannel && providerDescRe.test(desc));
      const category = hasChannel ? 'channel' : hasProvider ? 'provider' : 'tool';
      return {
        id: p.id,
        name: p.name || p.id,
        description: desc,
        version: p.version || '',
        status: p.status || 'unknown',
        enabled: !!p.enabled,
        origin: p.origin || 'bundled',
        category,
        channelIds: p.channelIds || [],
        providerIds: p.providerIds || [],
        toolNames: p.toolNames || [],
        hookCount: p.hookCount || 0,
        httpRoutes: p.httpRoutes || 0,
      };
    });
  } catch {
    return [];
  }
}

app.get('/api/plugins/list', async (req, res) => {
  try {
    const [skills, extensions, allPlugins] = await Promise.all([
      Promise.resolve(listUserSkills()),
      listUserExtensions(),
      listAllPlugins()
    ]);
    res.json({ skills, extensions, allPlugins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enable/disable a plugin
app.post('/api/plugins/extension/toggle', async (req, res) => {
  const { id, enable } = req.body || {};
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'missing plugin id' });
  const action = enable ? 'enable' : 'disable';
  const cmd = [
    'if command -v openclaw >/dev/null 2>&1; then',
    `  openclaw plugins ${action} ${JSON.stringify(id)} 2>&1`,
    'elif [ -x /root/.npm-global/bin/openclaw ]; then',
    `  /root/.npm-global/bin/openclaw plugins ${action} ${JSON.stringify(id)} 2>&1`,
    'elif [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
    `  node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs plugins ${action} ${JSON.stringify(id)} 2>&1`,
    'else',
    '  echo "openclaw not found"; exit 127',
    'fi'
  ].join('\n');
  try {
    const result = await runOpenClawCli(cmd, 15000);
    const output = stripAnsi(String(result.output || '')).trim();
    if (!result.ok) return res.status(500).json({ success: false, error: output });
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update all plugins
app.post('/api/plugins/extension/update-all', async (req, res) => {
  const cmd = [
    'if command -v openclaw >/dev/null 2>&1; then',
    '  openclaw plugins update --all 2>&1',
    'elif [ -x /root/.npm-global/bin/openclaw ]; then',
    '  /root/.npm-global/bin/openclaw plugins update --all 2>&1',
    'elif [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
    '  node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs plugins update --all 2>&1',
    'else',
    '  echo "openclaw not found"; exit 127',
    'fi'
  ].join('\n');
  try {
    const result = await runOpenClawCli(cmd, 120000);
    const output = stripAnsi(String(result.output || '')).trim();
    if (!result.ok) return res.status(500).json({ success: false, error: output });
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scan GitHub repo or local dir for available skills
app.post('/api/plugins/skill/scan', async (req, res) => {
  const { source, localPath } = req.body || {};
  if (!source || typeof source !== 'string') {
    return res.status(400).json({ error: 'Provide a GitHub URL or local directory path' });
  }

  const sanitized = source.trim();
  if (sanitized.length > 1000) {
    return res.status(400).json({ error: 'Input too long' });
  }

  try {
    let scanDir;
    let isGitClone = false;

    // Determine if it's a GitHub/git URL or local path
    const isGitUrl = /^https?:\/\//.test(sanitized) || /^git@/.test(sanitized) || /\.git$/.test(sanitized);

    if (isGitUrl) {
      // Validate URL to prevent SSRF
      if (/[;&|`$(){}]/.test(sanitized)) {
        return res.status(400).json({ error: 'Invalid URL' });
      }
      // Only allow github.com, gitlab.com, gitee.com
      try {
        const parsed = new URL(sanitized);
        const allowedHosts = ['github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org'];
        if (!allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
          return res.status(400).json({ error: `Unsupported Git host: ${parsed.hostname}。Only GitHub/GitLab/Gitee/Bitbucket are supported` });
        }
      } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
      }

      // Clone to temp dir
      cleanScanTmp();
      fs.mkdirSync(SKILL_SCAN_TMP, { recursive: true });
      scanDir = SKILL_SCAN_TMP;
      isGitClone = true;

      await runCommandTextAsync(
        `git clone --depth=1 ${JSON.stringify(sanitized)} ${JSON.stringify(SKILL_SCAN_TMP)} 2>&1`,
        120000
      );
    } else if (localPath || sanitized.startsWith('/')) {
      // Local directory scan
      const dirPath = (localPath || sanitized).trim();
      // Prevent path traversal - must be absolute path
      if (!path.isAbsolute(dirPath)) {
        return res.status(400).json({ error: 'Please provide an absolute path' });
      }
      // Block sensitive directories
      const blocked = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root/.ssh', '/root/.gnupg'];
      if (blocked.some(b => dirPath === b || dirPath.startsWith(b + '/'))) {
        return res.status(400).json({ error: 'This directory cannot be scanned' });
      }
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        return res.status(400).json({ error: 'Directory does not exist or is not a directory' });
      }
      scanDir = dirPath;
    } else {
      return res.status(400).json({ error: 'Please provide a valid GitHub URL or local directory path' });
    }

    // Scan for skills
    const skills = findSkillsInDir(scanDir);

    // Run security validation on each found skill
    const results = skills.map(s => {
      const check = validateSkillSecurity(s.absPath);
      // Compute content hash for update detection
      let contentHash = '';
      try {
        const smPath = path.join(s.absPath, 'SKILL.md');
        if (fs.existsSync(smPath)) {
          contentHash = crypto.createHash('md5').update(fs.readFileSync(smPath, 'utf8')).digest('hex');
        }
      } catch {}
      return {
        ...s,
        valid: check.valid,
        errors: check.errors,
        warnings: check.warnings,
        contentHash,
        installed: isSkillInstalled(s.dirName)
      };
    });

    res.json({
      source: sanitized,
      isGit: isGitClone,
      scanDir,
      total: results.length,
      skills: results
    });
  } catch (e) {
    cleanScanTmp();
    res.status(500).json({ error: `Scan failed: ${e.message}` });
  }
});

// Install selected skills from scan results
app.post('/api/plugins/skill/install-selected', async (req, res) => {
  const { skills, source } = req.body || {};
  if (!Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: 'Please select Skills to install' });
  }

  // Ensure skills dir exists
  if (!fs.existsSync(OPENCLAW_SKILLS_DIR)) {
    fs.mkdirSync(OPENCLAW_SKILLS_DIR, { recursive: true });
  }

  const results = [];
  for (const skill of skills) {
    const { dirName, relPath, absPath } = skill;
    if (!dirName || typeof dirName !== 'string') {
      results.push({ name: dirName, success: false, error: 'Invalid skill name' });
      continue;
    }

    // Safe name
    const safeName = path.basename(dirName);
    if (safeName !== dirName || dirName.includes('..')) {
      results.push({ name: dirName, success: false, error: 'Name contains illegal characters' });
      continue;
    }

    const dest = path.join(OPENCLAW_SKILLS_DIR, safeName);
    const existed = fs.existsSync(dest);

    // Determine source path
    let srcPath = absPath;
    if (!srcPath || !fs.existsSync(srcPath)) {
      // Try to reconstruct from scan tmp
      if (relPath && fs.existsSync(path.join(SKILL_SCAN_TMP, relPath))) {
        srcPath = path.join(SKILL_SCAN_TMP, relPath);
      } else {
        results.push({ name: safeName, success: false, error: 'Source directory does not exist' });
        continue;
      }
    }

    // Final security check
    const check = validateSkillSecurity(srcPath);
    if (!check.valid) {
      results.push({ name: safeName, success: false, error: `Security check failed: ${check.errors.join('; ')}` });
      continue;
    }

    try {
      // Remove existing if updating
      if (existed) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      // Copy skill dir — use cp -a for proper copy
      execSync(`cp -a ${JSON.stringify(srcPath)} ${JSON.stringify(dest)}`, { timeout: 30000 });
      // Remove .git dir if present (from cloned repos)
      const gitDir = path.join(dest, '.git');
      if (fs.existsSync(gitDir)) {
        fs.rmSync(gitDir, { recursive: true, force: true });
      }
      results.push({ name: safeName, success: true, updated: existed, warnings: check.warnings });
    } catch (e) {
      results.push({ name: safeName, success: false, error: e.message });
    }
  }

  // Clean up scan temp
  cleanScanTmp();

  const successCount = results.filter(r => r.success).length;
  res.json({
    success: successCount > 0,
    total: skills.length,
    installed: successCount,
    results
  });
});

// Upload and install skills from browser local filesystem
app.post('/api/plugins/skill/upload-install', (req, res) => {
  const { skills } = req.body || {};
  if (!Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: 'Please select Skills to install' });
  }
  if (skills.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 Skills per install' });
  }

  if (!fs.existsSync(OPENCLAW_SKILLS_DIR)) {
    fs.mkdirSync(OPENCLAW_SKILLS_DIR, { recursive: true });
  }

  const results = [];
  for (const skill of skills) {
    const { dirName, files } = skill;
    if (!dirName || typeof dirName !== 'string') {
      results.push({ name: dirName || '?', success: false, error: 'Invalid skill name' });
      continue;
    }
    const safeName = path.basename(dirName);
    if (safeName !== dirName || /[.]{2}/.test(dirName)) {
      results.push({ name: dirName, success: false, error: 'Name contains illegal characters' });
      continue;
    }
    if (!Array.isArray(files) || files.length === 0) {
      results.push({ name: safeName, success: false, error: 'No file content' });
      continue;
    }
    if (!files.some(f => f.path === 'SKILL.md')) {
      results.push({ name: safeName, success: false, error: 'Missing SKILL.md file' });
      continue;
    }

    const dest = path.join(OPENCLAW_SKILLS_DIR, safeName);
    const existed = fs.existsSync(dest);

    try {
      if (existed) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      fs.mkdirSync(dest, { recursive: true });

      for (const f of files) {
        if (!f.path || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
        const safePath = path.normalize(f.path);
        if (safePath.startsWith('..') || path.isAbsolute(safePath)) continue;
        // Block hidden files
        if (safePath.split('/').some(seg => seg.startsWith('.'))) continue;
        const fileDest = path.join(dest, safePath);
        fs.mkdirSync(path.dirname(fileDest), { recursive: true });
        fs.writeFileSync(fileDest, Buffer.from(f.content, 'base64'));
      }

      // Server-side security validation (defense in depth)
      const check = validateSkillSecurity(dest);
      results.push({ name: safeName, success: true, updated: existed, warnings: check.warnings });
    } catch (e) {
      results.push({ name: safeName, success: false, error: e.message });
    }
  }

  const successCount = results.filter(r => r.success).length;
  res.json({
    success: successCount > 0,
    total: skills.length,
    installed: successCount,
    results
  });
});

// ===================== APP CENTER =====================
const APPS_DIR = path.join(process.env.HOME || '/root', '.openclaw', 'apps');

// Reverse proxy for installed apps — forward /apps/<id>/* to the app's port
app.use('/apps/:appId', (req, res) => {
  // Read app.json to find the port
  const appJsonPath = path.join(APPS_DIR, req.params.appId, 'app.json');
  let meta;
  try { meta = JSON.parse(fs.readFileSync(appJsonPath, 'utf8')); } catch { return res.status(404).send('App not found'); }
  if (!meta.port) return res.status(400).send('App has no port configured');
  const targetUrl = 'http://127.0.0.1:' + meta.port + (req.url === '/' ? '/index.html' : req.url);
  const http = require('http');
  http.get(targetUrl, (upstream) => {
    const ct = upstream.headers['content-type'];
    if (ct) res.setHeader('Content-Type', ct);
    res.status(upstream.statusCode);
    upstream.pipe(res);
  }).on('error', (e) => {
    res.status(502).send('App not reachable: ' + e.message);
  });
});

app.get('/api/app-center/list', async (req, res) => {
  const apps = [];
  try {
    if (fs.existsSync(APPS_DIR)) {
      const entries = fs.readdirSync(APPS_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const appJsonPath = path.join(APPS_DIR, e.name, 'app.json');
        if (!fs.existsSync(appJsonPath)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
          // Check if service is running (best effort)
          let status = 'unknown';
          if (meta.port) {
            try {
              const http = require('http');
              status = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve('stopped'), 2000);
                const r = http.get({ hostname: '127.0.0.1', port: meta.port, path: '/', timeout: 1500 }, (resp) => {
                  resp.resume(); // drain response body
                  clearTimeout(timer);
                  resolve(resp.statusCode ? 'running' : 'stopped');
                });
                r.on('error', () => { clearTimeout(timer); resolve('stopped'); });
                r.on('timeout', () => { r.destroy(); clearTimeout(timer); resolve('stopped'); });
              });
            } catch { status = 'unknown'; }
          }
          apps.push({ ...meta, status, dirName: e.name });
        } catch {}
      }
    }
  } catch (e) {
    console.error('[app-center] scan error:', e.message);
  }
  res.json({ apps });
});

// Install app: clone repo and start HTTP server
app.post('/api/app-center/install', async (req, res) => {
  try {
    const { id, name, displayName, description, icon, version, features, repo, port, entryPath, category } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing app id' });
    const appDir = path.join(APPS_DIR, id);
    if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });
    if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });

    const workspaceDir = path.join(process.env.HOME || '/root', '.openclaw', 'workspace', id);

    // Step 1: Clone or update repo from GitHub
    if (repo) {
      const { execSync } = require('child_process');
      if (fs.existsSync(path.join(workspaceDir, '.git'))) {
        // Already a git repo — pull latest
        console.log('[app-center] Pulling latest from', repo);
        try {
          execSync(`cd ${workspaceDir} && git pull --ff-only`, { timeout: 60000, stdio: 'pipe' });
        } catch (pullErr) {
          console.log('[app-center] git pull failed:', pullErr.message);
        }
      } else {
        // Fresh clone (remove stale workspace if exists)
        if (fs.existsSync(workspaceDir)) fs.rmSync(workspaceDir, { recursive: true, force: true });
        console.log('[app-center] Cloning', repo, 'to', workspaceDir);
        execSync(`git clone --depth 1 ${repo} ${workspaceDir}`, { timeout: 120000, stdio: 'pipe' });
      }
    }

    // Step 2: Start HTTP server if port specified
    let pid = null;
    if (port && fs.existsSync(workspaceDir)) {
      try {
        const { execSync: es } = require('child_process');
        const existing = es(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
        if (existing) {
          pid = parseInt(existing.split('\n')[0]);
          console.log('[app-center] Port', port, 'already in use by PID', pid);
        }
      } catch {}

      if (!pid) {
        const { spawn } = require('child_process');
        const srv = spawn('python3', ['-m', 'http.server', String(port)], {
          cwd: workspaceDir,
          detached: true,
          stdio: 'ignore'
        });
        srv.unref();
        pid = srv.pid;
        console.log('[app-center] Started HTTP server on port', port, 'PID', pid);
      }
    }

    const meta = {
      name: id, displayName: displayName || name, description, icon, version,
      features, repo, port, entryPath, category, pid,
      workspaceDir,
      installedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify(meta, null, 2));
    console.log('[app-center] Installed app:', id);
    res.json({ ok: true, app: meta });
  } catch (e) {
    console.error('[app-center] install error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update app: git pull and restart server
app.post('/api/app-center/update', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing app id' });
    const appDir = path.join(APPS_DIR, id);
    const appJsonPath = path.join(appDir, 'app.json');
    if (!fs.existsSync(appJsonPath)) return res.status(404).json({ error: 'App not installed' });

    const meta = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    const workspaceDir = meta.workspaceDir || path.join(process.env.HOME || '/root', '.openclaw', 'workspace', id);
    const { execSync } = require('child_process');

    // Step 1: git pull
    let updated = false;
    let oldHead = '', newHead = '';
    if (fs.existsSync(path.join(workspaceDir, '.git'))) {
      oldHead = execSync(`cd ${workspaceDir} && git rev-parse --short HEAD`, { encoding: 'utf8', timeout: 10000 }).trim();
      execSync(`cd ${workspaceDir} && git pull --ff-only`, { timeout: 60000, stdio: 'pipe' });
      newHead = execSync(`cd ${workspaceDir} && git rev-parse --short HEAD`, { encoding: 'utf8', timeout: 10000 }).trim();
      updated = oldHead !== newHead;
      console.log('[app-center] Update', id, ':', oldHead, '->', newHead, updated ? '(updated)' : '(already latest)');
    } else {
      return res.status(400).json({ error: 'No git repo in workspace' });
    }

    // Step 2: restart server if port configured
    if (meta.port) {
      const pids = execSync(`lsof -ti:${meta.port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      if (pids) {
        for (const p of pids.split('\n')) { try { process.kill(parseInt(p)); } catch {} }
      }
      await new Promise(r => setTimeout(r, 500));
      const { spawn } = require('child_process');
      const srv = spawn('python3', ['-m', 'http.server', String(meta.port)], {
        cwd: workspaceDir, detached: true, stdio: 'ignore'
      });
      srv.unref();
      meta.pid = srv.pid;
      console.log('[app-center] Restarted', id, 'on port', meta.port, 'PID', srv.pid);
    }

    // Step 3: update app.json with new version from repo if available
    const repoAppJson = path.join(workspaceDir, 'app.json');
    if (fs.existsSync(repoAppJson)) {
      try {
        const repoMeta = JSON.parse(fs.readFileSync(repoAppJson, 'utf8'));
        if (repoMeta.version) meta.version = repoMeta.version;
        if (repoMeta.features) meta.features = repoMeta.features;
        if (repoMeta.description) meta.description = repoMeta.description;
      } catch {}
    }
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(appJsonPath, JSON.stringify(meta, null, 2));

    res.json({ ok: true, updated, oldVersion: oldHead, newVersion: newHead });
  } catch (e) {
    console.error('[app-center] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Uninstall app: stop server and remove from app-center
app.post('/api/app-center/uninstall', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing app id' });
    const appDir = path.join(APPS_DIR, id);

    // Try to stop the app server
    if (fs.existsSync(path.join(appDir, 'app.json'))) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
        if (meta.port) {
          const { execSync } = require('child_process');
          const pids = execSync(`lsof -ti:${meta.port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
          if (pids) {
            for (const p of pids.split('\n')) {
              try { process.kill(parseInt(p)); } catch {}
            }
            console.log('[app-center] Stopped processes on port', meta.port);
          }
        }
      } catch {}
    }

    if (fs.existsSync(appDir)) {
      fs.rmSync(appDir, { recursive: true, force: true });
      console.log('[app-center] Uninstalled app:', id);
    }
    // Also remove workspace
    const workspaceDir = path.join(process.env.HOME || '/root', '.openclaw', 'workspace', id);
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      console.log('[app-center] Removed workspace:', workspaceDir);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[app-center] uninstall error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Start app: launch HTTP server for an installed app
app.post('/api/app-center/start', async (req, res) => {
  try {
    const { id, port } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing app id' });
    const appDir = path.join(APPS_DIR, id);
    const appJsonPath = path.join(appDir, 'app.json');
    if (!fs.existsSync(appJsonPath)) return res.status(404).json({ error: 'App not found' });

    const meta = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    const workspaceDir = meta.workspaceDir || path.join(process.env.HOME || '/root', '.openclaw', 'workspace', id);
    const appPort = port || meta.port;

    if (!appPort || !fs.existsSync(workspaceDir)) {
      return res.status(400).json({ error: 'Cannot start: no port or workspace' });
    }

    // Check if already running
    const { execSync } = require('child_process');
    const existing = execSync(`lsof -ti:${appPort} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (existing) {
      return res.json({ ok: true, pid: parseInt(existing), message: 'Already running' });
    }

    const { spawn } = require('child_process');
    const srv = spawn('python3', ['-m', 'http.server', String(appPort)], {
      cwd: workspaceDir,
      detached: true,
      stdio: 'ignore'
    });
    srv.unref();

    // Update app.json with new PID
    meta.pid = srv.pid;
    fs.writeFileSync(appJsonPath, JSON.stringify(meta, null, 2));

    console.log('[app-center] Started app', id, 'on port', appPort, 'PID', srv.pid);
    res.json({ ok: true, pid: srv.pid });
  } catch (e) {
    console.error('[app-center] start error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// App profile sync: saves learning profile for OpenClaw analysis
app.post('/api/app-center/sync-profile', async (req, res) => {
  try {
    const profile = req.body;
    if (!profile || !profile.username) return res.status(400).json({ error: 'profile data required' });
    
    const fs = require('fs');
    const path = require('path');
    
    // Find the physics app workspace
    const workspaceDirs = [
      '/root/.openclaw/workspace/jiangsu-physics-knowledge/.openclaw/learning-profile',
      path.join(process.cwd(), '..', 'jiangsu-physics-knowledge', '.openclaw', 'learning-profile')
    ];
    
    let targetDir = null;
    for (const dir of workspaceDirs) {
      if (fs.existsSync(path.dirname(dir))) {
        targetDir = dir;
        break;
      }
    }
    
    if (!targetDir) {
      // Fallback: create in temp
      targetDir = '/tmp/openclaw-learning-profile';
    }
    
    fs.mkdirSync(targetDir, { recursive: true });
    const filePath = path.join(targetDir, 'profile.json');
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
    
    console.log(`[sync-profile] Saved profile for ${profile.username} to ${filePath}`);
    res.json({ ok: true, path: filePath });
  } catch (e) {
    console.error('[sync-profile] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// App AI proxy: forwards chat requests through OpenClaw gateway (like Feishu/messaging plugins)
app.post('/api/app-center/ai/chat', async (req, res) => {
  let client = null;
  try {
    const { messages, sessionKey: reqSessionKey } = req.body || {};
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });

    const systemMsg = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const userMsg = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    const fullMessage = systemMsg ? `[System Instruction]\n${systemMsg}\n\n[User Request]\n${userMsg}` : userMsg;
    const sessionKey = reqSessionKey || 'app:physics-quiz-' + Date.now();

    console.log('[app-center/ai] Connecting to gateway...');
    client = await createGatewayControlUiClient(10000);
    console.log('[app-center/ai] Connected.');

    // Listen for chat events on the WS
    let responseChunks = [];
    let finalResponse = '';
    let chatDone = false;
    let chatError = null;

    client.on('chat', (payload) => {
      console.log('[app-center/ai] chat event: state=' + payload?.state);
      if (!payload) return;
      const extractText = (msg) => {
        if (!msg) return '';
        if (typeof msg === 'string') return msg;
        if (typeof msg.text === 'string') return msg.text;
        if (Array.isArray(msg.content)) return msg.content.map(b => b.text || (typeof b === 'string' ? b : '')).join('');
        if (typeof msg.content === 'string') return msg.content;
        return '';
      };
      if (payload.state === 'delta' && payload.message) {
        const txt = extractText(payload.message);
        if (txt) responseChunks.push(txt);
      }
      if (payload.state === 'final') {
        const txt = extractText(payload.message);
        if (txt) finalResponse = txt;
        chatDone = true;
      }
      if (payload.state === 'error') {
        chatError = payload.error || 'Unknown AI error';
        chatDone = true;
      }
    });

    console.log('[app-center/ai] Sending chat.send, sessionKey=' + sessionKey);
    let sendResult;
    try {
      sendResult = await client.request('chat.send', {
        sessionKey,
        message: fullMessage,
        deliver: true,
        timeoutMs: 120000,
        idempotencyKey: crypto.randomUUID()
      }, 15000);
      console.log('[app-center/ai] chat.send ack:', JSON.stringify(sendResult || {}).slice(0, 300));
    } catch (sendErr) {
      console.log('[app-center/ai] chat.send error:', sendErr.message);
    }

    // Wait for chat events (streaming response)
    const maxWaitMs = 120000;
    const start = Date.now();

    while (!chatDone && Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 1000));
    }

    client.close();
    client = null;

    if (chatError) return res.json({ error: 'AI error: ' + chatError });

    const reply = finalResponse || responseChunks.join('');
    if (!reply) {
      console.log('[app-center/ai] No response within timeout');
      return res.json({ error: 'OpenClaw did not return a response in time' });
    }

    console.log('[app-center/ai] Got response, length=' + reply.length);
    res.json({ choices: [{ message: { role: 'assistant', content: reply } }] });
  } catch (e) {
    if (client) try { client.close(); } catch {}
    console.error('[app-center/ai] error:', e.message);
    res.status(502).json({ error: 'OpenClaw Gateway error: ' + e.message });
  }
});

// Legacy: direct install from git URL (backward compat)
app.post('/api/plugins/skill/install', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'missing url' });

  // Validate: must look like a git URL or simple name
  const sanitized = url.trim();
  if (sanitized.length > 500 || /[;&|`$(){}]/.test(sanitized)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    // Ensure skills dir exists
    if (!fs.existsSync(OPENCLAW_SKILLS_DIR)) {
      fs.mkdirSync(OPENCLAW_SKILLS_DIR, { recursive: true });
    }
    // Derive skill name from URL
    const parts = sanitized.replace(/\.git$/, '').split('/');
    const skillName = parts[parts.length - 1] || 'skill';
    const dest = path.join(OPENCLAW_SKILLS_DIR, skillName);

    if (fs.existsSync(dest)) {
      return res.status(409).json({ error: `Skill "${skillName}" already exists, please remove before installing` });
    }

    const output = await runCommandTextAsync(
      `git clone --depth=1 ${JSON.stringify(sanitized)} ${JSON.stringify(dest)} 2>&1`,
      120000
    );
    // Verify SKILL.md exists
    const hasSkillMd = fs.existsSync(path.join(dest, 'SKILL.md'));
    res.json({
      success: true,
      output: output + (hasSkillMd ? '' : '\n⚠️ Note: SKILL.md file not found in this repository')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plugins/skill/remove', async (req, res) => {
  ensureOpenclawPkgRoot();
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'missing name' });

  // Prevent path traversal
  const safeName = path.basename(name);
  if (safeName !== name || name.includes('..')) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  // Search all skill dirs for this skill
  const candidates = [
    path.join(OPENCLAW_BUNDLED_SKILLS_DIR, safeName),
    path.join(OPENCLAW_MANAGED_SKILLS_DIR, safeName),
  ];
  // Also check extension skills
  try {
    if (fs.existsSync(OPENCLAW_EXTENSIONS_DIR)) {
      for (const ext of fs.readdirSync(OPENCLAW_EXTENSIONS_DIR, { withFileTypes: true })) {
        if (ext.isDirectory()) candidates.push(path.join(OPENCLAW_EXTENSIONS_DIR, ext.name, 'skills', safeName));
      }
    }
  } catch {}

  const dir = candidates.find(d => fs.existsSync(d));
  if (!dir) {
    return res.status(404).json({ error: `Skill "${safeName}" does not exist` });
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plugins/extension/install', async (req, res) => {
  const pkg = (req.body || {}).package;
  if (!pkg || typeof pkg !== 'string') return res.status(400).json({ error: 'missing package' });

  const sanitized = pkg.trim();
  if (sanitized.length > 500 || /[;&|`$()\\]/.test(sanitized)) {
    return res.status(400).json({ error: 'Invalid package name or command' });
  }

  // Detect install format
  const isNpxCmd = /^npx\s+(-y\s+)?@?[a-z0-9-~]/.test(sanitized);
  const isNpmPkg = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^\s]*)?$/.test(sanitized);
  const isGithubShort = /^github:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(#.*)?$/.test(sanitized);
  const isGitUrl = /^https?:\/\/(github\.com|gitlab\.com|gitee\.com)\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git)?(\/?#.*)?$/.test(sanitized);
  if (!isNpxCmd && !isNpmPkg && !isGithubShort && !isGitUrl) {
    return res.status(400).json({ error: 'Supported formats: npm package, github:user/repo, GitHub URL, or npx command (e.g. npx -y @scope/cli install)' });
  }

  try {
    // Ensure openclaw/plugin-sdk is resolvable for source-installed OpenClaw
    const linkResult = ensureOpenclawModuleLink();
    const linkLog = linkResult.created
      ? `[symlink] Created openclaw module link: ${linkResult.path} → ${linkResult.target}\n`
      : '';

    // npx commands run directly (e.g. npx -y @tencent-weixin/openclaw-weixin-cli@latest install)
    if (isNpxCmd) {
      const npxResult = await runOpenClawCli(sanitized, 180000);
      const output = stripAnsi(String(npxResult.output || '')).trim();
      const fullOutput = linkLog + output;
      const hasLoadError = /\b(failed to load|Cannot find module|PluginLoadFailureError)\b/i.test(output);
      const hasInstallOk = /\b(Installed plugin|Installing to|插件就绪|already at)\b/i.test(output);
      // Plugin installed but failed to load → warning
      if (hasInstallOk && hasLoadError) {
        return res.json({ success: true, output: fullOutput, warning: 'Plugin installed but failed to load — possible version mismatch. Check install log for details.' });
      }
      const hasFatalError = !npxResult.ok || (!hasInstallOk && /\b(failed|error|not found)\b/i.test(output));
      if (hasFatalError) {
        return res.status(500).json({ success: false, error: fullOutput || 'npx command failed' });
      }
      return res.json({ success: true, output: fullOutput });
    }

    // Try openclaw plugins install first (proper way)
    const cliCmd = [
      'if command -v openclaw >/dev/null 2>&1; then',
      `  openclaw plugins install ${JSON.stringify(sanitized)} 2>&1`,
      'elif [ -x /root/.npm-global/bin/openclaw ]; then',
      `  /root/.npm-global/bin/openclaw plugins install ${JSON.stringify(sanitized)} 2>&1`,
      'elif [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
      `  node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs plugins install ${JSON.stringify(sanitized)} 2>&1`,
      'else',
      '  exit 127',
      'fi'
    ].join('\n');
    const cliResult = await runOpenClawCli(cliCmd, 120000);
    const cliOutput = stripAnsi(String(cliResult.output || '')).trim();
    // If install failed because plugin already exists, remove it and retry
    if (!cliResult.ok && /plugin already exists.*delete it first/i.test(cliOutput)) {
      const pluginIdMatch = cliOutput.match(/extensions\/([^\s()]+)/);
      if (pluginIdMatch) {
        const extDir = `/root/.openclaw/extensions/${pluginIdMatch[1]}`;
        await runOpenClawCli(`rm -rf ${JSON.stringify(extDir)} 2>&1`, 10000);
        const retryResult = await runOpenClawCli(cliCmd, 120000);
        const retryOutput = stripAnsi(String(retryResult.output || '')).trim();
        if (retryResult.ok) {
          return res.json({ success: true, output: linkLog + retryOutput });
        }
        return res.status(500).json({ success: false, error: linkLog + retryOutput });
      }
    }
    if (cliResult.ok) {
      const cliHasError = /\b(failed to load|Cannot find module|PluginLoadFailureError)\b/i.test(cliOutput);
      const cliFullOutput = linkLog + cliOutput;
      if (cliHasError) {
        return res.json({ success: true, output: cliFullOutput, warning: 'Plugin installed but failed to load — possible version mismatch' });
      }
      return res.json({ success: true, output: cliFullOutput });
    }
    // Fallback to npm install -g if CLI failed
    const npmResult = await runOpenClawCli(`npm install -g ${JSON.stringify(sanitized)} 2>&1`, 120000);
    const npmOutput = stripAnsi(String(npmResult.output || '')).trim();
    if (!npmResult.ok) {
      return res.status(500).json({ success: false, error: linkLog + (npmOutput || 'npm install failed') });
    }
    res.json({ success: true, output: linkLog + npmOutput });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plugins/extension/remove', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'missing name' });

  const sanitized = name.trim();
  if (sanitized.length > 200 || /[;&|`$(){}]/.test(sanitized)) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  try {
    // Try openclaw plugins uninstall first
    const cliCmd = [
      'if command -v openclaw >/dev/null 2>&1; then',
      `  openclaw plugins uninstall ${JSON.stringify(sanitized)} 2>&1`,
      'elif [ -x /root/.npm-global/bin/openclaw ]; then',
      `  /root/.npm-global/bin/openclaw plugins uninstall ${JSON.stringify(sanitized)} 2>&1`,
      'elif [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
      `  node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs plugins uninstall ${JSON.stringify(sanitized)} 2>&1`,
      'else',
      '  exit 127',
      'fi'
    ].join('\n');
    const cliResult = await runOpenClawCli(cliCmd, 60000);
    if (cliResult.ok) {
      return res.json({ success: true, output: stripAnsi(String(cliResult.output || '')).trim() });
    }
    // Fallback to npm uninstall -g
    const output = await runCommandTextAsync(
      `npm uninstall -g ${JSON.stringify(sanitized)} 2>&1`,
      60000
    );
    res.json({ success: true, output: stripAnsi(output || '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  // Disable perMessageDeflate for terminal to avoid potential 1006 on some proxies/browsers
  termWss = new WebSocketServer({ 
    noServer: true,
    perMessageDeflate: false
  });

  wss.on('connection', (ws, req) => {
    if (!isAuthenticated(req)) {
      try { ws.close(1008, 'unauthorized'); } catch {}
      return;
    }

    // Send recent lines on connect
    try {
      const lines = tailLogLines(WS_LOG_BOOTSTRAP_LINES);
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
        const newLines = buf.toString('utf8').split('\n').filter(Boolean).map(sanitizeLogLine).filter(Boolean);
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
      } catch {
      }
    }

    if (!authenticated) {
      console.warn(`[terminal-ws] unauthorized connect: ${reqPath}`);
      setTerminalBackendState({ ready: false, reason: 'unauthorized websocket terminal request' });
      try { ws.close(1008, 'unauthorized'); } catch {}
      return;
    }

    closeActiveTerminalSession('new-connection');

    let shell, mode, reason;
    try {
      const res = createTerminalShell();
      shell = res.shell;
      mode = res.mode;
      reason = res.reason;
    } catch (err) {
      console.error('[terminal-ws] createTerminalShell failed:', err);
      setTerminalBackendState({ ready: false, reason: 'createTerminalShell error' });
      try { ws.close(1011, 'terminal-error'); } catch {}
      return;
    }

    if (!shell || !shell.stdin || !shell.stdout) {
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
      sendOutput('OpenClaw Terminal connected (fallback shell). Enter a command and press Enter to execute.\n');
      sendOutput('[terminal] script not detected in current environment, using compatibility mode.\n');
    }

    // Catch stdin errors to prevent crash
    shell.stdin.on('error', (err) => {
      // Ignore EPIPE
    });

    shell.stdout.on('data', (chunk) => sendOutput(chunk.toString('utf8')));
    shell.stdout.on('error', () => {}); // Prevent crash
    
    if (mode !== 'pty' && shell.stderr) {
      shell.stderr.on('data', (chunk) => sendOutput(chunk.toString('utf8')));
      shell.stderr.on('error', () => {}); // Prevent crash
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
          if (shell.stdin && !shell.stdin.destroyed) {
            shell.stdin.write(msg.data);
          }
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
      if (activeTerminalSession && activeTerminalSession.ws === ws) {
        activeTerminalSession = null;
      }
      try { if (shell.stdin && !shell.stdin.destroyed) shell.stdin.end(); } catch {}
      try { shell.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { shell.kill('SIGKILL'); } catch {}
      }, 1000);
    };

    activeTerminalSession = { ws, shell, mode, cleanup };

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
  const rawUrl = String(req.url || '');
  let pathname = '';
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    pathname = rawUrl.split('?')[0] || '';
  }

  if (WebSocketServer && pathname === '/api/ws/logs') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }

  if (WebSocketServer && pathname === '/api/ws/terminal') {
    try {
      termWss.handleUpgrade(req, socket, head, (ws) => {
        termWss.emit('connection', ws, req);
      });
    } catch (e) {
      console.error(`[terminal-ws] handleUpgrade error:`, e.message);
      socket.destroy();
    }
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

  // Rate limit WebSocket upgrades to gateway-proxy to prevent triggering gateway's auth rate limiter
  const clientIp = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const wsRateKey = `gwproxy-ws:${clientIp}`;
  const now = Date.now();
  if (!_gwProxyWsRateMap) _gwProxyWsRateMap = new Map();
  const lastTs = _gwProxyWsRateMap.get(wsRateKey) || 0;
  if (now - lastTs < 2000) {
    try { socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nConnection: close\r\n\r\n'); } catch {}
    socket.destroy();
    return;
  }
  _gwProxyWsRateMap.set(wsRateKey, now);
  // Cleanup old entries periodically
  if (_gwProxyWsRateMap.size > 100) {
    for (const [k, t] of _gwProxyWsRateMap) { if (now - t > 30000) _gwProxyWsRateMap.delete(k); }
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

server.on('connection', (socket) => {
  socket.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  repairOpenClawConfigProviders();
  normalizePairedDevicesScopes();
  sanitizeAllConfigBackups();
  checkOrphanInstallTask(); // C7: Detect orphan install processes on startup (DFMEA T2)
  console.log(`[web] OpenClaw Web Panel started: http://0.0.0.0:${PORT}`);

  // Browser Bridge now uses Caddy WSS proxy (main HTTPS port), no longer needs a separate port
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[web][error] port ${PORT} already in use, possible duplicate web-panel launch. Please stop the old process before starting.`);
  } else {
    console.error(`[web][error] Web panel startup failed: ${err?.message || err}`);
  }
  process.exit(1);
});
