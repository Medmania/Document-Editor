
// Global CodeMirror reference
window.codeMirrorEditor = null;

let swiftLatexEngine = null;
let currentEngineType = 'xetex';
let isLatexEngineLoading = false;
let isLatexEngineReady = false;
let autoCompileTimer = null;
let autoCompileEnabled = false;
let compiledPdfBuffer = null;
let latexPdfZoom = 1.0;
let firstRenderedLatexPageWidth = 0;

// Default Starter LaTeX Templates
const LATEX_TEMPLATES = {
  article: `\\documentclass[11pt, a4paper]{article}\n\\usepackage{xcolor}\n\\usepackage{amsmath, amssymb}\n\\usepackage{geometry}\n\\geometry{margin=1in}\n\n\\definecolor{primary}{RGB}{37, 99, 235}\n\n\\title{\\color{primary}\\textbf{Academic Survey \\& Research Manuscript}}\n\\author{\\textbf{DocuCraft Engine} \\\\ WebAssembly TeX Suite}\n\\date{\\today}\n\n\\begin{document}\n\n\\maketitle\n\n\\begin{abstract}\nThis document illustrates client-side LaTeX compilation using WebAssembly.\n\\end{abstract}\n\n\\section{Introduction}\nBrowser-based TeX engines render PDF preview without external server calls.\n\n\\section{Mathematical Formulation}\nEuler's identity represents a key relation in complex analysis:\n\\begin{equation}\ne^{i\\pi} + 1 = 0\n\\end{equation}\n\n\\end{document}`,
  report: `\\documentclass[12pt, a4paper]{report}\n\\usepackage{xcolor}\n\\usepackage{geometry}\n\\geometry{margin=1in}\n\n\\title{\\textbf{Project Executive Report}}\n\\author{Technical Operations}\n\\date{\\today}\n\n\\begin{document}\n\n\\maketitle\n\\tableofcontents\n\n\\chapter{Executive Summary}\n\\section{Project Goals}\nProvide high-fidelity document conversion tools directly in the browser.\n\n\\end{document}`,
  letter: `\\documentclass{letter}\n\\usepackage{geometry}\n\\geometry{margin=1in}\n\n\\address{DocuCraft Studio\\\\Client Suite}\n\\signature{Lead Engineer}\n\n\\begin{document}\n\\begin{letter}{Recipient Name}\n\\opening{Dear Colleague,}\n\nThank you for utilizing our client-side document processing workspace.\n\n\\closing{Sincerely,}\n\\end{letter}\n\\end{document}`,
  beamer: `\\documentclass{beamer}\n\\usetheme{Madrid}\n\\title[DocuCraft Suite]{In-Browser LaTeX Presentations}\n\\author{Engineering Team}\n\\date{\\today}\n\n\\begin{document}\n\\frame{\\titlepage}\n\\begin{frame}\n\\frametitle{Key System Features}\n\\begin{itemize}\n    \\item 100\\% Client-Side WASM Compilation\n    \\item Instant Synchronized PDF Preview\n\\end{itemize}\n\\end{frame}\n\\end{document}`
};

function initCodeMirrorEditor() {
  const textarea = document.getElementById('latex-cm-textarea');
  if (!textarea) return;

  window.codeMirrorEditor = CodeMirror.fromTextArea(textarea, {
    mode: 'stex',
    theme: 'dracula',
    lineNumbers: true,
    matchBrackets: true,
    lineWrapping: true,
    viewportMargin: Infinity,
    extraKeys: {
      "Ctrl-Enter": () => compileLaTeX(),
      "Cmd-Enter": () => compileLaTeX()
    }
  });

  window.codeMirrorEditor.setValue(LATEX_TEMPLATES.article);
  updateLatexCharCount();

  window.codeMirrorEditor.on('change', () => {
    updateLatexCharCount();
    saveDraftToDB('latex-code', window.codeMirrorEditor.getValue());
    if (autoCompileEnabled) {
      clearTimeout(autoCompileTimer);
      autoCompileTimer = setTimeout(() => compileLaTeX(), 1500);
    }
  });
}

function updateLatexCharCount() {
  if (window.codeMirrorEditor) {
    document.getElementById('latex-char-count').innerText = `${window.codeMirrorEditor.getValue().length} chars`;
  }
}

