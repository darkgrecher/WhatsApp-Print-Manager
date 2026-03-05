const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const mime = require("mime-types");
const { autoUpdater } = require("electron-updater");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  makeInMemoryStore,
  getContentType,
  fetchLatestBaileysVersion,
  isLidUser,
} = require("@whiskeysockets/baileys");

// ── Globals ──────────────────────────────────────────────────────────────────
let mainWindow;
let updateWindow;
let updateCancelled = false;
let sock; // Baileys WebSocket
let isClientReady = false;
let DOWNLOADS_DIR;

// License server URL (change this to your production backend URL)
const LICENSE_API_URL = "https://whatsapp-print-admin.vercel.app/api";

// Baileys logger — silent to keep console clean
const baileysLogger = pino({ level: "silent" });

// In-memory store for chats, contacts, messages
let store = makeInMemoryStore({ logger: baileysLogger });
let storeSaveTimer = null;

// Track the current account's JID so we can detect account switches
let currentAccountJid = null;

// Ensure the re-auth check only runs once per app lifecycle (not on reconnects)
let hasCheckedReauth = false;

// Debounced chat-update notification — avoids flooding the renderer
let chatsUpdatedTimer = null;
function notifyChatsUpdated() {
  if (chatsUpdatedTimer) clearTimeout(chatsUpdatedTimer);
  chatsUpdatedTimer = setTimeout(() => {
    chatsUpdatedTimer = null;
    mainWindow?.webContents?.send("whatsapp:chats-updated");
  }, 500);
}

/**
 * Path to the persisted store file.
 */
function getStorePath() {
  return getUserDataPath("baileys_store.json");
}

/**
 * Path to the marker that records whether a full history sync has completed.
 */
function getSyncMarkerPath() {
  return getUserDataPath(".history_synced");
}

function isHistorySynced() {
  return fs.existsSync(getSyncMarkerPath());
}

function markHistorySynced() {
  try {
    fs.writeFileSync(getSyncMarkerPath(), Date.now().toString());
  } catch (_) {}
}

function clearSyncMarker() {
  try {
    if (fs.existsSync(getSyncMarkerPath())) fs.unlinkSync(getSyncMarkerPath());
  } catch (_) {}
}

/**
 * Load the store from disk if available.
 */
function loadStoreFromDisk() {
  const storePath = getStorePath();
  try {
    if (fs.existsSync(storePath)) {
      store.readFromFile(storePath);
      console.log(
        `[WhatsApp] Store loaded from disk (${getAllStoreChats().length} chats)`,
      );
    }
  } catch (err) {
    console.error("[WhatsApp] Failed to read store from disk:", err.message);
  }
}

/**
 * Start periodic store saving to disk.
 */
function startStorePersistence() {
  if (storeSaveTimer) clearInterval(storeSaveTimer);
  storeSaveTimer = setInterval(() => {
    try {
      store.writeToFile(getStorePath());
    } catch (_) {}
  }, 15000); // save every 15 seconds
}

/**
 * Stop periodic store saving.
 */
function stopStorePersistence() {
  if (storeSaveTimer) {
    clearInterval(storeSaveTimer);
    storeSaveTimer = null;
  }
}

/**
 * Reset the in-memory store and delete persisted file.
 */
function resetStore() {
  stopStorePersistence();
  store = makeInMemoryStore({ logger: baileysLogger });
  currentAccountJid = null;
  // Delete persisted store file and sync marker
  try {
    const storePath = getStorePath();
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  } catch (_) {}
  clearSyncMarker();
  console.log("[WhatsApp] Store cleared");
}

function getUserDataPath(...segments) {
  return path.join(app.getPath("userData"), ...segments);
}

function ensureDownloadsDir() {
  DOWNLOADS_DIR = getUserDataPath("downloads");
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
}

// ── Cleanup helpers ──────────────────────────────────────────────────────────

/**
 * Clear Electron's GPU disk-cache to avoid "Unable to move the cache" errors.
 */
function cleanupGpuCache() {
  const gpuCachePath = path.join(app.getPath("userData"), "GPUCache");
  try {
    if (fs.existsSync(gpuCachePath)) {
      fs.rmSync(gpuCachePath, { recursive: true, force: true });
      console.log("[Cleanup] Cleared GPU cache");
    }
  } catch (_) {}
}

// ── Electron Window ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "WhatsApp Print Manager",
    icon: path.join(__dirname, "src", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
  mainWindow.setMenuBarVisibility(false);

  // Open DevTools in dev mode
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

// ── Baileys Helpers ──────────────────────────────────────────────────────────

/** Media message type keys we care about */
const MEDIA_TYPES = new Set([
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "audioMessage",
  "stickerMessage",
  "pttMessage",
]);

/**
 * Extract media info from a Baileys WAMessage.
 * Handles wrappers like viewOnce, ephemeral, documentWithCaption.
 */
function getMediaInfo(msg) {
  if (!msg?.message) return null;

  let content = msg.message;
  if (content.ephemeralMessage) content = content.ephemeralMessage.message;
  if (content.viewOnceMessage) content = content.viewOnceMessage.message;
  if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
  if (content.documentWithCaptionMessage)
    content = content.documentWithCaptionMessage.message;

  if (!content) return null;

  for (const [key, value] of Object.entries(content)) {
    if (MEDIA_TYPES.has(key) && value) {
      return {
        type: key.replace("Message", ""),
        content: value,
        mimetype: value.mimetype || null,
        fileName: value.fileName || value.title || null,
        fileSize: value.fileLength ? Number(value.fileLength) : null,
        caption: value.caption || "",
      };
    }
  }
  return null;
}

/**
 * Get text body from any message type.
 */
function getMessageBody(msg) {
  if (!msg?.message) return "";
  const type = getContentType(msg.message);
  if (type === "conversation") return msg.message.conversation || "";
  if (type === "extendedTextMessage")
    return msg.message.extendedTextMessage?.text || "";
  const media = getMediaInfo(msg);
  if (media?.caption) return media.caption;
  return "";
}

/**
 * Serialize a Baileys message key into a string ID.
 */
function serializeMessageId(key) {
  return `${key.fromMe ? "true" : "false"}_${key.remoteJid}_${key.id}`;
}

/**
 * Convert Baileys timestamp (possibly a Long/object) to a unix timestamp.
 */
function toTimestamp(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts === "object" && ts.low !== undefined) return ts.low;
  return Number(ts) || 0;
}

