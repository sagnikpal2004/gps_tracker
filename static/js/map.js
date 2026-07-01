// --- Leaflet Map Managers Layer ---

const NCR_CENTER = [28.4729, 77.0726]; // Airtel HQ Gurgaon Coordinates

// Helper to create a tile layer dynamically based on page configurations
function createTileLayer() {
    const provider = document.body.getAttribute('data-map-provider');
    if (provider === 'google') {
        return L.gridLayer.googleMutant({
            type: 'roadmap' // Options: 'roadmap', 'satellite', 'terrain', 'hybrid'
        });
    } else {
        return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        });
    }
}

// 1. LIVE TRACKING MAP MANAGER
const LiveMap = {
    map: null,
    deviceMarkers: {},   // hw_id -> L.marker
    deviceTelemetry: {}, // hw_id -> latest telemetry
    geofenceCircles: {},  // gf_id -> L.circle
    
    init() {
        if (this.map) return;
        
        this.map = L.map('live-map', {
            center: NCR_CENTER,
            zoom: 13,
            zoomControl: true
        });
        
        createTileLayer().addTo(this.map);
        this.loadGeofencesOverlay();
    },
    
    // Draw all geofences on the live map as background visual overlays
    async loadGeofencesOverlay() {
        try {
            // Remove existing
            for (const key in this.geofenceCircles) {
                this.geofenceCircles[key].remove();
            }
            this.geofenceCircles = {};
            
            const geofences = await API.getGeofences();
            geofences.forEach(gf => {
                const circle = L.circle([gf.latitude, gf.longitude], {
                    radius: gf.radius,
                    color: 'rgba(245, 158, 11, 0.4)', // transparent orange/amber border
                    fillColor: 'rgba(245, 158, 11, 0.05)',
                    weight: 1.5,
                    dashArray: '4, 4'
                }).addTo(this.map);
                
                circle.bindTooltip(`Geofence: ${gf.name}`, { sticky: true });
                this.geofenceCircles[gf.id] = circle;
            });
        } catch (err) {
            console.error("Failed to load geofences overlay on live map:", err);
        }
    },
    
    // Dynamically update or create markers for active/offline devices
    updateMarkers(devices) {
        if (!this.map) this.init();
        
        devices.forEach(dev => {
            const hwId = dev.hardware_id;
            let lat = NCR_CENTER[0];
            let lon = NCR_CENTER[1];
            
            // Save telemetry for overlay card lookups
            this.deviceTelemetry[hwId] = dev;

            // Use the latest coordinates joined from location_history by get_all_devices().
            // Skip devices that have no fix yet (e.g. offline devices that never reported a position).
            const hasLocation = !!(dev.latitude && dev.longitude);
            if (!hasLocation) {
                return;
            }

            lat = dev.latitude;
            lon = dev.longitude;
            
            const isOnline = dev.status === "online" || dev.status === "moving";
            const statusClass = dev.status; // online, offline, moving
            
            // Custom CSS marker icon
            const customIcon = L.divIcon({
                className: 'custom-leaflet-marker',
                html: `
                    <div class="marker-pin-outer ${statusClass}" id="marker-${hwId}">
                        <div class="marker-pin-inner ${statusClass}"></div>
                        <div class="marker-pulse ${statusClass}"></div>
                    </div>
                `,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            });
            
            const tooltipContent = `
                <div style="font-family: 'Inter', sans-serif; font-size: 12px; line-height: 1.4;">
                    <strong style="font-family: 'Outfit'; font-size: 13px;">${escapeHTML(dev.name)}</strong><br>
                    Asset: <b>${escapeHTML(dev.assigned_asset || 'N/A')}</b><br>
                    Status: <span style="text-transform: capitalize; color: ${
                        dev.status === 'online' ? 'var(--status-online)' : 
                        dev.status === 'moving' ? 'var(--status-moving)' : 'var(--status-offline)'
                    }; font-weight: 600;">${dev.status}</span><br>
                    Battery: <b>${dev.battery_level}%</b>
                </div>
            `;
            
            if (this.deviceMarkers[hwId]) {
                // Update existing marker
                const marker = this.deviceMarkers[hwId];
                marker.setLatLng([lat, lon]);
                
                // Update icon style by finding element or re-assigning icon
                marker.setIcon(customIcon);
                marker.setTooltipContent(tooltipContent);
            } else {
                // Create new marker
                const marker = L.marker([lat, lon], { icon: customIcon }).addTo(this.map);
                marker.bindTooltip(tooltipContent, { permanent: false, direction: 'top', offset: [0, -10] });
                
                // Clicking marker zooms and details it
                marker.on('click', () => {
                    if (window.focusDevice) {
                        window.focusDevice(dev.id);
                    }
                });
                
                this.deviceMarkers[hwId] = marker;
            }
        });
    },
    
    // Zoom and pan to device marker
    focusOnDevice(hwId) {
        const marker = this.deviceMarkers[hwId];
        if (marker && this.map) {
            this.map.flyTo(marker.getLatLng(), 15, {
                animate: true,
                duration: 1.2
            });
            marker.openTooltip();
        }
    },
    
    resize() {
        if (this.map) {
            this.map.invalidateSize();
        }
    }
};

