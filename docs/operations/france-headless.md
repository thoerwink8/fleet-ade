# 法国 VPS 无界面 ADE 运维手册

本文档说明法国机器上无界面 ADE 服务端（`fleet-ade.service`）的安装、更新、配对、会话撤销与日常巡检方法。

## 1. 边界与原则

- **只走 WireGuard 隧道**：服务端绑定 `--host 192.0.2.2 --port 3773`，`ufw` 仅放行 `wg-fleet` 网卡来自 `192.0.2.0/24` 的 `3773/tcp`，公网网卡不监听、不放行，不挂任何公网域名或反向代理。
- **专用系统用户与独立运行时**：以专用系统用户 `ade`（无 `sudo`）运行；Node `26.12.1` 与 `pnpm@12.14.0` 仅装在 `/home/ade/.local` 下，绝不改动系统 `/usr/bin/node`（`v22.23.2`）和现有引擎服务。
- **独立模型与仓库凭据**：`ade` 用户使用自己独立的 `/home/ade/.grok`，以及单独一份 GitHub App 凭据（`/etc/fleet-ade/github-app.json`，`root:ade 0640`）换来的安装令牌访问 `thoerwink8/fleet-ade`，不用任何个人令牌，也不复用其他系统用户的凭据或轮换 OIDC 凭据；`ade` 不在 `fleet` 组；法国机器上禁用 `claudeAgent` 与 `codex`，仅启用 `grok`。
- **离得开上游服务**：`T3CODE_TELEMETRY_ENABLED=false`、`OTEL_SDK_DISABLED=true`、`T3CODE_OTEL_SDK_DISABLED=true`、`enableProviderUpdateChecks=false` 常驻开启，不连接任何 `t3.codes` / `t3coderelay.com` 上游域名。
- **并发与资源闸门**：服务端通过 `--max-concurrent-sessions 2`（及 `settings.json` 中的 `maxConcurrentSessions: 2`）将跨会话并发轮次限制为 2 个；超出上限的新轮次在持久出站队列排队，空闲会话按上限及时回收。

## 2. 目录与单元布局

| 路径 / 单元                             | 属主与权限         | 说明                                                                                                                                        |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/ade/.local/node`                 | `ade:ade`          | 指向 `node-v26.12.1-linux-x64`（自带 `npm` 独立安装 `pnpm@12.14.0` 至 `/home/ade/.local/pnpm-12.14.0`，入口在 `/home/ade/.local/bin/pnpm`） |
| `/home/ade/.local/bin/t3`               | `ade:ade` `0755`   | `t3` CLI 包装脚本（自动指定 `T3CODE_HOME=/var/lib/fleet-ade/home` 并关闭遥测）                                                              |
| `/home/ade/.grok`                       | `ade:ade` `0750`   | `ade` 独立的 Grok CLI 与登录态                                                                                                              |
| `/var/lib/fleet-ade/app`                | `ade:ade` `0750`   | 指定 40 位提交的代码检出与构建产物（`apps/server/dist/bin.mjs`）                                                                            |
| `/var/lib/fleet-ade/home`               | `ade:ade` `0750`   | ADE 数据目录（`userdata/statev2.sqlite`、`userdata/settings.json`、日志）                                                                   |
| `/var/lib/fleet-ade/repos`              | `ade:ade` `0750`   | 法国环境中的项目主检出与工作树目录                                                                                                          |
| `/etc/fleet-ade/service.env`            | `root:ade` `0640`  | 监听地址、端口与并发上限覆盖项                                                                                                              |
| `/etc/systemd/system/ade.slice`         | `root:root` `0644` | 顶层资源池（与现有引擎和 `gha-runner.slice` 隔离）                                                                                          |
| `/etc/systemd/system/fleet-ade.service` | `root:root` `0644` | 常驻无界面服务端单元                                                                                                                        |

## 3. 资源预算（6 vCPU / 12 GiB 宿主机）

法国机器同时承载现有引擎、2 个自建 CI 跑机（`gha-runner.slice`）与无界面 ADE：

| 工作负载                                 | systemd Slice                     | CPU 权重 / 配额                 | 内存上限（`MemoryHigh` / `MemoryMax`）     | `Nice` |
| ---------------------------------------- | --------------------------------- | ------------------------------- | ------------------------------------------ | ------ |
| 现有引擎与后端服务                       | 默认 / 既有 slice                 | `CPUWeight=100`（最高优先）     | 按既有配置保持不变                         | `0`    |
| 无界面 ADE（常驻 + 最多 2 个 Grok 会话） | `ade.slice` / `fleet-ade.service` | `CPUWeight=50`、`CPUQuota=250%` | `2560M` / `3072M`（`MemorySwapMax=1024M`） | `5`    |
| 自建 CI 跑机（2 实例共享）               | `gha-runner.slice`                | `CPUWeight=25`、`CPUQuota=500%` | `7680M` / `8704M`                          | `10`   |
| ADE 安装与更新构建（临时单元）           | `ade-build.slice`                 | `CPUWeight=20`、`CPUQuota=200%` | `3584M` / `4096M`                          | `15`   |

> [!IMPORTANT]
> root 的 SSH 会话位于 `user-0.slice`（`MemoryHigh=2G`、`MemoryMax=3G`）。`france-install.sh` 与 `france-update.sh` 内部均已通过 `systemd-run --wait --pipe --collect` 将 `pnpm install` 与 `vp run --filter t3 build` 放入临时 `ade-build.slice` 执行，切勿在裸 SSH 会话中直接手跑构建。

## 4. 首次安装

1. 为 `ade` 用户登录 Grok（GitHub 凭据由第 4 节的脚本在安装时配好，不需要 `gh auth login`）：

   ```bash
   sudo -iu ade /home/ade/.grok/bin/grok login
   ```

2. 以 `root` 执行安装脚本并传入要部署的 40 位提交号（远端 SSH 命令一律加 `timeout`）。`/etc/fleet-ade/github-app.json` 还不存在时，加 `--github-app-source <GitHub App 的 JSON 文件>` 从它创建（见第 4 节）：

   ```bash
   sudo bash scripts/deploy/france-install.sh <40位提交SHA> [--github-app-source <App JSON>]
   ```

   脚本会自动完成：建 `ade` 用户与目录、校验并安装 Node `26.12.1` + `pnpm@12.14.0`、配好 GitHub App 凭据与 git 凭据助手（第 4 节）、在临时构建 cgroup 中编译 `t3`、合并 `settings.json`（设置 `maxConcurrentSessions: 2`；机器互连始终开启）、安装 `ade.slice` 与 `fleet-ade.service`、配置 `ufw` 仅在 `wg-fleet` 放行 `3773/tcp`、启动服务并校验监听地址。

### 4.1 GitHub App 凭据（`ade` 推 PR 用）

`ade` 用 GitHub App 安装令牌拉取和推送 `thoerwink8/fleet-ade`，提交和 PR 的作者是 App 机器人，不是个人账号。App 需已安装到 `thoerwink8/fleet-ade`，权限含 `contents` 与 `pull_requests` 写。

`scripts/deploy/france-github-app.sh`（`france-install.sh` 与 `france-update.sh` 都会调用，可重复执行）负责：

| 项                                                  | 说明                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/etc/fleet-ade/github-app.json`（`root:ade 0640`） | 只在文件不存在时由 `--source` 创建，只拷 `id`、`client_id`、`slug`、`pem` 四个字段，不带 webhook 与 client 密钥；不打印任何值                  |
| `/home/ade/.local/bin/git-credential-fleet-ade-app` | git 凭据助手：用 App 私钥签 JWT，换 1 小时有效的安装令牌（限定仓库 `fleet-ade`），缓存在 `~/.cache/fleet-ade/`，剩余不足 10 分钟时自动重新换发 |
| `/home/ade/.gitconfig`                              | 助手只对 `https://github.com/thoerwink8/fleet-ade`（含 `.git` 结尾）生效（`useHttpPath`），其他远端不会拿到令牌；提交身份设为 App 机器人       |
| `/home/ade/.local/bin/gh`                           | `gh` 包装脚本：未设置 `GH_TOKEN` 时用同一个助手取安装令牌再调 `/usr/bin/gh`，供 Grok 会话开 PR                                                 |

