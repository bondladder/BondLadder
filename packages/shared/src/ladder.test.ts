import { describe, expect, it } from 'vitest'
import fixture from '../../../fixtures/ladder.json'
import {
  type LadderCandidate,
  type LadderProposal,
  issuerShareBps,
  proposeLadder,
  rungTargetTs,
  splitDeposit,
} from './ladder'
import { RUNG_COUNT, RUNG_MONTHS, maxIssuerBps } from './profiles'
import { notchForLabel } from './scale'

const NOW = 1_772_000_000n
const DAY = 86_400n
const DEPOSIT = 1_000_000_000n

// Щабель тримається у кандидаті, щоб тест міг прибрати цілий щабель, а підбір
// його не бачив: він знає лише строк погашення (FR-006).
interface TestCandidate extends LadderCandidate {
  readonly rungMonths: number
}

function candidate(
  issuerId: string,
  label: string,
  rungMonths: number,
  driftDays: number,
): TestCandidate {
  const notch = notchForLabel(label)
  if (notch === null) {
    throw new Error(`невідома мітка ${label}`)
  }

  return {
    issuerId,
    notch,
    rungMonths,
    maturityTs: rungTargetTs(NOW, rungMonths) + BigInt(driftDays) * DAY,
  }
}

function curve(issuerId: string, label: string, drifts: readonly number[]): TestCandidate[] {
  return RUNG_MONTHS.map((rungMonths, index) =>
    candidate(issuerId, label, rungMonths, drifts[index] ?? 0),
  )
}

// Найближчий на кожному щаблі — інший емітент: ECHO, ALPHA, CHARLIE, BRAVO,
// DELTA. FOXTROT не найближчий ніде і лишається запасним.
const SIX_ISSUERS: readonly TestCandidate[] = [
  ...curve('ALPHA', 'AAA', [9, 1, 7, 8, 6]),
  ...curve('BRAVO', 'AA', [3, 8, 9, 2, 7]),
  ...curve('CHARLIE', 'A', [8, 6, 2, 7, 9]),
  ...curve('DELTA', 'A-', [7, 9, 8, 6, 1]),
  ...curve('ECHO', 'AA-', [1, 7, 6, 9, 8]),
  ...curve('FOXTROT', 'A+', [12, 13, 14, 15, 16]),
]

const NEAREST_ISSUERS = ['ECHO', 'ALPHA', 'CHARLIE', 'BRAVO', 'DELTA']

function accept<C extends LadderCandidate>(proposal: LadderProposal<C>) {
  if (!proposal.ok) {
    throw new Error(`розкладку не сформовано: ${proposal.reason}`)
  }

  return proposal.allocations
}

function issuersOf<C extends LadderCandidate>(proposal: LadderProposal<C>): string[] {
  return accept(proposal).map((allocation) => allocation.candidate.issuerId)
}

describe('поділ депозиту', () => {
  it('ділить на п’ять часток так само, як спільний фікстур', () => {
    expect(fixture.rungMonths).toEqual([...RUNG_MONTHS])

    for (const entry of fixture.split) {
      const amounts = splitDeposit(BigInt(entry.depositMicro))

      expect(
        amounts.map((share) => share.amountMicro.toString()),
        entry.case,
      ).toEqual(entry.amountsMicro)
      expect(
        amounts.map((share) => share.rungMonths),
        entry.case,
      ).toEqual([...RUNG_MONTHS])
    }
  })

  it('не втрачає жодної одиниці на жодній сумі', () => {
    for (const depositMicro of [5n, 6n, 7n, 8n, 9n, 999_999_999n, DEPOSIT, DEPOSIT + 4n]) {
      const total = splitDeposit(depositMicro).reduce((sum, share) => sum + share.amountMicro, 0n)

      expect(total, `${depositMicro}`).toBe(depositMicro)
    }
  })

  it('лишає неподільний залишок щаблю 18 місяців, а не найкоротшому', () => {
    const amounts = splitDeposit(DEPOSIT + 3n)

    for (const share of amounts.slice(0, RUNG_COUNT - 1)) {
      expect(share.amountMicro).toBe(DEPOSIT / 5n)
    }
    expect(amounts[RUNG_COUNT - 1]?.rungMonths).toBe(18)
    expect(amounts[RUNG_COUNT - 1]?.amountMicro).toBe(DEPOSIT / 5n + 3n)
  })
})

