(function () {
  const MSG_OUTPUT = "1";
  const MSG_KITTY = "7";
  const DEFAULT_TOUCH_SCROLL_THRESHOLD = 24;
  const overlay = document.getElementById("kitty-overlay");
  const terminal = document.getElementById("terminal");
  const KITTY_TRACE = Boolean(window.gotty_kitty_trace);
  const state = {
    cols: 80,
    rows: 24,
    placements: new Map(),
    scrollBound: false,
    renderBound: false,
    renderDisposables: [],
    relayoutFrame: 0,
    outputTail: "",
    recentCursorHome: false,
    recentClearLineCount: 0,
    touchBound: false,
    touchScroll: null,
    contextMenu: null
  };

  function xtermElements() {
    if (!terminal) {
      return {};
    }
    return {
      xterm: terminal.querySelector(".xterm"),
      screen: terminal.querySelector(".xterm-screen"),
      rows: terminal.querySelector(".xterm-rows"),
      viewport: terminal.querySelector(".xterm-viewport"),
      helper: terminal.querySelector(".xterm-helper-textarea")
    };
  }

  function ensureOverlayBounds() {
    if (!overlay || !terminal) {
      return;
    }
    const { screen } = xtermElements();
    const containerRect = terminal.getBoundingClientRect();
    const rect = screen ? screen.getBoundingClientRect() : containerRect;
    overlay.style.left = `${rect.left - containerRect.left}px`;
    overlay.style.top = `${rect.top - containerRect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function cellMetrics() {
    ensureOverlayBounds();
    const { screen, rows, helper } = xtermElements();
    const rect = (screen || terminal).getBoundingClientRect();
    let cellWidth = rect.width / Math.max(1, state.cols);
    let cellHeight = rect.height / Math.max(1, state.rows);

    if (rows) {
      const firstRow = rows.firstElementChild;
      if (firstRow) {
        const rowRect = firstRow.getBoundingClientRect();
        if (rowRect.height > 0) {
          cellHeight = rowRect.height;
        }
      }
    }

    if (helper) {
      const helperRect = helper.getBoundingClientRect();
      if (helperRect.width > 0) {
        cellWidth = helperRect.width;
      }
      if (helperRect.height > 0) {
        cellHeight = helperRect.height;
      }
    }

    return {
      width: cellWidth,
      height: cellHeight
    };
  }

  function anchorOffset() {
    return {
      left: 0,
      top: 0
    };
  }

  function placementKey(message) {
    const control = message.control || {};
    const imageId = control.i || control.I || (message.image && message.image.id) || "anon";
    return `${imageId}:${control.p || "0"}`;
  }

  function currentCursorPosition() {
    const xterm = terminal && terminal.__gottyXterm;
    const active = xterm && xterm.buffer && xterm.buffer.active;
    if (!active) {
      return null;
    }
    return {
      bufferRow: active.baseY + active.cursorY + 1,
      col: active.cursorX + 1
    };
  }

  function currentViewportY() {
    const xterm = terminal && terminal.__gottyXterm;
    const active = xterm && xterm.buffer && xterm.buffer.active;
    return active ? active.viewportY : 0;
  }

  function createPlacementMarker() {
    const xterm = terminal && terminal.__gottyXterm;
    if (!xterm || typeof xterm.registerMarker !== "function") {
      return null;
    }
    try {
      return xterm.registerMarker(0);
    } catch (error) {
      return null;
    }
  }

  function decodeRawImage(image) {
    const binary = atob(image.data);
    const bytes = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    let rgba;
    if (image.format === 32) {
      rgba = bytes;
    } else if (image.format === 24) {
      rgba = new Uint8ClampedArray((bytes.length / 3) * 4);
      for (let src = 0, dst = 0; src < bytes.length; src += 3, dst += 4) {
        rgba[dst] = bytes[src];
        rgba[dst + 1] = bytes[src + 1];
        rgba[dst + 2] = bytes[src + 2];
        rgba[dst + 3] = 255;
      }
    } else {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
    return canvas;
  }

  function binaryFromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function stringFromBase64(base64) {
    return atob(base64);
  }

  function inferBlobMimeType(image, control) {
    const explicit = control && (control.U || control.mime);
    if (explicit) {
      return explicit;
    }
    if (!image) {
      return "application/octet-stream";
    }
    if (image.format === 100) {
      return "image/png";
    }
    return "application/octet-stream";
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error("Failed to create blob from canvas"));
      }, "image/png");
    });
  }

  async function blobDimensions(blob) {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    }

    return new Promise((resolve, reject) => {
      const probe = new Image();
      const url = URL.createObjectURL(blob);
      probe.onload = () => {
        const dimensions = {
          width: probe.naturalWidth,
          height: probe.naturalHeight
        };
        URL.revokeObjectURL(url);
        resolve(dimensions);
      };
      probe.onerror = (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      };
      probe.src = url;
    });
  }

  async function resolveImageAsset(image) {
    if (!image) {
      return null;
    }
    if (image.format === 100) {
      const blob = new Blob([binaryFromBase64(image.data)], {
        type: inferBlobMimeType(image, image.control || {})
      });
      const dimensions = await blobDimensions(blob);
      return { blob, width: dimensions.width, height: dimensions.height };
    }
    const canvas = decodeRawImage(image);
    if (!canvas) {
      return null;
    }
    const blob = await canvasToBlob(canvas);
    return { blob, width: canvas.width, height: canvas.height };
  }

  function revokeNodeUrl(node) {
    if (node && node.__kittyObjectUrl) {
      URL.revokeObjectURL(node.__kittyObjectUrl);
      node.__kittyObjectUrl = "";
    }
  }

  function layoutNode(node) {
    if (!node || !node.__kittyPlacement) {
      return;
    }
    const { control, cursor, intrinsicWidth, intrinsicHeight } = node.__kittyPlacement;
    const metrics = cellMetrics();
    const anchor = anchorOffset();
    const cols = Number.parseInt(control.c || "0", 10) || Math.max(1, Math.round(intrinsicWidth / Math.max(1, metrics.width)));
    const rows = Number.parseInt(control.r || "0", 10) || Math.max(1, Math.round(intrinsicHeight / Math.max(1, metrics.height)));
    const marker = node.__kittyMarker;
    const row = marker && !marker.isDisposed && Number.isFinite(marker.line)
      ? marker.line - currentViewportY() + 1
      : cursor && Number.isFinite(cursor.bufferRow)
        ? cursor.bufferRow - currentViewportY()
        : (cursor && cursor.row) || 1;
    node.style.left = `${anchor.left + (Math.max(1, cursor.col) - 1) * metrics.width}px`;
    node.style.top = `${anchor.top + (row - 1) * metrics.height}px`;
    node.style.width = `${cols * metrics.width}px`;
    node.style.height = `${rows * metrics.height}px`;
    node.style.zIndex = String(Number.parseInt(control.z || "0", 10) || 0);
  }

  function relayoutAll() {
    ensureOverlayBounds();
    for (const node of state.placements.values()) {
      layoutNode(node);
    }
  }

  function scheduleRelayout() {
    if (state.relayoutFrame) {
      return;
    }
    state.relayoutFrame = requestAnimationFrame(() => {
      state.relayoutFrame = 0;
      relayoutAll();
    });
  }

  function bindViewportScroll() {
    if (state.scrollBound) {
      return;
    }
    const { viewport } = xtermElements();
    if (!viewport) {
      return;
    }
    viewport.addEventListener("scroll", relayoutAll, { passive: true });
    state.scrollBound = true;
  }

  function bindTerminalRender() {
    if (state.renderBound || !terminal) {
      return;
    }
    const xterm = terminal.__gottyXterm;
    if (!xterm) {
      return;
    }
    if (typeof xterm.onRender === "function") {
      state.renderDisposables.push(xterm.onRender(() => {
        scheduleRelayout();
      }));
    }
    if (typeof xterm.onWriteParsed === "function") {
      state.renderDisposables.push(xterm.onWriteParsed(() => {
        scheduleRelayout();
      }));
    }
    state.renderBound = state.renderDisposables.length > 0;
  }

  function dispatchSyntheticWheel(target, touch, deltaX, deltaY) {
    if (!target) {
      return;
    }
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaX,
      deltaY,
      clientX: touch.clientX,
      clientY: touch.clientY
    });
    target.dispatchEvent(event);
  }

  function touchScrollThreshold() {
    const configured = Number(window.touchScrollThreshold);
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return DEFAULT_TOUCH_SCROLL_THRESHOLD;
  }

  function bindTouchScrolling() {
    if (state.touchBound || !terminal) {
      return;
    }

    const bindTarget = terminal;
    const activeTouchId = () => state.touchScroll && state.touchScroll.identifier;
    const wheelTarget = () => {
      const { screen, viewport, xterm } = xtermElements();
      return screen || viewport || xterm || terminal;
    };

    bindTarget.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) {
        state.touchScroll = null;
        return;
      }
      const touch = event.touches[0];
      state.touchScroll = {
        identifier: touch.identifier,
        lastX: touch.clientX,
        lastY: touch.clientY,
        residualX: 0,
        residualY: 0
      };
    }, { passive: true });

    bindTarget.addEventListener("touchmove", (event) => {
      if (!state.touchScroll) {
        return;
      }
      const touch = Array.from(event.touches).find((entry) => entry.identifier === activeTouchId());
      if (!touch) {
        return;
      }

      const deltaX = state.touchScroll.lastX - touch.clientX;
      const deltaY = state.touchScroll.lastY - touch.clientY;
      state.touchScroll.lastX = touch.clientX;
      state.touchScroll.lastY = touch.clientY;
      state.touchScroll.residualX += deltaX;
      state.touchScroll.residualY += deltaY;

      const threshold = touchScrollThreshold();
      const stepX = state.touchScroll.residualX >= 0 ? 1 : -1;
      const stepY = state.touchScroll.residualY >= 0 ? 1 : -1;
      const ticksX = Math.trunc(Math.abs(state.touchScroll.residualX) / threshold);
      const ticksY = Math.trunc(Math.abs(state.touchScroll.residualY) / threshold);

      if (ticksX === 0 && ticksY === 0) {
        return;
      }

      event.preventDefault();
      const target = wheelTarget();
      const count = Math.max(ticksX, ticksY);
      for (let i = 0; i < count; i += 1) {
        dispatchSyntheticWheel(
          target,
          touch,
          i < ticksX ? stepX : 0,
          i < ticksY ? stepY : 0
        );
      }
      state.touchScroll.residualX -= ticksX * threshold * stepX;
      state.touchScroll.residualY -= ticksY * threshold * stepY;
    }, { passive: false });

    const clearTouchScroll = () => {
      state.touchScroll = null;
    };
    bindTarget.addEventListener("touchend", clearTouchScroll, { passive: true });
    bindTarget.addEventListener("touchcancel", clearTouchScroll, { passive: true });
    state.touchBound = true;
  }

  function ensureContextMenu() {
    if (state.contextMenu) {
      return state.contextMenu;
    }

    const menu = document.createElement("div");
    menu.className = "kitty-context-menu";
    menu.hidden = true;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "kitty-context-menu__item";
    removeButton.textContent = "Remove image";
    menu.appendChild(removeButton);

    state.contextMenu = {
      root: menu,
      removeButton,
      targetKey: null
    };

    document.body.appendChild(menu);

    removeButton.addEventListener("click", () => {
      if (!state.contextMenu || !state.contextMenu.targetKey) {
        return;
      }
      const node = state.placements.get(state.contextMenu.targetKey);
      if (node) {
        revokeNodeUrl(node);
        node.remove();
        state.placements.delete(state.contextMenu.targetKey);
      }
      hideContextMenu();
    });

    document.addEventListener("pointerdown", (event) => {
      if (!state.contextMenu || state.contextMenu.root.hidden) {
        return;
      }
      if (state.contextMenu.root.contains(event.target)) {
        return;
      }
      hideContextMenu();
    }, { passive: true });

    window.addEventListener("blur", hideContextMenu);
    window.addEventListener("resize", hideContextMenu);

    return state.contextMenu;
  }

  function showContextMenu(x, y, key) {
    const menu = ensureContextMenu();
    menu.targetKey = key;
    menu.root.hidden = false;

    const margin = 10;
    const rect = menu.root.getBoundingClientRect();
    let left = x - rect.width - margin;
    if (left < margin) {
      left = Math.min(window.innerWidth - rect.width - margin, x + margin);
    }
    if (left < margin) {
      left = margin;
    }

    let top = y - rect.height - margin;
    if (top < margin) {
      top = Math.min(window.innerHeight - rect.height - margin, y + margin);
    }
    if (top < margin) {
      top = margin;
    }

    menu.root.style.left = `${left}px`;
    menu.root.style.top = `${top}px`;
  }

  function hideContextMenu() {
    if (!state.contextMenu) {
      return;
    }
    state.contextMenu.targetKey = null;
    state.contextMenu.root.hidden = true;
  }

  async function placeImage(message) {
    if (!overlay || !terminal || !message.image) {
      return;
    }

    const key = placementKey(message);
    const control = message.control || {};
    const cursor = message.bufferCursor || message.cursor || { row: 1, col: 1 };
    if (message.image) {
      message.image.control = control;
    }

    let node = state.placements.get(key);
    if (!node) {
      node = document.createElement("img");
      node.className = "kitty-image";
      node.alt = "";
      node.__kittyObjectUrl = "";
      node.__kittyMarker = null;
      node.addEventListener("contextmenu", (event) => {
        showContextMenu(event.clientX, event.clientY, key);
      });
      state.placements.set(key, node);
      overlay.appendChild(node);
    }

    if (!node.__kittyMarker) {
      node.__kittyMarker = createPlacementMarker();
    }

    const asset = await resolveImageAsset(message.image);
    if (!asset) {
      return;
    }
    const objectUrl = URL.createObjectURL(asset.blob);
    revokeNodeUrl(node);
    node.__kittyObjectUrl = objectUrl;
    node.__kittyPlacement = {
      control,
      cursor,
      intrinsicWidth: asset.width,
      intrinsicHeight: asset.height
    };
    node.src = objectUrl;
    bindViewportScroll();
    bindTerminalRender();
    bindTouchScrolling();
    layoutNode(node);
  }

  function deleteImages(message) {
    const info = message.delete || {};
    if (info.scope === "a") {
      for (const node of state.placements.values()) {
        revokeNodeUrl(node);
        node.remove();
      }
      state.placements.clear();
      return;
    }

    if (info.imageId) {
      for (const [key, node] of state.placements.entries()) {
        if (key.startsWith(`${info.imageId}:`)) {
          revokeNodeUrl(node);
          node.remove();
          state.placements.delete(key);
        }
      }
    }
  }

  function clearAllImages() {
    deleteImages({ delete: { scope: "a" } });
  }

  function inspectTerminalOutput(data) {
    if (typeof data !== "string" || data[0] !== MSG_OUTPUT || data.length <= 1) {
      return;
    }

    let text;
    try {
      text = state.outputTail + stringFromBase64(data.slice(1));
    } catch (error) {
      state.outputTail = "";
      return;
    }

    if (text.includes("\u001bc") || text.includes("\f")) {
      clearAllImages();
    }

    const csiPattern = /\u001b\[([0-9;?]*)([A-Za-z])/g;
    let match;
    while ((match = csiPattern.exec(text)) !== null) {
      const params = match[1];
      const finalByte = match[2];
      if (finalByte === "H" || finalByte === "f") {
        const normalized = params === "" ? ["1"] : params.split(";");
        const row = Number.parseInt(normalized[0] || "1", 10) || 1;
        const col = Number.parseInt(normalized[1] || "1", 10) || 1;
        state.recentCursorHome = row === 1 && col === 1;
        if (state.recentCursorHome) {
          state.recentClearLineCount = 0;
        }
      }
      if (finalByte === "J") {
        const mode = params === "" ? 0 : Number.parseInt(params.split(";").pop() || "0", 10) || 0;
        if (mode === 2 || mode === 3 || (mode === 0 && state.recentCursorHome)) {
          clearAllImages();
        }
        state.recentCursorHome = false;
        state.recentClearLineCount = 0;
      }
      if (finalByte === "K") {
        const mode = params === "" ? 0 : Number.parseInt(params.split(";").pop() || "0", 10) || 0;
        if (state.recentCursorHome && mode === 0) {
          state.recentClearLineCount += 1;
          if (state.recentClearLineCount >= Math.max(4, Math.floor(state.rows / 3))) {
            clearAllImages();
            state.recentCursorHome = false;
            state.recentClearLineCount = 0;
          }
        } else {
          state.recentClearLineCount = 0;
        }
      }
      if (finalByte === "h" || finalByte === "l") {
        if (params === "?1049" || params === "?1047" || params === "?47") {
          clearAllImages();
        }
        state.recentCursorHome = false;
        state.recentClearLineCount = 0;
      }
      if (finalByte !== "H" && finalByte !== "f" && finalByte !== "K") {
        state.recentCursorHome = false;
        state.recentClearLineCount = 0;
      }
    }

    state.outputTail = text.slice(-64);
  }

  function handleKittyMessage(payload) {
    const message = JSON.parse(payload);
    if (message.kind === "placement") {
      message.bufferCursor = currentCursorPosition();
      placeImage(message);
      return true;
    }
    if (message.kind === "delete") {
      deleteImages(message);
      return true;
    }
    return false;
  }

  const nativeSend = WebSocket.prototype.send;
  const nativeOnOpen = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type !== "message") {
      return nativeOnOpen.call(this, type, listener, options);
    }
      const wrapped = function (event) {
        inspectTerminalOutput(event.data);
        if (typeof event.data === "string" && event.data[0] === MSG_KITTY) {
          if (handleKittyMessage(event.data.slice(1))) {
            return;
          }
        }
        const result = listener.call(this, event);
        scheduleRelayout();
        return result;
      };
      listener.__kittyWrapped = wrapped;
      return nativeOnOpen.call(this, type, wrapped, options);
    };

  const nativeRemoveEventListener = WebSocket.prototype.removeEventListener;
  WebSocket.prototype.removeEventListener = function (type, listener, options) {
    if (type === "message" && listener && listener.__kittyWrapped) {
      return nativeRemoveEventListener.call(this, type, listener.__kittyWrapped, options);
    }
    return nativeRemoveEventListener.call(this, type, listener, options);
  };

  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  Object.defineProperty(WebSocket.prototype, "onmessage", {
    configurable: true,
    enumerable: descriptor ? descriptor.enumerable : true,
    get() {
      return this.__kittyOnMessage || null;
    },
    set(handler) {
      this.__kittyOnMessage = handler;
      if (!descriptor || !descriptor.set) {
        return;
      }
      if (typeof handler !== "function") {
        descriptor.set.call(this, handler);
        return;
      }
      descriptor.set.call(this, function (event) {
        inspectTerminalOutput(event.data);
        if (typeof event.data === "string" && event.data[0] === MSG_KITTY) {
          if (handleKittyMessage(event.data.slice(1))) {
            return;
          }
        }
        return handler.call(this, event);
      });
    }
  });

  window.addEventListener("resize", relayoutAll);
  bindTouchScrolling();
  const originalNativeSend = nativeSend;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string" && data[0] === "3") {
      try {
        const resize = JSON.parse(data.slice(1));
        if (resize.columns) {
          state.cols = resize.columns;
        }
        if (resize.rows) {
          state.rows = resize.rows;
        }
      } catch (error) {
        // ignore
      }
    }
    return originalNativeSend.call(this, data);
  };
  relayoutAll();
})();
