// CSS custom properties for engines without them (Chromium < 49, e.g. LG webOS 3.x).
// The plugin's styles are <style> elements built in JS and use var(--…) heavily;
// css-vars-ponyfill rewrites them to static values and keeps watching for new
// ones. jellyfin-web's own stylesheets are <link>s and are left alone.
import cssVars from 'css-vars-ponyfill';

var supported = window.CSS && CSS.supports && CSS.supports('color', 'var(--je-probe)');

if (!supported) {
    var start = function () {
        cssVars({
            include: 'style',
            onlyLegacy: true,
            watch: true,
            silent: true,
            updateURLs: false
        });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
}
