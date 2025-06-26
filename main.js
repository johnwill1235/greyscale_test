const startButton = document.getElementById('start-button');
const mapTypeSelect = document.getElementById('map-type');
const regionSelect = document.getElementById('region-select');
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
let allPaths = []; // Array of {path: [], usageData: Map, maxUsage: number, strokeStyle: string, lineWidth: number}
let roadUsageMap = new Map(); // Global usage tracking for all roads
let currentStartCityName = null;
let currentEndCityName = null;
let currentRegion = 'china'; // Default region

// City visit tracking for leaderboard
let cityVisitCounts = new Map(); // Track how many times each city has been visited

// Animation state
let animationFrameId;
let tendrilsToDraw = [];
let isPathfindingActive = false; // Track if pathfinding is currently running

// Exploration tracking
let exploredPixelsBitmap = null; // Use a bitmap for memory efficiency
let exploredCanvas = null; // Offscreen canvas for explored areas
let exploredCtx = null;

// Dynamic path generation based on region and map type
function getMapPaths(region, mapType) {
    const regionPaths = {
        china: {
            cities: 'data/china/cities.geojson',
            map: 'data/china/map.png',
            pgw: 'data/china/map.pgw',
            viewmap: 'data/china/viewmap.png',
            satmap: 'data/china/satmap.png'
        },
        usa: {
            cities: 'data/usa/usacities.geojson',
            map: 'data/usa/greyscale_usa.png',
            pgw: 'data/usa/greyscale_usa.pgw',
            viewmap: 'data/usa/viewmap_usa.png',
            satmap: 'data/usa/usasatellite.png'
        }
    };
    
    const paths = regionPaths[region];
    return {
        cities: paths.cities,
        map: paths.map,
        pgw: paths.pgw,
        display: mapType === 'satmap' ? paths.satmap : paths.viewmap
    };
}

// Load map images
let calculationMapImage = new Image();
let displayMapImage = new Image();
let currentDisplayMapSrc = '';

function loadMaps(region, mapType) {
    const paths = getMapPaths(region, mapType);
    
    // Update current region
    currentRegion = region;
    
    // Load calculation map (always the greyscale map for pathfinding)
    calculationMapImage = new Image();
    const calculationMapPromise = new Promise(resolve => {
        calculationMapImage.onload = resolve;
    });
    calculationMapImage.src = paths.map;
    
    // Load display map
    const newDisplaySrc = paths.display;
    displayMapImage = new Image();
    const displayMapPromise = new Promise(resolve => {
        displayMapImage.onload = () => {
            currentDisplayMapSrc = newDisplaySrc;
            resolve();
        };
    });
    displayMapImage.src = newDisplaySrc;
    
    return Promise.all([calculationMapPromise, displayMapPromise]).then(() => {
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

        // Scale the display map to match the calculation map size
        mapCtx.drawImage(displayMapImage, 0, 0, mapWidth, mapHeight);
        
        // Notify worker about the region change
        const paths = getMapPaths(currentRegion, mapTypeSelect.value);
        worker.postMessage({ 
            type: 'loadRegion', 
            payload: { 
                region: currentRegion,
                citiesPath: paths.cities,
                mapPath: paths.map,
                pgwPath: paths.pgw
            } 
        });
    });
}

function loadDisplayMap(mapType) {
    const paths = getMapPaths(currentRegion, mapType);
    const newSrc = paths.display;
    
    if (newSrc !== currentDisplayMapSrc) {
        currentDisplayMapSrc = newSrc;
        displayMapImage = new Image();
        
        return new Promise(resolve => {
            displayMapImage.onload = () => {
                // Redraw the map canvas with the new image
                mapCtx.drawImage(displayMapImage, 0, 0, mapWidth, mapHeight);
                resolve();
            };
            displayMapImage.src = newSrc;
        });
    }
    
    return Promise.resolve();
}

// Initialize with default region and map type
loadMaps('china', 'viewmap').then(() => {
    // Enable start button after initial maps are loaded
    startButton.disabled = false;
    console.log('Initial maps loaded, start button enabled');
}).catch(error => {
    console.error('Error loading initial maps:', error);
    startButton.disabled = false; // Enable anyway so user can try
});

// Add event listeners for map type and region changes
mapTypeSelect.addEventListener('change', () => {
    const selectedMapType = mapTypeSelect.value;
    loadDisplayMap(selectedMapType);
});

