// <copyright file="CorpusDiscoveryTargetKindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import Xunit

/// Regression tests for issue #1749 mode 3: `CorpusDiscovery.ReadTargetKind`
/// used to match the literal substring `<OutputType>Exe</OutputType>`,
/// so any benign reformat (extra whitespace, an attribute, `WinExe`)
/// silently reclassified the app as (cref:TargetKind.Library), which
/// flips `gsc` to `/target:library` and — because stdout-parity
/// requires (cref:TargetKind.Exe) — drops stdout-parity verification
/// entirely. The fix parses the csproj as XML instead.
open class CorpusDiscoveryTargetKindTests {
    @Theory
    @InlineData("<OutputType>Exe</OutputType>", TargetKind(0))
    @InlineData("<OutputType> Exe </OutputType>", TargetKind(0))
    @InlineData("<OutputType>WinExe</OutputType>", TargetKind(0))
    @InlineData("<OutputType>exe</OutputType>", TargetKind(0))
    @InlineData("<OutputType>Library</OutputType>", TargetKind(1))
    @InlineData("", TargetKind(1))
    @InlineData("<OutputType Condition=\"'$$(Configuration)'=='Debug'\">Exe</OutputType>", TargetKind(0))
    func Discover_ClassifiesTargetKind_FromParsedOutputType(outputTypeElement string, expected TargetKind) {
        let appDir = NewScratchApp("MyApp", outputTypeElement)
        let app = Assert.Single(CorpusDiscovery.Discover(Path.GetDirectoryName(appDir)))
        Assert.Equal(expected, app.TargetKind)
    }

    /// The old literal substring match's exact failure cases (formatting or a
    /// `WinExe` variant) must now classify as (cref:TargetKind.Exe),
    /// not silently fall back to (cref:TargetKind.Library).
    @Theory
    @InlineData("<OutputType> Exe </OutputType>")
    @InlineData("<OutputType>WinExe</OutputType>")
    func Discover_FormattingOrWinExe_NeverMisclassifiesAsLibrary(outputTypeElement string) {
        let appDir = NewScratchApp("ReformattedApp", outputTypeElement)
        let app = Assert.Single(CorpusDiscovery.Discover(Path.GetDirectoryName(appDir)))
        Assert.Equal(TargetKind.Exe, app.TargetKind)
    }

    /// Multiple `PropertyGroup`s (SDK-style, with an earlier stale value)
    /// resolve to the last `OutputType` in document order.
    @Fact
    func Discover_MultiplePropertyGroups_LastOutputTypeWins() {
        let root = NewScratchDir("multi-propertygroup")
        let appFolder = Path.Combine(root, "MultiApp")
        Directory.CreateDirectory(appFolder)
        File.WriteAllText(Path.Combine(appFolder, "MultiApp.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
</Project>
`))
        File.WriteAllText(Path.Combine(appFolder, "Program.cs"), "class Program { static void Main() { } }")
        let app = Assert.Single(CorpusDiscovery.Discover(root))
        Assert.Equal(TargetKind.Exe, app.TargetKind)
    }

    @Theory
    @InlineData("Microsoft.NET.Sdk.Worker")
    @InlineData("Microsoft.NET.Sdk.Web")
    func Discover_ExecutableSdkWithoutOutputType_ClassifiesAsExe(sdk string) {
        let root = NewScratchDir("executable-sdk")
        let appFolder = Path.Combine(root, "SdkApp")
        Directory.CreateDirectory(appFolder)
        File.WriteAllText(
            Path.Combine(appFolder, "SdkApp.csproj"),
            "<Project Sdk=\"$sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
        )
        File.WriteAllText(Path.Combine(appFolder, "Program.cs"), "System.Console.WriteLine(1);")
        let app = Assert.Single(CorpusDiscovery.Discover(root))
        Assert.Equal(TargetKind.Exe, app.TargetKind)
    }

    shared {
        private func NewScratchApp(appName string, outputTypeElement string) string {
            let root = NewScratchDir(appName)
            let appFolder = Path.Combine(root, appName)
            Directory.CreateDirectory(appFolder)
            File.WriteAllText(Path.Combine(appFolder, appName + ".csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    ` + "$outputTypeElement" + `
  </PropertyGroup>
</Project>
`))
            File.WriteAllText(Path.Combine(appFolder, "Program.cs"), "class Program { static void Main() { } }")
            return appFolder
        }

        private func NewScratchDir(label string) string {
            // Not AppContext.BaseDirectory: it sits under out/bin/<Config>/..., and
            // CorpusDiscovery.Discover deliberately excludes anything under a
            // "/bin/" or "/obj/" path segment (build output noise), which would
            // make Discover find zero apps here.
            let root = Path.Combine(
                Path.GetTempPath(),
                "cs2gs-corpus-discovery-tests",
                label,
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(root)
            return root
        }
    }
}
