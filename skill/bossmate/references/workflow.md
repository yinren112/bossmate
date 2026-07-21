# Workflow

Run commands from the Skill root. Use `BOSSMATE_HOME` if the private workspace is not the default.

## Start every run

```powershell
node scripts/boss.js self-test
node scripts/boss.js validate
node scripts/boss.js check
node scripts/boss.js replies
node scripts/boss.js interactions
node scripts/boss.js list
```

`replies` is read-only. Do not open or answer pending conversations unless the user separately requests reply help.

If `check` returns a circuit breaker lock status (`lock.json` present), do not run online commands until resolved. See [Circuit breaker unlocking](#circuit-breaker-unlocking-unlock).

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

```powershell
node scripts/boss.js read <job-id> --source=search:<keyword>
node scripts/boss.js review <job-id> `
  --remote=pass --remote-evidence="<exact JD evidence>" `
  --pay=pass --pay-evidence="<calculation and evidence>" `
  --risk=pass --risk-evidence="<risk conclusion>" `
  --next="draft opener"
```

Use `pass`, `fail`, or `pending`. Do not guess missing pay, hours, location, or remote terms. `read` uses 12-second rendering polling to load full JD content.

## Draft

The host Agent is responsible for understanding the JD and crafting the customized opener message.

1. Fetch structured context (profile facts, job details, and validation rules):

```powershell
node scripts/boss.js opener-context <job-id>
```

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

When a hard stop condition (such as security verification, 403, passport error page, code 32/36/37, or ≥3 consecutive blank JDs) occurs, `data/lock.json` is automatically created and all online commands refuse to run.

To unlock after a human has manually resolved the issue in the browser:

```powershell
node scripts/boss.js unlock --reason="<explanation of manual resolution and verification>"
```

Always run `node scripts/boss.js check` after unlocking to verify that the browser session is healthy before continuing work.

## Batch checkpoint

After a small batch:

```powershell
node scripts/boss.js validate
node scripts/boss.js check
node scripts/boss.js list
```

Continue execution automatically unless a hard stop occurs.
