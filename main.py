import asyncio
import os
import urllib.request
import urllib.parse
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional
from fastapi import FastAPI, HTTPException, Depends, Header, Response, Cookie
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

import database
import simulator

# Simple in-memory session manager for user authentication
active_sessions = {}  # token -> {username, role, expires}

def create_session(username: str, role: str) -> str:
    token = f"session-{username}-{datetime.now().timestamp()}"
    expires = datetime.now() + timedelta(hours=8)
    active_sessions[token] = {
        "username": username,
        "role": role,
        "expires": expires
    }
    return token

def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized: Missing or invalid token")
    
    token = authorization.split(" ")[1]
    session = active_sessions.get(token)
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized: Session expired or invalid")
    
    if datetime.now() > session["expires"]:
        active_sessions.pop(token, None)
        raise HTTPException(status_code=401, detail="Unauthorized: Session expired")
        
    return session

def check_role(required_roles: list):
    def role_checker(user = Depends(get_current_user)):
        if user["role"] not in required_roles:
            raise HTTPException(status_code=403, detail="Forbidden: Insufficient permissions")
        return user
    return role_checker

# Keep track of last geofence crossings in memory to compare transitions
last_geofence_states = {} # maps (device_id, geofence_id) -> bool (True if inside, False if outside)

def sync_geofences_and_alerts(dev, lat, lon, battery, timestamp):
    dev_id = dev["id"]
    hw_id = dev["hardware_id"]
    
    # 1. Low battery alert
    if battery <= 15 and dev["battery_level"] > 15:
        database.add_alert(
            device_id=dev_id,
            alert_type="low_battery",
            message=f"Device {dev['name']} ({hw_id}) is low on battery: {battery}%",
            timestamp=timestamp
        )
        
    # 2. Geofence checks
    geofences = database.get_all_geofences()
    for gf in geofences:
        gf_id = gf["id"]
        gf_name = gf["name"]
        gf_lat = gf["latitude"]
        gf_lon = gf["longitude"]
        gf_radius = gf["radius"]
        
        dist = simulator.haversine_distance(lat, lon, gf_lat, gf_lon)
        is_inside = dist <= gf_radius
        
        state_key = (dev_id, gf_id)
        prev_inside = last_geofence_states.get(state_key)
        
        if prev_inside is not None:
            if is_inside and not prev_inside:
                # Entered geofence
                msg = f"Device '{dev['name']}' entered geofence '{gf_name}'."
                database.add_alert(dev_id, "geofence_entry", msg, timestamp)
            elif not is_inside and prev_inside:
                # Exited geofence
                msg = f"Device '{dev['name']}' exited geofence '{gf_name}'."
                database.add_alert(dev_id, "geofence_exit", msg, timestamp)
                
        last_geofence_states[state_key] = is_inside

# Settings to easily swap local mock API with a production Cloud API
FIND_HUB_API_URL = os.getenv("FIND_HUB_API_URL", "http://127.0.0.1:8000/api/findhub/devices")
FIND_HUB_API_KEY = os.getenv("FIND_HUB_API_KEY", "")
SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "5"))

async def fetch_findhub_data():
    """Performs HTTP GET to the external Find Hub API URL in a non-blocking thread."""
    try:
        # Fall back to direct function call if it's the local mock url to prevent connection errors when offline
        if "127.0.0.1" in FIND_HUB_API_URL or "localhost" in FIND_HUB_API_URL:
            return find_hub_devices()
            
        req = urllib.request.Request(FIND_HUB_API_URL)
        if FIND_HUB_API_KEY:
            req.add_header("Authorization", f"Bearer {FIND_HUB_API_KEY}")
        req.add_header("User-Agent", "Airtel-GPS-Dashboard/1.0")
        
        def perform_request():
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.loads(response.read().decode())
                
        return await asyncio.to_thread(perform_request)
    except Exception as e:
        # Fallback for local testing
        if "127.0.0.1" in FIND_HUB_API_URL or "localhost" in FIND_HUB_API_URL:
            return find_hub_devices()
        print(f"[Sync Error] Failed to fetch coordinates from {FIND_HUB_API_URL}: {e}")
        return None

