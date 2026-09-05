// <copyright file="Adr0169TranslatedAnalyzerHarness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Emit;
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
    /// Issue #3880: builds the parity tests' ROSLYN control by compiling one
    /// real analyzer's own C# source with Roslyn and instantiating it out of
    /// the emitted assembly, instead of naming the type from a project
    /// reference on <c>src/Analyzers/InternalAnalyzers</c>.
    /// <para>
    /// The project reference does not survive self-migration: cs2gs retargets
    /// <c>InternalAnalyzers</c> onto the G# analyzer API (ADR-0169), so the
    /// migrated <c>StructFieldDefsReadAnalyzer</c> is a
    /// <c>GSharpDiagnosticAnalyzer</c> and
    /// <c>ImmutableArray.Create[DiagnosticAnalyzer](StructFieldDefsReadAnalyzer())</c>
    /// has no applicable overload — the whole Roslyn half of the parity check
    /// stops binding. Compiling the analyzer's source is also the more honest
    /// control: it is exactly what the G# half already does (translate and
    /// compile the same file), so both sides now start from the same bytes on
    /// disk rather than one side starting from a build output.
    /// </para>
    /// </summary>
    /// <param name="analyzerFileName">The analyzer source file name under <c>src/Analyzers/InternalAnalyzers</c>.</param>
    /// <param name="analyzerTypeName">The analyzer type's simple name.</param>
    /// <returns>A live Roslyn analyzer instance.</returns>
    public static DiagnosticAnalyzer CompileRoslynAnalyzer(string analyzerFileName, string analyzerTypeName)
    {
        string analyzerDirectory = Path.Combine(
            FindRepoRoot(), "src", "Analyzers", "InternalAnalyzers");

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            (analyzerFileName, File.ReadAllText(Path.Combine(analyzerDirectory, analyzerFileName))),
            ("DiagnosticDescriptors.cs", File.ReadAllText(Path.Combine(analyzerDirectory, "DiagnosticDescriptors.cs"))),
        });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        using var peStream = new MemoryStream();
        EmitResult emitResult = project.Compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            $"Roslyn control analyzer {analyzerTypeName} should compile:\n"
                + string.Join("\n", emitResult.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        Assembly assembly = Assembly.Load(peStream.ToArray());
        Type analyzerType = assembly.GetType("GSharp.InternalAnalyzers." + analyzerTypeName, throwOnError: true);
        return (DiagnosticAnalyzer)Activator.CreateInstance(analyzerType);
    }

    /// <summary>
    /// Translates and compiles the real GSA0001 into an analyzer assembly.
    /// </summary>
    /// <param name="workDirectory">The directory receiving the emitted dll.</param>
    /// <returns>The analyzer assembly path.</returns>
    public static string CompileTranslatedGsa0001(string workDirectory)
        => CompileTranslatedAnalyzer(
            workDirectory,
            "StructFieldDefsReadAnalyzer.cs",
            "TranslatedGsa0001",
            Gsa0001Descriptors);

    /// <summary>
    /// Translates and compiles one REAL analyzer from
    /// <c>src/Analyzers/InternalAnalyzers</c> into an analyzer assembly, using
    /// the repository's own <c>DiagnosticDescriptors.cs</c> unless a stand-in
    /// is supplied. Generalized for issue #3794 so GSA0003 and GSA0004 — the
    /// two namespace-scoped rules whose migrated tests the snippet
    /// package-split fixes — can be executed here, not merely translated.
    /// </summary>
    /// <param name="workDirectory">The directory receiving the emitted dll.</param>
    /// <param name="analyzerFileName">The analyzer source file name.</param>
    /// <param name="assemblyName">The emitted assembly name.</param>
    /// <param name="descriptorSource">A descriptor stand-in, or null for the real table.</param>
    /// <returns>The analyzer assembly path.</returns>
    public static string CompileTranslatedAnalyzer(
        string workDirectory,
        string analyzerFileName,
        string assemblyName,
        string descriptorSource = null)
    {
        string analyzerDirectory = Path.Combine(
            FindRepoRoot(), "src", "Analyzers", "InternalAnalyzers");
        string analyzerSource = File.ReadAllText(Path.Combine(analyzerDirectory, analyzerFileName));
        string descriptors = descriptorSource
            ?? File.ReadAllText(Path.Combine(analyzerDirectory, "DiagnosticDescriptors.cs"));

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            (analyzerFileName, analyzerSource),
            ("DiagnosticDescriptors.cs", descriptors),
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
            AssemblyName = assemblyName,
        };

        string dllPath = Path.Combine(workDirectory, assemblyName + ".dll");
        using (var peStream = File.Create(dllPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: assemblyName);
            Assert.True(
                result.Success,
                $"Translated {assemblyName} should compile:\n" + string.Join("\n", result.Diagnostics.Where(d => d.IsError).Select(d => d.Message)));
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
