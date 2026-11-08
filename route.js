import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// ============================================================================
// Configuration - toutes les cles sont OPTIONNELLES et lues cote SERVEUR.
// Aucune cle n'est jamais exposee au frontend.
// ============================================================================
const CONFIG = {
  solanaRpc: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  baseRpc: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  alchemyBase: process.env.ALCHEMY_BASE_API_KEY || '',
  emergentKey: process.env.EMERGENT_LLM_KEY || '',
  emergentModel: process.env.EMERGENT_MODEL || 'gpt-4o-mini',
  coingecko: 'https://api.coingecko.com/api/v3',
  dexscreener: 'https://api.dexscreener.com/latest/dex'
}

// ============================================================================
// Validation des adresses
// ============================================================================
function isSolanaAddress(a) { return typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) }
function isEvmAddress(a) { return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a) }

// ============================================================================
// Solana RPC (JSON-RPC brut, sans SDK)
// ============================================================================
async function solanaRpc(method, params) {
  const res = await fetch(CONFIG.solanaRpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store'
  })
  if (!res.ok) throw new Error(`Solana RPC ${res.status}`)
  const j = await res.json()
  if (j.error) throw new Error(j.error.message || 'Solana RPC error')
  return j.result
}

async function getSolanaBalances(owner) {
  const balances = []
  const [lamports, tokenAccounts] = await Promise.all([
    solanaRpc('getBalance', [owner, { commitment: 'confirmed' }]).catch(() => ({ value: 0 })),
    solanaRpc('getTokenAccountsByOwner', [owner, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] }))
  ])
  const sol = (lamports.value || 0) / 1_000_000_000
  if (sol > 0) balances.push({ mint: 'native', amount: sol, decimals: 9 })
  for (const a of (tokenAccounts.value || [])) {
    const info = a.account?.data?.parsed?.info
    const amt = Number(info?.tokenAmount?.uiAmount ?? 0)
    if (amt > 0) balances.push({ mint: info.mint, amount: amt, decimals: info.tokenAmount.decimals })
  }
  // Token-2022
  try {
    const t22 = await solanaRpc('getTokenAccountsByOwner', [owner, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
    for (const a of (t22.value || [])) {
      const info = a.account?.data?.parsed?.info
      const amt = Number(info?.tokenAmount?.uiAmount ?? 0)
      if (amt > 0) balances.push({ mint: info.mint, amount: amt, decimals: info.tokenAmount.decimals })
    }
  } catch {}
  return balances
}

// ============================================================================
// Base (EVM) RPC + Alchemy optionnel
// ============================================================================
async function evmRpc(url, method, params, tries = 4) {
  let lastErr = null
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        cache: 'no-store'
      })
      if (!res.ok) {
        const err = new Error(`EVM RPC ${res.status}`)
        err.rateLimited = res.status === 429
        throw err
      }
      const j = await res.json()
      if (j.error) throw new Error(j.error.message || 'EVM RPC error')
      return j.result
    } catch (e) {
      lastErr = e
      // Retry uniquement sur rate-limit, avec backoff exponentiel
      if (e.rateLimited && i < tries - 1) { await new Promise(r => setTimeout(r, 600 * Math.pow(2, i))); continue }
      throw e
    }
  }
  throw lastErr
}

async function getBaseNative(addr) {
  const hex = await evmRpc(CONFIG.baseRpc, 'eth_getBalance', [addr, 'latest'])
  const wei = BigInt(hex)
  return Number(wei) / 1e18
}

