const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

let mainWindow;
let pollingInterval = null;
let isMonitoring = false;
let currentConfig = null;
let scanLock = false;
let lastNewFileTime = Date.now();
let sleepTimerInterval = null;
let currentUploadProcess = null; // Track rclone child process

const POLL_INTERVAL_MS = 20000;
const MAX_RETRIES = 3;
const IGNORED_FILES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

// Stats: cumulative = across all sessions, session = current session only
let stats = { total: 0, cumulativeUploaded: 0, sessionUploaded: 0, remaining: 0 };

// ─── Window ──────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1050,
    height: 830,
    minWidth: 800,
    minHeight: 600,
    title: 'Snap Drive',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── Helpers ─────────────────────────────────────────────
function getLogDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logToFile(message) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);
  const line = `[${timeStr}] ${message}\n`;
  const filePath = path.join(getLogDir(), `upload-log-${dateStr}.txt`);
  fs.appendFileSync(filePath, line);
}

function sendLog(message, type = 'info') {
  logToFile(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', { message, type, time: new Date().toTimeString().slice(0, 5) });
  }
}

function sendStats() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stats-update', { ...stats });
  }
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-change', status);
  }
}

function isIgnoredFile(filename) {
  if (IGNORED_FILES.includes(filename)) return true;
  if (filename.startsWith('.')) return true;
  if (filename.startsWith('._')) return true;
  return false;
}

