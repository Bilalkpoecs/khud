import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';

import { getHistoryDir } from '../lib/profile.js';

interface HistoryProfile {
  recent_decisions?: Array<{ what: string }>;
}

export function cmdHistory(count: number = 10): void {
  const historyDir = getHistoryDir();
  if (!fs.existsSync(historyDir)) {
    console.log(chalk.gray('No history yet.'));
    return;
  }

  const files = fs.readdirSync(historyDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, count);

  if (files.length === 0) {
    console.log(chalk.gray('No history yet.'));
    return;
  }

  console.log('');
  console.log(chalk.bold('khud history'));
  console.log('');

  for (const file of files) {
    const profile = JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf8')) as HistoryProfile;
    const stamp = file.replace('.json', '').replace('T', ' ');
    console.log(`${chalk.gray(stamp)}  ${profile.recent_decisions?.[0]?.what ?? 'profile update'}`);
  }
}
