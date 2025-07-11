import { connect } from 'cloudflare:sockets';

const dec = new TextDecoder(),
  enc = new TextEncoder();

let ENV = null,
  failCache = new Map(),
  failCacheMax = 500,
  failCacheTTL = 3e5, // 5分钟

uuid2arr = (u) => {
  const h = u.replace(/-/g, '');
  let r = new Uint8Array(16);
  for (let i = 0; i < 16; i++) r[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return r;
},
eqArr = (a, b) => {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return 0;
  return 1;
},
atobUrlSafe = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  let b = atob(s),
    u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
},
readEnv = (k, def, env) => {
  let v = import.meta.env?.[k] ?? env?.[k];
  if (v == null || v === '') return def;
  if (typeof v === 'string') {
    let t = v.trim();
    if (t === 'true') return !0;
    if (t === 'false') return !1;
    if (t.includes('\n'))
      return t
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    if (!isNaN(t)) return Number(t);
    return t;
  }
  return v;
},
initCfg = (env) => {
  if (ENV) return ENV;
  ENV = {
    ID: readEnv('ID', '242222', env),
    UUID: readEnv('UUID', 'd26432c5-a84b-47c3-aaf8-b949f326efb3', env),
    IP: readEnv('IP', ['104.16.160.145'], env),
    TXT: readEnv('TXT', [], env),
    PROXYIP: readEnv('PROXYIP', 'sjc.o00o.ooo:443', env),
    REVERSE: readEnv('启用反代功能', !0, env),
    NAT64: readEnv('NAT64', !1, env),
    NAME: readEnv('我的节点名字', '狂暴', env),
  };
  ENV.uuidB = uuid2arr(ENV.UUID);
  return ENV;
},
cleanFailCache = () => {
  let now = Date.now();
  for (let [k, v] of failCache) if (v.expire < now) failCache.delete(k);
},
convNAT64 = (ip) => {
  let p = ip.split('.').map((x) => Number(x).toString(16).padStart(2, '0'));
  return `2001:67c:2960:6464::${p[0]}${p[1]}:${p[2]}${p[3]}`;
},
getIPv6 = async (d) => {
  let r = await fetch(`https://1.1.1.1/dns-query?name=${d}&type=A`, { headers: { Accept: 'application/dns-json' } });
  let j = await r.json();
  let a = j.Answer?.find((x) => x.type === 1);
  if (!a) throw '解析失败';
  return convNAT64(a.data);
},
mkCfgFile = (host, c) =>
  c.IP.concat([host + ':443'])
    .map((ip) => {
      let [m, t] = ip.split('@'),
        [addr, nm = c.NAME] = m.split('#'),
        ps = addr.split(':'),
        pt = Number(ps.length > 1 ? ps.pop() : 443),
        ad = ps.join(':'),
        tls = t === 'notls' ? 'security=none' : 'security=tls';
      return `vless://${c.UUID}@${ad}:${pt}?encryption=none&${tls}&sni=${host}&type=ws&host=${host}&path=%2F%3Fed%3D2560#${nm}`;
    })
    .join('\n'),
