// Winner Takes All — dip-reversion bot on the pump.fun replay (agent-fun/replay/v2).
//
// Idea: a bonding curve that ran up and then fell hard from its recent high tends to
// bounce part of the way back, while a curve that just keeps falling does not. So this
// bot buys a coin only after it has dropped 30-40% from its recent high AND has already
// recovered 5% from the dip low (a bounce, not a fall), only once the curve is old
// enough to have real flow behind it (300+ slots since creation) and big enough to
// trade (12+ SOL of real reserve), and then sells the whole position on a partial
// rebound (+30% on cost), on a stop (-9%), or when the trade goes stale (600 slots
// held). It buys in small tranches and adds while the dip holds near the first entry,
// so a false start costs little and a real bounce still gets size. One entry per coin
// over the whole run: re-entering the same coin after an exit lost money in grading,
// so a coin gets exactly one shot.
//
// Everything here is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O beyond stdin/stdout, iteration only over insertion-ordered maps
// and sorted mint lists, so the two graded executions produce byte-identical logs.
// The wire layer (hello / batch / done, replies) is implemented in this file so the
// entry is a single self-contained main.ts.

import { stdin, stdout } from 'node:process';

// ---------------------------------------------------------------- constants

const LAMPORTS = 1_000_000_000n;
const BPS = 10_000n;
/** Curve fee taken on every trade against the bonding curve (95 protocol + 30 creator). */
const CURVE_FEE_BPS = 125n;

// ---------------------------------------------------------------- parameters

const P = {
  /** Lookback (slots) for the recent high the drawdown is measured from. */
  highWindow: 2500,
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: 300,
  /** Enter when the price is at least this far below the recent high... */
  ddMin: 0.3,
  /** ...and not further than this (a collapse, not a dip). */
  ddMax: 0.4,
  /** The curve must hold at least this much real SOL at decision time. */
  minRealSol: 12,
  /** SOL per buy tranche (the harness's per-reply size cap applies too). */
  trancheSol: 0.1,
  /** Most SOL of cost in one position. */
  maxPosSol: 1.0,
  /** Smallest buy worth sending (one order costs 105k lamports in tx fees). */
  minBuySol: 0.01,
  /** Add a tranche only while the price stays within this of the first entry price. */
  addBand: 0.05,
  /** Sell when the position's liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: 0.3,
  /** Sell when it falls to cost * (1 - stopLoss). */
  stopLoss: 0.09,
  /** Sell after holding this many slots regardless. */
  maxHold: 600,
  /** After an exit, ignore the coin for this many slots. */
  cooldown: 300,
  /** Most entries per coin over the whole run (1 = one shot per coin, no re-entry). */
  maxEntries: 1,
  /** Most new entries per batch. */
  maxEntriesPerBatch: 2,
  /** Buy slippage (bps); sells go out wide so exits are never refused on price. */
  buySlipBps: 500,
  sellSlipBps: 3000,
  /** Exits are sent as this many equal sells in one reply. */
  sellSplits: 2,
  /**
   * Hybrid gate: 0 = buy the dip as soon as it is in band; >0 = also require the
   * price to have recovered this much from the dip low first (a bounce, not a fall).
   * Set to 5%: the dip alone is not enough, the curve must already be turning up.
   */
  recovery: 0.05,
};

// ---------------------------------------------------------------- wire types

type Pubkey = string;

interface Hello {
  type: 'hello';
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: { max_open_positions: number; max_order_bps_of_real_reserve: number; max_orders_per_batch: number };
  latency_slots: number;
  fees: { base_fee_lamports: string; priority_fee_lamports: string };
}

interface ChainEvent {
  event: 'TradeEvent' | 'CreateEvent' | 'CompleteEvent';
  mint: Pubkey;
  slot: number;
  is_buy?: boolean;
  sol_amount?: string;
  virtual_sol_reserves?: string;
  virtual_token_reserves?: string;
  real_sol_reserves?: string;
  real_token_reserves?: string;
  virtual_quote_reserves?: string;
}

interface Fill {
  client_id: string;
  mint: Pubkey;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
}

interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: { mint: Pubkey; slot: number; virtual_token_reserves: string; virtual_quote_reserves: string; real_token_reserves: string; real_quote_reserves: string }[];
  fills: Fill[];
  account: { cash_lamports: string; positions: { mint: Pubkey; token_amount: string; cost_lamports: string }[] };
}

type Order =
  | { side: 'buy'; client_id: string; mint: Pubkey; quote_lamports: string; max_slippage_bps: number }
  | { side: 'sell'; client_id: string; mint: Pubkey; token_amount: string; max_slippage_bps: number };

// ---------------------------------------------------------------- engine

interface Curve {
  mint: Pubkey;
  created: number | null;
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  slot: number;
  complete: boolean;
}

interface Pending {
  order: Order;
}

class Engine {
  hello: Hello;
  cash = 0n;
  positions = new Map<Pubkey, { tokens: bigint; cost: bigint }>();
  curves = new Map<Pubkey, Curve>();
  pending = new Map<string, Pending>();
  #nextId = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
  }

  txFee(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  clientId(): string {
    return `o${this.#nextId++}`;
  }

  /** The most this batch's buys on one mint may spend together (with a small margin). */
  buyCap(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.rq * BigInt(this.hello.caps.max_order_bps_of_real_reserve) * 97n) / (BPS * 100n);
  }

  /** Cash minus what pending orders will take if they fill. */
  freeCash(): bigint {
    let free = this.cash;
    const tx = this.txFee();
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === 'buy') free -= BigInt(p.order.quote_lamports);
    }
    return free;
  }

  committedCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
    return mints.size;
  }

  applyBatch(batch: Batch): void {
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.cash = BigInt(batch.account.cash_lamports);
    this.positions.clear();
    for (const p of batch.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) this.positions.set(p.mint, { tokens, cost: BigInt(p.cost_lamports) });
    }
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c === undefined || m.slot < c.slot) continue;
      c.vt = BigInt(m.virtual_token_reserves);
      c.vq = BigInt(m.virtual_quote_reserves);
      c.rt = BigInt(m.real_token_reserves);
      c.rq = BigInt(m.real_quote_reserves);
      c.slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const c: Curve = {
          mint: e.mint,
          created: e.slot,
          vq: BigInt(e.virtual_quote_reserves ?? '0'),
          vt: BigInt(e.virtual_token_reserves ?? '0'),
          rq: 0n,
          rt: BigInt(e.real_token_reserves ?? '0'),
          slot: e.slot,
          complete: false,
        };
        this.curves.set(e.mint, c);
      } else if (e.event === 'TradeEvent') {
        let c = this.curves.get(e.mint);
        if (c === undefined) {
          c = { mint: e.mint, created: null, vq: 0n, vt: 0n, rq: 0n, rt: 0n, slot: e.slot, complete: false };
          this.curves.set(e.mint, c);
        }
        c.vq = BigInt(e.virtual_quote_reserves ?? '0');
        c.vt = BigInt(e.virtual_token_reserves ?? '0');
        c.rq = BigInt(e.real_quote_reserves ?? '0');
        c.rt = BigInt(e.real_token_reserves ?? '0');
        c.slot = e.slot;
      } else {
        const c = this.curves.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }
  }

  record(orders: Order[]): void {
    for (const o of orders) this.pending.set(o.client_id, { order: o });
  }
}

// ---------------------------------------------------------------- strategy

interface Point {
  slot: number;
  price: number;
  buy: boolean;
  sol: number;
}

interface Book {
  /** Slot of the CreateEvent; null when first seen through a trade. */
  created: number | null;
  /** Recent price points, oldest first, inside the high window. */
  pts: Point[];
  entryPrice: number;
  entrySlot: number;
  entryHigh: number;
  /** Lamports committed to buys on this position (sent, filled or not). */
  committed: bigint;
  /** Entries taken on this coin over the run. */
  entries: number;
  /** Slot until which the coin is ignored after an exit. */
  coolUntil: number;
  /** A sell is in flight: do not send another. */
  exiting: boolean;
}

const books = new Map<Pubkey, Book>();

function bookOf(mint: Pubkey): Book {
  let b = books.get(mint);
  if (b === undefined) {
    b = { created: null, pts: [], entryPrice: 0, entrySlot: -1, entryHigh: 0, committed: 0n, entries: 0, coolUntil: -1, exiting: false };
    books.set(mint, b);
  }
  return b;
}

