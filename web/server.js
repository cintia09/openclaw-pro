// ============================================================
// server.js — OpenClaw Web 管理面板 (docker/web)
// - Express on 3000
// - Auth: signed cookie + PBKDF2 (docker-config.json)
// - Keep legacy APIs: status/config/restart/openclaw/logs/trading
// - WebSocket: /api/ws/logs (tail gateway log)
// - Plugins market APIs: /api/plugins/list + /api/plugins/install
// - STT config APIs: /api/stt/config
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, exec } = require('child_process');
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
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; frame-ancestors 'self'"
  );
  next();
});

const PORT = 3000;

const CONFIG_PATH = '/root/.openclaw/openclaw.json';
const DOCKER_CONFIG_PATH = '/root/.openclaw/docker-config.json';
const STT_CONFIG_PATH = '/root/.openclaw/stt-config.json';
const PLUGINS_STATE_PATH = '/root/.openclaw/plugins-state.json';

const LOG_FILE = '/tmp/openclaw-gateway.log';

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

function restartGatewayForeground(callback) {
  const cmd = [
    'pkill -f "[o]penclaw.*gateway" >/dev/null 2>&1 || true',
    'nohup openclaw gateway run --allow-unconfigured >> /root/.openclaw/logs/gateway.log 2>&1 &',
    'sleep 1',
    'pgrep -f "[o]penclaw.*gateway" >/dev/null 2>&1',
  ].join(' && ');

  exec(`bash -lc '${cmd}'`, callback);
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

app.use(requireAuthPage);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', requireAuthApi);

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
  return readJson(CONFIG_PATH, {});
}
function writeConfig(config) {
  writeJson(CONFIG_PATH, config);
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
    // Only consider a release version difference as the primary "hasUpdate" trigger
    const hasUpdate = currentNorm !== 'unknown' && currentNorm !== 'dev'
      && !!latestNorm && latestNorm !== currentNorm;

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
      log('检测到 start-services.sh 已更新：请重启容器以使入口脚本变更生效（仅热更新不会立即生效）');
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
  const status = { gateway: false, web: true, caddy: false, uptime: 0, memory: {}, version: getCurrentVersion() };

  try {
    execSync('pgrep -f "[o]penclaw.*gateway"', { stdio: 'ignore' });
    status.gateway = true;
  } catch {}

  try {
    execSync('pgrep -f caddy', { stdio: 'ignore' });
    status.caddy = true;
  } catch {}

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

  if (status.browserEnabled) {
    try {
      execSync('pgrep -f "websockify.*6080"', { stdio: 'ignore' });
      status.browser = true;
    } catch {
      status.browser = false;
    }
  } else {
    status.browser = false;
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
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: config (basic; keep legacy behavior)
// ============================================================
app.get('/api/config', (req, res) => {
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
    const config = readConfig();
    const updates = req.body || {};
    deepMerge(config, updates);
    writeConfig(config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: restart gateway
// ============================================================
app.post('/api/restart', (req, res) => {
  try {
    restartGatewayForeground((err, stdout, stderr) => {
      res.json({ success: !err, output: stdout || stderr });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: OpenClaw install/status/update/start
// ============================================================
const installLogs = {};

function appendInstallLog(task, chunk) {
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

function runOpenClawTask(command, title) {
  const taskId = Date.now().toString();
  installLogs[taskId] = {
    status: 'running',
    log: '',
    startedAt: Date.now(),
    seq: 0,
    chunks: []
  };

  const task = installLogs[taskId];
  appendInstallLog(task, `[openclaw] ${title}\n`);
  appendInstallLog(task, `[openclaw] command: ${command}\n\n`);

  const escaped = String(command).replace(/'/g, `'"'"'`);
  const child = exec(`bash --noprofile --norc -lc '${escaped}'`, {
    timeout: 900000,
    env: { ...process.env, TERM: 'dumb' }
  });
  child.stdout.on('data', d => appendInstallLog(task, d));
  child.stderr.on('data', d => appendInstallLog(task, d));
  child.on('close', code => {
    task.status = code === 0 ? 'success' : 'failed';
    task.exitCode = code;
    const keys = Object.keys(installLogs).sort();
    while (keys.length > 5) delete installLogs[keys.shift()];
  });

  return taskId;
}

app.get('/api/openclaw', (req, res) => {
  let installed = false;
  let version = '';
  try {
    version = execSync('openclaw --version 2>/dev/null', { encoding: 'utf8' }).trim();
    installed = true;
  } catch {}

  const gatewayRunning = (() => {
    try {
      execSync('pgrep -f "[o]penclaw.*gateway"', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  res.json({ installed, version, gatewayRunning });
});

app.post('/api/openclaw/install', (req, res) => {
  const command = 'curl -fsSL --proto "=https" --tlsv1.2 https://openclaw.ai/install-cli.sh | bash';
  const taskId = runOpenClawTask(command, '使用 OpenClaw 官网安装脚本安装 CLI');
  res.json({ taskId });
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

app.post('/api/openclaw/update', (req, res) => {
  const command = [
    'if command -v openclaw >/dev/null 2>&1; then',
    '  openclaw update --channel stable || npm install -g openclaw@latest;',
    'else',
    '  curl -fsSL --proto "=https" --tlsv1.2 https://openclaw.ai/install-cli.sh | bash;',
    'fi'
  ].join(' ');
  const taskId = runOpenClawTask(command, '按官方稳定渠道更新 OpenClaw');
  res.json({ taskId });
});

app.post('/api/openclaw/start', (req, res) => {
  restartGatewayForeground((err, stdout, stderr) => {
    res.json({ success: !err, output: stdout || stderr });
  });
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
  if (!fs.existsSync(LOG_FILE)) return [];
  const output = execSync(`tail -${Math.max(1, Math.min(lines, 5000))} "${LOG_FILE}"`, { encoding: 'utf8' });
  return output
    .split('\n')
    .filter(Boolean)
    .map(sanitizeLogLine);
}

app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 100;
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json({ logs: 'No log file found' });
    const output = execSync(`tail -${Math.max(1, Math.min(lines, 5000))} "${LOG_FILE}"`, { encoding: 'utf8' });
    const sanitized = output
      .split('\n')
      .map(sanitizeLogLine)
      .join('\n');
    res.json({ logs: sanitized });
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

if (WebSocketServer) {
  const wss = new WebSocketServer({ server, path: '/api/ws/logs' });

  wss.on('connection', (ws) => {
    // Send recent lines on connect
    try {
      const lines = tailLogLines(120);
      ws.send(JSON.stringify({ type: 'lines', lines }));
    } catch {}

    // Track file offset for incremental reads
    let lastSize = 0;
    try { lastSize = fs.statSync(LOG_FILE).size; } catch {}

    let watcher = null;
    let debounceTimer = null;

    const sendNewLines = () => {
      if (ws.readyState !== 1) return;
      try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size === lastSize) return;
        if (stat.size < lastSize) {
          // File was truncated/rotated — re-read from start
          lastSize = 0;
        }
        const fd = fs.openSync(LOG_FILE, 'r');
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
      watcher = fs.watch(LOG_FILE, () => {
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
} else {
  console.warn('[web] ws package not available: /api/ws/logs disabled');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[web] OpenClaw Web 管理面板启动: http://0.0.0.0:${PORT}`);
});
