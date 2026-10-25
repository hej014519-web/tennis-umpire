export type SideId='a'|'b';
export type Player={id:string;name:string;sideId:SideId};
export type PenaltyProfile={id:string;label:string;confirmed:boolean;pointPenalty:boolean;gamePenalty:boolean;disqualification:boolean;gamePenaltyService:'review'|'advance'};
export type MatchConfig={mode:'singles'|'doubles';players:Player[];sideNames:{a:string;b:string};bestOf:1|3;gamesPerSet:4|6;tiebreakAt:4|6;deuce:'advantage'|'no-ad';serviceOrder:string[];firstServerId:string;penaltyProfile:PenaltyProfile;ruleLabel?:string;initialNearSide?:SideId};
export type SetScore={a:number;b:number;winner?:SideId;tiebreakPoints?:{a:number;b:number}};
export type CoreState={status:'scheduled'|'live'|'paused'|'medical'|'completed';sets:SetScore[];points:{a:number;b:number};tiebreak:boolean;serviceCursor:number;tiebreakFirstCursor:number;faults:0|1;nearSideId:SideId;positions:Record<string,{x:number;y:number}>;winner?:SideId;endReason?:'score'|'retirement'|'disqualification'|'manual';serviceReviewRequired:boolean;elapsedMs:number;runningSince:number|null};
export type MatchEvent={id:string;revision:number;at:number;type:string;command:Command;scoreBefore:string;scoreAfter:string;result:string;voided:boolean;correctedBy?:string;replaces?:string};
export type MatchState=CoreState&{version:1;config:MatchConfig;revision:number;events:MatchEvent[];history:{eventId:string;before:CoreState;configBefore?:MatchConfig}[]};
export type Command=
 |{type:'configure';config:MatchConfig}
 |{type:'start'}|{type:'pause'}|{type:'resume'}|{type:'medical'}|{type:'undo'}|{type:'switchEnds'}|{type:'let'}|{type:'rallyLet'}
 |{type:'point';sideId:SideId}
 |{type:'fault';kind?:'service'|'foot'}
 |{type:'movePlayer';playerId:string;x:number;y:number}
 |{type:'retire';sideId:SideId;reason:string}
 |{type:'finish';winner:SideId;reason:string}
 |{type:'formalPenalty';sideId:SideId;penalty:'warning'|'point'|'game'|'disqualification';reason:string}
 |{type:'confirmService';serverId:string}
 |{type:'setServiceOrder';serviceOrder:string[];firstServerId:string}
 |{type:'correctScore';sets:SetScore[];points:{a:number;b:number};tiebreak:boolean;serverId:string;reason:string}
 |{type:'voidEvent';eventId:string;reason:string}
 |{type:'correctEvent';eventId:string;replacement:Exclude<Command,{type:'correctEvent'}|{type:'voidEvent'}|{type:'undo'}>;reason:string};
export const DEMO_PENALTY_PROFILE:PenaltyProfile={id:'demo-explicit',label:'演示：逐次明确选择处罚，不自动递进；罚局后人工核对发球',confirmed:false,pointPenalty:true,gamePenalty:true,disqualification:true,gamePenaltyService:'review'};
export const HISTORY_LIMIT=256;
// Public API: createMatch(config), applyCommand(state,command,now?), scoreLabels(state),
// serverPlayerId(state), matchElapsed(state,now?), restoreSnapshot(snapshot).

