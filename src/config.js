import { resolve } from 'node:path';

export function getConfig(env = process.env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`не заполнено ${name} в .env`);
    return value;
  };
  const number = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`неверное значение ${name}`);
    return value;
  };
  const ownerId = env.OWNER_USER_ID ? number('OWNER_USER_ID', 0, 1, Number.MAX_SAFE_INTEGER) : null;
  if (ownerId && !Number.isSafeInteger(ownerId)) throw new Error('OWNER_USER_ID должен быть целым');
  const provider = env.AI_PROVIDER || (env.VERTEX_SERVICE_ACCOUNT_BASE64 || env.GOOGLE_APPLICATION_CREDENTIALS ? 'vertex' : env.GEMINI_API_KEY ? 'gemini' : 'polza');
  if (!['vertex','gemini','polza'].includes(provider)) throw new Error('AI_PROVIDER должен быть vertex gemini или polza');
  if (provider==='vertex' && !env.VERTEX_SERVICE_ACCOUNT_BASE64 && !env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('нужен VERTEX_SERVICE_ACCOUNT_BASE64 или GOOGLE_APPLICATION_CREDENTIALS');
  const searchProvider=env.SEARCH_PROVIDER || (provider==='vertex'?'tavily':'native');
  if (!['tavily','native'].includes(searchProvider) || (provider==='vertex' && searchProvider!=='tavily')) throw new Error('для vertex нужен SEARCH_PROVIDER=tavily');
  const baseUrl = provider==='gemini'?'https://generativelanguage.googleapis.com/v1beta':(env.POLZA_BASE_URL || 'https://polza.ai/api/v1').replace(/\/$/, '');
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('POLZA_BASE_URL должен использовать https');
  return {
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    provider,
    polzaKey: provider==='polza'?required('POLZA_API_KEY'):'',
    geminiKey: provider==='gemini'?required('GEMINI_API_KEY'):'',
    baseUrl,
    model: provider==='vertex'?(env.VERTEX_MODEL || 'gemini-3.8-flash'):provider==='gemini'?(env.GEMINI_MODEL || 'gemini-3.8-flash'):(env.POLZA_MODEL || 'google/gemini-3.8-flash'),
    vertexCredentialsBase64:provider==='vertex'?(env.VERTEX_SERVICE_ACCOUNT_BASE64 || ''):'',
    vertexCredentialsPath:provider==='vertex'?(env.GOOGLE_APPLICATION_CREDENTIALS || ''):'',
    vertexProject:env.GOOGLE_CLOUD_PROJECT || '',
    vertexLocation:env.GOOGLE_CLOUD_LOCATION || 'global',
    searchProvider,
    tavilyKey:env.TAVILY_API_KEY || '',
    searchMonthlyCredits:number('SEARCH_MONTHLY_CREDITS',990,0,990),
    searchCacheMs:number('SEARCH_CACHE_MINUTES',15,0,60)*60000,
    geminiUsdToRub:number('GEMINI_USD_TO_RUB',100,1,10000),
    geminiCostSafetyFactor:number('GEMINI_COST_SAFETY_FACTOR',1.15,1,10),
    ownerUsername: (env.OWNER_USERNAME || 'Al_stonck').replace(/^@/, '').toLowerCase(),
    ownerId,
    databasePath: resolve(env.DATABASE_PATH || './data/aisylu.sqlite'),
    aiTimeoutMs: number('AI_TIMEOUT_MS', 90000, 1000, 180000),
    userCooldown: number('USER_COOLDOWN_SECONDS', 4, 0, 300) * 1000,
    chatPerMinute: number('CHAT_AI_PER_MINUTE', 10, 1, 20),
    globalPerHour: number('GLOBAL_AI_PER_HOUR', 120, 1, 10000),
    dailyBudgetRub: number('DAILY_BUDGET_RUB', 100, 0.01, 100000),
    expensivePerDay: number('EXPENSIVE_REQUESTS_PER_DAY', 10, 0, 10000),
    expensivePerUserDay: number('EXPENSIVE_REQUESTS_PER_USER_DAY', 3, 0, 10000),
    textReserveRub: number('TEXT_REQUEST_RESERVE_RUB', 1.5, 0.01, 1000),
    searchReserveRub: number('SEARCH_REQUEST_RESERVE_RUB', 4, 0.01, 1000),
    mediaReserveRub: number('MEDIA_REQUEST_RESERVE_RUB', 3, 0.01, 1000),
    maxOutputTokens: number('AI_MAX_OUTPUT_TOKENS', 2048, 512, 8192),
    maxPromptPrice: number('MAX_PROMPT_PRICE_PER_MILLION', 60, 0.01, 100000),
    maxCompletionPrice: number('MAX_COMPLETION_PRICE_PER_MILLION', 300, 0.01, 100000),
    maxAudioPrice: number('MAX_AUDIO_PRICE_PER_MILLION', 60, 0.01, 100000),
    ambientProbability: number('AMBIENT_PROBABILITY', 0.03, 0, 1),
    ambientCooldown: number('AMBIENT_COOLDOWN_SECONDS', 900, 60, 86400) * 1000,
  };
}

export function safeError(error, config = {}) {
  let message = error instanceof Error ? error.message : String(error);
  if (error?.cause?.code) message += ` (${error.cause.code})`;
  for (const secret of [config.telegramToken, config.polzaKey,config.geminiKey,config.vertexCredentialsBase64,config.tavilyKey].filter(Boolean).sort((a,b)=>b.length-a.length)) {
    if (secret) message = message.replaceAll(secret, '[secret]');
  }
  return message.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[secret]').replace(/bot\d+:[\w-]+/g, 'bot[secret]').replace(/pza_[\w-]+/g, '[secret]').replace(/AIza[\w-]{20,}/g,'[secret]').replace(/(?:tvly-[\w-]+|ya29\.[\w.-]+)/g,'[secret]').slice(0, 500);
}
