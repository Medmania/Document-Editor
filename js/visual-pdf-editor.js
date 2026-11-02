/**
 * js/visual-pdf-editor.js
 * Visual PDF Editor with True Text Editing & Immediate White-Out Engine
 */

// ====================== STATE ======================
let vPdfDocument = null;
let vOriginalBuffer = null;
let vPagesData = []; // { pageNum, fabricJson, width, height, pdfPageWidth, pdfPageHeight, whiteoutRects }
let vCurrentPageNum = 1;
let vFabricCanvas = null;
let vZoomScale = 1.0;
let vEditMode = 'edit-text'; // 'edit-text' | 'annotate'
let vCurrentTool = 'select';
let vCurrentColor = '#0f172a';
let vCurrentFontSize = 18;
let vUndoStack = [];
let vRedoStack = [];
let ocrWorker = null;
let isOcrRunning = false;

// ====================== INIT ======================
function initVisualFabricCanvas() {
  vFabricCanvas = new fabric.Canvas('pdf-v-fabric-canvas', {
    selection: true,
    preserveObjectStacking: true
  });

  vFabricCanvas.on('object:modified', (e) => {
    if (e.target?.isOriginalText) markOriginalTextAsModified(e.target);
    pushVisualHistory();
  });

  vFabricCanvas.on('object:added', (e) => {
    if (e.target && !e.target.isBackground) pushVisualHistory();
  });

  vFabricCanvas.on('text:changed', (e) => {
    if (e.target?.isOriginalText) markOriginalTextAsModified(e.target);
  });

  vFabricCanvas.on('object:removed', (e) => {
    if (e.target?.isOriginalText) markOriginalTextAsModified(e.target);
  });
}

// ====================== HELPERS ======================
function markOriginalTextAsModified(textObj) {
  const pageData = vPagesData[vCurrentPageNum - 1];
  if (!pageData || !textObj?.originalBounds) return;

  const bounds = textObj.originalBounds;
  const exists = pageData.whiteoutRects.some(r => r.id === bounds.id);
  if (!exists) {
    pageData.whiteoutRects.push({ ...bounds });
    textObj.isModified = true;
  }
}

function pushVisualHistory() {
  if (!vFabricCanvas) return;
  const json = JSON.stringify(vFabricCanvas.toJSON([
    'isOriginalText', 'originalText', 'originalBounds', 'isOcrText', 'ocrConfidence', 'isModified'
  ]));
  if (vUndoStack.length === 0 || vUndoStack[vUndoStack.length - 1] !== json) {
    vUndoStack.push(json);
    if (vUndoStack.length > 30) vUndoStack.shift();
    vRedoStack = [];
  }
}

function undoVisualState() {
  if (vUndoStack.length > 1) {
    vRedoStack.push(vUndoStack.pop());
    vFabricCanvas.loadFromJSON(vUndoStack[vUndoStack.length - 1], () => vFabricCanvas.renderAll());
  }
}

function redoVisualState() {
  if (vRedoStack.length > 0) {
    const state = vRedoStack.pop();
    vUndoStack.push(state);
    vFabricCanvas.loadFromJSON(state, () => vFabricCanvas.renderAll());
  }
}

// ====================== LOAD PDF ======================
async function loadVisualPdfFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > 25 * 1024 * 1024) {
    showToast('Large file detected. Lowering scale for better performance.', 'info');
    vZoomScale = 0.8;
  }

  window.currentLoadedFileName = file.name.replace(/\.[^/.]+$/, "");
  showToast(`Loading "${file.name}"...`, 'info');

  try {
    vOriginalBuffer = await file.arrayBuffer();
    vPdfDocument = await pdfjsLib.getDocument({ data: vOriginalBuffer.slice(0) }).promise;

    vPagesData = [];
    for (let i = 1; i <= vPdfDocument.numPages; i++) {
      vPagesData.push({
        pageNum: i,
        fabricJson: null,
        width: 0,
        height: 0,
        pdfPageWidth: 0,
        pdfPageHeight: 0,
        whiteoutRects: []
      });
    }

    vCurrentPageNum = 1;
    vUndoStack = [];
    vRedoStack = [];

    document.getElementById('pdf-editor-upload-zone').classList.add('hidden');
    document.getElementById('pdf-editor-workspace').classList.remove('hidden');

    await renderVisualPageThumbnails();
    await loadVisualPage(1);

    showToast('PDF loaded! Mode: Edit Original Text', 'success');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    event.target.value = '';
  }
}

function handleVisualPdfDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('drop-active');
  const file = event.dataTransfer.files[0];
  if (file?.type === 'application/pdf') {
    loadVisualPdfFile({ target: { files: [file] } });
  } else {
    showToast('Please drop a valid PDF file.', 'error');
  }
}

// ====================== THUMBNAILS ======================
async function renderVisualPageThumbnails() {
  const sidebar = document.getElementById('v-thumbnails-sidebar');
  sidebar.innerHTML = '';

  for (let i = 1; i <= vPdfDocument.numPages; i++) {
    const page = await vPdfDocument.getPage(i);
    const viewport = page.getViewport({ scale: 0.18 });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const wrapper = document.createElement('div');
    wrapper.className = `p-1.5 rounded-xl border cursor-pointer transition-all text-center space-y-1 ${
      i === vCurrentPageNum ? 'border-brand-600 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300 bg-white'
    }`;
    wrapper.onclick = () => changeVisualPageTo(i);

    const img = document.createElement('img');
    img.src = canvas.toDataURL();
    img.className = 'w-full h-auto rounded-lg shadow-sm';

    const label = document.createElement('span');
    label.className = 'text-[10px] font-semibold text-slate-500 block';
    label.innerText = `Page ${i}`;

    wrapper.appendChild(img);
    wrapper.appendChild(label);
    sidebar.appendChild(wrapper);

    canvas.width = 0;
    canvas.height = 0;
  }
}

// ====================== PAGE LOADING ======================
async function saveCurrentVisualPageState() {
  if (vFabricCanvas && vPagesData[vCurrentPageNum - 1]) {
    vPagesData[vCurrentPageNum - 1].fabricJson = vFabricCanvas.toJSON([
      'isOriginalText', 'originalText', 'originalBounds', 'isOcrText', 'ocrConfidence', 'isModified'
    ]);
  }
}

async function loadVisualPage(pageNum) {
  if (!vPdfDocument) return;

  await saveCurrentVisualPageState();
  vCurrentPageNum = pageNum;
  document.getElementById('v-page-indicator').innerText = `Page ${pageNum} of ${vPdfDocument.numPages}`;

  const page = await vPdfDocument.getPage(pageNum);
  const unscaledViewport = page.getViewport({ scale: 1.0 });
  const viewportScale = 1.5 * vZoomScale;
  const viewport = page.getViewport({ scale: viewportScale });

  const pageData = vPagesData[pageNum - 1];
  pageData.width = viewport.width;
  pageData.height = viewport.height;
  pageData.pdfPageWidth = unscaledViewport.width;
  pageData.pdfPageHeight = unscaledViewport.height;

  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = viewport.width;
  bgCanvas.height = viewport.height;
  const bgCtx = bgCanvas.getContext('2d');
  await page.render({ canvasContext: bgCtx, viewport }).promise;

  vFabricCanvas.clear();
  vFabricCanvas.setWidth(viewport.width);
  vFabricCanvas.setHeight(viewport.height);

  if (pageData.fabricJson) {
    // Restore previously edited page
    fabric.Image.fromURL(bgCanvas.toDataURL(), (img) => {
      vFabricCanvas.setBackgroundImage(img, () => {
        vFabricCanvas.loadFromJSON(pageData.fabricJson, () => {
          applyEditModeStyles();
          vFabricCanvas.renderAll();
        });
      });
      bgCanvas.width = 0;
      bgCanvas.height = 0;
    });
  } else {
    // First time → extract text + immediate white-out
    await extractAndOverlayOriginalText(page, viewport, unscaledViewport, bgCtx, bgCanvas);
  }
}