async def sync_database_with_api():
    """Consumes Google Find Hub REST API via HTTP GET and synchronizes the local database (Option A)."""
    # 1. If pulling from our local mock server, trigger the simulator step first
    # to update the mock positions in memory.
    if "127.0.0.1" in FIND_HUB_API_URL or "localhost" in FIND_HUB_API_URL:
        simulator.run_simulation_step()
        
    # 2. Poll coordinates from the REST API URL
    payload = await fetch_findhub_data()
    if not payload:
        return
        
    timestamp = datetime.now().isoformat()
    
    # 3. Synchronize local SQLite database
    for device_data in payload.get("devices", []):
        hw_id = device_data["hardwareId"]
        coords = device_data.get("coordinates")

        telemetry = device_data["telemetry"]
        battery = telemetry["batteryPercent"]
        status = telemetry["status"]
        speed = telemetry.get("speed", 0.0)

        # Get matching database device
        dev = database.get_device_by_hw(hw_id)
        if not dev:
            continue

        if coords:
            lat = coords["latitude"]
            lon = coords["longitude"]

            # Write coordinates history log
            database.add_location_record(dev["id"], lat, lon, speed, battery, timestamp)

            # Sync geofence crossings & generate alerts
            sync_geofences_and_alerts(dev, lat, lon, battery, timestamp)

        # Always sync status and battery, even for offline/no-location devices
        database.update_device(dev["id"], dev["name"], dev["assigned_asset"], battery_level=battery, status=status)

# Background simulation task loop
async def simulation_loop():
    try:
        while True:
            if simulator.sim_state.simulation_active:
                await sync_database_with_api()
            await asyncio.sleep(SYNC_INTERVAL_SECONDS)
    except asyncio.CancelledError:
        pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    database.init_db()
    # Execute an immediate sync step so initial locations are active
    await sync_database_with_api()
    # Start sync loop in the background
    app.state.sim_task = asyncio.create_task(simulation_loop())
    yield
    # Shutdown
    app.state.sim_task.cancel()
    await app.state.sim_task

app = FastAPI(
    title="GPS Device Monitoring Dashboard API",
    description="Backend API serving telemetry data, devices registry, geofences, and alert logs.",
    version="1.0.0",
    lifespan=lifespan
)

# CORS Setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Pydantic Schemas for Requests ---

class LoginRequest(BaseModel):
    username: str
    password: str

class DeviceCreate(BaseModel):
    hardware_id: str
    name: str
    assigned_asset: Optional[str] = None

class DeviceUpdate(BaseModel):
    name: str
    assigned_asset: Optional[str] = None

class GeofenceCreate(BaseModel):
    name: str
    latitude: float
    longitude: float
    radius: float # in meters

class SimControlRequest(BaseModel):
    active: bool

class UserCreate(BaseModel):
    username: str
    password: str
    role: str  # 'Admin', 'Operator', 'Viewer'

class UserUpdate(BaseModel):
    role: str
    password: Optional[str] = None  # only set if changing password

# --- API Endpoints ---

# 1. Authentication Endpoints
@app.post("/api/auth/login")
def login(req: LoginRequest):
    user = database.get_user(req.username)
    if not user:
        raise HTTPException(status_code=400, detail="Invalid username or password")
    
    if not database.verify_password(user["password_hash"], req.password):
        raise HTTPException(status_code=400, detail="Invalid username or password")
    
    token = create_session(user["username"], user["role"])
    database.log_audit(user["username"], "Login", "User logged in successfully")
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": user["username"],
        "role": user["role"]
    }

@app.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        session = active_sessions.pop(token, None)
        if session:
            database.log_audit(session["username"], "Logout", "User logged out")
    return {"message": "Logged out successfully"}

@app.get("/api/auth/me")
def get_me(user = Depends(get_current_user)):
    return user

# 2. Devices Management Endpoints
# @app.get("/api/devices")
# def list_devices(user = Depends(get_current_user)):
#     return database.get_all_devices()

@app.post("/api/devices")
def create_device(req: DeviceCreate, user = Depends(check_role(["Admin"]))):
    existing = database.get_device_by_hw(req.hardware_id)
    if existing:
        raise HTTPException(status_code=400, detail="Device with this Hardware ID already exists")
    
    dev_id = database.add_device(req.hardware_id, req.name, req.assigned_asset)
    if not dev_id:
        raise HTTPException(status_code=500, detail="Failed to register device")
    
    # Initialize simulator path dynamically (default to Gurgaon, swap to Kolkata if matching name/HW ID)
    name_lower = req.name.lower()
    hw_lower = req.hardware_id.lower()
    if "kolkata" in name_lower or "kolkata" in hw_lower or "kol" in name_lower or "kol" in hw_lower:
        simulator.DEVICE_ROUTES[req.hardware_id] = simulator.PATH_KOLKATA_LOOP
    else:
        simulator.DEVICE_ROUTES[req.hardware_id] = simulator.PATH_CYBER_CITY_LOOP
    simulator.sim_state.device_indices[req.hardware_id] = 0
    
    database.log_audit(user["username"], "Register Device", f"Registered device {req.name} ({req.hardware_id})")
    return {"id": dev_id, "hardware_id": req.hardware_id, "name": req.name, "assigned_asset": req.assigned_asset}

