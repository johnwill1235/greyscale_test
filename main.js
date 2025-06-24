const startButton = document.getElementById('start-button');
const mapCanvas = document.getElementById('map-canvas');
const animationCanvas = document.getElementById('animation-canvas');
const roadCanvas = document.getElementById('road-canvas');
const cityCanvas = document.getElementById('city-canvas');
const leaderboardList = document.getElementById('leaderboard-list');

const mapCtx = mapCanvas.getContext('2d');
const animationCtx = animationCanvas.getContext('2d');
const roadCtx = roadCanvas.getContext('2d');
const cityCtx = cityCanvas.getContext('2d');

const worker = new Worker('worker.js');

let mapWidth = 0;
let mapHeight = 0;
let cities = [];
let leaderboardRoads = [];
let allPaths = [];

// Animation state
let animationFrameId;
let tendrilsToDraw = [];
let isPathfindingActive = false; // Track if pathfinding is currently running

// Exploration tracking
let exploredPixelsBitmap = null; // Use a bitmap for memory efficiency
let exploredCanvas = null; // Offscreen canvas for explored areas
let exploredCtx = null;

// Load map image
const mapImage = new Image();
mapImage.src = 'data/map.png';
mapImage.onload = () => {
    mapWidth = mapCanvas.width = mapImage.width;
    mapHeight = mapCanvas.height = mapImage.height;
    animationCanvas.width = mapImage.width;
    animationCanvas.height = mapImage.height;
    roadCanvas.width = mapImage.width;
    roadCanvas.height = mapImage.height;
    cityCanvas.width = mapImage.width;
    cityCanvas.height = mapImage.height;
    
    // Create offscreen canvas for explored areas
    exploredCanvas = new OffscreenCanvas(mapWidth, mapHeight);
    exploredCtx = exploredCanvas.getContext('2d');
    
    // Initialize bitmap for tracking explored pixels
    exploredPixelsBitmap = new Uint8Array(mapWidth * mapHeight);

    mapCtx.drawImage(mapImage, 0, 0);
};

function masterDraw() {
    // A single function to redraw the entire state of all canvases.
    // Useful for when the tab becomes visible again.
    roadCtx.clearRect(0, 0, mapWidth, mapHeight);
    cityCtx.clearRect(0, 0, mapWidth, mapHeight);
    animationCtx.clearRect(0, 0, mapWidth, mapHeight);

    // Redraw all components in their correct order
    if (exploredCanvas) {
        animationCtx.drawImage(exploredCanvas, 0, 0);
    }
    drawAllRoads(); // Redraws permanent roads
    drawCities();   // Redraws cities
}

// Listen for tab visibility changes to redraw the canvas.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        masterDraw();
    }
});

