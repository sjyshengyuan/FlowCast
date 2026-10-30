package dev.flowcast.companion;

import java.net.URI;
import org.json.JSONObject;
import okhttp3.OkHttpClient;
import java.util.concurrent.TimeUnit;

final class ConnectionProfile {
 final String base,room,secret,fingerprint;
 final boolean remote;
 private ConnectionProfile(String base,String room,String secret,String fingerprint,boolean remote){this.base=base;this.room=room;this.secret=secret;this.fingerprint=fingerprint;this.remote=remote;}
 static ConnectionProfile parse(String text)throws Exception{
  if(text==null||text.length()>4096)throw new IllegalArgumentException("配对文本无效");
  JSONObject value=new JSONObject(text);int version=value.getInt("v");boolean remote=version==3&&"remote".equals(value.optString("mode"));
  if(!"flowcast".equals(value.getString("app"))||!(version==2||remote))throw new IllegalArgumentException("请使用 FlowCast 配对二维码或文本");
  String base=value.getString("url");URI uri=new URI(base);
  if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!uri.getPath().isEmpty()||(uri.getPort()==0||uri.getPort()>65535))throw new IllegalArgumentException("服务地址无效");
  String secret=value.getString("secret"),room=remote?value.getString("room"):"",fingerprint=remote?"":value.getString("fingerprint");
  if(!secret.matches("[a-fA-F0-9]{48}")||(remote?!room.matches("[a-f0-9]{48}"):!fingerprint.matches("[a-fA-F0-9]{64}")))throw new IllegalArgumentException("配对信息不完整");
  return new ConnectionProfile(base,room,secret,fingerprint,remote);
 }
 String failureMessage(Throwable error){
  String detail=error.getClass().getSimpleName();
  if(error instanceof javax.net.ssl.SSLException)return (remote?"远程服务证书验证失败，请使用系统信任的 HTTPS 服务。":"电脑证书校验失败，请停止共享并扫描电脑最新二维码。")+"\n本次尝试："+base+"\n"+detail;
  return (remote?"远程服务连接失败，请检查手机网络、服务是否在线以及最新远程配对。":"已识别局域网配对，但电脑无法访问。请让手机与电脑连接同一 Wi-Fi/热点，确认电脑服务正在运行；电脑换网后重新扫码。\n若两端处于不同网络，请先在电脑启用已配置公网服务的跨网连接，再使用远程配对。")+"\n本次尝试："+base+"\n"+detail;
 }
 static OkHttpClient client(boolean remote,String fingerprint)throws Exception{
  if(!remote)return PinnedClient.create(fingerprint);
  return new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).connectTimeout(10,TimeUnit.SECONDS).readTimeout(12,TimeUnit.SECONDS).pingInterval(10,TimeUnit.SECONDS).build();
 }
}
