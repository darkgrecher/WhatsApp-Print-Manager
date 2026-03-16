const fs = require('fs');
let code = fs.readFileSync('src/renderer.js', 'utf8');

// 1. Remove toggleSelectAll and updateSelectAllButton
const toggleSelectAllRegex = /function toggleSelectAll\(\) \{[\s\S]*?\}\s*function updateSelectAllButton\(\) \{[\s\S]*?\}/;
code = code.replace(toggleSelectAllRegex, '');

// 2. Remove updateSelectAllButton() from updatePrintButton (or updateSelectionButton now)
code = code.replace(/updateSelectAllButton\(\);\n/g, '');

// Rename updatePrintButton to updateSelectionUI
code = code.replace(/function updatePrintButton\(\)/g, 'function updateSelectionUI()');
code = code.replace(/updatePrintButton\(\)/g, 'updateSelectionUI()');

// 3. Replace toggleFileSelect
const toggleFileSelectRegex = /function toggleFileSelect\(messageId\) \{[\s\S]*?updateSelectionUI\(\);\n  \}/;

const newToggleFileSelect = `function getFileType(fileName) {
  if (!fileName) return "unknown";
  const ext = fileName.split('.').pop().toLowerCase();
  const imageExts = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tiff', 'tif', 'webp'];
  if (ext === 'pdf') return 'pdf';
  if (imageExts.includes(ext)) return 'image';
  return ext;
}

function toggleFileSelect(messageId) {
  const fileToSelect = currentFiles.find(f => f.messageId === messageId);
  if (!fileToSelect) return;

  if (!selectedFiles.has(messageId)) {
    // We are adding. Check if it matches existing selection types.
    if (selectedFiles.size > 0) {
      const firstSelectedId = Array.from(selectedFiles)[0];
      const firstFile = currentFiles.find(f => f.messageId === firstSelectedId);
      if (firstFile) {
        const firstType = getFileType(firstFile.fileName);
        const currentType = getFileType(fileToSelect.fileName);
        if (firstType !== currentType) {
          showToast(\`Please select only files of the same type (\${firstType.toUpperCase()})\`, "warning");
          // Revert checkbox if it was toggled
          const elList = document.querySelectorAll(\`.file-item[data-message-id="\${messageId}"] .file-checkbox\`);
          elList.forEach(cb => cb.checked = false);
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
    \`file-\${messageId.replace(/[^a-zA-Z0-9]/g, "_")}\`,
  );
  if (el) el.classList.toggle("selected", selectedFiles.has(messageId));
  
  const checkbox = el ? el.querySelector(".file-checkbox") : null;
  if (checkbox) checkbox.checked = selectedFiles.has(messageId);

  updateSelectionUI();
}`;

if (code.match(toggleFileSelectRegex)) {
  code = code.replace(toggleFileSelectRegex, newToggleFileSelect);
} else {
  // If rename didn't match correctly with old name, let's try with updatePrintButton
  const fallbackRegex = /function toggleFileSelect\(messageId\) \{[\s\S]*?updatePrintButton\(\);\n  \}/;
  if (code.match(fallbackRegex)) {
     code = code.replace(fallbackRegex, newToggleFileSelect);
  } else {
     console.log("Could not find toggleFileSelect!");
  }
}

// 4. Add openSelected
const openSelectedFunc = `

// ── Open Selected ────────────────────────────────────────────────────────
async function openSelected() {
  if (selectedFiles.size === 0) {
    showToast("No downloaded files selected", "warning");
    return;
  }

  const filePaths = [];
  selectedFiles.forEach((msgId) => {
    const file = currentFiles.find((f) => f.messageId === msgId);
    if (file && file.localPath) filePaths.push(file.localPath);
  });

  if (filePaths.length === 0) {
    showToast("No downloaded files selected to open", "warning");
    return;
  }

  for (const filePath of filePaths) {
    openFile(filePath);
  }
  
  selectedFiles.clear();
  renderFiles();
  updateSelectionUI();
}
`;

// insert openSelectedFunc before Download chapter
if (code.includes('// ── Download ─────────────────────────────────────────────────────────────')) {
    code = code.replace('// ── Download ─────────────────────────────────────────────────────────────', openSelectedFunc + '\n// ── Download ─────────────────────────────────────────────────────────────');
}

fs.writeFileSync('src/renderer.js', code, 'utf8');
console.log('Patch complete.');
