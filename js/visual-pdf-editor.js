/**
 * js/visual-pdf-editor.js
 * Visual PDF Editor Engine powered by Fabric.js, PDF.js, pdf-lib, and Tesseract OCR.
 * 
 * --- ORIGINAL TEXT EDITING & WHITE-OUT ARCHITECTURE ---
 * 1. Extraction: PDF.js `getTextContent()` extracts raw glyph strings and transform matrices.
 * 2. Grouping: `groupPdfItemsIntoLines` clusters glyphs by Y-level and X-proximity into logical text lines.
 * 3. Positioning & Scaling: Matrices map baseline coordinates into canvas space. Bounding boxes
 *    are recorded simultaneously in unscaled PDF Document Space (points, bottom-left origin) and
 *    stored in `originalBounds`.
 * 4. Inline Editing & White-Out Tracking: When an original text Fabric.IText object is edited,
 *    moved, transformed, or deleted, `markOriginalTextAsModified` captures its exact initial unscaled
 *    PDF bounding box with a 1.5pt protective margin into `pageData.whiteoutRects`.
 * 5. Clean PDF-Lib Export: On export, pdf-lib FIRST draws filled white rectangles over all whited-out 
 *    regions directly on the native PDF page streams. Canvas overlays (edited text, annotations, shapes)
 *    are rendered at high DPI (2.0x scale) and drawn on top, ensuring old text is completely erased.
 */

// Visual PDF Editor State Variables
let vPdfDocument = null;
let vOriginalBuffer = null;
let vPagesData = []; // Array of { pageNum, fabricJson, width, height, pdfPageWidth, pdfPageHeight, whiteoutRects: [] }
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

/**
 * Initializes the interactive Fabric.js canvas and binds state listeners.
 */
function initVisualFabricCanvas() {
  vFabricCanvas = new fabric.Canvas('pdf-v-fabric-canvas', {
    selection: true,
    preserveObjectStacking: true
  });

  // Event Listeners for Undo/Redo & Real-Time Modification Tracking
  vFabricCanvas.on('object:modified', (e) => {
    if (e.target && e.target.isOriginalText) {
      markOriginalTextAsModified(e.target);
    }
    pushVisualHistory();
  });

  vFabricCanvas.on('object:added', (e) => {
    if (e.target && !e.target.isBackground) pushVisualHistory();
  });

  vFabricCanvas.on('text:changed', (e) => {
    const obj = e.target;
    if (obj && obj.isOriginalText) {
      markOriginalTextAsModified(obj);
    }
  });

  vFabricCanvas.on('object:removed', (e) => {
    const obj = e.target;
    if (obj && obj.isOriginalText) {
      markOriginalTextAsModified(obj);
    }
  });
}

/**
 * Registers an original text object's region for white-out erasure on PDF export.
 */
function markOriginalTextAsModified(textObj) {
  const pageData = vPagesData[vCurrentPageNum - 1];
  if (!pageData || !textObj || !textObj.originalBounds) return;

  const bounds = textObj.originalBounds;
  const exists = pageData.whiteoutRects.some(r => r.id === bounds.id);
  
  if (!exists) {
    pageData.whiteoutRects.push({
      id: bounds.id,
      pdfX: bounds.pdfX,
      pdfY: bounds.pdfY,
      pdfW: bounds.pdfW,
      pdfH: bounds.pdfH
    });
    textObj.isModified = true;
  }
}

/**
 * Handles Drag and Drop PDF import.
 */
function handleVisualPdfDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('drop-active');
  const file = event.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    loadVisualPdfFile({ target: { files: [file] } });
  } else {
    showToast('Please drop a valid PDF file.', 'error');
  }
}

/**
 * Loads a selected PDF file into the visual editor memory.
 */
async function loadVisualPdfFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > 25 * 1024 * 1024) {
    showToast('Large file (>25MB). Lowering viewport scale to optimize performance.', 'info');
    vZoomScale = 0.8;
  }

  window.currentLoadedFileName = file.name.replace(/\.[^/.]+$/, "");
  showToast(`Loading "${file.name}"...`, 'info');

  try {
    if (vOriginalBuffer) vOriginalBuffer = null;
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

    showToast('PDF loaded! Active mode: Edit Original Text.', 'success');
  } catch (err) {
    showToast('Error opening PDF: ' + err.message, 'error');
  } finally {
    event.target.value = '';
  }
}

/**
 * Renders page thumbnails in the sidebar.
 */
