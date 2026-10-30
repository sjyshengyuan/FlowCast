package dev.flowcast.companion;

// Shared capture and encoder policy; dimensions retain the phone's actual aspect ratio.
final class MediaProfile {
 final String name;final int screenLongEdge,cameraWidth,cameraHeight,screenBitrate,cameraBitrate;
 MediaProfile(String name,int edge,int width,int height,int screenBitrate,int cameraBitrate){this.name=name;screenLongEdge=edge;cameraWidth=width;cameraHeight=height;this.screenBitrate=screenBitrate;this.cameraBitrate=cameraBitrate;}
 static MediaProfile select(String name){
  if("smooth".equals(name))return new MediaProfile(name,960,960,540,2200000,1000000);
  if("detail".equals(name))return new MediaProfile(name,1920,1920,1080,8000000,4000000);
  return new MediaProfile("balanced",1280,1280,720,4500000,2500000);
 }
 int[] screenSize(int width,int height){if(width<=0||height<=0){width=720;height=1280;}double scale=Math.min(1.0,(double)screenLongEdge/Math.max(width,height));return new int[]{Math.max(2,((int)Math.round(width*scale))&~1),Math.max(2,((int)Math.round(height*scale))&~1)};}
}
