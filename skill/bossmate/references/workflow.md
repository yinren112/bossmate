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
node scripts/boss.js self-test     # after changing the runtime
node scripts/boss.js validate      # after a batch, or when the ledger looks wrong
node scripts/boss.js replies       # when handling replies this session
node scripts/boss.js interactions  # when sourcing from "who viewed me"
node scripts/boss.js rate-status   # full limit detail; preflight already summarizes it
```

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

```powershell
node scripts/boss.js search "<keyword>" --profile=<profile-id> --page=1
node scripts/boss.js candidates --profile=<profile-id> --limit=20
```

Recruiter activity affects order only. Never reject only because a recruiter is inactive. Closed positions (`job_closed`) will be automatically detected and skipped during reading.

## Read and review

`--jd` returns the JD text plus every field needed to review it, in one call — use it instead of
reading and then fetching the body separately:

```powershell
node scripts/boss.js read <job-id> --jd --source=search:<keyword>
node scripts/boss.js review <job-id> `
  --remote=pass --remote-evidence="<exact JD evidence>" `
  --pay=pass --pay-evidence="<calculation and evidence>" `
  --risk=pass --risk-evidence="<risk conclusion>" `
  --next="draft opener"
```

Use `pass`, `fail`, or `pending`. Do not guess missing pay, hours, location, or remote terms. `read` uses 12-second rendering polling to load full JD content.

To re-read a JD already in the ledger — for example after a context compaction — use the offline
`jd` command instead of re-reading the page (no network, no rate-limit charge, works while locked):

```powershell
node scripts/boss.js jd <job-id>
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

If delivery confirmation is detected on the chat message row, the ledger updates the outreach status to `DELIVERED`.

## Circuit breaker unlocking (`unlock`)

When a hard stop condition (such as security verification, 403, passport error page, code 32/36/37, ≥3 consecutive blank JDs, or a rolling rate-limit hard ceiling — see [references/safety.md](references/safety.md)) occurs, `data/lock.json` is automatically created and all online commands refuse to run.

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
