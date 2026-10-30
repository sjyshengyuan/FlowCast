import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

export const capability=()=>randomBytes(24).toString('hex');
export const equalToken=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function remoteOrigin(value,{allowLoopback=false}={}){
 const url=new URL(value);
 if(url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('服务地址仅填写 HTTPS 域名与端口');
 if(url.protocol!=='https:'&&!(allowLoopback&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('跨网服务必须使用 HTTPS');
 return url.origin;
}
export function validSignal(message,role){
 if(!message||typeof message!=='object')return false;
 if(message.type==='status')return typeof message.message==='string'&&message.message.length<=300;
 if(role==='desktop'&&message.type==='quality')return ['smooth','balanced','detail'].includes(message.profile);
 if(role==='desktop'&&message.type==='restart')return true;
 if(role==='desktop'&&message.type==='studio-away')return true;
 if(!['phoneScreen','phoneCamera'].includes(message.source)||typeof message.session!=='string'||message.session.length<1||message.session.length>80)return false;
 if(message.type==='offer')return role==='phone'&&typeof message.sdp==='string'&&message.sdp.length<=100000;
 if(message.type==='answer')return role==='desktop'&&typeof message.sdp==='string'&&message.sdp.length<=100000;
 if(message.type==='candidate')return typeof message.candidate?.candidate==='string'&&message.candidate.candidate.length<=4096;
 return false;
}
export function iceConfiguration({stunUrls=[],turnUrls=[],turnSecret='',relayOnly=false,ttl=21600}={},identity='peer',now=Date.now()){
 const check=(urls,pattern)=>{if(!Array.isArray(urls)||urls.length>8||urls.some(url=>typeof url!=='string'||url.length>500||!pattern.test(url)))throw Error('无效的 ICE 服务器地址');return urls;};
 check(stunUrls,/^stuns?:[^/\s]+$/);check(turnUrls,/^turns?:[^/\s]+$/);
 if(!Number.isInteger(ttl)||ttl<600||ttl>86400)throw Error('TURN 凭据时效须为 600–86400 秒');
 if(turnUrls.length&&turnSecret.length<32)throw Error('TURN 共享密钥至少 32 字符');
 if(relayOnly&&!turnUrls.length)throw Error('强制中继需要 TURN');
 const iceServers=[];
 if(stunUrls.length)iceServers.push({urls:stunUrls});
 const expiresAt=now+ttl*1000;
 if(turnUrls.length){
  const username=Math.floor(expiresAt/1000)+':'+identity;
  iceServers.push({urls:turnUrls,username,credential:createHmac('sha1',turnSecret).update(username).digest('base64')});
 }
 return {iceServers,iceTransportPolicy:relayOnly?'relay':'all',expiresAt};
}