// ====================== CORE: TEXT EXTRACTION + IMMEDIATE WHITE-OUT ======================
async function extractAndOverlayOriginalText(page, viewport, unscaledViewport, bgCtx, bgCanvas) {
  const textContent = await page.getTextContent();
  const pageData = vPagesData[vCurrentPageNum - 1];

  if (!textContent.items || textContent.items.length === 0) {
    fabric.Image.fromURL(bgCanvas.toDataURL(), (img) => {
      vFabricCanvas.setBackgroundImage(img, vFabricCanvas.renderAll.bind(vFabricCanvas));
      bgCanvas.width = 0;
      bgCanvas.height = 0;
    });
    showToast('Scanned page detected. Use "OCR Page" button.', 'info');
    return;
  }

  const lines = groupPdfItemsIntoLines(textContent.items);
  const fabricTextObjects = [];

  lines.forEach((lineItems, index) => {
    const lineText = lineItems.map(i => i.str).join(' ').trim();
    if (!lineText) return;

    const firstItem = lineItems[0];
    const tx = pdfjsLib.Util.transform(viewport.transform, firstItem.transform);
    const fontScale = Math.sqrt(firstItem.transform[0] ** 2 + firstItem.transform[1] ** 2);
    const canvasFontSize = fontScale * viewport.scale;
    const pdfFontSize = fontScale;

    const lineCanvasWidth = lineItems.reduce((sum, item) => sum + (item.width || 0) * viewport.scale, 0);
    const linePdfWidth = lineItems.reduce((sum, item) => sum + (item.width || 0), 0);

    const canvasLeft = tx[4];
    const canvasTop = tx[5] - canvasFontSize * 0.85;
    const lineCanvasHeight = canvasFontSize * 1.3;

    // === IMMEDIATE VISUAL WHITE-OUT (kills ghosting) ===
    bgCtx.fillStyle = '#ffffff';
    bgCtx.fillRect(
      Math.floor(canvasLeft - 3),
      Math.floor(canvasTop - 3),
      Math.ceil(lineCanvasWidth + 6),
      Math.ceil(lineCanvasHeight + 6)
    );

    // PDF space coordinates (bottom-left origin)
    const pdfX = firstItem.transform[4];
    const pdfY = firstItem.transform[5] - pdfFontSize * 0.25;

    const boundsId = `b-p${vCurrentPageNum}-l${index}-${Math.random().toString(36).slice(2, 7)}`;
    const originalBounds = {
      id: boundsId,
      pdfX: Math.max(0, pdfX - 2),
      pdfY: Math.max(0, pdfY - 2.5),
      pdfW: (linePdfWidth || 80) + 4,
      pdfH: pdfFontSize * 1.35 + 5
    };

    pageData.whiteoutRects.push(originalBounds);

    const textObj = new fabric.IText(lineText, {
      left: canvasLeft,
      top: canvasTop,
      fontSize: canvasFontSize || 14,
      fill: '#0f172a',
      fontFamily: 'Helvetica, Arial, sans-serif',
      isOriginalText: true,
      originalText: lineText,
      originalBounds: originalBounds,
      stroke: vEditMode === 'edit-text' ? '#2563eb' : '',
      strokeWidth: vEditMode === 'edit-text' ? 0.6 : 0,
      padding: 2,
      cornerColor: '#2563eb',
      cornerSize: 7,
      transparentCorners: false
    });

    fabricTextObjects.push(textObj);
  });

  // Set background (already whitened) + add editable text
  fabric.Image.fromURL(bgCanvas.toDataURL(), (img) => {
    vFabricCanvas.setBackgroundImage(img, () => {
      fabricTextObjects.forEach(obj => vFabricCanvas.add(obj));
      applyEditModeStyles();
      vFabricCanvas.renderAll();
      pushVisualHistory();
    });
    bgCanvas.width = 0;
    bgCanvas.height = 0;
  });
}

// ====================== MODE & TOOLS ======================
function setVisualEditMode(mode) {
  vEditMode = mode;

  const editBtn = document.getElementById('v-mode-edit');
  const annotateBtn = document.getElementById('v-mode-annotate');

  if (editBtn && annotateBtn) {
    editBtn.className = mode === 'edit-text'
      ? "px-2.5 py-1 text-xs font-semibold rounded-lg text-brand-600 bg-white shadow-sm flex items-center gap-1.5"
      : "px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 flex items-center gap-1.5";

    annotateBtn.className = mode === 'annotate'
      ? "px-2.5 py-1 text-xs font-semibold rounded-lg text-brand-600 bg-white shadow-sm flex items-center gap-1.5"
      : "px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 flex items-center gap-1.5";
  }

  if (mode === 'edit-text' && vFabricCanvas.isDrawingMode) {
    setVisualTool('select');
  }

  applyEditModeStyles();
}

