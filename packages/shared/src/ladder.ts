// Підбір розкладки до підпису (FR-007): п'ять щаблів сітки, на кожному —
// найближче до цільового строку погашення серед того, що пускає профіль
// (FR-005, FR-006), і поділ депозиту рівними частками з неподільним залишком
// у щабель 18 місяців (FR-032).
//
// Пропозиція нічого не доводить: програма перевіряє кожне обмеження заново
// (T020). Тут вона потрібна, щоб показати розкладку без симуляції транзакції.

import { BPS_DENOMINATOR } from './math'
import {
  RUNG_COUNT,
  RUNG_MONTHS,
  type RiskProfile,
  admitsIssuerShare,
  admitsRating,
} from './profiles'

export interface LadderCandidate {
  readonly issuerId: string
  readonly maturityTs: bigint
  readonly notch: number
}

export interface RungShare {
  readonly rungMonths: number
  readonly amountMicro: bigint
}

export interface LadderAllocation<C extends LadderCandidate> extends RungShare {
  readonly candidate: C
}

export interface LadderRequest<C extends LadderCandidate> {
  readonly profile: RiskProfile
  readonly depositMicro: bigint
  readonly nowTs: bigint
  readonly candidates: readonly C[]
}

export type LadderProposal<C extends LadderCandidate> =
  | { readonly ok: true; readonly allocations: readonly LadderAllocation<C>[] }
  | { readonly ok: false; readonly reason: 'deposit-below-rung-count' }
  | { readonly ok: false; readonly reason: 'no-admitted-instruments' }
  | { readonly ok: false; readonly reason: 'issuer-limit' }

const SECONDS_PER_DAY = 86_400n
const DAYS_PER_YEAR = 365n
const MONTHS_PER_YEAR = 12n

// Ті самі дні, що й у каталозі: round(міс × 365 / 12), половина вгору. Місяць
// однакової довжини тут доречніший за календарний — сітка строків є константою
// протоколу, а не датою у чиємусь часовому поясі.
export function rungTargetTs(nowTs: bigint, rungMonths: number): bigint {
  const days = (BigInt(rungMonths) * DAYS_PER_YEAR + MONTHS_PER_YEAR / 2n) / MONTHS_PER_YEAR

  return nowTs + days * SECONDS_PER_DAY
}

export function splitDeposit(depositMicro: bigint): readonly RungShare[] {
  const share = depositMicro / BigInt(RUNG_COUNT)

  return RUNG_MONTHS.map((rungMonths, index) => ({
    rungMonths,
    amountMicro: index === RUNG_COUNT - 1 ? depositMicro - share * BigInt(RUNG_COUNT - 1) : share,
  }))
}

// Вниз, як і решта арифметики: неподільний залишок робить найдовший щабель
// більшим за рівну частку на кілька мікро-USDC, і ceil відмовляв би другому
// щаблю того самого емітента лише через те, що депозит не поділився на п'ять.
export function issuerShareBps(issuerMicro: bigint, depositMicro: bigint): number {
  return Number((issuerMicro * BPS_DENOMINATOR) / depositMicro)
}

interface RankedCandidate<C extends LadderCandidate> {
  readonly candidate: C
  readonly distance: bigint
}

// Строк, потім емітент — щоб «найближче погашення» лишалось однією відповіддю
// і не залежало від порядку кандидатів, у якому їх віддав RPC.
function compareNearest<C extends LadderCandidate>(
  left: RankedCandidate<C>,
  right: RankedCandidate<C>,
): number {
  if (left.distance !== right.distance) {
    return left.distance < right.distance ? -1 : 1
  }
  if (left.candidate.maturityTs !== right.candidate.maturityTs) {
    return left.candidate.maturityTs < right.candidate.maturityTs ? -1 : 1
  }
  if (left.candidate.issuerId !== right.candidate.issuerId) {
    return left.candidate.issuerId < right.candidate.issuerId ? -1 : 1
  }

  return 0
}

function rankByNearest<C extends LadderCandidate>(
  pool: readonly C[],
  targetTs: bigint,
): readonly C[] {
  return pool
    .map((candidate) => {
      const gap = candidate.maturityTs - targetTs
      return { candidate, distance: gap < 0n ? -gap : gap }
    })
    .sort(compareNearest)
    .map((ranked) => ranked.candidate)
}

export function proposeLadder<C extends LadderCandidate>(
  request: LadderRequest<C>,
): LadderProposal<C> {
  const { profile, depositMicro, nowTs } = request

  // Менший депозит лишив би щаблі з нулем: це не лествиця, а відмова.
  // Справжній мінімум вкладу — параметр vault (FR-009), і його тримає програма.
  if (depositMicro < BigInt(RUNG_COUNT)) {
    return { ok: false, reason: 'deposit-below-rung-count' }
  }

  // Придатність не залежить від щабля: поріг рейтингу і ліміт на емітента
  // однакові на всіх п'яти (FR-005), а сітка строків керує лише порядком.
  // Тому пул один, а прохід щабель за щаблем не заганяє себе в глухий кут —
  // доки хоч в одного емітента лишилась місткість, у нього є чим закрити
  // будь-який щабель.
  const pool = request.candidates.filter(
    (candidate) => candidate.maturityTs > nowTs && admitsRating(profile, candidate.notch),
  )
  if (pool.length === 0) {
    return { ok: false, reason: 'no-admitted-instruments' }
  }

  const held = new Map<string, bigint>()
  const allocations: LadderAllocation<C>[] = []

  for (const share of splitDeposit(depositMicro)) {
    const candidate = rankByNearest(pool, rungTargetTs(nowTs, share.rungMonths)).find((entry) => {
      const heldAfter = (held.get(entry.issuerId) ?? 0n) + share.amountMicro
      return admitsIssuerShare(profile, issuerShareBps(heldAfter, depositMicro))
    })

    // Придатні інструменти є, але всі — в емітентів, які вже вибрали ліміт:
    // часткова лествиця не пропонується (FR-006).
    if (candidate === undefined) {
      return { ok: false, reason: 'issuer-limit' }
    }

    held.set(candidate.issuerId, (held.get(candidate.issuerId) ?? 0n) + share.amountMicro)
    allocations.push({ ...share, candidate })
  }

  return { ok: true, allocations }
}
