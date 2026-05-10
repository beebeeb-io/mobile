export interface PdfImagePage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

type PdfChunk = string | Uint8Array;

const encoder = new TextEncoder();

function ascii(input: string): Uint8Array {
  return encoder.encode(input);
}

function byteLength(chunk: PdfChunk): number {
  return typeof chunk === 'string' ? ascii(chunk).length : chunk.length;
}

function concatChunks(chunks: PdfChunk[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + byteLength(chunk), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? ascii(chunk) : chunk;
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}

function pdfNumber(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2).replace(/\.?0+$/, '') : '0';
}

function pageSizeForImage(width: number, height: number): { width: number; height: number } {
  return width > height ? { width: 792, height: 612 } : { width: 612, height: 792 };
}

function imagePlacement(
  imageWidth: number,
  imageHeight: number,
  pageWidth: number,
  pageHeight: number,
): { width: number; height: number; x: number; y: number } {
  const margin = 24;
  const maxWidth = pageWidth - margin * 2;
  const maxHeight = pageHeight - margin * 2;
  const scale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    width,
    height,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
  };
}

export function buildJpegPdfBytes(pages: PdfImagePage[]): Uint8Array {
  if (pages.length === 0) {
    throw new Error('Cannot build a PDF without pages');
  }

  const chunks: PdfChunk[] = ['%PDF-1.4\n%\xFF\xFF\xFF\xFF\n'];
  const offsets: number[] = [0];
  let position = chunks.reduce((sum, chunk) => sum + byteLength(chunk), 0);

  const add = (chunk: PdfChunk) => {
    chunks.push(chunk);
    position += byteLength(chunk);
  };

  const addObject = (objectNumber: number, body: PdfChunk[]) => {
    offsets[objectNumber] = position;
    add(`${objectNumber} 0 obj\n`);
    for (const part of body) add(part);
    add('\nendobj\n');
  };

  const pageObjectNumbers = pages.map((_, index) => 3 + index * 3);
  const maxObjectNumber = 2 + pages.length * 3;

  addObject(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  addObject(2, [
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ]);

  pages.forEach((page, index) => {
    const pageObject = 3 + index * 3;
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    const pageSize = pageSizeForImage(page.width, page.height);
    const placement = imagePlacement(page.width, page.height, pageSize.width, pageSize.height);
    const imageName = `Im${index + 1}`;
    const content = [
      'q\n',
      `${pdfNumber(placement.width)} 0 0 ${pdfNumber(placement.height)} ${pdfNumber(placement.x)} ${pdfNumber(placement.y)} cm\n`,
      `/${imageName} Do\n`,
      'Q\n',
    ].join('');

    addObject(pageObject, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageSize.width} ${pageSize.height}] `,
      `/Resources << /XObject << /${imageName} ${imageObject} 0 R >> >> `,
      `/Contents ${contentObject} 0 R >>`,
    ]);

    addObject(imageObject, [
      `<< /Type /XObject /Subtype /Image /Width ${Math.max(1, Math.round(page.width))} `,
      `/Height ${Math.max(1, Math.round(page.height))} /ColorSpace /DeviceRGB `,
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      page.jpeg,
      '\nendstream',
    ]);

    addObject(contentObject, [
      `<< /Length ${ascii(content).length} >>\nstream\n`,
      content,
      'endstream',
    ]);
  });

  const xrefOffset = position;
  add(`xref\n0 ${maxObjectNumber + 1}\n`);
  add('0000000000 65535 f \n');
  for (let objectNumber = 1; objectNumber <= maxObjectNumber; objectNumber++) {
    const offset = offsets[objectNumber];
    if (typeof offset !== 'number') {
      throw new Error(`Missing PDF object offset for ${objectNumber}`);
    }
    add(`${offset.toString().padStart(10, '0')} 00000 n \n`);
  }
  add(`trailer\n<< /Size ${maxObjectNumber + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return concatChunks(chunks);
}