async function initSwiftLatexEngine(engineType = currentEngineType) {
  if (isLatexEngineLoading) return;
  isLatexEngineLoading = true;
  isLatexEngineReady = false;

  const bannerText = document.getElementById('latex-engine-status-text');
  bannerText.innerText = `Initializing ${engineType === 'xetex' ? 'XeLaTeX' : 'pdfLaTeX'} WASM Engine... Downloading WebAssembly binaries.`;

  try {
    if (typeof SwiftLaTeX !== 'undefined') {
      if (engineType === 'xetex' && SwiftLaTeX.XeTeXEngine) swiftLatexEngine = new SwiftLaTeX.XeTeXEngine();
      else if (SwiftLaTeX.PdfTeXEngine) swiftLatexEngine = new SwiftLaTeX.PdfTeXEngine();
      else if (SwiftLaTeX.Engine) swiftLatexEngine = new SwiftLaTeX.Engine();

      if (swiftLatexEngine && swiftLatexEngine.loadEngine) await swiftLatexEngine.loadEngine();

      isLatexEngineReady = true;
      isLatexEngineLoading = false;
      currentEngineType = engineType;
      bannerText.innerText = `${engineType === 'xetex' ? 'XeLaTeX' : 'pdfLaTeX'} WASM Engine Ready! 100% In-Browser Compilation.`;
    } else {
      throw new Error('SwiftLaTeX library not loaded.');
    }
  } catch (err) {
    isLatexEngineLoading = false;
    isLatexEngineReady = false;
    bannerText.innerText = `TeX Engine operating in fallback compatibility mode.`;
  }
}

async function switchLatexEngine(engineType) {
  currentEngineType = engineType;
  swiftLatexEngine = null;
  await initSwiftLatexEngine(engineType);
}

async function compileLaTeX() {
  if (!window.codeMirrorEditor) return;
  const code = window.codeMirrorEditor.getValue();
  if (!code.trim()) return;

  const statusText = document.getElementById('latex-status-text');
  const logContent = document.getElementById('latex-log-content');
  const compileBtn = document.getElementById('latex-compile-btn');
  const placeholder = document.getElementById('latex-preview-placeholder');
  const loadingState = document.getElementById('latex-preview-loading');
  const canvasContainer = document.getElementById('latex-canvas-container');

  statusText.innerText = "Compiling...";
  compileBtn.disabled = true;
  placeholder.classList.add('hidden');
  canvasContainer.classList.add('hidden');
  loadingState.classList.remove('hidden');

  try {
    let pdfBytes = null;
    let compilationLog = "";

    if (swiftLatexEngine && isLatexEngineReady && typeof swiftLatexEngine.compileLaTeX === 'function') {
      if (swiftLatexEngine.writeMemFSFile) swiftLatexEngine.writeMemFSFile('main.tex', code);
      const result = await swiftLatexEngine.compileLaTeX();
      pdfBytes = result.pdfBytes || result.pdf;
      compilationLog = result.log || "Compilation complete with zero errors.\n";
    } else {
      compilationLog = "[NOTICE] Running client-side HTML layout fallback preview engine.\n" +
                       "[NOTICE] Native LaTeX packages and TikZ figures require WASM TeX binaries.\n\n";
      
      const renderContainer = document.createElement('div');
      renderContainer.className = "p-10 bg-white font-serif text-slate-900 leading-relaxed max-w-3xl mx-auto shadow-2xl";
      renderContainer.innerHTML = code.replace(/\\documentclass[\s\S]*?\\begin{document}/, '')
                                      .replace(/\\end{document}/, '')
                                      .replace(/\\section{(.*?)}/g, '<h2 class="text-xl font-bold border-b pb-1 mb-2 mt-4">$1</h2>')
                                      .replace(/\\subsection{(.*?)}/g, '<h3 class="text-lg font-semibold mb-1 mt-3">$1</h3>')
                                      .replace(/\\textbf{(.*?)}/g, '<strong>$1</strong>')
                                      .replace(/\\textit{(.*?)}/g, '<em>$1</em>');
      
      const pdfBlob = await html2pdf().set({ margin: 15 }).from(renderContainer).output('blob');
      pdfBytes = await pdfBlob.arrayBuffer();
    }

    logContent.innerText = compilationLog;

    if (pdfBytes) {
      compiledPdfBuffer = pdfBytes;
      await renderLatexPdfPreview(pdfBytes);
      statusText.innerText = "Success";
      statusText.className = "text-emerald-400 font-medium";
      document.getElementById('latex-pdf-controls').classList.remove('hidden');
    }
  } catch (err) {
    statusText.innerText = "Error";
    statusText.className = "text-red-400 font-medium";
    logContent.innerText += `\nError: ${err.message}`;
    document.getElementById('latex-log-panel').classList.remove('hidden');
  } finally {
    compileBtn.disabled = false;
    loadingState.classList.add('hidden');
  }
}

