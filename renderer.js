// ═══════════════════════════════════════════
// Snappy Drive — Renderer
// ═══════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);

// ─── DOM refs: Setup ──────────────────────
const stepSetup = $('#step-setup');
const stepUpload = $('#step-upload');
const stepInd1 = $('#step-ind-1');
const stepInd2 = $('#step-ind-2');

const checkInstalled = $('#check-installed');
const checkRemote = $('#check-remote');
const checkConnection = $('#check-connection');

const btnInstallHelp = $('#btn-install-help');
const btnCreateRemote = $('#btn-create-remote');
const btnReconnect = $('#btn-reconnect');
const btnReconfigure = $('#btn-reconfigure');

const configOutputPanel = $('#config-output-panel');
const configOutput = $('#config-output');
const btnCloseOutput = $('#btn-close-output');

const btnRecheck = $('#btn-recheck');
const btnContinue = $('#btn-continue');
const installInstructions = $('#install-instructions');
const linkRclone = $('#link-rclone');

// ─── DOM refs: Upload ─────────────────────
const btnBackSetup = $('#btn-back-setup');
const folderPathInput = $('#folder-path');
const folderLogInfo = $('#folder-log-info');
const driveLinkInput = $('#drive-link');
const driveIdDisplay = $('#drive-id-display');
const driveIdText = $('#drive-id-text');
const accessStatus = $('#access-status');
const folderError = $('#folder-error');
const driveError = $('#drive-error');
const autoRetryCheckbox = $('#auto-retry');
const overwriteCheckbox = $('#overwrite');
const autoSleepCheckbox = $('#auto-sleep');
const sleepConfig = $('#sleep-config');
const sleepMinutesSelect = $('#sleep-minutes');
const statusBadge = $('#status-badge');
const statusText = $('#status-text');

const btnSelectFolder = $('#btn-select-folder');
const btnStart = $('#btn-start');
const btnStop = $('#btn-stop');
const btnCancel = $('#btn-cancel');
const btnUploadNow = $('#btn-upload-now');
const btnClearLogs = $('#btn-clear-logs');
const btnReset = $('#btn-reset');

const statTotal = $('#stat-total');
const statCumulative = $('#stat-cumulative');
const statSession = $('#stat-session');
const statRemaining = $('#stat-remaining');
const logContainer = $('#log-container');

// ─── State ────────────────────────────────
let selectedFolder = '';
let extractedFolderId = '';
let isRunning = false;
let folderAccessVerified = false;

// ─── Reset all state ──────────────────────
function resetAll() {
  // Clear logs
  logContainer.innerHTML = '<div class="log-empty">Chờ hoạt động...</div>';

  // Reset stats
  statTotal.textContent = '0';
  statCumulative.textContent = '0';
  statSession.textContent = '0';
  statRemaining.textContent = '0';

  // Clear drive link
  driveLinkInput.value = '';
  extractedFolderId = '';
  driveIdDisplay.classList.add('hidden');
  driveError.classList.add('hidden');
  accessStatus.classList.add('hidden');
  folderAccessVerified = false;

  // Clear folder log info
  folderLogInfo.innerHTML = '';
  folderLogInfo.classList.add('hidden');
  folderError.classList.add('hidden');
}

// ═══════════════════════════════════════════
// STEP 1: Setup
// ═══════════════════════════════════════════

function setCheckState(el, state, detail) {
  const iconEl = el.querySelector('.check-icon');
  const detailEl = el.querySelector('.check-detail');
  if (state === 'loading') {
    iconEl.innerHTML = '<span class="check-spinner"></span>';
    el.className = 'check-item checking';
  } else if (state === 'pass') {
    iconEl.innerHTML = '<span class="check-pass">✓</span>';
    el.className = 'check-item passed';
  } else if (state === 'fail') {
    iconEl.innerHTML = '<span class="check-fail">✗</span>';
    el.className = 'check-item failed';
  } else {
    iconEl.innerHTML = '<span class="check-pending">○</span>';
    el.className = 'check-item';
  }
  if (detail) detailEl.textContent = detail;
}

