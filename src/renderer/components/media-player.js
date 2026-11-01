// Player für lokale Dateien. Kann er ein Format nicht abspielen, wird eine Vorschau-Kopie erstellt.
import { el } from '../utils/dom.js';

export class MediaPlayer {
  constructor() {
    this.media = null;
    this.previewRequested = false;
    this.video = el('video', { controls: true, preload: 'metadata' });
    this.hint = el('p', { class: 'muted preview-hint', hidden: true });
    this.root = el('div', { class: 'preview' }, this.video, this.hint);

    this.video.addEventListener('error', () => {
      if (this.video.getAttribute('src')) this.requestPreview();
    });
    this.video.addEventListener('loadedmetadata', () => {
      if (this.media?.hasVideo && this.video.videoWidth === 0) this.requestPreview();
    });
  }

  load(media) {
    this.media = media;
    this.previewRequested = false;
    this.hint.hidden = true;
    this.video.hidden = false;
    this.video.src = media.url;
  }

  clear() {
    this.media = null;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  async requestPreview() {
    if (this.previewRequested || !this.media?.hasVideo) return;
    this.previewRequested = true;
    const { path } = this.media;

    this.video.hidden = true;
    this.hint.textContent = 'Dieses Format kann nicht direkt abgespielt werden. Es wird eine Vorschau erstellt …';
    this.hint.hidden = false;

    const response = await window.vitool.invoke('media:preparePreview', path);
    if (this.media?.path !== path) return;

    if (response.ok) {
      this.hint.hidden = true;
      this.video.hidden = false;
      this.video.src = response.url;
    } else {
      this.hint.textContent = 'Keine Vorschau möglich. Die Bearbeitung funktioniert trotzdem.';
    }
  }
}
