# 关一 Linux 测试基线

上游 CI 的单测跑在 Linux。这里是同一套命令在一台 WSL2 发行版里跑完的记录。

## 环境

| 项     | 值                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------- |
| 发行版 | WSL2，名称 `FleetAde`，WSL 版本 2.6.3.0。不是默认发行版                                           |
| 系统   | Ubuntu 24.04 LTS                                                                                  |
| 内核   | `6.6.87.2-microsoft-standard-WSL2`（`#1 SMP PREEMPT_DYNAMIC Thu Jun 5 18:30:46 UTC 2025 x86_64`） |
| Node   | v26.12.1                                                                                          |
| pnpm   | 12.14.0                                                                                           |
| 提交   | `9860318fa73705ca63e547ed72ee668828f8cf30`                                                        |

再进这次的树：`wsl -d FleetAde`，然后 `cd /src/fleet-ade`。发行版保留，不删除。

## 安装依赖

发行版内的命令：

```bash
pnpm install --frozen-lockfile --store-dir <事先装好的 store> --config.packageImportMethod=copy
```

store 不在发行版自己的文件系统上，所以用 `copy`。包是先在宿主上装进 store，发行版里只复用。

| 项   | 值                                                |
| ---- | ------------------------------------------------- |
| 开始 | 2026-11-14T01:20:09+08:00                         |
| 结束 | 2026-11-14T01:21:33+08:00                         |
| 用时 | 84 秒                                             |
| 结果 | resolved 1779，downloaded 0，added 1779，退出码 0 |
| 校验 | lockfile 通过 supply-chain policies               |

根上的 `prepare`（`vp config --no-agent`）跑完了。`esbuild` 0.28.2 和 `node-pty` 能加载。

`react-native-enriched-markdown` 的 postinstall 会从 GitHub 拉 tree-sitter 语法，不参与这批单测。发行版里跳过了这一支，没有改仓库。更早一次安装在这一步被终止（退出 143），包已经在 `node_modules` 里；上面这 84 秒是收尾的那一次。

## 命令

对齐 `.github/workflows/ci.yml`。环境是 `CI=true`，遥测关掉。web 按包脚本整包跑（`vp test run --passWithNoTests --project unit --project browser`），没有按 CI 拆成 2 片；拆片只为缩短墙上时间。server 按 CI 拆 8 片，并发 4，并带 `--uncached` 和 `--verify-hits 1`。

没跑：

- Rust `cargo test --locked`。这台发行版只装了 Node 26 和 pnpm 12。
- 移动端原生静态检查。CI 把这一项放在 macOS。
- release smoke。那不是单测。

跑之前的准备，不算进下面的失败：

- Electron 44.10.1 的 linux-x64 压缩包事先解进了包的 `dist`。`@electron/get` 当时连不上发布地址。随后 `ensure:electron` 退出码 0。
- Chromium headless shell 已在缓存里。`ldd` 缺 `libnspr4.so`、`libnss3.so`、`libnssutil3.so`、`libasound.so.2`。`install-deps` 退出码 0，用时 205 秒，然后才跑 web。
- 发布检查脚本调用 `jq`。发行版里一开始没有。脚本那次因此失败。装上 Ubuntu 的 `jq` 1.7 之后，同一条命令重跑通过。CI 的 Ubuntu 镜像自带 `jq`。

## 各组用时

整轮从 2026-11-14T01:34:14+08:00 到 2026-11-14T02:03:21+08:00。

