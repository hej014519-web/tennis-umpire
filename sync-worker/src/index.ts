import {applyCommand, matchElapsed, restoreSnapshot, type Command, type MatchConfig, type MatchState} from '../../lib/umpire-engine';

// Small structural binding types keep the standalone Worker independent of
// the public site's browser-only TypeScript configuration.
interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Database {prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown[]>;}
export interface Env {DB: Database; ALLOWED_ORIGINS?: string;}
export type Room = {roomId: string; version: number; match: MatchState; title: string; court: string; updatedAt: number};
export type CreateRoomResponse = {roomId: string; editKey: string; viewKey: string; room: Room};
type RoomRow = {id: string; version: number; match_json: string; title: string; court: string; edit_hash: string; view_hash: string; updated_at: number};
type CreationReceipt = {creator_hash: string; payload_hash: string; room_id: string};
const MAX_BODY = 1024 * 1024, MAX_STATE = 1_500_000, MAX_EVENTS = 5000, HOUR = 3_600_000;
const COMMAND_TYPES = new Set(['configure','start','pause','resume','medical','undo','switchEnds','swapTeamPositions','setEndsChangeMode','let','rallyLet','point','fault','movePlayer','retire','finish','formalPenalty','confirmService','setServiceOrder','correctScore','voidEvent','correctEvent']);
const encoder = new TextEncoder();
const KEY = /^[A-Za-z0-9_-]{43}$/;
class ApiError extends Error {constructor(public status: number, message: string, public code: string, public room?: Room) {super(message);}}
function check(v: unknown, message: string, status = 400, code = 'VALIDATION_ERROR'): asserts v {if (!v) throw new ApiError(status, message, code);}
function record(v: unknown): v is Record<string, any> {return !!v && typeof v === 'object' && !Array.isArray(v);}
function auditCommand(v: unknown): boolean {return record(v) && COMMAND_TYPES.has(v.type) && (v.type !== 'setEndsChangeMode' || v.mode === 'automatic' || v.mode === 'manual') && (v.type !== 'correctEvent' || record(v.replacement) && !['correctEvent','voidEvent','undo'].includes(v.replacement.type) && auditCommand(v.replacement));}
function requestId(v: unknown): asserts v is string {check(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/.test(v), '缺少有效请求编号');}
function text(v: unknown, max: number, empty = false): string {check(typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0), '比赛名称或场地格式无效'); return v.trim();}
function base64(bytes: Uint8Array): string {return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');}
function random(bytes: number): string {return base64(crypto.getRandomValues(new Uint8Array(bytes)));}
async function digest(value: string): Promise<string> {return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));}
function equal(a: string, b: string): boolean {let n = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) n |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return n === 0;}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (record(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
async function keys(createKey: string, roomId: string) {
  const raw = Uint8Array.from(atob(createKey.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const derive = async (role: string) => base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('startline-room-v1:' + roomId + ':' + role))));
  return {editKey: await derive('edit'), viewKey: await derive('view')};
}
function publicRoom(row: RoomRow): Room {return {roomId: row.id, version: row.version, match: JSON.parse(row.match_json), title: row.title, court: row.court, updatedAt: row.updated_at};}
async function rowFor(env: Env, id: string): Promise<RoomRow> {const row = await env.DB.prepare('SELECT id,version,match_json,title,court,edit_hash,view_hash,updated_at FROM rooms WHERE id=?').bind(id).first<RoomRow>(); check(row, '比赛房间不存在', 404, 'ROOM_NOT_FOUND'); return row;}
function configuredOrigins(env: Env) {
  return new Set((env.ALLOWED_ORIGINS || 'https://hej014519-web.github.io').split(',').map(s => s.trim()).filter(s => s === 'https://hej014519-web.github.io' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(s)));
}
function cors(req: Request, env: Env): Headers {
  const h = new Headers({'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'});
  const origin = req.headers.get('Origin');
  if (origin && configuredOrigins(env).has(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Create-Key, If-None-Match');
    h.set('Access-Control-Expose-Headers', 'ETag, X-Idempotent-Replay, Retry-After');
    h.set('Access-Control-Max-Age', '600');
  }
  return h;
}
function response(req: Request, env: Env, value: unknown, status = 200, extra: Record<string, string> = {}): Response {const h = cors(req, env); for (const [k, v] of Object.entries(extra)) h.set(k, v); return new Response(status === 204 || status === 304 ? null : JSON.stringify(value), {status, headers: h});}
async function body(req: Request): Promise<Record<string, any>> {
  check(req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json', '请使用JSON请求', 415, 'UNSUPPORTED_MEDIA_TYPE');
  const size = req.headers.get('Content-Length');
  check(!size || /^\d+$/.test(size) && Number(size) <= MAX_BODY, '请求内容超过1MB', 413, 'BODY_TOO_LARGE');
  check(req.body, '请求内容为空');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {for (;;) {const {done, value} = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_BODY) {await reader.cancel(); throw new ApiError(413, '请求内容超过1MB', 'BODY_TOO_LARGE');} chunks.push(value);}} finally {reader.releaseLock();}
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
  let value: unknown; try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {throw new ApiError(400, 'JSON内容无效', 'INVALID_JSON');}
  check(record(value), '请求须为JSON对象'); return value;
}
function model<T>(fn: () => T): T {try {return fn();} catch (e) {throw new ApiError(400, e instanceof Error ? e.message : '比赛操作无效', 'INVALID_MATCH');}}
function configLimits(c: MatchConfig) {check(c.sideNames.a.length <= 120 && c.sideNames.b.length <= 120 && (!c.ruleLabel || c.ruleLabel.length <= 1000) && c.penaltyProfile.label.length <= 500 && c.penaltyProfile.id.length <= 100, '赛制说明或队名过长');}
function boundedMatch(match: MatchState): string {check(match.events.length <= MAX_EVENTS && match.history.length <= 256, '比赛记录已达同步上限，请导出记录后新建房间', 413, 'MATCH_TOO_LARGE'); configLimits(match.config); const raw = JSON.stringify(match); check(encoder.encode(raw).byteLength <= MAX_STATE, '比赛记录已达同步上限，请导出记录后新建房间', 413, 'MATCH_TOO_LARGE'); return raw;}
function initialMatch(input: unknown, now: number): MatchState {
  const match = model(() => restoreSnapshot(input));
  // The engine checks score/history integrity. Also validate the audit fields
  // read directly by the public viewer, so a malformed imported command cannot
  // crash another device's timeline.
  check(match.events.every(e => typeof e.type === 'string' && COMMAND_TYPES.has(e.type) && auditCommand(e.command) && e.id.length <= 128 && e.result.length <= 6000 && e.scoreBefore.length <= 1000 && e.scoreAfter.length <= 1000 && (e.command.type !== 'formalPenalty' || ['a','b'].includes(e.command.sideId) && typeof e.command.reason === 'string' && e.command.reason.length <= 1000 && ['warning','point','game','disqualification'].includes(e.command.penalty))), '本机比赛审计记录格式无效');
  check(match.events.every(e => e.at <= now) && (match.runningSince === null || match.runningSince <= now) && match.history.every(h => h.before.runningSince === null || h.before.runningSince <= now), '本机比赛包含未来时间，请校准设备时间后重试');
  check(match.elapsedMs <= now && match.history.every(h => h.before.elapsedMs <= now), '本机累计用时无效');
  // The imported score/audit is retained. The authoritative clock continues
  // from this server instant; client runningSince never drives future writes.
  match.elapsedMs = matchElapsed(match, now);
  match.runningSince = match.status === 'live' ? now : null;
  boundedMatch(match); return match;
}
async function authenticate(req: Request, row: RoomRow, write: boolean) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.get('Authorization') || '')?.[1];
  check(token, '缺少房间访问密钥', 401, 'INVALID_KEY'); const hash = await digest(token);
  check(equal(hash, row.edit_hash) || !write && equal(hash, row.view_hash), write ? '此链接没有执裁权限' : '房间访问密钥无效', 403, 'FORBIDDEN');
}
async function creationReplay(req: Request, env: Env, id: string, creatorHash: string, payloadHash: string): Promise<Response | null> {
  const receipt = await env.DB.prepare('SELECT creator_hash,payload_hash,room_id FROM creation_receipts WHERE request_id=?').bind(id).first<CreationReceipt>();
  if (!receipt) return null;
  check(equal(receipt.creator_hash, creatorHash), '创建请求密钥不匹配', 403, 'CREATE_KEY_MISMATCH');
  check(equal(receipt.payload_hash, payloadHash), '请求编号已用于其他创建内容', 409, 'REQUEST_ID_CONFLICT');
  const room = publicRoom(await rowFor(env, receipt.room_id));
  return response(req, env, {roomId: room.roomId, ...await keys(req.headers.get('X-Create-Key')!, room.roomId), room}, 200, {'X-Idempotent-Replay': '1'});
}
async function create(req: Request, env: Env): Promise<Response> {
  const b = await body(req); requestId(b.requestId); const createKey = req.headers.get('X-Create-Key'); check(createKey && KEY.test(createKey), '请先生成32字节X-Create-Key创建密钥');
  check(record(b.initial), '缺少初始比赛'); const title = text(b.initial.title, 120), court = text(b.initial.court, 60, true);
  const creatorHash = await digest(createKey), payloadHash = await digest(canonical({initial: {...b.initial, title, court}}));
  const replay = await creationReplay(req, env, b.requestId, creatorHash, payloadHash); if (replay) return replay;
  const now = Date.now(), match = initialMatch(b.initial.match, now), roomId = random(16), tokens = await keys(createKey, roomId), ipHash = await digest('create-ip:' + (req.headers.get('CF-Connecting-IP') || 'local'));
  const raw = boundedMatch(match), editHash = await digest(tokens.editKey), viewHash = await digest(tokens.viewKey);
  try {await env.DB.batch([
    env.DB.prepare('DELETE FROM creation_limits WHERE expires_at<=?').bind(now),
    env.DB.prepare('INSERT INTO creation_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').bind(ipHash, now + HOUR),
    env.DB.prepare('INSERT INTO rooms (id,version,match_json,title,court,edit_hash,view_hash,creation_rate_key,created_at,updated_at) VALUES (?,1,?,?,?,?,?,?,?,?)').bind(roomId, raw, title, court, editHash, viewHash, ipHash, now, now),
    env.DB.prepare('INSERT INTO creation_receipts (request_id,creator_hash,payload_hash,room_id,created_at) VALUES (?,?,?,?,?)').bind(b.requestId, creatorHash, payloadHash, roomId, now)
  ]);} catch (error) {const after = await creationReplay(req, env, b.requestId, creatorHash, payloadHash); if (after) return after; if (String(error).includes('CREATE_RATE_LIMIT')) throw new ApiError(429, '此网络每小时最多创建10场比赛，请稍后再试', 'RATE_LIMITED'); throw error;}
  const room: Room = {roomId, version: 1, match, title, court, updatedAt: now}; return response(req, env, {roomId, ...tokens, room}, 201);
}
async function commandReplay(req: Request, env: Env, row: RoomRow, id: string, hash: string): Promise<Response | null> {
  const receipt = await env.DB.prepare('SELECT payload_hash FROM command_receipts WHERE room_id=? AND request_id=?').bind(row.id, id).first<{payload_hash: string}>();
  if (!receipt) return null; check(equal(receipt.payload_hash, hash), '请求编号已用于其他操作', 409, 'REQUEST_ID_CONFLICT');
  return response(req, env, {room: publicRoom(await rowFor(env, row.id))}, 200, {'X-Idempotent-Replay': '1'});
}
async function mutate(req: Request, env: Env, id: string, start: boolean): Promise<Response> {
  const row = await rowFor(env, id); await authenticate(req, row, true); const b = await body(req); requestId(b.requestId);
  check(Number.isSafeInteger(b.expectedVersion) && b.expectedVersion >= 1, '缺少有效比赛版本');
  const payload = start ? {route: 'start', config: b.config, title: text(b.title, 120), court: text(b.court, 60, true)} : {route: 'commands', command: b.command};
  check(start || record(b.command), '缺少比赛操作'); const hash = await digest(canonical(payload));
  const replay = await commandReplay(req, env, row, b.requestId, hash); if (replay) return replay;
  if (b.expectedVersion !== row.version) throw new ApiError(409, '比赛已被其他设备更新，请查看最新比分后重试', 'VERSION_CONFLICT', publicRoom(row));
  const previous: MatchState = JSON.parse(row.match_json), now = Math.max(Date.now(), previous.events.at(-1)?.at || 0, row.updated_at);
  const match = model(() => start ? applyCommand(applyCommand(previous, {type: 'configure', config: b.config}, now), {type: 'start'}, now) : applyCommand(previous, b.command as Command, now));
  const raw = boundedMatch(match), title = start ? payload.title! : row.title, court = start ? payload.court! : row.court;
  try {await env.DB.batch([
    env.DB.prepare('INSERT INTO command_receipts (room_id,request_id,payload_hash,base_version,result_version,created_at) VALUES (?,?,?,?,?,?)').bind(id, b.requestId, hash, row.version, row.version + 1, now),
    env.DB.prepare('UPDATE rooms SET version=version+1,match_json=?,title=?,court=?,updated_at=? WHERE id=? AND version=?').bind(raw, title, court, now, id, row.version)
  ]);} catch (error) {
    const after = await commandReplay(req, env, row, b.requestId, hash); if (after) return after;
    if (String(error).includes('ROOM_VERSION_CONFLICT')) throw new ApiError(409, '比赛已被其他设备更新，请查看最新比分后重试', 'VERSION_CONFLICT', publicRoom(await rowFor(env, id)));
    throw error;
  }
  return response(req, env, {room: {roomId: id, version: row.version + 1, match, title, court, updatedAt: now} satisfies Room});
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const origin = req.headers.get('Origin'); check(!origin || configuredOrigins(env).has(origin), '此来源没有访问权限', 403, 'ORIGIN_FORBIDDEN');
      if (req.method === 'OPTIONS') return response(req, env, null, 204);
      const path = new URL(req.url).pathname;
      if (path === '/health' && req.method === 'GET') {await env.DB.batch([env.DB.prepare('SELECT version FROM rooms LIMIT 0'), env.DB.prepare('SELECT request_id FROM command_receipts LIMIT 0'), env.DB.prepare('SELECT request_id FROM creation_receipts LIMIT 0'), env.DB.prepare('SELECT count FROM creation_limits LIMIT 0')]); return response(req, env, {ok: true});}
      if (path === '/v1/rooms' && req.method === 'POST') return await create(req, env);
      const route = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})(?:\/(commands|start))?$/.exec(path);
      check(route, '接口不存在', 404, 'NOT_FOUND');
      if (req.method === 'GET' && !route[2]) {
        const row = await rowFor(env, route[1]); await authenticate(req, row, false); const tag = 'W/"' + row.id + ':' + row.version + '"';
        if (req.headers.get('If-None-Match')?.split(',').map(x => x.trim()).includes(tag)) return response(req, env, null, 304, {ETag: tag});
        return response(req, env, {room: publicRoom(row)}, 200, {ETag: tag});
      }
      if (req.method === 'POST' && route[2]) return await mutate(req, env, route[1], route[2] === 'start');
      throw new ApiError(405, '此请求方法不支持', 'METHOD_NOT_ALLOWED');
    } catch (e) {
      if (e instanceof ApiError) return response(req, env, {error: e.message, code: e.code, ...(e.room ? {room: e.room} : {})}, e.status, e.status === 429 ? {'Retry-After': '3600'} : {});
      return response(req, env, {error: '同步服务暂不可用，请保留本机记录后重试', code: 'SERVICE_UNAVAILABLE'}, 503);
    }
  }
};
