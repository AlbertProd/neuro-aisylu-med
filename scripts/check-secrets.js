import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../',import.meta.url));
const git = (...args) => execFileSync('git',args,{cwd:root,windowsHide:true});
const files = git('ls-files','--stage','-z').toString('utf8').split('\0').filter(Boolean);
if (!files.length) throw new Error('нет файлов в индексе git для проверки');

const known = [process.env.TELEGRAM_BOT_TOKEN,process.env.POLZA_API_KEY].filter(value=>value && value.length >= 8);
const patterns = [
  /pza_[A-Za-z0-9_-]{20,}/u,
  /\b\d{6,14}:[A-Za-z0-9_-]{30,}/u,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{30,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/u,
];
const issues = [];
for (const entry of files) {
  const [meta,path] = entry.split('\t');
  if (!meta.startsWith('100644 ') && !meta.startsWith('100755 ')) { issues.push(`${path}: ссылка или вложенный репозиторий`);continue; }
  if (/(^|\/)(?:data|logs|node_modules|\.pnpm-store|deploy-artifacts|twst11)(\/|$)|(^|\/)\.env(?!\.example$)(\.|$)|\.(?:sqlite(?:-\w+)?|db(?:-\w+)?|log|pid|pem|key|zip|tar\.gz)$/iu.test(path)) issues.push(`${path}: локальный или закрытый файл`);
  const body = git('show',`:${path}`);
  if (known.some(secret=>body.includes(Buffer.from(secret))) || patterns.some(pattern=>pattern.test(body.toString('utf8')))) issues.push(`${path}: обнаружен секрет`);
}
if (issues.length) { console.error(issues.join('\n'));process.exitCode = 1; }
else console.log(`проверено ${files.length} файлов индекса git ключей и закрытых файлов не найдено`);
