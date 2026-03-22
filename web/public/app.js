/* ============================================================
   app.js — OpenClaw Web Panel (no framework)
   - Hash routing, sidebar UX, fade transitions
   - Plugins market + Terminal (WebSocket logs)
   - Keep all existing functionality
   ============================================================ */

function $(id){ return document.getElementById(id); }
function q(sel, root=document){ return root.querySelector(sel); }
function qa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

// i18n helper — translates Chinese keys to English when locale=en
function _t() { return typeof window.t === 'function' ? window.t.apply(null, arguments) : arguments[0]; }

const OC_DEBUG = (() => {
  try {
    return localStorage.getItem('ocDebug') === '1';
  } catch {
    return false;
  }
})();

function dlog(...args){
  if (!OC_DEBUG) return;
  console.debug('[oc-debug]', ...args);
}

const UI_MAX_LINES_DEFAULT = 10000;
const UI_OC_LOG_MAX_LINES = 12000;
const UI_TERMINAL_MAX_LINES = 15000;
const UI_LOG_VIEW_FETCH_LINES = 1200;
const UI_LOG_VIEW_RENDER_MAX_LINES = 12000;
const UI_TERMINAL_FALLBACK_FETCH_LINES = 400;
const UI_XTERM_SCROLLBACK = 50000;

// ------------------------
// Log deduplication for WebSocket connection logs
// ------------------------
// Use a Set to store log identifiers already shown (connId + state)
const shownWsLogIds = new Set();
let lastWsLogState = null; // last displayed state

function getWsLogId(line) {
  // Extract connId and state as a unique identifier
  const match = line.match(/\[ws\]\s+webchat\s+(connected|disconnected)\s+conn=([a-f0-9-]+)/i);
  if (!match) return null;
  return `${match[2]}:${match[1].toLowerCase()}`; // connId:state
}

function parseWsLogLine(line) {
  // Match [gateway-runtime] [2026-03-07 16:32:01] [ws] webchat connected conn=xxx remote=...
  const match = line.match(/\[ws\]\s+webchat\s+(connected|disconnected)\s+conn=([a-f0-9-]+)/i);
  if (!match) return null;
  return {
    state: match[1].toLowerCase(), // 'connected' or 'disconnected'
    connId: match[2]
  };
}

// ------------------------
// API helper
// ------------------------
async function api(url, opts={}){
  const timeoutMs = Number(opts.timeoutMs || 60000);
  const { timeoutMs: _ignoreTimeoutMs, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  try{
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...fetchOpts,
      signal: controller.signal,
      body: fetchOpts.body ? JSON.stringify(fetchOpts.body) : undefined
    });

    const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt;
    if (OC_DEBUG) {
      dlog('api', fetchOpts.method || 'GET', url, 'status=', res.status, 'elapsedMs=', Math.round(elapsed));
    }

    if (res.status === 401){
      window.location.href = '/login.html';
      return { error: 'unauthorized' };
    }

    const rawText = await res.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch { data = null; }
    if (!res.ok) {
      const detail = (data && typeof data === 'object' && data.error)
        ? data.error
        : (rawText ? compactOutputForUi(rawText) : _t('请求失败（HTTP {0}）', res.status));
      return { error: detail, status: res.status };
    }
    if (data && typeof data === 'object') return data;
    return { error: rawText ? _t('响应不是有效 JSON：{0}', compactOutputForUi(rawText)) : _t('响应为空（后端未返回 JSON）') };
  }catch(e){
    console.error('api error', e);
    const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt;
    if (e && e.name === 'AbortError') return { error: _t('请求超时（>{0}ms）', timeoutMs) };
    dlog('api error', fetchOpts.method || 'GET', url, 'elapsedMs=', Math.round(elapsed), 'message=', e && e.message ? e.message : e);
    return { error: e.message };
  } finally {
    clearTimeout(timeout);
  }
}

function compactOutputForUi(text) {
  const s = stripAnsi(String(text || '')).replace(/\s+/g, ' ').trim();
  return s.length > 220 ? `${s.slice(0, 220)}...` : s;
}

function stripAnsi(text){
  const raw = String(text ?? '');
  return raw
    .replace(/\][^]*(?:|\\)/g, '')
    .replace(/\[[0-?]*[ -/]*[@-~]/g, '');
}

function stripOsc(text){
  return String(text ?? '').replace(/\][^]*(?:|\\)/g, '');
}

function normalizeTerminalChunk(text){
  let out = stripAnsi(String(text ?? ''));
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '');
  while (/\x08/.test(out)) {
    out = out.replace(/[^\n]\x08/g, '').replace(/\x08/g, '');
  }
  return out;
}

function formatVersionLabel(rawVersion){
  const v = String(rawVersion || '').trim();
  if (!v) return '';
  const lower = v.toLowerCase();
  if (lower === 'dev') {
    return _t('开发版（dev）');
  }
  if (lower === 'unknown' || /^v?0\.0\.0(?:[-+].*)?$/i.test(v)) {
    return _t('未标注版本');
  }
  return v;
}

function formatInstallSourceLabel(rawSource){
  const s = String(rawSource || '').trim().toLowerCase();
  if (s === 'source') return _t('源码安装');
  if (s === 'npm') return _t('npm 安装');
  if (s === 'binary') return _t('二进制安装');
  if (s === 'version') return _t('版本探测');
  if (s === 'none') return _t('未安装');
  return _t('已安装');
}

// ------------------------
// Toast
// ------------------------
let toastTimer = null;
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function highlightLogKeywords(rawLine, safeLine){
  const line = String(rawLine ?? '');
  let out = String(safeLine ?? '');

  out = out.replace(/\[(openclaw-install|openclaw-repair|watchdog|web-panel|gateway-runtime|gateway-legacy|gateway|install|status|update|openclaw|progress|web|DNS|state|uninstall)\]/g, (_m, token) => {
    const t = String(token || '').toLowerCase();
    if (t === 'openclaw-install' || t === 'openclaw-repair' || t === 'watchdog' || t === 'web-panel' || t === 'gateway-runtime' || t === 'gateway-legacy' || t === 'gateway') {
      return `<span class="term-tag term-tag-section">[${token}]</span>`;
    }
    if (t === 'install' || t === 'openclaw' || t === 'progress') {
      return `<span class="term-tag term-tag-install">[${token}]</span>`;
    }
    if (t === 'state' || t === 'uninstall') {
      return `<span class="term-tag term-tag-state">[${token}]</span>`;
    }
    if (t === 'status' || t === 'update') {
      return `<span class="term-tag term-tag-status">[${token}]</span>`;
    }
    return `<span class="term-tag term-tag-neutral">[${token}]</span>`;
  });

  out = out
    .replace(/\b(npm\s+ERR!)\b/g, '<span class="term-error">$1</span>')
    .replace(/\b(npm\s+WARN)\b/gi, '<span class="term-warn">$1</span>')
    .replace(/\b(npm\s+notice)\b/gi, '<span class="term-info">$1</span>')
    .replace(/\bstatus=(begin)\b/gi, '<span class="term-state-begin">status=$1</span>')
    .replace(/\bstatus=(running)\b/gi, '<span class="term-state-running">status=$1</span>')
    .replace(/\bstatus=(success)\b/gi, '<span class="term-state-success">status=$1</span>')
    .replace(/\bstatus=(failed|error)\b/gi, '<span class="term-state-failed">status=$1</span>')
    // WebSocket connect/disconnect highlighting
    .replace(/\b(connected)\b/gi, '<span class="term-state-success">$1</span>')
    .replace(/\b(disconnected)\b/gi, '<span class="term-state-failed">$1</span>')
    .replace(/\b(conn=[a-f0-9-]+)\b/gi, '<span class="term-conn-id">$1</span>')
    .replace(/\b(code=\d+)\b/gi, '<span class="term-code">$1</span>')
    .replace(/\b(reason=\w+)\b/gi, '<span class="term-reason">$1</span>')
    // Merge count and duration
    .replace(/(\(×\d+\))/g, '<span class="term-count">$1</span>')
    .replace(/(\[(?:持续|duration:?) [^\]]+\])/g, '<span class="term-duration">$1</span>');

  if (/^\s*\[[^\]]+\]\s*$/.test(line.trim())) {
    out = `<span class="term-section-line">${out}</span>`;
  }
  return out;
}

function colorizeLine(rawLine){
  const line = stripAnsi(String(rawLine ?? ''));

  // Handle WebSocket skip hint lines
  if (/^\s*\.\.\.\s*(?:跳过|skipped)/.test(line)) {
    return `<span class="term-line"><span class="term-skip-hint">${escapeHtml(line)}</span></span>`;
  }

  const dateLike = /^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
  let safe = highlightLogKeywords(line, escapeHtml(line));

  if (/^\s*(\$|#)\s+/.test(line)) {
    safe = `<span class="term-cmd">${safe}</span>`;
  } else if (/\b(ERROR|Error|ERR|failed|failure|失败|异常|fatal)\b/.test(line)) {
    safe = `<span class="term-error">${safe}</span>`;
  } else if (/\b(WARN|Warning|timeout|超时|occupied|占用|conflict|冲突)\b/i.test(line)) {
    safe = `<span class="term-warn">${safe}</span>`;
  } else if (/\b(INFO|started|listening|completed|完成|success|成功|已启动)\b/i.test(line)) {
    // Exclude connected/disconnected since they have dedicated handling in highlightLogKeywords
    safe = `<span class="term-info">${safe}</span>`;
  }

  const m = line.match(dateLike);
  if (m) {
    const prefix = escapeHtml(m[1]);
    safe = safe.replace(prefix, `<span class="term-date">${prefix}</span>`);
  }

  if (!line) safe = '&nbsp;';
  return `<span class="term-line">${safe}</span>`;
}

function appendColored(el, text, maxLines = UI_MAX_LINES_DEFAULT, autoscroll = true){
  if (!el) return;
  const raw = stripAnsi(String(text ?? '')).replace(/\r/g, '');
  const lines = raw.split('\n');
  const isLogPanel = /(^|-)log($|-)/i.test(String(el.id || '')) || String(el.id || '') === 'log-viewer';
  const renderLines = isLogPanel
    ? lines.filter((line) => String(line || '').trim() !== '')
    : lines;
  while (renderLines.length > 0 && renderLines[renderLines.length - 1] === '') renderLines.pop();

  // Process each line, support WebSocket log dedup (based on unique identifier)
  const processedLines = [];
  let skippedCount = 0;

  for (const line of renderLines) {
    const wsLogId = getWsLogId(line);

    if (!wsLogId) {
      // Non-WebSocket log, process directly
      processedLines.push(line);
      continue;
    }

    // Check whether this log entry has already been shown
    if (shownWsLogIds.has(wsLogId)) {
      // Already shown, skip
      skippedCount++;
      continue;
    }

    // New log entry, mark as shown
    shownWsLogIds.add(wsLogId);

    // Check state
    const wsInfo = parseWsLogLine(line);
    const state = wsInfo ? wsInfo.state : null;

    // If there are skipped logs, add a hint
    if (skippedCount > 0) {
      const skipHint = _t('    ... 跳过 {0} 条重复/已显示的日志', skippedCount);
      processedLines.push(skipHint);
      skippedCount = 0;
    }

    // Add this log entry
    processedLines.push(line);
    lastWsLogState = state;
  }

  if (processedLines.length === 0) {
    if (autoscroll) el.scrollTop = el.scrollHeight;
    return;
  }

  const html = processedLines.map(colorizeLine).join('');
  if (!html) return;

  el.insertAdjacentHTML('beforeend', html);

  const nodes = el.querySelectorAll('.term-line');
  if (nodes.length > maxLines) {
    for (let i = 0; i < nodes.length - maxLines; i++) {
      nodes[i].remove();
    }
  }
  if (autoscroll) el.scrollTop = el.scrollHeight;
}

function setColored(el, text, maxLines = UI_MAX_LINES_DEFAULT, autoscroll = true){
  if (!el) return;
  el.innerHTML = '';
  // Note: do not reset shownWsLogIds here, to support dedup across refresh cycles
  appendColored(el, text, maxLines, autoscroll);
}

function toast(title, detail=''){
  const old = q('.toast');
  if (old) old.remove();

  // Auto-translate toast messages via i18n
  const _t = typeof window.t === 'function' ? window.t : x => x;
  const tTitle = _t(title);
  const tDetail = _t(detail);

  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `
    <div class="t"><b>${escapeHtml(tTitle)}</b></div>
    <div class="s">${escapeHtml(tDetail)}</div>
  `;
  document.body.appendChild(el);

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.remove(), 3200);
}

function setNavUpdateDotVisible(id, visible){
  const dot = $(id);
  if (dot) dot.style.display = visible ? 'inline-block' : 'none';
}

// ------------------------
// Router / navigation
// ------------------------
const ROUTES = [
  { id: 'dashboard', title: _t('仪表盘') },
  { id: 'openclaw-engine', title: _t('OpenClaw 控制台') },
  { id: 'openclaw-ai', title: _t('接入模型配置') },
  { id: 'messaging', title: _t('消息平台') },
  { id: 'browser', title: _t('远端设备管理') },
  { id: 'plugins', title: _t('插件市场') },
  { id: 'app-center', title: _t('应用中心') },
  { id: 'terminal', title: _t('终端') },
  { id: 'settings', title: _t('系统设置') },
  { id: 'logs', title: _t('日志') },
];

function getRouteFromHash(){
  const h = (location.hash || '').replace('#','').trim();
  if (h === 'ai') return 'openclaw-ai';
  if (h === 'openclaw') return 'openclaw-engine';
  const found = ROUTES.find(r => r.id === h);
  return found ? found.id : 'dashboard';
}

function setActiveRoute(route){
  if (route !== 'openclaw-engine') stopGatewayStartupLogPulls();
  if (route !== 'browser' && deviceMgmtPollTimer) {
    clearInterval(deviceMgmtPollTimer);
    deviceMgmtPollTimer = null;
  }

  // nav active
  qa('#nav a').forEach(a => {
    const itemRoute = a.dataset.route;
    a.classList.toggle('active', itemRoute === route);
  });
  // pages
  qa('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + route));
  // title
  const page = $('page-' + route);
  $('page-title').textContent = page?.dataset?.title || (ROUTES.find(r => r.id===route)?.title ?? '');

  // close sidebar on mobile
  $('sidebar').classList.remove('open');

  // hooks
  if (route === 'dashboard') refreshStatus();
  if (route === 'openclaw-engine') { refreshOpenClaw(); }
  if (route === 'openclaw-ai') { loadAIConfig(); }
  if (route === 'messaging') { loadMessagingConfig(); }
  if (route === 'browser') startDeviceManagementPolling();
  if (route === 'plugins') refreshPlugins();
  if (route === 'app-center') refreshAppCenter();
  if (route === 'terminal') {
    bindTerminalInteraction();
    terminalConnect();
    ensureTerminalViewportFitted();
    setTimeout(() => ensureTerminalViewportFitted(), 120);
    setTimeout(() => ensureTerminalViewportFitted(), 600);
    focusTerminalInput();
  }
  if (route === 'settings') { renderDetectedTimezone(); checkForUpdate(); if (typeof window._bindSettingsLanguage === 'function') window._bindSettingsLanguage(); }
  if (route === 'logs') {
    // Reset WebSocket log dedup state
    shownWsLogIds.clear();
    lastWsLogState = null;
    refreshLogs();
  }
}

function renderDetectedTimezone(){
  const el = $('settings-tz-auto');
  if (!el) return;
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {}
  el.textContent = _t('{0}（自动探测）', timezone);
}

window.addEventListener('hashchange', ()=> setActiveRoute(getRouteFromHash()));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (getRouteFromHash() !== 'terminal') return;
  ensureTerminalViewportFitted();
  if (termWs && termWs.readyState === WebSocket.OPEN) return;
  if (termReconnectTimer) return;
  if (termFallbackTimer) {
    clearInterval(termFallbackTimer);
    termFallbackTimer = null;
  }
  terminalConnect();
});

window.addEventListener('focus', () => {
  if (getRouteFromHash() !== 'terminal') return;
  ensureTerminalViewportFitted();
  if (termWs && termWs.readyState === WebSocket.OPEN) return;
  if (termReconnectTimer) return;
  if (termFallbackTimer) {
    clearInterval(termFallbackTimer);
    termFallbackTimer = null;
  }
  terminalConnect();
});

const SIDEBAR_PREF_KEY = 'ocSidebarHidden';

function isMobileViewport(){
  return window.matchMedia('(max-width: 920px)').matches;
}

