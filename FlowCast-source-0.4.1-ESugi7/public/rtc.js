// Preserve mDNS candidates and add numeric alternatives from the authenticated local service.
export function lanCandidates(candidate,addresses=[]){
 const fields=String(candidate?.candidate||'').trim().split(/\s+/);
 if(fields.length<8||fields[6]!=='typ'||fields[7]!=='host'||!fields[4].toLowerCase().endsWith('.local'))return [candidate];
 const ips=[...new Set(addresses)].filter(ip=>typeof ip==='string'&&/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)&&ip.split('.').every(n=>Number(n)<=255)&&! /^(0|127|169\.254|22[4-9]|23\d)\./.test(ip)).slice(0,8);
 return [candidate,...ips.map((ip,index)=>{const parts=[...fields];parts[0]='candidate:lan'+index+fields[0].slice(10,28);parts[4]=ip;return {...candidate,candidate:parts.join(' ')};})];
}
export function iceSummary(stats){
 const rows=[...stats.values()],pairs=rows.filter(row=>row.type==='candidate-pair');
 const sum=key=>pairs.reduce((total,row)=>total+(Number(row[key])||0),0);
 return '候选对 '+pairs.length+'，成功 '+pairs.filter(row=>row.state==='succeeded').length+'，探测发送 '+sum('requestsSent')+' / 收到应答 '+sum('responsesReceived');
}
// Interval deltas avoid reporting lifetime averages after congestion has cleared.
export function videoStats(row,previous,stats){
 const valid=previous&&row.id===previous.id&&row.timestamp>previous.timestamp&&row.bytesReceived>=previous.bytesReceived&&row.framesDecoded>=previous.framesDecoded;
 const delta=key=>valid&&Number.isFinite(row[key])&&Number.isFinite(previous[key])?Math.max(0,row[key]-previous[key]):null;
 const seconds=valid?(row.timestamp-previous.timestamp)/1000:0,frames=delta('framesDecoded'),bytes=delta('bytesReceived'),received=delta('packetsReceived'),lost=delta('packetsLost'),emitted=delta('jitterBufferEmittedCount'),delay=delta('jitterBufferDelay');
 const transport=stats.get(row.transportId)||[...stats.values()].find(value=>value.type==='transport'&&value.selectedCandidatePairId);
 const pair=transport&&stats.get(transport.selectedCandidatePairId);
 return {active:!!valid&&(received>0||lost>0||bytes>0),fps:frames!==null?Math.round(frames/seconds):Number.isFinite(row.framesPerSecond)?Math.round(row.framesPerSecond):null,
 bitrate:bytes===null?null:Math.round(bytes*8/seconds/10000)/100,
 lossPercent:received===null||lost===null||received+lost===0?null:Math.round(lost/(received+lost)*1000)/10,
 jitter:Number.isFinite(row.jitter)?Math.round(row.jitter*1000):null,
 bufferMs:emitted>0&&delay!==null?Math.round(delay/emitted*1000):null,
 rtt:Number.isFinite(pair?.currentRoundTripTime)?Math.round(pair.currentRoundTripTime*1000):null,
 route:pair?([stats.get(pair.localCandidateId),stats.get(pair.remoteCandidateId)].some(candidate=>candidate?.candidateType==='relay')?'中继':'直连'):null,width:row.frameWidth||null,height:row.frameHeight||null};
}

