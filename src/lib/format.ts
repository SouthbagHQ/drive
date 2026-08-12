// Southbag Drive™ measures storage in industry-standard units.

const FLOPPY_BYTES = 1_474_560; // one (1) 3.5" high-density floppy diskette
const CDROM_BYTES = 700 * 1024 * 1024;
const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;

export const QUOTA_FLOPPIES_LABEL = '71.1 floppy disks';

export function toFloppies(bytes: number): string {
	const floppies = bytes / FLOPPY_BYTES;
	if (floppies === 0) return '0 floppies';
	if (floppies < 0.01) return `${floppies.toFixed(5)} floppies`;
	if (floppies < 1) return `${floppies.toFixed(3)} floppies`;
	return `${floppies.toFixed(2)} floppies`;
}

export function toCdRoms(bytes: number): string {
	return `${(bytes / CDROM_BYTES).toFixed(6)} CD-ROMs`;
}

export function fortnightsAgo(timestamp: number): string {
	const fortnights = Math.max(0, Date.now() - timestamp) / FORTNIGHT_MS;
	if (fortnights < 0.001) return 'just now';
	return `${fortnights.toFixed(3)} fortnights ago`;
}

export function truncateFront(name: string, max = 34): string {
	if (name.length <= max) return name;
	return `…${name.slice(name.length - (max - 1))}`;
}
