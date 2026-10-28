// Proof checker v3: the check of each Horn rule. `hornEntails` returns whether a conclusion follows from the cited
// premises by the named rule of the Horn calculus.
import {
    atMost,
    contextParts,
    expressionKey,
    invertKey,
    makeContext,
    NOTHING,
    propertyKey,
    sameLiteral,
    subjectKey,
    successors,
    universals,
    type HornFact,
    type HornPremises,
    type HornSubject,
    type HornSuccessor,
} from './proof-horn.js';
import type { ClassExpression } from './schema.js';

type ClassFact = Extract<HornFact, { readonly kind: 'class' }>;

function isNothing(expression: ClassExpression): boolean {
    return expressionKey(expression) === expressionKey(NOTHING);
}

/** The parts a context adds to another (by key). */
function addedParts(from: ClassExpression, to: ClassExpression): ReadonlyArray<ClassExpression> {
    const have = new Set(contextParts(from).map(expressionKey));
    return contextParts(to).filter((part) => !have.has(expressionKey(part)));
}

/** Whether `expression` is one of the conjuncts of `context`, or the context itself. */
function partOf(expression: ClassExpression, context: ClassExpression): boolean {
    const wanted = expressionKey(expression);
    return expressionKey(context) === wanted || contextParts(context).some((part) => expressionKey(part) === wanted);
}

function anonymous(premises: HornPremises, subject: HornSubject): ReadonlyArray<HornSuccessor> {
    return successors(premises, subject).filter((item) => !item.named);
}

/** The individuals the cited edges mention, each as a subject. */
function edgeIndividuals(premises: HornPremises): ReadonlyArray<HornSubject> {
    const iris = new Set<string>();
    for (const fact of premises.facts) {
        if (fact.kind === 'edge') {
            iris.add(fact.subject);
            iris.add(fact.object);
        }
    }
    return [...iris].sort().map((individual) => ({ kind: 'individual', individual }));
}

function told(conclusion: ClassFact, premises: HornPremises): boolean {
    const target = expressionKey(conclusion.expression);
    return premises.axioms.some((axiom) => {
        if (axiom.kind === 'SubClassOf') {
            return expressionKey(axiom.superClass) === target && premises.holds(conclusion.subject, axiom.subClass);
        }
        if (axiom.kind === 'EquivalentClasses') {
            return (
                axiom.classes.some((item) => expressionKey(item) === target) &&
                axiom.classes.some((item) => premises.holds(conclusion.subject, item))
            );
        }
        return false;
    });
}

function existsIntro(conclusion: ClassFact, premises: HornPremises): boolean {
    const expression = conclusion.expression;
    if (expression.kind !== 'ObjectSomeValuesFrom') {
        return false;
    }
    const wanted = propertyKey(expression.property);
    return successors(premises, conclusion.subject).some(
        (successor) =>
            premises.subProperty(successor.property, wanted) && premises.holds(successor.target, expression.filler),
    );
}

/** `X ⊑ ∃R.K'` from `X ⊑ ∃R.K`, where `K'` adds to `K` exactly the parts `extra` accepts. */
function refines(
    conclusion: ClassFact,
    premises: HornPremises,
    extra: (successor: HornSuccessor, added: ReadonlyArray<ClassExpression>) => boolean,
): boolean {
    const expression = conclusion.expression;
    if (expression.kind !== 'ObjectSomeValuesFrom') {
        return false;
    }
    const wanted = propertyKey(expression.property);
    return anonymous(premises, conclusion.subject).some((successor) => {
        if (successor.property !== wanted || successor.target.kind !== 'context') {
            return false;
        }
        const from = successor.target.context;
        if (expressionKey(makeContext([from, expression.filler])) !== expressionKey(makeContext([expression.filler]))) {
            return false;
        }
        return extra(successor, addedParts(from, expression.filler));
    });
}

