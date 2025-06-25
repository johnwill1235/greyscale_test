const startButton = document.getElementById('start-button');
const mapCanvas = document.getElementById('map-canvas');
const animationCanvas = document.getElementById('animation-canvas');
const roadCanvas = document.getElementById('road-canvas');
const cityCanvas = document.getElementById('city-canvas');


const mapCtx = mapCanvas.getContext('2d');
const animationCtx = animationCanvas.getContext('2d');
const roadCtx = roadCanvas.getContext('2d');
const cityCtx = cityCanvas.getContext('2d');

const worker = new Worker('worker.js');

let mapWidth = 0;
let mapHeight = 0;
let cities = [];
let allPaths = []; // Array of {path: [], usageData: Map, maxUsage: number, strokeStyle: string}
let roadUsageMap = new Map(); // Global usage tracking for all roads
let currentStartCityName = null;
let currentEndCityName = null;

// Animation state
let animationFrameId;
let tendrilsToDraw = [];
let isPathfindingActive = false; // Track if pathfinding is currently running

// Exploration tracking
let exploredPixelsBitmap = null; // Use a bitmap for memory efficiency
let exploredCanvas = null; // Offscreen canvas for explored areas
let exploredCtx = null;

// Load map images
const calculationMapImage = new Image();
calculationMapImage.src = 'data/map.png';

const displayMapImage = new Image();
displayMapImage.src = 'data/viewmap.png';

const calculationMapPromise = new Promise(resolve => calculationMapImage.onload = resolve);
const displayMapPromise = new Promise(resolve => displayMapImage.onload = resolve);

Promise.all([calculationMapPromise, displayMapPromise]).then(() => {
    mapWidth = mapCanvas.width = calculationMapImage.width;
    mapHeight = mapCanvas.height = calculationMapImage.height;
    animationCanvas.width = calculationMapImage.width;
    animationCanvas.height = calculationMapImage.height;
    roadCanvas.width = calculationMapImage.width;
    roadCanvas.height = calculationMapImage.height;
    cityCanvas.width = calculationMapImage.width;
    cityCanvas.height = calculationMapImage.height;
    
    // Create offscreen canvas for explored areas
    exploredCanvas = new OffscreenCanvas(mapWidth, mapHeight);
    exploredCtx = exploredCanvas.getContext('2d');
    
    // Initialize bitmap for tracking explored pixels
    exploredPixelsBitmap = new Uint8Array(mapWidth * mapHeight);

    // Scale the viewmap to match the calculation map size
    mapCtx.drawImage(displayMapImage, 0, 0, mapWidth, mapHeight);
});

function masterDraw() {
    // A single function to redraw the entire state of all canvases.
    // Useful for when the tab becomes visible again.
    roadCtx.clearRect(0, 0, mapWidth, mapHeight);
    cityCtx.clearRect(0, 0, mapWidth, mapHeight);
    animationCtx.clearRect(0, 0, mapWidth, mapHeight);

    // Redraw all components in their correct order
    // Only redraw explored areas if pathfinding is currently active
    if (exploredCanvas && isPathfindingActive) {
        animationCtx.drawImage(exploredCanvas, 0, 0);
    }
    drawAllRoads(); // Redraws permanent roads
    drawCities(currentStartCityName, currentEndCityName); // Redraws cities with active highlights
}

// Listen for tab visibility changes to redraw the canvas.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        masterDraw();
    } else {
        // Clean up when page becomes hidden
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        // Clear any ongoing animation state
        tendrilsToDraw = [];
    }
});

// Ensure clean state on page load
window.addEventListener('load', () => {
    // Reset all state variables
    isPathfindingActive = false;
    animationFrameId = null;
    tendrilsToDraw = [];
    currentStartCityName = null;
    currentEndCityName = null;
    allPaths = [];
    
    // Clear explored areas
    if (exploredPixelsBitmap) {
        exploredPixelsBitmap.fill(0);
    }
    
    // Enable start button
    startButton.disabled = false;
});

function drawCities(activeCity1Name = null, activeCity2Name = null) {
    cityCtx.clearRect(0, 0, mapWidth, mapHeight);

    cities.forEach(city => {
        const isActive = city.name === activeCity1Name || city.name === activeCity2Name;

        // Smaller cities: 6px normal, 12px for active
        const radius = isActive ? 12 : 6;
        
        cityCtx.beginPath();
        cityCtx.arc(city.x, city.y, radius, 0, Math.PI * 2);
        cityCtx.fillStyle = isActive ? 'yellow' : 'white';
        cityCtx.fill();
        
        // Add black border for better visibility
        cityCtx.strokeStyle = 'black';
        cityCtx.lineWidth = isActive ? 2 : 1;
        cityCtx.stroke();
        
        // Smaller font for city names
        cityCtx.fillStyle = 'black';
        cityCtx.font = isActive ? 'bold 14px sans-serif' : '12px sans-serif';
        cityCtx.fillText(city.name, city.x + radius + 6, city.y + 6);
    });

    if (isPathfindingActive) {
        animationFrameId = requestAnimationFrame(drawSearchTendrils);
    } else {
        // If pathfinding just stopped, do one last draw of any remaining explored areas.
        animationCtx.clearRect(0, 0, mapWidth, mapHeight);
        if (exploredCanvas) {
            animationCtx.drawImage(exploredCanvas, 0, 0);
        }
    }
}

