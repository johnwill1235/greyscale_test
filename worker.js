console.log('Worker script loaded.');

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

const state = {
    map: {
        width: 0,
        height: 0,
        imageData: null,
        elevationGrid: null, // Stores elevation for land, -1 for water
        roadUsageGrid: null, // Track how many times each pixel has been used for roads
        cityInfluenceGrid: null, // NEW: Pre-calculated grid for city proximity
    },
    cities: [],
    minPopulation: 0,
    maxPopulation: 0,
    pgw: null,
    currentRegion: 'china', // Track current region
    // FPS control
    targetFPS: 120,
    lastFrameTime: 0,
    // Dynamic paths
    currentPaths: {
        cities: 'data/china/cities.geojson',
        map: 'data/china/map.png',
        pgw: 'data/china/map.pgw'
    }
};

function parsePgw(text) {
    const lines = text.trim().split('\n');
    return {
        a: parseFloat(lines[0]), // pixel size x
        d: parseFloat(lines[1]), // rotation y
        b: parseFloat(lines[2]), // rotation x
        e: parseFloat(lines[3]), // pixel size y (negative)
        c: parseFloat(lines[4]), // top-left x
        f: parseFloat(lines[5]), // top-left y
    };
}

function lonLatToPixel(lon, lat) {
    if (!state.pgw) {
        throw new Error('PGW data not loaded yet.');
    }
    const { a, b, c, d, e, f } = state.pgw;

    // Inverse of:
    // lon = a * x + b * y + c
    // lat = d * x + e * y + f
    // Since b and d are 0 in our file, it's simpler:
    // x = (lon - c) / a
    // y = (lat - f) / e

    const x = (lon - c) / a;
    const y = (lat - f) / e;

    return { x, y };
}

async function loadRegionData(citiesPath, mapPath, pgwPath) {
    try {
        postMessage({ type: 'log', payload: 'Loading region data...' });

        const [citiesResponse, pgwResponse] = await Promise.all([
            fetch(citiesPath),
            fetch(pgwPath)
        ]);

        if (!citiesResponse.ok || !pgwResponse.ok) {
            throw new Error('Failed to fetch data files.');
        }

        const citiesData = await citiesResponse.json();
        const pgwText = await pgwResponse.text();
        
        state.pgw = parsePgw(pgwText);

        // Handle different GeoJSON structures for USA vs China
        state.cities = citiesData.features.map(feature => {
            const [lon, lat] = feature.geometry.coordinates;
            const { x, y } = lonLatToPixel(lon, lat);
            
            // USA uses 'City' and 'Population' (capital), China uses 'city_ascii' and 'population' (lowercase)
            const cityName = feature.properties.city_ascii || feature.properties.City || feature.properties.city || 'Unknown';
            const population = feature.properties.population || feature.properties.Population || 1;
            
            return {
                name: cityName,
                population: population,
                lon,
                lat,
                x,
                y,
            };
        });

        // Calculate min/max population
        if (state.cities.length > 0) {
            const populations = state.cities.map(c => c.population);
            state.minPopulation = Math.min(...populations);
            state.maxPopulation = Math.max(...populations);
            postMessage({ type: 'log', payload: `Population range: ${state.minPopulation} to ${state.maxPopulation}` });
        }

        postMessage({ type: 'citiesData', payload: state.cities });
        postMessage({ type: 'log', payload: 'City data processed.' });
        
        // Now load the map image to build the cost grid
        const mapImageResponse = await fetch(mapPath);
        if (!mapImageResponse.ok) {
            throw new Error('Failed to fetch map image.');
        }
        const imageBlob = await mapImageResponse.blob();
        const imageBitmap = await createImageBitmap(imageBlob);

        state.map.width = imageBitmap.width;
        state.map.height = imageBitmap.height;
        
        // Use an OffscreenCanvas to get image data
        const canvas = new OffscreenCanvas(state.map.width, state.map.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0);
        state.map.imageData = ctx.getImageData(0, 0, state.map.width, state.map.height);
        
        postMessage({ type: 'log', payload: 'Map image data loaded.' });

        createCostGrid();
        postMessage({ type: 'log', payload: 'Cost grid created.' });

        postMessage({ type: 'log', payload: 'Region data loaded successfully!' });
        console.log('Worker state:', state);

    } catch (error) {
        postMessage({ type: 'log', payload: `Error loading region data: ${error.message}` });
        console.error(error);
    }
}

