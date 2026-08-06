/**
 * Tier-1 slot budgets for the always-on identity file.
 *
 * Spec section 3.1 of the unified agent orchestration design. The reader was
 * capped at 800 tokens while this writer stayed unbounded, which achieves nothing:
 * the file measured 8617 chars, about 2154 estimated tokens, on 2026-08-06.
 *
 * Measured composition of that file:
 *   Preferences        1166 tok   54%
 *   Stack               442 tok   21%
 *   Khud protocol       223 tok   10%
 *   Constraints         197 tok    9%
 *   Active Project       90 tok    4%
 *   preamble             29 tok    1%
 *   Recent Decisions      5 tok    0%
 *
 * Tokens are estimated as chars/4 throughout, the same proxy the retrieval bench
 * uses, so the two sets of numbers stay comparable.
 */

export const CHARS_PER_TOKEN = 4;

export interface SlotBudget {
  readonly name: string;
  readonly tokens: number;
  /** Lower trims first when the total overflows. */
  readonly priority: number;
}

/**
 * Budgets are the spec's. Priority is not in the spec, so it is set here and
 * stated: hard rules are the last thing trimmed because they are the
 * non-negotiables, and the stack is the first because it is a list of names the
 * agent can also read off the repo.
 */
export const TIER1_SLOTS: Record<string, SlotBudget> = {
  identity: { name: 'identity', tokens: 150, priority: 3 },
  stack: { name: 'stack', tokens: 150, priority: 1 },
  rules: { name: 'rules', tokens: 300, priority: 4 },
  project: { name: 'project', tokens: 200, priority: 2 },
};

export const TIER1_TOTAL_TOKENS = 800;

/**
 * Rules budget override, in tokens.
 *
 * Default is 0, meaning "do not trim rules", because the cap's premise is
 * currently false. Spec 3.1 assumes anything trimmed from tier-1 stays reachable
 * through tier-2 pull. Probed on 2026-08-06 against the live index, 2 of 5 sampled
 * preferences were unreachable at any k, including "never use default exports in
 * TypeScript" and "use aplay not paplay for PipeWire audio". Trimming those from
 * the always-on file would delete them from the agent's view outright.
 *
 * Set KHUD_TIER1_RULES_TOKENS=300 to apply the spec budget once preferences are
 * written into the vault and the probe passes.
 */
export function rulesBudgetTokens(): number {
  const raw = process.env.KHUD_TIER1_RULES_TOKENS;
  if (!raw) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

export function estimateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

/**
 * Trim a list of lines to a token budget, keeping whole lines.
 *
 * A budget of 0 means unlimited. Returns the kept lines and the dropped ones, so
 * the caller can report exactly what a cap cost rather than losing it silently.
 */
export function trimLinesToBudget(
  lines: readonly string[],
  budgetTokens: number,
): { kept: string[]; dropped: string[] } {
  if (budgetTokens <= 0) {
    return { kept: [...lines], dropped: [] };
  }
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const kept: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > budgetChars) {
      dropped.push(line);
      continue;
    }
    kept.push(line);
    used += cost;
  }
  return { kept, dropped };
}
