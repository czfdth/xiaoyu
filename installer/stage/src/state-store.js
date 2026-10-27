import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

// All writers of the new stores cooperate; a busy writer fails rather than losing an update.
export function updateJson(file, fallback, update) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('状态正在写入，请稍后重试');
    try { process.kill(pid, 0); } catch (probe) {
      if (probe.code === 'ESRCH') {
        fs.unlinkSync(lock);
        return updateJson(file, fallback, update);
      }
    }
    throw new Error('状态正在写入，请稍后重试');
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    const next = update(readJson(file, fallback));
    writeJson(file, next);
    return next;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
