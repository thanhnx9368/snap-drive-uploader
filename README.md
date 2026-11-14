# Snappy Drive

<p align="center"><img src="assets/icon.png" width="128" alt="Snappy Drive"></p>

App macOS tự động upload ảnh lên **Google Drive ngay trong lúc Lightroom đang export** — không phải đợi export xong rồi mới kéo cả folder lên Drive. Làm cho Snappy Photo Studio.

Chọn folder Lightroom export ra, chọn thư mục tháng trên Drive, bấm **Bắt đầu upload**. Ảnh nào export xong là được đẩy lên ngay; khi hết ảnh mới, app tự đối chiếu với Drive và báo hoàn tất để bạn gửi link cho khách.

## Tính năng

**Upload**
- Upload từng ảnh ngay khi export xong (file không đổi trong ~3 giây), 4 luồng song song
- Tự thử lại khi lỗi mạng (sau 5s, 15s, 45s); khi hết ảnh mới sẽ đối chiếu tên + dung lượng với Drive, thiếu file nào thì upload lại
- Ảnh export lại (đã sửa) tự thay bản cũ trên Drive; file trùng tên có sẵn trên Drive (không do app upload) không bị đè
- Tạm dừng / tiếp tục, Dừng (ảnh đang lên vẫn chạy nốt), Huỷ ngay
- Chạy lại folder cũ thì chỉ upload ảnh mới — app nhớ ảnh nào đã lên

**Thư mục trên Drive**
- Lưu link **thư mục tháng** (VD `T11`), tối đa 8 tháng gần nhất để chọn nhanh
- Mỗi buổi chụp tự tạo thư mục **`dd/mm Tên khách`** trong thư mục tháng; đã có thì upload tiếp vào đó
- Ngày chụp lấy từ EXIF của ảnh, tên khách lấy theo tên folder (tự bỏ ngày ở đầu)
- Cảnh báo khi ngày chụp không cùng tháng với thư mục đang chọn
- **Copy link cho khách**: bật chia sẻ *"Ai có link đều xem được"* cho thư mục khách rồi copy link

**Giao diện**
- Kéo thả folder vào app (hoặc ⌘O)
- Danh sách ảnh có thumbnail và trạng thái từng ảnh (đọc được cả RAW qua QuickLook); chuyển dạng danh sách / lưới
- Bấm vào ảnh để xem lớn — `←` `→` chuyển ảnh, `Esc` đóng
- Tab **Nhật ký** và **Lịch sử** các buổi upload (Copy link khách / Mở Drive / Upload tiếp)
- Tiến độ hiện trên thanh menu macOS và badge trên Dock; thông báo khi upload xong
- Chặn máy ngủ khi còn upload; tuỳ chọn cho máy sleep sau khi xong

## Yêu cầu

