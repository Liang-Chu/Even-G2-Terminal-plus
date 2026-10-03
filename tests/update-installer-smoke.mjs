import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,cpSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Exercises the real installer health gate and rollback, using isolated data/ports only.
const release=resolve(process.argv[2]), windows=process.platform==='win32';
const sandbox=mkdtempSync(join(tmpdir(),'pilot-update-install-')), root=join(sandbox,'App with spaces');
const stage=join(release,'Even-Pilot');
const version=JSON.parse(readFileSync(join(stage,'package.json'))).version;
const setup=join(release,`Even-Pilot-${version}-Setup-${windows?'x64.exe':'linux-x64.run'}`);
const previousRelease=process.argv[3]?resolve(process.argv[3]):release;
const previousVersion=JSON.parse(readFileSync(join(previousRelease,'Even-Pilot/package.json'))).version;
const firstSetup=join(previousRelease,`Even-Pilot-${previousVersion}-Setup-${windows?'x64.exe':'linux-x64.run'}`);
const reservation=createServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));
const port=reservation.address().port;await new Promise(done=>reservation.close(done));
const data=windows?join(root,'.local'):join(sandbox,'data');
const env={...process.env,EVEN_PILOT_DATA_DIR:data,EVEN_PILOT_INSTALL_DIR:root,EVEN_PILOT_BIN_DIR:join(sandbox,'bin'),
 EVEN_PILOT_PORT:String(port),EVEN_PILOT_SERVICE_NAME:'pilot-update-'+randomUUID()+'.service',EVEN_PILOT_NO_SYSTEMD:'1',
 XDG_CONFIG_HOME:join(sandbox,'config'),XDG_DATA_HOME:join(sandbox,'share'),PI_CODING_AGENT_DIR:join(sandbox,'pi'),
 PI_CODING_AGENT_SESSION_DIR:'',CODEX_HOME:join(sandbox,'codex'),CLAUDE_CONFIG_DIR:join(sandbox,'claude'),
 EVEN_PILOT_CODEX:join(sandbox,'no-codex'),GOOGLE_APPLICATION_CREDENTIALS:'',EVEN_PILOT_FCM_PROJECT_ID:'',
 EVEN_PILOT_TOKEN:'',EVEN_PILOT_NOTIFICATION_TOKEN:'',DISPLAY:'',WAYLAND_DISPLAY:''};
if(!windows) { env.HOME=join(sandbox,'home'); env.SHELL='/bin/bash'; mkdirSync(env.HOME,{recursive:true}); }
const run=(exe,args)=>spawnSync(exe,args,{env,cwd:sandbox,windowsHide:true,encoding:'utf8',timeout:110000});
const install=(file,update)=>windows?run(file,['--quiet','--dir',root,'--no-shortcuts',update?'--update':'--no-launch'])
 :run('sh',[file,'--dir',root,update?'--update':'--no-start']);
