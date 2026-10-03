// Fullscreen presentation for the canvas player. Orientation lock is optional:
// browsers that cannot rotate the screen get a landscape layout inside the viewport.
type Orientation = ScreenOrientation & { lock?: (mode: 'landscape') => Promise<void> };
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void | Promise<void>;
};
type FullscreenRoot = HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> };

export function setupFullscreen(player: HTMLElement, button: HTMLButtonElement, status: HTMLElement, invalidate: () => void) {
  const doc = document as FullscreenDocument;
  const root = document.documentElement as FullscreenRoot;
  const touch = matchMedia('(pointer: coarse)');
  const orientation = screen.orientation as Orientation | undefined;
  const nativeActive = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  let expanded = false, busy = false, orientationRequested = false;

  const unlock = () => {
    if (!orientationRequested) return;
    orientationRequested = false;
    try { orientation?.unlock?.(); } catch { /* a hidden document may forbid unlock */ }
  };
  const sync = () => {
    const active = nativeActive() || expanded;
    // Remove the fallback as soon as the device itself rotates to landscape.
    player.classList.toggle('landscape-layout', active && touch.matches && innerHeight > innerWidth);
    button.textContent = active ? (expanded ? 'Exit expanded view' : 'Exit fullscreen') : 'Fullscreen';
    button.setAttribute('aria-pressed', String(active));
    if (!active) unlock();
    invalidate();
  };
  const toggle = async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      if (nativeActive() || expanded) {
        if (nativeActive()) {
          const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
          if (!exit) throw new Error('Fullscreen exit is unavailable');
          await exit.call(doc);
        }
        expanded = false;
        unlock();
        status.textContent = '';
        return;
      }
      status.textContent = '';
      try {
        const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
        if (!request) throw new Error('Fullscreen is unavailable');
        await request.call(root);
      } catch {
        if (!touch.matches) throw new Error('Fullscreen is unavailable');
        // Some mobile browsers cannot fullscreen a canvas page. Use the full
        // browser viewport and keep an explicit exit; browser chrome may remain.
        expanded = true;
        status.textContent = 'Expanded view — browser fullscreen is unavailable.';
      }
      sync();
      if (nativeActive() && touch.matches && orientation?.lock) {
        orientationRequested = true;
        try {
          // Do not disable Exit while waiting for the OS to rotate the device.
          void orientation.lock('landscape').then(() => {
            if (!nativeActive()) {
              // A late completion must also release the lock after an exit.
              orientationRequested = true;
              unlock();
            }
            sync();
          }, () => { /* keep the CSS landscape layout */ });
        } catch { /* keep the CSS landscape layout if locking is unsupported */ }
      }
    } catch {
      status.textContent = 'Fullscreen is unavailable in this browser window.';
    } finally {
      busy = false;
      button.disabled = false;
      sync();
    }
  };

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('resize', sync);
  touch.addEventListener('change', sync);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && expanded) {
      expanded = false;
      status.textContent = '';
      sync();
    }
  });
  window.addEventListener('pagehide', unlock);
  sync();
  return toggle;
}