function getSavedSidebarHidden(){
  try {
    return localStorage.getItem(SIDEBAR_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function setDesktopSidebarHidden(hidden, { persist = true } = {}){
  const nextHidden = !!hidden;
  document.body.classList.toggle('sidebar-hidden', nextHidden);
  const btn = $('btn-hamburger');
  if (btn) {
    btn.textContent = nextHidden ? '☰' : '◧';
    btn.title = nextHidden ? _t('显示侧边栏') : _t('隐藏侧边栏');
    btn.setAttribute('aria-label', btn.title);
  }
  if (!persist) return;
  try {
    localStorage.setItem(SIDEBAR_PREF_KEY, nextHidden ? '1' : '0');
  } catch {}
}

function applySidebarPreference(){
  if (isMobileViewport()) {
    setDesktopSidebarHidden(false, { persist: false });
    return;
  }
  setDesktopSidebarHidden(getSavedSidebarHidden(), { persist: false });
}

$('btn-gateway-console')?.addEventListener('click', (e) => {
  e.preventDefault();
  (async () => {
    const r = await api('/api/openclaw/gateway-link', { timeoutMs: 6000 });
    if (r?.gatewayBusy || r?.gatewayReady === false) {
      toast(_t('Gateway 未就绪'), r?.hint || _t('Gateway 正在启动中，请稍候后再试'));
      return;
    }
    const target = r?.preferredUrl || r?.directUrl || r?.proxyUrl || '/gateway-proxy/';
    const popup = window.open(target, '_blank');
    if (!popup) {
      window.location.href = target;
      toast(_t('弹窗被拦截'), _t('已在当前页面打开 Gateway 控制台'));
    }
    if (r?.hint) {
      toast(_t('Gateway 提示'), r.hint);
    }
  })();
});

// mobile sidebar
$('btn-hamburger').addEventListener('click', ()=> {
  if (isMobileViewport()) {
    $('sidebar').classList.toggle('open');
    return;
  }
  setDesktopSidebarHidden(!document.body.classList.contains('sidebar-hidden'));
});
document.addEventListener('click', (e)=>{
  const sidebar = $('sidebar');
  if (!sidebar.classList.contains('open')) return;
  const btn = $('btn-hamburger');
  if (sidebar.contains(e.target) || btn.contains(e.target)) return;
  sidebar.classList.remove('open');
});
window.addEventListener('resize', applySidebarPreference);
applySidebarPreference();

// ------------------------
// Tabs (messaging + plugins)
// ------------------------
function bindTabs(containerId, tabAttr, panelSelector, panelAttr){
  const container = $(containerId);
  if (!container) return;
  container.addEventListener('click', (e)=>{
    const t = e.target.closest('.tab');
    if (!t) return;
    const val = t.getAttribute(tabAttr);
    qa('.tab', container).forEach(x => x.classList.toggle('active', x === t));
    qa(panelSelector).forEach(p => p.hidden = (p.getAttribute(panelAttr) !== val));
  });
}

bindTabs('msg-tabs', 'data-tab', '#msg-panels .msg-panel', 'data-panel');

// ------------------------
// Dashboard
// ------------------------
function formatUptime(sec){
  sec = Number(sec||0);
  const d = Math.floor(sec/86400);
  const h = Math.floor((sec%86400)/3600);
  const m = Math.floor((sec%3600)/60);
  if (d>0) return _t('{0}天 {1}小时', d, h);
  if (h>0) return _t('{0}小时 {1}分钟', h, m);
  return _t('{0}分钟', m);
}

async function refreshStatus(){
  if (window.__statusRefreshing) {
    dlog('refreshStatus skipped: previous request still running');
    return;
  }
  window.__statusRefreshing = true;
  const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  try {
    const s = await api('/api/status');
    if (s.error) {
      dlog('refreshStatus error:', s.error);
      return;
    }

  reconcileOcLogCacheForInstance(s.installInstanceId);

  const openclawMissing = s.openclawInstalled === false;
  const gatewayPending = !openclawMissing && !s.gateway && (s.gatewayStarting || s.gatewayProcessRunning);
  const gatewayPairing = !openclawMissing && !s.gateway && !!s.gatewayPairingRequired;
  if ($('kpi-gateway')) {
    $('kpi-gateway').innerHTML = s.gateway
      ? `<span class="pulse online"></span>${_t('在线')}`
      : (openclawMissing
          ? `<span class="pulse offline"></span>${_t('离线')}`
          : (gatewayPairing
              ? `<span class="pulse offline"></span>${_t('待配对')}`
              : (gatewayPending
                  ? `<span class="pulse pending"></span>${_t('启动中')}`
                  : `<span class="pulse offline"></span>${_t('离线')}`)));
  }
  const gatewayParts = [
    s.gateway
      ? _t('健康检查正常')
      : (openclawMissing
          ? _t('OpenClaw 已卸载')
          : (gatewayPairing
              ? _t('等待控制台配对')
              : (gatewayPending
                  ? _t('进程已拉起，等待健康检查')
                  : _t('未检测到运行中的 Gateway'))))
  ];
  if (!openclawMissing && !s.gateway && s.gatewayProcessRunning && Number(s.gatewayProcessUptimeSec || 0) > 0) {
    gatewayParts.push(_t('运行 {0}', formatUptime(s.gatewayProcessUptimeSec)));
  }
  if (s.gatewayWatchdog === false) {
    gatewayParts.push(_t('watchdog未运行'));
  }
  if (s.terminal) {
    if (s.terminal.ready) {
      const mode = s.terminal.mode || 'unknown';
      if (mode === 'pty') {
        gatewayParts.push(_t('终端: 正常(PTY)'));
      } else if (mode === 'fallback') {
        gatewayParts.push(_t('终端: 正常(兼容模式)'));
      } else {
        gatewayParts.push(_t('{0}: {1}({2})', _t('终端'), _t('正常'), mode));
      }
    } else {
      const reasonText = s.terminal.reason || _t('终端后端未就绪');
      gatewayParts.push(_t('{0}: {1}', _t('终端'), reasonText));
    }
  } else {
    gatewayParts.push(_t('终端: 状态未知'));
  }
  const terminalStatus = $('kpi-terminal-status');
  const terminalDetail = $('kpi-terminal-detail');
  if (terminalStatus && terminalDetail) {
    if (s.terminal?.ready) {
      const mode = s.terminal.mode || 'unknown';
      terminalStatus.innerHTML = `<span class="pulse online"></span>${_t('终端就绪')}`;
      terminalDetail.textContent = mode === 'pty' ? _t('交互模式：PTY') : _t('{0}：{1}', _t('交互模式'), mode);
    } else {
      terminalStatus.innerHTML = `<span class="pulse offline"></span>${_t('终端异常')}`;
      terminalDetail.textContent = s.terminal?.reason || _t('终端后端未就绪');
    }
  }
  if ($('kpi-gateway-sub')) $('kpi-gateway-sub').textContent = gatewayParts.join(' · ');

  if ($('kpi-caddy')) {
    $('kpi-caddy').innerHTML = s.caddy
      ? `<span class="pulse online"></span>${_t('在线')}`
      : `<span class="pulse offline"></span>${_t('离线/未启用')}`;
  }
  if ($('kpi-domain')) $('kpi-domain').textContent = s.domain ? _t('域名：{0}', s.domain) : _t('未配置域名');

  if ($('kpi-memory')) $('kpi-memory').textContent = s.memory?.total ? `${s.memory.used}/${s.memory.total}MB (${s.memory.percent}%)` : '—';
  if ($('kpi-uptime')) $('kpi-uptime').textContent = s.uptime ? _t('运行：{0}', formatUptime(s.uptime)) : '—';

  // Update sidebar footer
  const panelVer = formatVersionLabel(s.version) || '-';
  const ocVer = formatVersionLabel(s.openclawVersion) || '-';
  if ($('sidebar-version')) $('sidebar-version').textContent = _t('面板 {0}', panelVer);
  if ($('sidebar-oc-version')) $('sidebar-oc-version').textContent = `OpenClaw ${ocVer}`;
  const statusEl = $('sidebar-status');
  if (statusEl) {
    const online = !!s.gateway;
    const cls = online ? 'online' : 'offline';
    statusEl.innerHTML = `Gateway <span class="gw-label ${cls}">${online ? 'ONLINE' : 'OFFLINE'}</span>`;
  }

  // Remote device management tab is always visible
  const browserNav = document.querySelector('#nav a[data-route="browser"]');
  if (browserNav) {
    browserNav.style.display = '';
  }

    const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt;
    dlog('refreshStatus ok', 'elapsedMs=', Math.round(elapsed), 'gateway=', !!s.gateway, 'caddy=', !!s.caddy);
  } finally {
    window.__statusRefreshing = false;
  }
}

// ------------------------
// Update check
// ------------------------
async function checkForUpdate(force = false) {
  const u = await api(`/api/update/check${force ? '?force=1' : ''}`);
  if (u.error && !u.currentVersion) return;

  // Dashboard banner
  const banner = $('update-banner');
  if (banner && u.hasUpdate) {
    // New version found
    const tEl = $('update-banner-title');
    if (tEl) tEl.innerHTML = '🆕 ' + _t('发现新版本') + '：<span id="update-latest">' + escapeHtml(u.latestVersion || '') + '</span>';
    const curEl = $('update-banner-current');
    if (curEl) curEl.style.display = '';
    $('update-current').textContent = formatVersionLabel(u.currentVersion);
    const ulEl = $('update-link');
    if (ulEl) { ulEl.href = u.releaseUrl || '#'; ulEl.style.display = ''; }
    banner.style.display = '';
    const hotBtn = $('btn-hotpatch-banner');
    const fullHint = $('update-full-hint');
    const installNote = $('update-install-note');
    if (u.requiresFullUpdate) {
      if (hotBtn) hotBtn.style.display = 'none';
      if (fullHint) {
        fullHint.style.display = '';
        fullHint.style.color = '#ff9f0a';
        fullHint.innerHTML = '📦 <b>' + _t('需要完整更新') + '</b>：' + _t('请重新执行一键安装脚本');
      }
      if (installNote) installNote.style.display = '';
    } else {
      if (hotBtn) {
        hotBtn.style.display = '';
        hotBtn.textContent = _t('⚡ 热更新');
        hotBtn.onclick = () => doHotPatch(false);
      }
      if (fullHint) {
        fullHint.style.display = '';
        fullHint.style.color = '#30d158';
        fullHint.innerHTML = '⚡ <b>' + _t('可热更新') + '</b>：' + _t('点击“热更新”即可，无需重装容器') + '<br><span class="muted" style="font-size:11px">ℹ ' + _t('热更新仅应用容器内文件，安装脚本等宿主机文件需重新下载') + '</span>';
      }
      if (installNote) installNote.style.display = 'none';
    }
  } else if (banner && !u.hasUpdate && u.latestVersion) {
    // No new version: offer force hotpatch
    const tEl = $('update-banner-title');
    if (tEl) tEl.innerHTML = '✅ ' + _t('当前已是最新版本') + ' <span class="muted small">(' + escapeHtml(formatVersionLabel(u.currentVersion)) + ')</span>';
    const curEl = $('update-banner-current');
    if (curEl) curEl.style.display = 'none';
    const ulEl = $('update-link');
    if (ulEl) ulEl.style.display = 'none';
    banner.style.display = '';
    const hotBtn = $('btn-hotpatch-banner');
    const fullHint = $('update-full-hint');
    const installNote = $('update-install-note');
    if (hotBtn) {
      hotBtn.style.display = '';
      hotBtn.textContent = _t('⚡ 强制热更新');
      hotBtn.onclick = () => doHotPatch(true);
    }
    if (fullHint) {
      fullHint.style.display = '';
      fullHint.style.color = '#8e8e93';
      fullHint.innerHTML = _t('版本号相同，可强制同步远程文件');
    }
    if (installNote) installNote.style.display = 'none';
  } else if (banner) {
    banner.style.display = 'none';
  }

  // Sidebar red dot (system/container update only)
  setNavUpdateDotVisible('update-dot', !!u.hasUpdate);

  // Settings page
  if ($('settings-current-ver')) {
    $('settings-current-ver').textContent = formatVersionLabel(u.currentVersion) || '—';
    $('settings-latest-ver').textContent = u.latestVersion || '—';
    const statusEl = $('settings-update-status');
    const linkEl = $('settings-release-link');
    if (u.hasUpdate) {
      if (u.requiresFullUpdate) {
        statusEl.innerHTML = '<span style="color:#ff9f0a">📦 ' + _t('需要完整更新') + '</span>';
      } else {
        statusEl.innerHTML = '<span style="color:#30d158">⚡ ' + _t('可热更新') + '</span> <span class="muted" style="font-size:11px">(' + _t('仅容器内文件') + ')</span>';
      }
      if (linkEl && u.releaseUrl) { linkEl.href = u.releaseUrl; linkEl.style.display = ''; }
      // Show/hide hot update & full update hints on settings page
      const hpBtn = $('btn-hotpatch');
      const fullNote = $('settings-full-update-note');
      if (hpBtn) {
        hpBtn.style.display = u.requiresFullUpdate ? 'none' : '';
        if (!u.requiresFullUpdate) {
          hpBtn.textContent = _t('⚡ 热更新（不重启容器）');
          hpBtn.onclick = () => doHotPatch(false);
        }
      }
      if (fullNote) fullNote.style.display = u.requiresFullUpdate ? '' : 'none';
    } else if (u.latestVersion) {
      if (u.currentVersion === u.latestVersion) {
        // Same version: show force hotpatch button
        statusEl.innerHTML = '<span style="color:#f5f5f7">✅ ' + _t('已是最新') + ' (' + formatVersionLabel(u.currentVersion) + ')</span>';
        if (linkEl) linkEl.style.display = 'none';
        // Show force hot update button when version is same
        const hpBtn = $('btn-hotpatch');
        const fullNote = $('settings-full-update-note');
        if (hpBtn) {
          hpBtn.style.display = '';
          hpBtn.textContent = _t('⚡ 强制热更新');
          hpBtn.onclick = () => doHotPatch(true);
        }
        if (fullNote) {
          fullNote.style.display = '';
          fullNote.innerHTML = '<span style="color:#30d158">' + _t('版本号相同，点击强制热更新可重新同步远程文件') + '</span>';
        }
      } else {
        // No update available (local version newer)
        statusEl.innerHTML = '<span style="color:#f5f5f7">✅ ' + _t('已是最新') + '</span>';
        if (linkEl) linkEl.style.display = 'none';
        const hpBtn = $('btn-hotpatch');
        const fullNote = $('settings-full-update-note');
        if (hpBtn) hpBtn.style.display = 'none';
        if (fullNote) fullNote.style.display = 'none';
      }
    } else if (u.error) {
      // Error fetching update info
      let errMsg = u.error;
      if (errMsg.includes('curl fallback failed') || errMsg.includes('fetch') || errMsg.includes('GitHub')) {
        errMsg = _t('⚠️ 无法连接 GitHub（网络不可达）');
      }
      statusEl.innerHTML = `<span style="color:#ff6b6b">${errMsg}</span>`;
      if (linkEl) linkEl.style.display = 'none';
      const hpBtn = $('btn-hotpatch');
      if (hpBtn) hpBtn.style.display = 'none';
    }
  }

  return u;
}

$('btn-refresh-status').addEventListener('click', async ()=>{
  const btn = $('btn-refresh-status');
  if (!btn) return;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = _t('刷新中...');
  try {
    await refreshStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});
$('btn-restart-gateway')?.addEventListener('click', async ()=>{
  const r = await api('/api/restart', { method:'POST' });
  if (r.success) {
    toast(_t('已触发重启'), r.message || _t('Gateway 正在重启，请稍候'));
  } else {
    toast(_t('重启失败'), r.error || _t('请查看日志'));
  }
  setTimeout(refreshStatus, 2500);
});

if ($('btn-check-update')) {
  $('btn-check-update').addEventListener('click', async () => {
    $('btn-check-update').disabled = true;
    $('btn-check-update').textContent = _t('检查中...');
    await checkForUpdate(true);
    $('btn-check-update').disabled = false;
    $('btn-check-update').textContent = _t('检查更新');
  });
}

if ($('btn-hotpatch')) {
  $('btn-hotpatch').addEventListener('click', () => doHotPatch());
}

let hotpatchRestartPending = false;
let deviceMgmtPollTimer = null;
let deviceMgmtInteractionUntil = 0;

function markDeviceManagementInteracting(holdMs = 15000) {
  deviceMgmtInteractionUntil = Math.max(deviceMgmtInteractionUntil, Date.now() + holdMs);
}

function isDeviceManagementInteractionActive() {
  if (Date.now() < deviceMgmtInteractionUntil) return true;
  const pageEl = $('page-browser');
  const activeEl = document.activeElement;
  if (!pageEl || !activeEl || !pageEl.contains(activeEl)) return false;
  return !!activeEl.closest('input, textarea, select, button');
}

function setHotpatchButtons(disabled, text) {
  const btns = qa('[id^="btn-hotpatch"]');
  btns.forEach((b) => {
    b.disabled = !!disabled;
    if (typeof text === 'string') b.textContent = text;
  });
}

async function doHotPatch(force = false) {
  if (hotpatchRestartPending) {
    toast(_t('请稍候'), _t('后端重启中，恢复后可再次热更新'));
    return;
  }

  setHotpatchButtons(true, force ? _t('⏳ 强制更新中...') : _t('⏳ 更新中...'));

  const logBox = $('hotpatch-log');
  const logPre = logBox ? logBox.querySelector('pre') : null;
  if (logBox) { logBox.style.display = ''; }
  if (logPre) logPre.textContent = force ? _t('正在强制拉取最新文件...\n') : _t('正在拉取最新文件...\n');

  try {
    const r = await api('/api/update/hotpatch', { method: 'POST', body: { branch: 'main', force } });
    if (r.error) {
      toast(force ? _t('强制热更新失败') : _t('热更新失败'), r.error);
      setHotpatchButtons(false, force ? _t('⚡ 强制热更新') : _t('⚡ 热更新（不重启容器）'));
      return;
    }

    // Poll for completion
    let done = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const s = await api('/api/update/hotpatch/status');
        if (logPre && s.log) logPre.textContent = s.log;
        if (logPre) logPre.scrollTop = logPre.scrollHeight;
        if (s.status === 'done' || s.status === 'error') {
          done = true;
          if (s.status === 'done') {
            const updated = s.updated || [];
            const hasFrontend = updated.some(f => f.startsWith('web/public/'));
            const hasWebServer = updated.includes('web/server.js');
            const hasStartServices = updated.includes('start-services.sh');

            if (hasWebServer) {
              toast(_t('热更新完成'), _t('Web 面板将自动重启，约 5-15 秒可恢复'));
              if (logPre) logPre.textContent += _t('\n检测到 web/server.js 更新：Web 面板将自动重启，请等待 5-15 秒后重连。');
            } else {
              toast(_t('热更新完成'), _t('{0} 个文件已更新', updated.length));
            }

            if (hasStartServices && logPre) {
              logPre.textContent += _t('\n检测到 start-services.sh 更新：请在宿主机执行 `docker restart clawnook` 以使入口脚本变更生效。');
              logPre.textContent += _t('\n若容器名不确定：先执行 `docker ps --format "{{.Names}}"`，再执行 `docker restart <容器名>`。');
              toast(_t('请重启容器'), _t('执行: docker restart clawnook'));
            }

            if (hasFrontend || hasWebServer || updated.length === 0) {
              if (logPre) {
                logPre.textContent += hasWebServer
                  ? _t('\n检测到后端已更新，正在等待服务恢复后自动重查更新状态（不再强制Refresh页面）。')
                  : updated.length === 0
                  ? _t('\n所有文件已是最新，正在Refresh版本状态...')
                  : _t('\n前端文件已更新，将自动重查更新状态；如需立即加载新前端可手动Refresh页面。');
              }

              if (hasWebServer) {
                hotpatchRestartPending = true;
                setHotpatchButtons(true, _t('⏳ 后端重启中...'));
              }

              const waitMs = hasWebServer ? 30000 : 10000;
              const intervalMs = 2000;
              const deadline = Date.now() + waitMs;

              const recoverAndRecheck = async () => {
                while (Date.now() < deadline) {
                  await new Promise(r => setTimeout(r, intervalMs));
                  try {
                    const st = await api('/api/status');
                    if (st && !st.error) {
                      await refreshStatus();
                      await checkForUpdate(true);
                      if (hasWebServer) {
                        toast(_t('热更新完成'), _t('Web 面板已恢复，已自动Refresh更新状态'));
                        hotpatchRestartPending = false;
                        setHotpatchButtons(false, _t('⚡ 热更新（不重启容器）'));
                      }
                      return;
                    }
                  } catch {
                    // server may still be restarting
                  }
                }
                await checkForUpdate(true);
                if (hasWebServer) {
                  toast(_t('提示'), _t('Web 面板重启中，如状态未更新请稍后手动Refresh页面'));
                  hotpatchRestartPending = false;
                  setHotpatchButtons(false, _t('⚡ 热更新（不重启容器）'));
                }
              };

              recoverAndRecheck();
            } else {
              const recheckUpdateState = async () => {
                for (let t = 0; t < 8; t++) {
                  await new Promise(r => setTimeout(r, 2000));
                  const u = await checkForUpdate(true);
                  if (u && !u.error) break;
                }
              };
              recheckUpdateState();
            }
          } else {
            toast(_t('热更新失败'), s.log || '');
          }
          break;
        }
      } catch { /* server might be restarting */ }
    }
    if (!done) toast(_t('热更新超时'), _t('请稍后Check state'));
  } catch (e) {
    toast(_t('热更新失败'), e.message);
  } finally {
    if (!hotpatchRestartPending) {
      setHotpatchButtons(false, _t('⚡ 热更新（不重启容器）'));
    }
  }
}

// ------------------------
// OpenClaw install/update
// ------------------------
let ocPollTimer = null;
let ocRepairPollTimer = null;
let ocRepairRunning = false;
let ocInstallRunning = false;
let ocInstallPhase = 'auto';
let ocStartRunning = false;
let ocUninstallRunning = false;
let ocInstalled = false;
let ocGatewayRunning = false;
let ocHasUpdate = false;
let ocLatestKnown = false;
let ocInstallTaskRunningRemote = false;
let ocRepairTaskRunningRemote = false;
let ocGatewayRestartRunningRemote = false;
let ocGatewayStartingRemote = false;
let ocLastGatewaySnapshot = '';
let ocGatewayLogPollTimer = null;
let ocGatewayLogPollRunning = false;
let ocLogsBurstTimer = null;
let ocStatusTicker = null;
let ocStatusBaseText = _t('更新状态：自动检查中');
let ocStatusProgress = null;
let ocOperationType = 'idle';
let ocPostInstallWarmupUntil = 0;
let ocLabelTicker = null;
let ocStatusLoading = true;
let ocStatusLoadedOnce = false;

function resolveInstallPhase({
  installBusy = false,
  operationType = 'idle',
  localPhase = 'auto',
  installTaskRunning = false,
  installed = false
} = {}){
  if (!installBusy) return 'idle';
  const op = String(operationType || 'idle');
  if (op === 'installing') return 'install';
  if (op === 'updating') return 'update';
  if (op === 'uninstalling') return 'uninstall';
  if (localPhase === 'install' || localPhase === 'update') return localPhase;
  if (localPhase === 'uninstall') return 'uninstall';
  if (installTaskRunning) return 'install';
  return installed ? 'update' : 'install';
}

function syncOpenClawButtons(){
  const installBtn = $('btn-oc-install');
  const uninstallBtn = $('btn-oc-uninstall');
  const repairBtn = $('btn-oc-repair-config');
  const startBtn = $('btn-oc-start');
  const statusDetecting = !!ocStatusLoading && !ocStatusLoadedOnce;
  const installBusyRemote = (
    ocOperationType === 'installing'
    || ocOperationType === 'updating'
    || ocOperationType === 'uninstalling'
  );
  const installBusy = !!ocInstallRunning || !!ocUninstallRunning || !!installBusyRemote;
  const repairBusy = !!ocRepairRunning || !!ocRepairTaskRunningRemote;
  const restartBusy = !!ocStartRunning || !!ocGatewayRestartRunningRemote || !!ocGatewayStartingRemote;
  const canRestartGateway = !!ocInstalled || !!ocGatewayRunning;
  const installPhase = resolveInstallPhase({
    installBusy,
    operationType: ocOperationType,
    localPhase: ocInstallPhase,
    installTaskRunning: ocInstallTaskRunningRemote,
    installed: ocInstalled
  });
  const noUpdateNeeded = !!ocInstalled && !!ocLatestKnown && !ocHasUpdate;

  if (installBtn) {
    if (statusDetecting) {
      installBtn.textContent = _t('检测中...');
      installBtn.disabled = true;
    } else if (installBusy && installPhase === 'install') {
      installBtn.textContent = _t('安装中...');
      installBtn.disabled = true;
    } else if (installBusy && installPhase === 'update') {
      installBtn.textContent = _t('更新中...');
      installBtn.disabled = true;
    } else if (installBusy && installPhase === 'uninstall') {
      installBtn.textContent = ocInstalled ? _t('更新') : _t('安装');
      installBtn.disabled = true;
    } else {
      installBtn.textContent = ocInstalled ? (noUpdateNeeded ? _t('已是最新') : _t('更新')) : _t('安装');
      installBtn.disabled = !!repairBusy || (restartBusy && ocInstalled) || noUpdateNeeded;
    }
  }

  if (uninstallBtn) {
    uninstallBtn.textContent = statusDetecting ? _t('检测中...') : (installBusy && installPhase === 'uninstall' ? _t('卸载中...') : _t('卸载'));
    uninstallBtn.disabled = statusDetecting || !ocInstalled || !!installBusy || !!repairBusy || !!restartBusy;
  }

  if (repairBtn) {
    repairBtn.textContent = statusDetecting ? _t('检测中...') : (repairBusy ? _t('修复中...') : _t('配置恢复'));
    repairBtn.disabled = statusDetecting || !!installBusy || !!repairBusy || !!restartBusy;
  }

  if (startBtn) {
    startBtn.textContent = statusDetecting ? _t('检测中...') : (restartBusy ? _t('启动中...') : _t('重启 Gateway'));
    startBtn.disabled = statusDetecting || !!installBusy || !!repairBusy || !!restartBusy || !canRestartGateway;
  }

  const versionInstallBtn = $('btn-oc-install-version');
  const versionSelect = $('oc-version-select');
  const versionLoadBtn = $('btn-oc-load-versions');
  if (versionInstallBtn) {
    versionInstallBtn.disabled = statusDetecting || !!installBusy || !!repairBusy || !!restartBusy || !versionSelect?.value;
  }
  if (versionLoadBtn) {
    versionLoadBtn.disabled = statusDetecting || !!installBusy;
  }
  if (versionSelect) {
    versionSelect.disabled = statusDetecting || !!installBusy;
  }
}

// ------------------------
// Operation Log (oc-log) localStorage cache
// ------------------------
const OC_LOG_CACHE_KEY = 'oc_log_cache_v1';
const OC_LOG_CACHE_INSTANCE_KEY = 'oc_log_cache_instance_v1';
const OC_LOG_CACHE_MAX = 128 * 1024; // 128KB
let ocLogCacheBootstrapped = false;
let ocLogCacheInstanceId = '';

function saveOcLogCache(){
  try {
    const el = $('oc-log');
    if (!el) return;
    let html = el.innerHTML;
    if (html.length > OC_LOG_CACHE_MAX) {
      html = html.slice(-OC_LOG_CACHE_MAX);
    }
    localStorage.setItem(OC_LOG_CACHE_KEY, html);
    if (ocLogCacheInstanceId) {
      localStorage.setItem(OC_LOG_CACHE_INSTANCE_KEY, ocLogCacheInstanceId);
    }
  } catch {}
}

function loadOcLogCache(){
  try {
    const html = localStorage.getItem(OC_LOG_CACHE_KEY);
    const el = $('oc-log');
    if (!el || !html) return;
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  } catch {}
}

function clearOcLogCache(){
  try {
    localStorage.removeItem(OC_LOG_CACHE_KEY);
    localStorage.removeItem(OC_LOG_CACHE_INSTANCE_KEY);
  } catch {}
}

function reconcileOcLogCacheForInstance(instanceId){
  const normalizedInstanceId = String(instanceId || '').trim();
  if (!normalizedInstanceId) return;
  if (ocLogCacheBootstrapped && ocLogCacheInstanceId === normalizedInstanceId) return;

  const logEl = $('oc-log');
  const storedInstanceId = (() => {
    try {
      return String(localStorage.getItem(OC_LOG_CACHE_INSTANCE_KEY) || '').trim();
    } catch {
      return '';
    }
  })();

  ocLogCacheInstanceId = normalizedInstanceId;
  if (!storedInstanceId || storedInstanceId !== normalizedInstanceId) {
    clearOcLogCache();
    if (logEl) logEl.innerHTML = '';
    try {
      localStorage.setItem(OC_LOG_CACHE_INSTANCE_KEY, normalizedInstanceId);
    } catch {}
    ocLogCacheBootstrapped = true;
    return;
  }

  if (!ocLogCacheBootstrapped) {
    loadOcLogCache();
  }
  ocLogCacheBootstrapped = true;
}

function shouldAutoScroll(el, threshold = 24){
  if (!el) return true;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= threshold;
}

function appendOcLogLine(line){
  const logEl = $('oc-log');
  if (!logEl) return;
  appendColored(logEl, `${line}\n`, UI_OC_LOG_MAX_LINES, shouldAutoScroll(logEl));
  saveOcLogCache();
}

function appendOcLogBlock(text){
  const logEl = $('oc-log');
  if (!logEl) return;
  const chunk = String(text || '').trim();
  if (!chunk) return;
  appendColored(logEl, `${chunk}\n`, UI_OC_LOG_MAX_LINES, shouldAutoScroll(logEl));
  saveOcLogCache();
}

function formatRemainingTime(totalSec){
  const sec = Math.max(0, Number(totalSec || 0) | 0);
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function animatedDots(){
  const n = (Math.floor(Date.now() / 450) % 3) + 1;
  return '.'.repeat(n);
}

function setStatusBadge(elId, pulseClass, label, animate = false){
  const el = $(elId);
  if (!el) return;
  const baseLabel = String(label || '');
  const active = !!animate;
  const text = active ? `${baseLabel}${animatedDots()}` : baseLabel;
  el.dataset.ocPulse = String(pulseClass || 'offline');
  el.dataset.ocLabel = baseLabel;
  el.dataset.ocAnimate = active ? '1' : '0';
  el.innerHTML = `<span class="pulse ${el.dataset.ocPulse}"></span>${text}`;
  syncStatusLabelTicker();
}

function renderAnimatedStatusBadges(){
  ['oc-installed', 'oc-gateway'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    if (el.dataset.ocAnimate !== '1') return;
    const pulse = el.dataset.ocPulse || 'pending';
    const label = el.dataset.ocLabel || '';
    el.innerHTML = `<span class="pulse ${pulse}"></span>${label}${animatedDots()}`;
  });
}

function syncStatusLabelTicker(){
  const installedAnimating = $('oc-installed')?.dataset?.ocAnimate === '1';
  const gatewayAnimating = $('oc-gateway')?.dataset?.ocAnimate === '1';
  const needTicker = installedAnimating || gatewayAnimating;
  if (needTicker && !ocLabelTicker) {
    ocLabelTicker = setInterval(renderAnimatedStatusBadges, 500);
  } else if (!needTicker && ocLabelTicker) {
    clearInterval(ocLabelTicker);
    ocLabelTicker = null;
  }
}

function renderOpenClawStatusTicker(){
  const el = $('oc-update-status');
  if (!el) return;
  let text = ocStatusBaseText || _t('更新状态：自动检查中');
  const p = ocStatusProgress;
  if (p && p.active && Number(p.totalSec || 0) > 0 && Number(p.startedAt || 0) > 0) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Number(p.startedAt || 0)) / 1000));
    const remain = Math.max(0, Number(p.totalSec || 0) - elapsed);
    text += _t('（{0}）', _t('已耗时 {0} / 预计剩余 {1}', formatRemainingTime(elapsed), formatRemainingTime(remain)));
  } else if (p && p.active && Number(p.startedAt || 0) > 0) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Number(p.startedAt || 0)) / 1000));
    text += _t('（{0}）', _t('已耗时 {0}', formatRemainingTime(elapsed)));
  }
  el.textContent = text;
}

function setOpenClawStatusLine(baseText, progress){
  ocStatusBaseText = String(baseText || _t('更新状态：自动检查中'));
  ocStatusProgress = progress && progress.active ? {
    active: true,
    totalSec: Number(progress.totalSec || 0),
    startedAt: Number(progress.startedAt || 0)
  } : null;
  if (ocStatusTicker) {
    clearInterval(ocStatusTicker);
    ocStatusTicker = null;
  }
  renderOpenClawStatusTicker();
  if (ocStatusProgress && ocStatusProgress.active) {
    ocStatusTicker = setInterval(renderOpenClawStatusTicker, 500);
  }
}

async function loadGatewayStartupLogs(lines = 160){
  // Startup logs no longer shown in op log panel; only update internal snapshot tracking
  try {
    const r = await api(`/api/openclaw/gateway/logs?lines=${Math.max(20, Math.min(lines, 1200))}`, { timeoutMs: 12000 });
    const snapshot = String(r?.logs || '').trim();
    if (r?.success && snapshot) {
      ocLastGatewaySnapshot = snapshot;
    }
  } catch (e) {
    // Fail silently, do not flush logs
  }
}

function stopGatewayStartupLogPulls(){
  if (ocGatewayLogPollTimer) clearInterval(ocGatewayLogPollTimer);
  ocGatewayLogPollTimer = null;
  ocGatewayLogPollRunning = false;
}

function applyGatewayRestartingUi(){
  setStatusBadge('oc-gateway', 'pending', _t('启动中'), true);
  setOpenClawStatusLine(_t('更新状态：Gateway 启动中'), { active: true, startedAt: Date.now(), totalSec: 60 });
}

function triggerLogsBurstPolling(durationMs = 18000, intervalMs = 1200){
  if (ocLogsBurstTimer) {
    clearInterval(ocLogsBurstTimer);
    ocLogsBurstTimer = null;
  }
  const startedAt = Date.now();
  const tick = async () => {
    if ((Date.now() - startedAt) > durationMs) {
      if (ocLogsBurstTimer) clearInterval(ocLogsBurstTimer);
      ocLogsBurstTimer = null;
      return;
    }
    await refreshLogs();
  };
  void tick();
  ocLogsBurstTimer = setInterval(() => { void tick(); }, Math.max(600, intervalMs));
}

function scheduleGatewayStartupLogPulls(lines = 200){
  stopGatewayStartupLogPulls();
  let tries = 0;
  const maxTries = 48;
  const tick = async () => {
    if (ocGatewayLogPollRunning) return;
    ocGatewayLogPollRunning = true;
    try {
      await loadGatewayStartupLogs(lines);
      const st = await refreshOpenClaw({ retries: 0 });
      tries += 1;
      if ((st && !st.error && st.gatewayRunning) || tries >= maxTries) {
        stopGatewayStartupLogPulls();
      }
      void refreshLogs();
    } finally {
      ocGatewayLogPollRunning = false;
    }
  };
  setTimeout(() => { void tick(); }, 1200);
  ocGatewayLogPollTimer = setInterval(() => { void tick(); }, 5000);
}

