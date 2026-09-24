/*
  HEWA GIRL MD MINI BOT - MULTI SESSION SUPPORT
  DEVELOPED BY HEWA SERVICE
  FULLY ENC AND PRIVET SOURCE CODE
*/

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { sms } = require("./msg");
const router = express.Router();
const pino = require('pino');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const yts = require('yt-search');
const { ytmp3, ytmp4 } = require('sadaslk-dlcore');
const os = require('os');
const FormData = require('form-data');
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);
// ffmpeg-static binary eka yt-dlp ekatath pennanna (mp3 convert ekata)
process.env.PATH = path.dirname(ffmpegPath) + ':' + (process.env.PATH || '');

// ═══ Tesseract + pdf-parse (receipt OCR සඳහා) ═══
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');

// ═══ Google Contacts API — People API (Railway-safe: env vars first, file fallback) ═══
const { google } = require('googleapis');

let peopleService = null;

function parseJsonSource(envValue, filePath, label) {
    // 1) Env var එකෙන් (Railway — ephemeral FS safe)
    if (process.env[envValue] && process.env[envValue].trim() !== '') {
        try {
            const parsed = JSON.parse(process.env[envValue]);
            console.log(`✅ Google Contacts: ${label} loaded from ${envValue} env var`);
            return parsed;
        } catch (e) {
            console.error(`❌ Google Contacts: ${envValue} env var parse error:`, e.message);
        }
    }

    // 2) Local file fallback
    const fullPath = path.join(__dirname, filePath);
    if (fs.existsSync(fullPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            console.log(`✅ Google Contacts: ${label} loaded from ./${filePath}`);
            return parsed;
        } catch (e) {
            console.error(`❌ Google Contacts: ./${filePath} parse error:`, e.message);
        }
    }

    console.warn(`⚠️ Google Contacts: ${label} not found (env + file both missing)`);
    return null;
}

(function initGoogleContacts() {
    try {
        const credentials = parseJsonSource('CREDENTIALS_JSON', 'credentials.json', 'credentials');
        const token = parseJsonSource('TOKEN_JSON', 'token.json', 'token');

        if (!credentials || !token) {
            console.warn('⚠️ Google Contacts disabled — auto-save won\'t work until credentials are set');
            return;
        }

        const creds = credentials.installed || credentials.web;

        if (!creds?.client_id || !creds?.client_secret) {
            console.error('❌ Google Contacts: client_id / client_secret missing in credentials');
            return;
        }

        if (!token.refresh_token) {
            console.error('❌ Google Contacts: refresh_token missing in token. Re-run: node generate-token.js');
            return;
        }

        const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret);
        auth.setCredentials({
            refresh_token: token.refresh_token,
            scope: token.scope || 'https://www.googleapis.com/auth/contacts'
        });

        peopleService = google.people({ version: 'v1', auth });
        console.log('✅ Google Contacts API initialized (Railway-safe mode)');
    } catch (e) {
        console.error('❌ Google Contacts init error:', e.message);
    }
})();

async function saveToGoogleContacts(displayName, phoneNumber, pushName) {
    if (!peopleService) throw new Error('Google Contacts not initialized');

    const requestBody = {
        names: [{ givenName: displayName, displayName: displayName }],
        phoneNumbers: [{ value: `+${phoneNumber}`, type: 'mobile' }]
    };

    // WhatsApp profile name එක Notes field එකට (reference එකට විතරයි)
    if (pushName) {
        requestBody.biographies = [{ value: `WA Profile: ${pushName}`, contentType: 'TEXT_PLAIN' }];
    }

    const res = await peopleService.people.createContact({ requestBody });
    return res.data;
}

// ═══ HEWA IMAGE — හැම තැනම මේ එකම image එක ═══
const SHANA_IMG = 'https://files.catbox.moe/rykk5e.jpg';
const akira = SHANA_IMG;

// ═══ AUTO SAVE STATE — Google Contacts save සඳහා state ═══
const autoSaveEnabled = new Map();
const autoSaveCounters = new Map();

const {
    default: makeWASocket,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    extractMessageContent,
    jidDecode,
    MessageRetryMap,
    jidNormalizedUser,
    proto,
    getContentType,
    areJidsSameUser,
    generateWAMessage,
    delay,
    Browsers
} = require("baileys");

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    STATUS: 'true',
    MODE: 'public',
    PREFIX: '.',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    AKIRA_IMG: 'https://files.catbox.moe/rykk5e.jpg',
    AUTORP_IMG: 'https://files.catbox.moe/rykk5e.jpg',
    NEWSLETTER_JID: '120363419619460838@newsletter',
    NEWSLETTER_LIST: [
        '120363425584831057@newsletter',
        '120363422562980426@newsletter'
    ],
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94728348795',
    CHANNEL_LINK: ''
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const socketHandlersMap = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';

// ═══ Status forward සඳහා ═══
const latestStatuses = new Map();

// ═══ Receipt OCR dedupe — එකම message එකට දෙපාරක් reply නොවීමට ═══
const receiptProcessed = new Set();
setInterval(() => receiptProcessed.clear(), 10 * 60 * 1000);

const SessionSchema = new mongoose.Schema({
    number: { type: String, unique: true, required: true },
    creds: { type: Object, required: true },
    config: { type: Object },
    updatedAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', SessionSchema);

async function connectMongoDB() {
    try {
        const mongoUri = process.env.MONGO_URI || '<MONGODB-URL>';
        if (!process.env.MONGO_URI && mongoUri === '<MONGODB-URL>') {
            console.warn('⚠️ MONGO_URI is missing. Please set MONGO_URI environment variable.');
            return;
        }
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('MongoDB connection failed:', error.message);
    }
}
connectMongoDB();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function initialize() {
    activeSockets.clear();
    socketCreationTime.clear();
    console.log('Cleared active sockets and creation times on startup');
}

async function uploadToCatbox(stream, fileName) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', stream, fileName);

        const res = await axios.post(
            'https://catbox.moe/user/api.php',
            form,
            { headers: form.getHeaders(), timeout: 0 }
        );

        if (typeof res.data === 'string' && res.data.startsWith('https://')) return res.data.trim();
        return null;
    } catch {
        return null;
    }
}

async function saveMediaToCatbox(msg) {
    try {
        const type = Object.keys(msg.message)[0];
        const mediaMap = {
            imageMessage: 'image',
            videoMessage: 'video',
            audioMessage: 'audio',
            documentMessage: 'document'
        };

        if (!mediaMap[type]) return null;

        const mediaMsg = msg.message[type];
        const size = mediaMsg.fileLength || 0;

        if (size > 100 * 1024 * 1024) return null;

        const stream = await downloadContentFromMessage(mediaMsg, mediaMap[type]);

        const ext =
            type === 'imageMessage' ? 'jpg' :
            type === 'videoMessage' ? 'mp4' :
            type === 'audioMessage' ? 'opus' :
            'bin';

        return await uploadToCatbox(stream, `${msg.key.id}.${ext}`);
    } catch {
        return null;
    }
}

async function cleanupInactiveSessions() {
    try {
        const sessions = await Session.find({}, 'number').lean();
        let cleanedCount = 0;

        for (const { number } of sessions) {
            const sanitizedNumber = number.replace(/[^0-9]/g, '');

            if (!activeSockets.has(sanitizedNumber) && !socketCreationTime.has(sanitizedNumber)) {
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

                if (fs.existsSync(sessionPath)) {
                    const stats = fs.statSync(sessionPath);
                    const timeSinceModified = Date.now() - stats.mtime.getTime();

                    if (timeSinceModified > 60 * 60 * 1000) {
                        console.log(`Cleaning up stale session: ${sanitizedNumber}`);
                        fs.removeSync(sessionPath);
                        cleanedCount++;
                    }
                }
            }
        }

        console.log(`Cleaned up ${cleanedCount} stale sessions`);
        return cleanedCount;
    } catch (error) {
        console.error('Cleanup error:', error);
        return 0;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const jid = message.key.remoteJid;

        if (jid !== config.NEWSLETTER_JID) return;

        try {
            const emojis = ['🎀', '🍬', '👽', '🌺', '🍓', '🍫', '🫐', '🥷'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

            const messageId = message.key.server_id || message.newsletterServerId;

            if (!messageId) {
                console.warn('⚠️ No newsletterServerId found in message:', message);
                return;
            }

            await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
            console.log(`✅ Reacted to official newsletter: ${jid}`);
        } catch (error) {
            console.error('⚠️ Newsletter reaction failed:', error.message);
        }
    });
}

