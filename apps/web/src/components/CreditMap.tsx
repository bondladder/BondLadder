import { motion } from 'framer-motion';
import { notchLabel } from '@/lib/format';
import { AXIS_GRADE_VALUES, CHART_X_MAX, CHART_X_MIN, CHART_X_TICKS, RATING_MAX, RATING_MIN } from '@/lib/source';

export interface CreditMapMark {
    id: string;
    issuer: string;
    ratingValue: number;
    maturity: string;
}

interface CreditMapProps {
    marks: CreditMapMark[];
    /** Ids of the five bonds that make up the position. */
    selectedIds: string[];
    floorValue: number;
    /** Right-hand caption on the floor rule, e.g. `Conservative floor — A- (7)`. */
    floorCaption: string;
    height?: number;
    /** Quarter-height inline illustration: no axis labels, no grid text. */
    mini?: boolean;
    /** Draws a vertical rule at this date and shades everything left of it. */
    todayLine?: string;
    /**
     * The domain to draw against. The chain catalogue moves — its maturities
     * and the grades present in it are whatever is deployed — so the composer
     * derives this from what it read. The screens still on mock figures leave
     * it out and get the mock's fixed domain.
     */
    domain?: {
        xMin: string;
        xMax: string;
        ticks: string[];
        ratingMin: number;
        ratingMax: number;
        axisValues: number[];
    };
}

const VB_W = 900;

const days = (date: string) => Date.parse(`${date}T00:00:00Z`);

