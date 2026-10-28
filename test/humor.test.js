import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { nextDelivery,LEXICON,profanityFamilies,variationState,variationGuide,candidatePenalty,selectReply } from '../src/humor.js';
import { AI,buildRequest,replyWordLimit } from '../src/ai.js';
import { getConfig } from '../src/config.js';

test('eight of ten casual responses are capped at ten words; factual and media responses allow forty', () => {
  const limits = Array.from({length:10},(_,i) => replyWordLimit({},() => i));
  assert.equal(limits.filter(n=>n===10).length,8);
  assert.equal(limits.filter(n=>n===40).length,2);
  for (const mode of ['search','summary','diagnosis','lore']) assert.equal(replyWordLimit({mode},() => 0),40);
  assert.equal(replyWordLimit({media:[{}]},() => 0),40);
});

const input = {
  botId:9,query:'не обижай мою кису',
  history:[
    { user_id:9,text:'блядь здравый смысл ушёл а ты остался' },
    { user_id:9,text:'охуеть здравый смысл блядь ушёл к тостеру' },
    { user_id:9,text:'у тостера блядь хотя бы есть предохранитель' },
    { user_id:2,text:'ебать пиздец жопа говно сука' },
  ],
};
const cfg = getConfig({ TELEGRAM_BOT_TOKEN:'test',POLZA_API_KEY:'test' });

test('cooldown recognizes swear families and ignores other participants', () => {
  assert.deepEqual([...profanityFamilies('бля блядь блять заебись поебень пиздатый охуенный сучий говнище жопный')],['blya','eb','pizd','khuy','suka','govno','zhopa']);
  assert.equal(profanityFamilies('небо ребята учёба').size,0);
  const state = variationState(input);
  assert.ok(state.used.has('blya'));
  assert.ok(state.used.has('khuy'));
  assert.ok(!state.used.has('pizd'));
  assert.ok(state.stale.includes('здрав'));
  assert.ok(state.stale.includes('тосте'));
});

test('filler cooldown lasts eight own replies, semantic words remain available when explicitly requested', () => {
  const history = [{ user_id:9,text:'блядь' },...Array.from({length:7},()=>({user_id:9,text:'спокойно'}))];
  assert.ok(variationState({ botId:9,history }).used.has('blya'));
  history.push({ user_id:9,text:'ещё спокойно' });
  assert.ok(!variationState({ botId:9,history }).used.has('blya'));
  assert.ok(!variationState({...input,query:'как работает тостер'}).stale.includes('тосте'));
});

test('vocabulary is sampled in small thematic portions, never added wholesale', () => {
  const words = Object.values(LEXICON).flatMap(g=>g.words.map(([w])=>w));
  assert.equal(words.length,96);
  assert.equal(new Set(words).size,96);
  const guide = variationGuide(input,()=>0);
  assert.match(guide,/метч/);
  assert.ok(guide.length < 1100);
  assert.ok(!guide.includes('боссфайт'));
});

test('one completion yields only the fresher alternative and never an internal JSON document', () => {
  const repeated = 'охуеть здравый смысл блядь ушёл к тостеру';
  const fresh = 'ладно у кисы дипломатический иммунитет';
  assert.ok(candidatePenalty(repeated,input)>candidatePenalty(fresh,input));
  assert.equal(selectReply(JSON.stringify({answers:[repeated,fresh]}),input,10),fresh);
  assert.equal(selectReply(JSON.stringify({answers:[repeated,repeated]}),input,10),'этот панч уже был я требую новый сценарий');
  assert.equal(selectReply('всё блядь прекрасно мы ещё повоюем',input,10),'всё прекрасно мы ещё повоюем');
  assert.equal(selectReply('всё заебись мы ещё повоюем',input,10),'всё заебись мы ещё повоюем');
  const cleanedDuplicate = { ...input,history:[...input.history,{user_id:9,text:'я люблю этот проект'}] };
  assert.equal(selectReply(JSON.stringify({answers:['я блядь люблю этот проект','кисе выдан дипломатический паспорт']}),cleanedDuplicate,10),'кисе выдан дипломатический паспорт');
  assert.throws(()=>selectReply('{"answers":[null]}',input,10),/неверный формат/);
});

test('alternatives do not alter search, media or summaries; quoted replies are separate data', () => {
  const request = buildRequest(cfg,{...input,replyTo:{author_id:9,text:'старый панч'}});
  assert.equal(request.response_format.type,'json_object');
  const current = JSON.parse(request.messages.at(-1).content.split('\n')[1]);
  assert.equal(current.request,input.query);
  assert.equal(current.reply_to.text,'старый панч');
  for (const mode of ['summary','search','lore','diagnosis']) assert.equal(buildRequest(cfg,{...input,mode}).response_format,undefined);
  assert.equal(buildRequest(cfg,{...input,media:[{type:'image_url'}]}).response_format,undefined);
  const serious = { query:'мне очень плохо не хочу жить' };
  assert.equal(buildRequest(cfg,serious).response_format,undefined);
  assert.equal(replyWordLimit(serious,()=>0),40);
  assert.equal(replyWordLimit({query:'я умру счастливой'},()=>0),10);
});

test('candidate selection makes one paid call and preserves cost on parse failures', async () => {
  let calls = 0;
  const ai = new AI(cfg,async()=>{ calls++;return new Response(JSON.stringify({id:'gen-one',usage:{cost:0.2},choices:[{message:{content:JSON.stringify({answers:['БЛЯДЬ здравый смысл снова ушёл','У кисы дипломатический иммунитет']})}}]})); });
  const result = await ai.reply({...input,wordLimit:10});
  assert.equal(result.text,'у кисы дипломатический иммунитет');
  assert.equal(calls,1);
  const invalid = new AI(cfg,async()=>new Response(JSON.stringify({id:'gen-bad',usage:{cost:0.3},choices:[{message:{content:'{"answers":[]}'}}]})));
  await assert.rejects(invalid.reply(input),e=>e.usage.cost===0.3 && e.generationId==='gen-bad');
});

test('twenty deliveries avoid the previous five choices per chat', () => {
  const store = new Store();
  try {
    const recent = Array.from({length:6},()=>nextDelivery(store,1,()=>0));
    assert.equal(new Set(recent).size,6);
  } finally { store.close(); }
});

test('humor rotates across replies, survives reuse and is separate between chats', () => {
  const store = new Store();
  try {
    const first = nextDelivery(store,-1,() => 0);
    const second = nextDelivery(store,-1,() => 0);
    const third = nextDelivery(store,-1,() => 0);
    assert.equal(new Set([first,second,third]).size,3);
    assert.equal(nextDelivery(store,-2,() => 0),first);
    assert.notEqual(nextDelivery(store,-1,() => 0),third);
  } finally { store.close(); }
});