async function autoReconnectOnStartup() {
    try {
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            console.log(`Loaded ${numbers.length} numbers from numbers.json`);
        }

        const sessions = await Session.find({}, 'number').lean();
        const mongoNumbers = sessions.map(s => s.number);
        numbers = [...new Set([...numbers, ...mongoNumbers])];

        if (numbers.length === 0) {
            console.log('No numbers found for auto-reconnect');
            return;
        }

        console.log(`Attempting to reconnect ${numbers.length} sessions...`);

        for (const number of numbers) {
            const sanitized = number.replace(/[^0-9]/g, '');
            if (activeSockets.has(sanitized)) {
                console.log(`Number ${sanitized} already connected, skipping`);
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };

            try {
                await EmpirePair(sanitized, mockRes);
                console.log(`✅ Initiated reconnect for ${sanitized}`);
            } catch (error) {
                console.error(`❌ Failed to reconnect ${sanitized}:`, error);
            }

            await delay(1500);
        }
    } catch (error) {
        console.error('Auto-reconnect on startup failed:', error);
    }
}

(async () => {
    await initialize();
    setTimeout(autoReconnectOnStartup, 5000);
})();

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

const fetchJson = async (url, options) => {
    try {
        options = options ? options : {};
        const res = await axios({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36'
            },
            ...options
        });
        return res.data;
    } catch (err) {
        return err;
    }
};

const runtime = (seconds) => {
    seconds = Number(seconds);
    var d = Math.floor(seconds / (3600 * 24));
    var h = Math.floor(seconds % (3600 * 24) / 3600);
    var m = Math.floor(seconds % 3600 / 60);
    var s = Math.floor(seconds % 60);
    var dDisplay = d > 0 ? d + (d == 1 ? ' day, ' : ' days, ') : '';
    var hDisplay = h > 0 ? h + (h == 1 ? ' hour, ' : ' hours, ') : '';
    var mDisplay = m > 0 ? m + (m == 1 ? ' minute, ' : ' minutes, ') : '';
    var sDisplay = s > 0 ? s + (s == 1 ? ' second' : ' seconds') : '';
    return dDisplay + hDisplay + mDisplay + sDisplay;
};

// ══════════════════════════════════════════════════════════════
// ═══ HEWA UNIVERSAL DOWNLOADER (yt-dlp + API fallback) ═══
// ══════════════════════════════════════════════════════════════
const YT_DLP_PATH = path.join(__dirname, 'yt-dlp');

const execAsync = (cmd) => new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 200, timeout: 300000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
    });
});

async function ytdlpDirect(url, mode, outPath) {
    let ytdl = YT_DLP_PATH;
    if (!fs.existsSync(YT_DLP_PATH)) ytdl = 'yt-dlp';

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    let cmd;
    if (mode === 'mp3') {
        cmd = `"${ytdl}" -f "bestaudio/best" --no-playlist --no-warnings --user-agent "${UA}" -x --audio-format mp3 --audio-quality 0 -o "${outPath}.%(ext)s" "${url}"`;
    } else {
        cmd = `"${ytdl}" -f "best[ext=mp4][height<=720]/best[ext=mp4]/best" --no-playlist --no-warnings --user-agent "${UA}" --merge-output-format mp4 -o "${outPath}.%(ext)s" "${url}"`;
    }
    await execAsync(cmd);

    const dir = path.dirname(outPath);
    const base = path.basename(outPath);
    const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
    if (!files.length) throw new Error('Download failed');
    return path.join(dir, files[0]);
}

async function downloadFromUrl(directUrl, outPath, ext = 'mp4') {
    const res = await axios.get(directUrl, {
        responseType: 'arraybuffer',
        timeout: 300000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    const filePath = outPath + '.' + ext;
    fs.writeFileSync(filePath, Buffer.from(res.data));
    if (fs.statSync(filePath).length < 10000) throw new Error('File too small / invalid');
    return filePath;
}

async function ytdlpDownload(url, mode, outPath) {
    try {
        return await ytdlpDirect(url, mode, outPath);
    } catch (e) {
        console.log('yt-dlp failed, trying API fallback:', e.message.slice(0, 150));
    }

    if (mode === 'mp3') {
        try {
            const r = await axios.post(`https://api.cobalt.tools/api/json`,
                { url: url, aFormat: 'mp3', isAudioOnly: true },
                { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 });
            if (r.data?.url) return await downloadFromUrl(r.data.url, outPath, 'mp3');
        } catch (_) {}

        try {
            const r = await axios.get(`https://ytdl-new-dxz.vercel.app/api/ytmp3?url=${encodeURIComponent(url)}`, { timeout: 30000 });
            const dl = r.data.download_url || r.data.result || r.data.url;
            if (dl) return await downloadFromUrl(dl, outPath, 'mp3');
        } catch (_) {}

        throw new Error('All download methods failed');
    }

    if (url.includes('tiktok.com')) {
        try {
            const r = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, { timeout: 30000 });
            const d = r.data?.data;
            const dl = d?.play || d?.hdplay || d?.wmplay;
            if (dl) return await downloadFromUrl(dl.startsWith('http') ? dl : 'https://www.tikwm.com' + dl, outPath, 'mp4');
        } catch (_) {}

        try {
            const r = await axios.get(`https://www.movanest.xyz/v2/tiktok?url=${encodeURIComponent(url)}`, { timeout: 30000 });
            const d = r.data?.results;
            const dl = d?.no_watermark || d?.watermark;
            if (dl) return await downloadFromUrl(dl, outPath, 'mp4');
        } catch (_) {}
    }

    if (url.includes('facebook.com') || url.includes('fb.watch')) {
        try {
            const r = await axios.get(`https://www.movanest.xyz/v2/fbdown?url=${encodeURIComponent(url)}`, { timeout: 30000 });
            const d = r.data?.results?.[0];
            const dl = d?.hdQualityLink || d?.normalQualityLink;
            if (dl) return await downloadFromUrl(dl, outPath, 'mp4');
        } catch (_) {}

        try {
            const r = await axios.post(`https://api.cobalt.tools/api/json`,
                { url: url },
                { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 });
            if (r.data?.url) return await downloadFromUrl(r.data.url, outPath, 'mp4');
        } catch (_) {}
    }

    if (url.includes('youtu')) {
        try {
            const r = await axios.get(`https://ytdl-new-dxz.vercel.app/api/ytmp4?url=${encodeURIComponent(url)}&quality=360`, { timeout: 30000 });
            const dl = r.data.video_url || r.data.download_url;
            if (dl) return await downloadFromUrl(dl, outPath, 'mp4');
        } catch (_) {}

        try {
            const r = await axios.post(`https://api.cobalt.tools/api/json`,
                { url: url },
                { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 });
            if (r.data?.url) return await downloadFromUrl(r.data.url, outPath, 'mp4');
        } catch (_) {}
    }

    try {
        const r = await axios.post(`https://api.cobalt.tools/api/json`,
            { url: url },
            { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 });
        if (r.data?.url) return await downloadFromUrl(r.data.url, outPath, 'mp4');
    } catch (_) {}

    throw new Error('All download methods failed');
}

async function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const senderNumber = msg.key.participant ? msg.key.participant.split('@')[0] : msg.key.remoteJid.split('@')[0];
        const botNumber = socket.user?.id ? jidNormalizedUser(socket.user.id).split('@')[0] : '';
        const isReact = msg.message.reactionMessage;

        const sanitizedNumber = botNumber.replace(/[^0-9]/g, '');
        const sessionConfig = activeSockets.get(sanitizedNumber)?.config || config;
    });
}

function setupAutoRestart(socket, number) {
    const id = number;
    let reconnecting = false;

    socket.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

        if (connection === 'open') {
            reconnecting = false;
            return;
        }

        if (connection !== 'close' || reconnecting) return;
        reconnecting = true;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.warn(`[${id}] Connection closed | code:`, statusCode);

        if (statusCode === 401) {
            await destroySocket(id);
            await deleteSession(id);
            return;
        }

        await delay(2000);
        await destroySocket(id);

        const mockRes = {
            headersSent: true,
            send() {},
            status() { return this }
        };

        try {
            await EmpirePair(id, mockRes);
        } catch (e) {
            console.error('Reconnect failed:', e);
        }

        reconnecting = false;
    });
}

async function destroySocket(id) {
    try {
        const data = activeSockets.get(id);
        if (data?.socket) {
            data.socket.ev.removeAllListeners();
            data.socket.ws?.close();
        }
    } catch (e) {
        console.error('Destroy socket error:', e);
    }

    activeSockets.delete(id);
    socketCreationTime.delete(id);
}