async function refreshOpenClaw(opts = {}){
  const initialLoading = !ocStatusLoadedOnce;
  if (initialLoading) {
    ocStatusLoading = true;
    setStatusBadge('oc-installed', 'pending', _t('检测中'), true);
    setStatusBadge('oc-gateway', 'pending', _t('检测中'), true);
    setOpenClawStatusLine(_t('更新状态：正在检测 OpenClaw 状态'), null);
    syncOpenClawButtons();
  }
  const retries = Math.max(0, Number(opts.retries ?? 0));
  const openclawStatusTimeoutMs = Math.max(2000, Number(opts.timeoutMs ?? 30000));
  const forceParam = opts.force ? '?force=1' : '';
  let d = null;
  let lastErr = '';

  for (let i = 0; i <= retries; i++) {
    d = await api(`/api/openclaw${forceParam}`, { timeoutMs: openclawStatusTimeoutMs });
    if (d && !d.error && Object.prototype.hasOwnProperty.call(d, 'installed')) break;
    lastErr = d?.error || _t('接口返回异常');
    if (i < retries) {
      await new Promise((resolve) => setTimeout(resolve, 350 * (i + 1)));
    }
  }

  if (!d || d.error || !Object.prototype.hasOwnProperty.call(d, 'installed')) {
    const detail = lastErr || _t('状态读取失败');
    setOpenClawStatusLine(_t('更新状态：读取失败') + `（${detail}）`, null);
    if (initialLoading) {
      ocStatusLoadedOnce = true;
      ocStatusLoading = false;
      syncOpenClawButtons();
    }
    return { error: detail };
  }

  ocStatusLoadedOnce = true;
  ocStatusLoading = false;

  const opType = String(d?.operationState?.type || 'idle');
  const opProgressRaw = d?.operationProgress && d.operationProgress.active ? d.operationProgress : null;
  const opProgress = opProgressRaw ? {
    active: true,
    startedAt: Number(opProgressRaw.startedAt || d?.operationState?.startedAt || Date.now()),
    totalSec: Number(opProgressRaw.totalSec || 0)
  } : null;
  const installBusyRemoteNow = (
    opType === 'installing'
    || opType === 'updating'
    || opType === 'uninstalling'
  );
  const installBusyNow = !!ocInstallRunning || !!ocUninstallRunning || !!installBusyRemoteNow || opType === 'installing' || opType === 'updating' || opType === 'uninstalling';
  const installPhaseNow = resolveInstallPhase({
    installBusy: installBusyNow,
    operationType: opType,
    localPhase: ocInstallPhase,
    installTaskRunning: !!d.installTaskRunning,
    installed: !!d.installed
  });
  const restartBusyNow = !!ocStartRunning || !!d.gatewayRestartRunning || opType === 'restarting_gateway';
  const uninstallBusyNow = !!ocUninstallRunning || opType === 'uninstalling';
  const repairBusyNow = !!ocRepairRunning || !!d.repairTaskRunning || opType === 'repairing_config';
  const postInstallWarmup = Date.now() < Number(ocPostInstallWarmupUntil || 0);

  if (installBusyNow && installPhaseNow === 'install') {
    setStatusBadge('oc-installed', 'pending', _t('安装中'), true);
  } else if (installBusyNow && installPhaseNow === 'update') {
    setStatusBadge('oc-installed', 'pending', _t('更新中'), true);
  } else if (installBusyNow && installPhaseNow === 'uninstall') {
    setStatusBadge('oc-installed', 'pending', _t('卸载中'), true);
  } else {
    setStatusBadge('oc-installed', d.installed ? 'online' : 'offline', d.installed ? _t('已安装') : _t('未安装'), false);
  }
  if (d.installed) {
    const versionLabel = formatVersionLabel(d.version);
    if (d.version && d.latestVersion && d.hasUpdate) {
      $('oc-version').textContent = _t('{0}：{1}（{2}）', _t('版本'), versionLabel, _t('可更新到 {0}', d.latestVersion));
    } else if (d.version) {
      $('oc-version').textContent = _t('{0}：{1}', _t('版本'), versionLabel);
    } else {
      $('oc-version').textContent = _t('{0}：{1}（{2}）', _t('版本'), _t('待识别'), formatInstallSourceLabel(d.installSource));
    }
  } else {
    $('oc-version').textContent = '—';
  }
  if (!d.installed && !d.gatewayRunning && !restartBusyNow) {
    setStatusBadge('oc-gateway', 'offline', _t('未安装'), false);
  } else if (restartBusyNow) {
    setStatusBadge('oc-gateway', 'pending', _t('启动中'), true);
  } else if (!d.gatewayRunning && d.gatewayStarting) {
    setStatusBadge('oc-gateway', 'pending', _t('启动中（初始化中）'), true);
  } else if (!d.gatewayRunning && postInstallWarmup && d.gatewayProcessRunning) {
    setStatusBadge('oc-gateway', 'pending', _t('启动中'), true);
  } else if (!d.gatewayRunning && d.gatewayPairingRequired) {
    setStatusBadge('oc-gateway', 'offline', _t('待配对（控制台鉴权）'), false);
  } else if (!d.gatewayRunning && d.gatewayProcessRunning) {
    setStatusBadge('oc-gateway', 'pending', _t('启动中（初始化中）'), true);
  } else {
    setStatusBadge('oc-gateway', d.gatewayRunning ? 'online' : 'offline', d.gatewayRunning ? _t('运行中') : _t('未启动'), false);
  }

  if (d.gatewayRunning) {
    ocPostInstallWarmupUntil = 0;
  }

  const displayLatestVersion = d.latestVersion || ((d.installed && d.version && !d.hasUpdate) ? d.version : '');

  ocInstalled = !!d.installed;
  ocGatewayRunning = !!d.gatewayRunning;
  ocHasUpdate = !!d.hasUpdate;
  setNavUpdateDotVisible('openclaw-update-dot', !!d.hasUpdate);
  ocLatestKnown = !!displayLatestVersion;
  ocInstallTaskRunningRemote = !!d.installTaskRunning;
  ocRepairTaskRunningRemote = !!d.repairTaskRunning;
  ocGatewayRestartRunningRemote = !!d.gatewayRestartRunning;
  ocGatewayStartingRemote = !!d.gatewayStarting;
  ocOperationType = opType;

  const actionBtn = $('btn-oc-install');
  if (actionBtn) {
    if (installBusyNow && installPhaseNow === 'install') actionBtn.textContent = _t('安装中...');
    else if (installBusyNow && installPhaseNow === 'update') actionBtn.textContent = _t('更新中...');
    else if (d.installed && !d.hasUpdate) actionBtn.textContent = _t('已是最新');
    else actionBtn.textContent = d.installed ? _t('更新') : _t('安装');
  }

  if ($('oc-current-ver')) {
    const currentVer = formatVersionLabel(d.version) || '—';
    $('oc-current-ver').textContent = currentVer;
  }
  if ($('oc-latest-ver')) {
    if (displayLatestVersion) {
      $('oc-latest-ver').textContent = displayLatestVersion;
    } else if (d.updateCheckError) {
      $('oc-latest-ver').textContent = _t('{0}（{1}）', _t('检测失败'), d.updateCheckError);
    } else {
      $('oc-latest-ver').textContent = _t('检测中');
    }
  }
  const invalidKeys = Array.isArray(d.invalidConfigKeys) ? d.invalidConfigKeys : [];
  const noLinuxPrebuilt = d.hasLinuxBinaryAsset === false;
  if (installBusyNow && installPhaseNow === 'install') {
    setOpenClawStatusLine(_t('更新状态：安装中'), opProgress);
  } else if (installBusyNow && installPhaseNow === 'update') {
    setOpenClawStatusLine(_t('更新状态：更新中'), opProgress);
  } else if (uninstallBusyNow || (installBusyNow && installPhaseNow === 'uninstall')) {
    setOpenClawStatusLine(_t('更新状态：卸载中'), opProgress);
  } else if (restartBusyNow) {
    setOpenClawStatusLine(_t('更新状态：Gateway 启动中'), opProgress);
  } else if (repairBusyNow) {
    setOpenClawStatusLine(_t('更新状态：配置恢复中'), opProgress);
  } else if (invalidKeys.length > 0) {
    setOpenClawStatusLine(_t('配置状态：检测到无效 key') + `（${invalidKeys.join(', ')}）`, null);
  } else if (noLinuxPrebuilt && !d.installed) {
    setOpenClawStatusLine(_t('安装提示：将使用官方 npm 安装'), null);
  } else if (!d.installed) {
    setOpenClawStatusLine(_t('更新状态：未安装，可执行安装'), null);
  } else if (!d.gatewayRunning && d.gatewayStarting && d.discordConnectError) {
    setOpenClawStatusLine(_t('Gateway 状态：启动中') + `（${d.discordConnectError}）`, null);
  } else if (!d.gatewayRunning && d.gatewayStarting) {
    setOpenClawStatusLine(_t('Gateway 状态：启动中（正在等待健康检查）'), null);
  } else if (!d.gatewayRunning && postInstallWarmup && d.gatewayProcessRunning) {
    setOpenClawStatusLine(_t('Gateway 状态：启动中（安装完成后Initialize中）'), null);
  } else if (!d.gatewayRunning && d.gatewayPairingRequired) {
    setOpenClawStatusLine(_t('Gateway 状态：等待控制台配对。请先在Gateway页面完成配对授权'), null);
  } else if (!d.gatewayRunning && d.gatewayProcessRunning && d.discordConnectError) {
    setOpenClawStatusLine(_t('Gateway 状态：初始化中') + `（${d.discordConnectError}）`, null);
  } else if (!d.gatewayRunning && d.gatewayProcessRunning) {
    setOpenClawStatusLine(_t('Gateway 状态：启动中（Initialize中，等待健康检查）'), null);
  } else if (d.installed && !d.version) {
    setOpenClawStatusLine(_t('更新状态：已安装（版本待识别）'), null);
  } else if (d.updateCheckError) {
    setOpenClawStatusLine(_t('更新状态：检查失败') + `（${d.updateCheckError}）`, null);
  } else if (d.hasUpdate) {
    setOpenClawStatusLine(_t('更新状态：发现新版本，可更新'), null);
  } else if (d.installed && d.gatewayRunning && d.discordConnectError) {
    setOpenClawStatusLine(_t('ℹ️ Discord {0}：{1}', _t('连接问题'), d.discordConnectError), null);
  } else if (d.installed) {
    setOpenClawStatusLine(_t('更新状态：已是最新版本'), null);
  } else {
    setOpenClawStatusLine(_t('更新状态：自动检查中'), null);
  }

  // pairing section is now always visible on the messaging page

  syncOpenClawButtons();

  return d;
}

async function pollTask(taskId){
  if (ocPollTimer) clearInterval(ocPollTimer);

  let lastSeq = 0;
  let errorStreak = 0;
  let errorBackoffMs = 2000; // C8: Exponential backoff initial value (DFMEA F2)
  const startedAt = Date.now();
  let lastHeartbeatAt = 0;
  const initialPhase = ocInstallPhase;
  const POLL_TOTAL_TIMEOUT_MS = 120000; // C8: Total timeout 120s (DFMEA F2)

  const schedulePoll = () => {
    if (ocPollTimer) clearTimeout(ocPollTimer);
    ocPollTimer = setTimeout(tick, errorStreak > 0 ? errorBackoffMs : 1500);
  };

  const tick = async () => {
    const st = await api('/api/openclaw/install/' + taskId + '?since=' + lastSeq, { timeoutMs: 20000 });
    if (!st || st.error) {
      errorStreak += 1;
      errorBackoffMs = Math.min(errorBackoffMs * 2, 30000); // C8: Exponential backoff, max 30s
      const totalErrorMs = Date.now() - startedAt;
      if (totalErrorMs > POLL_TOTAL_TIMEOUT_MS && errorStreak >= 3) {
        if (ocPollTimer) clearTimeout(ocPollTimer);
        ocPollTimer = null;
        ocInstallRunning = false;
        ocUninstallRunning = false;
        ocInstallPhase = 'auto';
        syncOpenClawButtons();
        const detail = st?.error || _t('任务状态轮询失败');
        appendOcLogLine(_t('❌ 轮询中断: {0}（连续失败{1}次，总耗时{2}s）', detail, errorStreak, Math.round(totalErrorMs/1000)));
        toast(_t('任务状态异常'), detail);
      } else {
        schedulePoll();
      }
      return;
    }
    errorStreak = 0;
    errorBackoffMs = 2000; // C8: reset backoff on success

    if ((Date.now() - startedAt) > 18 * 60 * 1000) {
      if (ocPollTimer) clearTimeout(ocPollTimer);
      ocPollTimer = null;
      ocInstallRunning = false;
      ocUninstallRunning = false;
      ocInstallPhase = 'auto';
      syncOpenClawButtons();
      appendOcLogLine(_t('⚠️ 任务执行超时，请检查日志并按需重试'));
      toast(_t('任务超时'), _t('执行超过 18 分钟，已停止前端轮询'));
      return;
    }

    // C11: Op log window shows only key milestones; detailed output kept in backend logs
    lastSeq = Number(st.seq || lastSeq || 0);

    const now = Date.now();
    if (now - lastHeartbeatAt >= 5000) {
      lastHeartbeatAt = now;
      await refreshOpenClaw({ retries: 0 });
    }

    if (st.status && st.status !== 'running'){
      clearTimeout(ocPollTimer);
      ocPollTimer = null;
      ocInstallRunning = false;
      ocUninstallRunning = false;
      const taskOp = String(st.operationType || '').trim() || (initialPhase === 'uninstall' ? 'uninstalling' : (initialPhase === 'update' ? 'updating' : 'installing'));
      const opLabel = taskOp === 'uninstalling' ? _t('卸载') : (taskOp === 'updating' ? _t('更新') : _t('安装'));
      ocInstallPhase = 'auto';
      syncOpenClawButtons();
      appendOcLogLine(st.status === 'success' ? _t('✅ {0}完成', opLabel) : _t('❌ {0}失败', opLabel));
      const successDetail = taskOp === 'uninstalling'
        ? _t('OpenClaw 已卸载')
        : (taskOp === 'updating' ? _t('OpenClaw 已更新，Gateway 正在自动重启') : _t('OpenClaw 已安装，Gateway 正在自动重启'));
      toast(st.status === 'success' ? _t('完成') : _t('失败'), st.status === 'success' ? successDetail : (st.error || st.log || _t('请查看日志')));
      if (st.status === 'success' && taskOp !== 'uninstalling') {
        appendOcLogLine(_t('⏳ Gateway 正在自动重启，状态栏将实时更新...'));
        ocPostInstallWarmupUntil = Date.now() + (5 * 60 * 1000);
        ocLastGatewaySnapshot = '';
        setStatusBadge('oc-gateway', 'pending', _t('启动中'), true);
        setOpenClawStatusLine(_t('更新状态：Gateway 启动中'), { active: true, startedAt: Date.now(), totalSec: 60 });
        scheduleGatewayStartupLogPulls(220);
      }
      refreshOpenClaw({ force: true });
      refreshStatus();
      return; // C8: task finished, stop scheduling next poll
    }
    schedulePoll(); // C8: Schedule next poll
  };

  await tick();
}

async function pollRepairTask(taskId){
  if (ocRepairPollTimer) clearInterval(ocRepairPollTimer);
  const repairBtn = $('btn-oc-repair-config');
  ocRepairRunning = true;
  if (repairBtn) {
    repairBtn.disabled = true;
    repairBtn.textContent = _t('修复中...');
  }
  let lastSeq = 0;
  let errorStreak = 0;
  const startedAt = Date.now();

  const tick = async () => {
    const st = await api('/api/openclaw/config/repair/' + taskId + '?since=' + lastSeq);
    if (!st || st.error) {
      errorStreak += 1;
      if (errorStreak >= 8) {
        if (ocRepairPollTimer) clearInterval(ocRepairPollTimer);
        ocRepairPollTimer = null;
        ocRepairRunning = false;
        if (repairBtn) {
          repairBtn.disabled = false;
          repairBtn.textContent = _t('配置恢复');
        }
        syncOpenClawButtons();
        toast(_t('任务状态异常'), st?.error || _t('配置恢复状态轮询失败'));
      }
      return;
    }
    errorStreak = 0;

    if ((Date.now() - startedAt) > 8 * 60 * 1000) {
      if (ocRepairPollTimer) clearInterval(ocRepairPollTimer);
      ocRepairPollTimer = null;
      ocRepairRunning = false;
      if (repairBtn) {
        repairBtn.disabled = false;
        repairBtn.textContent = _t('配置恢复');
      }
      syncOpenClawButtons();
      toast(_t('任务超时'), _t('配置恢复执行超过 8 分钟，已停止前端轮询'));
      return;
    }

    if (st.delta) {
      appendColored($('oc-log'), st.delta, UI_OC_LOG_MAX_LINES, shouldAutoScroll($('oc-log')));
      saveOcLogCache();
    }
    lastSeq = Number(st.seq || lastSeq || 0);

    if (st.status && st.status !== 'running') {
      if (ocRepairPollTimer) clearInterval(ocRepairPollTimer);
      ocRepairPollTimer = null;
      ocRepairRunning = false;
      if (repairBtn) {
        repairBtn.disabled = false;
        repairBtn.textContent = _t('配置恢复');
      }
      syncOpenClawButtons();
      if (st.status === 'success') {
        toast(_t('配置恢复完成'), st.changed ? _t('已修复并建议重启 Gateway') : _t('未发现需要修复的配置项'));
      } else {
        toast(_t('配置恢复失败'), st.error || _t('请查看日志'));
      }
      setTimeout(refreshOpenClaw, 800);
    }
  };

  await tick();
  ocRepairPollTimer = setInterval(tick, 700);
}

$('btn-oc-refresh').addEventListener('click', async ()=>{
  appendOcLogLine(_t('🔄 正在Refresh状态...'));
  const r = await refreshOpenClaw({ retries: 1 });
  if (r?.error) {
    appendOcLogLine(_t('❌ 状态Refresh失败：{0}', r.error));
    toast(_t('状态Refresh失败'), r.error);
  } else {
    const ver = r?.version ? formatVersionLabel(r.version) : _t('未知');
    const gw = r?.gatewayRunning ? _t('运行中') : _t('未启动');
    appendOcLogLine(_t('✅ 状态已Refresh（版本：{0}，Gateway：{1}）', ver, gw));
  }
});

// --- Config Export ---
$('btn-oc-config-export')?.addEventListener('click', async () => {
  const btn = $('btn-oc-config-export');
  if (btn) { btn.disabled = true; btn.textContent = _t('导出中...'); }
  appendOcLogLine(_t('[export] 正在打包配置文件...'));
  try {
    const resp = await fetch('/api/openclaw/config/export', {
      credentials: 'same-origin'
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || _t('导出失败'));
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('content-disposition') || '';
    const fnMatch = cd.match(/filename="?([^"]+)"?/);
    const defaultName = fnMatch ? fnMatch[1] : 'openclaw-config.tar.gz';
    // Try File System Access API (lets user pick save location)
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types: [{ description: _t('tar.gz 压缩包'), accept: { 'application/gzip': ['.tar.gz', '.tgz'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast(_t('配置导出'), _t('已保存配置压缩包'));
        appendOcLogLine(_t('[export] 配置已导出: ') + handle.name);
      } catch (PickerErr) {
        if (PickerErr.name === 'AbortError') {
          appendOcLogLine(_t('[export] 用户取消保存'));
        } else throw PickerErr;
      }
    } else {
      // Fallback: auto download
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = defaultName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(_t('配置导出'), _t('已下载配置压缩包'));
      appendOcLogLine(_t('[export] 配置已导出: ') + defaultName);
    }
  } catch (e) {
    toast(_t('导出失败'), e.message);
    appendOcLogLine(_t('[export] 导出失败: ') + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📤 ' + _t('配置导出'); }
  }
});

// --- Config Import ---
$('btn-oc-config-import')?.addEventListener('click', () => {
  const fileInput = $('config-import-file');
  if (!fileInput) return;
  // macOS file picker may grey out files with compound extensions (.tar.gz),
  // so clear accept to show all files and rely on JS validation instead
  fileInput.accept = '';
  fileInput.click();
});

$('config-import-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = ''; // reset for re-select
  if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz') && !file.name.endsWith('.tar')) {
    toast(_t('格式错误'), _t('请选择 .tar.gz、.tgz 或 .tar 文件'));
    return;
  }
  const importContentType = file.name.endsWith('.tar') && !file.name.endsWith('.tar.gz')
    ? 'application/x-tar' : 'application/gzip';
  if (!confirm(_t('导入配置将覆盖当前配置（会自动备份当前配置）。\n导入后需点击“重启 Gateway”使配置生效。\n\n确定继续？'))) return;
  const btn = $('btn-oc-config-import');
  if (btn) { btn.disabled = true; btn.textContent = _t('导入中...'); }
  try {
    const resp = await fetch('/api/openclaw/config/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': importContentType },
      body: file
    });
    const r = await resp.json();
    if (!resp.ok || r.error) throw new Error(r.error || _t('导入失败'));
    toast(_t('配置导入'), _t('已恢复: ') + (r.restoredFiles || []).join(', '));
    appendOcLogLine(_t('[import] 配置已导入: ') + (r.restoredFiles || []).join(', ') + _t(' (已备份到 ') + (r.backupName || '') + ')');
    appendOcLogLine(_t('[import] 请点击“重启 Gateway”使配置生效。'));
  } catch (e) {
    toast(_t('导入失败'), e.message);
    appendOcLogLine(_t('[import] 导入失败: ') + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 ' + _t('配置导入'); }
  }
});

// --- Migration Export ---
$('btn-migration-export')?.addEventListener('click', async () => {
  const btn = $('btn-migration-export');
  if (btn) { btn.disabled = true; btn.textContent = _t('打包中...'); }
  appendOcLogLine(_t('[migration] 正在导出全量迁移数据（配置+密钥+身份+设备+工作空间+会话历史）...'));
  try {
    const resp = await fetch('/api/openclaw/migration/export', { credentials: 'same-origin' });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || _t('导出失败'));
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('content-disposition') || '';
    const fnMatch = cd.match(/filename="?([^"]+)"?/);
    const defaultName = fnMatch ? fnMatch[1] : 'openclaw-migration.tar.gz';
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types: [{ description: _t('tar.gz 压缩包'), accept: { 'application/gzip': ['.tar.gz', '.tgz'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast(_t('迁移导出'), _t('已保存迁移包: ') + handle.name);
        appendOcLogLine(_t('[migration] 迁移包已导出: ') + handle.name + ' (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)');
      } catch (PickerErr) {
        if (PickerErr.name === 'AbortError') appendOcLogLine(_t('[migration] 用户取消保存'));
        else throw PickerErr;
      }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = defaultName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(_t('迁移导出'), _t('已下载迁移包'));
      appendOcLogLine(_t('[migration] 迁移包已下载: ') + defaultName + ' (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)');
    }
  } catch (e) {
    toast(_t('导出失败'), e.message);
    appendOcLogLine(_t('[migration] 导出失败: ') + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚚 ' + _t('迁移导出'); }
  }
});

// --- Migration Import ---
$('btn-migration-import')?.addEventListener('click', () => {
  const fileInput = $('migration-import-file');
  if (!fileInput) return;
  fileInput.accept = '';
  fileInput.click();
});

$('migration-import-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';
  if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
    toast(_t('格式错误'), _t('请选择 .tar.gz 迁移包'));
    return;
  }
  if (!confirm(_t('⚠️ 迁移导入将覆盖当前容器的 OpenClaw 应用数据：\n\n') +
    _t('• 配置文件（模型、渠道、安全策略）\n') +
    _t('• 加密密钥（.enc_key）\n') +
    _t('• 设备身份和已配对 Node\n') +
    _t('• 工作空间（SOUL.md 等 Agent 人格文件、脚本）\n') +
    _t('• Agent 会话历史\n') +
    _t('• 定时任务和执行记录\n\n') +
    _t('不会覆盖容器配置（SSH、端口、域名等）。\n') +
    _t('导入前会自动备份当前数据到 /tmp/。\n') +
    _t('导入后必须重启 Gateway 才能生效。\n\n确定继续？'))) return;
  const btn = $('btn-migration-import');
  if (btn) { btn.disabled = true; btn.textContent = _t('导入中...'); }
  appendOcLogLine(_t('[migration] 正在导入迁移数据: ') + file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)...');
  try {
    const resp = await fetch('/api/openclaw/migration/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/gzip' },
      body: file
    });
    const r = await resp.json();
    if (!resp.ok || r.error) throw new Error(r.error || _t('导入失败'));
    toast(_t('迁移导入成功'), _t('已恢复 ') + (r.restoredFiles || []).length + _t(' 项数据'));
    appendOcLogLine(_t('[migration] 导入完成: ') + (r.restoredFiles || []).join(', '));
    appendOcLogLine(_t('[migration] 原数据已备份到: ') + (r.preImportBackup || ''));
    appendOcLogLine(_t('[migration] ⚠️ 请点击「重启 Gateway」使迁移数据生效！'));
  } catch (e) {
    toast(_t('导入失败'), e.message);
    appendOcLogLine(_t('[migration] 导入失败: ') + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚚 ' + _t('迁移导入'); }
  }
});

$('btn-oc-repair-config')?.addEventListener('click', async ()=>{
  if (ocInstallRunning || ocInstallTaskRunningRemote || ocStartRunning || ocGatewayRestartRunningRemote) {
    toast(_t('任务进行中'), _t('安装/更新或Gateway重启执行中，暂不可配置恢复'));
    return;
  }
  if (ocRepairRunning) {
    appendOcLogLine(_t('[restore] 配置恢复任务进行中，请勿重复触发。'));
    return;
  }
  ocRepairRunning = true;
  syncOpenClawButtons();
  appendOcLogLine(_t('[restore] 正在读取配置备份列表...'));
  try {
    const list = await api('/api/openclaw/config/backups', { timeoutMs: 30000 });
    if (!list || list.error || !Array.isArray(list.backups)) {
      throw new Error(list?.error || _t('备份列表读取失败'));
    }
    if (list.backups.length === 0) {
      appendOcLogLine(_t('[restore] 未找到可用备份文件。'));
      toast(_t('配置恢复'), _t('未找到备份文件'));
      return;
    }

    // Build the backup selection list
    const shown = list.backups.slice(0, 15);
    const hint = shown.map((item, idx) => {
      const dateStr = item.name.replace('snapshot-', '').replace(/^openclaw-/, '').replace(/\.json$/, '').replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5:$6');
      const fileNames = (item.files || []).map(f => f.name).join(', ');
      return `${idx + 1}. ${dateStr}  [${fileNames}]`;
    }).join('\n');
    const input = window.prompt(
      _t('配置恢复说明：\n') +
      _t('1) 选择一个备份时间点\n') +
      _t('2) 多文件备份可选择恢复全部或单个文件\n') +
      _t('3) 恢复后需点击"重启 Gateway"使配置生效\n\n') +
      _t('可用备份：\n{0}\n{1}\n{2}\n', '─'.repeat(40), hint, '─'.repeat(40)) +
      _t('输入序号选择：'), '1');
    if (input === null) {
      appendOcLogLine(_t('[restore] 已取消。'));
      return;
    }

    const raw = String(input || '').trim();
    if (!raw || !/^\d+$/.test(raw)) {
      appendOcLogLine(_t('[restore] 未输入有效序号，已取消。'));
      return;
    }

    const selectedIdx = Number(raw) - 1;
    if (selectedIdx < 0 || selectedIdx >= shown.length) {
      appendOcLogLine(_t('[restore] 无效的选择。'));
      return;
    }

    const selected = shown[selectedIdx];
    let filesToRestore = [];

    // If snapshot with multiple files, let user choose which to restore
    if (selected.type === 'snapshot' && selected.files && selected.files.length > 1) {
      const fileHint = selected.files.map((f, i) => `  ${i + 1}. ${f.name}`).join('\n');
      const fileInput = window.prompt(
        _t('备份包含 {0} 个配置文件：\n{1}\n\n', selected.files.length, fileHint) +
        _t('输入序号恢复单个文件（如 1）\n') +
        _t('输入多个序号恢复多个文件（如 1,3）\n') +
        _t('输入 all 恢复全部文件：'),
        'all'
      );
      if (fileInput === null) {
        appendOcLogLine(_t('[restore] 已取消。'));
        return;
      }
      const fraw = String(fileInput || '').trim().toLowerCase();
      if (fraw === 'all' || fraw === _t('全部')) {
        filesToRestore = selected.files.map(f => f.name);
      } else {
        // Support comma-separated multi-index selection, e.g. "1,3" or "1, 2, 4"
        const indices = fraw.split(/[,，\s]+/).map(s => Number(s.trim()) - 1).filter(i => i >= 0 && i < selected.files.length);
        if (indices.length > 0) {
          filesToRestore = [...new Set(indices)].map(i => selected.files[i].name);
        }
      }
      if (filesToRestore.length === 0) {
        appendOcLogLine(_t('[restore] 无效的文件选择。'));
        return;
      }
    }

    const body = { name: selected.name };
    if (filesToRestore.length > 0) body.files = filesToRestore;
    appendOcLogLine(_t('[restore] 正在恢复备份: {0}', selected.name) + (filesToRestore.length > 0 ? ` (${filesToRestore.join(', ')})` : ''));
    const r = await api('/api/openclaw/config/restore', { method:'POST', body, timeoutMs: 30000 });
    if (!r || r.error || !r.success) {
      throw new Error(r?.error || _t('恢复失败'));
    }

    const restoredDesc = r.restoredFiles ? r.restoredFiles.join(', ') : (r.restored || selected.name);
    appendOcLogLine(_t('[restore] 配置恢复完成: {0}', restoredDesc));
    appendOcLogLine(_t('[restore] 请点击“重启 Gateway”使配置生效。'));
    toast(_t('配置恢复完成'), restoredDesc);
  } catch (e) {
    const err = e?.message || String(e || _t('配置恢复失败'));
    appendOcLogLine(_t('[restore] 失败: {0}', err));
    toast(_t('配置恢复失败'), err);
  } finally {
    ocRepairRunning = false;
    syncOpenClawButtons();
    setTimeout(refreshOpenClaw, 500);
  }
});

