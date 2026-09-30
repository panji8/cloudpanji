
/**
 * PANJI CLOUD — Frontend
 * Version: 1.0 (MVP)
 *
 * Connect ke Apps Script backend.
 * Semua data dummy di UI diganti dengan data nyata dari Google Sheets.
 */

// ============================================================
// KONFIGURASI — GANTI 2 BARIS INI
// ============================================================
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbyAmkUIkOUdissmVir9QQSDn9YieodZDFBxpyvt5ltlM2BISdCRiLSAtWYGE_bOcjQp6Q/exec',
  API_KEY: 'panji_08956223213600801200', // ← ganti dengan value PANJI_API_KEY kamu
  UPLOAD_CONCURRENCY: 3,
  MAX_RETRY: 2,
  CHUNK_SIZE_MB: 40 // Telegram + Apps Script payload limit
};

// ============================================================
// STATE
// ============================================================
const STATE = {
  files: [],
  folders: [],
  health: null,
  currentFilter: 'all',
  currentSort: 'newest',
  currentScreen: 'home',
  uploadQueue: [],
  uploadSession: null,
  isUploading: false
};

// ============================================================
// API HELPER
// ============================================================
async function api(action, params = {}, method = 'GET') {
  try {
    let url, options;

    if (method === 'GET') {
      const qs = new URLSearchParams({ action, key: CONFIG.API_KEY, ...params });
      url = `${CONFIG.API_URL}?${qs.toString()}`;
      options = { method: 'GET' };
    } else {
      // POST pakai text/plain untuk avoid CORS preflight di Apps Script
      url = CONFIG.API_URL;
      options = {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, key: CONFIG.API_KEY, ...params })
      };
    }

    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.message || data.error || 'Unknown error');
    }
    return data;
  } catch (err) {
    console.error(`API ${action} failed:`, err);
    throw err;
  }
}

// ============================================================
// HEALTH — cek koneksi backend
// ============================================================
async function loadHealth() {
  try {
    const data = await api('backupHealth');
    STATE.health = data;

    // Update dashboard stats
    updateEl('stat-total', formatNumber(data.total || 0));
    updateEl('stat-verified', formatNumber(data.verified || 0));
    updateEl('stat-pending', formatNumber(data.pending || 0));
    updateEl('stat-failed', formatNumber(data.failed || 0));

    // Update health badge
    const healthDot = document.querySelector('.health .dot');
    const healthTitle = document.querySelector('.health .txt b');
    const healthSub = document.querySelector('.health .txt span');
    if (healthDot && healthTitle && healthSub) {
      if (data.failed > 0) {
        healthDot.style.background = 'var(--err, #f87171)';
        healthTitle.textContent = `${data.failed} file gagal`;
        healthSub.textContent = `${data.verified} verified · ${data.pending} pending`;
      } else if (data.pending > 0) {
        healthDot.style.background = 'var(--warn, #fbbf24)';
        healthTitle.textContent = `${data.pending} file pending`;
        healthSub.textContent = `${data.verified} verified`;
      } else {
        healthDot.style.background = 'var(--ok, #34d399)';
        healthTitle.textContent = 'All files verified';
        healthSub.textContent = `${data.verified} verified · 0 pending · 0 failed`;
      }
    }

    return data;
  } catch (err) {
    toast(`Gagal cek backup: ${err.message}`);
    throw err;
  }
}

// ============================================================
// FILES — load & render
// ============================================================
async function loadFiles() {
  try {
    const params = {
      sort: STATE.currentSort,
      limit: 200
    };
    if (STATE.currentFilter !== 'all') params.type = STATE.currentFilter;

    const data = await api('listFiles', params);
    STATE.files = data.files || [];
    renderFiles(STATE.files);
    return data;
  } catch (err) {
    toast(`Gagal load files: ${err.message}`);
    throw err;
  }
}

