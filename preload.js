const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Setup
  checkRcloneFull: () => ipcRenderer.invoke('check-rclone-full'),
  createDriveRemote: () => ipcRenderer.invoke('create-drive-remote'),
  reconfigureDriveRemote: () => ipcRenderer.invoke('reconfigure-drive-remote'),
  reconnectDriveRemote: () => ipcRenderer.invoke('reconnect-drive-remote'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  checkFolderAccess: (folderId) => ipcRenderer.invoke('check-folder-access', folderId),

  // Settings & history
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  removeHistory: (id) => ipcRenderer.invoke('remove-history', id),

  // Folder & Drive
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  validateFolder: (folderPath) => ipcRenderer.invoke('validate-folder', folderPath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  validateDriveLink: (url) => ipcRenderer.invoke('validate-drive-link', url),
  resolveDriveTarget: (rootId, segments) => ipcRenderer.invoke('resolve-drive-target', rootId, segments),
  readShootDate: (folderPath) => ipcRenderer.invoke('read-shoot-date', folderPath),
  readFolderLog: (folderPath, startFromName) => ipcRenderer.invoke('read-folder-log', folderPath, startFromName),
  listFolder: (folderPath, startFromName) => ipcRenderer.invoke('list-folder', folderPath, startFromName),
  showInFinder: (filePath) => ipcRenderer.invoke('show-in-finder', filePath),
  publicLink: (historyId) => ipcRenderer.invoke('public-link', historyId),

  // Monitoring
  getState: () => ipcRenderer.invoke('get-state'),
  startMonitoring: (config) => ipcRenderer.invoke('start-monitoring', config),
  stopMonitoring: () => ipcRenderer.invoke('stop-monitoring'),
  cancelUpload: () => ipcRenderer.invoke('cancel-upload'),
  pauseUpload: () => ipcRenderer.invoke('pause-upload'),
  resumeUpload: () => ipcRenderer.invoke('resume-upload'),
  uploadNow: () => ipcRenderer.invoke('upload-now'),

  // Events
  onLog: (callback) => ipcRenderer.on('log', (_, data) => callback(data)),
  onStatsUpdate: (callback) => ipcRenderer.on('stats-update', (_, data) => callback(data)),
  onFilesUpdate: (callback) => ipcRenderer.on('files-update', (_, data) => callback(data)),
  onHistoryUpdate: (callback) => ipcRenderer.on('history-update', (_, data) => callback(data)),
  onStatusChange: (callback) => ipcRenderer.on('status-change', (_, data) => callback(data)),
  onUploadDone: (callback) => ipcRenderer.on('upload-done', (_, data) => callback(data)),
  onConfigOutput: (callback) => ipcRenderer.on('config-output', (_, data) => callback(data)),
});
