import math
import random
from datetime import datetime
import database

# Haversine formula to compute distance in meters between two GPS coordinates
def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0  # Earth's radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0)**2 + \
        math.cos(phi1) * math.cos(phi2) * \
        math.sin(delta_lambda / 2.0)**2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c

# Core route landmarks (NCR region)
AIRTEL_HQ = (28.4729, 77.0726)
CYBER_CITY = (28.4963, 77.0878)
DELHI_AIRPORT = (28.5562, 77.1000)
IFFCO_CHOWK = (28.4722, 77.0500)
SECTOR_56 = (28.4230, 77.1000)

def interpolate_route(coords, steps_per_segment=15):
    dense_path = []
    for i in range(len(coords) - 1):
        start = coords[i]
        end = coords[i+1]
        for step in range(steps_per_segment):
            t = step / steps_per_segment
            lat = start[0] + (end[0] - start[0]) * t
            lng = start[1] + (end[1] - start[1]) * t
            dense_path.append((lat, lng))
    dense_path.append(coords[-1])
    return dense_path

# Define paths
PATH_CYBER_CITY_LOOP = interpolate_route([
    AIRTEL_HQ, 
    (28.4800, 77.0780), 
    (28.4870, 77.0810), 
    CYBER_CITY, 
    (28.4920, 77.0750), 
    (28.4800, 77.0680), 
    IFFCO_CHOWK, 
    AIRTEL_HQ
])

PATH_AIRPORT_RUN = interpolate_route([
    AIRTEL_HQ,
    (28.4850, 77.0850),
    (28.5050, 77.0980),
    (28.5250, 77.1050),
    (28.5400, 77.0970),
    DELHI_AIRPORT,
    (28.5400, 77.0970),
    (28.5250, 77.1050),
    (28.5050, 77.0980),
    AIRTEL_HQ
])

# Route designed specifically to weave in and out of the Airtel HQ 1500m geofence
PATH_GEOFENCE_WEAVE = interpolate_route([
    AIRTEL_HQ,                  # 0m (Inside)
    (28.4770, 77.0750),         # ~520m (Inside)
    (28.4850, 77.0810),         # ~1570m (Outside) -> Exits geofence!
    (28.4910, 77.0850),         # ~2350m (Outside)
    (28.4850, 77.0810),         # ~1570m (Outside)
    (28.4770, 77.0750),         # ~520m (Inside) -> Enters geofence!
    AIRTEL_HQ
])

PATH_KOLKATA_LOOP = interpolate_route([
    (22.5735, 88.4331), # Airtel Salt Lake Office, Kolkata
    (22.5780, 88.4350),
    (22.5820, 88.4380),
    (22.5850, 88.4420),
    (22.5800, 88.4450),
    (22.5710, 88.4400),
    (22.5680, 88.4350),
    (22.5735, 88.4331)  # Back to Office
])

# Map devices to default paths
DEVICE_ROUTES = {
    "MAK-001": PATH_CYBER_CITY_LOOP,
    "MAK-002": PATH_AIRPORT_RUN,
    "MAK-003": PATH_GEOFENCE_WEAVE,
    "MAK-004": None # This device is mocked as offline by default
}

# Keep track of device indices and telemetry states in memory
class SimulatorState:
    def __init__(self):
        self.device_indices = {
            "MAK-001": 0,
            "MAK-002": 0,
            "MAK-003": 0
        }
        self.device_telemetry = {
            "MAK-001": {"battery": 88, "status": "online", "speed": 0.0},
            "MAK-002": {"battery": 92, "status": "online", "speed": 0.0},
            "MAK-003": {"battery": 45, "status": "online", "speed": 0.0},
            "MAK-004": {"battery": 12, "status": "offline", "speed": 0.0},
        }
        self.simulation_active = True

    def reset(self):
        for k in self.device_indices:
            self.device_indices[k] = 0
        for k in self.device_telemetry:
            self.device_telemetry[k]["battery"] = 80 if k != "MAK-004" else 12
            self.device_telemetry[k]["status"] = "offline" if k == "MAK-004" else "online"
            self.device_telemetry[k]["speed"] = 0.0

sim_state = SimulatorState()

def run_simulation_step():
    """Ticks the simulator state in memory. Simulates cloud-side GPS hardware publisher."""
    if not sim_state.simulation_active:
        return

    for hw_id, path in DEVICE_ROUTES.items():
        if not path:
            continue

        # Get current step index
        current_idx = sim_state.device_indices.get(hw_id, 0)

        # Update index for next time
        next_idx = (current_idx + 1) % len(path)
        sim_state.device_indices[hw_id] = next_idx

        # Initialize telemetry if missing
        if hw_id not in sim_state.device_telemetry:
            sim_state.device_telemetry[hw_id] = {"battery": 100, "status": "online", "speed": 0.0}

        telemetry = sim_state.device_telemetry[hw_id]

        # Battery simulation
        if random.random() < 0.1:
            telemetry["battery"] = max(0, telemetry["battery"] - 1)

        # Speed and status simulation
        speed = float(random.randint(25, 52))
        telemetry["speed"] = speed
        telemetry["status"] = "moving" if speed > 0 else "online"

