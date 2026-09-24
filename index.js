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

// 1. Settings Page Route
app.use('/settings', async (req, res, next) => {
    const filePath = path.join(__path, 'settings.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ status: false, message: "settings.html not found" });
    }
});

// 2. Main Web UI Route (main.html එක load කිරීම)
app.get('/', async (req, res) => {
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

// 3. Pair Router Mount (/code සහ /pair routes සඳහා)
app.use('/', code);

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
