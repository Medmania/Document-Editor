

// Visual PDF Editor State Variables
let vPdfDocument = null;
let vOriginalBuffer = null;
let vPagesData = []; // Array of { pageNum, fabricJson, width, height, whiteoutRects: [] }
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

function initVisualFabricCanvas() {
  vFabricCanvas = new fabric.Canvas('pdf-v-fabric-canvas', {
    selection: true,
    preserveObjectStacking: true
  });

  vFabricCanvas.on('object:modified', () => pushVisualHistory());
  vFabricCanvas.on('object:added', (e) => {
    if (e.target && !e.target.isBackground) pushVisualHistory();
  });
  vFabricCanvas.on('text:changed', (e) => {
    const obj = e.target;
    if (obj && obj.isOriginalText && obj.originalBounds) {
      markOriginalTextAsModified(obj);
    }
  });
}

function markOriginalTextAsModified(textObj) {
  const pageData = vPagesData[vCurrentPageNum - 1];
  if (pageData && textObj.originalBounds) {
    const exists = pageData.whiteoutRects.some(r => r.id === textObj.originalBounds.id);
    if (!exists) {
      pageData.whiteoutRects.push(textObj.originalBounds);
    }
  }
}

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

async function loadVisualPdfFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > 25 * 1024 * 1024) {
    showToast('Large file (>25MB). Lowering canvas render scale to optimize browser memory.', 'info');
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
      vPagesData.push({ pageNum: i, fabricJson: null, width: 0, height: 0, whiteoutRects: [] });
    }

    vCurrentPageNum = 1;
    vUndoStack = [];
    vRedoStack = [];

    document.getElementById('pdf-editor-upload-zone').classList.add('hidden');
    document.getElementById('pdf-editor-workspace').classList.remove('hidden');

    await renderVisualPageThumbnails();
    await loadVisualPage(1);

    showToast('PDF loaded successfully! Active mode: Edit Original Text.', 'success');
  } catch (err) {
    showToast('Error opening PDF: ' + err.message, 'error');
  } finally {
    event.target.value = '';
  }
}

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
    wrapper.className = `p-1.5 rounded-xl border cursor-pointer transition-all text-center space-y-1 ${i === vCurrentPageNum ? 'border-brand-600 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300 bg-white'}`;
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

    // Memory Cleanup
    canvas.width = 0; 
    canvas.height = 0;
  }
}

async function saveCurrentVisualPageState() {
  if (vFabricCanvas && vPagesData[vCurrentPageNum - 1]) {
    vPagesData[vCurrentPageNum - 1].fabricJson = vFabricCanvas.toJSON([
      'isOriginalText', 'originalText', 'originalBounds', 'isOcrText', 'ocrConfidence'
    ]);
  }
}

async function loadVisualPage(pageNum) {
  if (!vPdfDocument) return;

  await saveCurrentVisualPageState();
  vCurrentPageNum = pageNum;
  document.getElementById('v-page-indicator').innerText = `Page ${pageNum} of ${vPdfDocument.numPages}`;

  const page = await vPdfDocument.getPage(pageNum);
  const viewportScale = 1.5 * vZoomScale;
  const viewport = page.getViewport({ scale: viewportScale });

  const pageData = vPagesData[pageNum - 1];
  pageData.width = viewport.width;
  pageData.height = viewport.height;

  // Render Base Background
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
      extractAndOverlayOriginalText(page, viewport);
    }

    bgCanvas.width = 0; 
    bgCanvas.height = 0;
  });
}

