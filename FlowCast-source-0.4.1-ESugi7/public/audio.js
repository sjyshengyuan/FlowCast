// Recording and phone monitoring have separate gain paths; monitoring never includes the PC microphone.
export class AudioMixer {
 constructor({createContext=()=>new AudioContext(),createStream=tracks=>new MediaStream(tracks)}={}){
  Object.assign(this,{createContext,createStream});this.nodes=new Map();this.monitoring=false;this.muted=false;
 }
 ensure(){
  if(!this.context){
   const context=this.context=this.createContext();
   this.destination=context.createMediaStreamDestination();
   this.recordGain=context.createGain();this.recordGain.gain.value=this.muted?0:1;this.recordGain.connect(this.destination);
   this.monitorGain=context.createGain();this.monitorGain.gain.value=this.monitoring?0.7:0;this.monitorGain.connect(context.destination);
  }
  return this.context;
 }
 async resume(){
  const context=this.ensure();let timer;
  try{
   await Promise.race([context.resume(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('浏览器尚未允许声音，请再次点击启用声音检测')),3000))]);
   if(context.state!=='running')throw Error('浏览器声音已暂停，请再次点击启用声音检测');
  }finally{clearTimeout(timer);}
 }
 attach(key,stream){
  const tracks=stream?.getAudioTracks().filter(track=>track.readyState==='live')||[],old=this.nodes.get(key);
  if(old&&old.tracks.length===tracks.length&&old.tracks.every((track,index)=>track===tracks[index]))return;
  if(old){old.node.disconnect();old.analyser.disconnect();for(const track of old.tracks)track.removeEventListener('ended',old.ended);this.nodes.delete(key);}
  if(!tracks.length)return;
  const context=this.ensure(),node=context.createMediaStreamSource(this.createStream(tracks)),analyser=context.createAnalyser();
  analyser.fftSize=1024;node.connect(analyser);analyser.connect(this.recordGain);
  if(key==='phoneScreen'||key==='phoneCamera')analyser.connect(this.monitorGain);
  const ended=()=>{if(this.nodes.get(key)?.node===node)this.attach(key,stream);};
  for(const track of tracks)track.addEventListener('ended',ended);
  this.nodes.set(key,{node,analyser,tracks,ended,samples:new Float32Array(analyser.fftSize)});
 }
 setMuted(value){this.muted=!!value;if(this.recordGain)this.recordGain.gain.value=this.muted?0:1;}
 setMonitoring(value){this.monitoring=!!value;if(this.monitorGain)this.monitorGain.gain.value=this.monitoring?0.7:0;}
 measurePhone(){
  const rows=[...this.nodes].filter(([key])=>key==='phoneScreen'||key==='phoneCamera').map(([,entry])=>entry);
  const tracks=rows.flatMap(entry=>entry.tracks).filter(track=>track.readyState==='live');
  let rms=0;
  if(this.context?.state==='running')for(const entry of rows){entry.analyser.getFloatTimeDomainData(entry.samples);let power=0;for(const sample of entry.samples)power+=sample*sample;rms=Math.max(rms,Math.sqrt(power/entry.samples.length));}
  const db=rms>0?20*Math.log10(rms):-Infinity;
  return {tracks:tracks.length,paused:tracks.length>0&&tracks.every(track=>track.muted||!track.enabled),running:this.context?.state==='running',db:Number.isFinite(db)?Math.round(db):null,level:Number.isFinite(db)?Math.max(0,Math.min(100,(db+60)/60*100)):0,audible:db>-55};
 }
}
