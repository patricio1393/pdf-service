const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function detectarTipo(text) {
  if (/INFORMACI[ÓO]N\s+DEL\s+SOLICITANTE|ACEPTACI[ÓO]N\s+DE\s+CONDICIONES|SERVICIOS\s+CONTRATADOS/i.test(text)) {
    return 'SDS';
  }
  if (/\bPNM\b|PORTABILIDAD\s+NUMERICA\s+MOVIL|N[uú]mero\s+de\s+Solicitud\s+PNM/i.test(text)) {
    return 'SPN';
  }
  return null;
}

function extraerDni(text) {
  const RUIDO = new Set(['66328849']);
  const plausible = (n) => n && !RUIDO.has(n);
  const candidatos = [];
  let m = text.match(/DNI[A-Za-zÁÉÍÓÚÑ\s]{0,40}?(\d{7,8})/i);
  if (m) candidatos.push(m[1]);
  m = text.match(/(\d{7,8})[a-z0-9._%+-]+@/i);
  if (m) candidatos.push(m[1]);
  m = text.match(/Documento[:\s]*\n?([\s\S]{0,80}?)(\d{7,8})/i);
  if (m) candidatos.push(m[2]);
  m = text.match(/N[uú]mero\s+Documento[:\s]*(\d{7,8})/i);
  if (m) candidatos.push(m[1]);
  for (const c of candidatos) if (plausible(c)) return c;
  return null;
}

function extraerCliente(text) {
  let mc = text.match(/Apellido\s+y\s+Nombre[^:]*:\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,50}?)(?:\n|Tipo|Tel[eé]fono|DNI|Raz[óo]n|N[uú]mero|$)/);
  if (mc) {
    const nombre = mc[1].trim().replace(/\s+/g, ' ');
    if (nombre.length >= 4) return nombre.slice(0, 60);
  }
  mc = text.match(/([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]+)*)\s*\n?DNI([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{2,40}?)\d{7,8}/);
  if (mc) {
    const nombre = (mc[1] + ' ' + mc[2]).trim().replace(/\s+/g, ' ');
    if (nombre.length >= 4) return nombre.slice(0, 60);
  }
  mc = text.match(/([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]+)*)\s*\n?DNI/);
  if (mc) {
    const nombre = mc[1].trim().replace(/\s+/g, ' ');
    if (nombre.length >= 4) return nombre.slice(0, 60);
  }
  return null;
}

const SIG = {
  SDS: { x: 120, y: 438, w: 150 },
  SPN: { x: 80,  y: 230, w: 150 },
};

app.get('/health', (_req, res) => res.json({ ok: true, service: 'pdf-service' }));

app.post('/extraer', upload.single('sds'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo "sds"' });
    const data = await pdfParse(req.file.buffer);
    const text = data.text || '';
    const tipo = detectarTipo(text);
    const dni = extraerDni(text);
    const cliente = extraerCliente(text);
    if (!tipo) return res.status(422).json({ error: 'TIPO_DESCONOCIDO' });
    if (!dni)  return res.status(422).json({ error: 'NO_DNI' });
    res.json({ tipo, dni, cliente });
  } catch (e) {
    res.status(500).json({ error: 'EXTRACT_FAIL', detail: String(e.message || e) });
  }
});

const campos = upload.fields([
  { name: 'sds', maxCount: 1 },
  { name: 'firma', maxCount: 1 },
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 },
]);

app.post('/ensamblar', campos, async (req, res) => {
  try {
    const f = req.files || {};
    for (const k of ['sds', 'firma', 'front', 'back']) {
      if (!f[k] || !f[k][0]) return res.status(400).json({ error: 'Falta el archivo "' + k + '"' });
    }
    const docBuf   = f.sds[0].buffer;
    const firmaBuf = f.firma[0].buffer;
    const frontBuf = f.front[0].buffer;
    const backBuf  = f.back[0].buffer;

    let tipo = (req.body.tipo || '').toUpperCase();
    let dni = req.body.dni || '';
    let cliente = req.body.cliente || '';
    if (!tipo || !dni) {
      const data = await pdfParse(docBuf);
      const text = data.text || '';
      tipo = tipo || detectarTipo(text) || 'SDS';
      dni = dni || extraerDni(text) || '';
      cliente = cliente || extraerCliente(text) || '';
    }

    const pdfDoc = await PDFDocument.load(docBuf);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const signPage = pages[pages.length - 1];

    const cfg = SIG[tipo] || SIG.SDS;
    const firmaPng = await pdfDoc.embedPng(firmaBuf);
    const ratio = firmaPng.height / firmaPng.width;
    signPage.drawImage(firmaPng, { x: cfg.x, y: cfg.y, width: cfg.w, height: cfg.w * ratio });

    const frontImg = await pdfDoc.embedJpg(frontBuf);
    const backImg  = await pdfDoc.embedJpg(backBuf);
    const A4W = 595, A4H = 842;
    const dniPage = pdfDoc.addPage([A4W, A4H]);
    dniPage.drawText('Documento de identidad del solicitante', {
      x: 40, y: A4H - 55, size: 14, font, color: rgb(0.07, 0.06, 0.05),
    });
    const subtitle = [tipo, cliente, dni ? 'DNI ' + dni : ''].filter(Boolean).join('   ·   ');
    dniPage.drawText(subtitle, { x: 40, y: A4H - 74, size: 10, font, color: rgb(0.42, 0.39, 0.35) });

    const margin = 40, gap = 24;
    const usableW = A4W - margin * 2;
    const slotH = (A4H - 110 - margin - gap) / 2;
    const fit = (iw, ih, bw, bh) => { const s = Math.min(bw / iw, bh / ih); return { w: iw * s, h: ih * s }; };
    const fr = fit(frontImg.width, frontImg.height, usableW, slotH);
    dniPage.drawImage(frontImg, { x: margin + (usableW - fr.w) / 2, y: A4H - 110 - fr.h, width: fr.w, height: fr.h });
    const bk = fit(backImg.width, backImg.height, usableW, slotH);
    dniPage.drawImage(backImg, { x: margin + (usableW - bk.w) / 2, y: margin + (slotH - bk.h) / 2, width: bk.w, height: bk.h });

    const bytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${tipo}_firmada_${dni || 'cliente'}.pdf"`);
    res.setHeader('x-dni', dni);
    res.setHeader('x-tipo', tipo);
    if (cliente) res.setHeader('x-cliente', encodeURIComponent(cliente));
    res.send(Buffer.from(bytes));
  } catch (e) {
    res.status(500).json({ error: 'ASSEMBLE_FAIL', detail: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`pdf-service escuchando en :${PORT}`));
