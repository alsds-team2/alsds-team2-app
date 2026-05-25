"""
migrate_to_azure_sql.py
-----------------------
Migration script: SQLite → Azure SQL
ALY 6080
Integrated Experiential Learning
Team 2

Tables migrated:
    cbg_master, pois, cbg_poi_stats,
    Competitor_Summary, params, cbg_geometries
"""

import os
import sqlite3
import pyodbc
import pandas as pd
import time

# ─── Config ──────────────────────────────────────────────────────────────────

# Path relative to the deployed app root on Azure
SQLITE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "Data", "urban_ai_v2.db"
)
CHUNK_SIZE = 5000

# ─── Azure SQL schema ─────────────────────────────────────────────────────────
# Drop order: child tables before parent tables (FK constraints)
# Create order: parent tables before child tables

DROP_ORDER = [
    "cbg_geometries",
    "cbg_poi_stats",
    "Competitor_Summary",
    "params",
    "pois",
    "cbg_master",
]

CREATE_ORDER = [
    "cbg_master",
    "pois",
    "cbg_poi_stats",
    "Competitor_Summary",
    "params",
    "cbg_geometries",
]

CREATE_STATEMENTS = {

    "cbg_master": """
        CREATE TABLE cbg_master (
            geoid           BIGINT             PRIMARY KEY,
            population      FLOAT,
            median_income   FLOAT,
            median_age      FLOAT,
            latitude        FLOAT,
            longitude       FLOAT,
            utm_x           FLOAT,
            utm_y           FLOAT
        )
    """,

    "pois": """
        CREATE TABLE pois (
            placekey        NVARCHAR(255)   PRIMARY KEY,
            top_category    NVARCHAR(255),
            naics_code      INT,
            area_sq_meters  FLOAT,
            utm_x           FLOAT,
            utm_y           FLOAT
        )
    """,

    "cbg_poi_stats": """
        CREATE TABLE cbg_poi_stats (
            geoid           BIGINT,
            placekey        NVARCHAR(255),
            top_category    NVARCHAR(255),
            naics_code      INT,
            distance_m      FLOAT,
            visit_count     INT             DEFAULT 0,
            PRIMARY KEY (geoid, placekey),
            FOREIGN KEY (geoid)     REFERENCES cbg_master(geoid),
            FOREIGN KEY (placekey)  REFERENCES pois(placekey)
        )
    """,

    "Competitor_Summary": """
        CREATE TABLE Competitor_Summary (
            geoid           BIGINT,
            top_category    NVARCHAR(255),
            naics_code      INT,
            sum_U_existing  FLOAT,
            PRIMARY KEY (geoid, top_category),
            FOREIGN KEY (geoid) REFERENCES cbg_master(geoid)
        )
    """,

    "params": """
        CREATE TABLE params (
            top_category    NVARCHAR(255)   PRIMARY KEY,
            naics_code      INT,
            alpha           FLOAT,
            beta            FLOAT,
            correlation     FLOAT
        )
    """,

    "cbg_geometries": """
        CREATE TABLE cbg_geometries (
            geoid       BIGINT             PRIMARY KEY,
            geometry    NVARCHAR(MAX),
            FOREIGN KEY (geoid) REFERENCES cbg_master(geoid)
        )
    """,
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_sqlite_conn():
    if not os.path.exists(SQLITE_PATH):
        raise FileNotFoundError(f"SQLite DB not found at: {SQLITE_PATH}")
    return sqlite3.connect(SQLITE_PATH)


def get_azure_conn():
    conn_str = os.getenv("SQL_CONNECTION_STRING")
    if not conn_str:
        raise EnvironmentError("SQL_CONNECTION_STRING is not set.")
    return pyodbc.connect(conn_str, timeout=30)


def drop_tables(azure_cursor, azure_conn):
    for table in DROP_ORDER:
        azure_cursor.execute(f"""
            IF OBJECT_ID('{table}', 'U') IS NOT NULL
                DROP TABLE [{table}]
        """)
        azure_conn.commit()


def create_tables(azure_cursor, azure_conn):
    for table in CREATE_ORDER:
        azure_cursor.execute(CREATE_STATEMENTS[table])
        azure_conn.commit()


def migrate_table(table_name, sqlite_conn, azure_conn):
    """Read all rows from SQLite and insert into Azure SQL in chunks."""
    df = pd.read_sql(f'SELECT * FROM "{table_name}"', sqlite_conn)
    total_rows = len(df)

    azure_cursor  = azure_conn.cursor()
    cols = ", ".join([f"[{c}]" for c in df.columns])
    placeholders  = ", ".join(["?" for _ in df.columns])
    insert_sql = f"INSERT INTO [{table_name}] ({cols}) VALUES ({placeholders})"

    inserted = 0
    for chunk_start in range(0, total_rows, CHUNK_SIZE):
        chunk = df.iloc[chunk_start: chunk_start + CHUNK_SIZE]
        rows  = [
            tuple(None if pd.isna(v) else v for v in row)
            for row in chunk.itertuples(index=False)
        ]
        azure_cursor.executemany(insert_sql, rows)
        azure_conn.commit()
        inserted += len(rows)

    return inserted


# ─── Main function called by /admin/migrate ───────────────────────────────────

def run_migration(table=None):
    """
    Migrate all tables from SQLite to Azure SQL.
    Returns a dict with migration results for JSON response.
    """
    start = time.time()
    rows_inserted = {}

    try:
        sqlite_conn  = get_sqlite_conn()
        azure_conn   = get_azure_conn()
        azure_cursor = azure_conn.cursor()

        if table:
            # Single table mode: only rebuild this one table
            azure_cursor.execute(f"""
                IF OBJECT_ID('{table}', 'U') IS NOT NULL
                    DROP TABLE [{table}]
            """)
            azure_conn.commit()
            azure_cursor.execute(CREATE_STATEMENTS[table])
            azure_conn.commit()
            count = migrate_table(table, sqlite_conn, azure_conn)
            rows_inserted[table] = count
        else:
            # Full mode: drop all → create all → migrate all
            drop_tables(azure_cursor, azure_conn)
            create_tables(azure_cursor, azure_conn)
            for t in CREATE_ORDER:
                count = migrate_table(t, sqlite_conn, azure_conn)
                rows_inserted[t] = count

        sqlite_conn.close()
        azure_conn.close()

        elapsed = round(time.time() - start, 1)

        return {
            "ok":             True,
            "message":        "Migration completed successfully",
            "tables_created": [table] if table else CREATE_ORDER,
            "rows_inserted":  rows_inserted,
            "elapsed_sec":    elapsed,
        }

    except Exception as e:
        import traceback
        return {
            "ok":     False,
            "error":  str(e),
            "detail": traceback.format_exc(),
        }
