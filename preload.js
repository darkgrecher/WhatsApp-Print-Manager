const { contextBridge, ipcRenderer } = require("electron");

// Expose protected methods that allow the renderer process
// to use ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("api", {
  // ── WhatsApp Events ──
  onQRCode: (callback) =>
    ipcRenderer.on("whatsapp:qr", (_, data) => callback(data)),
  onStatus: (callback) =>
    ipcRenderer.on("whatsapp:status", (_, data) => callback(data)),
  onLoading: (callback) =>
    ipcRenderer.on("whatsapp:loading", (_, data) => callback(data)),
  onDownloadProgress: (callback) =>
    ipcRenderer.on("download:progress", (_, data) => callback(data)),
  onBulkDownloadProgress: (callback) =>
    ipcRenderer.on("download:bulk-progress", (_, data) => callback(data)),
  onNewMessage: (callback) =>
    ipcRenderer.on("whatsapp:new-message", (_, data) => callback(data)),

  // ── WhatsApp Actions ──
  getUnreadChats: () => ipcRenderer.invoke("get-unread-chats"),
  getAllChats: (options) => ipcRenderer.invoke("get-all-chats", options),
  getChatFiles: (chatId) => ipcRenderer.invoke("get-chat-files", chatId),
  downloadFile: (data) => ipcRenderer.invoke("download-file", data),
  downloadAllFiles: (chatId) =>
    ipcRenderer.invoke("download-all-files", chatId),
  markChatRead: (chatId) => ipcRenderer.invoke("mark-chat-read", chatId),
  reconnectWhatsApp: () => ipcRenderer.invoke("reconnect-whatsapp"),
  getWhatsAppStatus: () => ipcRenderer.invoke("get-whatsapp-status"),
  getProfileInfo: () => ipcRenderer.invoke("get-profile-info"),
  logoutWhatsApp: () => ipcRenderer.invoke("logout-whatsapp"),

  // ── Print Actions ──
  printFiles: (filePaths) => ipcRenderer.invoke("print-files", filePaths),
  printToPrinter: (data) => ipcRenderer.invoke("print-to-printer", data),
  getPrinters: () => ipcRenderer.invoke("get-printers"),

  // ── File Actions ──
  openDownloadsFolder: () => ipcRenderer.invoke("open-downloads-folder"),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  deleteFiles: (data) => ipcRenderer.invoke("delete-files", data),
  generateThumbnail: (filePath) =>
    ipcRenderer.invoke("generate-thumbnail", filePath),
});
