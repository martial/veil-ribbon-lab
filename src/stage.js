import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

const noiseGLSL = `
  float hash(vec3 p) {
    p = fract(p * .3183099 + vec3(.11,.17,.23));
    p *= 17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
  }
  float noise(vec3 p) {
    vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
`;

export function createStage(scene, renderer) {
  RectAreaLightUniformsLib.init();
  scene.background = new THREE.Color('#080d11');
  scene.fog = new THREE.FogExp2('#080d11', 0.035);

  // An HDR studio built from luminous softboxes gives coherent reflections
  // along the folds without depending on a remote HDRI download.
  const studio = new THREE.Scene();
  studio.background = new THREE.Color('#101922');
  const softbox = (position, scale, color, intensity) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide,
    }));
    mesh.position.set(...position); mesh.scale.set(...scale, 1); mesh.lookAt(0, 0, 0); studio.add(mesh);
  };
  softbox([-4, 2, 3], [0.6, 7], '#dcecff', 9);
  softbox([3, 4, -2], [6, 0.38], '#fff0dc', 18);
  softbox([2, -1, 4], [0.25, 5], '#f4efee', 4);
  softbox([-2, -3, -1], [1.6, 1.6], '#e1f3ff', 12);
  softbox([0, 5, 2], [5, 1.4], '#9db2c5', 1.5);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(studio, 0.025, 0.1, 30);
  scene.environment = environment.texture;
  pmrem.dispose();
  studio.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });

  const key = new THREE.RectAreaLight('#e9e6df', 3, 2, 5);
  key.position.set(-3, 3, 4); key.lookAt(0, 0.5, 0); scene.add(key);
  const rim = new THREE.RectAreaLight('#ffebd2', 22, 5, 0.45);
  rim.position.set(1, 3.5, -2); rim.lookAt(0, 0, 0); scene.add(rim);
  const fill = new THREE.RectAreaLight('#8dacc8', 2.5, 1, 3);
  fill.position.set(4, 0, 2); fill.lookAt(0, 0, 0); scene.add(fill);
  scene.add(new THREE.HemisphereLight('#91a9bd', '#101923', 0.17));
  const spot = new THREE.SpotLight('#e6ecf0', 35, 15, Math.PI * 0.15, 0.85, 2);
  spot.position.set(-2.45, -2.5, 0.75); spot.target.position.set(-0.75, 2, -0.8);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0003;
  spot.shadow.normalBias = 0.025;
  spot.shadow.camera.near = 0.15;
  spot.shadow.camera.far = 12;
  scene.add(spot, spot.target);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.ShadowMaterial({
    color: '#02070b', opacity: 0.18, depthWrite: false,
  }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -2.64; floor.receiveShadow = true; scene.add(floor);

  const volume = new THREE.Mesh(new THREE.BoxGeometry(12, 10, 8), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: true,
    uniforms: { time: { value: 0 }, strength: { value: 1 } },
    vertexShader: `varying vec3 vWorld; void main(){ vec4 world=modelMatrix*vec4(position,1.);vWorld=world.xyz;gl_Position=projectionMatrix*viewMatrix*world; }`,
    fragmentShader: `
      varying vec3 vWorld;
      uniform float time;
      uniform float strength;
      ${noiseGLSL}
      void main(){
        vec3 rd=normalize(vWorld-cameraPosition), ro=cameraPosition;
        vec3 lo=vec3(-6.,-2.63,-5.), hi=vec3(6.,6.,3.);
        vec3 t0=(lo-ro)/rd, t1=(hi-ro)/rd;
        vec3 tmin=min(t0,t1),tmax=max(t0,t1);
        float nearT=max(0.,max(tmin.x,max(tmin.y,tmin.z)));
        float farT=min(tmax.x,min(tmax.y,tmax.z));
        if(farT<=nearT) discard;
        float stepSize=(farT-nearT)/56.;
        float jitter=hash(vec3(gl_FragCoord.xy,0.));
        vec3 origin=vec3(-2.45,-2.5,.75), direction=normalize(vec3(1.7,4.5,-1.55));
        float light=0.,haze=0.;
        for(int i=0;i<56;i++){
          vec3 p=ro+rd*(nearT+(float(i)+jitter)*stepSize);
          vec3 relative=p-origin;
          float h=dot(relative,direction);
          float radial=length(relative-direction*h);
          float radius=.032+max(h,0.)*.29;
          float q=radial/radius;
          if(h>0. && q<1.){
            float n=noise(p*2.1+vec3(time*.10,-time*.14,time*.06));
            float density=(.7+n*.6)*(1.-smoothstep(.2,1.,q));
            light+=density*stepSize*.21/(.3+h*h*.22);
          }
          float n=noise(p*.7+vec3(time*.02,-time*.027,0.));
          haze+=n*stepSize*.0016*exp(-length(p-vec3(-2.,.6,-2.))*.25);
        }
        vec3 bg=vec3(.00243,.00402,.00560);
        vec3 color=bg+vec3(.37,.56,.73)*(light*.9+haze)*strength;
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  }));
  volume.position.set(0, 1.5, -1);
  // Opaque ordering includes the beam in the ribbon's transmission render.
  volume.renderOrder = -10;
  volume.frustumCulled = false;
  // Haze is low-frequency content: ray march it at reduced resolution while
  // keeping the cloth, normals, specular highlights, and shadows full-size.
  const volumeScene = new THREE.Scene();
  volumeScene.background = new THREE.Color('#080d11');
  volumeScene.add(volume);
  const volumeTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  volumeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
  volume.material.toneMapped = false;
  scene.background = volumeTarget.texture;
  const drawingSize = new THREE.Vector2();

  const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 128;
  const context = glowCanvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(0.07, '#e7f5ffff');
  gradient.addColorStop(0.25, '#92c6e966'); gradient.addColorStop(1, '#4d93c200');
  context.fillStyle = gradient; context.fillRect(0, 0, 128, 128);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color: '#bde0f7', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  glow.position.copy(spot.position); glow.scale.set(0.25, 0.25, 0.25); scene.add(glow);

  return {
    update(time) { volume.material.uniforms.time.value = time; },
    renderAtmosphere(camera) {
      renderer.getDrawingBufferSize(drawingSize);
      const width = Math.max(1, Math.round(drawingSize.x * .45));
      const height = Math.max(1, Math.round(drawingSize.y * .45));
      if (volumeTarget.width !== width || volumeTarget.height !== height) volumeTarget.setSize(width, height);
      const previousTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(volumeTarget);
      renderer.render(volumeScene, camera);
      renderer.setRenderTarget(previousTarget);
    },
    setLight(value) {
      key.intensity = 3 * value; rim.intensity = 22 * value; fill.intensity = 2.5 * value;
      spot.intensity = 35 * value; glow.material.opacity = Math.min(1, value);
      volume.material.uniforms.strength.value = value;
    },
    dispose() { environment.dispose(); glowTexture.dispose(); volumeTarget.dispose(); volume.geometry.dispose(); volume.material.dispose(); },
  };
}
