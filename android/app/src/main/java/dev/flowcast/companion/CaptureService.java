package dev.flowcast.companion;
import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.projection.MediaProjection;
import android.os.*;
import org.webrtc.*;
import org.webrtc.audio.JavaAudioDeviceModule;
import org.json.JSONObject;
import okhttp3.*;
import java.util.*;

public class CaptureService extends Service {
 public static volatile boolean running=false;public static volatile boolean activeScreen=false,activeCamera=false,activeMic=false;public static volatile String microphoneStatus="麦克风尚未启动";public static volatile String statusText="尚未共享";public static volatile long statusRevision=0;public static volatile String diagnostics="";
 final ArrayDeque<String> history=new ArrayDeque<>();boolean signalReady=false;long connectionAttempt=0;int videoRetry=0;Runnable videoRetryTask;String networkStatus="";
 HandlerThread thread;Handler worker;OkHttpClient client;WebSocket socket;volatile boolean stopping=false;int retry=0;
 EglBase egl;PeerConnectionFactory factory;JavaAudioDeviceModule audioModule;AudioSource audioSource;AudioTrack microphone;PowerManager.WakeLock wake;
 final Map<String,Source> sources=new LinkedHashMap<>();final Map<String,Link> links=new HashMap<>();String base,token,room;boolean useMic,remote;java.util.List<PeerConnection.IceServer> iceServers=new ArrayList<>();boolean relayOnly=false;String iceSignature="";
 MediaProfile profile=MediaProfile.select("balanced");int capturedWidth=0,capturedHeight=0;
 android.hardware.display.DisplayManager displayManager;
 final android.hardware.display.DisplayManager.DisplayListener displayListener=new android.hardware.display.DisplayManager.DisplayListener(){
  public void onDisplayAdded(int id){}public void onDisplayRemoved(int id){}
  public void onDisplayChanged(int id){if(!stopping&&id==android.view.Display.DEFAULT_DISPLAY&&(Build.VERSION.SDK_INT<34||capturedWidth==0)){android.graphics.Point size=displaySize();updateScreenSize(size.x,size.y);}}
 };
 static class Source {VideoCapturer capturer;SurfaceTextureHelper helper;VideoSource source;VideoTrack track;int width,height;}
 static class Link {PeerConnection pc;String session;RtpSender sender;long started=SystemClock.elapsedRealtime();boolean remote=false;String stage="正在创建视频请求";List<IceCandidate> candidates=new ArrayList<>();}
 @Override public void onCreate(){super.onCreate();thread=new HandlerThread("FlowCastRTC");thread.start();worker=new Handler(thread.getLooper());getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("capture","FlowCast 共享",NotificationManager.IMPORTANCE_LOW));}
 Notification notification(String text){PendingIntent stop=PendingIntent.getService(this,0,new Intent(this,CaptureService.class).setAction("STOP"),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);PendingIntent open=PendingIntent.getActivity(this,1,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);return new Notification.Builder(this,"capture").setContentTitle("FlowCast · 正在共享").setContentText(text).setContentIntent(open).setSmallIcon(R.drawable.ic_notification).setOngoing(true).addAction(new Notification.Action.Builder(null,"停止共享",stop).build()).build();}
 void localStatus(String text){statusText=text;statusRevision++;String time=new java.text.SimpleDateFormat("HH:mm:ss",java.util.Locale.ROOT).format(new Date());history.addLast(time+" "+text);while(history.size()>30)history.removeFirst();diagnostics=String.join("\n",history);android.util.Log.i("FlowCastConnection",text);if(!stopping)try{getSystemService(NotificationManager.class).notify(1,notification(text));}catch(SecurityException ignored){}}
 void report(String text){if(worker==null)return;if(Looper.myLooper()!=worker.getLooper()){worker.post(()->report(text));return;}if(stopping)return;localStatus(text);if(signalReady&&socket!=null)try{socket.send(new JSONObject().put("type","status").put("message",text.substring(0,Math.min(300,text.length()))).toString());}catch(Exception ignored){}}
 void micFailure(String error){microphoneStatus=error+"；请检查麦克风权限、系统麦克风开关及其他录音应用";report(microphoneStatus);}
 String failure(Throwable error){String text=error.getMessage();return error.getClass().getSimpleName()+(text==null?"":": "+text.substring(0,Math.min(180,text.length())));}
 @Override public int onStartCommand(Intent intent,int flags,int startId){if(intent==null||"STOP".equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}if("RECONNECT".equals(intent.getAction())){if(running)worker.post(()->{if(stopping)return;connectionAttempt++;signalReady=false;if(socket!=null)socket.cancel();socket=null;clearLinks();retry=0;videoRetry=0;connect();});else stopSelf();return START_NOT_STICKY;}if(running)return START_NOT_STICKY;
 boolean screen=intent.getBooleanExtra("screen",false),camera=intent.getBooleanExtra("camera",false);useMic=intent.getBooleanExtra("mic",false);activeMic=useMic;activeScreen=screen;activeCamera=camera;microphoneStatus=useMic?"等待麦克风采集启动":"本次未启用手机麦克风";base=intent.getStringExtra("base");token=intent.getStringExtra("token");remote=intent.getBooleanExtra("remote",false);room=intent.getStringExtra("room");int type=0;if(screen)type|=ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;if(Build.VERSION.SDK_INT>=30){if(camera)type|=ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;if(useMic)type|=ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;}
 try{if(Build.VERSION.SDK_INT>=29)startForeground(1,notification("正在连接电脑"),type);else startForeground(1,notification("正在连接电脑"));running=true;wake=getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"FlowCast:Capture");wake.acquire(4*60*60*1000L);}
 catch(Exception e){statusText="无法启动共享："+e.getMessage();statusRevision++;stopSelf();return START_NOT_STICKY;}
 worker.post(()->{try{client=ConnectionProfile.client(remote,intent.getStringExtra("fingerprint"));PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions());egl=EglBase.create();audioModule=JavaAudioDeviceModule.builder(this)
 .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback(){
  public void onWebRtcAudioRecordInitError(String error){micFailure("麦克风初始化失败："+error);}
  public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode code,String error){micFailure("麦克风启动失败："+error);}
  public void onWebRtcAudioRecordError(String error){micFailure("麦克风采集错误："+error);}
 })
 .setAudioRecordStateCallback(new JavaAudioDeviceModule.AudioRecordStateCallback(){
  public void onWebRtcAudioRecordStart(){microphoneStatus="手机麦克风采集已启动；请在电脑查看电平确认收到声音";report(microphoneStatus);}
  public void onWebRtcAudioRecordStop(){microphoneStatus="手机麦克风采集已停止";report(microphoneStatus);}
 }).createAudioDeviceModule();factory=PeerConnectionFactory.builder().setOptions(networkOptions()).setAudioDeviceModule(audioModule).setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(),true,true)).setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext())).createPeerConnectionFactory();if(useMic){audioSource=factory.createAudioSource(new MediaConstraints());microphone=factory.createAudioTrack("phoneMicrophone",audioSource);microphone.setEnabled(true);}if(screen){startScreen(intent.getParcelableExtra("projection"));}if(camera){Camera2Enumerator enumerator=new Camera2Enumerator(this);String front=null;for(String name:enumerator.getDeviceNames())if(enumerator.isFrontFacing(name)){front=name;break;}if(front==null)throw new Exception("没有可用的前置摄像头");CameraVideoCapturer capturer=enumerator.createCapturer(front,new CameraVideoCapturer.CameraEventsHandler(){public void onCameraError(String error){report("摄像头错误："+error);}public void onCameraDisconnected(){report("摄像头已断开");}public void onCameraFreezed(String error){report("摄像头暂停："+error);}public void onCameraOpening(String name){}public void onFirstFrameAvailable(){}public void onCameraClosed(){}});addSource("phoneCamera",capturer,profile.cameraWidth,profile.cameraHeight);}connect();}catch(Exception e){report("共享启动失败："+e.getMessage());stopSelf();}});return START_NOT_STICKY;}
 // Android ConnectivityManager can omit a tethering interface even though local signaling uses it.
 PeerConnectionFactory.Options networkOptions(){
  PeerConnectionFactory.Options options=new PeerConnectionFactory.Options();if(remote)return options;
  try{java.net.URI uri=java.net.URI.create(base);java.net.InetAddress target=java.net.InetAddress.getByName(uri.getHost());java.net.InetAddress local;
   try(java.net.DatagramSocket probe=new java.net.DatagramSocket()){probe.connect(target,uri.getPort()>0?uri.getPort():443);local=probe.getLocalAddress();}
   if(local.isAnyLocalAddress()||local.isLoopbackAddress())return options;
   android.net.ConnectivityManager manager=getSystemService(android.net.ConnectivityManager.class);boolean managed=false;
   for(android.net.Network network:manager.getAllNetworks()){android.net.LinkProperties properties=manager.getLinkProperties(network);if(properties!=null)for(android.net.LinkAddress address:properties.getLinkAddresses())if(address.getAddress().equals(local))managed=true;}
   if(!managed){options.disableNetworkMonitor=true;networkStatus="检测到共享热点/本地接口，使用系统网卡建立视频："+local.getHostAddress();}else networkStatus="视频使用已识别的局域网接口："+local.getHostAddress();report(networkStatus);
  }catch(Exception error){report("网络接口检查失败，使用默认连接："+failure(error));}
  return options;
 }
 android.graphics.Point displaySize(){android.graphics.Point size=new android.graphics.Point(720,1280);android.hardware.display.DisplayManager manager=getSystemService(android.hardware.display.DisplayManager.class);android.view.Display display=manager.getDisplay(android.view.Display.DEFAULT_DISPLAY);if(display!=null)display.getRealSize(size);return size;}
 void startScreen(Intent permission)throws Exception{
  android.graphics.Point size=displaySize();int[] dimensions=profile.screenSize(size.x,size.y);
  addSource("phoneScreen",new ScreenCapturerAndroid(permission,new MediaProjection.Callback(){
   @Override public void onStop(){report("系统已停止屏幕共享，请重新确认授权");if(!stopping)stopSelf();}
   @Override public void onCapturedContentResize(int width,int height){if(worker!=null)worker.post(()->{if(!stopping)updateScreenSize(width,height);});}
  }),dimensions[0],dimensions[1]);
  displayManager=getSystemService(android.hardware.display.DisplayManager.class);displayManager.registerDisplayListener(displayListener,worker);
 }
 void updateScreenSize(int width,int height){if(width<=0||height<=0)return;capturedWidth=width;capturedHeight=height;Source screen=sources.get("phoneScreen");if(screen==null)return;int[] dimensions=profile.screenSize(width,height);if(screen.width==dimensions[0]&&screen.height==dimensions[1])return;try{screen.capturer.changeCaptureFormat(dimensions[0],dimensions[1],30);screen.width=dimensions[0];screen.height=dimensions[1];report("屏幕尺寸已适配："+screen.width+" × "+screen.height);}catch(Exception error){report("调整屏幕尺寸失败："+failure(error));}}
 void applyQuality(String name){
  if(!Arrays.asList("smooth","balanced","detail").contains(name))return;profile=MediaProfile.select(name);
  Source screen=sources.get("phoneScreen");if(screen!=null){android.graphics.Point size=displaySize();updateScreenSize(capturedWidth>0?capturedWidth:size.x,capturedHeight>0?capturedHeight:size.y);}
  Source camera=sources.get("phoneCamera");if(camera!=null&&(camera.width!=profile.cameraWidth||camera.height!=profile.cameraHeight)){try{camera.capturer.changeCaptureFormat(profile.cameraWidth,profile.cameraHeight,30);camera.width=profile.cameraWidth;camera.height=profile.cameraHeight;}catch(Exception error){report("调整摄像头画质失败："+failure(error));}}
  for(Map.Entry<String,Link> entry:links.entrySet())configureSender(entry.getKey(),entry.getValue());
  report("画质档位："+(name.equals("smooth")?"流畅优先":name.equals("detail")?"清晰优先":"均衡"));
 }
 void configureSender(String key,Link link){if(link.sender==null)return;try{RtpParameters parameters=link.sender.getParameters();parameters.degradationPreference=profile.name.equals("smooth")?RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE:RtpParameters.DegradationPreference.BALANCED;for(RtpParameters.Encoding encoding:parameters.encodings){encoding.maxBitrateBps=key.equals("phoneScreen")?profile.screenBitrate:profile.cameraBitrate;encoding.maxFramerate=30;}if(!link.sender.setParameters(parameters))report(label(key)+"：编码器未接受画质参数，保留当前参数");}catch(Exception error){report(label(key)+"：更新画质失败："+failure(error));}}
 void addSource(String key,VideoCapturer capturer,int width,int height)throws Exception{Source item=new Source();sources.put(key,item);item.capturer=capturer;item.width=width;item.height=height;item.helper=SurfaceTextureHelper.create(key,egl.getEglBaseContext());item.source=factory.createVideoSource(capturer.isScreencast());capturer.initialize(item.helper,this,item.source.getCapturerObserver());capturer.startCapture(width,height,30);item.track=factory.createVideoTrack(key,item.source);}
 void connect(){
  if(stopping)return;signalReady=false;final long attempt=++connectionAttempt;report("正在连接电脑："+base);
  Request request=new Request.Builder().url(base.replaceFirst("https:","wss:")+"/signal/phone").header("X-Phone-Token",token).header("X-FlowCast-Room",remote?room:"").build();
  socket=client.newWebSocket(request,new WebSocketListener(){
   @Override public void onOpen(WebSocket ws,Response response){worker.post(()->{if(ws!=socket||stopping||attempt!=connectionAttempt)return;report("信令已连接，等待电脑握手确认");});}
   @Override public void onMessage(WebSocket ws,String text){worker.post(()->{if(ws!=socket||stopping||attempt!=connectionAttempt)return;try{receive(new JSONObject(text));}catch(Exception e){report("视频协商失败："+failure(e));}});}
   @Override public void onClosing(WebSocket ws,int code,String reason){ws.close(code,reason);}
   @Override public void onClosed(WebSocket ws,int code,String reason){worker.post(()->{if(ws!=socket||stopping||attempt!=connectionAttempt)return;signalReady=false;if(code==4001||code==4002){report(code==4001?"配对已撤销，请重新扫描电脑二维码":"连接已被另一个手机会话替代，请重新连接");stopSelf();}else reconnect(ws,"连接关闭（"+code+"）");});}
   @Override public void onFailure(WebSocket ws,Throwable error,Response response){worker.post(()->{if(ws!=socket||stopping||attempt!=connectionAttempt)return;signalReady=false;if(response!=null&&response.code()==401){report("配对凭据无效，请返回应用重新扫描电脑二维码");stopSelf();}else reconnect(ws,failure(error));});}
  });
  final WebSocket pending=socket;worker.postDelayed(()->{if(stopping||attempt!=connectionAttempt||socket!=pending||signalReady)return;reconnect(pending,"电脑连接或握手超时，请核对二维码地址与电脑服务");},12000);
 }
 void reconnect(WebSocket previous,String reason){if(stopping||socket!=previous)return;signalReady=false;socket=null;previous.cancel();clearLinks();final long attempt=++connectionAttempt;long delay=Math.min(10000,1000L<<Math.min(retry++,3));report(reason+"；"+(delay/1000)+" 秒后重连："+base);worker.postDelayed(()->{if(!stopping&&connectionAttempt==attempt&&socket==null)connect();},delay);}
 void send(JSONObject object){if(socket!=null&&!stopping&&!socket.send(object.toString()))report("信令发送失败，请点击重新连接视频");}
 JSONObject message(String type,String source,String session)throws Exception{return new JSONObject().put("type",type).put("source",source).put("session",session);}
 void receive(JSONObject message)throws Exception{String type=message.optString("type");if(type.equals("rtc-config")){configureIce(message.getJSONObject("config"));return;}if(type.equals("quality")){applyQuality(message.optString("profile"));return;}if(type.equals("ready")){if(remote)configureIce(message.getJSONObject("config"));signalReady=true;retry=0;videoRetry=0;if(!networkStatus.isEmpty())report(networkStatus);if(message.optBoolean("desktop")){report("电脑握手成功，正在创建视频请求");restart();}else report("电脑服务已连接，但工作台未打开；请打开电脑终端显示的网址");return;}if(type.equals("status")){String text=message.optString("message","");localStatus("电脑："+text.substring(0,Math.min(300,text.length())));return;}if(type.equals("restart")){videoRetry=0;restart();return;}if(type.equals("studio-away")){clearLinks();report("等待电脑工作台重新打开");return;}String key=message.optString("source");Link link=links.get(key);if(link==null||!link.session.equals(message.optString("session")))return;if(type.equals("answer")){link.stage="收到电脑应答，正在设置视频连接";report(label(key)+"："+link.stage);link.pc.setRemoteDescription(new Sdp(){@Override public void onSetSuccess(){worker.post(()->{if(links.get(key)!=link)return;link.remote=true;configureSender(key,link);link.stage="视频网络连通中";report(label(key)+"：已接受电脑应答，正在连通视频网络");for(IceCandidate candidate:link.candidates)link.pc.addIceCandidate(candidate);link.candidates.clear();});}},new SessionDescription(SessionDescription.Type.ANSWER,message.getString("sdp")));}else if(type.equals("candidate")){JSONObject data=message.getJSONObject("candidate");IceCandidate candidate=new IceCandidate(data.optString("sdpMid"),data.optInt("sdpMLineIndex"),data.getString("candidate"));if(link.remote)link.pc.addIceCandidate(candidate);else if(link.candidates.size()<256)link.candidates.add(candidate);}}
 void configureIce(JSONObject config)throws Exception{
  String signature=config.toString();if(signature.equals(iceSignature))return;
  org.json.JSONArray servers=config.getJSONArray("iceServers");if(servers.length()>8)throw new IllegalArgumentException("ICE 配置过大");
  List<PeerConnection.IceServer> next=new ArrayList<>();
  for(int i=0;i<servers.length();i++){
   JSONObject server=servers.getJSONObject(i);org.json.JSONArray urls=server.optJSONArray("urls");List<String> addresses=new ArrayList<>();
   if(urls==null)addresses.add(server.getString("urls"));else for(int j=0;j<urls.length();j++)addresses.add(urls.getString(j));
   if(addresses.size()>8)throw new IllegalArgumentException("ICE 地址过多");
   for(String address:addresses)if(!address.matches("^(stun|stuns|turn|turns):[^/\\s]+$"))throw new IllegalArgumentException("ICE 地址无效");
   next.add(PeerConnection.IceServer.builder(addresses).setUsername(server.optString("username","")).setPassword(server.optString("credential","")).createIceServer());
  }
  iceServers=next;relayOnly="relay".equals(config.optString("iceTransportPolicy"));iceSignature=signature;
  for(Link link:links.values())if(!link.pc.setConfiguration(rtcConfiguration()))report("视频网络配置已更新，重新连接视频后生效");
 }
 void restart(){if(stopping||!signalReady)return;clearLinks();for(Map.Entry<String,Source> entry:sources.entrySet())offer(entry.getKey(),entry.getValue());}
 // Only the sender retries; both video sources share one bounded retry timer.
 void retryVideo(){if(stopping||!signalReady||videoRetryTask!=null)return;if(videoRetry>=2){report("视频网络仍未连通，已暂停自动重试；请检查电脑网络后点击重新连接视频");return;}long delay=2000L*(++videoRetry);report("视频网络未连通，"+(delay/1000)+" 秒后重试（"+videoRetry+"/2）");videoRetryTask=()->{videoRetryTask=null;if(!stopping&&signalReady)repairLinks();};worker.postDelayed(videoRetryTask,delay);}
 void repairLinks(){
  for(Map.Entry<String,Source> entry:sources.entrySet()){
   String key=entry.getKey();Link link=links.get(key);if(link!=null){PeerConnection.IceConnectionState state=link.pc.iceConnectionState();boolean expired=SystemClock.elapsedRealtime()-link.started>=20000;if(state!=PeerConnection.IceConnectionState.FAILED&&state!=PeerConnection.IceConnectionState.DISCONNECTED&&!expired)continue;if(state==PeerConnection.IceConnectionState.CONNECTED||state==PeerConnection.IceConnectionState.COMPLETED)continue;links.remove(key);link.pc.close();link.pc.dispose();}
   offer(key,entry.getValue());
  }
 }
 void videoConnected(){if(links.size()!=sources.size())return;for(Link item:links.values()){PeerConnection.IceConnectionState state=item.pc.iceConnectionState();if(state!=PeerConnection.IceConnectionState.CONNECTED&&state!=PeerConnection.IceConnectionState.COMPLETED)return;}videoRetry=0;if(videoRetryTask!=null){worker.removeCallbacks(videoRetryTask);videoRetryTask=null;}}
 String label(String key){return key.equals("phoneScreen")?"手机屏幕":"手机前摄";}
 PeerConnection.RTCConfiguration rtcConfiguration(){PeerConnection.RTCConfiguration config=new PeerConnection.RTCConfiguration(iceServers);config.iceTransportsType=relayOnly?PeerConnection.IceTransportsType.RELAY:PeerConnection.IceTransportsType.ALL;config.sdpSemantics=PeerConnection.SdpSemantics.UNIFIED_PLAN;config.continualGatheringPolicy=PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;return config;}
 void offer(String key,Source source){Link link=new Link();link.session=UUID.randomUUID().toString();PeerConnection.RTCConfiguration config=rtcConfiguration();
 link.pc=factory.createPeerConnection(config,new PeerConnection.Observer(){public void onSignalingChange(PeerConnection.SignalingState state){}public void onIceConnectionChange(PeerConnection.IceConnectionState state){worker.post(()->{if(links.get(key)!=link)return;if(state==PeerConnection.IceConnectionState.CONNECTED||state==PeerConnection.IceConnectionState.COMPLETED){report(label(key)+"：视频网络已连通，正在发送画面");videoConnected();}if(state==PeerConnection.IceConnectionState.DISCONNECTED){report(label(key)+"：视频网络中断，等待恢复");worker.postDelayed(()->{if(!stopping&&links.get(key)==link&&link.pc.iceConnectionState()==PeerConnection.IceConnectionState.DISCONNECTED)retryVideo();},1000);}if(state==PeerConnection.IceConnectionState.FAILED)retryVideo();});}public void onIceConnectionReceivingChange(boolean receiving){}public void onIceGatheringChange(PeerConnection.IceGatheringState state){}public void onIceCandidate(IceCandidate candidate){worker.post(()->{if(links.get(key)!=link)return;try{send(message("candidate",key,link.session).put("candidate",new JSONObject().put("sdpMid",candidate.sdpMid).put("sdpMLineIndex",candidate.sdpMLineIndex).put("candidate",candidate.sdp)));}catch(Exception ignored){}});}public void onIceCandidatesRemoved(IceCandidate[] candidates){}public void onAddStream(MediaStream stream){}public void onRemoveStream(MediaStream stream){}public void onDataChannel(DataChannel channel){}public void onRenegotiationNeeded(){}public void onAddTrack(RtpReceiver receiver,MediaStream[] streams){}});
 if(link.pc==null){report("无法建立视频连接");return;}links.put(key,link);worker.postDelayed(()->{if(stopping||links.get(key)!=link)return;PeerConnection.IceConnectionState state=link.pc.iceConnectionState();if(state!=PeerConnection.IceConnectionState.CONNECTED&&state!=PeerConnection.IceConnectionState.COMPLETED){report(label(key)+"：视频连接超时（"+link.stage+"），将尝试恢复异常通道");retryVideo();}},20000);link.sender=link.pc.addTrack(source.track,Collections.singletonList(key));configureSender(key,link);if(microphone!=null&&(key.equals("phoneScreen")||!sources.containsKey("phoneScreen")))link.pc.addTrack(microphone,Collections.singletonList(key));link.pc.createOffer(new Sdp(){@Override public void onCreateSuccess(SessionDescription description){worker.post(()->{if(links.get(key)!=link)return;link.pc.setLocalDescription(new Sdp(){@Override public void onSetSuccess(){worker.post(()->{if(links.get(key)!=link)return;try{link.stage="视频请求已发送，等待电脑应答";send(message("offer",key,link.session).put("sdp",description.description));report(label(key)+"："+link.stage);}catch(Exception e){report(e.getMessage());}});}},description);});}},new MediaConstraints());}
 class Sdp implements SdpObserver{public void onCreateSuccess(SessionDescription description){}public void onSetSuccess(){}public void onCreateFailure(String error){report("协商失败："+error);}public void onSetFailure(String error){report("协商失败："+error);}}
 void clearLinks(){if(videoRetryTask!=null){worker.removeCallbacks(videoRetryTask);videoRetryTask=null;}for(Link link:links.values()){link.pc.close();link.pc.dispose();}links.clear();}
 @Override public void onDestroy(){stopping=true;running=false;microphoneStatus="共享已停止";signalReady=false;connectionAttempt++;if(socket!=null){socket.cancel();socket=null;}worker.post(()->{if(displayManager!=null){displayManager.unregisterDisplayListener(displayListener);displayManager=null;}clearLinks();for(Source source:sources.values()){try{if(source.capturer!=null){source.capturer.stopCapture();source.capturer.dispose();}}catch(Exception ignored){}if(source.track!=null)source.track.dispose();if(source.source!=null)source.source.dispose();if(source.helper!=null)source.helper.dispose();}sources.clear();if(microphone!=null)microphone.dispose();if(audioSource!=null)audioSource.dispose();if(factory!=null)factory.dispose();if(audioModule!=null)audioModule.release();if(egl!=null)egl.release();if(client!=null){client.dispatcher().executorService().shutdown();client.connectionPool().evictAll();}thread.quitSafely();});if(wake!=null&&wake.isHeld())wake.release();stopForeground(true);super.onDestroy();}
 @Override public IBinder onBind(Intent intent){return null;}
}
