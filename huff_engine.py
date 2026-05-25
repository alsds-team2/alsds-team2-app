"""
huff_engine.py  —  Huff Gravity Model V3
ALY 6080 · Integrated Experiential Learning · Team 2
"""

import math
import time
import os
import numpy as np
import pandas as pd
from db import get_connection

# ─── UTM Projection Function (EPSG:26919 — NAD83 UTM Zone 19N) ───────────────

def wgs84_to_utm_zone19n_nad83(latitude, longitude):
    a   = 6_378_137.0
    f   = 1 / 298.257222101
    e2  = 2 * f - f ** 2
    k0  = 0.9996
    E0  = 500_000.0
    lon0 = math.radians(-69.0)

    lat_r = math.radians(latitude)
    lon_r = math.radians(longitude)

    N = a / math.sqrt(1 - e2 * math.sin(lat_r) ** 2)
    T = math.tan(lat_r) ** 2
    C = (e2 / (1 - e2)) * math.cos(lat_r) ** 2
    A = math.cos(lat_r) * (lon_r - lon0)

    M = a * (
        (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * lat_r
        - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2 * lat_r)
        + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4 * lat_r)
        - (35*e2**3/3072) * math.sin(6 * lat_r)
    )

    x = E0 + k0 * N * (
        A
        + (1 - T + C) * A**3 / 6
        + (5 - 18*T + T**2 + 72*C - 58*(e2/(1-e2))) * A**5 / 120
    )
    y = k0 * (
        M + N * math.tan(lat_r) * (
            A**2 / 2
            + (5 - T + 9*C + 4*C**2) * A**4 / 24
            + (61 - 58*T + T**2 + 600*C - 330*(e2/(1-e2))) * A**6 / 720
        )
    )
    return x, y


# ─── Main inference function ──────────────────────────────────────────────────

