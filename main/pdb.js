// Nova IDE - portable PDB reader (the default debug symbols of .NET SDK projects)
// Gives, for a method token, its source file and the line of every IL offset (sequence points).
// Format: ECMA-335 metadata ("BSJB") with #Pdb, #~, #Strings, #Blob, #GUID streams;
// tables Document (0x30) and MethodDebugInformation (0x31). See the Portable PDB spec (dotnet/runtime).
'use strict';
const fs = require('fs');

function compressedU(b, p) {
  const b0 = b[p];
  if ((b0 & 0x80) === 0) return [b0, p + 1, 1];
  if ((b0 & 0xC0) === 0x80) return [((b0 & 0x3F) << 8) | b[p + 1], p + 2, 2];
  return [(((b0 & 0x1F) << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0, p + 4, 4];
}
function compressedS(b, p) {
  const [u, q, len] = compressedU(b, p);
  let v = u >>> 1;
  if (u & 1) v -= len === 1 ? 0x40 : len === 2 ? 0x2000 : 0x10000000;
  return [v, q];
}
const bitCount = (n) => { let c = 0; while (n) { c += Number(n & 1n); n >>= 1n; } return c; };

function parsePdb(buf) {
  if (buf.readUInt32LE(0) !== 0x424A5342) throw new Error('not a portable PDB (it may be a Windows PDB: set <DebugType>portable</DebugType>)');
  const verLen = buf.readUInt32LE(12);
  let p = 16 + verLen;
  p += 2; // flags
  const nStreams = buf.readUInt16LE(p); p += 2;
  const streams = {};
  for (let i = 0; i < nStreams; i++) {
    const off = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    p += 8;
    let e = p;
    while (buf[e]) e++;
    const name = buf.toString('latin1', p, e);
    p = (e + 4) & ~3;
    streams[name] = buf.subarray(off, off + size);
  }
  const tbl = streams['#~'] || streams['#-'];
  const blob = streams['#Blob'] || Buffer.alloc(0);
  const pdbS = streams['#Pdb'];
  if (!tbl || !pdbS) throw new Error('no PDB tables');
  // row counts of the type system tables (in the DLL) referenced by the PDB
  const rows = new Array(64).fill(0);
  const refMask = pdbS.readBigUInt64LE(24);
  let q = 32;
  for (let i = 0; i < 64; i++) if (refMask & (1n << BigInt(i))) { rows[i] = pdbS.readUInt32LE(q); q += 4; }
  const heap = tbl[6];
  const valid = tbl.readBigUInt64LE(8);
  q = 24;
  for (let i = 0; i < 64; i++) if (valid & (1n << BigInt(i))) { rows[i] = tbl.readUInt32LE(q); q += 4; }
  void bitCount;
  const blobIdx = heap & 4 ? 4 : 2, guidIdx = heap & 2 ? 4 : 2;
  const idx = (t) => (rows[t] < 0x10000 ? 2 : 4);
  const rd = (b, o, n) => (n === 2 ? b.readUInt16LE(o) : b.readUInt32LE(o));
  const blobAt = (i) => { if (!i) return Buffer.alloc(0); const [len, s] = compressedU(blob, i); return blob.subarray(s, s + len); };
  // Document table
  const docs = [null];
  const docRow = blobIdx + guidIdx + blobIdx + guidIdx;
  for (let r = 0; r < rows[0x30]; r++, q += docRow) {
    const nb = blobAt(rd(tbl, q, blobIdx));
    let sep = '', s = 0;
    if (nb.length) { sep = nb[0] ? String.fromCharCode(nb[0]) : ''; s = 1; }
    const parts = [];
    while (s < nb.length) { const [bi, s2] = compressedU(nb, s); s = s2; parts.push(bi ? blobAt(bi).toString('utf8') : ''); }
    docs.push(parts.join(sep));
  }
  // MethodDebugInformation: row i = MethodDef i
  const docIdx = idx(0x30);
  const methods = new Map();
  const mdiRow = docIdx + blobIdx;
  for (let r = 1; r <= rows[0x31]; r++, q += mdiRow) {
    const doc = rd(tbl, q, docIdx);
    const sp = rd(tbl, q + docIdx, blobIdx);
    if (sp) methods.set(r, { doc, sp });
  }
  return { docs, methods, blobAt };
}

// sequence points of one method: [{ il, line, col, endLine, file }] (hidden points left out)
function sequencePoints(pdb, rid) {
  const m = pdb.methods.get(rid);
  if (!m) return null;
  if (m.points) return m.points;
  const b = pdb.blobAt(m.sp);
  let p = 0;
  [, p] = compressedU(b, p); // local signature
  let doc = m.doc;
  if (!doc) [doc, p] = compressedU(b, p);
  const pts = [];
  let il = 0, line = 0, col = 0, first = true, firstVisible = true;
  while (p < b.length) {
    let d;
    [d, p] = compressedU(b, p);
    if (!first && d === 0) { [doc, p] = compressedU(b, p); continue; } // document record
    il = first ? d : il + d;
    first = false;
    let dLines, dCols;
    [dLines, p] = compressedU(b, p);
    if (dLines === 0) [dCols, p] = compressedU(b, p); else [dCols, p] = compressedS(b, p);
    if (dLines === 0 && dCols === 0) continue; // hidden
    if (firstVisible) { [line, p] = compressedU(b, p); [col, p] = compressedU(b, p); firstVisible = false; } else { let a, c; [a, p] = compressedS(b, p); [c, p] = compressedS(b, p); line += a; col += c; }
    pts.push({ il, line, col, endLine: line + dLines, file: pdb.docs[doc] });
  }
  m.points = pts;
  return pts;
}
function lineForIL(points, ilOffset) {
  if (!points || !points.length) return null;
  let best = points[0];
  for (const x of points) { if (x.il <= ilOffset) best = x; else break; }
  return best;
}

const cache = new Map(); // path -> { mtime, pdb } | { error }
function loadPdb(path) {
  try {
    const st = fs.statSync(path);
    const c = cache.get(path);
    if (c && c.mtime === st.mtimeMs) return c.pdb;
    const pdb = parsePdb(fs.readFileSync(path));
    cache.set(path, { mtime: st.mtimeMs, pdb });
    return pdb;
  } catch { return null; }
}

module.exports = { parsePdb, sequencePoints, lineForIL, loadPdb, compressedU, compressedS };
