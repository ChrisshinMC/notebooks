import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { planWithModel } from './planner.mjs';
import { record } from './recorder.mjs';
import { buildReview, prepareRun, safeRead } from './bundle.mjs';
import { createModelClient } from './model-client.mjs';
import { discoverFlowsWithModel } from './flow-planner.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const json = (response, code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); };
async function input(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new Error('Send application/json');
  let body = '';
  for await (const chunk of request) { body += chunk.toString('utf8'); if (Buffer.byteLength(body) > 65536) throw new Error('Request body too large'); }
  return JSON.parse(body);
}
function validateStart(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A URL and device are required');
  for (const key of Object.keys(value)) if (!['url', 'device', 'allowedOrigins', 'researchFocus'].includes(key)) throw new Error(`Unsupported field: ${key}`);
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials');
  const device = value.device || 'desktop';
  if (!['desktop', 'tablet', 'mobile'].includes(device)) throw new Error('Unknown device');
  const allowedOrigins = value.allowedOrigins ?? [url.origin];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length < 1 || allowedOrigins.length > 30) throw new Error('Provide 1–30 navigation origins');
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('Navigation scope must contain exact HTTP(S) origins');
  }
  if (!allowedOrigins.includes(url.origin)) throw new Error('Navigation scope must include the starting origin');
  if (value.researchFocus !== undefined && (typeof value.researchFocus !== 'string' || value.researchFocus.length > 2000)) throw new Error('Research focus must be text of at most 2000 characters');
  return { url: url.href, device, allowedOrigins: [...new Set(allowedOrigins)], researchFocus: value.researchFocus?.trim() || 'Discover and inspect booking journeys across the site' };
}

