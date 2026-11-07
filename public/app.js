/**
 * CFAT Real-Time Engine Client
 * api.cfat.site / chat.cfat.site
 * Supports real-time room chat, targeted whispers, and binary file transfer.
 */

// Application State
const state = {
  room: "",
  username: "",
  ws: null,
  wsUrl: "",
  participants: [],
  soundEnabled: localStorage.getItem("cfat_sound") !== "false",
  audioCtx: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,
  outgoingTransfers: {}, // id -> transferObj
  incomingTransfers: {}, // id -> transferObj
  fileRegistry: {},      // id -> { id, filename, rawBytes, isIncoming }
  activeEditingTransferId: null,
};

// DOM Elements
const elements = {
  lobbyScreen: document.getElementById("lobby-screen"),
  chatScreen: document.getElementById("chat-screen"),
  joinForm: document.getElementById("join-form"),
  hostForm: document.getElementById("host-form"),
  joinRoomInput: document.getElementById("join-room"),
  joinUserInput: document.getElementById("join-user"),
  hostRoomInput: document.getElementById("host-room"),
  hostUserInput: document.getElementById("host-user"),
  tabJoin: document.getElementById("tab-join"),
  tabHost: document.getElementById("tab-host"),
  activeRoomCode: document.getElementById("active-room-code"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  participantCountBadge: document.getElementById("participant-count-badge"),
  drawerUserCount: document.getElementById("drawer-user-count"),
  participantsList: document.getElementById("participants-list"),
  participantsDrawer: document.getElementById("participants-drawer"),
  drawerBackdrop: document.getElementById("drawer-backdrop"),
  messagesStream: document.getElementById("messages-stream"),
  chatInput: document.getElementById("chat-input"),
  sendButton: document.getElementById("send-button"),
  attachButton: document.getElementById("attach-button"),
  fileInput: document.getElementById("file-input"),
  dropOverlay: document.getElementById("drop-overlay"),
  soundIconOn: document.getElementById("sound-icon-on"),
  soundIconOff: document.getElementById("sound-icon-off"),
  toastContainer: document.getElementById("toast-container"),
  fileEditorModal: document.getElementById("file-editor-modal"),
  fileEditorTextarea: document.getElementById("file-editor-textarea"),
  editorFilename: document.getElementById("editor-filename"),
  editorStatsInfo: document.getElementById("editor-stats-info"),
};

// Architectural color palette for avatars
const AVATAR_PALETTE = [
  "#2563eb", // Cobalt
  "#0f766e", // Deep Teal
  "#b45309", // Amber
  "#334155", // Slate Gray
  "#047857", // Emerald
  "#be123c", // Crimson
  "#475569", // Cool Slate
  "#0369a1", // Steel Blue
];

// File Transfer Config
const WEB_FILE_SLICE = 24 * 1024; // 24 KB raw payload per chunk
const WEB_CHUNK_PACE_MS = 70;      // 70ms pacing (~14 msgs/sec, safe under Cloudflare 75 msgs / 5s)

// Initialization
document.addEventListener("DOMContentLoaded", async () => {
  updateSoundUI();
  initMobileViewport();
  initDragAndDrop();

  const savedUser = localStorage.getItem("cfat_username") || "";
  if (savedUser) {
    elements.joinUserInput.value = savedUser;
    elements.hostUserInput.value = savedUser;
  }

  elements.hostRoomInput.value = generateRoomCode();

  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    elements.joinRoomInput.value = roomParam.toUpperCase().trim();
    switchTab("join");
    elements.joinUserInput.focus();
  }

  // Fetch optional config from /api/config
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      if (data.wsUrl) {
        state.wsUrl = data.wsUrl;
      }
    }
  } catch (_) {
    // Falls back to current host
  }
});

// UI TAB SWITCHER
function switchTab(tab) {
  if (tab === "join") {
    elements.tabJoin.classList.add("active");
    elements.tabHost.classList.remove("active");
    elements.joinForm.classList.remove("hidden");
    elements.hostForm.classList.add("hidden");
  } else {
    elements.tabHost.classList.add("active");
    elements.tabJoin.classList.remove("active");
    elements.hostForm.classList.remove("hidden");
    elements.joinForm.classList.add("hidden");
  }
}

function generateRoomCode() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return String(num);
}

function generateNewRoomCode() {
  elements.hostRoomInput.value = generateRoomCode();
}

// FORM HANDLERS
function handleJoin(e) {
  e.preventDefault();
  const room = elements.joinRoomInput.value.trim().toUpperCase();
  const user = elements.joinUserInput.value.trim();
  if (!room || !user) return showToast("Enter room code and handle");
  enterRoom(room, user);
}