function extractFolderId(url) {
  const patterns = [/\/folders\/([a-zA-Z0-9_-]+)/, /id=([a-zA-Z0-9_-]+)/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── Session Logger ──────────────────────────────────────
class SessionLogger {
  constructor() {
    this.logFilePath = null;
    this.currentSession = null;
    this.logData = { sessions: [], uploadedFiles: {} }; // uploadedFiles: { filename: { size, uploadedAt, status } }
  }

  init(folderPath) {
    this.logFilePath = path.join(folderPath, '.appuploadanh-log.json');
    try {
      if (fs.existsSync(this.logFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.logFilePath, 'utf-8'));
        this.logData = data;
        if (!this.logData.uploadedFiles) this.logData.uploadedFiles = {};

        // Rebuild uploadedFiles from old sessions if map is empty
        if (Object.keys(this.logData.uploadedFiles).length === 0 && this.logData.sessions?.length > 0) {
          for (const session of this.logData.sessions) {
            if (!session.scans) continue;
            for (const scan of session.scans) {
              if (!scan.files) continue;
              for (const file of scan.files) {
                if (file.status === 'uploaded' || file.status === 'replaced') {
                  this.logData.uploadedFiles[file.name] = {
                    size: file.size || null,
                    uploadedAt: file.uploadedAt || session.startTime,
                  };
                }
              }
            }
          }
          // Save rebuilt data
          if (Object.keys(this.logData.uploadedFiles).length > 0) {
            this.save();
          }
        }
      }
    } catch { this.logData = { sessions: [], uploadedFiles: {} }; }
  }

  // Get count of previously uploaded files
  getCumulativeUploadedCount() {
    return Object.keys(this.logData.uploadedFiles || {}).length;
  }

  // Get list of previously uploaded filenames
  getUploadedFileNames() {
    return new Set(Object.keys(this.logData.uploadedFiles || {}));
  }

  startSession(config) {
    this.currentSession = {
      id: `session_${Date.now()}`,
      startTime: new Date().toISOString(),
      endTime: null,
      folderPath: config.folderPath,
      driveFolderId: config.folderId,
      overwrite: config.overwrite || false,
      scans: [],
      filesUploaded: 0,
      filesFailed: 0,
      totalBytesUploaded: 0,
      errors: [],
    };
    return this.currentSession;
  }

  logScan(scanData) {
    if (!this.currentSession) return;
    this.currentSession.scans.push({
      timestamp: new Date().toISOString(),
      localFileCount: scanData.localFileCount,
      remoteFileCount: scanData.remoteFileCount || null,
      filesStillWriting: scanData.filesStillWriting || false,
      uploadResult: null,
      files: [],
    });
  }

  logFileUploaded(fileName, fileSize) {
    if (!this.currentSession) return;
    const scanIndex = this.currentSession.scans.length - 1;
    if (scanIndex >= 0) {
      this.currentSession.scans[scanIndex].files.push({
        name: fileName,
        size: fileSize,
        uploadedAt: new Date().toISOString(),
        status: 'uploaded',
      });
    }
    this.currentSession.filesUploaded++;
    if (fileSize) this.currentSession.totalBytesUploaded += fileSize;

    // Add to cumulative uploaded files
    this.logData.uploadedFiles[fileName] = {
      size: fileSize,
      uploadedAt: new Date().toISOString(),
    };
  }

  // Sync: mark all local files as uploaded (when Drive confirms they're all there)
  syncAllLocalFiles(folderPath) {
    try {
      const files = fs.readdirSync(folderPath);
      let added = 0;
      for (const f of files) {
        if (f.startsWith('.') || ['Thumbs.db', 'desktop.ini'].includes(f)) continue;
        try {
          const stat = fs.statSync(path.join(folderPath, f));
          if (!stat.isFile()) continue;
          if (!this.logData.uploadedFiles[f]) {
            this.logData.uploadedFiles[f] = {
              size: stat.size,
              uploadedAt: new Date().toISOString(),
            };
            added++;
          }
        } catch { /* skip */ }
      }
      if (added > 0) this.save();
      return added;
    } catch { return 0; }
  }

  logFileFailed(fileName, error) {
    if (!this.currentSession) return;
    const scanIndex = this.currentSession.scans.length - 1;
    if (scanIndex >= 0) {
      this.currentSession.scans[scanIndex].files.push({
        name: fileName,
        status: 'failed',
        error,
      });
    }
    this.currentSession.filesFailed++;
    this.currentSession.errors.push({ timestamp: new Date().toISOString(), file: fileName, message: error });
  }

  logScanResult(result) {
    if (!this.currentSession) return;
    const scanIndex = this.currentSession.scans.length - 1;
    if (scanIndex >= 0) {
      this.currentSession.scans[scanIndex].uploadResult = {
        success: result.success,
        transferred: result.transferred,
        durationMs: result.durationMs,
      };
      if (result.remoteFileCount !== undefined) {
        this.currentSession.scans[scanIndex].remoteFileCount = result.remoteFileCount;
      }
    }
  }

  endSession() {
    if (!this.currentSession) return;
    this.currentSession.endTime = new Date().toISOString();
    this.logData.sessions.push(this.currentSession);
    this.save();
    this.currentSession = null;
  }

  saveProgress() {
    if (!this.logFilePath) return;
    try {
      const snapshot = { ...this.logData };
      if (this.currentSession) {
        snapshot.sessions = [...this.logData.sessions, { ...this.currentSession, endTime: null }];
      }
      fs.writeFileSync(this.logFilePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch { /* skip */ }
  }

  save() {
    if (!this.logFilePath) return;
    try {
      fs.writeFileSync(this.logFilePath, JSON.stringify(this.logData, null, 2), 'utf-8');
    } catch { /* skip */ }
  }
}

const sessionLogger = new SessionLogger();

// ─── File helpers ────────────────────────────────────────
function hasRecentlyModifiedFiles(folderPath, thresholdMs = 5000) {
  try {
    const files = fs.readdirSync(folderPath);
    const now = Date.now();
    for (const f of files) {
      if (isIgnoredFile(f)) continue;
      try {
        const stat = fs.statSync(path.join(folderPath, f));
        if (stat.isFile() && (now - stat.mtimeMs) < thresholdMs) return true;
      } catch { /* skip */ }
    }
    return false;
  } catch { return false; }
}

function countLocalFiles(folderPath) {
  try {
    return fs.readdirSync(folderPath).filter(f => {
      if (isIgnoredFile(f)) return false;
      try { return fs.statSync(path.join(folderPath, f)).isFile(); }
      catch { return false; }
    }).length;
  } catch { return 0; }
}

function getRemoteFileCount(folderId) {
  return new Promise((resolve) => {
    exec(`rclone lsf "drive:" --drive-root-folder-id="${folderId}" --files-only --exclude ".*"`, { timeout: 60000 }, (error, stdout) => {
      if (error) { resolve(0); return; }
      resolve(stdout.split('\n').filter(Boolean).length);
    });
  });
}

// ─── Upload with real-time progress ──────────────────────
function runRcloneUpload(folderPath, folderId, overwrite = false) {
  return new Promise((resolve) => {
    const args = [
      'copy', folderPath, 'drive:',
      '--drive-root-folder-id', folderId,
      '--exclude', '.*',
      '--exclude', 'Thumbs.db',
      '--exclude', 'desktop.ini',
      '-v', '--stats', '3s', '--stats-one-line',
    ];
    if (!overwrite) args.push('--ignore-existing');

    const child = spawn('rclone', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    currentUploadProcess = child;

    let lastProgressLine = '';
    let transferredCount = 0;
    let hasError = false;
    const uploadStartTime = Date.now();

    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);

      for (const line of lines) {
        if (line.includes(': Copied (new)') || line.includes(': Copied (replaced')) {
          const match = line.match(/:\s+(.+?):\s+Copied/);
          const isReplaced = line.includes('replaced');
          if (match) {
            transferredCount++;
            const fileName = match[1];
            sendLog(`✅ ${fileName} — đã upload${isReplaced ? ' (đè)' : ''}`, 'success');

            // Get file size
            let fileSize = null;
            try { fileSize = fs.statSync(path.join(folderPath, fileName)).size; } catch {}

            // Update stats
            stats.sessionUploaded++;
            stats.cumulativeUploaded++;
            stats.remaining = Math.max(0, stats.total - stats.cumulativeUploaded);
            sendStats();
            lastNewFileTime = Date.now();

            // Structured log
            sessionLogger.logFileUploaded(fileName, fileSize);
          }
        } else if (line.includes('Transferred:') && line.includes('/')) {
          const statsMatch = line.match(/Transferred:\s+(\d+)\s*\/\s*(\d+)/);
          if (statsMatch) {
            const done = parseInt(statsMatch[1]);
            const total = parseInt(statsMatch[2]);
            const speedMatch = line.match(/,\s*([\d.]+\s*\w+\/s)/);
            const etaMatch = line.match(/ETA\s+([\dhms]+)/);
            let progressMsg = `📤 ${done}/${total} file`;
            if (speedMatch) progressMsg += ` | ${speedMatch[1]}`;
            if (etaMatch) progressMsg += ` | ETA ${etaMatch[1]}`;
            if (progressMsg !== lastProgressLine) {
              lastProgressLine = progressMsg;
              sendLog(progressMsg, 'info');
            }
          }
        } else if (line.includes('ERROR')) {
          hasError = true;
          const errMatch = line.match(/:\s+(.+?):\s+(.+)/);
          if (errMatch) {
            sendLog(`❌ ${errMatch[1]}: ${errMatch[2]}`, 'error');
            sessionLogger.logFileFailed(errMatch[1], errMatch[2]);
          }
        } else if (line.includes('There was nothing to transfer')) {
          sendLog('✓ Tất cả file đã được upload trước đó', 'info');
        }
      }
    });

    child.on('close', (code) => {
      currentUploadProcess = null;
      resolve({ success: code === 0, transferred: transferredCount, hasError, durationMs: Date.now() - uploadStartTime });
    });

    child.on('error', (err) => {
      currentUploadProcess = null;
      resolve({ success: false, transferred: 0, hasError: true, durationMs: Date.now() - uploadStartTime });
    });
  });
}

// ─── Scan & Upload ───────────────────────────────────────
async function scanAndUpload(config, retryCount = 0) {
  if (scanLock) {
    sendLog('⏳ Upload đang chạy, chờ hoàn thành...', 'warn');
    return;
  }

  scanLock = true;
  const { folderPath, folderId } = config;

  try {
    if (!fs.existsSync(folderPath)) {
      sendLog('Folder theo dõi không tồn tại!', 'error');
      return;
    }

    const localCount = countLocalFiles(folderPath);
    stats.total = localCount;
    stats.remaining = Math.max(0, localCount - stats.cumulativeUploaded);
    sendLog(`📁 Quét folder: ${localCount} file (đã upload: ${stats.cumulativeUploaded}, còn: ${stats.remaining})`);
    sendStats();

    // Log scan
    const isStillWriting = hasRecentlyModifiedFiles(folderPath, 5000);
    sessionLogger.logScan({ localFileCount: localCount, filesStillWriting: isStillWriting });

    if (isStillWriting) {
      sendLog('⏳ Có file đang ghi, chờ lần quét tiếp...', 'warn');
      sessionLogger.saveProgress();
      return;
    }

    if (stats.remaining <= 0 && !config.overwrite) {
      sendLog('✓ Tất cả file đã upload — chờ file mới...', 'info');
      sessionLogger.saveProgress();
      return;
    }

    sendLog('🚀 Bắt đầu upload...', 'info');
    const result = await runRcloneUpload(folderPath, folderId, config.overwrite);

    // Log result
    const remoteCount = await getRemoteFileCount(folderId);
    sessionLogger.logScanResult({ ...result, remoteFileCount: remoteCount });

    if (result.success) {
      // Update cumulative from remote
      stats.cumulativeUploaded = remoteCount;
      stats.remaining = Math.max(0, localCount - remoteCount);
      sendStats();

      // Sync uploadedFiles map with actual state
      if (remoteCount >= localCount) {
        const added = sessionLogger.syncAllLocalFiles(folderPath);
        if (added > 0) sendLog(`📝 Log đã cập nhật: +${added} file từ phiên trước`, 'info');
      }

      if (result.transferred > 0) {
        sendLog(`🎉 Hoàn thành! Upload ${result.transferred} file (tổng: ${stats.cumulativeUploaded}/${stats.total})`, 'success');
      } else {
        sendLog(`✓ Đồng bộ OK — ${stats.cumulativeUploaded}/${stats.total} file trên Drive`, 'info');
      }
    } else if (retryCount < MAX_RETRIES) {
      sendLog(`⚠️ Upload lỗi, thử lại lần ${retryCount + 1}/${MAX_RETRIES}...`, 'warn');
      scanLock = false;
      return scanAndUpload(config, retryCount + 1);
    } else {
      sendLog(`❌ Upload thất bại sau ${MAX_RETRIES} lần thử`, 'error');
    }

    sessionLogger.saveProgress();
  } catch (err) {
    sendLog(`❌ Lỗi: ${err.message}`, 'error');
  } finally {
    scanLock = false;
  }
}

// ─── Auto-sleep ──────────────────────────────────────────
function startSleepTimer(idleMinutes) {
  if (sleepTimerInterval) clearInterval(sleepTimerInterval);
  sleepTimerInterval = setInterval(() => {
    const idleMs = Date.now() - lastNewFileTime;
    if (idleMs >= idleMinutes * 60 * 1000 && isMonitoring) {
      sendLog(`😴 Không có file mới trong ${idleMinutes} phút. Sleep máy...`, 'warn');
      stopMonitoring();
      setTimeout(() => { exec('pmset sleepnow'); }, 3000);
    }
  }, 30000);
}

function stopSleepTimer() {
  if (sleepTimerInterval) { clearInterval(sleepTimerInterval); sleepTimerInterval = null; }
}

// ─── Stop monitoring ──────────────────────────────────────
function stopMonitoring() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
  isMonitoring = false;
  currentConfig = null;
  stopSleepTimer();
  sessionLogger.endSession();
  sendStatus('stopped');
}

