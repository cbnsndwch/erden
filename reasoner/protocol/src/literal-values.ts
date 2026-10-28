// Proof checker v3: the data values the checker can compare on its own, for the certificate that two literals of a
// functional data property are different values. Only datatypes whose value comparison is simple and exact are
// comparable; for any other pair the engine refuses `uncheckable-inconsistency` instead of claiming a clash.
import type { Literal } from './schema.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

const INTEGER_TYPES = new Set(
    [
        'integer',
        'nonNegativeInteger',
        'nonPositiveInteger',
        'positiveInteger',
        'negativeInteger',
        'long',
        'int',
        'short',
        'byte',
        'unsignedLong',
        'unsignedInt',
        'unsignedShort',
        'unsignedByte',
    ].map((name) => `${XSD}${name}`),
);

const DECIMAL = /^([+-]?)([0-9]*)(?:\.([0-9]*))?$/u;

/** A decimal's canonical value: sign, integer digits without leading zeros, fraction without trailing zeros. */
function decimalValue(lexical: string): string | undefined {
    const match = DECIMAL.exec(lexical);
    if (match === null) {
        return undefined;
    }
    const whole = (match[2] ?? '').replace(/^0+/u, '');
    const fraction = (match[3] ?? '').replace(/0+$/u, '');
    if ((match[2] ?? '') === '' && (match[3] ?? '') === '') {
        return undefined;
    }
    if (whole === '' && fraction === '') {
        return '0';
    }
    const sign = match[1] === '-' ? '-' : '';
    return `${sign}${whole === '' ? '0' : whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * The value of a literal in the datatypes the checker compares, as a string that is equal for two literals exactly
 * when their values are equal; undefined for any other datatype or an ill-formed lexical form. Integers and decimals
 * share the decimal value space (OWL 2 Structural Specification, section 4.1); strings, language strings and booleans
 * each have their own.
 */
export function comparableLiteralValue(literal: Literal): string | undefined {
    const { datatype, lexicalForm } = literal;
    if (datatype === `${XSD}string`) {
        return `string:${lexicalForm}`;
    }
    if (datatype === RDF_LANG_STRING && literal.language !== null) {
        return `langString:${literal.language.toLowerCase()}:${lexicalForm}`;
    }
    if (datatype === `${XSD}boolean`) {
        const value = { true: 'true', '1': 'true', false: 'false', '0': 'false' }[lexicalForm.trim()];
        return value === undefined ? undefined : `boolean:${value}`;
    }
    if (datatype === `${XSD}decimal` || INTEGER_TYPES.has(datatype)) {
        const trimmed = lexicalForm.trim();
        if (INTEGER_TYPES.has(datatype) && trimmed.includes('.')) {
            return undefined;
        }
        const value = decimalValue(trimmed);
        return value === undefined ? undefined : `decimal:${value}`;
    }
    return undefined;
}

/** Whether the checker can show that two literals are different values. */
export function distinctComparableValues(left: Literal, right: Literal): boolean {
    const leftValue = comparableLiteralValue(left);
    const rightValue = comparableLiteralValue(right);
    return leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue;
}
