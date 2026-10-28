import { AI } from '../src/ai.js';
import { getConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { nextDelivery,profanityFamilies } from '../src/humor.js';
import { MOODS } from '../src/moods.js';

// Explicit paid check: ledger entries count toward the normal daily budget.
const config = getConfig();
const store = new Store(config.databasePath);
const ai = new AI(config);
const count = Number(process.argv[2] || 6);
if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error('число проверок от 1 до 6');
// Synthetic regression context from the repetition report, never a copy of the live database.
const history = ['хули ржёшь блядь это твоё приданое','охуеть здравый смысл блядь ушёл к другой','здравый смысл блядь сдох ты заел как ржавый шпингалет','блядь здравый смысл ушёл а ты как попугай остался','он блядь собрал чемодан и ушёл жить к тостеру','у тостера блядь хотя бы есть предохранитель'].map((text,i)=>({message_id:i+1,user_id:9,label:'айсылу',date:1,text}));
try {
  for (const query of ['можно я отдохну','не обижай мою кису','ахахахаха','я видел пришельцев','а почему не ко мне','я сегодня выгляжу охуенно'].slice(0,count)) {
    const reservation = store.reserveSpending(null,0,'text',config);
    if (reservation.error) throw new Error(reservation.error);
    try {
      const result = await ai.reply({ mode:'chat',query,history,user:{id:1,first_name:'участник'},botId:9,mood:MOODS[2],delivery:nextDelivery(store,'style-check'),wordLimit:10 });
      store.settleSpending(reservation.id,result.usage,result.generationId);
      history.push({ message_id:history.length+1,user_id:1,label:'участник',date:Math.floor(Date.now()/1000),text:query });
      history.push({ message_id:history.length+1,user_id:9,label:'айсылу',date:Math.floor(Date.now()/1000),text:result.text });
      console.log(JSON.stringify({query,answer:result.text,cost:result.usage?.cost_rub ?? result.usage?.cost,words:result.text.split(/\s+/).length,families:[...profanityFamilies(result.text)]}));
    } catch (error) {
      if (error.definitelyUnbilled) store.cancelSpending(reservation.id);
      else store.settleSpending(reservation.id,error.usage,error.generationId);
      throw error;
    }
  }
} finally { store.close(); }
