import { createHash } from 'node:crypto';

// Profile cosmetics must never prevent polling; persist successful versions and flood cooldowns.
export async function configureProfile(telegram,store,commands,logger,{ bot,now = Date.now() } = {}) {
  const methods = [
    ['setMyName',{ name:'НейроАйсылу' }],
    ['setMyShortDescription',{ short_description:'альтушка из уфы · mёd · 40 настроений · мемы и вымышленные phd' }],
    ['setMyCommands',{ commands }],
  ];
  for (const [method,body] of methods) {
    const key = `telegram-profile:${method}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (store.get(key) === fingerprint) continue;
    if (method === 'setMyName' && bot?.first_name === body.name) { store.set(key,fingerprint);continue; }
    if (Number(store.get(`${key}:retry`) || 0) > now) continue;
    try {
      await telegram.call(method,body,{ retry:false,timeout:10000 });
      store.set(key,fingerprint);
      store.set(`${key}:retry`,'0');
    } catch (error) {
      if (error.code === 429) store.set(`${key}:retry`,String(now + Math.max(error.retryAfter || 60,60)*1000));
      logger.error(error);
    }
  }
}
