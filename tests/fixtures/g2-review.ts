// Official-simulator UX review fixture. Imports the production G2 renderer;
// sample sessions never connect to Pi, production credentials or notifications.
import { createServer } from "vite";
import { resolve } from "node:path";

let scenario = "running";
const events: unknown[] = [];
const port = Number(process.env.EVEN_PILOT_REVIEW_PORT || 4320);
const vite = await createServer({ configFile: false, appType: "custom", root: resolve("apps/evenhub"), server: { host: "127.0.0.1", port, strictPort: true, hmr: false } });
vite.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/__scenario") {
    if (req.method === "POST") scenario = url.searchParams.get("name") || "running";
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ scenario })); return;
  }
  if (url.pathname === "/__events") {
    if (req.method === "POST") { let body = ""; for await (const chunk of req) body += chunk; events.push(JSON.parse(body)); }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(events)); return;
  }
  if (url.pathname === "/__close" && req.method === "POST") { res.end("closing"); setTimeout(() => { void vite.close().then(() => process.exit(0)); }, 100); return; }
  if (url.pathname !== "/__g2-review") { next(); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(await vite.transformIndexHtml("/__g2-review", `<!doctype html><meta charset="utf-8"><title>Even-Pilot G2 review fixture</title><h1>Official simulator review</h1><p>Synthetic sessions only.</p><canvas id="pixels" width="576" height="288" style="background:black;width:576px;height:288px"></canvas><pre id="preview"></pre>
<script type="module">
import { G2Display } from '/src/g2/display.ts';
import { VoiceController } from '/src/voice/controller.ts';
import { waitForEvenAppBridge, RebuildPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk';
const sessions=[
 {key:'alpha',id:'alpha',name:'Desktop connection',model:'deepseek/deepseek-v4-pro',tunnel:'pi',cwd:'C:/demo/api',monitored:true,runtimeStatus:'running',messageCount:42},
 {key:'beta',id:'beta',name:'Fix tests',model:'gpt-5.4',tunnel:'codex',cwd:'C:/demo/tests',monitored:true,runtimeStatus:'idle',messageCount:18},
 {key:'gamma',id:'gamma',name:'Review changes',model:'claude-opus-4-6',tunnel:'claude',cwd:'C:/demo/review',monitored:true,runtimeStatus:'idle',messageCount:12},
 {key:'archive',id:'archive',name:'Old unwatched session',cwd:'C:/demo/archive',monitored:false,runtimeStatus:'offline',messageCount:90}
];
let selected=sessions[0],last='',startedAt=Date.now()-83000;
function state(scenario) { const history=scenario.startsWith('history'),running=scenario==='running'||history; return {
 revision:1,connected:true,main:{status:running?'running':'idle',startedAt,statusSince:startedAt},tools:{active:running?{one:{name:'read',startedAt}}:{}},
 subagents:running?{active:3,mainDelegated:true}:undefined,
 session:{key:selected.key,name:selected.name,cwd:selected.cwd,model:selected.model,tunnel:selected.tunnel},currentAssistantText: history ? scenario==='history-stream'?'New progress for the current task.':'' : scenario==='empty'?'':
 scenario==='summary' ? 'Full desktop explanation remains in the terminal.\\n<g2-summary>连接已修复，手机可以访问电脑。\\n请在眼镜里继续当前会话。</g2-summary>' :
 'Three workers are checking the changes.\\n\\n• Connection and reconnection\\n• Session switching\\n• Completion notifications',
 assistantOpen:running,transcript:history?[
 {role:'user',text:'Review the previous task.',at:1},
 {role:'assistant',text:Array.from({length:14},(_,i)=>'Previous feedback line '+(i+1)+': this remains readable.').join('\\n'),at:2},
 {role:'user',text:'Continue the task in my desktop terminal.',at:3}
 ]:[],monitoring:{running:running?1:0,watched:3,since:startedAt,sessions:sessions.filter(s=>s.monitored).map(s=>({...s,status:s.runtimeStatus,current:s.key===selected.key}))}
 }; }
let voice;
const display=new G2Display((header,body,mode)=>{document.querySelector('#preview').textContent=header+'\\n'+body;},text=>console.log('connection',text),{
 list:async()=>sessions,
 open:async key=>{selected=sessions.find(s=>s.key===key);console.log('selected',key);return state(last);}
},{frame:canvas=>document.querySelector('#pixels').getContext('2d').drawImage(canvas,0,0),interrupt:async key=>console.log('fixture-stop',key),
input:{open(){voice.open();},toggleRecording(){void voice.toggleRecording();},finish(){voice.finish();},send(){void voice.confirm();},
startDeleting(){voice.startDeleting();},stopDeleting(){voice.stopDeleting();},pause(){voice.pause();},cancel(){voice.cancel();},audio(pcm){voice.audio(pcm);}},
 ready:bridge=>{for(const method of ['createStartUpPageContainer','rebuildPageContainer','textContainerUpgrade','updateImageRawData','shutDownPageContainer']){
 const original=bridge[method].bind(bridge);bridge[method]=async data=>{const result=await original(data);const entry={method,result,mode:typeof data==='number'?data:undefined,chars:data.content?.length,content:data.content,texts:data.textObject?.map(t=>({id:t.containerID,capture:t.isEventCapture,content:t.content})),items:data.listObject?.[0]?.itemContainer?.itemCount};console.log('wire',JSON.stringify(entry));await fetch('/__events',{method:'POST',body:JSON.stringify(entry)});return result;};}}
});
voice=new VoiceController({config:()=>({provider:'whisper',key:'synthetic-no-network',language:''}),target:()=>({key:selected.key,connection:'fixture'}),
mic:async open=>{console.log('fixture-microphone',open);return true;},transcribe:async()=>'Synthetic voice prompt for cancellation test.',
view:view=>{console.log('voice-phase',view.phase);display.setComposer(view.phase==='idle'||view.background?undefined:view);},send:async()=>{console.log('fixture-send');}});
display.update(state('running'),true); void display.init();
void waitForEvenAppBridge().then(bridge=>bridge.onEvenHubEvent(e=>{ console.log('input',JSON.stringify(e)); fetch('/__events',{method:'POST',body:JSON.stringify(e)}); }));
setInterval(async()=>{const {scenario}=await (await fetch('/__scenario')).json();if(scenario===last)return;last=scenario;
 if(scenario==='minimal'){ display.dispose(); console.log('minimal',await (await waitForEvenAppBridge()).rebuildPageContainer(new RebuildPageContainer({containerTotalNum:1,textObject:[new TextContainerProperty({xPosition:0,yPosition:0,width:576,height:288,containerID:1,containerName:'minimal',isEventCapture:1,content:'Hello G2. Minimal renderer check.'})]})));return;}
 display.update(state(scenario),scenario!=='offline');},300);
</script>`));
});
await vite.listen(); console.log(`G2 review fixture: http://127.0.0.1:${port}/__g2-review`);
