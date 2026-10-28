import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync,spawnSync } from 'node:child_process';
import { copyFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'aisylu-secrets-'));
  t.after(()=>{
    assert.ok(directory.startsWith(join(tmpdir(),'aisylu-secrets-')));
    rmSync(directory,{recursive:true,force:true});
  });
  mkdirSync(join(directory,'scripts'));
  copyFileSync(new URL('../scripts/check-secrets.js',import.meta.url),join(directory,'scripts','check-secrets.mjs'));
  const git = (...args)=>execFileSync('git',args,{cwd:directory,windowsHide:true,stdio:'pipe'});
  git('init','-q','-b','main');
  const check = ()=>spawnSync(process.execPath,['scripts/check-secrets.mjs'],{cwd:directory,windowsHide:true,encoding:'utf8',env:{...process.env,TELEGRAM_BOT_TOKEN:'',POLZA_API_KEY:''}});
  return {directory,git,check};
}

test('publication scan reads staged bytes instead of the current working copy',t=>{
  const f = fixture(t);
  const path = join(f.directory,'source.js');
  const fakeSecret = 'pza_' + 'synthetic'.repeat(5);
  writeFileSync(path,'export const ready = true;');f.git('add','source.js');
  writeFileSync(path,fakeSecret);
  assert.equal(f.check().status,0);
  f.git('add','source.js');
  writeFileSync(path,'export const ready = true;');
  const result = f.check();
  assert.equal(result.status,1);
  assert.match(result.stderr,/source.js/);
  assert.ok(!result.stderr.includes(fakeSecret));
});

test('publication scan accepts empty env examples and rejects tracked local data',t=>{
  const f = fixture(t);
  writeFileSync(join(f.directory,'.env.example'),'TELEGRAM_BOT_TOKEN=\nPOLZA_API_KEY=\n');
  f.git('add','.env.example');
  assert.equal(f.check().status,0);
  writeFileSync(join(f.directory,'.env'),'TELEGRAM_BOT_TOKEN=');
  f.git('add','--force','.env');
  assert.equal(f.check().status,1);
  f.git('rm','--cached','.env');
  mkdirSync(join(f.directory,'data'));
  writeFileSync(join(f.directory,'data','backup.sqlite'),'synthetic private data');
  f.git('add','--force','data/backup.sqlite');
  assert.equal(f.check().status,1);
});
