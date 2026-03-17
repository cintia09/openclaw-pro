/* ============================================================
   app.js — OpenClaw Web Panel (no framework)
   - Hash routing, sidebar UX, fade transitions
   - Plugins market + Terminal (WebSocket logs)
   - Keep all existing functionality
   ============================================================ */

function $(id){ return document.getElementById(id); }
function q(sel, root=document){ return root.querySelector(sel); }
function qa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

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
// 使用 Set 存储已经显示过的日志标识（connId + state）
const shownWsLogIds = new Set();
let lastWsLogState = null; // 最后显示的状态

function getWsLogId(line) {
  // 提取 connId 和状态作为唯一标识
  const match = line.match(/\[ws\]\s+webchat\s+(connected|disconnected)\s+conn=([a-f0-9-]+)/i);
  if (!match) return null;
  return `${match[2]}:${match[1].toLowerCase()}`; // connId:state
}

function parseWsLogLine(line) {
  // 匹配 [gateway-runtime] [2026-03-07 16:32:01] [ws] webchat connected conn=xxx remote=...
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
        : (rawText ? compactOutputForUi(rawText) : `请求失败（HTTP ${res.status}）`);
      return { error: detail, status: res.status };
    }
    if (data && typeof data === 'object') return data;
    return { error: rawText ? `响应不是有效 JSON：${compactOutputForUi(rawText)}` : '响应为空（后端未返回 JSON）' };
  }catch(e){
    console.error('api error', e);
    const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt;
    if (e && e.name === 'AbortError') return { error: `请求超时（>${timeoutMs}ms）` };
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
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function stripOsc(text){
  return String(text ?? '').replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '');
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
    return '开发版（dev）';
  }
  if (lower === 'unknown' || /^v?0\.0\.0(?:[-+].*)?$/i.test(v)) {
    return '未标注版本';
  }
  return v;
}

function formatInstallSourceLabel(rawSource){
  const s = String(rawSource || '').trim().toLowerCase();
  if (s === 'source') return '源码安装';
  if (s === 'npm') return 'npm 安装';
  if (s === 'binary') return '二进制安装';
  if (s === 'version') return '版本探测';
  if (s === 'none') return '未安装';
  return '已安装';
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
    // WebSocket 连接/断开高亮
    .replace(/\b(connected)\b/gi, '<span class="term-state-success">$1</span>')
    .replace(/\b(disconnected)\b/gi, '<span class="term-state-failed">$1</span>')
    .replace(/\b(conn=[a-f0-9-]+)\b/gi, '<span class="term-conn-id">$1</span>')
    .replace(/\b(code=\d+)\b/gi, '<span class="term-code">$1</span>')
    .replace(/\b(reason=\w+)\b/gi, '<span class="term-reason">$1</span>')
    // 合并计数和持续时间
    .replace(/(\(×\d+\))/g, '<span class="term-count">$1</span>')
    .replace(/(\[持续 [^\]]+\])/g, '<span class="term-duration">$1</span>');

  if (/^\s*\[[^\]]+\]\s*$/.test(line.trim())) {
    out = `<span class="term-section-line">${out}</span>`;
  }
  return out;
}

