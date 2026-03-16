const fs = require('fs');
let content = fs.readFileSync('src/renderer.js', 'utf8');
const startMatch = 'async function openSelected() {';
const startIndex = content.indexOf(startMatch);
const endMatch = '// ── Download ─────────────────────────────────────────────────────────────';
const endIndex = content.indexOf(endMatch, startIndex);

const oldBlock = content.substring(startIndex, endIndex);

const correctBlock = `async function openSelected() {
  if (selectedFiles.size === 0) {
    showToast("No downloaded files selected", "warning");
    return;
  }

  const filePaths = [];
  let allImages = true;

  selectedFiles.forEach((msgId) => {
    const file = currentFiles.find((f) => f.messageId === msgId);
    if (file && file.localPath) {
      filePaths.push(file.localPath);
      if (getFileType(file.fileName) !== "image") {
        allImages = false;
      }
    }
  });

  if (filePaths.length === 0) {
    showToast("No downloaded files selected to open", "warning");
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

  selectedFiles.clear();
  renderFiles();
  updateSelectionUI();
}

`;

content = content.replace(oldBlock, correctBlock);
fs.writeFileSync('src/renderer.js', content, 'utf8');
console.log('Fixed openSelected() syntax error');