async function renderVisualPageThumbnails() {
  const sidebar = document.getElementById('v-thumbnails-sidebar');
  sidebar.innerHTML = '';

  for (let i = 1; i <= vPdfDocument.numPages; i++) {
    const page = await vPdfDocument.getPage(i);
    const viewport = page.getViewport({ scale: 0.18 });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const wrapper = document.createElement('div');
    wrapper.className = `p-1.5 rounded-xl border cursor-pointer transition-all text-center space-y-1 ${
      i === vCurrentPageNum ? 'border-brand-600 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300 bg-white'
    }`;
    wrapper.onclick = () => changeVisualPageTo(i);

    const img = document.createElement('img');
    img.src = canvas.toDataURL();
    img.className = "w-full h-auto rounded-lg shadow-sm";

    const label = document.createElement('span');
    label.className = "text-[10px] font-semibold text-slate-500 block";
    label.innerText = `Page ${i}`;

    wrapper.appendChild(img);
    wrapper.appendChild(label);
    sidebar.appendChild(wrapper);

    // Clean memory
    canvas.width = 0; 
    canvas.height = 0;
  }
}

/**
 * Saves current canvas state to memory array before navigating pages.
 */
async function saveCurrentVisualPageState() {
  if (vFabricCanvas && vPagesData[vCurrentPageNum - 1]) {
    vPagesData[vCurrentPageNum - 1].fabricJson = vFabricCanvas.toJSON([
      'isOriginalText', 'originalText', 'originalBounds', 'isOcrText', 'ocrConfidence', 'isModified'
    ]);
  }
}

/**
 * Loads and renders a specific PDF page onto the Fabric canvas.
 */
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

  // Render Background PDF Canvas Image
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = viewport.width;
  bgCanvas.height = viewport.height;
  const ctx = bgCanvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  vFabricCanvas.clear();
  vFabricCanvas.setWidth(viewport.width);
  vFabricCanvas.setHeight(viewport.height);

  fabric.Image.fromURL(bgCanvas.toDataURL(), (img) => {
    vFabricCanvas.setBackgroundImage(img, vFabricCanvas.renderAll.bind(vFabricCanvas), { scaleX: 1, scaleY: 1 });

    if (pageData.fabricJson) {
      vFabricCanvas.loadFromJSON(pageData.fabricJson, () => {
        applyEditModeStyles();
        vFabricCanvas.renderAll();
      });
    } else {
      extractAndOverlayOriginalText(page, viewport, unscaledViewport);
    }

    // Canvas memory cleanup
    bgCanvas.width = 0; 
    bgCanvas.height = 0;
  });
}

/**
 * ACCURATE TEXT EXTRACTION & FABRIC OVERLAY
 * Parses glyph position matrices and maps them precisely into both Fabric Canvas space
 * and unscaled PDF Document Space (Points, bottom-left origin).
 */
async function extractAndOverlayOriginalText(page, viewport, unscaledViewport) {
  const textContent = await page.getTextContent();

  if (!textContent.items || textContent.items.length === 0) {
    showToast('Scanned or image-only page detected! Click "OCR Page" to extract editable text.', 'info');
    return;
  }

  const lines = groupPdfItemsIntoLines(textContent.items);
  const pdfHeight = unscaledViewport.height;

  lines.forEach((lineItems, index) => {
    const lineText = lineItems.map(i => i.str).join(' ');
    if (!lineText.trim()) return;

    const firstItem = lineItems[0];
    
    // Matrix transformation for viewport scaling
    const tx = pdfjsLib.Util.transform(viewport.transform, firstItem.transform);
    const fontScale = Math.sqrt(firstItem.transform[0] * firstItem.transform[0] + firstItem.transform[1] * firstItem.transform[1]);
    const canvasFontSize = fontScale * viewport.scale;
    const pdfFontSize = fontScale;

    // Calculate line bounding dimensions
    const lineCanvasWidth = lineItems.reduce((acc, item) => acc + ((item.width || 0) * viewport.scale), 0);
    const linePdfWidth = lineItems.reduce((acc, item) => acc + (item.width || 0), 0);
    const linePdfHeight = pdfFontSize * 1.25;

    // Unscaled PDF Space Coordinates (Points, bottom-left origin)
    const pdfX = firstItem.transform[4];
    const pdfY = firstItem.transform[5] - (pdfFontSize * 0.25); // Include descent buffer

    // Canvas Top-Left Position
    const canvasLeft = tx[4];
    const canvasTop = tx[5] - (canvasFontSize * 0.85); // Align ascent to top-left

    const boundsId = `bound-p${vCurrentPageNum}-line${index}-${Math.random().toString(36).substring(2, 8)}`;
    
    // Unscaled PDF Bounding Box with protective margin for white-out
    const originalBounds = {
      id: boundsId,
      pdfX: Math.max(0, pdfX - 1.5),
      pdfY: Math.max(0, pdfY - 2.0),
      pdfW: (linePdfWidth > 0 ? linePdfWidth : 80) + 3.0,
      pdfH: linePdfHeight + 4.0
    };

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
      strokeWidth: vEditMode === 'edit-text' ? 0.5 : 0,
      padding: 2,
      cornerColor: '#2563eb',
      cornerSize: 6,
      transparentCorners: false
    });

    vFabricCanvas.add(textObj);
  });

  vFabricCanvas.renderAll();
  pushVisualHistory();
}

