/** Declarative boundary for recipes, including future model-generated proposals. */
const TYPES = ['click', 'hover', 'fill', 'select', 'check', 'scroll'];
const fail = message => { throw new TypeError(`Invalid recipe: ${message}`); };
const object = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
};
const keys = (value, allowed, path) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key} is not supported`);
};
const string = (value, path, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${path} must be a nonempty string (maximum ${max})`);
  return value;
};
const integer = (value, fallback, min, max, path) => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) fail(`${path} must be an integer from ${min} to ${max}`);
  return result;
};
const url = (value, path) => {
  string(value, path);
  let result;
  try { result = new URL(value); } catch { fail(`${path} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password) fail(`${path} must be an HTTP(S) URL without credentials`);
  return result;
};

export function validatePlan(input) {
  object(input, 'recipe');
  keys(input, ['site', 'steps', 'explore', 'maxExplore', 'settleMs', 'allowedOrigins'], 'recipe');
  object(input.site, 'site');
  keys(input.site, ['id', 'name', 'startUrl'], 'site');
  const id = string(input.site.id, 'site.id', 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail('site.id must contain lowercase letters, numbers and single hyphens');
  const startUrl = url(input.site.startUrl, 'site.startUrl');
  const origins = input.allowedOrigins ?? [startUrl.origin];
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 100) fail('allowedOrigins must contain 1–100 origins');
  const allowedOrigins = [...new Set(origins.map((value, i) => {
    const parsed = url(value, `allowedOrigins[${i}]`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) fail(`allowedOrigins[${i}] must be an origin, without path, query or fragment`);
    return parsed.origin;
  }))];
  if (!allowedOrigins.includes(startUrl.origin)) fail('allowedOrigins must include the starting origin');
  if (input.explore !== undefined && typeof input.explore !== 'boolean') fail('explore must be boolean');
  if (!Array.isArray(input.steps) || input.steps.length > 1000) fail('steps must be an array with at most 1000 actions');
  const steps = input.steps.map((step, index) => {
    const path = `steps[${index}]`;
    object(step, path);
    keys(step, ['type', 'selector', 'frameSelector', 'label', 'value'], path);
    if (!TYPES.includes(step.type)) fail(`${path}.type is not a supported action`);
    const selector = string(step.selector, `${path}.selector`);
    const frameSelector = step.frameSelector === undefined ? undefined : string(step.frameSelector, `${path}.frameSelector`);
    const label = string(step.label, `${path}.label`, 300);
    if (['fill', 'select'].includes(step.type)) {
      if (typeof step.value !== 'string' || step.value.length > 10000) fail(`${path}.value must be a string with at most 10000 characters`);
    } else if (step.value !== undefined) fail(`${path}.value is only supported for fill/select`);
    return { type: step.type, selector, label, ...(frameSelector !== undefined ? { frameSelector } : {}), ...(step.value !== undefined ? { value: step.value } : {}) };
  });
  return {
    site: { id, name: string(input.site.name, 'site.name', 300), startUrl: startUrl.href },
    allowedOrigins, steps,
    explore: input.explore ?? false,
    maxExplore: integer(input.maxExplore, 20, 0, 500, 'maxExplore'),
    settleMs: Math.max(15000,integer(input.settleMs, 15000, 0, 30000, 'settleMs'))
  };
}

// A provider-independent tool contract. It is not an AI provider integration.
export const PLANNER_TOOL = Object.freeze({
  name: 'propose_research_recipe',
  description: 'Return a declarative journey using observed selectors. No JavaScript, shell commands, credential entry, purchases or reservation submissions. Validate with validatePlan before execution. Navigation origins are explicit; third-party resource recording is not restricted by this list.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['site', 'steps'],
    properties: {
      site: { type: 'object', additionalProperties: false, required: ['id', 'name', 'startUrl'], properties: { id: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 80 }, name: { type: 'string', minLength: 1, maxLength: 300 }, startUrl: { type: 'string', format: 'uri' } } },
      allowedOrigins: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', format: 'uri' } },
      steps: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['type', 'selector', 'label'], properties: { type: { enum: TYPES }, selector: { type: 'string', minLength: 1, maxLength: 2000 }, frameSelector: { type: 'string', minLength: 1, maxLength: 2000 }, label: { type: 'string', minLength: 1, maxLength: 300 }, value: { type: 'string', maxLength: 10000 } } } },
      explore: { type: 'boolean' }, maxExplore: { type: 'integer', minimum: 0, maximum: 500 }, settleMs: { type: 'integer', minimum: 0, maximum: 30000 }
    }
  }
});
