// One common boundary for generated text, menus, errors and callback notices.
export function formatReply(input, maxWords = 40) {
  const text = String(input || '')
    .replace(/https?:\/\/[^\s<>]+/giu, '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .toLocaleLowerCase('ru-RU')
    .replace(/[`*#<>«»“”"\[\]{}():;,!?…—–]/gu, ' ')
    .replace(/\.(?!\d)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.split(/\s+/u).filter(Boolean).slice(0, maxWords).join(' ') || 'мозг уехал за чак чаком попробуй ещё раз';
}

export function userLabel(user) {
  return user.username ? `@${user.username.toLowerCase()}` : String(user.first_name || 'анон').replace(/\s+/g, ' ').slice(0, 32);
}

export function localDay(time = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
}
