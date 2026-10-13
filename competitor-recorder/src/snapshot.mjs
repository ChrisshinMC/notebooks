import {writeFile,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {exclusion} from './explore.mjs';
import {waitForCaptureReadiness} from './capture-readiness.mjs';
import {sweepLazyImages} from './lazy-image-sweep.mjs';

export function pngSize(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return null;
 return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}
export function captureQuality(data,size){
 const flags=[];
 if(size&&data.viewport&&(Math.abs(size.width-data.viewport.width)>32||Math.abs(size.height-data.viewport.height)>32))flags.push({code:'viewport-size-mismatch',severity:'warning',message:'Recorded screenshot dimensions differ from the measured CSS viewport.'});
 if(data.visualState?.brokenImages)flags.push({code:'broken-images',severity:'warning',count:data.visualState.brokenImages,message:'The page reported image resources that failed to load.'});
 if(data.visualState?.pendingVisibleImages)flags.push({code:'visible-images-still-loading',severity:'warning',count:data.visualState.pendingVisibleImages,message:'Some visible images were still loading when this state was captured.'});
 if(data.visualState?.fontStatus==='loading')flags.push({code:'fonts-still-loading',severity:'warning',message:'Fonts were still loading when this state was captured.'});
 if(data.visualState?.challengeLike)flags.push({code:'possible-access-challenge',severity:'warning',message:'Page title or visible text resembles an access challenge; this may not be the intended content.'});
 if(data.visualState?.textLength<30&&!data.visualState?.imageCount&&!data.visualState?.canvasCount&&!data.elements.length)flags.push({code:'possibly-empty-page',severity:'warning',message:'Little visible content was detected in this state.'});
 return flags;
}

export async function snapshot(page, folder, id, options={}) {
 await mkdir(path.join(folder,'snapshots'),{recursive:true});
 await mkdir(path.join(folder,'screens'),{recursive:true});
 let loading=options.sharedLoading?{...options.sharedLoading,sharedWithParent:true,scope:'Parent document wait; frame resource counts observed separately without another timer'}:await waitForCaptureReadiness(page,{waitMs:options.waitMs});
 if(options.resolvePage){const selected=await options.resolvePage(page);if(selected&&selected!==page){page=selected;loading=await waitForCaptureReadiness(page,{waitMs:options.waitMs});}}
 const scrollSweep=!options.sharedLoading&&options.scrollSweep!==false?await sweepLazyImages(page,{deadline:options.deadline,onOperation:options.onCaptureOperation}):null;
 const data = await page.evaluate(() => {
  const elements=[];
  const originalHtml='<!doctype html>\n'+document.documentElement.outerHTML;
  const clone=document.documentElement.cloneNode(true);
  const source=[...document.querySelectorAll('*')], copies=[...clone.querySelectorAll('*')];
  function selector(el) {
   if(el.id) return '#'+CSS.escape(el.id);
   const parts=[];
   while(el && el.nodeType===1 && el!==document.documentElement) {
    const siblings=el.parentElement ? [...el.parentElement.children].filter(n=>n.tagName===el.tagName):[];
    parts.unshift(el.tagName.toLowerCase()+`:nth-of-type(${siblings.indexOf(el)+1})`);el=el.parentElement;
   } return 'html > '+parts.join(' > ');
  }
  // Copy live form state without password values; flattened shadow roots are not fabricated.
  source.slice(1).forEach((el,i)=>{
   const target=copies[i]; if(!target)return;
   if(el instanceof HTMLInputElement) { target.setAttribute('value',el.type==='password'?'':el.value); if(el.checked)target.setAttribute('checked','');else target.removeAttribute('checked'); }
   if(el instanceof HTMLTextAreaElement)target.textContent=el.value;
   if(el instanceof HTMLOptionElement){if(el.selected)target.setAttribute('selected','');else target.removeAttribute('selected');}
   if(el instanceof HTMLImageElement&&el.currentSrc)target.setAttribute('src',el.currentSrc);
  });
  document.querySelectorAll('a[href],button,input,select,textarea,summary,[role="button"],[role="tab"],[tabindex],[onclick]').forEach((el,index)=>{
   const r=el.getBoundingClientRect();
   if(!r.width || !r.height || getComputedStyle(el).visibility==='hidden')return;
   const name=el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || '';
   const elementId='element-'+index,elementSelector=selector(el);
   const sourceIndex=source.indexOf(el)-1;if(copies[sourceIndex])copies[sourceIndex].setAttribute('data-research-id',elementId);
   const anchor=el.closest('a[href]');
   elements.push({id:elementId,tag:el.tagName.toLowerCase(),role:el.getAttribute('role')||'',name:name.trim().slice(0,300),selector:elementSelector,...(anchor?{href:anchor.href}:{}),type:el.getAttribute('type'),expanded:el.getAttribute('aria-expanded'),rect:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height},status:'discovered'});
  });
  clone.querySelectorAll('script,iframe,object,embed,base,meta[http-equiv],link[rel="preload"],link[rel="modulepreload"],link[rel="prefetch"]').forEach(e=>e.remove());
  clone.querySelectorAll('*').forEach(el=>{
   for(const a of [...el.attributes])if(/^on/i.test(a.name)||['srcdoc','nonce','integrity','action','formaction'].includes(a.name))el.removeAttribute(a.name);
   if(el.tagName==='A') {el.removeAttribute('href');el.setAttribute('tabindex','-1');}
   for(const name of ['src','href','poster'])if(el.hasAttribute(name))try{el.setAttribute(name,new URL(el.getAttribute(name),document.baseURI).href);}catch{el.removeAttribute(name);}
   el.removeAttribute('srcset');
  });
  const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';
  policy.content="default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";
  clone.querySelector('head')?.prepend(policy);
  const bodyText=document.body?.innerText||'';
  const visualState={textLength:bodyText.trim().length,imageCount:document.images.length,canvasCount:document.querySelectorAll('canvas').length,brokenImages:[...document.images].filter(img=>img.complete&&img.currentSrc&&!img.naturalWidth).length,pendingImages:[...document.images].filter(img=>!img.complete).length,pendingOffscreenLazyImages:[...document.images].filter(img=>img.loading==='lazy'&&!img.complete&&img.getBoundingClientRect().top>=innerHeight).length,fontStatus:document.fonts?.status||'unavailable',challengeLike:/access denied|verify (?:that )?you are human|checking your browser|just a moment/i.test(document.title+' '+bodyText.slice(0,400))};
  visualState.pendingVisibleImages=[...document.images].filter(img=>{const r=img.getBoundingClientRect();return !img.complete&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;}).length;
  return {title:document.title,url:location.href,baseUrl:document.baseURI,originalHtml,html:'<!doctype html>\n'+clone.outerHTML,elements,visualState,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY},documentSize:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}};
 });
 for(const e of data.elements){const reason=exclusion(e);if(reason){e.status='excluded';e.reason=reason;}}
 const html=`snapshots/${id}.html`, screenshot=`screens/${id}.png`;
 const rawHtml=`snapshots/${id}.raw.html`;
 await writeFile(path.join(folder,rawHtml),data.originalHtml,'utf8');delete data.originalHtml;
 await writeFile(path.join(folder,html),data.html,'utf8');
 let dimensions=null;
 if(options.screenshot!==false){await page.screenshot({path:path.join(folder,screenshot),fullPage:false,scale:'css'});dimensions=pngSize(await readFile(path.join(folder,screenshot)));}
 const state={...data,loading,scrollSweep,html,rawHtml,...(options.screenshot!==false?{screenshot,captureType:'viewport',...(dimensions?{screenshotWidth:dimensions.width,screenshotHeight:dimensions.height}:{})}:{}),qualityFlags:captureQuality(data,dimensions),id,domHash:createHash('sha256').update(data.html).digest('hex'),capturedAt:new Date().toISOString(),frames:[],limitations:['Inert DOM snapshot: scripts removed; canvas and closed shadow DOM may not reproduce.','Direct child frame documents are separate snapshots; nested frames and shadow-root controls are not inventoried.']};
 if(loading.status!=='ready')state.qualityFlags.push({code:'resource-readiness-'+loading.status,severity:'warning',message:loading.reason});
 if(!loading.sharedWithParent&&loading.images?.decodeFailed)state.qualityFlags.push({code:'image-decode-failures',severity:'warning',count:loading.images.decodeFailed,message:'Some loaded images could not be decoded before capture.'});
 if(scrollSweep&&['partial','unavailable'].includes(scrollSweep.status))state.qualityFlags.push({code:'scroll-sweep-'+scrollSweep.status,severity:'warning',message:scrollSweep.reason||'Some page sections or resources remain unverified.'});
 if(data.visualState?.pendingOffscreenLazyImages)state.qualityFlags.push({code:'offscreen-lazy-images-pending',severity:'info',count:data.visualState.pendingOffscreenLazyImages,message:'Some offscreen lazy images remain pending after the bounded capture preparation.'});
 if(options.screenshot!==false&&options.fullPage!==false&&data.documentSize?.height>data.viewport?.height){
  try{const fullPageScreenshot=`screens/${id}-full-page.png`;await page.screenshot({path:path.join(folder,fullPageScreenshot),fullPage:true,scale:'css'});const size=pngSize(await readFile(path.join(folder,fullPageScreenshot)));state.fullPageScreenshot=fullPageScreenshot;if(size){state.fullPageScreenshotWidth=size.width;state.fullPageScreenshotHeight=size.height;}}
  catch(e){state.qualityFlags.push({code:'full-page-capture-unavailable',severity:'warning',message:e.message});}
 }
 if(options.includeFrames!==false&&typeof page.frames==='function'){
  for(const frame of page.frames().filter(f=>f.parentFrame()===page.mainFrame())){
   const frameId=`${id}-frame-${state.frames.length}`;
   try{
    const handle=await frame.frameElement();
    const frameSelector=await handle.evaluate(el=>{
     if(el.id)return '#'+CSS.escape(el.id);const parts=[];
     while(el&&el.nodeType===1&&el!==document.documentElement){const siblings=[...el.parentElement.children].filter(n=>n.tagName===el.tagName);parts.unshift(el.tagName.toLowerCase()+`:nth-of-type(${siblings.indexOf(el)+1})`);el=el.parentElement;}return 'html > '+parts.join(' > ');
    });
    await handle.dispose();
    const child=await snapshot(frame,folder,frameId,{includeFrames:false,screenshot:false,sharedLoading:loading});
    child.frameSelector=frameSelector;for(const element of child.elements)element.frameSelector=frameSelector;
    state.frames.push(child);
   }catch(e){state.frames.push({id:frameId,url:frame.url(),status:'unavailable',reason:e.message,elements:[]});}
  }
 }
 return state;
}
