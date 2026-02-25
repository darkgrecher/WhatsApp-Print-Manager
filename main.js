const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
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

      // If message has media, gather file info
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

  // Initialize with error handling and retry
  const startClient = async (attempt = 1) => {
    try {
      await whatsappClient.initialize();
    } catch (err) {
      console.error(`[WhatsApp] Initialization failed (attempt ${attempt}):`, err.message);
      if (attempt < 3) {
        console.log("[WhatsApp] Cleaning up and retrying...");
        try { await whatsappClient.destroy(); } catch (_) {}
        cleanupStaleLockFiles();
        // Re-create the client before retrying
        initWhatsApp(attempt + 1);
      } else {
        mainWindow?.webContents.send("whatsapp:status", "error");
        mainWindow?.webContents.send(
          "whatsapp:error",
          "Failed to start WhatsApp after multiple attempts. Please restart the app."
        );
      }
    }
  };
  startClient(retryAttempt);
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

// Get all chats with unread messages
ipcMain.handle("get-unread-chats", async () => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const chats = await whatsappClient.getChats();
    // Show ALL recent chats (not just unread), because WhatsApp Web
    // often auto-marks messages as read when the puppeteer session loads.
    // Filter: show chats with unread OR recent activity (last 24 hours)
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const recentChats = chats.filter((chat) => {
      return (
        chat.unreadCount > 0 || (chat.timestamp && chat.timestamp > oneDayAgo)
      );
    });

    const result = [];
    for (const chat of recentChats) {
      let contactName = chat.name || "Unknown";
      let contactNumber = chat.id.user || chat.id._serialized;
      let profilePicUrl = null;

      try {
        const contact = await chat.getContact();
        contactName =
          contact.pushname || contact.name || contact.number || contactName;
        profilePicUrl = await contact.getProfilePicUrl();
      } catch (e) {
        // Profile pic might not be available
      }

      // Get last message preview
      let lastMessage = "";
      try {
        const msgs = await chat.fetchMessages({ limit: 1 });
        if (msgs.length > 0) {
          lastMessage = msgs[0].hasMedia
            ? `[${msgs[0].type}]`
            : (msgs[0].body || "").substring(0, 50);
        }
      } catch (e) {}

      result.push({
        id: chat.id._serialized,
        name: contactName,
        number: contactNumber,
        unreadCount: chat.unreadCount,
        isGroup: chat.isGroup,
        profilePicUrl: profilePicUrl || null,
        timestamp: chat.timestamp,
        lastMessage,
      });
    }

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

// Print files
ipcMain.handle("print-files", async (event, filePaths) => {
  const results = [];

  for (const filePath of filePaths) {
    try {
      if (!fs.existsSync(filePath)) {
        results.push({ filePath, error: "File not found" });
        continue;
      }

      const ext = path.extname(filePath).toLowerCase();
      const isPDF = ext === ".pdf";

      if (isPDF) {
        // Use pdf-to-printer for PDFs
        const ptp = require("pdf-to-printer");
        await ptp.print(filePath);
        results.push({ filePath, success: true, method: "pdf-to-printer" });
      } else {
        // Use Windows shell "print" verb for other files (images, docs, etc.)
        const { exec } = require("child_process");
        await new Promise((resolve, reject) => {
          // Use PowerShell Start-Process with -Verb Print
          const cmd = `powershell -Command "Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -Verb Print"`;
          exec(cmd, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
          });
        });
        results.push({ filePath, success: true, method: "shell-print" });
      }
    } catch (err) {
      console.error(`Error printing ${filePath}:`, err);
      results.push({ filePath, error: err.message });
    }
  }

  return { results };
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

// Get available printers
ipcMain.handle("get-printers", async () => {
  try {
    const ptp = require("pdf-to-printer");
    const printers = await ptp.getPrinters();
    return { printers };
  } catch (err) {
    return { error: err.message, printers: [] };
  }
});

// Print to a specific printer
ipcMain.handle(
  "print-to-printer",
  async (event, { filePaths, printerName }) => {
    const results = [];

    for (const filePath of filePaths) {
      try {
        if (!fs.existsSync(filePath)) {
          results.push({ filePath, error: "File not found" });
          continue;
        }

        const ext = path.extname(filePath).toLowerCase();
        const isPDF = ext === ".pdf";

        if (isPDF) {
          const ptp = require("pdf-to-printer");
          const options = printerName ? { printer: printerName } : {};
          await ptp.print(filePath, options);
          results.push({ filePath, success: true });
        } else {
          // For non-PDF files, use PowerShell with printer specification
          const { exec } = require("child_process");
          await new Promise((resolve, reject) => {
            let cmd;
            if (printerName) {
              // Use rundll32 for images to a specific printer
              if (
                [
                  ".jpg",
                  ".jpeg",
                  ".png",
                  ".bmp",
                  ".gif",
                  ".tiff",
                  ".tif",
                ].includes(ext)
              ) {
                cmd = `powershell -Command "rundll32 shimgvw.dll,ImageView_PrintTo '${filePath.replace(/'/g, "''")}' '${printerName.replace(/'/g, "''")}'"`;
              } else {
                cmd = `powershell -Command "Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -Verb Print"`;
              }
            } else {
              cmd = `powershell -Command "Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -Verb Print"`;
            }
            exec(cmd, (error, stdout, stderr) => {
              if (error) reject(error);
              else resolve(stdout);
            });
          });
          results.push({ filePath, success: true });
        }
      } catch (err) {
        results.push({ filePath, error: err.message });
      }
    }

    return { results };
  },
);

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
    if (whatsappClient) {
      try {
        await whatsappClient.destroy();
      } catch (e) {}
    }
  });
} // end of single-instance else block
