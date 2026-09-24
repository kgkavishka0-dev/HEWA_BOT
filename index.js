const express = require('express');
const router = express.Router();
const fs = require('fs');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');

router.get('/', async (req, res) => {
    let num = req.query.number || req.query.code || req.query.phone;

    if (!num) {
        return res.json({ error: "කරුණාකර දුරකථන අංකය ඇතුළත් කරන්න." });
    }

    // අංකයේ ඇති +, -, spaces ඉවත් කිරීම
    num = num.replace(/[^0-9]/g, '');

    const sessionDir = './temp_' + Date.now();

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ["Mac OS", "Chrome", "121.0.6167.160"]
        });

        sock.ev.on('creds.update', saveCreds);

        // Connection එක වෙනස් වන විට (Connected/Closed) ක්‍රියාත්මක වේ
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                await delay(5000);
                
                // Pair වූ පසු WhatsApp එකට Message එකක් යැවීම
                const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                await sock.sendMessage(userJid, { 
                    text: `✅ *HEWA BOT CONNECTED SUCCESSFULLY!*\n\nඔබගේ Bot එක සාර්ථකව Connect විය.` 
                });

                // Socket එක වසා Temp Folder එක Clean කිරීම
                await delay(2000);
                try {
                    await sock.ws.close();
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                } catch (e) {}
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(3000);

            // Pair Code එක Request කිරීම
            let code = await sock.requestPairingCode(num);
            code = code?.match(/.{1,4}/g)?.join("-") || code;

            // Pair Code එක Web එකට Response කිරීම
            return res.json({ code: code });
        } else {
            return res.json({ error: "මෙම අංකය දැනටමත් Registered වී ඇත." });
        }

    } catch (err) {
        console.error("Pairing Error:", err);
        if (!res.headersSent) {
            return res.json({ error: "Pairing Code එක ලබාගැනීමට නොහැකි විය. නැවත උත්සාහ කරන්න." });
        }
    }
});

module.exports = router;
