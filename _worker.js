import { connect } from 'cloudflare:sockets';

const decoder = new TextDecoder(), encoder = new TextEncoder();
let UUID_BYTES_CACHE = null;
const ENV_CACHE = {};

function 读取环境变量(name, fallback, env) {
  const val = import.meta?.env?.[name] ?? env?.[name];
  if (!val) return fallback;
  if (typeof val !== 'string') return val;

  const trimmed = val.trim();
  switch (trimmed) {
    case 'true': return true;
    case 'false': return false;
  }
  if (trimmed.includes('\n')) return trimmed.split('\n').map(x => x.trim()).filter(Boolean);
  const num = Number(trimmed);
  return isNaN(num) ? trimmed : num;
}

function uuidStringToBytes(uuid) {
  return Uint8Array.from(uuid.replace(/-/g, '').match(/.{2}/g).map(h => parseInt(h, 16)));
}

function 初始化配置(env) {
  if (ENV_CACHE.done) return ENV_CACHE;
  const map = {
    ID: ['ID', '123456'],
    UUID: ['UUID', '5aba5b77-48eb-4ae2-b60d-5bfee7ac169e'],
    IP: ['IP', ['104.16.160.145']],
    TXT: ['TXT', []],
    PROXYIP: ['PROXYIP', 'sjc.o00o.ooo:443'],
    启用反代功能: ['启用反代功能', true],
    NAT64: ['NAT64', false],
    我的节点名字: ['我的节点名字', '狂暴'],
  };
  for (const [key, [k, def]] of Object.entries(map)) {
    ENV_CACHE[key] = 读取环境变量(k, def, env);
  }
  ENV_CACHE.UUID_BYTES = UUID_BYTES_CACHE = uuidStringToBytes(ENV_CACHE.UUID);
  ENV_CACHE.done = true;
  return ENV_CACHE;
}

function 验证UUID字节(buf) {
  return UUID_BYTES_CACHE.every((b, i) => buf[i] === b);
}

function convertToNAT64IPv6(ipv4) {
  return '2001:67c:2960:6464::' + ipv4.split('.').map(x => (+x).toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(':');
}

async function 解析IPv6(domain) {
  const res = await fetch(`https://1.1.1.1/dns-query?name=${domain}&type=A`, {
    headers: { Accept: 'application/dns-json' }
  });
  const data = await res.json();
  const ip = data.Answer?.find(x => x.type === 1)?.data;
  return ip ? convertToNAT64IPv6(ip) : null;
}

function base64urlToBytes(str) {
  return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer;
}

async function 尝试连接目标(host, port, cfg, init) {
  try {
    const s = await connect({ hostname: host, port });
    await s.opened;
    return { tcpSocket: s, initialData: init };
  } catch {}

  if (cfg.NAT64 && /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    try {
      const ip6 = convertToNAT64IPv6(host);
      return await 尝试连接目标(ip6, port, { ...cfg, NAT64: false }, init);
    } catch {}
  }

  if (cfg.启用反代功能 && cfg.PROXYIP) {
    const [h, p] = cfg.PROXYIP.split(':');
    return await 尝试连接目标(h, Number(p || port), { ...cfg, 启用反代功能: false }, init);
  }

  throw new Error('连接目标失败');
}

async function 解析VL标头(buf, cfg) {
  const c = new Uint8Array(buf);
  const atype = c[17];
  const port = (c[18 + atype + 1] << 8) | c[18 + atype + 2];
  let offset = 18 + atype + 4;
  let host = '';

  switch (c[offset - 1]) {
    case 1:
      host = `${c[offset++]}.${c[offset++]}.${c[offset++]}.${c[offset++]}`;
      break;
    case 2: {
      const len = c[offset++];
      host = decoder.decode(c.subarray(offset, offset + len));
      offset += len;
      break;
    }
    case 3:
      host = Array.from({ length: 8 }, (_, i) =>
        ((c[offset + 2*i] << 8) | c[offset + 2*i + 1]).toString(16)
      ).join(':');
      offset += 16;
      break;
  }

  const initData = buf.slice(offset);
  return await 尝试连接目标(host, port, cfg, initData);
}

function 建立数据通道(ws, tcp, init) {
  const writer = tcp.writable.getWriter();
  ws.send(new Uint8Array([0, 0]));
  if (init) writer.write(init);

  let buf = [], timer;
  ws.addEventListener('message', ({ data }) => {
    const chunk = data instanceof ArrayBuffer ? new Uint8Array(data)
      : typeof data === 'string' ? encoder.encode(data)
      : data;
    buf.push(chunk);
    if (!timer) timer = setTimeout(() => {
      writer.write(buf.length === 1 ? buf[0] :
        buf.reduce((a, b) => {
          const o = new Uint8Array(a.length + b.length);
          o.set(a); o.set(b, a.length); return o;
        }));
      buf = []; timer = null;
    }, 5);
  });

  tcp.readable.pipeTo(new WritableStream({
    write: chunk => ws.send(chunk),
    close: () => ws.close(),
    abort: () => ws.close()
  })).catch(() => ws.close());

  ws.addEventListener('close', () => {
    try { writer.releaseLock(); tcp.close(); } catch {}
  });
}

function 生成配置文件(host, cfg) {
  return cfg.IP.concat([`${host}:443`]).map(entry => {
    const [raw, name = cfg.我的节点名字] = entry.split('#');
    const [addr, port = 443] = raw.split(':');
    return `vless://${cfg.UUID}@${addr}:${port}?encryption=none&security=tls&type=ws&host=${host}&sni=${host}&path=%2F%3Fed%3D2560#${name}`;
  }).join('\n');
}

export default {
  async fetch(req, env) {
    const cfg = 初始化配置(env);
    const url = new URL(req.url);
    const upgrade = req.headers.get('Upgrade');
    const encoded = req.headers.get('sec-websocket-protocol');

    if (upgrade !== 'websocket') {
      const host = req.headers.get('Host');
      if (url.pathname === `/${cfg.ID}`) {
        return new Response(`订阅地址: https://${host}/${cfg.ID}/vless`, {
          status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
      }
      if (url.pathname === `/${cfg.ID}/vless`) {
        return new Response(生成配置文件(host, cfg), {
          status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
      }
      return new Response('Hello Worker!', { status: 200 });
    }

    try {
      const data = base64urlToBytes(encoded);
      const uuid = new Uint8Array(data, 1, 16);
      if (!验证UUID字节(uuid)) return new Response('无效UUID', { status: 403 });

      const { tcpSocket, initialData } = await 解析VL标头(data, cfg);
      const [client, server] = new WebSocketPair();
      server.accept();
      建立数据通道(server, tcpSocket, initialData);
      return new Response(null, { status: 101, webSocket: client });

    } catch (e) {
      return new Response(`连接失败: ${e.message}`, { status: 502 });
    }
  }
};
