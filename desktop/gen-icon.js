// Gera build/icon.png (256x256) e build/icon.ico (16/32/48/128/256) com a marca da Loja Gutto:
// quadrado laranja arredondado com "G" branco — a mesma do login e do menu lateral.
// Sem dependências: desenha pixel a pixel (com suavização) e monta PNG/ICO na mão.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COR_LARANJA = [232, 102, 74];  // --accent do painel (#E8664A)
const AMOSTRAS = 4;                   // 4x4 amostras por pixel = bordas suaves

function dentroRetanguloArredondado(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= radius * radius;
}

function dentroG(x, y, size) {
  const cx = size * 0.5, cy = size * 0.5;
  const externo = size * 0.30, traco = size * 0.105, interno = externo - traco;
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Anel com abertura no alto à direita (ângulo entre -50° e +2°, eixo y pra baixo)
  const angulo = Math.atan2(dy, dx) * 180 / Math.PI;
  const naAbertura = angulo > -50 && angulo < 2;
  if (dist >= interno && dist <= externo && !naAbertura) return true;
  // Barra horizontal do G, entrando da direita até o centro
  if (dist <= externo && x >= cx - size * 0.01 && y >= cy - traco * 0.05 && y <= cy + traco * 0.95) return true;
  return false;
}

function renderizar(size) {
  const radius = size * 0.22;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let fundo = 0, letra = 0;
      for (let sy = 0; sy < AMOSTRAS; sy++) {
        for (let sx = 0; sx < AMOSTRAS; sx++) {
          const px = x + (sx + 0.5) / AMOSTRAS, py = y + (sy + 0.5) / AMOSTRAS;
          if (!dentroRetanguloArredondado(px, py, size, radius)) continue;
          fundo++;
          if (dentroG(px, py, size)) letra++;
        }
      }
      const total = AMOSTRAS * AMOSTRAS;
      const i = (y * size + x) * 4;
      if (!fundo) continue; // transparente
      const t = letra / fundo; // mistura laranja → branco
      buf[i] = Math.round(COR_LARANJA[0] + (255 - COR_LARANJA[0]) * t);
      buf[i + 1] = Math.round(COR_LARANJA[1] + (255 - COR_LARANJA[1]) * t);
      buf[i + 2] = Math.round(COR_LARANJA[2] + (255 - COR_LARANJA[2]) * t);
      buf[i + 3] = Math.round(255 * fundo / total);
    }
  }
  return buf;
}

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(tipo, dados) {
  const tipoBuf = Buffer.from(tipo, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([tipoBuf, dados])), 0);
  return Buffer.concat([len, tipoBuf, dados, crcBuf]);
}

function paraPNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // color type RGBA
  ihdr.writeUInt8(0, 10); ihdr.writeUInt8(0, 11); ihdr.writeUInt8(0, 12);

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function paraICO(pngsPorTamanho) {
  const tamanhos = Object.keys(pngsPorTamanho).map(Number).sort((a, b) => a - b);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(tamanhos.length, 4);

  const entries = [];
  const datas = [];
  let offset = 6 + 16 * tamanhos.length;
  for (const size of tamanhos) {
    const png = pngsPorTamanho[size];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    datas.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

const buildDir = path.join(__dirname, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const tamanhos = [16, 32, 48, 128, 256];
const pngs = {};
for (const size of tamanhos) {
  pngs[size] = paraPNG(renderizar(size), size);
}

fs.writeFileSync(path.join(buildDir, 'icon.png'), pngs[256]);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), paraICO(pngs));
console.log('Gerado: build/icon.png e build/icon.ico');

// Mesmo ícone pro sistema aberto no navegador / instalado como aplicativo (Edge ou Chrome)
const publicDir = path.join(__dirname, '..', 'api', 'public');
fs.writeFileSync(path.join(publicDir, 'icone-192.png'), paraPNG(renderizar(192), 192));
fs.writeFileSync(path.join(publicDir, 'icone-512.png'), paraPNG(renderizar(512), 512));
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), paraICO({ 16: pngs[16], 32: pngs[32], 48: pngs[48] }));
console.log('Gerado: api/public/icone-192.png, icone-512.png e favicon.ico');