function handleHost(e) {
  e.preventDefault();
  const room = elements.hostRoomInput.value.trim().toUpperCase();
  const user = elements.hostUserInput.value.trim();
  if (!room || !user) return showToast("Enter room code and handle");
  enterRoom(room, user);
}

// WEBSOCKET & ROOM LIFECYCLE
function enterRoom(room, user) {
  state.room = room;
  state.username = user;
  localStorage.setItem("cfat_username", user);

  elements.lobbyScreen.classList.remove("active");
  elements.chatScreen.classList.add("active");
  elements.activeRoomCode.textContent = room;
  elements.messagesStream.innerHTML = "";

  if (window.visualViewport) {
    elements.chatScreen.style.height = `${window.visualViewport.height}px`;
    elements.chatScreen.style.top = `${window.visualViewport.offsetTop}px`;
  }

  elements.chatInput.focus();

  const newUrl = `${window.location.pathname}?room=${encodeURIComponent(room)}`;
  window.history.replaceState({ room }, "", newUrl);

  connectWebSocket();
}

function connectWebSocket() {
  setStatus("connecting", "Connecting...");

  let targetWs = state.wsUrl;
  if (!targetWs) {
    if (window.location.hostname.includes("cfat.site")) {
      targetWs = "wss://api.cfat.site/ws";
    } else {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      targetWs = `${proto}//${window.location.host}/ws`;
    }
  }

  const endpoint = `${targetWs}?room=${encodeURIComponent(state.room)}&user=${encodeURIComponent(state.username)}&game=chat`;

  try {
    state.ws = new WebSocket(endpoint);
  } catch (err) {
    console.error("WebSocket failed:", err);
    setStatus("offline", "Connection Failed");
    return;
  }

  state.ws.onopen = () => {
    state.reconnectAttempts = 0;
    setStatus("connected", "Connected");
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleIncomingPacket(data);
    } catch (err) {
      console.error("Invalid packet:", err);
    }
  };

  state.ws.onclose = () => {
    if (!state.room) return;
    setStatus("offline", "Disconnected");
    if (state.reconnectAttempts < state.maxReconnectAttempts) {
      state.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(1.5, state.reconnectAttempts), 8000);
      setStatus("connecting", `Reconnecting in ${Math.round(delay / 1000)}s...`);
      setTimeout(() => {
        if (state.room) connectWebSocket();
      }, delay);
    }
  };

  state.ws.onerror = (err) => {
    console.warn("WebSocket error:", err);
  };
}

function handleIncomingPacket(packet) {
  switch (packet.type) {
    case "room_state":
      updateParticipants(packet.users || []);
      renderSystemMessage(`Joined room ${packet.room}`);
      break;

    case "user_joined":
      updateParticipants(packet.users || []);
      renderSystemMessage(`${packet.user} entered the room`);
      playChime("join");
      break;

    case "user_left":
      updateParticipants(packet.users || []);
      renderSystemMessage(`${packet.user} left the room`);
      cleanupUserFileTransfers(packet.user);
      break;

    case "chat":
      renderChatMessage(packet.user, packet.message, packet.timestamp);
      if (packet.user !== state.username) {
        playChime("msg");
      }
      break;

    case "action":
    case "game":
      handleActionPacket(packet);
      break;
  }
}

// ACTION ROUTER (Whispers & File Sharing)
function handleActionPacket(packet) {
  const sender = packet.fromUser || packet.user;
  const action = packet.action;

  switch (action) {
    case "whisper":
      renderWhisperMessage(sender, state.username, packet.message, packet.timestamp || Date.now(), false);
      playChime("msg");
      break;

    case "file_offer":
      handleIncomingFileOffer(packet);
      break;

    case "file_accept":
      handlePeerFileAccept(packet);
      break;

    case "file_reject":
      handlePeerFileReject(packet);
      break;

    case "file_chunk":
      handleIncomingFileChunk(packet);
      break;

    case "file_done":
      handleIncomingFileDone(packet);
      break;

    case "file_cancel":
      handlePeerFileCancel(packet);
      break;
  }
}

// MESSAGE RENDERING
function renderChatMessage(sender, text, timestamp) {
  const isSelf = sender === state.username;
  const timeStr = formatTime(timestamp);

  const row = document.createElement("div");
  row.className = `msg-row ${isSelf ? "self" : "peer"}`;

  const avatarColor = getAvatarColor(sender);
  const initial = sender.charAt(0).toUpperCase();

  row.innerHTML = `
    <div class="msg-avatar" style="background: ${avatarColor}">${initial}</div>
    <div class="msg-bubble-wrap">
      <div class="msg-meta">
        <span>${escapeHTML(sender)}</span>
        <span>·</span>
        <span>${timeStr}</span>
      </div>
      <div class="msg-bubble">${escapeHTML(text)}</div>
    </div>
  `;

  elements.messagesStream.appendChild(row);
  scrollToBottom();
}

