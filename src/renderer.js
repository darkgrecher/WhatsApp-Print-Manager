// ══════════════════════════════════════════════════════════════════════════
// WhatsApp Print Manager - Renderer (Frontend Logic)
// ══════════════════════════════════════════════════════════════════════════

let currentChatId = null;
let currentFiles = [];
let selectedFiles = new Set();
let autoRefreshTimer = null;
let isRefreshing = false; // guard against re-entrant refresh
let showAllChats = false; // toggle between "recent/unread" and "all chats"
let newMessageRefreshTimer = null; // debounce timer for post-notification refresh
let newMessageFileReloadTimer = null; // debounce timer for file list reload
let suppressNextFileItemClick = false;
const dragSelectionState = {
  active: false,
  hasMoved: false,
  anchorMessageId: null,
  lastHoverMessageId: null,
  startX: 0,
  startY: 0,
};
let selectedOpenWithApp = {
  id: "__default__",
  name: "Default application",
};
const openWithPreferenceByType = new Map();
const pendingUnreadIds = new Map(); // chatId → Set<messageId> tracked client-side
let autoReclickTimer = null;
const AUTO_REFRESH_INTERVAL = 10000; // 10 seconds
const EXPLORER_SELECTION_SYNC_DEBOUNCE_MS = 120;
let explorerSelectionSyncTimer = null;
let lastExplorerSelectionSyncKey = null;
const WINDOWS_FILE_EXPLORER_APP_ID = "__windows_file_explorer__";

function getSingleTypeFromSet(typeSet) {
  return typeSet && typeSet.size === 1 ? Array.from(typeSet)[0] : null;
}

function getDefaultPreferenceApp() {
  return { id: "__default__", name: "Default application" };
}

function getOpenWithPreferenceForType(fileType) {
  if (!fileType) return getDefaultPreferenceApp();
  const pref = openWithPreferenceByType.get(fileType);
  if (pref && pref.id && pref.name) {
    return { id: pref.id, name: pref.name };
  }
  return getDefaultPreferenceApp();
}

function setOpenWithPreferenceForType(fileType, app) {
  if (!fileType || !app || !app.id) return;
  openWithPreferenceByType.set(fileType, {
    id: app.id,
    name: app.name || "Default application",
  });
}

function setFileSearchExpanded(expanded, options = {}) {
  const { focusInput = false } = options;
  const container = document.getElementById("file-search-toggle-container");
  const fileSearch = document.getElementById("file-search");

  if (!container) return;

  container.classList.toggle("expanded", !!expanded);

  if (expanded && focusInput && fileSearch) {
    setTimeout(() => fileSearch.focus(), 0);
  }
}

// ── Initialization ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  setupButtonListeners();
  loadPrinters();
  setupNetworkListeners();
});

function setupButtonListeners() {
  // Reconnect button
  const btnReconnect = document.getElementById("btn-reconnect");
  if (btnReconnect) btnReconnect.addEventListener("click", () => reconnect());

  const btnLoginAgain = document.getElementById("btn-login-again");
  if (btnLoginAgain) {
    btnLoginAgain.addEventListener("click", () => {
      if (btnReconnect) btnReconnect.classList.add("hidden");
      const qrStatus = document.getElementById("qr-status");
      if (qrStatus) qrStatus.textContent = "Clearing session and restarting...";
      const spinner = document.querySelector(".spinner");
      if (spinner) spinner.style.display = "inline-block";
      loginAgain();
    });
  }

  // Topbar buttons
  const btnRefresh = document.getElementById("btn-refresh");
  if (btnRefresh)
    btnRefresh.addEventListener("click", () => restartApplication());

  const btnOpenFolder = document.getElementById("btn-open-folder");
  if (btnOpenFolder)
    btnOpenFolder.addEventListener("click", () => openDownloadsFolder());

  // Profile trigger (toggle dropdown)
  const profileTrigger = document.getElementById("profile-trigger");
  if (profileTrigger)
    profileTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleProfileDropdown();
    });

  // Logout button
  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) btnLogout.addEventListener("click", () => logoutWhatsApp());

  // Check for Updates button
  const btnCheckUpdates = document.getElementById("btn-check-updates");
  if (btnCheckUpdates)
    btnCheckUpdates.addEventListener("click", () => checkForUpdates());

  // Display current version
  (async () => {
    try {
      const version = await window.api.getAppVersion();
      const badge = document.getElementById("current-version");
      if (badge) badge.textContent = "v" + version;
    } catch (_) {}
  })();

  // Close dropdown when clicking outside
  document.addEventListener("click", (e) => {
    const profileDropdown = document.getElementById("profile-dropdown");
    const profileSection = document.getElementById("profile-section");
    if (
      profileDropdown &&
      profileSection &&
      !profileSection.contains(e.target)
    ) {
      profileDropdown.classList.add("hidden");
    }

    const openWithContainer = document.getElementById("open-with-container");
    if (openWithContainer && !openWithContainer.contains(e.target)) {
      hideOpenWithDropdown();
    }

    const fileSearchToggleContainer = document.getElementById(
      "file-search-toggle-container",
    );
    const fileSearch = document.getElementById("file-search");
    if (
      fileSearchToggleContainer &&
      !fileSearchToggleContainer.contains(e.target)
    ) {
      const hasQuery = !!(fileSearch && fileSearch.value.trim().length);
      if (!hasQuery) {
        setFileSearchExpanded(false);
      }
    }
  });

  // File action buttons
  const btnUnselectAll = document.getElementById("btn-unselect-all");
  if (btnUnselectAll)
    btnUnselectAll.addEventListener("click", () => unselectAllFiles());

  const btnOpenSelected = document.getElementById("btn-open-selected");
  if (btnOpenSelected)
    btnOpenSelected.addEventListener("click", () => openSelected());

  const btnOpenWithMenu = document.getElementById("btn-open-with-menu");
  if (btnOpenWithMenu)
    btnOpenWithMenu.addEventListener("click", (event) =>
      toggleOpenWithDropdown(event),
    );

  updateOpenSelectedButtonLabel();

  const btnDelete = document.getElementById("btn-delete");
  if (btnDelete) btnDelete.addEventListener("click", () => deleteSelected());

  const btnOpenSelectedExplorer = document.getElementById(
    "btn-open-selected-explorer",
  );
  if (btnOpenSelectedExplorer) {
    btnOpenSelectedExplorer.addEventListener("click", () =>
      openSelectedInExplorer(),
    );
  }

  const btnFileSearchToggle = document.getElementById("btn-file-search-toggle");
  if (btnFileSearchToggle) {
    btnFileSearchToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const container = document.getElementById("file-search-toggle-container");
      const isExpanded = container?.classList.contains("expanded");
      setFileSearchExpanded(!isExpanded, { focusInput: !isExpanded });
    });
  }

  // Sidebar initial refresh button
  const btnSidebarRefresh = document.getElementById("btn-sidebar-refresh");
  if (btnSidebarRefresh)
    btnSidebarRefresh.addEventListener("click", () => refreshChats());

  // ── Search bars ──
  const chatSearch = document.getElementById("chat-search");
  const chatSearchClear = document.getElementById("chat-search-clear");
  if (chatSearch) {
    chatSearch.addEventListener("input", () => {
      filterChats(chatSearch.value);
      chatSearchClear.classList.toggle("hidden", chatSearch.value.length === 0);
    });
  }
  if (chatSearchClear) {
    chatSearchClear.addEventListener("click", () => {
      chatSearch.value = "";
      chatSearchClear.classList.add("hidden");
      filterChats("");
    });
  }

  const fileSearch = document.getElementById("file-search");
  const fileSearchClear = document.getElementById("file-search-clear");
  if (fileSearch) {
    fileSearch.addEventListener("focus", () => setFileSearchExpanded(true));
    fileSearch.addEventListener("input", () => {
      filterFiles(fileSearch.value);
      fileSearchClear.classList.toggle("hidden", fileSearch.value.length === 0);
    });
    fileSearch.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && fileSearch.value.length === 0) {
        setFileSearchExpanded(false);
      }
    });
  }
  if (fileSearchClear) {
    fileSearchClear.addEventListener("click", () => {
      fileSearch.value = "";
      fileSearchClear.classList.add("hidden");
      filterFiles("");
      fileSearch.focus();
    });
  }

  // ── License screen buttons ──
  const btnRequestTrial = document.getElementById("btn-request-trial");
  if (btnRequestTrial)
    btnRequestTrial.addEventListener("click", () => requestTrialVersion());

  const btnCheckAgain = document.getElementById("btn-check-again");
  if (btnCheckAgain)
    btnCheckAgain.addEventListener("click", () => recheckLicense());

  const btnCheckAgainExpired = document.getElementById(
    "btn-check-again-expired",
  );
  if (btnCheckAgainExpired)
    btnCheckAgainExpired.addEventListener("click", () => recheckLicense());

  const btnCheckAgainRejected = document.getElementById(
    "btn-check-again-rejected",
  );
  if (btnCheckAgainRejected)
    btnCheckAgainRejected.addEventListener("click", () => recheckLicense());

  const btnCheckAgainError = document.getElementById("btn-check-again-error");
  if (btnCheckAgainError)
    btnCheckAgainError.addEventListener("click", () => restartApplication());

  const btnLicenseLogout = document.getElementById("btn-license-logout");
  if (btnLicenseLogout)
    btnLicenseLogout.addEventListener("click", () => licenseLogout());

  // ── Chat Input Bar ──
  setupChatInputBar();
}