export default function CreditMap({
    marks,
    selectedIds,
    floorValue,
    floorCaption,
    height = 380,
    mini = false,
    todayLine,
    domain,
}: CreditMapProps) {
    const xMin = days(domain?.xMin ?? CHART_X_MIN);
    const xMax = days(domain?.xMax ?? CHART_X_MAX);
    const ticks = domain?.ticks ?? CHART_X_TICKS;
    const ratingMin = domain?.ratingMin ?? RATING_MIN;
    const ratingMax = domain?.ratingMax ?? RATING_MAX;
    const axisValues = domain?.axisValues ?? AXIS_GRADE_VALUES;

    const pad = mini ? { top: 12, right: 168, bottom: 16, left: 16 } : { top: 18, right: 172, bottom: 40, left: 84 };

    const innerW = VB_W - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const x = (date: string) => pad.left + ((days(date) - xMin) / (xMax - xMin)) * innerW;
    const y = (value: number) => pad.top + ((value - ratingMin) / (ratingMax - ratingMin)) * innerH;

    const floorY = y(floorValue);
    const selected = new Set(selectedIds);

    const ladder = marks
        .filter((m) => selected.has(m.id))
        .slice()
        .sort((a, b) => days(a.maturity) - days(b.maturity));

    const ladderPoints = ladder.map((m) => `${x(m.maturity).toFixed(2)},${y(m.ratingValue).toFixed(2)}`).join(' ');

    const ease = [0.4, 0, 0.2, 1] as const;
    const transition = { duration: 0.34, ease };

    return (
        <figure className="m-0 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <div style={{ minWidth: mini ? 520 : 660 }}>
                <svg
                    viewBox={`0 0 ${VB_W} ${height}`}
                    width="100%"
                    height={height}
                    role="img"
                    aria-label={`Credit map. Rating against maturity date. Floor at ${notchLabel(floorValue)}.`}
                    style={{ display: 'block', overflow: 'visible' }}
                >
                    {/* Out-of-bounds band: everything below the floor */}
                    <motion.rect
                        x={pad.left}
                        width={innerW}
                        initial={false}
                        animate={{ y: floorY, height: Math.max(0, pad.top + innerH - floorY) }}
                        transition={transition}
                        fill="hsl(var(--oob))"
                    />

                    {/* Elapsed shading, left of today */}
                    {todayLine && (
                        <rect
                            x={pad.left}
                            y={pad.top}
                            width={Math.max(0, x(todayLine) - pad.left)}
                            height={innerH}
                            fill="hsl(var(--ink))"
                            opacity={0.045}
                        />
                    )}

                    {/* Horizontal grade rules */}
                    {axisValues.map((value) => (
                        <g key={value}>
                            <line
                                x1={pad.left}
                                x2={pad.left + innerW}
                                y1={y(value)}
                                y2={y(value)}
                                stroke="hsl(var(--rule))"
                                strokeWidth={1}
                            />
                            {!mini && (
                                <text
                                    x={pad.left - 12}
                                    y={y(value) + 4}
                                    textAnchor="end"
                                    className="figure"
                                    fontSize={12}
                                    fontFamily="var(--font-body)"
                                    fill="hsl(var(--ink-muted))"
                                >
                                    {notchLabel(value)}
                                </text>
                            )}
                        </g>
                    ))}

                    {/* Frame */}
                    <line
                        x1={pad.left}
                        x2={pad.left}
                        y1={pad.top}
                        y2={pad.top + innerH}
                        stroke="hsl(var(--rule-strong))"
                    />
                    <line
                        x1={pad.left}
                        x2={pad.left + innerW}
                        y1={pad.top + innerH}
                        y2={pad.top + innerH}
                        stroke="hsl(var(--rule-strong))"
                    />

                    {/* Maturity ticks */}
                    {!mini &&
                        ticks.map((tick) => (
                            <g key={tick}>
                                <line
                                    x1={x(tick)}
                                    x2={x(tick)}
                                    y1={pad.top + innerH}
                                    y2={pad.top + innerH + 5}
                                    stroke="hsl(var(--rule-strong))"
                                />
                                <text
                                    x={x(tick)}
                                    y={pad.top + innerH + 22}
                                    textAnchor="middle"
                                    className="figure"
                                    fontSize={11}
                                    fontFamily="var(--font-body)"
                                    fill="hsl(var(--ink-faint))"
                                >
                                    {tick}
                                </text>
                            </g>
                        ))}

                    {/* Today */}
                    {todayLine && (
                        <g>
                            <line
                                x1={x(todayLine)}
                                x2={x(todayLine)}
                                y1={pad.top}
                                y2={pad.top + innerH}
                                stroke="hsl(var(--ink-muted))"
                                strokeWidth={1}
                                strokeDasharray="3 3"
                            />
                            {!mini && (
                                <text
                                    x={x(todayLine) + 6}
                                    y={pad.top + 12}
                                    className="figure"
                                    fontSize={11}
                                    fontFamily="var(--font-body)"
                                    fill="hsl(var(--ink-muted))"
                                >
                                    {todayLine}
                                </text>
                            )}
                        </g>
                    )}

                    {/* The ladder */}
                    <motion.polyline
                        key={ladderPoints}
                        points={ladderPoints}
                        fill="none"
                        stroke="hsl(var(--mark))"
                        strokeWidth={1}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.28, ease }}
                    />

                    {/* Marks */}
                    {marks.map((m) => {
                        const isSelected = selected.has(m.id);
                        const belowFloor = m.ratingValue > floorValue;
                        return (
                            <motion.circle
                                key={m.id}
                                cx={x(m.maturity)}
                                cy={y(m.ratingValue)}
                                initial={false}
                                animate={{
                                    r: isSelected ? (mini ? 4 : 5) : 2.5,
                                    fill: isSelected
                                        ? 'hsl(var(--mark))'
                                        : belowFloor
                                          ? 'hsl(var(--paper))'
                                          : 'hsl(var(--ink-faint))',
                                    stroke: belowFloor ? 'hsl(var(--ink-faint))' : 'hsl(var(--mark))',
                                    strokeOpacity: belowFloor ? 1 : isSelected ? 1 : 0,
                                }}
                                transition={transition}
                                strokeWidth={1}
                            >
                                <title>{`${m.issuer} · ${notchLabel(m.ratingValue)} · ${m.maturity}`}</title>
                            </motion.circle>
                        );
                    })}

                    {/* The floor */}
                    <motion.line
                        x1={pad.left}
                        x2={pad.left + innerW}
                        initial={false}
                        animate={{ y1: floorY, y2: floorY }}
                        transition={transition}
                        stroke="hsl(var(--mark))"
                        strokeWidth={1.25}
                    />
                    <motion.text
                        x={pad.left + innerW + 10}
                        initial={false}
                        animate={{ y: floorY + 4 }}
                        transition={transition}
                        fontSize={mini ? 11 : 12}
                        fontFamily="var(--font-body)"
                        fill="hsl(var(--mark))"
                        className="figure"
                    >
                        {floorCaption}
                    </motion.text>
                </svg>
            </div>
        </figure>
    );
}
