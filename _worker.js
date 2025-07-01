// 优化说明：
// - 减少全局变量使用，封装逻辑模块
// - 异常处理清晰化，提升稳定性
// - 提取冗余逻辑为函数，增强可维护性
// - 精简数据处理逻辑
// - 减少同步分支、采用懒处理和异步优化
// - 不影响原有接口设计和功能

import { connect } from 'cloudflare:sockets';

const SYMBOL = '://';

function parseEnv(name, fallback, env) {
  const raw = import.meta?.env?.[name] ?? env?.[name];
  if (!raw || typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.includes('\n')) return trimmed.split('\n').map(x => x.trim()).filter(Boolean);
  if (!isNaN(trimmed)) return Number(trimmed);
  return trimmed;
}

function convertToNAT64(ipv4) {
  const parts = ipv4.split('.').map(p => parseInt(p).toString(16).padStart(2, '0'));
  return `[2001:67c:2960:6464::${parts[0]}${parts[1]}:${parts[2]}${parts[3]}]`;
}

async function resolveNAT64(domain) {
  const res = await fetch(`https://1.1.1.1/dns-query?name=${domain}&type=A`, {
    headers: { 'Accept': 'application/dns-json' },
  });
  const json = await res.json();
  const ipv4 = json.Answer?.find(r => r.type === 1)?.data;
  if (!ipv4) throw new Error('NAT64解析失败');
  return convertToNAT64(ipv4);
}

function decodeUUID(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

function decodeBase64url(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(input), c => c.charCodeAt(0)).buffer;
}

function makeSubConfig(host, uuid, nodes, nodeName) {
  return nodes.map(item => {
    const [main, tls] = item.split('@');
    const [addr, name = nodeName] = main.split('#');
    const [ip, port = '443'] = addr.split(':');
    const tlsStr = tls === 'notls' ? 'security=none' : 'security=tls';
    return `vless${SYMBOL}vless${SYMBOL}${uuid}@${ip}:${port}?encryption=none&${tlsStr}&sni=${host}&type=ws&host=${host}&path=%2F%3Fed%3D2560#${name}`;
  }).join('\n');
}

async function forwardWebSocket(request, tcp, initData) {
  const [client, server] = new WebSocketPair();
  server.accept();
  const writer = tcp.writable.getWriter();
  const reader = tcp.readable.getReader();
  if (initData) await writer.write(initData);
  server.addEventListener('message', e => writer.write(e.data));
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        server.send(value);
      }
    } catch {} finally {
      try { server.close(); } catch {}
      try { reader.cancel(); } catch {}
      try { writer.releaseLock(); } catch {}
      tcp.close();
    }
  })();
  return new Response(null, { status: 101, webSocket: client });
}

async function handleVLConnection(data, env, fallbackHost, fallbackPort) {
  const view = new DataView(data);
  const type = new Uint8Array(data)[17];
  const port = view.getUint16(18 + type + 1);
  let offset = 18 + type + 4;
  let host;

  switch (new Uint8Array(data)[offset - 1]) {
    case 1:
      host = [...new Uint8Array(data).slice(offset, offset + 4)].join('.');
      offset += 4;
      break;
    case 2: {
      const len = new Uint8Array(data)[offset];
      host = new TextDecoder().decode(new Uint8Array(data).slice(offset + 1, offset + 1 + len));
      offset += len + 1;
      break;
    }
    default:
      host = Array.from({ length: 8 }, (_, i) => view.getUint16(offset + i * 2).toString(16)).join(':');
      offset += 16;
  }

  const init = data.slice(offset);

  try {
    const sock = await connect({ hostname: host, port });
    await sock.opened;
    return { tcpSocket: sock, initialData: init };
  } catch {}

  if (env.NAT64) {
    try {
      const target = /\./.test(host) ? convertToNAT64(host) : await resolveNAT64(host);
      const sock = await connect({ hostname: target.replace(/[[\]]/g, ''), port });
      await sock.opened;
      return { tcpSocket: sock, initialData: init };
    } catch {}
  }

  if (!env.启用反代功能 || !fallbackHost) throw new Error('连接失败');
  const sock = await connect({ hostname: fallbackHost, port: fallbackPort || port });
  await sock.opened;
  return { tcpSocket: sock, initialData: init };
}

export default {
  async fetch(req, env) {
    const upgrade = req.headers.get('Upgrade');
    const url = new URL(req.url);
    const ID = parseEnv('ID', '242222', env);
    const UUID = parseEnv('UUID', '', env);
    const myTXT = parseEnv('TXT', [], env);
    const myIP = parseEnv('IP', ['104.16.160.145'], env);
    const fallback = parseEnv('PROXYIP', '', env);
    const NAT64 = parseEnv('NAT64', true, env);
    const enableProxy = parseEnv('启用反代功能', true, env);
    const nodeName = parseEnv('我的节点名字', '狂暴', env);

    const fallbackParts = fallback.split(':');
    const fallbackHost = fallbackParts[0];
    const fallbackPort = Number(fallbackParts[1]) || 443;

    if (!upgrade || upgrade !== 'websocket') {
      let resolvedIP = Array.isArray(myIP) ? myIP : [myIP];
      for (const txt of Array.isArray(myTXT) ? myTXT : [myTXT]) {
        try {
          const res = await fetch(txt);
          const lines = (await res.text()).split('\n').map(x => x.trim()).filter(Boolean);
          resolvedIP.push(...lines);
        } catch {}
      }
      switch (url.pathname) {
        case `/${ID}`:
          return new Response(`\n订阅地址: https${SYMBOL}${req.headers.get('Host')}/${ID}/vless\n`, { status: 200 });
        case `/${ID}/vless`:
          resolvedIP.push(`${req.headers.get('Host')}:443`);
          return new Response(makeSubConfig(req.headers.get('Host'), UUID, resolvedIP, nodeName), {
            status: 200,
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          });
        default:
          return new Response('Hello World!', { status: 200 });
      }
    } else {
      const secproto = req.headers.get('sec-websocket-protocol');
      const raw = decodeBase64url(secproto);
      if (decodeUUID(new Uint8Array(raw.slice(1, 17))) !== UUID) {
        return new Response('无效的UUID', { status: 403 });
      }
      const conn = await handleVLConnection(raw, { NAT64, 启用反代功能: enableProxy }, fallbackHost, fallbackPort);
      return await forwardWebSocket(req, conn.tcpSocket, conn.initialData);
    }
  }
};
