import assert from 'node:assert/strict';
import { NapCatWebSocketClient, text } from '../src/napcat-client.js';

class FakeWebSocket {
  static instances = [];
  constructor(url) { this.url = url; this.listeners = new Map(); this.readyState = 0; FakeWebSocket.instances.push(this); }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  dispatch(name, event = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  open() { this.readyState = 1; this.dispatch('open'); }
  receive(value) { this.dispatch('message', { data: JSON.stringify(value) }); }
  close(code = 1000, reason = 'closed') { this.readyState = 3; this.dispatch('close', { code, reason }); }
}

const fetchCalls = [];
const fetchImpl = async (url, options) => {
  fetchCalls.push({ url, options });
  const action = String(url).split('/').at(-1);
  const data = action === 'get_login_info' ? { user_id: 12345, nickname: 'NapCatBot' } : { message_id: 99 };
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data }) };
};

assert.deepEqual(text('hello'), [{ type: 'text', data: { text: 'hello' } }]);
const bot = new NapCatWebSocketClient({
  url: 'ws://127.0.0.1:3001',
  httpUrl: 'http://127.0.0.1:3000',
  accessToken: 'ws-secret',
  httpAccessToken: 'http-secret',
  reconnect: false,
  WebSocketImpl: FakeWebSocket,
  fetchImpl,
});
let opened = false;
let privateMessage = null;
let groupMessage = null;
bot.on('open', () => { opened = true; });
bot.onPrivateMessage((event) => { privateMessage = event; });
bot.onGroupMessage((event) => { groupMessage = event; });
const connecting = bot.connect();
const socket = FakeWebSocket.instances.at(-1);
assert.match(socket.url, /access_token=ws-secret/);
socket.open();
await connecting;
assert.equal(opened, true);
socket.receive({ post_type: 'message', message_type: 'private', user_id: 7, self_id: 12345 });
socket.receive({ post_type: 'message', message_type: 'group', group_id: 8, self_id: 12345 });
assert.equal(privateMessage.user_id, 7);
assert.equal(groupMessage.group_id, 8);
const login = await bot.getLoginInfo();
assert.equal(login.user_id, 12345);
assert.equal(fetchCalls[0].url, 'http://127.0.0.1:3000/get_login_info');
assert.equal(fetchCalls[0].options.headers.authorization, 'Bearer http-secret');
assert.equal(JSON.parse(fetchCalls[0].options.body).user_id, undefined);
const sent = await bot.sendPrivateMessage(7, text('hello'));
assert.equal(sent.message_id, 99);
assert.equal(fetchCalls[1].url, 'http://127.0.0.1:3000/send_private_msg');
assert.deepEqual(JSON.parse(fetchCalls[1].options.body).message, text('hello'));
bot.close();

console.log('NapCat client tests passed');