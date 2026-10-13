import {readdir,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareRun} from '../competitor-recorder/src/bundle.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
export function createDurableUpload({baseUrl,token,fetchImpl=fetch,prepare=prepareRun,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const base=new URL(baseUrl);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('HTTPS callback URL required');
 async function send(route,method,body,headers={}){
  for(let attempt=0;attempt<3;attempt++){
   try{const response=await fetchImpl(new URL(route,base),{method,redirect:'error',signal:AbortSignal.timeout(90000),headers:{authorization:'Bearer '+token,'content-length':String(body.length),...headers},body});if(response.ok)return;if(response.status<500&&![408,429].includes(response.status))throw Object.assign(Error('Upload rejected'),{terminal:true});}catch(e){if(e.terminal)throw Error('Durable upload rejected');}
   if(attempt<2)await sleep(1000*(attempt+1));
  }throw Error('Durable upload acknowledgement unavailable');
 }
 return async({id,folder})=>{
  const files=[];async function walk(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){const relative=prefix+entry.name,absolute=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Symlink capture artifact rejected');if(entry.isDirectory())await walk(absolute,relative+'/');else if(entry.isFile()){const stat=await lstat(absolute);if(stat.size>64*1024*1024)throw Error('Capture artifact exceeds upload limit');files.push({path:relative,absolute});}}}await walk(folder);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const manifest=[];
  for(const file of files){const bytes=await readFile(file.absolute),sha256=digest(bytes);manifest.push({path:file.path,size:bytes.length,sha256});await send('/api/service/runs/'+id+'/files/'+file.path.split('/').map(encodeURIComponent).join('/'),'PUT',bytes,{'content-type':'application/octet-stream','x-research-sha256':sha256});}
  const run=await prepare(folder),bytes=Buffer.from(JSON.stringify({id,status:'completed',result:{run}}));if(bytes.length>64*1024*1024)throw Error('Prepared review exceeds upload limit');
  await send('/api/service/runs/'+id+'/complete','POST',bytes,{'content-type':'application/json','x-research-artifact-count':String(manifest.length),'x-research-manifest-sha256':digest(JSON.stringify(manifest))});
 };
}
