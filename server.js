// server.js
// Wilson Telematics Backend - proxy for Damoov APIs (Trips + Daily Statistics)


process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, p) => {
  console.error('❌ UNHANDLED REJECTION:', reason);
});



const express = require('express');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Root endpoint
//app.get('/', (req, res) => {
//  res.json({ message: 'Wilson Telematics Backend is running' });
//});

/**
 * GET /api/trips
 *
 * 用「User level JWT」去调 Damoov 的 `trips/get/v1`，
 * 并开启 IncludeStatistics / IncludeScores。
 * 直接从返回的 Statistics 里把：
 *   - Mileage (km)
 *   - DurationMinutes
 *   - AverageSpeed
 *   - MaxSpeed
 * 等字段取出来，映射成 iOS 端的 BackendTrip 结构。
 *
 * Header：
 *   Authorization: Bearer <USER_JWT_FROM_IOS>
 */
app.get('/api/trips', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }

    // 最近 30 天
    const now = new Date();
    const dateTo = now.toISOString();
    const dateFrom = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

    const damoovResponse = await axios.post(
      'https://api.telematicssdk.com/trips/get/v1/',
      {
        StartDate: dateFrom,
        EndDate: dateTo,
        IncludeDetails: true,
        IncludeStatistics: true,   // ✅ 关键：要上统计数据
        IncludeScores: true,
        Locale: 'EN',
        UnitSystem: 'Si',
        SortBy: 'StartDateUtc_Desc',
        Paging: {
          Page: 1,
          Count: 50,
          IncludePagingInfo: true
        }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    const raw = damoovResponse.data;

    console.log('=== RAW trips/get/v1 (with statistics) ===');
    console.dir(raw, { depth: null });

    const tripsRaw = raw.Result?.Trips || [];

    if (!Array.isArray(tripsRaw) || tripsRaw.length === 0) {
      console.log('⚠️ No trips from trips/get/v1');
      return res.json({ source: 'damoov_trips_v1', trips: [], count: 0 });
    }

    const mapped = tripsRaw.map((t) => {
      const stats = t.Statistics || {};
      const data  = t.Data || {};

      const mileageKm      = stats.Mileage ?? 0;
      const durationMin    = stats.DurationMinutes ?? 0;
      const avgSpeed       = stats.AverageSpeed ?? 0;
      const maxSpeed       = stats.MaxSpeed ?? 0;

      const accelCount     = stats.AccelerationsCount ?? 0;
      const brakeCount     = stats.BrakingsCount ?? 0;
      const cornerCount    = stats.CorneringsCount ?? 0;

      const phoneMin       = stats.PhoneUsageDurationMinutes ?? 0;

      const dayMin         = stats.DayHours ?? 0;
      const rushMin        = stats.RushHours ?? 0;
      const nightMin       = stats.NightHours ?? 0;
      const totalTimeMin   = dayMin + rushMin + nightMin;

      const nightRatio     = totalTimeMin > 0 ? nightMin / totalTimeMin : 0;
      const rushRatio      = totalTimeMin > 0 ? rushMin / totalTimeMin : 0;

      return {
        id:
          t.Id ||
          t.TripId ||
          t.TrackToken ||
          t.IdTrip ||
          t.TripToken ||
          '',

        // 开始 / 结束时间：直接用 Data 里的 StartDate / EndDate
        startDate:
          data.StartDate ||
          data.StartDateUtc ||
          null,

        endDate:
          data.EndDate ||
          data.EndDateUtc ||
          null,

        // ✅ 核心指标
        distanceKm: mileageKm,
        durationSec: Math.round(durationMin * 60),

        averageSpeedKmh: avgSpeed,
        maxSpeedKmh: maxSpeed,

        // ✅ 驾驶事件
        harshBrakingCount: brakeCount,
        harshAccelerationCount: accelCount,
        harshCorneringCount: cornerCount,

        // Trips API 里没有“事件次数”，只有超速里程，就先用 0 占位
        speedingEvents: 0,

        // ✅ 手机使用（秒）
        phoneUsageSeconds: Math.round(phoneMin * 60),

        // ✅ 夜间/高峰比例
        nightDrivingRatio: nightRatio,
        rushHourDrivingRatio: rushRatio
      };
    });

    console.log('=== MAPPED TRIP SAMPLE (for iOS BackendTrip) ===');
    console.dir(mapped[0], { depth: null });

    res.json({
      source: 'damoov_trips_v1',
      trips: mapped,
      count: mapped.length
    });
  } catch (err) {
    console.error('❌ Error from Damoov (trips/get/v1 with statistics):', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: 'Failed to fetch trips from Damoov (trips/get/v1 with statistics)',
      detail: err.response?.data || err.message
    });
  }
});

