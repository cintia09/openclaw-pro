function $(id){return document.getElementById(id)}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

function setHint(msg, type = '') {
  const el = $('login-hint');
  el.textContent = msg || '';
  el.className = 'auth-hint' + (type ? ` ${type}` : '');
}

let setupMode = false;

function setSetupMode(on) {
  setupMode = !!on;
  $('setup-confirm-field').style.display = setupMode ? '' : 'none';
  $('login-username').value = 'admin';
  $('login-username').disabled = true;
  $('login-submit').textContent = setupMode ? '设置密码' : '登录';
  $('login-password').setAttribute('autocomplete', setupMode ? 'new-password' : 'current-password');
  setHint(setupMode ? '首次使用：请先设置管理密码（至少8位）' : '', setupMode ? '' : '');
}

async function refreshBootstrapStatus() {
  try {
    const r = await api('/api/bootstrap/status');
    if (r.ok && r.data && typeof r.data.setupRequired === 'boolean') {
      setSetupMode(r.data.setupRequired);
    }
  } catch {}
}

async function doSubmit() {
  const username = $('login-username').value.trim() || 'admin';
  const password = $('login-password').value;

  if (!password) {
    setHint(setupMode ? '请输入密码' : '请输入用户名和密码', 'error');
    return;
  }

  if (setupMode) {
    const password2 = $('login-password2').value;
    if (!password2) return setHint('请再次输入密码', 'error');
    if (password !== password2) return setHint('两次输入的密码不一致', 'error');
    if (String(password).length < 8) return setHint('密码至少8位', 'error');
  }

  const btn = $('login-submit');
  btn.disabled = true;
  btn.textContent = setupMode ? '设置中...' : '登录中...';
  setHint('');

  try {
    if (setupMode) {
      const r = await api('/api/bootstrap/setup', { method: 'POST', body: { password } });
      if (r.ok && r.data && r.data.success) {
        window.location.href = '/';
        return;
      }
      setHint(r.data?.error || '设置失败', 'error');
      return;
    }

    const r = await api('/api/login', { method: 'POST', body: { username, password } });
    if (r.ok && r.data && r.data.success) {
      window.location.href = '/';
      return;
    }
    if (r.status === 409 && r.data?.setupRequired) {
      setSetupMode(true);
      setHint(r.data?.error || '需要先初始化', 'error');
      return;
    }
    setHint(r.data?.error || '登录失败', 'error');
  } catch (e) {
    setHint('网络错误：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = setupMode ? '设置密码' : '登录';
  }
}

$('login-submit').addEventListener('click', doSubmit);
$('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });
$('login-password2')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });

$('login-username').value = 'admin';
$('login-password').focus();
refreshBootstrapStatus();
