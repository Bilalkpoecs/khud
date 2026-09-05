import fs from 'node:fs';
import path from 'node:path';

import { hermesSoulFiles } from '../adapters/hermes.js';
import { expandTargets, type SupportedTarget } from '../lib/agents.js';
import { parseContextProfile, previewContext, profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import { readProfile } from '../lib/profile.js';

export interface ContextPreviewOptions {
  to: string;
  profile?: string;
  json?: boolean;
}

export function cmdContextPreview(options: ContextPreviewOptions): void {
  try {
    const source = options.profile
      ? path.resolve(options.profile)
      : path.join(resolvePaths().khudDir, 'profile.json');
    const value: unknown = JSON.parse(fs.readFileSync(source, 'utf8'));
    const preview = previewContext(parseContextProfile(value), options.to);
    if (options.json) {
      console.log(JSON.stringify({ source, ...preview }, null, 2));
    } else {
      console.log(`Read-only context preview: ${source}`);
      console.log(`Budget: ${preview.budget_tokens} estimated tokens (characters/4). No files are written.`);
      for (const item of preview.projections) {
        console.log(`${item.target.padEnd(9)} ${item.bytes} bytes, ${item.estimated_tokens} estimated tokens: ${item.within_budget ? 'within budget' : 'OVER BUDGET'} (${item.kind})`);
      }
      if (preview.projections.length === 1) console.log(`\n${preview.projections[0].content}`);
    }
    if (preview.projections.some((item) => !item.within_budget)) {
      console.error('Context exceeds the budget. All supplied rules are retained; move scoped guidance and verify retrieval before reducing the profile.');
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Cannot preview context: ${message}`);
    process.exitCode = 1;
  }
}

export interface ContextDiffOptions {
  to: string;
}

/** Compare what each agent has on disk against what the current profile would generate. */
export function cmdContextDiff(options: ContextDiffOptions): void {
  try {
    const profile = readProfile();
    const core = renderCore(profileCore(profile));
    let drift = 0;
    for (const target of expandTargets(options.to)) {
      for (const file of projectionTargets(target)) {
        const expected = target === 'hermes'
          ? renderProjection('hermes', core)
          : renderProjection(target, core);
        const exists = fs.existsSync(file);
        const actual = exists ? fs.readFileSync(file, 'utf8') : '';
        const inSync = target === 'hermes' ? actual.includes(expected) : actual === expected;
        if (!inSync) drift += 1;
        const state = !exists ? 'MISSING' : inSync ? 'in sync' : 'DRIFTED';
        console.log(`${target.padEnd(9)} ${state.padEnd(8)} ${file}`);
      }
    }
    if (drift > 0) {
      console.error(`${drift} projection(s) differ from the current profile. Run: khud sync --to all`);
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Cannot diff context: ${message}`);
    process.exitCode = 1;
  }
}

function projectionTargets(target: SupportedTarget): string[] {
  const paths = resolvePaths();
  if (target === 'claude') return [paths.claudeMarkdown];
  if (target === 'codex') return [paths.codexAgentsFile];
  if (target === 'opencode') return [paths.opencodeIdentityFile];
  if (target === 'cursor') return [paths.cursorRuleFile];
  if (target === 'pi') return [paths.piAgentsFile];
  const souls = hermesSoulFiles();
  return souls.length ? souls : [paths.hermesSoulFile];
}