function hideAllActionButtons() {
  btnInstallHelp.classList.add('hidden');
  btnCreateRemote.classList.add('hidden');
  btnReconnect.classList.add('hidden');
  btnReconfigure.classList.add('hidden');
}

async function runSetupChecks() {
  btnRecheck.disabled = true;
  btnContinue.disabled = true;
  installInstructions.classList.add('hidden');
  hideAllActionButtons();

  setCheckState(checkInstalled, 'loading', 'Đang kiểm tra...');
  setCheckState(checkRemote, 'pending', 'Chờ...');
  setCheckState(checkConnection, 'pending', 'Chờ...');

  const result = await window.api.checkRcloneFull();

  if (result.installed) {
    setCheckState(checkInstalled, 'pass', `rclone v${result.version}`);
  } else {
    setCheckState(checkInstalled, 'fail', 'rclone chưa cài đặt');
    btnInstallHelp.classList.remove('hidden');
    installInstructions.classList.remove('hidden');
    btnRecheck.disabled = false;
    return;
  }

  await sleep(300);
  setCheckState(checkRemote, 'loading', 'Đang kiểm tra remote...');
  await sleep(200);

  if (result.remoteExists) {
    setCheckState(checkRemote, 'pass', 'Remote "drive" đã cấu hình ✓');
  } else {
    setCheckState(checkRemote, 'fail', result.errorDetail || 'Remote "drive" chưa tồn tại');
    btnCreateRemote.classList.remove('hidden');
    btnRecheck.disabled = false;
    return;
  }

  await sleep(300);
  setCheckState(checkConnection, 'loading', 'Đang kết nối Google Drive...');
  await sleep(200);

  if (result.connectionOk) {
    setCheckState(checkConnection, 'pass', 'Kết nối thành công ✓');
  } else {
    setCheckState(checkConnection, 'fail', result.errorDetail || 'Kết nối thất bại');
    btnReconnect.classList.remove('hidden');
    btnRecheck.disabled = false;
    return;
  }

  btnContinue.disabled = false;
  btnRecheck.disabled = false;
  btnReconfigure.classList.remove('hidden');
}

// ─── Setup buttons ────────────────────────
btnInstallHelp.addEventListener('click', () => { installInstructions.classList.toggle('hidden'); });

btnCreateRemote.addEventListener('click', async () => {
  btnCreateRemote.disabled = true;
  btnCreateRemote.innerHTML = '<span class="check-spinner small"></span> Đang tạo...';
  configOutput.textContent = 'Đang tạo remote "drive"...\nTrình duyệt sẽ mở để đăng nhập Google.\n\n';
  configOutputPanel.classList.remove('hidden');
  const result = await window.api.createDriveRemote();
  appendConfigOutput(result.success ? '\n✅ ' + result.message : '\n❌ ' + result.message);
  if (result.success) { await sleep(1000); runSetupChecks(); }
  else { btnCreateRemote.disabled = false; btnCreateRemote.innerHTML = 'Tạo kết nối'; }
});

btnReconnect.addEventListener('click', async () => {
  btnReconnect.disabled = true;
  btnReconnect.innerHTML = '<span class="check-spinner small"></span> Đang kết nối...';
  configOutput.textContent = 'Đang kết nối lại Google Drive...\n\n';
  configOutputPanel.classList.remove('hidden');
  const result = await window.api.reconnectDriveRemote();
  appendConfigOutput(result.success ? '\n✅ ' + result.message : '\n❌ ' + result.message);
  if (result.success) { await sleep(1000); runSetupChecks(); }
  else { btnReconnect.disabled = false; btnReconnect.innerHTML = 'Kết nối lại'; }
});

btnReconfigure.addEventListener('click', async () => {
  btnReconfigure.disabled = true;
  btnReconfigure.innerHTML = '<span class="check-spinner small"></span> Đang cấu hình...';
  configOutput.textContent = 'Đang xoá cấu hình cũ và tạo lại...\nTrình duyệt sẽ mở để đăng nhập Google mới.\n\n';
  configOutputPanel.classList.remove('hidden');
  const result = await window.api.reconfigureDriveRemote();
  appendConfigOutput(result.success ? '\n✅ ' + result.message : '\n❌ ' + result.message);
  if (result.success) { await sleep(1000); runSetupChecks(); }
  else { btnReconfigure.disabled = false; btnReconfigure.innerHTML = '<span class="btn-icon">🔁</span> Đổi tài khoản Google'; }
});

