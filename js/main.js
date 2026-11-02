

// Global App State Variables
window.currentLoadedFileName = "Document";

// Configure PDF.js Worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// Global DOM Initialization
window.addEventListener('DOMContentLoaded', () => {
  initQuillEditor();
  initSortableGrid();
  initCodeMirrorEditor();
  initResizableSplitPane();
  initVisualFabricCanvas();
  initIndexedDB();
  setupKeyboardShortcuts();
});

// Main Tab Navigation Switcher
function switchTab(tabId) {
  const tabs = ['pdf-editor', 'editor', 'converter', 'organizer', 'latex'];
  tabs.forEach(tab => {
    const btn = document.getElementById(`tab-${tab}-btn`);
    const sectionId = tab === 'pdf-editor' ? 'tab-pdf-editor' : tab === 'editor' ? 'tab-flow-editor' : tab === 'converter' ? 'tab-pdf-converter' : tab === 'organizer' ? 'tab-page-organizer' : 'tab-latex-studio';
    const section = document.getElementById(sectionId);
    if (tabId.includes(tab)) {
      btn.className = "px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg transition-all text-brand-600 bg-white shadow-sm whitespace-nowrap";
      section.classList.remove('hidden');
      if (tab === 'latex') {
        setTimeout(() => { 
          if (window.codeMirrorEditor) window.codeMirrorEditor.refresh(); 
          initSwiftLatexEngine(); 
        }, 100);
      }
    } else {
      btn.className = "px-3.5 py-2 text-xs md:text-sm font-semibold rounded-lg transition-all text-slate-600 hover:text-slate-900 whitespace-nowrap";
      section.classList.add('hidden');
    }
  });
}

// Global Keyboard Shortcuts (Guarded)
function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    // Guard 1: Must be in Visual Editor Tab
    const vTab = document.getElementById('tab-pdf-editor');
    if (!vTab || vTab.classList.contains('hidden')) return;

    // Guard 2: Ignore typing inside text inputs, textareas, contenteditables
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
      return;
    }

    // Guard 3: Ignore if Fabric object is in inline edit mode
    const activeObj = typeof vFabricCanvas !== 'undefined' && vFabricCanvas ? vFabricCanvas.getActiveObject() : null;
    if (activeObj && activeObj.isEditing) return;

    // Undo: Ctrl+Z / Cmd+Z
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoVisualState();
    }
    // Redo: Ctrl+Y / Cmd+Y / Ctrl+Shift+Z
    if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') || ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'z')) {
      e.preventDefault();
      redoVisualState();
    }
    // Delete Object
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (activeObj && !activeObj.isEditing) {
        e.preventDefault();
        deleteSelectedVisualObject();
      }
    }
  });
}