/** Price of one token in SOL from virtual reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** What selling `tokens` would pay, curve fees and one tx fee deducted. */
function liquidationValue(vq: bigint, vt: bigint, rq: bigint, tokens: bigint, tx: bigint): bigint {
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  const fee = (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return q - fee - tx;
}

function onBatch(e: Engine, batch: Batch): Order[] {
  const slot = batch.slot;
  const tx = e.txFee();
  const cap = e.hello.caps.max_orders_per_batch;
  const orders: Order[] = [];
  const touched: Pubkey[] = [];

  // Fold this batch's trades into the per-mint price history.
  for (const ev of batch.events) {
    if (ev.event === 'CreateEvent') bookOf(ev.mint).created = ev.slot;
    if (ev.event !== 'TradeEvent') continue;
    const b = bookOf(ev.mint);
    const price = priceOf(BigInt(ev.virtual_quote_reserves ?? '0'), BigInt(ev.virtual_token_reserves ?? '0'));
    b.pts.push({ slot, price, buy: ev.is_buy === true, sol: Number(BigInt(ev.sol_amount ?? '0')) / 1e9 });
    if (touched[touched.length - 1] !== ev.mint && !touched.includes(ev.mint)) touched.push(ev.mint);
  }
  for (const mint of touched) {
    const b = books.get(mint)!;
    let cut = 0;
    while (cut < b.pts.length && b.pts[cut]!.slot <= slot - P.highWindow) cut++;
    if (cut > 0) b.pts.splice(0, cut);
    if (b.pts.length > 400) b.pts.splice(0, b.pts.length - 400);
  }

  // A position that vanished without a sell of ours (curve completed, harness
  // close, or a buy that never filled) resets its book and starts cooling down.
  for (const f of batch.fills) {
    const b = books.get(f.mint);
    if (b === undefined) continue;
    if (f.side === 'sell') {
      b.exiting = false;
      if (!e.positions.has(f.mint)) {
        b.committed = 0n;
        b.entrySlot = -1;
        b.coolUntil = slot + P.cooldown;
      }
    } else if (f.status !== 'filled' && !e.positions.has(f.mint)) {
      let stillPending = false;
      for (const o of e.pending.values()) if (o.order.mint === f.mint) stillPending = true;
      if (!stillPending) {
        b.committed = 0n;
        b.entrySlot = -1;
      }
    }
  }
  for (const [mint, b] of books) {
    if (b.entrySlot < 0 || e.positions.has(mint)) continue;
    let stillPending = false;
    for (const o of e.pending.values()) if (o.order.mint === mint) stillPending = true;
    if (!stillPending) {
      b.committed = 0n;
      b.entrySlot = -1;
      b.coolUntil = slot + P.cooldown;
    }
  }

  const marks = new Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint }>();
  for (const m of batch.marks) {
    marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves), rq: BigInt(m.real_quote_reserves) });
  }
  const pendingMints = new Set<Pubkey>();
  for (const o of e.pending.values()) pendingMints.add(o.order.mint);

  // 1. Exits and adds on held positions, in mint order (deterministic).
  const held = [...e.positions.keys()].sort();
  for (const mint of held) {
    if (orders.length >= cap) break;
    const h = e.positions.get(mint)!;
    const b = bookOf(mint);
    const curve = e.curves.get(mint);
    if (curve === undefined || curve.complete || b.exiting) continue;
    const mk = marks.get(mint);
    const vq = mk ? mk.vq : curve.vq;
    const vt = mk ? mk.vt : curve.vt;
    const rq = mk ? mk.rq : curve.rq;
    const value = liquidationValue(vq, vt, rq, h.tokens, tx);
    const gain = h.cost > 0n ? Number(value - h.cost) / Number(h.cost) : 0;
    const entrySlot = b.entrySlot < 0 ? slot : b.entrySlot;
    if (gain >= P.takeProfit || gain <= -P.stopLoss || slot - entrySlot >= P.maxHold) {
      if (pendingMints.has(mint)) continue;
      const n = Math.max(1, Math.min(P.sellSplits, cap - orders.length));
      const piece = h.tokens / BigInt(n);
      for (let i = 1; i <= n; i++) {
        const amount = i === n ? h.tokens - piece * BigInt(n - 1) : piece;
        orders.push({ side: 'sell', client_id: e.clientId(), mint, token_amount: amount.toString(), max_slippage_bps: P.sellSlipBps });
      }
      b.exiting = true;
      continue;
    }
    // Add a tranche while the dip holds near the first entry.
    const ticks = b.pts;
    const price = ticks.length > 0 ? ticks[ticks.length - 1]!.price : 0;
    if (pendingMints.has(mint) || b.committed >= BigInt(Math.floor(P.maxPosSol * 1e9))) continue;
    if (b.entryPrice <= 0 || Math.abs(price / b.entryPrice - 1) > P.addBand) continue;
    let amount = BigInt(Math.floor(P.maxPosSol * 1e9)) - b.committed;
    const tranche = BigInt(Math.floor(P.trancheSol * 1e9));
    if (amount > tranche) amount = tranche;
    const sizeCap = e.buyCap(mint);
    if (amount > sizeCap) amount = sizeCap;
    if (amount < BigInt(Math.floor(P.minBuySol * 1e9))) continue;
    if (e.freeCash() - amount - tx < 0n) continue;
    orders.push({ side: 'buy', client_id: e.clientId(), mint, quote_lamports: amount.toString(), max_slippage_bps: P.buySlipBps });
    b.committed += amount;
    pendingMints.add(mint);
  }

  // 2. New entries on coins that traded this batch.
  let entries = 0;
  let open = e.committedCount();
  for (const mint of touched) {
    if (orders.length >= cap || entries >= P.maxEntriesPerBatch) break;
    if (open >= e.hello.caps.max_open_positions) break;
    if (e.positions.has(mint) || pendingMints.has(mint)) continue;
    const curve = e.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const b = bookOf(mint);
    if (slot < b.coolUntil) continue;
    if (b.entries >= P.maxEntries) continue;
    if (b.created === null || slot - b.created < P.minAge) continue;
    const realSol = Number(curve.rq) / 1e9;
    if (realSol < P.minRealSol) continue;
    const pts = b.pts;
    if (pts.length === 0) continue;
    let hi = 0;
    let hiSlot = -1;
    for (const p of pts) {
      if (p.price > hi) {
        hi = p.price;
        hiSlot = p.slot;
      }
    }
    if (hi <= 0) continue;
    const last = pts[pts.length - 1]!;
    const dd = 1 - last.price / hi;
    if (dd < P.ddMin || dd > P.ddMax) continue;
    if (P.recovery > 0) {
      let low = Infinity;
      for (const p of pts) if (p.slot >= hiSlot && p.price < low) low = p.price;
      if (!Number.isFinite(low) || last.price < low * (1 + P.recovery)) continue;
    }
    let amount = BigInt(Math.floor(P.trancheSol * 1e9));
    const sizeCap = e.buyCap(mint);
    if (amount > sizeCap) amount = sizeCap;
    if (amount < BigInt(Math.floor(P.minBuySol * 1e9))) continue;
    if (e.freeCash() - amount - tx < 0n) continue;
    orders.push({ side: 'buy', client_id: e.clientId(), mint, quote_lamports: amount.toString(), max_slippage_bps: P.buySlipBps });
    b.entryPrice = last.price;
    b.entrySlot = slot;
    b.entryHigh = hi;
    b.committed = amount;
    b.entries++;
    b.exiting = false;
    pendingMints.add(mint);
    entries++;
    open++;
  }
  return orders;
}

// ---------------------------------------------------------------- line loop

async function* readLines(input: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of input) {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      nl = buf.indexOf('\n');
    }
  }
  if (buf.length > 0) yield buf;
}

let engine: Engine | null = null;

for await (const line of readLines(stdin)) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line) as { type: string };
  if (msg.type === 'hello') {
    engine = new Engine(msg as unknown as Hello);
  } else if (msg.type === 'batch') {
    const batch = msg as unknown as Batch;
    const e = engine!;
    e.applyBatch(batch);
    const orders = onBatch(e, batch);
    e.record(orders);
    stdout.write(`${JSON.stringify({ type: 'reply', seq: batch.seq, orders })}\n`);
  } else if (msg.type === 'done') {
    break;
  }
}
