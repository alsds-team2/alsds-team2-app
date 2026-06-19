const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

const state = {
  step: "category",
  business_category: null,
  candidate_lat: null,
  candidate_lon: null,
  floor_area: null,
  last_result: null,
  last_business_category: null,
  last_floor_area: null,
  last_category_name: null,
  user_input_category: null,
  scenario_count: 0,
  scenarioHistory: []
};

setStep(1);

addBotMessage(
  "Welcome. I'm Lara, your personal agent. I will guide you through a store-location scenario for Worcester, MA. " +
  "First, what type of business are you planning to open? For example: hardware store, grocery store, or pharmacy."
);

sendBtn.addEventListener("click", handleSend);

chatInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    handleSend();
  }
});

window.onMapLocationSelected = function (location) {
  state.candidate_lat = location.lat;
  state.candidate_lon = location.lon;

  if (state.step === "location") {
    const confirmMsg = document.createElement("div");
    confirmMsg.className = "message bot";
    confirmMsg.innerHTML = `
      Location selected: (${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}).
      Use this location?
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button onclick="window.confirmLocation()" style="font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid #0d9488;background:#0d9488;color:#fff;cursor:pointer;">Yes, use this</button>
        <button onclick="window.cancelLocation()" style="font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid #d1d5db;background:#fff;color:#374151;cursor:pointer;">Cancel</button>
      </div>
    `;
    chatMessages.appendChild(confirmMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    window.confirmLocation = function () {
      confirmMsg.remove();
      addBotMessage(
        `Great. Now enter the proposed store floor area in square meters.`
      );
      state.step = "floor_area";
      setStep(3);
    };

    window.cancelLocation = function () {
      confirmMsg.remove();
      addBotMessage("Cancelled. Click the map again to choose a location.");
    };
  } else if (state.step === "ready" && state.last_business_category && state.last_floor_area) {
    state.candidate_lat = location.lat;
    state.candidate_lon = location.lon;

    const confirmMsg = document.createElement("div");
    confirmMsg.className = "message bot";
    confirmMsg.innerHTML = `
      New location selected: (${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}).
      Run the model here?
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button onclick="window.confirmRerun()" style="font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid #0d9488;background:#0d9488;color:#fff;cursor:pointer;">Yes, run</button>
        <button onclick="window.cancelRerun()" style="font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid #d1d5db;background:#fff;color:#374151;cursor:pointer;">Cancel</button>
      </div>
    `;
    chatMessages.appendChild(confirmMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    window.confirmRerun = function () {
      confirmMsg.remove();
      state.business_category = state.last_business_category;
      state.floor_area = state.last_floor_area;
      showStaleBanner();
      addBotMessage(
        `Running again at (${state.candidate_lat.toFixed(6)}, ${state.candidate_lon.toFixed(6)}) with the same business type and floor area.`
      );
      runModel();
    };

    window.cancelRerun = function () {
      confirmMsg.remove();
      addBotMessage("Cancelled. Click the map again to choose a new location.");
    };
  }
};

async function handleSend() {
  const text = chatInput.value.trim();
  if (!text) return;

  addUserMessage(text);
  chatInput.value = "";

  try {
    /*
      IMPORTANT:
      Before treating the message as a normal follow-up question,
      check whether the user is asking to rerun the model with a new full set of inputs.

      Example supported message:
      "use 42.229212, -71.805525 and rerun the model for NAICS code 4441 and area of 1000 square meters"
    */
    const rerunInputs = extractRerunInputs(text);

    if (rerunInputs) {
      await rerunModelFromMessage(rerunInputs);
      return;
    }

    if (state.step === "category") {
      const response = await fetch("/api/resolve_naics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_input: text.trim() })
      });

      const data = await response.json();

      if (!data.ok) {
        addBotMessage(data.error || "I could not recognize that business type. Please try again.");
        return;
      }

      state.business_category = data.naics_code;
      state.last_category_name = data.category_name;
      state.user_input_category = text.trim();

      if (data.warning) {
        addBotMessage(
          `I matched your input to: ${data.category_name} (NAICS ${data.naics_code}). ` +
          `I'm not fully confident in this match — please confirm this is correct before continuing.`
        );
      } else if (data.is_fallback) {
        addBotMessage(
          `Got it — ${data.category_name} (NAICS ${data.naics_code}). ` +
          "Note: this category does not have calibrated parameters, so the model will use default values. Results may be less accurate. " +
          "Now click the proposed store location on the map, or type coordinates as: 42.24, -71.78"
        );
      } else {
        addBotMessage(
          `Got it — ${data.category_name} (NAICS ${data.naics_code}). ` +
          "Now click the proposed store location on the map, or type coordinates as: 42.24, -71.78"
        );
      }

      state.step = "location";
      setStep(2);
      return;
    }

    if (state.step === "location") {
      const coords = parseCoordinates(text);

      if (!coords) {
        addBotMessage("Please click the map or type coordinates in this format: 42.24, -71.78");
        return;
      }

      state.candidate_lat = coords.lat;
      state.candidate_lon = coords.lon;

      if (window.setCandidateLocation) {
        window.setCandidateLocation(coords.lat, coords.lon, false);
      }

      state.step = "floor_area";
      setStep(3);
      addBotMessage("Great. Now enter the proposed store floor area in square meters.");
      return;
    }

    if (state.step === "floor_area") {
      const area = Number(text.replace(/,/g, ""));

      if (!Number.isFinite(area) || area <= 0) {
        addBotMessage("Please enter a positive numeric floor area, such as 1000.");
        return;
      }

      state.floor_area = area;
      state.step = "ready";
      /*set 4 step tell user the progress*/
      setStep(4);

      addBotMessage(
        `Thanks. I will run the Huff model for NAICS ${state.business_category}, ` +
        `location (${state.candidate_lat.toFixed(6)}, ${state.candidate_lon.toFixed(6)}), ` +
        `and floor area ${state.floor_area} square meters.`
      );

      await runModel();
      return;
    }

    if (state.step === "ready") {
      const coords = parseCoordinates(text);

      if (coords && state.last_business_category && state.last_floor_area) {
        state.business_category = state.last_business_category;
        state.floor_area = state.last_floor_area;
        state.candidate_lat = coords.lat;
        state.candidate_lon = coords.lon;

        if (window.setCandidateLocation) {
          window.setCandidateLocation(coords.lat, coords.lon, false);
        }

        showStaleBanner();
        addBotMessage(
          `Running again with the same business type and floor area at the new location (${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)}).`
        );

        await runModel();
        return;
      }

      // First try to resolve as a business type
      let naicsResponse;
      try {
        naicsResponse = await fetch("/api/resolve_naics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_input: text.trim() })
        });
        const naicsData = await naicsResponse.json();
        if (naicsData.ok) {
          state.business_category = naicsData.naics_code;
          state.floor_area = state.last_floor_area;
          state.last_category_name = naicsData.category_name;
          state.user_input_category = text.trim();

          const fallbackNote = naicsData.is_fallback
            ? " Note: default parameters will be used for this category."
            : "";

          showStaleBanner();
          addBotMessage(
            `Got it — switching to ${naicsData.category_name} (NAICS ${naicsData.naics_code}) at the same location and floor area.${fallbackNote}`
          );
          await runModel();
          return;
        }
      } catch (e) {
        // not a business type, fall through to askQuestion
      }

      await askQuestion(text);
      return;
    }
  } catch (error) {
    addErrorMessage(error.message || String(error));
  }
}

