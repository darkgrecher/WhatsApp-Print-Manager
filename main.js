const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const mime = require("mime-types");
const { autoUpdater } = require("electron-updater");

// ── Globals ──────────────────────────────────────────────────────────────────
let mainWindow;
let updateWindow;
let updateCancelled = false;
let whatsappClient;
let isClientReady = false;
let DOWNLOADS_DIR;

// Cache for enriched chat data (profile pic, resolved name, last message).
// Survives across refreshChats() calls so the UI doesn't lose enrichment.
const enrichedChatCache = new Map();
let enrichmentInProgress = false;

// License server URL (change this to your production backend URL)
const LICENSE_API_URL = "https://whatsapp-print-admin.vercel.app/api";

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
 * Remove stale Chromium singleton lock files from the session directory.
 * These can remain after a crash and prevent puppeteer from launching.
 */
function cleanupStaleLockFiles() {
  const authPath = getUserDataPath(".wwebjs_auth");
  if (!fs.existsSync(authPath)) return;

  const lockNames = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  const walk = (dir) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (lockNames.includes(entry.name)) {
          try {
            fs.unlinkSync(fullPath);
            console.log("[Cleanup] Removed stale lock:", fullPath);
          } catch (_) {}
        }
      }
    } catch (_) {}
  };
  walk(authPath);
}

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