regionSelect.addEventListener('change', () => {
    const selectedRegion = regionSelect.value;
    const selectedMapType = mapTypeSelect.value;
    
    // Disable start button while switching regions
    startButton.disabled = true;
    
    // Clear all existing data when switching regions
    isPathfindingActive = false;
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    tendrilsToDraw = [];
    currentStartCityName = null;
    currentEndCityName = null;
    allPaths = [];
    roadUsageMap.clear();
    cities = [];
    
    // Clear city visit tracking for the new region
    cityVisitCounts.clear();
    updateLeaderboard();
    
    // Clear all canvases
    if (mapWidth && mapHeight) {
        roadCtx.clearRect(0, 0, mapWidth, mapHeight);
        cityCtx.clearRect(0, 0, mapWidth, mapHeight);
        animationCtx.clearRect(0, 0, mapWidth, mapHeight);
        if (exploredPixelsBitmap) {
            exploredPixelsBitmap.fill(0);
        }
        if (exploredCtx) {
            exploredCtx.clearRect(0, 0, mapWidth, mapHeight);
        }
    }
    
    // Load new region
    loadMaps(selectedRegion, selectedMapType).then(() => {
        // Re-enable start button after region is loaded
        startButton.disabled = false;
        console.log('Region switched, start button enabled');
    }).catch(error => {
        console.error('Error switching region:', error);
        startButton.disabled = false; // Enable anyway so user can try
    });
});

// City visit tracking functions
function trackCityVisit(cityName) {
    if (!cityName) return;
    
    const currentCount = cityVisitCounts.get(cityName) || 0;
    cityVisitCounts.set(cityName, currentCount + 1);
    
    console.log(`City visit tracked: ${cityName} (${currentCount + 1} times)`);
    updateLeaderboard();
}

function trackCitiesAlongPath(path) {
    if (!path || !cities || cities.length === 0 || !mapWidth) return;
    
    // Convert path indices to coordinates and check which cities are passed through
    const passedThroughCities = new Set(); // Use Set to avoid counting same city multiple times per path
    const proximityThreshold = 15; // Distance threshold to consider a city "passed through"
    
    // Sample the path at regular intervals to avoid checking every single pixel
    const sampleInterval = Math.max(1, Math.floor(path.length / 100)); // Sample ~100 points along the path
    
    for (let i = 0; i < path.length; i += sampleInterval) {
        const pixelIndex = path[i];
        const pathX = pixelIndex % mapWidth;
        const pathY = Math.floor(pixelIndex / mapWidth);
        
        // Check distance to each city
        for (const city of cities) {
            const cityX = Math.round(city.x);
            const cityY = Math.round(city.y);
            
            // Calculate distance between path point and city
            const distance = Math.sqrt(
                Math.pow(pathX - cityX, 2) + Math.pow(pathY - cityY, 2)
            );
            
            // If path passes close enough to city, count it
            if (distance <= proximityThreshold) {
                passedThroughCities.add(city.name);
            }
        }
    }
    
    // Also check the exact start and end points of the path
    if (path.length > 0) {
        // Check start point
        const startIndex = path[0];
        const startX = startIndex % mapWidth;
        const startY = Math.floor(startIndex / mapWidth);
        
        // Check end point
        const endIndex = path[path.length - 1];
        const endX = endIndex % mapWidth;
        const endY = Math.floor(endIndex / mapWidth);
        
        for (const city of cities) {
            const cityX = Math.round(city.x);
            const cityY = Math.round(city.y);
            
            const startDistance = Math.sqrt(
                Math.pow(startX - cityX, 2) + Math.pow(startY - cityY, 2)
            );
            const endDistance = Math.sqrt(
                Math.pow(endX - cityX, 2) + Math.pow(endY - cityY, 2)
            );
            
            if (startDistance <= proximityThreshold || endDistance <= proximityThreshold) {
                passedThroughCities.add(city.name);
            }
        }
    }
    
    // Track all cities that were passed through
    passedThroughCities.forEach(cityName => {
        trackCityVisit(cityName);
    });
    
    console.log(`Path passed through ${passedThroughCities.size} cities:`, Array.from(passedThroughCities));
}

function updateLeaderboard() {
    const leaderboardEmpty = document.getElementById('leaderboard-empty');
    const leaderboardList = document.getElementById('leaderboard-list');
    
    if (cityVisitCounts.size === 0) {
        leaderboardEmpty.style.display = 'block';
        leaderboardList.style.display = 'none';
        return;
    }
    
    leaderboardEmpty.style.display = 'none';
    leaderboardList.style.display = 'block';
    
    // Convert map to array and sort by visit count
    const sortedCities = Array.from(cityVisitCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20); // Top 20 cities
    
    // Clear the list
    leaderboardList.innerHTML = '';
    
    // Add cities to the leaderboard
    sortedCities.forEach(([cityName, visitCount]) => {
        const listItem = document.createElement('li');
        
        const cityNameSpan = document.createElement('span');
        cityNameSpan.className = 'leaderboard-city-name';
        cityNameSpan.textContent = cityName;
        
        const countSpan = document.createElement('span');
        countSpan.className = 'leaderboard-count';
        countSpan.textContent = visitCount;
        
        // Add traffic level styling based on visit count
        const maxCount = Math.max(...cityVisitCounts.values());
        if (visitCount >= maxCount * 0.7) {
            countSpan.classList.add('high-traffic');
        } else if (visitCount >= maxCount * 0.3) {
            countSpan.classList.add('medium-traffic');
        } else {
            countSpan.classList.add('low-traffic');
        }
        
        listItem.appendChild(cityNameSpan);
        listItem.appendChild(countSpan);
        leaderboardList.appendChild(listItem);
    });
}

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

