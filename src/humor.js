import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { formatReply } from './style.js';

export const LEXICON = JSON.parse(readFileSync(new URL('../content/lexicon.json',import.meta.url),'utf8'));
export const PROFANITY = [
  { id:'eb',pattern:/^(?:(?:за|вы|про|по|до|под|раз|от|с|об|у|на|пере|при)?[её]б|[её]пт|долбо[её]б)/u,words:'ебать ебанутый заебись ебучий наебал поебень' },
  { id:'pizd',pattern:/^(?:(?:за|рас|про|от|на|под)?пизд)/u,words:'пиздец пиздёж пиздануть пиздатый распиздяй' },
  { id:'khuy',pattern:/^(?:(?:на|по|до|ни|не|за|о|а|от|раз|под)?ху[йеяюи]|хер)/u,words:'охуеть похуй хуйня хуёвый охуенный нахуй' },
  { id:'suka',pattern:/^(?:сук[аиоуе]|суч)/u,words:'сука сучий сучара' },
  { id:'govno',pattern:/^(?:говн|дерьм|обосра|засра|просра|сра[лт])/u,words:'говно говнище дерьмо обосраться просрать' },
  { id:'zhopa',pattern:/^(?:жоп|задниц)/u,words:'жопа жопный задница' },
  { id:'blya',pattern:/^бля(?:д|т|х|$)/u,words:'бля блядь блять' },
];

const tokens = text => String(text || '').toLowerCase().replaceAll('ё','е').match(/[\p{L}\p{N}]+/gu) || [];
const stem = word => word.slice(0,5);
const STOP = new Set(tokens('только когда чтобы потому сейчас вообще просто хотя такой такая какие какой этого здесь почему очень опять тебя тебе меня тебе твоя твой моих своих будет есть была были было который которые').map(stem));
export const profanityFamilies = text => new Set(tokens(text).flatMap(word => PROFANITY.filter(f => f.pattern.test(word)).map(f => f.id)));
const ownReplies = ({ history = [],botId }) => botId == null ? [] : history.filter(m => String(m.user_id) === String(botId)).slice(-10).map(m => String(m.text || ''));
const meaningful = text => tokens(text).filter(w => w.length >= 4 && !STOP.has(stem(w)) && !profanityFamilies(w).size).map(stem);

export function variationState(input) {
  const recent = ownReplies(input);
  const used = new Set(recent.slice(-4).flatMap(t => [...profanityFamilies(t)]));
  if (recent.slice(-8).some(t => profanityFamilies(t).has('blya'))) used.add('blya');
  const current = new Set(meaningful(input.query));
  const counts = new Map();
  for (const text of recent.slice(-8)) for (const word of new Set(meaningful(text))) counts.set(word,(counts.get(word) || 0) + 1);
  const stale = [...counts].filter(([word,n]) => n >= 2 && !current.has(word)).sort((a,b) => b[1]-a[1]).slice(0,8).map(([word]) => word);
  return { recent,used,current,stale };
}

export function variationGuide(input,pick = randomInt) {
  const state = variationState(input);
  const available = PROFANITY.filter(f => !state.used.has(f.id));
  const family = available.length ? available[pick(available.length)] : null;
  const query = String(input.query || '').toLowerCase();
  const groups = Object.entries(LEXICON).filter(([key,g]) => key !== 'construction' && key !== 'absurd' && g.match && new RegExp(g.match,'iu').test(query));
  const pool = (groups.length ? groups : [['reactions',LEXICON.reactions]]).flatMap(([,g]) => g.words);
  const old = state.recent.join(' ').toLowerCase();
  const sample = (list,n) => {
    const choices = list.filter(([word]) => !old.includes(word));
    const selected = [];
    while (choices.length && selected.length < n) selected.push(choices.splice(pick(choices.length),1)[0]);
    return selected;
  };
  const words = [...sample(pool,2),...sample(pick(4) === 0 ? LEXICON.absurd.words : LEXICON.construction.words,1)];
  return `Вариативность: ${family ? `если нужен мат доступно новое семейство: ${family.words}` : 'мат недавно повторялся можно обойтись без него'}. Не вставляй ругань как запятую и не приклеивай матерное прилагательное к случайному существительному ради мата. Не повторяй недавние семейства: ${PROFANITY.filter(f => state.used.has(f.id)).map(f => f.words.split(' ')[0]).join(' ') || 'нет'}. ${state.stale.length ? `Уже заезженные корни образов: ${state.stale.join(' ')}. Смени образ если он не нужен новому вопросу. ` : ''}Необязательная палитра ${JSON.stringify(words)}: возьми максимум одно выражение только если подходит или придумай своё. Это не готовые ответы.`;
}

