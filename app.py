import os
from flask import Flask, request, jsonify, render_template
from openai import AzureOpenAI
import json
from db import test_connection, get_connection

app = Flask(__name__)


# -------------------------
# Azure OpenAI Setup
# -------------------------

client = AzureOpenAI(
    api_key=os.getenv("AZURE_OPENAI_API_KEY"),
    api_version=os.getenv("AZURE_OPENAI_API_VERSION"),
    azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
)

DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT")

# -------------------------
# Routes
# -------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/dbcheck")
def dbcheck():
    try:
        ok = test_connection()
        return jsonify({"ok": ok})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# -------------------------
# Admin: Migration
# -------------------------

# @app.route("/admin/migrate")
# def admin_migrate():
#     try:
#         table  = request.args.get("table")
#         offset = request.args.get("offset", 0, type=int)
#         limit  = request.args.get("limit", 50000, type=int)
#         from migrate_to_azure_sql import run_migration
#         result = run_migration(table=table, offset=offset, limit=limit)
#         return jsonify(result)
#     except Exception as e:
#         return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/admin/naics_list")
def naics_list():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT DISTINCT naics_code, top_category FROM pois ORDER BY naics_code")
    rows = [{"naics_code": r[0], "top_category": r[1]} for r in cursor.fetchall()]
    conn.close()
    return jsonify(rows)
# -------------------------
# DB Structure Verification
# -------------------------

