// realtimePipeline.js
// Wilson Telematics Realtime Pipeline
// 1) 自动调用 https://user.telematicssdk.com/v1/Auth/Login 拿 JWT
// 2) 用这个 JWT 连接 Damoov Realtime WebSocket
// 3) 打印 device_update 事件到 log（Railway / 本地）

const WebSocket = require('ws');
const axios = require('axios');

// ========== 1. Auth 配置（用于 /v1/Auth/Login） ==========

// Auth URL：你用的就是这个
const AUTH_URL =
  process.env.DAMOOV_AUTH_URL ||
  'https://user.telematicssdk.com/v1/Auth/Login';

// 来自 DataHub “API Authorization Credentials / Instance” 管理页面
// （你在 Swagger 里登录时用的那一组）
const AUTH_INSTANCE_ID   = process.env.DAMOOV_AUTH_INSTANCE_ID;   // InstanceID
const AUTH_INSTANCE_KEY  = process.env.DAMOOV_AUTH_INSTANCE_KEY;  // InstanceKey（有就填，没有可以先留空）

// 这两个就是你在 Swagger 里输入的 Email / Password
const AUTH_LOGIN_EMAIL   = process.env.DAMOOV_AUTH_LOGIN_EMAIL;
const AUTH_PASSWORD      = process.env.DAMOOV_AUTH_PASSWORD;

// ========== 2. Realtime WebSocket 配置 ==========

// Realtime Quick Start 里看到的 Instance Id（一般是 User Group InstanceID）
const REALTIME_INSTANCE_ID = process.env.DAMOOV_INSTANCE_ID; // 例如：33bda6ca-7cbf-4f31-a2c7-e522ccbbd228

// 可选：如果想只订阅某一个设备，就填 virtualDeviceToken；不填就是整个 instance 的设备
const REALTIME_DEVICE_TOKEN = process.env.DAMOOV_DEVICE_TOKEN || null;

const WS_URL = 'wss://portal-apis.telematicssdk.com/realtime/api/v1/ws/realtime';

// ========== 3. 内部状态：当前 JWT ==========

let currentJwt = null;

// ========== 4. 登录函数：调用 /v1/Auth/Login 拿新 JWT ==========

async function loginForRealtime() {
  if (!AUTH_INSTANCE_ID || !AUTH_LOGIN_EMAIL || !AUTH_PASSWORD) {
    console.warn('⚠️ 缺少 DAMOOV_AUTH_* 环境变量，无法自动登录获取 JWT');
    return null;
  }

  try {
    console.log('🔐 调用 Auth/Login 获取新的 JWT ...');

    const resp = await axios.post(
      AUTH_URL,
      {
        // 按文档“Authorize as Admin with API Authorization Credentials”
        // curl 示例里字段是小写 loginFields / password
        loginFields: { Email: AUTH_LOGIN_EMAIL },
        password: AUTH_PASSWORD
      },
      {
        headers: {
          // 这里的 InstanceId / InstanceKey 来自你管理页面的 API Instance
          InstanceId: AUTH_INSTANCE_ID,
          InstanceKey: AUTH_INSTANCE_KEY || '',
          'Content-Type': 'application/json-patch+json',
          accept: '*/*'
        }
      }
    );

    const result = resp.data.Result || {};
    const token = result.AccessToken?.Token;
    const refreshToken = result.RefreshToken;

    if (!token) {
      console.error('❌ Auth/Login 返回的结果里没有 AccessToken.Token：', resp.data);
      return null;
    }

    currentJwt = token;
    console.log('✅ Auth/Login 成功获取 JWT（RefreshToken 是否存在：', !!refreshToken, '）');

    // 👉 现在我们先不单独调 RefreshToken，而是：
    //    如果 WebSocket 报 401 / 403，就再调一次 Login 拿新的 JWT，
    //    对你来说已经是“自动更新”了，不用每天自己手动去 portal 换。
    return token;
  } catch (err) {
    console.error('❌ Auth/Login 调用失败：', err.response?.data || err.message);
    return null;
  }
}

async function getJwtEnsured() {
  if (currentJwt) return currentJwt;
  return await loginForRealtime();
}

// ========== 5. 启动实时管线（在 server.js 里调用） ==========

function startRealtimePipeline() {
  if (!REALTIME_INSTANCE_ID) {
    console.warn('⚠️ Realtime pipeline 未启动：DAMOOV_INSTANCE_ID 没有配置');
    return;
  }

  connectWebSocket();
}

// ========== 6. 建立 WebSocket 连接并处理消息 ==========

async function connectWebSocket() {
  const jwt = await getJwtEnsured();
  if (!jwt) {
    console.warn('⚠️ 因为没有 JWT，不能连接 Realtime WebSocket');
    return;
  }

  console.log(`🌐 Connecting to Damoov Realtime WebSocket: ${WS_URL}`);
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ Realtime WebSocket connected');

    const authMessage = {
      type: 'authenticate',
      access_token: jwt,
      instance_id: REALTIME_INSTANCE_ID,
      client_id: `node_backend_${Date.now()}`,
      units: 'imperial',
      timezone: 'America/Los_Angeles',
      date_format: 'iso'
    };

    if (REALTIME_DEVICE_TOKEN) {
      authMessage.device_token = REALTIME_DEVICE_TOKEN;
    }

    ws.send(JSON.stringify(authMessage));
    console.log('📨 Sent authenticate message to Damoov Realtime');
  });

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      console.warn('⚠️ Realtime non-JSON message:', raw.toString());
      return;
    }

    switch (data.type) {
      case 'welcome':
        console.log('👋 Realtime welcome message');
        console.log('   connection_id:', data.connection_id);
        console.log('   instance_id  :', data.instance_id);
        break;

      case 'authenticated':
        console.log('✅ Realtime WebSocket authenticated');
        break;

      case 'subscribed':
        console.log('📡 Realtime 订阅成功 topic:', data.topic);
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

        // 将来如果要在后端也算一个风险评分，可以在这里调用你自己的逻辑
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

        // 如果是认证问题（401 / 403），自动重新登录 + 重连
        if (data.code === 401 || data.code === 403) {
          await handleAuthErrorAndReconnect(ws);
        }
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
    // 非主动关闭的情况，稍后重连
    setTimeout(() => {
      console.log('♻️ Reconnecting Realtime WebSocket...');
      connectWebSocket();
    }, 60_000);
  });

  async function handleAuthErrorAndReconnect(socket) {
    console.warn('🔐 WebSocket 认证失败，准备重新登录并重连...');
    currentJwt = null; // 清空旧 JWT
    await loginForRealtime(); // 拿新的 JWT
    try {
      socket.close();
    } catch (e) {
      // ignore
    }
    setTimeout(() => {
      console.log('♻️ Reconnecting Realtime WebSocket after auth error...');
      connectWebSocket();
    }, 5_000);
  }
}

module.exports = {
  startRealtimePipeline
};
