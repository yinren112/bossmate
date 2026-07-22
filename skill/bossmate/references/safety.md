# Safety and privacy

## Hard stops and circuit breaker lock

Stop all online actions for the affected account immediately when any of these conditions occur:

- HTTP 403, passport exception page, CAPTCHA, security verification, or account anomaly;
- API error code 32, 36, or 37;
- consecutive blank or partial JD content (≥3 times);
- daily job detail page read limit reached (max 950 reads per calendar day);
- job, company, recruiter, or recipient mismatch;
- uncertain message delivery;
- unexpected browser navigation or lost login.

Do not retry through a different browser surface, account, internal API, or automation framework.

### Persistent Circuit Breaker Lock (`lock.json`)

When a hard stop condition (such as security verification, 403, passport exception, code 32/36/37, or 3 consecutive blank JDs) is detected, the runtime automatically writes a persistent circuit breaker lock file (`data/lock.json`).

While `lock.json` exists:
- All online commands (`check`, `replies`, `interactions`, `search`, `candidates`, `read`, `send`, `verify-delivery`, `company-jobs`, etc.) will immediately refuse to run.
- Switching scripts, restarting the process, or clearing chat context will NOT bypass the lock.

### Manual Unlock (`unlock`)

The circuit breaker lock can ONLY be removed through explicit human manual intervention after addressing the safety condition in the browser:

```powershell
node scripts/boss.js unlock --reason="<explanation of resolution and manual verification>"
```

After unlocking, perform a single human-supervised minimal check (`node scripts/boss.js check` and `read` one job) before resuming automated runs.

## Send gates

Require all of the following:

1. complete structured JD (automatically skipping closed positions);
2. configured requirements reviewed with evidence (`review`);
3. no prior conversation with the recruiter (`encryptBossId` deduplication);
4. current page still matches the reviewed job and JD hash;
5. opener saved via `save-opener` using only confirmed facts;
6. exact recipient identity;
7. exact message row bound and verified as delivered/read (15-iteration delivery verification polling).

The runtime has no force-send option. Do not add one.

## Privacy

Keep these out of the Skill and source control:

- resume and identity details;
- `profile.md` and `preferences.json`;
- live ledger and reports;
- browser profile, cookies, session files, and screenshots;
- recruiter chats and contact information.

Never send private data to another model or service unless the user explicitly asks and understands the destination.

## Public communication

Describe the project as local browser assistance with evidence and safety gates. Do not claim that it defeats detection, hides automation, bypasses security, or guarantees account safety.
