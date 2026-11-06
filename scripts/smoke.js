// Explicit live check. Makes four small paid requests, sends nothing to Telegram.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig, safeError } from '../src/config.js';
import { AI } from '../src/ai.js';
import { MOODS } from '../src/moods.js';
import { FFMPEG, runMedia, prepareMediaBytes, withMediaTemp } from '../src/media.js';
import { Store } from '../src/store.js';

const config = getConfig();
const store = new Store(config.databasePath);
const ai = new AI(config,fetch,store);
async function paid(input) {
  const kind = input.mode==='search'?'search':input.media?.length?'media':'text';
  const reservation = store.reserveSpending(null,0,kind,config);
  if (reservation.error) throw new Error(reservation.error);
  try {
    const result = await ai.reply(input);
    store.settleSpending(reservation.id,result.usage,result.generationId);
    return result;
  } catch (error) {
    if (error.definitelyUnbilled) store.cancelSpending(reservation.id);
    else store.settleSpending(reservation.id,error.usage,error.generationId);
    throw error;
  }
}
const input = { mood:MOODS[2],user:{ id:1,first_name:'тестер' },history:[] };
const check = (name,result) => {
  assert.ok(result.text.split(/\s+/u).length <= 40);
  assert.equal(result.text,result.text.toLowerCase());
  console.log(JSON.stringify({ check:name,provider:config.provider,text:result.text,sources:result.sources?.length || 0,tokens:result.usage?.total_tokens,cost_rub:result.usage?.cost_rub ?? result.usage?.cost,estimated:!!result.usage?.cost_estimated }));
};

try {
  check('chat',await paid({ ...input,query:'представься одной фразой и объясни почему у тебя phd' }));
  check('summary',await paid({ ...input,mode:'summary',query:'что было',history:[
    { message_id:1,user_id:2,label:'маша',date:1791650000,text:'встречаемся в субботу в 18 у белой' },
    { message_id:2,user_id:3,label:'дима',date:1791650010,text:'ок чай и чак чак принесу я' },
    { message_id:3,user_id:2,label:'маша',date:1791650020,text:'кто возьмёт колонку пока непонятно' },
  ] }));
  const search = await paid({ ...input,mode:'search',query:'официальный сайт национального музея республики башкортостан уфа адрес' });
  check('search',search);
  assert.ok(search.sources.length,'search must return citations');
  await withMediaTemp(async directory => {
    const path = join(directory,'fixture.mp4');
    await runMedia(FFMPEG,['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=320x240:d=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',path]);
    const media = await prepareMediaBytes(await readFile(path),{ kind:'video',file:{ duration:4 } });
    assert.ok(media.some(p => p.type === 'image_url'));
    assert.ok(media.some(p => p.type === 'input_audio'));
    check('video_with_audio',await paid({ ...input,query:'что на видео и какой звук не выдумывай речь',media }));
  });
} catch (error) { console.error(safeError(error,config)); process.exitCode = 1; }
finally { store.close(); }
