/**
 * A clamped rectangular sheet. XPBD edge and signed-dihedral constraints act
 * only between material points: there is no attraction to world-space poses.
 * Air is a prescribed, advected velocity field, not a coupled fluid solver.
 */
export class RibbonCloth {
  constructor(columns = 56, rows = 24) {
    this.columns = columns; this.rows = rows;
    this.count = (columns + 1) * (rows + 1);
    this.length = 4.8; this.width = 1.9;
    this.positions = new Float32Array(this.count * 3);
    this.previous = new Float32Array(this.count * 3);
    this.rest = new Float32Array(this.count * 3);
    this.base = new Float32Array(this.count * 3);
    this.normals = new Float32Array(this.count * 3);
    this.inverseMass = new Float32Array(this.count);
    this.tethers = new Float32Array(this.count);
    this.tetherAnchors = new Uint32Array(this.count);
    this.params = { wind: .85, turbulence: .3, memory: .65, relief: 1, gravity: -9.81 };
    this.time = 0; this.depth = null; this.gust = 0;
    const stride = columns + 1;
    for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
      const i = y * stride + x, u = x / columns, v = y / rows;
      // The sheet begins resting on the floor, with a small central part of
      // its short edge gripped. The broad end and both side edges are free.
      this.base.set([-1.8 + (v-.5)*this.width, -2.575, -.04-u*this.length],i*3);
      this.inverseMass[i] = x===0 && Math.abs(v-.5)<=.056 ? 0 : 1;
    }
    const triangles = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
      // Alternating diagonals avoid a preferred fold direction.
      if ((x+y)%2) triangles.push(a,b,c,b,d,c);
      else triangles.push(a,b,d,a,d,c);
    }
    this.triangles = new Uint32Array(triangles);
    const edgeMap = new Map(), edges = [], bends = [];
    for (let k = 0; k < triangles.length; k += 3) for (let j = 0; j < 3; j++) {
      const a = triangles[k+j], b = triangles[k+(j+1)%3], c = triangles[k+(j+2)%3];
      const key = Math.min(a,b) * this.count + Math.max(a,b);
      const other = edgeMap.get(key);
      if (other) bends.push(other[0],other[1],other[2],c);
      else { edgeMap.set(key,[a,b,c]); edges.push(a,b); }
    }
    // The other diagonal controls shear independently of the render triangles.
    for(let y=0;y<rows;y++) for(let x=0;x<columns;x++) {
      const a=y*stride+x,b=a+1,c=a+stride,d=c+1;
      if((x+y)%2) edges.push(a,d);else edges.push(b,c);
    }
    this.edges = new Uint32Array(edges);
    this.edgeRest = new Float32Array(edges.length/2);
    this.edgeLambda = new Float32Array(edges.length/2);
    this.bends = new Uint32Array(bends);
    this.bendRest = new Float32Array(bends.length/4);
    this.bendLambda = new Float32Array(bends.length/4);
    this.bendWeight = new Float32Array(bends.length/4);
    this.gradient = new Float64Array(12);
    this.rebuildRest();
  }

  setDepth(values) {
    if (values !== null && (values.length !== this.count || !values.every(Number.isFinite))) {
      throw new Error(`Depth map must contain ${this.count} finite samples.`);
    }
    this.depth = values ? Float32Array.from(values, v => Math.max(0, Math.min(1, v))) : null;
    this.rebuildRest();
  }

  setWidth(width) {
    if (!Number.isFinite(width) || width < .5 || width > 6) throw new Error('Ribbon width must be between 0.5 and 6.');
    if (width === this.width) return;
    this.width = width;
    for (let y = 0; y <= this.rows; y++) for (let x = 0; x <= this.columns; x++) {
      this.base[(y * (this.columns + 1) + x) * 3] = -1.8 + (y / this.rows - .5) * width;
    }
    // Resize the material itself, including its stretch, bend and tether rest
    // lengths. Scaling the rendered mesh alone would distort the simulation.
    this.rebuildRest();
  }

  rebuildRest() {
    this.rest.set(this.base);
    if (this.depth) for (let i = 0; i < this.count; i++) {
      // Flatten the first centimetres where the floor clamp grips the sheet.
      const u = (i % (this.columns+1)) / this.columns;
      this.rest[i*3+1] += this.depth[i] * .48 * this.params.relief * Math.min(1,u*12);
    }
    for (let j = 0; j < this.edgeRest.length; j++) {
      this.edgeRest[j] = distance(this.rest,this.edges[j*2]*3,this.edges[j*2+1]*3);
    }
    for (let j = 0; j < this.bendRest.length; j++) {
      this.bendRest[j] = dihedral(this.rest,this.bends,j*4);
      let weight = 0;
      for (let k = 0; k < 4; k++) weight += this.depth?.[this.bends[j*4+k]] || 0;
      this.bendWeight[j] = Math.min(1,weight);
    }
    const pins=[];
    for(let i=0;i<this.count;i++) if(!this.inverseMass[i]) pins.push(i);
    for(let i=0;i<this.count;i++) {
      const x=i%(this.columns+1),y=Math.floor(i/(this.columns+1));
      let nearest=Infinity,anchor=pins[0];
      for(const pin of pins) {
        const dy=(y-Math.floor(pin/(this.columns+1)))*this.width/this.rows;
        const length=Math.hypot(x*this.length/this.columns,dy);
        if(length<nearest){nearest=length;anchor=pin;}
      }
      this.tetherAnchors[i]=anchor;
      // A conservative path along the sculpted row allows the extra material
      // area introduced by relief, without tying it to a world-space pose.
      let length=0;
      if(this.depth) for(let j=0;j<x;j++) length+=distance(this.rest,(y*(this.columns+1)+j)*3,(y*(this.columns+1)+j+1)*3);
      this.tethers[i]=nearest+Math.max(0,length-x*this.length/this.columns);
    }
    this.reset();
  }

  reset() {
    this.positions.set(this.rest);
    // Small initial imperfection breaks the symmetry of a perfectly flat sheet.
    // It is an initial condition only, never an animated displacement.
    if (!this.depth) for (let i = 0; i < this.count; i++) {
      const u = i%(this.columns+1)/this.columns, v = Math.floor(i/(this.columns+1))/this.rows;
      this.positions[i*3+1] += .008*u*(1+Math.sin(v*9+u*4));
    }
    this.previous.set(this.positions);
    this.time = 0; this.gust = 0;
  }

  step(dt = 1/120) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1/30) throw new Error('Cloth requires a fixed, small timestep.');
    const p = this.positions, old = this.previous, n = this.normals, w = this.inverseMass;
    this.time += dt; this.gust *= Math.exp(-dt*1.5);
    const wind = Math.max(0,this.params.wind + this.gust);
    const speed = wind*7;
    const t = this.time, turbulence = this.params.turbulence;
    const pulse = 1 + turbulence*(.14*Math.sin(t*1.37)+.08*Math.sin(t*2.53+.6));
    n.fill(0);
    for (let j = 0; j < this.triangles.length; j += 3) {
      const a=this.triangles[j]*3,b=this.triangles[j+1]*3,c=this.triangles[j+2]*3;
      const ax=p[b]-p[a],ay=p[b+1]-p[a+1],az=p[b+2]-p[a+2];
      const bx=p[c]-p[a],by=p[c+1]-p[a+1],bz=p[c+2]-p[a+2];
      const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;
      n[a]+=nx;n[a+1]+=ny;n[a+2]+=nz;
      n[b]+=nx;n[b+1]+=ny;n[b+2]+=nz;
      n[c]+=nx;n[c+1]+=ny;n[c+2]+=nz;
    }
    for (let i=0;i<this.count;i++) {
      if (!w[i]) continue;
      const k=i*3, inv=1/Math.max(1e-10,Math.hypot(n[k],n[k+1],n[k+2]));
      const nx=n[k]*inv,ny=n[k+1]*inv,nz=n[k+2]*inv;
      let vx=(p[k]-old[k])/dt,vy=(p[k+1]-old[k+1])/dt,vz=(p[k+2]-old[k+2])/dt;
      // Eddy phases advect through WORLD positions with the mean airflow.
      // Cross-coordinate components are divergence-free; no UV-driven waves.
      const qx=p[k]*1.8-speed*t*.46,qy=p[k+1]*1.8-speed*t*.76,qz=p[k+2]*1.8;
      const eddy=speed*turbulence*.2;
      // A broad fan spreads the airstream across the camera-facing width.
      // This velocity acts through drag; it never prescribes cloth positions.
      // The floor jet rises first, then the room's crossflow carries it right.
      const height=Math.max(0,Math.min(1,(p[k+1]+2.575)/4));
      const dirX=.18+.63*height,dirY=Math.sqrt(1-dirX*dirX);
      const transverse=(p[k]+1.8)*dirY-(p[k+1]+2.575)*dirX;
      const spread=speed*.24*Math.tanh(transverse);
      const ax=speed*dirX*pulse+spread*dirY+eddy*(Math.sin(qy+qz+t*.37)+.35*Math.sin(qy*2.1-qz));
      const ay=speed*dirY*pulse-spread*dirX+eddy*(Math.sin(qz+qx*.7+t*.21)+.35*Math.sin(qz*2-qx));
      const az=speed*.06+eddy*(Math.sin(qx-qy*.6)+.45*Math.sin(qx*2.3+qy*1.5));
      const rx=ax-vx,ry=ay-vy,rz=az-vz;
      const vn=rx*nx+ry*ny+rz*nz;
      // Semi-implicit normal drag cannot accelerate a point past the air speed.
      // k = rho * Cd / (2 * areal density), tuned for a light film.
      const normalDrag=1-1/(1+18*Math.abs(vn)*dt);
      const tangentDrag=1-Math.exp(-.09*Math.hypot(rx,ry,rz)*dt);
      vx+=nx*vn*normalDrag+(rx-nx*vn)*tangentDrag;
      vy+=ny*vn*normalDrag+(ry-ny*vn)*tangentDrag;
      vz+=nz*vn*normalDrag+(rz-nz*vn)*tangentDrag;
      vy+=this.params.gravity*dt;
      const damp=Math.exp(-.08*dt);
      old[k]=p[k];old[k+1]=p[k+1];old[k+2]=p[k+2];
      p[k]+=vx*dt*damp;p[k+1]+=vy*dt*damp;p[k+2]+=vz*dt*damp;
    }
    this.edgeLambda.fill(0);this.bendLambda.fill(0);
    for (let iteration=0;iteration<10;iteration++) {
      if(iteration%2===0) this.solveBending(dt,iteration%4===2);
      this.solveEdges(dt,iteration%2===1);
      // Unilateral material-distance bounds transmit tension from the clamp.
      // A point may move freely ANYWHERE inside this radius, including falling.
      for (let i=0;i<this.count;i++) {
        if(!w[i])continue;
        const k=i*3,a=this.tetherAnchors[i]*3;
        const dx=p[k]-p[a],dy=p[k+1]-p[a+1],dz=p[k+2]-p[a+2];
        const len=Math.hypot(dx,dy,dz),limit=this.tethers[i]*1.004;
        if (len>limit) {const s=limit/len;p[k]=p[a]+dx*s;p[k+1]=p[a+1]+dy*s;p[k+2]=p[a+2]+dz*s;}
        if(p[k+1]<-2.59)p[k+1]=-2.59;
      }
    }
    for (let i=0;i<this.count;i++) {
      const k=i*3;
      if (p[k+1]<=-2.5899) {
        p[k+1]=-2.59;old[k+1]=-2.59;
        old[k]=p[k]-(p[k]-old[k])*.75;old[k+2]=p[k+2]-(p[k+2]-old[k+2])*.75;
      }
    }
  }

  solveEdges(dt,reverse) {
    const p=this.positions,w=this.inverseMass,alpha=2e-8/(dt*dt);
    for (let q=0;q<this.edgeRest.length;q++) {
      const j=reverse?this.edgeRest.length-q-1:q;
      const ai=this.edges[j*2],bi=this.edges[j*2+1],wa=w[ai],wb=w[bi];
      if (!wa&&!wb) continue;
      const a=ai*3,b=bi*3,dx=p[b]-p[a],dy=p[b+1]-p[a+1],dz=p[b+2]-p[a+2];
      const len=Math.hypot(dx,dy,dz);
      if (len<1e-10) continue;
      const dl=(-(len-this.edgeRest[j])-alpha*this.edgeLambda[j])/(wa+wb+alpha);
      this.edgeLambda[j]+=dl;
      const s=dl/len;
      p[a]-=wa*s*dx;p[a+1]-=wa*s*dy;p[a+2]-=wa*s*dz;
      p[b]+=wb*s*dx;p[b+1]+=wb*s*dy;p[b+2]+=wb*s*dz;
    }
  }

  solveBending(dt,reverse) {
    const p=this.positions,w=this.inverseMass,g=this.gradient,b=this.bends;
    for (let q=0;q<this.bendRest.length;q++) {
      const j=reverse?this.bendRest.length-q-1:q,k=j*4;
      const angle=dihedral(p,b,k,g);
      if (!Number.isFinite(angle)) continue;
      let error=angle-this.bendRest[j];
      if (error>Math.PI) error-=2*Math.PI;else if(error<-Math.PI) error+=2*Math.PI;
      const retention=this.depth?this.params.memory*this.bendWeight[j]:0;
      const alpha=(.32/(1+retention*800))/(dt*dt);
      let denom=alpha;
      for(let i=0;i<4;i++) denom+=w[b[k+i]]*(g[i*3]**2+g[i*3+1]**2+g[i*3+2]**2);
      const dl=(-error-alpha*this.bendLambda[j])/denom;
      this.bendLambda[j]+=dl;
      for(let i=0;i<4;i++) {
        const index=b[k+i],s=w[index]*dl;
        for(let axis=0;axis<3;axis++) p[index*3+axis]+=s*g[i*3+axis];
      }
    }
  }

  /** Bicubic interpolation only. Every animated fold comes from the solver. */
  sample(u,v,target,offset=0) {
    const fx=Math.min(this.columns-.000001,Math.max(0,u)*this.columns);
    const fy=Math.min(this.rows-.000001,Math.max(0,v)*this.rows);
    const x=Math.floor(fx),y=Math.floor(fy),tx=fx-x,ty=fy-y;
    const stride=(this.columns+1)*3,p=this.positions;
    const xa=Math.max(0,x-1)*3,xb=x*3,xc=(x+1)*3,xd=Math.min(this.columns,x+2)*3;
    const ya=Math.max(0,y-1)*stride,yb=y*stride,yc=(y+1)*stride,yd=Math.min(this.rows,y+2)*stride;
    for(let axis=0;axis<3;axis++) {
      const a=cubic(p[ya+xa+axis],p[ya+xb+axis],p[ya+xc+axis],p[ya+xd+axis],tx);
      const b=cubic(p[yb+xa+axis],p[yb+xb+axis],p[yb+xc+axis],p[yb+xd+axis],tx);
      const c=cubic(p[yc+xa+axis],p[yc+xb+axis],p[yc+xc+axis],p[yc+xd+axis],tx);
      const d=cubic(p[yd+xa+axis],p[yd+xb+axis],p[yd+xc+axis],p[yd+xd+axis],tx);
      target[offset+axis]=cubic(a,b,c,d,ty);
    }
  }
}

