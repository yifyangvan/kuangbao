import { connect } from 'cloudflare:sockets';
const d = new TextDecoder(), e = new TextEncoder();
let U = null, C = {};

const g = (n, f, env) => {
  const v = import.meta?.env?.[n] ?? env?.[n];
  if (!v) return f;
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.includes('\n')) return t.split('\n').map(x => x.trim()).filter(Boolean);
  const num = Number(t);
  return isNaN(num) ? t : num;
};

const b16 = s => Uint8Array.from(s.replace(/-/g, '').match(/.{2}/g).map(x => parseInt(x, 16)));

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
  C.B = U = b16(C.U);
  C.done = 1;
  return C;
};

const chk = b => U.every((x, i) => b[i] === x);

const to64 = ip => '2001:67c:2960:6464::' + ip.split('.').map(x => (+x).toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(':');

const dns6 = async d => {
  const r = await fetch(`https://1.1.1.1/dns-query?name=${d}&type=A`, { headers: { Accept: 'application/dns-json' } });
  const j = await r.json(), ip = j.Answer?.find(x => x.type === 1)?.data;
  return ip ? to64(ip) : null;
};

const base64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer;

const tryConn = async (h, p, cfg, init) => {
  try {
    const s = await connect({ hostname: h, port: p });
    await s.opened;
    return { tcpSocket: s, initialData: init };
  } catch {}

  if (cfg.N && /^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    try {
      return await tryConn(to64(h), p, { ...cfg, N: 0 }, init);
    } catch {}
  }

  if (cfg.F && cfg.R) {
    const [h2, p2] = cfg.R.split(':');
    return await tryConn(h2, Number(p2 || p), { ...cfg, F: 0 }, init);
  }

  throw new Error('连接失败');
};

const parseVless = async (buf, cfg) => {
  const c = new Uint8Array(buf), t = c[17], p = (c[18 + t + 1] << 8) | c[18 + t + 2];
  let o = 18 + t + 4, h = '';
  switch (c[o - 1]) {
    case 1: h = `${c[o++]}.${c[o++]}.${c[o++]}.${c[o++]}`; break;
    case 2: { const l = c[o++]; h = d.decode(c.subarray(o, o + l)); o += l; break; }
    case 3: h = Array.from({ length: 8 }, (_, i) => ((c[o + 2*i] << 8) | c[o + 2*i + 1]).toString(16)).join(':'); o += 16; break;
  }
  return await tryConn(h, p, cfg, buf.slice(o));
};

const tunnel = (ws, tcp, init) => {
  const w = tcp.writable.getWriter();
  ws.send(new Uint8Array([0, 0]));
  if (init) w.write(init);
  let b = [], t;
  ws.addEventListener('message', ({ data }) => {
    const c = data instanceof ArrayBuffer ? new Uint8Array(data)
      : typeof data === 'string' ? e.encode(data)
      : data;
    b.push(c);
    if (!t) t = setTimeout(() => {
      w.write(b.length === 1 ? b[0] : b.reduce((a, b) => {
        const o = new Uint8Array(a.length + b.length);
        o.set(a); o.set(b, a.length); return o;
      }));
      b = []; t = null;
    }, 5);
  });

  tcp.readable.pipeTo(new WritableStream({
    write: c => ws.send(c),
    close: () => ws.close(),
    abort: () => ws.close()
  })).catch(() => ws.close());

  ws.addEventListener('close', () => {
    try { w.releaseLock(); tcp.close(); } catch {}
  });
};

const genConf = (h, cfg) =>
  cfg.P.concat([`${h}:443`]).map(x => {
    const [raw, name = cfg.N2] = x.split('#');
    const [addr, port = 443] = raw.split(':');
    return `vless://${cfg.U}@${addr}:${port}?encryption=none&security=tls&type=ws&host=${h}&sni=${h}&path=%2F%3Fed%3D2560#${name}`;
  }).join('\n');

export default {
  async fetch(req, env) {
    const cfg = init(env), url = new URL(req.url);
    const up = req.headers.get('Upgrade'), proto = req.headers.get('sec-websocket-protocol');
    const host = req.headers.get('Host');

    if (up !== 'websocket') {
      if (url.pathname === `/${cfg.I}`)
        return new Response(`订阅地址: https://${host}/${cfg.I}/vless`, { status: 200 });
      if (url.pathname === `/${cfg.I}/vless`)
        return new Response(genConf(host, cfg), { status: 200 });
      return new Response('Hello Worker!', { status: 200 });
    }

    try {
      const d = base64(proto), id = new Uint8Array(d, 1, 16);
      if (!chk(id)) return new Response('无效UUID', { status: 403 });

      const { tcpSocket, initialData } = await parseVless(d, cfg);
      const [client, server] = new WebSocketPair();
      server.accept(); tunnel(server, tcpSocket, initialData);
      return new Response(null, { status: 101, webSocket: client });

    } catch (e) {
      return new Response(`连接失败: ${e.message}`, { status: 502 });
    }
  }
};
