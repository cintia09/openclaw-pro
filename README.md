# OpenClaw Pro（Docker 部署包）

面向 Linux / macOS / Windows 的 OpenClaw 一键部署仓库。  
当前发布策略以 **ImageOnly + Lite 镜像** 为主：不要求先下载仓库源码，即可完成安装。

---

## 1. 当前能力概览

- 一键安装：Linux、Windows 都支持向导化流程。
- 默认镜像模式：优先 ImageOnly（仅拉取/加载发布镜像，不 clone 源码）。
- 自动恢复：本地镜像损坏会自动删除并重下，失败自动回退 GHCR。
- 安全默认：容器 SSH 默认禁用密码登录，仅密钥登录。
- Web 管理面板：内置管理 UI（默认 `3000`），含状态、配置、日志、插件/终端能力。

---

## 2. 一键安装（推荐）

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
```

### Windows（管理员 PowerShell）

```powershell
irm https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows.ps1 | iex
```

或下载后右键 `install-windows.bat` 以管理员身份运行。

---

## 3. Linux 安装流程（与 Windows 对齐）

`install.sh` 的行为：

- `curl | bash` 且检测到 `/dev/tty`：进入交互向导（通过 tty 交互）。
- `curl | bash` 且无 tty：走非交互 ImageOnly。
- 本地执行 `bash install.sh`：可选源码安装或 ImageOnly（默认 ImageOnly）。

`install-imageonly.sh` 的关键流程：

1. 选择/确认端口（并自动处理端口冲突）。
2. 检查本地镜像完整性（`gzip -t`）。
3. 若损坏或不存在：自动下载（多源 + `.part` 原子文件 + 校验）。
4. `docker load`；失败则尝试流式解压导入（`unpigz/gunzip`）。
5. 仍失败则自动回退 `ghcr.io` 拉取。
6. 创建并启动容器、注入公钥、应用 SSH 安全策略。

> 注意：Linux 已改为与 Windows 一样，**不再要求用户手工输入 root 密码**。脚本会自动生成并保存本地密码文件。

---

## 4. Windows 安装流程（当前实现）

`install-windows.ps1` 主要步骤：

1. 环境检测（管理员权限、系统版本、WSL/Ubuntu 状态）。
2. 必要时安装 WSL2 + Ubuntu（可重启后自动继续）。
3. 在 Ubuntu 中准备 Docker/运行环境。
4. 部署 OpenClaw（默认对齐 Lite / ImageOnly 流程）。
5. 收尾：SSH 配置加固、公钥注入、root 初始密码文件保存、完成信息展示。

Windows 侧同样采用：

- 自动端口冲突处理。
- SSH 密钥优先，禁用密码登录。
- 生成并保存 root 初始密码文件（本地可查）。

---

## 5. ImageOnly 落盘目录（Linux）

当在目录 `X` 执行安装时（`TARGET_DIR=X`）：

- 工作根目录：`X/openclaw-pro`
- 镜像文件：`X/openclaw-pro/openclaw-pro-image-lite.tar.gz`
- 安装日志：`X/openclaw-pro/install.log`
- root 初始密码文件：`X/openclaw-pro/root-initial-password.txt`
- 持久化数据：`X/openclaw-pro/home-data/root` 与 `X/openclaw-pro/home-data/username`

---

## 6. Docker 镜像内部功能

### Lite 镜像（当前主发布）

来源：`Dockerfile.lite`

内置能力：

- Ubuntu 24.04 基础环境。
- 基础运维工具（curl/wget/git/ssh/net-tools 等）。
- Node.js 22。
- Caddy。
- Web 管理面板（`/opt/openclaw-web`）。
- `start-services.sh` 作为容器入口。

不内置（按需安装/恢复）：

- Chrome/noVNC 图形浏览器能力。
- LightGBM 等交易推理依赖。
- `openclaw` CLI（若缺失，网关会被跳过）。

### Full 镜像（仓库支持）

来源：`Dockerfile`

额外内置：

- Chrome + noVNC。
- LightGBM/pandas/numpy/baostock。
- `openclaw` CLI。

---

## 7. 容器运行与服务编排

入口脚本：`start-services.sh`

主要职责：

- 配置 DNS（dnsmasq + DoH 兜底 + hosts 预写）。
- 恢复/加固 SSH（host key 持久化、禁用密码登录）。
- 启动 Web 管理面板（3000）。
- 启动 OpenClaw 网关（若 CLI 可用）及 watchdog。
- 根据配置决定 Caddy/HTTPS/浏览器相关服务。

Web 后端：`web/server.js`

- Express + cookie 签名认证。
- 提供状态、配置、日志、插件市场、终端等 API。
- WebSocket 支持日志与终端通道。
- DNS 失败时提供 fetch/curl 回退策略。

---

## 8. 常用命令（源码模式）

```bash
./openclaw-docker.sh run
./openclaw-docker.sh stop
./openclaw-docker.sh status
./openclaw-docker.sh logs
./openclaw-docker.sh shell
./openclaw-docker.sh config
```

---

## 9. 故障排查

### 镜像导入失败（`unpigz ... corrupted`）

这是本地 tar 包损坏的典型表现，安装脚本已自动处理：

- `gzip -t` 失败会自动删除并重下。
- `docker load` 失败会尝试流式导入和 GHCR 回退。

可手动查看日志：

```bash
cat openclaw-pro/install.log
```

### 容器未启动

```bash
docker ps -a | grep openclaw-pro
docker logs openclaw-pro
```

### SSH 无法登录

- 确认使用密钥登录（默认禁用密码登录）。
- 检查宿主机公钥是否注入到容器 `/root/.ssh/authorized_keys`。

---

## 10. 说明

- 目前文档以 **当前代码行为** 为准。若脚本更新，请同步更新本 README。
- 若你希望“纯源码模式”为默认行为，可将 `install.sh` 的默认选项改回源码安装。