// 2. LOCATION HISTORY TRAJECTORY MAP MANAGER
const HistoryMap = {
    map: null,
    polyline: null,
    markers: [],
    replayMarker: null,
    
    init() {
        if (this.map) return;
        
        this.map = L.map('history-map', {
            center: NCR_CENTER,
            zoom: 12,
            zoomControl: true
        });
        
        createTileLayer().addTo(this.map);
    },
    
    clear() {
        if (this.polyline) {
            this.polyline.remove();
            this.polyline = null;
        }
        
        this.markers.forEach(m => m.remove());
        this.markers = [];
        
        if (this.replayMarker) {
            this.replayMarker.remove();
            this.replayMarker = null;
        }
    },
    
    // Draws historical path line with start/end node markers
    drawHistoryPath(points) {
        if (!this.map) this.init();
        this.clear();
        
        const coords = points.map(p => [p.latitude, p.longitude]);
        
        // Draw path polyline
        this.polyline = L.polyline(coords, {
            color: 'var(--accent-red)',
            weight: 4,
            opacity: 0.85,
            lineJoin: 'round'
        }).addTo(this.map);
        
        // Fit viewport
        this.map.fitBounds(this.polyline.getBounds(), { padding: [40, 40] });
        
        // Draw start node marker (Green circle tag)
        const startPoint = points[0];
        const startMarker = L.circleMarker([startPoint.latitude, startPoint.longitude], {
            radius: 8,
            color: '#10b981',
            fillColor: '#10b981',
            fillOpacity: 1,
            weight: 2
        }).addTo(this.map).bindTooltip("Route Start Point", { direction: 'top' });
        
        // Draw end node marker (Red circle tag)
        const endPoint = points[points.length - 1];
        const endMarker = L.circleMarker([endPoint.latitude, endPoint.longitude], {
            radius: 8,
            color: '#ef4444',
            fillColor: '#ef4444',
            fillOpacity: 1,
            weight: 2
        }).addTo(this.map).bindTooltip("Last Logged Point", { direction: 'top' });
        
        this.markers.push(startMarker, endMarker);
    },
    
    // Moves tracer dot along historical route coordinates
    updateReplayMarker(lat, lon) {
        if (!this.map) this.init();
        
        const replayIcon = L.divIcon({
            className: 'custom-leaflet-marker',
            html: `
                <div class="marker-pin-outer moving" style="width: 28px; height: 28px;">
                    <div class="marker-pin-inner moving" style="width: 14px; height: 14px;"></div>
                    <div class="marker-pulse moving"></div>
                </div>
            `,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });
        
        if (this.replayMarker) {
            this.replayMarker.setLatLng([lat, lon]);
        } else {
            this.replayMarker = L.marker([lat, lon], { icon: replayIcon }).addTo(this.map);
        }
        
        // Automatically pan map to keep replay in view
        this.map.panTo([lat, lon], { animate: true });
    },
    
    resize() {
        if (this.map) {
            this.map.invalidateSize();
        }
    }
};

