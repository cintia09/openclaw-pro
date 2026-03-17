// ============================================================
// server.js — OpenClaw Web 管理面板 (docker/web)
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
// Helpers: API Key 加密/解密（AES-256-CBC + PBKDF2）
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
    console.log('[enc] 加密主密钥已自动生成');
  } catch (e) {
    console.warn('[enc] 无法生成加密密钥:', e.message);
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
    console.warn('[enc] 加密失败:', e.message);
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
    console.warn('[enc] 解密失败:', e.message);
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

// 启动时确保加密密钥存在
ensureEncryptionKey();

// 启动时自动修复：将 models.json 中被错误加密的 API key 解密回明文
// （models.json 必须保留明文，因为 openclaw gateway 直接读取）
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
          console.log(`[enc] 已将 ${pName} 的 API key 恢复为明文（openclaw 需要明文读取）`);
        }
      }
    }
    if (changed) {
      writeJson(modelsPath, models);
      console.log('[enc] models.json API key 修复完成');
    }
  } catch (e) {
    console.warn('[enc] API key 修复失败:', e.message);
  }
}
setTimeout(repairModelsJsonApiKeys, 3000);

// ============================================================
// OpenClaw 内置模型目录 — 启动时从 models.generated.js 加载
// 用于：保存配置时自动查询模型能力（reasoning, contextWindow 等）
// ============================================================
let _openclawModelCatalog = null; // { provider: { modelId: { name, api, reasoning, input, contextWindow, maxTokens, compat } } }

// 我们的 provider 名称 → OpenClaw 内置 provider 名称 映射
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

// 加载 OpenClaw 内置模型目录
function loadOpenClawModelCatalog() {
  // 支持多个可能的安装路径：npm-global 安装 和 openclaw-source 源码安装
  const catalogPaths = [
    '/root/.openclaw/openclaw-source/node_modules/@mariozechner/pi-ai/dist/models.generated.js',
    '/root/.npm-global/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/models.generated.js',
  ];
  const catalogPath = catalogPaths.find(p => fs.existsSync(p.replace('/dist/models.generated.js', '')));
  try {
    if (!catalogPath) {
      // 尝试从缓存中加载
      const cachePath = '/root/.openclaw/model-catalog-cache.json';
      if (fs.existsSync(cachePath)) {
        _openclawModelCatalog = readJson(cachePath, null);
        if (_openclawModelCatalog) {
          console.log(`[catalog] 已从缓存加载模型目录 (${Object.keys(_openclawModelCatalog).length} providers)`);
          return;
        }
      }
      console.log('[catalog] OpenClaw 模型目录未找到');
      return;
    }
    // 使用 require 加载 ESM 模块中的 MODELS
    const { execSync } = require('child_process');
    const json = execSync(`node -e "const m = require('${catalogPath}'); process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(m.MODELS).map(([p, models]) => [p, Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens, compat: model.compat || undefined }]))]))))"`, {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    });
    _openclawModelCatalog = JSON.parse(json);
    // 缓存到文件
    try {
      fs.writeFileSync('/root/.openclaw/model-catalog-cache.json', json, { encoding: 'utf8', mode: 0o600 });
    } catch {}
    const totalModels = Object.values(_openclawModelCatalog).reduce((sum, prov) => sum + Object.keys(prov).length, 0);
    console.log(`[catalog] 已加载 OpenClaw 模型目录: ${Object.keys(_openclawModelCatalog).length} providers, ${totalModels} models`);
  } catch (e) {
    console.warn('[catalog] 加载模型目录失败:', e.message);
  }
}
setTimeout(loadOpenClawModelCatalog, 1000);

// Gateway 支持的 api 枚举值（写入 openclaw.json 时必须校验）
const VALID_GATEWAY_API_VALUES = new Set([
  'openai-completions', 'openai-responses', 'openai-codex-responses',
  'anthropic-messages', 'google-generative-ai', 'github-copilot',
  'bedrock-converse-stream', 'ollama'
]);

/**
 * 将模型目录中的 api 值映射为 gateway 合法值
 * 如果值不在 gateway 支持列表中，返回对应 provider 的安全默认值
 */
