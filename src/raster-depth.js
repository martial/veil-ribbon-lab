// CPU camera-depth capture of the same indexed triangles rendered by WebGL.
// Avoids a GPU readback stall; perspective correction and a z-buffer preserve
// metric depth and the nearest visible fold. Output uses a top-left origin.
const buffers=new WeakMap();
export function rasterDepth(geometry, matrix, size, nearDepth, farDepth) {
  const positions=geometry.attributes.position.array,indices=geometry.index.array,m=matrix.elements;
  let buffer=buffers.get(geometry);
  if(!buffer||buffer.size!==size){
    buffer={size,clip:new Float64Array(positions.length/3*4),screen:new Float64Array(positions.length/3*4),
      pixels:new Uint8ClampedArray(size*size*4),depth:new Float64Array(size*size)};
    buffers.set(geometry,buffer);
  }
  const {clip,pixels,depth,screen}=buffer;depth.fill(Infinity);pixels.fill(0);
  for(let i=0,j=0;i<positions.length;i+=3,j+=4){
    const x=positions[i],y=positions[i+1],z=positions[i+2];
    clip[j]=m[0]*x+m[4]*y+m[8]*z+m[12];
    clip[j+1]=m[1]*x+m[5]*y+m[9]*z+m[13];
    clip[j+2]=m[2]*x+m[6]*y+m[10]*z+m[14];
    clip[j+3]=m[3]*x+m[7]*y+m[11]*z+m[15];
    const reciprocal=1/clip[j+3];
    screen[j]=(clip[j]*reciprocal*.5+.5)*size;
    screen[j+1]=(.5-clip[j+1]*reciprocal*.5)*size;
    screen[j+2]=clip[j+2]*reciprocal;screen[j+3]=reciprocal;
  }
  for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
  function draw(a,b,c,coordinates=screen){
    const ax=coordinates[a],ay=coordinates[a+1],az=coordinates[a+2],aw=coordinates[a+3];
    const bx=coordinates[b],by=coordinates[b+1],bz=coordinates[b+2],bw=coordinates[b+3];
    const cx=coordinates[c],cy=coordinates[c+1],cz=coordinates[c+2],cw=coordinates[c+3];
    const area=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy);
    if(Math.abs(area)<1e-10)return;
    const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),x1=Math.min(size-1,Math.floor(Math.max(ax,bx,cx)-.5));
    const y0=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5)),y1=Math.min(size-1,Math.floor(Math.max(ay,by,cy)-.5));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const px=x+.5,py=y+.5;
      const u=((by-cy)*(px-cx)+(cx-bx)*(py-cy))/area;
      const v=((cy-ay)*(px-cx)+(ax-cx)*(py-cy))/area,w=1-u-v;
      if(u<0||v<0||w<0)continue;
      const z=u*az+v*bz+w*cz,k=y*size+x;
      if(z>=depth[k])continue;
      depth[k]=z;
      const metric=1/(u*aw+v*bw+w*cw);
      const shade=Math.round(255*(.08+.92*(1-Math.max(0,Math.min(1,(metric-nearDepth)/(farDepth-nearDepth))))));
      pixels[k*4]=pixels[k*4+1]=pixels[k*4+2]=shade;
    }
  }
  // Homogeneous clipping keeps depth valid when orbiting close to a fold.
  function clipPlane(poly,sign){
    const out=[];
    for(let i=0;i<poly.length;i++){
      const a=poly[i],b=poly[(i+1)%poly.length],da=a[3]+sign*a[2],db=b[3]+sign*b[2];
      if(da>=0)out.push(a);
      if((da>=0)!==(db>=0)){
        const t=da/(da-db);out.push(a.map((value,k)=>value+t*(b[k]-value)));
      }
    }
    return out;
  }
  const outside=k=>clip[k+2]<-clip[k+3]||clip[k+2]>clip[k+3];
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i]*4,b=indices[i+1]*4,c=indices[i+2]*4;
    if(!outside(a)&&!outside(b)&&!outside(c)){draw(a,b,c);continue;}
    const triangle=[clip.subarray(a,a+4),clip.subarray(b,b+4),clip.subarray(c,c+4)];
    const poly=clipPlane(clipPlane(triangle,1),-1);
    const coordinates=new Float64Array(poly.length*4);
    for(let j=0;j<poly.length;j++){
      const v=poly[j];coordinates[j*4]=(v[0]/v[3]*.5+.5)*size;coordinates[j*4+1]=(.5-v[1]/v[3]*.5)*size;
      coordinates[j*4+2]=v[2]/v[3];coordinates[j*4+3]=1/v[3];
    }
    for(let j=1;j<poly.length-1;j++)draw(0,j*4,(j+1)*4,coordinates);
  }
  return pixels;
}
