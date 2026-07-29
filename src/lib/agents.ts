import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolvePaths } from './paths.js';

export const SUPPORTED_TARGETS = ['claude', 'opencode', 'cursor'] as const;

export type SupportedTarget = (typeof SUPPORTED_TARGETS)[number];

export interface DetectedAgent {
  target: SupportedTarget;
  name: string;
  detectedBy: 'command' | 'path';
  evidence: string;
}

export function expandTargets(target: string = 'all'): SupportedTarget[] {
  if (target === 'all') {
    return [...SUPPORTED_TARGETS];
  }

  if (isSupportedTarget(target)) {
    return [target];
  }

  throw new Error(`Unsupported target: ${target}`);
}

export function getAgentName(target: SupportedTarget): string {
  if (target === 'claude') {
    return 'Claude Code';
  }

  if (target === 'opencode') {
    return 'OpenCode';
  }

  return 'Cursor';
}

export function detectInstalledAgents(): DetectedAgent[] {
  const detections: DetectedAgent[] = [];
  const paths = resolvePaths();
  const localAppData = process.env.LOCALAPPDATA || path.join(paths.homeDir, 'AppData', 'Local');

  maybeAddDetection(detections, 'claude', 'claude', [
    path.join(paths.homeDir, '.local', 'bin', 'claude'),
    paths.claudeDir
  ]);
  maybeAddDetection(detections, 'opencode', 'opencode', [
    path.join(paths.homeDir, '.opencode', 'bin', 'opencode'),
    paths.opencodeConfigDir,
    paths.opencodeAgentsDir
  ]);
  maybeAddDetection(detections, 'cursor', 'cursor', [
    '/usr/bin/cursor',
    '/opt/Cursor',
    '/usr/share/cursor',
    '/Applications/Cursor.app',
    path.join(paths.homeDir, 'Applications', 'Cursor.app'),
    path.join(paths.configDir, 'Cursor'),
    path.join(localAppData, 'Programs', 'Cursor'),
    path.join(localAppData, 'Cursor')
  ]);

  return detections;
}

function maybeAddDetection(
  detections: DetectedAgent[],
  target: SupportedTarget,
  commandName: string,
  fallbackPaths: string[]
): void {
  if (commandExists(commandName)) {
    detections.push({
      target,
      name: getAgentName(target),
      detectedBy: 'command',
      evidence: commandName
    });
    return;
  }

  const existingPath = fallbackPaths.find((candidate) => fs.existsSync(candidate));
  if (existingPath) {
    detections.push({
      target,
      name: getAgentName(target),
      detectedBy: 'path',
      evidence: existingPath
    });
  }
}

function commandExists(commandName: string): boolean {
  const result = spawnSync(commandName, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32'
  });

  return !result.error && result.status === 0;
}

function isSupportedTarget(target: string): target is SupportedTarget {
  return SUPPORTED_TARGETS.includes(target as SupportedTarget);
}
