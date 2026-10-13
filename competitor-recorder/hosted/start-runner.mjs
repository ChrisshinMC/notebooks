import { access } from 'node:fs/promises';
import path from 'node:path';
import { loadModelConfig } from '../src/model-client.mjs';
import { createCaptureRunner } from './runner.mjs';
const { chromium } = await import('playwright');
let browserReady = false; try { await access(chromium.executablePath()); browserReady = true; } catch {}
const { client, model } = loadModelConfig();
const port = Number(process.env.CAPTURE_RUNNER_PORT || 9000); if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid CAPTURE_RUNNER_PORT');
const server = await createCaptureRunner({ token: process.env.CAPTURE_SERVICE_TOKEN, client, model, browserType: chromium, browserReady, outputRoot: path.resolve(process.env.CAPTURE_DATA_DIR || 'capture-service-data'), allowedHosts: (process.env.CAPTURE_ALLOWED_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean), egressProxy: process.env.CAPTURE_EGRESS_PROXY });
server.listen(port, process.env.CAPTURE_RUNNER_HOST || '127.0.0.1', () => console.log('Capture runner listening; place it behind an authenticated HTTPS service endpoint.'));
