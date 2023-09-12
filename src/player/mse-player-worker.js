/*
 * Copyright (C) 2023 もにょてっく. All Rights Reserved.
 *
 * @author もにょ〜ん <monyone.teihen@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from '../utils/logger.js';
import {IllegalStateException} from '../utils/exception.js';

import Polyfill from '../utils/polyfill.js';
import PlayerEvents from './player-events.js'
import MSEController from '../core/mse-controller.js';
import Transmuxer from '../core/transmuxer.js';
import TransmuxingEvents from '../core/transmuxing-events.js';

class MSEControllerForWorker extends MSEController {
    constructor(config) {
        super(config);
        this.currentTime = 0;
        this.readyState = 0;
    }

    attachMediaElement() {
        if (this._mediaSource) {
            throw new IllegalStateException('MediaSource has been attached to an HTMLMediaElement!');
        }
        let ms = this._mediaSource = new self.MediaSource();
        ms.addEventListener('sourceopen', this.e.onSourceOpen);
        ms.addEventListener('sourceended', this.e.onSourceEnded);
        ms.addEventListener('sourceclose', this.e.onSourceClose);

        this._mediaSourceObjectURL = null
        return this._mediaSource.handle;
    }

    _needCleanupSourceBuffer() {
        if (!this._config.autoCleanupSourceBuffer) {
            return false;
        }

        for (let type in this._sourceBuffers) {
            let sb = this._sourceBuffers[type];
            if (sb) {
                let buffered = sb.buffered;
                if (buffered.length >= 1) {
                    if (this.currentTime - buffered.start(0) >= this._config.autoCleanupMaxBackwardDuration) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    _doCleanupSourceBuffer() {
        for (let type in this._sourceBuffers) {
            let sb = this._sourceBuffers[type];
            if (sb) {
                let buffered = sb.buffered;
                let doRemove = false;

                for (let i = 0; i < buffered.length; i++) {
                    let start = buffered.start(i);
                    let end = buffered.end(i);

                    if (start <= this.currentTime && this.currentTime < end + 3) {  // padding 3 seconds
                        if (this.currentTime - start >= this._config.autoCleanupMaxBackwardDuration) {
                            doRemove = true;
                            let removeEnd = this.currentTime - this._config.autoCleanupMinBackwardDuration;
                            this._pendingRemoveRanges[type].push({start: start, end: removeEnd});
                        }
                    } else if (end < this.currentTime) {
                        doRemove = true;
                        this._pendingRemoveRanges[type].push({start: start, end: end});
                    }
                }

                if (doRemove && !sb.updating) {
                    this._doRemoveRanges();
                }
            }
        }
    }

    _updateMediaSourceDuration() {
        let sb = this._sourceBuffers;
        if (this.readyState === HTMLMediaElement.HAVE_NOTHING || this._mediaSource.readyState !== 'open') {
            return;
        }
        if ((sb.video && sb.video.updating) || (sb.audio && sb.audio.updating)) {
            return;
        }

        let current = this._mediaSource.duration;
        let target = this._pendingMediaDuration;

        if (target > 0 && (isNaN(current) || target > current)) {
            Log.v(this.TAG, `Update MediaSource duration from ${current} to ${target}`);
            this._mediaSource.duration = target;
        }

        this._requireSetMediaDuration = false;
        this._pendingMediaDuration = 0;
    }
}

// Media Source Extensions controller
let MSEWorker = function (self) {
    let _msectl = null;
    let _transmuxer = null;
    let currentTime = 0;

    Polyfill.install();
    self.addEventListener('message', function (e) {
        switch (e.data.cmd) {
            case 'init':
                _msectl = new MSEControllerForWorker(e.data.param[1]);
                _transmuxer = new Transmuxer(e.data.param[0], { ... e.data.param[1], enableWorker: false });

                _transmuxer.on(TransmuxingEvents.INIT_SEGMENT, (type, is) => {
                    if (_msectl == null) { throw new IllegalStateException('MSEController not Initialized!'); }
                    _msectl.appendInitSegment(is);
                });
                _transmuxer.on(TransmuxingEvents.MEDIA_SEGMENT, (type, ms) => {
                    if (_msectl == null) { throw new IllegalStateException('MSEController not Initialized!'); }
                    _msectl.appendMediaSegment(ms);

                    // lazyLoad check
                    if (e.data.param[1].lazyLoad && !e.data.param[1].isLive) {
                        if (ms.info.endDts >= (currentTime + e.data.param[1].lazyLoadMaxDuration) * 1000) {
                            /*
                            if (this._progressChecker == null) {
                                Log.v(this.TAG, 'Maximum buffering duration exceeded, suspend transmuxing task');
                                this._suspendTransmuxer();
                            }
                            */
                        }
                    }
                });
                _transmuxer.on(TransmuxingEvents.LOADING_COMPLETE, () => {
                    if (_msectl == null) { throw new IllegalStateException('MSEController not Initialized!'); }
                    _msectl.endOfStream();
                    self.postMessage({ cmd: PlayerEvents.LOADING_COMPLETE });
                });
                _transmuxer.open();

                break;
            case 'attachMediaElement': {
                if (_msectl == null) { throw new IllegalStateException('MSEController not Initialized!'); }
                const handle = _msectl.attachMediaElement()
                self.postMessage({
                    cmd: 'attachMediaElement',
                    handle,
                }, [handle]);
                break;
            }
            case 'detachMediaElement':
                if (_msectl == null) { throw new IllegalStateException('MSEController not Initialized!'); }
                _msectl.detachMediaElement();
                self.postMessage({
                    cmd: 'detachMediaElement',
                });
                break;
            case 'timeupdate':
                if (_msectl == null) { throw new IllegalStateException('MSEController not Initialized!'); }
                _msectl.currentTime = e.data.currnetTime;
                break;
            case 'readystatechange ':
                if (_msectl == null) { throw new IllegalStateException('MSEController not Initialized!'); }
                _msectl.readyState = e.data.readyState;
                break;
        }
    });
};

export default MSEWorker;