function renderFiles(files) {
  // Cari semua grid di halaman
  const grids = document.querySelectorAll('[data-files-grid]');
  if (!grids.length) return;

  if (!files.length) {
    grids.forEach(grid => {
      grid.innerHTML = `
        <div class="empty" style="grid-column:1/-1">
          <div class="e">📭</div>
          <p>Belum ada file. Coba upload foto pertama kamu.</p>
        </div>`;
    });
    return;
  }

  const html = files.map(file => {
    const isImage = file.file_type === 'photo';
    const isVideo = file.file_type === 'video';
    const link = file.telegram_link || '#';
    const icon = isVideo ? '🎬' : isImage ? '🖼️' : '📄';
    const fav = file.favorite ? '<span class="fav">⭐</span>' : '';
    const tag = file.filename
      ? `<span class="tag">${escapeHtml(truncate(file.filename, 12))}</span>`
      : '';

    return `
      <div class="tile ${isVideo ? 'video' : ''}"
           onclick="openDetail('${file.id}')">
        ${isImage && file.thumbnail_file_id
          ? `<img src="${getThumbUrl(file.thumbnail_file_id)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">`
          : icon}
        ${tag}
        ${fav}
      </div>`;
  }).join('');

  grids.forEach(grid => { grid.innerHTML = html; });
}

// ============================================================
// FOLDERS
// ============================================================
async function loadFolders() {
  try {
    const data = await api('getFolders');
    STATE.folders = data.folders || [];
    renderFolders();
    renderFolderSelect();
    return data;
  } catch (err) {
    console.error('loadFolders failed:', err);
  }
}

function renderFolders() {
  const container = document.querySelector('[data-folders-list]');
  if (!container) return;

  if (!STATE.folders.length) {
    container.innerHTML = '<div class="empty"><p>Belum ada folder.</p></div>';
    return;
  }

  container.innerHTML = STATE.folders.map(f => `
    <div class="folder-row" onclick="filterByFolder('${f.folder_id}')">
      <div class="fi">📁</div>
      <div class="fn">
        <b>${escapeHtml(f.folder_name)}</b>
        <span>${countFilesInFolder(f.folder_id)} files</span>
      </div>
      <div class="chev" style="color:var(--text-mute)">›</div>
    </div>
  `).join('');
}

function renderFolderSelect() {
  const select = document.querySelector('[data-folder-select]');
  if (!select) return;
  select.innerHTML = STATE.folders.map(f =>
    `<option value="${f.folder_id}">${escapeHtml(f.folder_name)}</option>`
  ).join('');
}

function countFilesInFolder(folderId) {
  return STATE.files.filter(f => f.folder_id === folderId).length;
}

function filterByFolder(folderId) {
  STATE.currentFilter = 'folder';
  STATE.currentFolderId = folderId;
  // reload dengan filter folder
  api('listFiles', { folder_id: folderId, limit: 200 })
    .then(data => renderFiles(data.files || []));
}