| 组                | 命令                                                                                                                                                    | 退出码              | 用时                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------- |
| ensure-electron   | `vp run --filter @t3tools/desktop ensure:electron`                                                                                                      | 0                   | <1 秒                     |
| preview-python    | 预览打包脚本的测试（脚本后来已删除）                                                                                                                    | 0                   | <1 秒（6 通过，0.011 秒） |
| release-checks    | `node --test` 四个 `.github/scripts/*.test.cjs`                                                                                                         | 1，装上 jq 后重跑 0 | 162 毫秒；重跑 1.5 秒     |
| packages          | `vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' --filter '!@t3tools/web' test`                                    | 0                   | 322 秒                    |
| playwright-web    | `node apps/web/node_modules/playwright/cli.js install --only-shell chromium`                                                                            | 0                   | 2 秒                      |
| playwright-server | 装服务端用的无头浏览器（服务端后来已不依赖 playwright-core，这一步不再需要）                                                                            | 0                   | <1 秒                     |
| playwright-deps   | `node apps/web/node_modules/playwright/cli.js install-deps chromium`                                                                                    | 0                   | 205 秒                    |
| web               | `vp run --filter @t3tools/web test`                                                                                                                     | 1                   | 527 秒                    |
| server 1/8        | `vp run test:cached -- --shard 1/8 --concurrency 4 --uncached apps/server/integration/transferBudgetV2.integration.test.ts --verify-hits 1 apps/server` | 1                   | 60 秒                     |
| server 2/8        | 同上，分片 2/8                                                                                                                                          | 0                   | 110 秒                    |
| server 3/8        | 同上，分片 3/8                                                                                                                                          | 0                   | 111 秒                    |
| server 4/8        | 同上，分片 4/8                                                                                                                                          | 0                   | 105 秒                    |
| server 5/8        | 同上，分片 5/8                                                                                                                                          | 1                   | 50 秒                     |
| server 6/8        | 同上，分片 6/8                                                                                                                                          | 0                   | 91 秒                     |
| server 7/8        | 同上，分片 7/8                                                                                                                                          | 0                   | 93 秒                     |
| server 8/8        | 同上，分片 8/8                                                                                                                                          | 0                   | 71 秒                     |

server 是冷缓存，八片都是 `0% cache hit`。退出码 1 的两片各有下面的断言失败。

## 每个包

### packages（34/34 successful）

合计 13027 通过，0 失败，5 跳过（13032）。

日志是四路并行，汇总行没有包名。下面这些包的测试文件数和汇总里的文件数一一对应：

| 包                                   | 文件 | 通过 | 失败 | 跳过 |
| ------------------------------------ | ---- | ---- | ---- | ---- |
| apps/mobile                          | 302  | 3460 | 0    | 0    |
| packages/client-runtime              | 162  | 2005 | 0    | 0    |
| packages/shared                      | 102  | 1643 | 0    | 3    |
| scripts                              | 38   | 268  | 0    | 1    |
| packages/contracts                   | 32   | 173  | 0    | 0    |
| oxlint-plugin-t3code                 | 31   | 396  | 0    | 0    |
| packages/provider-core               | 23   | 264  | 0    | 0    |
| packages/source-control-github       | 21   | 402  | 0    | 0    |
| packages/provider-opencode           | 17   | 224  | 0    | 0    |
| packages/provider-cursor             | 15   | 139  | 0    | 0    |
| packages/provider-acp                | 8    | 106  | 0    | 0    |
| packages/ssh                         | 4    | 65   | 0    | 0    |
| packages/secret-provider-onepassword | 2    | 7    | 0    | 0    |

还有一组是 118 个文件通过、1 个文件跳过，用例 1128 通过、1 跳过。磁盘上最接近的是 `apps/desktop`（117 个测试文件），没有别的包落在这个数量级。

文件数撞车的包全部通过，失败数是 0。并行日志对不上每一行汇总：

| 包                                                                                   | 文件数 | 这几组的用例数（都是 0 失败） |
| ------------------------------------------------------------------------------------ | ------ | ----------------------------- |
| packages/provider-muse、infra/task-cache                                             | 各 11  | 107、41                       |
| packages/provider-pi                                                                 | 7      | 214                           |
| packages/provider-grok、packages/provider-acp-registry、packages/effect-acp、evals   | 各 6   | 76、76、1016、116             |
| packages/source-control-core、packages/provider-fx、packages/effect-codex-app-server | 各 5   | 20、55、59                    |
| packages/tailscale、packages/secret-provider-core、packages/provider-kiro            | 各 1   | 3、13、8                      |