$('btn-oc-install').addEventListener('click', async ()=>{
  if (ocInstallRunning) {
    toast(_t('任务进行中'), _t('安装/更新任务正在执行，请稍候'));
    return;
  }
  ocInstallRunning = true;
  ocInstallPhase = 'auto';
  syncOpenClawButtons();
  let taskStarted = false;
  try{
    const _logEl = $('oc-log');
    if (_logEl) _logEl.innerHTML = '';
    clearOcLogCache();
    if (!ocInstalled) {
      ocInstallPhase = 'install';
      appendOcLogLine(_t('📦 开始安装 OpenClaw...'));
      const i = await api('/api/openclaw/install', { method:'POST', timeoutMs: 90000 });
      if (!i.taskId && Number(i?.status || 0) === 409) {
        const existingTaskId = String(i?.operationState?.taskId || '').trim();
        const existingType = String(i?.operationState?.type || '').trim();
        if (existingTaskId && (existingType === 'installing' || existingType === 'updating')) {
          appendOcLogLine(_t('⏳ 检测到已有任务进行中，接管进度显示...'));
          toast(_t('任务进行中'), _t('已存在安装/更新任务，正在接管进度显示'));
          taskStarted = true;
          pollTask(existingTaskId);
          return;
        }
      }
      if (!i.taskId){
        const isEmptyResponse = i && typeof i === 'object' && Object.keys(i).length === 0;
        const detail = i.error || (isEmptyResponse
          ? _t('接口返回空响应（可能会话失效或页面缓存未更新，请Refresh后重试）')
          : _t('接口返回异常（{0}）', JSON.stringify(i || {}) || 'empty'));
        appendOcLogLine(_t('❌ 安装启动失败: {0}', detail));
        if (/空响应|缓存未更新|会话失效|empty response|cache not updated|session expired/i.test(detail)) {
          appendOcLogLine(_t('💡 提示: 请强制Refresh页面后重试（macOS: Command+Shift+R）'));
        }
        toast(_t('安装失败'), detail);
        return;
      }
      toast(_t('开始安装'), _t('正在执行 OpenClaw 安装...'));
      appendOcLogLine(_t('✅ 安装任务已启动'));
      if (i?.release?.tag) appendOcLogLine(_t('📋 目标版本: {0}', i.release.tag));
      taskStarted = true;
      pollTask(i.taskId);
      return;
    }

    let current = await refreshOpenClaw({ retries: 2 });
    if (!current || current.error) {
      const detail = current?.error || _t('无法获取当前 OpenClaw 状态');
      appendOcLogLine(_t('⚠️ 状态读取失败，使用缓存继续（{0}）', detail));
      current = {
        installed: !!ocInstalled,
        version: '',
        latestVersion: '',
        hasUpdate: false,
        updateCheckError: detail
      };
    }

    if (!current.installed) {
      ocInstallPhase = 'install';
      appendOcLogLine(_t('📦 开始安装 OpenClaw...'));
      const i = await api('/api/openclaw/install', { method:'POST', timeoutMs: 90000 });
      if (!i.taskId && Number(i?.status || 0) === 409) {
        const existingTaskId = String(i?.operationState?.taskId || '').trim();
        const existingType = String(i?.operationState?.type || '').trim();
        if (existingTaskId && (existingType === 'installing' || existingType === 'updating')) {
          appendOcLogLine(_t('⏳ 检测到已有任务进行中，接管进度显示...'));
          toast(_t('任务进行中'), _t('已存在安装/更新任务，正在接管进度显示'));
          taskStarted = true;
          pollTask(existingTaskId);
          return;
        }
      }
      if (!i.taskId){
        const isEmptyResponse = i && typeof i === 'object' && Object.keys(i).length === 0;
        const detail = i.error || (isEmptyResponse
          ? _t('接口返回空响应（可能会话失效或页面缓存未更新，请Refresh后重试）')
          : _t('接口返回异常（{0}）', JSON.stringify(i || {}) || 'empty'));
        appendOcLogLine(_t('❌ 安装启动失败: {0}', detail));
        if (/空响应|缓存未更新|会话失效|empty response|cache not updated|session expired/i.test(detail)) {
          appendOcLogLine(_t('💡 提示: 请强制Refresh页面后重试（macOS: Command+Shift+R）'));
        }
        toast(_t('安装失败'), detail);
        return;
      }
      toast(_t('开始安装'), _t('正在执行 OpenClaw 安装...'));
      appendOcLogLine(_t('✅ 安装任务已启动'));
      if (i?.release?.tag) appendOcLogLine(_t('📋 目标版本: {0}', i.release.tag));
      taskStarted = true;
      pollTask(i.taskId);
      return;
    }

    if (!current.version) {
      appendOcLogLine(_t('⚠️ 未检测到Local版本，已取消更新'));
      toast(_t('更新已取消'), _t('未检测到Local版本，请先检查安装状态'));
      return;
    }

    if (!current.latestVersion) {
      appendOcLogLine(_t('⚠️ 无法获取远端最新版本，已取消更新'));
      toast(_t('更新已取消'), current.updateCheckError || _t('无法获取远端版本'));
      return;
    }

    if (!current.hasUpdate) {
      appendOcLogLine(_t('✅ 当前已是最新版本（{0}）', formatVersionLabel(current.version)));
      toast(_t('无需更新'), _t('当前已是最新版本：{0}', formatVersionLabel(current.version)));
      return;
    }

    appendOcLogLine(_t('📦 开始更新 OpenClaw: {0} → {1}', formatVersionLabel(current.version), current.latestVersion));
    ocInstallPhase = 'update';
    const r = await api('/api/openclaw/update', { method:'POST' });
    if (!r.taskId && Number(r?.status || 0) === 409) {
      const existingTaskId = String(r?.operationState?.taskId || '').trim();
      const existingType = String(r?.operationState?.type || '').trim();
      if (existingTaskId && (existingType === 'installing' || existingType === 'updating')) {
        appendOcLogLine(_t('⏳ 检测到已有任务进行中，接管进度显示...'));
        toast(_t('任务进行中'), _t('已存在安装/更新任务，正在接管进度显示'));
        taskStarted = true;
        pollTask(existingTaskId);
        return;
      }
    }
    if (!r.taskId){
      const isEmptyResponse = r && typeof r === 'object' && Object.keys(r).length === 0;
      const detail = r.error || (isEmptyResponse
        ? _t('接口返回空响应（可能会话失效或页面缓存未更新，请Refresh后重试）')
        : _t('接口返回异常（{0}）', JSON.stringify(r || {}) || 'empty'));
      appendOcLogLine(_t('❌ 更新启动失败: {0}', detail));
      if (/空响应|缓存未更新|会话失效|empty response|cache not updated|session expired/i.test(detail)) {
        appendOcLogLine(_t('💡 提示: 请强制Refresh页面后重试（macOS: Command+Shift+R）'));
      }
      toast(_t('更新失败'), detail);
      return;
    }
    toast(_t('开始更新'), _t('正在更新到 {0}...', current.latestVersion));
    appendOcLogLine(_t('✅ 更新任务已启动'));
    if (r?.release?.tag) appendOcLogLine(_t('📋 目标版本: {0}', r.release.tag));
    taskStarted = true;
    pollTask(r.taskId);
  } catch (e) {
    appendOcLogLine(_t('❌ 请求失败: {0}', e.message || e));
    toast(_t('请求失败'), e.message || String(e));
  }finally{
    if (!taskStarted) {
      ocInstallRunning = false;
      ocInstallPhase = 'auto';
      syncOpenClawButtons();
    }
  }
});

$('btn-oc-start').addEventListener('click', async (event)=>{
  if (ocInstallRunning) {
    toast(_t('任务进行中'), _t('安装/更新执行中，暂不可重启 Gateway'));
    return;
  }
  if (ocStartRunning) {
    toast(_t('任务进行中'), _t('Gateway重启正在执行，请稍候'));
    return;
  }
  const skipConfirm = !!(event && event.shiftKey);
  if (!skipConfirm) {
    const ok = window.confirm(_t('确认重启 Gateway？\n重启期间连接会短暂中断。'));
    if (!ok) {
      toast(_t('已取消'), _t('未执行 Gateway 重启'));
      return;
    }
  }
  ocStartRunning = true;
  ocGatewayRestartRunningRemote = true;
  applyGatewayRestartingUi();
  syncOpenClawButtons();
  appendOcLogLine(_t('⏳ 正在提交重启请求...'));
  ocLastGatewaySnapshot = '';
  let restartAccepted = false;
  try {
    const r = await api('/api/openclaw/start', { method:'POST', timeoutMs: 90000 });
    if (r.success) {
      restartAccepted = true;
      appendOcLogLine(_t('✅ 重启请求已接受，Gateway 重启中...'));
      if (r.logs) {
        ocLastGatewaySnapshot = String(r.logs || '').trim() || ocLastGatewaySnapshot;
      }
      triggerLogsBurstPolling(22000, 1200);
      scheduleGatewayStartupLogPulls(220);
      toast(_t('已触发重启'), r.message || _t('Gateway 正在重启，请稍候'));
    } else {
      const errMsg = String(r.error || '');
      const timeoutLike = /超时|timeout/i.test(errMsg);
      const networkLike = /Load failed|Failed to fetch|NetworkError|fetch/i.test(errMsg);
      if (timeoutLike || networkLike) {
        const status = await api('/api/openclaw', { timeoutMs: 15000 });
        const opType = String(status.operationType || '').trim();
        const backendRestarting = !!status.gatewayRestartRunning || opType === 'restarting_gateway';
        if (backendRestarting) {
          restartAccepted = true;
          ocGatewayRestartRunningRemote = true;
          appendOcLogLine(_t('⏳ 请求超时，但后端仍在重启中...'));
          triggerLogsBurstPolling(22000, 1200);
          scheduleGatewayStartupLogPulls(220);
          toast(_t('重启处理中'), _t('请求超时，但后端仍在重启 Gateway'));
          return;
        }
      }
      appendOcLogLine(_t('❌ 重启失败: {0}', r.error || _t('请查看日志')));
      if (r.logs) {
        ocLastGatewaySnapshot = String(r.logs || '').trim() || ocLastGatewaySnapshot;
      }
      if (/Unrecognized key|Invalid config|配置无效/i.test(String(r.error || ''))) {
        appendOcLogLine(_t('💡 检测到配置无效，请点击“配置恢复”按钮后重试'));
      }
      ocGatewayRestartRunningRemote = false;
      toast(_t('重启失败'), r.error || _t('请查看日志'));
    }
  } finally {
    if (!restartAccepted) {
      ocGatewayRestartRunningRemote = false;
    }
    ocStartRunning = false;
    syncOpenClawButtons();
  }
  if (restartAccepted) {
    // Poll until Gateway has truly finished starting (up to 10 min)
    // Gateway hot-restart usually completes in 5-15s; cold start may take longer
    const pollStart = Date.now();
    const pollTimeout = 10 * 60 * 1000;
    const pollInterval = 2000;
    // Initial wait: allow old process to exit and new one to start, avoid falsely judging old process as successful
    const initialDelay = 2500;
    let gwUp = false;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 20; // 40s of continuous failures → give up
    const newProcessUptimeGraceSec = 30;
    appendOcLogLine(_t('⏳ 等待 Gateway 启动完成（最多 10 分钟）...'));
    await new Promise(r => setTimeout(r, initialDelay));
    while (Date.now() - pollStart < pollTimeout) {
      await new Promise(r => setTimeout(r, pollInterval));
      try {
        const st = await api('/api/openclaw', { timeoutMs: 15000 });
        if (st.error) {
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            appendOcLogLine(_t('⚠️ API 连续 {0} 次返回错误，停止轮询', consecutiveErrors));
            break;
          }
          continue;
        }
        consecutiveErrors = 0;
        const stillRestarting = !!(st.gatewayStarting) || st.operationState?.type === 'restarting_gateway';
        const gatewayProcessUptimeSec = Number(st.gatewayProcessUptimeSec || 0);
        const healthyNewProcess = st.gatewayRunning
          && gatewayProcessUptimeSec > 0
          && gatewayProcessUptimeSec <= newProcessUptimeGraceSec;
        if (st.gatewayRunning && (!stillRestarting || healthyNewProcess)) {
          gwUp = true;
          break;
        }
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          appendOcLogLine(_t('⚠️ 网络连续 {0} 次失败，停止轮询', consecutiveErrors));
          break;
        }
      }
    }
    if (gwUp) {
      appendOcLogLine(_t('✅ Gateway 重启成功'));
      toast(_t('重启成功'), _t('Gateway 已恢复运行'));
    } else {
      appendOcLogLine(_t('⚠️ Gateway 重启超时或轮询中断，请Check state'));
      toast(_t('重启超时'), _t('Gateway 未在预期时间内恢复，请手动检查'));
    }
    ocGatewayRestartRunningRemote = false;
    syncOpenClawButtons();
  }
  setTimeout(() => refreshOpenClaw({ retries: 0 }), 200);
  setTimeout(refreshOpenClaw, 1800);
});

$('btn-oc-uninstall')?.addEventListener('click', async ()=>{
  if (ocInstallRunning || ocUninstallRunning) {
    toast(_t('任务进行中'), _t('安装/更新/卸载任务正在执行，请稍候'));
    return;
  }
  if (ocStartRunning || ocRepairRunning) {
    toast(_t('任务进行中'), _t('当前有其他操作在执行，请稍候'));
    return;
  }
  if (!ocInstalled) {
    toast(_t('无法卸载'), _t('当前未安装 OpenClaw'));
    return;
  }
  const ok1 = window.confirm(_t('确认卸载 OpenClaw？\n将移除Local安装与源码目录。'));
  if (!ok1) return toast(_t('已取消'), _t('未执行卸载'));
  const ok2 = window.confirm(_t('二次确认：确定继续卸载吗？\n卸载期间将禁止安装/更新/重启。'));
  if (!ok2) return toast(_t('已取消'), _t('未执行卸载'));

  ocUninstallRunning = true;
  ocInstallPhase = 'uninstall';
  syncOpenClawButtons();
  let taskStarted = false;
  try {
    const _logEl = $('oc-log');
    if (_logEl) _logEl.innerHTML = '';
    clearOcLogCache();
    appendOcLogLine(_t('🗑️ 开始卸载 OpenClaw...'));
    const r = await api('/api/openclaw/uninstall', { method:'POST' });
    if (!r?.taskId) {
      const detail = r?.error || _t('卸载任务创建失败');
      appendOcLogLine(_t('❌ 卸载启动失败: {0}', detail));
      toast(_t('卸载失败'), detail);
      return;
    }
    taskStarted = true;
    appendOcLogLine(_t('⏳ 卸载任务执行中...'));
    pollTask(r.taskId);
    toast(_t('开始卸载'), _t('正在执行 OpenClaw 卸载...'));
  } catch (e) {
    appendOcLogLine(_t('❌ 卸载请求失败: {0}', e.message || e));
    toast(_t('请求失败'), e.message || String(e));
  } finally {
    if (!taskStarted) {
      ocUninstallRunning = false;
      ocInstallPhase = 'auto';
      syncOpenClawButtons();
    }
  }
});

// --- Install from historical version selection ---
$('btn-oc-load-versions')?.addEventListener('click', async () => {
  const btn = $('btn-oc-load-versions');
  const sel = $('oc-version-select');
  if (!btn || !sel) return;
  btn.disabled = true;
  btn.textContent = _t('加载中...');
  try {
    const r = await api('/api/openclaw/versions', { timeoutMs: 30000 });
    if (!r?.versions?.length) {
      toast(_t('加载失败'), r?.error || _t('未获取到版本列表'));
      return;
    }
    sel.innerHTML = '<option value="">' + _t('选择历史版本...') + '</option>';
    for (const v of r.versions) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v + (r.installedVersion === v ? _t(' (当前)') : '');
      sel.appendChild(opt);
    }
    toast(_t('版本列表已加载'), _t('共 {0} 个版本', r.versions.length));
  } catch (e) {
    toast(_t('加载失败'), e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = _t('加载版本列表');
  }
});

$('oc-version-select')?.addEventListener('change', () => {
  const sel = $('oc-version-select');
  const btn = $('btn-oc-install-version');
  if (btn) btn.disabled = !sel?.value;
});

$('btn-oc-install-version')?.addEventListener('click', async () => {
  const sel = $('oc-version-select');
  const version = sel?.value;
  if (!version) return toast(_t('请选择版本'), _t('请先从下拉列表中选择要安装的版本'));
  if (ocInstallRunning || ocUninstallRunning) {
    return toast(_t('任务进行中'), _t('安装/更新任务正在执行，请稍候'));
  }
  const ok = window.confirm(_t('确认安装 OpenClaw {0}？\n将使用 A/B 备份更新模式，Gateway 仅在切换版本时短暂停止。', formatVersionLabel(version)));
  if (!ok) return toast(_t('已取消'), _t('未执行安装'));

  ocInstallRunning = true;
  ocInstallPhase = 'install';
  syncOpenClawButtons();
  let taskStarted = false;
  try {
    const _logEl = $('oc-log');
    if (_logEl) _logEl.innerHTML = '';
    clearOcLogCache();
    appendOcLogLine(_t('📦 开始安装指定版本: {0}', formatVersionLabel(version)));
    const r = await api('/api/openclaw/install-version', { method: 'POST', body: { version }, timeoutMs: 90000 });
    if (!r?.taskId) {
      const detail = r?.error || _t('安装任务创建失败');
      appendOcLogLine(_t('❌ 安装启动失败: {0}', detail));
      toast(_t('安装失败'), detail);
      return;
    }
    toast(_t('开始安装'), _t('正在安装 {0}...', formatVersionLabel(version)));
    appendOcLogLine(_t('✅ 安装任务已启动'));
    appendOcLogLine(_t('📋 目标版本: {0}', formatVersionLabel(version)));
    taskStarted = true;
    pollTask(r.taskId);
  } catch (e) {
    appendOcLogLine(_t('❌ 请求失败: {0}', e.message || e));
    toast(_t('请求失败'), e.message || String(e));
  } finally {
    if (!taskStarted) {
      ocInstallRunning = false;
      ocInstallPhase = 'auto';
      syncOpenClawButtons();
    }
  }
});

// ------------------------
// AI config - Refactored

// Provider configuration info
const AI_PROVIDERS = {
  // ─── Common ───
  anthropic: {
    name: 'Anthropic (Claude)', group: 'Common',
    apiKeyLabel: 'Anthropic API Key', apiKeyPlaceholder: 'sk-ant-api03-...',
    authType: 'apikey', baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022']
  },
  openai: {
    name: 'OpenAI (GPT)', group: 'Common',
    apiKeyLabel: 'OpenAI API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'o1', 'o1-mini']
  },
  'github-copilot': {
    name: 'GitHub Copilot', group: 'Common',
    apiKeyLabel: 'OAuth Token', apiKeyPlaceholder: _t('使用设备授权登录'),
    authType: 'oauth', oauthType: 'device',
    baseUrl: 'https://api.githubcopilot.com',
    models: ['github-copilot/gpt-4o', 'github-copilot/gpt-4', 'github-copilot/claude-3.5-sonnet', 'github-copilot/claude-sonnet-4', 'github-copilot/o1', 'github-copilot/o3-mini', 'github-copilot/gemini-2.0-flash'],
    oauthGuide: `<div style="color:#98989d;line-height:1.6">
      <p style="margin:4px 0"><b>${_t('GitHub Copilot 设备授权流程')}：</b></p>
      <p style="margin:4px 0">1. ${_t('确保你有 GitHub Copilot 订阅（个人版或企业版）')}</p>
      <p style="margin:4px 0">2. ${_t('点击"启动设备授权"按钮')}</p>
      <p style="margin:4px 0">3. ${_t('在弹出页面中登录 GitHub 并授权设备')}</p>
      <p style="margin:4px 0">4. ${_t('输入显示的设备码完成授权')}</p>
      <p style="margin:8px 0;color:#ff9f0a">${_t('注意：模型名称需要以 github-copilot/ 开头')}</p>
    </div>`
  },
  gemini: {
    name: 'Google Gemini', group: 'Common',
    apiKeyLabel: 'Gemini API Key', apiKeyPlaceholder: 'AIza...',
    authType: 'apikey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']
  },
  openrouter: {
    name: 'OpenRouter', group: 'Common',
    apiKeyLabel: 'OpenRouter API Key', apiKeyPlaceholder: 'sk-or-...',
    authType: 'apikey', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-pro-1.5']
  },
  deepseek: {
    name: 'DeepSeek', group: 'Common',
    apiKeyLabel: 'DeepSeek API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner']
  },
  // ─── International ───
  mistral: {
    name: 'Mistral AI', group: 'International',
    apiKeyLabel: 'Mistral API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest']
  },
  xai: {
    name: 'xAI (Grok)', group: 'International',
    apiKeyLabel: 'xAI API Key', apiKeyPlaceholder: 'xai-...',
    authType: 'apikey', baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-fast']
  },
  groq: {
    name: 'Groq', group: 'International',
    apiKeyLabel: 'Groq API Key', apiKeyPlaceholder: 'gsk_...',
    authType: 'apikey', baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it']
  },
  together: {
    name: 'Together AI', group: 'International',
    apiKeyLabel: 'Together API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.together.xyz/v1',
    models: ['moonshotai/Kimi-K2.5', 'deepseek-ai/DeepSeek-R1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo']
  },
  huggingface: {
    name: 'Hugging Face', group: 'International',
    apiKeyLabel: 'HF Token', apiKeyPlaceholder: 'hf_...',
    authType: 'apikey', baseUrl: 'https://router.huggingface.co/v1',
    models: ['deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3.1', 'meta-llama/Llama-3.3-70B-Instruct']
  },
  perplexity: {
    name: 'Perplexity', group: 'International',
    apiKeyLabel: 'Perplexity API Key', apiKeyPlaceholder: 'pplx-...',
    authType: 'apikey', baseUrl: 'https://api.perplexity.ai',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro']
  },
  nvidia: {
    name: 'NVIDIA NIM', group: 'International',
    apiKeyLabel: 'NVIDIA API Key', apiKeyPlaceholder: 'nvapi-...',
    authType: 'apikey', baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct']
  },
  cerebras: {
    name: 'Cerebras', group: 'International',
    apiKeyLabel: 'Cerebras API Key', apiKeyPlaceholder: 'csk-...',
    authType: 'apikey', baseUrl: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b', 'llama-3.1-8b']
  },
  venice: {
    name: 'Venice AI', group: 'International',
    apiKeyLabel: 'Venice API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.venice.ai/api/v1',
    models: ['llama-3.3-70b', 'deepseek-r1-671b']
  },
  // ─── China ───
  bailian: {
    name: _t('阿里云百炼 (Bailian)'), group: 'China',
    apiKeyLabel: 'DashScope API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    models: ['qwen3.5-plus', 'qwen3-max-2026-01-23', 'qwen3-coder-next', 'qwen3-coder-plus', 'MiniMax-M2.5', 'glm-5', 'glm-4.7', 'kimi-k2.5']
  },
  zai: {
    name: _t('智谱 Z.AI (GLM)'), group: 'China',
    apiKeyLabel: 'Z.AI API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5', 'glm-4.7']
  },
  moonshot: {
    name: 'Moonshot (Kimi)', group: 'China',
    apiKeyLabel: 'Moonshot API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.5', 'moonshot-v1-128k', 'moonshot-v1-32k']
  },
  'kimi-coding': {
    name: 'Kimi Coding', group: 'China',
    apiKeyLabel: 'Kimi Coding API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.kimi.com/coding/',
    models: ['k2p5']
  },
  minimax: {
    name: 'MiniMax', group: 'China',
    apiKeyLabel: 'MiniMax API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.minimax.io/anthropic',
    models: ['MiniMax-M2.5', 'MiniMax-M1']
  },
  xiaomi: {
    name: _t('小米 MiMo'), group: 'China',
    apiKeyLabel: 'Xiaomi API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.xiaomimimo.com/anthropic',
    models: ['mimo-v2-flash']
  },
  qianfan: {
    name: _t('百度千帆 (Qianfan)'), group: 'China',
    apiKeyLabel: 'Qianfan API Key', apiKeyPlaceholder: 'bce-v3/ALTAK-...',
    authType: 'apikey', baseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['deepseek-v3.2', 'ernie-4.5-8k']
  },
  volcengine: {
    name: _t('火山引擎 (Volcengine)'), group: 'China',
    apiKeyLabel: 'Volcengine API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    needsBaseUrl: true,
    models: ['ark-code-latest']
  },
  byteplus: {
    name: 'BytePlus', group: 'China',
    apiKeyLabel: 'BytePlus API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    needsBaseUrl: true,
    models: ['ark-code-latest']
  },
  // ─── Gateway / Proxy ───
  litellm: {
    name: 'LiteLLM', group: 'Gateway',
    apiKeyLabel: 'LiteLLM API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'http://localhost:4000',
    needsBaseUrl: true,
    models: ['claude-opus-4-6', 'gpt-4o']
  },
  opencode: {
    name: 'OpenCode Zen', group: 'Gateway',
    apiKeyLabel: 'OpenCode API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://opencode.ai/v1',
    models: ['claude-opus-4-6', 'gpt-4o']
  },
  kilocode: {
    name: 'Kilo Gateway', group: 'Gateway',
    apiKeyLabel: 'Kilocode API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.kilo.ai/api/gateway/',
    models: ['anthropic/claude-opus-4.6']
  },
  synthetic: {
    name: 'Synthetic', group: 'Gateway',
    apiKeyLabel: 'Synthetic API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: '',
    needsBaseUrl: true,
    models: ['hf:MiniMaxAI/MiniMax-M2.5']
  },
  // ─── Local ───
  ollama: {
    name: 'Ollama (Local)', group: 'Local',
    apiKeyLabel: _t('Ollama API Key (可选)'), apiKeyPlaceholder: _t('留空即可'),
    authType: 'apikey', baseUrl: 'http://localhost:11434',
    needsBaseUrl: true,
    models: []
  },
  lmstudio: {
    name: 'LM Studio (Local)', group: 'Local',
    apiKeyLabel: _t('API Key (可选)'), apiKeyPlaceholder: 'lm-studio',
    authType: 'apikey', baseUrl: 'http://127.0.0.1:1234/v1',
    needsBaseUrl: true,
    models: []
  },
  vllm: {
    name: 'vLLM (Local)', group: 'Local',
    apiKeyLabel: _t('vLLM API Key (可选)'), apiKeyPlaceholder: _t('留空即可'),
    authType: 'apikey', baseUrl: 'http://localhost:8000/v1',
    needsBaseUrl: true,
    models: []
  },
  // ─── Custom ───
  custom: {
    name: _t('Custom端点'), group: _t('其他'),
    apiKeyLabel: 'API Key', apiKeyPlaceholder: 'your-api-key',
    authType: 'apikey', baseUrl: '',
    needsBaseUrl: true,
    models: []
  }
};

// --- Multi API Key management ---
let aiConfiguredKeys = []; // [{id, provider, keyMasked, baseUrl, authType, models:[]}]
let aiAuthTaskTimer = null;
let lastFocusedModelInput = 'ai-model-primary';
// Save active OAuth auth state; can be restored when switching providers
let _activeOAuthState = null; // { provider, url, userCode, taskId }

function providerFromModel(modelId = '') {
  const text = String(modelId || '').trim();
  if (!text.includes('/')) return '';
  return text.split('/')[0];
}

