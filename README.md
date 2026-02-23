# WhatsApp Print Manager

A desktop application for bookshops to easily download and print files received via WhatsApp.

## Features

- **QR Code Login** – Log in by scanning a QR code with your WhatsApp mobile app
- **View Unread Chats** – See all contacts with unread messages
- **Filter by Contact** – Select specific contacts to view their files
- **Batch Download** – Download all media files from a chat with one click
- **Print Management** – Select files and print them to any connected printer
- **Supports All File Types** – PDF, images, Word, Excel, PowerPoint, and more
- **Persistent Session** – Stays logged in between app restarts

## Prerequisites

- **Node.js** v18 or later
- **Windows 10/11** (printing features use Windows shell)
- A WhatsApp account

## Installation

```bash
# Navigate to the project directory
cd whatsapp-print-app

# Install dependencies
npm install

# Start the app
npm start
```

## Usage

1. **Launch** the app with `npm start`
2. **Scan** the QR code with your WhatsApp mobile (Settings → Linked Devices → Link a Device)
3. **Wait** for WhatsApp to load (progress bar shown)
4. **Click** on a contact in the left sidebar to view files they sent
5. **Download** files individually or use "Download All"
6. **Select** downloaded files using checkboxes
7. **Choose** your printer from the dropdown (optional, uses default if not set)
8. **Click** "Print Selected" to send to printer

## Project Structure

```
whatsapp-print-app/
├── main.js          # Electron main process + WhatsApp client
├── preload.js       # IPC bridge (secure context isolation)
├── package.json
├── downloads/       # Downloaded media files stored here
└── src/
    ├── index.html   # Application UI
    ├── styles.css   # Styling
    └── renderer.js  # Frontend logic
```

## Notes

- The app uses **whatsapp-web.js** which automates WhatsApp Web via Puppeteer
- Session data is stored in `.wwebjs_auth/` folder for persistent login
- Downloaded files are saved in the `downloads/` folder
- PDF printing uses `pdf-to-printer`, other files use Windows shell print verb

## Troubleshooting

- **QR code not showing?** Click the Reconnect button or restart the app
- **Files not printing?** Ensure you have a printer installed and set as default
- **Download fails?** Some media may expire on WhatsApp servers; try refreshing

## License

MIT
