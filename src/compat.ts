/** Compatibility for common embedded browsers. Only JSON-domain match data is cloned. */
const define=(target:object,name:PropertyKey,value:unknown)=>Object.defineProperty(target,name,{value,writable:true,configurable:true});
if(!Array.prototype.at)define(Array.prototype,'at',function<T>(this:T[],index:number){const n=Math.trunc(Number(index)||0);return this[n<0?this.length+n:n];});
if(!Array.prototype.findLast)define(Array.prototype,'findLast',function<T>(this:T[],fn:(value:T,index:number,array:T[])=>unknown,thisArg?:unknown){for(let i=this.length-1;i>=0;i--)if(fn.call(thisArg,this[i],i,this))return this[i];return undefined;});
if(!Object.hasOwn)define(Object,'hasOwn',(object:object,key:PropertyKey)=>Object.prototype.hasOwnProperty.call(object,key));
if(!globalThis.structuredClone)define(globalThis,'structuredClone',function<T>(value:T):T{
 const seen=new WeakMap<object,unknown>();
 const copy=(item:any):any=>{if(item===null||typeof item!=='object')return item;if(seen.has(item))return seen.get(item);if(item instanceof Date)return new Date(item.getTime());const out:any=Array.isArray(item)?[]:{};seen.set(item,out);Object.keys(item).forEach(key=>Object.defineProperty(out,key,{value:copy(item[key]),writable:true,enumerable:true,configurable:true}));return out;};
 return copy(value);
});
if(globalThis.crypto&&!globalThis.crypto.randomUUID)define(globalThis.crypto,'randomUUID',()=>{const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;});
export {};
