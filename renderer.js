// ═══════════════════════════════════════════
// Snappy Drive — Renderer
// Sidebar: đích đến trên Drive (thư mục tháng, ngày chụp, tên khách) · Nội dung: kéo thả folder, lưới ảnh, tiến độ
// ═══════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ─── State ────────────────────────────────
let settings = {};
let selectedFolder = '';
let destNameTouched = false;
let dateTouched = false;
let pendingMonthId = '';
let isRunning = false;
let hasStopped = false;
let lastPhase = 'idle';
let lastConfig = null;
let currentHistoryId = null;
let driveLink = '';
let setupOk = false;
let fileList = [];
let fileFilter = 'all';
let viewerIndex = -1;
let viewerList = [];
const MAX_LOG_ENTRIES = 800;
const MAX_TILES = 1500;
const MAX_MONTHS = 8;

// ─── Helpers ──────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const basename = (p) => p.replace(/\/+$/, '').split('/').pop();
const joinPath = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;
const pad = (n) => String(n).padStart(2, '0');
const cleanSegment = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const driveUrl = (id) => `https://drive.google.com/drive/folders/${id}`;
const thumbUrl = (file, size = 256) => `snappy://thumb/?p=${encodeURIComponent(joinPath(selectedFolder, file.name))}&s=${size}&t=${file.mtimeMs || 0}`;
const photoUrl = (file) => `snappy://photo/?p=${encodeURIComponent(joinPath(selectedFolder, file.name))}&t=${file.mtimeMs || 0}`;

