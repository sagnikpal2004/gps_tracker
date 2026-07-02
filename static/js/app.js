// --- Core Dashboard Application Orchestrator ---

// Global Application State
const AppState = {
    currentUser: null,
    activeTab: "live-map",
    devices: [],
    geofences: [],
    alerts: [],
    pollingInterval: null,
    selectedDeviceId: null,
    role: null
};

// Toast Notification Helper
function showToast(title, desc, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    
    let iconClass = "fa-info-circle";
    if (type === "success") iconClass = "fa-circle-check";
    if (type === "warning") iconClass = "fa-triangle-exclamation";
    if (type === "danger") iconClass = "fa-circle-xmark";
    
    toast.innerHTML = `
        <i class="fa-solid ${iconClass}"></i>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-desc">${desc}</div>
        </div>
        <button class="toast-close"><i class="fa-solid fa-xmark"></i></button>
    `;
    
    container.appendChild(toast);
    
    // Wire up close button
    toast.querySelector(".toast-close").addEventListener("click", () => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 250);
    });
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.opacity = "0";
            setTimeout(() => toast.remove(), 250);
        }
    }, 5000);
}

// Bootstrap Application
document.addEventListener("DOMContentLoaded", () => {
    initEventListeners();
    checkSession();
});

// Check local storage session
async function checkSession() {
    if (isAuthenticated()) {
        const username = localStorage.getItem("gps_user_username");
        const role = localStorage.getItem("gps_user_role");
        
        AppState.currentUser = username;
        AppState.role = role;
        
        setupUserInterface(username, role);
        startPolling();
        
        // Trigger initial data load
        switchTab("live-map");
    } else {
        document.getElementById("login-screen").classList.add("active");
    }
}

// Configure dashboard UI according to roles
function setupUserInterface(username, role) {
    document.getElementById("login-screen").classList.remove("active");
    document.getElementById("profile-username").textContent = username;
    document.getElementById("profile-role").textContent = role;
    
    // Apply Role-Based Access Controls (RBAC)
    const adminItems = document.querySelectorAll(".admin-only");
    const operatorItems = document.querySelectorAll(".operator-only");
    
    if (role === "Admin") {
        adminItems.forEach(el => el.classList.remove("hidden"));
        operatorItems.forEach(el => el.classList.remove("hidden"));
    } else if (role === "Operator") {
        adminItems.forEach(el => el.classList.add("hidden"));
        operatorItems.forEach(el => el.classList.remove("hidden"));
    } else {
        // Viewer role
        adminItems.forEach(el => el.classList.add("hidden"));
        operatorItems.forEach(el => el.classList.add("hidden"));
    }
    
    showToast("System Access Granted", `Logged in as ${username} (${role})`, "success");
}

