// Keep native close protection alive until the final upload/processing completes.
function installLifecycle({app,window,server,powerSaveBlocker,dialog}) {
 let recording=false,blocker=null,quitting=false,shutdown=null,warning=null;
 function setRecording(value) {
  if(typeof value!=='boolean')throw new TypeError('Invalid recording state');
  recording=value;
  if(recording&&blocker===null)blocker=powerSaveBlocker.start('prevent-display-sleep');
  if(!recording&&blocker!==null){powerSaveBlocker.stop(blocker);blocker=null;}
 }
 function warn() {
  if(warning)return;
  warning=Promise.resolve(dialog.showMessageBox(window,{type:'info',message:'请先结束录制，再关闭 FlowCast。',buttons:['继续录制']})).finally(()=>{warning=null;});
 }
 function close(event) {if(recording){event.preventDefault();warn();}}
 function stop() {
  if(shutdown)return shutdown;
  setRecording(false);
  shutdown=Promise.resolve().then(()=>server.shutdown()).catch(error=>{
   dialog.showErrorBox('FlowCast 关闭失败','已保存的数据将保留，请下次启动后检查录制列表。\n'+error.message);
  }).finally(()=>{quitting=true;app.quit();});
  return shutdown;
 }
 window.on('close',close);
 window.webContents.on('render-process-gone',()=>{
  setRecording(false);
  dialog.showErrorBox('FlowCast 画面进程已退出','录制已中断。请重新打开工作台，在录制列表恢复已保存的部分。');
 });
 app.on('before-quit',event=>{
  if(quitting)return;
  event.preventDefault();
  if(recording){warn();return;}
  void stop();
 });
 app.on('window-all-closed',()=>{void stop();});
 return {setRecording,stop};
}
module.exports={installLifecycle};
