import { BlockError } from './block.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export type RoutingMode = 'scrapling-first' | 'legacy-only';

export interface RouteDiagnostics {
  primaryEngine?: string;
  finalEngine?: string;
  fallbackReason?: string;
  failureClass?: string;
  shadowMode?: boolean;
  shadowSecondaryResult?: any;
  shadowSecondaryError?: any;
  forceMode?: RoutingMode;
}

export const routingDiagnostics = new AsyncLocalStorage<RouteDiagnostics>();

export interface RouteOptions<T> {
  mode?: RoutingMode;
  adapter?: string;
  method?: 'GET' | 'POST';
  isReadOnlyPost?: boolean;
  primaryName?: string;
  secondaryName?: string;
  primary: () => Promise<T>;
  secondary: () => Promise<T>;
  validate?: (data: T) => boolean;
}

import { LEGACY_ONLY, SCRAPLING_COHORTS } from '../config.js';

export class FallbackError extends Error {
  constructor(message: string, public readonly primaryError: Error, public readonly secondaryError: Error) {
    super(message);
    this.name = 'FallbackError';
  }
}

export async function route<T>(options: RouteOptions<T>): Promise<T> {
  const diag = routingDiagnostics.getStore();
  const primaryName = options.primaryName || 'scrapling';
  const secondaryName = options.secondaryName || 'legacy';
  
  let effectiveMode = diag?.forceMode || options.mode || 'legacy-only';
  
  if (options.adapter && !diag?.forceMode && !options.mode) {
    effectiveMode = SCRAPLING_COHORTS.includes(options.adapter) ? 'scrapling-first' : 'legacy-only';
  }
  
  if (LEGACY_ONLY) {
    effectiveMode = 'legacy-only';
  }

  if (diag) {
    diag.primaryEngine = effectiveMode === 'legacy-only' ? secondaryName : primaryName;
  }

  if (effectiveMode === 'legacy-only') {
    try {
      const res = await options.secondary();
      if (diag) diag.finalEngine = secondaryName;
      return res;
    } catch (err: any) {
      if (diag) {
        diag.finalEngine = 'none';
        diag.fallbackReason = err.message;
        diag.failureClass = extractBlockKind(err instanceof Error ? err : new Error(String(err)));
      }
      throw err;
    }
  }

  let primaryResult: T;
  let primaryError: Error;
  
  try {
    primaryResult = await options.primary();
    
    if (options.validate) {
      if (!options.validate(primaryResult)) {
        throw new Error('body validation failed');
      }
    }

    if (diag) diag.finalEngine = primaryName;
    return primaryResult;
  } catch (err: any) {
    primaryError = err instanceof Error ? err : new Error(String(err));
    if (diag) diag.fallbackReason = primaryError.message;
    
    // Evaluate if eligible for fallback
    
    if (primaryError.name === 'AbortError') {
      if (diag) { diag.finalEngine = 'none'; diag.failureClass = extractBlockKind(primaryError); }
      throw primaryError;
    }
    
    if (options.method === 'POST' && !options.isReadOnlyPost) {
      if (diag) { diag.finalEngine = 'none'; diag.failureClass = extractBlockKind(primaryError); }
      throw primaryError;
    }
    
    if (primaryError instanceof BlockError) {
      if (primaryError.kind === 'rate_limited') {
        if (diag) { diag.finalEngine = 'none'; diag.failureClass = 'rate_limited'; }
        throw primaryError;
      }
    } else {
      // Configuration errors like 404/400/410 should not fall back
      if (primaryError.message.match(/^(404|400|410|401)\b/)) {
        if (diag) { diag.finalEngine = 'none'; diag.failureClass = extractBlockKind(primaryError); }
        throw primaryError;
      }
    }
  }

  // Fallback
  try {
    const res = await options.secondary();
    if (diag) diag.finalEngine = secondaryName;
    return res;
  } catch (secondaryErr: any) {
    const error2 = secondaryErr instanceof Error ? secondaryErr : new Error(String(secondaryErr));
    // The FallbackError preserves both causes
    const combined = new FallbackError(`Both primary and secondary failed. Primary: ${primaryError.message}. Secondary: ${error2.message}`, primaryError, error2);
    if (diag) {
      diag.finalEngine = 'none';
      diag.failureClass = extractBlockKind(combined) || 'error';
    }
    // Note: tests expect secondary error directly, but let's throw combined so both causes survive
    throw combined;
  }
}

import type { BlockKind } from './block.js';

export function extractBlockKind(err: Error): BlockKind | undefined {
  if (err instanceof BlockError) return err.kind;
  if (err instanceof FallbackError) {
    const isAuthFail = (e: Error) => !(e instanceof BlockError) && !!e.message.match(/^(404|400|410|401)\b/);
    if (isAuthFail(err.primaryError) || isAuthFail(err.secondaryError)) {
      return undefined;
    }
    if (err.primaryError instanceof BlockError) return err.primaryError.kind;
    if (err.secondaryError instanceof BlockError) return err.secondaryError.kind;
  }
  return undefined;
}