function setupEventListeners() {
  // ── ESC key to close chat ──
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && currentChatId) {
      closeChat();
    }
  });

  document.addEventListener("mousemove", handleDragSelectionMouseMove);
  document.addEventListener("mouseup", finishDragSelection);

  // WhatsApp QR Code
  window.api.onQRCode((qrDataURL) => {
    stopInitTimer();
    const qrImg = document.getElementById("qr-image");
    const qrStatus = document.getElementById("qr-status");
    const spinner = document.querySelector(".spinner");

    qrImg.src = qrDataURL;
    qrImg.classList.remove("hidden");
    if (qrStatus)
      qrStatus.textContent = "Scan this QR code with WhatsApp on your phone";
    if (spinner) spinner.style.display = "none";
  });

  // WhatsApp Status
  window.api.onStatus((status) => {
    console.log("WhatsApp status:", status);
    const badge = document.getElementById("connection-badge");

    switch (status) {
      case "launching":
        setQrStatus("Starting ...");
        startInitTimer();
        break;
      case "qr_ready":
        stopInitTimer();
        break;
      case "authenticated":
        stopInitTimer();
        showLoginLoading();
        break;
      case "ready":
        stopInitTimer();
        validateLicense();
        break;
      case "recovering":
        if (badge) {
          badge.textContent = "Recovering...";
          badge.className = "badge";
          badge.style.background = "#f59e0b";
          badge.style.color = "white";
        }
        showToast(
          "WhatsApp connection lost. Recovering automatically...",
          "warning",
        );
        break;
      case "recovery_failed":
        if (badge) {
          badge.textContent = "Recovery Failed";
          badge.className = "badge";
          badge.style.background = "#dc2626";
          badge.style.color = "white";
        }
        showToast(
          "Automatic recovery failed. Please restart the app.",
          "error",
        );
        document.getElementById("btn-reconnect").classList.remove("hidden");
        break;
      case "disconnected":
        if (badge) {
          badge.textContent = "Disconnected";
          badge.className = "badge";
          badge.style.background = "#dc2626";
          badge.style.color = "white";
        }
        showToast("WhatsApp disconnected", "error");
        break;
      case "auth_failure":
        showToast("Authentication failed. Please try again.", "error");
        document.getElementById("btn-reconnect").classList.remove("hidden");
        document.getElementById("btn-login-again").classList.remove("hidden");
        break;
      case "error":
        stopInitTimer();
        const qrStatusError = document.getElementById("qr-status");
        if (qrStatusError)
          qrStatusError.textContent =
            "Connection failed due to network/startup timeout.";
        const spinnerError = document.querySelector(".spinner");
        if (spinnerError) spinnerError.style.display = "none";

        document.getElementById("btn-reconnect").classList.remove("hidden");
        document.getElementById("btn-login-again").classList.remove("hidden");
        showToast("Initialization failed.", "error");
        break;
      case "retrying":
        {
          stopInitTimer();
          const qrImg = document.getElementById("qr-image");
          const qrStatus = document.getElementById("qr-status");
          const spinner = document.querySelector(".spinner");
          if (qrImg) qrImg.classList.add("hidden");
          if (spinner) spinner.style.display = "";
          if (qrStatus)
            qrStatus.textContent = "Connection issue detected. Retrying...";
          startInitTimer();
        }
        showToast("Connection issue detected, retrying...", "info");
        break;
      case "logged_out":
        switchToLoginScreen();
        showToast("Logged out successfully", "info");
        break;
    }
  });

  // Loading screen (WhatsApp Web loading_screen events — fires after auth)
  window.api.onLoading(({ percent, message }) => {
    const fill = document.getElementById("loading-bar-fill");
    const text = document.getElementById("loading-text");
    const container = document.getElementById("loading-bar-container");

    if (container) container.classList.remove("hidden");
    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = `${message} (${percent}%)`;
  });

  // Download progress (single)
  window.api.onDownloadProgress(({ messageId, status }) => {
    updateFileStatus(messageId, status);
  });

  // Bulk download progress
  window.api.onBulkDownloadProgress(({ current, total, messageId }) => {
    const fill = document.getElementById("bulk-progress-fill");
    const text = document.getElementById("bulk-progress-text");
    const container = document.getElementById("bulk-progress");

    container.classList.remove("hidden");
    const pct = Math.round((current / total) * 100);
    fill.style.width = `${pct}%`;
    text.textContent = `Downloading ${current} of ${total} files...`;

    if (current === total) {
      setTimeout(() => container.classList.add("hidden"), 2000);
    }
  });

  // ── Progressive chat enrichment ──
  // As the backend streams enriched chat data (profile pics, last messages,
  // resolved names), update each chat item in-place without rebuilding.
  window.api.onChatEnriched((batch) => {
    for (const data of batch) {
      const el = document.querySelector(
        `.chat-item[data-chat-id="${CSS.escape(data.id)}"]`,
      );
      if (!el) continue;

      // Update stored chat data
      if (window._chatData && window._chatData[data.id]) {
        Object.assign(window._chatData[data.id], data);
      }

      const chatData = (window._chatData && window._chatData[data.id]) || data;
      const displayNumber = getDisplayChatNumber(chatData);
      const displayName = getDisplayChatName(chatData, displayNumber);

      const numberEl = el.querySelector(".chat-number");
      if (numberEl) {
        numberEl.textContent = displayNumber;
        numberEl.classList.toggle("hidden", !displayNumber);
      }

      const contactNameEl = el.querySelector(".chat-contact-name");
      if (contactNameEl) {
        contactNameEl.textContent =
          displayName + (chatData.isGroup ? " \uD83D\uDC65" : "");
        contactNameEl.classList.toggle("hidden", !displayName);
      }

      el.dataset.chatName = displayName || displayNumber || chatData.name || "";

      // Update profile picture
      if (data.profilePicUrl) {
        const avatarEl = el.querySelector(".chat-avatar");
        if (avatarEl) {
          const initials = getInitials(
            displayName || displayNumber || chatData.name || "",
          );
          avatarEl.innerHTML = `<img src="${escapeHtml(data.profilePicUrl)}" alt="" onerror="this.parentElement.textContent='${initials}'">`;
        }
      }

      // Update last message preview
      if (data.lastMessage) {
        let lastMsgEl = el.querySelector(".chat-last-msg");
        if (lastMsgEl) {
          lastMsgEl.textContent = data.lastMessage;
        } else {
          const chatInfo = el.querySelector(".chat-info");
          if (chatInfo) {
            const div = document.createElement("div");
            div.className = "chat-last-msg";
            div.textContent = data.lastMessage;
            chatInfo.appendChild(div);
          }
        }
      }
    }
  });

  // ── Progressive file loading ──
  // Older files arrive in batches via IPC after unread files were returned.
  window.api.onChatFilesBatch(({ chatId, files, done }) => {
    console.log(
      `[onChatFilesBatch] chatId=${chatId} files=${files.length} done=${done} (currentChatId=${currentChatId})`,
    );
    // Ignore batches for a chat we're no longer viewing
    if (chatId !== currentChatId) return;

    if (files.length > 0) {
      currentFiles.push(...files);
      document.getElementById("file-count").textContent =
        `${currentFiles.length} file${currentFiles.length !== 1 ? "s" : ""}`;

      const fileList = document.getElementById("file-list");

      // Auto-select downloaded unread files
      const newUnread = files.filter((f) => f.isUnread && f.isDownloaded);
      newUnread.forEach((f) => selectedFiles.add(f.messageId));
      if (newUnread.length > 0) {
        updateSelectionUI();
      }

      // Re-render the entire message list in proper chronological order
      // This ensures older messages appear at top and new at bottom
      renderFiles();
    }

    // Remove loading indicator when done
    if (done) {
      const fileList = document.getElementById("file-list");
      const loadingEl = fileList.querySelector("#older-files-loading");
      if (loadingEl) loadingEl.remove();

      // If nothing loaded at all (no unread, no older), show empty state
      if (currentFiles.length === 0) {
        fileList.innerHTML = `<div class="empty-state"><p>No media files found in this chat</p></div>`;
        document.getElementById("file-count").textContent = "0 files";
      }
    }
  });

  // ── Auto-downloaded file notification ──
  // Fires when Phase 2 either confirms a file is already on disk (correcting
  // a Phase-1 false-negative) or has just freshly downloaded an unread file.
  window.api.onFileAutoDownloaded(
    ({ chatId, messageId, localPath, fileName }) => {
      if (chatId !== currentChatId) return;

      // Update in-memory record
      const file = currentFiles.find((f) => f.messageId === messageId);
      if (!file) return;
      file.isDownloaded = true;
      file.localPath = localPath;
      if (fileName) file.fileName = fileName;

      // Update DOM: enable the checkbox and update status badge + action buttons
      const safeMsgId = messageId.replace(/[^a-zA-Z0-9]/g, "_");
      const fileEl = document.getElementById(`file-${safeMsgId}`);
      if (fileEl) {
        const checkbox = fileEl.querySelector(".file-checkbox");
        if (checkbox) {
          checkbox.disabled = false;
          checkbox.removeAttribute("title");
        }

        // Update status badge to show "✓ Ready"
        const statusEl = fileEl.querySelector(".status-badge");
        if (statusEl) {
          statusEl.className = "status-badge downloaded";
          statusEl.textContent = "✓ Ready";
        }

        // Update action buttons: replace download button with open buttons
        const actionsDiv = fileEl.querySelector(".file-actions");
        if (actionsDiv) {
          actionsDiv.innerHTML = `
            <button class="btn-file-action" data-action="open-file" data-path="${escapeHtml(localPath)}">Open</button>
          `;
          attachFileEventListeners(fileEl);
        }

        if (file.type === "sticker" && file.localPath) {
          const stickerContent = fileEl.querySelector(
            ".sticker-message-content",
          );
          if (stickerContent) {
            const stickerSrc = `file:///${file.localPath.replace(/\\/g, "/")}`;
            stickerContent.innerHTML = `<img class="sticker-image" src="${escapeHtml(stickerSrc)}" alt="Sticker" loading="lazy" />`;
          }
        }
      }

      // Auto-select unread files (same behaviour as selectChat's initial render)
      if (
        file.isUnread &&
        isSelectableMediaFile(file) &&
        !selectedFiles.has(messageId)
      ) {
        selectedFiles.add(messageId);
        if (fileEl) {
          fileEl.classList.add("selected");
          const checkbox = fileEl.querySelector(".file-checkbox");
          if (checkbox) checkbox.checked = true;
        }
        updateSelectionUI();
      }
    },
  );

  // ── Sender name resolution for unread files ──
  window.api.onFileSenderResolved(({ chatId, messageId, sender }) => {
    if (chatId !== currentChatId) return;
    // Update in currentFiles
    const file = currentFiles.find((f) => f.messageId === messageId);
    if (file) file.sender = sender;
    // Update in DOM
    const safeMsgId = messageId.replace(/[^a-zA-Z0-9]/g, "_");
    const el = document.querySelector(`#file-${safeMsgId} .file-meta`);
    if (el) {
      const fromSpan = [...el.querySelectorAll("span")].find((s) =>
        s.textContent.startsWith("From:"),
      );
      if (fromSpan) fromSpan.textContent = `From: ${sender}`;
    }
  });

  // ── Real-time new message listener ──
  window.api.onNewMessage((data) => {
    console.log("[NewMessage]", data);
    // 'album' is a WhatsApp container event that wraps a group of images —
    // it is not itself a countable message. Skip it (and any no-content
    // placeholder) to avoid the badge and tracker showing N+1.
    const isContainer = data.type === "album" || (!data.hasMedia && !data.body);
    const hasDownloadableMedia = data.hasMedia && data.type !== "sticker";

    if (!isContainer) {
      showToast(
        `New message from ${data.chatName || data.sender}${hasDownloadableMedia ? " (has file)" : ""}`,
        "info",
      );
    }

    // Track this message's ID so we can tag it as unread later,
    // regardless of what chat.unreadCount says in whatsapp-web.js.
    // Only track real messages, not container/album events.
    if (data.messageId && !isContainer) {
      if (!pendingUnreadIds.has(data.chatId)) {
        pendingUnreadIds.set(data.chatId, new Set());
      }
      pendingUnreadIds.get(data.chatId).add(data.messageId);
    }

    // Optimistically update the chat item in the DOM immediately, without
    // waiting for a getChats() round-trip (which may return stale data).
    // Pass isContainer so the badge is not bumped for album wrapper events.
    optimisticChatUpdate(data, isContainer);

    // If we're currently viewing this chat and it has media, add it immediately
    if (currentChatId === data.chatId && data.hasMedia) {
      // Create file object from the incoming message data
      const newFile = {
        messageId: data.messageId,
        chatId: data.chatId,
        sender: data.sender,
        fromMe: false,
        timestamp: data.timestamp,
        type: data.type,
        body: data.body || "",
        fileName:
          data.fileName ||
          `${data.type}_${data.timestamp}.${mime.extension(data.mimeType || "application/octet-stream") || "bin"}`,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        isDownloaded: data.autoDownloaded || false,
        localPath: data.localPath || null,
        isUnread: true,
      };

      // Add to currentFiles
      currentFiles.push(newFile);

      // Re-render the entire file list to maintain proper chronological order
      renderFiles();

      // Update file count
      document.getElementById("file-count").textContent =
        `${currentFiles.length} file${currentFiles.length !== 1 ? "s" : ""}`;
    }

    // Debounced follow-up refresh: resets on every new message so only one
    // refresh fires 2s after the last message in a burst (e.g. 8 files).
    if (newMessageRefreshTimer) clearTimeout(newMessageRefreshTimer);
    newMessageRefreshTimer = setTimeout(() => {
      newMessageRefreshTimer = null;
      refreshChats();
    }, 2000);
  });
}

// ── Optimistic Chat Update ───────────────────────────────────────────────
// Immediately updates the chat list DOM when a new message arrives, using
// the data already present in the IPC payload — no getChats() round-trip.
function optimisticChatUpdate(data, isContainer = false) {
  const chatList = document.getElementById("chat-list");
  if (!chatList) return;

  const existing = chatList.querySelector(
    `.chat-item[data-chat-id="${CSS.escape(data.chatId)}"]`,
  );

  if (existing) {
    // Update last message preview (only for real messages, not containers)
    if (!isContainer) {
      const lastMsgEl = existing.querySelector(".chat-last-msg");
      const preview =
        data.type === "sticker"
          ? "Sticker"
          : data.hasMedia
            ? `📎 ${data.fileName || data.type || "File"}`
            : data.body || "";
      if (lastMsgEl) {
        lastMsgEl.textContent = preview;
      } else if (preview) {
        const chatInfo = existing.querySelector(".chat-info");
        if (chatInfo) {
          const div = document.createElement("div");
          div.className = "chat-last-msg";
          div.textContent = preview;
          chatInfo.appendChild(div);
        }
      }
    }

    // Bump the unread badge only for real messages, not container events
    if (!isContainer) {
      let badge = existing.querySelector(".badge-unread");
      if (badge) {
        const current = parseInt(badge.textContent, 10) || 0;
        badge.textContent = current + 1;
      } else {
        badge = document.createElement("span");
        badge.className = "badge badge-unread";
        badge.textContent = "1";
        existing.appendChild(badge);
      }
    }

    // Move this chat to the top of the list
    chatList.prepend(existing);
  } else if (!isContainer) {
    // Chat not currently in the list — do a full refresh to add it
    refreshChats();
  }
}