describe('частка емітента', () => {
  it('рахує частку вниз, тож неподільний залишок не з’їдає ліміт', () => {
    expect(issuerShareBps(200_000_000n, DEPOSIT)).toBe(2000)
    expect(issuerShareBps(400_000_003n, DEPOSIT + 3n)).toBe(4000)
    expect(issuerShareBps(DEPOSIT, DEPOSIT)).toBe(10_000)
    expect(issuerShareBps(0n, DEPOSIT)).toBe(0)
  })
})

describe('підбір розкладки', () => {
  it('дає п’ять щаблів у сітці строків і розкладає повний депозит', () => {
    const allocations = accept(
      proposeLadder({
        profile: 'conservative',
        depositMicro: DEPOSIT,
        nowTs: NOW,
        candidates: SIX_ISSUERS,
      }),
    )

    expect(allocations.map((allocation) => allocation.rungMonths)).toEqual([...RUNG_MONTHS])
    expect(allocations.reduce((sum, allocation) => sum + allocation.amountMicro, 0n)).toBe(DEPOSIT)
  })

  it('бере на кожен щабель найближче погашення', () => {
    const proposal = proposeLadder({
      profile: 'conservative',
      depositMicro: DEPOSIT,
      nowTs: NOW,
      candidates: SIX_ISSUERS,
    })

    expect(issuersOf(proposal)).toEqual(NEAREST_ISSUERS)
  })

  it('не залежить від порядку кандидатів на вході', () => {
    const request = { profile: 'conservative', depositMicro: DEPOSIT, nowTs: NOW } as const
    const straight = proposeLadder({ ...request, candidates: SIX_ISSUERS })
    const reversed = proposeLadder({ ...request, candidates: [...SIX_ISSUERS].reverse() })

    expect(accept(reversed)).toEqual(accept(straight))
  })

  // FR-005: поріг відсікає інструмент до того, як його побачить «найближче
  // погашення», інакше найближчий забирав би щабель незалежно від рейтингу.
  it('відкидає рейтинг нижчий за поріг, навіть коли він найближчий на кожному щаблі', () => {
    const proposal = proposeLadder({
      profile: 'balanced',
      depositMicro: DEPOSIT,
      nowTs: NOW,
      candidates: [...curve('ZULU', 'BB+', [0, 0, 0, 0, 0]), ...SIX_ISSUERS],
    })

    expect(issuersOf(proposal)).toEqual(NEAREST_ISSUERS)
  })

  it('не бере інструмент, строк якого вже настав', () => {
    const spare = ['PAPA', 'QUEBEC', 'ROMEO', 'TANGO'].flatMap((issuerId, index) =>
      [6, 9, 12, 18].map((rungMonths) => candidate(issuerId, 'AAA', rungMonths, 5 + index)),
    )
    // Погашений стоїть до цілі щабля 3 місяці ближче (91 день), ніж будь-що
    // інше в наборі: без відсіву він забрав би щабель саме за FR-006.
    const matured = { ...candidate('MATURED', 'AAA', 3, 0), maturityTs: NOW }
    const late = candidate('LATE', 'AAA', 3, 92)

    const proposal = proposeLadder({
      profile: 'conservative',
      depositMicro: DEPOSIT,
      nowTs: NOW,
      candidates: [matured, late, ...spare],
    })

    expect(issuersOf(proposal)[0]).toBe('LATE')
  })

  it('різні профілі дають різну розкладку на тому самому каталозі', () => {
    const candidates = [...curve('SIERRA', 'BBB-', [0, 0, 0, 0, 0]), ...SIX_ISSUERS]
    const request = { depositMicro: DEPOSIT, nowTs: NOW, candidates } as const

    expect(issuersOf(proposeLadder({ ...request, profile: 'conservative' }))).toEqual(
      NEAREST_ISSUERS,
    )
    expect(issuersOf(proposeLadder({ ...request, profile: 'balanced' }))).toEqual([
      'SIERRA',
      'SIERRA',
      'CHARLIE',
      'BRAVO',
      'DELTA',
    ])
  })

  it('тримає частку емітента в межах ліміту профілю', () => {
    const candidates = [...curve('SIERRA', 'BBB-', [0, 0, 0, 0, 0]), ...SIX_ISSUERS]

    for (const profile of ['conservative', 'balanced'] as const) {
      const perIssuer = new Map<string, bigint>()

      for (const allocation of accept(
        proposeLadder({ profile, depositMicro: DEPOSIT, nowTs: NOW, candidates }),
      )) {
        const issuerId = allocation.candidate.issuerId
        perIssuer.set(issuerId, (perIssuer.get(issuerId) ?? 0n) + allocation.amountMicro)
      }

      for (const [issuerId, held] of perIssuer) {
        expect(issuerShareBps(held, DEPOSIT), `${profile}/${issuerId}`).toBeLessThanOrEqual(
          maxIssuerBps(profile),
        )
      }
    }
  })

  // Той самий вузький каталог: збалансованому ліміту 4000 bps вистачає двох
  // щаблів на емітента, консервативному 2000 bps — ні.
  it('складає лествицю з трьох емітентів збалансованому і відмовляє консервативному', () => {
    const three = [
      ...curve('ALPHA', 'AAA', [9, 1, 7, 8, 6]),
      ...curve('BRAVO', 'AA', [3, 8, 9, 2, 7]),
      ...curve('CHARLIE', 'A', [8, 6, 2, 7, 9]),
    ]
    const request = { depositMicro: DEPOSIT, nowTs: NOW, candidates: three } as const

    const issuers = issuersOf(proposeLadder({ ...request, profile: 'balanced' }))
    expect(issuers).toHaveLength(RUNG_COUNT)
    for (const issuerId of new Set(issuers)) {
      expect(issuers.filter((entry) => entry === issuerId).length, issuerId).toBeLessThanOrEqual(2)
    }

    expect(proposeLadder({ ...request, profile: 'conservative' })).toEqual({
      ok: false,
      reason: 'issuer-limit',
    })
  })

  it('відмовляє замість часткової лествиці, коли поріг не пускає жодного', () => {
    expect(
      proposeLadder({
        profile: 'conservative',
        depositMicro: DEPOSIT,
        nowTs: NOW,
        candidates: curve('ZULU', 'BB+', [0, 0, 0, 0, 0]),
      }),
    ).toEqual({ ok: false, reason: 'no-admitted-instruments' })
  })

  it('відмовляє, коли весь каталог уже погашений', () => {
    expect(
      proposeLadder({
        profile: 'balanced',
        depositMicro: DEPOSIT,
        nowTs: NOW,
        candidates: SIX_ISSUERS.map((entry) => ({ ...entry, maturityTs: NOW - DAY })),
      }),
    ).toEqual({ ok: false, reason: 'no-admitted-instruments' })
  })

  it('відмовляє на депозиті, меншому за кількість щаблів', () => {
    for (const depositMicro of [0n, 1n, 4n]) {
      expect(
        proposeLadder({
          profile: 'conservative',
          depositMicro,
          nowTs: NOW,
          candidates: SIX_ISSUERS,
        }),
        `${depositMicro}`,
      ).toEqual({ ok: false, reason: 'deposit-below-rung-count' })
    }
  })
})

describe('цільовий строк щабля', () => {
  it('відміряє строк від моменту депозиту тими самими днями, що й каталог', () => {
    for (const rungMonths of RUNG_MONTHS) {
      const days = (rungTargetTs(NOW, rungMonths) - NOW) / DAY

      expect(Number(days), `${rungMonths} міс`).toBe(Math.round((rungMonths * 365) / 12))
    }
  })
})
