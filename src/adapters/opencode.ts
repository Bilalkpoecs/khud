import fs from 'node:fs';

import { atomicWriteText } from '../lib/atomic.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';

const PATHS = resolvePaths();
const OC_GLOBAL = PATHS.opencodeAgentsDir;
const KHUD_FILE = PATHS.opencodeIdentityFile;

export function injectOpencode(profile: Profile): void {
  fs.mkdirSync(OC_GLOBAL, { recursive: true });
  atomicWriteText(KHUD_FILE, compileToOpencode(profile));
}

function compileToOpencode(profile: Profile): string {
  const decisions = profile.recent_decisions
    .slice(0, 5)
    .map((decision) => `- ${decision.date}: ${decision.what} - ${decision.why}`)
    .join('\n');

  const preferences = profile.preferences.map((preference) => `- ${preference}`).join('\n');
  const stack = profile.stack.join(', ');
  const constraints = profile.constraints.map((constraint) => `- ${constraint}`).join('\n');

  return `# Developer Identity - ${profile.name}
Managed by khud. Source: ~/.khud/profile.json. Updated: ${profile.updated}

## Stack
${stack}

## Preferences (apply to every session)
${preferences}

## Active Project
${profile.active_project.name}: ${profile.active_project.description}
Stack: ${profile.active_project.stack}
Status: ${profile.active_project.status}

## Recent Decisions
${decisions}

## Machine Constraints
${constraints}

---

## Khud Session Protocol

At session end write:
\`~/.khud/inbox/opencode/<session-id>/<capture-id>.json\`

Legacy fallback: \`~/.khud/pending.json\` (auto-bridged).

{
  "schema_version": 1,
  "client": "opencode",
  "session_id": "<session id>",
  "date": "YYYY-MM-DD",
  "decisions": [{ "what": "...", "why": "..." }],
  "preferences_learned": [{ "text": "...", "evidence": { "kind": "explicit_user", "quote": "...", "confidence": 0.9 } }],
  "project_status": "one line",
  "stack_updates": [],
  "source": "agent"
}

Write empty arrays if nothing to capture.
Write silently.
`;
}