async function renderLatexPdfPreview(pdfBuffer) {
  const container = document.getElementById('latex-canvas-container');
  container.innerHTML = '';
  container.classList.remove('hidden');

  const pdf = await pdfjsLib.getDocument({ data: pdfBuffer.slice(0) }).promise;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    
    if (pageNum === 1) {
      const unscaledViewport = page.getViewport({ scale: 1.0 });
      firstRenderedLatexPageWidth = unscaledViewport.width;
    }

    const viewport = page.getViewport({ scale: latexPdfZoom });

    const canvasCard = document.createElement('div');
    canvasCard.className = "relative shadow-2xl rounded-lg overflow-hidden bg-white border border-slate-700 my-2";

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    canvasCard.appendChild(canvas);
    container.appendChild(canvasCard);
  }
}

function fitLatexPdfWidth() {
  const viewportEl = document.getElementById('latex-pdf-viewport');
  if (!viewportEl || !firstRenderedLatexPageWidth) {
    latexPdfZoom = 1.0;
  } else {
    const availableWidth = viewportEl.clientWidth - 48;
    latexPdfZoom = Math.max(0.5, Math.min(2.5, availableWidth / firstRenderedLatexPageWidth));
  }
  document.getElementById('latex-pdf-zoom-val').innerText = `${Math.round(latexPdfZoom * 100)}%`;
  if (compiledPdfBuffer) renderLatexPdfPreview(compiledPdfBuffer);
}

function changeLatexPdfZoom(delta) {
  latexPdfZoom = Math.max(0.5, Math.min(2.5, latexPdfZoom + delta));
  document.getElementById('latex-pdf-zoom-val').innerText = `${Math.round(latexPdfZoom * 100)}%`;
  if (compiledPdfBuffer) renderLatexPdfPreview(compiledPdfBuffer);
}

function downloadCompiledPdf() {
  if (compiledPdfBuffer) saveBlob(new Blob([compiledPdfBuffer], { type: 'application/pdf' }), 'Compiled-LaTeX.pdf');
}

function toggleAutoCompile(enabled) { autoCompileEnabled = enabled; }

function loadLatexTemplate(key) { 
  if (LATEX_TEMPLATES[key] && window.codeMirrorEditor) { 
    window.codeMirrorEditor.setValue(LATEX_TEMPLATES[key]); 
    compileLaTeX(); 
  } 
}

function handleLatexFileUpload(e) { 
  const file = e.target.files[0]; 
  if (file) { 
    const reader = new FileReader(); 
    reader.onload = (evt) => { 
      if (window.codeMirrorEditor) window.codeMirrorEditor.setValue(evt.target.result); 
      compileLaTeX(); 
    }; 
    reader.readAsText(file); 
  } 
}

function downloadLatexFile() { 
  if (window.codeMirrorEditor) {
    saveBlob(new Blob([window.codeMirrorEditor.getValue()], { type: 'text/x-tex' }), 'document.tex'); 
  }
}

function clearLatexEditor() { 
  if (window.codeMirrorEditor) window.codeMirrorEditor.setValue(''); 
  document.getElementById('latex-canvas-container').innerHTML = ''; 
  compiledPdfBuffer = null; 
}

function toggleCompilerLog() { 
  document.getElementById('latex-log-panel').classList.toggle('hidden'); 
}

function initResizableSplitPane() {
  const resizer = document.getElementById('latex-resizer');
  const leftPanel = document.getElementById('latex-editor-panel');
  const container = document.getElementById('latex-split-container');
  if (!resizer || !leftPanel || !container) return;
  
  let isDragging = false;

  resizer.addEventListener('mousedown', () => { isDragging = true; resizer.classList.add('dragging'); });
  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = container.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    if (pct >= 20 && pct <= 80) leftPanel.style.width = `${pct}%`;
  });
  window.addEventListener('mouseup', () => { isDragging = false; resizer.classList.remove('dragging'); });
}
