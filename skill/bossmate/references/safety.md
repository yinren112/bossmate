# Safety and privacy

## Rolling rate limits

All limits are evaluated over a **rolling 24-hour window**, not a calendar day. Every online
action is reserved before the browser request in `data/budget.<port>.json`, so failed requests are
counted too.

| Gate | Search pages | Job-detail reads | Sends |
|---|---|---|---|
| 24h soft limit (normal stopping point) | 30 | 300 | 30 |
| 24h hard ceiling (auto-triggers the circuit breaker) | 120 | 900 | 150 |
| 10-minute burst limit | 6 | 40 | 6 |
| Minimum gap between actions | 15s | 8s | 25s |

Behavior when a gate is hit:

- **24h soft limit or 10-minute burst limit** → run stops with an error. Wait for the window to slide.
- **24h hard ceiling** → run stops *and* writes the circuit breaker lock. At that volume the traffic itself is the anomaly.
- **Minimum gap not met** → not an error. The runtime waits out the remainder with jitter and continues. `[节流] ...` lines are this, working as intended.

Treat the hard ceiling as a fuse, not a target. Day-to-day operation should sit well under the
soft limit; raise a soft limit only after several clean days on an account with no restriction
history. `send` also charges the read quota, because its preflight loads a job detail page.

Between **23:00 and 09:00** local time the minimum gap doubles and the burst limit is halved. The
24-hour totals are unchanged — late-night traffic is spread out, not blocked.

Never replace a randomized wait with a fixed one. For the reasoning behind any of the above —
including why a calendar-day counter and fixed intervals both fail — see
[rate-limit-rationale.md](rate-limit-rationale.md).

## Context hygiene

The ledger grows to roughly 5 KB per job, so a few hundred jobs is already large enough to
overwhelm an agent's context in a single read.

- **Never read `data/ledger.json` directly.** Every field an agent needs is available through a command: `read --jd` / `jd` for review input, `preflight` for run state, `list` and `candidates` for queues, `rate-status` for limits.
- Get the JD once per job via `read <id> --jd`, judge it, record the verdict with `review`, then let it go. Once the evidence is in the ledger the JD text has no further use — do not carry a backlog of full JDs forward.
- Use `opener-context --brief` after the first job in a session: it omits the JD you just read and the fact profile that has not changed, which is most of the payload.
- Load `profile.md` once per session, not per job.
- Process one job to completion before starting the next, and work in batches of roughly 15–20 jobs per session. Safety state (lock, rate counters, ledger) is all on disk and survives compaction, but the reasoning behind skip/reject decisions does not — a fresh session beats a compacted one.

## Hard stops and circuit breaker lock

Stop all online actions for the affected account immediately when any of these conditions occur:

- HTTP 403, passport exception page, CAPTCHA, security verification, or account anomaly;
- API error code 32, 36, or 37;
- consecutive blank or partial JD content (≥3 times);
- a rolling rate-limit hard ceiling above is reached;
- job, company, recruiter, or recipient mismatch;
- uncertain message delivery;
- unexpected browser navigation or lost login.

Do not retry through a different browser surface, account, internal API, or automation framework.

### Persistent Circuit Breaker Lock (`lock.<port>.json`)

When a hard stop condition (such as security verification, 403, passport exception, code 32/36/37,
3 consecutive blank JDs, or a rate-limit hard ceiling) is detected, the runtime automatically
writes a persistent per-account circuit breaker lock file (`data/lock.<port>.json`).

While the account's `lock.<port>.json` is locked:
- All online commands (`check`, `replies`, `interactions`, `search`, `candidates`, `read`, `send`, `verify-delivery`, `company-jobs`, etc.) will immediately refuse to run.
- Switching scripts, restarting the process, or clearing chat context will NOT bypass the lock.

### Manual Unlock (`unlock`)

The circuit breaker lock can ONLY be removed through explicit human manual intervention after addressing the safety condition in the browser:

```powershell
node scripts/boss.js unlock --reason="<explanation of resolution and manual verification>"
```

**Platform-level signals do not unlock the same day.** If the lock reason indicates the platform's
own anti-abuse system fired — code 32/36/37, "access restricted," "account anomaly detected" —
`unlock` refuses until 24 hours have passed *and* the calendar day has changed, and reports the
earliest time it will allow it. This exists because the common failure pattern in real incidents
is not the request that trips the signal — it's continuing to browse a few more times right after
the signal appears, which is what turns a throttled endpoint into a full account restriction.
Ordinary hard stops (e.g. a stray security page `check` happened to notice) are not subject to
this and can be unlocked any time. Overriding the cooldown before it expires requires an explicit
`--override-severe-lock` flag and is the operator's own call to make, not the runtime's default:

```powershell
node scripts/boss.js unlock --reason="<explanation>" --override-severe-lock
```

After unlocking, perform a single human-supervised minimal check (`node scripts/boss.js check` and `read` one job) before resuming automated runs.

## Send gates

Require all of the following:

1. complete structured JD (automatically skipping closed positions);
2. target-role fit, location/work-mode, pay, and risk reviewed with evidence (`review`);
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
