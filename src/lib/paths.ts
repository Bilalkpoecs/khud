import os from 'node:os';
import path from 'node:path';

export interface PathEnv {
  HOME?: string;
  USERPROFILE?: string;
  APPDATA?: string;
  LOCALAPPDATA?: string;
  XDG_CONFIG_HOME?: string;
  KHUD_HOME?: string;
  KHUD_CONFIG_HOME?: string;
  KHUD_DESKTOP_DIR?: string;
  KHUD_OPENCODE_AGENTS_DIR?: string;
  KHUD_VAULT_DIR?: string;
}

export interface ResolvedPaths {
  homeDir: string;
  configDir: string;
  desktopDir: string;
  khudDir: string;
  inboxDir: string;
  quarantineDir: string;
  processedDir: string;
  candidatesDir: string;
  lockDir: string;
  pendingFile: string;
  historyDir: string;
  vaultDir: string;
  sessionsDir: string;
  decisionsDir: string;
  decisionLogFile: string;
  decisionArchiveFile: string;
  claudeDir: string;
  claudeMarkdown: string;
  claudeSettings: string;
  cursorDir: string;
  cursorRulesDir: string;
  cursorRuleFile: string;
  cursorHooks: string;
  opencodeConfigDir: string;
  opencodePluginsDir: string;
  opencodeAgentsDir: string;
  opencodeIdentityFile: string;
  codexDir: string;
  codexAgentsFile: string;
  piAgentDir: string;
  piAgentsFile: string;
  hermesDir: string;
  hermesSoulFile: string;
  hermesProfilesDir: string;
  ancestorAgentsFile: string;
}

type RuntimePlatform = NodeJS.Platform | 'win32' | 'darwin' | 'linux';

export function resolvePaths(
  platform: RuntimePlatform = process.platform,
  env: PathEnv = process.env
): ResolvedPaths {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const homeDir = env.KHUD_HOME || env.HOME || env.USERPROFILE || os.homedir();

  const configDir = env.KHUD_CONFIG_HOME || (
    platform === 'win32'
      ? env.APPDATA || pathApi.join(homeDir, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? pathApi.join(homeDir, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || pathApi.join(homeDir, '.config')
  );

  const desktopDir = env.KHUD_DESKTOP_DIR || pathApi.join(homeDir, 'Desktop');
  const khudDir = pathApi.join(homeDir, '.khud');
  const vaultDir = env.KHUD_VAULT_DIR
    || pathApi.join(desktopDir, 'bilal-workspace', 'Active', 'Bilal');
  const claudeDir = pathApi.join(homeDir, '.claude');
  const cursorDir = pathApi.join(homeDir, '.cursor');
  const opencodeConfigDir = pathApi.join(configDir, 'opencode');
  const opencodeAgentsDir = env.KHUD_OPENCODE_AGENTS_DIR || pathApi.join(opencodeConfigDir, 'agents');
  const decisionsDir = pathApi.join(vaultDir, 'Decisions');
  const codexDir = pathApi.join(homeDir, '.codex');
  const piAgentDir = pathApi.join(homeDir, '.pi', 'agent');
  const hermesDir = pathApi.join(homeDir, '.hermes');

  return {
    homeDir,
    configDir,
    desktopDir,
    khudDir,
    inboxDir: pathApi.join(khudDir, 'inbox'),
    quarantineDir: pathApi.join(khudDir, 'quarantine'),
    processedDir: pathApi.join(khudDir, 'processed'),
    candidatesDir: pathApi.join(khudDir, 'candidates'),
    lockDir: pathApi.join(khudDir, 'locks', 'finalize.lock'),
    pendingFile: pathApi.join(khudDir, 'pending.json'),
    historyDir: pathApi.join(khudDir, 'history'),
    vaultDir,
    sessionsDir: pathApi.join(vaultDir, 'Sessions'),
    decisionsDir,
    decisionLogFile: pathApi.join(decisionsDir, 'Decision-Log.md'),
    decisionArchiveFile: pathApi.join(decisionsDir, 'Decision-Log.archive.md'),
    claudeDir,
    claudeMarkdown: pathApi.join(claudeDir, 'CLAUDE.md'),
    claudeSettings: pathApi.join(claudeDir, 'settings.json'),
    cursorDir,
    cursorRulesDir: pathApi.join(cursorDir, 'rules'),
    cursorRuleFile: pathApi.join(cursorDir, 'rules', 'khud.mdc'),
    cursorHooks: pathApi.join(cursorDir, 'hooks.json'),
    opencodeConfigDir,
    opencodePluginsDir: pathApi.join(opencodeConfigDir, 'plugins'),
    opencodeAgentsDir,
    opencodeIdentityFile: pathApi.join(opencodeAgentsDir, 'khud-identity.md'),
    codexDir,
    codexAgentsFile: pathApi.join(codexDir, 'AGENTS.md'),
    piAgentDir,
    piAgentsFile: pathApi.join(piAgentDir, 'AGENTS.md'),
    hermesDir,
    hermesSoulFile: pathApi.join(hermesDir, 'SOUL.md'),
    hermesProfilesDir: pathApi.join(hermesDir, 'profiles'),
    // Codex and Pi both concatenate ancestor AGENTS.md files into the effective load.
    ancestorAgentsFile: pathApi.join(homeDir, 'AGENTS.md')
  };
}

export function displayPath(fullPath: string, env: PathEnv = process.env): string {
  const { homeDir } = resolvePaths(process.platform, env);
  return fullPath.startsWith(homeDir) ? `~${fullPath.slice(homeDir.length)}` : fullPath;
}