function applyEditModeStyles() {
  vFabricCanvas.getObjects().forEach(obj => {
    if (obj.isOriginalText) {
      obj.set({
        stroke: vEditMode === 'edit-text' ? '#2563eb' : '',
        strokeWidth: vEditMode === 'edit-text' ? 0.6 : 0,
        selectable: true,
        hoverCursor: vEditMode === 'edit-text' ? 'text' : 'move'
      });
    }
  });
  vFabricCanvas.renderAll();
}

function setVisualTool(tool) {
  vCurrentTool = tool;
  vFabricCanvas.isDrawingMode = false;

  if (tool === 'pen') {
    if (vEditMode === 'edit-text') setVisualEditMode('annotate');
    vFabricCanvas.isDrawingMode = true;
    vFabricCanvas.freeDrawingBrush.color = vCurrentColor;
    vFabricCanvas.freeDrawingBrush.width = 3;
  } else if (tool === 'highlight') {
    if (vEditMode === 'edit-text') setVisualEditMode('annotate');
    vFabricCanvas.isDrawingMode = true;
    vFabricCanvas.freeDrawingBrush.color = 'rgba(255, 235, 59, 0.45)';
    vFabricCanvas.freeDrawingBrush.width = 18;
  }
}

function addVisualText() {
  setVisualTool('select');
  const text = new fabric.IText('New Text', {
    left: 80,
    top: 80,
    fontSize: parseInt(vCurrentFontSize),
    fill: vCurrentColor,
    fontFamily: 'Inter, sans-serif'
  });
  vFabricCanvas.add(text);
  vFabricCanvas.setActiveObject(text);
}

function addVisualRect() {
  setVisualTool('select');
  const rect = new fabric.Rect({
    left: 80,
    top: 80,
    width: 140,
    height: 90,
    fill: 'transparent',
    stroke: vCurrentColor,
    strokeWidth: 2
  });
  vFabricCanvas.add(rect);
  vFabricCanvas.setActiveObject(rect);
}

function addVisualImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    fabric.Image.fromURL(e.target.result, (img) => {
      img.scaleToWidth(180);
      img.set({ left: 100, top: 100 });
      vFabricCanvas.add(img);
      vFabricCanvas.setActiveObject(img);
    });
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function updateVisualColor(color) {
  vCurrentColor = color;
  const active = vFabricCanvas.getActiveObject();
  if (active) {
    active.set('fill', color);
    if (active.stroke && !active.isOriginalText) active.set('stroke', color);
    vFabricCanvas.renderAll();
  }
}

function updateVisualFontSize(size) {
  vCurrentFontSize = size;
  const active = vFabricCanvas.getActiveObject();
  if (active?.type === 'i-text') {
    active.set('fontSize', parseInt(size));
    vFabricCanvas.renderAll();
  }
}

function deleteSelectedVisualObject() {
  const active = vFabricCanvas.getActiveObject();
  if (active) {
    if (active.isOriginalText) markOriginalTextAsModified(active);
    vFabricCanvas.remove(active);
    vFabricCanvas.renderAll();
    pushVisualHistory();
  }
}

// ====================== NAVIGATION & ZOOM ======================
async function changeVisualPage(delta) {
  const next = vCurrentPageNum + delta;
  if (next >= 1 && next <= vPdfDocument.numPages) await loadVisualPage(next);
}

async function changeVisualPageTo(pageNum) {
  if (pageNum >= 1 && pageNum <= vPdfDocument.numPages && pageNum !== vCurrentPageNum) {
    await loadVisualPage(pageNum);
  }
}

function zoomVisualCanvas(delta) {
  vZoomScale = Math.max(0.5, Math.min(2.5, vZoomScale + delta));
  document.getElementById('v-zoom-indicator').innerText = `${Math.round(vZoomScale * 100)}%`;
  loadVisualPage(vCurrentPageNum);
}

