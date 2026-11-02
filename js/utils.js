

// IndexedDB Global Instance
let dbInstance = null;

// Toast Notifications System
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  const colors = { 
    success: 'bg-emerald-600 text-white', 
    error: 'bg-red-600 text-white', 
    info: 'bg-slate-900 text-white' 
  };

  toast.className = `px-4 py-3 rounded-xl shadow-lg text-xs font-semibold flex items-center justify-between gap-3 pointer-events-auto transform transition-all duration-300 opacity-0 translate-y-2 ${colors[type] || colors.info}`;
  toast.innerHTML = `<span>${message}</span><button onclick="this.parentElement.remove()" class="opacity-70 hover:opacity-100 text-sm font-bold">&times;</button>`;

  container.appendChild(toast);
  setTimeout(() => { toast.classList.remove('opacity-0', 'translate-y-2'); }, 10);
  setTimeout(() => { 
    toast.classList.add('opacity-0', 'translate-y-2'); 
    setTimeout(() => toast.remove(), 300); 
  }, 4000);
}

// File Blob Saver Helper
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; 
  a.download = filename;
  document.body.appendChild(a); 
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Drag & Drop Highlight Handlers
function handleDragOver(e, el) { 
  e.preventDefault(); 
  el.classList.add('drop-active'); 
}

function handleDragLeave(e, el) { 
  e.preventDefault(); 
  el.classList.remove('drop-active'); 
}

// PDF Text Item Line Grouping Algorithm
function groupPdfItemsIntoLines(items) {
  const lines = [];
  let currentLine = [];
  let lastY = null;

  const sortedItems = [...items].sort((a, b) => {
    const yDiff = b.transform[5] - a.transform[5];
    if (Math.abs(yDiff) > 3) return yDiff;
    return a.transform[4] - b.transform[4];
  });

  sortedItems.forEach(item => {
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 4) {
      if (currentLine.length > 0) lines.push(currentLine);
      currentLine = [];
    }
    currentLine.push(item);
    lastY = y;
  });

  if (currentLine.length > 0) lines.push(currentLine);
  return lines;
}

// IndexedDB Initialization and Helpers
function initIndexedDB() {
  try {
    const request = indexedDB.open('DocuCraftStudioDB', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts');
      }
    };
    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      loadSavedDrafts();
    };
  } catch (err) {
    console.warn('IndexedDB not supported or accessible:', err);
  }
}

function saveDraftToDB(key, data) {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put(data, key);
  } catch (e) { 
    console.warn('Draft save failed:', e); 
  }
}

function loadSavedDrafts() {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction('drafts', 'readonly');
    const req = tx.objectStore('drafts').get('latex-code');
    req.onsuccess = () => {
      if (req.result && window.codeMirrorEditor) {
        window.codeMirrorEditor.setValue(req.result);
      }
    };
  } catch (e) {}
}