// Event Listeners Routing
function initEventListeners() {
    // 1. Authentication
    document.getElementById("login-form").addEventListener("submit", handleLoginSubmit);
    document.getElementById("logout-btn").addEventListener("click", () => {
        stopPolling();
        API.logout();
        AppState.currentUser = null;
        AppState.role = null;
        showToast("Signed Out", "You have logged out of the dashboard", "info");
    });
    
    // 2. Navigation
    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            const tabName = item.getAttribute("data-tab");
            switchTab(tabName);
        });
    });
    
    // 3. Search & Filters inside Map Sidebar
    document.getElementById("device-search").addEventListener("input", filterLiveDevices);
    document.querySelectorAll(".filter-pill").forEach(pill => {
        pill.addEventListener("click", () => {
            document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            filterLiveDevices();
        });
    });
    
    // Close live overlay card
    document.getElementById("close-overlay-btn").addEventListener("click", () => {
        document.getElementById("selected-device-overlay").classList.add("hidden");
        AppState.selectedDeviceId = null;
    });
    
    // 4. Notification Bell Dropdown
    const bellBtn = document.getElementById("bell-dropdown-btn");
    const bellMenu = document.getElementById("bell-dropdown-menu");
    
    bellBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        bellMenu.classList.toggle("active");
    });
    
    document.addEventListener("click", () => {
        bellMenu.classList.remove("active");
    });
    
    document.getElementById("mark-all-read-btn").addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (AppState.role === "Viewer") return;
        try {
            await API.markAllAlertsRead();
            showToast("Alerts Marked Read", "All active alerts marked as read", "success");
            fetchAlerts();
        } catch (err) {
            showToast("Action Failed", err.message, "danger");
        }
    });
    
    document.querySelectorAll(".view-all-alerts-link").forEach(link => {
        link.addEventListener("click", (e) => {
            e.preventDefault();
            switchTab("alerts");
        });
    });
    
    // 5. Simulator Controller
    document.getElementById("sim-toggle-checkbox").addEventListener("change", async (e) => {
        if (AppState.role === "Viewer") {
            e.preventDefault();
            document.getElementById("sim-toggle-checkbox").checked = !e.target.checked;
            showToast("Permission Denied", "Viewer cannot control simulator", "warning");
            return;
        }
        try {
            await API.setSimulatorActive(e.target.checked);
            const status = e.target.checked ? "Activated" : "Paused";
            showToast("Find Hub Simulator", `Tracking engine is now ${status}`, "info");
            document.getElementById("sim-status-dot").className = `status-indicator-dot ${e.target.checked ? 'online' : 'offline'}`;
        } catch (err) {
            showToast("Failed to Toggle Simulator", err.message, "danger");
        }
    });
    
    document.getElementById("sim-reset-btn").addEventListener("click", async () => {
        if (AppState.role === "Viewer") return;
        try {
            await API.resetSimulator();
            showToast("Simulator Reset", "All tracker tags relocated to starting positions", "success");
        } catch (err) {
            showToast("Reset Failed", err.message, "danger");
        }
    });
    
    // 6. Devices Management Registry Modals (Admin Only)
    const deviceModal = document.getElementById("device-modal");
    
    document.getElementById("btn-show-add-device-modal").addEventListener("click", () => {
        document.getElementById("device-modal-title").textContent = "Register New GPS Tag";
        document.getElementById("btn-save-device-modal").textContent = "Register Tag";
        document.getElementById("device-modal-form").reset();
        document.getElementById("modal-device-id").value = "";
        document.getElementById("modal-hw-id").readOnly = false;
        deviceModal.classList.remove("hidden");
        deviceModal.classList.add("active");
    });
    
    document.getElementById("close-device-modal-btn").addEventListener("click", () => {
        deviceModal.classList.remove("active");
        deviceModal.classList.add("hidden");
    });
    document.getElementById("btn-cancel-device-modal").addEventListener("click", () => {
        deviceModal.classList.remove("active");
        deviceModal.classList.add("hidden");
    });
    
    document.getElementById("device-modal-form").addEventListener("submit", handleDeviceSubmit);
    
    // 7. Geofence Management CRUD
    document.getElementById("btn-show-add-geofence").addEventListener("click", () => {
        document.getElementById("add-geofence-card").classList.remove("hidden");
    });
    
    document.getElementById("btn-cancel-geofence").addEventListener("click", () => {
        document.getElementById("add-geofence-card").classList.add("hidden");
    });
    
    document.getElementById("add-geofence-form").addEventListener("submit", handleGeofenceSubmit);
    
    // 8. Trajectory Query
    document.getElementById("history-query-form").addEventListener("submit", handleHistoryQuery);

    // 9. User Management Modal
    const userModal = document.getElementById("user-modal");

    document.getElementById("btn-show-add-user-modal").addEventListener("click", () => {
        document.getElementById("user-modal-title").textContent = "Add New User";
        document.getElementById("btn-save-user-modal").textContent = "Add User";
        document.getElementById("user-modal-form").reset();
        document.getElementById("modal-user-id").value = "";
        document.getElementById("modal-username").readOnly = false;
        document.getElementById("modal-user-password").required = true;
        document.getElementById("modal-password-hint").classList.add("hidden");
        userModal.classList.remove("hidden");
        userModal.classList.add("active");
    });

    document.getElementById("close-user-modal-btn").addEventListener("click", () => {
        userModal.classList.remove("active");
        userModal.classList.add("hidden");
    });

    document.getElementById("btn-cancel-user-modal").addEventListener("click", () => {
        userModal.classList.remove("active");
        userModal.classList.add("hidden");
    });

    document.getElementById("user-modal-form").addEventListener("submit", handleUserSubmit);
}