export class PhoneReceiver {
 constructor({quality='balanced',key,getKey,getLocalAddresses=()=>[],onStream,onState,onStats,onStatsBatch=()=>{}}){Object.assign(this,{quality,key,getKey,getLocalAddresses,onStream,onState,onStats,onStatsBatch});this.rtcConfig={iceServers:[],iceTransportPolicy:'all'};this.peers=new Map();this.earlyCandidates=new Map();this.closed=false;this.connectAttempt=0;this.generation=0;this.signaling=Promise.resolve();this.connect();this.stats=setInterval(()=>this.measure(),2000);}
 async connect(){
  if(this.closed)return;const attempt=++this.connectAttempt;clearTimeout(this.retry);
  if(this.getKey){try{const key=await this.getKey();if(this.closed||attempt!==this.connectAttempt)return;this.key=key;}catch{if(this.closed||attempt!==this.connectAttempt)return;this.onState("无法连接电脑服务，正在重试");if(!this.closed)this.retry=setTimeout(()=>this.connect(),1500);return;}}
  if(this.closed||attempt!==this.connectAttempt)return;
  const ws=this.ws=new WebSocket('ws://'+location.host+'/signal/desktop?key='+encodeURIComponent(this.key));
  ws.onopen=()=>{if(this.ws===ws&&!this.closed)this.onState('工作台已连接，等待手机');};
  ws.onmessage=e=>{
   if(this.ws!==ws||this.closed)return;
   let msg;try{msg=JSON.parse(e.data);}catch{return;}
   if(msg.type==='rtc-config'){
    if(JSON.stringify(this.rtcConfig)!==JSON.stringify(msg.config)){
     this.rtcConfig=msg.config;for(const entry of this.peers.values())try{entry.pc.setConfiguration?.(this.rtcConfig);}catch{this.onState('视频网络配置已更新，重新连接视频后生效');}
    }return;
   }
   if(msg.type==='phone'){if(!msg.connected)this.reset();if(msg.connected)this.sendQuality();this.onState(msg.connected?'正在建立视频连接':'手机已断开');return;}
   if(msg.type==='status'){this.onState(msg.message);return;}
   const generation=this.generation;
   // WebSocket preserves message order, but asynchronous SDP operations must also be serialized.
   this.signaling=this.signaling.then(()=>{if(generation===this.generation)return this.handle(msg,generation);}).catch(error=>{if(generation===this.generation){this.onState('视频协商失败：'+error.message);this.send({type:'status',message:('电脑视频协商失败：'+error.message).slice(0,300)});}});
  };
  ws.onclose=e=>{if(this.ws!==ws)return;this.reset();if(e.code===4002){this.closed=true;clearInterval(this.stats);this.onState('另一工作台已打开');return;}this.onState('正在重连电脑服务');if(!this.closed)this.retry=setTimeout(()=>this.connect(),1500);};
 }
 setQuality(quality){if(!['smooth','balanced','detail'].includes(quality))return;this.quality=quality;for(const entry of this.peers.values())for(const receiver of entry.pc.getReceivers?.()||[])this.tuneReceiver(receiver);this.sendQuality();}
 sendQuality(){this.send({type:'quality',profile:this.quality});}
 tuneReceiver(receiver){if(!receiver||receiver.track?.kind!=='video')return;try{if('jitterBufferTarget' in receiver)receiver.jitterBufferTarget=({smooth:20,balanced:40,detail:80}[this.quality]??40);}catch{}}
 reconnectVideo(){if(this.closed){this.closed=false;this.connect();this.stats=setInterval(()=>this.measure(),2000);return;}if(this.ws?.readyState===1){this.reset();this.onState('正在重新协商手机视频');this.send({type:'restart'});}}
 send(message){if(this.ws?.readyState===1)this.ws.send(JSON.stringify(message));}
 async handle(msg,generation=this.generation){
  if(!['phoneScreen','phoneCamera'].includes(msg.source))return;
  if(msg.type==='offer'){
   clearTimeout(this.peers.get(msg.source)?.timeout);this.peers.get(msg.source)?.pc.close();this.onStream(msg.source,null);
   this.onState('已收到手机视频请求，正在协商');
   const pc=new RTCPeerConnection(this.rtcConfig),entry={pc,session:msg.session,lastFrames:0,lastTime:0,stream:null,started:Date.now(),lanCount:0};this.peers.set(msg.source,entry);
   const current=()=>generation===this.generation&&this.peers.get(msg.source)===entry;
   pc.onicecandidate=e=>{if(!current()||!e.candidate)return;const candidates=this.rtcConfig.iceServers?.length?[e.candidate.toJSON()]:lanCandidates(e.candidate.toJSON(),this.getLocalAddresses());entry.lanCount+=candidates.length-1;for(const candidate of candidates)this.send({type:'candidate',source:msg.source,session:msg.session,candidate});};
   pc.ontrack=e=>{if(!current())return;this.tuneReceiver(e.receiver);if(!entry.stream)entry.stream=new MediaStream();if(!entry.stream.getTracks().includes(e.track))entry.stream.addTrack(e.track);this.onStream(msg.source,entry.stream);};
   pc.onconnectionstatechange=()=>{if(!current())return;const state={connected:'视频通道已连接，等待画面',connecting:'视频网络正在连通',disconnected:'视频网络中断，正在恢复',failed:'视频网络连接失败，请检查网络与中继服务'}[pc.connectionState]||'视频协商中';this.onState(state);this.send({type:'status',source:msg.source,message:state});if(pc.connectionState==='failed'){this.onStream(msg.source,null);this.reportNetwork(msg.source,entry);}};
   await pc.setRemoteDescription({type:'offer',sdp:msg.sdp});if(!current())return; const pendingKey=msg.source+':'+msg.session;for(const candidate of this.earlyCandidates.get(pendingKey)||[])await pc.addIceCandidate(candidate);this.earlyCandidates.delete(pendingKey);if(!current())return;
   const answer=await pc.createAnswer();if(!current())return;await pc.setLocalDescription(answer);if(!current())return;
   this.send({type:'answer',source:msg.source,session:msg.session,sdp:pc.localDescription.sdp});
   entry.timeout=setTimeout(()=>{if(current()&&!['connected','closed'].includes(pc.connectionState)){const message='视频协商超时：手机已连接，但视频网络尚未连通；请查看连接诊断';this.onState(message);this.send({type:'status',source:msg.source,message});this.reportNetwork(msg.source,entry);}},15000);entry.timeout.unref?.();
  }else if(msg.type==='candidate'){const entry=this.peers.get(msg.source);if(entry?.session===msg.session)await entry.pc.addIceCandidate(msg.candidate);else {const key=msg.source+':'+msg.session;if(!this.earlyCandidates.has(key)){if(this.earlyCandidates.size>=8)this.earlyCandidates.delete(this.earlyCandidates.keys().next().value);this.earlyCandidates.set(key,[]);}const pending=this.earlyCandidates.get(key);if(pending.length<256)pending.push(msg.candidate);}}
 }
 async reportNetwork(source,entry,stats){try{stats=stats||await entry.pc.getStats();if(this.peers.get(source)!==entry)return;entry.networkReported=true;this.send({type:'status',source,message:('视频网络诊断：'+iceSummary(stats)+'；补充局域网候选 '+entry.lanCount).slice(0,300)});}catch{}}
 async measure(){
  if(this.measuring)return;this.measuring=true;
  const measurements=[],generation=this.generation;
  try{for(const[source,entry]of this.peers){try{
   const stats=await entry.pc.getStats();if(this.peers.get(source)!==entry)continue;
   if(!entry.networkReported&&Date.now()-entry.started>=8000)this.reportNetwork(source,entry,stats);
   for(const row of stats.values())if(row.type==='inbound-rtp'&&(row.kind==='video'||row.mediaType==='video')){
    if(row.framesDecoded>0&&!entry.receivedFrames){entry.receivedFrames=true;this.send({type:'status',source,message:'电脑已解码收到手机画面，视频传输正常'});}
    const measured=videoStats(row,entry.previous,stats);this.onStats(source,measured);if(entry.pc.connectionState==='connected'&&row.framesDecoded>0)measurements.push(measured);entry.previous={...row};
   }
  }catch{}}if(generation===this.generation)this.onStatsBatch(measurements);}finally{this.measuring=false;}
 }
 reset(){this.generation++;this.signaling=Promise.resolve();this.earlyCandidates.clear();for(const[source,entry]of this.peers){clearTimeout(entry.timeout);entry.pc.close();this.onStream(source,null);}this.peers.clear();}
 close(){this.closed=true;this.connectAttempt++;clearInterval(this.stats);clearTimeout(this.retry);this.reset();this.ws?.close();}
}

