// DOM shims for old TV web engines (LG webOS 3.x = Chromium 38), bundled into
// the ES5 compatibility layer by scripts/es5/build.mjs. Everything here
// feature-detects first and is a no-op on current browsers. ECMAScript
// built-ins come from core-js; this file covers the DOM APIs core-js doesn't.
/* eslint-disable no-extend-native */

(function () {
    'use strict';

    var ElementProto = window.Element && Element.prototype;
    if (!ElementProto) return;

    function define(proto, name, value) {
        if (proto && !(name in proto)) {
            Object.defineProperty(proto, name, { configurable: true, enumerable: false, writable: true, value: value });
        }
    }

    function defineGetter(proto, name, get) {
        if (proto && !(name in proto)) {
            Object.defineProperty(proto, name, { configurable: true, enumerable: false, get: get });
        }
    }

    /* ---- Element.matches / closest (Chrome 34 / 41) ---- */

    if (ElementProto.webkitMatchesSelector) define(ElementProto, 'matches', ElementProto.webkitMatchesSelector);
    define(ElementProto, 'closest', function (selector) {
        var node = this;
        while (node && node.nodeType === 1) {
            if (node.matches(selector)) return node;
            node = node.parentElement || node.parentNode;
        }
        return null;
    });

    /* ---- ParentNode / ChildNode convenience methods (Chrome 54 / 86) ---- */

    function toNode(item) {
        return item instanceof Node ? item : document.createTextNode(String(item));
    }

    function toFragment(args) {
        var fragment = document.createDocumentFragment();
        for (var i = 0; i < args.length; i++) fragment.appendChild(toNode(args[i]));
        return fragment;
    }

    var parents = [ElementProto, window.Document && Document.prototype, window.DocumentFragment && DocumentFragment.prototype];
    parents.forEach(function (proto) {
        define(proto, 'append', function () {
            this.appendChild(toFragment(arguments));
        });
        define(proto, 'prepend', function () {
            this.insertBefore(toFragment(arguments), this.firstChild);
        });
        define(proto, 'replaceChildren', function () {
            var fragment = toFragment(arguments);
            while (this.firstChild) this.removeChild(this.firstChild);
            this.appendChild(fragment);
        });
    });

    var children = [ElementProto, window.CharacterData && CharacterData.prototype, window.DocumentType && DocumentType.prototype];
    children.forEach(function (proto) {
        define(proto, 'remove', function () {
            if (this.parentNode) this.parentNode.removeChild(this);
        });
        define(proto, 'before', function () {
            if (this.parentNode) this.parentNode.insertBefore(toFragment(arguments), this);
        });
        define(proto, 'after', function () {
            if (this.parentNode) this.parentNode.insertBefore(toFragment(arguments), this.nextSibling);
        });
        define(proto, 'replaceWith', function () {
            if (this.parentNode) this.parentNode.replaceChild(toFragment(arguments), this);
        });
    });

    /* ---- Node.isConnected (Chrome 54) ---- */

    defineGetter(Node.prototype, 'isConnected', function () {
        var doc = this.ownerDocument || this;
        return doc.documentElement ? doc.documentElement.contains(this) || doc === this : false;
    });

    /* ---- Element.getAttributeNames / toggleAttribute (Chrome 61 / 69) ---- */

    define(ElementProto, 'getAttributeNames', function () {
        var names = [];
        for (var i = 0; i < this.attributes.length; i++) names.push(this.attributes[i].name);
        return names;
    });
    define(ElementProto, 'toggleAttribute', function (name, force) {
        var has = this.hasAttribute(name);
        var want = force === undefined ? !has : !!force;
        if (want && !has) this.setAttribute(name, '');
        if (!want && has) this.removeAttribute(name);
        return want;
    });

    /* ---- getPropertyValue returns null, not '', for unset properties (old Chromium) ---- */

    if (window.CSSStyleDeclaration && document.documentElement.style.getPropertyValue('--je-probe') === null) {
        var nativeGetPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
        CSSStyleDeclaration.prototype.getPropertyValue = function () {
            var value = nativeGetPropertyValue.apply(this, arguments);
            return value === null ? '' : value;
        };
    }

    /* ---- Node.getRootNode (Chrome 54) ---- */

    define(Node.prototype, 'getRootNode', function () {
        var node = this;
        while (node.parentNode) node = node.parentNode;
        return node;
    });

    /* ---- DOMTokenList: toggle(token, force) and multi-token add/remove ---- */

    (function () {
        var probe = document.createElement('div');
        var list = probe.classList;
        if (!list) return;
        var TokenProto = Object.getPrototypeOf(list);
        list.toggle('a', true);
        if (!list.contains('a')) {
            var nativeToggle = TokenProto.toggle;
            TokenProto.toggle = function (token, force) {
                if (arguments.length < 2) return nativeToggle.call(this, token);
                if (force) this.add(token); else this.remove(token);
                return !!force;
            };
        }
        list.add('b', 'c');
        if (!list.contains('c')) {
            ['add', 'remove'].forEach(function (method) {
                var original = TokenProto[method];
                TokenProto[method] = function () {
                    for (var i = 0; i < arguments.length; i++) original.call(this, arguments[i]);
                };
            });
        }
    })();

    /* ---- PointerEvent constructor (Chrome 55); pointer listeners simply never fire ---- */

    if (!window.PointerEvent && window.MouseEvent) {
        window.PointerEvent = function PointerEvent(type, init) {
            var event = new MouseEvent(type, init);
            event.pointerId = init && init.pointerId !== undefined ? init.pointerId : 1;
            event.pointerType = (init && init.pointerType) || 'mouse';
            event.isPrimary = init && init.isPrimary !== undefined ? init.isPrimary : true;
            return event;
        };
        window.PointerEvent.prototype = MouseEvent.prototype;
    }

    /* ---- Intl.DisplayNames (Chrome 81): no names available, callers fall back to the code ---- */

    if (window.Intl && !Intl.DisplayNames) {
        Intl.DisplayNames = function DisplayNames(locales, options) {
            this.options = options || {};
        };
        Intl.DisplayNames.prototype.of = function () { return undefined; };
        Intl.DisplayNames.prototype.resolvedOptions = function () { return this.options; };
    }

    /* ---- DOMRect x / y (Chrome 61: ClientRect has only left/top) ---- */

    var RectProto = window.ClientRect ? ClientRect.prototype : (window.DOMRect ? DOMRect.prototype : null);
    defineGetter(RectProto, 'x', function () { return this.left; });
    defineGetter(RectProto, 'y', function () { return this.top; });

    /* ---- document.scrollingElement (Chrome 44) ---- */

    if (!('scrollingElement' in document)) {
        Object.defineProperty(Document.prototype, 'scrollingElement', {
            configurable: true,
            get: function () {
                return this.compatMode === 'BackCompat' ? this.body : (this.body && this.body.scrollTop ? this.body : this.documentElement);
            }
        });
    }

    // requestIdleCallback is deliberately not shimmed: every caller checks for it
    // and has its own setTimeout fallback with deliberately chosen delays.

    /* ---- scrollTo / scrollBy / scrollIntoView with an options object (Chrome 61) ---- */

    // Options objects and CSS scroll-behavior both arrived in Chromium 61; probing
    // by calling scrollTo would scroll the page.
    function scrollOptionsSupported() {
        return 'scrollBehavior' in document.documentElement.style;
    }

    if (!scrollOptionsSupported()) {
        var scrollElement = function (el, left, top) {
            if (el === window || el === document.documentElement || el === document.body) {
                window.scrollTo(left, top);
            } else {
                el.scrollLeft = left;
                el.scrollTop = top;
            }
        };
        var currentLeft = function (el) { return el === window ? window.pageXOffset : el.scrollLeft; };
        var currentTop = function (el) { return el === window ? window.pageYOffset : el.scrollTop; };
        var make = function (relative, nativeFn) {
            return function (a, b) {
                var self = this;
                if (a && typeof a === 'object') {
                    var left = a.left !== undefined ? +a.left : (relative ? 0 : currentLeft(self));
                    var top = a.top !== undefined ? +a.top : (relative ? 0 : currentTop(self));
                    if (relative) {
                        left += currentLeft(self);
                        top += currentTop(self);
                    }
                    if (self === window && nativeFn) return nativeFn.call(window, left, top);
                    return scrollElement(self, left, top);
                }
                if (self === window && nativeFn) return nativeFn.call(window, a, b);
                return scrollElement(self, relative ? currentLeft(self) + (+a || 0) : +a || 0, relative ? currentTop(self) + (+b || 0) : +b || 0);
            };
        };
        var nativeScrollTo = window.scrollTo;
        var nativeScrollBy = window.scrollBy;
        window.scrollTo = window.scroll = make(false, nativeScrollTo);
        window.scrollBy = make(true, nativeScrollBy);
        ElementProto.scrollTo = ElementProto.scroll = make(false, null);
        ElementProto.scrollBy = make(true, null);

        var nativeScrollIntoView = ElementProto.scrollIntoView;
        ElementProto.scrollIntoView = function (arg) {
            if (arg && typeof arg === 'object') {
                if ((arg.block === 'center' || arg.block === 'nearest') && this.scrollIntoViewIfNeeded) {
                    return this.scrollIntoViewIfNeeded(arg.block === 'center');
                }
                return nativeScrollIntoView.call(this, arg.block !== 'end');
            }
            return nativeScrollIntoView.apply(this, arguments);
        };
    }

    /* ---- addEventListener options object: once / passive / signal (Chrome 49 / 55 / 90) ---- */

    var optionsSupport = { capture: false, once: false, signal: false };
    try {
        var probe = {};
        Object.defineProperty(probe, 'capture', { get: function () { optionsSupport.capture = true; return false; } });
        Object.defineProperty(probe, 'once', { get: function () { optionsSupport.once = true; return false; } });
        Object.defineProperty(probe, 'signal', { get: function () { optionsSupport.signal = true; return undefined; } });
        window.addEventListener('je-options-probe', null, probe);
        window.removeEventListener('je-options-probe', null, probe);
    } catch (e) { /* treated as unsupported */ }

    if (!optionsSupport.capture || !optionsSupport.once || !optionsSupport.signal) {
        var WRAPPERS = '__jeListenerWrappers';
        var patchTarget = function (proto) {
            if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'addEventListener') || proto.__jeListenersPatched) return;
            var nativeAdd = proto.addEventListener;
            var nativeRemove = proto.removeEventListener;
            proto.__jeListenersPatched = true;

            proto.addEventListener = function (type, listener, options) {
                if (!options || typeof options !== 'object' || !listener) {
                    return nativeAdd.call(this, type, listener, options);
                }
                var capture = !!options.capture;
                var signal = options.signal;
                if (signal && signal.aborted) return undefined;

                var target = this;
                var wrapper = listener;
                if (options.once || signal) {
                    var list = listener[WRAPPERS] || (listener[WRAPPERS] = []);
                    for (var i = 0; i < list.length; i++) {
                        if (list[i].target === target && list[i].type === type && list[i].capture === capture) return undefined;
                    }
                    wrapper = function (event) {
                        if (options.once) target.removeEventListener(type, listener, capture);
                        return typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
                    };
                    list.push({ target: target, type: type, capture: capture, wrapper: wrapper });
                    if (signal && signal.addEventListener) {
                        signal.addEventListener('abort', function () {
                            target.removeEventListener(type, listener, capture);
                        });
                    }
                }
                return nativeAdd.call(this, type, wrapper, capture);
            };

            proto.removeEventListener = function (type, listener, options) {
                var capture = options && typeof options === 'object' ? !!options.capture : !!options;
                var list = listener && listener[WRAPPERS];
                if (list) {
                    for (var i = 0; i < list.length; i++) {
                        var entry = list[i];
                        if (entry.target === this && entry.type === type && entry.capture === capture) {
                            list.splice(i, 1);
                            return nativeRemove.call(this, type, entry.wrapper, capture);
                        }
                    }
                }
                return nativeRemove.call(this, type, listener, capture);
            };
        };
        // Older engines define the methods on several prototypes, not only EventTarget.
        [window.EventTarget && EventTarget.prototype, Node.prototype, Window.prototype,
            window.XMLHttpRequest && XMLHttpRequest.prototype, window.MediaQueryList && MediaQueryList.prototype,
            window.FileReader && FileReader.prototype, window.Worker && Worker.prototype]
            .forEach(patchTarget);
    }

    /* ---- MediaQueryList.addEventListener (Chrome 45) ---- */

    if (window.matchMedia) {
        var mql = window.matchMedia('all');
        if (mql && !mql.addEventListener && mql.addListener) {
            var MqlProto = Object.getPrototypeOf(mql);
            MqlProto.addEventListener = function (type, listener) {
                if (type === 'change') this.addListener(listener);
            };
            MqlProto.removeEventListener = function (type, listener) {
                if (type === 'change') this.removeListener(listener);
            };
        }
    }

    /* ---- new EventTarget() (Chrome 64) ---- */

    var eventTargetConstructible = true;
    try { new window.EventTarget(); } catch (e) { eventTargetConstructible = false; }
    if (!eventTargetConstructible) {
        var NativeEventTarget = window.EventTarget;
        var ShimEventTarget = function EventTarget() {
            var delegate = document.createDocumentFragment();
            this.addEventListener = delegate.addEventListener.bind(delegate);
            this.removeEventListener = delegate.removeEventListener.bind(delegate);
            this.dispatchEvent = delegate.dispatchEvent.bind(delegate);
        };
        if (NativeEventTarget) ShimEventTarget.prototype = NativeEventTarget.prototype;
        window.EventTarget = ShimEventTarget;
    }

    /* ---- KeyboardEvent.key / code (Chrome 51 / 48) — TV remotes only send keyCode ---- */

    var KEY_NAMES = {
        3: 'Cancel', 8: 'Backspace', 9: 'Tab', 12: 'Clear', 13: 'Enter', 16: 'Shift', 17: 'Control', 18: 'Alt',
        19: 'Pause', 20: 'CapsLock', 27: 'Escape', 32: ' ', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
        37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 45: 'Insert', 46: 'Delete',
        91: 'Meta', 93: 'ContextMenu', 144: 'NumLock', 145: 'ScrollLock',
        106: '*', 107: '+', 109: '-', 110: '.', 111: '/',
        173: 'AudioVolumeMute', 174: 'AudioVolumeDown', 175: 'AudioVolumeUp',
        176: 'MediaTrackNext', 177: 'MediaTrackPrevious', 178: 'MediaStop', 179: 'MediaPlayPause',
        186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: '\'',
        // LG webOS remote
        403: 'ColorF0Red', 404: 'ColorF1Green', 405: 'ColorF2Yellow', 406: 'ColorF3Blue',
        412: 'MediaRewind', 413: 'MediaStop', 415: 'MediaPlay', 417: 'MediaFastForward',
        461: 'GoBack', 10252: 'MediaPlayPause'
    };
    var CODE_NAMES = {
        8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'ShiftLeft', 17: 'ControlLeft', 18: 'AltLeft', 27: 'Escape',
        32: 'Space', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'ArrowLeft', 38: 'ArrowUp',
        39: 'ArrowRight', 40: 'ArrowDown', 45: 'Insert', 46: 'Delete'
    };

    if (window.KeyboardEvent && !('key' in KeyboardEvent.prototype)) {
        Object.defineProperty(KeyboardEvent.prototype, 'key', {
            configurable: true,
            get: function () {
                var code = this.keyCode || this.which;
                if (KEY_NAMES[code]) return KEY_NAMES[code];
                if (code >= 112 && code <= 135) return 'F' + (code - 111);
                if (code >= 96 && code <= 105) return String(code - 96);
                if (this.type === 'keypress' && this.charCode) return String.fromCharCode(this.charCode);
                if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) {
                    var ch = String.fromCharCode(code);
                    return this.shiftKey ? ch : ch.toLowerCase();
                }
                return 'Unidentified';
            }
        });
    }

    if (window.KeyboardEvent && !('code' in KeyboardEvent.prototype)) {
        Object.defineProperty(KeyboardEvent.prototype, 'code', {
            configurable: true,
            get: function () {
                var code = this.keyCode || this.which;
                if (CODE_NAMES[code]) return CODE_NAMES[code];
                if (code >= 65 && code <= 90) return 'Key' + String.fromCharCode(code);
                if (code >= 48 && code <= 57) return 'Digit' + String.fromCharCode(code);
                if (code >= 112 && code <= 135) return 'F' + (code - 111);
                return '';
            }
        });
    }
})();