def run_huff_model(
    candidate_lat,
    candidate_lon,
    business_category,
    floor_area,
    db_connection=None
):
    """
    Run the Huff Gravity Model V3 for a candidate store location.

    Parameters
    ----------
    candidate_lat      : float  — WGS84 latitude of the candidate store
    candidate_lon      : float  — WGS84 longitude of the candidate store
    business_category  : str    — top_category name or NAICS code (int or str)
    floor_area         : float  — candidate store area in square meters
    db_connection      : optional sqlite3 connection (uses DB_PATH if None)

    Returns
    -------
    dict with keys:
        predicted_visits  float   — total predicted annual visits
        market_share      float   — weighted average market share across CBGs
        competitors       list    — top competitor businesses
        runtime_ms        float   — execution time in milliseconds
        notes             str     — model notes / warnings
    """

    start_time = time.time()
    notes = []

    # ── 1. Database connection ────────────────────────────────────────────────
    own_connection = False
    if db_connection is not None:
        conn   = db_connection
        cursor = conn.cursor()
    else:
        conn   = get_connection()
        cursor = conn.cursor()
        own_connection = True

    try:
        # ── 2. Parameter lookup (alpha, beta) ─────────────────────────────────
        user_input = str(business_category).strip()

        cursor.execute("""
            SELECT alpha, beta, top_category
            FROM params
            WHERE top_category = ?
        """, (user_input,))
        row = cursor.fetchone()

        if row is None:
            try:
                naics_int = int(user_input)
                cursor.execute("""
                    SELECT alpha, beta, top_category
                    FROM params
                    WHERE naics_code = ?
                """, (naics_int,))
                row = cursor.fetchone()
            except ValueError:
                pass

        if row is None:
            alpha            = 1.0
            beta             = 2.0
            matched_category = user_input
            notes.append(
                f"Category '{user_input}' not found in params. "
                f"Using default alpha=1.0, beta=2.0."
            )
        else:
            alpha            = row[0]
            beta             = row[1]
            matched_category = row[2]

        # ── 3. Project new store to UTM (one projection per query) ────────────
        utm_x_new, utm_y_new = wgs84_to_utm_zone19n_nad83(
            candidate_lat, candidate_lon
        )

        # ── 4. Fetch pre-stored CBG coordinates + vectorized distance ─────────
        cursor.execute("""
            SELECT geoid, utm_x, utm_y
            FROM cbg_master
        """)
        cbg_rows = cursor.fetchall()
        cbgs_df  = pd.DataFrame(cbg_rows, columns=["geoid", "utm_x", "utm_y"])

        # NumPy C-level broadcast — no Python loop per CBG
        dx = cbgs_df["utm_x"].values - utm_x_new
        dy = cbgs_df["utm_y"].values - utm_y_new
        cbgs_df["dist_to_new"] = np.maximum(np.sqrt(dx**2 + dy**2), 1.0)

        # ── 5. Fetch pre-computed competitor utility (Competitor_Summary) ──────
        # This single indexed lookup replaces ~4,768 per-query computations.
        cursor.execute("""
            SELECT geoid, sum_U_existing
            FROM Competitor_Summary
            WHERE top_category = ?
        """, (matched_category,))
        utility_rows = cursor.fetchall()
        utility_df   = pd.DataFrame(utility_rows, columns=["geoid", "sum_U_existing"])

        cbgs_df = cbgs_df.merge(utility_df, on="geoid", how="left")
        cbgs_df["sum_U_existing"] = cbgs_df["sum_U_existing"].fillna(0)

        # ── 6. Huff Model: utility, probability, predicted visits ─────────────
        cbgs_df["U_new"] = (floor_area ** alpha) / (cbgs_df["dist_to_new"] ** beta)

        total_U          = cbgs_df["U_new"] + cbgs_df["sum_U_existing"]
        cbgs_df["P_new"] = np.where(total_U > 0, cbgs_df["U_new"] / total_U, 0)

        # Fetch historical demand per CBG for this category
        cursor.execute("""
            SELECT s.geoid, SUM(s.visit_count) AS total_demand
            FROM cbg_poi_stats s
            JOIN pois p ON s.placekey = p.placekey
            WHERE p.top_category = ?
            GROUP BY s.geoid
        """, (matched_category,))
        demand_rows = cursor.fetchall()
        demand_df   = pd.DataFrame(demand_rows, columns=["geoid", "total_demand"])

        cbgs_df = cbgs_df.merge(demand_df, on="geoid", how="left")
        cbgs_df["total_demand"]     = cbgs_df["total_demand"].fillna(0)
        cbgs_df["predicted_visits"] = cbgs_df["P_new"] * cbgs_df["total_demand"]

        total_visits  = round(float(cbgs_df["predicted_visits"].sum()), 2)
        total_demand  = float(cbgs_df["total_demand"].sum())

        # Weighted average market share across CBGs with demand
        active = cbgs_df[cbgs_df["total_demand"] > 0]
        if len(active) > 0 and total_demand > 0:
            market_share = round(
                float((active["P_new"] * active["total_demand"]).sum() / total_demand),
                6
            )
        else:
            market_share = 0.0

        # ── 7. Build competitor list ──────────────────────────────────────────
        # Top competitors by utility score, with distance in miles
        cursor.execute("""
            SELECT p.placekey,
                   p.top_category,
                   p.naics_code,
                   p.area_sq_meters,
                   p.utm_x,
                   p.utm_y
            FROM pois p
            WHERE p.top_category = ?
            LIMIT 50
        """, (matched_category,))
        comp_rows = cursor.fetchall()

        competitors = []
        for cr in comp_rows:
            placekey, top_cat, naics, area, c_utm_x, c_utm_y = cr
            if c_utm_x is None or c_utm_y is None:
                continue
            dist_m     = max(math.sqrt((c_utm_x - utm_x_new)**2 +
                                       (c_utm_y - utm_y_new)**2), 1.0)
            dist_miles = round(dist_m / 1609.34, 3)
            attraction = round(
                (area ** alpha) / (dist_m ** beta) if area else 0.0, 4
            )
            competitors.append({
                "name":           top_cat,
                "placekey":       placekey,
                "naics_code":     naics,
                "size":           round(float(area), 1) if area else 0.0,
                "distance_miles": dist_miles,
                "attraction":     attraction,
            })

        # Sort by attraction (highest first), keep top 10
        competitors.sort(key=lambda x: x["attraction"], reverse=True)
        competitors = competitors[:10]

        # ── 8. Timing ─────────────────────────────────────────────────────────
        runtime_ms = round((time.time() - start_time) * 1000, 2)

        return {
            "predicted_visits": total_visits,
            "market_share":     market_share,
            "competitors":      competitors,
            "runtime_ms":       runtime_ms,
            "notes":            " | ".join(notes) if notes else
                                f"V3 DB engine · matched category: {matched_category}",
            "inputs": {
                "candidate_lat":     candidate_lat,
                "candidate_lon":     candidate_lon,
                "business_category": business_category,
                "floor_area":        floor_area,
            },
        }

    finally:
        # Only close the connection if we opened it ourselves
        if own_connection:
            conn.close()
