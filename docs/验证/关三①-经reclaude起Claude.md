# 关三① 经 reclaude 起 Claude

核对 ADE 用绝对路径 `C:\Users\example\.local\bin\reclaude.exe` 起 Claude，homePath 留空，实例环境不放 `ANTHROPIC_*`。起 ADE 的那个进程去掉 `HTTPS_PROXY`、`HTTP_PROXY`、`https_proxy`、`http_proxy`、`ALL_PROXY`、`all_proxy`、`NODE_EXTRA_CA_CERTS`。用户自己的代理、hosts、全局 Node 没有改。

二进制路径在工作树 `.t3/userdata/settings.json` 的 `providerInstances.claudeAgent.config.binaryPath`。没有 `homePath`，没有 `environment`。

## 拉起

第一次：2026-11-13 23:51:24 +08，`vp run dev --no-seed`，server pid 52524，端口 14987。能力探测完成（installed，version 2.1.323，status ready，auth status authenticated）。进程随后被停掉，没有进入会话。这次探测算进额度。

第二次（获准的再起一次）：2026-11-14 00:09:34 +08，server pid 33136，端口 14987，web 端口 6947，baseDir 为本工作树 `.t3`。起进程时上述 7 个代理/证书变量和 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 都是 absent。代理端口按去掉之前的环境记为 56879。

这次会话和回退都在 pid 33136 上完成。之后 dev runner 又换过两次 server：00:33 pid 7272，00:37 pid 39024。两次都不是新的用户会话，各拉起一次 `reclaude.exe → claude.exe`，父进程仍是 `reclaude.exe`。00:51 端口 14987 已经没有监听。磁盘上的 provider cache 现在是最后一次启动写下的：checkedAt 2026-11-14 00:37:56 +08，version 2.1.323，status ready，auth status authenticated。

## 核对① 进程链

`Get-CimInstance Win32_Process` 只取 Name、ProcessId、ParentProcessId。

探测那一轮，00:09:48：

`claude.exe:11772 ← reclaude.exe:12536 ← node.exe:33136 ← node.exe:48884 ← node.exe:13084 ← cmd.exe:54120 ← node.exe:15736 ← node.exe:31000 ← cmd.exe:22716 ← pnpm-native.exe:34452 ← node.exe:8652 ← cmd.exe:50904 ← pwsh.exe:51740 ← grok.exe:31348 ← Mirasim.exe:17352 ← Mirasim.exe:26836 ← explorer.exe:11868`

会话那一轮，从 00:11:33 到回退前的 00:23:28，链一直是：

`claude.exe:56300 ← reclaude.exe:45832 ← node.exe:33136 ← （同上，直到 explorer.exe:11868）`

`claude.exe` 的父进程是 `reclaude.exe`，再上是这次 ADE 的 node（33136）。

## 核对② 三个 ANTHROPIC 变量

不读子进程环境。三样证据：

1. 第二次拉起时，起 ADE 的进程环境里 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 都是 absent。
2. 实例环境 0 条。`settings.json` 的 `claudeAgent` 没有 `environment`。
3. 代码不会替进程写入这三个键：
   - `apps/server/src/provider/Drivers/ClaudeHome.ts`：`makeClaudeEnvironment` 在 homePath 为空时原样返回传入环境（第 37–39 行），不设置 `CLAUDE_CONFIG_DIR`。`mergeClaudeProcessEnvironment`（第 74–82 行）复制宿主环境，只设置 `CLAUDE_CODE_ENTRYPOINT=t3-code`，删掉一组 `CLAUDE_*` 宿主会话变量和 `ELECTRON_RUN_AS_NODE`，再交给实例环境合并。
   - `packages/provider-core/src/server/instanceEnvironment.ts` 第 11–13 行：实例环境为空时原样返回。
   - `packages/provider-core/src/server/snapshotProbe.ts` 第 124–125 行：探测环境只加 `MISE_OFFLINE=1`。
   - `apps/server/src/provider/ClaudeProvider.ts` 第 428、776–777 行只读取 `ANTHROPIC_BASE_URL`。
   - `@anthropic-ai/claude-agent-sdk` 的 `sdk.mjs`：第 27 行是这三个名字的导出表；第 148–151 行是错误文案和名字列表；第 161 行读取 `process.env.ANTHROPIC_API_KEY`。这些位置都不是赋值。

## 核对③ ADE 自己不走 56879

`Get-NetTCPConnection` 看 ADE node（pid 33136）和它的非 claude 子进程有没有连到 `127.0.0.1:56879`。

探测窗口 9 次（00:09:56–00:11:13）：node=0，reclaude=0，other=0，claude=0。

会话窗口：00:11:22 和 00:11:30 仍全是 0。00:11:38 到回退前有 32 次采到 claude=4，node、reclaude、other 仍是 0。`claude.exe` 自己连 56879 按约定不算。回退之后 claude 也回到 0。全部 242 次 TCP 采样里 node、reclaude、other 都是 0，没有失败行。

后面两次换进程的采样同样是 node=0、reclaude=0、other=0。

## 会话和检查点回退

一个线程，provider `claudeAgent`，模型 `claude-sonnet-5-5`，一轮。回合在线程自己的工作树里写了 `guan3-probe.txt`，内容是 `probe-ok` 加一个换行。该工作树在本工作树的 `.t3/worktrees/` 下，不进这个 PR。

回退用产品命令 `checkpoint.rollback`，`restoreFiles: true`。目标是该线程 ordinal 0、app run 为空、status ready 的检查点（回合前的快照）。dispatch 返回 sequence 53。2026-11-14 00:23:30 +08 再找这个文件，已经没有。

## 计数

`event: non-cc-client` 在 `~/.reclaude/logs/daemon.log` 的行数，和 `~/.mirasim/traffic/` 里含 `non_cc_client` 的文件数。只记数字。

| 时刻                                                | daemon 行数 | traffic 文件数 |
| --------------------------------------------------- | ----------- | -------------- |
| 2026-11-13 23:28:12 +08（第一次拉起前）             | 0           | 0              |
| 2026-11-14 00:09:34 +08 之前的几次复核              | 0           | 0              |
| 2026-11-14 00:48:00 +08（回退之后，含后面两次启动） | 0           | 0              |
| 2026-11-14 00:51:00 +08 再核 daemon                 | 0           | —              |

dev.log 和 `.t3/userdata/logs` 里，「仅支持 Claude Code 客户端」、`non_cc_client`、`non-cc-client` 的出现次数都是 0。

## 花了多久

从第二次拉起（00:09:34）到回退确认文件消失（00:23:30），13 分 56 秒。到 00:48 的结束计数，38 分 26 秒。从第一次拉起（23:51:24）到这次结束计数，56 分 36 秒。
