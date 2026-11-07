# Erkennt mit pyannote, wer wann spricht, und ordnet die Sätze aus Whisper den Sprechern zu.
# Aufruf: python speaker_worker.py download <ordner>   (Token optional in HF_TOKEN)
#         python speaker_worker.py <auftrag.json>
# Läuft getrennt von Whisper, weil PyTorch eigene Grafikkarten-Bibliotheken mitbringt.
import json
import os
import sys

# pyannote schickt sonst Nutzungsdaten. Nach dem Einrichten braucht es kein Netz mehr.
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
REPO = "pyannote/speaker-diarization-community-1"


def say(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def download(folder):
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import GatedRepoError, HfHubHTTPError

    try:
        snapshot_download(REPO, local_dir=folder, token=os.environ.get("HF_TOKEN") or None)
    except GatedRepoError:
        say({"error": "gated"})
        sys.exit(1)
    except HfHubHTTPError as error:
        status = getattr(error.response, "status_code", None)
        say({"error": "gated" if status in (401, 403) else str(error)})
        sys.exit(1)


def find_turns(job, audio):
    os.environ["HF_HUB_OFFLINE"] = "1"
    import torch
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(job["model"])
    device = "cpu"
    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))
        device = "cuda"
    say({"device": device})

    # Die Stimmvergleiche dauern am längsten und bekommen den größten Teil des Balkens.
    shares = {"segmentation": (0, 0.2), "embeddings": (0.2, 0.95)}

    def hook(step, _artifact, file=None, total=None, completed=None):
        start, end = shares.get(step, (None, None))
        if start is not None and total:
            say({"progress": start + (end - start) * (completed or 0) / total})

    count = job.get("count")
    output = pipeline(
        {"waveform": torch.from_numpy(audio)[None], "sample_rate": 16000},
        hook=hook,
        **({"num_speakers": count} if count else {}),
    )
    # Die exklusive Fassung kennt keine Überlappungen, so gehört jedes Wort genau einem Sprecher.
    annotation = getattr(output, "exclusive_speaker_diarization", None) or output.speaker_diarization
    return [(turn.start, turn.end, label) for turn, _track, label in annotation.itertracks(yield_label=True)]


# Wer spricht zwischen start und end? Am meisten Überlappung gewinnt, sonst der zeitlich nächste Abschnitt.
def speaker_at(turns, start, end):
    best, best_overlap, best_distance = None, 0, None
    for turn_start, turn_end, speaker in turns:
        overlap = min(end, turn_end) - max(start, turn_start)
        if overlap > best_overlap:
            best, best_overlap = speaker, overlap
        elif best_overlap <= 0:
            distance = max(turn_start - end, start - turn_end)
            if best_distance is None or distance < best_distance:
                best, best_distance = speaker, distance
    return best


# Wechselt mitten in einem Satz der Sprecher, wird er an dieser Stelle geteilt.
def assign_speakers(segments, turns):
    result = []
    for segment in segments:
        # Von Hand geänderter Text passt nicht mehr zu den Wortzeiten und bleibt ganz.
        words = [] if segment.get("edited") else segment.get("words") or []
        if not words:
            result.append({**segment, "speaker": speaker_at(turns, segment["start"], segment["end"])})
            continue
        speakers = [speaker_at(turns, word["start"], word["end"]) for word in words]
        # Ein einzelnes Wort mitten in einem anderen Sprecher ist fast immer ein Messfehler.
        for index in range(1, len(speakers) - 1):
            if speakers[index - 1] == speakers[index + 1] != speakers[index]:
                speakers[index] = speakers[index - 1]
        groups = []
        for word, speaker in zip(words, speakers):
            if groups and groups[-1][0] == speaker:
                groups[-1][1].append(word)
            else:
                groups.append((speaker, [word]))
        for index, (speaker, group) in enumerate(groups):
            result.append({
                "start": segment["start"] if index == 0 else group[0]["start"],
                "end": segment["end"] if index == len(groups) - 1 else group[-1]["end"],
                "text": "".join(word["word"] for word in group).strip(),
                "words": group,
                "speaker": speaker,
            })
    return result


def main():
    if sys.argv[1] == "download":
        download(sys.argv[2])
        say({"done": True})
        return

    with open(sys.argv[1], encoding="utf-8-sig") as file:
        job = json.load(file)
    with open(job["transcript"], encoding="utf-8") as file:
        transcript = json.load(file)

    import numpy as np

    audio = np.fromfile(job["audio"], dtype=np.float32)
    turns = find_turns(job, audio) if transcript["segments"] else []
    if turns:
        # Gezählt wird in der Reihenfolge, in der jemand zuerst spricht.
        # Wer nur Geräusche macht und kein Wort sagt, bekommt keine Nummer.
        numbers = {}
        segments = assign_speakers(transcript["segments"], turns)
        for segment in segments:
            segment["speaker"] = numbers.setdefault(segment["speaker"], len(numbers))
        transcript["segments"] = segments
        transcript["speakers"] = len(numbers)
    else:
        for segment in transcript["segments"]:
            segment.pop("speaker", None)
        transcript.pop("speakers", None)

    with open(job["transcript"], "w", encoding="utf-8") as file:
        json.dump(transcript, file, ensure_ascii=False)
    say({"done": True})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        text = str(error)
        say({"error": "memory" if "out of memory" in text.lower() else text})
        sys.exit(1)
