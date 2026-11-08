(() => {
  const reply = (present, maxBufferSize, vendor, dotProduct) => {
    parent.postMessage(
      { source: 'sakutto-gpu-probe', present, maxBufferSize, vendor, dotProduct },
      '*',
    );
  };
  const gpu = navigator.gpu;
  if (!gpu) {
    reply(false, null, null, false);
    return;
  }
  gpu.requestAdapter().then(
    (adapter) => {
      const limit = adapter && adapter.limits ? adapter.limits.maxBufferSize : null;
      const vendor = adapter && adapter.info ? adapter.info.vendor : null;
      const features = gpu.wgslLanguageFeatures;
      const dotProduct = Boolean(features && features.has('packed_4x8_integer_dot_product'));
      reply(Boolean(adapter), typeof limit === 'number' ? limit : null, vendor, dotProduct);
    },
    () => reply(false, null, null, false),
  );
})();
