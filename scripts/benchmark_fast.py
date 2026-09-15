"""Benchmark actual depth images; saved timings exclude prompt/model cold start."""
import argparse
import io
import json
import time
import numpy as np
from PIL import Image
from fast_inference import CoreMLGenerator, ROOT

PROMPT = 'An ancient bronze sculpture with intricate carved relief, oxidized turquoise and copper gold patina, detailed ornamental engravings, museum artifact, black background'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='sdxs')
    parser.add_argument('--sizes', type=int, nargs='+', default=[256, 384])
    parser.add_argument('--count', type=int, default=20)
    parser.add_argument('--compute-units', default='CPU_AND_GPU', choices=['CPU_AND_GPU', 'CPU_AND_NE', 'ALL'])
    parser.add_argument('--int4', action='store_true')
    parser.add_argument('--input', default='.review/live-depth-input.png')
    args = parser.parse_args()
    image = Image.open(ROOT / args.input).convert('RGB')
    engine = CoreMLGenerator(args.model, args.sizes[0], args.compute_units, args.int4)
    output = ROOT / '.review' / f'benchmark-{args.model}-{args.compute_units.lower()}{"-int4" if args.int4 else ""}'
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for size in args.sizes:
        engine.load_size(size)
        for _ in range(5):
            engine.generate(image, PROMPT)
        samples = []
        for i in range(args.count):
            # Shift the captured depth slightly each iteration: no frame reuse.
            source = Image.fromarray(np.roll(np.asarray(image), i%6, axis=1))
            result, timings = engine.generate(source, PROMPT)
            start = time.perf_counter(); buffer = io.BytesIO(); result.save(buffer, format='PNG', compress_level=1)
            timings['png_ms'] = (time.perf_counter()-start)*1000
            samples.append(timings)
        result.save(output / f'{size}.png')
        means = {key: round(float(np.mean([sample[key] for sample in samples])), 2) for key in samples[0]}
        entry = {'model': args.model, 'compute_units': args.compute_units, 'int4': args.int4, 'size': size, 'samples': len(samples), 'mean': means,
            'p95_ms': round(float(np.percentile([s['total_ms'] for s in samples], 95)), 2),
            'inference_fps': round(1000/means['total_ms'], 2),
            'with_png_fps': round(1000/(means['total_ms']+means['png_ms']), 2)}
        results.append(entry); print(json.dumps(entry), flush=True)
        (output / 'results.json').write_text(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
