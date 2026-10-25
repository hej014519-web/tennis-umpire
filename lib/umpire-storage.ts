import {restoreSnapshot,type MatchState} from './umpire-engine';

export const UMPIRE_STORAGE_KEY='startline:tennis-umpire:public:v1';
export type ViewEvent={at:number;label:string};
export type UmpireSession={schema:1;match:MatchState;title:string;court:string;inverted:boolean;viewEvents:ViewEvent[];savedAt:number;writeId:string};
/** Replace this boundary with a versioned, authenticated match API for official matches.
 * Position feeds must separately declare manual/GPS/video provenance; demo coordinates are manual.
 */
export interface MatchDataAdapter {load():UmpireSession|null;save(session:UmpireSession):void;}
export function restoreSession(raw:string):UmpireSession {
 const v=JSON.parse(raw);
 if(v?.schema!==1||typeof v.title!=='string'||v.title.length>120||typeof v.court!=='string'||v.court.length>60||typeof v.inverted!=='boolean'||!Array.isArray(v.viewEvents)||v.viewEvents.length>1000||v.viewEvents.some((e:ViewEvent)=>!Number.isFinite(e.at)||typeof e.label!=='string'||e.label.length>200)||!Number.isFinite(v.savedAt)||typeof v.writeId!=='string')throw Error('记录格式不兼容，请保留备份后新建演示比赛。');
 return {...v,match:restoreSnapshot(v.match)};
}
export const browserMatchAdapter:MatchDataAdapter={
 load(){const raw=localStorage.getItem(UMPIRE_STORAGE_KEY);return raw?restoreSession(raw):null;},
 save(session){localStorage.setItem(UMPIRE_STORAGE_KEY,JSON.stringify(session));},
};
