// realtimeAuth.js
// 负责：
// 1) 使用 Auth/Login（https://user.telematicssdk.com/v1/Auth/Login）获取新的 Realtime JWT
// 2) 在内存中缓存 token，直到过期前 60 秒再刷新

const axios = require('axios');

// ================== 配置（来自 .env） ==================

// Auth URL：你现在用的就是这个；也允许你通过 env 覆盖
const AUTH_URL =
  process.env.DAMOOV_AUTH_URL ||
  'https://user.telematicssdk.com/v1/Auth/Login';

// 这两个来自 DataHub 里 “API Authorization Credentials / Instance”
const AUTH_INSTANCE_ID  = process.env.DAMOOV_AUTH_INSTANCE_ID;   // API InstanceId
const AUTH_INSTANCE_KEY = process.env.DAMOOV_AUTH_INSTANCE_KEY;  // API InstanceKey（如有）

// 这两个是你在 Swagger / Portal 登录 Auth/Login 时用的邮箱和密码
const AUTH_LOGIN_EMAIL  = process.env.DAMOOV_AUTH_LOGIN_EMAIL;
const AUTH_PASSWORD     = process.env.DAMOOV_AUTH_PASSWORD;

// 兼容：如果你还想手动塞一个固定 JWT（调试用）
const FALLBACK_STATIC_JWT = process.env.DAMOOV_REALTIME_JWT || null;

// ================== 内存缓存 ==================

let cachedToken = null;
let cachedExpiresAt = 0; // 毫秒时间戳

function shortToken(t) {
  if (!t) return '<null>';
  return t.slice(0, 16) + '...';
}

// ================== 真正向 Damoov 换新 JWT ==================

async function fetchNewTokenFromDamoov() {
  if (!AUTH_INSTANCE_ID || !AUTH_LOGIN_EMAIL || !AUTH_PASSWORD) {
    console.warn(
      '⚠️ fetchNewTokenFromDamoov: 缺少 DAMOOV_AUTH_INSTANCE_ID / DAMOOV_AUTH_LOGIN_EMAIL / DAMOOV_AUTH_PASSWORD'
    );
    return null;
  }

  console.log('🔐 Fetching new realtime JWT from Damoov (Auth/Login)...');

  try {
    // 对应你在 Swagger 里 Auth/Login 的 body：
    // {
    //   "loginFields": { "Email": "<你的邮箱>" },
    //   "password": "<你的密码>"
    // }
    const body = {
      loginFields: { Email: AUTH_LOGIN_EMAIL },
      password: AUTH_PASSWORD
    };

    const resp = await axios.post(AUTH_URL, body, {
      headers: {
        InstanceId: AUTH_INSTANCE_ID,
        InstanceKey: AUTH_INSTANCE_KEY || '',
        'Content-Type': 'application/json-patch+json',
        accept: '*/*'
      },
      timeout: 10_000
    });

    const data = resp.data || {};
    const result = data.Result || data.result || data;
    const accessTokenObj = result.AccessToken || result.access_token || {};
    const token = accessTokenObj.Token || accessTokenObj.token;
    const expiresIn = accessTokenObj.ExpiresIn || accessTokenObj.expires_in || 24 * 60 * 60; // 秒

    if (!token) {
      console.error('❌ fetchNewTokenFromDamoov: 没从响应里解析出 Token，请检查字段名');
      console.error('   Raw response snippet:', JSON.stringify(data).slice(0, 500));
      return null;
    }

    const now = Date.now();
    const expiresAt = now + expiresIn * 1000;

    cachedToken = token;
    cachedExpiresAt = expiresAt;

    console.log(
      '✅ Got new realtime JWT, prefix =',
      shortToken(token),
      'expiresIn =',
      expiresIn,
      'seconds'
    );

    return token;
  } catch (err) {
    console.error(
      '❌ fetchNewTokenFromDamoov error:',
      err.response?.status,
      err.response?.data || err.message
    );
  console.error('  status:', err.response?.status);
  console.error('  headers:', err.response?.headers);
  console.error('  data:', JSON.stringify(err.response?.data || {}, null, 2));
  console.error('  message:', err.message);
    return null;
  }
}

// ================== 对外：获取“当前可用”的 JWT ==================

async function getRealtimeJwt() {
  const now = Date.now();
  const safetyWindowMs = 60_000; // 提前 60 秒刷新

  if (cachedToken && now < cachedExpiresAt - safetyWindowMs) {
    // 还没到过期窗口，直接用缓存
    return cachedToken;
  }

  // 缓存没了 / 快过期 -> 去后台换一个新的
  const freshToken = await fetchNewTokenFromDamoov();

  if (freshToken) {
    return freshToken;
  }

  // 如果换新失败，而且你配置了一个硬编码 token，就退回去用这个
  if (FALLBACK_STATIC_JWT) {
    console.warn(
      '⚠️ getRealtimeJwt: 使用 fallback DAMOOV_REALTIME_JWT，注意它可能 24 小时后过期'
    );
    return FALLBACK_STATIC_JWT;
  }

  console.error('❌ getRealtimeJwt: 无可用 realtime JWT');
  return null;
}

// WebSocket 收到 401 / 403 时，可以手动把缓存作废，下次会强制刷新
function invalidateRealtimeJwt() {
  cachedToken = null;
  cachedExpiresAt = 0;
  console.warn('🧹 Realtime JWT cache invalidated');
}

module.exports = {
  getRealtimeJwt,
  invalidateRealtimeJwt
};