// Get waypoints & events for a single trip
// GET /api/trips/:tripId/waypoints
// Header: Authorization: Bearer <USER_JWT_FROM_IOS>
// 获取指定 trip 的 waypoints（给 iOS 用来画 polyline + 速度图 + 事件点）
app.get('/api/trips/:tripId/waypoints', async (req, res) => {
  const { tripId } = req.params;

  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing user JWT in Authorization header' });
    }

    const damoovUrl = `https://api.telematicssdk.com/trips/get/v1/${tripId}/waypoints`;

    const body = {
      IncludeEvents: true,   // ✅ 要事件
      UnitSystem: 'Si'
    };

    const damoovResp = await axios.post(damoovUrl, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });

    console.log('=== RAW TRIP WAYPOINTS FROM DAMOOV ===');
    console.dir(damoovResp.data, { depth: 3 });

    const rawTrip = damoovResp.data?.Result?.Trip;
    const waypoints = rawTrip?.Waypoints || [];
    const eventsRaw = rawTrip?.Events || [];
      
      
    console.log('=== RAW Events from Damoov ===');
    console.dir(eventsRaw, { depth: 5 });

    // 1) polyline：路线坐标
    const polyline = waypoints.map(wp => ({
      lat: wp.Lat,
      lon: wp.Long
    }));

    // 2) speedSeries：速度时间序列
    const speedSeries = waypoints.map(wp => ({
      t: wp.SecSinceStart,   // 秒
      speedKmh: wp.Speed     // km/h
    }));

    // 3) events：把 Damoov 的 Events 映射成简化结构
    const events = eventsRaw.map(ev => ({
      lat: ev.Lat ?? ev.Latitude ?? 0,
      lon: ev.Long ?? ev.Longitude ?? 0,
      type: ev.Type || ev.EventType || ev.EventName || ''
    }));

    const responseForIOS = {
      tripId,
      polyline,
      speedSeries,
      events    // ✅ 现在真的返回 events 给 iOS 了
    };

    return res.json(responseForIOS);
  } catch (err) {
    console.error('❌ Error fetching trip waypoints from Damoov:', err.response?.data || err.message);
    const status = err.response?.status || 500;
    return res.status(status).json({
      error: 'Failed to fetch trip waypoints from Damoov',
      details: err.response?.data || err.message
    });
  }
});





/**
 * GET /api/daily-stats
 *
 * 用 Daily statistics API（User level）拿到 MileageKm、TripsCount 等
 * 你 Dashboard 顶部的大卡片（总公里数 / 总时长 / 平均速度）就是靠这组数据算出来的。
 *
 * Header：
 *   Authorization: Bearer <USER_JWT_FROM_IOS>
 */
app.get('/api/daily-stats', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }

    // 最近 30 天
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

    const formatDate = (d) => d.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:mm:ss"

    const StartDate = formatDate(start);
    const EndDate = formatDate(now);

    const damoovResponse = await axios.get(
      'https://api.telematicssdk.com/indicators/v2/Statistics/daily',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        params: {
          StartDate,
          EndDate,
          UnitSystem: 'Si'
        }
      }
    );

    const raw = damoovResponse.data;

    console.log('=== RAW DAILY STATS FROM DAMOOV ===');
    console.dir(raw, { depth: null });

    const list = raw.Result || [];

    const clean = list.map((d) => ({
      date: d.ReportDate || null,
      mileageKm: d.MileageKm || 0,
      tripsCount: d.TripsCount || 0,
      avgSpeedKmh: d.AverageSpeedKmh || 0,
      maxSpeedKmh: d.MaxSpeedKmh || 0,
      speedingKm: d.TotalSpeedingKm || 0,
      accelerationsCount: d.AccelerationsCount || 0,
      brakingsCount: d.BrakingsCount || 0,
      corneringsCount: d.CorneringsCount || 0,
      phoneUsageMin: d.PhoneUsageDurationMin || 0,
      drivingTimeMin: d.DrivingTime || 0,
      nightDrivingMin: d.NightDrivingTime || 0,
      rushHourDrivingMin: d.RushHoursDrivingTime || 0
    }));

    res.json({
      days: clean,
      count: clean.length
    });
  } catch (err) {
    console.error('❌ Error from Damoov daily stats:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: 'Failed to fetch daily statistics',
      detail: err.response?.data || err.message
    });
  }
});

/**
 * GET /api/trips-detailed
 *
 * 用 Admin JWT + userId 调 trips/get/admin/v1/short，
 * 拿到最近 30 天内带统计数据的 trips 列表（每条有里程/时长/速度等）。
 *
 * Query:
 *   userId: 必填（比如 e57d182c-93e4-4a76-9f85-28d4385e06bc）
 */
