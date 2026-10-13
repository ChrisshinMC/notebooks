import { createHash } from 'node:crypto';
import { safeRead } from './bundle.mjs';

const canonical = value => JSON.stringify(stable(value));
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const delta = (left, right) => {
  const a = new Map(), b = new Map();
  for (const x of left) a.set(x, (a.get(x) || 0) + 1);
  for (const x of right) b.set(x, (b.get(x) || 0) + 1);
  const changes = [];
  for (const signature of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(signature) || 0, after = b.get(signature) || 0;
    if (before !== after) changes.push({ signature, before, after, difference: after - before });
  }
  return changes;
};
const actionKey = action => canonical([action.flowId || '', action.type, action.frameSelector || '', action.selector, action.label || '']);
const fields = (value, prefix = '') => {
  if (Array.isArray(value)) return value.flatMap(item => fields(item, `${prefix}[]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => fields(entry, `${prefix}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  return [prefix || '/'];
};
function removeJsonFields(value, omitted, path = '') {
  if (Array.isArray(value)) return value.map((item, i) => removeJsonFields(item, omitted, `${path}/${i}`));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(`${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)).map(([key, item]) => [key, removeJsonFields(item, omitted, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)]));
}
function requestShape(request, options) {
  let endpoint = request.url, query = [];
  try {
    const url = new URL(request.url); endpoint = url.origin + url.pathname;
    query = [...url.searchParams].filter(([key]) => !options.ignoreQueryParameters.includes(key)).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  } catch { /* Retain the raw invalid URL as evidence. */ }
  const headers = request.headers || {};
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
  const text = request.postData?.text;
  let payload = request.postData?.sha256 ? { sha256: request.postData.sha256 } : { captureStatus: request.postData?.status || 'unknown' };
  let bodyFields = [];
  if (typeof text === 'string') {
    if (/json/i.test(contentType)) {
      try {
        const json = JSON.parse(text); bodyFields = fields(json);
        payload = removeJsonFields(json, new Set(options.ignoreJsonPointers));
      } catch { payload = { invalidJson: text }; }
    } else if (/x-www-form-urlencoded/i.test(contentType)) {
      const values = [...new URLSearchParams(text)]; bodyFields = values.map(([key]) => key);
      payload = values.filter(([key]) => !options.ignoreFormFields.includes(key)).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    } else payload = { text };
  }
  return { endpoint, query, payload, bodyFields: [...new Set(bodyFields)].sort() };
}

/** Compares recorded evidence, not visual similarity or proof of causation. */
export function compareRuns(before, after, config = {}) {
  for (const key of Object.keys(config)) if (!['ignoreQueryParameters', 'ignoreFormFields', 'ignoreJsonPointers'].includes(key)) throw new TypeError(`Unknown comparison option: ${key}`);
  const options = { ignoreQueryParameters: [], ignoreFormFields: [], ignoreJsonPointers: [], ...config };
  for (const [key, value] of Object.entries(options)) if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new TypeError(`${key} must be a string array`);
  const sameSite = !!before.site?.id && before.site.id === after.site?.id && before.site.startUrl === after.site?.startUrl;
  const report = { schemaVersion: 1, beforeRunId: before.id, afterRunId: after.id, sameSite, options, comparable: sameSite, contextChanges: [], limitations: [
    'Request association is temporal, not causal. Request count changes may reflect background traffic.',
    'All query and payload values participate unless explicitly ignored in options. No incidental identifiers are silently discarded.',
    'HTML hashes measure exact captured content, not visual equivalence. Missing hashes are unknown, not equal.',
    'Actions align by flow, operation, selector, label and occurrence; a changed locator appears as removed/added.',
    'Only archived browser evidence is compared. Uncaptured bodies and frames remain unavailable.'
  ] };
  if (!sameSite) { report.reason = 'Different site IDs or starting URLs; no same-site regression comparison was performed.'; return report; }
  for (const key of ['device', 'recipeHash', 'browserVersion', 'locale', 'timezoneId', 'consentState', 'serviceWorkers']) {
    if (before[key] === undefined || after[key] === undefined) report.contextChanges.push({ field: key, status: 'unknown', before: before[key] ?? null, after: after[key] ?? null });
    else if (canonical(before[key]) !== canonical(after[key])) report.contextChanges.push({ field: key, status: 'changed', before: before[key], after: after[key] });
  }
  report.sameConditions = report.contextChanges.length === 0;
  const actionsBefore = before.actions || [], actionsAfter = after.actions || [];
  report.actions = delta(actionsBefore.map(actionKey), actionsAfter.map(actionKey));
  report.flows = delta((before.flows || []).map(flow => canonical([flow.id, flow.category, flow.status])), (after.flows || []).map(flow => canonical([flow.id, flow.category, flow.status])));
  const byKey = new Map();
  for (const action of actionsAfter) { const key = actionKey(action); if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(action); }
  report.actionOutcomes = [];
  for (const old of actionsBefore) { const newer = byKey.get(actionKey(old))?.shift(); if (newer && (old.status !== newer.status || old.error !== newer.error)) report.actionOutcomes.push({ action: actionKey(old), before: { status: old.status, error: old.error }, after: { status: newer.status, error: newer.error } }); }
  const requestSignatures = run => {
    const owners = new Map(), occurrences = new Map();
    for (const action of run.actions || []) {
      const key = actionKey(action), occurrence = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, occurrence); owners.set(action.id, `${key}#${occurrence}`);
    }
    return (run.requests || []).map(request => {
      const shape = requestShape(request, options);
      return { signature: canonical({ action: owners.get(request.actionId) || 'unassigned', method: request.method, endpoint: shape.endpoint, query: shape.query, payload: shape.payload, status: request.response?.status ?? request.failure ?? 'unknown' }), fields: canonical({ endpoint: shape.endpoint, method: request.method, query: shape.query.map(([key]) => key), body: shape.bodyFields }) };
    });
  };
  const a = requestSignatures(before), b = requestSignatures(after);
  report.requests = delta(a.map(x => x.signature), b.map(x => x.signature));
  report.transferredFields = delta(a.map(x => x.fields), b.map(x => x.fields));
  report.assets = delta((before.assets || []).map(x => canonical([x.url, x.sha256 || null, x.status])), (after.assets || []).map(x => canonical([x.url, x.sha256 || null, x.status])));
  report.states = [];
  const statesBefore = before.states || [], statesAfter = after.states || [];
  for (let i = 0; i < Math.max(statesBefore.length, statesAfter.length); i++) {
    const old = statesBefore[i], newer = statesAfter[i];
    report.states.push({ index: i, before: old?.id ?? null, after: newer?.id ?? null, status: !old ? 'added' : !newer ? 'removed' : !old.domHash || !newer.domHash ? 'unknown' : old.domHash === newer.domHash ? 'unchanged' : 'changed' });
  }
  return report;
}

export async function loadComparisonRun(folder) {
  const run = JSON.parse(await safeRead(folder, 'run.json', 'utf8'));
  if (run.browserVersion === undefined && run.environment?.browserVersion !== undefined) run.browserVersion = run.environment.browserVersion;
  try { run.recipeHash = hash(canonical(JSON.parse(await safeRead(folder, 'recipe.json', 'utf8')))); } catch { /* Missing recipe remains unknown. */ }
  for (const state of run.states || []) try { state.domHash = hash(await safeRead(folder, state.rawHtml || state.html)); } catch { /* Missing DOM remains unknown. */ }
  for (const request of run.requests || []) {
    const type = Object.entries(request.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
    if (request.postData?.path && /json|text|x-www-form-urlencoded/i.test(type)) try { request.postData.text = await safeRead(folder, request.postData.path, 'utf8'); } catch { /* Hash/capture status remains available. */ }
  }
  return run;
}
