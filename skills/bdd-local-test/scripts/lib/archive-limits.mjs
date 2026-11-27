export const entryLimit = 20000;
export const byteLimit = 4 * 1024 ** 3;
export const manifestLimit = 8 * 1024 ** 2;

export function sequentialReadOptions(size) {
  return size >= 8 * 1024 ** 2 ? { highWaterMark: 1024 ** 2 } : undefined;
}

export function safePathComponent(name) {
  if (typeof name !== 'string' || !name || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name) ||
      /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error('封存含不安全的路徑：' + name);
  }
  return name;
}
