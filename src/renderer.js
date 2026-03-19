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
const pendingUnreadIds = new Map(); // chatId → Set<messageId> tracked client-side
const AUTO_REFRESH_INTERVAL = 10000; // 10 seconds

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
      btnLoginAgain.classList.add("hidden");
      if (btnReconnect) btnReconnect.classList.add("hidden");
      const qrStatus = document.getElementById("qr-status");
      if (qrStatus) qrStatus.textContent = "Clearing session and restarting...";
      const spinner = document.querySelector(".spinner");
      if (spinner) spinner.style.display = "inline-block";
      window.api.logoutWhatsApp();
    });
  }

  // Topbar buttons
  const btnRefresh = document.getElementById("btn-refresh");
  if (btnRefresh) btnRefresh.addEventListener("click", () => refreshChats());

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
    const dropdown = document.getElementById("profile-dropdown");
    const section = document.getElementById("profile-section");
    if (dropdown && section && !section.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });

  // File action buttons
  const btnUnselectAll = document.getElementById("btn-unselect-all");
  if (btnUnselectAll)
    btnUnselectAll.addEventListener("click", () => unselectAllFiles());

  const btnOpenSelected = document.getElementById("btn-open-selected");
  if (btnOpenSelected)
    btnOpenSelected.addEventListener("click", () => openSelected());

  const fabDelete = document.getElementById("fab-delete");
  if (fabDelete) fabDelete.addEventListener("click", () => deleteSelected());

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
    fileSearch.addEventListener("input", () => {
      filterFiles(fileSearch.value);
      fileSearchClear.classList.toggle("hidden", fileSearch.value.length === 0);
    });
  }
  if (fileSearchClear) {
    fileSearchClear.addEventListener("click", () => {
      fileSearch.value = "";
      fileSearchClear.classList.add("hidden");
      filterFiles("");
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
}

function setupEventListeners() {
  // ── ESC key to close chat ──
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && currentChatId) {
      closeChat();
    }
  });

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
        setQrStatus("Starting browser...");
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
            "Connection failed due to a stale session or timeout.";
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
            qrStatus.textContent = "Session expired. Reconnecting...";
          startInitTimer();
        }
        showToast(
          "Session expired, reconnecting with fresh session...",
          "info",
        );
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

      // Update display name if enrichment resolved a better one
      if (data.name) {
        const nameEl = el.querySelector(".chat-name");
        if (nameEl) {
          const isGroup = nameEl.textContent.includes("\uD83D\uDC65");
          nameEl.textContent = data.name + (isGroup ? " \uD83D\uDC65" : "");
        }
        el.dataset.chatName = data.name;
      }

      // Update profile picture
      if (data.profilePicUrl) {
        const avatarEl = el.querySelector(".chat-avatar");
        if (avatarEl) {
          const initials = getInitials(data.name || "");
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
      const batchUnread = files.filter((f) => f.isUnread);
      const batchSeen = files.filter((f) => !f.isUnread);

      // ── Unread files arriving via batch ─────────────────────────────────
      // Happens when fetchMessages() surfaces a new message that was not yet
      // in the WhatsApp Web memory store during Phase 1.
      if (batchUnread.length > 0) {
        // Auto-select downloaded unread files (same behaviour as Phase 1)
        batchUnread
          .filter((f) => f.isDownloaded)
          .forEach((f) => selectedFiles.add(f.messageId));
        updateSelectionUI();

        const totalUnread = currentFiles.filter((f) => f.isUnread).length;
        let newSectionFiles = fileList.querySelector(".new-section-files");

        if (!newSectionFiles) {
          // Phase 1 returned nothing unread — build the whole section now
          const insertBefore =
            fileList.querySelector(".older-files-loading") ||
            fileList.querySelector(".seen-section");
          const sectionHtml =
            `<div class="file-section-header new-section">` +
            `<span class="section-icon">🔔</span>` +
            `<span>New Files (<span class="new-count">${totalUnread}</span>)</span>` +
            `</div><div class="new-section-files"></div>`;
          if (insertBefore) {
            insertBefore.insertAdjacentHTML("beforebegin", sectionHtml);
          } else {
            fileList.insertAdjacentHTML("afterbegin", sectionHtml);
          }
          newSectionFiles = fileList.querySelector(".new-section-files");
        } else {
          const countEl = fileList.querySelector(".new-section .new-count");
          if (countEl) countEl.textContent = totalUnread;
        }

        // Append into the isolated container so date keys stay within this
        // section and don't accidentally merge into "Previously Seen".
        appendFilesGrouped(batchUnread, newSectionFiles, null);
      }

      // ── Seen (older) files arriving via batch ────────────────────────────
      if (batchSeen.length > 0) {
        const seenCount = currentFiles.filter((f) => !f.isUnread).length;
        const hasNewSection = fileList.querySelector(".new-section");
        let seenSectionFiles = fileList.querySelector(".seen-section-files");

        if (!seenSectionFiles) {
          if (hasNewSection) {
            // Create the "Previously Seen" section with an isolated container
            const loadingEl = fileList.querySelector(".older-files-loading");
            const sectionHtml =
              `<div class="file-section-header seen-section">` +
              `<span class="section-icon">📂</span>` +
              `<span>Previously Seen (<span class="seen-count">${seenCount}</span>)</span>` +
              `</div><div class="seen-section-files"></div>`;
            if (loadingEl) {
              loadingEl.insertAdjacentHTML("beforebegin", sectionHtml);
            } else {
              fileList.insertAdjacentHTML("beforeend", sectionHtml);
            }
            seenSectionFiles = fileList.querySelector(".seen-section-files");
          } else {
            // No unread section — flat list, no header needed
            const loadingEl = fileList.querySelector(".older-files-loading");
            appendFilesGrouped(batchSeen, fileList, loadingEl);
          }
        } else {
          const countEl = fileList.querySelector(".seen-section .seen-count");
          if (countEl) countEl.textContent = seenCount;
        }

        if (seenSectionFiles) {
          appendFilesGrouped(batchSeen, seenSectionFiles, null);
        }
      }

      attachFileEventListeners(fileList);
    }

    // Remove loading indicator when done
    if (done) {
      const fileList = document.getElementById("file-list");
      const loadingEl = fileList.querySelector(".older-files-loading");
      if (loadingEl) loadingEl.remove();

      // If nothing loaded at all (no unread, no older), show empty state
      if (currentFiles.length === 0) {
        fileList.innerHTML = `<div class="empty-state"><p>No media files found in this chat</p></div>`;
        document.getElementById("file-count").textContent = "0 files";
      }

      // Load thumbnails for any new PDF files
      loadDocumentThumbnails();
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

      // Update DOM: enable the checkbox
      const safeMsgId = messageId.replace(/[^a-zA-Z0-9]/g, "_");
      const fileEl = document.getElementById(`file-${safeMsgId}`);
      if (fileEl) {
        const checkbox = fileEl.querySelector(".file-checkbox");
        if (checkbox) {
          checkbox.disabled = false;
          checkbox.removeAttribute("title");
        }
      }

      // Auto-select unread files (same behaviour as selectChat's initial render)
      if (file.isUnread && !selectedFiles.has(messageId)) {
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

    if (!isContainer) {
      showToast(
        `New message from ${data.chatName || data.sender}${data.hasMedia ? " (has file)" : ""}`,
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

    // Debounced follow-up refresh: resets on every new message so only one
    // refresh fires 2s after the last message in a burst (e.g. 8 files).
    if (newMessageRefreshTimer) clearTimeout(newMessageRefreshTimer);
    newMessageRefreshTimer = setTimeout(() => {
      newMessageRefreshTimer = null;
      refreshChats();
    }, 2000);

    // If we're currently viewing this chat, debounce file list reload so
    // a burst of messages (e.g. 8 images) triggers only one reload after
    // all messages have arrived and whatsapp-web.js has synced.
    if (currentChatId === data.chatId && data.hasMedia) {
      if (newMessageFileReloadTimer) clearTimeout(newMessageFileReloadTimer);
      newMessageFileReloadTimer = setTimeout(() => {
        newMessageFileReloadTimer = null;
        selectChat(data.chatId, data.chatName || data.sender);
      }, 2000);
    }
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
      const preview = data.hasMedia
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
      showLicenseScreen("pending");
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
  showToast("Logging out...", "info");
  await window.api.logoutWhatsApp();
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
      const initials = getInitials(chat.name);
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
      <div class="chat-item ${isActive}" data-chat-id="${escapeHtml(chat.id)}" data-chat-name="${escapeHtml(chat.name)}">
        <div class="chat-avatar">${avatarContent}</div>
        <div class="chat-info">
          <div class="chat-name">${escapeHtml(chat.name)} ${chat.isGroup ? "👥" : ""}</div>
          <div class="chat-number">${chat.number}</div>
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
async function selectChat(chatId, chatName) {
  currentChatId = chatId;
  selectedFiles.clear();
  updateSelectionUI();

  // Clear file search
  const fileSearch = document.getElementById("file-search");
  const fileSearchClear = document.getElementById("file-search-clear");
  if (fileSearch) fileSearch.value = "";
  if (fileSearchClear) fileSearchClear.classList.add("hidden");

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
    (f) => f.isUnread && f.isDownloaded,
  );
  if (unreadDownloaded.length > 0) {
    unreadDownloaded.forEach((f) => selectedFiles.add(f.messageId));
  }

  // Build initial HTML: unread files first, then loading indicator if older files coming
  let html = "";

  if (unreadFiles.length > 0) {
    html += `<div class="file-section-header new-section">
      <span class="section-icon">🔔</span>
      <span>New Files (<span class="new-count">${unreadFiles.length}</span>)</span>
    </div>`;
    // Wrap in an isolated container so batch-appended files don't bleed
    // date-separator keys from this section into the "Previously Seen" section.
    html += `<div class="new-section-files">${renderFilesGroupedByDate(unreadFiles)}</div>`;
  }

  if (hasOlderFiles) {
    html += `<div class="older-files-loading">
      <div class="spinner" style="width:20px;height:20px;border-width:2px"></div>
      <span style="margin-left:8px;color:var(--text-secondary)">Loading older files...</span>
    </div>`;
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
  loadDocumentThumbnails();

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
  const isChecked = selectedFiles.has(file.messageId) ? "checked" : "";
  const isSelected = selectedFiles.has(file.messageId) ? "selected" : "";
  const time = formatTime(file.timestamp);
  const size = file.fileSize ? formatSize(file.fileSize) : "";
  const statusBadge = getStatusBadge(file);
  const safeMsgId = file.messageId.replace(/[^a-zA-Z0-9]/g, "_");
  const unreadClass = file.isUnread ? "file-unread" : "";

  return `
    <div class="file-item ${isSelected} ${unreadClass}" data-message-id="${escapeHtml(file.messageId)}" id="file-${safeMsgId}">
      <input type="checkbox" class="file-checkbox" ${isChecked} 
        data-action="toggle-select" data-msg-id="${escapeHtml(file.messageId)}"
        ${!file.isDownloaded ? 'disabled title="Download first to select"' : ""} />
      <div class="file-icon ${iconInfo.class}">${iconInfo.icon}</div>
      <div class="file-details">
        <div class="file-name" title="${escapeHtml(file.fileName || "Unknown file")}">${escapeHtml(file.fileName || "Unknown file")}</div>
        <div class="file-meta">
          <span>${file.type || "file"}</span>
          ${size ? `<span>${size}</span>` : ""}
          <span>${time}</span>
          <span>From: ${escapeHtml(file.sender)}</span>
        </div>
      </div>
      ${statusBadge}
      <div class="file-actions">
        ${
          file.isDownloaded
            ? `<button class="btn-file-action" data-action="open-file" data-path="${escapeHtml(file.localPath)}">Open</button>
             `
            : `<button class="btn-file-action download" data-action="download-file" data-msg-id="${escapeHtml(file.messageId)}" data-filename="${escapeHtml(file.fileName)}">⬇️ Download</button>`
        }
      </div>
    </div>
  `;
}

// Attach action + click-to-select listeners to file items within a container.
// Safe to call multiple times — uses event delegation markers to avoid duplication.
function attachFileEventListeners(container) {
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
    el.addEventListener("click", (e) => {
      if (
        e.target.closest(".file-actions") ||
        e.target.closest(".file-checkbox")
      )
        return;
      const msgId = el.dataset.messageId;
      const file = currentFiles.find((f) => f.messageId === msgId);
      if (file && file.isDownloaded) {
        toggleFileSelect(msgId);
        const checkbox = el.querySelector(".file-checkbox");
        if (checkbox) checkbox.checked = selectedFiles.has(msgId);
      }
    });
  });
}

function renderFiles() {
  const fileList = document.getElementById("file-list");

  const unreadFiles = currentFiles.filter((f) => f.isUnread);
  const seenFiles = currentFiles.filter((f) => !f.isUnread);

  let html = "";

  if (unreadFiles.length > 0) {
    html += `<div class="file-section-header new-section">`;
    html += `<span class="section-icon">🔔</span>`;
    html += `<span>New Files (<span class="new-count">${unreadFiles.length}</span>)</span>`;
    html += `</div>`;
    html += `<div class="new-section-files">${renderFilesGroupedByDate(unreadFiles)}</div>`;
  }

  if (seenFiles.length > 0) {
    if (unreadFiles.length > 0) {
      html += `<div class="file-section-header seen-section">`;
      html += `<span class="section-icon">📂</span>`;
      html += `<span>Previously Seen (<span class="seen-count">${seenFiles.length}</span>)</span>`;
      html += `</div>`;
    }
    html += `<div class="seen-section-files">${renderFilesGroupedByDate(seenFiles)}</div>`;
  }

  fileList.innerHTML = html;
  attachFileEventListeners(fileList);
  loadDocumentThumbnails();
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

// ── Document Thumbnail Loading ───────────────────────────────────────────
async function loadDocumentThumbnails() {
  const pdfFiles = currentFiles.filter((f) => {
    const fn = (f.fileName || "").toLowerCase();
    const mt = (f.mimeType || "").toLowerCase();
    return (
      f.isDownloaded &&
      f.localPath &&
      (fn.endsWith(".pdf") || mt.includes("pdf"))
    );
  });

  for (const file of pdfFiles) {
    const safeMsgId = file.messageId.replace(/[^a-zA-Z0-9]/g, "_");
    const iconEl = document.querySelector(`#file-${safeMsgId} .file-icon`);
    if (!iconEl) continue;

    // Skip if already has a thumbnail image
    if (iconEl.querySelector(".file-thumbnail")) continue;

    try {
      const result = await window.api.generateThumbnail(file.localPath);
      if (result && result.thumbnailPath) {
        const url = "file:///" + result.thumbnailPath.replace(/\\/g, "/");
        iconEl.innerHTML = `<img class="file-thumbnail" src="${escapeHtml(url)}" alt="Preview" />`;
      }
    } catch (err) {
      console.error("Thumbnail load failed for", file.fileName, err);
    }
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

function toggleFileSelect(messageId) {
  const fileToSelect = currentFiles.find((f) => f.messageId === messageId);
  if (!fileToSelect) return;

  if (!selectedFiles.has(messageId)) {
    // We are adding. Check if it matches existing selection types.
    if (selectedFiles.size > 0) {
      const firstSelectedId = Array.from(selectedFiles)[0];
      const firstFile = currentFiles.find(
        (f) => f.messageId === firstSelectedId,
      );
      if (firstFile) {
        const firstType = getFileType(firstFile.fileName);
        const currentType = getFileType(fileToSelect.fileName);
        if (firstType !== currentType) {
          showToast(
            `Please select only files of the same type (${firstType.toUpperCase()})`,
            "warning",
          );
          // Revert checkbox if it was toggled
          const el = document.getElementById(
            `file-${messageId.replace(/[^a-zA-Z0-9]/g, "_")}`,
          );
          if (el) {
            const checkbox = el.querySelector(".file-checkbox");
            if (checkbox) checkbox.checked = false;
          }
          return;
        }
      }
    }
  }

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
  // Update floating delete FAB
  const fab = document.getElementById("fab-delete");
  if (fab) {
    if (selectedFiles.size > 0) {
      fab.classList.remove("hidden");
      document.getElementById("fab-delete-count").textContent =
        selectedFiles.size;
    } else {
      fab.classList.add("hidden");
    }
  }

  // Show unselect button only when files are selected
  const btnUnselectAll = document.getElementById("btn-unselect-all");
  if (btnUnselectAll) {
    btnUnselectAll.classList.toggle("hidden", selectedFiles.size === 0);
  }
}

function unselectAllFiles() {
  if (selectedFiles.size === 0) return;
  selectedFiles.clear();
  renderFiles();
  updateSelectionUI();
}

// ── Open Selected ────────────────────────────────────────────────────────
async function openSelected() {
  if (selectedFiles.size === 0) {
    showToast("No downloaded files selected", "warning");
    return;
  }

  const filePaths = [];
  const selectedTypes = new Set();
  let allImages = true;

  selectedFiles.forEach((msgId) => {
    const file = currentFiles.find((f) => f.messageId === msgId);
    if (file && file.localPath) {
      filePaths.push(file.localPath);
      const fType = getFileType(file.fileName);
      selectedTypes.add(fType);
      if (fType !== "image") {
        allImages = false;
      }
    }
  });

  if (filePaths.length === 0) {
    showToast("No downloaded files selected to open", "warning");
    return;
  }

  if (selectedTypes.size > 1) {
    showToast("Only files of one type can be opened", "warning");
    return;
  }

  if (allImages) {
    // Send directly to Windows Print Pictures dialog
    window.api.openPrintPictures(filePaths);
  } else {
    // Standard open for non-image or mixed batches
    for (const filePath of filePaths) {
      openFile(filePath);
    }
  }
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

  // Hide floating delete button
  const fab = document.getElementById("fab-delete");
  if (fab) fab.classList.add("hidden");

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
function openFile(filePath) {
  window.api.openFile(filePath);
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

  showToast("Logging out...", "info");
  stopAutoRefresh();

  await window.api.logoutWhatsApp();
}

async function checkForUpdates() {
  const dropdown = document.getElementById("profile-dropdown");
  dropdown.classList.add("hidden");

  showToast("Checking for updates...", "info");
  try {
    const result = await window.api.checkForUpdates();
    if (result.error) {
      showToast("Update check failed: " + result.error, "error");
    } else if (!result.available) {
      showToast("You're on the latest version!", "success");
    }
    // If available, the main process opens the update progress window
  } catch (err) {
    showToast("Could not check for updates", "error");
  }
}

function switchToLoginScreen() {
  // Reset state
  currentChatId = null;
  currentFiles = [];
  selectedFiles.clear();
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

function renderFilesGroupedByDate(files) {
  // Group files by date
  const groups = new Map();
  for (const file of files) {
    const key = getDateKey(file.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  let html = "";
  for (const [key, groupFiles] of groups) {
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