// ── Screen Switching ─────────────────────────────────────────────────────
function showLoginLoading() {
  const qrContainer = document.getElementById("qr-container");
  const loadingContainer = document.getElementById("loading-bar-container");

  qrContainer.innerHTML = `
    <div class="spinner"></div>
    <p id="qr-status">Authenticated! Loading WhatsApp...</p>
  `;
  if (loadingContainer) loadingContainer.classList.remove("hidden");
}

// ── License Validation ───────────────────────────────────────────────────
let licensePhoneNumber = null;
let licenseUserName = null;

async function validateLicense() {
  // Show license checking screen
  showLicenseScreen("checking");

  try {
    // Get profile info to determine the phone number
    const profile = await window.api.getProfileInfo();
    if (profile.error) {
      console.error("Could not get profile info:", profile.error);
      // If we can't get the number, let them through (graceful degradation)
      switchToMainScreen();
      refreshChats();
      return;
    }

    licensePhoneNumber = profile.number;
    licenseUserName = profile.name;

    // Display the phone number on the license screen
    const phoneDisplay = document.getElementById("license-phone-display");
    if (phoneDisplay) {
      phoneDisplay.textContent = "+" + licensePhoneNumber;
    }
    const nameDisplay = document.getElementById("license-name-display");
    if (nameDisplay) {
      nameDisplay.textContent = licenseUserName || "";
    }

    // Check license with backend
    const result = await window.api.checkLicense(licensePhoneNumber);

    switch (result.status) {
      case "active":
        // User has an active plan — proceed to main app
        switchToMainScreen();
        refreshChats();
        break;

      case "pending":
        // Trial request submitted but not yet approved
        showLicenseScreen("pending");
        break;

      case "expired":
        // Plan has expired
        showLicenseScreen("expired");
        break;

      case "rejected":
        // Request was rejected
        showLicenseScreen("rejected");
        break;

      case "not_found":
        // New user — show request trial button
        showLicenseScreen("no-plan");
        break;

      case "error":
        // Could not connect to license server — allow graceful degradation
        console.warn("License server unavailable:", result.message);
        showLicenseScreen("error");
        break;

      default:
        showLicenseScreen("no-plan");
        break;
    }
  } catch (err) {
    console.error("License validation error:", err);
    showLicenseScreen("error");
  }
}

function showLicenseScreen(state) {
  // Hide login and main screens, show license screen
  document.getElementById("login-screen").classList.remove("active");
  document.getElementById("main-screen").classList.remove("active");
  document.getElementById("license-screen").classList.add("active");

  // Hide all license states
  const states = [
    "license-checking",
    "license-no-plan",
    "license-pending",
    "license-expired",
    "license-rejected",
    "license-error",
  ];
  states.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });

  // Show the requested state
  const target = document.getElementById(`license-${state}`);
  if (target) target.classList.remove("hidden");

  // Load admin contact number for license screens
  if (state !== "checking") {
    loadAdminContact();
  }
}

async function requestTrialVersion() {
  const btn = document.getElementById("btn-request-trial");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Submitting request...";
  }

  try {
    const result = await window.api.requestTrial({
      phoneNumber: licensePhoneNumber,
      name: licenseUserName,
    });

    if (result.success) {
      showToast(result.message || "Trial request submitted!", "info");
      await recheckLicense();
    } else {
      showToast(result.message || "Failed to submit request", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Request Trial Version";
      }
    }
  } catch (err) {
    showToast("Failed to connect to license server", "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Request Trial Version";
    }
  }
}

async function recheckLicense() {
  showLicenseScreen("checking");
  // Small delay to show checking state
  await new Promise((r) => setTimeout(r, 500));
  await validateLicense();
}

async function restartApplication() {
  showToast("Restarting application...", "info");
  await window.api.restartApp();
}

async function licenseLogout() {
  showToast("Logging out and restarting...", "info");
  await window.api.logoutAndRestart();
}

async function loginAgain() {
  showToast("Clearing saved session and restarting...", "info");
  await window.api.logoutAndRestart();
}

function switchToMainScreen() {
  document.getElementById("login-screen").classList.remove("active");
  document.getElementById("license-screen").classList.remove("active");
  document.getElementById("main-screen").classList.add("active");

  const badge = document.getElementById("connection-badge");
  badge.textContent = "Connected";
  badge.className = "badge badge-success";

  // Load profile info
  loadProfileInfo();

  // Start auto-refresh timer
  startAutoRefresh();
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    console.log("[AutoRefresh] Refreshing chats...");
    refreshChats();
  }, AUTO_REFRESH_INTERVAL);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

// ── Network (online / offline) monitoring ────────────────────────────────
function setupNetworkListeners() {
  window.addEventListener("online", updateConnectionBadge);
  window.addEventListener("offline", updateConnectionBadge);
}

function updateConnectionBadge() {
  const badge = document.getElementById("connection-badge");
  if (!badge) return;

  if (navigator.onLine) {
    badge.textContent = "Connected";
    badge.className = "badge badge-success";
    badge.style.background = "";
    badge.style.color = "";
  } else {
    badge.textContent = "Disconnected";
    badge.className = "badge";
    badge.style.background = "#dc2626";
    badge.style.color = "white";
  }
}

// ── Chat List ────────────────────────────────────────────────────────────

function isInternalWhatsAppCode(value) {
  return /^\d{13,}$/.test(String(value || "").trim());
}

function looksLikePhoneLabel(value) {
  return /^\+?[\d\s()\-]{5,}$/.test(String(value || "").trim());
}

function getDisplayChatNumber(chat) {
  const chatId = String(chat?.id || "").toLowerCase();
  if (chatId.endsWith("@g.us")) {
    return "";
  }

  const candidates = [
    String(chat?.number || "").trim(),
    String(chat?.name || "").trim(),
    String(chat?.whatsappName || "").trim(),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isInternalWhatsAppCode(candidate)) continue;
    if (looksLikePhoneLabel(candidate)) return candidate;
  }

  return "";
}

function getDisplayChatName(chat, displayNumber = "") {
  const rawName = String(chat?.name || "").trim();
  const whatsappName = String(chat?.whatsappName || "").trim();

  const cleanRawName = isInternalWhatsAppCode(rawName) ? "" : rawName;
  const cleanWhatsappName = isInternalWhatsAppCode(whatsappName)
    ? ""
    : whatsappName;

  // For unsaved contacts, prefer the WhatsApp registration/profile name.
  if (
    cleanWhatsappName &&
    !looksLikePhoneLabel(cleanWhatsappName) &&
    cleanWhatsappName !== displayNumber
  ) {
    return cleanWhatsappName;
  }

  if (
    cleanRawName &&
    !looksLikePhoneLabel(cleanRawName) &&
    cleanRawName !== displayNumber
  ) {
    return cleanRawName;
  }

  if (cleanWhatsappName && cleanWhatsappName !== displayNumber) {
    return cleanWhatsappName;
  }

  if (cleanRawName && cleanRawName !== displayNumber) {
    return cleanRawName;
  }

  return "";
}

function filterChats(query) {
  const chatItems = document.querySelectorAll(".chat-item");
  const q = query.toLowerCase().trim();
  let visibleCount = 0;

  chatItems.forEach((el) => {
    const name = (el.dataset.chatName || "").toLowerCase();
    const number = (
      el.querySelector(".chat-number")?.textContent || ""
    ).toLowerCase();
    const matches = !q || name.includes(q) || number.includes(q);
    el.style.display = matches ? "" : "none";
    if (matches) visibleCount++;
  });

  // Show/hide no-results message
  const chatList = document.getElementById("chat-list");
  let noResults = chatList.querySelector(".no-search-results");
  if (visibleCount === 0 && q) {
    if (!noResults) {
      noResults = document.createElement("div");
      noResults.className = "no-search-results";
      noResults.innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p>No chats found</p>
      `;
      chatList.appendChild(noResults);
    }
  } else if (noResults) {
    noResults.remove();
  }
}

function filterFiles(query) {
  const fileItems = document.querySelectorAll(".file-item");
  const sectionHeaders = document.querySelectorAll(".file-section-header");
  const q = query.toLowerCase().trim();
  let visibleCount = 0;

  fileItems.forEach((el) => {
    const fileName = (
      el.querySelector(".file-name")?.textContent || ""
    ).toLowerCase();
    const fileMeta = (
      el.querySelector(".file-meta")?.textContent || ""
    ).toLowerCase();
    const matches = !q || fileName.includes(q) || fileMeta.includes(q);
    el.style.display = matches ? "" : "none";
    if (matches) visibleCount++;
  });

  // Hide section headers if no matching items beneath them
  sectionHeaders.forEach((header) => {
    let next = header.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains("file-section-header")) {
      if (
        next.classList.contains("file-item") &&
        next.style.display !== "none"
      ) {
        hasVisible = true;
        break;
      }
      next = next.nextElementSibling;
    }
    header.style.display = hasVisible || !q ? "" : "none";
  });

  // Hide date separators if no matching items beneath them
  const dateSeparators = document.querySelectorAll(".date-separator");
  dateSeparators.forEach((sep) => {
    let next = sep.nextElementSibling;
    let hasVisible = false;
    while (
      next &&
      !next.classList.contains("date-separator") &&
      !next.classList.contains("file-section-header")
    ) {
      if (
        next.classList.contains("file-item") &&
        next.style.display !== "none"
      ) {
        hasVisible = true;
        break;
      }
      next = next.nextElementSibling;
    }
    sep.style.display = hasVisible || !q ? "" : "none";
  });

  // Show/hide no-results message
  const fileList = document.getElementById("file-list");
  let noResults = fileList.querySelector(".no-search-results");
  if (visibleCount === 0 && q) {
    if (!noResults) {
      noResults = document.createElement("div");
      noResults.className = "no-search-results";
      noResults.innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p>No files match your search</p>
      `;
      fileList.appendChild(noResults);
    }
  } else if (noResults) {
    noResults.remove();
  }
}

