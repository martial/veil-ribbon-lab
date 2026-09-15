# Veil — ribbon lab

A standalone Three.js experiment: a thin ribbon clipped to the floor and lifted up and right by a broad airstream, with physical surface shading and a shaft of light. This project has its own dependencies and server and does not depend on Screenclub.

## Run

Requires Node.js 22.12+ or a current supported Node.js version.

```sh
npm install
npm run dev
```

Open **http://localhost:5187**. `npm run build` creates `dist/`; `npm run preview` serves that build on the same port after stopping the dev server. `npm test` checks the cloth solver.

## Controls

- Drag to orbit; scroll or pinch to zoom.
- Film, organza, and silk change the physical material, fiber detail, and transmission.
- Wind and turbulence change the air velocity seen by the moving cloth. **Still air** stops the airflow, **Breeze** restores it, and **Gust** adds a short pulse. The ribbon falls back to the floor when the airflow stops.
- Translucency and light adjust the surface and studio lighting.
- Space pauses/resumes. H hides/shows the interface.
- Reset restores the ribbon and camera while keeping your chosen material, maps, and parameters.
- The camera button downloads the current scene as a PNG, without the controls.
- Reduced-motion preferences start the scene paused.
- **Ribbon / Sculpture** selects the original film study or the supplied sculpture sample.
- **Photograph** toggles the original image over the sculpture's physical relief. The sculpture starts with a plain surface so its shape can be judged without baked photographic shadows.

## Current rendering and simulation

- Three.js r182 / WebGL 2, half-float rendering, 4× multisampling, ACES tone mapping, and restrained bloom.
- 1,425 simulated particles, 15,360 rendered triangles, and fixed 120 Hz integration.
- A 4.8 × 1.9 rectangular sheet, with three particles at the centre of its short edge held in a visible floor clamp. Its entire remaining perimeter is free.
- Gravity, orientation-dependent normal drag based on air velocity **relative to the cloth**, weaker tangential drag, and damped floor contact.
- A prescribed broad updraft that turns right with height, with gusts and advected world-space eddies. This is an approximate air field, not a coupled fluid simulation.
- XPBD edge constraints for stretch/shear and **signed dihedral bending** (the angle between neighbouring triangles). Ten alternating edge sweeps and five bending sweeps per substep.
- Unilateral long-range material-distance limits transmit tension from the clamp. Points can move anywhere within their available material length; these bounds cannot suspend the cloth in a pose.
- Bicubic render interpolation. There are no time-driven vertex displacements and no forces pulling vertices back toward a photographed silhouette.
- Fixed, material-coordinate microcreases and weave detail in normal maps. These are shading detail; the larger moving folds come from the solver.
- Physically based transmission, sheen, studio reflections, and approximate alpha layering for the very thin film.
- Custom ray-marched spotlight haze at 45% resolution. Transmission renders at 75% resolution. The cloth remains at the drawing-buffer resolution (DPR capped at 1.25).

