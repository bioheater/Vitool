<p align="center">
  <img src="assets/icon.svg" alt="Vitool logo" width="96" height="96">
</p>

<h1 align="center">Vitool</h1>

<p align="center">
  An all-in-one video toolbox for Windows: download, cut, convert, clean up audio, censor, mask, transcribe and summarize.<br>
  Everything runs on your own computer. Nothing is uploaded.
</p>

<p align="center">
  <a href="https://github.com/bioheater/Vitool/releases/latest"><b>Download for Windows</b></a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#license">License</a>
</p>

![Vitool in under a minute: download, AI mask, green screen, removing pauses, censoring, transcribing and summarizing](docs/screenshots/demo.avif)

## Features

### Download
- Paste a link from YouTube, Instagram, TikTok and many other sites, pick the quality, done
- Audio only, single sections of a video, or whole playlists
- Pick the audio language of videos with several, such as YouTube dubs, or download several languages
  at once into one MKV with every track labeled
- Embed subtitles and chapters into the file, and skip sponsor segments, self-promotion and calls to subscribe
  with [SponsorBlock](https://sponsor.ajay.app)
- Paste many links at once or drop a text file with links to get a list to choose from
- If yt-dlp doesn't know a site, Vitool finds the video on the page by itself, also on overview pages with many episodes,
  and offers the player's subtitles to embed into the file, also ones the player hasn't loaded yet.
  Ads on these pages are blocked, so banners don't cover the player
- yt-dlp keeps itself up to date, and an optional YouTube sign-in helps with age-restricted or private videos
- Download history with quick access to your files

![Checking a YouTube link before downloading](docs/screenshots/download.png)

### Cut
- Lossless cuts in seconds, or frame-exact cuts when precision matters
- Several sections at once, saved separately or joined into one file
- Play just the kept sections in a row to check the result before saving

### Convert
- MP4, MKV, WebM, MP3, WAV and more
- Target size, for example under 25 MB for sending
- Many files or a whole folder at once

### Tools
- Create GIFs and save still images
- Burn SRT, ASS or VTT subtitles into the picture
- **Censor**: blur, pixelate or black out areas with moving, resizable and rotatable fields.
  Keyframes for position, size, strength and rotation, soft edges, several visible
  sections per field, and a choice between gliding and jumping between keyframes
- **Green screen**: key out green or blue with a live preview. Vitool finds the color and a fitting
  tolerance by itself and removes the color fringe. Replace the background with a color, an image,
  a video, or keep it transparent as WebM or ProRes 4444
- **Adjust**: rotate, flip, remove black borders, stabilize shaky footage and change the speed, all in one pass
  with a live preview. Speed changes keep the pitch of voices

![Censoring with a rotated, pixelated field](docs/screenshots/censor.png)

![Green screen with the bunny from Big Buck Bunny in front of a new sky](docs/screenshots/greenscreen.png)

### MKV
- Remove unneeded audio tracks and subtitles without re-encoding
- Set language, name, default and forced flags
- Add tracks or save them as separate files
- **Align audio tracks**: Vitool finds the offset of a dub by itself and also fixes PAL versions
  that slowly drift apart
- Match a quiet track to the original volume, or make it louder or quieter by hand
- Shift audio and subtitle tracks by a few seconds
- Set up one episode and apply the same track choice to the rest of the season in one go

![Aligning a German dub with PAL speed detection](docs/screenshots/mkv.png)

### Audio
- **Remove pauses**: silent parts are found from the levels and cut out, picture and sound stay in sync.
  While playing, Vitool already skips them, so you hear the result before exporting
- **Reduce noise**: Vitool learns the noise from the quietest spot of the file, which also works for fans and hum
- **Even out loudness** for online video (−14 LUFS), podcasts (−16) or TV (−23)
- A short before-and-after preview for noise and loudness
- Extract the audio track as MP3, M4A, WAV, FLAC or unchanged

![Removing pauses and evening out loudness](docs/screenshots/audio.png)

### AI Mask (optional add-on)
- Click an object, the AI finds its shape and tracks it through the video (SAM 2.1 by Meta)
- Blur the object or the background, or cut it out

### Transcribe (optional add-on)
- Speech recognition with Whisper, also straight from a link
- Tells speakers apart (pyannote), rename them and fix mistakes with a click
- Translate any language into English
- Save as SRT, VTT, text or JSON, or burn styled subtitles into the video
- Transcribe many files or a whole folder in one go

![Transcription with two speakers](docs/screenshots/transcribe.png)

### Summarize
- What a video is about: a short summary, the key points and chapters with time stamps
- Works with a link (Vitool uses the video's subtitles), subtitle files, transcripts from Transcribe,
  or videos with embedded subtitles. Without any text, Whisper recognizes the speech first
- Runs locally with [Ollama](https://ollama.com) and the model of your choice. Long videos are read in parts
- Or use an online service with your own API key: OpenAI, Anthropic, Google Gemini, OpenRouter or any
  OpenAI-compatible service. Only the text is sent, never the video or sound, and the key is stored encrypted
- **Ask questions about the video** in a chat: follow up, have something explained or discuss it. Answers point
  to time stamps you can click to jump to that moment. For long videos the chat picks the matching passages
- Copy the result or save it together with the chat as Markdown

![Summary of Tears of Steel with key points and chapters](docs/screenshots/summary.png)

### And also
- Seven color themes with a subtle glass effect on Windows 11
- Interface in English, German, Spanish, French, Portuguese (Brazil), Hindi, Japanese and Simplified Chinese
- One preview volume for every player, remembered between sessions
- Send a file from one area to the next, for example from Download to Cut
- Continue in another area without saving in between: Vitool keeps a draft and only saves when you export
- Updates from GitHub with one click in the settings

![Settings with color themes](docs/screenshots/settings.png)

## Installation

1. Download `Vitool-Setup-x.y.z.exe` from the [latest release](https://github.com/bioheater/Vitool/releases/latest).
2. Run it. Windows may show **"Windows protected your PC"** because the installer is not code-signed yet.
   Click **More info** and then **Run anyway**.
3. On first start, Vitool offers to set up the programs it needs (yt-dlp, FFmpeg and Deno, about 270 MB).
   It downloads them from their official releases, checks them and keeps them in its own folder.
   If you prefer, you can install them yourself with winget instead.

**Requirements:** Windows 10 or 11, 64-bit. An NVIDIA graphics card makes AI Mask and Transcribe much faster,
but they also run on the processor.

The add-ons AI Mask and Transcribe are optional and downloaded only when you set them up inside Vitool.
They bring their own Python, so you do not need to install anything else.

## Privacy

Vitool processes all videos, audio and transcripts locally. It only goes online to download what you ask for,
to set up its programs and add-ons, and to check for updates on GitHub. If you choose an online service for
summaries, the text of the video (subtitles or transcript, title and description) is sent to that service.
If you turn on SponsorBlock for a download, the video ID is sent to sponsor.ajay.app to look up its segments.
When Vitool opens a page to find a video on it, it blocks ads there. The ad filter lists come from the
[Ghostery adblocker](https://github.com/ghostery/adblocker) on GitHub and are refreshed at most once a week.

## Building from source

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/bioheater/Vitool.git
cd Vitool
npm install
npm start
```

`npm run installer` builds the Windows installer into `dist`.

## Contributing

Bug reports and ideas are welcome as [issues](https://github.com/bioheater/Vitool/issues).
If you would like to contribute code, please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

Vitool is free and open-source software under the [GNU AGPL-3.0](LICENSE).
You may use, change and share it, also commercially. If you share a modified version, including over a network,
you have to make its full source code available under the same license.

The name **Vitool** and the logo are not covered by the AGPL: modified versions need their own name and logo.
Details, the licenses of all third-party components and the required attributions are in
[LICENSE-NOTICE.md](LICENSE-NOTICE.md).

The screenshots show the Blender open movies *Big Buck Bunny* and *Tears of Steel*,
© Blender Foundation ([blender.org](https://www.blender.org)), licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

## Responsible use

Only download, edit or transcribe content you have the right to use.
Copyright and the rules of the websites you download from still apply.
