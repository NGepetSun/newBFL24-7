/**
 * ╔══════════════════════════════════════════════════════╗
 * ║    StreamPulse Bot v4 — ZERO API, 100% Gratis        ║
 * ║    YouTube Live → Discord | Tanpa YouTube API        ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * TIDAK memerlukan YouTube API Key sama sekali.
 *
 * CARA KERJA — 2 metode gratis berlapis:
 * ───────────────────────────────────────
 * Metode 1: RSS Feed YouTube (0 quota, update tiap menit)
 *   → https://youtube.com/feeds/videos.xml?channel_id=UC...
 *   → Ambil video ID terbaru, lalu cek /watch?v=xxx
 *
 * Metode 2: Scraping halaman /live channel
 *   → https://youtube.com/channel/UC.../live
 *   → Jika live: ada "isLiveBroadcast" atau "watching now" di HTML
 *   → Jika tidak live: redirect ke halaman channel biasa
 *
 * Setup di Railway — Environment Variables:
 * ─────────────────────────────────────────
 * DISCORD_WEBHOOK  = https://discord.com/api/webhooks/...
 *
 * CHANNEL_IDS = UCaaa,UCbbb,UCccc
 *   (Channel ID format UC... — pisah koma untuk banyak channel)
 *
 * CHECK_INTERVAL = 120   (detik, default 2 menit)
 * MENTION        = @everyone
 * BOT_NAME       = StreamPulse
 * BOT_AVATAR     = (URL gambar, opsional)
 */

const axios   = require('axios');
const express = require('express');

// ── CONFIG ─────────────────────────────────────────────
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK  || '';
const RAW_IDS         = process.env.CHANNEL_IDS      || '';
const CHECK_INTERVAL  = parseInt(process.env.CHECK_INTERVAL || '120', 10);
const MENTION         = process.env.MENTION          || '@everyone';
const BOT_NAME        = process.env.BOT_NAME         || 'StreamPulse';
const BOT_AVATAR      = process.env.BOT_AVATAR       || '';
const PORT            = process.env.PORT             || 3000;

const CHANNEL_IDS = RAW_IDS.split(',').map(s => s.trim()).filter(Boolean);

// Headers agar request terlihat seperti browser biasa
const BROWSER_HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language' : 'en-US,en;q=0.9',
  'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ── STATE ──────────────────────────────────────────────
const state = {};
// state[id] = { name, handle, isLive, videoId, title, lastNotifAt, lastCheck, detectedBy }

let stats = {
  startedAt   : new Date(),
  totalChecks : 0,
  totalNotifs : 0,
  errors      : 0,
  lastCheck   : null,
};

// ════════════════════════════════════════════════════════
//  METODE 1 — RSS FEED (GRATIS, TANPA API)
//  Baca RSS channel → dapat video ID terbaru
//  Cek apakah video tersebut sedang live
// ════════════════════════════════════════════════════════

async function checkViaRSS(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const r   = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 12000 });
  const xml = r.data;

  // Ambil nama channel dari RSS
  const nameMatch = xml.match(/<title>([^<]+)<\/title>/);
  const channelName = nameMatch ? nameMatch[1].trim() : null;

  // Ambil semua video ID
  const videoIds = [];
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let m;
  while ((m = re.exec(xml)) !== null) videoIds.push(m[1]);

  if (!videoIds.length) return { isLive: false, channelName };

  // Cek 3 video terbaru — apakah ada yang live sekarang
  for (const videoId of videoIds.slice(0, 3)) {
    const live = await checkVideoIsLive(videoId);
    if (live) {
      return {
        isLive      : true,
        videoId,
        channelName,
        title       : live.title,
        streamUrl   : `https://youtu.be/${videoId}`,
        detectedBy  : 'RSS+VideoCheck',
      };
    }
  }

  return { isLive: false, channelName };
}

// ════════════════════════════════════════════════════════
//  METODE 2 — SCRAPING /live PAGE (GRATIS, TANPA API)
//  Buka youtube.com/channel/UC.../live
//  Cek apakah ada tanda-tanda live stream di HTML
// ════════════════════════════════════════════════════════

async function checkViaLivePage(channelId) {
  const url = `https://www.youtube.com/channel/${channelId}/live`;
  const r   = await axios.get(url, {
    headers      : BROWSER_HEADERS,
    timeout      : 15000,
    maxRedirects : 5,
  });
  const html = r.data;

  // Indikator live yang tersembunyi di HTML YouTube:
  const liveIndicators = [
    '"isLive":true',
    '"liveBroadcastDetails"',
    '"watching now"',
    'isLiveBroadcast',
    '"style":"LIVE"',
    '"iconType":"LIVE"',
    'hqdefault_live.jpg',
  ];

  const isLive = liveIndicators.some(indicator => html.includes(indicator));

  if (!isLive) return { isLive: false };

  // Ekstrak video ID dari URL final (setelah redirect)
  const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  const titleMatch   = html.match(/"title":"([^"]+)"/);
  const videoId      = videoIdMatch?.[1] || null;

  return {
    isLive    : true,
    videoId,
    title     : titleMatch?.[1] || 'Live Stream',
    streamUrl : videoId ? `https://youtu.be/${videoId}` : url,
    detectedBy: 'LivePage',
  };
}

