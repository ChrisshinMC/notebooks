// Platform identification describes browser evidence, not successful ingestion.
const hostIs = (host, domain) => host === domain || host.endsWith('.' + domain);
export const platformSources = {
  ga4: 'https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference',
  gtm: 'https://developers.google.com/tag-platform/tag-manager',
  'google-ads': 'https://developers.google.com/tag-platform/devguides/conversions',
  pinterest: 'https://developer.pinterest.com/docs/track-conversions/pinterest-tag/',
  'adobe-analytics': 'https://experienceleague.adobe.com/en/docs/analytics-learn/tutorials/implementation/implementation-basics/how-to-identify-your-analytics-tracking-server-and-report-suites'
};
function match(id,name,kind,evidence,confidence='endpoint-match') {
  return {id,name,kind,evidence,confidence,source:platformSources[id]||null};
}
export function classifyRequest(request) {
  let u; try {u=new URL(request.url);} catch {return null;}
  const h=u.hostname.toLowerCase(),p=u.pathname;
  if ((hostIs(h,'google-analytics.com')||hostIs(h,'analytics.google.com')) && /^\/(?:g|mp|debug\/mp)\/collect\/?$/.test(p))
    return match('ga4','Google Analytics 4','collection','Google Analytics collection host and GA4 endpoint');
  if (hostIs(h,'googletagmanager.com') && p==='/gtm.js')
    return match('gtm','Google Tag Manager','library','GTM container script; this alone is not an analytics event');
  if (hostIs(h,'googletagmanager.com') && p==='/gtag/js')
    return match('google-tag','Google tag','library','Shared Google tag script; the URL alone does not establish which products receive events');
  if ((hostIs(h,'googleadservices.com')||hostIs(h,'googleads.g.doubleclick.net')||hostIs(h,'google.com')) && /^\/(?:pagead\/(?:1p-)?(?:viewthrough)?conversion|ccm\/conversion)(?:\/|$)/.test(p))
    return match('google-ads','Google Ads','collection','Google advertising host and conversion endpoint');
  if(h==='ct.pinterest.com') return match('pinterest','Pinterest','collection','Pinterest collection host');
  if(h==='s.pinimg.com' && /\/ct\//.test(p)) return match('pinterest','Pinterest','library','Pinterest tag resource; no event implied');
  if(/^\/b\/ss\/[^/]+\//.test(p)) return match('adobe-analytics','Adobe Analytics','collection','Adobe Analytics beacon path; hostname may be first-party','signature-match');
  if(hostIs(h,'adobedc.net') && /^\/ee\//.test(p)) return match('adobe-edge','Adobe Experience Platform Edge','collection','Adobe Edge endpoint; downstream Adobe Analytics routing is not visible');
  if(hostIs(h,'adobedtm.com') && /\.js$/.test(p)) return match('adobe-tags','Adobe Experience Platform Tags','library','Adobe tag library; not proof of an Adobe Analytics event');
  if(hostIs(h,'facebook.com') && /^\/tr\/?$/.test(p)) return match('meta','Meta Pixel','collection','Meta Pixel collection endpoint');
  if(h==='connect.facebook.net' && /fbevents\.js$/.test(p)) return match('meta','Meta Pixel','library','Meta Pixel script resource; no event implied');
  return null;
}

// Arrays retain duplicate parameters and batch records; fields are not renamed.
export function decodeRequest(request) {
  let query=[]; try {query=[...new URL(request.url).searchParams].map(([name,value])=>({name,value}));}catch{}
  const headers=request.headers||{};
  const contentType=Object.entries(headers).find(([name])=>name.toLowerCase()==='content-type')?.[1]||'';
  const text=typeof request.postData==='string'?request.postData:request.postData?.text;
  let body={format:'unavailable',value:null};
  if(typeof text==='string') {
    if(!text) body={format:'empty',value:''};
    else if(/json/i.test(contentType)||/^[\s]*[\[{]/.test(text)) {
      try{body={format:'json',value:JSON.parse(text)};}catch{body={format:'text',value:text};}
    } else if(/x-www-form-urlencoded/i.test(contentType)) {
      body={format:'form',value:[...new URLSearchParams(text)].map(([name,value])=>({name,value}))};
    } else if(classifyRequest(request)?.id==='ga4' && text.includes('=')) {
      body={format:'parameter-batch',value:text.split(/\r?\n/).filter(Boolean).map(line=>[...new URLSearchParams(line)].map(([name,value])=>({name,value})))};
    } else body={format:'text',value:text};
  }
  return {query,body};
}