// ─── IPC: Read log from folder ───────────────────────────
ipcMain.handle('read-folder-log', (_, folderPath) => {
  const logPath = path.join(folderPath, '.appuploadanh-log.json');
  try {
    if (fs.existsSync(logPath)) {
      const data = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      let uploadedFiles = data.uploadedFiles || {};

      // Rebuild from sessions if uploadedFiles is empty (old log format)
      if (Object.keys(uploadedFiles).length === 0 && data.sessions?.length > 0) {
        for (const session of data.sessions) {
          if (!session.scans) continue;
          for (const scan of session.scans) {
            if (!scan.files) continue;
            for (const file of scan.files) {
              if (file.status === 'uploaded' || file.status === 'replaced') {
                uploadedFiles[file.name] = { size: file.size || null, uploadedAt: file.uploadedAt };
              }
            }
          }
        }
      }

      const cumulativeUploaded = Object.keys(uploadedFiles).length;
      const localCount = countLocalFiles(folderPath);
      const totalSessions = (data.sessions || []).length;
      return {
        hasLog: true,
        cumulativeUploaded,
        localCount,
        remaining: Math.max(0, localCount - cumulativeUploaded),
        totalSessions,
      };
    }
  } catch { /* skip */ }
  return { hasLog: false, cumulativeUploaded: 0, localCount: countLocalFiles(folderPath), remaining: 0, totalSessions: 0 };
});

