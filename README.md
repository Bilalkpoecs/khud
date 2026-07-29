# khud

khud is a cross-agent identity and memory compiler for local AI coding agents.

It keeps one canonical profile in `~/.khud/profile.json`, compiles that profile into each supported agent's native instruction format, and wires session hooks for inbox capture → locked `finalize` → Obsidian episodes/decisions → turbovec reindex, with evidence-gated preference promotion.

## supported agents

- Claude Code
- OpenCode
- Cursor

## platform support

- Linux: verified
- macOS: platform-aware path resolution included
- Windows: platform-aware path resolution included

khud now resolves home, config, plugin, and agent paths by platform instead of relying on Linux-only defaults.

## install

Install khud globally:

```bash
npm install -g khud
```

Then wire the current machine:

```bash
khud setup
```

`khud setup` detects which supported agents are installed on the current machine and only wires those targets.

## first-run flow on a new machine

```bash
npm install -g khud
khud setup
khud status
```

## what setup does

- creates `~/.khud/profile.json` if it does not exist
- keeps the existing profile unless `--reset-profile` is passed
- detects installed Claude Code, OpenCode, and Cursor targets
- writes the agent-specific identity files for detected targets
- installs the session hook files for detected targets

## common commands

```bash
khud setup
khud show
khud sync
khud status
khud diff
khud approve
khud reject
```

To replace the local profile with the seed profile during setup:

```bash
khud setup --reset-profile
```

## publish flow

Before publishing:

```bash
npm run build
npm pack
```

Publish to npm when authenticated:

```bash
npm publish
```
