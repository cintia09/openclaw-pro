# OpenClaw 安装/更新/启动重构测试集与执行步骤（含端到端）

## 1. 文档目标

本测试文档用于验证《`docs/openclaw-install-update-watchdog-design.md`》中的重构方案，覆盖：

1. 从 GitHub 官方仓库源码下载并本地编译安装。
2. watchdog 统一拉起与守护 Gateway。
3. 启动成功后的配置自动备份。
4. 启动失败且判定为配置问题时的自动回滚（仅一次）。
5. Web 手动恢复历史备份（按时间选择）。
6. 安装/更新/重启期间按钮禁用与状态联动。
7. 安全控制与审计能力。

---

## 2. 测试范围

### 2.1 范围内

- `web/server.js`（安装/更新/重启/备份恢复 API）
- `web/public/app.js`（按钮态、状态刷新、恢复交互）
- `scripts/openclaw-gateway-watchdog.sh`（健康检查、自愈、备份、回滚）
- `start-services.sh`（SSH 用户与公钥同步、服务入口）
- 容器内 OpenClaw 源码构建流程（下载、构建、替换）

### 2.2 范围外

- Trading 业务功能正确性
- noVNC/Chromium 图形业务测试
- 第三方网络稳定性（仅记录失败，不作为功能缺陷）

---

## 3. 测试环境与前置条件

## 3.1 环境要求

1. Linux 主机，Docker 可用。
2. `clawnook` 容器可启动。
3. 主机可访问 GitHub（`github.com` / `api.github.com`）。
4. Web 管理页可访问（默认 `http://<host>:3000`）。

## 3.2 关键路径检查

在容器内确认以下路径：

- `/root/.openclaw/openclaw-source`
- `/root/.openclaw/openclaw.json`
- `/root/.openclaw/config-backups`
- `/root/.openclaw/logs/gateway-watchdog.log`
- `/root/.openclaw/logs/openclaw-gateway.log`

---

## 4. 直接登录容器调试与测试（必须能力）

## 4.1 查找容器

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep openclaw
```

如果容器名不是 `clawnook`，将下文命令中的容器名替换为实际值。

## 4.2 进入容器（交互调试）

```bash
docker exec -it clawnook bash
```

## 4.3 容器内常用调试命令

```bash
# 进程与端口
pgrep -af 'openclaw|watchdog'
ss -tlnp | grep 18789

# 查看日志
tail -n 200 /root/.openclaw/logs/gateway-watchdog.log
tail -n 200 /root/.openclaw/logs/openclaw-gateway.log

