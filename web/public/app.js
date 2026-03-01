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

    let data = {};
    try{ data = await res.json(); }catch{ data = {}; }
    return data;
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

// ------------------------
// Toast
// ------------------------
let toastTimer = null;
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function colorizeLine(rawLine){
  const line = String(rawLine ?? '');
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
  const html = String(text ?? '').split('\n').map(colorizeLine).join('');
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
  { id: 'openclaw', title: 'OpenClaw' },
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
  if (h === 'ai') return 'openclaw';
  const found = ROUTES.find(r => r.id === h);
  return found ? found.id : 'dashboard';
}

function setActiveRoute(route){
  // nav active
  qa('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  // pages
  qa('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + route));
  // title
  const page = $('page-' + route);
  $('page-title').textContent = page?.dataset?.title || (ROUTES.find(r => r.id===route)?.title ?? '');

  // close sidebar on mobile
  $('sidebar').classList.remove('open');

  // hooks
  if (route === 'dashboard') refreshStatus();
  if (route === 'openclaw') { refreshOpenClaw(); loadAIConfig(); }
  if (route === 'messaging') loadMessagingConfig();
  if (route === 'trading') refreshTrading();
  if (route === 'plugins') refreshPlugins();
  if (route === 'terminal') terminalConnect();
  if (route === 'browser') loadBrowserFrame();
  if (route === 'settings') { loadSttConfig(); bindSttVisibility(); loadBrowserSettings(); checkForUpdate(); }
  if (route === 'logs') refreshLogs();
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
  $('kpi-gateway-sub').textContent = s.gateway ? '进程检测正常' : '未检测到进程';

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

async function doHotPatch() {
  const btns = qa('[id^="btn-hotpatch"]');
  btns.forEach(b => { b.disabled = true; b.textContent = '⏳ 更新中...'; });

  const logBox = $('hotpatch-log');
  const logPre = logBox ? logBox.querySelector('pre') : null;
  if (logBox) { logBox.style.display = ''; }
  if (logPre) logPre.textContent = '正在拉取最新文件...\n';

  try {
    const r = await api('/api/update/hotpatch', { method: 'POST', body: { branch: 'main' } });
    if (r.error) {
      toast('热更新失败', r.error);
      btns.forEach(b => { b.disabled = false; b.textContent = '⚡ 热更新'; });
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
              logPre.textContent += '\n检测到 start-services.sh 更新：建议重启容器以使入口脚本变更生效。';
            }

            if (hasFrontend || hasWebServer) {
              if (logPre) {
                logPre.textContent += hasWebServer
                  ? '\n检测到后端已更新，正在等待服务恢复后自动重查更新状态（不再强制刷新页面）。'
                  : '\n前端文件已更新，将自动重查更新状态；如需立即加载新前端可手动刷新页面。';
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
    btns.forEach(b => { b.disabled = false; b.textContent = '⚡ 热更新（不重启容器）'; });
  }
}

// ------------------------
// OpenClaw install/update
// ------------------------
let ocPollTimer = null;

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

async function refreshOpenClaw(){
  const d = await api('/api/openclaw');
  if (d.error) return;

  $('oc-installed').innerHTML = d.installed
    ? `<span class="pulse online"></span>已安装`
    : `<span class="pulse offline"></span>未安装`;
  $('oc-version').textContent = d.version ? `版本：${d.version}` : '—';
  $('oc-gateway').innerHTML = d.gatewayRunning
    ? `<span class="pulse online"></span>运行中`
    : `<span class="pulse offline"></span>未启动`;
}

async function pollTask(taskId){
  if (ocPollTimer) clearInterval(ocPollTimer);
  const logEl = $('oc-log');
  if (!logEl) return;
  logEl.innerHTML = '';

  let lastSeq = 0;

  const tick = async () => {
    const st = await api('/api/openclaw/install/' + taskId + '?since=' + lastSeq);
    if (!st || st.error) return;

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
      toast(st.status === 'success' ? '完成' : '失败', st.status === 'success' ? 'OpenClaw 已就绪' : (st.log || '请查看日志'));
      refreshOpenClaw();
      refreshStatus();
    }
  };

  await tick();
  ocPollTimer = setInterval(tick, 600);
}

$('btn-oc-refresh').addEventListener('click', refreshOpenClaw);
$('btn-oc-install').addEventListener('click', async ()=>{
  const btn = $('btn-oc-install');
  btn.disabled = true;
  try{
    appendOcLogLine('[openclaw] 正在提交安装/更新任务...');
    const r = await api('/api/openclaw/update', { method:'POST' });
    if (!r.taskId){
      const i = await api('/api/openclaw/install', { method:'POST' });
      if (!i.taskId){
        appendOcLogLine(`[openclaw] 启动失败: ${i.error || r.error || '接口未返回 taskId'}`);
        toast('启动失败', i.error || r.error || '接口未返回 taskId');
        return;
      }
      toast('开始安装', '正在执行 OpenClaw 官方安装流程...');
      appendOcLogLine(`[openclaw] 任务已启动: ${i.taskId}`);
      pollTask(i.taskId);
    }else{
      toast('开始更新', '正在按稳定渠道更新 OpenClaw（未安装时会自动安装）...');
      appendOcLogLine(`[openclaw] 任务已启动: ${r.taskId}`);
      pollTask(r.taskId);
    }
  } catch (e) {
    appendOcLogLine(`[openclaw] 请求失败: ${e.message || e}`);
    toast('请求失败', e.message || String(e));
  }finally{
    btn.disabled = false;
  }
});

$('btn-oc-start').addEventListener('click', async ()=>{
  appendOcLogLine('[gateway] 正在提交重启请求...');
  const r = await api('/api/openclaw/start', { method:'POST' });
  if (r.success) {
    appendOcLogLine(`[gateway] ${r.message || '重启请求已提交'}`);
    appendOcLogLine('[gateway] 请稍候 2-5 秒，状态将自动刷新。');
    toast('已触发重启', r.message || 'Gateway 正在重启，请稍候');
  } else {
    appendOcLogLine(`[gateway] 重启失败: ${r.error || '请查看日志'}`);
    toast('重启失败', r.error || '请查看日志');
  }
  setTimeout(refreshOpenClaw, 2500);
});

// ------------------------
// AI config
// ------------------------
function providerFromConfig(cfg){
  if (!cfg || !cfg.providers) return '';
  const keys = Object.keys(cfg.providers);
  return keys[0] || '';
}

async function loadAIConfig(){
  const cfg = await api('/api/config');
  if (cfg.error) return;

  const p = providerFromConfig(cfg) || 'anthropic';
  $('ai-provider').value = p;
  $('ai-model').value = cfg.providers?.[p]?.model || '';
  $('ai-apikey').value = '';
  $('ai-custom-url').value = cfg.providers?.[p]?.baseUrl || '';
  $('ai-custom-url-wrap').hidden = p !== 'custom';

  $('wizard').hidden = !!(cfg.providers && Object.keys(cfg.providers).length);
}

$('ai-provider').addEventListener('change', ()=>{
  $('ai-custom-url-wrap').hidden = $('ai-provider').value !== 'custom';
});

$('btn-ai-load').addEventListener('click', loadAIConfig);
$('btn-ai-save').addEventListener('click', async ()=>{
  const provider = $('ai-provider').value;
  const model = $('ai-model').value.trim();
  const apiKey = $('ai-apikey').value;
  const baseUrl = $('ai-custom-url').value.trim();

  const update = { providers: {} };
  update.providers[provider] = { model };
  if (apiKey && apiKey !== '***') update.providers[provider].apiKey = apiKey;
  if (provider === 'custom' && baseUrl) update.providers[provider].baseUrl = baseUrl;

  const r = await api('/api/config', { method:'POST', body:update });
  toast(r.success ? '保存成功' : '保存失败', r.error || '');
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

function termAppendText(text){
  const el = $('terminal');
  appendColored(el, text, 5000, !!$('term-autoscroll')?.checked);
}

function terminalDisconnect(){
  if (termReconnectTimer) {
    clearTimeout(termReconnectTimer);
    termReconnectTimer = null;
  }
  if (termWs){
    try{ termWs.close(); }catch{}
    termWs = null;
  }
  $('term-state').textContent = '未连接';
}

function sendTerminalData(data){
  if (!termWs || termWs.readyState !== WebSocket.OPEN) return false;
  termWs.send(JSON.stringify({ type: 'input', data }));
  return true;
}

function sendTerminalResize(){
  if (!termWs || termWs.readyState !== WebSocket.OPEN) return;
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

  terminalEl.addEventListener('click', () => terminalEl.focus());

  window.addEventListener('resize', () => {
    if (termResizeTimer) clearTimeout(termResizeTimer);
    termResizeTimer = setTimeout(sendTerminalResize, 120);
  });

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

async function ensureTerminalWsToken(){
  if (termWsToken) return termWsToken;
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
  const token = await ensureTerminalWsToken();
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `${proto}//${location.host}/api/ws/terminal${tokenQuery}`;

  $('term-state').textContent = '连接中...';

  try{ termWs = new WebSocket(url); }
  catch{
    $('term-state').textContent = 'WebSocket 不可用';
    termAppendText('[terminal] WebSocket 不可用，无法建立交互会话\n');
    return;
  }

  termWs.onopen = ()=> {
    $('term-state').textContent = '已连接';
    termAppendText('[terminal] 已连接（PTY）。直接在此区域输入命令并按回车执行。\n');
    $('terminal')?.focus();
    sendTerminalResize();
  };
  termWs.onclose = (ev)=> {
    const code = Number(ev?.code || 0);
    const reason = ev?.reason ? ` reason=${ev.reason}` : '';
    $('term-state').textContent = code === 1008 ? '认证失效' : '已断开';
    termAppendText(`\n[terminal] 连接已断开 (code=${code}${reason}).\n`);
    if (code === 1008) {
      termWsToken = null;
    }
    termWs = null;
    if ($('page-terminal').classList.contains('active')) {
      if (termReconnectTimer) clearTimeout(termReconnectTimer);
      termReconnectTimer = setTimeout(() => {
        termReconnectTimer = null;
        terminalConnect();
      }, 1500);
      $('term-state').textContent = '重连中...';
    }
  };
  termWs.onerror = ()=> {
    $('term-state').textContent = '连接错误';
    termAppendText('\n[terminal] 连接错误。\n');
    termWsToken = null;
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
}

$('btn-term-clear').addEventListener('click', ()=>{ $('terminal').innerHTML=''; });
bindTerminalInteraction();

// clean ws when leaving
setInterval(()=>{
  if (!$('page-terminal').classList.contains('active')) terminalDisconnect();
}, 1000);

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

// Settings — timezone save
$('btn-settings-save').addEventListener('click', async ()=> {
  const tz = $('settings-tz') ? $('settings-tz').value : '';
  try {
    const r = await api('/api/config', { method: 'POST', body: { timezone: tz } });
    toast(r.success ? '已保存' : '保存失败', r.error || '');
  } catch(e) { toast('保存失败', e.message); }
});

$('btn-browser-save').addEventListener('click', async ()=> {
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
// STT config
// ------------------------
function bindSttVisibility(){
  const p = $('stt-provider').value;
  const isLocal = p === 'local';
  $('stt-key-wrap').hidden = isLocal;
  $('stt-local-hint').hidden = !isLocal;
}

$('stt-provider').addEventListener('change', bindSttVisibility);

async function loadSttConfig(){
  const d = await api('/api/stt/config');
  if (d.error) return;
  if (d.provider) $('stt-provider').value = d.provider;
  if (d.model) $('stt-model').value = d.model;
  $('stt-api-key').value = '';
  bindSttVisibility();
}

$('btn-stt-load').addEventListener('click', loadSttConfig);
$('btn-stt-save').addEventListener('click', async ()=>{
  const provider = $('stt-provider').value;
  const model = $('stt-model').value;
  const apiKey = $('stt-api-key').value;

  const body = { provider, model };
  if (provider !== 'local') body.apiKey = apiKey;

  const r = await api('/api/stt/config', { method:'POST', body });
  toast(r.success ? '保存成功' : '保存失败', r.error || '');
});

$('btn-stt-install').addEventListener('click', async ()=>{
  const r = await api('/api/stt/install-local', { method:'POST' });
  toast(r.success ? '已触发安装' : '安装失败', r.output || r.error || '');
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
