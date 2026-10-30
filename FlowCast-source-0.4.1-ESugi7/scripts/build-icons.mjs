import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebSocket} from 'ws';
const qa=resolve('.qa');await mkdir(qa,{recursive:true});const run=await mkdtemp(join(qa,'icons-'));
const child=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+join(run,'chrome'),'--no-first-run','about:blank'],{windowsHide:true,stdio:'ignore'});
let ws,serial=0,launchError;child.on('error',error=>launchError=error);const pending=new Map(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function call(method,params={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params}));});}
try{
 let port;for(let i=0;i<100;i++){if(launchError)throw launchError;try{port=Number((await readFile(join(run,'chrome','DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await sleep(100);}}
 if(!port)throw Error('Chrome did not start');
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json')).json();ws=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});ws.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.id){const task=pending.get(msg.id);pending.delete(msg.id);if(msg.error)task?.reject(Error(JSON.stringify(msg.error)));else task?.resolve(msg.result);}};
 const svg=await readFile(resolve('public/assets/flowcast.svg'),'utf8');
 async function png(size){const expression='(async()=>{const img=new Image();img.src='+JSON.stringify('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'))+';await img.decode();const canvas=document.createElement("canvas");canvas.width=canvas.height='+size+';canvas.getContext("2d").drawImage(img,0,0,'+size+','+size+');return canvas.toDataURL("image/png").split(",")[1];})()';const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return Buffer.from(result.result.value,'base64');}
 const assets=resolve('public/assets');const sizes=[16,24,32,48,64,128,256],images=[];
 for(const size of [1024,512,192,180,...sizes]){const image=await png(size);await writeFile(join(assets,'flowcast-'+size+'.png'),image);if(sizes.includes(size))images.push({size,image});}
 await writeFile(join(assets,'favicon.png'),await png(32));
 const header=Buffer.alloc(6+images.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);let offset=header.length;
 for(const [i,{size,image}]of images.entries()){const pos=6+i*16;header[pos]=header[pos+1]=size===256?0:size;header.writeUInt16LE(1,pos+4);header.writeUInt16LE(32,pos+6);header.writeUInt32LE(image.length,pos+8);header.writeUInt32LE(offset,pos+12);offset+=image.length;}
 await writeFile(join(assets,'flowcast.ico'),Buffer.concat([header,...images.map(row=>row.image)]));
 console.log('Built SVG-derived PNG masters, favicon and 7-size Windows ICO.');
}finally{if(ws){try{await call('Browser.close');}catch{}ws.close();}child.kill();}
