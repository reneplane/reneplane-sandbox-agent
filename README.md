# Reneplane Local

Reneplane Local runs [Reneplane Workspace](https://workspace.reneplane.com) missions on your own
computer: the real backend, frontend, database and tests of each mission, for any stack. The IDE stays
in your browser and talks to this agent over `ws://127.0.0.1`.

## Install

Open a mission in the workspace and choose **On your computer**. The workspace shows a command with
your own one-time token in it. Paste it into a terminal:

```powershell
# Windows (PowerShell)
irm "https://get.reneplane.com/local.ps1?t=<token>" | iex
```

```sh
# macOS and Linux
curl -fsSL "https://get.reneplane.com/local?t=<token>" | sh
```

The command installs into `~/.reneplane` (no admin rights), pairs the agent with your browser,
starts it at login, and starts it now. Then click **Allow** when your browser asks whether the site may
connect to apps on your device.

Nothing else needs installing first. Each stack's runtime (Node, Python, Java, .NET, PostgreSQL,
MySQL) downloads the first time a mission needs it, with its checksum verified, and stays for next time.

## What it can do on your computer

- Listen on `127.0.0.1` only (ports 47811–47813), never on your network.
- Accept connections only from `https://workspace.reneplane.com` with a matching `Host`, and only from a
  browser it was paired with. Every message after pairing carries a session token.
- Read and write files only inside the mission's folder (`~/.reneplane/missions/<attempt>/repo`).
- Clone only Reneplane's own codebank repositories, at the tag the mission pins. The commands it runs
  come from that tag's `.reneplane/workspace.yaml`, never from files you edit.
- Run the mission's programs as you, without admin rights. They stop 10 minutes after you close the tab.

SQL Server missions use a database hosted by Reneplane (Azure SQL), so they need internet. Everything
else works offline once its runtime has been downloaded.

## Commands

```
reneplane-local status     is it running, and which mission
reneplane-local stop       stop it (and every mission program it started)
reneplane-local start      start it in the background
reneplane-local doctor     check this computer: memory, disk, runtimes, …
reneplane-local pair <t>   pair another browser (the workspace shows the token)
```

## Developing

```sh
npm install
npm test
RENEPLANE_HOME=~/.reneplane-dev npm run dev -- --codebanks ..   # accepts http://localhost:5175 too
```

`--codebanks <dir>` clones `reneplane/codebank-x` from `<dir>/codebank-x` instead of GitHub.
`npm run pin-runtimes` re-pins runtime downloads (URLs and SHA-256) after a version change.

The wire protocol is in `src/protocol.ts`; the workspace mirrors it in `src/contracts/agent.ts`.

## License

MIT
