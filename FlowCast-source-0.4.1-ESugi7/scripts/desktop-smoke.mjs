import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
import {mkdir,mkdtemp,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('..',import.meta.url));
const packaged=process.argv.includes('--packaged');
const executableIndex=process.argv.indexOf('--executable');
const executable=executableIndex>=0?resolve(process.argv[executableIndex+1]):join(root,packaged?'dist/win-unpacked/FlowCast.exe':'node_modules/electron/dist/electron.exe');
await access(executable).catch(()=>{throw new Error(packaged?'请先执行 npm run pack:win':'缺少 Electron 运行文件，请先完成 Electron 安装');});
const qa=join(root,'.qa');await mkdir(qa,{recursive:true});
const runDir=await mkdtemp(join(qa,'desktop-'));
const resultFile=join(qa,packaged?'desktop-packaged-result.json':'desktop-result.json');
const env={...process.env,FLOWCAST_TEST_DIR:runDir};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(executable,[...(packaged?[]:[root]),'--remote-debugging-port=0','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],{cwd:packaged?runDir:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let launchError,stderr='',ws,serial=0,base;const errors=[],pending=new Map();
child.on('error',error=>{launchError=error;});child.stdout.resume();child.stderr.on('data',data=>{stderr=(stderr+data).slice(-8000);});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++serial;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},20000);pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression,userGesture=false){const result=await call('Runtime.evaluate',{expression,userGesture,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
async function until(expression){for(let i=0;i<120;i++){if(await evaluate(expression))return;await sleep(150);}throw new Error('Timed out: '+expression+'; '+await evaluate('document.getElementById("notice")?.textContent'));}
async function decode(url){const video=document.createElement('video');video.muted=true;video.src=url;try{await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Decode failed'));});return {width:video.videoWidth,height:video.videoHeight,duration:video.duration};}finally{video.removeAttribute('src');video.load();}}
try{
 await writeFile(resultFile,JSON.stringify({passed:false,status:'running',packaged,runDir},null,2));
 let port;for(let i=0;i<150;i++){if(launchError)throw launchError;if(child.exitCode!==null)throw new Error('Electron exited: '+stderr);try{port=Number((await readFile(join(runDir,'data','DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await sleep(200);}}
 assert.ok(port,'Electron debugger unavailable: '+stderr);
 let page;for(let i=0;i<100;i++){const pages=await(await fetch('http://127.0.0.1:'+port+'/json')).json();page=pages.find(p=>p.type==='page'&&p.url.startsWith('http://127.0.0.1:'));if(page)break;await sleep(200);}assert.ok(page,'Studio did not load: '+stderr);
 ws=new WebSocket(page.webSocketDebuggerUrl);await once(ws,'open');
 ws.on('message',data=>{const message=JSON.parse(data);if(message.id){const task=pending.get(message.id);pending.delete(message.id);if(message.error)task?.reject(new Error(JSON.stringify(message.error)));else task?.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);});
 await call('Runtime.enable');await call('Page.enable');
 await until('!!window.flowcast && document.getElementById("connection")?.textContent.includes("已连接")');
 const screenSources=await evaluate('window.flowcast.sources()');assert.ok(Array.isArray(screenSources));
 assert.equal(await evaluate('typeof require'),'undefined');assert.equal(await evaluate('typeof process'),'undefined');
 base=await evaluate('location.origin');
 const state=await(await fetch(base+'/api/state')).json();assert.equal(resolve(state.recordingDir),join(runDir,'recordings'));
 await until('document.getElementById("pair-qr").naturalWidth>0');
 assert.equal(await evaluate('window.flowcast.setRecording("false").then(()=>false,()=>true)'),true);
 await evaluate('window.__recorders=[];window.MediaRecorder=class extends MediaRecorder{constructor(...args){super(...args);window.__recorders.push(this);}};document.getElementById("add-camera").click()',true);
 await until('document.getElementById("state-webcam").classList.contains("ready")');
 await evaluate('document.getElementById("add-mic").click()',true);await until('document.getElementById("audio-status").textContent.includes("已接收")');
 await evaluate('document.getElementById("record").click()',true);await until('window.__recorders[0]?.state==="recording"');await sleep(1800);
 await until('(async()=>{const items=await(await fetch("/api/recordings")).json();return items.length===1&&items[0].bytes>0;})()');const items=await(await fetch(base+'/api/recordings')).json();assert.equal(items.length,1);assert.ok(items[0].bytes>0);
 await evaluate('document.getElementById("pause").click()');await until('window.__recorders[0].state==="paused"');await sleep(300);
 const timer=await evaluate('document.getElementById("timer").textContent');await sleep(1200);assert.equal(await evaluate('document.getElementById("timer").textContent'),timer);
 await evaluate('document.getElementById("pause").click()');await sleep(1500);assert.equal(await evaluate('window.__recorders.length'),1);
 await evaluate('document.getElementById("stop").click()');await until('!!document.querySelector("#export-list a")');
 const webm=await evaluate('('+decode.toString()+')(document.querySelector("#export-list a").href)');assert.equal(webm.width,1280);assert.equal(webm.height,720);assert.ok(webm.duration>2&&webm.duration<6);
 await evaluate('document.querySelector("#export-list button").click()');await until('!!document.querySelector("#export-list a[href$=mp4]")');
 const mp4=await evaluate('('+decode.toString()+')(document.querySelector("#export-list a[href$=mp4]").href)');assert.equal(mp4.width,1280);assert.equal(mp4.height,720);
 await call('Page.reload');await until('document.querySelectorAll("#export-list a").length===2');assert.equal(errors.length,0,JSON.stringify(errors));
 
 // A second invocation should exit, leaving the original service and window alive.
 const second=spawn(executable,packaged?[]:[root],{cwd:runDir,env,windowsHide:true,stdio:'ignore'});
 const secondExit=await Promise.race([once(second,'exit'),sleep(10000).then(()=>{second.kill();throw Error('Second invocation did not exit');})]);assert.equal(secondExit[0],0);assert.equal((await fetch(base+'/health')).status,200);
 // Closing the actual window exercises the native shutdown path and port release.
 const exited=once(child,'exit');await evaluate('setTimeout(()=>window.close(),0)');
 const timeout=setTimeout(()=>child.kill(),15000);const [code]=await exited;clearTimeout(timeout);assert.equal(code,0,'Desktop did not exit cleanly: '+stderr);
 await assert.rejects(fetch(base+'/health'));
 const result={passed:true,packaged,executable,runDir,webm,mp4,consoleErrors:errors,checks:['isolated userData and recordings','native shared-source enumeration','second invocation reuses existing application','sandboxed preload bridge','invalid recording state rejected','TLS QR','synthetic camera and microphone','recording reaches disk','pause and resume in one recorder','WebM and MP4 decode','exports persist after reload','native window close exits and releases service']};
 await writeFile(resultFile,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){await writeFile(resultFile,JSON.stringify({passed:false,packaged,runDir,error:error.stack,stderr,consoleErrors:errors},null,2));throw error;}
finally{ws?.close();for(const task of pending.values())task.reject(new Error('Desktop test ended'));pending.clear();if(child.exitCode===null)child.kill();}