async function refreshChats() {
  if (isRefreshing) return; // prevent re-entrant calls
  isRefreshing = true;

  const chatList = document.getElementById("chat-list");
  const chatCount = document.getElementById("chat-count");
  const btnRefresh = document.getElementById("btn-refresh");

  // Add spin animation to refresh button
  if (btnRefresh) btnRefresh.classList.add("spinning");

  // Only show spinner on first load (don't flash spinner on auto-refresh)
  const isEmpty =
    chatList.children.length === 0 ||
    (chatList.children.length === 1 && chatList.querySelector(".empty-state"));
  if (isEmpty) {
    chatList.innerHTML = `
      <div class="empty-state">
        <div class="spinner"></div>
        <p style="margin-top:12px">Loading chats...</p>
      </div>
    `;
  }

  let result;
  try {
    result = await window.api.getUnreadChats();
  } catch (err) {
    result = { error: err.message || "Failed to fetch chats" };
  }

  if (btnRefresh) btnRefresh.classList.remove("spinning");
  isRefreshing = false;

  if (result.error) {
    // Only show error UI if there are no chats already displayed
    // (i.e. don't replace a working list with an error on transient failure)
    if (!isEmpty) return;
    chatList.innerHTML = `
      <div class="empty-state">
        <p>Error: ${result.error}</p>
        <button class="btn btn-small" id="btn-retry-chats">Retry</button>
      </div>
    `;
    document
      .getElementById("btn-retry-chats")
      .addEventListener("click", () => refreshChats());
    return;
  }

  // If the backend skipped due to a transient error, keep existing list
  if (result.skipped && !isEmpty) return;

  const chats = result.chats || [];
  chatCount.textContent = chats.length;

  if (chats.length === 0) {
    chatList.innerHTML = `
      <div class="empty-state">
        <p>No chats found</p>
        <p style="font-size:12px;color:#999;margin-top:4px">Make sure WhatsApp is connected and has chats</p>
        <button class="btn btn-small" id="btn-refresh-empty" style="margin-top:8px">Refresh</button>
      </div>
    `;
    document
      .getElementById("btn-refresh-empty")
      .addEventListener("click", () => refreshChats());
    return;
  }

  // Store chat data so click handler can look it up
  window._chatData = {};
  chats.forEach((c) => {
    window._chatData[c.id] = c;
  });

  chatList.innerHTML = chats
    .map((chat) => {
      const displayNumber = getDisplayChatNumber(chat);
      const displayName = getDisplayChatName(chat, displayNumber);
      const initials = getInitials(displayName || displayNumber || chat.name);
      const avatarContent = chat.profilePicUrl
        ? `<img src="${escapeHtml(chat.profilePicUrl)}" alt="" onerror="this.parentElement.textContent='${initials}'">`
        : initials;
      const isActive = currentChatId === chat.id ? "active" : "";
      // Use the higher of server unreadCount and client-tracked pending IDs
      const trackedCount = pendingUnreadIds.has(chat.id)
        ? pendingUnreadIds.get(chat.id).size
        : 0;
      const effectiveUnread = Math.max(chat.unreadCount || 0, trackedCount);
      const unreadBadge =
        effectiveUnread > 0
          ? `<span class="badge badge-unread">${effectiveUnread}</span>`
          : "";
      const lastMsg = chat.lastMessage
        ? `<div class="chat-last-msg">${escapeHtml(chat.lastMessage)}</div>`
        : "";

      return `
      <div class="chat-item ${isActive}" data-chat-id="${escapeHtml(chat.id)}" data-chat-name="${escapeHtml(displayName || displayNumber || chat.name || "")}">
        <div class="chat-avatar">${avatarContent}</div>
        <div class="chat-info">
          ${displayNumber ? `<div class="chat-number chat-number-highlight">${escapeHtml(displayNumber)}</div>` : ""}
          <div class="chat-contact-name${displayName ? "" : " hidden"}">${escapeHtml(displayName)} ${chat.isGroup ? "👥" : ""}</div>
          ${lastMsg}
        </div>
        ${unreadBadge}
      </div>
    `;
    })
    .join("");

  // Attach click handlers via event delegation
  chatList.querySelectorAll(".chat-item").forEach((el) => {
    el.addEventListener("click", () => {
      const chatId = el.dataset.chatId;
      const chatName = el.dataset.chatName;
      if (chatId) selectChat(chatId, chatName);
    });
  });
}

// ── Select Chat & Load Files ─────────────────────────────────────────────
async function selectChat(chatId, chatName, options = {}) {
  const allowAutoReclick = options.allowAutoReclick !== false;

  if (autoReclickTimer) {
    clearTimeout(autoReclickTimer);
    autoReclickTimer = null;
  }

  currentChatId = chatId;
  selectedFiles.clear();
  updateSelectionUI();

  // Clear file search
  const fileSearch = document.getElementById("file-search");
  const fileSearchClear = document.getElementById("file-search-clear");
  if (fileSearch) fileSearch.value = "";
  if (fileSearchClear) fileSearchClear.classList.add("hidden");
  setFileSearchExpanded(false);

  // Highlight active chat
  document.querySelectorAll(".chat-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.chatId === chatId);
  });

  // Show files section
  document.getElementById("no-chat-selected").classList.add("hidden");
  const filesSection = document.getElementById("files-section");
  filesSection.classList.remove("hidden");
  document.getElementById("selected-contact-name").textContent = chatName;

  // Load files
  const fileList = document.getElementById("file-list");
  fileList.innerHTML = `
    <div class="empty-state">
      <div class="spinner"></div>
      <p style="margin-top:12px">Loading files...</p>
    </div>
  `;

  // Pass client-tracked unread message IDs so the backend can tag them
  // correctly even if chat.unreadCount is stale or was reset.
  const trackedIds = pendingUnreadIds.has(chatId)
    ? [...pendingUnreadIds.get(chatId)]
    : [];
  const _selectT0 = Date.now();
  console.log(`[selectChat] invoking getChatFiles for ${chatId}`);
  const result = await window.api.getChatFiles(chatId, trackedIds);
  console.log(
    `[selectChat] getChatFiles resolved in ${Date.now() - _selectT0}ms — unread: ${result.files?.length ?? 0}, hasOlderFiles: ${result.hasOlderFiles}`,
  );

  if (result.error) {
    fileList.innerHTML = `<div class="empty-state"><p>Error: ${result.error}</p></div>`;
    return;
  }

  const unreadFiles = result.files || [];
  const hasOlderFiles = result.hasOlderFiles || false;
  const unreadInMemoryCount = Number(result.unreadInMemoryCount || 0);
  const olderInMemoryCount = Number(result.olderInMemoryCount || 0);

  currentFiles = [...unreadFiles];

  // Handle case where no unread files AND no older files expected
  if (unreadFiles.length === 0 && !hasOlderFiles) {
    fileList.innerHTML = `
      <div class="empty-state">
        <p>No media files found in this chat</p>
      </div>
    `;
    document.getElementById("file-count").textContent = "0 files";
    return;
  }

  // Auto-select all unread files that are already downloaded BEFORE rendering
  // so the checkboxes and "selected" class are correct in the initial HTML.
  const unreadDownloaded = unreadFiles.filter(
    (f) => f.isUnread && f.isDownloaded && isSelectableMediaFile(f),
  );
  if (unreadDownloaded.length > 0) {
    unreadDownloaded.forEach((f) => selectedFiles.add(f.messageId));
  }

  // Build initial HTML with WhatsApp-style chronological ordering
  let html = "";

  // Sort messages chronologically (oldest first, newest at bottom)
  const sortedFiles = [...unreadFiles].sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
  );

  // Check if there are unread messages
  const firstUnreadIndex = sortedFiles.findIndex((f) => f.isUnread);
  const hasUnreadMessages = firstUnreadIndex !== -1;

  let lastDateKey = null;
  for (let i = 0; i < sortedFiles.length; i++) {
    const file = sortedFiles[i];
    const dateKey = getDateKey(file.timestamp);

    // Add date separator when date changes
    if (dateKey !== lastDateKey) {
      const label = formatDateLabel(file.timestamp);
      html += `<div class="date-separator" data-date-key="${escapeHtml(dateKey)}"><span class="date-separator-label">${escapeHtml(label)}</span></div>`;
      lastDateKey = dateKey;
    }

    // Add unread divider before first unread message
    if (hasUnreadMessages && i === firstUnreadIndex) {
      html += `<div class="unread-divider" id="unread-divider"><span>Unread messages</span></div>`;
    }

    html += renderFileItem(file);
  }

  if (hasOlderFiles) {
    // Prepend loading indicator at the top (older messages load at top)
    html =
      `<div class="older-files-loading" id="older-files-loading">
      <div class="spinner" style="width:20px;height:20px;border-width:2px"></div>
      <span style="margin-left:8px;color:var(--text-secondary)">Loading older messages...</span>
    </div>` + html;
  }

  fileList.innerHTML = html;
  attachFileEventListeners(fileList);

  document.getElementById("file-count").textContent =
    `${currentFiles.length} file${currentFiles.length !== 1 ? "s" : ""}`;

  if (unreadDownloaded.length > 0) {
    showToast(
      `Auto-selected ${unreadDownloaded.length} new file(s). Unselect any you don't need.`,
      "info",
    );
  }

  updateSelectionUI();

  const shouldAutoReclick =
    allowAutoReclick && unreadInMemoryCount === 0 && olderInMemoryCount === 1;
  if (shouldAutoReclick) {
    console.log(
      `[selectChat] auto re-click scheduled for ${chatId} (0 unread, 1 older in memory)`,
    );
    autoReclickTimer = setTimeout(() => {
      autoReclickTimer = null;
      if (currentChatId !== chatId) return;
      selectChat(chatId, chatName, { allowAutoReclick: false });
    }, 500);
  }

  // Scroll to unread divider if present, otherwise to bottom (newest messages)
  setTimeout(() => {
    const unreadDivider = document.getElementById("unread-divider");
    if (unreadDivider) {
      unreadDivider.scrollIntoView({ behavior: "auto", block: "start" });
    } else {
      fileList.scrollTop = fileList.scrollHeight;
    }
  }, 100);

  // Mark chat as read AFTER loading files (so unread tagging is accurate)
  window.api.markChatRead(chatId);

  // Clear client-tracked unread IDs now that files have been loaded & displayed
  pendingUnreadIds.delete(chatId);

  // Remove unread badge from sidebar
  const chatItem = document.querySelector(
    `.chat-item[data-chat-id="${CSS.escape(chatId)}"]`,
  );
  if (chatItem) {
    const badge = chatItem.querySelector(".badge-unread");
    if (badge) badge.remove();
  }
}

// ── Render File List ─────────────────────────────────────────────────────
function renderFileItem(file) {
  const iconInfo = getFileIcon(file);
  const nonImageTypeLabel = getNonImageFileTypeLabel(file);
  const isChecked = selectedFiles.has(file.messageId) ? "checked" : "";
  const isSelected = selectedFiles.has(file.messageId) ? "selected" : "";
  const time = formatTime(file.timestamp);
  const size = file.fileSize ? formatSize(file.fileSize) : "";
  const statusBadge = getStatusBadge(file);
  const safeMsgId = file.messageId.replace(/[^a-zA-Z0-9]/g, "_");
  const unreadClass = file.isUnread ? "file-unread" : "";
  const isFromMe = !file.sender || file.fromMe;
  const senderName = isFromMe ? "You" : file.sender;
  const fromMeClass = isFromMe ? "from-me" : "";

  // For text messages (chat type), render as WhatsApp-style chat bubble
  const isChatMessage = file.type === "chat";

  if (isChatMessage) {
    const messageText = file.body || "(empty message)";
    return `
      <div class="chat-bubble ${fromMeClass} ${unreadClass}" data-message-id="${escapeHtml(file.messageId)}" id="file-${safeMsgId}">
        <div class="chat-bubble-sender">${escapeHtml(senderName)}</div>
        <div class="chat-bubble-text">${escapeHtml(messageText)}</div>
        <div class="chat-bubble-time">${time}</div>
      </div>
    `;
  }

  // For voice messages (ptt/audio), render as WhatsApp-style voice bubble with inline player
  const isVoiceMessage = file.type === "ptt" || file.type === "audio";

  if (isVoiceMessage) {
    const audioSrc = file.isDownloaded
      ? `file:///${file.localPath.replace(/\\/g, "/")}`
      : "";
    return `
      <div class="chat-bubble voice-bubble ${fromMeClass} ${unreadClass}" data-message-id="${escapeHtml(file.messageId)}" id="file-${safeMsgId}">
        <div class="chat-bubble-sender">${escapeHtml(senderName)}</div>
        <div class="voice-message-content">
          <div class="voice-icon">🎤</div>
          ${
            file.isDownloaded
              ? `<audio class="voice-audio-player" controls preload="metadata" src="${escapeHtml(audioSrc)}"></audio>`
              : `<div class="voice-waveform">
                <span></span><span></span><span></span><span></span><span></span>
                <span></span><span></span><span></span><span></span><span></span>
              </div>
              <button class="btn-voice-download" data-action="download-file" data-msg-id="${escapeHtml(file.messageId)}" data-filename="${escapeHtml(file.fileName)}" title="Download">⬇️</button>`
          }
        </div>
        <div class="chat-bubble-time">${time}${size ? ` • ${size}` : ""}</div>
      </div>
    `;
  }

  // For stickers, show the sticker directly instead of a file card.
  const isStickerMessage = file.type === "sticker";

  if (isStickerMessage) {
    const stickerSrc =
      file.isDownloaded && file.localPath
        ? `file:///${file.localPath.replace(/\\/g, "/")}`
        : "";

    return `
      <div class="chat-bubble sticker-bubble ${fromMeClass} ${unreadClass}" data-message-id="${escapeHtml(file.messageId)}" id="file-${safeMsgId}">
        <div class="chat-bubble-sender">${escapeHtml(senderName)}</div>
        <div class="sticker-message-content">
          ${
            stickerSrc
              ? `<img class="sticker-image" src="${escapeHtml(stickerSrc)}" alt="Sticker" loading="lazy" />`
              : `<div class="sticker-fallback">Sticker</div>`
          }
        </div>
        <div class="chat-bubble-time">${time}</div>
      </div>
    `;
  }

  return `
    <div class="file-item ${isSelected} ${unreadClass} ${fromMeClass}" data-message-id="${escapeHtml(file.messageId)}" id="file-${safeMsgId}">
      <input type="checkbox" class="file-checkbox" ${isChecked} 
        data-action="toggle-select" data-msg-id="${escapeHtml(file.messageId)}" />
      <div class="file-icon ${iconInfo.class}${nonImageTypeLabel ? " file-icon-has-label" : ""}">
        ${iconInfo.icon}
        ${nonImageTypeLabel ? `<span class="file-icon-type-label">${escapeHtml(nonImageTypeLabel)}</span>` : ""}
      </div>
      <div class="file-details">
        <div class="file-name" title="${escapeHtml(file.fileName || "Unknown file")}">${escapeHtml(file.fileName || "Unknown file")}</div>
        <div class="file-meta">
          ${size ? `<span>${size}</span>` : ""}
          <span>${time}</span>
          <span>From: ${escapeHtml(senderName)}</span>
        </div>
      </div>
      ${statusBadge}
      <div class="file-actions">
        ${
          file.isDownloaded
            ? `<button class="btn-file-action" data-action="open-file" data-path="${escapeHtml(file.localPath)}">Open</button>`
            : `<button class="btn-file-action download" data-action="download-file" data-msg-id="${escapeHtml(file.messageId)}" data-filename="${escapeHtml(file.fileName)}">⬇️ Download</button>`
        }
      </div>
    </div>
  `;
}