// ============================================================
// UPLOAD
// ============================================================
async function uploadFile(file, folderId = '', folderName = '') {
  // Baca file sebagai base64
  const base64 = await fileToBase64(file);

  const payload = {
    action: 'upload',
    file_base64: base64,
    filename: file.name,
    original_filename: file.name,
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
    folder_id: folderId,
    folder_name: folderName,
    file_date: file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString()
  };

  const data = await api('upload', payload, 'POST');
  return data.file;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

// ============================================================
// UPLOAD QUEUE — dengan concurrency + retry
// ============================================================
async function startUpload(files, folderId = '', folderName = '') {
  if (STATE.isUploading) {
    toast('Upload sedang berjalan');
    return;
  }

  STATE.isUploading = true;
  STATE.uploadQueue = Array.from(files).map(f => ({
    file: f,
    status: 'pending',
    progress: 0,
    retries: 0,
    error: null
  }));

  STATE.uploadSession = {
    id: 'session_' + Date.now(),
    total: STATE.uploadQueue.length,
    uploaded: 0,
    failed: 0,
    startedAt: new Date().toISOString()
  };

  renderUploadQueue();

  // Proses dengan concurrency terbatas
  const workers = Array(CONFIG.UPLOAD_CONCURRENCY).fill(null).map(() => worker(folderId, folderName));
  await Promise.all(workers);

  STATE.isUploading = false;
  const s = STATE.uploadSession;
  toast(`Upload selesai: ${s.uploaded}/${s.total} berhasil${s.failed ? `, ${s.failed} gagal` : ''}`);

  // Refresh library
  loadHealth();
  loadFiles();
}

async function worker(folderId, folderName) {
  while (true) {
    const item = STATE.uploadQueue.find(i => i.status === 'pending');
    if (!item) break;

    item.status = 'uploading';
    renderUploadQueue();

    try {
      await uploadFile(item.file, folderId, folderName);
      item.status = 'done';
      item.progress = 100;
      STATE.uploadSession.uploaded++;
    } catch (err) {
      if (item.retries < CONFIG.MAX_RETRY) {
        item.retries++;
        item.status = 'pending';
        await sleep(1000 * item.retries);
        continue;
      }
      item.status = 'failed';
      item.error = err.message;
      STATE.uploadSession.failed++;
    }
    renderUploadQueue();
  }
}

function renderUploadQueue() {
  const container = document.querySelector('[data-upload-queue]');
  if (!container || !STATE.uploadQueue.length) return;

  const total = STATE.uploadQueue.length;
  const done = STATE.uploadQueue.filter(i => i.status === 'done').length;
  const failed = STATE.uploadQueue.filter(i => i.status === 'failed').length;
  const uploading = STATE.uploadQueue.filter(i => i.status === 'uploading').length;
  const pct = Math.round((done / total) * 100);

  container.innerHTML = `
    <div class="queue">
      <div class="queue-head">
        <div class="label">Upload Session</div>
        <div class="count">${total} files</div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="queue-stats">
        <span class="q-ok">✓ <b>${done}</b> uploaded</span>
        <span class="q-run">⟳ <b>${uploading}</b> uploading</span>
        <span class="q-fail">⚠ <b>${failed}</b> failed</span>
      </div>
      <ul class="file-list">
        ${STATE.uploadQueue.slice(0, 10).map(item => renderQueueItem(item)).join('')}
      </ul>
    </div>
  `;
}

function renderQueueItem(item) {
  const statusClass = {
    pending: 'st-run',
    uploading: 'st-run',
    done: 'st-ok',
    failed: 'st-fail'
  }[item.status];

  const statusText = {
    pending: 'Pending',
    uploading: `${item.progress}%`,
    done: '✓ Uploaded',
    failed: '⚠ Failed'
  }[item.status];

  return `
    <li class="file-item">
      <div class="ic">${item.file.type.startsWith('video') ? '🎬' : '🖼️'}</div>
      <div class="info">
        <b>${escapeHtml(item.file.name)}</b>
      </div>
      <div class="status ${statusClass}">${statusText}</div>
    </li>
  `;
}

// ============================================================
// DETAIL SHEET
// ============================================================
async function openDetail(fileId) {
  const file = STATE.files.find(f => f.id === fileId);
  if (!file) return;

  const sheet = document.getElementById('sheet');
  if (!sheet) return;

  document.getElementById('sheetName').textContent = file.filename;
  document.getElementById('sheetSub').textContent =
    `${file.folder_name || 'Uncategorized'} · ${formatDate(file.upload_date)} · ${formatBytes(file.file_size)}`;

  const kvFolder = document.getElementById('kvFolder');
  const kvDate = document.getElementById('kvDate');
  const kvSize = document.getElementById('kvSize');
  const kvType = document.getElementById('kvType');

  if (kvFolder) kvFolder.textContent = file.folder_name || '—';
  if (kvDate) kvDate.textContent = formatDate(file.upload_date);
  if (kvSize) kvSize.textContent = formatBytes(file.file_size);
  if (kvType) kvType.textContent = file.file_type;

  // Preview: kalau image dan ada file_id, tampilkan via Telegram
  const preview = document.getElementById('sheetPreview');
  if (preview) {
    if (file.file_type === 'photo' && file.telegram_file_id) {
      preview.innerHTML = `<img src="${getThumbUrl(file.telegram_file_id)}" style="width:100%;height:100%;object-fit:cover;border-radius:16px" onerror="this.parentElement.textContent='🖼️'">`;
    } else if (file.file_type === 'video') {
      preview.textContent = '🎬';
    } else {
      preview.textContent = '📄';
    }
  }

  // Tombol Open → buka link Telegram
  const openBtn = document.querySelector('[data-action="open"]');
  if (openBtn) {
    openBtn.onclick = () => {
      if (file.telegram_link) {
        window.open(file.telegram_link, '_blank');
      } else {
        toast('Link Telegram tidak tersedia');
      }
    };
  }

  sheet.classList.add('show');
  document.getElementById('sheetBackdrop').classList.add('show');
}

function closeDetail() {
  document.getElementById('sheet').classList.remove('show');
  document.getElementById('sheetBackdrop').classList.remove('show');
}

// ============================================================
// FAVORITE
// ============================================================
async function toggleFavorite(fileId) {
  try {
    await api('favorite', { id: fileId }, 'POST');
    const file = STATE.files.find(f => f.id === fileId);
    if (file) file.favorite = !file.favorite;
    renderFiles(STATE.files);
    toast(file && file.favorite ? 'Ditambahkan ke favorit' : 'Dihapus dari favorit');
  } catch (err) {
    toast(`Gagal: ${err.message}`);
  }
}

// ============================================================
// UTILS
// ============================================================
function updateEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function formatNumber(n) {
  return new Intl.NumberFormat('id-ID').format(n);
}

function formatBytes(b) {
  if (!b) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getThumbUrl(fileId) {
  // Preview via Telegram direct file URL (limit 20MB)
  // Karena bot token tidak boleh di frontend, pakai cara lain:
  // Untuk MVP, kita tampilkan icon placeholder. V2 bisa pakai proxy.
  return ''; // sementara kosong
}

// ============================================================
// TOAST
// ============================================================
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) { console.log('[toast]', msg); return; }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ============================================================
// NAVIGATION
// ============================================================
function go(screen) {
  STATE.currentScreen = screen;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + screen);
  if (el) el.classList.add('active');

  document.querySelectorAll('.nav-item, .mnav, .side-link').forEach(n => n.classList.remove('active'));
  document.querySelectorAll(`[data-nav="${screen}"]`).forEach(n => n.classList.add('active'));

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Lazy load per screen
  if (screen === 'files' || screen === 'home') loadFiles();
  if (screen === 'folders') loadFolders();
  if (screen === 'backup' || screen === 'home') loadHealth();
}