// Login Handler
async function handleLoginSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById("login-btn");
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...`;
    
    const user = document.getElementById("username").value.trim();
    const pass = document.getElementById("password").value;
    
    try {
        const res = await API.login(user, pass);
        AppState.currentUser = res.username;
        AppState.role = res.role;
        
        setupUserInterface(res.username, res.role);
        startPolling();
        
        switchTab("live-map");
    } catch (err) {
        showToast("Access Denied", err.message || "Invalid credentials", "danger");
        btn.disabled = false;
        btn.innerHTML = `<span>Secure Sign In</span> <i class="fa-solid fa-arrow-right-to-bracket"></i>`;
    }
}

// Switch Screens
function switchTab(tabName) {
    AppState.activeTab = tabName;
    
    // Update active nav item
    document.querySelectorAll(".nav-item").forEach(item => {
        if (item.getAttribute("data-tab") === tabName) {
            item.classList.add("active");
        } else {
            item.classList.remove("active");
        }
    });
    
    // Show/Hide Viewports
    document.querySelectorAll(".viewport").forEach(viewport => {
        if (viewport.id === `viewport-${tabName}`) {
            viewport.classList.add("active");
        } else {
            viewport.classList.remove("active");
        }
    });
    
    // Header descriptions update
    const headers = {
        "live-map": ["Live Tracking Map", "Real-time coordinates streamed from MAK tracking hardware via Google Find Hub API."],
        "history": ["Location History Playback", "Query and analyze historical route logs and replay device travel paths."],
        "geofences": ["Virtual Border Fencing", "Designate boundaries and trigger instant telemetry alerts upon breaching geofences."],
        "alerts": ["Alert & Violation Audit Logs", "Inspect low battery events, network offline instances, and geofence violations."],
        "analytics": ["Dashboard Analytics Metrics", "Track general KPI totals, device connection uptime ratios, and telemetry patterns."],
        "devices-mgmt": ["Tracking Device Registry", "Register tracking hardware tags, assign to assets/users, and control device metadata."],
        "users-mgmt": ["User Management", "Create, update, and remove dashboard accounts and control role-based access permissions."],
        "audit-logs": ["Security & Administration Audit Trail", "Inspect user logins, database creations, and system modifications."]
    };
    
    if (headers[tabName]) {
        document.getElementById("current-tab-title").textContent = headers[tabName][0];
        document.getElementById("current-tab-desc").textContent = headers[tabName][1];
    }
    
    // Trigger View Specific Refreshes
    onTabOpened(tabName);
}

// Execute specific hooks when switching tabs
function onTabOpened(tabName) {
    if (tabName === "live-map") {
        setTimeout(() => LiveMap.resize(), 100);
        fetchDevices();
    } else if (tabName === "history") {
        setTimeout(() => HistoryMap.resize(), 100);
        populateHistoryDeviceSelect();
        // Clear previous path
        HistoryMap.clear();
        document.getElementById("history-replay-panel").classList.add("hidden");
    } else if (tabName === "geofences") {
        setTimeout(() => GeofenceMap.resize(), 100);
        fetchGeofences();
    } else if (tabName === "alerts") {
        fetchFullAlertsLog();
    } else if (tabName === "analytics") {
        fetchAnalytics();
    } else if (tabName === "devices-mgmt") {
        fetchDevicesRegistry();
    } else if (tabName === "users-mgmt") {
        fetchUsers();
    } else if (tabName === "audit-logs") {
        fetchAuditLogs();
    }
}

// Start Periodic Polling (every 5 seconds)
function startPolling() {
    stopPolling(); // just in case
    
    // Fetch immediately
    fetchAlerts();
    fetchDevices();
    
    AppState.pollingInterval = setInterval(() => {
        fetchAlerts();
        
        if (AppState.activeTab === "live-map") {
            fetchDevices();
        } else if (AppState.activeTab === "analytics") {
            fetchAnalytics();
        }
    }, 300000); // 5 minutes
}

function stopPolling() {
    if (AppState.pollingInterval) {
        clearInterval(AppState.pollingInterval);
        AppState.pollingInterval = null;
    }
}

// Fetch Devices for Sidebar Map Listing
async function fetchDevices() {
    try {
        const devices = await API.getDevices();
        AppState.devices = devices;

        // Update list sidebar
        renderDeviceList(devices);
        
        // Update map markers
        LiveMap.updateMarkers(devices);
        
        // Update selected device overlay card if open
        if (AppState.selectedDeviceId) {
            const dev = devices.find(d => d.id === AppState.selectedDeviceId);
            if (dev) updateDeviceOverlayCard(dev);
        }
    } catch (err) {
        console.error("Error loading devices list:", err);
    }
}

// Render list of devices in the live map sidebar
function renderDeviceList(devices) {
    const list = document.getElementById("live-device-list");
    if (!list) return;
    
    if (devices.length === 0) {
        list.innerHTML = `<div class="loading-spinner">No devices registered.</div>`;
        return;
    }
    
    const searchVal = document.getElementById("device-search").value.toLowerCase();
    const filterVal = document.querySelector(".filter-pill.active").getAttribute("data-filter");
    
    let filtered = devices.filter(dev => {
        const nameMatch = dev.name.toLowerCase().includes(searchVal) || 
                          (dev.assigned_asset && dev.assigned_asset.toLowerCase().includes(searchVal)) ||
                          dev.hardware_id.toLowerCase().includes(searchVal);
                          
        if (filterVal === "all") return nameMatch;
        if (filterVal === "online") return nameMatch && (dev.status === "online" || dev.status === "moving");
        if (filterVal === "offline") return nameMatch && dev.status === "offline";
        return nameMatch;
    });
    
    if (filtered.length === 0) {
        list.innerHTML = `<div class="loading-spinner">No matching devices.</div>`;
        return;
    }
    
    list.innerHTML = filtered.map(dev => {
        const isOnline = dev.status === "online" || dev.status === "moving";
        const statusClass = dev.status; // online, offline, moving
        const batteryIcon = dev.battery_level > 80 ? "fa-battery-full" : 
                            dev.battery_level > 50 ? "fa-battery-three-quarters" : 
                            dev.battery_level > 20 ? "fa-battery-quarter" : "fa-battery-empty";
                            
        const lastSyncText = dev.last_sync ? formatRelativeTime(dev.last_sync) : "Never";
        const isActive = AppState.selectedDeviceId === dev.id ? "active" : "";
        
        return `
            <div class="device-item ${isActive}" onclick="focusDevice(${dev.id})">
                <div class="device-item-header">
                    <h3>${escapeHTML(dev.name)}</h3>
                    <span class="badge ${statusClass}">${dev.status}</span>
                </div>
                <div class="device-item-body">
                    <span>Hardware ID: <strong>${escapeHTML(dev.hardware_id)}</strong></span>
                    <span>Asset: <strong>${escapeHTML(dev.assigned_asset || 'N/A')}</strong></span>
                </div>
                <div class="device-item-footer">
                    <span><i class="fa-solid ${batteryIcon}"></i> ${dev.battery_level}%</span>
                    <span>Sync: ${lastSyncText}</span>
                </div>
            </div>
        `;
    }).join("");
}

function filterLiveDevices() {
    renderDeviceList(AppState.devices);
}

// Select/Focus Device on Map
window.focusDevice = function(deviceId) {
    AppState.selectedDeviceId = deviceId;
    
    // Toggle active list highlights
    document.querySelectorAll(".device-item").forEach(item => item.classList.remove("active"));
    
    const dev = AppState.devices.find(d => d.id === deviceId);
    if (!dev) return;
    
    // Update live sidebar overlay details
    updateDeviceOverlayCard(dev);
    document.getElementById("selected-device-overlay").classList.remove("hidden");
    
    // Tell Leaflet map manager to fly to coordinates
    LiveMap.focusOnDevice(dev.hardware_id);
    
    // Re-render sidebar items to show highlight
    renderDeviceList(AppState.devices);
};

function updateDeviceOverlayCard(dev) {
    const latVal = dev.last_sync && LiveMap.deviceMarkers[dev.hardware_id] 
                 ? LiveMap.deviceMarkers[dev.hardware_id].getLatLng().lat.toFixed(5) 
                 : "N/A";
    const lonVal = dev.last_sync && LiveMap.deviceMarkers[dev.hardware_id] 
                 ? LiveMap.deviceMarkers[dev.hardware_id].getLatLng().lng.toFixed(5) 
                 : "N/A";
                 
    document.getElementById("overlay-dev-name").textContent = dev.name;
    document.getElementById("overlay-dev-hw").textContent = dev.hardware_id;
    document.getElementById("overlay-dev-asset").textContent = dev.assigned_asset || "Unassigned";
    document.getElementById("overlay-dev-coords").textContent = latVal !== "N/A" ? `${latVal}, ${lonVal}` : "N/A";
    
    // Speed update
    let speed = 0;
    if (dev.status === "moving" && LiveMap.deviceTelemetry[dev.hardware_id]) {
        speed = LiveMap.deviceTelemetry[dev.hardware_id].speed || 35;
    }
    document.getElementById("overlay-dev-speed").textContent = `${speed} km/h`;
    
    // Status Badge
    const badge = document.getElementById("overlay-dev-status");
    badge.className = `badge ${dev.status}`;
    badge.textContent = dev.status;
    
    // Battery Status
    document.getElementById("overlay-dev-battery").textContent = `${dev.battery_level}%`;
    const icon = document.getElementById("overlay-dev-battery-icon");
    icon.className = `fa-solid ` + (
        dev.battery_level > 80 ? "fa-battery-full" : 
        dev.battery_level > 50 ? "fa-battery-three-quarters" : 
        dev.battery_level > 20 ? "fa-battery-quarter" : "fa-battery-empty"
    );
    
    if (dev.battery_level <= 15) {
        icon.style.color = "var(--status-offline)";
    } else {
        icon.style.color = "var(--status-online)";
    }
    
    // Time
    document.getElementById("overlay-dev-time").textContent = dev.last_sync ? formatRelativeTime(dev.last_sync) : "N/A";
}

// Fetch Alerts for bell dropdown
async function fetchAlerts() {
    try {
        const unreadAlerts = await API.getAlerts(true);
        AppState.alerts = unreadAlerts;
        
        // Update notification badges
        const badgeEl = document.getElementById("bell-badge-count");
        const navBadgeEl = document.getElementById("nav-alerts-badge");
        
        const count = unreadAlerts.length;
        if (count > 0) {
            badgeEl.classList.remove("hidden");
            badgeEl.textContent = count;
            
            navBadgeEl.classList.remove("hidden");
            navBadgeEl.textContent = count;
        } else {
            badgeEl.classList.add("hidden");
            navBadgeEl.classList.add("hidden");
        }
        
        // Render dropdown items
        const listEl = document.getElementById("mini-alerts-list");
        if (unreadAlerts.length === 0) {
            listEl.innerHTML = `<div class="loading-spinner">No unread alerts.</div>`;
            return;
        }
        
        // Take first 5 recent alerts
        const recents = unreadAlerts.slice(0, 5);
        listEl.innerHTML = recents.map(alert => {
            let icon = "fa-circle-exclamation text-danger";
            if (alert.type.includes("geofence")) icon = "fa-draw-polygon text-warning";
            if (alert.type.includes("battery")) icon = "fa-battery-quarter text-warning";
            
            return `
                <div class="dropdown-item-alert" onclick="switchTab('alerts')">
                    <div class="alert-title">
                        <span><i class="fa-solid ${icon}"></i> ${escapeHTML(alert.type.replace('_', ' ').toUpperCase())}</span>
                        <span class="time">${formatRelativeTime(alert.timestamp)}</span>
                    </div>
                    <p>${escapeHTML(alert.message)}</p>
                </div>
            `;
        }).join("");
        
        // Display toast alerts for extremely fresh events (within past 10 seconds)
        unreadAlerts.forEach(alert => {
            const alertTime = new Date(alert.timestamp).getTime();
            const nowTime = new Date().getTime();
            // If alert occurred in the last 6 seconds, throw a visual Toast popup
            if (nowTime - alertTime < 6000) {
                // Ensure we don't spam duplicate alerts
                const sessionKey = `notified-alert-${alert.id}`;
                if (!sessionStorage.getItem(sessionKey)) {
                    sessionStorage.setItem(sessionKey, "true");
                    showToast(
                        alert.type.replace('_', ' ').toUpperCase(),
                        alert.message,
                        alert.type === "offline" ? "danger" : "warning"
                    );
                }
            }
        });
        
    } catch (err) {
        console.error("Error loading alerts:", err);
    }
}

// Fetch Full Alerts Log for Alerts Page Tab
async function fetchFullAlertsLog() {
    const tbody = document.getElementById("alerts-table-body");
    tbody.innerHTML = `<tr><td colspan="6" class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Fetching alerts history...</td></tr>`;
    
    try {
        const alerts = await API.getAlerts(false); // get both read and unread
        if (alerts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 24px; color: var(--text-secondary);">No alerts recorded.</td></tr>`;
            return;
        }
        
        tbody.innerHTML = alerts.map(a => {
            const devName = a.device_name || "Unknown Tag";
            const rowClass = a.is_read ? "" : "unread-row";
            const statusBadge = a.is_read ? '<span class="badge" style="background: rgba(255,255,255,0.05); color: var(--text-secondary);">Read</span>' 
                                          : '<span class="badge bg-danger">New</span>';
            const actionBtn = a.is_read ? "" : `<button class="btn btn-secondary btn-sm operator-only" onclick="markRead(${a.id})">Acknowledge</button>`;
            
            let alertTypeClass = "warning";
            if (a.type === "offline") alertTypeClass = "offline";
            if (a.type.includes("exit")) alertTypeClass = "offline";
            if (a.type.includes("entry")) alertTypeClass = "online";
            
            return `
                <tr class="${rowClass}">
                    <td><strong>${escapeHTML(devName)}</strong></td>
                    <td><span class="badge ${alertTypeClass}">${a.type.replace('_', ' ')}</span></td>
                    <td>${escapeHTML(a.message)}</td>
                    <td>${formatDate(a.timestamp)}</td>
                    <td>${statusBadge}</td>
                    <td class="operator-only">${actionBtn}</td>
                </tr>
            `;
        }).join("");
        
        // Re-apply RBAC display in dynamically loaded content
        if (AppState.role === "Viewer") {
            document.querySelectorAll(".operator-only").forEach(el => el.classList.add("hidden"));
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 24px; color: var(--status-offline);">${err.message}</td></tr>`;
    }
}

