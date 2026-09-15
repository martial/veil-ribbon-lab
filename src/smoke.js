import * as THREE from 'three';
import {loadLocalSample} from './image-input.js';
import fluidCode from './fluid.wgsl?raw';
import volumeCode from './volume.wgsl?raw';

const GRID=[80,120,64],CELL=.048;
const LOWER=[-1.92,-2.6,-1.536],UPPER=[1.92,3.16,1.536];
const BYTES_PER_ROW=Math.ceil(GRID[0]*8/256)*256;
const BYTE_SIZE=BYTES_PER_ROW*GRID[1]*GRID[2];
const layouts={
  clear:[6],initialize:[0,6,7],advectVelocity:[0,1,5,6],curl:[1,6],
  forces:[0,1,2,3,6],divergence:[1,6],pressure:[2,3,6],project:[1,3,6],
  advectDensity:[0,1,2,5,6],correctDensity:[0,1,2,3,5,6],
};

export async function createSculptureSmoke(viewport,camera,onError=console.error) {
  if(!navigator.gpu)throw new Error('The fluid study needs WebGPU. Open it in a browser with WebGPU enabled.');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)throw new Error('No WebGPU adapter is available for the fluid simulation.');
  const device=await adapter.requestDevice();
  let disposed=false,failure=null;
  device.addEventListener('uncapturederror',event=>{
    failure=event.error.message;console.error('Fluid GPU:',failure);onError(failure);
  });
  device.lost.then(info=>{if(!disposed){failure=info.message||'The fluid GPU device was lost.';onError(failure);}});
  const canvas=document.createElement('canvas');canvas.className='fluid-canvas';canvas.hidden=true;
  canvas.setAttribute('aria-label','A photograph projected through turbulent smoke, with depth and visible light pixels');viewport.appendChild(canvas);
  const context=canvas.getContext('webgpu');
  const format=navigator.gpu.getPreferredCanvasFormat();
  context.configure({device,format,alphaMode:'premultiplied'});
  const textures=[];
  function texture(label){
    const t=device.createTexture({label,size:GRID,dimension:'3d',format:'rgba16float',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
    textures.push(t);return t;
  }
  const velocity=[texture('Current velocity'),texture('Advected velocity'),texture('Velocity with forces')];
  const density=[texture('Smoke density'),texture('Forward density'),texture('Corrected density')];
  const pressure=[texture('Pressure A'),texture('Pressure B')];
  const curl=texture('Vorticity'),divergence=texture('Divergence');
  const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',addressModeW:'clamp-to-edge'});
  const uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const viewUniform=device.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const fluidModule=device.createShaderModule({label:'3D stable-fluid solver',code:fluidCode});
  const volumeModule=device.createShaderModule({label:'Smoke volume ray marcher',code:volumeCode});
  for(const module of [fluidModule,volumeModule]){
    const info=await module.getCompilationInfo();
    const errors=info.messages.filter(m=>m.type==='error');
    if(errors.length){device.destroy();canvas.remove();throw new Error(errors.map(e=>`${e.lineNum}: ${e.message}`).join('\n'));}
  }
  const pipelines={};
  await Promise.all(Object.keys(layouts).map(async entry=>{
    pipelines[entry]=await device.createComputePipelineAsync({label:entry,layout:'auto',compute:{module:fluidModule,entryPoint:entry}});
  }));
  const volumePipeline=await device.createRenderPipelineAsync({label:'Volumetric smoke',layout:'auto',
    vertex:{module:volumeModule,entryPoint:'vertex'},fragment:{module:volumeModule,entryPoint:'fragment',targets:[{format}]},
    primitive:{topology:'triangle-list'}});
  const [image,depth,mask]=await Promise.all([
    loadLocalSample(`${import.meta.env.BASE_URL}samples/sculpture-source.png`),loadLocalSample(`${import.meta.env.BASE_URL}samples/source-depth.png`),loadLocalSample(`${import.meta.env.BASE_URL}samples/source-mask.png`),
  ]);
  const iw=768,ih=1152;
  function pixels(image){const c=document.createElement('canvas');c.width=iw;c.height=ih;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(image,0,0,iw,ih);return g.getImageData(0,0,iw,ih).data;}
  const color=pixels(image),relief=pixels(depth),silhouette=pixels(mask);
  // The photograph is fixed projected light, separate from the moving fluid.
  function imageTexture(label,data,format){
    const t=device.createTexture({label,size:[iw,ih],format,
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture:t},data,{bytesPerRow:iw*4},[iw,ih]);textures.push(t);return t;
  }
  for(let i=0;i<color.length;i+=4)color[i+3]=silhouette[i];
  const projectedImage=imageTexture('Projector photograph (sRGB)',color,'rgba8unorm-srgb');
  const projectedDepth=imageTexture('Projector relative depth (linear)',relief,'rgba8unorm');
  const group=new THREE.Group();group.name='3D fluid volume';group.visible=false;
  const params={density:.75,vorticity:4.0,depth:1,dispersion:.3,emission:1.0,projector:5,pixels:128,thickness:.07,spill:.025,enabled:true};
  const simData=new Float32Array(8),viewData=new Float32Array(40);
  const inverse=new THREE.Matrix4();
  let needsReset=true,time=0,steps=0,current=0;
  const bindCache=new Map();
  let nextTextureId=0;const textureIds=new WeakMap();
  for(const t of textures)textureIds.set(t,nextTextureId++);
  const resources={0:{buffer:uniform},5:sampler};
  function dispatch(encoder,entry,inputs){
    const key=entry+Object.entries(inputs).map(([k,v])=>`${k}:${textureIds.get(v)}`).join(',');
    let bind=bindCache.get(key);
    if(!bind){
      const entries=layouts[entry].map(binding=>({binding,resource:inputs[binding]?inputs[binding].createView():resources[binding]}));
      bind=device.createBindGroup({layout:pipelines[entry].getBindGroupLayout(0),entries});bindCache.set(key,bind);
    }
    const pass=encoder.beginComputePass({label:entry});pass.setPipeline(pipelines[entry]);pass.setBindGroup(0,bind);
    pass.dispatchWorkgroups(GRID[0]/4,GRID[1]/4,GRID[2]/4);pass.end();
  }
  const volumeBinds=density.map(t=>device.createBindGroup({layout:volumePipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:{buffer:viewUniform}},{binding:1,resource:t.createView()},{binding:2,resource:sampler},
    {binding:3,resource:projectedImage.createView()},{binding:4,resource:projectedDepth.createView()},
  ]}));
  function simulate(encoder,dt,wind,turbulence){
    simData.set([dt,time,wind,turbulence,params.vorticity,params.emission,params.dispersion,params.depth]);
    device.queue.writeBuffer(uniform,0,simData);
    if(needsReset){
      dispatch(encoder,'initialize',{6:velocity[0],7:density[current]});
      dispatch(encoder,'clear',{6:pressure[0]});dispatch(encoder,'clear',{6:pressure[1]});
      needsReset=false;
    }
    if(dt<=0)return;
    dispatch(encoder,'advectVelocity',{1:velocity[0],6:velocity[1]});
    dispatch(encoder,'curl',{1:velocity[1],6:curl});
    dispatch(encoder,'forces',{1:velocity[1],2:density[current],3:curl,6:velocity[2]});
    dispatch(encoder,'divergence',{1:velocity[2],6:divergence});
    for(let i=0;i<24;i++)dispatch(encoder,'pressure',{2:divergence,3:pressure[i%2],6:pressure[1-i%2]});
    dispatch(encoder,'project',{1:velocity[2],3:pressure[0],6:velocity[0]});
    dispatch(encoder,'advectDensity',{1:velocity[0],2:density[current],6:density[1]});
    const next=current===0?2:0;
    dispatch(encoder,'correctDensity',{1:velocity[0],2:density[current],3:density[1],6:density[next]});
    current=next;steps++;
  }
  function render(encoder,dpr,light){
    const width=Math.max(1,Math.round(viewport.clientWidth*Math.min(dpr,1.25)*.65));
    const height=Math.max(1,Math.round(viewport.clientHeight*Math.min(dpr,1.25)*.65));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    camera.updateMatrixWorld();inverse.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).invert();
    viewData.set(inverse.elements,0);viewData.set([...camera.position.toArray(),time],16);
    viewData.set([...LOWER,0],20);viewData.set([...UPPER,0],24);viewData.set([params.density,light,params.enabled?params.projector:0,params.depth],28);
    viewData.set([params.pixels,params.thickness,params.spill,0],32);
    viewData.set([0,-.3,-16,16],36);
    device.queue.writeBuffer(viewUniform,0,viewData);
    const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(volumePipeline);pass.setBindGroup(0,volumeBinds[current]);pass.draw(3);pass.end();
  }
  return {
    group,params,canvas,count:GRID.reduce((a,b)=>a*b),backend:'WebGPU',
    get time(){return time;},get steps(){return steps;},get error(){return failure;},
    setVisible(visible){group.visible=visible;canvas.hidden=!visible;},
    update(delta,{wind,turbulence,dpr=1,light=1}){
      if(disposed||failure)return;
      const dt=Math.min(Math.max(0,delta),1/30);time+=dt;
      const encoder=device.createCommandEncoder({label:'Fluid frame'});
      simulate(encoder,dt,wind,turbulence);render(encoder,dpr,light);device.queue.submit([encoder.finish()]);
    },
    reset(){time=0;steps=0;needsReset=true;},
    async diagnostics(){
      const encoder=device.createCommandEncoder();
      const buffers=[0,1,2].map(()=>device.createBuffer({size:BYTE_SIZE,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
      for(let i=0;i<2;i++){
        dispatch(encoder,'divergence',{1:velocity[i===0?2:0],6:divergence});
        encoder.copyTextureToBuffer({texture:divergence},{buffer:buffers[i],bytesPerRow:BYTES_PER_ROW,rowsPerImage:GRID[1]},GRID);
      }
      encoder.copyTextureToBuffer({texture:density[current]},{buffer:buffers[2],bytesPerRow:BYTES_PER_ROW,rowsPerImage:GRID[1]},GRID);
      device.queue.submit([encoder.finish()]);await Promise.all(buffers.map(b=>b.mapAsync(GPUMapMode.READ)));
      const rms=buffers.slice(0,2).map(buffer=>{
        const data=new Uint16Array(buffer.getMappedRange());let squared=0,count=0,finite=true;
        for(let z=3;z<GRID[2]-3;z++)for(let y=3;y<GRID[1]-3;y++)for(let x=3;x<GRID[0]-3;x++){
          const value=THREE.DataUtils.fromHalfFloat(data[(z*GRID[1]+y)*BYTES_PER_ROW/2+x*4]);
          finite&&=Number.isFinite(value);squared+=value*value;count++;
        }
        buffer.unmap();buffer.destroy();return {rms:Math.sqrt(squared/count),finite};
      });
      const data=new Uint16Array(buffers[2].getMappedRange());let mass=0,finite=true,max=0;const center=[0,0,0];
      for(let z=0;z<GRID[2];z++)for(let y=0;y<GRID[1];y++)for(let x=0;x<GRID[0];x++){
        const d=THREE.DataUtils.fromHalfFloat(data[(z*GRID[1]+y)*BYTES_PER_ROW/2+x*4]);
        finite&&=Number.isFinite(d);mass+=d;max=Math.max(max,d);
        center[0]+=d*(LOWER[0]+(x+.5)*CELL);center[1]+=d*(LOWER[1]+(y+.5)*CELL);center[2]+=d*(LOWER[2]+(z+.5)*CELL);
      }
      buffers[2].unmap();buffers[2].destroy();
      return {grid:GRID,steps,beforeProjection:rms[0],afterProjection:rms[1],reduction:1-rms[1].rms/Math.max(rms[0].rms,1e-9),density:{mass:mass*CELL**3,max,finite,center:center.map(v=>v/Math.max(mass,1e-9))},error:failure};
    },
    flush(){return device.queue.onSubmittedWorkDone();},
    dispose(){disposed=true;textures.forEach(t=>t.destroy());uniform.destroy();viewUniform.destroy();device.destroy();canvas.remove();},
  };
}
