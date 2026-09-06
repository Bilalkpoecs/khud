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

## Supply-chain scanner alerts, explained

Automated scanners flag khud for capabilities that are inherent to what it is: a
local CLI that wires AI agents. None of them are network exfiltration. For the
record, and so a reviewer does not have to reverse-engineer it:

| Alert | Why it fires | Where |
|---|---|---|
| Shell / local binary execution | Detects installed agents via `<agent> --version`, runs the reindex script on finalize, calls `notify-send` for desktop notices | `src/lib/agents.ts`, `src/lib/finalize.ts`, `src/lib/notice.ts` |
| Filesystem access | Its entire purpose: read one profile, write each agent's instruction file | `src/adapters/*` |
| Environment variable access | Path resolution only: `HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME`, and the `KHUD_*` overrides | `src/lib/paths.ts` |
| URL strings | One loopback URL, `http://127.0.0.1:11435/api/status`, a read-only health probe of the local turbovec dashboard with a 2s timeout. Everything else scanners list here is a filename, not a URL | `src/commands/status.ts` |
| Code anomaly (hooks) | The OpenCode plugin passes prompt content and a session id to a local recall script and injects the result back into the session. That is the memory feature working as designed | `src/commands/hooks.ts` |

**khud makes no outbound network requests.** The only network call in the
codebase is the loopback probe above. There is no telemetry, no analytics, no
update check, and no call to any host you do not run yourself.

**What is worth scrutinising** is the same thing listed earlier on this page:
whether untrusted, model-authored content can reach an instruction file or a
hook without passing `khud approve`. That is the real threat model, not the
capability list.
