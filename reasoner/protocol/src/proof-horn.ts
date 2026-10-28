// Proof checker v3, the Horn rules: what each step of the Horn calculus must satisfy to be trusted. Every rule is a
// sound inference over arbitrary class expressions, checked against the premises the step cites and nothing else; why
// the engine took a step never matters. Each rule is checked in `proof-horn-rules.ts`.
import { classExpressionKey } from './canonical.js';
import { propertyParts } from './expressions.js';
import type { ClassExpression, Lemma, Literal, NormalizedAxiom, ObjectPropertyExpression } from './schema.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';
const OWL_NOTHING = 'http://www.w3.org/2002/07/owl#Nothing';
const THING: ClassExpression = { kind: 'NamedClass', iri: OWL_THING };
const NOTHING: ClassExpression = { kind: 'NamedClass', iri: OWL_NOTHING };

/** What a proof step is about: every element of a context (a class expression, read as its conjuncts), or one individual. */
export type HornSubject =
    | { readonly kind: 'context'; readonly context: ClassExpression }
    | { readonly kind: 'individual'; readonly individual: string };

/** A proved or asserted fact, in the shape the Horn rules read. */
export type HornFact =
    | { readonly kind: 'class'; readonly subject: HornSubject; readonly expression: ClassExpression }
    | { readonly kind: 'edge'; readonly subject: string; readonly property: string; readonly object: string }
    | { readonly kind: 'data'; readonly subject: string; readonly property: string; readonly value: Literal }
    | { readonly kind: 'same'; readonly left: string; readonly right: string };

/** An RDF statement's subject, predicate and object, as inferred statements carry them. */
export interface HornStatement {
    readonly subject: string;
    readonly predicate: string;
    readonly object: string | Literal;
}

/** The fact an inferred or asserted RDF statement states. */
export function statementFact(statement: HornStatement): HornFact {
    const { subject, predicate, object } = statement;
    if (typeof object !== 'string') {
        return { kind: 'data', subject, property: predicate, value: object };
    }
    if (predicate === RDF_TYPE) {
        return {
            kind: 'class',
            subject: { kind: 'individual', individual: subject },
            expression: { kind: 'NamedClass', iri: object },
        };
    }
    if (predicate === RDFS_SUBCLASS) {
        return {
            kind: 'class',
            subject: { kind: 'context', context: { kind: 'NamedClass', iri: subject } },
            expression: { kind: 'NamedClass', iri: object },
        };
    }
    if (predicate === OWL_SAME_AS) {
        return { kind: 'same', left: subject, right: object };
    }
    return { kind: 'edge', subject, property: predicate, object };
}

/** The fact a lemma concludes. */
export function lemmaFact(lemma: Lemma): HornFact {
    const conclusion = lemma.conclusion;
    return conclusion.kind === 'SubClassOf'
        ? {
              kind: 'class',
              subject: { kind: 'context', context: conclusion.subClass },
              expression: conclusion.superClass,
          }
        : {
              kind: 'class',
              subject: { kind: 'individual', individual: conclusion.individual },
              expression: conclusion.classExpression,
          };
}

/** The fact an axiom states about individuals, if it states one. */
export function axiomFact(axiom: NormalizedAxiom): HornFact | undefined {
    switch (axiom.kind) {
        case 'ClassAssertion':
            return {
                kind: 'class',
                subject: { kind: 'individual', individual: axiom.individual },
                expression: axiom.classExpression,
            };
        case 'ObjectPropertyAssertion':
            return { kind: 'edge', subject: axiom.subject, property: axiom.property, object: axiom.object };
        case 'DataPropertyAssertion':
            return { kind: 'data', subject: axiom.subject, property: axiom.property, value: axiom.value };
        case 'SubClassOf':
            return axiom.subClass.kind === 'NamedClass' && axiom.superClass.kind === 'NamedClass'
                ? { kind: 'class', subject: { kind: 'context', context: axiom.subClass }, expression: axiom.superClass }
                : undefined;
        default:
            return undefined;
    }
}

function key(expression: ClassExpression): string {
    return classExpressionKey(expression);
}

/** The conjuncts of a context, flattened. */
export function contextParts(context: ClassExpression): ReadonlyArray<ClassExpression> {
    return context.kind === 'ObjectIntersectionOf' ? context.operands.flatMap(contextParts) : [context];
}

