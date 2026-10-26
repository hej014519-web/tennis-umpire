import {restoreSnapshot,type Command,type MatchConfig,type MatchState} from './umpire-engine';

export const UMPIRE_SYNC_KEY='startline:tennis-umpire:sync:v1';
export type SharedRoom={roomId:string;version:number;match:MatchState;title:string;court:string;updatedAt:number};
export type RoomAccess={roomId:string;editKey?:string;viewKey?:string};
export type SharedInitial={match:MatchState;title:string;court:string};
type LocalView={inverted:boolean;events:{at:number;label:string}[]};
export type PendingRoomWrite={kind:'commands'|'start';roomId:string;requestId:string;expectedVersion:number;body:string;message:string};
export type PendingRoomCreation={createKey:string;requestId:string;body:string};
type DurableSync={schema:1;apiUrl:string;access?:RoomAccess;room?:SharedRoom;pending?:PendingRoomWrite;creation?:PendingRoomCreation;reviewRequired:boolean;view:LocalView};
export type SyncState=DurableSync&{busy:boolean;connected:boolean;lastChecked:number;error:string;externalConflict:boolean;linkBlocked:boolean};
type Store=Pick<Storage,'getItem'|'setItem'>;
type Options={storage:Store;fetcher?:typeof fetch;isOnline?:()=>boolean;now?:()=>number};
const KEY=/^[A-Za-z0-9_-]{43}$/,ID=/^[A-Za-z0-9_-]{22}$/;
const empty=(apiUrl:string):DurableSync=>({schema:1,apiUrl,reviewRequired:false,view:{inverted:false,events:[]}});
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));

