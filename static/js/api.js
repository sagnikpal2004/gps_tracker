// --- API Client Layer ---

const API_BASE = "";

// Get stored session token
function getAuthToken() {
    return localStorage.getItem("gps_session_token");
}

// Check if authenticated
function isAuthenticated() {
    return !!getAuthToken();
}

// Generic Fetch Wrapper with Auth Headers
async function apiFetch(url, options = {}) {
    const token = getAuthToken();
    
    // Set headers
    const headers = {
        "Content-Type": "application/json",
        ...options.headers
    };
    
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    
    const config = {
        ...options,
        headers
    };
    
    try {
        const response = await fetch(url, config);
        
        if (response.status === 401) {
            // Unauthorized - clear credentials and redirect to login
            localStorage.removeItem("gps_session_token");
            localStorage.removeItem("gps_user_username");
            localStorage.removeItem("gps_user_role");
            
            // Show login screen overlay
            const loginScreen = document.getElementById("login-screen");
            if (loginScreen) loginScreen.classList.add("active");
            
            throw new Error("Session expired or unauthorized");
        }
        
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || "API request failed");
        }
        
        return data;
    } catch (error) {
        console.error(`API Error [${url}]:`, error);
        throw error;
    }
}

// --- API Service Methods ---
const API = {
    // Auth
    async login(username, password) {
        const res = await apiFetch("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });
        
        if (res.access_token) {
            localStorage.setItem("gps_session_token", res.access_token);
            localStorage.setItem("gps_user_username", res.username);
            localStorage.setItem("gps_user_role", res.role);
        }
        return res;
    },
    
    logout() {
        // Asynchronously notify backend of logout (ignore errors)
        apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        
        localStorage.removeItem("gps_session_token");
        localStorage.removeItem("gps_user_username");
        localStorage.removeItem("gps_user_role");
        
        const loginScreen = document.getElementById("login-screen");
        if (loginScreen) loginScreen.classList.add("active");
    },
    
    async getMe() {
        return await apiFetch("/api/auth/me");
    },
    
    // Devices
    async getDevices() {
        // return await apiFetch("/api/devices");
        // return await apiFetch("https://findhubapi.onrender.com/devices");
        return await (await fetch("http://15.206.183.128:8000/devices")).json();
        return await (await fetch("https://findhubapi.onrender.com/devices")).json();
        // return await apiFetch("http://localhost:8000/devices");
        return await (await fetch("http://localhost:8000/devices")).json();
    },
    
    async createDevice(hardware_id, name, assigned_asset) {
        return await apiFetch("/api/devices", {
            method: "POST",
            body: JSON.stringify({ hardware_id, name, assigned_asset })
        });
    },
    
    async updateDevice(id, name, assigned_asset) {
        return await apiFetch(`/api/devices/${id}`, {
            method: "PUT",
            body: JSON.stringify({ name, assigned_asset })
        });
    },
    
    async deleteDevice(id) {
        return await apiFetch(`/api/devices/${id}`, {
            method: "DELETE"
        });
    },
    
    // History
    async getDeviceHistory(id, start, end) {
        return await apiFetch(`/api/devices/${id}/history?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    },
    
    // Geofences
    async getGeofences() {
        return await apiFetch("/api/geofences");
    },
    
    async createGeofence(name, latitude, longitude, radius) {
        return await apiFetch("/api/geofences", {
            method: "POST",
            body: JSON.stringify({ name, latitude, longitude, radius })
        });
    },
    
    async deleteGeofence(id) {
        return await apiFetch(`/api/geofences/${id}`, {
            method: "DELETE"
        });
    },
    
    // Alerts
    async getAlerts(unreadOnly = false) {
        return await apiFetch(`/api/alerts?unread_only=${unreadOnly}&limit=100`);
    },
    
    async markAlertRead(id) {
        return await apiFetch(`/api/alerts/${id}/read`, {
            method: "POST"
        });
    },
    
    async markAllAlertsRead() {
        return await apiFetch("/api/alerts/read-all", {
            method: "POST"
        });
    },
    
    // User Management
    async getUsers() {
        return await apiFetch("/api/users");
    },

    async createUser(username, password, role) {
        return await apiFetch("/api/users", {
            method: "POST",
            body: JSON.stringify({ username, password, role })
        });
    },

    async updateUser(id, role, password = null) {
        return await apiFetch(`/api/users/${id}`, {
            method: "PUT",
            body: JSON.stringify({ role, password })
        });
    },

    async deleteUser(id) {
        return await apiFetch(`/api/users/${id}`, { method: "DELETE" });
    },

    // Analytics & Logs
    async getAnalytics() {
        return await apiFetch("/api/analytics");
    },

    async getTelemetryFrequency(minutes = 6) {
        return await apiFetch(`/api/analytics/telemetry-frequency?minutes=${minutes}`);
    },
    
    async getAuditLogs() {
        return await apiFetch("/api/audit-logs");
    },
    
    // Simulator Controls
    async setSimulatorActive(active) {
        return await apiFetch("/api/simulator/control", {
            method: "POST",
            body: JSON.stringify({ active })
        });
    },
    
    async getSimulatorStatus() {
        return await apiFetch("/api/simulator/status");
    },
    
    async resetSimulator() {
        return await apiFetch("/api/simulator/reset", {
            method: "POST"
        });
    }
};
