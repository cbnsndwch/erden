import { createHmac } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { normalizeRegistryOrigin } from '../manifest/index.js';

import { deviceLoginInputInvalid } from './errors.js';

export interface AuthenticationIdentity {
    readonly kind: 'authenticated-user';
    readonly userId: string;
}

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const KEY_ID = /^[A-Za-z0-9]{1,16}$/u;
const DEVICE_SECRET = /^erden_dvc_v1_([A-Za-z0-9]{1,16})_([A-Za-z0-9_-]{43})$/u;
const CLI_CREDENTIAL = /^erden_cli_v1_([A-Za-z0-9]{1,16})_([A-Za-z0-9_-]{43})$/u;
const USER_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u;
const GENERATED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const encoder = new TextEncoder();

export const DEVICE_LOGIN_LIMITS = Object.freeze({
    clientId: 'erden-cli/v1',
    deviceLifetimeMilliseconds: 10 * 60 * 1_000,
    initialPollIntervalMilliseconds: 5_000,
    slowDownIncrementMilliseconds: 5_000,
    maximumPollIntervalMilliseconds: 30_000,
    exchangeReplayMilliseconds: 30 * 60 * 1_000,
    credentialLifetimeMilliseconds: 90 * 24 * 60 * 60 * 1_000,
    maximumUserCodeCollisions: 32,
    maximumKeys: 16,
});

export interface DeviceCredentialHmacKey {
    readonly version: 1;
    readonly keyId: string;
    readonly secret: Uint8Array;
}

export interface DeviceCredentialHmacKeyRing {
    readonly activeKeyId: string;
    readonly keys: ReadonlyArray<DeviceCredentialHmacKey>;
}

export interface BeginDeviceLoginInput {
    readonly registryOrigin: string;
    readonly requestId: string;
    readonly clientId: 'erden-cli/v1';
}

export interface ReviewDeviceLoginInput {
    readonly registryOrigin: string;
    readonly userCode: string;
    readonly identity: AuthenticationIdentity;
}

/**
 * An approval names the exact browser session that authenticated it. The approval commits only while that session
 * is live, and an approved request can be exchanged only while it still is; the reference never leaves the server.
 */
export interface ApproveDeviceLoginInput extends ReviewDeviceLoginInput {
    readonly sessionReference: string;
}

/**
 * The browser session that authenticated a request: its account and an opaque reference to that exact session.
 * Only the server derives it, from the session cookie; it is never read from request input, rendered, logged, or
 * placed in a URL. A CLI credential is not a browser session and never yields one.
 */
export interface AuthenticatedBrowserSession {
    readonly identity: AuthenticationIdentity;
    readonly sessionReference: string;
}

export interface ExchangeDeviceLoginInput {
    readonly registryOrigin: string;
    readonly deviceSecret: string;
}

export interface CliCredentialInput {
    readonly registryOrigin: string;
    readonly credential: string;
}

export interface DeviceLoginChallenge {
    readonly schema: 'erden.device-login-challenge/v1';
    readonly registryOrigin: string;
    readonly requestId: string;
    readonly deviceSecret: string;
    readonly userCode: string;
    readonly verificationUrl: string;
    readonly expiresAt: number;
    readonly intervalSeconds: number;
}

export interface DeviceLoginInspection {
    readonly schema: 'erden.device-login-inspection/v1';
    readonly registryOrigin: string;
    readonly clientId: 'erden-cli/v1';
    readonly expiresAt: number;
    readonly status: 'pending';
}

export interface DeviceLoginDecision {
    readonly schema: 'erden.device-login-decision/v1';
    readonly registryOrigin: string;
    readonly decision: 'approved' | 'denied';
}

export type DeviceLoginExchange = Readonly<
    | {
          schema: 'erden.device-login-exchange/v1';
          registryOrigin: string;
          status: 'pending' | 'slow-down';
          intervalSeconds: number;
      }
    | { schema: 'erden.device-login-exchange/v1'; registryOrigin: string; status: 'denied' | 'invalid' }
    | {
          schema: 'erden.device-login-exchange/v1';
          registryOrigin: string;
          status: 'credential';
          credential: string;
          expiresAt: number;
      }
