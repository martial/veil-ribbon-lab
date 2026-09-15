"""Compile fixed-size SDXS + tiny VAE models for the Mac's Metal GPU.

SDXS: https://github.com/IDKiro/sdxs
Core ML + TAESD approach: https://github.com/ochyai/streamdiffusion-mac
Only model weights are downloaded; no remote Python code is executed.
"""
import argparse
import gc
import json
import time
from pathlib import Path

import coremltools as ct
import numpy as np
import torch
from diffusers import AutoencoderTiny, UNet2DConditionModel, EulerDiscreteScheduler, ControlNetModel
from transformers import CLIPTokenizer, CLIPTextModel

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.models' / 'fast-cache'
MODELS = {'sdxs': 'IDKiro/sdxs-512-0.9', 'turbo': 'stabilityai/sd-turbo', 'sketch': 'IDKiro/sdxs-512-dreamshaper'}
torch.set_num_threads(4)


class Denoise(torch.nn.Module):
    def __init__(self, model):
        super().__init__(); self.model = model

    def forward(self, sample, timestep, text):
        return self.model(sample, timestep, encoder_hidden_states=text, return_dict=False)[0]


class GuidedDenoise(torch.nn.Module):
    def __init__(self, model, control):
        super().__init__(); self.model = model; self.control = control

    def forward(self, sample, timestep, text, structure):
        down, mid = self.control(sample, timestep, encoder_hidden_states=text,
            controlnet_cond=structure, conditioning_scale=1.15, return_dict=False)
        return self.model(sample, timestep, encoder_hidden_states=text,
            down_block_additional_residuals=down, mid_block_additional_residual=mid, return_dict=False)[0]


def convert(module, examples, names, output, path, quantize=False):
    if path.exists():
        print(f'Already prepared: {path.name}', flush=True); return
    started = time.perf_counter()
    with torch.inference_mode():
        traced = torch.jit.trace(module.eval(), examples, check_trace=False)
    result = ct.convert(traced,
        inputs=[ct.TensorType(name=name, shape=value.shape, dtype=np.float16) for name, value in zip(names, examples)],
        outputs=[ct.TensorType(name=output, dtype=np.float16)],
        compute_units=ct.ComputeUnit.CPU_AND_GPU, convert_to='mlprogram',
        minimum_deployment_target=ct.target.macOS15 if quantize else ct.target.macOS14, skip_model_load=True)
    if quantize:
        config = ct.optimize.coreml.OptimizationConfig(global_config=ct.optimize.coreml.OpLinearQuantizerConfig(
            mode='linear_symmetric', dtype='int4', granularity='per_block', block_size=32))
        result = ct.optimize.coreml.linear_quantize_weights(result, config)
    result.save(str(path))
    print(f'Prepared {path.name} in {time.perf_counter()-started:.1f}s', flush=True)
    del result, traced; gc.collect()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', choices=MODELS, default='sdxs')
    parser.add_argument('--sizes', nargs='+', type=int, default=[256, 384])
    parser.add_argument('--int4', action='store_true', help='Compare block-wise 4-bit UNet weights on macOS 15+')
    args = parser.parse_args()
    if any(size not in (128, 192, 256, 384, 512) for size in args.sizes):
        parser.error('Sizes must be 128, 192, 256, 384 or 512')
    model_id = MODELS[args.model]
    destination = ROOT / '.models' / f'coreml-{args.model}'
    destination.mkdir(parents=True, exist_ok=True)
    loader = dict(cache_dir=CACHE, use_safetensors=True)
    unet = UNet2DConditionModel.from_pretrained(model_id, subfolder='unet', **loader).eval().float()
    hidden = unet.config.cross_attention_dim
    if args.model == 'sketch':
        control = ControlNetModel.from_pretrained('IDKiro/sdxs-512-dreamshaper-sketch', cache_dir=CACHE,
            use_safetensors=False).eval().float()  # Diffusers uses torch.load(weights_only=True).
        module = GuidedDenoise(unet, control)
    else:
        module = Denoise(unet)
    for size in args.sizes:
        examples = (torch.randn(1, 4, size//8, size//8), torch.tensor([999.]), torch.randn(1, 77, hidden))
        names = ['sample', 'timestep', 'text']
        if args.model == 'sketch':
            examples += (torch.zeros(1, 3, size, size),); names.append('structure')
        convert(module, examples, names, 'noise', destination / f'unet-{size}{"-int4" if args.int4 else ""}.mlpackage', args.int4)
    del unet, module
    if args.model == 'sketch':
        del control
    gc.collect()
    vae = AutoencoderTiny.from_pretrained(model_id, subfolder='vae', **loader).eval().float() if args.model == 'sketch' else AutoencoderTiny.from_pretrained('madebyollin/taesd', **loader).eval().float()
    for size in args.sizes:
        convert(vae.encoder, (torch.zeros(1, 3, size, size),), ['image'], 'latent', destination / f'encoder-{size}.mlpackage')
        convert(vae.decoder, (torch.zeros(1, 4, size//8, size//8),), ['latent'], 'image', destination / f'decoder-{size}.mlpackage')
    del vae; gc.collect()
    # Cache the tokenizer and text encoder; prompts are encoded only on changes.
    if not (destination / 'text_encoder' / 'model.safetensors').exists():
        CLIPTokenizer.from_pretrained(model_id, subfolder='tokenizer', cache_dir=CACHE).save_pretrained(destination / 'tokenizer')
        CLIPTextModel.from_pretrained(model_id, subfolder='text_encoder', **loader).save_pretrained(destination / 'text_encoder')
        EulerDiscreteScheduler.from_pretrained(model_id, subfolder='scheduler', cache_dir=CACHE).save_pretrained(destination / 'scheduler')
    (destination / 'metadata.json').write_text(json.dumps({'model': model_id, 'vae': model_id if args.model == 'sketch' else 'madebyollin/taesd', 'hidden': hidden,
        'control': 'depth-derived edges / sketch ControlNet' if args.model == 'sketch' else None}, indent=2))
    print(f'Complete: {destination}', flush=True)


if __name__ == '__main__':
    main()
