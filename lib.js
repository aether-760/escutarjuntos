'use strict';

/* Funções puras do Ouvir Juntos (sem acesso à página), para facilitar os testes. */
(function (root) {
  const MAX_PLAYLIST_TRACKS = 300;
  const VARIANT_WORDS = ['remix', 'cover', 'live', 'ao vivo', 'slowed', 'sped up', 'nightcore', 'instrumental', 'karaoke', 'bootleg', 'mashup', 'reverb', '8d', 'acoustic', 'acustico'];

  function normalize(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function cleanTitle(raw) {
    return String(raw || '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/\s[-–—]\s.*$/, ' ')
      .replace(/\b(feat|ft|featuring)\.?\s.*$/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(value) {
    return normalize(value).split(' ').filter(Boolean);
  }

  function jaccard(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    if (!setA.size || !setB.size) return 0;
    let shared = 0;
    setA.forEach((item) => { if (setB.has(item)) shared += 1; });
    return shared / (setA.size + setB.size - shared);
  }

  function titleScore(wanted, candidate) {
    const wantedTokens = tokens(cleanTitle(wanted));
    const parts = String(candidate || '').split(/\s[-–—]\s/).map(cleanTitle).filter(Boolean);
    if (!parts.length) parts.push(cleanTitle(candidate));
    let best = 0;
    parts.forEach((part) => { best = Math.max(best, jaccard(wantedTokens, tokens(part))); });
    return best;
  }

  function hasVariant(raw) {
    const text = ` ${normalize(raw)} `;
    return VARIANT_WORDS.filter((word) => text.includes(` ${normalize(word)} `));
  }

  function artistMatches(wantedArtist, candidate) {
    const first = tokens(String(wantedArtist || '').split(',')[0]);
    if (!first.length) return false;
    const longest = first.reduce((a, b) => (b.length > a.length ? b : a), '');
    const haystack = new Set(tokens(`${candidate.channel || ''} ${candidate.title || ''}`));
    return longest.length >= 2 && haystack.has(longest);
  }

  /* Só aceita automaticamente quando título e artista batem; no resto, deixa para a pessoa escolher. */
  function pickBestAudiusMatch(track, results) {
    const wantedVariants = hasVariant(`${track.title}`);
    let best = null;
    let bestScore = 0;
    (results || []).forEach((candidate) => {
      const extra = hasVariant(candidate.title).filter((word) => !wantedVariants.includes(word));
      if (extra.length) return;
      if (!artistMatches(track.artist, candidate)) return;
      const score = titleScore(track.title, candidate.title);
      if (score >= 0.85 && score > bestScore) { best = candidate; bestScore = score; }
    });
    return best;
  }

  function parsePlaylistLink(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Cole o link de uma playlist.');
    const uri = raw.match(/^spotify:(playlist|album):([A-Za-z0-9]{10,64})$/i);
    if (uri) return { service: 'spotify', kind: uri[1].toLowerCase(), url: `https://open.spotify.com/${uri[1].toLowerCase()}/${uri[2]}` };
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('Esse link não parece válido. Copie o link da playlist e cole aqui.'); }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'open.spotify.com') {
      const index = parts.findIndex((part) => ['playlist', 'album'].includes(part.toLowerCase()));
      const id = index >= 0 ? parts[index + 1] : '';
      if (!id || !/^[A-Za-z0-9]{10,64}$/.test(id)) throw new Error('O link do Spotify precisa apontar para uma playlist ou álbum.');
      const kind = parts[index].toLowerCase();
      return { service: 'spotify', kind, url: `https://open.spotify.com/${kind}/${id}` };
    }
    if (host === 'deezer.com') {
      const index = parts.findIndex((part) => part.toLowerCase() === 'playlist');
      const id = index >= 0 ? parts[index + 1] : '';
      if (!id || !/^\d{3,20}$/.test(id)) throw new Error('O link do Deezer precisa apontar para uma playlist.');
      return { service: 'deezer', kind: 'playlist', url: `https://www.deezer.com/playlist/${id}` };
    }
    if (host === 'audius.co') {
      if (parts.length >= 3 && ['playlist', 'album'].includes(parts[1].toLowerCase())) return { service: 'audius', kind: 'playlist', url: `https://audius.co${url.pathname}` };
      if (parts.length === 2) return { service: 'audius', kind: 'track', url: `https://audius.co${url.pathname}` };
      throw new Error('O link do Audius precisa apontar para uma playlist, um álbum ou uma música.');
    }
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
      throw new Error('Playlists do YouTube não são lidas automaticamente. Use um link do Spotify, Deezer ou Audius, ou cole os nomes das músicas.');
    }
    throw new Error('Link não reconhecido. Use um link de playlist do Spotify, Deezer ou Audius.');
  }

  function parseManualPlaylist(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const tracks = [];
    for (const line of lines) {
      const parts = line.includes('\t') ? line.split('\t').map((part) => part.trim()).filter(Boolean) : line.split(/\s+[—–-]\s+/).map((part) => part.trim()).filter(Boolean);
      const title = parts[0] || '';
      const artist = parts.length >= 3 ? parts[1] : (parts[1] || 'Artista não informado');
      if (!title) continue;
      tracks.push({ title: title.slice(0, 180), artist: artist.slice(0, 220) });
      if (tracks.length >= MAX_PLAYLIST_TRACKS) break;
    }
    return tracks;
  }

  function parseYoutubeVideoId(value) {
    const raw = String(value || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    let url;
    try { url = new URL(raw); } catch (_) { return ''; }
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
    }
    if (!['youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) return '';
    const fromQuery = url.searchParams.get('v') || '';
    if (/^[A-Za-z0-9_-]{11}$/.test(fromQuery)) return fromQuery;
    const parts = url.pathname.split('/').filter(Boolean);
    const marker = parts.findIndex((part) => ['embed', 'shorts', 'live', 'v'].includes(part.toLowerCase()));
    const id = marker >= 0 ? (parts[marker + 1] || '') : '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  }

  function titleFromFilename(name) {
    const base = String(name || '').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/_/g, ' ').replace(/^\s*\d{1,3}[\s.\-)]+(?=\D)/, '').trim();
    const parts = base.split(/\s+[-–—]\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) return { artist: parts[0].slice(0, 220), title: parts.slice(1).join(' - ').slice(0, 180) };
    return { title: (base || 'Música sem nome').slice(0, 180), artist: 'Meu arquivo' };
  }

  /* ---- ID3v2 (nome e artista dentro do mp3) ---- */
  function synchsafe(bytes, pos) {
    return ((bytes[pos] & 0x7f) << 21) | ((bytes[pos + 1] & 0x7f) << 14) | ((bytes[pos + 2] & 0x7f) << 7) | (bytes[pos + 3] & 0x7f);
  }
  function uint32(bytes, pos) {
    return ((bytes[pos] * 0x1000000) + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]));
  }
  function ascii(bytes, pos, length) {
    let out = '';
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[pos + i]);
    return out;
  }
  function decodeId3Text(frame) {
    if (!frame.length) return '';
    const encoding = frame[0];
    let body = frame.subarray(1);
    let label = 'iso-8859-1';
    if (encoding === 1) {
      if (body[0] === 0xfe && body[1] === 0xff) { label = 'utf-16be'; body = body.subarray(2); }
      else if (body[0] === 0xff && body[1] === 0xfe) { label = 'utf-16le'; body = body.subarray(2); }
      else label = 'utf-16le';
    } else if (encoding === 2) label = 'utf-16be';
    else if (encoding === 3) label = 'utf-8';
    let text = '';
    try { text = new TextDecoder(label).decode(body); } catch (_) { return ''; }
    return text.split('\u0000')[0].trim();
  }

  function parseId3(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return {};
    const version = bytes[3];
    if (![2, 3, 4].includes(version)) return {};
    const end = Math.min(bytes.length, 10 + synchsafe(bytes, 6));
    let pos = 10;
    if ((bytes[5] & 0x40) && version >= 3) pos += version === 4 ? synchsafe(bytes, pos) : uint32(bytes, pos) + 4;
    const idLength = version === 2 ? 3 : 4;
    const headerLength = version === 2 ? 6 : 10;
    const out = {};
    while (pos + headerLength <= end) {
      if (bytes[pos] === 0) break;
      const id = ascii(bytes, pos, idLength);
      let size;
      if (version === 2) size = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
      else if (version === 4) size = synchsafe(bytes, pos + 4);
      else size = uint32(bytes, pos + 4);
      const start = pos + headerLength;
      const stop = start + size;
      if (size <= 0 || stop > end) break;
      if (id === 'TIT2' || id === 'TT2') out.title = decodeId3Text(bytes.subarray(start, stop));
      else if (id === 'TPE1' || id === 'TP1') out.artist = decodeId3Text(bytes.subarray(start, stop));
      if (out.title && out.artist) break;
      pos = stop;
    }
    if (out.title) out.title = out.title.slice(0, 180);
    if (out.artist) out.artist = out.artist.slice(0, 220);
    return out;
  }

  function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  const api = { MAX_PLAYLIST_TRACKS, normalize, cleanTitle, titleScore, pickBestAudiusMatch, parsePlaylistLink, parseManualPlaylist, parseYoutubeVideoId, titleFromFilename, parseId3, formatBytes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OJLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