async function setup() {
    // Load initial region (China)
    await loadRegionData(
        state.currentPaths.cities,
        state.currentPaths.map,
        state.currentPaths.pgw
    );
}

function createCostGrid() {
    const { width, height, imageData } = state.map;
    const data = imageData.data;
    const elevationGrid = new Float32Array(width * height);
    const roadUsageGrid = new Uint16Array(width * height); // Track usage count per pixel
    const cityInfluenceGrid = new Float32Array(width * height).fill(Infinity);

    const waterThreshold = 10; // Threshold to decide if a color is not grey

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const pixelIndex = i / 4;

        // Check if the pixel is greyscale (land) or colored (water)
        const isGrey = Math.abs(r - g) < waterThreshold && Math.abs(g - b) < waterThreshold;

        if (isGrey) {
            // Land: store the greyscale value (0-255). Lower value = higher elevation.
            elevationGrid[pixelIndex] = r;
        } else {
            // Water: mark with a special value.
            elevationGrid[pixelIndex] = -1; // Sentinel for water
        }
        roadUsageGrid[pixelIndex] = 0; // Initialize usage count
    }
    
    // Pre-calculate city influence using a multi-source Breadth-First Search (BFS)
    // This avoids calling getNearbyCity repeatedly during pathfinding.
    const queue = [];
    state.cities.forEach(city => {
        const x = Math.round(city.x);
        const y = Math.round(city.y);
        if (x >= 0 && x < width && y >= 0 && y < height) {
            const index = y * width + x;
            cityInfluenceGrid[index] = 0;
            queue.push(index);
        }
    });

    let head = 0;
    const searchRadius = 5; // Same radius as the old getNearbyCity
    while (head < queue.length) {
        const u = queue[head++];
        const u_dist = cityInfluenceGrid[u];

        if (u_dist >= searchRadius) continue; // Performance: stop searching beyond the radius

        const neighbors = getNeighbors(u, width, height);
        for (const neighbor of neighbors) {
            const v = neighbor.index;
            if (cityInfluenceGrid[v] === Infinity) {
                const newDist = u_dist + (neighbor.isDiagonal ? Math.SQRT2 : 1);
                if (newDist <= searchRadius) {
                    cityInfluenceGrid[v] = newDist;
                    queue.push(v);
                }
            }
        }
    }
    
    state.map.elevationGrid = elevationGrid;
    state.map.roadUsageGrid = roadUsageGrid;
    state.map.cityInfluenceGrid = cityInfluenceGrid;

    // We don't need the image data anymore, so we can release it
    state.map.imageData = null;
}

class PriorityQueue {
    constructor() {
        this.heap = [];
    }

    enqueue(element, priority) {
        this.heap.push({ element, priority });
        this.bubbleUp(this.heap.length - 1);
    }

    dequeue() {
        const min = this.heap[0];
        const end = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = end;
            this.sinkDown(0);
        }
        return min.element;
    }

    isEmpty() {
        return this.heap.length === 0;
    }

    bubbleUp(n) {
        const element = this.heap[n];
        while (n > 0) {
            const parentN = Math.floor((n - 1) / 2);
            const parent = this.heap[parentN];
            if (element.priority >= parent.priority) break;
            this.heap[parentN] = element;
            this.heap[n] = parent;
            n = parentN;
        }
    }

    sinkDown(n) {
        const length = this.heap.length;
        const element = this.heap[n];
        const elemPriority = element.priority;

        while (true) {
            let child2N = (n + 1) * 2;
            let child1N = child2N - 1;
            let swap = null;
            let child1, child2;

            if (child1N < length) {
                child1 = this.heap[child1N];
                if (child1.priority < elemPriority) {
                    swap = child1N;
                }
            }

            if (child2N < length) {
                child2 = this.heap[child2N];
                if (child2.priority < (swap === null ? elemPriority : child1.priority)) {
                    swap = child2N;
                }
            }

            if (swap === null) break;

            this.heap[n] = this.heap[swap];
            this.heap[swap] = element;
            n = swap;
        }
    }
}

