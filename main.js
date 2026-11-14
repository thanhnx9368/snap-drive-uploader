const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, powerSaveBlocker, Tray, Menu, nativeImage, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { Uploader, UploadLog, TEXT_LOG_DIR } = require('./uploader');
const { resolveTarget, FULLWIDTH_SLASH } = require('./drive-target');
const { folderShootDate } = require('./exif');

// Fix PATH for macOS .app bundles (Homebrew paths not inherited)
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/sbin', '/usr/local/sbin'];
const shellEnv = {
  ...process.env,
  PATH: [...EXTRA_PATHS, process.env.PATH].join(':'),
};

const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

let mainWindow = null;
let uploader = null;
let currentConfig = null;
let lastStats = null;
let lastDone = null;
let sleepTimer = null;
let powerBlockId = null;
let forceQuit = false;
let tray = null;
let currentHistoryId = null;

// ─── Settings & history (userData/settings.json) ─────────
const SETTINGS_KEYS = ['viewMode', 'monthFolders', 'currentMonthId', 'driveRootId', 'driveRootName', 'byMonth', 'destMode', 'lastDriveLink', 'lastFolder', 'options', 'logOpen'];
const MAX_HISTORY = 30;
let settings = null;

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }

function loadSettings() {
  if (settings) return settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')); } catch { settings = {}; }
  if (!Array.isArray(settings.history)) settings.history = [];
  // Buổi nào còn "đang chạy" từ lần mở trước (app bị tắt ngang) → đánh dấu đã dừng
  for (const h of settings.history) if (!h.endedAt) h.endedAt = h.startedAt;
  return settings;
}

function saveSettings() {
  try {
    const tmp = settingsPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmp, settingsPath());
  } catch { /* skip */ }
}

function updateHistory(patch, persist = false) {
  if (!currentHistoryId) return;
  const h = loadSettings().history.find((x) => x.id === currentHistoryId);
  if (h) Object.assign(h, patch);
  if (persist) { saveSettings(); send('history-update', settings.history); }
}

// ─── Tray (thanh menu macOS) ─────────────────────────────
function showWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow();
}

function updateTray(stats) {
  if (!stats || stats.phase === 'stopped') {
    if (tray) { tray.destroy(); tray = null; }
    return;
  }
  if (!tray) {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('Snappy Drive');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Mở Snappy Drive', click: showWindow },
      { type: 'separator' },
      { label: 'Thoát', click: () => app.quit() },
    ]));
  }
  const n = `${stats.cumulativeUploaded}/${stats.target || stats.total}`;
  const icon = { done: '✓', paused: '⏸', verifying: '🔎', stopping: '⏹' }[stats.phase];
  tray.setTitle(icon ? `☁️ ${icon} ${n}` : `☁️ ${n}`);
}

// Cho phép chạy thử với thư mục dữ liệu riêng (không đụng cài đặt thật)
if (process.env.SNAPPY_USER_DATA) app.setPath('userData', process.env.SNAPPY_USER_DATA);

