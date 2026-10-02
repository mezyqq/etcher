# Etcher

> Flash OS images to SD cards & USB drives, safely and easily.

Etcher is a powerful OS image flasher built with web technologies to ensure
flashing an SDCard or USB drive is a pleasant and safe experience. It protects
you from accidentally writing to your hard-drives, ensures every byte of data
was written correctly, and much more. It can also directly flash Raspberry Pi devices that support [USB device boot mode](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-device-boot-mode).

[![Current Release](https://img.shields.io/github/release/balena-io/etcher.svg?style=flat-square)](https://balena.io/etcher)
[![License](https://img.shields.io/github/license/balena-io/etcher.svg?style=flat-square)](https://github.com/balena-io/etcher/blob/master/LICENSE)
[![Balena.io Forums](https://img.shields.io/discourse/https/forums.balena.io/topics.svg?style=flat-square&label=balena.io%20forums)](https://forums.balena.io/c/etcher)

---

[**Download**][etcher] | [**Support**][support] | [**Documentation**][user-documentation] | [**Contributing**][contributing] | [**Roadmap**][milestones]

## Supported Operating Systems

- Linux; most distros; Intel 64-bit.
- Windows 10 and later; Intel 64-bit.
- macOS 10.13 (High Sierra) and later; both Intel and Apple Silicon.

## Flashing Windows installation media

Etcher has two tabs at the top of the window:

- **Linux & other** writes the image to the drive byte for byte. This is the
  right choice for Linux distributions, Raspberry Pi OS and most other images.
- **Windows** creates a bootable Windows installation drive from a Windows
  `.iso` file.

Windows ISOs can not be written byte for byte: the drive boots, but Windows
setup then can not read its own files and stops with *"A media driver your
computer needs is missing"*. The Windows tab prepares the drive the way Windows
setup expects instead:

1. The drive is erased and gets a GPT partition table with a single FAT32
   partition labelled `WINSTALL`.
2. The files of the ISO are copied onto it.
3. `sources/install.wim` is usually larger than the 4GB FAT32 file size limit,
   so it is split into `install.swm`, `install2.swm`, ... which Windows setup
   reads natively.

The drive boots on UEFI computers, including with Secure Boot enabled. Legacy
BIOS boot is not supported.

### Requirements

Splitting `install.wim` needs `wimlib-imagex` from [wimlib](https://wimlib.net).
Etcher checks for it before touching the drive and tells you if it is missing.

| Operating system | Install wimlib with |
| --- | --- |
| Arch / Manjaro | `sudo pacman -S wimlib` |
| Debian / Ubuntu | `sudo apt install wimtools` |
| Fedora | `sudo dnf install wimlib-utils` |
| macOS | `brew install wimlib` |
| Windows | download `wimlib-imagex.exe` from [wimlib.net](https://wimlib.net) and put it next to the Etcher executable or in your `PATH` |

On Linux, `parted` and `dosfstools` (`mkfs.fat`) are needed as well.

On Windows, the partition is limited to 32GB because Windows can not format
larger FAT32 volumes. The rest of a bigger drive is left unallocated.

### Advanced: storage drivers

Most computers do not need this. Use it only if Windows setup starts but lists
no disks to install to, which can happen on some laptops with Intel VMD / RST
enabled.

1. Download the storage driver for your computer (for Intel VMD, the
   "Intel Rapid Storage Technology" F6 driver from Intel or your laptop
   vendor) and extract it, so that you have a folder with `.inf` files.
2. On the Windows tab, open **Advanced** and choose that folder.

Etcher copies the folder to `\etcher-drivers` on the drive and adds an
`autounattend.xml` that loads those drivers when setup starts, so the disk
shows up without clicking "Load driver". The answer file does not automate
anything else: setup asks all its usual questions. If the ISO already contains
its own `autounattend.xml`, Etcher keeps it and the drivers have to be loaded
manually with "Load driver" → browse to `\etcher-drivers`.

## Installers

Refer to the [downloads page][etcher] for the latest pre-made
installers for all supported operating systems.

## Packages

#### Debian and Ubuntu based Package Repository (GNU/Linux x86/x64)

Package for Debian and Ubuntu can be downloaded from the [Github release page](https://github.com/balena-io/etcher/releases/)

##### Install .deb file using apt

   ```sh
      sudo apt install ./balena-etcher_******_amd64.deb
   ```

##### Uninstall

   ```sh
      sudo apt remove balena-etcher
   ```

#### Redhat (RHEL) and Fedora-based Package Repository (GNU/Linux x86/x64)

##### Yum

Package for Fedora-based and Redhat can be downloaded from the [Github release page](https://github.com/balena-io/etcher/releases/)

1. Install using yum

```sh
   sudo yum localinstall balena-etcher-***.x86_64.rpm
```

#### Arch/Manjaro Linux (GNU/Linux x64)

Etcher is offered through the Arch User Repository and can be installed on both Manjaro and Arch systems. You can compile it from the source code in this repository using [`balena-etcher`](https://aur.archlinux.org/packages/balena-etcher/). The following example uses a common AUR helper to install the latest release:

```sh
yay -S balena-etcher
```

##### Uninstall

```sh
yay -R balena-etcher
```

#### WinGet (Windows)

This package is updated by [gh-action](https://github.com/vedantmgoyal2009/winget-releaser), and is kept up to date automatically.

```sh
winget install balenaEtcher #or Balena.Etcher
```

##### Uninstall

```sh
winget uninstall balenaEtcher
```

#### Chocolatey (Windows)

This package is maintained by [@majkinetor](https://github.com/majkinetor), and
is kept up to date automatically.

```sh
choco install etcher
```

##### Uninstall

```sh
choco uninstall etcher
```

## Support

If you're having any problem, please [raise an issue][newissue] on GitHub, and
the balena.io team will be happy to help.

## License

Etcher is free software and may be redistributed under the terms specified in
the [license].

[etcher]: https://balena.io/etcher
[electron]: https://electronjs.org/
[electron-supported-platforms]: https://electronjs.org/docs/tutorial/support#supported-platforms
[support]: https://github.com/balena-io/etcher/blob/master/docs/SUPPORT.md
[contributing]: https://github.com/balena-io/etcher/blob/master/docs/CONTRIBUTING.md
[user-documentation]: https://github.com/balena-io/etcher/blob/master/docs/USER-DOCUMENTATION.md
[milestones]: https://github.com/balena-io/etcher/milestones
[newissue]: https://github.com/balena-io/etcher/issues/new
[license]: https://github.com/balena-io/etcher/blob/master/LICENSE
