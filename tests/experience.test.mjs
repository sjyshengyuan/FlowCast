import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {QUALITY_PRESETS,FramePacer,SourceSwitch,AdaptiveQuality}=await import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('../public/experience.js',import.meta.url),'utf8')).toString('base64'));

test('recording quality presets provide increasing detail and bitrate',()=>{
 assert.equal(QUALITY_PRESETS.smooth.width,1280);assert.equal(QUALITY_PRESETS.detail.height,1080);
 assert.ok(QUALITY_PRESETS.detail.bitrate>QUALITY_PRESETS.balanced.bitrate);
});
test('source switch waits for a live source and commits once it is ready',()=>{
 const ready=new Set(['desktop']);const switcher=new SourceSwitch('desktop');
 assert.equal(switcher.select('phoneScreen',key=>ready.has(key)),false);
 assert.equal(switcher.pending,'phoneScreen');ready.add('phoneScreen');
 assert.equal(switcher.commit(key=>ready.has(key)),true);assert.equal(switcher.current,'phoneScreen');
 assert.equal(switcher.commit(key=>ready.has(key)),false);
});
test('frame pacer limits a 120Hz callback stream to the target rate',()=>{
 const pacer=new FramePacer();let draws=0;for(let i=0;i<120;i++)if(pacer.due(i*1000/120,30))draws++;
 assert.ok(draws>=29&&draws<=31);
});

const healthy={active:true,lossPercent:0,bufferMs:30,rtt:25,jitter:3};
const congested={...healthy,lossPercent:12,bufferMs:240};

test('sustained congestion lowers transport one step, with a cooldown',()=>{
 const policy=new AdaptiveQuality('detail');
 assert.equal(policy.sample([congested],0),null);
 assert.equal(policy.sample([congested],2000),'balanced');
 for(let now=4000;now<14000;now+=2000)assert.equal(policy.sample([congested],now),null);
 assert.equal(policy.sample([congested],14000),'smooth');
 for(let now=16000;now<34000;now+=2000)assert.equal(policy.sample([congested],now),null);
 assert.equal(policy.current,'smooth');
});
test('recovery requires twenty continuous healthy seconds and respects the ceiling',()=>{
 const policy=new AdaptiveQuality('balanced');policy.sample([congested],0);policy.sample([congested],2000);
 for(let now=4000;now<24000;now+=2000)assert.equal(policy.sample([healthy],now),null);
 assert.equal(policy.sample([healthy],24000),'balanced');
 for(let now=26000;now<=50000;now+=2000)assert.equal(policy.sample([healthy],now),null);
 assert.equal(policy.current,'balanced');
});
test('static screens, missing stats and sampling gaps cannot force a quality change',()=>{
 const policy=new AdaptiveQuality('detail');
 for(let now=0;now<=30000;now+=2000)assert.equal(policy.sample([{...congested,active:false,fps:0}],now),null);
 assert.equal(policy.sample([congested],32000),null);
 assert.equal(policy.sample([congested],44000),null);
 assert.equal(policy.sample([],46000),null);
 assert.equal(policy.sample([congested],48000),null);
 assert.equal(policy.current,'detail');
});
test('both sources form one decision and a bad source prevents premature recovery',()=>{
 const policy=new AdaptiveQuality('detail');
 assert.equal(policy.sample([healthy,congested],0),null);
 assert.equal(policy.sample([healthy,congested],2000),'balanced');
 for(let now=4000;now<=30000;now+=2000)policy.sample([healthy,{...healthy,bufferMs:110}],now);
 assert.equal(policy.current,'balanced');
});
test('manual transport control and disabling adaptation take effect immediately',()=>{
 const policy=new AdaptiveQuality('detail');policy.sample([congested],0);policy.sample([congested],2000);
 policy.configure('detail',false);
 for(let now=4000;now<=30000;now+=2000)assert.equal(policy.sample([congested],now),null);
 assert.equal(policy.current,'detail');policy.configure('smooth',true);
 for(let now=32000;now<=60000;now+=2000)policy.sample([healthy],now);
 assert.equal(policy.current,'smooth');
});
test('unknown latency fields cannot promote transport quality',()=>{
 const policy=new AdaptiveQuality('balanced');policy.sample([congested],0);policy.sample([congested],2000);
 for(let now=4000;now<=40000;now+=2000)policy.sample([{active:true,lossPercent:0}],now);
 assert.equal(policy.current,'smooth');
});
test('cancelled and superseded source requests cannot commit later',()=>{
 const available=new Set(['desktop']),ready=key=>available.has(key),switcher=new SourceSwitch('desktop');
 switcher.select('phoneScreen',ready);switcher.select('phoneCamera',ready);available.add('phoneScreen');
 assert.equal(switcher.commit(ready),false);switcher.cancel();available.add('phoneCamera');
 assert.equal(switcher.commit(ready),false);assert.equal(switcher.current,'desktop');
 switcher.select('phoneCamera',ready);assert.equal(switcher.current,'phoneCamera');
});
test('frame pacing resumes without bursts after a long stall or rate change',()=>{
 const pacer=new FramePacer();assert.equal(pacer.due(0,4),true);assert.equal(pacer.due(10,4),false);
 assert.equal(pacer.due(15,30),true);assert.equal(pacer.due(16,30),false);
 assert.equal(pacer.due(5000,30),true);assert.equal(pacer.due(5001,30),false);
});
