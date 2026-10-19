# Gbam 🎯

> **Intelligent Betting Slip Engine & Statistical Probability Optimizer**

Gbam is an open, production-grade engine for intelligent sports betting ticket analysis, cross-bookmaker booking code conversion, algorithmic ticket trimming, and mathematical value assessment.

Unlike conventional platforms that randomly delete legs to hit an odds number, Gbam is built on rigorous statistical modeling (Bivariate Poisson Match Simulation, Expected Value ($+EV$) calculation, and Knapsack constraint optimization).

---

## ⚡ Core Capabilities

1. **Mathematical Probability & Expected Value Engine**
   - **Bivariate Poisson Distribution**: Simulates match scorelines ($0 \le h, a \le 10$) using dynamic team attack/defense ratings to derive true market probabilities.
   - **Expected Value (EV)**: Identifies market inefficiencies where $\text{EV} = (P \times \text{Odds}) - 1 > 0$.
   - **Fractional Kelly Criterion**: Computes mathematically optimal bankroll allocation.
   - **High-Probability Tier Filter**: Flags genuine $\ge 85–90\%$ low-risk selections (e.g. Over 0.5 match goals, Double Chance on elite favorites).

2. **Algorithmic Ticket Trimmer**
   - **Knapsack Target-Odds Solver**: Discovers the optimal subset of selections closest to your target multiplier (e.g. 10×, 50×) while maximizing cumulative true probability.
   - **Risk & Edge Filter**: Strips out negative-EV and volatile selections.
   - **Fixture Deduplication**: Automatically resolves conflicting outcomes on the same match.

3. **Serpentine Ticket Splitter**
   - Partitions a massive accumulator (e.g. 30+ games) across $K$ sub-tickets.
   - Uses snake/serpentine drafting to distribute high and low odds evenly across all slips with **zero fixture duplication**.

4. **Market Safety Swapper**
   - Automatically downgrades high-variance lines into safety cushions (e.g., *Over 2.5* $\rightarrow$ *Over 1.5*, or *Straight Win* $\rightarrow$ *Double Chance 1X*).

5. **Cross-Bookmaker Booking Code Conversion**
   - Pluggable adapter architecture for bookmakers (SportyBet, Bet9ja, with easily extensible drivers for 1XBet, Stake, BetKing, etc.).
   - Canonical market mapping dictionary.

---

## 📁 Project Architecture

```
gbam/
├── src/
│   ├── models/           # Strictly validated Zod schemas & TypeScript types
│   │   └── types.ts      # Fixture, BetLeg, BetSlip, ProbabilityAssessment
│   ├── stats/            # Mathematical & probability models
│   │   ├── poisson.ts    # Bivariate Poisson match simulation
│   │   └── evaluator.ts  # Expected Value, Edge, and Kelly Criterion
│   ├── engine/           # Ticket operations
│   │   ├── trimmer.ts    # Knapsack target odds & risk trimmer
│   │   ├── splitter.ts   # Serpentine odds-balancing splitter
│   │   └── editor.ts     # Market swapper & ticket combiner
│   ├── providers/        # Sports data abstraction
│   │   ├── sports-data.interface.ts
│   │   ├── mock-stats.provider.ts   # Deterministic offline provider
│   │   └── api-football.provider.ts # Live API-Football integration
│   ├── bookmakers/       # Pluggable sportsbooks
│   │   ├── adapter.interface.ts
│   │   ├── sportybet.adapter.ts
│   │   ├── bet9ja.adapter.ts
│   │   └── registry.ts   # Dynamic registry & converter
│   └── index.ts          # Public library API
├── tests/                # Automated Vitest test suite
├── .env.example          # Environment configuration
└── tsconfig.json         # Strict TypeScript compiler config
```

---

## 🚀 Getting Started

### 1. Installation

```bash
git clone https://github.com/PelumidotOps/Gbam.git
cd Gbam
npm install
```

### 2. Configuration

Copy the sample environment file:

```bash
cp .env.example .env
```

Add your API keys (e.g. `SPORTS_DATA_API_KEY`).

### 3. Run Tests

```bash
npm test
```

### 4. Build

```bash
npm run build
```

---

## 💻 Code Example

```typescript
import {
  PoissonModel,
  BetEvaluator,
  TicketTrimmer,
  BookmakerRegistry
} from 'gbam-core';

// 1. Calculate true match probability using Poisson simulation
const probs = PoissonModel.calculateMatchProbabilities({
  homeLambda: 2.4, // Expected goals for home team
  awayLambda: 0.6  // Expected goals for away team
});

console.log(`Home Win: ${(probs.homeWin * 100).toFixed(1)}%`);
console.log(`Over 0.5 Goals: ${(probs.over0_5 * 100).toFixed(1)}%`);
console.log(`Double Chance 1X: ${(probs.dc1X * 100).toFixed(1)}%`);

// 2. Cross-convert booking code from SportyBet to Bet9ja
const converted = await BookmakerRegistry.convertBookingCode(
  'SportyBet',
  'Bet9ja',
  'B7K4RQ'
);

console.log(`New Bet9ja Booking Code: ${converted.newBookingCode}`);
```

---

## 📜 License

MIT License.