// Own a source's video lifetime so superseded play() promises cannot update the UI.
export class PhoneMedia {
 constructor({createVideo=()=>document.createElement('video'),onChange,onAudio,onReady,onError,onDetach=()=>{},now=()=>Date.now()}){Object.assign(this,{createVideo,onChange,onAudio,onReady,onError,onDetach,now});this.entry=null;}
 set(stream){
  if(stream&&this.entry?.stream===stream){this.onAudio(stream);return this.entry.playing;}
  const old=this.entry;this.entry=null;
  if(old){this.onDetach(old);old.stream.removeEventListener('addtrack',old.tracksChanged);old.stream.removeEventListener('removetrack',old.tracksChanged);if(old.frameId!==undefined)old.element.cancelVideoFrameCallback?.(old.frameId);old.element.onloadeddata=null;old.element.pause();old.element.srcObject=null;}
  this.onAudio(null);
  if(!stream){this.onChange({element:null,stream:null,last:0});return Promise.resolve();}
  const video=this.createVideo();video.muted=true;video.autoplay=true;video.playsInline=true;
  const entry=this.entry={element:video,stream,last:0};this.onChange(entry);
  const current=()=>this.entry===entry;
  const ready=()=>{if(!current()||video.readyState<2||!stream.getVideoTracks().some(track=>track.readyState==='live'&&!track.muted))return;entry.last=this.now();if(!entry.ready){entry.ready=true;this.onReady();}};
  entry.tracksChanged=()=>{if(current()){this.onAudio(stream);ready();}};
  stream.addEventListener('addtrack',entry.tracksChanged);stream.addEventListener('removetrack',entry.tracksChanged);
  video.onloadeddata=ready;video.srcObject=stream;
  if(video.requestVideoFrameCallback){const frame=()=>{if(!current())return;ready();entry.frameId=video.requestVideoFrameCallback(frame);};entry.frameId=video.requestVideoFrameCallback(frame);}
  this.onAudio(stream);
  entry.playing=(async()=>{try{await video.play();if(current())ready();}catch(error){if(current())this.onError(error);}})();
  return entry.playing;
 }
}
