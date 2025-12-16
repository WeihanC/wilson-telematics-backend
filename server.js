// server.js
// Wilson Telematics Backend - proxy for Damoov APIs + Pricing Summary + Alert events

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const { calculateTripCost, PRICING_CONFIG } = require("./pricingEngine");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Root
app.get("/", (req, res) => {
  res.json({ message: "Wilson Telematics Backend is running" });
});

// -----------------------------
// Helpers
// -----------------------------
function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function getBearerToken(req) {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

function requireAuth(req, res) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing Authorization Bearer token" });
    return null;
  }
  return token;
}

function pickTripArray(payload) {
  // Damoov payloads vary; try common shapes
  return (
    payload?.Result?.Trips ||
    payload?.Result?.TripList ||
    payload?.Trips ||
    payload?.tripList ||
    []
  );
}

function normalizeTrip(t) {
  // best-effort mapping from Damoov trip summary objects
  const id = t?.Id || t?.TripId || t?.id || t?.tripId || "";
  const startDate = t?.StartDate || t?.StartTime || t?.startDate || t?.start_time || "";
  const endDate = t?.EndDate || t?.EndTime || t?.endDate || t?.end_time || "";

  const distanceKm =
    safeNum(t?.DistanceKm) ||
    safeNum(t?.Distance) ||
    safeNum(t?.distanceKm) ||
    safeNum(t?.distance_km) ||
    0;

  const durationSeconds =
    safeNum(t?.DurationSeconds) ||
    safeNum(t?.Duration) ||
    safeNum(t?.durationSeconds) ||
    safeNum(t?.duration_sec) ||
    0;

  const averageSpeedKmh =
    safeNum(t?.AverageSpeedKmh) ||
    safeNum(t?.AvgSpeedKmh) ||
    safeNum(t?.averageSpeedKmh) ||
    0;

  const maxSpeedKmh =
    safeNum(t?.MaxSpeedKmh) ||
    safeNum(t?.maxSpeedKmh) ||
    0;

  // Event counts (may not exist in your trip list response; leave 0 if missing)
  const harshBrakingCount =
    safeNum(t?.HarshBrakingCount) ||
    safeNum(t?.harshBrakingCount) ||
    safeNum(t?.brakingCount) ||
    0;

  const harshAccelerationCount =
    safeNum(t?.HarshAccelerationCount) ||
    safeNum(t?.harshAccelerationCount) ||
    safeNum(t?.accelerationCount) ||
    0;

  const harshCorneringCount =
    safeNum(t?.HarshCorneringCount) ||
    safeNum(t?.harshCorneringCount) ||
    safeNum(t?.corneringCount) ||
    0;

  const speedingEvents =
    safeNum(t?.SpeedingEvents) ||
    safeNum(t?.speedingEvents) ||
    safeNum(t?.speeding_events) ||
    0;

  const phoneUsageSeconds =
    safeNum(t?.PhoneUsageSeconds) ||
    safeNum(t?.phoneUsageSeconds) ||
    safeNum(t?.phone_usage_seconds) ||
    0;

  const nightDrivingRatio =
    safeNum(t?.NightDrivingRatio) ||
    safeNum(t?.nightDrivingRatio) ||
    safeNum(t?.night_driving_ratio) ||
    0;

  const rushHourDrivingRatio =
    safeNum(t?.RushHourDrivingRatio) ||
    safeNum(t?.rushHourDrivingRatio) ||
    safeNum(t?.rush_hour_driving_ratio) ||
    0;

  return {
    id,
    startDate,
    endDate,
    distanceKm,
    durationSeconds,
    averageSpeedKmh,
    maxSpeedKmh,
    harshBrakingCount,
    harshAccelerationCount,
    harshCorneringCount,
    speedingEvents,
    phoneUsageSeconds,
    nightDrivingRatio,
    rushHourDrivingRatio
  };
}

function toPricingEngineInput(normalizedTrip) {
  // Your pricingEngine.js expects keys like:
  // distanceKm, durationSeconds, brakingCount, accelerationCount, corneringCount, phoneUsageRatio, nightDrivingRatio, speedingEvents
  // If your pricingEngine differs, adjust here only (single source of truth).
  const durationSeconds = safeNum(normalizedTrip.durationSeconds);
  const phoneUsageSeconds = safeNum(normalizedTrip.phoneUsageSeconds);

  // phoneUsageRatio = phoneSeconds / durationSeconds, clamp 0..1
  const phoneUsageRatio =
    durationSeconds > 0 ? Math.max(0, Math.min(1, phoneUsageSeconds / durationSeconds)) : 0;

  return {
    distanceKm: safeNum(normalizedTrip.distanceKm),
    durationSeconds: durationSeconds,

    // align to your pricingEngine's expected keys
    brakingCount: safeNum(normalizedTrip.harshBrakingCount),
    accelerationCount: safeNum(normalizedTrip.harshAccelerationCount),
    corneringCount: safeNum(normalizedTrip.harshCorneringCount),

    speedingEvents: safeNum(normalizedTrip.speedingEvents),
    phoneUsageRatio: phoneUsageRatio,
    nightDrivingRatio: safeNum(normalizedTrip.nightDrivingRatio)
  };
}

// -----------------------------
// Damoov endpoints (set in .env)
// -----------------------------
const DAMOOV_TRIPS_URL = process.env.DAMOOV_TRIPS_URL;
const DAMOOV_TRIP_WAYPOINTS_URL = process.env.DAMOOV_TRIP_WAYPOINTS_URL;
const DAMOOV_DAILY_STATS_URL = process.env.DAMOOV_DAILY_STATS_URL;