function stripLeadingDate(name) {
  return cleanSegment(String(name || '').replace(/^\s*\d{1,2}\s*[./\-_]\s*\d{1,2}(\s*[./\-_]\s*\d{2,4})?[\s\-_]+/, ''));
}
function todayIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseIso(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? { y: m[1], m: m[2], d: m[3] } : null; }
function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatClock(iso) { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function formatDate(iso) { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function formatEta(sec) {
  if (sec == null || !isFinite(sec)) return '';
  if (sec < 60) return `Còn khoảng ${Math.max(1, sec)} giây`;
  const m = Math.round(sec / 60);
  return m < 60 ? `Còn khoảng ${m} phút` : `Còn khoảng ${Math.floor(m / 60)} giờ ${m % 60} phút`;
}
function saveSettings(patch) { Object.assign(settings, patch); window.api.saveSettings(patch); }

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ═══════════════════════════════════════════
// Kết nối Google Drive (sheet)
// ═══════════════════════════════════════════
const setupModal = $('#setup-modal');
const checkInstalled = $('#check-installed');
const checkRemote = $('#check-remote');
const checkConnection = $('#check-connection');
const btnInstallHelp = $('#btn-install-help');
const btnCreateRemote = $('#btn-create-remote');
const btnReconnect = $('#btn-reconnect');
const btnReconfigure = $('#btn-reconfigure');
const btnRecheck = $('#btn-recheck');
const btnContinue = $('#btn-continue');
const configOutputPanel = $('#config-output-panel');
const configOutput = $('#config-output');
const installInstructions = $('#install-instructions');

const openSetup = () => setupModal.classList.remove('hidden');
const closeSetup = () => setupModal.classList.add('hidden');

function setCheckState(el, state, detail) {
  const icons = {
    loading: '<span class="spinner"></span>',
    pass: '<span class="check-pass">✓</span>',
    fail: '<span class="check-fail">✕</span>',
    pending: '<span class="check-pending">○</span>',
  };
  el.querySelector('.check-icon').innerHTML = icons[state] || icons.pending;
  if (detail) el.querySelector('.check-detail').textContent = detail;
}

function setSetupOk(ok, message) {
  setupOk = ok;
  $('#setup-alert').classList.toggle('hidden', ok);
  if (!ok) $('#setup-alert-text').textContent = message || 'Chưa kết nối Google Drive';
  refresh();
}

async function runSetupChecks({ openOnFail = false } = {}) {
  btnRecheck.disabled = true;
  btnContinue.disabled = true;
  installInstructions.classList.add('hidden');
  for (const b of [btnInstallHelp, btnCreateRemote, btnReconnect, btnReconfigure]) b.classList.add('hidden');
  setCheckState(checkInstalled, 'loading', 'Đang kiểm tra...');
  setCheckState(checkRemote, 'pending', 'Chờ...');
  setCheckState(checkConnection, 'pending', 'Chờ...');

  const r = await window.api.checkRcloneFull();
  const fail = (msg) => { btnRecheck.disabled = false; setSetupOk(false, msg); if (openOnFail) openSetup(); };

  if (!r.installed) {
    setCheckState(checkInstalled, 'fail', 'Chưa cài đặt');
    btnInstallHelp.classList.remove('hidden');
    installInstructions.classList.remove('hidden');
    return fail('Chưa cài rclone');
  }
  setCheckState(checkInstalled, 'pass', `Phiên bản ${r.version}`);
  if (!r.remoteExists) {
    setCheckState(checkRemote, 'fail', 'Chưa kết nối tài khoản');
    btnCreateRemote.classList.remove('hidden');
    return fail('Chưa kết nối tài khoản Google');
  }
  setCheckState(checkRemote, 'pass', 'Đã kết nối');
  if (!r.connectionOk) {
    setCheckState(checkConnection, 'fail', r.errorDetail || 'Kết nối thất bại');
    btnReconnect.classList.remove('hidden');
    return fail('Mất kết nối Google Drive');
  }
  setCheckState(checkConnection, 'pass', 'Hoạt động tốt');
  btnContinue.disabled = false;
  btnRecheck.disabled = false;
  btnReconfigure.classList.remove('hidden');
  setSetupOk(true);
}

function appendConfigOutput(text) { configOutput.textContent += text; configOutput.scrollTop = configOutput.scrollHeight; }
window.api.onConfigOutput(appendConfigOutput);

async function runSetupAction(btn, busyLabel, intro, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner light"></span> ${busyLabel}`;
  configOutput.textContent = intro;
  configOutputPanel.classList.remove('hidden');
  const result = await fn();
  appendConfigOutput(result.success ? '\n✓ ' + result.message : '\n✕ ' + result.message);
  btn.disabled = false;
  btn.innerHTML = label;
  if (result.success) { await sleep(800); runSetupChecks(); }
}
btnCreateRemote.addEventListener('click', () => runSetupAction(btnCreateRemote, 'Đang mở...', 'Trình duyệt sẽ mở để đăng nhập Google...\n', window.api.createDriveRemote));
btnReconnect.addEventListener('click', () => runSetupAction(btnReconnect, 'Đang mở...', 'Trình duyệt sẽ mở để đăng nhập lại Google...\n', window.api.reconnectDriveRemote));
btnReconfigure.addEventListener('click', () => runSetupAction(btnReconfigure, 'Đang mở...', 'Đang xoá cấu hình cũ, trình duyệt sẽ mở để đăng nhập tài khoản mới...\n', window.api.reconfigureDriveRemote));
btnInstallHelp.addEventListener('click', () => installInstructions.classList.toggle('hidden'));
$('#link-rclone').addEventListener('click', (e) => { e.preventDefault(); window.api.openUrl('https://rclone.org/downloads/'); });
btnRecheck.addEventListener('click', () => runSetupChecks());
btnContinue.addEventListener('click', closeSetup);
$('#btn-close-setup').addEventListener('click', closeSetup);
$('#btn-settings').addEventListener('click', openSetup);
$('#btn-open-setup').addEventListener('click', openSetup);
setupModal.addEventListener('click', (e) => { if (e.target === setupModal) closeSetup(); });

// ═══════════════════════════════════════════
// Folder ảnh (kéo thả / chọn)
// ═══════════════════════════════════════════
const dropHero = $('#drop-hero');
const workspace = $('#workspace');
const dragOverlay = $('#drag-overlay');

async function setFolder(folderPath, { quiet = false } = {}) {
  if (!folderPath || isRunning) return false;
  if (!(await window.api.validateFolder(folderPath))) {
    if (!quiet) toast('Hãy chọn một folder, không phải file');
    return false;
  }
  const isNew = folderPath !== selectedFolder;
  selectedFolder = folderPath;
  hasStopped = false;
  dropHero.classList.add('hidden');
  workspace.classList.remove('hidden');
  $('#folder-name').textContent = basename(folderPath);
  $('#folder-name').title = folderPath;
  if (isNew) { destNameTouched = false; dateTouched = false; tileMap.clear(); $('#file-grid').innerHTML = ''; }
  if (!destNameTouched) destNameInput.value = stripLeadingDate(basename(folderPath));
  saveSettings({ lastFolder: folderPath });
  await refreshFolderInfo();
  if (!dateTouched) await loadShootDate();
  refresh();
  return true;
}

function clearFolder() {
  selectedFolder = '';
  destNameTouched = false;
  dateTouched = false;
  destNameInput.value = '';
  shootDateInput.value = '';
  shootDateHint.textContent = '';
  expectedTotalInput.value = '';
  tileMap.clear();
  $('#file-grid').innerHTML = '';
  fileList = [];
  workspace.classList.add('hidden');
  dropHero.classList.remove('hidden');
  saveSettings({ lastFolder: null });
  refresh();
}

async function chooseFolder() {
  if (isRunning) return;
  const folder = await window.api.selectFolder();
  if (folder) setFolder(folder);
}

// Khi chưa chạy: đọc danh sách ảnh + trạng thái từ log của folder
async function refreshFolderInfo() {
  if (!selectedFolder || isRunning || hasStopped) return;
  const list = await window.api.listFolder(selectedFolder, getStartFromName());
  renderFiles(list);
  const done = list.filter((f) => f.status === 'done').length;
  $('#folder-meta').textContent = list.length === 0
    ? 'Folder đang trống — ảnh export vào sẽ tự hiện ở đây'
    : done ? `${list.length} ảnh · ${done} đã có trên Drive` : `${list.length} ảnh · chưa upload`;
  renderIdleProgress(done, list.length);
}
setInterval(() => { if (!document.hidden) refreshFolderInfo(); }, 4000);

dropHero.addEventListener('click', chooseFolder);
dropHero.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseFolder(); } });
$('#btn-choose-folder').addEventListener('click', (e) => { e.stopPropagation(); chooseFolder(); });
$('#btn-change-folder').addEventListener('click', chooseFolder);

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (isRunning) return;
  dragDepth++;
  if (workspace.classList.contains('hidden')) dropHero.classList.add('dragover');
  else dragOverlay.classList.remove('hidden');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropHero.classList.remove('dragover'); dragOverlay.classList.add('hidden'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropHero.classList.remove('dragover');
  dragOverlay.classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (file && !isRunning) setFolder(window.api.getPathForFile(file));
});

