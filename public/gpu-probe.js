(() => {
  const reply = (present, maxBufferSize) => {
    parent.postMessage({ source: 'sakutto-gpu-probe', present, maxBufferSize }, '*');
  };
  const gpu = navigator.gpu;
  if (!gpu) {
    reply(false, null);
    return;
  }
  gpu.requestAdapter().then(
    (adapter) => {
      const limit = adapter && adapter.limits ? adapter.limits.maxBufferSize : null;
      reply(Boolean(adapter), typeof limit === 'number' ? limit : null);
    },
    () => reply(false, null),
  );
})();
