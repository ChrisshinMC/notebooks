import {readdir,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareRun} from '../competitor-recorder/src/bundle.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
export function createDurableUpload({baseUrl,token,fetchImpl=fetch,prepare=prepareRun,sleep=ms=>new Promise(r=>setTimeout(r,ms)),onProgress}){
 const base=new URL(baseUrl);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('HTTPS callback URL required');
 async function release(response){
  const reader=response.body?.getReader?.();if(!reader){await response.body?.cancel?.();return;}
  let size=0;try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384){await reader.cancel();break;}}}catch{try{await reader.cancel();}catch{}}finally{reader.releaseLock();}
 }
 async function send(route,method,body,headers={}){
  for(let attempt=0;attempt<3;attempt++){
   try{const response=await fetchImpl(new URL(route,base),{method,redirect:'error',signal:AbortSignal.timeout(90000),headers:{authorization:'Bearer '+token,'content-length':String(body.length),...headers},body});await release(response);if(response.ok)return;if(response.status<500&&![408,429].includes(response.status))throw Object.assign(Error('Upload rejected'),{terminal:true});}catch(e){if(e.terminal)throw Error('Durable upload rejected');}
   if(attempt<2)await sleep(1000*(attempt+1));
  }throw Error('Durable upload acknowledgement unavailable');
 }
 return async({id,folder,onProgress:runProgress})=>{
  const report=typeof runProgress==='function'?runProgress:onProgress;
  const files=[];async function walk(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){const relative=prefix+entry.name,absolute=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Symlink capture artifact rejected');if(entry.isDirectory())await walk(absolute,relative+'/');else if(entry.isFile()){const stat=await lstat(absolute);if(stat.size>64*1024*1024)throw Error('Capture artifact exceeds upload limit');files.push({path:relative,absolute,size:stat.size});}}}await walk(folder);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const manifest=new Array(files.length);let processed=0,uploadedBytes=0;
  async function uploadFile(index){const file=files[index],bytes=await readFile(file.absolute);if(bytes.length!==file.size)throw Error('Capture artifact changed before upload');const sha256=digest(bytes);manifest[index]={path:file.path,size:bytes.length,sha256};await send('/api/service/runs/'+id+'/files/'+file.path.split('/').map(encodeURIComponent).join('/'),'PUT',bytes,{'content-type':'application/octet-stream','x-research-sha256':sha256});processed++;uploadedBytes+=bytes.length;if(report){let timer;try{await Promise.race([Promise.resolve(report({id,phase:'Uploading capture',processed,total:files.length,uploadedBytes})),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}catch{}finally{clearTimeout(timer);}}}
  // Small-file batches overlap two round trips. Large files upload alone so
  // buffers stay bounded to 32 MiB per small batch or one 64 MiB artifact.
  for(let index=0;index<files.length;){const batch=[index++];if(files[batch[0]].size<=16*1024*1024&&index<files.length&&files[index].size<=16*1024*1024)batch.push(index++);const results=await Promise.allSettled(batch.map(uploadFile));const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;}
  const run=await prepare(folder),bytes=Buffer.from(JSON.stringify({id,status:'completed',result:{run}}));if(bytes.length>64*1024*1024)throw Error('Prepared review exceeds upload limit');
  await send('/api/service/runs/'+id+'/complete','POST',bytes,{'content-type':'application/json','x-research-artifact-count':String(manifest.length),'x-research-manifest-sha256':digest(JSON.stringify(manifest))});
 };
}
