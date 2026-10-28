// The W3 measurement's synthetic scale series (research/w3-shacl-engines/harness/workloads.mjs at 54c6650): N
// people with typed literals and links, 1% of them broken, against a Core shapes graph and a Core + SHACL-SPARQL
// shapes graph. The same seed gives the same bytes as W3's files.
export const SYN = 'http://example.org/syn#';
export const SYN_CORE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <${SYN}> .

ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:datatype xsd:string ; sh:minCount 1 ; sh:maxCount 1 ; sh:minLength 1 ] ;
  sh:property [ sh:path ex:age ; sh:datatype xsd:integer ; sh:maxCount 1 ; sh:minInclusive 0 ; sh:maxInclusive 150 ] ;
  sh:property [ sh:path ex:email ; sh:pattern "^[^@ ]+@[^@ ]+$" ; sh:maxCount 2 ] ;
  sh:property [ sh:path ex:status ; sh:in ( ex:Active ex:Inactive ) ; sh:maxCount 1 ] ;
  sh:property [ sh:path ex:worksFor ; sh:class ex:Organization ; sh:nodeKind sh:IRI ] .

ex:OrganizationShape a sh:NodeShape ;
  sh:targetClass ex:Organization ;
  sh:property [ sh:path ex:label ; sh:minCount 1 ; sh:datatype xsd:string ] ;
  sh:property [ sh:path [ sh:inversePath ex:worksFor ] ; sh:maxCount 1000 ] .
`;
export const SYN_SPARQL = `${SYN_CORE}
ex:NoSelfManagerShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:sparql [
    sh:message "A person cannot manage themselves or be managed by someone younger." ;
    sh:select """
      PREFIX ex: <${SYN}>
      SELECT $this ?value WHERE {
        $this ex:manager ?value .
        $this ex:age ?a .
        ?value ex:age ?b .
        FILTER (?value = $this || ?b < ?a)
      }
    """ ] .
`;

function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The N-Triples data graph for N people, with the two shapes graphs and the number of broken people. */
export function syntheticCase(n) {
    const random = rng(n);
    const lines = [];
    const t = (s, p, o) => lines.push(`<${SYN}${s}> <${p.startsWith('http') ? p : SYN + p}> ${o} .`);
    const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const xsd = (v, d) => `"${v}"^^<http://www.w3.org/2001/XMLSchema#${d}>`;
    const orgs = Math.max(1, Math.floor(n / 50));
    for (let o = 0; o < orgs; o += 1) {
        t(`org${o}`, type, `<${SYN}Organization>`);
        t(`org${o}`, 'label', `"Org ${o}"`);
    }
    let broken = 0;
    for (let i = 0; i < n; i += 1) {
        const bad = random() < 0.01;
        const p = `p${i}`;
        t(p, type, `<${SYN}Person>`);
        t(p, 'name', `"Person ${i}"`);
        t(p, 'age', bad && random() < 0.5 ? xsd(200, 'integer') : xsd(18 + (i % 60), 'integer'));
        t(p, 'email', bad && random() < 0.5 ? '"not-an-email"' : `"p${i}@example.org"`);
        t(p, 'status', `<${SYN}${i % 3 === 0 ? 'Inactive' : 'Active'}>`);
        t(p, 'worksFor', `<${SYN}org${i % orgs}>`);
        const oldest = i - (i % 60) + 59;
        if (bad) {
            t(p, 'manager', `<${SYN}${p}>`);
        } else if (oldest !== i && oldest < n) {
            t(p, 'manager', `<${SYN}p${oldest}>`);
        }
        if (bad) {
            broken += 1;
        }
    }
    return { n, data: `${lines.join('\n')}\n`, shapesCore: SYN_CORE, shapesSparql: SYN_SPARQL, broken };
}