>;

export interface CliCredentialRevocation {
    readonly schema: 'erden.cli-credential-revocation/v1';
    readonly registryOrigin: string;
    readonly revoked: true;
}

type Plain = Readonly<Record<string, unknown>>;

function exact(input: unknown, fields: ReadonlyArray<string>): Plain {
    try {
        if (
            input === null ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            isProxy(input) ||
            Object.getPrototypeOf(input) !== Object.prototype ||
            Object.getOwnPropertySymbols(input).length !== 0
        ) {
            throw deviceLoginInputInvalid();
        }
        const names = Object.getOwnPropertyNames(input).sort();
        const expected = [...fields].sort();
        if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
            throw deviceLoginInputInvalid();
        }
        for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(input, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw deviceLoginInputInvalid();
            }
        }
        return input as Plain;
    } catch {
        throw deviceLoginInputInvalid();
    }
}

function own(input: Plain, name: string): unknown {
    return Object.getOwnPropertyDescriptor(input, name)?.value;
}

function safeInteger(input: unknown): number {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) {
        throw deviceLoginInputInvalid();
    }
    return input;
}

function canonicalBase64url32(input: unknown): string {
    if (typeof input !== 'string' || !BASE64URL_32.test(input)) {
        throw deviceLoginInputInvalid();
    }
    const bytes = Buffer.from(input, 'base64url');
    if (bytes.byteLength !== 32 || bytes.toString('base64url') !== input) {
        throw deviceLoginInputInvalid();
    }
    return input;
}

export function decodeDeviceLoginRegistryOrigin(input: unknown): string {
    if (typeof input !== 'string' || encoder.encode(input).byteLength > 2048) {
        throw deviceLoginInputInvalid();
    }
    try {
        if (normalizeRegistryOrigin(input) !== input) {
            throw deviceLoginInputInvalid();
        }
        return input;
    } catch {
        throw deviceLoginInputInvalid();
    }
}

export const decodeDeviceLoginRequestId = canonicalBase64url32;

export function decodeDeviceLoginUserCode(input: unknown): string {
    if (typeof input !== 'string') {
        throw deviceLoginInputInvalid();
    }
    const normalized = input.toUpperCase().replace(/[^A-Z0-9]/gu, '');
    if (normalized.length !== 8) {
        throw deviceLoginInputInvalid();
    }
    const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
    if (!USER_CODE.test(formatted)) {
        throw deviceLoginInputInvalid();
    }
    return formatted;
}

export function decodeDeviceLoginIdentity(input: unknown): AuthenticationIdentity {
    const value = exact(input, ['kind', 'userId']);
    const userId = own(value, 'userId');
    if (own(value, 'kind') !== 'authenticated-user' || typeof userId !== 'string' || !GENERATED_ID.test(userId)) {
        throw deviceLoginInputInvalid();
    }
    return Object.freeze({ kind: 'authenticated-user', userId });
}

export function parseDeviceSecret(input: unknown): Readonly<{
    keyId: string;
    payload: string;
}> | null {
    if (typeof input !== 'string') {
        return null;
    }
    const match = input.match(DEVICE_SECRET);
    if (match?.[1] === undefined || match[2] === undefined) {
        return null;
    }
    try {
        return Object.freeze({ keyId: match[1], payload: canonicalBase64url32(match[2]) });
    } catch {
        return null;
    }
}

export function parseCliCredential(input: unknown): Readonly<{
    keyId: string;
    payload: string;
}> | null {
    if (typeof input !== 'string') {
        return null;
    }
    const match = input.match(CLI_CREDENTIAL);
    if (match?.[1] === undefined || match[2] === undefined) {
        return null;
    }
    try {
        return Object.freeze({ keyId: match[1], payload: canonicalBase64url32(match[2]) });
    } catch {
        return null;
    }
}

export function decodeBeginDeviceLoginInput(input: unknown): BeginDeviceLoginInput {
    const value = exact(input, ['clientId', 'registryOrigin', 'requestId']);
    if (own(value, 'clientId') !== DEVICE_LOGIN_LIMITS.clientId) {
        throw deviceLoginInputInvalid();
    }
    return Object.freeze({
        clientId: DEVICE_LOGIN_LIMITS.clientId,
        registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
        requestId: decodeDeviceLoginRequestId(own(value, 'requestId')),
    });
}

