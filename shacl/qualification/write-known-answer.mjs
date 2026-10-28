// Writes shacl/distribution/fixtures/known-answer.request.json: the request every platform binary answers before it
// is packaged, and that the resolver's self-test sends. A shapes graph with a Core constraint and a SHACL-SPARQL
// constraint, and two data graphs, one conforming and one breaking both. The executable digest is the placeholder
// `sha256:000…`; whoever sends it puts the binary's own digest in. Needs the built @erden/ontology.
//
//   node shacl/qualification/write-known-answer.mjs
import { writeFileSync } from 'node:fs';

import { N3, REPOSITORY, ontology } from './harness/lib.mjs';

const prefixes = '@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://example.org/known#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n';
function parse(text, prefix) {
    return new N3.Parser({ baseIRI: 'http://example.org/known', blankNodePrefix: prefix }).parse(prefixes + text);
}
const shapes = parse(
    `ex:TaskShape a sh:NodeShape ; sh:targetClass ex:Task ;
        sh:property [ sh:path ex:start ; sh:datatype xsd:integer ; sh:minCount 1 ; sh:maxCount 1 ] ;
        sh:sparql [ sh:message "{$this} ends before it starts" ;
            sh:select "SELECT $this ?value WHERE { $this <http://example.org/known#start> ?s ; <http://example.org/known#end> ?value . FILTER (?value < ?s) }" ] .`,
    'k_shape_',
);
const conforms = parse('ex:a a ex:Task ; ex:start 1 ; ex:end 2 .', 'k_good_');
const breaks = parse('ex:b a ex:Task ; ex:start 5, "six" ; ex:end 3 .', 'k_bad_');
const request = ontology.encodeShaclRequest({
    requestId: 'known-answer:core-and-sparql',
    tool: ontology.shaclEngineTool(`sha256:${'0'.repeat(64)}`),
    shapes: ontology.prepareShaclShapes(shapes),
    graphs: [
        { id: 'conforms', quads: conforms },
        { id: 'breaks', quads: breaks },
    ],
    maxResults: 100,
});
writeFileSync(new URL('shacl/distribution/fixtures/known-answer.request.json', REPOSITORY), request.line);
console.log(`wrote the known-answer request (${String(Buffer.byteLength(request.line))} bytes)`);