# 健康检查
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18789/health
curl -sS http://127.0.0.1:3000/api/openclaw | jq .
```

## 4.4 容器外快速单命令调试（无需进入交互 shell）

```bash
docker exec clawnook bash -lc 'pgrep -af "openclaw|watchdog"; tail -n 60 /root/.openclaw/logs/gateway-watchdog.log'
```

---

## 5. 测试数据准备

1. 准备一个“合法配置”模板（可使 Gateway 正常启动）。
2. 准备一个“非法配置”模板（例如注入非法 key，如 `providers` 或错误 schema 字段）。
3. 确保备份目录可写：

```bash
docker exec clawnook bash -lc 'mkdir -p /root/.openclaw/config-backups && chmod 700 /root/.openclaw/config-backups'
```

4. 清理历史测试噪声（仅测试环境）：

```bash
docker exec clawnook bash -lc 'rm -f /root/.openclaw/config-backups/openclaw-*.json'
```

---

## 6. 完整测试集（功能 + 安全 + 端到端）

## 6.1 功能测试集（F）

| ID | 测试目标 | 前置条件 | 步骤 | 预期结果 |
|---|---|---|---|---|
| F-01 | 全新安装成功 | 未安装 OpenClaw | Web 点击“安装” | 安装任务成功，版本可见，Gateway 运行中 |
| F-02 | 更新成功 | 已安装旧版本 | Web 点击“更新” | 更新任务成功，版本提升，Gateway 自动拉起 |
| F-03 | watchdog 单实例 | watchdog 已运行 | 重复触发 start-services/watchdog | 仅一份 watchdog 进程存在 |
| F-04 | Gateway 崩溃自动拉起 | Gateway 正常运行 | 手动 kill gateway 进程 | watchdog 在可接受时间内拉起 Gateway |
| F-05 | 配置变更触发自动备份 | 存在合法配置 | 修改配置并重启 Gateway | 生成新备份文件，mtime 更新 |
| F-06 | 配置不变不重复备份 | 已有最近备份 | 不修改配置连续重启 | 备份文件数量不增加 |
| F-07 | 启动失败触发自动回滚一次 | 存在 last_good 备份 | 写入非法配置并重启 | 自动回滚一次并重试启动 |
| F-08 | 回滚后仍失败进入人工态 | 构造无法恢复场景 | 连续失败直到回滚后仍失败 | 不再自动反复回滚，提示人工恢复 |
| F-09 | Web 手动恢复指定备份 | 有多个备份 | 在页面选择指定时间备份恢复 | 配置恢复成功，目标备份生效 |
| F-10 | 按钮禁用联动 | 任一任务运行中 | 观察安装/更新/重启/恢复按钮 | 全部禁用，任务结束后恢复 |
| F-11 | 状态接口一致性 | 服务运行中 | 轮询 `/api/openclaw` 与 `/api/status` | UI 状态与进程/日志一致 |
| F-12 | 任务日志完整性 | 触发安装/更新任务 | 轮询 task API | 可增量读取日志，状态终态正确 |
| F-13 | 安装/更新/Gateway 启动日志正确显示 | 已启用 OpenClaw 引擎页 | 执行安装/更新并触发重启，检查 `oc-log` 与 `/api/openclaw/gateway/logs` | UI 显示包含任务日志 + Gateway/Watchdog 启动日志快照，日志源正确 |
| F-14 | Gateway 运行日志路径自愈 | 删除 runtime 日志文件后触发重启 | 检查 watchdog 与 gateway 日志 | 不出现 `No such file or directory`；运行日志可写入 runtime 或 legacy 兜底路径 |
| F-15 | 状态聚合字段完整性 | 服务运行中 | 调用 `/api/openclaw` | 返回 `gatewayWatchdogRunning`、`operationState`、`lastBackupAt`、`lastRollbackAt` 字段且语义正确 |

## 6.2 安全测试集（S）

| ID | 测试目标 | 步骤 | 预期结果 |
|---|---|---|---|
| S-01 | 未认证请求拦截 | 未登录访问写接口（install/update/restore/start） | 返回 401 |
| S-02 | 路径穿越防护 | `name=../../etc/passwd` 调用恢复接口 | 返回 400/404，不发生越权访问 |
| S-03 | 文件名白名单 | 使用非法文件名（含空格、斜杠） | 被拒绝 |
| S-04 | 日志脱敏 | 注入包含 token/password 的输入并查看日志 | 日志中敏感值被 `***` 替代 |
| S-05 | 并发互斥 | 并发触发 install+update+start | 仅一个任务执行，其余复用或拒绝 |
| S-06 | 恢复前保护备份 | 执行手动恢复 | 生成 `before-restore` 备份 |
| S-07 | 回滚次数限制 | 连续触发配置错误启动 | 每个启动周期最多自动回滚一次 |
| S-08 | 备份目录权限 | 检查备份目录/文件权限 | 目录 700，文件 600（或符合安全基线） |
| S-09 | 安装来源可审计 | 执行安装后查看 source metadata | 包含 repo/tag/tarballUrl/installedAt |
| S-10 | API 输入校验 | 传入非法 repo/tag 参数 | 后端拒绝并返回明确错误 |
| S-11 | SSH 公钥登录一致性 | `HOST_USER` 模式下检查 `AllowUsers` 与用户 `authorized_keys` | 非 root 用户可密钥登录，避免 `Permission denied (publickey)` |
| S-12 | 日志源优先级与标记 | 同时存在 runtime/legacy 日志 | 调用 `/api/openclaw/gateway/logs` | 仅返回一个 Gateway 主日志源（runtime 优先），并带 `[gateway-runtime]/[gateway-legacy]/[watchdog]` 标记 |
| S-13 | 统一操作锁 | 并发触发 install/update/start/repair | 同类任务复用，跨类型返回冲突（409），`operationState` 与实际执行一致 |

## 6.3 端到端测试集（E2E）

| ID | 场景 | 预期 |
|---|---|---|
| E2E-01 | 全新安装到可用 | 安装完成，Gateway/Watchdog/UI 状态一致 |
| E2E-02 | 版本更新到可用 | 更新完成，版本变化，服务不中断或快速恢复 |
| E2E-03 | 配置变更→成功重启→自动备份 | 新备份出现，状态正常 |
| E2E-04 | 非法配置→自动回滚→恢复启动 | 自动回滚一次后恢复成功 |
| E2E-05 | 手动按时间恢复备份 | 选定备份恢复成功并可重启生效 |
| E2E-06 | 任务进行中 UI 禁用与后端互斥 | 无并发冲突，无重复执行 |
| E2E-07 | watchdog 失效恢复 | watchdog 异常后被拉起并继续守护 |
| E2E-08 | 安全回归链路 | 鉴权、输入校验、审计日志均通过 |
| E2E-09 | SSH 登录链路（HOST_USER） | 非 root 用户（如 `wm_20`）可使用宿主机公钥登录 |
| E2E-10 | Gateway 启动日志链路自愈 | runtime 日志文件缺失后仍能恢复并输出正确启动日志 |

---

## 7. 端到端详细执行步骤

## 7.1 E2E-01：全新安装到可用

1. 清理旧安装状态（测试环境）。
2. 打开 Web 管理页，进入 OpenClaw 引擎页面。
3. 点击“安装”，观察日志流。
4. 安装成功后检查：
   - `/api/openclaw` 返回 `installed=true`
   - `gatewayRunning=true`
   - `pgrep -af 'openclaw|watchdog'` 均存在
5. 验证 Gateway：
   - `curl http://127.0.0.1:18789/health` 返回 `200/401/403` 之一；若返回 `503`，需同时满足端口监听与 `/api/openclaw.gatewayRunning=true` 才判定健康。

