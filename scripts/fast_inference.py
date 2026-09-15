"""One-step, depth-initialized image generation with fixed-size Core ML models."""
import gc
import json
import time
from pathlib import Path

import coremltools as ct
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DRIFT_STYLES = [
    ('warm bronze', 'flowing liquid bronze, warm copper highlights, engraved ancient relief'),
    ('mother of pearl', 'iridescent mother of pearl, luminous ivory shell, delicate carved relief'),
    ('smoky glass', 'translucent smoky violet glass, silver veins and ethereal light'),
    ('living jade', 'deep jade and turquoise stone, fine gold mineral veins, organic carved relief'),
]


class CoreMLGenerator:
    def __init__(self, model='sdxs', size=256, compute_units='CPU_AND_GPU', int4=False):
        self.directory = ROOT / '.models' / f'coreml-{model}'
        self.metadata = json.loads((self.directory / 'metadata.json').read_text())
        self.control = bool(self.metadata.get('control'))
        self.size = None
        self.prompt = None
        self.seed = None
        self.text_encoder = None
        self.compute_units = getattr(ct.ComputeUnit, compute_units)
        self.int4 = int4
        # Euler's one-step x0 estimate, computed in float32 for stability.
        scheduler = json.loads((self.directory / 'scheduler' / 'scheduler_config.json').read_text())
        betas = np.linspace(scheduler['beta_start']**.5, scheduler['beta_end']**.5,
                            scheduler['num_train_timesteps'], dtype=np.float32)**2
        self.alphas = np.cumprod(1-betas)
        self.load_size(size)

    def load_size(self, size):
        if size == self.size:
            return
        paths = {part: self.directory / f'{part}-{size}.mlpackage' for part in ('encoder', 'unet', 'decoder')}
        if self.int4:
            paths['unet'] = self.directory / f'unet-{size}-int4.mlpackage'
        if not all(path.exists() for path in paths.values()):
            raise ValueError(f'Prepare {size}px models with scripts/prepare_fast_models.py first')
        self.models = {}; gc.collect()
        self.models = {part: ct.models.MLModel(str(path), compute_units=self.compute_units)
                       for part, path in paths.items()}
        self.size = size
        self.seed = None

    def encode_prompt(self, prompt):
        if prompt == self.prompt:
            return
        import torch
        from transformers import CLIPTokenizer, CLIPTextModel
        if self.text_encoder is None:
            torch.set_num_threads(4)
            self.tokenizer = CLIPTokenizer.from_pretrained(self.directory / 'tokenizer', local_files_only=True)
            self.text_encoder = CLIPTextModel.from_pretrained(self.directory / 'text_encoder', local_files_only=True).eval()
        descriptions = [prompt] + [f'{style}. {prompt}' for _, style in DRIFT_STYLES]
        inputs = self.tokenizer(descriptions, padding='max_length', max_length=77, truncation=True, return_tensors='pt')
        with torch.inference_mode():
            self.prompt_bank = self.text_encoder(inputs.input_ids)[0].numpy().astype(np.float16)
        self.embeddings = self.prompt_bank[:1]
        self.prompt = prompt
        # This Mac has 18 GB shared memory. Keep only the small prompt embedding
        # during streaming; reloading CLIP is paid only when the prompt changes.
        self.text_encoder = None; gc.collect()

    def generate(self, image, prompt, seed=42, strength=.85, drift=0, drift_phase=0):
        self.encode_prompt(prompt)
        start = time.perf_counter()
        phase = drift_phase % len(DRIFT_STYLES)
        index = int(phase); blend = phase-index
        blend = blend*blend*(3-2*blend)
        target = self.prompt_bank[index+1]*(1-blend)+self.prompt_bank[(index+1)%len(DRIFT_STYLES)+1]*blend
        embeddings = (self.embeddings*(1-drift)+target[None]*drift).astype(np.float16)
        self.drift_label = DRIFT_STYLES[index][0] if blend<.5 else DRIFT_STYLES[(index+1)%len(DRIFT_STYLES)][0]
        if seed != self.seed:
            self.noise = np.random.default_rng(seed).standard_normal((1, 4, self.size//8, self.size//8), dtype=np.float32)
            self.seed = seed
        pixels = np.asarray(image.resize((self.size, self.size), Image.Resampling.BILINEAR), dtype=np.float32)
        inputs = np.ascontiguousarray((pixels/127.5-1).transpose(2, 0, 1)[None], dtype=np.float16)
        stamp = time.perf_counter()
        clean = None if self.control else np.asarray(self.models['encoder'].predict({'image': inputs})['latent'], dtype=np.float32)
        enc_done = time.perf_counter()
        # The released sketch model is distilled at t=999. Lower timesteps
        # produce flat grey output instead of the trained one-step translation.
        timestep = 999 if self.control else round(strength * 999)
        sqrt_a = np.sqrt(self.alphas[timestep])
        sqrt_b = np.sqrt(1-self.alphas[timestep])
        noisy = self.noise if self.control else clean*sqrt_a + self.noise*sqrt_b
        model_input = {'sample': noisy.astype(np.float16), 'timestep': np.array([timestep], dtype=np.float16), 'text': embeddings}
        if self.control:
            # Released SDXS guidance is sketch-trained: extract the ribbon's
            # silhouette and fold edges from depth, rather than claiming that
            # the available weights are a trained depth ControlNet.
            gray = pixels[..., 0]/255
            padded = np.pad(gray, 1)
            gx = np.abs(padded[1:-1,2:]-padded[1:-1,:-2])
            gy = np.abs(padded[2:,1:-1]-padded[:-2,1:-1])
            edges = np.clip((gx+gy)*7*(strength/.85), 0, 1)
            model_input['structure'] = np.repeat(edges[None,None], 3, axis=1).astype(np.float16)
        prediction = self.models['unet'].predict(model_input)['noise']
        unet_done = time.perf_counter()
        denoised = (noisy-sqrt_b*np.asarray(prediction, dtype=np.float32))/sqrt_a
        decoded = self.models['decoder'].predict({'latent': denoised.astype(np.float16)})['image']
        dec_done = time.perf_counter()
        output = np.asarray(decoded, dtype=np.float32)[0].transpose(1, 2, 0)
        if not np.isfinite(output).all():
            raise RuntimeError('The model produced non-finite pixels')
        output = np.clip((output+1)*127.5, 0, 255).astype(np.uint8)
        # Projector aperture: generated pixels can never leave this frame's
        # captured silhouette. This mask is separate from learned guidance.
        output[np.max(pixels, axis=2)==0] = 0
        result = Image.fromarray(output)
        end = time.perf_counter()
        stages = {'prepare_ms': (stamp-start)*1000, 'encode_ms': (enc_done-stamp)*1000,
            'unet_ms': (unet_done-enc_done)*1000, 'decode_ms': (dec_done-unet_done)*1000,
            'post_ms': (end-dec_done)*1000, 'total_ms': (end-start)*1000}
        return result, stages