// Mark alert as acknowledged
window.markRead = async function(alertId) {
    if (AppState.role === "Viewer") return;
    try {
        await API.markAlertRead(alertId);
        showToast("Alert Updated", "Notification acknowledged", "success");
        fetchFullAlertsLog();
        fetchAlerts();
    } catch (err) {
        showToast("Failed to Read Alert", err.message, "danger");
    }
};

// Fetch Geofences for Geofence list
async function fetchGeofences() {
    const list = document.getElementById("geofence-list-items");
    list.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Loading geofences...</div>`;
    
    try {
        const geofences = await API.getGeofences();
        AppState.geofences = geofences;
        
        // Redraw geofences on map
        GeofenceMap.drawGeofences(geofences);
        
        if (geofences.length === 0) {
            list.innerHTML = `<div class="loading-spinner">No geofences created.</div>`;
            return;
        }
        
        list.innerHTML = geofences.map(g => {
            return `
                <div class="geofence-card" id="gf-card-${g.id}" onclick="focusGeofence(${g.id}, ${g.latitude}, ${g.longitude}, ${g.radius})" title="Click to locate on map" style="cursor:pointer;">
                    <h4><i class="fa-solid fa-draw-polygon" style="color:var(--status-warning); margin-right:6px; font-size:11px;"></i>${escapeHTML(g.name)}</h4>
                    <p>Coordinates: <strong>${g.latitude.toFixed(4)}, ${g.longitude.toFixed(4)}</strong></p>
                    <p>Radius: <strong>${g.radius} meters</strong></p>
                    <button class="delete-btn-absolute operator-only" onclick="event.stopPropagation(); deleteGeofence(${g.id})" title="Delete virtual fence">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            `;
        }).join("");
        
        // Apply RBAC filters
        if (AppState.role === "Viewer") {
            document.querySelectorAll(".operator-only").forEach(el => el.classList.add("hidden"));
        }
    } catch (err) {
        list.innerHTML = `<div class="loading-spinner" style="color: var(--status-offline);">${err.message}</div>`;
    }
}

// Save Geofence
async function handleGeofenceSubmit(e) {
    e.preventDefault();
    if (AppState.role === "Viewer") return;
    
    const name = document.getElementById("gf-name").value.trim();
    const lat = parseFloat(document.getElementById("gf-lat").value);
    const lon = parseFloat(document.getElementById("gf-lon").value);
    const rad = parseFloat(document.getElementById("gf-radius").value);
    
    try {
        await API.createGeofence(name, lat, lon, rad);
        showToast("Geofence Created", `Virtual boundary '${name}' is now active`, "success");
        
        // Hide card and refresh list
        document.getElementById("add-geofence-card").classList.add("hidden");
        document.getElementById("add-geofence-form").reset();
        fetchGeofences();
    } catch (err) {
        showToast("Create Failed", err.message, "danger");
    }
}

// Delete Geofence
window.deleteGeofence = async function(id) {
    if (AppState.role === "Viewer") return;
    if (!confirm("Are you sure you want to delete this geofence? This might stop boundary violation alerts.")) return;
    
    try {
        await API.deleteGeofence(id);
        showToast("Geofence Removed", "Virtual boundary deleted successfully", "success");
        fetchGeofences();
    } catch (err) {
        showToast("Delete Failed", err.message, "danger");
    }
};

// Focus on a geofence on the map when its card is clicked
window.focusGeofence = function(id, lat, lon, radius) {
    // Highlight selected card
    document.querySelectorAll(".geofence-card").forEach(c => c.classList.remove("active"));
    const card = document.getElementById(`gf-card-${id}`);
    if (card) card.classList.add("active");

    // Fly the map to the geofence centre and open its tooltip
    GeofenceMap.flyToGeofence(lat, lon, radius);
};

// Populate History dropdown
async function populateHistoryDeviceSelect() {
    const select = document.getElementById("history-device-select");
    select.innerHTML = `<option value="">-- Choose Device --</option>`;
    
    try {
        const devices = await API.getDevices();
        devices.forEach(d => {
            const opt = document.createElement("option");
            opt.value = d.id;
            opt.textContent = `${d.name} (${d.hardware_id})`;
            select.appendChild(opt);
        });
        
        // Set default dates: start of today to now
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        
        document.getElementById("history-start-time").value = formatDateTimeLocal(startOfToday);
        document.getElementById("history-end-time").value = formatDateTimeLocal(now);
    } catch (err) {
        console.error("Failed to load devices list for history select:", err);
    }
}

// Query Trajectory History
async function handleHistoryQuery(e) {
    e.preventDefault();
    const devId = document.getElementById("history-device-select").value;
    const start = document.getElementById("history-start-time").value;
    const end = document.getElementById("history-end-time").value;
    
    // Convert local time to ISO strings
    const startISO = new Date(start).toISOString();
    const endISO = new Date(end).toISOString();
    
    try {
        const historyPoints = await API.getDeviceHistory(devId, startISO, endISO);
        
        if (historyPoints.length === 0) {
            showToast("No Telemetry Found", "No coordinates logged for this time range.", "warning");
            HistoryMap.clear();
            document.getElementById("history-replay-panel").classList.add("hidden");
            return;
        }
        
        showToast("History Loaded", `Fetched ${historyPoints.length} tracking path points`, "success");
        
        // Render path line and focus
        HistoryMap.drawHistoryPath(historyPoints);
        
        // Configure Replay Panel
        setupTrajectoryReplay(historyPoints);
    } catch (err) {
        showToast("Query Failed", err.message, "danger");
    }
}

// Configures slider and playback hooks for historical replays
let playbackTimer = null;
let playbackPoints = [];
let playbackIndex = 0;

function setupTrajectoryReplay(points) {
    playbackPoints = points;
    playbackIndex = 0;
    
    // Reset play state
    stopPlayback();
    
    const panel = document.getElementById("history-replay-panel");
    panel.classList.remove("hidden");
    
    // Update summary labels
    document.getElementById("history-summary-points").textContent = points.length;
    
    // Average Speed calculation
    const totalSpeed = points.reduce((acc, p) => acc + (p.speed || 0), 0);
    const avgSpeed = (totalSpeed / points.length).toFixed(1);
    document.getElementById("history-summary-speed").textContent = `${avgSpeed} km/h`;
    
    // Configure slider
    const slider = document.getElementById("playback-range-slider");
    slider.min = 0;
    slider.max = points.length - 1;
    slider.value = 0;
    
    updateReplayFrame();
    
    // Slider interaction
    slider.addEventListener("input", (e) => {
        playbackIndex = parseInt(e.target.value);
        updateReplayFrame();
    });
    
    // Play button hook
    const playBtn = document.getElementById("playback-btn-play");
    const pauseBtn = document.getElementById("playback-btn-pause");
    
    playBtn.onclick = () => {
        playBtn.classList.add("hidden");
        pauseBtn.classList.remove("hidden");
        startPlayback();
    };
    
    pauseBtn.onclick = () => {
        pauseBtn.classList.add("hidden");
        playBtn.classList.remove("hidden");
        stopPlayback();
    };
}

function startPlayback() {
    stopPlayback(); // just in case
    
    const speedSelect = document.getElementById("playback-speed-select");
    const slider = document.getElementById("playback-range-slider");
    
    const playStep = () => {
        if (playbackIndex >= playbackPoints.length - 1) {
            playbackIndex = 0; // restart
        } else {
            playbackIndex++;
        }
        
        slider.value = playbackIndex;
        updateReplayFrame();
        
        // Calculate speed ms
        const factor = parseInt(speedSelect.value);
        const intervalMs = Math.max(100, 1000 / factor);
        playbackTimer = setTimeout(playStep, intervalMs);
    };
    
    playStep();
}

function stopPlayback() {
    if (playbackTimer) {
        clearTimeout(playbackTimer);
        playbackTimer = null;
    }
}

function updateReplayFrame() {
    if (playbackPoints.length === 0 || playbackIndex >= playbackPoints.length) return;
    
    const p = playbackPoints[playbackIndex];
    
    // Draw current tracer marker on the history map
    HistoryMap.updateReplayMarker(p.latitude, p.longitude);
    
    // Labels
    document.getElementById("playback-current-time").textContent = formatTimeOnly(p.timestamp);
    document.getElementById("playback-speed-val").textContent = `${(p.speed || 0).toFixed(1)} km/h`;
}

// Fetch analytics and render Chart.js graphics
let telemetryChartObj = null;
let ratioChartObj = null;

async function fetchAnalytics() {
    try {
        const data = await API.getAnalytics();
        
        // Update stats counters
        document.getElementById("kpi-total-devices").textContent = data.total_devices;
        document.getElementById("kpi-online-devices").textContent = data.online_devices;
        document.getElementById("kpi-unread-alerts").textContent = data.unread_alerts;
        document.getElementById("kpi-total-geofences").textContent = data.total_geofences;
        
        // Fetch devices list to calculate chart metrics
        const devices = AppState.devices.length > 0 ? AppState.devices : await API.getDevices();
        
        // 1. Doughnut chart ratios (Online, Offline)
        const onlineCount = data.online_devices;
        const offlineCount = data.offline_devices;
        
        const ratioCtx = document.getElementById("ratio-chart").getContext("2d");
        if (ratioChartObj) {
            ratioChartObj.data.datasets[0].data = [onlineCount, offlineCount];
            ratioChartObj.update();
        } else {
            ratioChartObj = new Chart(ratioCtx, {
                type: "doughnut",
                data: {
                    labels: ["Online & Active", "Offline"],
                    datasets: [{
                        data: [onlineCount, offlineCount],
                        backgroundColor: ["#10b981", "#ef4444"],
                        borderWidth: 1,
                        borderColor: "#1f2937"
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: "bottom",
                            labels: { color: "#f3f4f6", boxWidth: 12, font: { family: 'Inter' } }
                        }
                    }
                }
            });
        }
        
        // 2. Telemetry Activity Frequency — real data from location_history
        const telemetryCtx = document.getElementById("telemetry-chart").getContext("2d");

        // Fetch actual per-minute counts from the backend
        const freqData = await API.getTelemetryFrequency(6);

        // Build a full 6-minute window so gaps show as 0 (not missing bars)
        const now = new Date();
        const labels = [];
        const pointsData = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 60000);
            const label = formatTimeOnly(d.toISOString()).slice(0, 5); // "HH:MM"
            labels.push(label);
            // Find matching minute slot from API response; default to 0 if no records
            const match = freqData.find(r => r.minute === label);
            pointsData.push(match ? match.count : 0);
        }

        if (!telemetryChartObj) {
            telemetryChartObj = new Chart(telemetryCtx, {
                type: "line",
                data: {
                    labels: labels,
                    datasets: [{
                        label: "Location Records / Minute",
                        data: pointsData,
                        borderColor: "#ff1f40",
                        backgroundColor: "rgba(255, 31, 64, 0.08)",
                        borderWidth: 2,
                        fill: true,
                        tension: 0.3,
                        pointRadius: 4,
                        pointBackgroundColor: "#ff1f40"
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: { color: "rgba(255,255,255,0.05)" },
                            ticks: { color: "#9ca3af", stepSize: 1 },
                            title: { display: true, text: "Records logged", color: "#6b7280", font: { size: 11 } }
                        },
                        x: {
                            grid: { display: false },
                            ticks: { color: "#9ca3af" },
                            title: { display: true, text: "Time (last 6 min)", color: "#6b7280", font: { size: 11 } }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: ctx => ` ${ctx.parsed.y} location record${ctx.parsed.y !== 1 ? 's' : ''} logged`
                            }
                        }
                    }
                }
            });
        } else {
            // Update existing chart with fresh real data
            telemetryChartObj.data.labels = labels;
            telemetryChartObj.data.datasets[0].data = pointsData;
            telemetryChartObj.update();
        }
    } catch (err) {
        console.error("Error drawing analytics:", err);
    }
}

// Fetch Devices for Registry (Admin Only)
async function fetchDevicesRegistry() {
    const tbody = document.getElementById("devices-table-body");
    tbody.innerHTML = `<tr><td colspan="6" class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Loading registry...</td></tr>`;
    
    try {
        const devices = await API.getDevices();
        if (devices.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 24px; color: var(--text-secondary);">No trackers registered.</td></tr>`;
            return;
        }
        
        tbody.innerHTML = devices.map(d => {
            const statusClass = d.status;
            const lastSync = d.last_sync ? formatDate(d.last_sync) : "N/A";
            
            return `
                <tr>
                    <td><code>${escapeHTML(d.hardware_id)}</code></td>
                    <td><strong>${escapeHTML(d.name)}</strong></td>
                    <td>${escapeHTML(d.assigned_asset || 'Unassigned')}</td>
                    <td><span class="badge ${statusClass}">${d.status}</span></td>
                    <td>${lastSync}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm" onclick="editDeviceModal(${d.id})">Edit</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteDeviceRegistry(${d.id})">Deregister</button>
                    </td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 24px; color: var(--status-offline);">${err.message}</td></tr>`;
    }
}

