import { access } from 'node:fs/promises';
import { getConfig, safeError } from '../src/config.js';
import { Telegram } from '../src/telegram.js';
import { FFMPEG, FFPROBE, runMedia } from '../src/media.js';
import { VertexAuth } from '../src/vertex.js';

const config = getConfig();
try {
  const telegram = new Telegram(config.telegramToken);
  const native = config.provider==='gemini';
  const [bot,webhook,models] = await Promise.all([
    telegram.call('getMe'),telegram.call('getWebhookInfo'),
    config.provider==='vertex'?new VertexAuth(config).token().then(()=>({data:[{id:config.model}]})):fetch(`${config.baseUrl}/models${native?'?pageSize=1000':''}`,{ headers:native?{'x-goog-api-key':config.geminiKey}:{ Authorization:`Bearer ${config.polzaKey}` },signal:AbortSignal.timeout(20000) }).then(async r => { if (!r.ok) throw new Error(`каталог моделей http ${r.status}`); return r.json(); }),
  ]);
  const model = native?models.models?.find(m=>m.name===`models/${config.model}`):models.data?.find(m => m.id === config.model);
  if (!model) throw new Error(`выбранной модели нет в каталоге ${config.provider}`);
  await Promise.all([access(FFMPEG),access(FFPROBE)]);
  await runMedia(FFMPEG,['-version']);
  await runMedia(FFPROBE,['-version']);
  console.log(JSON.stringify({ telegram:'ok',username:bot.username,privacy_enabled:!bot.can_read_all_group_messages,webhook_enabled:!!webhook.url,provider:config.provider,endpoint:config.provider==='vertex'?'oauth ok':'catalog ok',generation_auth:'доступ к генерации проверяется через smoke.js',model:native?model.name:model.id,input_modalities:model.architecture?.input_modalities,media_tools:'ok' },null,2));
} catch (error) { console.error(safeError(error,config)); process.exitCode = 1; }
