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
    const timeout = setTimeout(() => controller.abort(), options.timeout || 30000);
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
const BROWSER_PAIRS_PATH = '/root/.openclaw/browser-pairs.json';
const DEVICE_PAIRING_PENDING_PATH = '/root/.openclaw/devices/pending.json';
const DEVICE_PAIRING_PAIRED_PATH = '/root/.openclaw/devices/paired.json';

const TRADING_DIR = '/root/trading-system';
const STRATEGY_PARAMS_PATH = path.join(TRADING_DIR, 'strategy_params.json');

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
    return JSON.parse(fs.readFileSync(p, 'utf8'));
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
  const catalogPath = '/root/.npm-global/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/models.generated.js';
  try {
    if (!fs.existsSync(catalogPath.replace('/dist/models.generated.js', ''))) {
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

/**
 * 从 OpenClaw 内置目录查询模型能力
 * @param {string} providerName - 我们的 provider 名称 (如 'gemini', 'bailian')
 * @param {string} modelId - 模型 ID (如 'gemini-3-flash-preview')
 * @returns {object|null} 模型能力定义，或 null（未找到时）
 */
function lookupModelCapabilities(providerName, modelId) {
  if (!_openclawModelCatalog) return null;

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

  if (catalogEntry) {
    const isInferred = catalogEntry._inferred;
    const safeApi = sanitizeApiValue(catalogEntry.api, providerName) || 'openai-completions';
    if (safeApi !== catalogEntry.api) {
      console.log(`[catalog] 模型 ${providerName}/${modelId} api 值 "${catalogEntry.api}" 不被 gateway 支持，映射为 "${safeApi}"`);
    }
    if (isInferred) {
      console.log(`[catalog] 模型 ${providerName}/${modelId} 家族匹配成功 (${catalogEntry._matchedFamily})，推测使用同家族参数: reasoning=${catalogEntry.reasoning}, api=${safeApi}, ctx=${catalogEntry.contextWindow}`);
    } else {
      console.log(`[catalog] 模型 ${providerName}/${modelId} 命中内置目录: reasoning=${catalogEntry.reasoning}, api=${safeApi}, ctx=${catalogEntry.contextWindow}`);
    }
    return {
      id: modelId,
      name: isInferred ? modelId : (catalogEntry.name || modelId),
      api: safeApi,
      ...(catalogEntry.headers ? { headers: catalogEntry.headers } : {}),
      reasoning: catalogEntry.reasoning ?? false,
      input: catalogEntry.input || ['text'],
      cost: catalogEntry.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: catalogEntry.contextWindow || 128000,
      maxTokens: catalogEntry.maxTokens || 4096,
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

    const { execFileSync } = require('child_process');

    const url = `${endpoint}/chat/completions`;
    const authHeader = provider === 'anthropic' ? 'x-api-key' : 'Authorization';
    const authValue = provider === 'anthropic' ? apiKey : `Bearer ${apiKey}`;

    const body = JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5
    });

    // execFileSync 以数组传参，不经过 shell，杜绝命令注入
    const args = [
      '-sS', '--connect-timeout', '10', '--max-time', '20',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `${authHeader}: ${authValue}`,
      '-d', body,
      '-w', '\n%{http_code}',
      url
    ];

    const result = execFileSync('curl', args, {
      encoding: 'utf8',
      timeout: 30000,
      env: process.env
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
    const resolveProviderSyncApi = (provName, fallbackApi) => {
      if (provName === 'github-copilot') return 'github-copilot';
      return sanitizeApiValue(fallbackApi, provName) || fallbackApi;
    };
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
      // 如果 catalog 指示不同的 api 类型，同步更新 provider 级别的 api
      const syncedProviderApi = resolveProviderSyncApi(provName, entry.api);
      if (syncedProviderApi && prov.api && syncedProviderApi !== prov.api) {
        console.log(`[sync] 更新 provider ${provName}.api: ${prov.api} → ${syncedProviderApi} (来自模型目录)`);
        prov.api = syncedProviderApi;
        configChanged = true;
        // 同步更新该 provider 下已有模型的 api 字段（保持一致性）
        for (const m of prov.models) {
          if (m.api && m.api !== entry.api) {
            // 查询 catalog 确认该模型的原生 api
            const mCap = lookupModelCapabilities(provName, m.id);
            const correctApi = sanitizeApiValue(mCap?.api, provName) || entry.api;
            if (m.api !== correctApi) {
              console.log(`[sync] 同步 ${provName}/${m.id}.api: ${m.api} → ${correctApi}`);
              m.api = correctApi;
              configChanged = true;
            }
          }
        }
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
          // 同步 provider 级别的 api
          const syncedProviderApi = resolveProviderSyncApi(provName, entry.api);
          if (syncedProviderApi && prov.api && syncedProviderApi !== prov.api) {
            prov.api = syncedProviderApi;
            modelsChanged = true;
            // 同步更新该 provider 下已有模型的 api 字段
            for (const m of prov.models) {
              if (m.api && m.api !== entry.api) {
                const mCap = lookupModelCapabilities(provName, m.id);
                const correctApi = sanitizeApiValue(mCap?.api, provName) || entry.api;
                if (m.api !== correctApi) {
                  m.api = correctApi;
                  modelsChanged = true;
                }
              }
            }
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
    // C10: extract task= and elapsed= independently (they may appear in either order)
    if (!inferredTs) {
      const taskIdMatch = normalized.match(/\btask=([^\s]+)/i);
      const elapsedMatch = normalized.match(/\belapsed=(\d+)s/i)
        || normalized.match(/安装进行中[.…]*\s*(\d+)s/);
      if (taskIdMatch?.[1] && elapsedMatch?.[1]) {
        const baseTs = taskStartTs.get(taskIdMatch[1]);
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
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

const OPENCLAW_INSTALL_MODES = new Set(['auto', 'release', 'npm', 'source']);

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
  let sourceEntryOk = runCommandOk(`test -f "${sourceEntry}"`, 1200);
  let runtimeEntryOk = runCommandOk(`test -f "${distEntryJs}" || test -f "${distEntryMjs}" || test -f "${distIndexJs}" || test -f "${distIndexMjs}"`, 1200);
  let npmBinaryOk = runCommandOk('command -v openclaw >/dev/null 2>&1 || test -x /root/.npm-global/bin/openclaw || test -x /usr/local/bin/openclaw || test -x /usr/bin/openclaw || test -x /opt/homebrew/bin/openclaw', 1200);
  if (!sourceEntryOk || !runtimeEntryOk || !npmBinaryOk) {
    runCommandText('sleep 0.35', 1200);
    sourceEntryOk = sourceEntryOk || runCommandOk(`test -f "${sourceEntry}"`, 1200);
    runtimeEntryOk = runtimeEntryOk || runCommandOk(`test -f "${distEntryJs}" || test -f "${distEntryMjs}" || test -f "${distIndexJs}" || test -f "${distIndexMjs}"`, 1200);
    npmBinaryOk = npmBinaryOk || runCommandOk('command -v openclaw >/dev/null 2>&1 || test -x /root/.npm-global/bin/openclaw || test -x /usr/local/bin/openclaw || test -x /usr/bin/openclaw || test -x /opt/homebrew/bin/openclaw', 1200);
  }
  const ok = npmBinaryOk || (sourceEntryOk && runtimeEntryOk);
  let issue = '';
  if (!ok) {
    if (!sourceEntryOk && !npmBinaryOk && !runtimeEntryOk) issue = 'missing-source-binary-and-runtime-entry';
    else if (!sourceEntryOk && !npmBinaryOk) issue = 'missing-source-and-binary-entry';
    else if (!runtimeEntryOk) issue = 'missing-runtime-entry';
  }
  let runtimeEntry = '';
  if (runCommandOk(`test -f "${distEntryJs}"`, 800)) runtimeEntry = distEntryJs;
  else if (runCommandOk(`test -f "${distEntryMjs}"`, 800)) runtimeEntry = distEntryMjs;
  else if (runCommandOk(`test -f "${distIndexJs}"`, 800)) runtimeEntry = distIndexJs;
  else if (runCommandOk(`test -f "${distIndexMjs}"`, 800)) runtimeEntry = distIndexMjs;
  return {
    ok,
    issue,
    sourceEntry,
    distEntry: runtimeEntry,
    npmBinary: runCommandText('command -v openclaw 2>/dev/null || true', 1000) || (npmBinaryOk ? '/root/.npm-global/bin/openclaw' : '')
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
    const release = await getLatestOpenClawRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release);
    const taskId = runOpenClawTask(
      command,
      `检测到运行入口缺失(${openClawRuntimeRecoveryState.lastIssue})，自动执行安装恢复（官方 npm 优先 → GitHub Linux 包 → 源码兜底）(${release.tag})`,
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
  const rel = await getLatestOpenClawRelease(repo);
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
    const rel = await getLatestOpenClawRelease(repo);
    const version = parseOpenClawVersion(rel?.tag || '');
    latestOpenClawVersionCache.hasLinuxBinaryAsset = !!(rel?.binaryAsset && rel.binaryAsset.source !== 'npm-dist-tarball');
    latestOpenClawVersionCache.assetsSummary = Array.isArray(rel?.assets)
      ? rel.assets.slice(0, 10).map((item) => String(item?.name || '').trim()).filter(Boolean).join(', ')
      : '';
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

      if (checkedRef && result.dockerfileChanged && !_dockerfileChangeLogged) {
        console.log(`[update] Dockerfile changed: local hash differs from ref ${checkedRef}`);
        _dockerfileChangeLogged = true;
      }
    } catch {}

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

    // Update version file ONLY if ALL files were successfully updated (no failures)
    if (hotpatchState.failed.length > 0) {
      log(`⚠️ 版本号未更新: ${hotpatchState.failed.length} 个文件更新失败，请检查网络或 GitHub 访问`);
      hotpatchState.status = 'error';
      return;
    } else if (hotpatchState.updated.length > 0) {
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
        }
      } catch {}
    } else {
      log(`版本号未更新: 无文件变更`);
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

  const gatewayLogTail = readGatewayLogTail(220);
  // Run shell checks in parallel (async) to avoid blocking the event loop
  const [gatewayHealthCodeText, gatewayRuntimePid, portListening, caddyRunning, watchdogRunning] = await Promise.all([
    runCommandTextAsync(LOCAL_GATEWAY_HEALTH_CHECK_CMD, 3000),
    Promise.resolve(getGatewayRuntimePid()),
    runCommandOkAsync('ss -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]" || netstat -ltn 2>/dev/null | grep -q "[:.]18789[[:space:]]"', 1200),
    runCommandOkAsync('pgrep -f caddy >/dev/null 2>&1 || ss -ltn 2>/dev/null | grep -q ":443 " || netstat -ltn 2>/dev/null | grep -q ":443 "', 1200),
    runCommandOkAsync('pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1', 1200),
  ]);
  const gatewayHealthCode = Number.parseInt(String(gatewayHealthCodeText || '').trim(), 10) || 0;
  const gatewayPidSafe = Number.parseInt(String(gatewayRuntimePid || '').trim(), 10) || 0;
  const gatewayProcessRunning = isGatewayRuntimeProcessRunning() || portListening;
  const gatewayProcessUptimeSec = gatewayPidSafe > 0
    ? Number.parseInt(String(await runCommandTextAsync(`ps -o etimes= -p ${gatewayPidSafe} 2>/dev/null || true`, 1200) || '').trim(), 10) || 0
    : 0;
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
// API: browser bridge (远端浏览器插件控制)
// ============================================================
const BROWSER_CONTROL_PORT = 18791;

function readBrowserPairs() {
  return readJson(BROWSER_PAIRS_PATH, { pairs: [], pairCodes: [] });
}

function writeBrowserPairs(data) {
  writeJson(BROWSER_PAIRS_PATH, data);
}

// 已连接的浏览器扩展: Map<pairCode, { ws, name, connectedAt, lastPing }>
const browserBridgeClients = new Map();

// 生成配对码 (6位大写字母数字)
function generatePairCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符 I,O,0,1
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.get('/api/browser/config', async (req, res) => {
  try {
    const config = readJson(CONFIG_PATH, {});
    const pairsData = readBrowserPairs();
    const browserCfg = config.browser || {};
    const sandboxEnabled = !!(config.agents?.defaults?.sandbox?.browser?.enabled);

    // 探测 gateway browser control 状态
    let gatewayBrowser = { listening: false, version: '' };
    try {
      const versionJson = runCommandText(
        `curl -sf --max-time 3 http://127.0.0.1:${BROWSER_CONTROL_PORT}/json/version 2>/dev/null`,
        5000
      );
      if (versionJson) {
        const v = JSON.parse(versionJson);
        gatewayBrowser = { listening: true, version: v.Browser || v.browser || '' };
      }
    } catch {}
    if (!gatewayBrowser.listening) {
      gatewayBrowser.listening = runCommandOk(
        `curl -sf --max-time 2 -o /dev/null http://127.0.0.1:${BROWSER_CONTROL_PORT}/ 2>/dev/null`,
        4000
      );
    }

    // 在线扩展列表
    const connectedBrowsers = [];
    for (const [code, client] of browserBridgeClients) {
      connectedBrowsers.push({
        pairCode: code,
        name: client.name || code,
        connectedAt: client.connectedAt,
        lastPing: client.lastPing
      });
    }

    // 已注册的配对码
    const pairCodes = pairsData.pairCodes || [];

    res.json({
      browser: browserCfg,
      sandboxEnabled,
      gatewayBrowser,
      pairCodes,
      connectedBrowsers
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 生成新配对码
app.post('/api/browser/pair-code', async (req, res) => {
  try {
    const { name } = req.body || {};
    const code = generatePairCode();
    const pairsData = readBrowserPairs();
    if (!pairsData.pairCodes) pairsData.pairCodes = [];
    pairsData.pairCodes.push({
      code,
      name: String(name || '').trim() || '新设备',
      createdAt: new Date().toISOString()
    });
    writeBrowserPairs(pairsData);
    res.json({ success: true, code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除配对码
app.delete('/api/browser/pair-code/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const pairsData = readBrowserPairs();
    pairsData.pairCodes = (pairsData.pairCodes || []).filter(p => p.code !== code);
    writeBrowserPairs(pairsData);
    // 如果已连接则断开
    const client = browserBridgeClients.get(code);
    if (client) {
      try { client.ws.close(1000, 'pair code deleted'); } catch {}
      browserBridgeClients.delete(code);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新浏览器启用配置
app.post('/api/browser/config', async (req, res) => {
  try {
    const { browserEnabled, sandboxEnabled } = req.body || {};
    const config = readJson(CONFIG_PATH, {});
    if (typeof browserEnabled === 'boolean') {
      if (!config.browser) config.browser = {};
      config.browser.enabled = browserEnabled;
    }
    if (typeof sandboxEnabled === 'boolean') {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.sandbox) config.agents.defaults.sandbox = {};
      if (!config.agents.defaults.sandbox.browser) config.agents.defaults.sandbox.browser = {};
      config.agents.defaults.sandbox.browser.enabled = sandboxEnabled;
    }
    writeOpenClawConfig(config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 向已连接的浏览器扩展发送测试命令
app.post('/api/browser/test', async (req, res) => {
  try {
    const { pairCode } = req.body || {};
    if (!pairCode) return res.status(400).json({ error: '缺少 pairCode' });
    const client = browserBridgeClients.get(pairCode);
    if (!client) return res.json({ reachable: false, error: '该设备未在线' });

    // 向扩展发送 list-targets 命令并等待回复
    const requestId = `test-${Date.now()}`;
    const p = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client._pendingRequests?.delete(requestId);
        resolve({ reachable: false, error: '扩展响应超时' });
      }, 8000);
      if (!client._pendingRequests) client._pendingRequests = new Map();
      client._pendingRequests.set(requestId, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });
    try {
      client.ws.send(JSON.stringify({ type: 'list-targets', requestId }));
    } catch (e) {
      return res.json({ reachable: false, error: '发送命令失败: ' + e.message });
    }
    const result = await p;
    if (result.reachable === false) return res.json(result);
    return res.json({ reachable: true, targets: result.targets || [], name: client.name });
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
    const allModelsToSave = [];
    if (primaryModel) allModelsToSave.push({ model: primaryModel, role: '主模型' });
    if (subModel) allModelsToSave.push({ model: subModel, role: '子代理模型' });
    if (fallbacks) {
      const addFb = (arr, label) => {
        if (!Array.isArray(arr)) return;
        arr.filter(Boolean).forEach(m => allModelsToSave.push({ model: m, role: label }));
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
    for (const { model, role } of allModelsToSave) {
      if (!model || !model.includes('/')) continue;
      // 已存在于当前配置中的模型跳过验证
      if (existingModels.has(model)) continue;
      const [prov] = model.split('/');
      // 检查 provider 是否有有效 key
      if (!validProviders.has(prov)) {
        errors.push(`${role} "${model}" 的 provider "${prov}" 没有配置有效的 API Key 或授权，请先添加`);
      }
      // 检查模型是否在目录中被支持
      const [provName, modId] = model.split('/');
      const catalogHit = lookupModelCapabilities(provName, modId);

      if (!catalogHit) {
        // 完全未找到 - 可能是全新模型或拼写错误
        errors.push(`${role} "${model}" 未在 OpenClaw 模型目录中找到，请确认模型名称是否正确`);
      } else if (catalogHit._inferred) {
        // 家族前缀匹配成功（推测匹配）- 需要进行运行时验证
        console.log(`[ai/config] ${model} 家族匹配成功 (${catalogHit._matchedFamily})，将进行运行时验证...`);

        // 获取该 provider 的 API Key 和 baseUrl
        let modelApiKey = '';
        let modelBaseUrl = '';
        try {
          const modelsCfg = readAiModels();
          modelApiKey = modelsCfg.providers?.[provName]?.apiKey || '';
          modelBaseUrl = modelsCfg.providers?.[provName]?.baseUrl || '';
        } catch {}

        // 如果没有找到 key，尝试从 auth-profiles 获取
        if (!modelApiKey) {
          for (const [, profile] of Object.entries(authProfiles.profiles || {})) {
            if (profile.provider === provName) {
              modelApiKey = getAuthProfileSecret(profile) || '';
              break;
            }
          }
        }

        if (!modelApiKey || modelApiKey === 'YOUR_API_KEY') {
          errors.push(`${role} "${model}" 需要进行运行时验证，但 ${provName} 没有配置有效的 API Key`);
        } else {
          // 异步测试模型可用性
          const testResult = await testModelAvailability(provName, modId, modelApiKey, modelBaseUrl);
          if (!testResult.available) {
            errors.push(`${role} "${model}" 运行时验证失败: ${testResult.error || '模型不可用'}`);
          } else {
            console.log(`[ai/config] ${model} 运行时验证成功，允许配置`);
          }
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
      if (!target[provName]) return; // provider 不存在则跳过
      if (!target[provName].models) target[provName].models = [];
      const existingIdx = target[provName].models.findIndex(m => m.id === modId);
      const entry = buildModelEntry(provName, modId);
      if (existingIdx === -1) {
        target[provName].models.push(entry);
      } else {
        // 已存在时更新关键字段
        const existing = target[provName].models[existingIdx];
        for (const field of ['name', 'api', 'headers', 'reasoning', 'contextWindow', 'maxTokens', 'input', 'compat', 'cost']) {
          if (entry[field] !== undefined) existing[field] = entry[field];
        }
      }
      // 同步 provider 级别的 api（仅当新值是 gateway 合法值时才更新）
      if (entry.api && target[provName].api && entry.api !== target[provName].api) {
        const safeProvApi = sanitizeApiValue(entry.api, provName);
        const desiredProvApi = provName === 'github-copilot' ? 'github-copilot' : safeProvApi;
        if (desiredProvApi && desiredProvApi !== target[provName].api) {
          console.log(`[ensureModelEntry] 更新 provider ${provName}.api: ${target[provName].api} → ${desiredProvApi}`);
          target[provName].api = desiredProvApi;
        }
      }
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
        const src = models.providers[provName] || {};
        config.models.providers[provName] = {
          baseUrl: src.baseUrl || getDefaultBaseUrl(provName),
          api: src.api || 'openai-completions',
          models: []
        };
        // 复制 apiKey（如果 models.json 中有有效的）
        if (src.apiKey && src.apiKey !== 'YOUR_API_KEY') {
          config.models.providers[provName].apiKey = src.apiKey;
        }
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

    // Gateway 会自动检测 config 变更并热加载，无需手动重启
    console.log('[ai/config] 模型配置已保存，Gateway 将自动热加载');
    res.json({ success: true, message: '模型配置已保存，Gateway 将自动热加载新配置' });
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
      // C3: 确保 watchdog 存活后再提交 gateway 重启 (DFMEA G1)
      ensureGatewayWatchdog((wdErr) => {
        if (wdErr) {
          appendInstallLog(task, `[openclaw][warn] ensureGatewayWatchdog 失败: ${wdErr.message}\n`);
        }
      });
      const restartState = queueGatewayRestart(`${operationType}-complete`, taskId);
      task.gatewayRestartQueued = true;
      task.gatewayRestartState = restartState;
      appendInstallLog(task, `[openclaw] ${opLabel}完成，已提交 Gateway 自动重启请求。\n`);
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
  restarting_gateway: 480,
  repairing_config: 900
};
// C9: Grace period must exceed watchdog CHECK_INTERVAL (10s) to avoid race condition
// where the reconcile clears the restarting_gateway lock before the watchdog polls it.
// Previously 5s — caused the watchdog to never see restart requests (DFMEA O4).
const OPENCLAW_RESTART_RECONCILE_GRACE_SEC = 30;

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
    'rm -rf "$PERSIST_SRC_DIR"',
    'mv -Tf "$STAGE_SRC_DIR" "$PERSIST_SRC_DIR"',
    'ln -sfn "$PERSIST_SRC_DIR" "$SRC_DIR"',
    'if [ ! -f "$SRC_DIR/openclaw.mjs" ] && [ -f "$SRC_DIR/dist/openclaw.mjs" ]; then ln -sf "$SRC_DIR/dist/openclaw.mjs" "$SRC_DIR/openclaw.mjs"; fi',
    'if [ ! -f "$SRC_DIR/openclaw.mjs" ]; then echo "[openclaw] 编译产物缺失: $SRC_DIR/openclaw.mjs"; exit 4; fi',
    'if [ ! -f "$SRC_DIR/dist/entry.js" ] && [ -f "$SRC_DIR/dist/index.js" ]; then ln -sfn index.js "$SRC_DIR/dist/entry.js"; fi',
    'if [ ! -f "$SRC_DIR/dist/entry.mjs" ] && [ -f "$SRC_DIR/dist/index.mjs" ]; then ln -sfn index.mjs "$SRC_DIR/dist/entry.mjs"; fi',
    'if [ ! -f "$SRC_DIR/dist/entry.js" ] && [ ! -f "$SRC_DIR/dist/entry.mjs" ] && [ ! -f "$SRC_DIR/dist/index.js" ] && [ ! -f "$SRC_DIR/dist/index.mjs" ]; then echo "[openclaw] 编译产物缺失: $SRC_DIR/dist/entry|index.(m)js"; exit 4; fi',
    'mkdir -p /root/.openclaw',
    'printf "{\\n  \\\"repo\\\": \\\"%s\\\",\\n  \\\"tag\\\": \\\"%s\\\",\\n  \\\"tarballUrl\\\": \\\"%s\\\",\\n  \\\"installedAt\\\": \\\"%s\\\"\\n}\\n" "$OPENCLAW_REPO" "$OPENCLAW_TAG" "$OPENCLAW_TARBALL_URL" "$(date -Iseconds)" > /root/.openclaw/openclaw-source-install.json',
    'echo "[openclaw] source build install completed: $OPENCLAW_REPO@$OPENCLAW_TAG"',
    'node "$SRC_DIR/openclaw.mjs" --version 2>/dev/null || node "$SRC_DIR/openclaw.mjs" -v 2>/dev/null || true'
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
    'echo "[openclaw] 安装编译包到持久目录: $PERSIST_SRC_DIR"',
    'STAGE_PERSIST_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source.asset.stage.$$"',
    'rm -rf "$STAGE_PERSIST_SRC_DIR" "$PERSIST_SRC_DIR"',
    'mkdir -p "$(dirname "$STAGE_PERSIST_SRC_DIR")"',
    'mv -Tf "$ASSET_ROOT" "$STAGE_PERSIST_SRC_DIR"',
    'mv -Tf "$STAGE_PERSIST_SRC_DIR" "$PERSIST_SRC_DIR"',
    'ln -sfn "$PERSIST_SRC_DIR" "$WORK_SRC_DIR"',
    'printf "{\\n  \\\"repo\\\": \\\"%s\\\",\\n  \\\"tag\\\": \\\"%s\\\",\\n  \\\"assetName\\\": \\\"%s\\\",\\n  \\\"assetUrl\\\": \\\"%s\\\",\\n  \\\"installedAt\\\": \\\"%s\\\"\\n}\\n" "$OPENCLAW_REPO" "$OPENCLAW_TAG" "$OPENCLAW_ASSET_NAME" "$OPENCLAW_ASSET_URL" "$(date -Iseconds)" > /root/.openclaw/openclaw-source-install.json',
    'echo "[openclaw] release 资产安装完成: $OPENCLAW_ASSET_NAME"',
    'node "$PERSIST_SRC_DIR/openclaw.mjs" --version 2>/dev/null || node "$PERSIST_SRC_DIR/openclaw.mjs" -v 2>/dev/null || true'
  ].join('\n');
}

function buildOpenClawPreferredInstallCommand(release, options = {}) {
  const mode = normalizeOpenClawInstallMode(options?.mode || process.env.OPENCLAW_INSTALL_MODE || 'auto');
  const assetCmd = buildOpenClawReleaseAssetInstallCommand(release);
  const safeAssetCmd = assetCmd || 'false';
  const npmCmd = buildOpenClawNpmInstallCommand();
  const sourceCmd = buildOpenClawSourceInstallCommand(release);
  const selectedAsset = String(release?.binaryAsset?.name || '').trim();
  const selectedAssetSource = String(release?.binaryAsset?.source || 'github-release').trim() || 'github-release';
  const selectedAssetSizeMb = Number(release?.binaryAsset?.size || 0) > 0
    ? Math.ceil(Number(release.binaryAsset.size || 0) / (1024 * 1024))
    : 0;
  const selectedAssetInfo = selectedAsset
    ? `${selectedAsset}${selectedAssetSizeMb > 0 ? ` (${selectedAssetSizeMb}MB)` : ''}`
    : 'none';
  const assetsBrief = Array.isArray(release?.assets)
    ? release.assets.slice(0, 10).map((item) => {
      const name = String(item?.name || '').trim();
      const sizeMb = Number(item?.size || 0) > 0 ? Math.ceil(Number(item.size || 0) / (1024 * 1024)) : 0;
      return name ? `${name}${sizeMb > 0 ? `(${sizeMb}MB)` : ''}` : '';
    }).filter(Boolean).join(', ')
    : '';

  const safeMode = String(mode || 'auto').replace(/"/g, '');
  const safeTag = String(release?.tag || '').replace(/"/g, '');
  const safeAssetSource = selectedAssetSource.replace(/"/g, '');
  const safeAssetInfo = selectedAssetInfo.replace(/"/g, '');
  const safeAssetsBrief = String(assetsBrief || 'none').replace(/"/g, '');

  const releaseModeBlock = [
    'if [ "$HAS_RELEASE_ASSET" != "1" ]; then',
    '  echo "[openclaw][error] release 模式要求可用编译包，但当前未检测到（assets=${RELEASE_ASSETS_BRIEF}）"',
    '  exit 41',
    'fi',
    'if (',
    safeAssetCmd,
    '); then',
    '  if runtime_ready_and_latest; then',
    '    echo "[openclaw] release 模式安装完成并校验通过。"',
    '  else',
    '    echo "[openclaw][error] release 模式安装后版本或入口校验失败。"',
    '    exit 42',
    '  fi',
    'else',
    '  rc=$?',
    '  echo "[openclaw][error] release 模式安装失败(exit=${rc})"',
    '  exit "$rc"',
    'fi'
  ].join('\n');

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

  const sourceModeBlock = [
    sourceCmd,
    'if runtime_ready_and_latest; then',
    '  echo "[openclaw] source 模式安装完成并校验通过。"',
    'else',
    '  echo "[openclaw][error] source 模式安装后版本或入口校验失败。"',
    '  exit 44',
    'fi'
  ].join('\n');

  const autoModeBlock = [
    'if runtime_ready_and_latest; then',
    '  echo "[openclaw] 当前运行版本已满足目标版本，跳过安装。"',
    '  exit 0',
    'fi',
    'AUTO_DONE=0',
    'echo "[openclaw] 自动模式：先尝试官方 npm 安装..."',
    'if (',
    npmCmd,
    '); then',
    '  rm -f /root/.openclaw/openclaw-source-install.json >/dev/null 2>&1 || true',
    '  if runtime_ready_and_latest; then',
    '    echo "[openclaw] npm 路径成功。"',
    '    AUTO_DONE=1',
    '  else',
    '    echo "[openclaw] npm 路径后校验未通过，继续尝试 release 预构建包。"',
    '  fi',
    'else',
    '  rc=$?',
    '  echo "[openclaw] npm 路径失败(exit=${rc})，继续尝试 release 预构建包。"',
    'fi',
    'if [ "$AUTO_DONE" != "1" ] && [ "$HAS_RELEASE_ASSET" = "1" ]; then',
    '  echo "[openclaw] 自动模式：尝试 release 预构建包..."',
    '  if (',
    safeAssetCmd,
    '  ); then',
    '    if runtime_ready_and_latest; then',
    '      echo "[openclaw] release 路径成功。"',
    '      AUTO_DONE=1',
    '    else',
    '      echo "[openclaw] release 路径未达到目标版本或入口不完整，回退源码构建安装..."',
    '    fi',
    '  else',
    '    rc=$?',
    '    echo "[openclaw] release 路径失败(exit=${rc})，回退源码构建安装..."',
    '  fi',
    'elif [ "$AUTO_DONE" != "1" ]; then',
    '  echo "[openclaw] 自动模式：未检测到 GitHub Linux 资产，跳过 release，转入源码构建安装。"',
    'fi',
    'if [ "$AUTO_DONE" != "1" ]; then',
    '  echo "[openclaw] 自动模式：执行源码构建安装..."',
    sourceCmd,
    '  if runtime_ready_and_latest; then',
    '    echo "[openclaw] source 路径成功。"',
    '    AUTO_DONE=1',
    '  else',
    '    echo "[openclaw][error] source 路径执行后校验仍失败。"',
    '    exit 45',
    '  fi',
    'fi',
    'if [ "$AUTO_DONE" != "1" ]; then',
    '  echo "[openclaw][error] 自动安装链路未完成。"',
    '  exit 46',
    'fi'
  ].join('\n');

  const modeBlock = mode === 'release'
    ? releaseModeBlock
    : mode === 'npm'
      ? npmModeBlock
      : mode === 'source'
        ? sourceModeBlock
        : autoModeBlock;

  return [
    'set -euo pipefail',
    `INSTALL_MODE="${safeMode}"`,
    `TARGET_TAG="${safeTag}"`,
    'TARGET_VERSION="${TARGET_TAG#v}"',
    `HAS_RELEASE_ASSET="${assetCmd ? '1' : '0'}"`,
    `RELEASE_ASSET_SOURCE="${safeAssetSource}"`,
    `RELEASE_ASSET_INFO="${safeAssetInfo}"`,
    `RELEASE_ASSETS_BRIEF="${safeAssetsBrief}"`,
    'echo "[openclaw] install mode: ${INSTALL_MODE}"',
    'echo "[openclaw] release tag: ${TARGET_TAG:-unknown}"',
    'echo "[openclaw] selected release asset: ${RELEASE_ASSET_INFO} (source=${RELEASE_ASSET_SOURCE})"',
    'verify_runtime_entry() {',
    '  if [ -f /root/.openclaw/openclaw-source/openclaw.mjs ]; then',
    '    if [ ! -f /root/.openclaw/openclaw-source/dist/entry.js ] && [ ! -f /root/.openclaw/openclaw-source/dist/entry.mjs ] && [ ! -f /root/.openclaw/openclaw-source/dist/index.js ] && [ ! -f /root/.openclaw/openclaw-source/dist/index.mjs ]; then',
    '      return 1',
    '    fi',
    '    if command -v timeout >/dev/null 2>&1; then',
    '      timeout 30 node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs --version >/dev/null 2>&1 || return 1',
    '    else',
    '      node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs --version >/dev/null 2>&1 || return 1',
    '    fi',
    '    return 0',
    '  fi',
    '  if command -v openclaw >/dev/null 2>&1 || [ -x /root/.npm-global/bin/openclaw ] || [ -x /usr/local/bin/openclaw ]; then',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    'current_openclaw_version() {',
    '  local raw=""',
    '  if command -v openclaw >/dev/null 2>&1; then',
    '    raw="$(openclaw --version 2>/dev/null || openclaw -v 2>/dev/null || true)"',
    '  elif [ -x /root/.npm-global/bin/openclaw ]; then',
    '    raw="$(/root/.npm-global/bin/openclaw --version 2>/dev/null || /root/.npm-global/bin/openclaw -v 2>/dev/null || true)"',
    '  elif [ -x /usr/local/bin/openclaw ]; then',
    '    raw="$(/usr/local/bin/openclaw --version 2>/dev/null || /usr/local/bin/openclaw -v 2>/dev/null || true)"',
    '  fi',
    '  if [ -z "$raw" ] && [ -f /root/.openclaw/openclaw-source/package.json ]; then',
    '    raw="$(node -e "try{const p=require(\\"/root/.openclaw/openclaw-source/package.json\\");console.log(p.version||\\"\\")}catch(e){}" 2>/dev/null || true)"',
    '  fi',
    '  raw="$(printf "%s" "$raw" | tr -d "\\r" | grep -Eo "[0-9]+\\.[0-9]+\\.[0-9]+([-.][0-9A-Za-z.]+)?" | head -n1 || true)"',
    '  printf "%s" "$raw"',
    '}',
    'version_matches_target() {',
    '  if [ -z "$TARGET_VERSION" ]; then',
    '    return 0',
    '  fi',
    '  local current',
    '  current="$(current_openclaw_version)"',
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
    'runtime_ready_and_latest() { verify_runtime_entry && version_matches_target; }',
    modeBlock
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
    const rawToken = String(cfg?.gateway?.auth?.token || '').trim();
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

// --- Config Export (download as .tar.gz) ---
app.get('/api/openclaw/config/export', (req, res) => {
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
    const { execSync } = require('child_process');
    execSync(`tar -czf ${JSON.stringify(tgzPath)} -C ${JSON.stringify(tmpDir)} .`, { stdio: 'pipe', timeout: 15000 });
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
    const release = await getLatestOpenClawRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release, { mode });
    const taskId = runOpenClawTask(
      command,
      `安装 OpenClaw（mode=${mode}，官方 npm 优先 → GitHub Linux 包 → 源码兜底）(${release.tag})`,
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

function buildOpenClawNpmInstallCommand() {
  return [
    'set -euo pipefail',
    'for bin in node npm; do',
    '  if ! command -v "$bin" >/dev/null 2>&1; then',
    '    echo "[openclaw] 缺少镜像内依赖: $bin（请重新构建镜像，不在运行时安装系统依赖）"',
    '    exit 11',
    '  fi',
    'done',
    'npm config set registry https://registry.npmmirror.com',
    'npm config set fetch-retries 6',
    'npm config set fetch-retry-mintimeout 2000',
    'npm config set fetch-retry-maxtimeout 20000',
    'NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo /usr/local)"',
    'OPENCLAW_STATE_ROOT="/root/.openclaw"',
    'PERSIST_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw-source"',
    'WORK_SRC_DIR="$OPENCLAW_STATE_ROOT/openclaw"',
    'mkdir -p "$OPENCLAW_STATE_ROOT" "$OPENCLAW_STATE_ROOT/logs" "$OPENCLAW_STATE_ROOT/cache/openclaw" "$OPENCLAW_STATE_ROOT/locks"',
    'OPENCLAW_LIB_DIR="${NPM_PREFIX}/lib/node_modules"',
    'OPENCLAW_BIN="${NPM_PREFIX}/bin/openclaw"',
    'MIRROR_LATEST="$(npm view openclaw version --registry=https://registry.npmmirror.com 2>/dev/null || true)"',
    'NPMJS_LATEST="$(npm view openclaw version --registry=https://registry.npmjs.org 2>/dev/null || true)"',
    'VERSION_QUERY_FAILED=0',
    'if [ -z "$MIRROR_LATEST" ] && [ -z "$NPMJS_LATEST" ]; then',
    '  VERSION_QUERY_FAILED=1',
    '  echo "[openclaw][warn] npm view 查询失败（两个源均不可用），跳过版本对齐检查"',
    'fi',
    'if [ -n "$NPMJS_LATEST" ] && [ "$MIRROR_LATEST" != "$NPMJS_LATEST" ]; then',
    '  echo "[openclaw] 镜像最新(${MIRROR_LATEST:-unknown})落后于 npmjs(${NPMJS_LATEST})，直接使用 npmjs 源安装..."',
    '  npm config set registry https://registry.npmjs.org',
    'fi',
    '# --- backup-then-install-in-place: 备份旧版本而非预删除 (DFMEA N1) ---',
    'BACKUP_LIB_DIR="/root/.npm-global-backup"',
    'rm -rf "$BACKUP_LIB_DIR" 2>/dev/null || true',
    'if [ -d "${OPENCLAW_LIB_DIR}/openclaw" ]; then',
    '  mkdir -p "$BACKUP_LIB_DIR"',
    '  cp -a "${OPENCLAW_LIB_DIR}/openclaw" "$BACKUP_LIB_DIR/openclaw"',
    '  echo "[openclaw] 旧版本已备份到 $BACKUP_LIB_DIR"',
    'fi',
    'rm -rf "${OPENCLAW_LIB_DIR}"/.openclaw-* >/dev/null 2>&1 || true',
    'npm cache verify >/dev/null 2>&1 || true',
    '# --- 验证安装结果的函数 (DFMEA N4/N2) ---',
    'verify_installed_openclaw() {',
    '  [ -f "${OPENCLAW_LIB_DIR}/openclaw/package.json" ] || return 1',
    '  local has_entry=0',
    '  [ -f "${OPENCLAW_LIB_DIR}/openclaw/openclaw.mjs" ] && has_entry=1',
    '  [ -f "${OPENCLAW_LIB_DIR}/openclaw/dist/openclaw.mjs" ] && has_entry=1',
    '  [ -f "${OPENCLAW_LIB_DIR}/openclaw/dist/entry.js" ] && has_entry=1',
    '  [ -f "${OPENCLAW_LIB_DIR}/openclaw/dist/index.js" ] && has_entry=1',
    '  [ -f "${OPENCLAW_LIB_DIR}/openclaw/dist/index.mjs" ] && has_entry=1',
    '  [ "$has_entry" = "1" ] || return 1',
    '  if command -v openclaw >/dev/null 2>&1; then',
    '    openclaw -v >/dev/null 2>&1 || return 1',
    '  elif [ -x "$OPENCLAW_BIN" ]; then',
    '    "$OPENCLAW_BIN" -v >/dev/null 2>&1 || return 1',
    '  fi',
    '  return 0',
    '}',
    '# --- 安装失败时还原备份 (DFMEA N1) ---',
    'restore_openclaw_backup() {',
    '  if [ -d "$BACKUP_LIB_DIR/openclaw" ]; then',
    '    echo "[openclaw] 安装失败，还原旧版本..."',
    '    rm -rf "${OPENCLAW_LIB_DIR}/openclaw" 2>/dev/null || true',
    '    mv "$BACKUP_LIB_DIR/openclaw" "${OPENCLAW_LIB_DIR}/openclaw"',
    '    npm rebuild -g openclaw 2>/dev/null || true',
    '    echo "[openclaw] 旧版本已还原"',
    '  else',
    '    echo "[openclaw][warn] 无可还原的备份"',
    '  fi',
    '}',
    'OPENCLAW_NPM_LAST_ERROR=""',
    'run_npm_global_install() {',
    '  local pkg="$1"',
    '  local label="$2"',
    '  local rc=0',
    '  local tmp_log="$OPENCLAW_STATE_ROOT/logs/npm-install-${label}.log"',
    '  rm -f "$tmp_log"',
    '  set +e',
    '  if command -v timeout >/dev/null 2>&1; then',
    '    echo "[openclaw] ${label}: timeout 900s npm install -g ${pkg} --prefer-online --no-audit --no-fund"',
    '    timeout 900 npm install -g "$pkg" --prefer-online --no-audit --no-fund 2>&1 | tee "$tmp_log"',
    '    rc=${PIPESTATUS[0]}',
    '  else',
    '    echo "[openclaw] ${label}: npm install -g ${pkg} --prefer-online --no-audit --no-fund"',
    '    npm install -g "$pkg" --prefer-online --no-audit --no-fund 2>&1 | tee "$tmp_log"',
    '    rc=${PIPESTATUS[0]}',
    '  fi',
    '  set -e',
    '  if [ "$rc" -ne 0 ]; then',
    '    if [ "$rc" -eq 124 ]; then',
    '      OPENCLAW_NPM_LAST_ERROR="[openclaw][error] npm install 超时(900s): ${pkg}"',
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
    '  return "$rc"',
    '}',
    'if ! run_npm_global_install openclaw@latest "first_install"; then',
    '  echo "[openclaw] npm install 首次失败，尝试清理并重试..."',
    '  npm cache verify >/dev/null 2>&1 || true',
    '  npm config set registry https://registry.npmjs.org',
    '  if ! run_npm_global_install openclaw@latest "retry_install"; then',
    '    [ -n "$OPENCLAW_NPM_LAST_ERROR" ] && echo "$OPENCLAW_NPM_LAST_ERROR"',
    '    restore_openclaw_backup',
    '    exit 31',
    '  fi',
    'fi',
    '# 首次安装成功后验证 (DFMEA N4/N2)',
    'if ! verify_installed_openclaw; then',
    '  echo "[openclaw][warn] 首次安装验证失败，尝试 rebuild..."',
    '  npm rebuild -g openclaw 2>/dev/null || true',
    'fi',
    '# 安装成功，清理备份',
    'rm -rf "$BACKUP_LIB_DIR" 2>/dev/null || true',
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
    '  echo "[openclaw] npm root -g: ${NPM_ROOT:-unknown}"',
    '  echo "[openclaw] package candidate: $OPENCLAW_PKG_DIR"',
    '  if [ ! -d "$OPENCLAW_PKG_DIR" ]; then',
    '    ALT_PKG_DIR="${OPENCLAW_LIB_DIR}/openclaw"',
    '    if [ -d "$ALT_PKG_DIR" ]; then',
    '      echo "[openclaw] npm root 未发现 openclaw，改用 prefix 路径: $ALT_PKG_DIR"',
    '      OPENCLAW_PKG_DIR="$ALT_PKG_DIR"',
    '    fi',
    '  fi',
    '  if [ ! -d "$OPENCLAW_PKG_DIR" ]; then',
    '    echo "[openclaw] 预构建包缺失: $OPENCLAW_PKG_DIR"',
    '    return 14',
    '  fi',
    '  rm -rf "$PERSIST_SRC_DIR"',
    '  ln -sfn "$OPENCLAW_PKG_DIR" "$PERSIST_SRC_DIR"',
    '  ln -sfn "$PERSIST_SRC_DIR" "$WORK_SRC_DIR"',
    '  if [ ! -f "$PERSIST_SRC_DIR/openclaw.mjs" ] && [ -f "$PERSIST_SRC_DIR/dist/openclaw.mjs" ]; then',
    '    ln -sfn "$PERSIST_SRC_DIR/dist/openclaw.mjs" "$PERSIST_SRC_DIR/openclaw.mjs"',
    '  fi',
    '  if [ ! -f "$PERSIST_SRC_DIR/dist/entry.js" ] && [ -f "$PERSIST_SRC_DIR/dist/index.js" ]; then ln -sfn index.js "$PERSIST_SRC_DIR/dist/entry.js"; fi',
    '  if [ ! -f "$PERSIST_SRC_DIR/dist/entry.mjs" ] && [ -f "$PERSIST_SRC_DIR/dist/index.mjs" ]; then ln -sfn index.mjs "$PERSIST_SRC_DIR/dist/entry.mjs"; fi',
    '  if [ ! -f "$PERSIST_SRC_DIR/openclaw.mjs" ] || { [ ! -f "$PERSIST_SRC_DIR/dist/entry.js" ] && [ ! -f "$PERSIST_SRC_DIR/dist/entry.mjs" ] && [ ! -f "$PERSIST_SRC_DIR/dist/index.js" ] && [ ! -f "$PERSIST_SRC_DIR/dist/index.mjs" ]; }; then',
    '    echo "[openclaw] 预构建包关键产物不完整（缺少 openclaw.mjs 或 dist/entry|index.(m)js），回退源码构建"',
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
    '# 提取纯数字版本号（openclaw -v 输出可能含 "OpenClaw 2026.3.8 (commit)" 等前后缀）',
    'CURRENT_VER="$(printf "%s" "$CURRENT_VER" | tr -d "\\r" | grep -Eo "[0-9]+\\.[0-9]+\\.[0-9]+([-.][-0-9A-Za-z.]+)?" | head -n1 || true)"',
    'echo "[openclaw] version alignment check: current=${CURRENT_VER:-empty} npmjs=${NPMJS_LATEST:-empty} sync_ok=${SYNC_OK} query_failed=${VERSION_QUERY_FAILED}"',
    'if [ "$VERSION_QUERY_FAILED" != "1" ] && { [ "$SYNC_OK" != "1" ] || { [ -n "$NPMJS_LATEST" ] && [ -n "$CURRENT_VER" ] && [ "$CURRENT_VER" != "$NPMJS_LATEST" ]; }; }; then',
    '  if [ "$SYNC_OK" != "1" ]; then',
    '    echo "[openclaw] 预构建包校验失败，尝试从 npmjs 重新安装一次..."',
    '  else',
    '    echo "[openclaw] 镜像版本(${CURRENT_VER:-unknown})落后于 npmjs 最新(${NPMJS_LATEST})，切换 npmjs 对齐..."',
    '  fi',
    '  npm config set registry https://registry.npmjs.org',
    '  # === 安全对齐：backup-then-install-in-place (DFMEA N4/N2/N1) ===',
    '  ALIGN_PKG="${NPMJS_LATEST:+openclaw@$NPMJS_LATEST}"',
    '  ALIGN_PKG="${ALIGN_PKG:-openclaw@latest}"',
    '  ALIGN_LABEL="npmjs对齐安装"',
    '  ALIGN_OK=0',
    '  # 备份当前版本',
    '  rm -rf "$BACKUP_LIB_DIR" 2>/dev/null || true',
    '  if [ -d "${OPENCLAW_LIB_DIR}/openclaw" ]; then',
    '    mkdir -p "$BACKUP_LIB_DIR"',
    '    cp -a "${OPENCLAW_LIB_DIR}/openclaw" "$BACKUP_LIB_DIR/openclaw"',
    '    echo "[openclaw] 对齐前已备份旧版本到 $BACKUP_LIB_DIR"',
    '  fi',
    '  echo "[openclaw] ${ALIGN_LABEL}: 原地安装 ${ALIGN_PKG}..."',
    '  set +e',
    '  if command -v timeout >/dev/null 2>&1; then',
    '    echo "[openclaw] ${ALIGN_LABEL}: timeout 900s npm install -g ${ALIGN_PKG} --prefer-online --no-audit --no-fund"',
    '    timeout 900 npm install -g "$ALIGN_PKG" --prefer-online --no-audit --no-fund 2>&1 | tee "$OPENCLAW_STATE_ROOT/logs/npm-install-align.log"',
    '    ALIGN_RC=${PIPESTATUS[0]}',
    '  else',
    '    npm install -g "$ALIGN_PKG" --prefer-online --no-audit --no-fund 2>&1 | tee "$OPENCLAW_STATE_ROOT/logs/npm-install-align.log"',
    '    ALIGN_RC=${PIPESTATUS[0]}',
    '  fi',
    '  set -e',
    '  # 验证安装结果',
    '  if [ "$ALIGN_RC" -eq 0 ] && verify_installed_openclaw; then',
    '    ALIGN_OK=1',
    '    echo "[openclaw] 对齐安装成功且验证通过"',
    '    rm -rf "$BACKUP_LIB_DIR" 2>/dev/null || true',
    '  else',
    '    echo "[openclaw] 对齐安装失败或验证未通过 (rc=${ALIGN_RC})"',
    '    restore_openclaw_backup',
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

    const mode = resolveOpenClawInstallMode(req);
    const repo = resolveOpenClawSourceRepo(true);
    const release = await getLatestOpenClawRelease(repo);
    const command = buildOpenClawPreferredInstallCommand(release, { mode });
    const taskId = runOpenClawTask(
      command,
      `更新 OpenClaw（mode=${mode}，官方 npm 优先 → GitHub Linux 包 → 源码兜底）(${release.tag})`,
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
  if (!/^[0-9a-f-]{36}$/.test(requestId)) return res.status(400).json({ success: false, error: 'requestId 格式无效' });
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
    const existingTokens = existing.tokens && typeof existing.tokens === 'object' ? { ...existing.tokens } : {};
    existingTokens[role] = {
      token,
      role,
      scopes: entry.scopes || existing.approvedScopes || ['operator.admin'],
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
      approvedScopes: entry.scopes || existing.approvedScopes || ['operator.admin'],
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
  // 过滤掉频繁的 webchat connected/disconnected 日志
  if (/\[ws\]\s+webchat\s+(connected|disconnected)/i.test(line)) {
    return null;
  }
  // 过滤掉高频 ws 消息日志（device.pair.list, node.list, chat.history 等）
  if (/\[ws\]\s+⇄\s+res\s+✓\s+(device\.pair\.list|node\.list|chat\.history|device\.list)\b/.test(line)) {
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
// Plugins market — Skills & Extensions
// ============================================================
// Resolve the openclaw package's skills directory (bundled)
function resolveOpenclawPkgRoot() {
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
  return '/root/.npm-global/lib/node_modules/openclaw';
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
let browserBridgeWss = null;

if (WebSocketServer) {
  wss = new WebSocketServer({ noServer: true });
  // Disable perMessageDeflate for terminal to avoid potential 1006 on some proxies/browsers
  termWss = new WebSocketServer({ 
    noServer: true,
    perMessageDeflate: false
  });
  browserBridgeWss = new WebSocketServer({ noServer: true });

  // ─── Browser Bridge WebSocket ─────────────────────────
  browserBridgeWss.on('connection', (ws, req) => {
    let parsedUrl;
    try { parsedUrl = new URL(req.url, 'http://localhost'); } catch { parsedUrl = { searchParams: new URLSearchParams() }; }
    const code = (parsedUrl.searchParams.get('code') || '').trim().toUpperCase();
    const name = (parsedUrl.searchParams.get('name') || '').trim() || 'Chrome';

    // 验证配对码
    const pairsData = readBrowserPairs();
    const validCodes = (pairsData.pairCodes || []).map(p => p.code);
    if (!code || !validCodes.includes(code)) {
      try { ws.close(4001, 'invalid pair code'); } catch {}
      return;
    }

    // 如果该 code 已有连接，踢掉旧的
    if (browserBridgeClients.has(code)) {
      const old = browserBridgeClients.get(code);
      try { old.ws.close(4002, 'replaced by new connection'); } catch {}
    }

    const client = {
      ws,
      name,
      connectedAt: new Date().toISOString(),
      lastPing: new Date().toISOString(),
      _pendingRequests: new Map()
    };
    browserBridgeClients.set(code, client);
    console.log(`[browser-bridge] 扩展已连接: code=${code}, name=${name}`);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      // 心跳回复
      if (msg.type === 'ping') {
        client.lastPing = new Date().toISOString();
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
        return;
      }

      // targets 列表回复
      if (msg.type === 'targets' && msg.requestId) {
        const cb = client._pendingRequests.get(msg.requestId);
        if (cb) {
          client._pendingRequests.delete(msg.requestId);
          cb({ reachable: true, targets: msg.targets || [] });
        }
        return;
      }

      // CDP 命令结果回复
      if (msg.type === 'cdp-result' || msg.type === 'cdp-error') {
        const cb = client._pendingRequests.get(msg.id);
        if (cb) {
          client._pendingRequests.delete(msg.id);
          cb(msg);
        }
        return;
      }

      // attach/detach 结果
      if (msg.type === 'attach-result' || msg.type === 'detach-result') {
        const key = `${msg.type}-${msg.tabId}`;
        const cb = client._pendingRequests.get(key);
        if (cb) {
          client._pendingRequests.delete(key);
          cb(msg);
        }
        return;
      }
    });

    ws.on('close', () => {
      if (browserBridgeClients.get(code)?.ws === ws) {
        browserBridgeClients.delete(code);
        console.log(`[browser-bridge] 扩展已断开: code=${code}`);
      }
    });

    ws.on('error', () => {});

    // 发送欢迎消息
    try { ws.send(JSON.stringify({ type: 'welcome', serverTime: new Date().toISOString() })); } catch {}
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

  // 浏览器扩展 Bridge WebSocket (无需 session 认证，使用配对码认证)
  if (WebSocketServer && browserBridgeWss && pathname === '/api/ws/browser-bridge') {
    try {
      browserBridgeWss.handleUpgrade(req, socket, head, (ws) => {
        browserBridgeWss.emit('connection', ws, req);
      });
    } catch (e) {
      console.error(`[browser-bridge] handleUpgrade error:`, e.message);
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
  sanitizeAllConfigBackups();
  checkOrphanInstallTask(); // C7: 启动时检测孤儿安装进程 (DFMEA T2)
  console.log(`[web] OpenClaw Web 管理面板启动: http://0.0.0.0:${PORT}`);
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[web][error] 端口 ${PORT} 已被占用，疑似重复启动 web-panel，请先停止旧进程后再启动。`);
  } else {
    console.error(`[web][error] Web 面板启动失败: ${err?.message || err}`);
  }
  process.exit(1);
});
