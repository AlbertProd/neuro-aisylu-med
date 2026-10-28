import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { getConfig } from '../src/config.js';
import { AI,buildRequest } from '../src/ai.js';
import { Router } from '../src/router.js';
import { MOODS } from '../src/moods.js';
import { MediaError } from '../src/media.js';

const config = getConfig({ TELEGRAM_BOT_TOKEN:'test',POLZA_API_KEY:'test' });
function fixture(t) { const store = new Store();t.after(() => store.close());return store; }

test('budget accounts for reservations before API charges are known', t => {
  const store = fixture(t);
  const cfg = { ...config,dailyBudgetRub:4 };
  const first = store.reserveSpending(1,1,'search',cfg);
  assert.ok(first.id);
  assert.ok(store.reserveSpending(2,2,'text',cfg).error);
  store.settleSpending(first.id,{ cost_rub:1.2 },'gen-one');
  assert.ok(store.reserveSpending(2,2,'text',cfg).id);
  assert.equal(store.spending().actual,1.2);
  assert.equal(store.spending().held,1.5);
});
test('missing and malformed costs retain reservation instead of becoming zero', t => {
  const store = fixture(t);
  for (const usage of [undefined,{}, { cost_rub:'unknown' },{ cost_rub:-5 },{ cost_rub:null }]) {
    const r = store.reserveSpending(1,1,'text',config);
    store.settleSpending(r.id,usage);
  }
  assert.equal(store.spending().held,7.5);
  assert.equal(store.spending().actual,0);
});
test('known zero charge is released and unpaid invalid media does not use quotas', t => {
  const store = fixture(t);
  const r = store.reserveSpending(1,1,'media',config);
  store.cancelSpending(r.id);
  assert.equal(store.spending().expensive,0);
  assert.equal(store.spending().total,0);
  const next = store.reserveSpending(1,1,'text',config);
  store.settleSpending(next.id,{ cost_rub:0 });
  assert.equal(store.spending().total,0);
});
test('expensive quotas are global, per participant, and do not block text', t => {
  const store = fixture(t);
  const cfg = { ...config,expensivePerDay:2,expensivePerUserDay:1 };
  assert.ok(store.reserveSpending(1,1,'search',cfg).id);
  assert.ok(store.reserveSpending(2,1,'media',cfg).error);
  assert.ok(store.reserveSpending(2,2,'media',cfg).id);
  assert.ok(store.reserveSpending(3,3,'search',cfg).error);
  assert.ok(store.reserveSpending(3,3,'text',cfg).id);
});
test('budget resets at Ufa midnight and charges belong to request start day', t => {
  const store = fixture(t);
  const before = Date.parse('2026-10-10T18:59:00Z');
  const after = Date.parse('2026-10-10T19:01:00Z');
  const cfg = { ...config,dailyBudgetRub:4 };
  const r = store.reserveSpending(1,1,'search',cfg,before);
  assert.ok(store.reserveSpending(1,1,'search',cfg,after).id);
  store.settleSpending(r.id,{ cost_rub:2 });
  assert.equal(store.spending('2026-10-10').actual,2);
  assert.equal(store.spending('2026-10-11').held,4);
});
test('forgetting or unbinding a chat cannot reset monetary spending', t => {
  const store = fixture(t);
  store.bindChat({ id:1 });
  const r = store.reserveSpending(1,1,'search',config);
  store.settleSpending(r.id,{ cost:2.5 });
  store.forget(1);
  store.unbindChat(1);
  assert.equal(store.spending().actual,2.5);
  assert.equal(store.spending().expensive,1);
});
test('imports and repeat imports cannot double-count a generation', t => {
  const store = fixture(t);
  const r = store.reserveSpending(1,1,'text',config);
  store.settleSpending(r.id,{ cost:0.2 },'gen-same');
  const generation = { id:'gen-same',createdAt:new Date().toISOString(),cost:'0.2' };
  store.importSpending(generation);
  store.importSpending(generation);
  assert.equal(store.spending().actual,0.2);
  store.importSpending({ ...generation,id:'gen-other',cost:'0.7' });
  assert.ok(Math.abs(store.spending().actual-0.9) < 0.00001);
});
test('budget and unresolved reservations survive restarting the database', () => {
  const directory = mkdtempSync(join(tmpdir(),'aisylu-budget-'));
  try {
    let store = new Store(join(directory,'test.sqlite'));
    store.reserveSpending(1,1,'search',config);
    store.close();
    store = new Store(join(directory,'test.sqlite'));
    assert.equal(store.spending().held,4);
    store.close();
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(),'aisylu-budget-')));
    rmSync(directory,{ recursive:true,force:true });
  }
});
test('cache prefix remains stable and all fifty messages retain full text and authors', () => {
  const history = Array.from({ length:50 },(_,i) => ({ message_id:i,user_id:i%3,label:`user${i%3}`,text:`Полный текст сообщения ${i}`,date:100+i,topic:1 }));
  const one = buildRequest(config,{ query:'привет',history,mood:MOODS[0] });
  const two = buildRequest(config,{ mode:'search',query:'новости',history,mood:MOODS[25] });
  assert.equal(one.messages[0].content,two.messages[0].content);
  const payload = JSON.parse(one.messages[2].content.split('\n')[1]);
  assert.equal(payload.rows.length,50);
  assert.equal(payload.authors.length,3);
  assert.equal(payload.rows[49][4],'Полный текст сообщения 49');
  assert.equal(one.provider.sort,'price');
  assert.equal(one.provider.max_price.prompt,60);
  assert.equal(two.plugins[0].engine,'exa');
  assert.equal(one.max_tokens,2048);
});
test('empty paid model answer preserves billing information', async () => {
  const ai = new AI(config,async () => new Response(JSON.stringify({ id:'gen-empty',usage:{ cost:0.4 },choices:[{ message:{ content:null } }] })));
  await assert.rejects(ai.reply({ query:'hi' }),error => error.usage.cost === 0.4 && error.generationId === 'gen-empty');
});
test('router stops before downloading or calling AI when budget is exhausted', async t => {
  const store = fixture(t);
  const sent = [];
  const cfg = { ...config,dailyBudgetRub:0.5 };
  let invoked = false;
  const router = new Router({ config:cfg,store,telegram:{ async send(m,text){ sent.push(text); } },ai:{ async reply(){ invoked = true; } },bot:{ id:9 },prepare:async()=>{ invoked = true; } });
  await router.generate({ chat:{ id:1,type:'private' },from:{ id:1 },message_id:1,voice:{ file_id:'x' } },'chat','слушай');
  assert.equal(invoked,false);
  assert.match(sent[0],/бюджет/);
});
test('router cancels reservation when preprocessing rejects media before a paid call', async t => {
  const store = fixture(t);
  const router = new Router({ config,store,telegram:{ async send(){},async call(){} },ai:{ async reply(){ throw new Error('must not call'); } },bot:{ id:9 },prepare:async()=>{ throw new MediaError('broken'); },logger:{ error(){},info(){} } });
  await router.generate({ chat:{ id:1,type:'private' },from:{ id:1 },message_id:1,voice:{ file_id:'x' } },'chat','слушай');
  assert.equal(store.spending().held,0);
  assert.equal(store.spending().expensive,0);
});

