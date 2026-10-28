import { ERDEN_PROOF_CHECKER_SPEC } from './profile.js';
import type { DecidedResult, Literal, NormalizedAxiom } from './schema.js';

export type ProofValidationIssue =
    | 'derivation-cycle'
    | 'duplicate-inferred-id'
    | 'invalid-inconsistency-evidence'
    | 'invalid-unsatisfiable-evidence'
    | 'missing-proof-premise'
    | 'not-entailed'
    | 'unknown-proof-rule';

export type DecidedEvidence = Omit<DecidedResult, 'certificate'>;
type Inferred = DecidedEvidence['inferred'][number];
type AtomicObject = string | Literal;
export interface AtomicStatement {
    readonly subject: string;
    readonly predicate: string;
    readonly object: AtomicObject;
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const OWL_THING = 'http://www.w3.org/2002/07/owl#Thing';
const OWL_NOTHING = 'http://www.w3.org/2002/07/owl#Nothing';

/**
 * The most operand combinations one `union-domain-type` proof may ask the checker to examine:
 * the product of the operand counts of the union domains it cites.
 */
export const MAX_UNION_CASES: number = ERDEN_PROOF_CHECKER_SPEC.maxUnionCases;

function sameObject(left: AtomicObject, right: AtomicObject): boolean {
    if (typeof left === 'string' || typeof right === 'string') {
        return left === right;
    }
    return (
        left.lexicalForm === right.lexicalForm && left.datatype === right.datatype && left.language === right.language
    );
}

function sameStatement(left: AtomicStatement, right: AtomicStatement): boolean {
    return (
        left.subject === right.subject && left.predicate === right.predicate && sameObject(left.object, right.object)
    );
}

export function atomicFromAxiom(axiom: NormalizedAxiom): AtomicStatement | undefined {
    switch (axiom.kind) {
        case 'SubClassOf':
            return axiom.subClass.kind === 'NamedClass' && axiom.superClass.kind === 'NamedClass'
                ? { subject: axiom.subClass.iri, predicate: RDFS_SUBCLASS, object: axiom.superClass.iri }
                : undefined;
        case 'ClassAssertion':
            return axiom.classExpression.kind === 'NamedClass'
                ? { subject: axiom.individual, predicate: RDF_TYPE, object: axiom.classExpression.iri }
                : undefined;
        case 'ObjectPropertyAssertion':
            return { subject: axiom.subject, predicate: axiom.property, object: axiom.object };
        case 'DataPropertyAssertion':
            return { subject: axiom.subject, predicate: axiom.property, object: axiom.value };
        case 'AnnotationAssertion':
            return { subject: axiom.subject, predicate: axiom.property, object: axiom.value };
        default:
            return undefined;
    }
}

function asAtomic(statement: Inferred): AtomicStatement {
    return {
        subject: statement.subject,
        predicate: statement.predicate,
        object: statement.object,
    };
}

function asNamedClassAssertion(axiom: NormalizedAxiom) {
    return axiom.kind === 'ClassAssertion' && axiom.classExpression.kind === 'NamedClass'
        ? { id: axiom.id, individual: axiom.individual, classIri: axiom.classExpression.iri }
        : undefined;
}

function isType(statement: AtomicStatement): statement is AtomicStatement & {
    readonly object: string;
} {
    return statement.predicate === RDF_TYPE && typeof statement.object === 'string';
}
function isSubclass(statement: AtomicStatement): statement is AtomicStatement & {
    readonly object: string;
} {
    return statement.predicate === RDFS_SUBCLASS && typeof statement.object === 'string';
}

/** The named classes `start` reaches through the subclass statements among the premises. */
function upward(start: Iterable<string>, premiseAtoms: ReadonlyArray<AtomicStatement>): Set<string> {
    const reached = new Set(start);
    const pending = [...reached];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        for (const atom of premiseAtoms) {
            if (isSubclass(atom) && atom.subject === next && !reached.has(atom.object)) {
                reached.add(atom.object);
                pending.push(atom.object);
            }
        }
    }
    return reached;
}

