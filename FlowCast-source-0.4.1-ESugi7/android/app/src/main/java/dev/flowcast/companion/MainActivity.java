package dev.flowcast.companion;
import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.os.*;
import android.graphics.Color;
import android.widget.*;


import org.json.JSONObject;
import okhttp3.*;
import java.util.ArrayList;
public class MainActivity extends Activity {
 TextView status,computer,connectionLog,audioInfo;long seenStatus=-1;CheckBox screen,camera,mic;Button connect,scan;String base,token,fingerprint,room;boolean remote;boolean useScreen,useCamera,useMic;final Handler poll=new Handler(Looper.getMainLooper());
 final Runnable update=new Runnable(){public void run(){if(seenStatus!=CaptureService.statusRevision){seenStatus=CaptureService.statusRevision;status.setText(CaptureService.statusText);}if(connectionLog!=null)connectionLog.setText(CaptureService.diagnostics);updateSharingControls();poll.postDelayed(this,1000);}};
 @Override public void onCreate(Bundle state){super.onCreate(state);LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(35,85,35,45);root.setBackgroundColor(Color.rgb(16,20,26));LinearLayout titleRow=new LinearLayout(this);titleRow.setGravity(android.view.Gravity.CENTER_VERTICAL);ImageView mark=new ImageView(this);mark.setImageResource(R.drawable.flowcast_mark);mark.setContentDescription("FlowCast 图标");int iconSize=(int)(58*getResources().getDisplayMetrics().density);titleRow.addView(mark,new LinearLayout.LayoutParams(iconSize,iconSize));TextView title=new TextView(this);title.setText("FlowCast "+BuildConfig.VERSION_NAME);title.setTextSize(27);title.setTextColor(Color.rgb(188,242,120));titleRow.addView(title);root.addView(titleRow);TextView help=new TextView(this);help.setText("同一 Wi-Fi/热点使用局域网二维码。跨网须先配置在线公网服务，再使用远程配对。\n无需数据线，切换画面不会中断电脑录制。\n画质由电脑选择：流畅 / 均衡 / 清晰，30 FPS 目标。");help.setPadding(0,25,0,25);root.addView(help);computer=new TextView(this);root.addView(computer);screen=new CheckBox(this);screen.setText("共享手机屏幕 · 自动适配横竖屏");screen.setChecked(true);root.addView(screen);camera=new CheckBox(this);camera.setText("同时共享前置摄像头");camera.setChecked(true);root.addView(camera);mic=new CheckBox(this);mic.setText("共享手机麦克风");root.addView(mic);audioInfo=new TextView(this);audioInfo.setTextSize(13);audioInfo.setPadding(0,8,0,18);root.addView(audioInfo);mic.setOnCheckedChangeListener((button,checked)->updateSharingControls());scan=new Button(this);scan.setText("扫描电脑二维码");root.addView(scan);Button remotePair=new Button(this);remotePair.setText("粘贴远程配对文本");root.addView(remotePair);remotePair.setOnClickListener(v->pasteRemote());connect=new Button(this);connect.setText("连接已记住的电脑");root.addView(connect);Button reconnect=new Button(this);reconnect.setText("重新连接视频（保留屏幕授权）");root.addView(reconnect);reconnect.setOnClickListener(v->{if(!CaptureService.running){status.setText("共享未运行，请先连接电脑并授权屏幕共享。");return;}startService(new Intent(this,CaptureService.class).setAction("RECONNECT"));});Button stop=new Button(this);stop.setText("停止共享");root.addView(stop);status=new TextView(this);status.setPadding(0,25,0,0);root.addView(status);connectionLog=new TextView(this);connectionLog.setTextSize(12);connectionLog.setTextIsSelectable(true);connectionLog.setPadding(0,20,0,0);root.addView(connectionLog);seenStatus=CaptureService.statusRevision;if(CaptureService.running||seenStatus>0)status.setText(CaptureService.statusText);ScrollView scroll=new ScrollView(this);scroll.addView(root);setContentView(scroll);load();scan.setOnClickListener(v->{if(CaptureService.running){status.setText("请先停止当前共享，再连接其他电脑。");return;}openScanner();});connect.setOnClickListener(v->prepare());stop.setOnClickListener(v->{stopService(new Intent(this,CaptureService.class));status.setText("共享已停止，电脑录制可继续。");});}
 void updateSharingControls(){
  boolean active=CaptureService.running;screen.setEnabled(!active);camera.setEnabled(!active);mic.setEnabled(!active);
  if(active){screen.setChecked(CaptureService.activeScreen);camera.setChecked(CaptureService.activeCamera);mic.setChecked(CaptureService.activeMic);}
  if(audioInfo!=null)audioInfo.setText(active?(CaptureService.activeMic?CaptureService.microphoneStatus+"\n电脑默认不播放手机声音，可在电脑“声音”面板开启监听。":"本次未开启手机麦克风。先停止共享，勾选麦克风后重新开始。"):(mic.isChecked()?"麦克风将在开始共享后启用。电脑预览默认静音，可开启“监听手机声音”。":"录制前可勾选手机麦克风。来源设置在开始共享时生效。"));
 }
 void openScanner(){try{startActivityForResult(new Intent(this,ScanActivity.class),ScanActivity.REQUEST);}catch(RuntimeException error){android.util.Log.e("FlowCastScan","Cannot open scanner",error);status.setText("无法打开扫码页面："+error.getClass().getSimpleName());}}
 void load(){android.content.SharedPreferences prefs=getSharedPreferences("computer",MODE_PRIVATE);base=prefs.getString("base","");token=prefs.getString("token","");fingerprint=prefs.getString("fingerprint","");remote=prefs.getBoolean("remote",false);room=prefs.getString("room","");computer.setText(base.isEmpty()?"尚未连接电脑": (remote?"已记住跨网服务：":"已记住局域网电脑（上次成功）：")+base);connect.setEnabled(!token.isEmpty());}
 @Override protected void onResume(){super.onResume();poll.post(update);}@Override protected void onPause(){poll.removeCallbacks(update);super.onPause();}
 void prepare(){if(CaptureService.running){status.setText("已经在共享。要修改来源，请先停止共享。");return;}useScreen=screen.isChecked();useCamera=camera.isChecked();useMic=mic.isChecked();if(!useScreen&&!useCamera){status.setText("请至少选择一路画面。");return;}ArrayList<String> permissions=new ArrayList<>();if(useCamera&&checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)permissions.add(Manifest.permission.CAMERA);if(useMic&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)permissions.add(Manifest.permission.RECORD_AUDIO);if(!permissions.isEmpty()){requestPermissions(permissions.toArray(new String[0]),10);return;}if(useScreen){MediaProjectionManager manager=getSystemService(MediaProjectionManager.class);startActivityForResult(manager.createScreenCaptureIntent(),20);}else launch(null);}
 @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] grants){super.onRequestPermissionsResult(request,permissions,grants);if(request==11){if(grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED)openScanner();else{status.setText("扫码需要相机权限。请在手机设置中允许 FlowCast 使用相机。");new android.app.AlertDialog.Builder(this).setMessage("请在应用权限中允许相机，然后返回重新扫码。").setPositiveButton("打开设置",(dialog,which)->startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,android.net.Uri.parse("package:"+getPackageName())))).setNegativeButton("取消",null).show();}return;}if(request==10){if(grants.length==0){status.setText("权限申请已取消。");return;}for(int grant:grants)if(grant!=PackageManager.PERMISSION_GRANTED){status.setText("所选来源需要权限。可取消对应选项后重试。");return;}prepare();}}
 @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==ScanActivity.REQUEST){if(result==RESULT_OK&&data!=null&&data.getStringExtra(ScanActivity.RESULT)!=null)pair(data.getStringExtra(ScanActivity.RESULT));else status.setText("已退出扫码，可重新扫描电脑二维码。");return;}if(request==20){if(result==RESULT_OK&&data!=null)launch(data);else status.setText("已取消系统录屏授权。");}}
 void pair(String text){
  if(CaptureService.running){status.setText("请先停止当前共享，再配对其他电脑。");return;}
  try{
   ConnectionProfile connection=ConnectionProfile.parse(text);
   final String nextBase=connection.base;
   OkHttpClient client=ConnectionProfile.client(connection.remote,connection.fingerprint);
   JSONObject body=new JSONObject().put("secret",connection.secret).put("name",Build.MANUFACTURER+" "+Build.MODEL);
   if(connection.remote)body.put("room",connection.room);
   Request request=new Request.Builder().url(nextBase+(connection.remote?"/api/remote/pair":"/api/pair")).post(RequestBody.create(body.toString(),MediaType.get("application/json"))).build();
   status.setText("已识别"+(connection.remote?"跨网":"局域网")+"配对，正在连接…");scan.setEnabled(false);
   client.newCall(request).enqueue(new Callback(){
    public void onFailure(Call call,java.io.IOException error){runOnUiThread(()->{if(isFinishing()||isDestroyed())return;scan.setEnabled(true);status.setText(connection.failureMessage(error));});}
    public void onResponse(Call call,Response response){
     try(response){
      JSONObject result=new JSONObject(response.body().string());if(!response.isSuccessful())throw new Exception(result.optString("error","配对失败"));
      String nextToken=result.getString("token");
      getSharedPreferences("computer",MODE_PRIVATE).edit().putString("base",nextBase).putString("token",nextToken).putString("fingerprint",connection.fingerprint).putBoolean("remote",connection.remote).putString("room",connection.room).apply();
      runOnUiThread(()->{if(isFinishing()||isDestroyed())return;scan.setEnabled(true);load();status.setText("已配对。确认系统授权后即可共享。");prepare();});
     }catch(Exception error){runOnUiThread(()->{if(isFinishing()||isDestroyed())return;scan.setEnabled(true);status.setText(error.getMessage());});}
    }
   });
  }catch(Exception error){status.setText("配对信息无效："+error.getMessage());}
 }
 void pasteRemote(){
  if(CaptureService.running){status.setText("请先停止当前共享，再配对。");return;}
  EditText input=new EditText(this);input.setHint("粘贴电脑工作台的完整远程配对文本");input.setMinLines(4);input.setMaxLines(8);
  new android.app.AlertDialog.Builder(this).setTitle("远程配对").setMessage("电脑与手机不必在同一网络。请使用电脑生成的最新配对文本。").setView(input).setPositiveButton("连接",(dialog,which)->pair(input.getText().toString().trim())).setNegativeButton("取消",null).show();
 }
 void launch(Intent projection){Intent service=new Intent(this,CaptureService.class);service.putExtra("base",base);service.putExtra("token",token);service.putExtra("remote",remote);service.putExtra("room",room);service.putExtra("fingerprint",fingerprint);service.putExtra("screen",useScreen);service.putExtra("camera",useCamera);service.putExtra("mic",useMic);if(projection!=null)service.putExtra("projection",projection);try{startForegroundService(service);status.setText("正在连接，可在电脑查看画面。");}catch(Exception e){status.setText("无法启动共享："+e.getMessage());}}
}
