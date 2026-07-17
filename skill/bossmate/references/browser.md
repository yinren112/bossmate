# Dedicated browser

## Verified platform

The bundled launcher is verified for Windows with Edge or Chrome and Node.js 22+.

## Launch

From the Skill root:

```powershell
pwsh -File scripts/setup-browser.ps1 -Browser edge -Port 9222
```

The script:

- locates Edge or Chrome;
- creates `<home>/browser-profile`;
- starts a visible dedicated browser;
- opens BOSS;
- verifies the CDP port.

Ask the user to log in only in that visible window. Never ask for credentials, codes, cookies, exported profiles, or remote access.

## Confirm configuration

Keep the same port in `<home>/preferences.json`, or set `BOSS_CDP_PORT`.

After the user reports login complete:

```powershell
node scripts/boss.js check
```

Success requires at least one BOSS page and zero security pages.

## Existing-login migration

Do not copy the user's normal browser profile by default. A copied profile may contain unrelated browsing data.

If the user explicitly requests migration:

1. explain that the source browser must be closed;
2. copy only into the dedicated `<home>/browser-profile`;
3. exclude cache directories;
4. preserve the source profile;
5. verify the dedicated browser and ask the user to log in again if needed.

## Other operating systems

Use an equivalent visible Chrome/Edge launch command with:

- `--remote-debugging-port=<port>`
- `--user-data-dir=<private dedicated directory>`
- `https://www.zhipin.com/`

Do not claim an untested platform is verified.