/**
 * Toggles visual highlight outlines depending on active mode.
 */
function setVisualEditMode(mode) {
  vEditMode = mode;
  document.getElementById('v-mode-edit').className = mode === 'edit-text' 
    ? "px-2.5 py-1 text-xs font-semibold rounded-lg text-brand-600 bg-white shadow-sm flex items-center gap-1.5" 
    : "px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 flex items-center gap-1.5";
  
  document.getElementById('v-mode-annotate').className = mode === 'annotate' 
    ? "px-2.5 py-1 text-xs font-semibold rounded-lg text-brand-600 bg-white shadow-sm flex items-center gap-1.5" 
    : "px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 flex items-center gap-1.5";

  if (mode === 'edit-text' && vFabricCanvas.isDrawingMode) {
    setVisualTool('select');
  }

  applyEditModeStyles();
}

/**
 * Applies subtle outline styling to original PDF text objects in Edit Mode.
 */
function applyEditModeStyles() {
  vFabricCanvas.getObjects().forEach(obj => {
    if (obj.isOriginalText) {
      obj.set({ 
        stroke: vEditMode === 'edit-text' ? '#2563eb' : '', 
        strokeWidth: vEditMode === 'edit-text' ? 0.5 : 0, 
        selectable: vEditMode === 'edit-text' || vCurrentTool === 'select',
        hoverCursor: vEditMode === 'edit-text' ? 'text' : 'move'
      });
    }
  });
  vFabricCanvas.renderAll();
}

/**
 * Runs Tesseract.js OCR on scanned image PDF pages.
 */
async function runOCR() {
  if (isOcrRunning) return;
  if (!vPdfDocument) {
    showToast('Please load a PDF document first.', 'error');
    return;
  }

  const banner = document.getElementById('ocr-progress-banner');
  const statusText = document.getElementById('ocr-status-text');
  banner.classList.remove('hidden');
  isOcrRunning = true;

  try {
    statusText.innerText = "Rendering page image for Tesseract OCR...";
    const page = await vPdfDocument.getPage(vCurrentPageNum);
    const ocrScale = 2.0;
    const viewport = page.getViewport({ scale: ocrScale });

    const cleanCanvas = document.createElement('canvas');
    cleanCanvas.width = viewport.width;
    cleanCanvas.height = viewport.height;
    const ctx = cleanCanvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    if (!ocrWorker) {
      statusText.innerText = "Loading Tesseract.js WASM OCR binaries...";
      ocrWorker = await Tesseract.createWorker('eng');
    }

    statusText.innerText = `Recognizing glyphs on page ${vCurrentPageNum}...`;
    const imageBlob = await new Promise(resolve => cleanCanvas.toBlob(resolve, 'image/png'));
    const ret = await ocrWorker.recognize(imageBlob);

    cleanCanvas.width = 0; 
    cleanCanvas.height = 0;

    const currentCanvasScale = 1.5 * vZoomScale;
    const scaleRatio = currentCanvasScale / ocrScale;

    let addedCount = 0;
    if (ret && ret.data && ret.data.words) {
      ret.data.words.forEach(word => {
        if (word.text.trim() && word.confidence > 30) {
          addedCount++;
          const wordX = word.bbox.x0 * scaleRatio;
          const wordY = word.bbox.y0 * scaleRatio;
          const wordH = (word.bbox.y1 - word.bbox.y0) * scaleRatio;

          const textObj = new fabric.IText(word.text, {
            left: wordX,
            top: wordY,
            fontSize: Math.max(12, Math.round(wordH)),
            fill: '#0f172a',
            fontFamily: 'Inter, sans-serif',
            isOcrText: true,
            ocrConfidence: Math.round(word.confidence),
            backgroundColor: 'rgba(224, 231, 255, 0.7)'
          });

          vFabricCanvas.add(textObj);
        }
      });
    }

    vFabricCanvas.renderAll();
    pushVisualHistory();
    showToast(`OCR complete! Recognized ${addedCount} words.`, 'success');
  } catch (err) {
    if (err && err.message !== 'cancelled') {
      showToast('OCR Error: ' + err.message, 'error');
    }
  } finally {
    isOcrRunning = false;
    banner.classList.add('hidden');
  }
}

