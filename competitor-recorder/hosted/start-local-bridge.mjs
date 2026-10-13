import path from 'node:path';
import { createLocalBridge } from './local-bridge.mjs';
const bridge=await createLocalBridge({hostedUrl:process.env.RESEARCH_HOSTED_URL,token:process.env.LOCAL_RECORDER_TOKEN,localUrl:process.env.RESEARCH_LOCAL_URL||'http://127.0.0.1:8768',journalPath:path.resolve('runs','local-bridge.json')});
console.log('Local recorder connection started. Keep the local research application running.');
while(true){
  try{const result=await bridge.tick();console.log('Local recorder connection: '+result.status);}
  catch{console.error('Recorder connection unavailable; retained local job for retry.');}
  await new Promise(resolve=>setTimeout(resolve,5000));
}
