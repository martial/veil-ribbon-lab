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

## Smoke: projected light through a WebGPU fluid

Open **http://localhost:5187/?study=smoke**, or choose **Smoke**. A separate WebGPU renderer simulates an Eulerian smoke volume on an **80 × 120 × 64 grid (614,400 cells)**. The initial mist and continuing floor jets are independent of the sculpture photograph. Velocity advection, buoyancy, vorticity confinement, 24 Jacobi pressure iterations, a matching discrete divergence/gradient, and limited MacCormack density transport drive the motion.

The photograph is sampled as fixed rear-projected light through this volume. The depth map selects scattering layers, so image pixels can appear at different distances. This selection is a visual approximation of shaped or multiplexed fog displays, not a capability of an ordinary projector shining into arbitrary smoke. No image pixels are carried as a dye, and there is no textured sculpture mesh or sprite cloud.

- **Projector light / Projector on:** brightness and a direct comparison with unlit smoke.
- **Image resolution:** horizontal projector pixel count. Lower values expose individual light columns.
- **Image depth / Flat fog screen:** depth relief versus a planar layer.
- **Layer softness:** thickness of the selected scattering layer.
- **Light through the mist:** illumination outside that layer; more spill reduces image clarity.
- **Fluid settings:** optical density, vorticity, dissipation, and floor emission.
- **Refill mist:** reset the fluid, without changing the projector image.
- **Wind / Turbulence:** ambient airflow and stirring; warm mist also has buoyancy.

`window.__veil.smoke.diagnostics()` in development reads the actual GPU fields and reports divergence before/after pressure projection, finite density, mass, and centroid. This is a real-time fluid approximation with finite resolution, bounded timesteps, simplified thermal buoyancy, and an open boundary.

[Research notes: fog projection, multilayer water droplets, and what is approximated](docs/projection-research.md).

Primary fluid references: [GPU Gems: Fast Fluid Dynamics](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu) and [GPU Gems 3: Real-Time 3D Fluids](https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids).

## Live projection: ribbon depth → SD-Turbo → ribbon

Open **http://localhost:5187/?study=projection**. The projector starts at the viewing camera's position. **Project from this view** repositions it; **Follow viewer** keeps it attached to the camera. A labeled calibration grid lets you inspect placement and fold occlusion without running inference.

Every render frame captures the current ribbon's depth into a GPU target. When the model is ready, one asynchronous readback sends the newest depth image to the local service. The returned image is projected in camera coordinates onto the moving ribbon. A live projector depth buffer prevents light passing through an occluding front fold. **Start generation** runs continuously with one request at a time and no backlog. Separate metrics show generated FPS and end-to-end frame delay.

### Run the local model

```sh
uv venv --python 3.12 .venv-turbo
uv pip install --python .venv-turbo/bin/python -r scripts/requirements-turbo.txt
.venv-turbo/bin/python scripts/turbo_server.py
```

The service listens on **127.0.0.1:5192**. Vite proxies `/turbo` to it; restart Vite after changing its config. First launch downloads SD-Turbo's FP16 weights into ignored `.models/turbo/`. The service uses PyTorch MPS on Apple Silicon, CUDA where available, otherwise CPU. It caches prompt embeddings and uses a fixed seed plus one denoising evaluation. **Image transformation** changes the input noise timestep, not the number of queued frames.

The model consumes the grayscale depth image as **img2img initialization**. This is not a trained depth ControlNet and does not guarantee depth-consistent output. The generated image can lag the moving ribbon; the displayed timing makes that visible. This implementation does not claim 30 generated FPS on the Mac. Generation at 256 or 384 pixels trades image quality for speed; SD-Turbo's preferred resolution is 512 pixels.

Measured on the M3 Pro in this workspace at 384 × 384: about 0.74 seconds of inference and 1.1 seconds end-to-end per image (roughly 0.9 generated FPS), while the WebGL study runs concurrently. These are prototype measurements, not a hardware guarantee. Run `.venv-turbo/bin/python -m unittest tests/turbo_server_test.py` to check input validation without loading model weights.

The connection panel also accepts a service implementing `GET /health` and `POST /generate` with the contract in `scripts/turbo_server.py`. Model weights, Python environments, and incoming frames are not published. GitHub Pages can display the projection study but cannot run Python inference; viewers need a running local or remote compatible service. Browser local-network permissions may apply when connecting from the public site.

## GitHub Pages

The Pages workflow builds and tests the project on pushes to `codex/ribbon-lab`, then publishes `dist/`. Relative asset URLs work under a repository path. Smoke requires WebGPU in the viewing browser; Ribbon uses WebGL 2. The model weights and Python runtime are not shipped to Pages: the sculpture's image and depth assets are precomputed.
