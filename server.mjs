import http from 'node:http';
import {isIP} from 'node:net';
import https from 'node:https';
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {networkInterfaces} from 'node:os';
import {randomBytes,randomInt,timingSafeEqual,X509Certificate} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import {Recordings} from './lib/recordings.mjs';
import {RemoteBridge} from './lib/remote-bridge.mjs';
const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// Local-only diagnostics retain network endpoints, never raw candidates or ICE credentials.
export function candidateEndpoint(candidate){
 const parts=String(candidate?.candidate||'').trim().split(/\s+/);if(parts.length<8||parts[6]!=='typ')return 'invalid';
 const protocol=['udp','tcp'].includes(parts[2].toLowerCase())?parts[2].toLowerCase():'unknown',type=['host','srflx','prflx','relay'].includes(parts[7])?parts[7]:'unknown';
 const address=isIP(parts[4])?parts[4]:parts[4].endsWith('.local')?'mDNS':'hidden';const port=/^\d{1,5}$/.test(parts[5])&&Number(parts[5])<=65535?parts[5]:'?';
 return protocol+' '+type+' '+address+':'+port;
}
export function createStudioServer({port=4310,tlsPort=4311,recordingDir=resolve('recordings'),deviceFile=null,tls=null,phoneCredential=null,allowRemoteLoopback=false}={}){
 const code=String(randomInt(100000,1000000)),desktopKey=randomBytes(24).toString('hex');let pairKey=randomBytes(24).toString('hex'),pairExpiry=Date.now()+600000;
 let credential=phoneCredential,phone=null,desktop=null,phoneName=credential?.name||'',lastSeen=0;
 let remote=null,remotePhone=null,rtcConfig={iceServers:[],iceTransportPolicy:'all'};
 const remoteState=()=>remote?.snapshot()||{enabled:false,state:'off'};
 const activePhone=()=>remote?remotePhone:phone;
 const attempts=new Map(),events=new Set(),recordings=new Recordings(recordingDir);
 const diagnostics=[];const trace=(role,event,source,detail)=>{diagnostics.push({time:new Date().toISOString(),role,event,...(source?{source}:{}),...(detail?{detail}:{})});if(diagnostics.length>100)diagnostics.shift();};
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const emit=(event,data)=>{for(const res of events){if(res.writableLength>1000000){res.destroy();events.delete(res);}else res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');}};
 const transmit=(target,data)=>{if(target?.readyState===WebSocket.OPEN){if(target.bufferedAmount>1000000)target.close(1008,'Backpressure');else target.send(JSON.stringify(data));}};
 async function body(req,max=65536){const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>max){const error=new Error('请求过大');error.status=413;throw error;}chunks.push(chunk);}return Buffer.concat(chunks);}
 const originAllowed=req=>!req.headers.origin||['http://localhost:'+server.address()?.port,'http://127.0.0.1:'+server.address()?.port].includes(req.headers.origin);
 async function handler(req,res){try{
  const url=new URL(req.url,'http://localhost');if(!originAllowed(req))return send(res,403,{error:'不允许的来源'});
  if(url.pathname==='/health')return send(res,200,{ok:true,version:'0.4.1'});
  if(url.pathname==='/api/pair'&&req.method==='POST'){
   if(remote)return send(res,409,{error:'电脑正在使用跨网模式，请先关闭跨网连接'});
   if(!req.socket.encrypted&&!local(req))return send(res,403,{error:'请扫描电脑二维码，使用加密连接'});
   const ip=req.socket.remoteAddress,now=Date.now();let limit=attempts.get(ip);if(!limit||now-limit.start>60000){limit={start:now,count:0};attempts.set(ip,limit);}if(++limit.count>8)return send(res,429,{error:'请一分钟后再试'});
   const input=JSON.parse((await body(req,4096)).toString());const accepted=local(req)?equal(String(input.code||''),code)||equal(input.secret,pairKey):equal(input.secret,pairKey)&&Date.now()<pairExpiry;
   if(!accepted)return send(res,401,{error:'二维码已失效，请重新扫描'});
   phone?.close(4001,'Replaced');credential={token:randomBytes(32).toString('hex'),name:String(input.name||'Android').slice(0,80)};phoneName=credential.name;
   if(deviceFile)await writeFile(deviceFile,JSON.stringify(credential));pairKey=randomBytes(24).toString('hex');pairExpiry=Date.now()+600000;emit('phone',{name:phoneName,connected:false});return send(res,200,{token:credential.token});
  }
  if(!local(req))return send(res,403,{error:'控制台仅限本机访问'});
  if(url.pathname==='/api/remote'&&req.method==='GET')return send(res,200,remoteState());
  if(url.pathname==='/api/remote'&&req.method==='POST'){
   if(remote)return send(res,409,{error:'请先关闭当前跨网连接'});
   const input=JSON.parse((await body(req,4096)).toString());
   const bridge=new RemoteBridge({url:input.url,accessKey:input.accessKey,allowLoopback:allowRemoteLoopback,desktop:desktop?.readyState===1,
    onSignal:message=>{if(remote!==bridge)return;lastSeen=Date.now();trace('phone',message.type,message.source,message.type==='candidate'?candidateEndpoint(message.candidate):message.type==='status'?message.message:undefined);transmit(desktop,message);},
    onConfig:config=>{if(remote!==bridge)return;rtcConfig=config;transmit(desktop,{type:'rtc-config',config});},
    onPhone:connected=>{
     if(remote!==bridge)return;
     remotePhone=connected?{readyState:1,send:raw=>bridge.send(JSON.parse(raw)),close:()=>bridge.revoke()}:null;
     transmit(desktop,{type:'phone',connected});emit('remote',{});emit('phone',{connected});
    },
    onState:()=>emit('remote',{})});
   remote=bridge;phone?.close(4001,'Remote mode enabled');transmit(desktop,{type:'phone',connected:false});return send(res,202,remoteState());
  }
  if(url.pathname==='/api/remote'&&req.method==='DELETE'){
   const previous=remote;remote=null;remotePhone=null;previous?.close();rtcConfig={iceServers:[],iceTransportPolicy:'all'};
   transmit(desktop,{type:'rtc-config',config:rtcConfig});transmit(desktop,{type:'phone',connected:false});emit('remote',{});return send(res,200,remoteState());
  }
  if(url.pathname==='/api/remote/refresh'&&req.method==='POST'){remote?.refresh();return send(res,200,remoteState());}
  if(url.pathname==='/api/remote/qr'){
   const state=remoteState();if(!state.payload)return send(res,409,{error:'跨网服务尚未就绪'});
   res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(await QRCode.toBuffer(state.payload,{scale:8,margin:4,errorCorrectionLevel:'M'}));return;
  }
  if(url.pathname==='/api/diagnostics'&&req.method==='GET')return send(res,200,{phoneConnected:activePhone()?.readyState===WebSocket.OPEN,remote:remoteState().state,desktopConnected:desktop?.readyState===WebSocket.OPEN,phoneName,events:diagnostics});
  if(url.pathname==='/api/state'){
   if(Date.now()>pairExpiry){pairKey=randomBytes(24).toString('hex');pairExpiry=Date.now()+600000;}
   const entries=Object.entries(networkInterfaces()).flatMap(([name,list])=>(list||[]).filter(x=>x.family==='IPv4'&&!x.internal).map(x=>({name,address:x.address})));
   entries.sort((a,b)=>Number(/virtual|vmware|vbox|wsl|vpn|docker|hyper-v/i.test(a.name))-Number(/virtual|vmware|vbox|wsl|vpn|docker|hyper-v/i.test(b.name)));
   const fingerprint=tls?new X509Certificate(tls.cert).fingerprint256.replaceAll(':','').toLowerCase():null;
   return send(res,200,{code,desktopKey,phoneName,connected:activePhone()?.readyState===1,remote:remoteState(),rtcConfig,desktopConnected:desktop?.readyState===1,lastSeen,recordingDir,addresses:entries.map(x=>'https://'+x.address+':'+(secure?.address()?.port||tlsPort)),pairing:entries.map(x=>({name:x.name,address:x.address,payload:JSON.stringify({app:'flowcast',v:2,url:'https://'+x.address+':'+(secure?.address()?.port||tlsPort),secret:pairKey,fingerprint})}))});
  }
  if(url.pathname==='/api/qr'){
   const host=url.searchParams.get('host');const valid=Object.values(networkInterfaces()).flat().some(x=>x?.family==='IPv4'&&x.address===host);if(!valid||!tls)return send(res,400,{error:'无可用地址'});
   const payload=JSON.stringify({app:'flowcast',v:2,url:'https://'+host+':'+(secure?.address()?.port||tlsPort),secret:pairKey,fingerprint:new X509Certificate(tls.cert).fingerprint256.replaceAll(':','').toLowerCase()});
   res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(await QRCode.toBuffer(payload,{scale:8,margin:4,errorCorrectionLevel:'M'}));return;
  }
  if(url.pathname==='/api/disconnect'&&req.method==='POST'){if(remote){remote.revoke();return send(res,200,{ok:true});}credential=null;phoneName='';phone?.close(4001,'Revoked');if(deviceFile)await writeFile(deviceFile,'null');emit('phone',{name:'',connected:false});return send(res,200,{ok:true});}
  if(url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(': connected\n\n');events.add(res);req.on('close',()=>events.delete(res));return;}
  if(url.pathname==='/api/recordings'&&req.method==='GET')return send(res,200,await recordings.list());
  if(url.pathname==='/api/recordings'&&req.method==='POST')return send(res,201,await recordings.start());
  const recording=/^\/api\/recordings\/([a-f0-9-]{36})\/(chunk|finish|recover|mp4|file)$/.exec(url.pathname);
  if(recording){const[,id,action]=recording;if(action==='chunk'&&req.method==='POST'){const seq=Number(url.searchParams.get('seq'));if(!Number.isSafeInteger(seq)||seq<0)return send(res,400,{error:'无效序号'});return send(res,200,await recordings.append(id,seq,await body(req,16*1024*1024)));}
   if(action==='finish'&&req.method==='POST')return send(res,200,await recordings.finish(id));
   if(action==='recover'&&req.method==='POST')return send(res,200,await recordings.recover(id));
   if(action==='mp4'&&req.method==='POST')return send(res,200,await recordings.mp4(id));
   if(action==='file'&&req.method==='GET'){const ext=url.searchParams.get('format')==='mp4'?'.mp4':'.webm';const path=recordings.path(id,ext),info=await stat(path);const headers={'Content-Type':ext==='.mp4'?'video/mp4':'video/webm','Accept-Ranges':'bytes','Content-Disposition':'inline; filename="FlowCast-'+id+ext+'"'};let start=0,end=info.size-1;const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');if(req.headers.range&&!match){res.writeHead(416);res.end();return;}if(match){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;if(start>end||start>=info.size){res.writeHead(416,{'Content-Range':'bytes */'+info.size});res.end();return;}headers['Content-Range']='bytes '+start+'-'+end+'/'+info.size;}headers['Content-Length']=end-start+1;res.writeHead(match?206:200,headers);const stream=createReadStream(path,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;}
  }
  const assets={'/assets/flowcast.svg':['assets/flowcast.svg','image/svg+xml'],'/assets/favicon.png':['assets/favicon.png','image/png'],'/assets/flowcast-180.png':['assets/flowcast-180.png','image/png'],'/audio.css':['audio.css','text/css; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/rtc.js':['rtc.js','text/javascript; charset=utf-8'],'/audio.js':['audio.js','text/javascript; charset=utf-8'],'/experience.js':['experience.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
  if(req.method==='GET'&&assets[url.pathname]){const[name,type]=assets[url.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-ancestors 'none'",'Permissions-Policy':'camera=(self), microphone=(self), display-capture=(self)'});res.end(await readFile(new URL('./public/'+name,import.meta.url)));return;}
  send(res,404,{error:'未找到'});
 }catch(error){if(!res.headersSent)send(res,error.status||400,{error:error.message});else res.end();}}
 const server=http.createServer(handler);const secure=tls?https.createServer(tls,handler):null;const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
 function upgrade(req,socket,head){const url=new URL(req.url,'http://localhost');const role=url.pathname==='/signal/desktop'?'desktop':url.pathname==='/signal/phone'?'phone':null;
  const authorized=role==='desktop'?local(req)&&originAllowed(req)&&equal(url.searchParams.get('key'),desktopKey):role==='phone'&&!remote&&(req.socket.encrypted||local(req))&&credential&&equal(req.headers['x-phone-token']||url.searchParams.get('token'),credential.token);
  if(!authorized){trace(role||'unknown','unauthorized');socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>{ws.role=role;ws.alive=true;trace(role,'connected',null,role==='phone'?'手机信令地址 '+req.socket.remoteAddress:undefined);if(role==='desktop'){desktop?.close(4002,'Other studio opened');desktop=ws;transmit(ws,{type:'rtc-config',config:rtcConfig});transmit(ws,{type:'phone',connected:activePhone()?.readyState===WebSocket.OPEN});if(remote)remote.setDesktop(true);else transmit(phone,{type:'restart'});}else{phone?.close(4002,'Reconnected');phone=ws;lastSeen=Date.now();emit('phone',{name:phoneName,connected:true});transmit(desktop,{type:'phone',connected:true});transmit(ws,{type:'ready',desktop:!!desktop});}
   ws.on('pong',()=>ws.alive=true);let count=0;const reset=setInterval(()=>count=0,1000);reset.unref();ws.on('message',data=>{if(ws!==(role==='phone'?phone:desktop)||role==='phone'&&!credential)return;if(++count>150){trace(role,'rate-limit');ws.close(1008,'Rate limit');return;}try{const message=JSON.parse(data);if(!['offer','answer','candidate','restart','status','quality'].includes(message.type))return;if(message.type==='quality'&&(role!=='desktop'||!['smooth','balanced','detail'].includes(message.profile)))return;if(['offer','answer','candidate'].includes(message.type)&&(!['phoneScreen','phoneCamera'].includes(message.source)||typeof message.session!=='string'||message.session.length>80))return;if(message.type==='status'){if(typeof message.message!=='string'||message.message.length>300)return;trace(role,'status',message.source,message.message);}else trace(role,message.type,message.source,message.type==='candidate'?candidateEndpoint(message.candidate):undefined);if(role==='phone')lastSeen=Date.now();transmit(role==='phone'?desktop:activePhone(),message);}catch{ws.close(1008,'Invalid JSON');}});ws.on('close',(code)=>{trace(role,'disconnected',null,String(code));clearInterval(reset);if(ws===phone){phone=null;emit('phone',{name:phoneName,connected:false});transmit(desktop,{type:'phone',connected:false});}if(ws===desktop){desktop=null;if(remote)remote.setDesktop(false);else transmit(phone,{type:'studio-away'});}});ws.on('error',()=>{});
  });
 }
 server.on('upgrade',upgrade);secure?.on('upgrade',upgrade);const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}for(const res of events)res.write(': heartbeat\n\n');for(const [key,value]of attempts)if(Date.now()-value.start>60000)attempts.delete(key);},15000);heartbeat.unref();
 server.on('close',()=>clearInterval(heartbeat));server.recordings=recordings;server.secure=secure;server.shutdown=async()=>{const bridge=remote;remote=null;bridge?.close();clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();for(const res of events)res.destroy();await recordings.close();for(const service of [secure,server])if(service?.listening){service.closeAllConnections();await new Promise(resolve=>service.close(resolve));}};return server;
}
async function listenAvailable(service,port,host,autoPort){
 const listen=value=>new Promise((resolve,reject)=>{const failed=error=>{service.off('listening',ready);reject(error);};const ready=()=>{service.off('error',failed);resolve();};service.once('error',failed);service.once('listening',ready);service.listen(value,host);});
 try{await listen(port);}catch(error){if(!autoPort||error.code!=='EADDRINUSE'||port===0)throw error;await listen(0);}
}
export async function startStudio({port=4310,tlsPort=4311,autoPort=true,dataDir=resolve('.flowcast'),recordingDir=resolve('recordings'),allowRemoteLoopback=false}={}){
 await mkdir(dataDir,{recursive:true});let tls;try{tls=JSON.parse(await readFile(join(dataDir,'tls.json'),'utf8'));}catch{const pems=await selfsigned.generate([{name:'commonName',value:'FlowCast local studio'}],{keySize:2048,algorithm:'sha256',notAfterDate:new Date(Date.now()+5*365*86400000)});tls={key:pems.private,cert:pems.cert};await writeFile(join(dataDir,'tls.json'),JSON.stringify(tls));}
 const deviceFile=join(dataDir,'device.json');let phoneCredential;try{phoneCredential=JSON.parse(await readFile(deviceFile,'utf8'));}catch{}
 const server=createStudioServer({port,tlsPort,tls,recordingDir,deviceFile,phoneCredential,allowRemoteLoopback});await server.recordings.init();
 try{await listenAvailable(server,port,'127.0.0.1',autoPort);await listenAvailable(server.secure,tlsPort,'0.0.0.0',autoPort);}catch(error){await server.shutdown();throw error;}return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 try{
  const port=Number(process.env.PORT||4310),tlsPort=Number(process.env.TLS_PORT||4311);
  const server=await startStudio({port,tlsPort});
  if(port&&server.address().port!==port)console.log('工作台端口 '+port+' 已被占用，已自动切换。');
  if(tlsPort&&server.secure.address().port!==tlsPort)console.log('手机连接端口 '+tlsPort+' 已被占用，二维码已更新为可用端口。');
  console.log('FlowCast: http://localhost:'+server.address().port);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await server.shutdown();process.exit(0);});
 }catch(error){console.error('FlowCast 启动失败：'+error.message);process.exitCode=1;}
}
