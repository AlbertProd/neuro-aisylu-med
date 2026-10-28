import { createHash } from 'node:crypto';
import { formatReply, localDay } from './style.js';
import { mediaFile, prepareMedia, MediaError } from './media.js';
import { nextDelivery } from './humor.js';

export const COMMANDS = [
  ['menu','меню айсылу'], ['summary','что было в чате'], ['search','поиск в интернете'],
  ['mood','текущее настроение'], ['lore','история айсылу'], ['profile','твой профиль'],
  ['daily','забрать мёд'], ['top','топ участников'], ['marry','предложить брак реплаем'],
  ['divorce','расторгнуть брак'], ['couples','пары чата'], ['rep','репутация реплаем'],
  ['ship','совместимость реплаем'], ['roast','добрая прожарка'], ['diagnosis','мемодиагноз'],
  ['bind','подключить чат владельцу'], ['status','состояние бота владельцу'], ['budget','расходы и лимиты владельцу'], ['forget','забыть контекст владельцу'],
  ['ambient','включить щитпост владельцу'], ['unbind','отключить чат владельцу'], ['help','как общаться'],
].map(([command, description]) => ({ command, description }));

export function parseIntent(message, bot) {
  const text = (message.text || message.caption || '').trim();
  const slash = text.match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (slash) {
    if (slash[2] && slash[2].toLowerCase() !== bot.username.toLowerCase()) return null;
    return { command: slash[1].toLowerCase(), query: (slash[3] || '').trim() };
  }
  if (['++','--'].includes(text) && message.reply_to_message) return { command: 'rep', query: text === '++' ? '+' : '-' };
  const alias = /(?:^|\s)(?:нейроайсылу|айсылу)(?=$|[\s,!?])/iu;
  const mention = new RegExp(`@${bot.username}(?=$|[^a-z0-9_])`, 'i');
  const addressed = alias.test(text) || mention.test(text);
  const replyToBot = message.reply_to_message?.from?.id === bot.id;
  if (!addressed && !replyToBot && message.chat.type !== 'private') return null;
  const query = text.replace(alias, ' ').replace(mention, ' ').replace(/^[\s,!?]+/, '').trim();
  if (/^поиск(?:\s|$)/iu.test(query)) return { command: 'search', query: query.replace(/^поиск\s*/iu, '') };
  if (/^что\s+было(?:\s|$|[?!])/iu.test(query)) return { command: 'summary', query };
  if (/^(новости|что нового в мире)(?:\s|$)/iu.test(query)) return { command: 'search', query: query.replace(/^новости\s*/iu, '') || 'последние новости Уфы сегодня' };
  const aliases = { 'меню':'menu', 'настроение':'mood', 'лор':'lore', 'профиль':'profile', 'дейлик':'daily', 'топ':'top', 'брак':'marry', 'развод':'divorce', 'пары':'couples', 'шип':'ship', 'прожарь':'roast', 'диагноз':'diagnosis', 'помощь':'help' };
  if (aliases[query.toLowerCase()]) return { command: aliases[query.toLowerCase()], query: '' };
  return { command: 'chat', query: query || 'кратко прокомментируй вложение или контекст' };
}

export function menu(userId,owner = false) {
  const button = (text, action) => ({ text, callback_data: `menu:${userId}:${action}` });
  return { inline_keyboard: [
    [button('🧠 что было','summary'),button('🔎 поиск','search')],
    [button('🎭 настроение','mood'),button('🖤 мой лор','lore')],
    [button('👤 профиль','profile'),button('🍯 дейлик','daily')],
    [button('💍 браки','couples'),button('🏆 топ','top')],
    [button('🔥 прожарь меня','roast'),button('🌀 мемодиагноз','diagnosis')],
    [button('📖 помощь','help')],
    ...(owner ? [[button('💸 бюджет','budget')]] : []),
  ] };
}