btnCloseOutput.addEventListener('click', () => configOutputPanel.classList.add('hidden'));
linkRclone.addEventListener('click', (e) => { e.preventDefault(); window.api.openUrl('https://rclone.org/downloads/'); });

function appendConfigOutput(text) {
  configOutput.textContent += text;
  configOutput.scrollTop = configOutput.scrollHeight;
}
window.api.onConfigOutput((text) => appendConfigOutput(text));

btnRecheck.addEventListener('click', runSetupChecks);

btnContinue.addEventListener('click', () => {
  stepSetup.classList.add('hidden');
  stepUpload.classList.remove('hidden');
  stepInd1.classList.remove('active');
  stepInd2.classList.add('active');
});

btnBackSetup.addEventListener('click', () => {
  if (isRunning) return;
  stepUpload.classList.add('hidden');
  stepSetup.classList.remove('hidden');
  stepInd2.classList.remove('active');
  stepInd1.classList.add('active');
});

runSetupChecks();

// ═══════════════════════════════════════════
// STEP 2: Upload Workflow
// ═══════════════════════════════════════════

autoSleepCheckbox.addEventListener('change', () => {
  sleepConfig.classList.toggle('hidden', !autoSleepCheckbox.checked);
});

// ─── Folder select with log preview ───────
btnSelectFolder.addEventListener('click', async () => {
  const path = await window.api.selectFolder();
  if (path) {
    selectedFolder = path;
    folderPathInput.value = path;

    // Reset everything for the new folder
    resetAll();

    // Read log from folder to preview stats
    const logInfo = await window.api.readFolderLog(path);
    if (logInfo.hasLog) {
      folderLogInfo.innerHTML = `
        <span class="log-info-icon">📊</span>
        <span>Phiên trước: <strong>${logInfo.cumulativeUploaded}/${logInfo.localCount}</strong> file đã upload
        (${logInfo.totalSessions} phiên) — còn <strong>${logInfo.remaining}</strong> file</span>
      `;
      folderLogInfo.classList.remove('hidden');

      // Pre-fill stats preview
      statTotal.textContent = logInfo.localCount;
      statCumulative.textContent = logInfo.cumulativeUploaded;
      statRemaining.textContent = logInfo.remaining;
    } else {
      folderLogInfo.innerHTML = `
        <span class="log-info-icon">📁</span>
        <span>Folder mới — ${logInfo.localCount} file, chưa upload</span>
      `;
      folderLogInfo.classList.remove('hidden');

      statTotal.textContent = logInfo.localCount;
      statCumulative.textContent = 0;
      statRemaining.textContent = logInfo.localCount;
    }
  }
});

// ─── Drive link ───────────────────────────
let accessCheckTimeout = null;

driveLinkInput.addEventListener('input', async () => {
  const url = driveLinkInput.value.trim();
  folderAccessVerified = false;
  accessStatus.classList.add('hidden');

  if (!url) {
    driveIdDisplay.classList.add('hidden');
    driveError.classList.add('hidden');
    extractedFolderId = '';
    return;
  }

  const id = await window.api.validateDriveLink(url);
  if (id) {
    extractedFolderId = id;
    driveIdText.textContent = id;
    driveIdDisplay.classList.remove('hidden');
    driveError.classList.add('hidden');
    clearTimeout(accessCheckTimeout);
    accessCheckTimeout = setTimeout(() => checkFolderAccess(id), 600);
  } else {
    extractedFolderId = '';
    driveIdDisplay.classList.add('hidden');
    driveError.textContent = 'Link Google Drive không hợp lệ';
    driveError.classList.remove('hidden');
  }
});