// ── WhatsApp Client ──────────────────────────────────────────────────────────
function initWhatsApp(retryAttempt = 1) {
  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: getUserDataPath(".wwebjs_auth"),
    }),
    // Use a user agent that matches the actual Chromium version bundled with
    // puppeteer.  A mismatch (e.g. declaring Chrome/101 while running Chrome/145)
    // makes WhatsApp reject QR-code linking with "Couldn't link device".
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    // Always fetch the latest WhatsApp Web version instead of relying on a
    // potentially stale local cache.
    webVersionCache: {
      type: "none",
    },
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu",
      ],
    },
  });

  // QR Code event
  whatsappClient.on("qr", async (qr) => {
    console.log("[WhatsApp] QR code received");
    try {
      const qrDataURL = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      mainWindow?.webContents.send("whatsapp:qr", qrDataURL);
    } catch (err) {
      console.error("QR generation error:", err);
    }
  });

  // Authenticated
  whatsappClient.on("authenticated", () => {
    console.log("[WhatsApp] Authenticated");
    mainWindow?.webContents.send("whatsapp:status", "authenticated");
  });

  // Ready
  whatsappClient.on("ready", () => {
    console.log("[WhatsApp] Client is ready");
    isClientReady = true;
    mainWindow?.webContents.send("whatsapp:status", "ready");
  });

  // Loading screen progress
  whatsappClient.on("loading_screen", (percent, message) => {
    mainWindow?.webContents.send("whatsapp:loading", { percent, message });
  });

  // Disconnected
  whatsappClient.on("disconnected", (reason) => {
    console.log("[WhatsApp] Disconnected:", reason);
    isClientReady = false;
    mainWindow?.webContents.send("whatsapp:status", "disconnected");
  });

  // Auth failure
  whatsappClient.on("auth_failure", (msg) => {
    console.error("[WhatsApp] Auth failure:", msg);
    mainWindow?.webContents.send("whatsapp:status", "auth_failure");
  });

  // ── Real-time incoming message listener ──
  whatsappClient.on("message", async (msg) => {
    console.log(
      `[WhatsApp] New message from ${msg.from}: type=${msg.type}, hasMedia=${msg.hasMedia}`,
    );
    try {
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const contactName =
        contact.pushname || contact.name || contact.number || "Unknown";

      const messageData = {
        chatId: chat.id._serialized,
        chatName: chat.name || contactName,
        contactNumber: chat.id.user || chat.id._serialized,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        messageId: msg.id._serialized,
        hasMedia: msg.hasMedia,
        type: msg.type,
        body: msg.body || "",
        timestamp: msg.timestamp,
        sender: contactName,
      };

      // If message has media, gather file info and auto-download
      if (msg.hasMedia) {
        messageData.fileName = msg._data?.fileName || null;
        messageData.mimeType = msg._data?.mimetype || null;
        messageData.fileSize = msg._data?.size || null;

        if (!messageData.fileName) {
          const ext =
            mime.extension(
              messageData.mimeType || "application/octet-stream",
            ) || "bin";
          messageData.fileName = `${msg.type || "file"}_${msg.timestamp}.${ext}`;
        }

        // Auto-download media without marking the chat as read
        try {
          const media = await msg.downloadMedia();
          if (media) {
            let finalFileName = messageData.fileName || media.filename;
            if (!finalFileName) {
              const ext2 = mime.extension(media.mimetype) || "bin";
              finalFileName = `file_${Date.now()}.${ext2}`;
            }
            const safeMsgId = msg.id._serialized.replace(/[^a-zA-Z0-9]/g, "_");
            const localPath = path.join(
              DOWNLOADS_DIR,
              `${safeMsgId}_${finalFileName}`,
            );
            const buffer = Buffer.from(media.data, "base64");
            fs.writeFileSync(localPath, buffer);
            messageData.autoDownloaded = true;
            messageData.localPath = localPath;
            console.log(`[WhatsApp] Auto-downloaded media: ${finalFileName}`);
          }
        } catch (dlErr) {
          console.error("[WhatsApp] Auto-download failed:", dlErr.message);
        }
      }

      mainWindow?.webContents.send("whatsapp:new-message", messageData);
    } catch (err) {
      console.error("[WhatsApp] Error processing incoming message:", err);
    }
  });

  // Also listen for message_create (messages sent BY this account or received)
  whatsappClient.on("message_create", async (msg) => {
    // Only care about incoming messages (not our own)
    if (msg.fromMe) return;
    // The "message" event above handles incoming, but some versions
    // of whatsapp-web.js fire message_create instead/additionally
  });

  // Initialize with error handling, timeout detection, and retry
  const startClient = async (attempt = 1) => {
    // Track whether any meaningful event has fired during init
    let eventReceived = false;
    // Guard against both timeout and catch block trying to retry
    let retryTriggered = false;
    const markEventReceived = () => {
      eventReceived = true;
    };

    // Listen for key events that indicate successful progress
    whatsappClient.once("qr", markEventReceived);
    whatsappClient.once("authenticated", markEventReceived);
    whatsappClient.once("ready", markEventReceived);
    whatsappClient.once("auth_failure", markEventReceived);

    const doRetry = async (reason) => {
      if (retryTriggered) return; // prevent double-retry
      retryTriggered = true;

      try {
        await whatsappClient.destroy();
      } catch (_) {}

      // Give the browser process time to fully exit
      await new Promise((r) => setTimeout(r, 2000));

      if (attempt < 3) {
        // Clear stale auth data so a fresh QR code can be generated
        if (!eventReceived) {
          const authPath = getUserDataPath(".wwebjs_auth");
          try {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log("[WhatsApp] Cleared stale auth data");
          } catch (_) {}
        }

        cleanupStaleLockFiles();
        console.log(`[WhatsApp] Retrying (${reason})...`);
        mainWindow?.webContents.send("whatsapp:status", "retrying");
        initWhatsApp(attempt + 1);
      } else {
        mainWindow?.webContents.send("whatsapp:status", "error");
        mainWindow?.webContents.send(
          "whatsapp:error",
          "Failed to start WhatsApp after multiple attempts. Please restart the app.",
        );
      }
    };

    // Set an initialization timeout – if no events fire within 45 seconds,
    // the session data is likely stale and causing a silent hang.
    const INIT_TIMEOUT_MS = 45000;
    const initTimer = setTimeout(async () => {
      if (!eventReceived) {
        console.warn(
          `[WhatsApp] No events received after ${INIT_TIMEOUT_MS / 1000}s (attempt ${attempt}) – session may be stale`,
        );
        await doRetry("stale session timeout");
      }
    }, INIT_TIMEOUT_MS);

    try {
      await whatsappClient.initialize();
      clearTimeout(initTimer);
    } catch (err) {
      clearTimeout(initTimer);
      console.error(
        `[WhatsApp] Initialization failed (attempt ${attempt}):`,
        err.message,
      );
      await doRetry("init error");
    }
  };
  startClient(retryAttempt);
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

/**
 * Fetches a profile picture URL and returns it as a base64 data URI.
 * WhatsApp CDN URLs require session cookies, so we download in the main
 * process and pass the data URI to the renderer.
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
 * Attaches a no-op catch to the original promise so that if the timeout wins
 * and the promise later rejects (e.g. "detached Frame"), the rejection is
 * silently handled instead of crashing the process.
 */
