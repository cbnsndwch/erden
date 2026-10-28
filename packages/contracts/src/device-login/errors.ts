const messages = Object.freeze({
    DEVICE_LOGIN_INPUT_INVALID: 'The device login request is invalid',
    DEVICE_LOGIN_UNAVAILABLE: 'Device login is unavailable',
    DEVICE_LOGIN_CONFLICT: 'The device login request conflicts with existing state',
    DEVICE_LOGIN_TRANSIENT: 'Device login is temporarily unavailable',
    DEVICE_LOGIN_DEFECT: 'Device login could not complete',
} as const);

export type DeviceLoginErrorCode = keyof typeof messages;

export class DeviceLoginError extends Error {
    readonly code: DeviceLoginErrorCode;

    constructor(code: DeviceLoginErrorCode) {
        super(messages[code]);
        this.name = 'DeviceLoginError';
        this.code = code;
        Object.freeze(this);
    }
}

export function deviceLoginInputInvalid(): DeviceLoginError {
    return new DeviceLoginError('DEVICE_LOGIN_INPUT_INVALID');
}

export function isDeviceLoginError(input: unknown): input is DeviceLoginError {
    return input instanceof DeviceLoginError && input.message === messages[input.code];
}

export function normalizeDeviceLoginError(
    input: unknown,
    allowed: ReadonlySet<DeviceLoginErrorCode>,
): DeviceLoginError {
    return isDeviceLoginError(input) && allowed.has(input.code)
        ? new DeviceLoginError(input.code)
        : new DeviceLoginError('DEVICE_LOGIN_DEFECT');
}
