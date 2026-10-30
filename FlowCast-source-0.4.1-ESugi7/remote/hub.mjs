import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {WebSocketServer,WebSocket} from 'ws';
import {capability,equalToken,remoteOrigin,validSignal,iceConfiguration} from '../lib/remote-protocol.mjs';

// Signaling only: this process never serves the recording workstation or its files.
export function createRemoteHub({accessKey,publicUrl,ice={},allowLoopback=false,maxRooms=100,now=()=>Date.now(),pairTtl=600000,roomGrace=300000}={}){
 if(typeof accessKey!=='string'||accessKey.length<32)throw Error('FLOWCAST_REMOTE_ACCESS_KEY 至少 32 字符');
 publicUrl=remoteOrigin(publicUrl,{allowLoopback});
 iceConfiguration(ice);
 const rooms=new Map(),attempts=new Map(),sockets=new WebSocketServer({noServer:true,maxPayload:128*1024});
 const send=(ws,message)=>{if(ws?.readyState===WebSocket.OPEN){if(ws.bufferedAmount>1024*1024)ws.close(1008,'Backpressure');else ws.send(JSON.stringify(message));}};
 const config=room=>{
  if(!room.config||room.config.expiresAt-now()<((ice.ttl||21600)*500))room.config=iceConfiguration(ice,room.id,now());
  return room.config;
 };
 function expire(room){room.secret=capability();room.pairExpires=now()+pairTtl;}
 function notifyPhone(room){send(room.studio,{type:'phone',connected:room.phone?.readyState===1});}
 function rtc(room){const value={type:'rtc-config',config:config(room)};send(room.studio,value);send(room.phone,value);}
 function registered(room){send(room.studio,{type:'registered',room:room.id,secret:room.secret,pairExpires:room.pairExpires,publicUrl,config:config(room)});}
 function remove(room){if(rooms.get(room.id)!==room)return;rooms.delete(room.id);room.studio?.close(4001,'Room closed');room.phone?.close(4001,'Pairing revoked');}
 async function body(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>4096)throw Error('请求过大');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString());}
 function limited(req){
  // Socket address is authoritative; spoofable forwarded headers are intentionally ignored.
  const key=req.socket.remoteAddress;let state=attempts.get(key);
  if(!state||now()-state.time>60000){if(attempts.size>=10000)return true;state={time:now(),count:0};attempts.set(key,state);}
  return ++state.count>20;
 }
 const server=http.createServer(async(req,res)=>{
  const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  try{
   if(req.url==='/health'&&req.method==='GET')return reply(200,{ok:true,service:'flowcast-remote',version:'0.4.1'});
   if(req.url!=='/api/remote/pair'||req.method!=='POST')return reply(404,{error:'未找到'});
   if(limited(req))return reply(429,{error:'尝试过多，请稍后再试'});
   const input=await body(req),room=rooms.get(input.room);
   if(!room||!room.studio||room.pairExpires<=now()||!equalToken(input.secret,room.secret))return reply(401,{error:'远程配对码已失效，请在电脑刷新'});
   const token=capability();room.phone?.close(4001,'Pairing replaced');room.phone=null;room.phoneToken=token;expire(room);registered(room);notifyPhone(room);
   return reply(200,{token});
  }catch{return reply(400,{error:'无效请求'});}
 });
 server.on('upgrade',(req,socket,head)=>{
  const reject=code=>{socket.write('HTTP/1.1 '+code+' Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();};
  if(req.headers.origin)return reject(403); // This endpoint is used by native clients / the local Node bridge.
  let role,room;
  if(req.url==='/signal/studio'&&equalToken(req.headers.authorization,'Bearer '+accessKey))role='desktop';
  else if(req.url==='/signal/phone'){
   room=rooms.get(req.headers['x-flowcast-room']);
   if(room&&equalToken(req.headers['x-phone-token'],room.phoneToken))role='phone';
  }
  if(!role||limited(req))return reject(401);
  sockets.handleUpgrade(req,socket,head,ws=>{
   ws.alive=true;ws.on('pong',()=>ws.alive=true);ws.on('error',()=>{});
   let current=room,count=0,windowStart=now(),registeredSocket=role==='phone';
   const timeout=setTimeout(()=>{if(!registeredSocket)ws.close(1008,'Registration required');},5000);timeout.unref();
   ws.on('message',raw=>{
    if(now()-windowStart>=1000){count=0;windowStart=now();}if(++count>150){ws.close(1008,'Rate limit');return;}
    let message;try{message=JSON.parse(raw);}catch{ws.close(1008,'Invalid JSON');return;}
    if(!message||typeof message!=='object'||Array.isArray(message)){ws.close(1008,'Invalid message');return;}
    if(role==='desktop'&&!registeredSocket){
     if(message.type!=='register'||!/^[a-f0-9]{48}$/.test(message.room)||!/^[a-f0-9]{48}$/.test(message.owner)){ws.close(1008,'Invalid registration');return;}
     current=rooms.get(message.room);
     if(current&&!equalToken(current.owner,message.owner)){ws.close(4001,'Invalid owner');return;}
     if(!current){if(rooms.size>=maxRooms){ws.close(1013,'Capacity');return;}current={id:message.room,owner:message.owner};expire(current);rooms.set(current.id,current);}
     const previous=current.studio;current.studio=ws;current.awaySince=null;current.desktop=message.desktop===true;previous?.close(4002,'Replaced');
     registeredSocket=true;clearTimeout(timeout);registered(current);notifyPhone(current);rtc(current);
     send(current.phone,current.desktop?{type:'restart'}:{type:'studio-away'});return;
    }
    if(!current||rooms.get(current.id)!==current||ws!==(role==='desktop'?current.studio:current.phone))return;
    if(role==='desktop'){
     if(message.type==='refresh-pair'){expire(current);registered(current);return;}
     if(message.type==='revoke'){current.phoneToken=null;const old=current.phone;current.phone=null;old?.close(4001,'Revoked');expire(current);registered(current);notifyPhone(current);return;}
     if(message.type==='close-room'){remove(current);return;}
     if(message.type==='desktop-state'){const was=current.desktop;current.desktop=message.connected===true;if(was!==current.desktop)send(current.phone,current.desktop?{type:'restart'}:{type:'studio-away'});return;}
    }
    if(!validSignal(message,role))return;
    if(role==='phone'&&!current.desktop)return;
    send(role==='desktop'?current.phone:current.studio,message);
   });
   ws.on('close',()=>{
    clearTimeout(timeout);if(!current||rooms.get(current.id)!==current)return;
    if(ws===current.studio){current.studio=null;current.desktop=false;current.awaySince=now();send(current.phone,{type:'studio-away'});}
    if(ws===current.phone){current.phone=null;notifyPhone(current);}
   });
   if(role==='phone'){
    const old=current.phone;current.phone=ws;old?.close(4002,'Reconnected');notifyPhone(current);rtc(current);
    send(ws,{type:'ready',desktop:!!current.studio&&current.desktop,config:config(current)});
   }
  });
 });
 const heartbeat=setInterval(()=>{
  for(const ws of sockets.clients){if(!ws.alive)ws.terminate();else{ws.alive=false;ws.ping();}}
  for(const room of rooms.values()){if(!room.studio&&now()-room.awaySince>=roomGrace)remove(room);else if(room.studio){if(room.pairExpires<=now()){expire(room);registered(room);}rtc(room);}}
  for(const [key,state]of attempts)if(now()-state.time>60000)attempts.delete(key);
 },15000);heartbeat.unref();
 server.shutdown=async()=>{clearInterval(heartbeat);for(const ws of sockets.clients)ws.terminate();rooms.clear();sockets.close();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));};
 return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 try{
  const split=value=>(value||'').split(',').map(value=>value.trim()).filter(Boolean);
  const server=createRemoteHub({accessKey:process.env.FLOWCAST_REMOTE_ACCESS_KEY,publicUrl:process.env.FLOWCAST_REMOTE_PUBLIC_URL,
   ice:{stunUrls:split(process.env.FLOWCAST_STUN_URLS),turnUrls:split(process.env.FLOWCAST_TURN_URLS),turnSecret:process.env.FLOWCAST_TURN_SECRET||'',relayOnly:process.env.FLOWCAST_RELAY_ONLY==='1'}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.PORT||8080),'0.0.0.0',resolve);});
  console.log('FlowCast remote signaling ready on port '+server.address().port);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await server.shutdown();process.exit(0);});
 }catch(error){console.error(error.message);process.exitCode=1;}
}
