/**
 * CFAT Chat - Room Messaging Client
 * chat.cfat.site
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
  soundIconOn: document.getElementById("sound-icon-on"),
  soundIconOff: document.getElementById("sound-icon-off"),
  toastContainer: document.getElementById("toast-container"),
};

// Curated architectural color palette for avatars (no random rainbow hues)
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

// Initialization
document.addEventListener("DOMContentLoaded", async () => {
  updateSoundUI();
  initMobileViewport();

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
  const prefix = "CFAT";
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${num}`;
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
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    targetWs = `${proto}//${window.location.host}/ws`;
  }

  const endpoint = `${targetWs}?room=${encodeURIComponent(state.room)}&user=${encodeURIComponent(state.username)}`;

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
      break;

    case "chat":
      renderChatMessage(packet.user, packet.message, packet.timestamp);
      if (packet.user !== state.username) {
        playChime("msg");
      }
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

// Mobile Viewport Handler (Messenger-style fixed header, scrollable messages)
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

// SOUND EFFECTS (Web Audio API Synthesizer - Clean clicks/tones)
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
