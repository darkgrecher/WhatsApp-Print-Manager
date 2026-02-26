const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const mime = require("mime-types");

// ── Globals ──────────────────────────────────────────────────────────────────
let mainWindow;
let whatsappClient;
let isClientReady = false;
let DOWNLOADS_DIR;

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
    const markEventReceived = () => { eventReceived = true; };

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
 * Utility: run a promise with a timeout. Resolves to fallback on timeout.
 */
function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// Get all chats
ipcMain.handle("get-unread-chats", async () => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const chats = await withTimeout(whatsappClient.getChats(), 30000, []);
    if (!chats || chats.length === 0) return { chats: [] };

    // Show ALL chats (excluding status@broadcast)
    const allChats = chats
      .filter((c) => c.id._serialized !== "status@broadcast")
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Process all chats in parallel with individual timeouts
    const result = await Promise.all(
      allChats.map(async (chat) => {
        let contactNumber = chat.id.user || chat.id._serialized;
        // savedName = name from phone contacts or chat name
        let savedName = chat.name || "";
        // whatsappName = pushname set by the user on WhatsApp
        let whatsappName = "";
        let profilePicUrl = null;

        try {
          const contact = await withTimeout(chat.getContact(), 5000, null);
          if (contact) {
            whatsappName = contact.pushname || "";
            // If savedName is empty or just the number, try contact.name
            if (!savedName || savedName === contactNumber) {
              savedName = contact.name || "";
            }
            profilePicUrl = await withTimeout(
              contact.getProfilePicUrl(),
              3000,
              null,
            );
          }
        } catch (e) {
          // Contact info not available, continue with defaults
        }

        // Get last message preview (with timeout)
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

        // Determine a display name (fallback chain)
        const displayName = savedName || whatsappName || contactNumber;

        return {
          id: chat.id._serialized,
          name: displayName,
          number: contactNumber,
          whatsappName: whatsappName,
          unreadCount: chat.unreadCount,
          isGroup: chat.isGroup,
          profilePicUrl: profilePicUrl || null,
          timestamp: chat.timestamp,
          lastMessage,
        };
      }),
    );

    // Sort by most recent first
    result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return { chats: result };
  } catch (err) {
    console.error("Error getting unread chats:", err);
    return { error: err.message };
  }
});

// Get ALL chats (not just unread) — for the "All Chats" view
ipcMain.handle("get-all-chats", async (event, { limit = 30 } = {}) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const chats = await whatsappClient.getChats();
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

// Get messages with media for a specific chat
ipcMain.handle("get-chat-files", async (event, chatId) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const chat = await whatsappClient.getChatById(chatId);
    const unreadCount = chat.unreadCount || 0;
    // Fetch messages (limit to last 50 for performance)
    const messages = await chat.fetchMessages({ limit: 50 });

    // Determine which messages are unread:
    // The last `unreadCount` messages (sorted by time ascending) are unread
    const sortedMsgs = [...messages].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );
    const unreadMsgIds = new Set();
    if (unreadCount > 0) {
      const unreadSlice = sortedMsgs.slice(-unreadCount);
      unreadSlice.forEach((m) => unreadMsgIds.add(m.id._serialized));
    }

    const files = [];
    for (const msg of messages) {
      if (msg.hasMedia) {
        let senderName = "Unknown";
        try {
          const contact = await msg.getContact();
          senderName =
            contact.pushname || contact.name || contact.number || "Unknown";
        } catch (e) {}

        // Determine file info from message
        const mediaInfo = {
          messageId: msg.id._serialized,
          chatId: chatId,
          sender: senderName,
          timestamp: msg.timestamp,
          type: msg.type, // image, video, document, audio, sticker, ptt
          caption: msg.body || "",
          fileName: null,
          mimeType: null,
          fileSize: null,
          isDownloaded: false,
          localPath: null,
        };

        // Try to get document info
        if (msg._data?.fileName) {
          mediaInfo.fileName = msg._data.fileName;
        }
        if (msg._data?.mimetype) {
          mediaInfo.mimeType = msg._data.mimetype;
        }
        if (msg._data?.size) {
          mediaInfo.fileSize = msg._data.size;
        }

        // Generate a default filename if none exists
        if (!mediaInfo.fileName) {
          const ext =
            mime.extension(mediaInfo.mimeType || "application/octet-stream") ||
            "bin";
          const typePrefix = mediaInfo.type || "file";
          mediaInfo.fileName = `${typePrefix}_${msg.timestamp}.${ext}`;
        }

        // Check if already downloaded
        const expectedPath = path.join(
          DOWNLOADS_DIR,
          `${msg.id._serialized.replace(/[^a-zA-Z0-9]/g, "_")}_${mediaInfo.fileName}`,
        );
        if (fs.existsSync(expectedPath)) {
          mediaInfo.isDownloaded = true;
          mediaInfo.localPath = expectedPath;
        }

        // Tag whether this file is from an unread message
        mediaInfo.isUnread = unreadMsgIds.has(msg.id._serialized);

        files.push(mediaInfo);
      }
    }

    // Sort by timestamp descending (newest first)
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
      const chat = await whatsappClient.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 100 });
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
    const chat = await whatsappClient.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
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
    const { exec } = require("child_process");
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
          // Use PowerShell to print images to the specific printer
          await new Promise((resolve, reject) => {
            const escapedPath = filePath.replace(/'/g, "''");
            const escapedPrinter = targetPrinter.replace(/'/g, "''");
            const cmd = `powershell -Command "Start-Process mspaint.exe -ArgumentList '/pt','${escapedPath}','${escapedPrinter}' -Wait"`;
            exec(cmd, (error) => {
              if (error) reject(error);
              else resolve();
            });
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
        const chat = await whatsappClient.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 100 });

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
    const chat = await whatsappClient.getChatById(chatId);
    await chat.sendSeen();
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

// Get the logged-in user's profile info
ipcMain.handle("get-profile-info", async () => {
  if (!isClientReady || !whatsappClient) return { error: "WhatsApp not ready" };

  try {
    const info = whatsappClient.info;
    const pushname = info.pushname || "Unknown";
    const number = info.wid ? info.wid.user : "";

    let profilePicUrl = null;
    try {
      profilePicUrl = await whatsappClient.getProfilePicUrl(
        info.wid._serialized,
      );
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
    if (whatsappClient) {
      try {
        await whatsappClient.destroy();
      } catch (e) {}
    }
  });
} // end of single-instance else block
