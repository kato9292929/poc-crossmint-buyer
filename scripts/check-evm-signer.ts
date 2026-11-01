/**
 * Crossmint の EVM ウォレット（Base）が、検証できる EIP-712 の署名を返せるかを確かめる（資金は動かさない）。
 * 署名するのは USDC の送金許可ではなく、無害な確認用のメッセージ。検証は Base の RPC で viem の verifyTypedData（ERC-1271 / ERC-6492 対応）。
 *
 *   ALLOW_PRODUCTION=true npm run check:evm-signer
 */
import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { getOrCreateAgentWallet, x402SignerFrom } from '../src/crossmint/wallet.ts';

const aw = await getOrCreateAgentWallet();
const signer = x402SignerFrom(aw);
const chain = aw.chain === 'base' ? base : baseSepolia;
const typed = {
  // verifyingContract は SDK が必須にしている。USDC ではない無関係のアドレスにして、送金の許可として使えないようにする
  domain: { name: 'poc-crossmint-buyer signer check', version: '1', chainId: chain.id, verifyingContract: '0x000000000000000000000000000000000000dEaD' as const },
  types: { Check: [{ name: 'note', type: 'string' }, { name: 'at', type: 'uint256' }] },
  primaryType: 'Check' as const,
  message: { note: 'no funds are moved by this signature', at: BigInt(Math.floor(Date.now() / 1000)) },
};
const signature = await signer.signTypedData(typed as never);
const client = createPublicClient({ chain, transport: http() });
const valid = await client.verifyTypedData({ address: signer.address, signature, ...typed });
const code = await client.getCode({ address: signer.address });
console.log(JSON.stringify({ wallet: signer.address, chain: aw.chain, deployed: !!code && code !== '0x', signatureBytes: (signature.length - 2) / 2, erc6492: signature.endsWith('6492649264926492649264926492649264926492649264926492649264926492'), valid }, null, 2));
