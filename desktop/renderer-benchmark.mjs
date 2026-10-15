/** Read-only performance fixture: route/render/scroll against isolated synthetic transcripts. */
export async function profileSyntheticChat(window, expectedMessages) {
  if (!Number.isInteger(expectedMessages) || expectedMessages < 1 || expectedMessages > 50000)
    throw new Error("Invalid synthetic Chat size");
  const target = await window.webContents.executeJavaScript(
    `(async()=>{const chats=await fetch('/api/instances').then(r=>r.json());const chat=chats.find(c=>/^Benchmark Chat 1:/.test(c.name));if(!chat)throw new Error('Synthetic Chat was not discovered ('+chats.length+'): '+chats.slice(0,5).map(c=>c.name).join(', '));return{chatId:chat.id,projectId:chat.projectSlug||chat.projectId||chat.workingDirectory.split('/').pop(),spaceId:chat.spaceId}})()`,
  );
  const path = target.spaceId
    ? `/projects/${encodeURIComponent(target.projectId)}/spaces/${encodeURIComponent(target.spaceId)}/${encodeURIComponent(target.chatId)}`
    : `/projects/${encodeURIComponent(target.projectId)}/chats/${encodeURIComponent(target.chatId)}`;
  await window.webContents.executeJavaScript(
    `(()=>{window.__relayBenchmark={started:performance.now(),tasks:[]};window.__relayBenchmark.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__relayBenchmark.tasks.push(entry.duration)});window.__relayBenchmark.observer.observe({entryTypes:['longtask']});})()`,
  );
  window.webContents.send("desktop:navigate", path);
  const report = await window.webContents.executeJavaScript(`(async()=>{
    const state=window.__relayBenchmark;
    const deadline=performance.now()+20000;
    while(!document.querySelector('[data-chat-content]')?.textContent.includes(${JSON.stringify(`Message ${expectedMessages}:`)})){
      if(performance.now()>deadline)throw new Error('Synthetic Chat render timed out at '+location.pathname+': '+document.body.innerText.slice(-500));
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const routeReadyMs=performance.now()-state.started;
    let scroller=document.querySelector('[data-chat-content]').parentElement;
    while(scroller&&!['auto','scroll'].includes(getComputedStyle(scroller).overflowY))scroller=scroller.parentElement;
    if(!scroller)throw new Error('Chat scroll container was not found');
    const previousBehavior=scroller.style.scrollBehavior;
    scroller.style.scrollBehavior='auto';
    const frameTimes=[];
    let previous=performance.now();
    let peakRows=0;
    for(let frame=0;frame<60;frame++){
      scroller.scrollTop=(scroller.scrollHeight-scroller.clientHeight)*(frame/59);
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const now=performance.now();frameTimes.push(now-previous);previous=now;
      peakRows=Math.max(peakRows,document.querySelectorAll('[data-row-id]').length);
    }
    scroller.style.scrollBehavior=previousBehavior;
    state.observer.disconnect();
    const heap=performance.memory?.usedJSHeapSize??null;
    const result={routeReadyMs,frames:frameTimes.length,maxFrameMs:Math.max(...frameTimes),slowFramesOver50ms:frameTimes.filter(ms=>ms>50).length,peakRenderedRows:peakRows,longTaskCount:state.tasks.length,longTaskTotalMs:state.tasks.reduce((a,b)=>a+b,0),maxLongTaskMs:Math.max(0,...state.tasks),usedJSHeapSize:heap};
    delete window.__relayBenchmark;
    return result;
  })()`);
  return { ...report, syntheticAssistantMessages: expectedMessages };
}
