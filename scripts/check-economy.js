// Two real requests, recorded in the same budget ledger as the bot.
import { getConfig,safeError } from '../src/config.js';
import { AI } from '../src/ai.js';
import { Store } from '../src/store.js';
import { MOODS } from '../src/moods.js';

const config = getConfig();
const store = new Store(config.databasePath);
const ai = new AI(config);
try {
  for (const [mode,query] of [
    ['chat','представься одной фразой и объясни почему у тебя phd'],
    ['search','официальный сайт национального музея республики башкортостан уфа адрес'],
  ]) {
    const reservation = store.reserveSpending(0,0,mode === 'search' ? 'search' : 'text',config);
    if (reservation.error) throw new Error(reservation.error);
    try {
      const result = await ai.reply({ mode,query,mood:MOODS[2],user:{ id:0,first_name:'тестер' },history:[] });
      store.settleSpending(reservation.id,result.usage,result.generationId);
      console.log(JSON.stringify({ mode,text:result.text,sources:result.sources.length,cost_rub:result.usage?.cost_rub ?? result.usage?.cost,tokens:result.usage?.total_tokens,reasoning:result.usage?.completion_tokens_details?.reasoning_tokens,cached:result.usage?.prompt_tokens_details?.cached_tokens,generation:result.generationId }));
      if (mode === 'search' && !result.sources.length) throw new Error('поиск не вернул источники');
    } catch (error) {
      if (store.db.prepare('SELECT state FROM spending WHERE id=?').get(reservation.id).state !== 'reported') {
        if (error.definitelyUnbilled) store.cancelSpending(reservation.id);
        else store.settleSpending(reservation.id,error.usage,error.generationId);
      }
      throw error;
    }
  }
  console.log(JSON.stringify({ budget:store.spending() }));
} catch (error) { console.error(safeError(error,config));process.exitCode = 1; }
finally { store.close(); }
