import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CrossmintAuthProvider,
  CrossmintPaymentMethodManagement,
  CrossmintProvider,
  OrderIntentVerification,
  useCrossmint,
  useCrossmintAuth,
  type OrderIntentVerificationProps,
} from '@crossmint/client-sdk-react-ui';

/**
 * フェーズB で本人が1回だけ開くページ。カード番号はこのページにも裏側のサーバーにも表示・保存しない
 * （カードの入力は Crossmint の iframe、支払い時のカード番号は裏側のサーバーが Stripe Checkout に直接入れる）。
 */
interface Config {
  env: 'staging' | 'production';
  clientApiKey: string;
  plan: { name: string; priceUsd: string; credits: number };
  merchant: { name: string; url: string; countryCode: string };
  /** 独自 JWT のモード（CROSSMINT_AUTH=custom-jwt）のとき、サーバーが発行したカード利用者の JWT。サインインの画面は出さない */
  customJwt?: { jwt: string; subject: string; email: string };
}
interface Auth {
  jwt?: string;
  label: string | null;
  email: string;
  status: string;
  login?: () => void;
  logout?: () => void;
}
type Rail = { rail: string; provider?: string; status: string; error?: { code: string } };
interface OiView {
  orderIntent: OrderIntentVerificationProps['orderIntent'] & { orderIntentId: string; rails: Rail[]; amount: { available: string } };
  selectedRail: Rail | null;
  needsVerification: Rail | null;
}

async function call<T>(path: string, jwt: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data, null, 2));
  return data as T;
}

function CrossmintAuthFlow({ config }: { config: Config }) {
  const { login, logout, jwt, user, status } = useCrossmintAuth();
  const email = user?.email ?? 'buyer@example.com';
  return <Flow config={config} auth={{ jwt, label: user?.email ?? user?.id ?? null, email, status, login: () => login(), logout: () => void logout() }} />;
}

function CustomJwtFlow({ config }: { config: Config }) {
  const { setJwt } = useCrossmint();
  const c = config.customJwt!;
  useEffect(() => setJwt(c.jwt), [c.jwt, setJwt]);
  return <Flow config={config} auth={{ jwt: c.jwt, label: `${c.subject}（独自 JWT）`, email: c.email, status: 'logged-in' }} />;
}

function Flow({ config, auth }: { config: Config; auth: Auth }) {
  const { login, logout, jwt, status } = auth;
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [rails, setRails] = useState<Rail[] | null>(null);
  const [oi, setOi] = useState<OiView | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onCardSaved = (pm: { paymentMethodId: string }) =>
    guard(async () => {
      setPaymentMethodId(pm.paymentMethodId);
      const r = await call<{ rails: Rail[] }>('/api/register-card', jwt!, { paymentMethodId: pm.paymentMethodId, email: auth.email });
      setRails(r.rails);
    });

  const createOi = () =>
    guard(async () => {
      const r = await call<OiView>('/api/order-intents', jwt!, { paymentMethodId });
      setOi(r);
      setVerifying(!!r.needsVerification);
    });

  const refreshOi = async () => {
    for (let i = 0; i < 20; i++) {
      const r = await call<OiView>(`/api/order-intents/${oi!.orderIntent.orderIntentId}`, jwt!);
      setOi(r);
      if (r.selectedRail) return;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  };

  const purchase = () =>
    guard(async () => {
      const r = await call<{ entry: unknown }>('/api/purchase', jwt!, { orderIntentId: oi!.orderIntent.orderIntentId, email: auth.email });
      setResult(r.entry);
    });

  return (
    <>
      <h1>Crossmint エージェントカード：Nevermined プランの購入</h1>
      <p>
        環境: <b>{config.env}</b> ／ 購入するもの: 実証1の Nevermined プラン <b>{config.plan.name}</b>（${config.plan.priceUsd}・{config.plan.credits} クレジット）を1回 ／ 加盟店:{' '}
        {config.merchant.name}
      </p>

      <section className={jwt ? 'done' : ''}>
        <h2>1. サインイン</h2>
        {status === 'logged-in' ? (
          <p>
            {auth.label} でサインイン中 {logout && <button onClick={() => logout()}>サインアウト</button>}
          </p>
        ) : (
          <button onClick={() => login?.()} disabled={status === 'initializing'}>
            Crossmint にサインイン（メールのワンタイムコード）
          </button>
        )}
      </section>

      {jwt && (
        <section className={paymentMethodId ? 'done' : ''}>
          <h2>2. カードを登録</h2>
          {config.env === 'staging' && (
            <p>
              staging では実カードは使えない。<b>4000 0566 5566 5556</b>（有効期限は未来の任意の月、CVC は任意の3桁）を入れる。
              このカードの1回限りの番号は Stripe のテストモードで通る（docs/phase0.md）。
            </p>
          )}
          {paymentMethodId ? (
            <p>
              登録済み: {paymentMethodId}
              {rails && <pre>{JSON.stringify(rails, null, 2)}</pre>}
            </p>
          ) : (
            <CrossmintPaymentMethodManagement jwt={jwt} onPaymentMethodSelected={onCardSaved} />
          )}
        </section>
      )}

      {paymentMethodId && rails && (
        <section className={oi?.selectedRail ? 'done' : ''}>
          <h2>3. 利用枠（order intent）を承認</h2>
          <p>
            上限 ${config.plan.priceUsd}・加盟店 {config.merchant.name}・有効期限 2時間 の order intent を作り、passkey で承認する。
          </p>
          {!oi && (
            <button onClick={createOi} disabled={busy}>
              order intent を作成して承認へ進む
            </button>
          )}
          {oi && verifying && oi.needsVerification && (
            <OrderIntentVerification
              orderIntent={oi.orderIntent}
              displayName="poc-crossmint-buyer"
              onVerificationComplete={() => {
                setVerifying(false);
                void guard(refreshOi);
              }}
              onVerificationError={(e) => {
                setVerifying(false);
                setError(`承認に失敗: ${String((e as Error)?.message ?? e)}`);
              }}
            />
          )}
          {oi && (
            <pre>
              {JSON.stringify(
                { orderIntentId: oi.orderIntent.orderIntentId, available: oi.orderIntent.amount.available, rails: oi.orderIntent.rails, selectedRail: oi.selectedRail },
                null,
                2,
              )}
            </pre>
          )}
          {oi && !oi.selectedRail && !verifying && (
            <button onClick={() => guard(refreshOi)} disabled={busy}>
              状態を再取得
            </button>
          )}
        </section>
      )}

      {oi?.selectedRail && (
        <section>
          <h2>4. 購入を実行</h2>
          <p>裏側でカード番号（{oi.selectedRail.rail}）を ${config.plan.priceUsd} 分だけ取得し、Nevermined の Stripe Checkout で1回支払う。</p>
          {!result && (
            <button onClick={purchase} disabled={busy}>
              {busy ? '購入中…（最大5分）' : '購入を実行'}
            </button>
          )}
          {result !== null && <pre>{JSON.stringify(result, null, 2)}</pre>}
        </section>
      )}

      {error && <pre className="err">{error}</pre>}
    </>
  );
}

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => {
    fetch('/api/config').then((r) => r.json()).then(setConfig);
  }, []);
  if (!config) return <p>読み込み中…</p>;
  return (
    <CrossmintProvider apiKey={config.clientApiKey}>
      {config.customJwt ? (
        <CustomJwtFlow config={config} />
      ) : (
        <CrossmintAuthProvider loginMethods={['email']}>
          <CrossmintAuthFlow config={config} />
        </CrossmintAuthProvider>
      )}
    </CrossmintProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