The solver is independent of Three.js (`src/cloth.js`). Its CPU constraints are based on [XPBD](https://matthias-research.github.io/pages/publications/XPBD.pdf) and [long-range attachments](https://matthias-research.github.io/pages/publications/sca2012cloth.pdf). Rendering runs on the GPU.

**Limits:** textile and air parameters are tuned rather than measured. There is no full cloth self-collision or continuous collision detection; overlapping folds can intersect. Transparency uses raster approximations, and the atmosphere does not receive volumetric shadows. This remains a real-time prototype rather than an offline, calibrated fabric simulation.

### Motion regression checks

`npm test` verifies that still air leaves the sheet on the floor, wind lifts it up/right, switching wind off drops the same moving state, anchors remain fixed, and maximum wind stays finite with sampled RMS edge strain below 4.5%. It also checks reset determinism, analytical bending gradients against finite differences, invalid inputs, and rigid-transform invariance of the sculpture's internal constraints.

## Sculpture textures and depth constraints

Expand **Sculpture input** to load a texture and a grayscale depth map. Files are decoded locally and are never uploaded. PNG, JPEG, and WebP are supported, up to 20 MB. Images are resized to at most 2,048 pixels on their longest side. Inputs currently stretch over the full ribbon UV rectangle; use corresponding images with the same crop and orientation.

The texture uses sRGB color. The depth map is interpreted as scalar grayscale data: black is zero relief, white is maximum relief, and transparent pixels contribute no relief. Both images use a matching top-left origin.

Depth **does affect the physics**:

1. Resample the depth image onto the solver grid.
2. Displace the flat material's rest surface, tapering to zero at the clamp.
3. Recompute intrinsic edge lengths and signed bending angles from that relief.
4. Use **Shape retention** to stiffen the local bending constraints in the sculpture region.

The sculpted material can translate, rotate, and bend with the ribbon. The old world-space shape springs and rest-surface collision planes have been removed. Relief preservation is still experimental: a single thin sheet can buckle, and strong shape retention makes it behave more like an embossed flexible sheet than loose film. This is not a rigid sculpture hidden inside the fabric.

## Included sculpture sample

Open **http://localhost:5187/?study=sculpture**, or click **Sculpture** in the studio.

The sample uses the user's original photograph. Its relative depth was estimated locally with Apple's Core ML conversion of Depth Anything V2 Small, using the float16 model. It is **not a luminance-to-height conversion**. Texture and depth rotate together to put the head toward the ribbon's free end. A separate foreground mask blends the black photographic background into the ribbon material at render time.

The image generator rejected two attempts to produce a new archaeological relief texture. No generated texture is included. The **Photograph** option retains the original lighting and shadows; it is a mapping test rather than a lighting-neutral albedo map. The sample's initial plain material makes the recovered geometry easier to assess.

- `public/samples/sculpture-source.png`: original supplied photograph.
- `public/samples/source-depth.png`: 8-bit relative depth for the browser.
- `public/samples/source-depth16.png`: 16-bit relative depth for further processing.
- `public/samples/source-mask.png`: edge-connected background mask.
- `public/samples/source-depth.json`: model, normalization, timing, and processing provenance.

### Recompute depth locally on macOS

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r scripts/requirements-depth.txt
.venv/bin/python scripts/estimate_depth.py public/samples/sculpture-source.png public/samples/source --mask-black
```

The script downloads approximately 50 MB of model weights on its first run. Inference runs locally through Core ML with `ComputeUnit.ALL`; Core ML selects the hardware. The last measured prediction took 56 ms, excluding model loading and image processing. The model's fixed 518 × 392 input uses padding to preserve aspect ratio. Output coordinates are mapped back to the source image, normalized, and smoothed before loading into the cloth.

The runtime and weights stay in ignored `.venv/` and `.models/` directories. Model: [Apple Core ML Depth Anything V2 Small](https://huggingface.co/apple/coreml-depth-anything-v2-small), Apache-2.0. The sample assets are precomputed, so the browser demo does not require Python or download model weights.

### Next stage: sculpture image → cloth

The supplied sample now covers local depth estimation and the connection to the solver. A repeatable image-generation service and one-click estimation for new uploads are **not connected to the browser**.

1. Generate a ribbon-aligned sculpture texture with the desired relief and lighting-neutral color.
2. Estimate monocular depth from that exact image; align its crop and mask, remove the background, and smooth uncertain depth edges.
3. Convert the relative depth to bounded relief and a confidence/stiffness map.
4. Feed relief to the rest geometry and stiffness to local constraints. Use a separate normal map for high-frequency detail.

A single image provides relative visible-surface depth, not a full reconstruction of the sculpture or its back. Low-resolution depth should set broad geometry; it should not introduce noisy, stiff spikes into the cloth.

## Higher-end path

The next browser upgrade is a WebGPU compute solver with more particles and self-collision. C++/WASM is another CPU-solver option. A native Apple version could use Metal, but requires a separate native rendering/application layer.

Relevant primary documentation: [Three.js physical materials](https://threejs.org/docs/pages/MeshPhysicalMaterial.html), [Three.js WebGPU renderer](https://threejs.org/docs/pages/WebGPURenderer.html), and [Apple Metal](https://developer.apple.com/metal/).

## Files

- `src/cloth.js`: standalone cloth solver and depth-to-rest-shape mapping.
- `src/material.js`: material presets and procedural microstructure.
- `src/stage.js`: lights, reflection environment, and atmospheric shader.
- `src/main.js`: render loop, dense render mesh, camera, controls, and image inputs.
- `src/image-input.js`: image decoding, aligned depth sampling, and source-background shading.
- `src/style.css`: responsive studio interface.
- `tests/cloth.test.js`: floor/updraft behavior, anchoring, strain, reset, bending gradients, frame-independent depth constraints, and malformed-input checks.
- `scripts/estimate_depth.py`: reproducible local Core ML depth inference and scalar-field processing.

Google Fonts are used for the interface with system fallbacks. The scene itself needs no external assets or API keys.

## Smoke: 3D WebGPU fluid

Open **http://localhost:5187/?study=smoke**, or choose **Smoke**. A separate WebGPU renderer simulates an Eulerian smoke volume on an **80 × 120 × 64 grid (614,400 cells)**. The supplied photograph, foreground mask, and estimated depth define an initial 3D density source. The source's unseen interior is a shallow synthetic fill, not a reconstructed back surface.

Each step advects velocity, computes curl, applies buoyancy and vorticity confinement, solves pressure with 24 Jacobi iterations, removes the pressure gradient, then transports smoke, temperature, and a color tracer with limited MacCormack correction. A matching discrete divergence and gradient give the pressure solver a consistent seven-point Laplacian. The source adds density and heat; it does not constrain the moving fluid to stay inside the sculpture.

The volume is ray-marched with density-dependent extinction and light attenuation through the smoke. This uses WebGPU compute and a transparent WebGPU canvas over the Three.js studio. There are no particle sprites in Smoke mode. The studio background redraws when the camera or lighting changes; the fluid evolves every frame.

Controls:

- **Smoke density:** optical thickness.
- **Swirl strength:** vorticity confinement.
- **Sculpture depth:** depth scale of the source. Choose **Reveal sculpture again** to immediately reseed at the new depth.
- **Dissipation:** how quickly density fades.
- **Source strength:** continuing emission. Zero lets the initial sculpture disperse freely.
- **Reveal sculpture again:** reseed density and reset velocity/pressure.
- **Wind / Turbulence:** ambient flow and external stirring. Warm smoke still rises when ambient wind is zero.
- **Pause:** freeze the fluid; camera orbit stays available.

`window.__veil.smoke.diagnostics()` in development reads actual GPU fields to report pre/post-projection divergence, finite density, mass, and centroid. This is a real-time fluid approximation with finite grid resolution, bounded timesteps, simplified thermal buoyancy, and an open volume boundary. It is not a calibrated engineering flow model.

Primary method references: [GPU Gems: Fast Fluid Dynamics](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu), [GPU Gems 3: Real-Time 3D Fluids](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids), and the [WebGPU specification](https://gpuweb.github.io/gpuweb/).

## GitHub Pages

The Pages workflow builds and tests the project on pushes to `codex/ribbon-lab`, then publishes `dist/`. Relative asset URLs work under a repository path. Smoke requires WebGPU in the viewing browser; Ribbon uses WebGL 2. The model weights and Python runtime are not shipped to Pages: the sculpture's image and depth assets are precomputed.
