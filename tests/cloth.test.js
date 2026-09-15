import test from 'node:test';
import assert from 'node:assert/strict';
import { RibbonCloth, dihedral } from '../src/cloth.js';

const advance = (cloth, seconds) => { for(let i=0;i<seconds*120;i++) cloth.step(); };
function freeEnd(cloth) {
  const result=[0,0,0];
  for(let y=0;y<=cloth.rows;y++) for(let k=0;k<3;k++) result[k]+=cloth.positions[(y*(cloth.columns+1)+cloth.columns)*3+k]/(cloth.rows+1);
  return result;
}
function strain(cloth) {
  let squared=0;
  for(let j=0;j<cloth.edgeRest.length;j++) {
    const a=cloth.edges[j*2]*3,b=cloth.edges[j*2+1]*3;
    const length=Math.hypot(...[0,1,2].map(k=>cloth.positions[a+k]-cloth.positions[b+k]));
    squared+=(length/cloth.edgeRest[j]-1)**2;
  }
  return Math.sqrt(squared/cloth.edgeRest.length);
}
const relief = cloth => Float32Array.from({length:cloth.count},(_,i)=> {
  const u=i%(cloth.columns+1)/cloth.columns,v=Math.floor(i/(cloth.columns+1))/cloth.rows;
  return Math.exp(-((u-.5)**2+(v-.5)**2)*28);
});

test('without wind, the floor-mounted ribbon settles onto the floor', () => {
  const cloth=new RibbonCloth(32,12);cloth.params.wind=0;
  advance(cloth,10);
  const tip=freeEnd(cloth);
  assert.ok(tip[1]<-2.5, `free end did not settle: ${tip}`);
  assert.ok(cloth.positions.every((v,i)=>i%3!==1||v<-2.5),'still air cannot hold any part of the sheet up');
  assert.ok(strain(cloth)<.05);
});

test('wind extends the sheet and switching it off releases the same live state', () => {
  const cloth=new RibbonCloth(32,12);advance(cloth,8);
  const flying=freeEnd(cloth);
  assert.ok(flying[0]>-.8 && flying[1]>.3, `airflow must lift the free end up and right: ${flying}`);
  const snapshot=cloth.positions.slice();
  advance(cloth,.3);
  const moved=cloth.positions.reduce((sum,v,i)=>sum+(v-snapshot[i])**2,0)/cloth.count;
  assert.ok(moved>.001,'folds should continue moving after the initial transient');
  cloth.params.wind=0;advance(cloth,10);
  const fallen=freeEnd(cloth);
  assert.ok(fallen[1]<flying[1]-1.2,'turning wind off must cause visible sag');
  assert.ok(fallen[1]<-2.4,'the loose end must return to the floor');
});

test('maximum wind stays finite, near-inextensible, and attached over a sustained run', () => {
  const cloth=new RibbonCloth();cloth.params.wind=1.5;cloth.params.turbulence=1;
  for(let block=0;block<6;block++) {
    advance(cloth,2);
    assert.ok(cloth.positions.every(v=>Number.isFinite(v)&&Math.abs(v)<8));
    assert.ok(strain(cloth)<.045,`RMS strain ${strain(cloth)}`);
    for(let i=0;i<cloth.count;i++) {
      assert.ok(cloth.positions[i*3+1]>=-2.591);
      if(cloth.inverseMass[i]===0) assert.deepEqual(cloth.positions.slice(i*3,i*3+3),cloth.rest.slice(i*3,i*3+3));
    }
  }
});

test('reset is deterministic and removes velocity', () => {
  const cloth=new RibbonCloth(20,8);advance(cloth,1);
  const first=cloth.positions.slice();cloth.reset();
  assert.deepEqual(cloth.previous,cloth.positions);
  advance(cloth,1);assert.deepEqual(cloth.positions,first);
});

test('signed bending gradients match finite differences away from the flat pose', () => {
  const p=new Float64Array([0,0,0,1,.2,.1,.1,1,.3,.8,-1,-.2]);
  const ids=[0,1,2,3],gradient=new Float64Array(12);
  dihedral(p,ids,0,gradient);
  for(let i=0;i<12;i++) {
    const original=p[i];p[i]=original+1e-6;const hi=dihedral(p,ids);
    p[i]=original-1e-6;const lo=dihedral(p,ids);p[i]=original;
    assert.ok(Math.abs(gradient[i]-(hi-lo)/2e-6)<1e-6,`gradient ${i}`);
  }
});

test('depth encodes intrinsic distances and fold angles, with no world-position target', () => {
  const a=new RibbonCloth(20,8),b=new RibbonCloth(20,8);
  const flatLengths=a.edgeRest.slice();a.setDepth(relief(a));b.setDepth(relief(b));
  assert.notDeepEqual(a.edgeRest,flatLengths);
  assert.ok(a.bendRest.some(v=>Math.abs(v)>.02));
  // Deform identical sheets, then rigidly rotate/translate one. Their internal
  // constraints must produce the same result in either coordinate system.
  for(let i=0;i<a.count;i++) a.positions[i*3+2]+=.05*Math.sin(i*.6);
  const transform=(x,y,z)=>[x*.8-z*.6+3,y-2,x*.6+z*.8+.7];
  for(let i=0;i<a.count;i++) b.positions.set(transform(...a.positions.slice(i*3,i*3+3)),i*3);
  for(let j=0;j<5;j++) {a.solveBending(1/120,false);a.solveEdges(1/120,false);b.solveBending(1/120,false);b.solveEdges(1/120,false);}
  let max=0;
  for(let i=0;i<a.count;i++) {
    const expected=transform(...a.positions.slice(i*3,i*3+3));
    for(let k=0;k<3;k++) max=Math.max(max,Math.abs(expected[k]-b.positions[i*3+k]));
  }
  assert.ok(max<2e-5,`shape constraints depend on world position: ${max}`);
  a.setDepth(null);assert.deepEqual(a.rest,a.base);
});

test('malformed depth and unsafe timesteps do not change the state', () => {
  const cloth=new RibbonCloth(10,4),initial=cloth.positions.slice();
  assert.throws(()=>cloth.setDepth(new Float32Array(2)),/finite samples/);
  assert.throws(()=>cloth.setDepth(new Float32Array(cloth.count).fill(NaN)),/finite samples/);
  assert.throws(()=>cloth.step(1),/timestep/);
  assert.throws(()=>cloth.step(NaN),/timestep/);
  assert.deepEqual(cloth.positions,initial);
});
