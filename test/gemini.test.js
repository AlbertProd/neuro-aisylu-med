import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig,safeError } from '../src/config.js';
import { AI,buildRequest } from '../src/ai.js';
import { buildGeminiRequest,parseGeminiResponse,geminiUsage } from '../src/gemini.js';
import { Store } from '../src/store.js';

const config = getConfig({TELEGRAM_BOT_TOKEN:'test-token',GEMINI_API_KEY:'test-google-key'});
const usageMetadata = {promptTokenCount:1000,candidatesTokenCount:100,thoughtsTokenCount:200,cachedContentTokenCount:100,totalTokenCount:1300};
const response = (content,extra={})=>({responseId:'gemini-response',usageMetadata,candidates:[{content:{parts:[{text:content}]}}],...extra});

test('Gemini config does not require Polza and never silently falls back to its key',()=>{
  assert.equal(config.provider,'gemini');
  assert.equal(config.model,'gemini-3.8-flash');
  assert.equal(config.polzaKey,'');
  assert.equal(config.baseUrl,'https://generativelanguage.googleapis.com/v1beta');
  assert.throws(()=>getConfig({TELEGRAM_BOT_TOKEN:'test',AI_PROVIDER:'gemini',POLZA_API_KEY:'test'}),/GEMINI_API_KEY/);
  assert.equal(getConfig({TELEGRAM_BOT_TOKEN:'test',POLZA_API_KEY:'test'}).provider,'polza');
  assert.ok(!safeError(new Error('test-google-key'),config).includes(config.geminiKey));
  assert.ok(!safeError(new Error('AIza'+'x'.repeat(35))).includes('x'.repeat(35)));
});

test('native request retains all fifty messages and supports inline image and audio without secret URLs',()=>{
  const history = Array.from({length:50},(_,i)=>({message_id:i,user_id:i%2,label:`user${i%2}`,date:i,text:`сообщение ${i}`}));
  const body = buildGeminiRequest(buildRequest(config,{query:'что здесь',history,media:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,YWJj'}},{type:'input_audio',input_audio:{format:'mp3',data:'YWJj'}}]}));
  assert.equal(body.contents.length,1);
  const parts = body.contents[0].parts;
  assert.equal(JSON.parse(parts[0].text.split('\n')[1]).rows.length,50);
  assert.equal(parts[2].inlineData.mimeType,'image/jpeg');
  assert.equal(parts[3].inlineData.mimeType,'audio/mpeg');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'low');
  assert.equal(body.generationConfig.temperature,undefined);
  assert.ok(!JSON.stringify(body).includes(config.geminiKey));
  assert.throws(()=>buildGeminiRequest(buildRequest(config,{media:[{type:'image_url',image_url:{url:'https://api.telegram.org/bot-secret/file'}}]})),/подготовленные/);
});

test('Google search is only enabled for explicit search and JSON alternatives stay within ordinary replies',()=>{
  const chat = buildGeminiRequest(buildRequest(config,{query:'привет'}));
  assert.equal(chat.tools,undefined);
  assert.equal(chat.generationConfig.responseMimeType,'application/json');
  assert.equal(chat.generationConfig.responseJsonSchema.properties.answers.maxItems,2);
  const search = buildGeminiRequest(buildRequest(config,{mode:'search',query:'уфа новости'}),{mode:'search'});
  assert.deepEqual(search.tools,[{googleSearch:{}}]);
  assert.equal(search.generationConfig.responseMimeType,undefined);
});

test('native response ignores hidden thoughts and citations only come from HTTPS grounding metadata',()=>{
  const data = response('ответ');
  data.candidates[0].content.parts.unshift({thought:true,text:'скрытое рассуждение'});
  data.candidates[0].groundingMetadata = {groundingChunks:[{web:{uri:'https://example.com/Case',title:'источник'}},{web:{uri:'javascript:alert(1)'}},{web:{uri:'https://user:pass@example.com/'}},{web:{uri:'https://example.com/Case'}}]};
  const result = parseGeminiResponse(data,config,{});
  assert.equal(result.content,'ответ');
  assert.deepEqual(result.sources,[{url:'https://example.com/Case',title:'источник'}]);
});

test('Google cost estimates include thinking, caching, search queries and the announced 2027 price change',()=>{
  const data = response('ответ');
  const early = geminiUsage(data,config,{now:Date.UTC(2026,10,6)});
  const usd = (900*0.75+100*0.075+300*3.75)/1e6;
  assert.ok(Math.abs(early.cost_usd-usd)<1e-12);
  assert.ok(early.cost_rub>=usd*100*1.15);
  assert.equal(early.cost_estimated,true);
  assert.equal(geminiUsage(data,config,{now:Date.UTC(2027,0,1)}).cost_usd,usd*2);
  data.candidates[0].groundingMetadata = {webSearchQueries:['уфа','уфа',' музей ','']};
  assert.ok(Math.abs(geminiUsage(data,config,{mode:'search',now:Date.UTC(2026,10,6)}).cost_usd-(usd+0.028))<1e-12);
  assert.equal(geminiUsage({usageMetadata:{totalTokenCount:100}},config,{}).cost_rub,undefined);
  assert.equal(geminiUsage({},config,{}),undefined);
});

test('one native call selects one short reply and passes Google authentication only in a header',async()=>{
  let calls = 0;
  const ai = new AI(config,async(url,options)=>{
    calls++;
    assert.ok(url.endsWith('/models/gemini-3.8-flash:generateContent'));
    assert.ok(!url.includes(config.geminiKey));
    assert.equal(options.headers['x-goog-api-key'],config.geminiKey);
    assert.equal(options.headers.Authorization,undefined);
    assert.ok(!options.body.includes(config.geminiKey));
    return new Response(JSON.stringify(response('{"answers":["привет дворовым легендам","здорово местным гремлинам"]}')));
  });
  const result = await ai.reply({query:'привет',wordLimit:10});
  assert.equal(calls,1);
  assert.ok(result.text.split(/\s+/).length<=10);
  assert.equal(result.generationId,'gemini-response');
  assert.equal(result.usage.cost_estimated,true);
});

test('Google rejects unpaid requests without retries or a Polza fallback and preserves usage on empty paid responses',async()=>{
  let calls = 0;
  const ai = new AI(config,async()=>{calls++;return new Response('{}',{status:402});});
  await assert.rejects(ai.reply({query:'hi'}),error=>error.definitelyUnbilled && /402/.test(error.message));
  assert.equal(calls,1);
  const empty = new AI(config,async()=>new Response(JSON.stringify(response(''))));
  await assert.rejects(empty.reply({query:'hi'}),error=>error.usage.cost_estimated && error.generationId==='gemini-response');
});

test('estimated Google spending shares the original daily budget and survives database restart',()=>{
  const directory = mkdtempSync(join(tmpdir(),'aisylu-gemini-'));
  try {
    const file = join(directory,'test.sqlite');
    let store = new Store(file);
    const r = store.reserveSpending(1,1,'text',config);
    store.settleSpending(r.id,{cost_rub:2,cost_estimated:true},'google-one');
    assert.equal(store.spending().actual,0);
    assert.equal(store.spending().estimated,2);
    assert.equal(store.spending().total,2);
    assert.ok(store.reserveSpending(1,1,'text',{...config,dailyBudgetRub:3}).error);
    store.close();store = new Store(file);
    assert.equal(store.spending().estimated,2);
    store.close();
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(),'aisylu-gemini-')));
    rmSync(directory,{recursive:true,force:true});
  }
});
