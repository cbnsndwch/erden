/**
 * A pre-parser for RDF/XML document type declarations. Oxigraph's RDF/XML reader expands nested internal
 * entities without a bound and can panic inside WebAssembly, so every RDF/XML source passes this scan first.
 *
 * Allowed: at most one `<!DOCTYPE name [ ... ]>` whose internal subset holds only general entities with plain
 * literal values (the FIBO and OWL convention of namespace abbreviations), comments, processing instructions,
 * and element, attribute-list and notation declarations without references. Everything that can reach outside
 * the document or multiply its size is refused before the parser runs.
 *
 * Oxigraph does not tokenize the internal subset: it reads every `<!ENTITY` in the document type's raw text,
 * including any inside a comment, a processing instruction or a quoted value, and a later declaration of a name
 * replaces an earlier one. So every `<!ENTITY` in the text must be a declaration this scan read, and each name
 * is declared once; otherwise the guard would check a different set of entities from the one the parser expands.
 *
 * Oxigraph's RDF/XML reader also slows down far faster than element nesting grows (about 5 s at depth 40,000 and
 * 95 s at 100,000), so elements may nest at most `maxElementDepth` deep.
 */

export type RdfXmlGuardReason =
    | 'encoding-declaration'
    | 'external-dtd'
    | 'external-entity'
    | 'parameter-entity'
    | 'entity-reference-in-value'
    | 'internal-subset-too-large'
    | 'entity-expansion-too-large'
    | 'nesting-too-deep'
    | 'malformed-document-type';

export interface RdfXmlGuardRefusal {
    readonly reason: RdfXmlGuardReason;
    readonly detail: string;
}

export const RDF_XML_GUARD_LIMITS = Object.freeze({
    maxInternalSubsetBytes: 64 * 1024,
    /** The sum, over every entity reference in the document, of the replacement text it expands to. */
    maxExpandedEntityBytes: 32 * 1024 * 1024,
    /** Element nesting depth; ontologies nest a few dozen levels at most. */
    maxElementDepth: 128,
});

const NAME_START = /[A-Za-z_:À-￿]/u;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/u;
const WHITESPACE = /[ \u0009\u000D\u000A]/u;

class Refused extends Error {
    readonly refusal: RdfXmlGuardRefusal;
    constructor(reason: RdfXmlGuardReason, detail: string) {
        super(detail);
        this.refusal = Object.freeze({ reason, detail });
    }
}