export const DELIVERIES = [
  'сухая короткая ответка с неожиданным последним словом',
  'один нелепо конкретный бытовой образ',
  'самоирония или переворот предъявы на себя',
  'невозмутимое преувеличение масштаба мелочи',
  'мрачный вымышленный абсурд про ситуацию',
  'неожиданная аналогия из совсем другой области без лекции',
  'короткая пародия на объявление или официальную формулировку',
  'буквальное прочтение фразы с неожиданным результатом',
  'язвительное наблюдение об одной детали текущей реплики',
  'абсурдный мини сюжет из одного предложения',
  'условие «только когда» с нелепым конкретным препятствием вместо прямого отказа',
  'столкни пафос текущей реплики с мелкой прозаичной деталью',
  'новая нелепая составная фраза из двух далёких областей с понятным смыслом',
  'спокойный комплимент с неожиданным язвительным хвостом',
  'короткое вымышленное название товара или услуги по текущей ситуации',
  'дружеская матерная нежность вместо нападения',
  'переверни ожидание в последних двух словах',
  'притворное согласие с нелепым практическим последствием',
  'самоироничная капитуляция вместо соревнования в оскорблениях',
  'одно точное наблюдение без метафоры и без вопроса в конце',
];

export function nextDelivery(store, chatId, pick = randomInt) {
  let recent;
  try { recent = JSON.parse(store.get(`delivery:${chatId}`) || '[]'); } catch { recent = []; }
  if (!Array.isArray(recent)) recent = [];
  const choices = DELIVERIES.map((_,i) => i).filter(i => !recent.slice(-5).includes(i));
  const index = choices[pick(choices.length)];
  store.set(`delivery:${chatId}`,JSON.stringify([...recent.slice(-4),index]));
  return DELIVERIES[index];
}

export function candidatePenalty(text,input) {
  const { recent,used,current,stale } = variationState(input);
  const words = tokens(text);
  const normalized = words.join(' ');
  let penalty = 0;
  for (const id of profanityFamilies(text)) if (used.has(id)) penalty += id === 'blya' ? 60 : 15;
  for (const word of new Set(meaningful(text))) if (stale.includes(word) && !current.has(word)) penalty += 10;
  for (const old of recent) {
    const previous = tokens(old);
    if (normalized === previous.join(' ')) penalty += 1000;
    if (words.length >= 3 && words.slice(0,3).join(' ') === previous.slice(0,3).join(' ')) penalty += 35;
    for (let i = 0;i <= words.length-4;i++) if (previous.join(' ').includes(words.slice(i,i+4).join(' '))) penalty += 20;
  }
  const families = tokens(text).flatMap(w => [...profanityFamilies(w)]);
  penalty += (families.length - new Set(families).size) * 20;
  return penalty;
}

// Both alternatives come from one completion; selecting locally never calls the model again.
export function selectReply(content,input,wordLimit) {
  let answers;
  const raw = String(content).trim().replace(/^```(?:json)?\s*|\s*```$/gu,'');
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.answers) || !parsed.answers.length || parsed.answers.length > 2 || parsed.answers.some(a => typeof a !== 'string' || !a.trim())) throw new Error('неверный формат вариантов ответа');
    answers = parsed.answers;
  } else answers = [raw]; // Plain-text completions remain compatible with other providers.
  const state = variationState(input);
  const previous = new Set(state.recent.map(t => tokens(t).join(' ')));
  const candidates = answers.map(t => formatReply(t,wordLimit)).filter(t => !previous.has(tokens(t).join(' '))).map(t => {
    let words = t.split(' ');
    // Remove only a repeated filler inside a longer sentence, never meaningful verbs/adjectives.
    if (state.used.has('blya') && words.length >= 5) words = words.filter((w,i) => !['бля','блядь','блять','блеать'].includes(w) || i === words.length-1);
    return formatReply(words.join(' '),wordLimit);
  }).filter(t => !previous.has(tokens(t).join(' ')));
  if (!candidates.length) {
    const fallbacks = ['этот панч уже был я требую новый сценарий','всё пластинку зажевало включаю другую сторону','так мой внутренний попугай уволен'];
    return formatReply(fallbacks.find(t => !previous.has(tokens(t).join(' '))) || 'сменим пластинку',wordLimit);
  }
  candidates.sort((a,b) => candidatePenalty(a,input) - candidatePenalty(b,input));
  return candidates[0];
}
