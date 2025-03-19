import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const ANIMATED_ICON_UPDATE_TIMEOUT = 60;

export const Animation = GObject.registerClass(
class Animation extends St.Bin {
    _init(file, width, height, speed) {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);

        super._init({
            style: `width: ${width}px; height: ${height}px;`,
        });

        this._file = file;
        this._width = width;
        this._height = height;

        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('resource-scale-changed',
            () => this._loadFile());

        themeContext.connectObject('notify::scale-factor',
            () => {
                this._loadFile();
                this.set_size(
                    this._width * themeContext.scale_factor,
                    this._height * themeContext.scale_factor);
            }, this);

        this._speed = speed;

        this._isLoaded = false;
        this._isPlaying = false;
        this._timeoutId = 0;
        this._frame = 0;

        this._loadFile();
    }

    play() {
        if (this._isLoaded && this._timeoutId === 0) {
            if (this._frame === 0)
                this._showFrame(0);

            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, this._speed, this._update.bind(this));
            GLib.Source.set_name_by_id(this._timeoutId, '[gnome-shell] this._update');
        }

        this._isPlaying = true;
    }

    stop() {
        if (this._timeoutId > 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        this._isPlaying = false;
    }

    _loadFile() {
        const resourceScale = this.get_resource_scale();
        let wasPlaying = this._isPlaying;

        if (this._isPlaying)
            this.stop();

        this._isLoaded = false;
        this.destroy_all_children();

        let textureCache = St.TextureCache.get_default();
        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._animations = textureCache.load_sliced_image(this._file,
            this._width, this._height,
            scaleFactor, resourceScale,
            () => this._loadFinished());
        this._animations.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.set_child(this._animations);

        if (wasPlaying)
            this.play();
    }

    _showFrame(frame) {
        let oldFrameActor = this._animations.get_child_at_index(this._frame);
        if (oldFrameActor)
            oldFrameActor.hide();

        this._frame = frame % this._animations.get_n_children();

        let newFrameActor = this._animations.get_child_at_index(this._frame);
        if (newFrameActor)
            newFrameActor.show();
    }

    _update() {
        this._showFrame(this._frame + 1);
        return GLib.SOURCE_CONTINUE;
    }

    _loadFinished() {
        this._isLoaded = this._animations.get_n_children() > 0;

        if (this._isLoaded && this._isPlaying)
            this.play();
    }

    _onDestroy() {
        this.stop();
    }
});

export const AnimatedIcon = GObject.registerClass(
class AnimatedIcon extends Animation {
    _init(file, size) {
        super._init(file, size, size, ANIMATED_ICON_UPDATE_TIMEOUT);
    }
});