/** JIN の有料エンドポイント（フェーズ0で 402 を確認した値。docs/phase0.md）。 */
export const JIN_ENDPOINTS = [
  { id: 'series', path: '/api/jin/series', priceUsd: '0.01' },
  { id: 'movers', path: '/api/jin/movers', priceUsd: '0.02' },
] as const;

export type JinEndpointId = (typeof JIN_ENDPOINTS)[number]['id'];