async function saveSession(number, creds) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.findOneAndUpdate({
            number: sanitizedNumber
        }, {
            creds,
            updatedAt: new Date()
        }, {
            upsert: true
        });
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(creds, null, 2));
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
        }
        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        }
        console.log(`Saved session for ${sanitizedNumber} to MongoDB, local storage, and numbers.json`);
    } catch (error) {
        console.error(`Failed to save session for ${sanitizedNumber}:`, error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({
            number: sanitizedNumber
        });
        if (!session) {

            return null;
        }
        if (!session.creds || !session.creds.me || !session.creds.me.id) {
            console.error(`Invalid session data for ${sanitizedNumber}`);
            await deleteSession(sanitizedNumber);
            return null;
        }
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(session.creds, null, 2));
        console.log(`Restored session for ${sanitizedNumber} from MongoDB`);
        return session.creds;
    } catch (error) {
        console.error(`Failed to restore session for ${number}:`, error);
        return null;
    }
}

async function deleteSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.deleteOne({
            number: sanitizedNumber
        });
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
        }
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            let numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        }

    } catch (error) {
        console.error(`Failed to delete session for ${number}:`, error);
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configDoc = await Session.findOne({
            number: sanitizedNumber
        }, 'config');
        return configDoc?.config || {
            ...config
        };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return {
            ...config
        };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.findOneAndUpdate({
            number: sanitizedNumber
        }, {
            config: newConfig,
            updatedAt: new Date()
        }, {
            upsert: true
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error(`Failed to update config for ${number}:`, error);
        throw error;
    }
}

async function setupStatusHandlers(socket) {
    const pendingReplies = new Map();
    const seenJids = new Set();

    socket.ev.on('messages.upsert', async ({
        messages
    }) => {
        const msg = messages[0];
        if (!msg?.key ||
            msg.key.remoteJid !== 'status@broadcast' ||
            !msg.key.participant ||
            msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const botJid = socket.user?.id ? jidNormalizedUser(socket.user.id) : '';
        if (!botJid || msg.key.participant === botJid) return;

        const sanitizedNumber = botJid.split('@')[0].replace(/[^0-9]/g, '');
        const sessionConfig = activeSockets.get(sanitizedNumber)?.config || config;

        // ═══ .status on/off — STATUS 'true' nam witharai view + like wenne ═══
        if ((sessionConfig.STATUS || config.STATUS) !== 'true') return;

        // ═══ Status forward sandaha anthinma status eka save karannawa ═══
        try {
            latestStatuses.set(sanitizedNumber, {
                key: msg.key,
                message: msg.message,
                from: msg.key.participant,
                ts: Date.now()
            });
            for (const [k, v] of latestStatuses) {
                if (Date.now() - v.ts > 24 * 60 * 60 * 1000) latestStatuses.delete(k);
            }
        } catch (_) {}

        let statusViewed = false;

        try {

            if (sessionConfig.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([msg.key]);
                        statusViewed = true;
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) {
                            console.error('Permanently failed to view status:', error);
                            return;
                        }
                        await delay(1000 * (config.MAX_RETRIES - retries + 1));
                    }
                }
            } else {

                statusViewed = true;
            }

            if (statusViewed && sessionConfig.AUTO_LIKE_STATUS === 'true') {
                await delay(5000);

                const emojis = sessionConfig.AUTO_LIKE_EMOJI || ['❤️', '💚', '💜', '🧡', '🩷'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            msg.key.remoteJid, {
                                react: {
                                    text: randomEmoji,
                                    key: msg.key
                                }
                            }, {
                                statusJidList: [msg.key.participant]
                            }
                        );
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) {
                            console.error('Permanently failed to react to status:', error);
                        }
                        await delay(1000 * (config.MAX_RETRIES - retries + 1));
                    }
                }
            }

        } catch (error) {
            console.error('Unexpected error in status handler:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function EmpirePair(number, res) {
    console.log(`Initiating pairing/reconnect for ${number}`);
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    if (activeSockets.has(sanitizedNumber)) {
        try { activeSockets.get(sanitizedNumber).socket?.end?.(); } catch {}
        activeSockets.delete(sanitizedNumber);
    }

    await restoreSession(sanitizedNumber);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }),
            browser: ["Mac OS", "Chrome", "121.0.6167.160"], // 👈 Browser එක මේකට මාරු කරපන්
            markOnlineOnConnect: false,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: undefined,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: false,
            retryRequestOptions: {
                delayMs: 500,
                maxRetries: 5
            }
        });
        socketCreationTime.set(sanitizedNumber, Date.now());

        // ═══ GLOBAL HUMAN TYPING ═══
        const origSendMessage = socket.sendMessage.bind(socket);
        socket.sendMessage = async (jid, content, opts) => {
            try {
                const jidStr = typeof jid === 'string' ? jid : jid?.id || '';
                const isChatJid =
                    typeof jidStr === 'string' &&
                    (jidStr.endsWith('@s.whatsapp.net') || jidStr.endsWith('@g.us'));
                const hasText = content && (typeof content.text === 'string' || typeof content.caption === 'string');

                if (isChatJid && hasText && Math.random() < 0.85) {
                    const thinkTime = 800 + Math.floor(Math.random() * 1700);
                    await socket.sendPresenceUpdate('composing', jidStr);
                    await delay(thinkTime);
                    const result = await origSendMessage(jid, content, opts);
                    await socket.sendPresenceUpdate('paused', jidStr).catch(() => {});
                    return result;
                }
            } catch (_) {}
            return origSendMessage(jid, content, opts);
        };

        if (!socket._handlersAttached) {
            socket._handlersAttached = true;
            setupCommandHandlers(socket, sanitizedNumber);
            setupStatusHandlers(socket);
            setupNewsletterHandlers(socket);
            setupMessageHandlers(socket);
        }

        setupAutoRestart(socket, sanitizedNumber);

        // 🚨 FIX 1: Connection initialization delay & proper Pairing Code Execution
        // ✅ ඒ වෙනුවට මේ ටික Paste කරන්න:
        if (!socket.authState.creds.registered) {
            let retries = 3;
            const custom = "HEWADV12";
            let code = null;

            await delay(1500);

            while (retries > 0) {
                try {
                    code = await socket.requestPairingCode(sanitizedNumber, custom);
                    if (code) break;
                } catch (error) {
                    retries--;
                    console.error(`Pairing retry failed, remaining: ${retries}`, error.message);
                    if (retries === 0) break;
                    await delay(1500);
                }
            }

           if (code && res && !res.headersSent) {
                return res.status(200).send({ code });
            } else if (!res.headersSent) {
                return res.status(500).send({ error: "Failed to generate pairing code." });
            }
        }

        socket.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                const credsPath = path.join(sessionPath, 'creds.json');
                if (!fs.existsSync(credsPath)) return;
                const fileContent = fs.readFileSync(credsPath, 'utf8');
                const creds = JSON.parse(fileContent);
                await saveSession(sanitizedNumber, creds);
            } catch (e) {
                console.error("Creds update error:", e.message);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`✅ Connection opened for ${sanitizedNumber}`);
                try {
                    await delay(3000);

                    if (!socket.user?.id) {
                        console.error(`❌ socket.user is null after connection open for ${sanitizedNumber}`);
                        return;
                    }

                    const userJid = jidNormalizedUser(socket.user.id);
                    const freshConfig = await loadUserConfig(sanitizedNumber);

                    activeSockets.set(sanitizedNumber, { socket, config: freshConfig });
                    console.log(`📌 Socket registered in activeSockets for ${sanitizedNumber}`);

                    // ═══ Auto Save state load from Mongo (Railway restart safe) ═══
                    if (freshConfig.AUTOSAVE === 'true') {
                        autoSaveEnabled.set(sanitizedNumber, true);
                        console.log(`✅ [AUTO SAVE] Restored ON state for ${sanitizedNumber}`);
                    } else {
                        autoSaveEnabled.set(sanitizedNumber, false);
                    }

                    try {
                        const combinedList = [];

                        if (config.NEWSLETTER_JID) {
                            combinedList.push(config.NEWSLETTER_JID);
                        }

                        if (config.NEWSLETTER_LIST && Array.isArray(config.NEWSLETTER_LIST)) {
                            config.NEWSLETTER_LIST.forEach(jid => {
                                if (!combinedList.includes(jid)) {
                                    combinedList.push(jid);
                                }
                            });
                        }

                        console.log(`📌 Total Newsletters to follow (including Main): ${combinedList.length}`);

                        for (const jid of combinedList) {
                            try {
                                await socket.newsletterFollow(jid);

                                if (jid === config.NEWSLETTER_JID) {
                                    console.log(`👑 Main Newsletter Followed Successfully: ${jid}`);
                                } else {
                                    console.log(`✅ Extra Newsletter Followed: ${jid}`);
                                }

                                await delay(2000);
                            } catch (e) {
                                console.log(`❌ Newsletter error for ${jid}:`, e.message);
                            }
                        }
                    } catch (newsletterError) {
                        console.error("Newsletter list error:", newsletterError);
                    }

                    await socket.sendMessage(userJid, {
                        image: { url: SHANA_IMG },
                        caption: formatMessage(
                            '`*↳ ❝ [🎀 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗧𝗼 𝗛𝗘𝗪𝗔 𝙎𝙀𝙍𝙑𝙄𝘾𝙀 🎀] ¡! ❞*`',
                            `╭─────⊹₊⟡⋆ 𝐈𝐧𝐟𝐨 ⋆⟡₊⊹─────<𝟑 .ᐟ\n┊ 𝜗𝜚⋆ : 𝚅𝙴𝚁𝚂𝙸𝙾𝙽 - V1.0.0\n┊ 𝜗𝜚⋆ : 𝙽𝚄𝙼𝙱𝙴𝚁 - ${number}\n┊ 𝜗𝜚⋆ : 𝙾𝚆𝙽𝙴𝚁 - 𝗛𝗘𝗪𝗔 𝙎𝙀𝙍𝙑𝙄𝘾𝙀 ִ ࣪𖤐.ᐟ\n╰────────────────────<𝟑 .ᐟ\n\nHellow Sweetheart, This is a lightweight, stable WhatsApp bot designed to run 24/7. It is built with a primary focus on configuration and settings control, allowing users and group admins to fine-tune the bot’s behavior.\n\n₊❏❜ ⋮ Web - https://akira.gotukolaya.site`,
                            '𝗛𝗘𝗪𝗔 𝙎𝙀𝙍𝙑𝙄𝘾𝙀 ✹'
                        )
                    });
                    console.log(`📩 Welcome message sent for ${sanitizedNumber}`);
                } catch (error) {
                    console.error('Error in connection open handler:', error.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === 401) {
                    try { socket.end(); } catch {}
                    activeSockets.delete(sanitizedNumber);
                    socketCreationTime.delete(sanitizedNumber);
                    await deleteSession(sanitizedNumber);
                }
            }
        });

    } catch (error) {
        socketCreationTime.delete(sanitizedNumber);
        if (res && !res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

async function setupCommandHandlers(socket, number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    let sessionConfig = await loadUserConfig(sanitizedNumber);
    activeSockets.set(sanitizedNumber, {
        socket,
        config: sessionConfig
    });

    // ═══ Auto Save state load from Mongo (restart safe) ═══
    if (sessionConfig.AUTOSAVE === 'true') {
        autoSaveEnabled.set(sanitizedNumber, true);
    } else {
        autoSaveEnabled.set(sanitizedNumber, false);
    }

    const recentCallers = new Set();

    // ═══ HEWA AGENT - AUTO REPLY state ═══
    const autorpLastSent = new Map();  // sender -> menu යවපු අන්තිම වෙලාව (menu cooldown සඳහා)
    const AUTORP_DELAY_MS_MIN = 5000;  // thappara 5
    const AUTORP_DELAY_MS_MAX = 10000; // thappara 10

    // ═══ Status forward state ═══
    const statusFwdLastSent = new Map();
    const STATUS_FWD_COOLDOWN_MS = 10 * 60 * 1000;

    setInterval(() => {
        const now = Date.now();
        for (const [key, ts] of statusFwdLastSent) {
            if (now - ts > STATUS_FWD_COOLDOWN_MS * 2) statusFwdLastSent.delete(key);
        }
    }, 30000);

    // ═══ HEWA AGENT - CALLCUT handler ═══
    socket.ev.on('call', async (calls) => {
        try {
            const currentData = activeSockets.get(sanitizedNumber);
            const cfg = currentData?.config || sessionConfig;
            if (cfg.CALLCUT !== 'true') return;

            for (const call of calls) {
                if (call.status === 'offer') {
                    const callFrom = call.from;
                    const callId = call.id;
                    try {
                        await socket.rejectCall(callId, callFrom);
                        console.log(`✅ [HEWA AGENT] Call cut from ${callFrom}`);

                        await socket.sendMessage(callFrom, {
                            text: `*කණගාටුයි !!*\n\n*මේ වේලාවේ ඔබට HEWA සමග සම්බන්ධ විය නොහැක 🚫*\n\n*මම ඔබට ඔහුව හැකිතාක් ඉක්මනට සම්බන්ධ කර දෙනතෙක් රැඳී සිටින්න.*\n\n📌ඔවු\n📌නැත\n\n> HEWA SERVICE 🇱🇰`
                        });
                    } catch (e) {
                        console.error('❌ [HEWA AGENT] Call cut error:', e.message);
                    }
                }
            }
        } catch (e) {
            console.error('Call handler error:', e.message);
        }
    });

    socket.ev.on('messages.upsert', async ({
        messages
    }) => {

        const msg = messages[0];
        if (!msg.message) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage?.contextInfo != null
                ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
                : [];
        const body = (type === 'conversation') ? msg.message.conversation
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage')
                ? msg.message.extendedTextMessage.text
            : (type == 'interactiveResponseMessage')
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id
            : (type == 'templateButtonReplyMessage')
                ? msg.message.templateButtonReplyMessage?.selectedId
            : (type === 'extendedTextMessage')
                ? msg.message.extendedTextMessage.text
            : (type == 'imageMessage') && msg.message.imageMessage.caption
                ? msg.message.imageMessage.caption
            : (type == 'videoMessage') && msg.message.videoMessage.caption
                ? msg.message.videoMessage.caption
            : (type == 'buttonsResponseMessage')
                ? msg.message.buttonsResponseMessage?.selectedButtonId
            : (type == 'listResponseMessage')
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
            : (type == 'messageContextInfo')
                ? (msg.message.buttonsResponseMessage?.selectedButtonId
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
                    || msg.text)
            : (type === 'viewOnceMessage')
                ? msg.message[type]?.message[getContentType(msg.message[type].message)]
            : (type === "viewOnceMessageV2")
                ? (msg.message[type]?.message?.imageMessage?.caption || msg.message[type]?.message?.videoMessage?.caption || "")
            : '';

        if (!body) return;

        const text = body;
        const isCmd = text.startsWith(sessionConfig.PREFIX || '.');
        const sender = msg.key.remoteJid;

        const botJid = socket.user?.id ? socket.user.id.split(':')[0] : '';
        const nowsender = msg.key.fromMe ?
            (botJid + '@s.whatsapp.net') :
            (msg.key.participant || msg.key.remoteJid);

        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;

        const isbot = botJid ? botJid.includes(senderNumber) : false;
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        const isAshuu = sender === `${config.OWNER_NUMBER}@s.whatsapp.net` ||
            (socket.user?.id ? jidNormalizedUser(socket.user.id) === sender : false);
        const isGroup = msg.key.remoteJid.endsWith('@g.us');

        // ═══════════════════════════════════════════════════════
        // ═══ CALLCUT RESPONSE (ඔවු / නැත) HANDLER ═══
        // ═══════════════════════════════════════════════════════
        if (!isGroup && !msg.key.fromMe) {
            const trimmedCallText = text.trim().toLowerCase();
            if (trimmedCallText === 'ඔවු' || trimmedCallText === 'ow' || trimmedCallText === 'owu') {
                await socket.sendMessage(sender, {
                    text: `මැසෙජ් එක තෙරුම් ගත්තා ✅\n\n *ඔබට ඉතාමත් ඉකමන් සහ 100% Safe SERVICE එක ලාබා ගැනිමට පහල අංක දෙකෙන් එකකට මැසෙජ් හො කොල් යොමු කරන්න*\n\n: ☎️ 0725560900 PODI SERVICE\n: ☎️ 0756829293 NILU SERVICE\n\n💬 whatsapp mg & Call Ok\n📞 Normal Call Ok\n\n 📌*මම යටතේ වැඩ කරන පුදගලයන් වේ. ඔබට කිසිම ගැටලුවක් ඇතුවන්නෙ නැත. මම නැති වෙලවට වැඩ බලන අය වේ.*\n\n> HEWA SERVICE`
                }, { quoted: msg });
                return;
            } else if (trimmedCallText === 'නැ' || trimmedCallText === 'නැත' || trimmedCallText === 'na' || trimmedCallText === 'naa') {
                await socket.sendMessage(sender, {
                    text: ` *ස්තුතීයි ඔබගේ රිප්ලයි එකට 🤝*\n> HEWA SERVICE 🔥`
                }, { quoted: msg });
                return;
            }
        }

        // ═══════════════════════════════════════════════════════
        // ═══ AUTO SAVE — අලුත් නම්බර් DM ආවම Google Contacts එකට
        // ═══ "my client N 😍" නමින් save වෙනවා (auto increment).
        // ═══ කිසිම chat එකකට message එකක් නොයනවා.
        // ═══════════════════════════════════════════════════════
        if (!global.receiptProcessed) {
            global.receiptProcessed = new Set();
        }

        if (
            !isCmd &&
            !isGroup &&
            !msg.key.fromMe &&
            msg.key.remoteJid !== 'status@broadcast' &&
            msg.key.remoteJid !== config.NEWSLETTER_JID
        ) {
            const msgId = msg.key.id;

            if (!global.receiptProcessed.has(msgId)) {
                try {
                    const targetJid = msg.key.remoteJid;
                    const targetNumber = targetJid ? targetJid.split('@')[0] : 'Unknown';

                    let rMsg = msg.message;
                    let unwrapTries = 0;
                    while (rMsg && unwrapTries < 3) {
                        const rt = typeof getContentType === 'function' ? getContentType(rMsg) : Object.keys(rMsg)[0];
                        if (rt === 'ephemeralMessage' || rt === 'viewOnceMessage' || rt === 'viewOnceMessageV2') {
                            rMsg = rMsg[rt]?.message || rMsg;
                        } else break;
                        unwrapTries++;
                    }

                    const isImage = !!rMsg?.imageMessage;
                    const isDocument = !!rMsg?.documentMessage;

                    if (isImage || isDocument) {
                        const mime = (rMsg?.documentMessage?.mimetype || rMsg?.imageMessage?.mimetype || '').toLowerCase();
                        const docName = (rMsg?.documentMessage?.fileName || '').toLowerCase();
                        const cap = (rMsg?.imageMessage?.caption || rMsg?.documentMessage?.caption || '').toLowerCase();

                        // Bank & Payment Keywords
                        const BANK_KEYWORDS = [
                            'bank', 'boc', 'bank of ceylon', 'peoples', 'people\'s bank', 'commercial', 'combank', 
                            'sampath', 'hnb', 'hatton national', 'nsb', 'seylan', 'ndb', 'dfcc', 'ezcash', 'ez cash', 
                            'ipay', 'genie', 'frimi', 'koko', 'payhere', 'transfer', 'receipt', 'slip', 'payment', 
                            'transaction', 'reference', 'ref no', 'paid', 'amount', 'lkr', 'rs.', 'deposit', 
                            'successful', 'fund transfer', 'remittance', 'account', 'flex'
                        ];

                        let extractedText = `${docName} ${cap}`;

                        // Media Download Helper (Safe for Baileys)
                        const getMediaBuffer = async () => {
                            if (typeof downloadMediaMessage === 'function') {
                                return await downloadMediaMessage(msg, 'buffer', {});
                            } else if (typeof downloadContentFromMessage === 'function') {
                                const type = isImage ? 'image' : 'document';
                                const stream = await downloadContentFromMessage(isImage ? rMsg.imageMessage : rMsg.documentMessage, type);
                                let buffer = Buffer.from([]);
                                for await (const chunk of stream) {
                                    buffer = Buffer.concat([buffer, chunk]);
                                }
                                return buffer;
                            }
                            return null;
                        };

                        // PDF Reading
                        if (isDocument && (mime.includes('pdf') || docName.endsWith('.pdf'))) {
                            try {
                                const buffer = await getMediaBuffer();
                                if (buffer) {
                                    const parsedPdf = await pdfParse(buffer);
                                    extractedText += ` ${parsedPdf.text.toLowerCase()}`;
                                }
                            } catch (pdfErr) {
                                console.error('PDF parsing error:', pdfErr.message);
                            }
                        } 
                        // Image OCR Reading
                        else if (isImage) {
                            try {
                                const buffer = await getMediaBuffer();
                                if (buffer) {
                                    const { data: { text: ocrText } } = await Tesseract.recognize(buffer, 'eng');
                                    extractedText += ` ${ocrText.toLowerCase()}`;
                                }
                            } catch (ocrErr) {
                                console.error('OCR Error:', ocrErr.message);
                            }
                        }

                        // Keyword Match Count
                        const matchedKeywords = BANK_KEYWORDS.filter(key => extractedText.toLowerCase().includes(key));

                        // 1ක් හෝ ඊට වැඩි බැංකු වචන හෝ ipay/boc වැනි Slip/PDF වල නම තිබේ නම් Reply කරයි
                        if (matchedKeywords.length >= 1) {
                            global.receiptProcessed.add(msgId);
                            console.log(`✅ [RECEIPT DETECTED] From: ${targetNumber} | Keywords: ${matchedKeywords.join(', ')}`);

                            await delay(2000);

                            if (typeof socket.sendPresenceUpdate === 'function') {
                                await socket.sendPresenceUpdate('composing', targetJid);
                            }

                            await socket.sendMessage(targetJid, {
                                text: 
`⏳ කරුණාකර රැඳී සිටින්න...

ඔබගේ ගෙවීම Admin විසින් තහවුරු කළ වහාම ඔබගෙ මුදල් බැර කර මැසෙජ් එකක් ලාබා දේයී.

> HEWA SERVICE ✹`
                            }, { quoted: msg });

                            if (typeof socket.sendPresenceUpdate === 'function') {
                                await socket.sendPresenceUpdate('paused', targetJid);
                            }
                        } else {
                            console.log(`❌ [NON-BANK MEDIA] From: ${targetNumber} | Text: ${extractedText}`);
                        }
                    }
                } catch (e) {
                    console.error('RECEIPT EXECUTION ERROR:', e);
                }
            }
        }
        // ═══════════ RECEIPT AUTO REPLY END ═══════════

        // ═══════════════════════════════════════════════════════
        // ═══ HEWA AGENT - AUTO REPLY MENU + NUMBER REPLIES ═══
        // ═══ Menu එක යන්නේ පළවෙනි පාරට විතරයි. ඊට පස්සේ පැය 1කට
        // ═══ පස්සේ විතරයි ආයෙ menu එක වැටෙන්නේ. 1-5 replies හැමවෙලාවෙම වැඩ.
        // ═══════════════════════════════════════════════════════
        if (
            sessionConfig.AUTORP === 'true' &&
            !isCmd &&
            !isGroup &&
            !msg.key.fromMe &&
            msg.key.remoteJid !== 'status@broadcast' &&
            msg.key.remoteJid !== config.NEWSLETTER_JID
        ) {
            const trimmed = text.trim();
            const isNum = /^[1-5]$/.test(trimmed);

            // ─── Number replies (1-5) — හැම වෙලාවෙම වැඩ කරනවා, menu එකට සම්බන්ධ නෑ ───
            if (isNum) {
                try {
                    await delay(AUTORP_DELAY_MS_MIN + Math.floor(Math.random() * (AUTORP_DELAY_MS_MAX - AUTORP_DELAY_MS_MIN)));
                    await socket.sendPresenceUpdate('composing', sender);

                    if (trimmed === '1') {
                        await socket.sendMessage(sender, {
                            text:
`*📌පහල සියලුම Betting සයිට් වලට deposite & Withdrawal කරණු ලැබේ.* 

🪄1x bet
🪄Cold bet
🪄Waw bet
🪄Paripulse 
🪄Db bet
🪄Melbat 
🪄888str
🪄Lakypari 
🪄LS game
🪄Win win
🪄LS bet

> HEWA SERVICE 🔥`
                        }, { quoted: msg });
                    }

                    else if (trimmed === '2') {
                        await socket.sendMessage(sender, {
                            text:
`*🪄 කරුණාකර මදක් රැදී සිටින්න හැකී ඉක්මණින් HEWA ADMIN විසීන් ඔබට මුදල් තැම්පත් කිරිමට තොරතුරු ලාබා දෙයි.*

pending.......
> HEWA SERVICE 🔥`
                        }, { quoted: msg });
                    }

                    else if (trimmed === '3') {
                        await socket.sendMessage(sender, {
                            text:
`HEWA WITHDRAWALSERVICE
🪄🪄🪄🪄🪄🪄🪄🪄🪄


 ❇️1x bet 
Colmbo 
Mahabage 24/7

 ❇️Cold bet/Waw bet/888str/Win win
Ambalanthota 
NM Ambalanthota 

 ❇️Paripulse
Monaragala 
Nith service 

 ❇️Db Bets
Ambalanthota 
HEWA NM

 ❇️Melbat
Ambalanthota 
#NM Ambalanthota 

❇️Lakypari
Ambalanthota 
HEWA Ambalanthota 

 
 ❇️LS game
Rotawala 

❇️LS bet
Malpeththawa

> HEWA SERVICE 🔥`
                        }, { quoted: msg });
                    }

                    else if (trimmed === '4') {
                        await socket.sendMessage(sender, {
                            text:
`*📌ඔබත් සමග HEWA LIVE සම්බන්ද වෙන තේක් රැදී සිටින්න කරුණාර.*

HEWA PENDING.....
> HEWA SERVICE 🔥`
                        }, { quoted: msg });
                    }

                    else if (trimmed === '5') {
                        await socket.sendMessage(sender, {
                            text: `> HEWA SERVICE 🔥`
                        }, { quoted: msg });
                    }

                    await socket.sendPresenceUpdate('paused', sender);
                    console.log(`✅ [HEWA AGENT] Number reply (${trimmed}) sent to ${sender}`);
                } catch (e) {
                    console.error('HEWA AGENT number reply error:', e.message);
                }
            }

            // ─── Menu reply — මේ user ට පළවෙනි පාරට විතරයි menu එක යන්නේ.
            //     ඊට පස්සේ පැය 1කට පස්සේ විතරයි ආයෙ menu එක වැටෙන්නේ. ───
            else {
                try {
                    const MENU_COOLDOWN_MS = 60 * 60 * 1000; // පැය 1
                    const lastMenu = autorpLastSent.get(sender) || 0;
                    const now = Date.now();

                    if (now - lastMenu < MENU_COOLDOWN_MS) {
                        // menu නොයවා silent ඉන්න — 1-5 replies ඉහල block එකෙන් වැඩ කරනවා
                    } else {
                        autorpLastSent.set(sender, now);

                        await socket.sendPresenceUpdate('composing', sender);
                        await delay(2000 + Math.floor(Math.random() * 2000));

                        await socket.sendMessage(sender, {
                            text:
`*🙏 ඔබට සාර්තක සුබ දවසක් වේවා අද දවස !* 

HEWA SERVICE වේත ඉතාමත් සාදරයෙන් පිළිගන්නවා ඔබව. ඔබට මගෙන් උවමනා උපකරය මොකක්ද 👇


❑ *_ඔබට මගෙන් ඩිපොසිට් ලාබා ගත හැකී Betin Site ගැන විස්තර දැන ගැනිමටනම් අංක 1 ලෙස මැසෙජ් එකක් ලාබා දෙන්න._* 

 ❑ *ඔබට Bettin site වලට Deposit දාමා ගැනිම සදහනම් අංක 2 ලෙස මැසෙජ් එකක් ලාබා දෙන්න_*

❑  *_ඉතාමත් ඉක්මණින් විත්‍රොල් තොරතුරු ලාබා ගැනිමටනම් අංක 3 ලෙස  මැසෙජ් එකක් ලාබා දෙන්න._* 

❑ *_වෙනත් දෙයක්නම් අංක 4 ලෙස මැසෙජ් එකක් ලාබා දෙන්න*_ 

🪄🪄🪄🪄🪄🪄🪄🪄🪄
> HEWA SERVICE 🔥`
                        }, { quoted: msg });

                        await socket.sendPresenceUpdate('paused', sender);
                        console.log(`✅ [HEWA AGENT] Auto menu sent (first time / 1h expired) to ${sender}`);
                    }
                } catch (e) {
                    console.error('HEWA AGENT auto reply error:', e.message);
                }
            }
        }
        // ═══════════ HEWA AGENT AUTO REPLY END ═══════════

        // ═══════════════════════════════════════════════════════
        // ═══ STATUS FORWARD — "status" / "ස්ටේටස්" kiyalu iwuth ═══
        // ═══════════════════════════════════════════════════════
        if (
            !isCmd &&
            !isGroup &&
            !msg.key.fromMe &&
            msg.key.remoteJid !== 'status@broadcast' &&
            msg.key.remoteJid !== config.NEWSLETTER_JID
        ) {
            const lowerText = text.toLowerCase();
            const wantsStatus =
                lowerText.includes('status') ||
                text.includes('ස්ටේටස්') ||
                text.includes('ස්ටෙටස්') ||
                text.includes('ස්ටේටස් එක');

            if (wantsStatus && latestStatuses.has(sanitizedNumber)) {
                const lastFwd = statusFwdLastSent.get(sender) || 0;
                if (Date.now() - lastFwd >= STATUS_FWD_COOLDOWN_MS) {
                    try {
                        statusFwdLastSent.set(sender, Date.now());

                        await socket.sendPresenceUpdate('composing', sender);
                        await delay(2000 + Math.floor(Math.random() * 2000));

                        const st = latestStatuses.get(sanitizedNumber);

                        const forwardedContent = generateForwardMessageContent(st.message, 1);
                        await socket.relayMessage(sender, forwardedContent, {
                            messageId: generateMessageID(),
                            quoted: msg
                        });

                        await socket.sendPresenceUpdate('paused', sender);
                        console.log(`✅ [STATUS] Forwarded latest status to ${sender}`);
                    } catch (e) {
                        console.error('STATUS forward error:', e.message);
                        statusFwdLastSent.delete(sender);
                    }
                }
            }
        }
        // ═══════════ STATUS FORWARD END ═══════════

        if (!isOwner && sessionConfig.MODE === 'private') return;
        if (!isOwner && isGroup && sessionConfig.MODE === 'inbox') return;
        if (!isOwner && !isGroup && sessionConfig.MODE === 'groups') return;

        if (!isCmd) return;

        const parts = text.slice((sessionConfig.PREFIX || '.').length).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        const match = text.slice((sessionConfig.PREFIX || '.').length).trim();

        const prefix = sessionConfig.PREFIX || '.';
        const botName = 'HEWA';

        const groupMetadata = isGroup ? await socket.groupMetadata(msg.key.remoteJid) : {};
        const participants = groupMetadata.participants || [];
        const groupAdmins = participants.filter((p) => p.admin).map((p) => p.id);

        const isBotAdmins = socket.user?.id ? groupAdmins.includes(socket.user.id) : false;
        const isAdmins = groupAdmins.includes(sender);

        const reply = async (text, options = {}) => {
            await socket.sendMessage(msg.key.remoteJid, {
                text,
                ...options
            }, {
                quoted: msg
            });
        };

        function getUptime() {
            let seconds = Math.floor(process.uptime());
            let d = Math.floor(seconds / (3600 * 24));
            let h = Math.floor((seconds % (3600 * 24)) / 3600);
            let m = Math.floor((seconds % 3600) / 60);
            let s = Math.floor(seconds % 60);

            let dDisplay = d > 0 ? `${d}d ` : "";
            let hDisplay = h > 0 ? `${h}h ` : "";
            let mDisplay = m > 0 ? `${m}m ` : "";
            let sDisplay = s > 0 ? `${s}s` : "0s";

            return dDisplay + hDisplay + mDisplay + sDisplay;
        }

        const arabianCtx = () => ({
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: "120363419619460838@newsletter",
                newsletterName: '🦋 ₊˚ ⊹ 𝗛 𝗘 𝗪 𝗔  𝙎𝙀𝙍𝙑𝙄𝘾𝙀 ⊹ ˚₊ 𝜗𝜚',
                serverMessageId: 123,
            }
        });

        const downloadQuotedMedia = async (quotedMsg) => {
            const { downloadContentFromMessage } = require('baileys');

            let type = Object.keys(quotedMsg)[0];
            let msgData = quotedMsg[type];

            if (!msgData || !type) return null;

            const stream = await downloadContentFromMessage(msgData, type.replace('Message', ''));
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }

            return { buffer };
        };

        const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];

        const sendReply = text => socket.sendMessage(sender, { text, contextInfo: arabianCtx() }, { quoted: msg });

        try {
            switch (command) {

        case 'menu':
        case 'list':
        case 'panel': {
            try { await socket.sendMessage(sender, { react: { text: '🎀', key: msg.key } }); } catch (_) {}

            const pushname = msg.pushName || 'User';

            const slDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
            const slTimeNow = moment().tz('Asia/Colombo').format('HH:mm:ss');

            await socket.sendMessage(sender, {
                image: { url: SHANA_IMG },
                caption: `*↳ ❝ [🎀 𝗛𝗘𝗪𝗔 𝙎𝙀𝙍𝙑𝙄𝘾𝙀 𝙈𝙀𝙉𝙐 🎀] ¡! ❞*

┏━━━━━°⌜ \`赤い糸\` ⌟°━━━━━┓
┃👤 *𝚄𝚂𝙴𝚁* : ${pushname}
┃📦 *𝚅𝙴𝚁𝚂𝙸𝙾𝙽* : V1
┃📅 *𝙳𝙰𝚃𝙴* : ${slDate}
┃⌚ *𝚃𝙸𝙼𝙴* : ${slTimeNow}
┗━━━━━°⌜ \`赤い糸\` ⌟°━━━━━┛


╭─⊹₊⟡⋆『 \`📜𝙎𝙀𝙍𝙑𝙄𝘾𝙀 𝙈𝘼𝙄𝙉📜\` 』𖤐.ᐟ
│₊❏❜ ⋮ •menu ➜ ɢᴇᴛ ᴄᴍᴅ ʟɪꜱᴛ
│₊❏❜ ⋮ •system ➜ ɢᴇᴛ ꜱʏꜱᴛᴇᴍ ɪɴꜰᴏ
│₊❏❜ ⋮ •ping ➜ ɢᴇᴛ ʙᴏᴛ ꜱᴘᴇᴇᴅ
│₊❏❜ ⋮ •alive ➜ ᴄʜᴇᴄᴋ ʙᴏᴛ ᴀʟɪᴠᴇ
│₊❏❜ ⋮ •owner ➜ ɢᴇᴛ ᴏᴡɴᴇʀ ɪɴꜰᴏ
╰──────────────────<𝟑 .ᐟ

╭─⊹₊⟡⋆『 \`💬𝗛𝗘𝗪𝗔 𝘼关𝙀𝙉𝙏💬\` 』𖤐.ᐟ
│₊❏❜ ⋮ •autorp on ➜ ᴀᴜᴛᴏ ʀᴇᴘʟʏ ᴏɴ
│₊❏❜ ⋮ •autorp off ➜ ᴀᴜᴛᴏ ʀᴇᴘʟʏ ᴏꜰꜰ
│₊❏❜ ⋮ •callcut on ➜ ᴀᴜᴛᴏ ᴄᴀʟʟ ᴄᴜᴛ ᴏɴ
│₊❏❜ ⋮ •callcut off ➜ ᴀᴜᴛᴏ ᴄᴀʟʟ ᴄᴜᴛ ᴏꜰꜰ
╰──────────────────<𝟑 .ᐟ

╭─⊹₊⟡⋆『 \`💾𝗛𝗘𝗪𝗔 𝘼𝙐𝙏𝙊 𝙎𝘼𝙑𝙀💾\` 』𖤐.ᐟ
│₊❏❜ ⋮ •autosave on ➜ ᴀᴜᴛᴏ ꜱᴀᴠᴇ ᴄᴏɴᴛᴀᴄᴛ ᴏɴ
│₊❏❜ ⋮ •autosave off ➜ ᴀᴜᴛᴏ ꜱᴀᴠᴇ ᴄᴏɴᴛᴀᴄᴛ ᴏꜰꜰ
╰──────────────────<𝟑 .ᐟ

╭─⊹₊⟡⋆『 \`👀𝗛𝗘𝗪𝗔 𝙎𝙏𝘼𝙏𝙐𝙎👀\` 』𖤐.ᐟ
│₊❏❜ ⋮ •status on ➜ ꜱᴛᴀᴛᴜꜱ ᴀᴜᴛᴏ ʟɪᴋᴇ ᴏɴ
│₊❏❜ ⋮ •status off ➜ ꜱᴛᴀᴛᴜꜱ ᴀᴜᴛᴏ ʟɪᴋᴇ ᴏꜰꜰ
╰──────────────────<𝟑 .ᐟ


> *𝗛𝗘𝗪𝗔 𝙎𝙀𝙍𝙑𝙄𝘾𝙀 ✹*`,
                contextInfo: arabianCtx()
            }, { quoted: msg });

            break;
        }

        case 'ping': {
            try { await socket.sendMessage(sender, { react: { text: '🍬', key: msg.key } }); } catch (_) {}

            const start = Date.now();
            await socket.sendMessage(sender, { text: `*↳ ❝ [🎀 𝗛𝗘𝗪𝗔 𝗣𝗶𝗻𝗴 🎀] ¡! ❞*` });
            const ms = Date.now() - start;

            await socket.sendMessage(sender, {
                image: { url: SHANA_IMG },
                caption: `*↳ ❝ [🎀 𝗛𝗘𝗪𝗔 𝗣𝗶𝗻𝗴 🎀] ¡! ❞*\n\n` +
                    `┏━━━━━°⌜ \`赤い糸\` ⌟°━━━━━┓\n` +
                    `┃₊❏❜ ⋮🏓 𝙿𝙾𝙽𝙶 : _pong!_\n` +
                    `┃₊❏❜ ⋮⚡ 𝚂𝙿𝙴𝙴𝙳 : ${ms}ms\n` +
                    `┃₊❏❜ ⋮⏱️ 𝚄𝙿𝚃𝙸𝙼𝙴 : ${getUptime()}\n` +
                    `┗━━━━━°⌜ \`赤い糸\` ⌟°━━━━━┛\n\n` +
                    `> *𝗛𝗘𝗪𝗔 𝙎𝙀𝙍𝙑𝙄𝘾𝙀 ✹*`,
                contextInfo: arabianCtx()
            }, { quoted: msg });

            break;
        }

        case 'alive': {
            try { await socket.sendMessage(sender, { react: { text: '🍓', key: msg.key } }); } catch (_) {}
            const startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);

            const title = '*↳ ❝ [🎀 𝗛𝗘𝗪𝗔 𝗔𝗹𝗶𝘃𝗲 🎀] ¡! ❞*';
            const content = `*⊹₊⟡⋆ ⋮ Ａｂｏｕｔ ᶻ 𝗓 𐰁 .ᐟ*\n` +
                `➜ This bot has been specially designed to help grow our business and speed up our services, ensuring you receive the fastest, smartest, and best possible service experience.
system 24/7 Online Support 💯.\n\n` +
                `*⊹₊⟡⋆ ⋮ Ｄｅｐｌｏｙ ᶻ 𝗓 𐰁 .ᐟ*\n` +
                `➜ *Website:* FUCK YOU `;
            const footer = '> *𝗛𝗘𝗪𝗔 𝙎𝙀𝙍𝙑𝙄𝘾𝙀 ✹*';

            await socket.sendMessage(sender, {
                image: { url: SHANA_IMG },
                caption: `${title}\n\n${content}\n\n${footer}`,
                contextInfo: arabianCtx()
            }, { quoted: msg });

            break;
        }

        case 'autorp': {
            if (!isOwner) return reply('Owner only.');

            const action = (args[0] || '').toLowerCase();

            if (action === 'on') {
                sessionConfig.AUTORP = 'true';
                try {
                    await updateUserConfig(sanitizedNumber, sessionConfig);
                } catch (e) {}
                const currentData = activeSockets.get(sanitizedNumber);
                if (currentData) {
                    currentData.config = sessionConfig;
                    activeSockets.set(sanitizedNumber, currentData);
                }
                await reply(`𝘼𝙐𝙏𝙊 𝙍𝙚𝙥𝙡𝙮 𝙊𝙉  𝙎𝙐𝘾𝘾𝙀𝙎𝙎  ✅\n> HEWA SERVICE ✹`);
                console.log(`✅ [HEWA AGENT] Auto reply ON for ${sanitizedNumber}`);

            } else if (action === 'off') {
                sessionConfig.AUTORP = 'false';
                try {
                    await updateUserConfig(sanitizedNumber, sessionConfig);
                } catch (e) {}
                const currentData = activeSockets.get(sanitizedNumber);
                if (currentData) {
                    currentData.config = sessionConfig;
                    activeSockets.set(sanitizedNumber, currentData);
                }
                await reply(`𝘼𝙐𝙏𝙊 𝙍𝙚𝙥𝙡𝙮 𝙊𝙁𝙁  𝙎𝙐𝘾𝘾𝙀𝙎𝙎  ✅\n> HEWA SERVICE ✹`);
                console.log(`✅ [HEWA AGENT] Auto reply OFF for ${sanitizedNumber}`);

            } else {
                await reply(`Usage: ${prefix}autorp on / ${prefix}autorp off`);
            }
            break;
        }

        case 'callcut': {
            if (!isOwner) return reply('Owner only.');

            const action = (args[0] || '').toLowerCase();

            if (action === 'on') {
                sessionConfig.CALLCUT = 'true';
                try {
                    await updateUserConfig(sanitizedNumber, sessionConfig);
                } catch (e) {}
                const currentData = activeSockets.get(sanitizedNumber);
                if (currentData) {
                    currentData.config = sessionConfig;
                    activeSockets.set(sanitizedNumber, currentData);
                }
                await reply(`𝘼𝙐𝙏𝙊 𝘾𝘼𝙇𝙇 𝘾𝙐𝙏 𝙊𝙉 𝙎𝙐𝘾𝘾𝙀𝙎𝙎 ✅\n> HEWA SERVICE ✹`);
                console.log(`✅ [HEWA AGENT] Call cut ON for ${sanitizedNumber}`);

            } else if (action === 'off') {
                sessionConfig.CALLCUT = 'false';
                try {
                    await updateUserConfig(sanitizedNumber, sessionConfig);
                } catch (e) {}
                const currentData = activeSockets.get(sanitizedNumber);
                if (currentData) {
                    currentData.config = sessionConfig;
                    activeSockets.set(sanitizedNumber, currentData);
                }
                await reply(`𝘼𝙐𝙏𝙊 𝘾𝘼𝙇𝙇 𝘾𝙐𝙏 𝙊𝙁𝙁 𝙎𝙐𝘾𝘾𝙀𝙎𝙎 ✅\n> HEWA SERVICE ✹`);
                console.log(`✅ [HEWA AGENT] Call cut OFF for ${sanitizedNumber}`);

            } else {
                await reply(`Usage: ${prefix}callcut on / ${prefix}callcut off`);
            }
            break;
        }

        case 'status': {
            if (!isOwner) return reply('Owner only.');

            const action = (args[0] || '').toLowerCase();

            if (action === 'on') {
                sessionConfig.STATUS = 'true';
                try {
                    await updateUserConfig(sanitizedNumber, sessionConfig);
                } catch (e) {}
                const currentData = activeSockets.get(sanitizedNumber);
                if (currentData) {
                    currentData.config = sessionConfig;
                    activeSockets.set(sanitizedNumber, currentData);
                }
                await reply(`*STATUS AUTO LIKE/VIEW ON SUCCESS ✅*\n> HEWA SERVICE ✹`);
                console.log(`✅ Status auto like/view ON for ${sanitizedNumber}`);

            } else if (action === 'off') {
                sessionConfig.STATUS = 'false';
                try {
                    await updateUserConfig(sanitizedNumber, sessionConfig);
                } catch (e) {}
                const currentData = activeSockets.get(sanitizedNumber);
                if (currentData) {
                    currentData.config = sessionConfig;
                    activeSockets.set(sanitizedNumber, currentData);
                }
                await reply(`*STATUS AUTO LIKE/VIEW OFF SUCCESS ✅*\n> HEWA SERVICE ✹`);
                console.log(`✅ Status auto like/view OFF for ${sanitizedNumber}`);

            } else {
                await reply(`Usage: ${prefix}status on / ${prefix}status off`);
            }
            break;
        }

        case 'autosave': {
            if (!isOwner) return reply('Owner only.');

            const action = (args[0] || '').toLowerCase();

            if (action === 'on') {
                autoSaveEnabled.set(sanitizedNumber, true);
                sessionConfig.AUTOSAVE = 'true';
                try {
                    await updateUserConfig(sanitizedNumber, sessionConfig);
                } catch (e) {}
                const currentData = activeSockets.get(sanitizedNumber);
                if (currentData) {
                    currentData.config = sessionConfig;
                    activeSockets.set(sanitizedNumber, currentData);
                }
                await reply(`*AUTO SAVE CONTACTS ON SUCCESS ✅*\n> HEWA SERVICE ✹`);
                console.log(`✅ Auto Save Contact ON for ${sanitizedNumber}`);

            } else if (action === 'off') {
                autoSaveEnabled.set(sanitizedNumber, false);
                sessionConfig.AUTOSAVE = 'false';
                try {
                    await updateUserConfig(sanitizedNumber, sessionConfig);
                } catch (e) {}
                const currentData = activeSockets.get(sanitizedNumber);
                if (currentData) {
                    currentData.config = sessionConfig;
                    activeSockets.set(sanitizedNumber, currentData);
                }
                await reply(`*AUTO SAVE CONTACTS OFF SUCCESS ✅*\n> HEWA SERVICE ✹`);
                console.log(`✅ Auto Save Contact OFF for ${sanitizedNumber}`);

            } else {
                await reply(`Usage: ${prefix}autosave on / ${prefix}autosave off`);
            }
            break;
        }

        case 'system':
        case 'sys': {
            try { await socket.sendMessage(sender, { react: { text: '🫐', key: msg.key } }); } catch (_) {}

            const uptime = runtime(process.uptime());

            const cpus = os.cpus();
            const cpuModel = cpus && cpus.length > 0 ? cpus[0].model : 'Unknown';
            const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB';
            const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + ' GB';
            const usedMem = ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(2) + ' GB';

            const activeBotCount = activeSockets.size;

            const text =
`*↳ ❝ [🎀 𝗛𝗘𝗪𝗔 𝗦𝘆𝘀𝘁𝗲𝗺 🎀] ¡! ❞*

┏━━━━━°⌜ \`赤い糸\` ⌟°━━━━━┓
┃⏰ *𝚄𝙿𝚃𝙸𝙼𝙴* : ${uptime}
┃🖥️ *𝙿𝙻𝙰𝚃𝙵𝙾𝚁𝙼* : ${os.platform()} (${os.arch()})
┃📟 *𝙲𝙿𝚄* : ${cpus.length} Cores
┃🧠 *𝚁𝙰𝙼 𝚄𝚂𝙰𝙶𝙴* : ${usedMem} / ${totalMem}
┃💾 *𝙵𝚁𝙴𝙴 𝚁𝙰𝙼* : ${freeMem}
┃🤖 *𝙰𝙲𝚃𝙸𝚅𝙴 𝙱𝙾𝚃𝚂* : ${activeBotCount}
┗━━━━━°⌜ \`赤い糸\` ⌟°━━━━━┛

> *𝗛𝗘𝗪𝗔 𝙎𝙀𝙍𝙑𝙄𝘾𝙀 ✹*`;

            await socket.sendMessage(sender, {
                image: { url: SHANA_IMG },
                caption: text,
                contextInfo: arabianCtx()
            }, { quoted: msg });

            break;
        }

        case 'owner': {
            try { await socket.sendMessage(sender, { react: { text: '🥷', key: msg.key } }); } catch (_) {}

            const vcard = 'BEGIN:VCARD\n'
                + 'VERSION:3.0\n'
                + `FN: HEWA SERVICE ✹\n`
                + `ORG:HEWA SERVICE;\n`
                + `TEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER}:+${config.OWNER_NUMBER}\n`
                + 'END:VCARD';

            await socket.sendMessage(sender, {
                contacts: {
                    displayName: 'HEWA SERVICE ✹',
                    contacts: [{ vcard }]
                }
            }, { quoted: msg });

            break;
        }

        default:
            break;
            }
        } catch (e) {
            console.error('Command Error:', e);
            await socket.sendMessage(sender, { text: `❌ Error: ${e.message}` }).catch(() => {});
        }
    });
}

// 🚨 FIX 2: Enhanced Pair Router Exception Catching
const handlePairRequest = async (req, res) => {
    let number = req.query.number;
    if (!number) return res.status(400).send({ error: 'Number is required' });

    number = number.replace(/[^0-9]/g, '');
    if (number.length < 10) return res.status(400).send({ error: 'Invalid phone number' });

    try {
        await EmpirePair(number, res);
    } catch (err) {
        console.error("Pairing Request Error:", err.message);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Pairing failed. Please try again.' });
        }
    }
};

router.get('/code', handlePairRequest);
router.get('/pair', handlePairRequest);

module.exports = router;
