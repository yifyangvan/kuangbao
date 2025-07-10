---

# 🚀 Cloudflare Workers TCP 中继部署指南

本项目基于 **Cloudflare Workers** 实现 **TCP over WebSocket** 中继，适用于构建高性能、可部署在边缘节点的代理通道。

> 📦 本项目由「天书狂暴版」优化修改而来，无需配置额外的 Cloudflare 环境变量，开箱即用。

---

## ✅ 部署前准备

| 项目            | 说明                                             |
| ------------- | ---------------------------------------------- |
| Cloudflare 账号 | 注册并登录 [cloudflare.com](https://cloudflare.com) |
| 自有域名          | 已绑定至 Cloudflare（或使用 Workers.dev 测试域）           |

---

## ⚙️ 快速部署步骤

1. **Fork本项目**
2. **Pages部署**

---

## 🌐 服务接口说明

### 📥 订阅地址

用于获取客户端订阅链接：

```
https://你的域名/${ID}
```

示例：

```
https://example.pages.dev/111111
```
