// Import today's existing charges without reading conversation content.
import { getConfig,safeError } from '../src/config.js';
import { Store } from '../src/store.js';
import { localDay } from '../src/style.js';

const config = getConfig();
const store = new Store(config.databasePath);
try {
  const day = localDay();
  const dateFrom = new Date(`${day}T00:00:00+05:00`).toISOString();
  let pages = 1;
  for (let page = 1;page <= pages;page++) {
    const params = new URLSearchParams({ dateFrom,limit:'100',page:String(page),status:'completed' });
    const response = await fetch(`${config.baseUrl}/history/generations?${params}`,{ headers:{ Authorization:`Bearer ${config.polzaKey}` },signal:AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`polza история http ${response.status}`);
    const data = await response.json();
    pages = Math.min(data.meta?.totalPages || 1,100);
    for (const generation of data.items || []) store.importSpending(generation);
  }
  console.log(JSON.stringify({ day,...store.spending(day) }));
} catch (error) { console.error(safeError(error,config));process.exitCode = 1; }
finally { store.close(); }