function forallFiller(conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    if (
        refines(conclusion, premises, (successor, added) =>
            added.every((part) =>
                universals(premises, subject).some(
                    (universal) =>
                        premises.subProperty(successor.property, universal.property) && partOf(part, universal.filler),
                ),
            ),
        )
    ) {
        return true;
    }
    // Named: an individual reached by an edge is in the filler of a universal restriction on its predecessor.
    return edgeIndividuals(premises).some((predecessor) =>
        successors(premises, predecessor).some(
            (successor) =>
                successor.named &&
                subjectKey(successor.target) === subjectKey(subject) &&
                universals(premises, predecessor).some(
                    (universal) =>
                        premises.subProperty(successor.property, universal.property) &&
                        expressionKey(universal.filler) === expressionKey(conclusion.expression),
                ),
        ),
    );
}

function inversePushback(conclusion: ClassFact, premises: HornPremises): boolean {
    const wanted = expressionKey(conclusion.expression);
    return successors(premises, conclusion.subject).some((successor) =>
        universals(premises, successor.target).some(
            (universal) =>
                premises.subProperty(invertKey(successor.property), universal.property) &&
                expressionKey(universal.filler) === wanted,
        ),
    );
}

function inverseFiller(conclusion: ClassFact, premises: HornPremises): boolean {
    return refines(conclusion, premises, (successor, added) =>
        added.every(
            (part) =>
                part.kind === 'ObjectSomeValuesFrom' &&
                premises.subProperty(invertKey(successor.property), propertyKey(part.property)) &&
                premises.holds(conclusion.subject, part.filler),
        ),
    );
}

function transitiveThrough(premises: HornPremises, via: string, transitive: string, universal: string): boolean {
    return (
        premises.isTransitive(transitive) &&
        premises.subProperty(via, transitive) &&
        premises.subProperty(transitive, universal)
    );
}

function transitiveFiller(conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    if (
        refines(conclusion, premises, (successor, added) =>
            added.every(
                (part) =>
                    part.kind === 'ObjectAllValuesFrom' &&
                    universals(premises, subject).some(
                        (universal) =>
                            transitiveThrough(
                                premises,
                                successor.property,
                                propertyKey(part.property),
                                universal.property,
                            ) && expressionKey(universal.filler) === expressionKey(part.filler),
                    ),
            ),
        )
    ) {
        return true;
    }
    const expression = conclusion.expression;
    if (expression.kind !== 'ObjectAllValuesFrom') {
        return false;
    }
    const transitive = propertyKey(expression.property);
    return edgeIndividuals(premises).some((predecessor) =>
        successors(premises, predecessor).some(
            (successor) =>
                successor.named &&
                subjectKey(successor.target) === subjectKey(subject) &&
                universals(premises, predecessor).some(
                    (universal) =>
                        transitiveThrough(premises, successor.property, transitive, universal.property) &&
                        expressionKey(universal.filler) === expressionKey(expression.filler),
                ),
        ),
    );
}

function transitivePushback(conclusion: ClassFact, premises: HornPremises): boolean {
    const expression = conclusion.expression;
    if (expression.kind !== 'ObjectAllValuesFrom') {
        return false;
    }
    const transitive = propertyKey(expression.property);
    return successors(premises, conclusion.subject).some((successor) =>
        universals(premises, successor.target).some(
            (universal) =>
                transitiveThrough(premises, invertKey(successor.property), transitive, universal.property) &&
                expressionKey(universal.filler) === expressionKey(expression.filler),
        ),
    );
}

/** `X ⊑ ∃T.G` from `X ⊑ ∃R₁.K` and `K ⊑ ∃R₂.G` (or named edges), `R₁, R₂ ⊑* T`, `T` transitive. */
function transitiveExists(conclusion: ClassFact, premises: HornPremises): boolean {
    const expression = conclusion.expression;
    if (expression.kind !== 'ObjectSomeValuesFrom') {
        return false;
    }
    const transitive = propertyKey(expression.property);
    const filler = expressionKey(expression.filler);
    return (
        premises.isTransitive(transitive) &&
        successors(premises, conclusion.subject).some(
            (first) =>
                premises.subProperty(first.property, transitive) &&
                successors(premises, first.target).some(
                    (second) =>
                        !second.named &&
                        second.target.kind === 'context' &&
                        premises.subProperty(second.property, transitive) &&
                        expressionKey(second.target.context) === filler,
                ),
        )
    );
}

