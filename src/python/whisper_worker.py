# Transkribiert eine Tonspur mit faster-whisper.
# Aufruf: python whisper_worker.py <auftrag.json>. Fortschritt kommt als JSON-Zeilen, das Ergebnis als Datei.
import json
import os
import site
import sys


def say(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


# Die Grafikkarten-Bibliotheken liegen als Python-Pakete in der Umgebung und müssen gefunden werden.
def add_cuda_libraries():
    for packages in site.getsitepackages():
        for name in ("cublas", "cudnn", "cuda_nvrtc"):
            folder = os.path.join(packages, "nvidia", name, "bin")
            if os.path.isdir(folder):
                os.add_dll_directory(folder)
                os.environ["PATH"] = folder + os.pathsep + os.environ["PATH"]


def transcribe(job, audio, device):
    from faster_whisper import WhisperModel

    model = WhisperModel(job["model"], device=device, compute_type="float16" if device == "cuda" else "int8")
    say({"device": device})
    duration = len(audio) / 16000
    segments, info = model.transcribe(
        audio,
        language=job.get("language") or None,
        task="translate" if job.get("translate") else "transcribe",
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )

    result = []
    for segment in segments:
        result.append({
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
            "text": segment.text.strip(),
            "words": [
                {"start": round(word.start, 3), "end": round(word.end, 3), "word": word.word}
                for word in (segment.words or [])
            ],
        })
        say({"progress": min(1.0, segment.end / duration) if duration else 0})
    return {"language": info.language, "duration": duration, "device": device, "segments": result}


def main():
    with open(sys.argv[1], encoding="utf-8-sig") as file:
        job = json.load(file)

    add_cuda_libraries()
    import ctranslate2
    import numpy as np

    audio = np.fromfile(job["audio"], dtype=np.float32)
    result = None
    if ctranslate2.get_cuda_device_count() > 0:
        try:
            result = transcribe(job, audio, "cuda")
        except Exception:
            # Klappt es auf der Grafikkarte nicht, etwa weil der Speicher fehlt, rechnet der Prozessor.
            say({"progress": 0})
    if result is None:
        result = transcribe(job, audio, "cpu")

    with open(job["output"], "w", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False)
    say({"done": True})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        text = str(error)
        if "out of memory" in text.lower():
            say({"error": "memory"})
        else:
            say({"error": text})
        sys.exit(1)
