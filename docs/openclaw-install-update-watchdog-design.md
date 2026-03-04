# OpenClaw 安装/更新/启动重构设计文档（按当前代码校准）

## 1. 背景与目标

当前 openclaw-pro 已具备 OpenClaw 安装、更新、watchdog 拉起、配置备份与手动恢复的基础能力，但实现分散，状态联动与异常恢复策略仍需统一。

本次重构目标（对应需求原文）：

1. OpenClaw 必须从 GitHub 官方仓库下载源码并在本地编译安装（容器内本地构建）。
2. Gateway 统一由 watchdog 启动与守护。
3. Gateway 每次成功重启后，watchdog 检测配置变化，若有变化自动备份。
4. Gateway 启动失败时，若判定为配置问题，自动恢复最近一次成功配置，仅自动恢复一次。
5. Web 页面提供“手动恢复备份配置”能力，用户可按时间选择历史备份恢复。
6. 安装/更新/重启 Gateway 期间，相关按钮不可操作（禁用态）。
7. OpenClaw 安装/启动成功后，Web 页面状态正确反映。
8. Gateway 启动成功后，OpenClaw 控制台状态正确反映。

---

## 2. 现状评估（基于当前代码）

### 2.1 已有能力

- `web/server.js`
  - 已有源码安装/更新任务框架（`/api/openclaw/install`、`/api/openclaw/update`）。
  - 已有从 GitHub Release 获取源码包并本地编译的命令构建器（`buildOpenClawSourceInstallCommand`）。
  - 已有 OpenClaw 状态接口（`/api/openclaw`）及任务轮询接口。
  - 已有配置备份列表与恢复接口（`/api/openclaw/config/backups`、`/api/openclaw/config/restore`）。
  - 接口鉴权已接入（`app.use('/api', requireAuthApi)`，未登录返回 401）。
- `scripts/openclaw-gateway-watchdog.sh`
  - 已有 watchdog 单实例锁、进程/端口健康检测、自动重启。
  - 已有“配置变更自动备份”（hash 比对）。
  - 已有“配置失败时自动回滚最近备份并重试一次”逻辑。
- `web/public/app.js`
  - 已有安装/更新/重启按钮及并发禁用逻辑（`syncOpenClawButtons`）。
  - 已有手动配置恢复流程（当前为 `prompt` 输入选择）。
  - 已有状态轮询并更新 OpenClaw 卡片状态。

### 2.2 Docker 镜像编译依赖检查结论

- `Dockerfile` / `Dockerfile.lite` 已内置源码构建关键依赖：`nodejs 22`、`npm`、`git`、`curl`、`tar`、`python3`、`build-essential`。
- 镜像已预装 `pnpm@10.23.0` 与 `rolldown@1.0.0-rc.6`（降低运行时安装抖动）。
- `buildOpenClawSourceInstallCommand` 在 node/npm 缺失时仍有兜底安装逻辑（`apt + nodesource`）。
- 结论：按当前安装链路（`npm install` + `npm run build/compile`）所需依赖已覆盖；当前流程未显式使用 `cmake` 等额外 C/C++ 工具链。

### 2.3 主要差距

1. **源码来源约束仍可增强**：当前默认仓库为 `openclaw/openclaw`，但允许环境变量覆写，尚未做仓库白名单开关。
2. **watchdog “单次自动回滚”仍为隐式逻辑**：当前通过失败后仅回滚并重试一次实现，缺少结构化状态字段与事件指标。
3. **手动恢复交互较弱**：当前 `prompt` 方式不适合备份较多场景，缺少按时间可视化选择。
4. **状态面统一度不足**：Web 状态、watchdog 事件、控制台反馈需同源并可解释（如“已回滚/待人工处理”）。
5. **后端互斥锁仍分散**：当前为安装任务锁、修复文件锁、重启布尔锁，尚未统一 operation lock 域。

---

## 3. 重构范围与非目标

### 3.1 范围内

- OpenClaw 安装/更新/启动链路重构（源码下载、编译、安装、watchdog 拉起）。
- watchdog 配置备份与自动回滚策略增强。
- Web 侧恢复配置能力升级（按时间选择）。
- 任务进行中按钮禁用与状态联动增强。

### 3.2 范围外

- 交易系统（trading）功能重构。
- Caddy/noVNC 体系重构。
- OpenClaw 自身业务逻辑（非网关生命周期）变更。

---

## 4. 目标架构