async function getBaseErc20ViaAlchemy(addr) {
  if (!CONFIG.alchemyBase) return []
  const url = `https://base-mainnet.g.alchemy.com/v2/${CONFIG.alchemyBase}`
  const listKey = `erc20:base:${addr.toLowerCase()}`
  const staleKey = `erc20stale:base:${addr.toLowerCase()}`
  const cachedList = cacheGet(listKey)
  if (cachedList) return cachedList
  try {
    // 1. Soldes avec pagination (max 3 pages = 300 tokens)
    let tokens = []
    let pageKey = null
    for (let page = 0; page < 3; page++) {
      const params = pageKey ? [addr, 'erc20', { pageKey }] : [addr, 'erc20']
      const balRes = await evmRpc(url, 'alchemy_getTokenBalances', params)
      tokens.push(...(balRes?.tokenBalances || []).filter(t => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x'))
      pageKey = balRes?.pageKey || null
      if (!pageKey) break
    }
    tokens = tokens.slice(0, 300)

    // 2. Metadonnees par lots de 8 (evite les 429 Alchemy) + cache 24h + retry
    const out = []
    for (let i = 0; i < tokens.length; i += 8) {
      const part = await Promise.all(tokens.slice(i, i + 8).map(async (t) => {
        try {
          const meta = await alchemyMetaCached(url, t.contractAddress)
          const decimals = meta?.decimals ?? 18
          const raw = BigInt(t.tokenBalance)
          const amt = Number(raw) / Math.pow(10, decimals)
          if (amt <= 0) return null
          return { contract: t.contractAddress.toLowerCase(), amount: amt, decimals, symbol: meta?.symbol || null, name: meta?.name || null, logo: meta?.logo || null }
        } catch (e) {
          console.error('[alchemy] metadata perdue pour', t.contractAddress, e.message)
          return null
        }
      }))
      out.push(...part.filter(Boolean))
    }
    cacheSet(listKey, out, 55 * 1000) // lisse portfolio + comparateur + auto-refresh 60s
    cacheSet(staleKey, out, 24 * 60 * 60 * 1000) // copie de secours longue duree
    return out
  } catch (err) {
    console.error('[alchemy] erreur:', err.message)
    // Fallback : derniere liste connue plutot que de faire disparaitre les tokens
    const stale = cacheGet(staleKey)
    if (stale) {
      console.warn('[alchemy] utilisation de la copie de secours pour', addr)
      return stale
    }
    return []
  }
}

// Metadonnees de contrat immuables -> cache 24h + 3 tentatives avec backoff
async function alchemyMetaCached(url, contract) {
  const ck = `meta:base:${contract.toLowerCase()}`
  const cached = cacheGet(ck)
  if (cached) return cached
  let lastErr = null
  for (let i = 0; i < 3; i++) {
    try {
      const meta = await evmRpc(url, 'alchemy_getTokenMetadata', [contract])
      cacheSet(ck, meta || {}, 24 * 60 * 60 * 1000)
      return meta || {}
    } catch (e) {
      lastErr = e
      if (i < 2) await new Promise(r => setTimeout(r, 350 * (i + 1)))
    }
  }
  throw lastErr
}

// ============================================================================
// DexScreener (prix, liquidite, volume - gratuit sans cle)
// ============================================================================
const NATIVE_PROXY = {
  solana: 'So11111111111111111111111111111111111111112', // wSOL
  base: '0x4200000000000000000000000000000000000006' // wETH sur Base
}

function shapeDexPair(best) {
  return {
    symbol: best.baseToken?.symbol || null,
    name: best.baseToken?.name || null,
    priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
    priceChange24h: best.priceChange?.h24 ?? null,
    priceChange1h: best.priceChange?.h1 ?? null,
    liquidityUsd: best.liquidity?.usd ?? null,
    volume24hUsd: best.volume?.h24 ?? null,
    fdvUsd: best.fdv ?? null,
    marketCapUsd: best.marketCap ?? null,
    logo: best.info?.imageUrl || null,
    dexUrl: best.url || null
  }
}

async function getDexData(chain, address) {
  const addr = address === 'native' ? NATIVE_PROXY[chain] : address
  try {
    const res = await fetch(`${CONFIG.dexscreener}/tokens/${addr}`, { cache: 'no-store' })
    if (!res.ok) return null
    const j = await res.json()
    const pairs = (j.pairs || []).filter(p => (chain === 'solana' && p.chainId === 'solana') || (chain === 'base' && p.chainId === 'base'))
    if (pairs.length === 0) return null
    const best = pairs.sort((a,b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
    return shapeDexPair(best)
  } catch { return null }
}

// Prix groupes : jusqu'a 30 adresses par appel DexScreener (evite le rate-limit
// qui rendait des prix null -> tokens masques a tort par le filtre poussiere)
async function getDexDataBatch(chain, addresses) {
  const map = new Map()
  const uniq = [...new Set(addresses)]
  const chunks = []
  for (let i = 0; i < uniq.length; i += 30) chunks.push(uniq.slice(i, i + 30))
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const res = await fetch(`${CONFIG.dexscreener}/tokens/${chunk.join(',')}`, { cache: 'no-store' })
      if (!res.ok) return
      const j = await res.json()
      const byToken = new Map()
      for (const p of (j.pairs || [])) {
        if ((chain === 'solana' && p.chainId !== 'solana') || (chain === 'base' && p.chainId !== 'base')) continue
        let key = p.baseToken?.address || ''
        if (!key) continue
        if (chain === 'base') key = key.toLowerCase()
        const arr = byToken.get(key) || []
        arr.push(p)
        byToken.set(key, arr)
      }
      for (const [key, pairs] of byToken) {
        const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
        map.set(key, shapeDexPair(best))
      }
    } catch {}
  }))
  return map
}