// ====================== OCR ======================
async function runOCR() {
  if (isOcrRunning || !vPdfDocument) return;

  const banner = document.getElementById('ocr-progress-banner');
  const statusText = document.getElementById('ocr-status-text');
  banner.classList.remove('hidden');
  isOcrRunning = true;

  try {
    statusText.innerText = 'Preparing page for OCR...';
    const page = await vPdfDocument.getPage(vCurrentPageNum);
    const ocrScale = 2.0;
    const viewport = page.getViewport({ scale: ocrScale });

    const cleanCanvas = document.createElement('canvas');
    cleanCanvas.width = viewport.width;
    cleanCanvas.height = viewport.height;
    await page.render({ canvasContext: cleanCanvas.getContext('2d'), viewport }).promise;

    if (!ocrWorker) {
      statusText.innerText = 'Loading Tesseract engine...';
      ocrWorker = await Tesseract.createWorker('eng');
    }

    statusText.innerText = `OCR running on page ${vCurrentPageNum}...`;
    const blob = await new Promise(r => cleanCanvas.toBlob(r, 'image/png'));
    const result = await ocrWorker.recognize(blob);

    cleanCanvas.width = 0;
    cleanCanvas.height = 0;

    const scaleRatio = (1.5 * vZoomScale) / ocrScale;
    let count = 0;

    result.data.words.forEach(word => {
      if (word.text.trim() && word.confidence > 35) {
        count++;
        const textObj = new fabric.IText(word.text, {
          left: word.bbox.x0 * scaleRatio,
          top: word.bbox.y0 * scaleRatio,
          fontSize: Math.max(11, (word.bbox.y1 - word.bbox.y0) * scaleRatio),
          fill: '#0f172a',
          fontFamily: 'Inter, sans-serif',
          isOcrText: true,
          backgroundColor: 'rgba(224, 231, 255, 0.65)'
        });
        vFabricCanvas.add(textObj);
      }
    });

    vFabricCanvas.renderAll();
    pushVisualHistory();
    showToast(`OCR finished — ${count} words added`, 'success');
  } catch (err) {
    showToast('OCR Error: ' + err.message, 'error');
  } finally {
    isOcrRunning = false;
    banner.classList.add('hidden');
  }
}

async function cancelOCR() {
  if (ocrWorker) {
    try { await ocrWorker.terminate(); } catch (e) {}
    ocrWorker = null;
  }
  isOcrRunning = false;
  document.getElementById('ocr-progress-banner').classList.add('hidden');
  showToast('OCR cancelled', 'info');
}

// ====================== EXPORT ======================
async function exportVisualEditedPdf() {
  if (!vOriginalBuffer) return;
  await saveCurrentVisualPageState();

  try {
    showToast('Exporting PDF...', 'info');
    const pdfDoc = await PDFLib.PDFDocument.load(vOriginalBuffer.slice(0));

    for (let i = 0; i < vPagesData.length; i++) {
      const pageData = vPagesData[i];
      const page = pdfDoc.getPages()[i];

      // 1. Vector white-out
      if (pageData.whiteoutRects?.length) {
        pageData.whiteoutRects.forEach(rect => {
          page.drawRectangle({
            x: rect.pdfX,
            y: rect.pdfY,
            width: rect.pdfW,
            height: rect.pdfH,
            color: PDFLib.rgb(1, 1, 1),
            borderWidth: 0
          });
        });
      }

      // 2. High-DPI overlay
      if (pageData.fabricJson?.objects?.length) {
        const exportScale = 2.5;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = pageData.pdfPageWidth * exportScale;
        tempCanvas.height = pageData.pdfPageHeight * exportScale;

        const tempFabric = new fabric.StaticCanvas(tempCanvas, {
          viewportTransform: [exportScale, 0, 0, exportScale, 0, 0]
        });

        await new Promise(resolve => {
          tempFabric.loadFromJSON(pageData.fabricJson, async () => {
            tempFabric.setBackgroundImage(null, tempFabric.renderAll.bind(tempFabric));

            tempFabric.getObjects().forEach(o => {
              if (o.isOriginalText) o.set({ strokeWidth: 0, stroke: '' });
            });

            tempFabric.renderAll();

            const pngImage = await pdfDoc.embedPng(tempCanvas.toDataURL('image/png'));
            const { width, height } = page.getSize();
            page.drawImage(pngImage, { x: 0, y: 0, width, height });

            tempCanvas.width = 0;
            tempCanvas.height = 0;
            resolve();
          });
        });
      }
    }

    const pdfBytes = await pdfDoc.save();
    saveBlob(new Blob([pdfBytes], { type: 'application/pdf' }), `${window.currentLoadedFileName || 'Edited'}-visual.pdf`);
    showToast('PDF exported successfully!', 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}

function closeVisualEditor() {
  document.getElementById('pdf-editor-workspace').classList.add('hidden');
  document.getElementById('pdf-editor-upload-zone').classList.remove('hidden');
  if (vFabricCanvas) vFabricCanvas.clear();
  vPdfDocument = null;
  vOriginalBuffer = null;
  vPagesData = [];
}
