// Vergleicht Versionen wie 0.3.0 oder 2025.10.22.1 Teil für Teil als Zahl.
function isNewer(version, than) {
  const parts = (value) => String(value ?? '').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(version);
  const b = parts(than);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

module.exports = { isNewer };