// ============================================================================
// CoinGecko (prix natifs SOL/ETH - gratuit sans cle)
// ============================================================================
async function getNativePrices() {
  const cached = cacheGet('nativePrices')
  if (cached) return cached
  try {
    const res = await fetch(`${CONFIG.coingecko}/simple/price?ids=solana,ethereum&vs_currencies=usd&include_24hr_change=true`, { cache: 'no-store' })
    if (!res.ok) return {}
    const data = await res.json()
    if (data && (data.solana || data.ethereum)) cacheSet('nativePrices', data, NATIVE_PRICE_TTL_MS)
    return data
  } catch { return {} }
}

// ============================================================================
// Construction du portefeuille
// ============================================================================
const NATIVE_META = {
  solana: { symbol: 'SOL', name: 'Solana', logo: 'https://assets.coingecko.com/coins/images/4128/small/solana.png' },
  base: { symbol: 'ETH', name: 'Ethereum (Base)', logo: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png' }
}

async function buildPortfolio({ solana = [], base = [], costBasis = {}, dustThreshold = DEFAULT_DUST_USD }) {
  const solanaValid = solana.filter(isSolanaAddress).slice(0, 5)
  const baseValid = base.filter(isEvmAddress).slice(0, 5)

  // 1. Recuperer les soldes bruts par chaine
  const solRaw = new Map()
  const baseRaw = new Map()

  await Promise.all([
    ...solanaValid.map(async (addr) => {
      try {
        const bals = await getSolanaBalances(addr)
        for (const b of bals) {
          const k = b.mint
          const ex = solRaw.get(k)
          if (ex) ex.amount += b.amount
          else solRaw.set(k, { chain: 'solana', address: b.mint, amount: b.amount, decimals: b.decimals })
        }
      } catch (e) { console.error('[solana]', addr, e.message) }
    }),
    ...baseValid.map(async (addr) => {
      try {
        const n = await getBaseNative(addr)
        if (n > 0) {
          const ex = baseRaw.get('native')
          if (ex) ex.amount += n
          else baseRaw.set('native', { chain: 'base', address: 'native', amount: n, decimals: 18 })
        }
        const erc20 = await getBaseErc20ViaAlchemy(addr)
        for (const t of erc20) {
          const k = t.contract
          const ex = baseRaw.get(k)
          if (ex) ex.amount += t.amount
          else baseRaw.set(k, { chain: 'base', address: k, amount: t.amount, decimals: t.decimals, symbol: t.symbol, name: t.name, logo: t.logo })
        }
      } catch (e) { console.error('[base]', addr, e.message) }
    })
  ])

  const raw = [...solRaw.values(), ...baseRaw.values()]

  // 2. Prix natifs SOL/ETH via CoinGecko
  const nativePrices = await getNativePrices()

  // 3. Enrichir chaque token avec DexScreener (appels groupes par 30)
  const addrFor = (r) => r.address === 'native' ? NATIVE_PROXY[r.chain] : r.address
  const [solDex, baseDex] = await Promise.all([
    getDexDataBatch('solana', raw.filter(r => r.chain === 'solana').map(addrFor)),
    getDexDataBatch('base', raw.filter(r => r.chain === 'base').map(r => addrFor(r).toLowerCase()))
  ])

  const positions = raw.map((r) => {
    const isNative = r.address === 'native'
    const meta = isNative ? NATIVE_META[r.chain] : null
    const dex = r.chain === 'solana' ? solDex.get(addrFor(r)) : baseDex.get(addrFor(r).toLowerCase())

    let priceUsd = dex?.priceUsd ?? null
    let priceChange24h = dex?.priceChange24h ?? null

    // Fallback prix natif via CoinGecko
    if (isNative && (priceUsd == null)) {
      const cgId = r.chain === 'solana' ? 'solana' : 'ethereum'
      priceUsd = nativePrices[cgId]?.usd ?? null
      priceChange24h = nativePrices[cgId]?.usd_24h_change ?? priceChange24h
    }

    // Pour les tokens natifs, on prefere meta (ETH, SOL) plutot que le proxy WETH/wSOL de DexScreener
    const symbol = meta?.symbol || dex?.symbol || r.symbol || r.address.slice(0, 4).toUpperCase()
    const name = meta?.name || dex?.name || r.name || 'Token inconnu'
    const logo = meta?.logo || dex?.logo || r.logo || null
    const valueUsd = priceUsd != null ? priceUsd * r.amount : null

    // PnL a partir du prix d'achat moyen fourni par l'utilisateur
    const cbKey = `${r.chain}:${r.address}`
    const avgBuyPrice = typeof costBasis[cbKey] === 'number' && costBasis[cbKey] > 0 ? costBasis[cbKey] : null
    const pnlUsd = avgBuyPrice != null && priceUsd != null ? (priceUsd - avgBuyPrice) * r.amount : null
    const pnlPct = avgBuyPrice != null && avgBuyPrice > 0 && priceUsd != null ? ((priceUsd - avgBuyPrice) / avgBuyPrice) * 100 : null

    return {
      chain: r.chain,
      address: r.address,
      symbol,
      name,
      logo,
      quantity: r.amount,
      decimals: r.decimals,
      priceUsd,
      priceChange24h,
      priceChange1h: dex?.priceChange1h ?? null,
      valueUsd,
      avgBuyPrice,
      pnlUsd,
      pnlPct,
      liquidityUsd: dex?.liquidityUsd ?? null,
      volume24hUsd: dex?.volume24hUsd ?? null,
      marketCapUsd: dex?.marketCapUsd ?? null,
      dexUrl: dex?.dexUrl ?? null,
      isNative
    }
  })

  const all = positions.filter(p => p.quantity > 0)
  // Filtre "poussiere" : les actifs valant moins de 5 centimes (ou sans prix
  // connu, donc valorises 0$) sont exclus du portefeuille et de tous les
  // calculs (total, PnL, allocation, IA, snapshots)
  const kept = all.filter(p => p.valueUsd != null && p.valueUsd >= dustThreshold)
  return {
    positions: kept.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)),
    dustHidden: all.length - kept.length
  }
}

