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
    // English: look up translation
    let str = _en[zhKey] || zhKey;
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

  // Translate a single text node
  function _translateTextNode(node) {
    // Skip nodes inside elements marked with data-i18n-skip
    if (node.parentElement && node.parentElement.closest('[data-i18n-skip]')) return;
    const text = node.textContent;
    if (!text || !/[\u4e00-\u9fff]/.test(text)) return;
    const trimmed = text.trim();
    if (_en[trimmed]) {
      node.textContent = text.replace(trimmed, _en[trimmed]);
      return;
    }
    // Try translating Chinese segments within mixed text
    let result = text;
    let changed = false;
    // Sort keys by length (longest first) to avoid partial matches
    const sorted = _sortedKeys || (_sortedKeys = Object.keys(_en).sort((a, b) => b.length - a.length));
    for (const zh of sorted) {
      if (result.includes(zh)) {
        result = result.split(zh).join(_en[zh]);
        changed = true;
      }
    }
    if (changed) node.textContent = result;
  }
  let _sortedKeys = null;

  // Translate attributes (placeholder, title, aria-label)
  function _translateAttrs(el) {
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const val = el.getAttribute(attr);
      if (!val || !/[\u4e00-\u9fff]/.test(val)) continue;
      const trimmed = val.trim();
      if (_en[trimmed]) {
        el.setAttribute(attr, val.replace(trimmed, _en[trimmed]));
        continue;
      }
      let result = val;
      let changed = false;
      const sorted = _sortedKeys || (_sortedKeys = Object.keys(_en).sort((a, b) => b.length - a.length));
      for (const zh of sorted) {
        if (result.includes(zh)) {
          result = result.split(zh).join(_en[zh]);
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
    const elements = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title],[aria-label]') : [];
    for (const el of elements) {
      if (el.closest('[data-i18n-skip]')) continue;
      _translateAttrs(el);
    }
    // <option> elements
    const options = root.querySelectorAll ? root.querySelectorAll('option') : [];
    for (const opt of options) {
      if (opt.closest('[data-i18n-skip]')) continue;
      const text = opt.textContent;
      if (text && /[\u4e00-\u9fff]/.test(text)) {
        const trimmed = text.trim();
        if (_en[trimmed]) opt.textContent = text.replace(trimmed, _en[trimmed]);
      }
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
    }
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