export class Router {
  constructor({ config, store, telegram, ai, bot, prepare = prepareMedia, logger = console }) {
    Object.assign(this, { config, store, telegram, ai, bot, prepare, logger });
    this.lastCommands = new Map();
    this.lastAmbient = new Map();
    this.ambientMessages = new Map();
  }
  async say(message, text, markup) {
    const sent = await this.telegram.send(message, formatReply(text), markup);
    if (sent?.message_id) this.store.record({ ...sent, from: this.bot }, { count: false });
    return sent;
  }
  allowed(message, user) {
    if (!user || user.is_bot || message.sender_chat) return false;
    if (message.chat.type === 'private') return this.store.isOwner(user, this.config);
    return ['group','supergroup'].includes(message.chat.type) && !!this.store.chat(message.chat.id);
  }
  async handle(update) {
    if (update.callback_query) return this.callback(update.callback_query);
    const message = update.message || update.edited_message;
    if (!message?.from || message.from.is_bot || message.sender_chat) return;
    const owner = this.store.isOwner(message.from, this.config);
    const intent = parseIntent(message, this.bot);
    const group = ['group','supergroup'].includes(message.chat.type);
    if (group && owner && intent?.command === 'bind') {
      this.store.bindChat(message.chat);
      this.store.record(message);
      return this.say(message, 'чат подключён к mёd отключи privacy mode в botfather чтобы я видела разговор теперь зови айсылу или отвечай на мои сообщения', menu(message.from.id));
    }
    if (!this.allowed(message, message.from)) return;
    this.store.record(message, { count: !update.edited_message });
    if (update.edited_message) return;
    if (!intent) {
      const settings = this.store.chat(message.chat.id);
      const count = (this.ambientMessages.get(message.chat.id) || 0) + 1;
      this.ambientMessages.set(message.chat.id, count);
      if (settings?.ambient && !mediaFile(message) && (message.text?.length || 0) > 10 && count >= 30 && Date.now() - (this.lastAmbient.get(message.chat.id) || 0) >= this.config.ambientCooldown && Math.random() < this.config.ambientProbability) {
        this.lastAmbient.set(message.chat.id, Date.now());
        this.ambientMessages.set(message.chat.id, 0);
        return this.generate(message, 'ambient', 'прокомментируй текущую беседу', false, true);
      }
      return;
    }
    const key = `${message.chat.id}:${message.from.id}`;
    if (Date.now() - (this.lastCommands.get(key) || 0) < 1500) return;
    this.lastCommands.set(key, Date.now());
    return this.command(message, intent, owner);
  }

