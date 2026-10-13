import { createHash } from 'node:crypto';
import { safeRead } from './bundle.mjs';

/** Artifact integrity only: cannot prove traffic absent from the log was captured. */
export async function validateRun(folder) {
  const errors = [], warnings = [];
  let run;
  try { run = JSON.parse(await safeRead(folder, 'run.json', 'utf8')); }
  catch (error) { return { valid: false, errors: ['Cannot read run.json: ' + error.message], warnings, checked: {} }; }
  const checked = { states: 0, actions: 0, requests: 0, navigations: 0, captureOperations: 0, capturedBodies: 0, assets: 0, frames: 0 };
  const unique = (items, label) => {
    const ids = new Set();
    for (const item of items) {
      if (typeof item.id !== 'string' || !item.id) errors.push(`${label}: missing ID`);
      else if (ids.has(item.id)) errors.push(`${label}: duplicate ID ${item.id}`);
      ids.add(item.id);
    }
    return ids;
  };
  const states = run.states || [], actions = run.actions || [], requests = run.requests || [];
  if (![states, actions, requests].every(Array.isArray)) return { valid: false, errors: ['States, actions and requests must be arrays'], warnings, checked };
  const stateIds = unique(states, 'State'), actionIds = unique(actions, 'Action'), requestIds = unique(requests, 'Request');
  const flows = run.flows || [];
  if (!Array.isArray(flows)) return { valid: false, errors: ['Flows must be an array'], warnings, checked };
  const flowIds = unique(flows, 'Flow');
  const navigations = run.navigations || [];
  if (!Array.isArray(navigations)) return { valid: false, errors: ['Navigations must be an array'], warnings, checked };
  const navigationIds = unique(navigations, 'Navigation');
  const operations = run.captureOperations || [];
  if (!Array.isArray(operations)) return { valid: false, errors: ['Capture operations must be an array'], warnings, checked };
  const operationIds = unique(operations, 'Capture operation');
  for (const flow of flows) {
    if (!['untested', 'in-progress', 'explored', 'blocked', 'excluded'].includes(flow.status)) errors.push(`Flow ${flow.id}: unknown status`);
    if (!stateIds.has(flow.sourceStateId)) errors.push(`Flow ${flow.id}: missing discovery source state`);
    for (const id of flow.stateIds || []) if (!stateIds.has(id)) errors.push(`Flow ${flow.id}: missing state ${id}`);
    for (const id of flow.actionIds || []) {
      if (!actionIds.has(id)) errors.push(`Flow ${flow.id}: missing action ${id}`);
      else if (actions.find(action => action.id === id).flowId !== flow.id) errors.push(`Flow ${flow.id}: inconsistent action ownership ${id}`);
    }
  }
  for (const [label, items] of [['State', states], ['Action', actions], ['Request', requests]]) {
    for (const item of items) if (item.flowId && !flowIds.has(item.flowId)) errors.push(`${label} ${item.id}: missing associated flow`);
  }
  const read = async (relative, label) => {
    try { return await safeRead(folder, relative); }
    catch (error) { errors.push(`${label}: missing or unsafe artifact (${String(relative)}): ${error.message}`); return null; }
  };
  const verifyBody = async (value, label) => {
    if (!value) { warnings.push(`${label}: no body status recorded`); return; }
    if (!['captured', 'absent', 'unavailable', 'omitted', 'truncated'].includes(value.status)) { errors.push(`${label}: unknown or unfinished body status ${String(value.status)}`); return; }
    if (['unavailable', 'omitted', 'truncated'].includes(value.status)) {
      if (!value.reason) warnings.push(`${label}: ${value.status} without reason`);
      return;
    }
    if (value.status === 'absent') { if (value.path) errors.push(`${label}: absent body has a file path`); return; }
    const bytes = await read(value.path, label); if (!bytes) return;
    checked.capturedBodies++;
    if (!Number.isInteger(value.bytes) || value.bytes !== bytes.length) errors.push(`${label}: body byte length does not match archive`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (!value.sha256 || value.sha256 !== digest) errors.push(`${label}: body SHA-256 does not match archive`);
  };
  const stateMap = new Map(states.map(state => [state.id, state]));
  for (const state of states) {
    checked.states++;
    await read(state.html, `State ${state.id} HTML`);
    if (state.rawHtml) await read(state.rawHtml, `State ${state.id} original DOM`);
    else warnings.push(`State ${state.id}: original DOM missing`);
    if (state.screenshot) await read(state.screenshot, `State ${state.id} screenshot`);
    else warnings.push(`State ${state.id}: screenshot missing`);
    if (state.fullPageScreenshot) await read(state.fullPageScreenshot, `State ${state.id} full-page screenshot`);
    for (const id of state.captureOperationIds || []) {
      if (!operationIds.has(id)) errors.push(`State ${state.id}: missing capture operation ${id}`);
      else if (operations.find(item => item.id === id).stateId !== state.id) errors.push(`State ${state.id}: capture operation belongs to another state`);
    }
    unique(state.elements || [], `State ${state.id} element`);
    for (const frame of state.frames || []) {
      checked.frames++;
      if (!frame.frameSelector) errors.push(`State ${state.id} frame ${frame.id}: missing frameSelector`);
      if (frame.html) await read(frame.html, `Frame ${frame.id} HTML`);
      else warnings.push(`Frame ${frame.id}: HTML unavailable`);
      if (frame.rawHtml) await read(frame.rawHtml, `Frame ${frame.id} original DOM`);
      unique(frame.elements || [], `Frame ${frame.id} element`);
    }
  }
  for (const action of actions) {
    checked.actions++;
    if (!stateIds.has(action.fromStateId)) errors.push(`Action ${action.id}: missing source state`);
    if (!stateIds.has(action.toStateId)) {
      (action.status === 'completed' ? errors : warnings).push(`Action ${action.id}: missing result state`);
    }
    const state = stateMap.get(action.fromStateId);
    const elements = action.frameSelector ? state?.frames?.find(frame => frame.frameSelector === action.frameSelector)?.elements : state?.elements;
    const target = elements?.find(element => element.id === action.elementId && element.selector === action.selector);
    if (!target) (action.status === 'completed' ? errors : warnings).push(`Action ${action.id}: target is not in source inventory`);
    for (const id of action.requestIds || []) {
      if (!requestIds.has(id)) errors.push(`Action ${action.id}: missing request ${id}`);
      else if (requests.find(request => request.id === id).actionId !== action.id) errors.push(`Action ${action.id}: inconsistent ownership for request ${id}`);
    }
  }
  for (const navigation of navigations) {
    checked.navigations++;
    if (!['restore-flow-source', 'restore-source-interaction'].includes(navigation.type)) errors.push(`Navigation ${navigation.id}: unknown type`);
    if (!['completed', 'blocked'].includes(navigation.status)) errors.push(`Navigation ${navigation.id}: unknown or unfinished status`);
    if (!stateIds.has(navigation.fromStateId)) errors.push(`Navigation ${navigation.id}: missing source state`);
    if (!stateIds.has(navigation.toStateId)) (navigation.status === 'completed' ? errors : warnings).push(`Navigation ${navigation.id}: missing result state`);
    if (!navigation.flowId || !flowIds.has(navigation.flowId)) errors.push(`Navigation ${navigation.id}: missing associated flow`);
    const resultState = stateMap.get(navigation.toStateId);
    if (resultState && resultState.flowId !== navigation.flowId) errors.push(`Navigation ${navigation.id}: result state belongs to a different flow`);
    if (!Array.isArray(navigation.requestIds)) errors.push(`Navigation ${navigation.id}: requestIds must be an array`);
    for (const id of Array.isArray(navigation.requestIds) ? navigation.requestIds : []) {
      const request = requests.find(item => item.id === id);
      if (!request) errors.push(`Navigation ${navigation.id}: missing request ${id}`);
      else if (request.navigationId !== navigation.id) errors.push(`Navigation ${navigation.id}: inconsistent ownership for request ${id}`);
    }
    if (navigation.type === 'restore-source-interaction') {
      const original = actions.find(action => action.id === navigation.originalActionId);
      if (!original || original.status !== 'completed') errors.push(`Navigation ${navigation.id}: missing completed original action`);
      else if (original.selector !== navigation.selector || (original.frameSelector || '') !== (navigation.frameSelector || '') || original.type !== navigation.interactionType) errors.push(`Navigation ${navigation.id}: replay differs from original action`);
      const source = stateMap.get(navigation.fromStateId);
      const elements = navigation.frameSelector ? source?.frames?.find(frame => frame.frameSelector === navigation.frameSelector)?.elements : source?.elements;
      if (!elements?.some(element => element.selector === navigation.selector)) (navigation.status === 'completed' ? errors : warnings).push(`Navigation ${navigation.id}: replay target absent from source inventory`);
    }
  }
  for (const operation of operations) {
    checked.captureOperations++;
    if (operation.type !== 'lazy-image-scroll-sweep') errors.push(`Capture operation ${operation.id}: unknown type`);
    if (!['completed', 'partial', 'unavailable'].includes(operation.status) || !operation.endedAt) errors.push(`Capture operation ${operation.id}: unfinished operation`);
    if (!stateIds.has(operation.stateId)) (run.status === 'failed' ? warnings : errors).push(`Capture operation ${operation.id}: missing result state`);
    else if (!stateMap.get(operation.stateId).captureOperationIds?.includes(operation.id)) errors.push(`Capture operation ${operation.id}: absent from state's operation list`);
    if (operation.flowId && !flowIds.has(operation.flowId)) errors.push(`Capture operation ${operation.id}: missing associated flow`);
    if (operation.triggerActionId && !actionIds.has(operation.triggerActionId)) errors.push(`Capture operation ${operation.id}: missing triggering action`);
    if (operation.triggerNavigationId && !navigationIds.has(operation.triggerNavigationId)) errors.push(`Capture operation ${operation.id}: missing triggering navigation`);
    if (!Array.isArray(operation.requestIds)) errors.push(`Capture operation ${operation.id}: requestIds must be an array`);
    for (const id of Array.isArray(operation.requestIds) ? operation.requestIds : []) {
      const request = requests.find(item => item.id === id);
      if (!request) errors.push(`Capture operation ${operation.id}: missing request ${id}`);
      else if (request.captureOperationId !== operation.id) errors.push(`Capture operation ${operation.id}: inconsistent request ownership`);
    }
  }
  for (const request of requests) {
    checked.requests++;
    if (request.captureOperationId) {
      const operation = operations.find(item => item.id === request.captureOperationId);
      if (!operation) errors.push(`Request ${request.id}: missing capture operation`);
      else {
        if (!operation.requestIds?.includes(request.id)) errors.push(`Request ${request.id}: absent from capture operation's request list`);
        if ((request.flowId || null) !== (operation.flowId || null)) errors.push(`Request ${request.id}: capture operation flow ownership differs`);
      }
      if (request.actionId || request.navigationId) errors.push(`Request ${request.id}: capture traffic also attributed to user action or navigation`);
    }
    if (request.actionId && !actionIds.has(request.actionId)) errors.push(`Request ${request.id}: missing associated action`);
    if (request.actionId && !actions.find(action => action.id === request.actionId)?.requestIds?.includes(request.id)) errors.push(`Request ${request.id}: absent from associated action's request list`);
    if (request.navigationId) {
      const navigation = navigations.find(item => item.id === request.navigationId);
      if (!navigationIds.has(request.navigationId)) errors.push(`Request ${request.id}: missing associated navigation`);
      else {
        if (!navigation.requestIds?.includes(request.id)) errors.push(`Request ${request.id}: absent from associated navigation's request list`);
        if (request.flowId !== navigation.flowId) errors.push(`Request ${request.id}: navigation flow ownership differs`);
      }
      if (request.actionId) errors.push(`Request ${request.id}: attributed to both an action and restoration navigation`);
    }
    await verifyBody(request.postData, `Request ${request.id} payload`);
    await verifyBody(request.response?.body, `Request ${request.id} response`);
  }
  for (const asset of run.assets || []) {
    checked.assets++;
    if (!requestIds.has(asset.requestId)) errors.push(`Asset ${asset.url}: missing source request`);
    await verifyBody(asset, `Asset ${asset.url}`);
  }
  if (!run.endedAt || run.status === 'recording') errors.push('Run was not finalized');
  return { valid: errors.length === 0, runId: run.id, status: run.status, checked, errors, warnings, scope: 'Checks recorded references and archived bytes; does not certify all browser traffic or successful visual reconstruction.' };
}