function renderWhisperMessage(fromUser, toUser, message, timestamp, isSelf) {
  const timeStr = formatTime(timestamp);
  const row = document.createElement("div");
  row.className = `msg-row ${isSelf ? "self" : "peer"} whisper`;

  const avatarColor = getAvatarColor(fromUser);
  const initial = fromUser.charAt(0).toUpperCase();
  const label = isSelf ? `PM to ${escapeHTML(toUser)}` : `PM from ${escapeHTML(fromUser)}`;

  row.innerHTML = `
    <div class="msg-avatar" style="background: ${avatarColor}">${initial}</div>
    <div class="msg-bubble-wrap">
      <div class="msg-meta">
        <span class="whisper-badge">Whisper</span>
        <span>${label}</span>
        <span>·</span>
        <span>${timeStr}</span>
      </div>
      <div class="msg-bubble">${escapeHTML(message)}</div>
    </div>
  `;

  elements.messagesStream.appendChild(row);
  scrollToBottom();
}

function renderSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "system-pill";
  div.textContent = text;
  elements.messagesStream.appendChild(div);
  scrollToBottom();
}

function handleSendMessage(e) {
  if (e) e.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  // Handle Whisper command: /w <user> <message>
  if (text.startsWith("/w ") || text.startsWith("/whisper ")) {
    const parts = text.split(" ");
    parts.shift();
    const to = parts.shift();
    const content = parts.join(" ").trim();
    if (!to || !content) {
      showToast("Usage: /w <user> <message>");
      return;
    }
    state.ws.send(JSON.stringify({
      type: "action",
      action: "whisper",
      to,
      message: content,
    }));
    renderWhisperMessage(state.username, to, content, Date.now(), true);
    elements.chatInput.value = "";
    elements.chatInput.focus();
    return;
  }

  state.ws.send(JSON.stringify({ type: "chat", text }));
  elements.chatInput.value = "";
  elements.chatInput.focus();
}

function handleInputKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSendMessage();
  }
}

function scrollToBottom() {
  elements.messagesStream.scrollTop = elements.messagesStream.scrollHeight;
}

// ============================================================
// FILE SHARING (SENDING & RECEIVING)
// ============================================================

function triggerFileInput() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return showToast("Connect to a room first");
  }
  elements.fileInput.value = "";
  elements.fileInput.click();
}

function handleFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  sendFile(file);
}

function initDragAndDrop() {
  const dropOverlay = elements.dropOverlay;
  const chatScreen = elements.chatScreen;

  let dragCounter = 0;

  window.addEventListener("dragenter", (e) => {
    if (!state.room || !chatScreen.classList.contains("active")) return;
    dragCounter++;
    if (dropOverlay) dropOverlay.classList.remove("hidden");
  });

  window.addEventListener("dragleave", (e) => {
    if (!state.room || !chatScreen.classList.contains("active")) return;
    dragCounter--;
    if (dragCounter <= 0 && dropOverlay) {
      dragCounter = 0;
      dropOverlay.classList.add("hidden");
    }
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    if (dropOverlay) dropOverlay.classList.add("hidden");
    if (!state.room || !chatScreen.classList.contains("active")) return;

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      sendFile(file);
    }
  });

  // Support pasting image/file from clipboard
  window.addEventListener("paste", (e) => {
    if (!state.room || !chatScreen.classList.contains("active")) return;
    const file = e.clipboardData?.files?.[0];
    if (file) {
      sendFile(file);
    }
  });
}

async function sendFile(file) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return showToast("Not connected to room");
  }
  if (file.size > 100 * 1024 * 1024) {
    return showToast("File too large (100MB limit)");
  }

  showToast(`Preparing ${file.name}...`);
  const transferId = Math.random().toString(36).substring(2, 10);
  const rawBuffer = await file.arrayBuffer();
  const rawBytes = new Uint8Array(rawBuffer);

  // Compress with deflate-raw if supported and smaller
  let payloadBytes = rawBytes;
  let isCompressed = false;
  try {
    const deflated = await compressDeflateRaw(rawBytes);
    if (deflated.length < rawBytes.length) {
      payloadBytes = deflated;
      isCompressed = true;
    }
  } catch (_) {}

  const totalChunks = payloadBytes.length > 0 ? Math.ceil(payloadBytes.length / WEB_FILE_SLICE) : 0;

  const transfer = {
    id: transferId,
    filename: file.name,
    size: file.size,
    payload: payloadBytes,
    compressed: isCompressed ? 1 : 0,
    totalChunks,
    acceptedBy: null,
    timer: null,
    cardEl: null,
  };
  state.outgoingTransfers[transferId] = transfer;

  state.fileRegistry[transferId] = {
    id: transferId,
    filename: file.name,
    rawBytes: rawBytes,
    isIncoming: false,
  };

  transfer.cardEl = renderOutgoingFileCard(transfer);

  state.ws.send(JSON.stringify({
    type: "action",
    action: "file_offer",
    id: transferId,
    filename: file.name,
    size: file.size,
    compressed: transfer.compressed,
    totalChunks: transfer.totalChunks,
  }));
}

