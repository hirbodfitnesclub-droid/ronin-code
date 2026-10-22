import { badRequest } from './util.js';

/**
 * Minimal multipart/form-data parser (no dependency) — just enough for the
 * receipt claim upload: text fields + one file part, binary-safe.
 * Returns { fields: {name: string}, files: {name: {filename, contentType, data}} }.
 */
export function parseMultipart(buffer, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentTypeHeader || '');
  if (!m) throw badRequest('invalid_multipart', 'Expected multipart/form-data with a boundary.');
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const fields = {};
  const files = {};

  let pos = buffer.indexOf(boundary);
  if (pos === -1) throw badRequest('invalid_multipart', 'Malformed multipart body.');
  pos += boundary.length;

  while (pos < buffer.length) {
    // Each part starts after CRLF; the body ends at `--boundary--`.
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break; // "--" terminator
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = buffer.toString('utf8', pos, headerEnd);
    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers);
    if (!disp) break;
    const name = /name="([^"]*)"/.exec(disp[1])?.[1];
    const filename = /filename="([^"]*)"/.exec(disp[1])?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase();

    const dataStart = headerEnd + 4;
    const next = buffer.indexOf(boundary, dataStart);
    if (next === -1) break;
    // Part data ends at the CRLF right before the next boundary.
    const dataEnd = Math.max(dataStart, next - 2);
    const data = buffer.subarray(dataStart, dataEnd);
    if (name) {
      if (filename !== undefined) {
        files[name] = { filename, contentType: type || 'application/octet-stream', data: Buffer.from(data) };
      } else {
        fields[name] = data.toString('utf8');
      }
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}
