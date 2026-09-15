# Projecting an image through mist

## What the experiments demonstrate

- **Rakkolainen et al., “Mid-air display experiments to create novel user interfaces” (2009).** A thin fog screen catches rear-projected light. Forward scattering makes the viewing direction important. Dark image regions stay comparatively transparent. The paper reports image degradation from oblique views and blending through the thickness of the fog layer. [Paper](https://link.springer.com/article/10.1007/s11042-009-0280-1)
- **Lam, Chen and Huang, “A Novel Volumetric Display using Fog Emitter Matrix” (ICRA 2015).** Individually switched nozzles, synchronized with projected imagery, create a nonplanar scattering medium. Different image regions can therefore appear at different physical depths. [Author project, images and video](https://binchen.me/ICRA2015fogdisplay.html)
- **Barnum, Narasimhan and Kanade, “A Multi-Layered Display with Water Drops” (SIGGRAPH 2010).** Synchronized water-drop layers and a projector-camera system divide projected light in space and time. The prototype displays imagery on up to four layers; controlled drop timing avoids occluding the same projector ray. This is a layered-depth display, not an ordinary fountain with a single video projected over it. [CMU project and demonstration videos](https://www.cs.cmu.edu/~ILIM/projects/IL/waterDisplay2/) · [Paper](https://www.cs.cmu.edu/~ILIM/projects/IL/waterDisplay2/papers/barnum10multi.pdf)

## Changes to the smoke study

The image is **light**, separate from smoke density. An Eulerian simulation transports density and heat from floor jets. The renderer samples the photograph in a fixed rear projector's perspective coordinates at every ray-march sample. Pixel apertures form small light columns through the volume. Density modulates their brightness; Beer–Lambert attenuation weakens the light through thicker smoke. A forward-peaked phase approximation changes the brightness with viewing angle.

The relative sculpture depth places a Gaussian scattering layer along each pixel ray. This is an **art-directed approximation of a shaped or multiplexed mist display**. It does not claim that a conventional projector can select an arbitrary distance along a ray through uncontrolled smoke. “Light through the mist” adds illumination away from the selected layer, revealing the blur and light trails of volumetric projection. “Flat fog screen” sets the selected layer to zero relief. Turning the projector off leaves only the moving mist.

The fluid does not contain a rigid statue, a statue-shaped density source, a particle sprite image, or an emissive sculpture mesh. The supplied image retains its original photographic lighting. A single estimated depth map gives only a visible-surface relief, not a full statue reconstruction.

## Separate experiment: live projection onto cloth

This is a different optical setup: capture the **ribbon's geometry depth** from a projector camera, use that image as the initialization for SD-Turbo img2img, and project the generated RGB result back onto the moving cloth. A fresh projector depth buffer tests visibility so a front fold can occlude a back fold. The projector starts at the viewer, then remains fixed unless repositioned or set to follow.

- [SD-Turbo model card and img2img API](https://huggingface.co/stabilityai/sd-turbo): distilled SD 2.1, compatible with single-step inference. This experiment uses a custom Euler noise timestep to adjust transformation continuously with one denoising evaluation.
- [StreamDiffusion](https://github.com/cumulo-autumn/StreamDiffusion): a useful future CUDA/TensorRT backend. Its reported high frame rates are measured on an RTX 4090 setup; they are not a benchmark for this Mac.

Depth is currently an **image initialization**, not a trained ControlNet condition or a geometry guarantee. Fixed noise reduces random flicker but does not establish temporal coherence. The frame-by-frame implementation prepares the next ribbon pose offscreen, then presents its generated image, pose, projector matrix, and visibility buffer together. The previous complete pair remains visible until generation finishes. Each pair advances simulation time by 1/30 second; inference determines wall-clock playback speed. Projector moves are also latched per frame.
