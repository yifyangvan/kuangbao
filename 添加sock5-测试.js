import { connect } from 'cloudflare:sockets';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

let UUID_BYTES_CACHE = null;
const DNS_CACHE = new Map();
const ENV_CACHE = {};

function 读取环境变量(name, fallback, env) {
  const raw = import.meta?.env?.[name] ?? env?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed.includes('\n')) return trimmed.split('\n').map(s => s.trim()).filter(Boolean);
    if (!isNaN(trimmed)) return Number(trimmed);
    return trimmed;
  }
  return raw;
}

function 初始化配置(env) {
  if (ENV_CACHE.done) return ENV_CACHE;
  ENV_CACHE.ID = 读取环境变量('ID', '242222', env);
  ENV_CACHE.UUID = 读取环境变量('UUID', 'd26432c5-a84b-47c3-aaf8-b949f326efb3', env);
  ENV_CACHE.UUID_BYTES = UUID_BYTES_CACHE = uuidStringToBytes(ENV_CACHE.UUID);
  ENV_CACHE.IP = 读取环境变量('IP', ['104.16.160.145'], env);
  ENV_CACHE.TXT = 读取环境变量('TXT', [], env);
  ENV_CACHE.PROXYIP = 读取环境变量('PROXYIP', 'sjc.o00o.ooo:443', env);
  ENV_CACHE.启用反代功能 = 读取环境变量('启用反代功能', true, env);
  ENV_CACHE.NAT64 = 读取环境变量('NAT64', false, env);
  ENV_CACHE.我的节点名字 = 读取环境变量('我的节点名字', '狂暴', env);
  ENV_CACHE.SOCKS5 = 读取环境变量('SOCKS5', '', env);
  ENV_CACHE.done = true;
  return ENV_CACHE;
}

function uuidStringToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function 验证UUID字节等价(buf16) {
  const ref = UUID_BYTES_CACHE;
  for (let i = 0; i < 16; i++) {
    if (buf16[i] !== ref[i]) return false;
  }
  return true;
}

function convertToNAT64IPv6(ipv4) {
  const parts = ipv4.split('.');
  const hex = parts.map(p => Number(p).toString(16).padStart(2, '0'));
  return `2001:67c:2960:6464::${hex[0]}${hex[1]}:${hex[2]}${hex[3]}`;
}

async function getIPv6ProxyAddress(domain) {
  if (DNS_CACHE.has(domain)) return DNS_CACHE.get(domain);
  const r = await fetch(`https://1.1.1.1/dns-query?name=${domain}&type=A`, {
    headers: { 'Accept': 'application/dns-json' }
  });
  const j = await r.json();
  const a = j.Answer?.find(x => x.type === 1);
  if (!a) throw new Error('无法解析IPv4地址');
  const ip6 = convertToNAT64IPv6(a.data);
  DNS_CACHE.set(domain, ip6);
  return ip6;
}

function atobUrlSafe(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
}

export default {
  async fetch(req, env) {
    const cfg = 初始化配置(env);
    const upgrade = req.headers.get('Upgrade');
    const url = new URL(req.url);

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

    const enc = req.headers.get('sec-websocket-protocol');
    const data = atobUrlSafe(enc);
    const uuid = new Uint8Array(data, 1, 16);
    if (!验证UUID字节等价(uuid)) return new Response('无效的UUID', { status: 403 });

    try {
      const { tcpSocket, initialData } = await 解析VL标头(data, cfg);
      const [client, server] = new WebSocketPair();
      server.accept();
      传输数据管道(server, tcpSocket, initialData);
      return new Response(null, { status: 101, webSocket: client });
    } catch (e) {
      return new Response(`连接目标失败: ${e.message}`, { status: 502 });
    }
  }
};

