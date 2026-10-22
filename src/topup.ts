import { encodeFunctionData, erc20Abi, parseEther, zeroAddress, type Abi, type Address } from "viem";
import {
  aeroQuoterAbi,
  aeroRouterAbi,
  allowanceAbi,
  immutableAbi,
  safeAbi,
  uniswapQuoterAbi,
  uniswapRouterAbi,
} from "./abi.ts";
import { blockAtLeast, call, lower, readEach, readMany, WETH, type Call, type Chain } from "./chain.ts";
import { errorMessage, log } from "./log.ts";
import type { Run } from "./pass.ts";
import { broadcastTx, confirmTx, prepareTx, signTx, type From, type TxCall } from "./vote.ts";

// The keeper and the proposer pay for their votes and claims in ETH. First thing on the Tuesday run, before the week's
// votes and claims spend it, the proposer draws the USDC that both lack from the immutable conduit's treasury, a Safe
// that allows it a weekly amount through Safe's Allowance Module; swaps it to ETH through Uniswap's or Aero's router,
// whichever pays more; and sends the keeper its share. The keeper's key only receives.

/** Safe's Allowance Module, version 1.0.0. */
export const ALLOWANCE_MODULE: Address = "0x691f59471Bfd2B7d639DCF74671a2d648ED1E331";
export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Uniswap's SwapRouter02 and QuoterV2, from its deployment docs. Its router holds what is swapped to ADDRESS_THIS.
export const UNISWAP_ROUTER: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
const UNISWAP_QUOTER: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const UNISWAP_SELF: Address = "0x0000000000000000000000000000000000000002";
// Aero's Slipstream SwapRouter and Metaquoter, from its docs' security page. Its router holds what is swapped to zero.
export const AERO_ROUTER: Address = "0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418";
const AERO_QUOTER: Address = "0x1dDfeC5058180C207F55BB77D95AcDd0d8227868";
export const TARGET = parseEther("0.003"); // what each key is topped up to: check.sh fails below 0.002 ETH
export const TOP_UP_MS = 5 * 60_000; // how long a top-up may take: the scheduled run starts 10 minutes before its vote
export const MIN_SWAP = 1_000_000n; // 1 USDC: the proposer's USDC waits until it can swap this much
export const MIN_SEND = parseEther("0.0001"); // less waits for a later week
const MAX_LOSS = 0.02; // the most a swap may pay under the job's prices
const QUOTE_MARGIN_BPS = 50n; // a swap's minimum is this far under its quote
const DEADLINE_SLACK_MS = 60_000; // how long past the last send a swap may land

/**
 * A pool of USDC and WETH, and its router: `swap` is the router's call that sells USDC through the pool and unwraps the
 * WETH to `to`, and `quote` asks the router's quoter what that pays.
 */
export type Venue = {
  name: string;
  router: Address;
  quote: (amountIn: bigint) => Call;
  swap: (amountIn: bigint, amountOutMinimum: bigint, to: Address, deadline: bigint) => TxCall;
};

const unwrap = (abi: Abi, amountMinimum: bigint, to: Address) =>
  encodeFunctionData({ abi, functionName: "unwrapWETH9", args: [amountMinimum, to] });

/** Uniswap v3's pool with the fee `fee`, in millionths. */
const uniswap = (fee: number): Venue => ({
  name: `Uniswap ${fee}`,
  router: UNISWAP_ROUTER,
  quote: (amountIn) =>
    call(UNISWAP_QUOTER, uniswapQuoterAbi, "quoteExactInputSingle", [
      { tokenIn: USDC, tokenOut: WETH, amountIn, fee, sqrtPriceLimitX96: 0n },
    ]),
  swap: (amountIn, amountOutMinimum, to, deadline) => {
    const params = { tokenIn: USDC, tokenOut: WETH, fee, recipient: UNISWAP_SELF, amountIn, amountOutMinimum };
    const args = [{ ...params, sqrtPriceLimitX96: 0n }] as const;
    const swap = encodeFunctionData({ abi: uniswapRouterAbi, functionName: "exactInputSingle", args });
    const data = [swap, unwrap(uniswapRouterAbi, amountOutMinimum, to)];
    return { to: UNISWAP_ROUTER, abi: uniswapRouterAbi, functionName: "multicall", args: [deadline, data] };
  },
});

