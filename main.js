const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
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
const openWithSessions = new Map();

// Detached frame recovery tracking
let detachedFrameCount = 0;
let lastDetachedFrameTime = 0;
const DETACHED_FRAME_THRESHOLD = 5; // Trigger recovery after 5 consecutive detached frame errors
const DETACHED_FRAME_WINDOW = 30000; // Within 30 seconds
let isRecovering = false;

// License server URL (change this to your production backend URL)
const LICENSE_API_URL = "https://whatsapp-print-admin.vercel.app/api";

function psQuote(value) {
  return "'" + String(value == null ? "" : value).replace(/'/g, "''") + "'";
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const { execFile } = require("child_process");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || "").trim()));
          return;
        }
        resolve((stdout || "").trim());
      },
    );
  });
}

function cleanupOpenWithSessions() {
  const now = Date.now();
  for (const [key, value] of openWithSessions.entries()) {
    if (!value || now - value.createdAt > 15 * 60 * 1000) {
      openWithSessions.delete(key);
    }
  }
}

function normalizeJsonArray(jsonText) {
  if (!jsonText) return [];
  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".bmp",
  ".gif",
  ".tiff",
  ".tif",
  ".webp",
]);

function isImageFilePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function openPrintPicturesDialog(filePaths) {
  try {
    if (process.platform !== "win32") {
      for (const fp of filePaths) require("electron").shell.openPath(fp);
      return { success: true };
    }

    const os = require("os");
    const path = require("path");
    const { exec } = require("child_process");
    const batchId = Date.now().toString();
    const tempDir = path.join(
      os.tmpdir(),
      "WhatsappPrintManager_Batch_" + batchId,
    );
    const fsSync = require("fs");
    fsSync.mkdirSync(tempDir, { recursive: true });

    for (const fp of filePaths) {
      if (fsSync.existsSync(fp)) {
        const dest = path.join(tempDir, path.basename(fp));
        fsSync.copyFileSync(fp, dest);
      }
    }

    const psScriptPath = path.join(tempDir, "print.ps1");
    const psScriptContent = `$ErrorActionPreference = 'SilentlyContinue'
  $shell = New-Object -ComObject Shell.Application
  $folder = $shell.Namespace('${tempDir}')
  if ($folder) {
    $items = $folder.Items()
    if ($items.Count -gt 0) {
      $items.InvokeVerbEx('Print')
      Start-Sleep -Seconds 300
    }
  }`;
    fsSync.writeFileSync(psScriptPath, psScriptContent, "utf8");

    exec(
      `powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "${psScriptPath}"`,
      (err) => {
        if (err) console.error("Print Pictures background loop error:", err);
      },
    );

    return { success: true };
  } catch (err) {
    console.error("open-print-pictures error:", err);
    return { error: err.message };
  }
}

async function openWithWindowsPhotos(filePaths) {
  try {
    const existingFilePaths = Array.isArray(filePaths)
      ? filePaths.filter((fp) => fp && fs.existsSync(fp))
      : [];

    if (!existingFilePaths.length) {
      return { error: "No valid files selected" };
    }

    if (process.platform !== "win32") {
      for (const fp of existingFilePaths) {
        await shell.openPath(fp);
      }
      return {
        success: true,
        results: existingFilePaths.map((filePath) => ({
          filePath,
          success: true,
        })),
      };
    }

    if (existingFilePaths.length > 1) {
      const os = require("os");
      const tempDir = path.join(
        os.tmpdir(),
        "WhatsappPrintManager_PhotosBatch_" + Date.now().toString(),
      );
      fs.mkdirSync(tempDir, { recursive: true });

      for (const fp of existingFilePaths) {
        const dest = path.join(tempDir, path.basename(fp));
        fs.copyFileSync(fp, dest);
      }

      const ps = [
        "$ErrorActionPreference='Stop'",
        "$shell = New-Object -ComObject Shell.Application",
        `$folder = $shell.Namespace(${psQuote(tempDir)})`,
        "if (-not $folder) { throw 'Cannot open temp folder for Photos batch' }",
        "$items = $folder.Items()",
        "if ($items.Count -le 0) { throw 'No items in Photos batch folder' }",
        "$items.InvokeVerbEx('Open')",
        "Start-Sleep -Milliseconds 1200",
      ].join("\n");

      await runPowerShell(ps);
      return {
        success: true,
        results: existingFilePaths.map((filePath) => ({
          filePath,
          success: true,
        })),
      };
    }

    const singleFile = existingFilePaths[0];
    const shellResult = await shell.openPath(singleFile);
    if (shellResult) {
      return { error: shellResult };
    }
    return {
      success: true,
      results: [{ filePath: singleFile, success: true }],
    };
  } catch (error) {
    return { error: error.message || "Failed to open with Windows Photos" };
  }
}

