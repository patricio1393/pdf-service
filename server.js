/**
 * pdf-service — microservicio de ensamblado de PDFs SDS/SPN
 *
 * Endpoints (solo accesibles desde la red interna de Docker):
 *   GET  /health      -> chequeo de vida
 *   POST /extraer     -> recibe el PDF (campo "sds"), devuelve { tipo, dni, cliente }
 *   POST /ensamblar   -> recibe sds + firma + front + back, devuelve el PDF final
 *
 * No expone puertos al exterior: n8n le habla por http://pdf-service:3000
 */
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { readBarcodes, setZXingModuleOverrides } = require('zxing-wasm/reader');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// --------- Utilidades de análisis ---------
function detectarTipo(text) {
  // Los marcadores de SDS son inequívocos (secciones propias de esa solicitud).
  // La SDS MENCIONA "formulario de portabilidad numérica" en su texto legal,
  // así que NO se puede usar esa frase para detectar SPN. Chequeamos SDS primero.
  if (/INFORMACI[ÓO]N\s+DEL\s+SOLICITANTE|ACEPTACI[ÓO]N\s+DE\s+CONDICIONES|SERVICIOS\s+CONTRATADOS/i.test(text)) {
    return 'SDS';
  }
  // SPN: la sigla "PNM" y el número de solicitud "…PNA" no aparecen en la SDS.
  if (/\bPNM\b|PORTABILIDAD\s+NUMERICA\s+MOVIL|N[uú]mero\s+de\s+Solicitud\s+PNM/i.test(text)) {
    return 'SPN';
  }
  return null;
}
function extraerDni(text) {
  // pdf-parse reordena el texto según el layout, así que probamos varias
  // estrategias en cascada. El CUIT de Claro (66328849) es ruido conocido: lo excluimos.
  const RUIDO = new Set(['66328849']); // CUIT AMX Argentina (Claro)
  const plausible = (n) => n && !RUIDO.has(n);

  const candidatos = [];

  // 1) "DNI" seguido (con nombre en medio, hasta 40 chars) del número — típico SDS
  let m = text.match(/DNI[A-Za-zÁÉÍÓÚÑ\s]{0,40}?(\d{7,8})/i);
  if (m) candidatos.push(m[1]);

  // 2) número inmediatamente antes de un email — SDS suele tener "DNI <n><email>"
  m = text.match(/(\d{7,8})[a-z0-9._%+-]+@/i);
  if (m) candidatos.push(m[1]);

  // 3) "Documento" ... número dentro de un bloque cercano — típico SPN
  m = text.match(/Documento[:\s]*\n?([\s\S]{0,80}?)(\d{7,8})/i);
  if (m) candidatos.push(m[2]);

  // 4) "Número Documento" clásico (por si el layout lo respeta)
  m = text.match(/N[uú]mero\s+Documento[:\s]*(\d{7,8})/i);
  if (m) candidatos.push(m[1]);

  // devolver el primer candidato plausible
  for (const c of candidatos) if (plausible(c)) return c;
  return null;
}
function extraerCliente(text) {
  // Buscamos el nombre del titular. Cortamos en salto de línea o cuando
  // empieza la siguiente etiqueta del formulario (Tipo, Teléfono, DNI, etc.).
  let mc = text.match(/Apellido\s+y\s+Nombre[^:]*:\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{3,50}?)(?:\n|Tipo|Tel[eé]fono|DNI|Raz[óo]n|N[uú]mero|$)/);
  if (mc) {
    const nombre = mc[1].trim().replace(/\s+/g, ' ');
    if (nombre.length >= 4) return nombre.slice(0, 60);
  }
  // Fallback SDS: el texto reordenado suele quedar como
  // "SANCHEZ\nDNIJESSICA JACQUELINA36970012m.noelia@..."
  // → apellido antes de "DNI", nombre después, hasta el número o email.
  mc = text.match(/([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]+)*)\s*\n?DNI([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{2,40}?)\d{7,8}/);
  if (mc) {
    const nombre = (mc[1] + ' ' + mc[2]).trim().replace(/\s+/g, ' ');
    if (nombre.length >= 4) return nombre.slice(0, 60);
  }
  // Fallback simple: apellido pegado a DNI
  mc = text.match(/([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]+)*)\s*\n?DNI/);
  if (mc) {
    const nombre = mc[1].trim().replace(/\s+/g, ' ');
    if (nombre.length >= 4) return nombre.slice(0, 60);
  }
  return null;
}

// --------- Coordenadas de firma (calibradas con PDFs reales) ---------
const SIG = {
  SDS: [{ page: 'last', x: 270, y: 548, w: 150 }],
  SPN: [
    { page: 0, x: 70, y: 180, w: 150 },
    { page: 'last', x: 80, y: 230, w: 150 },
  ],
};

// =========================================================
//  LECTURA DE DNI DESDE FOTOS (barcode PDF417 + OCR con voto)
// =========================================================
let _wasmReady = false;
function initWasm() {
  if (_wasmReady) return;
  const wasmPath = require.resolve('zxing-wasm/dist/reader/zxing_reader.wasm');
  setZXingModuleOverrides({ wasmBinary: fs.readFileSync(wasmPath) });
  _wasmReady = true;
}

