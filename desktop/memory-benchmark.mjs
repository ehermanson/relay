import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

/** Isolated benchmark only; GC samples measure retention, never production tuning. */
export async function profileMemory({
  window,
  request,
  processMetrics,
  rounds = 2,
  settleMs = 10000,
}) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const snapshots = [];
  const debuggerAttached = !window.webContents.debugger.isAttached();
  if (debuggerAttached) window.webContents.debugger.attach("1.3");
  async function sample(phase, collectGarbage = false) {
    if (collectGarbage)
      await window.webContents.debugger.sendCommand("HeapProfiler.collectGarbage");
    const heap = await window.webContents.debugger.sendCommand("Runtime.getHeapUsage");
    const backend = await request("metrics", { collectGarbage });
    const rendererCaches = await window.webContents.executeJavaScript(`new Promise(resolve=>{
      const handler=event=>{clearTimeout(timer);resolve(event.detail)};
      const timer=setTimeout(()=>{window.removeEventListener('relay:memory-diagnostics-result',handler);resolve(null)},1000);
      window.addEventListener('relay:memory-diagnostics-result',handler,{once:true});
      window.dispatchEvent(new Event('relay:memory-diagnostics'));
    })`);
    const snapshot = {
      phase,
      collectGarbage,
      backend,
      rendererHeap: heap,
      rendererCaches,
      processes: processMetrics(),
    };
    snapshots.push(snapshot);
    console.info("DESKTOP_MEMORY_SAMPLE", JSON.stringify(snapshot));
  }
  try {
    await delay(settleMs);
    await sample("settled");
    const chats = await window.webContents.executeJavaScript(
      `fetch('/api/instances').then(r=>r.json()).then(chats=>chats.filter(c=>/^Benchmark Chat /.test(c.name)).sort((a,b)=>Number(a.name.match(/Chat (\\d+)/)[1])-Number(b.name.match(/Chat (\\d+)/)[1])))`,
    );
    const timings = [];
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index < chats.length; index++) {
        const chat = chats[index];
        const project =
          chat.projectSlug || chat.projectId || chat.workingDirectory.split("/").pop();
        const path = `/projects/${encodeURIComponent(project)}/chats/${encodeURIComponent(chat.id)}`;
        const started = performance.now();
        window.webContents.send("desktop:navigate", path);
        await window.webContents.executeJavaScript(`(async()=>{
          const deadline=performance.now()+20000;
          while(location.pathname!==${JSON.stringify(path)} || !document.querySelector('[data-chat-content]')?.textContent.includes(${JSON.stringify(`memory-fixture-${index}`)})) {
            if(performance.now()>deadline)throw new Error('Memory fixture Chat did not load: '+location.pathname);
            await new Promise(resolve=>setTimeout(resolve,25));
          }
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        })()`);
        timings.push(performance.now() - started);
      }
      window.webContents.send("desktop:navigate", "/");
      await delay(1000);
      await sample(`round-${round + 1}`);
      await sample(`round-${round + 1}-retained`, true);
    }
    await delay(settleMs);
    await sample("final-idle");
    await sample("final-retained", true);
    if (process.env.RELAY_DESKTOP_HEAP_SNAPSHOT) {
      const output = createWriteStream(process.env.RELAY_DESKTOP_HEAP_SNAPSHOT, { mode: 0o600 });
      const completion = finished(output);
      void completion.catch(() => {});
      const listener = (_event, method, parameters) => {
        if (method === "HeapProfiler.addHeapSnapshotChunk") output.write(parameters.chunk);
      };
      window.webContents.debugger.on("message", listener);
      try {
        await window.webContents.debugger.sendCommand("HeapProfiler.takeHeapSnapshot");
        output.end();
        await completion;
      } finally {
        window.webContents.debugger.removeListener("message", listener);
        output.destroy();
      }
    }
    return { rounds, chats: chats.length, settleMs, timings, snapshots };
  } finally {
    if (debuggerAttached) window.webContents.debugger.detach();
  }
}
