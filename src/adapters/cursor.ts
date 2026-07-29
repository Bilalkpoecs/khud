import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteText } from '../lib/atomic.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';

const PATHS = resolvePaths();

export function injectCursorProject(profile: Profile, cwd: string = process.cwd()): void {
  const rulesDir = path.join(cwd, '.cursor', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  atomicWriteText(path.join(rulesDir, 'khud.mdc'), compileToCursor(profile));
}

export function injectCursorGlobal(profile: Profile): void {
  const globalRules = PATHS.cursorRulesDir;
  fs.mkdirSync(globalRules, { recursive: true });
  atomicWriteText(path.join(globalRules, 'khud.mdc'), compileToCursor(profile));
}

function compileToCursor(profile: Profile): string {
  const decisions = profile.recent_decisions
    .slice(0, 5)
    .map((decision) => `- ${decision.date}: ${decision.what} - ${decision.why}`)
    .join('\n');

  const preferences = profile.preferences.map((preference) => `- ${preference}`).join('\n');
  // Cursor received neither of these until 2026-07-29: 6 constraints and 773 bytes
  // were dropped silently, including the decision protocol the profile itself calls
  // load-bearing. The Claude and OpenCode adapters both emitted them all along.
  const constraints = profile.constraints.map((constraint) => `- ${constraint}`).join('\n');

  return `---
description: Developer identity - apply to all sessions
alwaysApply: true
---

# ${profile.name} - Developer Identity (khud)
Managed by khud. Updated: ${profile.updated}

Stack: ${profile.stack.join(', ')}

Preferences:
${preferences}

Constraints:
${constraints}

Active: ${profile.active_project.name} - ${profile.active_project.description}
Status: ${profile.active_project.status}

Recent decisions:
${decisions}

## Session Capture Rule
At the end of every session write a JSON summary to
\`~/.khud/inbox/cursor/<session-id>/<capture-id>.json\`
(or legacy \`~/.khud/pending.json\` which is auto-bridged).

Include quoted evidence for preferences. Only explicit user statements
and repeated verified behavior become durable identity. Write silently.
`;
}