// ═══════════════════════════════════════════
// Đích đến: thư mục tháng + ngày chụp + tên khách
// ═══════════════════════════════════════════
const monthSelect = $('#month-select');
const monthLinkInput = $('#month-link');
const monthNameInput = $('#month-name');
const monthStatus = $('#month-status');
const btnSaveMonth = $('#btn-save-month');
const shootDateInput = $('#shoot-date');
const shootDateHint = $('#shoot-date-hint');
const destNameInput = $('#dest-name');
const expectedTotalInput = $('#expected-total');

const months = () => settings.monthFolders || [];
const currentMonth = () => months().find((m) => m.id === settings.currentMonthId) || null;

function renderMonths({ adding = false } = {}) {
  const list = months();
  const showAdd = adding || list.length === 0;
  $('#month-pick').classList.toggle('hidden', showAdd);
  $('#month-add').classList.toggle('hidden', !showAdd);
  $('#btn-cancel-month').classList.toggle('hidden', list.length === 0);
  $('#month-actions').classList.toggle('hidden', showAdd || !list.length);
  monthSelect.innerHTML = list.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
  if (settings.currentMonthId) monthSelect.value = settings.currentMonthId;
  refresh();
}

function suggestMonthName() {
  const p = parseIso(shootDateInput.value) || parseIso(todayIso());
  return `T${Number(p.m)}/${p.y}`;
}

let monthTimer = null;
let monthSeq = 0;
monthLinkInput.addEventListener('input', () => {
  pendingMonthId = '';
  btnSaveMonth.disabled = true;
  clearTimeout(monthTimer);
  const url = monthLinkInput.value.trim();
  if (!url) { monthStatus.innerHTML = ''; return; }
  monthTimer = setTimeout(async () => {
    const seq = ++monthSeq;
    const id = await window.api.validateDriveLink(url);
    if (seq !== monthSeq) return;
    if (!id) { monthStatus.innerHTML = '<span class="bad">Link không hợp lệ — copy link thư mục từ Google Drive</span>'; return; }
    monthStatus.innerHTML = '<span class="wait">Đang kiểm tra quyền truy cập…</span>';
    const r = await window.api.checkFolderAccess(id);
    if (seq !== monthSeq) return;
    if (!r.hasAccess) { monthStatus.innerHTML = `<span class="bad">${escapeHtml(r.error)}</span>`; return; }
    pendingMonthId = id;
    if (!monthNameInput.value.trim()) monthNameInput.value = suggestMonthName();
    monthStatus.innerHTML = '<span class="ok">Có quyền truy cập · đặt tên rồi bấm Lưu</span>';
    btnSaveMonth.disabled = false;
    monthNameInput.focus();
    monthNameInput.select();
  }, 450);
});

function saveMonth() {
  if (!pendingMonthId) return;
  const name = cleanSegment(monthNameInput.value) || suggestMonthName();
  const list = [{ id: pendingMonthId, name }, ...months().filter((m) => m.id !== pendingMonthId)].slice(0, MAX_MONTHS);
  saveSettings({ monthFolders: list, currentMonthId: pendingMonthId });
  pendingMonthId = '';
  monthLinkInput.value = '';
  monthNameInput.value = '';
  monthStatus.innerHTML = '';
  btnSaveMonth.disabled = true;
  renderMonths();
  toast(`Đã lưu thư mục ${name}`);
}
btnSaveMonth.addEventListener('click', saveMonth);
monthNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveMonth(); });
$('#btn-month-menu').addEventListener('click', () => { renderMonths({ adding: true }); monthLinkInput.focus(); });
$('#btn-cancel-month').addEventListener('click', () => { monthLinkInput.value = ''; monthStatus.innerHTML = ''; renderMonths(); });
$('#btn-open-month').addEventListener('click', () => { const m = currentMonth(); if (m) window.api.openUrl(driveUrl(m.id)); });
monthSelect.addEventListener('change', () => { saveSettings({ currentMonthId: monthSelect.value }); refresh(); });

async function loadShootDate() {
  if (!selectedFolder) return;
  shootDateHint.textContent = 'Đang đọc ngày chụp…';
  const r = await window.api.readShootDate(selectedFolder);
  if (dateTouched) return;
  if (r.date) {
    shootDateInput.value = r.date;
    shootDateHint.textContent = 'Ngày chụp lấy từ thông tin ảnh (EXIF).';
  } else {
    shootDateInput.value = todayIso();
    shootDateHint.textContent = r.images ? 'Ảnh không có ngày chụp — đang dùng hôm nay.' : 'Folder chưa có ảnh — đang dùng hôm nay.';
  }
  refresh();
}
shootDateInput.addEventListener('input', () => { dateTouched = true; shootDateHint.textContent = ''; refresh(); });
destNameInput.addEventListener('input', () => { destNameTouched = true; refresh(); });

function clientFolderName() {
  const p = parseIso(shootDateInput.value);
  const name = cleanSegment(destNameInput.value);
  return p && name ? `${p.d}/${p.m} ${name}` : null;
}

function monthMismatch() {
  const m = currentMonth();
  const p = parseIso(shootDateInput.value);
  if (!m || !p || directModeCheckbox.checked) return null;
  const mm = /T\s*(\d{1,2})\b/i.exec(m.name);
  if (!mm || Number(mm[1]) === Number(p.m)) return null;
  const better = months().find((x) => {
    const t = /T\s*(\d{1,2})\b/i.exec(x.name);
    const y = /(20\d{2})/.exec(x.name);
    return t && Number(t[1]) === Number(p.m) && (!y || y[1] === p.y);
  });
  return { shootMonth: Number(p.m), better };
}