// Attach action + click-to-select listeners to file items within a container.
// Safe to call multiple times — uses event delegation markers to avoid duplication.
function attachFileEventListeners(container) {
  if (!container.dataset.dragSelectionAttached) {
    container.dataset.dragSelectionAttached = "1";
    container.addEventListener("mousedown", handleFileListMouseDown);
  }

  container.querySelectorAll("[data-action]").forEach((el) => {
    if (el.dataset.listenerAttached) return;
    el.dataset.listenerAttached = "1";
    if (el.tagName === "INPUT") {
      el.addEventListener("change", handleFileAction);
    } else {
      el.addEventListener("click", handleFileAction);
    }
  });

  container.querySelectorAll(".file-item").forEach((el) => {
    if (el.dataset.clickAttached) return;
    el.dataset.clickAttached = "1";
    el.addEventListener("click", async (e) => {
      if (suppressNextFileItemClick) {
        suppressNextFileItemClick = false;
        return;
      }

      if (
        e.target.closest(".file-actions") ||
        e.target.closest(".file-checkbox")
      )
        return;
      const msgId = el.dataset.messageId;
      const file = currentFiles.find((f) => f.messageId === msgId);
      if (!file) return;

      // If not downloaded, download first then select
      if (!file.isDownloaded) {
        await downloadSingleFile(msgId, file.fileName);
        // After download, select the file
        toggleFileSelect(msgId);
        // Update checkbox state after re-render
        const fileItem = document.getElementById(
          `file-${msgId.replace(/[^a-zA-Z0-9]/g, "_")}`,
        );
        if (fileItem) {
          const checkbox = fileItem.querySelector(".file-checkbox");
          if (checkbox) checkbox.checked = selectedFiles.has(msgId);
        }
      } else {
        // If already downloaded, just toggle select
        toggleFileSelect(msgId);
        const checkbox = el.querySelector(".file-checkbox");
        if (checkbox) checkbox.checked = selectedFiles.has(msgId);
      }
    });
  });
}

function getVisibleFileItemsInOrder() {
  const fileList = document.getElementById("file-list");
  if (!fileList) return [];

  return Array.from(fileList.querySelectorAll(".file-item")).filter((el) => {
    if (!el || !el.dataset.messageId) return false;
    if (el.style.display === "none") return false;
    return true;
  });
}

function getFileTypeByMessageId(messageId) {
  const file = currentFiles.find((f) => f.messageId === messageId);
  if (!file) return null;
  return getFileType(file.fileName);
}

function applySelectionFromMessageIds(messageIds) {
  selectedFiles.clear();
  messageIds.forEach((msgId) => selectedFiles.add(msgId));

  const fileList = document.getElementById("file-list");
  if (!fileList) {
    updateSelectionUI();
    return;
  }

  fileList.querySelectorAll(".file-item").forEach((el) => {
    const msgId = el.dataset.messageId;
    const isSelected = selectedFiles.has(msgId);
    el.classList.toggle("selected", isSelected);
    const checkbox = el.querySelector(".file-checkbox");
    if (checkbox) checkbox.checked = isSelected;
  });

  updateSelectionUI();
}

function getDragRange(anchorMessageId, hoverMessageId) {
  const orderedItems = getVisibleFileItemsInOrder();
  const startIndex = orderedItems.findIndex(
    (el) => el.dataset.messageId === anchorMessageId,
  );
  const endIndex = orderedItems.findIndex(
    (el) => el.dataset.messageId === hoverMessageId,
  );

  if (startIndex === -1 || endIndex === -1) return [];

  const min = Math.min(startIndex, endIndex);
  const max = Math.max(startIndex, endIndex);
  const selectedIds = [];

  for (let i = min; i <= max; i++) {
    const msgId = orderedItems[i].dataset.messageId;
    if (!msgId) continue;
    selectedIds.push(msgId);
  }

  return selectedIds;
}

function updateDragSelectionToElement(fileItemEl) {
  if (!dragSelectionState.active || !fileItemEl) return;

  const hoverMessageId = fileItemEl.dataset.messageId;
  if (!hoverMessageId) return;

  if (dragSelectionState.lastHoverMessageId === hoverMessageId) return;
  dragSelectionState.lastHoverMessageId = hoverMessageId;

  const selectedIds = getDragRange(
    dragSelectionState.anchorMessageId,
    hoverMessageId,
  );
  applySelectionFromMessageIds(selectedIds);
}

function handleFileListMouseDown(event) {
  if (event.button !== 0) return;
  if (
    event.target.closest(".file-actions") ||
    event.target.closest(".file-checkbox")
  ) {
    return;
  }

  const fileItemEl = event.target.closest(".file-item");
  if (!fileItemEl) return;

  const messageId = fileItemEl.dataset.messageId;
  if (!messageId) return;

  dragSelectionState.active = true;
  dragSelectionState.hasMoved = false;
  dragSelectionState.anchorMessageId = messageId;
  dragSelectionState.lastHoverMessageId = messageId;
  dragSelectionState.startX = event.clientX;
  dragSelectionState.startY = event.clientY;
}

function handleDragSelectionMouseMove(event) {
  if (!dragSelectionState.active) return;

  const movedX = Math.abs(event.clientX - dragSelectionState.startX);
  const movedY = Math.abs(event.clientY - dragSelectionState.startY);
  const movedEnough = movedX > 3 || movedY > 3;

  if (!dragSelectionState.hasMoved) {
    if (!movedEnough) return;
    dragSelectionState.hasMoved = true;
    suppressNextFileItemClick = true;
    // Start with anchor selected when drag begins.
    applySelectionFromMessageIds([dragSelectionState.anchorMessageId]);
  }

  const target = event.target;
  const fileItemEl =
    target && target.closest ? target.closest(".file-item") : null;
  if (!fileItemEl) return;

  const fileList = document.getElementById("file-list");
  if (!fileList || !fileList.contains(fileItemEl)) return;

  updateDragSelectionToElement(fileItemEl);
}

function finishDragSelection() {
  const shouldAutoClearSuppression =
    dragSelectionState.active && dragSelectionState.hasMoved;

  if (!dragSelectionState.active) return;

  dragSelectionState.active = false;
  dragSelectionState.hasMoved = false;
  dragSelectionState.anchorMessageId = null;
  dragSelectionState.lastHoverMessageId = null;

  if (shouldAutoClearSuppression) {
    setTimeout(() => {
      suppressNextFileItemClick = false;
    }, 0);
  }
}

function renderFiles() {
  const fileList = document.getElementById("file-list");

  // Sort ALL messages chronologically (oldest first, newest at bottom)
  const sortedFiles = [...currentFiles].sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
  );

  // Check if there are unread messages
  const firstUnreadIndex = sortedFiles.findIndex((f) => f.isUnread);
  const hasUnread = firstUnreadIndex !== -1;

  let html = "";
  let lastDateKey = null;

  for (let i = 0; i < sortedFiles.length; i++) {
    const file = sortedFiles[i];
    const dateKey = getDateKey(file.timestamp);

    // Add date separator when date changes
    if (dateKey !== lastDateKey) {
      const label = formatDateLabel(file.timestamp);
      html += `<div class="date-separator" data-date-key="${escapeHtml(dateKey)}"><span class="date-separator-label">${escapeHtml(label)}</span></div>`;
      lastDateKey = dateKey;
    }

    // Add unread divider before first unread message
    if (hasUnread && i === firstUnreadIndex) {
      html += `<div class="unread-divider" id="unread-divider"><span>Unread messages</span></div>`;
    }

    html += renderFileItem(file);
  }

  fileList.innerHTML = html;
  attachFileEventListeners(fileList);

  // Scroll to unread divider if present, otherwise to bottom
  setTimeout(() => {
    const unreadDivider = document.getElementById("unread-divider");
    if (unreadDivider) {
      unreadDivider.scrollIntoView({ behavior: "auto", block: "start" });
    } else {
      fileList.scrollTop = fileList.scrollHeight;
    }
  }, 100);
}

function handleFileAction(e) {
  const el = e.currentTarget;
  const action = el.dataset.action;

  switch (action) {
    case "toggle-select":
      toggleFileSelect(el.dataset.msgId);
      break;
    case "open-file":
      openFile(el.dataset.path);
      break;
    case "download-file":
      downloadSingleFile(el.dataset.msgId, el.dataset.filename);
      break;
  }
}

// ── File Selection ───────────────────────────────────────────────────────
function getFileType(fileName) {
  if (!fileName) return "unknown";
  const ext = fileName.split(".").pop().toLowerCase();
  const imageExts = ["jpg", "jpeg", "png", "bmp", "gif", "tiff", "tif", "webp"];
  if (ext === "pdf") return "pdf";
  if (imageExts.includes(ext)) return "image";
  return ext;
}

function getNonImageFileTypeLabel(file) {
  if (!file) return "FILE";

  const fileName = String(file.fileName || "");
  const mimeType = String(file.mimeType || "").toLowerCase();
  const type = String(file.type || "").toLowerCase();
  const extension = fileName.includes(".")
    ? fileName.split(".").pop().trim().toLowerCase()
    : "";

  const isImage =
    mimeType.includes("image") ||
    type === "image" ||
    getFileType(fileName) === "image";
  if (isImage) return "";

  if (extension) return extension.toUpperCase();
  if (type && type !== "unknown") return type.toUpperCase();

  if (mimeType) {
    const mimeLeaf = mimeType.split("/").pop().split(";")[0].trim();
    if (mimeLeaf) return mimeLeaf.toUpperCase();
  }

  return "FILE";
}

function isSelectableMediaFile(file) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  return !["chat", "ptt", "audio", "sticker"].includes(type);
}

function toggleFileSelect(messageId) {
  const fileToSelect = currentFiles.find((f) => f.messageId === messageId);
  if (!fileToSelect) return;

  if (selectedFiles.has(messageId)) {
    selectedFiles.delete(messageId);
  } else {
    selectedFiles.add(messageId);
  }

  // Update visual
  const el = document.getElementById(
    `file-${messageId.replace(/[^a-zA-Z0-9]/g, "_")}`,
  );
  if (el) el.classList.toggle("selected", selectedFiles.has(messageId));

  updateSelectionUI();
}

