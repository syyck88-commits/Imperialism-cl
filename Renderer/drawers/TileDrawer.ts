
import { GameMap, TerrainType, TileData, ImprovementType, ResourceType } from '../../Grid/GameMap';
import { Hex, areHexesEqual } from '../../Grid/HexMath';
import { Unit } from '../../Entities/Unit';
import { AssetManager } from '../AssetManager';
import { Camera, hexToScreen, ISO_FACTOR, RenderLayer } from '../RenderUtils';
import { AnimalManager } from '../effects/AnimalManager';

// Sub-drawers
// ALIASING IMPORT TO PREVENT RECURSION BUG
import { drawTexturedHex as drawBaseTerrain, drawForestTile } from './TerrainDrawer';
import { drawTileContent } from './ContentDrawer';
import { drawTileConnections, isConnectable } from './InfrastructureDrawer';

type EnqueueFn = (depth: number, layer: RenderLayer, draw: () => void) => void;

export class TileDrawer {
    
    public static enqueueInfrastructure(
        enqueue: EnqueueFn,
        ctx: CanvasRenderingContext2D,
        hex: Hex,
        tile: TileData,
        camera: Camera,
        hexSize: number,
        assets: AssetManager,
        map: GameMap,
        selectedUnit: Unit | null,
        validMoves: Hex[]
    ) {
        const { x, y } = hexToScreen(hex.q, hex.r, camera, hexSize);
        
        if (isConnectable(tile)) {
            enqueue(y, RenderLayer.INFRASTRUCTURE, () => drawTileConnections(map, hex, camera, hexSize)(ctx));
        }

        if (selectedUnit && validMoves.some(vm => areHexesEqual(vm, hex))) {
            enqueue(y, RenderLayer.INFRASTRUCTURE, () => {
                const currentHexSize = hexSize * camera.zoom;
                const uiDrawW = Math.ceil(Math.sqrt(3) * currentHexSize);
                const uiDrawH = Math.ceil((2 * currentHexSize * ISO_FACTOR) + 4);
                ctx.drawImage(
                    assets.uiSprites,
                    assets.uiMap.move.x * assets.uiTileW, 0, assets.uiTileW, assets.uiTileH,
                    x - uiDrawW/2, y - uiDrawH/2, uiDrawW, uiDrawH
                );
            });
        }
    }

    public static enqueueContent(
        enqueue: EnqueueFn,
        ctx: CanvasRenderingContext2D,
        hex: Hex,
        depthY: number,
        tile: TileData,
        camera: Camera,
        hexSize: number,
        assets: AssetManager,
        animalManager: AnimalManager,
        forestData?: Map<string, number>,
        desertData?: Map<string, number>,
        time: number = 0,
        windStrength: number = 0.5
    ) {
        // Procedural Forest
        if (tile.terrain === TerrainType.FOREST) {
            enqueue(depthY, RenderLayer.CONTENT, () => drawForestTile(hex, tile, camera, hexSize, assets, forestData, time, windStrength)(ctx));
            return;
        }

        // DESERT content only (resources/improvements). 
        // We DO NOT draw the desert tile base here, that is handled by the global map.
        // But if there is oil or a road on sand, we draw it here.

        const hasVisibleContent = 
            (tile.isProspected && tile.improvement === ImprovementType.NONE && tile.resource === ResourceType.NONE) ||
            (tile.resource !== ResourceType.NONE && !tile.isHidden) ||
            (tile.improvement !== ImprovementType.NONE && tile.improvement !== ImprovementType.ROAD && tile.improvement !== ImprovementType.RAILROAD && tile.improvement !== ImprovementType.CITY);
        
        if (hasVisibleContent) {
            enqueue(depthY, RenderLayer.CONTENT, () => drawTileContent(hex, tile, camera, hexSize, assets, animalManager)(ctx));
        }
    }

    public static drawTexturedHex(
        ctx: CanvasRenderingContext2D, 
        x: number, 
        y: number, 
        size: number, 
        type: TerrainType,
        assets: AssetManager,
        hex?: Hex,
        desertData?: Map<string, number>
    ) {
        // Delegate to specific terrain drawer (using the alias to avoid recursion)
        drawBaseTerrain(ctx, x, y, size, type, assets);
    }
}
