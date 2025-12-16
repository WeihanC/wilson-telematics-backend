// server.js
// Wilson Telematics Backend - proxy for Damoov APIs + Pricing Summary + Alert events
// Compatible with your old working endpoints:
// - Trips: POST https://api.telematicssdk.com/trips/get/v1/
// - Waypoints: POST https://api.telematicssdk.com/trips/get/v1/:tripId/waypoints
// - Daily stats: GET https://api.telematicssdk.com/indicators/v2/Statistics/daily

process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ UNHANDLED REJECTION:", reason);
});

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

// -----------------------------
// Damoov endpoints (set in Railway env)
// -----------------------------
const DAMOOV_TRIPS_URL = process.env.DAMOOV_TRIPS_URL; // POST
const DAMOOV_TRIP_WAYPOINTS_URL = process.env.DAMOOV_TRIP_WAYPOINTS_URL; // POST, contains :tripId
const DAMOOV_DAILY_STATS_URL = process.env.DAMOOV_DAILY_STATS_URL; // GET

// -----------------------------
// Normalize trips (match your old mapping)
// -----------------------------
function mapTripFromTripsApi(t) {
  const stats = t?.Statistics || {};
  const data = t?.Data || {};

  const mileageKm = safeNum(stats.Mileage, 0);
  const durationMin = safeNum(stats.DurationMinutes, 0);
  const avgSpeed = safeNum(stats.AverageSpeed, 0);
  const maxSpeed = safeNum(stats.MaxSpeed, 0);

  const accelCount = safeNum(stats.AccelerationsCount, 0);
  const brakeCount = safeNum(stats.BrakingsCount, 0);
  const cornerCount = safeNum(stats.CorneringsCount, 0);

  const phoneMin = safeNum(stats.PhoneUsageDurationMinutes, 0);

  const dayMin = safeNum(stats.DayHours, 0);
  const rushMin = safeNum(stats.RushHours, 0);
  const nightMin = safeNum(stats.NightHours, 0);
  const totalTimeMin = dayMin + rushMin + nightMin;

  const nightRatio = totalTimeMin > 0 ? nightMin / totalTimeMin : 0;
  const rushRatio = totalTimeMin > 0 ? rushMin / totalTimeMin : 0;

  const mapped = {
    id: t?.Id || t?.TripId || t?.TrackToken || t?.IdTrip || t?.TripToken || "",

    startDate: data?.StartDate || data?.StartDateUtc || null,
    endDate: data?.EndDate || data?.EndDateUtc || null,

    distanceKm: mileageKm,
    durationSeconds: Math.round(durationMin * 60),

    averageSpeedKmh: avgSpeed,
    maxSpeedKmh: maxSpeed,

    harshBrakingCount: brakeCount,
    harshAccelerationCount: accelCount,
    harshCorneringCount: cornerCount,

    // Trips API 在你旧代码里没有“超速次数”，先占位 0
    speedingEvents: 0,

    phoneUsageSeconds: Math.round(phoneMin * 60),

    nightDrivingRatio: nightRatio,
    rushHourDrivingRatio: rushRatio
  };

  return mapped;
}

function toPricingEngineInput(mappedTrip) {
  const durationSeconds = safeNum(mappedTrip.durationSeconds);
  const phoneUsageSeconds = safeNum(mappedTrip.phoneUsageSeconds);

  const phoneUsageRatio =
    durationSeconds > 0 ? Math.max(0, Math.min(1, phoneUsageSeconds / durationSeconds)) : 0;

  return {
    distanceKm: safeNum(mappedTrip.distanceKm),
    durationSeconds: durationSeconds,

    brakingCount: safeNum(mappedTrip.harshBrakingCount),
    accelerationCount: safeNum(mappedTrip.harshAccelerationCount),
    corneringCount: safeNum(mappedTrip.harshCorneringCount),

    speedingEvents: safeNum(mappedTrip.speedingEvents),
    phoneUsageRatio: phoneUsageRatio,
    nightDrivingRatio: safeNum(mappedTrip.nightDrivingRatio)
  };
}