function renderMonthWarning() {
  const box = $('#month-warning');
  const w = monthMismatch();
  if (!w) { box.classList.add('hidden'); return; }
  box.innerHTML = `Ảnh chụp tháng ${w.shootMonth} nhưng đang chọn <b>${escapeHtml(currentMonth().name)}</b>. `
    + (w.better ? `<button class="link-btn" id="btn-switch-month">Chuyển sang ${escapeHtml(w.better.name)}</button>` : 'Bấm “Thêm” để lưu thư mục tháng đúng.');
  box.classList.remove('hidden');
  const sw = $('#btn-switch-month');
  if (sw) sw.addEventListener('click', () => { saveSettings({ currentMonthId: w.better.id }); renderMonths(); });
}

function renderPathPreview() {
  const el = $('#path-preview');
  const m = currentMonth();
  if (!m) { el.classList.add('hidden'); return; }
  if (directModeCheckbox.checked) {
    el.innerHTML = `Upload thẳng vào <b>${escapeHtml(m.name)}</b>`;
  } else {
    const client = clientFolderName();
    if (!client) { el.classList.add('hidden'); return; }
    el.innerHTML = `${escapeHtml(m.name)}<span class="sep">›</span><b>${escapeHtml(client)}</b>`;
  }
  el.classList.remove('hidden');
}

// ═══════════════════════════════════════════
// Tuỳ chọn
// ═══════════════════════════════════════════
const directModeCheckbox = $('#direct-mode');
const autoSleepCheckbox = $('#auto-sleep');
const sleepMinutesSelect = $('#sleep-minutes');
const startFromCheckbox = $('#start-from-file-checkbox');
const startFromInput = $('#start-from-file-input');
const overwriteCheckbox = $('#overwrite');

const getStartFromName = () => (startFromCheckbox.checked ? startFromInput.value.trim() : '');
function readOptions() {
  return {
    directMode: directModeCheckbox.checked,
    autoSleep: autoSleepCheckbox.checked,
    sleepMinutes: parseInt(sleepMinutesSelect.value, 10),
    overwrite: overwriteCheckbox.checked,
  };
}
function applyOptions(o = {}) {
  if ('directMode' in o) directModeCheckbox.checked = !!o.directMode;
  if ('autoSleep' in o) autoSleepCheckbox.checked = !!o.autoSleep;
  if (o.sleepMinutes) sleepMinutesSelect.value = String(o.sleepMinutes);
  if ('overwrite' in o) overwriteCheckbox.checked = !!o.overwrite;
}
for (const el of [directModeCheckbox, autoSleepCheckbox, sleepMinutesSelect, overwriteCheckbox]) {
  el.addEventListener('change', () => { saveSettings({ options: readOptions() }); refresh(); });
}
let startFromTimer = null;
startFromCheckbox.addEventListener('change', refreshFolderInfo);
startFromInput.addEventListener('input', () => {
  startFromCheckbox.checked = !!startFromInput.value.trim();
  clearTimeout(startFromTimer);
  startFromTimer = setTimeout(refreshFolderInfo, 400);
});

// ═══════════════════════════════════════════
// Nút Bắt đầu
// ═══════════════════════════════════════════
const btnStart = $('#btn-start');
const startHint = $('#start-hint');

const destReady = () => !!currentMonth() && (directModeCheckbox.checked || !!clientFolderName());

function missingReason() {
  if (!setupOk) return 'Cần kết nối Google Drive (biểu tượng ⚙ góc trên)';
  if (!selectedFolder) return 'Kéo thả hoặc chọn folder ảnh';
  if (!currentMonth()) return 'Dán link thư mục tháng trên Drive';
  if (!directModeCheckbox.checked && !parseIso(shootDateInput.value)) return 'Chọn ngày chụp';
  if (!directModeCheckbox.checked && !cleanSegment(destNameInput.value)) return 'Nhập tên khách';
  return '';
}

function refresh() {
  $('#client-group').classList.toggle('hidden', directModeCheckbox.checked);
  renderMonthWarning();
  renderPathPreview();
  if (isRunning) return;
  const reason = missingReason();
  btnStart.disabled = !!reason;
  startHint.textContent = reason;
}

// ═══════════════════════════════════════════
// Chạy / điều khiển
// ═══════════════════════════════════════════
const btnPause = $('#btn-pause');
const btnCheck = $('#btn-check');
const btnStop = $('#btn-stop');

async function startWith(config) {
  $('#log-container').innerHTML = '';
  renderDone(null);
  const result = await window.api.startMonitoring(config);
  if (!result.success) { startHint.innerHTML = `<span class="bad">${escapeHtml(result.message)}</span>`; return false; }
  lastConfig = config;
  currentHistoryId = result.historyId;
  hasStopped = false;
  setRunningState(true);
  switchTab('files');
  return true;
}

