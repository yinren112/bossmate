# Rate limiting: why these numbers and this shape

Background reading. The operational rules live in [safety.md](safety.md) — read this file only
when changing a limit, adding a new online action, or deciding whether some pacing behavior is a
bug or intentional.

## What the platform actually measures

Anti-abuse detection does not evaluate single requests in isolation. It looks at volume, density,
and rhythm over time.

Job-detail-page reads in the low thousands per day, and outreach sends in the low hundreds per
day, are commonly associated with restrictions on this kind of site. Staying well under those
levels with no prior restriction history is the safer pattern. The threshold that triggers a
restriction also appears to drop for a repeat account, or for one that already produced a warning
signal earlier the same day — so the limits here are meant to keep normal usage comfortably clear
of that range rather than to hug it.

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

## Why actions are reserved before the request

Rate events are persisted in `data/budget.<port>.json` before the browser request starts. A failed
load, blank JD, security redirect, or interrupted send still reached the platform and must count.
Deriving counters only from successful ledger writes silently under-counts exactly the failures
most likely to precede an account restriction.

On first upgrade, BossMate seeds the budget from existing ledger timestamps. After that, the
budget is authoritative. It is separated by CDP port so two configured accounts cannot consume or
clear each other's limits. An in-memory counter is never used because every command runs as a new
process.

Anything that must survive a restart, a context compaction, or a switch to a different script
belongs in a file, not in a variable and not in conversation history.

## Why sends also charge the read quota

`send` loads the job detail page during preflight. The platform counts that page view in the same
bucket as any other detail-page read, so charging only the `sends` counter would make the read
ceiling under-count and let real traffic exceed the fuse it was supposed to enforce.

## Why the severe-lock cooldown blocks same-day unlocking

The design principle here: the single request that trips the platform's signal is generally not
what causes an account-level restriction by itself. What tends to cause it is continuing to
browse a few more times *after* the signal appears — turning a throttled endpoint into a
restricted account.

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
