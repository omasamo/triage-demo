// Exposes a single, narrow bridge to the UI. No Node APIs reach the renderer.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('triage', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('triage', method, ...args),
  on: (channel: 'ai-status' | 'reanalyse-progress' | 'download-progress' | 'speedtest-progress', cb: (payload: unknown) => void) => {
    const fn = (_: unknown, p: unknown) => cb(p);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  desktop: true,
});
