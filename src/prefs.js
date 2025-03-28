/* =============================================================================================================
	SyncthingIndicator 0.42
================================================================================================================

	GJS syncthing gnome-shell indicator preferences.

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import {
    ExtensionPreferences,
    gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class SyncthingIndicatorExtensionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;

        const iconTheme = Gtk.IconTheme.get_for_display(window.get_display());
        const iconsDirectory = this.dir.get_child("icons").get_path();
        iconTheme.add_search_path(iconsDirectory);

        this._general();
    }

    _general() {
        const page = new Adw.PreferencesPage();
        this._window.add(page);

        // About button
        const aboutButton = new Gtk.Button({
            child: new Adw.ButtonContent({
                icon_name: "help-about-symbolic",
            }),
        });
        const pagesStack = page.get_parent(); // AdwViewStack
        const contentStack = pagesStack.get_parent().get_parent(); // GtkStack
        const preferences = contentStack.get_parent(); // GtkBox
        const headerBar = preferences
            .get_first_child()
            .get_next_sibling()
            .get_first_child()
            .get_first_child()
            .get_first_child(); // AdwHeaderBar
        headerBar.pack_start(aboutButton);
        aboutButton.connect("clicked", () => {
            this.showAbout();
        });

        let settings = this.getSettings("org.gnome.shell.extensions.syncthing");

        // Settings group
        const mainGroup = new Adw.PreferencesGroup({
            title: _("settings-group-title"),
            description: _("settings-group-description"),
        });
        page.add(mainGroup);

        // Menu type model
        let menuTypesModel = new Gtk.StringList();
        menuTypesModel.append(_("quick-settings"));
        menuTypesModel.append(_("main-panel"));

        // Menu type combo selector
        const typeCombo = new Adw.ComboRow({
            title: _("menu-type-title", "Menu type"),
            subtitle: _("menu-type-subtitle"),
            model: menuTypesModel,
        });
        settings.bind(
            "menu",
            typeCombo,
            "selected",
            Gio.SettingsBindFlags.DEFAULT
        );
        mainGroup.add(typeCombo);

        // Icon state switch
        const iconStateSwitch = new Adw.SwitchRow({
            title: _("icon-state-title", "Icon state"),
            subtitle: _("icon-state-subtitle"),
        });
        settings.bind(
            "icon-state",
            iconStateSwitch,
            "active",
            Gio.SettingsBindFlags.DEFAULT
        );
        mainGroup.add(iconStateSwitch);

        // Settings button switch
        const autoStartItemSwitch = new Adw.SwitchRow({
            title: _("auto-start-item"),
            subtitle: _("auto-start-item-subtitle"),
        });
        settings.bind(
            "auto-start-item",
            autoStartItemSwitch,
            "active",
            Gio.SettingsBindFlags.DEFAULT
        );
        mainGroup.add(autoStartItemSwitch);

        // Settings button switch
        const settingsButtonSwitch = new Adw.SwitchRow({
            title: _("setting-button-title"),
            subtitle: _("setting-button-subtitle"),
        });
        settings.bind(
            "settings-button",
            settingsButtonSwitch,
            "active",
            Gio.SettingsBindFlags.DEFAULT
        );
        mainGroup.add(settingsButtonSwitch);

        // Automatic configuration group
        const autoGroup = new Adw.PreferencesGroup({
            title: _("auto-config-group-title", ""),
            description: _("auto-config-group-description"),
        });
        page.add(autoGroup);

        // Automatic configuration switch
        const autoConfigSwitch = new Adw.SwitchRow({
            title: _("auto-config-title"),
            subtitle: _("auto-config-subtitle"),
        });
        settings.bind(
            "auto-config",
            autoConfigSwitch,
            "active",
            Gio.SettingsBindFlags.DEFAULT
        );
        autoGroup.add(autoConfigSwitch);

        // Config file view
        const configFileView = new Adw.ActionRow({
            title: _("config-file-title"),
            subtitle: "%CONFIGVALUE%",
        });
        settings.bind(
            "auto-config",
            configFileView,
            "visible",
            Gio.SettingsBindFlags.DEFAULT
        );
        autoGroup.add(configFileView);

        // Service address & port view
        const serviceAddressView = new Adw.ActionRow({
            title: _("service-address-title"),
            subtitle: "%CONFIGVALUE%",
        });
        settings.bind(
            "auto-config",
            serviceAddressView,
            "visible",
            Gio.SettingsBindFlags.DEFAULT
        );
        autoGroup.add(serviceAddressView);

        // API key view
        const apiKeyView = new Adw.ActionRow({
            title: _("api-key-title"),
            subtitle: "%CONFIGVALUE%",
        });
        settings.bind(
            "auto-config",
            apiKeyView,
            "visible",
            Gio.SettingsBindFlags.DEFAULT
        );
        autoGroup.add(apiKeyView);

        // Service address & port entry
        const serviceAddressEntry = new Adw.EntryRow({
            title: _("service-address-title"),
            tooltip_text: _("service-address-tooltip"),
            show_apply_button: true,
        });
        settings.bind(
            "auto-config",
            serviceAddressEntry,
            "visible",
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        settings.bind(
            "service-address",
            serviceAddressEntry,
            "text",
            Gio.SettingsBindFlags.DEFAULT
        );
        autoGroup.add(serviceAddressEntry);

        // API key entry
        const apiKeyEntry = new Adw.EntryRow({
            title: _("api-key-title"),
            tooltip_text: _("api-key-tooltip"),
            show_apply_button: true,
        });
        settings.bind(
            "auto-config",
            apiKeyEntry,
            "visible",
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        settings.bind(
            "api-key",
            apiKeyEntry,
            "text",
            Gio.SettingsBindFlags.DEFAULT
        );
        autoGroup.add(apiKeyEntry);
    }

    showAbout() {
        const about_window = new Adw.AboutWindow({
            transient_for: this._window,
            modal: true,
        });
        about_window.set_application_icon("syncthing-idle");
        about_window.set_application_name(_("syncthing-indicator"));
        about_window.set_version(`${this.metadata.version}`);
        about_window.set_developer_name("2nv2u");
        about_window.set_issue_url(this.metadata.url + "/issues");
        about_window.set_website(this.metadata.url);
        about_window.set_license_type(Gtk.License.GPL_3_0);
        about_window.set_copyright(_("copyright") + " © 2025 2nv2u");
        about_window.show();
    }
}
