# SWE-2 值班

两份值班都只读仓、不改代码、不合并、不改规矩。模型走 magpie 网关的 OpenAI 接口，地址、模型名、密钥都在环境变量里，代码不写密钥。

## 命令

在仓根：

```bash
node .github/scripts/duty.cjs triage --dry-run
node .github/scripts/duty.cjs retro --dry-run
```

去掉 `--dry-run` 才会写：分拣贴标签和评论，复盘改 `LESSONS.md`，满 3 天的条目在 fleet-ade 开一张「升规矩」单。

| 变量              | 缺省                       | 作用                                    |
| ----------------- | -------------------------- | --------------------------------------- |
| `MAGPIE_BASE_URL` | `http://127.0.0.1:3425/v1` | 网关。法国用 `http://192.0.2.2:3425/v1` |
| `MAGPIE_MODEL`    | `group/swe-pool`           | SWE-2                                   |
| `MAGPIE_API_KEY`  | 无                         | 干跑不要；真写必须有，只放环境          |
| `DUTY_LIMIT`      | `10`                       | 每次最多处理几条                        |
| `DUTY_DAY`        | 今天 UTC                   | 复盘看哪一天，`YYYY-MM-DD`              |

## 分拣

读 fleet-ade 和 other-repo 已开的单。已贴 `值班:已分拣` 的跳过。每次只处理最新的 `DUTY_LIMIT` 条。

判有效后贴一个类别（`缺陷` / `需求` / `杂项`）、一个域（`域:engine` / `域:api` / `域:mirasim`）、一个性质（`性质:bug` / `性质:perf` / `性质:process`）。这套名字和说明从 other-repo 的现有标签拷过来；fleet-ade 上没有就建。

疑似重复只评论 `疑似重复 #N`，不关单。长 CI 失败日志只评论一句根因。同一种评论已在就不再写。

## 夜间复盘

读当天已合并、提交里带 revert 的、CI 红的 PR，让 SWE-2 指出返工、验证太糙（该跑的检查没写 Not run）、同类漏修。只关没合的 PR 不算回滚。写进 `LESSONS.md`，每条带 `Seen N×` 和日期。同一条在 3 个不同日子出现，在 fleet-ade 开一张「升规矩」单，不改规矩。

## 法国 cron

本仓不安装 cron，也不动 `fleet-ade.service` 和旧引擎。在法国以专用用户跑时，先确认：

- `gh` 已能读写 `thoerwink8/fleet-ade` 和 `thoerwink8/other-repo`。现有 GitHub App 只覆盖 fleet-ade，且令牌没有 issues 写权限；要读 other-repo、贴标签、评论、开「升规矩」单，先另配一份能写两个仓 issues 的凭据。
- `MAGPIE_API_KEY` 放在只有该用户能读的文件里，不进仓。
- 仓检出在固定目录，例如 `/var/lib/fleet-ade/repos/fleet-ade`，且已在 `main`。

`crontab -e`：

```cron
0 * * * * . /etc/fleet-ade/duty.env && cd /var/lib/fleet-ade/repos/fleet-ade && /usr/bin/git pull --ff-only origin main && /home/ade/.local/node/bin/node .github/scripts/duty.cjs triage >> /var/lib/fleet-ade/home/duty.log 2>&1
30 23 * * * . /etc/fleet-ade/duty.env && cd /var/lib/fleet-ade/repos/fleet-ade && /usr/bin/git pull --ff-only origin main && /home/ade/.local/node/bin/node .github/scripts/duty.cjs retro >> /var/lib/fleet-ade/home/duty.log 2>&1
```

`/etc/fleet-ade/duty.env` 只放变量，权限 `root:ade 0640`：

```bash
export MAGPIE_BASE_URL=http://192.0.2.2:3425/v1
export MAGPIE_MODEL=group/swe-pool
export MAGPIE_API_KEY=
export DUTY_LIMIT=10
export GH_TOKEN=
```

密钥那两行留空，由有权限的人在机器上填。不要把真值写进仓或 PR。
