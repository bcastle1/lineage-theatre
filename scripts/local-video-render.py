"""CPU-only archive film renderer: original photos, captions and local narration."""
import hashlib
import json
import math
import subprocess
import textwrap
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw, ImageFont

WIDTH, HEIGHT, FPS = 1280, 720, 25
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
Image.MAX_IMAGE_PIXELS = 40_000_000


def run(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=900)


def probe(path):
    return json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]).stdout)


def card(job, scene, photo, path):
    im = Image.new("RGB", (WIDTH, HEIGHT), "#101e27")
    if photo:
        with Image.open(photo) as source:
            source = ImageOps.exif_transpose(source).convert("RGB")
            fitted = ImageOps.contain(source, (WIDTH, HEIGHT - 160))
            im.paste(fitted, ((WIDTH - fitted.width) // 2, (HEIGHT - fitted.height) // 2 - 15))
    draw = ImageDraw.Draw(im)
    draw.rectangle((0, 0, WIDTH, 92), fill="#101e27")
    draw.rectangle((0, HEIGHT - 145, WIDTH, HEIGHT), fill="#101e27")
    draw.line((54, 79, WIDTH - 54, 79), fill="#c5a46e", width=2)
    heading = scene["title"]
    while draw.textlength(heading, font=ImageFont.truetype(FONT, 28)) > WIDTH - 110:
        heading = heading[:-2]
    draw.text((54, 29), heading, font=ImageFont.truetype(FONT, 28), fill="#f8f1e6")
    if not photo:
        lines = textwrap.wrap(scene.get("visual") or job["title"], 54)[:6]
        for index, line in enumerate(lines):
            draw.text((WIDTH // 2, 218 + index * 42), line, anchor="mt", font=ImageFont.truetype(FONT, 28), fill="#d9d8cd")
        draw.text((WIDTH // 2, 160), "FAMILY ARCHIVE", anchor="mt", font=ImageFont.truetype(FONT, 18), fill="#c5a46e")
    im.save(path)


def ass_time(seconds):
    centis = round(seconds * 100)
    return f"{centis // 360000}:{centis // 6000 % 60:02}:{centis // 100 % 60:02}.{centis % 100:02}"


def captions(text, seconds, path):
    # Neutralize ASS controls; captions are plain customer text.
    words = text.replace("\\", " ").replace("{", "(").replace("}", ")").split()
    groups = [words[i:i + 16] for i in range(0, len(words), 16)]
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,25,&H00F1F1F1,&H00FFFFFF,&H00101E27,&H00101E27,0,0,0,0,100,100,0,0,1,1,0,2,75,75,45,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    for index, group in enumerate(groups):
        wrapped = "\\N".join(textwrap.wrap(" ".join(group), 78))
        header += f"Dialogue: 0,{ass_time(index * seconds / len(groups))},{ass_time((index + 1) * seconds / len(groups))},Default,,0,0,0,,{wrapped}\n"
    path.write_text(header, encoding="utf-8")


def render(job, work, photos=None, progress=lambda percent: None):
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    photos = photos or {}
    scenes = job["scenes"]
    clips = []
    for index, scene in enumerate(scenes):
        prefix = work / f"scene-{index:03}"
        png, wav, ass, mp4 = [prefix.with_suffix(ext) for ext in [".png", ".wav", ".ass", ".mp4"]]
        text = (scene.get("narration", "") + " " + scene.get("dialogue", "")).strip() or scene["title"]
        txt = prefix.with_suffix(".txt")
        txt.write_text(text, encoding="utf-8")
        run(["espeak-ng", "-v", "en-us", "-s", "155", "-f", str(txt), "-w", str(wav)])
        spoken = float(probe(wav)["format"]["duration"])
        seconds = max(job["duration"] / len(scenes), spoken + 0.6)
        if seconds > 300:
            raise ValueError("Scene narration exceeds the render limit")
        card(job, scene, photos.get(scene.get("photoId")), png)
        captions(text, max(spoken, 1), ass)
        frames = math.ceil(seconds * FPS)
        # Camera motion is applied to photos only; title cards stay still.
        motion = f"zoompan=z='min(zoom+0.00012,1.06)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={frames}:s={WIDTH}x{HEIGHT}:fps={FPS}," if scene.get("photoId") else ""
        filters = f"{motion}subtitles={ass.name},format=yuv420p"
        args = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "2", "-filter_threads", "1", "-loop", "1", "-i", png.name, "-i", wav.name,
                "-vf", filters, "-af", "apad", "-t", str(seconds), "-r", str(FPS), "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", mp4.name]
        subprocess.run(args, cwd=work, check=True, capture_output=True, timeout=900)
        clips.append(mp4)
        progress(round(85 * (index + 1) / len(scenes)))
    concat = work / "clips.txt"
    concat.write_text("\n".join(f"file '{clip.name}'" for clip in clips), encoding="utf-8")
    output = work / "film.mp4"
    run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", str(concat), "-c", "copy", "-movflags", "+faststart", str(output)])
    info = probe(output)
    video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in info["streams"] if stream["codec_type"] == "audio")
    duration = float(info["format"]["duration"])
    if video["codec_name"] != "h264" or audio["codec_name"] != "aac" or not 1 <= duration <= 900 or output.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("Rendered film exceeds delivery limits")
    run(["ffmpeg", "-v", "error", "-threads", "2", "-i", str(output), "-f", "null", "-"])
    return output, {"sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "sizeBytes": output.stat().st_size,
                    "durationSeconds": duration, "width": video["width"], "height": video["height"], "hasAudio": True, "engine": "ffmpeg-espeak"}


if __name__ == "__main__":
    import sys
    output, report = render(json.loads(Path(sys.argv[1]).read_text()), sys.argv[2])
    print(json.dumps(report))
