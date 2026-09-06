# khud

**Cross-agent identity compiler — خود**

**khud is a cross-agent identity and memory compiler for AI coding agents.**
It gives Claude Code, Codex, OpenCode, Cursor, Pi and Hermes one shared profile
and one shared memory, instead of six drifting copies.

If you use more than one AI coding agent, each wants your context in its own
format, in its own file, in its own directory: `CLAUDE.md` for Claude Code,
`AGENTS.md` for Codex, an identity file for OpenCode, an `.mdc` rule for Cursor.
So you either write the same preferences six times and watch them drift, or you
give the weaker agents nothing.

khud keeps one canonical profile in `~/.khud/profile.json`, compiles it into
each agent's native instruction format, and keeps them in sync. Write it once.

```bash
npm install -g khud
khud setup
khud status
```

## What it actually does

**One profile, many agents.** `khud sync` compiles `~/.khud/profile.json` into
each agent's own instruction file. Change a preference in
one place; every agent picks it up.

**Session memory that survives.** Session hooks capture work in progress to an
inbox. `khud finalize` locks those captures and writes them into Obsidian as
episodes and decisions, then reindexes them in turbovec so they are retrievable
later.

**Nothing lands without your say-so.** Agent-written summaries stay pending
until you look at them. `khud diff` shows what an agent wants to add,
`khud approve` accepts it, `khud reject` throws it away. Preferences are promoted
only when there is evidence behind them, not because an agent asserted one once.

## Which AI coding agents does khud support?

Six targets. khud writes the file each agent already reads at session start, so
there is nothing to configure inside the agent itself:

| Agent | File khud writes |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex CLI | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/agents/khud-identity.md` |
| Cursor | `~/.cursor/rules/khud.mdc` |
| Pi | `~/.pi/agent/AGENTS.md` |
| Hermes | `~/.hermes/SOUL.md` |

`khud setup` detects which of these are actually installed and wires only those.
It will not create config for an agent you do not use.

Codex and Pi both concatenate ancestor `AGENTS.md` files into their effective
context, which khud accounts for when it compiles.

**Not wired today.** The 2026 agent landscape is wider than these six: GitHub
Copilot agent mode, Windsurf, Cline, Aider, Continue.dev, Roo Code, Kilo Code,
Devin, Antigravity CLI and Grok Build. Anything that reads a plain `AGENTS.md`
can be pointed at khud's compiled output by hand, but there is no detection or
hook installation for it. Open an issue if you want one added.

## Platform support

| Platform | Status |
|---|---|
| Linux | verified |
| macOS | platform-aware path resolution |
| Windows | platform-aware path resolution |

Home, config, plugin and agent paths resolve per platform rather than assuming
Linux defaults.

## Commands

### Daily use

```bash
khud status        # what is wired, what is pending
khud show          # print the canonical profile
khud sync          # recompile the profile into every agent's format
khud diff          # show the pending agent-written summary
khud approve       # accept it
khud reject        # discard it
```

### Setup and profile

```bash
khud setup                    # detect agents and wire this machine
khud setup --reset-profile    # replace the local profile with the seed profile
khud init                     # initialise with your profile
khud set                      # set profile values
khud add                      # add to the profile
khud context                  # inspect shared instructions without touching live files
khud history                  # recent profile changes
```

### Memory pipeline

```bash
khud capture             # write or validate session captures
khud finalize            # lock inbox captures into Obsidian and the profile
khud finalize-hook       # ingest stop-hook JSON from stdin, then finalize
khud migrate-decisions   # split Decision-Log.md into per-entry temporal notes
```

## What `khud setup` does

- creates `~/.khud/profile.json` if it does not exist
- keeps your existing profile unless `--reset-profile` is passed
- detects installed Claude Code, Codex, OpenCode, Cursor, Pi and Hermes targets
- writes the agent-specific identity files for detected targets
- installs the session hook files for detected targets

## Contributing

```bash
npm run build
npm test
```

Issues and pull requests: https://github.com/Bilalkpoecs/khud/issues

## License

MIT
