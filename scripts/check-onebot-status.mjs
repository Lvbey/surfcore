// 查询 SnowLuma 网关与 QQ 会话状态：HTTP API + WebSocket
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { NapCatWebSocketClient } from '../src/napcat-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const napcat = cfg.onebot?.adapter === 'napcat';
const selected = napcat ? (cfg.onebot ?? {}) : (cfg.snowluma ?? {});
const wsUrl = selected.wsUrl || cfg.snowluma?.wsUrl || 'ws://127.0.0.1:3001';
const httpUrl = selected.httpUrl || cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000';
const wsToken = napcat ? (selected.wsAccessToken ?? selected.accessToken ?? '') : (cfg.snowluma?.accessToken ?? '');
const httpToken = napcat ? (selected.httpAccessToken ?? selected.accessToken ?? '') : (cfg.snowluma?.accessToken ?? '');
const baseHttp = String(httpUrl).replace(/\/+$/, '');

console.log('配置:');
console.log(`  wsUrl   = ${wsUrl}`);
console.log(`  httpUrl = ${baseHttp}`);
console.log(`  adapter = ${napcat ? 'NapCat' : 'SnowLuma'}`);
console.log(`  WS token   = ${wsToken ? '已配置' : '未配置'}`);
console.log(`  HTTP token = ${httpToken ? '已配置' : '未配置'}`);

// 1) HTTP API 检查（MCP 工具走这里，426 是最常见问题）
try {
  const res = await fetch(`${baseHttp}/get_login_info`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    signal: AbortSignal.timeout(5000)
  });
  if (res.status === 426) {
    console.error('\n❌ HTTP 426: httpUrl 指向了 WebSocket 端口。');
    console.error(`   当前 httpUrl = ${baseHttp}`);
    console.error('   请改为 OneBot HTTP API 端口（默认 http://127.0.0.1:3000），不要填 WebSocket 端口（默认 3001）。');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\n❌ HTTP ${res.status}: 无法访问 ${baseHttp}/get_login_info`);
    console.error(`   请确认 ${napcat ? 'NapCat' : 'SnowLuma'} 已启动、HTTP API 已启用，且端口/token 正确。`);
    process.exit(1);
  }
  const body = await res.json();
  if (body?.status === 'ok' && body?.retcode === 0) {
    console.log('\n✅ OneBot HTTP API 正常');
    if (body.data?.user_id) console.log(`   当前 QQ: ${body.data.user_id} (${body.data.nickname || ''})`);
  } else {
    console.error(`\n❌ 网关返回异常: ${JSON.stringify(body)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`\n❌ 无法连接 ${baseHttp}/get_login_info: ${error?.message ?? error}`);
  console.error(`   请确认 ${napcat ? 'NapCat' : 'SnowLuma'} 已启动、HTTP API 已启用，且端口/token 正确。`);
  process.exit(1);
}

// 2) WebSocket 连接检查
console.log('\n--- WebSocket ---');
const bot = napcat
  ? new NapCatWebSocketClient({ url: wsUrl, httpUrl: baseHttp, accessToken: wsToken, httpAccessToken: httpToken, reconnect: false })
  : new SnowLumaWebSocketClient({ url: wsUrl, accessToken: wsToken || undefined, reconnect: false });
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 10_000));
try {
  await Promise.race([bot.connect(), timeout]);
  console.log(`✅ 已连接 ${napcat ? 'NapCat' : 'SnowLuma'} 网关`);
  const login = await bot.getLoginInfo();
  console.log('✅ get_login_info:', JSON.stringify(login));
  try {
    const status = await bot.getStatus();
    console.log('✅ get_status:', JSON.stringify(status));
  } catch (error) {
    console.log('⚠️  get_status 失败:', error?.message ?? error);
  }
} catch (error) {
  console.error('❌ WebSocket 连接失败:', error?.message ?? error);
  process.exit(1);
} finally {
  try { bot.close(); } catch {}
}
