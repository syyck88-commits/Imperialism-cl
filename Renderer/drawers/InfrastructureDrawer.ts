
import { GameMap, TileData, ImprovementType } from '../../Grid/GameMap';
import { Hex, getHexNeighbors } from '../../Grid/HexMath';
import { Camera, hexToScreen } from '../RenderUtils';

export function isConnectable(t: TileData): boolean {
    return t.improvement === ImprovementType.ROAD || 
        t.improvement === ImprovementType.RAILROAD || 
        t.improvement === ImprovementType.CITY || 
        t.improvement === ImprovementType.DEPOT ||
        t.improvement === ImprovementType.PORT ||
        t.improvement === ImprovementType.MINE ||
        t.improvement === ImprovementType.FARM ||
        t.improvement === ImprovementType.LUMBER_MILL ||
        t.improvement === ImprovementType.RANCH ||
        t.improvement === ImprovementType.PLANTATION ||
        t.improvement === ImprovementType.OIL_WELL;
}

export function drawTileConnections(map: GameMap, hex: Hex, camera: Camera, hexSize: number) {
    return (ctx: CanvasRenderingContext2D) => {
        const { x, y } = hexToScreen(hex.q, hex.r, camera, hexSize);
        
        ctx.lineWidth = Math.max(2, 6 * camera.zoom); 
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#64748b'; 

        const neighbors = getHexNeighbors(hex);
        
        ctx.beginPath();
        for (const n of neighbors) {
            if (!map.isValid(n.q, n.r)) continue;
            
            const nTile = map.getTile(n.q, n.r);
            if (nTile && isConnectable(nTile)) {
                const nPos = hexToScreen(n.q, n.r, camera, hexSize);
                const midX = (x + nPos.x) / 2;
                const midY = (y + nPos.y) / 2;
                ctx.moveTo(x, y);
                ctx.lineTo(midX, midY);
            }
        }
        ctx.stroke();
    };
}
