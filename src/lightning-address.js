// A BIES Lightning address forwards the provider's original LNURL-pay metadata.
// The callback then issues an invoice directly to the corresponding Satlantis wallet.
const app = 'https://app.buildinelsalvador.com/.well-known/nostr.json';
const publicDomain = 'buildinelsalvador.com';
const providerHosts = new Set(['satlantis.io', 'www.satlantis.io', 'api.satlantis.io']);
const localPart = /^[a-z0-9._-]{1,64}$/;
function answer(value, status = 200) {
  return Response.json(value, { status, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
function unavailable() { return answer({ status: 'ERROR', reason: 'Lightning address unavailable' }, 404); }

export async function lightningAddress(request, env) {
  if (request.method !== 'GET') return answer({ status: 'ERROR', reason: 'Use GET' }, 405);
  const name = new URL(request.url).pathname.slice('/.well-known/lnurlp/'.length);
  if (!localPart.test(name)) return unavailable();
  try {
    // Provisioned by the domain operator from a verified live wallet, never a profile payment field.
    const entry = await env.SITE.get('lightning:alias:' + name, 'json');
    if (!entry || !/^[0-9a-f]{64}$/.test(entry.pubkey) ||
        typeof entry.address !== 'string' || !/^[a-z0-9._-]{1,64}@satlantis\.io$/.test(entry.address)) return unavailable();
    const options = { redirect: 'manual', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) };
    const owner = await fetch(app + '?name=' + encodeURIComponent(name), options);
    if (!owner.ok || (await owner.json()).names?.[name] !== entry.pubkey) return unavailable();
    let url = new URL('https://satlantis.io/.well-known/lnurlp/' + entry.address.split('@')[0]);
    let upstream = await fetch(url.href, options);
    for (let hops = 0; hops < 2 && [301, 302, 307, 308].includes(upstream.status); hops++) {
      const location = upstream.headers.get('Location');
      if (!location) return unavailable();
      url = new URL(location, url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !providerHosts.has(url.hostname)) return unavailable();
      upstream = await fetch(url.href, options);
    }
    if (!upstream.ok) return unavailable();
    const data = await upstream.json();
    const callback = new URL(data.callback);
    if (data.tag !== 'payRequest' || callback.protocol !== 'https:' || callback.username || callback.password ||
        !Number.isSafeInteger(data.minSendable) || data.minSendable <= 0 ||
        !Number.isSafeInteger(data.maxSendable) || data.maxSendable < data.minSendable) return unavailable();
    const metadata = JSON.parse(data.metadata);
    if (!Array.isArray(metadata) || !metadata.some(item => Array.isArray(item) && item[0] === 'text/plain') ||
        !metadata.some(item => Array.isArray(item) && ['text/identifier', 'text/email'].includes(item[0]) &&
          [entry.address, name + '@' + publicDomain].includes(item[1]))) return unavailable();
    // The provider commits to this metadata when creating its invoice. Preserve it byte for byte.
    return answer(data);
  } catch {
    return answer({ status: 'ERROR', reason: 'Lightning address temporarily unavailable' }, 503);
  }
}