function updateSelectionUI() {
  // Update delete button
  const btnDelete = document.getElementById("btn-delete");
  const btnDeleteBadge = document.getElementById("btn-delete-badge");
  if (btnDelete) {
    btnDelete.classList.toggle("hidden", selectedFiles.size === 0);
    if (btnDeleteBadge) {
      btnDeleteBadge.textContent = selectedFiles.size.toString();
    }
  }

  // Show unselect button only when files are selected
  const btnUnselectAll = document.getElementById("btn-unselect-all");
  if (btnUnselectAll) {
    btnUnselectAll.classList.toggle("hidden", selectedFiles.size === 0);
  }

  // Show open-with container only when files are selected
  const openWithContainer = document.getElementById("open-with-container");
  if (openWithContainer) {
    openWithContainer.classList.toggle("hidden", selectedFiles.size === 0);
  }

  const { selectedTypes } = getSelectedOpenableFiles();
  const hasMixedTypes = selectedTypes.size > 1;
  const disableOpenWithActions = selectedFiles.size === 0 || hasMixedTypes;

  const btnOpenSelected = document.getElementById("btn-open-selected");
  if (btnOpenSelected) {
    btnOpenSelected.disabled = disableOpenWithActions;
    if (hasMixedTypes) {
      btnOpenSelected.title =
        "Open With is available only for single file type selections";
    }
  }

  const btnOpenWithMenu = document.getElementById("btn-open-with-menu");
  if (btnOpenWithMenu) {
    btnOpenWithMenu.disabled = disableOpenWithActions;
    if (hasMixedTypes) {
      btnOpenWithMenu.title =
        "Choose application is available only for single file type selections";
    } else {
      btnOpenWithMenu.title = "Choose application";
    }
  }

  if (disableOpenWithActions) {
    hideOpenWithDropdown();
  }

  const btnOpenSelectedExplorer = document.getElementById(
    "btn-open-selected-explorer",
  );
  if (btnOpenSelectedExplorer) {
    btnOpenSelectedExplorer.classList.toggle(
      "hidden",
      selectedFiles.size === 0,
    );
  }

  updateOpenSelectedButtonLabel();
  queueExplorerSelectionSync();
}

function unselectAllFiles() {
  if (selectedFiles.size === 0) return;
  selectedFiles.clear();
  hideOpenWithDropdown();
  renderFiles();
  updateSelectionUI();
}

function getSelectedOpenableFiles() {
  const filePaths = [];
  const selectedTypes = new Set();

  selectedFiles.forEach((msgId) => {
    const file = currentFiles.find((f) => f.messageId === msgId);
    if (file && file.localPath) {
      filePaths.push(file.localPath);
      selectedTypes.add(getFileType(file.fileName));
    }
  });

  return { filePaths, selectedTypes };
}

function queueExplorerSelectionSync() {
  if (explorerSelectionSyncTimer) {
    clearTimeout(explorerSelectionSyncTimer);
  }

  explorerSelectionSyncTimer = setTimeout(() => {
    explorerSelectionSyncTimer = null;
    void syncExplorerSelectionFolder();
  }, EXPLORER_SELECTION_SYNC_DEBOUNCE_MS);
}

async function syncExplorerSelectionFolder(showErrorToast = false) {
  const { filePaths } = getSelectedOpenableFiles();
  const normalizedPaths = [...new Set(filePaths.filter(Boolean))].sort();
  const syncKey = normalizedPaths.join("|");

  if (syncKey === lastExplorerSelectionSyncKey) {
    return;
  }

  lastExplorerSelectionSyncKey = syncKey;
  const result = await window.api.syncExplorerSelectionFolder(normalizedPaths);

  if (result && result.error) {
    // Allow retry on the next mutation if a sync attempt fails.
    lastExplorerSelectionSyncKey = null;
    if (showErrorToast) {
      showToast(`Explorer sync failed: ${result.error}`, "error");
    }
  }
}
function updateOpenSelectedButtonLabel() {
  const btnOpenSelected = document.getElementById("btn-open-selected");
  if (!btnOpenSelected) return;
  const { selectedTypes } = getSelectedOpenableFiles();
  if (selectedTypes.size > 1) {
    btnOpenSelected.textContent = "Open with Default application";
    return;
  }
  const selectedType = getSingleTypeFromSet(selectedTypes);
  if (selectedType) {
    selectedOpenWithApp = getOpenWithPreferenceForType(selectedType);
  }
  const fullAppName = selectedOpenWithApp.name || "Default application";
  btnOpenSelected.textContent = `Open with ${fullAppName}`;
  btnOpenSelected.title = `Open with ${fullAppName}`;
}

function hideOpenWithDropdown() {
  const dropdown = document.getElementById("open-with-dropdown");
  if (dropdown) dropdown.classList.add("hidden");
}

function getDefaultOpenWithApp(apps, isImageType) {
  if (isImageType) {
    const printPicturesApp = apps.find(
      (app) => app.id === "__print_pictures__",
    );
    if (printPicturesApp) {
      return { id: printPicturesApp.id, name: printPicturesApp.name };
    }
  }

  const defaultApp = apps.find((app) => app.id === "__default__");
  if (defaultApp) {
    return { id: defaultApp.id, name: defaultApp.name };
  }

  return { id: "__default__", name: "Default application" };
}

function getSelectedTypesForPaths(filePaths) {
  const selectedTypes = new Set();

  filePaths.forEach((filePath) => {
    const file = currentFiles.find((f) => f.localPath === filePath);
    const nameFromPath = (filePath || "").split(/[\\/]/).pop() || "";
    selectedTypes.add(getFileType(file?.fileName || nameFromPath));
  });

  return selectedTypes;
}

function renderOpenWithDropdown(apps, selectedType) {
  const dropdown = document.getElementById("open-with-dropdown");
  if (!dropdown) return;

  const visibleApps = (Array.isArray(apps) ? apps : []).filter(
    (app) => app && app.id !== WINDOWS_FILE_EXPLORER_APP_ID,
  );

  dropdown.innerHTML = "";

  visibleApps.forEach((app) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "open-with-option";
    if (app.id === selectedOpenWithApp.id) {
      option.classList.add("active");
    }
    option.textContent = app.name;
    option.addEventListener("click", async () => {
      const appSelection = { id: app.id, name: app.name };
      selectedOpenWithApp = appSelection;
      if (selectedType) {
        setOpenWithPreferenceForType(selectedType, appSelection);
      }
      updateOpenSelectedButtonLabel();
      hideOpenWithDropdown();
      await openSelectedWithApp(appSelection, selectedType);
    });
    dropdown.appendChild(option);
  });

  dropdown.classList.remove("hidden");
}

async function openSelectedInExplorer() {
  if (selectedFiles.size === 0) {
    showToast("No downloaded files selected", "warning");
    return;
  }

  const { filePaths } = getSelectedOpenableFiles();
  const normalizedFilePaths = [...new Set(filePaths.filter(Boolean))];
  if (normalizedFilePaths.length === 0) {
    showToast("No downloaded files selected to open", "warning");
    return;
  }

  hideOpenWithDropdown();

  const openResult = await window.api.openFilesWithApp({
    appId: WINDOWS_FILE_EXPLORER_APP_ID,
    filePaths: normalizedFilePaths,
  });

  if (openResult && openResult.error) {
    showToast(`Open failed: ${openResult.error}`, "error");
    return;
  }

  showToast("Opened selected files in temp folder", "success");
}

async function toggleOpenWithDropdown(event) {
  event.stopPropagation();

  const dropdown = document.getElementById("open-with-dropdown");
  if (!dropdown) return;

  if (!dropdown.classList.contains("hidden")) {
    hideOpenWithDropdown();
    return;
  }

  if (selectedFiles.size === 0) {
    showToast("Select files first to choose an app", "warning");
    return;
  }

  const { filePaths, selectedTypes } = getSelectedOpenableFiles();
  if (filePaths.length === 0) {
    showToast("No downloaded files selected to open", "warning");
    return;
  }

  if (selectedTypes.size > 1) {
    return;
  }

  const appListResult = await window.api.getOpenWithApps(filePaths[0]);
  if (appListResult.error) {
    showToast(`Could not load applications: ${appListResult.error}`, "error");
    return;
  }

  const apps = Array.isArray(appListResult.apps) ? appListResult.apps : [];
  if (apps.length === 0) {
    showToast("No compatible applications found", "warning");
    return;
  }

  const selectedType = getSingleTypeFromSet(selectedTypes);
  const isImageType = selectedTypes.size === 1 && selectedTypes.has("image");
  let appToHighlight = selectedType
    ? getOpenWithPreferenceForType(selectedType)
    : selectedOpenWithApp;

  if (isImageType && appToHighlight.id === "__default__") {
    appToHighlight = getDefaultOpenWithApp(apps, true);
  }

  if (!apps.some((app) => app.id === appToHighlight.id)) {
    appToHighlight = getDefaultOpenWithApp(apps, isImageType);
  }

  selectedOpenWithApp = appToHighlight;
  if (selectedType) {
    setOpenWithPreferenceForType(selectedType, appToHighlight);
  }
  updateOpenSelectedButtonLabel();

  renderOpenWithDropdown(apps, selectedType);
}

async function openFilesWithAppSelection(
  filePaths,
  preferredApp,
  options = {},
) {
  const {
    showSuccessToast = true,
    selectedType: providedSelectedType = null,
    persistSelection = false,
  } = options;
  const normalizedFilePaths = Array.isArray(filePaths)
    ? filePaths.filter(Boolean)
    : [];

  if (normalizedFilePaths.length === 0) {
    showToast("No downloaded files selected to open", "warning");
    return;
  }

  const selectedTypes = getSelectedTypesForPaths(normalizedFilePaths);
  if (selectedTypes.size > 1) {
    showToast("Only files of one type can be opened", "warning");
    return;
  }

  const appListResult = await window.api.getOpenWithApps(
    normalizedFilePaths[0],
  );
  if (appListResult.error) {
    showToast(`Could not load applications: ${appListResult.error}`, "error");
    return;
  }

  const apps = Array.isArray(appListResult.apps) ? appListResult.apps : [];
  if (apps.length === 0) {
    showToast("No compatible applications found", "warning");
    return;
  }

  const resolvedSelectedType =
    providedSelectedType || getSingleTypeFromSet(selectedTypes);
  const isImageType = resolvedSelectedType === "image";

  let appToUse = preferredApp || selectedOpenWithApp;
  if (isImageType && appToUse.id === "__default__") {
    appToUse = getDefaultOpenWithApp(apps, true);
  }

  if (!apps.some((app) => app.id === appToUse.id)) {
    appToUse = getDefaultOpenWithApp(apps, isImageType);
  }

  if (resolvedSelectedType) {
    setOpenWithPreferenceForType(resolvedSelectedType, appToUse);
  }

  if (persistSelection) {
    selectedOpenWithApp = appToUse;
    updateOpenSelectedButtonLabel();
  }

  hideOpenWithDropdown();

  const openResult = await window.api.openFilesWithApp({
    requestId: appListResult.requestId,
    appId: appToUse.id,
    filePaths: normalizedFilePaths,
  });

  if (openResult.error) {
    showToast(`Open failed: ${openResult.error}`, "error");
    return;
  }

  if (Array.isArray(openResult.results)) {
    const failed = openResult.results.filter((r) => r.error).length;
    const opened = openResult.results.length - failed;
    if (failed > 0) {
      showToast(`Opened ${opened} file(s), ${failed} failed`, "warning");
    } else if (showSuccessToast) {
      showToast(`Opened ${opened} file(s)`, "success");
    }
  } else if (showSuccessToast) {
    showToast(`Opened ${normalizedFilePaths.length} file(s)`, "success");
  }
}

