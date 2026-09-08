// Демо-каталог боргових інструментів: емітент, строк, купон, ціна, рейтинг
// (FR-001). Це аргументи для register_instrument і publish_rating — самі
// транзакції шле deploy.ts, коли з'явиться куди їх слати.
//
// Каталог — функція від опорного часу, а не таблиця з датами: емітент відмовляє
// в реєстрації інструмента, строк якого вже минув, тож зашиті дати зробили б
// фікстур таким, що протухає сам по собі.

import { RUNG_MONTHS } from '@bondladder/shared'

export interface CatalogEntry {
  readonly issuerId: string
  readonly ratingLabel: string
  readonly agencyCode: string
  /// Щабель, під який випущено інструмент. Демо-метадані каталогу: підбір на
  /// ланцюзі й на клієнті дивиться на строк погашення, а не на це поле.
  readonly rungMonths: number
  readonly maturityTs: bigint
  readonly couponBps: number
  readonly priceMicro: bigint
}

interface CreditCurve {
  readonly issuerId: string
  readonly ratingLabel: string
  readonly agencyCode: string
  readonly couponBps: number
  readonly yieldBps: number
  /// Зсув дати погашення для кожного щабля з RUNG_MONTHS, у тому самому
  /// порядку. Зсув належить інструменту, а не кривій: один зсув на емітента
  /// робив би «найближче погашення» з FR-006 однаковим порядком на всіх
  /// п'яти щаблях, і підбір завжди брав би верхівку цього порядку до
  /// вичерпання ліміту — поріг профілю не впливав би ні на що.
  readonly maturityDriftDays: readonly number[]
}

// Емітенти вигадані. Шість проходять консервативний поріг — рівно стільки, щоб
// п'ять щаблів дісталися п'ятьом різним емітентам за ліміту 2000 bps; два
// відкриваються лише збалансованому профілю, і один не проходить за жодного,
// щоб FR-005 було що відкинути.
//
// Зсуви розставлені так, що на кожному щаблі найближчий інструмент належить
// іншому емітенту, а на щаблі 3 місяці найближчий — той самий BB+, який
// відкидають обидва профілі. Кредитна якість і точність потрапляння в строк не
// корелюють: інакше поріг профілю не змінював би розкладку, і FR-004 не було б
// чим показати.
const CREDIT_CURVES: readonly CreditCurve[] = [
  {
    issuerId: 'HELVETIA-RE',
    ratingLabel: 'AAA',
    agencyCode: 'MOODYS',
    couponBps: 320,
    yieldBps: 335,
    maturityDriftDays: [-13, 15, 23, -9, 11],
  },
  {
    issuerId: 'NORDLYS-ENERGI',
    ratingLabel: 'AA',
    agencyCode: 'FITCH',
    couponBps: 365,
    yieldBps: 380,
    maturityDriftDays: [7, 6, 17, -21, 19],
  },
  {
    issuerId: 'KESTREL-RAIL',
    ratingLabel: 'AA-',
    agencyCode: 'MOODYS',
    couponBps: 395,
    yieldBps: 415,
    maturityDriftDays: [2, 10, 12, 18, 26],
  },
  {
    issuerId: 'ATLAS-MARITIME',
    ratingLabel: 'A+',
    agencyCode: 'FITCH',
    couponBps: 460,
    yieldBps: 480,
    maturityDriftDays: [-18, -17, -25, 24, -8],
  },
  {
    issuerId: 'CALDERA-WATER',
    ratingLabel: 'A',
    agencyCode: 'SPGLOBAL',
    couponBps: 430,
    yieldBps: 455,
    maturityDriftDays: [-9, -12, 4, -16, -30],
  },
  {
    issuerId: 'VERDANT-AGRI',
    ratingLabel: 'A-',
    agencyCode: 'SPGLOBAL',
    couponBps: 505,
    yieldBps: 530,
    maturityDriftDays: [16, 19, -20, -26, 3],
  },
  {
    issuerId: 'ORICON-LOGISTICS',
    ratingLabel: 'BBB+',
    agencyCode: 'MOODYS',
    couponBps: 610,
    yieldBps: 645,
    maturityDriftDays: [11, -8, -7, 5, -23],
  },
  {
    issuerId: 'SABLE-TEXTILES',
    ratingLabel: 'BBB-',
    agencyCode: 'FITCH',
    couponBps: 725,
    yieldBps: 770,
    maturityDriftDays: [-5, -3, -14, 13, -15],
  },
  {
    issuerId: 'RUBICON-LEISURE',
    ratingLabel: 'BB+',
    agencyCode: 'SPGLOBAL',
    couponBps: 940,
    yieldBps: 1000,
    maturityDriftDays: [1, -22, 28, 29, 33],
  },
]

const SECONDS_PER_DAY = 86_400n
const DAYS_PER_YEAR = 365
const MONTHS_PER_YEAR = 12
const PAR_PRICE_MICRO = 1_000_000n
const BPS_DENOMINATOR = 10_000n

function tenorDays(rungMonths: number, driftDays: number): number {
  return Math.round((rungMonths * DAYS_PER_YEAR) / MONTHS_PER_YEAR) + driftDays
}

// Проста дисконтна ціна нульового купона під дохідність емітента: чим далі
// погашення, тим глибше ціна під номіналом. Демо-модель, а не котирування.
function priceMicroFor(yieldBps: number, days: number): bigint {
  const discountBps = BigInt(Math.round((yieldBps * days) / DAYS_PER_YEAR))

  return (PAR_PRICE_MICRO * BPS_DENOMINATOR) / (BPS_DENOMINATOR + discountBps)
}

export function buildCatalog(referenceTs: bigint): readonly CatalogEntry[] {
  const catalog: CatalogEntry[] = []

  for (const curve of CREDIT_CURVES) {
    for (const [index, rungMonths] of RUNG_MONTHS.entries()) {
      const driftDays = curve.maturityDriftDays[index]
      if (driftDays === undefined) {
        throw new Error(`${curve.issuerId}: немає зсуву для щабля ${rungMonths} місяців`)
      }

      const days = tenorDays(rungMonths, driftDays)

      catalog.push({
        issuerId: curve.issuerId,
        ratingLabel: curve.ratingLabel,
        agencyCode: curve.agencyCode,
        rungMonths,
        maturityTs: referenceTs + BigInt(days) * SECONDS_PER_DAY,
        couponBps: curve.couponBps,
        priceMicro: priceMicroFor(curve.yieldBps, days),
      })
    }
  }

  return catalog
}
