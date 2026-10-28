import { setTimeout as delay } from 'node:timers/promises';
import { formatReply } from './style.js';

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class TelegramError extends Error {
  constructor(code, method, parameters = {}) { super(`telegram ${method} ошибка ${code}`); this.code = code; this.retryAfter = Math.max(0,Number(parameters?.retry_after) || 0); }
}

export class Telegram {
  constructor(token, fetchImpl = fetch) { this.token = token; this.fetch = fetchImpl; this.lastSent = new Map(); }
  async call(method, body = {}, { signal, timeout = 30000, retry = true } = {}) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    let response;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: combined,
      });
    } catch (error) {
      const idempotent = ['getMe','getWebhookInfo','getFile','getUpdates','setMyName','setMyShortDescription','setMyCommands','sendChatAction','editMessageReplyMarkup'];
      if (retry && !signal?.aborted && idempotent.includes(method)) {
        await delay(750,undefined,{ signal });
        return this.call(method,body,{ signal,timeout,retry:false });
      }
      throw error;
    }
    const data = await response.json();
    if (!data.ok) {
      if (retry && data.error_code === 429 && data.parameters?.retry_after <= 30) {
        await delay(data.parameters.retry_after * 1000, undefined, { signal });
        return this.call(method, body, { signal, timeout, retry: false });
      }
      throw new TelegramError(data.error_code || response.status, method,data.parameters);
    }
    return data.result;
  }
  async send(message, text, markup) {
    const chatId = message.chat.id;
    const gap = message.chat.type === 'private' ? 1050 : 3100;
    const wait = (this.lastSent.get(chatId) || 0) + gap - Date.now();
    if (wait > 0) await delay(wait);
    this.lastSent.set(chatId, Date.now());
    return this.call('sendMessage', {
      chat_id: chatId, text: formatReply(text),
      message_thread_id: message.message_thread_id,
      reply_parameters: message.message_id ? { message_id: message.message_id, allow_sending_without_reply: true } : undefined,
      reply_markup: markup,
      link_preview_options: { is_disabled: true },
    });
  }
  async download(file) {
    if ((file.file_size || 0) > MAX_DOWNLOAD_BYTES) throw new Error('файл больше 20 мб сожми и пришли заново');
    const info = await this.call('getFile', { file_id: file.file_id });
    if (!info.file_path || info.file_size > MAX_DOWNLOAD_BYTES) throw new Error('файл недоступен или больше 20 мб');
    // Telegram's token-bearing download URL stays here; only bytes reach the model.
    const response = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('не удалось скачать медиа');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error('файл больше 20 мб сожми и пришли заново');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