function withTimeout(promise, ms, fallback = null) {
  // Prevent unhandled rejection when timeout wins and promise rejects later
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Wait until the puppeteer page inside whatsapp-web.js is usable again
 * (i.e. its main frame is no longer detached after an internal navigation).
 * Polls with 500ms intervals up to `timeoutMs`.
 */
async function waitForPageReady(timeoutMs = 25000) {
  const page = whatsappClient?.pupPage;
  if (!page) return;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await page.evaluate(() => true);
      return; // page is usable
    } catch (e) {
      if (e.message && e.message.includes("detached Frame")) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        return; // different error — let the caller deal with it
      }
    }
  }
  // timeout — let the caller try and get the real error
}

/**
 * Retry helper for whatsapp-web.js operations that may fail with transient
 * "detached Frame" errors when WhatsApp Web internally navigates.
 * On a detached frame, waits for the page to become usable before retrying.
 * @param {() => Promise} fn  – factory that creates the promise (called each attempt)
 * @param {number} retries    – max retry attempts (default 3)
 */
async function retryOnDetachedFrame(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isDetached =
        err && err.message && err.message.includes("detached Frame");
      if (isDetached && attempt < retries) {
        console.warn(
          `[Retry] Detached frame on attempt ${attempt}/${retries}, waiting for page to recover...`,
        );
        await waitForPageReady();
      } else {
        throw err;
      }
    }
  }
}

// Get all chats
ipcMain.handle("get-unread-chats", async () => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const chats = await retryOnDetachedFrame(() =>
      withTimeout(whatsappClient.getChats(), 30000, []),
    );
    if (!chats || chats.length === 0) return { chats: [] };

    // Show ALL chats (excluding status@broadcast)
    const allChats = chats
      .filter((c) => c.id._serialized !== "status@broadcast")
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Build chat objects, merging cached enrichment data when available.
    // Chats that haven't been enriched yet use basic fallback values.
    const result = allChats.map((chat) => {
      const contactNumber = chat.id.user || chat.id._serialized;
      const cached = enrichedChatCache.get(chat.id._serialized);

      return {
        id: chat.id._serialized,
        name: cached?.name || chat.name || contactNumber,
        number: contactNumber,
        whatsappName: cached?.whatsappName || "",
        unreadCount: chat.unreadCount,
        isGroup: chat.isGroup,
        profilePicUrl: cached?.profilePicUrl || null,
        timestamp: chat.timestamp,
        lastMessage: cached?.lastMessage || "",
      };
    });

    // On first load (cache empty), kick off background enrichment.
    // On subsequent refreshes the cache already has everything, so skip.
    if (!enrichmentInProgress && enrichedChatCache.size === 0) {
      enrichChatsInBackground(allChats);
    }

    return { chats: result };
  } catch (err) {
    const isDetached =
      err && err.message && err.message.includes("detached Frame");
    if (isDetached) {
      console.warn("[get-unread-chats] Skipping refresh due to detached frame");
      return { chats: [], skipped: true };
    }
    console.error("Error getting unread chats:", err);
    return { error: err.message };
  }
});

