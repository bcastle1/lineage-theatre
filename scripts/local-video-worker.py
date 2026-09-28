"""Outbound-only worker. The Spark never exposes its render API to the internet."""
import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.parse
from pathlib import Path

spec = importlib.util.spec_from_file_location("renderer", Path(__file__).with_name("local-video-render.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
BASE = os.environ.get("LINEAGE_VIDEO_ORIGIN", "https://www.lineagetheater.com").rstrip("/")
if BASE not in ("https://www.lineagetheater.com", "https://lineagetheater.com"):
    raise RuntimeError("Choose the verified production origin")
KEY = os.environ["LINEAGE_LOCAL_VIDEO_WORKER_KEY"]
ENDPOINT = BASE + "/api/studio?local=1&worker=1"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)


def request(body):
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    with opener.open(req, timeout=170) as response:
        return json.load(response)


def process(ticket):
    job, claim = ticket["job"], ticket["claim"]
    identity = {"id": job["id"], "claim": claim}
    percent = [1]
    stopped = threading.Event()

    def heartbeat():
        while not stopped.wait(30):
            try:
                request({"action": "progress", **identity, "progress": percent[0]})
            except Exception:
                pass  # Completion still requires a live, matching lease.

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="lineage-render-") as directory:
            work = Path(directory)
            photos = {}
            for photo_id in {scene["photoId"] for scene in job["scenes"] if scene.get("photoId")}:
                url = ENDPOINT + "&action=source&id=" + job["id"] + "&photo=" + urllib.parse.quote(photo_id)
                req = urllib.request.Request(url, headers={"Authorization": "Bearer " + KEY, "X-Render-Claim": claim})
                with opener.open(req, timeout=120) as response:
                    data = response.read(20 * 1024 * 1024 + 1)
                    if len(data) > 20 * 1024 * 1024:
                        raise ValueError("Photo exceeds local rendering limit")
                    path = work / (photo_id + ".image")
                    path.write_bytes(data)
                    photos[photo_id] = path

            def progress(value):
                percent[0] = value
                request({"action": "progress", **identity, "progress": value})

            output, report = renderer.render(job, work, photos, progress)
            grant = request({"action": "upload", **identity, "report": report})
            upload = subprocess.run(["node", str(Path(__file__).with_name("local-video-upload.mjs"))],
                                    input=json.dumps({**grant, "path": str(output)}).encode(), capture_output=True, timeout=240)
            if upload.returncode:
                raise RuntimeError("Film upload failed")
            result = request({"action": "complete", **identity, "report": report})
            print(json.dumps({"event": "completed", "id": job["id"], "duration": result["durationSeconds"], "bytes": report["sizeBytes"]}), flush=True)
    except Exception as error:
        # Never log source text, credentials, upload grants, or provider bodies.
        print(json.dumps({"event": "failed", "id": job["id"], "type": type(error).__name__}), flush=True)
        try:
            request({"action": "failed", **identity})
        except Exception:
            pass
    finally:
        stopped.set()
        thread.join(timeout=180)


if __name__ == "__main__":
    renderer.run(["ffmpeg", "-version"])
    renderer.run(["espeak-ng", "--version"])
    print(json.dumps({"event": "started", "engine": "ffmpeg-espeak", "gpu": False}), flush=True)
    while True:
        try:
            ticket = request({"action": "poll"})
            if ticket.get("job"):
                process(ticket)
                continue
        except Exception as error:
            print(json.dumps({"event": "connection-unavailable", "type": type(error).__name__}), flush=True)
        time.sleep(30)