@app.route("/db_structure")
def db_structure():
    try:
        conn   = get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT TABLE_NAME
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_NAME
        """)
        tables = [row[0] for row in cursor.fetchall()]

        result = []
        for table in tables:
            cursor.execute(f"SELECT COUNT(*) FROM [{table}]")
            count = cursor.fetchone()[0]
            result.append({
                "TABLE_NAME": table,
                "row_count":  count
            })

        conn.close()
        return jsonify(result)

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# -------------------------
# Run Huff Model
# -------------------------

@app.route("/api/run_huff", methods=["POST"])
def api_run_huff():
    try:
        from huff_engine import run_huff_model

        data = request.get_json(silent=True) or {}

        candidate_lat = get_first_present(data, ["candidate_lat", "lat", "latitude"])
        candidate_lon = get_first_present(data, ["candidate_lon", "lon", "lng", "longitude"])
        business_category = get_first_present(data, ["business_category", "naics_code", "naics"])
        floor_area = get_first_present(data, ["floor_area", "floor_area_sqm", "area", "area_sqm"])

        missing = []
        if candidate_lat is None:
            missing.append("candidate_lat")
        if candidate_lon is None:
            missing.append("candidate_lon")
        if business_category is None:
            missing.append("business_category or naics_code")
        if floor_area is None:
            missing.append("floor_area or floor_area_sqm")

        if missing:
            return jsonify({
                "ok": False,
                "error": "Missing required inputs: " + ", ".join(missing)
            }), 400

        try:
            candidate_lat = float(candidate_lat)
            candidate_lon = float(candidate_lon)
            floor_area = float(floor_area)
            business_category = str(business_category).strip()
        except Exception:
            return jsonify({
                "ok": False,
                "error": "Invalid input type. Latitude, longitude, and floor area must be numeric. NAICS/business category must be provided."
            }), 400

        if not business_category:
            return jsonify({"ok": False, "error": "Business category / NAICS code cannot be empty."}), 400

        if candidate_lat < -90 or candidate_lat > 90:
            return jsonify({"ok": False, "error": "candidate_lat must be between -90 and 90."}), 400

        if candidate_lon < -180 or candidate_lon > 180:
            return jsonify({"ok": False, "error": "candidate_lon must be between -180 and 180."}), 400

        if floor_area <= 0:
            return jsonify({"ok": False, "error": "floor_area must be greater than zero."}), 400

        result = run_huff_model(
            candidate_lat=candidate_lat,
            candidate_lon=candidate_lon,
            business_category=business_category,
            floor_area=floor_area,
            db_connection=None  # Teams can replace this with Azure SQL usage
        )

        explanation = generate_explanation(result)

        return jsonify({
            "ok": True,
            "inputs": {
                "candidate_lat": candidate_lat,
                "candidate_lon": candidate_lon,
                "business_category": business_category,
                "floor_area": floor_area
            },
            "result": result,
            "explanation": explanation
        })

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# -------------------------
# Ask Follow-up Questions
# -------------------------

@app.route("/api/ask", methods=["POST"])
def api_ask():
    try:
        data = request.get_json(silent=True) or {}
        question = data.get("question")
        result = data.get("result")

        if not question or not result:
            return jsonify({"ok": False, "error": "Missing question or result"}), 400

        answer = answer_question(question, result)

        return jsonify({"ok": True, "answer": answer})

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

NAICS_CALIBRATED = {
    "3399": "Other Miscellaneous Manufacturing",
    "4441": "Building Material and Supplies Dealers",
    "6214": "Outpatient Care Centers",
    "311811": "Bakeries and Tortilla Manufacturing",
    "441310": "Automotive Parts, Accessories, and Tire Stores",
    "445310": "Beer, Wine, and Liquor Stores",
    "447110": "Gasoline Stations",
    "448310": "Jewelry, Luggage, and Leather Goods Stores",
    "452319": "General Merchandise Stores, including Warehouse Clubs and Supercenters",
    "453991": "Other Miscellaneous Store Retailers",
    "512240": "Sound Recording Industries",
    "517312": "Wired and Wireless Telecommunications Carriers",
    "522110": "Depository Credit Intermediation",
    "522310": "Activities Related to Credit Intermediation",
    "523930": "Other Financial Investment Activities",
    "524113": "Insurance Carriers",
    "531120": "Lessors of Real Estate",
    "531210": "Offices of Real Estate Agents and Brokers",
    "611310": "Colleges, Universities, and Professional Schools",
    "621210": "Offices of Dentists",
    "621511": "Medical and Diagnostic Laboratories",
    "812910": "Other Personal Services",
    "922110": "Justice, Public Order, and Safety Activities"
}

NAICS_FALLBACK = {
    "485": "Transit and Ground Passenger Transportation",
    "487": "Scenic and Sightseeing Transportation",
    "562": "Waste Management and Remediation Services",
    "623": "Nursing and Residential Care Facilities",
    "2382": "Building Equipment Contractors",
    "2383": "Building Finishing Contractors",
    "2389": "Other Specialty Trade Contractors",
    "3231": "Printing and Related Support Activities",
    "4238": "Machinery, Equipment, and Supplies Merchant Wholesalers",
    "4422": "Home Furnishings Stores",
    "4442": "Lawn and Garden Equipment and Supplies Stores",
    "4481": "Clothing Stores",
    "5151": "Radio and Television Broadcasting",
    "5412": "Accounting, Tax Preparation, Bookkeeping, and Payroll Services",
    "5414": "Specialized Design Services",
    "5416": "Management, Scientific, and Technical Consulting Services",
    "5418": "Advertising, Public Relations, and Related Services",
    "5616": "Investigation and Security Services",
    "6115": "Technical and Trade Schools",
    "6215": "Medical and Diagnostic Laboratories",
    "6233": "Continuing Care Retirement Communities and Assisted Living Facilities for the Elderly",
    "6241": "Individual and Family Services",
    "7111": "Performing Arts Companies",
    "8111": "Automotive Repair and Maintenance",
    "8122": "Death Care Services",
    "9231": "Administration of Human Resource Programs",
    "9261": "Administration of Economic Programs",
    "54192": "Other Professional, Scientific, and Technical Services",
    "81211": "Personal Care Services",
    "221111": "Electric Power Generation, Transmission and Distribution",
    "237110": "Utility System Construction",
    "238140": "Foundation, Structure, and Building Exterior Contractors",
    "238150": "Foundation, Structure, and Building Exterior Contractors",
    "238220": "Building Equipment Contractors",
    "238330": "Building Finishing Contractors",
    "238390": "Building Finishing Contractors",
    "312120": "Beverage Manufacturing",
    "312130": "Beverage Manufacturing",
    "323113": "Printing and Related Support Activities",
    "323117": "Printing and Related Support Activities",
    "335220": "Household Appliance Manufacturing",
    "339950": "Other Miscellaneous Manufacturing",
    "423330": "Lumber and Other Construction Materials Merchant Wholesalers",
    "423450": "Professional and Commercial Equipment and Supplies Merchant Wholesalers",
    "423610": "Household Appliances and Electrical and Electronic Goods Merchant Wholesalers",
    "423690": "Household Appliances and Electrical and Electronic Goods Merchant Wholesalers",
    "423720": "Hardware, and Plumbing and Heating Equipment and Supplies Merchant Wholesalers",
    "423730": "Hardware, and Plumbing and Heating Equipment and Supplies Merchant Wholesalers",
    "423740": "Hardware, and Plumbing and Heating Equipment and Supplies Merchant Wholesalers",
    "423820": "Machinery, Equipment, and Supplies Merchant Wholesalers",
    "423830": "Machinery, Equipment, and Supplies Merchant Wholesalers",
    "423850": "Machinery, Equipment, and Supplies Merchant Wholesalers",
    "423910": "Miscellaneous Durable Goods Merchant Wholesalers",
    "424210": "Drugs and Druggists' Sundries Merchant Wholesalers",
    "441110": "Automobile Dealers",
    "441120": "Automobile Dealers",
    "441222": "Other Motor Vehicle Dealers",
    "441228": "Other Motor Vehicle Dealers",
    "441320": "Automotive Parts, Accessories, and Tire Stores",
    "442110": "Furniture Stores",
    "442210": "Home Furnishings Stores",
    "442299": "Home Furnishings Stores",
    "443141": "Electronics and Appliance Stores",
    "443142": "Electronics and Appliance Stores",
    "444110": "Building Material and Supplies Dealers",
    "444120": "Building Material and Supplies Dealers",
    "444130": "Building Material and Supplies Dealers",
    "444190": "Building Material and Supplies Dealers",
    "445110": "Grocery Stores",
    "445120": "Grocery Stores",
    "445210": "Specialty Food Stores",
    "445220": "Specialty Food Stores",
    "445230": "Specialty Food Stores",
    "445292": "Specialty Food Stores",
    "445299": "Specialty Food Stores",
    "446110": "Health and Personal Care Stores",
    "446120": "Health and Personal Care Stores",
    "446191": "Health and Personal Care Stores",
    "446199": "Health and Personal Care Stores",
    "448140": "Clothing Stores",
    "448190": "Clothing Stores",
    "448210": "Shoe Stores",
    "448320": "Jewelry, Luggage, and Leather Goods Stores",
    "451110": "Sporting Goods, Hobby, and Musical Instrument Stores",
    "451120": "Sporting Goods, Hobby, and Musical Instrument Stores",
    "451130": "Sporting Goods, Hobby, and Musical Instrument Stores",
    "451140": "Sporting Goods, Hobby, and Musical Instrument Stores",
    "451211": "Book Stores and News Dealers",
    "452210": "Department Stores",
    "452311": "General Merchandise Stores, including Warehouse Clubs and Supercenters",
    "453110": "Florists",
    "453210": "Office Supplies, Stationery, and Gift Stores",
    "453220": "Office Supplies, Stationery, and Gift Stores",
    "453310": "Used Merchandise Stores",
    "453910": "Other Miscellaneous Store Retailers",
    "453920": "Other Miscellaneous Store Retailers",
    "453998": "Other Miscellaneous Store Retailers",
    "484210": "Specialized Freight Trucking",
    "485210": "Interurban and Rural Bus Transportation",
    "485310": "Taxi and Limousine Service",
    "485999": "Other Transit and Ground Passenger Transportation",
    "488119": "Support Activities for Air Transportation",
    "488190": "Support Activities for Air Transportation",
    "488410": "Support Activities for Road Transportation",
    "488510": "Freight Transportation Arrangement",
    "491110": "Postal Service",
    "492110": "Couriers and Express Delivery Services",
    "512131": "Motion Picture and Video Industries",
    "515210": "Cable and Other Subscription Programming",
    "518210": "Data Processing, Hosting, and Related Services",
    "519120": "Other Information Services",
    "522130": "Depository Credit Intermediation",
    "522298": "Nondepository Credit Intermediation",
    "522390": "Activities Related to Credit Intermediation",
    "523999": "Other Financial Investment Activities",
    "524210": "Agencies, Brokerages, and Other Insurance Related Activities",
    "531110": "Lessors of Real Estate",
    "531130": "Lessors of Real Estate",
    "531190": "Lessors of Real Estate",
    "531311": "Activities Related to Real Estate",
    "532111": "Automotive Equipment Rental and Leasing",
    "532120": "Automotive Equipment Rental and Leasing",
    "532282": "Consumer Goods Rental",
    "532284": "Consumer Goods Rental",
    "532289": "Consumer Goods Rental",
    "532310": "General Rental Centers",
    "532412": "Commercial and Industrial Machinery and Equipment Rental and Leasing",
    "532490": "Commercial and Industrial Machinery and Equipment Rental and Leasing",
    "541120": "Legal Services",
    "541213": "Accounting, Tax Preparation, Bookkeeping, and Payroll Services",
    "541219": "Accounting, Tax Preparation, Bookkeeping, and Payroll Services",
    "541940": "Other Professional, Scientific, and Technical Services",
    "551114": "Management of Companies and Enterprises",
    "561320": "Employment Services",
    "561720": "Services to Buildings and Dwellings",
    "561730": "Services to Buildings and Dwellings",
    "561790": "Services to Buildings and Dwellings",
    "562211": "Waste Treatment and Disposal",
    "611110": "Elementary and Secondary Schools",
    "611210": "Junior Colleges",
    "611511": "Technical and Trade Schools",
    "611519": "Technical and Trade Schools",
    "611620": "Other Schools and Instruction",
    "611630": "Other Schools and Instruction",
    "611691": "Other Schools and Instruction",
    "611692": "Other Schools and Instruction",
    "611699": "Other Schools and Instruction",
    "621111": "Offices of Physicians",
    "621112": "Offices of Physicians",
    "621310": "Offices of Other Health Practitioners",
    "621320": "Offices of Other Health Practitioners",
    "621330": "Offices of Other Health Practitioners",
    "621340": "Offices of Other Health Practitioners",
    "621399": "Offices of Other Health Practitioners",
    "621420": "Outpatient Care Centers",
    "621492": "Outpatient Care Centers",
    "621493": "Outpatient Care Centers",
    "621498": "Outpatient Care Centers",
    "621610": "Home Health Care Services",
    "621991": "Other Ambulatory Health Care Services",
    "622110": "General Medical and Surgical Hospitals",
    "622210": "Psychiatric and Substance Abuse Hospitals",
    "622310": "Specialty (except Psychiatric and Substance Abuse) Hospitals",
    "623110": "Nursing Care Facilities (Skilled Nursing Facilities)",
    "623312": "Continuing Care Retirement Communities and Assisted Living Facilities for the Elderly",
    "624110": "Individual and Family Services",
    "624120": "Individual and Family Services",
    "624190": "Individual and Family Services",
    "624221": "Community Food and Housing, and Emergency and Other Relief Services",
    "624410": "Child Day Care Services",
    "711211": "Spectator Sports",
    "711310": "Promoters of Performing Arts, Sports, and Similar Events",
    "712110": "Museums, Historical Sites, and Similar Institutions",
    "712120": "Museums, Historical Sites, and Similar Institutions",
    "712130": "Museums, Historical Sites, and Similar Institutions",
    "712190": "Museums, Historical Sites, and Similar Institutions",
    "713110": "Amusement Parks and Arcades",
    "713210": "Gambling Industries",
    "713910": "Other Amusement and Recreation Industries",
    "713940": "Other Amusement and Recreation Industries",
    "713950": "Other Amusement and Recreation Industries",
    "713990": "Other Amusement and Recreation Industries",
    "721110": "Traveler Accommodation",
    "722320": "Special Food Services",
    "722410": "Drinking Places (Alcoholic Beverages)",
    "722511": "Restaurants and Other Eating Places",
    "722513": "Restaurants and Other Eating Places",
    "722515": "Restaurants and Other Eating Places",
    "811111": "Automotive Repair and Maintenance",
    "811121": "Automotive Repair and Maintenance",
    "811122": "Automotive Repair and Maintenance",
    "811191": "Automotive Repair and Maintenance",
    "811192": "Automotive Repair and Maintenance",
    "811198": "Automotive Repair and Maintenance",
    "811211": "Electronic and Precision Equipment Repair and Maintenance",
    "811412": "Personal and Household Goods Repair and Maintenance",
    "811420": "Personal and Household Goods Repair and Maintenance",
    "811430": "Personal and Household Goods Repair and Maintenance",
    "811490": "Personal and Household Goods Repair and Maintenance",
    "812112": "Personal Care Services",
    "812191": "Personal Care Services",
    "812199": "Personal Care Services",
    "812210": "Death Care Services",
    "812220": "Death Care Services",
    "812320": "Drycleaning and Laundry Services",
    "812930": "Other Personal Services",
    "812990": "Other Personal Services",
    "813110": "Religious Organizations",
    "813219": "Grantmaking and Giving Services",
    "813410": "Civic and Social Organizations",
    "922120": "Justice, Public Order, and Safety Activities",
    "922160": "Justice, Public Order, and Safety Activities",
    "926120": "Administration of Economic Programs"
}

NAICS_WHITELIST = {**NAICS_CALIBRATED, **NAICS_FALLBACK}

@app.route("/api/resolve_naics", methods=["POST"])
def api_resolve_naics():
    try:
        data = request.get_json(silent=True) or {}
        user_input = data.get("user_input", "").strip()

        if not user_input:
            return jsonify({"ok": False, "error": "No input provided."}), 400

        whitelist_text = "\n".join(
            f"{code}: {name}" for code, name in NAICS_WHITELIST.items()
        )

        response = client.chat.completions.create(
            model=DEPLOYMENT,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a NAICS code classifier. "
                        "Given a business description, return the single best matching NAICS code "
                        "from the provided whitelist. "
                        "Respond ONLY with a JSON object in this exact format, no extra text:\n"
                        '{"naics_code": "4441", "category_name": "Building Material and Supplies Dealers", "confidence": "high"}\n'
                        "If no match is reasonable, set confidence to 'low'."
                    )
                },
                {
                    "role": "user",
                    "content": (
                        f"Business description: {user_input}\n\n"
                        f"Available NAICS codes:\n{whitelist_text}"
                    )
                }
            ],
            temperature=0.1
        )

        raw = response.choices[0].message.content.strip()

        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        parsed = json.loads(raw)

        naics_code = str(parsed.get("naics_code", "")).strip()
        category_name = parsed.get("category_name", "")
        confidence = parsed.get("confidence", "low")

        if naics_code not in NAICS_WHITELIST:
            return jsonify({
                "ok": False,
                "error": f"There are no historical records for this business type in our data. The model cannot produce results. Please try a different description."
            }), 400

        is_fallback = naics_code not in NAICS_CALIBRATED

        if confidence == "low":
            return jsonify({
                "ok": True,
                "naics_code": naics_code,
                "category_name": category_name,
                "is_fallback": is_fallback,
                "warning": "Low confidence match. Please confirm this is the right category."
            })

        return jsonify({
            "ok": True,
            "naics_code": naics_code,
            "category_name": category_name,
            "is_fallback": is_fallback
        })

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/cbg_boundaries")
def api_cbg_boundaries():
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT geoid, geometry FROM cbg_geometries")
        rows = cursor.fetchall()
        conn.close()

        features = []
        for row in rows:
            geoid = row[0]
            geometry = json.loads(row[1])
            features.append({
                "type": "Feature",
                "properties": {"geoid": geoid},
                "geometry": geometry
            })

        return jsonify({
            "type": "FeatureCollection",
            "features": features
        })

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

# -------------------------
# Helper Functions
# -------------------------

def get_first_present(data, keys):
    """
    Returns the first value found in a dictionary from a list of possible keys.
    This lets the frontend send either:
      business_category / floor_area
    or:
      naics_code / floor_area_sqm
    """
    for key in keys:
        if key in data and data.get(key) is not None:
            return data.get(key)
    return None


def safe_competitor_sample(result, n=3):
    competitors = result.get("competitors", [])

    if not isinstance(competitors, list):
        return []

    return competitors[:n]


# -------------------------
# LLM Functions
# -------------------------

def generate_explanation(result):
    prompt = f"""
