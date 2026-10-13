import path from 'node:path';
import {access} from 'node:fs/promises';
import {createCaptureRunner} from '../competitor-recorder/hosted/runner.mjs';
import {createHostedOpenRouterClient,hostedModelStatus} from '../competitor-hosted-app/research-api/openrouter-client.mjs';
export async function createService({env=process.env,browserType,recordFn,client,fetchImpl}={}){
 const config=hostedModelStatus(env);
 let browserReady=false;try{await access(browserType.executablePath());browserReady=true;}catch{}
 const allowedHosts=(env.CAPTURE_ALLOWED_HOSTS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
 return createCaptureRunner({token:env.CAPTURE_SERVICE_TOKEN,client:client||(config.modelConfigured?createHostedOpenRouterClient({env,fetchImpl}):null),model:config.model,browserType,browserReady,outputRoot:path.resolve(env.CAPTURE_DATA_DIR||'/data'),allowedHosts,egressProxy:env.CAPTURE_EGRESS_PROXY,publicSubresources:env.CAPTURE_PUBLIC_SUBRESOURCES==='true',recordFn});
}