async function checkFolderAccess(folderId) {
  accessStatus.innerHTML = '<span class="access-checking">🔍 Đang kiểm tra quyền truy cập...</span>';
  accessStatus.classList.remove('hidden');
  const result = await window.api.checkFolderAccess(folderId);
  if (result.hasAccess) {
    accessStatus.innerHTML = '<span class="access-ok">✓ Có quyền truy cập folder này</span>';
    folderAccessVerified = true;
  } else {
    accessStatus.innerHTML = `<span class="access-denied">✗ ${result.error}</span>`;
    folderAccessVerified = false;
  }
}

// ─── Controls ─────────────────────────────
btnStart.addEventListener('click', async () => {
  if (!selectedFolder) { folderError.textContent = 'Vui lòng chọn folder'; folderError.classList.remove('hidden'); return; }
  if (!extractedFolderId) { driveError.textContent = 'Vui lòng nhập link Google Drive hợp lệ'; driveError.classList.remove('hidden'); return; }

  if (!folderAccessVerified) {
    accessStatus.innerHTML = '<span class="access-checking">🔍 Kiểm tra quyền...</span>';
    accessStatus.classList.remove('hidden');
    const r = await window.api.checkFolderAccess(extractedFolderId);
    if (!r.hasAccess) { accessStatus.innerHTML = `<span class="access-denied">✗ ${r.error}</span>`; return; }
    accessStatus.innerHTML = '<span class="access-ok">✓ Có quyền truy cập</span>';
    folderAccessVerified = true;
  }

  const config = {
    folderPath: selectedFolder,
    folderId: extractedFolderId,
    autoRetry: autoRetryCheckbox.checked,
    overwrite: overwriteCheckbox.checked,
    autoSleep: autoSleepCheckbox.checked,
    sleepMinutes: parseInt(sleepMinutesSelect.value, 10),
  };

  const result = await window.api.startMonitoring(config);
  if (result.success) setRunningState(true);
});

btnStop.addEventListener('click', async () => {
  await window.api.stopMonitoring();
  setRunningState(false);
});

btnCancel.addEventListener('click', async () => {
  await window.api.cancelUpload();
});

btnUploadNow.addEventListener('click', async () => {
  await window.api.uploadNow();
});

btnClearLogs.addEventListener('click', () => {
  logContainer.innerHTML = '<div class="log-empty">Chờ hoạt động...</div>';
});

btnReset.addEventListener('click', () => {
  if (isRunning) return;
  selectedFolder = '';
  folderPathInput.value = '';
  resetAll();
});

function setRunningState(running) {
  isRunning = running;
  btnStart.disabled = running;
  btnStop.disabled = !running;
  btnCancel.classList.toggle('hidden', !running);
  btnUploadNow.disabled = !running;
  btnSelectFolder.disabled = running;
  driveLinkInput.disabled = running;
  btnBackSetup.disabled = running;
  btnReset.disabled = running;
  autoSleepCheckbox.disabled = running;
  sleepMinutesSelect.disabled = running;
  overwriteCheckbox.disabled = running;

  if (running) {
    statusBadge.classList.add('running');
    statusText.textContent = 'Đang chạy';
  } else {
    statusBadge.classList.remove('running');
    statusText.textContent = 'Đã dừng';
  }
}

// ─── IPC listeners ────────────────────────
window.api.onLog((data) => {
  const empty = logContainer.querySelector('.log-empty');
  if (empty) empty.remove();
  const entry = document.createElement('div');
  entry.className = `log-entry ${data.type}`;
  entry.innerHTML = `<span class="log-time">[${data.time}]</span><span class="log-msg">${escapeHtml(data.message)}</span>`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
});

window.api.onStatsUpdate((data) => {
  if (data.total !== undefined) statTotal.textContent = data.total;
  if (data.cumulativeUploaded !== undefined) statCumulative.textContent = data.cumulativeUploaded;
  if (data.sessionUploaded !== undefined) statSession.textContent = data.sessionUploaded;
  if (data.remaining !== undefined) statRemaining.textContent = data.remaining;
});

window.api.onStatusChange((status) => {
  setRunningState(status === 'running');
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