function handlePeerFileAccept(packet) {
  const transfer = state.outgoingTransfers[packet.id];
  if (!transfer) return;
  const peer = packet.fromUser || packet.user;

  if (transfer.acceptedBy) {
    state.ws.send(JSON.stringify({
      type: "action",
      action: "file_reject",
      to: peer,
      id: packet.id,
      reason: "Already accepted by another user",
    }));
    return;
  }

  transfer.acceptedBy = peer;
  transmitOutgoingFile(transfer, peer);
}

function handlePeerFileReject(packet) {
  const transfer = state.outgoingTransfers[packet.id];
  if (!transfer || transfer.acceptedBy) return;
  const peer = packet.fromUser || packet.user;
  updateFileCardStatus(transfer.cardEl, `${peer} declined the file.`, 0);
  delete state.outgoingTransfers[packet.id];
}

function transmitOutgoingFile(transfer, recipient) {
  const payload = transfer.payload;
  const totalChunks = transfer.totalChunks;
  let chunkIndex = 0;

  updateFileCardStatus(transfer.cardEl, `Sending to ${recipient}...`, 0);

  if (totalChunks === 0) {
    state.ws.send(JSON.stringify({
      type: "action",
      action: "file_done",
      to: recipient,
      id: transfer.id,
    }));
    const regItem = state.fileRegistry[transfer.id];
    const isText = isTextFile(transfer.filename, regItem ? regItem.rawBytes : transfer.payload);
    updateOutgoingFileCardDone(transfer.cardEl, `✓ Sent to ${recipient}`, transfer.id, transfer.filename, isText);
    delete state.outgoingTransfers[transfer.id];
    return;
  }

  function sendNextChunk() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.outgoingTransfers[transfer.id]) {
      return;
    }

    if (chunkIndex >= totalChunks) {
      state.ws.send(JSON.stringify({
        type: "action",
        action: "file_done",
        to: recipient,
        id: transfer.id,
      }));
      const regItem = state.fileRegistry[transfer.id];
      const isText = isTextFile(transfer.filename, regItem ? regItem.rawBytes : transfer.payload);
      updateOutgoingFileCardDone(transfer.cardEl, `✓ Sent to ${recipient}`, transfer.id, transfer.filename, isText);
      delete state.outgoingTransfers[transfer.id];
      return;
    }

    const start = chunkIndex * WEB_FILE_SLICE;
    const slice = payload.subarray(start, start + WEB_FILE_SLICE);
    const b64 = uint8ToBase64(slice);

    state.ws.send(JSON.stringify({
      type: "action",
      action: "file_chunk",
      to: recipient,
      id: transfer.id,
      i: chunkIndex,
      index: chunkIndex,
      n: totalChunks,
      totalChunks: totalChunks,
      d: b64,
      data: b64,
    }));

    chunkIndex++;
    const pct = Math.round((chunkIndex / totalChunks) * 100);
    const approxBytes = Math.min(transfer.size, Math.round((chunkIndex / totalChunks) * transfer.size));
    updateFileCardStatus(transfer.cardEl, `Sending to ${recipient} (${humanSize(approxBytes)} / ${humanSize(transfer.size)})...`, pct);

    transfer.timer = setTimeout(sendNextChunk, WEB_CHUNK_PACE_MS);
  }

  sendNextChunk();
}

function handleIncomingFileOffer(packet) {
  const sender = packet.fromUser || packet.user;
  if (!sender || sender.toLowerCase() === state.username.toLowerCase()) return;

  const id = packet.id;
  const filename = String(packet.filename || "file").replace(/[/\\]/g, "_");
  const size = Number(packet.size) || 0;
  const compressed = Boolean(packet.compressed);
  const totalChunks = Number(packet.totalChunks) || 0;

  const transfer = {
    id,
    from: sender,
    filename,
    size,
    compressed,
    totalChunks,
    chunks: new Array(Math.max(1, totalChunks)).fill(null),
    receivedChunks: 0,
    cardEl: null,
    finalized: false,
  };
  state.incomingTransfers[id] = transfer;

  transfer.cardEl = renderIncomingFileCard(transfer);
  playChime("msg");

  // Auto-accept transfer immediately
  acceptIncomingFile(id);
}

function acceptIncomingFile(transferId) {
  const t = state.incomingTransfers[transferId];
  if (!t) return;

  state.ws.send(JSON.stringify({
    type: "action",
    action: "file_accept",
    to: t.from,
    id: t.id,
  }));

  updateFileCardReceiving(t.cardEl, `Receiving from ${t.from}...`);

  if (t.size === 0 && t.totalChunks === 0) {
    finalizeIncomingFile(t);
  }
}

