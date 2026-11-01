export function folderOf(filePath) {
  return filePath.slice(0, Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')));
}