A Huff-style gravity model has been run with the following results:

Predicted visits: {result.get("predicted_visits")}
Market share: {result.get("market_share")}

Competitors (sample):
{safe_competitor_sample(result, 3)}

Explain what these results mean for a business owner considering this location.
"""

    response = client.chat.completions.create(
        model=DEPLOYMENT,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a location decision support assistant. "
                    "Explain results in plain language that a business owner would understand. "
                    "Do not use markdown formatting like bold or bullet points. "
                    "Keep the response to 3-5 sentences. "
                    "Always mention that the model does not include rent, zoning, or parking. "
                    "Never claim a location is guaranteed to succeed."
                )
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        temperature=0.4
    )

    return response.choices[0].message.content


def answer_question(question, result):
    prompt = f"""
You are assisting with a retail location analysis using a Huff model.

Model result:
{result}

User question:
{question}

Answer clearly and concisely, grounded in the model output.

Important rules:
- Do not invent data.
- Do not claim that you reran the Huff model.
- If the user asks to rerun the model with new inputs, explain that the app can rerun the model when the message includes all required inputs: NAICS code, floor area, latitude, and longitude.
"""

    response = client.chat.completions.create(
        model=DEPLOYMENT,
        messages=[
            {
                "role": "system",
                "content":(
                    "You are a location decision support assistant for a retail site analysis tool in Worcester, MA. "
                    "Only answer questions related to location analysis, the Huff model results, competitors, market share, or business site selection. "
                    "If the user asks about anything unrelated, politely decline and redirect them back to location decision support. "
                    "Use plain, practical language that a business owner would understand. "
                    "Avoid academic jargon. "
                    "Keep responses to 3-5 sentences. "
                    "Always mention what the model does not include, such as rent, zoning, or parking, when relevant. "
                    "Never claim a location is guaranteed to succeed."
                )
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        temperature=0.5
    )

    return response.choices[0].message.content


# -------------------------
# Run locally
# -------------------------

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