function functionalMerge(conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    const expression = conclusion.expression;
    if (expression.kind !== 'ObjectSomeValuesFrom') {
        return false;
    }
    const wanted = propertyKey(expression.property);
    const links = anonymous(premises, subject);
    return atMost(premises, subject).some(
        (limit) =>
            limit.cardinality === 1 &&
            links.some(
                (first) =>
                    first.property === wanted &&
                    first.target.kind === 'context' &&
                    premises.subProperty(first.property, limit.property) &&
                    premises.holds(first.target, limit.filler) &&
                    links.some(
                        (second) =>
                            second.target.kind === 'context' &&
                            premises.subProperty(second.property, limit.property) &&
                            premises.holds(second.target, limit.filler) &&
                            first.target.kind === 'context' &&
                            expressionKey(makeContext([first.target.context, second.target.context])) ===
                                expressionKey(makeContext([expression.filler])),
                    ),
            ),
    );
}

function functionalPushback(conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    return successors(premises, subject).some((first) =>
        atMost(premises, first.target).some(
            (limit) =>
                limit.cardinality === 1 &&
                premises.subProperty(invertKey(first.property), limit.property) &&
                premises.holds(subject, limit.filler) &&
                anonymous(premises, first.target).some((second) => {
                    if (
                        second.target.kind !== 'context' ||
                        !premises.subProperty(second.property, limit.property) ||
                        !premises.holds(second.target, limit.filler)
                    ) {
                        return false;
                    }
                    if (partOf(conclusion.expression, second.target.context)) {
                        return true;
                    }
                    const expression = conclusion.expression;
                    return (
                        expression.kind === 'ObjectSomeValuesFrom' &&
                        first.target.kind === 'context' &&
                        propertyKey(expression.property) === invertKey(second.property) &&
                        expressionKey(expression.filler) === expressionKey(first.target.context)
                    );
                }),
        ),
    );
}

function maxZero(conclusion: ClassFact, premises: HornPremises): boolean {
    return (
        isNothing(conclusion.expression) &&
        successors(premises, conclusion.subject).some((successor) =>
            atMost(premises, conclusion.subject).some(
                (limit) =>
                    limit.cardinality === 0 &&
                    premises.subProperty(successor.property, limit.property) &&
                    premises.holds(successor.target, limit.filler),
            ),
        )
    );
}

/** `X ⊑ owl:Nothing` from a successor `K` of `X` (through `R`) with `≤0 S.F`, `Inv(R) ⊑* S` and `X ⊑ F`. */
function maxZeroPushback(conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    return (
        isNothing(conclusion.expression) &&
        successors(premises, subject).some((successor) =>
            atMost(premises, successor.target).some(
                (limit) =>
                    limit.cardinality === 0 &&
                    premises.subProperty(invertKey(successor.property), limit.property) &&
                    premises.holds(subject, limit.filler),
            ),
        )
    );
}

function disjoint(conclusion: ClassFact, premises: HornPremises): boolean {
    return (
        isNothing(conclusion.expression) &&
        premises.axioms.some(
            (axiom) =>
                axiom.kind === 'DisjointClasses' &&
                axiom.classes.some((left) =>
                    axiom.classes.some(
                        (right) =>
                            expressionKey(left) !== expressionKey(right) &&
                            premises.holds(conclusion.subject, left) &&
                            premises.holds(conclusion.subject, right),
                    ),
                ),
        )
    );
}

function complement(conclusion: ClassFact, premises: HornPremises): boolean {
    return (
        isNothing(conclusion.expression) &&
        premises
            .classesOf(conclusion.subject)
            .some(
                (expression) =>
                    expression.kind === 'ObjectComplementOf' && premises.holds(conclusion.subject, expression.operand),
            )
    );
}