function appendAiAuthLog(line, type = 'info'){
  const logEl = $('ai-auth-log');
  if (!logEl) return;
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  appendColored(logEl, `[${timestamp}] ${line}\n`, 5000, true);
}

function appendMsgLog(line){
  const logEl = $('msg-log');
  if (!logEl) return;
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  appendColored(logEl, `[${timestamp}] ${line}\n`, 3000, true);
}

function parseGuildIds(raw){
  return Array.from(new Set(
    String(raw || '')
      .split(/[\n,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => /^\d+$/.test(s))
  ));
}

function setDiscordRuntimeStatus(message, tone = 'info') {
  const el = $('discord-runtime-status');
  if (!el) return;
  const palette = {
    info: { bg: '#1a1a2e', border: 'rgba(255,255,255,.08)', color: '#c9d1d9' },
    success: { bg: 'rgba(46,160,67,.12)', border: 'rgba(46,160,67,.35)', color: '#7ee787' },
    warning: { bg: 'rgba(210,153,34,.12)', border: 'rgba(210,153,34,.35)', color: '#e3b341' },
    error: { bg: 'rgba(248,81,73,.12)', border: 'rgba(248,81,73,.35)', color: '#ff938a' }
  };
  const style = palette[tone] || palette.info;
  el.textContent = message;
  el.style.background = style.bg;
  el.style.borderColor = style.border;
  el.style.color = style.color;
}

function setDiscordPairingResult(message, tone = 'info') {
  const el = $('discord-pairing-result');
  if (!el) return;
  const colors = {
    info: '#8b949e',
    success: '#7ee787',
    warning: '#e3b341',
    error: '#ff938a'
  };
  el.textContent = message || '';
  el.style.color = colors[tone] || colors.info;
}

async function loadDiscordRuntimeStatus(){
  setDiscordRuntimeStatus(_t('正在检查 Discord 运行状态...'));
  const status = await api('/api/openclaw', { timeoutMs: 12000 });
  if (status.error) {
    setDiscordRuntimeStatus(_t('Discord 运行状态读取失败：{0}', status.error), 'error');
    return;
  }

  const enabled = ($('discord-enabled')?.value || 'false') === 'true';
  if (!enabled) {
    setDiscordRuntimeStatus(_t('Discord 当前未启用。保存配置并重启 Gateway 后才会建立连接。'), 'warning');
    return;
  }
  if (status.discordConnectError) {
    setDiscordRuntimeStatus(_t('Discord 连接异常：{0}', status.discordConnectError), 'error');
    return;
  }
  if (status.gatewayRunning) {
    setDiscordRuntimeStatus(_t('Gateway 在线，最近未检测到 Discord 连接错误。'), 'success');
    return;
  }
  if (status.gatewayStarting || status.gatewayProcessRunning) {
    setDiscordRuntimeStatus(_t('Gateway 正在启动中，等待 Discord 完成连接。'), 'warning');
    return;
  }
  setDiscordRuntimeStatus(_t('Gateway 当前未运行，暂时无法确认 Discord 连接状态。'), 'warning');
}

// AI key tab switching
document.querySelectorAll('#ai-key-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#ai-key-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.aiTab;
    const newKeyPanel = $('ai-tab-new-key');
    const configPanel = $('ai-tab-configured-keys');
    if (newKeyPanel) newKeyPanel.hidden = target !== 'new-key';
    if (configPanel) configPanel.hidden = target !== 'configured-keys';
  });
});

function updateAiProviderUI() {
  const provider = $('ai-provider')?.value || 'anthropic';
  const config = AI_PROVIDERS[provider] || AI_PROVIDERS.anthropic;

  const apikeyWrap = $('ai-apikey-wrap');
  if (apikeyWrap) {
    if (config.authType === 'oauth') {
      apikeyWrap.hidden = true;
    } else {
      apikeyWrap.hidden = false;
      const apikeyLabel = $('ai-apikey-label');
      const apikeyInput = $('ai-apikey');
      if (apikeyLabel) apikeyLabel.textContent = config.apiKeyLabel || 'API Key';
      if (apikeyInput) apikeyInput.placeholder = config.apiKeyPlaceholder || 'sk-...';
    }
  }

  const oauthWrap = $('ai-oauth-wrap');
  if (oauthWrap) {
    if (config.authType === 'oauth') {
      oauthWrap.hidden = false;
      const guideEl = $('ai-oauth-guide');
      // If OAuth auth in progress, restore auth info instead of overwriting
      if (guideEl) {
        if (_activeOAuthState && _activeOAuthState.provider === provider) {
          _showActiveOAuthInCard();
        } else if (config.oauthGuide) {
          guideEl.innerHTML = config.oauthGuide;
        }
      }
    } else {
      oauthWrap.hidden = true;
    }
  }

  const baseurlWrap = $('ai-baseurl-wrap');
  if (baseurlWrap) {
    baseurlWrap.hidden = !config.needsBaseUrl;
    if (config.needsBaseUrl) {
      const baseurlInput = $('ai-baseurl');
      if (baseurlInput && !baseurlInput.value) baseurlInput.value = config.baseUrl || '';
    }
  }

  // Update add-button text: OAuth mode does not require an API Key
  const addBtn = $('btn-ai-add-key');
  if (addBtn) {
    addBtn.textContent = config.authType === 'oauth' ? _t('添加此授权') : _t('添加此 API Key');
    // OAuth mode hides add button (auto-added after auth completes)
    addBtn.hidden = config.authType === 'oauth';
  }
}

function renderConfiguredKeys() {
  const select = $('ai-configured-select');
  if (!select) return;

  // Save currently selected value
  const prevVal = select.value;

  // Clear and rebuild options
  select.innerHTML = '<option value="">— ' + _t('请选择') + ' —</option>';

  aiConfiguredKeys.forEach((k, idx) => {
    const pConfig = AI_PROVIDERS[k.provider] || {};
    const providerName = pConfig.name || k.provider;
    const keyHint = k.keyMasked ? ` (${k.keyMasked})` : (k.authType === 'oauth' ? ' (OAuth)' : '');
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `${providerName}${keyHint}`;
    select.appendChild(opt);
  });

  // Restore selection
  if (prevVal && select.querySelector(`option[value="${prevVal}"]`)) {
    select.value = prevVal;
  }

  onConfiguredKeySelected();
}

let _modelsFetchGen = 0; // Prevent race: old request overwriting new result when switching key

function onConfiguredKeySelected() {
  const select = $('ai-configured-select');
  const idx = parseInt(select?.value || '', 10);
  const key = aiConfiguredKeys[idx];

  const detail = $('ai-configured-detail');
  const info = $('ai-configured-info');
  const actions = $('ai-configured-actions');
  const modelsWrap = $('ai-configured-models-wrap');
  const modelsList = $('ai-configured-models-list');

  // Clear old model list immediately on switch to avoid showing previous provider models
  if (modelsList) modelsList.innerHTML = '';
  if (modelsWrap) modelsWrap.hidden = true;

  if (!key || isNaN(idx)) {
    if (detail) detail.hidden = true;
    if (actions) actions.hidden = true;
    return;
  }

  if (detail) detail.hidden = false;
  if (actions) actions.hidden = false;

  const pConfig = AI_PROVIDERS[key.provider] || {};
  const authLabel = key.authType === 'oauth' ? 'OAuth' : 'API Key';
  let infoText = `${authLabel}: ${key.keyMasked || '—'}`;
  if (key.baseUrl) infoText += `\nURL: ${key.baseUrl}`;
  if (info) info.textContent = infoText;

  // Auto-fetch available models
  fetchConfiguredKeyModels();
}

async function fetchConfiguredKeyModels() {
  const select = $('ai-configured-select');
  const idx = parseInt(select?.value || '', 10);
  const key = aiConfiguredKeys[idx];
  if (!key) {
    toast(_t('请先选择'), _t('请先从下拉菜单选择一个 Key'));
    return;
  }

  const pConfig = AI_PROVIDERS[key.provider] || {};
  const gen = ++_modelsFetchGen; // Increment generation

  // Show loading indicator
  const modelsWrap = $('ai-configured-models-wrap');
  const modelsList = $('ai-configured-models-list');
  if (modelsWrap) modelsWrap.hidden = false;
  if (modelsList) modelsList.innerHTML = '<div style="padding:8px;color:#86868b">' + _t('加载中...') + '</div>';

  appendAiAuthLog(_t('[fetch] 正在获取 {0} 的模型列表...', pConfig.name || key.provider));

  try {
    // All providers fetch real model list through backend API
    const res = await api('/api/ai/models', {
      method: 'POST',
      body: { provider: key.provider }
    });
    // Discard stale request results (user switched to another key)
    if (gen !== _modelsFetchGen) return;
    if (res.error && !res.models) {
      appendAiAuthLog(_t('[fetch] 获取失败: {0}', res.error), 'error');
      if (modelsList) modelsList.innerHTML = '';
      if (modelsWrap) modelsWrap.hidden = true;
      return;
    }
    renderConfiguredModelsList(res.models || []);
    const srcLabel = res.source === 'api' ? _t('(来自 API)') : res.source === 'builtin' ? _t('(内置列表)') : '';
    appendAiAuthLog(_t('[fetch] 成功获取 {0} 个模型 {1}', (res.models || []).length, srcLabel), 'success');
    if (res.error && res.source === 'builtin') {
      appendAiAuthLog(`[fetch] ⚠️ ${res.error}`, 'error');
    }
  } catch (e) {
    if (gen !== _modelsFetchGen) return;
    appendAiAuthLog(_t('[fetch] 错误: {0}', e.message), 'error');
    if (modelsList) modelsList.innerHTML = '';
    if (modelsWrap) modelsWrap.hidden = true;
  }
}

