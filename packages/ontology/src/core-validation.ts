import { DataFactory, Store } from 'n3';

import { quadKey } from './assembly.js';
import type {
    AssembledOntology,
    BorrowedTermValidation,
    PropertyDomainRangeFinding,
    PropertyDomainRangeValidation,
    ProjectSourceOwner,
} from './model.js';
import { OWL, RDF, RDFS, XSD } from './model.js';
import { compareCodePoints } from './order.js';
import { partitionForBundledReasoner } from './reasoner/normalize.js';
import { sourcePolicy } from './reasoner/partition.js';

function namedNode(value: string) {
    return DataFactory.namedNode(value);
}

const RDF_TYPE = namedNode(`${RDF}type`);
const RDFS_SUBCLASS = namedNode(`${RDFS}subClassOf`);
const RDFS_DOMAIN = namedNode(`${RDFS}domain`);
const RDFS_RANGE = namedNode(`${RDFS}range`);
const PROPERTY_TYPES = [`${OWL}AnnotationProperty`, `${OWL}DatatypeProperty`, `${OWL}ObjectProperty`] as const;
const RESERVED_NAMESPACES = [OWL, RDF, RDFS, XSD] as const;

function ownedPrefixes(owners: ReadonlyArray<ProjectSourceOwner>): ReadonlyArray<string> {
    return [...new Set(owners.flatMap((owner) => owner.ownedIriPrefixes))].sort(compareCodePoints);
}

function startsWithAny(value: string, prefixes: ReadonlyArray<string>): boolean {
    return prefixes.some((prefix) => value.startsWith(prefix));
}

export function validateBorrowedTerms(
    dataset: Store,
    owners: ReadonlyArray<ProjectSourceOwner>,
    /** The statements whose borrowed terms must be declared; every statement by default. */
    usage: Store = dataset,
): BorrowedTermValidation {
    const own = ownedPrefixes(owners);
    const declared = new Set<string>();
    for (const quad of dataset.getQuads(null, RDF_TYPE, null, null)) {
        if (
            quad.subject.termType === 'NamedNode' &&
            quad.object.termType === 'NamedNode' &&
            quad.object.value.startsWith(OWL)
        ) {
            declared.add(quad.subject.value);
        }
    }
    function isExternal(iri: string): boolean {
        return !startsWithAny(iri, own) && !startsWithAny(iri, RESERVED_NAMESPACES);
    }
    const used = new Set<string>();
    for (const quad of usage.getQuads(null, null, null, null)) {
        if (isExternal(quad.predicate.value)) {
            used.add(quad.predicate.value);
        }
        if (
            (quad.predicate.equals(RDF_TYPE) || quad.predicate.equals(RDFS_SUBCLASS)) &&
            quad.object.termType === 'NamedNode' &&
            isExternal(quad.object.value)
        ) {
            used.add(quad.object.value);
        }
    }
    const sortedUsed = [...used].sort(compareCodePoints);
    const sortedDeclared = [...declared].sort(compareCodePoints);
    const missing = sortedUsed.filter((iri) => !declared.has(iri));
    return { used: sortedUsed, declared: sortedDeclared, missing, conforms: missing.length === 0 };
}

export function validatePropertyDomainRange(
    dataset: Store,
    owners: ReadonlyArray<ProjectSourceOwner>,
): PropertyDomainRangeValidation {
    const own = ownedPrefixes(owners);
    const properties = new Set<string>();
    for (const type of PROPERTY_TYPES) {
        for (const quad of dataset.getQuads(null, RDF_TYPE, namedNode(type), null)) {
            if (quad.subject.termType === 'NamedNode' && startsWithAny(quad.subject.value, own)) {
                properties.add(quad.subject.value);
            }
        }
    }
    const sortedProperties = [...properties].sort(compareCodePoints);
    const findings: PropertyDomainRangeFinding[] = [];
    for (const property of sortedProperties) {
        const term = namedNode(property);
        const domain = dataset.countQuads(term, RDFS_DOMAIN, null, null) > 0;
        const range = dataset.countQuads(term, RDFS_RANGE, null, null) > 0;
        if (!domain || !range) {
            findings.push({
                property,
                missing: !domain && !range ? 'domain+range' : !domain ? 'domain' : 'range',
            });
        }
    }
    return { properties: sortedProperties, findings, conforms: findings.length === 0 };
}

/**
 * The core rules over a validated graph. With every project in refuse mode they run exactly as before. When a
 * project is in report mode, the borrowed-term rule asks only the reasoned statements that a refuse-mode project
 * asserts to declare their borrowed terms (declarations still count from anywhere), and the domain-and-range rule
 * covers only properties owned by refuse-mode projects, because a mirrored upstream cannot add declarations or axioms
 * it does not publish.
 */
export function validateCoreOntology(graph: AssembledOntology): Readonly<{
    borrowedTerms: BorrowedTermValidation;
    propertyDomainRange: PropertyDomainRangeValidation;
}> {
    const owners = graph.sources.map((source) => source.descriptor.owner);
    if (graph.sources.every((source) => sourcePolicy(source) === 'refuse')) {
        return {
            borrowedTerms: validateBorrowedTerms(graph.dataset, owners),
            propertyDomainRange: validatePropertyDomainRange(graph.dataset, owners),
        };
    }
    const { excludedKeys } = partitionForBundledReasoner(graph);
    const reasoned = new Store(
        graph.dataset.getQuads(null, null, null, null).filter((quad) => !excludedKeys.has(quadKey(quad))),
    );
    const refuseSources = graph.sources.filter((source) => sourcePolicy(source) === 'refuse');
    const refuseIds = new Set(refuseSources.map((source) => source.descriptor.id));
    const refuseOwners = refuseSources.map((source) => source.descriptor.owner);
    const refuseKeys = new Set(
        graph.provenance
            .filter((entry) => entry.asserted.some((contributor) => refuseIds.has(contributor.sourceId)))
            .map((entry) => entry.key),
    );
    const usage = new Store(reasoned.getQuads(null, null, null, null).filter((quad) => refuseKeys.has(quadKey(quad))));
    return {
        borrowedTerms: validateBorrowedTerms(reasoned, owners, usage),
        propertyDomainRange: validatePropertyDomainRange(reasoned, refuseOwners),
    };
}
