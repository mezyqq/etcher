/*
 * Copyright 2026 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * This file handles writing Windows installation media.
 *
 * Windows ISOs are not hybrid images, so a raw copy is not bootable.
 * Instead we create a GPT partition table with a single FAT32 partition,
 * copy the ISO contents onto it and split install.wim into <4GB .swm
 * parts with wimlib, which keeps the drive bootable on any UEFI machine
 * (including with Secure Boot enabled).
 *
 * Optionally a folder of storage drivers (e.g. Intel RST/VMD) is copied
 * to the drive along with an autounattend.xml that loads them before the
 * setup looks for disks, so the target SSD shows up without having to
 * click "Load driver".
 */

import { spawn } from 'child_process';
import {
	constants as fsConstants,
	createReadStream,
	createWriteStream,
} from 'fs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

import type { MultiDestinationProgress } from 'etcher-sdk/build/multi-write';
import type { Drive as DrivelistDrive } from 'drivelist';

import { toJSON } from '../shared/errors';
import { emitLog, emitState } from './api';
import type { WindowsWriteOptions, WriteResult } from './types/types';

const VOLUME_LABEL = 'WINSTALL';
// FAT32 can not hold files of 4GiB or more
const FAT32_MAX_FILE_SIZE = 4 * 1024 ** 3 - 1;
const WIM_SPLIT_SIZE_MB = 3800;
// Windows only formats FAT32 volumes up to 32GB
const WINDOWS_FAT32_MAX_PARTITION_MB = 32000;
export const DRIVERS_DIRECTORY = 'etcher-drivers';
const PROGRESS_INTERVAL_MS = 500;

type CleanupTask = () => Promise<void>;
const cleanupTasks: CleanupTask[] = [];
let aborted = false;

function addCleanup(task: CleanupTask) {
	cleanupTasks.push(task);
}

/**
 * @summary Unmount everything this module mounted, newest first
 */
export async function cleanupWindowsWrite() {
	aborted = true;
	while (cleanupTasks.length > 0) {
		const task = cleanupTasks.pop() as CleanupTask;
		try {
			await task();
		} catch (error: any) {
			console.log(`cleanup failed: ${error.message}`);
		}
	}
}

function userError(message: string, code = 'EWINDOWSMEDIA') {
	const error: any = new Error(message);
	error.code = code;
	error.description = message;
	return error;
}

function run(
	command: string,
	args: string[],
	{
		input,
		onOutput,
	}: { input?: string; onOutput?: (chunk: string) => void } = {},
): Promise<string> {
	emitLog(`$ ${command} ${args.join(' ')}`);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: true });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (data: Buffer) => {
			stdout += data.toString();
			onOutput?.(data.toString());
		});
		child.stderr.on('data', (data: Buffer) => {
			stderr += data.toString();
		});
		child.on('error', (error: any) => {
			if (error.code === 'ENOENT') {
				reject(userError(`Required program "${command}" was not found`));
			} else {
				reject(error);
			}
		});
		child.on('close', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				const output = (stderr || stdout).trim();
				reject(userError(`"${command}" failed (exit code ${code}): ${output}`));
			}
		});
		if (input !== undefined) {
			child.stdin.write(input);
		}
		child.stdin.end();
	});
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function findExecutable(
	names: string[],
	extraDirectories: string[] = [],
): Promise<string | undefined> {
	const directories = [
		...(process.env.PATH ?? '').split(path.delimiter),
		...extraDirectories,
	].filter((directory) => directory.length > 0);
	for (const directory of directories) {
		for (const name of names) {
			const candidate = path.join(directory, name);
			try {
				await fs.access(candidate, fsConstants.X_OK);
				return candidate;
			} catch {
				// try next candidate
			}
		}
	}
	return undefined;
}

async function findWimlib(): Promise<string | undefined> {
	if (process.env.ETCHER_WIMLIB) {
		return process.env.ETCHER_WIMLIB;
	}
	if (process.platform === 'win32') {
		return await findExecutable(
			['wimlib-imagex.exe'],
			[path.dirname(process.execPath)],
		);
	}
	return await findExecutable(
		['wimlib-imagex'],
		// sudo strips the Homebrew paths on macOS
		['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/usr/sbin'],
	);
}