```text
Web UI (app.js/index.html)
    │
    ▼
Web API (server.js)
  ├─ Operation Manager（安装/更新/重启互斥锁）
  ├─ Source Build Manager（GitHub 源码下载+本地编译）
  ├─ Config Backup API（列举/恢复）
  └─ Status Aggregator（openclaw + watchdog + gateway）
    │
    ▼
Watchdog (openclaw-gateway-watchdog.sh)
  ├─ 启停与健康探测
  ├─ 成功启动后配置变更备份
  └─ 配置错误自动回滚（一次）
```

---

## 5. 目录与数据规范

### 5.1 关键路径

- OpenClaw 源码目录：`/workspace/project/openclaw`
- OpenClaw 配置：`/root/.openclaw/openclaw.json`
- 备份目录：`/root/.openclaw/config-backups`
- watchdog 日志：`/root/.openclaw/logs/gateway-watchdog.log`
- Gateway 日志：`/workspace/tmp/openclaw-gateway.log`
- 源码安装元数据：`/root/.openclaw/openclaw-source-install.json`

### 5.2 备份命名与索引

- 备份文件：`openclaw-YYYYMMDD-HHMMSS.json`
- 当前已使用索引：
  - `.last_hash`：最近成功备份配置 hash
  - `.last_good`：最近成功备份文件路径
- 新增建议：
  - `manifest.json`（可选）：记录每个备份的来源、hash、恢复次数、是否自动回滚候选。

---

## 6. 状态机设计

### 6.1 操作状态机（安装/更新/重启）

- `idle`：空闲
- `installing`
- `updating`
- `restarting_gateway`
- `repairing_config`
- `failed`
- `success`

规则：

1. 任一非 `idle` 状态时，安装/更新/重启/恢复按钮全部禁用。
2. 后端接口执行前必须先检查 operation lock（当前为分散锁，见第 11 节）。
3. 前端状态以 `/api/openclaw` 返回的远端状态为准，本地状态仅作过渡。

### 6.2 watchdog 启动状态机

- `down` → `starting` → `healthy`
- `starting` → `failed_config`（检测到配置错误）
- `failed_config` → `rollback_once` → `starting`
- `rollback_once` 后再次失败 → `failed_manual_intervention`

核心约束：每次启动流程仅自动回滚并重试一次。

---

## 7. 关键流程设计

## 7.1 安装流程（从官方 GitHub repo 源码）

1. Web 调用 `POST /api/openclaw/install`。
2. 若安装任务已在运行，后端直接返回复用 `taskId`。
3. 解析源码仓库（优先环境变量，其次 npm metadata，最终默认 `openclaw/openclaw`）。
4. 拉取 `releases/latest` 并生成 codeload tarball 地址。
5. 下载 tarball（本地缓存 + 重试），失败回退 `git clone --branch <tag>`。
6. 依赖校验与构建（node/npm 检查、npm 依赖安装、pnpm 可用性检查、执行 `build`/`compile` 脚本）。
7. 原子替换运行目录（先构建到临时目录，成功后切换）。
8. 写入安装元数据（repo/tag/tarball/installedAt）。
9. 任务成功后由前端触发 `POST /api/openclaw/start`，仅终止 gateway 进程，由 watchdog 拉起。

## 7.2 更新流程

与安装流程一致，区别为：

- 前端在调用前先通过 `/api/openclaw` 判断 `hasUpdate`。
- 后端 `POST /api/openclaw/update` 当前复用安装构建流程。
- 成功后重启链路同安装流程（由 watchdog 拉起）。

## 7.3 Gateway 重启流程

1. `POST /api/openclaw/start`。
2. 后端检查 `gatewayRestartRunning` 布尔锁并置位。
3. 仅终止 gateway 进程，不直接启动。
4. watchdog 检测到 down 后执行标准启动流程。
5. 启动成功后触发配置变更检查与备份。
6. 状态聚合接口反映最终状态，前端解除禁用。

---

## 8. 配置备份与自动回滚策略

## 8.1 自动备份触发条件

触发时机：Gateway 启动成功（healthy）后。

策略：

1. 读取 `openclaw.json` 计算 hash。
2. 与 `.last_hash` 对比，不同则创建新备份并更新 `.last_hash/.last_good`。
3. 超过保留上限（默认 30）执行滚动删除。

## 8.2 自动回滚触发条件

触发条件（满足其一）：

- 启动阶段日志命中配置错误特征（`Unrecognized key`、`Invalid config`、schema/validation/parse）。
- Gateway 进程快速退出且日志中有配置错误证据。