function getNeighbors(index, width, height) {
    const neighbors = [];
    const x = index % width;
    const y = Math.floor(index / width);

    // 8-directional movement
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            if (i === 0 && j === 0) continue;
            const nx = x + j;
            const ny = y + i;

            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                const neighborIndex = ny * width + nx;
                const isDiagonal = (i !== 0 && j !== 0);
                neighbors.push({ index: neighborIndex, isDiagonal, i, j });
            }
        }
    }
    return neighbors;
}

function calculateGeometricLength(path) {
    if (!path || path.length < 2) return 0;
    const { width } = state.map;
    let geometricPathLength = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const u_idx = path[i];
        const v_idx = path[i+1];

        const u_x = u_idx % width;
        const u_y = Math.floor(u_idx / width);
        const v_x = v_idx % width;
        const v_y = Math.floor(v_idx / width);

        const dx = Math.abs(u_x - v_x);
        const dy = Math.abs(u_y - v_y);

        if (dx === 1 && dy === 1) { // Diagonal move
            geometricPathLength += Math.SQRT2;
        } else { // Straight move
            geometricPathLength += 1;
        }
    }
    return geometricPathLength;
}

function findNearestCity(pixelIndex) {
    const { width } = state.map;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    let nearestCity = null;
    let minDistanceSq = Infinity;

    state.cities.forEach(city => {
        const dx = x - city.x;
        const dy = y - city.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < minDistanceSq) {
            minDistanceSq = distanceSq;
            nearestCity = city;
        }
    });
    return nearestCity;
}

