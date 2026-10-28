// Prefer Node's built-in SQLite; standard hosting images may still use Node 20.
let native;
if (process.env.SQLITE_BACKEND !== 'better') {
  try { native = await import('node:sqlite'); }
  catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
}
let DatabaseSync = native?.DatabaseSync;
let backup = native?.backup;
if (!DatabaseSync) {
  const { default: Database } = await import('better-sqlite3');
  DatabaseSync = class extends Database {
    constructor(path, { readOnly = false } = {}) { super(path,{ readonly:readOnly }); }
  };
  backup = (database, target) => database.backup(target);
}
export { DatabaseSync, backup };