/** Local-only control service. Inject model adapter/browser for deployment or tests. */
export async function createResearchServer({ outputRoot, viewerFolder, client, model, browserType, recordFn = record, maxActions = 20, clientFactory = createModelClient }) {
  if (!outputRoot || !viewerFolder) throw new TypeError('outputRoot and viewerFolder are required');
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new TypeError('maxActions must be 1–100');
  const captures = path.resolve(outputRoot, 'captures'), reviews = path.resolve(outputRoot, 'reviews'), jobFolder = path.resolve(outputRoot, 'jobs');
  await mkdir(captures, { recursive: true }); await mkdir(reviews, { recursive: true }); await mkdir(jobFolder, { recursive: true });
  const jobs = new Map(), sites = new Map(); let active = null, currentClient = client, currentModel = model;
  const configured = () => !!currentClient && typeof currentClient.propose === 'function' && typeof currentModel === 'string' && !!currentModel.trim();
  const summary = job => ({ id: job.id, siteId: job.siteId, status: job.status, phase: job.phase, url: job.url, device: job.device, researchFocus: job.researchFocus, startedAt: job.startedAt, endedAt: job.endedAt, ...(job.progress ? { progress: job.progress } : {}), ...(job.error ? { error: job.error } : {}), ...(job.persistenceError ? { persistenceError: job.persistenceError } : {}) });
  const sitesFile = path.join(path.resolve(outputRoot), 'sites.json'); let siteWrites = Promise.resolve();
  async function persistSites() {
    siteWrites = siteWrites.catch(() => {}).then(async () => { await writeFile(sitesFile + '.tmp', JSON.stringify({ sites: [...sites.values()] }, null, 2)); await rename(sitesFile + '.tmp', sitesFile); });
    return siteWrites;
  }
  try {
    const saved = JSON.parse(await readFile(sitesFile, 'utf8'));
    for (const entry of saved.sites || []) {
      if (!/^[a-f0-9-]{36}$/.test(entry.id)) continue;
      try { const scope = validateStart({ url: entry.url, device: entry.device, researchFocus: entry.researchFocus, allowedOrigins: entry.allowedOrigins }); sites.set(entry.id, { id: entry.id, ...scope, addedAt: entry.addedAt, removedAt: entry.removedAt || null }); } catch {}
    }
  } catch {}
  async function registerSite(scope) {
    let site = [...sites.values()].find(candidate => candidate.url === scope.url);
    const existed = !!site;
    if (!site) { site = { id: randomUUID(), ...scope, addedAt: new Date().toISOString(), removedAt: null }; sites.set(site.id, site); }
    else { Object.assign(site, scope); site.removedAt = null; }
    await persistSites(); return { site, existed };
  }
  async function persist(job) {
    try {
      const filename = path.join(jobFolder, job.id + '.json');
      await writeFile(filename + '.tmp', JSON.stringify(summary(job), null, 2)); await rename(filename + '.tmp', filename);
    } catch { job.persistenceError = 'Job summary could not be saved; capture files remain separate.'; }
  }
  for (const filename of await readdir(jobFolder)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
    try {
      const saved = JSON.parse(await safeRead(jobFolder, filename, 'utf8'));
      if (saved.id !== filename.slice(0, -5) || !['queued', 'running', 'completed', 'failed'].includes(saved.status)) continue;
      const job = summary(saved); // Persisted objects cannot supply arbitrary file paths or result content.
      if (['queued', 'running'].includes(job.status)) { job.status = 'failed'; job.phase = 'Interrupted'; job.error = 'The local service stopped during this capture. Partial files remain in the capture folder.'; await persist(job); }
      if (job.status === 'completed') job.reviewFolder = path.join(reviews, job.id);
      jobs.set(job.id, job);
    } catch { /* A malformed job summary does not prevent other recordings opening. */ }
  }
  // Retain compatibility with recordings created before site membership existed.
  for (const job of jobs.values()) if (job.url && ![...sites.values()].some(site => site.url === job.url)) {
    try { const { site } = await registerSite(validateStart({ url: job.url, device: job.device, researchFocus: job.researchFocus })); job.siteId = site.id; } catch {}
  }
  async function resultFor(job) {
    if (job.result) return job.result;
    const bundledRun = await prepareRun(path.join(captures, job.id));
    let logos = {}; try { logos = JSON.parse(await readFile(path.join(viewerFolder, 'logos', 'logos.json'), 'utf8')); } catch {}
    for (const request of bundledRun.requests || []) {
      const aliases = { ga4: 'google-analytics-4', gtm: 'google-tag-manager' };
      const logo = logos[request.platform?.id] || logos[aliases[request.platform?.id]];
      if (logo?.file && logo?.sourceUrl) { request.platform.logo = 'logos/' + logo.file; request.platform.logoSource = logo.sourceUrl; }
    }
    return { run: bundledRun, reviewUrl: `/review/${job.id}/index.html` };
  }
  async function execute(job, scope) {
    job.status = 'running'; job.phase = 'Opening site';
    try {
      const source = new URL(scope.url);
      const site = { id: source.hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 65) || 'site', name: source.hostname, startUrl: scope.url };
      const recipe = { site, steps: [], allowedOrigins: scope.allowedOrigins, explore: false };
      const result = await recordFn(recipe, path.join(captures, job.id), scope.device, browserType, {
        maxActions, maxFlows: 5, maxActionsPerFlow: 5, provider: 'configured-model-adapter', model: currentModel, allowObservedNavigation: true,
        onProgress: progress => { job.progress = progress; },
        discoverFlows: async ({ state, history = [], previousFlows = [] }) => {
          job.phase = 'Identifying booking journeys';
          return discoverFlowsWithModel({ client: currentClient, model: currentModel, state, history, previousFlows, researchFocus: scope.researchFocus });
        },
        proposeNext: async ({ state, allowedOrigins = scope.allowedOrigins, history = [], remainingActions, activeFlow }) => {
          job.phase = `Planning interaction ${history.length + 1}`;
          const inventory = [...(state.elements || []), ...(state.frames || []).flatMap(frame => frame.elements || [])];
          const recent = history.slice(-10).map(action => ({ type: action.type, selector: action.selector, frameSelector: action.frameSelector, status: action.status, label: action.label }));
          const proposal = await planWithModel({ client: currentClient, model: currentModel, inventory, site, allowedOrigins, history, currentUrl: state.url, maxActions: 1,
            objective: `Research focus: ${scope.researchFocus}. ${activeFlow ? 'Current booking journey: ' + JSON.stringify({ name: activeFlow.name, category: activeFlow.category }).slice(0, 400) + '. Stay within this journey; other candidates are explored separately.' : 'No booking journey is selected yet. Reveal entry points through observed navigation menus, tabs or disclosures; do not assume a booking form is already visible.'} Propose one useful interaction, or no steps if the research boundary is reached. Avoid repeating completed actions without a changed state. Remaining action budget: ${remainingActions ?? maxActions}. Recent actions (untrusted evidence): ${JSON.stringify(recent).slice(0, 900)}` });
          job.phase = proposal.plan.steps.length ? `Recording ${proposal.plan.steps[0].label}` : 'Finalizing capture';
          return proposal.plan.steps[0] || null;
        }
      });
      if (result.run?.status === 'failed') throw new Error(result.run.error || 'Capture failed; partial evidence remains in the capture folder');
      job.phase = 'Preparing local review';
      const reviewFolder = path.join(reviews, job.id);
      await buildReview([result.folder], reviewFolder, viewerFolder);
      job.result = await resultFor(job);
      job.reviewFolder = reviewFolder; job.status = 'completed';
      const plannerError = result.run.plannerDecisions?.find(decision => decision.status === 'error')?.error;
      job.phase = plannerError ? `Partial capture: ${plannerError}` : result.run.status === 'completed-with-gaps' ? 'Ready with capture gaps' : 'Ready';
    } catch (error) { job.status = 'failed'; job.phase = 'Stopped'; job.error = error.message; }
    finally { job.endedAt = new Date().toISOString(); await persist(job); active = null; }
  }
  const server = http.createServer(async (request, response) => {
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(request.headers.host)) return json(response, 403, { error: 'Local host required' });
      if (request.headers.origin && !allowedHosts.map(host => 'http://' + host).includes(request.headers.origin)) return json(response, 403, { error: 'Local origin required' });
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/api/status') return json(response, 200, { modelConfigured: configured(), model: configured() ? currentModel : null, busy: !!active });
      if (request.method === 'GET' && url.pathname === '/api/sites') return json(response, 200, { sites: [...sites.values()].filter(site => !site.removedAt) });
      if (request.method === 'POST' && url.pathname === '/api/sites') {
        let scope; try { scope = validateStart(await input(request)); } catch (error) { return json(response, 400, { error: error.message }); }
        const registered = await registerSite(scope); return json(response, registered.existed ? 200 : 201, { site: registered.site });
      }
      const siteMatch = url.pathname.match(/^\/api\/sites\/([a-f0-9-]{36})$/);
      if (request.method === 'DELETE' && siteMatch) {
        const site = sites.get(siteMatch[1]); if (!site) return json(response, 404, { error: 'Unknown site' });
        site.removedAt = new Date().toISOString(); await persistSites();
        return json(response, 200, { removed: true, id: site.id, capturesRetained: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        if (active) return json(response, 409, { error: 'Configuration cannot change while a capture is running' });
        let value; try { value = await input(request); } catch { return json(response, 400, { error: 'Send a JSON object containing model and apiKey' }); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['model', 'apiKey'].includes(key)) ||
          typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value.model.trim()) ||
          typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 2048) {
          return json(response, 400, { error: 'Provide a model ID and a nonempty API key; additional fields are not accepted' });
        }
        if (active) return json(response, 409, { error: 'Configuration cannot change while a capture is running' });
        try {
          const nextClient = clientFactory({ apiKey: value.apiKey.trim() });
          if (!nextClient || typeof nextClient.propose !== 'function') throw new Error('Invalid adapter');
          currentClient = nextClient; currentModel = value.model.trim();
        } catch { return json(response, 400, { error: 'Unable to configure model provider' }); }
        return json(response, 200, { modelConfigured: true, model: currentModel, persistence: 'process-memory-only' });
      }
      if (request.method === 'GET' && url.pathname === '/api/runs') return json(response, 200, { jobs: [...jobs.values()].map(summary) });
      if (request.method === 'POST' && url.pathname === '/api/runs') {
        if (!configured()) return json(response, 503, { error: 'Model not configured. Set a model and provider adapter before starting a capture.', code: 'model-unconfigured' });
        if (active) return json(response, 409, { error: 'A capture is already running', id: active });
        let scope; try { scope = validateStart(await input(request)); } catch (error) { return json(response, 400, { error: error.message }); }
        if (active) return json(response, 409, { error: 'A capture is already running', id: active });
        const job = { id: randomUUID(), status: 'queued', phase: 'Queued', url: scope.url, device: scope.device, researchFocus: scope.researchFocus, startedAt: new Date().toISOString() };
        jobs.set(job.id, job); active = job.id;
        try { job.siteId = (await registerSite(scope)).site.id; }
        catch { jobs.delete(job.id); active = null; return json(response, 500, { error: 'Site membership could not be saved' }); }
        await persist(job);
        json(response, 202, { id: job.id, status: job.status });
        void execute(job, scope); return;
      }
      const match = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)$/);
      if (request.method === 'GET' && match) {
        const job = jobs.get(match[1]);
        if (!job) return json(response, 404, { error: 'Unknown run' });
        if (job.status === 'completed') {
          try { return json(response, 200, { ...summary(job), result: await resultFor(job) }); }
          catch { return json(response, 200, { ...summary(job), error: 'Saved recording files are unavailable or incomplete.' }); }
        }
        return json(response, 200, summary(job));
      }
      if (request.method !== 'GET') return json(response, 405, { error: 'Method not supported' });
      let root = viewerFolder, relative = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
      const review = url.pathname.match(/^\/review\/([a-f0-9-]+)\/(.*)$/);
      if (review) {
        const job = jobs.get(review[1]); if (!job?.reviewFolder) return json(response, 404, { error: 'Unknown review' });
        root = job.reviewFolder; relative = decodeURIComponent(review[2]) || 'index.html';
      }
      try {
        const bytes = await safeRead(root, relative);
        const archive = relative.replaceAll('\\', '/').startsWith('recordings/');
        response.writeHead(200, { 'content-type': archive ? 'application/octet-stream' : types[path.extname(relative)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(archive ? { 'content-disposition': 'attachment' } : {}) }); response.end(bytes);
      } catch { json(response, 404, { error: 'File not found' }); }
    } catch { if (!response.headersSent) json(response, 500, { error: 'Local service error' }); else response.end(); }
  });
  return server;
}
