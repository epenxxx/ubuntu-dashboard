const express = require('express');
const { exec } = require('child_process');
const os = require('os');
const util = require('util');
const path = require('path');
const session = require('express-session');

const execPromise = async (cmd) => {
    return await util.promisify(exec)(cmd, { timeout: 20000 }); // Waktu tunggu Git diperpanjang 20 detik
};

const getCpuUsage = () => {
    return new Promise((resolve) => {
        const first = os.cpus();
        setTimeout(() => {
            const second = os.cpus();
            let totalDiff = 0, idleDiff = 0;
            for (let i = 0; i < first.length; i++) {
                totalDiff += Object.values(second[i].times).reduce((a, b) => a + b, 0) - Object.values(first[i].times).reduce((a, b) => a + b, 0);
                idleDiff += second[i].times.idle - first[i].times.idle;
            }
            const usage = totalDiff === 0 ? 0 : ((totalDiff - idleDiff) / totalDiff) * 100;
            resolve(usage.toFixed(1));
        }, 200);
    });
};

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

app.get('/api/stats', requireLogin, async (req, res) => {
    let stats = { 
        hostname: os.hostname(), platform: os.platform(), release: os.release(), uptime: os.uptime(),
        memory: null, cpuUsage: "0.0", storage: { ssd: null, hdd: null }
    };
    try {
        const tMem = os.totalmem(), fMem = os.freemem(), uMem = tMem - fMem;
        stats.memory = { total: (tMem/1048576).toFixed(0), used: (uMem/1048576).toFixed(0), percentage: ((uMem/tMem)*100).toFixed(1) };
    } catch(e) {}
    try { stats.cpuUsage = await getCpuUsage(); } catch(e) {}
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

// PERBAIKAN FITUR GIT PUSH: Membungkus seluruh perintah Git di Host OS
app.post('/api/git/upload', requireLogin, async (req, res) => {
    const { path, url, user, token } = req.body;
    
    // Injeksi token secara aman ke URL
    let authUrl = url;
    if (url.startsWith('https://')) {
        authUrl = url.replace('https://', `https://${encodeURIComponent(user)}:${encodeURIComponent(token)}@`);
    } else if (url.startsWith('http://')) {
        authUrl = url.replace('http://', `http://${encodeURIComponent(user)}:${encodeURIComponent(token)}@`);
    }

    // Membungkus seluruh perintah dengan "sh -c" agar dieksekusi DI LUAR Docker
    const cmd = `${nsenter} sh -c "cd ${path} && git init && git config user.name '${user}' && git config user.email '${user}@users.noreply.github.com' && git add . && git commit -m 'Auto backup via Orion Core' && git branch -M main && (git remote remove origin 2>/dev/null || true) && git remote add origin ${authUrl} && git push -u origin main"`;
    
    try { 
        const { stdout, stderr } = await execPromise(cmd); 
        res.json({ success: true, log: stdout + '\n' + stderr }); 
    } 
    catch (e) { 
        res.status(500).json({ success: false, log: (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + e.message }); 
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server jalan di Port ${PORT}`));