btnStart.addEventListener('click', async () => {
  const month = currentMonth();
  if (!month || !selectedFolder) return;
  btnStart.disabled = true;
  let folderId = month.id;
  let driveName = month.name;
  let linkParentId = null;
  let linkName = null;

  if (!directModeCheckbox.checked) {
    const client = clientFolderName();
    btnStart.innerHTML = '<span class="spinner light"></span>&nbsp; Đang chuẩn bị thư mục…';
    const r = await window.api.resolveDriveTarget(month.id, [client]);
    btnStart.textContent = 'Bắt đầu upload';
    if (!r.success) { startHint.innerHTML = `<span class="bad">${escapeHtml(r.message)}</span>`; btnStart.disabled = false; return; }
    folderId = r.folderId;
    driveName = `${month.name} › ${client}`;
    linkParentId = month.id;
    linkName = client;
    if (r.created) toast(`Đã tạo thư mục “${client}” trên Drive`);
  }

  saveSettings({ options: readOptions() });
  const ok = await startWith({
    folderPath: selectedFolder,
    folderId,
    driveName,
    linkParentId,
    linkName,
    startFromName: getStartFromName(),
    expectedTotal: parseInt(expectedTotalInput.value, 10) || 0,
    ...readOptions(),
  });
  if (!ok) btnStart.disabled = false;
});

btnPause.addEventListener('click', () => (lastPhase === 'paused' ? window.api.resumeUpload() : window.api.pauseUpload()));
btnCheck.addEventListener('click', () => { window.api.uploadNow(); toast('Đang thử lại và đối chiếu với Drive'); });
btnStop.addEventListener('click', () => (lastPhase === 'stopping' ? window.api.cancelUpload() : window.api.stopMonitoring()));

$('#btn-new-session').addEventListener('click', () => {
  hasStopped = false;
  currentHistoryId = null;
  startFromCheckbox.checked = false;
  startFromInput.value = '';
  renderDone(null);
  setRunningState(false);
  clearFolder();
});
$('#btn-resume-session').addEventListener('click', () => { if (lastConfig) startWith(lastConfig); });
$('#btn-open-local').addEventListener('click', () => { if (lastConfig) window.api.openFolder(lastConfig.folderPath); });
$('#btn-open-drive-side').addEventListener('click', () => { if (driveLink) window.api.openUrl(driveLink); });

function renderRunSummary(config) {
  if (!config) return;
  $('#sum-folder').textContent = basename(config.folderPath);
  $('#sum-folder').title = config.folderPath;
  $('#sum-drive').textContent = config.driveName || 'Thư mục Drive';
  $('#sum-drive').title = config.driveName || '';
  const tags = [];
  if (config.expectedTotal) tags.push(`Dự kiến ${config.expectedTotal} ảnh`);
  if (config.autoSleep) tags.push(`Sleep sau ${config.sleepMinutes} phút`);
  if (config.startFromName) tags.push(`Từ ${config.startFromName}`);
  if (config.overwrite) tags.push('Đè file trùng tên');
  $('#sum-options').innerHTML = tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
}

function setRunningState(running) {
  isRunning = running;
  const showSummary = running || hasStopped;
  $('#form-view').classList.toggle('hidden', showSummary);
  $('#run-view').classList.toggle('hidden', !showSummary);
  $('#idle-actions').classList.toggle('hidden', showSummary);
  $('#running-actions').classList.toggle('hidden', !running);
  $('#after-actions').classList.toggle('hidden', running || !hasStopped);
  $('#btn-change-folder').classList.toggle('hidden', showSummary);
  $('#run-tip').classList.toggle('hidden', !running);
  if (showSummary) renderRunSummary(lastConfig);
  if (!running) {
    lastPhase = hasStopped ? 'stopped' : 'idle';
    setPhase(lastPhase);
    $('#hero-eta').textContent = '';
    if (hasStopped && driveLink) $('#done-actions').classList.remove('hidden');
    if (!hasStopped) refreshFolderInfo();
    refresh();
  }
}

// ═══════════════════════════════════════════
// Tiến độ
// ═══════════════════════════════════════════
const PHASE = {
  idle: { pill: 'Sẵn sàng', label: 'Chưa upload' },
  waiting: { pill: 'Chờ ảnh mới', label: 'Đang chờ ảnh mới', sub: 'Đang chờ Lightroom export thêm ảnh' },
  uploading: { pill: 'Đang upload', label: 'Đang upload', sub: 'Đang tải ảnh lên Google Drive' },
  verifying: { pill: 'Đang kiểm tra', label: 'Đang đối chiếu', sub: 'Không còn ảnh mới — đang kiểm tra lại với Drive' },
  paused: { pill: 'Tạm dừng', label: 'Tạm dừng', sub: 'Bấm “Tiếp tục” để upload tiếp' },
  done: { pill: 'Hoàn tất', label: 'Hoàn tất', sub: 'Tất cả ảnh đã có trên Drive' },
  stopping: { pill: 'Đang dừng', label: 'Đang dừng', sub: 'Chờ ảnh đang upload chạy xong' },
  stopped: { pill: 'Đã dừng', label: 'Đã dừng', sub: 'Đã dừng theo dõi folder' },
};

function setPhase(phase) {
  const p = PHASE[phase] || PHASE.idle;
  $('#status-pill').className = `status ${phase}`;
  $('#status-text').textContent = p.pill;
  $('#hero').dataset.phase = phase;
  $('#hero-label').textContent = p.label;
}

function setProgress(done, target) {
  $('#hero-done').textContent = done;
  $('#hero-target').textContent = target;
  const pct = target ? Math.min(100, Math.round((done / target) * 100)) : 0;
  $('#progress-fill').style.width = `${pct}%`;
  $('#hero-pct').textContent = `${pct}%`;
}