function rejectIncomingFile(transferId) {
  const t = state.incomingTransfers[transferId];
  if (!t) return;

  state.ws.send(JSON.stringify({
    type: "action",
    action: "file_reject",
    to: t.from,
    id: t.id,
  }));

  updateFileCardDone(t.cardEl, "Declined");
  delete state.incomingTransfers[transferId];
}

function handleIncomingFileChunk(packet) {
  const t = state.incomingTransfers[packet.id];
  const sender = packet.fromUser || packet.user;
  if (!t || t.from.toLowerCase() !== (sender || "").toLowerCase()) return;

  const idx = Number(packet.index !== undefined ? packet.index : packet.i);
  const total = Number(packet.totalChunks !== undefined ? packet.totalChunks : packet.n);
  const b64 = String(packet.data !== undefined ? packet.data : (packet.d || ""));

  if (!Number.isInteger(idx) || idx < 0 || idx >= t.totalChunks || !b64) return;
  if (t.chunks[idx] !== null) return; // already got this chunk

  const chunkBuf = base64ToUint8(b64);
  t.chunks[idx] = chunkBuf;
  t.receivedChunks++;

  const pct = Math.round((t.receivedChunks / t.totalChunks) * 100);
  const approxBytes = Math.min(t.size, Math.round((t.receivedChunks / t.totalChunks) * t.size));
  updateFileCardStatus(t.cardEl, `Receiving (${humanSize(approxBytes)} / ${humanSize(t.size)})...`, pct);

  if (t.receivedChunks >= t.totalChunks) {
    finalizeIncomingFile(t);
  }
}

function handleIncomingFileDone(packet) {
  const t = state.incomingTransfers[packet.id];
  if (t && t.receivedChunks >= t.totalChunks) {
    finalizeIncomingFile(t);
  }
}

function handlePeerFileCancel(packet) {
  const id = packet.id;
  const t = state.incomingTransfers[id];
  if (t) {
    updateFileCardDone(t.cardEl, "Transfer cancelled by sender");
    delete state.incomingTransfers[id];
  }
}

async function finalizeIncomingFile(t) {
  if (t.finalized) return;
  t.finalized = true;

  updateFileCardStatus(t.cardEl, "Assembling & decompressing...", 100);

  let combined;
  if (t.totalChunks > 0) {
    const totalBytes = t.chunks.reduce((acc, c) => acc + (c ? c.length : 0), 0);
    combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of t.chunks) {
      if (c) {
        combined.set(c, offset);
        offset += c.length;
      }
    }
  } else {
    combined = new Uint8Array(0);
  }

  let finalBytes = combined;
  if (t.compressed && combined.length > 0) {
    try {
      finalBytes = await decompressDeflateRaw(combined);
    } catch (err) {
      console.warn("Decompression error, using raw:", err);
      finalBytes = combined;
    }
  }

  const blob = new Blob([finalBytes]);
  const blobUrl = URL.createObjectURL(blob);
  t.downloadUrl = blobUrl;
  t.rawBytes = finalBytes;

  state.fileRegistry[t.id] = {
    id: t.id,
    filename: t.filename,
    rawBytes: finalBytes,
    isIncoming: true,
  };

  const isText = isTextFile(t.filename, finalBytes);

  updateFileCardReady(t.cardEl, t.filename, humanSize(finalBytes.length), blobUrl, t.id, isText);
  playChime("msg");
  showToast(`File ready: ${t.filename}`);

  // Automatically trigger download
  triggerDownload(blobUrl, t.filename);
}

function cleanupUserFileTransfers(peerName) {
  for (const [id, t] of Object.entries(state.incomingTransfers)) {
    if (t.from === peerName && !t.finalized) {
      updateFileCardDone(t.cardEl, `${peerName} disconnected`);
      delete state.incomingTransfers[id];
    }
  }
  for (const [id, t] of Object.entries(state.outgoingTransfers)) {
    if (t.acceptedBy === peerName) {
      if (t.timer) clearTimeout(t.timer);
      updateFileCardDone(t.cardEl, `${peerName} disconnected`);
      delete state.outgoingTransfers[id];
    }
  }
}

