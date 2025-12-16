// server.js
// Wilson Telematics Backend - proxy for Damoov APIs + Pricing Summary

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const { computeTripPremium, computePricingSummary } = require("./pricingEngine");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Root endpoint
app.get("/", (req, res) => {
  res.json({ message: "Wilson Telematics Backend is running" });
});

// -----------------------------
// Helpers
// -----------------------------
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

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// -----------------------------
// Damoov endpoints config
// You must set these in .env
// -----------------------------
const DAMOOV_TRIPS_URL = process.env.DAMOOV_TRIPS_URL; // e.g. https://...
const DAMOOV_TRIP_WAYPOINTS_URL = process.env.DAMOOV_TRIP_WAYPOINTS_URL; // e.g. https://.../:tripId...
const DAMOOV_DAILY_STATS_URL = process.env.DAMOOV_DAILY_STATS_URL; // e.g. https://...

// Optional: pricing parameters (can tune later)
const PRICING_CONFIG = {
  basePerKm: safeNum(process.env.PRICING_BASE_PER_KM, 0.08),
  baseFixed: safeNum(process.env.PRICING_BASE_FIXED, 0.35)
};

// -----------------------------
// GET /api/trips
// Returns normalized trips list (last 30 days), each trip includes pricing
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

    // Try to locate trips array from common Damoov shapes
    const raw = response.data;
    const tripsRaw =
      raw?.Result?.Trips ||
      raw?.Result?.TripList ||
      raw?.Trips ||
      raw?.tripList ||
      [];

    const trips = Array.isArray(tripsRaw)
      ? tripsRaw.map((t) => {
          // normalize fields (best effort; adjust mapping if your Damoov payload differs)
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

          // event counts (if present)
          const harshBrakingCount =
            safeNum(t?.HarshBrakingCount) ||
            safeNum(t?.brakingCount) ||
            safeNum(t?.harshBrakingCount) ||
            0;
          const harshAccelerationCount =
            safeNum(t?.HarshAccelerationCount) ||
            safeNum(t?.accelerationCount) ||
            safeNum(t?.harshAccelerationCount) ||
            0;
          const harshCorneringCount =
            safeNum(t?.HarshCorneringCount) ||
            safeNum(t?.corneringCount) ||
            safeNum(t?.harshCorneringCount) ||
            0;

          const phoneUsageSeconds =
            safeNum(t?.PhoneUsageSeconds) ||
            safeNum(t?.phoneUsageSeconds) ||
            safeNum(t?.phone_usage_seconds) ||
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

          const normalized = {
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
            phoneUsageSeconds
          };

          const pricing = computeTripPremium(normalized, PRICING_CONFIG);

          return {
            ...normalized,
            pricing
          };
        })
      : [];

    res.json({
      source: "damoov_trips_v1",
      dateFrom,
      dateTo,
      count: trips.length,
      trips
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
// Uses /api/trips data shape and returns summary for last N trips
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
    const tripsRaw =
      raw?.Result?.Trips ||
      raw?.Result?.TripList ||
      raw?.Trips ||
      raw?.tripList ||
      [];

    const normalizedTrips = Array.isArray(tripsRaw)
      ? tripsRaw.map((t) => {
          const id = t?.Id || t?.TripId || t?.id || t?.tripId || "";
          const startDate = t?.StartDate || t?.StartTime || t?.startDate || t?.start_time || "";
          const endDate = t?.EndDate || t?.EndTime || t?.endDate || t?.end_time || "";
          const distanceKm =
            safeNum(t?.DistanceKm) || safeNum(t?.Distance) || safeNum(t?.distanceKm) || 0;
          const durationSeconds =
            safeNum(t?.DurationSeconds) || safeNum(t?.Duration) || safeNum(t?.durationSeconds) || 0;

          const harshBrakingCount = safeNum(t?.HarshBrakingCount) || safeNum(t?.harshBrakingCount) || 0;
          const harshAccelerationCount = safeNum(t?.HarshAccelerationCount) || safeNum(t?.harshAccelerationCount) || 0;
          const harshCorneringCount = safeNum(t?.HarshCorneringCount) || safeNum(t?.harshCorneringCount) || 0;
          const phoneUsageSeconds = safeNum(t?.PhoneUsageSeconds) || safeNum(t?.phoneUsageSeconds) || 0;

          const averageSpeedKmh = safeNum(t?.AverageSpeedKmh) || safeNum(t?.averageSpeedKmh) || 0;
          const maxSpeedKmh = safeNum(t?.MaxSpeedKmh) || safeNum(t?.maxSpeedKmh) || 0;

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
            phoneUsageSeconds
          };
        })
      : [];

    // sort by startDate desc (best-effort)
    normalizedTrips.sort((a, b) => (String(b.startDate)).localeCompare(String(a.startDate)));

    const summary = computePricingSummary(normalizedTrips, limit, PRICING_CONFIG);

    res.json({
      source: "pricing_summary_v1",
      dateFrom,
      dateTo,
      ...summary
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
// If you already had it, keep your original. This is a safe template.
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

    // You likely already parse/transform waypoints in your existing code;
    // keep your original logic if it works better.
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
// Keep your existing if already working. Here is a safe template.
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
// Frontend can log real-time alerts here
// -----------------------------
app.post("/api/alert-events", (req, res) => {
  // optional: requireAuth(req,res) if you want to enforce
  const body = req.body || {};
  console.log("📡 [AlertEvent]", body);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Wilson Telematics Backend is running on port ${PORT}`);
});
