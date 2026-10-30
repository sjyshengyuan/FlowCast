import {mkdir,open,readFile,writeFile,readdir,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

export class Recordings {
 constructor(root){this.root=root;this.sessions=new Map();this.jobs=new Map();this.starting=null;this.closing=false;}
 async init(){await mkdir(this.root,{recursive:true});}
 path(id,ext){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new Error('Invalid recording');return join(this.root,id+ext);}
 async save(meta){const target=this.path(meta.id,'.json');await writeFile(target+'.tmp',JSON.stringify(meta,null,2));await rename(target+'.tmp',target);}
 async start(){
  if(this.closing)throw new Error('服务正在关闭');
  if(this.starting||this.sessions.size)throw new Error('已有录制正在进行');
  const task=Promise.resolve().then(async()=>{
   await this.init();
   const id=randomUUID(),file=await open(this.path(id,'.partial.webm'),'wx');
   const meta={id,created:new Date().toISOString(),state:'recording',bytes:0,next:0};
   try{await this.save(meta);}catch(error){await file.close();await unlink(this.path(id,'.partial.webm')).catch(()=>{});throw error;}
   this.sessions.set(id,{file,meta,queue:Promise.resolve(),accepting:true});return {...meta};
  });
  this.starting=task;try{return await task;}finally{this.starting=null;}
 }
 async append(id,seq,data){
  const s=this.sessions.get(id);
  if(this.closing||!s?.accepting)throw new Error('录制不存在或已经结束');
  if(!Number.isSafeInteger(seq)||seq<0||!data.length)throw new Error('无效的录制分片');
  const task=s.queue.then(async()=>{
   const hash=createHash('sha256').update(data).digest('hex');
   if(seq===s.meta.next-1){if(hash!==s.meta.lastHash)throw new Error('重复分片内容不一致');return {...s.meta};}
   if(seq!==s.meta.next)throw new Error('录制分片顺序错误');
   const meta={...s.meta,bytes:s.meta.bytes+data.length,next:seq+1,lastHash:hash};
   try{
    let offset=0;
    while(offset<data.length){const result=await s.file.write(data,offset,data.length-offset,s.meta.bytes+offset);if(!result.bytesWritten)throw new Error('磁盘写入中断');offset+=result.bytesWritten;}
    await s.file.sync();await this.save(meta);s.meta=meta;return {...meta};
   }catch(error){
    // A failed request must never duplicate partially written bytes on retry.
    try{await s.file.truncate(s.meta.bytes);await s.file.sync();}catch{s.accepting=false;}
    throw error;
   }
  });
  s.queue=task.catch(()=>{});return task;
 }
 async finish(id){
  const s=this.sessions.get(id);
  if(s){
   if(!s.finishing){s.accepting=false;s.finishing=(async()=>{await s.queue;await s.file.sync();await s.file.close();this.sessions.delete(id);s.meta.state='processing';await this.save(s.meta);})();}
   await s.finishing;
  }
  return this.recover(id);
 }
 async run(args){
  const executable=ffmpeg?.replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');if(!executable)throw new Error('缺少视频封装程序');
  await new Promise((resolve,reject)=>{const child=spawn(executable,['-hide_banner','-loglevel','error','-nostdin',...args],{windowsHide:true});let error='';child.stderr.on('data',d=>error=(error+d).slice(-3000));child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error||'视频处理失败')));});
 }
 async job(id,action,work){
  const existing=this.jobs.get(id);
  if(existing){if(existing.action!==action)throw new Error('视频正在处理中');return existing.promise;}
  const promise=Promise.resolve().then(work);this.jobs.set(id,{action,promise});
  try{return await promise;}finally{this.jobs.delete(id);}
 }
 async recover(id){
  if(this.sessions.has(id))throw new Error('录制尚未结束');
  return this.job(id,'recover',async()=>{
   const meta=JSON.parse(await readFile(this.path(id,'.json'),'utf8'));
   if(meta.state==='ready')return meta;
   try{
    await this.run(['-y','-i',this.path(id,'.partial.webm'),'-map','0','-c','copy',this.path(id,'.webm')]);
    meta.state='ready';meta.error=null;await this.save(meta);await unlink(this.path(id,'.partial.webm')).catch(()=>{});
   }catch(error){meta.state='recoverable';meta.error=error.message;await this.save(meta);}
   return meta;
  });
 }
 async mp4(id){
  return this.job(id,'mp4',async()=>{
   const meta=JSON.parse(await readFile(this.path(id,'.json'),'utf8'));
   if(meta.state!=='ready')throw new Error('请先完成录制');if(meta.mp4)return meta;
   const temp=this.path(id,'.converting.mp4');
   try{await this.run(['-y','-i',this.path(id,'.webm'),'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',temp]);await rename(temp,this.path(id,'.mp4'));meta.mp4=true;await this.save(meta);return meta;}
   finally{await unlink(temp).catch(()=>{});}
  });
 }
 async list(){
  await this.init();const items=[];
  for(const name of await readdir(this.root)){
   if(!name.endsWith('.json'))continue;
   try{const meta=JSON.parse(await readFile(join(this.root,name),'utf8'));this.path(meta.id,'.json');if(['recording','processing'].includes(meta.state)&&!this.sessions.has(meta.id)&&!this.jobs.has(meta.id))meta.state='recoverable';items.push(meta);}catch{}
  }
  return items.sort((a,b)=>b.created.localeCompare(a.created));
 }
 async close(){
  this.closing=true;await this.starting?.catch(()=>{});
  for(const [id,s]of this.sessions){
   s.accepting=false;
   if(s.finishing){await s.finishing;continue;}
   await s.queue;await s.file.sync();await s.file.close();s.meta.state='recoverable';await this.save(s.meta);this.sessions.delete(id);
  }
  await Promise.allSettled([...this.jobs.values()].map(job=>job.promise));
 }
}
