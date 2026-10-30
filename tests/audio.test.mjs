import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {AudioMixer}=await import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('../public/audio.js',import.meta.url),'utf8')).toString('base64'));
function setup(){
 let amplitude=0;
 class Node {connections=new Set();gain={value:1};fftSize=1024;connect(node){this.connections.add(node);return node;}disconnect(){this.connections.clear();}getFloatTimeDomainData(samples){samples.fill(amplitude);}}
 const context={state:'running',destination:new Node(),resume:async()=>{},createGain:()=>new Node(),createAnalyser:()=>new Node(),createMediaStreamDestination:()=>({stream:{id:'persistent-output'}}),createMediaStreamSource:()=>new Node()};
 const mixer=new AudioMixer({createContext:()=>context,createStream:tracks=>({tracks})});
 const track=()=>Object.assign(new EventTarget(),{readyState:'live',enabled:true,muted:false});
 const stream=tracks=>({getAudioTracks:()=>tracks});
 return {mixer,context,track,stream,tone:value=>amplitude=value};
}
test('phone monitoring is opt-in and cannot route the PC microphone to speakers',()=>{
 const s=setup();s.mixer.attach('phoneScreen',s.stream([s.track()]));s.mixer.attach('mic',s.stream([s.track()]));
 assert.equal(s.mixer.monitorGain.gain.value,0);
 assert.ok(s.mixer.nodes.get('phoneScreen').analyser.connections.has(s.mixer.monitorGain));
 assert.ok(!s.mixer.nodes.get('mic').analyser.connections.has(s.mixer.monitorGain));
 s.mixer.setMonitoring(true);assert.equal(s.mixer.monitorGain.gain.value,0.7);
 s.mixer.setMonitoring(false);assert.equal(s.mixer.monitorGain.gain.value,0);
});
test('recording mute and listening have independent paths and keep the output stream',()=>{
 const s=setup();s.mixer.ensure();const output=s.mixer.destination.stream;s.mixer.setMonitoring(true);s.mixer.setMuted(true);
 assert.equal(s.mixer.recordGain.gain.value,0);assert.equal(s.mixer.monitorGain.gain.value,0.7);
 s.mixer.setMuted(false);s.mixer.setMonitoring(false);assert.equal(s.mixer.recordGain.gain.value,1);assert.equal(s.mixer.destination.stream,output);
});
test('ended or superseded phone tracks cannot leave duplicate sources in the mix',()=>{
 const s=setup(),first=s.track(),second=s.track(),a=s.stream([first]),b=s.stream([second]);
 s.mixer.attach('phoneCamera',a);const old=s.mixer.nodes.get('phoneCamera');s.mixer.attach('phoneCamera',a);assert.equal(s.mixer.nodes.get('phoneCamera'),old);
 s.mixer.attach('phoneCamera',b);assert.equal(old.node.connections.size,0);assert.equal(old.analyser.connections.size,0);
 first.readyState='ended';first.dispatchEvent(new Event('ended'));assert.equal(s.mixer.nodes.get('phoneCamera').tracks[0],second);
 second.readyState='ended';second.dispatchEvent(new Event('ended'));assert.equal(s.mixer.nodes.size,0);
});
test('phone level measures real sample energy and distinguishes missing, paused and silent tracks',()=>{
 const s=setup();assert.equal(s.mixer.measurePhone().tracks,0);s.mixer.attach('phoneScreen',s.stream([s.track()]));s.tone(0.1);
 const value=s.mixer.measurePhone();assert.equal(value.db,-20);assert.ok(value.level>60);assert.equal(value.audible,true);
 s.tone(0);assert.equal(s.mixer.measurePhone().audible,false);s.mixer.nodes.get('phoneScreen').tracks[0].muted=true;assert.equal(s.mixer.measurePhone().paused,true);
});
test('suspended browser audio does not report audible input',async()=>{
 const s=setup();s.mixer.attach('phoneScreen',s.stream([s.track()]));s.tone(0.2);s.context.state='suspended';
 assert.equal(s.mixer.measurePhone().running,false);assert.equal(s.mixer.measurePhone().level,0);await assert.rejects(s.mixer.resume(),/浏览器声音已暂停/);
 s.context.resume=async()=>s.context.state='running';await s.mixer.resume();assert.equal(s.mixer.measurePhone().running,true);
});