function colorizeLine(rawLine){
  const line = stripAnsi(String(rawLine ?? ''));

  // 处理 WebSocket 跳过提示行
  if (/^\s*\.\.\.\s*跳过/.test(line)) {
    return `<span class="term-line"><span class="term-skip-hint">${escapeHtml(line)}</span></span>`;
  }

  const dateLike = /^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
  let safe = highlightLogKeywords(line, escapeHtml(line));

  if (/^\s*(\$|#)\s+/.test(line)) {
    safe = `<span class="term-cmd">${safe}</span>`;
  } else if (/\b(ERROR|Error|ERR|failed|失败|异常|fatal)\b/.test(line)) {
    safe = `<span class="term-error">${safe}</span>`;
  } else if (/\b(WARN|Warning|timeout|超时|占用|冲突)\b/i.test(line)) {
    safe = `<span class="term-warn">${safe}</span>`;
  } else if (/\b(INFO|started|listening|完成|成功|已启动)\b/i.test(line)) {
    // 排除 connected/disconnected，因为它们在 highlightLogKeywords 中有专门处理
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

  // 处理每一行，支持 WebSocket 连接日志去重（基于唯一标识）
  const processedLines = [];
  let skippedCount = 0;

  for (const line of renderLines) {
    const wsLogId = getWsLogId(line);

    if (!wsLogId) {
      // 非 WebSocket 日志，直接处理
      processedLines.push(line);
      continue;
    }

    // 检查这条日志是否已经显示过
    if (shownWsLogIds.has(wsLogId)) {
      // 已经显示过，跳过
      skippedCount++;
      continue;
    }

    // 新的日志，标记为已显示
    shownWsLogIds.add(wsLogId);

    // 检查状态
    const wsInfo = parseWsLogLine(line);
    const state = wsInfo ? wsInfo.state : null;

    // 如果有跳过的日志，添加提示
    if (skippedCount > 0) {
      const skipHint = `    ... 跳过 ${skippedCount} 条重复/已显示的日志`;
      processedLines.push(skipHint);
      skippedCount = 0;
    }

    // 添加这条日志
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
  // 注意：不在此处重置 shownWsLogIds，以支持跨刷新周期的去重
  appendColored(el, text, maxLines, autoscroll);
}

function toast(title, detail=''){
  const old = q('.toast');
  if (old) old.remove();

  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `
    <div class="t"><b>${escapeHtml(title)}</b></div>
    <div class="s">${escapeHtml(detail)}</div>
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
  { id: 'dashboard', title: '仪表盘' },
  { id: 'openclaw-engine', title: 'OpenClaw 控制台' },
  { id: 'openclaw-ai', title: '接入模型配置' },
  { id: 'messaging', title: '消息平台' },
  { id: 'browser', title: '远端设备管理' },
  { id: 'plugins', title: '插件市场' },
  { id: 'terminal', title: '终端' },
  { id: 'settings', title: '系统设置' },
  { id: 'logs', title: '日志' },
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
  if (route === 'terminal') {
    bindTerminalInteraction();
    terminalConnect();
    ensureTerminalViewportFitted();
    setTimeout(() => ensureTerminalViewportFitted(), 120);
    setTimeout(() => ensureTerminalViewportFitted(), 600);
    focusTerminalInput();
  }
  if (route === 'settings') { renderDetectedTimezone(); checkForUpdate(); }
  if (route === 'logs') {
    // 重置 WebSocket 日志去重状态
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
  el.textContent = `${timezone}（自动探测）`;
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
    btn.title = nextHidden ? '显示侧边栏' : '隐藏侧边栏';
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
      toast('Gateway 未就绪', r?.hint || 'Gateway 正在启动中，请稍候后再试');
      return;
    }
    const target = r?.preferredUrl || r?.directUrl || r?.proxyUrl || '/gateway-proxy/';
    const popup = window.open(target, '_blank');
    if (!popup) {
      window.location.href = target;
      toast('弹窗被拦截', '已在当前页面打开 Gateway 控制台');
    }
    if (r?.hint) {
      toast('Gateway 提示', r.hint);
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
  if (d>0) return `${d}天 ${h}小时`;
  if (h>0) return `${h}小时 ${m}分钟`;
  return `${m}分钟`;
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
      ? `<span class="pulse online"></span>在线`
      : (openclawMissing
          ? `<span class="pulse offline"></span>离线`
          : (gatewayPairing
              ? `<span class="pulse offline"></span>待配对`
              : (gatewayPending
                  ? `<span class="pulse pending"></span>启动中`
                  : `<span class="pulse offline"></span>离线`)));
  }
  const gatewayParts = [
    s.gateway
      ? '健康检查正常'
      : (openclawMissing
          ? 'OpenClaw 已卸载'
          : (gatewayPairing
              ? '等待控制台配对'
              : (gatewayPending
                  ? '进程已拉起，等待健康检查'
                  : '未检测到运行中的 Gateway')))
  ];
  if (!openclawMissing && !s.gateway && s.gatewayProcessRunning && Number(s.gatewayProcessUptimeSec || 0) > 0) {
    gatewayParts.push(`运行 ${formatUptime(s.gatewayProcessUptimeSec)}`);
  }
  if (s.gatewayWatchdog === false) {
    gatewayParts.push('watchdog未运行');
  }
  if (s.terminal) {
    if (s.terminal.ready) {
      const mode = s.terminal.mode || 'unknown';
      if (mode === 'pty') {
        gatewayParts.push('终端: 正常(PTY)');
      } else if (mode === 'fallback') {
        gatewayParts.push('终端: 正常(兼容模式)');
      } else {
        gatewayParts.push(`终端: 正常(${mode})`);
      }
    } else {
      const reasonText = s.terminal.reason || '终端后端未就绪';
      gatewayParts.push(`终端: ${reasonText}`);
    }
  } else {
    gatewayParts.push('终端: 状态未知');
  }
  const terminalStatus = $('kpi-terminal-status');
  const terminalDetail = $('kpi-terminal-detail');
  if (terminalStatus && terminalDetail) {
    if (s.terminal?.ready) {
      const mode = s.terminal.mode || 'unknown';
      terminalStatus.innerHTML = '<span class="pulse online"></span>终端就绪';
      terminalDetail.textContent = mode === 'pty' ? '交互模式：PTY' : `交互模式：${mode}`;
    } else {
      terminalStatus.innerHTML = '<span class="pulse offline"></span>终端异常';
      terminalDetail.textContent = s.terminal?.reason || '终端后端未就绪';
    }
  }
  if ($('kpi-gateway-sub')) $('kpi-gateway-sub').textContent = gatewayParts.join(' · ');

  if ($('kpi-caddy')) {
    $('kpi-caddy').innerHTML = s.caddy
      ? `<span class="pulse online"></span>在线`
      : `<span class="pulse offline"></span>离线/未启用`;
  }
  if ($('kpi-domain')) $('kpi-domain').textContent = s.domain ? `域名：${s.domain}` : '未配置域名';

  if ($('kpi-memory')) $('kpi-memory').textContent = s.memory?.total ? `${s.memory.used}/${s.memory.total}MB (${s.memory.percent}%)` : '—';
  if ($('kpi-uptime')) $('kpi-uptime').textContent = s.uptime ? `运行：${formatUptime(s.uptime)}` : '—';

  // Update sidebar footer
  const panelVer = formatVersionLabel(s.version) || '-';
  const ocVer = formatVersionLabel(s.openclawVersion) || '-';
  if ($('sidebar-version')) $('sidebar-version').textContent = `面板 ${panelVer}`;
  if ($('sidebar-oc-version')) $('sidebar-oc-version').textContent = `OpenClaw ${ocVer}`;
  const statusEl = $('sidebar-status');
  if (statusEl) {
    const online = !!s.gateway;
    const cls = online ? 'online' : 'offline';
    statusEl.innerHTML = `Gateway <span class="gw-label ${cls}">${online ? 'ONLINE' : 'OFFLINE'}</span>`;
  }

  // 远端设备管理 tab 始终可见
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
    if (tEl) tEl.innerHTML = '\uD83C\uDD95 \u53D1\u73B0\u65B0\u7248\u672C\uFF1A<span id="update-latest">' + escapeHtml(u.latestVersion || '') + '</span>';
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
        fullHint.innerHTML = '\uD83D\uDCE6 <b>\u9700\u8981\u5B8C\u6574\u66F4\u65B0</b>\uFF1A\u8BF7\u91CD\u65B0\u6267\u884C\u4E00\u952E\u5B89\u88C5\u811A\u672C';
      }
      if (installNote) installNote.style.display = '';
    } else {
      if (hotBtn) {
        hotBtn.style.display = '';
        hotBtn.textContent = '\u26A1 \u70ED\u66F4\u65B0';
        hotBtn.onclick = () => doHotPatch(false);
      }
      if (fullHint) {
        fullHint.style.display = '';
        fullHint.style.color = '#30d158';
        fullHint.innerHTML = '\u26A1 <b>\u53EF\u70ED\u66F4\u65B0</b>\uFF1A\u70B9\u51FB\u201C\u70ED\u66F4\u65B0\u201D\u5373\u53EF\uFF0C\u65E0\u9700\u91CD\u88C5\u5BB9\u5668<br><span class="muted" style="font-size:11px">\u2139 \u70ED\u66F4\u65B0\u4EC5\u5E94\u7528\u5BB9\u5668\u5185\u6587\u4EF6\uFF0C\u5B89\u88C5\u811A\u672C\u7B49\u5BBF\u4E3B\u673A\u6587\u4EF6\u9700\u91CD\u65B0\u4E0B\u8F7D</span>';
      }
      if (installNote) installNote.style.display = 'none';
    }
  } else if (banner && !u.hasUpdate && u.latestVersion) {
    // No new version: offer force hotpatch
    const tEl = $('update-banner-title');
    if (tEl) tEl.innerHTML = '\u2705 \u5F53\u524D\u5DF2\u662F\u6700\u65B0\u7248\u672C <span class="muted small">(' + escapeHtml(formatVersionLabel(u.currentVersion)) + ')</span>';
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
      hotBtn.textContent = '\u26A1 \u5F3A\u5236\u70ED\u66F4\u65B0';
      hotBtn.onclick = () => doHotPatch(true);
    }
    if (fullHint) {
      fullHint.style.display = '';
      fullHint.style.color = '#8e8e93';
      fullHint.innerHTML = '\u7248\u672C\u53F7\u76F8\u540C\uFF0C\u53EF\u5F3A\u5236\u540C\u6B65\u8FDC\u7A0B\u6587\u4EF6';
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
        statusEl.innerHTML = '<span style="color:#ff9f0a">📦 需要完整更新</span>';
      } else {
        statusEl.innerHTML = '<span style="color:#30d158">⚡ 可热更新</span> <span class="muted" style="font-size:11px">(仅容器内文件)</span>';
      }
      if (linkEl && u.releaseUrl) { linkEl.href = u.releaseUrl; linkEl.style.display = ''; }
      // Show/hide hot update & full update hints on settings page
      const hpBtn = $('btn-hotpatch');
      const fullNote = $('settings-full-update-note');
      if (hpBtn) {
        hpBtn.style.display = u.requiresFullUpdate ? 'none' : '';
        if (!u.requiresFullUpdate) {
          hpBtn.textContent = '⚡ 热更新（不重启容器）';
          hpBtn.onclick = () => doHotPatch(false);
        }
      }
      if (fullNote) fullNote.style.display = u.requiresFullUpdate ? '' : 'none';
    } else if (u.latestVersion) {
      if (u.currentVersion === u.latestVersion) {
        // Same version: show force hotpatch button
        statusEl.innerHTML = '<span style="color:#f5f5f7">✅ 已是最新 (' + formatVersionLabel(u.currentVersion) + ')</span>';
        if (linkEl) linkEl.style.display = 'none';
        // Show force hot update button when version is same
        const hpBtn = $('btn-hotpatch');
        const fullNote = $('settings-full-update-note');
        if (hpBtn) {
          hpBtn.style.display = '';
          hpBtn.textContent = '⚡ 强制热更新';
          hpBtn.onclick = () => doHotPatch(true);
        }
        if (fullNote) {
          fullNote.style.display = '';
          fullNote.innerHTML = '<span style="color:#30d158">版本号相同，点击强制热更新可重新同步远程文件</span>';
        }
      } else {
        // No update available (local version newer)
        statusEl.innerHTML = '<span style="color:#f5f5f7">✅ 已是最新</span>';
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
        errMsg = '⚠️ 无法连接 GitHub（网络不可达）';
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
  btn.textContent = '刷新中...';
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
    toast('已触发重启', r.message || 'Gateway 正在重启，请稍候');
  } else {
    toast('重启失败', r.error || '请查看日志');
  }
  setTimeout(refreshStatus, 2500);
});

if ($('btn-check-update')) {
  $('btn-check-update').addEventListener('click', async () => {
    $('btn-check-update').disabled = true;
    $('btn-check-update').textContent = '检查中...';
    await checkForUpdate(true);
    $('btn-check-update').disabled = false;
    $('btn-check-update').textContent = '检查更新';
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
    toast('请稍候', '后端重启中，恢复后可再次热更新');
    return;
  }

  setHotpatchButtons(true, force ? '⏳ 强制更新中...' : '⏳ 更新中...');

  const logBox = $('hotpatch-log');
  const logPre = logBox ? logBox.querySelector('pre') : null;
  if (logBox) { logBox.style.display = ''; }
  if (logPre) logPre.textContent = force ? '正在强制拉取最新文件...\n' : '正在拉取最新文件...\n';

  try {
    const r = await api('/api/update/hotpatch', { method: 'POST', body: { branch: 'main', force } });
    if (r.error) {
      toast(force ? '强制热更新失败' : '热更新失败', r.error);
      setHotpatchButtons(false, force ? '⚡ 强制热更新' : '⚡ 热更新（不重启容器）');
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
              toast('热更新完成', 'Web 面板将自动重启，约 5-15 秒可恢复');
              if (logPre) logPre.textContent += '\n检测到 web/server.js 更新：Web 面板将自动重启，请等待 5-15 秒后重连。';
            } else {
              toast('热更新完成', `${updated.length} 个文件已更新`);
            }

            if (hasStartServices && logPre) {
              logPre.textContent += '\n检测到 start-services.sh 更新：请在宿主机执行 `docker restart openclaw-pro` 以使入口脚本变更生效。';
              logPre.textContent += '\n若容器名不确定：先执行 `docker ps --format "{{.Names}}"`，再执行 `docker restart <容器名>`。';
              toast('请重启容器', '执行: docker restart openclaw-pro');
            }

            if (hasFrontend || hasWebServer || updated.length === 0) {
              if (logPre) {
                logPre.textContent += hasWebServer
                  ? '\n检测到后端已更新，正在等待服务恢复后自动重查更新状态（不再强制刷新页面）。'
                  : updated.length === 0
                  ? '\n所有文件已是最新，正在刷新版本状态...'
                  : '\n前端文件已更新，将自动重查更新状态；如需立即加载新前端可手动刷新页面。';
              }

              if (hasWebServer) {
                hotpatchRestartPending = true;
                setHotpatchButtons(true, '⏳ 后端重启中...');
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
                        toast('热更新完成', 'Web 面板已恢复，已自动刷新更新状态');
                        hotpatchRestartPending = false;
                        setHotpatchButtons(false, '⚡ 热更新（不重启容器）');
                      }
                      return;
                    }
                  } catch {
                    // server may still be restarting
                  }
                }
                await checkForUpdate(true);
                if (hasWebServer) {
                  toast('提示', 'Web 面板重启中，如状态未更新请稍后手动刷新页面');
                  hotpatchRestartPending = false;
                  setHotpatchButtons(false, '⚡ 热更新（不重启容器）');
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
            toast('热更新失败', s.log || '');
          }
          break;
        }
      } catch { /* server might be restarting */ }
    }
    if (!done) toast('热更新超时', '请稍后检查状态');
  } catch (e) {
    toast('热更新失败', e.message);
  } finally {
    if (!hotpatchRestartPending) {
      setHotpatchButtons(false, '⚡ 热更新（不重启容器）');
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
let ocStatusBaseText = '更新状态：自动检查中';
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
      installBtn.textContent = '检测中...';
      installBtn.disabled = true;
    } else if (installBusy && installPhase === 'install') {
      installBtn.textContent = '安装中...';
      installBtn.disabled = true;
    } else if (installBusy && installPhase === 'update') {
      installBtn.textContent = '更新中...';
      installBtn.disabled = true;
    } else if (installBusy && installPhase === 'uninstall') {
      installBtn.textContent = ocInstalled ? '更新' : '安装';
      installBtn.disabled = true;
    } else {
      installBtn.textContent = ocInstalled ? (noUpdateNeeded ? '已是最新' : '更新') : '安装';
      installBtn.disabled = !!repairBusy || (restartBusy && ocInstalled) || noUpdateNeeded;
    }
  }

  if (uninstallBtn) {
    uninstallBtn.textContent = statusDetecting ? '检测中...' : (installBusy && installPhase === 'uninstall' ? '卸载中...' : '卸载');
    uninstallBtn.disabled = statusDetecting || !ocInstalled || !!installBusy || !!repairBusy || !!restartBusy;
  }

  if (repairBtn) {
    repairBtn.textContent = statusDetecting ? '检测中...' : (repairBusy ? '修复中...' : '配置恢复');
    repairBtn.disabled = statusDetecting || !!installBusy || !!repairBusy || !!restartBusy;
  }

  if (startBtn) {
    startBtn.textContent = statusDetecting ? '检测中...' : (restartBusy ? '启动中...' : '重启 Gateway');
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
  let text = ocStatusBaseText || '更新状态：自动检查中';
  const p = ocStatusProgress;
  if (p && p.active && Number(p.totalSec || 0) > 0 && Number(p.startedAt || 0) > 0) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Number(p.startedAt || 0)) / 1000));
    const remain = Math.max(0, Number(p.totalSec || 0) - elapsed);
    text += `（已耗时 ${formatRemainingTime(elapsed)} / 预计剩余 ${formatRemainingTime(remain)}）`;
  } else if (p && p.active && Number(p.startedAt || 0) > 0) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Number(p.startedAt || 0)) / 1000));
    text += `（已耗时 ${formatRemainingTime(elapsed)}）`;
  }
  el.textContent = text;
}

function setOpenClawStatusLine(baseText, progress){
  ocStatusBaseText = String(baseText || '更新状态：自动检查中');
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
  // 启动日志不再显示在操作日志面板，仅更新内部 snapshot 跟踪状态
  try {
    const r = await api(`/api/openclaw/gateway/logs?lines=${Math.max(20, Math.min(lines, 1200))}`, { timeoutMs: 12000 });
    const snapshot = String(r?.logs || '').trim();
    if (r?.success && snapshot) {
      ocLastGatewaySnapshot = snapshot;
    }
  } catch (e) {
    // 静默失败，不刷日志
  }
}

function stopGatewayStartupLogPulls(){
  if (ocGatewayLogPollTimer) clearInterval(ocGatewayLogPollTimer);
  ocGatewayLogPollTimer = null;
  ocGatewayLogPollRunning = false;
}

function applyGatewayRestartingUi(){
  setStatusBadge('oc-gateway', 'pending', '启动中', true);
  setOpenClawStatusLine('更新状态：Gateway 启动中', { active: true, startedAt: Date.now(), totalSec: 60 });
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
    setStatusBadge('oc-installed', 'pending', '检测中', true);
    setStatusBadge('oc-gateway', 'pending', '检测中', true);
    setOpenClawStatusLine('更新状态：正在检测 OpenClaw 状态', null);
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
    lastErr = d?.error || '接口返回异常';
    if (i < retries) {
      await new Promise((resolve) => setTimeout(resolve, 350 * (i + 1)));
    }
  }

  if (!d || d.error || !Object.prototype.hasOwnProperty.call(d, 'installed')) {
    const detail = lastErr || '状态读取失败';
    setOpenClawStatusLine(`更新状态：读取失败（${detail}）`, null);
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
    setStatusBadge('oc-installed', 'pending', '安装中', true);
  } else if (installBusyNow && installPhaseNow === 'update') {
    setStatusBadge('oc-installed', 'pending', '更新中', true);
  } else if (installBusyNow && installPhaseNow === 'uninstall') {
    setStatusBadge('oc-installed', 'pending', '卸载中', true);
  } else {
    setStatusBadge('oc-installed', d.installed ? 'online' : 'offline', d.installed ? '已安装' : '未安装', false);
  }
  if (d.installed) {
    const versionLabel = formatVersionLabel(d.version);
    if (d.version && d.latestVersion && d.hasUpdate) {
      $('oc-version').textContent = `版本：${versionLabel}（可更新到 ${d.latestVersion}）`;
    } else if (d.version) {
      $('oc-version').textContent = `版本：${versionLabel}`;
    } else {
      $('oc-version').textContent = `版本：待识别（${formatInstallSourceLabel(d.installSource)}）`;
    }
  } else {
    $('oc-version').textContent = '—';
  }
  if (!d.installed && !d.gatewayRunning && !restartBusyNow) {
    setStatusBadge('oc-gateway', 'offline', '未安装', false);
  } else if (restartBusyNow) {
    setStatusBadge('oc-gateway', 'pending', '启动中', true);
  } else if (!d.gatewayRunning && d.gatewayStarting) {
    setStatusBadge('oc-gateway', 'pending', '启动中（初始化中）', true);
  } else if (!d.gatewayRunning && postInstallWarmup && d.gatewayProcessRunning) {
    setStatusBadge('oc-gateway', 'pending', '启动中', true);
  } else if (!d.gatewayRunning && d.gatewayPairingRequired) {
    setStatusBadge('oc-gateway', 'offline', '待配对（控制台鉴权）', false);
  } else if (!d.gatewayRunning && d.gatewayProcessRunning) {
    setStatusBadge('oc-gateway', 'pending', '启动中（初始化中）', true);
  } else {
    setStatusBadge('oc-gateway', d.gatewayRunning ? 'online' : 'offline', d.gatewayRunning ? '运行中' : '未启动', false);
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
    if (installBusyNow && installPhaseNow === 'install') actionBtn.textContent = '安装中...';
    else if (installBusyNow && installPhaseNow === 'update') actionBtn.textContent = '更新中...';
    else if (d.installed && !d.hasUpdate) actionBtn.textContent = '已是最新';
    else actionBtn.textContent = d.installed ? '更新' : '安装';
  }

  if ($('oc-current-ver')) {
    const currentVer = formatVersionLabel(d.version) || '—';
    $('oc-current-ver').textContent = currentVer;
  }
  if ($('oc-latest-ver')) {
    if (displayLatestVersion) {
      $('oc-latest-ver').textContent = displayLatestVersion;
    } else if (d.updateCheckError) {
      $('oc-latest-ver').textContent = `检测失败（${d.updateCheckError}）`;
    } else {
      $('oc-latest-ver').textContent = '检测中';
    }
  }
  const invalidKeys = Array.isArray(d.invalidConfigKeys) ? d.invalidConfigKeys : [];
  const noLinuxPrebuilt = d.hasLinuxBinaryAsset === false;
  if (installBusyNow && installPhaseNow === 'install') {
    setOpenClawStatusLine('更新状态：安装中', opProgress);
  } else if (installBusyNow && installPhaseNow === 'update') {
    setOpenClawStatusLine('更新状态：更新中', opProgress);
  } else if (uninstallBusyNow || (installBusyNow && installPhaseNow === 'uninstall')) {
    setOpenClawStatusLine('更新状态：卸载中', opProgress);
  } else if (restartBusyNow) {
    setOpenClawStatusLine('更新状态：Gateway 启动中（正在等待健康检查）', opProgress);
  } else if (repairBusyNow) {
    setOpenClawStatusLine('更新状态：配置恢复中', opProgress);
  } else if (invalidKeys.length > 0) {
    setOpenClawStatusLine(`配置状态：检测到无效 key（${invalidKeys.join(', ')}），请点击“配置恢复”`, null);
  } else if (noLinuxPrebuilt && !d.installed) {
    setOpenClawStatusLine('安装提示：将使用官方 npm 安装', null);
  } else if (!d.installed) {
    setOpenClawStatusLine('更新状态：未安装，可执行安装', null);
  } else if (!d.gatewayRunning && d.gatewayStarting && d.discordConnectError) {
    setOpenClawStatusLine(`Gateway 状态：启动中（通道连接受阻 — ${d.discordConnectError}）`, null);
  } else if (!d.gatewayRunning && d.gatewayStarting) {
    setOpenClawStatusLine('Gateway 状态：启动中（正在等待健康检查）', null);
  } else if (!d.gatewayRunning && postInstallWarmup && d.gatewayProcessRunning) {
    setOpenClawStatusLine('Gateway 状态：启动中（安装完成后初始化中）', null);
  } else if (!d.gatewayRunning && d.gatewayPairingRequired) {
    setOpenClawStatusLine('Gateway 状态：等待控制台配对。请先在网关页面完成配对授权', null);
  } else if (!d.gatewayRunning && d.gatewayProcessRunning && d.discordConnectError) {
    setOpenClawStatusLine(`Gateway 状态：初始化中（${d.discordConnectError}）`, null);
  } else if (!d.gatewayRunning && d.gatewayProcessRunning) {
    setOpenClawStatusLine('Gateway 状态：启动中（初始化中，等待健康检查）', null);
  } else if (d.installed && !d.version) {
    setOpenClawStatusLine('更新状态：已安装（版本待识别）', null);
  } else if (d.updateCheckError) {
    setOpenClawStatusLine(`更新状态：检查失败（${d.updateCheckError}）`, null);
  } else if (d.hasUpdate) {
    setOpenClawStatusLine('更新状态：发现新版本，可更新', null);
  } else if (d.installed && d.gatewayRunning && d.discordConnectError) {
    setOpenClawStatusLine(`ℹ️ Discord 连接问题：${d.discordConnectError}`, null);
  } else if (d.installed) {
    setOpenClawStatusLine('更新状态：已是最新版本', null);
  } else {
    setOpenClawStatusLine('更新状态：自动检查中', null);
  }

  // pairing section is now always visible on the messaging page

  syncOpenClawButtons();

  return d;
}

async function pollTask(taskId){
  if (ocPollTimer) clearInterval(ocPollTimer);

  let lastSeq = 0;
  let errorStreak = 0;
  let errorBackoffMs = 2000; // C8: 指数退避起始值 (DFMEA F2)
  const startedAt = Date.now();
  let lastHeartbeatAt = 0;
  const initialPhase = ocInstallPhase;
  const POLL_TOTAL_TIMEOUT_MS = 120000; // C8: 总超时 120s (DFMEA F2)

  const schedulePoll = () => {
    if (ocPollTimer) clearTimeout(ocPollTimer);
    ocPollTimer = setTimeout(tick, errorStreak > 0 ? errorBackoffMs : 1500);
  };

  const tick = async () => {
    const st = await api('/api/openclaw/install/' + taskId + '?since=' + lastSeq, { timeoutMs: 20000 });
    if (!st || st.error) {
      errorStreak += 1;
      errorBackoffMs = Math.min(errorBackoffMs * 2, 30000); // C8: 指数退避，上限 30s
      const totalErrorMs = Date.now() - startedAt;
      if (totalErrorMs > POLL_TOTAL_TIMEOUT_MS && errorStreak >= 3) {
        if (ocPollTimer) clearTimeout(ocPollTimer);
        ocPollTimer = null;
        ocInstallRunning = false;
        ocUninstallRunning = false;
        ocInstallPhase = 'auto';
        syncOpenClawButtons();
        const detail = st?.error || '任务状态轮询失败';
        appendOcLogLine(`❌ 轮询中断: ${detail}（连续失败${errorStreak}次，总耗时${Math.round(totalErrorMs/1000)}s）`);
        toast('任务状态异常', detail);
      } else {
        schedulePoll();
      }
      return;
    }
    errorStreak = 0;
    errorBackoffMs = 2000; // C8: 成功后重置退避

    if ((Date.now() - startedAt) > 18 * 60 * 1000) {
      if (ocPollTimer) clearTimeout(ocPollTimer);
      ocPollTimer = null;
      ocInstallRunning = false;
      ocUninstallRunning = false;
      ocInstallPhase = 'auto';
      syncOpenClawButtons();
      appendOcLogLine('⚠️ 任务执行超时，请检查日志并按需重试');
      toast('任务超时', '执行超过 18 分钟，已停止前端轮询');
      return;
    }

    // C11: 操作日志窗口只显示关键里程碑，详细输出保留在后端日志
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
      const opLabel = taskOp === 'uninstalling' ? '卸载' : (taskOp === 'updating' ? '更新' : '安装');
      ocInstallPhase = 'auto';
      syncOpenClawButtons();
      appendOcLogLine(st.status === 'success' ? `✅ ${opLabel}完成` : `❌ ${opLabel}失败`);
      const successDetail = taskOp === 'uninstalling'
        ? 'OpenClaw 已卸载'
        : (taskOp === 'updating' ? 'OpenClaw 已更新，Gateway 正在自动重启' : 'OpenClaw 已安装，Gateway 正在自动重启');
      toast(st.status === 'success' ? '完成' : '失败', st.status === 'success' ? successDetail : (st.error || st.log || '请查看日志'));
      if (st.status === 'success' && taskOp !== 'uninstalling') {
        appendOcLogLine('⏳ Gateway 正在自动重启，状态栏将实时更新...');
        ocPostInstallWarmupUntil = Date.now() + (5 * 60 * 1000);
        ocLastGatewaySnapshot = '';
        setStatusBadge('oc-gateway', 'pending', '启动中', true);
        setOpenClawStatusLine('更新状态：Gateway 启动中', { active: true, startedAt: Date.now(), totalSec: 60 });
        scheduleGatewayStartupLogPulls(220);
      }
      refreshOpenClaw({ force: true });
      refreshStatus();
      return; // C8: 任务结束，不再调度下一次轮询
    }
    schedulePoll(); // C8: 调度下一次轮询
  };

  await tick();
}

async function pollRepairTask(taskId){
  if (ocRepairPollTimer) clearInterval(ocRepairPollTimer);
  const repairBtn = $('btn-oc-repair-config');
  ocRepairRunning = true;
  if (repairBtn) {
    repairBtn.disabled = true;
    repairBtn.textContent = '修复中...';
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
          repairBtn.textContent = '配置恢复';
        }
        syncOpenClawButtons();
        toast('任务状态异常', st?.error || '配置恢复状态轮询失败');
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
        repairBtn.textContent = '配置恢复';
      }
      syncOpenClawButtons();
      toast('任务超时', '配置恢复执行超过 8 分钟，已停止前端轮询');
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
        repairBtn.textContent = '配置恢复';
      }
      syncOpenClawButtons();
      if (st.status === 'success') {
        toast('配置恢复完成', st.changed ? '已修复并建议重启 Gateway' : '未发现需要修复的配置项');
      } else {
        toast('配置恢复失败', st.error || '请查看日志');
      }
      setTimeout(refreshOpenClaw, 800);
    }
  };

  await tick();
  ocRepairPollTimer = setInterval(tick, 700);
}

$('btn-oc-refresh').addEventListener('click', async ()=>{
  appendOcLogLine('🔄 正在刷新状态...');
  const r = await refreshOpenClaw({ retries: 1 });
  if (r?.error) {
    appendOcLogLine(`❌ 状态刷新失败：${r.error}`);
    toast('状态刷新失败', r.error);
  } else {
    const ver = r?.version ? formatVersionLabel(r.version) : '未知';
    const gw = r?.gatewayRunning ? '运行中' : '未启动';
    appendOcLogLine(`✅ 状态已刷新（版本：${ver}，Gateway：${gw}）`);
  }
});

// --- Config Export ---
$('btn-oc-config-export')?.addEventListener('click', async () => {
  const btn = $('btn-oc-config-export');
  if (btn) { btn.disabled = true; btn.textContent = '\u5BFC\u51FA\u4E2D...'; }
  appendOcLogLine('[export] \u6B63\u5728\u6253\u5305\u914D\u7F6E\u6587\u4EF6...');
  try {
    const resp = await fetch('/api/openclaw/config/export', {
      credentials: 'same-origin'
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '\u5BFC\u51FA\u5931\u8D25');
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
          types: [{ description: 'tar.gz \u538B\u7F29\u5305', accept: { 'application/gzip': ['.tar.gz', '.tgz'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('\u914D\u7F6E\u5BFC\u51FA', '\u5DF2\u4FDD\u5B58\u914D\u7F6E\u538B\u7F29\u5305');
        appendOcLogLine('[export] \u914D\u7F6E\u5DF2\u5BFC\u51FA: ' + handle.name);
      } catch (PickerErr) {
        if (PickerErr.name === 'AbortError') {
          appendOcLogLine('[export] \u7528\u6237\u53D6\u6D88\u4FDD\u5B58');
        } else throw PickerErr;
      }
    } else {
      // Fallback: auto download
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = defaultName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('\u914D\u7F6E\u5BFC\u51FA', '\u5DF2\u4E0B\u8F7D\u914D\u7F6E\u538B\u7F29\u5305');
      appendOcLogLine('[export] \u914D\u7F6E\u5DF2\u5BFC\u51FA: ' + defaultName);
    }
  } catch (e) {
    toast('\u5BFC\u51FA\u5931\u8D25', e.message);
    appendOcLogLine('[export] \u5BFC\u51FA\u5931\u8D25: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDCE4 \u914D\u7F6E\u5BFC\u51FA'; }
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
    toast('\u683C\u5F0F\u9519\u8BEF', '\u8BF7\u9009\u62E9 .tar.gz\u3001.tgz \u6216 .tar \u6587\u4EF6');
    return;
  }
  const importContentType = file.name.endsWith('.tar') && !file.name.endsWith('.tar.gz')
    ? 'application/x-tar' : 'application/gzip';
  if (!confirm('\u5BFC\u5165\u914D\u7F6E\u5C06\u8986\u76D6\u5F53\u524D\u914D\u7F6E\uFF08\u4F1A\u81EA\u52A8\u5907\u4EFD\u5F53\u524D\u914D\u7F6E\uFF09\u3002\n\u5BFC\u5165\u540E\u9700\u70B9\u51FB\u201C\u91CD\u542F Gateway\u201D\u4F7F\u914D\u7F6E\u751F\u6548\u3002\n\n\u786E\u5B9A\u7EE7\u7EED\uFF1F')) return;
  const btn = $('btn-oc-config-import');
  if (btn) { btn.disabled = true; btn.textContent = '\u5BFC\u5165\u4E2D...'; }
  try {
    const resp = await fetch('/api/openclaw/config/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': importContentType },
      body: file
    });
    const r = await resp.json();
    if (!resp.ok || r.error) throw new Error(r.error || '\u5BFC\u5165\u5931\u8D25');
    toast('\u914D\u7F6E\u5BFC\u5165', '\u5DF2\u6062\u590D: ' + (r.restoredFiles || []).join(', '));
    appendOcLogLine('[import] \u914D\u7F6E\u5DF2\u5BFC\u5165: ' + (r.restoredFiles || []).join(', ') + ' (\u5DF2\u5907\u4EFD\u5230 ' + (r.backupName || '') + ')');
    appendOcLogLine('[import] \u8BF7\u70B9\u51FB\u201C\u91CD\u542F Gateway\u201D\u4F7F\u914D\u7F6E\u751F\u6548\u3002');
  } catch (e) {
    toast('\u5BFC\u5165\u5931\u8D25', e.message);
    appendOcLogLine('[import] \u5BFC\u5165\u5931\u8D25: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDCE5 \u914D\u7F6E\u5BFC\u5165'; }
  }
});

// --- Migration Export ---
$('btn-migration-export')?.addEventListener('click', async () => {
  const btn = $('btn-migration-export');
  if (btn) { btn.disabled = true; btn.textContent = '打包中...'; }
  appendOcLogLine('[migration] 正在导出全量迁移数据（配置+密钥+身份+设备+工作空间+会话历史）...');
  try {
    const resp = await fetch('/api/openclaw/migration/export', { credentials: 'same-origin' });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '导出失败');
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('content-disposition') || '';
    const fnMatch = cd.match(/filename="?([^"]+)"?/);
    const defaultName = fnMatch ? fnMatch[1] : 'openclaw-migration.tar.gz';
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types: [{ description: 'tar.gz 压缩包', accept: { 'application/gzip': ['.tar.gz', '.tgz'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('迁移导出', '已保存迁移包: ' + handle.name);
        appendOcLogLine('[migration] 迁移包已导出: ' + handle.name + ' (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)');
      } catch (PickerErr) {
        if (PickerErr.name === 'AbortError') appendOcLogLine('[migration] 用户取消保存');
        else throw PickerErr;
      }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = defaultName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('迁移导出', '已下载迁移包');
      appendOcLogLine('[migration] 迁移包已下载: ' + defaultName + ' (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)');
    }
  } catch (e) {
    toast('导出失败', e.message);
    appendOcLogLine('[migration] 导出失败: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚚 迁移导出'; }
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
    toast('格式错误', '请选择 .tar.gz 迁移包');
    return;
  }
  if (!confirm('⚠️ 迁移导入将覆盖当前容器的 OpenClaw 应用数据：\n\n' +
    '• 配置文件（模型、渠道、安全策略）\n' +
    '• 加密密钥（.enc_key）\n' +
    '• 设备身份和已配对 Node\n' +
    '• 工作空间（SOUL.md 等 Agent 人格文件、脚本）\n' +
    '• Agent 会话历史\n' +
    '• 定时任务和执行记录\n\n' +
    '不会覆盖容器配置（SSH、端口、域名等）。\n' +
    '导入前会自动备份当前数据到 /tmp/。\n' +
    '导入后必须重启 Gateway 才能生效。\n\n确定继续？')) return;
  const btn = $('btn-migration-import');
  if (btn) { btn.disabled = true; btn.textContent = '导入中...'; }
  appendOcLogLine('[migration] 正在导入迁移数据: ' + file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)...');
  try {
    const resp = await fetch('/api/openclaw/migration/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/gzip' },
      body: file
    });
    const r = await resp.json();
    if (!resp.ok || r.error) throw new Error(r.error || '导入失败');
    toast('迁移导入成功', '已恢复 ' + (r.restoredFiles || []).length + ' 项数据');
    appendOcLogLine('[migration] 导入完成: ' + (r.restoredFiles || []).join(', '));
    appendOcLogLine('[migration] 原数据已备份到: ' + (r.preImportBackup || ''));
    appendOcLogLine('[migration] ⚠️ 请点击「重启 Gateway」使迁移数据生效！');
  } catch (e) {
    toast('导入失败', e.message);
    appendOcLogLine('[migration] 导入失败: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚚 迁移导入'; }
  }
});

$('btn-oc-repair-config')?.addEventListener('click', async ()=>{
  if (ocInstallRunning || ocInstallTaskRunningRemote || ocStartRunning || ocGatewayRestartRunningRemote) {
    toast('任务进行中', '安装/更新或网关重启执行中，暂不可配置恢复');
    return;
  }
  if (ocRepairRunning) {
    appendOcLogLine('[restore] 配置恢复任务进行中，请勿重复触发。');
    return;
  }
  ocRepairRunning = true;
  syncOpenClawButtons();
  appendOcLogLine('[restore] 正在读取配置备份列表...');
  try {
    const list = await api('/api/openclaw/config/backups', { timeoutMs: 30000 });
    if (!list || list.error || !Array.isArray(list.backups)) {
      throw new Error(list?.error || '备份列表读取失败');
    }
    if (list.backups.length === 0) {
      appendOcLogLine('[restore] 未找到可用备份文件。');
      toast('配置恢复', '未找到备份文件');
      return;
    }

    // 构建备份选择列表
    const shown = list.backups.slice(0, 15);
    const hint = shown.map((item, idx) => {
      const dateStr = item.name.replace('snapshot-', '').replace(/^openclaw-/, '').replace(/\.json$/, '').replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5:$6');
      const fileNames = (item.files || []).map(f => f.name).join(', ');
      return `${idx + 1}. ${dateStr}  [${fileNames}]`;
    }).join('\n');
    const input = window.prompt(
      `配置恢复说明：\n` +
      `1) 选择一个备份时间点\n` +
      `2) 多文件备份可选择恢复全部或单个文件\n` +
      `3) 恢复后需点击"重启 Gateway"使配置生效\n\n` +
      `可用备份：\n${'─'.repeat(40)}\n${hint}\n${'─'.repeat(40)}\n` +
      `输入序号选择：`, '1');
    if (input === null) {
      appendOcLogLine('[restore] 已取消。');
      return;
    }

    const raw = String(input || '').trim();
    if (!raw || !/^\d+$/.test(raw)) {
      appendOcLogLine('[restore] 未输入有效序号，已取消。');
      return;
    }

    const selectedIdx = Number(raw) - 1;
    if (selectedIdx < 0 || selectedIdx >= shown.length) {
      appendOcLogLine('[restore] 无效的选择。');
      return;
    }

    const selected = shown[selectedIdx];
    let filesToRestore = [];

    // 如果是 snapshot 且有多个文件，让用户选择恢复哪些
    if (selected.type === 'snapshot' && selected.files && selected.files.length > 1) {
      const fileHint = selected.files.map((f, i) => `  ${i + 1}. ${f.name}`).join('\n');
      const fileInput = window.prompt(
        `备份包含 ${selected.files.length} 个配置文件：\n${fileHint}\n\n` +
        `输入序号恢复单个文件（如 1）\n` +
        `输入多个序号恢复多个文件（如 1,3）\n` +
        `输入 all 恢复全部文件：`,
        'all'
      );
      if (fileInput === null) {
        appendOcLogLine('[restore] 已取消。');
        return;
      }
      const fraw = String(fileInput || '').trim().toLowerCase();
      if (fraw === 'all' || fraw === '全部') {
        filesToRestore = selected.files.map(f => f.name);
      } else {
        // 支持逗号分隔的多序号选择，如 "1,3" 或 "1, 2, 4"
        const indices = fraw.split(/[,，\s]+/).map(s => Number(s.trim()) - 1).filter(i => i >= 0 && i < selected.files.length);
        if (indices.length > 0) {
          filesToRestore = [...new Set(indices)].map(i => selected.files[i].name);
        }
      }
      if (filesToRestore.length === 0) {
        appendOcLogLine('[restore] 无效的文件选择。');
        return;
      }
    }

    const body = { name: selected.name };
    if (filesToRestore.length > 0) body.files = filesToRestore;
    appendOcLogLine(`[restore] 正在恢复备份: ${selected.name}` + (filesToRestore.length > 0 ? ` (${filesToRestore.join(', ')})` : ''));
    const r = await api('/api/openclaw/config/restore', { method:'POST', body, timeoutMs: 30000 });
    if (!r || r.error || !r.success) {
      throw new Error(r?.error || '恢复失败');
    }

    const restoredDesc = r.restoredFiles ? r.restoredFiles.join(', ') : (r.restored || selected.name);
    appendOcLogLine(`[restore] 配置恢复完成: ${restoredDesc}`);
    appendOcLogLine('[restore] 请点击“重启 Gateway”使配置生效。');
    toast('配置恢复完成', restoredDesc);
  } catch (e) {
    const err = e?.message || String(e || '配置恢复失败');
    appendOcLogLine(`[restore] 失败: ${err}`);
    toast('配置恢复失败', err);
  } finally {
    ocRepairRunning = false;
    syncOpenClawButtons();
    setTimeout(refreshOpenClaw, 500);
  }
});

$('btn-oc-install').addEventListener('click', async ()=>{
  if (ocInstallRunning) {
    toast('任务进行中', '安装/更新任务正在执行，请稍候');
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
      appendOcLogLine('📦 开始安装 OpenClaw...');
      const i = await api('/api/openclaw/install', { method:'POST', timeoutMs: 90000 });
      if (!i.taskId && Number(i?.status || 0) === 409) {
        const existingTaskId = String(i?.operationState?.taskId || '').trim();
        const existingType = String(i?.operationState?.type || '').trim();
        if (existingTaskId && (existingType === 'installing' || existingType === 'updating')) {
          appendOcLogLine('⏳ 检测到已有任务进行中，接管进度显示...');
          toast('任务进行中', '已存在安装/更新任务，正在接管进度显示');
          taskStarted = true;
          pollTask(existingTaskId);
          return;
        }
      }
      if (!i.taskId){
        const isEmptyResponse = i && typeof i === 'object' && Object.keys(i).length === 0;
        const detail = i.error || (isEmptyResponse
          ? '接口返回空响应（可能会话失效或页面缓存未更新，请刷新后重试）'
          : `接口返回异常（${JSON.stringify(i || {}) || 'empty'}）`);
        appendOcLogLine(`❌ 安装启动失败: ${detail}`);
        if (/空响应|缓存未更新|会话失效/.test(detail)) {
          appendOcLogLine('💡 提示: 请强制刷新页面后重试（macOS: Command+Shift+R）');
        }
        toast('安装失败', detail);
        return;
      }
      toast('开始安装', '正在执行 OpenClaw 安装...');
      appendOcLogLine(`✅ 安装任务已启动`);
      if (i?.release?.tag) appendOcLogLine(`📋 目标版本: ${i.release.tag}`);
      taskStarted = true;
      pollTask(i.taskId);
      return;
    }

    let current = await refreshOpenClaw({ retries: 2 });
    if (!current || current.error) {
      const detail = current?.error || '无法获取当前 OpenClaw 状态';
      appendOcLogLine(`⚠️ 状态读取失败，使用缓存继续（${detail}）`);
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
      appendOcLogLine('📦 开始安装 OpenClaw...');
      const i = await api('/api/openclaw/install', { method:'POST', timeoutMs: 90000 });
      if (!i.taskId && Number(i?.status || 0) === 409) {
        const existingTaskId = String(i?.operationState?.taskId || '').trim();
        const existingType = String(i?.operationState?.type || '').trim();
        if (existingTaskId && (existingType === 'installing' || existingType === 'updating')) {
          appendOcLogLine('⏳ 检测到已有任务进行中，接管进度显示...');
          toast('任务进行中', '已存在安装/更新任务，正在接管进度显示');
          taskStarted = true;
          pollTask(existingTaskId);
          return;
        }
      }
      if (!i.taskId){
        const isEmptyResponse = i && typeof i === 'object' && Object.keys(i).length === 0;
        const detail = i.error || (isEmptyResponse
          ? '接口返回空响应（可能会话失效或页面缓存未更新，请刷新后重试）'
          : `接口返回异常（${JSON.stringify(i || {}) || 'empty'}）`);
        appendOcLogLine(`❌ 安装启动失败: ${detail}`);
        if (/空响应|缓存未更新|会话失效/.test(detail)) {
          appendOcLogLine('💡 提示: 请强制刷新页面后重试（macOS: Command+Shift+R）');
        }
        toast('安装失败', detail);
        return;
      }
      toast('开始安装', '正在执行 OpenClaw 安装...');
      appendOcLogLine('✅ 安装任务已启动');
      if (i?.release?.tag) appendOcLogLine(`📋 目标版本: ${i.release.tag}`);
      taskStarted = true;
      pollTask(i.taskId);
      return;
    }

    if (!current.version) {
      appendOcLogLine('⚠️ 未检测到本地版本，已取消更新');
      toast('更新已取消', '未检测到本地版本，请先检查安装状态');
      return;
    }

    if (!current.latestVersion) {
      appendOcLogLine('⚠️ 无法获取远端最新版本，已取消更新');
      toast('更新已取消', current.updateCheckError || '无法获取远端版本');
      return;
    }

    if (!current.hasUpdate) {
      appendOcLogLine(`✅ 当前已是最新版本（${formatVersionLabel(current.version)}）`);
      toast('无需更新', `当前已是最新版本：${formatVersionLabel(current.version)}`);
      return;
    }

    appendOcLogLine(`📦 开始更新 OpenClaw: ${formatVersionLabel(current.version)} → ${current.latestVersion}`);
    ocInstallPhase = 'update';
    const r = await api('/api/openclaw/update', { method:'POST' });
    if (!r.taskId && Number(r?.status || 0) === 409) {
      const existingTaskId = String(r?.operationState?.taskId || '').trim();
      const existingType = String(r?.operationState?.type || '').trim();
      if (existingTaskId && (existingType === 'installing' || existingType === 'updating')) {
        appendOcLogLine('⏳ 检测到已有任务进行中，接管进度显示...');
        toast('任务进行中', '已存在安装/更新任务，正在接管进度显示');
        taskStarted = true;
        pollTask(existingTaskId);
        return;
      }
    }
    if (!r.taskId){
      const isEmptyResponse = r && typeof r === 'object' && Object.keys(r).length === 0;
      const detail = r.error || (isEmptyResponse
        ? '接口返回空响应（可能会话失效或页面缓存未更新，请刷新后重试）'
        : `接口返回异常（${JSON.stringify(r || {}) || 'empty'}）`);
      appendOcLogLine(`❌ 更新启动失败: ${detail}`);
      if (/空响应|缓存未更新|会话失效/.test(detail)) {
        appendOcLogLine('💡 提示: 请强制刷新页面后重试（macOS: Command+Shift+R）');
      }
      toast('更新失败', detail);
      return;
    }
    toast('开始更新', `正在更新到 ${current.latestVersion}...`);
    appendOcLogLine('✅ 更新任务已启动');
    if (r?.release?.tag) appendOcLogLine(`📋 目标版本: ${r.release.tag}`);
    taskStarted = true;
    pollTask(r.taskId);
  } catch (e) {
    appendOcLogLine(`❌ 请求失败: ${e.message || e}`);
    toast('请求失败', e.message || String(e));
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
    toast('任务进行中', '安装/更新执行中，暂不可重启 Gateway');
    return;
  }
  if (ocStartRunning) {
    toast('任务进行中', '网关重启正在执行，请稍候');
    return;
  }
  const skipConfirm = !!(event && event.shiftKey);
  if (!skipConfirm) {
    const ok = window.confirm('确认重启 Gateway？\n重启期间连接会短暂中断。');
    if (!ok) {
      toast('已取消', '未执行 Gateway 重启');
      return;
    }
  }
  ocStartRunning = true;
  ocGatewayRestartRunningRemote = true;
  applyGatewayRestartingUi();
  syncOpenClawButtons();
  appendOcLogLine('⏳ 正在提交重启请求...');
  ocLastGatewaySnapshot = '';
  let restartAccepted = false;
  try {
    const r = await api('/api/openclaw/start', { method:'POST', timeoutMs: 90000 });
    if (r.success) {
      restartAccepted = true;
      appendOcLogLine('✅ 重启请求已接受，Gateway 重启中...');
      if (r.logs) {
        ocLastGatewaySnapshot = String(r.logs || '').trim() || ocLastGatewaySnapshot;
      }
      triggerLogsBurstPolling(22000, 1200);
      scheduleGatewayStartupLogPulls(220);
      toast('已触发重启', r.message || 'Gateway 正在重启，请稍候');
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
          appendOcLogLine('⏳ 请求超时，但后端仍在重启中...');
          triggerLogsBurstPolling(22000, 1200);
          scheduleGatewayStartupLogPulls(220);
          toast('重启处理中', '请求超时，但后端仍在重启 Gateway');
          return;
        }
      }
      appendOcLogLine(`❌ 重启失败: ${r.error || '请查看日志'}`);
      if (r.logs) {
        ocLastGatewaySnapshot = String(r.logs || '').trim() || ocLastGatewaySnapshot;
      }
      if (/Unrecognized key|Invalid config|配置无效/i.test(String(r.error || ''))) {
        appendOcLogLine('💡 检测到配置无效，请点击“配置恢复”按钮后重试');
      }
      ocGatewayRestartRunningRemote = false;
      toast('重启失败', r.error || '请查看日志');
    }
  } finally {
    if (!restartAccepted) {
      ocGatewayRestartRunningRemote = false;
    }
    ocStartRunning = false;
    syncOpenClawButtons();
  }
  if (restartAccepted) {
    // 轮询等待 Gateway 真正启动完成（最多 10 分钟）
    // Gateway 热重启通常在 5~15 秒内完成，冷启动可能需要更长时间
    const pollStart = Date.now();
    const pollTimeout = 10 * 60 * 1000;
    const pollInterval = 2000;
    // 初始等待：给旧进程退出、新进程启动留时间，避免误判旧进程为"已成功"
    const initialDelay = 2500;
    let gwUp = false;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 20; // 40s of continuous failures → give up
    const newProcessUptimeGraceSec = 30;
    appendOcLogLine('⏳ 等待 Gateway 启动完成（最多 10 分钟）...');
    await new Promise(r => setTimeout(r, initialDelay));
    while (Date.now() - pollStart < pollTimeout) {
      await new Promise(r => setTimeout(r, pollInterval));
      try {
        const st = await api('/api/openclaw', { timeoutMs: 15000 });
        if (st.error) {
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            appendOcLogLine(`⚠️ API 连续 ${consecutiveErrors} 次返回错误，停止轮询`);
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
          appendOcLogLine(`⚠️ 网络连续 ${consecutiveErrors} 次失败，停止轮询`);
          break;
        }
      }
    }
    if (gwUp) {
      appendOcLogLine('✅ Gateway 重启成功');
      toast('重启成功', 'Gateway 已恢复运行');
    } else {
      appendOcLogLine('⚠️ Gateway 重启超时或轮询中断，请检查状态');
      toast('重启超时', 'Gateway 未在预期时间内恢复，请手动检查');
    }
    ocGatewayRestartRunningRemote = false;
    syncOpenClawButtons();
  }
  setTimeout(() => refreshOpenClaw({ retries: 0 }), 200);
  setTimeout(refreshOpenClaw, 1800);
});

$('btn-oc-uninstall')?.addEventListener('click', async ()=>{
  if (ocInstallRunning || ocUninstallRunning) {
    toast('任务进行中', '安装/更新/卸载任务正在执行，请稍候');
    return;
  }
  if (ocStartRunning || ocRepairRunning) {
    toast('任务进行中', '当前有其他操作在执行，请稍候');
    return;
  }
  if (!ocInstalled) {
    toast('无法卸载', '当前未安装 OpenClaw');
    return;
  }
  const ok1 = window.confirm('确认卸载 OpenClaw？\n将移除本地安装与源码目录。');
  if (!ok1) return toast('已取消', '未执行卸载');
  const ok2 = window.confirm('二次确认：确定继续卸载吗？\n卸载期间将禁止安装/更新/重启。');
  if (!ok2) return toast('已取消', '未执行卸载');

  ocUninstallRunning = true;
  ocInstallPhase = 'uninstall';
  syncOpenClawButtons();
  let taskStarted = false;
  try {
    const _logEl = $('oc-log');
    if (_logEl) _logEl.innerHTML = '';
    clearOcLogCache();
    appendOcLogLine('🗑️ 开始卸载 OpenClaw...');
    const r = await api('/api/openclaw/uninstall', { method:'POST' });
    if (!r?.taskId) {
      const detail = r?.error || '卸载任务创建失败';
      appendOcLogLine(`❌ 卸载启动失败: ${detail}`);
      toast('卸载失败', detail);
      return;
    }
    taskStarted = true;
    appendOcLogLine('⏳ 卸载任务执行中...');
    pollTask(r.taskId);
    toast('开始卸载', '正在执行 OpenClaw 卸载...');
  } catch (e) {
    appendOcLogLine(`❌ 卸载请求失败: ${e.message || e}`);
    toast('请求失败', e.message || String(e));
  } finally {
    if (!taskStarted) {
      ocUninstallRunning = false;
      ocInstallPhase = 'auto';
      syncOpenClawButtons();
    }
  }
});

// --- 历史版本选择安装 ---
$('btn-oc-load-versions')?.addEventListener('click', async () => {
  const btn = $('btn-oc-load-versions');
  const sel = $('oc-version-select');
  if (!btn || !sel) return;
  btn.disabled = true;
  btn.textContent = '加载中...';
  try {
    const r = await api('/api/openclaw/versions', { timeoutMs: 30000 });
    if (!r?.versions?.length) {
      toast('加载失败', r?.error || '未获取到版本列表');
      return;
    }
    sel.innerHTML = '<option value="">选择历史版本...</option>';
    for (const v of r.versions) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v + (r.installedVersion === v ? ' (当前)' : '');
      sel.appendChild(opt);
    }
    toast('版本列表已加载', `共 ${r.versions.length} 个版本`);
  } catch (e) {
    toast('加载失败', e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = '加载版本列表';
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
  if (!version) return toast('请选择版本', '请先从下拉列表中选择要安装的版本');
  if (ocInstallRunning || ocUninstallRunning) {
    return toast('任务进行中', '安装/更新任务正在执行，请稍候');
  }
  const ok = window.confirm(`确认安装 OpenClaw ${formatVersionLabel(version)}？\n将使用 A/B 备份更新模式，Gateway 仅在切换版本时短暂停止。`);
  if (!ok) return toast('已取消', '未执行安装');

  ocInstallRunning = true;
  ocInstallPhase = 'install';
  syncOpenClawButtons();
  let taskStarted = false;
  try {
    const _logEl = $('oc-log');
    if (_logEl) _logEl.innerHTML = '';
    clearOcLogCache();
    appendOcLogLine(`📦 开始安装指定版本: ${formatVersionLabel(version)}`);
    const r = await api('/api/openclaw/install-version', { method: 'POST', body: { version }, timeoutMs: 90000 });
    if (!r?.taskId) {
      const detail = r?.error || '安装任务创建失败';
      appendOcLogLine(`❌ 安装启动失败: ${detail}`);
      toast('安装失败', detail);
      return;
    }
    toast('开始安装', `正在安装 ${formatVersionLabel(version)}...`);
    appendOcLogLine('✅ 安装任务已启动');
    appendOcLogLine(`📋 目标版本: ${formatVersionLabel(version)}`);
    taskStarted = true;
    pollTask(r.taskId);
  } catch (e) {
    appendOcLogLine(`❌ 请求失败: ${e.message || e}`);
    toast('请求失败', e.message || String(e));
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

// Provider 配置信息
const AI_PROVIDERS = {
  // ─── 常用 ───
  anthropic: {
    name: 'Anthropic (Claude)', group: '常用',
    apiKeyLabel: 'Anthropic API Key', apiKeyPlaceholder: 'sk-ant-api03-...',
    authType: 'apikey', baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022']
  },
  openai: {
    name: 'OpenAI (GPT)', group: '常用',
    apiKeyLabel: 'OpenAI API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'o1', 'o1-mini']
  },
  'github-copilot': {
    name: 'GitHub Copilot', group: '常用',
    apiKeyLabel: 'OAuth Token', apiKeyPlaceholder: '使用设备授权登录',
    authType: 'oauth', oauthType: 'device',
    baseUrl: 'https://api.githubcopilot.com',
    models: ['github-copilot/gpt-4o', 'github-copilot/gpt-4', 'github-copilot/claude-3.5-sonnet', 'github-copilot/claude-sonnet-4', 'github-copilot/o1', 'github-copilot/o3-mini', 'github-copilot/gemini-2.0-flash'],
    oauthGuide: `<div style="color:#98989d;line-height:1.6">
      <p style="margin:4px 0"><b>GitHub Copilot 设备授权流程：</b></p>
      <p style="margin:4px 0">1. 确保你有 GitHub Copilot 订阅（个人版或企业版）</p>
      <p style="margin:4px 0">2. 点击"启动设备授权"按钮</p>
      <p style="margin:4px 0">3. 在弹出页面中登录 GitHub 并授权设备</p>
      <p style="margin:4px 0">4. 输入显示的设备码完成授权</p>
      <p style="margin:8px 0;color:#ff9f0a">注意：模型名称需要以 github-copilot/ 开头</p>
    </div>`
  },
  gemini: {
    name: 'Google Gemini', group: '常用',
    apiKeyLabel: 'Gemini API Key', apiKeyPlaceholder: 'AIza...',
    authType: 'apikey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']
  },
  openrouter: {
    name: 'OpenRouter', group: '常用',
    apiKeyLabel: 'OpenRouter API Key', apiKeyPlaceholder: 'sk-or-...',
    authType: 'apikey', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-pro-1.5']
  },
  deepseek: {
    name: 'DeepSeek', group: '常用',
    apiKeyLabel: 'DeepSeek API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner']
  },
  // ─── 国际 ───
  mistral: {
    name: 'Mistral AI', group: '国际',
    apiKeyLabel: 'Mistral API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest']
  },
  xai: {
    name: 'xAI (Grok)', group: '国际',
    apiKeyLabel: 'xAI API Key', apiKeyPlaceholder: 'xai-...',
    authType: 'apikey', baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-fast']
  },
  groq: {
    name: 'Groq', group: '国际',
    apiKeyLabel: 'Groq API Key', apiKeyPlaceholder: 'gsk_...',
    authType: 'apikey', baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it']
  },
  together: {
    name: 'Together AI', group: '国际',
    apiKeyLabel: 'Together API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.together.xyz/v1',
    models: ['moonshotai/Kimi-K2.5', 'deepseek-ai/DeepSeek-R1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo']
  },
  huggingface: {
    name: 'Hugging Face', group: '国际',
    apiKeyLabel: 'HF Token', apiKeyPlaceholder: 'hf_...',
    authType: 'apikey', baseUrl: 'https://router.huggingface.co/v1',
    models: ['deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3.1', 'meta-llama/Llama-3.3-70B-Instruct']
  },
  perplexity: {
    name: 'Perplexity', group: '国际',
    apiKeyLabel: 'Perplexity API Key', apiKeyPlaceholder: 'pplx-...',
    authType: 'apikey', baseUrl: 'https://api.perplexity.ai',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro']
  },
  nvidia: {
    name: 'NVIDIA NIM', group: '国际',
    apiKeyLabel: 'NVIDIA API Key', apiKeyPlaceholder: 'nvapi-...',
    authType: 'apikey', baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct']
  },
  cerebras: {
    name: 'Cerebras', group: '国际',
    apiKeyLabel: 'Cerebras API Key', apiKeyPlaceholder: 'csk-...',
    authType: 'apikey', baseUrl: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b', 'llama-3.1-8b']
  },
  venice: {
    name: 'Venice AI', group: '国际',
    apiKeyLabel: 'Venice API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.venice.ai/api/v1',
    models: ['llama-3.3-70b', 'deepseek-r1-671b']
  },
  // ─── 中国 ───
  bailian: {
    name: '阿里云百炼 (Bailian)', group: '中国',
    apiKeyLabel: 'DashScope API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    models: ['qwen3.5-plus', 'qwen3-max-2026-01-23', 'qwen3-coder-next', 'qwen3-coder-plus', 'MiniMax-M2.5', 'glm-5', 'glm-4.7', 'kimi-k2.5']
  },
  zai: {
    name: '智谱 Z.AI (GLM)', group: '中国',
    apiKeyLabel: 'Z.AI API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5', 'glm-4.7']
  },
  moonshot: {
    name: 'Moonshot (Kimi)', group: '中国',
    apiKeyLabel: 'Moonshot API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.5', 'moonshot-v1-128k', 'moonshot-v1-32k']
  },
  'kimi-coding': {
    name: 'Kimi Coding', group: '中国',
    apiKeyLabel: 'Kimi Coding API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.kimi.com/coding/',
    models: ['k2p5']
  },
  minimax: {
    name: 'MiniMax', group: '中国',
    apiKeyLabel: 'MiniMax API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.minimax.io/anthropic',
    models: ['MiniMax-M2.5', 'MiniMax-M1']
  },
  xiaomi: {
    name: '小米 MiMo', group: '中国',
    apiKeyLabel: 'Xiaomi API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.xiaomimimo.com/anthropic',
    models: ['mimo-v2-flash']
  },
  qianfan: {
    name: '百度千帆 (Qianfan)', group: '中国',
    apiKeyLabel: 'Qianfan API Key', apiKeyPlaceholder: 'bce-v3/ALTAK-...',
    authType: 'apikey', baseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['deepseek-v3.2', 'ernie-4.5-8k']
  },
  volcengine: {
    name: '火山引擎 (Volcengine)', group: '中国',
    apiKeyLabel: 'Volcengine API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    needsBaseUrl: true,
    models: ['ark-code-latest']
  },
  byteplus: {
    name: 'BytePlus', group: '中国',
    apiKeyLabel: 'BytePlus API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    needsBaseUrl: true,
    models: ['ark-code-latest']
  },
  // ─── 网关 / 代理 ───
  litellm: {
    name: 'LiteLLM', group: '网关',
    apiKeyLabel: 'LiteLLM API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'http://localhost:4000',
    needsBaseUrl: true,
    models: ['claude-opus-4-6', 'gpt-4o']
  },
  opencode: {
    name: 'OpenCode Zen', group: '网关',
    apiKeyLabel: 'OpenCode API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://opencode.ai/v1',
    models: ['claude-opus-4-6', 'gpt-4o']
  },
  kilocode: {
    name: 'Kilo Gateway', group: '网关',
    apiKeyLabel: 'Kilocode API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: 'https://api.kilo.ai/api/gateway/',
    models: ['anthropic/claude-opus-4.6']
  },
  synthetic: {
    name: 'Synthetic', group: '网关',
    apiKeyLabel: 'Synthetic API Key', apiKeyPlaceholder: 'sk-...',
    authType: 'apikey', baseUrl: '',
    needsBaseUrl: true,
    models: ['hf:MiniMaxAI/MiniMax-M2.5']
  },
  // ─── 本地 ───
  ollama: {
    name: 'Ollama (本地)', group: '本地',
    apiKeyLabel: 'Ollama API Key (可选)', apiKeyPlaceholder: '留空即可',
    authType: 'apikey', baseUrl: 'http://localhost:11434',
    needsBaseUrl: true,
    models: []
  },
  lmstudio: {
    name: 'LM Studio (本地)', group: '本地',
    apiKeyLabel: 'API Key (可选)', apiKeyPlaceholder: 'lm-studio',
    authType: 'apikey', baseUrl: 'http://127.0.0.1:1234/v1',
    needsBaseUrl: true,
    models: []
  },
  vllm: {
    name: 'vLLM (本地)', group: '本地',
    apiKeyLabel: 'vLLM API Key (可选)', apiKeyPlaceholder: '留空即可',
    authType: 'apikey', baseUrl: 'http://localhost:8000/v1',
    needsBaseUrl: true,
    models: []
  },
  // ─── 自定义 ───
  custom: {
    name: '自定义端点', group: '其他',
    apiKeyLabel: 'API Key', apiKeyPlaceholder: 'your-api-key',
    authType: 'apikey', baseUrl: '',
    needsBaseUrl: true,
    models: []
  }
};

// --- 多 API Key 管理 ---
let aiConfiguredKeys = []; // [{id, provider, keyMasked, baseUrl, authType, models:[]}]
let aiAuthTaskTimer = null;
let lastFocusedModelInput = 'ai-model-primary';
// 保存活跃的 OAuth 授权状态，切换 provider 时可恢复
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
  setDiscordRuntimeStatus('正在检查 Discord 运行状态...');
  const status = await api('/api/openclaw', { timeoutMs: 12000 });
  if (status.error) {
    setDiscordRuntimeStatus(`Discord 运行状态读取失败：${status.error}`, 'error');
    return;
  }

  const enabled = ($('discord-enabled')?.value || 'false') === 'true';
  if (!enabled) {
    setDiscordRuntimeStatus('Discord 当前未启用。保存配置并重启 Gateway 后才会建立连接。', 'warning');
    return;
  }
  if (status.discordConnectError) {
    setDiscordRuntimeStatus(`Discord 连接异常：${status.discordConnectError}`, 'error');
    return;
  }
  if (status.gatewayRunning) {
    setDiscordRuntimeStatus('Gateway 在线，最近未检测到 Discord 连接错误。', 'success');
    return;
  }
  if (status.gatewayStarting || status.gatewayProcessRunning) {
    setDiscordRuntimeStatus('Gateway 正在启动中，等待 Discord 完成连接。', 'warning');
    return;
  }
  setDiscordRuntimeStatus('Gateway 当前未运行，暂时无法确认 Discord 连接状态。', 'warning');
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
      // 如果有正在进行的 OAuth 授权，恢复授权信息而不是覆盖
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

  // 更新添加按钮文本：OAuth 模式不需要 API Key
  const addBtn = $('btn-ai-add-key');
  if (addBtn) {
    addBtn.textContent = config.authType === 'oauth' ? '添加此授权' : '添加此 API Key';
    // OAuth 模式隐藏添加按钮（授权完成后自动添加）
    addBtn.hidden = config.authType === 'oauth';
  }
}

function renderConfiguredKeys() {
  const select = $('ai-configured-select');
  if (!select) return;

  // 保存当前选中值
  const prevVal = select.value;

  // 清空并重建选项
  select.innerHTML = '<option value="">— 请选择 —</option>';

  aiConfiguredKeys.forEach((k, idx) => {
    const pConfig = AI_PROVIDERS[k.provider] || {};
    const providerName = pConfig.name || k.provider;
    const keyHint = k.keyMasked ? ` (${k.keyMasked})` : (k.authType === 'oauth' ? ' (OAuth)' : '');
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `${providerName}${keyHint}`;
    select.appendChild(opt);
  });

  // 恢复选中
  if (prevVal && select.querySelector(`option[value="${prevVal}"]`)) {
    select.value = prevVal;
  }

  onConfiguredKeySelected();
}

let _modelsFetchGen = 0; // 防止竞态：切换 key 时旧请求覆盖新结果

function onConfiguredKeySelected() {
  const select = $('ai-configured-select');
  const idx = parseInt(select?.value || '', 10);
  const key = aiConfiguredKeys[idx];

  const detail = $('ai-configured-detail');
  const info = $('ai-configured-info');
  const actions = $('ai-configured-actions');
  const modelsWrap = $('ai-configured-models-wrap');
  const modelsList = $('ai-configured-models-list');

  // 切换时立即清空旧模型列表，避免显示上一个 provider 的模型
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

  // 自动获取可用模型
  fetchConfiguredKeyModels();
}

async function fetchConfiguredKeyModels() {
  const select = $('ai-configured-select');
  const idx = parseInt(select?.value || '', 10);
  const key = aiConfiguredKeys[idx];
  if (!key) {
    toast('请先选择', '请先从下拉菜单选择一个 Key');
    return;
  }

  const pConfig = AI_PROVIDERS[key.provider] || {};
  const gen = ++_modelsFetchGen; // 递增 generation

  // 显示加载中
  const modelsWrap = $('ai-configured-models-wrap');
  const modelsList = $('ai-configured-models-list');
  if (modelsWrap) modelsWrap.hidden = false;
  if (modelsList) modelsList.innerHTML = '<div style="padding:8px;color:#86868b">加载中...</div>';

  appendAiAuthLog(`[fetch] 正在获取 ${pConfig.name || key.provider} 的模型列表...`);

  try {
    // 所有 provider 都通过后端 API 获取真实模型列表
    const res = await api('/api/ai/models', {
      method: 'POST',
      body: { provider: key.provider }
    });
    // 丢弃过期的请求结果（用户已切换到其他 key）
    if (gen !== _modelsFetchGen) return;
    if (res.error && !res.models) {
      appendAiAuthLog(`[fetch] 获取失败: ${res.error}`, 'error');
      if (modelsList) modelsList.innerHTML = '';
      if (modelsWrap) modelsWrap.hidden = true;
      return;
    }
    renderConfiguredModelsList(res.models || []);
    const srcLabel = res.source === 'api' ? '(来自 API)' : res.source === 'builtin' ? '(内置列表)' : '';
    appendAiAuthLog(`[fetch] 成功获取 ${(res.models || []).length} 个模型 ${srcLabel}`, 'success');
    if (res.error && res.source === 'builtin') {
      appendAiAuthLog(`[fetch] ⚠️ ${res.error}`, 'error');
    }
  } catch (e) {
    if (gen !== _modelsFetchGen) return;
    appendAiAuthLog(`[fetch] 错误: ${e.message}`, 'error');
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
        appendAiAuthLog(`[select] 已填充 ${fieldLabel}: ${modelId}`);
      }
    });
  });
}

async function deleteConfiguredKey() {
  const select = $('ai-configured-select');
  const idx = parseInt(select?.value || '', 10);
  const key = aiConfiguredKeys[idx];
  if (!key) {
    toast('请先选择', '请先从下拉菜单选择一个 Key');
    return;
  }

  const pConfig = AI_PROVIDERS[key.provider] || {};
  const label = `${pConfig.name || key.provider} (${key.keyMasked || 'OAuth'})`;
  if (!confirm(`确认删除 ${label}？\n关联的模型配置也会被清除。`)) return;

  appendAiAuthLog(`[delete] 正在删除 ${label}...`);

  try {
    const res = await api('/api/ai/keys', {
      method: 'DELETE',
      body: { provider: key.provider, keyId: key.id }
    });

    if (res.error) {
      toast('删除失败', res.error);
      appendAiAuthLog(`[delete] 失败: ${res.error}`, 'error');
      return;
    }

    toast('已删除', `${label} 已移除`);
    appendAiAuthLog(`[delete] ${label} 已删除`, 'success');
    await loadAIConfig();
  } catch (e) {
    toast('删除失败', e.message);
    appendAiAuthLog(`[delete] 错误: ${e.message}`, 'error');
  }
}

async function addAiKey() {
  const provider = $('ai-provider')?.value || '';
  const apiKey = $('ai-apikey')?.value?.trim() || '';
  const baseUrl = $('ai-baseurl')?.value?.trim() || '';
  const config = AI_PROVIDERS[provider] || {};

  // OAuth 类型不能通过"添加"按钮直接添加，必须先完成 OAuth 授权流程
  if (config.authType === 'oauth') {
    toast('请先授权', `${config.name || provider} 需要先点击"启动设备授权"完成 OAuth 登录`);
    appendAiAuthLog(`[add] ${config.name || provider} 是 OAuth 类型，请先完成设备授权`, 'error');
    return;
  }

  if (!apiKey) {
    toast('参数错误', '请输入 API Key');
    appendAiAuthLog('[add] 请输入 API Key', 'error');
    return;
  }

  // 先验证 API Key 有效性
  appendAiAuthLog(`[validate] 正在验证 ${config.name || provider} API Key...`);
  const addBtn = $('btn-ai-add-key');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = '验证中…'; }

  try {
    const vRes = await api('/api/ai/keys/validate', {
      method: 'POST',
      body: { provider, apiKey, baseUrl: baseUrl || null }
    });
    if (vRes.valid === false) {
      toast('Key 无效', vRes.error || 'API Key 验证失败');
      appendAiAuthLog(`[validate] API Key 验证失败: ${vRes.error || '无效'}`, 'error');
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = '添加此 API Key'; }
      return;
    }
    if (vRes.warning) {
      appendAiAuthLog(`[validate] ⚠️ ${vRes.warning}`);
    } else {
      appendAiAuthLog(`[validate] API Key 验证通过 ✓`, 'success');
    }
  } catch (e) {
    appendAiAuthLog(`[validate] 验证请求失败: ${e.message}，继续添加`);
  }

  if (addBtn) { addBtn.disabled = true; addBtn.textContent = '保存中…'; }
  appendAiAuthLog(`[add] 正在添加 ${config.name || provider} 的 API Key...`);

  try {
    const res = await api('/api/ai/keys', {
      method: 'POST',
      body: { provider, apiKey: apiKey || null, baseUrl: baseUrl || null }
    });

    if (res.error) {
      toast('添加失败', res.error);
      appendAiAuthLog(`[add] 失败: ${res.error}`, 'error');
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = '添加此 API Key'; }
      return;
    }

    toast('添加成功', `${config.name || provider} API Key 已保存`);
    appendAiAuthLog(`[add] ${config.name || provider} API Key 添加成功`, 'success');
    if ($('ai-apikey')) $('ai-apikey').value = '';
    await loadAIConfig();
    // 自动切到已配置 Key 页面
    document.querySelector('#ai-key-tabs .tab[data-ai-tab="configured-keys"]')?.click();
    // 自动选中刚添加的 key（选最后一个匹配的 provider）
    const sel = $('ai-configured-select');
    if (sel) {
      let lastIdx = -1;
      aiConfiguredKeys.forEach((k, i) => { if (k.provider === provider) lastIdx = i; });
      if (lastIdx >= 0) { sel.value = String(lastIdx); onConfiguredKeySelected(); }
    }
    // 自动获取可用模型
    appendAiAuthLog(`[add] 正在获取可用模型列表...`);
    try { await fetchConfiguredKeyModels(); } catch {}
  } catch (e) {
    toast('添加失败', e.message);
    appendAiAuthLog(`[add] 错误: ${e.message}`, 'error');
  }
  if (addBtn) { addBtn.disabled = false; addBtn.textContent = '添加此 API Key'; }
}

async function loadAIConfig(){
  appendAiAuthLog('[load] 正在读取配置...');

  try {
    let d = await api('/api/ai/config', { timeoutMs: 30000 });

    // 首次超时自动重试一次
    if (d.error && /超时|timeout/i.test(d.error)) {
      appendAiAuthLog('[load] 首次读取超时，正在重试...');
      d = await api('/api/ai/config', { timeoutMs: 30000 });
    }

    if (d.error) {
      $('ai-status').textContent = `状态：读取失败（${d.error}）`;
      appendAiAuthLog(`[load] 读取失败: ${d.error}`, 'error');
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
    const keyStatus = keyCount > 0 ? `✅ ${keyCount} 个 Key` : '⚠️ 未配置';
    const modelStatus = primaryModel ? `主模型：${primaryModel}` : '主模型：未设置';
    $('ai-status').textContent = `状态：已读取（${modelStatus}；API Key：${keyStatus}）`;
    appendAiAuthLog(`[load] 配置读取成功，${keyCount} 个已配置 Key`, 'success');

  } catch (e) {
    $('ai-status').textContent = `状态：读取失败（${e.message}）`;
    appendAiAuthLog(`[load] 错误: ${e.message}`, 'error');
  }
}

async function saveAIConfig() {
  let primaryModel = $('ai-model-primary')?.value?.trim() || '';
  let primaryFallback = $('ai-model-primary-fallback')?.value?.trim() || '';
  let subModel = $('ai-model-sub')?.value?.trim() || '';
  let subFallback = $('ai-model-sub-fallback')?.value?.trim() || '';

  if (!primaryModel) {
    toast('参数错误', '请设置主代理模型');
    appendAiAuthLog('[save] 错误: 主代理模型未设置', 'error');
    return;
  }

  // 自动补全 provider/ 前缀
  const autoPrefix = (modelStr) => {
    if (!modelStr) return modelStr;
    if (modelStr.includes('/')) return modelStr;
    // 从已配置 key 中找匹配的 provider，或使用当前选中的 provider
    const selProvider = $('ai-provider')?.value || '';
    const configuredProviders = aiConfiguredKeys.map(k => k.provider);
    const provider = configuredProviders.length > 0 ? configuredProviders[0] : selProvider;
    if (provider) return provider + '/' + modelStr;
    return modelStr;
  };
  primaryModel = autoPrefix(primaryModel);
  subModel = subModel ? autoPrefix(subModel) : '';
  // 对 fallback 列表中的每个模型也自动补前缀
  const autoPrefixList = (str) => {
    if (!str) return str;
    return str.split(',').map(s => autoPrefix(s.trim())).filter(Boolean).join(', ');
  };
  primaryFallback = autoPrefixList(primaryFallback);
  subFallback = autoPrefixList(subFallback);

  appendAiAuthLog('[save] 开始保存模型配置...');

  try {
    const body = {
      primaryModel,
      fallbacks: {
        primary: primaryFallback ? primaryFallback.split(',').map(s => s.trim()).filter(Boolean) : [],
        sub: subFallback ? subFallback.split(',').map(s => s.trim()).filter(Boolean) : []
      },
      subModel: subModel || null
    };

    appendAiAuthLog(`[save] 主模型: ${primaryModel}`);
    if (body.fallbacks.primary.length) appendAiAuthLog(`[save] 主代理 Fallbacks: ${body.fallbacks.primary.join(', ')}`);
    if (subModel) appendAiAuthLog(`[save] 子代理模型: ${subModel}`);

    const res = await api('/api/ai/config', { method:'POST', body });
    if (res.error) {
      toast('保存失败', res.error);
      appendAiAuthLog(`[save] 保存失败: ${res.error}`, 'error');
      return;
    }

    toast('保存成功', res.message || '模型配置已保存');
    appendAiAuthLog(`[save] ${res.message || '模型配置已保存'}`, 'success');
    await loadAIConfig();
  } catch (e) {
    toast('保存失败', e.message);
    appendAiAuthLog(`[save] 错误: ${e.message}`, 'error');
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
      // 自动显示设备授权信息 — 在 OAuth 卡片区域内显示
      if (!oauthUrlOpened) {
        const urlMatch = st.delta.match(/https?:\/\/[^\s)]+\/login\/device[^\s)']*/i)
          || st.delta.match(/https?:\/\/[^\s)]+verification[^\s)']*/i)
          || st.delta.match(/(https?:\/\/github\.com[^\s)']*)/i);
        if (urlMatch) {
          const url = urlMatch[0].replace(/[,.;:]+$/, '');
          oauthUrlOpened = true;
          // 提取 user_code
          const codeMatch = st.delta.match(/(?:授权码|code)[:：]\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})?)/i);
          const userCode = codeMatch ? codeMatch[1] : '';
          // 保存活跃授权状态，切换 provider 时可恢复
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
      toast(success ? '认证完成' : '认证失败', success ? '认证信息已写入' : '请查看日志');
      appendAiAuthLog(`[auth] OAuth 认证${success ? '成功' : '失败'}`, success ? 'success' : 'error');
      // 恢复 OAuth 卡片区域到初始状态
      _restoreOAuthCard(success);
      if (success) {
        // OAuth 成功后重新加载配置（服务端已自动添加 provider 条目）
        const provider = $('ai-provider')?.value || '';
        await loadAIConfig();
        // 自动切到已配置 Key 页面
        document.querySelector('#ai-key-tabs .tab[data-ai-tab="configured-keys"]')?.click();
        // 自动选中刚授权的 provider
        const sel = $('ai-configured-select');
        if (sel) {
          const newIdx = aiConfiguredKeys.findIndex(k => k.provider === provider);
          if (newIdx >= 0) { sel.value = String(newIdx); onConfiguredKeySelected(); }
        }
        // OAuth 成功后自动获取可用模型
        appendAiAuthLog(`[auth] 正在获取可用模型列表...`);
        try { await fetchConfiguredKeyModels(); } catch {}
        return;
      }
      await loadAIConfig();
    }
  };
  await tick();
  aiAuthTaskTimer = setInterval(tick, 1000);
}

/** 在 OAuth 卡片区域显示活跃的授权信息（链接+授权码+重新授权按钮） */
function _showActiveOAuthInCard() {
  if (!_activeOAuthState) return;
  const { url, userCode } = _activeOAuthState;
  const guideEl = $('ai-oauth-guide');
  const statusEl = $('ai-oauth-status');
  const oauthBtn = $('btn-ai-oauth-login');
  if (statusEl) statusEl.textContent = '⏳ 等待用户完成授权…';
  if (oauthBtn) { oauthBtn.disabled = true; oauthBtn.textContent = '授权进行中…'; }
  if (guideEl) {
    const linkHtml = `<a href="${url}" target="_blank" rel="noopener" style="color:#58a6ff;text-decoration:underline;font-weight:bold;font-size:14px">👉 点击此处打开 GitHub 授权页面</a>`;
    const codeHtml = userCode ? `<div style="margin-top:10px;font-size:20px;font-weight:bold;color:#f5f5f7;letter-spacing:4px;text-align:center;padding:10px 16px;background:#2d333b;border-radius:8px;border:1px solid #444c56">授权码: ${userCode}</div>` : '';
    const hintHtml = `<div style="margin-top:8px;font-size:12px;color:#8b949e">请点击上方链接，在 GitHub 页面中输入授权码完成认证</div>`;
    const reAuthHtml = `<div style="margin-top:12px;text-align:center"><button class="btn btn-secondary" id="_btn-reauth" style="font-size:12px">🔄 重新授权</button></div>`;
    guideEl.innerHTML = `<div style="padding:4px 0">${linkHtml}${codeHtml}${hintHtml}${reAuthHtml}</div>`;
    // 绑定重新授权按钮
    const reAuthBtn = document.getElementById('_btn-reauth');
    if (reAuthBtn) reAuthBtn.addEventListener('click', () => {
      _activeOAuthState = null;
      _restoreOAuthCard(false);
      startOAuthLogin();
    });
  }
}

/** 恢复 OAuth 卡片区域到初始状态 */
function _restoreOAuthCard(success) {
  const statusEl = $('ai-oauth-status');
  const guideEl = $('ai-oauth-guide');
  const oauthBtn = $('btn-ai-oauth-login');
  if (oauthBtn) { oauthBtn.disabled = false; oauthBtn.textContent = '启动设备授权'; }
  if (statusEl) statusEl.textContent = success ? '✅ 授权成功，可再次点击刷新授权' : '点击按钮启动设备授权流程';
  // 清除活跃状态
  if (success || !_activeOAuthState) _activeOAuthState = null;
  // 恢复 guide 内容
  const provider = $('ai-provider')?.value || '';
  const config = AI_PROVIDERS[provider] || {};
  if (guideEl && config.oauthGuide) guideEl.innerHTML = config.oauthGuide;
}

async function startOAuthLogin() {
  const provider = $('ai-provider')?.value || '';
  appendAiAuthLog(`[auth] 启动 ${provider} OAuth 登录...`);
  // 更新 OAuth 卡片状态为"正在启动"
  const statusEl = $('ai-oauth-status');
  if (statusEl) statusEl.textContent = '正在启动授权…';

  try {
    const r = await api('/api/ai/auth/oauth/login', { method:'POST', body: { provider } });
    if (!r.success || !r.taskId) {
      toast('启动失败', r.error || '无法启动 OAuth 登录');
      appendAiAuthLog(`[auth] 启动失败: ${r.error || '未返回 taskId'}`, 'error');
      if (statusEl) statusEl.textContent = '启动失败，请重试';
      return;
    }
    appendAiAuthLog(`[auth] OAuth 任务已启动: ${r.taskId}`);
    pollAiAuthTask(r.taskId);
  } catch (e) {
    appendAiAuthLog(`[auth] 错误: ${e.message}`, 'error');
    if (statusEl) statusEl.textContent = '出错，请重试';
  }
}

// 事件监听
$('ai-provider')?.addEventListener('change', updateAiProviderUI);
$('btn-ai-load')?.addEventListener('click', loadAIConfig);
$('btn-ai-oauth-login')?.addEventListener('click', startOAuthLogin);
$('btn-ai-save')?.addEventListener('click', saveAIConfig);
$('btn-ai-add-key')?.addEventListener('click', addAiKey);
$('ai-configured-select')?.addEventListener('change', onConfiguredKeySelected);
$('btn-ai-configured-fetch')?.addEventListener('click', fetchConfiguredKeyModels);
$('btn-ai-configured-delete')?.addEventListener('click', deleteConfiguredKey);

// 记录最后聚焦的模型输入框
['ai-model-primary','ai-model-primary-fallback','ai-model-sub','ai-model-sub-fallback'].forEach(id => {
  $(id)?.addEventListener('focus', () => { lastFocusedModelInput = id; });
});

// 初始化
updateAiProviderUI();
// ------------------------
// Messaging – load / save (refactored to match openclaw.json schema)
// Feishu: channels.feishu.accounts.main.{appId,appSecret,botName,...}
// Discord: channels.discord.{token,guildId,groupPolicy,streaming,historyLimit,dmHistoryLimit}
// ------------------------
async function loadMessagingConfig(){
  appendMsgLog('[load] 正在读取消息平台配置...');
  const cfg = await api('/api/config');
  if (cfg.error) {
    appendMsgLog(`[load] 读取失败: ${cfg.error}`);
    return;
  }
  const c = cfg.channels || {};

  const setBoolSelect = (id, v) => { if ($(id)) $(id).value = String(!!v); };
  const setVal = (id, v) => { if ($(id)) $(id).value = v ?? ''; };

  // -- 飞书 (nested: accounts.default, fallback accounts.main) with flat fallback --
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
  // 多服务器模式：优先展示标准 guilds，兼容历史 guildId
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
  appendMsgLog('[load] 配置读取完成');
}

$('btn-msg-load')?.addEventListener('click', loadMessagingConfig);

$('btn-discord-approve-pairing')?.addEventListener('click', async ()=>{
  const input = $('discord-pairing-code');
  const button = $('btn-discord-approve-pairing');
  const code = String(input?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code || !/^[A-Z0-9]{6,32}$/.test(code)) {
    setDiscordPairingResult('请输入有效的 Discord 配对码。', 'error');
    toast('审批失败', '配对码格式无效');
    return;
  }

  if (button) button.disabled = true;
  setDiscordPairingResult('正在审批 Discord 配对码...', 'info');
  appendMsgLog(`[discord] 正在审批配对码 ${code}...`);
  const result = await api('/api/openclaw/pairing/approve-discord', {
    method: 'POST',
    body: { code },
    timeoutMs: 45000
  });
  if (button) button.disabled = false;

  if (result.success) {
    if (input) input.value = '';
    setDiscordPairingResult(result.message || `配对码 ${code} 已批准。`, 'success');
    appendMsgLog(`[discord] ${result.message || `配对码 ${code} 已批准`}`);
    toast('审批成功', result.message || `配对码 ${code} 已批准`);
    await loadDiscordRuntimeStatus();
    return;
  }

  setDiscordPairingResult(result.error || '审批失败', 'error');
  appendMsgLog(`[discord] 审批失败: ${result.error || 'unknown'}`);
  toast('审批失败', result.error || 'unknown');
  await loadDiscordRuntimeStatus();
});

// 重启 Gateway 生效
$('btn-msg-restart')?.addEventListener('click', async ()=>{
  appendMsgLog('[restart] 正在重启 Gateway...');
  const r = await api('/api/openclaw/start', { method:'POST' });
  toast(r.success ? 'Gateway 已重启' : '重启失败', r.error || '');
  appendMsgLog(r.success ? '[restart] Gateway 重启成功' : `[restart] Gateway 重启失败: ${r.error || 'unknown'}`);
  if (r.success && $('btn-msg-restart')) $('btn-msg-restart').style.display = 'none';
});

qa('[data-save-msg]').forEach(btn => {
  btn.addEventListener('click', async ()=>{
    const platform = btn.getAttribute('data-save-msg');
    appendMsgLog(`[save] 开始保存 ${platform} 配置...`);
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
      // OpenClaw 官方 schema：使用 guilds（多服务器）
      update.channels.discord.guilds = Object.fromEntries(guildIds.map((id) => [id, {}]));
      // 标记后端执行完整替换，避免 deepMerge 残留旧服务器
      update.channels.discord.__replaceGuilds = true;
      appendMsgLog(`[save] Discord 服务器数: ${guildIds.length}`);
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
      toast('保存成功', `已写入 channels.${saved}，需重启 Gateway 生效`);
      appendMsgLog(`[save] 保存成功: channels.${saved}`);
      if ($('btn-msg-restart')) $('btn-msg-restart').style.display = '';
    } else {
      appendMsgLog(`[save] 保存失败: ${r.error || 'unknown'}`);
      toast('保存失败', r.error || '');
    }
  });
});

// ------------------------
// 远端设备管理 (Node 模式)
// ------------------------
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

async function loadDeviceManagement(forceConnectedRefresh = false) {
  if (window.__deviceMgmtRefreshing) return;
  window.__deviceMgmtRefreshing = true;
  try {
  // 并行加载: setup command + pairing list + security config + connected nodes
  const [cmdRes, pairRes, secRes, connRes] = await Promise.all([
    api('/api/node/setup-command'),
    api('/api/openclaw/pairing/list'),
    api('/api/node/security'),
    api(`/api/node/connected${forceConnectedRefresh ? '?force=1' : ''}`)
  ]);

  // 快速连接命令
  const cmdEl = $('device-setup-command');
  const cmdWinEl = $('device-setup-command-win');
  const cmdBgEl = $('device-setup-command-bg');
  const cmdWinBgEl = $('device-setup-command-win-bg');
  const cmdNoteEl = $('device-setup-command-note');
  if (cmdEl) {
    if (cmdRes.success && cmdRes.hasToken) {
      cmdEl.textContent = cmdRes.command;
    } else {
      cmdEl.textContent = cmdRes.command || '# 加载失败';
    }
  }
  if (cmdWinEl) {
    if (cmdRes.success && cmdRes.hasToken && cmdRes.commandWindows) {
      cmdWinEl.textContent = cmdRes.commandWindows;
    } else {
      cmdWinEl.textContent = '# Windows 命令加载失败';
    }
  }
  if (cmdBgEl) {
    if (cmdRes.success && cmdRes.hasToken && cmdRes.bgCmd) {
      cmdBgEl.textContent = cmdRes.bgCmd;
    } else {
      cmdBgEl.textContent = '# 后台命令加载失败';
    }
  }
  if (cmdWinBgEl) {
    if (cmdRes.success && cmdRes.hasToken && cmdRes.bgCmdWindows) {
      cmdWinBgEl.textContent = cmdRes.bgCmdWindows;
    } else {
      cmdWinBgEl.textContent = '# Windows 后台命令加载失败';
    }
  }
  if (cmdNoteEl) {
    const noteParts = [];
    noteParts.push(cmdRes.tlsNote || '命令会根据当前 HTTPS 配置决定是否保留 NODE_TLS_REJECT_UNAUTHORIZED=0；无法可靠判断时会保守保留。');
    if (cmdRes.nodeBgDir) {
      noteParts.push(`后台模式会为当前网关使用独立目录 ${cmdRes.nodeBgDir}，不同网关可同时运行。`);
    }
    cmdNoteEl.textContent = noteParts.join(' ');
  }

  // 在线节点列表
  renderConnectedNodes(connRes);

  // 配对审批列表
  renderPairingList(pairRes);

  // 已配对设备列表
  renderPairedList(pairRes, connRes);

  // 安全配置
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
    listEl.innerHTML = '<div class="muted small">读取失败: ' + esc(r?.error || '') + '</div>';
    return;
  }
  const nodes = r.nodes || [];
  if (!nodes.length) {
    listEl.innerHTML = '<div class="muted small" style="color:#8b949e">暂无已配对的 Node 节点</div>';
    return;
  }
  listEl.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<tr style="border-bottom:1px solid #30363d;color:#8b949e;font-size:12px">' +
    '<th style="text-align:left;padding:6px 8px">状态</th>' +
    '<th style="text-align:left;padding:6px 8px">名称</th>' +
    '<th style="text-align:left;padding:6px 8px">平台</th>' +
    '<th style="text-align:left;padding:6px 8px">IP</th>' +
    '<th style="text-align:left;padding:6px 8px">时间</th>' +
    '</tr>' +
    nodes.map(n => {
      const statusDot = n.connected
        ? '<span style="color:#3fb950" title="在线">●</span>'
        : '<span style="color:#f85149" title="离线">●</span>';
      const statusText = n.connected ? '在线' : '离线';
      const statusTimeMs = n.connected ? n.connectedAtMs : n.offlineAtMs;
      const timeLabel = n.connected ? '连接时间' : '离线时间';
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
    listEl.innerHTML = '<div class="muted small">读取失败: ' + esc(r?.error || '') + '</div>';
    return;
  }
  const pending = r.pending || [];
  if (!pending.length) {
    listEl.innerHTML = '<div class="muted small" style="color:#8b949e">暂无待审批的配对请求</div>';
    return;
  }
  listEl.innerHTML = pending.map((p) => {
    const age = Math.round((Date.now() - (p.ts || 0)) / 1000);
    const ageStr = age < 60 ? age + '秒前' : Math.round(age / 60) + '分钟前';
    const name = esc(p.displayName || p.clientId || '未知设备');
    const plat = esc(friendlyPlatform(p.platform));
    const mode = esc(p.clientMode || 'operator');
    const role = esc(p.role || 'operator');
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#1a1a2e;border-radius:6px;margin-bottom:4px">'
      + '<span style="flex:1;font-size:12px"><b>' + name + '</b>'
      + (plat ? ' <span class="muted small">(' + plat + ')</span>' : '')
      + ' · <span class="muted small">' + mode + '</span>'
      + ' · <span class="muted small">' + role + '</span>'
      + ' · <span class="muted small">' + ageStr + '</span></span>'
      + '<button class="btn btn-primary" style="font-size:12px;padding:2px 12px" data-approve-id="' + esc(p.requestId) + '">审批通过</button>'
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
    listEl.innerHTML = '<div class="muted" style="text-align:center;padding:20px;color:#ff453a">加载失败</div>';
    return;
  }
  const paired = r.paired || [];
  const connectedIndex = buildConnectedNodeIndex(connRes);
  if (!paired.length) {
    listEl.innerHTML = '<div class="muted" style="text-align:center;padding:20px">暂无已配对设备</div>';
    return;
  }
  listEl.innerHTML = paired.map((d) => {
    const name = esc(d.displayName || d.clientId || '未知');
    const plat = esc(friendlyPlatform(d.platform));
    const mode = esc(d.clientMode || 'operator');
    const roles = (d.roles || [d.role || 'operator']).map(esc).join(', ');
    const time = d.approvedAtMs ? new Date(d.approvedAtMs).toLocaleString() : '—';
    const devId = esc(d.deviceId || '');
    const liveNode = connectedIndex.get(d.deviceId || '') || null;
    const isConnected = Boolean(liveNode?.connected);
    const liveStatus = isConnected
      ? '<span class="muted small" style="color:#3fb950">在线，取消配对后当前会话会失效；远端后台进程不会自动退出</span>'
      : '<span class="muted small">离线，取消配对仅删除配对记录</span>';
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap">'
      + `<span style="color:${isConnected ? '#3fb950' : '#8b949e'};font-size:14px">●</span>`
      + '<b style="min-width:80px">' + name + '</b>'
      + (plat ? '<span class="muted small">(' + plat + ')</span>' : '')
      + '<span class="muted small">' + mode + '</span>'
      + '<span class="muted small">角色: ' + roles + '</span>'
      + '<span class="muted small">审批于: ' + time + '</span>'
      + liveStatus
      + '<span style="flex:1"></span>'
      + '<code class="muted small" title="Device ID">' + devId.slice(0, 8) + '…</code>'
      + '<button class="btn btn-sm btn-danger" data-unpair-id="' + devId + '" style="font-size:11px;padding:2px 8px">取消配对</button>'
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
  btn.disabled = true; btn.textContent = '审批中...';
  if (resultEl) { resultEl.textContent = ''; resultEl.style.color = ''; }
  try {
    const r = await api('/api/openclaw/pairing/approve', { method: 'POST', body: { requestId } });
    if (r.success) {
      if (resultEl) { resultEl.textContent = '✅ 审批成功 (deviceId: ' + (r.deviceId || '').slice(0, 8) + '…)'; resultEl.style.color = '#30d158'; }
      setTimeout(() => loadDeviceManagement(), 500);
    } else {
      if (resultEl) { resultEl.textContent = '❌ ' + (r.error || '审批失败'); resultEl.style.color = '#ff453a'; }
    }
  } catch (e) {
    if (resultEl) { resultEl.textContent = '❌ 网络错误'; resultEl.style.color = '#ff453a'; }
  } finally {
    btn.disabled = false; btn.textContent = '审批通过';
  }
}

async function unpairDevice(deviceId, opts = {}) {
  const connected = opts.connected === true;
  const targetName = String(opts.displayName || '').trim();
  const label = targetName ? `“${targetName}”` : '该设备';
  const message = connected
    ? `确定取消${label}的配对吗？\n\n该节点当前在线，确认后会删除配对关系，当前连接会失效。\n如果远端是后台运行，远端命令不会自动退出，仍会继续重试连接。`
    : `确定取消${label}的配对吗？\n\n该设备当前离线，确认后只会删除配对关系。`;
  if (!confirm(message)) return;
  const r = await api('/api/node/unpair', { method: 'POST', body: { deviceId } });
  if (r.success) {
    toast(r.disconnected ? '已取消配对；当前连接已失效，远端后台命令需手动停止或重新配对' : '已取消配对');
    loadDeviceManagement();
  } else {
    toast('操作失败', r.error || '');
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

// 复制快速连接命令
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
    label = 'Windows 后台运行';
  } else if (isBgVisible) {
    text = bgEl?.textContent || '';
    label = '后台运行';
  } else if (isWinVisible) {
    text = winEl?.textContent || '';
    label = 'Windows PowerShell';
  } else {
    text = linuxEl?.textContent || '';
    label = 'Linux/macOS';
  }
  navigator.clipboard.writeText(text).then(
    () => toast(`已复制 ${label} 连接命令`),
    () => toast('复制失败')
  );
});

// 刷新
$('btn-device-refresh')?.addEventListener('click', () => loadDeviceManagement(true));
$('btn-pairing-refresh')?.addEventListener('click', () => loadDeviceManagement(true));
$('btn-connected-refresh')?.addEventListener('click', () => loadDeviceManagement(true));

// 保存安全配置
$('btn-device-save-security')?.addEventListener('click', async () => {
  const autoApprove = ($('device-auto-approve')?.value || 'false') === 'true';
  const browserMode = $('device-browser-mode')?.value || 'auto';
  const execSecurity = $('device-exec-security')?.value || 'full';
  const denyCommands = ($('device-deny-commands')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);

  const r = await api('/api/node/security', { method: 'POST', body: { autoApprove, browserMode, execSecurity, denyCommands } });
  if (r.success) {
    toast('安全配置已保存', '部分配置需重启 Gateway 生效');
    if ($('btn-device-restart-gw')) $('btn-device-restart-gw').style.display = '';
  } else {
    toast('保存失败', r.error || '');
  }
});

// 重启 Gateway
$('btn-device-restart-gw')?.addEventListener('click', async () => {
  const r = await api('/api/openclaw/start', { method: 'POST' });
  toast(r.success ? 'Gateway 已重启' : '重启失败', r.error || '');
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
  if (source === 'bundled') return '<span style="background:#e3f2fd;color:#1565c0;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px">内置</span>';
  if (source === 'managed') return '<span style="background:#e8f5e9;color:#2e7d32;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px">用户安装</span>';
  if (source.startsWith('ext:')) return `<span style="background:#e8eaf6;color:#283593;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px">扩展</span><span style="background:#fff3e0;color:#e65100;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:3px">${escapeHtml(source.slice(4))}</span>`;
  return '';
}

function skillCard(s) {
  const secBadge = s.securityWarnings > 0
    ? '<span style="background:#fff3e0;color:#e65100;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px" title="' + escapeHtml((s.securityDetails || []).join('; ')) + '">\u26A0 \u6CE8\u610F</span>'
    : '';
  const secDetail = s.securityWarnings > 0 && (s.securityDetails || []).length
    ? `<div class="muted small" style="color:#ffa726;margin-top:2px">\u26A0 ${escapeHtml(s.securityDetails.join('; '))}</div>`
    : '';
  return `
    <div class="card" style="margin-bottom:10px;padding:10px 14px${s.securityWarnings > 0 ? ';border-left:3px solid #ff9800' : ''}">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700">${escapeHtml(s.name)}${skillSourceBadge(s.source)}${secBadge}</div>
          ${s.description ? `<div class="muted small" style="margin-top:2px">${escapeHtml(s.description)}</div>` : ''}
          ${secDetail}
        </div>
        ${s.source === 'managed' ? `<button class="btn" style="font-size:12px;padding:2px 10px;white-space:nowrap" data-skill-remove="${escapeHtml(s.name)}">移除</button>` : ''}
      </div>
    </div>`;
}

function scanSkillCard(s, idx) {
  // Match with installed skills
  const installed = _installedSkills.find(i => i.name === s.dirName);
  // Only show "has update" when content changed AND installed skill is NOT user-managed
  // (user-managed skills with same name are likely custom/unrelated; avoid false-positive update prompts)
  const contentDiffers = installed && s.contentHash && installed.contentHash && s.contentHash !== installed.contentHash && s.dirName === installed.name;
  const hasUpdate = contentDiffers && installed.source !== 'managed';
  const nameConflict = contentDiffers && installed.source === 'managed';
  const isLocalScan = !!s._localScan;
  let statusBadge = '';
  if (installed && hasUpdate) {
    statusBadge = '<span style="color:#ff9800;font-size:11px;margin-left:6px;font-weight:700">↑ 有更新</span>';
  } else if (nameConflict) {
    statusBadge = '<span style="color:#ff9800;font-size:11px;margin-left:6px">⚠ 同名已安装 (自定义)</span>';
  } else if (installed && isLocalScan) {
    statusBadge = '<span style="color:#2196f3;font-size:11px;margin-left:6px">⟳ 已安装 (可覆盖)</span>';
  } else if (installed) {
    statusBadge = '<span style="color:#4caf50;font-size:11px;margin-left:6px">✓ 已安装</span>';
  } else if (!s.valid) {
    statusBadge = '<span style="color:#f44;font-size:11px;margin-left:6px">✗ 无效</span>';
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
        <button class="btn" style="font-size:12px;padding:2px 10px" data-ext-remove="${escapeHtml(ext.name)}">卸载</button>
      </div>
    </div>`;
}

