
import { GameMap, TerrainType, TileData } from '../Grid/GameMap';
import { Hex, areHexesEqual, hexToString } from '../Grid/HexMath';
import { City } from '../Entities/City';
import { Unit } from '../Entities/Unit';
import { AssetManager } from './AssetManager';
import { Camera, hexToScreen, ISO_FACTOR, RenderLayer } from './RenderUtils';
import { TerrainClustering } from './TerrainClustering';
import { TileDrawer } from './drawers/TileDrawer';
import { CityDrawer } from './drawers/CityDrawer';
import { UnitDrawer } from './drawers/UnitDrawer';
import { OverlayDrawer } from './drawers/OverlayDrawer';
import { TerrainErosion, TerrainSprite } from './assets/TerrainErosion';
import { AnimalManager } from './effects/AnimalManager';

// Reusable type for render function to avoid closure creation overhead
type RenderFn = () => void;

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

    // Optimization: Pools and caches
    private _unitsByRow: Map<number, Unit[]> = new Map();
    private _citiesByRow: Map<number, City[]> = new Map();
    
    // Fixed buckets for one row to avoid sorting. 
    // Indices match RenderLayer enum.
    private _rowBuckets: Array<RenderFn[]> = [[], [], [], [], [], []];

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
        const zoom = camera.zoom;
        const hexSizeZoom = this.hexSize * zoom;
        const visibleWorldWidth = camera.width / zoom;
        const visibleWorldHeight = camera.height / zoom;

        // Optimization: Pre-calculate constants for loop
        const margin = 2; 
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
        // Drawn directly without queueing for speed, as they are the background.
        for (let r = minRow; r < maxRow; r++) {
            for (let c = minCol; c < maxCol; c++) {
                const q = c - (r - (r & 1)) / 2;
                if (!this.map.isValid(q, r)) continue;

                const tile = this.map.getTile(q, r);
                if (!tile) continue;

                // Optimization: Inline hexToScreen math to avoid object allocation
                const worldX = this.hexSize * Math.sqrt(3) * (q + r/2);
                const worldY = (this.hexSize * 1.5 * r) * ISO_FACTOR;
                const screenX = worldX * zoom - camera.x * zoom;
                const screenY = worldY * zoom - camera.y * zoom;

                let visualTerrain = tile.terrain;
                
                // If it's a 3D sprite biome or Forest, use PLAINS/Base as underlay
                if (tile.terrain === TerrainType.MOUNTAIN || 
                    tile.terrain === TerrainType.HILLS || 
                    tile.terrain === TerrainType.DESERT || 
                    tile.terrain === TerrainType.FOREST) {
                    visualTerrain = TerrainType.PLAINS;
                }

                // Optimization: Use cached canvas drawer
                TileDrawer.drawTexturedHex(ctx, screenX, screenY, hexSizeZoom, visualTerrain, this.assets, {q,r}, this.desertData);
            }
        }

        // --- LAYER 2: LARGE BIOME SPRITES ---
        // Optimization: Strict Culling before Draw
        const camRight = camera.width;
        const camBottom = camera.height;

        for (const sprite of this.terrainSprites) {
            const destW = Math.floor(sprite.canvas.width * zoom);
            const destH = Math.floor(sprite.canvas.height * zoom);
            const destX = Math.floor((sprite.x - camera.x) * zoom);
            const destY = Math.floor((sprite.y - camera.y) * zoom);

            // Simple view culling
            if (destX > camRight || destY > camBottom || destX + destW < 0 || destY + destH < 0) continue;

            ctx.drawImage(sprite.canvas, destX, destY, destW, destH);
        }

        // --- LAYER 3: SORTED ENTITIES (Bucketed Row-by-Row) ---
        
        // 1. Clear and Populate Pools
        this._unitsByRow.clear();
        this._citiesByRow.clear();

        for (const u of units) {
            const r = Math.round(u.visualPos.r);
            if (!this._unitsByRow.has(r)) this._unitsByRow.set(r, []);
            this._unitsByRow.get(r)!.push(u);
        }

        for (const c of cities) {
            const r = c.location.r;
            if (!this._citiesByRow.has(r)) this._citiesByRow.set(r, []);
            this._citiesByRow.get(r)!.push(c);
        }

        // Optimization: Re-use enqueue closure
        const enqueue = (depth: number, layer: RenderLayer, draw: RenderFn) => {
            // We ignore depth inside the bucket because within a single row, 
            // the layer order (Terrain -> Infra -> Content -> Unit) determines occlusion.
            this._rowBuckets[layer].push(draw);
        };

        // 2. Iterate Visible Rows
        for (let r = minRow; r < maxRow; r++) {
            // Clear buckets for this row
            for(let i=0; i<6; i++) {
                this._rowBuckets[i].length = 0;
            }

            // 2.1 Tiles in this row
            for (let c = minCol; c < maxCol; c++) {
                const q = c - (r - (r & 1)) / 2;
                if (!this.map.isValid(q, r)) continue;
                const tile = this.map.getTile(q, r);
                if (!tile) continue;

                // Manual hexToScreen again for speed
                const worldX = this.hexSize * Math.sqrt(3) * (q + r/2);
                const worldY = (this.hexSize * 1.5 * r) * ISO_FACTOR;
                const screenY = worldY * zoom - camera.y * zoom; // Used for depth, but irrelevant in bucket logic

                // Add Infrastructure (Roads)
                TileDrawer.enqueueInfrastructure(enqueue, ctx, {q, r}, tile, camera, this.hexSize, this.assets, this.map, selectedUnit, validMoves);
                
                // Add Content (Resources & FOREST TREES)
                TileDrawer.enqueueContent(
                    enqueue, 
                    ctx, 
                    {q,r}, 
                    screenY, 
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
            const rowCities = this._citiesByRow.get(r);
            if (rowCities) {
                CityDrawer.enqueueCity(enqueue, ctx, rowCities, camera, this.hexSize, this.assets);
            }

            // 2.3 Units in this row
            const rowUnits = this._unitsByRow.get(r);
            if (rowUnits) {
                UnitDrawer.enqueueUnits(enqueue, ctx, rowUnits, selectedUnit, camera, this.hexSize, this.assets);
            }

            // 3. Draw buckets in order (0 to 5)
            // No sorting needed!
            for(let i=0; i<6; i++) {
                const bucket = this._rowBuckets[i];
                const len = bucket.length;
                for(let j=0; j<len; j++) {
                    bucket[j]();
                }
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
