import { TimeTravelEngine } from "./engine.js"
import { DebuggerUI } from "./ui.js"

const statusEl = document.querySelector("#status-pill")

async function boot() {
  try {
    const engine = await TimeTravelEngine.create()
    const ui = new DebuggerUI(engine)
    ui.setStatus("ok", "VM ready")
    // record the default sample right away so the page opens alive
    await ui.record()
    window.__timetravel = { engine, ui } // handy for curious devtools users & e2e tests
  } catch (err) {
    console.error(err)
    if (statusEl) {
      statusEl.className = "status-pill err"
      statusEl.textContent = "failed to load WebAssembly VM — see devtools console"
    }
  }
}

boot()