async function extractAndOverlayOriginalText(page, viewport) {
  const textContent = await page.getTextContent();

  if (!textContent.items || textContent.items.length === 0) {
    showToast('Image-only PDF page detected! Click "OCR Page" to extract text.', 'info');
    return;
  }

  const lines = groupPdfItemsIntoLines(textContent.items);

  lines.forEach((lineItems, index) => {
    const lineText = lineItems.map(i => i.str).join(' ');
    if (!lineText.trim()) return;

    const firstItem = lineItems[0];
    const tx = pdfjsLib.Util.transform(viewport.transform, firstItem.transform);
    const fontSize = Math.sqrt(firstItem.transform[0] * firstItem.transform[0] + firstItem.transform[1] * firstItem.transform[1]) * viewport.scale;

    const lineCalcWidth = lineItems.reduce((acc, item) => acc + (item.width || 0), 0) * viewport.scale;
    const lineCalcHeight = fontSize * 1.2;

    const boundsId = `bound-${vCurrentPageNum}-${index}-${Math.random().toString(36).substr(2, 6)}`;
    const originalBounds = {
      id: boundsId,
      left: tx[4],
      top: tx[5] - fontSize,
      width: lineCalcWidth > 0 ? lineCalcWidth : 100,
      height: lineCalcHeight
    };

    const textObj = new fabric.IText(lineText, {
      left: tx[4],
      top: tx[5] - fontSize,
      fontSize: fontSize || 14,
      fill: '#0f172a',
      fontFamily: 'Helvetica, Inter, sans-serif',
      isOriginalText: true,
      originalText: lineText,
      originalBounds: originalBounds,
      stroke: vEditMode === 'edit-text' ? '#2563eb' : '',
      strokeWidth: vEditMode === 'edit-text' ? 0.5 : 0
    });

    vFabricCanvas.add(textObj);
  });

  vFabricCanvas.renderAll();
  pushVisualHistory();
}

function setVisualEditMode(mode) {
  vEditMode = mode;
  document.getElementById('v-mode-edit').className = mode === 'edit-text' ? "px-2.5 py-1 text-xs font-semibold rounded-lg text-brand-600 bg-white shadow-sm flex items-center gap-1.5" : "px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 flex items-center gap-1.5";
  document.getElementById('v-mode-annotate').className = mode === 'annotate' ? "px-2.5 py-1 text-xs font-semibold rounded-lg text-brand-600 bg-white shadow-sm flex items-center gap-1.5" : "px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 flex items-center gap-1.5";

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
        strokeWidth: vEditMode === 'edit-text' ? 0.5 : 0, 
        selectable: true 
      });
    }
  });
  vFabricCanvas.renderAll();
}

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
    statusText.innerText = "Rendering clean original page for OCR...";
    const page = await vPdfDocument.getPage(vCurrentPageNum);
    const ocrScale = 2.0;
    const viewport = page.getViewport({ scale: ocrScale });

    const cleanCanvas = document.createElement('canvas');
    cleanCanvas.width = viewport.width;
    cleanCanvas.height = viewport.height;
    const ctx = cleanCanvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    if (!ocrWorker) {
      statusText.innerText = "Initializing Tesseract.js OCR engine binaries...";
      ocrWorker = await Tesseract.createWorker('eng');
    }

    statusText.innerText = `Recognizing text on page ${vCurrentPageNum}...`;
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
            fontFamily: 'Inter',
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
    showToast(`OCR complete! Recognized ${addedCount} words (marked with indigo background).`, 'success');
  } catch (err) {
    if (err && err.message !== 'cancelled') {
      showToast('OCR Error: ' + err.message, 'error');
    }
  } finally {
    isOcrRunning = false;
    banner.classList.add('hidden');
  }
}

async function cancelOCR() {
  if (ocrWorker) {
    try { await ocrWorker.terminate(); } catch(e) {}
    ocrWorker = null;
  }
  isOcrRunning = false;
  document.getElementById('ocr-progress-banner').classList.add('hidden');
  showToast('OCR operation cancelled.', 'info');
}

function pushVisualHistory() {
  if (vFabricCanvas) {
    const json = JSON.stringify(vFabricCanvas.toJSON([
      'isOriginalText', 'originalText', 'originalBounds', 'isOcrText', 'ocrConfidence'
    ]));
    if (vUndoStack.length === 0 || vUndoStack[vUndoStack.length - 1] !== json) {
      vUndoStack.push(json);
      if (vUndoStack.length > 30) vUndoStack.shift();
      vRedoStack = [];
    }
  }
}

function undoVisualState() {
  if (vUndoStack.length > 1) {
    vRedoStack.push(vUndoStack.pop());
    const state = vUndoStack[vUndoStack.length - 1];
    vFabricCanvas.loadFromJSON(state, () => vFabricCanvas.renderAll());
  }
}