## 7.2 E2E-02：版本更新到可用

1. 保持已安装状态。
2. 触发“更新”。
3. 观察 task 日志是否包含新 tag/版本信息。
4. 更新完成后确认：
   - 版本字段变化（若远端确有更新）。
   - Gateway 在 watchdog 拉起后恢复健康。

## 7.3 E2E-03：配置变更后自动备份

1. 记录当前备份数量：
   ```bash
   docker exec clawnook bash -lc 'ls -1 /root/.openclaw/config-backups/openclaw-*.json 2>/dev/null | wc -l'
   ```
2. 修改配置（合法变更），触发 Gateway 重启。
3. 检查备份目录数量 +1，且 `mtime` 最新。
4. 检查 watchdog 日志出现 `backup-created` 事件。

## 7.4 E2E-04：非法配置触发自动回滚一次

1. 写入非法配置项（例如插入不被 schema 允许的 key）。
2. 触发 Gateway 重启。
3. 观察 watchdog 日志：
   - 检测配置错误
   - 执行 rollback attempt
   - 再次启动
4. 断言：
   - 自动回滚仅发生一次
   - Gateway 最终可用或进入人工介入态（明确日志）

## 7.5 E2E-05：Web 手动按时间恢复

1. 在页面打开“配置恢复”列表。
2. 选择一个历史时间点备份并确认恢复。
3. 检查返回成功，当前配置被替换。
4. 可选执行“恢复并重启 Gateway”，验证服务恢复。

## 7.6 E2E-06：并发与按钮禁用