function unionCase(conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    const known = new Set(premises.classesOf(subject).map(expressionKey));
    const target = expressionKey(conclusion.expression);
    const cases = premises.facts.filter(
        (fact): fact is ClassFact =>
            fact.kind === 'class' &&
            fact.subject.kind === 'context' &&
            (expressionKey(fact.expression) === target || isNothing(fact.expression)),
    );
    return premises.axioms.some((axiom) => {
        if (axiom.kind !== 'PropertyDomain' || axiom.domain.kind !== 'ObjectUnionOf') {
            return false;
        }
        const applies =
            axiom.propertyKind === 'ObjectProperty'
                ? successors(premises, subject).some((successor) =>
                      premises.subProperty(successor.property, axiom.property),
                  )
                : subject.kind === 'individual' &&
                  premises.facts.some(
                      (fact) =>
                          fact.kind === 'data' &&
                          fact.subject === subject.individual &&
                          premises.subDataProperty(fact.property, axiom.property),
                  );
        return (
            applies &&
            axiom.domain.operands.every(
                (operand) =>
                    // The case of the conclusion itself needs no proof.
                    expressionKey({ kind: 'NamedClass', iri: operand }) === target ||
                    cases.some(
                        (item) =>
                            item.subject.kind === 'context' &&
                            contextParts(item.subject.context).every((part) => {
                                const partKey = expressionKey(part);
                                return (
                                    known.has(partKey) ||
                                    partKey === expressionKey({ kind: 'NamedClass', iri: operand })
                                );
                            }),
                    ),
            )
        );
    });
}

function classRule(rule: string, conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    const expression = conclusion.expression;
    switch (rule) {
        case 'conjunct':
            return premises.holds(subject, expression);
        case 'told':
            return told(conclusion, premises);
        case 'and-intro':
            return (
                expression.kind === 'ObjectIntersectionOf' &&
                expression.operands.every((operand) => premises.holds(subject, operand))
            );
        case 'and-elim':
            return premises
                .classesOf(subject)
                .some(
                    (item) =>
                        item.kind === 'ObjectIntersectionOf' &&
                        item.operands.some((operand) => expressionKey(operand) === expressionKey(expression)),
                );
        case 'union-intro':
            return (
                expression.kind === 'ObjectUnionOf' &&
                expression.operands.some((operand) => premises.holds(subject, { kind: 'NamedClass', iri: operand }))
            );
        case 'exists-intro':
            return existsIntro(conclusion, premises);
        case 'exists-bottom':
            return (
                isNothing(expression) &&
                successors(premises, subject).some((successor) => premises.holds(successor.target, NOTHING))
            );
        case 'forall-filler':
            return forallFiller(conclusion, premises);
        case 'inverse-pushback':
            return inversePushback(conclusion, premises);
        case 'inverse-filler':
            return inverseFiller(conclusion, premises);
        case 'transitive-filler':
            return transitiveFiller(conclusion, premises);
        case 'transitive-pushback':
            return transitivePushback(conclusion, premises);
        case 'transitive-exists':
            return transitiveExists(conclusion, premises);
        case 'functional-merge':
            return functionalMerge(conclusion, premises);
        case 'functional-pushback':
            return functionalPushback(conclusion, premises);
        case 'functional-filler':
            return functionalFillerType(conclusion, premises);
        case 'max-zero':
            return maxZero(conclusion, premises);
        case 'max-zero-pushback':
            return maxZeroPushback(conclusion, premises);
        case 'disjoint':
            return disjoint(conclusion, premises);
        case 'complement':
            return complement(conclusion, premises);
        case 'data-domain':
            return dataDomain(conclusion, premises);
        case 'union-case':
            return unionCase(conclusion, premises);
        case 'same-as-copy':
            return sameAsCopy(conclusion, premises);
        case 'chain-exists':
            return chainExists(conclusion, premises);
        case 'chain-forall':
            return chainForall(conclusion, premises);
        default:
            return false;
    }
}

/** A property chain of a cited `SubObjectPropertyOf`, read forwards and as its inverse. */
interface ChainRule {
    readonly properties: ReadonlyArray<string>;
    readonly target: string;
}

