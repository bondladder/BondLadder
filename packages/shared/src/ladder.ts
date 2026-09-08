// Підбір розкладки до підпису (FR-007): п'ять щаблів сітки, на кожному —
// найближче до цільового строку погашення серед того, що пускає профіль
// (FR-005) і що лежить у допуску щабля (FR-006), та поділ депозиту рівними
// частками з неподільним залишком у щабель 18 місяців (FR-032).
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

export interface RungWindow {
  readonly targetTs: bigint
  readonly fromTs: bigint
  readonly toTs: bigint
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
  | { readonly ok: false; readonly reason: 'rung-unfilled'; readonly rungMonths: number }
  | { readonly ok: false; readonly reason: 'issuer-limit' }

const SECONDS_PER_DAY = 86_400n
const DAYS_PER_YEAR = 365n
const MONTHS_PER_YEAR = 12n
const HALF = 2n

// Ті самі дні, що й у каталозі: round(міс × 365 / 12), половина вгору. Місяць
// однакової довжини тут доречніший за календарний — сітка строків є константою
// протоколу, а не датою у чиємусь часовому поясі.
export function rungTargetTs(nowTs: bigint, rungMonths: number): bigint {
  const days = (BigInt(rungMonths) * DAYS_PER_YEAR + MONTHS_PER_YEAR / HALF) / MONTHS_PER_YEAR

  return nowTs + days * SECONDS_PER_DAY
}

// Допуск за FR-006 виводиться із сітки, а не задається окремим числом:
// половина відстані до сусіднього щабля з кожного боку, у крайніх — до
// єдиного сусіда. Верхня межа виключна, тож інструмент рівно на середині між
// двома цілями належить коротшому щаблю і придатний рівно для одного.
export function rungWindow(nowTs: bigint, rungMonths: number): RungWindow {
  const index = RUNG_MONTHS.indexOf(rungMonths)
  const previous = RUNG_MONTHS[index - 1]
  const next = RUNG_MONTHS[index + 1]
  const targetTs = rungTargetTs(nowTs, rungMonths)

  const down =
    previous === undefined ? undefined : (targetTs - rungTargetTs(nowTs, previous)) / HALF
  const up = next === undefined ? undefined : (rungTargetTs(nowTs, next) - targetTs) / HALF

  // Сітка коротша за два щаблі не існує (RUNG_MONTHS), тож нуль тут
  // недосяжний — він лише закриває тип.
  return {
    targetTs,
    fromTs: targetTs - (down ?? up ?? 0n),
    toTs: targetTs + (up ?? down ?? 0n),
  }
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

interface PreparedRung<C extends LadderCandidate> extends RungShare {
  readonly ranked: readonly C[]
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

function rankForRung<C extends LadderCandidate>(
  request: LadderRequest<C>,
  rungMonths: number,
): readonly C[] {
  const window = rungWindow(request.nowTs, rungMonths)

  return request.candidates
    .filter(
      (candidate) =>
        candidate.maturityTs >= window.fromTs &&
        candidate.maturityTs < window.toTs &&
        admitsRating(request.profile, candidate.notch),
    )
    .map((candidate) => {
      const gap = candidate.maturityTs - window.targetTs
      return { candidate, distance: gap < 0n ? -gap : gap }
    })
    .sort(compareNearest)
    .map((ranked) => ranked.candidate)
}

export function proposeLadder<C extends LadderCandidate>(
  request: LadderRequest<C>,
): LadderProposal<C> {
  const { profile, depositMicro } = request

  // Менший депозит лишив би щаблі з нулем: це не лествиця, а відмова.
  // Справжній мінімум вкладу — параметр vault (FR-009), і його тримає програма.
  if (depositMicro < BigInt(RUNG_COUNT)) {
    return { ok: false, reason: 'deposit-below-rung-count' }
  }

  const rungs: PreparedRung<C>[] = []
  for (const share of splitDeposit(depositMicro)) {
    const ranked = rankForRung(request, share.rungMonths)
    if (ranked.length === 0) {
      return { ok: false, reason: 'rung-unfilled', rungMonths: share.rungMonths }
    }

    rungs.push({ ...share, ranked })
  }

  // Допуск робить набори щаблів неперетинними, тож найближчий на короткому
  // щаблі може виявитись єдиним придатним на довгому: жадібний прохід відмовив
  // би там, де повний набір існує. Відкат по щаблях повертає першу розкладку у
  // порядку «щабель за щаблем, найближче першим» — саме її і показуємо.
  const fill = (
    remaining: readonly PreparedRung<C>[],
    held: Map<string, bigint>,
  ): LadderAllocation<C>[] | null => {
    const [rung, ...rest] = remaining
    if (rung === undefined) {
      return []
    }

    for (const candidate of rung.ranked) {
      const heldBefore = held.get(candidate.issuerId) ?? 0n
      const heldAfter = heldBefore + rung.amountMicro
      if (!admitsIssuerShare(profile, issuerShareBps(heldAfter, depositMicro))) {
        continue
      }

      held.set(candidate.issuerId, heldAfter)
      const tail = fill(rest, held)
      held.set(candidate.issuerId, heldBefore)

      if (tail !== null) {
        return [{ rungMonths: rung.rungMonths, amountMicro: rung.amountMicro, candidate }, ...tail]
      }
    }

    return null
  }

  const allocations = fill(rungs, new Map())

  return allocations === null ? { ok: false, reason: 'issuer-limit' } : { ok: true, allocations }
}
