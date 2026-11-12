/**
 * A synthetic multi-line PDF whose pages carry `/Rotate`, for grouping and wrap tests.
 *
 * Each page is 12 lines of 10 pt body text. Generated in memory so the suite and
 * `bench:pdf:layout` share one fixture without a committed binary.
 */
export function rotatedBodyPdf(rotations: readonly number[] = [90, 270]): Uint8Array {
  const lines = Array.from({ length: 12 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return `(Line ${number} of the sample body.) Tj`;
  });
  const ops = ['BT', '/F1 10 Tf', '50 520 Td', lines[0] ?? ''];
  for (const line of lines.slice(1)) {
    ops.push('0 -14 Td', line);
  }
  ops.push('ET');
  const content = `${ops.join('\n')}\n`;

  const parts: Uint8Array[] = [];
  const offsets = new Map<number, number>();
  let length = 0;
  const encoder = new TextEncoder();
  const push = (value: string): void => {
    const buffer = encoder.encode(value);
    parts.push(buffer);
    length += buffer.length;
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const fontId = 3;
  let nextId = 4;
  const pageIds: number[] = [];

  offsets.set(fontId, length);
  push(`${String(fontId)} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  for (const rotation of rotations) {
    const contentId = nextId;
    const pageId = nextId + 1;
    nextId += 2;
    pageIds.push(pageId);

    offsets.set(contentId, length);
    push(
      `${String(contentId)} 0 obj\n<< /Length ${String(content.length)} >>\nstream\n${content}endstream\nendobj\n`,
    );
    offsets.set(pageId, length);
    push(
      `${String(pageId)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Rotate ${String(rotation)} /Resources << /Font << /F1 ${String(fontId)} 0 R >> >> /Contents ${String(contentId)} 0 R >>\nendobj\n`,
    );
  }

  offsets.set(2, length);
  push(
    `2 0 obj\n<< /Type /Pages /Count ${String(pageIds.length)} /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] >>\nendobj\n`,
  );
  offsets.set(1, length);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const xrefStart = length;
  let xref = `xref\n0 ${String(nextId)}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id += 1) {
    xref += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${String(nextId)} /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`,
  );

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