function wimlibInstallHint() {
	switch (process.platform) {
		case 'linux':
			return 'Install it with your package manager, e.g. "sudo pacman -S wimlib", "sudo apt install wimtools" or "sudo dnf install wimlib-utils".';
		case 'darwin':
			return 'Install it with "brew install wimlib".';
		default:
			return 'Download it from https://wimlib.net and put wimlib-imagex.exe next to the Etcher executable or in your PATH.';
	}
}

interface Platform {
	requiredPrograms: string[];
	mountIso(isoPath: string): Promise<string>;
	// Partition and format the drive, returns where the new volume is mounted
	prepareDrive(drive: DrivelistDrive): Promise<string>;
	finalizeDrive(drive: DrivelistDrive, mountpoint: string): Promise<void>;
}

async function makeTemporaryDirectory(prefix: string) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	addCleanup(async () => {
		await fs.rmdir(directory);
	});
	return directory;
}

async function linuxUnmountDevice(device: string) {
	const output = await run('lsblk', [
		'--list',
		'--noheadings',
		'--paths',
		'--output',
		'NAME,MOUNTPOINT',
		device,
	]);
	for (const line of output.split('\n')) {
		const [name, ...mountpoint] = line.trim().split(/\s+/);
		if (name && mountpoint.length > 0 && mountpoint[0] !== '') {
			await run('umount', [name]);
		}
	}
}

async function linuxFindPartition(device: string): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const output = await run('lsblk', [
			'--list',
			'--noheadings',
			'--paths',
			'--output',
			'NAME,TYPE',
			device,
		]);
		const partition = output
			.split('\n')
			.map((line) => line.trim().split(/\s+/))
			.find(([, type]) => type === 'part');
		if (partition !== undefined) {
			return partition[0];
		}
		await delay(500);
	}
	throw userError(`The new partition on ${device} did not show up`);
}

const linux: Platform = {
	requiredPrograms: [
		'lsblk',
		'wipefs',
		'parted',
		'mkfs.fat',
		'mount',
		'umount',
	],

	async mountIso(isoPath) {
		const mountpoint = await makeTemporaryDirectory('etcher-iso-');
		try {
			// Windows ISOs keep the real file tree in the UDF filesystem
			await run('mount', ['-o', 'loop,ro', '-t', 'udf', isoPath, mountpoint]);
		} catch {
			await run('mount', ['-o', 'loop,ro', isoPath, mountpoint]);
		}
		addCleanup(async () => {
			await run('umount', ['-l', mountpoint]);
		});
		return mountpoint;
	},

	async prepareDrive(drive) {
		const device = drive.device;
		await linuxUnmountDevice(device);
		await run('wipefs', ['--all', '--force', device]);
		await run('parted', [
			'--script',
			device,
			'mklabel',
			'gpt',
			'mkpart',
			VOLUME_LABEL,
			'fat32',
			'1MiB',
			'100%',
		]);
		await run('partprobe', [device]).catch(() => undefined);
		await run('udevadm', ['settle']).catch(() => undefined);
		const partition = await linuxFindPartition(device);
		// The desktop may have automounted the new (still empty) partition
		await linuxUnmountDevice(device).catch(() => undefined);
		await run('mkfs.fat', ['-F', '32', '-n', VOLUME_LABEL, partition]);
		const mountpoint = await makeTemporaryDirectory('etcher-usb-');
		await run('mount', ['-t', 'vfat', partition, mountpoint]);
		addCleanup(async () => {
			// finalizeDrive already unmounts it unless the write failed half way
			await run('umount', ['-l', mountpoint]).catch(() => undefined);
		});
		return mountpoint;
	},

	async finalizeDrive(drive) {
		await run('sync', []);
		await linuxUnmountDevice(drive.device);
	},
};

async function plistToJson(plist: string): Promise<any> {
	return JSON.parse(
		await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist }),
	);
}