async function refreshPlugins() {
  const d = await api('/api/plugins/list');
  if (d.error) return toast('加载失败', d.error);

  const skillsList = d.skills || [];
  const extsList = d.extensions || [];
  _installedSkills = skillsList; // cache for comparison

  // Separate managed skills from bundled and extension
  const userSkills = skillsList.filter(s => s.source === 'managed');
  const extSkills = skillsList.filter(s => s.source && s.source.startsWith('ext:'));
  const bundledSkills = skillsList.filter(s => s.source === 'bundled');

  function skillGroupHtml(label, skills, collapsed) {
    const arrow = collapsed ? '\u25B6' : '\u25BC';
    const display = collapsed ? 'none' : '';
    return `<div style="margin-top:12px;border-top:1px solid #333;padding-top:10px">
      <div style="cursor:pointer;user-select:none;color:#8e8e93;font-size:13px" onclick="const c=this.nextElementSibling;const a=c.style.display==='none';c.style.display=a?'':'none';this.querySelector('span').textContent=a?'\u25BC':'\u25B6'">
        <span>${arrow}</span> ${label} (${skills.length})
      </div>
      <div style="display:${display};margin-top:8px">${skills.map(skillCard).join('')}</div>
    </div>`;
  }

  let html = '';
  if (userSkills.length) {
    html += skillGroupHtml('\u7528\u6237\u5B89\u88C5', userSkills, false);
  } else {
    html += '<div class="muted small" style="padding:12px 0">暂无用户安装的 Skill。</div>';
  }
  if (extSkills.length) {
    html += skillGroupHtml('\u6269\u5C55 Skills', extSkills, true);
  }
  if (bundledSkills.length) {
    html += skillGroupHtml('\u5185\u7F6E Skills', bundledSkills, true);
  }
  $('skills-list').innerHTML = html;

  $('extensions-list').innerHTML = extsList.length
    ? extsList.map(extensionCard).join('')
    : '<div class="muted small" style="padding:12px 0">暂无用户额外安装的 Extension。OpenClaw 内置的 40+ Extensions 已自动加载。</div>';
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
  if (!skillMdFile) { errors.push('缺少 SKILL.md 文件'); return { valid: false, errors, warnings }; }
  for (const pat of SKILL_DANGEROUS_PATTERNS_CLIENT) {
    if (pat.test(skillMdFile.textContent || '')) warnings.push(`SKILL.md 包含可疑模式: ${pat.source}`);
  }
  for (const f of files) {
    const ext = '.' + f.path.split('.').pop().toLowerCase();
    if (SKILL_SUSPICIOUS_EXTS.includes(ext)) warnings.push(`包含脚本文件: ${f.path}`);
    if (f.size > 5 * 1024 * 1024) warnings.push(`大文件 (>${Math.round(f.size / 1048576)}MB): ${f.path}`);
    if (f.path !== 'SKILL.md' && f.path.endsWith('.md')) {
      for (const pat of SKILL_DANGEROUS_PATTERNS_CLIENT) {
        if (pat.test(f.textContent || '')) { warnings.push(`${f.path} 包含可疑模式: ${pat.source}`); break; }
      }
    }
  }
  if (files.length > 200) warnings.push(`目录包含过多文件 (>${files.length})`);
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
  if (pre) pre.textContent += `找到 ${skills.length} 个 Skill\n`;
  if (skills.length === 0) {
    if (pre) pre.textContent += '该源中未找到包含 SKILL.md 的目录\n';
    $('skill-scan-results').style.display = 'none';
    return;
  }
  // Mark installed state
  for (const s of _scanResults) {
    s.installed = _installedSkills.some(i => i.name === s.dirName);
  }
  $('skill-scan-title').textContent = `扫描结果 — 共 ${skills.length} 个 Skill`;
  $('skill-scan-list').innerHTML = _scanResults.map((s, i) => scanSkillCard(s, i)).join('');
  $('skill-scan-results').style.display = '';
  if (logEl) logEl.style.display = 'none';
}

