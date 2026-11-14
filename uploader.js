// ═══════════════════════════════════════════
// Snappy Drive — Upload engine
// Theo dõi folder, upload từng file ngay khi export xong (file ổn định),
// tự thử lại, đối chiếu với Drive khi hết file mới và báo hoàn thành.
// Không phụ thuộc Electron để có thể test bằng Node thuần.
// ═══════════════════════════════════════════

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOG_JSON = 'appuploadanh-log.json';
const TEXT_LOG_DIR = 'upload-logs';
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', LOG_JSON]);
const RETRY_DELAYS_MS = [5000, 15000, 45000];
const MAX_SESSIONS_KEPT = 100;
const MAX_ERRORS_PER_SESSION = 50;

// ─── Local files ─────────────────────────────────────────
function isEligibleName(name, startFromName) {
  if (IGNORED_NAMES.has(name) || name.startsWith('.')) return false;
  if (startFromName && name.toLowerCase() < startFromName.toLowerCase()) return false;
  return true;
}

// Chỉ lấy file ở cấp trên cùng (không đi vào thư mục con như upload-logs/)
function listLocalFiles(folderPath, startFromName = '') {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(folderPath); } catch { return out; }
  for (const name of names) {
    if (!isEligibleName(name, startFromName)) continue;
    try {
      const st = fs.statSync(path.join(folderPath, name));
      if (st.isFile()) out.push({ name, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    } catch { /* file vừa bị xoá/đổi tên */ }
  }
  return out;
}

// ─── Persistent upload log (appuploadanh-log.json trong folder) ──
class UploadLog {
  constructor(folderPath) {
    this.folderPath = folderPath;
    this.filePath = path.join(folderPath, LOG_JSON);
    this.data = UploadLog.load(this.filePath);
    this.session = null;
    this.saveTimer = null;
  }

  static load(filePath) {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* chưa có hoặc hỏng */ }
    if (!raw || typeof raw !== 'object') return { version: 2, uploadedFiles: {}, sessions: [] };

    const uploadedFiles = raw.uploadedFiles && typeof raw.uploadedFiles === 'object' ? raw.uploadedFiles : {};
    const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];

    // Định dạng cũ: dựng lại danh sách đã upload từ các lần quét
    if (Object.keys(uploadedFiles).length === 0) {
      for (const s of sessions) {
        for (const scan of s.scans || []) {
          for (const f of scan.files || []) {
            if (f.status === 'uploaded' || f.status === 'replaced') {
              uploadedFiles[f.name] = { size: f.size ?? null, uploadedAt: f.uploadedAt || s.startTime };
            }
          }
        }
      }
    }

    // Bỏ mảng "scans" khổng lồ của định dạng cũ, chỉ giữ tóm tắt phiên
    const slim = sessions.map((s) => ({
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime ?? null,
      driveFolderId: s.driveFolderId,
      filesUploaded: s.filesUploaded || 0,
      filesFailed: s.filesFailed || 0,
      totalBytesUploaded: s.totalBytesUploaded || 0,
      errors: (s.errors || []).slice(-MAX_ERRORS_PER_SESSION),
    }));

    return { version: 2, uploadedFiles, sessions: slim.slice(-MAX_SESSIONS_KEPT) };
  }

  // File local đã được upload đúng phiên bản hiện tại chưa?
  matches(file) {
    const r = this.data.uploadedFiles[file.name];
    if (!r) return false;
    if (r.size != null && r.size !== file.size) return false;
    if (r.mtimeMs != null && Math.abs(r.mtimeMs - file.mtimeMs) > 1000) return false;
    return true;
  }

  hasRecord(name) { return !!this.data.uploadedFiles[name]; }
  getRecord(name) { return this.data.uploadedFiles[name]; }

  markUploaded(file, { skippedExisting = false } = {}) {
    this.data.uploadedFiles[file.name] = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      uploadedAt: new Date().toISOString(),
      ...(skippedExisting ? { skippedExisting: true } : {}),
    };
    if (this.session && !skippedExisting) {
      this.session.filesUploaded++;
      this.session.totalBytesUploaded += file.size || 0;
    }
    this.scheduleSave();
  }

  // Ép upload lại (ví dụ đối chiếu thấy Drive thiếu/khác)
  invalidate(name, { keepRecord = false } = {}) {
    if (keepRecord && this.data.uploadedFiles[name]) {
      this.data.uploadedFiles[name].size = -1; // giữ record → upload ở chế độ thay thế
    } else {
      delete this.data.uploadedFiles[name];
    }
    this.scheduleSave();
  }

  logError(name, message) {
    if (!this.session) return;
    this.session.filesFailed++;
    this.session.errors.push({ timestamp: new Date().toISOString(), file: name, message });
    if (this.session.errors.length > MAX_ERRORS_PER_SESSION) this.session.errors.shift();
    this.scheduleSave();
  }

  startSession(config) {
    this.session = {
      id: `session_${Date.now()}`,
      startTime: new Date().toISOString(),
      endTime: null,
      driveFolderId: config.folderId,
      filesUploaded: 0,
      filesFailed: 0,
      totalBytesUploaded: 0,
      errors: [],
    };
    this.data.sessions.push(this.session);
    if (this.data.sessions.length > MAX_SESSIONS_KEPT) this.data.sessions.shift();
    this.scheduleSave();
  }

  endSession() {
    if (this.session) this.session.endTime = new Date().toISOString();
    this.session = null;
    this.flush();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 1500);
  }

  // Ghi atomic: ghi file tạm (tên bắt đầu bằng "." nên không bị upload) rồi rename
  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const tmp = path.join(this.folderPath, `.${LOG_JSON}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* folder có thể đã bị rút ổ */ }
  }

  // Danh sách file + trạng thái (đã lên Drive hay chưa) khi chưa chạy
  static listWithStatus(folderPath, startFromName = '') {
    const fake = { data: UploadLog.load(path.join(folderPath, LOG_JSON)) };
    return listLocalFiles(folderPath, startFromName).map((f) => {
      const done = UploadLog.prototype.matches.call(fake, f);
      const rec = done ? fake.data.uploadedFiles[f.name] : null;
      return { name: f.name, size: f.size, mtimeMs: f.mtimeMs, status: done ? 'done' : 'pending', at: rec ? rec.uploadedAt : null };
    });
  }

  // Tóm tắt cho màn hình chọn folder (không ghi gì)
  static summarize(folderPath, startFromName = '') {
    const filePath = path.join(folderPath, LOG_JSON);
    const hasLog = fs.existsSync(filePath);
    const fake = { data: UploadLog.load(filePath) };
    const files = listLocalFiles(folderPath, startFromName);
    const uploaded = files.filter((f) => UploadLog.prototype.matches.call(fake, f)).length;
    return {
      hasLog,
      localCount: files.length,
      cumulativeUploaded: uploaded,
      remaining: files.length - uploaded,
      totalSessions: fake.data.sessions.length,
    };
  }
}

// ─── Uploader ────────────────────────────────────────────
class Uploader extends EventEmitter {
  /**
   * @param {object} opts
   *  folderPath, folderId, overwrite, startFromName, expectedTotal
   *  rclone (đường dẫn binary), env, remote ('drive:'), remoteArgs (mặc định --drive-root-folder-id)
   *  concurrency, scanIntervalMs, stableMs, doneIdleMs
   */
  constructor(opts) {
    super();
    this.opts = {
      rclone: 'rclone',
      env: process.env,
      remote: 'drive:',
      remoteArgs: null,
      concurrency: 4,
      scanIntervalMs: 3000,
      stableMs: 3000,
      doneIdleMs: 60000,
      overwrite: false,
      startFromName: '',
      expectedTotal: 0,
      ...opts,
    };
    if (!this.opts.remoteArgs) this.opts.remoteArgs = ['--drive-root-folder-id', this.opts.folderId];

    this.log = new UploadLog(this.opts.folderPath);
    this.seen = new Map();       // name -> {size, mtimeMs} lần quét trước (để biết file đã ổn định)
    this.queue = [];
    this.queued = new Set();
    this.active = new Map();     // name -> child process
    this.attempts = new Map();
    this.retryAt = new Map();
    this.failed = new Set();     // đã thử hết số lần
    this.conflicts = new Set();  // trên Drive có file cùng tên khác nội dung, không đè
    this.localFiles = [];
    this.pendingUnstable = 0;
    this.unstable = new Set();   // file đang được export (chưa ổn định)
    this.paused = false;
    this.filesTimer = null;

    this.sessionUploaded = 0;
    this.uploadTimes = [];
    this.lastActivity = Date.now();
    this.doneNotified = false;
    this.verifying = false;
    this.scanning = false;
    this.stopping = false;
    this.finished = false;
    this.scanTimer = null;
  }

  get driveLink() { return `https://drive.google.com/drive/folders/${this.opts.folderId}`; }

  // ── lifecycle ──
  start() {
    this.log.startSession(this.opts);
    this.scanning = true;
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), this.opts.scanIntervalMs);
  }

  // Dừng quét: file đang upload vẫn chạy nốt và được ghi log
  stop() {
    if (this.finished) return;
    this.scanning = false;
    this.stopping = true;
    clearInterval(this.scanTimer);
    this.queue = [];
    this.queued.clear();
    this.retryAt.clear();
    if (this.active.size === 0) this._finish();
    else this.emitLog(`⏳ Chờ ${this.active.size} file đang upload chạy xong...`, 'info');
    this.emitStats();
  }

  // Huỷ ngay: kill toàn bộ rclone đang chạy
  cancel() {
    if (this.finished) return;
    this.scanning = false;
    this.stopping = true;
    this.cancelled = true;
    clearInterval(this.scanTimer);
    this.queue = [];
    this.queued.clear();
    for (const child of this.active.values()) { try { child.kill('SIGTERM'); } catch { /* đã thoát */ } }
    this.active.clear();
    this._finish();
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.log.endSession();
    this.emitStats();
    this.emit('stopped');
  }

  isBusy() { return this.active.size > 0 || this.queue.length > 0; }

  // Người dùng bấm "Kiểm tra & upload ngay": thử lại file lỗi ngay và đối chiếu sớm
  forceCheck() {
    if (!this.scanning) return;
    this.retryAt.clear();
    this.attempts.clear();
    this.failed.clear();
    this.doneNotified = false;
    this.forceVerify = true;
    this.scan();
  }

  // Tạm dừng: không bắt đầu file mới, file đang lên vẫn chạy nốt
  pause() {
    if (!this.scanning || this.paused) return;
    this.paused = true;
    this.emitLog('⏸ Tạm dừng — các file đang upload sẽ chạy nốt', 'warn');
    this.emitStats();
  }

  resume() {
    if (!this.scanning || !this.paused) return;
    this.paused = false;
    this.emitLog('▶ Tiếp tục upload', 'info');
    this.scan();
  }

  // ── scan ──
  scan() {
    if (!this.scanning) return;
    if (!fs.existsSync(this.opts.folderPath)) {
      this.emitLog('❌ Folder theo dõi không còn tồn tại (ổ cứng bị rút?)', 'error');
      return;
    }
    const now = Date.now();
    const files = listLocalFiles(this.opts.folderPath, this.opts.startFromName);
    const present = new Set();
    const unstable = new Set();

    for (const f of files) {
      present.add(f.name);
      const prev = this.seen.get(f.name);
      const changed = !prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs;
      this.seen.set(f.name, { size: f.size, mtimeMs: f.mtimeMs });

      if (this.log.matches(f)) continue;
      if (changed) { this.lastActivity = now; this.doneNotified = false; }
      if (this.active.has(f.name) || this.queued.has(f.name)) continue;
      if (this.failed.has(f.name) || this.conflicts.has(f.name)) continue;
      if ((this.retryAt.get(f.name) || 0) > now) continue;

      // Ổn định = không đổi kể từ lần quét trước và đã "nguội" vài giây.
      // File cũ (sửa từ >30s trước) coi là ổn định ngay ở lần quét đầu.
      const age = now - f.mtimeMs;
      const stable = age >= this.opts.stableMs && (prev ? !changed : age > 30000);
      if (!stable) { unstable.add(f.name); continue; }

      this.retryAt.delete(f.name);
      this.queue.push(f.name);
      this.queued.add(f.name);
    }
    for (const name of this.seen.keys()) if (!present.has(name)) this.seen.delete(name);

    this.localFiles = files;
    this.unstable = unstable;
    this.pendingUnstable = unstable.size;
    this.pump();
    this.emitStats();
    this.checkDone();
  }

  // ── upload ──
  pump() {
    while (!this.stopping && !this.paused && this.active.size < this.opts.concurrency && this.queue.length) {
      const name = this.queue.shift();
      this.queued.delete(name);
      this.uploadOne(name);
    }
  }

  uploadOne(name) {
    const localPath = path.join(this.opts.folderPath, name);
    let file;
    try {
      const st = fs.statSync(localPath);
      file = { name, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    } catch { return; }

    const replace = this.opts.overwrite || this.log.hasRecord(name);
    const args = [
      'copyto', localPath, this.opts.remote + name,
      ...this.opts.remoteArgs,
      '-v', '--stats', '0',
      '--retries', '1', '--low-level-retries', '5',
      '--drive-chunk-size', '32M',
    ];
    if (!replace) args.push('--ignore-existing');

    const child = spawn(this.opts.rclone, args, { env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.active.set(name, child);
    this.emitStats();

    let output = '';
    const collect = (d) => { output = (output + d.toString()).slice(-8000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    const done = (code, spawnError) => {
      if (settled) return;
      settled = true;
      if (this.active.get(name) === child) this.active.delete(name);
      if (this.cancelled) return;

      if (code === 0) {
        const copied = /:\s+Copied \(/.test(output);
        this.log.markUploaded(file, { skippedExisting: !copied });
        this.attempts.delete(name);
        this.retryAt.delete(name);
        this.lastActivity = Date.now();
        if (copied) {
          this.sessionUploaded++;
          this.uploadTimes.push(Date.now());
          if (this.uploadTimes.length > 200) this.uploadTimes.shift();
          const replaced = /Copied \(replaced/.test(output);
          this.emitLog(`✅ ${name}${replaced ? ' — đã thay bản trên Drive' : ''}`, 'success');
        } else {
          this.emitLog(`↷ ${name} — đã có trên Drive, bỏ qua`, 'info');
        }
      } else {
        const errLine = spawnError
          ? (spawnError.code === 'ENOENT' ? 'không tìm thấy rclone' : spawnError.message)
          : (output.split('\n').filter((l) => /ERROR|Failed/.test(l)).pop() || `rclone thoát với mã ${code}`)
              .replace(/^.*?(ERROR|NOTICE)\s*:\s*/, '').trim();
        const n = (this.attempts.get(name) || 0) + 1;
        this.attempts.set(name, n);
        if (n > RETRY_DELAYS_MS.length) {
          this.failed.add(name);
          this.log.logError(name, errLine);
          this.emitLog(`❌ ${name}: ${errLine} — đã thử ${n} lần, sẽ thử lại khi đối chiếu`, 'error');
        } else {
          const delay = RETRY_DELAYS_MS[n - 1];
          this.retryAt.set(name, Date.now() + delay);
          this.emitLog(`⚠️ ${name}: ${errLine} — thử lại sau ${delay / 1000}s (lần ${n}/${RETRY_DELAYS_MS.length})`, 'warn');
        }
      }

      if (this.stopping && this.active.size === 0) { this._finish(); return; }
      this.pump();
      this.emitStats();
      this.checkDone();
    };

    child.on('close', (code) => done(code));
    child.on('error', (err) => done(-1, err));
  }

  // ── done detection & verification ──
  hasPendingRetries() {
    for (const name of this.retryAt.keys()) if (!this.failed.has(name)) return true;
    return false;
  }

  checkDone() {
    if (!this.scanning || this.paused || this.verifying || this.doneNotified) return;
    if (this.queue.length || this.active.size || this.pendingUnstable || this.hasPendingRetries()) return;
    if (!this.forceVerify && Date.now() - this.lastActivity < this.opts.doneIdleMs) return;
    this.forceVerify = false;
    this.verify();
  }

  listRemote() {
    return new Promise((resolve, reject) => {
      const args = ['lsjson', this.opts.remote, ...this.opts.remoteArgs, '--files-only', '--no-mimetype', '--no-modtime'];
      const child = spawn(this.opts.rclone, args, { env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('quá thời gian 120s')); }, 120000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `mã ${code}`));
        try {
          const map = new Map();
          for (const item of JSON.parse(out || '[]')) map.set(item.Name, item.Size);
          resolve(map);
        } catch (e) { reject(e); }
      });
    });
  }

  async verify() {
    this.verifying = true;
    this.emitStats();
    this.emitLog('🔎 Không còn file mới — đang đối chiếu với Drive...', 'info');
    let remote;
    try {
      remote = await this.listRemote();
    } catch (e) {
      this.verifying = false;
      this.lastActivity = Date.now(); // thử đối chiếu lại sau một chu kỳ chờ nữa
      this.emitLog(`⚠️ Không đối chiếu được với Drive: ${e.message}`, 'warn');
      this.emitStats();
      return;
    }
    if (!this.scanning) { this.verifying = false; return; }

    const files = listLocalFiles(this.opts.folderPath, this.opts.startFromName);
    const toRetry = [];
    for (const f of files) {
      if (this.active.has(f.name) || this.queued.has(f.name)) continue;
      const remoteSize = remote.get(f.name);
      if (remoteSize === undefined) {
        this.log.invalidate(f.name);
        toRetry.push(f.name);
      } else if (remoteSize >= 0 && remoteSize !== f.size) {
        const rec = this.log.getRecord(f.name);
        const ours = rec && !rec.skippedExisting;
        if (ours || this.opts.overwrite) {
          this.log.invalidate(f.name, { keepRecord: true });
          toRetry.push(f.name);
        } else if (!this.conflicts.has(f.name)) {
          this.conflicts.add(f.name);
          this.emitLog(`⚠️ ${f.name}: trên Drive đã có file cùng tên nhưng khác dung lượng — bật "Upload đè" nếu muốn thay`, 'warn');
        }
      } else if (!this.log.matches(f)) {
        // Có trên Drive đúng dung lượng nhưng log chưa ghi (ví dụ upload bằng tay trước đó)
        this.log.markUploaded(f, { skippedExisting: true });
      }
    }
    for (const name of toRetry) { this.failed.delete(name); this.attempts.delete(name); this.retryAt.delete(name); }

    this.verifying = false;
    if (toRetry.length) {
      const preview = toRetry.slice(0, 5).join(', ') + (toRetry.length > 5 ? ', ...' : '');
      this.emitLog(`🔁 Drive thiếu/khác ${toRetry.length} file (${preview}) — đang upload lại`, 'warn');
      this.lastActivity = Date.now();
      this.scan();
      return;
    }

    this.doneNotified = true;
    const total = files.length;
    const summary = {
      total,
      onDrive: total - this.conflicts.size,
      sessionUploaded: this.sessionUploaded,
      conflicts: this.conflicts.size,
      link: this.driveLink,
    };
    const extra = this.conflicts.size ? ` (${this.conflicts.size} file trùng tên không đè)` : '';
    this.emitLog(`🎉 Đã đủ ${summary.onDrive}/${total} file trên Drive${extra}`, 'success');
    this.emitStats();
    this.emit('done', summary);
  }

  // ── stats ──
  phase() {
    if (this.finished) return 'stopped';
    if (this.stopping) return 'stopping';
    if (this.paused) return 'paused';
    if (this.verifying) return 'verifying';
    if (this.active.size || this.queue.length) return 'uploading';
    if (this.doneNotified) return 'done';
    return 'waiting';
  }

  getStats() {
    const total = this.localFiles.length;
    const uploaded = this.localFiles.filter((f) => this.log.matches(f)).length;
    const expected = this.opts.expectedTotal > 0 ? this.opts.expectedTotal : 0;
    const target = Math.max(expected, total);

    // Tốc độ dựa trên các file upload xong trong 3 phút gần nhất
    const now = Date.now();
    const recent = this.uploadTimes.filter((t) => now - t < 180000);
    let etaSec = null;
    if (recent.length >= 3) {
      const span = Math.max(1, (now - recent[0]) / 1000);
      const perSec = recent.length / span;
      etaSec = Math.round((target - uploaded) / perSec);
    }

    return {
      phase: this.phase(),
      total,
      cumulativeUploaded: uploaded,
      sessionUploaded: this.sessionUploaded,
      remaining: Math.max(0, total - uploaded),
      expected,
      target,
      active: [...this.active.keys()],
      queued: this.queue.length,
      waitingExport: this.pendingUnstable,
      retrying: [...this.retryAt.keys()].filter((n) => !this.failed.has(n)).length,
      failed: this.failed.size,
      conflicts: this.conflicts.size,
      etaSec: target > uploaded ? etaSec : null,
      link: this.driveLink,
    };
  }

  getFileList() {
    return this.localFiles.map((f) => {
      let status;
      if (this.active.has(f.name)) status = 'uploading';
      else if (this.log.matches(f)) status = 'done';
      else if (this.conflicts.has(f.name)) status = 'conflict';
      else if (this.failed.has(f.name)) status = 'failed';
      else if (this.retryAt.has(f.name)) status = 'retry';
      else if (this.unstable.has(f.name)) status = 'exporting';
      else status = 'queued';
      const rec = status === 'done' ? this.log.getRecord(f.name) : null;
      return { name: f.name, size: f.size, mtimeMs: f.mtimeMs, status, at: rec ? rec.uploadedAt : null };
    });
  }

  emitStats() {
    this.emit('stats', this.getStats());
    if (!this.filesTimer) {
      this.filesTimer = setTimeout(() => { this.filesTimer = null; this.emit('files', this.getFileList()); }, 250);
    }
  }
  emitLog(message, type = 'info') { this.emit('log', message, type); }
}

module.exports = { Uploader, UploadLog, listLocalFiles, LOG_JSON, TEXT_LOG_DIR };
