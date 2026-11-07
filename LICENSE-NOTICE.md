# Vitool — License Notice

## Abbreviation

AGPL-3.0-only

## Notice

Copyright 2026-present bioheater.

Vitool is **free and open-source software, licensed under the GNU Affero
General Public License, Version 3 (AGPL-3.0)**. You are free to use, copy,
modify and redistribute it, including for commercial purposes.

Because this is the **Affero** GPL, one additional obligation applies: if you
modify Vitool and make that modified version available to others, including
over a network, you must also offer them the complete corresponding source
code of your modified version under the same AGPL-3.0 terms.

If you want to use Vitool or parts of it in a closed-source product without
these obligations, a separate commercial license may be possible. Please get
in touch through the GitHub repository.

(This notice is a plain-language summary. The binding terms are the full
GNU AGPL-3.0 text in [`LICENSE`](LICENSE).)

## Name and logo

The AGPL-3.0 covers the source code, not the name or the logo. "Vitool" and
the Vitool logo identify the original project by bioheater.

- You may use the name to refer to the original project, for example
  "works with Vitool" or "based on Vitool".
- A modified version or fork must use its own name and its own logo, so that
  nobody mistakes it for the original or thinks it is endorsed by it.
- Unmodified copies of an official release may keep the name and logo.

For any other use of the name or logo, please ask first through the GitHub
repository.

## Third-party components

These components keep their own licenses. Vitool does not relicense them.

### Shipped with the installer

| Component | License |
| --- | --- |
| [Electron](https://github.com/electron/electron) | MIT |
| [hls.js](https://github.com/video-dev/hls.js) | Apache-2.0 |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT |

### Downloaded on request into Vitool's data folder

Vitool downloads these programs from their official release pages when you
choose to set them up. They run as separate programs.

| Component | License |
| --- | --- |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense |
| [FFmpeg](https://ffmpeg.org) (build by [yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds)) | GPL (GPL build) |
| [Deno](https://github.com/denoland/deno) | MIT |
| [uv](https://github.com/astral-sh/uv) | MIT or Apache-2.0 |
| [Python](https://www.python.org) | PSF License |

### Optional add-ons (AI Mask, Transcribe)

| Component | License |
| --- | --- |
| [PyTorch](https://github.com/pytorch/pytorch) | BSD-3-Clause |
| [SAM 2](https://github.com/facebookresearch/sam2) by Meta, code and SAM 2.1 checkpoints | Apache-2.0 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) | MIT |
| [Whisper](https://github.com/openai/whisper) by OpenAI, models converted by [Systran](https://huggingface.co/Systran) and [Dropbox](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo) | MIT |
| [pyannote.audio](https://github.com/pyannote/pyannote-audio) | MIT |
| [pyannote speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) model by pyannote | CC-BY-4.0 |

The pyannote model requires attribution under CC-BY-4.0: speaker detection in
Vitool uses *speaker-diarization-community-1* by pyannote, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Responsible use

Only download, edit or transcribe content you have the right to use. The
terms of the websites you download from and the copyright of the content
still apply.
