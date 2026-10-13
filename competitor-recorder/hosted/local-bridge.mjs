import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Sends work to the existing local HTTP application, never a second crawler.
export async function createLocalBridge({hostedUrl,token,localUrl='http://127.0.0.1:8768',journalPath,fetchImpl=fetch}) {
  const remote=new URL(hostedUrl), local=new URL(localUrl);
  if(remote.protocol!=='https:' || remote.username || remote.password || remote.search || remote.hash) throw Error('HTTPS hosted URL required');
  if(local.protocol!=='http:' || !['127.0.0.1','localhost'].includes(local.hostname) || local.username || local.password || local.search || local.hash) throw Error('Loopback local URL required');
  if(typeof token!=='string'||token.length<32) throw Error('Pairing token required');
  let journal={}; try { journal=JSON.parse(await readFile(journalPath,'utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
  const save=async()=>{await mkdir(path.dirname(journalPath),{recursive:true});await writeFile(journalPath+'.tmp',JSON.stringify(journal),{mode:0o600});await rename(journalPath+'.tmp',journalPath);};
  if(!journal.clientId){journal.clientId=randomUUID();await save();}
  const call=async(base,route,value,secret)=>{
    const response=await fetchImpl(new URL(route,base),{method:value?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(60000),headers:{'content-type':'application/json',...(secret?{authorization:'Bearer '+token}:{origin:local.origin})},...(value?{body:JSON.stringify(value)}:{})});
    if(!response.ok) {const error=Error('Recorder transport returned HTTP '+response.status);error.status=response.status;throw error;} return response.json();
  };
  const finish=async payload=>{
    const id=journal.job.id;
    await call(remote,'/api/bridge/'+id+'/finish',payload,true);
    journal={clientId:journal.clientId};await save();return {status:payload.status,jobId:id,...(payload.errorCode?{errorCode:payload.errorCode}:{})};
  };
  return {async tick(){
    if(journal.failure) return finish({lease:journal.job.lease,status:'failed',errorCode:journal.failure});
    const readiness=await call(local,'/api/status');
    if(!journal.localId && !readiness.modelConfigured) return {status:'model-unconfigured'};
    if(!journal.job){
      if(readiness.busy) return {status:'local-busy'};
      const {job}=await call(remote,'/api/bridge/claim',{clientId:journal.clientId},true);
      if(!job) return {status:'idle'};
      journal={clientId:journal.clientId,job,submission:'not-started'};await save();
    }
    const job=journal.job;
    if(!journal.localId){
      if(journal.submission==='uncertain') return {status:'submission-uncertain',jobId:job.id};
      journal.submission='uncertain';await save(); // Crash/timeout must never duplicate a local recording.
      let accepted;
      try {accepted=await call(local,'/api/runs',{url:job.url,device:job.device,researchFocus:job.researchFocus,allowedOrigins:job.allowedOrigins});}
      catch(error){
        if([400,401,403,404,409,413,415,422,429,503].includes(error.status)){
          journal.failure='local-request-rejected';await save();return finish({lease:job.lease,status:'failed',errorCode:journal.failure});
        }
        throw error;
      }
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(accepted?.id||'')) throw Error('Local submission response did not identify a recording; outcome remains uncertain');
      journal.localId=accepted.id; journal.submission='accepted';await save();
    }
    const outcome=await call(local,'/api/runs/'+journal.localId);
    if(!['completed','failed'].includes(outcome.status)) return {status:'running',jobId:job.id};
    if(outcome.status==='completed'&&!outcome.result?.run) throw Error('Local recording result unavailable');
    const payload={lease:job.lease,status:outcome.status,...(outcome.result?{result:{run:outcome.result.run}}:{})};
    if(Buffer.byteLength(JSON.stringify(payload),'utf8')>32*1024*1024){
      journal.failure='result-too-large';await save();return finish({lease:job.lease,status:'failed',errorCode:journal.failure});
    }
    return finish(payload);
  }};
}
