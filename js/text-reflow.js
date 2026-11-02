

let quill = null;

function initQuillEditor() {
  quill = new Quill('#editor-wrapper', {
    theme: 'snow',
    placeholder: 'Type or paste content here...',
    modules: {
      toolbar: [
        [{ 'font': [] }, { 'size': ['small', false, 'large', 'huge'] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ 'color': [] }, { 'background': [] }],
        [{ 'align': [] }],
        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
        ['blockquote', 'code-block'],
        ['clean']
      ]
    }
  });
}

async function handleEditorImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  window.currentLoadedFileName = file.name.replace(/\.[^/.]+$/, "");
  document.getElementById('editor-file-name').innerText = file.name;
  document.getElementById('editor-file-status').classList.remove('hidden');

  try {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'docx') {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      quill.clipboard.dangerouslyPasteHTML(result.value);
    } else if (ext === 'pdf') {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let htmlContent = "";
      let multiColumnDetected = false;

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        if (checkMultiColumnHeuristic(textContent.items)) {
          multiColumnDetected = true;
        }

        const lines = groupPdfItemsIntoLines(textContent.items);
        lines.forEach(lineItems => {
          const lineText = lineItems.map(item => {
            const isBold = (item.fontName || '').toLowerCase().includes('bold');
            return isBold ? `<strong>${item.str}</strong>` : item.str;
          }).join(' ');

          htmlContent += `<p>${lineText}</p>`;
        });
      }

      if (multiColumnDetected) {
        showToast('Notice: Multi-column PDF layout detected. Text reflow order may require manual adjustment.', 'info');
      }

      quill.clipboard.dangerouslyPasteHTML(htmlContent);
    }
    showToast('Document imported into reflow editor!', 'success');
  } catch (err) {
    showToast('Import Error: ' + err.message, 'error');
  } finally {
    event.target.value = '';
  }
}

function checkMultiColumnHeuristic(items) {
  if (!items || items.length < 15) return false;
  const xPositions = items.map(item => item.transform[4]);
  const minX = Math.min(...xPositions);
  const maxX = Math.max(...xPositions);
  const midX = minX + (maxX - minX) / 2;

  let leftCount = 0, rightCount = 0;
  items.forEach(item => {
    if (item.transform[4] < midX - 30) leftCount++;
    else if (item.transform[4] > midX + 30) rightCount++;
  });

  return (leftCount > items.length * 0.25 && rightCount > items.length * 0.25);
}

function resetEditorContent() {
  quill.setText('');
  document.getElementById('editor-file-status').classList.add('hidden');
}

async function exportRichText(format) {
  if (quill.getText().trim().length === 0) {
    showToast('Editor canvas is empty.', 'error');
    return;
  }
  const filename = `${window.currentLoadedFileName || 'Document'}.${format}`;

  if (format === 'pdf') {
    html2pdf().set({ 
      margin: 15, 
      filename: filename, 
      html2canvas: { scale: 2 }, 
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } 
    }).from(quill.root).save();
  } else if (format === 'docx') {
    try {
      const delta = quill.getContents();
      const children = parseQuillDeltaToDocx(delta);
      const doc = new docx.Document({ sections: [{ children }] });
      const blob = await docx.Packer.toBlob(doc);
      saveBlob(blob, filename);
      showToast('Exported to DOCX!', 'success');
    } catch (err) {
      showToast('DOCX Export Error: ' + err.message, 'error');
    }
  }
}

function parseQuillDeltaToDocx(delta) {
  const paragraphs = [];
  let currentRuns = [];

  delta.ops.forEach(op => {
    if (typeof op.insert === 'string') {
      const text = op.insert;
      const lines = text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) {
          const runOpts = { text: lines[i] };
          if (op.attributes) {
            if (op.attributes.bold) runOpts.bold = true;
            if (op.attributes.italic) runOpts.italics = true;
            if (op.attributes.underline) runOpts.underline = {};
            if (op.attributes.strike) runOpts.strike = true;
            if (op.attributes.color) runOpts.color = op.attributes.color.replace('#', '');
            if (op.attributes.size) {
              if (op.attributes.size === 'small') runOpts.size = 18;
              else if (op.attributes.size === 'large') runOpts.size = 28;
              else if (op.attributes.size === 'huge') runOpts.size = 36;
            }
          }
          currentRuns.push(new docx.TextRun(runOpts));
        }

        if (i < lines.length - 1) {
          const pOpts = { children: currentRuns.length > 0 ? currentRuns : [new docx.TextRun("")] };
          if (op.attributes && op.attributes.header) {
            if (op.attributes.header === 1) pOpts.heading = docx.HeadingLevel.HEADING_1;
            else if (op.attributes.header === 2) pOpts.heading = docx.HeadingLevel.HEADING_2;
            else if (op.attributes.header === 3) pOpts.heading = docx.HeadingLevel.HEADING_3;
          }
          if (op.attributes && op.attributes.list === 'bullet') {
            pOpts.bullet = { level: 0 };
          }
          paragraphs.push(new docx.Paragraph(pOpts));
          currentRuns = [];
        }
      }
    }
  });

  if (currentRuns.length > 0) {
    paragraphs.push(new docx.Paragraph({ children: currentRuns }));
  }

  return paragraphs.length > 0 ? paragraphs : [new docx.Paragraph({ children: [new docx.TextRun("")] })];
}
