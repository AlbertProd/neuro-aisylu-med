import { DatabaseSync } from './sqlite.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { localDay, userLabel } from './style.js';
import { MOODS, nextMood } from './moods.js';

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, title TEXT NOT NULL, ambient INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (
        chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, user_id INTEGER,
        label TEXT NOT NULL, text TEXT NOT NULL, date INTEGER NOT NULL, topic INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS members (
        chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, label TEXT NOT NULL,
        messages INTEGER DEFAULT 0, reputation INTEGER DEFAULT 0, honey INTEGER DEFAULT 0,
        last_daily TEXT, PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS moods (chat_id INTEGER PRIMARY KEY, mood_id INTEGER NOT NULL, remaining INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, proposer INTEGER NOT NULL, target INTEGER NOT NULL,
        expires INTEGER NOT NULL, status TEXT DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS spouses (
        chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, partner INTEGER NOT NULL, since INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS votes (
        chat_id INTEGER NOT NULL, voter INTEGER NOT NULL, target INTEGER NOT NULL, day TEXT NOT NULL,
        PRIMARY KEY (chat_id, voter, target, day)
      );
      CREATE TABLE IF NOT EXISTS usage (at INTEGER NOT NULL, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
      CREATE TABLE IF NOT EXISTS spending (
        id TEXT PRIMARY KEY, generation_id TEXT UNIQUE, chat_id INTEGER, user_id INTEGER,
        kind TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL,
        reserved REAL NOT NULL, actual REAL, state TEXT NOT NULL,
        tokens INTEGER, reasoning_tokens INTEGER, cached_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS spending_day ON spending(day);
    `);
  }

  close() { this.db.close(); }
  get(key) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, String(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  isOwner(user, config) {
    if (!user || user.is_bot) return false;
    const pinned = Number(this.get('owner_id')) || null;
    if (config.ownerId) return user.id === config.ownerId;
    if (pinned) return user.id === pinned;
    if (user.username?.toLowerCase() !== config.ownerUsername) return false;
    this.set('owner_id', user.id);
    return true;
  }

  bindChat(chat) { this.db.prepare('INSERT INTO chats (id,title) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title').run(chat.id, chat.title || 'mёd'); }
  chat(id) { return this.db.prepare('SELECT * FROM chats WHERE id=?').get(id); }
  unbindChat(id) {
    this.transaction(() => {
      for (const table of ['messages','members','moods','proposals','spouses','votes','usage']) this.db.prepare(`DELETE FROM ${table} WHERE chat_id=?`).run(id);
      this.db.prepare('DELETE FROM chats WHERE id=?').run(id);
    });
  }
  setAmbient(id, enabled) { this.db.prepare('UPDATE chats SET ambient=? WHERE id=?').run(Number(enabled), id); }

  record(message, { count = true } = {}) {
    const user = message.from || { id: 0, first_name: 'системное' };
    const label = userLabel(user);
    const text = (message.text || message.caption || '').slice(0, 6000) || mediaLabel(message);
    const exists = this.db.prepare('SELECT 1 FROM messages WHERE chat_id=? AND message_id=?').get(message.chat.id, message.message_id);
    this.db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_id,message_id)
      DO UPDATE SET text=excluded.text, label=excluded.label`).run(message.chat.id, message.message_id, user.id, label, text, message.date || Math.floor(Date.now()/1000), message.message_thread_id || 0);
    this.db.prepare(`DELETE FROM messages WHERE chat_id=? AND message_id NOT IN
      (SELECT message_id FROM messages WHERE chat_id=? ORDER BY message_id DESC LIMIT 50)`).run(message.chat.id, message.chat.id);
    if (!user.is_bot && user.id && count && !exists) {
      this.db.prepare(`INSERT INTO members (chat_id,user_id,label,messages) VALUES (?,?,?,1)
        ON CONFLICT(chat_id,user_id) DO UPDATE SET label=excluded.label,messages=messages+1`).run(message.chat.id, user.id, label);
    }
  }

  annotate(chatId, messageId, note) {
    this.db.prepare("UPDATE messages SET text=substr(text || char(10) || ?,1,6500) WHERE chat_id=? AND message_id=?").run(note, chatId, messageId);
  }
  history(chatId, before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT * FROM messages WHERE chat_id=? AND message_id<? ORDER BY message_id DESC LIMIT 50').all(chatId, before).reverse();
  }
  forget(chatId) { this.db.prepare('DELETE FROM messages WHERE chat_id=?').run(chatId); }
  member(chatId, userId) { return this.db.prepare('SELECT * FROM members WHERE chat_id=? AND user_id=?').get(chatId, userId); }
  label(chatId, userId) { return this.member(chatId, userId)?.label || `участник ${userId}`; }
  top(chatId) { return this.db.prepare('SELECT * FROM members WHERE chat_id=? ORDER BY reputation DESC,honey DESC,messages DESC LIMIT 5').all(chatId); }

  mood(chatId, consume = false) {
    let row = this.db.prepare('SELECT * FROM moods WHERE chat_id=?').get(chatId);
    if (!row || row.remaining <= 0) {
      const mood = nextMood(row?.mood_id);
      row = { mood_id: mood.id, remaining: mood.remaining };
      this.db.prepare('INSERT OR REPLACE INTO moods VALUES (?,?,?)').run(chatId, row.mood_id, row.remaining);
    }
    if (consume) this.db.prepare('UPDATE moods SET remaining=remaining-1 WHERE chat_id=?').run(chatId);
    return { ...MOODS[row.mood_id], remaining: row.remaining };
  }

  daily(chatId, userId, now = Date.now()) {
    const day = localDay(now);
    const member = this.member(chatId, userId);
    if (!member) return { error: 'сначала напиши что нибудь в чат' };
    if (member.last_daily === day) return { error: 'сегодня мёд уже забран приходи после полуночи по уфе' };
    const amount = randomInt(5, 26);
    this.db.prepare('UPDATE members SET honey=honey+?,last_daily=? WHERE chat_id=? AND user_id=?').run(amount, day, chatId, userId);
    return { amount, total: member.honey + amount };
  }

  reputation(chatId, voter, target, value, now = Date.now()) {
    if (voter === target) return 'себе репу не крутим нарциссометр дымится';
    if (!this.member(chatId, target)) return 'этого человека пока нет в моей статистике';
    const day = localDay(now);
    return this.transaction(() => {
      const result = this.db.prepare('INSERT OR IGNORE INTO votes VALUES (?,?,?,?)').run(chatId, voter, target, day);
      if (!result.changes) return 'этому человеку ты уже менял репутацию сегодня';
      this.db.prepare('UPDATE members SET reputation=reputation+? WHERE chat_id=? AND user_id=?').run(value > 0 ? 1 : -1, chatId, target);
      return `${this.label(chatId, target)} репутация ${this.member(chatId, target).reputation} совет мёда постановил`;
    });
  }

  spouse(chatId, userId) { return this.db.prepare('SELECT * FROM spouses WHERE chat_id=? AND user_id=?').get(chatId, userId); }
  propose(chatId, proposer, target, now = Date.now()) {
    if (proposer === target) return { error: 'с собой брак не оформляю купи себе чак чак' };
    if (this.spouse(chatId, proposer) || this.spouse(chatId, target)) return { error: 'кто то уже в браке сначала разберитесь с текущим сезоном' };
    this.db.prepare("DELETE FROM proposals WHERE expires<? OR status!='pending'").run(now);
    const existing = this.db.prepare("SELECT id FROM proposals WHERE chat_id=? AND proposer=? AND target=? AND status='pending'").get(chatId, proposer, target);
    if (existing) return { error: 'предложение уже отправлено подожди ответа' };
    const id = randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO proposals (id,chat_id,proposer,target,expires) VALUES (?,?,?,?,?)').run(id, chatId, proposer, target, now + 600000);
    return { id };
  }

  answerProposal(id, chatId, userId, accept, now = Date.now()) {
    return this.transaction(() => {
      const p = this.db.prepare('SELECT * FROM proposals WHERE id=? AND chat_id=?').get(id, chatId);
      if (!p || p.status !== 'pending' || p.expires < now) return { error: 'предложение уже закрыто или протухло' };
      if (userId !== p.target) return { error: 'это предложение другому человеку не лезь в загс' };
      if (accept && (this.spouse(chatId, p.proposer) || this.spouse(chatId, p.target))) return { error: 'кто то уже успел вступить в другой брак' };
      this.db.prepare('UPDATE proposals SET status=? WHERE id=?').run(accept ? 'accepted' : 'declined', id);
      if (accept) {
        this.db.prepare('INSERT INTO spouses VALUES (?,?,?,?),(?,?,?,?)').run(chatId,p.proposer,p.target,now,chatId,p.target,p.proposer,now);
        this.db.prepare("UPDATE proposals SET status='closed' WHERE chat_id=? AND status='pending' AND (proposer IN (?,?) OR target IN (?,?))").run(chatId,p.proposer,p.target,p.proposer,p.target);
      }
      return { ...p, accepted: accept };
    });
  }

  divorce(chatId, userId, expectedPartner, expectedSince) {
    return this.transaction(() => {
      const spouse = this.spouse(chatId, userId);
      if (!spouse || spouse.partner !== expectedPartner || spouse.since !== expectedSince) return 'этот брак уже закончился кнопка устарела';
      this.db.prepare('DELETE FROM spouses WHERE chat_id=? AND user_id IN (?,?)').run(chatId, userId, spouse.partner);
      return 'развод оформлен мёд пополам мемы по очереди';
    });
  }
  couples(chatId) { return this.db.prepare('SELECT * FROM spouses WHERE chat_id=? AND user_id<partner ORDER BY since DESC LIMIT 5').all(chatId); }

  reserveAI(chatId, userId, config, now = Date.now()) {
    // The reservation is persisted before the request; restarts cannot reset cost limits.
    return this.transaction(() => {
      this.db.prepare('DELETE FROM usage WHERE at<?').run(now - 3600000);
      const global = this.db.prepare('SELECT count(*) AS n FROM usage').get().n;
      const chat = this.db.prepare('SELECT count(*) AS n FROM usage WHERE chat_id=? AND at>?').get(chatId, now - 60000).n;
      const last = this.db.prepare('SELECT max(at) AS at FROM usage WHERE chat_id=? AND user_id=?').get(chatId, userId).at;
      if (last != null && now - last < config.userCooldown) return 'дай мне пару секунд я одна а вас целая диссертация';
      if (global >= config.globalPerHour) return 'часовой лимит мыслей закончился скоро вернусь';
      if (chat >= config.chatPerMinute) return 'слишком много вопросов за минуту дайте мозгу остыть';
      this.db.prepare('INSERT INTO usage VALUES (?,?,?)').run(now, chatId, userId);
      return null;
    });
  }

  spending(day = localDay()) {
    const row = this.db.prepare(`SELECT COALESCE(sum(CASE WHEN state='reported' THEN actual ELSE 0 END),0) AS actual,
      COALESCE(sum(CASE WHEN state IN ('reserved','uncertain') THEN reserved ELSE 0 END),0) AS held,
      sum(CASE WHEN kind IN ('search','media') AND state!='cancelled' THEN 1 ELSE 0 END) AS expensive,
      count(*) AS requests FROM spending WHERE day=?`).get(day);
    return { ...row,expensive:row.expensive || 0,total:row.actual+row.held };
  }

  reserveSpending(chatId,userId,kind,config,now = Date.now()) {
    return this.transaction(() => {
      const day = localDay(now);
      const totals = this.spending(day);
      const reserved = kind === 'search' ? config.searchReserveRub : kind === 'media' ? config.mediaReserveRub : config.textReserveRub;
      if (kind !== 'text') {
        if (totals.expensive >= config.expensivePerDay) return { error:'дневной лимит поиска и медиа закончился обычный разговор ещё доступен' };
        const own = this.db.prepare("SELECT count(*) AS n FROM spending WHERE day=? AND user_id=? AND kind IN ('search','media') AND state!='cancelled'").get(day,userId).n;
        if (own >= config.expensivePerUserDay) return { error:'твой дневной лимит поиска и медиа закончился поболтаем без них' };
      }
      if (totals.total + reserved > config.dailyBudgetRub + 0.000001) return { error:'дневной бюджет почти исчерпан на этот запрос резерва не хватает игры и меню работают' };
      const id = randomUUID();
      this.db.prepare('INSERT INTO spending (id,chat_id,user_id,kind,day,at,reserved,state) VALUES (?,?,?,?,?,?,?,?)').run(id,chatId,userId,kind,day,now,reserved,'reserved');
      return { id,reserved };
    });
  }

  settleSpending(id,usage,generationId) {
    const value = usage?.cost_rub ?? usage?.cost;
    const actual = value == null || value === '' ? NaN : Number(value);
    const known = Number.isFinite(actual) && actual >= 0;
    this.db.prepare('UPDATE spending SET actual=?,state=?,generation_id=?,tokens=?,reasoning_tokens=?,cached_tokens=? WHERE id=?').run(
      known ? actual : null,known ? 'reported' : 'uncertain',generationId || null,usage?.total_tokens ?? null,
      usage?.completion_tokens_details?.reasoning_tokens ?? null,usage?.prompt_tokens_details?.cached_tokens ?? null,id,
    );
  }

  cancelSpending(id) { this.db.prepare("UPDATE spending SET actual=0,state='cancelled' WHERE id=? AND state='reserved'").run(id); }

  importSpending(generation) {
    const actual = Number(generation.cost);
    const at = Date.parse(generation.createdAt);
    if (!generation.id || !Number.isFinite(actual) || actual < 0 || !Number.isFinite(at)) return;
    this.db.prepare(`INSERT OR IGNORE INTO spending (id,generation_id,kind,day,at,reserved,actual,state,tokens,reasoning_tokens,cached_tokens)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`import:${generation.id}`,generation.id,'import',localDay(at),at,actual,actual,'reported',generation.usage?.total_tokens ?? null,
      generation.usage?.completion_tokens_details?.reasoning_tokens ?? null,generation.usage?.prompt_tokens_details?.cached_tokens ?? null);
  }
}

export function mediaLabel(message) {
  if (message.voice || message.audio) return '[аудио ещё не прослушано]';
  if (message.video || message.video_note || message.animation) return '[видео ещё не просмотрено]';
  if (message.photo) return '[фото ещё не просмотрено]';
  if (message.sticker) return `[стикер ${message.sticker.emoji || ''}]`;
  if (message.document) return '[файл не прочитан]';
  return '[нет текста]';
}
