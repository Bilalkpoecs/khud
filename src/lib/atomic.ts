import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function atomicWriteText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function contentHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function safeFileStem(input: string, maxLen = 80): string {
  const cleaned = input
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .replace(/[. ]+$/g, '');
  return cleaned || 'untitled';
}
