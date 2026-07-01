import sqlite3
import os
import hashlib
import uuid
from datetime import datetime

DATABASE_FILE = "gps_dashboard.db"

def get_db_connection():
    conn = sqlite3.connect(DATABASE_FILE)
    conn.row_factory = sqlite3.Row
    # Enable Foreign Key constraints
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def hash_password(password: str, salt: str = None) -> str:
    """Hash password using SHA-256 with a salt."""
    if not salt:
        salt = uuid.uuid4().hex
    hashed = hashlib.sha256((password + salt).encode('utf-8')).hexdigest()
    return f"{salt}:{hashed}"

def verify_password(stored_password: str, provided_password: str) -> bool:
    """Verify a stored password against a provided password."""
    try:
        salt, hashed = stored_password.split(":")
        check = hashlib.sha256((provided_password + salt).encode('utf-8')).hexdigest()
        return check == hashed
    except ValueError:
        return False

def init_db():
    """Initialize database tables and seed initial data if empty."""
    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Users table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL, -- 'Admin', 'Operator', 'Viewer'
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # 2. Devices table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hardware_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        assigned_asset TEXT,
        status TEXT DEFAULT 'offline', -- 'online', 'offline', 'moving'
        battery_level INTEGER DEFAULT 100,
        last_sync TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # 3. Location History table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS location_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        speed REAL DEFAULT 0.0,
        battery_level INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
    )
    """)

    # Create index for fast retrieval of historical tracks
    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_location_history_device_timestamp 
    ON location_history(device_id, timestamp)
    """)

    # 4. Geofences table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS geofences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        radius REAL NOT NULL, -- radius in meters
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # 5. Alerts table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER,
        type TEXT NOT NULL, -- 'geofence_exit', 'geofence_entry', 'low_battery', 'offline'
        message TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_read INTEGER DEFAULT 0, -- 0 for false, 1 for true
        FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL
    )
    """)

    # 6. Audit Logs table (optional but good for User & Role Management)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # Commit tables creation
    conn.commit()

    # Seed admin user if it doesn't exist
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] == 0:
        admin_pass = hash_password("admin123")
        operator_pass = hash_password("operator123")
        viewer_pass = hash_password("viewer123")

        cursor.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ("admin", admin_pass, "Admin"))
        cursor.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ("operator", operator_pass, "Operator"))
        cursor.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ("viewer", viewer_pass, "Viewer"))
        conn.commit()

    # Seed default tracking devices if they don't exist
    cursor.execute("SELECT COUNT(*) FROM devices")
    if cursor.fetchone()[0] == 0:
        # (hardware_id, name, asset, status, battery, seed_lat, seed_lon)
        default_devices = [
            ("MAK-001", "MAK Field Tracker 1",    "Airtel Tech Van 1",          "online",  88, 28.4729, 77.0726),
            ("MAK-002", "MAK Asset Tag A",         "Mobile Tower Generator 4",   "online",  92, 28.4729, 77.0726),
            ("MAK-003", "MAK Employee Badge 12",   "On-Field Engr Rohit",        "online",  45, 28.4729, 77.0726),
            ("MAK-004", "MAK Router Tracker 8",    "Backup Core Link B",         "offline", 12, None,    None),
        ]
        now = datetime.now().isoformat()
        for hw_id, name, asset, status, battery, seed_lat, seed_lon in default_devices:
            cursor.execute(
                "INSERT INTO devices (hardware_id, name, assigned_asset, status, battery_level, last_sync) VALUES (?, ?, ?, ?, ?, ?)",
                (hw_id, name, asset, status, battery, now)
            )
            dev_id = cursor.lastrowid
            # Seed an initial location record for online devices so the map has coordinates on first load
            if seed_lat is not None and seed_lon is not None:
                cursor.execute(
                    "INSERT INTO location_history (device_id, latitude, longitude, speed, battery_level, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                    (dev_id, seed_lat, seed_lon, 0.0, battery, now)
                )
        conn.commit()

    # Seed default geofences (NCR regions)
    cursor.execute("SELECT COUNT(*) FROM geofences")
    if cursor.fetchone()[0] == 0:
        # Gurgaon HQ geofence: center Airtel HQ (28.4729, 77.0726), radius 1500m
        # Delhi Airport geofence: center (28.5562, 77.1000), radius 2500m
        cursor.execute(
            "INSERT INTO geofences (name, latitude, longitude, radius) VALUES (?, ?, ?, ?)",
            ("Airtel HQ Gurgaon", 28.4729, 77.0726, 1500.0)
        )
        cursor.execute(
            "INSERT INTO geofences (name, latitude, longitude, radius) VALUES (?, ?, ?, ?)",
            ("Delhi Airport Zone", 28.5562, 77.1000, 2500.0)
        )
        conn.commit()

    conn.close()

# --- Helper Queries ---

def get_user(username: str):
    conn = get_db_connection()
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return row

def get_all_users():
    conn = get_db_connection()
    rows = conn.execute("SELECT id, username, role, created_at FROM users ORDER BY id ASC").fetchall()
    conn.close()
    return [dict(row) for row in rows]

def add_user(username: str, password: str, role: str):
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            (username, hash_password(password), role)
        )
        conn.commit()
        user_id = cursor.lastrowid
        conn.close()
        return user_id
    except Exception:
        conn.close()
        return None

def update_user(user_id: int, role: str, password: str = None):
    conn = get_db_connection()
    if password:
        conn.execute(
            "UPDATE users SET role = ?, password_hash = ? WHERE id = ?",
            (role, hash_password(password), user_id)
        )
    else:
        conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    conn.commit()
    conn.close()

def delete_user(user_id: int):
    conn = get_db_connection()
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()

def log_audit(username: str, action: str, details: str = None):
    conn = get_db_connection()
    conn.execute("INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)", (username, action, details))
    conn.commit()
    conn.close()

def get_audit_logs(limit=50):
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(row) for row in rows]

# --- Devices ---
def get_all_devices():
    conn = get_db_connection()
    rows = conn.execute("""
        SELECT d.*, lh.latitude, lh.longitude, lh.speed 
        FROM devices d 
        LEFT JOIN location_history lh ON lh.id = (
            SELECT id FROM location_history 
            WHERE device_id = d.id 
            ORDER BY timestamp DESC, id DESC LIMIT 1
        )
    """).fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_device(device_id: int):
    conn = get_db_connection()
    row = conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

def get_device_by_hw(hardware_id: str):
    conn = get_db_connection()
    row = conn.execute("SELECT * FROM devices WHERE hardware_id = ?", (hardware_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

def add_device(hardware_id: str, name: str, assigned_asset: str = None):
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO devices (hardware_id, name, assigned_asset, last_sync) VALUES (?, ?, ?, ?)",
            (hardware_id, name, assigned_asset, datetime.now().isoformat())
        )
        conn.commit()
        dev_id = cursor.lastrowid
        conn.close()
        return dev_id
    except sqlite3.IntegrityError:
        conn.close()
        return None

def update_device(device_id: int, name: str, assigned_asset: str, battery_level: int = None, status: str = None):
    conn = get_db_connection()
    query = "UPDATE devices SET name = ?, assigned_asset = ?"
    params = [name, assigned_asset]
    if battery_level is not None:
        query += ", battery_level = ?"
        params.append(battery_level)
    if status is not None:
        query += ", status = ?"
        params.append(status)
    query += ", last_sync = ? WHERE id = ?"
    params.extend([datetime.now().isoformat(), device_id])
    
    conn.execute(query, tuple(params))
    conn.commit()
    conn.close()

def delete_device(device_id: int):
    conn = get_db_connection()
    conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    conn.commit()
    conn.close()

# --- Telemetry & History ---
def add_location_record(device_id: int, latitude: float, longitude: float, speed: float, battery_level: int, timestamp: str = None):
    conn = get_db_connection()
    if not timestamp:
        timestamp = datetime.now().isoformat()
    conn.execute(
        "INSERT INTO location_history (device_id, latitude, longitude, speed, battery_level, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        (device_id, latitude, longitude, speed, battery_level, timestamp)
    )
    # Update last_sync timestamp — status and battery are handled by update_device()
    conn.execute(
        "UPDATE devices SET last_sync = ? WHERE id = ?",
        (timestamp, device_id)
    )
    conn.commit()
    conn.close()

def get_device_history(device_id: int, start_time: str, end_time: str):
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT * FROM location_history WHERE device_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC",
        (device_id, start_time, end_time)
    )
    res = [dict(row) for row in rows]
    conn.close()
    return res

# --- Geofences ---
def get_all_geofences():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM geofences").fetchall()
    conn.close()
    return [dict(row) for row in rows]

def add_geofence(name: str, latitude: float, longitude: float, radius: float):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO geofences (name, latitude, longitude, radius) VALUES (?, ?, ?, ?)",
        (name, latitude, longitude, radius)
    )
    conn.commit()
    g_id = cursor.lastrowid
    conn.close()
    return g_id

def delete_geofence(geofence_id: int):
    conn = get_db_connection()
    conn.execute("DELETE FROM geofences WHERE id = ?", (geofence_id,))
    conn.commit()
    conn.close()

# --- Alerts ---
def add_alert(device_id: int, alert_type: str, message: str, timestamp: str = None):
    conn = get_db_connection()
    if not timestamp:
        timestamp = datetime.now().isoformat()
    
    # Avoid inserting exact duplicates in the last 1 minute to prevent alert spamming
    cursor = conn.cursor()
    cursor.execute(
        "SELECT COUNT(*) FROM alerts WHERE device_id = ? AND type = ? AND timestamp > datetime('now', '-1 minute')",
        (device_id, alert_type)
    )
    if cursor.fetchone()[0] == 0:
        cursor.execute(
            "INSERT INTO alerts (device_id, type, message, timestamp) VALUES (?, ?, ?, ?)",
            (device_id, alert_type, message, timestamp)
        )
        conn.commit()
    conn.close()

def get_all_alerts(limit=100, unread_only=False):
    conn = get_db_connection()
    query = "SELECT a.*, d.name as device_name FROM alerts a LEFT JOIN devices d ON a.device_id = d.id"
    params = []
    if unread_only:
        query += " WHERE a.is_read = 0"
    query += " ORDER BY a.timestamp DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, tuple(params)).fetchall()
    conn.close()
    return [dict(row) for row in rows]

def mark_alert_as_read(alert_id: int):
    conn = get_db_connection()
    conn.execute("UPDATE alerts SET is_read = 1 WHERE id = ?", (alert_id,))
    conn.commit()
    conn.close()

def mark_all_alerts_read():
    conn = get_db_connection()
def mark_all_alerts_read():
    conn = get_db_connection()
    conn.execute("UPDATE alerts SET is_read = 1")
    conn.commit()
    conn.close()

# --- Analytics ---
def get_analytics():
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) FROM devices")
    total_devices = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM devices WHERE status = 'online' OR status = 'moving'")
    online_devices = cursor.fetchone()[0]

    offline_devices = total_devices - online_devices

    cursor.execute("SELECT COUNT(*) FROM alerts WHERE is_read = 0")
    unread_alerts = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM location_history")
    total_telemetry_points = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM geofences")
    total_geofences = cursor.fetchone()[0]

    conn.close()
    return {
        "total_devices": total_devices,
        "online_devices": online_devices,
        "offline_devices": offline_devices,
        "unread_alerts": unread_alerts,
        "total_telemetry_points": total_telemetry_points,
        "total_geofences": total_geofences
    }

def get_telemetry_frequency(minutes: int = 6):
    """Returns location_history record counts per minute for the last N minutes."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT
            strftime('%H:%M', timestamp) AS minute_slot,
            COUNT(*) AS record_count
        FROM location_history
        WHERE timestamp >= datetime('now', ?)
        GROUP BY minute_slot
        ORDER BY minute_slot ASC
    """, (f'-{minutes} minutes',))
    rows = cursor.fetchall()
    conn.close()
    return [{"minute": row["minute_slot"], "count": row["record_count"]} for row in rows]

# --- User Management ---
def get_all_users():
    conn = get_db_connection()
    rows = conn.execute("SELECT id, username, role, created_at FROM users ORDER BY id ASC").fetchall()
    conn.close()
    return [dict(row) for row in rows]

def add_user(username: str, password: str, role: str):
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            (username, hash_password(password), role)
        )
        conn.commit()
        user_id = cursor.lastrowid
        conn.close()
        return user_id
    except Exception:
        conn.close()
        return None

def update_user(user_id: int, role: str, password: str = None):
    conn = get_db_connection()
    if password:
        conn.execute(
            "UPDATE users SET role = ?, password_hash = ? WHERE id = ?",
            (role, hash_password(password), user_id)
        )
    else:
        conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    conn.commit()
    conn.close()

def delete_user(user_id: int):
    conn = get_db_connection()
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