export function decodeReviewDeviceLoginInput(input: unknown): ReviewDeviceLoginInput {
    const value = exact(input, ['identity', 'registryOrigin', 'userCode']);
    return Object.freeze({
        registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
        userCode: decodeDeviceLoginUserCode(own(value, 'userCode')),
        identity: decodeDeviceLoginIdentity(own(value, 'identity')),
    });
}

export function decodeSessionReference(input: unknown): string {
    if (typeof input !== 'string' || !GENERATED_ID.test(input)) {
        throw deviceLoginInputInvalid();
    }
    return input;
}

export function decodeAuthenticatedBrowserSession(input: unknown): AuthenticatedBrowserSession {
    const value = exact(input, ['identity', 'sessionReference']);
    return Object.freeze({
        identity: decodeDeviceLoginIdentity(own(value, 'identity')),
        sessionReference: decodeSessionReference(own(value, 'sessionReference')),
    });
}

export function decodeApproveDeviceLoginInput(input: unknown): ApproveDeviceLoginInput {
    const value = exact(input, ['identity', 'registryOrigin', 'sessionReference', 'userCode']);
    return Object.freeze({
        registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
        userCode: decodeDeviceLoginUserCode(own(value, 'userCode')),
        identity: decodeDeviceLoginIdentity(own(value, 'identity')),
        sessionReference: decodeSessionReference(own(value, 'sessionReference')),
    });
}

export function decodeExchangeDeviceLoginInput(input: unknown): ExchangeDeviceLoginInput {
    const value = exact(input, ['deviceSecret', 'registryOrigin']);
    const deviceSecret = own(value, 'deviceSecret');
    if (parseDeviceSecret(deviceSecret) === null) {
        throw deviceLoginInputInvalid();
    }
    return Object.freeze({
        registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
        deviceSecret: deviceSecret as string,
    });
}

export function decodeCliCredentialInput(input: unknown): CliCredentialInput {
    const value = exact(input, ['credential', 'registryOrigin']);
    const credential = own(value, 'credential');
    if (parseCliCredential(credential) === null) {
        throw deviceLoginInputInvalid();
    }
    return Object.freeze({
        registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
        credential: credential as string,
    });
}

export function decodeDeviceLoginChallenge(input: unknown): DeviceLoginChallenge {
    const value = exact(input, [
        'deviceSecret',
        'expiresAt',
        'intervalSeconds',
        'registryOrigin',
        'requestId',
        'schema',
        'userCode',
        'verificationUrl',
    ]);
    const deviceSecret = own(value, 'deviceSecret');
    const userCode = decodeDeviceLoginUserCode(own(value, 'userCode'));
    const verificationUrl = own(value, 'verificationUrl');
    const registryOrigin = decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin'));
    const intervalSeconds = safeInteger(own(value, 'intervalSeconds'));
    if (
        own(value, 'schema') !== 'erden.device-login-challenge/v1' ||
        typeof deviceSecret !== 'string' ||
        parseDeviceSecret(deviceSecret) === null ||
        typeof verificationUrl !== 'string' ||
        intervalSeconds < 5 ||
        intervalSeconds > 30
    ) {
        throw deviceLoginInputInvalid();
    }
    const expectedVerificationUrl = `${registryOrigin}/api/v1/auth/device?user_code=${encodeURIComponent(userCode)}`;
    if (verificationUrl !== expectedVerificationUrl) {
        throw deviceLoginInputInvalid();
    }
    return Object.freeze({
        schema: 'erden.device-login-challenge/v1',
        registryOrigin,
        requestId: decodeDeviceLoginRequestId(own(value, 'requestId')),
        deviceSecret,
        userCode,
        verificationUrl,
        expiresAt: safeInteger(own(value, 'expiresAt')),
        intervalSeconds,
    });
}

