## What changed

<!-- What this does and why. The diff already shows how. -->

## Checklist

- [ ] `npm run build` passes
- [ ] `npm test` passes in full
- [ ] New behaviour has a test in `tests/`
- [ ] Paths go through `src/lib/paths.ts`, no hardcoded `~/.config` or `/`
- [ ] No path added that writes agent output straight into a profile or
      instruction file without the approval gate

## Adding an agent target?

- [ ] Declared in `SUPPORTED_TARGETS` in `src/lib/agents.ts`
- [ ] Paths resolve in `src/lib/paths.ts`
- [ ] Adapter added in `src/adapters/`
- [ ] Detection is non-destructive and does not overwrite hand-maintained files
- [ ] README agent table updated
