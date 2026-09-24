const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Web Page Load Karne Ke Liye Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

// 2. HTML script dwara requested Pairing Endpoint (/code ya /pair)
app.get('/code', async (req, res) => {
    let num = req.query.number || req.query.code || req.query.phone;

    if (!num) {
        return res.status(400).json({ error: "Please enter your phone number." });
    }

    num = num.replace(/[^0-9]/g, '');
    const sessionDir = './temp_' + Date.now();

    const cleanup = async (sock) => {
        try {
            if (sock) {
                sock.ev.removeAllListeners('connection.update');
                sock.ev.removeAllListeners('creds.update');
                await sock.ws.close();
            }
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        } catch (e) {}
    };

    let sock = null;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ["Mac OS", "Chrome", "121.0.6167.160"]
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (connection === 'open') {
                await delay(5000);
                try {
                    const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    await sock.sendMessage(userJid, { 
                        text: `✅ *HEWA BOT CONNECTED SUCCESSFULLY!*` 
                    });
                } catch (msgErr) {}

                await delay(2000);
                await cleanup(sock);
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(3000);

            let code = await sock.requestPairingCode(num);
            code = code?.match(/.{1,4}/g)?.join("-") || code;

            setTimeout(() => { cleanup(sock); }, 180000);

            return res.json({ code: code });
        } else {
            await cleanup(sock);
            return res.json({ error: "Number already registered." });
        }

    } catch (err) {
        await cleanup(sock);
        if (!res.headersSent) {
            return res.status(500).json({ error: "Could not retrieve pairing code." });
        }
    }
});

// Alias for /pair endpoint
app.get('/pair', (req, res) => {
    if (req.query.number || req.query.code || req.query.phone) {
        return res.redirect(`/code?number=${req.query.number || req.query.code || req.query.phone}`);
    }
    res.sendFile(path.join(__dirname, 'main.html'));
});

// Railway Binding
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
