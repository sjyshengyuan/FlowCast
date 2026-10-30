import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {WebSocket} from 'ws';
import {mkdir,writeFile,mkdtemp,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {startStudio} from '../server.mjs';
import {remoteSmoke} from './remote-smoke-support.mjs';
const remoteMode=process.argv.includes('--remote');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=resolve('.qa');await mkdir(dir,{recursive:true});
const runDir=await mkdtemp(join(dir,'browser-'));
let server=await startStudio({port:0,tlsPort:0,allowRemoteLoopback:remoteMode,dataDir:join(runDir,'data'),recordingDir:join(runDir,'recordings')});
const base='http://127.0.0.1:'+server.address().port;
const remote=remoteMode?await remoteSmoke(base):null;
const detail=process.env.FLOWCAST_TEST_QUALITY==='detail',expectedWidth=detail?1920:1280,expectedHeight=detail?1080:720;
// A deterministic microphone tone makes received and saved audio verifiable.
const wave=Buffer.alloc(44+48000*2);wave.write('RIFF',0);wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(48000,24);wave.writeUInt32LE(96000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(96000,40);for(let i=0;i<48000;i++)wave.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*8000),44+i*2);await writeFile(join(runDir,'microphone.wav'),wave);
const child=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+join(runDir,'chrome'),'--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+join(runDir,'microphone.wav'),'--window-size=1440,1100','--no-first-run','about:blank'],{windowsHide:true,stdio:'ignore'});
let launchError;child.on('error',error=>launchError=error);
let ws;const pending=new Map();let serial=0;const errors=[];
async function call(method,params={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},20000);pending.set(id,{resolve:x=>{clearTimeout(timer);resolve(x);},reject:x=>{clearTimeout(timer);reject(x);}});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression,userGesture=false){const result=await call('Runtime.evaluate',{expression,userGesture,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
async function until(expression,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expression))return;await sleep(150);}throw new Error('Condition timed out: '+expression+'; notice: '+await evaluate('document.getElementById("notice")?.textContent'));}
try{
 let port;for(let i=0;i<80;i++){if(launchError)throw launchError;try{port=Number((await readFile(join(runDir,'chrome','DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await sleep(200);}}
 assert.ok(port,'Chrome failed to launch');const pages=await(await fetch('http://127.0.0.1:'+port+'/json')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});ws.onmessage=e=>{const message=JSON.parse(e.data);if(message.id){const task=pending.get(message.id);pending.delete(message.id);if(message.error)task?.reject(new Error(JSON.stringify(message.error)));else task?.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);};
 await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
 await call('Page.addScriptToEvaluateOnNewDocument',{source:'window.__recorders=[];window.MediaRecorder=class extends MediaRecorder{constructor(...args){super(...args);window.__recorders.push(this);}};'});
 // Optional native-peer compatibility scenario: hide desktop host addresses and reject mDNS on sender.
 if(process.env.FLOWCAST_TEST_MDNS==='1')await call('Page.addScriptToEvaluateOnNewDocument',{source:'window.__NativePeer=RTCPeerConnection;window.__rejectMdns=true;window.__maskedCandidates=0;window.RTCPeerConnection=class extends RTCPeerConnection{set onicecandidate(handler){super.onicecandidate=event=>{if(!event.candidate)return handler(event);const value=event.candidate.toJSON(),parts=value.candidate.split(" ");if(parts[7]==="host"&&/^\\d+\\./.test(parts[4])){parts[4]="unresolvable-test.local";value.candidate=parts.join(" ");window.__maskedCandidates++;}handler({candidate:{toJSON:()=>value}});};}};'});
 await call('Page.navigate',{url:base});await until('document.getElementById("connection")?.textContent.includes("已连接")');
 assert.equal(await evaluate('document.title'),'FlowCast · 连续录制工作台');await until('document.getElementById("pair-qr").naturalWidth>0');

 if(remote){
  await evaluate('window.__remotePhoneUrl='+JSON.stringify(remote.phoneUrl));
  await evaluate('document.getElementById("remote-settings").open=true;document.getElementById("remote-url").value='+JSON.stringify(remote.url)+';document.getElementById("remote-key").value='+JSON.stringify(remote.key)+';document.getElementById("enable-remote").click()');
  await until('document.getElementById("remote-status").textContent.includes("跨网配对已就绪")');
  assert.equal(await evaluate('document.getElementById("remote-key").value'),'');
  assert.equal(await evaluate('document.getElementById("network").hidden'),true);
  assert.ok(await evaluate('document.getElementById("pair-network-step").textContent.includes("不同 Wi-Fi")'));
 }
 if(detail)await evaluate('document.getElementById("quality").value="detail";document.getElementById("quality").dispatchEvent(new Event("change"))');
 // The enlarged QR stays usable without navigating away from the workstation.
 await evaluate('document.getElementById("enlarge-qr").click()');
 await until('document.getElementById("pair-dialog").open && document.getElementById("large-pair-qr").naturalWidth>0');
 assert.ok(await evaluate('document.getElementById("large-pair-qr").naturalWidth>=400'));
 assert.equal(await evaluate('document.getElementById("large-pair-qr").src'),await evaluate('document.getElementById("pair-qr").src'));
 const oldQr=await evaluate('document.getElementById("large-pair-qr").src');
 await evaluate('document.getElementById("refresh-pair-qr").click()');
 await until('document.getElementById("large-pair-qr").src!=='+JSON.stringify(oldQr));
 await until('document.getElementById("large-pair-qr").complete && document.getElementById("large-pair-qr").naturalWidth>0');
 await writeFile(join(dir,remoteMode?'remote-pairing-large.png':'pairing-large.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 await evaluate('document.getElementById("close-pair-dialog").click()');
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
 // Pending selections can be cancelled before a phone arrives.
 await evaluate('document.querySelector("[data-source=phoneCamera]").click()');
 assert.equal(await evaluate('!document.getElementById("cancel-switch").hidden'),true);
 await evaluate('document.getElementById("cancel-switch").click()');
 assert.equal(await evaluate('document.getElementById("cancel-switch").hidden'),true);

 // Two real browser WebRTC peers emulate the Android sender over the actual signaling server.
 await evaluate('('+installPhone.toString()+')()');
 await until('document.getElementById("state-phoneScreen").classList.contains("ready") && document.getElementById("state-phoneCamera").classList.contains("ready")');
 await until('window.__phone.qualities.length>0');
 assert.equal(await evaluate('document.getElementById("monitor-phone").checked'),false);
 await evaluate('document.getElementById("enable-audio").click()',true);
 await until('document.getElementById("enable-audio").disabled');
 await until('document.getElementById("phone-audio-meter").value>5');
 await evaluate('document.getElementById("monitor-phone").click()',true);
 await until('document.getElementById("monitor-status").textContent.includes("监听已开启")');
 await evaluate('document.getElementById("monitor-phone").click()',true);
 if(remote?.relayOnly){
  await until('(async()=>{for(const item of window.__phone.links.values()){const stats=await item.pc.getStats();const transport=[...stats.values()].find(row=>row.type==="transport"&&row.selectedCandidatePairId);const pair=transport&&stats.get(transport.selectedCandidatePairId);if(!pair||![stats.get(pair.localCandidateId),stats.get(pair.remoteCandidateId)].some(c=>c?.candidateType==="relay"))return false;}return true;})()');
 }
 // Live transport changes must travel over signaling without replacing the recorder.
 await evaluate('document.getElementById("auto-quality").click();document.getElementById("transport-quality").value="detail";document.getElementById("transport-quality").dispatchEvent(new Event("change"))');
 await until('window.__phone.qualities.at(-1)==="detail"');
 // Direct and rapid faded source switches must finish on an actual decoded frame.
 await evaluate('document.getElementById("transition-mode").value="cut";document.getElementById("transition-mode").dispatchEvent(new Event("change"));document.querySelector("[data-source=phoneCamera]").click();document.querySelector("[data-layout=single]").click()');
 await sleep(150);
 assert.equal(await evaluate('document.querySelector(".source.selected").dataset.source'),'phoneCamera');
 assert.ok(await evaluate('(()=>{const pixel=document.getElementById("stage").getContext("2d").getImageData(640,40,1,1).data;return pixel[0]>100&&pixel[1]>50;})()'));
 await evaluate('document.getElementById("transition-mode").value="fade";document.getElementById("transition-mode").dispatchEvent(new Event("change"));for(let i=0;i<16;i++)document.querySelector("[data-source="+(i%2?"phoneScreen":"phoneCamera")+"]").click()');
 await sleep(250);
 assert.equal(await evaluate('document.querySelector(".source.selected").dataset.source'),'phoneScreen');
 assert.ok(await evaluate('(()=>{const pixel=document.getElementById("stage").getContext("2d").getImageData(640,40,1,1).data;return pixel[1]>pixel[0]&&pixel[1]>60;})()'));
 if(process.env.FLOWCAST_TEST_MDNS==='1')assert.ok(await evaluate('window.__maskedCandidates>0'),'must actually exercise masked desktop candidates');
 assert.ok(await evaluate('document.querySelector(".source.selected").dataset.source.startsWith("phone")'));await evaluate('window.__phone.pauseFrames()');await sleep(4200);assert.equal(await evaluate('document.getElementById("state-phoneScreen").classList.contains("ready")'),true);
 await evaluate('document.querySelector("[data-layout=grid]").click();document.getElementById("record").click()',true);await until('window.__recorders[0]?.state === "recording"');await sleep(2000);
 assert.equal(await evaluate('document.getElementById("quality").disabled'),true);
 assert.equal(await evaluate('document.getElementById("transport-quality").disabled'),false);
 await evaluate('document.getElementById("transport-quality").value="smooth";document.getElementById("transport-quality").dispatchEvent(new Event("change"))');
 await until('window.__phone.qualities.at(-1)==="smooth"');
 assert.equal(await evaluate('window.__recorders[0].state'),'recording');
 const audioTrack=await evaluate('window.__recorders[0].stream.getAudioTracks()[0].id');
 await evaluate('document.getElementById("monitor-phone").click()',true);
 await until('document.getElementById("monitor-status").textContent.includes("监听已开启")');
 assert.equal(await evaluate('window.__recorders[0].stream.getAudioTracks()[0].id'),audioTrack);
 await evaluate('document.getElementById("monitor-phone").click()',true);
 assert.equal(await evaluate('document.getElementById("stage").width'),expectedWidth);
 let items=await(await fetch(base+'/api/recordings')).json();assert.equal(items.length,1);assert.ok(items[0].bytes>0,'recording must reach disk before stop');const id=items[0].id;
 await evaluate('document.getElementById("pause").click()');await until('window.__recorders[0].state === "paused"');await sleep(300);const timer=await evaluate('document.getElementById("timer").textContent');await sleep(1400);assert.equal(await evaluate('document.getElementById("timer").textContent'),timer);
 await evaluate('document.querySelector("[data-layout=pip]").click();document.querySelector("[data-source=phoneScreen]").click();document.getElementById("pause").click()');await sleep(1800);assert.equal(await evaluate('window.__recorders[0].state'),'recording');assert.equal(await evaluate('window.__recorders.length'),1);
 await evaluate('document.getElementById("stop").click()');await until('!!document.querySelector("#export-list a")');
 const output=await evaluate('('+decode.toString()+')(document.querySelector("#export-list a").href)');assert.equal(output.width,expectedWidth);assert.equal(output.height,expectedHeight);assert.ok(output.duration>2&&output.duration<6,'pause excluded from final media: '+output.duration);
 const audio=await verifyAudio(server.recordings.path(id,'.webm'));assert.ok(audio.rms>0.005,'phone microphone must be audible in the saved recording: '+audio.rms);
 const range=await fetch(base+'/api/recordings/'+id+'/file',{headers:{Range:'bytes=0-31'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,32);
 await evaluate('document.querySelector("#export-list button").click()');await until('!!document.querySelector("#export-list a[href$=mp4]")');
 const mp4=await evaluate('('+decode.toString()+')(document.querySelector("#export-list a[href$=mp4]").href)');assert.equal(mp4.width,expectedWidth);assert.equal(mp4.height,expectedHeight);const mp4Audio=await verifyAudio(server.recordings.path(id,'.mp4'));assert.ok(mp4Audio.rms>0.005,'MP4 must retain phone audio');
  await evaluate('document.getElementById("add-camera").click()',true);await until('document.getElementById("state-webcam").textContent.includes("已接入")');
 await evaluate('document.getElementById("add-mic").click()',true);await until('document.getElementById("audio-status").textContent.includes("已接收")');
 await fetch(base+'/api/disconnect',{method:'POST'});await until('!document.getElementById("state-phoneScreen").classList.contains("ready")');
 await evaluate('window.__phone.stop()');await evaluate('('+installPhone.toString()+')()');await until('document.getElementById("state-phoneScreen").classList.contains("ready")');
 await evaluate('document.querySelector("[data-layout=single]").click()');await sleep(200);const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(dir,remoteMode?'remote-desktop.png':'desktop.png'),Buffer.from(shot.data,'base64'));
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(200);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 await evaluate('window.__phone.stop()');const orphan=await server.recordings.start();await server.recordings.append(orphan.id,0,await readFile(server.recordings.path(id,'.webm')));await call('Page.reload');await until('Array.from(document.querySelectorAll("#export-list button")).some(button=>button.textContent==="结束并恢复这段录制")');await evaluate('Array.from(document.querySelectorAll("#export-list button")).find(button=>button.textContent==="结束并恢复这段录制").click()');await until('document.querySelectorAll("#export-list a").length===3');assert.equal(errors.length,0,JSON.stringify(errors));
 if(remote){
  await evaluate('document.getElementById("disable-remote").click()');
  await until('!document.getElementById("network").disabled');
  assert.equal((await(await fetch(base+'/api/remote')).json()).enabled,false);
 }
 const restartPort=server.address().port,restartTlsPort=server.secure.address().port;await server.shutdown();server=await startStudio({port:restartPort,tlsPort:restartTlsPort,autoPort:false,dataDir:join(runDir,"data"),recordingDir:join(runDir,"recordings")});await until('(async()=>{const d=await(await fetch("/api/diagnostics")).json();return d.desktopConnected;})()');await evaluate('document.getElementById("connection-details").open=true;document.getElementById("refresh-diagnostics").click()');await until('document.getElementById("diagnostics").textContent.includes("工作台信令：已连接")');
 const result={passed:true,remoteSignaling:remoteMode,forcedRelay:!!remote?.relayOnly,audio,mp4Audio,recordingQuality:detail?'detail':'balanced',mdnsCompatibility:process.env.FLOWCAST_TEST_MDNS==='1',output,mp4,recordingDir:join(runDir,'recordings'),consoleErrors:errors,checks:['phone audio level before recording','opt-in phone listening','listening toggle retains recording audio track','saved WebM and MP4 have non-silent phone audio','enlarged QR and refresh stay in workstation','enlarged QR at mobile width','pending source cancellation','rapid source switches and decoded canvas pixels','live transport quality relay while recording','fixed recording dimensions and one recorder during transport changes','synthetic webcam and microphone','two WebRTC video sources with streamless microphone','phone video decodes before sound activation','static phone screen remains available','phone disconnect and reconnect','streaming writes before stop','layout switch','pause timer and media duration','one recorder across resume','persisted WebM and MP4 decode','HTTP byte range','TLS pairing QR renders','recordings survive page reload','orphaned recording recovery from UI','390px responsive width','server restart renews credentials without page reload','connection diagnostics reflect actual signaling']};await writeFile(join(dir,remoteMode?'remote-browser-result.json':'browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{if(ws){try{await call('Browser.close');}catch{}ws.close();}child.kill();await server.shutdown();await remote?.close();}
async function verifyAudio(file){
 return new Promise((resolve,reject)=>{const child=spawn(ffmpeg,['-v','error','-nostdin','-i',file,'-map','0:a:0','-ac','1','-ar','16000','-f','f32le','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});const parts=[],errors=[];child.stdout.on('data',part=>parts.push(part));child.stderr.on('data',part=>errors.push(part));child.on('error',reject);child.on('exit',code=>{if(code!==0)return reject(Error('Audio decode failed: '+Buffer.concat(errors).toString()));const bytes=Buffer.concat(parts);let sum=0,peak=0;for(let i=0;i+4<=bytes.length;i+=4){const value=bytes.readFloatLE(i);sum+=value*value;peak=Math.max(peak,Math.abs(value));}resolve({rms:Math.sqrt(sum/(bytes.length/4)),peak,samples:bytes.length/4});});});
}
async function decode(url){const video=document.createElement('video');video.muted=true;video.src=url;document.body.append(video);try{await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Cannot decode '+url));});return {width:video.videoWidth,height:video.videoHeight,duration:video.duration};}finally{video.remove();}}
async function installPhone(){
 const state=await(await fetch('/api/state')).json();
 const pair=state.remote?.enabled?null:await(await fetch('/api/pair',{method:'POST',body:JSON.stringify({code:state.code,name:'Synthetic WebRTC phone'})})).json();
 const socket=new WebSocket(pair?'ws://'+location.host+'/signal/phone?token='+pair.token:window.__remotePhoneUrl),links=new Map(),timers=[],qualities=[];let queue=Promise.resolve(),rtcConfig={iceServers:[]},ready;
 const readyMessage=new Promise(resolve=>ready=resolve);
 window.__phone={qualities,links,pauseFrames(){timers.forEach(clearInterval);},stop(){socket.close();for(const item of links.values()){item.pc.close();item.stream.getTracks().forEach(track=>track.stop());}timers.forEach(clearInterval);}};
 socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.type==='rtc-config'){rtcConfig=msg.config;return;}if(msg.type==='ready'){rtcConfig=msg.config||rtcConfig;ready();return;}if(msg.type==='quality'){qualities.push(msg.profile);return;}queue=queue.then(async()=>{const item=links.get(msg.source);if(item?.session!==msg.session)return;if(msg.type==='answer'){const sdp=window.__rejectMdns?msg.sdp.split('\r\n').filter(line=>!line.startsWith('a=candidate:')).join('\r\n'):msg.sdp;await item.pc.setRemoteDescription({type:'answer',sdp});for(const candidate of item.pending)await item.pc.addIceCandidate(candidate);item.pending=[];}else if(msg.type==='candidate'){if(window.__rejectMdns&&msg.candidate.candidate.includes('.local'))return;if(item.pc.remoteDescription)await item.pc.addIceCandidate(msg.candidate);else item.pending.push(msg.candidate);}}).catch(error=>{setTimeout(()=>{throw error;});});};
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 await Promise.race([readyMessage,new Promise((_,reject)=>setTimeout(()=>reject(Error('Phone handshake timed out')),10000))]);
 for(const [index,source]of ['phoneScreen','phoneCamera'].entries()){
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=480;const context=canvas.getContext('2d');const draw=()=>{context.fillStyle=index?'#b36743':'#38695d';context.fillRect(0,0,320,480);context.fillStyle='white';context.font='22px sans-serif';context.fillText(source,30,150);context.fillText(String(Date.now()),30,240);};draw();timers.push(setInterval(draw,100));
  const stream=canvas.captureStream(10),pc=new (window.__NativePeer||RTCPeerConnection)(rtcConfig),session=crypto.randomUUID();links.set(source,{pc,session,stream,pending:[]});stream.getTracks().forEach(track=>pc.addTrack(track,stream));if(source==='phoneScreen'){const microphone=await navigator.mediaDevices.getUserMedia({audio:true,video:false});for(const track of microphone.getAudioTracks()){stream.addTrack(track);pc.addTrack(track);}}pc.onicecandidate=event=>{if(event.candidate&&!window.__rejectMdns&&socket.readyState===1)socket.send(JSON.stringify({type:'candidate',source,session,candidate:event.candidate.toJSON()}));};await pc.setLocalDescription(await pc.createOffer());socket.send(JSON.stringify({type:'offer',source,session,sdp:window.__rejectMdns?pc.localDescription.sdp.split('\r\n').filter(line=>!line.startsWith('a=candidate:')).join('\r\n'):pc.localDescription.sdp}));
 }
}
