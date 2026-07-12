// Stub for Tauri API modules during Next.js dev server.
// At runtime inside Tauri webview these are injected globally.
module.exports = new Proxy(
  {},
  {
    get(_, key) {
      return (...args) =>
        Promise.reject(new Error(`Tauri API "${String(key)}" is only available inside the desktop app.`))
    },
  }
)
