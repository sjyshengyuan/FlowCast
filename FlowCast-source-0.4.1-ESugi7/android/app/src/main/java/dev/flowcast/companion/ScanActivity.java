package dev.flowcast.companion;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.*;
import android.hardware.Camera;
import android.net.Uri;
import android.os.*;
import android.util.Log;
import android.view.*;
import android.widget.*;
import com.google.zxing.*;
import com.journeyapps.barcodescanner.*;
import com.journeyapps.barcodescanner.camera.*;
import java.io.InputStream;
import java.net.URI;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Keep the entire visible preview decodable, with photo import independent of camera permission. */
public class ScanActivity extends Activity {
 public static final int REQUEST=30;
 public static final String RESULT="flowcast.scan.result";
 private static final int CAMERA_PERMISSION=31,PHOTO=32;
 private BarcodeView preview;
 private TextView message;
 private Button retry,focus,photo;
 private boolean active,completed,failed,continuous=true,picking,importing,destroyed;
 private String decodedPhoto,photoError;
 private final Handler ui=new Handler(Looper.getMainLooper());
 private final ExecutorService images=Executors.newSingleThreadExecutor();
 private final Runnable scanHelp=()->{
  if(active&&!completed&&!failed&&!picking&&!importing)
   message.setText("还没识别到？在电脑点击“放大二维码”，完整保留白边；稍微拉远手机，或切换对焦。也可从图片识别。");
 };

