// Class and property expressions of profile V2: the IRIs they name, the positions they are admitted in, and whether an
// axiom stays inside V1 (which the engine decides with the V1 procedure) or needs the Horn calculus.
import type { ClassExpression, NormalizedAxiom, ObjectPropertyExpression } from './schema.js';

/** The named property of a property expression, and whether the expression is its inverse. */
export function propertyParts(property: ObjectPropertyExpression): { readonly iri: string; readonly inverse: boolean } {
    return typeof property === 'string' ? { iri: property, inverse: false } : { iri: property.property, inverse: true };
}

/** Every IRI a class expression names: classes, properties and opaque construct IRIs. */
export function classExpressionIris(expression: ClassExpression): ReadonlyArray<string> {
    switch (expression.kind) {
        case 'NamedClass':
            return [expression.iri];
        case 'ObjectUnionOf':
            return expression.operands;
        case 'ObjectIntersectionOf':
            return expression.operands.flatMap(classExpressionIris);
        case 'ObjectSomeValuesFrom':
        case 'ObjectAllValuesFrom':
        case 'ObjectMaxCardinality':
            return [propertyParts(expression.property).iri, ...classExpressionIris(expression.filler)];
        case 'ObjectComplementOf':
            return classExpressionIris(expression.operand);
        case 'OpaqueClassExpression':
            return [expression.constructIri];
        case 'CyclicClassExpression':
            return [];
    }
}

/** Every class expression an axiom contains at its top level. */
export function axiomClassExpressions(axiom: NormalizedAxiom): ReadonlyArray<ClassExpression> {
    switch (axiom.kind) {
        case 'SubClassOf':
            return [axiom.subClass, axiom.superClass];
        case 'ClassAssertion':
            return [axiom.classExpression];
        case 'PropertyDomain':
            return [axiom.domain];
        case 'PropertyRange':
            return typeof axiom.range === 'string' ? [] : [axiom.range];
        case 'EquivalentClasses':
        case 'DisjointClasses':
            return axiom.classes;
        default:
            return [];
    }
}

/** Whether some expression in the tree satisfies `test`. */
export function someClassExpression(
    expression: ClassExpression,
    test: (expression: ClassExpression) => boolean,
): boolean {
    if (test(expression)) {
        return true;
    }
    switch (expression.kind) {
        case 'ObjectIntersectionOf':
            return expression.operands.some((operand) => someClassExpression(operand, test));
        case 'ObjectSomeValuesFrom':
        case 'ObjectAllValuesFrom':
        case 'ObjectMaxCardinality':
            return someClassExpression(expression.filler, test);
        case 'ObjectComplementOf':
            return someClassExpression(expression.operand, test);
        default:
            return false;
    }
}

/**
 * Whether the Horn calculus admits an expression where something is asserted to be in it (`positive`: a superclass, a
 * range or domain, a class assertion) or tested against it (`negative`: a subclass, a disjointness member). Nesting
 * keeps the polarity, except under a complement and in the filler of a maximum cardinality.
 */
export function admittedAt(expression: ClassExpression, positive: boolean): boolean {
    switch (expression.kind) {
        case 'NamedClass':
            return true;
        case 'ObjectIntersectionOf':
            return expression.operands.every((operand) => admittedAt(operand, positive));
        case 'ObjectSomeValuesFrom':
            return admittedAt(expression.filler, positive);
        case 'ObjectUnionOf':
            return !positive;
        case 'ObjectAllValuesFrom':
            return positive && admittedAt(expression.filler, true);
        case 'ObjectMaxCardinality':
            return positive && admittedAt(expression.filler, false);
        case 'ObjectComplementOf':
            return positive && admittedAt(expression.operand, false);
        case 'OpaqueClassExpression':
        case 'CyclicClassExpression':
            return false;
    }
}

