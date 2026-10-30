import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Recordings} from '../lib/recordings.mjs';
async function setup(t){const root=await mkdtemp(join(tmpdir(),'flowcast-recordings-'));const recordings=new Recordings(root);t.after(async()=>{await recordings.close();await rm(root,{recursive:true,force:true});});return recordings;}

test('concurrent starts allow only one recording',async t=>{
 const r=await setup(t);const results=await Promise.allSettled([r.start(),r.start()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.sessions.size,1);
});
test('chunks persist in order; retries cannot duplicate or change data',async t=>{
 const r=await setup(t),{id}=await r.start();
 await Promise.all([r.append(id,0,Buffer.from('first')),r.append(id,1,Buffer.from('second'))]);
 assert.equal((await r.append(id,1,Buffer.from('second'))).bytes,11);
 await assert.rejects(r.append(id,1,Buffer.from('changed')),/内容不一致/);
 await assert.rejects(r.append(id,3,Buffer.from('gap')),/顺序/);
 assert.equal(await readFile(r.path(id,'.partial.webm'),'utf8'),'firstsecond');
});
test('partial disk failure rolls back before retry',async t=>{
 const r=await setup(t),{id}=await r.start(),s=r.sessions.get(id),write=s.file.write.bind(s.file);let calls=0;
 s.file.write=async(buffer,offset,length,position)=>{if(calls++===0)return write(buffer,offset,2,position);throw new Error('disk full');};
 await assert.rejects(r.append(id,0,Buffer.from('abcdef')),/disk full/);
 assert.equal((await readFile(r.path(id,'.partial.webm'))).length,0);s.file.write=write;
 await r.append(id,0,Buffer.from('abcdef'));assert.equal(await readFile(r.path(id,'.partial.webm'),'utf8'),'abcdef');
});
test('metadata failure leaves sequence retryable and bytes unduplicated',async t=>{
 const r=await setup(t),{id}=await r.start(),save=r.save.bind(r);r.save=async()=>{throw new Error('metadata failed');};
 await assert.rejects(r.append(id,0,Buffer.from('abc')),/metadata failed/);assert.equal(r.sessions.get(id).meta.next,0);r.save=save;
 await r.append(id,0,Buffer.from('abc'));assert.equal(await readFile(r.path(id,'.partial.webm'),'utf8'),'abc');
});
test('shutdown waits for accepted writes and leaves recoverable metadata',async t=>{
 const r=await setup(t),{id}=await r.start();const append=r.append(id,0,Buffer.from('saved'));await r.close();await append;
 assert.equal((await r.list())[0].state,'recoverable');assert.equal(await readFile(r.path(id,'.partial.webm'),'utf8'),'saved');await assert.rejects(r.start(),/关闭/);
});
test('interrupted finalization is listed as recoverable after restart',async t=>{
 const r=await setup(t),{id}=await r.start();await r.close();const meta=JSON.parse(await readFile(r.path(id,'.json'),'utf8'));meta.state='processing';await writeFile(r.path(id,'.json'),JSON.stringify(meta));
 const restarted=new Recordings(r.root);assert.equal((await restarted.list())[0].state,'recoverable');
});
test('real WebM recovery, deduplicated finalization and MP4 conversion',async t=>{
 const r=await setup(t);const fixture=join(r.root,'fixture.webm');await r.run(['-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','1','-c:v','libvpx',fixture]);
 const data=await readFile(fixture),{id}=await r.start();const writing=r.append(id,0,data);
 const [a,b]=await Promise.all([r.finish(id),r.finish(id)]);await writing;assert.equal(a.state,'ready');assert.equal(b.state,'ready');
 const [mp4,duplicate]=await Promise.all([r.mp4(id),r.mp4(id)]);assert.equal(mp4.mp4,true);assert.equal(duplicate.mp4,true);
 assert.ok((await readFile(r.path(id,'.mp4'))).length>1000);await r.run(['-i',r.path(id,'.mp4'),'-f','null','-']);
});
