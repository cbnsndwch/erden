import { DataFactory, type Quad, type Store, type Term } from 'n3';

import { OWL, RDF, RDFS, SHACL, type UnsupportedShaclConstructKind } from './model.js';

/**
 * What the bundled SHACL engine refuses, found before it runs, so the refusal names each statement and where it is
 * written. The engine, erden-shacl 0.1.0 (PurRDF purrdf-shapes 3.0.1), runs SHACL Core, SHACL-SPARQL (constraints,
 * declared constraint components, SPARQL-based targets) and SHACL-AF node expressions; it refuses, and Erden refuses
 * the step before starting it:
 *
 * - `sh:js`: SHACL-JS is not part of SHACL 1.2 and the engine has no JavaScript engine (`unsupported-shacl-js`);
 * - a constraint component the shapes declare with a SHACL-JS validator (`sh:JSValidator`), for the same reason
 *   (`shapes-ill-formed`); components with SPARQL validators run;
 * - `owl:imports` in the shapes graph: the engine fetches nothing and Erden gives it no import table
 *   (`shapes-imports`); the shapes of the project's dependencies are already checked;
 * - `sh:entailment`: SHACL requires a processor to refuse a regime it does not support, and the engine supports only
 *   SHACL-AF's `sh:RulesEntailment` (`shapes-invalid` for any other), which Erden does not offer, since rules would
 *   change the data a check validates; Erden refuses every `sh:entailment`.
 *
 * `packages/ontology/test/shacl-support.test.ts` runs every kind through the engine: the kinds below are refused by
 * it, and the constructs no longer refused (SPARQL constraints, SPARQL-based components, custom targets, node
 * expressions) are validated by it. Anything else the engine refuses is an operational failure (`SHACL_REFUSED`, exit 3). When the
 * engine changes, re-run that test and change this set to match.
 */
export const SHACL_ENGINE = Object.freeze({ name: 'erden-shacl', version: '0.1.0+purrdf.3.0.1' });
const ENGINE = `the bundled SHACL engine (${SHACL_ENGINE.name} ${SHACL_ENGINE.version})`;

const UNSUPPORTED_BY_ENGINE: ReadonlySet<UnsupportedShaclConstructKind> = new Set([
    'js-constraint',
    'constraint-component',
    'owl-imports',
    'entailment',
]);

/** One statement the engine cannot run, with the shape it affects. */
export interface UnsupportedShaclStatement {
    readonly kind: UnsupportedShaclConstructKind;
    readonly shape: string | null;
    readonly construct: string;
    readonly message: string;
    readonly statement: Quad;
}

function iri(value: string) {
    return DataFactory.namedNode(value);
}

const RDF_TYPE = iri(`${RDF}type`);
const RDFS_SUBCLASS = iri(`${RDFS}subClassOf`);
const SH_PROPERTY = iri(`${SHACL}property`);
const SH_TARGET = iri(`${SHACL}target`);
const SH_SELECT = iri(`${SHACL}select`);
const SH_ASK = iri(`${SHACL}ask`);
const SH_PARAMETER = iri(`${SHACL}parameter`);
const SH_PATH = iri(`${SHACL}path`);
const SH_CONSTRAINT_COMPONENT = iri(`${SHACL}ConstraintComponent`);
const SH_ENTAILMENT = iri(`${SHACL}entailment`);
const OWL_IMPORTS = iri(`${OWL}imports`);

const VALIDATOR_PREDICATES = ['validator', 'nodeValidator', 'propertyValidator'] as const;

const CONSTRAINT_PARAMETERS: ReadonlyArray<{
    readonly kind: UnsupportedShaclConstructKind;
    readonly parameter: string;
    readonly component: string;
    readonly what: string;
}> = [
    {
        kind: 'sparql-constraint',
        parameter: `${SHACL}sparql`,
        component: `${SHACL}SPARQLConstraintComponent`,
        what: 'a SHACL-SPARQL constraint (sh:sparql)',
    },
    {
        kind: 'js-constraint',
        parameter: `${SHACL}js`,
        component: `${SHACL}JSConstraintComponent`,
        what: 'a SHACL-JS constraint (sh:js)',
    },
    {
        kind: 'expression-constraint',
        parameter: `${SHACL}expression`,
        component: `${SHACL}ExpressionConstraintComponent`,
        what: 'a SHACL-AF node expression constraint (sh:expression)',
    },
];