function renderConfiguredModelsList(models) {
  const wrap = $('ai-configured-models-wrap');
  const list = $('ai-configured-models-list');
  if (!wrap || !list) return;

  if (!models || models.length === 0) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  list.innerHTML = models.map(m => {
    const id = m.id || m;
    const name = m.name || m.id || m;
    return `<div class="model-item" data-model="${id}" style="padding:6px 12px;margin:3px 0;background:#232326;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between;align-items:center" onmouseover="this.style.background='#3a3a3e'" onmouseout="this.style.background='#232326'">
      <span style="font-weight:600;font-size:13px">${name}</span>
      <span style="font-size:11px;color:#86868b;font-family:var(--mono)">${id}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.model-item').forEach(item => {
    item.addEventListener('click', () => {
      const modelId = item.dataset.model;
      const target = $(lastFocusedModelInput) || $('ai-model-primary');
      if (target) {
        if (lastFocusedModelInput.includes('fallback') && target.value.trim()) {
          target.value = target.value.trim() + ', ' + modelId;
        } else {
          target.value = modelId;
        }
        const fieldLabel = target.closest('.field')?.querySelector('.label span')?.textContent || lastFocusedModelInput;
        appendAiAuthLog(_t('[select] 已填充 {0}: {1}', fieldLabel, modelId));
      }
    });
  });
}

async function deleteConfiguredKey() {
  const select = $('ai-configured-select');
  const idx = parseInt(select?.value || '', 10);
  const key = aiConfiguredKeys[idx];
  if (!key) {
    toast(_t('请先选择'), _t('请先从下拉菜单选择一个 Key'));
    return;
  }

  const pConfig = AI_PROVIDERS[key.provider] || {};
  const label = `${pConfig.name || key.provider} (${key.keyMasked || 'OAuth'})`;
  if (!confirm(_t('确认删除 {0}？\n关联的模型配置也会被清除。', label))) return;

  appendAiAuthLog(_t('[delete] 正在删除 {0}...', label));

  try {
    const res = await api('/api/ai/keys', {
      method: 'DELETE',
      body: { provider: key.provider, keyId: key.id }
    });

    if (res.error) {
      toast(_t('删除失败'), res.error);
      appendAiAuthLog(_t('[delete] 失败: {0}', res.error), 'error');
      return;
    }

    toast(_t('已删除'), _t('{0} 已移除', label));
    appendAiAuthLog(_t('[delete] {0} 已删除', label), 'success');
    await loadAIConfig();
  } catch (e) {
    toast(_t('删除失败'), e.message);
    appendAiAuthLog(_t('[delete] 错误: {0}', e.message), 'error');
  }
}

async function addAiKey() {
  const provider = $('ai-provider')?.value || '';
  const apiKey = $('ai-apikey')?.value?.trim() || '';
  const baseUrl = $('ai-baseurl')?.value?.trim() || '';
  const config = AI_PROVIDERS[provider] || {};

  // OAuth type cannot be added via Add button; OAuth auth flow must complete first
  if (config.authType === 'oauth') {
    toast(_t('请先授权'), _t('{0} 需要先点击"启动设备授权"完成 OAuth 登录', config.name || provider));
    appendAiAuthLog(_t('[add] {0} 是 OAuth 类型，请先完成设备授权', config.name || provider), 'error');
    return;
  }

  if (!apiKey) {
    toast(_t('参数错误'), _t('请输入 API Key'));
    appendAiAuthLog(_t('[add] 请输入 API Key'), 'error');
    return;
  }

  // Validate API Key first
  appendAiAuthLog(_t('[validate] 正在验证 {0} API Key...', config.name || provider));
  const addBtn = $('btn-ai-add-key');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = _t('验证中…'); }

  try {
    const vRes = await api('/api/ai/keys/validate', {
      method: 'POST',
      body: { provider, apiKey, baseUrl: baseUrl || null }
    });
    if (vRes.valid === false) {
      toast(_t('Key 无效'), vRes.error || _t('API Key 验证失败'));
      appendAiAuthLog(_t('[validate] API Key 验证失败: {0}', vRes.error || _t('无效')), 'error');
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = _t('添加此 API Key'); }
      return;
    }
    if (vRes.warning) {
      appendAiAuthLog(`[validate] ⚠️ ${vRes.warning}`);
    } else {
      appendAiAuthLog(_t('[validate] API Key 验证通过 ✓'), 'success');
    }
  } catch (e) {
    appendAiAuthLog(_t('[validate] 验证请求失败: {0}，继续添加', e.message));
  }

  if (addBtn) { addBtn.disabled = true; addBtn.textContent = _t('保存中…'); }
  appendAiAuthLog(_t('[add] 正在添加 {0} 的 API Key...', config.name || provider));

  try {
    const res = await api('/api/ai/keys', {
      method: 'POST',
      body: { provider, apiKey: apiKey || null, baseUrl: baseUrl || null }
    });

    if (res.error) {
      toast(_t('添加失败'), res.error);
      appendAiAuthLog(_t('[add] 失败: {0}', res.error), 'error');
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = _t('添加此 API Key'); }
      return;
    }

    toast(_t('添加成功'), _t('{0} API Key 已保存', config.name || provider));
    appendAiAuthLog(_t('[add] {0} API Key 添加成功', config.name || provider), 'success');
    if ($('ai-apikey')) $('ai-apikey').value = '';
    await loadAIConfig();
    // Auto-switch to configured keys page
    document.querySelector('#ai-key-tabs .tab[data-ai-tab="configured-keys"]')?.click();
    // Auto-select just-added key (pick last matching provider)
    const sel = $('ai-configured-select');
    if (sel) {
      let lastIdx = -1;
      aiConfiguredKeys.forEach((k, i) => { if (k.provider === provider) lastIdx = i; });
      if (lastIdx >= 0) { sel.value = String(lastIdx); onConfiguredKeySelected(); }
    }
    // Auto-fetch available models
    appendAiAuthLog(_t('[add] 正在获取可用模型列表...'));
    try { await fetchConfiguredKeyModels(); } catch {}
  } catch (e) {
    toast(_t('添加失败'), e.message);
    appendAiAuthLog(_t('[add] 错误: {0}', e.message), 'error');
  }
  if (addBtn) { addBtn.disabled = false; addBtn.textContent = _t('添加此 API Key'); }
}

async function loadAIConfig(){
  appendAiAuthLog(_t('[load] 正在读取配置...'));

  try {
    let d = await api('/api/ai/config', { timeoutMs: 30000 });

    // Auto-retry once on first timeout
    if (d.error && /超时|timeout/i.test(d.error)) {
      appendAiAuthLog(_t('[load] 首次读取超时，正在重试...'));
      d = await api('/api/ai/config', { timeoutMs: 30000 });
    }

    if (d.error) {
      $('ai-status').textContent = _t('状态：读取失败（{0}）', d.error);
      appendAiAuthLog(_t('[load] 读取失败: {0}', d.error), 'error');
      return;
    }

    // Populate model configuration
    const primaryModel = d.defaultModel || '';
    if ($('ai-model-primary')) $('ai-model-primary').value = primaryModel;
    if (d.fallbacks?.primary && $('ai-model-primary-fallback')) {
      $('ai-model-primary-fallback').value = d.fallbacks.primary.join(', ');
    }
    if (d.subModel && $('ai-model-sub')) $('ai-model-sub').value = d.subModel;
    if (d.fallbacks?.sub && $('ai-model-sub-fallback')) {
      $('ai-model-sub-fallback').value = d.fallbacks.sub.join(', ');
    }

    // Build configured keys list
    aiConfiguredKeys = (d.configuredKeys || []).map(k => ({
      id: k.id || k.provider,
      provider: k.provider,
      keyMasked: k.keyMasked || '',
      baseUrl: k.baseUrl || '',
      authType: k.authType || 'apikey',
      models: k.models || []
    }));
    renderConfiguredKeys();

    // Set provider dropdown to first configured or default
    const provider = d.provider || (aiConfiguredKeys.length > 0 ? aiConfiguredKeys[0].provider : 'anthropic');
    if ($('ai-provider')) $('ai-provider').value = provider;
    if (d.baseUrl && $('ai-baseurl')) $('ai-baseurl').value = d.baseUrl;

    updateAiProviderUI();

    const keyCount = aiConfiguredKeys.length;
    const keyStatus = keyCount > 0 ? _t('✅ {0} 个 Key', keyCount) : _t('⚠️ 未配置');
    const modelStatus = primaryModel ? _t('主模型：{0}', primaryModel) : _t('主模型：未设置');
    $('ai-status').textContent = _t('状态：已读取（{0}；API Key：{1}）', modelStatus, keyStatus);
    appendAiAuthLog(_t('[load] 配置读取成功，{0} 个已配置 Key', keyCount), 'success');

  } catch (e) {
    $('ai-status').textContent = _t('状态：读取失败（{0}）', e.message);
    appendAiAuthLog(_t('[load] 错误: {0}', e.message), 'error');
  }
}

async function saveAIConfig() {
  let primaryModel = $('ai-model-primary')?.value?.trim() || '';
  let primaryFallback = $('ai-model-primary-fallback')?.value?.trim() || '';
  let subModel = $('ai-model-sub')?.value?.trim() || '';
  let subFallback = $('ai-model-sub-fallback')?.value?.trim() || '';

  if (!primaryModel) {
    toast(_t('参数错误'), _t('请设置主代理模型'));
    appendAiAuthLog(_t('[save] 错误: 主代理模型未设置'), 'error');
    return;
  }

  // Auto-complete the provider/ prefix
  const autoPrefix = (modelStr) => {
    if (!modelStr) return modelStr;
    if (modelStr.includes('/')) return modelStr;
    // Find matching provider from configured keys, or use currently selected provider
    const selProvider = $('ai-provider')?.value || '';
    const configuredProviders = aiConfiguredKeys.map(k => k.provider);
    const provider = configuredProviders.length > 0 ? configuredProviders[0] : selProvider;
    if (provider) return provider + '/' + modelStr;
    return modelStr;
  };
  primaryModel = autoPrefix(primaryModel);
  subModel = subModel ? autoPrefix(subModel) : '';
  // Also auto-prepend prefix for each model in fallback list
  const autoPrefixList = (str) => {
    if (!str) return str;
    return str.split(',').map(s => autoPrefix(s.trim())).filter(Boolean).join(', ');
  };
  primaryFallback = autoPrefixList(primaryFallback);
  subFallback = autoPrefixList(subFallback);

  appendAiAuthLog(_t('[save] 开始保存模型配置...'));

  try {
    const body = {
      primaryModel,
      fallbacks: {
        primary: primaryFallback ? primaryFallback.split(',').map(s => s.trim()).filter(Boolean) : [],
        sub: subFallback ? subFallback.split(',').map(s => s.trim()).filter(Boolean) : []
      },
      subModel: subModel || null
    };

    appendAiAuthLog(_t('[save] 主模型: {0}', primaryModel));
    if (body.fallbacks.primary.length) appendAiAuthLog(_t('[save] {0}', _t('主代理 Fallbacks: {0}', body.fallbacks.primary.join(', '))));
    if (subModel) appendAiAuthLog(_t('[save] {0}', _t('子代理模型: {0}', subModel)));

    const res = await api('/api/ai/config', { method:'POST', body });
    if (res.error) {
      toast(_t('保存失败'), res.error);
      appendAiAuthLog(_t('[save] 保存失败: {0}', res.error), 'error');
      return;
    }

    toast(_t('保存成功'), res.message || _t('模型配置已保存'));
    appendAiAuthLog(_t('[save] {0}', res.message || _t('模型配置已保存')), 'success');
    await loadAIConfig();
  } catch (e) {
    toast(_t('保存失败'), e.message);
    appendAiAuthLog(_t('[save] 错误: {0}', e.message), 'error');
  }
}

async function pollAiAuthTask(taskId){
  if (aiAuthTaskTimer) clearInterval(aiAuthTaskTimer);
  let lastSeq = 0;
  let oauthUrlOpened = false;
  const tick = async () => {
    const st = await api('/api/ai/auth/task/' + taskId + '?since=' + lastSeq);
    if (!st || st.error) return;
    if (st.delta) {
      appendColored($('ai-auth-log'), st.delta, 3000, true);
      // Auto-display device auth info — shown inside the OAuth card area
      if (!oauthUrlOpened) {
        const urlMatch = st.delta.match(/https?:\/\/[^\s)]+\/login\/device[^\s)']*/i)
          || st.delta.match(/https?:\/\/[^\s)]+verification[^\s)']*/i)
          || st.delta.match(/(https?:\/\/github\.com[^\s)']*)/i);
        if (urlMatch) {
          const url = urlMatch[0].replace(/[,.;:]+$/, '');
          oauthUrlOpened = true;
          // Extract user_code
          const codeMatch = st.delta.match(/(?:授权码|code)[:：]\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})?)/i);
          const userCode = codeMatch ? codeMatch[1] : '';
          // Save active auth state; can be restored when switching providers
          const provider = $('ai-provider')?.value || '';
          _activeOAuthState = { provider, url, userCode, taskId };
          _showActiveOAuthInCard();
        }
      }
    }
    lastSeq = Number(st.seq || lastSeq || 0);
    if (st.status && st.status !== 'running') {
      if (aiAuthTaskTimer) clearInterval(aiAuthTaskTimer);
      aiAuthTaskTimer = null;
      const success = st.status === 'success';
      toast(success ? _t('认证完成') : _t('认证失败'), success ? _t('认证信息已写入') : _t('请查看日志'));
      appendAiAuthLog(_t('[auth] OAuth 认证{0}', success ? _t('成功') : _t('失败')), success ? 'success' : 'error');
      // Restore OAuth card area to initial state
      _restoreOAuthCard(success);
      if (success) {
        // After OAuth success, reload config (server auto-added provider entry)
        const provider = $('ai-provider')?.value || '';
        await loadAIConfig();
        // Auto-switch to configured keys page
        document.querySelector('#ai-key-tabs .tab[data-ai-tab="configured-keys"]')?.click();
        // Auto-select just-authorized provider
        const sel = $('ai-configured-select');
        if (sel) {
          const newIdx = aiConfiguredKeys.findIndex(k => k.provider === provider);
          if (newIdx >= 0) { sel.value = String(newIdx); onConfiguredKeySelected(); }
        }
        // Auto-fetch available models after OAuth success
        appendAiAuthLog(_t('[auth] 正在获取可用模型列表...'));
        try { await fetchConfiguredKeyModels(); } catch {}
        return;
      }
      await loadAIConfig();
    }
  };
  await tick();
  aiAuthTaskTimer = setInterval(tick, 1000);
}

/** Display active auth info in OAuth card area (link + code + re-auth button) */
function _showActiveOAuthInCard() {
  if (!_activeOAuthState) return;
  const { url, userCode } = _activeOAuthState;
  const guideEl = $('ai-oauth-guide');
  const statusEl = $('ai-oauth-status');
  const oauthBtn = $('btn-ai-oauth-login');
  if (statusEl) statusEl.textContent = _t('⏳ 等待用户完成授权…');
  if (oauthBtn) { oauthBtn.disabled = true; oauthBtn.textContent = _t('授权进行中…'); }
  if (guideEl) {
    const linkHtml = `<a href="${url}" target="_blank" rel="noopener" style="color:#58a6ff;text-decoration:underline;font-weight:bold;font-size:14px">👉 ${_t('点击此处打开 GitHub 授权页面')}</a>`;
    const codeHtml = userCode ? `<div style="margin-top:10px;font-size:20px;font-weight:bold;color:#f5f5f7;letter-spacing:4px;text-align:center;padding:10px 16px;background:#2d333b;border-radius:8px;border:1px solid #444c56">${_t('授权码')}: ${userCode}</div>` : '';
    const hintHtml = `<div style="margin-top:8px;font-size:12px;color:#8b949e">${_t('请点击上方链接，在 GitHub 页面中输入授权码完成认证')}</div>`;
    const reAuthHtml = `<div style="margin-top:12px;text-align:center"><button class="btn btn-secondary" id="_btn-reauth" style="font-size:12px">🔄 ${_t('重新授权')}</button></div>`;
    guideEl.innerHTML = `<div style="padding:4px 0">${linkHtml}${codeHtml}${hintHtml}${reAuthHtml}</div>`;
    // Bind re-authorize button
    const reAuthBtn = document.getElementById('_btn-reauth');
    if (reAuthBtn) reAuthBtn.addEventListener('click', () => {
      _activeOAuthState = null;
      _restoreOAuthCard(false);
      startOAuthLogin();
    });
  }
}

/** Restore OAuth card area to initial state */
function _restoreOAuthCard(success) {
  const statusEl = $('ai-oauth-status');
  const guideEl = $('ai-oauth-guide');
  const oauthBtn = $('btn-ai-oauth-login');
  if (oauthBtn) { oauthBtn.disabled = false; oauthBtn.textContent = _t('启动设备授权'); }
  if (statusEl) statusEl.textContent = success ? _t('✅ 授权成功，可再次点击Refresh授权') : _t('点击按钮启动设备授权流程');
  // Clear active state
  if (success || !_activeOAuthState) _activeOAuthState = null;
  // Restore guide content
  const provider = $('ai-provider')?.value || '';
  const config = AI_PROVIDERS[provider] || {};
  if (guideEl && config.oauthGuide) guideEl.innerHTML = config.oauthGuide;
}

async function startOAuthLogin() {
  const provider = $('ai-provider')?.value || '';
  appendAiAuthLog(_t('[auth] 启动 {0} OAuth 登录...', provider));
  // Update OAuth card status to "starting"
  const statusEl = $('ai-oauth-status');
  if (statusEl) statusEl.textContent = _t('正在启动授权…');

  try {
    const r = await api('/api/ai/auth/oauth/login', { method:'POST', body: { provider } });
    if (!r.success || !r.taskId) {
      toast(_t('启动失败'), r.error || _t('无法启动 OAuth 登录'));
      appendAiAuthLog(_t('[auth] 启动失败: {0}', r.error || _t('未返回 taskId')), 'error');
      if (statusEl) statusEl.textContent = _t('启动失败，请重试');
      return;
    }
    appendAiAuthLog(_t('[auth] OAuth 任务已启动: {0}', r.taskId));
    pollAiAuthTask(r.taskId);
  } catch (e) {
    appendAiAuthLog(_t('[auth] 错误: {0}', e.message), 'error');
    if (statusEl) statusEl.textContent = _t('出错，请重试');
  }
}

// Event listeners
$('ai-provider')?.addEventListener('change', updateAiProviderUI);
$('btn-ai-load')?.addEventListener('click', loadAIConfig);
$('btn-ai-oauth-login')?.addEventListener('click', startOAuthLogin);
$('btn-ai-save')?.addEventListener('click', saveAIConfig);
$('btn-ai-add-key')?.addEventListener('click', addAiKey);
$('ai-configured-select')?.addEventListener('change', onConfiguredKeySelected);
$('btn-ai-configured-fetch')?.addEventListener('click', fetchConfiguredKeyModels);
$('btn-ai-configured-delete')?.addEventListener('click', deleteConfiguredKey);

// Record the last focused model input field
['ai-model-primary','ai-model-primary-fallback','ai-model-sub','ai-model-sub-fallback'].forEach(id => {
  $(id)?.addEventListener('focus', () => { lastFocusedModelInput = id; });
});

// Initialize
updateAiProviderUI();
// ------------------------
// Messaging – load / save (refactored to match openclaw.json schema)
// Feishu: channels.feishu.accounts.main.{appId,appSecret,botName,...}
// Discord: channels.discord.{token,guildId,groupPolicy,streaming,historyLimit,dmHistoryLimit}
// ------------------------
async function loadMessagingConfig(){
  appendMsgLog(_t('[load] 正在读取消息平台配置...'));
  const cfg = await api('/api/config');
  if (cfg.error) {
    appendMsgLog(_t('[load] 读取失败: {0}', cfg.error));
    return;
  }
  const c = cfg.channels || {};

  const setBoolSelect = (id, v) => { if ($(id)) $(id).value = String(!!v); };
  const setVal = (id, v) => { if ($(id)) $(id).value = v ?? ''; };

  // -- Feishu (nested: accounts.default, fallback accounts.main) with flat fallback --
  const fs = c.feishu || {};
  const fsMain = fs.accounts?.default || fs.accounts?.main || {};
  setBoolSelect('feishu-enabled', fs.enabled);
  setVal('feishu-appid',   fsMain.appId   || fs.appId   || '');
  setVal('feishu-secret',  fsMain.appSecret || fs.appSecret || '');
  setVal('feishu-botname', fsMain.botName || fs.botName || '');
  setVal('feishu-dmpolicy', fsMain.dmPolicy || fs.dmPolicy || 'open');
  setVal('feishu-token',   fsMain.verificationToken || fs.verificationToken || '');
  setVal('feishu-encrypt', fsMain.encryptKey || fs.encryptKey || '');

  // -- Telegram --
  setBoolSelect('telegram-enabled', c.telegram?.enabled);
  setVal('telegram-token', c.telegram?.token);
  setVal('telegram-users', c.telegram?.allowedUsers);

  // -- Discord (new fields) --
  const dc = c.discord || {};
  const guildKeys = Object.keys(dc.guilds || {}).filter((k) => k !== '*');
  setBoolSelect('discord-enabled', dc.enabled);
  setVal('discord-token', dc.token);
  // Multi-server mode: prefer standard guilds, backward-compatible with single guildId
  const guildText = guildKeys.length
    ? guildKeys.join('\n')
    : (dc.guildId ? String(dc.guildId) : '');
  setVal('discord-guilds', guildText);
  setVal('discord-grouppolicy', dc.groupPolicy || 'allowlist');
  const rawStreaming = String(dc.streaming || 'partial').toLowerCase();
  const validStreaming = ['partial', 'progress', 'block', 'off'].includes(rawStreaming) ? rawStreaming : (rawStreaming === 'full' ? 'progress' : 'partial');
  setVal('discord-streaming',   validStreaming);
  setVal('discord-historylimit', dc.historyLimit ?? 30);
  setVal('discord-dmhistorylimit', dc.dmHistoryLimit ?? 50);
  await loadDiscordRuntimeStatus();

  // -- Signal --
  setBoolSelect('signal-enabled', c.signal?.enabled);
  setVal('signal-cli',   c.signal?.cliPath);
  setVal('signal-phone', c.signal?.phone);

  // -- WhatsApp --
  setBoolSelect('whatsapp-enabled', c.whatsapp?.enabled);
  setVal('whatsapp-url', c.whatsapp?.apiUrl);
  setVal('whatsapp-key', c.whatsapp?.apiKey);

  if ($('btn-msg-restart')) $('btn-msg-restart').style.display = 'none';
  appendMsgLog(_t('[load] 配置读取完成'));
}

$('btn-msg-load')?.addEventListener('click', loadMessagingConfig);

$('btn-discord-approve-pairing')?.addEventListener('click', async ()=>{
  const input = $('discord-pairing-code');
  const button = $('btn-discord-approve-pairing');
  const code = String(input?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code || !/^[A-Z0-9]{6,32}$/.test(code)) {
    setDiscordPairingResult(_t('请输入有效的 Discord 配对码。'), 'error');
    toast(_t('审批失败'), _t('配对码格式无效'));
    return;
  }

  if (button) button.disabled = true;
  setDiscordPairingResult(_t('正在审批 Discord 配对码...'), 'info');
  appendMsgLog(_t('[discord] 正在审批配对码 {0}...', code));
  const result = await api('/api/openclaw/pairing/approve-discord', {
    method: 'POST',
    body: { code },
    timeoutMs: 45000
  });
  if (button) button.disabled = false;

  if (result.success) {
    if (input) input.value = '';
    setDiscordPairingResult(result.message || _t('配对码 {0} 已批准。', code), 'success');
    appendMsgLog(_t('[discord] {0}', result.message || _t('配对码 {0} 已批准', code)));
    toast(_t('审批成功'), result.message || _t('配对码 {0} 已批准', code));
    await loadDiscordRuntimeStatus();
    return;
  }

  setDiscordPairingResult(result.error || _t('审批失败'), 'error');
  appendMsgLog(_t('[discord] 审批失败: {0}', result.error || 'unknown'));
  toast(_t('审批失败'), result.error || 'unknown');
  await loadDiscordRuntimeStatus();
});

// Restart Gateway to apply
$('btn-msg-restart')?.addEventListener('click', async ()=>{
  appendMsgLog(_t('[restart] 正在重启 Gateway...'));
  const r = await api('/api/openclaw/start', { method:'POST' });
  toast(r.success ? _t('Gateway 已重启') : _t('重启失败'), r.error || '');
  appendMsgLog(r.success ? _t('[restart] Gateway 重启成功') : _t('[restart] Gateway 重启失败: {0}', r.error || 'unknown'));
  if (r.success && $('btn-msg-restart')) $('btn-msg-restart').style.display = 'none';
});

qa('[data-save-msg]').forEach(btn => {
  btn.addEventListener('click', async ()=>{
    const platform = btn.getAttribute('data-save-msg');
    appendMsgLog(_t('[save] 开始保存 {0} 配置...', platform));
    const update = { channels: {} };
    const enabled = ($(`${platform}-enabled`)?.value || 'false') === 'true';
    update.channels[platform] = { enabled };

    if (platform === 'feishu'){
      // Write nested structure: accounts.default (OpenClaw requires default or bindings)
      const feishuAcct = {
        appId:             $('feishu-appid').value,
        appSecret:         $('feishu-secret').value,
        botName:           $('feishu-botname').value,
        dmPolicy:          $('feishu-dmpolicy')?.value || 'open',
      };
      // Only include optional fields if non-empty (avoid empty strings confusing Gateway schema)
      const vt = $('feishu-token').value.trim();
      const ek = $('feishu-encrypt').value.trim();
      if (vt) feishuAcct.verificationToken = vt;
      if (ek) feishuAcct.encryptKey = ek;
      update.channels.feishu.accounts = { default: feishuAcct };
    }
    if (platform === 'discord'){
      const guildIds = parseGuildIds($('discord-guilds')?.value || '');
      Object.assign(update.channels.discord, {
        token:           $('discord-token').value,
        groupPolicy:     $('discord-grouppolicy')?.value || 'allowlist',
        streaming:       $('discord-streaming')?.value || 'partial',
        historyLimit:    Number($('discord-historylimit')?.value) || 30,
        dmHistoryLimit:  Number($('discord-dmhistorylimit')?.value) || 50,
      });
      // OpenClaw official schema: use guilds (multi-server)
      update.channels.discord.guilds = Object.fromEntries(guildIds.map((id) => [id, {}]));
      // Mark backend for full replacement, avoid deepMerge leaving old servers
      update.channels.discord.__replaceGuilds = true;
      appendMsgLog(_t('[save] Discord 服务器数: {0}', guildIds.length));
    }
    if (platform === 'telegram'){
      update.channels.telegram.token = $('telegram-token').value;
      update.channels.telegram.allowedUsers = $('telegram-users').value;
    }
    if (platform === 'signal'){
      update.channels.signal.cliPath = $('signal-cli').value;
      update.channels.signal.phone = $('signal-phone').value;
    }
    if (platform === 'whatsapp'){
      update.channels.whatsapp.apiUrl = $('whatsapp-url').value;
      update.channels.whatsapp.apiKey = $('whatsapp-key').value;
    }

    const r = await api('/api/config', { method:'POST', body:update });
    if (r.success) {
      await loadMessagingConfig();
      const saved = Array.isArray(r.savedChannels) && r.savedChannels.length
        ? r.savedChannels.join(', ')
        : platform;
      toast(_t('保存成功'), _t('已写入 channels.{0}，需重启 Gateway to apply', saved));
      appendMsgLog(_t('[save] 保存成功: channels.{0}', saved));
      if ($('btn-msg-restart')) $('btn-msg-restart').style.display = '';
    } else {
      appendMsgLog(_t('[save] 保存失败: {0}', r.error || 'unknown'));
      toast(_t('保存失败'), r.error || '');
    }
  });
});

// ------------------------
// Remote device management (Node mode)
// ------------------------
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

async function loadDeviceManagement(forceConnectedRefresh = false) {
  if (window.__deviceMgmtRefreshing) return;
  window.__deviceMgmtRefreshing = true;
  try {
  // Parallel load: setup command + pairing list + security config + connected nodes
  const [cmdRes, pairRes, secRes, connRes] = await Promise.all([
    api('/api/node/setup-command'),
    api('/api/openclaw/pairing/list'),
    api('/api/node/security'),
    api(`/api/node/connected${forceConnectedRefresh ? '?force=1' : ''}`)
  ]);

  // Quick-connect command
  const cmdEl = $('device-setup-command');
  const cmdWinEl = $('device-setup-command-win');
  const cmdBgEl = $('device-setup-command-bg');
  const cmdWinBgEl = $('device-setup-command-win-bg');
  const cmdNoteEl = $('device-setup-command-note');
  if (cmdEl) {
    if (cmdRes.success && cmdRes.hasToken) {
      cmdEl.textContent = cmdRes.command;
    } else {
      cmdEl.textContent = cmdRes.command || _t('# 加载失败');
    }
  }
  if (cmdWinEl) {
    if (cmdRes.success && cmdRes.hasToken && cmdRes.commandWindows) {
      cmdWinEl.textContent = cmdRes.commandWindows;
    } else {
      cmdWinEl.textContent = _t('# Windows 命令加载失败');
    }
  }
  if (cmdBgEl) {
    if (cmdRes.success && cmdRes.hasToken && cmdRes.bgCmd) {
      cmdBgEl.textContent = cmdRes.bgCmd;
    } else {
      cmdBgEl.textContent = _t('# 后台命令加载失败');
    }
  }
  if (cmdWinBgEl) {
    if (cmdRes.success && cmdRes.hasToken && cmdRes.bgCmdWindows) {
      cmdWinBgEl.textContent = cmdRes.bgCmdWindows;
    } else {
      cmdWinBgEl.textContent = _t('# Windows 后台命令加载失败');
    }
  }
  if (cmdNoteEl) {
    const noteParts = [];
    noteParts.push(cmdRes.tlsNote || _t('命令会根据当前 HTTPS 配置决定是否保留 NODE_TLS_REJECT_UNAUTHORIZED=0；无法可靠判断时会保守保留。'));
    if (cmdRes.nodeBgDir) {
      noteParts.push(_t('后台模式会为当前 Gateway 使用独立目录 {0}，不同 Gateway 可同时运行。', cmdRes.nodeBgDir));
    }
    cmdNoteEl.textContent = noteParts.join(' ');
  }

  // Online nodes list
  renderConnectedNodes(connRes);

  // Pairing approval list
  renderPairingList(pairRes);

  // Paired devices list
  renderPairedList(pairRes, connRes);

  // Security configuration
  if (secRes.success) {
    if ($('device-auto-approve')) $('device-auto-approve').value = String(!!secRes.autoApprove);
    if ($('device-browser-mode')) $('device-browser-mode').value = secRes.browserMode || 'auto';
    if ($('device-exec-security')) $('device-exec-security').value = secRes.execSecurity || 'full';
    if ($('device-deny-commands')) $('device-deny-commands').value = (secRes.denyCommands || []).join('\n');
    toggleAutoApproveWarning();
  }
  } finally {
    window.__deviceMgmtRefreshing = false;
  }
}

function startDeviceManagementPolling() {
  if (deviceMgmtPollTimer) {
    clearInterval(deviceMgmtPollTimer);
    deviceMgmtPollTimer = null;
  }
  loadDeviceManagement();
}

function friendlyPlatform(p) {
  const m = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  return m[(p || '').toLowerCase()] || p || '';
}

function buildConnectedNodeIndex(r) {
  const index = new Map();
  if (!r || !r.success || !Array.isArray(r.nodes)) return index;
  r.nodes.forEach((node) => {
    const key = String(node?.nodeId || node?.deviceId || '').trim();
    if (key) index.set(key, node);
  });
  return index;
}

function setDeviceCommandTab(mode) {
  const panes = {
    linux: $('device-setup-command'),
    'linux-bg': $('device-setup-command-bg'),
    win: $('device-setup-command-win'),
    'win-bg': $('device-setup-command-win-bg')
  };
  const tabs = {
    linux: $('tab-cmd-linux'),
    'linux-bg': $('tab-cmd-bg'),
    win: $('tab-cmd-win'),
    'win-bg': $('tab-cmd-win-bg')
  };
  Object.values(panes).forEach((pane) => {
    if (pane) pane.style.display = 'none';
  });
  Object.entries(tabs).forEach(([key, tab]) => {
    if (tab) tab.style.fontWeight = key === mode ? '700' : '400';
  });
  if (panes[mode]) panes[mode].style.display = '';
}

function renderConnectedNodes(r) {
  const listEl = $('connected-nodes-list');
  if (!listEl) return;
  if (!r || !r.success) {
    listEl.innerHTML = '<div class="muted small">' + _t('读取失败') + ': ' + esc(r?.error || '') + '</div>';
    return;
  }
  const nodes = r.nodes || [];
  if (!nodes.length) {
    listEl.innerHTML = '<div class="muted small" style="color:#8b949e">' + _t('暂无已配对的 Node 节点') + '</div>';
    return;
  }
  listEl.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<tr style="border-bottom:1px solid #30363d;color:#8b949e;font-size:12px">' +
    '<th style="text-align:left;padding:6px 8px">' + _t('状态') + '</th>' +
    '<th style="text-align:left;padding:6px 8px">' + _t('名称') + '</th>' +
    '<th style="text-align:left;padding:6px 8px">' + _t('平台') + '</th>' +
    '<th style="text-align:left;padding:6px 8px">IP</th>' +
    '<th style="text-align:left;padding:6px 8px">' + _t('时间') + '</th>' +
    '</tr>' +
    nodes.map(n => {
      const statusDot = n.connected
        ? '<span style="color:#3fb950" title="' + _t('在线') + '">●</span>'
        : '<span style="color:#f85149" title="' + _t('离线') + '">●</span>';
      const statusText = n.connected ? _t('在线') : _t('离线');
      const statusTimeMs = n.connected ? n.connectedAtMs : n.offlineAtMs;
      const timeLabel = n.connected ? _t('连接时间') : _t('离线时间');
      const connTime = statusTimeMs ? `${timeLabel}：${new Date(statusTimeMs).toLocaleString()}` : '-';
      const ipText = String(n.ipAddress || '').trim();
      return '<tr style="border-bottom:1px solid #21262d">' +
        `<td style="padding:6px 8px">${statusDot} <span class="muted small">${statusText}</span></td>` +
        `<td style="padding:6px 8px;font-weight:600">${esc(n.displayName || '')}</td>` +
        `<td style="padding:6px 8px"><span class="muted small">${esc(friendlyPlatform(n.platform))}</span></td>` +
        `<td style="padding:6px 8px"><span class="muted small">${esc(ipText || '-')}</span></td>` +
        `<td style="padding:6px 8px"><span class="muted small">${connTime}</span></td>` +
        '</tr>';
    }).join('') +
    '</table>';
}

function renderPairingList(r) {
  const listEl = $('pairing-pending-list');
  if (!listEl) return;
  if (!r || !r.success) {
    listEl.innerHTML = '<div class="muted small">' + _t('读取失败') + ': ' + esc(r?.error || '') + '</div>';
    return;
  }
  const pending = r.pending || [];
  if (!pending.length) {
    listEl.innerHTML = '<div class="muted small" style="color:#8b949e">' + _t('暂无待审批的配对请求') + '</div>';
    return;
  }
  listEl.innerHTML = pending.map((p) => {
    const age = Math.round((Date.now() - (p.ts || 0)) / 1000);
    const ageStr = age < 60 ? age + _t('秒前') : Math.round(age / 60) + _t('分钟前');
    const name = esc(p.displayName || p.clientId || _t('未知设备'));
    const plat = esc(friendlyPlatform(p.platform));
    const mode = esc(p.clientMode || 'operator');
    const role = esc(p.role || 'operator');
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#1a1a2e;border-radius:6px;margin-bottom:4px">'
      + '<span style="flex:1;font-size:12px"><b>' + name + '</b>'
      + (plat ? ' <span class="muted small">(' + plat + ')</span>' : '')
      + ' · <span class="muted small">' + mode + '</span>'
      + ' · <span class="muted small">' + role + '</span>'
      + ' · <span class="muted small">' + ageStr + '</span></span>'
      + '<button class="btn btn-primary" style="font-size:12px;padding:2px 12px" data-approve-id="' + esc(p.requestId) + '">' + _t('审批通过') + '</button>'
      + '</div>';
  }).join('');
  listEl.querySelectorAll('[data-approve-id]').forEach((btn) => {
    btn.addEventListener('click', () => approvePairing(btn.dataset.approveId, btn));
  });
}

function renderPairedList(r, connRes) {
  const listEl = $('device-paired-list');
  if (!listEl) return;
  if (!r || !r.success) {
    listEl.innerHTML = '<div class="muted" style="text-align:center;padding:20px;color:#ff453a">' + _t('加载失败') + '</div>';
    return;
  }
  const paired = r.paired || [];
  const connectedIndex = buildConnectedNodeIndex(connRes);
  if (!paired.length) {
    listEl.innerHTML = '<div class="muted" style="text-align:center;padding:20px">' + _t('暂无已配对设备') + '</div>';
    return;
  }
  listEl.innerHTML = paired.map((d) => {
    const name = esc(d.displayName || d.clientId || _t('未知'));
    const plat = esc(friendlyPlatform(d.platform));
    const mode = esc(d.clientMode || 'operator');
    const roles = (d.roles || [d.role || 'operator']).map(esc).join(', ');
    const time = d.approvedAtMs ? new Date(d.approvedAtMs).toLocaleString() : '—';
    const devId = esc(d.deviceId || '');
    const liveNode = connectedIndex.get(d.deviceId || '') || null;
    const isConnected = Boolean(liveNode?.connected);
    const liveStatus = '';
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap">'
      + `<span style="color:${isConnected ? '#3fb950' : '#8b949e'};font-size:14px">●</span>`
      + '<b style="min-width:80px">' + name + '</b>'
      + (plat ? '<span class="muted small">(' + plat + ')</span>' : '')
      + '<span class="muted small">' + mode + '</span>'
      + '<span class="muted small">' + _t('角色') + ': ' + roles + '</span>'
      + '<span class="muted small">' + _t('审批于') + ': ' + time + '</span>'
      + liveStatus
      + '<span style="flex:1"></span>'
      + '<code class="muted small" title="Device ID">' + devId.slice(0, 8) + '…</code>'
      + '<button class="btn btn-sm btn-danger" data-unpair-id="' + devId + '" style="font-size:11px;padding:2px 8px">' + _t('取消配对') + '</button>'
      + '</div>';
  }).join('');
  listEl.querySelectorAll('[data-unpair-id]').forEach((btn) => {
    const liveNode = connectedIndex.get(btn.dataset.unpairId || '') || null;
    btn.addEventListener('click', () => unpairDevice(btn.dataset.unpairId, {
      connected: Boolean(liveNode?.connected),
      displayName: liveNode?.displayName || null
    }));
  });
}

async function approvePairing(requestId, btn) {
  const resultEl = $('pairing-result');
  btn.disabled = true; btn.textContent = _t('审批中...');
  if (resultEl) { resultEl.textContent = ''; resultEl.style.color = ''; }
  try {
    const r = await api('/api/openclaw/pairing/approve', { method: 'POST', body: { requestId } });
    if (r.success) {
      if (resultEl) { resultEl.textContent = _t('✅ 审批成功 (deviceId: ') + (r.deviceId || '').slice(0, 8) + '…)'; resultEl.style.color = '#30d158'; }
      setTimeout(() => loadDeviceManagement(), 500);
    } else {
      if (resultEl) { resultEl.textContent = '❌ ' + (r.error || _t('审批失败')); resultEl.style.color = '#ff453a'; }
    }
  } catch (e) {
    if (resultEl) { resultEl.textContent = _t('❌ 网络错误'); resultEl.style.color = '#ff453a'; }
  } finally {
    btn.disabled = false; btn.textContent = _t('审批通过');
  }
}

async function unpairDevice(deviceId, opts = {}) {
  const connected = opts.connected === true;
  const targetName = String(opts.displayName || '').trim();
  const label = targetName ? `“${targetName}”` : _t('该设备');
  const message = connected
    ? _t('确定取消{0}的配对吗？\n\n该节点当前在线，确认后会删除配对关系，当前连接会失效。\n如果远端是后台运行，远端命令不会自动退出，仍会继续重试连接。', label)
    : _t('确定取消{0}的配对吗？\n\n该设备当前离线，确认后只会删除配对关系。', label);
  if (!confirm(message)) return;
  const r = await api('/api/node/unpair', { method: 'POST', body: { deviceId } });
  if (r.success) {
    toast(r.disconnected ? _t('已取消配对；当前连接已失效，远端后台命令需手动停止或重新配对') : _t('已取消配对'));
    loadDeviceManagement();
  } else {
    toast(_t('操作失败'), r.error || '');
  }
}

function toggleAutoApproveWarning() {
  const warn = $('device-auto-approve-warning');
  const val = $('device-auto-approve')?.value;
  if (warn) warn.style.display = val === 'true' ? '' : 'none';
}

$('device-auto-approve')?.addEventListener('change', toggleAutoApproveWarning);

const deviceMgmtPageEl = $('page-browser');
deviceMgmtPageEl?.addEventListener('focusin', (event) => {
  if (event.target instanceof Element && event.target.closest('input, textarea, select, button')) {
    markDeviceManagementInteracting();
  }
});
deviceMgmtPageEl?.addEventListener('input', (event) => {
  if (event.target instanceof Element && event.target.closest('input, textarea, select')) {
    markDeviceManagementInteracting();
  }
});
deviceMgmtPageEl?.addEventListener('change', (event) => {
  if (event.target instanceof Element && event.target.closest('input, textarea, select')) {
    markDeviceManagementInteracting();
  }
});

// Copy quick-connect command
$('btn-copy-setup-cmd')?.addEventListener('click', () => {
  // Copy whichever tab is visible
  const linuxEl = $('device-setup-command');
  const winEl = $('device-setup-command-win');
  const bgEl = $('device-setup-command-bg');
  const winBgEl = $('device-setup-command-win-bg');
  const isWinVisible = winEl && winEl.style.display !== 'none';
  const isBgVisible = bgEl && bgEl.style.display !== 'none';
  const isWinBgVisible = winBgEl && winBgEl.style.display !== 'none';
  let text = '', label = '';
  if (isWinBgVisible) {
    text = winBgEl?.textContent || '';
    label = _t('Windows 后台运行');
  } else if (isBgVisible) {
    text = bgEl?.textContent || '';
    label = _t('后台运行');
  } else if (isWinVisible) {
    text = winEl?.textContent || '';
    label = 'Windows PowerShell';
  } else {
    text = linuxEl?.textContent || '';
    label = 'Linux/macOS';
  }
  navigator.clipboard.writeText(text).then(
    () => toast(_t('已复制 {0} 连接命令', label)),
    () => toast(_t('复制失败'))
  );
});

// Refresh
$('btn-device-refresh')?.addEventListener('click', () => loadDeviceManagement(true));
$('btn-pairing-refresh')?.addEventListener('click', () => loadDeviceManagement(true));
$('btn-connected-refresh')?.addEventListener('click', () => loadDeviceManagement(true));

// Save security configuration
$('btn-device-save-security')?.addEventListener('click', async () => {
  const autoApprove = ($('device-auto-approve')?.value || 'false') === 'true';
  const browserMode = $('device-browser-mode')?.value || 'auto';
  const execSecurity = $('device-exec-security')?.value || 'full';
  const denyCommands = ($('device-deny-commands')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);

  const r = await api('/api/node/security', { method: 'POST', body: { autoApprove, browserMode, execSecurity, denyCommands } });
  if (r.success) {
    toast(_t('安全配置已保存'), _t('部分配置需重启 Gateway to apply'));
    if ($('btn-device-restart-gw')) $('btn-device-restart-gw').style.display = '';
  } else {
    toast(_t('保存失败'), r.error || '');
  }
});

// Restart Gateway
$('btn-device-restart-gw')?.addEventListener('click', async () => {
  const r = await api('/api/openclaw/start', { method: 'POST' });
  toast(r.success ? _t('Gateway 已重启') : _t('重启失败'), r.error || '');
  if (r.success) {
    if ($('btn-device-restart-gw')) $('btn-device-restart-gw').style.display = 'none';
    setTimeout(() => loadDeviceManagement(), 2000);
  }
});

// ------------------------
// Plugins (Skills & Extensions)
// ------------------------
let _scanResults = []; // cached scan results
let _installedSkills = []; // cached installed skills for comparison
let _scanIsLocal = false; // whether current scan is from browser local

function skillSourceBadge(source) {
  if (!source) return '';
  if (source === 'bundled') return '<span style="background:#e3f2fd;color:#1565c0;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px">' + _t('内置') + '</span>';
  if (source === 'managed') return '<span style="background:#e8f5e9;color:#2e7d32;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px">' + _t('用户安装') + '</span>';
  if (source.startsWith('ext:')) return `<span style="background:#e8eaf6;color:#283593;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px">${_t('扩展')}</span><span style="background:#fff3e0;color:#e65100;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:3px">${escapeHtml(source.slice(4))}</span>`;
  return '';
}

function skillCard(s) {
  const secBadge = s.securityWarnings > 0
    ? '<span style="background:#fff3e0;color:#e65100;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px" title="' + escapeHtml((s.securityDetails || []).join('; ')) + '">⚠ ' + _t('注意') + '</span>'
    : '';
  const secDetail = s.securityWarnings > 0 && (s.securityDetails || []).length
    ? `<div class="muted small" style="color:#ffa726;margin-top:2px">⚠ ${escapeHtml(s.securityDetails.join('; '))}</div>`
    : '';
  return `
    <div class="card" style="margin-bottom:10px;padding:10px 14px${s.securityWarnings > 0 ? ';border-left:3px solid #ff9800' : ''}">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700">${escapeHtml(s.name)}${skillSourceBadge(s.source)}${secBadge}</div>
          ${s.description ? `<div class="muted small" style="margin-top:2px">${escapeHtml(s.description)}</div>` : ''}
          ${secDetail}
        </div>
        ${s.source === 'managed' ? `<button class="btn" style="font-size:12px;padding:2px 10px;white-space:nowrap" data-skill-remove="${escapeHtml(s.name)}">${_t('移除')}</button>` : ''}
      </div>
    </div>`;
}

function scanSkillCard(s, idx) {
  // Match with installed skills
  const installed = _installedSkills.find(i => i.name === s.dirName);
  const contentDiffers = installed && s.contentHash && installed.contentHash && s.contentHash !== installed.contentHash && s.dirName === installed.name;
  // If both sides have a meaningful SKILL.md name and they differ → different skill, just dir-name collision
  const skillNameMismatch = contentDiffers && installed.skillName && s.name && s.name !== s.dirName && installed.skillName !== s.name;
  const hasUpdate = contentDiffers && !skillNameMismatch && installed.source !== 'managed';
  const nameConflict = contentDiffers && (skillNameMismatch || installed.source === 'managed');
  const isLocalScan = !!s._localScan;
  let statusBadge = '';
  if (installed && hasUpdate) {
    statusBadge = '<span style="color:#ff9800;font-size:11px;margin-left:6px;font-weight:700">↑ ' + _t('有更新') + '</span>';
  } else if (skillNameMismatch) {
    statusBadge = '<span style="color:#ff9800;font-size:11px;margin-left:6px">⚠ ' + _t('同名目录 (不同 Skill)') + '</span>';
  } else if (nameConflict) {
    statusBadge = '<span style="color:#ff9800;font-size:11px;margin-left:6px">⚠ ' + _t('同名已安装 (Custom)') + '</span>';
  } else if (installed && isLocalScan) {
    statusBadge = '<span style="color:#2196f3;font-size:11px;margin-left:6px">⟳ ' + _t('已安装 (可覆盖)') + '</span>';
  } else if (installed) {
    statusBadge = '<span style="color:#4caf50;font-size:11px;margin-left:6px">✓ ' + _t('已安装') + '</span>';
  } else if (!s.valid) {
    statusBadge = '<span style="color:#f44;font-size:11px;margin-left:6px">✗ ' + _t('无效') + '</span>';
  }
  const warningHtml = (s.warnings || []).length
    ? `<div class="muted small" style="color:#ffa726;margin-top:2px">⚠ ${escapeHtml(s.warnings.join('; '))}</div>`
    : '';
  const errorHtml = (s.errors || []).length
    ? `<div class="muted small" style="color:#f44;margin-top:2px">✗ ${escapeHtml(s.errors.join('; '))}</div>`
    : '';
  const canInstall = s.valid && (!installed || hasUpdate || nameConflict || isLocalScan);
  return `
    <div class="card" style="margin-bottom:6px;padding:8px 12px;opacity:${!canInstall && !hasUpdate ? '0.6' : '1'}">
      <div class="row" style="align-items:flex-start;gap:8px">
        <input type="checkbox" data-scan-idx="${idx}" ${canInstall ? '' : 'disabled'} style="margin-top:4px" />
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px">${escapeHtml(s.name)}${statusBadge}</div>
          <div class="muted small" style="margin-top:1px">${escapeHtml(s.description || '')}</div>
          <div class="muted small" style="margin-top:1px;color:#888">📁 ${escapeHtml(s.relPath || s.dirName)}</div>
          ${warningHtml}${errorHtml}
        </div>
      </div>
    </div>`;
}

function extensionCard(ext) {
  return `
    <div class="card" style="margin-bottom:10px;padding:10px 14px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:700">${escapeHtml(ext.name)}</div>
          <div class="muted small" style="margin-top:2px">${escapeHtml(ext.version ? `v${ext.version}` : '')} ${escapeHtml(ext.description || '')}</div>
        </div>
        <button class="btn" style="font-size:12px;padding:2px 10px" data-ext-remove="${escapeHtml(ext.name)}">${_t('卸载')}</button>
      </div>
    </div>`;
}

async function refreshPlugins() {
  const d = await api('/api/plugins/list');
  if (d.error) return toast(_t('加载失败'), d.error);

  const skillsList = d.skills || [];
  const extsList = d.extensions || [];
  _installedSkills = skillsList; // cache for comparison

  // Separate managed skills from bundled and extension
  const userSkills = skillsList.filter(s => s.source === 'managed');
  const extSkills = skillsList.filter(s => s.source && s.source.startsWith('ext:'));
  const bundledSkills = skillsList.filter(s => s.source === 'bundled');

  function skillGroupHtml(label, skills, collapsed) {
    const arrow = collapsed ? '▶' : '▼';
    const display = collapsed ? 'none' : '';
    return `<div style="margin-top:12px;border-top:1px solid #333;padding-top:10px">
      <div style="cursor:pointer;user-select:none;color:#8e8e93;font-size:13px" onclick="const c=this.nextElementSibling;const a=c.style.display==='none';c.style.display=a?'':'none';this.querySelector('span').textContent=a?'▼':'▶'">
        <span>${arrow}</span> ${label} (${skills.length})
      </div>
      <div style="display:${display};margin-top:8px">${skills.map(skillCard).join('')}</div>
    </div>`;
  }

  let html = '';
  if (userSkills.length) {
    html += skillGroupHtml(_t('用户安装'), userSkills, false);
  } else {
    html += '<div class="muted small" style="padding:12px 0">' + _t('暂无用户安装的 Skill。') + '</div>';
  }
  if (extSkills.length) {
    html += skillGroupHtml(_t('扩展') + ' Skills', extSkills, true);
  }
  if (bundledSkills.length) {
    html += skillGroupHtml(_t('内置') + ' Skills', bundledSkills, true);
  }
  $('skills-list').innerHTML = html;

  $('extensions-list').innerHTML = extsList.length
    ? extsList.map(extensionCard).join('')
    : '<div class="muted small" style="padding:12px 0">' + _t('暂无用户额外安装的 Extension。OpenClaw 内置的 40+ Extensions 已自动加载。') + '</div>';
}

$('btn-plugins-refresh')?.addEventListener('click', refreshPlugins);

// Tab switching
$('plugins-tabs')?.addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  const ptab = t.getAttribute('data-ptab');
  qa('#plugins-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
  $('plugins-skills').hidden = ptab !== 'skills';
  $('plugins-extensions').hidden = ptab !== 'extensions';
});

// Install Skill — Scan workflow
// --- Client-side helpers for local dir scanning ---
const SKILL_DANGEROUS_PATTERNS_CLIENT = [
  /\beval\s*\(/i, /\bexec\s*\(/i, /\bspawn\s*\(/i,
  /\brm\s+-rf\b/i, /\bsudo\b/i, /\bcurl\b.*\|\s*bash/i,
  /\bwget\b.*\|\s*bash/i, /process\.env/i,
  /child_process/i, /\brequire\s*\(/i, /\bimport\s*\(/i
];
const SKILL_SUSPICIOUS_EXTS = ['.sh', '.bash', '.py', '.js', '.ts', '.exe', '.bat', '.cmd', '.ps1', '.rb', '.pl'];

function clientParseSkillMd(content) {
  const lines = content.split('\n');
  let name = '', description = '', inFm = false, fmLines = [];
  // Try YAML frontmatter first
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
      const h = l.match(/^#{1,3}\s+(.+)/);
      if (h) { name = h[1].trim(); break; }
    }
  }
  // Fallback: first body line for description
  if (!description) {
    inFm = false;
    for (const l of lines) {
      const t = l.trim();
      if (t === '---') { inFm = !inFm; continue; }
      if (inFm || !t || t.startsWith('#')) continue;
      description = t.slice(0, 200);
      break;
    }
  }
  return { name, description, content };
}

function clientValidateSecurity(files) {
  const warnings = [], errors = [];
  const skillMdFile = files.find(f => f.path === 'SKILL.md');
  if (!skillMdFile) { errors.push(_t('缺少 SKILL.md 文件')); return { valid: false, errors, warnings }; }
  for (const pat of SKILL_DANGEROUS_PATTERNS_CLIENT) {
    if (pat.test(skillMdFile.textContent || '')) warnings.push(_t('SKILL.md 包含可疑模式: {0}', pat.source));
  }
  for (const f of files) {
    const ext = '.' + f.path.split('.').pop().toLowerCase();
    if (SKILL_SUSPICIOUS_EXTS.includes(ext)) warnings.push(_t('包含脚本文件: {0}', f.path));
    if (f.size > 5 * 1024 * 1024) warnings.push(_t('大文件 (>{0}MB): {1}', Math.round(f.size / 1048576), f.path));
    if (f.path !== 'SKILL.md' && f.path.endsWith('.md')) {
      for (const pat of SKILL_DANGEROUS_PATTERNS_CLIENT) {
        if (pat.test(f.textContent || '')) { warnings.push(_t('{0} 包含可疑模式: {1}', f.path, pat.source)); break; }
      }
    }
  }
  if (files.length > 200) warnings.push(_t('目录包含过多文件 (>{0})', files.length));
  return { valid: errors.length === 0, errors, warnings };
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function browserScanDirectory(dirHandle, maxDepth) {
  if (!maxDepth) maxDepth = 8;
  const results = [];

  async function walk(handle, relPath, depth) {
    if (depth > maxDepth) return;
    let hasSkillMd = false;
    let skillMdText = '';
    const children = [];
    for await (const [name, entry] of handle.entries()) {
      children.push({ name, entry });
      if (name === 'SKILL.md' && entry.kind === 'file') {
        const file = await entry.getFile();
        skillMdText = await file.text();
        hasSkillMd = true;
      }
    }
    if (hasSkillMd) {
      const files = [];
      async function collect(h, prefix, d) {
        if (d > 3 || files.length > 200) return;
        for await (const [n, e] of h.entries()) {
          if (n.startsWith('.')) continue;
          if (e.kind === 'file') {
            const file = await e.getFile();
            if (file.size > 5 * 1024 * 1024) { files.push({ path: prefix ? prefix + '/' + n : n, size: file.size, content: '', textContent: '' }); continue; }
            const b64 = await readFileAsBase64(file);
            let textContent = '';
            if (n.endsWith('.md') || n.endsWith('.txt') || n.endsWith('.yaml') || n.endsWith('.yml') || n.endsWith('.json')) {
              textContent = await file.text();
            }
            files.push({ path: prefix ? prefix + '/' + n : n, content: b64, size: file.size, textContent });
          } else if (e.kind === 'directory') {
            await collect(e, prefix ? prefix + '/' + n : n, d + 1);
          }
        }
      }
      await collect(handle, '', 0);
      const parsed = clientParseSkillMd(skillMdText);
      const check = clientValidateSecurity(files);
      // Compute simple hash of SKILL.md content
      let contentHash = '';
      try {
        const enc = new TextEncoder().encode(skillMdText);
        const buf = await crypto.subtle.digest('SHA-256', enc);
        contentHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
      } catch {}
      results.push({
        name: parsed.name || handle.name,
        dirName: handle.name,
        relPath: relPath || '.',
        description: parsed.description,
        valid: check.valid,
        errors: check.errors,
        warnings: check.warnings,
        contentHash,
        files, // needed for upload
        _localScan: true
      });
      return;
    }
    for (const { name, entry } of children) {
      if (entry.kind !== 'directory') continue;
      if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
      await walk(entry, relPath ? relPath + '/' + name : name, depth + 1);
    }
  }

  await walk(dirHandle, '', 0);
  return results;
}

function showScanResults(skills, logEl) {
  _scanResults = skills;
  const pre = logEl?.querySelector('pre');
  if (pre) pre.textContent += _t('找到 {0} 个 Skill\n', skills.length);
  if (skills.length === 0) {
    if (pre) pre.textContent += _t('该源中未找到包含 SKILL.md 的目录\n');
    $('skill-scan-results').style.display = 'none';
    return;
  }
  // Mark installed state
  for (const s of _scanResults) {
    s.installed = _installedSkills.some(i => i.name === s.dirName);
  }
  $('skill-scan-title').textContent = _t('扫描结果 — 共 {0} 个 Skill', skills.length);
  $('skill-scan-list').innerHTML = _scanResults.map((s, i) => scanSkillCard(s, i)).join('');
  $('skill-scan-results').style.display = '';
  if (logEl) logEl.style.display = 'none';
}

// Scan from GitHub URL
$('btn-skill-scan')?.addEventListener('click', async () => {
  const input = $('skill-url-input');
  const source = (input?.value || '').trim();
  if (!source) return toast(_t('请输入'), _t('请输入 GitHub URL'));

  const logEl = $('skill-install-log');
  const pre = logEl?.querySelector('pre');
  logEl.style.display = '';
  pre.textContent = _t('正在扫描...\n');

  const btn = $('btn-skill-scan');
  btn.disabled = true;
  btn.textContent = _t('扫描中...');
  _scanIsLocal = false;

  try {
    // Refresh installed list first
    const list = await api('/api/plugins/list');
    if (list.skills) _installedSkills = list.skills;

    const r = await api('/api/plugins/skill/scan', { method: 'POST', body: { source }, timeoutMs: 180000 });
    if (r.error) {
      pre.textContent += _t('错误: {0}\n', r.error);
      toast(_t('扫描失败'), r.error);
      return;
    }
    showScanResults(r.skills || [], logEl);
  } catch (e) {
    pre.textContent += _t('错误: {0}\n', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = _t('🔍 扫描');
  }
});

// Browse local directory (browser filesystem)
// Safari fallback: process files from <input webkitdirectory>
async function browserScanFromFileList(fileList) {
  const tree = {}; // { topDir: { relPath: File } }
  for (const f of fileList) {
    const parts = f.webkitRelativePath.split('/');
    if (parts.length < 2) continue;
    const topDir = parts[0]; // root directory name
    const relPath = parts.slice(1).join('/');
    if (!tree[topDir]) tree[topDir] = {};
    tree[topDir][relPath] = f;
  }

  // Build a virtual FS handle-like structure and scan each skill dir
  const results = [];
  for (const [dirName, files] of Object.entries(tree)) {
    if (!files['SKILL.md']) {
      // Check sub-dirs for SKILL.md
      const subDirs = {};
      for (const [rel, file] of Object.entries(files)) {
        const parts = rel.split('/');
        if (parts.length < 2) continue;
        const sub = parts[0];
        const subRel = parts.slice(1).join('/');
        if (!subDirs[sub]) subDirs[sub] = {};
        subDirs[sub][subRel] = file;
      }
      for (const [sub, subFiles] of Object.entries(subDirs)) {
        const sk = await _processFileMap(sub, sub, subFiles);
        if (sk) results.push(sk);
      }
    } else {
      const sk = await _processFileMap(dirName, '.', files);
      if (sk) results.push(sk);
    }
  }
  return results;
}

async function _processFileMap(dirName, relPath, fileMap) {
  const skillMdFile = fileMap['SKILL.md'];
  if (!skillMdFile) return null;
  const skillMdText = await skillMdFile.text();
  const fileEntries = [];
  for (const [rel, file] of Object.entries(fileMap)) {
    if (rel.startsWith('.') || rel.split('/').some(p => p.startsWith('.'))) continue;
    if (file.size > 5 * 1024 * 1024) {
      fileEntries.push({ path: rel, size: file.size, content: '', textContent: '' });
      continue;
    }
    const b64 = await readFileAsBase64(file);
    let textContent = '';
    if (/\.(md|txt|yaml|yml|json)$/i.test(rel)) textContent = await file.text();
    fileEntries.push({ path: rel, content: b64, size: file.size, textContent });
  }
  const parsed = clientParseSkillMd(skillMdText);
  const check = clientValidateSecurity(fileEntries);
  let contentHash = '';
  try {
    const enc = new TextEncoder().encode(skillMdText);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    contentHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  } catch {}
  return {
    name: parsed.name || dirName,
    dirName,
    relPath,
    description: parsed.description,
    valid: check.valid,
    errors: check.errors,
    warnings: check.warnings,
    contentHash,
    files: fileEntries,
    _localScan: true
  };
}

async function handleLocalDirScan(getSkills, label) {
  const logEl = $('skill-install-log');
  const pre = logEl?.querySelector('pre');
  logEl.style.display = '';
  pre.textContent = _t('正在扫描本地目录: {0}\n', label);
  _scanIsLocal = true;

  const btn = $('btn-skill-browse');
  btn.disabled = true;
  btn.textContent = _t('扫描中...');

  try {
    const list = await api('/api/plugins/list');
    if (list.skills) _installedSkills = list.skills;

    pre.textContent += _t('正在读取文件并进行安全扫描...\n');
    const skills = await getSkills();

    const warnCount = skills.reduce((n, s) => n + (s.warnings?.length || 0), 0);
    const invalidCount = skills.filter(s => !s.valid).length;
    if (warnCount > 0) pre.textContent += _t('⚠ 安全扫描: {0} 条警告\n', warnCount);
    if (invalidCount > 0) pre.textContent += _t('✗ {0} 个无效 Skill\n', invalidCount);
    if (warnCount === 0 && invalidCount === 0 && skills.length > 0) pre.textContent += _t('✓ 安全扫描通过\n');

    showScanResults(skills, logEl);
  } catch (e) {
    pre.textContent += _t('错误: {0}\n', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = _t('📂 本地目录');
  }
}

$('btn-skill-browse')?.addEventListener('click', async () => {
  if (window.showDirectoryPicker) {
    // Chrome / Edge: use File System Access API
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    } catch (e) {
      if (e.name === 'AbortError') return;
      toast(_t('选择失败'), e.message);
      return;
    }
    await handleLocalDirScan(() => browserScanDirectory(dirHandle), dirHandle.name);
  } else {
    // Safari / Firefox fallback: use hidden <input webkitdirectory>
    const input = $('skill-dir-fallback');
    if (!input) {
      toast(_t('不支持'), _t('当前浏览器不支持目录选择'));
      return;
    }
    input.value = '';
    input.onchange = async () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      const label = files[0]?.webkitRelativePath?.split('/')[0] || _t('本地目录');
      await handleLocalDirScan(() => browserScanFromFileList(files), label);
    };
    input.click();
  }
});

// Select all in scan results
$('btn-skill-select-all')?.addEventListener('click', () => {
  const boxes = qa('#skill-scan-list input[type=checkbox]:not(:disabled)');
  const allChecked = [...boxes].every(b => b.checked);
  boxes.forEach(b => { b.checked = !allChecked; });
});

// Close scan results
$('btn-skill-scan-close')?.addEventListener('click', () => {
  $('skill-scan-results').style.display = 'none';
  _scanResults = [];
});

// Install selected skills from scan
$('btn-skill-install-selected')?.addEventListener('click', async () => {
  const boxes = qa('#skill-scan-list input[type=checkbox]:checked');
  const selected = [...boxes].map(b => {
    const idx = parseInt(b.getAttribute('data-scan-idx'), 10);
    return _scanResults[idx];
  }).filter(Boolean);

  if (selected.length === 0) return toast(_t('请选择'), _t('请勾选要安装的 Skills'));

  const logEl = $('skill-install-log');
  const pre = logEl?.querySelector('pre');
  logEl.style.display = '';
  pre.textContent = _t('正在安装 {0} 个 Skill...\n', selected.length);

  const btn = $('btn-skill-install-selected');
  btn.disabled = true;
  btn.textContent = _t('安装中...');

  try {
    let r;
    if (selected.some(s => s._localScan)) {
      // Browser-local scan: upload files to server
      const payload = selected.map(s => ({
        dirName: s.dirName,
        files: (s.files || []).map(f => ({ path: f.path, content: f.content }))
      }));
      r = await api('/api/plugins/skill/upload-install', { method: 'POST', body: { skills: payload }, timeoutMs: 120000 });
    } else {
      // Server-side scan (git clone): use existing endpoint
      r = await api('/api/plugins/skill/install-selected', { method: 'POST', body: { skills: selected }, timeoutMs: 120000 });
    }

    if (r.results) {
      for (const item of r.results) {
        const icon = item.success ? '✓' : '✗';
        const label = item.updated ? _t('更新成功') : _t('安装成功');
        pre.textContent += `${icon} ${item.name}: ${item.success ? label : item.error}`;
        if (item.warnings?.length) pre.textContent += ` ⚠ ${item.warnings.join('; ')}`;
        pre.textContent += '\n';
      }
    }

    if (r.installed > 0) {
      toast(_t('安装完成'), _t('成功安装 {0}/{1} 个 Skill，重启 Gateway 后生效', r.installed, r.total));
      $('skill-scan-results').style.display = 'none';
      _scanResults = [];
      refreshPlugins();
    } else {
      toast(_t('安装失败'), r.error || _t('未成功安装任何 Skill'));
    }
  } catch (e) {
    pre.textContent += _t('错误: {0}\n', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = _t('安装选中');
  }
});

// Install Extension from npm
$('btn-ext-install')?.addEventListener('click', async () => {
  const input = $('ext-npm-input');
  const pkg = (input?.value || '').trim();
  if (!pkg) return toast(_t('请输入'), _t('请输入 npm 包名'));

  const logEl = $('ext-install-log');
  const pre = logEl?.querySelector('pre');
  logEl.style.display = '';
  pre.textContent = _t('正在安装...\n');

  const btn = $('btn-ext-install');
  btn.disabled = true;
  btn.textContent = _t('安装中...');

  try {
    const r = await api('/api/plugins/extension/install', { method: 'POST', body: { package: pkg }, timeoutMs: 120000 });
    pre.textContent += (r.output || r.error || (r.success ? _t('安装成功') : _t('未知错误'))) + '\n';
    if (r.success) {
      toast(_t('安装成功'), _t('Extension 已安装，重启 Gateway 后生效'));
      input.value = '';
      refreshPlugins();
    } else {
      toast(_t('安装失败'), r.error || '');
    }
  } catch (e) {
    pre.textContent += _t('错误: {0}\n', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = _t('安装 Extension');
  }
});

// Remove skill
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-skill-remove]');
  if (!btn) return;
  const name = btn.getAttribute('data-skill-remove');
  if (!confirm(_t('确认移除 Skill "{0}"？', name))) return;
  btn.disabled = true;
  btn.textContent = _t('移除中...');
  const r = await api('/api/plugins/skill/remove', { method: 'POST', body: { name } });
  toast(r.success ? _t('已移除') : _t('移除失败'), r.error || '');
  refreshPlugins();
});

// Remove extension
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ext-remove]');
  if (!btn) return;
  const name = btn.getAttribute('data-ext-remove');
  if (!confirm(_t('确认卸载 Extension "{0}"？', name))) return;
  btn.disabled = true;
  btn.textContent = _t('卸载中...');
  const r = await api('/api/plugins/extension/remove', { method: 'POST', body: { name }, timeoutMs: 60000 });
  toast(r.success ? _t('已卸载') : _t('卸载失败'), r.error || '');
  refreshPlugins();
});

// ------------------------
// Terminal (interactive shell)
// ------------------------
let termWs = null;
let terminalBound = false;
let termResizeTimer = null;
let termReconnectTimer = null;
let termConnectInFlight = false;
let termWsToken = null;
let termFallbackTimer = null;
let termFailureCount = 0;
let termConnectTimeoutTimer = null;
let termEmulator = null;
let termFitAddon = null;
let termSseSource = null;
let termSseMode = false;
const TERM_CACHE_KEY = 'oc_terminal_cache_v2';
const TERM_CACHE_MAX = 2000000;
let termOutputCache = '';

function stripTerminalBootstrapNoise(text){
  const src = String(text ?? '');
  if (!src) return src;
  const lines = src.split('\n');
  const cleaned = lines.filter((line) => {
    const s = String(line || '').trim();
    if (!s) return true;
    if (s === 'export TERM=xterm-256color CLICOLOR=1 CLICOLOR_FORCE=1') return false;
    if (s === 'alias ls="ls --color=auto" 2>/dev/null || true') return false;
    if (s === 'alias grep="grep --color=auto" 2>/dev/null || true') return false;
    if (/^bash-[0-9.]+#\s+export\s+TERM=xterm-256color\s+CLICOLOR=1\s+CLICOLOR_FORCE=1$/i.test(s)) return false;
    if (/^bash-[0-9.]+#\s+alias\s+ls="ls --color=auto"\s+2>\/dev\/null\s+\|\|\s+true$/i.test(s)) return false;
    if (/^bash-[0-9.]+#\s+alias\s+grep="grep --color=auto"\s+2>\/dev\/null\s+\|\|\s+true$/i.test(s)) return false;
    if (s === _t('[terminal] 已连接（PTY）。直接在此区域输入命令并按回车执行。')) return false;
    if (s === _t('OpenClaw Terminal connected (PTY). 输入命令并回车执行。')) return false;
    return true;
  });
  return cleaned.join('\n');
}

function loadTerminalCache(){
  try {
    const raw = localStorage.getItem(TERM_CACHE_KEY);
    termOutputCache = raw ? stripTerminalBootstrapNoise(String(raw)) : '';
    if (termOutputCache.length > TERM_CACHE_MAX) {
      termOutputCache = termOutputCache.slice(-TERM_CACHE_MAX);
    }
    const firstNl = termOutputCache.indexOf('\n');
    if (firstNl > 0 && !termOutputCache.startsWith('\n')) {
      termOutputCache = termOutputCache.slice(firstNl + 1);
    }
  } catch {
    termOutputCache = '';
  }
}

function saveTerminalCache(){
  try {
    localStorage.setItem(TERM_CACHE_KEY, termOutputCache);
  } catch {}
}

function appendTerminalCache(text){
  const chunk = String(text ?? '');
  if (!chunk) return;
  termOutputCache += stripTerminalBootstrapNoise(chunk);
  if (termOutputCache.length > TERM_CACHE_MAX) {
    termOutputCache = termOutputCache.slice(-TERM_CACHE_MAX);
    const firstNl = termOutputCache.indexOf('\n');
    if (firstNl > 0) termOutputCache = termOutputCache.slice(firstNl + 1);
  }
  saveTerminalCache();
}

function ensureTerminalViewportFitted(retries = 6){
  if (getRouteFromHash() !== 'terminal') return;
  if (!termEmulator || !termFitAddon) return;
  const container = $('terminal');
  if (!container) return;
  if ((container.clientWidth || 0) < 120 || (container.clientHeight || 0) < 80) {
    if (retries > 0) setTimeout(() => ensureTerminalViewportFitted(retries - 1), 120);
    return;
  }
  try { termFitAddon.fit(); } catch {}
  sendTerminalResize();
}

function focusTerminalInput(){
  if (termEmulator) {
    try { termEmulator.focus(); } catch {}
    return;
  }
  $('terminal')?.focus();
}

function initTerminalEmulator(){
  if (termEmulator) return true;
  const terminalContainer = $('terminal');
  if (!terminalContainer) return false;
  if (!window.Terminal) return false;

  try {
    termEmulator = new window.Terminal({
      cursorBlink: true,
      cursorInactiveStyle: 'none',
      convertEol: true,
      scrollback: UI_XTERM_SCROLLBACK,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#05070f',
        foreground: '#f5f5f7',
        cursor: '#d1d1d6'
      }
    });

    if (window.FitAddon && window.FitAddon.FitAddon) {
      termFitAddon = new window.FitAddon.FitAddon();
      termEmulator.loadAddon(termFitAddon);
    }

    terminalContainer.innerHTML = '';
    termEmulator.open(terminalContainer);
    if (termFitAddon) termFitAddon.fit();

    if (termFitAddon) {
      setTimeout(() => termFitAddon.fit(), 50);
    }
    
    // Restore cache if it exists
    loadTerminalCache();
    if (termOutputCache) {
      termEmulator.write(termOutputCache);
    }

    termEmulator.onData((data) => {
      sendTerminalData(data);
    });

    return true;
  } catch (e) {
    dlog('xterm init failed', e?.message || e);
    termEmulator = null;
    termFitAddon = null;
    return false;
  }
}

function termAppendText(text){
  const chunkRaw = stripTerminalBootstrapNoise(String(text ?? ''));
  if (!chunkRaw) return;
  appendTerminalCache(chunkRaw);
  if (termEmulator) {
    const chunk = stripOsc(chunkRaw);
    if (!chunk) return;
    termEmulator.write(chunk);
    return;
  }

  const el = $('terminal');
  if (!el) return;
  const chunk = normalizeTerminalChunk(chunkRaw);
  if (!chunk) return;
  appendColored(el, chunk, UI_TERMINAL_MAX_LINES, !!$('term-autoscroll')?.checked);
}

function terminalDisconnect(){
  if (termReconnectTimer) {
    clearTimeout(termReconnectTimer);
    termReconnectTimer = null;
  }
  if (termFallbackTimer) {
    clearInterval(termFallbackTimer);
    termFallbackTimer = null;
  }
  closeSseTerminal();
  if (termWs){
    try{ termWs.close(); }catch{}
    termWs = null;
  }
  $('term-state').textContent = _t('未连接');
}

async function pullTerminalFallbackLogs(){
  if (termWs && termWs.readyState === WebSocket.OPEN) return;
  if (termSseMode) return;
  const d = await api(`/api/logs?lines=${UI_TERMINAL_FALLBACK_FETCH_LINES}`);
  if (d.error) return;
  const logs = String(d.logs || '').trimEnd();
  if (!logs) return;
  setColored($('terminal'), logs, UI_TERMINAL_MAX_LINES, !!$('term-autoscroll')?.checked);
  if ($('term-autoscroll')?.checked) {
    $('terminal').scrollTop = $('terminal').scrollHeight;
  }
}

function closeSseTerminal() {
  if (termSseSource) {
    try { termSseSource.close(); } catch {}
    termSseSource = null;
  }
  termSseMode = false;
}

function startSseTerminal() {
  if (termSseSource) return;
  closeSseTerminal();
  termSseMode = true;
  $('term-state').textContent = _t('SSE 模式连接中...');
  termAppendText(_t('\n[terminal] WebSocket 不可用，正在切换 SSE 交互模式...\n'));

  const es = new EventSource('/api/terminal/stream');
  termSseSource = es;

  es.onopen = () => {
    $('term-state').textContent = _t('SSE 已连接');
  };

  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'connected') {
        $('term-state').textContent = _t('SSE 已连接');
        termAppendText(_t('[terminal] SSE 交互终端已连接。\n'));
        if (termEmulator) {
          try { termEmulator.clear(); } catch {}
        }
        termOutputCache = '';
        saveTerminalCache();
        focusTerminalInput();
        sendTerminalResize();
        return;
      }
      if (msg.type === 'output' && msg.data) {
        termAppendText(msg.data);
      }
    } catch {
      termAppendText(String(ev.data || ''));
    }
  };

  es.onerror = () => {
    $('term-state').textContent = _t('SSE 断开');
    closeSseTerminal();
    termAppendText(_t('\n[terminal] SSE 连接断开，3秒后重试...\n'));
    setTimeout(() => {
      if (!termSseMode && !termWs && $('page-terminal').classList.contains('active')) {
        startSseTerminal();
      }
    }, 3000);
  };
}

function startTerminalFallback(reason = ''){
  if (termFallbackTimer) return;
  if (termSseMode || termSseSource) return;

  // Try SSE interactive mode first
  termAppendText(_t('\n[terminal] WebSocket 交互连接不可用{0}，尝试 SSE 模式...\n', reason ? ` (${reason})` : ''));
  startSseTerminal();
}

function sendTerminalData(data){
  if (termSseMode || termSseSource) {
    api('/api/terminal/input', { method: 'POST', body: { data } }).catch(() => {});
    return true;
  }
  if (!termWs || termWs.readyState !== WebSocket.OPEN) return false;
  termWs.send(JSON.stringify({ type: 'input', data }));
  return true;
}

function sendTerminalResize(){
  let cols, rows;
  if (termEmulator) {
    if (termFitAddon) termFitAddon.fit();
    cols = Math.max(40, Number(termEmulator.cols) || 80);
    rows = Math.max(12, Number(termEmulator.rows) || 24);
  } else {
    const el = $('terminal');
    if (!el) return;
    cols = Math.max(40, Math.floor(el.clientWidth / 8));
    rows = Math.max(12, Math.floor(el.clientHeight / 18));
  }

  if (termSseMode || termSseSource) {
    api('/api/terminal/resize', { method: 'POST', body: { cols, rows } }).catch(() => {});
    return;
  }
  if (!termWs || termWs.readyState !== WebSocket.OPEN) return;
  termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
}

function bindTerminalInteraction(){
  if (terminalBound) return;
  const terminalEl = $('terminal');
  if (!terminalEl) return;

  const useXterm = initTerminalEmulator();

  terminalEl.addEventListener('click', () => focusTerminalInput());

  // Hook into tab visibility to ensure xterm redraws and fits its container
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      if (m.attributeName === 'class') {
        const isActive = $('page-terminal').classList.contains('active');
        if (isActive && termEmulator && termFitAddon) {
          // Tab just became visible, force a redraw/fit
          setTimeout(() => {
            termFitAddon.fit();
            sendTerminalResize();
            focusTerminalInput();
          }, 50);
          setTimeout(() => termFitAddon.fit(), 300);
        }
      }
    });
  });
  observer.observe($('page-terminal'), { attributes: true });

  window.addEventListener('resize', () => {
    if (termResizeTimer) clearTimeout(termResizeTimer);
    termResizeTimer = setTimeout(() => {
      if (termEmulator && termFitAddon) termFitAddon.fit();
      sendTerminalResize();
    }, 120);
  });

  if (useXterm) {
    terminalBound = true;
    return;
  }

  if (termOutputCache) {
    appendColored(terminalEl, normalizeTerminalChunk(termOutputCache), UI_TERMINAL_MAX_LINES, !!$('term-autoscroll')?.checked);
  }

  terminalEl.addEventListener('keydown', (e) => {
    const canSend = (termWs && termWs.readyState === WebSocket.OPEN) || (termSseMode && termSseSource);
    if (!canSend) {
      if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') {
        e.preventDefault();
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); sendTerminalData('\x03'); return; }
      if (k === 'd') { e.preventDefault(); sendTerminalData('\x04'); return; }
      if (k === 'l') { e.preventDefault(); sendTerminalData('\x0c'); return; }
      if (k === 'u') { e.preventDefault(); sendTerminalData('\x15'); return; }
    }

    switch (e.key) {
      case 'Enter': e.preventDefault(); sendTerminalData('\r'); return;
      case 'Backspace': e.preventDefault(); sendTerminalData('\x7f'); return;
      case 'Tab': e.preventDefault(); sendTerminalData('\t'); return;
      case 'ArrowUp': e.preventDefault(); sendTerminalData('\x1b[A'); return;
      case 'ArrowDown': e.preventDefault(); sendTerminalData('\x1b[B'); return;
      case 'ArrowRight': e.preventDefault(); sendTerminalData('\x1b[C'); return;
      case 'ArrowLeft': e.preventDefault(); sendTerminalData('\x1b[D'); return;
      case 'Escape': e.preventDefault(); sendTerminalData('\x1b'); return;
      default:
        if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
          e.preventDefault();
          sendTerminalData(e.key);
        }
    }
  });

  terminalEl.addEventListener('paste', (e) => {
    const canSend = (termWs && termWs.readyState === WebSocket.OPEN) || (termSseMode && termSseSource);
    if (!canSend) return;
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!text) return;
    e.preventDefault();
    sendTerminalData(text);
  });

  terminalBound = true;
}

async function ensureTerminalWsToken(force = false){
  if (!force && termWsToken) return termWsToken;
  const r = await api('/api/terminal/ws-token');
  if (r && !r.error && r.token) {
    termWsToken = r.token;
    return termWsToken;
  }
  return null;
}

async function terminalConnect(){
  if (!$('page-terminal').classList.contains('active')) return;
  if (termConnectInFlight) return;
  if (termSseMode || termSseSource) return;
  ensureTerminalViewportFitted();
  if (termWs && (termWs.readyState === WebSocket.OPEN || termWs.readyState === WebSocket.CONNECTING)) return;

  termConnectInFlight = true;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const freshToken = await ensureTerminalWsToken(true);
  const wsPrimaryUrl = `${proto}//${location.host}/api/ws/terminal${freshToken ? `?token=${encodeURIComponent(freshToken)}` : ''}`;
  const wsCookieUrl = `${proto}//${location.host}/api/ws/terminal`;

  $('term-state').textContent = _t('连接中...');
  const connectStartedAt = Date.now();
  let retriedWithCookie = false;

  function armConnectTimeout(){
    if (termConnectTimeoutTimer) clearTimeout(termConnectTimeoutTimer);
    termConnectTimeoutTimer = setTimeout(() => {
      if (!$('page-terminal').classList.contains('active')) return;
      if (termWs && termWs.readyState === WebSocket.CONNECTING) {
        try { termWs.close(); } catch {}
      }
      if (!termWs || termWs.readyState !== WebSocket.OPEN) {
        $('term-state').textContent = _t('连接超时，切换日志模式');
        startTerminalFallback(`timeout>${Date.now() - connectStartedAt}ms`);
      }
    }, 10000);
  }

  function clearConnectTimeout(){
    if (!termConnectTimeoutTimer) return;
    clearTimeout(termConnectTimeoutTimer);
    termConnectTimeoutTimer = null;
  }

  function connectWs(url, attemptLabel){
    let socket = null;
    try {
      socket = new WebSocket(url);
      termWs = socket;
    } catch {
      $('term-state').textContent = _t('WebSocket 不可用');
      termAppendText(_t('[terminal] WebSocket 不可用，无法建立交互会话 ({0})\n', attemptLabel));
      termConnectInFlight = false;
      return false;
    }

    armConnectTimeout();

    socket.onopen = ()=> {
      if (socket !== termWs) return;
      clearConnectTimeout();
      termConnectInFlight = false;
      termFailureCount = 0;
      if (termFallbackTimer) {
        clearInterval(termFallbackTimer);
        termFallbackTimer = null;
      }
      try { setActiveRoute('terminal'); } catch {}
      if (getRouteFromHash() !== 'terminal') {
        location.hash = 'terminal';
      }
      $('term-state').textContent = _t('已连接');

      if (!termEmulator && window.Terminal) {
        initTerminalEmulator();
      }

      if (termEmulator) {
        try { termEmulator.clear(); } catch {}
      } else if ($('terminal')) {
        $('terminal').innerHTML = '';
      }
      termOutputCache = '';
      saveTerminalCache();
      focusTerminalInput();
      ensureTerminalViewportFitted();
      sendTerminalResize();
      setTimeout(() => sendTerminalResize(), 200);
      setTimeout(() => sendTerminalResize(), 1200);
      setTimeout(() => sendTerminalResize(), 2600);
      setTimeout(() => sendTerminalResize(), 4200);
    };

    socket.onclose = (ev)=> {
      if (socket !== termWs) return;
      clearConnectTimeout();
      termConnectInFlight = false;
      const code = Number(ev?.code || 0);
      const reason = ev?.reason ? ` reason=${ev.reason}` : '';
      termFailureCount += 1;
      $('term-state').textContent = code === 1008 ? _t('认证失效') : _t('已断开');
      termAppendText(_t('\n[terminal] 连接已断开 (code={0}{1}) [{2}].\n', code, reason, attemptLabel));

      if (code === 1008) {
        termWsToken = null;
        if (!retriedWithCookie) {
          retriedWithCookie = true;
          termAppendText(_t('[terminal] token 鉴权失败，正在尝试 cookie 认证链路...\n'));
          setTimeout(() => connectWs(wsCookieUrl, 'cookie-auth'), 120);
          return;
        }
      }

      if (code === 1006 || termFailureCount >= 2) {
        startTerminalFallback(`code=${code}`);
        termWs = null;
        return;
      }

      termWs = null;
      if ($('page-terminal').classList.contains('active') && !termSseMode) {
        if (termReconnectTimer) clearTimeout(termReconnectTimer);
        termReconnectTimer = setTimeout(() => {
          termReconnectTimer = null;
          terminalConnect();
        }, 1800);
        $('term-state').textContent = _t('重连中...');
      }
    };

    socket.onerror = ()=> {
      if (socket !== termWs) return;
      clearConnectTimeout();
      termConnectInFlight = false;
      termFailureCount += 1;
      $('term-state').textContent = _t('连接错误');
      termAppendText(_t('\n[terminal] 连接错误 [{0}]。\n', attemptLabel));
      if (attemptLabel === 'token-auth') {
        termWsToken = null;
      }
      if (termFailureCount >= 2) {
        startTerminalFallback(_t('网络或Proxy异常'));
      }
    };

    socket.onmessage = (ev)=>{
      if (socket !== termWs) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output') {
          termAppendText(msg.data || '');
        } else if (msg.type === 'info') {
          termAppendText(msg.data || '');
        } else {
          termAppendText(String(ev.data || ''));
        }
      } catch {
        termAppendText(String(ev.data || ''));
      }
    };

    return true;
  }

  connectWs(wsPrimaryUrl, 'token-auth');
  termConnectInFlight = false;
}