// Scan from GitHub URL
$('btn-skill-scan')?.addEventListener('click', async () => {
  const input = $('skill-url-input');
  const source = (input?.value || '').trim();
  if (!source) return toast('请输入', '请输入 GitHub URL');

  const logEl = $('skill-install-log');
  const pre = logEl?.querySelector('pre');
  logEl.style.display = '';
  pre.textContent = '正在扫描...\n';

  const btn = $('btn-skill-scan');
  btn.disabled = true;
  btn.textContent = '扫描中...';
  _scanIsLocal = false;

  try {
    // Refresh installed list first
    const list = await api('/api/plugins/list');
    if (list.skills) _installedSkills = list.skills;

    const r = await api('/api/plugins/skill/scan', { method: 'POST', body: { source }, timeoutMs: 180000 });
    if (r.error) {
      pre.textContent += `错误: ${r.error}\n`;
      toast('扫描失败', r.error);
      return;
    }
    showScanResults(r.skills || [], logEl);
  } catch (e) {
    pre.textContent += `错误: ${e.message}\n`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 扫描';
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
  pre.textContent = `正在扫描本地目录: ${label}\n`;
  _scanIsLocal = true;

  const btn = $('btn-skill-browse');
  btn.disabled = true;
  btn.textContent = '扫描中...';

  try {
    const list = await api('/api/plugins/list');
    if (list.skills) _installedSkills = list.skills;

    pre.textContent += '正在读取文件并进行安全扫描...\n';
    const skills = await getSkills();

    const warnCount = skills.reduce((n, s) => n + (s.warnings?.length || 0), 0);
    const invalidCount = skills.filter(s => !s.valid).length;
    if (warnCount > 0) pre.textContent += `⚠ 安全扫描: ${warnCount} 条警告\n`;
    if (invalidCount > 0) pre.textContent += `✗ ${invalidCount} 个无效 Skill\n`;
    if (warnCount === 0 && invalidCount === 0 && skills.length > 0) pre.textContent += '✓ 安全扫描通过\n';

    showScanResults(skills, logEl);
  } catch (e) {
    pre.textContent += `错误: ${e.message}\n`;
  } finally {
    btn.disabled = false;
    btn.textContent = '📂 本地目录';
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
      toast('选择失败', e.message);
      return;
    }
    await handleLocalDirScan(() => browserScanDirectory(dirHandle), dirHandle.name);
  } else {
    // Safari / Firefox fallback: use hidden <input webkitdirectory>
    const input = $('skill-dir-fallback');
    if (!input) {
      toast('不支持', '当前浏览器不支持目录选择');
      return;
    }
    input.value = '';
    input.onchange = async () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      const label = files[0]?.webkitRelativePath?.split('/')[0] || '本地目录';
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

  if (selected.length === 0) return toast('请选择', '请勾选要安装的 Skills');

  const logEl = $('skill-install-log');
  const pre = logEl?.querySelector('pre');
  logEl.style.display = '';
  pre.textContent = `正在安装 ${selected.length} 个 Skill...\n`;

  const btn = $('btn-skill-install-selected');
  btn.disabled = true;
  btn.textContent = '安装中...';

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
        const label = item.updated ? '更新成功' : '安装成功';
        pre.textContent += `${icon} ${item.name}: ${item.success ? label : item.error}`;
        if (item.warnings?.length) pre.textContent += ` ⚠ ${item.warnings.join('; ')}`;
        pre.textContent += '\n';
      }
    }

    if (r.installed > 0) {
      toast('安装完成', `成功安装 ${r.installed}/${r.total} 个 Skill，重启 Gateway 后生效`);
      $('skill-scan-results').style.display = 'none';
      _scanResults = [];
      refreshPlugins();
    } else {
      toast('安装失败', r.error || '未成功安装任何 Skill');
    }
  } catch (e) {
    pre.textContent += `错误: ${e.message}\n`;
  } finally {
    btn.disabled = false;
    btn.textContent = '安装选中';
  }
});

