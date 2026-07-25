# Rate limiting: why these numbers and this shape

Background reading. The operational rules live in [safety.md](safety.md) — read this file only
when changing a limit, adding a new online action, or deciding whether some pacing behavior is a
bug or intentional.

## What the platform actually measures

Anti-abuse detection does not evaluate single requests in isolation. It looks at volume, density,
and rhythm over time.

Reports from real accounts consistently place the risk threshold for job-detail-page reads
somewhere around 1,000 per day, and outreach sends somewhere around 150 per day. An account well
under those numbers with no prior restriction history tends to run without incident. An account
that reaches those levels tends to get restricted — and the threshold appears to drop for a repeat
account, or for one that already produced a warning signal earlier the same day.

Detection is also retrospective rather than real-time. A session can finish cleanly with no errors
and the restriction can still land hours later the same evening. **"Nothing errored yet" is not
evidence of safety**, which is why the limits here are preventive rather than reactive.

## Two design mistakes that defeat rate limiting

Both of these look conservative on paper and fail in practice. Both were real bugs in earlier
versions of this runtime.

### 1. Resetting the counter at midnight instead of using a rolling window

A calendar-day counter lets an account spend a full day's quota at 23:00 and another full day's
quota at 00:10 — 1,800 actions inside twenty minutes, with each half technically "under the daily
limit." The platform sees one continuous burst; the counter sees two well-behaved days.

All limits here are therefore evaluated over a **rolling 24-hour window**. This matters most
exactly when it is most tempting to ignore: late-night sessions, which is when the highest-risk
runs tend to happen anyway.

### 2. Fixed-interval waits

A script that always waits exactly 3.5 seconds between actions is trivially distinguishable from a
human regardless of how safe that interval looks. Serial execution is not the same as human-like
execution — evenly spaced serial requests are arguably a *stronger* automation signal than
concurrent ones, because nothing organic produces that little variance.

Every wait in this runtime is drawn from a randomized range. Never replace one with a constant.

## Why counters derive from the ledger

The rate counters are computed from timestamps the ledger already stores (`jd.checkedAt` /
`jd.liveCheckedAt`, `outreach.sentAt`, `runs[].at`) rather than from a dedicated counter file.

Two failure modes motivate this:

- **A separate counter file drifts.** It can disagree with what the ledger says actually happened
  — after a crash, a partial write, or a manual edit — and then the gate is enforcing fiction.
- **An in-memory counter is worse than none.** Every command here runs as its own process, so a
  module-level variable resets on every invocation. A "3 consecutive blank JDs" breaker
  implemented that way never fires even once, while still reading like a working safeguard. That
  exact bug shipped and survived review; the consecutive-empty-JD count is now persisted in
  `ledger.safety`.

Anything that must survive a restart, a context compaction, or a switch to a different script
belongs in a file, not in a variable and not in conversation history.

## Why sends also charge the read quota

`send` loads the job detail page during preflight. The platform counts that page view in the same
bucket as any other detail-page read, so charging only the `sends` counter would make the read
ceiling under-count and let real traffic exceed the fuse it was supposed to enforce.

## Why the severe-lock cooldown blocks same-day unlocking

In the incidents behind this design, the request that tripped the platform's signal was not what
caused the account-level restriction. What caused it was continuing to browse a few more times
*after* the signal appeared — turning a throttled endpoint into a restricted account.

So a lock whose reason indicates the platform's own anti-abuse system fired (code 32/36/37,
access-restricted, account anomaly) refuses to unlock until 24 hours have passed *and* the
calendar day has changed. Ordinary hard stops — a stray security page that `check` happened to
notice — are not subject to this, because they carry no evidence that the platform judged the
account.

## Why night pacing throttles instead of blocking

Refusing to run between 23:00 and 09:00 would be the safer-looking rule, and it was the original
proposal. It was rejected for a practical reason: it fights users who genuinely work at night,
and a safety mechanism that blocks someone's actual working hours gets disabled.

Halving the rate keeps the mechanism in place instead of getting it turned off. The 24-hour totals
stay unchanged; only the spacing and burst allowance tighten.
