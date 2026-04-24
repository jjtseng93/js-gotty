# js-gotty / gotty.js

## News
### 2026/04/23
- Added optional noWinOpenUseFetch() at the frontend for Bun markdown TUI:
- https://github.com/jjtseng93/bun-taskmgr
### 2026/04/21
- Added show text in dialog for frontend:
- alert_advanced(getTerminalText())
- for copying text on mobile devices

## Intro 介紹
- 這是用 JavaScript / Bun 重新實作的 GoTTY 相容伺服器
- 參考了原本的GoTTY的程式碼 大部分以Codex生成
- 包含已針對 `js-gotty` 調整過的前端與 WebTTY 協定實作
- .
- 原版repo:
- https://github.com/sorenisanerd/gotty

### Features 特色功能
- Resumable reconnect: 瀏覽器斷線後可以用 reconnect token 接回原本的 shell / PTY，而不是重開一個新的 shell。
- Kitty Graphics Protocol: 可以顯示終端內嵌圖片
  * 像是用 `bun viu.mjs 1.png` 直接在終端中顯示圖片。
  * Windows不是使用Kitty協定，而是自訂協議
- ZMODEM / `rz/sz`: 可以從瀏覽器端選檔並上傳到遠端shell
  * 也可以從遠端shell下載檔案
  * Windows不是使用ZMODEM，而是自訂協議

### PTY Backends PTY後端策略
- Linux / macOS: 使用 Bun 內建 PTY `Bun.spawn(..., { terminal: ... })`
- Windows: 使用patched `node-pty`，但整體以 `bun` 啟動 `gotty.js`


## Usage 用法

### Linux

```sh
bun gotty.js -w bash
bun gotty.js -w --credential user:pass bash
bun gotty.js -w --reconnect fish
bun gotty.js -w --reconnect --reconnect-time 30 fish
bun gotty.js -w --reconnect --reconnect-time -1 fish
bun gotty.js -w -p 8000 fish

# show help
bun gotty.js
```

### Windows

```sh
bun gotty.js -w cmd.exe
bun gotty.js -w powershell

# show help
bun gotty.js
bun gotty.js -h
```

### Wrapper
- wgotty is a wrapper for Linux
- or Windows with busybox64u.exe bash
- https://frippery.org/busybox/
- just run ./wgotty and it will 
- detect installation status of Bun
- and show installation script if needed

## Tested platforms 已測試作業系統
- Windows x64: Windows 11
- Linux x64: CachyOS
- Android arm64: Termux proot, 
- Android arm64: My App
  * https://drive.google.com/drive/folders/18iwbKrAZfA-HoTSP9I5MzGz5xVFMZ4bg

## Current implementation 目前實做
- 使用node原生 `http`/`https`
- 使用 `ws` 處理 WebSocket upgrade
- 使用 `./static` 內自帶前端頁面、kitty overlay 與 WebTTY/ZMODEM 前端邏輯
- 支援 reconnect token 與 session resume，可接回原本 shell
- 支援輸出圖片到終端
- 支援檔案上傳/下載

### Reconnect / Resume 重新連接
- `--reconnect` 不是單純重開 websocket，而是讓 server 保留目前 PTY session，瀏覽器重新連上時可接回原本 shell。
- server 會為每個 reconnectable session 產生一個 reconnect token。前端會自動保存這個 token，重連時優先嘗試接回原 session。
- `--reconnect-time` 的語意：
  * `> 0`: 斷線後保留 session 指定秒數
  * `= 0`: 不保留 session
  * `< 0`: 無限期保留 session，直到 shell 自己結束或 server 被停止
- 前端的 reconnect 行為：
  * `reconnect-time > 0` 時，會在期限內自動重試多次
  * `reconnect-time < 0` 時，會每 1 分鐘自動重試一次
  * overlay 會提供 `Reconnect` 按鈕，可手動立即重試
  * 該按鈕右鍵/長按可輸入自訂reconnect token
- 目前 reconnect 是「接回現有 shell」，不是「回放斷線期間所有輸出」。斷線期間的輸出不會補送。

### Kitty intro
- 只要終端程式使用 Kitty Graphics Protocol (Linux) 輸出圖片，前端就會把圖片顯示在終端對應位置。
- Windows採用自訂協議。
- 用法：

```sh
bun viu.mjs 1.png
```

### rz upload intro
- 當遠端 shell 執行：

```sh
bun rz.js
```

- 前端會跳出檔案選擇視窗。選擇檔案後，會以 ZMODEM 上傳到目前 shell 所在目錄。

### sz download intro
- 當遠端 shell 執行：

```sh
bun sz.js file.txt
```

- 前端會接收 ZMODEM 下載資料，並讓瀏覽器下載檔案。


## Others 備註
- 目標是模擬原版 GoTTY 的主要行為，並增加特色功能
- 以 Bun 為主要執行方式。
- Linux / macOS 如果不是用 Bun 執行，PTY 會無法使用。
- 目前未實作 Go 版的 config 檔載入
