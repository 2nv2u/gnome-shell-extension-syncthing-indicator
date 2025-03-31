/* =============================================================================================================
	SyncthingIndicator 0.44
================================================================================================================

	GJS syncthing gnome-shell panel indicator signalling the Syncthing deamon status.

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import GObject from "gi://GObject";
import Clutter from "gi://Clutter";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import * as Components from "./components.js";
import * as Syncthing from "./syncthing.js";

const LOG_PREFIX = "syncthing-indicator-panel-menu:";

// Syncthing indicator controller panel
export const SyncthingIndicatorPanel = GObject.registerClass(
    {
        GTypeName: "SyncthingIndicatorPanel",
    },
    class SyncthingIndicatorPanel extends PanelMenu.Button {
        _init(extension) {
            super._init(0.0, "SyncthingIndicatorPanel");

            this.menu.box.add_style_class_name("syncthing-indicator");
            this.menu.box.add_style_class_name("panel");
            this.menu.box.add_style_class_name("quick-toggle-menu");

            // Header section
            // This is too instrusive in the implementation of the QuickToggleMenu
            // Find another way to create the header
            // TODO: Revisit
            const headerLayout = new Clutter.GridLayout();
            this._header = new St.Widget({
                style_class: "header",
                layout_manager: headerLayout,
            });
            headerLayout.hookup_style(this._header);
            this.menu.box.add_child(this._header);
            this._headerIcon = new St.Icon({
                style_class: "icon",
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._headerTitle = new St.Label({
                style_class: "title",
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            });
            this._headerSpacer = new Clutter.Actor({ x_expand: true });
            const side =
                this.menu.actor.text_direction === Clutter.TextDirection.RTL
                    ? Clutter.GridPosition.LEFT
                    : Clutter.GridPosition.RIGHT;
            headerLayout.attach(this._headerIcon, 0, 0, 1, 2);
            headerLayout.attach_next_to(
                this._headerTitle,
                this._headerIcon,
                side,
                1,
                1
            );
            headerLayout.attach_next_to(
                this._headerSpacer,
                this._headerTitle,
                side,
                1,
                1
            );
            this._headerTitle.text = _("syncthing");
            // Header action bar section
            const actionLayout = new Clutter.GridLayout();
            const actionBar = new St.Widget({
                layout_manager: actionLayout,
            });
            this._headerSpacer.x_align = Clutter.ActorAlign.END;
            this._headerSpacer.add_child(actionBar);

            const rescanButton = new Components.RescanButton(extension);
            actionLayout.attach(rescanButton, 0, 0, 1, 1);

            const advancedButton = new Components.AdvancedButton(extension);
            actionLayout.attach_next_to(
                advancedButton,
                rescanButton,
                Clutter.GridPosition.RIGHT,
                1,
                1
            );
            if (extension.settings.get_boolean("settings-button")) {
                const settingsButton = new Components.SettingsButton(extension);
                actionLayout.attach_next_to(
                    settingsButton,
                    advancedButton,
                    Clutter.GridPosition.RIGHT,
                    1,
                    1
                );
            }

            this.panel = new Components.SyncthingPanel(extension, this.menu);
            this.panel.showServiceSwitch(true);
            this.panel.showAutostartSwitch(
                extension.settings.get_boolean("auto-start-item")
            );
            this.panel.icon.addActor(this._headerIcon);
            this.add_child(this.panel.icon);
        }

        open(animate) {
            this.panel.open(animate);
        }

        close() {
            this.panel.close();
        }
    }
);
