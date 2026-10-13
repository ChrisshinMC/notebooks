export const profiles = {
 desktop: {name:'desktop',viewport:{width:1920,height:1080},isMobile:false,hasTouch:false},
 tablet: {name:'tablet',viewport:{width:1024,height:1366},isMobile:true,hasTouch:true},
 mobile: {name:'mobile',viewport:{width:390,height:844},isMobile:true,hasTouch:true}
};
const forbidden = /\b(pay(?:ment)?|purchase|place order|confirm booking|complete reservation|submit booking|sign in|log in|delete|unsubscribe)\b/i;
export function exclusion(element) {
 if (forbidden.test(`${element.name || ''} ${element.type || ''}`)) return 'Transaction, authentication or destructive action';
 if (element.type === 'password' || element.type === 'file') return 'Sensitive input';
 return null;
}
export function validateRecipe(recipe) {
 if (!recipe || !recipe.site?.id || !recipe.site?.name) throw new Error('site.id and site.name are required');
 const url = new URL(recipe.site.startUrl);
 if (!['http:','https:'].includes(url.protocol)) throw new Error('Only HTTP(S) start URLs are allowed');
 if (!Array.isArray(recipe.steps) || recipe.steps.length > 250) throw new Error('steps must be an array of at most 250 actions');
 for (const step of recipe.steps) {
  if (!['click','hover','fill','select','check','scroll'].includes(step.type)) throw new Error(`Unsupported action: ${step.type}`);
  if (typeof step.selector !== 'string' || !step.selector) throw new Error('Each action needs an observed selector');
  if (exclusion({name:step.label,type:step.inputType})) throw new Error(`Excluded action: ${step.label}`);
  if (['fill','select'].includes(step.type) && typeof step.value !== 'string') throw new Error('fill/select require a string value');
 }
 return recipe;
}
// Suggested actions are deliberately restricted to reversible disclosure controls.
// Links and transactional controls need an explicit recipe, never blind crawling.
export function discoveryQueue(elements, limit=20) {
 return elements.filter(e => !exclusion(e) && e.status === 'discovered' &&
  (e.role === 'tab' || e.expanded === 'false' || e.tag === 'summary')).slice(0,limit)
  .map(e=>({type:'click',selector:e.selector,label:e.name,elementId:e.id,...(e.frameSelector?{frameSelector:e.frameSelector}:{})}));
}
