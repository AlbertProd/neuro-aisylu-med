// Native Gemini generateContent transport. No API keys or provider-specific secrets enter prompts.
export function buildGeminiRequest(request,{mode = 'chat'} = {}) {
  const systems = request.messages.filter(m=>m.role==='system').map(m=>({text:m.content}));
  const parts = request.messages.filter(m=>m.role!=='system').flatMap(m=>{
    if (typeof m.content==='string') return [{text:m.content}];
    return m.content.map(part=>{
      if (part.type==='text') return {text:part.text};
      if (part.type==='input_audio') return {inlineData:{mimeType:part.input_audio.format==='mp3'?'audio/mpeg':`audio/${part.input_audio.format}`,data:part.input_audio.data}};
      if (part.type==='image_url') {
        const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/u.exec(part.image_url?.url || '');
        if (!match) throw new Error('gemini принимает только подготовленные изображения');
        return {inlineData:{mimeType:match[1],data:match[2]}};
      }
      throw new Error('неподдерживаемая часть медиа для gemini');
    });
  });
  if (mode==='search') systems.push({text:'Используй google_search только по текущему обращению. Достаточно одного узкого поиска. Не исследуй историю участников и не запускай дополнительные поиски ради полноты. Дай ссылки на использованные источники.'});
  const generationConfig = {maxOutputTokens:request.max_tokens,thinkingConfig:{thinkingLevel:'low'}};
  // Gemini 3.8 rejects temperature/topP/topK; variety comes from the rotating prompt and local selection.
  if (request.response_format?.type==='json_object') {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = {type:'object',properties:{answers:{type:'array',items:{type:'string'},minItems:2,maxItems:2}},required:['answers'],additionalProperties:false};
  }
  return {systemInstruction:{parts:systems},contents:[{role:'user',parts}],generationConfig,...(mode==='search'?{tools:[{googleSearch:{}}]}:{})};
}

export function geminiSources(candidate) {
  const sources = [];
  for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
    const web = chunk.web;
    if (!web?.uri) continue;
    try {
      const url = new URL(web.uri);
      if (url.protocol!=='https:' || url.username || url.password || sources.some(s=>s.url===url.href)) continue;
      sources.push({url:url.href,title:web.title || url.hostname});
    } catch {}
  }
  return sources.slice(0,3);
}

export function geminiUsage(data,config,{mode = 'chat',now = Date.now()} = {}) {
  const raw = data.usageMetadata;
  if (!raw) return undefined;
  const count = value=>Number.isSafeInteger(value) && value>=0 ? value : undefined;
  const prompt = count(raw.promptTokenCount);
  const total = count(raw.totalTokenCount);
  const output = count(raw.candidatesTokenCount ?? 0);
  const thoughts = count(raw.thoughtsTokenCount ?? 0);
  const cached = count(raw.cachedContentTokenCount ?? 0);
  const tool = count(raw.toolUsePromptTokenCount ?? 0);
  const usage = {total_tokens:total,prompt_tokens:prompt,completion_tokens:output,completion_tokens_details:{reasoning_tokens:thoughts},prompt_tokens_details:{cached_tokens:cached}};
  if ([prompt,total,output,thoughts,cached,tool].some(n=>n===undefined) || cached>prompt) return usage;
  if (config.model!=='gemini-3.8-flash') return usage;
  // Published introductory prices end on 2026-12-31. Do not silently undercount the announced 2027 rate.
  const factor = now>=Date.UTC(2027,0,1)?2:1;
  const input = Math.max(prompt+tool,total-output-thoughts);
  const queries = new Set((data.candidates?.[0]?.groundingMetadata?.webSearchQueries || []).filter(q=>typeof q==='string' && q.trim()).map(q=>q.trim()));
  // Charge estimates ignore free allowances/promotional credits so that the local limit remains conservative.
  const searchQueries = mode==='search'?Math.max(1,queries.size):0;
  const usd = ((input-cached)*0.75 + cached*0.075 + (output+thoughts)*3.75)*factor/1e6 + searchQueries*0.014;
  usage.cost_usd = usd;
  usage.cost_rub = Math.ceil(usd*config.geminiUsdToRub*config.geminiCostSafetyFactor*1e6)/1e6;
  usage.cost_estimated = true;
  usage.search_queries = searchQueries;
  return usage;
}

export function parseGeminiResponse(data,config,input) {
  const candidate = data.candidates?.[0];
  return {
    content:(candidate?.content?.parts || []).filter(p=>!p.thought && typeof p.text==='string').map(p=>p.text).join(''),
    sources:geminiSources(candidate),
    usage:geminiUsage(data,config,input),
    generationId:data.responseId,
  };
}
