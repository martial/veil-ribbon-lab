import * as THREE from 'three';

// A real projector camera. Rendering/capture continues independently of model
// inference. Only one capture is in flight, so slow generation has no backlog.
export function createLiveProjection(renderer,ribbon,viewer,onStatus=()=>{}) {
  const camera=new THREE.PerspectiveCamera(40,1,.1,80);
  const scene=new THREE.Scene();scene.background=new THREE.Color(0);
  const depthMaterial=new THREE.ShaderMaterial({side:THREE.DoubleSide,toneMapped:false,
    uniforms:{nearDepth:{value:4.5},farDepth:{value:12}},
    vertexShader:'varying float metricDepth;void main(){vec4 p=modelViewMatrix*vec4(position,1.);metricDepth=-p.z;gl_Position=projectionMatrix*p;}',
    fragmentShader:'varying float metricDepth;uniform float nearDepth;uniform float farDepth;void main(){float d=1.-clamp((metricDepth-nearDepth)/(farDepth-nearDepth),0.,1.);gl_FragColor=vec4(vec3(.08+.92*d),1.);}',
  });
  const mesh=new THREE.Mesh(ribbon.geometry,depthMaterial);mesh.matrixAutoUpdate=false;mesh.frustumCulled=false;scene.add(mesh);
  const target=new THREE.WebGLRenderTarget(384,384,{minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true});
  target.depthTexture=new THREE.DepthTexture(384,384,THREE.UnsignedIntType);
  const patternCanvas=document.createElement('canvas');patternCanvas.width=patternCanvas.height=512;
  const ctx=patternCanvas.getContext('2d');
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    ctx.fillStyle=(x+y)%2?'#b7dfdf':'#cf8056';ctx.fillRect(x*64,y*64,64,64);
    ctx.fillStyle='#0d1b27';ctx.font='15px sans-serif';ctx.fillText(`${x},${y}`,x*64+10,y*64+34);
  }
  const pattern=new THREE.CanvasTexture(patternCanvas);pattern.colorSpace=THREE.SRGBColorSpace;
  const uniforms={projectionMap:{value:pattern},projectorMatrix:{value:new THREE.Matrix4()},
    projectorDepth:{value:target.depthTexture},projectionPower:{value:1.3}};
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
  const state={active:false,running:false,busy:false,ready:false,model:'SD-Turbo',device:null,
    frames:0,captures:0,generated:0,inferenceMs:0,latencyMs:0,generatedFps:0,ageMs:0,error:null,
    mode:'grid',endpoint:import.meta.env.DEV?'/turbo':'http://127.0.0.1:5192',prompt:'An ancient bronze sculpture with intricate carved relief, oxidized turquoise and copper gold patina, detailed ornamental engravings, museum artifact, black background',
    seed:42,strength:.85,resolution:384,targetFps:30,follow:false};
  let disposed=false,generation=0,lastRequest=0,lastResult=0,nextHealth=0,healthBusy=false;
  let previewBusy=false,generatedTexture=null,modelAbort=null,originalMaterial=ribbon.material;
  const textureLoader=new THREE.TextureLoader();
  function placeProjector(){
    camera.copy(viewer);camera.aspect=1;
    // Keep the viewer's complete horizontal field when it is wider than square.
    camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(viewer.fov*.5))*Math.max(1,viewer.aspect)));
    camera.updateProjectionMatrix();camera.updateMatrixWorld();
    uniforms.projectorMatrix.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    const distance=viewer.position.length();
    depthMaterial.uniforms.nearDepth.value=Math.max(.1,distance-3.8);
    depthMaterial.uniforms.farDepth.value=distance+3.2;
  }
  placeProjector();
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
    finally{healthBusy=false;onStatus(state);}
  }
  async function capturePreview(){
    previewBusy=true;const epoch=generation,w=target.width,h=target.height;
    try{
      const data=new Uint8Array(w*h*4);
      await renderer.readRenderTargetPixelsAsync(target,0,0,w,h,data);
      if(disposed||!state.active||epoch!==generation)return;
      const topDown=new Uint8ClampedArray(data.length);
      for(let y=0;y<h;y++)topDown.set(data.subarray((h-1-y)*w*4,(h-y)*w*4),y*w*4);
      depthPreview.width=w;depthPreview.height=h;
      depthPreview.getContext('2d').putImageData(new ImageData(topDown,w,h),0,0);
    }finally{previewBusy=false;}
  }
  async function requestFrame(){
    state.busy=true;const epoch=generation,started=performance.now(),frameId=state.captures;
    const width=target.width,height=target.height,buffer=new Uint8Array(width*height*4);
    modelAbort=new AbortController();
    try{
      // Async pixel transfer avoids a synchronous GPU stall in the render loop.
      await renderer.readRenderTargetPixelsAsync(target,0,0,width,height,buffer);
      if(disposed||epoch!==generation)return;
      const flipped=new Uint8ClampedArray(buffer.length);
      for(let y=0;y<height;y++)flipped.set(buffer.subarray((height-1-y)*width*4,(height-y)*width*4),y*width*4);
      depthPreview.width=width;depthPreview.height=height;
      depthPreview.getContext('2d').putImageData(new ImageData(flipped,width,height),0,0);
      const depth=depthPreview.toDataURL('image/png');
      const response=await fetch(state.endpoint+'/generate',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({frame_id:frameId,depth,prompt:state.prompt,seed:state.seed,strength:state.strength}),
        signal:AbortSignal.any([modelAbort.signal,AbortSignal.timeout(180000)])});
      const result=await response.json();
      if(response.status===429){lastRequest=performance.now()+1000;return;}
      if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:`Generation failed (${response.status})`);
      if(disposed||epoch!==generation)return;
      if(result.frame_id!==frameId||!result.image?.startsWith('data:image/png;base64,'))throw new Error('Invalid model frame');
      const texture=await textureLoader.loadAsync(result.image);
      if(disposed||epoch!==generation){texture.dispose();return;}
      texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;
      generatedTexture?.dispose();generatedTexture=texture;
      if(state.mode==='generated')uniforms.projectionMap.value=texture;
      generatedPreview.src=result.image;
      const now=performance.now();state.generatedFps=lastResult?1000/(now-lastResult):1000/(now-started);
      lastResult=now;state.inferenceMs=result.inference_ms;state.latencyMs=now-started;
      state.generated++;state.error=null;
    }catch(error){if(error.name!=='AbortError'&&!disposed){state.error=error.message;state.running=false;}}
    finally{state.busy=false;modelAbort=null;if(!disposed)onStatus(state);}
  }
  return {state,camera,material,depthPreview,generatedPreview,target,
    setActive(active){
      if(active===state.active)return;
      state.active=active;
      if(active){originalMaterial=ribbon.material;ribbon.material=material;placeProjector();health();}
      else{ribbon.material=originalMaterial;state.running=false;generation++;modelAbort?.abort();}
    },
    setMode(mode){state.mode=mode;uniforms.projectionMap.value=mode==='grid'?pattern:(generatedTexture||pattern);onStatus(state);},
    placeProjector,health,
    run(){state.error=null;state.running=true;state.mode='generated';if(generatedTexture)uniforms.projectionMap.value=generatedTexture;health();onStatus(state);},
    stop(){state.running=false;onStatus(state);},
    setPower(value){uniforms.projectionPower.value=value;},
    update(){
      if(!state.active||disposed)return;
      if(state.follow)placeProjector();
      if(target.width!==state.resolution&&!state.busy)target.setSize(state.resolution,state.resolution);
      ribbon.updateMatrixWorld();mesh.matrix.copy(ribbon.matrixWorld);
      const previous=renderer.getRenderTarget(),clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
      renderer.setRenderTarget(target);renderer.setClearColor(0,0);renderer.clear();renderer.render(scene,camera);
      renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);
      state.captures++;state.frames++;const now=performance.now();state.ageMs=lastResult?now-lastResult:0;
      if(now>nextHealth){nextHealth=now+3000;health();}
      if(state.running&&state.ready&&!state.busy&&now-lastRequest>=1000/state.targetFps){lastRequest=now;requestFrame();}
      if(!state.busy&&!state.running&&!previewBusy&&state.frames%20===1)capturePreview().catch(()=>{});
      if(state.frames%20===0)onStatus(state);
    },
    dispose(){disposed=true;generation++;modelAbort?.abort();target.dispose();depthMaterial.dispose();material.dispose();pattern.dispose();generatedTexture?.dispose();},
  };
}