1. 触发一个长任务（安装或更新）。
2. 在任务执行期间尝试点击“更新/重启/恢复”。
3. 断言：
   - 前端按钮禁用；
   - 后端并发请求被拒绝或复用已有任务，不创建新冲突任务。

## 7.7 E2E-07：watchdog 失效恢复

1. 人工终止 watchdog 进程（测试环境）。
2. 触发健康循环或入口脚本自恢复逻辑。
3. 验证 watchdog 被重新拉起，且能继续监控 Gateway。

## 7.8 E2E-08：安全回归链路

1. 未登录调用关键写接口，验证 401。
2. 用非法备份名调用恢复接口，验证拒绝。
3. 检查日志脱敏。
4. 检查安装来源元数据可追溯。

## 7.9 E2E-09：SSH 登录链路（HOST_USER）

1. 在容器内确认 ssh 配置：
   - `sshd -T | grep -E 'allowusers|permitrootlogin|passwordauthentication|pubkeyauthentication'`
2. 确认用户与公钥：
   - `id <host_user>`
   - `ls -la /home/<host_user>/.ssh`
   - `tail -n 5 /home/<host_user>/.ssh/authorized_keys`
3. 从宿主机执行：
   - `ssh -p <ssh_port> <host_user>@<host_ip>`
4. 断言：
   - 非 root 用户公钥登录成功。
   - 不出现 `Permission denied (publickey)`。

## 7.10 E2E-10：Gateway 启动日志链路自愈

1. 在容器内模拟 runtime 日志目录缺失：
   - `rm -f /root/.openclaw/logs/openclaw-gateway.log`
2. 触发 Gateway 重启（Web 按钮或 `POST /api/openclaw/start`）。
3. 检查 watchdog 日志与 gateway 日志：
   - `tail -n 120 /root/.openclaw/logs/gateway-watchdog.log`
   - `ls -l /root/.openclaw/logs/openclaw-gateway.log 2>/dev/null`
   - `tail -n 80 /root/.openclaw/logs/openclaw-gateway.log 2>/dev/null || tail -n 80 /root/.openclaw/logs/gateway.log`
4. 调用日志接口（已登录会话）：
   - `GET /api/openclaw/gateway/logs?lines=200`
5. 断言：
   - 不出现 `.../openclaw-gateway.log: No such file or directory`。
   - 返回内容包含来源标记并可读（gateway + watchdog）。

---

## 8. 推荐执行命令清单

```bash
# 1) 检查 openclaw 状态
curl -sS http://127.0.0.1:3000/api/openclaw | jq .

# 2) 检查通用状态
curl -sS http://127.0.0.1:3000/api/status | jq .

# 3) 检查 watchdog / gateway 进程
docker exec clawnook bash -lc 'pgrep -af "openclaw|watchdog"'

# 4) 检查备份列表
docker exec clawnook bash -lc 'ls -lt /root/.openclaw/config-backups'

# 5) 查看关键日志
docker exec clawnook bash -lc 'tail -n 120 /root/.openclaw/logs/gateway-watchdog.log'
docker exec clawnook bash -lc 'tail -n 120 /root/.openclaw/logs/openclaw-gateway.log'
```

---

## 9. 缺陷判定与通过标准

### 9.1 通过标准

1. F/S/E2E 全部用例通过，且无 P0/P1 缺陷。
2. 自动回滚、手动恢复、按钮禁用、状态联动均稳定。
3. 容器内调试流程可重复执行（命令可用、结果可观测）。

### 9.2 阻塞缺陷（必须修复）

- 无法安装或无法更新。
- watchdog 无法守护 Gateway。
- 配置错误无法回滚且无人工恢复路径。
- 恢复接口存在路径穿越或未授权写风险。

---

## 10. 测试记录模板（建议）

每次执行记录以下字段：

- 执行人 / 日期 / 环境
- Git commit / 镜像版本
- 用例 ID
- 实际结果（通过/失败）
- 关键日志片段
- 缺陷单号（如有）
