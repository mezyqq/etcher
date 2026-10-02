#!/bin/bash

# The package installs the app to /usr/lib/balena-etcher and already ships
# the /usr/bin/balena-etcher symlink.

# SUID chrome-sandbox for Electron 5+, needed where unprivileged user
# namespaces are restricted (e.g. Ubuntu 24.04)
chmod 4755 '/usr/lib/balena-etcher/chrome-sandbox' || true

update-mime-database /usr/share/mime || true
update-desktop-database /usr/share/applications || true
