# Backend Verification Script for GPS Device Monitoring Dashboard

import os
import database
import simulator
import main
import asyncio
from datetime import datetime

def run_tests():
    print("--- Starting Backend Compilation & Logic Validation ---")
    
    # 1. Clean previous database if any to test fresh creation
    if os.path.exists(database.DATABASE_FILE):
        try:
            os.remove(database.DATABASE_FILE)
            print("Removed old database file to ensure clean validation run.")
        except OSError as e:
            print(f"Could not remove old database: {e}")

    # 2. Initialize Database & Seed
    print("Initializing Database tables...")
    database.init_db()
    print("Database tables initialized successfully.")
    
    # 3. Test Users auth
    print("Verifying seeded users auth...")
    admin = database.get_user("admin")
    if not admin:
        raise AssertionError("Seeded admin user not found in database!")
    
    password_ok = database.verify_password(admin["password_hash"], "admin123")
    if not password_ok:
        raise AssertionError("Verification of default admin password failed!")
    print("Default Admin password verified successfully.")
    
    # 4. Test Devices query
    print("Verifying seeded devices...")
    devices = database.get_all_devices()
    print(f"Total seeded devices found: {len(devices)}")
    for d in devices:
        print(f"  - Device: {d['name']} ({d['hardware_id']}) status: {d['status']} battery: {d['battery_level']}%")
        
    if len(devices) < 4:
        raise AssertionError(f"Expected at least 4 default devices, found {len(devices)}")

    # 5. Test Geofence query
    print("Verifying seeded geofences...")
    geofences = database.get_all_geofences()
    print(f"Total seeded geofences: {len(geofences)}")
    for g in geofences:
        print(f"  - Geofence: {g['name']} lat: {g['latitude']} lon: {g['longitude']} radius: {g['radius']}m")
        
    if len(geofences) < 2:
        raise AssertionError("Expected default geofences to be seeded!")

    # 6. Test Simulator tick logic
    print("Running initial simulation tick...")
    asyncio.run(main.sync_database_with_api())
    
    # Check if location history is populated
    devices_after_tick = database.get_all_devices()
    print("Telemetry coordinates after simulation tick:")
    for d in devices_after_tick:
        if d['status'] != 'offline':
            print(f"  - Device: {d['name']} lat: {d['latitude']} lon: {d['longitude']} speed: {d['speed']} km/h battery: {d['battery_level']}%")
            if d['latitude'] is None or d['longitude'] is None:
                raise AssertionError(f"Coordinates were not logged for online device {d['name']} after simulator tick!")
        else:
            print(f"  - Device: {d['name']} is offline (as expected)")
            
    # Check that location history entries exist
    conn = database.get_db_connection()
    count = conn.execute("SELECT COUNT(*) FROM location_history").fetchone()[0]
    conn.close()
    print(f"Total entries in location_history: {count}")
    if count == 0:
        raise AssertionError("Expected location history rows to be inserted after simulation tick!")

    # 7. Test Geofence Crossing Trigger Simulation
    print("Validating geofencing alert system...")
    # Add a mock geofence center on Cyber City path start to trigger entry
    # Cyber City Loop Waypoint 0 is Airtel HQ (28.4729, 77.0726)
    # Let's add a small geofence directly on it
    test_gf_id = database.add_geofence("Test Immediate Area", 28.4729, 77.0726, 100.0)
    
    # Run a tick
    asyncio.run(main.sync_database_with_api())
    
    # Check alerts
    alerts = database.get_all_alerts()
    print(f"Total alerts triggered: {len(alerts)}")
    for a in alerts:
        print(f"  - Alert: type: {a['type']} msg: {a['message']} time: {a['timestamp']}")
        
    print("--- Backend Compilation & Logic Validation Success! ---")

if __name__ == "__main__":
    run_tests()