test('unexpected charge above reservation blocks subsequent paid calls at the day limit', t => {
  const store = fixture(t);
  const cfg = { ...config,dailyBudgetRub:4 };
  const r = store.reserveSpending(1,1,'search',cfg);
  store.settleSpending(r.id,{ cost:4.1 });
  assert.ok(store.reserveSpending(1,1,'text',cfg).error);
});

test('cost is recorded even if Telegram delivery fails after generation', async t => {
  const store = fixture(t);
  const router = new Router({ config,store,telegram:{ async send(){ throw new Error('delivery failed'); },async call(){} },
    ai:{ async reply(){ return { text:'ответ',usage:{ cost:0.25 },generationId:'gen-delivery' }; } },bot:{ id:9 },logger:{ error(){},info(){} } });
  await assert.rejects(router.generate({ chat:{ id:1,type:'private' },from:{ id:1 },message_id:1 },'chat','hi'),/delivery failed/);
  assert.equal(store.spending().actual,0.25);
  assert.equal(store.spending().held,0);
});

test('an ambiguous AI connection failure keeps its monetary reservation', async t => {
  const store = fixture(t);
  const router = new Router({ config,store,telegram:{ async send(){},async call(){} },
    ai:{ async reply(){ throw new Error('response lost'); } },bot:{ id:9 },logger:{ error(){},info(){} } });
  await router.generate({ chat:{ id:1,type:'private' },from:{ id:1 },message_id:1 },'chat','hi');
  assert.equal(store.spending().held,1.5);
});

test('AI retries once only when no connection was established', async () => {
  let calls = 0;
  const ai = new AI(config,async () => {
    if (++calls === 1) throw new Error('fetch failed',{ cause:{ code:'UND_ERR_CONNECT_TIMEOUT' } });
    return new Response(JSON.stringify({ id:'gen-retry',usage:{ cost:0.1 },choices:[{ message:{ content:'привет' } }] }));
  });
  const result = await ai.reply({ query:'hi' });
  assert.equal(calls,2);
  assert.equal(result.usage.cost,0.1);
  let ambiguousCalls = 0;
  const ambiguous = new AI(config,async () => { ambiguousCalls++;throw new Error('socket lost',{ cause:{ code:'UND_ERR_SOCKET' } }); });
  await assert.rejects(ambiguous.reply({ query:'hi' }));
  assert.equal(ambiguousCalls,1);
});