/**
 * Get the best available timestamp for a chat, falling back to its latest message.
 */
function getChatTimestamp(chat) {
  const ts = toTimestamp(chat.conversationTimestamp || chat.timestamp);
  if (ts > 0) return ts;
  // Fallback: use the most recent message timestamp
  const msgs = getStoreMessages(chat.id);
  if (msgs.length > 0) {
    return toTimestamp(msgs[msgs.length - 1].messageTimestamp);
  }
  return 0;
}

/**
 * Get all chats from the store, safely handling different store interfaces.
 * Includes LID-format chats (modern WhatsApp uses LID for most conversations).
 */
function getAllStoreChats() {
  try {
    let chats = [];
    // KeyedDB (Baileys 6.6.0 default)
    if (typeof store.chats?.all === "function") {
      chats = store.chats.all();
    }
    // Map-like fallback
    else if (typeof store.chats?.values === "function") {
      chats = Array.from(store.chats.values());
    }
    // Array fallback
    else if (Array.isArray(store.chats)) {
      chats = store.chats;
    }

    // Also include chats that only exist in the messages store (e.g. groups)
    const chatIds = new Set(chats.map((c) => c.id));
    for (const jid of Object.keys(store.messages || {})) {
      if (!chatIds.has(jid)) {
        chats.push({ id: jid });
        chatIds.add(jid);
      }
    }

    return [...chats]
      .filter((c) => {
        if (!c.id) return false;
        // Skip system/broadcast JIDs
        if (c.id === "status@broadcast" || c.id === "0@s.whatsapp.net")
          return false;
        return true;
      })
      .sort((a, b) => getChatTimestamp(b) - getChatTimestamp(a));
  } catch (err) {
    console.error("[WhatsApp] getAllStoreChats error:", err.message);
    return [];
  }
}

/**
 * Get messages for a JID from the store, safely handling interfaces.
 */
function getStoreMessages(jid) {
  try {
    const msgs = store.messages[jid];
    if (!msgs) return [];
    if (Array.isArray(msgs.array)) return msgs.array;
    if (Array.isArray(msgs)) return msgs;
    return [];
  } catch {
    return [];
  }
}

/**
 * Get a contact from the store.
 */
function getContact(jid) {
  if (!store.contacts) return null;
  return store.contacts[jid] || null;
}

/**
 * Resolve the best display name for a chat JID.
 * For LID chats, look up the contact notify/name and fall back to pushName from messages.
 * For phone JIDs, use phone number as fallback.
 */
function resolveChatName(jid) {
  const chat = store.chats?.get?.(jid);
  const contact = getContact(jid);
  const savedName = chat?.name || contact?.name || "";
  const whatsappName = contact?.notify || "";

  if (savedName) return savedName;
  if (whatsappName) return whatsappName;

  // For non-LID JIDs, we can extract a phone number
  if (!isLidUser(jid) && !jid.endsWith("@g.us")) {
    return jid.split("@")[0].split(":")[0];
  }

  // For LID JIDs: try to find a pushName from recent messages
  const msgs = getStoreMessages(jid);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].pushName) return msgs[i].pushName;
  }

  // For groups, return an identifier
  if (jid.endsWith("@g.us")) return `Group ${jid.split("@")[0]}`;

  return jid.split("@")[0];
}

/**
 * Extract a phone number from a JID if possible.
 * LID JIDs don't contain a phone number, so returns empty string.
 */
function extractPhoneNumber(jid) {
  if (!jid) return "";
  if (jid.endsWith("@g.us") || isLidUser(jid)) return "";
  return jid.split("@")[0].split(":")[0];
}

/**
 * Find a message in the store by serialized messageId within a chat.
 * Serialized format: "fromMe_remoteJid_keyId"
 */
function findMessageInStore(chatId, messageId) {
  const msgs = getStoreMessages(chatId);
  // Extract key.id robustly: skip the first two segments (fromMe, remoteJid)
  const idx1 = messageId.indexOf("_");
  const idx2 = idx1 >= 0 ? messageId.indexOf("_", idx1 + 1) : -1;
  const keyId = idx2 >= 0 ? messageId.substring(idx2 + 1) : messageId;
  return msgs.find((m) => m.key.id === keyId) || null;
}

