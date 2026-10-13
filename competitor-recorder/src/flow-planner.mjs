import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { exclusion } from './explore.mjs';

export const FLOW_CATEGORIES = Object.freeze(['room', 'spa', 'dining', 'tickets', 'activities', 'packages', 'other', 'unknown']);
export const FLOW_DISCOVERY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['flows'], properties: {
    flows: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['name', 'category', 'selector', 'frameSelector', 'reason'], properties: {
      name: { type: 'string' }, category: { type: 'string', enum: FLOW_CATEGORIES }, selector: { type: 'string' }, frameSelector: { type: ['string', 'null'] }, reason: { type: 'string' }
    } } }
  }
};
const targetKey = target => JSON.stringify([target.frameSelector || '', target.selector]);
const text = (value, label, max = 2000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${label} must be nonempty text up to ${max} characters`); return value; };
const identity = flow => flow.href ? `url:${flow.href}` : JSON.stringify([flow.sourceUrl, flow.frameSelector || '', flow.selector]);

export async function discoverFlowsWithModel({ client, model, state, history = [], researchFocus = 'Discover booking journeys', previousFlows = [] }) {
  if (!client || typeof client.discover !== 'function') throw new TypeError('A configured client.discover adapter is required');
  text(model, 'model', 200); text(researchFocus, 'researchFocus', 2000);
  if (!state || !Array.isArray(state.elements) || !Array.isArray(history) || !Array.isArray(previousFlows)) throw new TypeError('Observed state, action history and previousFlows are required');
  const inventory = [...state.elements, ...(state.frames || []).flatMap(frame => frame.elements || [])];
  const observed = new Map();
  for (const element of inventory) {
    text(element.selector, 'observed selector');
    if (observed.has(targetKey(element))) throw new TypeError('Observed flow target is ambiguous');
    observed.set(targetKey(element), element);
  }
  const instructions = await readFile(new URL('../prompts/flow-discovery.txt', import.meta.url), 'utf8');
  const context = {
    researchFocus, state: { id: state.id, url: state.url, title: state.title },
    elements: inventory.map(element => Object.fromEntries(['selector', 'frameSelector', 'name', 'role', 'tag', 'href', 'status', 'disabled', 'visible'].filter(key => element[key] !== undefined).map(key => [key, typeof element[key] === 'string' ? element[key].slice(0, 2000) : element[key]]))),
    history: history.slice(-20).map(action => Object.fromEntries(['type', 'selector', 'frameSelector', 'label', 'status'].filter(key => typeof action?.[key] === 'string').map(key => [key, action[key].slice(0, 2000)])))
  };
  const response = await client.discover({ model, instructions, context, schema: FLOW_DISCOVERY_SCHEMA });
  let result = response;
  if (typeof response === 'string') { try { result = JSON.parse(response); } catch { throw new TypeError('Discovery must return a JSON object'); } }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => key !== 'flows') || !Array.isArray(result.flows) || result.flows.length > 30) throw new TypeError('Discovery must return at most 30 flows');
  const previous = new Map(previousFlows.map(flow => [identity(flow), flow]));
  const flows = [], seen = new Set();
  for (const candidate of result.flows) {
    if (!candidate || typeof candidate !== 'object' || Object.keys(candidate).some(key => !['name', 'category', 'selector', 'frameSelector', 'reason'].includes(key))) throw new TypeError('Unsupported discovery fields');
    text(candidate.name, 'flow name', 300); text(candidate.selector, 'flow selector'); text(candidate.reason, 'flow reason');
    if (!FLOW_CATEGORIES.includes(candidate.category)) throw new TypeError('Unsupported flow category');
    if (candidate.frameSelector !== null && candidate.frameSelector !== undefined) text(candidate.frameSelector, 'frameSelector');
    const element = observed.get(targetKey(candidate));
    if (!element) throw new TypeError('Discovery proposed an unobserved target');
    if (element.disabled || element.visible === false || ['blocked', 'excluded'].includes(element.status) || exclusion(element)) throw new TypeError('Discovery proposed an unavailable target');
    let href = null;
    if (element.href) { try { const url = new URL(element.href, state.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) href = url.href; } catch {} }
    const flow = { name: candidate.name, category: candidate.category, categorySource: 'model-inference', selector: element.selector, ...(element.frameSelector ? { frameSelector: element.frameSelector } : {}), href, sourceUrl: state.url, sourceStateId: state.id, reason: candidate.reason, evidence: { name: element.name || '', href, selector: element.selector, frameSelector: element.frameSelector || null } };
    const key = identity(flow); if (seen.has(key)) continue; seen.add(key);
    const prior = previous.get(key);
    flow.id = prior?.id || 'flow-' + createHash('sha256').update(key).digest('hex').slice(0, 16);
    flow.status = ['untested', 'explored', 'blocked', 'excluded', 'in-progress'].includes(prior?.status) ? prior.status : 'untested';
    flows.push(flow);
  }
  // Earlier candidates remain visible even when not present in the current state.
  for (const prior of previousFlows) if (!seen.has(identity(prior))) flows.push(prior);
  return { flows, provenance: { kind: 'model-discovery', model, stateId: state.id, identifiedAt: new Date().toISOString(), executed: false } };
}