const DEFAULT_DUST_USD = 0.05
// Seuil "poussiere" envoye par le client, borne pour rester raisonnable
function sanitizeDust(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DUST_USD
  return Math.min(n, 10000)
}

// ============================================================================
// Comparateur de wallets : soldes PAR wallet (non agreges) + prix dedupliques
// ============================================================================
async function buildComparison(wallets, dustThreshold = DEFAULT_DUST_USD) {
  // wallets: [{ chain: 'solana'|'base', address }] deja valides (max 10)

  // 1. Soldes bruts par wallet, en parallele
  const walletBalances = await Promise.all(wallets.map(async (w) => {
    try {
      if (w.chain === 'solana') {
        const bals = await getSolanaBalances(w.address)
        return bals.map(b => ({ chain: 'solana', tokenAddress: b.mint, amount: b.amount }))
      }
      const out = []
      const n = await getBaseNative(w.address).catch(() => 0)
      if (n > 0) out.push({ chain: 'base', tokenAddress: 'native', amount: n })
      const erc20 = await getBaseErc20ViaAlchemy(w.address)
      for (const t of erc20) out.push({ chain: 'base', tokenAddress: t.contract, amount: t.amount, symbol: t.symbol, name: t.name, logo: t.logo })
      return out
    } catch (e) {
      console.error('[compare]', w.chain, w.address, e.message)
      return []
    }
  }))

  // 2. Prix dedupliques sur l'ensemble des tokens rencontres
  const unique = new Map()
  for (const bals of walletBalances) {
    for (const b of bals) {
      const k = `${b.chain}:${b.tokenAddress}`
      if (!unique.has(k)) unique.set(k, b)
    }
  }
  const nativePrices = await getNativePrices()
  const uniqueList = [...unique.entries()]
  const dexAddr = (b) => b.tokenAddress === 'native' ? NATIVE_PROXY[b.chain] : b.tokenAddress
  const [solDex, baseDex] = await Promise.all([
    getDexDataBatch('solana', uniqueList.filter(([, b]) => b.chain === 'solana').map(([, b]) => dexAddr(b))),
    getDexDataBatch('base', uniqueList.filter(([, b]) => b.chain === 'base').map(([, b]) => dexAddr(b).toLowerCase()))
  ])
  const priceMap = new Map()
  for (const [k, b] of uniqueList) {
    const dex = b.chain === 'solana' ? solDex.get(dexAddr(b)) : baseDex.get(dexAddr(b).toLowerCase())
    let priceUsd = dex?.priceUsd ?? null
    let priceChange24h = dex?.priceChange24h ?? null
    if (b.tokenAddress === 'native' && priceUsd == null) {
      const cgId = b.chain === 'solana' ? 'solana' : 'ethereum'
      priceUsd = nativePrices[cgId]?.usd ?? null
      priceChange24h = nativePrices[cgId]?.usd_24h_change ?? priceChange24h
    }
    const isNative = b.tokenAddress === 'native'
    const symbol = isNative
      ? NATIVE_META[b.chain].symbol
      : (dex?.symbol || b.symbol || b.tokenAddress.slice(0, 4).toUpperCase())
    const logo = isNative ? NATIVE_META[b.chain].logo : (dex?.logo || b.logo || null)
    priceMap.set(k, { priceUsd, priceChange24h, symbol, logo })
  }

  // 3. Resume par wallet
  return wallets.map((w, i) => {
    const bals = walletBalances[i]
    let totalValueUsd = 0
    let change24hUsd = 0
    const toks = []
    for (const b of bals) {
      const pm = priceMap.get(`${b.chain}:${b.tokenAddress}`) || {}
      if (pm.priceUsd == null) continue
      const valueUsd = pm.priceUsd * b.amount
      if (valueUsd < dustThreshold) continue // ignore la poussiere (seuil reglable)
      totalValueUsd += valueUsd
      if (pm.priceChange24h != null) change24hUsd += valueUsd - valueUsd / (1 + pm.priceChange24h / 100)
      toks.push({ symbol: pm.symbol, logo: pm.logo, valueUsd, priceChange24h: pm.priceChange24h })
    }
    toks.sort((a, b) => b.valueUsd - a.valueUsd)
    const prevTotal = totalValueUsd - change24hUsd
    return {
      chain: w.chain,
      address: w.address,
      totalValueUsd,
      change24hUsd,
      change24hPct: prevTotal > 0 ? (change24hUsd / prevTotal) * 100 : 0,
      tokenCount: toks.length,
      topTokens: toks.slice(0, 4).map(t => ({ ...t, pct: totalValueUsd > 0 ? (t.valueUsd / totalValueUsd) * 100 : 0 }))
    }
  })
}

