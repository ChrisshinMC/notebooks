export const MINIMUM_CAPTURE_WAIT_MS=15000;
export const RESOURCE_READINESS_TIMEOUT_MS=5000;

/** One wait for the top-level state; child snapshots share its settled interval. */
export async function waitForCaptureReadiness(page,{waitMs=MINIMUM_CAPTURE_WAIT_MS}={}){
 const minimumWaitMs=Math.max(MINIMUM_CAPTURE_WAIT_MS,Math.min(30000,Number.isFinite(waitMs)?waitMs:MINIMUM_CAPTURE_WAIT_MS));
 const result={minimumWaitMs,resourceTimeoutMs:RESOURCE_READINESS_TIMEOUT_MS,startedAt:new Date().toISOString(),status:'waiting'};
 await page.waitForTimeout(minimumWaitMs);
 const resources=await waitForVisibleResources(page,RESOURCE_READINESS_TIMEOUT_MS);
 return {...result,...resources,startedAt:result.startedAt,resourceStartedAt:resources.startedAt};
}

export async function waitForVisibleResources(page,timeoutMs=RESOURCE_READINESS_TIMEOUT_MS){
 const result={resourceTimeoutMs:timeoutMs,startedAt:new Date().toISOString(),status:'waiting'};
 const resourceDeadline=Date.now()+timeoutMs;
 try{
  await page.waitForFunction(()=>{
   const visible=[...document.images].filter(image=>{const r=image.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;});
   return visible.every(image=>image.complete)&&(!document.fonts||document.fonts.status==='loaded');
  },null,{timeout:timeoutMs,polling:250});
  let timer;
  try{
   result.images=await Promise.race([page.evaluate(async()=>{
    const images=[...document.images].filter(image=>{const r=image.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;});
    const results=await Promise.allSettled(images.filter(image=>image.complete&&image.naturalWidth>0).map(image=>image.decode()));
    return {visible:images.length,decoded:results.filter(r=>r.status==='fulfilled').length,decodeFailed:results.filter(r=>r.status==='rejected').length,pending:images.filter(i=>!i.complete).length,failed:images.filter(i=>i.complete&&!i.naturalWidth).length};
   }),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=new Error('Image decode readiness deadline exceeded');error.name='TimeoutError';reject(error);},Math.max(1,resourceDeadline-Date.now()));})]);
  }finally{clearTimeout(timer);}
  result.status='ready';
 }catch(error){result.status=error?.name==='TimeoutError'?'timed-out':'unavailable';result.reason=error?.name==='TimeoutError'?'Visible image or font loading exceeded the bounded readiness check':'Image/font readiness could not be verified';}
 result.endedAt=new Date().toISOString();return result;
}
