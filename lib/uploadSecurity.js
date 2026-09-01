'use strict';
const path = require('path');

const IMAGE_TYPES = {
  jpeg: { mime: 'image/jpeg', exts: new Set(['.jpg', '.jpeg']) },
  png: { mime: 'image/png', exts: new Set(['.png']) },
  webp: { mime: 'image/webp', exts: new Set(['.webp']) },
};
const EVIDENCE_TYPES = {
  ...IMAGE_TYPES,
  pdf: { mime: 'application/pdf', exts: new Set(['.pdf']) },
  text: { mime: 'text/plain', exts: new Set(['.txt']) },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: new Set(['.docx']) },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', exts: new Set(['.xlsx']) },
};

function starts(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}
function ascii(buffer, start, length) {
  return Buffer.isBuffer(buffer) && buffer.length >= start + length
    ? buffer.subarray(start, start + length).toString('ascii')
    : '';
}
function zipEntryNames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 46) return new Set();
  const names = new Set();
  // Read central-directory entries rather than trusting arbitrary strings in
  // the archive body. This is sufficient to prove the OOXML package shape
  // without extracting attacker-controlled files onto disk.
  for (let offset = 0; offset <= buffer.length - 46;) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) { offset += 1; continue; }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || nameLength < 1) return new Set();
    names.add(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/'));
    offset = end;
  }
  return names;
}
function officeType(buffer) {
  const names = zipEntryNames(buffer);
  if (!names.has('[Content_Types].xml')) return null;
  if (names.has('word/document.xml')) return 'docx';
  if (names.has('xl/workbook.xml')) return 'xlsx';
  return null;
}
function detectedType(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  if (starts(buffer, [0xff,0xd8,0xff])) return 'jpeg';
  if (starts(buffer, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) return 'png';
  if (ascii(buffer,0,4)==='RIFF' && ascii(buffer,8,4)==='WEBP') return 'webp';
  if (ascii(buffer,0,5)==='%PDF-') return 'pdf';
  if (starts(buffer,[0x50,0x4b,0x03,0x04]) || starts(buffer,[0x50,0x4b,0x05,0x06]) || starts(buffer,[0x50,0x4b,0x07,0x08])) return officeType(buffer) || 'zip';
  // Plain text is intentionally conservative: reject NUL/control-heavy data.
  const sample=buffer.subarray(0,Math.min(buffer.length,4096));
  let controls=0;
  for(const b of sample){if(b===0)return null;if(b<9||(b>13&&b<32))controls+=1;}
  if(sample.length && controls/sample.length<0.01)return 'text';
  return null;
}
function safeExt(name){return path.extname(String(name||'')).toLowerCase();}
function validateMemoryUpload(file,{kind='image'}={}){
  if(!file||!Buffer.isBuffer(file.buffer))return {ok:false,error:'Upload data is missing'};
  const ext=safeExt(file.originalname),claimed=String(file.mimetype||'').toLowerCase();
  const allowed=kind==='evidence'?EVIDENCE_TYPES:IMAGE_TYPES;
  const detected=detectedType(file.buffer);
  if(detected==='zip')return {ok:false,error:'Unsupported or malformed Office archive upload'};
  const spec=allowed[detected];
  if(!spec)return {ok:false,error:`Unsupported ${kind==='evidence'?'evidence file':'image'} format`};
  if(!spec.exts.has(ext))return {ok:false,error:'File extension does not match the uploaded content'};
  if(claimed && claimed!==spec.mime){
    // Browsers sometimes label plain text as octet-stream; everything else
    // must agree with the detected file signature.
    if(!(detected==='text'&&claimed==='application/octet-stream'))return {ok:false,error:'File type does not match the uploaded content'};
  }
  return {ok:true,type:detected,mime:spec.mime,extension:[...spec.exts][0]};
}
function imageMulterFilter(req,file,cb){
  const ext=safeExt(file.originalname),mime=String(file.mimetype||'').toLowerCase();
  const permitted=(ext==='.jpg'||ext==='.jpeg'||ext==='.png'||ext==='.webp')&&['image/jpeg','image/png','image/webp'].includes(mime);
  cb(null,permitted);
}
function evidenceMulterFilter(req,file,cb){
  const ext=safeExt(file.originalname),mime=String(file.mimetype||'').toLowerCase();
  const spec=Object.values(EVIDENCE_TYPES).find(s=>s.exts.has(ext));
  cb(null,!!spec && (mime===spec.mime || (ext==='.txt'&&mime==='application/octet-stream')));
}

module.exports={IMAGE_TYPES,EVIDENCE_TYPES,detectedType,zipEntryNames,officeType,validateMemoryUpload,imageMulterFilter,evidenceMulterFilter,safeExt};