/** Whether a premise axiom names `individual` as an individual of the ontology. */
function namesIndividual(axiom: NormalizedAxiom, individual: string): boolean {
    switch (axiom.kind) {
        case 'ClassAssertion':
            return axiom.individual === individual;
        case 'ObjectPropertyAssertion':
            return axiom.subject === individual || axiom.object === individual;
        case 'DataPropertyAssertion':
            return axiom.subject === individual;
        case 'Declaration':
            return axiom.entityKind === 'NamedIndividual' && axiom.iri === individual;
        default:
            return false;
    }
}

/**
 * `owl:Thing ⊑ D` through the premises' subclass statements, for an individual that a premise
 * names or types: every individual is an `owl:Thing`.
 */
function thingSubclassEntails(
    conclusion: AtomicStatement,
    premiseAxioms: ReadonlyArray<NormalizedAxiom>,
    premiseAtoms: ReadonlyArray<AtomicStatement>,
): boolean {
    if (!isType(conclusion) || conclusion.object === OWL_THING) {
        return false;
    }
    const individual = conclusion.subject;
    const named =
        premiseAtoms.some((atom) => isType(atom) && atom.subject === individual) ||
        premiseAxioms.some((axiom) => namesIndividual(axiom, individual));
    return named && upward([OWL_THING], premiseAtoms).has(conclusion.object);
}

/**
 * Case analysis over the union domains the subject falls under. Each cited union domain with a
 * cited assertion of its property about the subject puts it in one of the union's operands. In
 * every combination of one operand per union, together with the subject's cited types and
 * `owl:Thing`, the classes reached through the cited subclass statements must either include the
 * conclusion or show the combination impossible: `owl:Nothing`, or two members of a cited
 * `DisjointClasses` axiom. At least one combination must be possible.
 */
function unionDomainEntails(
    conclusion: AtomicStatement,
    premiseAxioms: ReadonlyArray<NormalizedAxiom>,
    premiseAtoms: ReadonlyArray<AtomicStatement>,
): boolean {
    if (!isType(conclusion)) {
        return false;
    }
    const individual = conclusion.subject;
    const unions = new Map<string, ReadonlyArray<string>>();
    for (const axiom of premiseAxioms) {
        if (
            axiom.kind !== 'PropertyDomain' ||
            axiom.domain.kind !== 'ObjectUnionOf' ||
            (axiom.propertyKind !== 'ObjectProperty' && axiom.propertyKind !== 'DataProperty')
        ) {
            continue;
        }
        const objectProperty = axiom.propertyKind === 'ObjectProperty';
        const asserted = premiseAtoms.some(
            (atom) =>
                atom.subject === individual &&
                atom.predicate === axiom.property &&
                (typeof atom.object === 'string') === objectProperty,
        );
        if (asserted) {
            unions.set(JSON.stringify(axiom.domain.operands), axiom.domain.operands);
        }
    }
    const operandLists = [...unions.values()];
    const cases = operandLists.reduce((product, operands) => product * operands.length, 1);
    if (operandLists.length === 0 || cases > MAX_UNION_CASES) {
        return false;
    }
    const types = premiseAtoms.flatMap((atom) => (isType(atom) && atom.subject === individual ? [atom.object] : []));
    const disjoint = premiseAxioms.flatMap((axiom) =>
        axiom.kind === 'DisjointClasses'
            ? [axiom.classes.flatMap((item) => (item.kind === 'NamedClass' ? [item.iri] : []))]
            : [],
    );
    let possible = false;
    for (let index = 0; index < cases; index += 1) {
        let rest = index;
        const chosen = operandLists.map((operands) => {
            const operand = operands[rest % operands.length] as string;
            rest = Math.floor(rest / operands.length);
            return operand;
        });
        const reached = upward([...types, ...chosen, OWL_THING], premiseAtoms);
        const impossible =
            reached.has(OWL_NOTHING) ||
            disjoint.some((members) => members.filter((member) => reached.has(member)).length >= 2);
        if (impossible) {
            continue;
        }
        possible = true;
        if (!reached.has(conclusion.object)) {
            return false;
        }
    }
    return possible;
}