/** Aero's Slipstream pool at `pool`, with the tick spacing `tickSpacing`. */
const aero = (tickSpacing: number, pool: Address): Venue => ({
  name: `Aero ${tickSpacing}`,
  router: AERO_ROUTER,
  quote: (amountIn) => call(AERO_QUOTER, aeroQuoterAbi, "quoteExactInputSingleV3", [pool, USDC, amountIn, 0n]),
  swap: (amountIn, amountOutMinimum, to, deadline) => {
    const params = { tokenIn: USDC, tokenOut: WETH, tickSpacing, recipient: zeroAddress, deadline, amountIn };
    const args = [{ ...params, amountOutMinimum, sqrtPriceLimitX96: 0n }] as const;
    const swap = encodeFunctionData({ abi: aeroRouterAbi, functionName: "exactInputSingle", args });
    const data = [swap, unwrap(aeroRouterAbi, amountOutMinimum, to)];
    return { to: AERO_ROUTER, abi: aeroRouterAbi, functionName: "multicall", args: [data] };
  },
});

/** The deepest USDC-WETH pools of each: a swap goes through the one quoted most. */
export const VENUES: Venue[] = [
  uniswap(500),
  aero(100, "0x2A430bEbD2082d8e05D56d64DEDE8944279bbC24"),
  aero(50, "0x4A7af46bC8aBc00048c6c7920a1488DAF568366c"),
];

const ROUTERS = [...new Set(VENUES.map((venue) => venue.router))];

/** What the top-up starts from, read at block `at`: amounts of ETH in wei, of USDC in its units. */
type State = {
  at: bigint;
  /** The proposer, which sends every transaction of the top-up. */
  sender: From;
  treasury: Address;
  /** What the treasury allows the proposer each week, and what of it is left this week. */
  allowed: bigint;
  left: bigint;
  inTreasury: bigint;
  /** The keeper's ETH, and the proposer's ETH and USDC, and the USDC each router may take from it. */
  keeper: bigint;
  proposer: bigint;
  usdc: bigint;
  approved: Map<Address, bigint>;
  /** USD per ETH and per USDC. */
  ethUsd: number;
  usdcUsd: number;
};

/** A transaction of a top-up, what it is, for the logs and errors, and the least ETH it pays the proposer. */
type Step = { what: string; call: TxCall; gains?: bigint };

/**
 * Sends a top-up's steps, or simulates them: `send` returns once the step is in a block, `at` is the block to quote the
 * swap on, after the steps before it, and `balances` the keeper's and the proposer's ETH there.
 */
type Executor = {
  send: (step: Step) => Promise<void>;
  at: () => Promise<bigint>;
  balances: () => Promise<readonly [bigint, bigint]>;
};

/**
 * Tops up the keeper and the proposer to TARGET, when the job votes for the immutable conduit: the proposer draws the
 * USDC that both lack from the conduit's treasury, as far as its allowance and the treasury allow, swaps it to ETH, and
 * sends the keeper its share. USDC the proposer holds counts, and is swapped too. When both cannot reach TARGET, they end
 * even. A dry run simulates the transactions, each after those before it, and sends nothing. `until` (ms) bounds the
 * sends. Returns the number of failures.
 */
export async function topUp(run: Run, until: number): Promise<number> {
  if (!run.chain.v2) return 0;
  let failures = 0;
  try {
    const state = await readState(run, until);
    const allotted = allot(state);
    failures = allotted.failures;
    const exec = (run.dryRun ? simulator : sender)(run, state, until);
    await execute(run.chain, state, allotted.draw, until, exec);
    const [keeper, proposer] = await exec.balances();
    log.info(run.dryRun ? "dry run: would top up to" : "topped up", { keeper, proposer });
    return failures;
  } catch (error) {
    log.error(run.dryRun ? "dry run: top-up failed" : "top-up failed", { error: errorMessage(error) });
    return failures + 1;
  }
}

async function readState({ chain, prices }: Run, until: number): Promise<State> {
  const { conduit, proposer } = chain.v2!;
  const at = await blockAtLeast(chain);
  const read = <T>(calls: Call[]) => readMany<T>(chain.client, calls, { blockNumber: at });
  const balance = (address: Address) => chain.client.getBalance({ address, blockNumber: at });
  const [[treasury], priced, keeperEth, proposerEth] = await Promise.all([
    read<Address>([call(conduit, immutableAbi, "TREASURY")]),
    prices([USDC, WETH], until),
    balance(chain.keeper),
    balance(proposer),
  ]);
  const [enabled, allowance, inTreasury, usdc, ...approvals] = await read<boolean | readonly bigint[] | bigint>([
    call(treasury!, safeAbi, "isModuleEnabled", [ALLOWANCE_MODULE]),
    call(ALLOWANCE_MODULE, allowanceAbi, "getTokenAllowance", [treasury!, proposer, USDC]),
    call(USDC, erc20Abi, "balanceOf", [treasury!]),
    call(USDC, erc20Abi, "balanceOf", [proposer]),
    ...ROUTERS.map((router) => call(USDC, erc20Abi, "allowance", [proposer, router])),
  ]);
  const ethUsd = priced.get(lower(WETH));
  const usdcUsd = priced.get(lower(USDC));
  if (ethUsd === undefined || usdcUsd === undefined) throw new Error("ETH or USDC has no price");
  // The amount allowed each week, then what was spent of it since the last reset.
  const [amount, spent] = allowance as readonly bigint[];
  const allowed = enabled ? amount! : 0n;
  return {
    at,
    sender: { from: proposer, client: chain.v2Client },
    treasury: treasury!,
    allowed,
    left: allowed > spent! ? allowed - spent! : 0n,
    inTreasury: inTreasury as bigint,
    keeper: keeperEth,
    proposer: proposerEth,
    usdc: usdc as bigint,
    approved: new Map(ROUTERS.map((router, i) => [router, approvals[i] as bigint])),
    ethUsd,
    usdcUsd,
  };
}

