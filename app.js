'use strict';

const ASSEMBLYAI = 'https://api.assemblyai.com/v2';
const POLL_MS = 3000;
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  mediaRecorder: null,
  audioChunks: [],    // Blob[]
  mimeType: '',
  startTime: null,    // Date.now() at recording start
  timerInterval: null,
  notes: [],          // { timestamp_ms, text }[]
  transcript: null,   // processed segments[]
  speakers: {},       // { A: 'Speaker A', B: 'Speaker B', ... } — user-editable labels
  stream: null,
  audioCtx: null,
  audioSource: null,  // MediaStreamAudioSourceNode — shared between waveform + PCM pipe
  analyser: null,
  animFrame: null,
  isRecording: false,
  endTime: null,
  providerUsed: null,
  abortController: null,
  // Near-real-time live transcription (periodic batch chunks)
  liveInterval: null,
  liveChunkIndex: 0,  // index into audioChunks of next unprocessed chunk
  liveSegments: [],   // { start_ms, text }[] accumulated during recording
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const providerSelect      = $('provider');
const apiKeyField         = $('apiKeyField');
const keyLabel            = $('keyLabel');
const audioSourceSelect   = $('audioSource');
const liveToggleGroup     = $('liveToggleGroup');

// Per-provider key store — persists values when switching providers
const keyStore = { assemblyai: '', whisper: '' };

function getActiveKey() { return apiKeyField.value.trim(); }

function syncKeyStore() {
  keyStore[providerSelect.value] = apiKeyField.value;
}

// Aliases for legacy references throughout the code
const apiKeyInput    = { get value() { return apiKeyField.value; }, set value(v) { apiKeyField.value = v; }, get disabled() { return apiKeyField.disabled; }, set disabled(v) { apiKeyField.disabled = v; } };
const openaiKeyInput = apiKeyInput;
const languageSelect      = $('language');
const startBtn            = $('startBtn');
const stopBtn             = $('stopBtn');
const downloadAudioBtn    = $('downloadAudioBtn');
const timerEl             = $('timer');
const waveformCanvas      = $('waveform');
const statusSection       = $('statusSection');
const statusMessage       = $('statusMessage');
const progressBar         = $('progressBar');
const transcriptContainer = $('transcriptContainer');
const speakerRename       = $('speakerRename');
const noteInput           = $('noteInput');
const addNoteBtn          = $('addNoteBtn');
const notesList           = $('notesList');
const exportOptions       = $('exportOptions');
const exportBtn           = $('exportBtn');
const exportSeparateBtn   = $('exportSeparateBtn');
const cancelBtn           = $('cancelBtn');
const liveModeCheckbox    = $('liveMode');
const newSessionBtn       = $('newSessionBtn');
const newSessionBtn2      = $('newSessionBtn2');
const modeRecordBtn       = $('modeRecordBtn');
const modeUploadBtn       = $('modeUploadBtn');
const recordSection       = $('recordSection');
const uploadSection       = $('uploadSection');
const fileInput           = $('fileInput');
const fileName            = $('fileName');
const transcribeFileBtn   = $('transcribeFileBtn');
const intervieweeName     = $('intervieweeName');
const sessionNotes        = $('sessionNotes');
const formatHint          = $('formatHint');

const recordingIndicator  = $('recordingIndicator');
const connectionBadge     = $('connectionBadge');
const waveCtx = waveformCanvas.getContext('2d');

function updateConnectionBadge() {
  const online = navigator.onLine;
  connectionBadge.textContent = online ? 'Online' : 'Offline';
  connectionBadge.className = online ? 'is-online' : 'is-offline';
}

window.addEventListener('online', updateConnectionBadge);
window.addEventListener('offline', updateConnectionBadge);
updateConnectionBadge();

function setViewportState(state) {
  recordingIndicator.classList.remove('is-recording', 'is-error');
  if (state) recordingIndicator.classList.add(state);
}


// Inject keys from config.js if present (gitignored locally, absent on GitHub Pages)
if (window.APP_CONFIG) {
  if (window.APP_CONFIG.assemblyaiKey) keyStore.assemblyai = window.APP_CONFIG.assemblyaiKey;
  if (window.APP_CONFIG.openaiKey)     keyStore.whisper    = window.APP_CONFIG.openaiKey;
}


// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function elapsed() {
  return state.startTime ? Date.now() - state.startTime : 0;
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(msg, pct, cancellable = false) {
  statusSection.hidden = false;
  statusMessage.textContent = msg;
  if (pct != null) progressBar.style.width = pct + '%';
  cancelBtn.hidden = !cancellable;
}

