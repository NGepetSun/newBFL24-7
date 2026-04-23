/**
 * ╔══════════════════════════════════════════════════════╗
 * ║    NotiStream by @elvanprmn — ZERO API, 100% Gratis  ║
 * ║    YouTube Live → Discord | Tanpa YouTube API        ║
 * ║    + Channel Manager Dashboard                       ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * CARA KERJA — 2 metode gratis berlapis:
 * ───────────────────────────────────────
 * Metode 1: RSS Feed YouTube (0 quota, update tiap menit)
 * Metode 2: Scraping halaman /live channel
 *
 * Channel disimpan di channels.json — bisa dikelola via dashboard web.
 * Env variable CHANNEL_IDS tetap didukung sebagai seed awal.
 */

const axios   = require('axios');
const express = require('express');
const fs      = require('fs');
const path    = require('path');

// ── CONFIG ─────────────────────────────────────────────
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK  || '';
const RAW_IDS         = process.env.CHANNEL_IDS      || '';
const CHECK_INTERVAL  = parseInt(process.env.CHECK_INTERVAL || '120', 10);
const MENTION         = process.env.MENTION          || '@everyone';
const BOT_NAME        = process.env.BOT_NAME         || 'NotiStream by @elvanprmn';
const BOT_AVATAR      = process.env.BOT_AVATAR       || '';
const PORT            = process.env.PORT             || 3000;

// ── FILE STORAGE ───────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'channels.json');

function loadChannels() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    log('WARN', `Gagal baca channels.json: ${e.message}`);
  }
  return [];
}

function saveChannels(list) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {
    log('ERROR', `Gagal simpan channels.json: ${e.message}`);
  }
}

// Seed dari env variable jika channels.json belum ada
function initChannels() {
  let stored = loadChannels();
  if (stored.length === 0 && RAW_IDS) {
    const fromEnv = RAW_IDS.split(',').map(s => s.trim()).filter(Boolean);
    stored = fromEnv.map(id => ({ id, name: id, addedAt: new Date().toISOString() }));
    saveChannels(stored);
    log('INFO', `Seed ${stored.length} channel dari CHANNEL_IDS env`);
  }
  return stored;
}

// ── STATE ──────────────────────────────────────────────
let channelList = []; // array of { id, name, addedAt }
const state = {};     // state[id] = { name, isLive, videoId, title, lastNotifAt, detectedBy }

let stats = {
  startedAt   : new Date(),
  totalChecks : 0,
  totalNotifs : 0,
  errors      : 0,
  lastCheck   : null,
};

// Headers agar request terlihat seperti browser biasa
const BROWSER_HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language' : 'en-US,en;q=0.9',
  'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ════════════════════════════════════════════════════════
//  METODE 1 — RSS FEED
// ════════════════════════════════════════════════════════

async function checkViaRSS(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const r   = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 12000 });
  const xml = r.data;

  const nameTagMatch = xml.match(/<n>([^<]+)<\/name>/);
  const channelName  = nameTagMatch ? nameTagMatch[1].trim() : null;

  const videoIds = [];
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let m;
  while ((m = re.exec(xml)) !== null) videoIds.push(m[1]);

  if (!videoIds.length) return { isLive: false, channelName };

  const topVideos = videoIds.slice(0, 3);
  for (const vid of topVideos) {
    const live = await checkVideoIsLive(vid);
    if (live) {
      return {
        isLive      : true,
        videoId     : vid,
        channelName,
        title       : live.title,
        streamUrl   : `https://youtu.be/${vid}`,
        detectedBy  : 'RSS+VideoCheck',
      };
    }
  }

  return { isLive: false, channelName };
}

// ════════════════════════════════════════════════════════
//  METODE 2 — SCRAPING /live PAGE
// ════════════════════════════════════════════════════════

