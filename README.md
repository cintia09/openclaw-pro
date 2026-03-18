<p align="center">
  <img src="docs/images/banner.svg" alt="OpenClaw Pro" width="680" />
</p>

<p align="center">
  <a href="https://github.com/cintia09/openclaw-pro/releases"><img src="https://img.shields.io/github/v/release/cintia09/openclaw-pro?style=for-the-badge&color=f97316" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/cintia09/openclaw-pro/stargazers"><img src="https://img.shields.io/github/stars/cintia09/openclaw-pro?style=for-the-badge&color=f97316" alt="Stars"></a>
</p>

<p align="center">
  <strong>你的私人 AI 助手，一键部署到任何平台。</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw">OpenClaw</a> ·
  <a href="#一键安装">安装</a> ·
  <a href="#截图">截图</a> ·
  <a href="https://docs.openclaw.ai">文档</a>
</p>

---

[OpenClaw](https://github.com/openclaw/openclaw) 是一款开源的个人 AI 助手，支持接入 Discord、飞书、微信、Telegram、Slack、WhatsApp 等 20+ 平台，通过灵活的技能（Skills）和扩展（Extensions）机制，让 AI 真正融入你的日常工作流。

**OpenClaw Pro** 是面向 Linux、macOS、Windows 的 OpenClaw **一键部署工具**，提供：

- 🚀 **一键安装** — 一条命令完成 Docker 镜像拉取、容器创建、Gateway 启动
- 🔄 **热更新** — Web 控制面板内一键升级，支持 A/B 版本切换与自动回退
- 🛡️ **自愈能力** — Gateway Watchdog 健康监控、异常自动恢复、运行时断点续传
- 🎨 **Web 控制面板** — 可视化管理配置、模型、技能插件、安装/更新状态
- 🧩 **技能市场** — 在线浏览、安装、更新社区技能包

> 💬 OpenClaw 交流群：QQ `852036008`

## 截图

<details open>
<summary><b>📸 Web 控制面板一览（点击展开/收起）</b></summary>
<br/>

<table>
  <tr>
    <td><img src="docs/images/screenshot-01.png" width="400" /></td>
    <td><img src="docs/images/screenshot-02.png" width="400" /></td>
  </tr>
  <tr>
    <td><img src="docs/images/screenshot-03.png" width="400" /></td>
    <td><img src="docs/images/screenshot-04.png" width="400" /></td>
  </tr>
  <tr>
    <td><img src="docs/images/screenshot-05.png" width="400" /></td>
    <td><img src="docs/images/screenshot-06.png" width="400" /></td>
  </tr>
  <tr>
    <td><img src="docs/images/screenshot-07.png" width="400" /></td>
    <td><img src="docs/images/screenshot-08.png" width="400" /></td>
  </tr>
</table>

</details>

## 一键安装

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
```

### Windows（管理员 PowerShell）

Windows 安装当前仅保留 Docker Desktop 方案。
请先安装并启动 Docker Desktop，再执行下面的安装命令。

```powershell
irm https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows-bootstrap.ps1 | iex
```

或下载后以管理员身份运行 `install-windows.bat`。

## 许可证

[MIT](LICENSE)
