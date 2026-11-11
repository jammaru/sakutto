/**
 * The 0009 wave64 patch closes `ggml_webgpu_disable_subgroups` with an added
 * `}`, then inserts the f16/subgroup probe helpers. The original `}` after
 * those helpers ends `ggml_webgpu_probe_shuffle_down_wgsl`. `git apply --check`
 * cannot tell a stray file-scope brace from that shape, so the applied C++
 * is brace-balanced here. CI `--check` runs this after every patch apply.
 */
export function assertWave64ProbePlacement(cpp: string): void {
  const disable = cpp.indexOf('ggml_webgpu_disable_subgroups');
  const probe = cpp.indexOf('ggml_webgpu_probe_f16_sum_wgsl');
  if (disable < 0) throw new Error('ggml_webgpu_disable_subgroups is missing after the patches');
  if (probe < 0) throw new Error('ggml_webgpu_probe_f16_sum_wgsl is missing after the patches');
  if (probe < disable) {
    throw new Error('the f16 probe helpers were inserted before ggml_webgpu_disable_subgroups');
  }

  const between = cpp.slice(disable, probe);
  let depth = 0;
  let seenOpen = false;
  for (const character of between) {
    if (character === '{') {
      depth += 1;
      seenOpen = true;
    } else if (character === '}') {
      depth -= 1;
      if (depth < 0) {
        throw new Error('extra closing brace before ggml_webgpu_probe_f16_sum_wgsl');
      }
    }
  }
  if (!seenOpen || depth !== 0) {
    throw new Error('ggml_webgpu_disable_subgroups is still open when the f16 probe helpers begin');
  }

  const shuffle = cpp.indexOf('ggml_webgpu_probe_shuffle_down_wgsl');
  const correctness = cpp.indexOf('ggml_webgpu_correctness_probe');
  if (shuffle < 0 || correctness < 0 || correctness < shuffle) {
    throw new Error('the shuffle-down probe is not followed by ggml_webgpu_correctness_probe');
  }
  const afterShuffle = cpp.slice(shuffle, correctness);
  const close = afterShuffle.lastIndexOf('}');
  if (close < 0 || afterShuffle.slice(close + 1).includes('}')) {
    throw new Error('extra closing brace after ggml_webgpu_probe_shuffle_down_wgsl');
  }
}