/**
 * Cancels active Tesseract worker operation.
 */
async function cancelOCR() {
  if (ocrWorker) {
    try { await ocrWorker.terminate(); } catch(e) {}
    ocrWorker = null;
  }
  isOcrRunning = false;
  document.getElementById('ocr-progress-banner').classList.add('hidden');
  showToast('OCR cancelled.', 'info');
}

/**
 * Pushes canvas snapshot onto undo stack.
 */
function pushVisualHistory() {
  if (vFabricCanvas) {
    const json = JSON.stringify(vFabricCanvas.toJSON([
      'isOriginalText', 'originalText', 'originalBounds', 'isOcrText', 'ocrConfidence', 'isModified'
    ]));
    if (vUndoStack.length === 0 || vUndoStack[vUndoStack.length - 1] !== json) {
      vUndoStack.push(json);
      if (vUndoStack.length > 30) vUndoStack.shift();
      vRedoStack = [];
    }
  }
}

/**
 * Undoes last canvas action.
 */
function undoVisualState() {
  if (vUndoStack.length > 1) {
    vRedoStack.push(vUndoStack.pop());
    const state = vUndoStack[vUndoStack.length - 1];
    vFabricCanvas.loadFromJSON(state, () => vFabricCanvas.renderAll());
  }
}

/**
 * Redoes previously undone action.
 */
function redoVisualState() {
  if (vRedoStack.length > 0) {
    const state = vRedoStack.pop();
    vUndoStack.push(state);
    vFabricCanvas.loadFromJSON(state, () => vFabricCanvas.renderAll());
  }
}

/**
 * Switches pages sequentially.
 */
async function changeVisualPage(delta) {
  const next = vCurrentPageNum + delta;
  if (next >= 1 && next <= vPdfDocument.numPages) await loadVisualPage(next);
}

/**
 * Switches to a specific page index.
 */
async function changeVisualPageTo(pageNum) {
  if (pageNum >= 1 && pageNum <= vPdfDocument.numPages && pageNum !== vCurrentPageNum) {
    await loadVisualPage(pageNum);
  }
}

/**
 * Zooms canvas viewport scale.
 */
function zoomVisualCanvas(delta) {
  vZoomScale = Math.max(0.5, Math.min(2.5, vZoomScale + delta));
  document.getElementById('v-zoom-indicator').innerText = `${Math.round(vZoomScale * 100)}%`;
  loadVisualPage(vCurrentPageNum);
}

/**
 * Selects active drawing/editing tool.
 */
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
    vFabricCanvas.freeDrawingBrush.color = 'rgba(255, 235, 59, 0.4)';
    vFabricCanvas.freeDrawingBrush.width = 18;
  }
}

/**
 * Adds a new text box onto the canvas.
 */
function addVisualText() {
  setVisualTool('select');
  const text = new fabric.IText('New Text Box', { 
    left: 100, 
    top: 100, 
    fontSize: parseInt(vCurrentFontSize), 
    fill: vCurrentColor, 
    fontFamily: 'Inter, sans-serif' 
  });
  vFabricCanvas.add(text);
  vFabricCanvas.setActiveObject(text);
}

/**
 * Adds a rectangle shape onto the canvas.
 */
function addVisualRect() {
  setVisualTool('select');
  const rect = new fabric.Rect({ 
    left: 100, 
    top: 100, 
    width: 140, 
    height: 90, 
    fill: 'transparent', 
    stroke: vCurrentColor, 
    strokeWidth: 2 
  });
  vFabricCanvas.add(rect);
  vFabricCanvas.setActiveObject(rect);
}

/**
 * Imports an external image or signature onto the canvas.
 */
function addVisualImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    fabric.Image.fromURL(e.target.result, (img) => {
      img.scaleToWidth(180);
      img.set({ left: 120, top: 120 });
      vFabricCanvas.add(img);
      vFabricCanvas.setActiveObject(img);
    });
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

/**
 * Updates fill/stroke color of selected object.
 */
function updateVisualColor(color) {
  vCurrentColor = color;
  const activeObj = vFabricCanvas.getActiveObject();
  if (activeObj) {
    if (activeObj.set) activeObj.set('fill', color);
    if (activeObj.stroke && !activeObj.isOriginalText) activeObj.set('stroke', color);
    vFabricCanvas.renderAll();
  }
}

/**
 * Updates font size of selected text.
 */
function updateVisualFontSize(size) {
  vCurrentFontSize = size;
  const activeObj = vFabricCanvas.getActiveObject();
  if (activeObj && activeObj.type === 'i-text') {
    activeObj.set('fontSize', parseInt(size));
    vFabricCanvas.renderAll();
  }
}

/**
 * Deletes selected canvas object and registers white-out if original text.
 */
function deleteSelectedVisualObject() {
  const activeObj = vFabricCanvas.getActiveObject();
  if (activeObj) {
    if (activeObj.isOriginalText) {
      markOriginalTextAsModified(activeObj);
    }
    vFabricCanvas.remove(activeObj);
    vFabricCanvas.renderAll();
    pushVisualHistory();
  }
}

/**
 * Closes workspace and resets editor state.
 */
function closeVisualEditor() {
  document.getElementById('pdf-editor-workspace').classList.add('hidden');
  document.getElementById('pdf-editor-upload-zone').classList.remove('hidden');
  if (vFabricCanvas) vFabricCanvas.clear();
  vPdfDocument = null;
  vOriginalBuffer = null;
  vPagesData = [];
}

/**
 * PROPER WHITE-OUT + CLEAN EXPORT
 * Erases modified text regions using native PDF vector rectangles, then embeds high-DPI 
 * edited overlays onto the document.
 */
async function exportVisualEditedPdf() {
  if (!vOriginalBuffer) return;
  await saveCurrentVisualPageState();

  try {
    showToast('Exporting PDF with white-out layer processing...', 'info');
    const pdfDoc = await PDFLib.PDFDocument.load(vOriginalBuffer.slice(0));

    for (let i = 0; i < vPagesData.length; i++) {
      const pageData = vPagesData[i];
      const page = pdfDoc.getPages()[i];

      // STEP 1: Execute Native Vector White-Out over modified/deleted original text regions
      if (pageData.whiteoutRects && pageData.whiteoutRects.length > 0) {
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

      // STEP 2: Render crisp Fabric.js overlays (new/edited text, drawings, shapes)
      if (pageData.fabricJson && pageData.fabricJson.objects && pageData.fabricJson.objects.length > 0) {
        // High-DPI Canvas Rendering (2.0x scale for crisp export quality)
        const exportScale = 2.0;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = pageData.pdfPageWidth * exportScale;
        tempCanvas.height = pageData.pdfPageHeight * exportScale;

        const tempFabric = new fabric.StaticCanvas(tempCanvas, {
          viewportTransform: [exportScale, 0, 0, exportScale, 0, 0]
        });

        await new Promise((resolve) => {
          tempFabric.loadFromJSON(pageData.fabricJson, async () => {
            tempFabric.setBackgroundImage(null, tempFabric.renderAll.bind(tempFabric));
            
            // Remove blue selection strokes from export output
            tempFabric.getObjects().forEach(o => { 
              if (o.isOriginalText) {
                o.set({ strokeWidth: 0, stroke: '' });
              }
            });

            tempFabric.renderAll();

            const pngDataUrl = tempCanvas.toDataURL('image/png');
            const pngImage = await pdfDoc.embedPng(pngDataUrl);

            const { width, height } = page.getSize();
            page.drawImage(pngImage, { 
              x: 0, 
              y: 0, 
              width: width, 
              height: height 
            });

            // Clean memory
            tempCanvas.width = 0; 
            tempCanvas.height = 0;
            resolve();
          });
        });
      }
    }

    const pdfBytes = await pdfDoc.save();
    saveBlob(new Blob([pdfBytes], { type: 'application/pdf' }), `${window.currentLoadedFileName || 'Edited-Document'}-visual.pdf`);
    showToast('PDF exported successfully without ghosting!', 'success');
  } catch (err) {
    showToast('Export Error: ' + err.message, 'error');
  }
}
