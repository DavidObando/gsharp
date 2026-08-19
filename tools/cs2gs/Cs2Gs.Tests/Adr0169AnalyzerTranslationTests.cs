// <copyright file="Adr0169AnalyzerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 / docs/cs2gs-analyzer-translation.md: analyzer translation mode
/// rewrites Roslyn analyzer code to the G# analyzer API — attribute swap,
/// base-type and context types, SyntaxKind values, node-member renames,
/// GetLocation → Location, name-token idioms — and lowers comparisons against
/// members with no G# counterpart to constants with CS2GS-ANALYZER-SHAPE
/// review warnings. Unmapped Roslyn APIs fail loudly, never silently.
/// </summary>
public class Adr0169AnalyzerTranslationTests
{
    private const string MiniAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class MiniAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST0001"",
        ""Title"",
        ""Message"",
        ""Testing"",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(Analyze, SyntaxKind.ElementAccessExpression);
    }

    private static void Analyze(SyntaxNodeAnalysisContext context)
    {
        var access = (ElementAccessExpressionSyntax)context.Node;
        if (access.Expression is MemberAccessExpressionSyntax memberAccess
            && memberAccess.Name.Identifier.ValueText == ""Cache"")
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, access.GetLocation()));
        }
    }
}
";

    [Fact]
    public void MiniAnalyzer_TranslatesToGsAnalyzerApi()
    {
        var (printed, diagnostics) = TranslateAnalyzer(MiniAnalyzerSource);

        Assert.Contains("import GSharp.Core.CodeAnalysis.Analyzers", printed, StringComparison.Ordinal);
        Assert.Contains("GSharpDiagnosticAnalyzer", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("LanguageNames", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Microsoft.CodeAnalysis", printed, StringComparison.Ordinal);
        Assert.Contains("SyntaxKind.IndexExpression", printed, StringComparison.Ordinal);
        Assert.Contains("IndexExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.Contains("AccessorExpressionSyntax", printed, StringComparison.Ordinal);
        Assert.Contains(".Target", printed, StringComparison.Ordinal);
        Assert.Contains("GetLastToken().Text", printed, StringComparison.Ordinal);
        Assert.Contains(".Location", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetLocation", printed, StringComparison.Ordinal);

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void AssignmentLeftComparison_LowersToFalse_WithShapeWarning()
    {
        var (printed, diagnostics) = TranslateAnalyzer(@"
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class LeftCheckAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
    }

    private static bool IsAssignmentLeftSide(ExpressionSyntax expression)
    {
        var current = (SyntaxNode)expression;
        while (current.Parent is ParenthesizedExpressionSyntax)
        {
            current = current.Parent;
        }

        return current.Parent is AssignmentExpressionSyntax assignment && assignment.Left == current;
    }
}
");

        Assert.Contains("false", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".Left", printed, StringComparison.Ordinal);
        Assert.Contains(diagnostics, d => d.DiagnosticId == "CS2GS-ANALYZER-SHAPE"
            && d.Message.Contains("lowered to 'false'", StringComparison.Ordinal));
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBindsAgainstGsCore(printed);
    }

    [Fact]
    public void UnmappedRoslynApi_ReportsLoudGap()
    {
        var (_, diagnostics) = TranslateAnalyzer(@"
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using System.Collections.Immutable;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class UsesUnmappedApi : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray<DiagnosticDescriptor>.Empty;

    public override void Initialize(AnalysisContext context)
    {
        CSharpParseOptions options = CSharpParseOptions.Default;
        _ = options;
    }
}
");

        Assert.Contains(diagnostics, d => d.Severity == TranslationSeverity.Unsupported
            && d.Message.Contains("no G# analyzer-API mapping", StringComparison.Ordinal));
    }

    [Fact]
    public void NonAnalyzerProject_LeavesRoslynApisUntouched()
    {
        // Without analyzer mode, Microsoft.CodeAnalysis usage passes through
        // as ordinary imported CLR types (the pre-ADR-0169 behavior).
        LoadedCSharpProject project = LoadAnalyzerProject(@"
using Microsoft.CodeAnalysis;

namespace Sample;

public static class NotAnAnalyzer
{
    public static string Describe(SyntaxNode node) => node.ToString();
}
");
        Assert.False(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation));

        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) != "GlobalUsings.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));

        Assert.Contains("import Microsoft.CodeAnalysis", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Detector_RecognizesAnalyzerProjects()
    {
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(LoadAnalyzerProject(MiniAnalyzerSource).Compilation));
    }

    private static (string Printed, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateAnalyzer(string source)
    {
        LoadedCSharpProject project = LoadAnalyzerProject(source);
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation));

        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) != "GlobalUsings.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = translator.TranslateDocument(document, context);
        return (GSharpPrinter.Print(unit), context.Diagnostics.ToList());
    }

    private static LoadedCSharpProject LoadAnalyzerProject(string source)
    {
        MetadataReference[] references = new[]
            {
                typeof(object).Assembly,
                typeof(System.Collections.Immutable.ImmutableArray).Assembly,
                typeof(Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer).Assembly,
                typeof(Microsoft.CodeAnalysis.CSharp.CSharpCompilation).Assembly,
                typeof(Microsoft.CodeAnalysis.Compilation).Assembly,
                typeof(System.Runtime.CompilerServices.RuntimeHelpers).Assembly,
            }
            .Select(assembly => assembly.Location)
            .Distinct()
            .Select(location => (MetadataReference)MetadataReference.CreateFromFile(location))
            .Concat(new[]
            {
                (MetadataReference)MetadataReference.CreateFromFile(
                    Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location), "System.Runtime.dll")),
            })
            .ToArray();

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Analyzer.cs", source) },
            references);
        Assert.True(
            project.BoundWithoutErrors,
            "Analyzer snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static void AssertBindsAgainstGsCore(string printed)
    {
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, "analyzer.gs"));
        Assert.True(
            tree.Diagnostics.IsEmpty,
            "Translated analyzer should parse cleanly:\n" + string.Join("\n", tree.Diagnostics.Select(d => d.Message)) + "\n---\n" + printed);

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree)
        {
            IsLibrary = true,
        };
        var errors = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        Assert.True(
            errors.Count == 0,
            "Translated analyzer should bind against GSharp.Core:\n" + string.Join("\n", errors.Select(d => d.Message)) + "\n---\n" + printed);
    }
}
