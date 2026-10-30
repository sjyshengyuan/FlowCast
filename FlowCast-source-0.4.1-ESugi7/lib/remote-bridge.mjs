import {WebSocket} from 'ws';
import {capability,remoteOrigin,validSignal} from './remote-protocol.mjs';

export class RemoteBridge {
 constructor({url,accessKey,allowLoopback=false,onSignal=()=>{},onPhone=()=>{},onConfig=()=>{},onState=()=>{},desktop=false}){
  this.url=remoteOrigin(url,{allowLoopback});if(typeof accessKey!=='string'||accessKey.length<32)throw Error('服务接入密钥至少 32 字符');
  Object.assign(this,{accessKey,onSignal,onPhone,onConfig,onState,desktop});this.room=capability();this.owner=capability();this.closed=false;this.attempt=0;this.state='connecting';this.connected=false;this.connect();
 }
 snapshot(){return {enabled:!this.closed,state:this.state,url:this.url,connected:this.connected,
  hasTurn:!!this.config?.iceServers?.some(server=>[].concat(server.urls).some(url=>/^turns?:/.test(url))),
  ...(this.secret&&this.state==='ready'?{payload:JSON.stringify({app:'flowcast',v:3,mode:'remote',url:this.url,room:this.room,secret:this.secret}),pairExpires:this.pairExpires}:{})};}
 changed(){this.onState(this.snapshot());}
 connect(){
  if(this.closed)return;clearTimeout(this.retry);this.state='connecting';this.changed();
  const url=new URL('/signal/studio',this.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const ws=this.ws=new WebSocket(url,{headers:{Authorization:'Bearer '+this.accessKey},maxPayload:128*1024,handshakeTimeout:10000});
  const current=()=>!this.closed&&this.ws===ws;
  let watchdog;
  ws.on('open',()=>{if(current()){ws.send(JSON.stringify({type:'register',room:this.room,owner:this.owner,desktop:this.desktop}));watchdog=setTimeout(()=>{if(current()&&this.state!=='ready')ws.terminate();},12000);watchdog.unref?.();}});
  ws.on('message',raw=>{
   if(!current())return;let message;try{message=JSON.parse(raw);}catch{return;}if(!message||typeof message!=='object'||Array.isArray(message))return;
   if(message.type==='registered'){
    clearTimeout(watchdog);this.state='ready';this.attempt=0;this.secret=message.secret;this.pairExpires=message.pairExpires;this.config=message.config;this.onConfig(this.config);this.changed();return;
   }
   if(message.type==='rtc-config'){this.config=message.config;this.onConfig(this.config);return;}
   if(message.type==='phone'){this.connected=message.connected===true;this.onPhone(this.connected);this.changed();return;}
   if(validSignal(message,'phone'))this.onSignal(message);
  });
  ws.on('unexpected-response',(_,response)=>{response.resume();this.fatal=response.statusCode===401||response.statusCode===403;ws.terminate();});
  ws.on('error',()=>{});
  ws.on('close',code=>{
   clearTimeout(watchdog);if(!current())return;this.connected=false;this.onPhone(false);
   if(this.fatal||code===4001||code===4002||code===1008){this.state='error';this.changed();return;}
   this.state='reconnecting';this.changed();this.retry=setTimeout(()=>this.connect(),Math.min(10000,1000*2**Math.min(this.attempt++,3)));this.retry.unref?.();
  });
 }
 send(message){if(this.ws?.readyState===1&&this.state==='ready'&&this.ws.bufferedAmount<1024*1024)this.ws.send(JSON.stringify(message));}
 setDesktop(value){this.desktop=value;this.send({type:'desktop-state',connected:value});}
 refresh(){this.send({type:'refresh-pair'});}
 revoke(){this.send({type:'revoke'});}
 close(){this.send({type:'close-room'});this.closed=true;clearTimeout(this.retry);this.ws?.close();this.connected=false;this.state='off';this.onPhone(false);this.changed();}
}
