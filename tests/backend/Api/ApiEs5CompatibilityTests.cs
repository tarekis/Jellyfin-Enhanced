using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// The admin setting Es5CompatibilityMode switches every script response to the ES5
/// build (scripts/es5/build.mjs) embedded under the "es5." prefix; off (the default)
/// the responses are the original resources, byte for byte.
/// </summary>
[Collection("Plugin singleton")]
public class ApiEs5CompatibilityTests
{
    private const string Root = "Jellyfin.Plugin.JellyfinEnhanced.";
    private const string LayerMarker = "/* Jellyfin Enhanced ES5 compatibility layer";

    private static string Resource(string name)
    {
        using var stream = typeof(JellyfinEnhancedController).Assembly.GetManifestResourceStream(name);
        Assert.NotNull(stream);
        using var reader = new StreamReader(stream!);
        return reader.ReadToEnd();
    }

    private static string Body(ActionResult result)
    {
        if (result is FileContentResult bytes) return Encoding.UTF8.GetString(bytes.FileContents);
        using var stream = Assert.IsType<FileStreamResult>(result).FileStream;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    [Fact]
    public void SettingIsOffByDefault()
    {
        Assert.False(new PluginConfiguration().Es5CompatibilityMode);
        using var fixture = new ApiPluginFixture();
        Assert.False(ClientScriptVariant.UseEs5);
    }

    [Fact]
    public void OffServesTheOriginalScriptsPagesAndCacheKey()
    {
        using var fixture = new ApiPluginFixture();
        var controller = ApiAssetTests.Controller(fixture.Core);

        Assert.Equal(Resource(Root + "js.plugin.js"), Body(controller.GetMainScript()));
        Assert.Equal(Resource(Root + "js.core.navigation.js"), Body(ApiAssetTests.Controller(fixture.Core).GetScript("core/navigation.js")));
        Assert.Equal(Resource(Root + "PluginPages.CalendarPage.html"), Body(ApiAssetTests.Controller(fixture.Core).GetView("calendarPage")));
        var bundle = Body(ApiAssetTests.Controller(fixture.Core).GetScriptBundle());
        Assert.Contains(Resource(Root + "js.core.navigation.js"), bundle);
        Assert.DoesNotContain("-es5", fixture.Plugin.ScriptCacheKey);
        Assert.DoesNotContain("-es5", fixture.Plugin.BuildScriptTag());
    }

    [Fact]
    public void OnServesTheEs5BuildEverywhereAndChangesTheCacheKey()
    {
        if (!ClientScriptVariant.Es5Embedded) return; // built with -p:JeEs5Build=false
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.Es5CompatibilityMode = true;
        Assert.True(ClientScriptVariant.UseEs5);

        var mainScript = Body(ApiAssetTests.Controller(fixture.Core).GetMainScript());
        Assert.StartsWith(LayerMarker, mainScript);
        Assert.Equal(Resource(Root + "es5.js.plugin.js"), mainScript);
        Assert.Equal(Resource(Root + "es5.js.core.navigation.js"), Body(ApiAssetTests.Controller(fixture.Core).GetScript("core/navigation.js")));
        Assert.Equal(Resource(Root + "es5.PluginPages.CalendarPage.html"), Body(ApiAssetTests.Controller(fixture.Core).GetView("calendarPage")));

        // Every bundled module is its ES5 build.
        var bundle = Body(ApiAssetTests.Controller(fixture.Core).GetScriptBundle());
        foreach (var path in ClientScriptBundle.GetComponentScripts())
        {
            Assert.Contains(Resource(Root + "es5.js." + path.Replace('/', '.')), bundle);
        }

        // Resources without an ES5 build are served as they are.
        Assert.Equal(Resource(Root + "js.component-scripts.json"), Body(ApiAssetTests.Controller(fixture.Core).GetScript("component-scripts.json")));

        Assert.EndsWith("-es5", fixture.Plugin.ScriptCacheKey);
        Assert.Contains($"version=\"{fixture.Plugin.ScriptCacheKey}\"", fixture.Plugin.BuildScriptTag());
        Assert.Contains($"bundle.js.map?v={fixture.Plugin.ScriptCacheKey}", bundle);
    }

    [Fact]
    public void SwitchingBackDoesNotReuseTheOtherBuildsBundle()
    {
        if (!ClientScriptVariant.Es5Embedded) return;
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.Es5CompatibilityMode = true;
        var es5Bundle = Body(ApiAssetTests.Controller(fixture.Core).GetScriptBundle());
        fixture.Plugin.Configuration.Es5CompatibilityMode = false;
        var bundle = Body(ApiAssetTests.Controller(fixture.Core).GetScriptBundle());
        Assert.NotEqual(es5Bundle, bundle);
        Assert.Contains(Resource(Root + "js.core.navigation.js"), bundle);
        Assert.Equal(Resource(Root + "js.plugin.js"), Body(ApiAssetTests.Controller(fixture.Core).GetMainScript()));
    }

    [Fact]
    public void ResolveOnlyRedirectsResourcesThatHaveAnEs5Build()
    {
        Assert.Equal(Root + "js.plugin.js", ClientScriptVariant.Resolve(Root + "js.plugin.js", es5: false));
        Assert.Equal(Root + "Configuration.configPage.html", ClientScriptVariant.Resolve(Root + "Configuration.configPage.html", es5: true));
        Assert.Equal(Root + "js.locales.en.json", ClientScriptVariant.Resolve(Root + "js.locales.en.json", es5: true));
        Assert.Equal("Other.Assembly.js.plugin.js", ClientScriptVariant.Resolve("Other.Assembly.js.plugin.js", es5: true));
        if (ClientScriptVariant.Es5Embedded)
        {
            Assert.Equal(Root + "es5.js.plugin.js", ClientScriptVariant.Resolve(Root + "js.plugin.js", es5: true));
        }
    }
}