### web（`@t3tools/web`）

文件 576 通过、8 失败（584）。用例 6321 通过、9 失败、0 跳过（6330）。

### server（`t3`，八片相加）

文件 485 通过、2 失败（487）。用例 7879 通过、3 失败、7 跳过（7889）。

| 分片 | 文件通过 | 文件失败 | 用例通过 | 用例失败 | 用例跳过 |
| ---- | -------- | -------- | -------- | -------- | -------- |
| 1/8  | 49       | 1        | 895      | 1        | 1        |
| 2/8  | 62       | 0        | 623      | 0        | 0        |
| 3/8  | 62       | 0        | 1075     | 0        | 1        |
| 4/8  | 62       | 0        | 1002     | 0        | 0        |
| 5/8  | 58       | 1        | 1064     | 2        | 0        |
| 6/8  | 64       | 0        | 1258     | 0        | 0        |
| 7/8  | 64       | 0        | 961      | 0        | 1        |
| 8/8  | 64       | 0        | 1001     | 0        | 4        |

### 另外两组

- preview-python：6 通过。
- release-checks：装上 jq 之后 54 通过、0 失败。脚本里那一次是 51 通过、3 失败。

## 失败名单

### 需要真浏览器或真智能体，跳过

没有。web 的浏览器用例跑在已经装好的 Chromium headless shell 上。下面的失败是跑完之后断言或超时，不是因为没装浏览器而跳过。server 和 packages 里的 skip 是测试自己标的，日志没有写「需要真浏览器或真智能体」。

### 真失败

web，都在 browser（chromium）：

- `ChatMarkdown.browser.test.tsx` highlights a code block's own source when an earlier block of the same length was cached：高亮结果是 `undefined`，期望是那段源码字符串。
- `DiffPanel.browser.test.tsx` expands an unloaded file on the first click with default collapse false：点 Expand 超时。
- `AttachmentFilePreview.browser.test.tsx` toggles a Mermaid attachment between diagram and source through the lazy preview：点 Show rendered diagram 超时。
- `AttachmentFilePreview.office.browser.test.tsx` keeps spreadsheet dates on their calendar day west of UTC：整例超过 15 秒。
- `useInlineActionConfirm.browser.test.tsx` keeps a blocked merge action reachable without arming or performing it：整例超过 15 秒。
- `CloudVoiceConfiguration.browser.test.tsx` cancelling a provider's setup keeps the current destination and writes nothing：点 Cancel 超时。
- `CloudVoiceConfiguration.browser.test.tsx` enables the chosen provider only after a successful setup：点 API key 输入框超时。
- `StorageSettings.browser.test.tsx` keeps a newer pending age open when an older first save fails：填写天数输入框超时。
- `sheet-resize.browser.test.ts` requests current dimensions after resizing and scrolling away and back before a frame arrives：页面停在 Loading file，找不到名为 Sample 的 grid。

server：

- `src/provider/AntigravityInstallation.test.ts` explains that the linux-arm64 runtime needs 4 KiB pages when it aborts on a 16 KiB kernel：安装状态是 `cancelled`，期望是 `failed`。
- `src/cli/theme.test.ts` restores the previous theme when a re-publish fails to set：抛出 `Unknown error: undefined`。
- `src/cli/theme.test.ts` refuses to write when the settings file cannot be read：抛出 `Unknown error: undefined`。

### 环境缺件，补上后通过

`vercel-deployment-output.test.cjs` 里三条（plain URL、lockfile warning、trailing diagnostic）：脚本报 `jq: command not found`，退出码 127。装上 `jq` 1.7 后这三条和其余发布检查一起通过。
