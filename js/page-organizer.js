


let organizerPages = []; // Array of { id, buffer, pageIndex, rotation, filename, selected }
let sortableInstance = null;

function initSortableGrid() {
  sortableInstance = new Sortable(document.getElementById('organizer-grid'), {
    animation: 150,
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd: updateOrganizerOrder
  });
}

async function loadOrganizerPdfs(event) {
  const files = Array.from(event.target.files);
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;

    for (let i = 1; i <= pdf.numPages; i++) {
      const pageObj = { 
        id: 'page-' + Math.random().toString(36).substr(2, 9), 
        buffer: buffer.slice(0), 
        pageIndex: i - 1, 
        rotation: 0, 
        filename: file.name, 
        selected: false 
      };
      organizerPages.push(pageObj);
      await renderPageCard(pageObj);
    }
  }
  event.target.value = '';
  checkOrganizerState();
}

function handleOrganizerDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('drop-active');
  const files = Array.from(event.dataTransfer.files).filter(f => f.type === 'application/pdf');
  if (files.length > 0) loadOrganizerPdfs({ target: { files } });
}

async function renderPageCard(pageObj) {
  const grid = document.getElementById('organizer-grid');
  const card = document.createElement('div');
  card.className = `page-card bg-white p-3 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between relative group ${pageObj.selected ? 'selected-card' : ''}`;
  card.dataset.id = pageObj.id;
  card.onclick = (e) => toggleSelectCard(e, pageObj.id);

  const canvasContainer = document.createElement('div');
  canvasContainer.className = 'relative w-full aspect-[1/1.4] bg-slate-100 rounded-xl overflow-hidden flex items-center justify-center border border-slate-100';

  const canvas = document.createElement('canvas');
  const pdf = await pdfjsLib.getDocument({ data: pageObj.buffer.slice(0) }).promise;
  const page = await pdf.getPage(pageObj.pageIndex + 1);
  const viewport = page.getViewport({ scale: 0.3, rotation: pageObj.rotation });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  const actionsBar = document.createElement('div');
  actionsBar.className = 'mt-3 flex items-center justify-between gap-1 text-slate-500';
  actionsBar.innerHTML = `
    <div class="text-[10px] font-semibold truncate max-w-[70px]">${pageObj.filename}</div>
    <div class="flex items-center gap-1">
      <button onclick="event.stopPropagation(); rotatePage('${pageObj.id}')" title="Rotate 90°" aria-label="Rotate Page 90 Degrees" class="p-1 hover:bg-slate-100 rounded-lg text-slate-600"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></button>
      <button onclick="event.stopPropagation(); duplicatePage('${pageObj.id}')" title="Duplicate Page" aria-label="Duplicate Page" class="p-1 hover:bg-slate-100 rounded-lg text-slate-600"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg></button>
      <button onclick="event.stopPropagation(); deletePage('${pageObj.id}')" title="Delete Page" aria-label="Delete Page" class="p-1 hover:bg-red-50 rounded-lg text-red-600"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
    </div>
  `;

  canvasContainer.appendChild(canvas);
  card.appendChild(canvasContainer);
  card.appendChild(actionsBar);
  grid.appendChild(card);
}

function toggleSelectCard(event, id) {
  const pageObj = organizerPages.find(p => p.id === id);
  if (!pageObj) return;

  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    pageObj.selected = !pageObj.selected;
  } else {
    organizerPages.forEach(p => p.selected = (p.id === id ? !p.selected : false));
  }

  document.querySelectorAll('#organizer-grid .page-card').forEach(card => {
    const item = organizerPages.find(p => p.id === card.dataset.id);
    if (item && item.selected) card.classList.add('selected-card');
    else card.classList.remove('selected-card');
  });
}

async function rotatePage(id) {
  const pageObj = organizerPages.find(p => p.id === id);
  if (pageObj) {
    pageObj.rotation = (pageObj.rotation + 90) % 360;
    await reRenderGrid();
  }
}

async function duplicatePage(id) {
  const index = organizerPages.findIndex(p => p.id === id);
  if (index !== -1) {
    const dup = { ...organizerPages[index], id: 'page-' + Math.random().toString(36).substr(2, 9), selected: false };
    organizerPages.splice(index + 1, 0, dup);
    await reRenderGrid();
  }
}

