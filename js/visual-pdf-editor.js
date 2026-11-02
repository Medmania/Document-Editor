
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
 * Initializes the interactive Fabric.js canvas and binds modification listeners.
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
 * Registers an original text object's region for vector white-out on PDF export.
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
    showToast('Large file (>25MB). Lowering scale to optimize browser memory.', 'info');
    vZoomScale = 0.8;
  }

  window.currentLoadedFileName = file.name.replace(/\.[^/.]+$/, "");
  showToast(`Loading "${file.name}" into Visual Editor...`, 'info');

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

    showToast('PDF loaded successfully! Mode: Edit Original Text.', 'success');
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
 * Loads a PDF page, applies immediate background white-out, and populates editable text objects.
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

  // Render Base Background Canvas
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = viewport.width;
  bgCanvas.height = viewport.height;
  const bgCtx = bgCanvas.getContext('2d');
  await page.render({ canvasContext: bgCtx, viewport }).promise;

  vFabricCanvas.clear();
  vFabricCanvas.setWidth(viewport.width);
  vFabricCanvas.setHeight(viewport.height);

  if (pageData.fabricJson) {
    // Page has already been visited/loaded before: set current background and restore JSON
    fabric.Image.fromURL(bgCanvas.toDataURL(), (img) => {
      vFabricCanvas.setBackgroundImage(img, vFabricCanvas.renderAll.bind(vFabricCanvas), { scaleX: 1, scaleY: 1 });
      vFabricCanvas.loadFromJSON(pageData.fabricJson, () => {
        applyEditModeStyles();
        vFabricCanvas.renderAll();
      });
      bgCanvas.width = 0; bgCanvas.height = 0;
    });
  } else {
    // First load of page: Extract text and perform IMMEDIATE VISUAL WHITE-OUT on background image canvas
    await extractAndOverlayOriginalText(page, viewport, unscaledViewport, bgCtx, bgCanvas);
  }
}

/**
 * ACCURATE TEXT EXTRACTION & IMMEDIATE VISUAL WHITE-OUT
 * Extracts PDF text, paints white rectangles onto the background canvas to erase old text instantly,
 * and overlays matching editable Fabric.js IText objects.
 */
async function extractAndOverlayOriginalText(page, viewport, unscaledViewport, bgCtx, bgCanvas) {
  const textContent = await page.getTextContent();
  const pageData = vPagesData[vCurrentPageNum - 1];

  if (!textContent.items || textContent.items.length === 0) {
    // Image-only / Scanned page
    fabric.Image.fromURL(bgCanvas.toDataURL(), (img) => {
      vFabricCanvas.setBackgroundImage(img, vFabricCanvas.renderAll.bind(vFabricCanvas), { scaleX: 1, scaleY: 1 });
      bgCanvas.width = 0; bgCanvas.height = 0;
    });
    showToast('Scanned/Image page detected! Click "OCR Page" to extract text.', 'info');
    return;
  }

  const lines = groupPdfItemsIntoLines(textContent.items);
  const fabricTextObjects = [];

  lines.forEach((lineItems, index) => {
    const lineText = lineItems.map(i => i.str).join(' ');
    if (!lineText.trim()) return;

    const firstItem = lineItems[0];

    // 1. Calculate Canvas Coordinates (Top-Left Origin)
    const tx = pdfjsLib.Util.transform(viewport.transform, firstItem.transform);
    const fontScale = Math.sqrt(firstItem.transform[0] * firstItem.transform[0] + firstItem.transform[1] * firstItem.transform[1]);
    const canvasFontSize = fontScale * viewport.scale;
    const pdfFontSize = fontScale;

    const lineCanvasWidth = lineItems.reduce((acc, item) => acc + ((item.width || 0) * viewport.scale), 0);
    const linePdfWidth = lineItems.reduce((acc, item) => acc + (item.width || 0), 0);

    const canvasLeft = tx[4];
    const canvasTop = tx[5] - (canvasFontSize * 0.85); // Baseline to top-left shift
    const lineCanvasHeight = canvasFontSize * 1.25;

    // 2. IMMEDIATE VISUAL WHITE-OUT: Paint white rectangle over bgCtx before fabric background generation
    bgCtx.fillStyle = '#ffffff';
    bgCtx.fillRect(
      Math.floor(canvasLeft - 2), 
      Math.floor(canvasTop - 2), 
      Math.ceil((lineCanvasWidth > 0 ? lineCanvasWidth : 80) + 4), 
      Math.ceil(lineCanvasHeight + 4)
    );

    // 3. Calculate Unscaled PDF Coordinates (Bottom-Left Origin in points)
    const pdfX = firstItem.transform[4];
    const pdfY = firstItem.transform[5] - (pdfFontSize * 0.25);
    const linePdfHeight = pdfFontSize * 1.25;

    const boundsId = `bound-p${vCurrentPageNum}-l${index}-${Math.random().toString(36).substring(2, 8)}`;
    const originalBounds = {
      id: boundsId,
      pdfX: Math.max(0, pdfX - 1.5),
      pdfY: Math.max(0, pdfY - 2.0),
      pdfW: (linePdfWidth > 0 ? linePdfWidth : 80) + 3.0,
      pdfH: linePdfHeight + 4.0
    };

    // Store in whiteout list for export processing
    pageData.whiteoutRects.push(originalBounds);

    // 4. Create Fabric IText Object
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

    fabricTextObjects.push(textObj);
  });

  // Set the whited-out background canvas image and add text objects
  fabric.Image.fromURL(bgCanvas.toDataURL(), (img) => {
    vFabricCanvas.setBackgroundImage(img, () => {
      fabricTextObjects.forEach(obj => vFabricCanvas.add(obj));
      applyEditModeStyles();
      vFabricCanvas.renderAll();
      pushVisualHistory();
    }, { scaleX: 1, scaleY: 1 });

    // Clean background canvas memory
    bgCanvas.width = 0; 
    bgCanvas.height = 0;
  });
}