async function listOpenWithApps(filePath) {
  if (process.platform !== "win32") {
    return [{ id: "__default__", name: "Default application" }];
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!ext) {
    return [{ id: "__default__", name: "Default application" }];
  }
  const isImage = IMAGE_EXTENSIONS.has(ext);

  const ps = [
    "$ErrorActionPreference='Stop'",
    "$ext = " + psQuote(ext),
    "$apps = New-Object System.Collections.Generic.List[Object]",
    "function Add-App([string]$id,[string]$name,[string]$command) {",
    "  if ([string]::IsNullOrWhiteSpace($id) -or [string]::IsNullOrWhiteSpace($command)) { return }",
    "  if ([string]::IsNullOrWhiteSpace($name)) { $name = $id }",
    "  $apps.Add([PSCustomObject]@{ id = $id; name = $name; command = $command })",
    "}",
    "$progIds = New-Object System.Collections.Generic.HashSet[string]",
    "$assocLine = cmd /c ('assoc ' + $ext) 2>$null",
    "if ($assocLine -and $assocLine -match '=') {",
    "  [void]$progIds.Add(($assocLine -split '=', 2)[1].Trim())",
    "}",
    "$userChoiceKey = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\' + $ext + '\\UserChoice'",
    "if (Test-Path $userChoiceKey) {",
    "  $uc = (Get-ItemProperty $userChoiceKey -ErrorAction SilentlyContinue).ProgId",
    "  if ($uc) { [void]$progIds.Add($uc) }",
    "}",
    "$extOpenWithProgids = 'Registry::HKEY_CLASSES_ROOT\\' + $ext + '\\OpenWithProgids'",
    "if (Test-Path $extOpenWithProgids) {",
    "  foreach ($prop in (Get-Item $extOpenWithProgids).Property) { [void]$progIds.Add($prop) }",
    "}",
    "foreach ($progId in $progIds) {",
    "  if ([string]::IsNullOrWhiteSpace($progId)) { continue }",
    "  $cmdKey = 'Registry::HKEY_CLASSES_ROOT\\' + $progId + '\\shell\\open\\command'",
    "  if (Test-Path $cmdKey) {",
    "    $command = (Get-ItemProperty $cmdKey -ErrorAction SilentlyContinue).'(default)'",
    "    if ($command) {",
    "      $name = (Get-ItemProperty ('Registry::HKEY_CLASSES_ROOT\\' + $progId) -ErrorAction SilentlyContinue).'(default)'",
    "      if (-not $name) { $name = $progId }",
    "      Add-App $progId $name $command",
    "    }",
    "  }",
    "}",
    "$owList = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\' + $ext + '\\OpenWithList'",
    "if (Test-Path $owList) {",
    "  $props = (Get-ItemProperty $owList -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -match '^[a-z]$' } | Sort-Object Name",
    "  foreach ($p in $props) {",
    "    $exe = [string]$p.Value",
    "    if ([string]::IsNullOrWhiteSpace($exe)) { continue }",
    "    $appCmd = 'Registry::HKEY_CLASSES_ROOT\\Applications\\' + $exe + '\\shell\\open\\command'",
    "    if (Test-Path $appCmd) {",
    "      $command = (Get-ItemProperty $appCmd -ErrorAction SilentlyContinue).'(default)'",
    "      if ($command) {",
    "        $friendly = (Get-ItemProperty ('Registry::HKEY_CLASSES_ROOT\\Applications\\' + $exe) -ErrorAction SilentlyContinue).FriendlyAppName",
    "        if (-not $friendly) { $friendly = [System.IO.Path]::GetFileNameWithoutExtension($exe) }",
    "        Add-App ('app:' + $exe.ToLowerInvariant()) $friendly $command",
    "      }",
    "    }",
    "  }",
    "}",
    "$apps | Group-Object id | ForEach-Object { $_.Group[0] } | Sort-Object name | ConvertTo-Json -Depth 5 -Compress",
  ].join("\n");

  const raw = await runPowerShell(ps);
  const resolved = normalizeJsonArray(raw)
    .filter((x) => x && x.id && x.command)
    .map((x) => ({
      id: String(x.id),
      name: String(x.name || x.id),
      command: String(x.command),
    }));

  const builtIns = [{ id: "__default__", name: "Default application" }];
  if (isImage) {
    builtIns.push({
      id: "__paint__",
      name: "Paint",
    });
    builtIns.push({
      id: "__print_pictures__",
      name: "Print Pictures dialog",
    });
    builtIns.push({
      id: "__windows_photos__",
      name: "Windows Photos",
    });
  }

  return [...builtIns, ...resolved];
}

async function launchWithCommandTemplate(commandTemplate, filePaths) {
  const { spawn } = require("child_process");

  const normalizedFilePaths = Array.isArray(filePaths)
    ? filePaths.filter(Boolean)
    : [filePaths].filter(Boolean);
  if (normalizedFilePaths.length === 0) {
    throw new Error("No files provided");
  }

  const splitArgs = (text) => {
    if (!text) return [];
    const result = [];
    const re = /"((?:\\.|[^"])*)"|(\S+)/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const quoted = match[1];
      const plain = match[2];
      const token = quoted != null ? quoted.replace(/\\"/g, '"') : plain;
      if (token) result.push(token);
    }
    return result;
  };

  const expandEnvVars = (value) =>
    String(value || "").replace(
      /%([^%]+)%/g,
      (_, name) => process.env[name] || `%${name}%`,
    );

  const raw = String(commandTemplate || "").trim();
  if (!raw) throw new Error("Invalid application command");

  let exePath = "";
  let argsPart = "";
  const quotedMatch = raw.match(/^"([^"]+)"\s*(.*)$/);
  if (quotedMatch) {
    exePath = quotedMatch[1];
    argsPart = quotedMatch[2] || "";
  } else {
    const plainMatch = raw.match(/^(\S+)\s*(.*)$/);
    if (!plainMatch) throw new Error("Could not parse application command");
    exePath = plainMatch[1];
    argsPart = plainMatch[2] || "";
  }

  exePath = expandEnvVars(exePath);

  const launchDetached = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(exePath, args, {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });

  const exeName = path.basename(exePath).toLowerCase();
  const browserExeNames = new Set([
    "firefox.exe",
    "brave.exe",
    "brave-browser.exe",
    "chrome.exe",
    "msedge.exe",
    "opera.exe",
  ]);
  const isOperaLauncher = exeName === "launcher.exe" && /opera/i.test(exePath);
  const isAcrobat = exeName === "acrobat.exe";

  const buildArgsForPaths = (paths) => {
    const quotedFileArgs = paths.map((fp) => `"${fp}"`);
    const firstFileArg = quotedFileArgs[0];
    const remainingFileArgs = quotedFileArgs.slice(1);
    const hasSinglePlaceholder = /%1|%L|%l/.test(argsPart);
    const hasMultiPlaceholder = /%\*/.test(argsPart);

    let finalArgsText = argsPart.replace(
      /"%1"|%1|"%L"|%L|"%l"|%l/g,
      firstFileArg,
    );
    finalArgsText = finalArgsText.replace(/%\*/g, quotedFileArgs.join(" "));

    if (!hasSinglePlaceholder && !hasMultiPlaceholder) {
      finalArgsText = `${finalArgsText} ${quotedFileArgs.join(" ")}`.trim();
    } else if (
      hasSinglePlaceholder &&
      !hasMultiPlaceholder &&
      remainingFileArgs.length > 0
    ) {
      finalArgsText = `${finalArgsText} ${remainingFileArgs.join(" ")}`.trim();
    }

    finalArgsText = finalArgsText.replace(/\s+\/dde\b.*$/i, "").trim();
    return splitArgs(expandEnvVars(finalArgsText));
  };

  // Windows Open-With commands for browsers often contain shell-only flags
  // like `-osint -url %1` that fail with multiple files. For multi-file opens,
  // switch to browser-native tab arguments in a single process launch.
  if (
    normalizedFilePaths.length > 1 &&
    (browserExeNames.has(exeName) || isOperaLauncher)
  ) {
    const rawTokens = splitArgs(expandEnvVars(argsPart));
    const passthrough = [];

    for (let i = 0; i < rawTokens.length; i += 1) {
      const token = rawTokens[i];
      const lower = token.toLowerCase();
      if (lower === "-osint") continue;
      if (lower === "-url" || lower === "--single-argument") {
        if (i + 1 < rawTokens.length) i += 1;
        continue;
      }
      if (/%1|%l|%L|%\*/i.test(token)) continue;
      passthrough.push(token);
    }

    const tabArgs = [];
    if (exeName === "firefox.exe") {
      for (const fp of normalizedFilePaths) {
        tabArgs.push("-new-tab", fp);
      }
    } else {
      for (const fp of normalizedFilePaths) {
        tabArgs.push("--new-tab", fp);
      }
    }

    const finalArgs = [...passthrough, ...tabArgs];
    await launchDetached(finalArgs);
    return;
  }

  if (isAcrobat && normalizedFilePaths.length > 1) {
    // Acrobat command lines are often single-document oriented. Hand off
    // files one-by-one to the same executable to avoid command failures.
    for (const fp of normalizedFilePaths) {
      await launchDetached(buildArgsForPaths([fp]));
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return;
  }

  await launchDetached(buildArgsForPaths(normalizedFilePaths));
}