async function leerBarcode(buffer) {
  initWasm();
  const blob = new Blob([buffer], { type: 'image/jpeg' });
  const results = await readBarcodes(blob, { tryHarder: true, formats: ['PDF417'], maxNumberOfSymbols: 3 });
  for (const r of results) {
    const campos = (r.text || '').split('@');
    for (const c of campos) {
      const limpio = c.trim().replace(/\D/g, '');
      if (/^\d{7,8}$/.test(limpio)) return limpio;
    }
    const m = (r.text || '').match(/\b(\d{7,8})\b/);
    if (m) return m[1];
  }
  return null;
}

function preprocesar(img, scale, contrast) {
  const canvas = createCanvas(img.width * scale, img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, img.width * scale, img.height * scale);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    g = (g - 128) * contrast + 128;
    g = Math.max(0, Math.min(255, g));
    px[i] = px[i + 1] = px[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
  return canvas.toBuffer('image/png');
}

function ocrPng(pngBuffer, psm) {
  const tmp = path.join(os.tmpdir(), 'ocr_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.png');
  fs.writeFileSync(tmp, pngBuffer);
  try {
    return execFileSync('tesseract', [tmp, 'stdout', '--psm', String(psm)], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function extraerCandidatos(texto) {
  const cands = [];
  const re = /(\d{1,2}[.\s]?\d{3}[.\s]?\d{3})/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const limpio = m[1].replace(/[.\s]/g, '');
    if (limpio.length >= 7 && limpio.length <= 8) cands.push(limpio);
  }
  return cands;
}

async function leerOcr(buffer) {
  const img = await loadImage(buffer);
  const configs = [{ scale: 3, contrast: 1.4 }, { scale: 3, contrast: 2.0 }, { scale: 4, contrast: 1.6 }];
  const psms = [3, 11, 12];
  const votos = {};
  for (const cfg of configs) {
    const png = preprocesar(img, cfg.scale, cfg.contrast);
    for (const psm of psms) {
      for (const c of extraerCandidatos(ocrPng(png, psm))) votos[c] = (votos[c] || 0) + 1;
    }
  }
  const entradas = Object.entries(votos).sort((a, b) => b[1] - a[1]);
  if (entradas.length === 0) return { dni: null, confianza: 0 };
  const [ganador, v] = entradas[0];
  return { dni: ganador, confianza: Math.round(100 * v / (configs.length * psms.length)) };
}

async function leerDni({ front, back }) {
  for (const buf of [front, back].filter(Boolean)) {
    try { const dni = await leerBarcode(buf); if (dni) return { dni, metodo: 'barcode', confianza: 100 }; } catch {}
  }
  for (const buf of [front, back].filter(Boolean)) {
    try { const r = await leerOcr(buf); if (r.dni && r.confianza >= 50) return { dni: r.dni, metodo: 'ocr', confianza: r.confianza }; } catch {}
  }
  return { dni: null, error: 'no_legible' };
}

// --------- /health ---------
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pdf-service' }));

// --------- /leer-dni ---------
// Recibe multipart con "front" y opcionalmente "back". Devuelve { dni, metodo, confianza }
// o { error: 'no_legible' }.
const camposDni = upload.fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 },
]);
app.post('/leer-dni', camposDni, async (req, res) => {
  try {
    const f = req.files || {};
    const front = f.front && f.front[0] ? f.front[0].buffer : null;
    const back = f.back && f.back[0] ? f.back[0].buffer : null;
    if (!front && !back) return res.status(400).json({ error: 'Falta al menos "front" o "back"' });
    const r = await leerDni({ front, back });
    if (r.dni) return res.json(r);
    return res.status(422).json({ error: 'no_legible' });
  } catch (e) {
    res.status(500).json({ error: 'READ_FAIL', detail: String(e.message || e) });
  }
});

// --------- /extraer ---------
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

// --------- /ensamblar ---------
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

    // tipo/dni/cliente: los manda n8n como campos, o los recalculamos
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
    const pages = pdfDoc.getPages();

    // 1) estampar firma (uno o más lugares según el tipo de documento)
    const firmaPng = await pdfDoc.embedPng(firmaBuf);
    const ratio = firmaPng.height / firmaPng.width;
    const stamps = SIG[tipo] || SIG.SDS;
    for (const s of stamps) {
      const p = pages[s.page === 'last' ? pages.length - 1 : s.page];
      if (p) p.drawImage(firmaPng, { x: s.x, y: s.y, width: s.w, height: s.w * ratio });
    }

    // 2) hoja de DNI (solo imágenes, sin texto)
    const frontImg = await pdfDoc.embedJpg(frontBuf);
    const backImg  = await pdfDoc.embedJpg(backBuf);
    const A4W = 595, A4H = 842;
    const dniPage = pdfDoc.addPage([A4W, A4H]);

    const margin = 40, gap = 24;
    const usableW = A4W - margin * 2;
    const slotH = (A4H - margin * 2 - gap) / 2;
    const fit = (iw, ih, bw, bh) => { const s = Math.min(bw / iw, bh / ih); return { w: iw * s, h: ih * s }; };
    const fr = fit(frontImg.width, frontImg.height, usableW, slotH);
    dniPage.drawImage(frontImg, { x: margin + (usableW - fr.w) / 2, y: A4H - margin - fr.h, width: fr.w, height: fr.h });
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
