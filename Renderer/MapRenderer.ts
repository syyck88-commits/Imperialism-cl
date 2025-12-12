


import { GameMap, TerrainType, TileData } from '../Grid/GameMap';
import { Hex, areHexesEqual, hexToString } from '../Grid/HexMath';
import { City } from '../Entities/City';
import { Unit } from '../Entities/Unit';
import { AssetManager } from './AssetManager';
import { Camera, hexToScreen, ISO_FACTOR } from './RenderUtils';
import { TerrainClustering } from './TerrainClustering';
import { TileDrawer } from './drawers/TileDrawer';
import { CityDrawer } from './drawers/CityDrawer';
import { UnitDrawer } from './drawers/UnitDrawer';
import { OverlayDrawer } from './drawers/OverlayDrawer';
import { TerrainErosion, TerrainSprite } from './assets/TerrainErosion';
import { AnimalManager } from './effects/AnimalManager';

// RenderLayer enum is kept for type compatibility with Drawers, 
// but inside render() we map everything to a unified sorted queue.
enum RenderLayer {
    TERRAIN_BASE = 0,
    INFRASTRUCTURE = 2,
    CONTENT = 3,
    UNIT = 6,
    // Add others if strictly needed by drawers, but we override functionality
    DECAL = 1,
    STRUCTURE = 5
}

interface SortedRenderObject {
    y: number;
    draw: () => void;
}

export class MapRenderer {
    public map: GameMap;
    public hexSize: number;
    public assets: AssetManager;
    public forestData: Map<string, number>;
    public desertData: Map<string, number>;
    public animalManager: AnimalManager;

    // Terrain Sprites (Deserts + Mountains + Hills)
    private terrainSprites: TerrainSprite[] = [];
    
    private hexWidth: number;
    private vertDist: number;
    private horizDist: number;

    constructor(map: GameMap, hexSize: number = 64) {
        this.map = map;
        this.hexSize = hexSize;
        this.assets = new AssetManager();
        this.animalManager = new AnimalManager();
        this.forestData = new Map();
        this.desertData = new Map();

        this.hexWidth = Math.sqrt(3) * this.hexSize;
        // Vertical distance between rows in hex grid
        this.vertDist = (this.hexSize * 1.5) * ISO_FACTOR; 
        this.horizDist = this.hexWidth;
    }

    public async initializeTerrain(onProgress: (pct: number, msg: string) => void) {
        onProgress(5, "Анализ леса...");
        this.forestData = TerrainClustering.analyze(this.map, TerrainType.FOREST);
        this.desertData = TerrainClustering.analyze(this.map, TerrainType.DESERT);
        await this.regenerateTerrain(onProgress);
    }

    public async regenerateTerrain(onProgress: (pct: number, msg: string) => void) {
        this.terrainSprites = await TerrainErosion.generateAll(this.map, this.hexSize, onProgress);
    }

    public update(deltaTime: number) {
        this.animalManager.update(deltaTime);
    }

