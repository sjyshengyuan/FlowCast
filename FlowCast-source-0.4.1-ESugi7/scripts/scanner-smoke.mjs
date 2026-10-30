import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {startStudio} from '../server.mjs';
import {remoteSmoke} from './remote-smoke-support.mjs';
const qa=resolve('.qa');await mkdir(qa,{recursive:true});const run=await mkdtemp(join(qa,'scanner-'));
async function findFile(root,name){
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(entry.isFile()&&entry.name===name)return join(root,entry.name);
  if(entry.isDirectory()){const found=await findFile(join(root,entry.name),name);if(found)return found;}
 }
}
const jdkRoot=resolve('.toolchain/jdk'),jdk=join(jdkRoot,(await readdir(jdkRoot,{withFileTypes:true})).find(entry=>entry.isDirectory()).name);
const jar=await findFile(join(homedir(),'.gradle/caches/modules-2/files-2.1/com.google.zxing/core'),'core-3.4.1.jar');
if(!jar)throw Error('Build Android first to populate the existing ZXing dependency');
async function command(executable,args){
 await new Promise((resolve,reject)=>{const child=spawn(executable,args,{windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('QR decoder verification failed: '+code)));});
}
const server=await startStudio({port:0,tlsPort:0,allowRemoteLoopback:true,dataDir:join(run,'data'),recordingDir:join(run,'recordings')});
let remote;
try{
 const base='http://127.0.0.1:'+server.address().port,state=await(await fetch(base+'/api/state')).json();
 if(!state.pairing.length)throw Error('No network interface available for QR test');
 const response=await fetch(base+'/api/qr?host='+encodeURIComponent(state.pairing[0].address));
 if(!response.ok)throw Error('Server QR unavailable');await writeFile(join(run,'qr.png'),Buffer.from(await response.arrayBuffer()));
 await writeFile(join(run,'payload.txt'),state.pairing[0].payload);
 await command(join(jdk,'bin/javac.exe'),['-encoding','UTF-8','-cp',jar,'-d',run,resolve('android/app/src/main/java/dev/flowcast/companion/QrImageDecoder.java'),resolve('scripts/QrDecoderSmoke.java')]);
 await command(join(jdk,'bin/java.exe'),['-Djava.awt.headless=true','-cp',run+';'+jar,'dev.flowcast.companion.QrDecoderSmoke',join(run,'qr.png'),join(run,'payload.txt')]);
 remote=await remoteSmoke(base);
 await fetch(base+'/api/remote',{method:'POST',body:JSON.stringify({url:remote.url,accessKey:remote.key})});
 let remoteState;for(let i=0;i<100;i++){remoteState=await(await fetch(base+'/api/remote')).json();if(remoteState.state==='ready')break;await new Promise(resolve=>setTimeout(resolve,30));}
 if(!remoteState.payload)throw Error('Remote QR unavailable');
 const remoteQr=await fetch(base+'/api/remote/qr');if(!remoteQr.ok)throw Error('Remote QR response failed');
 await writeFile(join(run,'remote-qr.png'),Buffer.from(await remoteQr.arrayBuffer()));await writeFile(join(run,'remote-payload.txt'),remoteState.payload);
 await command(join(jdk,'bin/java.exe'),['-Djava.awt.headless=true','-cp',run+';'+jar,'dev.flowcast.companion.QrDecoderSmoke',join(run,'remote-qr.png'),join(run,'remote-payload.txt')]);
 await writeFile(join(qa,'scanner-result.json'),JSON.stringify({passed:true,checks:20,protocols:['v2 LAN','v3 remote'],liveCameraVerified:false,checksDescription:['server PNG','four-module white quiet zone and integer modules','240px QR','rotation','inverted colours','transparent background','off-centre screenshot','blank image','oversized image','mismatched pixels']},null,2));
}finally{await server.shutdown();await remote?.close();}