/** The canonical context of a set of conjuncts: flattened, without duplicates, sorted; a single one stands alone. */
export function makeContext(parts: ReadonlyArray<ClassExpression>): ClassExpression {
    const unique = new Map<string, ClassExpression>();
    for (const part of parts.flatMap(contextParts)) {
        unique.set(key(part), part);
    }
    const sorted = [...unique.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (sorted.length === 1) {
        return (sorted[0] as [string, ClassExpression])[1];
    }
    return { kind: 'ObjectIntersectionOf', operands: sorted.map(([, part]) => part) };
}

function subjectKey(subject: HornSubject): string {
    return subject.kind === 'context' ? `C:${key(subject.context)}` : `I:${subject.individual}`;
}

function sameLiteral(left: Literal, right: Literal): boolean {
    return (
        left.lexicalForm === right.lexicalForm && left.datatype === right.datatype && left.language === right.language
    );
}

/** A property expression as a key: the IRI, or `^` and the IRI for its inverse. */
function propertyKey(property: ObjectPropertyExpression): string {
    const { iri, inverse } = propertyParts(property);
    return inverse ? `^${iri}` : iri;
}

function invertKey(property: string): string {
    return property.startsWith('^') ? property.slice(1) : `^${property}`;
}

/** The premises of one step, indexed for the rule checks. */
export class HornPremises {
    readonly facts: ReadonlyArray<HornFact>;
    readonly axioms: ReadonlyArray<NormalizedAxiom>;
    private readonly classFacts = new Set<string>();
    private readonly propertyEdges = new Map<string, Set<string>>();
    private readonly dataEdges = new Map<string, Set<string>>();
    private readonly transitive = new Set<string>();

    constructor(facts: ReadonlyArray<HornFact>, axioms: ReadonlyArray<NormalizedAxiom>) {
        this.facts = facts;
        this.axioms = axioms;
        for (const fact of facts) {
            if (fact.kind === 'class') {
                this.classFacts.add(`${subjectKey(fact.subject)}\u0000${key(fact.expression)}`);
            }
        }
        for (const axiom of axioms) {
            this.indexAxiom(axiom);
        }
    }

    private link(map: Map<string, Set<string>>, from: string, to: string): void {
        const set = map.get(from) ?? new Set<string>();
        set.add(to);
        map.set(from, set);
    }

    private objectLink(from: string, to: string): void {
        this.link(this.propertyEdges, from, to);
        this.link(this.propertyEdges, invertKey(from), invertKey(to));
    }

    private indexAxiom(axiom: NormalizedAxiom): void {
        switch (axiom.kind) {
            case 'SubObjectPropertyOf':
                if (typeof axiom.subProperty === 'string' || axiom.subProperty.kind === 'ObjectInverseOf') {
                    this.objectLink(propertyKey(axiom.subProperty), propertyKey(axiom.superProperty));
                }
                return;
            case 'EquivalentObjectProperties':
                for (const left of axiom.properties) {
                    for (const right of axiom.properties) {
                        this.objectLink(propertyKey(left), propertyKey(right));
                    }
                }
                return;
            case 'InverseObjectProperties':
                this.objectLink(axiom.left, invertKey(axiom.right));
                this.objectLink(axiom.right, invertKey(axiom.left));
                return;
            case 'SymmetricObjectProperty':
                this.objectLink(axiom.property, invertKey(axiom.property));
                return;
            case 'TransitiveObjectProperty':
                this.transitive.add(axiom.property);
                this.transitive.add(invertKey(axiom.property));
                return;
            case 'SubDataPropertyOf':
                this.link(this.dataEdges, axiom.subProperty, axiom.superProperty);
                return;
            case 'EquivalentDataProperties':
                for (const left of axiom.properties) {
                    for (const right of axiom.properties) {
                        this.link(this.dataEdges, left, right);
                    }
                }
                return;
            default:
                return;
        }
    }

    private static reaches(edges: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string): boolean {
        const seen = new Set([from]);
        const pending = [from];
        for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
            if (next === to) {
                return true;
            }
            for (const item of edges.get(next) ?? []) {
                if (!seen.has(item)) {
                    seen.add(item);
                    pending.push(item);
                }
            }
        }
        return false;
    }

    /** `R ⊑* S` through the cited property axioms (a property reaches itself). */
    subProperty(sub: string, sup: string): boolean {
        return HornPremises.reaches(this.propertyEdges, sub, sup);
    }

    /** `p ⊑* q` through the cited data property axioms. */
    subDataProperty(sub: string, sup: string): boolean {
        return HornPremises.reaches(this.dataEdges, sub, sup);
    }

    /** A cited transitivity axiom makes `property` (or its inverse) transitive. */
    isTransitive(property: string): boolean {
        return this.transitive.has(property);
    }

    /** Whether `subject ⊑ expression` is cited, or holds by itself (`owl:Thing`, or a conjunct of the context). */
    holds(subject: HornSubject, expression: ClassExpression): boolean {
        if (expression.kind === 'NamedClass' && expression.iri === OWL_THING) {
            return true;
        }
        if (subject.kind === 'context') {
            const expressionKey = key(expression);
            if (key(subject.context) === expressionKey) {
                return true;
            }
            if (contextParts(subject.context).some((part) => key(part) === expressionKey)) {
                return true;
            }
        }
        return this.classFacts.has(`${subjectKey(subject)}\u0000${key(expression)}`);
    }

    /** The class facts cited about a subject. */
    classesOf(subject: HornSubject): ReadonlyArray<ClassExpression> {
        const wanted = subjectKey(subject);
        const parts = subject.kind === 'context' ? contextParts(subject.context) : [];
        return [
            ...parts,
            ...this.facts.flatMap((fact) =>
                fact.kind === 'class' && subjectKey(fact.subject) === wanted ? [fact.expression] : [],
            ),
        ];
    }
}