async function rerunModelFromMessage(inputs) {
  state.business_category = inputs.business_category;
  state.candidate_lat = inputs.candidate_lat;
  state.candidate_lon = inputs.candidate_lon;
  state.floor_area = inputs.floor_area;
  state.step = "ready";
  setStep(4);

  addBotMessage(
    `I found a new complete model input set. I will rerun the Huff model for NAICS ${state.business_category}, ` +
    `location (${state.candidate_lat.toFixed(6)}, ${state.candidate_lon.toFixed(6)}), ` +
    `and floor area ${state.floor_area} square meters.`
  );

  if (window.setCandidateLocation) {
    window.setCandidateLocation(state.candidate_lat, state.candidate_lon, false);
  }

  await runModel();
}

async function runModel() {
  addBotMessage("Running the model now...");

  const response = await fetch("/api/run_huff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      candidate_lat: state.candidate_lat,
      candidate_lon: state.candidate_lon,
      business_category: state.business_category,
      floor_area: state.floor_area,

      // Optional aliases for clearer backend compatibility
      naics_code: state.business_category,
      floor_area_sqm: state.floor_area
    })
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Model failed.");
  }

  state.last_result = data.result;
  state.last_business_category = state.business_category;
  state.last_floor_area = state.floor_area;
  state.scenario_count += 1;

  state.scenarioHistory.push({
    label: `${state.user_input_category || state.last_category_name}\n${state.candidate_lat.toFixed(2)}, ${state.candidate_lon.toFixed(2)}`,
    predicted_visits: data.result.predicted_visits,
    market_share: data.result.market_share,
    competitor_count: Array.isArray(data.result.competitors) ? data.result.competitors.length : 0
  });

  hideStaleBanner();
  renderResult(data.result);

  if (window.plotCompetitors) {
    window.plotCompetitors(data.result.competitors);
  }

  addBotMessage(
    data.explanation ||
    "Model completed. You can now ask follow-up questions about the result, or provide a new NAICS code, area, and coordinates to rerun the model."
  );
}

