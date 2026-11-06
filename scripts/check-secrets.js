import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../',import.meta.url));
const git = (...args) => execFileSync('git',args,{cwd:root,windowsHide:true});
const files = git('ls-files','--stage','-z').toString('utf8').split('\0').filter(Boolean);
if (!files.length) throw new Error('нет файлов в индексе git для проверки');

const known = [process.env.TELEGRAM_BOT_TOKEN,process.env.POLZA_API_KEY,process.env.GEMINI_API_KEY,process.env.TAVILY_API_KEY,process.env.VERTEX_SERVICE_ACCOUNT_BASE64].filter(value=>value && value.length >= 8);
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const raw=readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8');
  const credentials=JSON.parse(raw);
  known.push(Buffer.from(raw).toString('base64'),credentials.private_key);
}
const patterns = [
  /AIza[A-Za-z0-9_-]{20,}/u,
  /tvly-[A-Za-z0-9_-]{20,}/u,
  /"(?:private_key|type)"\s*:\s*"(?:-----BEGIN|service_account)/u,
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
