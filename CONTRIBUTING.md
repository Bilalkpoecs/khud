# Contributing

## Getting set up

```bash
git clone https://github.com/Bilalkpoecs/khud.git
cd khud
npm install
npm run build
npm test
```

Tests use the Node built-in test runner. There is no separate framework to
install.

```bash
npm test            # full suite
npm run test:focused
```

## Before opening a pull request

- `npm run build` passes with no TypeScript errors
- `npm test` passes in full
- New behaviour has a test next to the existing ones in `tests/`

## Things worth knowing

**Adding an agent target.** Targets are declared in `SUPPORTED_TARGETS` in
`src/lib/agents.ts`, their paths resolve in `src/lib/paths.ts`, and each gets an
adapter in `src/adapters/`. Detection must be non-destructive: khud only wires
an agent it finds actually installed, and it never overwrites a file the user
maintains by hand.

**Paths are platform-aware.** Do not hardcode `~/.config` or POSIX separators.
Everything resolves through `src/lib/paths.ts` so macOS and Windows work.

**Agent-written content is untrusted.** Anything a model produces goes to the
pending queue and waits for `khud approve`. Do not add a path that writes model
output straight into a profile or an instruction file.

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
Say what changed and why; the diff already shows how.

## Reporting bugs

https://github.com/Bilalkpoecs/khud/issues

For anything security-relevant, see [SECURITY.md](SECURITY.md) instead.