app.get('/api/trips-detailed', async (req, res) => {
  try {
    const adminToken = process.env.DAMOOV_ADMIN_JWT;
    if (!adminToken) {
      return res.status(500).json({
        error: 'Missing DAMOOV_ADMIN_JWT in .env (admin token required for detailed trips)'
      });
    }

    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId query parameter' });
    }

    console.log('🔍 Using admin API with userId:', userId);

    const now = new Date();
    const endDate = now.toISOString();
    const startDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

    // ❗ 关键点：所有参数都包在 request 里面，并且 Identifiers 是对象
    const body = {
      request: {
        Identifiers: {
          UserIds: [userId]
          // 如果你以后想按 deviceToken 查，可以改成：
          // DeviceTokens: [deviceToken]
        },
        StartDate: startDate,
        EndDate: endDate,
        IncludeDetails: false,      // 先只要 summary，地图以后再开
        IncludeStatistics: true,
        IncludeScores: true,
        UnitSystem: 'Si',
        SortBy: 'StartDateUtc_Desc',
        Limit: 50
      }
    };

    const damoovResponse = await axios.post(
      'https://api.telematicssdk.com/trips/get/admin/v1/short',
      body,
      {
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const raw = damoovResponse.data;
    console.log('=== RAW DETAILED TRIPS FROM DAMOOV (admin/short) ===');
    console.dir(raw, { depth: null });

    const tripsRaw =
      raw.Result?.Trips ||
      raw.Result?.List ||
      raw.Result ||
      raw.trips ||
      raw.Trips ||
      [];

    if (!Array.isArray(tripsRaw) || tripsRaw.length === 0) {
      console.log('⚠️ No detailed trips from admin API');
      return res.json({ source: 'damoov_trips_admin_v1_short', trips: [], count: 0 });
    }

    const mapped = tripsRaw.map((t) => ({
      id:
        t.TripId ||
        t.Id ||
        t.TrackToken ||
        t.IdTrip ||
        t.TripToken ||
        '',

      startDate:
        t.StartDateUtc ||
        t.StartDate ||
        t.DateStartUtc ||
        t.DateStart ||
        null,

      endDate:
        t.EndDateUtc ||
        t.EndDate ||
        t.DateEndUtc ||
        t.DateEnd ||
        null,

      distanceKm:
        t.DistanceKm ||
        t.MileageKm ||
        t.TripDistanceKm ||
        0,

      // 时长秒（有的字段是分钟，所以 *60）
      durationSec:
        t.DurationSec ||
        t.DrivingTimeSec ||
        (t.DrivingTimeMin ? t.DrivingTimeMin * 60 : 0) ||
        (t.DrivingTime ? t.DrivingTime * 60 : 0),

      averageSpeedKmh:
        t.AverageSpeedKmh ||
        t.AverageSpeed ||
        0,

      maxSpeedKmh:
        t.MaxSpeedKmh ||
        t.MaxSpeed ||
        0,

      harshBrakingCount:
        t.BrakingsCount ||
        t.HarshBrakingCount ||
        0,

      harshAccelerationCount:
        t.AccelerationsCount ||
        t.HarshAccelerationCount ||
        0,

      harshCorneringCount:
        t.CorneringsCount ||
        t.HarshCorneringCount ||
        0,

      speedingEvents:
        t.SpeedingEventsCount ||
        t.SpeedingCount ||
        0,

      phoneUsageSeconds:
        t.PhoneUsageDurationSec ||
        (t.PhoneUsageDurationMin ? t.PhoneUsageDurationMin * 60 : 0) ||
        0,

      nightDrivingRatio:
        t.NightDrivingRatio ||
        0,

      rushHourDrivingRatio:
        t.RushHourDrivingRatio ||
        0
    }));

    console.log('=== MAPPED DETAILED TRIP SAMPLE ===');
    console.dir(mapped[0], { depth: null });

    res.json({
      source: 'damoov_trips_admin_v1_short',
      trips: mapped,
      count: mapped.length
    });
  } catch (err) {
    console.error('❌ Error from Damoov (trips-detailed admin):', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: 'Failed to fetch detailed trips',
      detail: err.response?.data || err.message
    });
  }
});

// 健康检查 & 根路径
app.get('/', (req, res) => {
  console.log('➡️ GET / hit');
  res.status(200).json({
    status: 'ok',
    message: 'Wilson Telematics Backend is running',
    timestamp: new Date().toISOString()
  });
});



app.listen(PORT, () => {
  console.log(`🚀 Wilson Telematics Backend is running on port ${PORT}`);
});