// ============================================================
// INIT
// ============================================================
async function init() {
  console.log('Panji Cloud starting...');

  // Cek konfigurasi
  if (CONFIG.API_KEY === 'PANJI_API_KEY_KAMU') {
    toast('⚠ Set API_KEY di app.js dulu');
    console.warn('API_KEY belum diganti di CONFIG');
  }

  // Load awal
  try {
    await loadHealth();
  } catch (e) { /* sudah di-toast */ }

  try {
    await loadFiles();
  } catch (e) { /* sudah di-toast */ }

  try {
    await loadFolders();
  } catch (e) { /* sudah di-toast */ }

  // Bind upload dropzone
  const dz = document.getElementById('dropzone');
  if (dz) {
    ['dragenter', 'dragover'].forEach(ev => {
      dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); });
    });
    dz.addEventListener('drop', e => {
      const files = e.dataTransfer.files;
      if (files.length) handleFilesSelected(files);
    });
  }

  // File input
  const fileInput = document.querySelector('[data-file-input]');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      if (e.target.files.length) handleFilesSelected(e.target.files);
    });
  }

  console.log('Panji Cloud ready.');
}

function handleFilesSelected(files) {
  const folderSelect = document.querySelector('[data-folder-select]');
  const folderId = folderSelect ? folderSelect.value : '';
  const folderName = folderSelect ? folderSelect.options[folderSelect.selectedIndex]?.text : '';

  // Batas ukuran file
  const maxBytes = CONFIG.CHUNK_SIZE_MB * 1024 * 1024;
  const valid = Array.from(files).filter(f => {
    if (f.size > maxBytes) {
      toast(`⚠ ${f.name} terlalu besar (${formatBytes(f.size)}). Max ${CONFIG.CHUNK_SIZE_MB}MB`);
      return false;
    }
    return true;
  });

  if (!valid.length) return;
  startUpload(valid, folderId, folderName);
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
