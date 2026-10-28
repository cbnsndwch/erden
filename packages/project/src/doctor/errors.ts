export class DoctorOperationalError extends Error {
    readonly code = 'DOCTOR_OPERATIONAL_FAILURE' as const;
    override readonly cause!: unknown;

    constructor(cause?: unknown) {
        super('Erden doctor could not inspect the local runtime');
        this.name = 'DoctorOperationalError';
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
}
