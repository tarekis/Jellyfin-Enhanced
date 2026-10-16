using System.IO;
using System.IO.Compression;
using System.Reflection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Which build of the client scripts the server hands out.
    ///
    /// A build made with -p:JeEs5Build=true (release builds) embeds the client scripts
    /// twice: as written (js/**, PluginPages/*.html), and as the ES5 build of
    /// scripts/es5/build.mjs, Brotli-compressed under the "es5." resource prefix with a
    /// ".br" suffix, with a compatibility layer (polyfills) in front of js/plugin.js.
    /// The ES5 build is for old web engines that can't parse modern JavaScript, such as
    /// LG webOS 3.x TVs (Chromium 38) running the official Jellyfin app. It is served
    /// only while the admin turns on <see cref="Configuration.PluginConfiguration.Es5CompatibilityMode"/>,
    /// to every client, since the setting is server-wide. Off (the default), nothing
    /// changes. Without the ES5 resources (the default dotnet build) the setting has
    /// no effect.
    /// </summary>
    internal static class ClientScriptVariant
    {
        internal const string ResourceRoot = "Jellyfin.Plugin.JellyfinEnhanced.";
        internal const string Es5ResourceRoot = ResourceRoot + "es5.";
        internal const string Es5Suffix = ".br";

        private static readonly Assembly Assembly = typeof(ClientScriptVariant).Assembly;
        private static readonly Lazy<bool> Es5EmbeddedLazy = new(() => Assembly.GetManifestResourceInfo(Es5ResourceRoot + "js.plugin.js" + Es5Suffix) != null);

        /// <summary>Whether this build carries the ES5 scripts at all.</summary>
        internal static bool Es5Embedded => Es5EmbeddedLazy.Value;

        /// <summary>Whether the ES5 scripts are to be served right now.</summary>
        internal static bool UseEs5 => JellyfinEnhanced.Instance?.Configuration?.Es5CompatibilityMode == true && Es5Embedded;

        /// <summary>
        /// The resource to read for <paramref name="resourceName"/> (a full manifest
        /// resource name under <see cref="ResourceRoot"/>): its compressed ES5 build when
        /// <paramref name="es5"/> is set and one exists, else the name unchanged.
        /// Only scripts and plugin pages have an ES5 build; locales, fonts, JSON and
        /// CSS are the same for both.
        /// </summary>
        internal static string Resolve(string resourceName, bool es5)
        {
            if (!es5 || !resourceName.StartsWith(ResourceRoot, StringComparison.Ordinal))
            {
                return resourceName;
            }

            var es5Name = Es5ResourceRoot + resourceName.Substring(ResourceRoot.Length) + Es5Suffix;
            return Assembly.GetManifestResourceInfo(es5Name) != null ? es5Name : resourceName;
        }

        /// <summary>
        /// Opens <paramref name="resourceName"/>, or its ES5 build (see <see cref="Resolve"/>)
        /// decompressed into memory, so callers get a seekable stream of known length
        /// either way. Null when the resource doesn't exist.
        /// </summary>
        internal static Stream? Open(string resourceName, bool es5)
        {
            var resolved = Resolve(resourceName, es5);
            var stream = Assembly.GetManifestResourceStream(resolved);
            if (stream == null || !resolved.EndsWith(Es5Suffix, StringComparison.Ordinal) || resolved == resourceName)
            {
                return stream;
            }

            using (stream)
            using (var brotli = new BrotliStream(stream, CompressionMode.Decompress))
            {
                var decompressed = new MemoryStream();
                brotli.CopyTo(decompressed);
                decompressed.Position = 0;
                return decompressed;
            }
        }
    }
}
