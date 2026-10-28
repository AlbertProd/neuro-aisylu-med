import { DatabaseSync, backup } from '../src/sqlite.js';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = resolve(process.env.DATABASE_PATH || './data/aisylu.sqlite');
const target = resolve(process.argv[2] || './data/backups/aisylu.sqlite');
if (target === source) throw new Error('резервная копия должна быть отдельным файлом');
if (existsSync(target)) throw new Error('файл копии уже существует выбери другое имя');
mkdirSync(dirname(target), { recursive:true });
const db = new DatabaseSync(source, { readOnly:true });
try {
  await backup(db,target);
  console.log('готова согласованная резервная копия sqlite включая wal');
} finally { db.close(); }