async function 解析VL标头(buf, cfg) {
  const c = new Uint8Array(buf);
  const atype = c[17];
  const port = (c[18 + atype + 1] << 8) | c[18 + atype + 2];
  let offset = 18 + atype + 4;
  let host = '';

  switch (c[offset - 1]) {
    case 1: host = `${c[offset++]}.${c[offset++]}.${c[offset++]}.${c[offset++]}`; break;
    case 2: {
      const len = c[offset++];
      host = decoder.decode(c.subarray(offset, offset + len));
      offset += len;
    } break;
    case 3: {
      host = Array(8).fill(0).map((_, i) =>
        ((c[offset + 2*i] << 8) | c[offset + 2*i + 1]).toString(16)
      ).join(':');
      offset += 16;
    } break;
  }

  const initialData = buf.slice(offset);

  if (cfg.SOCKS5) {
    const [proxyHost, proxyPort] = cfg.SOCKS5.split(':');
    const tcp = await connect({ hostname: proxyHost, port: Number(proxyPort) });
    await tcp.opened;
    const writer = tcp.writable.getWriter();
    const reader = tcp.readable.getReader();

    await writer.write(new Uint8Array([0x05, 0x01, 0x00]));
    const res1 = await reader.read();
    if (res1.value?.[1] !== 0x00) throw new Error("SOCKS5 不支持无认证模式");

    const hostBuf = encoder.encode(host);
    const req = new Uint8Array(7 + hostBuf.length);
    req.set([0x05, 0x01, 0x00, 0x03, hostBuf.length]);
    req.set(hostBuf, 5);
    req.set([(port >> 8) & 0xff, port & 0xff], 5 + hostBuf.length);
    await writer.write(req);

    const res2 = await reader.read();
    if (res2.value?.[1] !== 0x00) throw new Error("SOCKS5 连接失败");

    return { tcpSocket: tcp, initialData };
  }

  try {
    const sock = await connect({ hostname: host, port });
    await sock.opened;
    return { tcpSocket: sock, initialData };
  } catch {}

  if (cfg.NAT64) {
    try {
      const target = /^\d+\.\d+\.\d+\.\d+$/.test(host)
        ? convertToNAT64IPv6(host)
        : host.includes(':') ? null : await getIPv6ProxyAddress(host);
      if (!target) throw new Error('IPv6 地址无需 NAT64');
      const sock = await connect({ hostname: target.replace(/\[|\]/g, ''), port });
      await sock.opened;
      return { tcpSocket: sock, initialData };
    } catch {}
  }

  if (cfg.启用反代功能 && cfg.PROXYIP) {
    const [h, p] = cfg.PROXYIP.split(':');
    const proxyPort = Number(p || port);
    const sock = await connect({ hostname: h, port: proxyPort });
    await sock.opened;
    return { tcpSocket: sock, initialData };
  }

  throw new Error('目标连接失败');
}

function 传输数据管道(ws, tcp, init) {
  const writer = tcp.writable.getWriter();
  ws.send(new Uint8Array([0, 0]));
  if (init) writer.write(init);

  let buffer = [];
  let flushTimer = null;
  const flush = () => {
    if (buffer.length === 0) return;
    const total = buffer.reduce((acc, chunk) => acc + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of buffer) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    writer.write(merged);
    buffer = [];
    flushTimer = null;
  };

  ws.addEventListener('message', evt => {
    let chunk = evt.data;
    if (chunk instanceof ArrayBuffer) {
      chunk = new Uint8Array(chunk);
    } else if (typeof chunk === 'string') {
      chunk = encoder.encode(chunk);
    }
    buffer.push(chunk);
    if (!flushTimer) flushTimer = setTimeout(flush, 5);
  });

  tcp.readable.pipeTo(new WritableStream({
    write(chunk) { ws.send(chunk); },
    close() { try { ws.close(); } catch {} },
    abort() { try { ws.close(); } catch {} }
  })).catch(() => { try { ws.close(); } catch {} });

  ws.addEventListener('close', () => {
    try { writer.releaseLock(); } catch {}
    try { tcp.close(); } catch {}
  });
}

function 生成配置文件(host, cfg) {
  const list = cfg.IP.concat([`${host}:443`]);
  return list.map(ip => {
    const [part, name = cfg.我的节点名字] = ip.split('#');
    const [addr, port = 443] = part.split(':');
    return `vless://${cfg.UUID}@${addr}:${port}?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=%2F%3Fed%3D2560#${name}`;
  }).join('\n');
}