// ════════════════════════════════════════════════════════
//  HELPER — Cek apakah video tertentu sedang live
//  Buka halaman watch?v=xxx dan cek HTML-nya
// ════════════════════════════════════════════════════════

async function checkVideoIsLive(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const r   = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 10000 });
    const html = r.data;

    const isLive = html.includes('"isLive":true') ||
                   html.includes('"style":"LIVE"') ||
                   html.includes('isLiveBroadcast') ||
                   html.includes('"liveBroadcastDetails"');

    if (!isLive) return null;

    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const title      = titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : 'Live Stream';

    return { videoId, title };
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════
//  INISIALISASI NAMA CHANNEL (dari RSS, gratis)
// ════════════════════════════════════════════════════════

async function getChannelName(channelId) {
  try {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const r   = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 8000 });
    // <title> pertama di RSS adalah nama channel
    const titles = [];
    const re = /<title>([^<]+)<\/title>/g;
    let m;
    while ((m = re.exec(r.data)) !== null) titles.push(m[1].trim());
    // Index 0 biasanya "YouTube", index 1 adalah nama channel
    return titles.find(t => t !== 'YouTube' && t.length > 0) || channelId;
  } catch {
    return channelId;
  }
}

// ════════════════════════════════════════════════════════
//  FUNGSI UTAMA — Cek channel (RSS dulu, fallback /live)
// ════════════════════════════════════════════════════════

async function checkChannelLive(channelId) {
  let result = null;

  // Coba Metode 1: RSS + video check
  try {
    result = await checkViaRSS(channelId);
    if (result.isLive) {
      log('DEBUG', `[RSS] ${channelId} → LIVE ✅ "${result.title}"`);
      return result;
    }
  } catch (e) {
    log('WARN', `RSS gagal (${e.message}) — coba /live page`);
  }

  // Coba Metode 2: Scraping /live page sebagai konfirmasi / fallback
  try {
    const liveResult = await checkViaLivePage(channelId);
    if (liveResult.isLive) {
      log('DEBUG', `[LIVE-PAGE] ${channelId} → LIVE ✅`);
      return { ...liveResult, channelName: result?.channelName };
    }
  } catch (e) {
    log('WARN', `Live page gagal: ${e.message}`);
  }

  return { isLive: false, channelName: result?.channelName };
}

// ════════════════════════════════════════════════════════
//  DISCORD WEBHOOK
// ════════════════════════════════════════════════════════