// Handle Add/Edit Device Registry Form Submission
async function handleDeviceSubmit(e) {
    e.preventDefault();
    if (AppState.role !== "Admin") return;
    
    const id = document.getElementById("modal-device-id").value;
    const hwId = document.getElementById("modal-hw-id").value.trim();
    const name = document.getElementById("modal-name").value.trim();
    const asset = document.getElementById("modal-asset").value.trim();
    
    const modal = document.getElementById("device-modal");
    
    try {
        if (id) {
            // Update
            await API.updateDevice(id, name, asset);
            showToast("Tag Config Updated", "Device assignment modified successfully", "success");
        } else {
            // Register
            await API.createDevice(hwId, name, asset);
            showToast("Tracker Registered", `Hardware '${hwId}' is now linked`, "success");
        }
        
        modal.classList.remove("active");
        modal.classList.add("hidden");
        fetchDevicesRegistry();
        fetchDevices();
    } catch (err) {
        showToast("Registry Failure", err.message, "danger");
    }
}

// Edit Device Modal
window.editDeviceModal = function(id) {
    if (AppState.role !== "Admin") return;
    const dev = AppState.devices.find(d => d.id === id);
    if (!dev) return;
    
    document.getElementById("device-modal-title").textContent = "Modify Tag Configuration";
    document.getElementById("btn-save-device-modal").textContent = "Save Changes";
    
    document.getElementById("modal-device-id").value = dev.id;
    document.getElementById("modal-hw-id").value = dev.hardware_id;
    document.getElementById("modal-hw-id").readOnly = true; // hardware ID is unique key, cannot edit
    document.getElementById("modal-name").value = dev.name;
    document.getElementById("modal-asset").value = dev.assigned_asset || "";
    
    const modalEl = document.getElementById("device-modal");
    modalEl.classList.remove("hidden");
    modalEl.classList.add("active");
};

