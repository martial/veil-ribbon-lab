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

The projector captures the **ribbon's geometry depth** and sends generated RGB light back onto that same pose. Camera-space visibility prevents a front fold from receiving light intended for a back fold. Every output is synchronized with its source pose, camera matrix and depth buffer. Both previews now show the same completed frame.

The initial SD-Turbo experiment used depth as img2img initialization. This could create an unrelated statue silhouette. The faster, shape-guided engine now uses **SDXS DreamShaper with the released sketch ControlNet**. Silhouette and fold edges are extracted from depth and fed to that network; an exact input mask bounds the projected image. The available weights are sketch-trained, not a trained depth ControlNet, and internal metric-depth consistency is not guaranteed.

- [SDXS paper and models](https://github.com/IDKiro/sdxs): compressed one-step generation, with an available sketch-conditioned variant.
- [Sketch ControlNet release](https://huggingface.co/IDKiro/sdxs-512-dreamshaper-sketch): the structure-guided model used here.
- [StreamDiffusion for Mac](https://github.com/ochyai/streamdiffusion-mac): Core ML and tiny-VAE experiments; its 22.7 FPS measurement is for an M3 Ultra, not this Mac.
- [SD-Turbo](https://huggingface.co/stabilityai/sd-turbo): retained as the original, slower MPS baseline.

The CPU rasterizer computes the same perspective-correct triangle depth without a GPU readback stall. A 256px comparison with WebGL found identical silhouette coverage and at most one 8-bit level of depth rounding difference. One private CPU pose is prepared while inference runs. Only complete pose/image pairs are presented, each advancing simulation by 1/30 second. Fixed noise and smoothly blended cached text embeddings provide gradual material variation; they do not constitute a temporal generative model.