function renderIdleProgress(done, total) {
  if (isRunning || hasStopped) return;
  setPhase('idle');
  $('#hero-label').textContent = total && done === total ? 'Đã có trên Drive' : done ? 'Đã upload một phần' : 'Chưa upload';
  setProgress(done, total);
  $('#chips').innerHTML = '';
  $('#done-actions').classList.add('hidden');
  $('#hero-sub').textContent = total === 0
    ? 'Có thể bấm Bắt đầu trước — ảnh export ra sẽ tự upload'
    : done === total ? 'Tất cả ảnh hiện có đã lên Drive' : `${total - done} ảnh chưa upload`;
}

function renderStats(s) {
  driveLink = s.link || driveLink;
  if (!isRunning) return;
  lastPhase = s.phase;
  setPhase(s.phase);
  setProgress(s.cumulativeUploaded, s.target || s.total);
  $('#folder-meta').textContent = `${s.total} ảnh · ${s.cumulativeUploaded} đã có trên Drive`;

  let sub = (PHASE[s.phase] || {}).sub || '';
  if (s.phase === 'waiting' && s.total === 0) sub = 'Chờ ảnh đầu tiên từ Lightroom…';
  if (s.phase === 'done' && s.expected > s.total) sub = `Đã lên đủ ${s.total} ảnh hiện có (dự kiến ${s.expected})`;
  if (s.sessionUploaded) sub += ` · lần này ${s.sessionUploaded} ảnh`;
  $('#hero-sub').textContent = sub;
  $('#hero-eta').textContent = s.phase === 'uploading' ? formatEta(s.etaSec) : '';

  const chips = [];
  if (s.active.length) chips.push(['', `${s.active.length} đang tải lên`]);
  if (s.queued) chips.push(['', `${s.queued} đang chờ`]);
  if (s.waitingExport) chips.push(['', `${s.waitingExport} đang export`]);
  if (s.retrying) chips.push(['warn', `${s.retrying} chờ thử lại`]);
  if (s.failed) chips.push(['bad', `${s.failed} lỗi`]);
  if (s.conflicts) chips.push(['warn', `${s.conflicts} trùng tên`]);
  $('#chips').innerHTML = chips.map(([c, t]) => `<span class="chip ${c}">${escapeHtml(t)}</span>`).join('');

  btnPause.textContent = s.phase === 'paused' ? 'Tiếp tục' : 'Tạm dừng';
  btnPause.disabled = s.phase === 'stopping';
  btnCheck.disabled = s.phase === 'stopping';
  btnStop.textContent = s.phase === 'stopping' ? 'Huỷ ngay' : s.phase === 'done' ? 'Kết thúc' : 'Dừng';
  btnStop.className = `btn btn-large ${s.phase === 'done' ? 'btn-blue' : 'btn-quiet-red'}`;
}

function renderDone(summary) {
  $('#done-actions').classList.toggle('hidden', !summary);
  if (summary) driveLink = summary.link;
}

// Copy link xem công khai cho khách
async function copyPublicLink(historyId, btn) {
  if (!historyId) return;
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = btn.classList.contains('btn-blue') ? '<span class="spinner light"></span>&nbsp; Đang tạo link…' : 'Đang tạo…'; }
  const r = await window.api.publicLink(historyId);
  if (btn) { btn.disabled = false; btn.innerHTML = label; }
  if (!r.success) { if (!r.cancelled) toast(r.message, 4500); return; }
  await window.api.copyText(r.url);
  toast(r.cached ? 'Đã copy link cho khách' : 'Đã bật “Ai có link đều xem được” và copy link');
}
$('#btn-copy-link').addEventListener('click', (e) => copyPublicLink(currentHistoryId, e.currentTarget));
$('#btn-open-drive').addEventListener('click', () => { if (driveLink) window.api.openUrl(driveLink); });

// ═══════════════════════════════════════════
// Lưới ảnh (cập nhật theo từng ô để thumbnail không nháy)
// ═══════════════════════════════════════════
const tileMap = new Map(); // name -> { el, status, mtimeMs }
const STATUS_TEXT = {
  done: '', pending: 'Chưa upload', queued: 'Đang chờ', exporting: 'Đang export', uploading: 'Đang tải lên',
  retry: 'Chờ thử lại', failed: 'Lỗi', conflict: 'Trùng tên trên Drive',
};
const STATUS_BADGE = { done: '✓', uploading: '↑', retry: '↻', failed: '!', conflict: '!', pending: '', queued: '', exporting: '…' };
const FILTERS = {
  all: () => true,
  pending: (f) => f.status !== 'done',
  error: (f) => ['failed', 'conflict', 'retry'].includes(f.status),
};

function createTile(f) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.tabIndex = 0;
  el.dataset.name = f.name;
  el.innerHTML = '<div class="thumb"><img loading="lazy" decoding="async" alt=""><span class="badge"></span></div><div class="tile-name"></div><div class="tile-sub"></div><div class="tile-size"></div>';
  const img = el.querySelector('img');
  img.addEventListener('error', () => {
    const ext = (f.name.split('.').pop() || '').slice(0, 4);
    img.replaceWith(Object.assign(document.createElement('span'), { className: 'ph', textContent: ext }));
  });
  el.querySelector('.tile-name').textContent = f.name;
  el.title = f.name;
  return el;
}