// ─── IPC: Setup checks ──────────────────────────────────
ipcMain.handle('check-rclone-full', async () => {
  const result = { installed: false, version: null, remoteExists: false, connectionOk: false, errorDetail: '' };
  try {
    const version = await new Promise((resolve, reject) => {
      exec('rclone version', (err, stdout) => {
        if (err) reject(err);
        else { const m = stdout.match(/rclone v([^\s]+)/); resolve(m ? m[1] : 'unknown'); }
      });
    });
    result.installed = true; result.version = version;
  } catch { result.errorDetail = 'rclone chưa được cài đặt'; return result; }

  try {
    const remotes = await new Promise((resolve, reject) => {
      exec('rclone listremotes', (err, stdout) => { if (err) reject(err); else resolve(stdout); });
    });
    const list = remotes.split('\n').map(r => r.trim()).filter(Boolean);
    result.remoteExists = list.includes('drive:');
    if (!result.remoteExists) {
      result.errorDetail = `Remote "drive" chưa tồn tại. Hiện có: ${list.length > 0 ? list.join(', ') : '(trống)'}`;
      return result;
    }
  } catch (err) { result.errorDetail = `Lỗi: ${err.message}`; return result; }

  try {
    await new Promise((resolve, reject) => {
      exec('rclone about drive:', { timeout: 30000 }, (err, stdout) => { if (err) reject(err); else resolve(stdout); });
    });
    result.connectionOk = true;
  } catch { result.errorDetail = 'Kết nối Google Drive thất bại. Token có thể đã hết hạn.'; }
  return result;
});

