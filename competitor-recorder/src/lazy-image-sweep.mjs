import {waitForVisibleResources} from './capture-readiness.mjs';

export const SCROLL_SWEEP_LIMITS=Object.freeze({sections:32,durationMs:30000,height:40000,sectionSettleMs:250,sectionReadinessMs:1000});
const measure=page=>page.evaluate(()=>({url:location.href,x:scrollX,y:scrollY,viewportWidth:innerWidth,viewportHeight:innerHeight,documentHeight:document.documentElement.scrollHeight}));
const valid=g=>g&&Number.isFinite(g.x)&&Number.isFinite(g.y)&&g.viewportWidth>0&&g.viewportHeight>0&&g.documentHeight>0;

/** Scrolls the actual document; never changes viewport dimensions or site CSS. */
export async function sweepLazyImages(page,{deadline=Infinity,onOperation}={}){
 const report={status:'unavailable',startedAt:new Date().toISOString(),sections:[],limits:{...SCROLL_SWEEP_LIMITS},gaps:[]};
 let original;try{original=await measure(page);}catch{report.reason='Document geometry could not be read';return report;}
 if(!valid(original)){report.reason='Document geometry unavailable';return report;}
 report.original=original;
 if(original.documentHeight<=original.viewportHeight){report.status='not-needed';report.restored=true;report.endedAt=new Date().toISOString();return report;}
 const stopAt=Math.min(deadline-2000,Date.now()+SCROLL_SWEEP_LIMITS.durationMs);
 if(stopAt<=Date.now()){report.status='partial';report.reason='Run deadline leaves no scroll-sweep budget';report.restored=true;return report;}
 await onOperation?.({phase:'start',details:report});
 let last=original,maxCovered=0;
 try{
  for(let index=0;index<SCROLL_SWEEP_LIMITS.sections;index++){
   if(Date.now()>=stopAt){report.reason='scroll-time-budget';break;}
   const target=Math.min(index*Math.max(1,Math.floor(original.viewportHeight*.8)),last.documentHeight-original.viewportHeight,SCROLL_SWEEP_LIMITS.height-original.viewportHeight);
   await page.evaluate(position=>window.scrollTo({left:position.x,top:position.y,behavior:'instant'}),{x:original.x,y:Math.max(0,target)});
   await page.waitForTimeout(Math.min(SCROLL_SWEEP_LIMITS.sectionSettleMs,Math.max(1,stopAt-Date.now())));
   const readiness=await waitForVisibleResources(page,Math.min(SCROLL_SWEEP_LIMITS.sectionReadinessMs,Math.max(1,stopAt-Date.now())));
   last=await measure(page);if(!valid(last))throw new Error('Document geometry unavailable after scrolling');
   report.sections.push({x:last.x,y:last.y,documentHeight:last.documentHeight,readiness});
   maxCovered=Math.max(maxCovered,last.y+last.viewportHeight);
   if(last.url!==original.url){report.reason='page-navigated-during-scroll';break;}
   if(last.viewportWidth!==original.viewportWidth||last.viewportHeight!==original.viewportHeight){report.reason='viewport-changed-during-scroll';break;}
   if(index>0&&Math.abs(last.y-target)>2&&report.sections.at(-2)?.y===last.y){report.reason='scroll-position-blocked';break;}
   if(last.y+last.viewportHeight>=last.documentHeight-2){report.reason='document-end';break;}
   if(target>=SCROLL_SWEEP_LIMITS.height-original.viewportHeight){report.reason='scroll-height-budget';break;}
  }
  report.reason||='scroll-section-budget';
  report.coveredHeight=maxCovered;report.finalDocumentHeight=last.documentHeight;report.documentGrowth=Math.max(0,last.documentHeight-original.documentHeight);
  if(report.reason!=='document-end')report.gaps.push('The bounded sweep did not visit the entire current document.');
  if(report.sections.some(section=>section.readiness.status!=='ready'||section.readiness.images?.pending||section.readiness.images?.failed||section.readiness.images?.decodeFailed))report.gaps.push('Some visited sections had unresolved or failed resources.');
  report.status=report.gaps.length?'partial':'completed';
 }catch(error){report.status='partial';report.reason=error.message;report.gaps.push('Scroll sweep interrupted before every section could be observed.');}
 finally{
  try{
   await page.evaluate(position=>window.scrollTo({left:position.x,top:position.y,behavior:'instant'}),{x:original.x,y:original.y});
   await page.waitForTimeout(500);
   report.restoreReadiness=await waitForVisibleResources(page,Math.min(1500,Math.max(1,deadline-Date.now())));
   const restored=await measure(page);report.restored=valid(restored)&&restored.url===original.url&&Math.abs(restored.x-original.x)<=2&&Math.abs(restored.y-original.y)<=2&&restored.viewportWidth===original.viewportWidth&&restored.viewportHeight===original.viewportHeight;
   if(report.restoreReadiness.status!=='ready'||report.restoreReadiness.images?.failed||report.restoreReadiness.images?.pending||report.restoreReadiness.images?.decodeFailed){report.status='partial';report.gaps.push('The restored viewport still has unresolved or failed resources.');}
   if(!report.restored){report.status='partial';report.gaps.push('Original page position or viewport could not be confirmed after restoration.');}
  }catch{report.status='partial';report.restored=false;report.gaps.push('Restoring the original scroll position failed.');}
  report.endedAt=new Date().toISOString();await onOperation?.({phase:'end',details:report});
 }
 return report;
}