export function normalizeSyncApi(value:string):string {
 if(!value.trim())return '';
 const url=new URL(value);
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('同步服务地址须为 HTTPS。');
 return url.href.replace(/\/+$/,'');
}
export function parseRoomLink(value:string):RoomAccess|null {
 const hash=value.includes('#')?value.slice(value.indexOf('#')+1):value.replace(/^#/,''),p=new URLSearchParams(hash),roomId=p.get('room'),editKey=p.get('edit'),viewKey=p.get('view');
 if(!roomId&&!editKey&&!viewKey)return null;
 if(!roomId||!ID.test(roomId)||Boolean(editKey)===Boolean(viewKey)||editKey&&!KEY.test(editKey)||viewKey&&!KEY.test(viewKey))throw Error('共享链接不完整，请重新复制完整的执裁或观赛链接。');
 return {roomId,...(editKey?{editKey}:{viewKey:viewKey!})};
}
export function roomShareLink(base:string,access:RoomAccess,role:'edit'|'view'):string {
 const key=role==='edit'?access.editKey:access.viewKey;
 if(!key)throw Error(role==='edit'?'当前没有执裁链接。':'此设备没有观赛密钥，请向创建比赛的人索取观赛链接。');
 const url=new URL(base);url.hash=new URLSearchParams({room:access.roomId,[role]:key}).toString();return url.href;
}
function roomFrom(value:unknown):SharedRoom {
 const r=value as SharedRoom;
 if(!r||!ID.test(r.roomId)||!Number.isSafeInteger(r.version)||r.version<1||typeof r.title!=='string'||r.title.length>120||typeof r.court!=='string'||r.court.length>60||!Number.isFinite(r.updatedAt))throw Error('同步服务返回了无效比赛，请保留当前页面后重试。');
 return {...r,match:restoreSnapshot(r.match)};
}
function load(storage:Store,apiUrl:string):DurableSync {
 const raw=storage.getItem(UMPIRE_SYNC_KEY);if(!raw)return empty(apiUrl);
 const d=JSON.parse(raw) as DurableSync;
 if(d.schema!==1||typeof d.apiUrl!=='string'||typeof d.reviewRequired!=='boolean'||typeof d.view?.inverted!=='boolean'||!Array.isArray(d.view.events))throw Error('共享记录无法读取。请保留本机记录，勿清除未确认请求。');
 if(d.access&&(!ID.test(d.access.roomId)||!d.access.editKey&&!d.access.viewKey||d.access.editKey&&!KEY.test(d.access.editKey)||d.access.viewKey&&!KEY.test(d.access.viewKey)))throw Error('本机共享密钥格式无效。');
 if(d.room)d.room=roomFrom(d.room);
 if(d.pending&&(!d.access?.editKey||d.pending.roomId!==d.access.roomId||!['commands','start'].includes(d.pending.kind)||typeof d.pending.body!=='string'||JSON.parse(d.pending.body).requestId!==d.pending.requestId))throw Error('未确认操作无法读取，请保留本机记录。');
 if(d.creation&&(!KEY.test(d.creation.createKey)||typeof d.creation.body!=='string'||JSON.parse(d.creation.body).requestId!==d.creation.requestId))throw Error('未确认创建请求无法读取，请保留本机记录。');
 return d;
}
function randomKey():string {return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}

/** Durable outbox: a write is never applied locally, rebased, or given another ID on retry. */
export class UmpireSyncClient {
 private durable:DurableSync;
 private listeners=new Set<(state:SyncState)=>void>();
 private busy=false;private reading=false;private connected=false;private lastChecked=0;private error='';private raw:string|null;private externalConflict=false;private linkBlocked=false;
 private readonly fetcher:typeof fetch;private readonly online:()=>boolean;private readonly now:()=>number;
 readonly apiUrl:string;
 constructor(apiUrl:string,private readonly options:Options){
  this.apiUrl=normalizeSyncApi(apiUrl);this.durable=load(options.storage,this.apiUrl);this.raw=options.storage.getItem(UMPIRE_SYNC_KEY);
  // Browser fetch requires its Window receiver; injected mocks are called as independent functions.
  const injected=options.fetcher;this.fetcher=injected?((input,init)=>injected(input,init)):((input,init)=>globalThis.fetch(input,init));
  this.online=options.isOnline||(()=>typeof navigator==='undefined'||navigator.onLine);this.now=options.now||Date.now;
  if(this.durable.apiUrl!==this.apiUrl&&(this.durable.access||this.durable.creation||this.durable.pending))this.error='同步服务地址已变化，原房间和未确认请求已保留；请先恢复原服务地址。';
 }
 getState():SyncState{return {...this.durable,busy:this.busy,connected:this.connected,lastChecked:this.lastChecked,error:this.error,externalConflict:this.externalConflict,linkBlocked:this.linkBlocked};}
 subscribe(fn:(state:SyncState)=>void):()=>void {this.listeners.add(fn);fn(this.getState());return()=>{this.listeners.delete(fn);};}
 private emit(){for(const fn of this.listeners)fn(this.getState());}
 checkStorage(){if(this.externalConflict||this.options.storage.getItem(UMPIRE_SYNC_KEY)!==this.raw){this.externalConflict=true;this.connected=false;this.error='另一个标签页更新了共享记录。请重新载入页面，核对最新记录后继续。';this.emit();throw Error(this.error);}}
 private save(next:DurableSync){this.checkStorage();try{const raw=JSON.stringify(next);this.options.storage.setItem(UMPIRE_SYNC_KEY,raw);this.raw=raw;this.durable=JSON.parse(raw);}catch{this.error='无法在本机保存同步状态。未确认请求会保留，请释放浏览器存储后重试。';this.emit();throw Error(this.error);}this.emit();}
 private guardNetwork(){this.checkStorage();if(!this.apiUrl)throw Error('同步服务尚未连接，本机计分仍可使用。');if(this.durable.apiUrl!==this.apiUrl)throw Error('同步服务地址已变化，不能向其他服务发送房间密钥。');if(!this.online())throw Error('当前离线，共享计分已锁定。联网后请先确认未完成的操作。');}
 private async request(path:string,init:RequestInit):Promise<{response:Response;data:any}>{
  this.guardNetwork();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{const response=await this.fetcher(this.apiUrl+path,{...init,signal:controller.signal,cache:'no-store',credentials:'omit'});const data=response.status===304?null:await response.json();return{response,data};}finally{clearTimeout(timer);}
 }
 private newest(room:SharedRoom):SharedRoom {if(this.durable.room?.roomId===room.roomId&&this.durable.room.version>room.version)return this.durable.room;return room;}
 attach(access:RoomAccess){
  if(this.busy||this.durable.pending||this.durable.creation)throw Error('有操作尚未确认，请先重试原请求，再切换比赛。');
  if(!ID.test(access.roomId)||!access.editKey&&!access.viewKey||access.editKey&&!KEY.test(access.editKey)||access.viewKey&&!KEY.test(access.viewKey))throw Error('共享链接无效。');
  const previous=this.durable.access,same=previous?.roomId===access.roomId;
  // Opening an explicit view link must not inherit an editor capability from this browser.
  const nextAccess=access.editKey&&same&&previous?.editKey===access.editKey?{...previous,...access}:access;
  this.connected=false;this.error='';this.save({...this.durable,apiUrl:this.apiUrl,access:nextAccess,room:same?this.durable.room:undefined,reviewRequired:same?this.durable.reviewRequired:false});this.linkBlocked=false;this.emit();
 }
 blockLink(){this.linkBlocked=true;this.emit();}
 confirmCurrentLink(){if(this.busy||this.durable.pending||this.durable.creation)throw Error('请先确认原房间的未完成操作。');this.linkBlocked=false;this.emit();}
 async refresh():Promise<boolean>{
  const access=this.durable.access;if(!access||this.reading||this.busy)return false;this.reading=true;
  const token=access.editKey||access.viewKey,cached=this.durable.room?.roomId===access.roomId?this.durable.room:undefined;
  try{const {response,data}=await this.request('/v1/rooms/'+access.roomId,{headers:{Authorization:'Bearer '+token,...(cached?{'If-None-Match':`W/"${cached.roomId}:${cached.version}"`}:{})}});
   if(this.durable.access?.roomId!==access.roomId||(this.durable.access.editKey||this.durable.access.viewKey)!==token)return false;this.checkStorage();
   if(response.status===304){if(!cached)throw Error('同步缓存缺失，请重新连接。');this.connected=true;this.lastChecked=this.now();if(!this.durable.pending&&!this.durable.reviewRequired)this.error='';this.emit();return true;}
   if(!response.ok)throw Error(data?.error||'无法连接共享比赛。');const room=roomFrom(data.room);if(room.roomId!==access.roomId)throw Error('房间响应不匹配。');
   this.connected=true;this.lastChecked=this.now();if(!this.durable.pending&&!this.durable.reviewRequired)this.error='';this.save({...this.durable,room:this.newest(room)});return true;
  }catch(e){this.connected=false;this.error=e instanceof Error?e.message:'同步连接中断。';this.emit();return false;}finally{this.reading=false;}
 }
 async create(initial:SharedInitial):Promise<boolean>{
  if(this.durable.creation)return this.retry();
  if(this.linkBlocked)throw Error('请先确认返回本机比赛或恢复原房间链接。');
  if(this.busy||this.durable.pending||this.durable.access)throw Error('请先处理当前共享比赛，再创建另一场。');
  this.guardNetwork();const requestId=crypto.randomUUID(),creation={createKey:randomKey(),requestId,body:JSON.stringify({requestId,initial:copy(initial)})};
  this.save({...this.durable,apiUrl:this.apiUrl,creation});return this.retry();
 }
 async command(command:Command,message='操作已同步'):Promise<boolean>{return this.queue('commands',{command},message);}
 async start(config:MatchConfig,title:string,court:string):Promise<boolean>{return this.queue('start',{config,title,court},'比赛已开赛并同步。');}
 private async queue(kind:PendingRoomWrite['kind'],payload:object,message:string):Promise<boolean>{
  if(this.busy||this.durable.pending||this.durable.creation)throw Error('上一操作尚未确认，请先重试原请求。');
  this.guardNetwork();const {access,room}=this.durable;
  if(!access?.editKey)throw Error('当前为只读观赛链接，不能执裁。');
  if(this.linkBlocked)throw Error('当前链接尚未核对，请恢复原房间链接或重新加入。');
  if(!this.connected||!room)throw Error('请先连接并核对最新比分。');if(this.durable.reviewRequired)throw Error('请先核对其他设备更新后的比分。');
  const requestId=crypto.randomUUID(),expectedVersion=room.version,pending={kind,roomId:room.roomId,requestId,expectedVersion,body:JSON.stringify({requestId,expectedVersion,...copy(payload)}),message};
  this.save({...this.durable,pending});return this.retry();
 }
 async retry():Promise<boolean>{
  if(this.busy)return false;const creation=this.durable.creation,pending=this.durable.pending;if(!creation&&!pending)return this.refresh();
  this.busy=true;this.error='';this.emit();
  try{
   const path=creation?'/v1/rooms':'/v1/rooms/'+pending!.roomId+'/'+pending!.kind;
   const headers:Record<string,string>={'Content-Type':'application/json',...(creation?{'X-Create-Key':creation.createKey}:{Authorization:'Bearer '+this.durable.access!.editKey})};
   const {response,data}=await this.request(path,{method:'POST',headers,body:(creation||pending)!.body});
   if(!response.ok){
    const message=typeof data?.error==='string'?data.error:'同步服务暂不可用。';
    if(response.status>=500||response.status===408||response.status===429)throw Error(message+' 原请求已保留，请重试确认。');
    let room=this.durable.room;if(response.status===409&&data?.room){const authoritative=roomFrom(data.room);if(authoritative.roomId!==pending?.roomId)throw Error('冲突回执房间不匹配，原请求已保留。');room=this.newest(authoritative);}
    this.error=message+(response.status===409?'；该操作未自动重放，请核对最新比分。':'；操作未执行。');this.connected=response.status!==401&&response.status!==403&&response.status!==404&&(response.status!==409||Boolean(data?.room))&&Boolean(room);this.lastChecked=this.now();
    this.save({...this.durable,creation:undefined,pending:undefined,room,reviewRequired:response.status===409});return false;
   }
   const room=roomFrom(data?.room);let access=this.durable.access;
   if(creation){if(data.roomId!==room.roomId||!KEY.test(data.editKey)||!KEY.test(data.viewKey))throw Error('创建回执不完整，原请求已保留，请重试。');access={roomId:room.roomId,editKey:data.editKey,viewKey:data.viewKey};}
   else if(room.roomId!==pending!.roomId)throw Error('操作回执房间不匹配，原请求已保留。');
   this.connected=true;this.lastChecked=this.now();this.error='';
   this.save({...this.durable,access,room:this.newest(room),creation:undefined,pending:undefined,reviewRequired:false});return true;
  }catch(e){this.connected=false;this.error=(e instanceof Error?e.message:'网络连接中断。')+' 未确认前不会重复计分，请重试原请求。';this.emit();return false;}finally{this.busy=false;this.emit();}
 }
 acknowledgeReview(){if(this.durable.pending||this.durable.creation||!this.connected)throw Error('请先确认未完成请求并连接最新比赛。');this.error='';this.save({...this.durable,reviewRequired:false});}
 setView(inverted:boolean,label:string){this.save({...this.durable,view:{inverted,events:[...this.durable.view.events,{at:this.now(),label}].slice(-500)}});}
 leave(){if(this.busy||this.durable.pending||this.durable.creation)throw Error('尚有未确认操作，请先重试确认后再退出。');this.connected=false;this.error='';this.save({...empty(this.apiUrl),view:this.durable.view});this.linkBlocked=false;this.emit();}
}

/** Used after subscribing, so malformed links cannot create a hidden editor connection. */
export function attachRoomLink(client:UmpireSyncClient,value:string):RoomAccess|null {
 try{const incoming=parseRoomLink(value);if(!incoming)return null;if(!client.apiUrl)throw Error('同步服务尚未连接，此共享链接暂时无法打开。');const saved=client.getState().access,same=saved?.roomId===incoming.roomId&&(incoming.editKey?saved.editKey===incoming.editKey:!saved.editKey&&saved.viewKey===incoming.viewKey);if(!same)client.attach(incoming);else if(client.getState().linkBlocked)client.confirmCurrentLink();return incoming;}catch(e){client.blockLink();throw e;}
}
