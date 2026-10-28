// What the protocol itself computed while writing a request or reading an answer, keyed by the frozen object it
// returned. Not exported from the package: only `sealReasonerRequest` and `openReasonerResponseJson` record values,
// and only the trust checks read them, so a caller cannot supply a digest the checks then believe.
import type { ReasonerRequest, ReasonerResponse } from './schema.js';

const sealedInputDigests = new WeakMap<ReasonerRequest, string>();
const openedResponses = new WeakSet<ReasonerResponse>();
const openedOutputDigests = new WeakMap<ReasonerResponse, string>();

/** Freezes every object and array under `value`, including those under an already frozen parent. */
function freezeDeep<A>(value: A): A {
    if (value !== null && typeof value === 'object') {
        Object.freeze(value);
        for (const item of Object.values(value)) {
            freezeDeep(item);
        }
    }
    return value;
}

/** Freezes a request `sealReasonerRequest` wrote and remembers the input digest it computed from the same text. */
export function rememberSealedRequest(request: ReasonerRequest, inputDigest: string): ReasonerRequest {
    sealedInputDigests.set(freezeDeep(request), inputDigest);
    return request;
}

/** Freezes an answer read from canonical text and remembers the output digest of its evidence, when decided. */
export function rememberOpenedResponse(response: ReasonerResponse, outputDigest: string | undefined): ReasonerResponse {
    openedResponses.add(freezeDeep(response));
    if (outputDigest !== undefined) {
        openedOutputDigests.set(response, outputDigest);
    }
    return response;
}

/** The input digest of a sealed request, which cannot have changed since; undefined for any other request. */
export function sealedInputDigest(request: ReasonerRequest): string | undefined {
    return sealedInputDigests.get(request);
}

/** The output digest of an opened decided answer, which cannot have changed since; undefined otherwise. */
export function openedOutputDigest(response: ReasonerResponse): string | undefined {
    return openedOutputDigests.get(response);
}

/** Whether `openReasonerResponseJson` read this answer from canonical text and froze it. */
export function isOpenedResponse(response: ReasonerResponse): boolean {
    return openedResponses.has(response);
}