function citedChains(premises: HornPremises): ReadonlyArray<ChainRule> {
    return premises.axioms.flatMap((axiom): ChainRule[] => {
        if (
            axiom.kind !== 'SubObjectPropertyOf' ||
            typeof axiom.subProperty === 'string' ||
            axiom.subProperty.kind !== 'ObjectPropertyChain'
        ) {
            return [];
        }
        const properties = axiom.subProperty.properties.map(propertyKey);
        const target = propertyKey(axiom.superProperty);
        return [
            { properties, target },
            { properties: [...properties].reverse().map(invertKey), target: invertKey(target) },
        ];
    });
}

/** The subjects at the end of every path from `start` along the chain's properties (through sub-properties). */
function chainEnds(
    premises: HornPremises,
    start: HornSubject,
    properties: ReadonlyArray<string>,
    namedOnly: boolean,
): ReadonlyArray<HornSubject> {
    let current: ReadonlyArray<HornSubject> = [start];
    for (const wanted of properties) {
        const next = new Map<string, HornSubject>();
        for (const subject of current) {
            for (const successor of successors(premises, subject)) {
                if ((!namedOnly || successor.named) && premises.subProperty(successor.property, wanted)) {
                    next.set(subjectKey(successor.target), successor.target);
                }
            }
        }
        current = [...next.values()];
    }
    return current;
}

/** `X ⊑ ∃S'.G`: a path from `X` along a chain `P₁ … Pₙ ⊑ S` ends in `G`, and `S ⊑* S'`. */
function chainExists(conclusion: ClassFact, premises: HornPremises): boolean {
    const expression = conclusion.expression;
    if (expression.kind !== 'ObjectSomeValuesFrom') {
        return false;
    }
    const wanted = propertyKey(expression.property);
    return citedChains(premises).some(
        (chain) =>
            premises.subProperty(chain.target, wanted) &&
            chainEnds(premises, conclusion.subject, chain.properties, false).some((end) =>
                premises.holds(end, expression.filler),
            ),
    );
}

/** `X ⊑ ∀P₁.∀P₂.…∀Pₙ.F` from `X ⊑ ∀S'.F` (or a range or domain) and a chain `P₁ … Pₙ ⊑ S ⊑* S'`. */
function chainForall(conclusion: ClassFact, premises: HornPremises): boolean {
    return citedChains(premises).some((chain) => {
        let inner: ClassExpression = conclusion.expression;
        for (const property of chain.properties) {
            if (inner.kind !== 'ObjectAllValuesFrom' || propertyKey(inner.property) !== property) {
                return false;
            }
            inner = inner.filler;
        }
        const filler = expressionKey(inner);
        return universals(premises, conclusion.subject).some(
            (universal) =>
                premises.subProperty(chain.target, universal.property) && expressionKey(universal.filler) === filler,
        );
    });
}

function reaches(premises: HornPremises, from: HornSubject, to: HornSubject, chain: ChainRule): boolean {
    return chainEnds(premises, from, chain.properties, true).some((end) => subjectKey(end) === subjectKey(to));
}

/** `a q c` from a path of named edges from `a` to `c` along a chain whose target is `q` or below it. */
function chainEdge(conclusion: Extract<HornFact, { kind: 'edge' }>, premises: HornPremises): boolean {
    const subject: HornSubject = { kind: 'individual', individual: conclusion.subject };
    const object: HornSubject = { kind: 'individual', individual: conclusion.object };
    return citedChains(premises).some(
        (chain) =>
            (premises.subProperty(chain.target, conclusion.property) && reaches(premises, subject, object, chain)) ||
            (premises.subProperty(chain.target, invertKey(conclusion.property)) &&
                reaches(premises, object, subject, chain)),
    );
}

/** For a named individual `a` and its two successors: is `limit` a functionality both fall under? */
function functionalPair(
    premises: HornPremises,
    predecessor: HornSubject,
    first: HornSuccessor,
    second: HornSuccessor,
): boolean {
    return atMost(premises, predecessor).some(
        (limit) =>
            limit.cardinality === 1 &&
            premises.subProperty(first.property, limit.property) &&
            premises.subProperty(second.property, limit.property) &&
            premises.holds(first.target, limit.filler) &&
            premises.holds(second.target, limit.filler),
    );
}

