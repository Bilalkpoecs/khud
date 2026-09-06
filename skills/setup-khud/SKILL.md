---
name: setup-khud
description: Install and wire khud, the cross-agent identity compiler, on a machine. Use when the user wants khud installed or set up, wants one profile shared across Claude Code, Codex, OpenCode, Cursor, Pi or Hermes, mentions khud setup, sync or hooks, or reports that khud is not reaching one of its agents.
---

khud compiles one profile at `~/.khud/profile.json` into each agent's native instruction file, and installs session hooks. Setup is four steps; each ends on a check you can read.

## 1. Node

`node -v` must print v18 or higher. Under nvm, source it first (`. "$NVM_DIR/nvm.sh"`) or the shell has no node at all.

## 2. Install

```bash
npm install -g khud
khud --version
```

An `EACCES` on the global prefix means npm is writing to a root-owned directory. Repoint it rather than using sudo:

```bash
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
```

Done when `khud --version` prints a version.

## 3. Wire

```bash
khud setup
```

This detects installed agents, creates the profile, compiles it into every detected agent, and installs their hooks. It prints each agent with the evidence that found it.

Detection is by command on `PATH` first, then by known config paths. An agent the user has installed but khud does not list is almost always a `PATH` problem in the shell khud ran from, not a missing feature.

Done when the output names every agent the user actually has.

## 4. Fill in the profile

A fresh profile carries only the OS account name; every list starts empty, so the first sync compiles nothing the user did not write. Add what the agents should know, then recompile:

```bash
khud add preference "explicit try/catch in async functions"
khud add stack "PostgreSQL"
khud sync
khud status
```

Longer edits go straight into `~/.khud/profile.json`, followed by `khud sync`. `--reset-profile` empties it again, so reach for it only to start over.

Done when `khud show` prints the user's own details and `khud status` reports every target wired.

## Commands

| Command | Purpose |
| --- | --- |
| `khud sync --to <target>` | recompile one agent: `claude`, `codex`, `opencode`, `cursor`, `pi`, `hermes`, `all` |
| `khud diff --to <target>` | show where an agent's file drifted from the profile |
| `khud context preview` | preview the compiled instructions, exits nonzero over budget |
| `khud hooks install --for <target>` | reinstall hooks after an agent update |
| `khud hooks status` | show which agents are wired and which files are in place |
| `khud add preference <text>` | append a preference, then `khud sync` |
| `khud add decision <what> --reason <why>` | record a decision |

## Per-system notes

Paths derive from the home directory, so Linux and macOS behave the same. On Windows khud reads `LOCALAPPDATA` for Cursor and `USERPROFILE` for the rest; run it from a shell where the global npm bin is on `PATH`.

Memory capture writes into an Obsidian vault and the recall hook shells out to `python3`. Both are optional: when python3 or the recall script is absent the hook catches the failure and returns empty context, so identity sync keeps working. Setup is complete without them.
