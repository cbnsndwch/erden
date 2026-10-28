import { MAX_REASONER_WIRE_BYTES } from '@erden/reasoner-protocol';

/**
 * Reasoner limits are deployment settings, not part of any persisted identity. The same ontology under different
 * limits has the same request input digest, lockfile, and reasoner identity; only the verdict can differ (a larger
 * budget can decide what a smaller one refuses). The CLI and the server read the same variables with the same grammar
 * and bounds, so an author can predict a deployment's verdict by setting the same values.
 */

export interface ReasonerLimits {
    /** Wall-time budget the reasoner process commits to, in milliseconds. */
    readonly maxWallTimeMs: number;
    /** Largest number of normalized input axioms the reasoner accepts. */
    readonly maxInputAxioms: number;
    /** Largest number of inferred statements the reasoner may report. */
    readonly maxInferences: number;
    /**
     * Largest canonical request, in bytes, sent to the reasoner, checked before the process starts; the reasoner's answer
     * is held to the same ceiling. Never above what the bundled reasoner reads (`reasonerWireCeiling`).
     */
    readonly maxRequestBytes: number;
}

/** The limits the reasoner request itself carries; the request ceiling is enforced before the request is sent. */
export type ReasonerRequestLimits = Pick<ReasonerLimits, 'maxWallTimeMs' | 'maxInputAxioms' | 'maxInferences'>;

export type ReasonerLimitKey = keyof ReasonerLimits;

export interface ReasonerLimitSetting {
    readonly key: ReasonerLimitKey;
    readonly variable: string;
    readonly defaultValue: number;
    readonly minimum: number;
    readonly maximum: number;
    readonly unit: string;
}

/** One row per setting: the variable that sets it, today's default, and its inclusive bounds. */
export const REASONER_LIMIT_SETTINGS: ReadonlyArray<ReasonerLimitSetting> = Object.freeze([
    Object.freeze({
        key: 'maxWallTimeMs',
        variable: 'ERDEN_REASONER_MAX_WALL_TIME_MS',
        defaultValue: 30_000,
        minimum: 1_000,
        maximum: 600_000,
        unit: 'milliseconds',
    }),
    Object.freeze({
        key: 'maxInputAxioms',
        variable: 'ERDEN_REASONER_MAX_INPUT_AXIOMS',
        defaultValue: 100_000,
        minimum: 1,
        maximum: 1_000_000,
        unit: 'axioms',
    }),
    Object.freeze({
        key: 'maxInferences',
        variable: 'ERDEN_REASONER_MAX_INFERENCES',
        defaultValue: 100_000,
        minimum: 1,
        maximum: 1_000_000,
        unit: 'inferred statements',
    }),
    Object.freeze({
        key: 'maxRequestBytes',
        variable: 'ERDEN_REASONER_MAX_REQUEST_BYTES',
        defaultValue: 16_777_216,
        minimum: 1_048_576,
        maximum: MAX_REASONER_WIRE_BYTES,
        unit: 'bytes',
    }),
] as const);

export const REASONER_LIMIT_ENVIRONMENT_NAMES = Object.freeze([
    'ERDEN_REASONER_MAX_WALL_TIME_MS',
    'ERDEN_REASONER_MAX_INPUT_AXIOMS',
    'ERDEN_REASONER_MAX_INFERENCES',
    'ERDEN_REASONER_MAX_REQUEST_BYTES',
] as const);

export type ReasonerLimitEnvironmentName = (typeof REASONER_LIMIT_ENVIRONMENT_NAMES)[number];

function setting(key: ReasonerLimitKey): ReasonerLimitSetting {
    const found = REASONER_LIMIT_SETTINGS.find((item) => item.key === key);
    if (found === undefined) {
        throw new TypeError(`Unknown reasoner limit ${key}`);
    }
    return found;
}