// ── WhatsApp Client (Baileys) ────────────────────────────────────────────────
async function initWhatsApp() {
  const authPath = getUserDataPath(".baileys_auth");
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  // Load cached store from disk (so chats show immediately on reconnect)
  loadStoreFromDisk();

  // On the very first init of this app session, check whether the previous
  // auth session never received a full history sync. If so, force re-auth so
  // shouldSyncHistoryMessage can run on the fresh connection.
  // This must NOT run on reconnects (status 515) or we'd wipe the auth mid-scan.
  if (!hasCheckedReauth) {
    hasCheckedReauth = true;
    const credsFile = path.join(authPath, "creds.json");
    let wasAuthenticated = false;
    try {
      if (fs.existsSync(credsFile)) {
        const creds = JSON.parse(fs.readFileSync(credsFile, "utf8"));
        wasAuthenticated = !!creds.me;
      }
    } catch (_) {}

    if (wasAuthenticated && !isHistorySynced()) {
      console.log(
        "[WhatsApp] Previously authenticated but history never synced — forcing re-auth",
      );
      try {
        fs.rmSync(authPath, { recursive: true, force: true });
        fs.mkdirSync(authPath, { recursive: true });
      } catch (err) {
        console.error("[WhatsApp] Failed to clear auth:", err.message);
      }
      // Also clear the partial store
      resetStore();
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
    console.log(`[WhatsApp] Using WA version: ${version.join(".")}`);
  } catch (err) {
    console.warn("[WhatsApp] Could not fetch latest version, using default");
    version = undefined; // Baileys will use its bundled default
  }

  const socketOptions = {
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger,
    markOnlineOnConnect: false,
    // Request history sync so chats are populated on reconnect
    shouldSyncHistoryMessage: () => true,
  };
  if (version) socketOptions.version = version;

  sock = makeWASocket(socketOptions);

  // Bind the built-in store to capture chats, contacts, messages
  store.bind(sock.ev);

  // Start persisting store to disk
  startStorePersistence();

  // Persist credentials
  sock.ev.on("creds.update", saveCreds);

  // ── Connection updates (QR, auth, ready, disconnect) ──
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code — arrives within seconds, no browser needed
    if (qr) {
      console.log("[WhatsApp] QR code received");
      try {
        const qrDataURL = await QRCode.toDataURL(qr, {
          width: 280,
          margin: 2,
        });
        mainWindow?.webContents?.send("whatsapp:qr", qrDataURL);
      } catch (err) {
        console.error("QR generation error:", err);
      }
    }

    if (connection === "connecting") {
      console.log("[WhatsApp] Connecting...");
    }

    if (connection === "open") {
      console.log("[WhatsApp] Connected");

      // Track the current account JID
      const newJid = sock.user?.id;
      if (currentAccountJid && newJid && currentAccountJid !== newJid) {
        // Account switched — wipe the old store data
        console.log(
          `[WhatsApp] Account changed (${currentAccountJid} -> ${newJid}), clearing store`,
        );
        resetStore();
        store.bind(sock.ev);
      }
      currentAccountJid = newJid;

      mainWindow?.webContents?.send("whatsapp:status", "authenticated");

      // If we have cached chats from disk, go ready quickly
      const cachedCount = getAllStoreChats().length;
      if (cachedCount > 0) {
        console.log(
          `[WhatsApp] ${cachedCount} cached chats available, going ready immediately`,
        );
        mainWindow?.webContents?.send("whatsapp:loading", {
          percent: 100,
          message: `Loaded ${cachedCount} chats`,
        });
        isClientReady = true;
        mainWindow?.webContents?.send("whatsapp:status", "ready");
      } else {
        mainWindow?.webContents?.send("whatsapp:loading", {
          percent: 30,
          message: "Connected. Waiting for chat sync...",
        });
        // Wait for chats to arrive from history sync
        waitForChatsAndReady();
      }
    }

    if (connection === "close") {
      isClientReady = false;

      // Save store to disk before disconnecting
      try {
        store.writeToFile(getStorePath());
      } catch (_) {}

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[WhatsApp] Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`,
      );

      if (statusCode === DisconnectReason.loggedOut) {
        mainWindow?.webContents?.send("whatsapp:status", "logged_out");
        resetStore(); // clear stale data on logout
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
        } catch (_) {}
      } else if (shouldReconnect) {
        mainWindow?.webContents?.send("whatsapp:status", "retrying");
        setTimeout(() => {
          initWhatsApp().catch((err) => {
            console.error("[WhatsApp] Reconnect failed:", err.message);
            mainWindow?.webContents?.send("whatsapp:status", "error");
          });
        }, 3000);
      } else {
        mainWindow?.webContents?.send("whatsapp:status", "disconnected");
      }
    }
  });

  // ── History sync tracking ──
  sock.ev.on("messaging-history.set", ({ chats: syncedChats, isLatest }) => {
    const totalChats = getAllStoreChats().length;
    console.log(
      `[WhatsApp] History sync: +${syncedChats?.length || 0} chats (total: ${totalChats}, isLatest: ${isLatest})`,
    );
    mainWindow?.webContents?.send("whatsapp:loading", {
      percent: Math.min(90, 30 + totalChats),
      message: `Syncing chats... (${totalChats} loaded)`,
    });
    // Persist immediately so synced chats survive a crash
    try {
      store.writeToFile(getStorePath());
    } catch (_) {}
    // Mark sync complete once the final batch arrives
    if (isLatest) {
      markHistorySynced();
      console.log(
        `[WhatsApp] History sync complete — ${totalChats} chats cached`,
      );
    }
    // Notify renderer so chat list updates as history batches arrive
    notifyChatsUpdated();
  });

  sock.ev.on("chats.upsert", (newChats) => {
    const total = getAllStoreChats().length;
    console.log(
      `[WhatsApp] chats.upsert: +${newChats?.length || 0} (total: ${total})`,
    );
    // Persist new chats promptly
    try {
      store.writeToFile(getStorePath());
    } catch (_) {}
    // Notify renderer that the chat list changed
    notifyChatsUpdated();
  });

  // ── Chat metadata updates (unread count, timestamp, name changes) ──
  sock.ev.on("chats.update", (updates) => {
    console.log(
      `[WhatsApp] chats.update: ${updates?.length || 0} chats updated`,
    );
    // The in-memory store already applies the updates; notify renderer
    notifyChatsUpdated();
  });

  sock.ev.on("chats.delete", (deletions) => {
    console.log(
      `[WhatsApp] chats.delete: ${deletions?.length || 0} chats removed`,
    );
    notifyChatsUpdated();
  });

  // ── Contact updates (so chat names display correctly) ──
  sock.ev.on("contacts.upsert", (contacts) => {
    console.log(`[WhatsApp] contacts.upsert: ${contacts?.length || 0}`);
    notifyChatsUpdated();
  });

  sock.ev.on("contacts.update", (updates) => {
    console.log(`[WhatsApp] contacts.update: ${updates?.length || 0}`);
    notifyChatsUpdated();
  });

  // ── Real-time incoming message listener ──
  sock.ev.on("messages.upsert", async ({ messages: newMessages, type }) => {
    if (type !== "notify") return;

    for (const msg of newMessages) {
      // For outgoing messages, just trigger a chat list refresh (chat moves to top)
      if (msg.key.fromMe) {
        notifyChatsUpdated();
        continue;
      }

      const jid = msg.key.remoteJid;
      if (!jid || jid === "status@broadcast") continue;

      const isGroup = jid.endsWith("@g.us");
      const contactNumber = extractPhoneNumber(jid);
      const contact = getContact(jid);
      const senderName =
        msg.pushName ||
        contact?.notify ||
        contact?.name ||
        contactNumber ||
        jid.split("@")[0];

      const chatName = resolveChatName(jid);

      const chatInfo = store.chats?.get?.(jid);
      const media = getMediaInfo(msg);
      const hasMedia = media !== null;

      const messageData = {
        chatId: jid,
        chatName,
        contactNumber,
        isGroup,
        unreadCount: chatInfo?.unreadCount || 0,
        messageId: serializeMessageId(msg.key),
        hasMedia,
        type:
          media?.type ||
          (msg.message
            ? (getContentType(msg.message) || "").replace("Message", "")
            : "unknown"),
        body: getMessageBody(msg),
        timestamp: toTimestamp(msg.messageTimestamp),
        sender: senderName,
      };

      // Auto-download media
      if (hasMedia) {
        messageData.fileName = media.fileName;
        messageData.mimeType = media.mimetype;
        messageData.fileSize = media.fileSize;

        if (!messageData.fileName) {
          const ext =
            mime.extension(
              messageData.mimeType || "application/octet-stream",
            ) || "bin";
          messageData.fileName = `${media.type || "file"}_${messageData.timestamp}.${ext}`;
        }

        try {
          const buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            {
              logger: baileysLogger,
              reuploadRequest: sock?.updateMediaMessage,
            },
          );
          if (buffer) {
            const safeMsgId = messageData.messageId.replace(
              /[^a-zA-Z0-9]/g,
              "_",
            );
            const localPath = path.join(
              DOWNLOADS_DIR,
              `${safeMsgId}_${messageData.fileName}`,
            );
            fs.writeFileSync(localPath, buffer);
            messageData.autoDownloaded = true;
            messageData.localPath = localPath;
            console.log(
              `[WhatsApp] Auto-downloaded media: ${messageData.fileName}`,
            );
          }
        } catch (dlErr) {
          console.error("[WhatsApp] Auto-download failed:", dlErr.message);
        }
      }

      console.log(
        `[WhatsApp] New message from ${jid}: type=${messageData.type}, hasMedia=${hasMedia}`,
      );
      mainWindow?.webContents?.send("whatsapp:new-message", messageData);
    }
  });
}

// ── Utility Helpers ──────────────────────────────────────────────────────────

/**
 * Fetches a profile picture URL and returns it as a base64 data URI.
 */
async function fetchProfilePicAsDataUri(url) {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "image/jpeg";
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Utility: run a promise with a timeout. Resolves to fallback on timeout.
 */
function withTimeout(promise, ms, fallback = null) {
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * After connection opens, poll for chats to arrive from history sync.
 * Marks ready once chats appear or after a maximum wait.
 */
function waitForChatsAndReady() {
  const MAX_WAIT_MS = 45000; // 45 seconds max for very large accounts
  const POLL_MS = 1000;
  const startTime = Date.now();

  const poll = () => {
    const elapsed = Date.now() - startTime;
    const chatCount = getAllStoreChats().length;

    console.log(
      `[WhatsApp] Sync poll: ${chatCount} chats after ${Math.round(elapsed / 1000)}s`,
    );

    if (chatCount > 0 || elapsed >= MAX_WAIT_MS) {
      // Chats arrived or timeout reached — declare ready
      mainWindow?.webContents?.send("whatsapp:loading", {
        percent: 100,
        message: chatCount > 0 ? `Loaded ${chatCount} chats` : "Ready",
      });
      isClientReady = true;
      mainWindow?.webContents?.send("whatsapp:status", "ready");
      console.log(
        `[WhatsApp] Ready with ${chatCount} chats after ${Math.round(elapsed / 1000)}s`,
      );
      return;
    }

    // Still waiting — update progress
    const pct = Math.min(90, 30 + Math.round((elapsed / MAX_WAIT_MS) * 60));
    mainWindow?.webContents?.send("whatsapp:loading", {
      percent: pct,
      message: "Syncing chats...",
    });
    setTimeout(poll, POLL_MS);
  };

  setTimeout(poll, POLL_MS);
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

// Get all chats
ipcMain.handle("get-unread-chats", async () => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const chats = getAllStoreChats();
    console.log(`[WhatsApp] get-unread-chats: returning ${chats.length} chats`);
    if (chats.length === 0) return { chats: [] };

    const result = chats.map((chat) => {
      const jid = chat.id;
      const isGroup = jid.endsWith("@g.us");
      const contactNumber = extractPhoneNumber(jid);
      const displayName = resolveChatName(jid);
      const contact = getContact(jid);
      const whatsappName = contact?.notify || "";

      // Last message preview (synchronous — from in-memory store)
      let lastMessage = "";
      try {
        const msgs = getStoreMessages(jid);
        if (msgs.length > 0) {
          const lastMsg = msgs[msgs.length - 1];
          const media = getMediaInfo(lastMsg);
          if (media) {
            lastMessage = `[${media.type}]`;
          } else {
            lastMessage = (getMessageBody(lastMsg) || "").substring(0, 50);
          }
        }
      } catch (_) {}

      return {
        id: jid,
        name: displayName,
        number: contactNumber,
        whatsappName,
        unreadCount: chat.unreadCount || 0,
        isGroup,
        profilePicUrl: null, // loaded lazily via get-profile-pic
        timestamp: getChatTimestamp(chat),
        lastMessage,
      };
    });

    result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return { chats: result };
  } catch (err) {
    console.error("Error getting chats:", err);
    return { error: err.message };
  }
});

// Get ALL chats — for the "All Chats" view
ipcMain.handle("get-all-chats", async (event, { limit = 30 } = {}) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const chats = getAllStoreChats().slice(0, limit);

    const result = chats.map((chat) => {
      const jid = chat.id;
      const isGroup = jid.endsWith("@g.us");
      const contactNumber = extractPhoneNumber(jid);
      const contactName = resolveChatName(jid);

      return {
        id: jid,
        name: contactName,
        number: contactNumber,
        unreadCount: chat.unreadCount || 0,
        isGroup,
        timestamp: getChatTimestamp(chat),
      };
    });

    return { chats: result };
  } catch (err) {
    return { error: err.message };
  }
});

// Get messages with media for a specific chat
ipcMain.handle("get-chat-files", async (event, chatId) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const allMessages = getStoreMessages(chatId);
    const messages = allMessages.slice(-50);

    const chatInfo = store.chats?.get?.(chatId) || null;
    const unreadCount = chatInfo?.unreadCount || 0;

    // Determine which messages are unread
    const sortedMsgs = [...messages].sort(
      (a, b) =>
        toTimestamp(a.messageTimestamp) - toTimestamp(b.messageTimestamp),
    );
    const unreadMsgIds = new Set();
    if (unreadCount > 0) {
      const unreadSlice = sortedMsgs.slice(-unreadCount);
      unreadSlice.forEach((m) => unreadMsgIds.add(serializeMessageId(m.key)));
    }

    const files = [];
    for (const msg of messages) {
      const media = getMediaInfo(msg);
      if (!media) continue;

      const msgId = serializeMessageId(msg.key);

      // Sender info
      let senderName = "Unknown";
      if (msg.key.fromMe) {
        senderName = "You";
      } else if (msg.pushName) {
        senderName = msg.pushName;
      } else {
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const contact = getContact(senderJid);
        senderName =
          contact?.notify ||
          contact?.name ||
          senderJid?.split("@")[0] ||
          "Unknown";
      }

      let fileName = media.fileName;
      if (!fileName) {
        const ext =
          mime.extension(media.mimetype || "application/octet-stream") || "bin";
        fileName = `${media.type || "file"}_${toTimestamp(msg.messageTimestamp)}.${ext}`;
      }

      // Check if already downloaded
      const safeMsgId = msgId.replace(/[^a-zA-Z0-9]/g, "_");
      const expectedPath = path.join(DOWNLOADS_DIR, `${safeMsgId}_${fileName}`);
      const isDownloaded = fs.existsSync(expectedPath);

      files.push({
        messageId: msgId,
        chatId,
        sender: senderName,
        timestamp: toTimestamp(msg.messageTimestamp),
        type: media.type,
        caption: media.caption,
        fileName,
        mimeType: media.mimetype,
        fileSize: media.fileSize,
        isDownloaded,
        localPath: isDownloaded ? expectedPath : null,
        isUnread: unreadMsgIds.has(msgId),
      });
    }

    files.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return { files, unreadCount };
  } catch (err) {
    console.error("Error getting chat files:", err);
    return { error: err.message };
  }
});

// Download a specific media file
ipcMain.handle(
  "download-file",
  async (event, { messageId, chatId, fileName }) => {
    if (!isClientReady) return { error: "WhatsApp not ready" };

    try {
      const msg = findMessageInStore(chatId, messageId);
      if (!msg) return { error: "Message not found" };

      const media = getMediaInfo(msg);
      if (!media) return { error: "Message has no media" };

      mainWindow?.webContents?.send("download:progress", {
        messageId,
        status: "downloading",
      });

      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger: baileysLogger,
          reuploadRequest: sock?.updateMediaMessage,
        },
      );
      if (!buffer) return { error: "Failed to download media" };

      let finalFileName = fileName || media.fileName;
      if (!finalFileName) {
        const ext = mime.extension(media.mimetype) || "bin";
        finalFileName = `file_${Date.now()}.${ext}`;
      }

      const safeMsgId = messageId.replace(/[^a-zA-Z0-9]/g, "_");
      const localPath = path.join(
        DOWNLOADS_DIR,
        `${safeMsgId}_${finalFileName}`,
      );

      fs.writeFileSync(localPath, buffer);

      mainWindow?.webContents?.send("download:progress", {
        messageId,
        status: "complete",
      });

      return {
        success: true,
        localPath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (err) {
      console.error("Error downloading file:", err);
      mainWindow?.webContents?.send("download:progress", {
        messageId,
        status: "error",
      });
      return { error: err.message };
    }
  },
);

// Download ALL files from a chat
ipcMain.handle("download-all-files", async (event, chatId) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const allMessages = getStoreMessages(chatId);
    const mediaMessages = allMessages.filter((m) => getMediaInfo(m) !== null);

    const results = [];
    for (let i = 0; i < mediaMessages.length; i++) {
      const msg = mediaMessages[i];
      const msgId = serializeMessageId(msg.key);

      mainWindow?.webContents?.send("download:bulk-progress", {
        current: i + 1,
        total: mediaMessages.length,
        messageId: msgId,
      });

      try {
        const media = getMediaInfo(msg);
        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: baileysLogger,
            reuploadRequest: sock?.updateMediaMessage,
          },
        );

        if (!buffer) {
          results.push({ messageId: msgId, error: "Failed to download" });
          continue;
        }

        let finalFileName = media.fileName;
        if (!finalFileName) {
          const ext = mime.extension(media.mimetype) || "bin";
          finalFileName = `${media.type || "file"}_${toTimestamp(msg.messageTimestamp)}.${ext}`;
        }

        const safeMsgId = msgId.replace(/[^a-zA-Z0-9]/g, "_");
        const localPath = path.join(
          DOWNLOADS_DIR,
          `${safeMsgId}_${finalFileName}`,
        );

        fs.writeFileSync(localPath, buffer);

        results.push({
          messageId: msgId,
          success: true,
          localPath,
          fileName: finalFileName,
          size: buffer.length,
        });
      } catch (dlErr) {
        results.push({ messageId: msgId, error: dlErr.message });
      }
    }

    return { results };
  } catch (err) {
    console.error("Error downloading all files:", err);
    return { error: err.message };
  }
});

// Print files with printer driver setup dialog
ipcMain.handle(
  "print-with-setup",
  async (event, { filePaths, printerName }) => {
    const { exec, execFile } = require("child_process");
    const results = [];

    // Resolve the actual printer name (if empty, find Windows default)
    let targetPrinter = printerName;
    if (!targetPrinter) {
      try {
        targetPrinter = await new Promise((resolve, reject) => {
          exec(
            'powershell -Command "(Get-CimInstance Win32_Printer | Where-Object Default -eq $true).Name"',
            (err, stdout) => {
              if (err) reject(err);
              else resolve(stdout.trim());
            },
          );
        });
      } catch (e) {
        console.error("Could not detect default printer:", e);
        return {
          error: "No printer selected and could not detect default printer",
        };
      }
    }

    if (!targetPrinter) {
      return { error: "No printer available" };
    }

    // Step 1: Open the printer driver's Printing Preferences dialog
    try {
      console.log(`[Print] Opening preferences for printer: ${targetPrinter}`);
      await new Promise((resolve, reject) => {
        const cmd = `printui /e /n "${targetPrinter.replace(/"/g, '\\"')}"  `;
        exec(cmd, (error) => {
          if (error) {
            console.error("[Print] Preferences dialog error:", error.message);
          }
          resolve();
        });
      });
    } catch (e) {
      console.error("[Print] Failed to open preferences:", e);
    }

    // Step 2: Print each file
    for (const filePath of filePaths) {
      try {
        if (!fs.existsSync(filePath)) {
          results.push({ filePath, error: "File not found" });
          continue;
        }

        const ext = path.extname(filePath).toLowerCase();
        const isPDF = ext === ".pdf";
        const imageExts = [
          ".jpg",
          ".jpeg",
          ".png",
          ".bmp",
          ".gif",
          ".tiff",
          ".tif",
          ".webp",
        ];
        const isImage = imageExts.includes(ext);

        if (isPDF) {
          const ptp = require("pdf-to-printer");
          await ptp.print(filePath, { printer: targetPrinter });
          results.push({ filePath, success: true, method: "pdf-to-printer" });
        } else if (isImage) {
          await new Promise((resolve, reject) => {
            execFile(
              "mspaint.exe",
              ["/pt", filePath, targetPrinter],
              (error) => {
                if (error) reject(error);
                else resolve();
              },
            );
          });
          results.push({ filePath, success: true, method: "mspaint-print" });
        } else {
          shell.openPath(filePath);
          results.push({ filePath, success: true, method: "default-app" });
        }
      } catch (err) {
        console.error(`[Print] Error printing ${filePath}:`, err);
        results.push({ filePath, error: err.message });
      }
    }

    return { results };
  },
);

