# Security Policy

## Supported versions

Only the latest published version receives fixes. khud is pre-1.0; older
versions are not patched.

| Version | Supported |
|---|---|
| 0.3.x | yes |
| < 0.3 | no |

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

https://github.com/Bilalkpoecs/khud/security/advisories/new

Do not open a public issue for a vulnerability. Expect an initial reply within
7 days.

## What khud touches, and why that matters

khud is a local CLI. It has no network calls and no telemetry, but it does read
and write files that shape what AI agents do, so the relevant risk is local:

- **It writes agent instruction files.** `~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.cursor/rules/khud.mdc` and the equivalents for
  OpenCode, Pi and Hermes. Anything that reaches those files becomes standing
  instruction for an agent that can run commands, so treat a write primitive
  here as higher severity than a normal config write.
- **It installs session hooks.** These execute on agent lifecycle events.
- **It reads and writes `~/.khud/profile.json`.** This holds personal identity
  and preferences.
- **It ingests agent-written summaries.** Content authored by a model is
  untrusted input. That is why summaries stay pending until approved through
  `khud diff` / `khud approve` rather than landing automatically.

Findings that let untrusted content reach an instruction file or a hook without
passing the approval gate are the ones worth reporting first.
