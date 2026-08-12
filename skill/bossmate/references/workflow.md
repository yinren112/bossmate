# Workflow

Run commands from the Skill root. Use `BOSSMATE_HOME` if the private workspace is not the default.

## Start every run

One command reports everything needed to decide what to do this session — lock state, browser
health, rate-limit headroom, night pacing, queue sizes, and pending conversations:

```powershell
node scripts/boss.js preflight
```

It exits non-zero if the account is locked or the browser is not logged in. In that case resolve
that first — see [Circuit breaker unlocking](#circuit-breaker-unlocking-unlock) — and do not run
online commands.

Run these only when you actually need them, not as routine warm-up:

```powershell
node scripts/boss.js doctor        # after changing or upgrading the runtime; fully offline
node scripts/boss.js daily-options # 查看或记录当天简历策略；不连接 BOSS
node scripts/boss.js next-work     # 上下文切换后返回一项最值得继续的工作
node scripts/boss.js job-workbench <job-id> # 单岗状态和精确下一条命令
node scripts/boss.js review-audit  # 离线检查审核证据与开场白一致性
node scripts/boss.js self-test     # focused deterministic runtime checks
node scripts/boss.js validate      # after a batch, or when the ledger looks wrong
node scripts/boss.js replies       # when handling replies this session
node scripts/boss.js interactions  # when sourcing from "who viewed me"
node scripts/boss.js rate-status   # full limit detail; preflight already summarizes it
```

`doctor` 会检查 Node 版本、随包模块、私有工作区、台账结构和确定性自测；整个过程不连接 BOSS，也不消耗在线额度。

每天可先运行 `daily-options`。如果 `needsChoice=true`，询问用户今天选择 `off`、`explicit` 或 `positive`，并用 `daily-options --resume=<mode>` 记录。这个选择不影响找岗、审岗或首次开场白；当前公开版尚未实现附件自动发送，只记录策略和多简历配置，不能声称已自动发出简历。

`replies` is read-only. Do not open or answer pending conversations unless the user separately requests reply help.

Occasional `[节流] ...` lines during `search`/`read`/`send` are the runtime pausing to respect the
minimum gap between actions — expected, not an error.

## Keep the context small

The ledger holds roughly 5 KB per job. **Never read `data/ledger.json` directly** — it will
swamp the context well before it is useful. Every field is reachable through a command.

Per job: get the JD once with `read --jd`, judge it, record the verdict, move on. Do not carry
finished JDs forward. Load `profile.md` once per session and use `opener-context --brief`
thereafter. Work in batches of ~15–20 jobs. See [Context hygiene](safety.md#context-hygiene).

## Discover

Prioritize:

1. recruiters who viewed or showed interest;
2. previously confirmed friendly companies;
3. BOSS recommendations and related jobs;
4. one keyword and one result page at a time.

收藏和推荐职位都使用可续跑入口，一条命令只推进一页或一批：

```powershell
node scripts/boss.js favorites --page=1
node scripts/boss.js favorites-next
node scripts/boss.js recommendations
node scripts/boss.js recommendations-next
node scripts/boss.js recommendations-close
node scripts/boss.js job-sources
```

收藏扫描期间保留上一次完整的 `favorite:current` 快照，只有最后一页完成后才整体替换；中途停止不会把“只扫了前几页”误记成完整收藏。推荐职位使用专用标签和本地断点，到底后会关闭标签并清理断点。

```powershell
node scripts/boss.js search "<keyword>" --profile=<profile-id> --page=1
node scripts/boss.js search-next
node scripts/boss.js search-close
node scripts/boss.js candidates --profile=<profile-id> --limit=20
```

BOSS 搜索页是单页应用，不能靠修改 `?page=` 真正翻页。`search` 会保留专用标签和本地断点，后续只用 `search-next` 点击分页或滚动加载；岗位集合不再变化时会自动关闭标签并清理断点。

Recruiter activity affects order only. Never reject only because a recruiter is inactive. Closed positions (`job_closed`) will be automatically detected and skipped during reading.
Deleted or expired detail links that return to the BOSS home/job-list page are recorded as expired
jobs, not account-security incidents.

## Read and review

`--jd` returns the JD text plus every field needed to review it, in one call — use it instead of
reading and then fetching the body separately:

```powershell
node scripts/boss.js read <job-id> --jd --source=search:<keyword>
node scripts/boss.js review <job-id> `
  --fit=pass --fit-evidence="<target-role and capability evidence>" `
  --location=pass --location-evidence="<work location / work-mode evidence>" `
  --pay=pass --pay-evidence="<calculation and evidence>" `
  --risk=pass --risk-evidence="<risk conclusion>" `
  --next="draft opener"
```

Use `pass`, `fail`, or `pending`. `fit` must confirm the work is actually in one of the user's
configured target directions. `location` means the job's city and office/remote arrangement match
the user's settings: it can pass for remote, hybrid, or on-site work. Do not guess missing pay,
hours, location, or remote terms. `read` uses 12-second rendering polling to load full JD content.
Treat terms such as "remote diagnostics", "remote control", or "remote operations" as product or
technical functions, not proof of remote work. Require separate workplace evidence in the JD.

For compatibility with older workspaces, `--remote` and `--remote-evidence` still write the new
`location` review field. New commands should use `--location`.

To re-read a JD already in the ledger — for example after a context compaction — use the offline
`jd` command instead of re-reading the page (no network, no rate-limit charge, works while locked):

```powershell
node scripts/boss.js jd <job-id>
```

After upgrading an existing workspace to this release, run the offline hash migration once. It
normalizes unordered benefit tags without weakening the live-JD change gate:

```powershell
node scripts/boss.js rehash-jd
```

For a large local queue, filter without opening the ledger:

```powershell
node scripts/boss.js list --queue=review --has-remote --limit=30
node scripts/boss.js list --grep="<title-or-company>" --source="<source>"
```

## Draft

The host Agent is responsible for understanding the JD and crafting the customized opener message.

1. Fetch structured context (profile facts, job details, and validation rules):

```powershell
node scripts/boss.js opener-context <job-id>          # first job of the session
node scripts/boss.js opener-context <job-id> --brief  # every job after that
```

`--brief` omits the fact profile and the JD body — the profile has not changed since the first
call, and you read the JD moments ago via `read --jd`. Those two fields are the bulk of the
payload, so use `--brief` for every job after the first. It requires that `profile.md` was loaded
earlier in the session; if it was not, call it without `--brief` once.

2. Compose a concise message based on the context:
- Select confirmed facts from `profile.md` relevant to the target JD;
- Include a specific question or value statement tailored to the position;
- Ensure no links or prohibited claims (`bannedClaims`);
- Keep within configured character length limits (`preferences.json`).

3. Validate and save the opener to the ledger:

```powershell
$env:MSG="<message>"
node scripts/boss.js save-opener <job-id>
Remove-Item Env:MSG
```

`save-opener` validates character limits and link policy before saving.

## Send

Once the opener is saved and review passed, execute the send command directly:

```powershell
node scripts/boss.js send <job-id>
```

`send` navigates to the chat page, submits the saved opener (automatically dismissing any "Improve Resume" or "Privacy Protection" pop-ups), and performs up to 15 iterations of delivery verification polling.

Only `DELIVERED` status counts as a successful delivery. `skipped_communicated`, `job_closed`, `blocked`, `delivery_unverified`, or error states do not count.

## Verify delivery (`verify-delivery`)

For positions left in the `delivery_unverified` state (e.g. pop-up delayed state confirmation during sending), re-enter the chat page to verify delivery:

```powershell
node scripts/boss.js verify-delivery <job-id>
```

The verifier opens the exact job conversation and binds the full message to the recruiter's stable
ID. Repeated opener text in other conversations does not cause a false failure.

## Circuit breaker unlocking (`unlock`)

When a hard stop condition (such as security verification, 403, passport error page, code 32/36/37, ≥3 consecutive blank JDs, or a rolling rate-limit hard ceiling — see [references/safety.md](references/safety.md)) occurs, `data/lock.<port>.json` is automatically created and all online commands for that account refuse to run.

To unlock after a human has manually resolved the issue in the browser:

```powershell
node scripts/boss.js unlock --reason="<explanation of manual resolution and verification>"
```

If the lock reason is a platform-level signal (code 32/36/37, access-restricted, account anomaly), `unlock` refuses until 24 hours have passed and the calendar day has changed — this is intentional, not a bug. Overriding it early requires `--override-severe-lock` and is a deliberate human call, not something to reach for by default.

Always run `node scripts/boss.js check` after unlocking to verify that the browser session is healthy before continuing work.

## Batch checkpoint

After a small batch:

```powershell
node scripts/boss.js validate
node scripts/boss.js preflight
```

Continue execution automatically unless a hard stop occurs.
