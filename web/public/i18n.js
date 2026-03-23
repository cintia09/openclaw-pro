/* ============================================================
   i18n.js — OpenClaw Web Panel Internationalization
   Supports: zh (Chinese, source language), en (English)
   Architecture:
     - Chinese text is used as i18n keys (self-documenting)
     - t(zhKey, ...args) returns English when locale='en',
       passthrough when locale='zh'
     - applyI18n() walks the DOM and auto-translates text nodes
     - MutationObserver keeps dynamic content translated
   ============================================================ */

(function () {
  'use strict';

  // --------------- locale management ---------------
  const STORAGE_KEY = 'openclaw-lang';
  let _locale = 'zh';

  function _detectLocale() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'zh') return saved;
    } catch {}
    const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
    return nav.startsWith('zh') ? 'zh' : 'en';
  }

  _locale = _detectLocale();

  function getLocale() { return _locale; }

  function setLocale(lang) {
    if (lang !== 'en' && lang !== 'zh') return;
    _locale = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    applyI18n();
    // Re-render dynamic content if the app exposes a refresh hook
    if (typeof window._i18nRefresh === 'function') window._i18nRefresh();
  }

  // --------------- translation dictionary (zh → en) ---------------
  // Organized by functional area. Chinese string is the key.
  const _en = {
    // ─── Navigation & Layout ──────────────────────────
    '管理面板': 'Control Panel',
    'OpenClaw 管理面板': 'OpenClaw Control Panel',
    '总览': 'Overview',
    '仪表盘': 'Dashboard',
    'OpenClaw 控制台': 'OpenClaw Console',
    '接入模型配置': 'Model Configuration',
    '消息平台': 'Messaging Platforms',
    '插件市场': 'Plugin Market',
    '远端设备管理': 'Remote Device Management',
    '运维与系统': 'Operations & System',
    '终端': 'Terminal',
    '系统设置': 'System Settings',
    '日志': 'Logs',
    '有可用更新': 'Update available',
    '隐藏侧边栏': 'Hide sidebar',
    '显示侧边栏': 'Show sidebar',
    '退出': 'Logout',
    '打开 OpenClaw Gateway 控制台': 'Open OpenClaw Gateway Console',
    '应用中心': 'App Center',
    '还没有安装任何应用': 'No apps installed yet',
    '在 OpenClaw 对话中说「帮我安装 xxx 应用」即可自动搜索并安装': 'Say "install xxx app" in OpenClaw conversation to auto-search and install',
    '运行中': 'Running',
    '已停止': 'Stopped',
    '未知': 'Unknown',
    '安装': 'Install',
    '安装中...': 'Installing...',
    '已安装': 'Installed',
    '卸载': 'Uninstall',
    '打开': 'Open',

    // ─── Dashboard ───────────────────────────────────
    '系统概览': 'System Overview',
    '服务状态 / 运行时间 / 资源使用': 'Service status / uptime / resource usage',
    '刷新': 'Refresh',
    '在线': 'Online',
    '离线': 'Offline',
    '面板服务运行中': 'Panel service running',
    '资源': 'Resources',
    '终端状态': 'Terminal Status',

    // ─── Update Banner ───────────────────────────────
    '发现新版本': 'New version available',
    '当前版本': 'Current version',
    '最新版本': 'Latest version',
    '查看更新': 'View update',
    '关闭': 'Close',
    '需要完整更新': 'Full update required',
    '可热更新': 'Hot-update available',
    '已是最新': 'Up to date',
    '已是最新版本': 'Already up to date',
    '热更新': 'Hot Update',
    '强制热更新': 'Force Hot Update',
    '此版本需要完整更新': 'This version requires a full update',
    '需要完整更新时，请重新执行一键安装脚本：': 'When a full update is required, re-run the one-click install script:',
    '查看 Release 页面': 'View Release Page',
    '检查更新': 'Check for Updates',
    '版本号相同，点击强制热更新可重新同步远程文件': 'Same version — click Force Hot Update to re-sync remote files',
    '此版本涉及系统底层更改，热更新不适用': 'This version involves system-level changes; hot update is not applicable',
    '请重新执行一键安装脚本，安装器会自动检测并升级到新版本。': 'Please re-run the install script; the installer will auto-detect and upgrade.',
    '不重启容器）': 'without restarting container)',

    // ─── OpenClaw Console ────────────────────────────
    '安装 / 版本 / Gateway 运行状态': 'Installation / Version / Gateway status',
    '安装状态': 'Install Status',
    'Gateway 状态': 'Gateway Status',
    '后台进程检测': 'Background process detection',
    '操作': 'Actions',
    '安装': 'Install',
    '卸载': 'Uninstall',
    '配置恢复': 'Restore Config',
    '重启 Gateway': 'Restart Gateway',
    '配置导出': 'Export Config',
    '配置导入': 'Import Config',
    '迁移导出': 'Migration Export',
    '迁移导入': 'Migration Import',
    '更新状态：自动检查中': 'Update status: checking...',
    '选择历史版本...': 'Select version...',
    '安装此版本': 'Install This Version',
    '加载版本列表': 'Load Version List',
    '操作日志': 'Operation Log',
    '安装按钮会自动判断是否需要更新，详细日志请到"日志"页面查看': 'The install button auto-detects updates. See the Logs page for details.',
    '安装中': 'Installing',
    '更新中': 'Updating',
    '卸载中': 'Uninstalling',
    '检测中...': 'Detecting...',
    '处理中': 'Processing',
    '已安装': 'Installed',
    '未安装': 'Not Installed',
    '运行中': 'Running',
    '未启动': 'Not Started',
    '已卸载': 'Uninstalled',
    '启动中': 'Starting',
    '待配对': 'Awaiting Pairing',
    '修复中': 'Repairing',
    '初始化中': 'Initializing',
    '初始化中）': 'Initializing)',
    '配置恢复中': 'Restoring config',
    'Gateway 启动中': 'Gateway starting',
    '刷新中...': 'Refreshing...',
    '检查中...': 'Checking...',
    '加载中...': 'Loading...',
    '加载中': 'Loading',
    '更新状态': 'Update status',

    // ─── OpenClaw Console — Status Details ───────────
    '开发版（dev）': 'Dev build',
    '开发版': 'Dev build',
    '未标注版本': 'Unlabeled version',
    '源码安装': 'Source install',
    'npm 安装': 'npm install',
    '二进制安装': 'Binary install',
    '版本探测': 'Version probe',
    '健康检查正常': 'Health check OK',
    '等待控制台配对': 'Waiting for console pairing',
    '进程已拉起': 'Process started',
    '未检测到运行中的 Gateway': 'No running Gateway detected',
    'watchdog未运行': 'Watchdog not running',
    '终端: 正常(PTY)': 'Terminal: OK (PTY)',
    '终端: 正常(兼容模式)': 'Terminal: OK (compat mode)',
    '终端后端未就绪': 'Terminal backend not ready',
    '终端: 状态未知': 'Terminal: status unknown',
    '终端就绪': 'Terminal ready',
    '交互模式：PTY': 'Interactive mode: PTY',
    '终端异常': 'Terminal error',
    '离线/未启用': 'Offline / not enabled',
    '未配置域名': 'Domain not configured',
    '当前未运行': 'Not running',
    '当前未安装 OpenClaw': 'OpenClaw not installed',

    // ─── OpenClaw Console — Operations ───────────────
    '开始安装': 'Starting install',
    '开始安装 OpenClaw': 'Starting OpenClaw install',
    '开始更新': 'Starting update',
    '开始更新 OpenClaw': 'Starting OpenClaw update',
    '开始卸载': 'Starting uninstall',
    '开始卸载 OpenClaw': 'Starting OpenClaw uninstall',
    '开始安装指定版本': 'Starting install of specified version',
    '安装完成': 'Installation complete',
    '安装成功': 'Installed successfully',
    '安装失败': 'Installation failed',
    '安装启动失败': 'Failed to start installation',
    '安装任务已启动': 'Install task started',
    '安装任务创建失败': 'Failed to create install task',
    '更新成功': 'Update successful',
    '更新失败': 'Update failed',
    '更新启动失败': 'Failed to start update',
    '更新任务已启动': 'Update task started',
    '更新已取消': 'Update cancelled',
    '卸载失败': 'Uninstall failed',
    '卸载启动失败': 'Failed to start uninstall',
    '卸载任务创建失败': 'Failed to create uninstall task',
    '卸载任务执行中': 'Uninstall in progress',
    '卸载请求失败': 'Uninstall request failed',
    '卸载期间将禁止安装/更新/重启': 'Install/update/restart disabled during uninstall',
    '任务已启动': 'Task started',
    '任务执行超时': 'Task execution timeout',
    '任务状态异常': 'Task status error',
    '任务状态轮询失败': 'Task polling failed',
    '任务结束': 'Task ended',
    '任务超时': 'Task timeout',
    '任务进行中': 'Task in progress',
    '可执行安装': 'Ready to install',
    '可更新': 'Update available',
    '当前有其他操作在执行': 'Another operation is in progress',
    '安装/更新/卸载任务正在执行': 'Install/update/uninstall task in progress',
    '安装/更新任务正在执行': 'Install/update task in progress',
    '安装/更新或网关重启执行中': 'Install/update or gateway restart in progress',
    '安装/更新执行中': 'Install/update in progress',
    '暂不可配置恢复': 'Config restore not available now',
    '暂不可重启 Gateway': 'Gateway restart not available now',
    '将使用 A/B 备份更新模式': 'Will use A/B backup update mode',
    '将使用官方 npm 安装': 'Will use official npm install',
    '将移除本地安装与源码目录': 'Will remove local install and source directories',
    '已存在安装/更新任务': 'An install/update task already exists',
    '二次确认': 'Confirmation required',
    '已已取消': 'Cancelled',
    '已取消': 'Cancelled',
    '已取消更新': 'Update cancelled',

    // ─── OpenClaw Console — Config Export/Import/Migration ───
    '打包中': 'Packaging...',
    '导出失败': 'Export failed',
    '导入中': 'Importing...',
    '导入失败': 'Import failed',
    '导入完成': 'Import complete',
    '已下载迁移包': 'Migration package downloaded',
    '已保存迁移包': 'Migration package saved',
    '备份列表读取失败': 'Failed to read backup list',
    '压缩包': 'Archive',
    '参数错误': 'Parameter error',
    '操作失败': 'Operation failed',
    '配置文件': 'Configuration files',
    '加密密钥': 'Encryption keys',
    '设备身份': 'Device identity',
    '定时任务和执行记录': 'Scheduled tasks and execution records',
    '多文件备份可选择恢复全部或单个文件': 'Multi-file backup: choose to restore all or individual files',
    '可用备份': 'Available backups',
    '全部': 'All',
    '恢复失败': 'Restore failed',
    '已恢复': 'Restored',
    '配置恢复完成': 'Config restore complete',
    '配置恢复失败': 'Config restore failed',

    // ─── OpenClaw Console — Version History ──────────
    '历史版本选择安装': 'Install from version history',
    '当前)': 'current)',
    '个版本': ' versions',
    '无法获取远端版本': 'Cannot fetch remote version',
    '无法获取远端最新版本': 'Cannot fetch latest remote version',
    '无法获取当前 OpenClaw 状态': 'Cannot get current OpenClaw status',

    // ─── Hot-patch ───────────────────────────────────
    '热更新完成': 'Hot update complete',
    '强制热更新失败': 'Force hot update failed',
    '热更新已开始': 'Hot update started',
    '强制更新中': 'Force updating',
    '个文件已更新': ' file(s) updated',
    '前端文件已更新': 'Frontend files updated',
    '所有文件已是最新': 'All files already up to date',
    '恢复后可再次热更新': 'Can hot-update again after restore',
    '如需立即加载新前端可手动刷新页面': 'Manually refresh the page to load new frontend',
    '如状态未更新请稍后手动刷新页面': 'If status not updated, manually refresh the page later',
    '已自动刷新更新状态': 'Update status auto-refreshed',
    '将自动重查更新状态': 'Will auto-recheck update status',

    // ─── Gateway ─────────────────────────────────────
    'Gateway 未就绪': 'Gateway not ready',
    'Gateway 已重启': 'Gateway restarted',
    'Gateway 重启提示': 'Gateway restart notice',
    'Gateway 当前未运行': 'Gateway not currently running',
    'Gateway 已恢复运行': 'Gateway recovered',
    '已触发重启': 'Restart triggered',
    '重启失败': 'Restart failed',
    '已重启': 'Restarted',
    '弹窗被拦截': 'Popup blocked',
    '已在当前页面打开 Gateway 控制台': 'Opened Gateway console in current page',
    '控制台': 'Console',
    '冷启动可能需要更长时间': 'Cold start may take longer',

    // ─── AI Model Configuration ──────────────────────
    '配置 API Key / 认证、模型选择': 'Configure API Key / auth, model selection',
    '刷新配置': 'Refresh Config',
    '状态：待读取': 'Status: pending',
    '新增 API Key / 设备授权': 'Add API Key / Device Auth',
    '已配置 API Key / 授权': 'Configured API Keys / Auth',
    '模型来源 (Provider)': 'Model Provider',
    '常用': 'Popular',
    '国际': 'International',
    '中国': 'China',
    '网关 / 代理': 'Gateway / Proxy',
    '本地': 'Local',
    '其他': 'Other',
    '阿里云百炼 (Bailian)': 'Alibaba Cloud Bailian',
    '智谱 Z.AI (GLM)': 'Zhipu Z.AI (GLM)',
    '小米 MiMo': 'Xiaomi MiMo',
    '百度千帆 (Qianfan)': 'Baidu Qianfan',
    '火山引擎 (Volcengine)': 'Volcengine',
    '自定义端点': 'Custom Endpoint',
    'API 端点 (Base URL)': 'API Endpoint (Base URL)',
    '同一个 Provider 支持多个 API Key，每个 Key 独立使用': 'Each Provider supports multiple API Keys, each used independently',
    '添加此 API Key': 'Add This API Key',
    'OAuth / 设备授权': 'OAuth / Device Auth',
    '启动设备授权': 'Start Device Auth',
    '点击按钮启动设备授权流程': 'Click to start device authorization flow',
    '选择已配置的 Key / 授权': 'Select Configured Key / Auth',
    '— 请选择 —': '— Select —',
    'Key 信息': 'Key Info',
    '删除此 Key': 'Delete This Key',
    '可用模型列表': 'Available Models',
    '点击模型名称可自动填充到下方配置': 'Click model name to auto-fill configuration below',
    '模型配置': 'Model Configuration',
    '主代理模型 (Primary)': 'Primary Agent Model',
    '主代理 Fallback 模型': 'Primary Fallback Model',
    '主模型不可用时使用，逗号分隔多个': 'Used when primary is unavailable, comma-separated',
    '子代理模型 (Sub Agent)': 'Sub Agent Model',
    '子代理 Fallback 模型': 'Sub Agent Fallback Model',
    '保存模型配置': 'Save Model Config',
    '已读取': 'Loaded',
    '保存中': 'Saving',
    '保存成功': 'Saved successfully',
    '保存失败': 'Save failed',
    '已填充': 'Filled in',
    '主模型': 'Primary model',
    '子代理模型': 'Sub agent model',
    '主代理 Fallbacks': 'Primary fallbacks',

    // ─── AI — API Key Management ─────────────────────
    '个已配置 Key': ' configured key(s)',
    '已删除': 'Deleted',
    '删除失败': 'Delete failed',
    '个 Key': ' key(s)',
    '成功获取': 'Fetched successfully',
    '个模型': ' model(s)',
    '获取模型列表失败': 'Failed to fetch model list',
    'Ollama API Key (可选)': 'Ollama API Key (optional)',
    'API Key (可选)': 'API Key (optional)',
    'vLLM API Key (可选)': 'vLLM API Key (optional)',
    '留空即可': 'Leave empty',
    'Ollama (本地)': 'Ollama (Local)',
    'LM Studio (本地)': 'LM Studio (Local)',
    'vLLM (本地)': 'vLLM (Local)',
    '已保存': 'Saved',
    '先验证 API Key 有效性': 'Verifying API Key first',
    '使用设备授权登录': 'Using device auth login',
    '个人版或企业版）': 'personal or enterprise)',
    '按钮直接添加': 'button to add directly',

    // ─── AI — OAuth Flow ─────────────────────────────
    '授权进行中': 'Authorization in progress',
    '授权成功': 'Authorization successful',
    '授权码': 'Auth code',
    '正在启动授权…': 'Starting authorization...',
    '启动失败，请重试': 'Start failed, please retry',
    '等待用户完成授权…': 'Waiting for user to complete authorization...',
    '点击此处打开 GitHub 授权页面': 'Click here to open GitHub auth page',
    '请点击上方链接，在 GitHub 页面中输入授权码完成认证': 'Click the link above and enter the auth code on GitHub to complete authentication',
    '重新授权': 'Re-authorize',
    '可再次点击刷新授权': 'Click again to refresh authorization',
    '点击按钮启动设备授权流程': 'Click button to start device auth flow',
    '必须先完成 OAuth 授权流程': 'Must complete OAuth authorization first',
    '无法启动 OAuth 登录': 'Cannot start OAuth login',
    '在弹出页面中登录 GitHub 并授权设备': 'Log in to GitHub and authorize the device in the popup',
    '完成 OAuth 登录': 'Complete OAuth login',
    '成功后自动获取可用模型': 'Available models will be fetched automatically after success',
    '已成功': 'Succeeded',
    '按钮': 'button',
    '按钮后重试': 'button and retry',

    // ─── AI — Save Config ────────────────────────────
    '开始保存': 'Saving',
    '开始保存模型配置': 'Saving model configuration',
    '接口返回异常': 'API returned an error',
    '接口返回空响应': 'API returned empty response',
    '出错': 'Error',
    '模型不可用': 'Model unavailable',
    '模型验证通过': 'Model validation passed',

    // ─── Messaging ───────────────────────────────────
    '配置 OpenClaw 接入的消息平台 · 保存后需重启 Gateway 生效': 'Configure messaging platforms · Restart Gateway after saving',
    '重启 Gateway 生效': 'Restart Gateway to apply',
    '飞书': 'Feishu (Lark)',
    '启用': 'Enabled',
    '私聊策略': 'DM Policy',
    '开放 (open)': 'Open',
    '受限 (restricted)': 'Restricted',
    '机器人名称': 'Bot Name',
    '保存飞书配置': 'Save Feishu Config',
    '保存 Discord 配置': 'Save Discord Config',
    '保存 Telegram 配置': 'Save Telegram Config',
    '保存 Signal 配置': 'Save Signal Config',
    '保存 WhatsApp 配置': 'Save WhatsApp Config',
    '保存微信配置': 'Save WeChat Config',
    '配置指引': 'Setup Guide',
    '必填': 'Required',
    '审批 Discord 配对码': 'Approve Discord Pairing Code',
    '配对码': 'Pairing Code',
    '批准配对': 'Approve Pairing',
    '群组策略': 'Group Policy',
    '白名单 (allowlist)': 'Allowlist',
    '流式回复': 'Streaming Reply',
    '服务器 ID 列表 (Guild IDs)': 'Server ID List (Guild IDs)',
    '群组历史条数': 'Group History Count',
    '私聊历史条数': 'DM History Count',
    '保存配置并重启 Gateway 后才会建立连接': 'Save config and restart Gateway to establish connection',
    '正在检查 Discord 运行状态...': 'Checking Discord runtime status...',
    '暂时无法确认 Discord 连接状态': 'Cannot confirm Discord connection status at this time',
    '最近未检测到 Discord 连接错误': 'No recent Discord connection errors detected',
    '审批成功': 'Approval successful',
    '审批失败': 'Approval failed',
    '审批中': 'Approving',
    '手机号': 'Phone Number',
    '高级选项': 'Advanced Options',
    '每行一个，或逗号分隔': 'One per line, or comma-separated',
    '服务器数': 'Server count',
    '多服务器模式': 'Multi-server mode',
    '多服务器）': 'multi-server)',
    '会话历史': 'Session history',

    // ─── Remote Device Management ────────────────────
    '远端节点状态': 'Remote Node Status',
    '设备配对审批': 'Device Pairing Approval',
    '已配对设备': 'Paired Devices',
    '安全配置': 'Security Configuration',
    '设备自动审批': 'Auto-approve Devices',
    '关闭（推荐）': 'Off (recommended)',
    '开启': 'On',
    'Node 浏览器代理模式': 'Node Browser Proxy Mode',
    '接入后自动启用）': 'auto-enable after connecting)',
    '禁用浏览器控制）': 'disable browser control)',
    '命令执行安全策略': 'Command Execution Security',
    '默认，自动允许）': 'default, auto-allow)',
    '需要节点本地逐次审批）': 'require local approval on each execution)',
    '禁止执行）': 'deny execution)',
    '禁止执行的命令': 'Blocked Commands',
    '保存安全配置': 'Save Security Config',
    '快速连接': 'Quick Connect',
    '在线节点列表': 'Online node list',
    '暂无已配对的 Node 节点': 'No paired Node nodes',
    '暂无已配对设备': 'No paired devices',
    '暂无待审批的配对请求': 'No pending pairing requests',
    '取消配对': 'Unpair',
    '已取消配对': 'Unpaired',
    '取消配对后当前会话会失效': 'Current session will be invalidated after unpairing',
    '取消配对仅删除配对记录': 'Unpairing only removes pairing records',
    '如果远端是后台运行': 'If remote is running in background',
    '安全配置已保存': 'Security config saved',
    '复制快速连接命令': 'Copy quick connect command',
    '已复制': 'Copied',
    '复制失败': 'Copy failed',
    '名称': 'Name',
    '平台': 'Platform',
    '时间': 'Time',
    '状态': 'Status',
    '后台命令加载失败': 'Failed to load background commands',
    '命令加载失败': 'Failed to load commands',
    '命令会根据当前 HTTPS 配置决定是否保留 NODE_TLS_REJECT_UNAUTHORIZED=0': 'Command will determine whether to keep NODE_TLS_REJECT_UNAUTHORIZED=0 based on current HTTPS config',
    '后台模式会为当前网关使用独立目录': 'Background mode uses a separate directory for the current gateway',
    '不同网关可同时运行': 'Multiple gateways can run simultaneously',
    '后台运行': 'Background',
    '前台）': 'foreground)',
    '后台）': 'background)',
    '审批于': 'Approved at',
    '审批通过': 'Approved',
    '已批准': 'Approved',
    '未知设备': 'Unknown device',
    '展开连接命令': 'Expand connect command',

    // ─── Time formatting ─────────────────────────────
    '天': 'd',
    '小时': 'h',
    '分钟': 'min',
    '分钟前': 'min ago',
    '秒前': 'sec ago',
    '未知时间': 'Unknown time',

    // ─── Plugins Market ──────────────────────────────
    '管理 Skills（知识包）和 Extensions（功能扩展），增强 OpenClaw 的能力': 'Manage Skills (knowledge packs) and Extensions to enhance OpenClaw capabilities',
    '扫描 Skill 源': 'Scan Skill Source',
    '扫描': 'Scan',
    '扫描中': 'Scanning',
    '扫描失败': 'Scan failed',
    '扫描结果': 'Scan Results',
    '全选': 'Select All',
    '安装选中': 'Install Selected',
    '安装 Extension': 'Install Extension',
    '本地目录': 'Local Directory',
    '内置': 'Built-in',
    '用户安装': 'User installed',
    '扩展': 'Extension',
    '有更新': 'Has update',
    '同名目录 (不同 Skill)': 'Same-name dir (different Skill)',
    '同名已安装 (自定义)': 'Same-name installed (custom)',
    '已安装 (可覆盖)': 'Installed (can override)',
    '无效': 'Invalid',
    '安全扫描': 'Security scan',
    '安全扫描通过': 'Security scan passed',
    '包含脚本文件': 'Contains script files',
    '包含可疑模式': 'Contains suspicious patterns',
    '成功安装': 'Successfully installed',
    '已安装/取消': 'Installed/Cancelled',
    '暂无用户安装的 Skill': 'No user-installed Skills',
    '暂无用户额外安装的 Extension': 'No user-installed Extensions',
    '内置的 40+ Extensions 已自动加载': '40+ built-in Extensions are auto-loaded',
    '安装提示': 'Install notice',
    '大文件': 'Large file',
    '当前浏览器不支持目录选择': 'Current browser does not support directory selection',
    '无效的文件选择': 'Invalid file selection',
    '无效的选择': 'Invalid selection',
    '个 Skill': ' Skill(s)',
    '个无效 Skill': ' invalid Skill(s)',
    '找到': 'Found',

    // ─── Terminal ────────────────────────────────────
    '交互终端': 'Interactive Terminal',
    '清空': 'Clear',
    '未连接': 'Not connected',
    '自动滚动': 'Auto-scroll',
    '交互终端已连接': 'Interactive terminal connected',
    '交互连接不可用': 'Interactive connection unavailable',
    '连接中...': 'Connecting...',
    '连接超时': 'Connection timeout',
    '已连接': 'Connected',
    '已断开': 'Disconnected',
    '重连中...': 'Reconnecting...',
    '连接错误': 'Connection error',
    '断开': 'Disconnected',
    '认证失效': 'Authentication expired',
    '无法建立交互会话': 'Cannot establish interactive session',
    '尝试 SSE 模式': 'Trying SSE mode',
    'SSE 模式连接中...': 'SSE mode connecting...',
    'SSE 已连接': 'SSE connected',
    'SSE 断开': 'SSE disconnected',
    'WebSocket 不可用': 'WebSocket unavailable',

    // ─── Settings ────────────────────────────────────
    '系统更新': 'System Update',
    '语言 / Language': 'Language',
    '界面语言': 'Interface Language',
    '说明': 'Note',
    '根据浏览器语言自动选择，也可手动切换。切换后页面会自动刷新。': 'Auto-detected from browser language. Can be switched manually. Page will refresh after switching.',
    '面板登录密码': 'Panel Login Password',
    '当前密码': 'Current Password',
    '新密码': 'New Password',
    '确认新密码': 'Confirm New Password',
    '修改密码': 'Change Password',
    '密码已修改': 'Password changed',
    '修改失败': 'Change failed',
    '请输入当前密码': 'Please enter current password',
    '新密码至少 8 位': 'New password must be at least 8 characters',
    '两次密码不一致': 'Passwords do not match',
    '默认账号 admin / openclaw（首次启动会自动创建）': 'Default account admin / openclaw (auto-created on first start)',
    '提示': 'Note',

    // ─── Logs ────────────────────────────────────────
    '轮询查看 / 敏感字段已脱敏': 'Polling view / sensitive fields masked',
    '时间线': 'Timeline',
    '按来源': 'By source',
    '自动刷新': 'Auto-refresh',
    '视图': 'View',

    // ─── Login ───────────────────────────────────────
    'AI 私人助手管理面板': 'AI Personal Assistant Control Panel',
    '请登录后继续': 'Please log in to continue',
    '用户名': 'Username',
    '密码': 'Password',
    '请输入密码': 'Enter password',
    '确认密码': 'Confirm Password',
    '再次输入密码': 'Re-enter password',
    '登录': 'Login',
    '设置密码': 'Set Password',
    '首次使用需要先设置管理密码（账号固定为 admin）。': 'First-time use: set your admin password (username is always admin).',
    '首次使用：请设置管理密码（至少8位，含大小写字母、数字和特殊字符）': 'First-time setup: set admin password (min 8 chars, upper + lower + digit + special)',
    '请输入用户名和密码': 'Please enter username and password',
    '请再次输入密码': 'Please re-enter password',
    '两次输入的密码不一致': 'Passwords do not match',
    '密码至少8位': 'Password must be at least 8 characters',
    '密码需包含至少一个大写字母': 'Password must contain at least one uppercase letter',
    '密码需包含至少一个小写字母': 'Password must contain at least one lowercase letter',
    '密码需包含至少一个数字': 'Password must contain at least one digit',
    '密码需包含至少一个特殊字符': 'Password must contain at least one special character',
    '设置中...': 'Setting up...',
    '登录中...': 'Logging in...',
    '设置失败': 'Setup failed',
    '登录失败': 'Login failed',
    '需要先初始化': 'Initialization required',
    '网络错误：': 'Network error: ',

    // ─── Toast & Common Messages ─────────────────────
    '状态刷新失败': 'Status refresh failed',
    '已刷新': 'Refreshed',
    '请求失败': 'Request failed',
    '失败': 'Failed',
    '成功': 'Success',
    '完成': 'Complete',
    '错误': 'Error',
    '确认': 'Confirm',
    '取消': 'Cancel',
    '初始化': 'Initialize',
    '启动': 'Start',
    '停止': 'Stop',
    '异常': 'Error',
    '可能会话失效或页面缓存未更新': 'Session may have expired or page cache not updated',
    '提示: 请强制刷新页面后重试': 'Tip: Force-refresh the page and retry',
    '当前连接已失效': 'Current connection has expired',
    '当前连接会失效': 'Current connection will expire',
    '后端重启中': 'Backend restarting',
    '响应不是有效 JSON': 'Response is not valid JSON',
    '响应为空': 'Response is empty',
    '不可用': 'Unavailable',
    '不支持': 'Not supported',
    '待识别': 'Pending identification',
    '当前已是最新版本': 'Already on the latest version',
    '占用': 'In use',
    '工作空间': 'Workspace',
    '无需更新': 'No update needed',
    '容器名': 'Container name',

    // ─── Setup Wizard ────────────────────────────────
    '首次使用提示': 'First-time Setup',
    '检测到尚未完成模型配置。请到「接入模型配置」完成基础设置。': 'Model configuration not complete. Go to "Model Configuration" to finish setup.',

    // ─── Provider Config ─────────────────────────────
    'GitHub Copilot 登录': 'GitHub Copilot Login',

    // ─── Dynamic patterns with placeholders ──────────
    // Use {0}, {1} for interpolation; t('key', val0, val1)
    '运行 {0}': 'Uptime {0}',
    '运行：{0}': 'Uptime: {0}',
    '域名：{0}': 'Domain: {0}',
    '面板 {0}': 'Panel {0}',
    'watchdog未运行': 'watchdog not running',
    '已耗时 {0} / 预计剩余 {1}': 'Elapsed {0} / Est. remaining {1}',
    '已耗时 {0}': 'Elapsed {0}',
    '后台模式会为当前 Gateway 使用独立目录 {0}，不同 Gateway 可同时运行。': 'Background mode uses separate directory {0} for this Gateway; multiple Gateways can run simultaneously.',
    '主代理 Fallbacks: {0}': 'Primary Proxy Fallbacks: {0}',
    '子代理模型: {0}': 'Sub Proxy model: {0}',
    '{0}天 {1}小时': '{0}d {1}h',
    '{0}小时 {1}分钟': '{0}h {1}min',
    '{0}分钟': '{0}min',
    '{0}秒前': '{0}s ago',
    '{0}分钟前': '{0}m ago',
    '确认删除 {0}？关联的模型配置也会被清除。': 'Delete {0}? Associated model configs will also be removed.',
    '已复制 {0} 连接命令': 'Copied {0} connect command(s)',
    '确认卸载 OpenClaw？此操作将移除本地安装与源码目录。': 'Uninstall OpenClaw? This will remove the local install and source directories.',
    '确认重启 Gateway？': 'Restart Gateway?',
    '可更新到 {0}': 'Can update to {0}',
    '已耗时 {0}s': 'Elapsed {0}s',
    '总耗时 {0}s': 'Total {0}s',
    '当前：{0} · 最新：{1}': 'Current: {0} · Latest: {1}',
    '备份包含 {0} 个配置文件': 'Backup contains {0} config file(s)',

    // ─── Server response messages (en→zh for Chinese mode) ───
    // These are the English messages returned by the server API.
    // The serverMsg() function translates them to Chinese when locale=zh.

    // ─── Additional app.js coverage ──────────────────
    // Toast titles
    'Gateway 未就绪': 'Gateway Not Ready',
    'Gateway 正在启动中，请稍候后再试': 'Gateway is starting, please try again later',
    '弹窗被拦截': 'Popup Blocked',
    '已在当前页面打开 Gateway 控制台': 'Opened Gateway console in current page',
    'Gateway 提示': 'Gateway Notice',
    '已触发重启': 'Restart Triggered',
    'Gateway 正在重启，请稍候': 'Gateway restarting, please wait',
    '重启失败': 'Restart Failed',
    '请查看日志': 'Please check logs',
    '请稍候': 'Please Wait',
    '后端重启中，恢复后可再次热更新': 'Backend restarting, hot patch available after recovery',
    '强制热更新失败': 'Force Hot Patch Failed',
    '热更新失败': 'Hot Patch Failed',
    '热更新完成': 'Hot Patch Complete',
    '热更新超时': 'Hot Patch Timeout',
    '请稍后检查状态': 'Please check status later',
    '任务状态异常': 'Task Status Error',
    '任务超时': 'Task Timeout',
    '配置恢复完成': 'Config Restore Complete',
    '配置恢复失败': 'Config Restore Failed',
    '迁移导出': 'Migration Export',
    '迁移导入成功': 'Migration Import Successful',
    '格式错误': 'Invalid Format',
    '导出失败': 'Export Failed',
    '导入失败': 'Import Failed',
    '任务进行中': 'Task In Progress',
    '安装/更新或网关重启执行中，暂不可配置恢复': 'Install/update or gateway restart running, config restore unavailable',
    '配置恢复': 'Config Restore',
    '未找到备份文件': 'No backup files found',
    '安装/更新任务正在执行，请稍候': 'Install/update task running, please wait',
    '已存在安装/更新任务，正在接管进度显示': 'Existing install/update task, taking over progress display',
    '安装失败': 'Install Failed',
    '开始安装': 'Starting Install',
    '正在执行 OpenClaw 安装...': 'Installing OpenClaw...',
    '更新已取消': 'Update Cancelled',
    '未检测到本地版本，请先检查安装状态': 'No local version detected, please check install status',
    '无法获取远端版本': 'Cannot fetch remote version',
    '更新失败': 'Update Failed',
    '开始更新': 'Starting Update',
    '安装/更新执行中，暂不可重启 Gateway': 'Cannot restart Gateway during install/update',
    '网关重启正在执行，请稍候': 'Gateway restart in progress, please wait',
    '已取消': 'Cancelled',
    '未执行 Gateway 重启': 'Gateway restart not performed',
    '重启处理中': 'Restart In Progress',
    '请求超时，但后端仍在重启 Gateway': 'Request timed out but backend still restarting',
    '重启成功': 'Restart Successful',
    'Gateway 已恢复运行': 'Gateway is back online',
    '重启超时': 'Restart Timeout',
    'Gateway 未在预期时间内恢复，请手动检查': 'Gateway did not recover in time, check manually',
    '安装/更新/卸载任务正在执行，请稍候': 'Install/update/uninstall task running, please wait',
    '当前有其他操作在执行，请稍候': 'Another operation is running, please wait',
    '无法卸载': 'Cannot Uninstall',
    '当前未安装 OpenClaw': 'OpenClaw is not installed',
    '未执行卸载': 'Uninstall not performed',
    '卸载失败': 'Uninstall Failed',
    '开始卸载': 'Starting Uninstall',
    '正在执行 OpenClaw 卸载...': 'Uninstalling OpenClaw...',
    '加载失败': 'Load Failed',
    '版本列表已加载': 'Version List Loaded',
    '请选择版本': 'Select Version',
    '请先从下拉列表中选择要安装的版本': 'Choose a version from the dropdown first',
    '未执行安装': 'Install not performed',
    '请先选择': 'Please Select',
    '请先从下拉菜单选择一个 Key': 'Select a key from the dropdown first',
    '删除失败': 'Delete Failed',
    '已删除': 'Deleted',
    '请先授权': 'Please Authorize First',
    '参数错误': 'Invalid Input',
    '请输入 API Key': 'Please enter an API Key',
    'Key 无效': 'Invalid Key',
    'API Key 验证失败': 'API Key validation failed',
    '添加失败': 'Add Failed',
    '添加成功': 'Added Successfully',
    '保存失败': 'Save Failed',
    '保存成功': 'Saved Successfully',
    '请设置主代理模型': 'Please set primary agent model',
    '模型配置已保存': 'Model config saved',
    '认证完成': 'Auth Complete',
    '认证失败': 'Auth Failed',
    '启动失败': 'Start Failed',
    '审批失败': 'Approval Failed',
    '审批成功': 'Approval Successful',
    'Gateway 已重启': 'Gateway Restarted',
    '操作失败': 'Operation Failed',
    '复制失败': 'Copy Failed',
    '安全配置已保存': 'Security Config Saved',
    '部分配置需重启 Gateway 生效': 'Some settings require Gateway restart to apply',
    '请输入': 'Input Required',
    '请输入 GitHub URL': 'Please enter a GitHub URL',
    '扫描失败': 'Scan Failed',
    '选择失败': 'Selection Failed',
    '当前浏览器不支持目录选择': 'Browser does not support directory selection',
    '请选择': 'Please Select',
    '请勾选要安装的 Skills': 'Check the Skills to install',
    '安装完成': 'Install Complete',
    '请输入 npm 包名': 'Please enter npm package name',
    '安装成功': 'Install Successful',
    '已移除': 'Removed',
    '移除失败': 'Remove Failed',
    '已卸载': 'Uninstalled',
    '卸载中...': 'Uninstalling...',
    '缺少参数': 'Missing Parameter',
    '请输入当前密码': 'Please enter current password',
    '新密码至少 8 位': 'New password must be at least 8 characters',
    '两次密码不一致': 'Passwords do not match',
    '密码已修改': 'Password Changed',
    '请重新登录': 'Please log in again',
    '修改失败': 'Change Failed',
    '配对码格式无效': 'Invalid pairing code format',
    '已取消配对': 'Unpaired',

    // textContent / status
    '（自动探测）': '(auto-detected)',
    '刷新中...': 'Refreshing...',
    '检查中...': 'Checking...',
    '检测中...': 'Detecting...',
    '安装中...': 'Installing...',
    '更新中...': 'Updating...',
    '修复中...': 'Repairing...',
    '启动中...': 'Starting...',
    '已是最新': 'Up to Date',
    '安装': 'Install',
    '更新': 'Update',
    '卸载': 'Uninstall',
    '加载中...': 'Loading...',
    '验证中…': 'Validating…',
    '保存中…': 'Saving…',
    '打包中...': 'Packaging...',
    '导入中...': 'Importing...',
    '审批中...': 'Approving...',
    '审批通过': 'Approve',
    '扫描中...': 'Scanning...',
    '安装选中': 'Install Selected',
    '移除中...': 'Removing...',
    '检测中': 'Detecting',
    '连接中...': 'Connecting...',
    '重连中...': 'Reconnecting...',
    '已连接': 'Connected',
    '未连接': 'Disconnected',
    '已断开': 'Disconnected',
    '连接错误': 'Connection Error',
    '连接超时，切换日志模式': 'Connection timeout, switching to log mode',
    'WebSocket 不可用': 'WebSocket unavailable',
    'SSE 模式连接中...': 'Connecting via SSE...',
    'SSE 已连接': 'SSE Connected',
    'SSE 断开': 'SSE Disconnected',
    '认证失效': 'Auth Expired',

    // Gateway / OpenClaw status
    '启动中': 'Starting',
    '启动中（初始化中）': 'Starting (initializing)',
    '待配对（控制台鉴权）': 'Awaiting pairing (console auth)',
    '运行中': 'Running',
    '未启动': 'Stopped',
    '未安装': 'Not Installed',
    '已安装': 'Installed',
    '未知': 'Unknown',
    '正在检测 OpenClaw 状态': 'Detecting OpenClaw status',
    '安装状态：': 'Install status: ',
    '接口返回异常': 'API returned error',
    '状态读取失败': 'Status read failed',
    '任务状态轮询失败': 'Task status polling failed',
    '配置恢复状态轮询失败': 'Config restore polling failed',
    '卸载任务创建失败': 'Uninstall task creation failed',
    '安装任务创建失败': 'Install task creation failed',
    '配置恢复失败': 'Config restore failed',
    '备份列表读取失败': 'Backup list read failed',
    '恢复失败': 'Restore failed',
    '导出失败': 'Export failed',
    '导入失败': 'Import failed',

    // Provider groups
    '常用': 'Popular',
    '国际': 'International',
    '中国': 'China',
    '网关': 'Gateway',
    '本地': 'Local',
    '其他': 'Other',

    // Version labels
    '开发版（dev）': 'Dev (dev)',
    '未标注版本': 'Untagged version',
    '源码安装': 'Source install',
    'npm 安装': 'npm install',
    '二进制安装': 'Binary install',
    '版本探测': 'Version detection',

    // Uptime
    '天': 'd',
    '小时': 'h',
    '分钟': 'min',
    '秒前': 's ago',
    '分钟前': 'm ago',

    // Log line classes
    '持续': 'Duration',

    // AI providers
    '使用设备授权登录': 'Use device authorization login',
    '留空即可': 'Leave empty',
    '可选': 'optional',
    '自定义端点': 'Custom Endpoint',

    // Skill scan
    '正在扫描...': 'Scanning...',
    '该源中未找到包含 SKILL.md 的目录': 'No directories with SKILL.md found in source',
    '更新成功': 'Update successful',
    '未知错误': 'Unknown error',

    // Terminal
    '输入命令并回车执行。': 'Enter a command and press Enter to execute.',
    '终端后端未就绪': 'Terminal backend not ready',

    // Remote device
    '暂无已配对的 Node 节点': 'No paired Node endpoints',
    '暂无待审批的配对请求': 'No pending pairing requests',
    '暂无已配对设备': 'No paired devices',
    '内置': 'Built-in',
    '用户安装': 'User Installed',
    '扩展': 'Extension',
    '暂无用户安装的 Skill。': 'No user-installed Skills.',
    '读取失败': 'Read failed',
    '角色': 'Role',
    '审批于': 'Approved at',
    '取消配对': 'Unpair',
    '移除': 'Remove',

    // Discord status
    '正在检查 Discord 运行状态...': 'Checking Discord runtime status...',
    'Discord 运行状态读取失败': 'Failed to read Discord runtime status',
    'Discord 当前未启用。保存配置并重启 Gateway 后才会建立连接。': 'Discord is not enabled. Save config and restart to establish connection.',
    'Discord 连接异常': 'Discord connection error',
    'Gateway 在线，最近未检测到 Discord 连接错误。': 'Gateway online, no recent Discord errors detected.',
    'Gateway 正在启动中，等待 Discord 完成连接。': 'Gateway starting, waiting for Discord connection.',
    'Gateway 当前未运行，暂时无法确认 Discord 连接状态。': 'Gateway not running, cannot confirm Discord status.',
    '请输入有效的 Discord 配对码。': 'Please enter a valid Discord pairing code.',
    '正在审批 Discord 配对码...': 'Approving Discord pairing code...',

    // Confirm dialogs
    '确认重启 Gateway？\n重启期间连接会短暂中断。': 'Confirm Gateway restart?\nConnections will be briefly interrupted.',
    '确认卸载 OpenClaw？\n将移除本地安装与源码目录。': 'Confirm uninstall OpenClaw?\nLocal install and source will be removed.',
    '二次确认：确定继续卸载吗？\n卸载期间将禁止安装/更新/重启。': 'Second confirmation: Continue uninstall?\nInstall/update/restart disabled during uninstall.',

    // Migration
    '正在导出全量迁移数据': 'Exporting full migration data',
    '配置+密钥+身份+设备+工作空间+会话历史': 'config+keys+identity+devices+workspaces+session history',
    '迁移包已导出': 'Migration package exported',
    '迁移包已下载': 'Migration package downloaded',
    '正在导入迁移数据': 'Importing migration data',
    '原数据已备份到': 'Original data backed up to',
    '项数据': 'item(s)',
    '正在读取配置备份列表...': 'Loading config backup list...',
    '正在恢复备份': 'Restoring backup',
    '使配置生效。': 'to apply config.',

    // Status lines
    '更新状态：自动检查中': 'Update status: Auto-checking',
    '更新状态：Gateway 启动中': 'Update status: Gateway starting',
    'Gateway 状态：启动中': 'Gateway status: Starting',
    '更新状态：正在检测 OpenClaw 状态': 'Update status: Detecting OpenClaw status',
    '更新状态：读取失败': 'Update status: Read failed',
    '更新状态：未安装，可执行安装': 'Update status: Not installed, ready to install',
    '更新状态：已安装（版本待识别）': 'Update status: Installed (version pending)',
    '更新状态：检查失败': 'Update status: Check failed',
    '更新状态：发现新版本，可更新': 'Update status: New version available',
    '更新状态：已是最新版本': 'Update status: Up to date',
    '配置状态：检测到无效 key': 'Config status: Invalid keys detected',
    '安装提示：将使用官方 npm 安装': 'Install note: Will use official npm install',
    'Gateway 状态：等待控制台配对': 'Gateway status: Awaiting console pairing',
    '请先在网关页面完成配对授权': 'Complete pairing on gateway page first',
    'Gateway 状态：初始化中': 'Gateway status: Initializing',
    '连接问题': 'connection issue',

    // OAuth
    '设备授权流程：': 'Device Authorization Flow:',
    '确保你有 GitHub Copilot 订阅（个人版或企业版）': 'Make sure you have a GitHub Copilot subscription (individual or enterprise)',
    '点击"启动设备授权"按钮': 'Click the "Start Device Auth" button',
    '在弹出页面中登录 GitHub 并授权设备': 'Log in to GitHub and authorize the device',
    '输入显示的设备码完成授权': 'Enter the displayed device code to complete authorization',
    '注意：模型名称需要以 github-copilot/ 开头': 'Note: Model names must start with github-copilot/',
    '等待用户完成授权': 'Waiting for user authorization',
    '授权进行中…': 'Authorization in progress…',
    '启动设备授权': 'Start Device Auth',
    '授权成功，可再次点击刷新授权': 'Auth successful; click again to refresh',
    '点击按钮启动设备授权流程': 'Click to start device authorization',
    '正在启动授权…': 'Starting authorization…',
    '启动失败，请重试': 'Failed to start, please retry',
    '出错，请重试': 'Error, please retry',
    '点击此处打开 GitHub 授权页面': 'Click here to open GitHub authorization page',
    '授权码': 'Auth Code',
    '请点击上方链接': 'Click the link above',
    '在 GitHub 页面中输入授权码完成认证': 'Enter the auth code on GitHub to complete authentication',
    '重新授权': 'Re-authorize',

    // Misc app.js
    '请求超时': 'Request timeout',
    '无法连接 GitHub（网络不可达）': 'Cannot reach GitHub (network unreachable)',
    '正在强制拉取最新文件...': 'Force-pulling latest files...',
    '正在拉取最新文件...': 'Pulling latest files...',
    '仅容器内文件': 'container files only',
    '加载版本列表': 'Load Version List',
    '添加此授权': 'Add Authorization',
    '添加此 API Key': 'Add API Key',
    '检测失败': 'Detection failed',
    '版本：': 'Version: ',
    '来自 API': 'from API',
    '内置列表': 'built-in list',
    '未配置': 'Not configured',
    '未配置域名': 'No domain configured',
    '后台运行': 'Background',
    '秒': 's',
    '该设备': 'this device',
    '加载': 'Load',
    '已保存': 'Saved',
    '正在获取': 'Fetching',
    '的模型列表...': 'model list...',
    '进行中': 'in progress',
    '接口返回空响应': 'API returned empty response',
    '正在验证': 'Validating',
    '正在添加': 'Adding',
    '正在删除': 'Deleting',
    '正在读取配置...': 'Loading config...',
    '首次读取超时，正在重试...': 'First read timed out, retrying...',
    '正在保存模型配置...': 'Saving model config...',
    '正在读取消息平台配置...': 'Loading messaging config...',
    '正在刷新状态...': 'Refreshing status...',
    '状态刷新失败：': 'Status refresh failed: ',
    '正在提交重启请求...': 'Submitting restart request...',
    '重启请求已接受，Gateway 重启中...': 'Restart request accepted, Gateway restarting...',
    '请求超时，但后端仍在重启中...': 'Request timed out but backend still restarting...',
    'Gateway 重启成功': 'Gateway restart successful',
    '开始安装 OpenClaw...': 'Starting OpenClaw install...',
    '检测到 web/server.js 更新': 'Detected web/server.js update',
    'Web 面板将自动重启': 'Web panel will auto-restart',
    '检测到 start-services.sh 更新': 'Detected start-services.sh update',
    '请在宿主机执行': 'Please run on host machine',
    '请重启容器': 'Please Restart Container',
    '个文件已更新': 'file(s) updated',
    'Web 面板已恢复，已自动刷新更新状态': 'Web panel recovered, update status refreshed',
    'Web 面板重启中，如状态未更新请稍后手动刷新页面': 'Web panel restarting; refresh manually if not updated',
    '目标版本': 'Target version',
    '正在更新到': 'Updating to',
    '正在安装': 'Installing',
    '个 Skill': 'Skill(s)',
    '个版本': 'version(s)',
    '重启 Gateway 后生效': 'restart Gateway to apply',
    '缺少 SKILL.md 文件': 'Missing SKILL.md file',
    '目录包含过多文件': 'Directory contains too many files',
    '尚未产生可展示日志': 'No displayable logs generated yet',
    '本地目录': 'Local Directory',
    '无需变更': 'No changes needed',
    '没有需要修复的配置项': 'No issues found',
    '已修复并建议重启 Gateway': 'Fixed, recommend restarting Gateway',
    '认证信息已写入': 'Credentials saved',
    '无法启动 OAuth 登录': 'Cannot start OAuth login',
    '需重启 Gateway 生效': 'restart Gateway to apply',
    '写入': 'Written to',
    '不会覆盖容器配置': 'Will not overwrite container config',
    '导入前会自动备份当前数据': 'Current data will be auto-backed up before import',
    '以使入口脚本变更生效': 'for startup script changes to take effect',
    '若容器名不确定': 'If container name is unknown',
    '先执行': 'first run',
    '再执行': 'then run',
    '容器名': 'container name',
    '输入序号选择': 'Enter number to select',
    '输入序号恢复单个文件': 'Enter number to restore single file',
    '输入多个序号恢复多个文件': 'Enter multiple numbers to restore multiple files',
    '全部': 'All',
    '文件': 'file(s)',
    '在线，取消配对后当前会话会失效': 'Online; unpairing will invalidate session',
    '远端后台进程不会自动退出': 'remote background tasks will not auto-exit',
    '离线，取消配对仅删除配对记录': 'Offline; unpairing only removes pairing record',
    '需要先点击"启动设备授权"完成 OAuth 登录': 'Click "Start Device Auth" to complete OAuth first',
    '无法可靠判断时会保守保留': 'kept conservatively when uncertain',
    '后台模式会为当前网关使用独立目录': 'Background mode uses separate dir for this gateway',
    '命令会根据当前 HTTPS 配置决定是否保留': 'Command retains based on HTTPS config',
    '有更新': 'Update available',
    '同名目录': 'Name conflict',
    '不同 Skill': 'different Skill',
    '同名已安装': 'Same name installed',
    '自定义': 'custom',
    '可覆盖': 'overwritable',
    '已安装': 'Installed',
    '无效': 'Invalid',
    '有效': 'Valid',
    '交互模式：': 'Interactive mode: ',
    '终端就绪': 'Terminal Ready',
    '终端异常': 'Terminal Error',
    '终端:': 'Terminal:',
    '正常': 'OK',
    '兼容模式': 'compat mode',
    '状态未知': 'unknown status',
    '健康检查正常': 'Health check OK',
    'OpenClaw 已卸载': 'OpenClaw uninstalled',
    '等待控制台配对': 'Awaiting console pairing',
    '进程已拉起，等待健康检查': 'Process started, waiting for health check',
    '未检测到运行中的 Gateway': 'No running Gateway detected',
    'watchdog未运行': 'Watchdog not running',
    '离线/未启用': 'Offline / Not Enabled',
    '待配对': 'Awaiting Pairing',
    '暂无用户额外安装的 Extension。OpenClaw 内置的 40+ Extensions 已自动加载。': 'No additional user-installed Extensions. 40+ built-in Extensions are auto-loaded.',
    '已加载': 'Loaded',
    '已禁用': 'Disabled',
    '内置': 'Built-in',
    '用户': 'User',
    '通道': 'Channel',
    '工具': 'Tool',
    '消息通道': 'Channels',
    '模型 Provider': 'Model Providers',
    '工具与扩展': 'Tools & Extensions',
    '共 {0} 个插件，{1} 个已加载': '{0} plugins total, {1} loaded',
    '启用中...': 'Enabling...',
    '禁用中...': 'Disabling...',
    '已启用': 'Enabled',
    '操作失败': 'Operation failed',
    '更新中...': 'Updating...',
    '正在更新插件...': 'Updating plugins...',
    '更新完成': 'Update complete',
    '更新失败': 'Update failed',
    '更新全部': 'Update All',
    '更新失败: {0}': 'Update failed: {0}',
    '安装完成（有警告）': 'Installed (with warnings)',
    '安装失败': 'Install failed',
    '即将推出': 'Coming Soon',
    '正在确保 {0} 插件已启用...': 'Ensuring {0} plugin is enabled...',
    '{0} 插件已启用': '{0} plugin enabled',
    '插件启用失败: {0}': 'Plugin enable failed: {0}',

    // ─── index.html static text — v1.1.314 batch ─────

    // AI Model Config
    '格式: provider/model-id': 'Format: provider/model-id',
    '配置读取成功': 'Config loaded successfully',
    '配置读取完成': 'Config load complete',
    '配置导出': 'Export Config',
    '配置导入': 'Import Config',
    '迁移导出': 'Migration Export',
    '迁移导入': 'Migration Import',
    '版本': 'Version',
    '交互模式': 'Interactive mode',
    '更新状态：安装中': 'Update status: Installing',
    '更新状态：更新中': 'Update status: Updating',
    '更新状态：卸载中': 'Update status: Uninstalling',
    '更新状态：配置恢复中': 'Update status: Restoring config',
    'Gateway 状态：启动中（正在等待健康检查）': 'Gateway status: Starting (waiting for health check)',
    'Gateway 状态：启动中（安装完成后Initialize中）': 'Gateway status: Starting (initializing after install)',
    'Gateway 状态：启动中（Initialize中，等待健康检查）': 'Gateway status: Starting (initializing, waiting for health check)',
    'Gateway 状态：等待控制台配对。请先在Gateway页面完成配对授权': 'Gateway status: Awaiting console pairing. Complete authorization on Gateway page first',
    'OpenClaw 已卸载': 'OpenClaw uninstalled',
    '进程已拉起，等待健康检查': 'Process started, awaiting health check',
    '终端: 正常(PTY)': 'Terminal: OK (PTY)',
    '终端: 正常(兼容模式)': 'Terminal: OK (compat mode)',
    '终端: 状态未知': 'Terminal: status unknown',
    '交互模式：PTY': 'Interactive mode: PTY',
    '待识别': 'pending identification',

    // Feishu setup guide
    '前往': 'Go to',
    '飞书开放平台': 'Feishu (Lark) Open Platform',
    '创建企业自建应用': 'create an enterprise app',
    '添加「机器人」能力': 'add "Bot" capability',
    '在「凭证与基础信息」中获取 App ID 和 App Secret': 'get App ID and App Secret from "Credentials & Basic Info"',
    '在「事件订阅」中配置回调 URL（格式:': 'configure callback URL in "Event Subscription" (format:',
    '你的域名': 'your-domain',
    '如: 小豆豆': 'e.g. My Bot',
    '高级选项（Verification Token / Encrypt Key）': 'Advanced (Verification Token / Encrypt Key)',

    // Discord setup guide & form
    '获取 Bot Token': 'get Bot Token',
    '开启 Message Content Intent': 'enable Message Content Intent',
    '生成邀请链接将 Bot 添加到服务器': 'generate invite link to add Bot to server',
    '当 Discord 里出现 access not configured 和配对码时，可在这里直接审批，无需再进容器执行命令。': 'When Discord shows "access not configured" and a pairing code, you can approve it here without running container commands.',
    'partial（逐段）': 'partial',
    'progress（逐字）': 'progress (per char)',
    'block（整段）': 'block (whole message)',
    'off（关闭）': 'off',
    '将写入 channels.discord.guilds（多服务器模式）': 'Saved to channels.discord.guilds (multi-server mode)',
    '例如: G8RP2Z8R': 'e.g. G8RP2Z8R',
    '每行一个，或逗号分隔\n例如:': 'One per line or comma-separated\ne.g.:',

    // Telegram setup guide
    '在 Telegram 中搜索': 'Search in Telegram for',
    '按提示创建机器人': 'follow the prompts to create a bot',
    '可通过': 'you can use',
    '获取你的 User ID': 'to get your User ID',
    '逗号分隔，如 123456,789012': 'comma-separated, e.g. 123456,789012',
    '发送': 'Send',

    // Signal setup guide
    '需要先安装': 'requires',
    '然后用': 'then use',
    '注册': 'to register',
    '再用': 'then use',
    '完成验证': 'to complete verification',
    '验证码': 'verification code',
    'Signal CLI 路径': 'Signal CLI Path',

    // WhatsApp setup guide
    '需要 WhatsApp Business API 或兼容网关（如': 'Requires WhatsApp Business API or compatible gateway (e.g.',
    '填入网关的 API 地址和密钥即可': 'Enter the gateway API address and key',

    // WeChat setup guide & QR login
    '扫码登录': 'QR Code Login',
    '获取登录二维码': 'Get Login QR Code',
    '退出登录': 'Log Out',
    '正在获取二维码...': 'Getting QR code...',
    '请使用微信扫一扫上方二维码': 'Scan the QR code above with WeChat',
    '获取二维码失败': 'Failed to get QR code',
    '已登录：{0}': 'Logged in: {0}',
    '微信用户': 'WeChat User',
    '未登录，请扫码绑定': 'Not logged in, scan QR to bind',
    '已退出': 'Logged Out',
    '微信已退出登录': 'WeChat logged out',
    '允许的用户 (微信号，逗号分隔，留空允许所有)': 'Allowed Users (WeChat IDs, comma-separated, leave empty for all)',

    // Messaging common footer
    '此页面提供常用配置项。如需更详细的通道设置，请打开': 'This page provides common settings. For advanced channel configuration, open',
    'openclaw 命令行 或访问 Gateway 自带 Web UI': 'openclaw CLI or Gateway built-in Web UI',

    // Remote Device Management — header & quick connect
    '将远端机器接入本 Gateway，AI 代理可远程操控浏览器与执行命令': 'connect remote machines to this Gateway, enabling AI agents to control browsers and execute commands remotely',
    '在远端机器上运行以下命令即可自动配对（需先安装': 'Run the following command on the remote machine to auto-pair (install',
    'CLI）。命令会自动配置节点安全策略并通过 TLS 加密连接：': 'CLI first). The command auto-configures node security policy and connects via TLS encryption:',
    '复制命令': 'Copy Command',
    '后台命令会为当前网关创建独立守护目录；同一网关重复执行会覆盖自身实例，不同网关可在同一台机器上并行运行。': 'Background command creates a dedicated daemon directory for the current gateway; re-running for the same gateway replaces the existing instance; different gateways can run in parallel on the same machine.',
    '命令会自动在远端创建': 'The command auto-creates',
    '并设置命令执行策略，然后启动节点连接。运行后需在下方审批才能接入。': 'and sets command execution policy, then starts the node connection. Approval below is required after running.',


    // Remote Device — node status & pairing
    '已配对的 Node 节点及其在线状态': 'Paired Node endpoints and their online status',
    '新设备首次连接 Gateway 时需要审批（包括 CLI、Node、Web UI、消息平台 Bot 等所有客户端）': 'New devices require approval on first Gateway connection (including CLI, Node, Web UI, messaging bots, etc.)',

    // Remote Device — security config
    '(Gateway 配置)': '(Gateway config)',
    '高危操作：': 'High-risk operation: ',
    '开启自动审批后，任何知道 Gateway Token 的设备都可以': 'With auto-approve enabled, any device with the Gateway Token can',
    '无需人工确认': 'without manual confirmation',
    '直接接入并获得完整操作权限。': 'connect directly with full access.',
    '完全的 AI 代理操控权': 'full AI agent control',
    '包括浏览器、命令执行等': 'including browser, command execution, etc.',
    '仅建议在完全可信的局域网环境中使用': 'recommended only in fully trusted LAN environments',
    '这等同于授予远端设备': 'This is equivalent to granting the remote device',
    '控制 AI 代理在远端节点上执行命令的放行方式；无人值守节点建议使用': 'Controls how AI agent commands are approved on remote nodes; for unattended nodes use',
    '在 gateway.nodes.denyCommands 中配置，禁止 Node 执行的命令': 'Configured in gateway.nodes.denyCommands to block specific Node commands',
    '每行一个命令，如：': 'One command per line, e.g.:',

    // Node Mode Guide
    'Node 模式说明（点击展开）': 'Node Mode Guide (click to expand)',
    '点击展开': 'click to expand',
    '重要：命令执行安全策略': 'Important: Command Execution Security Policy',
    '快速连接命令会自动在远端节点配置': 'Quick connect commands will auto-configure',
    '与上方安全配置同步': 'synced with security settings above',
    'AI 代理可直接执行命令，无需逐次审批；这是当前页面默认值，适合无人值守节点': 'AI agents can execute commands directly without per-request approval; this is the default, suitable for unattended nodes',
    '每次执行都需要在节点本地审批；如果节点不在你手边，命令会因': 'Each execution requires local node approval; if the node is not accessible, commands will fail due to',
    '超时而被拒绝': 'timeout rejection',
    '禁止所有命令执行': 'All command execution is blocked',
    'Gateway 页面里没有单独的"命令审批通过"按钮；若选择': 'There is no "approve command" button in the Gateway page; if you choose',
    '批准动作发生在节点本机': 'approval happens on the node itself',
    '什么是 Node 模式？': 'What is Node Mode?',
    '远端机器运行': 'A remote machine runs',
    '后，会自动连接到 Gateway 并注册为一个 Node 节点。': 'then auto-connects to the Gateway and registers as a Node endpoint.',
    'Gateway 可以通过该节点远程操控浏览器（Headless Chrome）和执行命令。': 'The Gateway can then remotely control browsers (Headless Chrome) and execute commands via this node.',
    '支持平台': 'Supported Platforms',
    '完整支持，命令相同（上方 Linux/macOS 标签页）': 'Full support, same commands (Linux/macOS tab above)',
    '完整支持，需 Node.js 18+ 环境，使用 PowerShell 命令（上方 Windows 标签页）': 'Full support, requires Node.js 18+, uses PowerShell commands (Windows tab above)',
    '连接方式': 'Connection Method',
    'TLS 加密': 'TLS Encryption',
    '通过 Caddy 独立 TLS 端口代理到 Gateway，命令已自动包含证书兼容设置：': 'Via Caddy TLS port proxy to Gateway; commands include cert compatibility settings:',
    'TLS 端口在安装时由用户指定，Caddy 自动提供 TLS 证书。': 'TLS port is user-specified during install; Caddy auto-provides TLS certificates.',
    '前置要求': 'Prerequisites',
    '远端机器需安装 Node.js 18+（': 'Remote machine needs Node.js 18+ (',
    '远端机器需安装 Chrome / Chromium（Node 会自动管理 Headless 实例）': 'Remote machine needs Chrome / Chromium (Node auto-manages Headless instances)',
    '远端机器需能访问到本 Gateway 的地址（局域网 / Tailscale / WireGuard / 公网）': 'Remote machine must reach this Gateway (LAN / Tailscale / WireGuard / public)',
    '安全模型': 'Security Model',
    'Node 配对需要 Gateway Auth Token + 人工审批（除非开启自动审批）': 'Node pairing requires Gateway Auth Token + manual approval (unless auto-approve is on)',
    '配对后 Node 获得 operator 级别权限，可被 AI 代理远程操控': 'After pairing, Node gets operator-level access and can be controlled by AI agents',
    '限制远端命令执行': 'restrict remote command execution',
    '建议仅在可信局域网或 VPN 环境中使用': 'recommended only in trusted LAN or VPN environments',

    // Text-node fragments split by HTML tags
    '命令：使用': 'command: uses',
    '不同网关会写入': 'Different gateways write to',
    '日志输出到当前网关对应目录下的': 'Logs are written to',
    '后台运行使用': 'Background mode uses',
    '从浏览器本地选择目录': 'Select local directory from browser',
    '面板': 'Panel',
    '当前：': 'Current: ',
    '最新：': 'Latest: ',

    // Feishu setup guide text-node fragments (split by <a>/<code> tags)
    '创建企业自建应用': 'create an enterprise app',
    '添加「机器人」能力': 'add "Bot" capability',
    '在「凭证与基础信息」中获取': 'get from "Credentials & Basic Info"',
    '和': 'and',
    '在「事件订阅」中配置回调': 'configure callback in "Event Subscriptions"',
    '格式': 'format',
    '你的域名': 'your-domain',

    // Messaging page bottom note (split by <b>/<code> tags)
    '命令行 或访问 Gateway 自带 Web UI）。': 'CLI, or access the Gateway built-in Web UI).',

    // Device management (split by <code> tags)
    '通过': 'via',
    '使用': 'uses',
    '包装': 'wrapper',
    '验证': 'to verify',
    '或': 'or',

    // Plugin install (split by <b>/<code> tags, text after </b>)
    '：点 📂 按钮选择文件夹，含客户端安全扫描（支持 Chrome/Edge/Safari）。': ': click 📂 to pick a folder with client-side security scan (Chrome/Edge/Safari).',

    // Wizard hint
    '首次使用提示': 'First-time Setup',
    '检测到尚未完成模型配置。请到「接入模型配置」完成基础设置。': 'Model configuration not yet complete. Go to "Model Configuration" to finish basic setup.',

    // index.html title attributes
    '无需下载镜像，直接更新文件': 'Update files directly without downloading images',
    '会进行二次确认，并在日志中记录状态变更': 'Requires confirmation; status changes are logged',
    '重启前会二次确认，按住 Shift 点击可跳过': 'Requires confirmation before restart; hold Shift to skip',
    '导出当前配置为压缩包下载到本地': 'Export current config as archive download',
    '从本地压缩包导入配置（会自动备份当前配置）': 'Import config from local archive (auto-backs up current config)',
    '导出全部数据（配置+密钥+身份+设备+定时任务），用于迁移到新容器': 'Export all data (config+keys+identity+devices+cron) for migration to new container',
    '从迁移包恢复全部数据，需重启 Gateway 生效': 'Restore all data from migration package; restart Gateway to apply',
    '安装选择的指定版本': 'Install the selected version',
    '从 npm 加载所有可用版本列表': 'Load all available versions from npm',

    // Discord placeholder (text-node fragment after \n)
    '例如': 'e.g.',
    '（如': '(e.g.',

    // Extension install placeholder (split by 、)
    'npm 包名、github:user/repo 或 GitHub URL': 'npm package name, github:user/repo, or GitHub URL',

    // Background Running Guide (details section)
    '后台运行与自动重连': 'Background Running & Auto-Reconnect',
    '推荐使用"后台运行"命令': 'Recommended: use the "Background" command',
    '推荐使用"后台运行"': 'Recommended: "Background"',
    'Gateway 重启或网络中断后会自动重连（5秒间隔）': 'Auto-reconnects after Gateway restart or network interruption (5s interval)',
    '重连循环': 'reconnect loop',
    '独立目录，可同时连接多个网关': 'separate directory, allowing multiple Gateway connections',
    '后台模式同样支持多网关隔离；命令执行后会打印当前网关专用的日志、错误日志和停止命令': 'Background mode also supports multi-gateway isolation; after running, it prints gateway-specific log paths, error logs, and stop commands',
    '执行命令后会显示准确路径': 'Exact paths are shown after running the command',
    '会话独立）': 'session is independent)',
    '独立会话）': 'independent session)',
    '关闭 SSH 后进程不会退出（': 'Process persists after closing SSH (',
    '关闭 SSH 会话后进程不会退出（': 'Process persists after closing SSH session (',
    '停止节点：执行命令后终端会显示当前网关专用的停止命令': 'Stop node: the stop command for the current gateway is displayed after running',
    '前台模式': 'Foreground mode',
    '适合调试：可直接看到输出，': 'suitable for debugging: see output directly,',
    'Gateway 重启': 'Gateway restart',
    '后节点会自动重连（后台模式），前台模式需手动重新运行': 'nodes auto-reconnect in background mode; foreground mode requires manual re-run',
    '如使用前台模式，Gateway 重启后需手动重新运行命令': 'If using foreground mode, manually re-run the command after Gateway restart',
    '网关 重启后，节点会在 5 秒内自动重连': 'After Gateway restart, nodes auto-reconnect within 5 seconds',
    'Gateway 重启后，节点会在 5 秒内自动重连': 'After Gateway restart, nodes auto-reconnect within 5 seconds',

    // Plugins Market — descriptions
    'Markdown 驱动的知识包，为 Agent 注入专业领域能力（如 GitHub 操作、Notion 读写等）。每个 Skill 是一个包含': 'Markdown-driven knowledge packs that inject domain expertise into Agents (e.g. GitHub Actions, Notion read/write). Each Skill is a directory containing',
    '的目录。': '.',
    'TypeScript 插件，扩展 OpenClaw 运行时功能（如新的消息通道、工具集、存储后端等）。通过 npm 安装。': 'TypeScript plugins that extend OpenClaw runtime (e.g. messaging channels, tool sets, storage backends). Installed via npm.',
    '所有已安装 Skills（内置 + 扩展 + 手动安装至': 'All installed Skills (built-in + extensions + manually installed to',
    '含安全扫描标记。': 'Includes security scan indicators.',
    '远程仓库': 'Remote Repository',
    '输入 URL 后点扫描（如': 'Enter URL and click Scan (e.g.',
    '本地目录：点 📂 按钮选择文件夹，含客户端安全扫描（支持 Chrome/Edge/Safari）。': 'Local: click 📂 to select a folder with client-side security scan (Chrome/Edge/Safari).',
    'OpenClaw 内置 40+ Extensions（含 Feishu、Discord、Telegram 等通道）。以下为用户额外安装的 Extensions。': 'OpenClaw includes 40+ built-in Extensions (Feishu, Discord, Telegram channels, etc.). Below are user-installed Extensions.',
    'npm 包名': 'npm package name',
    'GitHub 简写': 'GitHub shorthand',
    '安装后需重启 Gateway 生效': 'Restart Gateway after installing to apply',
    '支持三种安装方式：': 'Three install methods supported:',
    '输入 GitHub/GitLab/Gitee URL': 'Enter GitHub/GitLab/Gitee URL',

    // Settings — update descriptions
    '直接从 GitHub 拉取最新的 Web 前端、配置模板等文件，无需下载镜像/重建容器。': 'Pull the latest Web frontend and config templates from GitHub without downloading images or rebuilding containers.',
    '完整更新': 'Full Update',
    '如需更新系统包、Node.js 等底层依赖，请在宿主机重新执行一键安装脚本：': 'To update system packages, Node.js, and other core dependencies, re-run the install script on the host:',

    // Update banner
    '📦 此版本需要完整更新（下载新镜像）': '📦 This version requires a full update (new image download)',

    // confirm dialogs fragments
    '重启期间连接会短暂中断。': 'Connections will be briefly interrupted during restart.',
    '等待 Gateway 启动完成': 'Waiting for Gateway to start',

    // Tab labels for device command
    '前台': 'Foreground',
    '后台': 'Background',

    // Misc / app.js dynamic strings
    '未设置': 'Not set',
    '主模型：': 'Primary model: ',
    '主代理模型未设置': 'Primary agent model not set',
    '状态：已读取': 'Status: Loaded',
    '状态：读取失败': 'Status: Load failed',


    // ────── v1.1.316 comprehensive i18n (app.js dynamic strings) ──────
    ' (当前)': ' (current)',
    ' 项数据': ' items',
    '(内置列表)': '(built-in list)',
    '(来自 API)': '(from API)',
    '1) 选择一个备份时间点\n': '1) Select a backup time point\n',
    '2) 多文件备份可选择恢复全部或单个文件\n': '2) Multi-file backups can be restored fully or partially\n',
    '3) 恢复后需点击"重启 Gateway"使配置生效\n\n': '3) Click "Restart Gateway" after restore to apply\n\n',
    'Custom端点': 'Custom Endpoint',
    'Discord 运行状态读取失败：{0}': 'Discord runtime status read failed: {0}',
    'Discord 连接异常：{0}': 'Discord connection error: {0}',
    'Extension 已安装，重启 Gateway 后生效': 'Extension installed, restart Gateway to take effect',
    'Gateway 重启超时': 'Gateway restart timeout',
    'Gateway重启正在执行，请稍候': 'Gateway restart in progress, please wait',
    'OpenClaw Terminal connected (PTY). 输入命令并回车执行。': 'OpenClaw Terminal connected (PTY). Type commands and press Enter.',
    'OpenClaw 已安装，Gateway 正在自动重启': 'OpenClaw installed, Gateway is auto-restarting',
    'OpenClaw 已更新，Gateway 正在自动重启': 'OpenClaw updated, Gateway is auto-restarting',
    'SKILL.md 包含可疑模式: {0}': 'SKILL.md contains suspicious pattern: {0}',
    'Web 面板将自动重启，约 5-15 秒可恢复': 'Web panel will auto-restart, recovery in ~5-15 seconds',
    'Web 面板已恢复，已自动Refresh更新状态': 'Web panel recovered, update status auto-refreshed',
    'Web 面板重启中，如状态未更新请稍后手动Refresh页面': 'Web panel restarting, manually refresh if status not updated',
    'Windows 后台运行': 'Windows Background',
    '[add] {0} API Key 添加成功': '[add] {0} API Key added successfully',
    '[add] {0} 是 OAuth 类型，请先完成设备授权': '[add] {0} uses OAuth, please complete device authorization first',
    '[add] 失败: {0}': '[add] Failed: {0}',
    '[add] 正在添加 {0} 的 API Key...': '[add] Adding API Key for {0}...',
    '[add] 正在获取可用模型列表...': '[add] Fetching available models...',
    '[add] 请输入 API Key': '[add] Please enter API Key',
    '[add] 错误: {0}': '[add] Error: {0}',
    '[auth] OAuth 任务已启动: {0}': '[auth] OAuth task started: {0}',
    '[auth] OAuth 认证{0}': '[auth] OAuth authentication {0}',
    '[auth] 启动 {0} OAuth 登录...': '[auth] Starting {0} OAuth login...',
    '[auth] 启动失败: {0}': '[auth] Start failed: {0}',
    '[auth] 正在获取可用模型列表...': '[auth] Fetching available models...',
    '[auth] 错误: {0}': '[auth] Error: {0}',
    '[delete] {0} 已删除': '[delete] {0} deleted',
    '[delete] 失败: {0}': '[delete] Failed: {0}',
    '[delete] 正在删除 {0}...': '[delete] Deleting {0}...',
    '[delete] 错误: {0}': '[delete] Error: {0}',
    '[discord] 审批失败: {0}': '[discord] Approval failed: {0}',
    '[discord] 正在审批配对码 {0}...': '[discord] Approving pairing code {0}...',
    '[fetch] 成功获取 {0} 个模型 {1}': '[fetch] Successfully fetched {0} models {1}',
    '[fetch] 正在获取 {0} 的模型列表...': '[fetch] Fetching model list for {0}...',
    '[fetch] 获取失败: {0}': '[fetch] Fetch failed: {0}',
    '[fetch] 错误: {0}': '[fetch] Error: {0}',
    '[load] 正在读取消息平台配置...': '[load] Loading messaging platform config...',
    '[load] 正在读取配置...': '[load] Loading config...',
    '[load] 读取失败: {0}': '[load] Load failed: {0}',
    '[load] 配置读取完成': '[load] Config loaded',
    '[load] 配置读取成功，{0} 个已配置 Key': '[load] Config loaded, {0} configured Keys',
    '[load] 错误: {0}': '[load] Error: {0}',
    '[load] 首次读取超时，正在重试...': '[load] First read timed out, retrying...',
    '[migration] ⚠️ 请点击「重启 Gateway」使迁移数据生效！': '[migration] ⚠️ Click "Restart Gateway" to apply migrated data!',
    '[migration] 原数据已备份到: ': '[migration] Original data backed up to: ',
    '[migration] 导入失败: ': '[migration] Import failed: ',
    '[migration] 导入完成: ': '[migration] Import completed: ',
    '[migration] 导出失败: ': '[migration] Export failed: ',
    '[migration] 正在导入迁移数据: ': '[migration] Importing migration data: ',
    '[migration] 正在导出全量迁移数据（配置+密钥+身份+设备+工作空间+会话历史）...': '[migration] Exporting full migration data (config+keys+identity+devices+workspace+history)...',
    '[migration] 用户取消保存': '[migration] User cancelled save',
    '[migration] 迁移包已下载: ': '[migration] Migration package downloaded: ',
    '[migration] 迁移包已导出: ': '[migration] Migration package exported: ',
    '[restart] Gateway 重启失败: {0}': '[restart] Gateway restart failed: {0}',
    '[restart] Gateway 重启成功': '[restart] Gateway restarted successfully',
    '[restart] 正在重启 Gateway...': '[restart] Restarting Gateway...',
    '[restore] 失败: {0}': '[restore] Failed: {0}',
    '[restore] 已取消。': '[restore] Cancelled.',
    '[restore] 无效的文件选择。': '[restore] Invalid file selection.',
    '[restore] 无效的选择。': '[restore] Invalid selection.',
    '[restore] 未找到可用备份文件。': '[restore] No backup files found.',
    '[restore] 未输入有效序号，已取消。': '[restore] No valid number entered, cancelled.',
    '[restore] 正在恢复备份: {0}': '[restore] Restoring backup: {0}',
    '[restore] 正在读取配置备份列表...': '[restore] Loading config backup list...',
    '[restore] 请点击\u201c重启 Gateway\u201d使配置生效。': '[restore] Click "Restart Gateway" to apply config.',
    '[restore] 配置恢复任务进行中，请勿重复触发。': '[restore] Config restore in progress, do not trigger again.',
    '[restore] 配置恢复完成: {0}': '[restore] Config restored: {0}',
    '[save] Discord 服务器数: {0}': '[save] Discord server count: {0}',
    '[save] 主模型: {0}': '[save] Primary model: {0}',
    '[save] 保存失败: {0}': '[save] Save failed: {0}',
    '[save] 保存成功: channels.{0}': '[save] Saved: channels.{0}',
    '[save] 开始保存 {0} 配置...': '[save] Saving {0} config...',
    '[save] 开始保存模型配置...': '[save] Saving model config...',
    '[save] 错误: {0}': '[save] Error: {0}',
    '[save] 错误: 主代理模型未设置': '[save] Error: Primary agent model not set',
    '[select] 已填充 {0}: {1}': '[select] Filled {0}: {1}',
    '[terminal] SSE 交互终端已连接。\n': '[terminal] SSE interactive terminal connected.\n',
    '[terminal] WebSocket 不可用，无法建立交互会话 ({0})\n': '[terminal] WebSocket unavailable, cannot establish interactive session ({0})\n',
    '[terminal] token 鉴权失败，正在尝试 cookie 认证链路...\n': '[terminal] Token auth failed, trying cookie auth...\n',
    '[terminal] 已连接（PTY）。直接在此区域输入命令并按回车执行。': '[terminal] Connected (PTY). Type commands here and press Enter to execute.',
    '[validate] API Key 验证失败: {0}': '[validate] API Key validation failed: {0}',
    '[validate] API Key 验证通过 ✓': '[validate] API Key validated ✓',
    '[validate] 正在验证 {0} API Key...': '[validate] Validating {0} API Key...',
    '[validate] 验证请求失败: {0}，继续添加': '[validate] Validation request failed: {0}, proceeding to add',
    '\n[terminal] SSE 连接断开，3秒后重试...\n': '\n[terminal] SSE connection lost, retrying in 3s...\n',
    '\n[terminal] WebSocket 不可用，正在切换 SSE 交互模式...\n': '\n[terminal] WebSocket unavailable, switching to SSE mode...\n',
    '\n[terminal] WebSocket 交互连接不可用{0}，尝试 SSE 模式...\n': '\n[terminal] WebSocket unavailable{0}, trying SSE mode...\n',
    '\n[terminal] 连接已断开 (code={0}{1}) [{2}].\n': '\n[terminal] Connection closed (code={0}{1}) [{2}].\n',
    '\n[terminal] 连接错误 [{0}]。\n': '\n[terminal] Connection error [{0}].\n',
    '\n前端文件已更新，将自动重查更新状态；如需立即加载新前端可手动Refresh页面。': '\nFrontend files updated, will auto-recheck update status; manually refresh to load new frontend.',
    '\n所有文件已是最新，正在Refresh版本状态...': '\nAll files are up to date, refreshing version status...',
    '\n检测到 start-services.sh 更新：请在宿主机执行 `docker restart clawnook` 以使入口脚本变更生效。': '\nDetected start-services.sh update: run `docker restart clawnook` on the host to apply entry script changes.',
    '\n检测到 web/server.js 更新：Web 面板将自动重启，请等待 5-15 秒后重连。': '\nDetected web/server.js update: Web panel will auto-restart, please wait 5-15 seconds.',
    '\n检测到后端已更新，正在等待服务恢复后自动重查更新状态（不再强制Refresh页面）。': '\nBackend updated, waiting for service recovery to auto-recheck status (no forced page refresh).',
    '\n若容器名不确定：先执行 `docker ps --format "{{.Names}}"`，再执行 `docker restart <容器名>`。': '\nIf container name is unknown: run `docker ps --format "{{.Names}}"` first, then `docker restart <container-name>`.',
    'tar.gz 压缩包': 'tar.gz archive',
    '{0} API Key 已保存': '{0} API Key saved',
    '{0} 个文件已更新': '{0} files updated',
    '{0} 包含可疑模式: {1}': '{0} contains suspicious pattern: {1}',
    '{0} 已移除': '{0} removed',
    '{0} 需要先点击"启动设备授权"完成 OAuth 登录': '{0} requires device authorization first — click "Start Device Authorization"',
    '{0}（自动探测）': '{0} (auto-detected)',
    '• Agent 会话历史\n': '• Agent session history\n',
    '• 加密密钥（.enc_key）\n': '• Encryption keys (.enc_key)\n',
    '• 定时任务和执行记录\n\n': '• Scheduled tasks and execution records\n\n',
    '• 工作空间（SOUL.md 等 Agent 人格文件、脚本）\n': '• Workspace (SOUL.md, agent persona files, scripts)\n',
    '• 设备身份和已配对 Node\n': '• Device identity and paired Nodes\n',
    '• 配置文件（模型、渠道、安全策略）\n': '• Config files (models, channels, security policies)\n',
    '⏳ Gateway 正在自动重启，状态栏将实时更新...': '⏳ Gateway auto-restarting, status bar will update in real time...',
    '⏳ 卸载任务执行中...': '⏳ Uninstall task in progress...',
    '⏳ 后端重启中...': '⏳ Backend restarting...',
    '⏳ 强制更新中...': '⏳ Force updating...',
    '⏳ 更新中...': '⏳ Updating...',
    '⏳ 检测到已有任务进行中，接管进度显示...': '⏳ Existing task detected, taking over progress display...',
    '⏳ 正在提交重启请求...': '⏳ Submitting restart request...',
    '⏳ 等待 Gateway 启动完成（最多 10 分钟）...': '⏳ Waiting for Gateway to start (up to 10 minutes)...',
    '⏳ 等待用户完成授权…': '⏳ Waiting for user to complete authorization…',
    '⏳ 请求超时，但后端仍在重启中...': '⏳ Request timed out, but backend is still restarting...',
    '⚠ 安全扫描: {0} 条警告\n': '⚠ Security scan: {0} warnings\n',
    '⚠️ API 连续 {0} 次返回错误，停止轮询': '⚠️ API returned errors {0} times consecutively, stopping poll',
    '⚠️ Gateway 当前未运行，请Check state': '⚠️ Gateway not running, please check status',
    '⚠️ Gateway 重启超时或轮询中断，请Check state': '⚠️ Gateway restart timeout or poll interrupted, please check status',
    '⚠️ 任务执行超时，请检查日志并按需重试': '⚠️ Task execution timeout, check logs and retry if needed',
    '⚠️ 无法获取远端最新版本，已取消更新': '⚠️ Cannot fetch latest remote version, update cancelled',
    '⚠️ 无法连接 GitHub（网络不可达）': '⚠️ Cannot connect to GitHub (network unreachable)',
    '⚠️ 未检测到Local版本，已取消更新': '⚠️ No local version detected, update cancelled',
    '⚠️ 未配置': '⚠️ Not configured',
    '⚠️ 状态读取失败，使用缓存继续（{0}）': '⚠️ Status read failed, continuing with cache ({0})',
    '⚠️ 网络连续 {0} 次失败，停止轮询': '⚠️ Network failed {0} times consecutively, stopping poll',
    '⚠️ 迁移导入将覆盖当前容器的 OpenClaw 应用数据：\n\n': '⚠️ Migration import will overwrite current container\'s OpenClaw app data:\n\n',
    '⚡ 强制热更新': '⚡ Force Hot Update',
    '⚡ 热更新（不重启容器）': '⚡ Hot Update (no container restart)',
    '✅ Gateway 已恢复运行（页面Refresh后检测）': '✅ Gateway is running (detected after page refresh)',
    '✅ Gateway 重启成功': '✅ Gateway restarted successfully',
    '✅ {0} 个 Key': '✅ {0} Keys',
    '✅ {0}完成': '✅ {0} completed',
    '✅ 安装任务已启动': '✅ Install task started',
    '✅ 审批成功 (deviceId: ': '✅ Approved (deviceId: ',
    '✅ 当前已是最新版本（{0}）': '✅ Already on latest version ({0})',
    '✅ 授权成功，可再次点击Refresh授权': '✅ Authorized, click again to refresh',
    '✅ 更新任务已启动': '✅ Update task started',
    '✅ 状态已Refresh（版本：{0}，Gateway：{1}）': '✅ Status refreshed (Version: {0}, Gateway: {1})',
    '✅ 重启请求已接受，Gateway 重启中...': '✅ Restart request accepted, Gateway restarting...',
    '✓ 安全扫描通过\n': '✓ Security scan passed\n',
    '✗ {0} 个无效 Skill\n': '✗ {0} invalid Skills\n',
    '❌ {0}失败': '❌ {0} failed',
    '❌ 卸载启动失败: {0}': '❌ Uninstall start failed: {0}',
    '❌ 卸载请求失败: {0}': '❌ Uninstall request failed: {0}',
    '❌ 安装启动失败: {0}': '❌ Install start failed: {0}',
    '❌ 更新启动失败: {0}': '❌ Update start failed: {0}',
    '❌ 状态Refresh失败：{0}': '❌ Status refresh failed: {0}',
    '❌ 网络错误': '❌ Network error',
    '❌ 请求失败: {0}': '❌ Request failed: {0}',
    '❌ 轮询中断: {0}（连续失败{1}次，总耗时{2}s）': '❌ Poll interrupted: {0} (failed {1} times, total {2}s)',
    '❌ 重启失败: {0}': '❌ Restart failed: {0}',
    '不会覆盖容器配置（SSH、端口、域名等）。\n': 'Container config (SSH, ports, domain, etc.) will NOT be overwritten.\n',
    '主模型：{0}': 'Primary: {0}',
    '主模型：未设置': 'Primary: Not set',
    '停止轮询': 'Poll stopped',
    '共 {0} 个版本': '{0} versions total',
    '包含脚本文件: {0}': 'Contains script file: {0}',
    '可用备份：\n{0}\n{1}\n{2}\n': 'Available backups:\n{0}\n{1}\n{2}\n',
    '向下滚动并跟踪最新输出': 'Scroll down and follow latest output',
    '命令会根据当前 HTTPS 配置决定是否保留 NODE_TLS_REJECT_UNAUTHORIZED=0；无法可靠判断时会保守保留。': 'TLS setting is determined by current HTTPS config; NODE_TLS_REJECT_UNAUTHORIZED=0 is kept when uncertain.',
    '响应不是有效 JSON：{0}': 'Response is not valid JSON: {0}',
    '响应为空（后端未返回 JSON）': 'Empty response (backend returned no JSON)',
    '备份包含 {0} 个配置文件：\n{1}\n\n': 'Backup contains {0} config files:\n{1}\n\n',
    '大文件 (>{0}MB): {1}': 'Large file (>{0}MB): {1}',
    '安装/更新或Gateway重启执行中，暂不可配置恢复': 'Install/update or Gateway restart in progress, config restore unavailable',
    '导入前会自动备份当前数据到 /tmp/。\n': 'Current data will be auto-backed up to /tmp/ before import.\n',
    '导入后必须重启 Gateway 才能生效。\n\n确定继续？': 'Gateway must be restarted after import.\n\nContinue?',
    '已保存迁移包: ': 'Migration package saved: ',
    '已写入 channels.{0}，需重启 Gateway to apply': 'Written channels.{0}, restart Gateway to apply',
    '已取消配对；当前连接已失效，远端后台命令需手动停止或重新配对': 'Unpaired; connection invalidated. Remote background processes need manual stop or re-pair.',
    '已恢复 ': 'Restored ',
    '当前已是最新版本：{0}': 'Already on latest version: {0}',
    '成功安装 {0}/{1} 个 Skill，重启 Gateway 后生效': 'Successfully installed {0}/{1} Skills, restart Gateway to apply',
    '执行: docker restart clawnook': 'Run: docker restart clawnook',
    '执行超过 18 分钟，已停止前端轮询': 'Exceeded 18 minutes, frontend polling stopped',
    '扫描结果 — 共 {0} 个 Skill': 'Scan results — {0} Skills total',
    '找到 {0} 个 Skill\n': 'Found {0} Skills\n',
    '接口返回异常（{0}）': 'API returned error ({0})',
    '接口返回空响应（可能会话失效或页面缓存未更新，请Refresh后重试）': 'Empty API response (session may have expired or page cache outdated, please refresh and retry)',
    '未发现需要修复的配置项': 'No config items need repair',
    '未成功安装任何 Skill': 'No Skills installed successfully',
    '未检测到Local版本，请先检查安装状态': 'No local version detected, please check installation status',
    '未获取到版本列表': 'Failed to fetch version list',
    '未返回 taskId': 'No taskId returned',
    '正在启动 Discord 配对码审批...': 'Starting Discord pairing code approval...',
    '正在安装 {0} 个 Skill...\n': 'Installing {0} Skills...\n',
    '正在安装 {0}...': 'Installing {0}...',
    '正在安装...\n': 'Installing...\n',
    '正在强制拉取最新文件...\n': 'Force-pulling latest files...\n',
    '正在扫描...\n': 'Scanning...\n',
    '正在扫描本地目录: {0}\n': 'Scanning local directory: {0}\n',
    '正在拉取最新文件...\n': 'Pulling latest files...\n',
    '正在更新到 {0}...': 'Updating to {0}...',
    '正在读取文件并进行安全扫描...\n': 'Reading files and running security scan...\n',
    '状态Refresh失败': 'Status refresh failed',
    '状态：已读取（{0}；API Key：{1}）': 'Status: Loaded ({0}; API Key: {1})',
    '状态：读取失败（{0}）': 'Status: Load failed ({0})',
    '目录包含过多文件 (>{0})': 'Directory has too many files (>{0})',
    '确定取消{0}的配对吗？\n\n该节点当前在线，确认后会删除配对关系，当前连接会失效。\n如果远端是后台运行，远端命令不会自动退出，仍会继续重试连接。': 'Unpair {0}?\n\nThis node is currently online. Pairing will be removed and connection invalidated.\nIf running in background, the remote process will not auto-exit and will keep retrying.',
    '确定取消{0}的配对吗？\n\n该设备当前离线，确认后只会删除配对关系。': 'Unpair {0}?\n\nThis device is offline. Only the pairing record will be removed.',
    '确认删除 {0}？\n关联的模型配置也会被清除。': 'Delete {0}?\nAssociated model configs will also be removed.',
    '确认卸载 Extension "{0}"？': 'Uninstall Extension "{0}"?',
    '确认卸载 OpenClaw？\n将移除Local安装与源码目录。': 'Uninstall OpenClaw?\nLocal installation and source directory will be removed.',
    '确认安装 OpenClaw {0}？\n将使用 A/B 备份更新模式，Gateway 仅在切换版本时短暂停止。': 'Install OpenClaw {0}?\nA/B backup update mode will be used; Gateway stops briefly only during version switch.',
    '确认移除 Skill "{0}"？': 'Remove Skill "{0}"?',
    '离线时间': 'Offline since',
    '网络或Proxy异常': 'Network or proxy error',
    '该源中未找到包含 SKILL.md 的目录\n': 'No directories with SKILL.md found in this source\n',
    '请求失败（HTTP {0}）': 'Request failed (HTTP {0})',
    '请求超时（>{0}ms）': 'Request timeout (>{0}ms)',
    '请稍后Check state': 'Please check status later',
    '请选择 .tar.gz 迁移包': 'Please select a .tar.gz migration package',
    '输入 all 恢复全部文件：': 'Enter "all" to restore all files:',
    '输入多个序号恢复多个文件（如 1,3）\n': 'Enter multiple numbers to restore files (e.g. 1,3)\n',
    '输入序号恢复单个文件（如 1）\n': 'Enter a number to restore a single file (e.g. 1)\n',
    '输入序号选择：': 'Enter number to select:',
    '连接时间': 'Connected since',
    '部分配置需重启 Gateway to apply': 'Some configs require Gateway restart to apply',
    '配对码 {0} 已批准': 'Pairing code {0} approved',
    '配对码 {0} 已批准。': 'Pairing code {0} approved.',
    '配置恢复执行超过 8 分钟，已停止前端轮询': 'Config restore exceeded 8 minutes, frontend polling stopped',
    '配置恢复说明：\n': 'Config Restore Guide:\n',
    '错误: {0}\n': 'Error: {0}\n',
    '💡 提示: 请强制Refresh页面后重试（macOS: Command+Shift+R）': '💡 Tip: Force refresh the page and retry (macOS: Command+Shift+R)',
    '💡 检测到配置无效，请点击\u201c配置恢复\u201d按钮后重试': '💡 Invalid config detected, please click "Config Restore" and retry',
    '📂 本地目录': '📂 Local Directory',
    '📋 目标版本: {0}': '📋 Target version: {0}',
    '📦 开始安装 OpenClaw...': '📦 Starting OpenClaw installation...',
    '📦 开始安装指定版本: {0}': '📦 Installing specified version: {0}',
    '📦 开始更新 OpenClaw: {0} → {1}': '📦 Updating OpenClaw: {0} → {1}',
    '🔄 正在Refresh状态...': '🔄 Refreshing status...',
    '🔍 扫描': '🔍 Scan',
    '🗑️ 开始卸载 OpenClaw...': '🗑️ Starting OpenClaw uninstall...',

    // ────── v1.1.316 innerHTML / DOM walker keys ──────
    '在线，取消配对后当前会话会失效；远端后台进程不会自动退出': 'Online — unpairing will invalidate current session; remote background processes will not auto-exit',
    '↑ 有更新': '↑ Update available',
    '同名已安装 (Custom)': 'Same name installed (Custom)',
    'GitHub Copilot 设备授权流程：': 'GitHub Copilot Device Authorization Flow:',
    '阿里云百炼': 'Alibaba Bailian',
    '智谱': 'Zhipu',
    '小米': 'Xiaomi',
    '百度千帆': 'Baidu Qianfan',
    '火山引擎': 'Volcengine',
    '浏览器代理模式': 'Browser proxy mode',
    '接入后自动启用': 'Auto-enable after connection',
    '禁用浏览器控制': 'Disable browser control',
    '高危操作': 'High-risk operation',
    '自动审批': 'Auto-approve',

    // ────── v1.1.316 additional missing keys ──────
    '    ... 跳过 {0} 条重复/已显示的日志': '    ... skipped {0} duplicate/already shown logs',
    '# Windows 后台命令加载失败': '# Windows background command load failed',
    '# Windows 命令加载失败': '# Windows command load failed',
    '# 加载失败': '# Load failed',
    '# 后台命令加载失败': '# Background command load failed',
    '[restore] 请点击“重启 Gateway”使配置生效。': '[restore] Click "Restart Gateway" to apply config.',
    '💡 检测到配置无效，请点击“配置恢复”按钮后重试': '💡 Invalid config detected, click "Config Restore" and retry',
    // ────── v1.1.317 comprehensive i18n (innerHTML, dashboard, OAuth, skills) ──────
    '发现新版本': 'New version found',
    '需要完整更新': 'Full update required',
    '请重新执行一键安装脚本': 'Please re-run the install script',
    '⚡ 热更新': '⚡ Hot Update',
    '可热更新': 'Hot update available',
    '点击“热更新”即可，无需重装容器': 'Click "Hot Update" to apply, no container restart needed',
    '热更新仅应用容器内文件，安装脚本等宿主机文件需重新下载': 'Hot update only applies container files; host scripts need re-download',
    '当前已是最新版本': 'Already on the latest version',
    '⚡ 强制热更新': '⚡ Force Hot Update',
    '版本号相同，可强制同步远程文件': 'Same version, force sync remote files',
    '版本号相同，点击强制热更新可重新同步远程文件': 'Same version, click Force Hot Update to re-sync remote files',
    '仅容器内文件': 'container files only',
    '已是最新': 'Up to date',
    '导出中...': 'Exporting...',
    '[export] 正在打包配置文件...': '[export] Packing config files...',
    'tar.gz 压缩包': 'tar.gz archive',
    '配置导出': 'Config Export',
    '已保存配置压缩包': 'Config archive saved',
    '[export] 配置已导出: ': '[export] Config exported: ',
    '[export] 用户取消保存': '[export] User cancelled save',
    '已下载配置压缩包': 'Config archive downloaded',
    '配置导入': 'Config Import',
    '已恢复: ': 'Restored: ',
    '[import] 配置已导入: ': '[import] Config imported: ',
    ' (已备份到 ': ' (backed up to ',
    '[import] 请点击“重启 Gateway”使配置生效。': '[import] Click "Restart Gateway" to apply config.',
    '[import] 导入失败: ': '[import] Import failed: ',
    '[export] 导出失败: ': '[export] Export failed: ',
    '格式错误': 'Invalid format',
    '请选择 .tar.gz、.tgz 或 .tar 文件': 'Please select a .tar.gz, .tgz, or .tar file',
    '导入配置将覆盖当前配置（会自动备份当前配置）。\n导入后需点击“重启 Gateway”使配置生效。\n\n确定继续？': 'Importing config will overwrite current config (auto-backup will be created).\nClick "Restart Gateway" after import to apply.\n\nContinue?',
    '导入中...': 'Importing...',
    'GitHub Copilot 设备授权流程': 'GitHub Copilot Device Authorization',
    '确保你有 GitHub Copilot 订阅（个人版或企业版）': 'Ensure you have a GitHub Copilot subscription (individual or enterprise)',
    '点击“启动设备授权”按钮': 'Click the "Start Device Auth" button',
    '在弹出页面中登录 GitHub 并授权设备': 'Log in to GitHub on the popup page and authorize the device',
    '输入显示的设备码完成授权': 'Enter the displayed device code to complete authorization',
    '注意：模型名称需要以 github-copilot/ 开头': 'Note: Model names must start with github-copilot/',
    '点击此处打开 GitHub 授权页面': 'Click here to open GitHub auth page',
    '重新授权': 'Re-authorize',
    '注意': 'Note',
    '{0}: {1}': '{0}: {1}',
    '{0}: {1}({2})': '{0}: {1}({2})',
    '{0}（{1}）': '{0} ({1})',
    '{0}：{1}': '{0}: {1}',
    '{0}：{1}（{2}）': '{0}: {1} ({2})',
    '（{0}）': '({0})',
    'ℹ️ Discord {0}：{1}': 'ℹ️ Discord {0}: {1}',
    '[discord] {0}': '[discord] {0}',
    '[save] {0}': '[save] {0}',
  };

  // Reverse mapping: English server messages → Chinese
  // Used when server returns English and locale=zh
  const _serverZh = {
    'Already initialized': '已初始化',
    'Password must be at least 8 characters': '请设置至少8位的管理密码',
    'Password must include uppercase, lowercase, digits and special characters': '密码需包含大写字母、小写字母、数字和特殊字符',
    'Too many login failures, locked': '登录失败过多，已锁定',
    'Missing username or password': '缺少用户名或密码',
    'Please complete initial setup first': '请先完成初始化：设置管理密码',
    'Invalid username or password': '用户名或密码错误',
    'Missing parameters': '缺少参数',
    'New password must be at least 8 characters': '新密码至少8位',
    'Current password is incorrect': '当前密码不正确',
    'Cannot reach GitHub': '无法连接 GitHub',
    'Hot update in progress': '热更新正在进行中',
    'Hot update started': '热更新已开始',
    'Force hot update started': '强制热更新已开始',
    'Missing deviceId': '缺少 deviceId',
    'Invalid deviceId format': 'deviceId 格式无效',
    'Device not found': '未找到该设备',
    'Model cannot be empty': '模型不能为空',
    'Invalid model format': '模型格式不合法',
    'Set model failed': '设置模型失败',
    'Invalid provider': 'provider 不合法',
    'Token cannot be empty': 'token 不能为空',
    'Save auth failed': '保存认证失败',
    'Device code expired': '设备码已过期',
    'User cancelled authorization': '用户取消了授权',
    'Authorization timeout': '授权超时',
    'Failed to read config': '读取配置失败',
    'Primary model cannot be empty': '主模型不能为空',
    'Model name format should be provider/model-id': '模型名称格式应为 provider/model-id',
    'Provider has no valid API Key or auth': 'provider 没有配置有效的 API Key 或授权，请先添加',
    'Not found in OpenClaw model catalog': '未在 OpenClaw 模型目录中找到，请确认模型名称是否正确',
    'Runtime verification needed but no valid API Key': '需要进行运行时验证，但没有配置有效的 API Key',
    'Model config saved': '模型配置已保存',
    'Gateway reload requested': '已提交 Gateway 重载请求',
    'Save config failed': '保存配置失败',
    'Model not found in catalog, safe defaults used': '模型未在内置目录中找到，将使用安全默认值',
    'Provider cannot be empty': 'provider 不能为空',
    'Failed to fetch model list': '获取模型列表失败',
    'Gateway restart already in progress': 'Gateway 重启已在进行中',
    'Operation in progress': '操作进行中',
    'Restart request submitted': '重启请求已提交',
    'Release info incomplete': 'release 信息不完整',
    'Gateway starting': 'Gateway 正在启动中',
    'Token mode but no token found': 'token 模式但未读取到 token',
    'Repair task in progress': '修复任务进行中',
    'Repair task creation failed': '修复任务创建失败',
    'No exportable data files': '没有可导出的数据文件',
    'Gateway link generation failed': 'gateway link 生成失败',
    'API endpoint not found': '未找到 API 端点',
    'Gemini missing API Key': 'Gemini 缺少 API Key',
    'script command unavailable': 'script 命令不可用',
    'Entry point missing, auto-recovering via npm install': '检测到运行入口缺失，自动执行 npm 安装恢复',
    'Cannot reach version source': '无法连接版本源',
    'Version check failed': '版本检查失败',
    'Gateway unavailable': 'Gateway 不可用',
    'Invalid name': '无效的名称',
    'Skill source required': '请提供 GitHub URL 或本地目录路径',
    'Input too long': '输入过长',
  };

  // --------------- translation function ---------------

  function t(zhKey) {
    if (_locale === 'zh') {
      // Chinese: return key as-is with placeholder substitution
      let str = zhKey;
      for (let i = 1; i < arguments.length; i++) {
        str = str.replace('{' + (i - 1) + '}', arguments[i] != null ? arguments[i] : '');
      }
      return str;
    }
    // English: look up translation (normalize quotes for consistent matching)
    var nk = _normQ(zhKey);
    let str = _en[zhKey] || _en[nk] || _getNormEn()[nk] || zhKey;
    for (let i = 1; i < arguments.length; i++) {
      str = str.replace('{' + (i - 1) + '}', arguments[i] != null ? arguments[i] : '');
    }
    return str;
  }

  // Translate server API response messages
  function serverMsg(msg) {
    if (!msg || typeof msg !== 'string') return msg || '';
    if (_locale === 'zh') {
      // Server returns English; translate to Chinese
      return _serverZh[msg] || msg;
    }
    return msg;
  }

  // --------------- DOM auto-translation ---------------

  // Normalize smart/curly quotes to straight quotes for consistent key lookup
  function _normQ(s) { return s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/[\u300c\u300d]/g, '"'); }

  // Sorted keys for substring replacement (longest first)
  let _sortedKeys = null;
  // Build normalized-key → english map so both text and keys use straight quotes
  var _normEn = null;
  function _getNormEn() {
    if (_normEn) return _normEn;
    _normEn = {};
    for (var k in _en) { _normEn[_normQ(k)] = _en[k]; }
    return _normEn;
  }

  function _getSortedKeys() {
    if (_sortedKeys) return _sortedKeys;
    _sortedKeys = Object.keys(_getNormEn()).sort(function (a, b) { return b.length - a.length; });
    return _sortedKeys;
  }

  // Translate a single text node
  function _translateTextNode(node) {
    // Skip nodes inside elements marked with data-i18n-skip
    if (node.parentElement && node.parentElement.closest('[data-i18n-skip]')) return;
    const raw = node.textContent;
    if (!raw || !/[\u4e00-\u9fff]/.test(raw)) return;
    const text = _normQ(raw);
    const trimmed = text.trim();
    const ne = _getNormEn();
    if (ne[trimmed]) {
      node.textContent = text.replace(trimmed, ne[trimmed]);
      return;
    }
    // Try translating Chinese segments within mixed text
    let result = text;
    let changed = false;
    const sorted = _getSortedKeys();
    for (const zh of sorted) {
      if (result.includes(zh)) {
        result = result.split(zh).join(ne[zh]);
        changed = true;
      }
    }
    if (changed) node.textContent = result;
  }

  // Translate attributes (placeholder, title, aria-label, optgroup label)
  function _translateAttrs(el) {
    for (const attr of ['placeholder', 'title', 'aria-label', 'label']) {
      const raw = el.getAttribute(attr);
      if (!raw || !/[\u4e00-\u9fff]/.test(raw)) continue;
      const val = _normQ(raw);
      const trimmed = val.trim();
      const ne = _getNormEn();
      if (ne[trimmed]) {
        el.setAttribute(attr, val.replace(trimmed, ne[trimmed]));
        continue;
      }
      let result = val;
      let changed = false;
      const sorted = _getSortedKeys();
      for (const zh of sorted) {
        if (result.includes(zh)) {
          result = result.split(zh).join(ne[zh]);
          changed = true;
        }
      }
      if (changed) el.setAttribute(attr, result);
    }
  }

  // Walk DOM and translate all Chinese text
  function _translateDOM(root) {
    if (_locale === 'zh') return; // Chinese is the source language, no translation needed
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) {
      _translateTextNode(walker.currentNode);
    }
    // Attributes
    const elements = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title],[aria-label],[label]') : [];
    for (const el of elements) {
      if (el.closest('[data-i18n-skip]')) continue;
      _translateAttrs(el);
    }
    // <option> elements
    const options = root.querySelectorAll ? root.querySelectorAll('option') : [];
    for (const opt of options) {
      if (opt.closest('[data-i18n-skip]')) continue;
      const raw = opt.textContent;
      if (raw && /[\u4e00-\u9fff]/.test(raw)) {
        const text = _normQ(raw);
        const trimmed = text.trim();
        if (_en[trimmed]) opt.textContent = text.replace(trimmed, _en[trimmed]);
      }
    }
    // Translate <title>
    if (root === document.body && /[\u4e00-\u9fff]/.test(document.title)) {
      var nt = _normQ(document.title).trim();
      var ne = _getNormEn();
      if (ne[nt]) document.title = ne[nt];
    }
  }

  // Reverse translate (English → Chinese) for re-rendering
  function _restoreDOMChinese(root) {
    // When switching back to Chinese, reload the page for proper restore
    // (tracking original text per node would be complex)
    location.reload();
  }

  // Public applyI18n: re-translate the entire page
  function applyI18n() {
    document.documentElement.lang = _locale === 'zh' ? 'zh-CN' : 'en';
    if (_locale === 'en') {
      _translateDOM(document.body);
      _startObserver();
    } else {
      _stopObserver();
    }
    // Hide zh-only elements when locale is English
    document.querySelectorAll('.zh-only').forEach(el => {
      el.style.display = _locale === 'zh' ? '' : 'none';
    });
  }

  // MutationObserver for dynamic content
  let _observer = null;
  function _startObserver() {
    if (_locale === 'zh') return; // No translation needed
    if (_observer) return;
    _observer = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            _translateTextNode(node);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            _translateDOM(node);
          }
        }
      }
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  function _stopObserver() {
    if (_observer) { _observer.disconnect(); _observer = null; }
  }

  // --------------- language selector ---------------
  function _injectLanguageSelector() {
    const footer = document.querySelector('.sidebar-footer');
    if (!footer) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'dim';
    wrapper.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px;font-size:12px';
    wrapper.innerHTML =
      '<span style="opacity:.6">🌐</span>' +
      '<span class="lang-opt" data-lang="zh" style="cursor:pointer;padding:1px 6px;border-radius:3px">中文</span>' +
      '<span style="opacity:.3">|</span>' +
      '<span class="lang-opt" data-lang="en" style="cursor:pointer;padding:1px 6px;border-radius:3px">EN</span>';
    footer.appendChild(wrapper);

    function _updateLangUI() {
      wrapper.querySelectorAll('.lang-opt').forEach(function (el) {
        const active = el.dataset.lang === _locale;
        el.style.background = active ? 'rgba(255,255,255,.12)' : 'transparent';
        el.style.fontWeight = active ? '700' : '400';
      });
    }
    wrapper.addEventListener('click', function (e) {
      const lang = e.target.dataset && e.target.dataset.lang;
      if (lang && lang !== _locale) {
        if (lang === 'zh' && _locale === 'en') {
          // Switching to Chinese from English requires reload to restore original text
          setLocale(lang);
          location.reload();
          return;
        }
        setLocale(lang);
        _updateLangUI();
      }
    });
    _updateLangUI();
  }

  // Bind Settings-page language <select>
  function _bindSettingsLanguage() {
    var sel = document.getElementById('settings-language');
    if (!sel) return;
    // Restore correct value (DOM walker may have translated option text but value is intact)
    sel.value = _locale;
    if (sel._i18nBound) return; // avoid duplicate listeners
    sel._i18nBound = true;
    sel.addEventListener('change', function () {
      var lang = sel.value;
      if (lang && lang !== _locale) {
        setLocale(lang);
        location.reload();
      }
    });
  }

  // --------------- initialization ---------------
  function _init() {
    document.documentElement.lang = _locale === 'zh' ? 'zh-CN' : 'en';
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        _injectLanguageSelector();
        _bindSettingsLanguage();
        applyI18n();
        _startObserver();
      });
    } else {
      _injectLanguageSelector();
      _bindSettingsLanguage();
      applyI18n();
      _startObserver();
    }
  }

  // --------------- exports ---------------
  window.t = t;
  window.serverMsg = serverMsg;
  window.getLocale = getLocale;
  window.setLocale = setLocale;
  window.applyI18n = applyI18n;
  window._bindSettingsLanguage = _bindSettingsLanguage;

  _init();
})();
