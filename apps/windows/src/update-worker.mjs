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
  const pending=result+'.tmp-'+job.id;
  writeFileSync(pending,JSON.stringify({id:job.id,status,version:job.version,at:Date.now()}),{mode:0o600}); renameSync(pending,result);
}
let heartbeat, installerPid;
function pulse() {
  const state=join(job.directory,'updates','worker-state.json'), pending=state+'.tmp-'+job.id;
  writeFileSync(pending,JSON.stringify({id:job.id,version:job.version,pid:process.pid,installerPid,startedAt:job.startedAt,at:Date.now()}),{mode:0o600}); renameSync(pending,state);
}
try {
  const directory=resolve(job.directory,'updates');
  if(dirname(jobPath)!==directory || dirname(resolve(job.installer))!==directory || !/^\d+\.\d+\.\d+$/.test(job.version)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(job.id) || !Number.isFinite(job.startedAt)) throw new Error();
  pulse(); heartbeat=setInterval(()=>{try{pulse();}catch{}},2000); heartbeat.unref();
  if(createHash('sha256').update(readFileSync(job.installer)).digest('hex')!==job.sha256) throw new Error();
  await delay(1000); // Let the initiating API response leave before stopping the monitor.
  const command=process.platform==='win32'?job.installer:'sh';
  const args=process.platform==='win32'?['--quiet','--dir',job.root,'--update']: [job.installer,'--dir',job.root,'--update'];
  const child=spawn(command,args,{shell:false,stdio:'ignore',windowsHide:true,env:{...process.env,EVEN_PILOT_DATA_DIR:job.directory,EVEN_PILOT_PORT:String(job.port)}});
  installerPid=child.pid; try { pulse(); } catch { }
  const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',done);});
  record(code===0?'installed':'failed');
} catch { record('failed'); }
finally { clearInterval(heartbeat); try { if(JSON.parse(readFileSync(jobPath,'utf8')).id===job.id) unlinkSync(jobPath); } catch {} }
