// Sites Worker ESM entry. DB and BUCKET are native D1/R2 bindings.
// CAPTURE_SERVICE_URL and CAPTURE_SERVICE_TOKEN are server-only runtime values.
import { localQueue, paired } from './local-queue.mjs';
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const idPattern = /^[a-f0-9-]{36}$/;
export function publicHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || !host.includes('.') && !host.startsWith('[') || /\.(localhost|local|internal|home|lan)$/.test(host)) return false;
  if (host.startsWith('[')) return /^\[[23][0-9a-f]{3}:/.test(host) && !host.includes(':ffff:');
  if (/^[0-9.]+$/.test(host)) { const parts = host.split('.').map(Number); return parts.length === 4 && parts.every(part => part >= 0 && part <= 255) && ![0,10,127].includes(parts[0]) && !(parts[0] === 169 && parts[1] === 254) && !(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) && !(parts[0] === 192 && parts[1] === 168) && !(parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) && parts[0] < 224; }
  return true;
}
function configuration(env) {
  try { const url = new URL(env.CAPTURE_SERVICE_URL); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !env.CAPTURE_SERVICE_TOKEN) return null; return url.href.replace(/\/$/, ''); } catch { return null; }
}
export function validateSite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('A site object is required');
  if (Object.keys(value).some(key => !['url', 'device', 'researchFocus', 'allowedOrigins'].includes(key))) throw Error('Unsupported site field');
  const url = new URL(value.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use an HTTP(S) URL without credentials');
  if (!publicHostname(url.hostname)) throw Error('Only public website targets are supported');
  if (!['desktop', 'tablet', 'mobile'].includes(value.device || 'desktop')) throw Error('Unknown device');
  if (value.researchFocus !== undefined && (typeof value.researchFocus !== 'string' || value.researchFocus.length > 2000)) throw Error('Research focus must be text up to 2000 characters');
  const allowedOrigins = value.allowedOrigins ?? [url.origin];
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.length > 30 || !allowedOrigins.includes(url.origin)) throw Error('Invalid navigation scope');
  for (const origin of allowedOrigins) { const parsed = new URL(origin); if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol) || !publicHostname(parsed.hostname)) throw Error('Invalid navigation origin'); }
  return { url: url.href, device: value.device || 'desktop', researchFocus: value.researchFocus?.trim() || 'Discover and explore booking journeys', allowedOrigins: [...new Set(allowedOrigins)] };
}
async function body(request, limit = 65536) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw Error('Send application/json');
  const length = Number(request.headers.get('content-length')); if (length > limit) throw Error('Input too large');
  const reader = request.body?.getReader(); if (!reader) throw Error('Input required'); const chunks = []; let size = 0;
  while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) { await reader.cancel(); throw Error('Input too large'); } chunks.push(chunk.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return JSON.parse(new TextDecoder().decode(bytes));
}
const siteRecord = row => row ? JSON.parse(row.record_json) : null;
async function saveSite(env, owner, input) {
  const old = await env.DB.prepare('SELECT record_json FROM research_sites WHERE owner_id = ? AND url = ?').bind(owner, input.url).first();
  const site = { ...(siteRecord(old) || { id: crypto.randomUUID(), addedAt: new Date().toISOString() }), ...input, removedAt: null };
  await env.DB.prepare('INSERT INTO research_sites (id, owner_id, url, record_json, removed_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(owner_id,url) DO UPDATE SET record_json=excluded.record_json, removed_at=NULL').bind(site.id, owner, site.url, JSON.stringify(site)).run();
  return site;
}
async function saveJob(env, owner, job) {
  const activeOwner = ['queued','running','dispatch-unknown'].includes(job.status) ? owner : null;
  await env.DB.prepare('INSERT INTO research_jobs (id, owner_id, site_id, active_owner, record_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json, active_owner=excluded.active_owner').bind(job.id, owner, job.siteId, activeOwner, JSON.stringify(job)).run();
}
async function service(env, route, init = {}, fetchImpl) {
  const base = configuration(env); if (!base) throw Error('Capture service is not configured');
  const response = await fetchImpl(base + route, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.CAPTURE_SERVICE_TOKEN, ...init.headers } });
  if (!response.ok) { const error = Error('Capture service rejected the request'); error.status = response.status; throw error; }
  return response;
}
export function createHostedHandler({ fetchImpl = fetch } = {}) {
  return async function handler(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/bridge/')) {
      if (!env.DB || !env.BUCKET) return json({error:'Research storage is not configured'},503);
      try { return await localQueue(request,env,body); } catch { return json({error:'Recorder transport request failed'},400); }
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS?.fetch ? env.ASSETS.fetch(request) : new Response('Research assets are not configured', { status: 404 });
    // These headers are trusted only behind Sites' authenticated dispatch.
    const owner = request.headers.get('oai-authenticated-user-id');
    if (!owner && request.method === 'GET' && url.pathname === '/api/status') return json({mode:'hosted',captureAvailable:false,modelConfigured:false,busy:false,model:null,requiresSignIn:true,message:'Public research review is available. Sign in to manage your websites and recordings.'});
    if (!owner) return json({ error: 'Sign in to access this research' }, 401);
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== url.origin) return json({ error: 'Same-origin request required' }, 403);
    if (!env.DB || !env.BUCKET) return json({ error: 'Research storage is not configured' }, 503);
    try {
      if (request.method === 'GET' && url.pathname === '/api/status') {
        if (paired(env) && owner === env.LOCAL_RECORDER_OWNER) return json({mode:'hosted',captureAvailable:true,modelConfigured:false,busy:false,model:null,transport:'local',connection:'unverified',message:'Captures queue for the paired local recorder. It must be running with a configured model.'});
        if (!configuration(env)) return json({ mode: 'hosted', captureAvailable: false, modelConfigured: false, busy: false, model: null, message: 'Hosted capture service is not configured' });
        try { const state = await (await service(env, '/v1/status', {}, fetchImpl)).json(); return json({ mode: 'hosted', captureAvailable: state.captureAvailable === true, modelConfigured: state.modelConfigured === true, busy: state.busy === true, model: typeof state.model === 'string' ? state.model : null }); }
        catch { return json({ mode: 'hosted', captureAvailable: false, modelConfigured: false, busy: false, model: null, message: 'Hosted capture service is unavailable' }); }
      }
      if (url.pathname === '/api/config') return json({ error: 'Hosted credentials are managed by the service owner' }, 405);
      if (request.method === 'GET' && url.pathname === '/api/sites') {
        const rows = await env.DB.prepare('SELECT record_json FROM research_sites WHERE owner_id = ? AND removed_at IS NULL').bind(owner).all(); return json({ sites: rows.results.map(siteRecord) });
      }
      if (request.method === 'POST' && url.pathname === '/api/sites') return json({ site: await saveSite(env, owner, validateSite(await body(request))) }, 201);
      const siteMatch = url.pathname.match(/^\/api\/sites\/([a-f0-9-]{36})$/);
      if (siteMatch && request.method === 'DELETE') {
        const row = await env.DB.prepare('SELECT record_json FROM research_sites WHERE id = ? AND owner_id = ?').bind(siteMatch[1], owner).first(); if (!row) return json({ error: 'Unknown site' }, 404);
        const site = siteRecord(row); site.removedAt = new Date().toISOString(); await env.DB.prepare('UPDATE research_sites SET removed_at = ?, record_json = ? WHERE id = ? AND owner_id = ?').bind(site.removedAt, JSON.stringify(site), site.id, owner).run(); return json({ removed: true, id: site.id, capturesRetained: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/runs') { const rows = await env.DB.prepare('SELECT record_json FROM research_jobs WHERE owner_id = ?').bind(owner).all(); return json({ jobs: rows.results.map(row=>{const {lease,...job}=siteRecord(row);return job;}) }); }
      if (request.method === 'POST' && url.pathname === '/api/runs') {
        const local = paired(env) && owner === env.LOCAL_RECORDER_OWNER;
        if (!local && !configuration(env)) return json({ error: 'Hosted capture service is not configured' }, 503);
        const input = validateSite(await body(request)), site = await saveSite(env, owner, input);
        const job = { id: crypto.randomUUID(), siteId: site.id, ...input, status: 'queued', phase: 'Queued', startedAt: new Date().toISOString() };
        if (local) { job.transport='local'; job.phase='Waiting for paired local recorder'; }
        try { await saveJob(env, owner, job); } catch { return json({ error: 'An existing capture may still be active; inspect its status before starting another' }, 409); }
        if (local) return json({id:job.id,status:job.status},202);
        try { await service(env, '/v1/runs', { method: 'POST', body: JSON.stringify({ id: job.id, ...input }) }, fetchImpl); }
        catch (error) {
          // The runner contract rejects these statuses before creating a job.
          // Transport errors and other responses can have an uncertain outcome.
          if ([400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(error.status)) {
            job.status = 'failed'; job.phase = 'Capture request was not accepted'; job.error = 'The recorder rejected this request before starting capture.'; job.endedAt = new Date().toISOString();
          } else { job.status = 'dispatch-unknown'; job.phase = 'Dispatch outcome unknown; poll this run before retrying'; }
          await saveJob(env, owner, job);
        }
        return json({ id: job.id, status: job.status }, 202);
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})(?:\/files\/(.+))?$/);
      if (runMatch && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT record_json FROM research_jobs WHERE id = ? AND owner_id = ?').bind(runMatch[1], owner).first(); if (!row) return json({ error: 'Unknown run' }, 404);
        const job = siteRecord(row), prefix = `research/${encodeURIComponent(owner)}/${job.id}/`;
        if (runMatch[2]) {
          if (job.transport==='local') return json({error:'Raw archive files remain on the local recorder'},404);
          const relative = decodeURIComponent(runMatch[2]); if (!relative || relative.split(/[\\/]/).includes('..') || /^[\\/]|^[a-z]+:/i.test(relative)) return json({ error: 'Invalid artifact path' }, 400);
          const key = prefix + 'files/' + relative; let object = await env.BUCKET.get(key);
          if (!object) { const remote = await service(env, `/v1/runs/${job.id}/files/${relative.split('/').map(encodeURIComponent).join('/')}`, {}, fetchImpl); await env.BUCKET.put(key, remote.body, { httpMetadata: { contentType: 'application/octet-stream' } }); object = await env.BUCKET.get(key); }
          return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
        }
        if (job.status === 'failed') {const {lease,...publicJob}=job;return json(publicJob);}
        const cacheKey = prefix + 'result.json'; const cached = await env.BUCKET.get(cacheKey); if (cached) return new Response(cached.body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
        if (job.transport==='local') { const {lease,...publicJob}=job; return json(publicJob); }
        let remote; try { remote = await (await service(env, '/v1/runs/' + job.id, {}, fetchImpl)).json(); } catch { return json({ ...job, message: 'Capture service is temporarily unavailable; recorded job is retained' }); }
        if (!['queued', 'running', 'completed', 'failed'].includes(remote.status)) return json({ ...job, message: 'Capture service returned an invalid status' });
        job.status = remote.status; job.phase = remote.status === 'completed' ? 'Ready' : remote.status === 'failed' ? 'Capture stopped' : 'Capture in progress'; job.progress = remote.progress; if (remote.error) job.error = 'The capture service reported a failure; contact the service owner for details.'; job.endedAt = remote.endedAt; await saveJob(env, owner, job);
        if (job.status === 'completed') {
          const payload = await service(env, `/v1/runs/${job.id}/result`, {}, fetchImpl);
          // The result response is a complete /api/runs/:id JSON envelope; stream
          // it into R2 without storing large page/response bodies in D1.
          await env.BUCKET.put(cacheKey, payload.body, { httpMetadata: { contentType: 'application/json' } });
          const stored = await env.BUCKET.get(cacheKey); return new Response(stored.body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
        }
        return json(job);
      }
      return json({ error: 'Unknown API route' }, 404);
    } catch (error) { return json({ error: error instanceof TypeError || error instanceof SyntaxError ? 'Invalid request' : 'Research operation failed' }, 400); }
  };
}
export default { fetch: createHostedHandler() };
