# js-gotty / gotty.js

## Intro 介紹
- 這是用 JavaScript / Bun 重新實作的 GoTTY 相容伺服器
- 參考了原本的GoTTY的程式碼 大部分以Codex生成
- 包含已針對 `js-gotty` 調整過的前端與 WebTTY 協定實作
- .
- 原版repo:
- https://github.com/sorenisanerd/gotty

### 特色功能 Features
- Kitty Graphics Protocol: 可以顯示終端內嵌圖片
  * 像是用 `viu 1.png` 直接在終端中顯示圖片。
- ZMODEM / `rz`: 可以從瀏覽器端選檔並上傳到遠端shell
  * 目前已支援 `rz` 收檔流程。

### PTY後端策略 PTY Backends
- Linux / macOS: 使用 Bun 內建 PTY `Bun.spawn(..., { terminal: ... })`
- Windows: 使用 `node-pty`，但整體以 `bun` 啟動 `gotty.js`


## Usage 用法

### Linux

```sh
bun gotty.js -w bash
bun gotty.js -w --credential user:pass bash
bun gotty.js -w --reconnect fish
bun gotty.js -w -p 8000 fish
```

### Windows

```sh
bun gotty.js -w cmd.exe
bun gotty.js -w powershell
```


## 目前實做 Current implementation
- 使用原生 `http`/`https`
- 使用 `ws` 處理 WebSocket upgrade
- POSIX 上使用 Bun Terminal 啟動本機 PTY
- Windows 上透過 patched `node-pty` 提供 PTY
- 使用 `js-gotty/static` 內自帶前端頁面、kitty overlay 與 WebTTY/ZMODEM 前端邏輯
- 支援 Kitty Graphics Protocol 圖片顯示
- 支援 `viu` 這類透過 kitty protocol 輸出的圖片終端程式
- 支援 `rz` 檔案上傳

### kitty intro
- 只要終端程式使用 Kitty Graphics Protocol 輸出圖片，前端就會把圖片顯示在終端對應位置。
- 例如：
```sh
viu 1.png
```

### rz upload intro
- 當遠端 shell 執行：
```sh
rz
```
- 前端會跳出檔案選擇視窗。選擇檔案後，會以 ZMODEM 上傳到目前 shell 所在目錄。


## 備註
- 目標是模擬原版 GoTTY 的主要行為，不是逐行轉譯 Go 程式。
- 以 Bun 為主要執行方式。
- Linux / macOS 如果不是用 Bun 執行，PTY 會無法使用。
- 目前未實作 Go 版的 config 檔載入與 TLS client certificate 驗證。
