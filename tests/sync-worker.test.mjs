import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const root = new URL('../', import.meta.url);
const bundle = async path => (await build({entryPoints: [new URL(path, root).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, target: 'es2022'})).outputFiles[0].text;
const engine = await import('data:text/javascript;base64,' + Buffer.from(await bundle('lib/umpire-engine.ts')).toString('base64'));
const mf = new Miniflare({modules: true, script: await bundle('sync-worker/src/index.ts'), compatibilityDate: '2026-05-22', d1Databases: {DB: 'umpire-sync-isolated-tests'}, bindings: {ALLOWED_ORIGINS: 'https://hej014519-web.github.io,http://127.0.0.1:5173'}});
after(() => mf.dispose());
const DB = await mf.getD1Database('DB');
const sql = await readFile(new URL('sync-worker/migrations/0001_rooms.sql', root), 'utf8');
await DB.batch(sql.split(/;\s*\n\s*\n/).map(s => s.trim()).filter(Boolean).map(s => DB.prepare(s)));
const origin = 'https://hej014519-web.github.io';
const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const uid = () => crypto.randomUUID();
async function api(path, {method = 'GET', body, token, createKey, headers = {}, ip = '192.0.2.1'} = {}) {
  return mf.dispatchFetch('https://sync.test' + path, {method, headers: {Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(token ? {Authorization: 'Bearer ' + token} : {}), ...(createKey ? {'X-Create-Key': createKey} : {}), ...headers}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
}
function initial() {return {match: engine.createMatch(engine.defaultDemoConfig()), title: '虚构双打体验', court: '演示场地'};}
async function create(options = {}) {const packet = {requestId: uid(), initial: initial(), ...options.body}; const createKey = options.createKey || key(); const r = await api('/v1/rooms', {method: 'POST', ...options, body: packet, createKey}); assert.equal(r.status, 201, await r.clone().text()); return {...await r.json(), packet, createKey};}
const get = async (r, token = r.viewKey, headers = {}) => api('/v1/rooms/' + r.roomId, {token, headers});
const command = (r, cmd, version, requestId = uid(), token = r.editKey) => api('/v1/rooms/' + r.roomId + '/commands', {method: 'POST', token, body: {requestId, expectedVersion: version, command: cmd}});
async function started(options = {}) {const r = await create(options), config = structuredClone(r.room.match.config); config.penaltyProfile.confirmed = true; const res = await api('/v1/rooms/' + r.roomId + '/start', {method: 'POST', token: r.editKey, body: {requestId: uid(), expectedVersion: 1, config, title: r.room.title, court: r.room.court}}); assert.equal(res.status, 200, await res.clone().text()); return {...r, room: (await res.json()).room};}

test('health, exact CORS and preflight are public without exposing room data', async () => {
  const h = await api('/health'); assert.equal(h.status, 200); assert.deepEqual(await h.json(), {ok: true}); assert.equal(h.headers.get('Access-Control-Allow-Origin'), origin);
  const options = await api('/v1/rooms', {method: 'OPTIONS'}); assert.equal(options.status, 204); assert.match(options.headers.get('Access-Control-Allow-Headers'), /X-Create-Key/);
  for (const bad of ['https://evil.test', 'https://hej014519-web.github.io.evil.test', 'null']) {const r = await api('/health', {headers: {Origin: bad}}); assert.equal(r.status, 403); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);}
  assert.equal((await api('/health', {headers: {Origin: 'http://127.0.0.1:5173'}})).status, 200);
});
test('room creation retries recover identical separated keys; secrets are never stored in D1', async () => {
  const r = await create({ip: '192.0.2.2'}); assert.equal(r.room.version, 1); assert.match(r.roomId, /^[A-Za-z0-9_-]{22}$/); assert.match(r.editKey, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(r.editKey, r.viewKey);
  const retry = await api('/v1/rooms', {method: 'POST', body: r.packet, createKey: r.createKey, ip: '192.0.2.2'}); assert.equal(retry.status, 200); assert.equal(retry.headers.get('X-Idempotent-Replay'), '1'); const result = await retry.json(); assert.equal(result.editKey, r.editKey); assert.equal(result.viewKey, r.viewKey); assert.equal(result.roomId, r.roomId);
  const wrong = await api('/v1/rooms', {method: 'POST', body: r.packet, createKey: key()}); assert.equal(wrong.status, 403); assert.ok(!JSON.stringify(await wrong.json()).includes(r.editKey));
  const changed = await api('/v1/rooms', {method: 'POST', body: {...r.packet, initial: {...r.packet.initial, title: '其他内容'}}, createKey: r.createKey}); assert.equal(changed.status, 409);
  const stored = JSON.stringify((await DB.prepare('SELECT * FROM rooms WHERE id=?').bind(r.roomId).all()).results) + JSON.stringify((await DB.prepare('SELECT * FROM creation_receipts WHERE room_id=?').bind(r.roomId).all()).results);
  for (const secret of [r.editKey, r.viewKey, r.createKey]) assert.ok(!stored.includes(secret));
});
test('viewer reads scores but every mutation requires the separate edit key; ETags are auth protected', async () => {
  const r = await create({ip: '192.0.2.3'}), view = await get(r); assert.equal(view.status, 200); const etag = view.headers.get('ETag'); assert.ok(etag); assert.equal((await get(r, r.viewKey, {'If-None-Match': etag})).status, 304);
  assert.equal((await get(r, key(), {'If-None-Match': etag})).status, 403); assert.equal((await get(r, '')).status, 401);
  assert.equal((await command(r, {type: 'movePlayer', playerId: 'a1', x: .3, y: .5}, 1, uid(), r.viewKey)).status, 403);
  assert.equal((await api('/v1/rooms/' + r.roomId + '/start', {method: 'POST', token: r.viewKey, body: {}})).status, 403);
  assert.deepEqual(Object.keys((await view.json()).room).sort(), ['court', 'match', 'roomId', 'title', 'updatedAt', 'version']);
});
test('configure+start is one atomic room version; a rejected start changes neither score nor title', async () => {
  const r = await create({ip: '192.0.2.4'}), before = await (await get(r)).json();
  const bad = await api('/v1/rooms/' + r.roomId + '/start', {method: 'POST', token: r.editKey, body: {requestId: uid(), expectedVersion: 1, config: r.room.match.config, title: '不得写入', court: '不得写入'}}); assert.equal(bad.status, 400); assert.deepEqual(await (await get(r)).json(), before);
  const config = structuredClone(r.room.match.config); config.penaltyProfile.confirmed = true; const id = uid(); const packet = {requestId: id, expectedVersion: 1, config, title: '正式演示名称', court: '新场地'};
  const start = await api('/v1/rooms/' + r.roomId + '/start', {method: 'POST', token: r.editKey, body: packet}); assert.equal(start.status, 200); const room = (await start.json()).room; assert.equal(room.version, 2); assert.equal(room.match.revision, 2); assert.equal(room.match.status, 'live'); assert.equal(room.title, packet.title);
  const retry = await api('/v1/rooms/' + r.roomId + '/start', {method: 'POST', token: r.editKey, body: {...packet, expectedVersion: 99}}); assert.equal(retry.status, 200); assert.equal(retry.headers.get('X-Idempotent-Replay'), '1'); assert.equal((await retry.json()).room.version, 2);
});
test('dropped ACK replay commits a point once even after later writes; changed payload is refused', async () => {
  const r = await started({ip: '192.0.2.5'}), id = uid(); assert.equal((await command(r, {type: 'point', sideId: 'a'}, 2, id)).status, 200); assert.equal((await command(r, {type: 'point', sideId: 'b'}, 3)).status, 200);
  const retry = await command(r, {sideId: 'a', type: 'point'}, 4, id); assert.equal(retry.status, 200); assert.equal(retry.headers.get('X-Idempotent-Replay'), '1'); const room = (await retry.json()).room; assert.equal(room.version, 4); assert.deepEqual(room.match.points, {a: 1, b: 1});
  assert.equal((await command(r, {type: 'point', sideId: 'b'}, 4, id)).status, 409); assert.equal((await DB.prepare('SELECT count(*) AS n FROM command_receipts WHERE room_id=? AND request_id=?').bind(r.roomId, id).first()).n, 1);
});
test('fixed team swaps commit atomically once, synchronize to viewers and survive imported snapshots', async () => {
  const r = await started({ip:'192.0.2.12'}), before=structuredClone(r.room.match), id=uid();
  assert.equal((await command(r,{type:'swapTeamPositions',sideId:'a'},2,id,r.viewKey)).status,403);
  const moved=await command(r,{type:'swapTeamPositions',sideId:'a'},2,id);assert.equal(moved.status,200,await moved.clone().text());const room=(await moved.json()).room;
  assert.equal(room.version,3);assert.equal(room.match.revision,before.revision+1);assert.deepEqual(room.match.positions.a1,{x:.18,y:.74});assert.deepEqual(room.match.positions.a2,{x:.18,y:.26});for(const key of ['config','points','sets','serviceCursor','nearSideId'])assert.deepEqual(room.match[key],before[key]);
  const replay=await command(r,{type:'swapTeamPositions',sideId:'a'},2,id);assert.equal(replay.status,200);assert.equal(replay.headers.get('X-Idempotent-Replay'),'1');assert.deepEqual((await replay.json()).room.match.positions,room.match.positions);assert.deepEqual((await (await get(r)).json()).room.match.positions,room.match.positions);
  const imported=await create({body:{initial:{match:room.match,title:'虚构换位导入',court:'演示场地'}},ip:'192.0.2.13'});assert.deepEqual(imported.room.match.positions,room.match.positions);
  assert.equal((await command(r,{type:'undo'},3)).status,200);assert.deepEqual((await (await get(r)).json()).room.match.positions,before.positions);
});
test('automatic score and court change commit in one D1 version and duplicate retries cannot switch twice',async()=>{
  const r=await started({ip:'192.0.2.14'});assert.equal(r.room.match.endsChangeMode,'automatic');for(let i=0;i<3;i++)assert.equal((await command(r,{type:'point',sideId:'a'},2+i)).status,200);
  const id=uid(),both=await Promise.all([command(r,{type:'point',sideId:'a'},5,id),command(r,{type:'point',sideId:'a'},5,id)]);assert.deepEqual(both.map(x=>x.status),[200,200]);const room=(await (await get(r)).json()).room;assert.equal(room.version,6);assert.equal(room.match.nearSideId,'b');assert.deepEqual(room.match.sets,[{a:1,b:0}]);assert.deepEqual(room.match.points,{a:0,b:0});assert.equal(room.match.endsChangePending,false);assert.equal(room.match.serviceCursor,1);
  const replay=await command(r,{type:'point',sideId:'a'},6,id);assert.equal(replay.status,200);assert.equal(replay.headers.get('X-Idempotent-Replay'),'1');assert.equal((await replay.json()).room.match.nearSideId,'b');assert.equal((await DB.prepare('SELECT count(*) AS n FROM command_receipts WHERE room_id=? AND request_id=?').bind(r.roomId,id).first()).n,1);
  assert.equal((await command(r,{type:'undo'},6)).status,200);const restored=(await (await get(r)).json()).room;assert.equal(restored.version,7);assert.equal(restored.match.nearSideId,'a');assert.deepEqual(restored.match.sets,[{a:0,b:0}]);assert.deepEqual(restored.match.points,{a:3,b:0});
  assert.equal((await command(r,{type:'setEndsChangeMode',mode:'manual'},7)).status,200);assert.equal((await command(r,{type:'point',sideId:'a'},8)).status,200);const manual=(await (await get(r)).json()).room;assert.equal(manual.match.endsChangeMode,'manual');assert.equal(manual.match.endsChangePending,true);assert.equal(manual.match.nearSideId,'a');
  const changeId=uid();assert.equal((await command(r,{type:'setEndsChangeMode',mode:'automatic'},9,changeId,r.viewKey)).status,403);const changed=await command(r,{type:'setEndsChangeMode',mode:'automatic'},9,changeId);assert.equal(changed.status,200);const automatic=(await changed.json()).room;assert.equal(automatic.version,10);assert.equal(automatic.match.nearSideId,'b');assert.equal(automatic.match.endsChangeMode,'automatic');assert.equal(automatic.match.endsChangePending,false);for(const field of ['points','sets','positions','serviceCursor','config'])assert.deepEqual(automatic.match[field],manual.match[field]);
  const modeReplay=await command(r,{type:'setEndsChangeMode',mode:'automatic'},9,changeId);assert.equal(modeReplay.status,200);assert.equal(modeReplay.headers.get('X-Idempotent-Replay'),'1');assert.equal((await modeReplay.json()).room.match.nearSideId,'b');assert.deepEqual((await (await get(r)).json()).room.match,automatic.match);
  const imported=await create({body:{initial:{match:automatic.match,title:'虚构自动换边导入',court:'演示场地'}},ip:'192.0.2.15'});assert.equal(imported.room.match.endsChangeMode,'automatic');assert.equal(imported.room.match.nearSideId,'b');
});
test('a chosen manual mode survives atomic start while invalid mode commands and imported mode audits are rejected',async()=>{
  const r=await create({ip:'192.0.2.16'});assert.equal((await command(r,{type:'setEndsChangeMode',mode:'manual'},1)).status,200);const config=structuredClone(r.room.match.config);config.penaltyProfile.confirmed=true;
  const start=await api('/v1/rooms/'+r.roomId+'/start',{method:'POST',token:r.editKey,body:{requestId:uid(),expectedVersion:2,config,title:r.room.title,court:r.room.court}});assert.equal(start.status,200);assert.equal((await start.json()).room.match.endsChangeMode,'manual');
  const invalidId=uid(),invalid=await command(r,{type:'setEndsChangeMode',mode:'auto'},3,invalidId);assert.equal(invalid.status,400);assert.equal((await (await get(r)).json()).room.version,3);assert.equal(await DB.prepare('SELECT request_id FROM command_receipts WHERE room_id=? AND request_id=?').bind(r.roomId,invalidId).first(),null);
  const seed=initial();seed.match=engine.applyCommand(seed.match,{type:'setEndsChangeMode',mode:'manual'},0);seed.match.events[0].command.mode='auto';const bad=await api('/v1/rooms',{method:'POST',createKey:key(),body:{requestId:uid(),initial:seed},ip:'192.0.2.17'});assert.equal(bad.status,400);
  const legacy=initial();delete legacy.match.endsChangeMode;const old=await create({body:{initial:legacy},ip:'192.0.2.18'});assert.equal(engine.endsChangeMode(old.room.match),'manual');const oldConfig=structuredClone(old.room.match.config);oldConfig.penaltyProfile.confirmed=true;const oldStart=await api('/v1/rooms/'+old.roomId+'/start',{method:'POST',token:old.editKey,body:{requestId:uid(),expectedVersion:1,config:oldConfig,title:old.room.title,court:old.room.court}});assert.equal(oldStart.status,200);assert.equal((await oldStart.json()).room.match.endsChangeMode,'manual');
});
test('concurrent CAS accepts one writer, returns latest room to loser and rolls losing receipt back', async () => {
  const r = await started({ip: '192.0.2.6'}), ids = [uid(), uid()]; const responses = await Promise.all(ids.map((id, i) => command(r, {type: 'point', sideId: i ? 'b' : 'a'}, 2, id))); assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
  const loser = responses.findIndex(x => x.status === 409), error = await responses[loser].json(); assert.equal(error.code, 'VERSION_CONFLICT'); assert.equal(error.room.version, 3); assert.equal(await DB.prepare('SELECT request_id FROM command_receipts WHERE room_id=? AND request_id=?').bind(r.roomId, ids[loser]).first(), null);
  const room = (await (await get(r)).json()).room; assert.equal(room.version, 3); assert.equal(room.match.points.a + room.match.points.b, 1);
});
test('concurrent identical commands and creations are idempotent', async () => {
  const r = await started({ip: '192.0.2.7'}), id = uid(); const same = await Promise.all([command(r, {type: 'point', sideId: 'a'}, 2, id), command(r, {type: 'point', sideId: 'a'}, 2, id)]); assert.deepEqual(same.map(x => x.status), [200, 200]); assert.equal((await (await get(r)).json()).room.match.points.a, 1);
  const createKey = key(), packet = {requestId: uid(), initial: initial()}; const attempts = await Promise.all([1, 2].map(() => api('/v1/rooms', {method: 'POST', body: packet, createKey, ip: '192.0.2.77'}))); assert.deepEqual(attempts.map(x => x.status).sort(), [200, 201]); const values = await Promise.all(attempts.map(x => x.json())); assert.equal(values[0].roomId, values[1].roomId); assert.equal(values[0].editKey, values[1].editKey);
});
test('a late SQL failure rolls receipt and room CAS update back together', async () => {
  const r = await create({ip: '192.0.2.8'}), id = uid(); await assert.rejects(DB.batch([DB.prepare('INSERT INTO command_receipts (room_id,request_id,payload_hash,base_version,result_version,created_at) VALUES (?,?,?,?,?,?)').bind(r.roomId, id, 'test', 1, 2, Date.now()), DB.prepare('UPDATE rooms SET version=2 WHERE id=?').bind(r.roomId), DB.prepare('INSERT INTO rooms (id) VALUES (?)').bind('invalid')]));
  assert.equal((await (await get(r)).json()).room.version, 1); assert.equal(await DB.prepare('SELECT request_id FROM command_receipts WHERE room_id=? AND request_id=?').bind(r.roomId, id).first(), null);
});
test('malformed or future snapshots cannot enter storage; live import keeps score and rebases clock', async () => {
  for (const tweak of [s => s.points.a = -1, s => s.history.push({}), s => {s.events[0].at = Date.now() + 60_000;}, s => s.runningSince = Date.now() + 60_000]) {
    const seed = initial(), config = seed.match.config; config.penaltyProfile.confirmed = true; seed.match = engine.applyCommand(engine.createMatch(config), {type: 'start'}, Date.now() - 5000); tweak(seed.match);
    const response = await api('/v1/rooms', {method: 'POST', body: {requestId: uid(), initial: seed}, createKey: key(), ip: '192.0.2.9'}); assert.equal(response.status, 400, await response.clone().text());
  }
  const seed = initial(); seed.match.config.penaltyProfile.confirmed = true; seed.match = engine.applyCommand(seed.match, {type: 'start'}, Date.now() - 5000); seed.match = engine.applyCommand(seed.match, {type: 'point', sideId: 'a'}, Date.now() - 4000); const r = await create({body: {initial: seed}, ip: '192.0.2.9'}); assert.equal(r.room.match.points.a, 1); assert.ok(r.room.match.elapsedMs >= 5000); assert.equal(r.room.match.runningSince, r.room.updatedAt);
});
test('body limits cover untrusted content-length and actual streamed bytes', async () => {
  const headers = {Origin: origin, 'Content-Type': 'application/json', 'X-Create-Key': key()};
  const oversized = await mf.dispatchFetch('https://sync.test/v1/rooms', {method: 'POST', headers, body: JSON.stringify({padding: 'x'.repeat(1024 * 1024)})}); assert.equal(oversized.status, 413);
  const stream = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(700_000).fill(32)); controller.enqueue(new Uint8Array(400_000).fill(32)); controller.close();}});
  const streamed = await mf.dispatchFetch('https://sync.test/v1/rooms', {method: 'POST', headers, body: stream, duplex: 'half'}); assert.equal(streamed.status, 413);
  const invalid = await mf.dispatchFetch('https://sync.test/v1/rooms', {method: 'POST', headers, body: '{bad'}); assert.equal(invalid.status, 400);
  assert.equal((await api('/v1/rooms', {method: 'POST', createKey: key(), body: {requestId: uid(), initial: initial()}, headers: {'Content-Type': 'text/plain'}})).status, 415);
});
test('imported timeline commands and total event count are bounded before cloud storage', async () => {
  const seed = initial(); seed.match.events = [{id:'one',revision:1,at:0,type:'point',command:null,scoreBefore:'',scoreAfter:'',result:'',voided:false}]; seed.match.revision = 1;
  assert.equal((await api('/v1/rooms', {method:'POST', body:{requestId:uid(),initial:seed},createKey:key(),ip:'192.0.2.11'})).status,400);
  seed.match.events = Array.from({length:5001},(_,i)=>({id:String(i),revision:i+1,at:0,type:'point',command:{type:'point',sideId:'a'},scoreBefore:'',scoreAfter:'',result:'',voided:false})); seed.match.revision = 5001;
  const packet = {requestId:uid(),initial:seed}; assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 1024 * 1024);
  const capped = await api('/v1/rooms',{method:'POST',body:packet,createKey:key(),ip:'192.0.2.11'}); assert.equal(capped.status,413); assert.equal((await capped.json()).code,'MATCH_TOO_LARGE');
});
test('per-IP ten room limit is transactional; retries do not spend quota and expired counters are cleaned', async () => {
  const rooms = []; for (let i = 0; i < 10; i++) rooms.push(await create({ip: '192.0.2.10'})); const r = rooms[0];
  assert.equal((await api('/v1/rooms', {method: 'POST', body: r.packet, createKey: r.createKey, ip: '192.0.2.10'})).status, 200);
  const blocked = await api('/v1/rooms', {method: 'POST', body: {requestId: uid(), initial: initial()}, createKey: key(), ip: '192.0.2.10'}); assert.equal(blocked.status, 429);
  await DB.prepare('UPDATE creation_limits SET expires_at=0').run(); const extra = await create({ip: '192.0.2.10'}); assert.ok(extra.roomId); assert.equal((await DB.prepare('SELECT max(count) AS n FROM creation_limits').first()).n, 1);
});