// Install Extension from npm
$('btn-ext-install')?.addEventListener('click', async () => {
  const input = $('ext-npm-input');
  const pkg = (input?.value || '').trim();
  if (!pkg) return toast('请输入', '请输入 npm 包名');

  const logEl = $('ext-install-log');
  const pre = logEl?.querySelector('pre');
  logEl.style.display = '';
  pre.textContent = '正在安装...\n';

  const btn = $('btn-ext-install');
  btn.disabled = true;
  btn.textContent = '安装中...';

  try {
    const r = await api('/api/plugins/extension/install', { method: 'POST', body: { package: pkg }, timeoutMs: 120000 });
    pre.textContent += (r.output || r.error || (r.success ? '安装成功' : '未知错误')) + '\n';
    if (r.success) {
      toast('安装成功', `Extension 已安装，重启 Gateway 后生效`);
      input.value = '';
      refreshPlugins();
    } else {
      toast('安装失败', r.error || '');
    }
  } catch (e) {
    pre.textContent += `错误: ${e.message}\n`;
  } finally {
    btn.disabled = false;
    btn.textContent = '安装 Extension';
  }
});

// Remove skill
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-skill-remove]');
  if (!btn) return;
  const name = btn.getAttribute('data-skill-remove');
  if (!confirm(`确认移除 Skill "${name}"？`)) return;
  btn.disabled = true;
  btn.textContent = '移除中...';
  const r = await api('/api/plugins/skill/remove', { method: 'POST', body: { name } });
  toast(r.success ? '已移除' : '移除失败', r.error || '');
  refreshPlugins();
});

