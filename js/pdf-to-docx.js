

let selectedConvFile = null;

function handleConvFileSelect(event) {
  const file = event.target.files[0];
  if (file) {
    selectedConvFile = file;
    document.getElementById('conv-file-label').innerText = `Selected: ${file.name}`;
    document.getElementById('conv-btn').disabled = false;
  }
}

function handleConvDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('drop-active');
  const file = event.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') handleConvFileSelect({ target: { files: [file] } });
}

async function startPdfToDocxConversion() {
  if (!selectedConvFile) return;
  const btn = document.getElementById('conv-btn');
  const progressWrapper = document.getElementById('conv-progress-wrapper');
  const progressBar = document.getElementById('conv-progress-bar');
  const progressPercent = document.getElementById('conv-progress-percent');
  btn.disabled = true;
  progressWrapper.classList.remove('hidden');

  try {
    const arrayBuffer = await selectedConvFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const docxParagraphs = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const pct = Math.round((i / pdf.numPages) * 100);
      progressBar.style.width = `${pct}%`;
      progressPercent.innerText = `${pct}%`;

      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const lines = groupPdfItemsIntoLines(textContent.items);

      lines.forEach(line => {
        const runs = line.map(item => new docx.TextRun({
          text: item.str + " ",
          size: Math.max(10, Math.round((item.height || 12) * 1.8)),
          bold: (item.fontName || '').toLowerCase().includes('bold')
        }));
        docxParagraphs.push(new docx.Paragraph({ children: runs }));
      });
    }

    const doc = new docx.Document({ sections: [{ children: docxParagraphs }] });
    const blob = await docx.Packer.toBlob(doc);
    saveBlob(blob, selectedConvFile.name.replace(/\.pdf$/i, '') + '.docx');
    showToast('Converted PDF to DOCX successfully!', 'success');
  } catch (err) {
    showToast('Conversion Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    progressWrapper.classList.add('hidden');
  }
}
