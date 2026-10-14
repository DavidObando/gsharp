// <copyright file="AdditionalTextGeneratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Xunit
import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.GeneratorHost
import Microsoft.CodeAnalysis.Diagnostics
import System.Threading

/// Issue #2223: verifies the host forwards Roslyn `AdditionalText` and
/// `AnalyzerConfigOptions` to generators — the plumbing an Avalonia-style
/// XAML generator needs to materialize `InitializeComponent` from an
/// `.axaml` file. Uses a fake generator that mimics Avalonia's behavior
/// (read each `SourceItemGroup=AvaloniaXaml` additional file and emit a
/// partial `InitializeComponent` into the matching code-behind).
open class AdditionalTextGeneratorTests {
    @Fact
    func AdditionalText_And_Options_ReachGenerator_AndMaterializePartial() {
        let dir = Directory.CreateTempSubdirectory("gsgen-axaml-").FullName
        try {
            let axaml = Path.Combine(dir, "MainWindow.axaml")
            File.WriteAllText(axaml, "<Window/>")
            let txt = Path.Combine(dir, "readme.txt")
            File.WriteAllText(txt, "hello")
            let gs = BuildGs(`
package App

partial class MainWindow {
    func New() -> InitializeComponent()
}
`)
            let additionalTexts = List[AdditionalText]{
                HostAdditionalText(axaml, Dictionary[string, string]{["SourceItemGroup"] = "AvaloniaXaml"}),
                HostAdditionalText(txt)
            }
            let options = HostAnalyzerConfigOptionsProvider(
                Dictionary[string, string]{["build_property.RootNamespace"] = "App"}
            )
            let result = GeneratorHostRunner.Run(
                gs,
                References,
                []IIncrementalGenerator{FakeAvaloniaNameGenerator()},
                additionalTexts,
                options
            )
            Assert.Empty(result.Failures)
            let file = Assert.Single(result.GeneratedGsFiles)
            Assert.Contains("partial class MainWindow", file.GSharpSource)
            Assert.Contains("InitializeComponent", file.GSharpSource)
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    /// A minimal stand-in for Avalonia's XAML name generator: for each
    /// additional file whose `SourceItemGroup` option is `AvaloniaXaml`,
    /// emits a partial `InitializeComponent()` into a code-behind class named
    /// after the file (`MainWindow.axaml` → `MainWindow`).
    private class FakeAvaloniaNameGenerator : IIncrementalGenerator {
        func Initialize(context IncrementalGeneratorInitializationContext) {
            let xamlFiles = context
                .AdditionalTextsProvider
                .Combine(context.AnalyzerConfigOptionsProvider)
                .Where(
                (pair(Left AdditionalText, Right AnalyzerConfigOptionsProvider)) -> {
                    return pair
                        .Right
                        .GetOptions(pair.Left)
                        .TryGetValue("build_metadata.AdditionalFiles.SourceItemGroup", out var group) &&
                        group == "AvaloniaXaml"
                }
            )
                .Select(
                (
                    pair(Left AdditionalText, Right AnalyzerConfigOptionsProvider),
                    _ CancellationToken
                ) -> Path.GetFileNameWithoutExtension(pair.Left.Path)
            )
            context.RegisterSourceOutput(
                xamlFiles,
                (spc SourceProductionContext, className string) -> {
                    let sb = StringBuilder()
                    sb.AppendLine("#nullable enable")
                    sb.Append("partial class ").AppendLine(className)
                    sb.AppendLine("{")
                    sb.AppendLine("    public void InitializeComponent() { }")
                    sb.AppendLine("}")
                    spc.AddSource(className + ".axaml.g.cs", sb.ToString())
                }
            )
        }
    }

    shared {
        private prop References IReadOnlyList[MetadataReference] -> CSharpProjectLoader.RuntimeReferences()

        private func BuildGs(gsSource string) Compilation {
            return Compilation(GsSyntaxTree.Parse(SourceText.From(gsSource)))
        }
    }
}
