import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock } from '../src/lock.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'aisylu-lock-'));
  t.after(()=>{
    assert.ok(directory.startsWith(join(tmpdir(),'aisylu-lock-')));
    rmSync(directory,{recursive:true,force:true});
  });
  return join(directory,'bot.lock');
}

test('startup recovers a legacy PID reused by the new process, as happens with container PID 1',t=>{
  const file = fixture(t);
  writeFileSync(file,String(process.pid));
  const release = acquireLock(file);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).pid,process.pid);
  release();
  assert.equal(existsSync(file),false);
});

test('a process cannot acquire the same lock twice and release never deletes a replacement',t=>{
  const file = fixture(t);
  const release = acquireLock(file);
  assert.throws(()=>acquireLock(file),/уже запущен/);
  writeFileSync(file,'replacement owner');
  release();release();
  assert.equal(readFileSync(file,'utf8'),'replacement owner');
});

test('a live second process is excluded, but an abruptly terminated owner does not block recovery',async t=>{
  const file = fixture(t);
  const module = new URL('../src/lock.js',import.meta.url).href;
  const source = `import { acquireLock } from ${JSON.stringify(module)}; acquireLock(process.argv[1]); console.log('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath,['--input-type=module','-e',source,file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('lock helper exited');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('lock helper timeout')),5000);timer.unref();})]);
  assert.throws(()=>acquireLock(file),/уже запущен/);
  const exited = once(child,'exit');
  child.kill('SIGKILL');await exited;
  const release = acquireLock(file);
  release();assert.equal(existsSync(file),false);
});

test('an incomplete newly created lock is not stolen during its owner startup',t=>{
  const file = fixture(t);
  writeFileSync(file,'');
  assert.throws(()=>acquireLock(file),/уже запускается/);
});
