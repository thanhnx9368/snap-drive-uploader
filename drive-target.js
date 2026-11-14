// ═══════════════════════════════════════════
// Tìm hoặc tạo thư mục đích trên Drive theo đường dẫn: [Năm, T{tháng}, "dd/mm Tên khách"]
// bên trong thư mục gốc. Trả về ID của thư mục cuối cùng.
// ═══════════════════════════════════════════

// Google Drive cho phép "/" trong tên thư mục. rclone hiển thị ký tự đó thành "／" (U+FF0F)
// vì "/" là dấu phân cách đường dẫn.
const FULLWIDTH_SLASH = '／';

function cleanSegment(s) {
  return String(s || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
}
const toRclone = (s) => s.replace(/\//g, FULLWIDTH_SLASH);
const sameName = (rcloneName, wanted) => rcloneName === toRclone(wanted) || rcloneName === wanted;

// Đường dẫn theo tháng: ["2026", "T11", "14/11 Thôi nôi Bảo An"]
function monthPath(isoDate, title) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return null;
  const [, y, mo, d] = m;
  const name = cleanSegment(title);
  return [y, `T${Number(mo)}`, name ? `${d}/${mo} ${name}` : `${d}/${mo}`];
}

// Bỏ ngày ở đầu tên folder local, VD "14/11 Bảo An", "14.11 Bảo An", "1411 Bảo An" → "Bảo An"
function stripLeadingDate(name) {
  return cleanSegment(String(name || '').replace(/^\s*\d{1,2}\s*[./\-_]\s*\d{1,2}(\s*[./\-_]\s*\d{2,4})?[\s\-_]+/, ''));
}

/**
 * @param {(args:string[]) => Promise<string>} run  chạy rclone, trả về stdout
 * @param {string} rootId
 * @param {string[]} segments
 */
async function resolveTarget(run, rootId, segments) {
  const segs = segments.map(cleanSegment);
  if (!segs.length || segs.some((s) => !s)) throw new Error('Tên thư mục không hợp lệ');
  const base = ['--drive-root-folder-id', rootId];
  const parent = segs.slice(0, -1).map(toRclone).join('/');
  const last = segs[segs.length - 1];

  const find = async () => {
    let out;
    try {
      out = await run(['lsjson', `drive:${parent}`, ...base, '--dirs-only', '--no-modtime', '--no-mimetype']);
    } catch {
      return null; // thư mục cha chưa tồn tại
    }
    const item = JSON.parse(out || '[]').find((i) => sameName(i.Name, last));
    return item ? item.ID || null : null;
  };

  let folderId = await find();
  let created = false;
  if (!folderId) {
    await run(['mkdir', `drive:${segs.map(toRclone).join('/')}`, ...base]);
    folderId = await find();
    created = true;
  }
  if (!folderId) throw new Error('Không lấy được ID thư mục vừa tạo');
  return { folderId, created, path: segs };
}

module.exports = { resolveTarget, monthPath, stripLeadingDate, cleanSegment, FULLWIDTH_SLASH };