// Get available printers
ipcMain.handle("get-printers", async () => {
  try {
    const { exec } = require("child_process");
    const printers = await new Promise((resolve, reject) => {
      exec(
        'powershell -Command "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name"',
        (err, stdout) => {
          if (err) reject(err);
          else {
            const names = stdout
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            resolve(names.map((name) => ({ name })));
          }
        },
      );
    });
    return { printers };
  } catch (err) {
    return { error: err.message, printers: [] };
  }
});

// Open downloads folder
ipcMain.handle("open-downloads-folder", async () => {
  shell.openPath(DOWNLOADS_DIR);
  return { success: true };
});

// Open a specific file
ipcMain.handle("open-file", async (event, filePath) => {
  if (fs.existsSync(filePath)) {
    shell.openPath(filePath);
    return { success: true };
  }
  return { error: "File not found" };
});

// Delete downloaded files + optionally delete from WhatsApp chat
ipcMain.handle(
  "delete-files",
  async (event, { filePaths, messageIds, chatId }) => {
    const results = [];

    // 1. Delete local files from disk
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          results.push({ filePath, success: true });
        } else {
          results.push({ filePath, error: "File not found on disk" });
        }
      } catch (err) {
        results.push({ filePath, error: err.message });
      }
    }

    // 2. Delete messages from WhatsApp chat
    const waResults = [];
    if (isClientReady && chatId && messageIds && messageIds.length > 0) {
      for (const msgId of messageIds) {
        try {
          const msg = findMessageInStore(chatId, msgId);
          if (msg) {
            await sock.sendMessage(chatId, { delete: msg.key });
            waResults.push({ messageId: msgId, success: true });
          } else {
            waResults.push({
              messageId: msgId,
              error: "Message not found in store",
            });
          }
        } catch (msgErr) {
          waResults.push({ messageId: msgId, error: msgErr.message });
        }
      }
    }

    return { results, waResults };
  },
);

