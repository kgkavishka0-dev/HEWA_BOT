const express = require('express');
const router = express.Router();
const fs = require('fs');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');
const pino = require('pino');

router.get('/', async (req, res) => {
    // Frontend එකෙන් එන number / phone Parameter එක ලබාගැනීම
    let num = req.query.number || req.query.code || req.query.phone;

    if (!num) {
        return res.json({ error: "කරුණාකර දුරකථන අංකය ඇතුළත් කරන්න." });
    }

    // අංකයේ ඇති +, -, spaces වැනි අනවශ්‍ය සංකේත ඉවත් කිරීම
    num = num.replace(/[^0-9]/g, '');

    // Temp Session Folder එක සාදාගැනීම
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
            // Server Block වීම වළක්වන Browser Config එක
            browser: ["Mac OS", "Chrome", "121.0.6167.160"]
        });

        sock.ev.on('creds.update', saveCreds);

        if (!sock.authState.creds.registered) {
            // Socket එක Establish වීමට තත්පර 3ක Delay එකක්
            await delay(3000);

            // Pair Code එක Request කිරීම
            let code = await sock.requestPairingCode(num);
            code = code?.match(/.{1,4}/g)?.join("-") || code;

            // Folder එක Clean කිරීමට පෙර Response එක යැවීම
            res.json({ code: code });
        } else {
            res.json({ error: "මෙම අංකය දැනටමත් Registered වී ඇත." });
        }

    } catch (err) {
        console.error("Pairing Error:", err);
        res.json({ error: "Pairing Code එක ලබාගැනීමට නොහැකි විය. නැවත උත්සාහ කරන්න." });
    } finally {
        // තත්පර 10කින් පසු Temp Folder එක Clean කිරීම
        setTimeout(() => {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            } catch (e) {}
        }, 10000);
    }
});

module.exports = router;