function calculateRoadProperties(maxUsage) {
    // All roads are black, but mature roads (12+ uses) get double thickness
    return {
        strokeStyle: 'rgba(0, 0, 0, 0.8)', // All roads are black
        lineWidth: maxUsage >= 12 ? 3.0 : 1.5 // Double thickness for mature roads
    };
}

function updatePathProperties() {
    // Only recalculate properties for paths that might have changed
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
            const roadProps = calculateRoadProperties(maxUsage);
            pathData.strokeStyle = roadProps.strokeStyle;
            pathData.lineWidth = roadProps.lineWidth;
        }
    });
}

function drawAllRoads() {
    roadCtx.clearRect(0, 0, mapWidth, mapHeight);

    allPaths.forEach(pathData => {
        const path = pathData.path || pathData; // Handle both old and new format
        
        // Use cached properties if available
        const strokeStyle = pathData.strokeStyle || 'rgba(0, 0, 0, 0.8)';
        const lineWidth = pathData.lineWidth || 1.5;
        
        roadCtx.strokeStyle = strokeStyle;
        roadCtx.lineWidth = lineWidth;
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
            
            // Re-enable start button after each path completes
            startButton.disabled = false;
            
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
    roadCtx.strokeStyle = 'rgba(0, 0, 0, 0.8)'; // Black roads
    roadCtx.lineWidth = 1.5; // Standard thickness
    roadCtx.beginPath();
    roadCtx.moveTo(pathCoords[0].x, pathCoords[0].y);
    pathCoords.forEach(p => roadCtx.lineTo(p.x, p.y));
    roadCtx.stroke();
}

startButton.addEventListener('click', async () => {
    console.log('Starting simulation...');
    startButton.disabled = true;
    
    try {
        // Check if we have valid map dimensions
        if (!mapWidth || !mapHeight) {
            console.error('Maps not loaded yet');
            alert('Please wait for maps to load before starting simulation');
            startButton.disabled = false;
            return;
        }
        
        // Check if we have cities data
        if (!cities || cities.length === 0) {
            console.error('No cities data available');
            alert('No cities data available. Please try switching regions.');
            startButton.disabled = false;
            return;
        }
        
        console.log(`Starting simulation with ${cities.length} cities on ${mapWidth}x${mapHeight} map`);
        
        // Load the selected map type before starting
        const selectedMapType = mapTypeSelect.value;
        await loadDisplayMap(selectedMapType);
        
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
        
        // Reset city visit tracking for new simulation
        cityVisitCounts.clear();
        updateLeaderboard();
        
        // Redraw base state
        drawCities();
        
        worker.postMessage({ type: 'start' });
        console.log('Simulation start message sent to worker');
        // Note: Start button will be re-enabled when simulation is running or if there's an error
        
    } catch (error) {
        console.error('Error starting simulation:', error);
        alert('Error starting simulation: ' + error.message);
        startButton.disabled = false;
    }
});

worker.onmessage = (e) => {
    const { type, payload } = e.data;

    if (type === 'log') {
        console.log(`Worker: ${payload}`);
    } else if (type === 'citiesData') {
        cities = payload;
        drawCities();
        // Re-enable start button when cities are loaded
        if (!isPathfindingActive) {
            startButton.disabled = false;
        }
        console.log(`Loaded ${cities.length} cities`);
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
        
        // Track cities that the path passes through
        trackCitiesAlongPath(path);
        
        // Create path object with initial styling
        const pathObj = {
            path: path,
            maxUsage: 0,
            strokeStyle: 'rgba(0, 0, 0, 0.8)', // Default style
            lineWidth: 1.5 // Default thickness
        };
        allPaths.push(pathObj);
        
        // Update global usage map if we have usage data
        if (pathWithUsage) {
            pathWithUsage.forEach(({index, usage}) => {
                roadUsageMap.set(index, usage + 1); // Add 1 for the new path
            });
        }
        
        // Only update properties for paths that might have changed usage
        updatePathProperties();
        
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