/** USDC in wei of ETH, at the job's prices. */
const toWei = ({ ethUsd, usdcUsd }: State, usdc: bigint) =>
  BigInt(Math.floor((Number(usdc) * 1e12 * usdcUsd) / ethUsd));

/**
 * What the proposer draws: the USDC that takes both keys to TARGET, counting what it holds, as far as the allowance and
 * the treasury allow. The proposer's ETH beyond TARGET can go to the keeper, but not the keeper's to the proposer. A
 * treasury that holds too little is a failure.
 */
function allot(state: State): { draw: bigint; failures: number } {
  const { keeper, proposer, usdc, allowed, left, inTreasury, ethUsd, usdcUsd } = state;
  const short = (keeper < TARGET ? TARGET - keeper : 0n) + TARGET - proposer - toWei(state, usdc);
  const needed = short > 0n ? BigInt(Math.ceil(((Number(short) / 1e18) * ethUsd * 1e6) / usdcUsd)) : 0n;
  log.info("top-up", {
    treasury: state.treasury,
    allowanceLeft: left,
    inTreasury,
    ethUsd,
    keeper,
    proposer,
    usdc,
    needed,
  });
  const available = left < inTreasury ? left : inTreasury;
  if (needed <= available) return { draw: needed, failures: 0 };
  const fields = { needed, allowanceLeft: left, inTreasury };
  let failures = 0;
  if (allowed === 0n) log.warning("the treasury does not let the proposer draw USDC: not topping up", fields);
  else if (inTreasury < left) {
    failures++;
    log.error("the treasury holds too little USDC to top up the keys: fund it", fields);
  } else log.warning("the proposer's allowance limits the top-up this week", fields);
  return { draw: available, failures };
}

/** What the proposer sends the keeper: what takes it to TARGET, or, if both cannot be there, even with the proposer. */
export function shareOf(keeper: bigint, proposer: bigint): bigint {
  const even = (keeper + proposer) / 2n;
  const goal = even < TARGET ? even : TARGET;
  return goal > keeper ? goal - keeper : 0n;
}

const drawCall = ({ treasury, sender }: State, amount: bigint): TxCall => ({
  to: ALLOWANCE_MODULE,
  abi: allowanceAbi,
  functionName: "executeAllowanceTransfer",
  args: [treasury, USDC, sender.from, amount, zeroAddress, 0n, sender.from, "0x"],
});

const approveCall = (router: Address, amount: bigint): TxCall => ({
  to: USDC,
  abi: erc20Abi,
  functionName: "approve",
  args: [router, amount],
});

const minOut = (quoted: bigint) => (quoted * (10_000n - QUOTE_MARGIN_BPS)) / 10_000n;

/** The swap's deadline: a little past `until`, so that a swap sent near it is not refused for it. */
const deadline = (until: number) => BigInt(Math.floor((until + DEADLINE_SLACK_MS) / 1000));

/**
 * The venue among `venues` quoted most for `usdc` on block `at`, and the least its swap may pay: QUOTE_MARGIN_BPS under
 * its quote, and never more than MAX_LOSS under the job's prices. Fails if none pays that.
 */
async function bestVenue(
  chain: Chain,
  state: State,
  usdc: bigint,
  at: bigint,
  venues = VENUES,
): Promise<{ venue: Venue; minimum: bigint }> {
  const quotes = await readEach<readonly bigint[]>(
    chain.client,
    venues.map((venue) => venue.quote(usdc)),
    { blockNumber: at },
  );
  const paid = quotes.map((quote) => quote?.[0] ?? 0n);
  const best = paid.reduce((b, p, i) => (p > paid[b]! ? i : b), 0);
  const quoted = paid[best]!;
  const floor = BigInt(Math.floor(Number(toWei(state, usdc)) * (1 - MAX_LOSS)));
  if (quoted < floor) throw new Error(`a swap of ${usdc} USDC units pays at most ${quoted} wei, under ${floor}`);
  const venue = venues[best]!;
  const margin = minOut(quoted);
  const minimum = margin > floor ? margin : floor;
  log.info("top-up quote", { venue: venue.name, usdc, quoted, minimum });
  return { venue, minimum };
}