async function launchWindowsOpenWithDialog(filePath) {
  return new Promise((resolve, reject) => {
    const { execFile } = require("child_process");
    execFile(
      "rundll32.exe",
      ["shell32.dll,OpenAs_RunDLL", filePath],
      { windowsHide: true },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function getUserDataPath(...segments) {
  return path.join(app.getPath("userData"), ...segments);
}

function ensureDownloadsDir() {
  DOWNLOADS_DIR = app.getPath("downloads");
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
}

/**
 * Find an installed Chrome or Edge executable on this machine.
 * Puppeteer's bundled Chromium frequently crashes on fresh Windows installs
 * because it lacks system VC++ runtimes and can be quarantined by antivirus.
 * Chrome and Edge are pre-installed or easily available and are always stable.
 * Returns null if none found, in which case the bundled Chromium is used.
 */
function findSystemBrowser() {
  const candidates = [
    // Google Chrome (64-bit install)
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    // Google Chrome (32-bit install on 64-bit Windows)
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    // Google Chrome (per-user install)
    path.join(
      os.homedir(),
      "AppData",
      "Local",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    // Microsoft Edge — pre-installed on every Windows 10/11 machine
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || null;
  if (found) console.log(`[WhatsApp] Using system browser: ${found}`);
  else
    console.log("[WhatsApp] No system browser found, using bundled Chromium");
  return found;
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

// ── WhatsApp Recovery ────────────────────────────────────────────────────────
async function triggerWhatsAppRecovery() {
  if (isRecovering) {
    console.warn("[Recovery] Already recovering, skipping duplicate request");
    return;
  }

  isRecovering = true;
  console.log("[Recovery] Starting WhatsApp client recovery...");

  try {
    // Notify UI that recovery is starting
    mainWindow?.webContents.send("whatsapp:status", "recovering");

    // Mark client as not ready
    isClientReady = false;

    // Destroy the existing client
    if (whatsappClient) {
      try {
        console.log("[Recovery] Destroying existing WhatsApp client...");
        await whatsappClient.destroy();
      } catch (err) {
        console.warn("[Recovery] Error destroying client:", err.message);
      }
    }

    // Wait a bit for cleanup
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Reset detached frame counter
    detachedFrameCount = 0;
    lastDetachedFrameTime = 0;

    // Reinitialize WhatsApp
    console.log("[Recovery] Reinitializing WhatsApp client...");
    initWhatsApp();
  } catch (err) {
    console.error("[Recovery] Error during recovery:", err);
    mainWindow?.webContents.send("whatsapp:status", "recovery_failed");
  } finally {
    isRecovering = false;
  }
}

// ── WhatsApp Client ──────────────────────────────────────────────────────────
function initWhatsApp(retryAttempt = 1) {
  const systemBrowser = findSystemBrowser();
  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: getUserDataPath(".wwebjs_auth"),
    }),
    // Use a user agent that matches the actual Chromium version bundled with
    // puppeteer.  A mismatch (e.g. declaring Chrome/101 while running Chrome/145)
    // makes WhatsApp reject QR-code linking with "Couldn't link device".
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    // Cache the WhatsApp Web version locally so repeated starts skip the
    // remote version-check network round-trip (saves 2-5 seconds on every
    // launch).  The cache is stored alongside auth data in userData.
    webVersionCache: {
      type: "local",
      path: getUserDataPath(".wwebjs_cache"),
    },
    puppeteer: {
      headless: true,
      // Use installed Chrome/Edge when available — much more stable than the
      // bundled Chromium on fresh Windows machines (VC++ runtimes, antivirus).
      ...(systemBrowser ? { executablePath: systemBrowser } : {}),
      // Reduce the per-command DevTools Protocol timeout so genuine Chrome
      // crashes surface in ~15 s instead of the 180 s puppeteer v24 default.
      protocolTimeout: 15000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu",
        // NOTE: do NOT pass --no-zygote when using the installed Windows
        // Chrome binary.  That flag is designed for Linux; on Windows Chrome
        // it prevents renderer processes from spawning, so no page ever loads.
        // Suppress first-run welcome UI and background app mode prompts.
        "--disable-extensions",
        "--disable-default-apps",
        "--no-default-browser-check",
        // Give the headless window an explicit size so Chrome doesn't fail
        // on systems with no display or unusual display configurations.
        "--window-size=1280,800",
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

  // ── Granular init progress events ─────────────────────────────────────
  // Fire status messages as each phase completes so the renderer can show
  // meaningful progress instead of a static "Initializing..." spinner.
  whatsappClient.once("qr", () => {
    mainWindow?.webContents.send("whatsapp:status", "qr_ready");
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

      // Give the browser process a moment to fully exit before re-launching.
      await new Promise((r) => setTimeout(r, 1500));

      if (attempt < 3) {
        // Keep persisted auth/session data on automatic retries so users are
        // not forced to re-scan QR after transient network/startup issues.
        // A full session reset is available via the explicit "Log Again"
        // action in the UI.

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

    // Set an initialization timeout – slow networks and low-end machines can
    // need longer before first events arrive.
    const INIT_TIMEOUT_MS = 60000;
    const initTimer = setTimeout(async () => {
      if (!eventReceived) {
        console.warn(
          `[WhatsApp] No events received after ${INIT_TIMEOUT_MS / 1000}s (attempt ${attempt})`,
        );
        await doRetry("startup timeout");
      }
    }, INIT_TIMEOUT_MS);

    mainWindow?.webContents.send("whatsapp:status", "launching");
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
      const result = await fn();
      // Success - reset detached frame counter
      detachedFrameCount = 0;
      return result;
    } catch (err) {
      const isDetached =
        err && err.message && err.message.includes("detached Frame");
      if (isDetached) {
        const now = Date.now();

        // Reset counter if it's been a while since the last error
        if (now - lastDetachedFrameTime > DETACHED_FRAME_WINDOW) {
          detachedFrameCount = 0;
        }

        detachedFrameCount++;
        lastDetachedFrameTime = now;

        console.warn(
          `[Retry] Detached frame on attempt ${attempt}/${retries} (total: ${detachedFrameCount}), waiting for page to recover...`,
        );

        // If we've hit the threshold, trigger recovery
        if (detachedFrameCount >= DETACHED_FRAME_THRESHOLD && !isRecovering) {
          console.error(
            `[Recovery] Detached frame threshold reached (${detachedFrameCount}). Triggering WhatsApp client recovery...`,
          );
          triggerWhatsAppRecovery();
        }

        if (attempt < retries) {
          await waitForPageReady();
        } else {
          throw err;
        }
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
    // ── Phase 1: Fast basic data directly from WhatsApp Web's in-memory store ──
    // window.Store.Chat.getModelsArray() is synchronous — it reads already-loaded
    // in-memory data without any serialization overhead, so it completes in
    // milliseconds regardless of how many chats the account has.
    // This completely bypasses the slow getChats() serialization path.
    let basicChats = null;
    try {
      basicChats = await whatsappClient.pupPage.evaluate(() => {
        const models =
          window.Store?.Chat?.getModelsArray?.() ||
          window.WWebJS?.store?.Chat?.getModelsArray?.() ||
          [];
        return models
          .filter((c) => c.id?._serialized !== "status@broadcast")
          .map((c) => ({
            id: c.id._serialized,
            name:
              c.formattedTitle || c.name || c.id.user || c.id._serialized || "",
            unreadCount: c.unreadCount || 0,
            isGroup: !!c.isGroup,
            timestamp: c.t || 0,
          }))
          .sort((a, b) => b.timestamp - a.timestamp);
      });
    } catch (e) {
      console.warn("[get-unread-chats] Fast path failed:", e.message);
    }

    // Fallback: if the page evaluate didn't work, use the standard API
    // (slower but guaranteed to work).
    if (!basicChats || basicChats.length === 0) {
      console.log("[get-unread-chats] Falling back to getChats()");
      const chats = await retryOnDetachedFrame(() =>
        withTimeout(whatsappClient.getChats(), 60000, null),
      );
      if (!chats) return { chats: [], skipped: true };
      basicChats = chats
        .filter((c) => c.id._serialized !== "status@broadcast")
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .map((c) => ({
          id: c.id._serialized,
          name: c.name || c.id.user || c.id._serialized,
          unreadCount: c.unreadCount || 0,
          isGroup: !!c.isGroup,
          timestamp: c.timestamp || 0,
        }));
    }

    if (!basicChats || basicChats.length === 0) return { chats: [] };

    // Build result objects merging basic data with the enrichment cache.
    const result = basicChats.map((chat) => {
      const cached = enrichedChatCache.get(chat.id);
      const contactNumber = chat.id.includes("@")
        ? chat.id.split("@")[0]
        : chat.id;
      return {
        id: chat.id,
        name: cached?.name || chat.name,
        number: contactNumber,
        whatsappName: cached?.whatsappName || "",
        unreadCount: chat.unreadCount,
        isGroup: chat.isGroup,
        profilePicUrl: cached?.profilePicUrl || null,
        timestamp: chat.timestamp,
        lastMessage: cached?.lastMessage || "",
      };
    });

    // ── Phase 2: Background enrichment (contact names, profile pics, last msgs) ──
    // Run getChats() in the background — it's slow for large accounts but the
    // UI is already rendered. Use setImmediate so the IPC reply is dispatched
    // first (same anti-race pattern as progressive file loading).
    if (!enrichmentInProgress && enrichedChatCache.size === 0) {
      setImmediate(async () => {
        try {
          const fullChats = await retryOnDetachedFrame(() =>
            withTimeout(whatsappClient.getChats(), 120000, null),
          );
          if (fullChats) {
            const filtered = fullChats
              .filter((c) => c.id._serialized !== "status@broadcast")
              .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            enrichChatsInBackground(filtered);
          }
        } catch (e) {
          console.error(
            "[Enrichment] getChats() background failed:",
            e.message,
          );
          enrichmentInProgress = false;
        }
      });
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
// Phase 1: reads WhatsApp Web's in-memory message store via pupPage.evaluate()
//          — synchronous, completes in <100ms regardless of chat size.
// Phase 2: background getChatById()+fetchMessages() fetches messages that are
//          not yet loaded in the page memory (older history), streamed as batches.
ipcMain.handle("get-chat-files", async (event, chatId, trackedUnreadIds) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };

  try {
    const _t0 = Date.now();
    console.log(`[Files] START chatId=${chatId}`);

    // ── Fast path: read from WhatsApp Web's in-memory message store ──────────
    // window.Store.Chat.get(chatId).msgs contains every message WhatsApp Web
    // has already loaded — no network, no Puppeteer serialization overhead.
    let storeMessages = [];
    let unreadCount = 0;
    let chatName = null;
    const unreadMsgIds = new Set();
    try {
      const storeData = await whatsappClient.pupPage.evaluate((cid) => {
        const chat = window.Store?.Chat?.get?.(cid);
        if (!chat) return null;
        const allMsgs = chat.msgs?.getModelsArray?.() || [];
        const unreadCount = chat.unreadCount || 0;

        // Get chat contact name for fallback
        const chatName =
          chat.name ||
          chat.contact?.pushname ||
          chat.contact?.name ||
          chat.formattedTitle ||
          null;

        // Compute unread IDs from ALL messages (text + media) so that
        // slice(-unreadCount) correctly identifies the last N messages
        // regardless of type. Filtering to media-only first would cause
        // unread detection to break when most unread messages are text.
        const sortedAll = [...allMsgs].sort((a, b) => (a.t || 0) - (b.t || 0));
        const unreadIds =
          unreadCount > 0
            ? sortedAll
                .slice(-unreadCount)
                .map((m) => m.id?._serialized)
                .filter(Boolean)
            : [];

        // Include: text messages, voice notes, images, and documents (no video)
        const ALLOWED_TYPES = ["chat", "image", "document", "ptt", "audio"];

        return {
          unreadCount,
          unreadIds,
          chatName,
          messages: allMsgs
            .filter((m) => m.hasMedia || ALLOWED_TYPES.includes(m.type))
            .map((m) => {
              // For messages from others, try to get sender name from various sources
              const isFromMe = m.id?.fromMe || m.fromMe;
              let sender = null;
              if (!isFromMe) {
                sender =
                  m.notifyName ||
                  m._data?.notifyName ||
                  m.senderObj?.pushname ||
                  m.senderObj?.name ||
                  m.pushName ||
                  m._data?.pushName ||
                  chatName;
              }
              return {
                id: m.id?._serialized,
                type: m.type || "chat",
                timestamp: m.t || 0,
                body: m.body || m.caption || "",
                sender,
                fromMe: isFromMe,
                fileName: m.filename || m.mediaFilename || null,
                mimeType: m.mimetype || null,
                fileSize: m.size || m.filesize || null,
              };
            }),
        };
      }, chatId);

      if (storeData) {
        storeMessages = (storeData.messages || []).filter((m) => m.id);
        unreadCount = storeData.unreadCount;
        chatName = storeData.chatName || null;
        // unreadIds from the store are already correctly computed from all msgs
        (storeData.unreadIds || []).forEach((id) => unreadMsgIds.add(id));
      }
      console.log(
        `[Files] store read in ${Date.now() - _t0}ms — ${storeMessages.length} media msgs in memory, ${unreadMsgIds.size} unread IDs`,
      );
    } catch (e) {
      console.warn("[Files] Memory store fast path failed:", e.message);
    }

    // Merge client-tracked IDs (real-time onNewMessage events) into unread set
    if (Array.isArray(trackedUnreadIds)) {
      trackedUnreadIds.forEach((id) => unreadMsgIds.add(id));
    }

    // Extract file info from raw in-memory store data (Node.js side)
    function extractFromRaw(raw) {
      let { fileName, mimeType, fileSize } = raw;
      if (!fileName) {
        const ext =
          mime.extension(mimeType || "application/octet-stream") || "bin";
        fileName = `${raw.type || "file"}_${raw.timestamp}.${ext}`;
      }
      const safeId = (raw.id || "").replace(/[^a-zA-Z0-9]/g, "_");
      const expectedPath = path.join(DOWNLOADS_DIR, `${safeId}_${fileName}`);
      const isDownloaded = fs.existsSync(expectedPath);

      // Determine sender - use "You" for messages you sent, otherwise try to get sender name
      const isFromMe = raw.fromMe === true;
      const senderName = isFromMe ? null : raw.sender || chatName || "Unknown";

      return {
        messageId: raw.id,
        chatId,
        sender: senderName,
        fromMe: isFromMe,
        timestamp: raw.timestamp,
        type: raw.type,
        body: raw.body || "",
        caption: raw.body,
        fileName,
        mimeType,
        fileSize,
        isDownloaded,
        localPath: isDownloaded ? expectedPath : null,
        isUnread: unreadMsgIds.has(raw.id),
      };
    }

    // Helper for whatsapp-web.js message objects (used in background fetch)
    function extractFileInfo(msg) {
      // Determine sender - use null for messages you sent (renderer shows "You"), otherwise get sender name
      const isFromMe = msg.id?.fromMe || msg.fromMe;
      const senderName = isFromMe
        ? null
        : msg._data?.notifyName ||
          msg._data?.pushName ||
          msg.author ||
          chatName ||
          "Unknown";

      const info = {
        messageId: msg.id._serialized,
        chatId,
        sender: senderName,
        fromMe: isFromMe || false,
        timestamp: msg.timestamp,
        type: msg.type,
        body: msg.body || "",
        caption: msg.body || "",
        // Try both capitalisations — WhatsApp Web store uses lowercase 'filename'
        // but some ww.js versions alias it as 'fileName' (capital N).
        fileName: msg._data?.fileName || msg._data?.filename || null,
        mimeType: msg._data?.mimetype || msg._data?.mimeType || null,
        fileSize: msg._data?.size || null,
        isDownloaded: false,
        localPath: null,
        isUnread: unreadMsgIds.has(msg.id._serialized),
      };
      if (!info.fileName) {
        const ext =
          mime.extension(info.mimeType || "application/octet-stream") || "bin";
        info.fileName = `${info.type || "file"}_${msg.timestamp}.${ext}`;
      }
      const expectedPath = path.join(
        DOWNLOADS_DIR,
        `${msg.id._serialized.replace(/[^a-zA-Z0-9]/g, "_")}_${info.fileName}`,
      );
      if (fs.existsSync(expectedPath)) {
        info.isDownloaded = true;
        info.localPath = expectedPath;
      }
      return info;
    }

    const storeFiles = storeMessages.map(extractFromRaw);
    const unreadFiles = storeFiles.filter((f) => f.isUnread);
    const olderStoreFiles = storeFiles.filter((f) => !f.isUnread);
    unreadFiles.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    olderStoreFiles.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // IDs already sent — used to deduplicate against server fetch
    const sentIds = new Set(storeFiles.map((f) => f.messageId));

    console.log(
      `[Files] split: ${unreadFiles.length} unread, ${olderStoreFiles.length} older in memory`,
    );

    // ── Background: send older in-memory files, then fetch from server ────────
    // setImmediate ensures the IPC reply is dispatched first so the renderer
    // DOM is ready before any batch arrives (prevents the wipe-on-resume race).
    setImmediate(async () => {
      const FILE_BATCH_SIZE = 10;
      try {
        // 1. Send older in-memory files immediately (no network required)
        if (olderStoreFiles.length > 0) {
          for (let i = 0; i < olderStoreFiles.length; i += FILE_BATCH_SIZE) {
            mainWindow?.webContents.send("whatsapp:chat-files-batch", {
              chatId,
              files: olderStoreFiles.slice(i, i + FILE_BATCH_SIZE),
              done: false,
            });
          }
        }

        // 2. Fetch from server to surface messages not yet loaded in memory
        let serverMessages = [];
        try {
          const chat = await retryOnDetachedFrame(() =>
            whatsappClient.getChatById(chatId),
          );
          serverMessages = await retryOnDetachedFrame(() =>
            chat.fetchMessages({ limit: 100 }),
          );
          console.log(
            `[Files] fetchMessages done in ${Date.now() - _t0}ms — ${serverMessages.length} server msgs`,
          );
        } catch (e) {
          console.warn("[Files] fetchMessages failed:", e.message);
        }

        // 3. Only process messages not already shown from the in-memory store.
        // Include: text messages, voice notes, images, and documents (no video)
        const ALLOWED_TYPES = ["chat", "image", "document", "ptt", "audio"];
        const newMediaMsgs = serverMessages
          .filter(
            (m) =>
              (m.hasMedia || ALLOWED_TYPES.includes(m.type)) &&
              !sentIds.has(m.id._serialized),
          )
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const newFiles = newMediaMsgs.map(extractFileInfo);

        if (newFiles.length > 0) {
          for (let i = 0; i < newFiles.length; i += FILE_BATCH_SIZE) {
            mainWindow?.webContents.send("whatsapp:chat-files-batch", {
              chatId,
              files: newFiles.slice(i, i + FILE_BATCH_SIZE),
              done: i + FILE_BATCH_SIZE >= newFiles.length,
            });
          }
        } else {
          // Nothing new from server — signal done so loading indicator clears
          mainWindow?.webContents.send("whatsapp:chat-files-batch", {
            chatId,
            files: [],
            done: true,
          });
        }

        // 4. Fix isDownloaded status for files already shown in Phase 1 and
        //    auto-download any unread files genuinely missing from disk.
        //
        //    Phase 1 reads filenames from raw store model properties (m.filename)
        //    which may differ from msg._data?.fileName used by extractFileInfo,
        //    causing Phase 1 to report isDownloaded=false even when the file is
        //    already on disk.  Phase 2 skips those messages via sentIds, so no
        //    correction ever reaches the renderer.  We fix that here.
        const allPrintable = serverMessages.filter(
          (m) => m.hasMedia || ALLOWED_TYPES.includes(m.type),
        );
        for (const msg of allPrintable) {
          const info = extractFileInfo(msg);
          const wasInPhase1 = sentIds.has(info.messageId);

          if (info.isDownloaded && wasInPhase1) {
            // Correct a Phase-1 false-negative (filename capitalisation mismatch)
            mainWindow?.webContents.send("whatsapp:file-auto-downloaded", {
              chatId,
              messageId: info.messageId,
              localPath: info.localPath,
              fileName: info.fileName,
            });
          } else if (!info.isDownloaded && unreadMsgIds.has(info.messageId)) {
            // Unread file not on disk — download it now so it can be selected.
            try {
              const media = await msg.downloadMedia();
              if (!media) continue;
              let finalFileName =
                msg._data?.fileName ||
                msg._data?.filename ||
                media.filename ||
                null;
              if (!finalFileName) {
                const ext = mime.extension(media.mimetype) || "bin";
                finalFileName = `${msg.type || "file"}_${msg.timestamp}.${ext}`;
              }
              const safeMsgId = msg.id._serialized.replace(
                /[^a-zA-Z0-9]/g,
                "_",
              );
              const localPath = path.join(
                DOWNLOADS_DIR,
                `${safeMsgId}_${finalFileName}`,
              );
              if (!fs.existsSync(localPath)) {
                const buffer = Buffer.from(media.data, "base64");
                fs.writeFileSync(localPath, buffer);
              }
              mainWindow?.webContents.send("whatsapp:file-auto-downloaded", {
                chatId,
                messageId: msg.id._serialized,
                localPath,
                fileName: finalFileName,
              });
            } catch (e) {
              console.warn(
                `[Files] Auto-download failed for ${msg.id._serialized}:`,
                e.message,
              );
            }
          }
        }

        // 5. Resolve sender names for printable messages only
        const ALLOWED_TYPES_FOR_SENDER = [
          "chat",
          "image",
          "document",
          "ptt",
          "audio",
        ];
        const allWWJSMedia = serverMessages.filter(
          (m) => m.hasMedia || ALLOWED_TYPES_FOR_SENDER.includes(m.type),
        );
        for (const msg of allWWJSMedia) {
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
      } catch (err) {
        console.error("[Files] Background task failed:", err.message);
        mainWindow?.webContents.send("whatsapp:chat-files-batch", {
          chatId,
          files: [],
          done: true,
        });
      }
    });

    console.log(
      `[Files] returning Phase 1 at ${Date.now() - _t0}ms — ${unreadFiles.length} unread, hasOlderFiles=${storeFiles.length > 0 || true}`,
    );
    return {
      files: unreadFiles,
      unreadCount,
      // Always true — background always runs to fetch additional server data.
      // Renderer handles empty-state via onChatFilesBatch done+empty check.
      hasOlderFiles: true,
    };
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

    // If no printer is selected, open Electron's system print dialog (Ctrl+Shift+P equivalent)
    if (!printerName) {
      const { pathToFileURL } = require("url");
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
      for (const filePath of filePaths) {
        try {
          if (!fs.existsSync(filePath)) {
            results.push({ filePath, error: "File not found" });
            continue;
          }
          await new Promise((resolve, reject) => {
            const ext = path.extname(filePath).toLowerCase();
            const fileUrl = pathToFileURL(filePath).href;
            const isImage = imageExts.includes(ext);

            const printWin = new BrowserWindow({
              show: false,
              width: 800,
              height: 1100,
              webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
              },
            });

            let tempHtmlPath = null;
            const cleanup = () => {
              if (tempHtmlPath) {
                try {
                  fs.unlinkSync(tempHtmlPath);
                } catch {}
                tempHtmlPath = null;
              }
            };

            const doPrint = () => {
              // Delay lets the renderer finish painting before print is triggered,
              // preventing blank pages on hidden windows.
              setTimeout(() => {
                printWin.webContents.print(
                  { silent: false },
                  (success, errorType) => {
                    printWin.close();
                    cleanup();
                    if (success) resolve();
                    else reject(new Error(errorType || "Print cancelled"));
                  },
                );
              }, 500);
            };

            if (isImage) {
              // Wrap image in a full HTML page so the renderer has proper content
              // to paint. Loading a raw file:// image URL can produce a blank print
              // because the browser's image-viewer wrapper is not fully rendered in
              // a hidden window before print() is called.
              const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; background: white; }
img { max-width: 100%; height: auto; display: block; }
@media print { img { max-width: 100%; page-break-inside: avoid; } }
</style>
</head>
<body><img src="${fileUrl}"></body>
</html>`;
              tempHtmlPath = path.join(
                os.tmpdir(),
                `wpm-print-${Date.now()}.html`,
              );
              fs.writeFileSync(tempHtmlPath, htmlContent, "utf8");
              printWin.loadFile(tempHtmlPath);
            } else {
              printWin.loadURL(fileUrl);
            }

            printWin.webContents.once("did-finish-load", doPrint);

            printWin.webContents.once("did-fail-load", (_ev, code, desc) => {
              printWin.close();
              cleanup();
              reject(new Error(desc || `Load failed (${code})`));
            });
          });
          results.push({
            filePath,
            success: true,
            method: "system-print-dialog",
          });
        } catch (err) {
          // "Print cancelled" is not a real error — the user closed the dialog
          if (err.message === "Print cancelled") {
            results.push({
              filePath,
              success: true,
              method: "system-print-dialog",
            });
          } else {
            console.error(
              `[Print] Error opening system print dialog for ${filePath}:`,
              err,
            );
            results.push({ filePath, error: err.message });
          }
        }
      }
      return { results };
    }

    const targetPrinter = printerName;

    // Step 1: Open the printer driver's Printing Preferences dialog
    // This lets the user set color/BW, quality, paper size, orientation, pages per sheet, etc.
    try {
      console.log(`[Print] Opening preferences for printer: ${targetPrinter}`);
      await new Promise((resolve) => {
        // printui /e opens "Printing Preferences" for the named printer
        const cmd = `printui /e /n "${targetPrinter.replace(/"/g, '\\"')}"`;
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

// Open Windows "Open With" dialog for a single file
ipcMain.handle("open-with-dialog", async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { error: "File not found" };
    }
    await launchWindowsOpenWithDialog(filePath);
    return { success: true };
  } catch (error) {
    return { error: error.message || "Failed to open dialog" };
  }
});

ipcMain.handle("get-open-with-apps", async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { error: "File not found", apps: [] };
    }

    const apps = await listOpenWithApps(filePath);
    cleanupOpenWithSessions();

    const requestId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const commandMap = new Map(
      apps
        .filter(
          (a) =>
            a.id !== "__default__" &&
            a.id !== "__windows_open_with__" &&
            a.command,
        )
        .map((a) => [a.id, a.command]),
    );
    openWithSessions.set(requestId, { createdAt: Date.now(), commandMap });

    return {
      requestId,
      apps: apps.map((a) => ({ id: a.id, name: a.name })),
    };
  } catch (error) {
    return { error: error.message || "Failed to get app list", apps: [] };
  }
});

ipcMain.handle("open-files-with-app", async (event, payload) => {
  try {
    const body = payload || {};
    const requestId = body.requestId;
    const appId = body.appId;
    const filePaths = Array.isArray(body.filePaths) ? body.filePaths : [];
    const existingFilePaths = filePaths.filter((fp) => fp && fs.existsSync(fp));
    const allImages = existingFilePaths.every((fp) => isImageFilePath(fp));

    if (!existingFilePaths.length) {
      return { error: "No valid files selected" };
    }

    if (appId === "__paint__") {
      // Open files in Paint - Paint only supports one file at a time
      const results = [];
      for (const filePath of existingFilePaths) {
        try {
          const { spawn } = require("child_process");
          const child = spawn("mspaint.exe", [filePath], {
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          results.push({ filePath, success: true });
          // Small delay between instances to ensure proper launching
          if (existingFilePaths.length > 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        } catch (error) {
          results.push({ filePath, error: error.message });
        }
      }
      return { success: results.some((r) => r.success), results };
    }

    if (appId === "__print_pictures__") {
      return await openPrintPicturesDialog(existingFilePaths);
    }

    if (appId === "__windows_photos__") {
      return await openWithWindowsPhotos(existingFilePaths);
    }

    if (!appId || appId === "__default__") {
      if (allImages) {
        return await openPrintPicturesDialog(existingFilePaths);
      }
      for (const filePath of existingFilePaths) {
        await shell.openPath(filePath);
      }
      return { success: true };
    }

    if (appId === "__windows_open_with__") {
      const results = [];
      for (const filePath of existingFilePaths) {
        try {
          await launchWindowsOpenWithDialog(filePath);
          results.push({ filePath, success: true });
        } catch (error) {
          results.push({ filePath, error: error.message || "Failed to open" });
        }
      }
      return { success: results.some((r) => r.success), results };
    }

    cleanupOpenWithSessions();
    const session = openWithSessions.get(requestId);
    if (!session || !session.commandMap || !session.commandMap.has(appId)) {
      return {
        error: "App selection expired. Please open the app menu again.",
      };
    }

    const commandTemplate = session.commandMap.get(appId);
    try {
      // Launch once with all selected files so compatible apps can open tabs
      // in a single window instead of spawning one window per file.
      await launchWithCommandTemplate(commandTemplate, existingFilePaths);
      return {
        success: true,
        results: existingFilePaths.map((filePath) => ({
          filePath,
          success: true,
        })),
      };
    } catch (error) {
      return {
        error: error.message || "Failed to open",
        results: existingFilePaths.map((filePath) => ({
          filePath,
          error: error.message || "Failed to open",
        })),
      };
    }
  } catch (error) {
    return { error: error.message || "Failed to open files" };
  }
});

// Open multiple images in the Windows "Print Pictures" dialog
ipcMain.handle("open-print-pictures", async (event, filePaths) => {
  return await openPrintPicturesDialog(filePaths);
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

// ── Send Messages ────────────────────────────────────────────────────────────

// Send text message
ipcMain.handle("send-text-message", async (event, chatId, message) => {
  if (!isClientReady) return { error: "WhatsApp not ready" };
  if (!chatId || !message) return { error: "Missing chatId or message" };
  try {
    const chat = await retryOnDetachedFrame(() =>
      whatsappClient.getChatById(chatId),
    );
    const sentMsg = await retryOnDetachedFrame(() => chat.sendMessage(message));

    // Notify renderer about the sent message
    const msgInfo = {
      messageId: sentMsg.id._serialized,
      chatId,
      sender: null, // null = "You" in renderer
      timestamp: sentMsg.timestamp || Math.floor(Date.now() / 1000),
      type: "chat",
      body: message,
      fromMe: true,
    };
    mainWindow?.webContents.send("whatsapp:message-sent", msgInfo);

    return { success: true, messageId: sentMsg.id._serialized };
  } catch (err) {
    console.error("Error sending text message:", err);
    return { error: err.message };
  }
});

// Send voice message
ipcMain.handle(
  "send-voice-message",
  async (event, chatId, audioBase64, mimeType) => {
    if (!isClientReady) return { error: "WhatsApp not ready" };
    if (!chatId || !audioBase64)
      return { error: "Missing chatId or audio data" };

    // Validate audio base64 data
    if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
      return { error: "Audio data is invalid or empty" };
    }

    try {
      const chat = await retryOnDetachedFrame(() =>
        whatsappClient.getChatById(chatId),
      );

      // Log chat details for debugging
      console.log(
        `Chat info - ID: ${chatId}, Name: ${chat.name}, IsGroup: ${chat.isGroup}, IsReadOnly: ${chat.isReadOnly}, Contact: ${chat.contact?.name || "N/A"}`,
      );

      // Try the provided MIME first, then common voice-safe fallbacks.
      const inputMime = String(mimeType || "").trim();
      const strippedMime = inputMime ? inputMime.split(";")[0].trim() : "";
      const mimeCandidates = [
        inputMime,
        strippedMime,
        "audio/ogg;codecs=opus",
        "audio/ogg",
        "audio/webm;codecs=opus",
        "audio/webm",
      ].filter(Boolean);

      // Deduplicate while preserving order.
      const uniqueMimes = [...new Set(mimeCandidates)];

      console.log(
        `Attempting voice send for chat ${chatId}, audio size: ${audioBase64.length} chars, MIME options: ${uniqueMimes.join(", ")}`,
      );

      let sentMsg = null;
      let lastError = null;

      for (const candidateMime of uniqueMimes) {
        const ext = candidateMime.includes("ogg")
          ? "ogg"
          : candidateMime.includes("webm")
            ? "webm"
            : "ogg";

        console.log(
          `Creating MessageMedia with MIME: ${candidateMime}, filename: voice.${ext}, base64 length: ${audioBase64.length}`,
        );

        try {
          const media = new MessageMedia(
            candidateMime,
            audioBase64,
            `voice.${ext}`,
          );
          console.log(
            `MessageMedia created successfully, media.mimetype: ${media.mimetype}, media.filename: ${media.filename}`,
          );

          // Prefer true WhatsApp voice-note mode first.
          try {
            console.log(`Sending as voice message...`);
            sentMsg = await retryOnDetachedFrame(() =>
              chat.sendMessage(media, { sendAudioAsVoice: true }),
            );
            console.log(`✓ Voice send succeeded!`);
            break;
          } catch (voiceErr) {
            lastError = voiceErr;
            const voiceDetails =
              voiceErr?.stack || JSON.stringify(voiceErr) || String(voiceErr);
            console.warn(
              `Voice send failed with MIME ${candidateMime}:`,
              voiceErr?.message || voiceErr,
              "Details:",
              voiceDetails,
            );
          }

          // Fallback: some environments cannot encode a valid PTT payload.
          // Send as regular audio so message is not lost.
          try {
            console.log(`Fallback: Sending as regular audio message...`);
            sentMsg = await retryOnDetachedFrame(() =>
              chat.sendMessage(media, { sendAudioAsVoice: false }),
            );
            console.log(`✓ Audio fallback send succeeded!`);
            break;
          } catch (audioErr) {
            lastError = audioErr;
            const audioDetails =
              audioErr?.stack || JSON.stringify(audioErr) || String(audioErr);
            console.warn(
              `Fallback audio send failed with MIME ${candidateMime}:`,
              audioErr?.message || audioErr,
              "Details:",
              audioDetails,
            );
          }
        } catch (mediaErr) {
          console.error(
            `Failed to create MessageMedia:`,
            mediaErr?.message || mediaErr,
          );
          lastError = mediaErr;
        }
      }

      if (!sentMsg) {
        // Extract meaningful error from lastError
        let errorMsg = "Could not send voice message";
        if (lastError) {
          const orig = lastError?.message || String(lastError) || "";
          if (orig === "t" || orig === "t: t") {
            // WhatsApp Web API error - likely session/auth/rate limit issue
            errorMsg =
              "WhatsApp Web validation failed. Try: 1) Refresh the app, 2) Check your internet, 3) Re-scan QR code";
          } else {
            errorMsg = orig || errorMsg;
          }
        }

        // Last resort: try sending as a plain audio file without voice options
        console.log("Last resort: attempting to send as plain audio file...");
        try {
          const lastMime = uniqueMimes[uniqueMimes.length - 1] || "audio/webm";
          const ext = lastMime.includes("ogg") ? "ogg" : "webm";
          const plainMedia = new MessageMedia(
            lastMime,
            audioBase64,
            `audio.${ext}`,
          );
          sentMsg = await retryOnDetachedFrame(() =>
            chat.sendMessage(plainMedia),
          );
          console.log("✓ Plain audio file send succeeded!");
        } catch (plainErr) {
          console.error("Last resort also failed:", plainErr?.message);
        }

        if (!sentMsg) {
          throw new Error(errorMsg);
        }
      }

      // Notify renderer about the sent message
      const msgInfo = {
        messageId: sentMsg.id._serialized,
        chatId,
        sender: null,
        timestamp: sentMsg.timestamp || Math.floor(Date.now() / 1000),
        type: sentMsg.type || "ptt",
        body: "",
        fromMe: true,
      };
      mainWindow?.webContents.send("whatsapp:message-sent", msgInfo);

      return { success: true, messageId: sentMsg.id._serialized };
    } catch (err) {
      console.error("Error sending voice message:", err);
      // Extract error details more carefully
      const errorMessage =
        err?.message || (err && String(err)) || "Failed to send voice message";
      return { error: errorMessage };
    }
  },
);

// Send file message
ipcMain.handle(
  "send-file-message",
  async (event, chatId, filePath, caption) => {
    if (!isClientReady) return { error: "WhatsApp not ready" };
    if (!chatId || !filePath) return { error: "Missing chatId or file path" };
    try {
      if (!fs.existsSync(filePath)) {
        return { error: "File not found" };
      }

      const chat = await retryOnDetachedFrame(() =>
        whatsappClient.getChatById(chatId),
      );

      const media = MessageMedia.fromFilePath(filePath);
      const sentMsg = await retryOnDetachedFrame(() =>
        chat.sendMessage(media, { caption: caption || "" }),
      );

      // Notify renderer about the sent message
      const msgInfo = {
        messageId: sentMsg.id._serialized,
        chatId,
        sender: null,
        timestamp: sentMsg.timestamp || Math.floor(Date.now() / 1000),
        type: sentMsg.type || "document",
        body: caption || "",
        fileName: path.basename(filePath),
        fromMe: true,
      };
      mainWindow?.webContents.send("whatsapp:message-sent", msgInfo);

      return { success: true, messageId: sentMsg.id._serialized };
    } catch (err) {
      console.error("Error sending file message:", err);
      return { error: err.message };
    }
  },
);

// Select file to send (opens file dialog)
ipcMain.handle("select-file-to-send", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select file to send",
    properties: ["openFile"],
    filters: [
      { name: "All Files", extensions: ["*"] },
      { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] },
      {
        name: "Documents",
        extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt"],
      },
      { name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a"] },
      { name: "Video", extensions: ["mp4", "avi", "mov", "mkv"] },
    ],
  });

  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }

  return {
    filePath: result.filePaths[0],
    fileName: path.basename(result.filePaths[0]),
  };
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

// Logout + full app restart (ensures account unlink and clean QR on next launch)
ipcMain.handle("logout-and-restart", async () => {
  try {
    if (whatsappClient) {
      try {
        await whatsappClient.logout();
      } catch (e) {
        console.error("[LogoutRestart] logout() failed:", e?.message || e);
      }
      try {
        await whatsappClient.destroy();
      } catch (e) {
        console.error("[LogoutRestart] destroy() failed:", e?.message || e);
      }
    }

    isClientReady = false;
    enrichedChatCache.clear();
    enrichmentInProgress = false;

    // Remove persisted auth/version caches to force QR for a new account.
    const authPath = getUserDataPath(".wwebjs_auth");
    const cachePath = getUserDataPath(".wwebjs_cache");
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
    } catch (e) {
      console.error("[LogoutRestart] Failed clearing auth data:", e);
    }
    try {
      fs.rmSync(cachePath, { recursive: true, force: true });
    } catch (e) {
      console.error("[LogoutRestart] Failed clearing version cache:", e);
    }
  } finally {
    app.relaunch();
    app.exit(0);
  }

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

    // Handle common error scenarios
    if (err.message && err.message.includes("404")) {
      return {
        available: false,
        error:
          "Update server not ready. Please check back later or visit the GitHub repository for manual download.",
        code: "UPDATE_METADATA_NOT_FOUND",
      };
    }

    if (
      err.message &&
      (err.message.includes("ENOTFOUND") ||
        err.message.includes("ECONNREFUSED"))
    ) {
      return {
        available: false,
        error:
          "Network error. Please check your internet connection and try again.",
        code: "NETWORK_ERROR",
      };
    }

    return {
      available: false,
      error:
        err.message || "Failed to check for updates. Please try again later.",
    };
  }
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

ipcMain.handle("restart-app", () => {
  app.relaunch();
  app.exit(0);
  return { success: true };
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