/** The single source of the default limits; nothing else holds a copy. */
export const DEFAULT_REASONER_LIMITS: ReasonerLimits = Object.freeze({
    maxWallTimeMs: setting('maxWallTimeMs').defaultValue,
    maxInputAxioms: setting('maxInputAxioms').defaultValue,
    maxInferences: setting('maxInferences').defaultValue,
    maxRequestBytes: setting('maxRequestBytes').defaultValue,
});

export class ReasonerLimitSettingError extends Error {
    readonly code = 'REASONER_LIMIT_SETTING_INVALID';
    readonly variable: string;
    readonly minimum: number;
    readonly maximum: number;

    constructor(item: ReasonerLimitSetting) {
        super(
            `${item.variable} must be a whole number of ${item.unit} from ${String(item.minimum)} to ${String(item.maximum)}`,
        );
        this.name = 'ReasonerLimitSettingError';
        this.variable = item.variable;
        this.minimum = item.minimum;
        this.maximum = item.maximum;
    }
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

function parseSetting(item: ReasonerLimitSetting, text: string | undefined): number {
    if (text === undefined) {
        return item.defaultValue;
    }
    if (!DECIMAL.test(text)) {
        throw new ReasonerLimitSettingError(item);
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < item.minimum || value > item.maximum) {
        throw new ReasonerLimitSettingError(item);
    }
    return value;
}

/**
 * Reads the limits from an environment. Unset means the default; any other value must be canonical decimal digits
 * inside the bounds, or the setting is refused with an error naming the variable.
 */
export function parseReasonerLimits(environment: Readonly<Record<string, string | undefined>>): ReasonerLimits {
    return Object.freeze({
        maxWallTimeMs: parseSetting(setting('maxWallTimeMs'), environment.ERDEN_REASONER_MAX_WALL_TIME_MS),
        maxInputAxioms: parseSetting(setting('maxInputAxioms'), environment.ERDEN_REASONER_MAX_INPUT_AXIOMS),
        maxInferences: parseSetting(setting('maxInferences'), environment.ERDEN_REASONER_MAX_INFERENCES),
        maxRequestBytes: parseSetting(setting('maxRequestBytes'), environment.ERDEN_REASONER_MAX_REQUEST_BYTES),
    });
}

/** Returns a frozen copy when every limit is a safe integer inside its bounds. */
export function validateReasonerLimits(limits: ReasonerLimits): ReasonerLimits {
    for (const item of REASONER_LIMIT_SETTINGS) {
        const value = limits[item.key];
        if (!Number.isSafeInteger(value) || value < item.minimum || value > item.maximum) {
            throw new ReasonerLimitSettingError(item);
        }
    }
    return Object.freeze({
        maxWallTimeMs: limits.maxWallTimeMs,
        maxInputAxioms: limits.maxInputAxioms,
        maxInferences: limits.maxInferences,
        maxRequestBytes: limits.maxRequestBytes,
    });
}

/** The V1 wire ceiling every reasoner release reads, and the only one releases before 0.2.0 read. */
const V1_WIRE_BYTES = 16_777_216;

/** Reasoner releases that read more than the V1 ceiling (their adapter contract records `max-wire-bytes`). */
const WIRE_CEILINGS: ReadonlyMap<string, number> = new Map([
    ['0.2.0+purrdf.0.12.0.dfb1df7', MAX_REASONER_WIRE_BYTES],
    ['0.3.0+purrdf.0.12.0.dfb1df7', MAX_REASONER_WIRE_BYTES],
]);

/**
 * The largest request and answer one reasoner release reads and writes. A release not listed is held to the V1
 * ceiling of 16 MiB, so a raised ERDEN_REASONER_MAX_REQUEST_BYTES never sends an older reasoner more than it reads.
 */
export function reasonerWireCeiling(toolVersion: string): number {
    return WIRE_CEILINGS.get(toolVersion) ?? V1_WIRE_BYTES;
}

/** The variable and current value behind one limit, for diagnostics that name the setting. */
export function reasonerLimitSetting(key: ReasonerLimitKey): ReasonerLimitSetting {
    return setting(key);
}
