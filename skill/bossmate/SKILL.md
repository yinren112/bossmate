---
name: bossmate
description: Run a local, evidence-based BOSS job-search workflow through a user-owned, logged-in Edge or Chrome browser using bare Chrome DevTools Protocol. Use when an AI agent needs to help a user configure job preferences from a resume, set up and log in to a dedicated BOSS browser, search and read complete job descriptions, assess fit/pay/remote/risk evidence, prevent duplicate recruiter outreach, draft truthful first messages, send only within the user's chosen approval mode, and verify delivery. Also use when continuing or auditing an existing BossMate workspace.
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
- Stop immediately on verification pages, account anomalies, code 36/37, repeated partial/empty JDs, uncertain recipient identity, or uncertain delivery.

## Agent responsibilities

The current agent must:

- interview the user and update private configuration;
- interpret complete JD evidence;
- run `review` with explicit evidence;
- call `opener-context`, write one truthful opener, and save it with `save-opener`;
- request explicit per-job approval only when `preferences.json` uses `mode: "review"`;
- continue autonomously when `mode: "autopilot"` and every deterministic gate passes;
- report progress from the ledger, not from memory.

The scripts must:

- control the dedicated browser through bare CDP;
- persist the ledger atomically;
- detect prior recruiter contact;
- verify the live job, recruiter, JD hash, message row, and delivery state;
- refuse ambiguous or unsafe actions.

## Completion

Finish only after:

1. `node scripts/boss.js validate` passes;
2. `node scripts/boss.js check` reports a logged-in BOSS page and no security page;
3. the ledger contains the evidence and outcome for every processed job;
4. the final report separates delivered, skipped, rejected, pending, and blocked items.

If no job passes, report zero. Never weaken the user's rules to create volume.