// Mark chat as read
ipcMain.handle("mark-chat-read", async (event, chatId) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };
  try {
    const msgs = getStoreMessages(chatId);
    if (msgs.length > 0) {
      const lastMsg = msgs[msgs.length - 1];
      await sock.readMessages([lastMsg.key]);
    }
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Refresh / reconnect WhatsApp
ipcMain.handle("reconnect-whatsapp", async () => {
  try {
    isClientReady = false;
    stopStorePersistence();
    try {
      store.writeToFile(getStorePath());
    } catch (_) {}
    if (sock) {
      try {
        sock.end(undefined);
      } catch (_) {}
      sock = null;
    }
    await initWhatsApp();
    return { success: true };
  } catch (err) {
    console.error("[WhatsApp] Reconnect failed:", err.message);
    return { error: err.message };
  }
});

// Get WhatsApp status
ipcMain.handle("get-whatsapp-status", async () => {
  return { ready: isClientReady };
});

// ── Admin Contact ────────────────────────────────────────────────────────────
ipcMain.handle("get-admin-contact", async () => {
  try {
    const response = await fetch(
      `${LICENSE_API_URL}/settings/admin_contact_number`,
    );
    if (!response.ok) return { number: null };
    const data = await response.json();
    return { number: data.value || null };
  } catch (err) {
    console.error("[Settings] Failed to fetch admin contact:", err.message);
    return { number: null };
  }
});

// ── License Validation ───────────────────────────────────────────────────────
ipcMain.handle("check-license", async (_, phoneNumber) => {
  try {
    const response = await fetch(`${LICENSE_API_URL}/license/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber }),
    });
    if (!response.ok) {
      return { status: "error", message: "License server returned an error" };
    }
    return await response.json();
  } catch (err) {
    console.error("[License] Check failed:", err.message);
    return { status: "error", message: "Could not connect to license server" };
  }
});

ipcMain.handle("request-trial", async (_, { phoneNumber, name }) => {
  try {
    const response = await fetch(`${LICENSE_API_URL}/license/request-trial`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber, name }),
    });
    if (!response.ok) {
      return { success: false, message: "License server returned an error" };
    }
    return await response.json();
  } catch (err) {
    console.error("[License] Trial request failed:", err.message);
    return { success: false, message: "Could not connect to license server" };
  }
});

// Get the logged-in user's profile info (returns immediately with number/name;
// profile pic is fetched asynchronously and sent via IPC when ready)
ipcMain.handle("get-profile-info", async () => {
  if (!isClientReady || !sock) return { error: "WhatsApp not ready" };

  try {
    const user = sock.user;
    const pushname = user?.name || "Unknown";
    // user.id can be "1234567890:0@s.whatsapp.net" or "1234567890@s.whatsapp.net"
    const number = user?.id?.split(":")[0]?.split("@")[0] || "";

    // Return immediately — don't block on profile pic
    const result = {
      name: pushname,
      number,
      profilePicUrl: null,
    };

    // Fetch profile pic in background and push it to the renderer when ready
    (async () => {
      try {
        const rawUrl = await sock.profilePictureUrl(user.id, "image");
        const pic = await fetchProfilePicAsDataUri(rawUrl);
        if (pic) {
          mainWindow?.webContents?.send("whatsapp:profile-pic", {
            jid: user.id,
            profilePicUrl: pic,
            isSelf: true,
          });
        }
      } catch (_) {}
    })();

    return result;
  } catch (err) {
    console.error("Error getting profile info:", err);
    return { error: err.message };
  }
});

// Get a single chat's profile picture (called lazily from renderer)
ipcMain.handle("get-profile-pic", async (_, jid) => {
  if (!isClientReady || !sock) return { profilePicUrl: null };
  try {
    let rawUrl = null;
    try {
      rawUrl = await withTimeout(
        sock.profilePictureUrl(jid, "image"),
        3000,
        null,
      );
    } catch (_) {
      // 404/not-found is normal for contacts without profile pics
      return { profilePicUrl: null };
    }
    if (!rawUrl) return { profilePicUrl: null };
    const pic = await withTimeout(fetchProfilePicAsDataUri(rawUrl), 5000, null);
    return { profilePicUrl: pic };
  } catch (_) {
    return { profilePicUrl: null };
  }
});

// Logout — destroy connection, clear auth, go back to QR screen
ipcMain.handle("logout-whatsapp", async () => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        console.error("Error during logout:", e.message);
      }
      try {
        sock.end(undefined);
      } catch (_) {}
      sock = null;
    }
  } catch (e) {
    console.error("Error during logout cleanup:", e);
  }

  isClientReady = false;

  // Clear stale chat/contact/message data
  resetStore();

  // Clear auth data so a new QR is shown
  const authPath = getUserDataPath(".baileys_auth");
  try {
    fs.rmSync(authPath, { recursive: true, force: true });
  } catch (e) {
    console.error("Error clearing auth data:", e);
  }

  // Notify renderer to switch to login screen
  mainWindow?.webContents?.send("whatsapp:status", "logged_out");

  // Re-initialize for fresh QR
  setTimeout(() => {
    initWhatsApp().catch((err) => {
      console.error("[WhatsApp] Re-init after logout failed:", err.message);
    });
  }, 1000);

  return { success: true };
});

// ── Thumbnail Generation ─────────────────────────────────────────────────────
let thumbWindow = null;
let thumbBusy = false;
const thumbQueue = [];

function ensureThumbDir() {
  const thumbDir = getUserDataPath("thumbnails");
  if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
  return thumbDir;
}

ipcMain.handle("generate-thumbnail", async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: "File not found" };

  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".pdf") return { error: "Unsupported file type" };

  const thumbDir = ensureThumbDir();
  const stat = fs.statSync(filePath);
  const hash = crypto
    .createHash("md5")
    .update(`${filePath}_${stat.size}_${stat.mtimeMs}`)
    .digest("hex");
  const thumbPath = path.join(thumbDir, hash + ".png");

  if (fs.existsSync(thumbPath)) {
    return { thumbnailPath: thumbPath };
  }

  return new Promise((resolve) => {
    thumbQueue.push({ filePath, thumbPath, resolve });
    processThumbQueue();
  });
});

async function processThumbQueue() {
  if (thumbBusy || thumbQueue.length === 0) return;
  thumbBusy = true;

  const { filePath, thumbPath, resolve } = thumbQueue.shift();

  try {
    if (!thumbWindow || thumbWindow.isDestroyed()) {
      thumbWindow = new BrowserWindow({
        width: 200,
        height: 260,
        show: false,
        webPreferences: {
          plugins: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
    }

    const fileUrl =
      "file:///" +
      filePath.replace(/\\/g, "/") +
      "#toolbar=0&navpanes=0&scrollbar=0&view=Fit";
    await thumbWindow.loadURL(fileUrl);

    // Wait for PDF to render
    await new Promise((r) => setTimeout(r, 2500));

    const image = await thumbWindow.webContents.capturePage();
    const resized = image.resize({ width: 200 });
    fs.writeFileSync(thumbPath, resized.toPNG());

    resolve({ thumbnailPath: thumbPath });
  } catch (err) {
    console.error("Thumbnail generation error:", err);
    resolve({ error: err.message });
  }

  thumbBusy = false;
  processThumbQueue();
}

// ── Global error handlers ────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[UnhandledRejection]", msg);
});

process.on("uncaughtException", (err) => {
  const msg = err?.message || "";
  console.error("[UncaughtException]", msg);
  // Suppress non-fatal WebSocket / Baileys / transient errors
  const suppressPatterns = [
    "WebSocket",
    "Connection Closed",
    "Connection was lost",
    "Timed Out",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "Boom",
    "statusCode",
    "DisconnectReason",
    "detached Frame",
    "rate-overlimit",
    "conflict",
  ];
  if (suppressPatterns.some((p) => msg.includes(p))) {
    return;
  }
  throw err;
});

// ── Auto-Updater ─────────────────────────────────────────────────────────────
autoUpdater.logger = console;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function createUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus();
    return;
  }
  updateWindow = new BrowserWindow({
    width: 400,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    alwaysOnTop: true,
    center: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  updateWindow.loadFile(path.join(__dirname, "src", "update.html"));
  updateWindow.on("closed", () => {
    updateWindow = null;
  });
}

autoUpdater.on("download-progress", (progress) => {
  console.log(
    `[Updater] Progress: ${Math.round(progress.percent)}% (${(progress.transferred / 1048576).toFixed(1)}/${(progress.total / 1048576).toFixed(1)} MB)`,
  );
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send("update:download-progress", progress);
  }
});

autoUpdater.on("update-downloaded", (info) => {
  console.log("[Updater] Download complete:", info?.version);
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send("update:downloaded");
  }
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 3000);
});

autoUpdater.on("error", (err) => {
  console.error("[Updater] Error:", err?.message || err);
  if (updateCancelled) {
    updateCancelled = false;
    return;
  }
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.send(
      "update:error",
      err?.message || "Unknown error",
    );
  }
});

ipcMain.handle("check-for-updates", async () => {
  try {
    console.log("[Updater] Checking for updates...");
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      console.log("[Updater] No update info returned");
      return { available: false };
    }
    const latest = result.updateInfo.version;
    const current = app.getVersion();
    console.log(`[Updater] Current: ${current}, Latest: ${latest}`);
    if (latest === current) {
      return { available: false, current };
    }
    createUpdateWindow();
    updateCancelled = false;
    updateWindow.webContents.once("did-finish-load", () => {
      console.log("[Updater] Window loaded, starting download...");
      autoUpdater.downloadUpdate().catch((err) => {
        console.error(
          "[Updater] downloadUpdate() rejected:",
          err?.message || err,
        );
      });
    });
    return { available: true, current, latest };
  } catch (err) {
    console.error("[Updater] Check failed:", err.message);
    return { available: false, error: err.message };
  }
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

ipcMain.on("cancel-update", () => {
  console.log("[Updater] User cancelled download");
  updateCancelled = true;
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.close();
  }
});

// ── App Lifecycle ────────────────────────────────────────────────────────────

// Prevent multiple instances of the app
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    cleanupGpuCache();
    ensureDownloadsDir();

    createWindow();
    try {
      await initWhatsApp();
    } catch (err) {
      console.error("[WhatsApp] initWhatsApp failed:", err.message);
      // Don't crash — the user can reconnect via the UI
      mainWindow?.webContents?.send("whatsapp:status", "error");
      mainWindow?.webContents?.send(
        "whatsapp:error",
        "Failed to start WhatsApp. Please try reconnecting.",
      );
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", async () => {
    stopStorePersistence();
    try {
      store.writeToFile(getStorePath());
    } catch (_) {}
    if (sock) {
      try {
        sock.end(undefined);
      } catch (_) {}
      sock = null;
    }
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
    // Save store before quitting
    stopStorePersistence();
    try {
      store.writeToFile(getStorePath());
    } catch (_) {}

    // Close thumbnail window if open
    if (thumbWindow && !thumbWindow.isDestroyed()) {
      try {
        thumbWindow.close();
      } catch (_) {}
      thumbWindow = null;
    }
    // Close update window if open
    if (updateWindow && !updateWindow.isDestroyed()) {
      try {
        updateWindow.close();
      } catch (_) {}
      updateWindow = null;
    }
    // Close socket
    if (sock) {
      try {
        sock.end(undefined);
      } catch (_) {}
      sock = null;
    }
  });
} // end of single-instance else block
