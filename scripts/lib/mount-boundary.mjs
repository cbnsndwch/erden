import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function decodeMountPath(value) {
    return value.replace(
        /\\(040|011|012|134)/gu,
        (escape, digits) =>
            ({
                '011': '\t',
                '012': '\n',
                '040': ' ',
                134: '\\',
            })[digits] ?? escape,
    );
}

export function isContainedPath(root, candidate) {
    const fragment = relative(root, candidate);
    return fragment.length > 0 && fragment !== '..' && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment);
}

export function readLinuxMountInfo() {
    return readFileSync('/proc/self/mountinfo', 'utf8');
}

export function readLinuxDescriptorMountId(fd) {
    const match = /^mnt_id:\s+(\d+)$/mu.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
    if (match?.[1] === undefined) {
        throw new Error('Test filesystem safety could not inspect a Linux descriptor mount identity');
    }
    return match[1];
}

export function parseLinuxMountInfo(mountInfo) {
    return mountInfo
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
            const separator = line.indexOf(' - ');
            const fields = (separator < 0 ? line : line.slice(0, separator)).split(' ');
            if (
                fields.length < 6 ||
                fields[0] === undefined ||
                fields[2] === undefined ||
                fields[3] === undefined ||
                fields[4] === undefined
            ) {
                throw new Error('Test filesystem safety could not parse Linux mount information');
            }
            const mountPoint = resolve(decodeMountPath(fields[4]));
            return Object.freeze({
                key: `${fields[0]}:${fields[2]}:${decodeMountPath(fields[3])}:${mountPoint}`,
                mountId: fields[0],
                mountPoint,
            });
        });
}

export function enclosingLinuxMount(path, records) {
    const candidate = resolve(path);
    let selected;
    for (const record of records) {
        if (record.mountPoint !== candidate && !isContainedPath(record.mountPoint, candidate)) {
            continue;
        }
        if (selected === undefined || record.mountPoint.length > selected.mountPoint.length) {
            selected = record;
        }
    }
    if (selected === undefined) {
        throw new Error('Test filesystem safety found no enclosing Linux mount');
    }
    return selected;
}