@app.put("/api/devices/{device_id}")
def update_device(device_id: int, req: DeviceUpdate, user = Depends(check_role(["Admin", "Operator"]))):
    device = database.get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    
    database.update_device(device_id, req.name, req.assigned_asset)
    database.log_audit(user["username"], "Update Device", f"Updated device ID {device_id} metadata")
    return {"id": device_id, "name": req.name, "assigned_asset": req.assigned_asset}

@app.delete("/api/devices/{device_id}")
def delete_device(device_id: int, user = Depends(check_role(["Admin"]))):
    device = database.get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    
    # Clean up simulator map
    hw_id = device["hardware_id"]
    simulator.DEVICE_ROUTES.pop(hw_id, None)
    simulator.sim_state.device_indices.pop(hw_id, None)
    
    database.delete_device(device_id)
    database.log_audit(user["username"], "Delete Device", f"Deleted device ID {device_id} ({hw_id})")
    return {"message": "Device deleted successfully"}

# 3. Telemetry & History Endpoints
@app.get("/api/devices/{device_id}/history")
def get_device_history(device_id: int, start: str, end: str, user = Depends(get_current_user)):
    device = database.get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    
    try:
        # Validate timestamp formats
        datetime.fromisoformat(start)
        datetime.fromisoformat(end)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use ISO format (YYYY-MM-DDTHH:MM:SS)")
        
    return database.get_device_history(device_id, start, end)

# 4. Geofencing Endpoints
@app.get("/api/geofences")
def list_geofences(user = Depends(get_current_user)):
    return database.get_all_geofences()

@app.post("/api/geofences")
def create_geofence(req: GeofenceCreate, user = Depends(check_role(["Admin", "Operator"]))):
    g_id = database.add_geofence(req.name, req.latitude, req.longitude, req.radius)
    database.log_audit(user["username"], "Create Geofence", f"Created geofence '{req.name}' radius {req.radius}m")
    return {"id": g_id, "name": req.name, "latitude": req.latitude, "longitude": req.longitude, "radius": req.radius}

@app.delete("/api/geofences/{geofence_id}")
def delete_geofence(geofence_id: int, user = Depends(check_role(["Admin", "Operator"]))):
    database.delete_geofence(geofence_id)
    database.log_audit(user["username"], "Delete Geofence", f"Deleted geofence ID {geofence_id}")
    return {"message": "Geofence deleted successfully"}

# 5. Alerts Endpoints
@app.get("/api/alerts")
def list_alerts(limit: int = 50, unread_only: bool = False, user = Depends(get_current_user)):
    return database.get_all_alerts(limit, unread_only)

@app.post("/api/alerts/{alert_id}/read")
def read_alert(alert_id: int, user = Depends(check_role(["Admin", "Operator"]))):
    database.mark_alert_as_read(alert_id)
    return {"message": "Alert marked as read"}

@app.post("/api/alerts/read-all")
def read_all_alerts(user = Depends(check_role(["Admin", "Operator"]))):
    database.mark_all_alerts_read()
    return {"message": "All alerts marked as read"}

# 6. User Management Endpoints (Admin Only)
@app.get("/api/users")
def list_users(user = Depends(check_role(["Admin"]))):
    return database.get_all_users()

@app.post("/api/users")
def create_user(req: UserCreate, user = Depends(check_role(["Admin"]))):
    VALID_ROLES = ["Admin", "Operator", "Viewer"]
    if req.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {VALID_ROLES}")
    if database.get_user(req.username):
        raise HTTPException(status_code=400, detail="Username already exists")
    user_id = database.add_user(req.username, req.password, req.role)
    if not user_id:
        raise HTTPException(status_code=500, detail="Failed to create user")
    database.log_audit(user["username"], "Create User", f"Created user '{req.username}' with role {req.role}")
    return {"id": user_id, "username": req.username, "role": req.role}

@app.put("/api/users/{user_id}")
def update_user(user_id: int, req: UserUpdate, user = Depends(check_role(["Admin"]))):
    VALID_ROLES = ["Admin", "Operator", "Viewer"]
    if req.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {VALID_ROLES}")
    database.update_user(user_id, req.role, req.password)
    database.log_audit(user["username"], "Update User", f"Updated user ID {user_id} role to {req.role}")
    return {"id": user_id, "role": req.role}

