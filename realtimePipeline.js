// realtimePipeline.js
// Wilson Telematics - Realtime WebSocket pipeline
//
// 功能：
//   1. 连接 Damoov Realtime WebSocket，使用 Instance 级 JWT 做 authenticate
//   2. 监听 device_update 消息，提取速度 / 限速等信息
//   3. 在内存维护每个 device 的最新状态 + 最近的风险事件列表
//   4. 暴露 REST API 给前端 / 其他服务使用
//
// 使用方法：
//   1) 在项目根目录： npm install ws
//   2) 新建 .env 增加：
//        DAMOOV_REALTIME_WS_URL=wss://portal-apis.telematicssdk.com/realtime/api/v1/ws/realtime
//        DAMOOV_REALTIME_JWT=<你从 Quick Start 得到的 JWT（AccessToken.Token 那一串）>
//        DAMOOV_INSTANCE_ID=<你的 InstanceId>
//   3) 在 server.js 里：
//        const { setupRealtimePipeline } = require('./realtimePipeline');
//        ...
//        setupRealtimePipeline(app);

const WebSocket = require('ws');

// 从环境变量读取 Realtime 配置
const REALTIME_WS_URL =
  process.env.DAMOOV_REALTIME_WS_URL ||
  'wss://portal-apis.telematicssdk.com/realtime/api/v1/ws/realtime';

const REALTIME_JWT =
  process.env.DAMOOV_REALTIME_JWT || process.env.DAMOOV_ADMIN_JWT;

const REALTIME_INSTANCE_ID = process.env.DAMOOV_INSTANCE_ID;

// 简单的内存缓存：所有设备的最新状态 + 最近风险事件
// liveDevices: { [deviceToken]: { lastUpdateAt, riskLevel, overspeedMph, speedMps, speedLimitMps, position, raw } }
const liveDevices = {};

// liveEvents: 最近 N 条风险事件（用于 /api/live/events）
const liveEvents = [];
const MAX_EVENTS = 200;

// 对外导出：在 server.js 里调用，传入 Express app
function setupRealtimePipeline(app) {
  if (!REALTIME_JWT || !REALTIME_INSTANCE_ID) {
    console.warn(
      '⚠️ Realtime pipeline NOT started: DAMOOV_REALTIME_JWT 或 DAMOOV_INSTANCE_ID 未配置'
    );
  } else {
    startRealtimeWebSocket();
  }

  // ===== REST API：暴露实时状态 =====

  // 1) 返回所有设备的最新状态
  app.get('/api/live/devices', (req, res) => {
    res.json({
      count: Object.keys(liveDevices).length,
      devices: liveDevices,
    });
  });

  // 2) 返回某个 device 的最新状态
  app.get('/api/live/devices/:deviceToken', (req, res) => {
    const token = req.params.deviceToken;
    const device = liveDevices[token];
    if (!device) {
      return res.status(404).json({
        error: 'Device not found in realtime cache',
        deviceToken: token,
      });
    }
    res.json(device);
  });

  // 3) 返回最近风险事件列表
  app.get('/api/live/events', (req, res) => {
    res.json({
      count: liveEvents.length,
      events: liveEvents,
    });
  });
}

// ===== WebSocket 部分 =====

let ws = null;
let reconnectTimer = null;