function drawSearchTendrils() {
    // Clear the animation canvas
    animationCtx.clearRect(0, 0, mapWidth, mapHeight);

    // First, draw the persistent explored areas from the offscreen canvas
    if (exploredCanvas) {
        animationCtx.drawImage(exploredCanvas, 0, 0);
    }

    // Draw current tendrils larger and brighter
    if (tendrilsToDraw.length > 0) {
        animationCtx.fillStyle = 'rgba(255, 255, 0, 0.9)'; // Bright yellow
        
        // Update explored areas on offscreen canvas
        exploredCtx.fillStyle = 'rgba(255, 97, 97, 0.3)'; // Green tint for explored
        
        tendrilsToDraw.forEach(index => {
            const x = index % mapWidth;
            const y = Math.floor(index / mapWidth);
            
            // Draw larger tendril on main canvas (2x2 instead of 1x1)
            animationCtx.fillRect(x - 1, y - 1, 3, 3);
            
            // Add to explored areas if not already explored
            if (exploredPixelsBitmap && exploredPixelsBitmap[index] === 0) {
                exploredPixelsBitmap[index] = 1;
                exploredCtx.fillRect(x, y, 1, 1);
            }
        });
        
        // Only clear tendrils after drawing them
        tendrilsToDraw = [];
    }
    
    // Only continue animation loop if pathfinding is active
    if (isPathfindingActive) {
        animationFrameId = requestAnimationFrame(drawSearchTendrils);
    }
}

function getGradientColor(rank) {
    // Rank 0 is red, ranks 1-9 interpolate from red to black.
    if (rank === 0) return 'rgb(255, 0, 0)'; // Brightest red for top rank
    const t = rank / 9; // interpolation factor from 0 to 1
    const r = Math.round(255 * (1 - t));
    return `rgb(${r}, 0, 0)`;
}

function calculateStrokeStyle(maxUsage) {
    if (maxUsage >= 12) {
        // Fully developed road: transition from 70% opacity brown to 100% opacity black
        // Assume max development around 30 uses for full transition
        const developmentLevel = Math.min((maxUsage - 12) / 18, 1); // 0 to 1
        
        if (developmentLevel === 0) {
            // Start of development: 70% opacity brown
            return 'rgba(139, 69, 19, 0.7)'; // Brown at 70% opacity
        } else if (developmentLevel >= 1) {
            // Fully developed: 100% opacity black
            return 'rgba(0, 0, 0, 1.0)';
        } else {
            // Transition: interpolate from brown to black, opacity from 70% to 100%
            const brown = [139, 69, 19];
            const black = [0, 0, 0];
            const r = Math.round(brown[0] * (1 - developmentLevel) + black[0] * developmentLevel);
            const g = Math.round(brown[1] * (1 - developmentLevel) + black[1] * developmentLevel);
            const b = Math.round(brown[2] * (1 - developmentLevel) + black[2] * developmentLevel);
            const opacity = 0.7 + (0.3 * developmentLevel); // 70% to 100%
            return `rgba(${r}, ${g}, ${b}, ${opacity})`;
        }
    } else {
        // Basic road: keep original low-opacity black
        return 'rgba(0, 0, 0, 0.7)';
    }
}

function updatePathColors() {
    // Only recalculate colors for paths that might have changed
    allPaths.forEach(pathData => {
        const path = pathData.path || pathData; // Handle both old and new format
        
        // Find the maximum usage for this path
        let maxUsage = 0;
        path.forEach(index => {
            const usage = roadUsageMap.get(index) || 0;
            maxUsage = Math.max(maxUsage, usage);
        });
        
        // Only update if maxUsage changed
        if (pathData.maxUsage !== maxUsage) {
            pathData.maxUsage = maxUsage;
            pathData.strokeStyle = calculateStrokeStyle(maxUsage);
        }
    });
}

function drawAllRoads() {
    roadCtx.clearRect(0, 0, mapWidth, mapHeight);

    allPaths.forEach(pathData => {
        const path = pathData.path || pathData; // Handle both old and new format
        
        // Use cached stroke style if available
        const strokeStyle = pathData.strokeStyle || 'rgba(0, 0, 0, 0.7)';
        
        roadCtx.strokeStyle = strokeStyle;
        roadCtx.lineWidth = 1.5;
        roadCtx.beginPath();
        
        // Convert path to coordinates and draw
        let isFirst = true;
        path.forEach(index => {
            const x = index % mapWidth;
            const y = Math.floor(index / mapWidth);
            if (isFirst) {
                roadCtx.moveTo(x, y);
                isFirst = false;
            } else {
                roadCtx.lineTo(x, y);
            }
        });
        
        roadCtx.stroke();
    });
}