const darwin: Platform = {
	requiredPrograms: ['diskutil', 'hdiutil', 'plutil'],

	async mountIso(isoPath) {
		const info = await plistToJson(
			await run('hdiutil', [
				'attach',
				'-nobrowse',
				'-readonly',
				'-plist',
				isoPath,
			]),
		);
		const mountpoint = info['system-entities']
			.map((entity: any) => entity['mount-point'])
			.find((point: string | undefined) => point !== undefined);
		if (mountpoint === undefined) {
			throw userError(`Could not mount ${isoPath}`);
		}
		addCleanup(async () => {
			await run('hdiutil', ['detach', '-force', mountpoint]);
		});
		return mountpoint;
	},

	async prepareDrive(drive) {
		await run('diskutil', ['unmountDisk', 'force', drive.device]);
		await run('diskutil', [
			'eraseDisk',
			'FAT32',
			VOLUME_LABEL,
			'GPT',
			drive.device,
		]);
		const list = await plistToJson(
			await run('diskutil', ['list', '-plist', drive.device]),
		);
		const partitions: any[] = list.AllDisksAndPartitions[0]?.Partitions ?? [];
		const partition = partitions.find((p) => p.VolumeName === VOLUME_LABEL);
		if (partition === undefined) {
			throw userError(`The new partition on ${drive.device} did not show up`);
		}
		if (partition.MountPoint) {
			return partition.MountPoint;
		}
		await run('diskutil', ['mount', partition.DeviceIdentifier]);
		const info = await plistToJson(
			await run('diskutil', ['info', '-plist', partition.DeviceIdentifier]),
		);
		return info.MountPoint;
	},

	async finalizeDrive(drive) {
		await run('sync', []);
		await run('diskutil', ['unmountDisk', drive.device]);
	},
};

function powershell(script: string) {
	return run('powershell.exe', [
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-EncodedCommand',
		Buffer.from(
			`$ErrorActionPreference = 'Stop'\n${script}`,
			'utf16le',
		).toString('base64'),
	]);
}

function powershellString(value: string) {
	return `'${value.replace(/'/g, "''")}'`;
}

function lastLine(output: string) {
	const lines = output.trim().split(/\r?\n/);
	return lines[lines.length - 1].trim();
}

const win32: Platform = {
	requiredPrograms: ['powershell.exe'],

	async mountIso(isoPath) {
		const image = powershellString(isoPath);
		const letter = lastLine(
			await powershell(
				`(Mount-DiskImage -ImagePath ${image} -PassThru | Get-Volume).DriveLetter`,
			),
		);
		addCleanup(async () => {
			await powershell(`Dismount-DiskImage -ImagePath ${image} | Out-Null`);
		});
		if (!/^[A-Z]$/i.test(letter)) {
			throw userError(`Could not mount ${isoPath}`);
		}
		return `${letter}:\\`;
	},

	async prepareDrive(drive) {
		const match = drive.device.match(/PhysicalDrive(\d+)$/i);
		if (match === null) {
			throw userError(`Unexpected device path ${drive.device}`);
		}
		const disk = match[1];
		const letter = lastLine(
			await powershell(`
Clear-Disk -Number ${disk} -RemoveData -RemoveOEM -Confirm:$false -ErrorAction SilentlyContinue
Initialize-Disk -Number ${disk} -PartitionStyle GPT
$size = [Math]::Min((Get-Disk -Number ${disk}).LargestFreeExtent, ${WINDOWS_FAT32_MAX_PARTITION_MB}MB)
$partition = New-Partition -DiskNumber ${disk} -Size $size -AssignDriveLetter -GptType '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'
$partition | Format-Volume -FileSystem FAT32 -NewFileSystemLabel ${VOLUME_LABEL} -Confirm:$false | Out-Null
(Get-Partition -DiskNumber ${disk} -PartitionNumber $partition.PartitionNumber).DriveLetter
`),
		);
		if (!/^[A-Z]$/i.test(letter)) {
			throw userError(`Could not assign a drive letter to ${drive.device}`);
		}
		return `${letter}:\\`;
	},

	async finalizeDrive(_drive, mountpoint) {
		await powershell(`Write-VolumeCache -DriveLetter ${mountpoint[0]}`);
	},
};

function getPlatform(): Platform {
	switch (process.platform) {
		case 'linux':
			return linux;
		case 'darwin':
			return darwin;
		case 'win32':
			return win32;
		default:
			throw userError(
				`Writing Windows media is not supported on ${process.platform}`,
			);
	}
}

interface SourceFile {
	relativePath: string;
	size: number;
}

async function listFiles(root: string, relative = ''): Promise<SourceFile[]> {
	const entries = await fs.readdir(path.join(root, relative), {
		withFileTypes: true,
	});
	const files: SourceFile[] = [];
	for (const entry of entries) {
		const relativePath = path.join(relative, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(root, relativePath)));
		} else if (entry.isFile()) {
			const { size } = await fs.stat(path.join(root, relativePath));
			files.push({ relativePath, size });
		}
	}
	return files;
}

