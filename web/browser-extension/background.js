/**
 * OpenClaw Browser Bridge — Service Worker (background.js)
 *
 * 功能：
 * 1. 读取用户配置的服务器地址 + 配对码
 * 2. 通过 WebSocket 连接到 OpenClaw 服务端 (/api/ws/browser-bridge)
 * 3. 接收 CDP 命令 → chrome.debugger 执行 → 回传结果
 * 4. 维持心跳 & 断线重连
 */

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let config = { serverUrl: '', pairCode: '', deviceName: '' };
let connState = 'disconnected'; // disconnected | connecting | connected

// ─── 初始化 ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['serverUrl', 'pairCode', 'deviceName'], (r) => {
    if (r.serverUrl) config.serverUrl = r.serverUrl;
    if (r.pairCode)  config.pairCode  = r.pairCode;
    if (r.deviceName) config.deviceName = r.deviceName;
    if (config.serverUrl && config.pairCode) connect();
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['serverUrl', 'pairCode', 'deviceName'], (r) => {
    if (r.serverUrl) config.serverUrl = r.serverUrl;
    if (r.pairCode)  config.pairCode  = r.pairCode;
    if (r.deviceName) config.deviceName = r.deviceName;
    if (config.serverUrl && config.pairCode) connect();
  });
});

// ─── 来自 popup 的消息 ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({ state: connState, config });
    return;
  }
  if (msg.type === 'connect') {
    config.serverUrl  = msg.serverUrl  || '';
    config.pairCode   = msg.pairCode   || '';
    config.deviceName = msg.deviceName || '';
    chrome.storage.local.set(config);
    disconnect();
    connect();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return;
  }
});

// ─── WebSocket 连接 ─────────────────────────────────────
function buildWsUrl() {
  let base = config.serverUrl.replace(/\/+$/, '');
  // http → ws, https → wss
  base = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  if (!/^wss?:/.test(base)) base = 'ws://' + base;
  return `${base}/api/ws/browser-bridge?code=${encodeURIComponent(config.pairCode)}&name=${encodeURIComponent(config.deviceName || 'Chrome')}`;
}

function connect() {
  if (ws) return;
  connState = 'connecting';
  broadcastState();

  try {
    ws = new WebSocket(buildWsUrl());
  } catch (e) {
    console.error('[bridge] ws create error', e);
    connState = 'disconnected';
    broadcastState();
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[bridge] connected');
    connState = 'connected';
    broadcastState();
    startHeartbeat();
  };

  ws.onmessage = async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    if (msg.type === 'pong') return; // heartbeat reply

    if (msg.type === 'cdp') {
      // Execute CDP command via chrome.debugger
      const { id, targetId, method, params } = msg;
      try {
        const result = await executeCdp(targetId, method, params);
        wsSend({ type: 'cdp-result', id, result });
      } catch (e) {
        wsSend({ type: 'cdp-error', id, error: e.message || String(e) });
      }
      return;
    }

    if (msg.type === 'list-targets') {
      // Return list of open tabs
      try {
        const tabs = await chrome.tabs.query({});
        const targets = tabs.map(t => ({
          id: String(t.id),
          title: t.title || '',
          url: t.url || '',
          type: 'page'
        }));
        wsSend({ type: 'targets', requestId: msg.requestId, targets });
      } catch (e) {
        wsSend({ type: 'targets', requestId: msg.requestId, targets: [], error: e.message });
      }
      return;
    }

    if (msg.type === 'attach') {
      try {
        await debuggerAttach(Number(msg.tabId));
        wsSend({ type: 'attach-result', tabId: msg.tabId, ok: true });
      } catch (e) {
        wsSend({ type: 'attach-result', tabId: msg.tabId, ok: false, error: e.message });
      }
      return;
    }

    if (msg.type === 'detach') {
      try {
        await debuggerDetach(Number(msg.tabId));
        wsSend({ type: 'detach-result', tabId: msg.tabId, ok: true });
      } catch (e) {
        wsSend({ type: 'detach-result', tabId: msg.tabId, ok: false, error: e.message });
      }
      return;
    }
  };

  ws.onclose = () => {
    console.log('[bridge] disconnected');
    cleanup();
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[bridge] ws error', e);
  };
}

function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    try { ws.close(); } catch {}
  }
  cleanup();
}

function cleanup() {
  ws = null;
  connState = 'disconnected';
  broadcastState();
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!config.serverUrl || !config.pairCode) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    wsSend({ type: 'ping' });
  }, 25000);
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'stateChanged', state: connState }).catch(() => {});
}

// ─── chrome.debugger 封装 ───────────────────────────────
const _attached = new Set(); // tabId set

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    if (_attached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      _attached.add(tabId);
      resolve();
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve, reject) => {
    if (!_attached.has(tabId)) return resolve();
    chrome.debugger.detach({ tabId }, () => {
      _attached.delete(tabId);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

function executeCdp(targetId, method, params) {
  const tabId = Number(targetId);
  return new Promise(async (resolve, reject) => {
    // Auto-attach if not attached
    if (!_attached.has(tabId)) {
      try { await debuggerAttach(tabId); } catch (e) { return reject(e); }
    }
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(result);
    });
  });
}

// Cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (_attached.has(tabId)) {
    _attached.delete(tabId);
  }
});

// Cleanup on debugger detach
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) _attached.delete(source.tabId);
});
