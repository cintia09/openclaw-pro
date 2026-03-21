# ClawNook 功能全景

## 核心架构
- **OpenClaw Gateway**：Node.js AI消息处理网关 (port 18789/18790)
- **Web控制面板**：Express.js + 纯JS前端 (port 3000)
- **Gateway Watchdog**：bash脚本守护进程，生命周期管理
- **Caddy反向代理**：HTTPS和域名管理
- **Docker化部署**：基于Ubuntu 24.04轻量级镜像
- **SSH服务**：仅密钥认证

## 安装部署
- **一键安装**：Linux/macOS/Windows 一条命令完成
- **离线安装**：下载源码+镜像，本地运行脚本
- **HTTPS支持**：Let's Encrypt自动证书或自签名
- **端口配置**：HTTP/HTTPS/SSH/Gateway全可自定义
- **域名配置**：支持FQDN或IP地址

## Web控制面板
- **仪表盘**：CPU/内存/磁盘使用率、Gateway状态
- **OpenClaw控制台**：启动/停止/重启、版本管理
- **AI模型配置**：多Provider、多Key、Fallback机制
- **消息平台**：飞书/Telegram/Discord/Signal/WhatsApp等20+平台
- **技能市场**：浏览/安装/上传技能包
- **远端设备**：noVNC浏览器远程访问
- **终端**：WebSocket实时Shell (xterm.js)
- **系统设置**：语言/时区/证书/防火墙/密码
- **日志查看**：Gateway/Watchdog/Web面板多维日志

## AI模型接入
- **20+提供商**：OpenAI、Claude、Gemini、DeepSeek、Ollama等
- **双层模型**：主代理模型 + 子代理模型
- **Fallback机制**：主模型不可用时自动切换备选
- **多Key管理**：单Provider支持多个API Key
- **自动模型探测**：获取可用模型列表
- **本地模型**：Ollama/LM Studio/vLLM

## 消息平台 (20+)
- 飞书(Lark)、Telegram、Discord、Signal、WhatsApp
- 微信、Slack、钉钉等
- 配对码审批机制
- 平台独立配置

## 技能市场
- **三种来源**：用户安装/扩展Skills/内置Skills
- **安全检测**：危险模式检测(eval/exec/rm等)
- **多种安装**：URL安装/上传zip/本地目录扫描
- **40+内置扩展**

## 热更新机制
- **热补丁**：Web前端/服务器脚本实时更新，无需重启
- **完整更新**：Gateway核心变更时重建镜像
- **A/B切换**：自动备份、失败回退
- **定期检查**：30分钟轮询新版本

## 自愈与监控
- **Watchdog守护**：5秒轮询、进程存活检测
- **自动恢复**：3次重试、退避等待、配置回滚
- **断点续传**：记录运行时检查点
- **配置备份**：成功启动自动备份(最多30份)
- **多服务监控**：Gateway/Web/Caddy/noVNC/Chromium

## 安全特性
- **PBKDF2密码哈希**
- **Cookie会话管理**
- **SSH仅密钥登录**
- **Caddy安全Headers** (HSTS/CSP/X-Frame)
- **TLS 1.2+强制**
- **容器安全**：非root运行、Volume隔离
- **fail2ban防暴力破解**
