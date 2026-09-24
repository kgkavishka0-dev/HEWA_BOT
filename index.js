const express = require('express');
const fs = require('fs');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());

// Root endpoint එක (Server එක වැඩදැයි බලන්න)
app.get('/', (req, res) => {
    res.send("✅ HEWA BOT Server is Live and Running!");
});

// Pairing Code ලබාගන්නා Route එක (/pair?number=94771234567)
app.get('/pair', async (req, res) => {
    let num = req.query.number || req.query.code || req.query.phone;

    if (!num) {
        return res.status(400).json({ error: "කරුණාකර දුරකථන අංකය ඇතුළත් කරන්න. (උදා: /pair?number=94771234567)" });
    }

    // අංකයේ ඇති +, -, spaces වැනි සියලු සංකේත ඉවත් කිරීම
    num = num.replace(/[^0-9]/g, '');

    // Temp Session Folder එක සෑදීම
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
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`✅ WhatsApp Pairing Successful for: ${num}`);
                await delay(5000);

                try {
                    const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    await sock.sendMessage(userJid, { 
                        text: `✅ *HEWA BOT CONNECTED SUCCESSFULLY!*\n\nඔබගේ WhatsApp ගිණුම සාර්ථකව Connect විය.` 
                    });
                } catch (msgErr) {
                    console.error("Message sending error:", msgErr);
                }

                await delay(2000);
                await cleanup(sock);
            } else if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    // Reconnection logical checks
                }
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(3000);

            let code = await sock.requestPairingCode(num);
            code = code?.match(/.{1,4}/g)?.join("-") || code;

            // මිනිත්තු 3කට පසු Auto Clean වීම
            setTimeout(() => {
                cleanup(sock);
            }, 180000);

            return res.json({ code: code });
        } else {
            await cleanup(sock);
            return res.json({ error: "මෙම අංකය දැනටමත් Registered වී ඇත." });
        }

    } catch (err) {
        console.error("Pairing Error:", err);
        await cleanup(sock);

        if (!res.headersSent) {
            return res.status(500).json({ error: "Pairing Code එක ලබාගැනීමට නොහැකි විය. නැවත උත්සාහ කරන්න." });
        }
    }
});

// Railway Server එකේ Port එකට Bind කිරීම
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server is listening on port ${PORT}`);
});