处理：

1. 若本启动周期未执行过自动回滚，则从 `.last_good`（无则最近备份）恢复。
2. 同一启动流程内仅重试一次。
3. 若仍失败，进入 `failed_manual_intervention`，等待用户手动恢复。

---

## 9. Web 手动恢复设计（按时间选择）

## 9.1 后端 API

沿用并增强：

- `GET /api/openclaw/config/backups`
  - 当前返回字段：`name, path, size, mtimeMs, mtime`
  - 默认按 `mtime desc` 排序。
- `POST /api/openclaw/config/restore`
  - 当前入参：`name`
  - 行为：恢复前先备份当前配置到 `openclaw.json.before-restore.<ts>.bak`，再拷贝目标备份。

## 9.2 前端交互

将当前 `prompt` 替换为弹窗/列表：

1. 展示最近 N 条备份（时间、大小、文件名）。
2. 支持按时间降序选择。
3. 点击确认后执行恢复。
4. 恢复成功后可一键“恢复并重启 Gateway”。

---

## 10. 按钮禁用与状态联动

## 10.1 禁用规则

按钮：`安装/更新`、`配置恢复`、`重启 Gateway`。

禁用条件（任一为 true）：

- `installTaskRunning`
- `repairTaskRunning`
- `gatewayRestartRunning`
- 本地轮询态 `ocInstallRunning/ocRepairRunning/ocStartRunning`

> 现有 `syncOpenClawButtons` 已具备基础能力，本次统一以后端状态为主。

## 10.2 状态显示一致性

`/api/openclaw` 当前已输出：

- `installed, version, latestVersion, hasUpdate, updateCheckError`
- `gatewayRunning`
- `installSource`
- `installTaskRunning, repairTaskRunning, gatewayRestartRunning`
- `invalidConfigKeys`

建议新增：

- `gatewayWatchdogRunning`
- `operationState`
- `lastBackupAt` / `lastRollbackAt`

Web 卡片与 Gateway 控制台统一展示：

1. 安装状态
2. Gateway 运行状态
3. watchdog 在线状态
4. 最近备份/回滚事件

---

## 11. 并发控制与幂等

当前实现：

1. install/update 复用 `activeInstallTaskId` 作为任务幂等入口。
2. repair 使用独立文件锁 `REPAIR_LOCK_FILE=/tmp/openclaw-config-repair.lock`。
3. gateway restart 使用 `gatewayRestartRunning` 布尔锁。
4. watchdog 单实例锁已实现（`flock + lock_dir`）。

待完善：

1. 后端统一 operation lock（文件锁或内存锁+pid 校验）：
   - `/tmp/openclaw-operation.lock`
2. install/update/start/repair 共享同一锁域。
3. 明确跨接口复用策略（统一 taskId 或标准拒绝码）。

---

## 12. 安全与可靠性要求（增强）

### 12.1 威胁模型与安全边界

1. 受保护资产：
   - OpenClaw 配置（含认证信息/密钥）。
   - 源码安装链路（repo、tag、tarball）。
   - 运行状态与日志（可能含敏感字段）。
2. 主要攻击面：
   - Web 管理接口（未授权调用、参数注入）。
   - 备份恢复接口（路径穿越、恶意文件恢复）。
   - 源码下载与构建链路（供应链污染、伪造版本）。
   - 容器内调试入口（越权登录、敏感数据泄露）。
3. 边界原则：
   - Web 仅暴露必要 API；容器内脚本不直接暴露到公网。
   - 仅允许在容器内本地环回调用 watchdog/gateway 管理命令。

### 12.2 供应链与源码安装安全

1. 当前默认仓库为官方仓库（`openclaw/openclaw`），但允许通过 `OPENCLAW_SOURCE_REPO` 覆写；建议增加白名单开关。
2. 仅允许 `https://github.com/<owner>/<repo>` 与 GitHub release tarball 源。
3. 当前已记录安装来源元数据（`repo/tag/tarballUrl/installedAt`）到 `/root/.openclaw/openclaw-source-install.json`。
4. 对下载 tarball 执行完整性校验（`tar -tzf`），失败不进入构建阶段。
5. 构建时使用最小权限环境，不允许执行来源不明的额外脚本（仅执行受控 npm/build 命令）。

### 12.3 配置备份/恢复安全