首次配置（法国机器上已有同一个 App 的 JSON 时，由有权限的人执行）：

```bash
sudo bash scripts/deploy/france-github-app.sh --source <App JSON 路径>
```

验证（不打印令牌）：

```bash
sudo -iu ade git ls-remote https://github.com/thoerwink8/fleet-ade.git HEAD
```

## 5. 日常更新（拉提交 → 构建 → 重启）

需要升级法国无界面 ADE 到新提交时，以 `root` 运行：

```bash
sudo bash /var/lib/fleet-ade/app/scripts/deploy/france-update.sh <新的40位提交SHA>
```

构建期间旧的 `fleet-ade.service` 继续提供服务；构建通过后脚本执行 `systemctl restart fleet-ade.service`，并等待 `http://192.0.2.2:3773/.well-known/t3/environment` 就绪及校验监听地址仍仅绑定 `192.0.2.2:3773`。

## 6. 本机通过 WireGuard 配对与撤销会话

1. **本机加入 WireGuard 内网**：本机作为 `192.0.2.0/24` 节点（如 `192.0.2.3/32`，`AllowedIPs = 192.0.2.0/24`）经香港跳板转发直达 `192.0.2.2:3773`，只路由 `192.0.2.0/24` 子网，不改动系统代理或 Clash 配置。
2. **签发一次性配对链接**：在法国机器以 `ade` 用户签发配对链接：

   ```bash
   sudo -iu ade t3 auth pairing create --base-url http://192.0.2.2:3773 --label "local-workstation"
   ```

3. **在本机 ADE 配对**：
   - 机器互连始终开启，无需配置 `linkedEnvironmentsEnabled`；
   - 在环境列表中添加远端环境，填入上一步输出的 `http://192.0.2.2:3773/pair#token=...` 配对地址，完成后状态显示为「已连接」。
4. **查看与立即撤销会话**：

   ```bash
   sudo -iu ade t3 auth session list
   sudo -iu ade t3 auth session revoke <session-id>
   ```

   `t3 auth session revoke` 会通知正在运行的 `fleet-ade.service` 立即吊销该会话并断开已建立的 WebSocket 连接，本机 ADE 随即变为断开状态。

## 7. 验收与巡检命令

- **核查仅监听隧道地址**：

  ```bash
  ss -ltnp | grep 3773
  sudo ufw status numbered | grep 3773
  ```

- **核查公网地址不可达**：从隧道外向 `<法国公网IP>:3773` 发起 TCP 连接应超时或拒绝。
- **核查无上游域名连接**：

  ```bash
  journalctl -u fleet-ade.service --since "24 hours ago" --no-pager \
    | grep -Ei 't3\.codes|t3coderelay\.com' || echo "zero upstream hits"
  ```

## 8. 协调者交接

配对机之间可以交出机群协调者；交出返回 `handed-over-unconfirmed` 表示本机任期已改、但目标机没确认收到。未确认的目标机靠下一次任期交换收敛；自动重推和开机互拉由后续版本提供，目前没有。若旧协调者此后永久不可用（磁盘坏、退役），直接在新协调者所在机器上 `force` 接管即可，不需要人工修任期表。