async function findPath(startCity, endCity) {
    const { width, height, elevationGrid, roadUsageGrid, cityInfluenceGrid } = state.map;
    const startX = Math.round(startCity.x);
    const startY = Math.round(startCity.y);
    const endX = Math.round(endCity.x);
    const endY = Math.round(endCity.y);

    const startIndex = startY * width + startX;
    const endIndex = endY * width + endX;

    // Calculate straight-line distance for reference
    const straightLineDistance = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
    
    postMessage({ 
        type: 'log', 
        payload: `🔍 Starting pathfinding: ${startCity.name} → ${endCity.name} | Distance: ${Math.floor(straightLineDistance)} pixels | Map: ${width}x${height}` 
    });

    const pq = new PriorityQueue();
    const distances = new Float32Array(width * height).fill(Infinity);
    const predecessors = new Int32Array(width * height).fill(-1); // Simple index storage - much more efficient
    const visited = new Uint8Array(width * height); // More memory efficient than Set - 0 = unvisited, 1 = visited
    
    distances[startIndex] = 0;
    pq.enqueue(startIndex, 0);

    // Debug starting position
    postMessage({ 
        type: 'log', 
        payload: `🔍 Start position: (${startX}, ${startY}) | End position: (${endX}, ${endY})` 
    });

    let count = 0;
    let processedCount = 0; // Track actual processing, not just queue operations
    let visitedCount = 0; // Track visited nodes efficiently
    const visitedForUpdate = [];
    let lastUpdateCount = 0;
    let queueSizeWarning = false;
    
    // Progress tracking for long-distance paths  
    const isLongDistance = straightLineDistance > 1000;
    let bestDistanceToTarget = straightLineDistance;
    let progressCheckInterval = 100000;
    let lastProgressCheck = 0;
    let stuckCounter = 0; // Count how many times we haven't made progress
    let smoothedQueueSize = 0; // Smoothed queue size to prevent jumpiness
    
    const startTime = performance.now();

    while (!pq.isEmpty()) {
        const u = pq.dequeue();

        // Skip if already processed (prevents reprocessing expensive nodes)
        if (visited[u] === 1) {
            count++;
            continue;
        }
        visited[u] = 1;
        visitedCount++;



        // Regular step logging for debugging
        if (count % 50000 === 0) { // Reduced frequency of this log
            const queueSize = pq.heap.length;
            const efficiency = processedCount > 0 ? (count / processedCount).toFixed(2) : 0;
            postMessage({ 
                type: 'log', 
                payload: `Steps: ${count} | Processed: ${processedCount} | Queue: ${queueSize} | Visited: ${visitedCount}` 
            });
        }

        // Progress monitoring for long-distance paths
        if (isLongDistance && count - lastProgressCheck >= progressCheckInterval) {
            const currentX = u % width;
            const currentY = Math.floor(u / width);
            const currentDistanceToTarget = Math.sqrt((endX - currentX) ** 2 + (endY - currentY) ** 2);
            
            if (currentDistanceToTarget < bestDistanceToTarget) {
                bestDistanceToTarget = currentDistanceToTarget;
                const progress = ((straightLineDistance - bestDistanceToTarget) / straightLineDistance * 100).toFixed(1);
                postMessage({ 
                    type: 'log', 
                    payload: `🎯 Progress update: ${progress}% complete | Distance remaining: ${Math.floor(bestDistanceToTarget)} pixels` 
                });
            }
            lastProgressCheck = count;
        }

        if (u === endIndex) {
            // Path found, reconstruct it
            const path = [];
            let current = endIndex;
            while (current !== -1) {
                path.unshift(current);
                current = predecessors[current];
            }
            
            const geometricPathLength = calculateGeometricLength(path);

            // Performance metrics
            const endTime = performance.now();
            const totalTime = (endTime - startTime).toFixed(2);
            const efficiency = (geometricPathLength / straightLineDistance);
            const stepsPerPixel = (count / geometricPathLength).toFixed(1);
            
            postMessage({ 
                type: 'log', 
                payload: `✅ Path found! | Length: ${geometricPathLength.toFixed(1)} pixels | Steps: ${count} | Processed: ${processedCount} | Time: ${totalTime}ms | Efficiency: ${efficiency.toFixed(2)}x straight line | ${stepsPerPixel} steps/pixel` 
            });
            
            // Clear any remaining tendril updates
            if (visitedForUpdate.length > 0) {
                 postMessage({ type: 'pathfindingUpdate', payload: visitedForUpdate.slice() });
            }
            return {path, efficiency};
        }
        
        visitedForUpdate.push(u);
        count++;
        processedCount++;

        // Smooth queue size tracking to prevent jumpy behavior
        const queueSize = pq.heap.length;
        smoothedQueueSize = smoothedQueueSize * 0.95 + queueSize * 0.05; // Exponential smoothing
        
        // Monitor queue size for performance issues
        if (!queueSizeWarning && smoothedQueueSize > 50000) {
            postMessage({ type: 'log', payload: `Large queue detected (avg: ${Math.floor(smoothedQueueSize)} items) - encountering high-cost terrain` });
            queueSizeWarning = true;
        }

        // Linear increase in update frequency
        const baseUpdateFrequency = isLongDistance ? 200 : 100;
        const linearIncrement = isLongDistance ? 2 : 1;
        const maxUpdateFrequency = isLongDistance ? 2000 : 1000;
        
        const currentUpdateFrequency = Math.min(
            maxUpdateFrequency, 
            baseUpdateFrequency + Math.floor(processedCount / 1000) * linearIncrement
        );

        if (count - lastUpdateCount >= currentUpdateFrequency) {
            const currentTime = performance.now();
            const frameDelay = 1000 / state.targetFPS;
            
            // Only send update if enough time has passed for target FPS
            if (currentTime - state.lastFrameTime >= frameDelay) {
                postMessage({ type: 'pathfindingUpdate', payload: visitedForUpdate.slice() });
                visitedForUpdate.length = 0;
                lastUpdateCount = count;
                state.lastFrameTime = currentTime;
                
                // Wait for next frame to maintain target FPS
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        const uDist = distances[u];
        const neighbors = getNeighbors(u, width, height);

        // Debug first node's neighbors (to understand why queue might be empty)
        if (count === 1) {
            postMessage({ 
                type: 'log', 
                payload: `🔍 First node neighbors: ${neighbors.length} neighbors found at position (${u % width}, ${Math.floor(u / width)})` 
            });
            neighbors.forEach((neighbor, i) => {
                const neighborX = neighbor.index % width;
                const neighborY = Math.floor(neighbor.index / width);
                postMessage({ 
                    type: 'log', 
                    payload: `   Neighbor ${i}: (${neighborX}, ${neighborY}) | Diagonal: ${neighbor.isDiagonal}` 
                });
            });
        }

        for (const neighbor of neighbors) {
            const v = neighbor.index;
            
            // Skip if already visited (major optimization for high-cost areas)
            if (visited[v] === 1) {
                continue;
            }
            
            const currentElevation = elevationGrid[u];
            const neighborElevation = elevationGrid[v];

            let moveCost;

            // Step 1: Calculate the base cost from terrain, regardless of roads.
            if (neighborElevation === -1) {
                // Water/river cost varies by region - USA has lower river costs
                moveCost = state.currentRegion === 'usa' ? 3.0 : 15.0;
            } 
            else {
                const baseCost = 1.0;
                // Region-specific terrain factors - USA has less terrain impact
                const uphillFactor = state.currentRegion === 'usa' ? 2.0 : 5.0;
                const downhillFactor = state.currentRegion === 'usa' ? 0.3 : 0.5;

                // New logic: higher 'r' value (lighter color) means higher elevation.
                // elevationDiff > 0 is uphill, < 0 is downhill.
                const elevationDiff = neighborElevation - currentElevation;

                if (elevationDiff > 0) { // Uphill
                    moveCost = baseCost + uphillFactor * elevationDiff;
                } else { // Downhill or flat
                    // elevationDiff is negative or zero, so this applies a discount
                    moveCost = baseCost + downhillFactor * elevationDiff;
                }
                
                // Ensure cost is never zero or negative
                moveCost = Math.max(0.1, moveCost);
            }

            // Step 2: If a road exists, apply an efficiency discount.
            const usageCount = roadUsageGrid[v];
            if (usageCount > 0) {
                const maxUses = 12; // 12 * 2.5% = 30%
                const actualUses = Math.min(usageCount, maxUses);
                const efficiency = actualUses * 0.025; // 0.025 to 0.30
                moveCost *= (1 - efficiency); // Apply discount
            }

            // Step 3: Apply a "city buff" using the pre-calculated influence grid.
            const cityDistance = cityInfluenceGrid[v];
            if (cityDistance < 15) { // 50 is the radius used in the pre-calculation
                const cityFactor = 0.8; // Apply a 40% cost reduction
                moveCost *= (1 - cityFactor);
            }


            // Step 4: Account for diagonal distance.
            if (neighbor.isDiagonal) {
                moveCost *= Math.SQRT2;
            }

            const newDist = uDist + moveCost;
            
            // More conservative high-cost filtering to prevent getting stuck
            if (moveCost >= 80 && distances[v] !== Infinity && newDist > distances[v] * 1.05) {
                continue;
            }

            if (newDist < distances[v]) {
                distances[v] = newDist;
                predecessors[v] = u;
                pq.enqueue(v, newDist);
            }
        }
    }

    // This should never be reached since paths always exist
}

function updateCostGridWithRoad(path) {
    const { roadUsageGrid } = state.map;
    if (!roadUsageGrid) {
        console.warn('Road usage grid not available for update.');
        return;
    }

    for (const pixelIndex of path) {
        if (roadUsageGrid[pixelIndex] < 65535) { // Prevent overflow
            roadUsageGrid[pixelIndex]++;
        }
    }
}

function weightedRandom(items) {
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    let random = Math.random() * totalWeight;

    for (const item of items) {
        if (random < item.weight) {
            return item.item;
        }
        random -= item.weight;
    }
    return items[items.length - 1].item;
}

function pickStartCity() {
    if (!state.cities || state.cities.length === 0) {
        return null;
    }
    
    const weightedCities = state.cities.map(city => ({
        item: city,
        weight: city.population || 1 // Ensure no zero weights
    }));
    
    const selected = weightedRandom(weightedCities);
    postMessage({ type: 'log', payload: `Selected start city: ${selected?.name} (pop: ${selected?.population})` });
    return selected;
}

function pickEndCity(startCity) {
    if (!startCity || !state.cities || state.cities.length < 2) {
        return null;
    }
    
    const weightedCities = state.cities
        .filter(city => city.name !== startCity.name)
        .map(city => {
            const dx = city.x - startCity.x;
            const dy = city.y - startCity.y;
            // Add 1 to avoid division by zero
            const distance = Math.sqrt(dx * dx + dy * dy) + 1;

            // Favor population, but penalize distance.
            // The distance penalty is softened (sqrt) to allow for some long-distance connections.
            const population = city.population || 1; // Ensure no zero populations
            const weight = population / Math.sqrt(distance);

            return { item: city, weight };
        });
    
    if (weightedCities.length === 0) return null;
    
    const selected = weightedRandom(weightedCities);
    postMessage({ type: 'log', payload: `Selected end city: ${selected?.name} (pop: ${selected?.population})` });
    return selected;
}

let nextPathResolver = null;
function waitForNextPath() {
    return new Promise(resolve => {
        nextPathResolver = resolve;
    });
}

async function simulationLoop() {
    postMessage({ type: 'log', payload: 'Starting simulation loop.' });

    let isFirstPath = true;
    while(true) {
        const loopStartTime = performance.now();
        
        if (!isFirstPath) {
            await waitForNextPath();
        }
        isFirstPath = false;

        // Validate we have cities before trying to pick them
        if (!state.cities || state.cities.length === 0) {
            postMessage({ type: 'log', payload: 'No cities available, waiting...' });
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }

        const startCity = pickStartCity();
        const endCity = pickEndCity(startCity);
        
        postMessage({ type: 'log', payload: `Picked cities: ${startCity?.name} -> ${endCity?.name}` });

        if (startCity && endCity) {
            postMessage({ type: 'log', payload: `${'='.repeat(80)}` });
            postMessage({ type: 'findingPath', payload: { from: startCity.name, to: endCity.name } });
            
            try {
                const result = await findPath(startCity, endCity);

                if (result) {
                    const {path, efficiency} = result;
                    
                    // Get usage data for each pixel in the path
                    const pathWithUsage = path.map(pixelIndex => ({
                        index: pixelIndex,
                        usage: state.map.roadUsageGrid[pixelIndex] || 0
                    }));
                    
                    postMessage({ 
                        type: 'pathFound', 
                        payload: { 
                            path, 
                            pathWithUsage,
                            startCity, 
                            endCity, 
                            efficiency 
                        } 
                    });
                    updateCostGridWithRoad(path);
                } else {
                    postMessage({ type: 'log', payload: 'No path found between cities' });
                }
            } catch (error) {
                postMessage({ type: 'log', payload: `Error finding path: ${error.message}` });
            }
        } else {
             // If no cities, just wait a bit
             postMessage({ type: 'log', payload: 'Could not pick valid cities, waiting...' });
             await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Ensure minimum delay between simulation cycles to maintain reasonable speed
        const loopDuration = performance.now() - loopStartTime;
        const minCycleTime = 100; // Minimum 100ms between new paths
        if (loopDuration < minCycleTime) {
            await new Promise(resolve => setTimeout(resolve, minCycleTime - loopDuration));
        }
    }
}



self.onmessage = (e) => {
    const { type, payload } = e.data;

    if (type === 'start') {
        postMessage({ type: 'log', payload: 'Worker started.' });
        
        // Reset worker state for new simulation
        if (state.map.roadUsageGrid) {
            state.map.roadUsageGrid.fill(0); // Reset road usage tracking
        }
        
        // Only run setup if we don't have cities loaded already
        if (!state.cities || state.cities.length === 0) {
            postMessage({ type: 'log', payload: 'Loading initial setup...' });
            setup().then(() => {
                simulationLoop();
            });
        } else {
            postMessage({ type: 'log', payload: 'Using existing region data for simulation...' });
            simulationLoop();
        }
    } else if (type === 'loadRegion') {
        postMessage({ type: 'log', payload: `Loading region: ${payload.region}` });
        
        // Update current region
        state.currentRegion = payload.region;
        
        // Update current paths
        state.currentPaths = {
            cities: payload.citiesPath,
            map: payload.mapPath,
            pgw: payload.pgwPath
        };
        
        // Reset state
        state.cities = [];
        state.map.imageData = null;
        state.map.elevationGrid = null;
        state.map.roadUsageGrid = null;
        state.map.cityInfluenceGrid = null;
        
        // Load new region data
        loadRegionData(payload.citiesPath, payload.mapPath, payload.pgwPath);
    } else if (type === 'readyForNextPath') {
        if (nextPathResolver) {
            nextPathResolver();
            nextPathResolver = null;
        }
    }
}; 