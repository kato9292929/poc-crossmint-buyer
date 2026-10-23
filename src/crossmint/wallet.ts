import { CrossmintWallets, EVMWallet, createCrossmint, type Wallet } from '@crossmint/wallets-sdk';
import type { ClientEvmSigner } from '@x402/evm';
import { crossmintEnv, evmChainFor, required, type CrossmintEnv } from '../config.ts';

/**
 * サーバー側エージェントウォレット（server agent wallet）。
 * 復旧手段（recovery）も署名者もバックエンドの CROSSMINT_SIGNER_SECRET だけで、人の承認（passkey・OTP）は要らない。
 * alias で取り出すので、アドレスを設定に持たなくてよい。
 */
export const WALLET_ALIAS = process.env.CROSSMINT_WALLET_ALIAS ?? 'poc-crossmint-buyer';

export interface AgentWallet {
  env: CrossmintEnv;
  chain: 'base' | 'base-sepolia';
  network: 'eip155:8453' | 'eip155:84532';
  wallet: Wallet<'base' | 'base-sepolia'>;
  address: `0x${string}`;
}

export function crossmintClient() {
  const apiKey = required('CROSSMINT_SERVER_API_KEY');
  const env = crossmintEnv(apiKey);
  const wallets = CrossmintWallets.from(createCrossmint({ apiKey }));
  return { env, wallets };
}

export async function getOrCreateAgentWallet(opts: { create?: boolean } = {}): Promise<AgentWallet> {
  const { env, wallets } = crossmintClient();
  const secret = required('CROSSMINT_SIGNER_SECRET');
  const { chain, network } = evmChainFor(env);
  let wallet: Wallet<typeof chain>;
  try {
    wallet = await wallets.getWallet(`evm:alias:${WALLET_ALIAS}`, { chain });
  } catch (e) {
    if (!opts.create) throw new Error(`ウォレット evm:alias:${WALLET_ALIAS} が取れない（npm run wallet:setup で作る）: ${(e as Error).message}`);
    wallet = await wallets.createWallet({ chain, recoveryMethods: [{ type: 'server', secret }], alias: WALLET_ALIAS });
  }
  await wallet.useSigner({ type: 'server', secret });
  return { env, chain, network, wallet, address: wallet.address as `0x${string}` };
}

/**
 * Crossmint の EVM ウォレットを x402 の ClientEvmSigner にする（ドキュメントの x402 の手順どおり）。
 * スマートウォレットなので、署名は ERC-1271／ERC-6492 の形で返る。
 */
export function x402SignerFrom(aw: AgentWallet): ClientEvmSigner {
  const evm = EVMWallet.from(aw.wallet);
  return {
    address: evm.address as `0x${string}`,
    async signTypedData(typedData) {
      const { signature } = await evm.signTypedData({ ...(typedData as Parameters<typeof evm.signTypedData>[0]), chain: aw.chain });
      return signature as `0x${string}`;
    },
  };
}
