// realtimePipeline.js
// Wilson Telematics Realtime Pipeline
// 连接 Damoov WebSocket，打印 device_update 事件，确认实时数据是否到达后端

const WebSocket = require('ws');

// 从环境变量读取配置
const REALTIME_JWT = process.env.DAMOOV_REALTIME_JWT;           // 你在 portal 用 /app/auth 拿到的 AccessToken.Token
const REALTIME_INSTANCE_ID = process.env.DAMOOV_INSTANCE_ID;    // 33bda6ca-...
const REALTIME_DEVICE_TOKEN = process.env.DAMOOV_DEVICE_TOKEN || null; // 可选：如果只想订阅某一个 device

const WS_URL = 'wss://portal-apis.telematicssdk.com/realtime/api/v1/ws/realtime';

function startRealtimePipeline() {
  if (!REALTIME_JWT || !REALTIME_INSTANCE_ID) {
    console.warn('⚠️ Realtime pipeline disabled: DAMOOV_REALTIME_JWT 或 DAMOOV_INSTANCE_ID 没配置');
    return;
  }

  console.log(`🌐 Connecting to Damoov Realtime WebSocket: ${WS_URL}`);

  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ Realtime WebSocket connected');

    const authMessage = {
      type: 'authenticate',
      access_token: REALTIME_JWT,
      instance_id: REALTIME_INSTANCE_ID,
      client_id: `node_backend_${Date.now()}`,   // 可选，方便他们排查
      units: 'imperial',                         // 直接让后端用 mph
      timezone: 'America/Los_Angeles',
      date_format: 'iso'
    };

    // 如果你已经确认 DAMOOV_DEVICE_TOKEN 是当前手机的 virtualDeviceToken，也可以打开下面这一行，只订阅一个 device：
    if (REALTIME_DEVICE_TOKEN) {
      authMessage.device_token = REALTIME_DEVICE_TOKEN;
    }

    ws.send(JSON.stringify(authMessage));
    console.log('📨 Sent authenticate message to Damoov Realtime');
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      console.warn('⚠️ Realtime non-JSON message:', raw.toString());
      return;
    }

    switch (data.type) {
    case 'authenticated':
      console.log('✅ Realtime WebSocket authenticated');
      break;

    case 'welcome':
      console.log('👋 Realtime welcome message');
      console.log('   connection_id:', data.connection_id);
      console.log('   instance_id  :', data.instance_id);
      break;

    case 'subscribed':
      console.log('📡 Automatically subscribed to topic:', data.topic);
      break;

    case 'device_update': {
      const pos = data.position || {};
      const speedMps = typeof pos.Speed === 'number' ? pos.Speed : 0;
      const speedMph = speedMps * 2.23694;

      console.log(
        `🚗 device_update | device=${data.device_token}` +
        ` track=${data.track_token}` +
        ` lat=${pos.Latitude}` +
        ` lon=${pos.Longitude}` +
        ` speed=${speedMph.toFixed(1)} mph`
      );

      // 👇 以后如果你想在后端也跑一遍风险引擎，可以在这里调你自己的逻辑
      // drivingRiskEngine.process({
      //   deviceToken: data.device_token,
      //   timestamp: pos.Timestamp,
      //   speedMps,
      //   lat: pos.Latitude,
      //   lon: pos.Longitude
      // });

      break;
    }

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    case 'error':
      console.error(
        '⚠️ Realtime WebSocket error from server:',
        data.code,
        data.message
      );
      break;

    default:
      console.log('ℹ️ Realtime message:', data);
    }
  });

  ws.on('error', (err) => {
    console.error('⚠️ Realtime WebSocket LOW-LEVEL error:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.warn('🔌 Realtime WebSocket closed:', code, reason.toString());
    // 简单的重连机制（1 分钟后重连），可以根据需要改
    setTimeout(() => {
      console.log('♻️ Reconnecting Realtime WebSocket...');
      startRealtimePipeline();
    }, 60_000);
  });
}

module.exports = {
  startRealtimePipeline
};
