import * as THREE from 'three';

export async function decodeImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  return canvas;
}

export async function loadLocalSample(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the sculpture sample (${response.status}).`);
  return decodeImage(await response.blob());
}

export function orientToRibbon(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.height; canvas.height = source.width;
  const context = canvas.getContext('2d');
  context.translate(canvas.width, 0); context.rotate(Math.PI / 2); context.drawImage(source, 0, 0);
  return canvas;
}

export function depthSamples(canvas, cloth) {
  const small = document.createElement('canvas'); small.width = cloth.columns + 1; small.height = cloth.rows + 1;
  const context = small.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingQuality = 'high';
  context.drawImage(canvas, 0, 0, small.width, small.height);
  const pixels = context.getImageData(0, 0, small.width, small.height).data;
  const depth = new Float32Array(cloth.count);
  for (let y = 0; y <= cloth.rows; y++) for (let x = 0; x <= cloth.columns; x++) {
    const src = ((cloth.rows - y) * small.width + x) * 4;
    depth[y * small.width + x] = (pixels[src] * 0.2126 + pixels[src + 1] * 0.7152 + pixels[src + 2] * 0.0722) / 255 * pixels[src + 3] / 255;
  }
  return depth;
}

// Blend the photographic background into the base cloth material. The original
// image on disk stays intact. This is a shader operation using a scalar mask.
export function attachSourceMask(material) {
  const uniforms = { sourceMask: { value: null }, sourceMaskEnabled: { value: 0 }, sourceGround: { value: new THREE.Color('#afa38e') } };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = `uniform sampler2D sourceMask; uniform float sourceMaskEnabled; uniform vec3 sourceGround;\n` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      #ifdef USE_MAP
        if (sourceMaskEnabled > .5) {
          float mask = texture2D(sourceMask, vMapUv).r;
          diffuseColor.rgb = mix(sourceGround, diffuseColor.rgb, mask);
        }
      #endif
    `);
  };
  material.customProgramCacheKey = () => 'veil-source-mask-v1';
  return uniforms;
}