async function askQuestion(question) {
  if (!state.last_result) {
    addBotMessage("Please complete a model run first.");
    return;
  }

  const response = await fetch("/api/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      question,
      result: state.last_result
    })
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "The assistant could not answer.");
  }

  addBotMessage(data.answer);
}

function extractRerunInputs(message) {
  const coords = parseCoordinates(message);

  if (!coords) {
    return null;
  }

  const naicsMatch =
    message.match(/naics(?:\s+code)?\s*(?:is|=|:|of|for)?\s*(\d{2,6})/i) ||
    message.match(/business\s+category\s*(?:is|=|:|of|for)?\s*(\d{2,6})/i) ||
    message.match(/category\s*(?:is|=|:|of|for)?\s*(\d{2,6})/i);

  const areaMatch =
    message.match(/area\s*(?:of|is|=|:)?\s*([\d,]+(?:\.\d+)?)/i) ||
    message.match(/floor\s+area\s*(?:of|is|=|:)?\s*([\d,]+(?:\.\d+)?)/i) ||
    message.match(/([\d,]+(?:\.\d+)?)\s*(?:square\s+meters|square\s+metres|sqm|sq\.?\s*m|m2|m²)/i);

  if (!naicsMatch || !areaMatch) {
    return null;
  }

  const businessCategory = naicsMatch[1];
  const floorArea = Number(areaMatch[1].replace(/,/g, ""));

  if (!businessCategory || !Number.isFinite(floorArea) || floorArea <= 0) {
    return null;
  }

  return {
    business_category: businessCategory,
    candidate_lat: coords.lat,
    candidate_lon: coords.lon,
    floor_area: floorArea
  };
}

function showStaleBanner() {
  const banner = document.getElementById("staleBanner");
  if (banner) banner.style.display = "block";
}

function hideStaleBanner() {
  const banner = document.getElementById("staleBanner");
  if (banner) banner.style.display = "none";
}