/** A successor of a subject: through a property (a key, `^` for an inverse) to a context or a named individual. */
export interface HornSuccessor {
    readonly property: string;
    readonly target: HornSubject;
    /** Whether the successor is a named edge, not an existential. */
    readonly named: boolean;
}

/** Every successor of `subject` the premises give: existentials it is cited (or known) to be in, and named edges. */
export function successors(premises: HornPremises, subject: HornSubject): ReadonlyArray<HornSuccessor> {
    const found: HornSuccessor[] = [];
    for (const expression of premises.classesOf(subject)) {
        if (expression.kind === 'ObjectSomeValuesFrom') {
            found.push({
                property: propertyKey(expression.property),
                target: { kind: 'context', context: expression.filler },
                named: false,
            });
        }
    }
    if (subject.kind === 'individual') {
        for (const fact of premises.facts) {
            if (fact.kind !== 'edge') {
                continue;
            }
            if (fact.subject === subject.individual) {
                found.push({
                    property: fact.property,
                    target: { kind: 'individual', individual: fact.object },
                    named: true,
                });
            }
            if (fact.object === subject.individual) {
                found.push({
                    property: invertKey(fact.property),
                    target: { kind: 'individual', individual: fact.subject },
                    named: true,
                });
            }
        }
    }
    return found;
}

/** A universal restriction `∀S.F` on every element of a subject, cited or from a range or domain axiom. */
interface Universal {
    readonly property: string;
    readonly filler: ClassExpression;
}

export function universals(premises: HornPremises, subject: HornSubject): ReadonlyArray<Universal> {
    const found: Universal[] = [];
    for (const expression of premises.classesOf(subject)) {
        if (expression.kind === 'ObjectAllValuesFrom') {
            found.push({ property: propertyKey(expression.property), filler: expression.filler });
        }
    }
    for (const axiom of premises.axioms) {
        if (axiom.kind === 'PropertyRange' && axiom.propertyKind === 'ObjectProperty') {
            found.push({
                property: axiom.property,
                filler: typeof axiom.range === 'string' ? { kind: 'NamedClass', iri: axiom.range } : axiom.range,
            });
        }
        // `∃S.⊤ ⊑ F` is `⊤ ⊑ ∀S⁻.F`: every element's S-predecessors are in F.
        if (axiom.kind === 'PropertyDomain' && axiom.propertyKind === 'ObjectProperty') {
            found.push({ property: invertKey(axiom.property), filler: axiom.domain });
        }
    }
    return found;
}

/** A maximum cardinality `≤n S.F` on every element of a subject, cited or from a functionality axiom. */
interface AtMost {
    readonly cardinality: 0 | 1;
    readonly property: string;
    readonly filler: ClassExpression;
}

export function atMost(premises: HornPremises, subject: HornSubject): ReadonlyArray<AtMost> {
    const found: AtMost[] = [];
    for (const expression of premises.classesOf(subject)) {
        if (expression.kind === 'ObjectMaxCardinality') {
            found.push({
                cardinality: expression.cardinality,
                property: propertyKey(expression.property),
                filler: expression.filler,
            });
        }
    }
    for (const axiom of premises.axioms) {
        if (axiom.kind === 'FunctionalObjectProperty') {
            found.push({ cardinality: 1, property: propertyKey(axiom.property), filler: THING });
        }
        if (axiom.kind === 'InverseFunctionalObjectProperty') {
            found.push({ cardinality: 1, property: invertKey(propertyKey(axiom.property)), filler: THING });
        }
    }
    return found;
}

export { NOTHING, THING, invertKey, key as expressionKey, propertyKey, sameLiteral, subjectKey };
