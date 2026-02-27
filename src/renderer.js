// ══════════════════════════════════════════════════════════════════════════
// WhatsApp Print Manager - Renderer (Frontend Logic)
// ══════════════════════════════════════════════════════════════════════════

let currentChatId = null;
let currentFiles = [];
let selectedFiles = new Set();
let autoRefreshTimer = null;
let isRefreshing = false; // guard against re-entrant refresh
let showAllChats = false; // toggle between "recent/unread" and "all chats"
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

  // Close dropdown when clicking outside
  document.addEventListener("click", (e) => {
    const dropdown = document.getElementById("profile-dropdown");
    const section = document.getElementById("profile-section");
    if (dropdown && section && !section.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });

  // File action buttons
  const btnSelectAll = document.getElementById("btn-select-all");
  if (btnSelectAll)
    btnSelectAll.addEventListener("click", () => toggleSelectAll());

  const btnPrintSelected = document.getElementById("btn-print-selected");
  if (btnPrintSelected)
    btnPrintSelected.addEventListener("click", () => printSelected());

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
    const qrImg = document.getElementById("qr-image");
    const qrStatus = document.getElementById("qr-status");
    const spinner = document.querySelector(".spinner");

    qrImg.src = qrDataURL;
    qrImg.classList.remove("hidden");
    qrStatus.textContent = "Scan this QR code with WhatsApp on your phone";
    if (spinner) spinner.style.display = "none";
  });

  // WhatsApp Status
  window.api.onStatus((status) => {
    console.log("WhatsApp status:", status);
    const badge = document.getElementById("connection-badge");

    switch (status) {
      case "authenticated":
        showLoginLoading();
        break;
      case "ready":
        switchToMainScreen();
        refreshChats();
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
        break;
      case "retrying":
        {
          const qrImg = document.getElementById("qr-image");
          const qrStatus = document.getElementById("qr-status");
          const spinner = document.querySelector(".spinner");
          if (qrImg) qrImg.classList.add("hidden");
          if (spinner) spinner.style.display = "";
          if (qrStatus)
            qrStatus.textContent = "Session expired. Reconnecting...";
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

  // Loading screen
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

  // ── Real-time new message listener ──
  window.api.onNewMessage((data) => {
    console.log("[NewMessage]", data);
    showToast(
      `New message from ${data.chatName || data.sender}${data.hasMedia ? " (has file)" : ""}`,
      "info",
    );

    // Auto-refresh the chat list to show the new message
    refreshChats();

    // If we're currently viewing this chat, reload its files
    if (currentChatId === data.chatId && data.hasMedia) {
      selectChat(data.chatId, data.chatName || data.sender);
    }
  });
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

function switchToMainScreen() {
  document.getElementById("login-screen").classList.remove("active");
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
      const unreadBadge =
        chat.unreadCount > 0
          ? `<span class="badge badge-unread">${chat.unreadCount}</span>`
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
  updatePrintButton();

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

  const result = await window.api.getChatFiles(chatId);

  if (result.error) {
    fileList.innerHTML = `<div class="empty-state"><p>Error: ${result.error}</p></div>`;
    return;
  }

  currentFiles = result.files || [];
  document.getElementById("file-count").textContent =
    `${currentFiles.length} file${currentFiles.length !== 1 ? "s" : ""}`;

  if (currentFiles.length === 0) {
    fileList.innerHTML = `
      <div class="empty-state">
        <p>No media files found in this chat</p>
      </div>
    `;
    return;
  }

  // Auto-select all unread files that are already downloaded
  const unreadDownloaded = currentFiles.filter(
    (f) => f.isUnread && f.isDownloaded,
  );
  if (unreadDownloaded.length > 0) {
    unreadDownloaded.forEach((f) => selectedFiles.add(f.messageId));
    showToast(
      `Auto-selected ${unreadDownloaded.length} new file(s). Unselect any you don't need.`,
      "info",
    );
  }

  renderFiles();
  updatePrintButton();

  // Mark chat as read AFTER loading files (so unread tagging is accurate)
  window.api.markChatRead(chatId);

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
             <button class="btn-file-action print" data-action="print-file" data-path="${escapeHtml(file.localPath)}">🖨️ Print</button>`
            : `<button class="btn-file-action download" data-action="download-file" data-msg-id="${escapeHtml(file.messageId)}" data-filename="${escapeHtml(file.fileName)}">⬇️ Download</button>`
        }
      </div>
    </div>
  `;
}

function renderFiles() {
  const fileList = document.getElementById("file-list");

  const unreadFiles = currentFiles.filter((f) => f.isUnread);
  const seenFiles = currentFiles.filter((f) => !f.isUnread);

  let html = "";

  // New (unread) files section
  if (unreadFiles.length > 0) {
    html += `<div class="file-section-header new-section">
      <span class="section-icon">🔔</span>
      <span>New Files (${unreadFiles.length})</span>
    </div>`;
    html += renderFilesGroupedByDate(unreadFiles);
  }

  // Previously seen files section
  if (seenFiles.length > 0) {
    if (unreadFiles.length > 0) {
      html += `<div class="file-section-header seen-section">
        <span class="section-icon">📂</span>
        <span>Previously Seen (${seenFiles.length})</span>
      </div>`;
    }
    html += renderFilesGroupedByDate(seenFiles);
  }

  fileList.innerHTML = html;

  // Attach event listeners via delegation on buttons
  fileList.querySelectorAll("[data-action]").forEach((el) => {
    if (el.tagName === "INPUT") {
      el.addEventListener("change", handleFileAction);
    } else {
      el.addEventListener("click", handleFileAction);
    }
  });

  // Click anywhere on card to toggle selection
  fileList.querySelectorAll(".file-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      // Don't toggle if clicking on action buttons or checkbox
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

  // Load document thumbnails asynchronously
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
    case "print-file":
      printSingleFile(el.dataset.path);
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
function toggleFileSelect(messageId) {
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

  updatePrintButton();
}

function toggleSelectAll() {
  const btn = document.getElementById("btn-select-all");
  const downloadedFiles = currentFiles.filter((f) => f.isDownloaded);
  const allCurrentlySelected =
    downloadedFiles.length > 0 &&
    downloadedFiles.every((f) => selectedFiles.has(f.messageId));

  if (allCurrentlySelected) {
    // Deselect all
    selectedFiles.clear();
  } else {
    // Select all downloaded files
    downloadedFiles.forEach((f) => {
      selectedFiles.add(f.messageId);
    });
  }

  renderFiles();
  updateSelectAllButton();
  updatePrintButton();
}

function updateSelectAllButton() {
  const btn = document.getElementById("btn-select-all");
  if (!btn) return;
  const downloadedFiles = currentFiles.filter((f) => f.isDownloaded);
  const allCurrentlySelected =
    downloadedFiles.length > 0 &&
    downloadedFiles.every((f) => selectedFiles.has(f.messageId));
  btn.textContent = allCurrentlySelected ? "Deselect All" : "Select All";
}

function updatePrintButton() {
  const btn = document.getElementById("btn-print-selected");
  btn.disabled = selectedFiles.size === 0;
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
    Print Selected (${selectedFiles.size})
  `;

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

  updateSelectAllButton();
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
    updatePrintButton();

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

// ── Printing ─────────────────────────────────────────────────────────────
async function printSelected() {
  if (selectedFiles.size === 0) return;

  const filePaths = [];
  selectedFiles.forEach((msgId) => {
    const file = currentFiles.find((f) => f.messageId === msgId);
    if (file && file.localPath) filePaths.push(file.localPath);
  });

  if (filePaths.length === 0) {
    showToast("No downloaded files selected for printing", "warning");
    return;
  }

  const printerName = document.getElementById("printer-select").value;

  showToast(`Opening printer setup for ${filePaths.length} file(s)...`, "info");

  const result = await window.api.printWithSetup({ filePaths, printerName });

  if (result.error) {
    showToast(`Print error: ${result.error}`, "error");
    return;
  }

  if (result.results) {
    const success = result.results.filter((r) => r.success).length;
    const fail = result.results.filter((r) => r.error).length;
    showToast(
      `Printed ${success} file(s)${fail > 0 ? `, ${fail} failed` : ""}`,
      fail > 0 ? "warning" : "success",
    );
  }
}

async function printSingleFile(filePath) {
  const printerName = document.getElementById("printer-select").value;
  showToast("Opening printer setup...", "info");

  const result = await window.api.printWithSetup({
    filePaths: [filePath],
    printerName,
  });

  if (result.error) {
    showToast(`Print error: ${result.error}`, "error");
    return;
  }

  if (result.results && result.results[0]) {
    if (result.results[0].success) {
      showToast("File sent to printer!", "success");
    } else {
      showToast(`Print error: ${result.results[0].error}`, "error");
    }
  }
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

function switchToLoginScreen() {
  // Reset state
  currentChatId = null;
  currentFiles = [];
  selectedFiles.clear();
  allSelected = false;
  stopAutoRefresh();

  // Switch screens
  document.getElementById("main-screen").classList.remove("active");
  const loginScreen = document.getElementById("login-screen");
  loginScreen.classList.add("active");

  // Reset QR container to show spinner
  const qrContainer = document.getElementById("qr-container");
  qrContainer.innerHTML = `
    <div class="spinner"></div>
    <p id="qr-status">Initializing WhatsApp connection...</p>
    <img id="qr-image" class="qr-image hidden" alt="QR Code" />
  `;

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
  for (const [, groupFiles] of groups) {
    const label = formatDateLabel(groupFiles[0].timestamp);
    html += `<div class="date-separator"><span class="date-separator-label">${escapeHtml(label)}</span></div>`;
    html += groupFiles.map(renderFileItem).join("");
  }
  return html;
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
