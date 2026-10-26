import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
const output=await build({stdin:{contents:"export * from './lib/umpire-sync.ts'; export * from './lib/umpire-engine.ts';",resolveDir:new URL('..',import.meta.url).pathname,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const E=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
const API='https://sync.example.test',roomId='a'.repeat(22),editKey='E'.repeat(43),viewKey='V'.repeat(43);
class MemoryStore{data=new Map();fail=false;writes=0;getItem(k){return this.data.get(k)||null;}setItem(k,v){if(this.fail)throw Error('quota');this.writes++;this.data.set(k,v);}}
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function room(version=1){const config=E.defaultDemoConfig();config.penaltyProfile.confirmed=true;let match=E.createMatch(config);match=E.applyCommand(match,{type:'start'},1000);return{roomId,version,match,title:'共享测试',court:'01',updatedAt:1000};}
function options(storage,fetcher,extra={}){return{storage,fetcher,isOnline:()=>true,...extra};}
async function connected(storage,fetcher,extra={}){const client=new E.UmpireSyncClient(API,options(storage,fetcher,extra));client.attach({roomId,editKey,viewKey});assert.equal(await client.refresh(),true);return client;}

test('creation is durable before sending and lost ACK retries identical body and 32-byte create key after reload',async()=>{
 const storage=new MemoryStore(),packets=[];let created;
 const fetcher=async(url,init)=>{assert.equal(url,API+'/v1/rooms');const durable=JSON.parse(storage.getItem(E.UMPIRE_SYNC_KEY));assert.equal(durable.creation.body,init.body);assert.equal(durable.creation.createKey,init.headers['X-Create-Key']);packets.push({body:init.body,key:init.headers['X-Create-Key']});created??={roomId,editKey,viewKey,room:{...room(),match:JSON.parse(init.body).initial.match}};if(packets.length===1)throw Error('ACK lost');return response(created);};
 const client=new E.UmpireSyncClient(API,options(storage,fetcher)),initial={match:room().match,title:'创建时名称',court:'01'};
 assert.equal(await client.create(initial),false);assert.equal(client.getState().access,undefined);assert.match(client.getState().creation.createKey,/^[A-Za-z0-9_-]{43}$/);initial.title='后续改名';
 const reload=new E.UmpireSyncClient(API,options(storage,fetcher));assert.equal(await reload.retry(),true);assert.deepEqual(packets[0],packets[1]);assert.equal(JSON.parse(packets[1].body).initial.title,'创建时名称');assert.equal(reload.getState().creation,undefined);assert.equal(reload.getState().access.editKey,editKey);
});

test('lost command ACK never updates optimistically; reload and polling retain original request ID/version/body',async()=>{
 const storage=new MemoryStore(),packets=[];let current=room();const seen=new Set();
 const fetcher=async(url,init)=>{if(init.method!=='POST')return response({room:current});packets.push(init.body);const p=JSON.parse(init.body);if(!seen.has(p.requestId)){seen.add(p.requestId);current={...current,version:2,match:E.applyCommand(current.match,p.command,2000)};throw Error('lost ACK');}return response({room:current});};
 const client=await connected(storage,fetcher);assert.equal(await client.command({type:'point',sideId:'a'}),false);assert.equal(client.getState().room.match.points.a,0);assert.equal(client.getState().connected,false);assert.ok(client.getState().pending);
 await assert.rejects(()=>client.command({type:'point',sideId:'a'}),/尚未确认/);
 const reload=new E.UmpireSyncClient(API,options(storage,fetcher));assert.equal(await reload.refresh(),true);assert.ok(reload.getState().pending);assert.equal(reload.getState().room.match.points.a,1);assert.equal(await reload.retry(),true);assert.equal(packets[0],packets[1]);assert.equal(JSON.parse(packets[1]).expectedVersion,1);assert.equal(reload.getState().pending,undefined);assert.equal(reload.getState().room.match.points.a,1);assert.equal(seen.size,1);
});

test('409 adopts authoritative score and persists explicit review across same-link attach; no automatic rebase',async()=>{
 const storage=new MemoryStore(),packets=[];let current=room();
 const fetcher=async(url,init)=>{if(init.method!=='POST')return response({room:current});packets.push(JSON.parse(init.body));if(packets.length===1){current={...current,version:2,match:E.applyCommand(current.match,{type:'point',sideId:'b'},2000)};return response({error:'其他裁判已更新',code:'VERSION_CONFLICT',room:current},409);}current={...current,version:3,match:E.applyCommand(current.match,packets.at(-1).command,3000)};return response({room:current});};
 const client=await connected(storage,fetcher);assert.equal(await client.command({type:'point',sideId:'a'}),false);assert.equal(packets.length,1);assert.equal(client.getState().room.match.points.a,0);assert.equal(client.getState().room.match.points.b,1);assert.equal(client.getState().pending,undefined);
 const reload=new E.UmpireSyncClient(API,options(storage,fetcher));reload.attach({roomId,editKey});assert.equal(reload.getState().reviewRequired,true);await reload.refresh();await assert.rejects(()=>reload.command({type:'point',sideId:'a'}),/核对/);reload.acknowledgeReview();assert.equal(await reload.command({type:'point',sideId:'a'}),true);assert.equal(packets[1].expectedVersion,2);assert.notEqual(packets[0].requestId,packets[1].requestId);
});

test('viewer cannot submit command/start, and view link does not inherit or export editor key',async()=>{
 const storage=new MemoryStore();let posts=0;const fetcher=async(url,init)=>{if(init.method==='POST')posts++;return response({room:room()});};
 const client=await connected(storage,fetcher);client.attach(E.parseRoomLink('https://site.test/#room='+roomId+'&view='+viewKey));await client.refresh();assert.equal(client.getState().access.editKey,undefined);
 await assert.rejects(()=>client.command({type:'point',sideId:'a'}),/只读/);await assert.rejects(()=>client.start(room().match.config,'x','y'),/只读/);client.setView(true,'本机旋转');assert.equal(client.getState().view.inverted,true);assert.equal(client.getState().room.match.nearSideId,'a');assert.equal(posts,0);
 const link=E.roomShareLink('https://site.test/path/#room='+roomId+'&edit='+editKey,{roomId,editKey,viewKey},'view');assert.ok(link.includes('view='+viewKey));assert.ok(!link.includes(editKey));assert.ok(!link.includes('edit='));
});

test('offline write and storage failure never send a mutation or show an optimistic point',async()=>{
 const storage=new MemoryStore();let online=true,posts=0;const fetcher=async(url,init)=>{if(init.method==='POST')posts++;return response({room:room()});};
 const client=await connected(storage,fetcher,{isOnline:()=>online});online=false;await assert.rejects(()=>client.command({type:'point',sideId:'a'}),/离线/);assert.equal(client.getState().pending,undefined);online=true;storage.fail=true;await assert.rejects(()=>client.command({type:'point',sideId:'a'}),/保存/);assert.equal(posts,0);assert.equal(client.getState().room.match.points.a,0);
});

test('single-flight writer rejects another action while exact original request is in flight',async()=>{
 const storage=new MemoryStore();let release,posts=0;let current=room();const fetcher=async(url,init)=>{if(init.method!=='POST')return response({room:current});posts++;await new Promise(resolve=>release=resolve);current={...current,version:2,match:E.applyCommand(current.match,JSON.parse(init.body).command,2000)};return response({room:current});};
 const client=await connected(storage,fetcher),first=client.command({type:'point',sideId:'a'});await assert.rejects(()=>client.command({type:'point',sideId:'b'}),/尚未确认/);assert.equal(posts,1);release();assert.equal(await first,true);assert.equal(client.getState().room.match.points.a,1);assert.equal(client.getState().room.match.points.b,0);
});

test('late polling response cannot roll back newer confirmed command or local viewing direction',async()=>{
 const storage=new MemoryStore();let reads=0,resolveRead;const old=room(),updated={...old,version:2,match:E.applyCommand(old.match,{type:'point',sideId:'a'},2000)};
 const fetcher=async(url,init)=>{if(init.method==='POST')return response({room:updated});if(++reads===1)return response({room:old});return new Promise(resolve=>resolveRead=()=>resolve(response({room:old})));};
 const client=await connected(storage,fetcher);client.setView(true,'旋转');const poll=client.refresh();assert.equal(await client.command({type:'point',sideId:'a'}),true);resolveRead();await poll;assert.equal(client.getState().room.version,2);assert.equal(client.getState().room.match.points.a,1);assert.equal(client.getState().view.inverted,true);
});

test('second tab refresh/view updates cannot overwrite first tab durable unacknowledged outbox',async()=>{
 const storage=new MemoryStore();const fetcher=async(url,init)=>{if(init.method==='POST')throw Error('ACK lost');return response({room:room()});};
 const first=await connected(storage,fetcher),second=new E.UmpireSyncClient(API,options(storage,fetcher));assert.equal(await first.command({type:'point',sideId:'a'}),false);const original=storage.getItem(E.UMPIRE_SYNC_KEY);
 assert.equal(await second.refresh(),false);assert.equal(second.getState().externalConflict,true);assert.throws(()=>second.setView(true,'另页旋转'),/标签页/);assert.equal(storage.getItem(E.UMPIRE_SYNC_KEY),original);assert.ok(new E.UmpireSyncClient(API,options(storage,fetcher)).getState().pending);
});

test('successful cloud ACK followed by storage failure preserves pending and recovers without new request',async()=>{
 const storage=new MemoryStore(),packets=[];const current=room(),updated={...current,version:2,match:E.applyCommand(current.match,{type:'point',sideId:'a'},2000)};
 const fetcher=async(url,init)=>{if(init.method!=='POST')return response({room:current});packets.push(init.body);if(packets.length===1)storage.fail=true;return response({room:updated});};
 const client=await connected(storage,fetcher);assert.equal(await client.command({type:'point',sideId:'a'}),false);assert.ok(client.getState().pending);assert.equal(client.getState().room.match.points.a,0);storage.fail=false;const reload=new E.UmpireSyncClient(API,options(storage,fetcher));assert.equal(await reload.retry(),true);assert.equal(packets[0],packets[1]);assert.equal(reload.getState().room.match.points.a,1);
});

test('5xx keeps full outbox and different target room cannot replace unconfirmed action',async()=>{
 const storage=new MemoryStore();const fetcher=async(url,init)=>init.method==='POST'?response({error:'服务暂不可用'},503):response({room:room()});const client=await connected(storage,fetcher);
 assert.equal(await client.command({type:'switchEnds'}),false);const before=storage.getItem(E.UMPIRE_SYNC_KEY);assert.throws(()=>client.attach({roomId:'b'.repeat(22),viewKey}),/尚未确认/);assert.equal(storage.getItem(E.UMPIRE_SYNC_KEY),before);assert.equal(client.getState().room.match.nearSideId,'a');
});

test('capability never goes to a changed API origin, and malformed or dual-role links are rejected',async()=>{
 const storage=new MemoryStore();const client=await connected(storage,async()=>response({room:room()}));let calls=0;const moved=new E.UmpireSyncClient('https://other.example.test',options(storage,async()=>{calls++;return response({room:room()});}));assert.equal(await moved.refresh(),false);assert.equal(calls,0);assert.match(moved.getState().error,/地址已变化/);
 assert.throws(()=>E.parseRoomLink('#room='+roomId+'&edit='+editKey+'&view='+viewKey),/不完整/);assert.throws(()=>E.parseRoomLink('#room=invalid&view='+viewKey),/不完整/);assert.equal(client.getState().access.editKey,editKey);
});

test('ETag uses verified room version; 304 refreshes connection without rewriting full cached match',async()=>{
 const storage=new MemoryStore();let count=0,now=1000;const headers=[];
 const fetcher=async(url,init)=>{headers.push(init.headers);if(++count===1)return response({room:room()});return new Response(null,{status:304});};
 const client=await connected(storage,fetcher,{now:()=>now});assert.equal(headers[0]['If-None-Match'],undefined);const writes=storage.writes,raw=storage.getItem(E.UMPIRE_SYNC_KEY);now=3000;assert.equal(await client.refresh(),true);assert.equal(headers[1]['If-None-Match'],'W/"'+roomId+':1"');assert.equal(client.getState().lastChecked,3000);assert.equal(client.getState().connected,true);assert.equal(storage.writes,writes);assert.equal(storage.getItem(E.UMPIRE_SYNC_KEY),raw);
});

test('304 after lost ACK cannot clear pending, and permission change discards old polling response',async()=>{
 const storage=new MemoryStore();let get=0,resolveRead;const fetcher=async(url,init)=>{if(init.method==='POST')throw Error('ACK lost');get++;if(get===1)return response({room:room()});if(get===2)return new Response(null,{status:304});return new Promise(resolve=>resolveRead=()=>resolve(response({room:room()})));};
 const client=await connected(storage,fetcher);await client.command({type:'point',sideId:'a'});const packet=client.getState().pending.body;assert.equal(await client.refresh(),true);assert.equal(client.getState().pending.body,packet);
 const otherStore=new MemoryStore(),viewClient=await connected(otherStore,async()=>response({room:room()}));let late;const alt=new E.UmpireSyncClient(API,options(otherStore,()=>new Promise(resolve=>late=resolve)));const reading=alt.refresh();alt.attach({roomId,viewKey});late(response({room:room()}));assert.equal(await reading,false);assert.equal(alt.getState().connected,false);assert.equal(alt.getState().access.editKey,undefined);assert.ok(viewClient);
});

test('same hash restart preserves conflict review; malformed hash always notifies subscribed state and blocks hidden editor',async()=>{
 const storage=new MemoryStore();let posts=0;const initial=room(),newer={...initial,version:2,match:E.applyCommand(initial.match,{type:'point',sideId:'b'},2000)};
 const fetcher=async(url,init)=>{if(init.method==='POST'){posts++;return response({error:'冲突',code:'VERSION_CONFLICT',room:newer},409);}return response({room:initial});};
 const first=await connected(storage,fetcher);await first.command({type:'point',sideId:'a'});const reload=new E.UmpireSyncClient(API,options(storage,fetcher)),observed=[];reload.subscribe(state=>observed.push(state));E.attachRoomLink(reload,'#room='+roomId+'&edit='+editKey);assert.equal(reload.getState().reviewRequired,true);
 assert.throws(()=>E.attachRoomLink(reload,'#room=broken&edit=truncated'),/不完整/);assert.equal(observed.at(-1).linkBlocked,true);await reload.refresh();await assert.rejects(()=>reload.command({type:'point',sideId:'a'}),/链接尚未核对/);assert.equal(posts,1);reload.confirmCurrentLink();assert.equal(reload.getState().linkBlocked,false);assert.equal(reload.getState().reviewRequired,true);
});

test('new viewer hash cannot silently restore pending old editor; resolving old request still requires explicit room choice',async()=>{
 const storage=new MemoryStore();let fail=true,posts=0;const current=room(),updated={...current,version:2,match:E.applyCommand(current.match,{type:'point',sideId:'a'},2000)};
 const fetcher=async(url,init)=>{if(init.method==='POST'){posts++;if(fail)throw Error('ACK lost');return response({room:updated});}return response({room:current});};
 const client=await connected(storage,fetcher);await client.command({type:'point',sideId:'a'});assert.throws(()=>E.attachRoomLink(client,'#room='+'b'.repeat(22)+'&view='+viewKey),/尚未确认/);assert.equal(client.getState().linkBlocked,true);fail=false;assert.equal(await client.retry(),true);await assert.rejects(()=>client.command({type:'point',sideId:'a'}),/链接尚未核对/);assert.equal(posts,2);E.attachRoomLink(client,'#room='+roomId+'&edit='+editKey);assert.equal(client.getState().linkBlocked,false);
});

test('fresh browser invalid hash can explicitly return local and then create a writable shared room',async()=>{
 const storage=new MemoryStore();let posts=0;const fetcher=async(url,init)=>{posts++;if(url.endsWith('/v1/rooms'))return response({roomId,editKey,viewKey,room:room()},201);return response({room:{...room(),version:2,match:E.applyCommand(room().match,JSON.parse(init.body).command,2000)}});};
 const client=new E.UmpireSyncClient(API,options(storage,fetcher));assert.throws(()=>E.attachRoomLink(client,'#room=broken&view=truncated'),/不完整/);assert.equal(client.getState().linkBlocked,true);await assert.rejects(()=>client.create({match:room().match,title:'本机','court':'01'}),/确认返回/);assert.equal(posts,0);client.confirmCurrentLink();assert.equal(await client.create({match:room().match,title:'本机',court:'01'}),true);assert.equal(client.getState().linkBlocked,false);assert.equal(await client.command({type:'point',sideId:'a'}),true);assert.equal(posts,2);
});

test('default browser fetch retains global receiver and injected fetch remains an independent function',async()=>{
 const original=globalThis.fetch,storage=new MemoryStore();let calls=0;
 try{
  globalThis.fetch=function(url,init){assert.equal(this,globalThis,'browser fetch must receive Window/globalThis');calls++;assert.equal(url,API+'/v1/rooms');assert.equal(init.method,'POST');return Promise.resolve(response({roomId,editKey,viewKey,room:room()},201));};
  const client=new E.UmpireSyncClient(API,{storage,isOnline:()=>true});assert.equal(await client.create({match:room().match,title:'默认请求','court':'01'}),true);assert.equal(calls,1);assert.equal(client.getState().creation,undefined);
 }finally{globalThis.fetch=original;}
 const injected=new E.UmpireSyncClient(API,{storage:new MemoryStore(),isOnline:()=>true,fetcher:function(){assert.equal(this,undefined,'injected function must not receive client/options as receiver');return Promise.resolve(response({roomId,editKey,viewKey,room:room()},201));}});assert.equal(await injected.create({match:room().match,title:'注入请求',court:'01'}),true);
});
