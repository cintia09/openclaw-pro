# ClawNook 功能全景 — Structured Content

## Title
ClawNook 功能全景

## Learning Objectives
- 了解 ClawNook 的整体架构和核心组件
- 掌握安装部署的多种方式
- 理解 Web 控制面板的功能模块
- 了解 AI 模型接入和消息平台集成能力
- 理解热更新、自愈监控和安全机制

---

## Section 1: 核心架构
**Key Concept**: 六大核心组件协同工作
**Visual Element**: 中心是一只可爱的螃蟹吉祥物（OpenClaw Logo），周围连接六个组件图标
**Content**:
- 🌐 OpenClaw Gateway — Node.js AI消息处理网关
- 🎨 Web控制面板 — Express.js + 纯JS前端
- 🐕 Gateway Watchdog — bash守护进程
- 🔒 Caddy反向代理 — HTTPS和域名管理
- 📦 Docker容器 — Ubuntu 24.04轻量镜像
- 🔑 SSH服务 — 仅密钥认证

**Text Labels**: Gateway网关, Web面板, 看门狗, Caddy代理, Docker容器, SSH服务

---

## Section 2: 安装部署
**Key Concept**: 多种安装方式，灵活适配
**Visual Element**: 可爱的安装向导角色拿着工具箱
**Content**:
- 🚀 一键安装 — Linux/macOS/Windows 一条命令
- 📥 离线安装 — 下载源码+镜像本地运行
- 🔐 HTTPS支持 — Let's Encrypt或自签名证书
- ⚙️ 端口配置 — HTTP/HTTPS/SSH/Gateway全可自定义
- 🌍 域名配置 — FQDN或IP地址均支持

**Text Labels**: 一键安装, 离线安装, HTTPS证书, 端口配置, 域名配置

---

## Section 3: Web控制面板
**Key Concept**: 可视化管理一切
**Visual Element**: 一个可爱的仪表盘屏幕，上面有多个小窗口
**Content**:
- 📊 仪表盘 — CPU/内存/磁盘监控、Gateway状态
- 🎮 OpenClaw控制台 — 启动/停止/重启
- 💻 终端 — WebSocket实时Shell (xterm.js)
- 📋 日志查看 — Gateway/Watchdog/Web多维日志
- ⚙️ 系统设置 — 语言/时区/证书/防火墙/密码
- 🤖 AI模型配置 — Provider/Key/模型选择
- 💬 消息平台管理 — 多平台统一配置
- 🧩 技能市场 — 浏览安装技能包

**Text Labels**: 仪表盘, 控制台, 终端, 日志, 设置, AI配置, 消息平台, 技能市场

---

## Section 4: AI模型接入
**Key Concept**: 20+提供商，智能Fallback
**Visual Element**: 可爱的AI机器人连接多个云服务图标
**Content**:
- 🧠 20+提供商 — OpenAI/Claude/Gemini/DeepSeek/Ollama等
- 🔄 双层模型 — 主代理模型 + 子代理模型
- ⚡ Fallback机制 — 主模型不可用自动切换备选
- 🔑 多Key管理 — 单Provider多个API Key
- 🔍 自动模型探测 — 获取可用模型列表
- 🏠 本地模型 — Ollama/LM Studio/vLLM

**Text Labels**: 20+提供商, 双层模型, 自动Fallback, 多Key管理, 模型探测, 本地模型

---

## Section 5: 消息平台 (20+)
**Key Concept**: 一个AI助手，连接所有平台
**Visual Element**: 中心的螃蟹向四周发送消息气泡，连接各平台Logo
**Content**:
- 💬 飞书(Lark) — AppID/Secret/加密Key
- ✈️ Telegram — Token配置/用户白名单
- 🎮 Discord — 多服务器/流模式/配对码
- 📱 Signal — CLI路径/电话号码
- 📲 WhatsApp — API URL/Key配置
- 💼 更多 — 微信/Slack/钉钉等

**Text Labels**: 飞书, Telegram, Discord, Signal, WhatsApp, 微信, Slack, 钉钉

---

## Section 6: 技能市场
**Key Concept**: 扩展AI能力的生态系统
**Visual Element**: 一个可爱的商店/货架，上面摆满技能包盒子
**Content**:
- 📦 三种来源 — 用户安装/扩展Skills/内置Skills
- 🛡️ 安全检测 — 危险模式检测(eval/exec/rm等)
- 📤 多种安装 — URL安装/上传zip/本地目录
- 🎁 40+内置扩展 — 开箱即用

**Text Labels**: 用户安装, 扩展Skills, 内置Skills, 安全检测, 40+扩展

---

## Section 7: 热更新
**Key Concept**: 不停机升级，自动回退
**Visual Element**: 可爱的火箭在升级，旁边有A/B两个版本切换开关
**Content**:
- 🔥 热补丁 — Web前端/服务器脚本实时更新
- 🔄 完整更新 — Gateway核心变更重建镜像
- 🔀 A/B切换 — 自动备份、失败自动回退
- ⏰ 定期检查 — 30分钟轮询新版本

**Text Labels**: 热补丁, 完整更新, A/B切换, 自动回退, 版本检查

---

## Section 8: 自愈与监控
**Key Concept**: 7×24小时守护，自动恢复
**Visual Element**: 一只戴着护士帽的可爱看门狗，手持听诊器
**Content**:
- 🐕 Watchdog守护 — 5秒轮询/进程检测
- 🔄 自动恢复 — 3次重试/退避等待/配置回滚
- 📍 断点续传 — 记录运行时检查点
- 💾 配置备份 — 成功启动自动备份(最多30份)
- 👁️ 多服务监控 — Gateway/Web/Caddy/noVNC/Chromium

**Text Labels**: Watchdog, 自动恢复, 断点续传, 配置备份, 多服务监控

---

## Section 9: 安全特性
**Key Concept**: 多层防护，企业级安全
**Visual Element**: 一个可爱的盾牌守卫角色
**Content**:
- 🔐 PBKDF2密码哈希 — 安全存储
- 🍪 Cookie会话管理 — signed cookie
- 🔑 SSH仅密钥登录 — 禁用密码认证
- 🛡️ Caddy安全Headers — HSTS/CSP/X-Frame
- 🔒 TLS 1.2+强制 — 加密传输
- 🏗️ 容器安全 — 非root/Volume隔离
- 🚫 fail2ban — 防暴力破解

**Text Labels**: 密码哈希, 会话管理, 密钥登录, 安全Headers, TLS加密, 容器隔离, 防暴力破解
