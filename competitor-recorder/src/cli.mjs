import {readFile} from 'node:fs/promises';
import {record} from './recorder.mjs';
const [recipePath,output,device='desktop']=process.argv.slice(2);
if(!recipePath||!output){console.error('Usage: npm run record -- recipe.json new-run-folder [desktop|tablet|mobile]');process.exitCode=2;}
else {const recipe=JSON.parse(await readFile(recipePath,'utf8'));const {chromium}=await import('playwright');const result=await record(recipe,output,device,chromium);console.log(JSON.stringify({folder:result.folder,status:result.run.status,states:result.run.states.length,requests:result.run.requests.length}));if(result.run.status==='failed')process.exitCode=1;}
