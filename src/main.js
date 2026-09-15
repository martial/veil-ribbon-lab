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
import { createLiveProjection } from './live-projection.js';
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
  let activeStudy='ribbon',smoke=null,smokePromise=null,projection=null,presentProjection=null;
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
  // At 256px projection resolution this interpolation is already subpixel.
  const renderColumns = requestedStudy==='projection'?96:160, renderRows = requestedStudy==='projection'?32:48;
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
  const writeGeometry = targetGeometry => {
    const array = targetGeometry.attributes.position.array;
    for (let y = 0; y <= renderRows; y++) for (let x = 0; x <= renderColumns; x++) {
      const u = x / renderColumns, v = y / renderRows, k = (y * (renderColumns + 1) + x) * 3;
      cloth.sample(u, v, array, k);
    }
    targetGeometry.attributes.position.needsUpdate = true;targetGeometry.computeVertexNormals();
  };
  const updateGeometry=()=>writeGeometry(geometry);
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
  const togglePause = () => { paused = !paused;syncPause();if(activeStudy==='projection'&&projection?.frameLocked){paused?projection.stop():projection.run();} };
  $('pause').addEventListener('click', togglePause);
  $('reset').addEventListener('click', () => { if(activeStudy==='smoke')smoke?.reset();else {projection?.reset();cloth.reset();}homeView();updateGeometry();toast('Study and view reset'); });
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
      else if (id === 'light') stage.setLight(value*(activeStudy==='smoke'?.12:1));
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
    const isSmoke=study==='smoke',isProjection=study==='projection';
    if(projection)projection.setActive(isProjection);
    $('studio').classList.toggle('projection-mode',isProjection);
    $('live-panel').hidden=!isProjection;
    $('projection-study').setAttribute('aria-pressed',String(isProjection));
    $('studio').classList.toggle('smoke-mode',isSmoke);
    ribbon.visible=!isSmoke;floorRig.visible=!isSmoke;
    stage.setLight(Number($('light').value)*(isSmoke?.12:1));
    if(smoke)smoke.setVisible(isSmoke);
    $('ribbon-study').setAttribute('aria-pressed', String(study === 'ribbon'));
    $('sculpture-study').setAttribute('aria-pressed', String(study === 'sculpture'));
    $('smoke-study').setAttribute('aria-pressed',String(isSmoke));
    $('smoke-panel').hidden=!isSmoke;$('surface-controls').hidden=isSmoke||isProjection;
    $('sculpture-input-panel').hidden=isSmoke||isProjection;
    document.querySelectorAll('.cloth-transmission').forEach(el=>el.hidden=isSmoke||isProjection);
    $('surface-view').hidden=isSmoke||isProjection||!cloth.depth||!importedTexture;
    document.querySelector('.intro .small-label').textContent=isSmoke?'An image, suspended in air':'Anchored to the floor';
    document.querySelector('.intro h1').innerHTML=isSmoke?'Light through<br>smoke.':'Lifted<br>by the wind.';
    document.querySelector('.intro p').innerHTML=isSmoke?'Pixels catch in the moving mist.<br>A photograph unfolds into depth.':'A ribbon, caught in an updraft.<br>Air flows up and to the right ↗';
    if(isSmoke)$('material-caption').textContent='Projected light / fluid mist';
    document.querySelector('.engine-tag').textContent=isSmoke?'WebGPU / 3D fluid':'Three.js / WebGL 2';
    if(isProjection){
      document.querySelector('.intro .small-label').textContent='Camera → depth → image → light';
      document.querySelector('.intro h1').innerHTML='A living<br>projection.';
      document.querySelector('.intro p').innerHTML='The ribbon shapes each image.<br>The projector sends it back as light.';
      $('material-caption').textContent='Live depth / SD-Turbo';
      document.querySelector('.engine-tag').textContent='Three.js / local diffusion';
    }
    const url = new URL(location.href);
    if(study==='ribbon')url.searchParams.delete('study');else url.searchParams.set('study',study);
    history.replaceState(null, '', url);
  };
  const updateProjectionStatus=state=>{
    if(state.active){
      const model=state.model.split('/').at(-1);
      $('material-caption').textContent=`Live depth / ${model}`;
      for(const option of $('live-resolution').options)option.disabled=!state.supportedSizes.includes(Number(option.value));
      $('live-resolution').value=String(state.resolution);
    }
    if(state.active&&state.mode==='generated'){
      paused=!state.running;syncPause();
      $('play-state').textContent=state.running?'Frame-by-frame playback':state.busy?'Generating one frame':'Frame held';
    }
    $('live-start').textContent=state.running?'Stop after this frame':'Run frame by frame';
    $('live-next').disabled=state.busy;
    const previewFrame=state.projectedFrame||state.capturedFrame;
    $('live-depth-label').textContent=previewFrame?`Depth · frame ${previewFrame}`:'Captured depth';
    $('live-drift-label').textContent=state.supportsDrift?state.driftLabel:'Fixed prompt';
    $('live-wander').disabled=!state.supportsDrift;$('live-drift').disabled=!state.supportsDrift;
    $('live-strength-label').textContent=state.structureControl?'Fold guidance':'Image transformation';
    $('live-start').setAttribute('aria-pressed',String(state.running));
    $('live-grid').setAttribute('aria-pressed',String(state.mode==='grid'));
    $('live-image-label').textContent=state.projectedFrame?`Projected · frame ${state.projectedFrame}`:state.mode==='grid'?'Calibration grid':'Waiting for first frame';
    $('live-rate').textContent=state.generated?`${state.generatedFps.toFixed(2)} fps`:'— fps';
    $('live-delay').textContent=state.generated?`${(state.latencyMs/1000).toFixed(2)} s`:'— ms';
    $('live-status').textContent=state.error||(!state.ready?state.status==='loading'?'Loading the model on this Mac…':'Local model offline':state.busy?`Generating frame ${state.capturedFrame} · holding ${state.projectedFrame||'initial pose'}`:state.projectedFrame?`Frame ${state.projectedFrame} · ${state.simulationTime.toFixed(3)} s of motion`:`${state.model.split('/').at(-1)} ready · ${state.device?.toUpperCase()||'GPU'}`);
  };
  const loadProjection=()=>{
    ++sampleVersion;
    if(!projection){
      projection=createLiveProjection(renderer,ribbon,camera,updateProjectionStatus,(nextGeometry,advance)=>{
        if(advance)for(let i=0;i<4;i++)cloth.step(1/120);
        writeGeometry(nextGeometry);return cloth.time;
      },()=>presentProjection?.());
      $('live-depth-preview').appendChild(projection.depthPreview);$('live-image-preview').appendChild(projection.generatedPreview);
      $('live-endpoint').value=projection.state.endpoint;
    }
    selectStudy('projection');
  };
  $('projection-study').addEventListener('click',loadProjection);
  $('live-start').addEventListener('click',()=>{if(!projection)return;paused=projection.state.running;syncPause();paused?projection.stop():projection.run();});
  $('live-next').addEventListener('click',()=>{paused=true;syncPause();projection?.nextFrame();});
  $('live-grid').addEventListener('click',()=>projection?.setMode(projection.state.mode==='grid'?'generated':'grid'));
  $('live-place').addEventListener('click',()=>{projection?.placeProjector();toast(projection?.frameLocked?'Projector placement applies to the next frame':'Projector placed at this view');});
  $('live-follow').addEventListener('click',()=>{if(projection){projection.state.follow=!projection.state.follow;$('live-follow').setAttribute('aria-pressed',String(projection.state.follow));}});
  $('live-wander').addEventListener('click',()=>{if(projection){projection.state.drifting=!projection.state.drifting;
    $('live-wander').setAttribute('aria-pressed',String(projection.state.drifting));$('live-wander').textContent=projection.state.drifting?'Prompt wandering':'Look held';}});
  $('live-prompt').addEventListener('change',()=>{if(projection)projection.state.prompt=$('live-prompt').value.trim()||projection.state.prompt;});
  $('live-endpoint').addEventListener('change',()=>{if(projection){projection.stop();projection.state.endpoint=$('live-endpoint').value.trim().replace(/\/$/,'');projection.health();}});
  $('live-resolution').addEventListener('change',()=>{if(projection)projection.state.resolution=Number($('live-resolution').value);});
  $('live-seed').addEventListener('change',()=>{if(projection)projection.state.seed=Math.max(0,Math.min(4294967295,Math.round(Number($('live-seed').value)||42)));});
  for(const id of ['live-power','live-strength','live-drift']){
    syncRange(id);$(id).addEventListener('input',()=>{syncRange(id);if(projection){if(id==='live-power')projection.setPower(Number($(id).value));else projection.state[id==='live-drift'?'drift':'strength']=Number($(id).value);}});
  }
  const projectionNote=()=>{
    const isFlat=Number($('smoke-depth').value)===0;
    $('projection-flat').setAttribute('aria-pressed',String(isFlat));
    $('projection-relief').setAttribute('aria-pressed',String(!isFlat));
    $('projection-note').textContent=isFlat?'A flat scattering layer. Increase light spill to see how an ordinary beam spreads through thick mist.':'Depth display uses the estimated depth to select scattering layers. Drag to see the relief.';
  };
  for(const [id,param] of [['smoke-density','density'],['smoke-swirl','vorticity'],['smoke-pixels','pixels'],['smoke-depth','depth'],['smoke-dispersion','dispersion'],['smoke-emission','emission'],['smoke-projector','projector'],['smoke-thickness','thickness'],['smoke-spill','spill']]) {
    const sync=()=>{
      syncRange(id);
      if(id==='smoke-pixels')$(id+'-value').value=`${$(id).value} px`;
      if(id==='smoke-depth')projectionNote();
    };
    sync();$(id).addEventListener('input',()=>{sync();if(smoke)smoke.params[param]=Number($(id).value);});
  }
  for(const [id,depth] of [['projection-flat',0],['projection-relief',1]])$(id).addEventListener('click',()=>{
    $('smoke-depth').value=String(depth);$('smoke-depth').dispatchEvent(new Event('input'));
  });
  $('projector-toggle').addEventListener('click',()=>{
    if(!smoke)return;
    smoke.params.enabled=!smoke.params.enabled;
    $('projector-toggle').textContent=smoke.params.enabled?'Projector on':'Projector off';
    $('projector-toggle').setAttribute('aria-pressed',String(smoke.params.enabled));
  });
  const loadSmoke=async()=>{
    const version=++sampleVersion;
    $('smoke-study').disabled=true;$('smoke-study').textContent='Loading…';
    try{
      if(!smokePromise)smokePromise=createSculptureSmoke(viewport,camera,toast).then(result=>{smoke=result;scene.add(smoke.group);return smoke;}).catch(error=>{smokePromise=null;throw error;});
      await smokePromise;
      if(version!==sampleVersion)return;
      selectStudy('smoke');homeView();
      toast('Projector ready — drag to look through the depth');
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
  let frameCount = 0, measuredFPS = 0,backgroundPose='',atmospherePose='';
  const fixedStep = 1 / 120;
  const renderScene=()=>{
    const pose=(activeStudy==='smoke'||activeStudy==='projection')?[activeStudy,...camera.matrixWorld.elements,$('light').value,viewport.clientWidth,viewport.clientHeight].join(','):'';
    const holdProjection=activeStudy==='projection'&&projection?.frameLocked;
    const displayKey=holdProjection?`${pose}:${projection.state.sequence}:${projection.state.projectedFrame}:${$('live-power').value}`:pose;
    if(holdProjection?displayKey!==backgroundPose:activeStudy!=='smoke'||pose!==backgroundPose){
      if(activeStudy!=='projection'||pose!==atmospherePose){stage.update(cloth.time);stage.renderAtmosphere(camera);atmospherePose=pose;}
      composer.render();backgroundPose=displayKey;
      if(holdProjection)projection.frameRendered();
    }
  };
  // Present each completed pair immediately; do not add another animation-frame
  // wait to the inference loop. Every generated image gets a real scene render.
  presentProjection=()=>{if(!document.hidden)renderScene();};
  const animate = now => {
    const delta = Math.min((now - lastTime) / 1000, 1 / 15); lastTime = now;
    if (document.hidden) { accumulator = 0; return; }
    orbit.update();
    if(activeStudy==='smoke'&&smoke){
      cloth.gust*=Math.exp(-delta*1.5);
      smoke.update(paused?0:delta,{wind:cloth.params.wind+cloth.gust,turbulence:cloth.params.turbulence,dpr:renderer.getPixelRatio(),light:Number($('light').value)});
      accumulator=0;
    }else if(activeStudy==='projection'&&projection?.frameLocked){
      accumulator=0; // The frame scheduler advances four physics steps per generated frame.
    }else if (!paused) {
      accumulator += delta;
      while (accumulator >= fixedStep) { cloth.step(fixedStep); accumulator -= fixedStep; }
      updateGeometry();
    } else accumulator = 0;
    if(activeStudy==='projection')projection?.update();
    renderScene();
    frameCount++;frames++;
    if (now - fpsTime >= 1000) {
      measuredFPS = Math.round(frames * 1000 / (now - fpsTime));
      $('fps').textContent = `${measuredFPS} fps`; frames = 0; fpsTime = now;
    }
  };
  if(requestedStudy==='smoke')await loadSmoke();
  else if(requestedStudy==='sculpture')await loadSculpture();
  else if(requestedStudy==='projection')loadProjection();
  await renderer.compileAsync(scene, camera);
  stage.renderAtmosphere(camera);
  composer.render();
  $('loading').classList.add('loaded');
  renderer.setAnimationLoop(animate);
  if (import.meta.env.DEV) {
    window.__veil = {
      cloth, material, geometry, renderer, camera, orbit,get smoke(){return smoke;},get projection(){return projection;},
      advance(seconds) {
        if(!Number.isFinite(seconds)||seconds<0||seconds>30) throw new Error('Review step must be between 0 and 30 seconds');
        paused=true;syncPause();
        if(activeStudy==='smoke'){
          let remaining=seconds;
          do {const dt=Math.min(remaining,1/30);smoke.update(dt,{wind:cloth.params.wind+cloth.gust,turbulence:cloth.params.turbulence,dpr:renderer.getPixelRatio(),light:Number($('light').value)});remaining-=dt;} while(remaining>1e-6);
        }
        else {if(activeStudy==='projection')projection.reset();for(let i=0;i<Math.round(seconds/fixedStep);i++) cloth.step(fixedStep);}
        updateGeometry();stage.update(cloth.time);stage.renderAtmosphere(camera);composer.render();
      },
      stats: () => ({study:activeStudy, frames: frameCount, fps: measuredFPS, paused, time: activeStudy==='smoke'?smoke.time:cloth.time, particles:activeStudy==='smoke'?0:cloth.count,cells:activeStudy==='smoke'?smoke.count:0, triangles:activeStudy==='smoke'?0:indices.length / 3, texture: !!material.map, depth: activeStudy==='smoke'||activeStudy==='projection'||!!cloth.depth, size: [viewport.clientWidth, viewport.clientHeight] }),
    };
  }
  if (import.meta.hot) import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null); observer.disconnect(); orbit.dispose(); stage.dispose();
    smoke?.dispose();projection?.dispose();
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
