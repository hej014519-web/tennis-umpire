import type {SideId} from './umpire-engine';

const NORMAL_SIDES=Object.freeze(['a','b'] as const);
const REVERSED_SIDES=Object.freeze(['b','a'] as const);

/**
 * Visible team order, left to right on a horizontal court and top to bottom on
 * a vertical court. Match end changes and camera rotation each reverse that
 * order; together they cancel. Only presentation changes: use each returned
 * SideId to read scores, players and service, and as the scoring command target.
 */
export function courtDisplaySides(nearSideId:SideId,inverted:boolean):readonly [SideId,SideId]{
 return (nearSideId==='b')!==inverted?REVERSED_SIDES:NORMAL_SIDES;
}