/** Whether every class expression of an axiom is in a position profile V2 admits. */
export function hasAdmittedExpressions(axiom: NormalizedAxiom): boolean {
    switch (axiom.kind) {
        case 'SubClassOf':
            return admittedAt(axiom.subClass, false) && admittedAt(axiom.superClass, true);
        case 'ClassAssertion':
            return admittedAt(axiom.classExpression, true);
        case 'PropertyDomain':
            if (axiom.propertyKind === 'AnnotationProperty') {
                return axiom.domain.kind === 'NamedClass';
            }
            return (
                (axiom.domain.kind === 'ObjectUnionOf' && axiom.domain.operands.length >= 2) ||
                admittedAt(axiom.domain, true)
            );
        case 'PropertyRange':
            return (
                typeof axiom.range === 'string' ||
                (axiom.propertyKind === 'ObjectProperty' &&
                    axiom.range.kind !== 'NamedClass' &&
                    admittedAt(axiom.range, true))
            );
        case 'EquivalentClasses':
            return axiom.classes.every((item) => admittedAt(item, true) && admittedAt(item, false));
        case 'DisjointClasses':
            return axiom.classes.every((item) => admittedAt(item, false));
        default:
            return true;
    }
}

/** Whether an axiom is inside the V1 allow-list exactly as V1 admits it (decided by the V1 procedure). */
export function isV1Axiom(axiom: NormalizedAxiom): boolean {
    switch (axiom.kind) {
        case 'SubClassOf':
            return axiom.subClass.kind === 'NamedClass' && axiom.superClass.kind === 'NamedClass';
        case 'ClassAssertion':
            return axiom.classExpression.kind === 'NamedClass';
        case 'EquivalentClasses':
        case 'DisjointClasses':
            return axiom.classes.every((item) => item.kind === 'NamedClass');
        case 'PropertyDomain':
            return axiom.domain.kind === 'NamedClass' || axiom.domain.kind === 'ObjectUnionOf';
        case 'PropertyRange':
            return typeof axiom.range === 'string';
        case 'SubObjectPropertyOf':
        case 'EquivalentObjectProperties':
        case 'FunctionalObjectProperty':
        case 'InverseFunctionalObjectProperty':
        case 'SymmetricObjectProperty':
        case 'SubDataPropertyOf':
        case 'EquivalentDataProperties':
        case 'FunctionalDataProperty':
            return false;
        default:
            return true;
    }
}

/** Every IRI an axiom names, in no particular order. */
export function axiomIris(axiom: NormalizedAxiom): ReadonlyArray<string> {
    const graph = axiom.graph.kind === 'NamedGraph' ? [axiom.graph.iri] : [];
    const expressions = axiomClassExpressions(axiom).flatMap(classExpressionIris);
    switch (axiom.kind) {
        case 'Declaration':
            return [...graph, axiom.iri];
        case 'SubClassOf':
        case 'EquivalentClasses':
        case 'DisjointClasses':
            return [...graph, ...expressions];
        case 'ClassAssertion':
            return [...graph, axiom.individual, ...expressions];
        case 'PropertyDomain':
            return [...graph, axiom.property, ...expressions];
        case 'PropertyRange':
            return [...graph, axiom.property, ...(typeof axiom.range === 'string' ? [axiom.range] : expressions)];
        case 'InverseObjectProperties':
            return [...graph, axiom.left, axiom.right];
        case 'TransitiveObjectProperty':
        case 'SymmetricObjectProperty':
        case 'FunctionalDataProperty':
            return [...graph, axiom.property];
        case 'FunctionalObjectProperty':
        case 'InverseFunctionalObjectProperty':
            return [...graph, propertyParts(axiom.property).iri];
        case 'SubObjectPropertyOf':
            return [
                ...graph,
                ...(typeof axiom.subProperty !== 'string' && axiom.subProperty.kind === 'ObjectPropertyChain'
                    ? axiom.subProperty.properties.map((property) => propertyParts(property).iri)
                    : [propertyParts(axiom.subProperty).iri]),
                propertyParts(axiom.superProperty).iri,
            ];
        case 'EquivalentObjectProperties':
            return [...graph, ...axiom.properties.map((property) => propertyParts(property).iri)];
        case 'SubDataPropertyOf':
            return [...graph, axiom.subProperty, axiom.superProperty];
        case 'EquivalentDataProperties':
            return [...graph, ...axiom.properties];
        case 'ObjectPropertyAssertion':
            return [...graph, axiom.property, axiom.subject, axiom.object];
        case 'DataPropertyAssertion':
            return [...graph, axiom.property, axiom.subject, axiom.value.datatype];
        case 'AnnotationAssertion':
            return [
                ...graph,
                axiom.property,
                axiom.subject,
                ...(typeof axiom.value === 'string' ? [axiom.value] : [axiom.value.datatype]),
            ];
        case 'Import':
            return [...graph, axiom.ontology];
        case 'OpaqueAxiom':
            return [...graph, axiom.constructIri];
    }
}
