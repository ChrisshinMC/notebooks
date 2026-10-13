import {readFile,writeFile,mkdir,cp,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {classifyRequest,decodeRequest} from './platforms.mjs';

export async function safeRead(root,relative,encoding) {
 if(typeof relative!=='string'||path.isAbsolute(relative)||/^[a-z]+:/i.test(relative))throw Error('Artifact path must be relative');
 const base=await realpath(root),target=await realpath(path.resolve(base,relative));
 if(!target.startsWith(base+path.sep))throw Error('Artifact path escapes run folder');
 return readFile(target,encoding);
}
const jsLiteral=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const contentType=r=>Object.entries(r.response?.headers||{}).find(([k])=>k.toLowerCase()==='content-type')?.[1]?.split(';')[0]?.trim().toLowerCase()||'application/octet-stream';
const textType=t=>/^text\//.test(t)||/json|javascript|xml|svg/.test(t);
const unescapeAttribute=s=>s.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,entity=>{
 const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};
 if(named[entity.toLowerCase()])return named[entity.toLowerCase()];
 const code=entity.toLowerCase().startsWith('&#x')?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);
 return code>=0&&code<=0x10ffff?String.fromCodePoint(code):entity;
});

export async function prepareRun(folder) {
 const run=JSON.parse(await safeRead(folder,'run.json','utf8'));
 const bodies={},snapshots={},assets=[];
 const requests=run.requests||[];
 for(const r of requests){
  r.platform=classifyRequest(r);
  if(r.postData?.path)try{r.postData.text=await safeRead(folder,r.postData.path,'utf8');bodies[r.postData.path]=r.postData.text;}catch(e){r.postData.bundleError=e.message;}
  r.decoded=decodeRequest(r);
  if(r.response?.body?.path){
   try{
    const bytes=await safeRead(folder,r.response.body.path),type=contentType(r);
    if(textType(type))bodies[r.response.body.path]=bytes.toString('utf8');
    assets.push({request:r,bytes,type,url:r.url});
   }catch(e){r.response.body.bundleError=e.message;}
  }
 }
 const missing=new Set();
 const allStates=(run.states||[]).flatMap(state=>[state,...(state.frames||[])]);
 for(const state of allStates){
  const at=Date.parse(state.capturedAt||run.endedAt)||Infinity;
  const available=new Map();const stateMissing=new Set();
  const assetTime=a=>Date.parse(a.request.finishedAt||a.request.startedAt)||0;
  for(const a of [...assets].sort((a,b)=>assetTime(a)-assetTime(b)))if(assetTime(a)<=at&&![204,304].includes(a.request.response?.status))available.set(a.url,a);
  const dataUrl=(url,base,seen=new Set())=>{
   if(/^data:/i.test(url)||url.startsWith('#'))return url;
   let absolute;try{absolute=new URL(url,base).href;}catch{return '';}
   const parsed=new URL(absolute),fragment=parsed.hash;parsed.hash='';const asset=available.get(parsed.href)||available.get(absolute);
   if(!asset){missing.add(absolute);stateMissing.add(absolute);return '';}
   if(seen.has(absolute)){missing.add(absolute+' (cyclic stylesheet)');return '';}
   let bytes=asset.bytes;
   if(asset.type==='text/css'){
    const next=new Set(seen);next.add(absolute);
    let css=bytes.toString('utf8');
    css=css.replace(/@import\s+(['"])(.*?)\1\s*([^;]*);/gi,(_,q,v,conditions)=>`@import url("${dataUrl(v,absolute,next)}") ${conditions};`);
    css=css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(_,q,v)=>`url("${dataUrl(v,absolute,next)}")`);
    bytes=Buffer.from(css);
   }
   return `data:${asset.type};base64,${bytes.toString('base64')}${fragment}`;
  };
  try{
   if(state.html){
   let html=await safeRead(folder,state.html,'utf8');
   const rewriteCss=css=>css.replace(/@import\s+(['"])(.*?)\1\s*([^;]*);/gi,(_,q,v,conditions)=>`@import url(${dataUrl(v,state.baseUrl||state.url)}) ${conditions};`).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(_,q,v)=>`url(${dataUrl(v,state.baseUrl||state.url)})`);
   // Decode HTML entities in inline CSS first; do not rewrite url(...) in
   // unrelated text nodes, where it is content rather than an asset reference.
   html=html.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi,(_,q,value)=>{
    const css=rewriteCss(unescapeAttribute(value));
    return `style=${q}${css.replaceAll('&','&amp;').replaceAll(q,q==='"'?'&quot;':'&#39;')}${q}`;
   });
   html=html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,(_,open,css,close)=>open+rewriteCss(css)+close);
   html=html.replace(/\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi,(original,key,q,value)=>{
    if(value.startsWith('#'))return original;
    return `${key}=${q}${dataUrl(unescapeAttribute(value),state.baseUrl||state.url)}${q}`;
   });
   snapshots[state.html]=html;
   }state.reconstructionMissingAssets=[...stateMissing];
  }catch(e){state.bundleError=e.message;}
  for(const field of ['screenshot','fullPageScreenshot'])if(state[field])try{state[field]='data:image/'+(state[field].endsWith('.jpg')?'jpeg':'png')+';base64,'+(await safeRead(folder,state[field])).toString('base64');}catch(e){state[field+'Error']=e.message;}
 }
 return {...run,snapshots,bodies,reconstructionMissingAssets:[...missing],basePath:''};
}

export async function buildReview(runFolders,output,viewerFolder) {
 const target=path.resolve(output);
 for(const folder of runFolders){const source=path.resolve(folder);if(target===source||target.startsWith(source+path.sep)||source.startsWith(target+path.sep))throw Error('Review output must be separate from capture folders');}
 // Never replace a populated output: each export is an immutable folder.
 try{await stat(target);throw Error('Output already exists; choose a new review folder');}catch(e){if(e.code!=='ENOENT')throw e;}
 const runs=[];for(const folder of runFolders)runs.push(await prepareRun(folder));
 await mkdir(target,{recursive:true});
 await cp(viewerFolder,target,{recursive:true,filter:source=>path.basename(source)!=='data.js' && !path.basename(source).startsWith('fixture')});
 for(let i=0;i<runFolders.length;i++){
  await cp(runFolders[i],path.join(target,'recordings',`run-${i+1}`),{recursive:true});
  runs[i].archivePath=`recordings/run-${i+1}`;
 }
 let logos={};try{logos=JSON.parse(await readFile(path.join(viewerFolder,'logos','logos.json'),'utf8'));}catch{}
 for(const run of runs)for(const req of run.requests||[]){
  const aliases={ga4:'google-analytics-4',gtm:'google-tag-manager'};
  const logo=logos[req.platform?.id]||logos[aliases[req.platform?.id]];if(logo?.file&&logo?.sourceUrl){
   req.platform.logo='logos/'+logo.file;req.platform.logoSource=logo.sourceUrl;
  }
 }
 await writeFile(path.join(target,'data.js'),'window.RESEARCH_DATA='+jsLiteral({runs})+';\n');
 await writeFile(path.join(target,'README.txt'),'Competitive UX Research\n\nOpen index.html. Captured pages are inert review copies; scripts do not execute.\nThis local review includes captured request and response data. It is not an automatically sanitized sharing copy.\nThe recordings folder preserves original run files and captured asset bytes, including scripts; these scripts are not executed by the viewer. Missing reconstruction assets are listed in each run.\n');
 return {output:target,runs:runs.length,states:runs.reduce((n,r)=>n+(r.states?.length||0),0)};
}
