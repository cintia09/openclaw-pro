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

// ------------------------
// API helper
// ------------------------
async function api(url, opts={}){
  const timeoutMs = Number(opts.timeoutMs || 15000);
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

// ------------------------
// Toast
// ------------------------
let toastTimer = null;
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function colorizeLine(rawLine){
  const line = stripAnsi(String(rawLine ?? ''));
  const dateLike = /^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
  let safe = escapeHtml(line);

  if (/^\s*(\$|#)\s+/.test(line)) {
    safe = `<span class="term-cmd">${safe}</span>`;
  } else if (/\b(ERROR|Error|ERR|failed|失败|异常|fatal)\b/.test(line)) {
    safe = `<span class="term-error">${safe}</span>`;
  } else if (/\b(WARN|Warning|timeout|超时|占用|冲突)\b/i.test(line)) {
    safe = `<span class="term-warn">${safe}</span>`;
  } else if (/\b(INFO|started|listening|connected|完成|成功|已启动)\b/i.test(line)) {
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

function appendColored(el, text, maxLines = 5000, autoscroll = true){
  if (!el) return;
  const html = stripAnsi(String(text ?? '')).split('\n').map(colorizeLine).join('');
  el.insertAdjacentHTML('beforeend', html);
  const nodes = el.querySelectorAll('.term-line');
  if (nodes.length > maxLines) {
    for (let i = 0; i < nodes.length - maxLines; i++) nodes[i].remove();
  }
  if (autoscroll) el.scrollTop = el.scrollHeight;
}

function setColored(el, text, maxLines = 5000, autoscroll = true){
  if (!el) return;
  el.innerHTML = '';
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

// ------------------------
// Router / navigation
// ------------------------
const ROUTES = [
  { id: 'dashboard', title: '仪表盘' },
  { id: 'openclaw-engine', title: 'OpenClaw 控制台' },
  { id: 'openclaw-ai', title: 'AI 模型配置' },
  { id: 'messaging', title: '消息平台' },
  { id: 'trading', title: '交易系统' },
  { id: 'plugins', title: '插件市场' },
  { id: 'browser', title: '浏览器' },
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
  const isOpenClawRoute = route === 'openclaw-engine' || route === 'openclaw-ai';

  // nav active
  qa('#nav a').forEach(a => {
    const itemRoute = a.dataset.route;
    const active = itemRoute === route || (isOpenClawRoute && itemRoute === 'openclaw-engine');
    a.classList.toggle('active', !!active);
  });
  // pages
  qa('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + route));
  qa('[data-oc-switch]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-oc-switch') === route);
  });
  // title
  const page = $('page-' + route);
  $('page-title').textContent = page?.dataset?.title || (ROUTES.find(r => r.id===route)?.title ?? '');

  // close sidebar on mobile
  $('sidebar').classList.remove('open');

  // hooks
  if (route === 'dashboard') refreshStatus();
  if (route === 'openclaw-engine') { refreshOpenClaw(); }
  if (route === 'openclaw-ai') { loadAIConfig(); }
  if (route === 'messaging') loadMessagingConfig();
  if (route === 'trading') refreshTrading();
  if (route === 'plugins') refreshPlugins();
  if (route === 'terminal') {
    terminalConnect();
    focusTerminalInput();
  }
  if (route === 'browser') loadBrowserFrame();
  if (route === 'settings') { loadBrowserSettings(); renderDetectedTimezone(); checkForUpdate(); }
  if (route === 'logs') refreshLogs();
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

function loadBrowserFrame(){
  const frame = $('browser-frame');
  if (!frame) return;
  const vncSrc = frame.dataset.vncSrc;
  if (vncSrc && frame.src !== location.origin + vncSrc) {
    frame.src = vncSrc;
  }
}

function setBrowserNavVisible(visible){
  const link = q('#nav a[data-route="browser"]');
  if (!link) return;
  link.style.display = visible ? '' : 'none';
}

async function loadBrowserSettings(){
  const d = await api('/api/docker-config');
  if (!d || d.error) return;
  if ($('settings-browser-enabled')) {
    $('settings-browser-enabled').value = String(!!d.browserEnabled);
  }
  setBrowserNavVisible(!!d.browserEnabled);
}

window.addEventListener('hashchange', ()=> setActiveRoute(getRouteFromHash()));

qa('[data-oc-switch]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const route = String(btn.getAttribute('data-oc-switch') || '').trim();
    if (!route) return;
    if (getRouteFromHash() === route) return;
    location.hash = route;
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (getRouteFromHash() !== 'terminal') return;
  if (termWs && termWs.readyState === WebSocket.OPEN) return;
  terminalConnect();
});

$('btn-gateway-console')?.addEventListener('click', (e) => {
  e.preventDefault();
  const popup = window.open('', '_blank');
  if (popup) {
    try { popup.opener = null; } catch {}
    popup.document.title = 'OpenClaw Gateway';
    popup.document.body.innerHTML = '<p style="font-family:system-ui;padding:16px;">正在打开 OpenClaw Gateway 控制台...</p>';
  }
  (async () => {
    const r = await api('/api/openclaw/gateway-link', { timeoutMs: 6000 });
    const target = r?.preferredUrl || r?.directUrl || r?.proxyUrl || '/gateway-proxy/';
    if (popup) {
      popup.location.href = target;
    } else {
      window.location.href = target;
      toast('弹窗被拦截', '已在当前页面打开 Gateway 控制台');
    }
    if (r?.hint) {
      toast('Gateway 提示', r.hint);
    }
  })();
});

// mobile sidebar
$('btn-hamburger').addEventListener('click', ()=> $('sidebar').classList.toggle('open'));
document.addEventListener('click', (e)=>{
  const sidebar = $('sidebar');
  if (!sidebar.classList.contains('open')) return;
  const btn = $('btn-hamburger');
  if (sidebar.contains(e.target) || btn.contains(e.target)) return;
  sidebar.classList.remove('open');
});

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

$('plugins-tabs')?.addEventListener('click', (e)=>{
  const t = e.target.closest('.tab');
  if (!t) return;
  const ptab = t.dataset.ptab;
  qa('#plugins-tabs .tab').forEach(x=> x.classList.toggle('active', x===t));
  $('plugins-skills').hidden = ptab !== 'skills';
  $('plugins-pro').hidden = ptab !== 'pro';
});

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

  $('kpi-gateway').innerHTML = s.gateway
    ? `<span class="pulse online"></span>在线`
    : `<span class="pulse offline"></span>离线`;
  const gatewayParts = [s.gateway ? '进程检测正常' : '未检测到进程'];
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
  $('kpi-gateway-sub').textContent = gatewayParts.join(' · ');

  $('kpi-caddy').innerHTML = s.caddy
    ? `<span class="pulse online"></span>在线`
    : `<span class="pulse offline"></span>离线/未启用`;
  $('kpi-domain').textContent = s.domain ? `域名：${s.domain}` : '未配置域名';

  $('kpi-memory').textContent = s.memory?.total ? `${s.memory.used}/${s.memory.total}MB (${s.memory.percent}%)` : '—';
  $('kpi-uptime').textContent = s.uptime ? `运行：${formatUptime(s.uptime)}` : '—';

  $('sidebar-status').textContent = s.gateway ? '● ONLINE' : '● OFFLINE';

  // Update sidebar version
    if (s.version && s.version !== 'unknown') {
      $('sidebar-version').textContent = s.version;
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
    $('update-latest').textContent = u.latestVersion;
    $('update-current').textContent = u.currentVersion;
    $('update-link').href = u.releaseUrl || '#';
    banner.style.display = '';
    // Show/hide hot update button based on update type
    const hotBtn = $('btn-hotpatch-banner');
    const fullHint = $('update-full-hint');
    const installNote = $('update-install-note');
    if (hotBtn) hotBtn.style.display = u.requiresFullUpdate ? 'none' : '';
    if (fullHint) {
      fullHint.style.display = u.requiresFullUpdate ? '' : 'none';
      if (u.requiresFullUpdate) {
        fullHint.innerHTML = '📦 <b>需要完整更新</b>：请重新执行一键安装脚本（会自动检测并升级到新版本）';
      }
    }
    if (installNote) installNote.style.display = u.requiresFullUpdate ? '' : 'none';
    if (!u.requiresFullUpdate && fullHint) {
      fullHint.style.display = '';
      fullHint.style.color = '#4ade80';
      fullHint.innerHTML = '⚡ <b>可热更新</b>：建议先点击“热更新”，无需重装容器';
    } else if (fullHint) {
      fullHint.style.color = '#f59e0b';
    }
  } else if (banner) {
    banner.style.display = 'none';
  }

  // Sidebar red dot
  const dot = $('update-dot');
  if (dot) { dot.style.display = u.hasUpdate ? '' : 'none'; }

  // Settings page
  if ($('settings-current-ver')) {
    $('settings-current-ver').textContent = u.currentVersion || '—';
    $('settings-latest-ver').textContent = u.latestVersion || '—';
    const statusEl = $('settings-update-status');
    const linkEl = $('settings-release-link');
    if (u.hasUpdate) {
      if (u.requiresFullUpdate) {
        statusEl.innerHTML = '<span style="color:#f59e0b">📦 需要完整更新</span>';
      } else {
        statusEl.innerHTML = '<span style="color:#4ade80">⚡ 可热更新</span>';
      }
      if (linkEl && u.releaseUrl) { linkEl.href = u.releaseUrl; linkEl.style.display = ''; }
      // Show/hide hot update & full update hints on settings page
      const hpBtn = $('btn-hotpatch');
      const fullNote = $('settings-full-update-note');
      if (hpBtn) hpBtn.style.display = u.requiresFullUpdate ? 'none' : '';
      if (fullNote) fullNote.style.display = u.requiresFullUpdate ? '' : 'none';
    } else if (u.latestVersion) {
      statusEl.innerHTML = '<span style="color:#888">✅ 已是最新</span>';
      if (linkEl) linkEl.style.display = 'none';
      // Hide hot update button and full update note when already up to date
      const hpBtn = $('btn-hotpatch');
      const fullNote = $('settings-full-update-note');
      if (hpBtn) hpBtn.style.display = 'none';
      if (fullNote) fullNote.style.display = 'none';
    } else {
      // Friendly error: don't show raw curl commands to user
      let errMsg = u.error || '检查失败';
      if (errMsg.includes('curl fallback failed') || errMsg.includes('fetch')) {
        errMsg = '⚠️ 无法连接 GitHub（网络不可达）';
      }
      statusEl.innerHTML = `<span style="color:#f87171">${errMsg}</span>`;
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

function setHotpatchButtons(disabled, text) {
  const btns = qa('[id^="btn-hotpatch"]');
  btns.forEach((b) => {
    b.disabled = !!disabled;
    if (typeof text === 'string') b.textContent = text;
  });
}

async function doHotPatch() {
  if (hotpatchRestartPending) {
    toast('请稍候', '后端重启中，恢复后可再次热更新');
    return;
  }

  setHotpatchButtons(true, '⏳ 更新中...');

  const logBox = $('hotpatch-log');
  const logPre = logBox ? logBox.querySelector('pre') : null;
  if (logBox) { logBox.style.display = ''; }
  if (logPre) logPre.textContent = '正在拉取最新文件...\n';

  try {
    const r = await api('/api/update/hotpatch', { method: 'POST', body: { branch: 'main' } });
    if (r.error) {
      toast('热更新失败', r.error);
      setHotpatchButtons(false, '⚡ 热更新（不重启容器）');
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

            if (hasFrontend || hasWebServer) {
              if (logPre) {
                logPre.textContent += hasWebServer
                  ? '\n检测到后端已更新，正在等待服务恢复后自动重查更新状态（不再强制刷新页面）。'
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
let ocStartRunning = false;
let ocInstalled = false;
let ocInstallTaskRunningRemote = false;
let ocRepairTaskRunningRemote = false;
let ocGatewayRestartRunningRemote = false;
let ocLastGatewaySnapshot = '';

function syncOpenClawButtons(){
  const installBtn = $('btn-oc-install');
  const repairBtn = $('btn-oc-repair-config');
  const startBtn = $('btn-oc-start');
  const installBusy = !!ocInstallRunning || !!ocInstallTaskRunningRemote;
  const repairBusy = !!ocRepairRunning || !!ocRepairTaskRunningRemote;
  const restartBusy = !!ocStartRunning || !!ocGatewayRestartRunningRemote;
  const anyBusy = installBusy || repairBusy || restartBusy;
  if (installBtn) installBtn.disabled = anyBusy;
  if (repairBtn) repairBtn.disabled = anyBusy;
  if (startBtn) startBtn.disabled = anyBusy || !ocInstalled;
}

function shouldAutoScroll(el, threshold = 24){
  if (!el) return true;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= threshold;
}

function appendOcLogLine(line){
  const logEl = $('oc-log');
  if (!logEl) return;
  appendColored(logEl, `${line}\n`, 6000, shouldAutoScroll(logEl));
}

function appendOcLogBlock(text){
  const logEl = $('oc-log');
  if (!logEl) return;
  const chunk = String(text || '').trim();
  if (!chunk) return;
  appendColored(logEl, `${chunk}\n`, 6000, shouldAutoScroll(logEl));
}

async function loadGatewayStartupLogs(lines = 160){
  try {
    const r = await api(`/api/openclaw/gateway/logs?lines=${Math.max(20, Math.min(lines, 1200))}`, { timeoutMs: 12000 });
    const snapshot = String(r?.logs || '').trim();
    if (r?.success && snapshot && snapshot !== ocLastGatewaySnapshot) {
      appendOcLogLine('[gateway] 最近启动日志快照：');
      appendOcLogBlock(snapshot);
      ocLastGatewaySnapshot = snapshot;
    }
  } catch (e) {
    appendOcLogLine(`[gateway] 读取启动日志失败: ${e?.message || e}`);
  }
}

function scheduleGatewayStartupLogPulls(lines = 200){
  [1800, 4200, 8000].forEach((delay) => {
    setTimeout(() => loadGatewayStartupLogs(lines), delay);
  });
}

async function refreshOpenClaw(opts = {}){
  const retries = Math.max(0, Number(opts.retries ?? 1));
  let d = null;
  let lastErr = '';

  for (let i = 0; i <= retries; i++) {
    d = await api('/api/openclaw', { timeoutMs: 15000 });
    if (d && !d.error && Object.prototype.hasOwnProperty.call(d, 'installed')) break;
    lastErr = d?.error || '接口返回异常';
    if (i < retries) {
      await new Promise((resolve) => setTimeout(resolve, 350 * (i + 1)));
    }
  }

  if (!d || d.error || !Object.prototype.hasOwnProperty.call(d, 'installed')) {
    const detail = lastErr || '状态读取失败';
    if ($('oc-update-status')) {
      $('oc-update-status').textContent = `更新状态：读取失败（${detail}）`;
    }
    return { error: detail };
  }

  $('oc-installed').innerHTML = d.installed
    ? `<span class="pulse online"></span>已安装`
    : `<span class="pulse offline"></span>未安装`;
  if (d.installed) {
    if (d.version && d.latestVersion && d.hasUpdate) {
      $('oc-version').textContent = `版本：${d.version}（可更新到 ${d.latestVersion}）`;
    } else if (d.version) {
      $('oc-version').textContent = `版本：${d.version}`;
    } else {
      $('oc-version').textContent = '版本：未解析（已安装）';
    }
  } else {
    $('oc-version').textContent = '—';
  }
  $('oc-gateway').innerHTML = d.gatewayRunning
    ? `<span class="pulse online"></span>运行中`
    : `<span class="pulse offline"></span>未启动`;

  ocInstalled = !!d.installed;
  ocInstallTaskRunningRemote = !!d.installTaskRunning;
  ocRepairTaskRunningRemote = !!d.repairTaskRunning;
  ocGatewayRestartRunningRemote = !!d.gatewayRestartRunning;

  const actionBtn = $('btn-oc-install');
  if (actionBtn) {
    actionBtn.textContent = d.installed ? '更新' : '安装';
  }

  if ($('oc-current-ver')) $('oc-current-ver').textContent = d.version || '—';
  if ($('oc-latest-ver')) $('oc-latest-ver').textContent = d.latestVersion || (d.installed ? '检测中' : '—');
  if ($('oc-update-status')) {
    const invalidKeys = Array.isArray(d.invalidConfigKeys) ? d.invalidConfigKeys : [];
    if (invalidKeys.length > 0) {
      $('oc-update-status').textContent = `配置状态：检测到无效 key（${invalidKeys.join(', ')}），请点击“配置恢复”`;
    } else if (!d.installed) {
      $('oc-update-status').textContent = '更新状态：未安装，可执行安装';
    } else if (d.updateCheckError) {
      $('oc-update-status').textContent = `更新状态：检查失败（${d.updateCheckError}）`;
    } else if (d.hasUpdate) {
      $('oc-update-status').textContent = '更新状态：发现新版本，可更新';
    } else if (d.latestVersion) {
      $('oc-update-status').textContent = '更新状态：已是最新版本';
    } else {
      $('oc-update-status').textContent = '更新状态：自动检查中';
    }
  }

  syncOpenClawButtons();

  return d;
}

async function pollTask(taskId){
  if (ocPollTimer) clearInterval(ocPollTimer);
  const logEl = $('oc-log');
  if (!logEl) return;
  logEl.innerHTML = '';

  let lastSeq = 0;
  let errorStreak = 0;
  const startedAt = Date.now();

  const tick = async () => {
    const st = await api('/api/openclaw/install/' + taskId + '?since=' + lastSeq);
    if (!st || st.error) {
      errorStreak += 1;
      if (errorStreak >= 8) {
        if (ocPollTimer) clearInterval(ocPollTimer);
        ocPollTimer = null;
        ocInstallRunning = false;
        syncOpenClawButtons();
        const detail = st?.error || '任务状态轮询失败';
        appendOcLogLine(`[openclaw] 轮询中断: ${detail}`);
        toast('任务状态异常', detail);
      }
      return;
    }
    errorStreak = 0;

    if ((Date.now() - startedAt) > 18 * 60 * 1000) {
      if (ocPollTimer) clearInterval(ocPollTimer);
      ocPollTimer = null;
      ocInstallRunning = false;
      syncOpenClawButtons();
      appendOcLogLine('[openclaw] 任务执行超时，请检查日志并按需重试。');
      toast('任务超时', '执行超过 18 分钟，已停止前端轮询');
      return;
    }

    const autoScroll = shouldAutoScroll(logEl);

    if (st.delta) {
      appendColored(logEl, st.delta, 6000, autoScroll);
    } else if (!lastSeq && st.log) {
      // First render fallback
      setColored(logEl, st.log, 6000, autoScroll);
    }
    lastSeq = Number(st.seq || lastSeq || 0);

    if (st.status && st.status !== 'running'){
      clearInterval(ocPollTimer);
      ocPollTimer = null;
      ocInstallRunning = false;
      syncOpenClawButtons();
      toast(st.status === 'success' ? '完成' : '失败', st.status === 'success' ? 'OpenClaw 已就绪' : (st.log || '请查看日志'));
      if (st.status === 'success') {
        appendOcLogLine('[gateway] 安装/更新成功，正在自动重启 Gateway...');
        ocLastGatewaySnapshot = '';
        try {
          const rr = await api('/api/openclaw/start', { method:'POST' });
          if (rr.success) {
            appendOcLogLine(`[gateway] ${rr.message || '重启请求已提交，watchdog 将自动拉起'}`);
            if (rr.logs) {
              appendOcLogBlock(rr.logs);
              ocLastGatewaySnapshot = String(rr.logs || '').trim() || ocLastGatewaySnapshot;
            }
            scheduleGatewayStartupLogPulls(220);
          } else {
            appendOcLogLine(`[gateway] 自动重启失败: ${rr.error || '请查看日志'}`);
            if (rr.logs) {
              appendOcLogBlock(rr.logs);
              ocLastGatewaySnapshot = String(rr.logs || '').trim() || ocLastGatewaySnapshot;
            }
          }
        } catch (e) {
          appendOcLogLine(`[gateway] 自动重启请求失败: ${e.message || e}`);
        }
      }
      refreshOpenClaw();
      refreshStatus();
    }
  };

  await tick();
  ocPollTimer = setInterval(tick, 600);
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
      appendColored($('oc-log'), st.delta, 6000, shouldAutoScroll($('oc-log')));
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
  const r = await refreshOpenClaw({ retries: 1 });
  if (r?.error) toast('状态刷新失败', r.error);
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
    const list = await api('/api/openclaw/config/backups', { timeoutMs: 15000 });
    if (!list || list.error || !Array.isArray(list.backups)) {
      throw new Error(list?.error || '备份列表读取失败');
    }
    if (list.backups.length === 0) {
      appendOcLogLine('[restore] 未找到可用备份文件。');
      toast('配置恢复', '未找到备份文件');
      return;
    }

    const shown = list.backups.slice(0, 12);
    const hint = shown.map((item, idx) => `${idx + 1}. ${item.name}`).join('\n');
    const input = window.prompt(`请选择要恢复的备份（输入序号或文件名）：\n${hint}`, shown[0].name);
    if (input === null) {
      appendOcLogLine('[restore] 已取消。');
      return;
    }

    const raw = String(input || '').trim();
    if (!raw) {
      appendOcLogLine('[restore] 未输入备份项，已取消。');
      return;
    }

    let selectedName = raw;
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw) - 1;
      if (idx >= 0 && idx < shown.length) selectedName = shown[idx].name;
    }

    appendOcLogLine(`[restore] 正在恢复备份: ${selectedName}`);
    const r = await api('/api/openclaw/config/restore', { method:'POST', body: { name: selectedName }, timeoutMs: 15000 });
    if (!r || r.error || !r.success) {
      throw new Error(r?.error || '恢复失败');
    }

    appendOcLogLine(`[restore] 配置恢复完成: ${r.restored || selectedName}`);
    appendOcLogLine('[restore] 请点击“重启 Gateway”使配置生效。');
    toast('配置恢复完成', r.restored || selectedName);
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
  syncOpenClawButtons();
  let taskStarted = false;
  try{
    const current = await refreshOpenClaw({ retries: 2 });
    if (!current || current.error) {
      const detail = current?.error || '无法获取当前 OpenClaw 状态';
      appendOcLogLine(`[openclaw] 状态读取失败，无法继续（${detail}）。`);
      toast('读取失败', detail);
      return;
    }

    if (!current.installed) {
      appendOcLogLine('[openclaw] 未安装，正在提交安装任务...');
      const i = await api('/api/openclaw/install', { method:'POST' });
      if (!i.taskId){
        const isEmptyResponse = i && typeof i === 'object' && Object.keys(i).length === 0;
        const detail = i.error || (isEmptyResponse
          ? '接口返回空响应（可能会话失效或页面缓存未更新，请刷新后重试）'
          : `接口返回异常（${JSON.stringify(i || {}) || 'empty'}）`);
        appendOcLogLine(`[openclaw] 安装启动失败: ${detail}`);
        if (/空响应|缓存未更新|会话失效/.test(detail)) {
          appendOcLogLine('[openclaw] 提示: 请强制刷新页面后重试（macOS: Command+Shift+R）。');
        }
        toast('安装失败', detail);
        return;
      }
      toast('开始安装', '正在执行 OpenClaw 安装...');
      appendOcLogLine(`[openclaw] 安装任务已启动: ${i.taskId}`);
      taskStarted = true;
      pollTask(i.taskId);
      return;
    }

    if (!current.version) {
      appendOcLogLine('[openclaw] 未检测到本地版本，已取消更新。');
      toast('更新已取消', '未检测到本地版本，请先检查安装状态');
      return;
    }

    if (!current.latestVersion) {
      appendOcLogLine('[openclaw] 无法获取远端最新版本，已取消更新。');
      toast('更新已取消', current.updateCheckError || '无法获取远端版本');
      return;
    }

    if (!current.hasUpdate) {
      appendOcLogLine(`[openclaw] 当前已是最新版本（${current.version}），无需更新。`);
      toast('无需更新', `当前已是最新版本：${current.version}`);
      return;
    }

    appendOcLogLine(`[openclaw] 检测到新版本：${current.version} -> ${current.latestVersion}，开始更新...`);
    const r = await api('/api/openclaw/update', { method:'POST' });
    if (!r.taskId){
      const isEmptyResponse = r && typeof r === 'object' && Object.keys(r).length === 0;
      const detail = r.error || (isEmptyResponse
        ? '接口返回空响应（可能会话失效或页面缓存未更新，请刷新后重试）'
        : `接口返回异常（${JSON.stringify(r || {}) || 'empty'}）`);
      appendOcLogLine(`[openclaw] 更新启动失败: ${detail}`);
      if (/空响应|缓存未更新|会话失效/.test(detail)) {
        appendOcLogLine('[openclaw] 提示: 请强制刷新页面后重试（macOS: Command+Shift+R）。');
      }
      toast('更新失败', detail);
      return;
    }
    toast('开始更新', `正在更新到 ${current.latestVersion}...`);
    appendOcLogLine(`[openclaw] 更新任务已启动: ${r.taskId}`);
    taskStarted = true;
    pollTask(r.taskId);
  } catch (e) {
    appendOcLogLine(`[openclaw] 请求失败: ${e.message || e}`);
    toast('请求失败', e.message || String(e));
  }finally{
    if (!taskStarted) {
      ocInstallRunning = false;
      syncOpenClawButtons();
    }
  }
});

$('btn-oc-start').addEventListener('click', async ()=>{
  if (ocInstallRunning) {
    toast('任务进行中', '安装/更新执行中，暂不可重启 Gateway');
    return;
  }
  if (ocStartRunning) {
    toast('任务进行中', '网关重启正在执行，请稍候');
    return;
  }
  ocStartRunning = true;
  syncOpenClawButtons();
  appendOcLogLine('[gateway] 正在提交重启请求...');
  ocLastGatewaySnapshot = '';
  try {
    const r = await api('/api/openclaw/start', { method:'POST' });
    if (r.success) {
      appendOcLogLine(`[gateway] ${r.message || '重启请求已提交'}`);
      appendOcLogLine('[gateway] 请稍候 2-5 秒，状态将自动刷新。');
      if (r.logs) {
        appendOcLogBlock(r.logs);
        ocLastGatewaySnapshot = String(r.logs || '').trim() || ocLastGatewaySnapshot;
      }
      scheduleGatewayStartupLogPulls(220);
      toast('已触发重启', r.message || 'Gateway 正在重启，请稍候');
    } else {
      appendOcLogLine(`[gateway] 重启失败: ${r.error || '请查看日志'}`);
      if (r.logs) {
        appendOcLogBlock(r.logs);
        ocLastGatewaySnapshot = String(r.logs || '').trim() || ocLastGatewaySnapshot;
      }
      if (/Unrecognized key|Invalid config|配置无效/i.test(String(r.error || ''))) {
        appendOcLogLine('[gateway] 检测到配置无效，请点击“配置恢复”按钮后重试。');
      }
      toast('重启失败', r.error || '请查看日志');
    }
  } finally {
    ocStartRunning = false;
    syncOpenClawButtons();
  }
  setTimeout(refreshOpenClaw, 2500);
});

// ------------------------
// AI config
// ------------------------
let aiAuthTaskTimer = null;

function providerFromModel(modelId = '') {
  const text = String(modelId || '').trim();
  if (!text.includes('/')) return '';
  return text.split('/')[0];
}

function normalizeProviderIdForAuth(provider) {
  const p = String(provider || '').trim();
  if (p === 'github-copilot') return 'copilot-proxy';
  return p;
}

function updateAiProviderUI() {
  const provider = $('ai-provider').value;
  $('ai-custom-url-wrap').hidden = provider !== 'custom';
  if ($('btn-ai-copilot-login')) {
    $('btn-ai-copilot-login').hidden = provider !== 'github-copilot';
  }
}

function appendAiAuthLog(line){
  const logEl = $('ai-auth-log');
  if (!logEl) return;
  appendColored(logEl, `${line}\n`, 3000, true);
}

async function loadAIConfig(){
  const d = await api('/api/ai/status');
  if (d.error) {
    $('ai-status').textContent = `状态：读取失败（${d.error}）`;
    return;
  }

  const defaultModel = d.defaultModel || d.resolvedDefault || '';
  const provider = providerFromModel(defaultModel) || 'anthropic';
  if ($('ai-provider')) $('ai-provider').value = provider;
  if ($('ai-model')) $('ai-model').value = defaultModel;
  if ($('ai-apikey')) $('ai-apikey').value = '';
  updateAiProviderUI();

  if (d.success) {
    const providers = (d.configuredProviders || []).join(', ') || '无';
    $('ai-status').textContent = `状态：已读取（默认模型：${defaultModel || '未设置'}；认证来源：${providers}）`;
  } else {
    $('ai-status').textContent = `状态：读取失败（${d.raw || 'openclaw models status --json 执行失败'}）`;
  }
}

async function pollAiAuthTask(taskId){
  if (aiAuthTaskTimer) clearInterval(aiAuthTaskTimer);
  let lastSeq = 0;
  const tick = async () => {
    const st = await api('/api/ai/auth/task/' + taskId + '?since=' + lastSeq);
    if (!st || st.error) return;
    if (st.delta) appendColored($('ai-auth-log'), st.delta, 3000, true);
    lastSeq = Number(st.seq || lastSeq || 0);
    if (st.status && st.status !== 'running') {
      if (aiAuthTaskTimer) clearInterval(aiAuthTaskTimer);
      aiAuthTaskTimer = null;
      toast(st.status === 'success' ? 'Copilot 登录完成' : 'Copilot 登录失败', st.status === 'success' ? '认证信息已写入 OpenClaw' : '请查看认证日志');
      await loadAIConfig();
    }
  };
  await tick();
  aiAuthTaskTimer = setInterval(tick, 1000);
}

$('ai-provider').addEventListener('change', updateAiProviderUI);

$('btn-ai-load').addEventListener('click', loadAIConfig);

$('btn-ai-copilot-login')?.addEventListener('click', async ()=>{
  appendAiAuthLog('[ai] 正在启动 GitHub Copilot 登录流程...');
  const r = await api('/api/ai/auth/copilot/login', { method:'POST' });
  if (!r.success || !r.taskId) {
    toast('启动失败', r.error || '无法启动 Copilot 登录流程');
    appendAiAuthLog(`[ai] 启动失败: ${r.error || '接口未返回 taskId'}`);
    return;
  }
  appendAiAuthLog(`[ai] 认证任务已启动: ${r.taskId}`);
  pollAiAuthTask(r.taskId);
});

$('btn-ai-save').addEventListener('click', async ()=>{
  const provider = $('ai-provider').value;
  const model = $('ai-model').value.trim();
  const apiKey = $('ai-apikey').value.trim();

  if (!model) {
    toast('参数错误', '请先填写模型');
    return;
  }

  const modelRes = await api('/api/ai/model', { method:'POST', body:{ model } });
  if (!modelRes.success) {
    toast('保存失败', modelRes.error || '设置模型失败');
    appendAiAuthLog(`[ai] 设置模型失败: ${modelRes.error || ''}`);
    return;
  }
  appendAiAuthLog(`[ai] 已设置默认模型: ${model}`);

  if (provider === 'github-copilot') {
    toast('模型已保存', 'Copilot 请点击“GitHub Copilot 登录”完成认证');
    await loadAIConfig();
    return;
  }

  if (!apiKey) {
    toast('保存成功', '模型已保存（未更新 API Key）');
    await loadAIConfig();
    return;
  }

  const authProvider = normalizeProviderIdForAuth(provider);
  appendAiAuthLog(`[ai] 正在写入 ${authProvider} 认证信息...`);
  const authRes = await api('/api/ai/auth/token', { method:'POST', body:{ provider: authProvider, token: apiKey } });
  if (!authRes.success) {
    toast('保存部分成功', `模型已保存；认证写入失败：${authRes.error || ''}`);
    appendAiAuthLog(`[ai] 认证写入失败: ${authRes.error || ''}`);
  } else {
    toast('保存成功', '模型与认证信息已写入 OpenClaw');
    if (authRes.output) appendAiAuthLog(`[ai] ${authRes.output}`);
  }
  if ($('ai-apikey')) $('ai-apikey').value = '';
  await loadAIConfig();
});

// ------------------------
// Messaging config
// ------------------------
async function loadMessagingConfig(){
  const cfg = await api('/api/config');
  if (cfg.error) return;
  const c = cfg.channels || {};

  const setBoolSelect = (id, v) => { if ($(id)) $(id).value = String(!!v); };

  setBoolSelect('feishu-enabled', c.feishu?.enabled);
  $('feishu-appid').value = c.feishu?.appId || '';
  $('feishu-secret').value = c.feishu?.appSecret || '';
  $('feishu-token').value = c.feishu?.verificationToken || '';
  $('feishu-encrypt').value = c.feishu?.encryptKey || '';

  setBoolSelect('telegram-enabled', c.telegram?.enabled);
  $('telegram-token').value = c.telegram?.token || '';
  $('telegram-users').value = c.telegram?.allowedUsers || '';

  setBoolSelect('discord-enabled', c.discord?.enabled);
  $('discord-token').value = c.discord?.token || '';
  $('discord-guild').value = c.discord?.guildId || '';

  setBoolSelect('signal-enabled', c.signal?.enabled);
  $('signal-cli').value = c.signal?.cliPath || '';
  $('signal-phone').value = c.signal?.phone || '';

  setBoolSelect('whatsapp-enabled', c.whatsapp?.enabled);
  $('whatsapp-url').value = c.whatsapp?.apiUrl || '';
  $('whatsapp-key').value = c.whatsapp?.apiKey || '';
}

$('btn-msg-load').addEventListener('click', loadMessagingConfig);

qa('[data-save-msg]').forEach(btn => {
  btn.addEventListener('click', async ()=>{
    const platform = btn.getAttribute('data-save-msg');
    const update = { channels: {} };
    const enabled = ($(`${platform}-enabled`)?.value || 'false') === 'true';
    update.channels[platform] = { enabled };

    if (platform === 'feishu'){
      update.channels.feishu.appId = $('feishu-appid').value;
      update.channels.feishu.appSecret = $('feishu-secret').value;
      update.channels.feishu.verificationToken = $('feishu-token').value;
      update.channels.feishu.encryptKey = $('feishu-encrypt').value;
    }
    if (platform === 'telegram'){
      update.channels.telegram.token = $('telegram-token').value;
      update.channels.telegram.allowedUsers = $('telegram-users').value;
    }
    if (platform === 'discord'){
      update.channels.discord.token = $('discord-token').value;
      update.channels.discord.guildId = $('discord-guild').value;
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
    toast(r.success ? '保存成功' : '保存失败', r.error || '');
  });
});

// ------------------------
// Trading (legacy endpoints retained)
// ------------------------
async function refreshTrading(){
  const d = await api('/api/trading');
  if (d.error) return;

  $('trading-not-installed').hidden = !!d.installed;
  $('trading-installed').hidden = !d.installed;

  if (d.installed){
    $('trading-commit').textContent = d.commit || '—';
    $('strategy-params').value = d.strategyParams ? JSON.stringify(d.strategyParams, null, 2) : '';
  }
}

$('btn-trading-refresh').addEventListener('click', refreshTrading);
$('btn-trading-install').addEventListener('click', async ()=>{
  const token = $('trading-gh-token').value;
  const repo = $('trading-repo').value;
  if (!token || !repo) return toast('缺少参数', '请填写 GitHub Token 与仓库地址');

  $('trading-install-status').textContent = '安装中...';
  const r = await api('/api/trading/install', { method:'POST', body:{ token, repo } });
  if (r.success){
    $('trading-install-status').textContent = '安装成功';
    toast('安装成功', '');
    setTimeout(refreshTrading, 800);
  }else{
    $('trading-install-status').textContent = '安装失败：' + (r.error||'');
    toast('安装失败', r.error||'');
  }
});

$('btn-trading-update').addEventListener('click', async ()=>{
  const r = await api('/api/trading/update', { method:'POST' });
  toast(r.success ? '更新成功' : '更新失败', r.output || r.error || '');
  if (r.success) setTimeout(refreshTrading, 800);
});

$('btn-strategy-save').addEventListener('click', async ()=>{
  try{
    const parsed = JSON.parse($('strategy-params').value || '{}');
    const r = await api('/api/trading', { method:'POST', body: parsed });
    toast(r.success ? '已保存' : '保存失败', r.error||'');
  }catch{
    toast('JSON 格式错误', '请检查策略参数');
  }
});

// ------------------------
// Plugins
// ------------------------
function pluginCard(p){
  const tag = p.pro ? '<span class="badge pro">PRO</span>' : '<span class="badge">免费</span>';
  const btnText = p.installed ? '已安装' : '安装';
  const btnCls = p.installed ? 'btn' : 'btn btn-primary';

  return `
    <div class="card" style="margin-bottom:12px">
      <div class="row" style="justify-content:space-between; align-items:flex-start">
        <div class="row" style="gap:12px; align-items:flex-start">
          <div style="font-size:22px; line-height:1">${escapeHtml(p.icon||'🧩')}</div>
          <div>
            <div style="font-weight:900">${escapeHtml(p.name)}</div>
            <div class="muted small" style="margin-top:4px">${escapeHtml(p.desc || '')}</div>
          </div>
        </div>
        <div class="row" style="gap:10px">
          ${tag}
          <button class="${btnCls}" data-plugin-install="${escapeHtml(p.id)}" ${p.installed ? 'disabled' : ''}>${btnText}</button>
        </div>
      </div>
    </div>
  `;
}

async function refreshPlugins(){
  const d = await api('/api/plugins/list');
  if (d.error) return toast('加载失败', d.error);

  $('plugins-skills').innerHTML = (d.skills || []).map(pluginCard).join('') || '<div class="muted">暂无</div>';
  $('plugins-pro').innerHTML = (d.pro || []).map(pluginCard).join('') || '<div class="muted">暂无</div>';
}

$('btn-plugins-refresh').addEventListener('click', refreshPlugins);

document.addEventListener('click', async (e)=>{
  const btn = e.target.closest('[data-plugin-install]');
  if (!btn) return;

  const id = btn.getAttribute('data-plugin-install');
  btn.disabled = true;
  btn.textContent = '安装中...';

  const r = await api('/api/plugins/install', { method:'POST', body:{ id } });
  toast(r.success ? '安装成功' : '安装失败', r.error||'');
  refreshPlugins();
});

// ------------------------
// Terminal (interactive shell)
// ------------------------
let termWs = null;
let terminalBound = false;
let termResizeTimer = null;
let termReconnectTimer = null;
let termWsToken = null;
let termFallbackTimer = null;
let termFailureCount = 0;
let termConnectTimeoutTimer = null;
let termEmulator = null;
let termFitAddon = null;

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
      scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#05070f',
        foreground: '#e5e7eb',
        cursor: '#93c5fd'
      }
    });

    if (window.FitAddon && window.FitAddon.FitAddon) {
      termFitAddon = new window.FitAddon.FitAddon();
      termEmulator.loadAddon(termFitAddon);
    }

    terminalContainer.innerHTML = '';
    termEmulator.open(terminalContainer);
    if (termFitAddon) termFitAddon.fit();

    termEmulator.onData((data) => {
      if (termWs && termWs.readyState === WebSocket.OPEN) {
        sendTerminalData(data);
      }
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
  const chunkRaw = String(text ?? '');
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
  el.textContent += chunk;
  const maxChars = 180000;
  if (el.textContent.length > maxChars) {
    el.textContent = el.textContent.slice(-maxChars);
  }
  if ($('term-autoscroll')?.checked) {
    el.scrollTop = el.scrollHeight;
  }
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
  if (termWs){
    try{ termWs.close(); }catch{}
    termWs = null;
  }
  $('term-state').textContent = '未连接';
}

async function pullTerminalFallbackLogs(){
  if (termWs && termWs.readyState === WebSocket.OPEN) return;
  const d = await api('/api/logs?lines=140');
  if (d.error) return;
  const logs = String(d.logs || '').trimEnd();
  if (!logs) return;
  setColored($('terminal'), logs, 6000, !!$('term-autoscroll')?.checked);
  if ($('term-autoscroll')?.checked) {
    $('terminal').scrollTop = $('terminal').scrollHeight;
  }
}

function startTerminalFallback(reason = ''){
  if (termFallbackTimer) return;
  $('term-state').textContent = '只读日志模式';
  termAppendText(`\n[terminal] 交互连接不可用，已切换只读日志模式${reason ? ` (${reason})` : ''}。\n`);
  pullTerminalFallbackLogs().catch(()=>{});
  termFallbackTimer = setInterval(() => pullTerminalFallbackLogs().catch(()=>{}), 2500);
}

function sendTerminalData(data){
  if (!termWs || termWs.readyState !== WebSocket.OPEN) return false;
  termWs.send(JSON.stringify({ type: 'input', data }));
  return true;
}

function sendTerminalResize(){
  if (!termWs || termWs.readyState !== WebSocket.OPEN) return;
  if (termEmulator) {
    if (termFitAddon) termFitAddon.fit();
    const cols = Math.max(40, Number(termEmulator.cols) || 80);
    const rows = Math.max(12, Number(termEmulator.rows) || 24);
    termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    return;
  }
  const el = $('terminal');
  if (!el) return;
  const cols = Math.max(40, Math.floor(el.clientWidth / 8));
  const rows = Math.max(12, Math.floor(el.clientHeight / 18));
  termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
}

function bindTerminalInteraction(){
  if (terminalBound) return;
  const terminalEl = $('terminal');
  if (!terminalEl) return;

  const useXterm = initTerminalEmulator();

  terminalEl.addEventListener('click', () => focusTerminalInput());

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

  terminalEl.addEventListener('keydown', (e) => {
    if (!termWs || termWs.readyState !== WebSocket.OPEN) {
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
    if (!termWs || termWs.readyState !== WebSocket.OPEN) return;
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
  if (termWs && (termWs.readyState === WebSocket.OPEN || termWs.readyState === WebSocket.CONNECTING)) return;

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
    try {
      termWs = new WebSocket(url);
    } catch {
      $('term-state').textContent = 'WebSocket 不可用';
      termAppendText(`[terminal] WebSocket 不可用，无法建立交互会话 (${attemptLabel})\n`);
      return false;
    }

    armConnectTimeout();

    termWs.onopen = ()=> {
      clearConnectTimeout();
      termFailureCount = 0;
      if (termFallbackTimer) {
        clearInterval(termFallbackTimer);
        termFallbackTimer = null;
      }
      $('term-state').textContent = '已连接';
      termAppendText('[terminal] 已连接（PTY）。直接在此区域输入命令并按回车执行。\n');
      focusTerminalInput();
      sendTerminalResize();
    };

    termWs.onclose = (ev)=> {
      clearConnectTimeout();
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
      }

      termWs = null;
      if ($('page-terminal').classList.contains('active')) {
        if (termReconnectTimer) clearTimeout(termReconnectTimer);
        termReconnectTimer = setTimeout(() => {
          termReconnectTimer = null;
          terminalConnect();
        }, 1800);
        $('term-state').textContent = '重连中...';
      }
    };

    termWs.onerror = ()=> {
      clearConnectTimeout();
      termFailureCount += 1;
      $('term-state').textContent = '连接错误';
      termAppendText(`\n[terminal] 连接错误 [${attemptLabel}]。\n`);
      if (attemptLabel === 'token-auth') {
        termWsToken = null;
      }
      if (termFailureCount >= 2) {
        startTerminalFallback('网络或代理异常');
      }
      api('/api/status').then((s) => {
        const reason = s?.terminal?.reason;
        if (reason) {
          termAppendText(`[terminal] 后端状态: ${reason}\n`);
        }
      }).catch(() => {});
    };

    termWs.onmessage = (ev)=>{
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
}

$('btn-term-clear').addEventListener('click', ()=>{
  if (termEmulator) {
    termEmulator.clear();
    return;
  }
  $('terminal').textContent='';
});
bindTerminalInteraction();

// ------------------------
// Logs (poll)
// ------------------------
let logsTimer = null;
async function refreshLogs(){
  const d = await api('/api/logs?lines=400');
  if (d.error) return;
  setColored($('log-viewer'), d.logs || '', 6000, true);
  $('log-viewer').scrollTop = $('log-viewer').scrollHeight;
}

$('btn-logs-refresh').addEventListener('click', refreshLogs);
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

$('btn-browser-save')?.addEventListener('click', async ()=> {
  const browserEnabled = $('settings-browser-enabled')?.value === 'true';
  const r = await api('/api/docker-config', { method: 'POST', body: { browserEnabled } });
  if (r.success) {
    setBrowserNavVisible(browserEnabled);
    toast('浏览器设置已保存', '重启容器后生效（docker restart openclaw-pro）');
  } else {
    toast('保存失败', r.error || '');
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
setActiveRoute(getRouteFromHash());
refreshStatus();
loadBrowserSettings();
setInterval(refreshStatus, 30000);

// Auto check for updates on page load (non-blocking)
setTimeout(() => checkForUpdate(), 3000);

// Periodic update check every 30 minutes
setInterval(() => checkForUpdate(), 30 * 60 * 1000);