const clone=<T>(v:T):T=>structuredClone(v);
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const other=(side:SideId):SideId=>side==='a'?'b':'a';
const sideOK=(s:unknown):s is SideId=>s==='a'||s==='b';
const integer=(n:unknown,max=1000000):n is number=>typeof n==='number'&&Number.isInteger(n)&&n>=0&&n<=max;
function reason(s:unknown){check(typeof s==='string'&&s.trim().length>0&&s.length<=1000,'请填写1–1000字的操作原因');}
function validateConfig(c:MatchConfig){
 check(c&&['singles','doubles'].includes(c.mode),'请选择单打或双打');check(Array.isArray(c.players)&&c.players.length===(c.mode==='singles'?2:4),'球员人数与单双打不符');
 check(new Set(c.players.map(p=>p.id)).size===c.players.length,'球员ID必须固定且唯一');for(const p of c.players)check(p&&typeof p.id==='string'&&p.id.length>0&&p.id.length<=100&&typeof p.name==='string'&&p.name.trim()&&p.name.length<=100&&sideOK(p.sideId),'球员身份无效');
 for(const side of ['a','b']as const)check(c.players.filter(p=>p.sideId===side).length===(c.mode==='singles'?1:2)&&typeof c.sideNames?.[side]==='string'&&c.sideNames[side].trim(),'双方球员或队名不完整');
 check([1,3].includes(c.bestOf)&&[4,6].includes(c.gamesPerSet)&&c.tiebreakAt===c.gamesPerSet&&['advantage','no-ad'].includes(c.deuce),'盘制、局数或占先设置无效');validateOrder(c,c.serviceOrder,c.firstServerId);
 const p=c.penaltyProfile;check(p&&typeof p.id==='string'&&p.id.length>0&&typeof p.label==='string'&&p.label.trim()&&typeof p.confirmed==='boolean'&&typeof p.pointPenalty==='boolean'&&typeof p.gamePenalty==='boolean'&&typeof p.disqualification==='boolean'&&['review','advance'].includes(p.gamePenaltyService),'请配置明确的处罚profile');check(c.initialNearSide===undefined||sideOK(c.initialNearSide),'初始半场无效');
}
function validateOrder(c:MatchConfig,order:string[],first:string){check(Array.isArray(order)&&order.length===c.players.length&&new Set(order).size===order.length&&order.every(id=>c.players.some(p=>p.id===id))&&order.includes(first),'发球轮次必须包含每位固定球员一次');for(let i=0;i<order.length;i++)check(c.players.find(p=>p.id===order[i])!.sideId!==c.players.find(p=>p.id===order[(i+1)%order.length])!.sideId,'发球轮次必须双方交替');}
export function defaultDemoConfig(mode:MatchConfig['mode']='doubles'):MatchConfig{
 const players:Player[]=[{id:'a1',name:'林沐',sideId:'a'},...(mode==='doubles'?[{id:'a2',name:'周宁',sideId:'a'}as Player]:[]),{id:'b1',name:'陈屿',sideId:'b'},...(mode==='doubles'?[{id:'b2',name:'许言',sideId:'b'}as Player]:[])];
 return{mode,players,sideNames:{a:'晴川队',b:'松庭队'},bestOf:3,gamesPerSet:6,tiebreakAt:6,deuce:'advantage',serviceOrder:mode==='doubles'?['a1','b1','a2','b2']:['a1','b1'],firstServerId:'a1',penaltyProfile:clone(DEMO_PENALTY_PROFILE),ruleLabel:'虚构平板演示规则，非本赛事正式规程',initialNearSide:'a'};
}
export function createMatch(config:MatchConfig):MatchState{validateConfig(config);return{version:1,config:clone(config),revision:0,status:'scheduled',sets:[{a:0,b:0}],points:{a:0,b:0},tiebreak:false,serviceCursor:config.serviceOrder.indexOf(config.firstServerId),tiebreakFirstCursor:config.serviceOrder.indexOf(config.firstServerId),faults:0,nearSideId:config.initialNearSide||'a',positions:Object.fromEntries(config.players.map(p=>[p.id,{x:p.sideId==='a'?.22:.78,y:config.mode==='singles'?.5:p.id===config.players.find(q=>q.sideId===p.sideId)?.id?.3:.7}])),serviceReviewRequired:false,elapsedMs:0,runningSince:null,events:[],history:[]};}
export function matchElapsed(s:MatchState,now=Date.now()){check(Number.isFinite(now)&&now>=0,'计时时间无效');return s.elapsedMs+(s.runningSince===null?0:Math.max(0,now-s.runningSince));}
export function serverPlayerId(s:MatchState):string{if(s.serviceReviewRequired)return'';const n=s.points.a+s.points.b,index=s.tiebreak?(s.tiebreakFirstCursor+Math.floor((n+1)/2))%s.config.serviceOrder.length:s.serviceCursor;return s.config.serviceOrder[index];}
export function scoreLabels(s:Pick<MatchState,'points'|'tiebreak'>):{a:string;b:string}{if(s.tiebreak)return{a:String(s.points.a),b:String(s.points.b)};const{a,b}=s.points;if(a>=3&&b>=3)return a===b?{a:'40',b:'40'}:a>b?{a:'AD',b:'40'}:{a:'40',b:'AD'};const labels=['0','15','30','40'];return{a:labels[a]||'AD',b:labels[b]||'AD'};}
export function describeScore(s:MatchState):string{const p=scoreLabels(s);return s.sets.map(x=>`${x.a}:${x.b}`).join(' / ')+` · ${s.tiebreak?'抢七 ':''}${p.a}:${p.b}`+(s.winner?` · ${s.config.sideNames[s.winner]}获胜`:'');}
function core(s:MatchState):CoreState{const {version,config,revision,events,history,...score}=s;return clone(score);}
function freeze(s:MatchState,now:number){s.elapsedMs=matchElapsed(s,now);s.runningSince=null;}
function complete(s:MatchState,winner:SideId,endReason:CoreState['endReason'],now:number){freeze(s,now);s.status='completed';s.winner=winner;s.endReason=endReason;s.faults=0;s.serviceReviewRequired=false;}
function setWinner(set:SetScore,c:MatchConfig):SideId|undefined{
 if(set.a===c.gamesPerSet+1&&set.b===c.gamesPerSet)return'a';if(set.b===c.gamesPerSet+1&&set.a===c.gamesPerSet)return'b';
 if(set.a>=c.gamesPerSet&&set.a-set.b>=2)return'a';if(set.b>=c.gamesPerSet&&set.b-set.a>=2)return'b';
}
function finishSet(s:MatchState,now:number){const set=s.sets.at(-1)!;set.winner=setWinner(set,s.config);if(!set.winner)return;const wins=s.sets.filter(x=>x.winner===set.winner).length;if(wins>=Math.ceil(s.config.bestOf/2))complete(s,set.winner,'score',now);else s.sets.push({a:0,b:0});s.points={a:0,b:0};s.tiebreak=false;}
function game(s:MatchState,side:SideId,now:number,advance=true){const wasTB=s.tiebreak,first=s.tiebreakFirstCursor;s.sets.at(-1)![side]++;s.points={a:0,b:0};s.faults=0;s.tiebreak=false;if(advance)s.serviceCursor=wasTB?(first+1)%s.config.serviceOrder.length:(s.serviceCursor+1)%s.config.serviceOrder.length;finishSet(s,now);const current=s.sets.at(-1)!;if(s.status!=='completed'&&current.a===s.config.tiebreakAt&&current.b===s.config.tiebreakAt){s.tiebreak=true;s.tiebreakFirstCursor=s.serviceCursor;}}
function point(s:MatchState,side:SideId,now:number){check(sideOK(side),'得分方无效');s.points[side]++;s.faults=0;const rival=other(side);if(s.tiebreak){if(s.points[side]>=7&&s.points[side]-s.points[rival]>=2){const tally=clone(s.points);game(s,side,now);const won=s.sets.findLast(x=>x.winner&&!x.tiebreakPoints);if(won)won.tiebreakPoints=tally;}return;}if(s.points[side]>=4&&(s.config.deuce==='no-ad'||s.points[side]-s.points[rival]>=2))game(s,side,now);}
function scoreCheck(sets:SetScore[],points:{a:number;b:number},tb:boolean,c:MatchConfig){
 check(Array.isArray(sets)&&sets.length>0&&sets.length<=c.bestOf&&points&&integer(points.a)&&integer(points.b)&&typeof tb==='boolean','比分格式无效');let winner:SideId|undefined;
 for(let i=0;i<sets.length;i++){const set=sets[i];check(set&&integer(set.a,c.gamesPerSet+1)&&integer(set.b,c.gamesPerSet+1),'局数超出当前盘制');const w=setWinner(set,c);if(w){const won=set[w],lost=set[other(w)];check(won===c.gamesPerSet&&lost<=c.gamesPerSet-2||won===c.gamesPerSet+1&&(lost===c.gamesPerSet-1||lost===c.gamesPerSet),'该盘比分不符合抢七盘制');check(!set.winner||set.winner===w,'盘胜方与比分不一致');if(set.tiebreakPoints){const p=set.tiebreakPoints;check(integer(p.a)&&integer(p.b)&&(p[w]===7&&p[other(w)]<=5||p[w]>7&&p[w]-p[other(w)]===2)&&set[w]===c.gamesPerSet+1&&set[other(w)]===c.gamesPerSet,'抢七最终比分无效');}set.winner=w;}else{check(i===sets.length-1&&!set.winner&&!set.tiebreakPoints&&set.a<=c.gamesPerSet&&set.b<=c.gamesPerSet,'只有最后一盘可以尚未结束，且局数不能越过抢七线');}
  const a=sets.slice(0,i+1).filter(x=>x.winner==='a').length,b=sets.slice(0,i+1).filter(x=>x.winner==='b').length;if(a>=Math.ceil(c.bestOf/2)||b>=Math.ceil(c.bestOf/2)){check(i===sets.length-1,'已决出胜负后不能增加额外盘');winner=a>b?'a':'b';}
 }
 const last=sets.at(-1)!;if(winner){check(!tb&&points.a===0&&points.b===0,'完赛后不能留有正在进行的分数');return winner;}
 check(!last.winner,'未决胜比赛须包含当前未结束盘');const mustTB=last.a===c.tiebreakAt&&last.b===c.tiebreakAt;check(tb===mustTB,'平局达到抢七线必须进入抢七，其他局分不能标记抢七');
 if(tb)check(!(Math.max(points.a,points.b)>=7&&Math.abs(points.a-points.b)>=2),'抢七已经结束，须结算该盘');else check(!(Math.max(points.a,points.b)>=4&&(c.deuce==='no-ad'||Math.abs(points.a-points.b)>=2)),'该局已结束，须结算局分');return undefined;
}
function setServer(s:MatchState,id:string){const idx=s.config.serviceOrder.indexOf(id);check(idx>=0,'发球员不在固定名单中');s.serviceCursor=idx;if(s.tiebreak)s.tiebreakFirstCursor=(idx-Math.floor((s.points.a+s.points.b+1)/2)%s.config.serviceOrder.length+s.config.serviceOrder.length)%s.config.serviceOrder.length;}
function restoreCore(s:MatchState,before:CoreState,now:number){const elapsed=matchElapsed(s,now);for(const key of ['winner','endReason']as const)delete s[key];Object.assign(s,clone(before));s.elapsedMs=before.status==='scheduled'?0:elapsed;s.runningSince=before.status==='live'?now:null;}
function lastHistory(s:MatchState,eventId?:string){const h=s.history.at(-1);check(h&&(!eventId||h.eventId===eventId),'该事件不是最近可撤销操作，请先撤销后续操作；较早快照可能已归档');return h;}
export function applyCommand(previous:MatchState,command:Command,now=Date.now()):MatchState{
 check(previous?.version===1&&Number.isFinite(now)&&now>=0&&(!previous.events.length||now>=previous.events.at(-1)!.at),'状态版本或操作时间无效');check(command&&typeof command.type==='string','操作无效');let raw:string;try{raw=JSON.stringify(command);}catch{throw new Error('操作包含循环引用');}check(raw!.length<=30000,'操作内容过大');const s=clone(previous),before=core(s),configBefore=clone(s.config),beforeLabel=describeScore(s);let result='';
 if(command.type==='undo'||command.type==='voidEvent'||command.type==='correctEvent'){
  if(command.type!=='undo')reason(command.reason);const h=lastHistory(s,command.type==='undo'?undefined:command.eventId);const target=s.events.find(e=>e.id===h.eventId)!;s.history.pop();restoreCore(s,h.before,now);if(h.configBefore)s.config=clone(h.configBefore);target.voided=true;
  if(command.type==='correctEvent'){check(!['correctEvent','voidEvent','undo'].includes(command.replacement.type),'更正不能嵌套撤销或更正');const corrected=applyCommand(s,command.replacement,now);const e=corrected.events.at(-1)!;e.replaces=target.id;e.command=clone(command);e.result='更正：'+command.reason+'；'+e.result;corrected.events.find(x=>x.id===target.id)!.correctedBy=e.id;return corrected;}
  result=(command.type==='undo'?'撤销最近操作':'作废事件：'+command.reason)+'；恢复至 '+describeScore(s);
 }else{
  switch(command.type){
   case'configure':check(s.status==='scheduled','仅赛前可配置规则');Object.assign(s,createMatch(command.config),{events:s.events,history:s.history,revision:s.revision});result='更新赛前配置';break;
   case'start':check(s.status==='scheduled','比赛已经开始');check(s.config.penaltyProfile.confirmed,'请先明确确认演示处罚profile');s.status='live';s.runningSince=now;result='开始比赛；'+(s.config.ruleLabel||'演示规则，非赛事正式规程');break;
   case'pause':check(s.status==='live','比赛当前未在进行');freeze(s,now);s.status='paused';result='暂停计时';break;
   case'medical':check(s.status==='live'||s.status==='paused','当前不能进入医疗暂停');freeze(s,now);s.status='medical';result='医疗暂停；不自动结束或自动处罚';break;
   case'resume':check((s.status==='paused'||s.status==='medical')&&!s.serviceReviewRequired,'请先核对发球次序，或当前比赛未暂停');s.status='live';s.runningSince=now;result='恢复比赛';break;
   case'point':check(s.status==='live'&&!s.serviceReviewRequired,'请开赛/恢复并核对发球次序后再记分');point(s,command.sideId,now);result=s.config.sideNames[command.sideId]+'得1分';break;
   case'fault':{check(s.status==='live'&&!s.serviceReviewRequired,'当前不能记录发球失误');check(command.kind===undefined||['service','foot'].includes(command.kind),'发球失误类型无效');const server=s.config.players.find(p=>p.id===serverPlayerId(s))!;if(s.faults===0){s.faults=1;result=(command.kind==='foot'?'一发脚误':'一发失误')+'，改二发';}else{point(s,other(server.sideId),now);result=(command.kind==='foot'?'二发脚误':'双误')+'，'+s.config.sideNames[other(server.sideId)]+'得1分';}break;}
   case'let':case'rallyLet':check(s.status==='live'&&!s.serviceReviewRequired,'当前不能重发');if(command.type==='rallyLet')s.faults=0;result=command.type==='let'?'发球Let：本次发球重发，保留已有一发失误':'整分重赛：恢复一发，不改变已记分数';break;
   case'switchEnds':s.nearSideId=other(s.nearSideId);result='手动交换半场；身份、比分、发球次序及逻辑坐标保持不变';break;
   case'movePlayer':check(Object.hasOwn(s.positions,command.playerId)&&Number.isFinite(command.x)&&command.x>=0&&command.x<=1&&Number.isFinite(command.y)&&command.y>=0&&command.y<=1,'球员或坐标无效（0–1）');s.positions[command.playerId]={x:command.x,y:command.y};result='手动调整'+s.config.players.find(p=>p.id===command.playerId)!.name+'的站位';break;
   case'retire':check(s.status!=='scheduled'&&s.status!=='completed'&&sideOK(command.sideId),'当前不能退赛');reason(command.reason);complete(s,other(command.sideId),'retirement',now);result=s.config.sideNames[command.sideId]+'退赛：'+command.reason+'；对方获胜';break;
   case'finish':check(s.status!=='scheduled'&&s.status!=='completed'&&sideOK(command.winner),'当前不能手动结束');reason(command.reason);complete(s,command.winner,'manual',now);result='手动结束，'+s.config.sideNames[command.winner]+'获胜：'+command.reason;break;
   case'formalPenalty':{check(s.status!=='scheduled'&&s.status!=='completed'&&sideOK(command.sideId),'当前不能处罚');reason(command.reason);const p=s.config.penaltyProfile;check(p.confirmed,'处罚profile尚未确认');const awarded=other(command.sideId);if(command.penalty==='warning')result='明确警告，不改变比分';else if(command.penalty==='point'){check(p.pointPenalty,'当前profile不允许罚分');point(s,awarded,now);result='明确罚1分，'+s.config.sideNames[awarded]+'得分';}else if(command.penalty==='game'){check(p.gamePenalty,'当前profile不允许罚局');game(s,awarded,now,p.gamePenaltyService==='advance');result='明确罚1局，'+s.config.sideNames[awarded]+'得局';if(p.gamePenaltyService==='review'&&!s.winner){freeze(s,now);s.status='paused';s.serviceReviewRequired=true;result+='；已暂停，须人工核对并确认下一发球员';}}else{check(command.penalty==='disqualification'&&p.disqualification,'取消资格操作未获profile允许');complete(s,awarded,'disqualification',now);result=s.config.sideNames[command.sideId]+'取消资格，对方获胜';}result+='：'+command.reason;break;}
   case'confirmService':check(s.serviceReviewRequired&&s.status==='paused','当前没有待核对发球次序');setServer(s,command.serverId);s.serviceReviewRequired=false;result='已人工确认下一发球员，需明确恢复比赛';break;
   case'setServiceOrder':{const last=s.sets.at(-1)!;check(s.status==='scheduled'||s.sets.length>1&&last.a===0&&last.b===0&&s.points.a===0&&s.points.b===0&&!s.tiebreak&&s.status!=='completed','只能赛前或新盘尚未开始时调整队内发球次序');validateOrder(s.config,command.serviceOrder,command.firstServerId);const expected=s.config.players.find(p=>p.id===serverPlayerId(s))?.sideId,chosen=s.config.players.find(p=>p.id===command.firstServerId)!.sideId;check(s.status==='scheduled'||expected===chosen,'新盘先发球队必须接续上盘规则，队内可以重新选择发球员');s.config.serviceOrder=[...command.serviceOrder];s.config.firstServerId=command.firstServerId;s.serviceCursor=s.config.serviceOrder.indexOf(command.firstServerId);s.tiebreakFirstCursor=s.serviceCursor;result='明确设置本盘发球轮次';break;}
   case'correctScore':{check(s.status!=='scheduled'&&(!s.endReason||s.endReason==='score'),'请先撤销退赛、取消资格或手动终止，再校正比分');reason(command.reason);const sets=clone(command.sets),winner=scoreCheck(sets,command.points,command.tiebreak,s.config);s.sets=sets;s.points=clone(command.points);s.tiebreak=command.tiebreak;s.faults=0;s.serviceReviewRequired=false;setServer(s,command.serverId);delete s.winner;delete s.endReason;if(winner)complete(s,winner,'score',now);else{freeze(s,now);s.status='paused';}result='人工校正比分并明确发球员，已暂停待恢复：'+command.reason;break;}
   default:throw new Error('未知比赛操作');
  }
 }
 s.revision=previous.revision+1;const id=crypto.randomUUID();s.events.push({id,revision:s.revision,at:now,type:command.type,command:clone(command),scoreBefore:beforeLabel,scoreAfter:describeScore(s),result,voided:false});
 if(!['undo','voidEvent'].includes(command.type)){s.history.push({eventId:id,before,...(['configure','setServiceOrder'].includes(command.type)?{configBefore}:{})});s.history=s.history.slice(-HISTORY_LIMIT);}
 return s;
}
export function endsChangeDue(s:MatchState):boolean{if(s.status==='scheduled'||s.status==='completed')return false;const lastSwitch=s.events.findLast(e=>e.type==='switchEnds'&&!e.voided);if(lastSwitch?.scoreAfter===describeScore(s))return false;const n=s.points.a+s.points.b;if(s.tiebreak)return n>0&&n%6===0;if(n!==0)return false;const last=s.sets.at(-1)!;if(last.a+last.b>0)return(last.a+last.b)%2===1;const prev=s.sets.at(-2);return Boolean(prev&&(prev.a+prev.b)%2===1);}
function validateCoreSnapshot(s:CoreState,c:MatchConfig){
 check(s&&['scheduled','live','paused','medical','completed'].includes(s.status)&&sideOK(s.nearSideId)&&integer(s.faults,1)&&typeof s.serviceReviewRequired==='boolean'&&Number.isFinite(s.elapsedMs)&&s.elapsedMs>=0&&(s.runningSince===null||Number.isFinite(s.runningSince)&&s.runningSince>=0),'快照状态或计时无效');
 check(s.status==='live'?s.runningSince!==null:s.runningSince===null,'快照计时状态不一致');
 check(integer(s.serviceCursor,c.players.length-1)&&integer(s.tiebreakFirstCursor,c.players.length-1),'快照发球轮次无效');
 check(s.positions&&typeof s.positions==='object'&&Object.keys(s.positions).length===c.players.length,'快照球员坐标名单无效');
 for(const p of c.players){const x=s.positions[p.id];check(x&&Number.isFinite(x.x)&&x.x>=0&&x.x<=1&&Number.isFinite(x.y)&&x.y>=0&&x.y<=1,'快照球员坐标无效');}
 check(s.endReason===undefined||['score','manual','retirement','disqualification'].includes(s.endReason),'快照结束原因无效');
 const winner=scoreCheck(clone(s.sets),s.points,s.tiebreak,c);
 if(s.status==='completed')check(sideOK(s.winner)&&(['retirement','disqualification','manual'].includes(s.endReason||'')||winner===s.winner),'快照完赛结果无效');else check(!s.winner&&!winner&&!s.endReason,'快照状态与盘数胜负不一致');
 check(!s.serviceReviewRequired||s.status==='paused','待核对发球时必须保持暂停');
 if(s.status==='scheduled')check(s.sets.length===1&&s.sets[0].a===0&&s.sets[0].b===0&&s.points.a===0&&s.points.b===0&&!s.tiebreak&&s.faults===0&&s.elapsedMs===0,'未开赛快照不能已有比分或计时');
}
export function restoreSnapshot(snapshot:unknown):MatchState{
 let encoded:string;try{encoded=typeof snapshot==='string'?snapshot:JSON.stringify(snapshot);}catch{throw new Error('快照包含循环引用');}check(typeof encoded==='string'&&encoded.length<=10000000,'快照过大或为空');let value:any;try{value=JSON.parse(encoded);}catch{throw new Error('快照JSON无效');}
 check(value&&value.version===1&&integer(value.revision)&&Array.isArray(value.events)&&value.events.length<=20000&&Array.isArray(value.history)&&value.history.length<=HISTORY_LIMIT,'快照版本或历史无效');
 const s=value as MatchState;validateConfig(s.config);validateCoreSnapshot(s,s.config);
 const ids=new Set(s.events.map(e=>e.id));check(ids.size===s.events.length&&s.events.length===s.revision&&s.events.every((e,i)=>typeof e.id==='string'&&e.id.length>0&&e.revision===i+1&&Number.isFinite(e.at)&&e.at>=0&&(i===0||e.at>=s.events[i-1].at)&&typeof e.voided==='boolean'&&typeof e.result==='string'&&typeof e.scoreBefore==='string'&&typeof e.scoreAfter==='string'),'快照审计事件无效');
 let config=s.config;const seen=new Set<string>();
 for(const h of [...s.history].reverse()){
  check(ids.has(h.eventId)&&!seen.has(h.eventId)&&!s.events.find(e=>e.id===h.eventId)!.voided&&h.before&&Array.isArray(h.before.sets)&&!Object.hasOwn(h.before,'history')&&!Object.hasOwn(h.before,'events'),'历史快照无效或递归');seen.add(h.eventId);
  if(h.configBefore){validateConfig(h.configBefore);config=h.configBefore;}validateCoreSnapshot(h.before,config);
 }
 return s;
}
