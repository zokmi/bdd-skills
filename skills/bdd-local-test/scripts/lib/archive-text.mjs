// Historical PowerShell reports and JSON may use a UTF-16 byte-order mark.
export function decodeArchiveText(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}
