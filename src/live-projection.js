import * as THREE from 'three';

// Every visible generated frame is a matched geometry/image/projector pair.
// The next pose is simulated offscreen; the last complete pair stays visible.
export function createLiveProjection(renderer,ribbon,viewer,onStatus=()=>{},captureFrame=()=>0) {
  const camera=new THREE.PerspectiveCamera(40,1,.1,80);
  const scene=new THREE.Scene();scene.background=new THREE.Color(0);
  const depthMaterial=new THREE.ShaderMaterial({side:THREE.DoubleSide,toneMapped:false,
    uniforms:{nearDepth:{value:4.5},farDepth:{value:12}},
    vertexShader:'varying float metricDepth;void main(){vec4 p=modelViewMatrix*vec4(position,1.);metricDepth=-p.z;gl_Position=projectionMatrix*p;}',
    fragmentShader:'varying float metricDepth;uniform float nearDepth;uniform float farDepth;void main(){float d=1.-clamp((metricDepth-nearDepth)/(farDepth-nearDepth),0.,1.);gl_FragColor=vec4(vec3(.08+.92*d),1.);}',
  });
  const captureGeometry=ribbon.geometry.clone();
  const mesh=new THREE.Mesh(captureGeometry,depthMaterial);mesh.matrixAutoUpdate=false;mesh.frustumCulled=false;scene.add(mesh);
  const targets=[0,1].map(()=>{
    const t=new THREE.WebGLRenderTarget(384,384,{minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true});
    t.depthTexture=new THREE.DepthTexture(384,384,THREE.UnsignedIntType);return t;
  });
  let captureIndex=0;
  const patternCanvas=document.createElement('canvas');patternCanvas.width=patternCanvas.height=512;
  const ctx=patternCanvas.getContext('2d');
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    ctx.fillStyle=(x+y)%2?'#b7dfdf':'#cf8056';ctx.fillRect(x*64,y*64,64,64);
    ctx.fillStyle='#0d1b27';ctx.font='15px sans-serif';ctx.fillText(`${x},${y}`,x*64+10,y*64+34);
  }
  const pattern=new THREE.CanvasTexture(patternCanvas);pattern.colorSpace=THREE.SRGBColorSpace;
  const uniforms={projectionMap:{value:pattern},projectorMatrix:{value:new THREE.Matrix4()},
    projectorDepth:{value:targets[1].depthTexture},projectionPower:{value:1.3}};
  const material=new THREE.MeshPhysicalMaterial({color:'#64757e',roughness:.52,metalness:0,
    transmission:.22,thickness:.008,side:THREE.DoubleSide,sheen:.4,sheenColor:new THREE.Color('#cfdae2'),
    clearcoat:.16,envMapIntensity:.45});
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms);
    shader.vertexShader='varying vec4 projectorPosition;uniform mat4 projectorMatrix;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\nprojectorPosition=projectorMatrix*modelMatrix*vec4(transformed,1.);');
    shader.fragmentShader='varying vec4 projectorPosition;uniform sampler2D projectionMap;uniform sampler2D projectorDepth;uniform float projectionPower;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>',`#include <emissivemap_fragment>
      vec3 projected=projectorPosition.xyz/projectorPosition.w*.5+.5;
      if(projectorPosition.w>0.&&all(greaterThanEqual(projected,vec3(0.)))&&all(lessThanEqual(projected,vec3(1.)))){
        float visibleDepth=texture2D(projectorDepth,projected.xy).r;
        float visible=1.-smoothstep(.0002,.0012,projected.z-visibleDepth);
        vec3 imageLight=texture2D(projectionMap,projected.xy).rgb;
        totalEmissiveRadiance+=imageLight*projectionPower*visible;
      }`);
  };
  material.customProgramCacheKey=()=> 'live-projector-depth-occlusion-v1';
  const depthPreview=document.createElement('canvas'),generatedPreview=document.createElement('img');
  depthPreview.width=depthPreview.height=384;generatedPreview.alt='Most recent SD-Turbo generated image';
  generatedPreview.src=patternCanvas.toDataURL();
  const black=new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1);black.needsUpdate=true;
  const blankCanvas=document.createElement('canvas');blankCanvas.width=blankCanvas.height=1;
  blankCanvas.getContext('2d').fillRect(0,0,1,1);
  const blackPreview=blankCanvas.toDataURL();
  const state={active:false,running:false,busy:false,ready:false,model:'SD-Turbo',device:null,
    frames:0,captures:0,generated:0,capturedFrame:0,projectedFrame:0,simulationTime:0,sequence:0,
    inferenceMs:0,latencyMs:0,generatedFps:0,ageMs:0,error:null,stepRequested:false,
    mode:'grid',endpoint:import.meta.env.DEV?'/turbo':'http://127.0.0.1:5192',prompt:'An ancient bronze sculpture with intricate carved relief, oxidized turquoise and copper gold patina, detailed ornamental engravings, museum artifact, black background',
    seed:42,strength:.85,resolution:384,targetFps:30,follow:false};
  let disposed=false,generation=0,lastRequest=0,lastResult=0,nextHealth=0,healthBusy=false;
  let previewBusy=false,generatedTexture=null,modelAbort=null,originalMaterial=ribbon.material;
  let pendingFrame=null,nextFrameId=1,hasPresented=false,projectorQueued=false;
  const textureLoader=new THREE.TextureLoader();
  function copyViewer(){
    camera.copy(viewer);camera.aspect=1;
    camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(viewer.fov*.5))*Math.max(1,viewer.aspect)));
    camera.updateProjectionMatrix();camera.updateMatrixWorld();
    const distance=viewer.position.length();
    depthMaterial.uniforms.nearDepth.value=Math.max(.1,distance-3.8);
    depthMaterial.uniforms.farDepth.value=distance+3.2;
  }
  copyViewer();
  function placeProjector(){
    // Do not move the projected image while its corresponding pose is held.
    // Manual placement and viewer-follow take effect on the next capture.
    if(pendingFrame){projectorQueued=true;return;}
    copyViewer();
  }
  async function health(){
    if(healthBusy||disposed)return;
    healthBusy=true;
    try{
      const response=await fetch(state.endpoint+'/health',{signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error(`Model service: ${response.status}`);
      const result=await response.json();state.ready=result.status==='ready';state.device=result.device;
      if(result.error||state.status==='offline')state.error=result.error;state.model=result.model||'SD-Turbo';
      state.status=result.status;
    }catch(error){state.ready=false;state.status='offline';state.error='Start the local model service on this Mac.';}
    finally{healthBusy=false;if(!disposed)onStatus(state);}
  }
  function renderDepth(target){
    ribbon.updateMatrixWorld();mesh.matrix.copy(ribbon.matrixWorld);
    const previous=renderer.getRenderTarget(),clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
    renderer.setRenderTarget(target);renderer.setClearColor(0,0);renderer.clear();renderer.render(scene,camera);
    renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);
  }
  function copyGeometry(from,to){
    for(const name of ['position','normal']){
      to.attributes[name].array.set(from.attributes[name].array);to.attributes[name].needsUpdate=true;
    }
  }
  async function readDepth(target,epoch){
    const w=target.width,h=target.height,data=new Uint8Array(w*h*4);
    // Read once per generated frame (and only occasionally for calibration).
    // A held canvas may not submit another display frame to retire an async
    // readback fence. This small synchronous copy keeps capture deterministic.
    renderer.readRenderTargetPixels(target,0,0,w,h,data);
    if(disposed||!state.active||epoch!==generation)return null;
    const topDown=new Uint8ClampedArray(data.length);
    for(let y=0;y<h;y++)topDown.set(data.subarray((h-1-y)*w*4,(h-y)*w*4),y*w*4);
    depthPreview.width=w;depthPreview.height=h;
    depthPreview.getContext('2d').putImageData(new ImageData(topDown,w,h),0,0);
    return depthPreview.toDataURL('image/png');
  }
  function prepareFrame(){
    if(pendingFrame)return pendingFrame; // retry the same pose after an error
    if(state.follow||projectorQueued){copyViewer();projectorQueued=false;}
    const simulationTime=captureFrame(captureGeometry,hasPresented);
    const target=targets[captureIndex];target.setSize(state.resolution,state.resolution);
    const matrix=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    pendingFrame={id:nextFrameId,simulationTime,target,matrix};
    renderDepth(target);state.captures++;state.capturedFrame=nextFrameId;
    return pendingFrame;
  }
  async function requestFrame(){
    state.busy=true;const epoch=generation,started=performance.now();
    const controller=new AbortController();modelAbort=controller;
    // Latch settings together with the depth capture, before any await.
    const settings={prompt:state.prompt,seed:state.seed,strength:state.strength,endpoint:state.endpoint};
    try{
      const frame=prepareFrame();onStatus(state);
      const depth=await readDepth(frame.target,epoch);
      if(!depth||disposed||epoch!==generation)return;
      const response=await fetch(settings.endpoint+'/generate',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({frame_id:frame.id,depth,prompt:settings.prompt,seed:settings.seed,strength:settings.strength}),
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});
      const result=await response.json();
      if(disposed||epoch!==generation)return;
      if(response.status===429){lastRequest=performance.now()+1000;return;}
      if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:`Generation failed (${response.status})`);
      if(result.frame_id!==frame.id||!result.image?.startsWith('data:image/png;base64,'))throw new Error('Invalid model frame');
      const texture=await textureLoader.loadAsync(result.image);
      if(disposed||epoch!==generation){texture.dispose();return;}
      texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;
      // Present atomically: pose + normals + RGB + the exact projector matrix
      // and depth attachment captured for this frame. No old texture on a new pose.
      copyGeometry(captureGeometry,ribbon.geometry);
      uniforms.projectionMap.value=texture;
      uniforms.projectorMatrix.value.copy(frame.matrix);
      uniforms.projectorDepth.value=frame.target.depthTexture;
      generatedTexture?.dispose();generatedTexture=texture;generatedPreview.src=result.image;
      const now=performance.now();state.generatedFps=lastResult?1000/(now-lastResult):1000/(now-started);
      lastResult=now;state.inferenceMs=result.inference_ms;state.latencyMs=now-started;
      state.generated++;state.projectedFrame=frame.id;state.simulationTime=frame.simulationTime;
      state.error=null;state.stepRequested=false;hasPresented=true;
      captureIndex=1-captureIndex;nextFrameId++;pendingFrame=null;
    }catch(error){
      if(error.name!=='AbortError'&&!disposed&&epoch===generation){state.error=error.message;state.running=false;state.stepRequested=false;}
    }finally{
      if(modelAbort===controller){state.busy=false;modelAbort=null;}
      if(!disposed)onStatus(state);
    }
  }
  function resetSequence(){
    generation++;modelAbort?.abort();pendingFrame=null;hasPresented=false;nextFrameId=1;
    state.sequence++;
    state.running=false;state.stepRequested=false;state.projectedFrame=0;state.capturedFrame=0;
    state.generated=0;state.simulationTime=0;state.inferenceMs=0;state.latencyMs=0;state.generatedFps=0;state.error=null;lastResult=0;
    uniforms.projectionMap.value=state.mode==='grid'?pattern:black;
    generatedPreview.src=state.mode==='grid'?patternCanvas.toDataURL():blackPreview;
  }
  function selectGenerated(){
    state.mode='generated';state.error=null;
    if(!hasPresented){uniforms.projectionMap.value=black;generatedPreview.src=blackPreview;}
  }
  return {state,camera,material,depthPreview,generatedPreview,
    get target(){return targets[captureIndex];},
    get frameLocked(){return state.active&&state.mode==='generated';},
    get presentedMatrix(){return uniforms.projectorMatrix.value;},
    setActive(active){
      if(active===state.active)return;
      resetSequence();state.active=active;
      if(active){originalMaterial=ribbon.material;ribbon.material=material;copyViewer();health();}
      else{ribbon.material=originalMaterial;state.mode='grid';uniforms.projectionMap.value=pattern;}
    },
    setMode(mode){
      if(mode==='grid'){state.mode='grid';resetSequence();}
      else selectGenerated();
      onStatus(state);
    },
    placeProjector,health,reset:resetSequence,
    run(){selectGenerated();state.running=true;health();onStatus(state);},
    nextFrame(){selectGenerated();state.running=false;state.stepRequested=true;health();onStatus(state);},
    stop(){state.running=false;state.stepRequested=false;onStatus(state);},
    setPower(value){uniforms.projectionPower.value=value;},
    update(){
      if(!state.active||disposed)return;
      const now=performance.now();state.frames++;state.ageMs=lastResult?now-lastResult:0;
      if(now>nextHealth){nextHealth=now+3000;health();}
      if(state.mode==='grid'){
        if(state.follow)copyViewer();
        const target=targets[captureIndex];
        if(target.width!==state.resolution&&!previewBusy)target.setSize(state.resolution,state.resolution);
        copyGeometry(ribbon.geometry,captureGeometry);renderDepth(target);
        uniforms.projectorMatrix.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
        uniforms.projectorDepth.value=target.depthTexture;
        if(!previewBusy&&state.frames%20===1){
          previewBusy=true;readDepth(target,generation).catch(()=>{}).finally(()=>{previewBusy=false;});
        }
      }else if((state.running||state.stepRequested)&&state.ready&&!state.busy&&now-lastRequest>=1000/state.targetFps){
        lastRequest=now;requestFrame();
      }
      if(state.frames%20===0)onStatus(state);
    },
    dispose(){disposed=true;generation++;modelAbort?.abort();targets.forEach(t=>t.dispose());captureGeometry.dispose();depthMaterial.dispose();material.dispose();pattern.dispose();black.dispose();generatedTexture?.dispose();},
  };
}
