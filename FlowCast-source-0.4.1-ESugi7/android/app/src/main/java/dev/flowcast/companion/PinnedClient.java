package dev.flowcast.companion;
import java.security.MessageDigest;
import java.security.cert.*;
import javax.net.ssl.*;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
final class PinnedClient {
 static OkHttpClient create(String fingerprint) throws Exception {
  if(fingerprint==null||!fingerprint.matches("[a-fA-F0-9]{64}"))throw new IllegalArgumentException("无效的电脑证书，请重新扫码");
  X509TrustManager trust=new X509TrustManager(){public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}public void checkClientTrusted(X509Certificate[] chain,String auth)throws CertificateException{throw new CertificateException("不支持客户端证书");}public void checkServerTrusted(X509Certificate[] chain,String auth)throws CertificateException{try{if(chain.length==0)throw new CertificateException("缺少证书");chain[0].checkValidity();byte[] hash=MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());StringBuilder hex=new StringBuilder();for(byte b:hash)hex.append(String.format("%02x",b));if(!MessageDigest.isEqual(hex.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII),fingerprint.toLowerCase(java.util.Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.US_ASCII)))throw new CertificateException("电脑证书与二维码不匹配");}catch(CertificateException e){throw e;}catch(Exception e){throw new CertificateException(e);}}};
  SSLContext context=SSLContext.getInstance("TLS");context.init(null,new TrustManager[]{trust},null);
  // Identity is verified against the exact certificate SHA-256 obtained by scanning the computer.
  return new OkHttpClient.Builder().sslSocketFactory(context.getSocketFactory(),trust).hostnameVerifier((host,session)->{try{trust.checkServerTrusted(new X509Certificate[]{(X509Certificate)session.getPeerCertificates()[0]},"RSA");return true;}catch(Exception e){return false;}}).connectTimeout(7,TimeUnit.SECONDS).readTimeout(10,TimeUnit.SECONDS).pingInterval(10,TimeUnit.SECONDS).build();
 }
}
