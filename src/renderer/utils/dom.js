// Kleine Hilfe zum Erzeugen von Elementen. Texte werden sicher als Text eingefügt.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  });
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

export function icon(path) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const shape = document.createElementNS(svgNs, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

export function pageHeader(title, text) {
  return el('header', { class: 'page-header' }, el('h1', {}, title), el('p', { class: 'muted' }, text));
}