// ============================================================================
// Cache memoire simple pour les appels CoinGecko (protege le rate-limit gratuit)
// ============================================================================
const apiCache = new Map() // key -> { data, expires }
const SOCIAL_TTL_MS = 30 * 60 * 1000 // stats sociales : evoluent lentement
const HISTORY_TTL_MS = 10 * 60 * 1000 // historique 7j : granularite horaire
const NATIVE_PRICE_TTL_MS = 60 * 1000

function cacheGet(key) {
  const hit = apiCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data
  if (hit) apiCache.delete(key)
  return null
}

function cacheSet(key, data, ttl) {
  if (apiCache.size > 300) apiCache.clear()
  apiCache.set(key, { data, expires: Date.now() + ttl })
}

// ============================================================================
// Router
// ============================================================================
function routeOf(req, params) {
  const parts = params?.path || []
  return '/' + parts.join('/')
}

export async function GET(req, ctx) {
  const params = await ctx.params
  const route = routeOf(req, params)

  if (route === '/' || route === '/health') {
    return NextResponse.json({
      ok: true,
      service: 'ledger-room',
      time: new Date().toISOString(),
      alchemyEnabled: Boolean(CONFIG.alchemyBase)
    })
  }

  // ==========================================================================
  // 7d PRICE HISTORY via CoinGecko (gratuit, sans cle)
  // GET /api/token/history?chain=solana|base&address=native|<mint|contract>
  // ==========================================================================
  if (route === '/token/history') {
    try {
      const { searchParams } = new URL(req.url)
      const chain = searchParams.get('chain')
      const address = searchParams.get('address')
      if (!chain || !address) return NextResponse.json({ error: 'chain et address requis' }, { status: 400 })

      const histKey = `hist:${chain}:${address}`
      const cachedHist = cacheGet(histKey)
      if (cachedHist) return NextResponse.json({ ...cachedHist, cached: true })

      let url = null
      if (address === 'native') {
        const id = chain === 'solana' ? 'solana' : 'ethereum'
        url = `${CONFIG.coingecko}/coins/${id}/market_chart?vs_currency=usd&days=7`
      } else {
        // CoinGecko platform ids: base = "base", solana = "solana"
        const platform = chain === 'base' ? 'base' : 'solana'
        url = `${CONFIG.coingecko}/coins/${platform}/contract/${address}/market_chart?vs_currency=usd&days=7`
      }
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) {
        // Cache les 404 (token non reference) mais pas les 429 (rate-limit temporaire)
        const payload = { prices: [], source: 'none', reason: `coingecko ${res.status}` }
        if (res.status === 404) cacheSet(histKey, payload, HISTORY_TTL_MS)
        return NextResponse.json(payload)
      }
      const data = await res.json()
      const prices = (data.prices || []).map(([t, p]) => ({ t, p }))
      const payload = { prices, source: 'coingecko' }
      if (prices.length > 0) cacheSet(histKey, payload, HISTORY_TTL_MS)
      return NextResponse.json(payload)
    } catch (err) {
      console.error('[api/token/history]', err)
      return NextResponse.json({ prices: [], source: 'none', reason: err.message })
    }
  }

  // ==========================================================================
  // SOCIAL / SENTIMENT via CoinGecko (gratuit, sans cle, cache 5 min)
  // GET /api/token/social?chain=solana|base&address=native|<mint|contract>
  // ==========================================================================
  if (route === '/token/social') {
    try {
      const { searchParams } = new URL(req.url)
      const chain = searchParams.get('chain')
      const address = searchParams.get('address')
      if (!chain || !address) return NextResponse.json({ error: 'chain et address requis' }, { status: 400 })

      const cacheKey = `social:${chain}:${address}`
      const cached = cacheGet(cacheKey)
      if (cached) return NextResponse.json({ ...cached, cached: true })

      let url = null
      const qs = 'localization=false&tickers=false&market_data=false&community_data=true&developer_data=true&sparkline=false'
      if (address === 'native') {
        const id = chain === 'solana' ? 'solana' : 'ethereum'
        url = `${CONFIG.coingecko}/coins/${id}?${qs}`
      } else {
        const platform = chain === 'base' ? 'base' : 'solana'
        url = `${CONFIG.coingecko}/coins/${platform}/contract/${address}?${qs}`
      }

      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) {
        const payload = { found: false, rateLimited: res.status === 429, reason: `coingecko ${res.status}` }
        // Cache aussi les 404 pour eviter de re-marteler l'API (mais pas les 429)
        if (res.status === 404) cacheSet(cacheKey, payload, SOCIAL_TTL_MS)
        return NextResponse.json(payload)
      }

      const j = await res.json()
      const cd = j.community_data || {}
      const dd = j.developer_data || {}
      const links = j.links || {}
      const twitterHandle = links.twitter_screen_name || null
      const githubRepo = (links.repos_url?.github || []).filter(Boolean)[0] || null
      const subredditUrl = links.subreddit_url && links.subreddit_url !== 'https://www.reddit.com' ? links.subreddit_url : null

      const payload = {
        found: true,
        id: j.id || null,
        name: j.name || null,
        sentimentUp: j.sentiment_votes_up_percentage ?? null,
        sentimentDown: j.sentiment_votes_down_percentage ?? null,
        watchlistUsers: j.watchlist_portfolio_users ?? null,
        twitter: {
          followers: cd.twitter_followers ?? null,
          url: twitterHandle ? `https://x.com/${twitterHandle}` : null
        },
        reddit: {
          subscribers: cd.reddit_subscribers ?? null,
          active48h: cd.reddit_accounts_active_48h ?? null,
          posts48h: cd.reddit_average_posts_48h ?? null,
          comments48h: cd.reddit_average_comments_48h ?? null,
          url: subredditUrl
        },
        telegram: { users: cd.telegram_channel_user_count ?? null },
        github: {
          stars: dd.stars ?? null,
          forks: dd.forks ?? null,
          issues: dd.total_issues ?? null,
          prsMerged: dd.pull_requests_merged ?? null,
          commits4w: dd.commit_count_4_weeks ?? null,
          contributors: dd.pull_request_contributors ?? null,
          url: githubRepo
        }
      }
      cacheSet(cacheKey, payload, SOCIAL_TTL_MS)
      return NextResponse.json(payload)
    } catch (err) {
      console.error('[api/token/social]', err)
      return NextResponse.json({ found: false, reason: err.message })
    }
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export async function POST(req, ctx) {
  const params = await ctx.params
  const route = routeOf(req, params)

  if (route === '/portfolio') {
    try {
      const body = await req.json().catch(() => ({}))
      const addresses = body.addresses || {}
      const solana = Array.isArray(addresses.solana) ? addresses.solana : []
      const base = Array.isArray(addresses.base) ? addresses.base : []
      if (solana.length === 0 && base.length === 0) {
        return NextResponse.json({ error: 'Aucune adresse fournie.' }, { status: 400 })
      }
      const dustThreshold = sanitizeDust(body.dustThresholdUsd)
      const { positions, dustHidden } = await buildPortfolio({ solana, base, costBasis: body.costBasis || {}, dustThreshold })
      return NextResponse.json({
        positions,
        fetchedAt: Date.now(),
        meta: {
          dustHidden,
          dustThresholdUsd: dustThreshold,
          alchemyEnabled: Boolean(CONFIG.alchemyBase),
          aiEnabled: Boolean(CONFIG.emergentKey),
          alchemyNote: CONFIG.alchemyBase ? null : 'Configure ALCHEMY_BASE_API_KEY pour detecter tous les tokens ERC20 sur Base.'
        }
      })
    } catch (err) {
      console.error('[api/portfolio]', err)
      return NextResponse.json({ error: err.message || 'Erreur serveur' }, { status: 500 })
    }
  }

  // ==========================================================================
  // COMPARATEUR DE WALLETS
  // POST /api/portfolio/compare  body: { wallets: [{ chain, address }] }
  // ==========================================================================
  if (route === '/portfolio/compare') {
    try {
      const body = await req.json().catch(() => ({}))
      const rawWallets = Array.isArray(body.wallets) ? body.wallets : []
      const wallets = rawWallets
        .filter(w => w && (
          (w.chain === 'solana' && isSolanaAddress(w.address)) ||
          (w.chain === 'base' && isEvmAddress(w.address))
        ))
        .slice(0, 10)
      if (wallets.length < 2) {
        return NextResponse.json({ error: 'Au moins 2 wallets valides sont requis pour comparer.' }, { status: 400 })
      }
      const comparison = await buildComparison(wallets, sanitizeDust(body.dustThresholdUsd))
      return NextResponse.json({ wallets: comparison, fetchedAt: Date.now() })
    } catch (err) {
      console.error('[api/portfolio/compare]', err)
      return NextResponse.json({ error: err.message || 'Erreur serveur' }, { status: 500 })
    }
  }

  if (route === '/ai/advice') {
    try {
      if (!CONFIG.emergentKey) {
        return NextResponse.json({ error: 'LLM key not configured' }, { status: 503 })
      }
      const body = await req.json().catch(() => ({}))
      const t = body.token
      if (!t || !t.symbol) {
        return NextResponse.json({ error: 'Token invalide' }, { status: 400 })
      }

      const context = {
        symbol: t.symbol,
        name: t.name,
        chain: t.chain,
        priceUsd: t.priceUsd,
        priceChange24h: t.priceChange24h,
        priceChange1h: t.priceChange1h,
        liquidityUsd: t.liquidityUsd,
        volume24hUsd: t.volume24hUsd,
        marketCapUsd: t.marketCapUsd,
        quantity: t.quantity,
        valueUsd: t.valueUsd,
        avgBuyPrice: t.avgBuyPrice,
        pnlPct: t.pnlPct
      }

      const systemPrompt = `Tu es un analyste crypto senior qui donne des lectures pedagogiques et prudentes. Reponds UNIQUEMENT avec un JSON valide (pas de markdown, pas de texte autour).

Schema strict:
{
  "action": "RENFORCER" | "CONSERVER" | "VENDRE" | "ATTENDRE" | "EVITER",
  "confidence": entier 0-100,
  "risk": entier 0-100,
  "horizon": "court terme" | "moyen terme" | "long terme",
  "priceTarget": nombre ou null (en USD),
  "stopLoss": nombre ou null (en USD),
  "takeProfit": nombre ou null (en USD),
  "reasoning": [3 chaines courtes en francais, chacune 15-25 mots max]
}

Regles:
- Ne recommande RENFORCER que si liquidite > 100k USD et 24h stable (<15% de variation).
- Recommande PRENDRE_PROFIT ou VENDRE si pnlPct > 100 ou variation 24h > 40%.
- Recommande EVITER si liquidite < 10k USD (risque de rug).
- Cible et stopLoss doivent etre coherents avec priceUsd (stopLoss < prix < priceTarget si RENFORCER/CONSERVER).
- Ne devine jamais des chiffres absents; utilise null si donnee manquante.
- Reasoning : 3 phrases concretes basees sur les DONNEES fournies (cite les chiffres).
- Rappelle-toi : contenu educatif, jamais un conseil financier.`

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25_000)

      const llmRes = await fetch('https://integrations.emergentagent.com/llm/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.emergentKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: CONFIG.emergentModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Analyse ce token :\n' + JSON.stringify(context, null, 2) }
          ],
          temperature: 0.2,
          max_tokens: 600
        }),
        signal: controller.signal
      })
      clearTimeout(timeout)

      const raw = await llmRes.text()
      if (!llmRes.ok) {
        console.error('[ai/advice] LLM error', llmRes.status, raw.slice(0, 400))
        return NextResponse.json({ error: 'LLM provider error', status: llmRes.status }, { status: 502 })
      }

      const payload = JSON.parse(raw)
      const text = payload.choices?.[0]?.message?.content || ''

      // Extraire le JSON meme si entoure de markdown
      let jsonStr = text.trim()
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fenceMatch) jsonStr = fenceMatch[1].trim()
      const s = jsonStr.indexOf('{')
      const e = jsonStr.lastIndexOf('}')
      if (s < 0 || e < 0) {
        return NextResponse.json({ error: 'Reponse LLM invalide', raw: text.slice(0, 300) }, { status: 502 })
      }
      const advice = JSON.parse(jsonStr.slice(s, e + 1))

      // Validation minimale
      const validActions = ['RENFORCER', 'CONSERVER', 'VENDRE', 'ATTENDRE', 'EVITER']
      if (!validActions.includes(advice.action)) advice.action = 'ATTENDRE'
      if (typeof advice.confidence !== 'number') advice.confidence = 50
      if (!Array.isArray(advice.reasoning)) advice.reasoning = ['Analyse incomplete']

      return NextResponse.json({ advice, model: CONFIG.emergentModel, generatedAt: Date.now() })
    } catch (err) {
      if (err?.name === 'AbortError') {
        return NextResponse.json({ error: 'LLM timeout' }, { status: 504 })
      }
      console.error('[api/ai/advice]', err)
      return NextResponse.json({ error: err.message || 'Erreur serveur' }, { status: 500 })
    }
  }

  // ==========================================================================
  // GLOBAL PORTFOLIO ANALYSIS via Emergent LLM
  // ==========================================================================
  if (route === '/ai/portfolio') {
    try {
      if (!CONFIG.emergentKey) return NextResponse.json({ error: 'LLM key not configured' }, { status: 503 })
      const body = await req.json().catch(() => ({}))
      const positions = Array.isArray(body.positions) ? body.positions : []
      if (positions.length === 0) return NextResponse.json({ error: 'Aucune position fournie' }, { status: 400 })

      const total = positions.reduce((s, p) => s + (p.valueUsd || 0), 0)
      const compact = positions.slice(0, 20).map(p => ({
        symbol: p.symbol,
        chain: p.chain,
        valueUsd: p.valueUsd,
        pct: total > 0 && p.valueUsd != null ? +((p.valueUsd / total) * 100).toFixed(2) : null,
        priceChange24h: p.priceChange24h,
        liquidityUsd: p.liquidityUsd,
        marketCapUsd: p.marketCapUsd,
        pnlPct: p.pnlPct
      }))
      const chains = [...new Set(positions.map(p => p.chain))]

      const systemPrompt = `Tu es un analyste crypto senior. Tu produis un diagnostic global de portefeuille en francais.
Reponds UNIQUEMENT avec un JSON valide (pas de markdown, pas de texte autour).

Schema strict:
{
  "overallScore": entier 0-100 (sante globale du portefeuille),
  "diversificationScore": entier 0-100,
  "riskScore": entier 0-100 (100 = tres risque),
  "concentrationRisk": "faible" | "moyenne" | "elevee",
  "topAsset": symbole du plus gros holding,
  "topAssetPct": pourcentage 0-100,
  "strengths": [3 chaines courtes en francais, chiffres cites],
  "risks": [3 chaines courtes en francais, chiffres cites],
  "recommendations": [3 actions concretes en francais, verbes a l'infinitif]
}

Regles:
- Base ton analyse UNIQUEMENT sur les chiffres fournis.
- Un portefeuille tres concentre (>60% dans 1 actif) = concentrationRisk "elevee".
- Peu de liquidite ou beaucoup de tokens < 10k USD de liquidite = risque eleve.
- Cite des pourcentages / montants precis dans strengths & risks.
- Contenu educatif, jamais un conseil financier personnalise.`

      const userPayload = { valeurTotaleUsd: total, nombreDePositions: positions.length, chaines: chains, positions: compact }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25_000)
      const llmRes = await fetch('https://integrations.emergentagent.com/llm/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CONFIG.emergentKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CONFIG.emergentModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Analyse ce portefeuille :\n' + JSON.stringify(userPayload, null, 2) }
          ],
          temperature: 0.2,
          max_tokens: 800
        }),
        signal: controller.signal
      })
      clearTimeout(timeout)

      const raw = await llmRes.text()
      if (!llmRes.ok) return NextResponse.json({ error: 'LLM provider error', status: llmRes.status }, { status: 502 })
      const payload = JSON.parse(raw)
      const text = payload.choices?.[0]?.message?.content || ''
      let jsonStr = text.trim()
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fenceMatch) jsonStr = fenceMatch[1].trim()
      const s = jsonStr.indexOf('{'), e = jsonStr.lastIndexOf('}')
      if (s < 0 || e < 0) return NextResponse.json({ error: 'Reponse LLM invalide' }, { status: 502 })
      const analysis = JSON.parse(jsonStr.slice(s, e + 1))
      return NextResponse.json({ analysis, model: CONFIG.emergentModel, generatedAt: Date.now() })
    } catch (err) {
      if (err?.name === 'AbortError') return NextResponse.json({ error: 'LLM timeout' }, { status: 504 })
      console.error('[api/ai/portfolio]', err)
      return NextResponse.json({ error: err.message || 'Erreur serveur' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