export function decodeDeviceLoginInspection(input: unknown): DeviceLoginInspection {
    const value = exact(input, ['clientId', 'expiresAt', 'registryOrigin', 'schema', 'status']);
    if (
        own(value, 'schema') !== 'erden.device-login-inspection/v1' ||
        own(value, 'status') !== 'pending' ||
        own(value, 'clientId') !== DEVICE_LOGIN_LIMITS.clientId
    ) {
        throw deviceLoginInputInvalid();
    }
    return Object.freeze({
        schema: 'erden.device-login-inspection/v1',
        registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
        clientId: DEVICE_LOGIN_LIMITS.clientId,
        expiresAt: safeInteger(own(value, 'expiresAt')),
        status: 'pending',
    });
}

export function decodeDeviceLoginDecision(input: unknown): DeviceLoginDecision {
    const value = exact(input, ['decision', 'registryOrigin', 'schema']);
    const decision = own(value, 'decision');
    if (
        own(value, 'schema') !== 'erden.device-login-decision/v1' ||
        (decision !== 'approved' && decision !== 'denied')
    ) {
        throw deviceLoginInputInvalid();
    }
    return Object.freeze({
        schema: 'erden.device-login-decision/v1',
        registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
        decision,
    });
}

export function decodeDeviceLoginExchange(input: unknown): DeviceLoginExchange {
    if (input === null || typeof input !== 'object') {
        throw deviceLoginInputInvalid();
    }
    const status = own(input as Plain, 'status');
    if (status === 'pending' || status === 'slow-down') {
        const value = exact(input, ['intervalSeconds', 'registryOrigin', 'schema', 'status']);
        const intervalSeconds = safeInteger(own(value, 'intervalSeconds'));
        if (own(value, 'schema') !== 'erden.device-login-exchange/v1' || intervalSeconds < 5 || intervalSeconds > 30) {
            throw deviceLoginInputInvalid();
        }
        return Object.freeze({
            schema: 'erden.device-login-exchange/v1',
            registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
            status,
            intervalSeconds,
        });
    }
    if (status === 'denied' || status === 'invalid') {
        const value = exact(input, ['registryOrigin', 'schema', 'status']);
        if (own(value, 'schema') !== 'erden.device-login-exchange/v1') {
            throw deviceLoginInputInvalid();
        }
        return Object.freeze({
            schema: 'erden.device-login-exchange/v1',
            registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
            status,
        });
    }
    if (status === 'credential') {
        const value = exact(input, ['credential', 'expiresAt', 'registryOrigin', 'schema', 'status']);
        const credential = own(value, 'credential');
        if (
            own(value, 'schema') !== 'erden.device-login-exchange/v1' ||
            typeof credential !== 'string' ||
            parseCliCredential(credential) === null
        ) {
            throw deviceLoginInputInvalid();
        }
        return Object.freeze({
            schema: 'erden.device-login-exchange/v1',
            registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
            status,
            credential,
            expiresAt: safeInteger(own(value, 'expiresAt')),
        });
    }
    throw deviceLoginInputInvalid();
}

export function decodeCliCredentialRevocation(input: unknown): CliCredentialRevocation {
    const value = exact(input, ['registryOrigin', 'revoked', 'schema']);
    if (own(value, 'schema') !== 'erden.cli-credential-revocation/v1' || own(value, 'revoked') !== true) {
        throw deviceLoginInputInvalid();
    }
    return Object.freeze({
        schema: 'erden.cli-credential-revocation/v1',
        registryOrigin: decodeDeviceLoginRegistryOrigin(own(value, 'registryOrigin')),
        revoked: true,
    });
}

export function validateDeviceCredentialKeyId(input: unknown): string {
    if (typeof input !== 'string' || !KEY_ID.test(input)) {
        throw deviceLoginInputInvalid();
    }
    return input;
}

function encodeFields(fields: ReadonlyArray<string>): Uint8Array {
    return encoder.encode(fields.map((field) => `${String(encoder.encode(field).byteLength)}:${field}`).join('|'));
}

export function deviceCredentialHmac(key: Uint8Array, domain: string, fields: ReadonlyArray<string>): Buffer {
    return createHmac('sha256', key)
        .update(encodeFields(['erden/device-login/v1', domain, ...fields]))
        .digest();
}
