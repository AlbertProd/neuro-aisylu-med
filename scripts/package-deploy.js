import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../',import.meta.url));
const directories = ['src','content','scripts','test','deploy'];
const sources = ['Dockerfile','.dockerignore','.env.example','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','bothost.json',...directories,'README.md','DEPLOY.md'];
const secrets = [process.env.TELEGRAM_BOT_TOKEN,process.env.POLZA_API_KEY].filter(Boolean);
function verify(relative) {
  const path = join(root,relative);
  const entries = readdirSync(path,{ withFileTypes:true });
  for (const entry of entries) {
    const next = join(relative,entry.name);
    if (entry.isSymbolicLink()) throw new Error(`ссылки не допускаются в архиве: ${next}`);
    if (entry.isDirectory()) verify(next);
    else verifyFile(next);
  }
}
function verifyFile(relative) {
  const body = readFileSync(join(root,relative));
  if (secrets.some(secret => body.includes(Buffer.from(secret)))) throw new Error(`в коде найден ключ: ${relative}`);
}
for (const source of sources) {
  if (directories.includes(source)) verify(source);
  else verifyFile(source);
}
mkdirSync(join(root,'deploy-artifacts'),{ recursive:true });
const result = spawnSync('tar',['-czf','deploy-artifacts/aisylu-deploy.tar.gz',...sources],{ cwd:root,windowsHide:true,encoding:'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || 'не удалось собрать архив');
console.log('готов deploy-artifacts/aisylu-deploy.tar.gz без ключей базы и журналов');
