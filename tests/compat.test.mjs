import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {build,transform} from 'esbuild';

test('embedded-browser compatibility restores scoring, persistence snapshots and UUIDs without modern helpers',async()=>{
 const context=vm.createContext({crypto:{getRandomValues:bytes=>webcrypto.getRandomValues(bytes)}});
 vm.runInContext('globalThis.structuredClone=undefined;Array.prototype.at=undefined;Array.prototype.findLast=undefined;Object.hasOwn=undefined;',context);
 const code=await readFile(new URL('../src/compat.ts',import.meta.url),'utf8');
 const compat=await transform(code,{loader:'ts',format:'iife',target:'es2020'});
 vm.runInContext(compat.code,context);
 const engine=await build({entryPoints:[new URL('../lib/umpire-engine.ts',import.meta.url).pathname],bundle:true,platform:'browser',format:'iife',globalName:'Engine',write:false,target:'es2020'});
 vm.runInContext(engine.outputFiles[0].text,context);
 const result=vm.runInContext(`(()=>{const c=Engine.defaultDemoConfig();c.penaltyProfile.confirmed=true;let s=Engine.createMatch(c);s=Engine.applyCommand(s,{type:'start'},1);s=Engine.applyCommand(s,{type:'point',sideId:'a'},2);s=Engine.restoreSnapshot(JSON.stringify(s));const first=Engine.scoreLabels(s).a;s=Engine.applyCommand(s,{type:'undo'},3);return JSON.stringify({first,undo:Engine.scoreLabels(s).a,uuid:crypto.randomUUID(),negative:[1,2,3].at(-1),find:[1,2,3].findLast(x=>x<3)});})()`,context);
 const r=JSON.parse(result);assert.equal(r.first,'15');assert.equal(r.undo,'0');assert.equal(r.negative,3);assert.equal(r.find,2);assert.match(r.uuid,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
