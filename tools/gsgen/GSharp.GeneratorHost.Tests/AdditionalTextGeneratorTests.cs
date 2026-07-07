// <copyright file="AdditionalTextGeneratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Xunit;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// Issue #2223: verifies the host forwards Roslyn <c>AdditionalText</c> and
/// <c>AnalyzerConfigOptions</c> to generators — the plumbing an Avalonia-style
/// XAML generator needs to materialize <c>InitializeComponent</c> from an
/// <c>.axaml</c> file. Uses a fake generator that mimics Avalonia's behavior
/// (read each <c>SourceItemGroup=AvaloniaXaml</c> additional file and emit a
/// partial <c>InitializeComponent</c> into the matching code-behind).
/// </summary>
public class AdditionalTextGeneratorTests
{
    private static IReadOnlyList<MetadataReference> References => CSharpProjectLoader.RuntimeReferences();

    [Fact]
    public void AdditionalText_And_Options_ReachGenerator_AndMaterializePartial()
    {
        string dir = Directory.CreateTempSubdirectory("gsgen-axaml-").FullName;
        try
        {
            string axaml = Path.Combine(dir, "MainWindow.axaml");
            File.WriteAllText(axaml, "<Window/>");
            string txt = Path.Combine(dir, "readme.txt");
            File.WriteAllText(txt, "hello");

            Compilation gs = BuildGs(@"
package App

partial class MainWindow {
    func New() -> InitializeComponent()
}
");

            var additionalTexts = new List<AdditionalText>
            {
                new HostAdditionalText(
                    axaml,
                    new Dictionary<string, string> { ["SourceItemGroup"] = "AvaloniaXaml" }),

                // A non-Avalonia additional file must be ignored by the generator.
                new HostAdditionalText(txt),
            };

            var options = new HostAnalyzerConfigOptionsProvider(
                new Dictionary<string, string> { ["build_property.RootNamespace"] = "App" });

            GeneratorHostResult result = GeneratorHostRunner.Run(
                gs,
                References,
                new IIncrementalGenerator[] { new FakeAvaloniaNameGenerator() },
                additionalTexts,
                options);

            Assert.Empty(result.Failures);

            (string HintName, string GSharpSource) file = Assert.Single(result.GeneratedGsFiles);
            Assert.Contains("partial class MainWindow", file.GSharpSource);
            Assert.Contains("InitializeComponent", file.GSharpSource);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static Compilation BuildGs(string gsSource)
    {
        return new Compilation(GsSyntaxTree.Parse(SourceText.From(gsSource)));
    }

    /// <summary>
    /// A minimal stand-in for Avalonia's XAML name generator: for each
    /// additional file whose <c>SourceItemGroup</c> option is <c>AvaloniaXaml</c>,
    /// emits a partial <c>InitializeComponent()</c> into a code-behind class named
    /// after the file (<c>MainWindow.axaml</c> → <c>MainWindow</c>).
    /// </summary>
    private sealed class FakeAvaloniaNameGenerator : IIncrementalGenerator
    {
        public void Initialize(IncrementalGeneratorInitializationContext context)
        {
            var xamlFiles = context.AdditionalTextsProvider
                .Combine(context.AnalyzerConfigOptionsProvider)
                .Where(static pair =>
                {
                    return pair.Right.GetOptions(pair.Left)
                        .TryGetValue("build_metadata.AdditionalFiles.SourceItemGroup", out var group)
                        && group == "AvaloniaXaml";
                })
                .Select(static (pair, _) => Path.GetFileNameWithoutExtension(pair.Left.Path));

            context.RegisterSourceOutput(xamlFiles, static (spc, className) =>
            {
                var sb = new StringBuilder();
                sb.AppendLine("#nullable enable");
                sb.Append("partial class ").AppendLine(className);
                sb.AppendLine("{");
                sb.AppendLine("    public void InitializeComponent() { }");
                sb.AppendLine("}");
                spc.AddSource(className + ".axaml.g.cs", sb.ToString());
            });
        }
    }
}
