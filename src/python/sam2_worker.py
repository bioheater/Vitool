"""KI-Dienst für Vitool: bekommt Befehle als JSON-Zeilen und antwortet ebenso.

Läuft als eigener Prozess, damit Vitool auch ohne installierte KI funktioniert.
"""
import json
import os
import sys
import traceback

import numpy as np
import torch
from PIL import Image
from sam2.build_sam import build_sam2_video_predictor

CONFIGS = {
    "tiny": "configs/sam2.1/sam2.1_hiera_t.yaml",
    "small": "configs/sam2.1/sam2.1_hiera_s.yaml",
    "base_plus": "configs/sam2.1/sam2.1_hiera_b+.yaml",
    "large": "configs/sam2.1/sam2.1_hiera_l.yaml",
}
PREVIEW_COLOR = (47, 198, 232, 255)

device = "cuda" if torch.cuda.is_available() else "cpu"
predictor = None
state = None


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
    with torch.inference_mode(), autocast():
        state = predictor.init_state(video_path=command["frames"], offload_video_to_cpu=True, async_loading_frames=False)
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
