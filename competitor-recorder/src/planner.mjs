import { validatePlan, PLANNER_TOOL } from './plan-schema.mjs';
import { exclusion } from './explore.mjs';
import { readFile } from 'node:fs/promises';

/**
 * Injected model adapter. client.propose receives a JSON-safe input and must
 * return the recipe object (or its JSON string). It has no browser or shell.
 * The caller chooses the provider/model and grants navigation origins.
 * This produces a proposal; it never executes a journey by itself.
 */
export async function planWithModel({ client, model, inventory, site, allowedOrigins, history = [], currentUrl, objective = 'Review the visible booking journey', maxActions = 30 }) {
  if (!client || typeof client.propose !== 'function') throw new TypeError('A configured client.propose adapter is required');
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('Choose a model explicitly');
  if (!Array.isArray(inventory) || inventory.length > 20000) throw new TypeError('inventory must be an observed element array');
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 250) throw new TypeError('maxActions must be between 1 and 250');
  if (typeof objective !== 'string' || objective.length > 4000) throw new TypeError('objective must be a string of at most 4000 characters');
  if (!Array.isArray(history)) throw new TypeError('history must be an action array');
  if (currentUrl !== undefined && (typeof currentUrl !== 'string' || currentUrl.length > 4000)) throw new TypeError('currentUrl must be a URL string');
  const baseline = validatePlan({ site, allowedOrigins, steps: [] });
  const observed = new Map();
  const targetKey = element => JSON.stringify([element.frameSelector || '', element.selector]);
  for (const element of inventory) {
    if (!element || typeof element.selector !== 'string' || !element.selector) throw new TypeError('Every inventory element requires an observed selector');
    if (element.frameSelector !== undefined && (typeof element.frameSelector !== 'string' || !element.frameSelector.trim())) throw new TypeError('Inventory frameSelector must be a nonempty string');
    if (observed.has(targetKey(element))) throw new TypeError(`Ambiguous inventory selector: ${element.selector}`);
    observed.set(targetKey(element), element);
  }
  // Do not send cookies, network payloads, HTML or arbitrary extra element fields.
  const elements = inventory.map(e => Object.fromEntries(['id', 'selector', 'frameSelector', 'tag', 'role', 'name', 'type', 'expanded', 'status', 'disabled', 'visible'].filter(k => e[k] !== undefined).map(k => [k, typeof e[k] === 'string' ? e[k].slice(0, 2000) : e[k]])));
  const recentActions = history.slice(-20).map(action => Object.fromEntries(['type', 'selector', 'frameSelector', 'label', 'status'].filter(key => typeof action?.[key] === 'string').map(key => [key, action[key].slice(0, 2000)])));
  const bookingInstructions = await readFile(new URL('../prompts/next-interaction.txt', import.meta.url), 'utf8');
  const response = await client.propose({
    model,
    instructions: bookingInstructions + '\nReturn only a recipe matching the tool contract, with at most maxActions actions and exploration off.',
    tool: PLANNER_TOOL,
    context: { site: baseline.site, allowedOrigins: baseline.allowedOrigins, currentUrl: currentUrl || baseline.site.startUrl, history: recentActions, objective, maxActions, elements }
  });
  let candidate = response;
  if (typeof response === 'string') {
    try { candidate = JSON.parse(response); } catch { throw new TypeError('Model response must be a recipe object or JSON, without prose or code fences'); }
  }
  const plan = validatePlan(candidate);
  if (JSON.stringify(plan.site) !== JSON.stringify(baseline.site)) throw new TypeError('Model cannot change site identity or starting URL');
  if (plan.allowedOrigins.some(origin => !baseline.allowedOrigins.includes(origin))) throw new TypeError('Model cannot add navigation origins');
  if (plan.explore) throw new TypeError('Model proposal cannot enable automatic exploration');
  if (plan.steps.length > maxActions) throw new TypeError('Model proposal exceeds action limit');
  for (const step of plan.steps) {
    const element = observed.get(targetKey(step));
    if (!element) throw new TypeError(`Model proposed an unobserved selector: ${step.selector}`);
    if (element.disabled || element.visible === false || ['blocked', 'excluded'].includes(element.status)) throw new TypeError(`Model proposed an unavailable element: ${step.selector}`);
    const reason = exclusion(element);
    if (reason) throw new TypeError(`Model proposed an excluded element: ${step.selector} (${reason})`);
  }
  return { plan, provenance: { kind: 'model-proposal', promptVersion: 'booking-interaction-1', model, observedElementCount: inventory.length, validatedAt: new Date().toISOString(), executed: false } };
}
