import { connect } from 'cloudflare:sockets';
const d = new TextDecoder(), e = new TextEncoder();
let U = null, C = {};

const g = (k, f, env) => {
  const v = import.meta?.env?.[k] ?? env?.[k];
  if (!v) return f;
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.includes('\n')) return t.split('\n').map(x => x.trim()).filter(Boolean);
  const n = Number(t);
  return isNaN(n) ? t : n;
};

const init = env => {
  if (C.done) return C;
  const m = {
    I: ['ID', '123456'],
    U: ['UUID', '5aba5b77-48eb-4ae2-b60d-5bfee7ac169e'],
    P: ['IP', ['104.16.160.145']],
    T: ['TXT', []],
    R: ['PROXYIP', 'sjc.o00o.ooo:443'],
    F: ['启用反代功能', true],
    N: ['NAT64', false],
    N2: ['我的节点名字', '狂暴']
  };
  for (const [k, [k2, d]] of Object.entries(m)) C[k] = g(k2, d, env);
  C.B = U = Uint8Array.from(C.U.replace(/-/g, '').match(/.{2}/g).map(x => parseInt(x, 16)));
  return C.done = 1, C;
};

const chk = b => U.every((x, i) => b[i] === x);

const to64 = ip => '2001:67c:2960:6464::' + ip.split('.').map(x => (+x).toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(':');

const tryConn = async (h, p, c, init) => {
  try {
    const s = await connect({ hostname: h, port: p });
    await s.opened;
    return { tcpSocket: s, initialData: init };
  } catch {}
  if (c.N && /^\d+\.\d+\.\d+\.\d+$/.test(h)) try {
    return await tryConn(to64(h), p, { ...c, N: 0 }, init);
  } catch {}
  if (c.F && c.R) {
    const [h2, p2] = c.R.split(':');
    return await tryConn(h2, +p2 || p, { ...c, F: 0 }, init);
  }
  throw new Error('连接失败');
};

const parseV = async (buf, c) => {
  const a = new Uint8Array(buf), t = a[17], p = (a[18 + t + 1] << 8) | a[18 + t + 2];
  let o = 18 + t + 4, h = '';
  switch (a[o - 1]) {
    case 1: h = `${a[o++]}.${a[o++]}.${a[o++]}.${a[o++]}`; break;
    case 2: { const l = a[o++]; h = d.decode(a.subarray(o, o + l)); o += l; break; }
    case 3: h = Array.from({ length: 8 }, (_, i) => ((a[o + 2*i] << 8) | a[o + 2*i + 1]).toString(16)).join(':'); o += 16;
  }
  return await tryConn(h, p, c, buf.slice(o));
};

const tunnel = (ws, tcp, init) => {
  const w = tcp.writable.getWriter();
  ws.send(new Uint8Array([0, 0]));
  if (init) w.write(init);
  let b = [], t;
  ws.addEventListener('message', ({ data }) => {
    const c = data instanceof ArrayBuffer ? new Uint8Array(data) : typeof data === 'string' ? e.encode(data) : data;
    b.push(c);
    if (!t) t = setTimeout(() => {
      const total = b.length === 1 ? b[0] : (() => {
        const len = b.reduce((s, x) => s + x.length, 0), o = new Uint8Array(len);
        let pos = 0; for (const x of b) o.set(x, pos), pos += x.length;
        return o;
      })();
      w.write(total); b = []; t = null;
    }, 5);
  });

  tcp.readable.pipeTo(new WritableStream({
    write: d => ws.send(d),
    close: () => ws.close(),
    abort: () => ws.close()
  })).catch(() => ws.close());

  ws.addEventListener('close', () => {
    try { w.releaseLock(); tcp.close(); } catch {}
  });
};

const conf = (h, c) => c.P.concat([`${h}:443`]).map(x => {
  const [raw, name = c.N2] = x.split('#'), [addr, port = 443] = raw.split(':');
  return `vless://${c.U}@${addr}:${port}?encryption=none&security=tls&type=ws&host=${h}&sni=${h}&path=%2F%3Fed%3D2560#${name}`;
}).join('\n');

export default {
  async fetch(req, env) {
    const c = init(env), url = new URL(req.url), h = req.headers.get('Host');
    if (req.headers.get('Upgrade') !== 'websocket') {
      const path = url.pathname;
      if (path === `/${c.I}`) return new Response(`订阅地址: https://${h}/${c.I}/vless`);
      if (path === `/${c.I}/vless`) return new Response(conf(h, c));
      return new Response('Hello Worker!');
    }

    try {
      const proto = req.headers.get('sec-websocket-protocol'), data = Uint8Array.from(atob(proto.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      if (!chk(data.subarray(1, 17))) return new Response('无效UUID', { status: 403 });
      const { tcpSocket, initialData } = await parseV(data.buffer, c);
      const [client, server] = new WebSocketPair(); server.accept();
      tunnel(server, tcpSocket, initialData);
      return new Response(null, { status: 101, webSocket: client });
    } catch (e) {
      return new Response('连接失败: ' + e.message, { status: 502 });
    }
  }
};
