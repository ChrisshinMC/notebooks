import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { record } from '../src/recorder.mjs';
import { planWithModel } from '../src/planner.mjs';
import { discoverFlowsWithModel } from '../src/flow-planner.mjs';
import { prepareRun, safeRead } from '../src/bundle.mjs';
import { validateSite, publicHostname } from './worker.mjs';

const reply = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const validId = id => /^[a-f0-9-]{36}$/.test(id);
const authorized = (header, token) => { const expected = Buffer.from('Bearer ' + token), actual = Buffer.from(header || ''); return expected.length === actual.length && timingSafeEqual(expected, actual); };
export function guardedBrowser(browserType, allowedHosts, egressProxy, publicSubresources=false) {
  const allowed = new Set(allowedHosts.map(host => host.toLowerCase()));
  if ((!allowed.size && !publicSubresources) || !egressProxy) throw Error('Explicit capture host allowlist and restricted egress proxy are required');
  return { launch: async options => {
    const browser = await browserType.launch({ ...options, proxy: { server: egressProxy }, args:[...(options.args||[]),'--proxy-bypass-list=<-loopback>','--disable-quic'] });
    return new Proxy(browser, { get(target, key) {
      if (key === 'newContext') return async config => {
        const context = await target.newContext(config);
        return new Proxy(context, { get(inner, member) {
          if (member === 'route') return (pattern, handler, routeOptions) => inner.route(pattern, async (route, request) => {
            let url; try { url = new URL(route.request().url()); } catch { return route.abort('blockedbyclient'); }
            if (!['http:', 'https:'].includes(url.protocol) || !publicHostname(url.hostname) || (!publicSubresources && !allowed.has(url.hostname.toLowerCase()))) return route.abort('blockedbyclient');
            return handler(route, request);
          }, routeOptions);
          const value = inner[member]; return typeof value === 'function' ? value.bind(inner) : value;
        } });
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
}

export async function createCaptureRunner({ token, client, model, browserType, browserReady = false, outputRoot, allowedHosts = [], egressProxy, publicSubresources=false, onCompleted, recordFn = record }) {
  if (typeof token !== 'string' || token.length < 32) throw Error('A service authentication token of at least 32 characters is required');
  const root = path.resolve(outputRoot); await mkdir(root, { recursive: true });
  const jobs = new Map(); let active = null;
  const ready = () => !!client?.propose && !!client?.discover && !!model && browserReady && (allowedHosts.length > 0 || publicSubresources) && !!egressProxy;
  const save = async job => { const file = path.join(root, job.id + '.json'); await writeFile(file + '.tmp', JSON.stringify(job, null, 2)); await rename(file + '.tmp', file); };
  for (const filename of await readdir(root)) if (/^[a-f0-9-]{36}\.json$/.test(filename)) {
    try { const job = JSON.parse(await safeRead(root, filename, 'utf8')); if (!validId(job.id) || filename !== job.id + '.json') continue; if (['queued','running'].includes(job.status)) { job.status = 'failed'; job.error = 'Capture interrupted by service restart'; await save(job); } jobs.set(job.id, job); } catch {}
  }
  async function execute(job, scope) {
    try {
      job.status = 'running'; job.phase = 'Recording'; await save(job);
      const site = { id: new URL(scope.url).hostname.replace(/[^a-z0-9]+/gi, '-').slice(0,60), name: new URL(scope.url).hostname, startUrl: scope.url };
      const result = await recordFn({ site, steps: [], allowedOrigins: scope.allowedOrigins }, path.join(root, job.id), scope.device, guardedBrowser(browserType, allowedHosts, egressProxy, publicSubresources), {
        maxActions: 20, maxFlows: 5, maxActionsPerFlow: 5, allowObservedNavigation: true, provider: 'service-model', model,
        discoverFlows: args => discoverFlowsWithModel({ ...args, client, model, researchFocus: scope.researchFocus }),
        proposeNext: async ({ state, history, allowedOrigins, activeFlow }) => {
          const proposal = await planWithModel({ client, model, site, allowedOrigins, history, currentUrl: state.url, inventory: [...state.elements, ...(state.frames || []).flatMap(frame => frame.elements || [])], maxActions: 1, objective: `${scope.researchFocus}. ${activeFlow ? 'Current booking flow: ' + activeFlow.name : 'Reveal observed booking entry points through menus and navigation.'}` }); return proposal.plan.steps[0] || null;
        },
        onProgress: progress => { job.progress = progress; }
      });
      if (result.run.status === 'failed') throw Error('Capture failed');
      if(onCompleted){job.phase='Uploading capture';await save(job);await onCompleted({id:job.id,folder:path.join(root,job.id),run:result.run});}
      job.status = 'completed'; job.phase = result.run.status === 'completed-with-gaps' ? 'Ready with capture gaps' : 'Ready';
    } catch { job.status = 'failed'; job.phase = 'Stopped'; job.error = 'Capture failed or was interrupted; inspect the service capture files'; }
    finally { job.endedAt = new Date().toISOString(); try { await save(job); } catch { job.error = 'Job status could not be persisted; inspect service storage'; } active = null; }
  }
  return http.createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, token)) return reply(res, 401, { error: 'Service authentication required' });
    try {
      const url = new URL(req.url, 'http://runner.invalid');
      if (req.method === 'GET' && url.pathname === '/v1/status') return reply(res, 200, { captureAvailable: ready(), modelConfigured: !!client?.propose && !!model, model: model || null, busy: !!active });
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        if (!ready()) return reply(res, 503, { error: 'Capture runtime, model or egress policy is not configured' });
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(res, 400, { error: 'Send application/json' });
        let text = ''; for await (const chunk of req) { text += chunk.toString('utf8'); if (Buffer.byteLength(text) > 65536) return reply(res, 413, { error: 'Input too large' }); }
        const parsed = JSON.parse(text), { id, ...value } = parsed; if (!validId(id)) return reply(res, 400, { error: 'A stable UUID job ID is required' });
        const scope = validateSite(value); if (!publicSubresources && !allowedHosts.includes(new URL(scope.url).hostname.toLowerCase())) return reply(res, 403, { error: 'Target is outside the configured capture host allowlist' });
        if (jobs.has(id)) return reply(res, 200, { id, status: jobs.get(id).status });
        if (active) return reply(res, 409, { error: 'Capture capacity is busy' });
        const job = { id, ...scope, status: 'queued', phase: 'Queued', startedAt: new Date().toISOString() }; active = id; jobs.set(id, job);
        try { await save(job); } catch { jobs.delete(id); active = null; return reply(res, 500, { error: 'Job could not be persisted' }); }
        reply(res, 202, { id, status: job.status }); void execute(job, scope); return;
      }
      const match = url.pathname.match(/^\/v1\/runs\/([a-f0-9-]{36})(?:\/(result|files)(?:\/(.+))?)?$/);
      if (req.method === 'GET' && match) {
        const job = jobs.get(match[1]); if (!job) return reply(res, 404, { error: 'Unknown run' });
        if (!match[2]) return reply(res, 200, job);
        if (match[2] === 'result') { if (job.status !== 'completed') return reply(res, 409, { error: 'Capture is not complete' }); return reply(res, 200, { ...job, result: { run: await prepareRun(path.join(root, job.id)) } }); }
        const bytes = await safeRead(path.join(root, job.id), decodeURIComponent(match[3] || ''));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'cache-control': 'no-store' }); res.end(bytes); return;
      }
      reply(res, 404, { error: 'Unknown service route' });
    } catch { reply(res, 400, { error: 'Invalid service request or unavailable artifact' }); }
  });
}
