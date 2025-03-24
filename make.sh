#!/usr/bin/env bash

#======================================================================================================
#	Extension make script
#======================================================================================================

SCRIPT=$(readlink -f "${BASH_SOURCE[0]}")
SCRIPT_PATH=$(dirname "$SCRIPT")
CUR_PATH=$(pwd)

EXT_NAME="syncthing@gnome.2nv2u.com"

# Generate translations
[ -d $SCRIPT_PATH/src/locale ] && rm -rf $SCRIPT_PATH/src/locale
for LANG_FILE in $SCRIPT_PATH/po/*.po; do
    MO_PATH=$SCRIPT_PATH/src/locale/$(basename "${LANG_FILE%.*}")/LC_MESSAGES
    mkdir -p $MO_PATH
    msgfmt $LANG_FILE -o $MO_PATH/$EXT_NAME.mo
done

# Compile schemas
glib-compile-schemas $SCRIPT_PATH/src/schemas/

# Zip extensions files
[ -f $CUR_PATH/$EXT_NAME.zip ] && rm -f $CUR_PATH/$EXT_NAME.zip
(cd $SCRIPT_PATH/src && zip -r $CUR_PATH/$EXT_NAME.zip *)
zip -r $CUR_PATH/$EXT_NAME.zip -j $SCRIPT_PATH/LICENSE