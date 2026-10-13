// Optional outbound pairing. The token is configured on the Worker and local
// process only; it is never handed to the research UI.
export const paired = env => env.CAPTURE_MODE === 'local' && typeof env.LOCAL_RECORDER_OWNER === 'string' && !!env.LOCAL_RECORDER_OWNER && typeof env.LOCAL_RECORDER_TOKEN === 'string' && env.LOCAL_RECORDER_TOKEN.length >= 32;
async function authorized(request, env) {
  if (!paired(env)) return false;
  const supplied = request.headers.get('authorization') || '';
  if (supplied.length > 4096) return false;
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a,b] = await Promise.all([digest(supplied), digest('Bearer ' + env.LOCAL_RECORDER_TOKEN)]);
  let different = 0; for (let i=0;i<a.length;i++) different |= a[i]^b[i]; return different === 0;
}
export async function localQueue(request, env, readBody) {
  const reply = (value,status=200) => Response.json(value,{status,headers:{'cache-control':'no-store'}});
  if (!await authorized(request,env)) return reply({error:'Recorder pairing required'},401);
  if (request.method !== 'POST') return reply({error:'POST required'},405);
  const owner = env.LOCAL_RECORDER_OWNER, pathname = new URL(request.url).pathname;
  if (pathname === '/api/bridge/claim') {
    const input=await readBody(request); if(!/^[a-f0-9-]{36}$/.test(input.clientId||'')) return reply({error:'Recorder identity required'},400);
    const rows = await env.DB.prepare('SELECT record_json FROM research_jobs WHERE owner_id = ?').bind(owner).all();
    const jobs = rows.results.map(row=>JSON.parse(row.record_json));
    const claimed = jobs.find(job=>job.status==='running' && job.transport==='local');
    if(claimed) return reply({job:claimed.leaseClient===input.clientId?claimed:null});
    const job = jobs.find(job=>job.status==='queued' && job.transport==='local');
    if (!job) return reply({job:null});
    const before = JSON.stringify(job); job.status='running'; job.phase='Claimed by paired local recorder'; job.lease=crypto.randomUUID();job.leaseClient=input.clientId;
    const result = await env.DB.prepare('UPDATE research_jobs SET record_json = ? WHERE id = ? AND owner_id = ? AND record_json = ?').bind(JSON.stringify(job),job.id,owner,before).run();
    if (result.meta?.changes !== 1) return reply({job:null});
    return reply({job});
  }
  const match=pathname.match(/^\/api\/bridge\/([a-f0-9-]{36})\/finish$/);
  if (!match) return reply({error:'Unknown bridge route'},404);
  const payload=await readBody(request,32*1024*1024);
  const row=await env.DB.prepare('SELECT record_json FROM research_jobs WHERE id = ? AND owner_id = ?').bind(match[1],owner).first();
  if (!row) return reply({error:'Unknown run'},404);
  const job=JSON.parse(row.record_json);
  if (!payload.lease || payload.lease!==job.lease || job.transport!=='local') return reply({error:'Invalid claim'},403);
  if (['completed','failed'].includes(job.status)) return reply({status:job.status});
  if (!['completed','failed'].includes(payload.status)) return reply({error:'Invalid outcome'},400);
  if (payload.status==='completed') {
    if (!payload.result?.run || !Array.isArray(payload.result.run.states) || !Array.isArray(payload.result.run.requests)) return reply({error:'Recorded result required'},400);
    const result={run:payload.result.run};
    await env.BUCKET.put(`research/${encodeURIComponent(owner)}/${job.id}/result.json`,JSON.stringify({id:job.id,siteId:job.siteId,status:'completed',result}),{httpMetadata:{contentType:'application/json'}});
  }
  job.status=payload.status; job.phase=job.status==='completed'?'Ready':'Local capture stopped'; job.endedAt=new Date().toISOString();
  if(job.status==='failed') {
    const errors={'local-request-rejected':'The local recorder rejected this request before capture started.','result-too-large':'The recording remains available locally, but its bundled result exceeds the 32 MiB hosted transfer limit.'};
    job.error=errors[payload.errorCode]||'The local capture stopped before a hosted result was available.';
  }
  await env.DB.prepare('UPDATE research_jobs SET record_json = ?, active_owner = NULL WHERE id = ? AND owner_id = ?').bind(JSON.stringify(job),job.id,owner).run();
  return reply({status:job.status});
}