// -----------------------------
// POST /api/trips  (actually GET route but calls Damoov POST)
// -----------------------------
app.get("/api/trips", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;

  if (!DAMOOV_TRIPS_URL) {
    return res.status(500).json({ error: "Missing DAMOOV_TRIPS_URL in env" });
  }

  try {
    const now = new Date();
    const dateTo = now.toISOString();
    const dateFrom = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

    // Damoov trips/get/v1 expects POST + body (per your old working code)
    const body = {
      StartDate: dateFrom,
      EndDate: dateTo,
      IncludeDetails: true,
      IncludeStatistics: true,
      IncludeScores: true,
      Locale: "EN",
      UnitSystem: "Si",
      SortBy: "StartDateUtc_Desc",
      Paging: { Page: 1, Count: 50, IncludePagingInfo: true }
    };

    const damoovResp = await axios.post(DAMOOV_TRIPS_URL, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });

    const raw = damoovResp.data;
    const tripsRaw = raw?.Result?.Trips || [];

    if (!Array.isArray(tripsRaw) || tripsRaw.length === 0) {
      return res.json({ source: "damoov_trips_v1", trips: [], count: 0 });
    }

    const mapped = tripsRaw.map(mapTripFromTripsApi);

    // attach pricing
    const tripsWithPricing = mapped.map((t) => {
      const input = toPricingEngineInput(t);
      const pricing = calculateTripCost(input, PRICING_CONFIG);
      return { ...t, pricing };
    });

    res.json({
      source: "damoov_trips_v1",
      dateFrom,
      dateTo,
      count: tripsWithPricing.length,
      trips: tripsWithPricing
    });
  } catch (err) {
    console.error("❌ Error from Damoov (trips/get/v1):", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({
      error: "Failed to fetch trips from Damoov",
      detail: err?.response?.data || err.message
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

    const body = {
      StartDate: dateFrom,
      EndDate: dateTo,
      IncludeDetails: true,
      IncludeStatistics: true,
      IncludeScores: true,
      Locale: "EN",
      UnitSystem: "Si",
      SortBy: "StartDateUtc_Desc",
      Paging: { Page: 1, Count: 100, IncludePagingInfo: true }
    };

    const damoovResp = await axios.post(DAMOOV_TRIPS_URL, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });

    const raw = damoovResp.data;
    const tripsRaw = raw?.Result?.Trips || [];
    const mapped = Array.isArray(tripsRaw) ? tripsRaw.map(mapTripFromTripsApi) : [];

    // newest first already sorted by API, but safe:
    const sliced = mapped.slice(0, limit);

    const pricedTrips = sliced.map((t) => {
      const pricing = calculateTripCost(toPricingEngineInput(t), PRICING_CONFIG);
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
    console.error("❌ Error computing pricing summary:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({
      error: "Failed to compute pricing summary",
      detail: err?.response?.data || err.message
    });
  }
});

// -----------------------------
// GET /api/trips/:tripId/waypoints  (calls Damoov POST)
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

    const body = {
      IncludeEvents: true,
      UnitSystem: "Si"
    };

    const damoovResp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });

    const rawTrip = damoovResp.data?.Result?.Trip;
    const waypoints = rawTrip?.Waypoints || [];
    const eventsRaw = rawTrip?.Events || [];

    const polyline = waypoints.map((wp) => ({ lat: wp.Lat, lon: wp.Long }));
    const speedSeries = waypoints.map((wp) => ({ t: wp.SecSinceStart, speedKmh: wp.Speed }));
    const events = eventsRaw.map((ev) => ({
      lat: ev.Lat ?? ev.Latitude ?? 0,
      lon: ev.Long ?? ev.Longitude ?? 0,
      type: ev.Type || ev.EventType || ev.EventName || ""
    }));

    res.json({ tripId, polyline, speedSeries, events });
  } catch (err) {
    console.error("❌ Error fetching trip waypoints:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({
      error: "Failed to fetch trip waypoints",
      detail: err?.response?.data || err.message
    });
  }
});

// -----------------------------
// GET /api/daily-stats  (keeps iOS expected shape: { days: [...] })
// -----------------------------
app.get("/api/daily-stats", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;

  if (!DAMOOV_DAILY_STATS_URL) {
    return res.status(500).json({ error: "Missing DAMOOV_DAILY_STATS_URL in env" });
  }

  try {
    // last 30 days
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

    const formatDate = (d) => d.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:mm:ss"
    const StartDate = formatDate(start);
    const EndDate = formatDate(now);

    const damoovResp = await axios.get(DAMOOV_DAILY_STATS_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      params: { StartDate, EndDate, UnitSystem: "Si" }
    });

    const raw = damoovResp.data;
    const list = raw?.Result || [];

    const clean = (Array.isArray(list) ? list : []).map((d) => ({
      date: d.ReportDate || null,
      mileageKm: safeNum(d.MileageKm, 0),
      tripsCount: safeNum(d.TripsCount, 0),
      avgSpeedKmh: safeNum(d.AverageSpeedKmh, 0),
      maxSpeedKmh: safeNum(d.MaxSpeedKmh, 0),
      speedingKm: safeNum(d.TotalSpeedingKm, 0),
      accelerationsCount: safeNum(d.AccelerationsCount, 0),
      brakingsCount: safeNum(d.BrakingsCount, 0),
      corneringsCount: safeNum(d.CorneringsCount, 0),
      phoneUsageMin: safeNum(d.PhoneUsageDurationMin, 0),
      drivingTimeMin: safeNum(d.DrivingTime, 0),
      nightDrivingMin: safeNum(d.NightDrivingTime, 0),
      rushHourDrivingMin: safeNum(d.RushHoursDrivingTime, 0)
    }));

    // ✅ important: keep iOS expected keys
    res.json({ days: clean, count: clean.length });
  } catch (err) {
    console.error("❌ Error from Damoov daily stats:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({
      error: "Failed to fetch daily stats",
      detail: err?.response?.data || err.message
    });
  }
});

// -----------------------------
// POST /api/alert-events
// -----------------------------
app.post("/api/alert-events", (req, res) => {
  console.log("📡 [AlertEvent]", req.body || {});
  res.json({ ok: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Wilson Telematics Backend is running on port ${PORT}`);
});
