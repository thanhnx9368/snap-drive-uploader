const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Setup
  checkRcloneFull: () => ipcRenderer.invoke('check-rclone-full'),
  createDriveRemote: () => ipcRenderer.invoke('create-drive-remote'),
  reconfigureDriveRemote: () => ipcRenderer.invoke('reconfigure-drive-remote'),
  reconnectDriveRemote: () => ipcRenderer.invoke('reconnect-drive-remote'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  checkFolderAccess: (folderId) => ipcRenderer.invoke('check-folder-access', folderId),

  // Folder & Drive
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  validateDriveLink: (url) => ipcRenderer.invoke('validate-drive-link', url),
  readFolderLog: (folderPath) => ipcRenderer.invoke('read-folder-log', folderPath),

  // Monitoring
  startMonitoring: (config) => ipcRenderer.invoke('start-monitoring', config),
  stopMonitoring: () => ipcRenderer.invoke('stop-monitoring'),
  cancelUpload: () => ipcRenderer.invoke('cancel-upload'),
  uploadNow: () => ipcRenderer.invoke('upload-now'),

  // Events
  onLog: (callback) => ipcRenderer.on('log', (_, data) => callback(data)),
  onStatsUpdate: (callback) => ipcRenderer.on('stats-update', (_, data) => callback(data)),
  onStatusChange: (callback) => ipcRenderer.on('status-change', (_, data) => callback(data)),
  onConfigOutput: (callback) => ipcRenderer.on('config-output', (_, data) => callback(data)),
});
