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

# Generate fallback.json from en.po
echo "{" > $SCRIPT_PATH/src/locale/fallback.json
FIRST=1
while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ $line == msgid\ \"* ]]; then
        msgid="${line#msgid \"}"
        msgid="${msgid%\"}"
    elif [[ $line == msgstr\ \"* ]]; then
        msgstr="${line#msgstr \"}"
        msgstr="${msgstr%\"}"
    elif [[ $line == \"*\" ]] && [[ -n "$msgstr" ]]; then
        cont="${line%\"}"
        cont="${cont#\"}"
        msgstr="$msgstr$cont"
    elif [[ -z "$line" ]] && [[ -n "$msgid" ]] && [[ -n "$msgstr" ]]; then
        if [[ -n "$msgid" ]] && [[ "$msgid" != "\"\"" ]]; then
            if [[ $FIRST == 1 ]]; then
                FIRST=0
            else
                echo "," >> $SCRIPT_PATH/src/locale/fallback.json
            fi
            printf '  "%s": "%s"' "$msgid" "$msgstr" >> $SCRIPT_PATH/src/locale/fallback.json
        fi
        msgid=""
        msgstr=""
    fi
done < $SCRIPT_PATH/po/en.po
        echo "" >> $SCRIPT_PATH/src/locale/fallback.json
echo "}" >> $SCRIPT_PATH/src/locale/fallback.json

# Compile schemas
[ -f $CUR_PATH/src/schemas/gschemas.compiled ] && rm -f $CUR_PATH/src/schemas/gschemas.compiled
glib-compile-schemas $SCRIPT_PATH/src/schemas/

# Zip extensions files
[ -f $CUR_PATH/$EXT_NAME.zip ] && rm -f $CUR_PATH/$EXT_NAME.zip
(cd $SCRIPT_PATH/src && zip -r $CUR_PATH/$EXT_NAME.zip *)
zip -r $CUR_PATH/$EXT_NAME.zip -j $SCRIPT_PATH/LICENSE
