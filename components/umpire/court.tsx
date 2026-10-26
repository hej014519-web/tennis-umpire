'use client';

import {useEffect,useId,useRef,useState,type CSSProperties,type KeyboardEvent,type PointerEvent} from 'react';
import './court.css';

export type CourtPlayer={id:string;name:string;side:'a'|'b';x:number;y:number};
export type UmpireCourtProps={
  players:CourtPlayer[];
  servingPlayerId:string;
  mode:'singles'|'doubles';
  endsSwapped:boolean;
  viewRotated:boolean;
  /** True when the parent rotates the entire application by 180 degrees. */
  displayInverted?:boolean;
  disabled?:boolean;
  onMove:(id:string,x:number,y:number)=>void|Promise<boolean>;
};

type Point={x:number;y:number};
type Preview=Point&{id:string;settled?:boolean};
type Drag={id:string;pointerId:number;target:HTMLButtonElement;origin:Point;offset:Point;startX:number;startY:number;moved:boolean};
type KeyMove={id:string;origin:Point;point:Point};
const VIEW={width:800,height:460};
// Every normalized position uses the full doubles rectangle, including singles mode.
// x=0/1: left/right baseline. y=0/1: upper/lower doubles sideline.
const COURT={left:50,width:700,top:(VIEW.height-700*10.97/23.77)/2,height:700*10.97/23.77};
const SINGLES_INSET=(10.97-8.23)/2/10.97;
const SERVICE_DISTANCE=6.4/23.77*COURT.width;
const clamp=(n:number)=>Math.min(1,Math.max(0,Number.isFinite(n)?n:0.5));
const cleanPoint=(p:Point):Point=>({x:clamp(p.x),y:clamp(p.y)});
function displayPoint(p:Point,endsSwapped:boolean,viewRotated:boolean):Point{
  return endsSwapped!==viewRotated?{x:1-p.x,y:1-p.y}:{x:p.x,y:p.y};
}
// The same mirror is its own inverse. It never mutates a player's stored position.
const dataPoint=displayPoint;
function pointerDisplayPoint(clientX:number,clientY:number,rect:Pick<DOMRect,'left'|'top'|'width'|'height'>,displayInverted:boolean):Point{
  let x=(clientX-rect.left)/Math.max(rect.width,1),y=(clientY-rect.top)/Math.max(rect.height,1);
  // Bounding rectangles do not retain the parent's 180-degree rotation.
  if(displayInverted){x=1-x;y=1-y;}
  return{x:(x*VIEW.width-COURT.left)/COURT.width,y:(y*VIEW.height-COURT.top)/COURT.height};
}
const changed=(a:Point,b:Point)=>Math.abs(a.x-b.x)>0.00001||Math.abs(a.y-b.y)>0.00001;
function monogram(name:string){const parts=name.trim().split(/\s+/);if(parts.length>1&&/^[A-Za-z]/.test(parts[0]))return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();return Array.from(name.trim()).slice(0,1).join('')||'·';}
function release(drag:Drag|null){if(!drag)return;try{if(drag.target.hasPointerCapture(drag.pointerId))drag.target.releasePointerCapture(drag.pointerId);}catch{/* Capture may already have ended after cancellation. */}}
function Ball(){return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M5 5c11 3 3 11 14 14M19 5C8 8 16 16 5 19"/></svg>;}

export default function UmpireCourt({players,servingPlayerId,mode,endsSwapped,viewRotated,displayInverted=false,disabled=false,onMove}:UmpireCourtProps){
  const [selectedId,setSelectedId]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[announcement,setAnnouncement]=useState('');
  const board=useRef<HTMLDivElement>(null),drag=useRef<Drag|null>(null),keyMove=useRef<KeyMove|null>(null);
  const previewVersion=useRef(0);
  const id=useId().replace(/:/g,'');
  const instructionsId='ump-court-instructions-'+id,netId='ump-court-net-'+id;
  const selected=players.find(p=>p.id===selectedId),serving=players.find(p=>p.id===servingPlayerId);
  const mirrored=endsSwapped!==viewRotated;
  useEffect(()=>{
    // A view/ends change or a temporary lock cancels only the unfinished gesture.
    const current=drag.current;drag.current=null;keyMove.current=null;release(current);clearPreview();
  },[disabled,endsSwapped,viewRotated,displayInverted]);
  useEffect(()=>{
    if(selectedId&&!players.some(p=>p.id===selectedId))setSelectedId('');
    if(drag.current&&!players.some(p=>p.id===drag.current!.id)){const old=drag.current;drag.current=null;release(old);clearPreview();}
    if(keyMove.current&&!players.some(p=>p.id===keyMove.current!.id)){keyMove.current=null;clearPreview();}
    if(preview&&!players.some(p=>p.id===preview.id))clearPreview();
  },[players,selectedId]);
  // Clear acknowledged previews after React commits the authoritative player props.
  useEffect(()=>{if(preview?.settled)setPreview(null);},[preview]);
  useEffect(()=>()=>{previewVersion.current++;release(drag.current);drag.current=null;keyMove.current=null;},[]);

  function clearPreview(){previewVersion.current++;setPreview(null);}
  function commit(playerId:string,origin:Point,point:Point){
    const next=cleanPoint(point);if(!changed(origin,next)){clearPreview();return;}
    const version=++previewVersion.current;
    setPreview({id:playerId,...next});
    const settle=(saved:boolean|void)=>{
      if(version!==previewVersion.current)return;
      if(saved===false){clearPreview();return;}
      setPreview(current=>current?.id===playerId?{...current,settled:true}:current);
      const player=players.find(p=>p.id===playerId),shown=displayPoint(next,endsSwapped,viewRotated);
      setAnnouncement(`${player?.side==='a'?'A':'B'}方${player?.name||'球员'}站位已调整，画面横向${Math.round(shown.x*100)}%，纵向${Math.round(shown.y*100)}%。`);
    };
    // Only the local marker is previewed; scores and match state still await confirmation.
    try{Promise.resolve(onMove(playerId,next.x,next.y)).then(settle,()=>settle(false));}
    catch{settle(false);}
  }
  function positionFromPointer(clientX:number,clientY:number,offset:Point={x:0,y:0}){
    const rect=board.current?.getBoundingClientRect();if(!rect)return null;
    const p=pointerDisplayPoint(clientX,clientY,rect,displayInverted);
    return dataPoint(cleanPoint({x:p.x+offset.x,y:p.y+offset.y}),endsSwapped,viewRotated);
  }
  function select(player:CourtPlayer){setSelectedId(player.id);setAnnouncement(`已选中${player.side==='a'?'A':'B'}方${player.name}，可点击球场落点、拖动或使用方向键调整。`);}
  function startDrag(e:PointerEvent<HTMLButtonElement>,player:CourtPlayer){
    if(disabled||!e.isPrimary||e.button!==0)return;
    e.stopPropagation();e.preventDefault();e.currentTarget.focus({preventScroll:true});select(player);
    const old=drag.current;drag.current=null;release(old);keyMove.current=null;clearPreview();
    const rect=board.current?.getBoundingClientRect();if(!rect)return;
    const origin=cleanPoint(player),shown=displayPoint(origin,endsSwapped,viewRotated),pointer=pointerDisplayPoint(e.clientX,e.clientY,rect,displayInverted);
    drag.current={id:player.id,pointerId:e.pointerId,target:e.currentTarget,origin,offset:{x:shown.x-pointer.x,y:shown.y-pointer.y},startX:e.clientX,startY:e.clientY,moved:false};
    try{e.currentTarget.setPointerCapture(e.pointerId);}catch{drag.current=null;}
  }
  function moveDrag(e:PointerEvent<HTMLButtonElement>){
    const current=drag.current;if(!current||current.pointerId!==e.pointerId||disabled)return;
    e.stopPropagation();
    if(!current.moved&&Math.hypot(e.clientX-current.startX,e.clientY-current.startY)<5)return;
    current.moved=true;
    const next=positionFromPointer(e.clientX,e.clientY,current.offset);if(next)setPreview({id:current.id,...next});
  }
  function finishDrag(e:PointerEvent<HTMLButtonElement>){
    const current=drag.current;if(!current||current.pointerId!==e.pointerId)return;e.stopPropagation();
    const moved=current.moved||Math.hypot(e.clientX-current.startX,e.clientY-current.startY)>=5;
    const next=positionFromPointer(e.clientX,e.clientY,current.offset);
    drag.current=null;release(current);
    if(moved&&next&&!disabled)commit(current.id,current.origin,next);else clearPreview();
  }
  function cancelDrag(e:PointerEvent<HTMLButtonElement>){
    const current=drag.current;if(!current||current.pointerId!==e.pointerId)return;
    drag.current=null;release(current);clearPreview();
  }
  function finishKeyboard(){const current=keyMove.current;if(!current)return;keyMove.current=null;if(!disabled)commit(current.id,current.origin,current.point);else clearPreview();}
  function keyboard(e:KeyboardEvent<HTMLButtonElement>,player:CourtPlayer){
    if(disabled)return;
    if(e.key==='Escape'){e.preventDefault();keyMove.current=null;const old=drag.current;drag.current=null;release(old);clearPreview();setSelectedId('');setAnnouncement('已取消站位调整。');return;}
    const directions:Record<string,Point>={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1}};
    const direction=directions[e.key];if(!direction)return;e.preventDefault();e.stopPropagation();
    if(drag.current)return;
    if(!keyMove.current)previewVersion.current++;
    setSelectedId(player.id);
    const current=keyMove.current?.id===player.id?keyMove.current:{id:player.id,origin:cleanPoint(player),point:cleanPoint(player)};
    const shown=displayPoint(current.point,endsSwapped,viewRotated),step=e.shiftKey?0.08:0.02;
    current.point=dataPoint(cleanPoint({x:shown.x+direction.x*step,y:shown.y+direction.y*step}),endsSwapped,viewRotated);
    keyMove.current=current;setPreview({id:player.id,...current.point});
  }
  function clickCourt(e:React.MouseEvent<HTMLDivElement>){
    if(disabled||!selected||drag.current||keyMove.current||(e.target as Element).closest('button'))return;
    const next=positionFromPointer(e.clientX,e.clientY);if(next)commit(selected.id,cleanPoint(selected),next);
  }
  const leftSide=mirrored?'b':'a',rightSide=mirrored?'a':'b';
  return <section className={'ump-court-root'+(disabled?' ump-court-root--disabled':'')} aria-label={mode==='doubles'?'双打手动站位球场':'单打手动站位球场'}>
    <div className="ump-court-component-heading"><div><span className="ump-court-eyebrow">COURT POSITION</span><h3>球场站位 <span>{mode==='doubles'?'双打':'单打'}</span></h3></div><span className="ump-court-manual-label">手动示意</span></div>
    <div className="ump-court-view-status" role="status" aria-live="polite" aria-atomic="true" aria-label="球场显示状态">
      <span className={endsSwapped?'ump-court-state ump-court-state--active':'ump-court-state'}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h13m-3-3 3 3-3 3M17 14H4m3-3-3 3 3 3"/></svg>{endsSwapped?'已交换比赛端':'比赛端未交换'}</span>
      <span className={viewRotated||displayInverted?'ump-court-state ump-court-state--active':'ump-court-state'}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6a7 7 0 1 1-1 6M4 2v5h5"/></svg>{displayInverted?(viewRotated?'整屏倒转 · 球场 180°':'整屏倒转视角'):viewRotated?'球场视角 180°':'标准视角'}</span>
    </div>
    <div className={'ump-court-board ump-court-board--'+mode} ref={board} onClick={clickCourt} role="group" aria-label="点击球员后选择站位落点" aria-describedby={instructionsId}>
      <svg className="ump-court-surface" viewBox="0 0 800 460" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        <defs><pattern id={netId} width="5" height="8" patternUnits="userSpaceOnUse"><path d="M0 0H5M0 0V8" className="ump-court-net-weave"/></pattern></defs>
        <rect width="800" height="460" rx="14" className="ump-court-surround"/>
        <rect x={COURT.left} y={COURT.top} width={COURT.width} height={COURT.height} className="ump-court-playing-area"/>
        {mode==='singles'&&<><rect x={COURT.left} y={COURT.top} width={COURT.width} height={COURT.height*SINGLES_INSET} className="ump-court-inactive-alley"/><rect x={COURT.left} y={COURT.top+COURT.height*(1-SINGLES_INSET)} width={COURT.width} height={COURT.height*SINGLES_INSET} className="ump-court-inactive-alley"/></>}
        <rect x={COURT.left} y={COURT.top} width={COURT.width} height={COURT.height} className={'ump-court-line ump-court-doubles-line'+(mode==='singles'?' ump-court-line--muted':'')}/>
        <path d={`M${COURT.left} ${COURT.top+COURT.height*SINGLES_INSET}H${COURT.left+COURT.width}M${COURT.left} ${COURT.top+COURT.height*(1-SINGLES_INSET)}H${COURT.left+COURT.width}`} className="ump-court-line ump-court-singles-line"/>
        <path d={`M${400-SERVICE_DISTANCE} ${COURT.top+COURT.height*SINGLES_INSET}V${COURT.top+COURT.height*(1-SINGLES_INSET)}M${400+SERVICE_DISTANCE} ${COURT.top+COURT.height*SINGLES_INSET}V${COURT.top+COURT.height*(1-SINGLES_INSET)}M${400-SERVICE_DISTANCE} 230H${400+SERVICE_DISTANCE}`} className="ump-court-line"/>
        <path d={`M${COURT.left} 230h6M${COURT.left+COURT.width} 230h-6`} className="ump-court-line"/>
        <rect x="396" y={COURT.top-13} width="8" height={COURT.height+26} className="ump-court-net-shadow"/>
        <rect x="397" y={COURT.top-10} width="6" height={COURT.height+20} fill={`url(#${netId})`}/>
        <path d={`M400 ${COURT.top-10}V${COURT.top+COURT.height+10}`} className="ump-court-net-tape"/>
        <circle cx="400" cy={COURT.top-12} r="4" className="ump-court-net-post"/><circle cx="400" cy={COURT.top+COURT.height+12} r="4" className="ump-court-net-post"/>
        <text x="400" y="32" textAnchor="middle" className="ump-court-net-caption">NET</text>
        <text x="400" y="437" textAnchor="middle" className="ump-court-dimensions">23.77 m × {mode==='doubles'?'10.97':'8.23'} m</text>
      </svg>
      <span className={'ump-court-end-label ump-court-end-label--left ump-court-end-label--'+leftSide}>{leftSide.toUpperCase()} 方</span><span className={'ump-court-end-label ump-court-end-label--right ump-court-end-label--'+rightSide}>{rightSide.toUpperCase()} 方</span>
      {players.map(player=>{
        const p=preview?.id===player.id?preview:cleanPoint(player),shown=displayPoint(p,endsSwapped,viewRotated),selected=selectedId===player.id,isServing=servingPlayerId===player.id,isDragging=drag.current?.id===player.id&&!!preview;
        const style={left:((COURT.left+shown.x*COURT.width)/VIEW.width*100)+'%',top:((COURT.top+shown.y*COURT.height)/VIEW.height*100)+'%'} as CSSProperties;
        const classes=['ump-court-player','ump-court-player--'+player.side,selected?'ump-court-player--selected':'',isDragging||keyMove.current?.id===player.id?'ump-court-player--moving':'',shown.y>.77?'ump-court-player--name-above':'',shown.x<.16?'ump-court-player--name-start':shown.x>.84?'ump-court-player--name-end':''].filter(Boolean).join(' ');
        return <button key={player.id} type="button" className={classes} style={style} disabled={disabled} aria-label={`${player.side.toUpperCase()}方 ${player.name}${isServing?'，发球员':''}，可用方向键调整站位`} aria-pressed={selected} aria-describedby={instructionsId} data-player-id={player.id} onPointerDown={e=>startDrag(e,player)} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onClick={e=>{e.stopPropagation();if(!disabled)select(player);}} onKeyDown={e=>keyboard(e,player)} onKeyUp={e=>{if(e.key.startsWith('Arrow')){e.preventDefault();finishKeyboard();}}} onBlur={finishKeyboard}>
          <span className="ump-court-player-face"><span className="ump-court-side-code">{player.side.toUpperCase()}</span><span className="ump-court-player-initials" aria-hidden="true">{monogram(player.name)}</span></span>
          {isServing&&<span className="ump-court-serving" title="发球员" aria-hidden="true"><Ball/></span>}
          <span className="ump-court-player-name" title={player.name}>{player.name||'待命名球员'}</span>
        </button>;
      })}
    </div>
    <div className="ump-court-legend"><span className="ump-court-legend-side ump-court-legend-side--a"><i/>A 方</span><span className="ump-court-legend-side ump-court-legend-side--b"><i/>B 方</span><span className="ump-court-legend-serve"><Ball/>{serving?`${serving.name} 发球`:'发球员待指定'}</span></div>
    <div className="ump-court-help" id={instructionsId}><span className="ump-court-selection">{disabled?'站位调整已锁定':selected?`已选 ${selected.side.toUpperCase()}方 · ${selected.name}`:'点选一名球员'}</span><p>{disabled?'当前可查看双方手动站位。':'点选球员后点击球场，或按住球员拖动；松手保存。方向键微调，Shift 加速，Esc 取消。'}</p></div>
    <span className="ump-court-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </section>;
}

export {UmpireCourt};