// 3. GEOFENCING CONFIGURATION MAP MANAGER
const GeofenceMap = {
    map: null,
    circles: [],
    tempCircle: null,
    
    init() {
        if (this.map) return;
        
        this.map = L.map('geofence-map', {
            center: NCR_CENTER,
            zoom: 13,
            zoomControl: true
        });
        
        createTileLayer().addTo(this.map);
        
        // Double-click on Geofence Map sets coordinates automatically
        this.map.on('dblclick', (e) => {
            if (AppState.role === "Viewer") return;
            
            // Show inline card
            document.getElementById("add-geofence-card").classList.remove("hidden");
            
            // Fill inputs
            const lat = e.latlng.lat;
            const lon = e.latlng.lng;
            document.getElementById("gf-lat").value = lat.toFixed(6);
            document.getElementById("gf-lon").value = lon.toFixed(6);
            
            // Default radius
            let radius = parseFloat(document.getElementById("gf-radius").value);
            if (isNaN(radius)) {
                radius = 1000;
                document.getElementById("gf-radius").value = radius;
            }
            
            // Update temporary visual circle
            this.drawTempCircle(lat, lon, radius);
        });
        
        // Input listeners to update temp geofence size interactively
        document.getElementById("gf-radius").addEventListener("input", (e) => {
            const rad = parseFloat(e.target.value);
            const lat = parseFloat(document.getElementById("gf-lat").value);
            const lon = parseFloat(document.getElementById("gf-lon").value);
            if (!isNaN(rad) && !isNaN(lat) && !isNaN(lon)) {
                this.drawTempCircle(lat, lon, rad);
            }
        });
    },
    
    drawTempCircle(lat, lon, radius) {
        if (this.tempCircle) {
            this.tempCircle.remove();
        }
        
        this.tempCircle = L.circle([lat, lon], {
            radius: radius,
            color: 'var(--accent-red)',
            fillColor: 'var(--accent-red)',
            fillOpacity: 0.15,
            weight: 2,
            dashArray: '5, 5'
        }).addTo(this.map);
        
        this.map.panTo([lat, lon]);
    },
    
    clearTempCircle() {
        if (this.tempCircle) {
            this.tempCircle.remove();
            this.tempCircle = null;
        }
    },
    
    // Draw all active geofence circles on the configuration canvas
    drawGeofences(geofences) {
        if (!this.map) this.init();
        
        // Clear previous
        this.circles.forEach(c => c.remove());
        this.circles = [];
        this.clearTempCircle();
        
        geofences.forEach(g => {
            const circle = L.circle([g.latitude, g.longitude], {
                radius: g.radius,
                color: 'var(--status-warning)',
                fillColor: 'var(--status-warning)',
                fillOpacity: 0.15,
                weight: 2
            }).addTo(this.map);
            
            circle.bindTooltip(`<b>${escapeHTML(g.name)}</b><br>Radius: ${g.radius}m`, { permanent: false, direction: 'top' });
            
            this.circles.push(circle);
        });
    },
    
    // Fly to a geofence centre, zoom to fit its radius, and open its tooltip
    flyToGeofence(lat, lon, radius) {
        if (!this.map) this.init();

        // Pick a zoom level that fits the geofence radius nicely
        const zoom = radius > 3000 ? 12 : radius > 1000 ? 13 : radius > 500 ? 14 : 15;
        this.map.flyTo([lat, lon], zoom, { animate: true, duration: 1.0 });

        // Open the tooltip of the matching circle
        this.circles.forEach(circle => {
            const center = circle.getLatLng();
            if (Math.abs(center.lat - lat) < 0.0001 && Math.abs(center.lng - lon) < 0.0001) {
                circle.openTooltip();
            }
        });
    },

    resize() {
        if (this.map) {
            this.map.invalidateSize();
        }
    }
};

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}
