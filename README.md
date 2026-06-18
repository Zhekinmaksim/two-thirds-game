# TWO-THIRDS

Confidential onchain game built on Inco Lightning.

Players pay a fixed `$1` entry fee, submit an encrypted pick from `0..63`, and try to land closest to `2/3` of the average pick. Guesses stay hidden until the round closes. After the round closes, the contract opens decryption for the configured settler, the keeper asks Inco for attested decryptions, and the contract verifies them onchain, computes the target, emits the revealed round numbers for the UI, and attempts to pay winners directly during settlement. If a token transfer fails, the game still advances and the owed amount becomes withdrawable credit.

## Product Summary

- Fixed entry fee: `$1 USDC`
- Max players per round: `100`
- Default round duration: `1 hour`
- Minimum players to settle a live game: `2`
- House rake: configurable, currently `5%`
- Winner payout: sent automatically by the contract inside `settle()`

## Architecture

```text
Player Browser              Keeper                     Contract
--------------             ------------------         -----------------------------
encrypt guess in browser -> polls closed rounds  ->  stores encrypted handles
approve + enter()          authorize decryption      verifies decrypt attestations
watch live state/events    attestedDecrypt()         computes 2/3 target
                           calls settle()            auto-pays winner(s) or credits fallback
                                                     starts next round
```

## Repository Layout

```text
two-thirds-game/
  contracts/               Foundry contract, tests, deploy scripts
  keeper/                  Node-based settlement bot for Fly.io
  frontend/
    app/                   Production Vite application for Vercel
    prototype.html         Older static prototype
  assets/social/           Social graphics and avatar/banner exports
  .github/workflows/       GitHub deployment workflows
```

## Current Mainnet State

- Frontend production URL: `https://two-thirds-game.vercel.app`
- Mainnet contract: `0x0e9D534dE28045A33D8aB94Dbebc6822816ABe1B`
- Network: `Base`
- Mainnet keeper Fly app: `two-thirds-keeper-mainnet`
- Testnet keeper Fly app: `two-thirds-keeper-testnet`

## Contract Behavior

The contract uses direct payouts first, with fallback credits if a transfer fails.

- `enter()` transfers the fixed entry fee into the contract.
- `authorizeSettlerDecryption()` can be called only after the round closes.
- `settle()` verifies every attested decrypted guess.
- The target is computed as `floor(2 * sum(guesses) / (3 * playerCount))`.
- The closest wallet or wallets win.
- The contract attempts immediate winner payouts during `settle()`.
- If a payout or treasury transfer fails, the owed amount is queued as claimable credit instead of freezing the round.
- Any remainder from integer division rolls into the next round.

That means the user experience is:

- no claim button
- payouts normally land automatically after settlement
- a withdraw step appears only for fallback credits if the token transfer failed

## Local Development

### Contracts

```bash
cd contracts
forge install foundry-rs/forge-std --no-git
npm install --ignore-scripts
forge build
forge test -vvv
```

### Keeper

```bash
cd keeper
cp .env.example .env
npm install
npm start
```

Required keeper env:

```bash
RPC_URL=https://rpc.ankr.com/base/1dfb41f645be2ab63ae3eb7463c41f98995438f00e44a579a0abee13b61cf83a
SETTLER_PRIVATE_KEY=
GAME_ADDRESS=0x0e9D534dE28045A33D8aB94Dbebc6822816ABe1B
CHAIN_ID=8453
INCO_PEPPER=mainnet
TICK_SECONDS=1
PORT=8080
```

### Frontend

```bash
cd frontend/app
cp .env.example .env.local
npm install
npm run dev
```

Required frontend env:

```bash
VITE_INCO_PEPPER=mainnet
VITE_CHAIN_ID=8453
VITE_CHAIN_NAME=Base
VITE_RPC_URL=https://rpc.ankr.com/base/1dfb41f645be2ab63ae3eb7463c41f98995438f00e44a579a0abee13b61cf83a
VITE_GAME_ADDRESS=0x0e9D534dE28045A33D8aB94Dbebc6822816ABe1B
VITE_TOKEN_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

## GitHub Deployment Flow

This repository is prepared for GitHub-triggered deployments.

### Frontend to Vercel

The Vercel project is connected directly to the GitHub repository.

Trigger:

- push to `main`

Behavior:

- Vercel detects the push from GitHub
- the project builds from `frontend/app`
- production is updated through Vercel's native Git integration

No GitHub secret is required for frontend deployment.

### Keeper Testnet to Fly.io

Workflow: `.github/workflows/deploy-keeper-testnet.yml`

Trigger:

- push to `main` when keeper files change
- manual `workflow_dispatch`

Required GitHub secret:

- `FLY_API_TOKEN`

The workflow deploys `keeper/fly.toml`, which targets the testnet app.

### Keeper Mainnet to Fly.io

Workflow: `.github/workflows/deploy-keeper-mainnet.yml`

Trigger:

- push to `main` when keeper files change
- manual `workflow_dispatch`

## Manual Deployment Commands

### Frontend

```bash
cd frontend/app
vercel --prod
```

### Keeper Testnet

```bash
cd keeper
fly deploy -c fly.toml
```

### Keeper Mainnet

```bash
cd keeper
fly deploy -c fly.mainnet.toml
```

## Mainnet Checklist

- Full round lifecycle verified on testnet
- Contract reviewed before real-money usage
- Separate deployer, treasury, and settler wallets
- Separate Fly app and settler key for mainnet
- Vercel production env updated to mainnet addresses
- Keeper funded with gas

## Notes

- The frontend is public-read first: round, pot, timer, results, archive, leaderboard, and live feed work without wallet connection.
- The favicon is aligned with the social avatar asset.
- The recent leaderboard is derived from real settled rounds, not simulated data.
