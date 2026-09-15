struct View {
  inverse:mat4x4f,
  camera:vec4f,
  lower:vec4f,
  upper:vec4f,
  settings:vec4f,
}
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var density:texture_3d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
struct Vertex {@builtin(position) position:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) id:u32)->Vertex{
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var result:Vertex;result.position=vec4f(p[id],0,1);result.uv=p[id];return result;
}
fn field(p:vec3f)->vec4f{
  let uv=(p-view.lower.xyz)/(view.upper.xyz-view.lower.xyz);
  if(any(uv<vec3f(0))||any(uv>vec3f(1))){return vec4f(0);}
  return textureSampleLevel(density,linearSampler,uv,0);
}
fn random(p:vec2f)->f32{return fract(sin(dot(p,vec2f(12.9898,78.233)))*43758.5453);}
@fragment fn fragment(input:Vertex)->@location(0) vec4f{
  let far=view.inverse*vec4f(input.uv,1,1);
  let origin=view.camera.xyz;let ray=normalize(far.xyz/far.w-origin);
  let t0=(view.lower.xyz-origin)/ray;let t1=(view.upper.xyz-origin)/ray;
  let mins=min(t0,t1);let maxs=max(t0,t1);
  let near=max(0.,max(mins.x,max(mins.y,mins.z)));
  let end=min(maxs.x,min(maxs.y,maxs.z));
  if(end<=near){return vec4f(0);}
  let step=.039;
  var t=near+random(input.position.xy)*step;
  var transmittance=1.;var color=vec3f(0.);
  let lightDirection=normalize(vec3f(-.8,.65,-.5));
  let extinction=view.settings.x*3.;
  for(var i=0;i<180;i++){
    if(t>end||transmittance<.012){break;}
    let p=origin+ray*t;let d=field(p);
    if(d.x>.012){
      var shadow=0.;var distance=.08;
      for(var j=0;j<6;j++){
        shadow+=field(p+lightDirection*distance).x*.15;
        distance+=.15;
      }
      let attenuation=exp(-shadow*extinction*1.4);
      let scattering=vec3f(.035,.055,.075)+vec3f(1.25,1.10,.88)*attenuation*view.settings.y;
      let characteristic=clamp(d.z/max(d.x,.001),0.,1.);
      let albedo=mix(vec3f(.69,.76,.80),vec3f(.92,.89,.81),characteristic);
      let alpha=1.-exp(-d.x*extinction*step);
      color+=transmittance*alpha*scattering*albedo;
      transmittance*=1.-alpha;
    }
    t+=step;
  }
  let alpha=1.-transmittance;
  // Premultiplied output for the transparent WebGPU canvas over the studio.
  var straight=color/max(alpha,.0001);
  straight=straight/(straight+vec3f(.55));
  straight=pow(straight,vec3f(1./2.2));
  return vec4f(straight*alpha,alpha);
}
