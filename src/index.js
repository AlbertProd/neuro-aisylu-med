import { mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfig, safeError } from './config.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { AI } from './ai.js';
import { Router, COMMANDS } from './router.js';
import { configureProfile } from './profile.js';

const config = getConfig();
const logger = {
  info: (message) => console.log(`${new Date().toISOString()} ${message}`),
  error: (error) => console.error(`${new Date().toISOString()} ${safeError(error,config)}`),
};
mkdirSync(dirname(config.databasePath),{ recursive:true });
const lockPath = join(dirname(config.databasePath),'bot.lock');
let lock;
try { lock = openSync(lockPath,'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const oldPid = Number(readFileSync(lockPath,'utf8'));
  let live = false;
  try { process.kill(oldPid,0); live = true; } catch (probe) { if (probe.code !== 'ESRCH') live = true; }
  if (live) throw new Error('бот уже запущен');
  unlinkSync(lockPath);
  lock = openSync(lockPath,'wx');
}
writeSync(lock,String(process.pid));
const store = new Store(config.databasePath);
const telegram = new Telegram(config.telegramToken);
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT',stop);
process.once('SIGTERM',stop);

try {
  const bot = await telegram.call('getMe');
  const webhook = await telegram.call('getWebhookInfo');
  if (webhook.url) throw new Error('у бота уже настроен webhook отключи его перед запуском polling');
  await configureProfile(telegram,store,COMMANDS,logger,{ bot });
  const router = new Router({ config,store,telegram,ai:new AI(config),bot,logger });
  logger.info(`НейроАйсылу запущена @${bot.username} model=${config.model} privacy=${!bot.can_read_all_group_messages}`);
  let failures = 0;
  while (!controller.signal.aborted) {
    try {
      const updates = await telegram.call('getUpdates',{
        offset:Number(store.get('offset') || 0),timeout:25,allowed_updates:['message','edited_message','callback_query'],
      },{ signal:controller.signal,timeout:35000 });
      failures = 0;
      for (const update of updates) {
        if (controller.signal.aborted) break;
        try { await router.handle(update); } catch (error) { logger.error(error); }
        store.set('offset',update.update_id+1);
      }
    } catch (error) {
      if (controller.signal.aborted) break;
      if (error.code === 409) throw new Error('другой экземпляр получает сообщения останови его');
      logger.error(error);
      const backoff = Math.min(30000,1000 * 2 ** Math.min(++failures,5));
      await delay(Math.max(backoff,(error.retryAfter || 0)*1000),undefined,{ signal:controller.signal }).catch(() => {});
    }
  }
} catch (error) { logger.error(error); process.exitCode = 1; }
finally {
  store.close();
  closeSync(lock);
  unlinkSync(lockPath);
  logger.info('бот остановлен');
}
