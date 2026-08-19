// <copyright file="Adr0169TranslatedAnalyzerHarness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Shared plumbing for the ADR-0169 parity and snippet-migration tests:
/// translates the REAL GSA0001 source in analyzer mode and compiles it with
/// the real G# compiler into a loadable analyzer assembly.
/// </summary>
internal static class Adr0169TranslatedAnalyzerHarness
{
    /// <summary>A minimal stand-in for the analyzer project's descriptor table.</summary>
    public const string Gsa0001Descriptors = @"
using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

public static class DiagnosticDescriptors
{
    public static readonly DiagnosticDescriptor StructFieldDefsRead = new(
        ""GSA0001"", ""T"", ""M"", ""GSharp.InternalAnalyzers"", DiagnosticSeverity.Warning, isEnabledByDefault: true);
}
";

    /// <summary>
    /// Translates and compiles the real GSA0001 into an analyzer assembly.
    /// </summary>
    /// <param name="workDirectory">The directory receiving the emitted dll.</param>
    /// <returns>The analyzer assembly path.</returns>
    public static string CompileTranslatedGsa0001(string workDirectory)
    {
        string analyzerSource = File.ReadAllText(Path.Combine(
            FindRepoRoot(), "src", "Analyzers", "InternalAnalyzers", "StructFieldDefsReadAnalyzer.cs"));

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("StructFieldDefsReadAnalyzer.cs", analyzerSource),
            ("DiagnosticDescriptors.cs", Gsa0001Descriptors),
        });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation));

        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        var trees = new List<GSharp.Core.CodeAnalysis.Syntax.SyntaxTree>();
        foreach (LoadedDocument document in project.Documents.Where(d => Path.GetFileName(d.FilePath) != "GlobalUsings.cs"))
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
            trees.Add(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, Path.GetFileName(document.FilePath) + ".gs")));
        }

        Assert.All(trees, tree => Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message))));

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees.ToArray())
        {
            IsLibrary = true,
            AssemblyName = "TranslatedGsa0001",
        };

        string dllPath = Path.Combine(workDirectory, "TranslatedGsa0001.dll");
        using (var peStream = File.Create(dllPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "TranslatedGsa0001");
            Assert.True(
                result.Success,
                "Translated GSA0001 should compile:\n" + string.Join("\n", result.Diagnostics.Where(d => d.IsError).Select(d => d.Message)));
        }

        return dllPath;
    }

    /// <summary>
    /// Walks up from the test base directory to the repository root.
    /// </summary>
    /// <returns>The repo root path.</returns>
    public static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "nuget.config")) &&
                File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
