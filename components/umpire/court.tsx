'use client';

import {useId,useRef,useState,type CSSProperties} from 'react';
import './court.css';

export type CourtPlayer={id:string;name:string;side:'a'|'b';x:number;y:number};
export type UmpireCourtProps={
  players:CourtPlayer[];
  servingPlayerId:string;
  mode:'singles'|'doubles';
  endsSwapped:boolean;
  viewRotated:boolean;
  projection?:'2d'|'2.5d';
  disabled?:boolean;
  onSwapTeam:(side:'a'|'b')=>void|Promise<boolean>;
};

type Point={x:number;y:number};
const VIEW={width:790,height:400};
// Geometry follows the full doubles rectangle; saved positions select a fixed slot only.
const COURT={left:35,width:720,top:(VIEW.height-720*10.97/23.77)/2,height:720*10.97/23.77};
const CENTER={x:VIEW.width/2,y:VIEW.height/2};
const SINGLES_INSET=(10.97-8.23)/2/10.97;
const SERVICE_DISTANCE=6.4/23.77*COURT.width;
function Ball(){return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M5 5c11 3 3 11 14 14M19 5C8 8 16 16 5 19"/></svg>;}
function Avatar(){return <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" className="ump-court-avatar-background"/><circle cx="20" cy="14" r="6" className="ump-court-avatar-person"/><path d="M8 34c0-8 5-13 12-13s12 5 12 13" className="ump-court-avatar-person"/></svg>;}

export default function UmpireCourt({players,servingPlayerId,mode,endsSwapped,viewRotated,projection='2d',disabled=false,onSwapTeam}:UmpireCourtProps){
  const [announcement,setAnnouncement]=useState('');
  const pending=useRef(false);
  const id=useId().replace(/:/g,'');
  const instructionsId='ump-court-instructions-'+id,netId='ump-court-net-'+id,standingNetId='ump-court-standing-net-'+id;
  const bySide={a:players.filter(player=>player.side==='a').sort((a,b)=>a.y-b.y),b:players.filter(player=>player.side==='b').sort((a,b)=>a.y-b.y)};
  const viewStyle={'--ump-court-view-angle':viewRotated?'180deg':'0deg'} as CSSProperties;

  function fixedPoint(player:CourtPlayer):Point{
    const teammates=bySide[player.side],slot=teammates.findIndex(teammate=>teammate.id===player.id);
    const point={x:player.side==='a'?.18:.82,y:mode==='doubles'&&teammates.length>1?(slot===0?.26:.74):.5};
    // Changing match ends mirrors the playing positions, independently of camera rotation.
    return endsSwapped?{x:1-point.x,y:1-point.y}:point;
  }
  function swapTeam(side:'a'|'b'){
    if(disabled||pending.current||mode!=='doubles'||bySide[side].length!==2)return;
    pending.current=true;
    const settle=(saved:boolean|void)=>{
      pending.current=false;
      if(saved!==false)setAnnouncement(`${side.toUpperCase()}方两名球员的示意站位已交换；发球和接发顺序保持不变。`);
    };
    try{Promise.resolve(onSwapTeam(side)).then(settle,()=>settle(false));}
    catch{settle(false);}
  }

  return <section className={'ump-court-root'+(disabled?' ump-court-root--disabled':'')} aria-label={mode==='doubles'?'双打球场':'单打球场'}>
    <div className={'ump-court-board ump-court-board--'+mode+(projection==='2.5d'?' ump-court-board--perspective':'')} style={viewStyle} role="group" aria-label={mode==='doubles'?'点击球员，交换同队示意站位':'单打球场'} aria-describedby={instructionsId} data-view-rotated={viewRotated?'true':'false'} data-ends-swapped={endsSwapped?'true':'false'} data-projection={projection} data-camera-tilt={projection==='2.5d'?'42':'0'} data-display-order={endsSwapped!==viewRotated?'b,a':'a,b'}>
      <div className="ump-court-camera">
      <div className="ump-court-plane">
        <div className="ump-court-edge ump-court-edge--top" aria-hidden="true"/>
        <div className="ump-court-edge ump-court-edge--bottom" aria-hidden="true"/>
        <div className="ump-court-edge ump-court-edge--left" aria-hidden="true"/>
        <div className="ump-court-edge ump-court-edge--right" aria-hidden="true"/>
        <svg className="ump-court-surface" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
          <defs><pattern id={netId} width="5" height="8" patternUnits="userSpaceOnUse"><path d="M0 0H5M0 0V8" className="ump-court-net-weave"/></pattern></defs>
          <rect width={VIEW.width} height={VIEW.height} rx="10" className="ump-court-surround"/>
          <rect x={COURT.left} y={COURT.top} width={COURT.width} height={COURT.height} className="ump-court-playing-area"/>
          {mode==='singles'&&<><rect x={COURT.left} y={COURT.top} width={COURT.width} height={COURT.height*SINGLES_INSET} className="ump-court-inactive-alley"/><rect x={COURT.left} y={COURT.top+COURT.height*(1-SINGLES_INSET)} width={COURT.width} height={COURT.height*SINGLES_INSET} className="ump-court-inactive-alley"/></>}
          <rect x={COURT.left} y={COURT.top} width={COURT.width} height={COURT.height} className={'ump-court-line ump-court-doubles-line'+(mode==='singles'?' ump-court-line--muted':'')}/>
          <path d={`M${COURT.left} ${COURT.top+COURT.height*SINGLES_INSET}H${COURT.left+COURT.width}M${COURT.left} ${COURT.top+COURT.height*(1-SINGLES_INSET)}H${COURT.left+COURT.width}`} className="ump-court-line ump-court-singles-line"/>
          <path d={`M${CENTER.x-SERVICE_DISTANCE} ${COURT.top+COURT.height*SINGLES_INSET}V${COURT.top+COURT.height*(1-SINGLES_INSET)}M${CENTER.x+SERVICE_DISTANCE} ${COURT.top+COURT.height*SINGLES_INSET}V${COURT.top+COURT.height*(1-SINGLES_INSET)}M${CENTER.x-SERVICE_DISTANCE} ${CENTER.y}H${CENTER.x+SERVICE_DISTANCE}`} className="ump-court-line"/>
          <path d={`M${COURT.left} ${CENTER.y}h6M${COURT.left+COURT.width} ${CENTER.y}h-6`} className="ump-court-line"/>
          <rect x={CENTER.x-4} y={COURT.top-13} width="8" height={COURT.height+26} className="ump-court-net-shadow"/>
          <g className="ump-court-flat-net">
            <rect x={CENTER.x-3} y={COURT.top-10} width="6" height={COURT.height+20} fill={`url(#${netId})`}/>
            <path d={`M${CENTER.x} ${COURT.top-10}V${COURT.top+COURT.height+10}`} className="ump-court-net-tape"/>
            <circle cx={CENTER.x} cy={COURT.top-12} r="4" className="ump-court-net-post"/><circle cx={CENTER.x} cy={COURT.top+COURT.height+12} r="4" className="ump-court-net-post"/>
          </g>
        </svg>
        <svg className="ump-court-upright-net" style={{left:'50%',top:(COURT.top-10)/VIEW.height*100+'%',width:(COURT.height+20)/VIEW.width*100+'%',height:38/VIEW.height*100+'%'}} viewBox="0 0 360 38" preserveAspectRatio="none" aria-hidden="true" data-net-plane="upright">
          <defs><pattern id={standingNetId} width="8" height="6" patternUnits="userSpaceOnUse"><path d="M0 0H8M0 0V6" className="ump-court-standing-net-weave"/></pattern></defs>
          <path d="M0 0H360V36Q180 29 0 36Z" className="ump-court-standing-net-fill"/>
          <path d="M0 0H360V36Q180 29 0 36Z" fill={`url(#${standingNetId})`}/>
          <path d="M0 36Q180 29 360 36" className="ump-court-standing-net-tape"/>
          <path d="M0 0V38M360 0V38" className="ump-court-standing-net-post"/>
        </svg>
        {players.map(player=>{
          const shown=fixedPoint(player),isServing=servingPlayerId===player.id,canSwap=mode==='doubles'&&bySide[player.side].length===2;
          const style={left:((COURT.left+shown.x*COURT.width)/VIEW.width*100)+'%',top:((COURT.top+shown.y*COURT.height)/VIEW.height*100)+'%'} as CSSProperties;
          return <button key={player.id} type="button" className={'ump-court-player ump-court-player--'+player.side+(isServing?' ump-court-player--serving':'')} style={style} disabled={disabled||!canSwap} aria-label={`${player.side.toUpperCase()}方 ${player.name}${isServing?'，发球员':''}${canSwap?'，点击与同队球员换位':'，固定站位'}`} aria-describedby={instructionsId} data-player-id={player.id} data-side-id={player.side} data-fixed-slot={bySide[player.side].findIndex(teammate=>teammate.id===player.id)} onClick={()=>swapTeam(player.side)}>
            <span className="ump-court-player-avatar" aria-hidden="true"><Avatar/></span>
            <span className="ump-court-player-name" title={player.name}>{player.name||'待命名球员'}</span>
            {isServing&&<span className="ump-court-serving" title="发球员"><Ball/><span className="ump-court-sr-only">发球</span></span>}
          </button>;
        })}
      </div>
      </div>
    </div>
    <span className="ump-court-sr-only" id={instructionsId}>{mode==='doubles'?'点击任一球员可交换该队两人的固定示意位置，不改变正式发球和接发顺序。站位为示意，没有接入实时定位。':'球员固定示意站位，没有接入实时定位。'}</span>
    <span className="ump-court-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </section>;
}

export {UmpireCourt};
