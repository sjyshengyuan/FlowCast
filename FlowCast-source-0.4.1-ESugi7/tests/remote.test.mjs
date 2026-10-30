import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {WebSocket} from 'ws';
import {createRemoteHub} from '../remote/hub.mjs';
import {capability,remoteOrigin,iceConfiguration,validSignal} from '../lib/remote-protocol.mjs';
import {startStudio} from '../server.mjs';

const key='test-access-key-'.padEnd(48,'a');
async function eventually(fn){for(let i=0;i<150;i++){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Condition timed out');}
async function setup(t,options={}){
 let time=Date.now();const server=createRemoteHub({accessKey:key,publicUrl:'http://127.0.0.1',allowLoopback:true,now:()=>time,...options});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.shutdown());
 return {server,base:'http://127.0.0.1:'+server.address().port,advance:ms=>time+=ms};
}
function inbox(ws){
 const rows=[];ws.on('message',raw=>rows.push(JSON.parse(raw)));
 return {rows,wait:type=>eventually(()=>{const i=rows.findIndex(row=>row.type===type);return i<0?null:rows.splice(i,1)[0];})};
}
async function studio(t,base,identity={}){
 const ws=new WebSocket(base.replace('http:','ws:')+'/signal/studio',{headers:{Authorization:'Bearer '+key}}),messages=inbox(ws);
 t.after(()=>ws.terminate());await once(ws,'open');ws.send(JSON.stringify({type:'register',room:identity.room||capability(),owner:identity.owner||capability(),desktop:true}));
 return {ws,messages,registration:await messages.wait('registered')};
}
async function pair(base,payload){return fetch(base+'/api/remote/pair',{method:'POST',body:JSON.stringify(payload)});}
async function phone(t,base,room,token){
 const ws=new WebSocket(base.replace('http:','ws:')+'/signal/phone',{headers:{'X-FlowCast-Room':room,'X-Phone-Token':token}}),messages=inbox(ws);
 t.after(()=>ws.terminate());await once(ws,'open');return {ws,messages};
}
async function rejected(url,headers={}){
 const ws=new WebSocket(url,{headers});ws.on('error',()=>{});
 return new Promise((resolve,reject)=>{ws.on('open',()=>{ws.terminate();reject(Error('Unexpected authorization'));});ws.on('unexpected-response',(_,response)=>{response.resume();ws.terminate();resolve(response.statusCode);});});
}
test('malformed JSON values cannot crash the hub or hijack a registered room',async t=>{
 const s=await setup(t),a=await studio(t,s.base);
 const bad=new WebSocket(s.base.replace('http:','ws:')+'/signal/studio',{headers:{Authorization:'Bearer '+key}});
 t.after(()=>bad.terminate());await once(bad,'open');
 const closed=once(bad,'close');bad.send('null');assert.equal((await closed)[0],1008);
 const intruder=new WebSocket(s.base.replace('http:','ws:')+'/signal/studio',{headers:{Authorization:'Bearer '+key}});
 t.after(()=>intruder.terminate());await once(intruder,'open');const denied=once(intruder,'close');
 intruder.send(JSON.stringify({type:'register',room:a.registration.room,owner:capability(),desktop:true}));
 assert.equal((await denied)[0],4001);assert.equal((await pair(s.base,a.registration)).status,200);
});

test('refresh retains paired phone but invalidates the old QR and isolates other rooms',async t=>{
 const s=await setup(t),a=await studio(t,s.base),b=await studio(t,s.base);
 const token=(await(await pair(s.base,a.registration)).json()).token,p=await phone(t,s.base,a.registration.room,token);
 await p.messages.wait('ready');const before=await a.messages.wait('registered');
 a.ws.send(JSON.stringify({type:'refresh-pair'}));const after=await a.messages.wait('registered');
 assert.notEqual(before.secret,after.secret);assert.equal((await pair(s.base,before)).status,401);
 assert.equal(await rejected(s.base.replace('http:','ws:')+'/signal/phone',{'X-FlowCast-Room':b.registration.room,'X-Phone-Token':token}),401);
 const offer={type:'offer',source:'phoneScreen',session:'isolated',sdp:'retained-phone'};
 p.ws.send(JSON.stringify(offer));assert.deepEqual(await a.messages.wait('offer'),offer);
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(b.messages.rows.some(row=>row.type==='offer'),false);
});

test('TURN credentials remain stable and refresh before expiry on room reconnect',async t=>{
 const s=await setup(t,{ice:{turnUrls:['turn:turn.example.com:3478'],turnSecret:'t'.repeat(48)}});
 const identity={room:capability(),owner:capability()},a=await studio(t,s.base,identity);
 a.ws.send(JSON.stringify({type:'refresh-pair'}));const refreshed=await a.messages.wait('registered');
 assert.deepEqual(refreshed.config,a.registration.config);
 s.advance(10800001);a.ws.close();await once(a.ws,'close');const b=await studio(t,s.base,identity);
 assert.notEqual(b.registration.config.iceServers[0].username,a.registration.config.iceServers[0].username);
 assert.ok(b.registration.config.expiresAt>a.registration.config.expiresAt);
});

test('bridge stops retrying rejected credentials without exposing the key',async t=>{
 const s=await setup(t);let bridge;const {RemoteBridge}=await import('../lib/remote-bridge.mjs');
 bridge=new RemoteBridge({url:s.base,accessKey:'wrong'.repeat(12),allowLoopback:true});
 t.after(()=>bridge.close());await eventually(()=>bridge.state==='error');
 assert.equal(bridge.snapshot().connected,false);assert.ok(!JSON.stringify(bridge.snapshot()).includes('wrong'));
});

test('remote URLs require HTTPS except explicit loopback tests',()=>{
 assert.equal(remoteOrigin('https://connect.example.com/'),'https://connect.example.com');
 for(const url of ['http://example.com','https://user:secret@example.com','https://example.com/path','https://example.com/?token=x'])assert.throws(()=>remoteOrigin(url));
 assert.throws(()=>remoteOrigin('http://127.0.0.1'));assert.equal(remoteOrigin('http://127.0.0.1:8080',{allowLoopback:true}),'http://127.0.0.1:8080');
});
test('TURN credentials are time-limited HMAC credentials and relay policy requires TURN',()=>{
 const secret='t'.repeat(48),now=1700000000000,config=iceConfiguration({stunUrls:['stun:stun.example.com:3478'],turnUrls:['turn:turn.example.com:3478?transport=udp','turns:turn.example.com:5349?transport=tcp'],turnSecret:secret,relayOnly:true},'room',now);
 assert.equal(config.iceTransportPolicy,'relay');assert.equal(config.expiresAt,now+21600000);
 const turn=config.iceServers[1];assert.equal(turn.username,'1700021600:room');assert.equal(turn.credential,createHmac('sha1',secret).update(turn.username).digest('base64'));
 assert.ok(!JSON.stringify(config).includes(secret));
 assert.throws(()=>iceConfiguration({relayOnly:true}));assert.throws(()=>iceConfiguration({turnUrls:['turn:example.com'],turnSecret:'weak'}));assert.throws(()=>iceConfiguration({stunUrls:['https://example.com']}));
});
test('signaling enforces roles, known sources and bounded payloads',()=>{
 assert.equal(validSignal({type:'restart'},'phone'),false);assert.equal(validSignal({type:'quality',profile:'detail'},'phone'),false);
 assert.equal(validSignal({type:'offer',source:'phoneScreen',session:'s',sdp:'x'},'phone'),true);
 assert.equal(validSignal({type:'offer',source:'phoneScreen',session:'s',sdp:'x'},'desktop'),false);
 assert.equal(validSignal({type:'offer',source:'filesystem',session:'s',sdp:'x'},'phone'),false);
 assert.equal(validSignal({type:'status',message:'x'.repeat(301)},'phone'),false);
});
test('hub exposes neither workstation nor files and rejects unauthorized sockets',async t=>{
 const s=await setup(t);
 assert.equal((await fetch(s.base+'/api/recordings')).status,404);assert.equal((await fetch(s.base+'/api/state')).status,404);
 assert.equal(await rejected(s.base.replace('http:','ws:')+'/signal/studio'),401);
 assert.equal(await rejected(s.base.replace('http:','ws:')+'/signal/phone',{'X-Phone-Token':'wrong'}),401);
 assert.equal(await rejected(s.base.replace('http:','ws:')+'/signal/studio',{Authorization:'Bearer '+key,Origin:'https://untrusted.example'}),403);
});
test('pairing is expiring, single use and room scoped',async t=>{
 const s=await setup(t),a=await studio(t,s.base),b=await studio(t,s.base);
 assert.equal((await pair(s.base,{room:b.registration.room,secret:a.registration.secret})).status,401);
 const response=await pair(s.base,a.registration);assert.equal(response.status,200);
 assert.equal((await pair(s.base,a.registration)).status,401);s.advance(600001);
 assert.equal((await pair(s.base,b.registration)).status,401);
});
test('phone and studio relay media negotiation, reconnect and revoke access',async t=>{
 const s=await setup(t),a=await studio(t,s.base),response=await pair(s.base,a.registration),{token}=await response.json();
 const p=await phone(t,s.base,a.registration.room,token);assert.equal((await p.messages.wait('ready')).desktop,true);
 const offer={type:'offer',source:'phoneScreen',session:'one',sdp:'phone-offer'};
 p.ws.send(JSON.stringify(offer));assert.deepEqual(await a.messages.wait('offer'),offer);
 const answer={...offer,type:'answer',sdp:'answer'};a.ws.send(JSON.stringify(answer));assert.deepEqual(await p.messages.wait('answer'),answer);
 a.ws.send(JSON.stringify({type:'desktop-state',connected:false}));await p.messages.wait('studio-away');
 a.ws.send(JSON.stringify({type:'desktop-state',connected:true}));await p.messages.wait('restart');
 const closed=once(p.ws,'close');a.ws.send(JSON.stringify({type:'revoke'}));assert.equal((await closed)[0],4001);
 assert.equal(await rejected(s.base.replace('http:','ws:')+'/signal/phone',{'X-FlowCast-Room':a.registration.room,'X-Phone-Token':token}),401);
});
test('room owner and room isolation survive studio reconnection',async t=>{
 const s=await setup(t),identity={room:capability(),owner:capability()},a=await studio(t,s.base,identity);
 const p=await phone(t,s.base,identity.room,(await(await pair(s.base,a.registration)).json()).token);await p.messages.wait('ready');
 a.ws.close();await once(a.ws,'close');await p.messages.wait('studio-away');
 const b=await studio(t,s.base,identity);assert.equal(b.registration.room,identity.room);await p.messages.wait('restart');
});
test('local bridge negotiates through hub and returns to LAN without exposing recording controls',async t=>{
 const hub=await setup(t),root=await mkdtemp(join(tmpdir(),'flowcast-remote-'));
 const local=await startStudio({port:0,tlsPort:0,allowRemoteLoopback:true,dataDir:join(root,'data'),recordingDir:join(root,'recordings')});
 t.after(async()=>{await local.shutdown();await rm(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+local.address().port,initial=await(await fetch(base+'/api/state')).json();
 const desktop=new WebSocket(base.replace('http:','ws:')+'/signal/desktop?key='+initial.desktopKey),messages=inbox(desktop);
 t.after(()=>desktop.terminate());await once(desktop,'open');
 assert.equal((await fetch(base+'/api/remote',{method:'POST',body:JSON.stringify({url:hub.base,accessKey:key})})).status,202);
 const state=await eventually(async()=>{const value=await(await fetch(base+'/api/remote')).json();return value.state==='ready'?value:null;});
 assert.ok(!JSON.stringify(state).includes(key));const payload=JSON.parse(state.payload);
 // The hub's configured public URL is not used by the local bridge as a redirect destination.
 assert.equal(payload.url,hub.base);
 const token=(await(await pair(hub.base,payload)).json()).token,p=await phone(t,hub.base,payload.room,token);await p.messages.wait('ready');
 p.ws.send(JSON.stringify({type:'offer',source:'phoneCamera',session:'s',sdp:'remote-offer'}));
 assert.equal((await messages.wait('offer')).sdp,'remote-offer');
 desktop.send(JSON.stringify({type:'answer',source:'phoneCamera',session:'s',sdp:'local-answer'}));assert.equal((await p.messages.wait('answer')).sdp,'local-answer');
 const config=await messages.wait('rtc-config');assert.ok(Array.isArray(config.config.iceServers));
 assert.equal((await fetch(base+'/api/pair',{method:'POST',body:JSON.stringify({code:initial.code})})).status,409);
 assert.equal((await fetch(base+'/api/remote/qr')).headers.get('content-type'),'image/png');
 assert.equal((await fetch(base+'/api/remote',{method:'DELETE'})).status,200);
 assert.equal((await(await fetch(base+'/api/remote')).json()).enabled,false);
 assert.equal((await fetch(base+'/api/pair',{method:'POST',body:JSON.stringify({code:initial.code})})).status,200);
});
test('remote pairing rate limits cannot be bypassed with forwarded headers',async t=>{
 const s=await setup(t);let status;for(let i=0;i<21;i++)status=(await fetch(s.base+'/api/remote/pair',{method:'POST',headers:{'X-Forwarded-For':'192.0.2.'+i},body:'{}'})).status;
 assert.equal(status,429);
});