async function checkViaLivePage(channelId) {
  let html = null;
  const urls = [`https://www.youtube.com/channel/${channelId}/live`];
  if (!channelId.startsWith('UC')) {
    urls.unshift(`https://www.youtube.com/@${channelId.replace(/^@/, '')}/live`);
  }

  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15000, maxRedirects: 5 });
      html = r.data;
      break;
    } catch (e) {
      log('WARN', `Live page URL gagal (${url}): ${e.message}`);
    }
  }

  if (!html) return { isLive: false };

  const isDefinitelyOffline =
    html.includes('"LIVE_STREAM_OFFLINE"') ||
    html.includes('"status":"OFFLINE"');
  if (isDefinitelyOffline) return { isLive: false };

  let score = 0;
  const reasons = [];

  if (html.includes('"concurrentViewers"'))                   { score += 2; reasons.push('concurrentViewers'); }
  if (html.includes('"isLive":true') && html.includes('"concurrentViewers"')) { score += 2; reasons.push('isLive+viewers'); }
  if (/watching now/i.test(html))                            { score += 2; reasons.push('watchingNow'); }
  if (html.includes('"isLive":true'))                         { score += 1; reasons.push('isLive'); }
  if (html.includes('"broadcastId":"') && !html.includes('"broadcastId":""')) { score += 1; reasons.push('broadcastId'); }
  if (html.includes('hqdefault_live.jpg'))                    { score += 1; reasons.push('liveThumbnail'); }
  if (html.includes('"viewerCount"'))                         { score += 1; reasons.push('viewerCount'); }
  if (html.includes('"LIVE_STREAM_OFFLINE"'))                 { score -= 5; }
  if (html.includes('"isUpcoming":true'))                     { score -= 3; reasons.push('isUpcoming!'); }

  log('DEBUG', `[LIVE-PAGE] ${channelId} score=${score} [${reasons.join(',')}]`);
  if (score < 3) return { isLive: false };

  const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})".*?"isLive":true/) ||
                       html.match(/"isLive":true.*?"videoId":"([a-zA-Z0-9_-]{11})"/) ||
                       html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
  const titleMatch   = html.match(/"text":"([^"]{5,100})".*?"isLive":true/) ||
                       html.match(/<title>([^<]+)<\/title>/);

  const videoId  = videoIdMatch?.[1] || null;
  const rawTitle = titleMatch?.[1] || 'Live Stream';
  const title    = rawTitle.replace(' - YouTube','').trim();

  return {
    isLive    : true,
    videoId,
    title,
    streamUrl : videoId ? `https://youtu.be/${videoId}` : urls[0],
    detectedBy: `LivePage(score=${score})`,
  };
}

// ════════════════════════════════════════════════════════
//  HELPER — Cek video live
// ════════════════════════════════════════════════════════

async function checkVideoIsLive(videoId) {
  try {
    const url  = `https://www.youtube.com/watch?v=${videoId}`;
    const r    = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 10000 });
    const html = r.data;

    const isOffline = html.includes('"LIVE_STREAM_OFFLINE"') ||
                      html.includes('"status":"OFFLINE"') ||
                      html.includes('"broadcastId":""');
    if (isOffline) return null;

    const hasIsLiveTrue      = html.includes('"isLive":true');
    const hasConcurrentView  = html.includes('"concurrentViewers"');
    const hasWatchingNow     = html.includes('watching now') || html.includes('"viewerCount"');
    const hasActiveBroadcast = html.includes('"broadcastId":"') && !html.includes('"broadcastId":""');

    const score = [hasIsLiveTrue, hasConcurrentView, hasWatchingNow, hasActiveBroadcast].filter(Boolean).length;
    if (score < 2) return null;

    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const title      = titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : 'Live Stream';

    log('DEBUG', `[VIDEO-CHECK] ${videoId} score=${score}/4 → LIVE ✅`);
    return { videoId, title };
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════
//  NAMA CHANNEL
// ════════════════════════════════════════════════════════

async function getChannelName(channelId) {
  try {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const r   = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 8000 });
    const xml = r.data;

    const nameTag = xml.match(/<n>([^<]+)<\/name>/);
    if (nameTag && nameTag[1].trim()) return nameTag[1].trim();

    const authorBlock = xml.match(/<author>[\s\S]*?<n>([^<]+)<\/name>[\s\S]*?<\/author>/);
    if (authorBlock && authorBlock[1].trim()) return authorBlock[1].trim();

    return await getChannelNameFromPage(channelId);
  } catch {
    return await getChannelNameFromPage(channelId).catch(() => channelId);
  }
}

async function getChannelNameFromPage(channelId) {
  try {
    const url  = `https://www.youtube.com/channel/${channelId}`;
    const r    = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 10000 });
    const html = r.data;

    const m1 = html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/);
    if (m1) return m1[1];
    const m2 = html.match(/<meta property="og:title" content="([^"]+)"/);
    if (m2) return m2[1];
    const m3 = html.match(/<title>([^<]+)<\/title>/);
    if (m3) return m3[1].replace(/\s*-\s*YouTube\s*$/i, '').trim();

    return channelId;
  } catch {
    return channelId;
  }
}