export function v1RuleEntails(
    statement: Inferred,
    premiseAxioms: ReadonlyArray<NormalizedAxiom>,
    premiseAtoms: ReadonlyArray<AtomicStatement>,
): boolean {
    const conclusion = asAtomic(statement);
    const rule: string = statement.provenance.rule;
    switch (rule) {
        case 'thing-subclass-type':
            return thingSubclassEntails(conclusion, premiseAxioms, premiseAtoms);
        case 'union-domain-type':
            return unionDomainEntails(conclusion, premiseAxioms, premiseAtoms);
        case 'subclass-type':
            return premiseAtoms.some(
                (type) =>
                    isType(type) &&
                    premiseAtoms.some(
                        (subclass) =>
                            isSubclass(subclass) &&
                            type.object === subclass.subject &&
                            sameStatement(conclusion, {
                                subject: type.subject,
                                predicate: RDF_TYPE,
                                object: subclass.object,
                            }),
                    ),
            );
        case 'subclass-transitive':
            return premiseAtoms.some(
                (left) =>
                    isSubclass(left) &&
                    premiseAtoms.some(
                        (right) =>
                            isSubclass(right) &&
                            left.object === right.subject &&
                            sameStatement(conclusion, {
                                subject: left.subject,
                                predicate: RDFS_SUBCLASS,
                                object: right.object,
                            }),
                    ),
            );
        case 'object-property-domain':
        case 'data-property-domain': {
            const propertyKind = rule === 'object-property-domain' ? 'ObjectProperty' : 'DataProperty';
            return premiseAxioms.some(
                (domain) =>
                    domain.kind === 'PropertyDomain' &&
                    domain.propertyKind === propertyKind &&
                    domain.domain.kind === 'NamedClass' &&
                    premiseAtoms.some(
                        (assertion) =>
                            assertion.predicate === domain.property &&
                            (propertyKind === 'ObjectProperty'
                                ? typeof assertion.object === 'string'
                                : typeof assertion.object !== 'string') &&
                            sameStatement(conclusion, {
                                subject: assertion.subject,
                                predicate: RDF_TYPE,
                                object: domain.domain.kind === 'NamedClass' ? domain.domain.iri : '',
                            }),
                    ),
            );
        }
        case 'object-property-range':
            return premiseAxioms.some((range) => {
                if (
                    range.kind !== 'PropertyRange' ||
                    range.propertyKind !== 'ObjectProperty' ||
                    typeof range.range !== 'string'
                ) {
                    return false;
                }
                const rangeIri = range.range;
                return premiseAtoms.some(
                    (assertion) =>
                        assertion.predicate === range.property &&
                        typeof assertion.object === 'string' &&
                        sameStatement(conclusion, { subject: assertion.object, predicate: RDF_TYPE, object: rangeIri }),
                );
            });
        case 'equivalent-class-subclass':
            return (
                conclusion.predicate === RDFS_SUBCLASS &&
                typeof conclusion.object === 'string' &&
                premiseAxioms.some(
                    (equivalence) =>
                        equivalence.kind === 'EquivalentClasses' &&
                        equivalence.classes.some(
                            (item) => item.kind === 'NamedClass' && item.iri === conclusion.subject,
                        ) &&
                        equivalence.classes.some(
                            (item) => item.kind === 'NamedClass' && item.iri === conclusion.object,
                        ),
                )
            );
        case 'equivalent-class-type':
            return (
                conclusion.predicate === RDF_TYPE &&
                typeof conclusion.object === 'string' &&
                premiseAxioms.some(
                    (equivalence) =>
                        equivalence.kind === 'EquivalentClasses' &&
                        equivalence.classes.some(
                            (item) => item.kind === 'NamedClass' && item.iri === conclusion.object,
                        ) &&
                        premiseAtoms.some(
                            (type) =>
                                isType(type) &&
                                type.subject === conclusion.subject &&
                                equivalence.classes.some(
                                    (item) => item.kind === 'NamedClass' && item.iri === type.object,
                                ),
                        ),
                )
            );
        case 'inverse-object-property':
            return premiseAxioms.some(
                (inverse) =>
                    inverse.kind === 'InverseObjectProperties' &&
                    premiseAtoms.some(
                        (assertion) =>
                            typeof assertion.object === 'string' &&
                            ((assertion.predicate === inverse.left &&
                                sameStatement(conclusion, {
                                    subject: assertion.object,
                                    predicate: inverse.right,
                                    object: assertion.subject,
                                })) ||
                                (assertion.predicate === inverse.right &&
                                    sameStatement(conclusion, {
                                        subject: assertion.object,
                                        predicate: inverse.left,
                                        object: assertion.subject,
                                    }))),
                    ),
            );
        case 'transitive-object-property':
            return premiseAxioms.some(
                (transitive) =>
                    transitive.kind === 'TransitiveObjectProperty' &&
                    premiseAtoms.some(
                        (left) =>
                            left.predicate === transitive.property &&
                            typeof left.object === 'string' &&
                            premiseAtoms.some(
                                (right) =>
                                    right.predicate === transitive.property &&
                                    right.subject === left.object &&
                                    typeof right.object === 'string' &&
                                    sameStatement(conclusion, {
                                        subject: left.subject,
                                        predicate: transitive.property,
                                        object: right.object,
                                    }),
                            ),
                    ),
            );
        default:
            return false;
    }
}

