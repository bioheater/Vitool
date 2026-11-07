"""KI-Dienst für Vitool: bekommt Befehle als JSON-Zeilen und antwortet ebenso.

Läuft als eigener Prozess, damit Vitool auch ohne installierte KI funktioniert.
"""
import json
import os
import sys
import traceback

from collections import OrderedDict

import numpy as np
import torch
import sam2.sam2_video_predictor as video_predictor
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor

CONFIGS = {
    "tiny": "configs/sam2.1/sam2.1_hiera_t.yaml",
    "small": "configs/sam2.1/sam2.1_hiera_s.yaml",
    "base_plus": "configs/sam2.1/sam2.1_hiera_b+.yaml",
    "large": "configs/sam2.1/sam2.1_hiera_l.yaml",
}
PREVIEW_COLOR = (47, 198, 232, 255)
LONG_SECTION_FRAMES = 1500

device = "cuda" if torch.cuda.is_available() else "cpu"
predictor = None
state = None


# SAM2 lädt sonst alle Bilder auf einmal, jedes als 1024 × 1024 Gleitkommazahlen (12 MB).
# Bei 1,5 Minuten mit 30 Bildern pro Sekunde sind das 35 GB und der Rechner steht still.
# Hier wird jedes Bild erst geladen, wenn SAM2 es braucht, die letzten bleiben kurz im Speicher.
class FramesOnDemand:
    CACHE = 8

    def __init__(self, folder, image_size):
        names = sorted((name for name in os.listdir(folder) if name.lower().endswith((".jpg", ".jpeg"))),
                       key=lambda name: int(os.path.splitext(name)[0]))
        if not names:
            raise RuntimeError(f"no images found in {folder}")
        self.paths = [os.path.join(folder, name) for name in names]
        self.image_size = image_size
        self.mean = torch.tensor((0.485, 0.456, 0.406), dtype=torch.float32)[:, None, None]
        self.std = torch.tensor((0.229, 0.224, 0.225), dtype=torch.float32)[:, None, None]
        self.cache = OrderedDict()
        with Image.open(self.paths[0]) as image:
            self.video_width, self.video_height = image.size

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, index):
        if index in self.cache:
            self.cache.move_to_end(index)
            return self.cache[index]
        with Image.open(self.paths[index]) as image:
            pixels = np.asarray(image.convert("RGB").resize((self.image_size, self.image_size)), dtype=np.float32) / 255.0
        frame = (torch.from_numpy(pixels).permute(2, 0, 1) - self.mean) / self.std
        self.cache[index] = frame
        if len(self.cache) > self.CACHE:
            self.cache.popitem(last=False)
        return frame


def load_frames_on_demand(video_path, image_size, **_options):
    frames = FramesOnDemand(video_path, image_size)
    return frames, frames.video_height, frames.video_width


video_predictor.load_video_frames = load_frames_on_demand


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def autocast():
    return torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda")


def union_mask(logits):
    return (logits > 0).any(dim=0).squeeze(0).cpu().numpy()


def save_preview(mask, path):
    height, width = mask.shape
    image = np.zeros((height, width, 4), dtype=np.uint8)
    image[mask] = PREVIEW_COLOR
    Image.fromarray(image, "RGBA").save(path)


def load(command):
    global predictor, state
    if predictor is None or predictor.model_id != command["model"]:
        predictor = build_sam2_video_predictor(CONFIGS[command["model"]], command["checkpoint"], device=device)
        predictor.model_id = command["model"]
    # Pro verfolgtem Bild bleibt etwa 1 MB Zwischenstand. Bei langen Abschnitten kommt das in den Arbeitsspeicher,
    # damit auch Grafikkarten mit wenig Speicher durchhalten.
    long_section = len(os.listdir(command["frames"])) > LONG_SECTION_FRAMES
    with torch.inference_mode(), autocast():
        state = predictor.init_state(video_path=command["frames"], offload_video_to_cpu=True, offload_state_to_cpu=long_section)
    return {"device": device, "frames": state["num_frames"]}


def points(command):
    width, height = state["video_width"], state["video_height"]
    frame = command["frame"]
    obj = command["object"]

    with torch.inference_mode(), autocast():
        if command["points"]:
            scaled = [[x * width, y * height] for x, y in command["points"]]
            _, _, logits = predictor.add_new_points_or_box(
                state,
                frame_idx=frame,
                obj_id=obj,
                points=np.array(scaled, dtype=np.float32),
                labels=np.array(command["labels"], dtype=np.int32),
                clear_old_points=True,
            )
        else:
            _, _, logits = predictor.clear_all_prompts_in_frame(state, frame, obj, need_output=True)
    if logits is None or len(logits) == 0:
        return {"empty": True}
    save_preview(union_mask(logits), command["preview"])
    return {}


def remove_object(command):
    with torch.inference_mode(), autocast():
        predictor.remove_object(state, command["object"], strict=False, need_output=False)
    return {}


def track(command):
    os.makedirs(command["masks"], exist_ok=True)
    os.makedirs(command["previews"], exist_ok=True)
    total = state["num_frames"]
    done = set()

    def run(reverse):
        for frame, _, logits in predictor.propagate_in_video(state, reverse=reverse):
            mask = union_mask(logits)
            Image.fromarray(mask.astype(np.uint8) * 255, "L").save(os.path.join(command["masks"], f"{frame:05d}.png"))
            save_preview(mask, os.path.join(command["previews"], f"{frame:05d}.png"))
            done.add(frame)
            if len(done) % 3 == 0:
                send({"progress": len(done) / total})

    with torch.inference_mode(), autocast():
        run(False)
        if len(done) < total:
            run(True)
    return {"frames": len(done)}


def reset(_command):
    with torch.inference_mode(), autocast():
        predictor.reset_state(state)
    return {}


COMMANDS = {"load": load, "points": points, "removeObject": remove_object, "track": track, "reset": reset}


def main():
    send({"ready": True, "device": device, "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None})
    for line in sys.stdin:
        command = json.loads(line)
        try:
            send({"result": COMMANDS[command["type"]](command)})
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            send({"error": "memory"})
        except Exception:
            traceback.print_exc()
            send({"error": traceback.format_exc(limit=3)})


main()
