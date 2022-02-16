import {
  ProxyConfigMap,
  ProxyConfigArray,
  ProxyConfigArrayItem,
} from 'webpack-dev-server';

import { ProxyEntry } from '@teambit/ui'



export function flattenProxyMap(proxies?: ProxyConfigMap | ProxyConfigArray): ProxyConfigArray {
  if (!proxies) return [];
  if (Array.isArray(proxies)) return proxies;

  return Object.entries(proxies).map(([path, value]) => {
    if (typeof value === 'string') return { path, context: value };

    return { path, ...value };
  });
}

export const proxyConfigToProxyEntry = (proxyConfig: ProxyConfigArrayItem): ProxyEntry => {
  const path = proxyConfig.path ?? [""];
  const context = (Array.isArray(path) ? path : [path]) // todo - use arrify
  return {...proxyConfig, context}
}
