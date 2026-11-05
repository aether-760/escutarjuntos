'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const lib = window.OJLib;
  const config = window.APP_CONFIG || {};

  const ui = {
    statusDot: $('statusDot'), statusText: $('statusText'),
    createRoomButton: $('createRoomButton'), joinRoomButton: $('joinRoomButton'),
    roomCodeInput: $('roomCodeInput'), roomActions: $('roomActions'), roomLive: $('roomLive'),
    roomRole: $('roomRole'), roomCodeDisplay: $('roomCodeDisplay'), roomHint: $('roomHint'),
    memberCount: $('memberCount'), roomFootnote: $('roomFootnote'),
    copyInviteButton: $('copyInviteButton'), copyRoomCodeButton: $('copyRoomCodeButton'), leaveRoomButton: $('leaveRoomButton'),
    playlistForm: $('playlistForm'), spotifyUrlInput: $('spotifyUrlInput'), loadPlaylistButton: $('loadPlaylistButton'),
    addFilesButton: $('addFilesButton'), addFilesInput: $('addFilesInput'), trackFileInput: $('trackFileInput'),
    addFolderButton: $('addFolderButton'), addFolderInput: $('addFolderInput'),
    hostControls: $('hostControls'), playAllButton: $('playAllButton'), prevButton: $('prevButton'), nextButton: $('nextButton'), shuffleButton: $('shuffleButton'),
    manualTrackList: $('manualTrackList'), importManualButton: $('importManualButton'),
    playerEmpty: $('playerEmpty'), playerWrap: $('playerWrap'), youtubeEmbed: $('youtubeEmbed'),
    audioWrap: $('audioWrap'), audioPlayer: $('audioPlayer'), fileAudio: $('fileAudio'),
    playlistTitle: $('playlistTitle'), playlistCount: $('playlistCount'), spotifySourceLink: $('spotifySourceLink'),
    nowPlayingTitle: $('nowPlayingTitle'), nowPlayingArtist: $('nowPlayingArtist'), playingEqualizer: $('playingEqualizer'),
    playPauseButton: $('playPauseButton'), syncButton: $('syncButton'), playbackStatus: $('playbackStatus'),
    playerTip: $('playerTip'), playlistList: $('playlistList'), playlistSourceLabel: $('playlistSourceLabel'), notice: $('notice')
  };

  const AUDIUS_API = 'https://api.audius.co/v1';
  const AUDIUS_APP = 'OUVIR_JUNTOS';
  const MAX_PLAYLIST_TRACKS = lib.MAX_PLAYLIST_TRACKS;
  const MAX_FILE_BYTES = 60 * 1024 * 1024;
  const FILE_CHUNK_BYTES = Math.min(48 * 1024, Math.max(4 * 1024, Number(config.FILE_CHUNK_BYTES) || 16 * 1024));
  const FILE_RATE_BPS = Math.max(64, Number(config.FILE_RATE_KBPS) || 900) * 1024; // velocidade máxima de envio (bytes/s)
  const SEND_BURST_BYTES = 128 * 1024;
  const SEND_BUFFER_LIMIT = 768 * 1024;
  const PREFETCH_AHEAD = 2;
  const STALL_MS = 3200;
  const MAX_IDLE_TRIES = 8;
  const DRIFT_YOUTUBE = 2.5;
  const DRIFT_AUDIO = 1.2;
  const LATENCY_GUESS = 0.15;

  const state = {
    room: null,
    hostConnection: null,
    roomId: null,
    isHost: false,
    connected: false,
    inviteUrl: null,
    joinSeq: 0,
    playlist: [],
    playlistName: '',
    playlistSourceUrl: '',
    playlistSource: '',
    currentTrackIndex: -1,
    roomPlayback: null,
    activeEngine: null,
    audioKeys: { audio: '', file: '' },
    audioPendingSeek: { audio: null, file: null },
    youtubePlayer: null,
    youtubePlayerPromise: null,
    youtubeReady: false,
    youtubeApiPromise: null,
    userActivatedPlayback: false,
    localPlaybackPaused: false,
    suppressPlayerEventsUntil: 0,
    searchResults: new Map(),
    searchInProgress: new Set(),
    playlistRevision: 0,
    matchRun: 0,
    files: new Map(),
    incoming: new Map(),
    fileProgress: new Map(),
    hostJobs: new Map(),
    hostPumping: false,
    fileWatchdog: null,
    unlocked: { audio: false, file: false },
    pendingFileTrackIndex: -1,
    shuffle: false,
    order: [],
    orderPos: -1,
    renderTimer: null,
    syncTimer: null,
    lastBroadcastAt: 0,
    lastUpcoming: null
  };

  /* ------------------------------------------------------------------ */
  /* Mensagens e utilidades                                              */
  /* ------------------------------------------------------------------ */

  function setNotice(message, type = '') {
    ui.notice.textContent = message || '';
    ui.notice.className = `notice${type ? ` ${type}` : ''}`;
    ui.notice.hidden = !message;
  }

  function setStatus(message, online = false) {
    ui.statusText.textContent = message;
    ui.statusDot.classList.toggle('online', Boolean(online));
  }

  function setPlaybackStatus(message) { ui.playbackStatus.textContent = message; }

  function setPlayerPlaying(playing) {
    ui.playingEqualizer.classList.toggle('paused', !playing);
    ui.playPauseButton.textContent = playing ? 'Ⅱ Pausar neste dispositivo' : '▶ Ativar meu player';
  }

  function sleep(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

  function randomId(length = 16) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  }

  // Aceita o link inteiro, o código puro, ou até uma mensagem de WhatsApp com o
  // link no meio ("Entra aí: https://...?sala=UJ-ABCD2345 vamos!").
  function normalizedRoomCode(value) {
    let raw = String(value || '').trim();
    if (!raw) return '';
    try { raw = decodeURIComponent(raw); } catch (_) { /* mantém o texto original */ }
    const found = raw.match(/\bUJ[\s_-]?([A-Za-z0-9]{8})(?![A-Za-z0-9])/i);
    if (found) return `UJ-${found[1].toUpperCase()}`;
    const param = raw.match(/[?&#]sala=([^&#\s]+)/i);
    if (param) return param[1].trim().toUpperCase();
    return raw.replace(/\s+/g, '').toUpperCase();
  }

  function isPlaylistController() { return !state.connected || state.isHost; }

  function scheduleRender() {
    if (state.renderTimer) return;
    state.renderTimer = window.setTimeout(() => { state.renderTimer = null; renderPlaylist(); }, 350);
  }

  /* ------------------------------------------------------------------ */
  /* Faixas e fontes                                                     */
  /* ------------------------------------------------------------------ */

  function newTrack(title, artist, sourceUrl = '', src = null) {
    return { title: String(title || 'Sem título').slice(0, 180), artist: String(artist || 'Artista não informado').slice(0, 220), sourceUrl, src };
  }

  function srcKey(src) {
    if (!src) return '';
    return src.type === 'file' ? `file:${src.fileId}` : `${src.type}:${src.id}`;
  }

  function trackReady(track) {
    if (!track || !track.src) return false;
    if (track.src.type === 'file') return state.files.has(track.src.fileId);
    return true;
  }

  /* youtube | audio (Audius) | file (mp3 que fica na memória do aparelho) */
  function engineFor(track) {
    const src = track && track.src;
    if (!src) return null;
    if (src.type === 'youtube') return 'youtube';
    if (src.type === 'audius') return 'audio';
    return 'file';
  }

  function isAudioEngine(engine) { return engine === 'audio' || engine === 'file'; }
  function elFor(engine) { return engine === 'audio' ? ui.audioPlayer : engine === 'file' ? ui.fileAudio : null; }

  function sanitizeSrc(src) {
    if (!src || typeof src !== 'object') return null;
    const label = String(src.label || '').slice(0, 200);
    if (src.type === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(String(src.id))) return { type: 'youtube', id: String(src.id), label };
    if (src.type === 'audius' && /^[A-Za-z0-9]{3,24}$/.test(String(src.id))) return { type: 'audius', id: String(src.id), label };
    if (src.type === 'file' && /^[a-z0-9]{6,32}$/.test(String(src.fileId))) {
      return { type: 'file', fileId: String(src.fileId), name: String(src.name || '').slice(0, 200), size: Math.max(0, Number(src.size) || 0), mime: String(src.mime || '').slice(0, 80) };
    }
    return null;
  }

  function sanitizePlaylist(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, MAX_PLAYLIST_TRACKS).map((item) => {
      const sourceUrl = item && typeof item.sourceUrl === 'string' && /^https:\/\//i.test(item.sourceUrl) ? item.sourceUrl.slice(0, 300) : '';
      return newTrack(item && item.title, item && item.artist, sourceUrl, sanitizeSrc(item && item.src));
    });
  }

  function sourceChip(track, index) {
    const src = track.src;
    if (!src) return { text: 'Sem fonte ainda', cls: 'chip-empty' };
    if (src.type === 'audius') return { text: 'Sem anúncios · Audius', cls: 'chip-good' };
    if (src.type === 'youtube') return { text: 'YouTube · pode ter anúncios', cls: 'chip-warn' };
    if (state.files.has(src.fileId)) return { text: 'mp3 pronto', cls: 'chip-good' };
    const pct = state.fileProgress.get(src.fileId);
    if (isPlaylistController()) return { text: 'mp3 indisponível', cls: 'chip-warn' };
    return pct !== undefined ? { text: `Chegando… ${pct}%`, cls: 'chip-warn' } : { text: 'mp3 · chega quando for tocar', cls: 'chip-good' };
  }

  function pruneFiles() {
    const used = new Set(state.playlist.filter((track) => track.src && track.src.type === 'file').map((track) => track.src.fileId));
    for (const [fileId, file] of state.files.entries()) {
      if (!used.has(fileId)) {
        if (file.url) { try { URL.revokeObjectURL(file.url); } catch (_) { /* */ } }
        state.files.delete(fileId);
        state.fileProgress.delete(fileId);
      }
    }
    for (const fileId of Array.from(state.incoming.keys())) {
      if (!used.has(fileId)) dropIncoming(fileId);
    }
  }

  function resetPlaylistSearchState() {
    state.playlistRevision += 1;
    state.matchRun += 1;
    state.searchResults.clear();
    state.searchInProgress.clear();
  }

  function stopEngines() {
    suppressPlayerEvents(2200);
    [ui.audioPlayer, ui.fileAudio].forEach((el) => { try { el.pause(); } catch (_) { /* */ } });
    try { if (state.youtubePlayer && state.youtubeReady) state.youtubePlayer.pauseVideo(); } catch (_) { /* */ }
    state.activeEngine = null;
    ui.youtubeEmbed.hidden = true;
    ui.audioWrap.hidden = true;
    ui.playPauseButton.disabled = true;
    ui.syncButton.disabled = true;
    setPlayerPlaying(false);
  }

  /* ------------------------------------------------------------------ */
  /* Lista de faixas (tela)                                              */
  /* ------------------------------------------------------------------ */

  function renderPlaylist() {
    const hasTracks = state.playlist.length > 0;
    ui.playerEmpty.hidden = hasTracks;
    ui.playerWrap.hidden = !hasTracks;
    if (!hasTracks) return;

    const controller = isPlaylistController();
    ui.playlistTitle.textContent = state.playlistName || 'Playlist';
    const ready = state.playlist.filter((track) => (controller ? trackReady(track) : Boolean(track.src))).length;
    ui.hostControls.hidden = !controller;
    updateShuffleButton();
    ui.playlistCount.textContent = `${state.playlist.length} ${state.playlist.length === 1 ? 'faixa' : 'faixas'} · ${ready} ${ready === 1 ? 'pronta' : 'prontas'} para tocar`;
    ui.spotifySourceLink.hidden = !state.playlistSourceUrl;
    if (state.playlistSourceUrl) ui.spotifySourceLink.href = state.playlistSourceUrl;
    ui.playlistSourceLabel.textContent = state.playlistSource || 'Lista';
    ui.playlistList.replaceChildren();

    state.playlist.forEach((track, index) => {
      const item = document.createElement('li');
      item.className = `track-item${index === state.currentTrackIndex ? ' current' : ''}`;

      const info = document.createElement('div');
      info.className = 'track-info';
      const title = document.createElement('strong');
      title.textContent = `${index + 1}. ${track.title}`;
      const artist = document.createElement('span');
      artist.textContent = track.artist;
      info.append(title, artist);

      const actions = document.createElement('div');
      actions.className = 'track-actions';
      const chipInfo = sourceChip(track, index);
      const chip = document.createElement('span');
      chip.className = `source-chip ${chipInfo.cls}`;
      chip.textContent = chipInfo.text;
      actions.appendChild(chip);

      if (controller) {
        const searching = state.searchInProgress.has(index);
        const audiusButton = document.createElement('button');
        audiusButton.type = 'button';
        audiusButton.className = 'button button-quiet track-search-button';
        audiusButton.textContent = searching ? 'Buscando…' : 'Sem anúncios';
        audiusButton.title = 'Procurar uma versão gratuita e sem anúncios no Audius';
        audiusButton.disabled = searching;
        audiusButton.addEventListener('click', () => searchAudiusForTrack(index));

        const fileButton = document.createElement('button');
        fileButton.type = 'button';
        fileButton.className = 'button button-quiet track-search-button';
        fileButton.textContent = 'Meu mp3';
        fileButton.title = 'Enviar um arquivo de áudio seu para esta faixa';
        fileButton.addEventListener('click', () => { state.pendingFileTrackIndex = index; ui.trackFileInput.value = ''; ui.trackFileInput.click(); });

        const youtubeButton = document.createElement('button');
        youtubeButton.type = 'button';
        youtubeButton.className = 'button button-quiet track-search-button';
        youtubeButton.textContent = 'YouTube';
        youtubeButton.title = 'Usar um vídeo do YouTube (pode ter anúncios)';
        youtubeButton.addEventListener('click', () => searchYoutubeForTrack(index));

        if (!(track.src && track.src.type === 'file')) actions.append(audiusButton, fileButton, youtubeButton);
        if (track.src && trackReady(track)) {
          const playButton = document.createElement('button');
          playButton.type = 'button';
          playButton.className = 'button button-secondary track-play-button';
          playButton.textContent = index === state.currentTrackIndex ? 'Recarregar' : 'Tocar';
          playButton.addEventListener('click', () => playTrack(index));
          actions.appendChild(playButton);
        }
      }

      item.append(info, actions);

      const candidates = state.searchResults.get(index);
      if (candidates && candidates.length && controller) {
        const candidateWrap = document.createElement('div');
        candidateWrap.className = 'candidate-list';
        const candidateHeading = document.createElement('span');
        candidateHeading.className = 'candidate-heading';
        candidateHeading.textContent = 'Escolha a versão correta (confira se é mesmo a música):';
        candidateWrap.appendChild(candidateHeading);
        candidates.forEach((candidate) => {
          const candidateButton = document.createElement('button');
          candidateButton.type = 'button';
          candidateButton.className = 'candidate-button';
          candidateButton.textContent = `${candidate.title} · ${candidate.channel}`;
          candidateButton.addEventListener('click', () => {
            state.searchResults.delete(index);
            selectSource(index, { type: candidate.type, id: candidate.id, label: `${candidate.title} · ${candidate.channel}`.slice(0, 200) }, true);
          });
          candidateWrap.appendChild(candidateButton);
        });
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'candidate-button candidate-dismiss';
        dismiss.textContent = 'Nenhuma é a certa';
        dismiss.addEventListener('click', () => { state.searchResults.delete(index); renderPlaylist(); });
        candidateWrap.appendChild(dismiss);
        item.appendChild(candidateWrap);
      }

      ui.playlistList.appendChild(item);
    });
  }

  function selectSource(index, src, autoplay) {
    const track = state.playlist[index];
    if (!track || !src) return;
    track.src = src;
    renderPlaylist();
    broadcastPlaylist();
    if (autoplay) playTrack(index);
    else setNotice(`Fonte definida para “${track.title}”.`, 'success');
  }

  /* ------------------------------------------------------------------ */
  /* Importação de playlists                                             */
  /* ------------------------------------------------------------------ */

  function applyImportedPlaylist({ name, service, sourceUrl, tracks }) {
    resetPlaylistSearchState();
    stopEngines();
    state.playlist = tracks.slice(0, MAX_PLAYLIST_TRACKS);
    state.playlistName = name;
    state.playlistSource = service;
    state.playlistSourceUrl = sourceUrl || '';
    state.currentTrackIndex = -1;
    state.roomPlayback = null;
    state.order = [];
    state.orderPos = -1;
    pruneFiles();
    renderPlaylist();
    broadcastPlaylist();
    setPlaybackStatus('Escolha uma faixa pronta e clique em “Tocar”, ou use “Tocar tudo”.');
  }

  async function importViaServer(link) {
    let response;
    try { response = await fetch(`/.netlify/functions/playlist?url=${encodeURIComponent(link.url)}`, { cache: 'no-store' }); }
    catch (_) { throw new Error('Não consegui falar com o servidor do site. Confira sua internet e tente de novo.'); }
    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!data) throw new Error('A leitura automática de playlists não está ativa neste site (a função “playlist” do Netlify não foi publicada). Enquanto isso, use “Prefere colar os nomes das músicas?”.');
    if (!response.ok || data.error) throw new Error(data.error || 'Não consegui ler essa playlist.');
    const tracks = (data.tracks || []).map((track) => newTrack(track.title, track.artist)).filter((track) => track.title);
    if (!tracks.length) throw new Error('Não encontrei músicas nessa playlist.');
    return { name: String(data.name || 'Playlist').slice(0, 140), service: String(data.service || 'Playlist'), sourceUrl: /^https:\/\//.test(data.sourceUrl || '') ? data.sourceUrl : '', tracks };
  }

  async function audiusFetch(path, params = {}) {
    const url = new URL(`${AUDIUS_API}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    url.searchParams.set('app_name', AUDIUS_APP);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`audius-${response.status}`);
      return await response.json();
    } finally { window.clearTimeout(timer); }
  }

  function audiusUsable(item) {
    return item && item.id && item.is_streamable !== false && !item.is_stream_gated && !item.is_delete && !item.is_unlisted;
  }

  function audiusCandidate(item) {
    return {
      type: 'audius',
      id: String(item.id),
      title: String(item.title || 'Sem título').slice(0, 180),
      channel: String((item.user && item.user.name) || 'Audius').slice(0, 100)
    };
  }

  async function audiusSearch(title, artist, limit = 6) {
    const firstArtist = String(artist || '').split(',')[0].trim();
    const cleaned = lib.cleanTitle(title) || title;
    let data = await audiusFetch('/tracks/search', { query: `${cleaned} ${firstArtist}`.trim(), limit });
    let items = (data.data || []).filter(audiusUsable);
    if (!items.length && firstArtist) {
      data = await audiusFetch('/tracks/search', { query: cleaned, limit });
      items = (data.data || []).filter(audiusUsable);
    }
    return items.map(audiusCandidate);
  }

  async function importAudius(link) {
    const resolved = await audiusFetch('/resolve', { url: link.url });
    const item = Array.isArray(resolved.data) ? resolved.data[0] : resolved.data;
    if (!item) throw new Error('Não encontrei esse link no Audius.');
    let name = 'Audius';
    let rawTracks = [];
    if (item.playlist_name) {
      name = String(item.playlist_name).slice(0, 140);
      const data = await audiusFetch(`/playlists/${encodeURIComponent(item.id)}/tracks`);
      rawTracks = data.data || [];
    } else if (item.title) {
      name = String(item.title).slice(0, 140);
      rawTracks = [item];
    } else {
      throw new Error('Esse link do Audius não é uma playlist nem uma música.');
    }
    const usable = rawTracks.filter(audiusUsable);
    const tracks = usable.map((raw) => {
      const candidate = audiusCandidate(raw);
      const permalink = typeof raw.permalink === 'string' && raw.permalink.startsWith('/') ? `https://audius.co${raw.permalink}` : '';
      return newTrack(candidate.title, candidate.channel, permalink, { type: 'audius', id: candidate.id, label: `${candidate.title} · ${candidate.channel}` });
    });
    if (!tracks.length) throw new Error('Nenhuma música desse link está liberada para tocar de graça.');
    return { name, service: 'Audius', sourceUrl: link.url, tracks, skipped: rawTracks.length - usable.length };
  }

  async function importFromLink(raw) {
    const link = lib.parsePlaylistLink(raw);
    ui.loadPlaylistButton.disabled = true;
    setNotice(link.service === 'audius' ? 'Lendo o link no Audius…' : `Lendo a playlist (${link.service === 'spotify' ? 'Spotify' : 'Deezer'})…`);
    try {
      const result = link.service === 'audius' ? await importAudius(link) : await importViaServer(link);
      applyImportedPlaylist(result);
      const total = result.tracks.length;
      if (link.service === 'audius') {
        const skipped = result.skipped ? ` ${result.skipped} ${result.skipped === 1 ? 'faixa' : 'faixas'} não ${result.skipped === 1 ? 'está liberada' : 'estão liberadas'} para tocar de graça.` : '';
        setNotice(`Playlist importada: ${total} ${total === 1 ? 'faixa' : 'faixas'}, todas sem anúncios.${skipped}`, 'success');
      } else {
        setNotice(`Playlist importada: ${total} ${total === 1 ? 'faixa' : 'faixas'}. Procurando versões sem anúncios…`, 'success');
        autoMatchAudius();
      }
    } finally {
      ui.loadPlaylistButton.disabled = false;
    }
  }

  async function autoMatchAudius() {
    const revision = state.playlistRevision;
    const run = ++state.matchRun;
    const pending = [];
    state.playlist.forEach((track, index) => { if (!track.src) pending.push(index); });
    if (!pending.length) return;
    let cursor = 0;
    let done = 0;
    let found = 0;
    let failed = 0;
    const cancelled = () => revision !== state.playlistRevision || run !== state.matchRun;

    const worker = async () => {
      while (!cancelled()) {
        const index = pending[cursor];
        cursor += 1;
        if (index === undefined) return;
        const track = state.playlist[index];
        try {
          const results = await audiusSearch(track.title, track.artist);
          if (cancelled()) return;
          if (!track.src) {
            const best = lib.pickBestAudiusMatch(track, results);
            if (best) { track.src = { type: 'audius', id: best.id, label: `${best.title} · ${best.channel}`.slice(0, 200) }; found += 1; }
          }
        } catch (_) { failed += 1; }
        done += 1;
        if (!cancelled()) {
          setNotice(`Procurando versões sem anúncios… ${done}/${pending.length} (${found} encontradas)`);
          scheduleRender();
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (cancelled()) return;
    renderPlaylist();
    broadcastPlaylist();
    if (failed === pending.length) {
      setNotice('Não consegui consultar o Audius agora. Você ainda pode enviar seus mp3 ou usar o YouTube em cada faixa.', 'error');
      return;
    }
    const missing = pending.length - found;
    const base = `Achei ${found} de ${pending.length} faixas sem anúncios no Audius.`;
    setNotice(missing > 0
      ? `${base} Para as ${missing} restantes, use “Meu mp3” (um arquivo seu) ou “YouTube” (pode ter anúncios).`
      : `${base} Já dá para ouvir tudo!`, found ? 'success' : '');
    setPlaybackStatus(found ? 'Clique em “Tocar” em uma faixa pronta.' : 'Nenhuma faixa pronta ainda: envie um mp3 ou escolha um vídeo do YouTube.');
  }

  async function searchAudiusForTrack(index) {
    if (!isPlaylistController()) { setNotice('Só o anfitrião pode escolher as fontes das músicas.', 'error'); return; }
    const track = state.playlist[index];
    if (!track) return;
    const revision = state.playlistRevision;
    state.searchInProgress.add(index);
    renderPlaylist();
    setNotice(`Procurando “${track.title}” no Audius…`);
    try {
      const results = await audiusSearch(track.title, track.artist, 5);
      if (revision !== state.playlistRevision || state.playlist[index] !== track) return;
      if (results.length) {
        state.searchResults.set(index, results);
        setNotice(`Encontrei ${results.length} possíveis versões. Confira se é mesmo a música antes de escolher.`, 'success');
      } else {
        state.searchResults.delete(index);
        setNotice(`Não achei “${track.title}” sem anúncios. Use “Meu mp3” ou “YouTube” para esta faixa.`, 'error');
      }
    } catch (_) {
      setNotice('Não consegui consultar o Audius agora. Tente de novo em instantes.', 'error');
    } finally {
      if (revision === state.playlistRevision && state.playlist[index] === track) {
        state.searchInProgress.delete(index);
        renderPlaylist();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* YouTube (opcional, pode ter anúncios)                               */
  /* ------------------------------------------------------------------ */

  async function searchYoutubeForTrack(index) {
    if (!isPlaylistController()) { setNotice('Só o anfitrião pode escolher as fontes das músicas.', 'error'); return; }
    const track = state.playlist[index];
    if (!track) return;
    const apiKey = String(config.YOUTUBE_API_KEY || '').trim();
    if (!apiKey) { showManualYoutubePicker(index); return; }

    const revision = state.playlistRevision;
    state.searchInProgress.add(index);
    renderPlaylist();
    setNotice(`Procurando “${track.title}” no YouTube…`);
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.search = new URLSearchParams({
        part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '5', regionCode: 'BR',
        relevanceLanguage: 'pt', safeSearch: 'moderate', q: `${track.title} ${track.artist} official audio`, key: apiKey
      }).toString();
      const response = await fetch(url);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 403) throw new Error('A busca do YouTube foi bloqueada. Confira a chave, as restrições da API e a cota diária no Google Cloud.');
        throw new Error('O YouTube não concluiu a busca.');
      }
      const results = (payload.items || []).filter((item) => item.id && item.id.videoId).map((item) => ({
        type: 'youtube',
        id: item.id.videoId,
        title: String((item.snippet && item.snippet.title) || 'Vídeo sem título').slice(0, 180),
        channel: String((item.snippet && item.snippet.channelTitle) || 'Canal').slice(0, 100)
      }));
      if (revision !== state.playlistRevision || state.playlist[index] !== track) return;
      state.searchResults.set(index, results);
      if (results.length) setNotice(`Encontrei ${results.length} opções no YouTube. Escolha a versão que corresponde à música.`, 'success');
      else setNotice('Não encontrei um vídeo que aceite incorporação.', 'error');
    } catch (error) {
      if (revision === state.playlistRevision && state.playlist[index] === track) setNotice(error.message || 'Não consegui pesquisar no YouTube.', 'error');
    } finally {
      if (revision === state.playlistRevision && state.playlist[index] === track) {
        state.searchInProgress.delete(index);
        renderPlaylist();
      }
    }
  }

  function showManualYoutubePicker(index) {
    const track = state.playlist[index];
    if (!track || !isPlaylistController()) return;
    const item = ui.playlistList.children[index];
    if (!item) return;
    const previous = item.querySelector('.manual-video-picker');
    if (previous) { previous.remove(); return; }

    const picker = document.createElement('div');
    picker.className = 'manual-video-picker';
    const explanation = document.createElement('p');
    explanation.textContent = 'Abra a pesquisa, escolha o vídeo correto e cole o link abaixo. O YouTube pode mostrar anúncios para cada pessoa.';

    const searchLink = document.createElement('a');
    searchLink.className = 'manual-video-search-link';
    searchLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${track.title} ${track.artist} official audio`)}`;
    searchLink.target = '_blank';
    searchLink.rel = 'noopener noreferrer';
    searchLink.textContent = 'Abrir busca no YouTube ↗';

    const form = document.createElement('form');
    form.className = 'manual-video-form';
    const input = document.createElement('input');
    input.type = 'url';
    input.inputMode = 'url';
    input.autocomplete = 'url';
    input.placeholder = 'Cole o link do vídeo do YouTube';
    input.setAttribute('aria-label', `Link do YouTube para ${track.title}`);
    input.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'button button-secondary';
    submit.textContent = 'Usar vídeo';
    form.append(input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (state.playlist[index] !== track) return;
      const videoId = lib.parseYoutubeVideoId(input.value);
      if (!videoId) {
        setNotice('Esse link não parece ser um vídeo válido do YouTube. Cole um link youtube.com ou youtu.be.', 'error');
        input.focus();
        return;
      }
      picker.remove();
      selectSource(index, { type: 'youtube', id: videoId, label: 'Vídeo escolhido manualmente' }, true);
    });

    picker.append(explanation, searchLink, form);
    item.appendChild(picker);
    input.focus();
  }

  async function ensureYoutubeApi() {
    if (window.YT && window.YT.Player) return window.YT;
    if (state.youtubeApiPromise) return state.youtubeApiPromise;
    state.youtubeApiPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish(new Error('O player do YouTube demorou para carregar. Atualize a página e tente novamente.')), 18000);
      const previousReady = window.onYouTubeIframeAPIReady;
      function finish(error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (error) { state.youtubeApiPromise = null; reject(error); }
        else if (window.YT && window.YT.Player) resolve(window.YT);
        else { state.youtubeApiPromise = null; reject(new Error('A API do YouTube carregou sem disponibilizar o player.')); }
      }
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previousReady === 'function') { try { previousReady(); } catch (_) { /* */ } }
        finish();
      };
      const existing = document.querySelector('script[data-loader="youtube-iframe"]');
      if (existing) {
        existing.addEventListener('error', () => finish(new Error('Não consegui carregar o player do YouTube.')), { once: true });
      } else {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.dataset.loader = 'youtube-iframe';
        script.onerror = () => finish(new Error('Não consegui carregar o player do YouTube. Confira sua conexão.'));
        document.head.appendChild(script);
      }
    });
    return state.youtubeApiPromise;
  }

  async function ensureYoutubePlayer() {
    if (state.youtubePlayer && state.youtubeReady) return state.youtubePlayer;
    if (state.youtubePlayerPromise) return state.youtubePlayerPromise;
    state.youtubePlayerPromise = (async () => {
      const YT = await ensureYoutubeApi();
      return new Promise((resolve, reject) => {
        ui.youtubeEmbed.replaceChildren();
        const target = document.createElement('div');
        target.id = 'youtubePlayerTarget';
        ui.youtubeEmbed.appendChild(target);
        let completed = false;
        const timeout = window.setTimeout(() => { if (!completed) reject(new Error('O player do YouTube não ficou pronto. Tente novamente.')); }, 18000);
        state.youtubePlayer = new YT.Player(target, {
          width: '640', height: '360', videoId: '',
          playerVars: { playsinline: 1, controls: 1, rel: 0, origin: window.location.origin, enablejsapi: 1 },
          events: {
            onReady: (event) => {
              completed = true;
              window.clearTimeout(timeout);
              state.youtubeReady = true;
              const frame = event.target.getIframe();
              if (frame) frame.title = 'Player do YouTube — Ouvir Juntos';
              resolve(state.youtubePlayer);
            },
            onStateChange: onYoutubeStateChange,
            onError: onYoutubeError
          }
        });
      });
    })();
    try { return await state.youtubePlayerPromise; }
    catch (error) {
      state.youtubePlayerPromise = null;
      state.youtubePlayer = null;
      state.youtubeReady = false;
      throw error;
    }
  }

  function onYoutubeStateChange(event) {
    const YT = window.YT;
    if (!YT || !YT.PlayerState || state.activeEngine !== 'youtube') return;
    if (event.data === YT.PlayerState.PLAYING) onEnginePlaying('Reproduzindo no YouTube. A sala acompanha a posição da faixa.');
    else if (event.data === YT.PlayerState.PAUSED) onEnginePaused();
    else if (event.data === YT.PlayerState.ENDED) onEngineEnded();
  }

  function onYoutubeError(event) {
    const messages = {
      2: 'O YouTube informou que o identificador do vídeo é inválido.',
      5: 'Este vídeo não pode ser reproduzido no player HTML5.',
      100: 'Este vídeo foi removido ou está privado.',
      101: 'O dono do vídeo não permite reprodução em sites externos.',
      150: 'O dono do vídeo não permite reprodução em sites externos.'
    };
    const message = messages[event.data] || 'O YouTube não conseguiu reproduzir este vídeo. Escolha outra fonte para a música.';
    setNotice(message, 'error');
    setPlaybackStatus(message);
  }

  /* ------------------------------------------------------------------ */
  /* Reprodução: YouTube e áudio (Audius / mp3) com a mesma lógica       */
  /* ------------------------------------------------------------------ */

  function suppressPlayerEvents(milliseconds = 1800) { state.suppressPlayerEventsUntil = Date.now() + milliseconds; }
  function playerEventsSuppressed() { return Date.now() < state.suppressPlayerEventsUntil; }

  function currentPlayerPosition() {
    try {
      if (state.activeEngine === 'youtube' && state.youtubePlayer && state.youtubeReady) return Math.max(0, Number(state.youtubePlayer.getCurrentTime() || 0));
      if (state.activeEngine === 'audio' || state.activeEngine === 'file') return Math.max(0, Number(elFor(state.activeEngine).currentTime || 0));
    } catch (_) { /* sem posição ainda */ }
    return state.roomPlayback ? Math.max(0, Number(state.roomPlayback.position || 0)) : 0;
  }

  function enginePlaying() {
    try {
      if (state.activeEngine === 'youtube' && state.youtubePlayer && state.youtubeReady && window.YT) return state.youtubePlayer.getPlayerState() === window.YT.PlayerState.PLAYING;
      if (isAudioEngine(state.activeEngine)) { const el = elFor(state.activeEngine); return !el.paused && !el.ended && !el.__unlocking; }
    } catch (_) { /* */ }
    return false;
  }

  function showEngine(engine) {
    suppressPlayerEvents(2200);
    state.activeEngine = engine;
    ui.youtubeEmbed.hidden = engine !== 'youtube';
    ui.audioWrap.hidden = !isAudioEngine(engine);
    ui.audioPlayer.hidden = engine !== 'audio';
    ui.fileAudio.hidden = engine !== 'file';
    if (engine !== 'youtube') { try { if (state.youtubePlayer && state.youtubeReady) state.youtubePlayer.pauseVideo(); } catch (_) { /* */ } }
    ['audio', 'file'].forEach((name) => { if (name !== engine) { try { elFor(name).pause(); } catch (_) { /* */ } } });
    ui.playPauseButton.disabled = !engine;
    ui.syncButton.disabled = !engine;
  }

  function enginePause() {
    try {
      if (state.activeEngine === 'youtube' && state.youtubePlayer) state.youtubePlayer.pauseVideo();
      else if (isAudioEngine(state.activeEngine)) elFor(state.activeEngine).pause();
    } catch (_) { /* */ }
  }

  async function audioPlay(engine = state.activeEngine) {
    try { await elFor(engine).play(); return true; } catch (_) { return false; }
  }

  async function engineResume() {
    if (state.activeEngine === 'youtube') {
      try { const player = await ensureYoutubePlayer(); player.playVideo(); } catch (error) { setNotice(error.message, 'error'); }
    } else if (state.activeEngine === 'file' && !ui.fileAudio.getAttribute('src')) {
      setPlaybackStatus('O mp3 ainda está chegando. Ele começa sozinho assim que chegar.');
    } else if (isAudioEngine(state.activeEngine)) {
      const ok = await audioPlay();
      if (!ok) setNotice('O navegador bloqueou o áudio. Aperte Play no player acima.', 'error');
    }
  }

  function audioUrlFor(src) {
    if (src.type === 'file') {
      const file = state.files.get(src.fileId);
      if (!file) return '';
      if (!file.url) file.url = URL.createObjectURL(file.blob);
      return file.url;
    }
    return `${AUDIUS_API}/tracks/${encodeURIComponent(src.id)}/stream?app_name=${AUDIUS_APP}`;
  }

  /* Retorna true quando trocou a fonte do <audio>. */
  function setAudioSource(track, engine) {
    const key = srcKey(track.src);
    if (state.audioKeys[engine] === key) return false;
    const url = audioUrlFor(track.src);
    if (!url) return false;
    const el = elFor(engine);
    el.muted = false; el.__unlocking = false;
    state.audioKeys[engine] = key;
    state.audioPendingSeek[engine] = null;
    el.src = url;
    el.load();
    return true;
  }

  function seekAudio(engine, seconds) {
    const el = elFor(engine);
    const target = Math.max(0, seconds);
    if (el.readyState >= 1) { try { el.currentTime = target; } catch (_) { /* */ } state.audioPendingSeek[engine] = null; }
    else state.audioPendingSeek[engine] = target;
  }

  /* Liberar o áudio no aparelho (celulares só deixam tocar depois de um toque do usuário). */
  let silentUrl = '';
  function silentWavUrl() {
    if (silentUrl) return silentUrl;
    const samples = 800;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples * 2, true);
    silentUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    return silentUrl;
  }
  function unlockMedia() {
    ['audio', 'file'].forEach((engine) => {
      if (state.unlocked[engine]) return;
      const el = elFor(engine);
      if (!el || el.getAttribute('src')) { state.unlocked[engine] = Boolean(el && el.getAttribute('src')); return; }
      state.unlocked[engine] = true;
      try {
        el.__unlocking = true;
        el.muted = true;
        el.src = silentWavUrl();
        const promise = el.play();
        const finish = () => {
          if (el.getAttribute('src') === silentUrl) { el.pause(); el.removeAttribute('src'); el.load(); }
          window.setTimeout(() => { if (!el.getAttribute('src') || el.getAttribute('src') !== silentUrl) { el.muted = false; el.__unlocking = false; } }, 80);
        };
        if (promise && promise.then) promise.then(finish, () => { state.unlocked[engine] = false; finish(); }); else finish();
      } catch (_) { state.unlocked[engine] = false; }
    });
  }

  function onEnginePlaying(statusMessage) {
    state.userActivatedPlayback = true;
    if (state.connected && !state.isHost) state.localPlaybackPaused = false;
    setPlayerPlaying(true);
    setPlaybackStatus(statusMessage);
    if (!playerEventsSuppressed() && isPlaylistController()) {
      updateRoomPlayback({ isPaused: false, position: currentPlayerPosition(), sentAt: Date.now() });
      broadcastRoomState();
    }
  }

  function onEnginePaused() {
    if (state.connected && !state.isHost && !playerEventsSuppressed()) state.localPlaybackPaused = true;
    setPlayerPlaying(false);
    setPlaybackStatus('Reprodução pausada neste dispositivo.');
    if (!playerEventsSuppressed() && isPlaylistController()) {
      updateRoomPlayback({ isPaused: true, position: currentPlayerPosition(), sentAt: Date.now() });
      broadcastRoomState();
    }
  }

  function onEngineEnded() {
    setPlayerPlaying(false);
    if (!isPlaylistController()) { setPlaybackStatus('A faixa terminou.'); return; }
    updateRoomPlayback({ isPaused: true, position: 0, sentAt: Date.now() });
    broadcastRoomState();
    setPlaybackStatus('Próxima faixa…');
    window.setTimeout(() => playNext(true), 450);
  }

  function onAudioError() {
    if (state.activeEngine !== 'audio' && state.activeEngine !== 'file') return;
    const track = state.playlist[state.currentTrackIndex];
    const isAudius = track && track.src && track.src.type === 'audius';
    const message = isAudius
      ? 'Não consegui tocar esta faixa do Audius (o artista pode ter removido ou restringido). Escolha outra fonte.'
      : 'Não consegui tocar este arquivo. O formato pode não ser aceito pelo navegador.';
    setNotice(message, 'error');
    setPlaybackStatus(message);
  }

  async function playTrack(index, keepOrder = false) {
    if (!isPlaylistController()) { setNotice('Peça ao anfitrião para escolher a faixa.', 'error'); return; }
    const track = state.playlist[index];
    if (!track || !track.src) { setNotice('Primeiro escolha uma fonte para essa faixa (sem anúncios, meu mp3 ou YouTube).', 'error'); return; }
    if (!trackReady(track)) { setNotice('Esse arquivo não está mais disponível neste aparelho. Envie o mp3 de novo.', 'error'); return; }

    if (!keepOrder) {
      ensureOrder();
      if (state.shuffle && state.order[state.orderPos] !== index) rebuildOrder(index);
      else state.orderPos = state.order.indexOf(index);
    }
    state.currentTrackIndex = index;
    state.userActivatedPlayback = true;
    ui.nowPlayingTitle.textContent = track.title;
    ui.nowPlayingArtist.textContent = track.artist;
    renderPlaylist();
    const engine = engineFor(track);
    showEngine(engine);

    if (engine === 'audio' || engine === 'file') {
      ui.playerTip.textContent = engine === 'file'
        ? 'Seus amigos recebem este mp3 pela sala e ele fica só na memória deles (nada é salvo). Mantenha esta página aberta. Cada pessoa pode precisar apertar “Ativar meu player”.'
        : 'Cada pessoa pode precisar apertar Play no próprio aparelho para liberar o áudio.';
      setAudioSource(track, engine);
      seekAudio(engine, 0);
      updateRoomPlayback({ trackIndex: index, sourceKey: srcKey(track.src), isPaused: false, position: 0, sentAt: Date.now() });
      broadcastRoomState();
      const ok = await audioPlay(engine);
      if (ok) {
        setPlayerPlaying(true);
        setPlaybackStatus('Tocando. A sala acompanha a posição da faixa.');
      } else {
        updateRoomPlayback({ isPaused: true, position: 0, sentAt: Date.now() });
        broadcastRoomState();
        setPlayerPlaying(false);
        setPlaybackStatus('O navegador bloqueou o início automático. Aperte Play no player.');
      }
      return;
    }

    ui.playerTip.textContent = 'Vídeo do YouTube: pode ter anúncios, e cada pessoa pode precisar apertar Play no próprio player.';
    try {
      const player = await ensureYoutubePlayer();
      suppressPlayerEvents(2200);
      player.loadVideoById({ videoId: track.src.id, startSeconds: 0 });
      updateRoomPlayback({ trackIndex: index, sourceKey: srcKey(track.src), isPaused: true, position: 0, sentAt: Date.now() });
      broadcastRoomState();
      setPlaybackStatus('Faixa carregada. Caso não comece, aperte Play no player.');
    } catch (error) {
      setNotice(error.message, 'error');
    }
  }

  function updateRoomPlayback(partial) {
    const previous = state.roomPlayback || {};
    const trackIndex = Number.isInteger(partial.trackIndex) ? partial.trackIndex : (state.currentTrackIndex >= 0 ? state.currentTrackIndex : previous.trackIndex);
    const track = state.playlist[trackIndex];
    state.roomPlayback = {
      trackIndex: Number.isInteger(trackIndex) ? trackIndex : -1,
      sourceKey: partial.sourceKey || (track && track.src ? srcKey(track.src) : (previous.sourceKey || '')),
      isPaused: typeof partial.isPaused === 'boolean' ? partial.isPaused : Boolean(previous.isPaused),
      position: Math.max(0, Number(partial.position !== undefined ? partial.position : previous.position || 0)),
      sentAt: Number(partial.sentAt || Date.now())
    };
  }

  /* Próximas faixas (na ordem em que vão tocar): os ouvintes já puxam esses mp3 para a memória. */
  function upcomingIndexes() {
    if (!isPlaylistController() || !state.playlist.length) return [];
    ensureOrder();
    const out = [];
    for (let pos = state.orderPos + 1; pos < state.order.length && out.length < PREFETCH_AHEAD; pos += 1) {
      const index = state.order[pos];
      const track = state.playlist[index];
      if (track && track.src && trackReady(track)) out.push(index);
    }
    return out;
  }

  function buildRoomState() {
    const playback = state.roomPlayback;
    if (!playback || !Number.isInteger(playback.trackIndex) || playback.trackIndex < 0) {
      return { trackIndex: -1, sourceKey: '', isPaused: true, position: 0, sentAt: Date.now(), shuffle: state.shuffle, upcoming: upcomingIndexes() };
    }
    let position = playback.position || 0;
    const playing = !playback.isPaused;
    if (playing && playback.sentAt) position += Math.max(0, (Date.now() - playback.sentAt) / 1000);
    if (isPlaylistController() && playing && enginePlaying()) position = currentPlayerPosition();
    return { trackIndex: playback.trackIndex, sourceKey: playback.sourceKey, isPaused: playback.isPaused, position, sentAt: Date.now(), shuffle: state.shuffle, upcoming: upcomingIndexes() };
  }

  /* Puxa para a memória a faixa atual e as próximas (só no aparelho de quem ouve). */
  function prefetchFor(payload) {
    if (!state.connected || state.isHost || !payload) return;
    const indexes = [];
    if (Number.isInteger(payload.trackIndex) && payload.trackIndex >= 0) indexes.push(payload.trackIndex);
    (Array.isArray(payload.upcoming) ? payload.upcoming : []).slice(0, PREFETCH_AHEAD + 1).forEach((i) => { if (Number.isInteger(i)) indexes.push(i); });
    const keep = new Set();
    indexes.forEach((i) => {
      const track = state.playlist[i];
      if (track && track.src && track.src.type === 'file') { keep.add(track.src.fileId); startIncoming(track.src); }
    });
    evictFiles(keep);
  }

  async function applyRoomState(payload) {
    if (!payload) return;
    prefetchFor(payload);
    if (!Number.isInteger(payload.trackIndex) || payload.trackIndex < 0) {
      state.roomPlayback = null;
      setPlaybackStatus('Aguardando o anfitrião escolher uma música.');
      return;
    }
    state.roomPlayback = { ...payload, receivedAt: payload.receivedAt || Date.now() };
    state.shuffle = Boolean(payload.shuffle);
    state.currentTrackIndex = payload.trackIndex;
    const track = state.playlist[payload.trackIndex];
    ui.playerEmpty.hidden = true;
    ui.playerWrap.hidden = false;
    renderPlaylist();
    if (!track || !track.src) { setPlaybackStatus('Aguardando o anfitrião escolher uma fonte para esta faixa.'); return; }
    ui.nowPlayingTitle.textContent = track.title;
    ui.nowPlayingArtist.textContent = track.artist;

    const received = state.roomPlayback.receivedAt;
    const adjusted = Math.max(0, Number(payload.position || 0) + (payload.isPaused ? 0 : (Date.now() - received) / 1000 + LATENCY_GUESS));
    const engine = engineFor(track);

    try {
      if (engine === 'file' && !state.files.has(track.src.fileId)) {
        // mp3 ainda não chegou neste aparelho: espera chegar (começa sozinho no ponto certo)
        if (state.activeEngine !== 'file') showEngine('file');
        suppressPlayerEvents(2400);
        try { ui.fileAudio.pause(); } catch (_) { /* */ }
        startIncoming(track.src);
        const pct = state.fileProgress.get(track.src.fileId) || 0;
        ui.playerTip.textContent = 'O mp3 vem pela sala e fica só na memória deste aparelho. Aperte “Ativar meu player” uma vez para liberar o som.';
        setPlayerPlaying(false);
        setPlaybackStatus(`Recebendo o mp3 da sala… ${pct}%. Ele começa sozinho assim que chegar.`);
        return;
      }

      if (engine === 'audio' || engine === 'file') {
        if (state.activeEngine !== engine) showEngine(engine);
        suppressPlayerEvents(2400);
        if (engine === 'file') ui.playerTip.textContent = 'Este mp3 está na memória do seu aparelho (nada é salvo). Se o som não começar, aperte “Ativar meu player”.';
        const el = elFor(engine);
        const changed = setAudioSource(track, engine);
        if (changed) seekAudio(engine, adjusted);
        else if (Math.abs((el.currentTime || 0) - adjusted) > DRIFT_AUDIO) seekAudio(engine, adjusted);

        if (payload.isPaused) {
          el.pause();
          setPlaybackStatus('A sala está pausada.');
          setPlayerPlaying(false);
        } else if (state.userActivatedPlayback && !state.localPlaybackPaused) {
          if (el.paused) {
            const ok = await audioPlay(engine);
            if (!ok) { setPlayerPlaying(false); setPlaybackStatus('O navegador bloqueou o áudio. Aperte “Ativar meu player”.'); return; }
          }
          setPlaybackStatus('Sincronizado com o anfitrião.');
        } else {
          setPlaybackStatus(state.localPlaybackPaused
            ? 'Você pausou o áudio apenas neste dispositivo. Use “Ativar meu player” para retomar.'
            : 'A música foi escolhida. Aperte “Ativar meu player” para ouvir neste dispositivo.');
          setPlayerPlaying(false);
        }
        return;
      }

      if (state.activeEngine !== 'youtube') showEngine('youtube');
      const player = await ensureYoutubePlayer();
      const currentId = (() => { try { return player.getVideoData().video_id || ''; } catch (_) { return ''; } })();
      suppressPlayerEvents(2400);
      if (currentId !== track.src.id) player.cueVideoById({ videoId: track.src.id, startSeconds: adjusted });
      else if (Math.abs(currentPlayerPosition() - adjusted) > DRIFT_YOUTUBE) player.seekTo(adjusted, true);

      if (payload.isPaused) {
        player.pauseVideo();
        setPlaybackStatus('A sala está pausada.');
        setPlayerPlaying(false);
      } else if (state.userActivatedPlayback && !state.localPlaybackPaused) {
        player.playVideo();
        setPlaybackStatus('Sincronizando com a reprodução do anfitrião.');
      } else {
        setPlaybackStatus(state.localPlaybackPaused
          ? 'Você pausou o áudio apenas neste dispositivo. Use “Ativar meu player” para retomar.'
          : 'A música foi escolhida. Aperte Play no player do YouTube para ativar o áudio neste dispositivo.');
        setPlayerPlaying(false);
      }
    } catch (error) {
      setNotice(error.message, 'error');
    }
  }

  async function toggleLocalPlayback() {
    unlockMedia();
    state.userActivatedPlayback = true;
    if (!state.activeEngine) {
      if (state.roomPlayback && state.roomPlayback.trackIndex >= 0) { applyRoomState(state.roomPlayback); return; }
      setNotice('Ainda não há música tocando.', 'error');
      return;
    }
    const playing = enginePlaying();
    if (state.connected && !state.isHost) {
      if (playing) {
        state.localPlaybackPaused = true;
        enginePause();
        setPlaybackStatus('Você pausou o áudio apenas neste dispositivo.');
      } else {
        state.localPlaybackPaused = false;
        await engineResume();
        sendToHost({ type: 'request-control', action: 'sync' });
      }
      return;
    }
    if (playing) enginePause(); else await engineResume();
  }

  function syncPlayback() {
    if (state.isHost) {
      broadcastRoomState();
      setNotice('Estado atual enviado para quem está na sala.', 'success');
    } else if (state.hostConnection && state.hostConnection.open) {
      sendToHost({ type: 'request-control', action: 'sync' });
      setNotice('Pedindo a sincronização da sala…', 'success');
    } else if (state.roomPlayback) {
      applyRoomState(state.roomPlayback);
    } else {
      setNotice('Entre em uma sala para sincronizar com outras pessoas.', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Arquivos mp3 (enviados direto entre os aparelhos)                   */
  /* ------------------------------------------------------------------ */

  function guessMime(name) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    return { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm' }[ext] || 'audio/mpeg';
  }

  function isAudioFile(file) {
    return /^audio\//.test(file.type) || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i.test(file.name);
  }

  async function readAudioMeta(file) {
    const fallback = lib.titleFromFilename(file.name);
    try {
      const head = await file.slice(0, 256 * 1024).arrayBuffer();
      const tags = lib.parseId3(head);
      return { title: tags.title || fallback.title, artist: tags.artist || fallback.artist };
    } catch (_) { return fallback; }
  }

  function registerFile(file) {
    const fileId = randomId(16);
    const mime = file.type || guessMime(file.name);
    state.files.set(fileId, { blob: file, url: '', name: file.name, size: file.size, mime });
    return { type: 'file', fileId, name: file.name.slice(0, 200), size: file.size, mime };
  }

  async function addLocalFiles(fileList, replaceIndex = -1, options = {}) {
    if (!isPlaylistController()) { setNotice('Só o anfitrião pode adicionar arquivos.', 'error'); return; }
    let files = Array.from(fileList || []);
    if (!files.length) return;
    let folderName = '';
    let ignored = 0;
    if (options.folder) {
      const audioFiles = files.filter(isAudioFile);
      ignored = files.length - audioFiles.length;
      audioFiles.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true, sensitivity: 'base' }));
      files = audioFiles;
      folderName = files[0] && files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0].slice(0, 100) : '';
      if (!files.length) { setNotice('Não encontrei arquivos de áudio nessa pasta.', 'error'); return; }
    }
    const rejected = [];
    const added = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (files.length > 12 && i % 10 === 0) { setNotice(`Lendo os arquivos… ${i}/${files.length}`); await sleep(0); }
      if (!isAudioFile(file)) { rejected.push(`${file.name} (não é um arquivo de áudio)`); continue; }
      if (!file.size) { rejected.push(`${file.name} (arquivo vazio)`); continue; }
      if (file.size > MAX_FILE_BYTES) { rejected.push(`${file.name} (passa de ${lib.formatBytes(MAX_FILE_BYTES)})`); continue; }
      if (replaceIndex >= 0 && added.length >= 1) break;
      if (replaceIndex < 0 && state.playlist.length + added.length >= MAX_PLAYLIST_TRACKS) { rejected.push(`${file.name} (limite de ${MAX_PLAYLIST_TRACKS} faixas)`); continue; }
      const meta = await readAudioMeta(file);
      added.push({ file, meta });
    }

    if (added.length) {
      if (replaceIndex >= 0) {
        const track = state.playlist[replaceIndex];
        if (track) {
          track.src = registerFile(added[0].file);
          pruneFiles();
        }
      } else {
        const wasEmpty = state.playlist.length === 0;
        added.forEach(({ file, meta }) => {
          state.playlist.push(newTrack(meta.title, meta.artist, '', registerFile(file)));
        });
        if (wasEmpty) {
          state.playlistName = folderName || 'Meus mp3';
          state.playlistSource = options.folder ? 'Pasta' : 'Meus arquivos';
          state.playlistSourceUrl = '';
        }
      }
      renderPlaylist();
      broadcastPlaylist();
      if (state.roomPlayback) broadcastRoomState();
    }

    const summary = added.length ? `${added.length} ${added.length === 1 ? 'arquivo adicionado' : 'arquivos adicionados'}.` : '';
    const skipped = ignored ? ` ${ignored} ${ignored === 1 ? 'arquivo da pasta que não é áudio foi ignorado' : 'arquivos da pasta que não são áudio foram ignorados'}.` : '';
    if (rejected.length && added.length) setNotice(`${summary} Não deu para usar: ${rejected.slice(0, 5).join('; ')}${rejected.length > 5 ? ` e mais ${rejected.length - 5}` : ''}.${skipped}`, 'error');
    else if (rejected.length) setNotice(`Não deu para usar: ${rejected.slice(0, 5).join('; ')}.`, 'error');
    else setNotice(`${summary}${skipped} Clique em “Tocar tudo” para começar.`, 'success');
  }

  /* ---- ordem de reprodução (sequencial ou aleatória) ---- */
  function shuffleInPlace(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      const j = bytes[0] % (i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function rebuildOrder(firstIndex = -1) {
    let list = state.playlist.map((_, index) => index);
    if (state.shuffle) {
      shuffleInPlace(list);
      if (firstIndex >= 0) list = [firstIndex, ...list.filter((index) => index !== firstIndex)];
    }
    state.order = list;
    state.orderPos = firstIndex >= 0 ? list.indexOf(firstIndex) : -1;
  }

  function ensureOrder() {
    if (state.order.length !== state.playlist.length) rebuildOrder(state.currentTrackIndex);
  }

  function updateShuffleButton() {
    ui.shuffleButton.textContent = `🔀 Aleatório: ${state.shuffle ? 'ligado' : 'desligado'}`;
    ui.shuffleButton.setAttribute('aria-pressed', state.shuffle ? 'true' : 'false');
  }

  function playNext(auto = false) {
    if (!isPlaylistController()) return false;
    ensureOrder();
    let pos = state.orderPos + 1;
    while (pos < state.order.length && !trackReady(state.playlist[state.order[pos]])) pos += 1;
    if (pos >= state.order.length) {
      setPlaybackStatus(auto ? 'A playlist chegou ao fim.' : 'Não há próxima faixa pronta para tocar.');
      if (!auto) setNotice('Não há próxima faixa pronta para tocar.', 'error');
      return false;
    }
    state.orderPos = pos;
    playTrack(state.order[pos], true);
    return true;
  }

  function playPrevious() {
    if (!isPlaylistController()) return;
    ensureOrder();
    if (state.currentTrackIndex >= 0 && currentPlayerPosition() > 3) { playTrack(state.currentTrackIndex, true); return; }
    let pos = state.orderPos - 1;
    while (pos >= 0 && !trackReady(state.playlist[state.order[pos]])) pos -= 1;
    if (pos < 0) { if (state.currentTrackIndex >= 0) playTrack(state.currentTrackIndex, true); return; }
    state.orderPos = pos;
    playTrack(state.order[pos], true);
  }

  function playAll() {
    if (!isPlaylistController()) { setNotice('Só o anfitrião controla a playlist.', 'error'); return; }
    if (!state.playlist.length) { setNotice('Adicione uma pasta, arquivos ou uma playlist primeiro.', 'error'); return; }
    rebuildOrder(-1);
    if (!playNext(false)) setNotice('Nenhuma faixa está pronta para tocar. Escolha uma fonte para elas.', 'error');
  }

  function toggleShuffle() {
    if (!isPlaylistController()) return;
    state.shuffle = !state.shuffle;
    rebuildOrder(state.currentTrackIndex);
    updateShuffleButton();
    if (state.roomPlayback) broadcastRoomState();
    setNotice(state.shuffle ? 'Modo aleatório ligado: a próxima música será sorteada.' : 'Modo aleatório desligado: as músicas seguem a ordem da lista.', 'success');
  }

  function evictFiles(keep) {
    for (const [fileId, file] of state.files.entries()) {
      if (keep.has(fileId)) continue;
      if (file.url) { try { URL.revokeObjectURL(file.url); } catch (_) { /* */ } }
      state.files.delete(fileId);
    }
    for (const fileId of Array.from(state.incoming.keys())) if (!keep.has(fileId)) dropIncoming(fileId);
  }

  /* ---- Envio (anfitrião) ----
   * O anfitrião publica os pedaços do mp3 UMA vez no tópico da sala (porta 443/WSS) e o servidor de
   * mensagens entrega a todos que estão ouvindo. Quem perder pedaços pede só os que faltam. */
  function chunkCount(size) { return Math.ceil(size / FILE_CHUNK_BYTES); }

  function hostEnqueueFile(fileId, ranges) {
    const file = state.files.get(fileId);
    if (!file || !file.size) return;
    const total = chunkCount(file.size);
    let job = state.hostJobs.get(fileId);
    if (!job) { job = { fileId, total, need: new Uint8Array(total), count: 0, cursor: 0, block: null }; state.hostJobs.set(fileId, job); }
    const mark = (from, to) => {
      for (let i = Math.max(0, from); i <= Math.min(total - 1, to); i += 1) if (!job.need[i]) { job.need[i] = 1; job.count += 1; }
    };
    if (!Array.isArray(ranges)) mark(0, total - 1);
    else ranges.slice(0, 500).forEach((range) => {
      if (Array.isArray(range) && Number.isInteger(range[0]) && Number.isInteger(range[1])) mark(range[0], range[1]);
    });
    pumpHostJobs();
  }

  function pickHostJob() {
    const current = state.playlist[state.currentTrackIndex];
    const currentId = current && current.src && current.src.type === 'file' ? current.src.fileId : '';
    const first = currentId ? state.hostJobs.get(currentId) : null;
    if (first && first.count > 0) return first;
    for (const job of state.hostJobs.values()) if (job.count > 0) return job;
    return null;
  }

  async function readHostChunk(job, file, index) {
    const start = index * FILE_CHUNK_BYTES;
    const end = Math.min(file.size, start + FILE_CHUNK_BYTES);
    if (!job.block || start < job.block.start || end > job.block.start + job.block.bytes.length) {
      const blockStart = start;
      const blockEnd = Math.min(file.size, blockStart + FILE_CHUNK_BYTES * 32);
      job.block = { start: blockStart, bytes: new Uint8Array(await file.blob.slice(blockStart, blockEnd).arrayBuffer()) };
    }
    return job.block.bytes.subarray(start - job.block.start, end - job.block.start);
  }

  async function pumpHostJobs() {
    if (state.hostPumping) return;
    state.hostPumping = true;
    try {
      let sentInBurst = 0;
      for (;;) {
        const room = state.room;
        if (!room || room.role !== 'host' || !room.mqtt) break;
        const job = pickHostJob();
        if (!job) break;
        if (!room.mqtt.connected) { await sleep(500); continue; }
        const file = state.files.get(job.fileId);
        if (!file) { state.hostJobs.delete(job.fileId); continue; }
        let index = -1;
        for (let step = 0; step < job.total; step += 1) {
          const candidate = (job.cursor + step) % job.total;
          if (job.need[candidate]) { index = candidate; break; }
        }
        if (index < 0) { job.count = 0; continue; }
        job.need[index] = 0; job.count -= 1; job.cursor = index + 1;
        if (job.count <= 0) { job.count = 0; }
        const data = await readHostChunk(job, file, index);
        const message = new Uint8Array(8 + data.length);
        const view = new DataView(message.buffer);
        view.setUint32(0, index); view.setUint32(4, job.total);
        message.set(data, 8);
        room.mqtt.publish(roomTopic(room.code, `f/${job.fileId}`), message);
        sentInBurst += data.length;
        if (sentInBurst >= SEND_BURST_BYTES || room.mqtt.buffered > SEND_BUFFER_LIMIT) {
          const wait = Math.max(20, Math.round((sentInBurst / FILE_RATE_BPS) * 1000));
          sentInBurst = 0;
          await sleep(wait);
          while (state.room === room && room.mqtt.buffered > SEND_BUFFER_LIMIT) await sleep(40);
        }
      }
    } catch (error) {
      console.warn('[Ouvir Juntos] Falha ao enviar o mp3:', error);
    } finally {
      state.hostPumping = false;
      if (pickHostJob() && state.room && state.room.role === 'host') window.setTimeout(pumpHostJobs, 300);
    }
  }

  /* ---- Recebimento (quem ouve) ---- */
  function dropIncoming(fileId) {
    const entry = state.incoming.get(fileId);
    if (entry && entry.tailTimer) window.clearTimeout(entry.tailTimer);
    state.incoming.delete(fileId);
    state.fileProgress.delete(fileId);
  }

  function missingRanges(entry, limit = 300) {
    const ranges = [];
    let start = -1;
    for (let i = 0; i < entry.total; i += 1) {
      if (!entry.chunks[i]) { if (start < 0) start = i; }
      else if (start >= 0) { ranges.push([start, i - 1]); start = -1; if (ranges.length >= limit) return ranges; }
    }
    if (start >= 0) ranges.push([start, entry.total - 1]);
    return ranges;
  }

  function requestMissing(entry) {
    if (!state.room || state.room.role !== 'guest' || !state.room.mqtt.connected || !state.room.acked) return;
    entry.requestedAt = Date.now();
    publishJson('ctl', { type: 'request-file', id: MY_ID, fileId: entry.fileId, ranges: entry.got === 0 ? null : missingRanges(entry) });
  }

  function ensureFileWatchdog() {
    if (state.fileWatchdog) return;
    state.fileWatchdog = window.setInterval(() => {
      if (!state.incoming.size) { window.clearInterval(state.fileWatchdog); state.fileWatchdog = null; return; }
      const now = Date.now();
      for (const entry of Array.from(state.incoming.values())) {
        if (now - Math.max(entry.lastAt, entry.requestedAt) < STALL_MS) continue;
        entry.tries += 1;
        if (entry.tries > MAX_IDLE_TRIES) {
          dropIncoming(entry.fileId);
          setNotice('O mp3 não está chegando. O anfitrião precisa estar com a página aberta; vou tentar de novo sozinho.', 'error');
          scheduleRender();
          continue;
        }
        requestMissing(entry);
      }
    }, 1000);
  }

  function startIncoming(src) {
    if (!src || src.type !== 'file' || state.files.has(src.fileId) || state.incoming.has(src.fileId)) return;
    if (!src.size || src.size > MAX_FILE_BYTES) return;
    const total = chunkCount(src.size);
    const entry = { fileId: src.fileId, name: src.name || '', mime: src.mime || 'audio/mpeg', size: src.size, total, chunks: new Array(total), got: 0, lastAt: Date.now(), requestedAt: 0, tries: 0, tailTimer: null };
    state.incoming.set(src.fileId, entry);
    state.fileProgress.set(src.fileId, 0);
    requestMissing(entry);
    ensureFileWatchdog();
    scheduleRender();
  }

  function onFileChunk(fileId, bytes) {
    const entry = state.incoming.get(fileId);
    if (!entry || !bytes || bytes.length < 9) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
    const index = view.getUint32(0);
    const total = view.getUint32(4);
    if (total !== entry.total || index >= total) return;
    const data = bytes.subarray(8);
    const expected = index < total - 1 ? FILE_CHUNK_BYTES : entry.size - (total - 1) * FILE_CHUNK_BYTES;
    if (data.length !== expected || entry.chunks[index]) return;
    entry.chunks[index] = data;
    entry.got += 1;
    entry.lastAt = Date.now();
    entry.tries = 0;
    if (entry.got >= entry.total) { finishIncoming(entry); return; }
    const pct = Math.min(99, Math.floor((entry.got / entry.total) * 100));
    if (pct !== state.fileProgress.get(fileId)) {
      state.fileProgress.set(fileId, pct);
      const current = state.playlist[state.currentTrackIndex];
      if (current && current.src && current.src.fileId === fileId && state.activeEngine === 'file' && !ui.fileAudio.getAttribute('src')) {
        setPlaybackStatus(`Recebendo o mp3 da sala… ${pct}%. Ele começa sozinho assim que chegar.`);
      }
      scheduleRender();
    }
    if (index === entry.total - 1) {
      // terminou uma passada: pede o que ficou faltando
      window.clearTimeout(entry.tailTimer);
      entry.tailTimer = window.setTimeout(() => { if (state.incoming.get(fileId) === entry && entry.got < entry.total) requestMissing(entry); }, 600);
    }
  }

  function finishIncoming(entry) {
    window.clearTimeout(entry.tailTimer);
    state.incoming.delete(entry.fileId);
    state.fileProgress.delete(entry.fileId);
    state.files.set(entry.fileId, { blob: new Blob(entry.chunks, { type: entry.mime }), url: '', name: entry.name, size: entry.size, mime: entry.mime });
    entry.chunks = [];
    renderPlaylist();
    const playback = state.roomPlayback;
    const track = playback ? state.playlist[playback.trackIndex] : null;
    if (track && track.src && track.src.type === 'file' && track.src.fileId === entry.fileId) {
      applyRoomState(playback); // o relógio original é mantido: entra no ponto certo da música
      sendToHost({ type: 'request-control', action: 'sync' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Salas                                                               */
  /*                                                                     */
  /* Entrada, sincronização E envio dos mp3: mensagens MQTT por WSS      */
  /* (porta 443). Funciona em qualquer rede e NÃO depende de conexão     */
  /* direta (P2P) entre os aparelhos.                                    */
  /* ------------------------------------------------------------------ */

  const DEFAULT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081'
  ];
  const BROKER_CHARS = 'ABCDEFGH';
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ROOM_CODE_RE = /^UJ-[A-H][A-Z0-9]{7}$/;
  const PRESENCE_TTL_MS = 75000;
  const HELLO_EVERY_MS = 1500;
  const JOIN_ACK_TIMEOUT_MS = 9000;

  function brokerList() {
    return Array.isArray(config.MQTT_BROKERS) && config.MQTT_BROKERS.length ? config.MQTT_BROKERS : DEFAULT_BROKERS;
  }
  function brokerIndexOfCode(code) {
    const match = ROOM_CODE_RE.exec(String(code || ''));
    const index = match ? BROKER_CHARS.indexOf(code[3]) : -1;
    return index >= 0 && index < brokerList().length ? index : -1;
  }
  function generateRoomCode(brokerIndex) {
    const bytes = new Uint8Array(7);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return `UJ-${BROKER_CHARS[brokerIndex]}${Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('')}`;
  }
  const roomTopic = (code, suffix) => `ouvirjuntos/v1/${code}/${suffix}`;
  const MY_ID = `g${randomId(10)}`;

  /* ---- Interface ---- */
  function showRoomLive() { ui.roomActions.hidden = true; ui.roomLive.hidden = false; }

  function makeInviteUrl(id) {
    const url = new URL(window.location.origin + window.location.pathname.replace(/index\.html$/, ''));
    url.searchParams.set('sala', id);
    return url.toString();
  }
  function updateUrlRoom(id) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('sala', id);
      window.history.replaceState({}, '', url);
    } catch (_) { /* */ }
  }

  /* O código da última sala criada fica guardado para o anfitrião que recarregar a página
     voltar com o MESMO código (e o link dos amigos continuar valendo). */
  const HOST_CODE_KEY = 'ouvirjuntos.hostRoom.v2';
  const HOST_CODE_TTL_MS = 6 * 60 * 60 * 1000;
  function savedHostCode() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(HOST_CODE_KEY) || 'null');
      if (saved && ROOM_CODE_RE.test(saved.code) && brokerIndexOfCode(saved.code) >= 0 && Date.now() - saved.at < HOST_CODE_TTL_MS) return saved.code;
    } catch (_) { /* */ }
    return '';
  }
  function rememberHostCode(code) { try { window.localStorage.setItem(HOST_CODE_KEY, JSON.stringify({ code, at: Date.now() })); } catch (_) { /* */ } }
  function forgetHostCode() { try { window.localStorage.removeItem(HOST_CODE_KEY); } catch (_) { /* */ } }

  function updateMemberCount() {
    const room = state.room;
    if (!room) return;
    const now = Date.now();
    room.members.forEach((seen, id) => { if (now - seen > PRESENCE_TTL_MS) room.members.delete(id); });
    const count = 1 + room.members.size;
    ui.memberCount.textContent = count === 1 ? '1 pessoa na sala' : `${count} pessoas na sala`;
  }

  /* ---- Mensagens (MQTT) ---- */
  function publishJson(suffix, message, retain = false) {
    const room = state.room;
    if (!room || !room.mqtt) return false;
    return room.mqtt.publish(roomTopic(room.code, suffix), JSON.stringify(message), retain);
  }

  const PLAYLIST_PART_SIZE = 15;
  function playlistParts() {
    const total = Math.max(1, Math.ceil(state.playlist.length / PLAYLIST_PART_SIZE));
    return Array.from({ length: total }, (_, part) => state.playlist.slice(part * PLAYLIST_PART_SIZE, (part + 1) * PLAYLIST_PART_SIZE));
  }

  function publishPlaylistNow() {
    const room = state.room;
    if (!room || room.role !== 'host' || !room.mqtt.connected) return;
    const parts = playlistParts();
    parts.forEach((list, index) => {
      const body = JSON.stringify({ playlist: list });
      if (room.sentParts.get(index) !== body) { room.mqtt.publish(roomTopic(room.code, `pl/${index}`), body, true); room.sentParts.set(index, body); }
    });
    const meta = JSON.stringify({ total: parts.length, name: state.playlistName, sourceUrl: state.playlistSourceUrl, source: state.playlistSource });
    if (room.sentParts.get('meta') !== meta) { room.mqtt.publish(roomTopic(room.code, 'pl/meta'), meta, true); room.sentParts.set('meta', meta); }
  }

  function broadcastPlaylist() {
    const room = state.room;
    if (!state.connected || !state.isHost || !room) return;
    window.clearTimeout(room.playlistTimer);
    room.playlistTimer = window.setTimeout(publishPlaylistNow, 400);
  }

  function broadcastRoomState() {
    if (!state.connected || !state.isHost || !state.roomId || !state.room) return;
    state.lastBroadcastAt = Date.now();
    publishJson('pb', buildRoomState());
  }

  function startSyncTimer() {
    if (state.syncTimer) window.clearInterval(state.syncTimer);
    state.syncTimer = window.setInterval(() => {
      if (!state.connected || !state.isHost || !state.activeEngine) return;
      if (enginePlaying()) {
        updateRoomPlayback({ isPaused: false, position: currentPlayerPosition(), sentAt: Date.now() });
        broadcastRoomState();
      }
    }, 3000);
  }

  function sendToHost(message) {
    const connection = state.hostConnection;
    if (!connection || !connection.open) { setNotice('Você perdeu a conexão com a sala. Aguarde a reconexão ou entre de novo pelo convite.', 'error'); return; }
    try { connection.send(message); } catch (_) { setNotice('Não consegui enviar o comando para a sala.', 'error'); }
  }

  /* ---- Anfitrião ---- */
  function handleHostMessage(message) {
    const room = state.room;
    if (!message || typeof message !== 'object' || !room || room.role !== 'host') return;
    const id = String(message.id || '');
    if (!/^[a-z0-9]{6,24}$/.test(id)) return;
    if (message.type === 'hello') {
      room.members.set(id, Date.now());
      updateMemberCount();
      publishJson(`to/${id}`, { type: 'ack', code: room.code });
      broadcastRoomState();
      return;
    }
    if (message.type === 'sync') { broadcastRoomState(); return; }
    if (message.type === 'request-file') {
      const fileId = String(message.fileId || '');
      if (!/^[a-z0-9]{6,32}$/.test(fileId) || !state.files.has(fileId)) return;
      hostEnqueueFile(fileId, message.ranges);
    }
  }

  function hostOnMessage(room, topic, payload) {
    const suffix = topic.slice(roomTopic(room.code, '').length);
    if (suffix === 'ctl') {
      let message = null;
      try { message = JSON.parse(payload); } catch (_) { return; }
      handleHostMessage(message);
    } else if (suffix.startsWith('presence/')) {
      const id = suffix.slice(9);
      if (!payload) room.members.delete(id);
      else if (id !== room.id) room.members.set(id, Date.now());
      updateMemberCount();
    }
  }

  async function startHost(code) {
    const index = brokerIndexOfCode(code);
    if (index < 0) throw Object.assign(new Error('Código inválido.'), { type: 'bad-code' });
    const id = `h${randomId(10)}`;
    const room = { role: 'host', code, id, mqtt: null, members: new Map(), sentParts: new Map(), playlistTimer: null, pruneTimer: null };
    room.mqtt = new window.OJMqtt.MqttLite({
      urls: [brokerList()[index]],
      clientId: `oj-${id}`,
      will: { topic: roomTopic(code, 'host'), payload: '', retain: true },
      onMessage: (topic, payload) => hostOnMessage(room, topic, payload),
      onState: (s) => {
        if (state.room !== room) return;
        if (s === 'reconnecting') setStatus('Reconectando ao servidor de mensagens…', false);
        if (s === 'connected') {
          room.sentParts.clear();
          room.mqtt.publish(roomTopic(code, 'host'), JSON.stringify({ id, at: Date.now() }), true);
          publishPlaylistNow();
          setStatus(room.members.size ? 'Sala ativa' : 'Sala ativa — aguardando pessoas', true);
        }
      }
    });
    try { await room.mqtt.connect(); }
    catch (error) { room.mqtt.close(true); throw Object.assign(new Error('Sem acesso ao servidor de mensagens.'), { type: 'broker' }); }
    state.room = room;
    room.mqtt.subscribe(roomTopic(code, 'ctl'));
    room.mqtt.subscribe(roomTopic(code, 'presence/+'));
    room.mqtt.publish(roomTopic(code, 'host'), JSON.stringify({ id, at: Date.now() }), true);
    room.pruneTimer = window.setInterval(updateMemberCount, 15000);
    return room;
  }

  async function createRoom() {
    ui.createRoomButton.disabled = true;
    ui.joinRoomButton.disabled = true;
    setNotice('Criando sua sala…');
    try {
      await closeRoom(false);
      let room = null;
      let lastError = null;
      const saved = savedHostCode();
      if (saved) { try { room = await startHost(saved); } catch (error) { lastError = error; } }
      for (let index = 0; !room && index < brokerList().length; index += 1) {
        try { room = await startHost(generateRoomCode(index)); } catch (error) { lastError = error; }
      }
      if (!room) throw lastError || Object.assign(new Error('Sem acesso ao servidor de mensagens.'), { type: 'broker' });
      const id = room.code;
      state.roomId = id;
      state.isHost = true;
      state.connected = true;
      showRoomLive();
      state.inviteUrl = makeInviteUrl(id);
      ui.roomRole.textContent = 'Você é o anfitrião';
      ui.roomHint.textContent = 'Envie o link ou o código. Mantenha esta página aberta: seus mp3 são enviados para a sala a partir do seu aparelho.';
      ui.roomCodeDisplay.textContent = id;
      ui.memberCount.textContent = '1 pessoa na sala';
      setStatus('Sala criada — aguardando pessoas', true);
      ui.roomFootnote.hidden = true;
      setNotice('Sala criada! Copie o convite e envie para seus amigos.', 'success');
      rememberHostCode(id);
      if (state.currentTrackIndex >= 0 && state.playlist[state.currentTrackIndex]) {
        updateRoomPlayback({ trackIndex: state.currentTrackIndex, isPaused: !enginePlaying(), position: currentPlayerPosition(), sentAt: Date.now() });
      }
      publishPlaylistNow();
      broadcastRoomState();
      renderPlaylist();
      startSyncTimer();
    } catch (error) {
      await closeRoom(false);
      setNotice(peerErrorMessage(error), 'error');
      setStatus('Não foi possível criar a sala', false);
    } finally {
      ui.createRoomButton.disabled = false;
      ui.joinRoomButton.disabled = false;
    }
  }

  /* ---- Convidado ---- */
  function tryApplyPlaylist(room) {
    const meta = room.plMeta;
    if (!meta || !Number.isInteger(meta.total) || meta.total < 1 || meta.total > 40) return;
    let list = [];
    for (let index = 0; index < meta.total; index += 1) {
      const part = room.plParts.get(index);
      if (!part) return;
      list = list.concat(part);
    }
    const signature = JSON.stringify([meta.name, meta.sourceUrl, meta.source, list]);
    if (signature === room.plSignature) return;
    room.plSignature = signature;
    resetPlaylistSearchState();
    state.playlist = sanitizePlaylist(list);
    state.playlistName = String(meta.name || 'Playlist da sala').slice(0, 140);
    state.playlistSourceUrl = typeof meta.sourceUrl === 'string' && /^https:\/\//i.test(meta.sourceUrl) ? meta.sourceUrl.slice(0, 300) : '';
    state.playlistSource = String(meta.source || 'Lista da sala').slice(0, 60);
    pruneFiles();
    renderPlaylist();
    if (state.roomPlayback) applyRoomState(state.roomPlayback);
    else if (state.lastUpcoming) prefetchFor(state.lastUpcoming);
  }

  function markGuestAcked(room) {
    if (room.acked) return;
    room.acked = true;
    window.clearInterval(room.helloTimer);
    room.helloTimer = null;
    if (state.hostConnection) state.hostConnection.open = true;
    if (room.ackResolve) { room.ackResolve(); room.ackResolve = null; }
    if (state.connected) {
      setStatus('Conectado à sala', true);
      setNotice('Você voltou para a sala.', 'success');
    }
  }

  function startHello(room) {
    room.acked = false;
    window.clearInterval(room.helloTimer);
    const send = () => { if (state.room === room && !room.acked && room.mqtt.connected) publishJson('ctl', { type: 'hello', id: MY_ID }); };
    send();
    room.helloTimer = window.setInterval(send, HELLO_EVERY_MS);
  }

  function guestOnMessage(room, topic, payload, retained) {
    const suffix = topic.slice(roomTopic(room.code, '').length);
    if (suffix === `to/${MY_ID}`) {
      let message = null;
      try { message = JSON.parse(payload); } catch (_) { return; }
      if (message.type === 'ack') markGuestAcked(room);
    } else if (suffix === 'host') {
      if (!payload) {
        room.hostPresent = false;
        if (state.connected && state.room === room) {
          if (state.hostConnection) state.hostConnection.open = false;
          room.acked = false;
          setStatus('O anfitrião saiu — aguardando ele voltar…', false);
          setNotice('O anfitrião saiu da sala ou perdeu a conexão. Vou voltar sozinho quando ele reaparecer.', 'error');
        }
      } else {
        room.hostPresent = true;
        if (state.connected && state.room === room && !room.acked) startHello(room);
      }
    } else if (suffix === 'pl/meta') {
      try { room.plMeta = JSON.parse(payload); } catch (_) { return; }
      tryApplyPlaylist(room);
    } else if (suffix.startsWith('f/')) {
      onFileChunk(suffix.slice(2), payload);
    } else if (suffix.startsWith('pl/')) {
      const index = Number(suffix.slice(3));
      if (!Number.isInteger(index) || index < 0 || index > 40) return;
      try { room.plParts.set(index, JSON.parse(payload).playlist || []); } catch (_) { return; }
      tryApplyPlaylist(room);
    } else if (suffix === 'pb') {
      if (retained || !room.acked) return;
      try { const pb = JSON.parse(payload); state.lastUpcoming = pb; applyRoomState(pb); } catch (_) { /* */ }
    } else if (suffix.startsWith('presence/')) {
      const id = suffix.slice(9);
      if (!payload) room.members.delete(id); else room.members.set(id, Date.now());
      updateMemberCount();
    }
  }

  async function attemptJoin(code, seq) {
    await closeRoom(false);
    if (seq !== state.joinSeq) throw Object.assign(new Error('Tentativa de entrada cancelada.'), { type: 'cancelled' });
    const index = brokerIndexOfCode(code);
    if (index < 0) throw Object.assign(new Error('Código inválido.'), { type: 'bad-code' });
    const room = { role: 'guest', code, id: MY_ID, mqtt: null, members: new Map(), plParts: new Map(), plMeta: null, plSignature: '', acked: false, hostPresent: false, helloTimer: null, presenceTimer: null, ackResolve: null };
    room.mqtt = new window.OJMqtt.MqttLite({
      urls: [brokerList()[index]],
      clientId: `oj-${MY_ID}`,
      will: { topic: roomTopic(code, `presence/${MY_ID}`), payload: '', retain: true },
      binaryTopic: (topic) => topic.startsWith(roomTopic(code, 'f/')),
      onMessage: (topic, payload, retained) => guestOnMessage(room, topic, payload, retained),
      onState: (s) => {
        if (state.room !== room || !state.connected) return;
        if (s === 'reconnecting') { setStatus('Reconectando ao servidor de mensagens…', false); if (state.hostConnection) state.hostConnection.open = false; room.acked = false; }
        if (s === 'connected') { publishJson(`presence/${MY_ID}`, { t: Date.now() }, true); startHello(room); }
      }
    });
    state.room = room;
    state.roomId = code;
    state.isHost = false;
    state.hostConnection = { open: false, send: (message) => {
      if (message.type === 'request-control') publishJson('ctl', { type: 'sync', id: MY_ID });
    } };
    try { await room.mqtt.connect(); }
    catch (error) { throw Object.assign(new Error('Sem acesso ao servidor de mensagens.'), { type: 'broker' }); }
    if (seq !== state.joinSeq) throw Object.assign(new Error('Tentativa de entrada cancelada.'), { type: 'cancelled' });
    ['host', 'pl/#', 'pb', 'f/+', 'presence/+', `to/${MY_ID}`].forEach((suffix) => room.mqtt.subscribe(roomTopic(code, suffix)));
    publishJson(`presence/${MY_ID}`, { t: Date.now() }, true);
    const acked = new Promise((resolve) => { room.ackResolve = resolve; });
    startHello(room);
    const found = await Promise.race([acked.then(() => true), sleep(JOIN_ACK_TIMEOUT_MS).then(() => false)]);
    if (seq !== state.joinSeq) throw Object.assign(new Error('Tentativa de entrada cancelada.'), { type: 'cancelled' });
    if (!found) throw Object.assign(new Error('Sala não encontrada.'), { type: 'peer-unavailable' });
    state.connected = true;
    room.presenceTimer = window.setInterval(() => { publishJson(`presence/${MY_ID}`, { t: Date.now() }, true); updateMemberCount(); }, 20000);
    renderPlaylist();
    showRoomLive();
    ui.roomRole.textContent = 'Você entrou na sala';
    ui.roomCodeDisplay.textContent = code;
    ui.roomHint.textContent = 'Você está conectado. Quando a música começar, aperte “Ativar meu player” se o navegador bloquear o início automático.';
    ui.roomFootnote.hidden = true;
    setStatus('Conectado à sala', true);
    updateMemberCount();
    state.inviteUrl = makeInviteUrl(code);
    updateUrlRoom(code);
  }

  async function joinRoom(roomId) {
    const code = normalizedRoomCode(roomId);
    if (!code) { setNotice('Digite ou cole o código ou o link do convite.', 'error'); return false; }
    if (!ROOM_CODE_RE.test(code) || brokerIndexOfCode(code) < 0) {
      setNotice('Esse código não é válido (ele tem a forma UJ-XXXXXXXX). Peça ao anfitrião para criar uma sala nova e mandar o novo convite.', 'error');
      return false;
    }
    const seq = ++state.joinSeq;
    ui.createRoomButton.disabled = true;
    ui.joinRoomButton.disabled = true;
    setNotice('Entrando na sala…');
    setStatus('Entrando na sala…', false);
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (seq !== state.joinSeq) return false;
        try {
          if (attempt > 1) setNotice(`Procurando a sala… tentativa ${attempt} de 3.`);
          await attemptJoin(code, seq);
          setNotice('Entrada confirmada! Agora você está na sala.', 'success');
          return true;
        } catch (error) {
          lastError = error;
          if (seq !== state.joinSeq || (error && error.type === 'cancelled')) return false;
          if (attempt >= 3 || (error && error.type === 'bad-code')) break;
          await sleep(1500);
        }
      }
      throw lastError || new Error('Não consegui entrar na sala.');
    } catch (error) {
      if (seq === state.joinSeq) {
        await closeRoom(false);
        ui.roomCodeInput.value = code;
        updateUrlRoom(code); // recarregar a página tenta de novo
        setNotice(peerErrorMessage(error), 'error');
        setStatus('Não foi possível entrar na sala', false);
      }
      return false;
    } finally {
      if (seq === state.joinSeq) {
        ui.createRoomButton.disabled = false;
        ui.joinRoomButton.disabled = false;
      }
    }
  }

  /* ---- Utilidades da sala ---- */
  async function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    if (!copied) throw new Error('copy-failed');
  }

  async function copyInvite() {
    if (!state.roomId) { setNotice('Crie ou entre em uma sala antes de copiar o convite.', 'error'); return; }
    const text = state.inviteUrl || makeInviteUrl(state.roomId);
    try {
      await writeClipboard(text);
      ui.copyInviteButton.textContent = 'Link copiado ✓';
      setNotice('Link copiado! Seu amigo pode abrir o link para entrar automaticamente.', 'success');
      window.setTimeout(() => { ui.copyInviteButton.textContent = 'Copiar convite'; }, 2200);
    } catch (_) { setNotice(`Não consegui copiar o link. Envie este código manualmente: ${state.roomId}`, 'error'); }
  }

  async function copyRoomCode() {
    if (!state.roomId) { setNotice('Crie ou entre em uma sala antes de copiar o código.', 'error'); return; }
    try {
      await writeClipboard(state.roomId);
      ui.copyRoomCodeButton.textContent = 'Código copiado ✓';
      setNotice('Código copiado! Seu amigo pode colá-lo no campo de convite.', 'success');
      window.setTimeout(() => { ui.copyRoomCodeButton.textContent = 'Copiar código'; }, 2200);
    } catch (_) { setNotice(`Não consegui copiar automaticamente. Código da sala: ${state.roomId}`, 'error'); }
  }

  function peerErrorMessage(error) {
    const type = error && error.type;
    const messages = {
      'peer-unavailable': 'Não encontrei uma sala ativa com esse código. O anfitrião precisa estar com a página aberta; peça para ele criar a sala (ou recarregar e clicar em “Criar sala”) e mandar o convite de novo.',
      'broker': 'Não consegui falar com o servidor de mensagens das salas (porta 443/WSS). Pode ser bloqueio da rede, de uma extensão ou do antivírus; teste outra rede ou outro navegador.',
      'bad-code': 'Esse código não é válido. Peça ao anfitrião para criar uma sala nova e mandar o novo convite.'
    };
    if (type && messages[type]) return messages[type];
    if (error && error.message) return error.message;
    return 'Ocorreu um erro ao conectar à sala. Confira o código e sua conexão com a internet.';
  }

  async function closeRoom(showMessage = true) {
    const room = state.room;
    state.room = null;
    if (room) {
      window.clearInterval(room.helloTimer);
      window.clearInterval(room.presenceTimer);
      window.clearInterval(room.pruneTimer);
      window.clearTimeout(room.playlistTimer);
      try {
        if (room.mqtt && room.mqtt.connected) {
          const clear = (suffix) => room.mqtt.publish(roomTopic(room.code, suffix), '', true);
          if (room.role === 'host') {
            clear('host');
            room.sentParts.forEach((_, key) => clear(key === 'meta' ? 'pl/meta' : `pl/${key}`));
          } else clear(`presence/${MY_ID}`);
        }
      } catch (_) { /* */ }
      try { if (room.mqtt) room.mqtt.close(true); } catch (_) { /* */ }
    }
    state.hostJobs.clear();
    Array.from(state.incoming.keys()).forEach(dropIncoming);
    state.lastUpcoming = null;
    state.hostConnection = null;
    state.roomId = null;
    state.isHost = false;
    state.connected = false;
    state.inviteUrl = null;
    if (state.syncTimer) { window.clearInterval(state.syncTimer); state.syncTimer = null; }
    ui.roomActions.hidden = false;
    ui.roomLive.hidden = true;
    ui.roomFootnote.hidden = false;
    ui.roomCodeInput.value = '';
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('sala');
      window.history.replaceState({}, '', url);
    } catch (_) { /* */ }
    setStatus('Você está offline de uma sala', false);
    if (showMessage) setNotice('Você saiu da sala. A playlist continua aberta neste dispositivo.', 'success');
    renderPlaylist();
  }

  // Ao fechar/recarregar a página, derruba a conexão sem avisar para o servidor publicar a "última vontade"
  // (assim a sala some na hora para os outros).
  window.addEventListener('pagehide', () => { if (state.room && state.room.mqtt) state.room.mqtt.close(false); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });

  /* ------------------------------------------------------------------ */
  /* Eventos da página                                                   */
  /* ------------------------------------------------------------------ */

  ui.createRoomButton.addEventListener('click', () => { unlockMedia(); state.joinSeq += 1; createRoom(); });
  ui.joinRoomButton.addEventListener('click', () => { unlockMedia(); joinRoom(ui.roomCodeInput.value); });
  ui.roomCodeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { unlockMedia(); joinRoom(ui.roomCodeInput.value); } });
  ui.copyInviteButton.addEventListener('click', copyInvite);
  ui.copyRoomCodeButton.addEventListener('click', copyRoomCode);
  ui.leaveRoomButton.addEventListener('click', () => { state.joinSeq += 1; forgetHostCode(); closeRoom(true); });

  ui.playlistForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!isPlaylistController()) { setNotice('O anfitrião é quem importa e controla a playlist da sala.', 'error'); return; }
    try { await importFromLink(ui.spotifyUrlInput.value); }
    catch (error) { setNotice(error.message || 'Não consegui importar essa playlist.', 'error'); }
  });

  ui.importManualButton.addEventListener('click', () => {
    if (!isPlaylistController()) { setNotice('O anfitrião é quem controla a playlist da sala.', 'error'); return; }
    const parsed = lib.parseManualPlaylist(ui.manualTrackList.value);
    if (!parsed.length) { setNotice('Cole ao menos uma faixa. Use o formato “Nome da música - Artista”.', 'error'); return; }
    applyImportedPlaylist({ name: 'Playlist colada', service: 'Lista colada', sourceUrl: '', tracks: parsed.map((track) => newTrack(track.title, track.artist)) });
    setNotice(`Importei ${parsed.length} ${parsed.length === 1 ? 'faixa' : 'faixas'}. Procurando versões sem anúncios…`, 'success');
    autoMatchAudius();
  });

  ui.addFilesButton.addEventListener('click', () => {
    if (!isPlaylistController()) { setNotice('Só o anfitrião pode adicionar arquivos.', 'error'); return; }
    ui.addFilesInput.value = '';
    ui.addFilesInput.click();
  });
  ui.addFilesInput.addEventListener('change', () => addLocalFiles(ui.addFilesInput.files));
  ui.addFolderButton.addEventListener('click', () => {
    if (!isPlaylistController()) { setNotice('Só o anfitrião pode adicionar arquivos.', 'error'); return; }
    ui.addFolderInput.value = '';
    ui.addFolderInput.click();
  });
  ui.addFolderInput.addEventListener('change', () => addLocalFiles(ui.addFolderInput.files, -1, { folder: true }));
  ui.playAllButton.addEventListener('click', playAll);
  ui.prevButton.addEventListener('click', playPrevious);
  ui.nextButton.addEventListener('click', () => playNext(false));
  ui.shuffleButton.addEventListener('click', toggleShuffle);
  ui.trackFileInput.addEventListener('change', () => {
    const index = state.pendingFileTrackIndex;
    state.pendingFileTrackIndex = -1;
    if (index >= 0) addLocalFiles(ui.trackFileInput.files, index);
  });

  ui.playPauseButton.addEventListener('click', toggleLocalPlayback);
  ui.syncButton.addEventListener('click', syncPlayback);

  [['audio', ui.audioPlayer], ['file', ui.fileAudio]].forEach(([engine, el]) => {
    el.addEventListener('play', () => {
      if (state.activeEngine !== engine || el.__unlocking) return;
      onEnginePlaying('Tocando. A sala acompanha a posição da faixa.');
    });
    el.addEventListener('pause', () => { if (state.activeEngine === engine && !el.ended && !el.__unlocking) onEnginePaused(); });
    el.addEventListener('ended', () => { if (state.activeEngine === engine) onEngineEnded(); });
    el.addEventListener('seeked', () => {
      if (state.activeEngine !== engine || playerEventsSuppressed() || !isPlaylistController()) return;
      updateRoomPlayback({ isPaused: el.paused, position: el.currentTime, sentAt: Date.now() });
      broadcastRoomState();
    });
    el.addEventListener('loadedmetadata', () => {
      const target = state.audioPendingSeek[engine];
      if (target !== null && target !== undefined) {
        state.audioPendingSeek[engine] = null;
        try { el.currentTime = target; } catch (_) { /* */ }
      }
    });
    el.addEventListener('error', onAudioError);
  });

  document.addEventListener('pointerdown', unlockMedia, { once: true, capture: true });

  renderPlaylist();

  const params = new URLSearchParams(window.location.search);
  const inviteRoom = normalizedRoomCode(params.get('sala') || '');
  if (inviteRoom) {
    ui.roomCodeInput.value = inviteRoom;
    setNotice('Convite encontrado. Tentando entrar na sala…');
    window.setTimeout(() => joinRoom(inviteRoom), 350);
  }
})();
