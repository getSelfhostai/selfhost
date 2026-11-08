#!/bin/sh
# Removes what a workspace made outside its own folder.
set -eu
dropdb --if-exists "acme_web_${CONDUCTOR_WORKSPACE_NAME}"
rm -rf "$HOME/Library/Application Support/com.acme.web.dev.$CONDUCTOR_WORKSPACE_NAME"
