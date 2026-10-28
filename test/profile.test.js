import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { configureProfile } from '../src/profile.js';
import { Telegram,TelegramError } from '../src/telegram.js';

test('successful profile is cached across calls; unchanged current name needs no setter', async t => {
  const store = new Store();t.after(()=>store.close());
  const calls = [];
  const telegram = { async call(method) { calls.push(method); } };
  const logger = { error(e) { throw e; } };
  await configureProfile(telegram,store,[],logger,{bot:{first_name:'НейроАйсылу'}});
  assert.deepEqual(calls,['setMyShortDescription','setMyCommands']);
  await configureProfile(telegram,store,[],logger);
  assert.equal(calls.length,2);
  await configureProfile(telegram,store,[{command:'menu',description:'меню'}],logger);
  assert.equal(calls.at(-1),'setMyCommands');
  assert.equal(calls.length,3);
});

test('profile rate limits never stop startup, survive a restart and respect retry_after', async t => {
  const store = new Store();t.after(()=>store.close());
  const calls = [];
  const errors = [];
  const telegram = { async call(method) { calls.push(method);if (method==='setMyName') throw new TelegramError(429,method,{retry_after:3600}); } };
  const logger = { error(e) { errors.push(e); } };
  await configureProfile(telegram,store,[],logger,{now:1000});
  assert.equal(calls.length,3);
  assert.equal(errors.length,1);
  await configureProfile(telegram,store,[],logger,{now:2000});
  assert.equal(calls.length,3);
  await configureProfile(telegram,store,[],logger,{now:3601001});
  assert.equal(calls.length,4);
});

test('Telegram preserves long retry_after without an immediate retry', async () => {
  let calls = 0;
  const telegram = new Telegram('test',async()=>{calls++;return new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:3600}}));});
  await assert.rejects(telegram.call('setMyName'),e=>e.code===429 && e.retryAfter===3600);
  assert.equal(calls,1);
});