ipcMain.handle('create-drive-remote', async () => {
  return new Promise((resolve) => {
    const child = spawn('rclone', ['config', 'create', 'drive', 'drive'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('config-output', d.toString()); });
    child.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('config-output', d.toString()); });
    child.on('close', (code) => resolve(code === 0 ? { success: true, message: 'Remote "drive" đã tạo thành công!' } : { success: false, message: `Lỗi: ${err || out}` }));
    child.on('error', (e) => resolve({ success: false, message: e.message }));
  });
});

ipcMain.handle('reconfigure-drive-remote', async () => {
  await new Promise((r) => exec('rclone config delete drive', () => r()));
  return new Promise((resolve) => {
    const child = spawn('rclone', ['config', 'create', 'drive', 'drive'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('config-output', d.toString()); });
    child.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('config-output', d.toString()); });
    child.on('close', (code) => resolve(code === 0 ? { success: true, message: 'Đã cấu hình lại thành công!' } : { success: false, message: `Lỗi: ${err || out}` }));
    child.on('error', (e) => resolve({ success: false, message: e.message }));
  });
});

ipcMain.handle('reconnect-drive-remote', async () => {
  return new Promise((resolve) => {
    const child = spawn('rclone', ['config', 'reconnect', 'drive:'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; mainWindow?.webContents.send('config-output', d.toString()); });
    child.stderr.on('data', (d) => { err += d; mainWindow?.webContents.send('config-output', d.toString()); });
    child.on('close', (code) => resolve(code === 0 ? { success: true, message: 'Đã kết nối lại thành công!' } : { success: false, message: `Lỗi: ${err || out}` }));
    child.on('error', (e) => resolve({ success: false, message: e.message }));
  });
});

