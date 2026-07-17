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

Recruiter activity affects order only. Never reject only because a recruiter is inactive.

## Read and review

```powershell
node scripts/boss.js read <job-id> --source=search:<keyword>
node scripts/boss.js review <job-id> `
  --remote=pass --remote-evidence="<exact JD evidence>" `
  --pay=pass --pay-evidence="<calculation and evidence>" `
  --risk=pass --risk-evidence="<risk conclusion>" `
  --next="draft opener"
```

Use `pass`, `fail`, or `pending`. Do not guess missing pay, hours, location, or remote terms.

## Draft

Get the complete context:

```powershell
node scripts/boss.js opener-context <job-id>
```

Write one short message using:

- one confirmed fact most relevant to the JD;
- one specific question;
- no links or unsupported claims.

Save it:

```powershell
$env:MSG="<message>"
node scripts/boss.js save-opener <job-id>
Remove-Item Env:MSG
```

## Approve and send

In `review` mode, record approval only after the user explicitly approves:

```powershell
node scripts/boss.js approve <job-id>
```

In `autopilot` mode, do not run `approve`.

Send:

```powershell
node scripts/boss.js send <job-id>
```

Only `DELIVERED` counts. `skipped_communicated`, `blocked`, `delivery_unverified`, or an error does not count.

## Batch checkpoint

After a small batch:

```powershell
node scripts/boss.js validate
node scripts/boss.js check
node scripts/boss.js list
```

Continue automatically in autopilot mode unless a hard stop occurs.