 @Override public void onCreate(Bundle state){
  super.onCreate(state);
  getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  if(state!=null)continuous=state.getBoolean("continuous",true);
  LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setFitsSystemWindows(true);
  int pad=dp(16);root.setPadding(pad,pad,pad,pad);root.setBackgroundColor(Color.rgb(16,20,26));
  message=new TextView(this);message.setTextColor(Color.WHITE);message.setTextSize(16);message.setPadding(0,dp(8),0,dp(12));
  message.setText("将完整二维码和白边放入预览，保持片刻。");root.addView(message);
  FrameLayout frame=new FrameLayout(this);root.addView(frame,new LinearLayout.LayoutParams(-1,0,1));
  LinearLayout actions=new LinearLayout(this);root.addView(actions);
  focus=new Button(this);updateFocusLabel();actions.addView(focus,new LinearLayout.LayoutParams(0,-2,1));
  photo=new Button(this);photo.setText("从图片识别");actions.addView(photo,new LinearLayout.LayoutParams(0,-2,1));
  retry=new Button(this);retry.setText("重试打开相机");retry.setVisibility(View.GONE);root.addView(retry);
  Button back=new Button(this);back.setText("返回");root.addView(back);
  back.setOnClickListener(v->finish());setContentView(root);
  retry.setOnClickListener(v->{failed=false;startCamera();});
  focus.setOnClickListener(v->{
   if(preview==null||!active||importing||picking||completed)return;
   continuous=!continuous;updateFocusLabel();pauseCamera();startCamera();
  });
  photo.setOnClickListener(v->choosePhoto());
  try{
   preview=new BarcodeView(this){
    @Override protected Rect calculateFramingRect(Rect container,Rect surface){
     Rect visible=new Rect(container);if(!visible.intersect(surface))return super.calculateFramingRect(container,surface);
     return visible; // No invisible central-square restriction.
    }
   };
   preview.setUseTextureView(false);
   preview.setPreviewScalingStrategy(new FitCenterStrategy());
   Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);
   preview.setDecoderFactory(new DefaultDecoderFactory(Collections.singletonList(BarcodeFormat.QR_CODE),hints,"UTF-8",2));
   frame.addView(preview,new FrameLayout.LayoutParams(-1,-1));
   preview.addStateListener(new CameraPreview.StateListener(){
    public void previewSized(){}public void previewStopped(){}public void cameraClosed(){}
    public void previewStarted(){
     if(!active||completed||failed||importing||picking)return;
     message.setText("全预览识别中 · 保留二维码四周白边，稍微拉远避免模糊。");
     retry.setVisibility(View.GONE);focus.setEnabled(true);ui.removeCallbacks(scanHelp);ui.postDelayed(scanHelp,8000);
    }
    public void cameraError(Exception error){if(active&&!picking&&!importing)showFailure(error);}
   });
  }catch(RuntimeException|LinkageError error){showFailure(error);}
 }
 private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
 private void updateFocusLabel(){focus.setText(continuous?"对焦：连续 · 点击切换":"对焦：自动 · 点击切换");}
 @Override protected void onSaveInstanceState(Bundle state){super.onSaveInstanceState(state);state.putBoolean("continuous",continuous);}
 @Override protected void onResume(){
  super.onResume();active=true;
  if(decodedPhoto!=null){String text=decodedPhoto;decodedPhoto=null;accept(text);if(completed)return;}
  if(!failed&&!picking&&!importing)startCamera();
  if(photoError!=null){message.setText(photoError);photoError=null;}
 }
 private void startCamera(){
  if(!active||completed||picking||importing||isFinishing())return;
  if(preview==null){message.setText("相机组件无法初始化，可从图片识别二维码。");return;}
  if(checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED){
   requestPermissions(new String[]{Manifest.permission.CAMERA},CAMERA_PERMISSION);return;
  }
  if(preview.getCameraInstance()!=null)return;
  try{
   int count=Camera.getNumberOfCameras();if(count==0)throw new IllegalStateException("设备没有可用摄像头");
   int selected=0;Camera.CameraInfo info=new Camera.CameraInfo();
   for(int i=0;i<count;i++){Camera.getCameraInfo(i,info);if(info.facing==Camera.CameraInfo.CAMERA_FACING_BACK){selected=i;break;}}
   CameraSettings settings=preview.getCameraSettings();settings.setRequestedCameraId(selected);settings.setAutoFocusEnabled(true);settings.setContinuousFocusEnabled(continuous);
   preview.decodeContinuous(new BarcodeCallback(){
    public void barcodeResult(BarcodeResult result){if(active&&!completed&&!failed&&!picking&&!importing)accept(result.getText());}
   });
   focus.setEnabled(false);message.setText("正在打开相机…");preview.resume();
  }catch(RuntimeException|LinkageError error){showFailure(error);}
 }
 private void accept(String text){
  if(text==null||completed||!active)return;
  try{
   ConnectionProfile.parse(text);
  }catch(Exception invalid){message.setText("已识别到其他二维码，请扫描电脑 FlowCast 工作台的配对二维码。");return;}
  completed=true;ui.removeCallbacks(scanHelp);previewPause();
  setResult(RESULT_OK,new Intent().putExtra(RESULT,text));finish();
 }
 private void choosePhoto(){
  if(completed||importing||picking)return;
  picking=true;ui.removeCallbacks(scanHelp);pauseCamera();
  try{startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE),PHOTO);}
  catch(RuntimeException error){picking=false;message.setText("无法打开图片选择器，请返回相机扫码。");if(!failed)startCamera();}
 }
 @Override protected void onActivityResult(int request,int result,Intent data){
  super.onActivityResult(request,result,data);if(request!=PHOTO)return;picking=false;
  if(result!=RESULT_OK||data==null||data.getData()==null)return;
  Uri uri=data.getData();importing=true;photo.setEnabled(false);message.setText("正在识别图片中的二维码…");
  images.execute(()->{
   String text=null,error=null;Bitmap bitmap=null;
   try{
    BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;
    try(InputStream input=getContentResolver().openInputStream(uri)){BitmapFactory.decodeStream(input,null,bounds);}
    if(bounds.outWidth<=0||bounds.outHeight<=0)throw new IllegalArgumentException("无法读取图片");
    BitmapFactory.Options options=new BitmapFactory.Options();options.inSampleSize=1;options.inPreferredConfig=Bitmap.Config.ARGB_8888;
    while(bounds.outWidth/options.inSampleSize>2048||bounds.outHeight/options.inSampleSize>2048
      ||(long)(bounds.outWidth/options.inSampleSize)*(bounds.outHeight/options.inSampleSize)>4000000)options.inSampleSize*=2;
    try(InputStream input=getContentResolver().openInputStream(uri)){bitmap=BitmapFactory.decodeStream(input,null,options);}
    if(bitmap==null)throw new IllegalArgumentException("无法读取图片");
    int[] pixels=new int[bitmap.getWidth()*bitmap.getHeight()];bitmap.getPixels(pixels,0,bitmap.getWidth(),0,0,bitmap.getWidth(),bitmap.getHeight());
    text=QrImageDecoder.decode(bitmap.getWidth(),bitmap.getHeight(),pixels);
    if(text==null)error="图片中未识别到二维码。请选择包含完整二维码及白边的清晰图片，或在电脑放大后重试。";
   }catch(Exception|OutOfMemoryError problem){error="无法识别这张图片，请选择更小、清晰的二维码图片后重试。";}
   finally{if(bitmap!=null)bitmap.recycle();}
   final String decoded=text,problem=error;
   ui.post(()->{
    if(destroyed||isFinishing())return;importing=false;photo.setEnabled(true);
    decodedPhoto=decoded;photoError=problem;
    if(active){if(decodedPhoto!=null){String value=decodedPhoto;decodedPhoto=null;accept(value);}
     if(!completed){if(!failed)startCamera();if(photoError!=null){message.setText(photoError);photoError=null;}}}
   });
  });
 }
 private void previewPause(){if(preview!=null)try{preview.pause();}catch(RuntimeException error){Log.w("FlowCastScan","Camera pause failed",error);}}
 private void pauseCamera(){ui.removeCallbacks(scanHelp);if(preview!=null)try{preview.pauseAndWait();}catch(RuntimeException error){Log.w("FlowCastScan","Camera close failed",error);}}
 private void showFailure(Throwable error){
  if(completed||isFinishing())return;failed=true;ui.removeCallbacks(scanHelp);Log.e("FlowCastScan","Scanner initialization failed",error);previewPause();focus.setEnabled(false);
  message.setText("无法打开相机，请检查相机权限与其他应用占用。也可点击“从图片识别”。\n错误："+error.getClass().getSimpleName());retry.setVisibility(View.VISIBLE);
 }
 @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] grants){
  super.onRequestPermissionsResult(request,permissions,grants);if(request!=CAMERA_PERMISSION)return;
  if(grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED){failed=false;startCamera();}
  else{failed=true;focus.setEnabled(false);message.setText("未获得相机权限。可从图片识别，或在系统设置中允许相机后重试。");retry.setVisibility(View.VISIBLE);}
 }
 @Override protected void onPause(){active=false;pauseCamera();super.onPause();}
 @Override protected void onDestroy(){destroyed=true;ui.removeCallbacksAndMessages(null);images.shutdownNow();super.onDestroy();}
}
