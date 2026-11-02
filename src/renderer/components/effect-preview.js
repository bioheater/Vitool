// Zeigt das Ergebnis live im Bild: Effekt plus Maske, ohne etwas zu exportieren.
const MAX_WIDTH = 960;
const CHECKER_SIZE = 16;
const PRELOAD_FRAMES = 20;
const REFERENCE_HEIGHT = 720;
const EDGE_LIMIT = 20 / 255;
const EDGE_SPREAD = 1.4;
const EDGE_SLOPE = 60;
const FILTER_ID = 'ai-mask-filter';
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(name, attributes = {}, ...children) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  node.append(...children);
  return node;
}

function checkerPattern(context) {
  const tile = document.createElement('canvas');
  tile.width = CHECKER_SIZE * 2;
  tile.height = CHECKER_SIZE * 2;
  const tileContext = tile.getContext('2d');
  tileContext.fillStyle = '#c9ced8';
  tileContext.fillRect(0, 0, tile.width, tile.height);
  tileContext.fillStyle = '#ffffff';
  tileContext.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  tileContext.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
  return context.createPattern(tile, 'repeat');
}

export class EffectPreview {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.helper = document.createElement('canvas');
    this.maskCanvas = document.createElement('canvas');
    this.base = null;
    this.images = new Map();
    this.pattern = checkerPattern(this.context);

    // Gleiche Rechnung wie im Export: weichzeichnen, neu begrenzen, dann weiche Kante.
    this.svgFilter = svgNode('filter', {
      id: FILTER_ID,
      x: '-10%',
      y: '-10%',
      width: '120%',
      height: '120%',
      'color-interpolation-filters': 'sRGB',
    });
    document.body.append(svgNode('svg', { width: 0, height: 0, class: 'svg-filters' }, this.svgFilter));
  }

  // Neue Maskenbilder liegen unter demselben Namen, die Version verhindert alte Bilder.
  setMasks(base, version) {
    this.base = base;
    this.version = version;
    this.images.clear();
  }

  image(frame) {
    if (!this.images.has(frame)) {
      const image = new Image();
      image.addEventListener('load', () => {
        if (frame === this.frame) this.draw(frame, this.options);
      });
      image.src = `${this.base}/${String(frame).padStart(5, '0')}.png?v=${this.version}`;
      this.images.set(frame, image);
    }
    return this.images.get(frame);
  }

  preload(frame, frameCount) {
    for (let next = frame + 1; next < Math.min(frameCount, frame + PRELOAD_FRAMES); next += 1) this.image(next);
  }

  size() {
    const scale = Math.min(1, MAX_WIDTH / this.video.videoWidth);
    return { width: Math.round(this.video.videoWidth * scale), height: Math.round(this.video.videoHeight * scale) };
  }

  updateFilter(expand, feather) {
    const steps = [];
    if (expand !== 0) {
      const limit = expand > 0 ? EDGE_LIMIT : 1 - EDGE_LIMIT;
      steps.push(
        svgNode('feGaussianBlur', { stdDeviation: Math.max(0.5, Math.abs(expand) / EDGE_SPREAD) }),
        svgNode('feComponentTransfer', {}, svgNode('feFuncA', { type: 'linear', slope: EDGE_SLOPE, intercept: 0.5 - EDGE_SLOPE * limit })),
      );
    }
    if (feather > 0) steps.push(svgNode('feGaussianBlur', { stdDeviation: feather }));
    this.svgFilter.replaceChildren(...steps);
    return steps.length > 0;
  }

  // Liefert die Maske mit erweitertem und weichem Rand.
  processedMask(image, size, options) {
    const scale = size.height / REFERENCE_HEIGHT;
    const hasFilter = this.updateFilter((options.expand ?? 0) * scale, (options.feather ?? 0) * scale);
    if (!hasFilter) return image;

    this.maskCanvas.width = size.width;
    this.maskCanvas.height = size.height;
    const context = this.maskCanvas.getContext('2d');
    context.filter = `url(#${FILTER_ID})`;
    context.drawImage(image, 0, 0, size.width, size.height);
    context.filter = 'none';
    return this.maskCanvas;
  }

  drawEffect({ effect, strength }, size) {
    const { context, video } = this;
    const scale = size.height / REFERENCE_HEIGHT;
    context.filter = 'none';
    if (effect === 'black') {
      context.fillStyle = '#000';
      context.fillRect(0, 0, size.width, size.height);
    } else if (effect === 'pixel') {
      const block = Math.max(2, (strength / 100) * 60 * scale);
      this.helper.width = Math.max(1, Math.round(size.width / block));
      this.helper.height = Math.max(1, Math.round(size.height / block));
      this.helper.getContext('2d').drawImage(video, 0, 0, this.helper.width, this.helper.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(this.helper, 0, 0, size.width, size.height);
      context.imageSmoothingEnabled = true;
    } else {
      context.filter = `blur(${(strength / 100) * 50 * scale}px)`;
      context.drawImage(video, 0, 0, size.width, size.height);
      context.filter = 'none';
    }
  }

  drawMatte(mask, size, objectWhite) {
    const { context } = this;
    context.fillStyle = objectWhite ? '#000' : '#fff';
    context.fillRect(0, 0, size.width, size.height);
    context.globalCompositeOperation = 'destination-out';
    context.drawImage(mask, 0, 0, size.width, size.height);
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = objectWhite ? '#fff' : '#000';
    context.fillRect(0, 0, size.width, size.height);
  }

  draw(frame, options) {
    this.frame = frame;
    this.options = options;
    const image = this.image(frame);
    if (!this.video.videoWidth || !image.complete || !image.naturalWidth) return;

    const size = this.size();
    if (this.canvas.width !== size.width) this.canvas.width = size.width;
    if (this.canvas.height !== size.height) this.canvas.height = size.height;

    const { context } = this;
    const mask = this.processedMask(image, size, options);
    const transparent = options.effect === 'transparent';
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, size.width, size.height);

    if (options.effect === 'overlay') {
      context.globalAlpha = 0.5;
      context.drawImage(mask, 0, 0, size.width, size.height);
      context.globalAlpha = 1;
    } else if (options.effect === 'matte') {
      this.drawMatte(mask, size, options.target !== 'background');
    } else {
      if (transparent) {
        context.fillStyle = this.pattern;
        context.fillRect(0, 0, size.width, size.height);
      } else {
        this.drawEffect(options, size);
      }
      // Die Maske schneidet den Effekt zu, der Rest des Canvas bleibt durchsichtig aufs Video.
      context.globalCompositeOperation = transparent || options.target === 'background' ? 'destination-out' : 'destination-in';
      context.drawImage(mask, 0, 0, size.width, size.height);
    }
    context.globalCompositeOperation = 'source-over';
  }
}
