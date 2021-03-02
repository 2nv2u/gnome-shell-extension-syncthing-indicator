#!/bin/bash

#======================================================================================================
#	Extension install script
#======================================================================================================

SCRIPT=$(readlink -f "${BASH_SOURCE[0]}")
SCRIPT_PATH=$(dirname "$SCRIPT")

source "$SCRIPT_PATH/make.sh"

gnome-extensions install $CUR_PATH/$EXT_NAME.zip
gnome-extensions enable $EXT_NAME
rm -f $CUR_PATH/$EXT_NAME.zip