$('btn-term-clear').addEventListener('click', ()=>{
  if (termEmulator) {
    termEmulator.clear();
    termOutputCache = '';
    saveTerminalCache();
    return;
  }
  $('terminal').innerHTML='';
  termOutputCache = '';
  saveTerminalCache();
});
loadTerminalCache();
// On page load, detect leftover restart-waiting logs in localStorage; if Gateway recovered, compensate with completion message
(function reconcileStaleRestartLog() {
  const logEl = $('oc-log');
  if (!logEl) return;
  const text = logEl.textContent || '';
  const hasWaiting = text.includes(_t('等待 Gateway 启动完成'));
  const hasResult = text.includes(_t('Gateway 重启成功')) || text.includes(_t('Gateway 重启超时')) || text.includes(_t('停止轮询'));
  if (hasWaiting && !hasResult) {
    api('/api/openclaw', { timeoutMs: 10000 }).then(st => {
      if (st && !st.error && st.gatewayRunning) {
        appendOcLogLine(_t('✅ Gateway 已恢复运行（页面Refresh后检测）'));
      } else if (st && !st.error && !st.gatewayRunning) {
        appendOcLogLine(_t('⚠️ Gateway 当前未运行，请Check state'));
      }
    }).catch(() => {});
  }
})();
bindTerminalInteraction();

