import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,verify } from 'node:crypto';
import { getConfig,safeError } from '../src/config.js';
import { VertexAuth,vertexAssertion,vertexEndpoint } from '../src/vertex.js';
import { WebSearch,searchResults } from '../src/search.js';
import { Store } from '../src/store.js';
import { AI } from '../src/ai.js';

const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const credentials={type:'service_account',project_id:'test-project-12345',client_email:'bot@test-project-12345.iam.gserviceaccount.com',private_key:pair.privateKey.export({type:'pkcs8',format:'pem'})};
const config=getConfig({TELEGRAM_BOT_TOKEN:'test',AI_PROVIDER:'vertex',VERTEX_SERVICE_ACCOUNT_BASE64:Buffer.from(JSON.stringify(credentials)).toString('base64'),TAVILY_API_KEY:'test-search-key'});
const usage={account:{current_plan:'Researcher',plan_usage:0,plan_limit:1000,paygo_usage:0,paygo_limit:null}};
const found={results:[{url:'https://example.com/one',title:'источник',content:'факт из источника'}]};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});

test('Vertex uses its own credentials and validates the endpoint without fallback',()=>{
  assert.equal(config.provider,'vertex');assert.equal(config.geminiKey,'');assert.equal(config.polzaKey,'');
  assert.equal(config.searchProvider,'tavily');
  assert.equal(vertexEndpoint(config,credentials),'https://aiplatform.googleapis.com/v1/projects/test-project-12345/locations/global/publishers/google/models/gemini-3.8-flash:generateContent');
  assert.throws(()=>vertexEndpoint({...config,vertexLocation:'evil.com'},credentials));
  assert.throws(()=>new VertexAuth({...config,vertexCredentialsBase64:Buffer.from('{}').toString('base64')}),/учётные/);
  assert.throws(()=>getConfig({TELEGRAM_BOT_TOKEN:'x',AI_PROVIDER:'vertex'}),/CREDENTIALS/);
  assert.throws(()=>getConfig({TELEGRAM_BOT_TOKEN:'x',AI_PROVIDER:'vertex',VERTEX_SERVICE_ACCOUNT_BASE64:'x',SEARCH_PROVIDER:'native'}),/tavily/);
  assert.equal(safeError(new Error(config.vertexCredentialsBase64),config),'[secret]');
  assert.equal(safeError(new Error(config.tavilyKey),config),'[secret]');
});

test('service account assertions are signed for Google only and tokens refresh before expiry',async()=>{
  let now=Date.UTC(2026,10,6),calls=0;
  const assertion=vertexAssertion(credentials,now);
  const [header,payload,signature]=assertion.split('.');
  assert.equal(JSON.parse(Buffer.from(payload,'base64url')).aud,'https://oauth2.googleapis.com/token');
  assert.equal(JSON.parse(Buffer.from(payload,'base64url')).exp,Math.floor(now/1000)+3600);
  assert.ok(verify('RSA-SHA256',Buffer.from(`${header}.${payload}`),pair.publicKey,Buffer.from(signature,'base64url')));
  const auth=new VertexAuth(config,async(url,options)=>{
    calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');
    assert.ok(!String(options.body).includes(credentials.private_key));
    return json({access_token:`token-${calls}`,expires_in:3600});
  },()=>now);
  assert.deepEqual(await Promise.all([auth.token(),auth.token()]),['token-1','token-1']);
  now+=3500000;assert.equal(await auth.token(),'token-1');
  now+=50000;assert.equal(await auth.token(),'token-2');assert.equal(calls,2);
  const failed=new VertexAuth(config,async()=>json({},403));
  await assert.rejects(failed.token(),e=>e.definitelyUnbilled && /403/.test(e.message));
});

test('search sends only the explicit query, uses advanced retrieval, and shares persistent cache',async()=>{
  const store=new Store();let posts=0,gets=0,now=Date.UTC(2026,10,6);
  const fetch=async(url,options)=>{
    assert.equal(options.headers.Authorization,`Bearer ${config.tavilyKey}`);
    if (url.endsWith('/usage')) {gets++;return json(usage);}
    posts++;const body=JSON.parse(options.body);
    assert.equal(body.query,'уфа новости сегодня');assert.equal(body.search_depth,'advanced');assert.equal(body.max_results,5);
    assert.equal(body.topic,'news');assert.equal(body.time_range,'day');assert.equal(body.include_answer,false);
    assert.equal(body.auto_parameters,false);assert.equal(body.messages,undefined);
    return json(found);
  };
  try {
    const web=new WebSearch(config,store,fetch,()=>now);
    const [one,two]=await Promise.all([web.search(' уфа   новости сегодня '),web.search('уфа новости сегодня')]);
    assert.deepEqual(one,two);assert.equal(posts,1);assert.equal(gets,1);assert.equal(store.searchCredits('2026-11'),2);
    assert.equal((await new WebSearch(config,store,fetch,()=>now).search('уфа новости сегодня')).cached,true);
    assert.equal(posts,1);
    now+=config.searchCacheMs+1;await web.search('уфа новости сегодня');assert.equal(posts,2);
  } finally {store.close();}
});