function startRealtimeWebSocket() {
  console.log('🌐 Connecting to Damoov Realtime WebSocket:', REALTIME_WS_URL);

  ws = new WebSocket(REALTIME_WS_URL);

  ws.on('open', () => {
    console.log('✅ Realtime WebSocket connected');

    if (!REALTIME_JWT || !REALTIME_INSTANCE_ID) {
      console.error(
        '❌ Missing REALTIME_JWT or REALTIME_INSTANCE_ID, cannot authenticate'
      );
      return;
    }

    const authMessage = {
      type: 'authenticate',
      access_token: REALTIME_JWT,
      instance_id: REALTIME_INSTANCE_ID,
      client_id: 'wilson_telematics_backend',
      // device_token: null 表示订阅整个 instance；如果只想看某个设备，可以填具体 deviceToken
      device_token: null,
      units: 'imperial', // 或 'metric'
      timezone: 'America/Los_Angeles',
      date_format: 'iso',
    };

    ws.send(JSON.stringify(authMessage));
    console.log('📨 Sent authenticate message to Damoov Realtime');
  });

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.error('❌ Failed to parse WebSocket message:', err);
      return;
    }

    handleRealtimeMessage(data);
  });

  ws.on('error', (err) => {
    console.error('❌ Realtime WebSocket error:', err.message || err);
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Realtime WebSocket closed: code=${code}, reason=${reason}`);

    // 简单自动重连：5 秒后再连
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startRealtimeWebSocket();
      }, 5000);
    }
  });
}

function handleRealtimeMessage(data) {
  const type = data.type;

  switch (type) {
    case 'authenticated':
      console.log('✅ Realtime WebSocket authenticated');
      break;

    case 'welcome':
      console.log('👋 Realtime welcome message');
      console.log('   connection_id:', data.connection_id);
      console.log('   instance_id  :', data.instance_id);
      break;

    case 'subscribed':
      console.log('📡 Subscribed to topic:', data.topic);
      break;

    case 'device_update':
      handleDeviceUpdate(data);
      break;

    case 'ping':
      // 按文档：收到 ping 要回 pong
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
      break;

    case 'error':
      console.error(
        '⚠️ Realtime WebSocket error from server:',
        data.code,
        data.message
      );
      break;

    default:
      // 其他类型先简单打印出来，方便你以后扩展
      console.log('ℹ️ Realtime WS message type:', type);
      break;
  }
}

// 处理设备实时更新
function handleDeviceUpdate(data) {
  const nowIso = new Date().toISOString();

  // 文档里 device_token 字段可能叫 device_token / deviceToken，我们兼容一下
  const deviceToken =
    data.device_token || data.deviceToken || 'unknown-device';

  // 尝试从 data.position 里取经纬度 / 速度 / 限速
  const pos = data.position || data.Position || {};
  const lat =
    pos.lat ?? pos.latitude ?? (pos.coordinates && pos.coordinates[1]);
  const lon =
    pos.lon ?? pos.longitude ?? (pos.coordinates && pos.coordinates[0]);
  const speedMps = toNumber(pos.speed ?? pos.Speed);
  const speedLimitMps = toNumber(
    pos.speed_limit ?? pos.speedLimit ?? pos.speed_limit_mps
  );

  // 计算 overspeed（mph）
  let overspeedMph = 0;
  if (speedMps != null && speedLimitMps != null) {
    const mph = mpsToMph(speedMps);
    const limitMph = mpsToMph(speedLimitMps);
    overspeedMph = Math.max(0, mph - limitMph);
  }

  // 简单风险算法（你后面可以换成更精细的版本）：
  //   severe: overspeed >= 20 mph
  //   medium: >= 10
  //   mild  : >= 5
  const riskLevel = classifyRisk(overspeedMph);

  // 更新 liveDevices 缓存
  liveDevices[deviceToken] = {
    lastUpdateAt: nowIso,
    riskLevel,
    overspeedMph,
    speedMps,
    speedLimitMps,
    position: lat != null && lon != null ? { lat, lon } : null,
    raw: data,
  };

  // 如果风险不是 none，就记一条事件
  if (riskLevel !== 'none') {
    const event = {
      time: nowIso,
      deviceToken,
      riskLevel,
      overspeedMph,
      lat,
      lon,
    };
    liveEvents.unshift(event);
    if (liveEvents.length > MAX_EVENTS) {
      liveEvents.length = MAX_EVENTS;
    }
  }

  console.log(
    `🚗 Realtime device_update: device=${deviceToken}, risk=${riskLevel}, overspeed=${overspeedMph.toFixed(
      1
    )} mph`
  );
}

// 简单的风险分级
function classifyRisk(overspeedMph) {
  if (!overspeedMph || overspeedMph <= 0) return 'none';
  if (overspeedMph >= 20) return 'severe';
  if (overspeedMph >= 10) return 'medium';
  if (overspeedMph >= 5) return 'mild';
  return 'none';
}

// 工具方法：m/s -> mph
function mpsToMph(v) {
  return v * 2.23694;
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

module.exports = {
  setupRealtimePipeline,
  // 下面这两个导出可以让你在别的地方直接读缓存（可选）
  liveDevices,
  liveEvents,
};