// ------------------------
// Logs (poll)
// ------------------------
let logsTimer = null;
async function refreshLogs(){
  const mode = String($('logs-view-mode')?.value || 'timeline');
  const d = await api(`/api/logs?lines=${UI_LOG_VIEW_FETCH_LINES}&view=${encodeURIComponent(mode)}&fold=1`);
  if (d.error) return;
  setColored($('log-viewer'), d.logs || '', UI_LOG_VIEW_RENDER_MAX_LINES, true);
  $('log-viewer').scrollTop = $('log-viewer').scrollHeight;
}

$('btn-logs-refresh').addEventListener('click', refreshLogs);
$('logs-view-mode')?.addEventListener('change', refreshLogs);
$('logs-auto').addEventListener('change', ()=>{
  if ($('logs-auto').checked){
    refreshLogs();
    logsTimer = setInterval(refreshLogs, 5000);
  }else{
    if (logsTimer) clearInterval(logsTimer);
    logsTimer = null;
  }
});

// ------------------------
// Settings — password
// ------------------------
$('btn-password').addEventListener('click', async ()=>{
  const oldPassword = $('old-password').value;
  const newPassword = $('new-password').value;
  const confirm = $('confirm-password').value;

  if (!oldPassword) return toast(_t('缺少参数'), _t('请输入当前密码'));
  if (!newPassword || newPassword.length < 8) return toast(_t('参数错误'), _t('新密码至少 8 位'));
  if (newPassword !== confirm) return toast(_t('参数错误'), _t('两次密码不一致'));

  const r = await api('/api/password', { method:'POST', body:{ oldPassword, newPassword } });
  if (r.success){
    toast(_t('密码已修改'), _t('请重新登录'));
    setTimeout(()=> location.href='/login.html', 800);
  }else{
    toast(_t('修改失败'), r.error || '');
  }
});

// ------------------------
// Logout
// ------------------------
$('btn-logout').addEventListener('click', async ()=>{
  try{ await api('/api/logout', { method:'POST' }); }
  finally{ location.href = '/login.html'; }
});

// ------------------------
// Init
// ------------------------
{
  const _initRoute = getRouteFromHash();
  setActiveRoute(_initRoute);
  // setActiveRoute calls refreshStatus for dashboard; for other routes, do it once
  if (_initRoute !== 'dashboard') refreshStatus();
}
setInterval(refreshStatus, 30000);
setInterval(() => {
  const route = getRouteFromHash();
  if (route === 'openclaw-engine') refreshOpenClaw({ retries: 0 });
}, 3000);

// Auto check for updates on page load (non-blocking)
setTimeout(() => checkForUpdate(), 3000);
// Deferred background OpenClaw status (only if not already loaded by route hook)
if (getRouteFromHash() !== 'openclaw-engine') {
  setTimeout(() => refreshOpenClaw({ retries: 1 }), 4000);
}

// Periodic update check every 30 minutes
setInterval(() => checkForUpdate(), 30 * 60 * 1000);
setInterval(() => {
  const route = getRouteFromHash();
  if (route !== 'openclaw-engine') refreshOpenClaw({ retries: 0 });
}, 5 * 60 * 1000);

// i18n: re-render dynamic content when locale changes without full reload
window._i18nRefresh = function() {
  refreshStatus();
  refreshOpenClaw({ retries: 0 });
  syncOpenClawButtons();
};

// ------------------------
// Session inactivity timeout
// ------------------------
(() => {
  const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
  let _inactivityTimer = null;

  function resetInactivityTimer() {
    if (_inactivityTimer) clearTimeout(_inactivityTimer);
    _inactivityTimer = setTimeout(async () => {
      try { await api('/api/logout', { method: 'POST' }); } catch {}
      location.href = '/login.html';
    }, INACTIVITY_MS);
  }

  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, resetInactivityTimer, { passive: true });
  });
  resetInactivityTimer();
})();

// ===================== APP CENTER =====================
// App catalog: available apps
const APP_CATALOG = [
  {
    id: 'jiangsu-physics',
    name: '江苏高考物理知识网站',
    icon: '⚛️',
    description: '涵盖高中全部物理知识的交互式学习平台，支持知识图谱、交互动画、AI智能出题和成绩追踪',
    version: '2.0.0',
    features: ['知识图谱', '交互动画', 'AI高考卷', '成绩追踪', '学习档案'],
    category: 'education',
    repo: 'https://github.com/cintia09/jiangsu-physics-knowledge',
    port: 8080,
    entryPath: '/apps/physics/',
    displayName: '江苏高考物理知识网站'
  }
];

// Operation log
let _appCenterLogs = [];
function appLog(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', {hour12:false});
  _appCenterLogs.push('[' + ts + '] ' + msg);
  if (_appCenterLogs.length > 100) _appCenterLogs = _appCenterLogs.slice(-50);
  const logEl = $('app-center-log-content');
  if (logEl) { logEl.textContent = _appCenterLogs.join('\n'); logEl.scrollTop = logEl.scrollHeight; }
}

async function refreshAppCenter() {
  const installedContainer = $('app-center-installed');
  const catalogContainer = $('app-center-catalog');
  if (!installedContainer || !catalogContainer) return;
  installedContainer.innerHTML = '<div style="grid-column:span 12;text-align:center;padding:20px;color:var(--dim)">扫描中...</div>';
  appLog('正在扫描已安装的应用...');
  let installedApps = [];
  try {
    const data = await api('/api/app-center/list');
    installedApps = data.apps || [];
    appLog('扫描完成，发现 ' + installedApps.length + ' 个已安装应用');
  } catch(e) { appLog('⚠ 扫描失败: ' + e.message); }
  const installedIds = new Set(installedApps.map(a => a.name));
  // Installed apps
  if (!installedApps.length) {
    installedContainer.innerHTML = '<div style="grid-column:span 12;text-align:center;padding:24px;color:var(--dim)"><div style="font-size:32px;margin-bottom:6px">📭</div><p style="font-size:13px">' + _t('还没有安装任何应用') + '</p><p class="dim" style="font-size:11px;margin-top:4px">👇 从下方应用商店安装</p></div>';
  } else {
    installedContainer.innerHTML = installedApps.map(function(app) {
      var sc = app.status === 'running' ? '#22c55e' : app.status === 'stopped' ? '#ef4444' : '#f59e0b';
      var st = app.status === 'running' ? _t('运行中') : app.status === 'stopped' ? _t('已停止') : _t('未知');
      var feats = (app.features || []).map(function(f){ return '<span style="display:inline-block;padding:1px 6px;background:rgba(99,102,241,.1);color:#6366f1;border-radius:4px;font-size:10px;margin:1px">'+f+'</span>'; }).join('');
      var openBtn = app.status === 'running' ? '<button class="btn btn-primary" style="font-size:11px;padding:3px 12px" onclick="window.open(\''+app.entryPath+'\',\'_blank\')">'+_t('打开')+'</button>' : '';
      return '<div class="card" style="grid-column:span 6;transition:transform .15s" onmouseenter="this.style.transform=\'translateY(-2px)\'" onmouseleave="this.style.transform=\'\'"><div style="display:flex;align-items:flex-start;gap:12px"><div style="font-size:36px;line-height:1">'+(app.icon||'📦')+'</div><div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap"><strong style="font-size:14px">'+(app.displayName||app.name)+'</strong><span style="display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:600;background:'+sc+'20;color:'+sc+'"><span style="width:6px;height:6px;border-radius:50%;background:'+sc+'"></span>'+st+'</span><span class="dim" style="font-size:10px">v'+(app.version||'?')+'</span></div><p class="dim" style="font-size:12px;margin:0 0 6px">'+(app.description||'')+'</p><div style="margin-bottom:8px">'+feats+'</div><div style="display:flex;align-items:center;gap:8px">'+openBtn+'<button class="btn" style="font-size:11px;padding:3px 12px;color:#ef4444;border-color:#ef4444" onclick="uninstallApp(\''+app.name+'\')">'+_t('卸载')+'</button></div></div></div></div>';
    }).join('');
  }
  // Catalog
  catalogContainer.innerHTML = APP_CATALOG.map(function(app) {
    var isInstalled = installedIds.has(app.id) || installedIds.has(app.name) || installedApps.some(function(a){ return a.displayName === app.name; });
    var isRunning = installedApps.some(function(a){ return (a.name === app.id || a.displayName === app.name) && a.status === 'running'; });
    var actionHtml;
    if (isInstalled) {
      actionHtml = '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;background:rgba(34,197,94,.1);color:#22c55e">✓ '+_t('已安装')+'</span>';
      if (isRunning) actionHtml += ' <button class="btn btn-primary" style="font-size:11px;padding:3px 12px;margin-left:4px" onclick="event.stopPropagation();window.open(\''+app.entryPath+'\',\'_blank\')">'+_t('打开')+'</button>';
    } else {
      actionHtml = '<button class="btn btn-primary" id="install-btn-'+app.id+'" style="font-size:11px;padding:3px 14px" onclick="event.stopPropagation();installApp(\''+app.id+'\')">'+_t('安装')+'</button>';
    }
    var feats = (app.features || []).map(function(f){ return '<span style="display:inline-block;padding:1px 6px;background:rgba(99,102,241,.1);color:#6366f1;border-radius:4px;font-size:10px;margin:1px">'+f+'</span>'; }).join('');
    return '<div class="card" style="grid-column:span 6;transition:transform .15s" onmouseenter="this.style.transform=\'translateY(-2px)\'" onmouseleave="this.style.transform=\'\'"><div style="display:flex;align-items:flex-start;gap:12px"><div style="font-size:36px;line-height:1">'+app.icon+'</div><div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><strong style="font-size:14px">'+app.name+'</strong><span class="dim" style="font-size:10px">v'+app.version+'</span></div><p class="dim" style="font-size:12px;margin:0 0 6px">'+app.description+'</p><div style="margin-bottom:8px">'+feats+'</div><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'+actionHtml+(app.repo ? '<a href="'+app.repo+'" target="_blank" rel="noopener" style="font-size:11px;color:var(--dim)" onclick="event.stopPropagation()">GitHub →</a>' : '')+'</div></div></div></div>';
  }).join('');
}

async function installApp(appId) {
  var app = APP_CATALOG.find(function(a){ return a.id === appId; });
  if (!app) return;
  var btn = $('install-btn-' + appId);
  if (btn) { btn.disabled = true; btn.textContent = _t('安装中...'); btn.style.opacity = '0.6'; }
  appLog('开始安装: ' + app.name + ' (' + appId + ')');
  try {
    var resp = await api('/api/app-center/install', {
      method: 'POST',
      body: JSON.stringify({ id: appId, name: appId, displayName: app.name, description: app.description, icon: app.icon, version: app.version, features: app.features, repo: app.repo, port: app.port, entryPath: app.entryPath, category: app.category })
    });
    if (resp.error) throw new Error(resp.error);
    appLog('✅ 应用 ' + app.name + ' 注册成功');
    appLog('应用目录: ~/.openclaw/apps/' + appId + '/');
    await refreshAppCenter();
  } catch(e) {
    appLog('❌ 安装失败: ' + e.message);
    if (btn) { btn.textContent = _t('安装'); btn.disabled = false; btn.style.opacity = ''; }
  }
}

async function uninstallApp(appId) {
  if (!confirm('确定卸载 ' + appId + '？\n\n注意：这只会移除应用注册，不会删除应用数据。')) return;
  appLog('正在卸载: ' + appId);
  try {
    var resp = await api('/api/app-center/uninstall', { method: 'POST', body: JSON.stringify({ id: appId }) });
    if (resp.error) throw new Error(resp.error);
    appLog('✅ 已卸载: ' + appId);
    refreshAppCenter();
  } catch(e) { appLog('❌ 卸载失败: ' + e.message); }
}