function updateTile(t, f) {
  if (t.size !== f.size) { t.el.querySelector('.tile-size').textContent = formatSize(f.size); t.size = f.size; }
  if (t.mtimeMs !== f.mtimeMs && f.status !== 'exporting') {
    const img = t.el.querySelector('img');
    if (img) img.src = thumbUrl(f);
    t.mtimeMs = f.mtimeMs;
  }
  if (t.status !== f.status || t.at !== f.at) {
    t.el.className = `tile s-${f.status}`;
    const badge = t.el.querySelector('.badge');
    badge.textContent = STATUS_BADGE[f.status] || '';
    badge.style.display = badge.textContent ? '' : 'none';
    t.el.querySelector('.tile-sub').textContent = f.status === 'done' ? (f.at ? `Lên Drive ${formatClock(f.at)}` : 'Đã có trên Drive') : STATUS_TEXT[f.status] || '';
    t.status = f.status;
    t.at = f.at;
  }
}

function renderFiles(list) {
  if (list) fileList = list;
  const grid = $('#file-grid');
  const empty = $('#files-empty');
  const done = fileList.filter((f) => f.status === 'done').length;
  $('#files-count').textContent = fileList.length ? `${done}/${fileList.length}` : '';

  const shown = fileList.filter(FILTERS[fileFilter]).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, MAX_TILES);
  $('#list-head').classList.toggle('hidden', viewMode !== 'list' || !shown.length);
  if (!shown.length) {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.innerHTML = !fileList.length
      ? (isRunning ? '<b>Chờ ảnh đầu tiên</b>Ảnh Lightroom export vào folder sẽ hiện ở đây.' : '<b>Folder chưa có ảnh</b>Có thể bấm Bắt đầu trước — ảnh export ra sẽ tự upload.')
      : fileFilter === 'error' ? '<b>Không có ảnh lỗi</b>' : '<b>Tất cả ảnh đã lên Drive</b>';
    return;
  }
  grid.classList.remove('hidden');
  empty.classList.add('hidden');

  const keep = new Set(shown.map((f) => f.name));
  for (const [name, t] of tileMap) if (!keep.has(name)) { t.el.remove(); tileMap.delete(name); }
  let prev = null;
  for (const f of shown) {
    let t = tileMap.get(f.name);
    if (!t) { t = { el: createTile(f), status: null, mtimeMs: null }; tileMap.set(f.name, t); }
    updateTile(t, f);
    const expectedPos = prev ? prev.nextSibling : grid.firstChild;
    if (expectedPos !== t.el) grid.insertBefore(t.el, expectedPos);
    prev = t.el;
  }
  viewerList = shown;
}

// ─── Lưới / Danh sách ─────────────────────
let viewMode = 'list';
function setViewMode(mode, { persist = true } = {}) {
  viewMode = mode === 'grid' ? 'grid' : 'list'; // mặc định: danh sách
  $('#file-grid').classList.toggle('list', viewMode === 'list');
  $$('#view-toggle .seg').forEach((b) => b.classList.toggle('active', b.dataset.view === viewMode));
  $('#list-head').classList.toggle('hidden', viewMode !== 'list' || $('#file-grid').classList.contains('hidden'));
  if (persist) saveSettings({ viewMode });
}
$$('#view-toggle .seg').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.view)));

$('#file-grid').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (tile) openViewer(tile.dataset.name);
});
$('#file-grid').addEventListener('keydown', (e) => {
  const tile = e.target.closest('.tile');
  if (tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openViewer(tile.dataset.name); }
});
$$('#file-filter .seg').forEach((b) => b.addEventListener('click', () => {
  fileFilter = b.dataset.filter;
  $$('#file-filter .seg').forEach((x) => x.classList.toggle('active', x === b));
  renderFiles();
}));

// ─── Xem trước ảnh ────────────────────────
const viewer = $('#viewer');
const viewerImg = $('#viewer-img');

function showViewerAt(i) {
  if (!viewerList.length) return;
  viewerIndex = (i + viewerList.length) % viewerList.length;
  const f = viewerList[viewerIndex];
  viewerImg.src = photoUrl(f);
  $('#viewer-name').textContent = f.name;
  const st = f.status === 'done' ? 'Đã lên Drive' : STATUS_TEXT[f.status] || '';
  $('#viewer-meta').textContent = [formatSize(f.size), st].filter(Boolean).join(' · ');
  $('#viewer-pos').textContent = `${viewerIndex + 1} / ${viewerList.length}`;
}
function openViewer(name) {
  const i = viewerList.findIndex((f) => f.name === name);
  if (i < 0) return;
  viewer.classList.remove('hidden');
  showViewerAt(i);
}
function closeViewer() { viewer.classList.add('hidden'); viewerImg.removeAttribute('src'); }
$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-prev').addEventListener('click', () => showViewerAt(viewerIndex - 1));
$('#viewer-next').addEventListener('click', () => showViewerAt(viewerIndex + 1));
$('#viewer-finder').addEventListener('click', () => { const f = viewerList[viewerIndex]; if (f) window.api.showInFinder(joinPath(selectedFolder, f.name)); });
viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer(); });

document.addEventListener('keydown', (e) => {
  if (!viewer.classList.contains('hidden')) {
    if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeViewer(); }
    if (e.key === 'ArrowLeft') showViewerAt(viewerIndex - 1);
    if (e.key === 'ArrowRight') showViewerAt(viewerIndex + 1);
    return;
  }
  if (e.key === 'Escape') closeSetup();
  if (e.metaKey && e.key.toLowerCase() === 'o') { e.preventDefault(); chooseFolder(); }
});