- macOS trên chip Apple (M1 trở lên)
- [rclone](https://rclone.org) đã cài và kết nối Google Drive với tên remote là **`drive`** — app có sẵn màn hình hướng dẫn kết nối

```bash
brew install rclone
```

## Cài đặt

1. Mở file `Snappy Drive-<phiên bản>-arm64.dmg`, kéo **Snappy Drive** vào **Applications**
2. Lần đầu mở: **chuột phải vào app → Mở → Mở** (app chưa ký bằng tài khoản Apple Developer nên macOS sẽ chặn nếu mở bằng double-click)
3. Nếu chưa kết nối Google Drive, app tự mở cửa sổ **Google Drive** → bấm **Kết nối** → đăng nhập Google trên trình duyệt

## Cách dùng

1. **Lần đầu mỗi tháng**: ở mục *Lưu vào Google Drive*, dán link thư mục tháng (VD `T11`), đặt tên gợi nhớ (VD `T11/2026`) → **Lưu**. Sang tháng mới bấm **Thêm** để lưu tháng mới.
2. **Mỗi buổi chụp**:
   - Kéo thả folder Lightroom export ra vào app
   - Kiểm tra *Ngày chụp* và *Tên khách* (đã điền sẵn), có thể nhập *Số ảnh dự kiến* để thấy % và thời gian còn lại
   - Bấm **Bắt đầu upload** — có thể bấm trước khi export, ảnh ra đến đâu lên đến đó
3. Export trong Lightroom như bình thường. Có thể thu nhỏ app, tiến độ hiện trên thanh menu.
4. Khi app báo **Hoàn tất**: bấm **Copy link cho khách** để gửi link xem công khai, rồi **Kết thúc** → **Buổi chụp mới**.

Kết quả trên Drive:

```
T11                         ← thư mục tháng (bạn dán link)
 ├─ 13/11 Thôi nôi Bảo An   ← app tự tạo
 └─ 14/11 Kỷ yếu Khánh Vân
```

### Tuỳ chọn nâng cao

| Tuỳ chọn | Tác dụng |
|---|---|
| Upload thẳng vào thư mục đã chọn | Không tạo thư mục khách, upload vào chính thư mục đang chọn |
| Sleep máy sau khi xong | Cho Mac ngủ sau N phút kể từ khi upload xong mà không có ảnh mới |
| Chỉ upload từ mã ảnh | Bỏ qua các file có tên đứng trước mã này (VD `_NXT3311`) |
| Đè file trùng tên trên Drive | Thay cả file trùng tên đã có sẵn trên Drive |

### Dữ liệu app lưu ở đâu

| File | Nội dung |
|---|---|
| `<folder ảnh>/appuploadanh-log.json` | Danh sách ảnh đã upload của folder (để lần sau không upload lại) |
| `<folder ảnh>/upload-logs/upload-log-YYYY-MM-DD.txt` | Nhật ký chi tiết theo ngày |
| `~/Library/Application Support/snappy-drive/settings.json` | Thư mục tháng đã lưu, tuỳ chọn, lịch sử các buổi upload |

Các file log trong folder ảnh **không** được upload lên Drive.

## Phát triển

```bash
npm install
```

```bash
npm start
```

Build bản macOS (dmg + zip) vào thư mục `dist/`:

```bash
npm run build:mac
```

### Cấu trúc code

| File | Vai trò |
|---|---|
| `main.js` | Electron main process: cửa sổ, IPC, gọi rclone, thông báo, thanh menu, lưu cài đặt & lịch sử, protocol `snappy://` cho thumbnail |
| `uploader.js` | Engine upload: theo dõi folder, hàng đợi, thử lại, đối chiếu với Drive, log JSON. Không phụ thuộc Electron |
| `drive-target.js` | Tìm / tạo thư mục khách trên Drive (xử lý dấu `/` trong tên) |
| `exif.js` | Đọc ngày chụp (EXIF) từ JPG / TIFF / RAW dạng TIFF |
| `preload.js` | Cầu nối an toàn giữa giao diện và main process |
| `index.html`, `renderer.js`, `styles.css` | Giao diện |
| `assets/` | Logo và icon app |

### Chạy thử không đụng Drive thật

rclone cho phép trỏ remote `drive:` về một thư mục local qua biến môi trường, còn `SNAPPY_USER_DATA` tách cài đặt khỏi bản thật:

```bash
mkdir -p /tmp/snappy-test/drive && cd /tmp/snappy-test/drive && SNAPPY_USER_DATA=/tmp/snappy-test/data RCLONE_CONFIG=/tmp/snappy-test/none.conf RCLONE_CONFIG_DRIVE_TYPE=local npx electron /đường/dẫn/tới/AppUploadAnh
```

Ảnh sẽ được "upload" vào `/tmp/snappy-test/drive`. Remote local không có ID thư mục và không tạo được link công khai, nên ở chế độ này hãy bật *Upload thẳng vào thư mục đã chọn*.

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| macOS báo không mở được app | Chuột phải vào app → **Mở** |
| "rclone chưa cài đặt" | `brew install rclone` rồi bấm **Kiểm tra lại** |
| "Mất kết nối Google Drive" | Mở ⚙ → **Kết nối lại** (token Google hết hạn) |
| Upload chậm hơn upload trên web Drive | rclone mặc định dùng Client ID chung nên hay bị Google giới hạn tốc độ. Nên [tạo Client ID riêng](https://rclone.org/drive/#making-your-own-client-id) rồi cấu hình lại remote `drive` |
| Ảnh báo "Trùng tên trên Drive" | Trên Drive đã có file cùng tên khác nội dung. Bật *Đè file trùng tên trên Drive* nếu muốn thay |
| Ảnh báo lỗi sau nhiều lần thử | Bấm **Kiểm tra** để thử lại ngay; xem chi tiết ở tab **Nhật ký** |
