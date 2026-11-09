(() => {
  const reply = (payload) => {
    parent.postMessage({ source: 'sakutto-gpu-probe', ...payload }, '*');
  };
  const empty = {
    present: false,
    maxBufferSize: null,
    maxStorageBufferBindingSize: null,
    maxComputeWorkgroupStorageSize: null,
    maxComputeInvocationsPerWorkgroup: null,
    vendor: null,
    architecture: null,
    device: null,
    description: null,
    fallbackAdapter: null,
    shaderF16: false,
    subgroups: false,
    subgroupMinSize: null,
    subgroupMaxSize: null,
    features: [],
    adapterAttempts: [],
    dotProduct: false,
  };
  const gpu = navigator.gpu;
  if (!gpu) {
    reply(empty);
    return;
  }
  const preferences = ['high-performance', 'default', 'low-power'];
  const attempts = [];
  const featureNames = (adapter) => {
    const names = [];
    try {
      if (adapter && adapter.features) {
        for (const name of adapter.features) names.push(String(name));
      }
    } catch (e) {}
    names.sort();
    return names;
  };
  const snapshot = (adapter) => {
    const limits = adapter && adapter.limits ? adapter.limits : {};
    const info = adapter && adapter.info ? adapter.info : {};
    const features = featureNames(adapter);
    const has = (name) => features.indexOf(name) !== -1;
    const fallback =
      adapter && typeof adapter.isFallbackAdapter === 'boolean'
        ? adapter.isFallbackAdapter
        : typeof info.isFallbackAdapter === 'boolean'
          ? info.isFallbackAdapter
          : null;
    const featuresObj = gpu.wgslLanguageFeatures;
    const dotProduct = Boolean(featuresObj && featuresObj.has('packed_4x8_integer_dot_product'));
    return {
      present: true,
      maxBufferSize: typeof limits.maxBufferSize === 'number' ? limits.maxBufferSize : null,
      maxStorageBufferBindingSize:
        typeof limits.maxStorageBufferBindingSize === 'number'
          ? limits.maxStorageBufferBindingSize
          : null,
      maxComputeWorkgroupStorageSize:
        typeof limits.maxComputeWorkgroupStorageSize === 'number'
          ? limits.maxComputeWorkgroupStorageSize
          : null,
      maxComputeInvocationsPerWorkgroup:
        typeof limits.maxComputeInvocationsPerWorkgroup === 'number'
          ? limits.maxComputeInvocationsPerWorkgroup
          : null,
      vendor: info.vendor || null,
      architecture: info.architecture || null,
      device: info.device || null,
      description: info.description || null,
      fallbackAdapter: fallback,
      shaderF16: has('shader-f16'),
      subgroups: has('subgroups'),
      subgroupMinSize: typeof info.subgroupMinSize === 'number' ? info.subgroupMinSize : null,
      subgroupMaxSize: typeof info.subgroupMaxSize === 'number' ? info.subgroupMaxSize : null,
      features,
      adapterAttempts: attempts.slice(),
      dotProduct,
    };
  };
  const request = (preference) => {
    attempts.push(preference);
    if (preference === 'default') return gpu.requestAdapter();
    return gpu.requestAdapter({ powerPreference: preference });
  };
  const pick = async () => {
    let first = null;
    for (let i = 0; i < preferences.length; i += 1) {
      const adapter = await request(preferences[i]);
      if (!adapter) continue;
      if (!first) first = adapter;
      const features = featureNames(adapter);
      const fallback =
        adapter.isFallbackAdapter === true ||
        (adapter.info && adapter.info.isFallbackAdapter === true);
      if (fallback) continue;
      if (features.indexOf('shader-f16') !== -1) return adapter;
    }
    return first;
  };
  pick().then(
    (adapter) => {
      if (!adapter) {
        reply({ ...empty, adapterAttempts: attempts.slice() });
        return;
      }
      reply(snapshot(adapter));
    },
    () => reply({ ...empty, adapterAttempts: attempts.slice() }),
  );
})();
