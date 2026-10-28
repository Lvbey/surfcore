// Minimal OneBot 11 client for NapCat.
//
// SurfCore keeps its existing bridge-facing method contract, while this adapter uses
// the standards-based event WebSocket plus OneBot HTTP actions. NapCat's HTTP server
// must be enabled explicitly; a WebSocket-only deployment is not sufficient for this app.
import { EventEmitter } from 'node:events';

export function text(value) {
  return [{ type: 'text', data: { text: String(value ?? '') } }];
}

function responseError(action, body) {
  return new Error(`OneBot action ${action} failed: retcode=${body?.retcode ?? '?'} ${String(body?.wording ?? body?.message ?? '').slice(0, 300)}`);
}

export class NapCatWebSocketClient extends EventEmitter {
  constructor({
    url,
    httpUrl = 'http://127.0.0.1:3000',
    accessToken = '',
    httpAccessToken = accessToken,
    reconnect = true,
    reconnectDelayMs = 3000,
    requestTimeoutMs = 15000,
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
  } = {}) {
    super();
    if (!url) throw new Error('NapCat wsUrl is required');
    if (!httpUrl) throw new Error('NapCat httpUrl is required');
    if (typeof WebSocketImpl !== 'function') throw new Error('当前 Node.js 没有可用的 WebSocket 实现，请使用 Node.js 22.13 或更新版本');
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 没有可用的 fetch 实现');
    this.url = String(url);
    this.httpUrl = String(httpUrl).replace(/\/+$/, '');
    this.accessToken = String(accessToken ?? '');
    this.httpAccessToken = String(httpAccessToken ?? '');
    this.reconnect = reconnect !== false;
    this.reconnectDelayMs = Math.max(250, Number(reconnectDelayMs) || 3000);
    this.requestTimeoutMs = Math.max(1000, Number(requestTimeoutMs) || 15000);
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.socket = null;
    this._connected = false;
    this._manualClose = false;
    this._connectPromise = null;
    this._reconnectTimer = null;
  }

  get isConnected() { return this._connected; }

  _wsUrl() {
    const u = new URL(this.url);
    if (this.accessToken) u.searchParams.set('access_token', this.accessToken);
    return u.toString();
  }

  _emitError(error) {
    // Node EventEmitter treats an unhandled `error` event as a process-fatal exception.
    if (this.listenerCount('error') > 0) this.emit('error', error instanceof Error ? error : new Error(String(error)));
  }

  _scheduleReconnect() {
    if (!this.reconnect || this._manualClose || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch((error) => this._emitError(error));
    }, this.reconnectDelayMs);
    this._reconnectTimer.unref?.();
  }

  connect() {
    if (this._connected && this.socket) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;
    this._manualClose = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    let socket;
    try { socket = new this.WebSocketImpl(this._wsUrl()); }
    catch (error) { this._scheduleReconnect(); return Promise.reject(error); }
    this.socket = socket;
    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = () => { if (!settled) { settled = true; resolve(); } };
      const settleReject = (error) => { if (!settled) { settled = true; reject(error); } };
      socket.addEventListener('open', () => {
        this._connected = true;
        settleResolve();
        this.emit('open');
      });
      socket.addEventListener('message', (message) => {
        try {
          const payload = typeof message.data === 'string' ? message.data : String(message.data ?? '');
          const event = JSON.parse(payload);
          if (event && typeof event === 'object') this.emit('event', event);
        } catch (error) {
          this._emitError(new Error(`NapCat WebSocket 收到无法解析的 JSON 帧：${error?.message ?? error}`));
        }
      });
      socket.addEventListener('error', () => {
        const error = new Error('NapCat WebSocket 连接错误；请核对 wsUrl、access_token 和 NapCat 监听配置');
        settleReject(error);
        this._emitError(error);
      });
      socket.addEventListener('close', (event) => {
        this._connected = false;
        const info = { code: Number(event?.code) || 1006, reason: String(event?.reason ?? '') };
        this.emit('close', info);
        settleReject(new Error(`NapCat WebSocket closed (${info.code})`));
        this._scheduleReconnect();
      });
    });
    const result = this._connectPromise;
    result.then(() => { if (this._connectPromise === result) this._connectPromise = null; }, () => { if (this._connectPromise === result) this._connectPromise = null; });
    return result;
  }

  close(code = 1000, reason = 'client-close') {
    this._manualClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    const socket = this.socket;
    this._connected = false;
    this.socket = null;
    try { socket?.close(code, reason); } catch {}
  }

  onEvent(handler) { this.on('event', handler); return this; }

  onPrivateMessage(handler) {
    this.on('event', (event) => {
      if (event?.post_type === 'message' && event?.message_type === 'private') handler(event);
    });
    return this;
  }

  onGroupMessage(handler) {
    this.on('event', (event) => {
      if (event?.post_type === 'message' && event?.message_type === 'group') handler(event);
    });
    return this;
  }

  onNotice(noticeType, handler) {
    this.on('event', (event) => {
      if (event?.post_type === 'notice' && event?.notice_type === noticeType) handler(event);
    });
    return this;
  }

  onBotStatus(handler) {
    this.on('event', (event) => {
      if (event?.post_type === 'notice' && (event?.notice_type === 'bot_status' || (event?.notice_type === 'notify' && event?.sub_type === 'bot_status'))) handler(event);
    });
    return this;
  }

  async request(action, params = {}) {
    const endpoint = `${this.httpUrl}/${encodeURIComponent(String(action))}`;
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.httpAccessToken ? { authorization: `Bearer ${this.httpAccessToken}` } : {}),
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const hint = response.status === 426 ? '（httpUrl 指向了 WebSocket 端口；NapCat HTTP API 必须单独启用）' : '';
      throw new Error(`NapCat HTTP ${response.status} ${action}${hint}`);
    }
    if (!body || typeof body !== 'object') throw new Error(`OneBot ${action} 返回了非 JSON 对象`);
    return body;
  }

  async raw(action, params = {}) {
    const body = await this.request(action, params);
    if (body.status !== 'ok' || Number(body.retcode) !== 0) throw responseError(action, body);
    return body.data;
  }

  getLoginInfo() { return this.raw('get_login_info', {}); }
  getStatus() { return this.raw('get_status', {}); }
  getMessage(messageId) { return this.raw('get_msg', { message_id: messageId }); }
  getImage(params = {}) { return this.raw('get_image', params); }
  getGroupInfo(groupId) { return this.raw('get_group_info', { group_id: groupId }); }
  getGroupMemberList(groupId) { return this.raw('get_group_member_list', { group_id: groupId, no_cache: false }); }
  getGroupMemberInfo(groupId, userId) { return this.raw('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: false }); }

  sendPrivateMessage(userId, message) { return this.raw('send_private_msg', { user_id: userId, message }); }
  sendGroupMessage(groupId, message) { return this.raw('send_group_msg', { group_id: groupId, message }); }

  // NapCat may not implement all SnowLuma-specific emoji helpers. Keep these as
  // explicit unsupported actions: callers already degrade safely when lookup fails.
  fetchFaceEntity(faceId) {
    return Promise.reject(new Error(`当前 OneBot adapter 未提供 fetchFaceEntity（face_id=${String(faceId)}）；已降级为表情文字`));
  }
}