// Delete Device Registry
window.deleteDeviceRegistry = async function(id) {
    if (AppState.role !== "Admin") return;
    const dev = AppState.devices.find(d => d.id === id);
    if (!dev) return;
    
    if (!confirm(`Deregister tracking tag '${dev.name}' (${dev.hardware_id})?\nAll historical coordinates will be permanently deleted.`)) return;
    
    try {
        await API.deleteDevice(id);
        showToast("Tracker Deregistered", `Tag '${dev.name}' deleted successfully`, "success");
        fetchDevicesRegistry();
        fetchDevices();
    } catch (err) {
        showToast("Delete Failure", err.message, "danger");
    }
};

// ─── User Management ────────────────────────────────────────────────────────

async function fetchUsers() {
    const tbody = document.getElementById("users-table-body");
    tbody.innerHTML = `<tr><td colspan="5" class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Loading users...</td></tr>`;

    try {
        const users = await API.getUsers();
        if (users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:24px; color:var(--text-secondary);">No users found.</td></tr>`;
            return;
        }

        const currentUser = AppState.currentUser;
        tbody.innerHTML = users.map(u => {
            const roleClass = u.role === "Admin" ? "online" : u.role === "Operator" ? "moving" : "warning";
            const isSelf = u.username === currentUser;
            return `
                <tr>
                    <td>${u.id}</td>
                    <td>
                        <strong>${escapeHTML(u.username)}</strong>
                        ${isSelf ? '<span class="badge online" style="margin-left:6px; font-size:10px;">You</span>' : ''}
                    </td>
                    <td><span class="badge ${roleClass}">${u.role}</span></td>
                    <td>${formatDate(u.created_at)}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm" onclick="editUserModal(${u.id}, '${escapeHTML(u.username)}', '${u.role}')">
                            <i class="fa-solid fa-pen"></i> Edit
                        </button>
                        ${!isSelf ? `<button class="btn btn-danger btn-sm" onclick="deleteUserAccount(${u.id}, '${escapeHTML(u.username)}')">
                            <i class="fa-solid fa-trash"></i> Delete
                        </button>` : ''}
                    </td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:24px; color:var(--status-offline);">${err.message}</td></tr>`;
    }
}

async function handleUserSubmit(e) {
    e.preventDefault();
    const id       = document.getElementById("modal-user-id").value;
    const username = document.getElementById("modal-username").value.trim();
    const role     = document.getElementById("modal-user-role").value;
    const password = document.getElementById("modal-user-password").value;
    const modal    = document.getElementById("user-modal");

    try {
        if (id) {
            // Edit mode — password optional
            await API.updateUser(id, role, password || null);
            showToast("User Updated", `${username}'s role set to ${role}`, "success");
        } else {
            // Add mode — password required
            if (!password) {
                showToast("Validation Error", "Password is required for new users", "danger");
                return;
            }
            await API.createUser(username, password, role);
            showToast("User Created", `Account '${username}' created as ${role}`, "success");
        }
        modal.classList.remove("active");
        modal.classList.add("hidden");
        fetchUsers();
    } catch (err) {
        showToast("Save Failed", err.message, "danger");
    }
}

window.editUserModal = function(id, username, role) {
    document.getElementById("user-modal-title").textContent = "Edit User";
    document.getElementById("btn-save-user-modal").textContent = "Save Changes";
    document.getElementById("modal-user-id").value = id;
    document.getElementById("modal-username").value = username;
    document.getElementById("modal-username").readOnly = true;
    document.getElementById("modal-user-role").value = role;
    document.getElementById("modal-user-password").value = "";
    document.getElementById("modal-user-password").required = false;
    document.getElementById("modal-password-hint").classList.remove("hidden");

    const modal = document.getElementById("user-modal");
    modal.classList.remove("hidden");
    modal.classList.add("active");
};

window.deleteUserAccount = async function(id, username) {
    if (!confirm(`Delete user '${username}'? This cannot be undone.`)) return;
    try {
        await API.deleteUser(id);
        showToast("User Deleted", `Account '${username}' has been removed`, "success");
        fetchUsers();
    } catch (err) {
        showToast("Delete Failed", err.message, "danger");
    }
};

// Fetch Audit Logs (Admin Only)
async function fetchAuditLogs() {
    const tbody = document.getElementById("audit-table-body");
    tbody.innerHTML = `<tr><td colspan="4" class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Fetching audit trials...</td></tr>`;
    
    try {
        const logs = await API.getAuditLogs();
        if (logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding: 24px; color: var(--text-secondary);">Audit trail is empty.</td></tr>`;
            return;
        }
        
        tbody.innerHTML = logs.map(l => {
            return `
                <tr>
                    <td><code>${formatDate(l.timestamp)}</code></td>
                    <td><strong>${escapeHTML(l.username)}</strong></td>
                    <td><span class="badge warning">${escapeHTML(l.action)}</span></td>
                    <td>${escapeHTML(l.details || 'No additional parameters')}</td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding: 24px; color: var(--status-offline);">${err.message}</td></tr>`;
    }
}

// --- Date Formatter Helpers ---

function formatRelativeTime(isoString) {
    const d = new Date(isoString);
    const now = new Date();
    const diffMs = now - d;
    const diffSec = Math.floor(diffMs / 1000);
    
    if (diffSec < 5) return "Just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    
    return d.toLocaleDateString();
}

function formatDate(isoString) {
    const d = new Date(isoString);
    return d.toLocaleString('en-IN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function formatTimeOnly(isoString) {
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function formatDateTimeLocal(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}
