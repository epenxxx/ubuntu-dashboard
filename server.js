const express = require('express');
const { exec } = require('child_process');
const os = require('os');
const util = require('util');
const path = require('path');
const session = require('express-session');

const execPromise = async (cmd) => {
    return await util.promisify(exec)(cmd, { timeout: 10000 });
};

// Background Cache Memory
let cachedCpu = "0.0";
let cachedIGpu = "0.0";
let lastNetwork = { rx: 0, tx: 0, time: Date.now() };
let cachedNetSpeed = { down: "0.0 KB/s", up: "0.0 KB/s" };

const app = express();
const PORT = 80;
const nsenter = "nsenter -t 1 -m -u -n -p"; 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'premium_secret',
    resave: false, saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const requireLogin = (req, res, next) => {
    if (req.session && req.session.isAdmin) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sesi habis' });
    res.redirect('/login');
};

// BACKGROUND WORKER: Menghitung CPU, iGPU, & Jaringan secara berkala agar API instan (Anti-Hang)
setInterval(async () => {
    // 1. Kalkulasi CPU Usage
    try {
        const first = os.cpus();
        setTimeout(async () => {
            const second = os.cpus();
            let totalDiff = 0, idleDiff = 0;
            for (let i = 0; i < first.length; i++) {
                totalDiff += Object.values(second[i].times).reduce((a, b) => a + b, 0) - Object.values(first[i].times).reduce((a, b) => a + b, 0);
                idleDiff += second[i].times.idle - first[i].times.idle;
            }
            cachedCpu = totalDiff === 0 ? "0.0" : (((totalDiff - idleDiff) / totalDiff) * 100).toFixed(1);
        }, 200);
    } catch(e) {}

    // 2. Kalkulasi iGPU Usage (Mendukung AMD & Intel)
    try {
        // Metode A: Cek AMD / Generic Sysfs (Instan)
        const { stdout: amdOut } = await execPromise(`${nsenter} cat /sys/class/drm/card0/device/gpu_busy_percent`);
        cachedIGpu = parseFloat(amdOut.trim()).toFixed(1);
    } catch(e) {
        try {
            // Metode B: Cek Intel iGPU menggunakan intel_gpu_top dalam mode JSON
            const { stdout: intelOut } = await execPromise(`${nsenter} timeout 1 intel_gpu_top -J -s 1 -n 1`);
            const data = JSON.parse(intelOut);
            if (data && data.engines && data.engines["Render/3D"]) {
                cachedIGpu = parseFloat(data.engines["Render/3D"].busy).toFixed(1);
            } else {
                cachedIGpu = "0.0";
            }
        } catch(err) {
            cachedIGpu = "0.0"; // Default jika tidak ada aktivitas / device tidak terpasang
        }
    }

    // 3. Kalkulasi Lalu Lintas Jaringan
    try {
        const { stdout: netOut } = await execPromise(`${nsenter} cat /proc/net/dev`);
        let currentRx = 0, currentTx = 0;
        netOut.split('\n').forEach(line => {
            if (line.includes(':')) {
                const p = line.trim().split(/\s+/);
                if (!p[0].startsWith('lo')) {
                    currentRx += parseInt(p[1]) || 0;
                    currentTx += parseInt(p[9]) || 0;
                }
            }
        });
        const now = Date.now();
        const timeDiff = (now - lastNetwork.time) / 1000;
        if (lastNetwork.rx > 0 && timeDiff > 0) {
            const downBps = (currentRx - lastNetwork.rx) / timeDiff;
            const upBps = (currentTx - lastNetwork.tx) / timeDiff;
            cachedNetSpeed.down = downBps > 1048576 ? (downBps / 1048576).toFixed(1) + " MB/s" : (downBps / 1024).toFixed(1) + " KB/s";
            cachedNetSpeed.up = upBps > 1048576 ? (upBps / 1048576).toFixed(1) + " MB/s" : (upBps / 1024).toFixed(1) + " KB/s";
        }
        lastNetwork = { rx: currentRx, tx: currentTx, time: now };
    } catch(e) {}
}, 3000);

// Routing Tampilan
app.get('/login', (req, res) => {
    if (req.session.isAdmin) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});
app.post('/login', (req, res) => {
    if (req.body.username === (process.env.ADMIN_USER || 'zylve') && req.body.password === (process.env.ADMIN_PASS || '26082014')) { 
        req.session.isAdmin = true; res.redirect('/'); 
    } else { res.redirect('/login?error=1'); }
});
app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });
app.get('/', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));