function key(term: Term): string {
    return `${term.termType}:${term.value}`;
}

function localName(value: string): string {
    return value.startsWith(SHACL) ? `sh:${value.slice(SHACL.length)}` : `<${value}>`;
}

/** The named shape a statement's subject belongs to, following `sh:property` up from an anonymous property shape. */
function shapeOwner(shapes: Store, subject: Term): string | null {
    let current = subject;
    const seen = new Set<string>();
    while (current.termType === 'BlankNode' && !seen.has(key(current))) {
        seen.add(key(current));
        const owner = shapes.getQuads(null, SH_PROPERTY, current, null)[0]?.subject;
        if (owner === undefined) {
            return null;
        }
        current = owner;
    }
    return current.termType === 'NamedNode' ? current.value : null;
}

/** Classes that are `sh:ConstraintComponent` or, through `rdfs:subClassOf` in the shapes graph, a subclass of it. */
function componentClasses(shapes: Store): ReadonlyArray<Term> {
    const found = new Map<string, Term>([[key(SH_CONSTRAINT_COMPONENT), SH_CONSTRAINT_COMPONENT]]);
    const pending: Term[] = [SH_CONSTRAINT_COMPONENT];
    for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
        for (const quad of shapes.getQuads(null, RDFS_SUBCLASS, parent, null)) {
            if (!found.has(key(quad.subject))) {
                found.set(key(quad.subject), quad.subject);
                pending.push(quad.subject);
            }
        }
    }
    return [...found.values()];
}

/** How a declared component validates, such as `sh:SPARQLAskValidator via sh:validator`. */
function validatorDescription(shapes: Store, component: Term): string {
    const parts: string[] = [];
    for (const name of VALIDATOR_PREDICATES) {
        for (const quad of shapes.getQuads(component, iri(`${SHACL}${name}`), null, null)) {
            const types = shapes
                .getQuads(quad.object, RDF_TYPE, null, null)
                .map((type) => localName(type.object.value));
            const inferred =
                shapes.getQuads(quad.object, SH_ASK, null, null).length > 0
                    ? ['a SPARQL ASK query']
                    : shapes.getQuads(quad.object, SH_SELECT, null, null).length > 0
                      ? ['a SPARQL SELECT query']
                      : ['a validator'];
            parts.push(`${(types.length > 0 ? types : inferred).join(', ')} via sh:${name}`);
        }
    }
    return parts.length === 0 ? 'no validator' : parts.sort().join('; ');
}

function constraintParameters(shapes: Store): ReadonlyArray<UnsupportedShaclStatement> {
    const found: UnsupportedShaclStatement[] = [];
    for (const rule of CONSTRAINT_PARAMETERS) {
        for (const statement of shapes.getQuads(null, iri(rule.parameter), null, null)) {
            found.push({
                kind: rule.kind,
                shape: shapeOwner(shapes, statement.subject),
                construct: rule.component,
                message: `uses ${rule.what}, which ${ENGINE} cannot run`,
                statement,
            });
        }
    }
    return found;
}

function customTargets(shapes: Store): ReadonlyArray<UnsupportedShaclStatement> {
    return shapes.getQuads(null, SH_TARGET, null, null).map((statement) => {
        const type = shapes
            .getQuads(statement.object, RDF_TYPE, null, null)
            .map((quad) => quad.object.value)
            .sort()[0];
        const sparql = shapes.getQuads(statement.object, SH_SELECT, null, null).length > 0;
        const construct = type ?? (sparql ? `${SHACL}SPARQLTarget` : `${SHACL}Target`);
        return {
            kind: 'custom-target' as const,
            shape: shapeOwner(shapes, statement.subject),
            construct,
            message: `selects its focus nodes with a custom target (sh:target, ${localName(construct)}), which ${ENGINE} never evaluates, so the shape would check no node`,
            statement,
        };
    });
}

