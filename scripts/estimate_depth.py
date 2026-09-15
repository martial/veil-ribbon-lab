"""Estimate actual relative depth with Apple's Core ML Depth Anything V2 Small.

macOS only. This is model inference and scalar-field processing, not a grayscale
conversion of the photograph. All inference is local after downloading weights.
"""
import argparse
from collections import deque
import json
from pathlib import Path
import time

import coremltools as ct
from huggingface_hub import snapshot_download
import numpy as np
from PIL import Image, ImageFilter, ImageOps


def background_mask(image):
    """Flood-fill only edge-connected black, preserving dark interior cavities."""
    rgb = np.asarray(image)
    # Erode the candidate background before flooding so a thin dark crease
    # cannot leak the mask into a shadowed arm or leg.
    dark = np.asarray(Image.fromarray((np.max(rgb, axis=2) < 8).astype(np.uint8) * 255)
                      .filter(ImageFilter.MinFilter(5))) > 0
    h, w = dark.shape
    background = np.zeros((h, w), dtype=bool)
    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            if dark[y, x] and not background[y, x]:
                background[y, x] = True
                queue.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if dark[y, x] and not background[y, x]:
                background[y, x] = True
                queue.append((y, x))
    while queue:
        y, x = queue.popleft()
        for ny, nx in ((y-1, x), (y+1, x), (y, x-1), (y, x+1)):
            if 0 <= ny < h and 0 <= nx < w and dark[ny, nx] and not background[ny, nx]:
                background[ny, nx] = True
                queue.append((ny, nx))
    background = np.asarray(Image.fromarray(background.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))) > 0
    mask = Image.fromarray((~background).astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(2))
    return np.asarray(mask).astype(np.float32) / 255


def remove_background_plane(depth):
    """Remove the slow perspective tilt of a slab using a robust edge-plane fit."""
    h, w = depth.shape
    yy, xx = np.mgrid[-1:1:complex(h), -1:1:complex(w)]
    edge = (np.abs(yy) > .88) | (np.abs(xx) > .95)
    design = np.stack([xx[edge], yy[edge], np.ones(np.count_nonzero(edge))], axis=1)
    samples = depth[edge]
    keep = np.ones(samples.shape, dtype=bool)
    for _ in range(3):
        coefficients = np.linalg.lstsq(design[keep], samples[keep], rcond=None)[0]
        residual = samples - design @ coefficients
        keep = np.abs(residual - np.median(residual)) <= max(1e-5, np.percentile(np.abs(residual), 85))
    plane = coefficients[0] * xx + coefficients[1] * yy + coefficients[2]
    return (depth - plane).astype(np.float32)