ipcMain.handle('open-url', (_, url) => shell.openExternal(url));

ipcMain.handle('check-folder-access', async (_, folderId) => {
  try {
    await new Promise((resolve, reject) => {
      exec(`rclone lsf "drive:" --drive-root-folder-id="${folderId}" --max-depth 1`, { timeout: 15000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
    return { hasAccess: true };
  } catch {
    return { hasAccess: false, error: 'Không có quyền truy cập folder này hoặc folder không tồn tại.' };
  }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Chọn folder theo dõi' });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('validate-drive-link', (_, url) => extractFolderId(url));

// ─── IPC: Monitoring ─────────────────────────────────────
ipcMain.handle('start-monitoring', (_, config) => {
  if (isMonitoring) return { success: false, message: 'Đang theo dõi rồi' };

  currentConfig = config;
  isMonitoring = true;
  lastNewFileTime = Date.now();

  // Init logger and read previous stats
  sessionLogger.init(config.folderPath);
  const prevUploaded = sessionLogger.getCumulativeUploadedCount();
  const localCount = countLocalFiles(config.folderPath);

  stats = {
    total: localCount,
    cumulativeUploaded: prevUploaded,
    sessionUploaded: 0,
    remaining: Math.max(0, localCount - prevUploaded),
  };

  sessionLogger.startSession(config);

  sendStatus('running');
  sendLog('▶ Bắt đầu theo dõi');
  sendLog(`📂 Folder: ${config.folderPath}`);
  sendLog(`🔗 Drive ID: ${config.folderId}`);
  if (prevUploaded > 0) {
    sendLog(`📊 Phiên trước: đã upload ${prevUploaded}/${localCount} file`, 'info');
  }
  if (config.overwrite) sendLog('⚠️ Chế độ upload đè (overwrite) đang BẬT', 'warn');
  sendLog('📝 Log file: .appuploadanh-log.json', 'info');
  sendStats();

  scanAndUpload(config);

  pollingInterval = setInterval(() => {
    if (isMonitoring) scanAndUpload(config);
  }, POLL_INTERVAL_MS);

  if (config.autoSleep && config.sleepMinutes > 0) {
    sendLog(`😴 Auto-sleep: ${config.sleepMinutes} phút sau khi xong`, 'info');
    startSleepTimer(config.sleepMinutes);
  }

  return { success: true };
});

ipcMain.handle('stop-monitoring', () => {
  stopMonitoring();
  sendLog('⏹ Dừng theo dõi');
  return { success: true };
});

ipcMain.handle('cancel-upload', () => {
  if (currentUploadProcess) {
    currentUploadProcess.kill('SIGTERM');
    currentUploadProcess = null;
    scanLock = false;
    sendLog('🛑 Đã huỷ upload đang chạy', 'warn');
  }
  return { success: true };
});

ipcMain.handle('upload-now', () => {
  if (!currentConfig) return { success: false, message: 'Chưa có phiên theo dõi' };
  sendLog('⬆ Upload thủ công');
  scanAndUpload(currentConfig);
  return { success: true };
});
