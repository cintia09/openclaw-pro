# OpenClaw Pro — Docker 部署包

一键部署 OpenClaw AI 助手到任意平台（Linux / macOS / Windows）。

## 快速开始

### 一键安装（推荐）

#### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
```

#### Windows

优先方式（更稳）：下载仓库后，右键 `install-windows.bat` → **以管理员身份运行**。

或在 **管理员 PowerShell** 中执行：

```powershell
irm https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows.ps1 | iex
```

#### 安装器会自动做什么

- 检测并准备环境（Windows 下自动处理 WSL2 / Ubuntu / Docker）
- 拉取并部署 Release 镜像（ImageOnly 优先）
- 自动检查 SSH 状态并关闭 SSH 密码登录（仅密钥登录）
- 尝试注入公钥（无公钥时自动生成 `id_ed25519` 再注入）
- 生成 root 初始密码文件（仅用于容器内本地管理）
- 安装结束后默认进入容器终端（`docker exec -it <container> bash`）

> 目录说明：安装目录在当前路径的 `openclaw-pro/`，持久化数据目录在 `openclaw-pro/home-data/`（多实例时为 `home-data-2`、`home-data-3` ...）。

### 一键升级（推荐）

统一方式：**重新执行一键安装脚本**。安装器会自动识别已部署实例并执行升级。

Linux / macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
```

Windows：

```powershell
irm https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows.ps1 | iex
```

> 升级默认保留 `home-data` 与配置。

### 手动安装（源码模式）

```bash
git clone https://github.com/cintia09/openclaw-pro.git openclaw-pro
cd openclaw-pro
chmod +x openclaw-docker.sh
./openclaw-docker.sh run
```

首次运行会引导你完成配置（root 密码、端口、HTTPS 域名等）。

访问地址：
- **内网/直连模式（不填域名）**:
  - Gateway：`http://服务器IP:18789`
  - Web管理面板：`http://服务器IP:3000`
- **HTTPS模式（填写域名）**:
  - Web管理面板：`https://你的域名:8443`
  - Gateway UI：`https://你的域名:8443/gateway`

### Windows

#### 方案A：Docker Desktop（有Docker Desktop的用户）

1. 安装 [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)
2. 打开 PowerShell：
```powershell
git clone https://github.com/cintia09/openclaw-pro.git openclaw-pro
cd openclaw-pro
bash openclaw-docker.sh run
```

#### 方案B：自动安装 WSL2 + Docker Engine（无需 Docker Desktop）

1. 下载解压部署包
2. 右键 `install-windows.bat` → **以管理员身份运行**
3. 按提示操作（可能需要重启一次，重启后会自动继续）
4. 完成后访问：
   - Gateway：`http://localhost:18789`
   - Web管理面板：`http://localhost:3000`

**Windows 系统要求：**
- Windows 10 版本 2004（Build 19041）或更高
- Windows 11 全版本支持
- 需要管理员权限

**安装过程概览：**
```
[1/5] 检测环境（Windows版本/WSL2/Ubuntu）
[2/5] 安装 WSL2 + Ubuntu 24.04     ← 首次安装约需 3-5 分钟
[3/5] 安装 Docker Engine           ← 约需 5-10 分钟
[4/5] 部署 OpenClaw Pro
[5/5] 启动服务 + 显示完成信息
```

> 如果脚本提示需要重启，重启后会**自动继续**（已创建 Windows 计划任务）。
> 所有操作日志保存在 `install-log.txt`。
> 安装完成后会默认进入容器终端；如需返回 PowerShell，输入 `exit`。

**Windows 管理命令（部署完成后，在 WSL 终端中运行）：**
```bash
wsl -d Ubuntu-24.04
cd /root/openclaw-pro
./openclaw-docker.sh status   # 查看状态
./openclaw-docker.sh logs     # 查看日志
./openclaw-docker.sh stop     # 停止服务
./openclaw-docker.sh run      # 重新启动
```

## 命令参考