function clearStatus() {
  statusSection.hidden = true;
  progressBar.style.width = '0%';
  cancelBtn.hidden = true;
  setViewportState(null);
}

function speakerLabel(code) {
  return state.speakers[code] || `Speaker ${code}`;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
async function startRecording() {
  let stream;
  try {
    if (audioSourceSelect.value === 'tab') {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getVideoTracks().forEach(t => t.stop());
      if (!stream.getAudioTracks().length) {
        alert('No audio captured. Make sure to enable "Share tab audio" in the browser picker.');
        return;
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  } catch (e) {
    alert(`Audio access denied: ${e.message}`);
    return;
  }

  // Reset session
  state.audioChunks = [];
  state.notes = [];
  state.transcript = null;
  state.speakers = {};
  state.liveSegments = [];
  state.liveChunkIndex = 0;
  notesList.innerHTML = '';
  transcriptContainer.innerHTML = '<p class="placeholder">Recording… add notes on the right.</p>';
  speakerRename.hidden = true;
  speakerRename.innerHTML = '';
  exportOptions.hidden = true;

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  state.mimeType = mimeType;
  state.stream = stream;

  state.mediaRecorder = new MediaRecorder(stream, { mimeType });
  state.mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
  };
  state.mediaRecorder.start(1000);

  state.startTime = Date.now();
  state.isRecording = true;
  setViewportState('is-recording');

  state.timerInterval = setInterval(() => {
    timerEl.textContent = fmtTime(elapsed());
  }, 500);

  setupAudio();

  if (liveModeCheckbox.checked) {
    startLiveChunking();
  }

  startBtn.disabled = true;
  stopBtn.disabled = false;
  downloadAudioBtn.disabled = false;
  noteInput.disabled = false;
  addNoteBtn.disabled = false;
  languageSelect.disabled = true;
  audioSourceSelect.disabled = true;
  liveModeCheckbox.disabled = true;
  intervieweeName.disabled = true;
  sessionNotes.disabled = true;
  newSessionBtn.hidden = true;
}

function stopMediaRecorder() {
  return new Promise(resolve => {
    state.mediaRecorder.addEventListener('stop', resolve, { once: true });
    state.mediaRecorder.stop();
  });
}

async function handleStop() {
  // If recording is still active, stop it first
  if (state.isRecording) {
    state.isRecording = false;
    stopBtn.disabled = true;
    startBtn.disabled = true;
    noteInput.disabled = true;
    addNoteBtn.disabled = true;

    clearInterval(state.timerInterval);
    cancelAnimationFrame(state.animFrame);

    stopLiveChunking();
    await stopMediaRecorder();
    state.stream.getTracks().forEach(t => t.stop());

    if (state.audioCtx) {
      state.audioCtx.close();
      state.audioCtx = null;
    }

    drawFlatLine();
    state.endTime = Date.now();
    setViewportState(null);
    newSessionBtn.hidden = false;
  }

  // Always disable stop while attempting transcription
  stopBtn.disabled = true;

  const provider = providerSelect.value;
  const key = getActiveKey();

  if (!key) {
    const label = provider === 'whisper' ? 'OpenAI' : 'AssemblyAI';
    setStatus(`Recording saved. Enter your ${label} API key then click Stop & Transcribe.`, 0);
    stopBtn.textContent = '↑ Transcribe Now';
    stopBtn.disabled = false;
    return;
  }

  const blob = new Blob(state.audioChunks, { type: state.mimeType });

  if (provider === 'whisper') {
    await runWhisperTranscription(blob, key);
  } else {
    await runAssemblyAITranscription(blob, key);
  }

  liveModeCheckbox.disabled = false;
}

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------
function setupAudio() {
  state.audioCtx = new AudioContext();
  state.audioSource = state.audioCtx.createMediaStreamSource(state.stream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512;
  state.audioSource.connect(state.analyser);
  drawWaveform();
}

function drawWaveform() {
  const buf = new Uint8Array(state.analyser.frequencyBinCount);
  const W = waveformCanvas.width;
  const H = waveformCanvas.height;

  function frame() {
    state.animFrame = requestAnimationFrame(frame);
    state.analyser.getByteTimeDomainData(buf);
    waveCtx.fillStyle = '#0d1117';
    waveCtx.fillRect(0, 0, W, H);
    waveCtx.lineWidth = 1.5;
    waveCtx.strokeStyle = '#3b82f6';
    waveCtx.beginPath();
    const step = W / buf.length;
    for (let i = 0; i < buf.length; i++) {
      const y = (buf[i] / 128) * (H / 2);
      i === 0 ? waveCtx.moveTo(0, y) : waveCtx.lineTo(i * step, y);
    }
    waveCtx.stroke();
  }
  frame();
}

function drawFlatLine() {
  const W = waveformCanvas.width;
  const H = waveformCanvas.height;
  waveCtx.fillStyle = '#0d1117';
  waveCtx.fillRect(0, 0, W, H);
  waveCtx.lineWidth = 1.5;
  waveCtx.strokeStyle = '#374151';
  waveCtx.beginPath();
  waveCtx.moveTo(0, H / 2);
  waveCtx.lineTo(W, H / 2);
  waveCtx.stroke();
}

function resizeCanvas() {
  waveformCanvas.width = waveformCanvas.offsetWidth;
  waveformCanvas.height = waveformCanvas.offsetHeight || 72;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
function addNote() {
  const text = noteInput.value.trim();
  if (!text) return;

  const note = { timestamp_ms: elapsed(), text };
  state.notes.push(note);
  noteInput.value = '';

  const el = document.createElement('div');
  el.className = 'note-item';
  el.innerHTML = `<span class="note-time">${fmtTime(note.timestamp_ms)}</span>`
               + `<span class="note-text">${esc(note.text)}</span>`;
  notesList.prepend(el);
}

// ---------------------------------------------------------------------------
// AssemblyAI API
// ---------------------------------------------------------------------------
async function uploadAudio(blob, key, attempt = 1, signal) {
  try {
    const res = await fetch(`${ASSEMBLYAI}/upload`, {
      method: 'POST',
      headers: { authorization: key },
      body: blob,
      signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Upload HTTP ${res.status}: ${txt}`);
    }
    const { upload_url } = await res.json();
    return upload_url;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const delay = 2000 * attempt;
      setStatus(`Upload attempt ${attempt} failed — retrying in ${delay / 1000}s…`, 10);
      await sleep(delay);
      return uploadAudio(blob, key, attempt + 1, signal);
    }
    throw err;
  }
}

async function submitTranscript(audioUrl, key, signal) {
  const lang = languageSelect.value;
  const body = {
    audio_url: audioUrl,
    speaker_labels: true,
    ...(lang ? { language_code: lang } : { language_detection: true }),
  };

  const res = await fetch(`${ASSEMBLYAI}/transcript`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Submit HTTP ${res.status}: ${txt}`);
  }
  const { id } = await res.json();
  return id;
}

async function pollUntilDone(id, key, signal) {
  let pct = 45;
  while (true) {
    await sleep(POLL_MS);
    const res = await fetch(`${ASSEMBLYAI}/transcript/${id}`, {
      headers: { authorization: key },
      signal,
    });
    if (!res.ok) throw new Error(`Poll HTTP ${res.status}`);
    const data = await res.json();

    if (data.status === 'error') throw new Error(`AssemblyAI error: ${data.error}`);

    if (data.status === 'completed') {
      state.transcript = splitIntoSegments(data);
      renderTranscript();
      clearStatus();
      exportOptions.hidden = false;
      return;
    }

    pct = Math.min(pct + 4, 88);
    setStatus('Processing audio…', pct);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runAssemblyAITranscription(blob, key) {
  state.providerUsed = 'assemblyai';
  state.abortController = new AbortController();
  const { signal } = state.abortController;
  const statusMsg = state.liveSegments.length
    ? 'Uploading for full transcript with speaker labels…'
    : 'Uploading audio to AssemblyAI…';
  setStatus(statusMsg, 10, true);
  try {
    const uploadUrl = await uploadAudio(blob, key, 1, signal);
    setStatus('Processing…', 40, true);
    const id = await submitTranscript(uploadUrl, key, signal);
    await pollUntilDone(id, key, signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('Upload cancelled. Audio still available via "Save Audio".', 0);
      newSessionBtn.hidden = false;
      return;
    }
    setStatus(`Error: ${err.message} — Your audio is still available via "Save Audio".`, 0);
    setViewportState('is-error');
    console.error('AssemblyAI error:', err);
  }
}

async function runWhisperTranscription(blob, key) {
  state.providerUsed = 'whisper';
  state.abortController = new AbortController();
  const sizeMB = blob.size / 1024 / 1024;
  const isWav = blob.type === 'audio/wav' || blob.type === 'audio/wave';

  if (sizeMB > 24.5 && !isWav) {
    setStatus(`Audio is ${sizeMB.toFixed(1)}MB — exceeds Whisper's 25MB limit. Re-export as MP3 (90% smaller) or switch to AssemblyAI.`, 0);
    return;
  }

  let blobs = [blob];
  if (sizeMB > 24.5 && isWav) {
    setStatus(`WAV file is ${sizeMB.toFixed(1)}MB — splitting into chunks…`, 10);
    try {
      blobs = await splitWavBlob(blob, 24 * 1024 * 1024);
      setStatus(`Split into ${blobs.length} chunks — transcribing…`, 20);
    } catch (e) {
      setStatus(`Could not split WAV: ${e.message}. Re-export as MP3 or switch to AssemblyAI.`, 0);
      return;
    }
  }

  const { signal } = state.abortController;
  let pct = blobs.length > 1 ? 20 : 10;
  setStatus(`Uploading to Whisper… (may take 1–3 min)`, pct, true);
  const progressInterval = setInterval(() => {
    pct = Math.min(pct + 2, 85);
    progressBar.style.width = pct + '%';
  }, 2000);

  try {
    const lang = languageSelect.value;
    const results = [];
    for (let i = 0; i < blobs.length; i++) {
      if (blobs.length > 1) setStatus(`Transcribing chunk ${i + 1} of ${blobs.length}…`, pct, true);
      results.push(await transcribeWithWhisper(blobs[i], key, lang, signal));
    }
    clearInterval(progressInterval);

    // Merge segments — offset each chunk's timestamps by previous duration
    const merged = { segments: [] };
    let offsetMs = 0;
    for (const data of results) {
      const lastSeg = data.segments?.at(-1);
      for (const seg of (data.segments || [])) {
        merged.segments.push({ ...seg, start: seg.start + offsetMs / 1000, end: seg.end + offsetMs / 1000 });
      }
      offsetMs += lastSeg ? (lastSeg.end * 1000) : (data.duration * 1000 || 0);
    }

    state.transcript = processWhisperSegments(merged);
    renderTranscript();
    clearStatus();
    exportOptions.hidden = false;
  } catch (err) {
    clearInterval(progressInterval);
    if (err.name === 'AbortError') {
      setStatus('Upload cancelled. Audio still available via "Save Audio".', 0);
      newSessionBtn.hidden = false;
      return;
    }
    setStatus(`Whisper error: ${err.message} — Your audio is still available via "Save Audio".`, 0);
    setViewportState('is-error');
    console.error('Whisper error:', err);
  }
}

async function splitWavBlob(blob, maxBytes) {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);

  // Validate RIFF WAV
  const riff = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (riff !== 'RIFF') throw new Error('Not a valid WAV file');

  const headerSize = 44;
  const blockAlign = view.getUint16(32, true); // bytes per sample frame
  const dataBytes = view.getUint32(40, true);

  const maxDataPerChunk = Math.floor((maxBytes - headerSize) / blockAlign) * blockAlign;
  const chunks = [];
  let offset = 0;

  while (offset < dataBytes) {
    const chunkDataLen = Math.min(maxDataPerChunk, dataBytes - offset);
    const chunkBuf = new ArrayBuffer(headerSize + chunkDataLen);
    // Copy header
    new Uint8Array(chunkBuf).set(new Uint8Array(buf, 0, headerSize));
    // Update sizes
    new DataView(chunkBuf).setUint32(4, 36 + chunkDataLen, true);
    new DataView(chunkBuf).setUint32(40, chunkDataLen, true);
    // Copy audio data
    new Uint8Array(chunkBuf, headerSize).set(new Uint8Array(buf, headerSize + offset, chunkDataLen));
    chunks.push(new Blob([chunkBuf], { type: 'audio/wav' }));
    offset += chunkDataLen;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// OpenAI Whisper API
// ---------------------------------------------------------------------------

async function transcribeWithWhisper(blob, key, lang, signal) {
  const formData = new FormData();
  formData.append('file', blob, blob.name || 'recording.webm');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');
  formData.append('temperature', '0');
  if (lang) formData.append('language', lang);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: formData,
    signal,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

function processWhisperSegments(data) {
  return (data.segments || [])
    .filter(s => s.text.trim())
    .map(s => ({
      speaker: 'A',
      start: Math.round(s.start * 1000),
      end: Math.round(s.end * 1000),
      text: s.text.trim(),
    }));
}

// ---------------------------------------------------------------------------
// Near-real-time transcription (5-second batch chunks)
// ---------------------------------------------------------------------------

const LIVE_CHUNK_INTERVAL_MS = 3000;
const LIVE_CHUNK_MIN_CHUNKS = 2; // skip if fewer than ~2s accumulated
const LIVE_POLL_MS = 1000;        // faster polling for live chunks vs main batch

function startLiveChunking() {
  setLiveStatus('● Live', false);
  transcriptContainer.innerHTML = '<p class="placeholder live-active">&#9679; Live transcript active — text appears ~10s after speech</p>';
  state.liveInterval = setInterval(processLiveChunk, LIVE_CHUNK_INTERVAL_MS);
}

function stopLiveChunking() {
  if (state.liveInterval) {
    clearInterval(state.liveInterval);
    state.liveInterval = null;
  }
  setLiveStatus('', false);
}

async function chunkHasSpeech(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1024, 16000);
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    const data = buffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length) > 0.005; // below threshold = silence
  } catch {
    return true; // can't decode → send anyway
  }
}

async function processLiveChunk() {
  const from = state.liveChunkIndex;
  const to = state.audioChunks.length;
  if (to - from < LIVE_CHUNK_MIN_CHUNKS) return;

  state.liveChunkIndex = to;
  const chunkStartMs = from * 1000; // 1 MediaRecorder chunk ≈ 1s

  const provider = providerSelect.value;
  const key = getActiveKey();
  if (!key) return;

  // WebM header lives in chunk 0 — must prepend it to every non-first slice
  const slice = state.audioChunks.slice(from, to);
  const blobParts = from === 0 ? slice : [state.audioChunks[0], ...slice];
  const chunkBlob = new Blob(blobParts, { type: state.mimeType });

  // Skip silent chunks — prevents Whisper hallucinations and saves API calls
  if (!(await chunkHasSpeech(chunkBlob))) return;

  try {
    let text;

    if (provider === 'whisper') {
      const file = new File([chunkBlob], 'chunk.webm', { type: state.mimeType });
      const data = await transcribeWithWhisper(file, key, languageSelect.value);
      text = data.text?.trim();
    } else {
      const uploadRes = await fetch(`${ASSEMBLYAI}/upload`, {
        method: 'POST',
        headers: { authorization: key },
        body: chunkBlob,
      });
      if (!uploadRes.ok) return;
      const { upload_url } = await uploadRes.json();

      const lang = languageSelect.value;
      const submitRes = await fetch(`${ASSEMBLYAI}/transcript`, {
        method: 'POST',
        headers: { authorization: key, 'content-type': 'application/json' },
        body: JSON.stringify({
          audio_url: upload_url,
          ...(lang ? { language_code: lang } : { language_detection: true }),
        }),
      });
      if (!submitRes.ok) return;
      const { id } = await submitRes.json();
      text = await pollChunkText(id, key);
    }

    if (text) {
      state.liveSegments.push({ start_ms: chunkStartMs, text });
      state.liveSegments.sort((a, b) => a.start_ms - b.start_ms);
      renderLiveTranscript();
    }
  } catch (e) {
    console.warn('Live chunk error:', e.message);
  }
}

async function pollChunkText(id, key) {
  for (let i = 0; i < 60; i++) {
    await sleep(LIVE_POLL_MS);
    const res = await fetch(`${ASSEMBLYAI}/transcript/${id}`, {
      headers: { authorization: key },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === 'completed') return data.text || null;
    if (data.status === 'error') return null;
  }
  return null;
}

function setLiveStatus(text, isError) {
  const el = $('liveStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'live-status' + (isError ? ' live-status-error' : ' live-status-ok');
  el.hidden = !text;
}

function renderLiveTranscript() {
  transcriptContainer.innerHTML = '';
  for (const seg of state.liveSegments) {
    const el = document.createElement('div');
    el.className = 'utterance';
    el.innerHTML =
      `<span class="utt-time">${fmtTime(seg.start_ms)}</span>`
    + `<span class="utt-speaker speaker-A">Live</span>`
    + `<span class="utt-text">${esc(seg.text)}</span>`;
    transcriptContainer.appendChild(el);
  }
  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

// ---------------------------------------------------------------------------
// Sentence-level splitting
// ---------------------------------------------------------------------------
const MAX_SEGMENT_MS = 45000;

function splitIntoSegments(data) {
  // Build word list with speaker — prefer utterances[].words, fall back to data.words
  let wordSources;
  if (data.utterances && data.utterances.length) {
    wordSources = data.utterances.flatMap(utt =>
      (utt.words || []).map(w => ({ ...w, speaker: utt.speaker || 'A' }))
    );
  } else if (data.words && data.words.length) {
    wordSources = data.words.map(w => ({ ...w, speaker: w.speaker || 'A' }));
  } else {
    return [];
  }

  const segments = [];
  let segStart = null;
  let segWords = [];
  let currentSpeaker = null;

  function flush() {
    if (!segWords.length) return;
    segments.push({
      speaker: currentSpeaker,
      start: segStart,
      end: segWords[segWords.length - 1].end,
      text: segWords.map(w => w.text).join(' '),
    });
    segWords = [];
    segStart = null;
  }

  for (const w of wordSources) {
    // Speaker change always starts new segment
    if (currentSpeaker !== null && w.speaker !== currentSpeaker) flush();

    currentSpeaker = w.speaker;
    if (segStart === null) segStart = w.start;
    segWords.push(w);

    const duration = w.end - segStart;
    const isSentenceEnd = /[.?!]$/.test(w.text.trim());

    if (isSentenceEnd || duration >= MAX_SEGMENT_MS) flush();
  }
  flush();

  return segments;
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------
function renderTranscript() {
  transcriptContainer.innerHTML = '';

  if (!state.transcript || state.transcript.length === 0) {
    transcriptContainer.innerHTML = '<p class="placeholder">No speech detected.</p>';
    return;
  }

  const isWhisper = state.providerUsed === 'whisper';

  if (!isWhisper) {
    const speakerCodes = [...new Set(state.transcript.map(s => s.speaker))].sort();
    for (const code of speakerCodes) {
      if (!state.speakers[code]) state.speakers[code] = `Speaker ${code}`;
    }
    buildSpeakerRename(speakerCodes);
  } else {
    speakerRename.hidden = true;
  }

  for (const seg of state.transcript) {
    const el = document.createElement('div');
    el.className = 'utterance';
    el.innerHTML = isWhisper
      ? `<span class="utt-time">${fmtTime(seg.start)}</span>`
      + `<span class="utt-text utt-text-full">${esc(seg.text)}</span>`
      : `<span class="utt-time">${fmtTime(seg.start)}</span>`
      + `<span class="utt-speaker speaker-${esc(seg.speaker)}" data-code="${esc(seg.speaker)}">${esc(state.speakers[seg.speaker])}</span>`
      + `<span class="utt-text">${esc(seg.text)}</span>`;
    transcriptContainer.appendChild(el);
  }
  transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

function buildSpeakerRename(codes) {
  speakerRename.innerHTML = '';
  for (const code of codes) {
    const pair = document.createElement('div');
    pair.className = 'rename-pair';
    const label = document.createElement('label');
    label.textContent = `Speaker ${code}:`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = state.speakers[code];
    input.placeholder = `Speaker ${code}`;
    input.dataset.code = code;
    input.addEventListener('input', e => {
      const c = e.target.dataset.code;
      state.speakers[c] = e.target.value || `Speaker ${c}`;
      // Update all speaker labels in transcript
      document.querySelectorAll(`.utt-speaker[data-code="${c}"]`).forEach(el => {
        el.textContent = state.speakers[c];
      });
    });
    pair.appendChild(label);
    pair.appendChild(input);
    speakerRename.appendChild(pair);
  }
  speakerRename.hidden = false;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function buildMetaHeader(segmentCount, noteCount) {
  const fmtAbsolute = ts => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const providerName = providerSelect.value === 'whisper' ? 'OpenAI Whisper' : 'AssemblyAI';
  const langLabels = { fi: 'Finnish', en: 'English', '': 'Auto-detect' };
  const durationMs = (state.endTime || Date.now()) - (state.startTime || Date.now());

  const interviewee = intervieweeName.value.trim();
  const notes = sessionNotes.value.trim();

  return [
    ...(interviewee ? [`# interviewee: ${interviewee}`] : []),
    ...(notes       ? [`# session_notes: ${notes}`]     : []),
    `# provider: ${providerName}`,
    `# session_start: ${state.startTime ? fmtAbsolute(state.startTime) : 'unknown'}`,
    `# session_end: ${state.endTime ? fmtAbsolute(state.endTime) : 'unknown'}`,
    `# duration: ${fmtTime(durationMs)}`,
    `# language: ${langLabels[languageSelect.value] ?? languageSelect.value}`,
    `# segments: ${segmentCount}`,
    `# notes: ${noteCount}`,
    `#`,
  ];
}

function buildInterleaved() {
  const isWhisper = state.providerUsed === 'whisper';
  const tRows = (state.transcript || []).map(u => ({
    ms: u.start,
    type: 'transcript',
    start: fmtTime(u.start),
    end: fmtTime(u.end),
    speaker: isWhisper ? null : speakerLabel(u.speaker),
    text: u.text,
  }));

  const nRows = state.notes.map(n => ({
    ms: n.timestamp_ms,
    type: 'note',
    start: fmtTime(n.timestamp_ms),
    end: '',
    speaker: null,
    text: n.text,
  }));

  const all = [...tRows, ...nRows].sort((a, b) => a.ms - b.ms);
  const headers = isWhisper
    ? ['type', 'timestamp_start', 'timestamp_end', 'text']
    : ['type', 'timestamp_start', 'timestamp_end', 'speaker', 'text'];

  const rows = [
    ...buildMetaHeader(tRows.length, nRows.length),
    headers.join(','),
    ...all.map(r => isWhisper
      ? [r.type, r.start, r.end, csvCell(r.text)].join(',')
      : [r.type, r.start, r.end, r.speaker, csvCell(r.text)].join(',')),
  ];
  return rows.join('\r\n');
}

function buildTranscriptCSV() {
  const isWhisper = state.providerUsed === 'whisper';
  const segments = state.transcript || [];
  const headers = isWhisper
    ? ['timestamp_start', 'timestamp_end', 'text']
    : ['timestamp_start', 'timestamp_end', 'speaker', 'text'];
  const rows = [
    ...buildMetaHeader(segments.length, state.notes.length),
    headers.join(','),
    ...segments.map(u => isWhisper
      ? [fmtTime(u.start), fmtTime(u.end), csvCell(u.text)].join(',')
      : [fmtTime(u.start), fmtTime(u.end), speakerLabel(u.speaker), csvCell(u.text)].join(',')),
  ];
  return rows.join('\r\n');
}

function buildNotesCSV() {
  const rows = [
    ...buildMetaHeader(state.transcript?.length ?? 0, state.notes.length),
    ['timestamp', 'note'].join(','),
    ...state.notes.map(n => [fmtTime(n.timestamp_ms), csvCell(n.text)].join(',')),
  ];
  return rows.join('\r\n');
}

function csvCell(str) {
  return `"${str.replace(/"/g, '""')}"`;
}

function downloadFile(content, filename) {
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sessionStamp() {
  // Simple local time stamp without Date.now() ambiguity
  const d = new Date();
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${y}${mo}${day}-${h}${min}`;
}

// ---------------------------------------------------------------------------
// Audio download
// ---------------------------------------------------------------------------
function downloadAudio() {
  if (!state.audioChunks.length) return;
  const blob = new Blob(state.audioChunks, { type: state.mimeType || 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `interview-audio-${sessionStamp()}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', handleStop);
downloadAudioBtn.addEventListener('click', downloadAudio);

exportBtn.addEventListener('click', () => {
  downloadFile(buildInterleaved(), `interview-${sessionStamp()}.csv`);
});

exportSeparateBtn.addEventListener('click', () => {
  const stamp = sessionStamp();
  downloadFile(buildTranscriptCSV(), `interview-transcript-${stamp}.csv`);
  downloadFile(buildNotesCSV(), `interview-notes-${stamp}.csv`);
});

addNoteBtn.addEventListener('click', addNote);
noteInput.addEventListener('keydown', e => { if (e.key === 'Enter') addNote(); });

const FORMAT_HINTS = {
  assemblyai: 'MP3, MP4, M4A, WAV, FLAC, AAC, OGG, WEBM, WMA — no size limit',
  whisper:    'MP3, MP4, M4A, WAV, WEBM — max 25 MB',
};

function updateFormatHint() {
  formatHint.textContent = FORMAT_HINTS[providerSelect.value] || '';
}

// ---------------------------------------------------------------------------
// Mode switching (Record / Upload)
// ---------------------------------------------------------------------------

modeRecordBtn.addEventListener('click', () => {
  modeRecordBtn.classList.add('active');
  modeUploadBtn.classList.remove('active');
  recordSection.hidden = false;
  uploadSection.hidden = true;
  liveToggleGroup.hidden = providerSelect.value === 'whisper';
});

modeUploadBtn.addEventListener('click', () => {
  modeUploadBtn.classList.add('active');
  modeRecordBtn.classList.remove('active');
  uploadSection.hidden = false;
  recordSection.hidden = true;
  liveToggleGroup.hidden = true; // no live mode for file uploads
});

function handleFileSelected(file) {
  if (!file) return;
  fileName.textContent = file.name;
  transcribeFileBtn.disabled = false;
}

fileInput.addEventListener('change', () => handleFileSelected(fileInput.files[0]));

const uploadArea = $('uploadArea');
uploadArea.addEventListener('dragover', e => {
  e.preventDefault();
  uploadArea.classList.add('drag-over');
});
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelected(file);
  // store dropped file for transcription
  uploadArea._droppedFile = file;
});

transcribeFileBtn.addEventListener('click', async () => {
  const file = uploadArea._droppedFile || fileInput.files[0];
  if (!file) return;

  const provider = providerSelect.value;
  const key = getActiveKey();
  if (!key) {
    const label = provider === 'whisper' ? 'OpenAI' : 'AssemblyAI';
    setStatus(`Enter your ${label} API key first.`, 0);
    return;
  }

  // Reset transcript area for new upload session
  state.transcript = null;
  state.speakers = {};
  state.notes = [];
  state.liveSegments = [];
  state.startTime = Date.now();
  state.endTime = null;
  notesList.innerHTML = '';
  speakerRename.hidden = true;
  speakerRename.innerHTML = '';
  exportOptions.hidden = true;
  newSessionBtn2.hidden = true;
  transcriptContainer.innerHTML = '<p class="placeholder">Processing…</p>';

  transcribeFileBtn.disabled = true;

  const blob = file;

  if (provider === 'whisper') {
    await runWhisperTranscription(blob, key);
  } else {
    await runAssemblyAITranscription(blob, key);
  }

  state.endTime = Date.now();
  noteInput.disabled = false;
  addNoteBtn.disabled = false;
  transcribeFileBtn.disabled = false;
  newSessionBtn2.hidden = false;
});

cancelBtn.addEventListener('click', () => {
  if (state.abortController) state.abortController.abort();
});

newSessionBtn.addEventListener('click', resetSession);
newSessionBtn2.addEventListener('click', resetSession);

function resetSession() {
  state.audioChunks = [];
  state.notes = [];
  state.transcript = null;
  state.speakers = {};
  state.liveSegments = [];
  state.liveChunkIndex = 0;
  state.startTime = null;
  state.endTime = null;
  state.providerUsed = null;
  state.isRecording = false;

  timerEl.textContent = '00:00:00';
  transcriptContainer.innerHTML = '<p class="placeholder">Transcript appears here after processing.</p>';
  notesList.innerHTML = '';
  speakerRename.hidden = true;
  speakerRename.innerHTML = '';
  exportOptions.hidden = true;
  newSessionBtn.hidden = true;
  clearStatus();
  setViewportState(null);
  drawFlatLine();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  stopBtn.textContent = '■ Stop & Transcribe';
  downloadAudioBtn.disabled = true;
  noteInput.disabled = true;
  addNoteBtn.disabled = true;
  liveModeCheckbox.disabled = false;
  providerSelect.disabled = false;
  languageSelect.disabled = false;
  apiKeyField.disabled = false;
  audioSourceSelect.disabled = false;
  intervieweeName.disabled = false;
  sessionNotes.disabled = false;
  // Reset upload section
  fileInput.value = '';
  fileName.textContent = '';
  transcribeFileBtn.disabled = true;
  newSessionBtn2.hidden = true;
  uploadArea._droppedFile = null;
}

const KEY_LABELS       = { assemblyai: 'AssemblyAI API Key', whisper: 'OpenAI API Key' };
const KEY_PLACEHOLDERS = { assemblyai: 'Enter API key',      whisper: 'sk-...' };

function applyProviderUI(previousProvider) {
  if (previousProvider) keyStore[previousProvider] = apiKeyField.value;
  const p = providerSelect.value;
  keyLabel.textContent    = KEY_LABELS[p];
  apiKeyField.placeholder = KEY_PLACEHOLDERS[p];
  apiKeyField.value       = keyStore[p] || '';
  liveToggleGroup.hidden  = false;
  updateFormatHint();
}

providerSelect.addEventListener('change', function () {
  applyProviderUI(this._prev);
  this._prev = providerSelect.value;
});
providerSelect._prev = providerSelect.value;

applyProviderUI(null);

// ---------------------------------------------------------------------------
// Canvas resize
// ---------------------------------------------------------------------------
const ro = new ResizeObserver(resizeCanvas);
ro.observe(waveformCanvas);
resizeCanvas();

// ---------------------------------------------------------------------------
// Guard against accidental tab close during recording/processing
// ---------------------------------------------------------------------------
window.addEventListener('beforeunload', e => {
  if (state.isRecording || (state.audioChunks.length && !state.transcript)) {
    e.preventDefault();
    e.returnValue = 'Recording in progress — are you sure you want to leave?';
  }
});