function encodingRefusal(text: string): RdfXmlGuardRefusal | undefined {
    const declaration = /^<\?xml[ \u0009\u000D\u000A][^>]*?\?>/u.exec(text);
    if (declaration === null) {
        return undefined;
    }
    const encoding = /encoding[ \u0009\u000D\u000A]*=[ \u0009\u000D\u000A]*(["'])([^"']*)\1/u.exec(declaration[0]);
    const name = encoding?.[2];
    return name === undefined || name.toLowerCase() === 'utf-8'
        ? undefined
        : { reason: 'encoding-declaration', detail: `the XML declaration names encoding ${name}; only UTF-8 is read` };
}

interface Cursor {
    readonly text: string;
    position: number;
}

function skipWhitespace(cursor: Cursor): void {
    while (cursor.position < cursor.text.length && WHITESPACE.test(cursor.text[cursor.position] ?? '')) {
        cursor.position += 1;
    }
}

function readName(cursor: Cursor, context: string): string {
    const start = cursor.position;
    if (!NAME_START.test(cursor.text[cursor.position] ?? '')) {
        throw new Refused('malformed-document-type', `${context} lacks a name`);
    }
    cursor.position += 1;
    while (cursor.position < cursor.text.length && NAME_CHAR.test(cursor.text[cursor.position] ?? '')) {
        cursor.position += 1;
    }
    return cursor.text.slice(start, cursor.position);
}

function skipPast(cursor: Cursor, terminator: string, context: string): void {
    const end = cursor.text.indexOf(terminator, cursor.position);
    if (end < 0) {
        throw new Refused('malformed-document-type', `${context} is not terminated`);
    }
    cursor.position = end + terminator.length;
}

function startsWithKeyword(cursor: Cursor, keyword: string): boolean {
    return cursor.text.startsWith(keyword, cursor.position);
}

/** Skips a markup declaration to its closing `>`, honouring quoted literals, and refuses any reference in it. */
function skipDeclaration(cursor: Cursor, context: string): void {
    let quote: string | undefined;
    while (cursor.position < cursor.text.length) {
        const character = cursor.text[cursor.position] ?? '';
        cursor.position += 1;
        if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            } else if (character === '&' || character === '%') {
                throw new Refused('entity-reference-in-value', `${context} contains an entity reference`);
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '%') {
            throw new Refused('parameter-entity', `${context} references a parameter entity`);
        } else if (character === '>') {
            return;
        }
    }
    throw new Refused('malformed-document-type', `${context} is not terminated`);
}

interface EntityDeclarations {
    /** The replacement-text size in bytes of each declared entity. */
    readonly sizes: Map<string, number>;
    /** The text position of every `<!ENTITY` the scan read as a declaration. */
    readonly positions: Set<number>;
}

function readEntity(cursor: Cursor, entities: EntityDeclarations): void {
    entities.positions.add(cursor.position);
    cursor.position += '<!ENTITY'.length;
    skipWhitespace(cursor);
    if (cursor.text[cursor.position] === '%') {
        throw new Refused('parameter-entity', 'the internal subset declares a parameter entity');
    }
    const name = readName(cursor, 'an entity declaration');
    if (!WHITESPACE.test(cursor.text[cursor.position] ?? '')) {
        throw new Refused('malformed-document-type', `entity ${name} is not followed by white space`);
    }
    if (entities.sizes.has(name)) {
        throw new Refused('malformed-document-type', `entity ${name} is declared more than once`);
    }
    skipWhitespace(cursor);
    if (startsWithKeyword(cursor, 'SYSTEM') || startsWithKeyword(cursor, 'PUBLIC')) {
        throw new Refused('external-entity', `entity ${name} is declared as an external (SYSTEM or PUBLIC) entity`);
    }
    const quote = cursor.text[cursor.position];
    if (quote !== '"' && quote !== "'") {
        throw new Refused('malformed-document-type', `entity ${name} has no quoted value`);
    }
    const end = cursor.text.indexOf(quote, cursor.position + 1);
    if (end < 0) {
        throw new Refused('malformed-document-type', `entity ${name} has an unterminated value`);
    }
    const value = cursor.text.slice(cursor.position + 1, end);
    if (value.includes('&') || value.includes('%')) {
        throw new Refused('entity-reference-in-value', `entity ${name} has a value that contains & or %`);
    }
    cursor.position = end + 1;
    skipWhitespace(cursor);
    if (cursor.text[cursor.position] !== '>') {
        throw new Refused('malformed-document-type', `entity ${name} declaration is not closed`);
    }
    cursor.position += 1;
    entities.sizes.set(name, Buffer.byteLength(value, 'utf8'));
}

function readInternalSubset(cursor: Cursor, entities: EntityDeclarations): void {
    const start = cursor.position;
    for (;;) {
        if (cursor.position - start > RDF_XML_GUARD_LIMITS.maxInternalSubsetBytes) {
            throw new Refused('internal-subset-too-large', 'the internal subset is larger than 64 KiB');
        }
        skipWhitespace(cursor);
        if (cursor.position >= cursor.text.length) {
            throw new Refused('malformed-document-type', 'the internal subset is not terminated');
        }
        if (cursor.text[cursor.position] === ']') {
            if (cursor.position - start > RDF_XML_GUARD_LIMITS.maxInternalSubsetBytes) {
                throw new Refused('internal-subset-too-large', 'the internal subset is larger than 64 KiB');
            }
            cursor.position += 1;
            return;
        }
        if (startsWithKeyword(cursor, '<!--')) {
            skipPast(cursor, '-->', 'a comment in the internal subset');
        } else if (startsWithKeyword(cursor, '<?')) {
            skipPast(cursor, '?>', 'a processing instruction in the internal subset');
        } else if (startsWithKeyword(cursor, '<!ENTITY')) {
            readEntity(cursor, entities);
        } else if (
            startsWithKeyword(cursor, '<!ELEMENT') ||
            startsWithKeyword(cursor, '<!ATTLIST') ||
            startsWithKeyword(cursor, '<!NOTATION')
        ) {
            skipDeclaration(cursor, 'a markup declaration in the internal subset');
        } else if (cursor.text[cursor.position] === '%') {
            throw new Refused('parameter-entity', 'the internal subset references a parameter entity');
        } else {
            throw new Refused('malformed-document-type', 'the internal subset holds an unrecognized declaration');
        }
    }
}

function expandedBytes(text: string, from: number, entities: ReadonlyMap<string, number>): number {
    let total = 0;
    for (const match of text.slice(from).matchAll(/&([^\s&;#<>"']+);/gu)) {
        total += entities.get(match[1] ?? '') ?? 0;
        if (total > RDF_XML_GUARD_LIMITS.maxExpandedEntityBytes) {
            break;
        }
    }
    return total;
}

function positions(text: string, pattern: RegExp): ReadonlyArray<number> {
    return [...text.matchAll(pattern)].map((match) => match.index);
}

/** The position of the `>` that closes the start tag at `start`, skipping quoted attribute values. */
function tagEnd(text: string, start: number): number {
    let quote: string | undefined;
    for (let index = start + 1; index < text.length; index += 1) {
        const character = text[index];
        if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            }
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index;
        }
    }
    return -1;
}

const MARKUP_TERMINATORS: ReadonlyArray<readonly [string, string]> = [
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
    ['<?', '?>'],
    ['<!', '>'],
    ['</', '>'],
];

/**
 * Refuses elements nested deeper than the bound, in one linear pass over the markup after the document type.
 * Text it cannot follow is left to the parser, which reports the syntax error.
 */
function nestingRefusal(text: string, from: number): RdfXmlGuardRefusal | undefined {
    let depth = 0;
    let index = text.indexOf('<', from);
    while (index >= 0) {
        const markup = MARKUP_TERMINATORS.find(([opening]) => text.startsWith(opening, index));
        let end: number;
        if (markup === undefined) {
            end = tagEnd(text, index);
            if (end >= 0 && text[end - 1] !== '/') {
                depth += 1;
                if (depth > RDF_XML_GUARD_LIMITS.maxElementDepth) {
                    return {
                        reason: 'nesting-too-deep',
                        detail: `elements nest more than ${String(RDF_XML_GUARD_LIMITS.maxElementDepth)} levels deep`,
                    };
                }
            }
        } else {
            const terminator = text.indexOf(markup[1], index + markup[0].length);
            end = terminator < 0 ? -1 : terminator + markup[1].length - 1;
            if (markup[0] === '</') {
                depth -= 1;
            }
        }
        if (end < 0) {
            return undefined;
        }
        index = text.indexOf('<', end + 1);
    }
    return undefined;
}

function documentTypeRefusal(text: string): RdfXmlGuardRefusal | number {
    // XML names are case-sensitive, but a tolerant tokenizer may not be: search without regard to case.
    const documentTypes = positions(text, /<!DOCTYPE/giu);
    const entityDeclarations = positions(text, /<!ENTITY/giu);
    const first = documentTypes[0];
    if (first === undefined) {
        return entityDeclarations.length === 0
            ? 0
            : { reason: 'malformed-document-type', detail: 'an entity is declared outside a document type' };
    }
    if (documentTypes.length > 1) {
        return { reason: 'malformed-document-type', detail: 'the document declares more than one document type' };
    }
    const cursor: Cursor = { text, position: first + '<!DOCTYPE'.length };
    const entities: EntityDeclarations = { sizes: new Map(), positions: new Set() };
    try {
        skipWhitespace(cursor);
        readName(cursor, 'the document type');
        skipWhitespace(cursor);
        if (startsWithKeyword(cursor, 'SYSTEM') || startsWithKeyword(cursor, 'PUBLIC')) {
            throw new Refused('external-dtd', 'the document type names an external (SYSTEM or PUBLIC) DTD');
        }
        if (cursor.text[cursor.position] === '[') {
            cursor.position += 1;
            readInternalSubset(cursor, entities);
            skipWhitespace(cursor);
        }
        if (cursor.text[cursor.position] !== '>') {
            throw new Refused('malformed-document-type', 'the document type declaration is not closed');
        }
        cursor.position += 1;
    } catch (error) {
        if (error instanceof Refused) {
            return error.refusal;
        }
        throw error;
    }
    if (entityDeclarations.some((position) => position < first || position >= cursor.position)) {
        return { reason: 'malformed-document-type', detail: 'an entity is declared outside the internal subset' };
    }
    if (entityDeclarations.some((position) => !entities.positions.has(position))) {
        return {
            reason: 'malformed-document-type',
            detail: 'an entity declaration appears inside a comment, a processing instruction or a quoted value, where the parser would still read it',
        };
    }
    if (expandedBytes(text, cursor.position, entities.sizes) > RDF_XML_GUARD_LIMITS.maxExpandedEntityBytes) {
        return {
            reason: 'entity-expansion-too-large',
            detail: 'entity references expand to more than 32 MiB of text',
        };
    }
    return cursor.position;
}

/** Where the markup after the document type declaration starts: 0 without one, or when the guard would refuse it. */
export function rdfXmlBodyStart(text: string): number {
    const documentType = documentTypeRefusal(text);
    return typeof documentType === 'number' ? documentType : 0;
}

/** Returns the first reason this RDF/XML text must not reach the parser, or undefined when it may. */
export function rdfXmlGuardRefusal(text: string): RdfXmlGuardRefusal | undefined {
    const encoding = encodingRefusal(text);
    if (encoding !== undefined) {
        return encoding;
    }
    const documentType = documentTypeRefusal(text);
    return typeof documentType === 'number' ? nestingRefusal(text, documentType) : documentType;
}
