import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {profiles,discoveryQueue,exclusion} from './explore.mjs';
import {snapshot} from './snapshot.mjs';
import {validatePlan} from './plan-schema.mjs';

export async function settleWithin(promise,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Capture deadline exceeded')),ms);})]);}finally{clearTimeout(timer);}}

export async function record(recipe, output, deviceName='desktop', browserType, hooks={}) {
 recipe=validatePlan(recipe);
 const plannerLimit=hooks.maxActions??20;
 if(!Number.isInteger(plannerLimit)||plannerLimit<0||plannerLimit>100)throw new Error('Planner maxActions must be 0..100');
 if(hooks.proposeNext!==undefined&&typeof hooks.proposeNext!=='function')throw new Error('proposeNext must be a function');
 const flowLimit=hooks.maxFlows??5,perFlowLimit=hooks.maxActionsPerFlow??5;
 if(!Number.isInteger(flowLimit)||flowLimit<1||flowLimit>20||!Number.isInteger(perFlowLimit)||perFlowLimit<1||perFlowLimit>20)throw new Error('Flow budgets must be integers 1..20');
 const device=profiles[deviceName];if(!device)throw new Error('Unknown device');
 // A fresh directory per run prevents a rerun silently replacing evidence.
 const folder=path.resolve(output);await mkdir(folder,{recursive:false});
 await mkdir(path.join(folder,'bodies'));
 await writeFile(path.join(folder,'recipe.json'),JSON.stringify(recipe,null,2));
 const run={schemaVersion:1,id:randomUUID(),site:recipe.site,device,startedAt:new Date().toISOString(),status:'recording',states:[],actions:[],requests:[],webSockets:[],assets:[],plannerDecisions:[],navigationScopeChanges:[],flows:[],navigations:[],flowDiscovery:[],captureOperations:[],limitations:[
  'Browser-observed traffic only. Not a packet capture or server-side traffic record.',
  'Action attribution is a time window, not proof of causation. Delayed/background requests may overlap.',
  'Service workers are blocked for repeatability; this can change site behavior.',
  'Navigation origin enforcement uses routing, which disables HTTP cache. Run conditions differ from an established user session.',
  'HTTP streaming bodies may be unavailable. WebSocket frames observed after attachment are recorded separately.',
  'Raw evidence contains potentially sensitive data. Do not share without review/redaction.',
  'Device profiles emulate viewport/touch; they are not physical-device measurements.'
 ]};
 run.recipeHash=createHash('sha256').update(JSON.stringify(recipe)).digest('hex');run.environment={node:process.version,platform:process.platform,architecture:process.arch};
 run.budgets={runMs:600000,drainMs:5000,actionMs:15000};
 const deadline=Date.now()+run.budgets.runMs;
 let browser,context,activeAction=null,activeNavigation=null,activeCaptureOperation=null,currentFlow=null,popupSource=null,popupListener=null,actionPopups=[],sequence=0,finalized=false,finalRun;const pending=new Set(),requestMap=new WeakMap();
 const bounded=settleWithin;
 async function checkpoint(phase,manifest=run){
  const bytes=JSON.stringify(manifest,null,2),temporary=path.join(folder,'.run.json.tmp');
  await writeFile(temporary,bytes);await rename(temporary,path.join(folder,'run.json'));
  if(hooks.onProgress)try{await bounded(Promise.resolve(hooks.onProgress({phase,status:manifest.status,states:manifest.states.length,actions:manifest.actions.length,requests:manifest.requests.length,plannerDecisions:manifest.plannerDecisions.length})),1000);}catch(e){run.limitations.push('Progress callback: '+e.message);}
 }
 async function drain(){try{await bounded(Promise.allSettled([...pending]));}catch{run.limitations.push(`${pending.size} capture tasks still pending after drain deadline`);}}
 const track=promise=>{pending.add(promise);promise.catch(e=>run.limitations.push('Capture error: '+e.message)).finally(()=>pending.delete(promise));};
 async function body(buffer) {
  if(finalized)return {status:'unavailable',reason:'Capture finalized'};
  if(buffer==null)return {status:'absent',bytes:0};
  const hash=createHash('sha256').update(buffer).digest('hex'),p=`bodies/${hash}`;
  await writeFile(path.join(folder,p),buffer);return {status:'captured',path:p,bytes:buffer.length,sha256:hash};
 }
 try {
  browser=await browserType.launch({headless:recipe.headless!==false});
  run.environment.browserVersion=browser.version();
  context=await browser.newContext({viewport:device.viewport,isMobile:device.isMobile,hasTouch:device.hasTouch,serviceWorkers:'block',recordHar:{path:path.join(folder,'network.har.zip'),mode:'full',content:'attach'}});
  context.setDefaultTimeout(run.budgets.actionMs);context.setDefaultNavigationTimeout(45000);
  context.on('request',req=>{
   const entry={id:'request-'+(++sequence),url:req.url(),method:req.method(),resourceType:req.resourceType(),startedAt:new Date().toISOString(),actionId:activeCaptureOperation?null:activeAction?.id||null,navigationId:activeCaptureOperation?null:activeNavigation?.id||null,captureOperationId:activeCaptureOperation?.id||null,flowId:currentFlow?.id||null,attribution:'temporal-window-not-causality',headers:{},postData:{status:'pending'}};
   const previous=req.redirectedFrom?.();if(previous)entry.redirectedFromId=requestMap.get(previous)?.id||null;
   try{const frame=req.frame();entry.frame={url:frame.url(),isMainFrame:!frame.parentFrame(),pageUrl:frame.page().url()};}catch{entry.frame={status:'unavailable',reason:'No frame associated with request'};}
   run.requests.push(entry);requestMap.set(req,entry);if(activeCaptureOperation)activeCaptureOperation.requestIds.push(entry.id);else{activeAction?.requestIds.push(entry.id);activeNavigation?.requestIds.push(entry.id);}
   track((async()=>{entry.headers=await req.allHeaders();entry.postData=await body(req.postDataBuffer());})());
  });
  context.on('response',response=>track((async()=>{
   const entry=requestMap.get(response.request());if(!entry)return;
   const headers=await response.allHeaders();if(finalized)return;
   entry.response={...entry.response,status:response.status(),headers,fromServiceWorker:response.fromServiceWorker(),body:entry.response?.body||{status:'pending'}};
  })()));
  context.on('requestfinished',req=>track((async()=>{
   const entry=requestMap.get(req);if(!entry)return;
   const response=await req.response();entry.timing=req.timing();entry.finishedAt=new Date().toISOString();
   if(!response){entry.response={body:{status:'unavailable',reason:'No response object'}};return;}
   entry.response={status:response.status(),headers:await response.allHeaders(),fromServiceWorker:response.fromServiceWorker(),body:{status:'pending'}};
   try {entry.response.body=await body(await response.body());
    if(['document','stylesheet','script','image','font','media'].includes(entry.resourceType)){
     const asset={url:entry.url,requestId:entry.id,capturedAt:entry.finishedAt,resourceType:entry.resourceType,...entry.response.body,contentType:entry.response.headers['content-type']||''};run.assets.push(asset);
    }
   }catch(e){entry.response.body={status:'unavailable',reason:e.message};}
  })()));
  context.on('requestfailed',req=>{const entry=requestMap.get(req);if(entry){entry.failure=req.failure()?.errorText;entry.finishedAt=new Date().toISOString();entry.response={...entry.response,body:{status:'unavailable',reason:entry.failure}};}});
  context.on('page',p=>p.on('websocket',socket=>{
   const ws={url:socket.url(),openedAt:new Date().toISOString(),frames:[]};run.webSockets.push(ws);
   for(const [event,direction]of[['framesent','sent'],['framereceived','received']])socket.on(event,frame=>{ws.frames.push({direction,at:new Date().toISOString(),actionId:activeCaptureOperation?null:activeAction?.id||null,captureOperationId:activeCaptureOperation?.id||null,encoding:Buffer.isBuffer(frame.payload)?'base64':'utf8',data:Buffer.isBuffer(frame.payload)?frame.payload.toString('base64'):frame.payload});});
   socket.on('close',()=>ws.closedAt=new Date().toISOString());
  }));
  const allowed=[...(recipe.allowedOrigins||[new URL(recipe.site.startUrl).origin])];
  await context.route('**/*',route=>{
   const req=route.request();
   let topLevel=false;try{topLevel=!req.frame().parentFrame();}catch{topLevel=true;}
   if(req.isNavigationRequest()&&topLevel&&!allowed.includes(new URL(req.url()).origin)){
    run.limitations.push('Blocked navigation outside declared origins: '+req.url());return route.abort('blockedbyclient');
   }return route.continue();
  });
  let page=await context.newPage();
  await page.goto(recipe.site.startUrl,{waitUntil:'domcontentloaded',timeout:45000});
  const settle=async()=>{await drain();};
  async function captureState(id){
   if(Date.now()+recipe.settleMs>deadline)throw new Error('Run time budget cannot accommodate the minimum capture wait');
   await checkpoint('Loading page');
   const captureOperationIds=[];
   const state=await snapshot(page,folder,id,{fullPage:hooks.fullPageScreenshots!==false,waitMs:recipe.settleMs,deadline,scrollSweep:hooks.scrollSweep!==false,resolvePage:async current=>{
    const popup=actionPopups.find(p=>!p.isClosed?.());if(!popup)return current;
    let origin;try{origin=new URL(popup.url()).origin;}catch{}
    if(!allowed.includes(origin)){if(activeAction){activeAction.status='blocked';activeAction.error='Popup navigation outside declared origins or unavailable';}run.limitations.push('Action popup could not be captured within declared navigation scope');return current;}
    await popup.waitForLoadState('domcontentloaded',{timeout:Math.max(1,Math.min(15000,deadline-Date.now()))});
    if(Date.now()+recipe.settleMs>deadline)throw new Error('Run time budget cannot accommodate popup capture wait');
    page=popup;return popup;
   },onCaptureOperation:async event=>{
    if(event.phase==='start'){
     activeCaptureOperation={id:'capture-operation-'+run.captureOperations.length,type:'lazy-image-scroll-sweep',stateId:id,flowId:currentFlow?.id||null,triggerActionId:activeAction?.id||null,triggerNavigationId:activeNavigation?.id||null,startedAt:new Date().toISOString(),status:'running',requestIds:[]};run.captureOperations.push(activeCaptureOperation);captureOperationIds.push(activeCaptureOperation.id);
    }else if(activeCaptureOperation){Object.assign(activeCaptureOperation,{endedAt:new Date().toISOString(),status:event.details.status,details:event.details});activeCaptureOperation=null;}
   }});
   state.captureOperationIds=captureOperationIds;
   const document=run.requests.findLast(r=>r.resourceType==='document'&&r.url===state.url);
   state.documentResponse={requestId:document?.id||null,status:document?.response?.status??null,availability:document?.response?.status!=null?'observed':'unavailable'};
   if(state.documentResponse.status>=400)state.qualityFlags.push({code:'document-http-error',severity:'warning',status:state.documentResponse.status,message:'The document returned an HTTP error status.'});
   return state;
  }
  await settle();run.states.push(await captureState('state-0'));await checkpoint('observed');
  const queue=[...recipe.steps];let explored=0,planned=0;const visited=new Set(),plannerVisited=new Set();
  async function proposeStep(state){
   if(hooks.proposeNext){
    if(planned>=plannerLimit){run.plannerStopReason='action-budget';return;}
    const decision={id:'decision-'+run.plannerDecisions.length,stateId:state.id,startedAt:new Date().toISOString(),status:'planning',provenance:{provider:hooks.provider||'injected',model:hooks.model||'unspecified'}};
    run.plannerDecisions.push(decision);
    try{
     const proposal=await bounded(hooks.proposeNext({site:structuredClone(recipe.site),allowedOrigins:[...allowed],state:structuredClone(state),history:structuredClone(run.actions),activeFlow:currentFlow?structuredClone(currentFlow):null,remainingActions:Math.min(plannerLimit-planned,currentFlow?perFlowLimit-currentFlow.actionIds.length:plannerLimit)}),Math.min(60000,Math.max(1,deadline-Date.now())));
     if(proposal===null){decision.status='stopped';run.plannerStopReason='planner-complete';return;}
     const normalized=validatePlan({...recipe,steps:[proposal]}).steps[0];
     const inventory=normalized.frameSelector?state.frames?.find(f=>f.frameSelector===normalized.frameSelector)?.elements||[]:state.elements;
     const targets=inventory.filter(e=>e.selector===normalized.selector);
     if(targets.length!==1)throw new Error('Planner target must match exactly one observed element');
     if(['excluded','blocked'].includes(targets[0].status)||exclusion(targets[0]))throw new Error('Planner target is excluded or blocked');
     const targetHash=normalized.frameSelector?state.frames?.find(f=>f.frameSelector===normalized.frameSelector)?.domHash:state.domHash;
     const key=JSON.stringify([state.url,targetHash,normalized.frameSelector||'',normalized.selector,normalized.type,normalized.value]);
     if(plannerVisited.has(key)){decision.status='stopped';run.plannerStopReason='repeated-action-in-unchanged-state';return;}
     plannerVisited.add(key);planned++;queue.push(normalized);decision.status='accepted';decision.action=normalized;
    }catch(e){decision.status='error';decision.error=e.message;run.plannerStopReason='planner-error';}
    finally{decision.endedAt=new Date().toISOString();await checkpoint('planned');}
    return;
   }
   if(!recipe.explore||explored>=recipe.maxExplore)return;
   const inventory=[...state.elements,...(state.frames||[]).flatMap(f=>f.elements||[])];
   const fingerprint=createHash('sha256').update(JSON.stringify([state.url,inventory.map(e=>[e.frameSelector,e.selector,e.name,e.expanded])])).digest('hex');
   const key=s=>fingerprint+'|'+(s.frameSelector||'')+'|'+s.selector;
   const candidate=discoveryQueue(inventory,500).find(s=>!visited.has(key(s)));
   if(candidate){visited.add(key(candidate));queue.push(candidate);explored++;}
  }
  const discoveredStates=new Set();let startedFlows=0;
  async function discoverCandidates(state){
   if(discoveredStates.has(state.id))return;discoveredStates.add(state.id);
   try{
    const result=await bounded(hooks.discoverFlows({state:structuredClone(state),history:structuredClone(run.actions),previousFlows:structuredClone(run.flows)}),Math.min(60000,Math.max(1,deadline-Date.now())));
    if(!result||!Array.isArray(result.flows)||result.flows.length>200)throw new Error('Flow discovery returned invalid candidates');
    const inventory=[...state.elements,...(state.frames||[]).flatMap(f=>f.elements||[])];
    for(const candidate of result.flows){
     if(!candidate||typeof candidate.id!=='string'||!candidate.id||candidate.id.length>100||typeof candidate.name!=='string'||!candidate.name||candidate.name.length>300||typeof candidate.selector!=='string')throw new Error('Invalid flow identity');
     if(run.flows.some(f=>f.id===candidate.id))continue;
     const matches=inventory.filter(e=>e.selector===candidate.selector&&(e.frameSelector||'')===(candidate.frameSelector||''));
     if(matches.length!==1||exclusion(matches[0])||['blocked','excluded'].includes(matches[0].status))throw new Error('Flow entry must be an available observed element');
     run.flows.push({...candidate,sourceStateId:state.id,sourceUrl:state.url,href:matches[0].href||null,status:'untested',actionIds:[],stateIds:[],evidence:{...candidate.evidence,name:matches[0].name,href:matches[0].href||null}});
    }
    run.flowDiscovery.push({stateId:state.id,status:'completed',provenance:result.provenance||null});
   }catch(e){run.flowDiscovery.push({stateId:state.id,status:'error',error:e.message});}
  }
  async function nextDiscovery(state){
   if(!hooks.discoverFlows)return proposeStep(state);
   await discoverCandidates(state);
   // A homepage may reveal its booking links only after a menu or tab action.
   if(!currentFlow&&!run.flows.length){await proposeStep(state);return;}
   if(currentFlow){
    const before=queue.length;
    if(currentFlow.actionIds.length<perFlowLimit&&planned<plannerLimit)await proposeStep(state);
    if(queue.length>before)return;
    currentFlow.status=run.actions.some(a=>a.flowId===currentFlow.id&&a.status==='blocked')||run.plannerStopReason==='planner-error'?'blocked':'explored';
    currentFlow.stopReason=planned>=plannerLimit?'shared-action-budget':currentFlow.actionIds.length>=perFlowLimit?'per-flow-action-budget':run.plannerStopReason||'no-further-observed-action';
    currentFlow.completeness='not-exhaustive';currentFlow=null;
   }
   while(planned<plannerLimit&&startedFlows<flowLimit){
    if(Date.now()>deadline)throw new Error('Run time budget exceeded during flow restoration');
    const flow=run.flows.find(f=>f.status==='untested');if(!flow)return;
    currentFlow=flow;flow.status='in-progress';startedFlows++;run.plannerStopReason=null;
    let source=run.states.at(-1);
    try{
     if(source.id!==flow.sourceStateId){
      const nav={id:'navigation-'+run.navigations.length,type:'restore-flow-source',flowId:flow.id,fromStateId:source.id,toStateId:null,url:flow.sourceUrl,status:'running',requestIds:[],startedAt:new Date().toISOString()};run.navigations.push(nav);activeNavigation=nav;
      try{await page.goto(flow.sourceUrl,{waitUntil:'domcontentloaded',timeout:45000});await settle();source=await captureState('state-'+run.states.length);source.flowId=flow.id;run.states.push(source);flow.stateIds.push(source.id);nav.toStateId=source.id;nav.status='completed';}catch(e){nav.status='blocked';nav.error=e.message;throw e;}finally{nav.endedAt=new Date().toISOString();activeNavigation=null;}
      // Replay only observed same-document discovery controls when a reload
      // drops the menu/tab state that originally exposed this entrypoint.
      const hasEntry=()=>{const list=flow.frameSelector?source.frames?.find(f=>f.frameSelector===flow.frameSelector)?.elements||[]:source.elements;return list.some(e=>e.selector===flow.selector&&e.name===flow.evidence.name&&(e.href||null)===(flow.href||null));};
      if(!hasEntry()){
       const replay=[];let targetId=flow.sourceStateId;
       while(replay.length<5){
        const prior=run.actions.find(a=>a.toStateId===targetId&&!a.flowId&&a.status==='completed');if(!prior)break;
        const before=run.states.find(s=>s.id===prior.fromStateId),after=run.states.find(s=>s.id===prior.toStateId);
        if(before?.url!==flow.sourceUrl||after?.url!==flow.sourceUrl||!['click','hover'].includes(prior.type))break;
        const list=prior.frameSelector?before.frames?.find(f=>f.frameSelector===prior.frameSelector)?.elements||[]:before.elements;
        const observed=list.find(e=>e.selector===prior.selector);
        if(!observed||exclusion(observed)||!(observed.expanded!==undefined&&observed.expanded!==null||['button','summary'].includes(observed.tag)||['tab','button','menuitem'].includes(observed.role)))break;
        replay.unshift({prior,observed});targetId=prior.fromStateId;
       }
       for(const {prior,observed}of replay){
        if(hasEntry())break;
        if(Date.now()>deadline)throw new Error('Run time budget exceeded during source interaction restoration');
        if(planned+1>=plannerLimit)throw new Error('Shared action budget cannot cover restoration and entry interaction');
        const liveList=prior.frameSelector?source.frames?.find(f=>f.frameSelector===prior.frameSelector)?.elements||[]:source.elements;
        const matches=liveList.filter(e=>e.selector===prior.selector&&e.name===observed.name);if(matches.length!==1)throw new Error('Cannot restore observed discovery control');
        const restore={id:'navigation-'+run.navigations.length,type:'restore-source-interaction',flowId:flow.id,fromStateId:source.id,toStateId:null,url:flow.sourceUrl,selector:prior.selector,frameSelector:prior.frameSelector||null,interactionType:prior.type,originalActionId:prior.id,status:'running',requestIds:[],startedAt:new Date().toISOString()};run.navigations.push(restore);activeNavigation=restore;
        planned++;
        try{
         const loc=prior.frameSelector?page.frameLocator(prior.frameSelector).locator(prior.selector):page.locator(prior.selector);if(await loc.count()!==1)throw new Error('Ambiguous restoration target');
         const live=await loc.evaluate(el=>({name:el.getAttribute('aria-label')||el.innerText||'',type:el.getAttribute('type')}));if(exclusion(live))throw new Error('Excluded restoration target');
         if(prior.type==='hover')await loc.hover();else await loc.click();await settle();
         source=await captureState('state-'+run.states.length);source.flowId=flow.id;run.states.push(source);flow.stateIds.push(source.id);restore.toStateId=source.id;restore.status='completed';
        }catch(e){restore.status='blocked';restore.error=e.message;throw e;}finally{restore.endedAt=new Date().toISOString();activeNavigation=null;await checkpoint('restored');}
       }
      }
     }
     const inventory=flow.frameSelector?source.frames?.find(f=>f.frameSelector===flow.frameSelector)?.elements||[]:source.elements;
     const targets=inventory.filter(e=>e.selector===flow.selector);
     if(targets.length!==1||targets[0].name!==flow.evidence.name||(targets[0].href||null)!==(flow.href||null))throw new Error('Restored entrypoint does not match captured element');
     if(!flow.stateIds.includes(source.id))flow.stateIds.push(source.id);
     queue.push({type:'click',selector:flow.selector,label:flow.name,...(flow.frameSelector?{frameSelector:flow.frameSelector}:{})});planned++;await checkpoint('flow-started');return;
    }catch(e){flow.status='blocked';flow.stopReason=e.message;currentFlow=null;await checkpoint('flow-blocked');}
   }
  }
  if(!queue.length)await nextDiscovery(run.states[0]);
  for(let i=0;i<queue.length;i++){
   if(Date.now()>deadline)throw new Error('Run time budget exceeded');
   const step=queue[i],from=run.states.at(-1),inventory=step.frameSelector?from.frames?.find(f=>f.frameSelector===step.frameSelector)?.elements||[]:from.elements,element=inventory.find(e=>e.selector===step.selector);
   const action={id:'action-'+i,...step,flowId:currentFlow?.id||null,elementId:element?.id||null,fromStateId:from.id,toStateId:null,startedAt:new Date().toISOString(),status:'running',requestIds:[],attribution:'temporal-window-not-causality'};
   currentFlow?.actionIds.push(action.id);
   run.actions.push(action);activeAction=action;
   try {
    if(step.frameSelector&&await page.locator(step.frameSelector).count()!==1)throw new Error('Frame selector does not uniquely match one frame');
    const locator=step.frameSelector?page.frameLocator(step.frameSelector).locator(step.selector):page.locator(step.selector);if(await locator.count()!==1)throw new Error('Selector does not uniquely match one element');
    const name=await locator.evaluate(el=>({name:el.getAttribute('aria-label')||el.innerText||'',type:el.getAttribute('type'),href:el.closest('a[href]')?.href||null}));
    const reason=exclusion(name);if(reason){if(element){element.status='excluded';element.reason=reason;}throw new Error(reason);}
    if(hooks.allowObservedNavigation===true&&step.type==='click'&&element?.href&&name.href===element.href){
     let destination;try{destination=new URL(element.href);}catch{}
     if(destination&&['https:','http:'].includes(destination.protocol)&&!destination.username&&!destination.password&&!allowed.includes(destination.origin)){
      allowed.push(destination.origin);run.navigationScopeChanges.push({origin:destination.origin,href:destination.href,sourceElement:element.id,frameSelector:step.frameSelector||null,actionId:action.id,at:new Date().toISOString(),reason:'observed-link'});
     }
    }
    popupSource=page;actionPopups=[];popupListener=popup=>actionPopups.push(popup);popupSource.on('popup',popupListener);
    if(step.type==='click')await locator.click();else if(step.type==='hover')await locator.hover();
    else if(step.type==='fill')await locator.fill(step.value);else if(step.type==='select')await locator.selectOption(step.value);
    else if(step.type==='check')await locator.check();else if(step.type==='scroll')await locator.scrollIntoViewIfNeeded();
    await settle();
    if(element)element.status='interacted';action.status='completed';
   }catch(e){action.status='blocked';action.error=e.message;if(element&&element.status!=='excluded'){element.status='blocked';element.reason=e.message;}}
   let state;
   try{state=await captureState('state-'+run.states.length);state.flowId=currentFlow?.id||null;run.states.push(state);action.toStateId=state.id;currentFlow?.stateIds.push(state.id);}
   finally{if(popupSource&&popupListener)popupSource.off('popup',popupListener);popupSource=null;popupListener=null;actionPopups=[];action.endedAt=new Date().toISOString();activeAction=null;}
   await checkpoint('observed');
   if(i===queue.length-1)await nextDiscovery(state);
  }
  await settle();run.status=run.actions.some(a=>a.status==='blocked')||run.plannerDecisions.some(d=>d.status==='error')||run.flowDiscovery.some(d=>d.status==='error')||run.flows.some(f=>f.status!=='explored')?'completed-with-gaps':'completed';
  if(hooks.discoverFlows)run.researchScope='Bounded exploration of discovered flow entrypoints; no claim of complete site or checkout coverage.';
 }catch(e){run.status='failed';run.error=e.message;}
 finally {
  await drain();
  if(context)await bounded(context.close(),10000).catch(e=>run.limitations.push('Context close/HAR flush: '+e.message));
  await drain();if(browser)await bounded(browser.close()).catch(e=>run.limitations.push(e.message));
  for(const entry of run.requests)if(!entry.response&&!entry.failure)entry.response={body:{status:'unavailable',reason:'Request unfinished when capture closed'}};
  run.endedAt=new Date().toISOString();
  for(const entry of run.requests){for(const value of [entry.postData,entry.response?.body])if(value?.status==='pending'){value.status='unavailable';value.reason='Capture task did not settle before close';}}
  finalized=true;
  finalRun=JSON.parse(JSON.stringify(run));
  await checkpoint('finished',finalRun);
 }
 return {folder,run:finalRun};
}