function renderResult(result) {
  const summary = document.getElementById("resultSummary");
  const tableWrap = document.getElementById("competitorTable");
  updateComparisonTable();
  const panel = document.getElementById("resultPanel");
  if (panel) panel.style.display = "block";
  const summary_bar = document.getElementById("analysisSummary");
  if (summary_bar) {
    summary_bar.style.display = "block";
    summary_bar.textContent = `Analyzing: ${state.user_input_category || state.last_category_name} · ${state.last_floor_area} m² · ${state.candidate_lat.toFixed(4)}, ${state.candidate_lon.toFixed(4)}`;
  }
  const predictedVisits = result.predicted_visits ?? "N/A";
  const marketShare = Number(result.market_share);
  const runtime = result.runtime_ms ?? "N/A";
  const notes = result.notes ?? "";

  summary.innerHTML = `
    <strong>Predicted Visits:</strong> ${escapeHtml(String(predictedVisits))} / yr<br>
    <strong>Estimated Market Share:</strong> ${Number.isFinite(marketShare) ? (marketShare * 100).toFixed(3) + "%" : "N/A"}
  `;

  /*add function to display metric cards*/
  if (typeof showMetricCards === "function") {
    showMetricCards(
      typeof predictedVisits === "number" ? predictedVisits.toFixed(1) : predictedVisits,
      Number.isFinite(marketShare) ? (marketShare * 100).toFixed(2) + "%" : "N/A",
      Array.isArray(result.competitors) ? result.competitors.length : "N/A"
    );
  }

  const competitors = Array.isArray(result.competitors) ? result.competitors : [];

  if (competitors.length === 0) {
    tableWrap.innerHTML = "No competitor records returned.";
    return;
  }

  let sortBy = "distance";

  function renderCompetitorTable(data, sort) {
    const sorted = [...data].sort((a, b) => {
      if (sort === "distance") return Number(a.distance_miles) - Number(b.distance_miles);
      return Number(b.attraction) - Number(a.attraction);
    });

    tableWrap.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <button onclick="window.sortCompetitors('distance')"
          style="font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid #d1d5db;cursor:pointer;background:${sort === 'distance' ? '#0d9488' : '#fff'};color:${sort === 'distance' ? '#fff' : '#374151'};">
          Nearest first
        </button>
        <button onclick="window.sortCompetitors('attraction')"
          style="font-size:12px;padding:4px 12px;border-radius:4px;border:1px solid #d1d5db;cursor:pointer;background:${sort === 'attraction' ? '#0d9488' : '#fff'};color:${sort === 'attraction' ? '#fff' : '#374151'};">
          Biggest threat first
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Store name</th>
            <th>Distance</th>
            <th>Size (m²)</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(c => `
            <tr>
              <td>${escapeHtml(c.name ?? "Unknown")}</td>
              <td>${c.distance_miles ? escapeHtml(String(c.distance_miles)) + " mi" : "N/A"}</td>
              <td>${escapeHtml(String(c.size ?? "N/A"))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  window.sortCompetitors = function (newSort) {
    sortBy = newSort;
    renderCompetitorTable(competitors, sortBy);
  };

  renderCompetitorTable(competitors, sortBy);
}

function updateComparisonTable() {
  const section = document.getElementById("comparisonSection");
  const tableDiv = document.getElementById("comparisonTable");

  if (state.scenarioHistory.length < 2) return;
  section.style.display = "block";

  const metrics = [
    { label: "Predicted visits / yr", key: "predicted_visits", format: v => Number(v).toFixed(2), higher_is_better: true },
    { label: "Market share", key: "market_share", format: v => (Number(v) * 100).toFixed(3) + "%", higher_is_better: true },
    { label: "Nearby competitors", key: "competitor_count", format: v => v + " stores", higher_is_better: false }
  ];

  const rows = metrics.map(m => {
    const values = state.scenarioHistory.map(s => Number(m.key === "market_share" ? s[m.key] * 100 : s[m.key]));
    const best = m.higher_is_better ? Math.max(...values) : Math.min(...values);
    const bestIndex = values.indexOf(best);
    const maxVal = Math.max(...values, 0.001);

    const bars = state.scenarioHistory.map((s, i) => {
      const raw = Number(m.key === "market_share" ? s[m.key] * 100 : s[m.key]);
      const pct = Math.min((raw / maxVal) * 100, 100).toFixed(0);
      const isBest = i === bestIndex;
      const color = isBest ? "#0d9488" : "#d1d5db";
      const label = m.format(m.key === "market_share" ? s[m.key] : s[m.key]);
      return `
        <td style="padding:8px 12px;vertical-align:middle;">
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="flex:1;height:8px;background:#f3f4f6;border-radius:4px;overflow:hidden;min-width:40px;">
              <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;"></div>
            </div>
            <span style="font-size:12px;${isBest ? "font-weight:500;color:#0d9488;" : "color:#6b7280;"};white-space:nowrap;">${escapeHtml(label)}</span>
          </div>
        </td>`;
    }).join("");

    const betterLabel = "Scenario " + (bestIndex + 1);

    return `<tr style="border-bottom:0.5px solid #f3f4f6;">
      <td style="padding:8px 12px;font-size:13px;color:#6b7280;white-space:nowrap;">${escapeHtml(m.label)}</td>
      ${bars}
      <td style="padding:8px 12px;font-size:12px;font-weight:500;color:#0d9488;white-space:nowrap;">${escapeHtml(betterLabel)}</td>
    </tr>`;
  }).join("");

  const scenarioHeaders = state.scenarioHistory.map((s, i) =>
    `<th style="padding:8px 12px;font-size:12px;font-weight:500;color:#6b7280;text-align:left;white-space:pre-line;">Scenario ${i + 1}\n${escapeHtml(s.label)}</th>`
  ).join("");

  tableDiv.innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1px solid #e5e7eb;">
          <th style="padding:8px 12px;font-size:12px;font-weight:500;color:#6b7280;text-align:left;">Metric</th>
          ${scenarioHeaders}
          <th style="padding:8px 12px;font-size:12px;font-weight:500;color:#6b7280;text-align:left;">Better</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="font-size:11px;color:#9ca3af;margin-top:8px;">This model does not include rent, zoning, or parking.</p>
  `;
}

function parseCoordinates(text) {
  /*
    Supports:
    42.229212, -71.805525
    use 42.229212, -71.805525 and rerun...
  */
  const match = text.match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);

  if (!match) {
    return null;
  }

  const lat = Number(match[1]);
  const lon = Number(match[2]);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  return { lat, lon };
}


function addBotMessage(text) {
  addMessage(text, "bot");
}

function addUserMessage(text) {
  addMessage(text, "user");
}

function addErrorMessage(text) {
  addMessage(text, "error");
}

function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = `message ${type}`;
  div.innerText = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function downloadReport() {
  if (!state.last_result) {
    addBotMessage("Please complete a model run first before downloading a report.");
    return;
  }

  const predictedVisits = state.last_result.predicted_visits ?? "N/A";
  const marketShare = Number(state.last_result.market_share);
  const competitors = Array.isArray(state.last_result.competitors) ? state.last_result.competitors : [];

  const competitorRows = competitors.map(c => `
    <tr>
      <td>${escapeHtml(c.name ?? "Unknown")}</td>
      <td>${c.distance_miles ? c.distance_miles + " mi" : "N/A"}</td>
      <td>${c.size ?? "N/A"} m²</td>
    </tr>
  `).join("");

  const comparisonSection = state.scenarioHistory.length >= 2 ? `
    <h2>Location Comparison</h2>
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          ${state.scenarioHistory.map((s, i) => `<th>Scenario ${i + 1}<br><small>${s.label.replace("\n", " · ")}</small></th>`).join("")}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Predicted visits / yr</td>
          ${state.scenarioHistory.map(s => `<td>${Number(s.predicted_visits).toFixed(2)}</td>`).join("")}
        </tr>
        <tr>
          <td>Market share</td>
          ${state.scenarioHistory.map(s => `<td>${(Number(s.market_share) * 100).toFixed(3)}%</td>`).join("")}
        </tr>
        <tr>
          <td>Nearby competitors</td>
          ${state.scenarioHistory.map(s => `<td>${s.competitor_count} stores</td>`).join("")}
        </tr>
      </tbody>
    </table>
  ` : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Sitewise Report</title>
  <style>
    body { font-family: Inter, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 24px; color: #111; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    h2 { font-size: 16px; margin-top: 32px; margin-bottom: 12px; color: #374151; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
    .meta { font-size: 13px; color: #6b7280; margin-bottom: 24px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    .kpi { background: #f9fafb; border-radius: 8px; padding: 16px; }
    .kpi-label { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
    .kpi-value { font-size: 24px; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 12px; font-weight: 500; color: #6b7280; border-bottom: 1px solid #e5e7eb; }
    td { padding: 8px 12px; border-bottom: 0.5px solid #f3f4f6; }
    .footer { font-size: 11px; color: #9ca3af; margin-top: 32px; }
  </style>
</head>
<body>
  <h1>Sitewise Location Report</h1>
  <div class="meta">
    Generated: ${new Date().toLocaleString()}<br>
    Analyzing: ${escapeHtml(state.user_input_category || state.last_category_name || "N/A")} &nbsp;·&nbsp;
    ${state.last_floor_area} m² &nbsp;·&nbsp;
    ${state.candidate_lat.toFixed(4)}, ${state.candidate_lon.toFixed(4)}
  </div>

  <h2>Model Results</h2>
  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Predicted visits</div>
      <div class="kpi-value">${typeof predictedVisits === "number" ? predictedVisits.toFixed(2) : predictedVisits} / yr</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Market share</div>
      <div class="kpi-value">${Number.isFinite(marketShare) ? (marketShare * 100).toFixed(3) + "%" : "N/A"}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Nearby competitors</div>
      <div class="kpi-value">${competitors.length} stores</div>
    </div>
  </div>

  <h2>Nearby Competitors (top 10)</h2>
  <table>
    <thead>
      <tr>
        <th>Store name</th>
        <th>Distance</th>
        <th>Size</th>
      </tr>
    </thead>
    <tbody>${competitorRows}</tbody>
  </table>

  ${comparisonSection}

  <div class="footer">
    This report was generated by Sitewise (LARA). Results are based on the Huff gravity model and do not include rent, zoning, or parking. No location is guaranteed to succeed.
  </div>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sitewise-report.html";
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
