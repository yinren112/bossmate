# Onboarding

## Goal

Create a private, user-confirmed workspace before any online action.

## Initialize

Run:

```powershell
node scripts/setup.js
```

Set `BOSSMATE_HOME` when the user wants a different private location. `BOSS_JOB_HOME` remains a compatibility alias.

## Interview

Ask at most two questions at a time. Do not make the user design the schema.

1. Ask for a resume, portfolio, pasted text, or permission to read an existing local resume.
2. Extract only verifiable facts, evidence links, target roles, and facts that must not be claimed.
3. Ask for primary and adjacent roles.
4. Ask for location/remote requirements, employment types, minimum compensation, schedule limits, and hard exclusions.
5. Show the resulting facts and preferences once for confirmation.

## Write private files

Update `<home>/profile.md`:

- replace all template text with confirmed facts;
- separate allowed facts, prohibited claims, evidence, and communication style;
- do not copy irrelevant personal identifiers.

Update `<home>/preferences.json`:

- create one profile per target role family;
- use real title/JD keywords supplied or confirmed by the user;
- set city, browser, compensation, exclusions, and opener limits;
- add risky or unsupported claims to `opener.bannedClaims`;
- set `onboarding.confirmed` to `true` only after the user confirms the summary;
- record `confirmedAt` as an ISO timestamp.

Keep `<home>/data/ledger.json` local.

## Cross-agent placement

Use the same Skill folder without changing business logic:

- Codex/OpenCode project skill: `.agents/skills/bossmate/`
- Claude Code project skill: `.claude/skills/bossmate/`
- Hermes: install or copy under `~/.hermes/skills/.../bossmate/`
- WorkBuddy project skill: `.workbuddy/skills/bossmate/`

Do not maintain separate forks for different agents.