test('search blocks paid plans, exhausted provider quota and uncertain usage before retrieval',async()=>{
  const store=new Store();
  try {
    for (const account of [{...usage.account,current_plan:'Bootstrap'},{...usage.account,paygo_limit:100},{...usage.account,plan_usage:989},{...usage.account,plan_usage:'unknown'}]) {
      let calls=0;
      const web=new WebSearch(config,store,async(url)=>{calls++;assert.ok(url.endsWith('/usage'));return json({account});});
      await assert.rejects(web.search('test'),e=>e.definitelyUnbilled);assert.equal(calls,1);
    }
    const web=new WebSearch(config,store,async()=>{throw new Error('offline');});
    await assert.rejects(web.search('test'),/проверить/);
    assert.equal(store.searchCredits(),0);
  } finally {store.close();}
});

test('monthly credit reservations survive uncertain failures, enforce concurrency and reset by UTC month',async()=>{
  const store=new Store();const now=()=>Date.UTC(2026,10,30,23,59);
  try {
    const web=new WebSearch({...config,searchMonthlyCredits:2},store,async(url)=>url.endsWith('/usage')?json(usage):Promise.reject(new Error('timeout')),now);
    await assert.rejects(web.search('one'),/недоступен/);
    await assert.rejects(web.search('two'),/месяц/);
    assert.equal(store.searchCredits('2026-11'),2);
    assert.ok(store.reserveSearchCredits(2,2,Date.UTC(2026,11,1)));
    assert.equal(store.reserveSearchCredits(2,2,Date.UTC(2026,11,1)),null);
  } finally {store.close();}
});

test('invalid search responses retain credits; rejected requests release them; citations are validated',async()=>{
  const store=new Store();
  try {
    const rejected=new WebSearch(config,store,async(url)=>url.endsWith('/usage')?json(usage):json({},401));
    await assert.rejects(rejected.search('one'),/401/);assert.equal(store.searchCredits(),0);
    const empty=new WebSearch(config,store,async(url)=>url.endsWith('/usage')?json(usage):json({results:[]}));
    await assert.rejects(empty.search('two'),/источников/);assert.equal(store.searchCredits(),2);
    assert.equal(searchResults({results:[...found.results,...found.results,{url:'javascript:alert(1)',content:'x'},{url:'https://user:password@example.com',content:'x'}]}).length,1);
  } finally {store.close();}
});

test('Vertex synthesis never enables paid grounding and does not expose credentials or chat history to search',async()=>{
  const store=new Store();let synthesis=0,searches=0;
  try {
    const ai=new AI(config,async(url,options)=>{
      if (url.includes('/usage')) return json(usage);
      if (url.includes('api.tavily.com')) {searches++;assert.ok(!options.body.includes('private conversation'));return json(found);}
      if (url.includes('oauth2')) return json({access_token:'oauth-access',expires_in:3600});
      synthesis++;
      assert.ok(url.includes('aiplatform.googleapis.com/v1/projects/'));
      assert.equal(options.headers.Authorization,'Bearer oauth-access');assert.equal(options.headers['x-goog-api-key'],undefined);
      const body=JSON.parse(options.body);assert.equal(body.tools,undefined);
      assert.ok(options.body.includes('факт из источника'));assert.ok(options.body.includes('НЕДОВЕРЕННЫЕ'));
      assert.ok(!options.body.includes(config.tavilyKey));assert.ok(!options.body.includes(config.vertexCredentialsBase64));
      return json({responseId:'native-one',usageMetadata:{promptTokenCount:100,totalTokenCount:110,candidatesTokenCount:10},candidates:[{content:{parts:[{text:'найденный факт'}]}}]});
    },store);
    const result=await ai.reply({mode:'search',query:'уфа музей',history:[{user_id:1,label:'x',text:'private conversation'}]});
    assert.equal(synthesis,1);assert.equal(searches,1);assert.equal(result.sources[0].url,found.results[0].url);
    assert.equal(result.usage.search_queries,0);assert.ok(result.usage.cost_estimated);
  } finally {store.close();}
});

test('quota failures do not call the language model or start a paid fallback',async()=>{
  const store=new Store();let calls=0;
  try {
    const ai=new AI({...config,searchMonthlyCredits:0},async(url)=>{calls++;assert.ok(url.endsWith('/usage'));return json(usage);},store);
    await assert.rejects(ai.reply({mode:'search',query:'news'}),e=>e.definitelyUnbilled);
    assert.equal(calls,1);
  } finally {store.close();}
});