/** Whether a declared component has a SHACL-JS validator (`sh:JSValidator`, or one naming a `sh:jsFunctionName`). */
function hasJavaScriptValidator(shapes: Store, component: Term): boolean {
    return VALIDATOR_PREDICATES.some((name) =>
        shapes
            .getQuads(component, iri(`${SHACL}${name}`), null, null)
            .some(
                (quad) =>
                    shapes.getQuads(quad.object, RDF_TYPE, iri(`${SHACL}JSValidator`), null).length > 0 ||
                    shapes.getQuads(quad.object, iri(`${SHACL}jsFunctionName`), null, null).length > 0,
            ),
    );
}

/**
 * Every use of a parameter of a constraint component the shapes graph declares outside the SHACL namespace with a
 * SHACL-JS validator.
 */
function declaredComponents(shapes: Store): ReadonlyArray<UnsupportedShaclStatement> {
    const components = new Map<string, Term>();
    for (const type of componentClasses(shapes)) {
        for (const quad of shapes.getQuads(null, RDF_TYPE, type, null)) {
            if (!(quad.subject.termType === 'NamedNode' && quad.subject.value.startsWith(SHACL))) {
                components.set(key(quad.subject), quad.subject);
            }
        }
    }
    const found: UnsupportedShaclStatement[] = [];
    for (const component of components.values()) {
        // The engine runs SPARQL-based components; only one validated by SHACL-JS is refused.
        if (!hasJavaScriptValidator(shapes, component)) {
            continue;
        }
        const validators = validatorDescription(shapes, component);
        const parameters = shapes
            .getQuads(component, SH_PARAMETER, null, null)
            .flatMap((quad) => shapes.getQuads(quad.object, SH_PATH, null, null).map((path) => path.object))
            .filter((path) => path.termType === 'NamedNode');
        for (const parameter of parameters) {
            for (const statement of shapes.getQuads(null, parameter, null, null)) {
                found.push({
                    kind: 'constraint-component',
                    shape: shapeOwner(shapes, statement.subject),
                    construct: component.termType === 'NamedNode' ? component.value : `${SHACL}ConstraintComponent`,
                    message: `uses ${localName(parameter.value)}, a parameter of ${component.termType === 'NamedNode' ? `the constraint component ${localName(component.value)}` : 'an anonymous constraint component'} that the shapes declare with ${validators}; ${ENGINE} has no JavaScript engine, so it cannot run a SHACL-JS validator`,
                    statement,
                });
            }
        }
    }
    return found;
}

function graphLevel(shapes: Store): ReadonlyArray<UnsupportedShaclStatement> {
    return [
        ...shapes.getQuads(null, OWL_IMPORTS, null, null).map((statement) => ({
            kind: 'owl-imports' as const,
            shape: null,
            construct: `${OWL}imports`,
            message: `imports ${statement.object.value} (owl:imports), which ${ENGINE} cannot load; Erden never fetches imports, and the shapes of the project's dependencies are already checked`,
            statement,
        })),
        ...shapes.getQuads(null, SH_ENTAILMENT, null, null).map((statement) => ({
            kind: 'entailment' as const,
            shape: null,
            construct: `${SHACL}entailment`,
            message: `asks for the entailment regime ${statement.object.value} (sh:entailment), which ${ENGINE} does not support; SHACL requires refusing a shapes graph that asks for a regime the processor does not support`,
            statement,
        })),
    ];
}

/**
 * Every statement of a shapes graph that the bundled engine cannot run. Empty when the engine can run the whole
 * graph, which is the case for SHACL Core.
 */
export function findUnsupportedShaclConstructs(shapes: Store): ReadonlyArray<UnsupportedShaclStatement> {
    return [
        ...constraintParameters(shapes),
        ...customTargets(shapes),
        ...declaredComponents(shapes),
        ...graphLevel(shapes),
    ].filter((item) => UNSUPPORTED_BY_ENGINE.has(item.kind));
}
