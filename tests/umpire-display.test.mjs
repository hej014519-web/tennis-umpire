import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function loadModule(path){
 const result=await build({entryPoints:[new URL(path,import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const [D,E]=await Promise.all([loadModule('../lib/umpire-display.ts'),loadModule('../lib/umpire-engine.ts')]);

function liveMatch(mode){
 const config=E.defaultDemoConfig(mode);
 config.penaltyProfile={...config.penaltyProfile,confirmed:true};
 let state=E.applyCommand(E.createMatch(config),{type:'start'},1);
 for(const [index,sideId] of ['a','a','b'].entries())state=E.applyCommand(state,{type:'point',sideId},index+2);
 return state;
}
function scoreboard(state,inverted){
 const labels=E.scoreLabels(state),serverId=E.serverPlayerId(state);
 return D.courtDisplaySides(state.nearSideId,inverted).map(sideId=>({
  sideId,
  names:state.config.players.filter(player=>player.sideId===sideId).map(player=>player.name).sort(),
  points:labels[sideId],
  games:state.sets.at(-1)[sideId],
  serving:state.config.players.find(player=>player.id===serverId)?.sideId===sideId,
  scoreCommand:{type:'point',sideId}
 }));
}

for(const [nearSideId,inverted,expected] of [
 ['a',false,['a','b']],
 ['a',true,['b','a']],
 ['b',false,['b','a']],
 ['b',true,['a','b']]
]){
 test(`court display order: near ${nearSideId}, rotated ${inverted}`,()=>{
  const sides=D.courtDisplaySides(nearSideId,inverted);
  assert.deepEqual(sides,expected);
  assert.equal(new Set(sides).size,2);
  assert.ok(Object.isFrozen(sides),'shared display order cannot be changed by its caller');
 });
}

for(const mode of ['singles','doubles']){
 test(`${mode}: end changes and rotation move the whole score/button identity together`,()=>{
  const initial=liveMatch(mode),before=structuredClone(initial);
  const normal=scoreboard(initial,false);
  assert.deepEqual(normal.map(row=>[row.sideId,row.points,row.serving]),[['a','30',true],['b','15',false]]);
  assert.deepEqual(scoreboard(initial,true),[normal[1],normal[0]]);
  assert.deepEqual(initial,before,'reading the display never mutates the match');

  const switched=E.applyCommand(initial,{type:'switchEnds'},10);
  assert.deepEqual(scoreboard(switched,false),[normal[1],normal[0]]);
  assert.deepEqual(scoreboard(switched,true),normal,'end change plus view rotation restores visual order');
  assert.deepEqual(switched.points,initial.points);
  assert.deepEqual(switched.sets,initial.sets);
  assert.deepEqual(switched.config.players,initial.config.players);
  assert.equal(E.serverPlayerId(switched),E.serverPlayerId(initial));

  // After the visual swap, the first button belongs to B and must still send B.
  const firstButton=scoreboard(switched,false)[0];
  const scored=E.applyCommand(switched,firstButton.scoreCommand,11);
  assert.deepEqual(scored.points,{a:2,b:2});
  assert.equal(firstButton.sideId,'b');
  assert.equal(scoreboard(scored,false)[0].points,'30');

  const twice=E.applyCommand(switched,{type:'switchEnds'},12);
  assert.deepEqual(scoreboard(twice,false),normal);
  let inverted=false;
  inverted=!inverted;inverted=!inverted;
  assert.deepEqual(scoreboard(initial,inverted),normal);
 });
}

test('team-mate position swaps never change display teams, scoring targets or service ownership',()=>{
 const initial=liveMatch('doubles');
 for(const nearSideId of ['a','b'])for(const inverted of [false,true]){
  let state={...initial,nearSideId};
  const expected=scoreboard(state,inverted);
  const slotOrder=match=>['a','b'].map(sideId=>match.config.players.filter(player=>player.sideId===sideId).sort((p,q)=>match.positions[p.id].y-match.positions[q.id].y).map(player=>player.id));
  for(const [index,sideId] of ['a','b','b','a'].entries()){
   state=E.applyCommand(state,{type:'swapTeamPositions',sideId},10+index);
   assert.deepEqual(scoreboard(state,inverted),expected);
   assert.equal(E.serverPlayerId(state),E.serverPlayerId(initial));
   assert.deepEqual(state.points,initial.points);
  }
  assert.deepEqual(slotOrder(state),slotOrder(initial));
 }
});

test('player-list order cannot reassign the team displayed beside a score button',()=>{
 for(const mode of ['singles','doubles']){
  const state=liveMatch(mode),reordered=structuredClone(state);
  reordered.config.players.reverse();
  for(const inverted of [false,true])assert.deepEqual(scoreboard(reordered,inverted),scoreboard(state,inverted));
 }
});
