import {readFileSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve, dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

// Detached before the installer stops the monitoring backend. No shell interpolation.
const jobPath=resolve(process.argv[2]);
const job=JSON.parse(readFileSync(jobPath,'utf8'));
const result=join(job.directory,'update-result.json');
function record(status) {
  writeFileSync(result+'.tmp',JSON.stringify({status,version:job.version,at:Date.now()}),{mode:0o600}); renameSync(result+'.tmp',result);
}
try {
  const directory=resolve(job.directory,'updates');
  if(dirname(jobPath)!==directory || dirname(resolve(job.installer))!==directory || !/^\d+\.\d+\.\d+$/.test(job.version)) throw new Error();
  if(createHash('sha256').update(readFileSync(job.installer)).digest('hex')!==job.sha256) throw new Error();
  await delay(1000); // Let the initiating API response leave before stopping the monitor.
  const command=process.platform==='win32'?job.installer:'sh';
  const args=process.platform==='win32'?['--quiet','--dir',job.root,'--update']: [job.installer,'--dir',job.root,'--update'];
  const child=spawn(command,args,{shell:false,stdio:'ignore',windowsHide:true,env:{...process.env,EVEN_PILOT_DATA_DIR:job.directory,EVEN_PILOT_PORT:String(job.port)}});
  const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',done);});
  record(code===0?'installed':'failed');
} catch { record('failed'); }
finally { try { unlinkSync(jobPath); } catch {} }