async function openSelectedWithApp(preferredApp, selectedType = null) {
  if (selectedFiles.size === 0) {
    showToast("No downloaded files selected", "warning");
    return;
  }

  const { filePaths } = getSelectedOpenableFiles();
  await openFilesWithAppSelection(filePaths, preferredApp, {
    showSuccessToast: true,
    selectedType,
    persistSelection: true,
  });
}

// ── Open Selected ────────────────────────────────────────────────────────
async function openSelected() {
  const { selectedTypes } = getSelectedOpenableFiles();
  const selectedType = getSingleTypeFromSet(selectedTypes);
  const preferredApp = selectedType
    ? getOpenWithPreferenceForType(selectedType)
    : selectedOpenWithApp;
  await openSelectedWithApp(preferredApp, selectedType);
}

// ── Download ─────────────────────────────────────────────────────────────
async function downloadSingleFile(messageId, fileName) {
  showToast("Downloading file...", "info");

  const result = await window.api.downloadFile({
    messageId,
    chatId: currentChatId,
    fileName,
  });

  if (result.error) {
    showToast(`Download failed: ${result.error}`, "error");
    return;
  }

  showToast(`Downloaded: ${result.fileName}`, "success");

  // Update the file in our local state
  const file = currentFiles.find((f) => f.messageId === messageId);
  if (file) {
    file.isDownloaded = true;
    file.localPath = result.localPath;
  }

  renderFiles();
}

// ── Delete ───────────────────────────────────────────────────────────────
async function deleteSelected() {
  if (selectedFiles.size === 0) return;

  const filePaths = [];
  const msgIds = [];
  selectedFiles.forEach((msgId) => {
    const file = currentFiles.find((f) => f.messageId === msgId);
    if (file && file.localPath) {
      filePaths.push(file.localPath);
      msgIds.push(msgId);
    }
  });

  if (filePaths.length === 0) {
    showToast("No downloaded files selected for deletion", "warning");
    return;
  }

  showToast(
    `Deleting ${filePaths.length} file(s) from disk & WhatsApp...`,
    "info",
  );

  const result = await window.api.deleteFiles({
    filePaths,
    messageIds: msgIds,
    chatId: currentChatId,
  });

  if (result.results) {
    const successCount = result.results.filter((r) => r.success).length;
    const failCount = result.results.filter((r) => r.error).length;

    // Update local state — remove successfully deleted files entirely
    result.results.forEach((r, i) => {
      if (r.success) {
        const idx = currentFiles.findIndex((f) => f.localPath === r.filePath);
        if (idx !== -1) currentFiles.splice(idx, 1);
        selectedFiles.delete(msgIds[i]);
      }
    });

    // Report WhatsApp deletion results
    const waResults = result.waResults || [];
    const waSuccess = waResults.filter((r) => r.success).length;
    const waFail = waResults.filter((r) => r.error).length;

    document.getElementById("file-count").textContent =
      `${currentFiles.length} file${currentFiles.length !== 1 ? "s" : ""}`;

    renderFiles();
    updateSelectionUI();

    let msg = `Deleted ${successCount} file(s) from disk`;
    if (waSuccess > 0) msg += `, ${waSuccess} from WhatsApp`;
    if (failCount > 0 || waFail > 0) msg += ` (${failCount + waFail} failed)`;
    showToast(msg, failCount > 0 || waFail > 0 ? "warning" : "success");
  }
}

// ── Close Chat (ESC) ─────────────────────────────────────────────────────
function closeChat() {
  currentChatId = null;
  currentFiles = [];
  selectedFiles.clear();
  queueExplorerSelectionSync();
  hideOpenWithDropdown();

  // Hide delete button
  const btnDelete = document.getElementById("btn-delete");
  if (btnDelete) btnDelete.classList.add("hidden");

  // Deselect active chat in sidebar
  document.querySelectorAll(".chat-item").forEach((el) => {
    el.classList.remove("active");
  });

  // Show "no chat selected" state
  document.getElementById("files-section").classList.add("hidden");
  document.getElementById("no-chat-selected").classList.remove("hidden");
}

// ── Printers ─────────────────────────────────────────────────────────────
async function loadPrinters() {
  const select = document.getElementById("printer-select");
  const result = await window.api.getPrinters();

  if (result.printers && result.printers.length > 0) {
    result.printers.forEach((printer) => {
      const option = document.createElement("option");
      option.value = printer.name || printer.deviceId || printer;
      option.textContent = printer.name || printer.deviceId || printer;
      select.appendChild(option);
    });
  }
}

// ── Other Actions ────────────────────────────────────────────────────────
async function openFile(filePath) {
  const selectedTypes = getSelectedTypesForPaths([filePath]);
  const selectedType = getSingleTypeFromSet(selectedTypes);
  const preferredApp = selectedType
    ? getOpenWithPreferenceForType(selectedType)
    : selectedOpenWithApp;

  await openFilesWithAppSelection([filePath], preferredApp, {
    showSuccessToast: false,
    selectedType,
    persistSelection: false,
  });
}

async function openWithDialog(filePath) {
  try {
    const result = await window.api.openWithDialog(filePath);
    if (result.error) {
      showToast(result.error, "error");
    }
  } catch (err) {
    showToast("Failed to open selection dialog", "error");
  }
}

function openDownloadsFolder() {
  window.api.openDownloadsFolder();
}

async function reconnect() {
  showToast("Reconnecting...", "info");
  await window.api.reconnectWhatsApp();
}

// ── Profile & Logout ─────────────────────────────────────────────────────
async function loadProfileInfo() {
  const result = await window.api.getProfileInfo();
  if (result.error) return;

  const name = result.name || "Unknown";
  const number = result.number || "";
  const initials = getInitials(name);

  // Update topbar avatar
  const profileAvatar = document.getElementById("profile-avatar");
  if (result.profilePicUrl) {
    profileAvatar.innerHTML = `<img src="${escapeHtml(result.profilePicUrl)}" alt="" onerror="this.parentElement.textContent='${initials}'">`;
  } else {
    profileAvatar.textContent = initials;
  }

  // Update dropdown
  const dropdownAvatar = document.getElementById("dropdown-avatar");
  if (result.profilePicUrl) {
    dropdownAvatar.innerHTML = `<img src="${escapeHtml(result.profilePicUrl)}" alt="" onerror="this.parentElement.textContent='${initials}'">`;
  } else {
    dropdownAvatar.textContent = initials;
  }

  document.getElementById("profile-name").textContent = name;
  document.getElementById("profile-number").textContent = number
    ? `+${number}`
    : "";

  // Fetch and display plan info
  if (number) {
    loadPlanInfo(number);
    loadAdminContact();
  }
}

async function loadPlanInfo(phoneNumber) {
  try {
    const license = await window.api.checkLicense(phoneNumber);
    const section = document.getElementById("plan-info-section");
    if (!section) return;

    if (license.status === "active" && license.planType) {
      section.classList.remove("hidden");

      // Plan type
      const planTypeEl = document.getElementById("plan-type-display");
      if (planTypeEl) {
        planTypeEl.textContent =
          license.planType === "TRIAL" ? "Trial" : "Annual";
        planTypeEl.className =
          "plan-info-value plan-badge " +
          (license.planType === "TRIAL"
            ? "plan-badge-trial"
            : "plan-badge-annual");
      }

      // Start date
      const startEl = document.getElementById("plan-start-display");
      if (startEl && license.planStartDate) {
        const d = new Date(license.planStartDate);
        startEl.textContent = d.toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }

      // End date
      const endEl = document.getElementById("plan-end-display");
      if (endEl && license.expiresAt) {
        const d = new Date(license.expiresAt);
        endEl.textContent = d.toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }

      // Days left
      const daysEl = document.getElementById("plan-days-left");
      if (daysEl && license.expiresAt) {
        const now = new Date();
        const end = new Date(license.expiresAt);
        const diffMs = end - now;
        const daysLeft = Math.max(0, Math.ceil(diffMs / 86400000));
        daysEl.textContent = daysLeft + (daysLeft === 1 ? " day" : " days");
        if (daysLeft <= 3) {
          daysEl.classList.add("plan-days-critical");
        } else if (daysLeft <= 7) {
          daysEl.classList.add("plan-days-warning");
        }
      }
    } else {
      section.classList.add("hidden");
    }
  } catch (err) {
    console.error("Failed to load plan info:", err);
  }
}

// Fetch admin contact number and populate all contact display elements
async function loadAdminContact() {
  try {
    const result = await window.api.getAdminContact();
    const contactEls = document.querySelectorAll(".admin-contact-number");
    const containerEls = document.querySelectorAll(".admin-contact-info");

    if (result.number) {
      contactEls.forEach((el) => (el.textContent = "+" + result.number));
      containerEls.forEach((el) => el.classList.remove("hidden"));

      // Also update the profile dropdown contact
      const profileEl = document.getElementById("profile-admin-number");
      const profileRow = document.getElementById("profile-admin-contact");
      if (profileEl) profileEl.textContent = "+" + result.number;
      if (profileRow) profileRow.classList.remove("hidden");
    } else {
      containerEls.forEach((el) => el.classList.add("hidden"));
      const profileRow = document.getElementById("profile-admin-contact");
      if (profileRow) profileRow.classList.add("hidden");
    }
  } catch (err) {
    console.error("Failed to load admin contact:", err);
  }
}

function toggleProfileDropdown() {
  const dropdown = document.getElementById("profile-dropdown");
  dropdown.classList.toggle("hidden");
}

async function logoutWhatsApp() {
  const dropdown = document.getElementById("profile-dropdown");
  dropdown.classList.add("hidden");

  showToast("Logging out and restarting...", "info");
  stopAutoRefresh();
  await window.api.logoutAndRestart();
}

async function checkForUpdates() {
  const dropdown = document.getElementById("profile-dropdown");
  dropdown.classList.add("hidden");

  showToast("Checking for updates...", "info");
  try {
    const result = await window.api.checkForUpdates();
    if (result.error) {
      let errorMessage = result.error;

      // Provide more helpful messages based on error code
      if (result.code === "UPDATE_METADATA_NOT_FOUND") {
        errorMessage = "📦 Update server is not ready yet. " + result.error;
      } else if (result.code === "NETWORK_ERROR") {
        errorMessage = "🌐 " + result.error;
      }

      showToast(errorMessage, "error");
    } else if (!result.available) {
      showToast("✅ You're on the latest version!", "success");
    }
    // If available, the main process opens the update progress window
  } catch (err) {
    console.error("Update check error:", err);
    showToast(
      "⚠️ Could not check for updates. Please try again later.",
      "error",
    );
  }
}

function switchToLoginScreen() {
  // Reset state
  currentChatId = null;
  currentFiles = [];
  selectedFiles.clear();
  queueExplorerSelectionSync();
  allSelected = false;
  pendingUnreadIds.clear();
  if (newMessageRefreshTimer) {
    clearTimeout(newMessageRefreshTimer);
    newMessageRefreshTimer = null;
  }
  if (newMessageFileReloadTimer) {
    clearTimeout(newMessageFileReloadTimer);
    newMessageFileReloadTimer = null;
  }
  stopAutoRefresh();

  // Clear chat list so old account's chats don't show for the new account
  const oldChatList = document.getElementById("chat-list");
  if (oldChatList) oldChatList.innerHTML = "";
  const oldFileList = document.getElementById("file-list");
  if (oldFileList) oldFileList.innerHTML = "";
  const noChatSel = document.getElementById("no-chat-selected");
  if (noChatSel) noChatSel.classList.remove("hidden");
  const filesSection = document.getElementById("files-section");
  if (filesSection) filesSection.classList.add("hidden");

  // Switch screens
  document.getElementById("main-screen").classList.remove("active");
  document.getElementById("license-screen").classList.remove("active");
  const loginScreen = document.getElementById("login-screen");
  loginScreen.classList.add("active");

  // Reset QR container to show spinner
  const qrContainer = document.getElementById("qr-container");
  qrContainer.innerHTML = `
    <div class="spinner"></div>
    <p id="qr-status">Waiting for browser to start...</p>
    <img id="qr-image" class="qr-image hidden" alt="QR Code" />
  `;
  startInitTimer();
  // Reset loading bar
  const loadingContainer = document.getElementById("loading-bar-container");
  if (loadingContainer) loadingContainer.classList.add("hidden");
  const fill = document.getElementById("loading-bar-fill");
  if (fill) fill.style.width = "0%";

  // Hide reconnect button
  document.getElementById("btn-reconnect").classList.add("hidden");

  // Reset profile
  document.getElementById("profile-avatar").textContent = "?";
  document.getElementById("dropdown-avatar").textContent = "?";
  document.getElementById("profile-name").textContent = "Loading...";
  document.getElementById("profile-number").textContent = "";
}

