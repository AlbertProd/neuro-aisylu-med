import { openSync,readFileSync,writeSync,closeSync,unlinkSync,statSync,fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const held = new Set();

function identity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`,'utf8');
    const start = stat.slice(stat.lastIndexOf(')')+2).split(/\s+/u)[19];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    return `${boot}:${start}`;
  } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid,0);return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Container restarts reuse PID 1. A PID alone must not identify a previous instance as live.
export function acquireLock(file) {
  const path = resolve(file);
  if (held.has(path)) throw new Error('бот уже запущен');
  let fd;
  for (let attempt=0;attempt<4;attempt++) {
    try { fd = openSync(path,'wx');break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let previous;
    try { previous = readFileSync(path,'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue;throw error; }
    let owner;
    try { owner = JSON.parse(previous); } catch { owner = null; }
    const pid = typeof owner === 'number' ? owner : owner?.pid;
    const valid = Number.isSafeInteger(pid) && pid > 0;
    if (valid && pid !== process.pid && alive(pid)) {
      const currentIdentity = identity(pid);
      if (!owner?.identity || !currentIdentity || owner.identity === currentIdentity) throw new Error('бот уже запущен');
    }
    if (!valid && Date.now()-statSync(path).mtimeMs < 30000) throw new Error('бот уже запускается');
    try {
      if (readFileSync(path,'utf8') !== previous) continue;
      unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (fd === undefined) throw new Error('не удалось получить блокировку бота');
  const lease = JSON.stringify({pid:process.pid,identity:identity(process.pid),nonce:randomUUID()});
  try { writeSync(fd,lease);fsyncSync(fd); }
  catch (error) { closeSync(fd);try { unlinkSync(path); } catch {}throw error; }
  held.add(path);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(path);
    closeSync(fd);
    try { if (readFileSync(path,'utf8') === lease) unlinkSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