  async command(message, { command, query }, owner = this.store.isOwner(message.from, this.config), callback = false) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const group = message.chat.type !== 'private';
    if (['bind','unbind','status','budget','forget','ambient'].includes(command) && !owner) return this.say(message, 'эту кнопку держит только владелец проекта');
    if (['start','menu'].includes(command)) return this.say(message, 'я нейроайсылу местная альтушка с вымышленными phd зови по имени поиск и сводка ниже голосовые и видео присылай с обращением или реплаем', menu(userId,owner));
    if (command === 'help') return this.say(message, 'айсылу поиск запрос · айсылу что было · реплай на медиа айсылу послушай · /marry реплаем · /rep + реплаем · /daily · /profile · /mood · /lore видео до двух минут и 20 мб');
    if (command === 'bind') return this.say(message, 'добавь меня в чат и отправь там /bind с твоего аккаунта');
    if (command === 'unbind') {
      if (!group) return this.say(message, 'отключать нужно из самого чата');
      this.store.unbindChat(chatId);
      // Do not reinsert a farewell into the erased chat history.
      return this.telegram.send(message, 'чат отключён локальная история и игры удалены');
    }
    if (command === 'status') {
      const history = this.store.history(chatId);
      return this.say(message, `жива модель ${this.config.model} память ${history.length} из 50 щитпост ${this.store.chat(chatId)?.ambient ? 'включён' : 'выключен'} личка закреплена за владельцем`, menu(userId,owner));
    }
    if (command === 'budget') {
      const spend = this.store.spending();
      return this.say(message, `сегодня ${spend.actual.toFixed(2)} ₽ резерв ${spend.held.toFixed(2)} ₽ бюджет ${this.config.dailyBudgetRub} ₽ поиск и медиа ${spend.expensive} из ${this.config.expensivePerDay} каждому ${this.config.expensivePerUserDay} в сутки сброс в полночь по уфе`);
    }
    if (command === 'forget') {
      this.store.forget(chatId);
      return this.telegram.send(message, 'контекст этого чата забыт начинаем новый сезон');
    }
    if (command === 'ambient') {
      if (!group) return this.say(message, 'щитпост включается в подключённом чате командой /ambient on');
      if (!['on','off'].includes(query)) return this.say(message, '/ambient on включить редкие реплики /ambient off выключить');
      this.store.setAmbient(chatId, query === 'on');
      return this.say(message, query === 'on' ? 'редкий щитпост включён максимум одна реплика в 15 минут после 30 сообщений' : 'сама в разговор не вклиниваюсь зови по имени');
    }
    if (command === 'mood') {
      const mood = this.store.mood(chatId);
      return this.say(message, `сейчас ${mood.name} ещё примерно ${mood.remaining} ответа и меня переклинит на новый вайб`);
    }
    if (command === 'profile') {
      const member = this.store.member(chatId, userId);
      const spouse = this.store.spouse(chatId, userId);
      return this.say(message, `${member?.label || 'анон'} сообщений ${member?.messages || 0} репутация ${member?.reputation || 0} мёд ${member?.honey || 0} ${spouse ? `в браке с ${this.store.label(chatId, spouse.partner)}` : 'свободный радикал'}`);
    }
    if (command === 'daily') {
      const result = this.store.daily(chatId, userId);
      return this.say(message, result.error || `держи ${result.amount} мёда теперь у тебя ${result.total} виртуальных единиц сладкого капитала`);
    }
    if (command === 'top') {
      const text = this.store.top(chatId).map((m,i) => `${i+1} ${m.label} репа ${m.reputation} мёд ${m.honey}`).join(' · ');
      return this.say(message, text || 'топ пока пуст даже элита ещё не проснулась');
    }
    if (command === 'couples') {
      const text = this.store.couples(chatId).map(m => `${this.store.label(chatId,m.user_id)} ♡ ${this.store.label(chatId,m.partner)}`).join(' · ');
      return this.say(message, text || 'пока никто не женат /marry реплаем на человека и ждём его согласия');
    }
    if (command === 'divorce') {
      if (!group) return this.say(message, 'браки оформляются в общем чате');
      const spouse = this.store.spouse(chatId, userId);
      if (!spouse) return this.say(message, 'ты уже свободен загс спит спокойно');
      return this.say(message, 'точно разводимся эта кнопка расторгнет ваш текущий брак', { inline_keyboard: [[{ text:'развестись',callback_data:`div:${userId}:${spouse.partner}:${spouse.since}` }]] });
    }
    if (['marry','rep','ship'].includes(command)) {
      if (!group) return this.say(message, 'эти игры работают в общем чате');
      const target = message.reply_to_message?.from;
      if (!target || target.is_bot || message.reply_to_message.sender_chat) return this.say(message, 'ответь этой командой на сообщение человека');
      // Ensure labels exist without counting the referenced message twice.
      if (!this.store.member(chatId, target.id)) this.store.db.prepare('INSERT INTO members (chat_id,user_id,label) VALUES (?,?,?)').run(chatId,target.id,target.username ? `@${target.username}` : (target.first_name || 'анон').slice(0,32));
      if (command === 'rep') {
        if (!['+','-'].includes(query)) return this.say(message, 'пиши /rep + или /rep - реплаем можно просто ++ или --');
        return this.say(message, this.store.reputation(chatId,userId,target.id,query === '+' ? 1 : -1));
      }
      if (command === 'ship') {
        const ids = [userId,target.id].sort((a,b) => a-b);
        const value = createHash('sha256').update(`${chatId}:${ids.join(':')}:${localDay()}`).digest().readUInt32BE(0) % 101;
        return this.say(message, `сегодня совместимость ${value} процентов научность нулевая зато красиво`);
      }
      const proposal = this.store.propose(chatId,userId,target.id);
      if (proposal.error) return this.say(message, proposal.error);
      return this.say(message, `${this.store.label(chatId,target.id)} тебе предложение от ${this.store.label(chatId,userId)} ответить можешь только ты срок десять минут`, { inline_keyboard: [[
        { text:'💍 согласие',callback_data:`wed:${proposal.id}:yes` }, { text:'скип',callback_data:`wed:${proposal.id}:no` },
      ]] });
    }
    if (command === 'search' && !query) return this.say(message, 'напиши айсылу поиск и сам запрос например айсылу поиск концерты в уфе на выходных');
    const modes = { chat:'chat',summary:'summary',search:'search',lore:'lore',roast:'roast',diagnosis:'diagnosis' };
    if (!modes[command]) return this.say(message, 'такой команды нет открой /menu');
    const history = this.store.history(chatId, callback ? Number.MAX_SAFE_INTEGER : message.message_id);
    if (command === 'summary' && !history.some(m => m.user_id !== this.bot.id && !m.text.startsWith('/'))) return this.say(message, 'пока мало истории я вижу только сообщения после подключения дай чату накопить лор');
    return this.generate(message, modes[command], query || ({ lore:'расскажи фрагмент своего лора',roast:'прожарь меня по моим репликам',diagnosis:'мой вымышленный мемодиагноз',summary:'что было в последних сообщениях чата' }[command]), callback);
  }

  async generate(message, mode, query, callback = false, quiet = false) {
    const limit = this.store.reserveAI(message.chat.id,message.from.id,this.config);
    if (limit) return quiet ? undefined : this.say(message,limit);
    const mediaMessage = mediaFile(message) ? message : (mediaFile(message.reply_to_message || {}) ? message.reply_to_message : null);
    const kind = mode === 'search' ? 'search' : mediaMessage && mode === 'chat' ? 'media' : 'text';
    const reservation = this.store.reserveSpending(message.chat.id,message.from.id,kind,this.config);
    if (reservation.error) return quiet ? undefined : this.say(message,reservation.error);
    const typing = () => this.telegram.call('sendChatAction',{ chat_id:message.chat.id,message_thread_id:message.message_thread_id,action:'typing' }).catch(() => {});
    await typing();
    const timer = setInterval(typing,4500);
    let called = false;
    let settled = false;
    try {
      const media = mediaMessage && mode === 'chat' ? await this.prepare(this.telegram,mediaMessage) : [];
      const reply = message.reply_to_message;
      const replyTo = mode === 'chat' && reply && !mediaMessage ? { author_id:reply.from?.id,text:(reply.text || reply.caption || '').slice(0,3000) } : undefined;
      called = true;
      const delivery = ['chat','lore','roast','ambient'].includes(mode) ? nextDelivery(this.store,message.chat.id) : undefined;
      const result = await this.ai.reply({ mode,query,replyTo,history:this.store.history(message.chat.id,callback ? Number.MAX_SAFE_INTEGER : message.message_id),mood:this.store.mood(message.chat.id,true),user:message.from,media,botId:this.bot.id,delivery });
      this.store.settleSpending(reservation.id,result.usage,result.generationId);
      settled = true;
      const cost = Number(result.usage?.cost_rub ?? result.usage?.cost);
      this.logger.info(`ai mode=${mode} tokens=${result.usage?.total_tokens ?? '?'} cost_rub=${Number.isFinite(cost) ? cost : '?'} reasoning=${result.usage?.completion_tokens_details?.reasoning_tokens ?? '?'} cached=${result.usage?.prompt_tokens_details?.cached_tokens ?? '?'} generation=${result.generationId || '?'}`);
      if (media.length) this.store.annotate(message.chat.id,mediaMessage.message_id,`[краткий разбор медиа моделью] ${result.text}`);
      const markup = result.sources?.length ? { inline_keyboard:[result.sources.map((s,i) => ({ text:`источник ${i+1}`,url:s.url }))] } : undefined;
      await this.say(message,result.text,markup);
    } catch (error) {
      if (!settled) {
        if (!called || error.definitelyUnbilled) this.store.cancelSpending(reservation.id);
        else this.store.settleSpending(reservation.id,error.usage,error.generationId);
      }
      this.logger.error(error);
      if (!quiet) await this.say(message,error instanceof MediaError ? error.message : 'связь с мозгом отвалилась попробуй чуть позже');
    } finally { clearInterval(timer); }
  }

  async callback(callback) {
    const original = callback.message;
    if (!original || !this.allowed(original,callback.from)) return;
    const message = { ...original,from:callback.from };
    const data = callback.data || '';
    const acknowledge = (text) => this.telegram.call('answerCallbackQuery',{ callback_query_id:callback.id,text:formatReply(text) });
    if (data.startsWith('menu:')) {
      const [,ownerId,command] = data.split(':');
      if (Number(ownerId) !== callback.from.id) return acknowledge('это чужое меню открой своё через /menu');
      const key = `${message.chat.id}:${callback.from.id}`;
      if (Date.now() - (this.lastCommands.get(key) || 0) < 1500) return acknowledge('секунду');
      this.lastCommands.set(key,Date.now());
      await acknowledge('сейчас');
      return this.command(message,{ command,query:'' },this.store.isOwner(callback.from,this.config),true);
    }
    if (data.startsWith('wed:')) {
      const [,id,answer] = data.split(':');
      if (!['yes','no'].includes(answer)) return acknowledge('неизвестный ответ');
      const result = this.store.answerProposal(id,message.chat.id,callback.from.id,answer === 'yes');
      if (result.error) return acknowledge(result.error);
      await acknowledge(result.accepted ? 'зарегистрировано' : 'предложение отклонено');
      await this.telegram.call('editMessageReplyMarkup',{ chat_id:message.chat.id,message_id:message.message_id,reply_markup:{ inline_keyboard:[] } }).catch(() => {});
      return this.say(message,result.accepted ? `${this.store.label(message.chat.id,result.proposer)} и ${this.store.label(message.chat.id,result.target)} теперь в браке совет мёда желает совместного вайба` : 'предложение отклонено сюжет пошёл по другой ветке');
    }
    if (data.startsWith('div:')) {
      const [,ownerId,partnerId,since] = data.split(':').map(Number);
      if (ownerId !== callback.from.id) return acknowledge('чужой брак не трогаем');
      const result = this.store.divorce(message.chat.id,ownerId,partnerId,since);
      await acknowledge('готово');
      await this.telegram.call('editMessageReplyMarkup',{ chat_id:message.chat.id,message_id:message.message_id,reply_markup:{ inline_keyboard:[] } }).catch(() => {});
      return this.say(message,result);
    }
    return acknowledge('эта кнопка устарела');
  }
}
