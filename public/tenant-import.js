const decoder = new TextDecoder();
const headings = ["किरायेदार का नाम","मोबाइल नंबर","किरायेदार आईडी नंबर","पता","व्यापार"];
const fields = ['name','phone','tenant_id_number','address','business'];
const xmlLimit = 4*1024*1024;

function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let footer = bytes.length-22;
  while (footer>=Math.max(0,bytes.length-65557) && view.getUint32(footer,true)!==0x06054b50) footer--;
  if (footer<0 || view.getUint32(footer,true)!==0x06054b50) throw new Error('सही .xlsx फ़ाइल चुनें।');
  let pos = view.getUint32(footer+16,true);
  const entries = new Map();
  for (let index=0;index<view.getUint16(footer+10,true);index++) {
    if (view.getUint32(pos,true)!==0x02014b50) throw new Error('Excel फ़ाइल नहीं पढ़ी जा सकी।');
    const nameLength = view.getUint16(pos+28,true);
    const name = decoder.decode(bytes.subarray(pos+46,pos+46+nameLength));
    entries.set(name,{method:view.getUint16(pos+10,true),size:view.getUint32(pos+24,true),
      compressed:view.getUint32(pos+20,true),offset:view.getUint32(pos+42,true)});
    pos+=46+nameLength+view.getUint16(pos+30,true)+view.getUint16(pos+32,true);
  }
  return {entries,view};
}

async function readXml(bytes, directory, name) {
  const entry = directory.entries.get(name);
  if (!entry) return null;
  const {view} = directory;
  if (entry.size>xmlLimit || view.getUint32(entry.offset,true)!==0x04034b50) throw new Error('Excel फ़ाइल बहुत बड़ी है या ख़राब है।');
  const start=entry.offset+30+view.getUint16(entry.offset+26,true)+view.getUint16(entry.offset+28,true);
  const data=bytes.subarray(start,start+entry.compressed);
  let xml;
  if (entry.method===0) {
    xml=decoder.decode(data);
  } else if (entry.method===8) {
    const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader=stream.getReader();
    let length=0;
    xml='';
    const textDecoder=new TextDecoder();
    try {
      for (;;) {
        const {value,done}=await reader.read();
        if (done) break;
        length+=value.length;
        if (length>xmlLimit) throw new Error('Excel फ़ाइल बहुत बड़ी है।');
        xml+=textDecoder.decode(value,{stream:true});
      }
      xml+=textDecoder.decode();
    } finally {await reader.cancel();}
  } else {
    throw new Error('इस Excel फ़ाइल का फ़ॉर्मेट समर्थित नहीं है।');
  }
  const document=new DOMParser().parseFromString(xml,'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Excel फ़ाइल नहीं पढ़ी जा सकी।');
  return document;
}

export async function readTenantWorkbook(file) {
  if (!file?.size || file.size>5*1024*1024 || !/\.xlsx$/i.test(file.name)) {
    throw new Error('5 MB तक की .xlsx फ़ाइल चुनें।');
  }
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());
    const directory=zipDirectory(bytes);
    const [sheet,strings]=await Promise.all([readXml(bytes,directory,'xl/worksheets/sheet1.xml'),readXml(bytes,directory,'xl/sharedStrings.xml')]);
    if (!sheet) throw new Error('डाउनलोड किया हुआ Excel टेम्पलेट इस्तेमाल करें।');
    const combineText=node=>[...node.getElementsByTagNameNS('*','t')].map(t=>t.textContent).join('');
    const dictionary=strings?[...strings.getElementsByTagNameNS('*','si')].map(combineText):[];
    const rows=[];
    for (const row of sheet.getElementsByTagNameNS('*','row')) {
      const line=Number(row.getAttribute('r'));
      const values=Array(5).fill('');
      for (const cell of row.getElementsByTagNameNS('*','c')) {
        const match=/^([A-E])\d+$/.exec(cell.getAttribute('r') || '');
        if (!match) continue;
        const type=cell.getAttribute('t');
        const value=cell.getElementsByTagNameNS('*','v')[0]?.textContent || '';
        values[match[1].charCodeAt(0)-65]=(type==='s'?dictionary[Number(value)] || '':type==='inlineStr'?combineText(cell):value).trim();
      }
      if (line===1) {
        if (headings.some((heading,i)=>values[i]!==heading)) throw new Error('Excel टेम्पलेट की पहली पंक्ति के शीर्षक न बदलें।');
        rows.push(null);
      } else if (values.some(Boolean)) {
        rows.push({line,...Object.fromEntries(fields.map((field,i)=>[field,values[i]]))});
      }
    }
    if (rows.shift()!==null || !rows.length) throw new Error('टेम्पलेट में कम से कम एक किरायेदार की जानकारी भरें।');
    if (rows.length>500) throw new Error('एक बार में अधिकतम 500 किरायेदार इम्पोर्ट करें।');
    return rows;
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw new Error('Excel फ़ाइल नहीं पढ़ी जा सकी।');
    throw error;
  }
}