/**
 * Toggles mode and updates outline visual cues.
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
 * Applies subtle outline indicator to original PDF text objects in Edit mode.
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
 * Runs Tesseract.js OCR engine on image PDF pages.
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
 * Cancels active Tesseract OCR operation.
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
 * Adds a new text box onto canvas.
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
 * Adds a rectangle shape onto canvas.
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
 * Imports an image or signature onto canvas.
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
 * Updates fill/stroke color of active object.
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
 * Updates font size of active text object.
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
 * Deletes selected object and registers white-out if original text.
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
 * CLEAN VECTOR EXPORT VIA PDF-LIB
 * Draws native vector white rectangles over all whited-out text regions in PDF space,
 * then overlays high-resolution (2.5x scale) canvas PNG renders without selection borders.
 */
async function exportVisualEditedPdf() {
  if (!vOriginalBuffer) return;
  await saveCurrentVisualPageState();

  try {
    showToast('Processing PDF export with vector white-outs...', 'info');
    const pdfDoc = await PDFLib.PDFDocument.load(vOriginalBuffer.slice(0));

    for (let i = 0; i < vPagesData.length; i++) {
      const pageData = vPagesData[i];
      const page = pdfDoc.getPages()[i];

      // Step 1: Draw Native Vector White Rectangles over extracted text regions in PDF Space
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

      // Step 2: Render crisp Fabric.js overlays (edited text, annotations, shapes)
      if (pageData.fabricJson && pageData.fabricJson.objects && pageData.fabricJson.objects.length > 0) {
        const exportScale = 2.5; // High-DPI export resolution
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = pageData.pdfPageWidth * exportScale;
        tempCanvas.height = pageData.pdfPageHeight * exportScale;

        const tempFabric = new fabric.StaticCanvas(tempCanvas, {
          viewportTransform: [exportScale, 0, 0, exportScale, 0, 0]
        });

        await new Promise((resolve) => {
          tempFabric.loadFromJSON(pageData.fabricJson, async () => {
            tempFabric.setBackgroundImage(null, tempFabric.renderAll.bind(tempFabric));
            
            // Hide selection stroke borders during PNG export
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

            // Memory cleanup
            tempCanvas.width = 0; 
            tempCanvas.height = 0;
            resolve();
          });
        });
      }
    }

    const pdfBytes = await pdfDoc.save();
    saveBlob(new Blob([pdfBytes], { type: 'application/pdf' }), `${window.currentLoadedFileName || 'Edited-Document'}-visual.pdf`);
    showToast('PDF exported successfully with zero ghosting!', 'success');
  } catch (err) {
    showToast('Export Error: ' + err.message, 'error');
  }
}