1. 备份恢复文件名严格白名单（保留现有 regex）。
2. 禁止路径穿越（`path.join` 后前缀校验，保留现有实现）。
3. 恢复前自动备份当前配置（`before-restore`），保证可回退。
4. 备份目录权限建议：
   - `/root/.openclaw/config-backups`：`700`
   - 备份文件：`600`
5. 恢复动作审计（记录操作者会话、时间、目标备份、恢复结果）为待补齐项。

### 12.4 API 与会话安全

1. 安装/更新/重启/恢复接口必须经过鉴权，未登录返回 `401`。
2. 对关键写操作增加操作锁（operation lock），防止并发重放导致状态错乱。
3. 输入参数校验：
   - repo/tag/name 参数采用白名单字符集。
   - 对 JSON body 做字段白名单过滤，拒绝未知关键字段。
4. 高风险接口（恢复配置、触发更新）建议增加二次确认 token（短时有效）。

### 12.5 日志与敏感信息保护

1. 日志持续脱敏：`token/password/apiKey/secret`。
2. 禁止在日志中打印完整配置明文；必要时仅输出字段名与摘要。
3. 备份列表 API 默认不返回配置内容，仅返回元信息（时间、大小、名称）。
4. 任务日志保留上限和轮转，防止日志膨胀导致磁盘压满。

### 12.6 watchdog 自愈安全策略

1. 自动回滚仅执行一次，避免“坏配置 ↔ 回滚”循环。
2. 回滚前必须检测失败特征属于配置错误，避免误回滚覆盖用户最新合法配置。
3. 自动回滚失败后进入人工介入态，不继续自动覆盖配置。
4. 回滚成功/失败事件统一打点，便于审计与告警。

---

## 13. 可观测性设计（待增强）

watchdog 日志统一事件前缀：

- `[wd][start]`
- `[wd][healthy]`
- `[wd][backup-created]`
- `[wd][rollback-attempt]`
- `[wd][rollback-success]`
- `[wd][rollback-failed]`

Web 状态接口聚合以下信号：

- process/port 健康
- watchdog 进程存在
- 最近一次回滚结果
- 最近一次备份时间

---

## 14. 测试与验收

## 14.1 功能测试

1. 安装：全新环境从官方 GitHub repo 安装成功，Gateway 由 watchdog 拉起。
2. 更新：检测到新版本后更新成功，状态正确刷新。
3. 自动备份：修改配置并重启成功后生成新备份。
4. 自动回滚：注入无效配置，启动失败触发一次自动回滚并恢复。
5. 手动恢复：Web 选择指定时间备份恢复成功。
6. 按钮禁用：安装/更新/重启期间相关按钮不可用。
7. 状态一致：Web 状态、watchdog 日志、Gateway 控制台状态一致。

## 14.2 失败场景

- GitHub 下载失败（重试 + 回退 git clone）。
- 构建失败（任务失败并保留日志）。
- 无可用备份时自动回滚失败（明确提示人工恢复）。
- 自动回滚后仍失败（不再自动循环）。

---

## 15. 实施计划（建议）

### Phase 1：后端与锁模型
- 统一 operation lock。
- 规范 install/update/start 任务状态输出。
- `/api/openclaw` 增强状态字段。

### Phase 2：watchdog 策略增强
- 显式“单次自动回滚”状态位。
- 备份/回滚事件日志标准化。

### Phase 3：Web 恢复交互升级
- 从 `prompt` 升级为可视化备份选择弹窗。
- 增加“恢复并重启”快捷操作。

### Phase 4：联调与验收
- 端到端验证 14.1/14.2 全部场景。
- 输出发布回滚说明。

---

## 16. 需求映射（逐条对应）

1. GitHub 官方 repo + 本地编译安装：第 7.1 节。
2. watchdog 启动：第 6.2/7.3 节。
3. 成功重启后配置变更自动备份：第 8.1 节。
4. 配置问题导致启动失败时自动恢复一次：第 8.2 节。
5. Web 手动按时间恢复备份：第 9 节。
6. 安装/更新/重启期间按钮禁用：第 10.1 节。
7. 安装启动后 Web 状态正确反映：第 10.2 节。
8. Gateway 启动后控制台状态正确反映：第 10.2/13 节。

---

## 17. 结论

本方案在保持当前代码结构可演进的前提下，重点补齐三件事：

1. 安装/更新/重启的统一状态机与并发互斥；
2. watchdog 的“成功备份 + 失败单次回滚”闭环；
3. Web 与控制台的一致状态可观测能力。

落地后可实现“自动化安装更新 + 可恢复 + 可解释 + 可运维”的稳定网关生命周期管理。
