import * as THREE from 'three';

// Deterministic, tileable fiber detail. All assets are generated locally.
export function createSurfaceTextures(renderer) {
  const size = 512, normalData = new Uint8Array(size * size * 4), roughData = new Uint8Array(size * size * 4);
  const height = (x, y) => Math.sin(x * Math.PI / 2) * 0.24 + Math.sin(y * Math.PI / 2) * 0.15 +
    Math.sin(y * Math.PI / 16 + Math.sin(x * Math.PI / 128) * 0.4) * 0.20 +
    Math.sin(x * Math.PI / 32 + y * Math.PI / 64) * 0.06;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const dx = (height(x + 1, y) - height(x - 1, y)) * 0.65;
    const dy = (height(x, y + 1) - height(x, y - 1)) * 0.65;
    const len = Math.hypot(dx, dy, 1);
    normalData[i] = (0.5 - dx / len * 0.5) * 255;
    normalData[i + 1] = (0.5 - dy / len * 0.5) * 255;
    normalData[i + 2] = (0.5 + 1 / len * 0.5) * 255;
    normalData[i + 3] = 255;
    const rough = 165 + height(x, y) * 50;
    roughData[i] = roughData[i + 1] = roughData[i + 2] = rough;
    roughData[i + 3] = 255;
  }
  const create = data => {
    const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(7, 3);
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.generateMipmaps = true;
    map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    map.needsUpdate = true;
    return map;
  };
  // Fine, fixed creases in the film. These travel with its material coordinates;
  // only the actual cloth solver changes the silhouette or animates folds.
  const filmData=new Uint8Array(size*size*4);
  const crease=(u,v)=>.006*Math.sin(v*165+u*9+Math.sin(u*15)*.8)+
    .002*Math.sin(v*351-u*23+Math.sin(u*27)*.4)+.0015*Math.sin(v*83+u*20);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=x/size,v=y/size,e=1/size;
    const dx=(crease(u+e,v)-crease(u-e,v))/(2*e*4.8);
    const dy=(crease(u,v+e)-crease(u,v-e))/(2*e*1.9);
    const length=Math.hypot(dx,dy,1),k=(y*size+x)*4;
    filmData[k]=(0.5-dx/length*.5)*255;filmData[k+1]=(0.5-dy/length*.5)*255;
    filmData[k+2]=(.5+.5/length)*255;filmData[k+3]=255;
  }
  const filmNormal=create(filmData);filmNormal.repeat.set(1,1);
  filmNormal.wrapS=filmNormal.wrapT=THREE.ClampToEdgeWrapping;
  return { normal: create(normalData), filmNormal, roughness: create(roughData) };
}

export const materialPresets = {
  stone: { color: '#d9cbb7', roughness: 0.96, transmission: 0, opacity:1,transparent:false,depthWrite:true, sheen: 0, sheenRoughness: 1, clearcoat: 0, clearcoatRoughness: 1, metalness: 0, ior: 1.45, iridescence: 0, normalStrength: 0.08, label: 'Sculpture in motion' },
  film: { color: '#f2ece2', roughness: .28, transmission: .88, opacity:.76,transparent:true,depthWrite:false, sheen: .22, sheenRoughness: .36, clearcoat: .65, clearcoatRoughness: .15, metalness: 0, ior: 1.38, iridescence: 0, normalStrength: .14, label: 'Translucent film' },
  organza: { color: '#cad3e5', roughness: 0.68, transmission: 0.48, opacity:.88,transparent:true,depthWrite:false, sheen: 0.85, sheenRoughness: 0.5, clearcoat: 0.15, clearcoatRoughness: 0.3, metalness: 0, ior: 1.4, iridescence: 0, normalStrength: 0.52, label: 'Woven organza' },
  silk: { color: '#dbd0bd', roughness: 0.55, transmission: 0.10, opacity:1,transparent:false,depthWrite:true, sheen: 1, sheenRoughness: 0.26, clearcoat: 0.26, clearcoatRoughness: 0.27, metalness: 0, ior: 1.48, iridescence: 0.04, normalStrength: 0.25, label: 'Pearl silk' },
};

export function createRibbonMaterial(textures) {
  return new THREE.MeshPhysicalMaterial({
    side: THREE.DoubleSide,
    normalMap: textures.normal,
    roughnessMap: textures.roughness,
    normalScale: new THREE.Vector2(0.065, 0.065),
    sheenColor: new THREE.Color('#e7eef7'),
    specularIntensity: 1,
    thickness: 0.008,
    attenuationColor: new THREE.Color('#c2ddeb'),
    attenuationDistance: 1,
    envMapIntensity: 1.15,
    ...Object.fromEntries(Object.entries(materialPresets.film).filter(([k]) => !['normalStrength', 'label'].includes(k))),
  });
}

export function setMaterialPreset(material, name) {
  const { normalStrength, label, ...parameters } = materialPresets[name];
  material.setValues(parameters);
  material.normalScale.setScalar(normalStrength);
  material.needsUpdate = true;
  return label;
}