// API Utama (Menyuplai data super cepat dari cache)
app.get('/api/stats', requireLogin, async (req, res) => {
    let stats = { 
        hostname: os.hostname(), platform: os.platform(), release: os.release(), uptime: os.uptime(),
        memory: null, cpuUsage: cachedCpu, igpuUsage: cachedIGpu, storage: { ssd: null, hdd: null }, network: cachedNetSpeed
    };
    try {
        const tMem = os.totalmem(), fMem = os.freemem(), uMem = tMem - fMem;
        stats.memory = { total: (tMem/1048576).toFixed(0), used: (uMem/1048576).toFixed(0), percentage: ((uMem/tMem)*100).toFixed(1) };
    } catch(e) {}
    try {
        const { stdout } = await execPromise(`${nsenter} df -k`);
        const lines = stdout.split('\n');
        let ssd = { total: 0, used: 0, percentage: 0 }, hdd = { total: 0, used: 0, percentage: 0 };
        for (let line of lines) {
            const p = line.trim().split(/\s+/);
            if (p.length >= 6) {
                if (p[5] === '/') { ssd.total = (p[1]/1048576).toFixed(1); ssd.used = (p[2]/1048576).toFixed(1); ssd.percentage = parseInt(p[4]); }
                else if (p[5] === '/mnt/HDD') { hdd.total = (p[1]/1048576).toFixed(1); hdd.used = (p[2]/1048576).toFixed(1); hdd.percentage = parseInt(p[4]); }
            }
        }
        stats.storage = { ssd: ssd.total ? ssd : null, hdd: hdd.total ? hdd : null };
    } catch(e) {}
    res.json(stats);
});

app.get('/api/systemd', requireLogin, async (req, res) => {
    try {
        const { stdout } = await execPromise(`${nsenter} systemctl list-units --type=service --all --plain --no-legend`);
        res.json(stdout.split('\n').filter(l => l.trim()).map(l => { const p = l.trim().split(/\s+/); return { name: p[0], active: p[2], sub: p[3] }; }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docker', requireLogin, async (req, res) => {
    try {
        const { stdout } = await execPromise(`docker ps -a --format '{"id":"{{.ID}}", "name":"{{.Names}}", "image":"{{.Image}}", "state":"{{.State}}", "status":"{{.Status}}", "ports":"{{.Ports}}"}'`);
        res.json(stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ports', requireLogin, async (req, res) => {
    try {
        const { stdout } = await execPromise(`${nsenter} ss -lntup`);
        const ports = stdout.split('\n').slice(1).map(l => {
            const p = l.trim().split(/\s+/); if(p.length < 5) return null;
            const portMatch = p[4].match(/:(\d+)$/); if(!portMatch) return null;
            let process = 'System'; const pPart = p.slice(6).join(' ');
            if (pPart.includes('users:')) { const m = pPart.match(/"([^"]+)"/); if (m) process = m[1]; }
            return { proto: p[0], port: portMatch[1], address: p[4], process };
        }).filter(Boolean);
        res.json(ports.sort((a, b) => a.port - b.port));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/systemd/:action/:name', requireLogin, async (req, res) => {
    try { await execPromise(`${nsenter} systemctl ${req.params.action} ${req.params.name}`); res.json({ success: true }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/docker/:action/:name', requireLogin, async (req, res) => {
    try { await execPromise(`docker ${req.params.action} ${req.params.name}`); res.json({ success: true }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/git/upload', requireLogin, async (req, res) => {
    const { path, url, user, token } = req.body;
    let authUrl = url;
    if (url.startsWith('https://')) { authUrl = url.replace('https://', `https://${encodeURIComponent(user)}:${encodeURIComponent(token)}@`); }
    const cmd = `${nsenter} sh -c "cd ${path} && git init && git config user.name '${user}' && git config user.email '${user}@users.noreply.github.com' && git add . && (git commit -m 'Auto backup via ZYLVEmedia Core' || true) && git branch -M main && (git remote remove origin 2>/dev/null || true) && git remote add origin ${authUrl} && git push -u origin main"`;
    try { 
        const { stdout, stderr } = await execPromise(cmd); 
        res.json({ success: true, log: (stdout + '\n' + stderr).replace(new RegExp(token, 'g'), '***TOKEN_RAHASIA***') }); 
    } catch (e) { 
        res.status(500).json({ success: false, log: ((e.stdout || '') + '\n' + (e.stderr || '') + '\n' + e.message).replace(new RegExp(token, 'g'), '***TOKEN_RAHASIA***') }); 
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server jalan di Port ${PORT}`));