/** `c ⊑ K` for a named successor `c` that a functional restriction merges with an existential's filler `K`. */
function functionalFillerType(conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    return edgeIndividuals(premises).some((predecessor) => {
        const all = successors(premises, predecessor);
        return all.some(
            (named) =>
                named.named &&
                subjectKey(named.target) === subjectKey(subject) &&
                all.some(
                    (link) =>
                        !link.named &&
                        link.target.kind === 'context' &&
                        partOf(conclusion.expression, link.target.context) &&
                        functionalPair(premises, predecessor, named, link),
                ),
        );
    });
}

function dataDomain(conclusion: ClassFact, premises: HornPremises): boolean {
    const subject = conclusion.subject;
    return (
        subject.kind === 'individual' &&
        premises.axioms.some(
            (axiom) =>
                axiom.kind === 'PropertyDomain' &&
                axiom.propertyKind === 'DataProperty' &&
                expressionKey(axiom.domain) === expressionKey(conclusion.expression) &&
                premises.facts.some(
                    (fact) =>
                        fact.kind === 'data' &&
                        fact.subject === subject.individual &&
                        premises.subDataProperty(fact.property, axiom.property),
                ),
        )
    );
}

function sameIndividuals(premises: HornPremises): ReadonlyArray<readonly [string, string]> {
    return premises.facts.flatMap((fact) => (fact.kind === 'same' ? [[fact.left, fact.right] as const] : []));
}

/** Whether `after` is `before` with some occurrences of `from` replaced by `to`, and at least one replaced. */
function substitutes(before: ReadonlyArray<string>, after: ReadonlyArray<string>, from: string, to: string): boolean {
    let replaced = false;
    for (let index = 0; index < before.length; index += 1) {
        if (before[index] === after[index]) {
            continue;
        }
        if (before[index] !== from || after[index] !== to) {
            return false;
        }
        replaced = true;
    }
    return replaced && before.length === after.length;
}

/** A fact as its kind and content, then the individuals in it (the positions a substitution may change). */
function factShape(fact: HornFact): readonly [string, ...string[]] {
    switch (fact.kind) {
        case 'class':
            return [
                `class:${fact.subject.kind === 'context' ? subjectKey(fact.subject) : ''}:${expressionKey(fact.expression)}`,
                fact.subject.kind === 'individual' ? fact.subject.individual : '',
            ];
        case 'edge':
            return [`edge:${fact.property}`, fact.subject, fact.object];
        case 'data':
            return [
                `data:${fact.property}:${JSON.stringify([fact.value.lexicalForm, fact.value.datatype, fact.value.language])}`,
                fact.subject,
            ];
        case 'same':
            return ['same', fact.left, fact.right];
    }
}

function sameAsCopy(conclusion: HornFact, premises: HornPremises): boolean {
    const shape = factShape;
    const after = shape(conclusion);
    return sameIndividuals(premises).some(([from, to]) =>
        premises.facts.some((fact) => {
            const before = shape(fact);
            return before[0] === after[0] && substitutes(before.slice(1), after.slice(1), from, to);
        }),
    );
}

function edgeRule(rule: string, conclusion: Extract<HornFact, { kind: 'edge' }>, premises: HornPremises): boolean {
    const subject: HornSubject = { kind: 'individual', individual: conclusion.subject };
    const object = `I:${conclusion.object}`;
    switch (rule) {
        case 'sub-property':
            return successors(premises, subject).some(
                (successor) =>
                    successor.named &&
                    subjectKey(successor.target) === object &&
                    premises.subProperty(successor.property, conclusion.property),
            );
        case 'transitive-edge':
            return successors(premises, subject).some(
                (first) =>
                    first.named &&
                    successors(premises, first.target).some(
                        (second) =>
                            second.named &&
                            subjectKey(second.target) === object &&
                            transitiveEdge(premises, first.property, second.property, conclusion.property),
                    ),
            );
        case 'functional-filler':
            return functionalFillerEdge(conclusion, premises);
        case 'chain-edge':
            return chainEdge(conclusion, premises);
        case 'same-as-copy':
            return sameAsCopy(conclusion, premises);
        default:
            return false;
    }
}

