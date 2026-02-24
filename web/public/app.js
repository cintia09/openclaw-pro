/* ============================================================
   app.js — OpenClaw Web Panel (no framework)
   - Hash routing, sidebar UX, fade transitions
   - Plugins market + Terminal (WebSocket logs)
   - Keep all existing functionality
   ============================================================ */

function $(id){ return document.getElementById(id); }
function q(sel, root=document){ return root.querySelector(sel); }
function qa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

// ------------------------
// API helper
// ------------------------
async function api(url, opts={}){
  try{
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });

    if (res.status === 401){
      window.location.href = '/login.html';
      return { error: 'unauthorized' };
    }

    let data = {};
    try{ data = await res.json(); }catch{ data = {}; }
    return data;
  }catch(e){
    console.error('api error', e);
    return { error: e.message };
  }
}

// ------------------------
// Toast
// ------------------------
let toastTimer = null;
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
  { id: 'ai', title: 'AI 配置' },
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
  if (route === 'openclaw') refreshOpenClaw();
  if (route === 'ai') loadAIConfig();
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
  const s = await api('/api/status');
  if (s.error) return;

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
  }

  // Settings page
  if ($('settings-current-ver')) {
    $('settings-current-ver').textContent = u.currentVersion || '—';
    $('settings-latest-ver').textContent = u.latestVersion || '—';
    const statusEl = $('settings-update-status');
    const linkEl = $('settings-release-link');
    if (u.hasUpdate) {
      statusEl.innerHTML = '<span style="color:#4ade80">🆕 有新版本</span>';
      if (linkEl && u.releaseUrl) { linkEl.href = u.releaseUrl; linkEl.style.display = ''; }
    } else if (u.latestVersion) {
      statusEl.innerHTML = '<span style="color:#888">✅ 已是最新</span>';
      if (linkEl) linkEl.style.display = 'none';
    } else {
      statusEl.textContent = u.error || '检查失败';
      if (linkEl) linkEl.style.display = 'none';
    }
  }

  return u;
}

$('btn-refresh-status').addEventListener('click', refreshStatus);
$('btn-restart-gateway').addEventListener('click', async ()=>{
  const r = await api('/api/restart', { method:'POST' });
  toast(r.success ? '已触发重启' : '重启失败', r.output || r.error || '');
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

// ------------------------
// OpenClaw install/update
// ------------------------
let ocPollTimer = null;
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
  logEl.textContent = '';

  ocPollTimer = setInterval(async ()=>{
    const st = await api('/api/openclaw/install/' + taskId);
    if (!st || st.error) return;
    logEl.textContent = st.log || '';
    logEl.scrollTop = logEl.scrollHeight;

    if (st.status && st.status !== 'running'){
      clearInterval(ocPollTimer);
      ocPollTimer = null;
      toast(st.status === 'success' ? '完成' : '失败', st.status === 'success' ? 'OpenClaw 已就绪' : (st.log || '请查看日志'));
      refreshOpenClaw();
      refreshStatus();
    }
  }, 1500);
}

$('btn-oc-refresh').addEventListener('click', refreshOpenClaw);
$('btn-oc-install').addEventListener('click', async ()=>{
  const btn = $('btn-oc-install');
  btn.disabled = true;
  try{
    const r = await api('/api/openclaw/update', { method:'POST' });
    if (!r.taskId){
      const i = await api('/api/openclaw/install', { method:'POST' });
      if (!i.taskId){ toast('启动失败', i.error||''); return; }
      toast('开始安装', '正在拉取 OpenClaw...');
      pollTask(i.taskId);
    }else{
      toast('开始更新', '正在更新 OpenClaw...');
      pollTask(r.taskId);
    }
  }finally{
    btn.disabled = false;
  }
});

$('btn-oc-start').addEventListener('click', async ()=>{
  const r = await api('/api/openclaw/start', { method:'POST' });
  toast(r.success ? '已触发启动' : '启动失败', r.output || r.error || '');
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
// Terminal (WebSocket logs)
// ------------------------
let termWs = null;
let termPaused = false;

function colorizeLogLine(line){
  const dateLike = /^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
  let safe = escapeHtml(line);

  if (/\b(ERROR|Error|ERR)\b/.test(line)) safe = `<span class="term-error">${safe}</span>`;
  else if (/\b(WARN|Warning|WRN)\b/.test(line)) safe = `<span class="term-warn">${safe}</span>`;

  const m = line.match(dateLike);
  if (m){
    const prefix = escapeHtml(m[1]);
    safe = safe.replace(prefix, `<span class="term-date">${prefix}</span>`);
  }

  return safe;
}

function termAppend(lines){
  const el = $('terminal');
  const arr = Array.isArray(lines) ? lines : String(lines||'').split('\n');

  const html = arr
    .filter(x=>x!==undefined && x!==null)
    .map(l=> `<span class="term-line">${colorizeLogLine(l)}</span>`)
    .join('');

  el.insertAdjacentHTML('beforeend', html);

  // cap DOM size
  const maxLines = 3000;
  const nodes = el.querySelectorAll('.term-line');
  if (nodes.length > maxLines){
    for (let i=0;i<nodes.length-maxLines;i++) nodes[i].remove();
  }

  if ($('term-autoscroll').checked){
    el.scrollTop = el.scrollHeight;
  }
}

function terminalDisconnect(){
  if (termWs){
    try{ termWs.close(); }catch{}
    termWs = null;
  }
  $('term-state').textContent = '未连接';
}

function terminalConnect(){
  if (!$('page-terminal').classList.contains('active')) return;
  if (termWs && (termWs.readyState === WebSocket.OPEN || termWs.readyState === WebSocket.CONNECTING)) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/ws/logs`;

  $('term-state').textContent = '连接中...';

  try{ termWs = new WebSocket(url); }
  catch{
    $('term-state').textContent = 'WebSocket 不可用';
    return;
  }

  termWs.onopen = ()=> { $('term-state').textContent = '已连接'; };
  termWs.onclose = ()=> { $('term-state').textContent = '已断开'; termWs=null; };
  termWs.onerror = ()=> { $('term-state').textContent = '连接错误'; };

  termWs.onmessage = (ev)=>{
    if (termPaused) return;
    try{
      const msg = JSON.parse(ev.data);
      if (msg.type === 'lines') termAppend(msg.lines);
      else if (msg.type === 'line') termAppend([msg.line]);
      else termAppend([String(ev.data||'')]);
    }catch{
      termAppend([String(ev.data||'')]);
    }
  };
}

$('btn-term-clear').addEventListener('click', ()=>{ $('terminal').innerHTML=''; });
$('btn-term-pause').addEventListener('click', ()=>{
  termPaused = !termPaused;
  $('btn-term-pause').textContent = termPaused ? '继续' : '暂停';
});

$('btn-term-download').addEventListener('click', async ()=>{
  const d = await api('/api/logs?lines=5000');
  const text = d.logs || '';
  const blob = new Blob([text], { type:'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `openclaw-gateway-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
});

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
  $('log-viewer').textContent = d.logs || '';
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