// Background enrichment: fetches contact info, profile pics, and last messages
// in batches and streams updates to the renderer. Results are cached so
// subsequent refreshChats() calls return enriched data instantly.
const ENRICH_BATCH_SIZE = 10;
async function enrichChatsInBackground(allChats) {
  enrichmentInProgress = true;
  for (let i = 0; i < allChats.length; i += ENRICH_BATCH_SIZE) {
    const batch = allChats.slice(i, i + ENRICH_BATCH_SIZE);
    const enriched = await Promise.all(
      batch.map(async (chat) => {
        let contactNumber = chat.id.user || chat.id._serialized;
        let savedName = chat.name || "";
        let whatsappName = "";
        let profilePicUrl = null;

        try {
          const contact = await withTimeout(chat.getContact(), 5000, null);
          if (contact) {
            whatsappName = contact.pushname || "";
            if (!savedName || savedName === contactNumber) {
              savedName = contact.name || "";
            }
            const rawUrl = await withTimeout(
              contact.getProfilePicUrl(),
              3000,
              null,
            );
            profilePicUrl = await withTimeout(
              fetchProfilePicAsDataUri(rawUrl),
              5000,
              null,
            );
          }
        } catch (e) {}

        let lastMessage = "";
        try {
          const msgs = await withTimeout(
            chat.fetchMessages({ limit: 1 }),
            3000,
            [],
          );
          if (msgs && msgs.length > 0) {
            lastMessage = msgs[0].hasMedia
              ? `[${msgs[0].type}]`
              : (msgs[0].body || "").substring(0, 50);
          }
        } catch (e) {}

        const displayName = savedName || whatsappName || contactNumber;

        const enrichedData = {
          id: chat.id._serialized,
          name: displayName,
          number: contactNumber,
          whatsappName,
          profilePicUrl: profilePicUrl || null,
          lastMessage,
        };

        // Store in cache
        enrichedChatCache.set(chat.id._serialized, enrichedData);

        return enrichedData;
      }),
    );

    // Send this batch to the renderer for live UI updates
    mainWindow?.webContents.send("whatsapp:chat-enriched", enriched);
  }
  enrichmentInProgress = false;
}

// Get ALL chats (not just unread) — for the "All Chats" view
ipcMain.handle("get-all-chats", async (event, { limit = 30 } = {}) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const chats = await retryOnDetachedFrame(() => whatsappClient.getChats());
    const sorted = chats
      .filter((c) => c.id._serialized !== "status@broadcast")
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);

    const result = [];
    for (const chat of sorted) {
      let contactName = chat.name || "Unknown";
      let contactNumber = chat.id.user || chat.id._serialized;

      try {
        const contact = await chat.getContact();
        contactName =
          contact.pushname || contact.name || contact.number || contactName;
      } catch (e) {}

      result.push({
        id: chat.id._serialized,
        name: contactName,
        number: contactNumber,
        unreadCount: chat.unreadCount,
        isGroup: chat.isGroup,
        timestamp: chat.timestamp,
      });
    }

    return { chats: result };
  } catch (err) {
    return { error: err.message };
  }
});

