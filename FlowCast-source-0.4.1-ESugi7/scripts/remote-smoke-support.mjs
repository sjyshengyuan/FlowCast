// Test-only adapter: browser synthetic phone -> native authenticated hub socket.
import http from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {createRemoteHub} from '../remote/hub.mjs';
import {capability} from '../lib/remote-protocol.mjs';
export async function remoteSmoke(base){
 const key=capability(),ice={
  stunUrls:(process.env.FLOWCAST_TEST_STUN_URLS||'').split(',').filter(Boolean),
  turnUrls:(process.env.FLOWCAST_TEST_TURN_URLS||'').split(',').filter(Boolean),
  turnSecret:process.env.FLOWCAST_TEST_TURN_SECRET||'',
  relayOnly:process.env.FLOWCAST_TEST_RELAY_ONLY==='1'
 };
 const hub=createRemoteHub({accessKey:key,publicUrl:'http://127.0.0.1',allowLoopback:true,ice});
 await new Promise(resolve=>hub.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+hub.address().port;
 const proxy=http.createServer((req,res)=>{res.writeHead(404);res.end();}),wss=new WebSocketServer({noServer:true,maxPayload:128*1024}),upstreams=new Set();
 proxy.on('upgrade',(req,socket,head)=>{
  if(req.headers.origin!==base||req.url!=='/phone'){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,async browser=>{
   browser.on('error',()=>{});let native;
   browser.on('close',()=>native?.terminate());
   try{
    const state=await(await fetch(base+'/api/remote')).json(),payload=JSON.parse(state.payload);
    const response=await fetch(url+'/api/remote/pair',{method:'POST',body:JSON.stringify(payload)});
    if(!response.ok)throw Error('Remote test pairing failed: '+response.status);
    const {token}=await response.json();if(browser.readyState!==1)return;
    native=new WebSocket(url.replace('http:','ws:')+'/signal/phone',{headers:{'X-FlowCast-Room':payload.room,'X-Phone-Token':token}});
    upstreams.add(native);native.on('error',()=>browser.close(1011,'Test upstream error'));
    native.on('close',()=>{upstreams.delete(native);browser.close();});
    native.on('message',raw=>{if(browser.readyState===1)browser.send(raw.toString());});
    browser.on('message',raw=>{if(native.readyState===1)native.send(raw.toString());});
   }catch{browser.close(1011,'Test pairing failed');}
  });
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 return {key,url,phoneUrl:'ws://127.0.0.1:'+proxy.address().port+'/phone',relayOnly:ice.relayOnly,
  async close(){for(const ws of upstreams)ws.terminate();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(resolve=>proxy.close(resolve));await hub.shutdown();}};
}
