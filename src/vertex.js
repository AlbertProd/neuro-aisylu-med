import { readFileSync } from 'node:fs';
import { createPrivateKey,sign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export function vertexCredentials(config) {
  let value;
  try {
    value = JSON.parse(config.vertexCredentialsBase64
      ? Buffer.from(config.vertexCredentialsBase64,'base64').toString('utf8')
      : readFileSync(config.vertexCredentialsPath,'utf8'));
    if (value.type!=='service_account' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value.project_id || '') || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(value.client_email || '') || typeof value.private_key!=='string') throw new Error();
    createPrivateKey(value.private_key);
  } catch { throw new Error('неверные учётные данные сервисного аккаунта vertex'); }
  return value;
}

export function vertexEndpoint(config,credentials) {
  const project = config.vertexProject || credentials.project_id;
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || !/^(?:global|[a-z]+-[a-z]+\d+)$/.test(config.vertexLocation)) throw new Error('неверный проект или регион vertex');
  const host = config.vertexLocation==='global'?'aiplatform.googleapis.com':`${config.vertexLocation}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${config.vertexLocation}/publishers/google/models/${encodeURIComponent(config.model)}:generateContent`;
}

export function vertexAssertion(credentials,now=Date.now()) {
  const iat = Math.floor(now/1000);
  const encode = data=>Buffer.from(JSON.stringify(data)).toString('base64url');
  const input = `${encode({alg:'RS256',typ:'JWT'})}.${encode({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/cloud-platform',aud:TOKEN_URL,iat,exp:iat+3600})}`;
  return `${input}.${sign('RSA-SHA256',Buffer.from(input),credentials.private_key).toString('base64url')}`;
}

export class VertexAuth {
  constructor(config,fetchImpl=fetch,now=Date.now) {
    this.credentials = vertexCredentials(config);
    this.endpoint = vertexEndpoint(config,this.credentials);
    this.fetch = fetchImpl;
    this.now = now;
  }
  async token() {
    if (this.cached && this.cached.expires>this.now()+60000) return this.cached.token;
    if (!this.pending) this.pending = this.refresh().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async refresh() {
    try {
      const response = await this.fetch(TOKEN_URL,{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:vertexAssertion(this.credentials,this.now())}),
        signal:AbortSignal.timeout(20000),redirect:'error',
      });
      if (!response.ok) throw new Error(`vertex oauth http ${response.status}`);
      const data = await response.json();
      if (typeof data.access_token!=='string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in<120) throw new Error('vertex oauth вернул неверный токен');
      this.cached = {token:data.access_token,expires:this.now()+Math.min(data.expires_in,3600)*1000};
      return data.access_token;
    } catch (cause) {
      // Authentication happens before generateContent. Never print OAuth responses/JWTs.
      const error = new Error(/^vertex oauth/.test(cause.message)?cause.message:'vertex oauth недоступен');
      error.definitelyUnbilled = true;
      throw error;
    }
  }
}