// -----------------------------
// GET /api/trips
// -----------------------------
app.get("/api/trips", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;

  if (!DAMOOV_TRIPS_URL) {
    return res.status(500).json({ error: "Missing DAMOOV_TRIPS_URL in env" });
  }

  try {
    // last 30 days
    const now = new Date();
    const dateTo = now.toISOString();
    const dateFrom = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

    const response = await axios.get(DAMOOV_TRIPS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      params: { DateFrom: dateFrom, DateTo: dateTo }
    });

    const raw = response.data;
    const tripsRaw = pickTripArray(raw);

    const normalizedTrips = Array.isArray(tripsRaw) ? tripsRaw.map(normalizeTrip) : [];

    // sort by startDate desc (best effort)
    normalizedTrips.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));

    // attach pricing computed by your pricingEngine.js
    const tripsWithPricing = normalizedTrips.map((t) => {
      const input = toPricingEngineInput(t);
      const pricing = calculateTripCost(input, PRICING_CONFIG);
      return {
        ...t,
        pricing
      };
    });

    res.json({
      source: "damoov_trips_v1",
      dateFrom,
      dateTo,
      count: tripsWithPricing.length,
      trips: tripsWithPricing
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "Failed to fetch trips from Damoov",
      detail: err?.response?.data || String(err)
    });
  }
});

// -----------------------------
// GET /api/pricing/summary?limit=30
// -----------------------------
app.get("/api/pricing/summary", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;

  const limit = Math.min(Math.max(parseInt(req.query.limit || "30", 10), 1), 100);

  if (!DAMOOV_TRIPS_URL) {
    return res.status(500).json({ error: "Missing DAMOOV_TRIPS_URL in env" });
  }

  try {
    const now = new Date();
    const dateTo = now.toISOString();
    const dateFrom = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

    const response = await axios.get(DAMOOV_TRIPS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      params: { DateFrom: dateFrom, DateTo: dateTo }
    });

    const raw = response.data;
    const tripsRaw = pickTripArray(raw);

    const normalizedTrips = Array.isArray(tripsRaw) ? tripsRaw.map(normalizeTrip) : [];

    // sort desc then slice
    normalizedTrips.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
    const sliced = normalizedTrips.slice(0, limit);

    // compute per-trip pricing & score
    const pricedTrips = sliced.map((t) => {
      const input = toPricingEngineInput(t);
      const pricing = calculateTripCost(input, PRICING_CONFIG);

      // Try to standardize fields from pricingEngine output
      // Your pricingEngine currently returns { basePrice, finalPrice, riskScore, ... } (based on the file you uploaded)
      const premium = safeNum(pricing?.finalPrice ?? pricing?.premium ?? pricing?.price, 0);
      const score = safeNum(pricing?.riskScore ?? pricing?.score ?? 0, 0);

      return {
        id: t.id,
        startDate: t.startDate,
        endDate: t.endDate,
        distanceKm: t.distanceKm,
        durationSeconds: t.durationSeconds,
        premium: +premium.toFixed(2),
        score: +score.toFixed(1)
      };
    });

    const tripCount = pricedTrips.length;
    const totalPremium = pricedTrips.reduce((s, x) => s + safeNum(x.premium), 0);
    const avgPremium = tripCount ? totalPremium / tripCount : 0;
    const avgScore = tripCount ? pricedTrips.reduce((s, x) => s + safeNum(x.score), 0) / tripCount : 0;
    const totalDistanceKm = pricedTrips.reduce((s, x) => s + safeNum(x.distanceKm), 0);

    res.json({
      source: "pricing_summary_v1",
      currency: "USD",
      limit,
      tripCount,
      totalPremium: +totalPremium.toFixed(2),
      avgPremium: +avgPremium.toFixed(2),
      avgScore: +avgScore.toFixed(1),
      totalDistanceKm: +totalDistanceKm.toFixed(3),
      trips: pricedTrips
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "Failed to compute pricing summary",
      detail: err?.response?.data || String(err)
    });
  }
});

// -----------------------------
// GET /api/trips/:tripId/waypoints
// -----------------------------
app.get("/api/trips/:tripId/waypoints", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;

  if (!DAMOOV_TRIP_WAYPOINTS_URL) {
    return res.status(500).json({ error: "Missing DAMOOV_TRIP_WAYPOINTS_URL in env" });
  }

  const tripId = req.params.tripId;

  try {
    const url = DAMOOV_TRIP_WAYPOINTS_URL.replace(":tripId", encodeURIComponent(tripId));

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    res.json(response.data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "Failed to fetch trip waypoints",
      detail: err?.response?.data || String(err)
    });
  }
});

// -----------------------------
// GET /api/daily-stats
// -----------------------------
app.get("/api/daily-stats", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;

  if (!DAMOOV_DAILY_STATS_URL) {
    return res.status(500).json({ error: "Missing DAMOOV_DAILY_STATS_URL in env" });
  }

  try {
    const now = new Date();
    const endDate = now.toISOString().slice(0, 10);
    const startDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    const response = await axios.get(DAMOOV_DAILY_STATS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      params: { StartDate: startDate, EndDate: endDate }
    });

    res.json(response.data);
  } catch (err) {
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "Failed to fetch daily stats",
      detail: err?.response?.data || String(err)
    });
  }
});

// -----------------------------
// POST /api/alert-events
// -----------------------------
app.post("/api/alert-events", (req, res) => {
  const body = req.body || {};
  console.log("📡 [AlertEvent]", body);
  res.json({ ok: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Wilson Telematics Backend is running on port ${PORT}`);
});
