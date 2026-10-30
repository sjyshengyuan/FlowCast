import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const {installLifecycle}=createRequire(import.meta.url)('../desktop/lifecycle.cjs');
function setup(){
 const app=new EventEmitter(),window=new EventEmitter();window.webContents=new EventEmitter();
 const calls={starts:0,stops:0,shutdown:0,quit:0,warnings:0,errors:[]};
 let finish;const pending=new Promise(resolve=>{finish=resolve;});
 app.quit=()=>{calls.quit++;app.emit('before-quit',{preventDefault(){throw new Error('Final quit must not be blocked');}});};
 const server={async shutdown(){calls.shutdown++;await pending;}};
 const lifecycle=installLifecycle({app,window,server,powerSaveBlocker:{start(){calls.starts++;return 42;},stop(id){assert.equal(id,42);calls.stops++;}},dialog:{showMessageBox(){calls.warnings++;return Promise.resolve();},showErrorBox(title,message){calls.errors.push({title,message});}}});
 const event=()=>({prevented:false,preventDefault(){this.prevented=true;}});
 return {app,window,calls,lifecycle,finish,event,server};
}
test('native close and app quit remain blocked throughout recording and finalization',async()=>{
 const s=setup();s.lifecycle.setRecording(true);s.lifecycle.setRecording(true);
 const close=s.event(),quit=s.event();s.window.emit('close',close);s.app.emit('before-quit',quit);
 assert.equal(close.prevented,true);assert.equal(quit.prevented,true);assert.equal(s.calls.shutdown,0);assert.equal(s.calls.starts,1);assert.equal(s.calls.warnings,1);
 s.lifecycle.setRecording(false);assert.equal(s.calls.stops,1);
 const idle=s.event();s.window.emit('close',idle);assert.equal(idle.prevented,false);
 s.finish();await s.lifecycle.stop();
});
test('quit waits for server writes and conversions and shuts down only once',async()=>{
 const s=setup(),event=s.event();s.app.emit('before-quit',event);s.app.emit('window-all-closed');
 await Promise.resolve();assert.equal(event.prevented,true);assert.equal(s.calls.shutdown,1);assert.equal(s.calls.quit,0);
 s.finish();await s.lifecycle.stop();assert.equal(s.calls.quit,1);
});
test('renderer crash releases sleep blocker and allows closing for recovery',async()=>{
 const s=setup();s.lifecycle.setRecording(true);s.window.webContents.emit('render-process-gone');
 assert.equal(s.calls.stops,1);assert.equal(s.calls.errors.length,1);
 const close=s.event();s.window.emit('close',close);assert.equal(close.prevented,false);
 s.finish();await s.lifecycle.stop();assert.equal(s.calls.shutdown,1);
});
test('invalid renderer state cannot silently clear native recording protection',async()=>{
 const s=setup();s.lifecycle.setRecording(true);assert.throws(()=>s.lifecycle.setRecording('false'),TypeError);
 const close=s.event();s.window.emit('close',close);assert.equal(close.prevented,true);
 s.lifecycle.setRecording(false);s.finish();await s.lifecycle.stop();
});
test('shutdown failure is reported and does not leave a background process',async()=>{
 const s=setup();s.server.shutdown=async()=>{throw new Error('disk unavailable');};
 await s.lifecycle.stop();assert.equal(s.calls.quit,1);assert.match(s.calls.errors[0].message,/disk unavailable/);
});