export function hasValidInconsistencyEvidence(
    axioms: ReadonlyMap<string, NormalizedAxiom>,
    evidence: DecidedEvidence,
): boolean {
    return evidence.diagnostics.some((diagnostic) => {
        if (diagnostic.code !== 'disjoint-class-assertions') {
            return false;
        }
        const referenced = diagnostic.axiomIds.flatMap((id) => {
            const axiom = axioms.get(id);
            return axiom === undefined ? [] : [axiom];
        });
        const assertions = referenced.flatMap((axiom) => {
            const assertion = asNamedClassAssertion(axiom);
            return assertion === undefined ? [] : [assertion];
        });
        return referenced.some(
            (disjoint) =>
                disjoint.kind === 'DisjointClasses' &&
                assertions.some((left) =>
                    assertions.some(
                        (right) =>
                            right.individual === left.individual &&
                            // Two assertions of one class (the same triple in two sources) are
                            // consistent with any disjointness: the witness needs two classes.
                            right.classIri !== left.classIri &&
                            disjoint.classes.some((item) => item.kind === 'NamedClass' && item.iri === left.classIri) &&
                            disjoint.classes.some((item) => item.kind === 'NamedClass' && item.iri === right.classIri),
                    ),
                ),
        );
    });
}

export function hasValidUnsatisfiableEvidence(
    item: DecidedEvidence['unsatisfiableClasses'][number],
    axioms: ReadonlyMap<string, NormalizedAxiom>,
    inferred: ReadonlyMap<string, Inferred>,
): boolean {
    const premiseAxioms = item.premiseIds.flatMap((id) => {
        const axiom = axioms.get(id);
        return axiom === undefined ? [] : [axiom];
    });
    const premiseAtoms = item.premiseIds.flatMap((id) => {
        const axiom = axioms.get(id);
        const statement = inferred.get(id);
        const atomic = axiom === undefined ? undefined : atomicFromAxiom(axiom);
        return atomic === undefined ? (statement === undefined ? [] : [asAtomic(statement)]) : [atomic];
    });
    return premiseAxioms.some(
        (disjoint) =>
            disjoint.kind === 'DisjointClasses' &&
            disjoint.classes.some(
                (left) =>
                    left.kind === 'NamedClass' &&
                    premiseAtoms.some(
                        (subclass) =>
                            isSubclass(subclass) && subclass.subject === item.classIri && subclass.object === left.iri,
                    ) &&
                    disjoint.classes.some(
                        (right) =>
                            right.kind === 'NamedClass' &&
                            right.iri !== left.iri &&
                            premiseAtoms.some(
                                (subclass) =>
                                    isSubclass(subclass) &&
                                    subclass.subject === item.classIri &&
                                    subclass.object === right.iri,
                            ),
                    ),
            ),
    );
}