let backend, worker, token, record, stalledClient;
const request=async(path,body)=>fetch(`http://127.0.0.1:${port}${path}`,{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(1200)});
async function until(fn,ms=20000){const end=Date.now()+ms;while(!await fn()){if(Date.now()>end)throw new Error('Update fixture timeout');await delay(100);}}
async function healthy(){try{return(await request('/api/updates')).ok;}catch{return false;}}
try {
 const first=install(firstSetup,false);assert.equal(first.status,0,first.stderr);
 record=JSON.parse(readFileSync(join(root,'install.json')));const payload=join(root,'versions',record.current);
 const claudeBefore=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json')));
 const config=readFileSync(join(data,'bridge-config.json'),'utf8');token=JSON.parse(config).controlToken;
 writeFileSync(join(data,'update-settings.json'),'{"automaticChecks":false}');
 const node=join(payload,'runtime',windows?'node.exe':'node');
 backend=spawn(node,['--import','tsx','apps/windows/src/cli.ts','--port',String(port)],{cwd:payload,env,stdio:'ignore',windowsHide:true});
 await until(healthy);
 worker=spawn(node,['-e','setInterval(()=>{},1000)'],{cwd:payload,env,stdio:'ignore',windowsHide:true});
 await new Promise((done,fail)=>{worker.once('spawn',done);worker.once('error',fail);});
 mkdirSync(join(data,'native'),{recursive:true});writeFileSync(join(data,'native',worker.pid+'.json'),JSON.stringify({version:1,pid:worker.pid,instance:randomUUID(),at:Date.now(),state:{connected:true}}));
 if(windows&&previousRelease!==release){
   // The published old backend can close its listener yet retain its IPC lock
   // forever while an unfinished phone upload remains active.
   stalledClient=connect(port,'127.0.0.1');stalledClient.on('error',()=>{});
   await once(stalledClient,'connect');
   stalledClient.write(`POST /api/prompt HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
   await delay(100);
 }
 let rejected;
 if(windows){
   const {buildInstaller}=await import('../scripts/installer.mjs');
   const bad=join(sandbox,'bad-release');mkdirSync(bad);
   const inventory=JSON.parse(readFileSync(join(release,'inventory.json')));
   const built=buildInstaller(resolve('.'),stage,bad,'9.9.9',inventory.files);
   rejected=install(built.installer,true);
 } else {
   const bad=join(sandbox,'bad-payload');cpSync(stage,bad,{recursive:true});
   const manifest=JSON.parse(readFileSync(join(bad,'release.json')));manifest.version='9.9.9';writeFileSync(join(bad,'release.json'),JSON.stringify(manifest));
   rejected=run(join(bad,'runtime/node'),[join(bad,'apps/linux/install.mjs'),'--dir',root,'--update']);
 }
 assert.notEqual(rejected.status,0,'Health version mismatch must reject the update');
 await until(healthy);
 assert.equal(JSON.parse(readFileSync(join(root,'install.json'))).current,record.current,'Previous payload selected after rollback');
 assert.equal((await(await request('/api/updates')).json()).currentVersion,previousVersion,'Previous backend is healthy after rollback');
 assert.equal(worker.exitCode,null,'Native process survives failed update');
 assert.equal(readFileSync(join(data,'bridge-config.json'),'utf8'),config,'Keys survive rollback');
 assert.deepEqual(JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'))),claudeBefore,'Rollback restores the previous owned hook command');
 const accepted=install(setup,true);assert.equal(accepted.status,0,accepted.stderr);
 await until(healthy);
 assert.equal(worker.exitCode,null,'Native process survives successful update');
 assert.equal((await(await request('/api/updates')).json()).automaticChecks,false,'Disabled update preference persists');
 assert.equal(readFileSync(join(data,'bridge-config.json'),'utf8'),config);
 assert.equal((await(await request('/api/updates')).json()).currentVersion,version,'The accepted backend serves the new exact version');
 if(previousRelease===release)assert.deepEqual(JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'))),claudeBefore,'Reinstall preserves the registered hook settings');
 console.log('PASS: '+process.platform+' '+previousVersion+' → '+version+' real --update installation, failed health check rollback, healthy restart, saved preference/key retention and native-process survival.');
} finally {
 if(stalledClient)stalledClient.destroy();
 if(worker?.exitCode===null){worker.kill();await until(()=>worker.exitCode!==null||worker.signalCode!==null);}
 try{await request('/api/shutdown',{});}catch{}
 if(existsSync(join(root,'install.json'))){
   const remove=windows?run(join(root,'Uninstall.exe'),['--quiet','--uninstall','--dir',root]):run(join(sandbox,'bin/even-pilot'),['uninstall']);
   if(remove.status)console.error('Fixture uninstall incomplete; retained at '+sandbox);
 }
 if(!existsSync(join(root,'install.json'))){await delay(500);rmSync(sandbox,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
}
