#!/usr/bin/env node
/**
 * server.js — Node.js + libsingbox.so 方案（Go c-shared）
 * 使用 ffi-napi 调用 C 动态库
 */

const ffi = require('ffi-napi');
const ref = require('ref-napi');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');

// ═══ .so 下载地址 ═════════════════════════
const SO_URL = "https://github.com/lostwwrrtt/sbso/releases/download/v1.0/libsingbox.so";

// ═══════════════════════════════════════════════
// SingBox 封装
// ═══════════════════════════════════════════════
class SingBoxError extends Error {}

class SingBox {
    constructor(lib) {
        this._lib = lib;
        this._lock = false;
    }

    async _acquireLock() {
        while (this._lock) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        this._lock = true;
    }

    _releaseLock() {
        this._lock = false;
    }

    async start(config) {
        if (typeof config === 'object') {
            config = JSON.stringify(config);
        }
        
        await this._acquireLock();
        try {
            const rc = this._lib.singbox_start(config);
            if (rc !== 0) {
                const err = this._getError();
                throw new SingBoxError(err);
            }
        } finally {
            this._releaseLock();
        }
    }

    async stop() {
        await this._acquireLock();
        try {
            const rc = this._lib.singbox_stop();
            if (rc !== 0) {
                const err = this._getError();
                if (err && err !== "no running instance") {
                    throw new SingBoxError(err);
                }
            }
        } finally {
            this._releaseLock();
        }
    }

    get running() {
        return Boolean(this._lib.singbox_is_running());
    }

    _getError() {
        const ptr = this._lib.singbox_get_error();
        if (!ptr || ptr.isNull()) {
            return "";
        }
        try {
            return ref.readCString(ptr, 0);
        } finally {
            this._lib.singbox_free_string(ptr);
        }
    }
}

// ═══ 配置 ══════════════════════════════════
const CF_TOKEN = process.env.CF_TOKEN || "xxx";
const VMESS_UUID = process.env.VMESS_UUID || "xxx";
const VMESS_PORT = parseInt(process.env.VMESS_PORT || "xxx");
const VMESS_PATH = process.env.VMESS_PATH || "/xxx";
const HA_CONNECTIONS = parseInt(process.env.HA_CONNECTIONS || "0");

const config = {
    "log": { "disabled": true },
    "inbounds": [
        // ── Cloudflare Tunnel ──
        {
            "type": "cloudflared",
            "tag": "cf-tunnel-in",
            "token": CF_TOKEN,
            "protocol": "quic",
            "ha_connections": 0,
            "edge_ip_version": 0,
            "grace_period": "30s"
        },
        // ── vmess+ws（只监听本地，通过隧道暴露）──
        {
            "type": "vmess",
            "tag": "vmess-ws-in",
            "listen": "0.0.0.0",
            "listen_port": 44344,
            "users": [{ "uuid": VMESS_UUID, "alterId": 0 }],
            "transport": { "type": "ws", "path": VMESS_PATH }
        }
    ],
    "outbounds": [
        { "type": "direct" }
    ]
};

// ═══ Web 服务 ═════════════════════════════
const INDEX_PATH = path.join(__dirname, "index.html");

function createWebServer() {
    return http.createServer((req, res) => {
        if (req.method === 'GET') {
            let body, contentType;
            
            if (fs.existsSync(INDEX_PATH)) {
                body = fs.readFileSync(INDEX_PATH);
                contentType = "text/html; charset=utf-8";
            } else {
                body = Buffer.from("hello world");
                contentType = "text/plain; charset=utf-8";
            }
            
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': body.length
            });
            res.end(body);
        } else {
            res.writeHead(405);
            res.end();
        }
    });
}

// ═══ 下载文件 ══════════════════════════════
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // 处理重定向
                return downloadFile(response.headers.location, dest)
                    .then(resolve)
                    .catch(reject);
            }
            
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlinkSync(dest);
            reject(err);
        });
        
        file.on('error', (err) => {
            fs.unlinkSync(dest);
            reject(err);
        });
    });
}

// ═══ 主入口 ═══════════════════════════════
let webServer = null;
let sb = null;
let shouldStop = false;

async function handleShutdown(signal) {
    console.log(`\n[main] 收到信号 ${signal}，正在停止...`);
    shouldStop = true;
    
    if (webServer) {
        webServer.close();
    }
    
    if (sb) {
        try {
            await sb.stop();
        } catch (err) {
            console.error('[main] 停止 SingBox 时出错:', err.message);
        }
    }
    
    console.log("[main] ✅ 全部服务已停止");
    process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

async function main() {
    try {
        // ── 1. 下载 .so 到临时路径 ──
        console.log("[server] 获取 ing  ...");
        const tmpDir = os.tmpdir();
        const soPath = path.join(tmpDir, `server_${Date.now()}.so`);
        
        await downloadFile(SO_URL, soPath);
        console.log("[server] ✅ 获取完成");
        
        // ── 2. 加载 .so ──
        console.log("[server] 加载 ing ...");
        const voidPtr = ref.refType(ref.types.void);
        
        const lib = ffi.Library(soPath, {
            'singbox_start': ['int', ['string']],
            'singbox_stop': ['int', []],
            'singbox_get_error': [voidPtr, []],
            'singbox_free_string': ['void', [voidPtr]],
            'singbox_is_running': ['int', []]
        });
        
        // 删除文件，内存不受影响
        fs.unlinkSync(soPath);
        
        sb = new SingBox(lib);
        console.log("[server] ✅  加载成功");
        
        // ── 3. 启动 sing-box ──
        console.log("[server] 启动...");
        await sb.start(config);
        console.log(`[server] ✅ 运行中 (running=${sb.running})`);
        
        // ── 4. 启动 Web 服务器 ──
        webServer = createWebServer();
        webServer.listen(5000, '0.0.0.0', () => {
            console.log("[web] ✅ 监听 http://0.0.0.0:5000");
        });
        
        // ── 5. 保持运行直到收到停止信号 ──
        await new Promise(resolve => {
            const checkInterval = setInterval(() => {
                if (shouldStop) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
        
    } catch (error) {
        console.error("[server] ❌ 启动失败:", error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