// ─── Nhật ký ──────────────────────────────
const logContainer = $('#log-container');
window.api.onLog((data) => {
  const empty = logContainer.querySelector('.empty');
  if (empty) empty.remove();
  const body = $('#tab-log');
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const entry = document.createElement('div');
  entry.className = `log-entry ${data.type}`;
  entry.innerHTML = `<span class="log-time">${escapeHtml(data.time.slice(-8))}</span><span class="log-msg">${escapeHtml(data.message)}</span>`;
  logContainer.appendChild(entry);
  while (logContainer.childElementCount > MAX_LOG_ENTRIES) logContainer.firstElementChild.remove();
  if (nearBottom) body.scrollTop = body.scrollHeight;
});
$('#btn-clear-logs').addEventListener('click', () => { logContainer.innerHTML = '<div class="empty">Chưa có hoạt động</div>'; });

// ─── Lịch sử ──────────────────────────────
function renderHistory(history) {
  settings.history = history || [];
  const el = $('#history-list');
  if (!settings.history.length) {
    el.innerHTML = '<div class="empty"><b>Chưa có buổi upload nào</b></div>';
    return;
  }
  el.innerHTML = settings.history.map((h) => {
    const live = !h.endedAt;
    const dot = live ? 'live' : h.completedAt ? 'ok' : '';
    const state = live ? 'đang chạy' : h.completedAt ? 'hoàn tất' : 'đã dừng';
    return `
      <div class="h-item" data-id="${escapeHtml(h.id)}">
        <span class="h-dot ${dot}"></span>
        <div class="h-main">
          <div class="h-name" title="${escapeHtml(h.folderPath)}">${escapeHtml(h.driveName || h.folderName)}</div>
          <div class="h-meta">${formatDate(h.startedAt)} · ${h.onDrive || 0}/${h.total || 0} ảnh · ${state}${h.publicLink ? ' · đã chia sẻ' : ''}</div>
        </div>
        <div class="h-actions">
          <button class="link-btn" data-act="copy">Copy link khách</button>
          <button class="link-btn" data-act="open">Mở Drive</button>
          ${live ? '' : '<button class="link-btn" data-act="reuse" title="Chạy lại với đúng folder và thư mục Drive này">Upload tiếp</button>'}
          ${live ? '' : '<button class="link-btn danger" data-act="remove" title="Xoá khỏi lịch sử">Xoá</button>'}
        </div>
      </div>`;
  }).join('');
}

$('#history-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const h = settings.history.find((x) => x.id === btn.closest('.h-item').dataset.id);
  if (!h) return;
  const act = btn.dataset.act;
  if (act === 'open') window.api.openUrl(h.link);
  if (act === 'copy') copyPublicLink(h.id, btn);
  if (act === 'remove') renderHistory(await window.api.removeHistory(h.id));
  if (act === 'reuse' && !isRunning) {
    if (!(await setFolder(h.folderPath, { quiet: true }))) { toast('Không tìm thấy folder (ổ cứng chưa cắm?)'); return; }
    startWith({
      folderPath: h.folderPath,
      folderId: h.driveFolderId,
      driveName: h.driveName || h.folderName,
      linkParentId: h.linkParentId || null,
      linkName: h.linkName || null,
      expectedTotal: 0,
      startFromName: '',
      ...readOptions(),
    });
  }
});

// ─── Tabs ─────────────────────────────────
function switchTab(name) {
  $$('.view-bar > .segmented:first-child .seg').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const n of ['files', 'log', 'history']) $(`#tab-${n}`).classList.toggle('hidden', n !== name);
  $('#btn-clear-logs').classList.toggle('hidden', name !== 'log');
  $('#file-filter').classList.toggle('hidden', name !== 'files');
  $('#view-toggle').classList.toggle('hidden', name !== 'files');
}
$$('.seg[data-tab]').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ─── IPC listeners ────────────────────────
window.api.onStatsUpdate(renderStats);
window.api.onFilesUpdate((list) => { if (isRunning) renderFiles(list); });
window.api.onHistoryUpdate(renderHistory);
window.api.onUploadDone(renderDone);
window.api.onStatusChange((status) => {
  if (status === 'running') { setRunningState(true); return; }
  if (isRunning) hasStopped = true;
  setRunningState(false);
});

// ═══════════════════════════════════════════
// Khởi động
// ═══════════════════════════════════════════
(async () => {
  settings = await window.api.getSettings();
  if (!settings.monthFolders && settings.driveRootId) {
    saveSettings({ monthFolders: [{ id: settings.driveRootId, name: settings.driveRootName || 'Thư mục đã lưu' }], currentMonthId: settings.driveRootId });
  }
  applyOptions(settings.options);
  setViewMode(settings.viewMode, { persist: false });
  renderMonths();
  renderHistory(settings.history);

  const state = await window.api.getState();
  if (state.running && state.config) {
    lastConfig = state.config;
    currentHistoryId = state.historyId;
    await window.api.validateFolder(state.config.folderPath);
    selectedFolder = state.config.folderPath;
    dropHero.classList.add('hidden');
    workspace.classList.remove('hidden');
    $('#folder-name').textContent = basename(selectedFolder);
    setRunningState(true);
    if (state.stats) renderStats(state.stats);
    renderFiles(state.files);
    renderDone(state.done);
  } else if (settings.lastFolder) {
    await setFolder(settings.lastFolder, { quiet: true });
  }
  refresh();
  runSetupChecks({ openOnFail: true });
})();
