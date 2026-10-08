import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const release = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(release, 'inventory.json')));
const setup = join(release, `Terminal-plus-${manifest.version}-Setup-x64.exe`);
const previousSetup = process.argv[3] ? resolve(process.argv[3]) : setup;
const sandbox = mkdtempSync(join(tmpdir(), 'pilot-install-'));
const root = join(sandbox, 'Application with spaces');
const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise(done => socket.close(done));
const env = { ...process.env, PATH: join(process.env.WINDIR,'System32') + ';' + process.env.WINDIR,
  EVEN_PILOT_DATA_DIR:'', EVEN_PILOT_PORT:String(port), EVEN_PILOT_TOKEN:'', EVEN_PILOT_NOTIFICATION_TOKEN:'',
  EVEN_PILOT_FCM_PROJECT_ID:'', GOOGLE_APPLICATION_CREDENTIALS:'',
  PI_CODING_AGENT_DIR:join(sandbox,'pi'), PI_CODING_AGENT_SESSION_DIR:'', CODEX_HOME:join(sandbox,'codex'),
  CLAUDE_CONFIG_DIR:join(sandbox,'claude'), EVEN_PILOT_CODEX:join(sandbox,'not-installed.exe') };
const invoke = (exe, args) => spawnSync(exe,args,{ cwd:sandbox,env,windowsHide:true,encoding:'utf8',timeout:120000 });
const claudeSettingsPath=join(env.CLAUDE_CONFIG_DIR,'settings.json');
const userClaudeSettings={env:{EXISTING_OPTION:'retain'},hooks:{Stop:[{hooks:[{type:'command',command:'echo keep-user-hook'}]}]}};
mkdirSync(env.CLAUDE_CONFIG_DIR,{recursive:true}); writeFileSync(claudeSettingsPath,JSON.stringify(userClaudeSettings));
const install = (exe = setup) => invoke(exe,['--quiet','--dir',root,'--no-launch','--no-shortcuts']);
let backend, working;
const configPath = join(root,'.local/bridge-config.json');
let token;
const request = (path, method='GET') => fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:method==='POST'?'{}':undefined,signal:AbortSignal.timeout(1500)});
async function until(check, timeout=20000) { const end=Date.now()+timeout; while(!await check()) { if(Date.now()>end) throw new Error('Installer fixture timeout'); await delay(100); } }
try {
  const first=install(previousSetup); assert.equal(first.status,0, first.stderr || 'First offline installation failed');
  const record=JSON.parse(readFileSync(join(root,'install.json'))), payload=join(root,'versions',record.current);
  assert.equal(record.version,JSON.parse(readFileSync(join(payload,'package.json'))).version);
  const node=join(payload,'runtime/node.exe');
  assert.equal(existsSync(node),true);
  const config=JSON.parse(readFileSync(configPath)); token=config.controlToken;
  assert.notEqual(token,config.notificationToken); assert.equal(existsSync(join(payload,'.local')),false);
  const original=readFileSync(configPath,'utf8');
  const userFile=join(root,'.local','retained-fixture.txt'); writeFileSync(userFile,'Keep user data');
  const rootId=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16).toUpperCase();
  const registry='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Even-Pilot-'+rootId;
  const reg=join(process.env.WINDIR,'System32/reg.exe');
  assert.equal(invoke(reg,['query',registry,'/v','UninstallString']).status,0,'Registered Windows uninstaller');
  backend=spawn(node,['--import','tsx','apps/windows/src/cli.ts','--host','127.0.0.1','--port',String(port)],{cwd:payload,env,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return(await request('/api/monitoring')).ok;}catch{return false;}});
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status,401);
  assert.equal((await request('/')).status,200);
  // This harmless process represents a native connector still using the installed runtime.
  working=spawn(node,['-e','setInterval(()=>{},1000)'],{cwd:payload,env,windowsHide:true,stdio:'ignore'});
  await new Promise((done,fail)=>{working.once('spawn',done);working.once('error',fail);});
  const native=join(root,'.local/native'); mkdirSync(native,{recursive:true});
  const nativeFile=join(native,working.pid+'.json');
  writeFileSync(nativeFile,JSON.stringify({version:1,pid:working.pid,instance:randomUUID(),at:Date.now(),state:{connected:true}}));
  const blocked=invoke(setup,['--quiet','--uninstall','--dir',root]);
  assert.equal(blocked.status,1,'Uninstall refuses a connected terminal');
  assert.equal((await request('/api/monitoring')).status,200,'Blocked uninstall leaves monitoring running');
  const again=install(); assert.equal(again.status,0,again.stderr || 'Reinstall failed');
  await until(()=>backend.exitCode!==null);
  assert.equal(backend.exitCode,0,'Installer gracefully stops only the monitoring backend');
  assert.equal(working.exitCode,null,'Native process survives update');
  assert.equal(readFileSync(configPath,'utf8'),original,'Pairing keys persist');
  assert.equal(readFileSync(userFile,'utf8'),'Keep user data');
  const updated=JSON.parse(readFileSync(join(root,'install.json')));
  assert.equal(existsSync(join(root,'.local','claude-monitor-registration.json')),true,'Owned Claude hooks are prepared');
  assert.equal(JSON.parse(readFileSync(claudeSettingsPath)).env.EXISTING_OPTION,'retain');
  assert.equal(updated.version,manifest.version);
  assert.equal(updated.current,manifest.version+'-'+manifest.buildId,'Upgrade selects the new payload');
  assert.equal(updated.versions.length,updated.current===record.current?1:2,'Working payload is retained across versions');
  const currentPayload=join(root,'versions',updated.current);
  backend=spawn(join(currentPayload,'runtime/node.exe'),['--import','tsx','apps/windows/src/cli.ts','--host','127.0.0.1','--port',String(port)],{cwd:currentPayload,env,windowsHide:true,stdio:'ignore'});
  await until(async()=>{try{return(await request('/api/monitoring')).ok;}catch{return false;}});
  working.kill(); await until(()=>working.exitCode!==null || working.signalCode!==null); rmSync(nativeFile);
  const uninstall=invoke(join(root,'Uninstall.exe'),['--quiet','--uninstall','--dir',root]);
  assert.equal(uninstall.status,0,'Registered uninstaller starts');
  await until(()=>!existsSync(join(root,'install.json')) && !existsSync(join(root,'Uninstall.exe')),30000);
  assert.equal(existsSync(join(root,'versions')),false,'Application payloads removed');
  assert.equal(invoke(reg,['query',registry]).status,1,'Uninstall registration removed');
  assert.equal(readFileSync(configPath,'utf8'),original,'Uninstall retains user keys');
  assert.equal(existsSync(join(env.PI_CODING_AGENT_DIR,'extensions/even-pilot-monitor.ts')),false,'No broken Pi extension left behind');
  assert.deepEqual(JSON.parse(readFileSync(claudeSettingsPath)),userClaudeSettings,'Uninstall removes only owned Claude hooks');
  assert.equal(existsSync(join(root,'.local','claude-monitor-registration.json')),false);
  console.log('PASS: offline installer without system Node/npm; spaced paths; Windows uninstall registration; bundled backend; reinstall/key retention; upgrade preserves native process; uninstall refuses active terminals and retains data.');
} finally {
  if(backend?.exitCode===null) { await request('/api/shutdown','POST').catch(()=>{}); await delay(500); if(backend.exitCode===null) backend.kill(); }
  if(working?.exitCode===null && working.signalCode===null) working.kill();
  // Keep a failed fixture available for diagnosis; successful installation is already uninstalled.
  if(!existsSync(join(root,'install.json'))) rmSync(sandbox,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