| 命令 | 说明 |
|------|------|
| `./openclaw-docker.sh run` | 启动（首次进入配置向导） |
| `./openclaw-docker.sh stop` | 停止容器 |
| `./openclaw-docker.sh status` | 查看状态 |
| `./openclaw-docker.sh config` | 修改配置 |
| `./openclaw-docker.sh shell` | 进入容器终端 |
| `./openclaw-docker.sh rebuild` | 重建镜像 |
| `./openclaw-docker.sh logs` | 查看日志 |

## 目录结构

```
openclaw-pro/          ← 部署脚本和Docker文件
├── openclaw-docker.sh    # 主管理脚本
├── install.sh            # 一键安装入口（curl|bash）
├── Dockerfile            # 容器镜像定义
├── docker-compose.yml    # Compose配置（备用，脚本默认用docker create）
├── start-services.sh     # 容器内入口
├── motd.sh               # 登录欢迎界面
├── Caddyfile.template    # HTTPS反代配置（envsubst模板）
├── web/                  # Web管理面板
│   ├── server.js
│   └── public/
│       ├── index.html
│       ├── login.html
│       ├── login.js
│       ├── style.css
│       └── app.js
├── install-windows.bat   # Windows安装入口（双击运行）
├── install-windows.ps1   # Windows安装脚本（WSL2+Docker）
├── update-windows.bat    # 兼容保留（建议优先使用安装脚本执行升级）
├── update-windows.ps1    # 兼容保留（建议优先使用安装脚本执行升级）
├── README.md
└── home-data/            ← 持久化数据（自动创建，挂载为容器/root）
    ├── .openclaw/
    │   ├── openclaw.json     # OpenClaw配置
    │   ├── docker-config.json # Docker部署配置
    │   └── logs/             # 日志
    └── ...                   # 你的工作文件
```

## 安全最佳实践

1. **设置强root密码** — 首次运行必填
2. **启用HTTPS** — 填写域名自动启用Caddy + Let's Encrypt
3. **启用ufw + fail2ban** — 首次运行时推荐开启
4. **容器安全加固**:
   - `cap_drop ALL` + `no-new-privileges`
   - 不挂载 Docker socket
   - HTTPS 模式下 Gateway/Web 面板端口仅绑定 127.0.0.1（外部只走 Caddy 反代）
5. **Web 面板账号** — 首次访问需要初始化设置管理密码（至少8位）
6. **文件权限** — `docker-config.json/openclaw.json` 建议 600，`home-data/` 建议 700

> **注意：** Caddy basicauth 和 Web 面板登录是两层独立认证。如果不需要 Caddy 层的 basicauth，可以在 `Caddyfile.template` 中注释掉 `basicauth` 块，只保留 Web 面板自身的登录认证即可。

## 交易系统

### 安装

通过Web面板 → 交易系统 → 填写GitHub Token和仓库地址 → 点击安装

### 功能

- 券商配置
- 策略参数管理
- 自动交易开关（默认关闭，红字风险提示）
- 持仓看板（只读）
- 一键更新（git pull）

### 依赖

容器预装 LightGBM, pandas, numpy, baostock 用于量化推理。

## 故障排除

### 容器无法启动

```bash
# 查看Docker日志
docker logs openclaw-pro

# 检查镜像是否构建成功
docker images | grep openclaw-pro
```

### Gateway不在线

```bash
# 进入容器
./openclaw-docker.sh shell

# 手动启动
openclaw gateway start

# 查看日志
cat /root/.openclaw/logs/gateway-start.log
```

### Web面板无法访问

```bash
# 进入容器检查
./openclaw-docker.sh shell
curl http://localhost:3000/api/status
```

### HTTPS证书问题

```bash
# 进入容器查看Caddy日志
./openclaw-docker.sh shell
cat /root/.openclaw/logs/caddy.log
```

### 重置所有配置

```bash
./openclaw-docker.sh stop
docker rm openclaw-pro
# 删除配置（保留数据）
rm home-data/.openclaw/docker-config.json
./openclaw-docker.sh run
```