// Get messages with media for a specific chat.
// Returns unread files immediately, then streams older files in batches
// via 'whatsapp:chat-files-batch' events for progressive rendering.
ipcMain.handle("get-chat-files", async (event, chatId, trackedUnreadIds) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const _t0 = Date.now();
    console.log(`[Files] START chatId=${chatId}`);

    const chat = await retryOnDetachedFrame(() =>
      whatsappClient.getChatById(chatId),
    );
    console.log(`[Files] getChatById done in ${Date.now()-_t0}ms`);

    const unreadCount = chat.unreadCount || 0;
    // Fetch messages (limit to last 50 for performance)
    const messages = await retryOnDetachedFrame(() =>
      chat.fetchMessages({ limit: 50 }),
    );
    console.log(`[Files] fetchMessages done in ${Date.now()-_t0}ms — total msgs: ${messages.length}`);

    // Determine which messages are unread by merging two sources:
    // 1) The last `unreadCount` messages (from whatsapp-web.js chat state)
    // 2) Client-tracked message IDs received via real-time onNewMessage events
    const sortedMsgs = [...messages].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );
    const unreadMsgIds = new Set();
    if (unreadCount > 0) {
      const unreadSlice = sortedMsgs.slice(-unreadCount);
      unreadSlice.forEach((m) => unreadMsgIds.add(m.id._serialized));
    }
    if (Array.isArray(trackedUnreadIds)) {
      trackedUnreadIds.forEach((id) => unreadMsgIds.add(id));
    }

    // Helper: extract file info from a message without contact resolution
    function extractFileInfo(msg) {
      const mediaInfo = {
        messageId: msg.id._serialized,
        chatId: chatId,
        sender: "Unknown",
        timestamp: msg.timestamp,
        type: msg.type,
        caption: msg.body || "",
        fileName: null,
        mimeType: null,
        fileSize: null,
        isDownloaded: false,
        localPath: null,
      };

      if (msg._data?.fileName) mediaInfo.fileName = msg._data.fileName;
      if (msg._data?.mimetype) mediaInfo.mimeType = msg._data.mimetype;
      if (msg._data?.size) mediaInfo.fileSize = msg._data.size;

      if (!mediaInfo.fileName) {
        const ext =
          mime.extension(mediaInfo.mimeType || "application/octet-stream") ||
          "bin";
        mediaInfo.fileName = `${mediaInfo.type || "file"}_${msg.timestamp}.${ext}`;
      }

      const expectedPath = path.join(
        DOWNLOADS_DIR,
        `${msg.id._serialized.replace(/[^a-zA-Z0-9]/g, "_")}_${mediaInfo.fileName}`,
      );
      if (fs.existsSync(expectedPath)) {
        mediaInfo.isDownloaded = true;
        mediaInfo.localPath = expectedPath;
      }

      mediaInfo.isUnread = unreadMsgIds.has(msg.id._serialized);
      return mediaInfo;
    }

    // Separate media messages into unread and older
    const mediaMessages = messages.filter((m) => m.hasMedia);
    const unreadMediaMsgs = mediaMessages.filter((m) =>
      unreadMsgIds.has(m.id._serialized),
    );
    const olderMediaMsgs = mediaMessages.filter(
      (m) => !unreadMsgIds.has(m.id._serialized),
    );
    console.log(`[Files] media split: ${unreadMediaMsgs.length} unread, ${olderMediaMsgs.length} older`);

    // Phase 1: Return unread files immediately (fast — no contact resolution)
    const unreadFiles = unreadMediaMsgs.map(extractFileInfo);
    unreadFiles.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Phase 2: Stream older files in date-grouped batches (background)
    // Sort older messages newest-first so today's files arrive before yesterday's
    olderMediaMsgs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Pre-compute older file info (synchronous, fast — no contact resolution)
    const allOlderFiles = olderMediaMsgs.map(extractFileInfo);
    console.log(`[Files] extractFileInfo done in ${Date.now()-_t0}ms — ${allOlderFiles.length} older files queued`);

    // Resolve contact names for ALL files in background (unread + older)
    (async () => {
      const allMediaMsgs = [...unreadMediaMsgs, ...olderMediaMsgs];
      for (const msg of allMediaMsgs) {
        try {
          const contact = await msg.getContact();
          const name =
            contact.pushname || contact.name || contact.number || "Unknown";
          mainWindow?.webContents.send("whatsapp:file-sender-resolved", {
            chatId,
            messageId: msg.id._serialized,
            sender: name,
          });
        } catch (e) {}
      }
    })();

    // Return Phase 1 immediately so the renderer can render unread files.
    // Use setImmediate to send older-file batches AFTER the invoke reply has
    // been dispatched — this prevents a race where batches arrive at the
    // renderer before selectChat() has set up the DOM, causing the batches
    // to be silently wiped when selectChat() does fileList.innerHTML = html.
    console.log(`[Files] returning Phase 1 at ${Date.now()-_t0}ms — ${unreadFiles.length} unread, hasOlderFiles=${olderMediaMsgs.length > 0}`);
    setImmediate(() => {
      const FILE_BATCH_SIZE = 10;
      if (allOlderFiles.length > 0) {
        for (let i = 0; i < allOlderFiles.length; i += FILE_BATCH_SIZE) {
          const batchFiles = allOlderFiles.slice(i, i + FILE_BATCH_SIZE);
          const isDone = i + FILE_BATCH_SIZE >= allOlderFiles.length;
          console.log(`[Files] sending batch at i=${i}, size=${batchFiles.length}, done=${isDone}`);
          mainWindow?.webContents.send("whatsapp:chat-files-batch", {
            chatId,
            files: batchFiles,
            done: isDone,
          });
        }
      } else {
        console.log(`[Files] no older files — sending done signal`);
        mainWindow?.webContents.send("whatsapp:chat-files-batch", {
          chatId,
          files: [],
          done: true,
        });
      }
    });

    return { files: unreadFiles, unreadCount, hasOlderFiles: olderMediaMsgs.length > 0 };
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
      const chat = await retryOnDetachedFrame(() =>
        whatsappClient.getChatById(chatId),
      );
      const messages = await retryOnDetachedFrame(() =>
        chat.fetchMessages({ limit: 100 }),
      );
      const msg = messages.find((m) => m.id._serialized === messageId);

      if (!msg) return { error: "Message not found" };
      if (!msg.hasMedia) return { error: "Message has no media" };

      mainWindow?.webContents.send("download:progress", {
        messageId,
        status: "downloading",
      });

      const media = await msg.downloadMedia();
      if (!media) return { error: "Failed to download media" };

      // Determine filename
      let finalFileName = fileName || media.filename;
      if (!finalFileName) {
        const ext = mime.extension(media.mimetype) || "bin";
        finalFileName = `file_${Date.now()}.${ext}`;
      }

      const safeMsgId = messageId.replace(/[^a-zA-Z0-9]/g, "_");
      const localPath = path.join(
        DOWNLOADS_DIR,
        `${safeMsgId}_${finalFileName}`,
      );

      // Save file
      const buffer = Buffer.from(media.data, "base64");
      fs.writeFileSync(localPath, buffer);

      mainWindow?.webContents.send("download:progress", {
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
      mainWindow?.webContents.send("download:progress", {
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
    const chat = await retryOnDetachedFrame(() =>
      whatsappClient.getChatById(chatId),
    );
    const messages = await retryOnDetachedFrame(() =>
      chat.fetchMessages({ limit: 100 }),
    );
    const mediaMessages = messages.filter((m) => m.hasMedia);

    const results = [];
    for (let i = 0; i < mediaMessages.length; i++) {
      const msg = mediaMessages[i];
      mainWindow?.webContents.send("download:bulk-progress", {
        current: i + 1,
        total: mediaMessages.length,
        messageId: msg.id._serialized,
      });

      try {
        const media = await msg.downloadMedia();
        if (!media) {
          results.push({
            messageId: msg.id._serialized,
            error: "Failed to download",
          });
          continue;
        }

        let finalFileName = media.filename;
        if (!finalFileName) {
          if (msg._data?.fileName) {
            finalFileName = msg._data.fileName;
          } else {
            const ext = mime.extension(media.mimetype) || "bin";
            finalFileName = `${msg.type || "file"}_${msg.timestamp}.${ext}`;
          }
        }

        const safeMsgId = msg.id._serialized.replace(/[^a-zA-Z0-9]/g, "_");
        const localPath = path.join(
          DOWNLOADS_DIR,
          `${safeMsgId}_${finalFileName}`,
        );

        const buffer = Buffer.from(media.data, "base64");
        fs.writeFileSync(localPath, buffer);

        results.push({
          messageId: msg.id._serialized,
          success: true,
          localPath,
          fileName: finalFileName,
          size: buffer.length,
        });
      } catch (dlErr) {
        results.push({ messageId: msg.id._serialized, error: dlErr.message });
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
    // This lets the user set color/BW, quality, paper size, orientation, pages per sheet, etc.
    try {
      console.log(`[Print] Opening preferences for printer: ${targetPrinter}`);
      await new Promise((resolve, reject) => {
        // printui /e opens "Printing Preferences" for the named printer
        const cmd = `printui /e /n "${targetPrinter.replace(/"/g, '\\"')}"  `;
        exec(cmd, (error) => {
          // printui exits when the user closes the dialog (OK or Cancel)
          if (error) {
            console.error("[Print] Preferences dialog error:", error.message);
          }
          // We proceed to print regardless — user may have clicked OK or Cancel
          resolve();
        });
      });
    } catch (e) {
      console.error("[Print] Failed to open preferences:", e);
    }

    // Step 2: Print each file to the selected printer with the configured preferences
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
          // Use pdf-to-printer (SumatraPDF) to print to the selected printer
          const ptp = require("pdf-to-printer");
          await ptp.print(filePath, { printer: targetPrinter });
          results.push({ filePath, success: true, method: "pdf-to-printer" });
        } else if (isImage) {
          // Use mspaint to print images to the specific printer
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
          // For other file types (DOCX, PPTX, etc.), open with default app
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
      try {
        const chat = await retryOnDetachedFrame(() =>
          whatsappClient.getChatById(chatId),
        );
        const messages = await retryOnDetachedFrame(() =>
          chat.fetchMessages({ limit: 100 }),
        );

        for (const msgId of messageIds) {
          try {
            const msg = messages.find((m) => m.id._serialized === msgId);
            if (msg) {
              // delete(true) = "delete for everyone" if recent enough, otherwise "delete for me"
              await msg.delete(true);
              waResults.push({ messageId: msgId, success: true });
            } else {
              waResults.push({
                messageId: msgId,
                error: "Message not found in chat",
              });
            }
          } catch (msgErr) {
            waResults.push({ messageId: msgId, error: msgErr.message });
          }
        }
      } catch (chatErr) {
        console.error("Error deleting WhatsApp messages:", chatErr);
        waResults.push({ error: chatErr.message });
      }
    }

    return { results, waResults };
  },
);

// (Printer selection is now handled by the OS print dialog – see print-with-dialog handler)

// Mark chat as read
ipcMain.handle("mark-chat-read", async (event, chatId) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };
  try {
    const chat = await retryOnDetachedFrame(() =>
      whatsappClient.getChatById(chatId),
    );
    await retryOnDetachedFrame(() => chat.sendSeen());
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Refresh / reconnect WhatsApp
ipcMain.handle("reconnect-whatsapp", async () => {
  try {
    if (whatsappClient) {
      await whatsappClient.destroy();
    }
    isClientReady = false;
    // Clear cached chat enrichment so the new session starts fresh
    enrichedChatCache.clear();
    enrichmentInProgress = false;
    initWhatsApp();
    return { success: true };
  } catch (err) {
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

// Get the logged-in user's profile info
ipcMain.handle("get-profile-info", async () => {
  if (!isClientReady || !whatsappClient) return { error: "WhatsApp not ready" };

  try {
    const info = whatsappClient.info;
    const pushname = info.pushname || "Unknown";
    const number = info.wid ? info.wid.user : "";

    let profilePicUrl = null;
    try {
      const rawUrl = await whatsappClient.getProfilePicUrl(
        info.wid._serialized,
      );
      profilePicUrl = await fetchProfilePicAsDataUri(rawUrl);
    } catch (e) {
      // Profile pic may not be available
    }

    return {
      name: pushname,
      number,
      profilePicUrl: profilePicUrl || null,
    };
  } catch (err) {
    console.error("Error getting profile info:", err);
    return { error: err.message };
  }
});

// Logout — destroy client, clear auth, go back to QR screen
ipcMain.handle("logout-whatsapp", async () => {
  try {
    if (whatsappClient) {
      await whatsappClient.logout();
      await whatsappClient.destroy();
    }
  } catch (e) {
    console.error("Error during logout:", e);
    // Even if logout fails, try to destroy and reinit
    try {
      await whatsappClient.destroy();
    } catch (e2) {}
  }

  isClientReady = false;

  // Clear cached chat enrichment so the new account starts completely fresh
  enrichedChatCache.clear();
  enrichmentInProgress = false;

  // Clear auth data so a new QR is shown
  const authPath = getUserDataPath(".wwebjs_auth");
  try {
    fs.rmSync(authPath, { recursive: true, force: true });
  } catch (e) {
    console.error("Error clearing auth data:", e);
  }

  // Notify renderer to switch to login screen
  mainWindow?.webContents.send("whatsapp:status", "logged_out");

  // Re-initialize for fresh QR
  setTimeout(() => {
    initWhatsApp();
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
// Prevent the app from crashing on transient puppeteer / whatsapp-web.js errors
// such as "Attempted to use detached Frame" which can occur when WhatsApp Web
// internally navigates while background operations are in-flight.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[UnhandledRejection]", msg);
});

process.on("uncaughtException", (err) => {
  // Let truly fatal errors (like out-of-memory) still crash
  if (err.message && err.message.includes("detached Frame")) {
    console.error(
      "[UncaughtException] Suppressed detached-frame error:",
      err.message,
    );
    return;
  }
  console.error("[UncaughtException]", err);
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
  // Wait a moment so user sees "Installing..." then quit-and-install
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 3000);
});

autoUpdater.on("error", (err) => {
  console.error("[Updater] Error:", err?.message || err);
  // Don't send error to window if user cancelled
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
    // Update is available — open progress window and start download
    createUpdateWindow();
    // Wait for window to finish loading before starting download
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
    // Focus the existing window instead of opening a new one
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    cleanupGpuCache();
    cleanupStaleLockFiles();
    ensureDownloadsDir();
    createWindow();
    initWhatsApp();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", async () => {
    if (whatsappClient) {
      try {
        await whatsappClient.destroy();
      } catch (e) {}
    }
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
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
    if (whatsappClient) {
      try {
        await whatsappClient.destroy();
      } catch (e) {}
    }
  });
} // end of single-instance else block
