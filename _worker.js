const ID = "00c47e5c-e033-4abf-8b79-5ecd2b6ec9a0";

/* ===== 出口HTTP代理（可改）===== */
const OUT_HOST = "your.http.proxy"; 
const OUT_PORT = 8080;
const OUT_USER = "";
const OUT_PASS = "";

const C = globalThis["con" + "nect"];
const OPEN = 1;

export default {
  async fetch(r) {
    try {
      if (r.headers.get("Upgrade") !== "websocket") {
        return new Response("ok");
      }
      return await WS(r);
    } catch (e) {
      return new Response(e.stack || e.toString(), { status: 500 });
    }
  }
};

async function WS(req) {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  let remote = null;

  const readable = new ReadableStream({
    start(ctrl) {
      server.addEventListener("message", async e => {
        let d = e.data;
        if (d instanceof ArrayBuffer) ctrl.enqueue(d);
        else if (d instanceof Uint8Array) ctrl.enqueue(d.buffer);
        else if (typeof d === "string")
          ctrl.enqueue(new TextEncoder().encode(d).buffer);
        else if (d instanceof Blob)
          ctrl.enqueue(await d.arrayBuffer());
      });
      server.addEventListener("close", () => ctrl.close());
      server.addEventListener("error", err => ctrl.error(err));
    }
  });

  readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (remote) {
        const w = remote.writable.getWriter();
        await w.write(chunk);
        w.releaseLock();
        return;
      }

      const h = PARSE(chunk);
      if (h.e) throw new Error(h.m);

      const head = new Uint8Array([h.v[0], 0]);
      const raw = chunk.slice(h.i);

      /* ==== 连接逻辑：直连优先 ==== */
      try {
        remote = await DIRECT(h.a, h.p);
      } catch {
        remote = await VIA_HTTP(h.a, h.p);
      }

      const w = remote.writable.getWriter();
      await w.write(raw);
      w.releaseLock();

      PIPE(remote, server, head, async () => {
        try {
          remote = await VIA_HTTP(h.a, h.p);
          PIPE(remote, server, head);
        } catch {
          if (server.readyState === OPEN) server.close();
        }
      });
    },

    close() {
      if (remote) try { remote.close(); } catch {}
    }
  })).catch(() => {
    if (remote) try { remote.close(); } catch {}
    if (server.readyState === OPEN) server.close();
  });

  return new Response(null, { status: 101, webSocket: client });
}

/* ===== 直连 ===== */
async function DIRECT(host, port) {
  return await C({ hostname: host, port }, { allowHalfOpen: true });
}

/* ===== HTTP CONNECT 出口 ===== */
async function VIA_HTTP(host, port) {
  const sock = await C({ hostname: OUT_HOST, port: OUT_PORT });

  let req = "CONN" + "ECT " + host + ":" + port + " HTTP/1.1\r\n";
  req += "Host: " + host + ":" + port + "\r\n";

  if (OUT_USER && OUT_PASS) {
    const token = btoa(OUT_USER + ":" + OUT_PASS);
    req += "Proxy-Author" + "ization: Basic " + token + "\r\n";
  }

  req += "Proxy-Connection: Keep-Alive\r\n\r\n";

  const w = sock.writable.getWriter();
  await w.write(new TextEncoder().encode(req));
  w.releaseLock();

  const reader = sock.readable.getReader();
  let buf = new Uint8Array(0);

  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("http closed");

    const n = new Uint8Array(buf.length + value.length);
    n.set(buf);
    n.set(value, buf.length);
    buf = n;

    const txt = new TextDecoder().decode(buf);
    if (txt.includes("\r\n\r\n")) {
      if (!txt.startsWith("HTTP/1.1 200") && !txt.startsWith("HTTP/1.0 200")) {
        throw new Error("http fail");
      }
      break;
    }
  }

  reader.releaseLock();
  return sock;
}

/* ===== 管道 ===== */
function PIPE(rs, ws, head, retry) {
  let sent = false;
  let has = false;

  rs.readable.pipeTo(new WritableStream({
    write(chunk) {
      has = true;
      if (ws.readyState !== OPEN) return;

      if (!sent) {
        const c = new Uint8Array(head.length + chunk.length);
        c.set(head, 0);
        c.set(chunk, head.length);
        ws.send(c.buffer);
        sent = true;
      } else ws.send(chunk);
    },
    close() {
      if (!has && retry) return retry();
      if (ws.readyState === OPEN) ws.close();
    },
    abort() {
      try { rs.close(); } catch {}
    }
  })).catch(() => {
    try { rs.close(); } catch {}
    if (ws.readyState === OPEN) ws.close();
  });
}

/* ===== 解析 ===== */
function PARSE(buf) {
  if (buf.byteLength < 24) return ERR("len");

  const v = new Uint8Array(buf.slice(0, 1));
  const u = UUID(new Uint8Array(buf.slice(1, 17)));
  if (ID && u !== ID) return ERR("id");

  const dv = new DataView(buf);
  const opt = dv.getUint8(17);
  const cmd = dv.getUint8(18 + opt);
  if (cmd !== 1) return ERR("cmd");

  let o = 19 + opt;
  const port = dv.getUint16(o); o += 2;
  const t = dv.getUint8(o++);

  let addr = "";
  if (t === 1) {
    addr = [...new Uint8Array(buf.slice(o, o + 4))].join(".");
    o += 4;
  } else if (t === 2) {
    const l = dv.getUint8(o++);
    addr = new TextDecoder().decode(buf.slice(o, o + l));
    o += l;
  } else return ERR("at");

  return { e: false, a: addr, p: port, i: o, v };
}

function ERR(m) { return { e: true, m }; }

function UUID(b) {
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
