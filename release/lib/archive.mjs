// Deterministic archives of a directory: the same tree gives the same bytes on every run. Entries are sorted by path,
// every modification time is the given epoch, owner and group are 0 with no names, modes are 0755 for directories and
// executables and 0644 otherwise, and nothing about the build host is recorded (gzip with no name, time 0 and a fixed
// OS byte; zip with no extra fields). Symbolic links are refused, so an archive never points outside itself.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

/** Every entry under `directory`, sorted by its archive path (`prefix/` + its relative path, `/`-separated). */
export function collectEntries(directory, prefix) {
    const entries = [];
    function walk(path) {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const absolute = join(path, entry.name);
            const name = `${prefix}/${relative(directory, absolute).replaceAll('\\', '/')}`;
            const stat = lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                throw new Error(`Refusing a symbolic link in an archive: ${name}`);
            }
            if (stat.isDirectory()) {
                entries.push({ name: `${name}/`, directory: true, executable: true });
                walk(absolute);
            } else if (stat.isFile()) {
                entries.push({ name, directory: false, executable: (stat.mode & 0o111) !== 0, path: absolute });
            } else {
                throw new Error(`Refusing a special file in an archive: ${name}`);
            }
        }
    }
    entries.push({ name: `${prefix}/`, directory: true, executable: true });
    walk(directory);
    return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function octal(value, width) {
    return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(name, size, mode, type, epoch) {
    const header = Buffer.alloc(512);
    function write(text, offset, width) {
        header.write(text, offset, Math.min(Buffer.byteLength(text), width), 'utf8');
    }
    write(name, 0, 100);
    write(octal(mode, 8), 100, 8);
    write(octal(0, 8), 108, 8);
    write(octal(0, 8), 116, 8);
    write(octal(size, 12), 124, 12);
    write(octal(epoch, 12), 136, 12);
    header.fill(' ', 148, 156);
    write(type, 156, 1);
    write('ustar\0', 257, 6);
    write('00', 263, 2);
    let sum = 0;
    for (const byte of header) {
        sum += byte;
    }
    write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return header;
}

/** A pax `path` record that states its own length, as the format requires. */
function paxPathRecord(path, length) {
    return `${String(length)} path=${path}\n`;
}

function padded(bytes) {
    const remainder = bytes.length % 512;
    return remainder === 0 ? [bytes] : [bytes, Buffer.alloc(512 - remainder)];
}

/** A POSIX (pax) tar of `entries`; a name that does not fit the 100-byte field gets a pax `path` record. */
export function tarBytes(entries, epoch) {
    const blocks = [];
    for (const entry of entries) {
        const data = entry.directory ? Buffer.alloc(0) : readFileSync(entry.path);
        const mode = entry.executable ? 0o755 : 0o644;
        let name = entry.name;
        if (Buffer.byteLength(name) > 100) {
            const body = paxPathRecord.bind(undefined, entry.name);
            let length = Buffer.byteLength(body(0));
            while (Buffer.byteLength(body(length)) !== length) {
                length = Buffer.byteLength(body(length));
            }
            const record = Buffer.from(body(length), 'utf8');
            blocks.push(tarHeader('PaxHeader', record.length, 0o644, 'x', epoch), ...padded(record));
            name = Buffer.from(entry.name)
                .subarray(0, 100)
                .toString('utf8')
                .replace(/\uFFFD+$/u, '');
        }
        blocks.push(tarHeader(name, data.length, mode, entry.directory ? '5' : '0', epoch), ...padded(data));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

/** gzip with no file name, time 0 and the OS byte fixed to 255 ("unknown"), so the host never shows. */
export function gzipBytes(bytes) {
    const compressed = gzipSync(bytes, { level: 9 });
    compressed[4] = 0;
    compressed[5] = 0;
    compressed[6] = 0;
    compressed[7] = 0;
    compressed[9] = 255;
    return compressed;
}

function dosDateTime(epoch) {
    const date = new Date(epoch * 1000);
    const year = Math.max(date.getUTCFullYear(), 1980);
    return {
        time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    };
}

/** A zip of `entries`, deflated, with Unix modes in the external attributes and no extra fields. */
export function zipBytes(entries, epoch) {
    if (entries.length > 0xffff) {
        throw new Error('Too many entries for a zip without Zip64');
    }
    const { time, date } = dosDateTime(epoch);
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = entry.directory ? Buffer.alloc(0) : readFileSync(entry.path);
        const compressed = entry.directory ? Buffer.alloc(0) : deflateRawSync(data, { level: 9 });
        const crc = entry.directory ? 0 : crc32(data);
        const method = entry.directory ? 0 : 8;
        const mode = (entry.directory ? 0o040000 : 0o100000) | (entry.executable ? 0o755 : 0o644);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((mode << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, compressed);
        centrals.push(central, name);
        offset += local.length + name.length + compressed.length;
        if (offset > 0xffffffff) {
            throw new Error('Archive too large for a zip without Zip64');
        }
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

/** Writes `directory` as `<prefix>/...` to `output` (`.tar.gz` or `.zip`); returns its size and SHA-256. */
export function writeArchive(directory, prefix, output, epoch) {
    const entries = collectEntries(directory, prefix);
    const bytes = output.endsWith('.zip') ? zipBytes(entries, epoch) : gzipBytes(tarBytes(entries, epoch));
    writeFileSync(output, bytes);
    return { bytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}