const isInstallImage = (relativePath: string) =>
	/^sources[\\/]install\.(wim|esd)$/i.test(relativePath);

class ProgressTracker {
	private written = 0;
	private lastEmit = 0;
	private readonly startedAt = Date.now();

	constructor(
		private readonly total: number,
		private readonly drives: number,
		private failed = 0,
	) {}

	public add(bytes: number) {
		this.written += bytes;
		this.emit();
	}

	public fail() {
		this.failed += 1;
	}

	public emit(force = false) {
		const now = Date.now();
		if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) {
			return;
		}
		this.lastEmit = now;
		const elapsed = Math.max((now - this.startedAt) / 1000, 0.001);
		const speed = this.written / elapsed;
		const state = {
			type: 'flashing',
			active: this.drives - this.failed,
			failed: this.failed,
			bytes: this.written,
			position: this.written,
			size: this.total,
			percentage: Math.min((this.written / this.total) * 100, 100),
			speed,
			averageSpeed: speed,
			totalSpeed: speed,
			eta: speed > 0 ? (this.total - this.written) / speed : undefined,
		};
		emitState(state as unknown as MultiDestinationProgress);
	}
}

async function copyFile(
	source: string,
	destination: string,
	progress: ProgressTracker,
) {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await pipeline(
		createReadStream(source, { highWaterMark: 4 * 1024 * 1024 }),
		new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				if (aborted) {
					callback(userError('Write aborted', 'EABORTED'));
					return;
				}
				progress.add(chunk.length);
				callback(null, chunk);
			},
		}),
		createWriteStream(destination),
	);
}

async function splitWim(
	wimlib: string,
	source: SourceFile,
	isoRoot: string,
	usbRoot: string,
	progress: ProgressTracker,
) {
	const destination = path.join(
		usbRoot,
		path.dirname(source.relativePath),
		'install.swm',
	);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	let reported = 0;
	await run(
		wimlib,
		[
			'split',
			path.join(isoRoot, source.relativePath),
			destination,
			`${WIM_SPLIT_SIZE_MB}`,
		],
		{
			onOutput(chunk) {
				// "... 1234 MiB of 5000 MiB (24%) written"
				const percentages = [...chunk.matchAll(/\((\d+)%\)/g)];
				if (percentages.length > 0) {
					const percentage = parseInt(
						percentages[percentages.length - 1][1],
						10,
					);
					const bytes = Math.floor((source.size * percentage) / 100);
					progress.add(bytes - reported);
					reported = bytes;
				}
			},
		},
	);
	progress.add(source.size - reported);
}