// ─── Thumbnail & xem trước ảnh: snappy://thumb?p=...&s=256, snappy://photo?p=... ──
protocol.registerSchemesAsPrivileged([
  { scheme: 'snappy', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const allowedFolders = new Set(); // chỉ phục vụ ảnh trong folder người dùng đã chọn
const thumbCache = new Map();
const MAX_THUMBS = 800;
const BROWSER_IMAGE = /\.(jpe?g|png|gif|webp|avif)$/i;

function isAllowedFile(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  return allowedFolders.has(path.dirname(path.resolve(p)));
}

async function makeThumb(p, size) {
  const st = fs.statSync(p);
  const key = `${p}|${st.mtimeMs}|${size}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
  const buf = img.toJPEG(82);
  thumbCache.set(key, buf);
  if (thumbCache.size > MAX_THUMBS) thumbCache.delete(thumbCache.keys().next().value);
  return buf;
}

function registerImageProtocol() {
  protocol.handle('snappy', async (req) => {
    try {
      const u = new URL(req.url);
      const p = u.searchParams.get('p');
      if (!isAllowedFile(p) || !fs.existsSync(p)) return new Response('not found', { status: 404 });
      if (u.hostname === 'photo' && BROWSER_IMAGE.test(p)) return net.fetch(pathToFileURL(p).toString());
      const size = u.hostname === 'photo' ? 2000 : Math.min(512, Math.max(64, parseInt(u.searchParams.get('s'), 10) || 256));
      const buf = await makeThumb(p, size);
      return new Response(buf, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' } });
    } catch {
      return new Response('error', { status: 404 });
    }
  });
}

// ─── Single instance ─────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}

// ─── Window ──────────────────────────────────────────────
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

function createWindow() {
  // Khi chạy bằng npm start, Dock hiện icon Electron mặc định → đổi sang logo Snappy
  if (!app.isPackaged && app.dock) { try { app.dock.setIcon(APP_ICON); } catch { /* skip */ } }
  mainWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 1050,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Snappy Drive',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f6f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => { registerImageProtocol(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.on('before-quit', (e) => {
  if (!uploader || forceQuit) return;
  if (uploader.isBusy()) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Huỷ', 'Thoát'],
      defaultId: 0,
      cancelId: 0,
      message: 'Đang upload ảnh lên Drive',
      detail: 'Thoát bây giờ sẽ dừng upload. Các file chưa xong sẽ được upload ở lần chạy sau.',
    });
    if (choice === 0) { e.preventDefault(); return; }
  }
  forceQuit = true;
  uploader.cancel();
});

// ─── Helpers ─────────────────────────────────────────────
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function pad(n) { return n.toString().padStart(2, '0'); }
function formatFullTime(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function localDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function getLogDir() {
  const base = currentConfig?.folderPath && fs.existsSync(currentConfig.folderPath)
    ? path.join(currentConfig.folderPath, TEXT_LOG_DIR)
    : path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* skip */ }
  return base;
}

function logToFile(message) {
  const now = new Date();
  try {
    fs.appendFileSync(path.join(getLogDir(), `upload-log-${localDateStr(now)}.txt`), `[${formatFullTime(now)}] ${message}\n`);
  } catch { /* ổ bị rút */ }
}

function sendLog(message, type = 'info') {
  logToFile(message);
  send('log', { message, type, time: formatFullTime(new Date()) });
}

function rclone(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('rclone', args, { timeout, env: shellEnv, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}

function extractFolderId(url) {
  if (typeof url !== 'string') return null;
  const patterns = [/\/folders\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m && FOLDER_ID_RE.test(m[1])) return m[1];
  }
  return null;
}

// ─── Power / sleep ───────────────────────────────────────
function updatePowerBlock(phase) {
  const needAwake = uploader && phase !== 'done' && phase !== 'stopped';
  if (needAwake && powerBlockId === null) {
    powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!needAwake && powerBlockId !== null) {
    powerSaveBlocker.stop(powerBlockId);
    powerBlockId = null;
  }
}

function cancelSleepTimer() {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
}

function scheduleSleep(minutes) {
  cancelSleepTimer();
  sendLog(`😴 Máy sẽ sleep sau ${minutes} phút nếu không có ảnh mới`, 'info');
  sleepTimer = setTimeout(() => {
    sleepTimer = null;
    if (!uploader || uploader.phase() !== 'done') return;
    sendLog('😴 Đã xong và không có ảnh mới — cho máy sleep', 'warn');
    stopUploader();
    setTimeout(() => execFile('pmset', ['sleepnow'], () => {}), 3000);
  }, minutes * 60 * 1000);
}

// ─── Uploader wiring ─────────────────────────────────────
function stopUploader() {
  if (uploader) uploader.stop();
}

function onDone(summary) {
  lastDone = summary;
  updateHistory({ onDrive: summary.onDrive, total: summary.total, uploaded: summary.sessionUploaded, completedAt: new Date().toISOString() }, true);
  send('upload-done', summary);


  if (Notification.isSupported()) {
    const extra = summary.conflicts ? ` · ${summary.conflicts} file trùng tên` : '';
    const n = new Notification({
      title: '✅ Snappy Drive — đã upload xong',
      body: `${summary.onDrive}/${summary.total} ảnh đã có trên Drive${extra}`,
    });
    n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); });
    n.show();
  }
  if (app.dock) app.dock.bounce('informational');

  if (currentConfig?.autoSleep && currentConfig.sleepMinutes > 0) scheduleSleep(currentConfig.sleepMinutes);
}

function onStats(stats) {
  const prevPhase = lastStats?.phase;
  lastStats = stats;
  send('stats-update', stats);
  updatePowerBlock(stats.phase);
  updateTray(stats);
  updateHistory({ uploaded: stats.sessionUploaded, total: stats.total, onDrive: stats.cumulativeUploaded });
  if (stats.phase !== 'done') {
    if (sleepTimer) { cancelSleepTimer(); sendLog('⏰ Có ảnh mới — huỷ hẹn giờ sleep', 'info'); }
    if (prevPhase === 'done') { lastDone = null; send('upload-done', null); }
  }
  if (app.dock) app.dock.setBadge(stats.remaining > 0 ? String(stats.remaining) : '');
}

function onStopped() {
  sendLog('⏹ Đã dừng theo dõi', 'info');
  updateHistory({ endedAt: new Date().toISOString() }, true);
  currentHistoryId = null;
  updateTray(null);
  cancelSleepTimer();
  uploader = null;
  updatePowerBlock('stopped');
  if (app.dock) app.dock.setBadge('');
  send('status-change', 'stopped');
}

// ─── IPC: Settings ───────────────────────────────────────
ipcMain.handle('get-settings', () => loadSettings());

ipcMain.handle('save-settings', (_, patch) => {
  loadSettings();
  if (patch && typeof patch === 'object') {
    for (const k of SETTINGS_KEYS) if (k in patch) settings[k] = patch[k];
  }
  saveSettings();
  return settings;
});

ipcMain.handle('remove-history', (_, id) => {
  loadSettings();
  settings.history = id ? settings.history.filter((h) => h.id !== id || h.id === currentHistoryId) : settings.history.filter((h) => h.id === currentHistoryId);
  saveSettings();
  return settings.history;
});

// ─── IPC: Folder ─────────────────────────────────────────
ipcMain.handle('validate-folder', (_, folderPath) => {
  try {
    const ok = typeof folderPath === 'string' && fs.statSync(folderPath).isDirectory();
    if (ok) allowedFolders.add(path.resolve(folderPath));
    return ok;
  } catch { return false; }
});

ipcMain.handle('list-folder', (_, folderPath, startFromName = '') => {
  if (typeof folderPath !== 'string' || !allowedFolders.has(path.resolve(folderPath))) return [];
  return UploadLog.listWithStatus(folderPath, startFromName);
});

ipcMain.handle('show-in-finder', (_, filePath) => { if (isAllowedFile(filePath)) shell.showItemInFolder(filePath); });

// Bật chia sẻ "Ai có link đều xem được" cho thư mục khách rồi trả về link
async function makePublicLink({ folderId, parentId, name }) {
  const args = parentId && name
    ? ['link', `drive:${name.replace(/\//g, FULLWIDTH_SLASH)}`, '--drive-root-folder-id', parentId]
    : ['link', 'drive:', '--drive-root-folder-id', folderId];
  const out = await rclone(args, 60000);
  const url = out.trim().split('\n').pop().trim();
  if (!/^https:\/\//.test(url)) throw new Error('rclone không trả về link');
  return url;
}

ipcMain.handle('public-link', async (_, historyId) => {
  const h = loadSettings().history.find((x) => x.id === historyId);
  if (!h) return { success: false, message: 'Không tìm thấy buổi upload' };
  if (h.publicLink) return { success: true, url: h.publicLink, cached: true };
  if (!FOLDER_ID_RE.test(h.driveFolderId || '')) return { success: false, message: 'Thiếu ID thư mục Drive' };
  if (!h.linkParentId) {
    // Upload thẳng vào thư mục có sẵn (có thể là cả thư mục tháng) → hỏi trước khi mở công khai
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Huỷ', 'Chia sẻ công khai'],
      defaultId: 0,
      cancelId: 0,
      message: `Chia sẻ công khai “${h.driveName || 'thư mục này'}”?`,
      detail: 'Ai có link đều xem được toàn bộ ảnh trong thư mục này, kể cả ảnh của khách khác nếu có.',
    });
    if (choice !== 1) return { success: false, cancelled: true };
  }
  try {
    const url = await makePublicLink({ folderId: h.driveFolderId, parentId: h.linkParentId, name: h.linkName });
    h.publicLink = url;
    saveSettings();
    send('history-update', settings.history);
    return { success: true, url };
  } catch (e) {
    const why = (e.stderr || e.message || '').trim().split('\n').pop().replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d \w+\s*:\s*/, '');
    return { success: false, message: `Không bật được chia sẻ công khai: ${why}` };
  }
});

ipcMain.handle('read-folder-log', (_, folderPath, startFromName = '') => {
  if (typeof folderPath !== 'string' || !fs.existsSync(folderPath)) {
    return { hasLog: false, cumulativeUploaded: 0, localCount: 0, remaining: 0, totalSessions: 0 };
  }
  return UploadLog.summarize(folderPath, startFromName);
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Chọn folder Lightroom export ra' });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('validate-drive-link', (_, url) => extractFolderId(url));

// ─── IPC: Setup checks ──────────────────────────────────
ipcMain.handle('check-rclone-full', async () => {
  const result = { installed: false, version: null, remoteExists: false, connectionOk: false, errorDetail: '' };
  try {
    const out = await rclone(['version'], 10000);
    const m = out.match(/rclone v([^\s]+)/);
    result.installed = true;
    result.version = m ? m[1] : 'unknown';
  } catch { result.errorDetail = 'rclone chưa được cài đặt'; return result; }

  try {
    const list = (await rclone(['listremotes'], 10000)).split('\n').map((r) => r.trim()).filter(Boolean);
    result.remoteExists = list.includes('drive:');
    if (!result.remoteExists) {
      result.errorDetail = `Remote "drive" chưa tồn tại. Hiện có: ${list.length ? list.join(', ') : '(trống)'}`;
      return result;
    }
  } catch (err) { result.errorDetail = `Lỗi: ${err.message}`; return result; }

  try {
    await rclone(['about', 'drive:'], 30000);
    result.connectionOk = true;
  } catch { result.errorDetail = 'Kết nối Google Drive thất bại. Token có thể đã hết hạn.'; }
  return result;
});

function runRcloneInteractive(args, okMessage) {
  return new Promise((resolve) => {
    const child = spawn('rclone', args, { stdio: ['ignore', 'pipe', 'pipe'], env: shellEnv });
    let out = '';
    const onData = (d) => { out += d; send('config-output', d.toString()); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve(code === 0 ? { success: true, message: okMessage } : { success: false, message: `Lỗi: ${out.trim().split('\n').pop() || code}` }));
    child.on('error', (e) => resolve({ success: false, message: e.message }));
  });
}

ipcMain.handle('create-drive-remote', () => runRcloneInteractive(['config', 'create', 'drive', 'drive'], 'Remote "drive" đã tạo thành công!'));

ipcMain.handle('reconfigure-drive-remote', async () => {
  if (uploader) return { success: false, message: 'Hãy dừng upload trước khi đổi tài khoản' };
  try { await rclone(['config', 'delete', 'drive'], 10000); } catch { /* chưa có remote */ }
  return runRcloneInteractive(['config', 'create', 'drive', 'drive'], 'Đã cấu hình lại thành công!');
});

ipcMain.handle('reconnect-drive-remote', () => runRcloneInteractive(['config', 'reconnect', 'drive:'], 'Đã kết nối lại thành công!'));

ipcMain.handle('open-url', (_, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url);
  return null;
});

ipcMain.handle('copy-text', (_, text) => { if (typeof text === 'string') clipboard.writeText(text); });

ipcMain.handle('open-folder', (_, folderPath) => {
  if (typeof folderPath === 'string' && fs.existsSync(folderPath)) return shell.openPath(folderPath);
  return null;
});

// Tìm (hoặc tạo) thư mục đích trong thư mục Drive gốc, VD ["2026", "T11", "14/11 Bảo An"]
ipcMain.handle('resolve-drive-target', async (_, rootId, segments) => {
  if (!FOLDER_ID_RE.test(rootId || '')) return { success: false, message: 'Thư mục gốc không hợp lệ' };
  if (!Array.isArray(segments) || !segments.length) return { success: false, message: 'Hãy nhập tên thư mục trên Drive' };
  try {
    const r = await resolveTarget((args) => rclone(args, 60000), rootId, segments);
    return { success: true, ...r };
  } catch (e) {
    return { success: false, message: `Không tạo được thư mục trên Drive: ${(e.stderr || e.message || '').trim().split('\n').pop()}` };
  }
});

ipcMain.handle('read-shoot-date', (_, folderPath) => {
  if (typeof folderPath !== 'string') return { date: null, images: 0 };
  return folderShootDate(folderPath);
});

ipcMain.handle('check-folder-access', async (_, folderId) => {
  if (!FOLDER_ID_RE.test(folderId || '')) return { hasAccess: false, error: 'Folder ID không hợp lệ.' };
  try {
    await rclone(['lsf', 'drive:', '--drive-root-folder-id', folderId, '--max-depth', '1', '--dirs-only'], 20000);
    return { hasAccess: true };
  } catch {
    return { hasAccess: false, error: 'Không có quyền truy cập folder này hoặc folder không tồn tại.' };
  }
});

// ─── IPC: Monitoring ─────────────────────────────────────
ipcMain.handle('get-state', () => ({
  running: !!uploader,
  historyId: currentHistoryId,
  files: uploader ? uploader.getFileList() : [],
  config: currentConfig,
  stats: lastStats,
  done: lastDone,
}));

ipcMain.handle('start-monitoring', (_, config) => {
  if (uploader) return { success: false, message: 'Đang theo dõi rồi' };
  if (!config || typeof config.folderPath !== 'string' || !fs.existsSync(config.folderPath)) {
    return { success: false, message: 'Folder không tồn tại' };
  }
  if (!FOLDER_ID_RE.test(config.folderId || '')) return { success: false, message: 'Folder ID không hợp lệ' };

  allowedFolders.add(path.resolve(config.folderPath));
  currentConfig = {
    folderPath: config.folderPath,
    folderId: config.folderId,
    overwrite: !!config.overwrite,
    autoSleep: !!config.autoSleep,
    sleepMinutes: Number(config.sleepMinutes) || 0,
    startFromName: (config.startFromName || '').trim(),
    expectedTotal: Math.max(0, parseInt(config.expectedTotal, 10) || 0),
    linkParentId: FOLDER_ID_RE.test(config.linkParentId || '') ? config.linkParentId : null,
    linkName: typeof config.linkName === 'string' ? config.linkName.slice(0, 300) : null,
    driveName: String(config.driveName || '').slice(0, 200),
  };
  lastDone = null;
  lastStats = null;

  uploader = new Uploader({ ...currentConfig, env: shellEnv });
  uploader.on('log', (msg, type) => sendLog(msg, type));
  uploader.on('stats', onStats);
  uploader.on('done', onDone);
  uploader.on('files', (files) => send('files-update', files));
  uploader.once('stopped', onStopped);

  send('status-change', 'running');
  sendLog('▶ Bắt đầu theo dõi — ảnh sẽ được upload ngay khi export xong');
  sendLog(`📂 Folder: ${currentConfig.folderPath}`);
  sendLog(`🔗 Drive: ${config.driveName ? config.driveName + ' — ' : ''}${uploader.driveLink}`);
  if (currentConfig.startFromName) sendLog(`⏭ Chỉ upload từ "${currentConfig.startFromName}" trở đi`, 'info');
  if (currentConfig.overwrite) sendLog('⚠️ Upload đè đang BẬT: file trùng tên trên Drive sẽ bị thay', 'warn');

  const prev = UploadLog.summarize(currentConfig.folderPath, currentConfig.startFromName);
  if (prev.cumulativeUploaded > 0) sendLog(`📊 Phiên trước: đã upload ${prev.cumulativeUploaded}/${prev.localCount} file`, 'info');

  loadSettings();
  currentHistoryId = `job_${Date.now()}`;
  settings.history.unshift({
    id: currentHistoryId,
    folderPath: currentConfig.folderPath,
    folderName: path.basename(currentConfig.folderPath),
    driveFolderId: currentConfig.folderId,
    driveName: currentConfig.driveName,
    linkParentId: currentConfig.linkParentId,
    linkName: currentConfig.linkName,
    link: uploader.driveLink,
    startedAt: new Date().toISOString(),
    endedAt: null,
    uploaded: 0,
    total: 0,
    onDrive: 0,
  });
  settings.history = settings.history.slice(0, MAX_HISTORY);
  saveSettings();
  send('history-update', settings.history);

  uploader.start();
  return { success: true, historyId: currentHistoryId };
});

ipcMain.handle('stop-monitoring', () => {
  stopUploader();
  return { success: true };
});

ipcMain.handle('cancel-upload', () => {
  if (uploader) {
    sendLog('🛑 Huỷ ngay — dừng mọi upload đang chạy', 'warn');
    uploader.cancel();
  }
  return { success: true };
});

ipcMain.handle('pause-upload', () => { if (uploader) uploader.pause(); return { success: true }; });
ipcMain.handle('resume-upload', () => { if (uploader) uploader.resume(); return { success: true }; });

ipcMain.handle('upload-now', () => {
  if (!uploader) return { success: false, message: 'Chưa có phiên theo dõi' };
  sendLog('🔎 Kiểm tra ngay: thử lại file lỗi và đối chiếu với Drive', 'info');
  uploader.forceCheck();
  return { success: true };
});