// FILE CARD UI RENDERERS
function renderOutgoingFileCard(transfer) {
  const timeStr = formatTime(Date.now());
  const row = document.createElement("div");
  row.className = "msg-row self";

  const avatarColor = getAvatarColor(state.username);
  const initial = state.username.charAt(0).toUpperCase();

  row.innerHTML = `
    <div class="msg-avatar" style="background: ${avatarColor}">${initial}</div>
    <div class="msg-bubble-wrap">
      <div class="msg-meta">
        <span>${escapeHTML(state.username)}</span>
        <span>·</span>
        <span>${timeStr}</span>
      </div>
      <div class="file-card" id="file-${transfer.id}">
        <div class="file-card-main">
          <div class="file-card-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          </div>
          <div class="file-card-details">
            <div class="file-card-name" title="${escapeHTML(transfer.filename)}">${escapeHTML(transfer.filename)}</div>
            <div class="file-card-size">${humanSize(transfer.size)}</div>
          </div>
        </div>
        <div class="file-progress-track">
          <div class="file-progress-fill" style="width: 0%;"></div>
        </div>
        <div class="file-card-status">
          <span>Offered to room · Waiting for peer...</span>
          <span class="pct-text">0%</span>
        </div>
      </div>
    </div>
  `;

  elements.messagesStream.appendChild(row);
  scrollToBottom();
  return row.querySelector(`#file-${transfer.id}`);
}

function renderIncomingFileCard(transfer) {
  const timeStr = formatTime(Date.now());
  const row = document.createElement("div");
  row.className = "msg-row peer";

  const avatarColor = getAvatarColor(transfer.from);
  const initial = transfer.from.charAt(0).toUpperCase();

  row.innerHTML = `
    <div class="msg-avatar" style="background: ${avatarColor}">${initial}</div>
    <div class="msg-bubble-wrap">
      <div class="msg-meta">
        <span>${escapeHTML(transfer.from)}</span>
        <span>·</span>
        <span>${timeStr}</span>
      </div>
      <div class="file-card" id="file-${transfer.id}">
        <div class="file-card-main">
          <div class="file-card-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          </div>
          <div class="file-card-details">
            <div class="file-card-name" title="${escapeHTML(transfer.filename)}">${escapeHTML(transfer.filename)}</div>
            <div class="file-card-size">${humanSize(transfer.size)}</div>
          </div>
        </div>
        <div class="file-progress-track hidden">
          <div class="file-progress-fill" style="width: 0%;"></div>
        </div>
        <div class="file-card-status">
          <span>${escapeHTML(transfer.from)} wants to send this file.</span>
          <span class="pct-text"></span>
        </div>
        <div class="file-card-actions">
          <button type="button" class="btn-file primary" onclick="acceptIncomingFile('${transfer.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>Accept</span>
          </button>
          <button type="button" class="btn-file secondary" onclick="rejectIncomingFile('${transfer.id}')">
            <span>Decline</span>
          </button>
        </div>
      </div>
    </div>
  `;

  elements.messagesStream.appendChild(row);
  scrollToBottom();
  return row.querySelector(`#file-${transfer.id}`);
}

function updateFileCardStatus(cardEl, text, pct) {
  if (!cardEl) return;
  const statusSpan = cardEl.querySelector(".file-card-status span:first-child");
  const pctSpan = cardEl.querySelector(".pct-text");
  const fill = cardEl.querySelector(".file-progress-fill");
  const track = cardEl.querySelector(".file-progress-track");

  if (track) track.classList.remove("hidden");
  if (statusSpan) statusSpan.textContent = text;
  if (pctSpan && typeof pct === "number") pctSpan.textContent = `${pct}%`;
  if (fill && typeof pct === "number") fill.style.width = `${pct}%`;
}

function updateFileCardReceiving(cardEl, text) {
  if (!cardEl) return;
  const actions = cardEl.querySelector(".file-card-actions");
  if (actions) actions.remove();
  const track = cardEl.querySelector(".file-progress-track");
  if (track) track.classList.remove("hidden");
  const statusSpan = cardEl.querySelector(".file-card-status span:first-child");
  if (statusSpan) statusSpan.textContent = text;
}

function updateFileCardDone(cardEl, text) {
  if (!cardEl) return;
  const actions = cardEl.querySelector(".file-card-actions");
  if (actions) actions.remove();
  const track = cardEl.querySelector(".file-progress-track");
  if (track) track.classList.add("hidden");
  const statusSpan = cardEl.querySelector(".file-card-status span:first-child");
  if (statusSpan) statusSpan.textContent = text;
  const pctSpan = cardEl.querySelector(".pct-text");
  if (pctSpan) pctSpan.textContent = "";
}