function clearExploredAreas() {
    if (exploredPixelsBitmap) {
        exploredPixelsBitmap.fill(0); // Reset the bitmap
    }
    if (exploredCtx) {
        exploredCtx.clearRect(0, 0, mapWidth, mapHeight);
    }
    if (animationCtx) {
        animationCtx.clearRect(0, 0, mapWidth, mapHeight);
    }
}

function drawLightning(path) {
    animationCtx.clearRect(0, 0, mapWidth, mapHeight);
    
    const pathCoords = path.map(index => ({
        x: index % mapWidth,
        y: Math.floor(index / mapWidth)
    }));

    let flashes = 0;
    const maxFlashes = 5;

    function flash() {
        if (flashes >= maxFlashes) {
            animationCtx.clearRect(0, 0, mapWidth, mapHeight);
            
            // Clear explored areas after lightning flash completes
            clearExploredAreas();
            
            currentStartCityName = null;
            currentEndCityName = null;
            drawCities(); // Redraw cities to remove highlights
            worker.postMessage({ type: 'readyForNextPath' });
            return;
        }

        animationCtx.clearRect(0, 0, mapWidth, mapHeight);
        
        // Draw a thick, bright line
        if (flashes % 2 === 0) {
            animationCtx.strokeStyle = 'white';
            animationCtx.lineWidth = 4;
            animationCtx.beginPath();
            animationCtx.moveTo(pathCoords[0].x, pathCoords[0].y);
            pathCoords.forEach(p => animationCtx.lineTo(p.x, p.y));
            animationCtx.stroke();
        }

        flashes++;
        setTimeout(flash, 80);
    }
    flash();
}

function drawPermanentRoad(pathCoords) {
    roadCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)'; // Changed to black
    roadCtx.lineWidth = 1.5; // Half thickness
    roadCtx.beginPath();
    roadCtx.moveTo(pathCoords[0].x, pathCoords[0].y);
    pathCoords.forEach(p => roadCtx.lineTo(p.x, p.y));
    roadCtx.stroke();
}

startButton.addEventListener('click', () => {
    console.log('Starting simulation...');
    startButton.disabled = true;
    
    // Clear all previous state when starting new simulation
    isPathfindingActive = false;
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    tendrilsToDraw = [];
    currentStartCityName = null;
    currentEndCityName = null;
    
    // Clear explored areas from previous simulations
    clearExploredAreas();
    
    // Clear all canvases to start fresh
    roadCtx.clearRect(0, 0, mapWidth, mapHeight);
    cityCtx.clearRect(0, 0, mapWidth, mapHeight);
    animationCtx.clearRect(0, 0, mapWidth, mapHeight);
    
    // Reset road data
    allPaths = [];
    roadUsageMap.clear();
    
    // Redraw base state
    drawCities();
    
    worker.postMessage({ type: 'start' });
    // The animation loop will now be started by the 'findingPath' message.
});

worker.onmessage = (e) => {
    const { type, payload } = e.data;

    if (type === 'log') {
        console.log(`Worker: ${payload}`);
    } else if (type === 'citiesData') {
        cities = payload;
        drawCities();
    } else if (type === 'findingPath') {
        isPathfindingActive = true;
        clearExploredAreas();
        const { from, to } = payload;
        currentStartCityName = from;
        currentEndCityName = to;
        drawCities(from, to);
        // Kick off the animation loop
        animationFrameId = requestAnimationFrame(drawSearchTendrils);
    } else if (type === 'pathfindingUpdate') {
        tendrilsToDraw.push(...payload);
        } else if (type === 'pathFound') {
        isPathfindingActive = false; // Stop the animation loop
        const { path, pathWithUsage, startCity, endCity } = payload;
        
        // Create path object with initial styling
        const pathObj = {
            path: path,
            maxUsage: 0,
            strokeStyle: 'rgba(0, 0, 0, 0.7)' // Default style
        };
        allPaths.push(pathObj);
        
        // Update global usage map if we have usage data
        if (pathWithUsage) {
            pathWithUsage.forEach(({index, usage}) => {
                roadUsageMap.set(index, usage + 1); // Add 1 for the new path
            });
        }
        
        // Only update colors for paths that might have changed usage
        updatePathColors();
        
        // Redraw roads with updated colors
        drawAllRoads();
        
        currentStartCityName = startCity.name;
        currentEndCityName = endCity.name;
        drawCities(startCity.name, endCity.name);
        drawLightning(path);
    }
};

worker.onerror = (e) => {
    console.error('Error in worker:', e);
}; 