// ════════════════════════════════════════════════════════
//  CEK CHANNEL
// ════════════════════════════════════════════════════════

async function checkChannelLive(channelId) {
  let result = null;
  let resolvedChannelName = null;

  try {
    result = await checkViaRSS(channelId);
    if (result.channelName) resolvedChannelName = result.channelName;
    if (result.isLive) {
      log('DEBUG', `[RSS] ${channelId} → LIVE ✅ "${result.title}"`);
      return result;
    }
  } catch (e) {
    log('WARN', `RSS gagal (${e.message}) — coba /live page`);
  }

  if (!resolvedChannelName) {
    resolvedChannelName = await getChannelName(channelId).catch(() => null);
  }

  try {
    const liveResult = await checkViaLivePage(channelId);
    if (liveResult.isLive) {
      log('DEBUG', `[LIVE-PAGE] ${channelId} → LIVE ✅`);
      return { ...liveResult, channelName: resolvedChannelName };
    }
  } catch (e) {
    log('WARN', `Live page gagal: ${e.message}`);
  }

  return { isLive: false, channelName: resolvedChannelName };
}

// ════════════════════════════════════════════════════════
//  DISCORD WEBHOOK
// ════════════════════════════════════════════════════════

async function sendDiscordNotif(channelName, streamUrl, isStart) {
  if (!DISCORD_WEBHOOK) { log('WARN', 'DISCORD_WEBHOOK belum diset!'); return; }

  const content = isStart
    ? `${MENTION ? MENTION + '\n' : ''}**${channelName}** Lagi LIVE BROTHER!\n${streamUrl}`
    : `📴 **${channelName}** LIVE SUDAH BERAKHIR.`;

  const payload = { username: BOT_NAME, content };
  if (BOT_AVATAR) payload.avatar_url = BOT_AVATAR;

  await axios.post(DISCORD_WEBHOOK, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  stats.totalNotifs++;
  log('NOTIF', `✅ Discord: "${channelName}" ${isStart ? `is live → ${streamUrl}` : 'ended'}`);
}

// ════════════════════════════════════════════════════════
//  MONITOR LOOP
// ════════════════════════════════════════════════════════

async function checkAll() {
  // Reload dari file setiap siklus agar perubahan dashboard langsung aktif
  channelList = loadChannels();
  const ids   = channelList.map(c => c.id);

  if (!ids.length) { log('WARN', 'Tidak ada channel dipantau!'); return; }

  stats.totalChecks++;
  stats.lastCheck = new Date();
  log('CHECK', `=== Cek #${stats.totalChecks} | ${ids.length} channel ===`);

  for (const id of ids) {
    if (!state[id]) {
      const saved = channelList.find(c => c.id === id);
      state[id] = { name: saved?.name || id, isLive: false, videoId: null, lastNotifAt: null };
    }
    const ch = state[id];

    try {
      const result = await checkChannelLive(id);
      if (result.channelName) {
        ch.name = result.channelName;
        // Update nama di file juga
        const entry = channelList.find(c => c.id === id);
        if (entry && entry.name !== result.channelName) {
          entry.name = result.channelName;
          saveChannels(channelList);
        }
      }

      if (result.isLive && !ch.isLive) {
        ch.isLive = true; ch.videoId = result.videoId; ch.title = result.title; ch.lastNotifAt = new Date();
        log('LIVE', `🔴 ${ch.name} — "${result.title}" [${result.detectedBy}]`);
        await sendDiscordNotif(ch.name, result.streamUrl, true);
      } else if (!result.isLive && ch.isLive) {
        ch.isLive = false; ch.videoId = null; ch.title = null;
        log('END', `📴 ${ch.name} selesai live`);
        await sendDiscordNotif(ch.name, null, false);
      } else if (result.isLive) {
        log('LIVE', `🔴 ${ch.name} masih live — skip notif`);
      } else {
        log('IDLE', `💤 ${ch.name} — tidak live`);
      }
    } catch (err) {
      stats.errors++;
      log('ERROR', `${ch.name}: ${err.message}`);
    }

    await sleep(2000);
  }

  // Hapus state channel yang sudah dihapus
  for (const id of Object.keys(state)) {
    if (!ids.includes(id)) delete state[id];
  }

  log('CHECK', `=== Selesai. Error: ${stats.errors} | Notif: ${stats.totalNotifs} ===`);
}

// ════════════════════════════════════════════════════════
//  HTTP DASHBOARD + API
// ════════════════════════════════════════════════════════

const app = express();
app.use(express.json());

// ── API: GET semua channel ──
app.get('/api/channels', (req, res) => {
  const channels = loadChannels();
  const enriched = channels.map(c => ({
    ...c,
    isLive : state[c.id]?.isLive || false,
    title  : state[c.id]?.title  || null,
  }));
  res.json({ ok: true, channels: enriched });
});

// ── API: Tambah channel ──
app.post('/api/channels', async (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string') return res.status(400).json({ ok: false, error: 'Channel ID wajib diisi' });

  const cleanId = id.trim();
  if (!cleanId.startsWith('UC')) {
    return res.status(400).json({ ok: false, error: 'Channel ID harus diawali UC...' });
  }

  const channels = loadChannels();
  if (channels.find(c => c.id === cleanId)) {
    return res.status(409).json({ ok: false, error: 'Channel sudah ada' });
  }

  // Ambil nama channel dulu
  let name = cleanId;
  try { name = await getChannelName(cleanId); } catch {}

  const entry = { id: cleanId, name, addedAt: new Date().toISOString() };
  channels.push(entry);
  saveChannels(channels);
  channelList = channels;

  log('MGMT', `➕ Tambah channel: ${name} (${cleanId})`);
  res.json({ ok: true, channel: entry });
});

// ── API: Hapus channel ──
app.delete('/api/channels/:id', (req, res) => {
  const cleanId  = decodeURIComponent(req.params.id);
  let channels = loadChannels();
  const before = channels.length;
  channels = channels.filter(c => c.id !== cleanId);

  if (channels.length === before) return res.status(404).json({ ok: false, error: 'Channel tidak ditemukan' });

  saveChannels(channels);
  channelList = channels;
  delete state[cleanId];
  log('MGMT', `🗑️ Hapus channel: ${cleanId}`);
  res.json({ ok: true });
});

// ── DASHBOARD HTML ──
app.get('/', (req, res) => {
  const upSec   = Math.floor((Date.now() - stats.startedAt) / 1000);
  const liveNow = Object.values(state).filter(c => c.isLive);

  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <title>NotiStream — Channel Manager</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:monospace;background:#0a0a0f;color:#e8e8f0;padding:24px;max-width:760px;margin:0 auto;}
    h1{color:#7c3aed;font-size:20px;margin-bottom:2px;}
    .sub{color:#6b6b8a;font-size:12px;margin-bottom:20px;}
    .card{background:#12121a;border:1px solid #2a2a3d;border-radius:12px;padding:18px;margin-bottom:14px;}
    .ct{font-size:11px;color:#6b6b8a;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;}
    .row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1a1a26;font-size:13px;}
    .row:last-child{border-bottom:none;}
    .lb{color:#6b6b8a;} .val{font-weight:700;}
    .g{color:#10b981;} .r{color:#ef4444;} .p{color:#7c3aed;}

    /* Channel list */
    #ch-list{margin-top:4px;}
    .ch{background:#1a1a26;border-radius:8px;padding:10px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;}
    .ch-info{flex:1;min-width:0;}
    .ch-name{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .ch-id{font-size:10px;color:#6b6b8a;margin-top:2px;}
    .ch-title{font-size:10px;color:#ef4444;margin-top:2px;}
    .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px;flex-shrink:0;}
    .badge{font-size:10px;padding:3px 8px;border-radius:10px;font-weight:700;white-space:nowrap;}
    .bl{background:rgba(239,68,68,.15);color:#ef4444;}
    .bi{background:rgba(107,107,138,.15);color:#6b6b8a;}
    .btn-del{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;flex-shrink:0;}
    .btn-del:hover{background:rgba(239,68,68,.25);}

    /* Add form */
    .add-form{display:flex;gap:8px;margin-top:4px;}
    .add-form input{flex:1;background:#1a1a26;border:1px solid #2a2a3d;border-radius:8px;padding:9px 12px;color:#e8e8f0;font-size:13px;font-family:monospace;outline:none;}
    .add-form input:focus{border-color:#7c3aed;}
    .add-form input::placeholder{color:#3a3a5a;}
    .btn-add{background:#7c3aed;border:none;color:#fff;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;}
    .btn-add:hover{background:#6d28d9;}
    .btn-add:disabled{opacity:.5;cursor:not-allowed;}

    .notice{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);border-radius:8px;padding:10px 14px;font-size:12px;color:#10b981;margin-bottom:14px;}
    .toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:700;opacity:0;transition:opacity .3s;pointer-events:none;}
    .toast.show{opacity:1;}
    .toast.ok{background:#10b981;color:#fff;}
    .toast.err{background:#ef4444;color:#fff;}
    #empty{color:#3a3a5a;font-size:13px;padding:12px 0;text-align:center;display:none;}
  </style>
</head>
<body>
  <h1>📡 NotiStream <span style="color:#10b981;font-size:13px">by @elvanprmn</span></h1>
  <div class="sub">YouTube Live → Discord · 100% Tanpa API · Channel Manager</div>

  <div class="notice">✅ Mode ZERO API — Channel disimpan permanen di server. Tidak akan hilang saat deploy ulang.</div>

  <div class="card">
    <div class="ct">Status Bot</div>
    <div class="row"><span class="lb">Status</span><span class="val g">🟢 Online</span></div>
    <div class="row"><span class="lb">Uptime</span><span class="val">${formatUptime(upSec)}</span></div>
    <div class="row"><span class="lb">Sedang Live</span><span class="val ${liveNow.length > 0 ? 'r' : ''}">${liveNow.length > 0 ? '🔴 ' + liveNow.map(c => c.name).join(', ') : '—'}</span></div>
    <div class="row"><span class="lb">Interval Cek</span><span class="val">${CHECK_INTERVAL}s</span></div>
    <div class="row"><span class="lb">Total Pengecekan</span><span class="val">${stats.totalChecks.toLocaleString()}</span></div>
    <div class="row"><span class="lb">Notif Terkirim</span><span class="val p">${stats.totalNotifs}</span></div>
    <div class="row"><span class="lb">Terakhir Cek</span><span class="val">${stats.lastCheck ? stats.lastCheck.toISOString().replace('T',' ').substring(0,19)+' UTC' : 'Belum'}</span></div>
    <div class="row"><span class="lb">Errors</span><span class="val ${stats.errors > 0 ? 'r' : 'g'}">${stats.errors}</span></div>
  </div>

  <div class="card">
    <div class="ct">Tambah Channel</div>
    <div class="add-form">
      <input id="inp-id" type="text" placeholder="Channel ID (contoh: UCxxxxxxxxxxxxxxxxxxxxxxxx)" maxlength="30">
      <button class="btn-add" id="btn-add" onclick="addChannel()">➕ Tambah</button>
    </div>
    <div style="font-size:11px;color:#3a3a5a;margin-top:8px;">Channel ID diawali UC... · Dapatkan dari YouTube Studio atau tools seperti commentpicker.com</div>
  </div>

  <div class="card">
    <div class="ct">Channel Dipantau (<span id="ch-count">…</span>)</div>
    <div id="ch-list"><div style="color:#3a3a5a;font-size:13px;padding:10px 0;">Memuat…</div></div>
    <div id="empty">Belum ada channel. Tambahkan channel di atas.</div>
  </div>

  <div style="text-align:center;color:#2a2a3d;font-size:11px;margin-top:12px">
    NotiStream by @elvanprmn · Railway · ${stats.startedAt.toISOString().replace('T',' ').substring(0,19)} UTC
  </div>

  <div class="toast" id="toast"></div>

<script>
let channels = [];

async function loadChannels() {
  try {
    const r = await fetch('/api/channels');
    const d = await r.json();
    channels = d.channels || [];
    renderChannels();
  } catch(e) {
    document.getElementById('ch-list').innerHTML = '<div style="color:#ef4444;font-size:13px">Gagal memuat channel</div>';
  }
}

function renderChannels() {
  const list = document.getElementById('ch-list');
  const empty = document.getElementById('empty');
  document.getElementById('ch-count').textContent = channels.length;

  if (!channels.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = channels.map(c => \`
    <div class="ch" id="ch-\${c.id}">
      <span class="dot" style="background:\${c.isLive ? '#ef4444' : '#10b981'}"></span>
      <div class="ch-info">
        <div class="ch-name">\${escHtml(c.name)}</div>
        <div class="ch-id">\${c.id}</div>
        \${c.isLive && c.title ? \`<div class="ch-title">🔴 \${escHtml(c.title)}</div>\` : ''}
      </div>
      <span class="badge \${c.isLive ? 'bl' : 'bi'}">\${c.isLive ? '🔴 LIVE' : '💤 Idle'}</span>
      <button class="btn-del" onclick="deleteChannel('\${c.id}', '\${escHtml(c.name)}')">🗑️ Hapus</button>
    </div>
  \`).join('');
}

async function addChannel() {
  const inp = document.getElementById('inp-id');
  const btn = document.getElementById('btn-add');
  const id  = inp.value.trim();

  if (!id) { showToast('Masukkan Channel ID', 'err'); return; }
  if (!id.startsWith('UC')) { showToast('Channel ID harus diawali UC...', 'err'); return; }

  btn.disabled = true;
  btn.textContent = '⏳ Menambahkan…';

  try {
    const r = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const d = await r.json();
    if (d.ok) {
      showToast(\`✅ \${d.channel.name} berhasil ditambahkan!\`, 'ok');
      inp.value = '';
      await loadChannels();
    } else {
      showToast('❌ ' + d.error, 'err');
    }
  } catch(e) {
    showToast('❌ Gagal: ' + e.message, 'err');
  }

  btn.disabled = false;
  btn.textContent = '➕ Tambah';
}

async function deleteChannel(id, name) {
  if (!confirm(\`Hapus channel "\${name}" dari pemantauan?\`)) return;

  try {
    const r = await fetch('/api/channels/' + encodeURIComponent(id), { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) {
      showToast(\`🗑️ \${name} dihapus\`, 'ok');
      await loadChannels();
    } else {
      showToast('❌ ' + d.error, 'err');
    }
  } catch(e) {
    showToast('❌ Gagal: ' + e.message, 'err');
  }
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  setTimeout(() => t.className = 'toast', 3000);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Tambah dengan Enter
document.getElementById('inp-id').addEventListener('keydown', e => {
  if (e.key === 'Enter') addChannel();
});

// Load awal + auto-refresh 30s
loadChannels();
setInterval(loadChannels, 30000);
</script>
</body>
</html>`);
});

app.get('/health', (req, res) => res.json({
  status  : 'ok',
  uptime  : Math.floor((Date.now() - stats.startedAt) / 1000),
  checks  : stats.totalChecks,
  notifs  : stats.totalNotifs,
  channels: loadChannels().length,
  liveNow : Object.values(state).filter(c => c.isLive).map(c => c.name),
}));

// ════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] [${level.padEnd(6)}] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatUptime(s) {
  const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sc=s%60;
  if(d>0) return `${d}d ${h}h ${m}m`;
  if(h>0) return `${h}h ${m}m ${sc}s`;
  return `${m}m ${sc}s`;
}

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════

async function main() {
  log('START', '╔════════════════════════════════════════════╗');
  log('START', '║  NotiStream by @elvanprmn — ZERO API       ║');
  log('START', '║  RSS + Scraping | Channel Manager          ║');
  log('START', '╚════════════════════════════════════════════╝');

  // Init channel dari file / env
  channelList = initChannels();

  log('INFO',  `Channels : ${channelList.length > 0 ? channelList.map(c=>c.id).join(', ') : '⚠️ Belum ada — tambah via dashboard'}`);
  log('INFO',  `Interval : setiap ${CHECK_INTERVAL}s`);
  log('INFO',  `Webhook  : ${DISCORD_WEBHOOK ? '✅ OK' : '⚠️ BELUM DISET'}`);
  log('INFO',  `Storage  : ${DATA_FILE}`);

  if (!DISCORD_WEBHOOK) log('WARN', 'DISCORD_WEBHOOK belum diset! Notif tidak akan terkirim.');

  app.listen(PORT, () => log('SERVER', `Dashboard aktif di port ${PORT}`));

  await sleep(2000);
  await checkAll();
  setInterval(checkAll, CHECK_INTERVAL * 1000);
  log('BOT', `✅ Bot aktif 24/7 — cek setiap ${CHECK_INTERVAL}s — TANPA YouTube API`);
}

main().catch(err => { log('FATAL', err.message); process.exit(1); });
