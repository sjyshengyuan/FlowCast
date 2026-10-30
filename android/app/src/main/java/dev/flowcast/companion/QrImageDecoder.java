package dev.flowcast.companion;

import com.google.zxing.*;
import com.google.zxing.common.*;
import com.google.zxing.qrcode.QRCodeReader;
import java.util.*;

/** Shared, bounded image decoder; Android image loading stays outside this class. */
final class QrImageDecoder {
 static String decode(int width,int height,int[] pixels){
  if(width<=0||height<=0||(long)width*height>4000000||pixels==null||(long)width*height!=pixels.length)
   throw new IllegalArgumentException("Invalid image dimensions");
  // Flatten transparency on white, as a QR image is displayed on the workstation.
  int[] opaque=new int[pixels.length];
  for(int i=0;i<pixels.length;i++){int pixel=pixels[i],alpha=pixel>>>24;
   int red=((pixel>>>16&255)*alpha+255*(255-alpha))/255;
   int green=((pixel>>>8&255)*alpha+255*(255-alpha))/255;
   int blue=((pixel&255)*alpha+255*(255-alpha))/255;
   opaque[i]=0xff000000|red<<16|green<<8|blue;
  }
  LuminanceSource source=new RGBLuminanceSource(width,height,opaque);
  Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);hints.put(DecodeHintType.CHARACTER_SET,"UTF-8");
  for(int polarity=0;polarity<2;polarity++){
   LuminanceSource input=polarity==0?source:source.invert();
   for(int method=0;method<2;method++){
    QRCodeReader reader=new QRCodeReader();
    try{return reader.decode(new BinaryBitmap(method==0?new HybridBinarizer(input):new GlobalHistogramBinarizer(input)),hints).getText();}
    catch(ReaderException ignored){}finally{reader.reset();}
   }
  }
  return null;
 }
}
