struct Sim { step:vec4f, settings:vec4f }
@group(0) @binding(0) var<uniform> sim:Sim;
@group(0) @binding(1) var velocity:texture_3d<f32>;
@group(0) @binding(2) var field:texture_3d<f32>;
@group(0) @binding(3) var aux:texture_3d<f32>;
@group(0) @binding(4) var source:texture_3d<f32>;
@group(0) @binding(5) var linearSampler:sampler;
@group(0) @binding(6) var output:texture_storage_3d<rgba16float,write>;
@group(0) @binding(7) var outputDensity:texture_storage_3d<rgba16float,write>;
const DIM=vec3i(80,120,64);
const H=.048;
const SIZE=vec3f(3.84,5.76,3.072);
const MIN=vec3f(-1.92,-2.6,-1.536);
@compute @workgroup_size(4,4,4)
fn clear(@builtin(global_invocation_id) p:vec3u){
  if(all(p<vec3u(DIM))){textureStore(output,vec3i(p),vec4f(0));}
}
fn valid(p:vec3u)->bool{return all(p<vec3u(DIM));}
fn safe(p:vec3i)->vec3i{return clamp(p,vec3i(0),DIM-1);}
fn vel(p:vec3i)->vec3f{return textureLoad(velocity,safe(p),0).xyz;}
fn scalar(p:vec3i)->f32{return textureLoad(aux,safe(p),0).x;}
fn curlAt(p:vec3i)->vec4f{return textureLoad(aux,safe(p),0);}
fn uv(p:vec3u)->vec3f{return (vec3f(p)+.5)/vec3f(DIM);}
fn sourceAt(p:vec3u)->vec4f{
  var coord=uv(p);coord.z=(coord.z-.5)/max(.12,sim.settings.w)+.5;
  if(any(coord<vec3f(0))||any(coord>vec3f(1))){return vec4f(0);}
  return textureSampleLevel(source,linearSampler,coord,0);
}
fn boundary(p:vec3u)->f32{
  let d=min(vec3f(p),vec3f(DIM-1-vec3i(p)));
  return smoothstep(0.,3.,min(d.x,min(d.y,d.z)));
}

@compute @workgroup_size(4,4,4)
fn initialize(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}
  let s=sourceAt(p);
  let world=MIN+uv(p)*SIZE;
  let seed=vec3f(sin(world.y*6.+world.z*3.),sin(world.z*4.+world.x*6.),cos(world.x*6.+world.y*4.));
  textureStore(output,vec3i(p),vec4f(seed*sim.step.w*.12,0));
  textureStore(outputDensity,vec3i(p),vec4f(s.x*1.1,s.x*.7,s.z*s.x*1.1,0));
}

@compute @workgroup_size(4,4,4)
fn advectVelocity(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}
  let coord=uv(p);let dt=sim.step.x;
  let v=textureLoad(velocity,vec3i(p),0).xyz;
  let mid=textureSampleLevel(velocity,linearSampler,coord-v*dt*.5/SIZE,0).xyz;
  let value=textureSampleLevel(velocity,linearSampler,coord-mid*dt/SIZE,0).xyz;
  textureStore(output,vec3i(p),vec4f(value*exp(-dt*.035),0));
}

@compute @workgroup_size(4,4,4)
fn curl(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}let q=vec3i(p);
  let x=(vel(q+vec3i(1,0,0))-vel(q-vec3i(1,0,0)))/(2.*H);
  let y=(vel(q+vec3i(0,1,0))-vel(q-vec3i(0,1,0)))/(2.*H);
  let z=(vel(q+vec3i(0,0,1))-vel(q-vec3i(0,0,1)))/(2.*H);
  let omega=vec3f(y.z-z.y,z.x-x.z,x.y-y.x);
  textureStore(output,q,vec4f(omega,length(omega)));
}