clearRes = (ws, w, t) => {
  try { ws?.close(); } catch {}
  try { w?.releaseLock(); } catch {}
  try { t?.close(); } catch {}
},
mergeU8A = (arrs) => {
  if (arrs.length === 1) return arrs[0];
  let l = arrs.reduce((a, b) => a + b.length, 0),
    r = new Uint8Array(l),
    o = 0;
  for (let a of arrs) {
    r.set(a, o);
    o += a.length;
  }
  return r;
},
pipeData = async (ws, tcp, init) => {
  const w = tcp.writable.getWriter();
  ws.send(new Uint8Array([0, 0]));
  if (init) await w.write(new Uint8Array(init));

  const abort = new AbortController();
  const to = setTimeout(() => abort.abort(), 15e3);

  tcp.readable.pipeTo(
    new WritableStream({
      write(c) { ws.send(c); },
      close() { clearRes(ws, w, tcp); },
      abort() { clearRes(ws, w, tcp); },
    }),
    { signal: abort.signal }
  ).catch(() => clearRes(ws, w, tcp)).finally(() => clearTimeout(to));

  let buf = [],
    writing = 0;
  function flush() {
    if (writing) return;
    writing = 1;
    queueMicrotask(async () => {
      let d = mergeU8A(buf);
      buf = [];
      try {
        await w.write(d);
      } catch { clearRes(ws, w, tcp); }
      writing = 0;
    });
  }
  ws.addEventListener('message', (e) => {
    let d = e.data;
    if (typeof d === 'string') d = enc.encode(d);
    else if (d instanceof Blob) d = new Uint8Array(d.arrayBuffer());
    else if (d instanceof ArrayBuffer) d = new Uint8Array(d);
    buf.push(d);
    flush();
  });
  ws.addEventListener('close', () => clearRes(ws, w, tcp));
},
parseVLHead = async (buf, c) => {
  let b = new Uint8Array(buf),
    t = b[17],
    port = (b[18 + t + 1] << 8) | b[18 + t + 2],
    off = 18 + t + 4,
    host;

  switch (b[off - 1]) {
    case 1:
      host = `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`;
      off += 4;
      break;
    case 2:
      let l = b[off];
      host = dec.decode(b.subarray(off + 1, off + 1 + l));
      off += l + 1;
      break;
    default:
      host = Array(8).fill(0).map((_, i) => ((b[off + 2 * i] << 8) | b[off + 2 * i + 1]).toString(16)).join(':');
      off += 16;
  }

  const initData = buf.byteLength > off ? buf.slice(off) : null;
  const cacheKey = host + ':' + port;
  cleanFailCache();
  if (failCache.has(cacheKey)) throw '缓存连接失败';

  let conns = [
    async () => {
      let sock = await connect({ hostname: host, port });
      await sock.opened;
      return { sock, initData };
    },
  ];

  if (c.NAT64 || c.REVERSE) {
    conns.push(async () => {
      if (host.includes('.') && !host.includes(':')) {
        let n6 = convNAT64(host);
        let sock = await connect({ hostname: n6.replace(/\[|\]/g, ''), port });
        await sock.opened;
        return { sock, initData };
      }
      throw 'NAT64不适用';
    });
    if (c.PROXYIP) {
      conns.push(async () => {
        let [h, p] = c.PROXYIP.split(':');
        let sock = await connect({ hostname: h, port: Number(p) || port });
        await sock.opened;
        return { sock, initData };
      });
    }
  }

  try {
    let { sock, initData: d } = await Promise.any(conns.map((f) => f()));
    return { tcpSocket: sock, initialData: d };
  } catch {
    if (failCache.size >= failCacheMax) failCache.delete(failCache.keys().next().value);
    failCache.set(cacheKey, { expire: Date.now() + failCacheTTL });
    throw '连接失败';
  }
};

export default {
  async fetch(req, env) {
    const c = initCfg(env);
    const up = req.headers.get('Upgrade'),
      url = new URL(req.url);

    if (up !== 'websocket') {
      const host = req.headers.get('Host');
      if (url.pathname === `/${c.ID}`)
        return new Response(`订阅地址: https://${host}/${c.ID}/vless`, { status: 200, headers: { 'content-type': 'text/plain' } });
      if (url.pathname === `/${c.ID}/vless`)
        return new Response(mkCfgFile(host, c), { status: 200, headers: { 'content-type': 'text/plain' } });
      return new Response('Hello World!', { status: 200 });
    }

    const proto = req.headers.get('sec-websocket-protocol');
    if (!proto || proto.length < 24) return new Response('协议错误', { status: 400 });
    let data;
    try { data = atobUrlSafe(proto); } catch { return new Response('协议解码失败', { status: 400 }); }
    if (!eqArr(data.subarray(1, 17), c.uuidB)) return new Response('UUID不匹配', { status: 403 });

    try {
      const { tcpSocket, initialData } = await parseVLHead(data.buffer, c);
      const [client, server] = new WebSocketPair();
      server.accept();
      pipeData(server, tcpSocket, initialData);
      return new Response(null, { status: 101, webSocket: client });
    } catch (e) {
      return new Response(e.toString(), { status: 500 });
    }
  },
};
