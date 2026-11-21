import type { ModelState } from '@/shared/engine-status';

/** Immutable remote bytes shared by translation models and multi-file asset bundles. */
export interface AssetPin {
  commit: string;
  size: number;
  sha256: string;
  url: string;
}

export interface AssetFile extends AssetPin {
  /** Relative path inside the bundle's storage directory. */
  path: string;
}

export interface AssetBundle<Id extends string = string> {
  id: Id;
  size: number;
  files: readonly AssetFile[];
}

export interface AssetStatus<Id extends string = string> {
  id: Id;
  state: ModelState;
  received: number;
  total: number;
  progress: number;
  error?: string;
}

export function assetBundleSize(files: readonly Pick<AssetPin, 'size'>[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}