function distance(p,a,b){return Math.hypot(p[b]-p[a],p[b+1]-p[a+1],p[b+2]-p[a+2]);}
function cubic(a,b,c,d,t){return b+.5*t*(c-a+t*(2*a-5*b+4*c-d+t*(3*(b-c)+d-a)));}

/** Signed hinge angle and analytic gradient. Exported for finite-difference QA. */
export function dihedral(p,indices,k=0,g=null) {
  const a=indices[k]*3,b=indices[k+1]*3,c=indices[k+2]*3,d=indices[k+3]*3;
  const ex=p[b]-p[a],ey=p[b+1]-p[a+1],ez=p[b+2]-p[a+2],ee=ex*ex+ey*ey+ez*ez,el=Math.sqrt(ee);
  const cx=p[c]-p[a],cy=p[c+1]-p[a+1],cz=p[c+2]-p[a+2];
  const dx=p[d]-p[a],dy=p[d+1]-p[a+1],dz=p[d+2]-p[a+2];
  const n1x=ey*cz-ez*cy,n1y=ez*cx-ex*cz,n1z=ex*cy-ey*cx;
  const n2x=dy*ez-dz*ey,n2y=dz*ex-dx*ez,n2z=dx*ey-dy*ex;
  const n1q=n1x*n1x+n1y*n1y+n1z*n1z,n2q=n2x*n2x+n2y*n2y+n2z*n2z;
  if (ee<1e-14||n1q<1e-16||n2q<1e-16) {g?.fill(0);return NaN;}
  const angle=Math.atan2(((n1y*n2z-n1z*n2y)*ex+(n1z*n2x-n1x*n2z)*ey+(n1x*n2y-n1y*n2x)*ez)/el,n1x*n2x+n1y*n2y+n1z*n2z);
  if(g) {
    const s1=-el/n1q,s2=-el/n2q;
    g[6]=n1x*s1;g[7]=n1y*s1;g[8]=n1z*s1;
    g[9]=n2x*s2;g[10]=n2y*s2;g[11]=n2z*s2;
    const u=(cx*ex+cy*ey+cz*ez)/ee,v=(dx*ex+dy*ey+dz*ez)/ee;
    for(let j=0;j<3;j++){g[j]=(u-1)*g[6+j]+(v-1)*g[9+j];g[3+j]=-u*g[6+j]-v*g[9+j];}
  }
  return angle;
}