function redoVisualState() {
  if (vRedoStack.length > 0) {
    const state = vRedoStack.pop();
    vUndoStack.push(state);
    vFabricCanvas.loadFromJSON(state, () => vFabricCanvas.renderAll());
  }
}

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

function addVisualText() {
  setVisualTool('select');
  const text = new fabric.IText('New Text Box', { left: 100, top: 100, fontSize: parseInt(vCurrentFontSize), fill: vCurrentColor, fontFamily: 'Inter' });
  vFabricCanvas.add(text);
  vFabricCanvas.setActiveObject(text);
}

function addVisualRect() {
  setVisualTool('select');
  const rect = new fabric.Rect({ left: 100, top: 100, width: 140, height: 90, fill: 'transparent', stroke: vCurrentColor, strokeWidth: 2 });
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
      img.set({ left: 120, top: 120 });
      vFabricCanvas.add(img);
      vFabricCanvas.setActiveObject(img);
    });
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function updateVisualColor(color) {
  vCurrentColor = color;
  const activeObj = vFabricCanvas.getActiveObject();
  if (activeObj) {
    if (activeObj.set) activeObj.set('fill', color);
    if (activeObj.stroke) activeObj.set('stroke', color);
    vFabricCanvas.renderAll();
  }
}

function updateVisualFontSize(size) {
  vCurrentFontSize = size;
  const activeObj = vFabricCanvas.getActiveObject();
  if (activeObj && activeObj.type === 'i-text') {
    activeObj.set('fontSize', parseInt(size));
    vFabricCanvas.renderAll();
  }
}

function deleteSelectedVisualObject() {
  const activeObj = vFabricCanvas.getActiveObject();
  if (activeObj) {
    if (activeObj.isOriginalText && activeObj.originalBounds) {
      markOriginalTextAsModified(activeObj);
    }
    vFabricCanvas.remove(activeObj);
    vFabricCanvas.renderAll();
    pushVisualHistory();
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

async function exportVisualEditedPdf() {
  if (!vOriginalBuffer) return;
  await saveCurrentVisualPageState();

  try {
    showToast('Processing PDF export layers...', 'info');
    const pdfDoc = await PDFLib.PDFDocument.load(vOriginalBuffer.slice(0));

    for (let i = 0; i < vPagesData.length; i++) {
      const pageData = vPagesData[i];
      const page = pdfDoc.getPages()[i];
      const scale = 1.5 * vZoomScale;

      // Step 1: White-out modified/deleted original text regions
      if (pageData.whiteoutRects && pageData.whiteoutRects.length > 0) {
        pageData.whiteoutRects.forEach(rect => {
          const pdfX = rect.left / scale;
          const pdfY = (pageData.height - rect.top - rect.height) / scale;
          const pdfW = rect.width / scale;
          const pdfH = rect.height / scale;

          page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfW,
            height: pdfH,
            color: PDFLib.rgb(1, 1, 1)
          });
        });
      }

      // Step 2: Render overlays via PNG canvas export
      if (pageData.fabricJson && pageData.fabricJson.objects && pageData.fabricJson.objects.length > 0) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = pageData.width;
        tempCanvas.height = pageData.height;
        const tempFabric = new fabric.StaticCanvas(tempCanvas);

        await new Promise((resolve) => {
          tempFabric.loadFromJSON(pageData.fabricJson, async () => {
            tempFabric.setBackgroundImage(null, tempFabric.renderAll.bind(tempFabric));
            tempFabric.getObjects().forEach(o => { if (o.isOriginalText) o.set('strokeWidth', 0); });
            tempFabric.renderAll();

            const pngDataUrl = tempCanvas.toDataURL('image/png');
            const pngImage = await pdfDoc.embedPng(pngDataUrl);

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
    saveBlob(new Blob([pdfBytes], { type: 'application/pdf' }), `${window.currentLoadedFileName || 'Edited-Document'}-visual.pdf`);
    showToast('PDF exported successfully!', 'success');
  } catch (err) {
    showToast('Export Error: ' + err.message, 'error');
  }
}