function autounattend() {
	const letters = 'C D E F G H I J K L M N O P Q R S T U V W Y Z';
	const command =
		`cmd.exe /c for %d in (${letters}) do @if exist %d:\\${DRIVERS_DIRECTORY}\\ ` +
		`for /r %d:\\${DRIVERS_DIRECTORY} %f in (*.inf) do @drvload "%f"`;
	const component = (architecture: string) => `
		<component name="Microsoft-Windows-Setup" processorArchitecture="${architecture}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
			<RunSynchronous>
				<RunSynchronousCommand wcm:action="add">
					<Order>1</Order>
					<Description>Load storage drivers added by Etcher</Description>
					<Path>${command}</Path>
				</RunSynchronousCommand>
			</RunSynchronous>
		</component>`;
	return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by balenaEtcher: loads the drivers from \\${DRIVERS_DIRECTORY} before setup looks for disks -->
<unattend xmlns="urn:schemas-microsoft-com:unattend">
	<settings pass="windowsPE">${component('amd64')}${component('arm64')}
	</settings>
</unattend>
`;
}

async function addDrivers(
	driversPath: string,
	usbRoot: string,
	hasOwnAnswerFile: boolean,
	progress: ProgressTracker,
) {
	const drivers = await listFiles(driversPath);
	if (!drivers.some((file) => /\.inf$/i.test(file.relativePath))) {
		throw userError(
			`The drivers folder ${driversPath} does not contain any .inf files. If you downloaded an .exe or .zip, extract it first.`,
		);
	}
	for (const file of drivers) {
		await copyFile(
			path.join(driversPath, file.relativePath),
			path.join(usbRoot, DRIVERS_DIRECTORY, file.relativePath),
			progress,
		);
	}
	if (hasOwnAnswerFile) {
		emitLog(
			'The image already has an autounattend.xml, drivers were copied but will not be loaded automatically',
		);
	} else {
		await fs.writeFile(path.join(usbRoot, 'autounattend.xml'), autounattend());
	}
}

async function writeDrive(
	platform: Platform,
	drive: DrivelistDrive,
	isoRoot: string,
	files: SourceFile[],
	wimlib: string | undefined,
	driversPath: string | undefined,
	progress: ProgressTracker,
) {
	emitLog(`Preparing ${drive.device}`);
	const usbRoot = await platform.prepareDrive(drive);
	for (const file of files) {
		if (aborted) {
			throw userError('Write aborted', 'EABORTED');
		}
		if (file.size > FAT32_MAX_FILE_SIZE) {
			if (!isInstallImage(file.relativePath) || wimlib === undefined) {
				throw userError(`${file.relativePath} is too large for FAT32`);
			}
			emitLog(`Splitting ${file.relativePath}`);
			await splitWim(wimlib, file, isoRoot, usbRoot, progress);
		} else {
			await copyFile(
				path.join(isoRoot, file.relativePath),
				path.join(usbRoot, file.relativePath),
				progress,
			);
		}
	}
	if (driversPath) {
		const hasOwnAnswerFile = files.some(
			(file) => file.relativePath.toLowerCase() === 'autounattend.xml',
		);
		await addDrivers(driversPath, usbRoot, hasOwnAnswerFile, progress);
	}
	emitLog(`Syncing ${drive.device}`);
	await platform.finalizeDrive(drive, usbRoot);
}

async function checkRequiredPrograms(platform: Platform) {
	for (const program of platform.requiredPrograms) {
		if (
			(await findExecutable([program], ['/usr/sbin', '/sbin'])) === undefined
		) {
			throw userError(
				`Required program "${program}" was not found, please install it and try again`,
			);
		}
	}
}

export async function writeWindows(
	options: WindowsWriteOptions,
): Promise<WriteResult> {
	aborted = false;
	const platform = getPlatform();
	const isoPath = options.image.path;
	emitLog(`Windows image: ${isoPath}`);
	emitLog(`Devices: ${options.destinations.map((d) => d.device).join(', ')}`);
	emitLog(`Drivers: ${options.driversPath ?? 'none'}`);

	const result: WriteResult = {
		bytesWritten: 0,
		devices: { successful: 0, failed: 0 },
		errors: [],
	};

	try {
		if (process.platform !== 'win32') {
			await checkRequiredPrograms(platform);
		}
		// Everything that can fail without touching the drives goes first
		const isoRoot = await platform.mountIso(isoPath);
		const files = await listFiles(isoRoot);
		if (!files.some((file) => isInstallImage(file.relativePath))) {
			throw userError(
				'This does not look like a Windows installation image (sources/install.wim or install.esd is missing)',
			);
		}
		const needsSplit = files.some((file) => file.size > FAT32_MAX_FILE_SIZE);
		const wimlib = needsSplit ? await findWimlib() : undefined;
		if (needsSplit && wimlib === undefined) {
			throw userError(
				`install.wim is larger than 4GB and has to be split, which needs wimlib-imagex. ${wimlibInstallHint()}`,
			);
		}
		let driversSize = 0;
		if (options.driversPath) {
			driversSize = (await listFiles(options.driversPath)).reduce(
				(total, file) => total + file.size,
				0,
			);
		}
		const sizePerDrive =
			files.reduce((total, file) => total + file.size, 0) + driversSize;
		const progress = new ProgressTracker(
			sizePerDrive * options.destinations.length,
			options.destinations.length,
		);
		progress.emit(true);

		for (const drive of options.destinations) {
			try {
				await writeDrive(
					platform,
					drive,
					isoRoot,
					files,
					wimlib,
					options.driversPath,
					progress,
				);
				result.devices!.successful += 1;
				result.bytesWritten! += sizePerDrive;
			} catch (error: any) {
				if (aborted) {
					throw error;
				}
				emitLog(`Writing ${drive.device} failed: ${error.message}`);
				progress.fail();
				result.devices!.failed += 1;
				result.errors.push({ ...toJSON(error), device: drive } as any);
			}
		}
		progress.emit(true);
	} finally {
		if (!aborted) {
			await cleanupWindowsWrite();
		}
	}
	return result;
}
