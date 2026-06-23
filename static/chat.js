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
    addBotMessage(
      `Great, I captured the candidate location: ${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}. ` +
      "Now enter the proposed store floor area in square meters."
    );
    state.step = "floor_area";
    setStep(3);
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

      const nlRerun = await tryNaturalLanguageRerun(text);
      if (nlRerun) return;

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

async function tryNaturalLanguageRerun(text) {
  if (!state.last_business_category || !state.candidate_lat || !state.candidate_lon || !state.last_floor_area) {
    return false;
  }

  const changeKeywords = /\b(try|switch|change|use|what about|how about|instead)\b/i;
  if (!changeKeywords.test(text)) {
    return false;
  }

  let naicsResponse;
  try {
    naicsResponse = await fetch("/api/resolve_naics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_input: text.trim() })
    });
  } catch (e) {
    return false;
  }

  const data = await naicsResponse.json();
  if (!data.ok) return false;
  state.business_category = data.naics_code;
  state.floor_area = state.last_floor_area;
  state.last_category_name = data.category_name;
  state.user_input_category = text.trim();
  const fallbackNote = data.is_fallback
    ? " Note: default parameters will be used for this category."
    : "";

  showStaleBanner();
  addBotMessage(
    `Got it — switching to ${data.category_name} (NAICS ${data.naics_code}) at the same location and floor area.${fallbackNote}`
  );

  await runModel();
  return true;
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
  updateScenarioChart();
  updateComparisonTable();

  const predictedVisits = result.predicted_visits ?? "N/A";
  const marketShare = Number(result.market_share);
  const runtime = result.runtime_ms ?? "N/A";
  const notes = result.notes ?? "";

  summary.innerHTML = `
    <strong>Predicted Visits:</strong> ${escapeHtml(predictedVisits)}<br>
    <strong>Estimated Market Share:</strong> ${Number.isFinite(marketShare) ? (marketShare * 100).toFixed(2) + "%" : "N/A"}<br>
    <strong>Runtime:</strong> ${escapeHtml(runtime)} ms<br>
    <strong>Notes:</strong> ${escapeHtml(notes)}
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

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Distance</th>
          <th>Size</th>
          <th>Attraction</th>
        </tr>
      </thead>
      <tbody>
        ${competitors.map(c => `
          <tr>
            <td>${escapeHtml(c.name ?? c.place_name ?? c.poi_name ?? "Unknown")}</td>
            <td>${escapeHtml(c.distance_miles ?? c.distance ?? "N/A")}</td>
            <td>${escapeHtml(c.size ?? c.floor_area ?? c.area ?? "N/A")}</td>
            <td>${escapeHtml(c.attraction ?? "N/A")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

let scenarioChart = null;

function updateScenarioChart() {
  const section = document.getElementById("chartSection");

  if (state.scenarioHistory.length < 1) return;

  section.style.display = "block";

  const labels = state.scenarioHistory.map(s => s.label);
  const visitsData = state.scenarioHistory.map(s => Number(s.predicted_visits).toFixed(2));
  const shareData = state.scenarioHistory.map(s => (Number(s.market_share) * 100).toFixed(3));

  const ctx = document.getElementById("scenarioChart").getContext("2d");

  if (scenarioChart) {
    scenarioChart.destroy();
  }

  scenarioChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Predicted Visits",
          data: visitsData,
          backgroundColor: "rgba(2, 128, 144, 0.7)",
          borderColor: "rgba(2, 128, 144, 1)",
          borderWidth: 1,
          yAxisID: "y"
        },
        {
          label: "Market Share (%)",
          data: shareData,
          backgroundColor: "rgba(124, 58, 237, 0.7)",
          borderColor: "rgba(124, 58, 237, 1)",
          borderWidth: 1,
          yAxisID: "y1"
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Predicted Visits" }
        },
        y1: {
          type: "linear",
          position: "right",
          title: { display: true, text: "Market Share (%)" },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}
function updateComparisonTable() {
  const section = document.getElementById("comparisonSection");
  const tableDiv = document.getElementById("comparisonTable");

  if (state.scenarioHistory.length < 2) return;

  section.style.display = "block";

  const headers = ["Metric", ...state.scenarioHistory.map(s => s.label), "Better"];

  const rows = [
    {
      metric: "Predicted Visits",
      values: state.scenarioHistory.map(s => Number(s.predicted_visits).toFixed(2)),
      higher_is_better: true
    },
    {
      metric: "Market Share (%)",
      values: state.scenarioHistory.map(s => (Number(s.market_share) * 100).toFixed(3) + "%"),
      higher_is_better: true
    },
    {
      metric: "Nearby Competitors",
      values: state.scenarioHistory.map(s => s.competitor_count ?? "N/A"),
      higher_is_better: false
    }
  ];

  const headerRow = headers.map(h => `<th style="white-space:pre-line;">${escapeHtml(String(h))}</th>`).join("");

  const bodyRows = rows.map(row => {
    const numericValues = row.values.map(v => parseFloat(v));
    const best = row.higher_is_better
      ? Math.max(...numericValues)
      : Math.min(...numericValues);

    const bestIndex = numericValues.indexOf(best);
    const betterLabel = state.scenarioHistory[bestIndex]
      ? "Scenario " + (bestIndex + 1)
      : "N/A";

    const cells = row.values.map((v, i) => {
      const isBest = numericValues[i] === best;
      return `<td style="${isBest ? "font-weight:600;color:#047857;" : ""}">${escapeHtml(String(v))}</td>`;
    });

    return `<tr>
      <td>${escapeHtml(row.metric)}</td>
      ${cells.join("")}
      <td style="font-weight:600;">${escapeHtml(betterLabel)}</td>
    </tr>`;
  }).join("");

  tableDiv.innerHTML = `
    <table>
      <thead><tr>${headerRow}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <p style="font-size:12px;color:#6b7280;margin-top:8px;">
      Note: This comparison is based on the Huff model only. It does not include rent, zoning, or parking.
    </p>
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
