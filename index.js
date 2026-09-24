const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const __path = process.cwd();
const PORT = process.env.PORT || 8000;
let code = require('./pair'); 

require('events').EventEmitter.defaultMaxListeners = 500;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Pair Code API Routes (/code සහ /pair දෙකටම mount කිරීම)
app.use('/code', code);
app.use('/pair', code);

// 2. Settings Page Route
app.use('/settings', async (req, res, next) => {
    const filePath = path.join(__path, 'settings.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ status: false, message: "settings.html not found" });
    }
});

// 3. Main Web UI Route (main.html එක load කිරීම)
app.use('/', async (req, res, next) => {
    // API request එකක් නම් next() එකට pass කරයි
    if (req.path !== '/') return next();

    const filePath = path.join(__path, 'main.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.json({
            status: true,
            message: "HEWA BOT SERVER IS RUNNING FINE!",
            pairing_url: "/code?number=YOUR_NUMBER"
        });
    }
});

// 4. 404 Route Handler
app.use((req, res) => {
    res.status(404).json({ status: false, message: "Route Not Found" });
});

app.listen(PORT, () => {
  console.log(`╔═══════════════════════════╗`);
  console.log(`║  Akira Bot — ONLINE  Port: ${PORT}   ║`);
  console.log(`╚═══════════════════════════╝`);
});

module.exports = app;