function deletePage(id) {
  organizerPages = organizerPages.filter(p => p.id !== id);
  const card = document.querySelector(`[data-id="${id}"]`);
  if (card) card.remove();
  checkOrganizerState();
}

async function bulkRotateSelected() {
  organizerPages.forEach(p => { if (p.selected) p.rotation = (p.rotation + 90) % 360; });
  await reRenderGrid();
}

function bulkDeleteSelected() {
  organizerPages = organizerPages.filter(p => !p.selected);
  reRenderGrid();
}

async function insertBlankPage() {
  let width = 595.28; // Standard A4 points
  let height = 841.89;

  if (organizerPages.length > 0) {
    const refPageObj = organizerPages.find(p => p.selected) || organizerPages[organizerPages.length - 1];
    if (refPageObj && refPageObj.buffer) {
      try {
        const refPdf = await PDFLib.PDFDocument.load(refPageObj.buffer.slice(0));
        const refPage = refPdf.getPages()[refPageObj.pageIndex];
        if (refPage) {
          const size = refPage.getSize();
          width = size.width;
          height = size.height;
        }
      } catch (e) {}
    }
  }

  const blankPdf = await PDFLib.PDFDocument.create();
  blankPdf.addPage([width, height]);
  const pdfBytes = await blankPdf.save();
  const pageObj = { 
    id: 'page-' + Math.random().toString(36).substr(2, 9), 
    buffer: pdfBytes.buffer, 
    pageIndex: 0, 
    rotation: 0, 
    filename: 'Blank Page', 
    selected: false 
  };
  organizerPages.push(pageObj);
  await renderPageCard(pageObj);
  checkOrganizerState();
  showToast('Inserted blank page matching document size.', 'info');
}

function confirmClearOrganizer() {
  if (confirm('Are you sure you want to remove all loaded pages?')) {
    organizerPages = [];
    document.getElementById('organizer-grid').innerHTML = '';
    checkOrganizerState();
  }
}

function updateOrganizerOrder() {
  const cardElements = Array.from(document.querySelectorAll('#organizer-grid .page-card'));
  organizerPages = cardElements.map(card => organizerPages.find(p => p.id === card.dataset.id)).filter(Boolean);
}

async function reRenderGrid() {
  document.getElementById('organizer-grid').innerHTML = '';
  for (const pageObj of organizerPages) await renderPageCard(pageObj);
  checkOrganizerState();
}

function checkOrganizerState() {
  const emptyState = document.getElementById('organizer-empty-state');
  const grid = document.getElementById('organizer-grid');
  const saveBtn = document.getElementById('organizer-save-btn');
  const clearBtn = document.getElementById('organizer-clear-btn');
  if (organizerPages.length === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    saveBtn.disabled = true; 
    clearBtn.disabled = true;
  } else {
    emptyState.classList.add('hidden');
    grid.classList.remove('hidden');
    saveBtn.disabled = false; 
    clearBtn.disabled = false;
  }
}

async function exportOrganizedPdf() {
  if (organizerPages.length === 0) return;
  try {
    showToast('Building organized PDF...', 'info');
    const mergedPdf = await PDFLib.PDFDocument.create();
    for (const item of organizerPages) {
      const srcDoc = await PDFLib.PDFDocument.load(item.buffer.slice(0));
      const [copiedPage] = await mergedPdf.copyPages(srcDoc, [item.pageIndex]);
      if (item.rotation !== 0) {
        const currentAngle = copiedPage.getRotation().angle;
        copiedPage.setRotation(PDFLib.degrees((currentAngle + item.rotation) % 360));
      }
      mergedPdf.addPage(copiedPage);
    }
    const pdfBytes = await mergedPdf.save();
    saveBlob(new Blob([pdfBytes], { type: 'application/pdf' }), `${window.currentLoadedFileName || 'Organized'}-export.pdf`);
    showToast('Organized PDF exported successfully!', 'success');
  } catch (err) {
    showToast('Error exporting PDF: ' + err.message, 'error');
  }
}
