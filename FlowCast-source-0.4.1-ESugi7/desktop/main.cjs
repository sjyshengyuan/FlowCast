const {app,BrowserWindow,ipcMain,desktopCapturer,session,shell,powerSaveBlocker,dialog,Menu}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {installLifecycle}=require('./lifecycle.cjs');
let window,server,selected=null;
app.setName('FlowCast');
// Explicit test mode isolates credentials, recordings and the single-instance lock.
const testRoot=process.env.FLOWCAST_TEST_DIR;
if(testRoot){
 if(!path.isAbsolute(testRoot))throw new Error('FLOWCAST_TEST_DIR must be absolute');
 app.setPath('userData',path.join(testRoot,'data'));
}
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
if(!app.requestSingleInstanceLock()){
 app.quit();
}else{
 app.on('second-instance',()=>{if(window&&!window.isDestroyed()){window.restore();window.focus();}});
 app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);
  const recordingDir=testRoot?path.join(testRoot,'recordings'):path.join(app.getPath('videos'),'FlowCast');
  try{
   const {startStudio}=await import(pathToFileURL(path.join(__dirname,'../server.mjs')).href);
   server=await startStudio({port:testRoot?0:4310,tlsPort:testRoot?0:4311,dataDir:app.getPath('userData'),recordingDir});
  }catch(error){dialog.showErrorBox('FlowCast 无法启动','请检查网络监听权限与保存目录。\n'+error.message);app.quit();return;}
  const origin='http://127.0.0.1:'+server.address().port;
  window=new BrowserWindow({show:false,width:1460,height:1050,minWidth:960,minHeight:700,backgroundColor:'#101216',title:'FlowCast',icon:path.join(__dirname,'../public/assets/flowcast.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.once('ready-to-show',()=>{if(!testRoot)window.show();});
  const lifecycle=installLifecycle({app,window,server,powerSaveBlocker,dialog});
  function trusted(event){if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||new URL(event.senderFrame.url).origin!==origin)throw new Error('Untrusted sender');}
  ipcMain.handle('capture:sources',async event=>{trusted(event);return(await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:320,height:180}})).filter(x=>x.name!=='FlowCast').map(x=>({id:x.id,name:x.name,thumbnail:x.thumbnail.toDataURL()}));});
  ipcMain.handle('capture:select',(event,id)=>{trusted(event);if(typeof id!=='string'||id.length>200)throw new Error('Invalid source');selected=id;});
  ipcMain.handle('recording:state',(event,value)=>{trusted(event);lifecycle.setRecording(value);});
  ipcMain.handle('recording:folder',event=>{trusted(event);return shell.openPath(recordingDir);});
  const allowed=['media','display-capture','local-network-access','local-network','loopback-network'];
  session.defaultSession.setPermissionCheckHandler((contents,permission,requestOrigin)=>contents===window.webContents&&requestOrigin===origin&&allowed.includes(permission));
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>callback(contents===window.webContents&&contents.getURL().startsWith(origin+'/')&&allowed.includes(permission)));
  session.defaultSession.setDisplayMediaRequestHandler(async(request,callback)=>{try{if(request.securityOrigin!==origin||request.frame!==window.webContents.mainFrame||!selected)return callback({});const id=selected;selected=null;const source=(await desktopCapturer.getSources({types:['screen','window']})).find(x=>x.id===id);if(!source)return callback({});callback({video:source,...(request.audioRequested?{audio:'loopback'}:{})});}catch{callback({});}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/'))event.preventDefault();});
  window.webContents.on('render-process-gone',()=>{selected=null;});
  await window.loadURL(origin);
 }).catch(async error=>{dialog.showErrorBox('FlowCast',error.message);await server?.shutdown();app.quit();});
}
