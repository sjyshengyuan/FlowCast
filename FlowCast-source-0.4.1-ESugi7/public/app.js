import {PhoneReceiver,PhoneMedia} from './rtc.js';
import {AudioMixer} from './audio.js';
import {QUALITY_PRESETS,FramePacer,SourceSwitch,AdaptiveQuality} from './experience.js';
const $=id=>document.getElementById(id);
const canvas=$('stage'),ctx=canvas.getContext('2d',{alpha:false});
const names={desktop:'电脑屏幕',phoneScreen:'手机屏幕',webcam:'电脑摄像头',phoneCamera:'手机前摄像头'};
const sources=Object.fromEntries(Object.keys(names).map(key=>[key,{element:null,stream:null,last:0,pending:false}]));
let main='desktop',secondary='phoneCamera',layout='single',recorder=null,startTime=0,pauseStart=0,pausedTotal=0,audioContext=null,audioDestination=null,mic=null,renderId=null,outputStream=null,stopping=false;
const mixer=new AudioMixer(),audioNodes=mixer.nodes;
let recordingId=null,writeQueue=Promise.resolve(),writeError=null,queuedBytes=0,sequence=0,starting=false,receiver=null;
const phoneStats={};
const sourceSwitch=new SourceSwitch(main),pacer=new FramePacer();
let quality='balanced';try{const saved=localStorage.getItem('flowcast-quality');if(Object.hasOwn(QUALITY_PRESETS,saved))quality=saved;}catch{}
let transportQuality=quality,autoQuality=true,transitionMode='fade';
try{const saved=localStorage.getItem('flowcast-transport-quality');if(Object.hasOwn(QUALITY_PRESETS,saved))transportQuality=saved;autoQuality=localStorage.getItem('flowcast-auto-quality')!=='false';if(localStorage.getItem('flowcast-transition')==='cut')transitionMode='cut';}catch{}
const adaptive=new AdaptiveQuality(transportQuality,autoQuality);
function configureTransport(){
 adaptive.configure($('transport-quality').value,$('auto-quality').checked);receiver?.setQuality(adaptive.current);
 try{localStorage.setItem('flowcast-transport-quality',adaptive.ceiling);localStorage.setItem('flowcast-auto-quality',String(adaptive.enabled));}catch{}
 updateTransportStatus();
}
function updateTransportStatus(){$('transport-status').textContent=(adaptive.enabled?'自动调节 · 当前请求：':'固定传输 · 当前请求：')+QUALITY_PRESETS[adaptive.current].label+'；实际画质以收到画面为准。';}
function adaptTransport(rows){const next=adaptive.sample(rows,performance.now());if(next){receiver?.setQuality(next);updateTransportStatus();}}
$('transport-quality').value=transportQuality;$('auto-quality').checked=autoQuality;
$('transport-quality').onchange=configureTransport;$('auto-quality').onchange=configureTransport;
$('transition-mode').value=transitionMode;$('transition-mode').onchange=()=>{transitionMode=$('transition-mode').value;transitionStart=0;try{localStorage.setItem('flowcast-transition',transitionMode);}catch{}updateSelection();render();};
$('cancel-switch').onclick=()=>{sourceSwitch.cancel();updateSelection();};
updateTransportStatus();
let transition=null,transitionStart=0,frameSamples=0,frameSampleStart=performance.now(),renderFps=0;
const heldFrames=new Map();
function beginTransition(){if(transitionMode==='cut'||matchMedia('(prefers-reduced-motion: reduce)').matches){transitionStart=0;return;}if(!transition)transition=document.createElement('canvas');if(transition.width!==canvas.width)transition.width=canvas.width;if(transition.height!==canvas.height)transition.height=canvas.height;transition.getContext('2d').drawImage(canvas,0,0);transitionStart=performance.now();}
function updateSelection(){document.querySelectorAll('.source').forEach(el=>{el.classList.toggle('selected',el.dataset.source===main);el.classList.toggle('pending',el.dataset.source===sourceSwitch.pending);el.setAttribute('aria-pressed',String(el.dataset.source===main));});$('switch-status').textContent=sourceSwitch.pending?'等待'+names[sourceSwitch.pending]+'就绪，当前画面继续':(transitionMode==='cut'?'画面就绪后直接切换':'画面就绪后切换 · 140 ms 渐变');$('cancel-switch').hidden=!sourceSwitch.pending;}
function applyQuality(value){
 if(!Object.hasOwn(QUALITY_PRESETS,value)||starting||stopping||recorder&&recorder.state!=='inactive')return;
 quality=value;const preset=QUALITY_PRESETS[value];canvas.width=preset.width;canvas.height=preset.height;transition=null;transitionStart=0;
 $('quality').value=value;$('quality-help').textContent=preset.description+'；录制期间固定此档位。手机传输可独立调节。';
 $('output-resolution').textContent=preset.width+' × '+preset.height;$('output-fps').textContent='· '+preset.fps+' FPS 目标';
 try{localStorage.setItem('flowcast-quality',value);}catch{}
 for(const key of ['desktop','webcam']){const track=sources[key].stream?.getVideoTracks()[0];if(track){track.contentHint=key==='desktop'?'detail':'motion';track.applyConstraints({width:{ideal:preset.width},height:{ideal:preset.height},frameRate:{ideal:preset.fps,max:preset.fps}}).catch(()=>{});}}
 pacer.reset();render();
}
$('quality').onchange=()=>{applyQuality($('quality').value);notice('已切换到'+QUALITY_PRESETS[quality].label+'，下一段录制使用此画质。');};
async function api(path,options){const response=await fetch(path,options);const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败');return result;}

function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
function ready(key){const s=sources[key];return !!s.stream&&s.stream.getVideoTracks().some(t=>t.readyState==='live'&&!t.muted)&&s.element?.readyState>=2;}
function audioSetup(resume=true){audioContext=mixer.ensure();audioDestination=mixer.destination;return resume?mixer.resume():Promise.resolve();}
function attachAudio(key,stream){mixer.attach(key,stream);updateAudio();}
function updateAudio(){
 const phone=mixer.measurePhone();$('audio-status').textContent=$('mute').checked?'录制声音已静音':audioNodes.size?'已接收 '+audioNodes.size+' 路':'未接收音轨';
 $('phone-audio-meter').value=phone.level;
 $('phone-audio-state').textContent=!phone.tracks?'未收到手机音轨，请在手机开始共享前勾选麦克风':!phone.running?'已收到手机音轨，点击启用声音检测':phone.paused?'手机音轨已暂停，请检查手机麦克风权限':phone.audible?'正在收音 · '+phone.db+' dBFS':'已收到音轨 · 暂无明显声音，请对手机说话';
 $('enable-audio').disabled=!!phone.running;
 $('monitor-status').textContent=mixer.monitoring?'监听已开启 · '+(phone.tracks?'仅播放手机声音，建议戴耳机':'等待手机音轨'):'监听关闭 · 手机声音仍可进入录制';
}
function selectSource(key){if(!Object.hasOwn(sources,key))return;if(sourceSwitch.select(key,ready)){beginTransition();main=sourceSwitch.current;}updateSelection();}
async function addSource(key){try{await audioSetup();if(key==='desktop'&&window.flowcast){const selected=await chooseDesktop();if(!selected)return;await window.flowcast.selectSource(selected);}const stream=key==='desktop'?await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:QUALITY_PRESETS[quality].width},height:{ideal:QUALITY_PRESETS[quality].height},frameRate:{ideal:30,max:30}},audio:true}):await navigator.mediaDevices.getUserMedia({video:{width:{ideal:QUALITY_PRESETS[quality].width},height:{ideal:QUALITY_PRESETS[quality].height},frameRate:{ideal:30,max:30}},audio:false});stream.getVideoTracks()[0].contentHint=key==='desktop'?'detail':'motion';const video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=stream;await video.play();const old=sources[key].stream;sources[key]={element:video,stream,last:Date.now()};old?.getTracks().forEach(t=>t.stop());attachAudio(key,stream);stream.getVideoTracks()[0].addEventListener('ended',()=>{if(sources[key].stream===stream){attachAudio(key,null);notice(names[key]+'已断开；录制中的该位置会显示占位画面。',true);}});selectSource(key);notice(names[key]+'已接入，可以随时切换或调整布局。');}catch(error){notice(error.name==='NotAllowedError'?'授权已取消或被拒绝，请重新点击并允许访问。':'无法接入画面：'+error.message,true);}}
$('add-screen').onclick=()=>addSource('desktop');$('add-camera').onclick=()=>addSource('webcam');
$('add-mic').onclick=async()=>{try{await audioSetup();if(mic){mic.getTracks().forEach(t=>t.stop());mic=null;attachAudio('mic',null);$('add-mic').textContent='＋ 开启电脑麦克风';}else{mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});attachAudio('mic',mic);$('add-mic').textContent='－ 关闭电脑麦克风';notice('电脑麦克风已开启。建议戴耳机，减少回声。');}}catch(error){notice('麦克风无法开启：'+error.message,true);}};
$('mute').onchange=()=>{mixer.setMuted($('mute').checked);updateAudio();};
$('enable-audio').onclick=async()=>{try{await audioSetup();updateAudio();}catch(error){notice(error.message,true);}};
$('monitor-phone').onchange=async()=>{const enabled=$('monitor-phone').checked;mixer.setMonitoring(false);if(enabled){try{await audioSetup();if($('monitor-phone').checked)mixer.setMonitoring(true);}catch(error){$('monitor-phone').checked=false;notice('无法开启监听：'+error.message,true);}}updateAudio();};
setInterval(updateAudio,250);
document.querySelectorAll('.source').forEach(el=>el.onclick=()=>selectSource(el.dataset.source));
document.querySelectorAll('.layout').forEach(el=>el.onclick=()=>{beginTransition();layout=el.dataset.layout;document.querySelectorAll('.layout').forEach(b=>b.classList.toggle('active',b===el));$('layout-label').textContent={single:'单画面',pip:'画中画',split:'左右共屏',grid:'四宫格'}[layout];});
$('secondary').onchange=()=>{beginTransition();secondary=$('secondary').value;};
function drawSource(key,x,y,w,h){ctx.fillStyle='#111821';ctx.fillRect(x,y,w,h);const s=sources[key];const held=heldFrames.get(key),recovering=!ready(key)&&held&&performance.now()<held.until;if(ready(key)||recovering){const el=recovering?held.canvas:s.element,sw=el.videoWidth||el.naturalWidth||el.width,sh=el.videoHeight||el.naturalHeight||el.height;if(sw&&sh){const scale=Math.min(w/sw,h/sh);ctx.drawImage(el,x+(w-sw*scale)/2,y+(h-sh*scale)/2,sw*scale,sh*scale);if(recovering){ctx.fillStyle='#111c';ctx.fillRect(x,y+h-34,w,34);ctx.fillStyle='#f3be65';ctx.font='15px Segoe UI, Microsoft YaHei';ctx.textAlign='center';ctx.fillText('正在恢复连接 · 保留上一帧',x+w/2,y+h-12);}}}else{ctx.fillStyle='#263344';ctx.beginPath();ctx.arc(x+w/2,y+h/2-35,30,0,Math.PI*2);ctx.fill();ctx.textAlign='center';ctx.fillStyle='#c1cbd8';ctx.font=Math.max(15,Math.min(25,w/20))+'px Segoe UI, Microsoft YaHei';ctx.fillText(names[key],x+w/2,y+h/2+25);ctx.fillStyle='#67778d';ctx.font='15px Segoe UI, Microsoft YaHei';ctx.fillText(s.last?'连接中断，等待恢复':'等待接入画面',x+w/2,y+h/2+55);}}
function render(){if(sourceSwitch.commit(ready)){beginTransition();main=sourceSwitch.current;updateSelection();}ctx.save();ctx.scale(canvas.width/1280,canvas.height/720);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality=quality==='detail'?'high':'low';ctx.fillStyle='#080d14';ctx.fillRect(0,0,1280,720);if(layout==='single'||layout==='pip'){drawSource(main,0,0,1280,720);if(layout==='pip'){ctx.fillStyle='#bccbda';ctx.fillRect(904,484,344,200);drawSource(secondary,908,488,336,192);}}else if(layout==='split'){drawSource(main,0,0,636,720);drawSource(secondary,644,0,636,720);}else{Object.keys(names).forEach((key,i)=>drawSource(key,(i%2)*644,Math.floor(i/2)*364,636,356));}ctx.restore();if(transition&&transitionStart){const elapsed=performance.now()-transitionStart;if(elapsed<140){ctx.save();ctx.globalAlpha=1-Math.max(0,elapsed)/140;ctx.drawImage(transition,0,0,canvas.width,canvas.height);ctx.restore();}else transitionStart=0;}frameSamples++;}
function scheduleFrame(){renderId=document.hidden?setTimeout(()=>tick(performance.now()),1000/30):requestAnimationFrame(tick);}
function tick(now){const live=Object.keys(sources).some(ready),active=recorder&&recorder.state==='recording';if(pacer.due(now,live||active||sourceSwitch.pending?30:4))render();if(now-frameSampleStart>=1000){renderFps=Math.round(frameSamples*1000/(now-frameSampleStart));frameSamples=0;frameSampleStart=now;}scheduleFrame();}
document.addEventListener('visibilitychange',()=>{clearTimeout(renderId);cancelAnimationFrame(renderId);pacer.reset();scheduleFrame();});
scheduleFrame();render();
function updateControls(){const active=recorder&&recorder.state!=='inactive',paused=recorder?.state==='paused';$('quality').disabled=!!active||stopping||starting;$('record').disabled=active||stopping||starting;$('pause').disabled=!active||stopping;$('stop').disabled=!active||stopping;$('pause').textContent=paused?'▶ 继续录制':'Ⅱ 暂停';$('record-status').textContent=starting?'正在准备录制':stopping?'正在生成文件':paused?'已暂停 · 预览继续':active?'正在录制':'准备录制';$('record-dot').className=paused?'paused':active?'recording':'';}
async function refreshExports(){try{const items=await api('/api/recordings');$('export-list').replaceChildren();$('exports').hidden=!items.length;for(const item of items){const row=document.createElement('div');row.className='recording-item';const label=document.createElement('span');label.textContent=new Date(item.created).toLocaleString()+' · '+(item.bytes/1048576).toFixed(1)+' MB';row.append(label);if(item.state==='ready'){for(const format of item.mp4?['webm','mp4']:['webm']){const link=document.createElement('a');link.href='/api/recordings/'+item.id+'/file?format='+format;link.download='FlowCast-'+item.id+'.'+format;link.textContent='下载 '+format.toUpperCase();row.append(link);}if(!item.mp4){const convert=document.createElement('button');convert.textContent='导出 MP4';convert.onclick=async()=>{convert.disabled=true;convert.textContent='转换中…';try{await api('/api/recordings/'+item.id+'/mp4',{method:'POST'});await refreshExports();}catch(error){notice(error.message,true);convert.disabled=false;convert.textContent='重试 MP4';}};row.append(convert);}}else if(item.state==='recoverable'){const recover=document.createElement('button');recover.textContent='恢复已有录制';recover.onclick=async()=>{recover.disabled=true;try{const result=await api('/api/recordings/'+item.id+'/recover',{method:'POST'});if(result.state!=='ready')notice('恢复未成功：'+result.error,true);await refreshExports();}catch(error){notice(error.message,true);recover.disabled=false;}};row.append(recover);}else{const state=document.createElement('span');state.textContent=item.state==='recording'?'录制中':'正在整理文件';row.append(state);if(item.state==='recording'&&item.id!==recordingId){const recover=document.createElement('button');recover.textContent='结束并恢复这段录制';recover.onclick=async()=>{recover.disabled=true;try{const result=await api('/api/recordings/'+item.id+'/finish',{method:'POST'});notice(result.state==='ready'?'已恢复保存到电脑的录制。':'暂时无法恢复：'+result.error,result.state!=='ready');await refreshExports();}catch(error){notice(error.message,true);recover.disabled=false;}};row.append(recover);}}$('export-list').append(row);}}catch(error){notice('读取录制列表失败：'+error.message,true);}}
function queueChunk(blob){if(blob.size>8*1024*1024){for(let offset=0;offset<blob.size;offset+=8*1024*1024)queueChunk(blob.slice(offset,offset+8*1024*1024));return;}const seq=sequence++;queuedBytes+=blob.size;if(queuedBytes>64*1024*1024&&recorder?.state==='recording'){$('pause').click();notice('磁盘写入跟不上录制，已自动暂停。等待写入完成后可继续。',true);}writeQueue=writeQueue.then(async()=>{try{if(writeError)return;let failure;for(let attempt=0;attempt<3;attempt++){try{await api('/api/recordings/'+recordingId+'/chunk?seq='+seq,{method:'POST',body:blob});failure=null;break;}catch(error){failure=error;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}}if(failure)throw failure;}catch(error){writeError=error;if(recorder?.state==='recording'){$('pause').click();}notice('保存失败，已暂停：'+error.message+'。请结束并恢复已保存的部分。',true);}finally{queuedBytes-=blob.size;}});}
$('record').onclick=async()=>{if(starting||stopping||recorder&&recorder.state!=='inactive')return;if(!Object.keys(sources).some(ready)){notice('请至少接入一路有效画面再开始录制。',true);return;}starting=true;updateControls();try{await audioSetup();mixer.setMuted($('mute').checked);outputStream=canvas.captureStream(QUALITY_PRESETS[quality].fps);audioDestination.stream.getAudioTracks().forEach(t=>outputStream.addTrack(t));const mime=['video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw new Error('当前环境不支持录制');recorder=new MediaRecorder(outputStream,{mimeType:mime,videoBitsPerSecond:QUALITY_PRESETS[quality].bitrate});recordingId=(await api('/api/recordings',{method:'POST'})).id;writeQueue=Promise.resolve();sequence=0;writeError=null;queuedBytes=0;recorder.ondataavailable=e=>{if(e.data.size)queueChunk(e.data);};recorder.onerror=e=>{notice('录制错误：'+(e.error?.message||'未知错误'),true);if(recorder.state!=='inactive')recorder.stop();};recorder.onstop=async()=>{stopping=true;updateControls();outputStream?.getVideoTracks().forEach(t=>t.stop());outputStream=null;await writeQueue;try{const result=await api('/api/recordings/'+recordingId+'/finish',{method:'POST'});notice(result.state==='ready'?(writeError?'录制已保存，但写入故障后可能有缺失，请检查视频。':'录制已保存到电脑。可下载 WebM 或导出 MP4。'):'文件已保留，可在录制列表尝试恢复。',!!writeError||result.state!=='ready');}catch(error){notice('整理文件失败：'+error.message+'。已写入磁盘的数据保留，可重新打开后恢复。',true);}finally{recordingId=null;stopping=false;updateControls();window.flowcast?.setRecording(false);refreshExports();}};startTime=performance.now();pausedTotal=0;pauseStart=0;recorder.start(1000);window.flowcast?.setRecording(true);notice('正在录制并持续保存到电脑。可随时切换、共屏或暂停。');}catch(error){outputStream?.getVideoTracks().forEach(t=>t.stop());outputStream=null;if(recordingId){await api('/api/recordings/'+recordingId+'/finish',{method:'POST'}).catch(()=>{});recordingId=null;}notice('无法开始录制：'+error.message,true);}finally{starting=false;updateControls();}};
$('pause').onclick=()=>{if(recorder?.state==='recording'){recorder.pause();pauseStart=performance.now();}else if(recorder?.state==='paused'){if(writeError||queuedBytes>16*1024*1024){notice('保存尚未恢复，请等待或结束录制。',true);return;}recorder.resume();pausedTotal+=performance.now()-pauseStart;pauseStart=0;}updateControls();};
$('stop').onclick=()=>{if(recorder&&recorder.state!=='inactive'){stopping=true;recorder.stop();updateControls();}};
setInterval(()=>{for(const key of Object.keys(sources)){const on=ready(key);$('state-'+key).textContent=on?(phoneStats[key]?'● '+(phoneStats[key].fps??'—')+' FPS · '+(phoneStats[key].bitrate??'—')+' Mbps':'● 已接入'):sources[key].last?'连接已中断':'未连接';$('state-'+key).classList.toggle('ready',on);}const values=Object.values(phoneStats),metric=field=>{const known=values.map(value=>value[field]).filter(Number.isFinite);return known.length?Math.max(...known):'—';},bad=values.some(value=>(value.lossPercent??0)>5||(value.bufferMs??0)>180||(value.rtt??0)>150);$('performance-status').textContent=renderFps+' FPS 合成 · 待保存 '+(queuedBytes/1048576).toFixed(1)+' MB';$('network-health').textContent=!values.length?'等待手机画面统计':(bad?'网络有波动 · ':'')+'网络往返 '+metric('rtt')+' ms · 接收缓冲 '+metric('bufferMs')+' ms · 丢包 '+metric('lossPercent')+'%';const count=Object.keys(sources).filter(ready).length;$('live-sources').textContent=count?count+' 路画面已接入':'尚未添加画面来源';if(recorder&&recorder.state!=='inactive'){let seconds=Math.floor(((pauseStart||performance.now())-startTime-pausedTotal)/1000);$('timer').textContent=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(x=>String(x).padStart(2,'0')).join(':');}},250);
const events=new EventSource('/api/events');events.onopen=()=>{$('connection').textContent='● 本地服务已连接';};events.onerror=()=>{$('connection').textContent='服务连接中断';};
const phoneMedia=new Map();
function acceptPhoneStream(key,stream){
 let media=phoneMedia.get(key);if(!media){media=new PhoneMedia({onDetach:entry=>{if(entry.element.readyState<2)return;const snapshot=document.createElement('canvas');snapshot.width=entry.element.videoWidth;snapshot.height=entry.element.videoHeight;if(snapshot.width&&snapshot.height){snapshot.getContext('2d').drawImage(entry.element,0,0);heldFrames.set(key,{canvas:snapshot,until:performance.now()+3000});}},onChange:entry=>{if(!entry.stream){entry.last=sources[key].last;delete phoneStats[key];}sources[key]=entry;},onAudio:value=>{audioSetup(false);attachAudio(key,value);},onReady:()=>{heldFrames.delete(key);$('phone-status').textContent='已收到手机画面';if(!ready(main)&&!sourceSwitch.pending)selectSource(key);notice(names[key]+'已接入，可以开始录制。');},onError:error=>notice(names[key]+'无法播放：'+error.message,true)});phoneMedia.set(key,media);}return media.set(stream);
}
async function loadState(){
 try{
  const state=await api('/api/state'),selected=$('network').value;
  $('network').replaceChildren();
  for(const entry of state.pairing){const option=document.createElement('option');option.value=entry.address;option.selected=entry.address===selected;option.textContent=entry.name+' · '+entry.address;$('network').append(option);}
  const remote=state.remote||{enabled:false},available=remote.enabled?remote.state==='ready':state.pairing.length>0;
  $('remote-url').disabled=remote.enabled;$('remote-key').disabled=remote.enabled;$('enable-remote').disabled=remote.enabled;
  $('disable-remote').hidden=!remote.enabled;$('remote-pairing').hidden=!remote.enabled||!remote.payload;
  $('remote-pairing').value=remote.payload||'';$('network').disabled=remote.enabled;$('refresh-remote').hidden=!remote.enabled;
  const labels={connecting:'正在连接跨网服务',reconnecting:'跨网服务中断，正在重连',ready:'跨网配对已就绪',error:'跨网连接失败，请关闭后核对服务地址与接入密钥',off:'当前使用局域网连接'};
  $('remote-status').textContent=(labels[remote.state]||labels.off)+(remote.state==='ready'?(remote.hasTurn?' · 已配置视频中继':' · 未配置 TURN，部分网络可能无法传视频'):'');
  $('pair-code').textContent=remote.enabled?'跨网配对':'扫码连接';
  $('pair-network-step').textContent=remote.enabled?'电脑与手机均联网，可使用不同 Wi-Fi 或移动数据':'电脑与手机连接同一 Wi-Fi';
  $('pair-network-tip').textContent=remote.enabled?'视频通过 WebRTC 加密传输；无法直连时使用已配置的中继。':'视频通过 WebRTC 加密传输。建议使用同一 5 GHz Wi-Fi；连接失败时可切换上方网络。';
  $('network').hidden=remote.enabled;
  $('pair-mode-badge').textContent=remote.enabled?'跨网配对':'局域网配对';
  $('show-remote').hidden=remote.enabled;
  $('pair-mode-help').textContent=remote.enabled?'跨网模式：手机扫码或粘贴最新配对文本，两端均须联网。':'当前二维码仅供局域网使用。手机使用移动数据或另一 Wi-Fi 时，不能直接访问电脑的私网地址。';
  $('addresses').textContent=remote.enabled?'远程服务：'+remote.url:'';
  const update=()=>{
   const src=(remote.enabled?'/api/remote/qr?':'/api/qr?host='+encodeURIComponent($('network').value)+'&')+'t='+Date.now();
   $('enlarge-qr').disabled=!available;
   if(available){$('pair-qr').src=src;if($('pair-dialog').open)setLargeQr(src);}
   else{$('pair-qr').removeAttribute('src');$('large-pair-qr').removeAttribute('src');if($('pair-dialog').open)$('pair-dialog-status').textContent='连接未就绪，请稍后刷新。';}
  };
  $('network').onchange=update;update();if(!available&&!remote.enabled)$('addresses').textContent='请先连接 Wi-Fi';
  let receiverState=state;
  if(!receiver)receiver=new PhoneReceiver({quality:adaptive.current,key:state.desktopKey,getKey:async()=>{receiverState=await api('/api/state');return receiverState.desktopKey;},getLocalAddresses:()=>receiverState.pairing.map(entry=>entry.address),onStream:(...args)=>acceptPhoneStream(...args).catch(error=>notice(error.message,true)),onState:state=>$('phone-status').textContent=state,onStats:(key,stats)=>phoneStats[key]=stats,onStatsBatch:adaptTransport});
 }catch(error){notice('读取配对信息失败：'+error.message,true);}
}
$('show-remote').onclick=()=>{$('remote-settings').open=true;$('remote-settings').scrollIntoView({behavior:'smooth',block:'center'});};
$('enable-remote').onclick=async()=>{
 $('enable-remote').disabled=true;
 try{await api('/api/remote',{method:'POST',body:JSON.stringify({url:$('remote-url').value.trim(),accessKey:$('remote-key').value})});$('remote-key').value='';await loadState();}
 catch(error){notice(error.message,true);$('enable-remote').disabled=false;}
};
$('disable-remote').onclick=async()=>{try{await api('/api/remote',{method:'DELETE'});await loadState();}catch(error){notice(error.message,true);}};
$('refresh-remote').onclick=async()=>{try{await api('/api/remote/refresh',{method:'POST'});await loadState();}catch(error){notice(error.message,true);}};
events.addEventListener('remote',()=>loadState());
function setLargeQr(src){$('pair-dialog-title').textContent=$('pair-mode-badge').textContent+' · 手机扫描连接';$('pair-dialog-status').textContent='正在加载二维码…';$('large-pair-qr').src=src;}
$('large-pair-qr').onload=()=>{$('pair-dialog-status').textContent='对准完整二维码，保持片刻。';};
$('large-pair-qr').onerror=()=>{$('pair-dialog-status').textContent='二维码加载失败，请刷新二维码。';};
$('pair-qr').onerror=()=>{if($('network').value)$('addresses').textContent='二维码加载失败，请检查电脑服务后刷新页面。';};
$('enlarge-qr').onclick=()=>{if($('enlarge-qr').disabled)return;setLargeQr($('pair-qr').src);if(!$('pair-dialog').open)$('pair-dialog').showModal();};
$('pair-qr').onclick=()=>$('enlarge-qr').click();
$('refresh-pair-qr').onclick=async()=>{try{const state=await api('/api/remote');if(state.enabled)await api('/api/remote/refresh',{method:'POST'});await loadState();}catch(error){notice(error.message,true);}};
$('close-pair-dialog').onclick=()=>$('pair-dialog').close();
async function chooseDesktop(){const choices=await window.flowcast.sources();const dialog=$('screen-picker');$('screen-options').replaceChildren();return new Promise(resolve=>{dialog.onclose=()=>resolve(dialog.returnValue||null);for(const choice of choices){const button=document.createElement('button');const img=document.createElement('img');img.src=choice.thumbnail;const label=document.createElement('span');label.textContent=choice.name;button.append(img,label);button.onclick=()=>dialog.close(choice.id);$('screen-options').append(button);}dialog.returnValue='';dialog.showModal();});}
$('picker-cancel').onclick=()=>$('screen-picker').close('');
$('open-folder').onclick=()=>window.flowcast?window.flowcast.openRecordings():notice('录制文件保存在项目 recordings 目录。');
$('disconnect').onclick=async()=>{try{const res=await fetch('/api/disconnect',{method:'POST'});if(!res.ok)throw new Error('请求失败');notice('手机已断开，再次接入需在手机端重新配对。');}catch(error){notice(error.message,true);}};
window.addEventListener('keydown',event=>{if(['INPUT','SELECT','TEXTAREA','BUTTON','A'].includes(document.activeElement.tagName)||event.ctrlKey||event.metaKey||event.altKey)return;if(['1','2','3','4'].includes(event.key))selectSource(Object.keys(names)[Number(event.key)-1]);if(event.code==='Space'&&recorder?.state!=='inactive'&&recorder){event.preventDefault();$('pause').click();}});
window.addEventListener('beforeunload',event=>{if((recorder&&recorder.state!=='inactive')||stopping){event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(!window.flowcast&&document.hidden&&recorder?.state==='recording')notice('页面进入后台可能降低合成帧率，请保持控制台可见。',true);});
events.addEventListener('phone',()=>loadState());loadState();refreshExports();setInterval(loadState,300000);

async function refreshDiagnostics(){try{const d=await api("/api/diagnostics");const rows=["当前工作台："+location.origin,...Object.entries(phoneStats).map(([key,s])=>names[key]+"："+(s.route||"路径待确认")+" / "+(s.width||'—')+"×"+(s.height||'—')+" / "+(s.fps??'—')+" FPS / "+(s.bitrate??'—')+" Mbps / 丢包 "+(s.lossPercent??'—')+"% / 网络往返 "+(s.rtt??'—')+" ms / 接收缓冲 "+(s.bufferMs??'—')+" ms"),"手机信令："+(d.phoneConnected?"已连接":"未连接"),"工作台信令："+(d.desktopConnected?"已连接":"未连接"),"当前页面："+(receiver?.closed?"已被其他工作台替代":receiver?.ws?.readyState===1?"已连接":"未连接"),"设备："+(d.phoneName||"尚未配对"),"视频请求/应答："+d.events.filter(e=>e.event==="offer").length+" / "+d.events.filter(e=>e.event==="answer").length,...d.events.slice(-12).map(e=>new Date(e.time).toLocaleTimeString()+" "+e.role+" "+e.event+" "+(e.source||"")+" "+(e.detail||""))];$("diagnostics").textContent=rows.join("\n");}catch(error){$("diagnostics").textContent="读取诊断失败："+error.message;}}
$("refresh-diagnostics").onclick=refreshDiagnostics;$("connection-details").ontoggle=()=>{if($("connection-details").open)refreshDiagnostics();};$("reconnect-video").onclick=()=>{receiver?.reconnectVideo();};

setInterval(()=>{if($("connection-details").open)refreshDiagnostics();},3000);

applyQuality(quality);updateSelection();
