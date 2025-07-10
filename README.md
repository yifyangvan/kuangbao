---

## 🌐 Cloudflare Worker VLESS 中转服务说明文档

### 📌 项目简介

本项目是一个基于 **Cloudflare Workers** 的轻量级 VLESS 中转服务，支持 **UUID 校验**、**WebSocket 转发**、**VLESS 订阅地址生成**，并集成了 **NAT64 支持**、**反代 IP 回退机制**、**配置可定制化** 等功能。

适用于无法直连的环境，通过中转提升连接质量或规避封锁。

---

### 🚀 功能特性

* ✅ 支持 VLESS over WebSocket
* ✅ 支持 Cloudflare CDN 全局中转
* ✅ 多 IP 支持，可自定义订阅入口
* ✅ 自适应 NAT64 和备用反代地址
* ✅ 支持一键订阅链接生成
* ✅ 完整兼容原版 VLESS 客户端配置

---

## 🛠️ 使用部署指南

### 1. 创建 Worker

* 登录 Cloudflare → Workers & Pages → 创建 Worker
* 在编辑器中粘贴完整的配置脚本（见上方脚本）
* 点击 “Save and Deploy” 部署

### 2. 设置环境变量

点击 Worker → `Settings` → `Variables` → 添加以下变量（可选但推荐）：

| 变量名       | 类型   | 说明                           |
| --------- | ---- | ---------------------------- |
| `UUID`    | Text | 用于认证连接的唯一 UUID（必填）           |
| `ID`      | Text | 订阅地址路径标识，如 `123456`          |
| `IP`      | Text | 支持多个 IP（可换 IP），用换行分隔         |
| `我的节点名字`  | Text | 节点在订阅链接中展示的名称（默认：狂暴）         |
| `启用反代功能`  | Text | 设置为 `true` 开启备用反代 IP         |
| `PROXYIP` | Text | 备用反代 IP 和端口，如 `1.2.3.4:443`  |
| `NAT64`   | Text | 设置为 `true` 可自动尝试 IPv4 转 IPv6 |

示例：

```
UUID = d26432c5-a84b-47c3-aaf8-b949f326efb3
ID = 242222
IP = 104.16.160.145
我的节点名字 = 狂暴转发
启用反代功能 = true
PROXYIP = sjc.o00o.ooo:443
NAT64 = true
```

---

## 🔗 使用方式说明

### 客户端配置（V2RayN / v2rayNG / Clash.Meta）

* 协议：`vless`
* 地址：你部署的 Worker 地址（如 `xxx.workers.dev`）
* 端口：`443`
* UUID：你设置的 UUID
* 加密方式：`none`
* 传输方式：`ws`
* TLS：开启
* WebSocket 路径：`/?ed=2560`
* host/sni：同你的域名

### 订阅地址路径

| 访问路径        | 功能说明                  |
| ----------- | --------------------- |
| `/ID`       | 返回“订阅地址提示”页面          |
| `/ID/vless` | 生成 VLESS 订阅链接列表（多 IP） |

例如：

```text
https://your-worker-subdomain.workers.dev/242222/vless
```

---

## 🧪 在线测试

你可使用浏览器访问 `/ID` 和 `/ID/vless` 路径测试是否部署成功：

```
https://your-worker-subdomain.workers.dev/242222
https://your-worker-subdomain.workers.dev/242222/vless
```

如看到节点链接即表示部署成功。

---

## ❓常见问题（FAQ）

### 1. 连接失败怎么排查？

* UUID 错误 → 请确认客户端 UUID 与环境变量一致
* IP 被封 → 可更换 `IP` 配置中的地址
* 反代失败 → 检查 `PROXYIP` 是否能正常访问
* NAT64 无效 → 某些区域不支持 IPv6，可关闭 `NAT64`

### 2. 支持哪些客户端？

* ✅ v2rayN（Windows）
* ✅ v2rayNG / SagerNet（Android）
* ✅ Shadowrocket / Stash（iOS）
* ✅ Clash.Meta（全平台）

### 3. 多个用户如何使用？

可拓展为 **多 UUID 支持**，目前需部署多个 Worker 实例分别设置不同 UUID。

---

## 📦 附加说明

### 📁 自建订阅转换

若你不使用订阅转换服务（如 Sub-Converter），此脚本可直接生成标准 VLESS 链接。

也可将 `TXT` 变量设置为你的订阅 JSON 内容或自定义文本返回。

---

## 🧩 高级拓展建议

* ✅ 多 UUID 多用户支持
* ✅ Fallback 路由分流机制
* ✅ WARP / SOCKS5 出口集成
* ✅ 自定义路径 & Anti-Replay 支持

如需定制功能，可基于该框架继续扩展。

---

## 📮 联系 & 反馈

如需协助调试、优化或部署脚本支持更多功能，可直接联系维护者或提交 Issue。

---
