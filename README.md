# hydrex-keeper

The Cloud Run job that casts the weekly Hydrex vote of the Klima "Carbon Impact" conduit on Base, and claims the rewards
of the conduit's delegators after each epoch flip. It signs with the HSM-held key of
[hydrex-keeper-key](https://github.com/ldeso/hydrex-keeper-key) and calls `vote` and `claimSwapAndDistribute` on the
Safe module of [hydrex-conduit-executor](https://github.com/ldeso/hydrex-conduit-executor), which forwards them to the
conduit. It can also vote and claim for the immutable conduit of
[hydrex-conduit](https://github.com/ldeso/hydrex-conduit), which anyone may propose a vote to or claim through, with a
second key, and then tops up both keys' ETH from that conduit's treasury. This repository holds the job in `src/`, whose
only dependency is `viem`, the tokens whose rewards it counts and claims in `tokens.json`, and the scripts in `sh/` that
create, deploy and check its Google Cloud project, with the IAM policies they write in `policy/`.

## How it votes

Hydrex epochs flip on Thursday at 00:00 UTC, and votes do not carry over. Cloud Scheduler starts the job at 23:50 UTC on
Tuesday and on Wednesday. The Tuesday run first tops up the keys: see
[How it tops up its keys](#how-it-tops-up-its-keys).

- **A day before the flip**, it votes in proportion to each pool's rewards. This vote is always cast, as a fallback.
- **In the last two blocks before the flip**, it votes for the largest expected reward: `x` votes on a pool with `V`
  votes from others and `usd` of rewards earn `usd × x / (V + x)`. It reads the block being built, with the votes others
  sent so far, and sends each vote about 0.8 s before its block's timestamp; if reads or signing fail, it sends the
  latest vote it has ready. It replaces the vote in force only if that pays at least $1 more.

Rewards are this epoch's bribes and fees in every pool with a live gauge, counted only in the tokens of `tokens.json`
and priced in USD. A vote leaves out pools that would get less than 0.1% of the votes, and all but the 40 largest: each
pool adds gas, and a Base transaction may use at most 16.8M. When blocks are nearly full, the tip rises, up to 0.1 gwei.

A failed execution exits non-zero, which emails `ALERT_EMAIL`, and Cloud Run retries it up to three times; a retry does
what is still due, and does not vote a day before the flip again for a conduit whose vote is in when its turn comes: for
the immutable conduit, only if the proposer sent the vote in force. A retry that starts once nothing is due succeeds at
once, since the attempt that was due already failed for what is wrong; a first attempt fails, so that a schedule that
misses its window alerts. After the flip, the last pass checks where its votes landed and that the Voter shows a vote of
the conduit in the epoch that ended, then claims.

## How it votes for the immutable conduit

When `CONDUIT` is set, the job also votes for the immutable conduit, version 2 of hydrex-conduit, at the same times,
with the same prices and in the same way, at most 20 pools to a vote, as that conduit allows. The proposer key signs its
votes, which go straight to the conduit.

- **The conduit's check.** Anyone may propose the conduit's vote, and it takes one only if its own score beats the vote
  in force by $1. That score counts only WETH, cbBTC, USDC and EURC at their Chainlink prices, and some trading fees.
  The job values a vote at its own prices, then checks that score as the vote is sent, rounded to basis points, aiming
  for $1.10: when its best vote falls short, it sends the best vote at its prices that clears it, if that one pays at
  least $1 more than the vote in force, a day before the flip too.
- **Both conduits.** A day before the flip, the immutable conduit votes once the Klima conduit's vote is in, so that its
  check counts the votes the Klima conduit's moves, and its vote is checked after the Klima conduit's too, in case that
  one is still pending. In the last blocks, each conduit plans apart, with RPC requests of its own. The Klima conduit's
  vote answers the immutable conduit's vote ready for the same block, as it would any other vote, and that one is
  checked after the Klima conduit's too, so that it clears its check whichever lands first. At each deadline, the job
  sends the freshest pair of plans checked together, so either conduit may send a plan a few hundred ms older than its
  latest; with no such pair, only the Klima conduit votes in that block, with its freshest plan that answered the
  immutable conduit's votes in force, if it has one. Neither conduit gives up rewards for the other. Voting for both
  costs the Klima conduit about 1–2% of its rewards, as any well-run conduit voting on the same pools would.
- **Votes of others.** A vote of someone else for the conduit, in the block being built, takes that block: the job then
  does not send one, and the Klima conduit's vote answers it. A day before the flip, when one takes the block of the
  job's vote, the job decides again against it.
- **Each on its own.** Neither conduit's failure stops the other's votes. The immutable conduit keeps voting if the
  Klima conduit has no voting power or refuses the keeper's votes, for example after losing its executor role, and the
  Klima conduit keeps voting and claiming if `CONDUIT` is unusable. Either fails the execution. Each conduit's claims go
  on whatever becomes of the other's.

## How it claims

After each flip, the job claims the rewards of the veNFTs delegated to the conduit. Each `claimSwapAndDistribute` claims
for one veNFT: the conduit collects its bribes and fees, swaps them to kVCM, uses about a third of the kVCM to retire
carbon credits, and sends the rest to the veNFT's owner.

- **Whose:** the veNFTs delegated to the conduit at the start of the epoch that just ended, except those that have not
  allowed the conduit to claim for them and, for now, the Klima Foundation's (`EXCLUDED_OWNERS` in `src/claim.ts`).
- **What:** rewards in the tokens of `tokens.json`, from the pools the conduit voted for in the last 12 epochs.
- **Minimum:** a claim is sent only if it collects at least $5 and its gas costs at most 5% of that. Smaller rewards
  wait for a later week.
- **Swaps:** through KyberSwap, with up to 5% slippage. The job checks each swap before using it, and claims less of a
  token when its swap would lose too much.

When `CONDUIT` is set, the job also claims for the immutable conduit's delegators, with the proposer key. Anyone may
call that conduit's `claim`, which collects a veNFT's bribes and fees and sends them to its owner as they are, less a 1%
fee to the conduit's treasury: no swap and no retirement. The same rules apply, but no owner is excluded: the Klima
Foundation's veNFTs are claimed for too.

Claims go one at a time for each conduit, the largest first, in the hour after the flip; the two conduits claim at the
same time. A conduit's claims stop if a claim would leave its key, the keeper or the proposer, with less than 0.001 ETH,
which is kept for the votes, or if another transaction of that key, such as a vote, is pending.

## How it tops up its keys

When `CONDUIT` is set, the Tuesday run first tops up the keeper and the proposer, before the week's votes and claims
spend their ETH, with USDC from the immutable conduit's treasury: the Safe that the conduit's `TREASURY()` names, which
takes its 1% fee. Through Safe's Allowance Module, version 1.0.0, the Safe lets the proposer draw USDC up to a weekly
allowance. The proposer sends every transaction of a top-up; the keeper's key only receives ETH.

- **How much:** each key is topped up to 0.003 ETH, so that it ends the week above the 0.002 ETH that `check.sh` asks
  for. The proposer draws the USDC that both lack, counting the USDC it holds and its own ETH beyond 0.003, which can go
  to the keeper; the keeper's beyond 0.003 cannot go to the proposer. When the allowance or the treasury cannot pay for
  both, the two keys end even. Less than 1 USDC to swap, or 0.0001 ETH to send the keeper, waits for a later week.
- **How:** the proposer approves the exact amount to the router of whichever of three deep USDC-WETH pools quotes the
  most: Uniswap v3's at 0.05%, through Uniswap's SwapRouter02, or Aero's Slipstream pools with tick spacings 100 and 50,
  through Aero's SwapRouter. In one call, the router swaps the USDC and unwraps the WETH to the proposer, which then
  sends the keeper its share. The swap is quoted before anything is drawn, and again just before it is sent: it is not
  made if it would pay more than 2% under the job's prices, and its minimum is 0.5% under its last quote. The top-up has
  5 minutes, and the run's vote comes 10 minutes after it starts.
- **Where from:** the job reads the treasury from the conduit. The module, the routers, their quoters (Uniswap's
  QuoterV2 and Aero's Metaquoter) and the pools are fixed in `src/topup.ts`; the Safe's owners enable the module, add
  `PROPOSER` as a delegate, and set its USDC allowance.

## What it can and cannot do

- **It votes, claims and tops up its keys.** `src/vote.ts`, `src/claim.ts` and `src/topup.ts` build every transaction
  the job sends: the module's `vote`, for pools with a live gauge that pay rewards in the tokens of `tokens.json`, and
  its `claimSwapAndDistribute`, for veNFTs delegated to the conduit, with KyberSwap calldata the job decodes and checks;
  the immutable conduit's `vote`, for the same pools, and its `claim`, for veNFTs delegated to it; and the proposer's
  top-up: the Allowance Module's `executeAllowanceTransfer`, of USDC from the treasury to the proposer, its approval of
  USDC to Uniswap's or Aero's router, that router's `multicall`, which swaps the USDC and unwraps the WETH to it, and a
  plain transfer of ETH to the keeper.
- **The key never leaves the HSM.** Cloud KMS signs, and a signature that does not recover to `KEEPER` is never sent.
  The job's service account is the key's only signer; it has no keys, and no role in its own project beyond reading its
  secrets.
- **The key can do more than the job does.** As the module's `KEEPER`, it can vote for any pool and call
  `claimSwapAndDistribute` with any swap calldata the conduit's routers accept. Anyone who can run code as the job's
  service account, such as an owner of the keeper project, can do the same.
- **The rest is checked on chain.** The module checks the caller; the conduit and the Voter check gauges, voting power
  and the epoch. For a claim, the conduit also checks that the veNFT lets it claim, and that each swap goes through a
  router it approves and buys a token it pays out.
- **The proposer key can draw from the treasury.** Anyone may propose the immutable conduit's vote and claim through it,
  so there its key can do nothing more than any account. But the treasury lets it draw its weekly USDC allowance, to any
  address: whoever can sign with it can take that much a week from the treasury, and no more. It is a second HSM key,
  and the job's service account is its only signer too. The keeper's key takes no part in top-ups but to receive.

## Deployment

- **Network:** Base.
- **`MODULE`:** [`0x750973E0CB728C3112561Bc8E9b235afA9B17E81`][module], `KlimaVeTokenConduitExecutor`.
- **`KEEPER`:** [`0x625CF6663d9D090535FBd57680bFFE6fA0262434`][keeper], the Cloud KMS HSM key `hydrex-keeper-v1`,
  version 1.
- **`CONDUIT`:** [`0x692c323B425A9DfeebE302F56168a7798D93EAC5`][immutable], `ImmutableVeTokenConduit`, version 2.
- **`PROPOSER`:** [`0x52c139f60452B93e1211F116BD43B28d7AfC2bCa`][proposer], the Cloud KMS HSM key `hydrex-proposer-v1`,
  version 1.
- **Treasury:** [`0x450c72de8c0079B49AcedF294a13011bd09D125B`][treasury], a 2-of-3 Safe. Its Allowance Module,
  [`0x691f59471Bfd2B7d639DCF74671a2d648ED1E331`][allowance], lets `PROPOSER` draw 10 USDC a week, reset on Mondays at
  00:00 UTC.
- **Routers:** Uniswap's SwapRouter02, [`0x2626664c2603336E57B271c5C0b26F421741e481`][uniswap], and Aero's Slipstream
  SwapRouter, [`0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418`][aero], as their documentation lists them.

[module]: https://basescan.org/address/0x750973E0CB728C3112561Bc8E9b235afA9B17E81
[keeper]: https://basescan.org/address/0x625CF6663d9D090535FBd57680bFFE6fA0262434
[immutable]: https://basescan.org/address/0x692c323B425A9DfeebE302F56168a7798D93EAC5
[proposer]: https://basescan.org/address/0x52c139f60452B93e1211F116BD43B28d7AfC2bCa
[treasury]: https://basescan.org/address/0x450c72de8c0079B49AcedF294a13011bd09D125B
[allowance]: https://basescan.org/address/0x691f59471Bfd2B7d639DCF74671a2d648ED1E331
[uniswap]: https://basescan.org/address/0x2626664c2603336E57B271c5C0b26F421741e481
[aero]: https://basescan.org/address/0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418

## Setup

Needs `gcloud`, `jq` and `curl`. `sh/setup.sh` and `sh/deploy.sh` need `roles/owner` on the keeper project, and
`sh/check.sh` needs `roles/viewer`, `roles/iam.securityReviewer` and `roles/secretmanager.viewer`. Every script is safe
to re-run.

1. **Configure.** `cp config.env.example config.env`, then fill in `KEEPER_PROJECT` (a project for the job only),
   `KMS_KEY_VERSION` and `PROPOSER_KMS_KEY_VERSION` (`version` in hydrex-keeper-key's `record/keeper.json` and
   `record/proposer.json`) and `ALERT_EMAIL`. `config.env` holds public material only; the secrets live in Secret
   Manager. To vote for the Klima conduit alone, empty `CONDUIT`, `PROPOSER` and `PROPOSER_KMS_KEY_VERSION`.
2. **Create the resources.** `sh/setup.sh` enables the APIs and creates the job's and the scheduler's service accounts,
   the secrets, and email alerts on a failed execution or start. It prints the job's service account.
3. **Grant the keys.** In hydrex-keeper-key, set `KEEPER_SA` to that service account and run `sh/grant.sh`.
4. **Add the secrets.** `sh/setup.sh` prints the command that adds each: Base RPC URLs, separated by commas, and an
   Alchemy API key. Public RPCs are tried after yours.
5. **Fund the keeper and the proposer.** Send ETH on Base to `KEEPER` and `PROPOSER`. The keeper's vote costs about
   0.00005 ETH and a claim up to 0.0001 ETH, and claims always leave 0.001 ETH for the votes: 0.01 ETH lasts it about
   three months. The proposer's votes take more gas and its claims less, and its claims leave it 0.001 ETH too: 0.01 ETH
   lasts it months. With `CONDUIT` set, every Tuesday the job then tops both up to 0.003 ETH from the treasury, if the
   treasury lets the proposer draw USDC and holds enough of it; the proposer pays for the top-ups, so it needs ETH to
   start.
6. **Deploy.** `sh/deploy.sh` builds the image with Cloud Build and deploys the job and its schedule. Run it again after
   any change to `src/` or `tokens.json`.
7. **Try it.** `sh/run.sh --dry-run --now` runs the Tuesday run at once, the top-up then the vote of a day before the
   flip, and signs the vote with KMS, but sends nothing; `sh/run.sh --now` sends them. `sh/run.sh --dry-run --claim`
   does the same for the claims. Without `--dry-run`, `--now` and `--claim` are refused while the schedule may be voting
   or claiming, and `--claim` also when that is within the hour it claims for. The logs are in Cloud Run, one JSON
   object per line.

A deployment that votes for the Klima conduit alone adds the immutable conduit by setting `CONDUIT`, `PROPOSER` and
`PROPOSER_KMS_KEY_VERSION` in `config.env` and in the repository variables of the `check` workflow, funding `PROPOSER`,
and running `sh/deploy.sh`. hydrex-keeper-key's `sh/check.sh` confirms that the job's service account may sign with the
proposer key.

## Checks

`sh/check.sh` compares the live project with `config.env` and `policy/`, read-only: the job, its schedule, the secrets,
the service accounts, IAM and the alerts. It also fails if the keeper or the proposer holds less than 0.002 ETH, to warn
before their claims stop at 0.001 ETH, and before the proposer cannot pay for a vote in busy blocks: with top-ups, when
those stop.

The `check` workflow runs it every Friday, after the vote, and on demand. It signs in through Workload Identity
Federation as a service account with the roles above, named by the `WIF_PROVIDER` and `CI_SERVICE_ACCOUNT` repository
variables, and builds `config.env` from the repository variables named in `config.env.example`: set at least
`KEEPER_PROJECT`, `KMS_KEY_VERSION` and `ALERT_EMAIL`.

Outside the scripts: enforce `iam.managed.disableServiceAccountKeyCreation` on the keeper project, since `check.sh` only
detects keys, and change `tokens.json` by pull request, then redeploy.

## Failure modes

- **Base RPC:** a read that fails, or gets no answer within 250 ms, also goes to the next URL. A vote or a claim goes to
  every URL; in the last blocks, a vote that no URL accepts fails the execution, unless the vote it replaces landed
  first. The claims' reads are much heavier, so each goes to one URL at a time, which has 30 s to answer.
- **Prices:** DefiLlama and Alchemy, and CoinGecko if `COINGECKO_SECRET` is set; a price is the median of their quotes,
  or the lower of two. A token without a price counts as zero, and the vote fails if no token has one. If every source
  fails, or less than 20 s are left, the last prices are used, but only if they were fetched for every token asked: the
  top-up's do not stand in for the vote's.
- **Keeper balance:** a vote needs twice its maximum cost in the keeper, so that it leaves enough to vote in the last
  blocks; a vote in the last blocks needs it once; a claim needs it plus 0.001 ETH. Short of that, the job refuses to
  vote or claim and logs `fund the keeper`.
- **Claims:** a conduit's reads before its claims are tried three times. A claim that fails, or claims still left when
  the hour ends, fail the execution; the next week's claims, or `sh/run.sh --claim`, take what is left. A conduit's
  claims stop if its key cannot pay, if another of that key's transactions is pending, or if a claim's outcome is
  unknown. A token KyberSwap cannot swap is left out, and a wrong answer from KyberSwap fails the execution.
- **Cloud Scheduler:** a failed start is retried three times within five minutes, and emails an alert. A paused or
  deleted schedule does neither; `check.sh` reports it.
- **Hydrex's minter:** if the Voter's epoch lags the calendar, the job refuses to vote, and claims wait for the minter
  until an hour after the flip. A retry that starts after that hour stops at once and succeeds, whatever else is wrong:
  the attempt that waited already failed for all of it, and failing again would only start another retry.
- **Immutable conduit:** without voting power this epoch, it gets no vote, and the job logs a warning. While Base's
  sequencer is down, and for an hour after, it takes no vote, so its votes fail the execution. When its own values
  cannot be read, the simulation of each vote is the only check. The proposer's balance works as the keeper's, and logs
  `fund the proposer`. A `CONDUIT` that is not such a conduit, on the Klima conduit's Voter, that cannot be read in
  three tries, that comes without `PROPOSER` and its key, or whose `PROPOSER` is the keeper, is left out and fails the
  execution.
- **Klima conduit:** without voting power this epoch, it gets no vote, and the job fails the execution; the immutable
  conduit still votes.
- **Top-ups:** everything goes through the proposer: if it cannot pay for a transaction, which logs `fund the proposer`,
  or has one pending, neither key is topped up. That, a treasury that holds too little USDC, once the proposer drew what
  it holds, a swap quoted more than 2% under the prices, a transaction that would revert or whose outcome is unknown,
  and a top-up still sending after 5 minutes, fail the execution after the run's vote; its retry tops up again. A swap
  never takes less than 98% of what the prices make its USDC worth, and is quoted again before it is sent. An allowance
  used up this week, or none, only logs a warning. USDC the proposer is left with is swapped by its next top-up. A dry
  run checks each transaction as the run would, on what those before it leave the proposer. A top-up transaction whose
  outcome is unknown does not hold up the proposer's vote, which replaces it at its nonce.

## Development

Needs Node 26. Run `npm ci`, then `npm run typecheck`, `npm test` and `npm run format` before committing.
`MODULE=0x750973E0CB728C3112561Bc8E9b235afA9B17E81 BASE_RPC_URLS=… npm run dry-run` runs the vote of a day before the
flip against Base without KMS, and sends nothing; `npm run dry-run-claim` does the same with the claims. With `CONDUIT`
and `PROPOSER` set too, the dry runs also plan the immutable conduit's vote and claims, and `npm run dry-run` first
simulates the top-up, each transaction after those before it. `test/sh/golden.sh` runs the scripts under `dash` (or
`$TEST_SH`) against a fake `gcloud` and `curl` and compares the calls and output with `test/sh/golden/`; `--update`
rewrites them. CI runs the type check, the tests, Prettier, the golden tests, `shellcheck` and `reuse lint`, and builds
the image. Dependabot updates the pinned Actions, npm packages and base images.

## Limitations

- The expected reward assumes the others' votes stay put. The last pass misses votes sent in the last 2 s or so, and
  rewards paid in the last minute, which is rare.
- Claims only take rewards in the tokens of `tokens.json`, from the pools the conduit voted for; the owner can claim the
  rest. But a claim takes everything those pools owe the veNFT, including what it earned before it delegated to the
  conduit, which is then swapped and partly retired like the rest, or, through the immutable conduit, pays its 1% fee.
- Rewards that never add up to $5 are never claimed. Swaps lose more as they grow: about 4.5% for $1,000 of USDC. Each
  swap also raises kVCM's price for the claims after it, so the veNFTs with the least to claim, which are claimed last,
  get slightly less kVCM.
- Anyone may vote for the immutable conduit, and the Voter takes one of its votes per block. Someone who votes for it in
  every block near the flip keeps the job's vote out, though each of their votes must score $1 more on the conduit's
  check than the one before. The job does not yet bid against them.

## License

MIT, REUSE compliant.
