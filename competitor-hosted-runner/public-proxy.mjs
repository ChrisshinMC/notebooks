import http from 'node:http';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
const blocked=new net.BlockList();
for(const [ip,bits]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(ip,bits);
export const publicIPv4=ip=>net.isIP(ip)===4&&!blocked.check(ip,'ipv4');
export async function resolvePublic(host,resolver=lookup){
 const answers=await resolver(host,{all:true,verbatim:true});
 // IPv6-only hosts intentionally unsupported; private and mixed answers fail closed.
 if(!answers.length||answers.some(a=>a.family===4&&!publicIPv4(a.address)))throw Error('Non-public destination');
 const answer=answers.find(a=>a.family===4&&publicIPv4(a.address));if(!answer)throw Error('No public IPv4 destination');return answer.address;
}
function target(raw,connect=false){const url=new URL(connect?'http://'+raw:raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid target');const port=Number(url.port||(connect?443:80));if(![80,443].includes(port))throw Error('Port not permitted');return {url,port};}
export function createPublicProxy({resolver=lookup}={}){
 const server=http.createServer(async(req,res)=>{try{
  const {url,port}=target(req.url);if(url.protocol!=='http:')throw Error('Use CONNECT for TLS');const address=await resolvePublic(url.hostname,resolver);
  const headers={...req.headers,host:url.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];
  const upstream=http.request({host:address,port,method:req.method,path:url.pathname+url.search,headers,timeout:30000},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
 }catch{res.writeHead(403);res.end('Destination denied');}});
 server.on('connect',async(req,client,head)=>{try{const {url,port}=target(req.url,true);const address=await resolvePublic(url.hostname.replace(/^\[|\]$/g,''),resolver);const upstream=net.connect({host:address,port});upstream.setTimeout(60000,()=>upstream.destroy());upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());}catch{client.end('HTTP/1.1 403 Forbidden\r\n\r\n');}});
 server.headersTimeout=15000;server.requestTimeout=30000;return server;
}