    public render(
        ctx: CanvasRenderingContext2D,
        camera: Camera,
        cities: City[],
        units: Unit[],
        selectedUnit: Unit | null = null,
        validMoves: Hex[] = [],
        path: Hex[] = [],
        previewHighlightHex: Hex | null = null,
        selectedHex: Hex | null = null,
        time: number = 0,
        windStrength: number = 0.5
    ): void {
        const visibleWorldWidth = camera.width / camera.zoom;
        const visibleWorldHeight = camera.height / camera.zoom;

        const margin = 2; // Small margin for base tiles
        const startRow = Math.floor(camera.y / this.vertDist) - margin;
        const endRow = Math.ceil((camera.y + visibleWorldHeight) / this.vertDist) + margin;
        const startCol = Math.floor(camera.x / this.horizDist) - margin;
        const endCol = Math.ceil((camera.x + visibleWorldWidth) / this.horizDist) + margin;

        const minRow = Math.max(0, startRow);
        const maxRow = Math.min(this.map.height, endRow);
        const minCol = Math.max(0, startCol);
        const maxCol = Math.min(this.map.width, endCol);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // --- LAYER 1: BASE TILES ---
        // Draw the flat ground everywhere. 
        // For tall biomes (Mtn/Hill/Desert/Forest), we draw PLAINS underneath to avoid holes.
        for (let r = minRow; r < maxRow; r++) {
            for (let c = minCol; c < maxCol; c++) {
                const q = c - (r - (r & 1)) / 2;
                if (!this.map.isValid(q, r)) continue;

                const tile = this.map.getTile(q, r);
                if (!tile) continue;

                const tileScreen = hexToScreen(q, r, camera, this.hexSize);

                let visualTerrain = tile.terrain;
                
                // If it's a 3D sprite biome or Forest, use PLAINS as underlay
                if (tile.terrain === TerrainType.MOUNTAIN || 
                    tile.terrain === TerrainType.HILLS || 
                    tile.terrain === TerrainType.DESERT || 
                    tile.terrain === TerrainType.FOREST) {
                    visualTerrain = TerrainType.PLAINS;
                }

                TileDrawer.drawTexturedHex(ctx, tileScreen.x, tileScreen.y, this.hexSize * camera.zoom, visualTerrain, this.assets, {q,r}, this.desertData);
            }
        }

        // --- LAYER 2: LARGE BIOME SPRITES ---
        // Draw all procedural terrain sprites (Mountains, etc).
        // Since we separated biomes in generation, we don't need complex Z-sorting between them.
        // We just draw them on top of base tiles, but BEHIND units/cities.
        
        // Note: terrainSprites array from TerrainErosion contains clusters.
        // We draw them all. Sorting by strict type logic (Desert -> Hill -> Mtn) is ideal, 
        // but here we render them in generation order which typically groups by type anyway.
        for (const sprite of this.terrainSprites) {
            const destX = Math.floor((sprite.x - camera.x) * camera.zoom);
            const destY = Math.floor((sprite.y - camera.y) * camera.zoom);
            const destW = Math.floor(sprite.canvas.width * camera.zoom);
            const destH = Math.floor(sprite.canvas.height * camera.zoom);

            // Simple view culling
            if (destX + destW < 0 || destX > camera.width || 
                destY + destH < 0 || destY > camera.height) continue;

            ctx.drawImage(sprite.canvas, destX, destY, destW, destH);
        }

        // --- LAYER 3: SORTED ENTITIES (Row-by-Row Painter's Algorithm) ---
        // Forests, Infrastructure, Cities, Units, Resources.
        // Optimized: Instead of one global sort, we process row by row.
        
        // 1. Bucket Dynamic Entities by Row for O(N) access inside loop
        const unitsByRow = new Map<number, Unit[]>();
        for (const u of units) {
            const r = Math.round(u.visualPos.r);
            if (!unitsByRow.has(r)) unitsByRow.set(r, []);
            unitsByRow.get(r)!.push(u);
        }

        const citiesByRow = new Map<number, City[]>();
        for (const c of cities) {
            const r = c.location.r;
            if (!citiesByRow.has(r)) citiesByRow.set(r, []);
            citiesByRow.get(r)!.push(c);
        }

        const rowEnqueue = (queue: SortedRenderObject[]) => (depth: number, _layer: any, draw: () => void) => {
            queue.push({ y: depth, draw });
        };

        // 2. Iterate Visible Rows
        for (let r = minRow; r < maxRow; r++) {
            const rowObjectQueue: SortedRenderObject[] = [];
            const enqueue = rowEnqueue(rowObjectQueue);

            // 2.1 Tiles in this row
            for (let c = minCol; c < maxCol; c++) {
                const q = c - (r - (r & 1)) / 2;
                if (!this.map.isValid(q, r)) continue;
                const tile = this.map.getTile(q, r);
                if (!tile) continue;

                const tileScreen = hexToScreen(q, r, camera, this.hexSize);
                
                // Add Infrastructure (Roads)
                TileDrawer.enqueueInfrastructure(enqueue, ctx, {q, r}, tile, camera, this.hexSize, this.assets, this.map, selectedUnit, validMoves);
                
                // Add Content (Resources & FOREST TREES)
                TileDrawer.enqueueContent(
                    enqueue, 
                    ctx, 
                    {q,r}, 
                    tileScreen.y, 
                    tile, 
                    camera, 
                    this.hexSize, 
                    this.assets, 
                    this.animalManager,
                    this.forestData, 
                    this.desertData, 
                    time, 
                    windStrength
                );
            }

            // 2.2 Cities in this row
            const rowCities = citiesByRow.get(r);
            if (rowCities) {
                CityDrawer.enqueueCity(enqueue, ctx, rowCities, camera, this.hexSize, this.assets);
            }

            // 2.3 Units in this row
            const rowUnits = unitsByRow.get(r);
            if (rowUnits) {
                UnitDrawer.enqueueUnits(enqueue, ctx, rowUnits, selectedUnit, camera, this.hexSize, this.assets);
            }

            // 3. Sort & Draw this row immediately
            rowObjectQueue.sort((a, b) => a.y - b.y);
            for (const obj of rowObjectQueue) {
                obj.draw();
            }
        }

        // --- OVERLAYS ---
        // Drawn absolutely last on top of everything
        OverlayDrawer.drawRadiusHighlight(ctx, camera, this.map, this.hexSize, this.assets, previewHighlightHex, selectedHex);
        OverlayDrawer.drawPath(ctx, path, selectedUnit, camera, this.hexSize, this.assets);
        OverlayDrawer.drawSelectionCursor(ctx, camera, this.hexSize, this.assets, selectedHex, selectedUnit);
    }

    public drawHighlight(ctx: CanvasRenderingContext2D, camera: Camera, hex: Hex) {
        OverlayDrawer.drawHighlight(ctx, camera, hex, this.hexSize, this.assets);
    }
}