@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, user = Depends(check_role(["Admin"]))):
    # Prevent admin from deleting their own account
    all_users = database.get_all_users()
    target = next((u for u in all_users if u["id"] == user_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target["username"] == user["username"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    database.delete_user(user_id)
    database.log_audit(user["username"], "Delete User", f"Deleted user '{target['username']}'")
    return {"message": "User deleted successfully"}

# 7. Analytics & Audit Logs Endpoints
@app.get("/api/analytics")
def get_analytics(user = Depends(get_current_user)):
    return database.get_analytics()

@app.get("/api/analytics/telemetry-frequency")
def get_telemetry_frequency(minutes: int = 6, user = Depends(get_current_user)):
    return database.get_telemetry_frequency(minutes)

@app.get("/api/audit-logs")
def list_audit_logs(limit: int = 50, user = Depends(check_role(["Admin"]))):
    return database.get_audit_logs(limit)

# 7. Simulator Control Endpoints (To toggle tracking and simulate)
@app.post("/api/simulator/control")
def control_simulator(req: SimControlRequest, user = Depends(check_role(["Admin", "Operator"]))):
    simulator.sim_state.simulation_active = req.active
    action = "started" if req.active else "paused"
    database.log_audit(user["username"], "Simulator Control", f"Simulator was {action}")
    return {"status": "success", "simulation_active": req.active}

@app.get("/api/simulator/status")
def get_simulator_status(user = Depends(get_current_user)):
    return {
        "simulation_active": simulator.sim_state.simulation_active,
        "device_indices": simulator.sim_state.device_indices
    }

@app.post("/api/simulator/reset")
def reset_simulator(user = Depends(check_role(["Admin", "Operator"]))):
    simulator.sim_state.reset()
    database.log_audit(user["username"], "Simulator Reset", "Simulator states reset to starting waypoints")
    return {"status": "success", "message": "Simulator reset completed"}

# 8. Simulated Find Hub REST API
# This mock endpoint returns the locations as if publishing from the hardware
@app.get("/api/findhub/devices")
def find_hub_devices():
    # Return raw Find Hub format
    db_devices = database.get_all_devices()
    find_hub_payload = []
    
    # Generate coordinates mapping representing what Find Hub would return
    for dev in db_devices:
        hw_id = dev["hardware_id"]
        # Match path positions and simulated telemetry state in memory
        path = simulator.DEVICE_ROUTES.get(hw_id)
        telemetry = simulator.sim_state.device_telemetry.get(hw_id)
        
        if path and telemetry:
            idx = simulator.sim_state.device_indices.get(hw_id, 0)
            lat, lon = path[idx]
            status = telemetry["status"]
            battery = telemetry["battery"]
        elif telemetry and not path:
            # Device has telemetry but no route (offline/static) — emit no-location entry
            status = telemetry["status"]
            battery = telemetry["battery"]
            find_hub_payload.append({
                "findHubId": f"fhub-{hw_id}",
                "hardwareId": hw_id,
                "deviceName": dev["name"],
                "coordinates": None,
                "telemetry": {
                    "batteryPercent": battery,
                    "signalStrengthDbm": -110,
                    "status": status,
                    "speed": 0.0,
                    "lastReported": datetime.now().isoformat()
                }
            })
            continue
        else:
            continue

        # Read simulated speed so it flows through to location_history
        sim_telemetry = simulator.sim_state.device_telemetry.get(hw_id, {})
        sim_speed = sim_telemetry.get("speed", 0.0) if status == "moving" else 0.0

        find_hub_payload.append({
            "findHubId": f"fhub-{hw_id}",
            "hardwareId": hw_id,
            "deviceName": dev["name"],
            "coordinates": {
                "latitude": lat,
                "longitude": lon
            },
            "telemetry": {
                "batteryPercent": battery,
                "signalStrengthDbm": -65 if status != "offline" else -110,
                "status": status,
                "speed": sim_speed,
                "lastReported": datetime.now().isoformat()
            }
        })
    return {"devices": find_hub_payload}

# --- Static File Serving & Root Routing ---

@app.get("/")
def read_root():
    return FileResponse("static/index.html")

@app.get("/google")
def read_google_root():
    return FileResponse("static/index1.html")

os.makedirs("static", exist_ok=True)
os.makedirs("static/css", exist_ok=True)
os.makedirs("static/js", exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")