function sanitizeApiValue(api, providerName) {
  if (!api || VALID_GATEWAY_API_VALUES.has(api)) return api;
  // 常见映射：azure-openai-responses → openai-responses
  const FALLBACK_MAP = {
    'azure-openai-responses': 'openai-responses',
    'azure-openai-completions': 'openai-completions',
  };
  if (FALLBACK_MAP[api]) return FALLBACK_MAP[api];
  // 按 provider 给默认值
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
 * 从 OpenClaw 内置目录查询模型能力
 * @param {string} providerName - 我们的 provider 名称 (如 'gemini', 'bailian')
 * @param {string} modelId - 模型 ID (如 'gemini-3-flash-preview')
 * @returns {object|null} 模型能力定义，或 null（未找到时）
 */
function lookupModelCapabilities(providerName, modelId) {
  if (!_openclawModelCatalog) {
    loadOpenClawModelCatalog();
  }
  if (!_openclawModelCatalog) return { _catalogUnavailable: true };

  // 1. 直接查找：先用映射后的 provider 名
  const openclawProvider = PROVIDER_TO_OPENCLAW_MAP[providerName.toLowerCase()] || providerName.toLowerCase();
  const providerModels = _openclawModelCatalog[openclawProvider];
  if (providerModels && providerModels[modelId]) {
    return providerModels[modelId];
  }

  // 2. 模糊匹配：在所有 provider 中按 modelId 搜索（处理 provider 名不一致的情况）
  for (const [prov, models] of Object.entries(_openclawModelCatalog)) {
    if (models[modelId]) {
      return models[modelId];
    }
  }

  // 3. 前缀匹配：例如 'gemini-3-flash-preview-0508' 匹配 'gemini-3-flash-preview'
  for (const [prov, models] of Object.entries(_openclawModelCatalog)) {
    for (const [id, model] of Object.entries(models)) {
      if (modelId.startsWith(id) || id.startsWith(modelId)) {
        return model;
      }
    }
  }

  // 4. 家族前缀匹配：提取模型家族前缀（纯字母部分），匹配同家族模型
  // 例如 'qwen3.5-plus' → 'qwen'，'claude-sonnet-4' → 'claude'，匹配 OpenClaw 目录中任意同家族模型
  const familyMatch = modelId.match(/^([a-z]+)/i);
  if (familyMatch) {
    const familyPrefix = familyMatch[1].toLowerCase();
    // 在所有 provider 中查找同家族的任意模型（以该前缀开头）
    for (const [prov, models] of Object.entries(_openclawModelCatalog)) {
      for (const [id, model] of Object.entries(models)) {
        // 检查模型ID是否以家族前缀开头（考虑多种命名格式：qwen-xxx, qwen/xxx, qwen_xxx）
        const idLower = id.toLowerCase();
        if (idLower.startsWith(familyPrefix + '-') ||
            idLower.startsWith(familyPrefix + '/') ||
            idLower.startsWith(familyPrefix + '_') ||
            idLower === familyPrefix) {
          // 找到同家族模型，标记为推测匹配
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
 * 为指定模型生成完整的 models.json 条目
 * 优先从 OpenClaw 内置目录获取真实能力，未命中时用安全默认值
 * @param {string} providerName - provider 名称
 * @param {string} modelId - 模型 ID
 * @returns {object} 完整的模型条目
 */
function buildModelEntry(providerName, modelId) {
  const catalogEntry = lookupModelCapabilities(providerName, modelId);

  if (catalogEntry?._catalogUnavailable) {
    console.log(`[catalog] 模型目录不可用，模型 ${providerName}/${modelId} 使用安全默认值`);
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
      console.log(`[catalog] 模型 ${providerName}/${modelId} api 值 "${catalogEntry.api}" 不被 gateway 支持，映射为 "${safeApi}"`);
    }
    if (isInferred) {
      console.log(`[catalog] 模型 ${providerName}/${modelId} 家族匹配成功 (${catalogEntry._matchedFamily})，推测使用同家族参数: reasoning=${resolvedReasoning}, api=${safeApi}, ctx=${resolvedContextWindow}`);
    } else {
      console.log(`[catalog] 模型 ${providerName}/${modelId} 命中内置目录: reasoning=${resolvedReasoning}, api=${safeApi}, ctx=${resolvedContextWindow}`);
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

  // 未命中内置目录 — 使用安全默认值
  console.log(`[catalog] 模型 ${providerName}/${modelId} 未命中内置目录，使用安全默认值 (reasoning=false)`);
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
 * 测试模型是否真实可用
 * 向 provider 发起一个极简的 chat completion 请求验证模型是否存在
 * 使用 execFileSync + curl 数组参数，继承代理环境变量且避免 shell 注入
 * @param {string} provider - provider 名称
 * @param {string} modelId - 模型 ID
 * @param {string} apiKey - API Key
 * @param {string} baseUrl - API 基础 URL
 * @returns {Promise<{available: boolean, error?: string}>}
 */
async function testModelAvailability(provider, modelId, apiKey, baseUrl) {
  const startTime = Date.now();
  try {
    const endpoint = baseUrl || getDefaultBaseUrl(provider);
    if (!endpoint) {
      return { available: false, error: '未找到 API 端点' };
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

    // execFile 以数组传参，不经过 shell，杜绝命令注入
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
      console.log(`[model-test] ${provider}/${modelId} 测试成功 (${elapsed}ms)`);
      return { available: true };
    }

    console.log(`[model-test] ${provider}/${modelId} 测试失败: HTTP ${httpCode} (${elapsed}ms)`);
    return { available: false, error: `HTTP ${httpCode}: ${responseBody.slice(0, 200)}` };

  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.log(`[model-test] ${provider}/${modelId} 测试异常: ${e.message} (${elapsed}ms)`);
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
  if (/http 400|http 401|http 403|http 404|invalid api key|模型不可用|model_not_found|not found/.test(text)) return false;
  return /timeout|timed out|econn|socket|network|fetch failed|http 429|http 500|http 502|http 503|http 504|temporar|rate limit|unavailable/.test(text);
}

async function fetchRemoteProviderModels(provider, apiKey, baseUrl) {
  const endpoint = baseUrl || getDefaultBaseUrl(provider);
  if (!endpoint) return { ok: false, error: '未找到 API 端点', models: [] };
  if (provider === 'anthropic') return { ok: false, error: 'Anthropic 不支持 /models 端点', models: [] };

  const modelsUrl = provider === 'ollama' ? `${endpoint}/api/tags` : `${endpoint}/models`;
  const headers = {};
  let fetchUrl = modelsUrl;

  if (provider === 'gemini') {
    if (!apiKey) return { ok: false, error: 'Gemini 缺少 API Key', models: [] };
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
    return { ok: false, error: err?.message || '获取模型列表失败', models: [] };
  }
}

function formatRuntimeModelOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object') return '无额外参数';
  const parts = [];
  if (overrides.reasoning !== undefined) parts.push(`reasoning=${overrides.reasoning}`);
  if (overrides.api) parts.push(`api=${overrides.api}`);
  if (overrides.contextWindow) parts.push(`ctx=${overrides.contextWindow}`);
  if (overrides.maxTokens) parts.push(`max=${overrides.maxTokens}`);
  if (Array.isArray(overrides.input) && overrides.input.length > 0) parts.push(`input=${overrides.input.join(',')}`);
  return parts.length > 0 ? parts.join(', ') : '无额外参数';
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
      console.log(`[ensureModelEntry] 修正 provider ${provName}.api: ${targetProviders[provName].api} → ${desiredProvApi}`);
      targetProviders[provName].api = desiredProvApi;
    }
  }
}

async function finalizeInferredModelValidation(job, state = {}) {
  const configPath = '/root/.openclaw/openclaw.json';
  const modelsPath = '/root/.openclaw/agents/main/agent/models.json';
  let config = readJson(configPath, {});
  if (!collectConfiguredModelStrings(config).has(job.model)) {
    console.log(`[ai/config] ${job.model} 已不在当前配置中，跳过后台验证结果回写`);
    return { status: 'done' };
  }

  const creds = getModelValidationCredentials(job.providerName);
  if (!creds.apiKey || creds.apiKey === 'YOUR_API_KEY') {
    console.log(`[ai/config] ${job.model} 后台验证跳过：${job.providerName} 没有配置有效的 API Key`);
    return { status: 'done' };
  }

  console.log(`[ai/config] ${job.model} 家族匹配成功 (${job.matchedFamily})，开始第 ${state.attempts || 1} 次后台运行时验证...`);
  const remoteModelsResult = await fetchRemoteProviderModels(job.providerName, creds.apiKey, creds.baseUrl);
  const remoteModel = remoteModelsResult.models.find((item) => item.id.toLowerCase() === String(job.modelId || '').toLowerCase()) || null;
  if (remoteModel?.overrides && Object.keys(remoteModel.overrides).length > 0) {
    console.log(`[ai/config] ${job.model} 后台元数据命中，获取到真实参数: ${formatRuntimeModelOverrides(remoteModel.overrides)}`);
  } else if (remoteModelsResult.ok) {
    console.log(`[ai/config] ${job.model} 后台元数据已查询，但 provider 未返回更精确的参数，保留当前推测值`);
  } else if (remoteModelsResult.error) {
    console.log(`[ai/config] ${job.model} 后台元数据查询失败: ${remoteModelsResult.error}`);
  }

  const testResult = await testModelAvailability(job.providerName, job.modelId, creds.apiKey, creds.baseUrl);
  if (!testResult.available) {
    const errorText = testResult.error || '模型不可用';
    const attemptCount = Number(state.attempts || 1);
    const queuedAt = Number(state.queuedAt || Date.now());
    const canRetry = attemptCount < INFERRED_MODEL_VALIDATION_MAX_ATTEMPTS
      && (Date.now() - queuedAt) < INFERRED_MODEL_VALIDATION_TOTAL_TIMEOUT_MS
      && shouldRetryInferredModelValidation(errorText);
    if (canRetry) {
      console.log(`[ai/config] ${job.model} 后台运行时验证失败，将重试: ${errorText}`);
      return { status: 'retry', delayMs: INFERRED_MODEL_VALIDATION_RETRY_DELAY_MS };
    }
    console.log(`[ai/config] ${job.model} 后台运行时验证失败，保留当前配置: ${errorText}`);
    return { status: 'done' };
  }

  config = readJson(configPath, {});
  if (!collectConfiguredModelStrings(config).has(job.model)) {
    console.log(`[ai/config] ${job.model} 在后台验证完成前已被移除，跳过结果回写`);
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

  if (opState.type === 'idle') {
    queueGatewayRestart('ai-config-async-model-validation');
    console.log(`[ai/config] ${job.model} 后台运行时验证成功，已更新配置并提交 Gateway 重载请求`);
  } else if (opState.type === 'restarting_gateway') {
    queueGatewayRestartWhenIdle('ai-config-async-model-validation-post-restart');
    console.log(`[ai/config] ${job.model} 后台运行时验证成功，配置已更新；当前 Gateway 正在重载，已登记重载完成后的补充重启`);
  } else {
    queueGatewayRestartWhenIdle('ai-config-async-model-validation-after-busy');
    console.log(`[ai/config] ${job.model} 后台运行时验证成功，配置已更新；当前操作 ${opState.type} 进行中，已登记稍后重载`);
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
        console.log(`[ai/config] ${job.model} 后台验证超过总超时 ${Math.floor(INFERRED_MODEL_VALIDATION_TOTAL_TIMEOUT_MS / 1000)}s，停止重试`);
        pendingInferredModelValidationJobs.delete(key);
        return;
      }

      const opState = getOpenClawOperationState();
      if (opState.type === 'installing' || opState.type === 'updating' || opState.type === 'uninstalling' || opState.type === 'repairing_config') {
        console.log(`[ai/config] ${job.model} 后台验证遇到操作 ${opState.type}，${Math.floor(INFERRED_MODEL_VALIDATION_BUSY_DELAY_MS / 1000)}s 后重试`);
        schedule(INFERRED_MODEL_VALIDATION_BUSY_DELAY_MS);
        return;
      }

      if (state.attempts > INFERRED_MODEL_VALIDATION_MAX_ATTEMPTS) {
        console.log(`[ai/config] ${job.model} 后台验证超过最大重试次数 ${INFERRED_MODEL_VALIDATION_MAX_ATTEMPTS}，停止重试`);
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
          console.error(`[ai/config] ${job.model} 后台运行时验证异常，将重试:`, err?.message || err);
          schedule(INFERRED_MODEL_VALIDATION_RETRY_DELAY_MS);
          return;
        }
        console.error(`[ai/config] ${job.model} 后台运行时验证异常:`, err?.message || err);
      } finally {
        if (!state.timer) pendingInferredModelValidationJobs.delete(key);
      }
    }, Math.max(0, Number(delayMs || 0)));

    pendingInferredModelValidationJobs.set(key, state);
  };

  schedule(0);
}

/**
 * 获取 OpenClaw 支持的内置 provider 列表
 */
function getOpenClawBuiltinProviders() {
  if (!_openclawModelCatalog) return [];
  return Object.keys(_openclawModelCatalog);
}

/**
 * 获取指定 provider 的所有内置模型列表
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

// 启动时确保 models.json 和 openclaw.json 中的 models 数组包含已配置的模型
// 使用 OpenClaw 内置模型目录自动探测能力
function syncConfiguredModelsToModelsJson() {
  try {
    const modelsPath = '/root/.openclaw/agents/main/agent/models.json';
    const configPath = '/root/.openclaw/openclaw.json';
    if (!fs.existsSync(configPath)) return;
    const config = readJson(configPath, {});
    const defaults = config?.agents?.defaults || {};
    // 收集所有已配置的模型 (provider/modelId)
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
    if (configuredModels.length === 0) return;
    // 同步到 openclaw.json（gateway 启动时读取此文件生成 models.json）
    let configChanged = false;
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    for (const modelStr of configuredModels) {
      const [provName, modelId] = modelStr.split('/');
      const prov = config.models.providers[provName];
      if (!prov) continue;
      if (!prov.models) prov.models = [];
      const existingIdx = prov.models.findIndex(m => m.id === modelId);
      const entry = buildModelEntry(provName, modelId);
      if (existingIdx === -1) {
        prov.models.push(entry);
        configChanged = true;
        console.log(`[sync] 已将模型 ${modelStr} 添加到 openclaw.json`);
      } else {
        // 已存在时，用目录能力更新关键字段（保留用户自定义值）
        const existing = prov.models[existingIdx];
        const fieldsToSync = ['name', 'api', 'headers', 'reasoning', 'contextWindow', 'maxTokens', 'input', 'compat', 'cost'];
        for (const field of fieldsToSync) {
          if (entry[field] !== undefined && JSON.stringify(existing[field]) !== JSON.stringify(entry[field])) {
            console.log(`[sync] 更新 ${modelStr}.${field}: ${JSON.stringify(existing[field])} → ${JSON.stringify(entry[field])}`);
            existing[field] = entry[field];
            configChanged = true;
          }
        }
      }
      // provider 级 api 仅在当前值缺失或非法时修正，不按单个模型的 api 翻转。
      const syncedProviderApi = normalizeProviderApiForSync(prov.api, provName, entry.api);
      if (syncedProviderApi && prov.api && syncedProviderApi !== prov.api) {
        console.log(`[sync] 修正 provider ${provName}.api: ${prov.api} → ${syncedProviderApi} (来自模型目录)`);
        prov.api = syncedProviderApi;
        configChanged = true;
      }
    }
    // 最终一致性检查：确保所有 provider 下模型的 api 与 catalog 一致
    for (const [provName, prov] of Object.entries(config.models.providers)) {
      if (!prov.models || !Array.isArray(prov.models)) continue;
      for (const m of prov.models) {
        const mCap = lookupModelCapabilities(provName, m.id);
        const correctApi = sanitizeApiValue(mCap?.api, provName);
        if (correctApi && m.api !== correctApi) {
          console.log(`[sync] 修正 ${provName}/${m.id}.api: ${m.api} → ${correctApi}`);
          m.api = correctApi;
          configChanged = true;
        }
      }
    }
    if (configChanged) {
      writeJson(configPath, config);
      console.log('[sync] openclaw.json 已更新');
    }
    // 同步到 models.json（如果文件存在）
    if (fs.existsSync(modelsPath)) {
      const models = readJson(modelsPath, { providers: {} });
      if (models?.providers) {
        let modelsChanged = false;
        for (const modelStr of configuredModels) {
          const [provName, modelId] = modelStr.split('/');
          const prov = models.providers[provName];
          if (!prov) continue;
          if (!prov.models) prov.models = [];
          const existingIdx = prov.models.findIndex(m => m.id === modelId);
          const entry = buildModelEntry(provName, modelId);
          if (existingIdx === -1) {
            prov.models.push(entry);
            modelsChanged = true;
            console.log(`[sync] 已将模型 ${modelStr} 添加到 models.json`);
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
          // provider 级 api 仅在当前值缺失或非法时修正。
          const syncedProviderApi = normalizeProviderApiForSync(prov.api, provName, entry.api);
          if (syncedProviderApi && prov.api && syncedProviderApi !== prov.api) {
            prov.api = syncedProviderApi;
            modelsChanged = true;
          }
        }
        // 最终一致性检查
        for (const [provName2, prov2] of Object.entries(models.providers)) {
          if (!prov2.models || !Array.isArray(prov2.models)) continue;
          for (const m of prov2.models) {
            const mCap = lookupModelCapabilities(provName2, m.id);
            const correctApi = sanitizeApiValue(mCap?.api, provName2);
            if (correctApi && m.api !== correctApi) {
              m.api = correctApi;
              modelsChanged = true;
            }
          }
        }
        if (modelsChanged) {
          writeJson(modelsPath, models);
          console.log('[sync] models.json 已更新');
        }
      }
    }
  } catch (e) {
    console.warn('[sync] models.json 同步失败:', e.message);
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
  if (!Number.isFinite(ts) || ts <= 0) return '未知时间';
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
      out.push(`[watchdog] [${formatLogTime(lastTs)}] [fold] ${foldType} 连续 ${count} 条已折叠`);
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
        || normalized.match(/安装进行中[.…]*\s*(\d+)s/);
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
      if (/\b(exit=\d+|signal=|timeout|超时|failed|失败|not found|EADDRINUSE|ECONN|ETIMEDOUT|EAI_AGAIN)\b/i.test(t)) return true;
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
    /^\[openclaw\]\s+安装脚本开始执行/i,
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
        out.push(`[state] 安装进行中... ${elapsed}s${taskSuffix} (${count} 条进度已折叠)`);
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
  // 从最新开始向前扫描，找到最近的 Discord 连接错误
  let lastDiscordError = '';
  let lastDiscordErrorTs = 0;
  let lastDiscordOk = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || '');
    if (!line) continue;
    // Discord 成功连接标志
    if (/\[discord\]\s+(connected|ready|logged in|Logged in as)/i.test(line)) {
      lastDiscordOk = parseBracketTimestamp(line) || Date.now();
      break;
    }
    // Discord TLS / fetch 错误
    if (!lastDiscordError && /\[discord\]\s+(gateway\s+error|final reply failed|fetch failed)/i.test(line)) {
      lastDiscordErrorTs = parseBracketTimestamp(line) || 0;
      if (/Client network socket disconnected.*TLS/i.test(line) || /fetch failed/i.test(line)) {
        lastDiscordError = 'TLS连接失败（网络被阻断，建议配置 HTTPS_PROXY 代理）';
      } else {
        lastDiscordError = 'Discord 网关连接失败';
      }
    }
  }
  if (!lastDiscordError) return '';
  // 如果最后一次成功连接比错误更新，则忽略
  if (lastDiscordOk > lastDiscordErrorTs) return '';
  // 错误超过 10 分钟不再显示
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
      note: '当前为域名 + 可信 HTTPS，命令已省略 NODE_TLS_REJECT_UNAUTHORIZED=0。'
    };
  }

  if ((rawDomain && isIpHost) || certMode === 'internal') {
    return {
      disableVerify: true,
      note: '当前为 IP/自签 HTTPS，命令保留 NODE_TLS_REJECT_UNAUTHORIZED=0。'
    };
  }

  return {
    disableVerify: true,
    note: '无法可靠判断当前证书是否受信任，命令保守保留 NODE_TLS_REJECT_UNAUTHORIZED=0。'
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
  // 清除容器构建时遗留的旧版本环境变量，让 watchdog 从 package.json 重新检测
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
      resolve({ ok: false, code: 1, output: 'script 命令不可用，无法执行需要 TTY 的登录/令牌写入流程' });
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
    console.warn(`[openclaw][release] GitHub release 查询失败，回退 npm 元数据生成 release: ${safeRepo}@${tag} (${err?.message || 'unknown'})`);
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
    throw new Error('无法从 npm 获取 OpenClaw 已发布版本');
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
      `检测到运行入口缺失(${openClawRuntimeRecoveryState.lastIssue})，自动执行 npm 安装恢复（${release.tag})`,
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
      latestOpenClawVersionCache.error = '无法连接版本源';
      if (!latestOpenClawVersionCache.updatedAt) latestOpenClawVersionCache.updatedAt = Date.now();
    }
  } catch (e) {
    latestOpenClawVersionCache.error = e?.message || String(e || '版本检查失败');
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
    // 对 HTML 响应注入 __OPENCLAW_CONTROL_UI_BASE_PATH__，确保 SPA 的 WebSocket 走 /gateway-proxy 代理
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
    // Clear lockout if admin password was changed after lockout started
    const changedAt = dockerConfig.webAuth?.users?.admin?.passwordChangedAt;
    if (changedAt && new Date(changedAt).getTime() > (st.lockUntil - LOCK_MS)) {
      recordLoginSuccess(ip);
    } else {
      const remainSec = Math.ceil((st.lockUntil - Date.now()) / 1000);
      return res.status(429).json({
        error: `登录失败过多，已锁定。请 ${remainSec}s 后重试`,
        locked: true,
        resetHint: '如需重置密码，请通过 SSH 或 docker exec 登录容器后执行命令：openclaw-reset-password'
      });
    }
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

async function getRemoteDockerfileHashesByRef(ref, timeout = 6000) {
  const candidates = ['Dockerfile.lite'];
  const results = await Promise.all(candidates.map(async (fileName) => {
    try {
      const dfResp = await fetchWithFallback(`${GITHUB_RAW_BASE}/${ref}/${fileName}`, {
        headers: { 'User-Agent': 'openclaw-pro' },
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
let _dockerfileChangeLogged = false;   // 只打印一次 Dockerfile 变更日志

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

    // --- 方式2: raw.githubusercontent.com 读 version.txt (API 不可达时的后备) ---
    if (!latestVersion) {
      try {
        const rawResp = await fetchWithFallback(`${GITHUB_RAW_BASE}/main/version.txt`, {
          headers: { 'User-Agent': 'openclaw-pro' },
          timeout: 6000
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

    // 当部署版本比 GitHub release 更新（pre-release / 未发布 release）时，
    // 将 latestVersion 修正为 currentVersion，避免面板显示过时的 release 版本号
    let displayLatestVersion = latestVersion;
    if (!hasUpdate && currentNorm && latestNorm && currentNorm !== 'unknown' && currentNorm !== 'dev') {
      const cmp = compareSemver(currentNorm, latestNorm);
      if (cmp > 0) {
        // 当前版本高于 GitHub release → 显示当前版本作为最新
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

    // hasUpdate 仅由 release 版本变化触发；不会因为 Dockerfile 变化单独触发更新提示。

    updateCache = { data: { latestVersion: displayLatestVersion, hasUpdate: result.hasUpdate, publishedAt, releaseUrl, releaseName, requiresFullUpdate: result.requiresFullUpdate, dockerfileChanged: result.dockerfileChanged }, checkedAt: Date.now() };
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
const WEB_PANEL_BACKUP_DIR = '/root/.openclaw/web-panel-backup';

/**
 * 热更新前备份当前文件，供 watchdog 回退使用
 */
function backupCurrentHotpatchFiles() {
  try {
    fs.mkdirSync(WEB_PANEL_BACKUP_DIR, { recursive: true });
    const meta = { version: getCurrentVersion(), timestamp: Date.now(), files: {} };
    for (const [, localPath] of HOTPATCH_FILES) {
      try {
        if (fs.existsSync(localPath)) {
          const basename = path.basename(localPath);
          fs.copyFileSync(localPath, path.join(WEB_PANEL_BACKUP_DIR, basename));
          meta.files[basename] = localPath;
        }
      } catch {}
    }
    // 同时备份版本号
    try {
      const ver = fs.readFileSync(VERSION_FILE, 'utf8').trim();
      if (ver) meta.backupVersion = ver;
    } catch {}
    fs.writeFileSync(path.join(WEB_PANEL_BACKUP_DIR, '.backup-meta'), JSON.stringify(meta, null, 2));
    return true;
  } catch (e) {
    console.error('[hotpatch] 备份当前文件失败:', e.message);
    return false;
  }
}

/**
 * 从备份恢复指定文件
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
    return res.status(409).json({ error: '热更新正在进行中' });
  }

  const branch = (req.body && req.body.branch) || 'main';
  const force = (req.body && req.body.force) || false;
  hotpatchState = { status: 'running', log: '', startedAt: Date.now(), updated: [], failed: [], force };
  res.json({ success: true, message: force ? '强制热更新已开始' : '热更新已开始' });

  const log = (msg) => { hotpatchState.log += msg + '\n'; console.log('[hotpatch] ' + msg); };

  try {
    // 在更新任何文件前，备份当前版本供回退使用
    if (backupCurrentHotpatchFiles()) {
      log('已备份当前文件到 web-panel-backup/');
    } else {
      log('⚠ 备份当前文件失败，继续更新（回退功能不可用）');
    }

    log(`${force ? '强制' : ''}从 GitHub (${branch}) 拉取最新文件...`);
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

        // Compare with existing file (skip comparison if force mode)
        if (!force) {
          let existingContent = '';
          try { existingContent = fs.readFileSync(localPath, 'utf8'); } catch {}

          if (content === existingContent) {
            log(`  ✓ ${ghPath}: 无变化`);
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

    // server.js 语法预检：写入后立即验证，失败则立即回退
    if (hotpatchState.updated.includes('web/server.js')) {
      try {
        execSync('node -c /opt/openclaw-web/server.js', { timeout: 15000, stdio: 'pipe' });
        log('  ✓ server.js 语法检查通过');
      } catch (syntaxErr) {
        const stderr = (syntaxErr.stderr || '').toString().trim();
        log(`  ❌ server.js 语法错误! ${stderr}`);
        log('  ↩ 正在从备份恢复 server.js...');
        if (restoreHotpatchFile('server.js')) {
          log('  ✅ server.js 已从备份恢复，跳过本次 server.js 更新');
          hotpatchState.updated = hotpatchState.updated.filter(f => f !== 'web/server.js');
          needWebRestart = false;
        } else {
          log('  ⚠ 无法从备份恢复 server.js，面板可能无法启动');
        }
        hotpatchState.failed.push('web/server.js (语法错误，已回退)');
      }
    }

    // Update version file ONLY if ALL files were successfully updated (no failures)
    if (hotpatchState.failed.length > 0) {
      log(`⚠️ 版本号未更新: ${hotpatchState.failed.length} 个文件更新失败，请检查网络或 GitHub 访问`);
      hotpatchState.status = 'error';
      return;
    } else {
      // 无失败：更新版本号（即使文件无变化，也同步最新版本标签）
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
        } else if (hotpatchState.updated.length === 0) {
          log(`所有文件已是最新，无需变更`);
        }
      } catch {}
    }

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
// 消息平台敏感字段列表
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

    // 读取 openclaw.json (原生读取避免超时)
    let config = {};
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch {
      config = {};
    }

    // 只返回 channels 字段（掩码敏感信息）
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

    // 读取现有 openclaw.json
    let config = {};
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch {
      config = {};
    }

    const updates = req.body || {};

    const savedChannels = [];

    // 合并 channels 配置到 openclaw.json（明文存储，openclaw 直接读取）
    if (updates.channels) {
      if (!config.channels) config.channels = {};
      savedChannels.push(...Object.keys(updates.channels));
      // 在合并前，剥离掩码值（防止 *** 覆盖真实密钥）
      stripMaskedValues(updates.channels);
      // 兼容历史错误字段并对齐 OpenClaw 当前 schema
      normalizeDiscordChannelConfig(updates.channels);
      normalizeDiscordChannelConfig(config.channels);
      normalizeFeishuChannelConfig(updates.channels);
      normalizeFeishuChannelConfig(config.channels);

      // 多服务器模式：当前端显式要求替换 guilds 时，先清空旧值再合并
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

    // 写回 openclaw.json（自动清理非法 key）
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

// 递归删除值匹配掩码模式 (***) 的字段，防止掩码值覆盖真实密钥
function stripMaskedValues(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    // UI 掩码值（*** 或 •••）不应覆盖真实密钥
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

// 兼容旧版/错误字段，统一到 OpenClaw 当前 schema
const VALID_DISCORD_STREAMING = new Set(['true', 'false', 'off', 'partial', 'block', 'progress']);

function normalizeDiscordChannelConfig(channelsObj) {
  if (!channelsObj || typeof channelsObj !== 'object') return;
  const discord = channelsObj.discord;
  if (!discord || typeof discord !== 'object') return;

  // streaming 值校验：'full' 是无效值，映射为 'progress'
  if (discord.streaming !== undefined) {
    const sv = String(discord.streaming).toLowerCase().trim();
    if (!VALID_DISCORD_STREAMING.has(sv)) {
      discord.streaming = sv === 'full' ? 'progress' : 'partial';
    } else {
      discord.streaming = sv;
    }
  }

  // 旧字段 guildId 不在官方 schema 中，迁移到 guilds
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

  // 账户级同样清理错误字段
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

// 飞书通道规范化：accounts.main → accounts.default，dmPolicy=open → allowFrom
function normalizeFeishuChannelConfig(channelsObj) {
  if (!channelsObj || typeof channelsObj !== 'object') return;
  const feishu = channelsObj.feishu;
  if (!feishu || typeof feishu !== 'object') return;

  if (feishu.accounts && typeof feishu.accounts === 'object') {
    // 如果只有 main 没有 default，把 main 重命名为 default
    if (feishu.accounts.main && !feishu.accounts.default) {
      feishu.accounts.default = feishu.accounts.main;
      delete feishu.accounts.main;
    }
    // 对每个账户：dmPolicy=open 时自动补 allowFrom: ["*"]；清理空字符串可选字段
    for (const acct of Object.values(feishu.accounts)) {
      if (!acct || typeof acct !== 'object') continue;
      if (acct.dmPolicy === 'open' && !acct.allowFrom) {
        acct.allowFrom = ['*'];
      }
      // 移除空字符串的可选字段（避免 Gateway schema 报错）
      for (const opt of ['verificationToken', 'encryptKey']) {
        if (acct[opt] === '') delete acct[opt];
      }
    }
  }
}

// ============================================================
// API: 远端设备管理 (Node 模式)
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
            finishReject(new Error(msg.error?.message || msg.error?.code || 'gateway connect rejected'));
            return;
          }
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
          ws.on('message', (innerData) => {
            try {
              const innerMsg = JSON.parse(String(innerData));
              const pending = handlers.get(innerMsg.id);
              if (!pending) return;
              handlers.delete(innerMsg.id);
              clearTimeout(pending.reqTimer);
              if (innerMsg.ok) pending.resolveReq(innerMsg.payload);
              else pending.rejectReq(new Error(innerMsg.error?.message || innerMsg.error?.code || `${innerMsg.id} failed`));
            } catch {}
          });
          resolve({ request, close });
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

// GET /api/node/setup-command — 生成一键连接命令
app.get('/api/node/setup-command', (req, res) => {
  try {
    const token = getGatewayAuthToken();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').replace(/:\d+$/, '') || '127.0.0.1';
    const dcfg = readDockerConfig();
    const tlsMode = getNodeTlsCommandMode(dcfg);
    const gatewayTlsPort = Number(dcfg.gateway_tls_public_port || dcfg.gateway_tls_port || 18790) || 18790;
    if (!token) {
      return res.json({ success: true, command: '# Gateway Auth Token 未配置，请先在 openclaw.json 中设置 gateway.auth.token', hasToken: false, commandWindows: '' });
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
      `echo "✅ Node 已在后台启动（多网关隔离模式），日志: ${nodeLogPathDisplay}"`,
      `echo "🛑 停止当前网关: ${nodeStopCmd}"`
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
      'if (-not $taskOk) { Write-Host "⚠️ 计划任务注册失败，后台进程仍会运行，但重启后需手动执行" }',
      // Start the runner now
      `Start-Process -FilePath powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$runnerFile | Out-Null`,
      `Write-Host "✅ Node 已在后台启动（多网关隔离模式），日志: ${nodeLogPathWindowsDisplay}"`,
      `Write-Host "⚠️ 错误日志: ${nodeDirWindowsDisplay}\\node-host.stderr.log"`,
      'if ($taskOk) { Write-Host "📌 已注册计划任务 \'$taskName\'，登录时自动启动" }',
      `Write-Host "🛑 停止当前网关: ${nodeStopCmdWindows}"`
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

// GET /api/node/security — 获取安全配置
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

// POST /api/node/security — 保存安全配置
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

// POST /api/node/unpair — 取消配对
app.post('/api/node/unpair', async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ success: false, error: '缺少 deviceId' });
    if (!/^[0-9a-fA-F-]{8,64}$/.test(deviceId)) return res.status(400).json({ success: false, error: 'deviceId 格式无效' });

    const paired = readJson(DEVICE_PAIRING_PAIRED_PATH, {});
    if (!paired[deviceId]) return res.status(404).json({ success: false, error: '未找到该设备' });

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

// --- Gateway WebSocket 查询节点在线状态 ---
// 优先以真实 device identity 的 control-ui 身份连接并调用 node.list
// 失败时降级为 cli 身份连接，通过 presence 快照检测节点在线
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

function queryGatewayNodeList(timeoutMs = 5000) {
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
        // 1) connect.challenge → 尝试带 device identity 的 control-ui 连接
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
        // 2) connect 响应
        if (msg.id === connectId) {
          if (msg.ok) {
            // control-ui 连接成功 → 调用 node.list
            listId = crypto.randomUUID();
            ws.send(JSON.stringify({ type: 'req', id: listId, method: 'node.list', params: {} }));
          } else {
            // control-ui 被拒绝（如 device identity required）→ 降级为 cli fallback
            logNodeProbeDebug('[node] control-ui rejected:', msg.error?.code || 'unknown', '→ cli fallback');
            usedFallback = true;
            try { ws.close(); } catch {}
            queryGatewayNodeListFallback(gatewayPort, token, timeoutMs - 1000).then(v => { clearTimeout(timer); finish(v); });
          }
          return;
        }
        // 3) node.list 响应
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

// 降级方案：cli 身份连接，从 presence 快照推断节点在线（无需 scopes）
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
          // 从 presence 快照中提取 mode=node, reason=connect 条目
          const presence = msg.payload?.snapshot?.presence || [];
          const nodePresence = presence.filter(p => p.mode === 'node' && p.reason === 'connect');
          logNodeProbeDebug('[node] cli fallback presence:', presence.length, 'total,', nodePresence.length, 'nodes');
          // 转换为 node.list 兼容格式（presence 中只有 host/mode/platform，无 nodeId）
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

// GET /api/node/connected — 获取当前已连接的远端设备列表
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
  if (!model) return res.status(400).json({ error: '模型不能为空' });
  if (!/^[a-zA-Z0-9._/:\-]+$/.test(model)) return res.status(400).json({ error: '模型格式不合法' });

  const result = await runOpenClawCli(`openclaw models set "${model.replace(/"/g, '')}" 2>&1`, 60000);
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

// 通用 OAuth 登录入口（直接实现 GitHub Device Flow，不依赖 CLI TTY）
app.post('/api/ai/auth/oauth/login', async (req, res) => {
  const provider = String(req.body?.provider || '').trim();
  if (!provider || !/^[a-zA-Z0-9\-]+$/.test(provider)) {
    return res.status(400).json({ error: 'provider 不合法' });
  }

  if (provider === 'github-copilot') {
    // 直接实现 GitHub Device Flow
    const taskId = Date.now().toString();
    aiAuthTasks[taskId] = { status: 'running', log: '', startedAt: Date.now(), seq: 0, chunks: [] };
    const task = aiAuthTasks[taskId];
    appendAiTaskLog(task, `[ai] GitHub Copilot 设备授权\n`);

    // 异步执行 device flow
    (async () => {
      try {
        const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
        const DEVICE_CODE_URL = 'https://github.com/login/device/code';
        const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

        // Step 1: 请求 device code
        appendAiTaskLog(task, '[ai] 正在请求 GitHub 设备码...\n');
        const dcRes = await fetch(DEVICE_CODE_URL, {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
          signal: AbortSignal.timeout(30000)
        });
        if (!dcRes.ok) throw new Error(`GitHub device code 请求失败: HTTP ${dcRes.status}`);
        const dcData = await dcRes.json();
        if (!dcData.device_code || !dcData.user_code || !dcData.verification_uri) {
          throw new Error('GitHub device code 响应缺少必要字段');
        }

        appendAiTaskLog(task, `\n请在浏览器中打开: ${dcData.verification_uri}\n`);
        appendAiTaskLog(task, `输入授权码: ${dcData.user_code}\n\n`);
        appendAiTaskLog(task, `[ai] 等待用户完成 GitHub 授权...\n`);

        // Step 2: 轮询等待授权
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
              throw new Error('设备码已过期，请重新启动授权');
            }
            if (tokenData.error === 'access_denied') {
              throw new Error('用户取消了授权');
            }
            if (tokenData.error) {
              throw new Error(`GitHub OAuth 错误: ${tokenData.error}`);
            }
          } catch (pollErr) {
            if (pollErr.message?.includes('设备码已过期') || pollErr.message?.includes('取消')) throw pollErr;
            appendAiTaskLog(task, `[ai] 轮询出错: ${pollErr.message}, 继续等待...\n`);
          }
        }

        if (!accessToken) throw new Error('授权超时，设备码已过期');

        appendAiTaskLog(task, '[ai] GitHub 访问令牌获取成功!\n');

        // Step 3: 保存到 auth-profiles.json（兼容 openclaw 格式）
        const authProfiles = readAiAuthProfiles();
        saveCanonicalCopilotAuthProfile(authProfiles, accessToken);
        writeAiAuthProfiles(authProfiles);
        appendAiTaskLog(task, '[ai] 认证信息已保存到 auth-profiles.json\n');

        // Step 4: 确保 models.json 中有 github-copilot provider 条目
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
        appendAiTaskLog(task, '[ai] 已更新 models.json 中的 github-copilot 配置\n');

        // Step 5: 同步 openclaw.json 中的 models.providers（确保 gateway 能识别）
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
        // 注: openclaw.json 中不写 apiKey（token 式授权由 gateway 自行交换）
        writeOpenClawConfig(ocConfig);
        appendAiTaskLog(task, '[ai] 已同步 openclaw.json 中的 github-copilot provider\n');

        task.status = 'success';
        task.exitCode = 0;
        appendAiTaskLog(task, '[ai] GitHub Copilot 授权完成 ✓\n');
      } catch (err) {
        appendAiTaskLog(task, `[ai] 授权失败: ${err.message}\n`);
        task.status = 'failed';
        task.exitCode = 1;
      }
      // 清理旧任务
      const keys = Object.keys(aiAuthTasks).sort();
      while (keys.length > 8) delete aiAuthTasks[keys.shift()];
    })();

    return res.json({ success: true, taskId });
  }

  // 非 copilot 的其他 OAuth provider 仍使用 CLI
  const command = `openclaw models auth login --provider ${provider}`;
  const taskId = runAiAuthTask(command, `${provider} OAuth 登录`);
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

// 读取 AI 配置
app.get('/api/ai/config', async (req, res) => {
  try {
    const configPath = '/root/.openclaw/openclaw.json';
    // 读取主配置
    let config = {};
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch {
      config = {};
    }

    // 读取 models.json 获取提供商列表
    const models = readAiModels();

    // 读取 auth-profiles.json
    const authProfiles = readAiAuthProfiles();

    const providers = new Set(Object.keys(models?.providers || {}));
    for (const [, profile] of Object.entries(authProfiles.profiles || {})) {
      if (profile?.provider) providers.add(profile.provider);
    }
    for (const [key, profile] of Object.entries(authProfiles || {})) {
      if (!AUTH_PROFILE_META_KEYS.has(key) && profile?.provider) providers.add(profile.provider);
    }

    // 构建 configuredKeys 数组（支持每个 provider 多个 key）
    const configuredKeys = [];
    const configuredKeySignatures = new Set();

    // 遍历 auth-profiles.profiles 找所有 key（支持多 key: provider, provider:2, provider:3 等）
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
        // 检查这个 key 是否是当前活跃的（与 models.json 中的 apiKey 匹配）
        const activeKey = prov?.apiKey || '';
        const isActive = isApiKey ? (rawKey === activeKey) : true;

        configuredKeys.push({
          id: profileId,
          provider: pName,
          keyMasked: isApiKey ? maskApiKey(rawKey) : (isOAuth ? 'OAuth 已授权' : ''),
          baseUrl: prov?.baseUrl || getDefaultBaseUrl(pName) || '',
          authType: isOAuth ? 'oauth' : 'apikey',
          models: (prov?.models || []).map(m => m.id || m),
          isActive
        });
        configuredKeySignatures.add(signature);
      }
    }

    // 同时检查旧格式顶级条目和 models.json 中有 key 但 profiles 中没有的 provider
    for (const pName of providers) {
      const prov = models.providers[pName];
      const rawKey = prov?.apiKey || '';
      const hasKey = !!rawKey && rawKey !== 'YOUR_API_KEY';

      // 检查是否已被 profiles 覆盖
      const alreadyHasProfile = configuredKeys.some(k => k.provider === pName);
      if (alreadyHasProfile) continue;

      // 检查旧格式 auth-profiles 顶级条目
      const topLevelProfile = authProfiles[pName];
      const isTopOAuth = topLevelProfile?.mode === 'oauth' || topLevelProfile?.mode === 'device' || topLevelProfile?.mode === 'token';
      const signature = buildConfiguredKeySignature(pName, isTopOAuth ? 'oauth' : 'apikey', getAuthProfileIdentity(topLevelProfile));

      if ((hasKey || isTopOAuth) && !configuredKeySignatures.has(signature)) {
        configuredKeys.push({
          id: pName,
          provider: pName,
          keyMasked: hasKey ? maskApiKey(rawKey) : (isTopOAuth ? 'OAuth 已授权' : ''),
          baseUrl: prov?.baseUrl || getDefaultBaseUrl(pName) || '',
          authType: isTopOAuth ? 'oauth' : 'apikey',
          models: (prov?.models || []).map(m => m.id || m),
          isActive: true
        });
        configuredKeySignatures.add(signature);
      }
    }

    // --- 自动清理孤立模型引用（provider 无有效 key 时清除对应模型配置） ---
    const validProviders = new Set(configuredKeys.map(k => k.provider));
    const isOrphan = (modelStr) => {
      if (!modelStr) return false;
      const p = String(modelStr).split('/')[0];
      return p && !validProviders.has(p);
    };

    let configDirty = false;
    const defaults = config?.agents?.defaults || {};

    // 清理 primary model
    if (defaults.model?.primary && isOrphan(defaults.model.primary)) {
      console.log(`[ai/config] Auto-clean orphaned primary model: ${defaults.model.primary}`);
      defaults.model.primary = '';
      configDirty = true;
    }

    // 清理 primary fallbacks
    if (Array.isArray(defaults.model?.fallbacks)) {
      const before = defaults.model.fallbacks.length;
      defaults.model.fallbacks = defaults.model.fallbacks.filter(m => !isOrphan(m));
      if (defaults.model.fallbacks.length < before) {
        console.log(`[ai/config] Auto-clean ${before - defaults.model.fallbacks.length} orphaned primary fallback(s)`);
        configDirty = true;
      }
    }

    // 清理非法的 subModel/subModelFallbacks 键（openclaw schema 不支持）
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

    // 清理 subagents.model（正确路径）
    const subagentModel = defaults.subagents?.model;
    if (subagentModel) {
      const subModelStr = typeof subagentModel === 'string' ? subagentModel : subagentModel?.primary;
      if (subModelStr && isOrphan(subModelStr)) {
        console.log(`[ai/config] Auto-clean orphaned subagent model: ${subModelStr}`);
        delete defaults.subagents.model;
        configDirty = true;
      }
    }

    // 写回清理后的配置（自动清理非法 key）
    if (configDirty) {
      try {
        writeOpenClawConfig(config);
        console.log('[ai/config] Wrote back cleaned config to openclaw.json');
      } catch (writeErr) {
        console.error('[ai/config] Failed to write cleaned config:', writeErr.message);
      }
    }

    // 解析默认模型（清理后的值）
    const primaryModel = defaults.model?.primary || '';
    const provider = primaryModel.split('/')[0] || (validProviders.size > 0 ? [...validProviders][0] : 'anthropic');

    // 解析 fallbacks（清理后的值）
    const modelFallbacks = defaults.model?.fallbacks || [];
    // 解析 subagents.model fallbacks
    const rawSubModel = defaults.subagents?.model;
    const subFallbacks = (rawSubModel && typeof rawSubModel === 'object' && Array.isArray(rawSubModel.fallbacks))
      ? rawSubModel.fallbacks : [];
    const fallbackObj = {
      primary: Array.isArray(modelFallbacks) ? modelFallbacks : [],
      sub: subFallbacks
    };

    // 解析 subagents.model（正确路径）
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
    res.status(500).json({ error: '读取配置失败: ' + (err?.message || '未知错误') });
  }
});

// 保存 AI 模型配置（仅模型相关，API Key 通过 /api/ai/keys 管理）
app.post('/api/ai/config', async (req, res) => {
  try {
    const { primaryModel, fallbacks, subModel } = req.body || {};

    if (!primaryModel) {
      return res.status(400).json({ error: '主模型不能为空' });
    }

    if (!primaryModel.includes('/')) {
      return res.status(400).json({ error: '模型名称格式应为 provider/model-id' });
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

    // ---- 验证: 检查每个模型的 provider 是否有有效的 API Key / 授权 ----
    const authProfilesPath = '/root/.openclaw/agents/main/agent/auth-profiles.json';
    let authProfiles = {};
    try { authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf8')); } catch { authProfiles = {}; }

    // 收集所有有有效 key 的 provider
    const validProviders = new Set();
    const profiles = authProfiles.profiles || {};
    for (const [, profile] of Object.entries(profiles)) {
      if (!profile?.provider) continue;
      const rawKey = getAuthProfileSecret(profile);
      const hasKey = !!rawKey && rawKey !== 'YOUR_API_KEY';
      const isOAuth = profile.mode === 'oauth' || profile.mode === 'device' || profile.mode === 'token' || profile.type === 'token';
      if (hasKey || isOAuth) validProviders.add(profile.provider);
    }
    // 同时检查 models.json 中直接配置了有效 key 的 provider
    for (const [pName, prov] of Object.entries(models.providers || {})) {
      const rawKey = prov?.apiKey || '';
      if (rawKey && rawKey !== 'YOUR_API_KEY') validProviders.add(pName);
      // 检查旧格式顶级 auth-profiles
      const topProfile = authProfiles[pName];
      if (topProfile?.mode === 'oauth' || topProfile?.mode === 'device' || topProfile?.mode === 'token') {
        validProviders.add(pName);
      }
    }

    // 收集当前已存在于配置中的模型（这些跳过验证）
    const existingModels = new Set();
    const curDefaults = config?.agents?.defaults || {};
    if (curDefaults.model?.primary) existingModels.add(curDefaults.model.primary);
    if (Array.isArray(curDefaults.model?.fallbacks)) curDefaults.model.fallbacks.forEach(m => m && existingModels.add(m));
    const curSub = curDefaults.subagents?.model;
    if (typeof curSub === 'string' && curSub) existingModels.add(curSub);
    if (curSub?.primary) existingModels.add(curSub.primary);
    if (Array.isArray(curSub?.fallbacks)) curSub.fallbacks.forEach(m => m && existingModels.add(m));

    // 收集本次要保存的所有模型
    const allModelsToSave = new Map();
    const addModelToSave = (model, role) => {
      if (!model) return;
      if (!allModelsToSave.has(model)) {
        allModelsToSave.set(model, { model, roles: new Set() });
      }
      allModelsToSave.get(model).roles.add(role);
    };
    if (primaryModel) addModelToSave(primaryModel, '主模型');
    if (subModel) addModelToSave(subModel, '子代理模型');
    if (fallbacks) {
      const addFb = (arr, label) => {
        if (!Array.isArray(arr)) return;
        arr.filter(Boolean).forEach(m => addModelToSave(m, label));
      };
      if (Array.isArray(fallbacks)) {
        addFb(fallbacks, '主代理 Fallback');
      } else if (typeof fallbacks === 'object') {
        addFb(fallbacks.primary, '主代理 Fallback');
        addFb(fallbacks.sub, '子代理 Fallback');
      }
    }

    // 验证每个模型
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
      // 已存在于当前配置中的模型跳过验证
      if (existingModels.has(model)) continue;
      const [prov] = model.split('/');
      // 检查 provider 是否有有效 key
      if (!validProviders.has(prov)) {
        errors.push(`${role} "${model}" 的 provider "${prov}" 没有配置有效的 API Key 或授权，请先添加`);
      }
      // 检查模型是否在目录中被支持
      const [provName, modId] = model.split('/');
      const catalogHit = getCachedCatalogHit(provName, modId);

      if (!catalogHit) {
        // 完全未找到 - 可能是全新模型或拼写错误
        errors.push(`${role} "${model}" 未在 OpenClaw 模型目录中找到，请确认模型名称是否正确`);
      } else if (catalogHit._catalogUnavailable) {
        // 模型目录未加载（外部 catalog 不可用）- 跳过严格验证，允许保存
        console.log(`[ai/config] ${model} 模型目录未加载，跳过目录验证`);
      } else if (catalogHit._inferred) {
        console.log(`[ai/config] ${model} 家族匹配成功 (${catalogHit._matchedFamily})，先保存配置，稍后进行后台运行时验证...`);
        const { apiKey: modelApiKey } = getModelValidationCredentials(provName, authProfiles);
        if (!modelApiKey || modelApiKey === 'YOUR_API_KEY') {
          errors.push(`${role} "${model}" 需要进行运行时验证，但 ${provName} 没有配置有效的 API Key`);
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
      // 精确匹配成功 (catalogHit && !catalogHit._inferred) - 无需额外验证
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('；') });
    }

    // ---- 更新 openclaw.json ----
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

    // subagents.model（正确路径：agents.defaults.subagents.model）
    if (subModel) {
      if (!config.agents.defaults.subagents) config.agents.defaults.subagents = {};
      // 支持 fallbacks：如果有子代理 fallback，写成 { primary, fallbacks } 对象
      const subFbArray = (fallbacks && Array.isArray(fallbacks.sub)) ? fallbacks.sub.filter(Boolean) : [];
      if (subFbArray.length > 0) {
        config.agents.defaults.subagents.model = { primary: subModel, fallbacks: subFbArray };
      } else {
        config.agents.defaults.subagents.model = subModel;
      }
    }
    // 清理非法的顶级 subModel/subModelFallbacks
    if (config.agents?.defaults?.subModel) delete config.agents.defaults.subModel;
    if (config.agents?.defaults?.subModelFallbacks) delete config.agents.defaults.subModelFallbacks;

    // 辅助：确保 provider 的 models 数组中包含指定 model 条目
    // 使用 OpenClaw 内置模型目录自动探测能力
    const ensureModelEntry = (target, provName, modId) => {
      const cacheKey = `${provName}/${modId}`;
      const deferred = deferredValidationModels.has(cacheKey);
      upsertProviderModelEntry(target, provName, modId, {
        deferInferredValidation: deferred,
        resolvedCatalogHit: getCachedCatalogHit(provName, modId),
        resolvedEntry: deferred ? buildSafePendingModelEntry(modId) : getCachedModelEntry(provName, modId)
      });
    };

    // 确保主模型的 provider 在 models.json 中存在
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

    // 同样处理 subModel
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

    // 同时写入 openclaw.json 的 models.providers（确保 gateway 重启后不丢失）
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    // 辅助：确保 config.models.providers 中存在指定 provider
    // 从 models.json 复制 provider 基本信息（不含 apiKey）
    const ensureConfigProvider = (provName) => {
      if (!config.models.providers[provName]) {
        ensureProviderShell(config.models.providers, models.providers, provName);
        console.log(`[ai/config] 在 openclaw.json 中创建 provider: ${provName}`);
      }
    };

    ensureConfigProvider(providerName);
    ensureModelEntry(config.models.providers, providerName, modelId);
    if (subModel && subModel.includes('/')) {
      const [subProv] = subModel.split('/');
      ensureConfigProvider(subProv);
      ensureModelEntry(config.models.providers, subProv, subModel.split('/')[1]);
    }
    // 处理 fallback 模型（写入 models.json 和 openclaw.json）
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

    // 写入文件（自动清理非法 key）
    writeOpenClawConfig(config);
    fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2), { encoding: 'utf8', mode: 0o600 });

    const opState = getOpenClawOperationState();
    let message = '模型配置已保存';
    let nextOperationState = opState;

    if (opState.type === 'idle') {
      nextOperationState = queueGatewayRestart('ai-config-save');
      message = '模型配置已保存，已提交 Gateway 重载请求';
      console.log('[ai/config] 模型配置已保存，已提交 Gateway 重载请求');
    } else if (opState.type === 'restarting_gateway') {
      message = '模型配置已保存，Gateway 重载已在进行中';
      console.log('[ai/config] 模型配置已保存，Gateway 重载已在进行中');
    } else {
      message = `模型配置已保存，当前存在进行中的操作（${opState.type}），请在操作完成后重载 Gateway 以应用配置`;
      console.log(`[ai/config] 模型配置已保存，但当前操作 ${opState.type} 正在进行，暂不额外触发 Gateway 重载`);
    }

    if (deferredValidationJobs.length > 0) {
      message += `；${deferredValidationJobs.length} 个家族匹配模型正在后台验证`;
      for (const job of deferredValidationJobs) {
        queueInferredModelValidation(job);
      }
    }

    res.json({ success: true, message, operationState: nextOperationState });
  } catch (err) {
    console.error('[ai/config] Error saving config:', err);
    res.status(500).json({ error: '保存配置失败: ' + (err?.message || '未知错误') });
  }
});

// 验证 API Key 有效性
app.post('/api/ai/keys/validate', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'provider 不能为空' });
    if (!apiKey) return res.status(400).json({ error: 'API Key 不能为空' });

    const endpoint = baseUrl || getDefaultBaseUrl(provider);
    if (!endpoint) return res.json({ valid: false, error: '无法确定 API 端点' });

    // 尝试调用 /models 端点来验证 key 可用性
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

    // 某些 provider 返回 401/403 表示 key 无效
    const status = response.status;
    let errMsg = `HTTP ${status}`;
    try {
      const body = await response.json();
      errMsg = body.error?.message || body.message || body.error || errMsg;
    } catch {}

    if (status === 401 || status === 403) {
      return res.json({ valid: false, error: `API Key 无效: ${errMsg}` });
    }

    // 其他状态码（如 429 rate limit）认为 key 本身有效
    if (status === 429 || status === 200 || status === 201) {
      return res.json({ valid: true });
    }

    // 404 表示该 provider 可能没有 /models 端点，不代表 key 无效
    if (status === 404) {
      return res.json({ valid: true, warning: `${provider} 不支持 /models 端点验证，已跳过` });
    }

    return res.json({ valid: false, error: errMsg });
  } catch (err) {
    console.error('[ai/keys/validate] Error:', err);
    // 网络超时等错误 — 不确定 key 是否有效，允许继续
    return res.json({ valid: true, warning: '无法连接到 API 验证: ' + (err?.message || '未知错误') });
  }
});

// ============ OpenClaw 内置模型目录查询 API ============

// 获取内置 provider 列表
app.get('/api/ai/catalog/providers', (req, res) => {
  const providers = getOpenClawBuiltinProviders();
  res.json({ providers });
});

// 获取指定 provider 的内置模型列表
app.get('/api/ai/catalog/models/:provider', (req, res) => {
  const { provider } = req.params;
  const models = getOpenClawProviderModels(provider);
  res.json({ provider, models });
});

// 查询单个模型的能力
app.get('/api/ai/catalog/lookup/:provider/:modelId', (req, res) => {
  const { provider, modelId } = req.params;
  const caps = lookupModelCapabilities(provider, modelId);
  if (!caps) {
    return res.json({ found: false, provider, modelId, message: '模型未在内置目录中找到，将使用安全默认值' });
  }
  res.json({
    found: true,
    provider,
    modelId,
    capabilities: caps,
    entry: buildModelEntry(provider, modelId)
  });
});

// 添加 API Key
app.post('/api/ai/keys', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl } = req.body || {};

    if (!provider) {
      return res.status(400).json({ error: 'provider 不能为空' });
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
      // 设置为当前活跃 key
      models.providers[provider].apiKey = apiKey;
      console.log(`[ai/keys] API key for ${provider} saved (active)`);
    }

    // 同步 auth-profiles.json（支持多 key：每个 key 用唯一 profileId）
    let authProfiles = readAiAuthProfiles();

    if (apiKey) {
      // 检查是否已有相同 apiKey 的 profile（避免重复）
      const existingProfileId = Object.keys(authProfiles.profiles || {}).find(pid => {
        const p = authProfiles.profiles[pid];
        return p?.provider === provider && p?.apiKey === apiKey;
      });

      if (!existingProfileId) {
        // 生成新 profileId
        // 第一个 key 用 provider 名，后续加 :N 后缀
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
      // 同时更新旧格式顶级条目（兼容）
      authProfiles[provider] = {
        provider,
        mode: 'api_key',
        apiKey,
        type: 'api_key',
        key: apiKey
      };
    }

    writeAiAuthProfiles(authProfiles);

    // 同步 openclaw.json 中的 models.providers
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

    res.json({ success: true, message: `${provider} API Key 已保存` });
  } catch (err) {
    console.error('[ai/keys] Error adding key:', err);
    res.status(500).json({ error: '添加失败: ' + (err?.message || '未知错误') });
  }
});

// 删除 API Key
app.delete('/api/ai/keys', async (req, res) => {
  try {
    const { provider, keyId } = req.body || {};

    if (!provider) {
      return res.status(400).json({ error: 'provider 不能为空' });
    }

    const configPath = '/root/.openclaw/openclaw.json';

    // 读取 auth-profiles
    let authProfiles = readAiAuthProfiles();

    // 删除指定的 profile（keyId 是 profileId）
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

    // 检查该 provider 是否还有其他 key
    const remainingKeys = Object.entries(authProfiles.profiles || {}).filter(([pid, p]) => p?.provider === provider);
    const hasRemainingKeys = remainingKeys.length > 0;

    // 从 models.json 中处理
    let models = readAiModels();

    if (!hasRemainingKeys) {
      // 没有剩余 key，移除 provider
      if (models.providers?.[provider]) {
        delete models.providers[provider];
        console.log(`[ai/keys] Removed provider ${provider} from models.json (no remaining keys)`);
      }
      // 清除旧格式顶级条目
      if (authProfiles[provider]) {
        delete authProfiles[provider];
      }
    } else {
      // 还有剩余 key，激活第一个
      const [nextPid, nextProfile] = remainingKeys[0];
      const nextKey = getAuthProfileSecret(nextProfile);
      if (nextKey && models.providers?.[provider]) {
        models.providers[provider].apiKey = nextKey;
        console.log(`[ai/keys] Activated next key for ${provider}: profile ${nextPid}`);
      }
      // 更新旧格式顶级条目
      if (nextProfile) {
        authProfiles[provider] = { ...nextProfile };
      }
    }

    // 从 openclaw.json 中处理
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { config = {}; }

    if (!hasRemainingKeys) {
      if (config.models?.providers?.[provider]) {
        delete config.models.providers[provider];
      }

      // 清除引用了该 provider 的模型配置
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
    // 写回所有文件（自动清理非法 key）
    writeAiModels(models);
    writeAiAuthProfiles(authProfiles);
    writeOpenClawConfig(config);

    res.json({ success: true, message: `${provider} 已删除` });
  } catch (err) {
    console.error('[ai/keys] Error deleting key:', err);
    res.status(500).json({ error: '删除失败: ' + (err?.message || '未知错误') });
  }
});

// 获取可用模型列表
app.post('/api/ai/models', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl } = req.body || {};

    if (!provider) {
      return res.status(400).json({ error: 'provider 不能为空' });
    }

    // 对于某些 provider，返回内置模型列表
    const builtInModels = {
      // 常用
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
      // 国际
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
      // 中国
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
      // 网关
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

    // github-copilot: 先交换 Copilot API Token，再获取模型
    if (provider === 'github-copilot') {
      try {
        const authProfiles = readAiAuthProfiles();
        // 兼容 openclaw 格式 (profiles sub-key) 和旧格式 (直接 top-level)
        const copilotAuth = authProfiles?.profiles?.['github-copilot:github']
          || authProfiles?.profiles?.['github-copilot']
          || authProfiles['github-copilot'];
        const githubToken = copilotAuth?.token || copilotAuth?.apiKey || '';
        if (githubToken) {
          console.log(`[ai/models] Exchanging GitHub token ${githubToken.substring(0, 8)}... for Copilot API token`);
          // Step 1: 将 GitHub ghu_ token 交换为 Copilot API token
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
            // 返回内置列表但同时携带错误信息
            return res.json({ success: true, models: builtInModels['github-copilot'], source: 'builtin', error: copilotErrorDetail || `HTTP ${tokenRes.status}` });
          } else {
            const tokenData = await tokenRes.json();
            const copilotApiToken = tokenData.token;
            if (copilotApiToken) {
              console.log(`[ai/models] Copilot API token obtained, expires_at: ${tokenData.expires_at}`);
              // 从 token 中提取实际 API base URL (proxy-ep 字段)
              let apiBaseUrl = 'https://api.individual.githubcopilot.com';
              const epMatch = copilotApiToken.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
              if (epMatch) {
                apiBaseUrl = 'https://' + epMatch[1].replace(/^proxy\./, 'api.');
                console.log(`[ai/models] Using extracted API base: ${apiBaseUrl}`);
              }
              // Step 2: 用 Copilot API token 获取模型列表
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
      // fallback 到内置列表
      console.log(`[ai/models] Using builtin copilot model list`);
      return res.json({ success: true, models: builtInModels['github-copilot'], source: 'builtin' });
    }

    // 尝试从存储中获取 API key（如果请求中没有提供）
    let effectiveApiKey = apiKey;
    if (!effectiveApiKey) {
      try {
        const modelsPath = '/root/.openclaw/agents/main/agent/models.json';
        const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
        effectiveApiKey = models?.providers?.[provider]?.apiKey || '';
      } catch {}
    }

    // 对于支持 /models 端点的 provider，尝试动态获取模型列表
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
          // ollama 使用不同的 API 路径
          const modelsUrl = provider === 'ollama'
            ? `${endpoint}/api/tags`
            : provider === 'anthropic'
              ? null  // Anthropic 不支持 /models 端点
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
              // 确保所有模型 ID 都有 provider/ 前缀
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

    // fallback 到内置列表
    if (builtInModels[provider]) {
      return res.json({ success: true, models: builtInModels[provider], source: 'builtin' });
    }

    // 默认返回空列表
    res.json({ success: true, models: [] });
  } catch (err) {
    console.error('[ai/models] Error:', err);
    res.status(500).json({ error: '获取模型列表失败: ' + (err?.message || '未知错误') });
  }
});

// 辅助函数：获取默认 baseUrl
function getDefaultBaseUrl(provider) {
  const urls = {
    // 常用
    'anthropic': 'https://api.anthropic.com/v1',
    'openai': 'https://api.openai.com/v1',
    'github-copilot': DEFAULT_COPILOT_API_BASE_URL,
    'gemini': 'https://generativelanguage.googleapis.com/v1beta',
    'openrouter': 'https://openrouter.ai/api/v1',
    'deepseek': 'https://api.deepseek.com/v1',
    // 国际
    'mistral': 'https://api.mistral.ai/v1',
    'xai': 'https://api.x.ai/v1',
    'groq': 'https://api.groq.com/openai/v1',
    'together': 'https://api.together.xyz/v1',
    'huggingface': 'https://router.huggingface.co/v1',
    'perplexity': 'https://api.perplexity.ai',
    'nvidia': 'https://integrate.api.nvidia.com/v1',
    'cerebras': 'https://api.cerebras.ai/v1',
    'venice': 'https://api.venice.ai/api/v1',
    // 中国
    'bailian': 'https://coding.dashscope.aliyuncs.com/v1',
    'zai': 'https://open.bigmodel.cn/api/paas/v4',
    'moonshot': 'https://api.moonshot.ai/v1',
    'kimi-coding': 'https://api.kimi.com/coding/',
    'minimax': 'https://api.minimax.io/anthropic',
    'xiaomi': 'https://api.xiaomimimo.com/anthropic',
    'qianfan': 'https://qianfan.baidubce.com/v2',
    'volcengine': 'https://ark.cn-beijing.volces.com/api/v3',
    'byteplus': 'https://ark.ap-southeast.bytepluses.com/api/v3',
    // 网关
    'litellm': 'http://localhost:4000',
    'opencode': 'https://opencode.ai/v1',
    'kilocode': 'https://api.kilo.ai/api/gateway/',
    // 本地
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
        message: 'Gateway 重启已在进行中，请稍候',
        operationState: opState
      });
    }

    if (opState.type !== 'idle') {
      return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
    }

    // 写入 operation.lock，让 watchdog 来执行重启
    queueGatewayRestart('api-restart');

    res.json({
      success: true,
      message: '重启请求已提交，watchdog 将在 10 秒内执行',
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
      || /(timeout|超时|failed|失败|exit=\d+|not found|EAI_AGAIN|ETIMEDOUT|ECONN|EADDRINUSE)/i.test(normalized)
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
  appendInstallLog(task, '[openclaw] 安装脚本开始执行，以下为实时输出...\n\n');

  const escaped = String(command).replace(/'/g, `'"'"'`);
  const child = exec(`bash --noprofile --norc -lc '${escaped}'`, {
    timeout: 2700000,
    maxBuffer: 200 * 1024 * 1024,
    env: { ...process.env, TERM: 'dumb' }
  });
  task.pid = Number(child.pid || 0) || 0;
  // C7: 持久化子进程 PID 以便重启后检测孤儿进程 (DFMEA T2)
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
    appendInstallLog(task, `[openclaw] 任务启动失败: ${err.message}\n`);
    task.status = 'failed';
    task.exitCode = -1;
    task.error = `任务启动失败: ${err.message}`;
    clearOpenClawOperationState(operationType);
  });
  child.stdout.on('data', d => appendInstallLog(task, d));
  child.stderr.on('data', d => appendInstallLog(task, d));
  child.on('close', (code, signal) => {
    clearInterval(heartbeatTimer);
    if (signal) {
      appendInstallLog(task, `[openclaw] 任务被中断（signal=${signal}），可能超时或被外部终止。\n`);
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
      const opLabel = operationType === 'updating' ? '更新' : '安装';
      const metadataSync = syncOpenClawPostInstallMetadata({ operationType, release: task.release || null });
      task.metadataSync = metadataSync;
      if (metadataSync?.error) {
        appendInstallLog(task, `[openclaw][warn] ${opLabel}后元数据同步失败: ${metadataSync.error}\n`);
      } else if (metadataSync?.configChanged || metadataSync?.updateCheckChanged) {
        appendInstallLog(task, `[openclaw] ${opLabel}后已同步元数据：version=${metadataSync.version}${metadataSync.tag ? ` tag=${metadataSync.tag}` : ''}\n`);
      }
      // A/B swap 已在安装脚本内完成 Gateway 停止→启动→健康检查，无需额外重启
      // 仅确保 watchdog 存活以便后续监控
      ensureGatewayWatchdog((wdErr) => {
        if (wdErr) {
          appendInstallLog(task, `[openclaw][warn] ensureGatewayWatchdog 失败: ${wdErr.message}\n`);
        }
      });
      appendInstallLog(task, `[openclaw] ${opLabel}完成（A/B 切换已启动并验证新 Gateway）。\n`);
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
        if (/(exit\s*=\s*\d+|超时|failed|失败|not found|ENOENT|ECONN|EAI_AGAIN|ETIMEDOUT)/i.test(line)) {
          reason = line;
          break;
        }
      }
      task.error = reason || `安装失败（exit=${code ?? 'unknown'}${signal ? `, signal=${signal}` : ''}）`;
      appendInstallLog(task, `[openclaw][error] ${task.error}\n`);
    }
    const durationSec = Math.max(0, Math.floor((Date.now() - Number(task.startedAt || Date.now())) / 1000));
    appendInstallLog(task, `[openclaw] task duration: ${durationSec}s\n`);
    appendInstallLog(task, `[state] operation=${operationType} status=${task.status} duration=${durationSec}s task=${taskId}\n`);
    appendInstallLog(task, `\n===== [${new Date().toISOString()}] task ${taskId} end status=${task.status} exitCode=${code ?? 'null'} signal=${signal || 'none'} =====\n`);
    if (activeInstallTaskId === taskId) activeInstallTaskId = '';
    clearOpenClawOperationState(operationType);
    // C7: 清理 PID 文件
    try { fs.unlinkSync(OPENCLAW_TASK_PID_FILE); } catch {}
    const keys = Object.keys(installLogs).sort();
    while (keys.length > 5) delete installLogs[keys.shift()];
  });

  return taskId;
}

// C7: 服务重启时检测并清理孤儿安装进程 (DFMEA T2)
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
      console.log(`[openclaw][orphan] 检测到孤儿安装进程 PID=${pid} task=${info.taskId} age=${ageSec}s，尝试终止...`);
      try { process.kill(pid, 'SIGTERM'); } catch {}
      setTimeout(() => {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
      }, 5000);
    } else {
      console.log(`[openclaw][orphan] PID=${pid} 已不存在，清理過期 PID 文件`);
    }
    try { fs.unlinkSync(OPENCLAW_TASK_PID_FILE); } catch {}
    // 同时清理可能过期的 operation.lock
    clearOpenClawOperationState(info.operationType || 'installing');
  } catch (e) {
    console.log(`[openclaw][orphan] 检查孤儿进程失败: ${e.message}`);
  }
}

function buildOpenClawUninstallCommand() {
  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] 脚本异常退出 line=$LINENO exit=$?" >&2\' ERR',
    'echo "[openclaw] 开始卸载 OpenClaw..."',
    'NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo /usr/local)"',
    'OPENCLAW_STATE_ROOT="/root/.openclaw"',
    'echo "[openclaw] npm prefix: ${NPM_PREFIX}"',
    'npm uninstall -g openclaw >/dev/null 2>&1 || true',
    'rm -f "${NPM_PREFIX}/bin/openclaw" >/dev/null 2>&1 || true',
    'rm -rf "${NPM_PREFIX}/lib/node_modules/openclaw" >/dev/null 2>&1 || true',
    'rm -rf "${OPENCLAW_STATE_ROOT}/openclaw" "${OPENCLAW_STATE_ROOT}/openclaw-source" >/dev/null 2>&1 || true',
    'rm -f "${OPENCLAW_STATE_ROOT}/openclaw-source-install.json" >/dev/null 2>&1 || true',
    'echo "[openclaw] 卸载完成（npm 全局包和本地源码目录已移除）"'
  ].join('\n');
}

function listOpenClawConfigBackups() {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG_BACKUP_DIR)) return [];
    const entries = fs.readdirSync(OPENCLAW_CONFIG_BACKUP_DIR);
    const result = [];

    // 新格式: snapshot-YYYYMMDD-HHMMSS 目录
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

    // 旧格式: openclaw-YYYYMMDD-HHMMSS.json 单文件
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
  // 支持旧格式 JSON 文件名和新的 snapshot 目录名
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
    // C6: 使用原子写入防止竞态读到半写数据 (DFMEA O2)
    // C9: 使用紧凑 JSON，因为 watchdog 的 grep 模式不匹配美化格式
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
        ? '安装中'
        : type === 'updating'
          ? '更新中'
          : type === 'uninstalling'
            ? '卸载中'
          : type === 'restarting_gateway'
            ? 'Gateway 启动中'
            : type === 'repairing_config'
              ? '配置恢复中'
              : '处理中'
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
  if (!safeTag || !safeTarball) throw new Error('release 信息不完整，无法构建安装命令');

  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] 脚本异常退出 line=$LINENO exit=$?" >&2\' ERR',
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
    'for bin in node npm git curl tar gzip; do',
    '  if ! command -v "$bin" >/dev/null 2>&1; then',
    '    echo "[openclaw] 缺少镜像内依赖: $bin（请重新构建镜像，不在运行时安装系统依赖）"',
    '    exit 11',
    '  fi',
    'done',
    'cd "$EXTRACT_DIR"',
    'export NODE_ENV=development',
    'export NPM_CONFIG_PRODUCTION=false',
    'export npm_config_production=false',
    'export NPM_CONFIG_INCLUDE=dev',
    'export npm_config_include=dev',
    'echo "[openclaw] source 构建阶段使用 dev 依赖模式 (NPM_CONFIG_PRODUCTION=false)"',
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
    'PNPM_CMD="pnpm"',
    'if command -v pnpm >/dev/null 2>&1; then',
    '  PNPM_CMD="pnpm"',
    'elif command -v corepack >/dev/null 2>&1; then',
    '  corepack prepare pnpm@10.23.0 --activate >/dev/null 2>&1 || true',
    '  if corepack pnpm -v >/dev/null 2>&1; then',
    '    PNPM_CMD="corepack pnpm"',
    '    echo "[openclaw] 未检测到 pnpm 可执行文件，使用 corepack pnpm 兜底"',
    '  else',
    '    echo "[openclaw] 缺少镜像内依赖: pnpm（corepack 兜底不可用）"',
    '    exit 11',
    '  fi',
    'else',
    '  echo "[openclaw] 缺少镜像内依赖: pnpm（请重新构建镜像，不在运行时安装系统依赖）"',
    '  exit 11',
    'fi',
    'PNPM_BIN_DIR="$(npm prefix -g 2>/dev/null)/bin"',
    'export PATH="$PNPM_BIN_DIR:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'if [ -x "$PNPM_BIN_DIR/pnpm" ]; then ln -sf "$PNPM_BIN_DIR/pnpm" /usr/local/bin/pnpm 2>/dev/null || true; fi',
    'if ! command -v pnpm >/dev/null 2>&1 && ! { command -v corepack >/dev/null 2>&1 && corepack pnpm -v >/dev/null 2>&1; }; then echo "[openclaw] pnpm 不可用，安装失败"; exit 5; fi',
    'if npm run | grep -qE "(^| )build( |$)"; then npm run build; elif npm run | grep -qE "(^| )compile( |$)"; then npm run compile; else echo "[openclaw] 未找到 build/compile 脚本"; exit 3; fi',
    'if [ ! -f dist/control-ui/index.html ]; then',
    '  echo "[openclaw] 检测到 control-ui 产物缺失，尝试执行 ui:build"',
    '  if npm run | grep -qE "(^| )ui:build( |$)"; then',
    '    $PNPM_CMD ui:build || npm run ui:build || true',
    '  fi',
    'fi',
    'if [ ! -f dist/control-ui/index.html ] && [ -d control-ui ] && [ -f control-ui/package.json ]; then',
    '  echo "[openclaw] 尝试在 control-ui 子目录执行构建"',
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
    '  echo "[openclaw] 使用现有安装中的 control-ui 产物回填"',
    '  mkdir -p dist/control-ui',
    '  cp -a "$PERSIST_SRC_DIR/dist/control-ui/." dist/control-ui/ || true',
    'fi',
    'if [ ! -f dist/control-ui/index.html ] && command -v npm >/dev/null 2>&1; then',
    '  NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"',
    '  if [ -n "$NPM_GLOBAL_ROOT" ] && [ -f "$NPM_GLOBAL_ROOT/openclaw/dist/control-ui/index.html" ]; then',
    '    echo "[openclaw] 使用 npm 全局 openclaw 的 control-ui 产物回填"',
    '    mkdir -p dist/control-ui',
    '    cp -a "$NPM_GLOBAL_ROOT/openclaw/dist/control-ui/." dist/control-ui/ || true',
    '  fi',
    'fi',
    'if [ ! -f dist/control-ui/index.html ]; then',
    '  # C5: 增强 control-ui 缺失的诊断信息 (DFMEA S1)',
    '  echo "[openclaw][error] control-ui 产物缺失，无法保证 Gateway /health 可用"',
    '  echo "[openclaw][diag] ls -la dist/ :"',
    '  ls -la dist/ 2>/dev/null || echo "  (dist/ 目录不存在)"',
    '  echo "[openclaw][diag] ls -la dist/control-ui/ :"',
    '  ls -la dist/control-ui/ 2>/dev/null || echo "  (dist/control-ui/ 目录不存在)"',
    '  echo "[openclaw][diag] find . -name index.html:"',
    '  find . -name index.html -type f 2>/dev/null | head -10 || echo "  (未找到任何 index.html)"',
    '  echo "[openclaw][diag] npm run scripts:"',
    '  npm run 2>/dev/null | grep -E "ui:|build" || echo "  (无匹配)"',
    '  exit 4',
    'fi',
    'STAGE_SRC_DIR="$WORK_BASE/openclaw-source.stage.$$"',
    'rm -rf "$STAGE_SRC_DIR"',
    'mkdir -p /root/.openclaw "$WORK_BASE"',
    'cp -a "$EXTRACT_DIR" "$STAGE_SRC_DIR"',
    '# A/B 模式: 安装到 staging 目录 (Gateway 不中断)',
    'NEXT_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source-next"',
    'rm -rf "$NEXT_SRC_DIR" 2>/dev/null || true',
    'mv -Tf "$STAGE_SRC_DIR" "$NEXT_SRC_DIR"',
    'if [ ! -f "$NEXT_SRC_DIR/openclaw.mjs" ] && [ -f "$NEXT_SRC_DIR/dist/openclaw.mjs" ]; then ln -sf "$NEXT_SRC_DIR/dist/openclaw.mjs" "$NEXT_SRC_DIR/openclaw.mjs"; fi',
    'if [ ! -f "$NEXT_SRC_DIR/openclaw.mjs" ]; then echo "[openclaw] 编译产物缺失: $NEXT_SRC_DIR/openclaw.mjs"; exit 4; fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.js" ] && [ -f "$NEXT_SRC_DIR/dist/index.js" ]; then ln -sfn index.js "$NEXT_SRC_DIR/dist/entry.js"; fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.mjs" ] && [ -f "$NEXT_SRC_DIR/dist/index.mjs" ]; then ln -sfn index.mjs "$NEXT_SRC_DIR/dist/entry.mjs"; fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.js" ] && [ ! -f "$NEXT_SRC_DIR/dist/entry.mjs" ] && [ ! -f "$NEXT_SRC_DIR/dist/index.js" ] && [ ! -f "$NEXT_SRC_DIR/dist/index.mjs" ]; then echo "[openclaw] 编译产物缺失: $NEXT_SRC_DIR/dist/entry|index.(m)js"; exit 4; fi',
    'mkdir -p /root/.openclaw',
    'printf "{\\n  \\\"repo\\\": \\\"%s\\\",\\n  \\\"tag\\\": \\\"%s\\\",\\n  \\\"tarballUrl\\\": \\\"%s\\\",\\n  \\\"installedAt\\\": \\\"%s\\\"\\n}\\n" "$OPENCLAW_REPO" "$OPENCLAW_TAG" "$OPENCLAW_TARBALL_URL" "$(date -Iseconds)" > /root/.openclaw/openclaw-source-install.json',
    'echo "[openclaw] source build staging 完成: $OPENCLAW_REPO@$OPENCLAW_TAG"',
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
    'trap \'echo "[openclaw][error] 脚本异常退出 line=$LINENO exit=$?" >&2\' ERR',
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
    'echo "[openclaw] 尝试 release 编译包: $OPENCLAW_ASSET_NAME (source=$OPENCLAW_ASSET_SOURCE)"',
    'echo "[openclaw] 资产直链: $OPENCLAW_ASSET_URL"',
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
    '    echo "[openclaw] 下载编译包尝试 $i/$max_retry (source=$source_idx): $url"',
    '    rm -f "$tmp"',
    '    http_code="$(curl -fL --http1.1 --connect-timeout 12 --max-time 1200 --retry 2 --retry-delay 2 --retry-all-errors -o "$tmp" -w "%{http_code}" "$url" 2>/dev/null || true)"',
    '    if [ -s "$tmp" ] && { [ "$http_code" = "200" ] || [ "$http_code" = "206" ]; }; then',
    '      echo "[openclaw] 下载成功(source=$source_idx, http=$http_code, bytes=$(wc -c < \"$tmp\" 2>/dev/null || echo 0))"',
    '      mv -f "$tmp" "$ARCHIVE_PATH"',
    '      return 0',
    '    fi',
    '    echo "[openclaw] 下载失败(source=$source_idx, http=${http_code:-000})，准备重试..."',
    '    rm -f "$tmp"',
    '    sleep $(( i < 5 ? 2 : 4 ))',
    '    i=$((i + 1))',
    '  done',
    '  echo "[openclaw][error] release 资产下载失败：多源重试耗尽（$max_retry 次）"',
    '  return 21',
    '}',
    'download_asset',
    'echo "[openclaw] 编译包下载完成: $ARCHIVE_PATH"',
    'case "$OPENCLAW_ASSET_NAME" in',
    '  *.tar.gz|*.tgz)',
    '    echo "[openclaw] 解压 tar.gz 编译包..."',
    '    tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"',
    '    ;;',
    '  *.zip)',
    '    if ! command -v unzip >/dev/null 2>&1; then',
    '      echo "[openclaw][error] 编译包为 zip，但镜像缺少 unzip"',
    '      exit 12',
    '    fi',
    '    echo "[openclaw] 解压 zip 编译包..."',
    '    unzip -q "$ARCHIVE_PATH" -d "$EXTRACT_DIR"',
    '    ;;',
    '  *)',
    '    echo "[openclaw][error] 不支持的编译包格式: $OPENCLAW_ASSET_NAME"',
    '    exit 12',
    '    ;;',
    'esac',
    'echo "[openclaw] 查找 openclaw.mjs 入口..."',
    'ASSET_ROOT="$(find "$EXTRACT_DIR" -type f -name openclaw.mjs | head -1 | xargs -I{} dirname "{}")"',
    'if [ -z "$ASSET_ROOT" ] || [ ! -f "$ASSET_ROOT/openclaw.mjs" ]; then',
    '  echo "[openclaw][error] 编译包缺少 openclaw.mjs"',
    '  exit 13',
    'fi',
    'echo "[openclaw] 编译包根目录: $ASSET_ROOT"',
    '# C4: node --check 语法验证 (DFMEA R1)',
    'if command -v node >/dev/null 2>&1; then',
    '  if ! node --check "$ASSET_ROOT/openclaw.mjs" 2>/dev/null; then',
    '    echo "[openclaw][error] openclaw.mjs 语法校验失败(node --check)，编译包可能损坏"',
    '    exit 14',
    '  fi',
    '  echo "[openclaw] openclaw.mjs node --check 语法校验通过"',
    'fi',
    'if [ ! -f "$ASSET_ROOT/dist/entry.js" ] && [ -f "$ASSET_ROOT/dist/index.js" ]; then ln -sfn index.js "$ASSET_ROOT/dist/entry.js"; fi',
    'if [ ! -f "$ASSET_ROOT/dist/entry.mjs" ] && [ -f "$ASSET_ROOT/dist/index.mjs" ]; then ln -sfn index.mjs "$ASSET_ROOT/dist/entry.mjs"; fi',
    'if [ ! -f "$ASSET_ROOT/dist/entry.js" ] && [ ! -f "$ASSET_ROOT/dist/entry.mjs" ] && [ ! -f "$ASSET_ROOT/dist/index.js" ] && [ ! -f "$ASSET_ROOT/dist/index.mjs" ]; then',
    '  echo "[openclaw][error] 编译包缺少 dist/entry|index.(m)js"',
    '  exit 13',
    'fi',
    'if [ ! -f "$ASSET_ROOT/dist/control-ui/index.html" ]; then',
    '  echo "[openclaw] WARN: 编译包缺少 control-ui 产物"',
    'fi',
    'if [ "$OPENCLAW_ASSET_SOURCE" = "npm-dist-tarball" ]; then',
    '  if ! command -v npm >/dev/null 2>&1; then',
    '    echo "[openclaw][error] npm-dist 资产缺少 npm，无法安装运行依赖"',
    '    exit 11',
    '  fi',
    '  echo "[openclaw] npm-dist 资产：安装运行时依赖(node_modules)..."',
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
    '      echo "[openclaw] npm-dist 依赖安装失败(registry=$reg, attempt=$i)，重试..."',
    '      sleep 3',
    '      i=$((i + 1))',
    '    done',
    '    return 1',
    '  }',
    '  if ! install_asset_deps https://registry.npmmirror.com; then',
    '    echo "[openclaw] npm-dist 依赖安装回退 npmjs registry..."',
    '    install_asset_deps https://registry.npmjs.org',
    '  fi',
    'fi',
    'echo "[openclaw] 安装编译包到 staging 目录 (A/B 模式，Gateway 不中断)..."',
    'NEXT_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source-next"',
    'rm -rf "$NEXT_SRC_DIR" 2>/dev/null || true',
    'mv -Tf "$ASSET_ROOT" "$NEXT_SRC_DIR"',
    'printf "{\\n  \\\"repo\\\": \\\"%s\\\",\\n  \\\"tag\\\": \\\"%s\\\",\\n  \\\"assetName\\\": \\\"%s\\\",\\n  \\\"assetUrl\\\": \\\"%s\\\",\\n  \\\"installedAt\\\": \\\"%s\\\"\\n}\\n" "$OPENCLAW_REPO" "$OPENCLAW_TAG" "$OPENCLAW_ASSET_NAME" "$OPENCLAW_ASSET_URL" "$(date -Iseconds)" > /root/.openclaw/openclaw-source-install.json',
    'echo "[openclaw] release 资产 staging 完成: $OPENCLAW_ASSET_NAME"',
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
    '    echo "[openclaw] npm 模式安装完成并校验通过。"',
    '  else',
    '    echo "[openclaw][error] npm 模式安装后版本或入口校验失败。"',
    '    exit 43',
    '  fi',
    'else',
    '  rc=$?',
    '  echo "[openclaw][error] npm 模式安装失败(exit=${rc})"',
    '  exit "$rc"',
    'fi'
  ].join('\n');

  const autoModeBlock = [
    'if current_already_at_target; then',
    '  echo "[openclaw] 当前运行版本已满足目标版本，跳过安装。"',
    '  exit 0',
    'fi',
    'echo "[openclaw] 自动模式：执行官方 npm 安装..."',
    'if (',
    npmCmd,
    '); then',
    '  rm -f /root/.openclaw/openclaw-source-install.json >/dev/null 2>&1 || true',
    '  if runtime_ready_and_latest; then',
    '    echo "[openclaw] npm 路径成功。"',
    '  else',
    '    echo "[openclaw][error] npm 路径后校验未通过。"',
    '    exit 43',
    '  fi',
    'else',
    '  rc=$?',
    '  echo "[openclaw][error] npm 路径失败(exit=${rc})。"',
    '  exit "$rc"',
    'fi'
  ].join('\n');

  const modeBlock = mode === 'npm' ? npmModeBlock : autoModeBlock;

  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] 脚本异常退出 line=$LINENO exit=$?" >&2\' ERR',
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
    '# 清理残留 staging 目录',
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
    '  # 仅当检查当前运行目录(PERSIST_SRC_DIR)时才 fallback 到全局命令',
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
    '  # 仅当检查当前运行目录时才 fallback 到全局命令',
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
    '    echo "[openclaw] WARN: 未读取到当前版本，按入口可用继续"',
    '    return 0',
    '  fi',
    '  if [ "$current" = "$TARGET_VERSION" ]; then',
    '    echo "[openclaw] 版本校验通过: ${current}"',
    '    return 0',
    '  fi',
    '  echo "[openclaw] 版本校验未通过: current=${current} target=${TARGET_VERSION}"',
    '  return 1',
    '}',
    '# 对 staging NEXT_SRC_DIR 验证',
    'runtime_ready_and_latest() { verify_runtime_entry "$NEXT_SRC_DIR" && version_matches_target "$NEXT_SRC_DIR"; }',
    '# 对当前运行版本（PERSIST_SRC_DIR）验证',
    'current_already_at_target() { verify_runtime_entry "$PERSIST_SRC_DIR" && version_matches_target "$PERSIST_SRC_DIR"; }',
    modeBlock,
    '',
    '# ===== A/B 切换: 停止 Gateway → 替换 → 启动 Gateway → 验证 → 回退 =====',
    'echo "[openclaw][A/B] 安装成功，开始执行版本切换..."',
    'if [ ! -d "$NEXT_SRC_DIR" ]; then',
    '  echo "[openclaw][error] staging 目录丢失: $NEXT_SRC_DIR"',
    '  exit 50',
    'fi',
    '# 步骤 1: 停止 Gateway 进程',
    'echo "[openclaw][A/B] 步骤 1/4: 停止 Gateway..."',
    'AB_GW_PID="$(pgrep -x openclaw-gateway 2>/dev/null || pgrep -x openclaw-gatewa 2>/dev/null || true)"',
    'AB_HAD_GATEWAY=0',
    'if [ -n "$AB_GW_PID" ]; then',
    '  AB_HAD_GATEWAY=1',
    '  echo "[openclaw][A/B] 发现 Gateway PID=$AB_GW_PID，正在停止..."',
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
    '# 用 pgrep + grep -v 排除自身及父进程，防止 pkill -f 匹配脚本自身命令行',
    '_SELF_PIDS="^($$|$PPID)\\$"',
    'pgrep -f "openclaw.mjs gateway" 2>/dev/null | grep -vE "$_SELF_PIDS" | xargs -r kill -9 2>/dev/null || true',
    'pgrep -f "openclaw.*gateway run" 2>/dev/null | grep -vE "$_SELF_PIDS" | xargs -r kill -9 2>/dev/null || true',
    'sleep 1',
    'echo "[openclaw][A/B] Gateway 已停止"',
    '',
    '# 步骤 2: 原子切换目录',
    'echo "[openclaw][A/B] 步骤 2/4: 执行版本目录切换..."',
    'rm -rf "$PREV_SRC_DIR" 2>/dev/null || true',
    'if [ -d "$PERSIST_SRC_DIR" ] || [ -L "$PERSIST_SRC_DIR" ]; then',
    '  mv -f "$PERSIST_SRC_DIR" "$PREV_SRC_DIR" 2>/dev/null || true',
    '  echo "[openclaw][A/B] 旧版本已暂存到 $PREV_SRC_DIR"',
    'fi',
    'mv -Tf "$NEXT_SRC_DIR" "$PERSIST_SRC_DIR"',
    'ln -sfn "$PERSIST_SRC_DIR" "$WORK_SRC_DIR"',
    'echo "[openclaw][A/B] 版本目录切换完成: openclaw-source → 新版本"',
    '',
    '# 步骤 3: 启动 Gateway 并验证',
    'echo "[openclaw][A/B] 步骤 3/4: 启动 Gateway 并验证..."',
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
    '  echo "[openclaw][A/B] 启动源路径: ${AB_GATEWAY_SOURCE_ROOT}"',
    '  nohup bash --noprofile --norc -lc "$AB_LAUNCH_CMD" >> "$GATEWAY_LOG" 2>&1 &',
    '  AB_GW_NEW_PID=$!',
    '  echo "[openclaw][A/B] Gateway 已启动 PID=$AB_GW_NEW_PID，等待健康检查..."',
    '  AB_HEALTH_WAIT=0',
    '  AB_HEALTH_TIMEOUT=300',
    '  AB_GW_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"',
    '  while [ "$AB_HEALTH_WAIT" -lt "$AB_HEALTH_TIMEOUT" ]; do',
    '    if curl -sf --max-time 3 "http://127.0.0.1:${AB_GW_PORT}/health" >/dev/null 2>&1; then',
    '      AB_GATEWAY_OK=1',
    '      break',
    '    fi',
    '    if ! kill -0 "$AB_GW_NEW_PID" 2>/dev/null; then',
    '      echo "[openclaw][A/B] Gateway 进程意外退出"',
    '      break',
    '    fi',
    '    sleep 3',
    '    AB_HEALTH_WAIT=$((AB_HEALTH_WAIT + 3))',
    '    if [ "$((AB_HEALTH_WAIT % 15))" -eq 0 ]; then',
    '      echo "[openclaw][A/B] 等待 Gateway 健康检查... ${AB_HEALTH_WAIT}s/${AB_HEALTH_TIMEOUT}s"',
    '    fi',
    '  done',
    'else',
    '  echo "[openclaw][A/B] 未找到 Gateway 启动命令，跳过健康检查"',
    '  AB_GATEWAY_OK=1',
    'fi',
    '',
    '# 步骤 4: 验证结果, 失败则回退',
    'if [ "$AB_GATEWAY_OK" = "1" ]; then',
    '  echo "[openclaw][A/B] ✅ Gateway 健康检查通过，版本切换成功!"',
    '  rm -rf "$PREV_SRC_DIR" 2>/dev/null || true',
    '  FINAL_VER="$(current_openclaw_version "$PERSIST_SRC_DIR")"',
    '  echo "[openclaw][A/B] 当前版本: ${FINAL_VER:-unknown}"',
    'else',
    '  echo "[openclaw][A/B] ❌ Gateway 健康检查失败，执行版本回退..."',
    '  # 停止新 Gateway',
    '  pkill -9 -x "openclaw-gateway" 2>/dev/null || true',
    '  pkill -9 -x "openclaw-gatewa" 2>/dev/null || true',
    '  pgrep -f "openclaw.mjs gateway" 2>/dev/null | grep -vE "$_SELF_PIDS" | xargs -r kill -9 2>/dev/null || true',
    '  pgrep -f "openclaw.*gateway run" 2>/dev/null | grep -vE "$_SELF_PIDS" | xargs -r kill -9 2>/dev/null || true',
    '  sleep 1',
    '  # 回退目录',
    '  if [ -d "$PREV_SRC_DIR" ] || [ -L "$PREV_SRC_DIR" ]; then',
    '    rm -rf "$PERSIST_SRC_DIR" 2>/dev/null || true',
    '    mv -f "$PREV_SRC_DIR" "$PERSIST_SRC_DIR"',
    '    ln -sfn "$PERSIST_SRC_DIR" "$WORK_SRC_DIR"',
    '    echo "[openclaw][A/B] 已回退到旧版本"',
    '    # 重启旧版本 Gateway',
    '    if [ "$AB_HAD_GATEWAY" = "1" ] && [ -f "$PERSIST_SRC_DIR/openclaw.mjs" ]; then',
    '      prepare_ab_gateway_source_root "$PERSIST_SRC_DIR"',
    '      ROLLBACK_CMD="node --experimental-sqlite $AB_GATEWAY_SOURCE_ROOT/openclaw.mjs gateway run --force --allow-unconfigured"',
    '      echo "" >> "$GATEWAY_LOG"',
    '      echo "===== [$(date -u +%FT%T.%3NZ)] A/B rollback: restarting old Gateway =====" >> "$GATEWAY_LOG"',
      '      echo "[openclaw][A/B] 回滚启动源路径: ${AB_GATEWAY_SOURCE_ROOT}"',
    '      nohup bash --noprofile --norc -lc "$ROLLBACK_CMD" >> "$GATEWAY_LOG" 2>&1 &',
    '      echo "[openclaw][A/B] 旧版本 Gateway 已重启 PID=$!"',
    '    fi',
    '  else',
    '    echo "[openclaw][A/B][warn] 无旧版本可回退"',
    '  fi',
    '  echo "[openclaw][A/B] ❌ 更新失败且已回退，Gateway 健康检查超时"',
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

    const [gatewayHealthCodeText, gatewayRuntimePid, gatewayWatchdogRunning] = await Promise.all([
      runCommandTextAsync(LOCAL_GATEWAY_HEALTH_CHECK_CMD, 3000),
      runCommandTextAsync(gatewayPidCmd, 1200),
      runCommandOkAsync('pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1', 1200)
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
        appendInstallLog(activeInstallTask, `[openclaw] 检测到安装子进程已退出（pid=${taskPid}）且 ${silentSec}s 无输出，自动结束任务。\n`);
        activeInstallTask.status = 'failed';
        activeInstallTask.exitCode = Number.isFinite(activeInstallTask.exitCode) ? activeInstallTask.exitCode : -3;
        activeInstallTask.error = activeInstallTask.error || '安装子进程异常退出';
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
        appendInstallLog(activeInstallTask, `[openclaw] 检测到任务状态与操作锁不一致，已自动结束该任务（age=${ageSec}s）。\n`);
        activeInstallTask.status = 'failed';
        activeInstallTask.exitCode = Number.isFinite(activeInstallTask.exitCode) ? activeInstallTask.exitCode : -2;
        installTaskRunning = false;
        activeInstallTaskId = '';
        activeInstallTask = null;
      }
    }

    if (!runtimeReady && operationState.type === 'idle' && !installTaskRunning) {
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
    const detail = e?.message || String(e || '状态读取失败');
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
      // 触发 watchdog 重启 gateway
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
      hint = 'Gateway 正在启动中，请稍候片刻后再打开控制台。';
    } else if (authMode === 'token' && !rawToken) {
      hint = 'Gateway 为 token 模式但未读取到 token，已回退到代理地址。';
    } else if (authMode !== 'token' && authMode !== 'none') {
      hint = `Gateway 当前认证模式为 ${authMode}，可能需要在控制台中手动输入凭据。`;
    }

    // 检查 gateway 健康状态
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
      return res.status(404).json({ error: '没有可导出的数据文件' });
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
    console.error(`[migration-export] 导出失败: ${e?.message}`);
    if (!res.headersSent) res.status(500).json({ error: e?.message || '迁移导出失败' });
  }
});

// --- Migration Import (restore full data from migration archive) ---
app.post('/api/openclaw/migration/import', (req, res) => {
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/gzip') && !contentType.includes('application/octet-stream') && !contentType.includes('application/x-gzip') && !contentType.includes('application/x-tar')) {
      return res.status(400).json({ error: '请上传 .tar.gz 迁移包' });
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 20) return res.status(400).json({ error: '文件太小，无效的压缩包' });
        if (buf.length > 50 * 1024 * 1024) return res.status(400).json({ error: '文件太大（最大 50MB）' });
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
          return res.status(400).json({ error: '无效的迁移包（缺少 _migration-meta.json）' });
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
        console.log(`[migration-import] 迁移导入完成: ${restoredFiles.join(', ')}, 预备份: ${preImportBackup}`);
        res.json({ success: true, restoredFiles, preImportBackup, needRestart: true });
      } catch (e) {
        console.error(`[migration-import] 导入失败: ${e?.message}`);
        res.status(500).json({ error: e?.message || '迁移导入失败' });
      }
    });
  } catch (e) {
    console.error(`[migration-import] 导入失败: ${e?.message}`);
    res.status(500).json({ error: e?.message || '迁移导入失败' });
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
      version: 'openclaw-pro-config-v1'
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
    console.log(`[config-backup] 查询备份列表: ${backups.length} 个备份`);
    res.json({ success: true, backups });
  } catch (e) {
    console.error(`[config-backup] 读取备份列表失败: ${e?.message}`);
    res.status(500).json({ success: false, error: e?.message || '读取备份列表失败' });
  }
});

app.post('/api/openclaw/config/restore', (req, res) => {
  try {
    const name = sanitizeBackupFileName(req.body?.name);
    if (!name) return res.status(400).json({ success: false, error: '备份名无效' });

    console.log(`[config-restore] 开始恢复配置, 备份: ${name}, 请求文件: ${JSON.stringify(req.body?.files || '全部')}`);

    const backupPath = path.join(OPENCLAW_CONFIG_BACKUP_DIR, name);
    if (!backupPath.startsWith(`${OPENCLAW_CONFIG_BACKUP_DIR}/`) || !fs.existsSync(backupPath)) {
      console.warn(`[config-restore] 备份不存在: ${name}`);
      return res.status(404).json({ success: false, error: '备份不存在' });
    }

    // 要恢复的特定文件列表（空=全部）
    const requestedFiles = Array.isArray(req.body?.files) ? req.body.files : [];
    const restoredFiles = [];

    const stat = fs.statSync(backupPath);
    if (stat.isDirectory()) {
      // snapshot 目录：恢复选定的文件
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

        // 备份当前文件
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
        console.warn(`[config-restore] 备份 ${name} 中没有可恢复的文件`);
        return res.status(400).json({ success: false, error: '没有可恢复的文件' });
      }
    } else {
      // 旧格式：单个 JSON 文件恢复到 openclaw.json
      if (fs.existsSync(CONFIG_PATH)) {
        try {
          fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.before-restore.${Date.now()}.bak`);
        } catch {}
      }
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.copyFileSync(backupPath, CONFIG_PATH);
      restoredFiles.push(name);
    }

    console.log(`[config-restore] 恢复完成: ${name}, 已恢复文件: [${restoredFiles.join(', ')}]`);
    res.json({ success: true, restored: name, restoredFiles });
  } catch (e) {
    console.error(`[config-restore] 恢复失败: ${e?.message}`);
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

    const mode = resolveOpenClawInstallMode(req);
    const repo = resolveOpenClawSourceRepo(true);
    const release = await resolveLatestOpenClawInstallRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release, { mode });
    const taskId = runOpenClawTask(
      command,
      `安装 OpenClaw（mode=${mode}，仅 npm）(${release.tag})`,
      'installing',
      { release }
    );
    if (!taskId) {
      return res.status(409).json({ success: false, error: '任务创建失败：存在并发操作占用', operationState: getOpenClawOperationState() });
    }
    res.json({ success: true, taskId, mode, release: { repo: release.repo, tag: release.tag }, logFile: installLogs[taskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
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
  res.json({ ...task, operationType: task.operationType || 'installing', delta });
});

app.post('/api/openclaw/uninstall', (req, res) => {
  try {
    if (isTaskRunning(installLogs, activeInstallTaskId)) {
      return res.json({ success: true, taskId: activeInstallTaskId, reused: true, logFile: installLogs[activeInstallTaskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
    }
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle') {
      return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
    }
    const taskId = runOpenClawTask(buildOpenClawUninstallCommand(), '卸载 OpenClaw（移除 npm 全局包与本地源码目录）', 'uninstalling');
    if (!taskId) {
      return res.status(409).json({ success: false, error: '任务创建失败：存在并发操作占用', operationState: getOpenClawOperationState() });
    }
    res.json({ success: true, taskId, logFile: installLogs[taskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '卸载任务创建失败' });
  }
});

function buildOpenClawNpmInstallCommand(targetVersion) {
  const safeVersion = String(targetVersion || 'latest').replace(/[^a-zA-Z0-9._-]/g, '');
  const pkg = safeVersion === 'latest' ? 'openclaw@latest' : `openclaw@${safeVersion}`;
  return [
    'set -euo pipefail',
    'trap \'echo "[openclaw][error] 脚本异常退出 line=$LINENO exit=$?" >&2\' ERR',
    'echo "[openclaw][npm] A/B 隔离安装模式（Gateway 不中断）"',
    'for bin in node npm; do',
    '  if ! command -v "$bin" >/dev/null 2>&1; then',
    '    echo "[openclaw] 缺少镜像内依赖: $bin（请重新构建镜像，不在运行时安装系统依赖）"',
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
    '# 清理上次可能残留的 staging 目录',
    'rm -rf "$NEXT_SRC_DIR" "$STAGING_PREFIX" 2>/dev/null || true',
    'mkdir -p "$STAGING_PREFIX"',
    '# 选择 registry',
    'MIRROR_LATEST="$(npm view openclaw version --registry=https://registry.npmmirror.com 2>/dev/null || true)"',
    'NPMJS_LATEST="$(npm view openclaw version --registry=https://registry.npmjs.org 2>/dev/null || true)"',
    'INSTALL_REGISTRY="https://registry.npmmirror.com"',
    'if [ -n "$NPMJS_LATEST" ] && [ "$MIRROR_LATEST" != "$NPMJS_LATEST" ]; then',
    '  echo "[openclaw] 镜像最新(${MIRROR_LATEST:-unknown})落后于 npmjs(${NPMJS_LATEST})，直接使用 npmjs 源安装..."',
    '  INSTALL_REGISTRY="https://registry.npmjs.org"',
    'fi',
    'npm cache verify >/dev/null 2>&1 || true',
    '# --- npm install 到隔离 prefix (不影响运行中 Gateway) ---',
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
    `      OPENCLAW_NPM_LAST_ERROR="[openclaw][error] npm install 超时(900s): ${pkg}"`,
    '    else',
    '      tail_msg="$(tail -n 1 "$tmp_log" 2>/dev/null || true)"',
    '      [ -z "$tail_msg" ] && tail_msg="npm install exit=${rc}"',
    '      OPENCLAW_NPM_LAST_ERROR="[openclaw][error] npm install 失败(exit=${rc}): ${tail_msg}"',
    '    fi',
    '    echo "$OPENCLAW_NPM_LAST_ERROR"',
    '    echo "[openclaw] npm 失败日志: $tmp_log"',
    '    tail -n 80 "$tmp_log" 2>/dev/null || true',
    '    return "$rc"',
    '  fi',
    '  echo "[openclaw] ${label}: 安装成功"',
    '  return 0',
    '}',
    'if ! run_npm_staging_install "first_install" "$INSTALL_REGISTRY"; then',
    '  echo "[openclaw] npm install 首次失败，尝试清理并重试(npmjs)..."',
    '  npm cache verify >/dev/null 2>&1 || true',
    '  rm -rf "$STAGING_PREFIX" 2>/dev/null || true',
    '  mkdir -p "$STAGING_PREFIX"',
    '  if ! run_npm_staging_install "retry_install" "https://registry.npmjs.org"; then',
    '    [ -n "$OPENCLAW_NPM_LAST_ERROR" ] && echo "$OPENCLAW_NPM_LAST_ERROR"',
    '    rm -rf "$STAGING_PREFIX" 2>/dev/null || true',
    '    exit 31',
    '  fi',
    'fi',
    '# 验证 staging prefix 安装结果',
    'STAGING_LIB_DIR="$STAGING_PREFIX/lib/node_modules/openclaw"',
    'if [ ! -f "$STAGING_LIB_DIR/package.json" ]; then',
    '  echo "[openclaw][error] staging prefix 安装后 package.json 缺失"',
    '  rm -rf "$STAGING_PREFIX" 2>/dev/null || true',
    '  exit 31',
    'fi',
    '# 将 staging 目录移动到 NEXT_SRC_DIR 供 A/B swap 使用',
    'rm -rf "$NEXT_SRC_DIR" 2>/dev/null || true',
    'mv -f "$STAGING_LIB_DIR" "$NEXT_SRC_DIR"',
    '# 确保入口文件和兼容 symlink',
    'if [ ! -f "$NEXT_SRC_DIR/openclaw.mjs" ] && [ -f "$NEXT_SRC_DIR/dist/openclaw.mjs" ]; then',
    '  ln -sfn "$NEXT_SRC_DIR/dist/openclaw.mjs" "$NEXT_SRC_DIR/openclaw.mjs"',
    'fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.js" ] && [ -f "$NEXT_SRC_DIR/dist/index.js" ]; then ln -sfn index.js "$NEXT_SRC_DIR/dist/entry.js"; fi',
    'if [ ! -f "$NEXT_SRC_DIR/dist/entry.mjs" ] && [ -f "$NEXT_SRC_DIR/dist/index.mjs" ]; then ln -sfn index.mjs "$NEXT_SRC_DIR/dist/entry.mjs"; fi',
    '# 语法验证',
    'if [ -f "$NEXT_SRC_DIR/openclaw.mjs" ] && command -v node >/dev/null 2>&1; then',
    '  if ! node --check "$NEXT_SRC_DIR/openclaw.mjs" 2>/dev/null; then',
    '    echo "[openclaw][error] openclaw.mjs 语法检查失败"',
    '    rm -rf "$NEXT_SRC_DIR" "$STAGING_PREFIX" 2>/dev/null || true',
    '    exit 31',
    '  fi',
    'fi',
    '# 版本读取验证',
    'STAGED_VER="$(node -e "try{console.log(require(\\"/root/.openclaw/openclaw-source-next/package.json\\").version||\\"\\")}catch(e){}" 2>/dev/null || true)"',
    'echo "[openclaw] npm staging 安装完成: version=${STAGED_VER:-unknown}"',
    '# 清理 staging prefix',
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
      return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
    }

    const mode = resolveOpenClawInstallMode(req);
    const repo = resolveOpenClawSourceRepo(true);
    const release = await resolveLatestOpenClawInstallRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release, { mode });
    const taskId = runOpenClawTask(
      command,
      `更新 OpenClaw（mode=${mode}，仅 npm）(${release.tag})`,
      'updating',
      { release }
    );
    if (!taskId) {
      return res.status(409).json({ success: false, error: '任务创建失败：存在并发操作占用', operationState: getOpenClawOperationState() });
    }
    res.json({ success: true, taskId, mode, release: { repo: release.repo, tag: release.tag }, logFile: installLogs[taskId]?.logFile || OPENCLAW_INSTALL_LOG_FILE });
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

// --- 版本列表 API: 获取 npm 已发布版本供用户选择历史版本安装 ---
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
      return res.json({ success: true, versions: [], error: '无法获取版本列表' });
    }
    // 逆序 (最新在前)
    versions.reverse();
    const installed = getInstalledOpenClawVersion();
    res.json({ success: true, versions, installedVersion: installed || '' });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '获取版本列表失败' });
  }
});

// --- 安装指定版本 API ---
app.post('/api/openclaw/install-version', async (req, res) => {
  try {
    const version = String(req.body?.version || '').trim();
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
      return res.status(400).json({ success: false, error: '版本号格式无效' });
    }
    if (isTaskRunning(installLogs, activeInstallTaskId)) {
      return res.json({ success: true, taskId: activeInstallTaskId, reused: true });
    }
    const opState = getOpenClawOperationState();
    if (opState.type !== 'idle') {
      return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
    }

    const repo = resolveOpenClawSourceRepo(true);
    // 构造 release 对象 (指定版本使用 npm 源)
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
      `安装 OpenClaw v${version}（指定版本）`,
      'installing',
      { release }
    );
    if (!taskId) {
      return res.status(409).json({ success: false, error: '任务创建失败：存在并发操作占用' });
    }
    res.json({ success: true, taskId, version, release: { repo, tag } });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '安装任务创建失败' });
  }
});

app.post('/api/openclaw/start', (req, res) => {
  console.log('[openclaw][start] restart requested');
  const opState = getOpenClawOperationState();

  if (opState.type === 'restarting_gateway') {
    console.log('[openclaw][start] restart already in progress');
    return res.json({
      success: true,
      message: 'Gateway 重启已在进行中，请稍候',
      operationState: opState
    });
  }

  if (opState.type !== 'idle') {
    console.log(`[openclaw][start] blocked by operation state: ${opState.type}`);
    return res.status(409).json({ success: false, error: `操作进行中: ${opState.type}`, operationState: opState });
  }

  // 写入 operation.lock，让 watchdog 来执行重启
  queueGatewayRestart('openclaw-start');

  res.json({
    success: true,
    message: '重启请求已提交，watchdog 将在 10 秒内执行',
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
    res.status(500).json({ success: false, error: e?.message || '读取配对状态失败' });
  }
});

app.post('/api/openclaw/pairing/approve', async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId || typeof requestId !== 'string') return res.status(400).json({ success: false, error: '缺少 requestId' });
  if (!/^[0-9a-fA-F-]{8,64}$/.test(requestId)) return res.status(400).json({ success: false, error: 'requestId 格式无效' });
  try {
    const pending = readJson(DEVICE_PAIRING_PENDING_PATH, {});
    const entry = pending[requestId];
    if (!entry) return res.status(404).json({ success: false, error: '未找到该配对请求（可能已过期）' });

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
    res.status(500).json({ success: false, error: e?.message || '审批失败' });
  }
});

app.post('/api/openclaw/pairing/approve-discord', async (req, res) => {
  const rawCode = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!rawCode) return res.status(400).json({ success: false, error: '缺少配对码' });
  if (!/^[A-Z0-9]{6,32}$/.test(rawCode)) return res.status(400).json({ success: false, error: '配对码格式无效' });

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
      const errorText = lines[lines.length - 1] || 'Discord 配对审批失败';
      return res.status(500).json({ success: false, error: errorText, output });
    }

    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const message = lines[lines.length - 1] || `Discord 配对码 ${rawCode} 已批准`;
    res.json({ success: true, code: rawCode, message, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || 'Discord 配对审批失败' });
  }
});

app.get('/api/openclaw/gateway/logs', (req, res) => {
  try {
    const lines = Math.max(20, Math.min(parseInt(req.query.lines || String(LOG_VIEW_DEFAULT_LINES), 10) || LOG_VIEW_DEFAULT_LINES, OPENCLAW_GATEWAY_LOG_API_MAX_LINES));
    const logs = readOpenClawGatewayLogs(lines, { includeWatchdog: true, includeInstall: true });
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || '读取 Gateway 日志失败' });
  }
});

// ============================================================
// Logs: sanitize + tail
// ============================================================
function sanitizeLogLine(line) {
  if (typeof line !== 'string') return null;
  if (/让我获取 GitHub .*数据(?:并整理所有数据)?[:：]?/.test(line)) {
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
  // 过滤掉频繁的 webchat connected/disconnected 日志
  if (/\[ws\]\s+webchat\s+(connected|disconnected)/i.test(line)) {
    return null;
  }
  // 过滤掉高频 ws 消息日志（device.pair.list, node.list, chat.history, config.get 等）
  if (/\[ws\]\s+⇄\s+res\s+✓\s+(device\.pair\.list|node\.list|chat\.history|device\.list|config\.get)\b/.test(line)) {
    return null;
  }
  // 过滤掉高频成功 RPC 响应（节点探测 / skills 扫描会持续刷屏）
  if (/\[ws\]\s+⇄\s+res\s+✓\s+(skills\.bins|node\.invoke)\b/.test(line)) {
    return null;
  }
  // 过滤掉重复的 Discord 重连/TLS 错误日志（网络问题时极其频繁）
  if (/\[discord\]\s+gateway:\s+(WebSocket connection closed|Attempting resume with backoff)/i.test(line)) {
    return null;
  }
  if (/\[discord\]\s+gateway\s+error:\s+Error:\s+Client network socket disconnected/i.test(line)) {
    return null;
  }
  // 过滤掉 config reload 的重复 invalid config 行（已在 invalidConfigKeys 中检测）
  if (/\[reload\]\s+config reload skipped\s+\(invalid config\)/i.test(line)) {
    return null;
  }
  // 过滤掉飞书/Discord 等通道的收发消息日志（对话内容不应泄露到运维日志面板）
  if (/\[(feishu|discord|telegram|signal|whatsapp)\].*(?:received message from|DM from|dispatching to agent|group message from)/i.test(line)) {
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
          if (/\[install\].*(npm ERR!|npm WARN|\[openclaw\]\[(error|fatal)\]|failed|失败|timeout|超时|end status=failed)/i.test(t)) return true;
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
        '[logs] 当前尚未产生可展示日志。',
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
    if (fs.existsSync(path.join(candidate, 'skills')) && fs.existsSync(path.join(candidate, 'extensions'))) {
      return candidate;
    }
  }
  try {
    const npmRoot = execSync('npm root -g 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
    const candidate = path.join(npmRoot, 'openclaw');
    if (fs.existsSync(path.join(candidate, 'skills')) && fs.existsSync(path.join(candidate, 'extensions'))) return candidate;
  } catch {}
  // Fallback: common paths
  const fallbacks = ['/root/.npm-global/lib/node_modules/openclaw', '/usr/local/lib/node_modules/openclaw'];
  for (const f of fallbacks) {
    if (fs.existsSync(path.join(f, 'skills')) && fs.existsSync(path.join(f, 'extensions'))) return f;
  }
  return candidateRoots[0];
}
const OPENCLAW_PKG_ROOT = resolveOpenclawPkgRoot();
const OPENCLAW_BUNDLED_SKILLS_DIR = path.join(OPENCLAW_PKG_ROOT, 'skills');
const OPENCLAW_EXTENSIONS_DIR = path.join(OPENCLAW_PKG_ROOT, 'extensions');
const OPENCLAW_MANAGED_SKILLS_DIR = path.join(process.env.HOME || '/root', '.openclaw', 'skills');
const OPENCLAW_SKILLS_DIR = OPENCLAW_MANAGED_SKILLS_DIR; // install target = managed (~/.openclaw/skills/)
const SKILL_SCAN_TMP = '/tmp/openclaw-skill-scan';
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
      if (fs.existsSync(skillMd)) {
        const parsed = parseSkillMd(skillMd);
        if (parsed) {
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
      results.push({ name: e.name, description, path: skillDir, contentHash, source, securityWarnings, securityDetails });
    }
  } catch {}
  return results;
}

/** List all installed skills from bundled dir, extension skills, and managed dir */
function listUserSkills() {
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
    errors.push('缺少 SKILL.md 文件');
    return { valid: false, errors, warnings };
  }

  // 2. Check SKILL.md is valid markdown
  const parsed = parseSkillMd(skillMdPath);
  if (!parsed) {
    errors.push('SKILL.md 文件无法解析');
    return { valid: false, errors, warnings };
  }

  // 3. Check SKILL.md content for dangerous patterns
  for (const pat of SKILL_DANGEROUS_PATTERNS) {
    if (pat.test(parsed.content)) {
      warnings.push(`SKILL.md 包含可疑模式: ${pat.source}`);
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
      warnings.push(`目录包含过多文件 (>${SKILL_DIR_MAX_FILES})`);
    }

    // Check for suspicious file types
    const suspiciousExts = ['.sh', '.bash', '.py', '.js', '.ts', '.exe', '.bat', '.cmd', '.ps1', '.rb', '.pl'];
    for (const f of allFiles) {
      const ext = path.extname(f.name).toLowerCase();
      if (suspiciousExts.includes(ext)) {
        warnings.push(`包含脚本文件: ${f.name}`);
      }
      // Check for large binary files
      try {
        const fstat = fs.statSync(f.path);
        if (fstat.size > 5 * 1024 * 1024) {
          warnings.push(`大文件 (>${Math.round(fstat.size / 1024 / 1024)}MB): ${f.name}`);
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
            warnings.push(`${f.name} 包含可疑模式: ${pat.source}`);
            break;
          }
        }
      } catch {}
    }
  } catch (e) {
    warnings.push(`目录扫描异常: ${e.message}`);
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

app.get('/api/plugins/list', async (req, res) => {
  try {
    const [skills, extensions] = await Promise.all([
      Promise.resolve(listUserSkills()),
      listUserExtensions()
    ]);
    res.json({ skills, extensions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scan GitHub repo or local dir for available skills
app.post('/api/plugins/skill/scan', async (req, res) => {
  const { source, localPath } = req.body || {};
  if (!source || typeof source !== 'string') {
    return res.status(400).json({ error: '请提供 GitHub URL 或本地目录路径' });
  }

  const sanitized = source.trim();
  if (sanitized.length > 1000) {
    return res.status(400).json({ error: '输入过长' });
  }

  try {
    let scanDir;
    let isGitClone = false;

    // Determine if it's a GitHub/git URL or local path
    const isGitUrl = /^https?:\/\//.test(sanitized) || /^git@/.test(sanitized) || /\.git$/.test(sanitized);

    if (isGitUrl) {
      // Validate URL to prevent SSRF
      if (/[;&|`$(){}]/.test(sanitized)) {
        return res.status(400).json({ error: '无效的 URL' });
      }
      // Only allow github.com, gitlab.com, gitee.com
      try {
        const parsed = new URL(sanitized);
        const allowedHosts = ['github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org'];
        if (!allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
          return res.status(400).json({ error: `不支持的 Git 主机: ${parsed.hostname}。仅支持 GitHub/GitLab/Gitee/Bitbucket` });
        }
      } catch {
        return res.status(400).json({ error: '无效的 URL 格式' });
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
        return res.status(400).json({ error: '请提供绝对路径' });
      }
      // Block sensitive directories
      const blocked = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root/.ssh', '/root/.gnupg'];
      if (blocked.some(b => dirPath === b || dirPath.startsWith(b + '/'))) {
        return res.status(400).json({ error: '该目录不可扫描' });
      }
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        return res.status(400).json({ error: '目录不存在或不是一个目录' });
      }
      scanDir = dirPath;
    } else {
      return res.status(400).json({ error: '请提供有效的 GitHub URL 或本地目录路径' });
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
    res.status(500).json({ error: `扫描失败: ${e.message}` });
  }
});

// Install selected skills from scan results
app.post('/api/plugins/skill/install-selected', async (req, res) => {
  const { skills, source } = req.body || {};
  if (!Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: '请选择要安装的 Skills' });
  }

  // Ensure skills dir exists
  if (!fs.existsSync(OPENCLAW_SKILLS_DIR)) {
    fs.mkdirSync(OPENCLAW_SKILLS_DIR, { recursive: true });
  }

  const results = [];
  for (const skill of skills) {
    const { dirName, relPath, absPath } = skill;
    if (!dirName || typeof dirName !== 'string') {
      results.push({ name: dirName, success: false, error: '无效的 skill 名称' });
      continue;
    }

    // Safe name
    const safeName = path.basename(dirName);
    if (safeName !== dirName || dirName.includes('..')) {
      results.push({ name: dirName, success: false, error: '名称包含非法字符' });
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
        results.push({ name: safeName, success: false, error: '源目录不存在' });
        continue;
      }
    }

    // Final security check
    const check = validateSkillSecurity(srcPath);
    if (!check.valid) {
      results.push({ name: safeName, success: false, error: `安全检查失败: ${check.errors.join('; ')}` });
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
    return res.status(400).json({ error: '请选择要安装的 Skills' });
  }
  if (skills.length > 50) {
    return res.status(400).json({ error: '单次最多安装 50 个 Skills' });
  }

  if (!fs.existsSync(OPENCLAW_SKILLS_DIR)) {
    fs.mkdirSync(OPENCLAW_SKILLS_DIR, { recursive: true });
  }

  const results = [];
  for (const skill of skills) {
    const { dirName, files } = skill;
    if (!dirName || typeof dirName !== 'string') {
      results.push({ name: dirName || '?', success: false, error: '无效的 skill 名称' });
      continue;
    }
    const safeName = path.basename(dirName);
    if (safeName !== dirName || /[.]{2}/.test(dirName)) {
      results.push({ name: dirName, success: false, error: '名称包含非法字符' });
      continue;
    }
    if (!Array.isArray(files) || files.length === 0) {
      results.push({ name: safeName, success: false, error: '无文件内容' });
      continue;
    }
    if (!files.some(f => f.path === 'SKILL.md')) {
      results.push({ name: safeName, success: false, error: '缺少 SKILL.md 文件' });
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

// Legacy: direct install from git URL (backward compat)
app.post('/api/plugins/skill/install', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'missing url' });

  // Validate: must look like a git URL or simple name
  const sanitized = url.trim();
  if (sanitized.length > 500 || /[;&|`$(){}]/.test(sanitized)) {
    return res.status(400).json({ error: '无效的 URL' });
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
      return res.status(409).json({ error: `Skill "${skillName}" 已存在，请先移除再安装` });
    }

    const output = await runCommandTextAsync(
      `git clone --depth=1 ${JSON.stringify(sanitized)} ${JSON.stringify(dest)} 2>&1`,
      120000
    );
    // Verify SKILL.md exists
    const hasSkillMd = fs.existsSync(path.join(dest, 'SKILL.md'));
    res.json({
      success: true,
      output: output + (hasSkillMd ? '' : '\n⚠️ 注意: 该仓库中未找到 SKILL.md 文件')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plugins/skill/remove', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'missing name' });

  // Prevent path traversal
  const safeName = path.basename(name);
  if (safeName !== name || name.includes('..')) {
    return res.status(400).json({ error: '无效的名称' });
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
    return res.status(404).json({ error: `Skill "${safeName}" 不存在` });
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
  // Validate: npm package name, scoped name, github:user/repo, or https URL
  if (sanitized.length > 500 || /[;&|`$(){}\\]/.test(sanitized)) {
    return res.status(400).json({ error: '无效的包名或 URL' });
  }
  // Must be a recognized format
  const isNpmPkg = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^\s]*)?$/.test(sanitized);
  const isGithubShort = /^github:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(#.*)?$/.test(sanitized);
  const isGitUrl = /^https?:\/\/(github\.com|gitlab\.com|gitee\.com)\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git)?(\/?#.*)?$/.test(sanitized);
  if (!isNpmPkg && !isGithubShort && !isGitUrl) {
    return res.status(400).json({ error: '请输入 npm 包名（如 @anthropic/extension）、github:user/repo 或 GitHub URL' });
  }

  try {
    const output = await runCommandTextAsync(
      `npm install -g ${JSON.stringify(sanitized)} 2>&1`,
      120000
    );
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plugins/extension/remove', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'missing name' });

  const sanitized = name.trim();
  if (sanitized.length > 200 || /[;&|`$(){}]/.test(sanitized)) {
    return res.status(400).json({ error: '无效的名称' });
  }

  try {
    const output = await runCommandTextAsync(
      `npm uninstall -g ${JSON.stringify(sanitized)} 2>&1`,
      60000
    );
    res.json({ success: true, output });
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
      sendOutput('OpenClaw Terminal connected (fallback shell). 输入命令并回车执行。\n');
      sendOutput('[terminal] 当前环境未检测到 script，已使用兼容模式。\n');
    }

    // 捕获 stdin 错误避免崩溃
    shell.stdin.on('error', (err) => {
      // 忽略 EPIPE
    });

    shell.stdout.on('data', (chunk) => sendOutput(chunk.toString('utf8')));
    shell.stdout.on('error', () => {}); // 防崩溃
    
    if (mode !== 'pty' && shell.stderr) {
      shell.stderr.on('data', (chunk) => sendOutput(chunk.toString('utf8')));
      shell.stderr.on('error', () => {}); // 防崩溃
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
  checkOrphanInstallTask(); // C7: 启动时检测孤儿安装进程 (DFMEA T2)
  console.log(`[web] OpenClaw Web 管理面板启动: http://0.0.0.0:${PORT}`);

  // Browser Bridge 现通过 Caddy WSS 代理（主 HTTPS 端口），不再需要独立端口
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[web][error] 端口 ${PORT} 已被占用，疑似重复启动 web-panel，请先停止旧进程后再启动。`);
  } else {
    console.error(`[web][error] Web 面板启动失败: ${err?.message || err}`);
  }
  process.exit(1);
});
