"""Local SD-Turbo bridge for the ribbon's camera-space depth captures.

Run .venv-turbo/bin/python scripts/turbo_server.py. Images stay on this machine.
Depth is the img2img initialization, not a trained ControlNet depth condition.
"""
import base64
import binascii
import io
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
ENGINE = os.environ.get('VEIL_ENGINE', 'sd-turbo')
IS_COREML = ENGINE in ('coreml-sdxs', 'coreml-sketch')
MODEL = {'coreml-sdxs': 'IDKiro/sdxs-512-0.9', 'coreml-sketch': 'IDKiro/sdxs-512-dreamshaper'}.get(ENGINE, 'stabilityai/sd-turbo')
state = {'status': 'loading', 'model': MODEL, 'device': None, 'error': None, 'generated': 0, 'last_ms': None}
lock = threading.Lock()
pipeline = None
prompt_cache = {}


def load_model():
    global pipeline
    try:
        if IS_COREML:
            from fast_inference import CoreMLGenerator
            pipeline = CoreMLGenerator('sketch' if ENGINE == 'coreml-sketch' else 'sdxs', 256, compute_units='ALL')
            state.update(device='coreml-auto', status='ready')
            print('SDXS + tiny VAE ready on Core ML (CPU/GPU/Neural Engine allowed)', flush=True)
            return
        import torch
        from diffusers import AutoPipelineForImage2Image
        device = 'mps' if torch.backends.mps.is_available() else ('cuda' if torch.cuda.is_available() else 'cpu')
        state['device'] = device
        pipeline = AutoPipelineForImage2Image.from_pretrained(
            MODEL, torch_dtype=torch.float16 if device != 'cpu' else torch.float32,
            variant='fp16', use_safetensors=True, cache_dir=ROOT / '.models' / 'turbo',
        ).to(device)
        pipeline.set_progress_bar_config(disable=True)
        state['status'] = 'ready'
        print(f'SD-Turbo ready on {device}', flush=True)
    except Exception as error:
        state.update(status='error', error=str(error))
        print(f'SD-Turbo load failed: {error}', flush=True)


@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=load_model, daemon=True).start()
    yield


app = FastAPI(title='Veil local depth → SD-Turbo', lifespan=lifespan)
app.add_middleware(CORSMiddleware,
    allow_origins=['http://localhost:5187', 'http://127.0.0.1:5187', 'https://martial.github.io'],
    allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])


class Frame(BaseModel):
    frame_id: int = Field(ge=0)
    depth: str = Field(max_length=2_000_000)
    prompt: str = Field(min_length=1, max_length=1000)
    seed: int = Field(default=42, ge=0, le=2**32-1)
    strength: float = Field(default=0.85, ge=0.25, le=0.95)
    drift: float = Field(default=0, ge=0, le=1)
    drift_phase: float = Field(default=0, ge=0, le=1_000_000)


@app.get('/health')
async def health():
    sizes = [256] if ENGINE == 'coreml-sketch' else [192, 256, 384] if IS_COREML else [256, 384, 512]
    conditioning = 'depth-derived edges / sketch ControlNet' if ENGINE == 'coreml-sketch' else 'depth image → img2img'
    return dict(state, busy=lock.locked(), conditioning=conditioning, structure_control=ENGINE == 'coreml-sketch',
                max_size=max(sizes), supported_sizes=sizes, engine=ENGINE, prompt_drift=IS_COREML)


def decode_depth(value):
    try:
        if not value.startswith('data:image/png;base64,'):
            raise ValueError('Expected a PNG depth image')
        raw = base64.b64decode(value.split(',', 1)[1], validate=True)
        image = Image.open(io.BytesIO(raw))
        sizes = (256,) if ENGINE == 'coreml-sketch' else (192, 256, 384) if IS_COREML else (256, 384, 512)
        if image.format != 'PNG' or image.width not in sizes or image.height != image.width:
            raise ValueError(f'Depth must be a square PNG at {", ".join(map(str, sizes))} pixels')
        image.load()
        return image.convert('RGB')
    except (ValueError, binascii.Error, UnidentifiedImageError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def generate(frame, depth):
    if IS_COREML:
        pipeline.load_size(depth.width)
        started = time.perf_counter()
        result, stages = pipeline.generate(depth, frame.prompt, frame.seed, frame.strength, frame.drift, frame.drift_phase)
        elapsed = (time.perf_counter()-started)*1000
        output = io.BytesIO(); result.save(output, format='PNG', compress_level=1)
        state['generated'] += 1; state['last_ms'] = round(elapsed, 1)
        return {'frame_id': frame.frame_id, 'image': 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode(),
                'inference_ms': round(elapsed, 1), 'width': result.width, 'height': result.height,
                'device': state['device'], 'model': MODEL, 'conditioning': pipeline.metadata.get('control') or 'depth image → img2img',
                'stages': stages, 'drift_label': pipeline.drift_label}
    import torch
    started = time.perf_counter()
    device = state['device']
    if frame.prompt not in prompt_cache:
        prompt_cache.clear()
        with torch.inference_mode():
            prompt_cache[frame.prompt] = pipeline.encode_prompt(
                frame.prompt, device=device, num_images_per_prompt=1,
                do_classifier_free_guidance=False)[0]
    # A custom Euler timestep continuously controls input noise while retaining
    # one U-Net evaluation. Pipeline strength=1 retains that one chosen step.
    timestep = round(frame.strength * 999)
    generator = torch.Generator(device='cpu').manual_seed(frame.seed)
    with torch.inference_mode():
        result = pipeline(prompt_embeds=prompt_cache[frame.prompt], image=depth,
            num_inference_steps=1, timesteps=[timestep], strength=1.0, guidance_scale=0.0,
            generator=generator).images[0]
    if device == 'mps':
        torch.mps.synchronize()
    elapsed = (time.perf_counter() - started) * 1000
    output = io.BytesIO(); result.save(output, format='PNG')
    state['generated'] += 1; state['last_ms'] = round(elapsed, 1)
    return {'frame_id': frame.frame_id, 'image': 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode(),
            'inference_ms': round(elapsed, 1), 'width': result.width, 'height': result.height,
            'device': device, 'model': MODEL, 'conditioning': 'depth image → img2img'}


@app.post('/generate')
async def generate_frame(frame: Frame):
    if state['status'] != 'ready':
        raise HTTPException(status_code=503, detail=state['error'] or 'Model is still loading')
    depth = decode_depth(frame.depth)
    if not lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail='One frame is already being generated')
    try:
        return await run_in_threadpool(generate, frame, depth)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    finally:
        lock.release()


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('VEIL_TURBO_PORT', '5192')), log_level='info', access_log=False)
