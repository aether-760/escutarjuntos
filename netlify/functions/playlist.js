'use strict';

/*
 * Lê os NOMES das músicas de uma playlist pública (Spotify ou Deezer).
 * Não usa chaves de API. Roda como Netlify Function em /.netlify/functions/playlist
 *
 * - Spotify: lê os dados da página pública de "embed" (a mesma usada pelo player
 *   incorporável do Spotify). Não é uma API oficial e o Spotify pode mudar o
 *   formato a qualquer momento.
 * - Deezer: usa a API pública oficial, que não exige chave para playlists públicas.
 */

const MAX_TRACKS = 300;
const TIMEOUT_MS = 9000;
const UA = 'Mozilla/5.0 (compatible; OuvirJuntos/1.0)';

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5', ...headers }, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function parseLink(raw) {
  const value = String(raw || '').trim();
  let match = value.match(/^spotify:(playlist|album):([A-Za-z0-9]{10,64})$/i);
  if (match) return { service: 'spotify', kind: match[1].toLowerCase(), id: match[2] };
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'open.spotify.com') {
    const index = parts.findIndex((part) => ['playlist', 'album'].includes(part.toLowerCase()));
    const id = index >= 0 ? parts[index + 1] : '';
    if (id && /^[A-Za-z0-9]{10,64}$/.test(id)) return { service: 'spotify', kind: parts[index].toLowerCase(), id };
    return null;
  }
  if (host === 'deezer.com') {
    const index = parts.findIndex((part) => part.toLowerCase() === 'playlist');
    const id = index >= 0 ? parts[index + 1] : '';
    if (id && /^\d{3,20}$/.test(id)) return { service: 'deezer', kind: 'playlist', id };
  }
  return null;
}

function cleanText(value, max) {
  return String(value || '').replace(/[\u00a0\u2009\u200a\s]+/g, ' ').trim().slice(0, max);
}

function findTrackList(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (Array.isArray(node.trackList)) return node;
  for (const key of Object.keys(node)) {
    const found = findTrackList(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

// Exportada para teste.
function parseSpotifyEmbedHtml(html) {
  const match = String(html || '').match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('embed-format');
  let data;
  try { data = JSON.parse(match[1]); } catch (_) { throw new Error('embed-format'); }
  const entity = findTrackList(data);
  if (!entity) throw new Error('embed-format');
  const tracks = [];
  for (const item of entity.trackList) {
    if (!item || !item.title) continue;
    if (item.uri && !/^spotify:track:/i.test(item.uri)) continue;
    tracks.push({ title: cleanText(item.title, 180), artist: cleanText(item.subtitle, 220) || 'Artista não informado' });
    if (tracks.length >= MAX_TRACKS) break;
  }
  return { name: cleanText(entity.name || entity.title, 140), tracks };
}

async function loadSpotify(link) {
  const result = await fetchText(`https://open.spotify.com/embed/${link.kind}/${link.id}`);
  if (result.status === 404) throw Object.assign(new Error('Playlist não encontrada. Ela precisa ser pública.'), { code: 404 });
  if (!result.ok) throw Object.assign(new Error(`O Spotify respondeu com erro ${result.status}.`), { code: 502 });
  let parsed;
  try { parsed = parseSpotifyEmbedHtml(result.text); }
  catch (_) { throw Object.assign(new Error('Não consegui ler essa playlist do Spotify. Ela precisa ser pública, e o Spotify pode ter mudado o formato da página.'), { code: 502 }); }
  if (!parsed.tracks.length) throw Object.assign(new Error('Não encontrei músicas nessa playlist. Ela pode estar vazia ou só ter podcasts.'), { code: 404 });
  return {
    service: 'Spotify',
    name: parsed.name || (link.kind === 'album' ? 'Álbum do Spotify' : 'Playlist do Spotify'),
    sourceUrl: `https://open.spotify.com/${link.kind}/${link.id}`,
    tracks: parsed.tracks
  };
}

async function loadDeezer(link) {
  const meta = await fetchText(`https://api.deezer.com/playlist/${link.id}`);
  let info;
  try { info = JSON.parse(meta.text); } catch (_) { info = null; }
  if (!info || info.error) throw Object.assign(new Error('Playlist do Deezer não encontrada. Ela precisa ser pública.'), { code: 404 });
  const tracks = [];
  let next = `https://api.deezer.com/playlist/${link.id}/tracks?limit=100`;
  let guard = 0;
  while (next && tracks.length < MAX_TRACKS && guard < 6) {
    guard += 1;
    const page = await fetchText(next);
    let data;
    try { data = JSON.parse(page.text); } catch (_) { break; }
    if (!data || data.error || !Array.isArray(data.data)) break;
    for (const item of data.data) {
      if (!item || !item.title) continue;
      tracks.push({ title: cleanText(item.title, 180), artist: cleanText(item.artist && item.artist.name, 220) || 'Artista não informado' });
      if (tracks.length >= MAX_TRACKS) break;
    }
    next = data.next && /^https:\/\/api\.deezer\.com\//.test(data.next) ? data.next : '';
  }
  if (!tracks.length) throw Object.assign(new Error('Não encontrei músicas nessa playlist do Deezer.'), { code: 404 });
  return {
    service: 'Deezer',
    name: cleanText(info.title, 140) || 'Playlist do Deezer',
    sourceUrl: `https://www.deezer.com/playlist/${link.id}`,
    tracks
  };
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') return reply(405, { error: 'Método não permitido.' });
  const link = parseLink(event.queryStringParameters && event.queryStringParameters.url);
  if (!link) return reply(400, { error: 'Link não reconhecido. Use um link de playlist do Spotify ou do Deezer.' });
  try {
    const result = link.service === 'spotify' ? await loadSpotify(link) : await loadDeezer(link);
    return reply(200, result);
  } catch (error) {
    if (error && error.name === 'AbortError') return reply(504, { error: 'O serviço demorou demais para responder. Tente de novo.' });
    return reply(error && error.code ? error.code : 502, { error: (error && error.message) || 'Não consegui ler a playlist.' });
  }
};

exports.parseSpotifyEmbedHtml = parseSpotifyEmbedHtml;
exports.parseLink = parseLink;
