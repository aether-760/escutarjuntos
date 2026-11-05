'use strict';

/*
 * Cliente MQTT 3.1.1 mínimo sobre WebSocket (wss), sem dependências.
 * Usado como "mensageiro" das salas: tudo trafega pela porta 443 (HTTPS/WSS),
 * então funciona em praticamente qualquer rede, sem depender de P2P.
 * Recursos: conectar, assinar, publicar (com retain), "última vontade" (will),
 * keep-alive e reconexão automática com reassinatura.
 */
(function (root) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function utf8(str) {
    const bytes = enc.encode(String(str));
    const out = new Uint8Array(bytes.length + 2);
    out[0] = bytes.length >> 8; out[1] = bytes.length & 255; out.set(bytes, 2);
    return out;
  }
  function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    parts.forEach((p) => { out.set(p, at); at += p.length; });
    return out;
  }
  function remainingLength(n) {
    const bytes = [];
    do { let digit = n % 128; n = Math.floor(n / 128); if (n > 0) digit |= 128; bytes.push(digit); } while (n > 0);
    return Uint8Array.from(bytes);
  }
  function packet(firstByte, body) {
    return concat([Uint8Array.from([firstByte]), remainingLength(body.length), body]);
  }

  class MqttLite {
    /**
     * @param {object} o
     * @param {string[]} o.urls            endereços wss:// a tentar, em ordem
     * @param {string}   o.clientId
     * @param {{topic:string,payload:string,retain:boolean}} [o.will]
     * @param {(topic:string,payload:string|Uint8Array,retained:boolean)=>void} o.onMessage
     * @param {(topic:string)=>boolean} [o.binaryTopic]  tópicos cujo conteúdo chega como Uint8Array (sem decodificar texto)
     * @param {(state:'connected'|'reconnecting'|'closed')=>void} [o.onState]
     */
    constructor(o) {
      this.urls = o.urls; this.clientId = o.clientId; this.will = o.will || null;
      this.onMessage = o.onMessage || (() => {}); this.onState = o.onState || (() => {});
      this.keepalive = o.keepalive || 30; this.binaryTopic = o.binaryTopic || null;
      this.subs = new Set(); this.ws = null; this.connected = false; this.closedByUs = false;
      this.buffer = new Uint8Array(0); this.packetId = 1; this.pingTimer = null; this.retryTimer = null; this.retries = 0;
      this.currentUrl = null;
    }

    /** Conecta no primeiro endereço que responder. Rejeita se nenhum responder. */
    async connect(perUrlTimeoutMs = 7000) {
      let lastError = null;
      for (const url of this.urls) {
        try { await this._open(url, perUrlTimeoutMs); this.currentUrl = url; this.retries = 0; return url; }
        catch (error) { lastError = error; }
      }
      throw lastError || new Error('Nenhum servidor de mensagens respondeu.');
    }

    _open(url, timeoutMs) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let ws;
        const fail = (error) => {
          if (settled) return; settled = true; clearTimeout(timer);
          try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } catch (_) { /* */ }
          reject(error);
        };
        const timer = setTimeout(() => fail(new Error(`Tempo esgotado em ${url}`)), timeoutMs);
        try { ws = new WebSocket(url, 'mqtt'); } catch (error) { fail(error); return; }
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => { ws.send(this._connectPacket()); };
        ws.onerror = () => fail(new Error(`Falha ao abrir ${url}`));
        ws.onclose = () => fail(new Error(`Conexão fechada em ${url}`));
        ws.onmessage = (event) => {
          this.buffer = concat([this.buffer, new Uint8Array(event.data)]);
          const packets = this._drain();
          for (const p of packets) {
            if (!settled && p.type === 2) {
              if (p.body[1] !== 0) { fail(new Error(`Servidor recusou (código ${p.body[1]})`)); return; }
              settled = true; clearTimeout(timer);
              this.ws = ws; this.connected = true;
              ws.onerror = () => { /* o onclose cuida */ };
              ws.onclose = () => this._dropped();
              ws.onmessage = (ev) => this._receive(ev.data);
              this._startPing();
              this.subs.forEach((filter) => this._sendSubscribe(filter));
              this.onState('connected');
              resolve(url);
            } else if (settled) {
              this._handle(p);
            }
          }
        };
      });
    }

    _connectPacket() {
      const hasWill = Boolean(this.will);
      let flags = 0x02; // clean session
      if (hasWill) { flags |= 0x04; if (this.will.retain) flags |= 0x20; }
      const header = concat([utf8('MQTT'), Uint8Array.from([4, flags, this.keepalive >> 8, this.keepalive & 255])]);
      const payload = [utf8(this.clientId)];
      if (hasWill) {
        const willBytes = enc.encode(this.will.payload || '');
        payload.push(utf8(this.will.topic), concat([Uint8Array.from([willBytes.length >> 8, willBytes.length & 255]), willBytes]));
      }
      return packet(0x10, concat([header, ...payload]));
    }

    _drain() {
      const out = [];
      for (;;) {
        const b = this.buffer;
        if (b.length < 2) break;
        let multiplier = 1, value = 0, i = 1, digit;
        do {
          if (i >= b.length) return out;
          digit = b[i++]; value += (digit & 127) * multiplier; multiplier *= 128;
          if (i > 5) { this.buffer = new Uint8Array(0); return out; }
        } while (digit & 128);
        if (b.length < i + value) break;
        out.push({ type: b[0] >> 4, flags: b[0] & 15, body: b.slice(i, i + value) });
        this.buffer = b.slice(i + value);
      }
      return out;
    }

    _receive(data) {
      this.buffer = concat([this.buffer, new Uint8Array(data)]);
      this._drain().forEach((p) => this._handle(p));
    }

    _handle(p) {
      if (p.type !== 3) return; // só PUBLISH interessa (SUBACK/PINGRESP são ignorados)
      const topicLen = (p.body[0] << 8) | p.body[1];
      const topic = dec.decode(p.body.subarray(2, 2 + topicLen));
      const qos = (p.flags >> 1) & 3;
      let at = 2 + topicLen;
      if (qos > 0) at += 2;
      const raw = p.body.subarray(at);
      const payload = (this.binaryTopic && this.binaryTopic(topic)) ? raw : dec.decode(raw);
      try { this.onMessage(topic, payload, Boolean(p.flags & 1)); } catch (error) { console.warn('[mqtt] erro no tratamento da mensagem', error); }
    }

    _sendSubscribe(filter) {
      if (!this.connected) return;
      const id = this.packetId++ & 0xffff || 1;
      this._raw(packet(0x82, concat([Uint8Array.from([id >> 8, id & 255]), utf8(filter), Uint8Array.from([0])])));
    }

    /** Bytes ainda na fila de envio do WebSocket (para controlar a velocidade). */
    get buffered() { return this.ws ? this.ws.bufferedAmount : 0; }

    _raw(bytes) { try { this.ws.send(bytes); return true; } catch (_) { return false; } }

    subscribe(filter) { this.subs.add(filter); this._sendSubscribe(filter); }

    publish(topic, payload, retain = false) {
      if (!this.connected) return false;
      const data = payload instanceof Uint8Array ? payload : enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
      const body = concat([utf8(topic), data]);
      return this._raw(packet(0x30 | (retain ? 1 : 0), body));
    }

    _startPing() {
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { if (this.connected) this._raw(Uint8Array.from([0xc0, 0])); }, (this.keepalive * 1000) / 2);
    }

    _dropped() {
      clearInterval(this.pingTimer);
      const was = this.connected;
      this.connected = false; this.ws = null;
      if (this.closedByUs) { this.onState('closed'); return; }
      if (was) this.onState('reconnecting');
      this._scheduleReconnect();
    }

    _scheduleReconnect() {
      if (this.closedByUs || this.retryTimer) return;
      const delay = Math.min(15000, 1000 * Math.pow(1.6, this.retries++));
      this.retryTimer = setTimeout(async () => {
        this.retryTimer = null;
        if (this.closedByUs) return;
        this.buffer = new Uint8Array(0);
        try { await this._open(this.currentUrl || this.urls[0], 7000); this.retries = 0; }
        catch (_) { this._scheduleReconnect(); }
      }, delay);
    }

    /** Fecha. cleanly=true envia DISCONNECT (o "will" NÃO é publicado); false derruba a conexão (o "will" é publicado). */
    close(cleanly = true) {
      this.closedByUs = true;
      clearInterval(this.pingTimer); clearTimeout(this.retryTimer); this.retryTimer = null;
      if (this.ws) {
        try { if (cleanly) this._raw(Uint8Array.from([0xe0, 0])); } catch (_) { /* */ }
        try { this.ws.onclose = null; this.ws.close(); } catch (_) { /* */ }
      }
      this.connected = false; this.ws = null;
    }
  }

  const api = { MqttLite };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OJMqtt = api;
})(typeof window !== 'undefined' ? window : globalThis);