function updateFileCardReady(cardEl, filename, sizeStr, downloadUrl, transferId, isText) {
  if (!cardEl) return;
  const track = cardEl.querySelector(".file-progress-track");
  if (track) track.classList.add("hidden");
  const statusSpan = cardEl.querySelector(".file-card-status span:first-child");
  if (statusSpan) statusSpan.textContent = `✓ Ready (${sizeStr})`;
  const pctSpan = cardEl.querySelector(".pct-text");
  if (pctSpan) pctSpan.textContent = "";

  const actions = cardEl.querySelector(".file-card-actions") || document.createElement("div");
  actions.className = "file-card-actions";
  
  let buttonsHtml = `
    <a class="btn-file download" href="${downloadUrl}" download="${escapeHTML(filename)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
      <span>Download</span>
    </a>
  `;

  if (isText && transferId) {
    buttonsHtml += `
      <button type="button" class="btn-file edit" onclick="openFileEditor('${escapeHTML(transferId)}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
        <span>Edit & Resend</span>
      </button>
    `;
  }

  actions.innerHTML = buttonsHtml;
  if (!cardEl.querySelector(".file-card-actions")) {
    cardEl.appendChild(actions);
  }
}

function updateOutgoingFileCardDone(cardEl, text, transferId, filename, isText) {
  updateFileCardDone(cardEl, text);
  if (isText && transferId && cardEl) {
    let actions = cardEl.querySelector(".file-card-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "file-card-actions";
      cardEl.appendChild(actions);
    }
    actions.innerHTML = `
      <button type="button" class="btn-file edit" onclick="openFileEditor('${escapeHTML(transferId)}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
        <span>Edit & Resend</span>
      </button>
    `;
  }
}

// ============================================================
// BASE64 & DEFLATE-RAW STREAM UTILITIES
// ============================================================

function uint8ToBase64(bytes) {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function base64ToUint8(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function compressDeflateRaw(uint8Array) {
  if (typeof CompressionStream === "undefined") return uint8Array;
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(uint8Array);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    res.set(c, offset);
    offset += c.length;
  }
  return res;
}

async function decompressDeflateRaw(uint8Array) {
  if (typeof DecompressionStream === "undefined") return uint8Array;
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(uint8Array);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    res.set(c, offset);
    offset += c.length;
  }
  return res;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// PARTICIPANTS
function updateParticipants(users) {
  state.participants = users;
  elements.participantCountBadge.textContent = users.length;
  elements.drawerUserCount.textContent = users.length;

  elements.participantsList.innerHTML = users
    .map((u) => {
      const isSelf = u === state.username;
      const initial = u.charAt(0).toUpperCase();
      const color = getAvatarColor(u);
      return `
        <li class="member-item">
          <div class="msg-avatar" style="background: ${color}">${initial}</div>
          <div class="member-meta">
            <span>${escapeHTML(u)}</span>
            ${isSelf ? '<span class="you-tag">You</span>' : ""}
          </div>
        </li>
      `;
    })
    .join("");
}

function toggleParticipantsDrawer() {
  const isHidden = elements.participantsDrawer.classList.contains("hidden");
  if (isHidden) {
    elements.participantsDrawer.classList.remove("hidden");
    elements.drawerBackdrop.classList.remove("hidden");
  } else {
    elements.participantsDrawer.classList.add("hidden");
    elements.drawerBackdrop.classList.add("hidden");
  }
}

// STATUS & UTILS
function setStatus(type, label) {
  let indicatorCls = "status-indicator";
  if (type === "connected") indicatorCls += " live";
  else if (type === "connecting") indicatorCls += " pending";
  elements.statusDot.className = indicatorCls;
  elements.statusText.textContent = label;
}

function leaveRoom() {
  state.room = "";
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  if (elements.chatScreen) {
    elements.chatScreen.style.height = "";
    elements.chatScreen.style.top = "";
  }

  window.history.replaceState({}, "", window.location.pathname);
  elements.chatScreen.classList.remove("active");
  elements.lobbyScreen.classList.add("active");
}

function initMobileViewport() {
  if (!window.visualViewport) return;

  const handleViewportChange = () => {
    if (!elements.chatScreen || !elements.chatScreen.classList.contains("active")) return;

    const vv = window.visualViewport;
    elements.chatScreen.style.height = `${vv.height}px`;
    elements.chatScreen.style.top = `${vv.offsetTop}px`;

    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }

    scrollToBottom();
  };

  window.visualViewport.addEventListener("resize", handleViewportChange);
  window.visualViewport.addEventListener("scroll", () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  });

  elements.chatInput.addEventListener("focus", () => {
    setTimeout(handleViewportChange, 120);
  });
}

function copyInviteLink() {
  const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(state.room)}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast("Invite link copied");
  }).catch(() => {
    prompt("Copy link:", url);
  });
}

function showToast(msg) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 2400);
}

// SOUND EFFECTS
function toggleSound() {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem("cfat_sound", state.soundEnabled);
  updateSoundUI();
  showToast(state.soundEnabled ? "Audio alerts on" : "Audio muted");
}

function updateSoundUI() {
  if (state.soundEnabled) {
    elements.soundIconOn.classList.remove("hidden");
    elements.soundIconOff.classList.add("hidden");
  } else {
    elements.soundIconOn.classList.add("hidden");
    elements.soundIconOff.classList.remove("hidden");
  }
}

