import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RibbonCloth } from './cloth.js';
import { createSurfaceTextures, createRibbonMaterial, setMaterialPreset } from './material.js';
import { createStage } from './stage.js';
import { createSculptureSmoke } from './smoke.js';
import { decodeImage, loadLocalSample, orientToRibbon, depthSamples, attachSourceMask } from './image-input.js';

const $ = id => document.getElementById(id);
let toastTimer;
function toast(message) {
  $('toast').textContent = message; $('toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3500);
}

async function start() {
  const viewport = $('viewport');
  const requestedStudy=new URLSearchParams(location.search).get('study');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
  renderer.transmissionResolutionScale = .75;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.03;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  let activeStudy='ribbon',smoke=null,smokePromise=null;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true; orbit.dampingFactor = 0.055; orbit.enablePan = false;
  orbit.minDistance = 4.8; orbit.maxDistance = 16; orbit.minPolarAngle = 0.48; orbit.maxPolarAngle = Math.PI * 0.54;
  const homeView = () => {
    const portrait = viewport.clientWidth / viewport.clientHeight < 0.9;
    camera.position.set(0.0, activeStudy==='smoke'?.2:0.0, portrait ? 11.0 : 8.8);
    orbit.target.set(-.1, activeStudy==='smoke'?.15:-.35, 0); orbit.update();
  };
  homeView();
  const cloth = new RibbonCloth();
  // Let gravity and airflow establish the initial drape before displaying it.
  if (!reducedMotion&&requestedStudy!=='smoke') for (let i=0;i<480;i++) cloth.step();
  const textures = createSurfaceTextures(renderer);
  const material = createRibbonMaterial(textures);
  const sourceMask = attachSourceMask(material);
  const renderColumns = 160, renderRows = 48;
  const geometry = new THREE.PlaneGeometry(1, 1, renderColumns, renderRows);
  const positions = geometry.attributes.position;
  positions.setUsage(THREE.DynamicDrawUsage);
  // Both imported images share a top-left origin: UV v=1 is the image's top.
  for (let y = 0; y <= renderRows; y++) for (let x = 0; x <= renderColumns; x++) {
    geometry.attributes.uv.setXY(y * (renderColumns + 1) + x, x / renderColumns, y / renderRows);
  }
  geometry.attributes.uv.needsUpdate = true;
  // PlaneGeometry's index winding is opposite to our rising-v ribbon coordinates.
  const indices = geometry.index.array;
  for (let i = 0; i < indices.length; i += 3) { const tmp = indices[i]; indices[i] = indices[i + 2]; indices[i + 2] = tmp; }
  const ribbon = new THREE.Mesh(geometry, material);
  ribbon.castShadow = true; ribbon.receiveShadow = false; ribbon.frustumCulled = false;
  scene.add(ribbon);
  const floorRig=new THREE.Group();scene.add(floorRig);
  // A floor-mounted clip gathers the middle of one short edge.
  const clampMaterial = new THREE.MeshStandardMaterial({color:'#454c50',metalness:.85,roughness:.35});
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(.22,.07,.16),clampMaterial);
  clamp.position.set(-1.8,-2.61,-.04);floorRig.add(clamp);
  const basePlate = new THREE.Mesh(new THREE.BoxGeometry(.37,.035,.29),clampMaterial);
  basePlate.position.set(-1.8,-2.637,-.04);floorRig.add(basePlate);
  for(const x of [-1.94,-1.66]) {
    const screw=new THREE.Mesh(new THREE.CylinderGeometry(.016,.016,.008,8),clampMaterial);
    screw.position.set(x,-2.615,-.04);floorRig.add(screw);
  }
  const stage = createStage(scene, renderer);

  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.14, 0.6, 1.1);
  composer.addPass(bloom); composer.addPass(new OutputPass());

  // Interpolate the simulated surface; never animate its vertices separately.
  const updateGeometry = () => {
    const array = positions.array;
    for (let y = 0; y <= renderRows; y++) for (let x = 0; x <= renderColumns; x++) {
      const u = x / renderColumns, v = y / renderRows, k = (y * (renderColumns + 1) + x) * 3;
      cloth.sample(u, v, array, k);
    }
    positions.needsUpdate = true; geometry.computeVertexNormals();
  };
  updateGeometry();

  let portraitLayout = viewport.clientWidth / viewport.clientHeight < 0.9;
  const resize = () => {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const portrait = width / height < 0.9;
    if (portrait !== portraitLayout) { portraitLayout = portrait; homeView(); }
    camera.aspect = width / height; camera.updateProjectionMatrix();
    renderer.setSize(width, height); composer.setSize(width, height);
  };
  const observer = new ResizeObserver(resize); observer.observe(viewport); resize();
  let paused = reducedMotion;
  const syncPause = () => {
    $('pause-label').textContent = paused ? 'Resume' : 'Pause';
    $('pause').setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
    $('pause').setAttribute('aria-pressed', String(paused));
    $('pause-icon').innerHTML = paused ? '<path d="M4 2.5L13 8l-9 5.5z"/>' : '<path d="M5 3v10M11 3v10"/>';
    $('play-state').textContent = paused ? 'Still frame' : 'Live simulation';
  };
  syncPause();
  const togglePause = () => { paused = !paused; syncPause(); };
  $('pause').addEventListener('click', togglePause);
  $('reset').addEventListener('click', () => { if(activeStudy==='smoke')smoke?.reset();else cloth.reset();homeView();updateGeometry();toast('Study and view reset'); });
  const toggleUI = () => { $('studio').classList.toggle('ui-hidden'); resize(); };
  $('hide-ui').addEventListener('click', toggleUI); $('show-ui').addEventListener('click', toggleUI);
  const onKey = event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === 'Space') { event.preventDefault(); togglePause(); }
    if (event.key.toLowerCase() === 'h') toggleUI();
  };
  window.addEventListener('keydown', onKey);

  const syncRange = id => {
    const input = $(id), value = Number(input.value);
    $(id + '-value').value = value.toFixed(2);
    input.style.setProperty('--progress', `${(value - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
  };
  for (const id of ['wind', 'turbulence', 'transmission', 'light', 'memory', 'relief']) {
    syncRange(id);
    $(id).addEventListener('input', () => {
      syncRange(id); const value = Number($(id).value);
      if (id === 'transmission') {
        if ((material.transmission === 0) !== (value === 0)) material.needsUpdate = true;
        material.transmission = value;
      }
      else if (id === 'light') stage.setLight(value);
      else if (id === 'relief') { cloth.params.relief = value; cloth.rebuildRest(); updateGeometry(); }
      else cloth.params[id] = value;
    });
  }
  $('still-air').addEventListener('click', () => {
    cloth.gust=0;$('wind').value='0';$('wind').dispatchEvent(new Event('input'));
    toast(activeStudy==='smoke'?'Airflow stopped':'Airflow stopped — the ribbon falls back to the floor');
  });
  $('breeze').addEventListener('click', () => {
    $('wind').value='.85';$('wind').dispatchEvent(new Event('input'));
  });
  $('gust').addEventListener('click', () => {
    cloth.gust+=.55;toast('A short gust of air');
  });
  let activePreset = 'film', importedTexture = null, importedMask = null, showingDepth = false, sampleVersion = 0;
  const preset = name => {
    activePreset = name;
    $('material-caption').textContent = setMaterialPreset(material, name);
    material.roughnessMap = ['stone','film'].includes(name) ? null : textures.roughness;
    material.normalMap = name==='film' ? textures.filmNormal : textures.normal;
    if (importedTexture && !showingDepth) material.color.set('#ffffff');
    $('transmission').value = material.transmission; syncRange('transmission');
    document.querySelectorAll('[data-material]').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.material === name)));
  };
  preset('film');
  document.querySelectorAll('[data-material]').forEach(button => button.addEventListener('click', () => {
    preset(button.dataset.material);
  }));

  // Local file inputs: neither texture nor depth data leaves the browser.
  // Per-input generations prevent slow earlier decodes from replacing newer files.
  const generations = { texture: 0, depth: 0 };
  const syncDepthView = () => {
    $('depth-only').disabled = !cloth.depth;
    $('depth-only').setAttribute('aria-pressed', String(showingDepth));
    $('depth-only').textContent = showingDepth ? 'Show photograph on surface' : 'Show shape without texture';
    $('surface-view').hidden = !cloth.depth || !importedTexture;
    $('surface-view').setAttribute('aria-pressed', String(!showingDepth));
    material.map = showingDepth ? null : importedTexture;
    material.color.set(showingDepth ? '#c4b9a5' : importedTexture ? '#ffffff' : '#c8d7e0');
    sourceMask.sourceMaskEnabled.value = importedMask && !showingDepth ? 1 : 0;
    material.needsUpdate = true;
  };
  const applyTexture = (canvas, name) => {
    importedTexture?.dispose(); importedTexture = new THREE.CanvasTexture(canvas);
    importedTexture.colorSpace = THREE.SRGBColorSpace;
    importedTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    showingDepth = false; syncDepthView();
    $('texture-name').textContent = name; $('clear-texture').disabled = false;
  };
  const applyDepth = (canvas, name) => {
    cloth.setDepth(depthSamples(canvas, cloth)); updateGeometry();
    $('depth-name').textContent = name; $('clear-depth').disabled = false;
    $('memory').disabled = false; $('relief').disabled = false; $('depth-only').disabled = false;
  };
  $('texture-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    sampleVersion++;
    const generation = ++generations.texture;
    try {
      const canvas = await decodeImage(file);
      if (generation !== generations.texture) return;
      importedMask?.dispose(); importedMask = null; sourceMask.sourceMask.value = null;
      applyTexture(canvas, file.name);
      toast('Texture applied to the ribbon');
    } catch (error) { toast(error.message || 'The image could not be read.'); }
    finally { event.target.value = ''; }
  });
  $('depth-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    sampleVersion++;
    const generation = ++generations.depth;
    try {
      const canvas = await decodeImage(file);
      if (generation !== generations.depth) return;
      applyDepth(canvas, file.name);
      toast('Depth applied to the cloth’s rest shape and constraints');
    } catch (error) { toast(error.message || 'The depth map could not be read.'); }
    finally { event.target.value = ''; }
  });
  $('clear-texture').addEventListener('click', () => {
    sampleVersion++;
    generations.texture++; importedTexture?.dispose(); importedTexture = null; material.map = null;
    importedMask?.dispose(); importedMask = null; sourceMask.sourceMask.value = null;
    showingDepth = false; syncDepthView();
    const transmission = material.transmission; setMaterialPreset(material, activePreset); material.transmission = transmission;
    $('texture-name').textContent = 'Procedural surface'; $('clear-texture').disabled = true;
  });
  $('clear-depth').addEventListener('click', () => {
    sampleVersion++;
    generations.depth++; cloth.setDepth(null); updateGeometry();
    $('depth-name').textContent = 'No depth map loaded'; $('clear-depth').disabled = true; $('memory').disabled = true;
    $('relief').disabled = true; showingDepth = false; syncDepthView();
  });
  $('depth-only').addEventListener('click', () => { showingDepth = !showingDepth; syncDepthView(); });
  $('surface-view').addEventListener('click', () => $('depth-only').click());
  const selectStudy = study => {
    activeStudy=study;
    const isSmoke=study==='smoke';
    $('studio').classList.toggle('smoke-mode',isSmoke);
    ribbon.visible=!isSmoke;floorRig.visible=!isSmoke;
    if(smoke)smoke.setVisible(isSmoke);
    $('ribbon-study').setAttribute('aria-pressed', String(study === 'ribbon'));
    $('sculpture-study').setAttribute('aria-pressed', String(study === 'sculpture'));
    $('smoke-study').setAttribute('aria-pressed',String(isSmoke));
    $('smoke-panel').hidden=!isSmoke;$('surface-controls').hidden=isSmoke;
    $('sculpture-input-panel').hidden=isSmoke;
    document.querySelectorAll('.cloth-transmission').forEach(el=>el.hidden=isSmoke);
    $('surface-view').hidden=isSmoke||!cloth.depth||!importedTexture;
    document.querySelector('.intro .small-label').textContent=isSmoke?'A sculpture in a moving fluid':'Anchored to the floor';
    document.querySelector('.intro h1').innerHTML=isSmoke?'Form into<br>smoke.':'Lifted<br>by the wind.';
    document.querySelector('.intro p').innerHTML=isSmoke?'Warm smoke rises and curls.<br>The sculpture becomes its source.':'A ribbon, caught in an updraft.<br>Air flows up and to the right ↗';
    if(isSmoke)$('material-caption').textContent='Volumetric smoke';
    document.querySelector('.engine-tag').textContent=isSmoke?'WebGPU / 3D fluid':'Three.js / WebGL 2';
    const url = new URL(location.href);
    if(study==='ribbon')url.searchParams.delete('study');else url.searchParams.set('study',study);
    history.replaceState(null, '', url);
  };
  for(const [id,param] of [['smoke-density','density'],['smoke-pixels','vorticity'],['smoke-depth','depth'],['smoke-dispersion','dispersion'],['smoke-emission','emission']]) {
    syncRange(id);$(id).addEventListener('input',()=>{syncRange(id);if(smoke)smoke.params[param]=Number($(id).value);});
  }
  const loadSmoke=async()=>{
    const version=++sampleVersion;
    $('smoke-study').disabled=true;$('smoke-study').textContent='Loading…';
    try{
      if(!smokePromise)smokePromise=createSculptureSmoke(viewport,camera,toast).then(result=>{smoke=result;scene.add(smoke.group);return smoke;}).catch(error=>{smokePromise=null;throw error;});
      await smokePromise;
      if(version!==sampleVersion)return;
      selectStudy('smoke');homeView();
      toast('3D fluid ready — reset to reveal the sculpture again');
    }catch(error){toast(error.message||'Could not create the smoke study.');}
    finally{$('smoke-study').disabled=false;$('smoke-study').textContent='Smoke';}
  };
  $('smoke-study').addEventListener('click',loadSmoke);
  $('smoke-reveal').addEventListener('click',()=>smoke?.reset());
  const loadSculpture = async () => {
    const version = ++sampleVersion;
    generations.texture++; generations.depth++;
    $('sculpture-study').disabled = true; $('sculpture-study').textContent = 'Loading…';
    try {
      const [color, depth, mask] = await Promise.all([
        loadLocalSample(`${import.meta.env.BASE_URL}samples/sculpture-source.png`),
        loadLocalSample(`${import.meta.env.BASE_URL}samples/source-depth.png`),
        loadLocalSample(`${import.meta.env.BASE_URL}samples/source-mask.png`),
      ]);
      if (version !== sampleVersion) return;
      importedMask?.dispose(); importedMask = new THREE.CanvasTexture(orientToRibbon(mask));
      sourceMask.sourceMask.value = importedMask;
      applyTexture(orientToRibbon(color), 'Your sculpture · original photograph');
      cloth.params.memory = .85; $('memory').value = '.85'; syncRange('memory');
      cloth.params.relief = 1; $('relief').value = '1'; syncRange('relief');
      applyDepth(orientToRibbon(depth), 'Depth Anything V2 · estimated relief');
      preset('stone'); showingDepth = true; syncDepthView(); selectStudy('sculpture'); homeView();
      toast('Sculpture loaded — the depth now shapes the cloth');
    } catch (error) { toast(error.message || 'The sculpture sample could not be loaded.'); }
    finally { $('sculpture-study').disabled = false; $('sculpture-study').textContent = 'Sculpture'; }
  };
  $('sculpture-study').addEventListener('click', loadSculpture);
  $('ribbon-study').addEventListener('click', () => {
    sampleVersion++; generations.texture++; generations.depth++;
    $('clear-texture').click(); $('clear-depth').click();
    preset('film'); selectStudy('ribbon'); cloth.reset(); homeView(); updateGeometry();
  });
  $('capture').addEventListener('click', async () => {
    stage.renderAtmosphere(camera);
    composer.render();
    const output=document.createElement('canvas');output.width=renderer.domElement.width;output.height=renderer.domElement.height;
    const context=output.getContext('2d');context.drawImage(renderer.domElement,0,0);
    if(activeStudy==='smoke'){
      smoke.update(0,{wind:cloth.params.wind,turbulence:cloth.params.turbulence,dpr:renderer.getPixelRatio(),light:Number($('light').value)});
      await smoke.flush();context.drawImage(smoke.canvas,0,0,output.width,output.height);
    }
    output.toBlob(blob => {
      if (!blob) { toast('Could not create the image. Try again.'); return; }
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `veil-${activeStudy==='smoke'?'smoke':activePreset}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Still image saved');
    }, 'image/png');
  });

  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); renderer.setAnimationLoop(null);
    $('error-detail').textContent = 'The graphics context was interrupted. Reload the studio to continue.';
    $('error').hidden = false;
  });

  let lastTime = performance.now(), accumulator = 0, frames = 0, fpsTime = lastTime;
  let frameCount = 0, measuredFPS = 0,backgroundPose='';
  const fixedStep = 1 / 120;
  const animate = now => {
    const delta = Math.min((now - lastTime) / 1000, 1 / 15); lastTime = now;
    if (document.hidden) { accumulator = 0; return; }
    orbit.update();
    if(activeStudy==='smoke'&&smoke){
      cloth.gust*=Math.exp(-delta*1.5);
      smoke.update(paused?0:delta,{wind:cloth.params.wind+cloth.gust,turbulence:cloth.params.turbulence,dpr:renderer.getPixelRatio(),light:Number($('light').value)});
      accumulator=0;
    }else if (!paused) {
      accumulator += delta;
      while (accumulator >= fixedStep) { cloth.step(fixedStep); accumulator -= fixedStep; }
      updateGeometry();
    } else accumulator = 0;
    const pose=activeStudy==='smoke'?[...camera.matrixWorld.elements,$('light').value,viewport.clientWidth,viewport.clientHeight].join(','):'';
    if(activeStudy!=='smoke'||pose!==backgroundPose){
      stage.update(cloth.time);stage.renderAtmosphere(camera);composer.render();backgroundPose=pose;
    }
    frameCount++;frames++;
    if (now - fpsTime >= 1000) {
      measuredFPS = Math.round(frames * 1000 / (now - fpsTime));
      $('fps').textContent = `${measuredFPS} fps`; frames = 0; fpsTime = now;
    }
  };
  if(requestedStudy==='smoke')await loadSmoke();
  else if(requestedStudy==='sculpture')await loadSculpture();
  await renderer.compileAsync(scene, camera);
  stage.renderAtmosphere(camera);
  composer.render();
  $('loading').classList.add('loaded');
  renderer.setAnimationLoop(animate);
  if (import.meta.env.DEV) {
    window.__veil = {
      cloth, material, renderer, camera, orbit,get smoke(){return smoke;},
      advance(seconds) {
        if(!Number.isFinite(seconds)||seconds<0||seconds>30) throw new Error('Review step must be between 0 and 30 seconds');
        paused=true;syncPause();
        if(activeStudy==='smoke')smoke.update(seconds,{wind:cloth.params.wind+cloth.gust,turbulence:cloth.params.turbulence,dpr:renderer.getPixelRatio(),light:Number($('light').value)});
        else for(let i=0;i<Math.round(seconds/fixedStep);i++) cloth.step(fixedStep);
        updateGeometry();stage.update(cloth.time);stage.renderAtmosphere(camera);composer.render();
      },
      stats: () => ({study:activeStudy, frames: frameCount, fps: measuredFPS, paused, time: activeStudy==='smoke'?smoke.time:cloth.time, particles:activeStudy==='smoke'?0:cloth.count,cells:activeStudy==='smoke'?smoke.count:0, triangles:activeStudy==='smoke'?0:indices.length / 3, texture: !!material.map, depth: activeStudy==='smoke'||!!cloth.depth, size: [viewport.clientWidth, viewport.clientHeight] }),
    };
  }
  if (import.meta.hot) import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null); observer.disconnect(); orbit.dispose(); stage.dispose();
    smoke?.dispose();
    importedTexture?.dispose(); importedMask?.dispose(); textures.normal.dispose(); textures.filmNormal.dispose(); textures.roughness.dispose();
    scene.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
    composer.dispose(); bloom.dispose(); renderer.dispose();
    window.removeEventListener('keydown', onKey); clearTimeout(toastTimer);
  });
}

start().catch(error => {
  console.error(error);
  $('loading').classList.add('loaded');
  $('error-detail').textContent = `The scene could not start: ${error.message}. Try a current browser with hardware acceleration enabled.`;
  $('error').hidden = false;
});