@compute @workgroup_size(4,4,4)
fn forces(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}let q=vec3i(p);let dt=sim.step.x;
  var v=vel(q);let d=textureLoad(field,q,0);
  let grad=vec3f(curlAt(q+vec3i(1,0,0)).w-curlAt(q-vec3i(1,0,0)).w,
                curlAt(q+vec3i(0,1,0)).w-curlAt(q-vec3i(0,1,0)).w,
                curlAt(q+vec3i(0,0,1)).w-curlAt(q-vec3i(0,0,1)).w);
  let n=grad/max(length(grad),.0001);
  let confinement=cross(n,curlAt(q).xyz)*sim.settings.x*H;
  let world=MIN+uv(p)*SIZE;
  let t=sim.step.y;let strength=sim.step.z;
  let ambient=vec3f(.42,.28,.035)*strength;
  let gust=vec3f(sin(t*1.3+world.y*5.1+world.z*3.7),cos(t*.8+world.z*4.7+world.x*3.1),sin(t*1.1+world.x*5.4+world.y*3.9));
  // Buoyancy uses advected heat and density. Confinement restores rotational
  // energy lost to a finite grid, following the stable-fluids method.
  let buoyancy=vec3f(0.,d.y*1.45-d.x*.08,0.);
  v+=(buoyancy+confinement+(ambient-v)*.16+gust*sim.step.w*.28)*dt;
  if(p.y<2u){v.y=max(0.,v.y);}
  let speed=length(v);v*=min(1.,5./max(speed,.001));
  textureStore(output,q,vec4f(v,0));
}

@compute @workgroup_size(4,4,4)
fn divergence(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}let q=vec3i(p);
  let center=vel(q);
  let div=(center.x-vel(q-vec3i(1,0,0)).x+
           center.y-vel(q-vec3i(0,1,0)).y+
           center.z-vel(q-vec3i(0,0,1)).z)/H;
  textureStore(output,q,vec4f(div,0,0,0));
}

@compute @workgroup_size(4,4,4)
fn pressure(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}let q=vec3i(p);
  if(any(q<vec3i(1))||any(q>=DIM-1)){textureStore(output,q,vec4f(0));return;}
  let neighbors=scalar(q+vec3i(1,0,0))+scalar(q-vec3i(1,0,0))+
                scalar(q+vec3i(0,1,0))+scalar(q-vec3i(0,1,0))+
                scalar(q+vec3i(0,0,1))+scalar(q-vec3i(0,0,1));
  let result=(neighbors-textureLoad(field,q,0).x*H*H)/6.;
  textureStore(output,q,vec4f(result,0,0,0));
}

@compute @workgroup_size(4,4,4)
fn project(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}let q=vec3i(p);
  // Matching forward gradient and backward divergence give the exact
  // seven-point Laplacian solved in the pressure pass.
  let center=scalar(q);
  let grad=vec3f(scalar(q+vec3i(1,0,0))-center,
                scalar(q+vec3i(0,1,0))-center,
                scalar(q+vec3i(0,0,1))-center)/H;
  var v=vel(q)-grad;
  if(p.y<2u){v.y=max(0.,v.y);}
  textureStore(output,q,vec4f(v,0));
}

@compute @workgroup_size(4,4,4)
fn advectDensity(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}
  let coord=uv(p);let v=textureLoad(velocity,vec3i(p),0).xyz;
  let mid=textureSampleLevel(velocity,linearSampler,coord-v*sim.step.x*.5/SIZE,0).xyz;
  let value=textureSampleLevel(field,linearSampler,coord-mid*sim.step.x/SIZE,0);
  textureStore(output,vec3i(p),value);
}

@compute @workgroup_size(4,4,4)
fn correctDensity(@builtin(global_invocation_id) p:vec3u){
  if(!valid(p)){return;}let q=vec3i(p);let coord=uv(p);let dt=sim.step.x;
  let v=textureLoad(velocity,q,0).xyz;
  let back=textureSampleLevel(aux,linearSampler,coord+v*dt/SIZE,0);
  let original=textureLoad(field,q,0);
  var corrected=textureLoad(aux,q,0)+.5*(original-back);
  // MacCormack correction with a local extrema limiter prevents overshoot.
  let previous=vec3i(floor((coord-v*dt/SIZE)*vec3f(DIM)-.5));
  var lo=vec4f(1e10);var hi=vec4f(-1e10);
  for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
    let sample=textureLoad(field,safe(previous+vec3i(x,y,z)),0);
    lo=min(lo,sample);hi=max(hi,sample);
  }}}
  corrected=clamp(corrected,lo,hi);
  corrected.x*=exp(-dt*(.055+sim.settings.z*.32));
  corrected.y*=exp(-dt*.32);corrected.z*=exp(-dt*(.055+sim.settings.z*.32));
  let s=sourceAt(p);
  // A weak continuing emission makes the statue legible while released smoke
  // is free to advect. No velocity is pulled toward the source's shape.
  let emitted=s.x*sim.settings.y*dt;
  corrected+=vec4f(emitted,emitted*.8,emitted*s.z,0);
  corrected*=mix(.84,1.,boundary(p));
  textureStore(output,q,clamp(corrected,vec4f(0),vec4f(4)));
}