def smooth_field(field, sigma):
    radius = max(1, int(np.ceil(sigma * 3)))
    kernel = np.exp(-.5 * (np.arange(-radius, radius+1) / sigma) ** 2)
    kernel /= kernel.sum()
    h, w = field.shape
    padded = np.pad(field, ((0, 0), (radius, radius)), mode='edge')
    horizontal = sum(weight * padded[:, i:i+w] for i, weight in enumerate(kernel))
    padded = np.pad(horizontal, ((radius, radius), (0, 0)), mode='edge')
    return sum(weight * padded[i:i+h] for i, weight in enumerate(kernel)).astype(np.float32)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('image', type=Path)
    parser.add_argument('output_prefix', type=Path)
    parser.add_argument('--plane', action='store_true', help='Remove the background plane of a generated relief slab')
    parser.add_argument('--mask-black', action='store_true', help='Remove the edge-connected black photographic background')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    model_path = root / '.models/DepthAnythingV2SmallF16.mlpackage'
    if not model_path.exists():
        snapshot_download('apple/coreml-depth-anything-v2-small',
                          allow_patterns=['DepthAnythingV2SmallF16.mlpackage/*', 'LICENSE'], local_dir=root / '.models')
    image = ImageOps.exif_transpose(Image.open(args.image)).convert('RGB')
    model = ct.models.MLModel(str(model_path), compute_units=ct.ComputeUnit.ALL)
    spec = model.get_spec()
    input_type = spec.description.input[0].type.imageType
    width, height = input_type.width, input_type.height
    # Preserve aspect ratio inside the model's fixed shape; crop the padding
    # from the result before mapping back into the original image coordinates.
    ratio = min(width / image.width, height / image.height)
    rw, rh = max(1, round(image.width * ratio)), max(1, round(image.height * ratio))
    resized = image.resize((rw, rh), Image.Resampling.LANCZOS)
    edge_pixels = np.concatenate([np.asarray(image)[0], np.asarray(image)[-1]], axis=0)
    fill = tuple(int(x) for x in np.median(edge_pixels, axis=0))
    letterbox = Image.new('RGB', (width, height), fill)
    left, top = (width - rw) // 2, (height - rh) // 2
    letterbox.paste(resized, (left, top))
    start = time.perf_counter()
    prediction = model.predict({spec.description.input[0].name: letterbox})
    duration = (time.perf_counter() - start) * 1000
    raw = np.asarray(prediction[spec.description.output[0].name], dtype=np.float32).squeeze()
    if raw.ndim != 2 or not np.all(np.isfinite(raw)):
        raise RuntimeError(f'Invalid model output: shape={raw.shape}')
    raw = raw[top:top+rh, left:left+rw]
    source_range = [float(raw.min()), float(raw.max())]
    if args.plane:
        raw = remove_background_plane(raw)
        low = 0
    else:
        low = float(np.percentile(raw, 2))
    high = float(np.percentile(raw, 99))
    if high <= low + 1e-6:
        raise RuntimeError('The estimated depth has no positive relief.')
    normalized = np.clip((raw-low)/(high-low), 0, 1)
    # Preserve the smooth broad relief; sensor/texture noise should not become
    # high-stiffness spikes in the cloth solver.
    size = (min(1536, image.width), max(1, round(image.height * min(1536, image.width) / image.width)))
    depth_img = Image.fromarray(normalized.astype(np.float32)).resize(size, Image.Resampling.BICUBIC)
    normalized = np.clip(smooth_field(np.asarray(depth_img), max(size)/900), 0, 1)
    args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
    if args.mask_black:
        mask = background_mask(image.resize(size, Image.Resampling.LANCZOS))
        # A soft outer transition avoids a vertical wall in the ribbon's rest
        # shape. Keep the color-compositing mask sharper than the physics mask.
        normalized *= smooth_field(mask, max(size)/150)
        Image.fromarray((mask * 255).astype(np.uint8)).save(str(args.output_prefix) + '-mask.png')
    depth_img = Image.fromarray((normalized*255).astype(np.uint8))
    args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
    depth_img.save(str(args.output_prefix) + '-depth.png')
    # Retain a higher-precision output for future solvers. Current browser import
    # uses 8-bit image data; the model's native precision is float16.
    Image.fromarray((normalized * 65535).astype(np.uint16)).save(str(args.output_prefix) + '-depth16.png')
    metadata = {
        'source': str(args.image), 'model': 'apple/coreml-depth-anything-v2-small',
        'variant': 'DepthAnythingV2SmallF16', 'model_license': 'Apache-2.0',
        'runtime': f'Core ML / coremltools {ct.__version__}', 'compute_units': 'ALL (Core ML selects hardware)',
        'first_inference_ms': round(duration, 2), 'input_size': [width, height], 'output_size': list(size),
        'raw_range': source_range, 'normalization_low': low, 'normalization_high': high,
        'meaning': 'Relative inverse depth: white is closer/higher relief. Not metric depth.',
        'background_plane_removed': args.plane, 'edge_connected_black_mask': args.mask_black,
        'depth_range': [float(normalized.min()), float(normalized.max())],
    }
    Path(str(args.output_prefix) + '-depth.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata, indent=2))


if __name__ == '__main__':
    main()