/**
 * The top-up's steps, each after those before it: the draw, the router's approval, the swap, and the transfer of the
 * keeper's share. The swap is quoted first, so that nothing is drawn unless a venue pays enough, and again on the block
 * of the steps before it, so that its minimum follows the price.
 */
async function execute(chain: Chain, state: State, draw: bigint, until: number, exec: Executor): Promise<void> {
  const usdc = state.usdc + draw;
  if (usdc >= MIN_SWAP) {
    let { venue, minimum } = await bestVenue(chain, state, usdc, state.at);
    if (draw > 0n) await exec.send({ what: "draw", call: drawCall(state, draw) });
    if (state.approved.get(venue.router)! < usdc) {
      await exec.send({ what: "approval", call: approveCall(venue.router, usdc) });
    }
    const at = await exec.at();
    if (at !== state.at) ({ minimum } = await bestVenue(chain, state, usdc, at, [venue]));
    const call = venue.swap(usdc, minimum, state.sender.from, deadline(until));
    await exec.send({ what: "swap", call, gains: minimum });
  }
  const [keeper, proposer] = await exec.balances();
  const share = shareOf(keeper, proposer);
  if (share >= MIN_SEND) await exec.send({ what: "transfer to the keeper", call: { to: chain.keeper, value: share } });
}

/** Sends each step once the one before it is in a block, and reads the balances on the block of the last. */
function sender(run: Run, state: State, until: number): Executor {
  const { chain } = run;
  let pinned = state.at;
  const balance = (address: Address) => chain.client.getBalance({ address, blockNumber: pinned });
  return {
    send: async ({ what, call }) => {
      pinned = await sendTx(run, state.sender, call, what, await blockAtLeast(chain, pinned), until);
    },
    at: async () => (pinned === state.at ? pinned : blockAtLeast(chain, pinned)),
    balances: () => Promise.all([balance(chain.keeper), balance(state.sender.from)] as const),
  };
}

/**
 * Simulates each step after those before it, on the state's block, and checks it as `sendTx` would, on the balance the
 * steps before it leave the proposer: each costs what it is expected to, and the swap pays its minimum.
 */
function simulator({ chain }: Run, state: State): Executor {
  const done: TxCall[] = [];
  let [keeper, proposer] = [state.keeper, state.proposer];
  return {
    send: async ({ what, call, gains = 0n }) => {
      const options = { what: `the ${what}`, before: done, blockNumber: state.at };
      const prepared = await prepareTx(chain, state.sender, call, options);
      payable(prepared, call, state.sender.from, proposer);
      done.push(call);
      const value = call.value ?? 0n;
      proposer += gains - prepared.expectedCost - value;
      if (call.to === chain.keeper) keeper += value;
      const { tx } = prepared;
      log.info("dry run: top-up simulated, not sent", { what, to: tx.to, value: tx.value, gas: tx.gas });
    },
    at: async () => state.at,
    balances: async () => [keeper, proposer] as const,
  };
}

/**
 * Fails unless the proposer can send `call`: it has no transaction pending, which may be a vote that a top-up must never
 * replace, and `balance` pays for the call's gas and value.
 */
function payable(
  { tx, cost, queued }: { tx: { nonce: number }; cost: bigint; queued: boolean },
  call: TxCall,
  from: Address,
  balance: bigint,
): void {
  if (queued) throw new Error(`a transaction of the proposer is pending at nonce ${tx.nonce}`);
  const needed = cost + (call.value ?? 0n);
  if (balance < needed) throw new Error(`fund the proposer: ${from} has ${balance} wei, needs ${needed}`);
}

/** Prepares, signs and sends the proposer's transaction for `call` on block `at`, and waits for it; returns its block. */
async function sendTx(
  { chain, proposer: signer }: Run,
  sender: From,
  call: TxCall,
  what: string,
  at: bigint,
  until: number,
): Promise<bigint> {
  const { from } = sender;
  const prepared = await prepareTx(chain, sender, call, { what: `the ${what}`, blockNumber: at });
  payable(prepared, call, from, prepared.balance);
  const { tx } = prepared;
  const { signed, ...ready } = await signTx(signer, tx, false, from);
  if (!signed) throw new Error("no key signs for the proposer");
  const hash = await broadcastTx(chain, { ...ready, signed }, until);
  log.info("top-up sent", { what, hash, nonce: tx.nonce });
  const { blockNumber } = await confirmTx(chain, from, hash, tx.nonce, `the ${what}`);
  log.info("top-up confirmed", { what, hash, block: blockNumber });
  return blockNumber;
}