function drawCities(activeCity1Name = null, activeCity2Name = null) {
    cityCtx.clearRect(0, 0, mapWidth, mapHeight);

    cities.forEach(city => {
        const isActive = city.name === activeCity1Name || city.name === activeCity2Name;

        // Much larger cities: 12px normal, 24px for active
        const radius = isActive ? 24 : 12;
        
        cityCtx.beginPath();
        cityCtx.arc(city.x, city.y, radius, 0, Math.PI * 2);
        cityCtx.fillStyle = isActive ? 'yellow' : 'white';
        cityCtx.fill();
        
        // Add black border for better visibility
        cityCtx.strokeStyle = 'black';
        cityCtx.lineWidth = isActive ? 3 : 2;
        cityCtx.stroke();
        
        // Much larger font for city names
        cityCtx.fillStyle = 'black';
        cityCtx.font = isActive ? 'bold 24px sans-serif' : '20px sans-serif';
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
        exploredCtx.fillStyle = 'rgba(100, 200, 100, 0.3)'; // Green tint for explored
        
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
    const t = rank / 9; // interpolation factor from 0 to 1
    const r = Math.round(255 * (1 - t));
    return `rgb(${r}, 0, 0)`;
}

function drawAllRoads() {
    roadCtx.clearRect(0, 0, mapWidth, mapHeight);

    // 1. Draw all base paths in grey
    allPaths.forEach(path => {
        const pathCoords = path.map(index => ({
            x: index % mapWidth,
            y: Math.floor(index / mapWidth)
        }));
        roadCtx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        roadCtx.lineWidth = 1.5;
        roadCtx.beginPath();
        roadCtx.moveTo(pathCoords[0].x, pathCoords[0].y);
        pathCoords.forEach(p => roadCtx.lineTo(p.x, p.y));
        roadCtx.stroke();
    });

    // 2. Draw leaderboard roads on top
    const sortedLeaderboardRoads = leaderboardRoads.sort((a, b) => b.efficiency - a.efficiency);
    
    sortedLeaderboardRoads.slice(0, 10).forEach((road, index) => {
        const pathCoords = road.path.map(index => ({
            x: index % mapWidth,
            y: Math.floor(index / mapWidth)
        }));

        roadCtx.strokeStyle = getGradientColor(index);
        roadCtx.lineWidth = 3.0;
        
        roadCtx.beginPath();
        roadCtx.moveTo(pathCoords[0].x, pathCoords[0].y);
        pathCoords.forEach(p => roadCtx.lineTo(p.x, p.y));
        roadCtx.stroke();
    });
}

function updateLeaderboard() {
    // Sort roads by efficiency (higher is better)
    const sortedRoads = leaderboardRoads.sort((a, b) => b.efficiency - a.efficiency);

    // Take top 10
    const topRoads = sortedRoads.slice(0, 10);

    // Generate HTML
    leaderboardList.innerHTML = topRoads
        .map((road, index) => {
            const efficiencyGain = road.efficiency * 100;
            const color = getGradientColor(index);
            const shadow = index === 0 ? '1px 1px 2px rgba(0,0,0,0.7)' : '1px 1px 2px rgba(255,255,255,0.4)';
            return `<li style="color: ${color}; text-shadow: ${shadow};">${road.from} - ${road.to}: +${efficiencyGain.toFixed(1)}%</li>`
        })
        .join('');
    
    drawAllRoads();
}

function addOrUpdateLeaderboardRoad(roadData) {
    const { startCity, endCity, efficiency, path } = roadData;
    const from = startCity.name;
    const to = endCity.name;

    // Normalize city names to create a unique ID
    const roadId = [from, to].sort().join('-');

    const existingRoad = leaderboardRoads.find(r => r.id === roadId);

    if (existingRoad) {
        existingRoad.efficiency = efficiency;
        existingRoad.path = path;
    } else {
        leaderboardRoads.push({
            id: roadId,
            from: from,
            to: to,
            efficiency: efficiency,
            path: path
        });
    }

    updateLeaderboard();
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
    roadCtx.strokeStyle = 'rgba(20, 20, 20, 0.7)';
    roadCtx.lineWidth = 1.5;
    roadCtx.beginPath();
    roadCtx.moveTo(pathCoords[0].x, pathCoords[0].y);
    pathCoords.forEach(p => roadCtx.lineTo(p.x, p.y));
    roadCtx.stroke();
}

startButton.addEventListener('click', () => {
    console.log('Starting simulation...');
    startButton.disabled = true;
    worker.postMessage({ type: 'start' });
    // The animation loop will now be started by the 'findingPath' message.
});

worker.onmessage = (e) => {
    const { type, payload } = e.data;

    if (type === 'log') {
        // console.log(`Worker: ${payload}`);
    } else if (type === 'citiesData') {
        cities = payload;
        drawCities();
    } else if (type === 'findingPath') {
        isPathfindingActive = true;
        clearExploredAreas();
        const { from, to } = payload;
        drawCities(from, to);
        // Kick off the animation loop
        animationFrameId = requestAnimationFrame(drawSearchTendrils);
    } else if (type === 'pathfindingUpdate') {
        tendrilsToDraw.push(...payload);
    } else if (type === 'pathFound') {
        isPathfindingActive = false; // Stop the animation loop
        const { path, startCity, endCity } = payload;
        allPaths.push(path);
        drawPermanentRoad(path);
        drawCities(startCity.name, endCity.name);
        drawLightning(path);
    } else if (type === 'leaderboardUpdate') {
        const roadData = {
            startCity: payload.startCity,
            endCity: payload.endCity,
            efficiency: payload.efficiency,
            path: payload.path,
        };
        addOrUpdateLeaderboardRoad(roadData);
    }
};

worker.onerror = (e) => {
    console.error('Error in worker:', e);
}; 