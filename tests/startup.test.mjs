import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {startStudio} from '../server.mjs';
async function occupy(t,host='127.0.0.1'){const server=http.createServer((req,res)=>res.end('occupied'));await new Promise(resolve=>server.listen(0,host,resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return server.address().port;}
test('occupied HTTP and TLS ports fall back and pairing advertises actual port',async t=>{
 const root=await mkdtemp(join(tmpdir(),'flowcast-ports-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const port=await occupy(t),tlsPort=await occupy(t,'0.0.0.0');
 const server=await startStudio({port,tlsPort,dataDir:join(root,'data'),recordingDir:join(root,'recordings')});t.after(()=>server.shutdown());
 assert.notEqual(server.address().port,port);assert.notEqual(server.secure.address().port,tlsPort);
 const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await(await fetch(base+'/health')).json()).ok,true);
 const state=await(await fetch(base+'/api/state')).json();for(const entry of state.pairing)assert.equal(new URL(JSON.parse(entry.payload).url).port,String(server.secure.address().port));
 const host=Object.values(networkInterfaces()).flat().find(x=>x?.family==='IPv4')?.address;
 if(host){const qr=await fetch(base+'/api/qr?host='+host);assert.equal(qr.status,200);assert.equal(qr.headers.get('content-type'),'image/png');}
 const origin=base;assert.equal((await fetch(base+'/api/state',{headers:{Origin:origin}})).status,200);
 const other=await startStudio({port:0,tlsPort:0,dataDir:join(root,'other-data'),recordingDir:join(root,'other-recordings')});await other.shutdown();
 await assert.rejects(startStudio({port,tlsPort:0,autoPort:false,dataDir:join(root,'strict-data'),recordingDir:join(root,'strict-recordings')}),{code:'EADDRINUSE'});
});
