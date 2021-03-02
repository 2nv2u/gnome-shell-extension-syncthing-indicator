#!/bin/bash

#======================================================================================================
#	Extension make script
#======================================================================================================

SCRIPT=$(readlink -f "${BASH_SOURCE[0]}")
SCRIPT_PATH=$(dirname "$SCRIPT")
CUR_PATH=$(pwd)

EXT_NAME="syncthing@gnome.2nv2u.com"

( cd $SCRIPT_PATH && zip -r $CUR_PATH/$EXT_NAME.zip * --exclude=.git/\* --exclude=*.sh --exclude=*.md)