/** Whether a transitive property `T` with both properties under it is the conclusion's property or under it. */
function transitiveEdge(premises: HornPremises, first: string, second: string, conclusion: string): boolean {
    return premises.axioms.some((axiom) => {
        if (axiom.kind !== 'TransitiveObjectProperty') {
            return false;
        }
        return [axiom.property, invertKey(axiom.property)].some(
            (transitive) =>
                premises.subProperty(first, transitive) &&
                premises.subProperty(second, transitive) &&
                premises.subProperty(transitive, conclusion),
        );
    });
}

/** The edge from `a` to a named successor `c` that a functional restriction merges with an existential of `a`. */
function functionalFillerEdge(conclusion: Extract<HornFact, { kind: 'edge' }>, premises: HornPremises): boolean {
    return edgeIndividuals(premises).some((predecessor) => {
        if (predecessor.kind !== 'individual') {
            return false;
        }
        const all = successors(premises, predecessor);
        return all.some(
            (named) =>
                named.named &&
                named.target.kind === 'individual' &&
                all.some((link) => {
                    if (link.named || named.target.kind !== 'individual') {
                        return false;
                    }
                    const forward =
                        conclusion.subject === predecessor.individual &&
                        conclusion.object === named.target.individual &&
                        link.property === conclusion.property;
                    const backward =
                        conclusion.subject === named.target.individual &&
                        conclusion.object === predecessor.individual &&
                        link.property === invertKey(conclusion.property);
                    return (forward || backward) && functionalPair(premises, predecessor, named, link);
                }),
        );
    });
}

function sameRule(rule: string, conclusion: Extract<HornFact, { kind: 'same' }>, premises: HornPremises): boolean {
    if (conclusion.left === conclusion.right) {
        return false;
    }
    const pairs = sameIndividuals(premises);
    switch (rule) {
        case 'functional-same-as':
            return edgeIndividuals(premises).some((predecessor) => {
                const named = successors(premises, predecessor).filter((item) => item.named);
                return named.some(
                    (first) =>
                        first.target.kind === 'individual' &&
                        first.target.individual === conclusion.left &&
                        named.some(
                            (second) =>
                                second.target.kind === 'individual' &&
                                second.target.individual === conclusion.right &&
                                functionalPair(premises, predecessor, first, second),
                        ),
                );
            });
        case 'same-as-symmetric':
            return pairs.some(([left, right]) => left === conclusion.right && right === conclusion.left);
        case 'same-as-transitive':
            return pairs.some(
                ([left, middle]) =>
                    left === conclusion.left &&
                    pairs.some(([from, right]) => from === middle && right === conclusion.right),
            );
        default:
            return false;
    }
}

function dataRule(rule: string, conclusion: Extract<HornFact, { kind: 'data' }>, premises: HornPremises): boolean {
    switch (rule) {
        case 'sub-property':
            return premises.facts.some(
                (fact) =>
                    fact.kind === 'data' &&
                    fact.subject === conclusion.subject &&
                    sameLiteral(fact.value, conclusion.value) &&
                    premises.subDataProperty(fact.property, conclusion.property),
            );
        case 'same-as-copy':
            return sameAsCopy(conclusion, premises);
        default:
            return false;
    }
}

/** Whether `conclusion` follows from `premises` by the Horn rule `rule`. */
export function hornEntails(rule: string, conclusion: HornFact, premises: HornPremises): boolean {
    switch (conclusion.kind) {
        case 'class':
            return classRule(rule, conclusion, premises);
        case 'edge':
            return edgeRule(rule, conclusion, premises);
        case 'same':
            return sameRule(rule, conclusion, premises);
        case 'data':
            return dataRule(rule, conclusion, premises);
    }
}