async function sendDiscordNotif(channelName, streamUrl, isStart) {
  if (!DISCORD_WEBHOOK) {
    log('WARN', 'DISCORD_WEBHOOK belum diset!'); return;
  }
  const content = isStart
    ? `${MENTION ? MENTION + '\n' : ''}**${channelName}** is live!\n${streamUrl}`
    : `📴 **${channelName}** has ended the stream.`;

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
  if (!CHANNEL_IDS.length) {
    log('WARN', 'CHANNEL_IDS tidak diset!'); return;
  }
  stats.totalChecks++;
  stats.lastCheck = new Date();
  log('CHECK', `=== Cek #${stats.totalChecks} | ${CHANNEL_IDS.length} channel ===`);

  for (const id of CHANNEL_IDS) {
    // Init state
    if (!state[id]) {
      const name = await getChannelName(id);
      state[id]  = { name, isLive: false, videoId: null, lastNotifAt: null };
      log('INFO', `📺 Terdaftar: ${name} (${id})`);
    }
    const ch = state[id];

    try {
      const result = await checkChannelLive(id);

      // Update nama channel jika dapat dari RSS
      if (result.channelName) ch.name = result.channelName;

      if (result.isLive && !ch.isLive) {
        // Baru live!
        ch.isLive      = true;
        ch.videoId     = result.videoId;
        ch.title       = result.title;
        ch.lastNotifAt = new Date();
        log('LIVE', `🔴 ${ch.name} — "${result.title}" [${result.detectedBy}]`);
        await sendDiscordNotif(ch.name, result.streamUrl, true);

      } else if (!result.isLive && ch.isLive) {
        // Selesai live
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

    // Jeda 2 detik antar channel agar tidak dianggap spam
    await sleep(2000);
  }

  log('CHECK', `=== Selesai. Error: ${stats.errors} | Notif: ${stats.totalNotifs} ===`);
}

// ════════════════════════════════════════════════════════
//  HTTP DASHBOARD (Railway butuh server HTTP)
// ════════════════════════════════════════════════════════

const app = express();

app.get('/', (req, res) => {
  const upSec   = Math.floor((Date.now() - stats.startedAt) / 1000);
  const liveNow = Object.values(state).filter(c => c.isLive);

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>StreamPulse Bot v4</title>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="30">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:monospace;background:#0a0a0f;color:#e8e8f0;padding:28px;max-width:720px;margin:0 auto;}
    h1{color:#7c3aed;font-size:22px;margin-bottom:4px;}
    .sub{color:#6b6b8a;font-size:12px;margin-bottom:24px;}
    .card{background:#12121a;border:1px solid #2a2a3d;border-radius:12px;padding:20px;margin-bottom:14px;}
    .ct{font-size:11px;color:#6b6b8a;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;}
    .row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #1a1a26;font-size:13px;}
    .row:last-child{border-bottom:none;}
    .lb{color:#6b6b8a;} .val{font-weight:700;}
    .g{color:#10b981;} .r{color:#ef4444;} .p{color:#7c3aed;}
    .ch{background:#1a1a26;border-radius:8px;padding:10px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;}
    .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px;}
    .badge{font-size:10px;padding:3px 8px;border-radius:10px;font-weight:700;}
    .bl{background:rgba(239,68,68,.15);color:#ef4444;}
    .bi{background:rgba(107,107,138,.15);color:#6b6b8a;}
    .notice{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);border-radius:8px;padding:12px 14px;font-size:12px;color:#10b981;margin-bottom:14px;}
  </style>
</head>
<body>
  <h1>📡 StreamPulse Bot <span style="color:#10b981;font-size:14px">v4</span></h1>
  <div class="sub">YouTube Live → Discord · 100% Tanpa API · Auto-refresh 30s</div>

  <div class="notice">✅ Mode ZERO API — Tidak menggunakan YouTube Data API. Gratis selamanya, tanpa quota.</div>

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
    <div class="ct">Channel Dipantau (${CHANNEL_IDS.length})</div>
    ${CHANNEL_IDS.map(id => {
      const ch = state[id];
      return `<div class="ch">
        <div>
          <span class="dot" style="background:${ch?.isLive ? '#ef4444' : '#10b981'}"></span>
          <span>${ch?.name || id}</span>
          ${ch?.isLive && ch.title ? `<div style="font-size:11px;color:#6b6b8a;margin-top:3px;padding-left:16px">"${ch.title}"</div>` : ''}
        </div>
        <span class="badge ${ch?.isLive ? 'bl' : 'bi'}">${ch?.isLive ? '🔴 LIVE' : '💤 Idle'}</span>
      </div>`;
    }).join('')}
  </div>

  <div style="text-align:center;color:#2a2a3d;font-size:11px;margin-top:12px">
    StreamPulse v4 · Railway · ${stats.startedAt.toISOString().replace('T',' ').substring(0,19)} UTC
  </div>
</body>
</html>`);
});

app.get('/health', (req, res) => res.json({
  status  : 'ok',
  uptime  : Math.floor((Date.now() - stats.startedAt) / 1000),
  checks  : stats.totalChecks,
  notifs  : stats.totalNotifs,
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
  if(d>0) return `${d}h ${h}j ${m}m`;
  if(h>0) return `${h}j ${m}m ${sc}d`;
  return `${m}m ${sc}d`;
}

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════

async function main() {
  log('START', '╔════════════════════════════════════════════╗');
  log('START', '║  StreamPulse Bot v4 — ZERO API Mode        ║');
  log('START', '║  RSS + Scraping | Tanpa YouTube API Key    ║');
  log('START', '╚════════════════════════════════════════════╝');
  log('INFO',  `Channels : ${CHANNEL_IDS.length > 0 ? CHANNEL_IDS.join(', ') : '⚠️ BELUM DISET — isi CHANNEL_IDS'}`);
  log('INFO',  `Interval : setiap ${CHECK_INTERVAL}s`);
  log('INFO',  `Webhook  : ${DISCORD_WEBHOOK ? '✅ OK' : '⚠️ BELUM DISET'}`);
  log('INFO',  `Mode     : ZERO API — tanpa YouTube API Key`);

  if (!DISCORD_WEBHOOK) log('WARN', 'DISCORD_WEBHOOK belum diset! Notif tidak akan terkirim.');
  if (!CHANNEL_IDS.length) log('WARN', 'CHANNEL_IDS belum diset! Isi di Railway Variables.');

  app.listen(PORT, () => log('SERVER', `Dashboard di port ${PORT}`));

  await sleep(2000);
  await checkAll();
  setInterval(checkAll, CHECK_INTERVAL * 1000);
  log('BOT', `✅ Bot aktif 24/7 — cek setiap ${CHECK_INTERVAL}s — TANPA YouTube API`);
}

main().catch(err => { log('FATAL', err.message); process.exit(1); });
