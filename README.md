# BossMate

Your AI agent for careful, evidence-based job hunting on BOSS.

BossMate teaches Codex, Claude Code, OpenCode, Hermes, or WorkBuddy to:

- learn your real resume facts and job preferences;
- launch a dedicated local browser and let you log in yourself;
- search and read complete job descriptions;
- record evidence for fit, pay, remote status, and risk;
- avoid contacting the same recruiter twice;
- write truthful first messages;
- send only within your chosen approval mode;
- verify the exact message was delivered.

Everything private stays on your computer.

## Install

No clone required:

```bash
npx github:yinren112/bossmate
```

Install for one agent:

```bash
npx github:yinren112/bossmate --agent codex
npx github:yinren112/bossmate --agent claude
npx github:yinren112/bossmate --agent opencode
npx github:yinren112/bossmate --agent hermes
npx github:yinren112/bossmate --agent workbuddy
```

Install into the current project instead of your user profile:

```bash
npx github:yinren112/bossmate --agent all --scope project
```

Then tell your agent:

> Use $bossmate to configure my resume and job preferences.

The agent will ask for your resume and preferences, create a private workspace, open a dedicated browser, and wait for you to log in.

## Requirements

- Node.js 22 or newer
- Windows with Edge or Chrome for the bundled browser launcher
- Your own BOSS account
- A supported local AI coding agent

The Skill format is portable. The bundled browser launcher is currently verified on Windows; other systems need an equivalent visible Chrome/Edge launch command.

## Safety

- You log in personally. BossMate never asks for passwords, SMS codes, cookies, or session tokens.
- Verification pages, account anomalies, code 36/37, incomplete JDs, uncertain recipients, or uncertain delivery stop the workflow.
- There is no force-send path.
- Review mode requires approval per job. Autopilot mode follows only the rules you confirmed during setup.
- No qualified job means zero messages.

BossMate is local browser assistance, not a guarantee of account safety or platform compatibility. You are responsible for following the platform's current terms and rules.

## Development

```bash
npm test
npm run pack:check
```

## License

MIT
