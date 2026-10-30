export const QUALITY_PRESETS=Object.freeze({
 smooth:{label:'流畅优先',width:1280,height:720,fps:30,bitrate:4_000_000,description:'720p · 较低录制码率，适合操作演示'},
 balanced:{label:'均衡',width:1280,height:720,fps:30,bitrate:6_000_000,description:'720p · 兼顾细节与流畅，适合日常录制'},
 detail:{label:'清晰优先',width:1920,height:1080,fps:30,bitrate:10_000_000,description:'1080p · 提高文字与画面细节，需要更好的设备性能'}
});
// Pace composition independently of the display's refresh rate.
export class FramePacer {
 constructor(){this.next=null;this.rate=null;}
 due(now,fps=30){const interval=1000/fps;if(this.next===null||this.rate!==fps||now<this.next-interval*2){this.rate=fps;this.next=now;}if(now+0.5<this.next)return false;this.next=now+interval-((now-this.next)%interval);return true;}
 reset(){this.next=null;}
}
// Queue unavailable sources while the current program keeps playing.
export class SourceSwitch {
 constructor(initial){this.current=initial;this.pending=null;}
 select(key,ready){if(ready(key)){const changed=this.current!==key;this.current=key;this.pending=null;return changed;}this.pending=key===this.current?null:key;return false;}
 cancel(){this.pending=null;}
 commit(ready){if(this.pending&&ready(this.pending)){this.current=this.pending;this.pending=null;return true;}return false;}
}

 
// Separate transport adaptation from the fixed dimensions of an active recording.
export class AdaptiveQuality {
 constructor(ceiling='balanced',enabled=true){this.configure(ceiling,enabled);}
 configure(ceiling,enabled=this.enabled){
  if(!Object.hasOwn(QUALITY_PRESETS,ceiling))return;
  this.ceiling=ceiling;this.enabled=enabled;this.current=ceiling;
  this.lastChange=-Infinity;this.reset();
 }
 reset(){this.badSince=null;this.goodSince=null;this.lastSample=null;}
 sample(rows,now){
  if(!this.enabled)return null;
  if(this.lastSample!==null&&(now-this.lastSample>6000||now<=this.lastSample))this.reset();
  this.lastSample=now;
  const active=rows.filter(row=>row.active);
  // Missing samples and static screens are not evidence of congestion or recovery.
  if(!active.length){this.badSince=null;this.goodSince=null;return null;}
  const bad=active.some(row=>(row.lossPercent??0)>5||(row.bufferMs??0)>180||(row.rtt??0)>180||(row.jitter??0)>60);
  const good=active.every(row=>Number.isFinite(row.lossPercent)&&row.lossPercent<=1&&(row.bufferMs??Infinity)<=90&&(row.rtt??Infinity)<=100&&(row.jitter??Infinity)<=30);
  this.badSince=bad?(this.badSince??now):null;this.goodSince=good?(this.goodSince??now):null;
  const levels=['smooth','balanced','detail'],index=levels.indexOf(this.current);
  let next=index;
  if(now-this.lastChange>=12000){
   if(this.badSince!==null&&now-this.badSince>=2000)next=Math.max(0,index-1);
   else if(this.goodSince!==null&&now-this.goodSince>=20000)next=Math.min(levels.indexOf(this.ceiling),index+1);
  }
  if(next===index)return null;
  this.current=levels[next];this.lastChange=now;this.badSince=null;this.goodSince=null;
  return this.current;
 }
}
