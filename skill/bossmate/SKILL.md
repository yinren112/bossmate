---
name: bossmate
description: Run a local, evidence-based BOSS job-search workflow through a user-owned, logged-in Edge or Chrome browser using bare Chrome DevTools Protocol. Use when an AI agent needs to help a user configure job preferences from a resume, set up and log in to a dedicated BOSS browser, search and read complete job descriptions, assess fit/pay/remote/risk evidence, prevent duplicate recruiter outreach, draft truthful first messages, send, and verify delivery. Also use when continuing or auditing an existing BossMate workspace.
---

# BossMate

Operate as the user's job-search agent. Use the bundled scripts as the deterministic browser, ledger, deduplication, send-gate, and delivery-verification layer. Keep judgment and writing in the current host agent; never invoke a different AI product behind the user's back.

## Locate the private workspace

Use `BOSS_JOB_HOME` when set. Otherwise use:

- Windows: `%USERPROFILE%\.bossmate`
- macOS/Linux: `$HOME/.bossmate`

Never store resumes, browser profiles, chats, or the live ledger inside this Skill folder.

## Route the task

1. If `profile.md` or `preferences.json` is missing, read [references/onboarding.md](references/onboarding.md) and complete onboarding.
2. If the dedicated browser is missing or logged out, read [references/browser.md](references/browser.md).
3. For job-search execution, read [references/workflow.md](references/workflow.md).
4. Before any online or send action, apply [references/safety.md](references/safety.md).

## Non-negotiable rules

- Require the user to log in personally. Never request or handle passwords, SMS codes, cookies, or session tokens.
- Use only the bundled `scripts/cdp.js` browser path. Do not replace it with Playwright, browser extensions, internal APIs, or direct site requests.
- Run one online action at a time. Never parallelize accounts, searches, JD reads, or sends.
- Require a complete JD before final judgment.
- Store exact evidence for fit requirements, compensation, work location/remote status, and risk.
- Treat recruiter identity and prior conversations as hard deduplication gates.
- Use only facts the user confirmed in `profile.md`.
- Never reset or bypass an outreach state. The runtime intentionally has no force-send option.
- Count a send only when the exact message is bound to the user's message row and that row shows delivered/read.
- Stop immediately and write persistent circuit breaker lock (`lock.json`) on security verification pages, 403, passport exception pages, account anomalies, code 32/36/37, consecutive blank JDs (≥3 times), uncertain recipient identity, or uncertain delivery. All online commands refuse to run while `lock.json` exists until manually unlocked via `unlock --reason=<explanation>`.

## Agent responsibilities

The current agent must:

- interview the user and update private configuration;
- interpret complete JD evidence;
- run `review` with explicit evidence;
- fetch context using `opener-context`, compose a customized and truthful opener based on the JD and confirmed profile facts, and save it via `save-opener`;
- proceed to `send` once the opener is saved and all deterministic safety gates pass;
- re-verify delivery using `verify-delivery` if outreach state is `delivery_unverified`;
- report progress from the ledger, not from memory.

The scripts must:

- control the dedicated browser through bare CDP;
- persist the ledger atomically;
- enforce the persistent circuit breaker lock (`lock.json`);
- detect prior recruiter contact and auto-skip closed jobs;
- verify the live job, recruiter, JD hash, message row, and delivery state;
- refuse ambiguous or unsafe actions.

## Completion

Finish only after:

1. `node scripts/boss.js validate` passes;
2. `node scripts/boss.js check` reports a logged-in BOSS page and no security page;
3. all `delivery_unverified` states have been re-verified using `verify-delivery` (or reported as unverified);
4. the ledger contains the evidence and outcome for every processed job;
5. the final report separates delivered, skipped, rejected, pending, and blocked items.

If no job passes, report zero. Never weaken the user's rules to create volume.
