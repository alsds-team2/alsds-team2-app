# Sitewise — AI-Assisted Location Decision Support System

**LARA (Location Analysis & Recommendation Agent)** is an AI-powered web application that helps retail businesses find optimal store locations in Worcester, MA using the Huff Gravity Model.

🔗 **Live App:** [https://alsds-team2-app-a6e4apfabwcbakaq.eastus-01.azurewebsites.net](https://alsds-team2-app-a6e4apfabwcbakaq.eastus-01.azurewebsites.net)

---

## Members

Kuan-Yu Chen, Tung-Tsan Wu, Salem Dejenu 


**Sponsor:** [Intelmatix](https://intelmatix.ai)
**University:** Northeastern University

---

## What LARA Does

LARA guides users through a four-step location analysis workflow:

1. **Choose a business type** — LARA matches natural language input to a calibrated NAICS category
2. **Pick a location** — Click anywhere on the Worcester map or type coordinates
3. **Set store size** — Enter the proposed floor area in square meters
4. **Get results** — View predicted visits, market share, and nearby competitors, then ask LARA follow-up questions in plain language

---

## Key Features

- **Huff Gravity Model** — Calibrated alpha/beta parameters for 23 NAICS retail categories across 149 Census Block Groups and 4,069 Points of Interest in Worcester, MA
- **AI Chat (LARA)** — Powered by Azure OpenAI GPT-4o; answers follow-up questions grounded in model results
- **Scenario Comparison** — Compare multiple locations side by side (same business type and floor area)
- **Competitor Analysis** — Shows nearby competitors with real store names, distance, size, and attraction scores
- **Download Report** — Export a full HTML report with KPIs, competitor table, and location comparison
- **Landing Page** — Dark-themed landing page inspired by Intelmatix's design aesthetic

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML, CSS, JavaScript, Leaflet.js |
| Backend | Python, Flask |
| Database | Azure SQL (pyodbc) |
| AI | Azure OpenAI GPT-4o |
| Deployment | Azure App Service |
| Version Control | GitHub |

---

## Project Structure

```
alsds-team2-app/
├── app.py                  # Flask routes and API endpoints
├── huff_engine.py          # Huff Gravity Model V3 implementation
├── db.py                   # Database connection helper
├── migrate_to_azure_sql.py # SQLite → Azure SQL migration script
├── static/
│   ├── chat.js             # LARA chat logic and step flow
│   ├── map.js              # Leaflet map integration
│   └── styles.css          # App styling
├── templates/
│   ├── index.html          # Main app UI
│   └── landing.html        # Landing page
└── Data/
    └── urban_ai_v2.db      # Local SQLite database
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page |
| `/app` | GET | Main LARA application |
| `/health` | GET | Health check — returns `{"status":"ok"}` |
| `/dbcheck` | GET | Verifies Azure SQL connection |
| `/api/run_huff` | POST | Runs the Huff Gravity Model |
| `/api/ask` | POST | LARA follow-up question answering |
| `/api/resolve_naics` | POST | Resolves natural language to NAICS category |
| `/api/cbg_boundaries` | GET | Returns Worcester CBG GeoJSON |

---

## Deployment

The app is deployed on **Azure App Service** with automatic deployment from the `main` branch via GitHub Actions.

**Branch workflow:**
```
feature branch → PR → merge to main → Azure auto-deploys
```

**Environment variables required:**
- `SQL_CONNECTION_STRING` — Azure SQL connection string
- `AZURE_OPENAI_ENDPOINT` — Azure OpenAI endpoint
- `AZURE_OPENAI_KEY` — Azure OpenAI API key

---

## Data

| Dataset | Rows | Description |
|---------|------|-------------|
| Census Block Groups | 149 | Worcester, MA CBG demographics and coordinates |
| Points of Interest | 4,069 | Retail POIs with NAICS codes and floor areas |
| CBG–POI Visits | 26,924 | Historical visit counts per CBG–POI pair |
| CBG–POI Distances | 606,281 | Pre-computed UTM distances |
| Calibrated Parameters | 23 | Alpha/beta values per NAICS category |