function playChime(kind = "msg") {
  if (!state.soundEnabled) return;
  try {
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (state.audioCtx.state === "suspended") {
      state.audioCtx.resume();
    }

    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(state.audioCtx.destination);

    const now = state.audioCtx.currentTime;
    if (kind === "msg") {
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(780, now + 0.08);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.18);
    } else if (kind === "join") {
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(550, now + 0.08);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.18);
    }
  } catch (_) {}
}

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// INLINE FILE EDITOR & RESEND
// ============================================================

function isTextFile(filename, uint8Array) {
  const textExtensions = [
    "txt", "text", "md", "markdown", "json", "js", "mjs", "cjs", "jsx", "ts", "tsx",
    "html", "htm", "css", "scss", "sass", "less", "py", "c", "cpp", "h", "hpp",
    "cs", "java", "go", "rs", "php", "rb", "sh", "bash", "zsh", "bat", "cmd",
    "ps1", "yaml", "yml", "toml", "ini", "conf", "config", "env", "xml", "svg",
    "sql", "csv", "tsv", "log", "diff", "patch", "dockerfile", "gitignore"
  ];
  const parts = (filename || "").toLowerCase().split(".");
  const ext = parts.length > 1 ? parts.pop() : "";
  if (ext && textExtensions.includes(ext)) return true;
  if ((filename || "").startsWith(".") && textExtensions.includes((filename || "").slice(1).toLowerCase())) return true;

  if (uint8Array && uint8Array.length > 0) {
    const sampleLen = Math.min(uint8Array.length, 2048);
    for (let i = 0; i < sampleLen; i++) {
      if (uint8Array[i] === 0) return false;
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(uint8Array.subarray(0, sampleLen));
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function openFileEditor(transferId) {
  const fileData = state.fileRegistry[transferId] || state.incomingTransfers[transferId] || state.outgoingTransfers[transferId];
  if (!fileData) {
    return showToast("File data not available");
  }

  const rawBytes = fileData.rawBytes || fileData.payload;
  let text = "";
  if (rawBytes) {
    try {
      text = new TextDecoder("utf-8").decode(rawBytes);
    } catch (err) {
      console.error("Failed to decode text:", err);
      return showToast("Cannot edit non-UTF8 file");
    }
  }

  state.activeEditingTransferId = transferId;
  if (elements.editorFilename) {
    elements.editorFilename.value = fileData.filename || "demo.txt";
  }
  if (elements.fileEditorTextarea) {
    elements.fileEditorTextarea.value = text;
  }
  updateEditorStats();

  if (elements.fileEditorModal) {
    elements.fileEditorModal.classList.remove("hidden");
    elements.fileEditorModal.setAttribute("aria-hidden", "false");
    setTimeout(() => {
      elements.fileEditorTextarea?.focus();
    }, 50);
  }
}

function closeFileEditor() {
  if (elements.fileEditorModal) {
    elements.fileEditorModal.classList.add("hidden");
    elements.fileEditorModal.setAttribute("aria-hidden", "true");
  }
  state.activeEditingTransferId = null;
}

function handleModalBackdropClick(event) {
  if (event.target === elements.fileEditorModal) {
    closeFileEditor();
  }
}

function updateEditorStats() {
  if (!elements.fileEditorTextarea || !elements.editorStatsInfo) return;
  const val = elements.fileEditorTextarea.value || "";
  const lines = val ? val.split("\n").length : 0;
  const chars = val.length;
  const bytes = new Blob([val]).size;
  elements.editorStatsInfo.textContent = `Lines: ${lines.toLocaleString()} · Chars: ${chars.toLocaleString()} · ${humanSize(bytes)}`;
}

function handleEditorKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    saveAndResendFile();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeFileEditor();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const textarea = e.target;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    textarea.value = val.substring(0, start) + "  " + val.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    updateEditorStats();
  }
}

async function saveAndResendFile() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return showToast("Not connected to room");
  }

  const text = elements.fileEditorTextarea ? elements.fileEditorTextarea.value : "";
  let filename = elements.editorFilename ? elements.editorFilename.value.trim() : "";
  if (!filename) filename = "demo.txt";

  closeFileEditor();

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const file = new File([blob], filename, { type: "text/plain;charset=utf-8" });

  showToast(`Broadcasting edited ${filename}...`);
  await sendFile(file);
}

function downloadEditedFile() {
  const text = elements.fileEditorTextarea ? elements.fileEditorTextarea.value : "";
  let filename = elements.editorFilename ? elements.editorFilename.value.trim() : "";
  if (!filename) filename = "edited_file.txt";

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  showToast(`Saved copy of ${filename}`);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && elements.fileEditorModal && !elements.fileEditorModal.classList.contains("hidden")) {
    closeFileEditor();
  }
});
