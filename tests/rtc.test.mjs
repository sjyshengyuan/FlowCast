import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/rtc.js',import.meta.url),'utf8');
const {PhoneReceiver,lanCandidates,iceSummary,videoStats}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function setup(t,options={}){
 const saved=Object.fromEntries(['WebSocket','RTCPeerConnection','MediaStream','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const peers=[],sent=[],states=[],streams=[];let release;const gate=new Promise(resolve=>release=resolve);
 class Socket{constructor(url){this.url=url;}readyState=1;send(message){sent.push(JSON.parse(message));}close(){}}
 class Peer{constructor(config){this.config=config;peers.push(this);}async setRemoteDescription(value){await gate;this.remoteDescription=value;}async createAnswer(){return {type:'answer',sdp:'answer'};}async setLocalDescription(value){this.localDescription=value;}async addIceCandidate(value){assert.ok(this.remoteDescription,'SDP must be ready before ICE');this.candidate=value;}close(){this.closed=true;}}
 class Stream{constructor(){this.tracks=[];}getTracks(){return this.tracks;}addTrack(track){this.tracks.push(track);}}
 Object.assign(globalThis,{MediaStream:Stream,WebSocket:Socket,RTCPeerConnection:Peer,location:{host:'localhost:4310'}});
 const receiver=new PhoneReceiver({...options,key:'key',onStream:(...args)=>streams.push(args),onState:state=>states.push(state),onStats:()=>{}});
 t.after(()=>{receiver.close();for(const [key,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
 return {receiver,peers,sent,states,streams,release,send:value=>receiver.ws.onmessage({data:JSON.stringify(value)})};
}
const offer={type:'offer',source:'phoneScreen',session:'one',sdp:'offer'};
test('remote ICE and relay policy reach peers and refresh without replacing their streams',async t=>{
 const s=setup(t,{getLocalAddresses:()=>['10.0.0.2']});
 const config={iceServers:[{urls:['turn:turn.example.com:3478'],username:'time:room',credential:'temporary'}],iceTransportPolicy:'relay'};
 s.send({type:'rtc-config',config});s.send(offer);s.release();await s.receiver.signaling;
 assert.deepEqual(s.peers[0].config,config);
 s.peers[0].onicecandidate({candidate:{toJSON:()=>({candidate:'candidate:a 1 udp 1 peer.local 12345 typ host'})}});
 assert.equal(s.sent.filter(row=>row.type==='candidate').length,1,'no synthetic LAN candidates in TURN mode');
 let refreshed;s.peers[0].setConfiguration=value=>refreshed=value;
 const next={...config,iceServers:[{...config.iceServers[0],username:'new-time:room'}]};
 s.send({type:'rtc-config',config:next});assert.deepEqual(refreshed,next);assert.equal(s.peers.length,1);
});

test('media route reports relay only when selected candidates prove it',()=>{
 const rows=new Map([['transport',{type:'transport',selectedCandidatePairId:'pair'}],['pair',{type:'candidate-pair',localCandidateId:'local',remoteCandidateId:'remote'}],['local',{candidateType:'host'}],['remote',{candidateType:'relay'}]]);
 assert.equal(videoStats(statsRow(),previous,rows).route,'中继');
 rows.set('remote',{candidateType:'srflx'});assert.equal(videoStats(statsRow(),previous,rows).route,'直连');
});

test('ICE waits for asynchronous SDP and local answer',async t=>{const s=setup(t);s.send(offer);s.send({...offer,type:'candidate',candidate:{candidate:'ice'}});await Promise.resolve();assert.equal(s.peers.length,1);s.release();await s.receiver.signaling;assert.equal(s.peers[0].candidate.candidate,'ice');assert.equal(s.sent[0].type,'answer');assert.ok(s.states.includes('已收到手机视频请求，正在协商'));});
test('ICE delivered before offer is buffered for that session',async t=>{const s=setup(t);s.send({...offer,type:'candidate',candidate:{candidate:'early'}});s.send(offer);s.release();await s.receiver.signaling;assert.equal(s.peers[0].candidate.candidate,'early');});
test('disconnect cancels in-flight SDP without sending stale answer',async t=>{const s=setup(t);s.send(offer);await Promise.resolve();s.send({type:'phone',connected:false});s.release();await s.receiver.signaling;assert.equal(s.peers[0].closed,true);assert.equal(s.sent.length,0);assert.equal(s.receiver.peers.size,0);});

test('audio and video track events share one persistent source stream',async t=>{const s=setup(t);s.send(offer);s.release();await s.receiver.signaling;const video={kind:'video'},audio={kind:'audio'},pc=s.peers[0];pc.ontrack({track:video,streams:[]});const first=s.streams.at(-1)[1];pc.ontrack({track:audio,streams:[]});assert.equal(s.streams.at(-1)[1],first);assert.deepEqual(first.getTracks(),[video,audio]);pc.ontrack({track:video,streams:[]});assert.equal(first.getTracks().length,2);});
test('desktop socket does not duplicate server restart notification',t=>{const s=setup(t);s.receiver.ws.onopen();assert.equal(s.sent.length,0);});

test("reconnect fetches fresh desktop credentials",async t=>{let key="old";const s=setup(t,{getKey:async()=>key});await Promise.resolve();assert.match(s.receiver.ws.url,/key=old/);key="new";await s.receiver.connect();assert.match(s.receiver.ws.url,/key=new/);});
test("late credential lookup cannot open an obsolete socket",async t=>{const pending=[];const s=setup(t,{getKey:()=>new Promise(resolve=>pending.push(resolve))});const next=s.receiver.connect();pending[1]("new");await next;const current=s.receiver.ws;pending[0]("old");await Promise.resolve();assert.equal(s.receiver.ws,current);assert.match(current.url,/key=new/);});
test("closing while credentials load never opens a socket",async t=>{let resolve;const s=setup(t,{getKey:()=>new Promise(done=>resolve=done)});s.receiver.close();resolve("later");await Promise.resolve();assert.equal(s.receiver.ws,undefined);});

test('mDNS retains original and adds deduplicated LAN candidates',()=>{
 const original={candidate:'candidate:a 1 udp 123 device.local 54321 typ host generation 0 ufrag abc',sdpMid:'0',sdpMLineIndex:0,usernameFragment:'abc'};
 const result=lanCandidates(original,['10.0.0.2','10.0.0.2','192.168.0.2','127.0.0.1','169.254.1.1','invalid','999.1.1.1']);
 assert.equal(result.length,3);assert.equal(result[0],original);
 for(const [index,address]of ['10.0.0.2','192.168.0.2'].entries()){const added=result[index+1],fields=added.candidate.split(' ');assert.equal(fields[4],address);assert.equal(fields[5],'54321');assert.equal(added.sdpMid,'0');assert.equal(added.usernameFragment,'abc');assert.ok(added.candidate.endsWith('ufrag abc'));}
 assert.ok(original.candidate.includes('device.local'));
});
test('numeric, relay and malformed candidates remain unchanged',()=>{for(const candidate of ['candidate:a 1 udp 1 10.0.0.1 10000 typ host','candidate:a 1 udp 1 relay.local 10000 typ relay','bad']){const original={candidate};assert.deepEqual(lanCandidates(original,['10.0.0.2']),[original]);}});
test('LAN candidates keep session and obsolete peers cannot send',async t=>{
 const s=setup(t,{getLocalAddresses:()=>['10.0.0.2']});s.send(offer);s.release();await s.receiver.signaling;
 const candidate={candidate:'candidate:a 1 udp 123 host.local 12345 typ host',sdpMid:'0',sdpMLineIndex:0};s.peers[0].onicecandidate({candidate:{toJSON:()=>candidate}});
 const sent=s.sent.filter(x=>x.type==='candidate');assert.equal(sent.length,2);assert.equal(sent[1].session,'one');assert.ok(sent[1].candidate.candidate.includes('10.0.0.2 12345'));
 s.receiver.reset();s.peers[0].onicecandidate({candidate:{toJSON:()=>candidate}});assert.equal(s.sent.filter(x=>x.type==='candidate').length,2);
});
test('two failed video sources do not trigger competing desktop restarts',async t=>{
 const s=setup(t);s.send(offer);s.send({...offer,source:'phoneCamera'});s.release();await s.receiver.signaling;
 for(const peer of s.peers){peer.connectionState='failed';peer.onconnectionstatechange();}
 assert.equal(s.sent.filter(x=>x.type==='restart').length,0);s.receiver.reconnectVideo();assert.equal(s.sent.filter(x=>x.type==='restart').length,1);
});
test('network summary counts probes without exposing addresses',()=>{
 const stats=new Map([['one',{type:'candidate-pair',state:'failed',requestsSent:5,responsesReceived:0}],['two',{type:'candidate-pair',state:'succeeded',requestsSent:3,responsesReceived:2}],['private',{type:'local-candidate',address:'10.0.0.2'}]]);
 const result=iceSummary(stats);assert.equal(result,'候选对 2，成功 1，探测发送 8 / 收到应答 2');assert.ok(!result.includes('10.0.0.2'));
});

test('receiver buffer targets are milliseconds and unsupported browsers remain usable',t=>{
 const s=setup(t),video={track:{kind:'video'},jitterBufferTarget:null},audio={track:{kind:'audio'},jitterBufferTarget:null};
 s.receiver.tuneReceiver(video);assert.equal(video.jitterBufferTarget,40);
 s.receiver.setQuality('smooth');s.receiver.tuneReceiver(video);assert.equal(video.jitterBufferTarget,20);
 s.receiver.setQuality('detail');s.receiver.tuneReceiver(video);assert.equal(video.jitterBufferTarget,80);
 s.receiver.tuneReceiver(audio);assert.equal(audio.jitterBufferTarget,null);
 assert.doesNotThrow(()=>s.receiver.tuneReceiver({track:{kind:'video'}}));
 assert.doesNotThrow(()=>s.receiver.tuneReceiver({track:{kind:'video'},set jitterBufferTarget(value){throw new Error('unsupported');}}));
});
const previous={id:'video',timestamp:1000,framesDecoded:30,bytesReceived:100000,packetsReceived:90,packetsLost:10,jitterBufferDelay:1,jitterBufferEmittedCount:30};
function statsRow(){return {...previous,type:'inbound-rtp',kind:'video',transportId:'transport',timestamp:3000,framesDecoded:90,bytesReceived:600000,packetsReceived:280,packetsLost:20,jitterBufferDelay:3.4,jitterBufferEmittedCount:90,jitter:0.006,frameWidth:720,frameHeight:1280};}
const transportStats=new Map([['transport',{type:'transport',selectedCandidatePairId:'pair'}],['pair',{type:'candidate-pair',currentRoundTripTime:0.025}]]);
test('video health uses interval deltas, selected transport and correct time units',()=>{
 const measured=videoStats(statsRow(),previous,transportStats);
 assert.equal(measured.active,true);assert.equal(measured.fps,30);assert.equal(measured.bitrate,2);
 assert.equal(measured.lossPercent,5);assert.equal(measured.bufferMs,40);assert.equal(measured.rtt,25);assert.equal(measured.jitter,6);
});
test('static video and reset counters do not become fresh congestion samples',()=>{
 const still=videoStats({...previous,timestamp:3000},previous,new Map());
 assert.equal(still.active,false);assert.equal(still.fps,0);assert.equal(still.lossPercent,null);assert.equal(still.bufferMs,null);
 const reset=videoStats({...statsRow(),framesDecoded:1,bytesReceived:10},previous,new Map());
 assert.equal(reset.active,false);assert.equal(reset.lossPercent,null);assert.equal(reset.bitrate,null);
});
test('receiver batches both sources once per measurement and discards obsolete results',async t=>{
 const batches=[],s=setup(t,{onStatsBatch:rows=>batches.push(rows)});
 s.send(offer);s.send({...offer,source:'phoneCamera'});s.release();await s.receiver.signaling;
 for(const peer of s.peers){peer.connectionState='connected';peer.getStats=async()=>new Map([['video',statsRow()],...transportStats]);}
 await s.receiver.measure();await s.receiver.measure();assert.equal(batches.length,2);assert.equal(batches[1].length,2);
 let release;s.peers[0].getStats=()=>new Promise(resolve=>release=resolve);
 const measuring=s.receiver.measure();s.receiver.reset();release(new Map([['video',statsRow()]]));await measuring;
 assert.equal(batches.length,2);
});
