# OpenClaw Pro

面向 Linux、macOS、Windows 的 OpenClaw 一键部署仓库。
当前推荐使用 ImageOnly + Lite 镜像完成安装。

## 2. 一键安装

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
