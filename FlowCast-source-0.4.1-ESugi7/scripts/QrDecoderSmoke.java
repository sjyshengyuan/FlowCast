package dev.flowcast.companion;

import java.awt.*;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import javax.imageio.ImageIO;
import java.util.Arrays;

/** Exercises the same decoder as Android image import against the actual server PNG. */
public final class QrDecoderSmoke {
 private static int checks=0;
 private static int[] pixels(BufferedImage image){return image.getRGB(0,0,image.getWidth(),image.getHeight(),null,0,image.getWidth());}
 private static void equal(String expected,BufferedImage image,String label){
  String actual=QrImageDecoder.decode(image.getWidth(),image.getHeight(),pixels(image));
  if(!expected.equals(actual))throw new AssertionError(label+" did not decode the original pairing payload");checks++;
 }
 public static void main(String[] args)throws Exception{
  BufferedImage image=ImageIO.read(Path.of(args[0]).toFile());String payload=Files.readString(Path.of(args[1]));
  if(image.getWidth()<400||image.getWidth()!=image.getHeight()||image.getWidth()%8!=0)throw new AssertionError("QR modules must render at integer scale");
  int[] qr=pixels(image);for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++)
   if((x<32||y<32||x>=image.getWidth()-32||y>=image.getHeight()-32)&&(qr[y*image.getWidth()+x]&0xffffff)!=0xffffff)throw new AssertionError("Missing four-module quiet zone");
  checks++;equal(payload,image,"server PNG");
  BufferedImage small=new BufferedImage(240,240,BufferedImage.TYPE_INT_RGB);Graphics2D graphics=small.createGraphics();graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION,RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);graphics.drawImage(image,0,0,240,240,null);graphics.dispose();equal(payload,small,"240px workstation QR");
  BufferedImage rotated=new BufferedImage(image.getHeight(),image.getWidth(),BufferedImage.TYPE_INT_RGB);
  for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++)rotated.setRGB(image.getHeight()-1-y,x,image.getRGB(x,y));equal(payload,rotated,"rotated QR");
  BufferedImage inverted=new BufferedImage(image.getWidth(),image.getHeight(),BufferedImage.TYPE_INT_RGB);
  for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++)inverted.setRGB(x,y,0xff000000|(~image.getRGB(x,y)&0xffffff));equal(payload,inverted,"inverted QR");
  BufferedImage transparent=new BufferedImage(image.getWidth(),image.getHeight(),BufferedImage.TYPE_INT_ARGB);
  for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++)transparent.setRGB(x,y,(image.getRGB(x,y)&0xffffff)==0xffffff?0:0xff000000);equal(payload,transparent,"transparent QR");
  BufferedImage screenshot=new BufferedImage(1440,1100,BufferedImage.TYPE_INT_RGB);graphics=screenshot.createGraphics();graphics.setColor(new Color(16,20,26));graphics.fillRect(0,0,1440,1100);graphics.drawImage(image,920,70,null);graphics.dispose();equal(payload,screenshot,"off-centre screenshot");
  int[] blank=new int[40000];Arrays.fill(blank,0xffffffff);
  if(QrImageDecoder.decode(200,200,blank)!=null)throw new AssertionError("Blank image produced QR");checks++;
  try{QrImageDecoder.decode(3000,3000,new int[1]);throw new AssertionError("Oversized image accepted");}catch(IllegalArgumentException expected){checks++;}
  try{QrImageDecoder.decode(10,10,new int[1]);throw new AssertionError("Mismatched pixels accepted");}catch(IllegalArgumentException expected){checks++;}
  System.out.println("Shared Android QR image decoder: "+checks+" checks passed; live camera still requires a device.");
 }
}
