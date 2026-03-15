# OpenClaw Pro

面向 Linux、macOS、Windows 的 OpenClaw 一键部署仓库。
当前推荐使用 ImageOnly + Lite 镜像完成安装。

## 维护脚本

如果当前已经有正在运行的 openclaw-pro 容器，并且你想把“取消配对时立即断开在线节点”的补丁重新应用到运行环境，可以执行：

```bash
./scripts/openclaw-apply-unpair-disconnect-patch.sh
```

这个脚本会同步当前仓库中的 Web 面板文件、给容器内 Gateway runtime 打补丁，并重启 Gateway 与 Web 面板进程。

## 2. 一键安装

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
```

### Windows（管理员 PowerShell）

```powershell
irm https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows.ps1 | iex
```

或下载后以管理员身份运行 `install-windows.bat`。
