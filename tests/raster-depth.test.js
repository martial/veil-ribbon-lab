import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rasterDepth } from '../src/raster-depth.js';

function geometry(vertices,indices){
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);return g;
}
const camera=new THREE.PerspectiveCamera(90,1,1,20);
const shade=z=>Math.round(255*(.08+.92*(1-(z-2)/8)));

test('camera depth has the expected perspective footprint, scalar value and origin',()=>{
  const g=geometry([-1,1,-4,1,1,-4,1,-1,-4,-1,-1,-4],[0,1,2,0,2,3]);
  const image=rasterDepth(g,camera.projectionMatrix,64,2,10);
  let count=0;
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const value=image[(y*64+x)*4];
    assert.equal(value,x>=24&&x<40&&y>=24&&y<40?shade(4):0);
    if(value)count++;
  }
  assert.equal(count,256);
});

test('the nearest fold wins regardless of triangle order or winding',()=>{
  const g=geometry([-2,-2,-6,2,-2,-6,0,2,-6,-1,-1,-3,1,-1,-3,0,1,-3],[0,1,2,3,4,5]);
  const first=rasterDepth(g,camera.projectionMatrix,64,2,10).slice();
  g.setIndex([5,4,3,2,1,0]);
  assert.deepEqual(rasterDepth(g,camera.projectionMatrix,64,2,10),first);
  assert.equal(first[(32*64+32)*4],shade(3));
});

test('sloped depth agrees with ray-triangle intersections rather than affine distance',()=>{
  const vertices=[-1,1,-2,3,3,-6,-1,-1,-2],g=geometry(vertices,[0,1,2]);
  const image=rasterDepth(g,camera.projectionMatrix,64,2,10);
  const a=new THREE.Vector3(...vertices.slice(0,3)),b=new THREE.Vector3(...vertices.slice(3,6)),c=new THREE.Vector3(...vertices.slice(6,9));
  for(const [x,y] of [[25,25],[32,25],[37,25]]){
    const direction=new THREE.Vector3((x+.5)/32-1,1-(y+.5)/32,-1).normalize();
    const point=new THREE.Ray(new THREE.Vector3(),direction).intersectTriangle(a,b,c,false,new THREE.Vector3());
    assert.ok(point);assert.equal(image[(y*64+x)*4],shade(-point.z));
  }
});

test('near clipping is finite and an entirely clipped triangle contributes no pixels',()=>{
  const g=geometry([-1,0,-.5,1,-1,-3,1,1,-3],[0,1,2]);
  assert.ok(rasterDepth(g,camera.projectionMatrix,32,1,10).some((v,i)=>i%4!==3&&v>0));
  g.attributes.position.array.fill(0);
  assert.ok(rasterDepth(g,camera.projectionMatrix,32,1,10).every((v,i)=>i%4===3||v===0));
});