// Remove extension
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ext-remove]');
  if (!btn) return;
  const name = btn.getAttribute('data-ext-remove');
  if (!confirm(`确认卸载 Extension "${name}"？`)) return;
  btn.disabled = true;
  btn.textContent = '卸载中...';
  const r = await api('/api/plugins/extension/remove', { method: 'POST', body: { name }, timeoutMs: 60000 });
  toast(r.success ? '已卸载' : '卸载失败', r.error || '');
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
    if (s === '[terminal] 已连接（PTY）。直接在此区域输入命令并按回车执行。') return false;
    if (s === 'OpenClaw Terminal connected (PTY). 输入命令并回车执行。') return false;
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
  $('term-state').textContent = '未连接';
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
  $('term-state').textContent = 'SSE 模式连接中...';
  termAppendText('\n[terminal] WebSocket 不可用，正在切换 SSE 交互模式...\n');

  const es = new EventSource('/api/terminal/stream');
  termSseSource = es;

  es.onopen = () => {
    $('term-state').textContent = 'SSE 已连接';
  };

  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'connected') {
        $('term-state').textContent = 'SSE 已连接';
        termAppendText('[terminal] SSE 交互终端已连接。\n');
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
    $('term-state').textContent = 'SSE 断开';
    closeSseTerminal();
    termAppendText('\n[terminal] SSE 连接断开，3秒后重试...\n');
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
  termAppendText(`\n[terminal] WebSocket 交互连接不可用${reason ? ` (${reason})` : ''}，尝试 SSE 模式...\n`);
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

  $('term-state').textContent = '连接中...';
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
        $('term-state').textContent = '连接超时，切换日志模式';
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
      $('term-state').textContent = 'WebSocket 不可用';
      termAppendText(`[terminal] WebSocket 不可用，无法建立交互会话 (${attemptLabel})\n`);
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
      $('term-state').textContent = '已连接';

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
      $('term-state').textContent = code === 1008 ? '认证失效' : '已断开';
      termAppendText(`\n[terminal] 连接已断开 (code=${code}${reason}) [${attemptLabel}].\n`);

      if (code === 1008) {
        termWsToken = null;
        if (!retriedWithCookie) {
          retriedWithCookie = true;
          termAppendText('[terminal] token 鉴权失败，正在尝试 cookie 认证链路...\n');
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
        $('term-state').textContent = '重连中...';
      }
    };

    socket.onerror = ()=> {
      if (socket !== termWs) return;
      clearConnectTimeout();
      termConnectInFlight = false;
      termFailureCount += 1;
      $('term-state').textContent = '连接错误';
      termAppendText(`\n[terminal] 连接错误 [${attemptLabel}]。\n`);
      if (attemptLabel === 'token-auth') {
        termWsToken = null;
      }
      if (termFailureCount >= 2) {
        startTerminalFallback('网络或代理异常');
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
// 页面加载时检测 localStorage 中残留的"等待重启"日志，若 Gateway 已恢复则补偿完成消息
(function reconcileStaleRestartLog() {
  const logEl = $('oc-log');
  if (!logEl) return;
  const text = logEl.textContent || '';
  const hasWaiting = text.includes('等待 Gateway 启动完成');
  const hasResult = text.includes('Gateway 重启成功') || text.includes('Gateway 重启超时') || text.includes('停止轮询');
  if (hasWaiting && !hasResult) {
    api('/api/openclaw', { timeoutMs: 10000 }).then(st => {
      if (st && !st.error && st.gatewayRunning) {
        appendOcLogLine('✅ Gateway 已恢复运行（页面刷新后检测）');
      } else if (st && !st.error && !st.gatewayRunning) {
        appendOcLogLine('⚠️ Gateway 当前未运行，请检查状态');
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

  if (!oldPassword) return toast('缺少参数', '请输入当前密码');
  if (!newPassword || newPassword.length < 8) return toast('参数错误', '新密码至少 8 位');
  if (newPassword !== confirm) return toast('参数错误', '两次密码不一致');

  const r = await api('/api/password', { method:'POST', body:{ oldPassword, newPassword } });
  if (r.success){
    toast('密码已修改', '请重新登录');
    setTimeout(()=> location.href='/login.html', 800);
  }else{
    toast('修改失败', r.error || '');
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
