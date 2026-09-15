// Run in an isolated dev tab at /?study=projection:
// await (await import('/tests/projection.browser.js')).checkProjectionFrames()
// Uses the real cloth solver, WebGL capture, texture decoding and render loop.
// A controllable model response makes latency, failure and cancellation repeatable.
export async function checkProjectionFrames() {
  const v=window.__veil,p=v?.projection;
  if(!p?.state.active)throw new Error('Open the dev projection study first');
  const originalFetch=window.fetch,requests=[],checks=[];
  const originalCamera=v.camera.clone();
  const check=(ok,name)=>{if(!ok)throw new Error(name);checks.push(name);};
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async predicate=>{
    const deadline=performance.now()+5000;
    while(!predicate()){
      if(performance.now()>deadline)throw new Error('Timed out waiting for a frame');
      await sleep(10);
    }
  };
  const hash=()=>{
    let h=2166136261;
    for(const name of ['position','normal'])for(const n of new Uint32Array(v.geometry.attributes[name].array.buffer))h=Math.imul(h^n,16777619);
    return h>>>0;
  };
  const matrix=()=>JSON.stringify(p.presentedMatrix.elements);
  const respond=(request,status=200,id=request.body.frame_id)=>request.resolve(new Response(JSON.stringify(
    status===200?{frame_id:id,image:request.body.depth,inference_ms:120}:{detail:'Controlled generation failure'}
  ),{status,headers:{'Content-Type':'application/json'}}));
  window.fetch=(url,options)=>{
    if(String(url).endsWith('/health'))return Promise.resolve(new Response(JSON.stringify({status:'ready',device:'test',model:'Controlled test model'})));
    if(String(url).endsWith('/generate'))return new Promise(resolve=>requests.push({body:JSON.parse(options.body),resolve}));
    return originalFetch(url,options);
  };
  try{
    v.advance(0);await wait(()=>!p.state.busy);await p.health();
    p.nextFrame();await wait(()=>requests.length===1);
    respond(requests[0]);await wait(()=>p.state.projectedFrame===1);
    const first={hash:hash(),time:p.state.simulationTime,matrix:matrix(),image:p.generatedPreview.src};
    p.run();await wait(()=>requests.length===2);
    p.stop();
    v.camera.position.x+=1;v.orbit.update();p.placeProjector();
    await sleep(180);
    check(hash()===first.hash&&p.generatedPreview.src===first.image,'Pose, normals and image stay fixed during inference');
    check(p.state.projectedFrame===1&&p.state.simulationTime===first.time,'Visible frame and simulation time stay fixed during inference');
    check(v.cloth.time>first.time&&v.cloth.time<=first.time+2/30+1e-9,'Only the pending pose and one private lookahead are simulated');
    respond(requests[1]);await wait(()=>p.state.projectedFrame===2);await sleep(100);
    check(hash()!==first.hash&&requests.length===2&&!p.state.running,'Stop finishes the current pair without requesting another');
    check(Math.abs(p.state.simulationTime-first.time-1/30)<1e-9,'Presented frames advance by exactly four physics substeps');
    check(matrix()===first.matrix,'Moving the projector cannot change a captured frame');
    const secondHash=hash(),secondTime=p.state.simulationTime;
    p.nextFrame();await wait(()=>requests.length===3);
    respond(requests[2],500);await wait(()=>!p.state.busy);
    check(hash()===secondHash&&p.state.projectedFrame===2&&!!p.state.error,'Failure holds the last completed pair');
    const failedTime=v.cloth.time;
    p.nextFrame();await wait(()=>requests.length===4);
    check(requests[3].body.depth===requests[2].body.depth&&requests[3].body.frame_id===3&&v.cloth.time===failedTime,'Retry reuses the exact depth and pose without skipping a frame');
    respond(requests[3]);await wait(()=>p.state.projectedFrame===3);
    check(matrix()!==first.matrix,'Queued projector placement applies to the next capture');
    check(Math.abs(p.state.simulationTime-secondTime-1/30)<1e-9,'Retry presents the next consecutive simulation frame');
    p.nextFrame();await wait(()=>requests.length===5);
    p.reset();respond(requests[4]);await wait(()=>!p.state.busy);
    check(p.state.projectedFrame===0&&p.state.generated===0,'Reset discards an old response even if the transport ignores abort');
    p.nextFrame();await wait(()=>requests.length===6);
    respond(requests[5],200,99);await wait(()=>!p.state.busy);
    check(p.state.projectedFrame===0&&p.state.error==='Invalid model frame','A response with the wrong frame number is rejected');
    return {passed:checks.length,checks};
  }finally{
    p.reset();window.fetch=originalFetch;
    v.camera.copy(originalCamera);v.orbit.update();p.placeProjector();
    await p.health();
  }
}
