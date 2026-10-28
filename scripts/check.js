import { access } from 'node:fs/promises';
import { getConfig, safeError } from '../src/config.js';
import { Telegram } from '../src/telegram.js';
import { FFMPEG, FFPROBE, runMedia } from '../src/media.js';

const config = getConfig();
try {
  const telegram = new Telegram(config.telegramToken);
  const [bot,webhook,models] = await Promise.all([
    telegram.call('getMe'),telegram.call('getWebhookInfo'),
    fetch(`${config.baseUrl}/models`,{ headers:{ Authorization:`Bearer ${config.polzaKey}` },signal:AbortSignal.timeout(20000) }).then(async r => { if (!r.ok) throw new Error(`каталог моделей http ${r.status}`); return r.json(); }),
  ]);
  const model = models.data?.find(m => m.id === config.model);
  if (!model) throw new Error('выбранной модели нет в каталоге polza');
  await Promise.all([access(FFMPEG),access(FFPROBE)]);
  await runMedia(FFMPEG,['-version']);
  await runMedia(FFPROBE,['-version']);
  console.log(JSON.stringify({ telegram:'ok',username:bot.username,privacy_enabled:!bot.can_read_all_group_messages,webhook_enabled:!!webhook.url,polza_endpoint:'ok',polza_auth:'проверка генерации через smoke.js',model:model.id,input_modalities:model.architecture?.input_modalities,media_tools:'ok' },null,2));
} catch (error) { console.error(safeError(error,config)); process.exitCode = 1; }
