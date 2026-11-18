// Minimal QR Code encoder (byte mode, versions 1–40, ECC L/M), for the setup QR codes.
// Follows ISO/IEC 18004 as laid out in Project Nayuki's reference implementation (MIT).
// Usage: QR.matrix(text) -> boolean[][];  QR.svg(text, { size }) -> SVG string.
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.QR = value;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  };
  const BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  };
  const FORMAT = { L: 1, M: 0 };
  const rawModules = ver => { let r = (16 * ver + 128) * ver + 64; if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; } return r; };
  const dataCodewords = (ver, ecl) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * BLOCKS[ecl][ver];
  const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; };
  function divisor(degree) {
    const result = new Array(degree).fill(0); result[degree - 1] = 1; let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) { result[j] = mul(result[j], root); if (j + 1 < result.length) result[j] ^= result[j + 1]; }
      root = mul(root, 0x02);
    }
    return result;
  }
  function remainder(data, div) {
    const result = div.map(() => 0);
    for (const b of data) { const factor = b ^ result.shift(); result.push(0); div.forEach((coef, i) => { result[i] ^= mul(coef, factor); }); }
    return result;
  }
  function utf8(text) { return typeof TextEncoder !== 'undefined' ? Array.from(new TextEncoder().encode(text)) : Array.from(Buffer.from(text, 'utf8')); }

  function matrix(text, ecl = 'M') {
    const bytes = utf8(String(text));
    let ver = 1;
    for (; ver <= 40; ver++) { const used = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8; if (used <= dataCodewords(ver, ecl) * 8) break; }
    if (ver > 40) throw new Error('内容过长，无法生成二维码');
    const bits = [], push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(4, 4); push(bytes.length, ver <= 9 ? 8 : 16); bytes.forEach(b => push(b, 8));
    const capacity = dataCodewords(ver, ecl) * 8;
    push(0, Math.min(4, capacity - bits.length)); push(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    const numBlocks = BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver], raw = Math.floor(rawModules(ver) / 8);
    const short = numBlocks - raw % numBlocks, shortLen = Math.floor(raw / numBlocks), div = divisor(eccLen), blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1)); k += dat.length;
      const ecc = remainder(dat, div); if (i < short) dat.push(0); blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= short) codewords.push(block[i]); });

    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
    const align = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      align.push(6); for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
    }
    align.forEach((ax, i) => align.forEach((ay, j) => {
      if (i === 0 && j === 0 || i === 0 && j === align.length - 1 || i === align.length - 1 && j === 0) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = mask => {
      const value = FORMAT[ecl] << 3 | mask; let rem = value;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = (value << 10 | rem) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = ver << 12 | rem;
      for (let i = 0; i < 18; i++) { const dark = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, dark); set(c, a, dark); }
    }
    for (let i = 0, right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) { modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
    const masks = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
    const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && masks[m](x, y)) modules[y][x] = !modules[y][x]; };
    const penalty = () => {
      let score = 0, dark = 0;
      for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const cur = pass ? modules[b][a] : modules[a][b], prev = pass ? modules[b - 1][a] : modules[a][b - 1];
          if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
        }
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = modules[y][x]; if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3; }
      for (const row of modules) for (const c of row) if (c) dark++;
      return score + Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) { apply(m); drawFormat(m); const s = penalty(); if (s < bestScore) { best = m; bestScore = s; } apply(m); }
    apply(best); drawFormat(best);
    return modules;
  }
  function svg(text, { size = 220, margin = 4, ecl = 'M' } = {}) {
    const m = matrix(text, ecl), n = m.length + margin * 2;
    let path = '';
    m.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + margin} ${y + margin}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }
  return { matrix, svg };
});