// ── UI Helpers ───────────────────────────────────────────────────────────

// ── Init timer: shows elapsed seconds while waiting for QR code ──────────
let _initTimerInterval = null;
let _initTimerStart = 0;

function setQrStatus(text) {
  const el = document.getElementById("qr-status");
  if (el) el.textContent = text;
}

function startInitTimer() {
  stopInitTimer();
  _initTimerStart = Date.now();
  _initTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - _initTimerStart) / 1000);
    const el = document.getElementById("qr-status");
    if (!el) return;
    // Only update while spinner is showing (QR not yet displayed)
    const qrImg = document.getElementById("qr-image");
    if (qrImg && !qrImg.classList.contains("hidden")) {
      stopInitTimer();
      return;
    }
    // Keep the current base message but append elapsed time
    const base = el.dataset.base || el.textContent.replace(/ \(\d+s\)$/, "");
    el.dataset.base = base;
    el.textContent = `${base} (${secs}s)`;
  }, 1000);
}

function stopInitTimer() {
  if (_initTimerInterval) {
    clearInterval(_initTimerInterval);
    _initTimerInterval = null;
  }
  // Strip elapsed time suffix from status text
  const el = document.getElementById("qr-status");
  if (el && el.dataset.base) {
    el.textContent = el.dataset.base;
    delete el.dataset.base;
  }
}
function updateFileStatus(messageId, status) {
  const safeMsgId = messageId.replace(/[^a-zA-Z0-9]/g, "_");
  const el = document.getElementById(`file-${safeMsgId}`);
  if (!el) return;

  const statusEl = el.querySelector(".status-badge");
  if (statusEl) {
    statusEl.className = `status-badge ${status}`;
    statusEl.textContent =
      status === "downloading"
        ? "Downloading..."
        : status === "complete"
          ? "Downloaded"
          : status === "error"
            ? "Error"
            : status;
  }
}

function getStatusBadge(file) {
  if (file.isDownloaded) {
    return `<span class="status-badge downloaded">✓ Ready</span>`;
  }
  return `<span class="status-badge pending">Pending</span>`;
}

function getFileIcon(file) {
  const mimeType = (file.mimeType || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  const fileName = (file.fileName || "").toLowerCase();

  // For downloaded images, show a thumbnail preview
  const isImage =
    mimeType.includes("image") ||
    type === "image" ||
    /\.(jpg|jpeg|png|gif|bmp|webp|tiff?)$/i.test(fileName);
  if (isImage && file.isDownloaded && file.localPath) {
    const fileUrl = "file:///" + file.localPath.replace(/\\/g, "/");
    return {
      class: "image",
      icon: `<img class="file-thumbnail" src="${escapeHtml(fileUrl)}" alt="Preview" onerror="this.outerHTML='<svg class=\\'file-type-svg\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'1.5\\'><rect x=\\'3\\' y=\\'3\\' width=\\'18\\' height=\\'18\\' rx=\\'2\\'/><circle cx=\\'8.5\\' cy=\\'8.5\\' r=\\'1.5\\'/><path d=\\'M21 15l-5-5L5 21\\'/></svg>'" />`,
    };
  }

  // For downloaded videos, show a thumbnail-style icon
  const isVideo = mimeType.includes("video") || type === "video";
  if (isVideo && file.isDownloaded && file.localPath) {
    return {
      class: "video",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    };
  }

  if (mimeType.includes("pdf") || fileName.endsWith(".pdf")) {
    return {
      class: "pdf",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
    };
  }
  if (isImage) {
    return {
      class: "image",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
    };
  }
  if (
    mimeType.includes("word") ||
    mimeType.includes("document") ||
    /\.docx?$/i.test(fileName)
  ) {
    return {
      class: "doc",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`,
    };
  }
  if (
    mimeType.includes("excel") ||
    mimeType.includes("spreadsheet") ||
    /\.xlsx?$/i.test(fileName)
  ) {
    return {
      class: "excel",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><rect x="8" y="12" width="8" height="6" rx="1"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="8" y1="15" x2="16" y2="15"/></svg>`,
    };
  }
  if (
    mimeType.includes("presentation") ||
    mimeType.includes("powerpoint") ||
    /\.pptx?$/i.test(fileName)
  ) {
    return {
      class: "ppt",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><rect x="8" y="11" width="8" height="7" rx="1"/></svg>`,
    };
  }
  if (isVideo) {
    return {
      class: "video",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    };
  }
  if (mimeType.includes("audio") || type === "audio" || type === "ptt") {
    return {
      class: "audio",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
    };
  }
  if (type === "chat") {
    return {
      class: "chat",
      icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    };
  }
  return {
    class: "other",
    icon: `<svg class="file-type-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
  };
}

function formatDateLabel(timestamp) {
  if (!timestamp) return "Unknown Date";
  const date = new Date(timestamp * 1000);
  const now = new Date();

  // Strip time for day comparison
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today - target) / 86400000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return date.toLocaleDateString("en-US", { weekday: "long" });
  }
  // Same year — omit year
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getDateKey(timestamp) {
  if (!timestamp) return "unknown";
  const d = new Date(timestamp * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderFilesGroupedByDate(files, reverseOrder = true) {
  // Sort files by timestamp (oldest first for WhatsApp-style display)
  const sortedFiles = [...files].sort((a, b) =>
    reverseOrder
      ? (a.timestamp || 0) - (b.timestamp || 0)
      : (b.timestamp || 0) - (a.timestamp || 0),
  );

  // Group files by date
  const groups = new Map();
  for (const file of sortedFiles) {
    const key = getDateKey(file.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  let html = "";
  // Sort date keys (oldest first when reverseOrder is true)
  const sortedKeys = [...groups.keys()].sort((a, b) =>
    reverseOrder ? a.localeCompare(b) : b.localeCompare(a),
  );

  for (const key of sortedKeys) {
    const groupFiles = groups.get(key);
    const label = formatDateLabel(groupFiles[0].timestamp);
    html += `<div class="date-separator" data-date-key="${escapeHtml(key)}"><span class="date-separator-label">${escapeHtml(label)}</span></div>`;
    html += groupFiles.map(renderFileItem).join("");
  }
  return html;
}

// Append files into a container, merging into existing date-separator groups
// instead of creating duplicate separators for the same day.
function appendFilesGrouped(files, container, beforeEl) {
  // Group incoming files by date key
  const groups = new Map();
  for (const file of files) {
    const key = getDateKey(file.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  for (const [key, groupFiles] of groups) {
    const label = formatDateLabel(groupFiles[0].timestamp);
    const filesHtml = groupFiles.map(renderFileItem).join("");
    const existingSep = container.querySelector(
      `.date-separator[data-date-key="${CSS.escape(key)}"]`,
    );
    if (existingSep) {
      // Find the last file-item that belongs to this separator
      // (every sibling .file-item or .date-separator until the next separator)
      let insertAfter = existingSep;
      let sibling = existingSep.nextElementSibling;
      while (sibling && !sibling.classList.contains("date-separator")) {
        if (sibling.classList.contains("file-item")) insertAfter = sibling;
        sibling = sibling.nextElementSibling;
      }
      insertAfter.insertAdjacentHTML("afterend", filesHtml);
    } else {
      const html = `<div class="date-separator" data-date-key="${escapeHtml(key)}"><span class="date-separator-label">${escapeHtml(label)}</span></div>${filesHtml}`;
      if (beforeEl) {
        beforeEl.insertAdjacentHTML("beforebegin", html);
      } else {
        container.insertAdjacentHTML("beforeend", html);
      }
    }
  }
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diff = now - date;
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "";
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

function getInitials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/**
 * Format a phone number for display.
 * Simply adds a '+' prefix to the raw international number.
 * e.g. "94771234567" → "+94771234567"
 */
function formatPhoneNumber(number) {
  if (!number) return "";
  // If it's a group ID or contains '@', return as-is
  if (number.includes("@") || number.includes("-")) return number;
  // Strip any non-digit characters
  const digits = number.replace(/\D/g, "");
  if (digits.length > 0) {
    return "+" + digits;
  }
  return number;
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeJs(str) {
  if (!str) return "";
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ── Toast Notifications ──────────────────────────────────────────────────
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function normalizeErrorMessage(errorValue, fallback = "Unknown error") {
  if (typeof errorValue === "string") {
    const msg = errorValue.trim();
    if (msg.length >= 3) return msg;
    return fallback;
  }
  if (errorValue && typeof errorValue.message === "string") {
    const msg = errorValue.message.trim();
    return msg || fallback;
  }
  return fallback;
}

// ── Chat Input Bar ───────────────────────────────────────────────────────
function setupChatInputBar() {
  const messageInput = document.getElementById("chat-message-input");
  const btnSend = document.getElementById("btn-send-message");
  const btnAttachFile = document.getElementById("btn-attach-file");

  if (messageInput) {
    // Send on Enter key
    messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendTextMessage();
      }
    });
  }

  if (btnSend) {
    btnSend.addEventListener("click", () => sendTextMessage());
  }

  if (btnAttachFile) {
    btnAttachFile.addEventListener("click", () => attachFile());
  }

  // Listen for sent messages
  window.api.onMessageSent((msgInfo) => {
    if (msgInfo.chatId === currentChatId) {
      addSentMessageToList(msgInfo);
    }
  });
}

async function sendTextMessage() {
  const messageInput = document.getElementById("chat-message-input");
  const message = messageInput?.value?.trim();

  if (!message || !currentChatId) {
    if (!currentChatId) showToast("Please select a chat first", "error");
    return;
  }

  try {
    messageInput.value = "";
    messageInput.focus();

    const result = await window.api.sendTextMessage(currentChatId, message);
    if (result.error) {
      showToast(`Failed to send: ${result.error}`, "error");
    }
  } catch (err) {
    showToast(`Error sending message: ${err.message}`, "error");
  }
}

async function attachFile() {
  if (!currentChatId) {
    showToast("Please select a chat first", "error");
    return;
  }

  try {
    const result = await window.api.selectFileToSend();
    if (result.canceled) return;

    const filePath = result.filePath;
    const fileName = result.fileName;

    // Ask for optional caption
    const caption = ""; // Could prompt user for caption

    showToast(`Sending ${fileName}...`, "info");

    const sendResult = await window.api.sendFileMessage(
      currentChatId,
      filePath,
      caption,
    );
    if (sendResult.error) {
      showToast(`Failed to send file: ${sendResult.error}`, "error");
    } else {
      showToast(`Sent ${fileName}`, "success");
    }
  } catch (err) {
    showToast(`Error attaching file: ${err.message}`, "error");
  }
}

function addSentMessageToList(msgInfo) {
  const fileList = document.getElementById("file-list");
  if (!fileList) return;

  // Create file object from message info
  const file = {
    messageId: msgInfo.messageId,
    chatId: msgInfo.chatId,
    sender: null,
    fromMe: true,
    timestamp: msgInfo.timestamp,
    type: msgInfo.type,
    body: msgInfo.body || "",
    fileName: msgInfo.fileName || null,
    isDownloaded: false,
    isUnread: false,
  };

  // Add to currentFiles
  currentFiles.push(file);

  // Render and append the new message at the bottom
  const html = renderFileItem(file);
  fileList.insertAdjacentHTML("beforeend", html);

  // Scroll to bottom
  fileList.scrollTop = fileList.scrollHeight;

  // Attach event listeners to the new element
  attachFileEventListeners(fileList);

  // Update file count
  document.getElementById("file-count").textContent =
    `${currentFiles.length} file${currentFiles.length !== 1 ? "s" : ""}`;
}

// Make cancelVoiceRecording available globally for onclick
window.cancelVoiceRecording = cancelVoiceRecording;
