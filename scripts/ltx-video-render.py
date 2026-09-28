"""Bounded LTX-2.5 text-to-video workflow for a dedicated local ComfyUI service."""
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path
import av
import imageio_ffmpeg
import psutil
from PIL import Image, ImageOps

BASE = "http://127.0.0.1:8189"
COMFY_ROOT = Path(os.environ.get("LINEAGE_COMFY_ROOT", Path(__file__).resolve().parent.parent / "ComfyUI")).resolve()

def request(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)

def workflow(prompt, duration=2, seed=20260928, width=1024, height=576, reference=None):
    graph = {}
    def node(id, kind, **inputs):
        graph[str(id)] = {'class_type': kind, 'inputs': inputs}
        return [str(id), 0]
    model=node(1,'UNETLoader',unet_name='ltx-2.5-22b-distilled-transformer-nvfp4.safetensors',weight_dtype='default')
    clip=node(2,'CLIPLoader',clip_name='gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',type='ltxv',device='default')
    vae=node(3,'VAELoader',vae_name='ltx-2.5-video-vae-conv-bf16.safetensors')
    audio=node(4,'VAELoader',vae_name='ltx-2.5-audio-vae-bf16.safetensors')
    pos=node(5,'CLIPTextEncode',clip=clip,text=prompt)
    neg=node(6,'CLIPTextEncode',clip=clip,text='cartoon, video game, blurry, distorted anatomy, unreadable text')
    cond=node(7,'LTXVConditioning',positive=pos,negative=neg,frame_rate=24)
    guider=node(8,'LTXVDualCFGGuider',model=model,positive=cond,negative=['7',1],video_cfg=1,audio_cfg=1)
    video=node(9,'EmptyLTXVLatentVideo',width=width//2,height=height//2,length=duration*24+1,batch_size=1)
    sound=node(10,'LTXVEmptyLatentAudio',audio_vae=audio,frames_number=duration*24+1,frame_rate=24,batch_size=1)
    av=node(11,'LTXVConcatAVLatent',video_latent=video,audio_latent=sound)
    noise=node(12,'RandomNoise',noise_seed=seed)
    sampler=node(13,'KSamplerSelect',sampler_name='euler_ancestral')
    sigmas=node(14,'ManualSigmas',sigmas='1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0')
    first=node(15,'SamplerCustomAdvanced',noise=noise,guider=guider,sampler=sampler,sigmas=sigmas,latent_image=av)
    split=node(16,'LTXVSeparateAVLatent',av_latent=first)
    upmodel=node(17,'LatentUpscaleModelLoader',model_name='ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors')
    up=node(18,'LTXVLatentUpsampler',samples=split,upscale_model=upmodel,vae=vae)
    joined=node(19,'LTXVConcatAVLatent',video_latent=up,audio_latent=['16',1])
    noise2=node(20,'RandomNoise',noise_seed=42)
    sigmas2=node(21,'ManualSigmas',sigmas='0.85, 0.7250, 0.4219, 0.0')
    final=node(22,'SamplerCustomAdvanced',noise=noise2,guider=guider,sampler=sampler,sigmas=sigmas2,latent_image=joined)
    split2=node(23,'LTXVSeparateAVLatent',av_latent=final)
    images=node(24,'VAEDecodeTiled',samples=split2,vae=vae,tile_size=256,overlap=64,temporal_size=32,temporal_overlap=8)
    decoded=node(25,'LTXVAudioVAEDecode',samples=['23',1],audio_vae=audio)
    movie=node(26,'CreateVideo',images=images,audio=decoded,fps=24,bit_depth=8,color_space='sRGB')
    node(27,'SaveVideo',video=movie,filename_prefix='lineage/pc-ltx-test',format='mp4',**{'format.codec':'h264'})
    if reference:
        loaded = node(30, 'LoadImage', image=reference)
        guided = node(31, 'LTXVImgToVideoInplace', vae=vae, image=loaded, latent=video, strength=0.85, bypass=False)
        graph['11']['inputs']['video_latent'] = guided
        refined = node(32, 'LTXVImgToVideoInplace', vae=vae, image=loaded, latent=up, strength=0.85, bypass=False)
        graph['19']['inputs']['video_latent'] = refined
    return graph


def check():
    stats = request('/system_stats')
    if not any(device.get('type') == 'cuda' for device in stats.get('devices', [])):
        raise RuntimeError('AI GPU is unavailable')
    queue = request('/queue')
    if queue.get('queue_running') or queue.get('queue_pending'):
        raise RuntimeError('AI renderer is occupied')
    if psutil.virtual_memory().available < 8 * 1024**3:
        raise RuntimeError('AI renderer needs more available system memory')


def render_clip(job, work, photos, progress):
    if not re.fullmatch(r'[a-f0-9]{64}', job.get('id', '')) or job.get('duration') not in (2, 5) or len(job.get('scenes', [])) != 1:
        raise ValueError('Invalid AI scene job')
    prompt = job['scenes'][0]['visual']
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError('Invalid AI scene description')
    check()
    reference = None
    if job.get('photoId'):
        path = photos[job['photoId']]
        reference = COMFY_ROOT / 'input/lineage-worker' / (job['id'] + '.png')
        reference.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(path) as original:
            if original.width * original.height > 40_000_000:
                raise ValueError('Reference image is too large')
            picture = ImageOps.exif_transpose(original).convert('RGB')
            picture.thumbnail((1536, 1536))
            picture.save(reference)
    graph = workflow(prompt, duration=job['duration'], seed=int(job['id'][:12], 16),
        reference='lineage-worker/' + reference.name if reference else None)
    graph['27']['inputs']['filename_prefix'] = 'lineage-worker/' + job['id']
    try:
        submitted = request('/prompt', {'prompt': graph, 'client_id': 'lineage-private-worker'})
    except Exception:
        if reference:
            reference.unlink(missing_ok=True)
        raise
    prompt_id = submitted['prompt_id']
    source = None
    started = time.monotonic()
    try:
        progress(10)
        while time.monotonic() - started < 1800:
            item = request('/history/' + prompt_id).get(prompt_id)
            if item:
                if item.get('status', {}).get('status_str') != 'success':
                    raise RuntimeError('AI generation failed')
                files = item.get('outputs', {}).get('27', {}).get('images', [])
                if len(files) != 1 or files[0].get('type') != 'output':
                    raise RuntimeError('AI output was not found')
                output_root = (COMFY_ROOT / 'output').resolve()
                source = (output_root / files[0]['subfolder'] / files[0]['filename']).resolve()
                if not source.is_relative_to(output_root / 'lineage-worker') or not source.name.startswith(job['id']) or source.suffix != '.mp4':
                    source = None
                    raise RuntimeError('Unexpected AI output path')
                break
            time.sleep(5)
        else:
            raise RuntimeError('AI generation exceeded its time limit')
        progress(85)
        output = Path(work) / 'ai-scene.mp4'
        # Re-encode for browser playback and remove embedded workflow/prompt metadata.
        result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
            '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '-1', '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', str(output)], capture_output=True, timeout=180,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise RuntimeError('AI video encoding failed')
        with av.open(str(output)) as container:
            video = container.streams.video[0]
            duration = container.duration / 1_000_000
            if video.width != 1024 or video.height != 576 or not container.streams.audio or not 1 <= duration <= 6:
                raise RuntimeError('AI video format did not match the selected profile')
            frames = sum(1 for _ in container.decode(video=0))
            if frames < 24:
                raise RuntimeError('AI video is incomplete')
        size = output.stat().st_size
        if not 100 <= size <= 100 * 1024**2:
            raise RuntimeError('AI output size is invalid')
        progress(95)
        return output, {'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'sizeBytes': size,
            'durationSeconds': duration, 'width': 1024, 'height': 576, 'hasAudio': True, 'engine': 'ltx-2.5-nvfp4'}
    finally:
        try:
            queue = request('/queue')
            if any(item[1] == prompt_id for item in queue.get('queue_running', [])):
                request('/interrupt', {})
            request('/queue', {'delete': [prompt_id]})
            request('/history', {'delete': [prompt_id]})
            if not request('/queue').get('queue_running'):
                request('/free', {'unload_models': True, 'free_memory': True})
        except Exception:
            pass
        if source and source.exists():
            source.unlink()
        if reference:
            reference.unlink(missing_ok=True)


def render(job, work, photos, progress):
    if job.get('mode') == 'film':
        import importlib.util
        spec = importlib.util.spec_from_file_location('ltx_film', Path(__file__).with_name('ltx-film-render.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.render(job, Path(work), photos, progress, render_clip)
    return render_clip(job, work, photos, progress)
