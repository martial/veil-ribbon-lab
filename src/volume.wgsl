struct View {
  inverse:mat4x4f,
  camera:vec4f,
  lower:vec4f,
  upper:vec4f,
  settings:vec4f,
  optics:vec4f, // horizontal pixels, layer thickness, light spill
  projector:vec4f, // fixed rear projector position + focal distance
}
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var density:texture_3d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
@group(0) @binding(3) var photograph:texture_2d<f32>;
@group(0) @binding(4) var depthMap:texture_2d<f32>;
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
fn projectedUV(p:vec3f)->vec2f{
  let relative=p-view.projector.xyz;
  return vec2f(.5)+relative.xy*vec2f(1./2.65,-1./4.)*view.projector.w/relative.z;
}
// Finite pixel apertures form columns of light, not points or a textured mesh.
fn projectorLight(p:vec3f)->vec3f{
  let uv=projectedUV(p);
  if(any(uv<vec2f(0))||any(uv>vec2f(1))){return vec3f(0);}
  let resolution=vec2f(view.optics.x,view.optics.x*1.5);
  let pixelUV=(floor(uv*resolution+.37)+.5-.37)/resolution;
  let image=textureSampleLevel(photograph,linearSampler,pixelUV,0);
  let depth=textureSampleLevel(depthMap,linearSampler,pixelUV,0).r;
  let surfaceDepth=(depth-.45)*1.8*view.settings.w;
  let layer=exp(-.5*pow((p.z-surfaceDepth)/view.optics.y,2.));
  let edge=abs(fract(uv*resolution+.37)-.5);
  let aperture=(1.-smoothstep(.43,.5,edge.x))*(1.-smoothstep(.43,.5,edge.y));
  // Depth selection approximates a shaped / multiplexed mist display. A
  // normal projector cannot gate depth in arbitrary smoke. The spill term
  // retains projected light along the rest of each ray.
  let receiver=view.optics.z+layer*(.18/view.optics.y);
  return image.rgb*image.a*aperture*receiver;
}
@fragment fn fragment(input:Vertex)->@location(0) vec4f{
  let far=view.inverse*vec4f(input.uv,1,1);
  let origin=view.camera.xyz;let ray=normalize(far.xyz/far.w-origin);
  let t0=(view.lower.xyz-origin)/ray;let t1=(view.upper.xyz-origin)/ray;
  let mins=min(t0,t1);let maxs=max(t0,t1);
  let near=max(0.,max(mins.x,max(mins.y,mins.z)));
  let end=min(maxs.x,min(maxs.y,maxs.z));
  if(end<=near){return vec4f(0);}
  let step=.031;
  var t=near+random(input.position.xy)*step;
  var transmittance=1.;var color=vec3f(0.);
  let extinction=view.settings.x*1.35;
  for(var i=0;i<224;i++){
    if(t>end||transmittance<.012){break;}
    let p=origin+ray*t;let d=field(p);
    if(d.x>.012){
      let light=projectorLight(p);
      let toLight=normalize(view.projector.xyz-p);
      var shadow=0.;
      let lightDistance=(view.lower.z-p.z)/toLight.z;
      for(var j=0;j<4;j++){
        shadow+=field(p+toLight*(f32(j)+.5)*lightDistance/4.).x*lightDistance/4.;
      }
      let attenuation=exp(-shadow*extinction*.55);
      // Forward-peaked phase approximation, not a calibrated Mie solution.
      let cosine=dot(-toLight,-ray);let g=.48;
      let phase=(1.-g*g)/pow(1.+g*g-2.*g*cosine,1.5);
      let scattering=vec3f(.009,.013,.02)*view.settings.y+light*view.settings.z*attenuation*(.18+.22*phase);
      let alpha=1.-exp(-d.x*extinction*step);
      color+=transmittance*alpha*scattering;
      transmittance*=1.-alpha;
    }
    t+=step;
  }
  let alpha=1.-transmittance;
  // Premultiplied output for the transparent WebGPU canvas over the studio.
  var straight=color/max(alpha,.0001);
  straight=vec3f(1.)-exp(-straight*1.7);
  straight=pow(straight,vec3f(1./2.2));
  return vec4f(straight*alpha,alpha);
}
