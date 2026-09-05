// <copyright file="Issue3920Gsa0002ImportedOperandDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using GSharp.CodeAnalysis.Analyzers.Testing;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 M5, issue #3920: a Roslyn <c>OperationKind</c> corresponds to
/// SEVERAL G# bound-node kinds, and the one GSA0002 exists to police is never
/// the one the naive one-to-one map named.
///
/// <para>
/// G# binds <c>a == b</c> over operands of an IMPORTED CLR type to
/// <c>BoundClrBinaryOperatorExpression</c> (the resolved <c>op_Equality</c>),
/// not to <c>BoundBinaryExpression</c>; and a call to an imported method such
/// as <c>object.ReferenceEquals</c> to <c>BoundImportedCallExpression</c>, not
/// to <c>BoundCallExpression</c>. Translating
/// <c>RegisterOperationAction(h, OperationKind.BinaryOperator)</c> to a single
/// <c>RegisterBoundNodeAction(h, BoundNodeKind.BinaryExpression)</c> therefore
/// dispatched the migrated GSA0002 zero times over reflection-<c>Type</c>
/// comparisons — which are imported by construction — and the rule reported
/// nothing at all.
/// </para>
///
/// <para>
/// Every assertion here EXECUTES: the real analyzer is translated, compiled by
/// the real G# compiler, loaded, and run through the real
/// <see cref="GSharpAnalyzerVerifier"/> over the translated snippet. The
/// positive and the two negatives share one path, so a rule that stops
/// reporting fails the positive rather than passing the negatives quietly.
/// </para>
/// </summary>
public sealed class Issue3920Gsa0002ImportedOperandDispatchTests : IDisposable
{
    // The real positive snippet from
    // ReflectionTypeComparisonAnalyzerTests.ReportsTypeofReferenceComparisonsInCompilerMetadataNamespaces.
    // All three sites compare an imported System.Type, so all three bind to
    // the imported-operand node shapes.
    private const string Gsa0002Positive = """
using System;

namespace GSharp.Core.CodeAnalysis.Binding
{
    class C
    {
        bool EqualsTypeof(Type type) => [|type == typeof(string)|];
        bool NotEqualsTypeof(Type type) => [|typeof(int) != type|];
        bool ReferenceEqualsTypeof(Type type) => [|ReferenceEquals(type, typeof(string))|];
    }
}
""";

    // The real negative snippet from the same class: symbol comparisons, Type
    // compared to Type (no typeof), null checks, and the two exempt utility
    // types. Every one of these now REACHES the handler — before #3920 it was
    // silent because nothing was dispatched at all.
    private const string Gsa0002NegativeExemptions = """
using System;

namespace GSharp.Core.CodeAnalysis.Symbols
{
    class Symbol { }
    class C
    {
        bool Same(Symbol a, Symbol b) => ReferenceEquals(a, b) || a == b;
        bool SameTypes(Type a, Type b) => ReferenceEquals(a, b) || a == b || a != b;
        bool NullCheck(Type a) => a == null || null != a;
    }

    class ClrTypeUtilities
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(int);
    }

    class TypeIdentityComparer
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(int);
    }
}
""";

    // The real negative snippet whose only exemption is the namespace.
    private const string Gsa0002NegativeNamespace = """
using System;

namespace GSharp.Core.CodeAnalysis.Syntax
{
    class C
    {
        bool Same(Type a) => ReferenceEquals(a, typeof(string)) || a == typeof(string);
    }
}
""";

    private readonly DirectoryInfo workDirectory =
        Directory.CreateTempSubdirectory("cs2gs-gsa0002-dispatch");

    /// <summary>Gets the GSA0002 positive and negative cases.</summary>
    /// <returns>The theory data.</returns>
    public static IEnumerable<object[]> Gsa0002Cases()
    {
        yield return new object[]
        {
            Gsa0002Positive,
            new[] { "GSA0002", "GSA0002", "GSA0002" },
        };
        yield return new object[] { Gsa0002NegativeExemptions, Array.Empty<string>() };
        yield return new object[] { Gsa0002NegativeNamespace, Array.Empty<string>() };
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        try
        {
            workDirectory.Delete(recursive: true);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>
    /// GSA0002, end to end, positive AND negatives on one path: the translated
    /// rule reports at exactly the three re-placed markers of the positive
    /// snippet — the case that reported NOTHING before the one-to-many kind
    /// expansion — and stays silent over both negatives.
    /// </summary>
    /// <param name="markedSnippet">The C# snippet with its markers.</param>
    /// <param name="ids">The expected diagnostic ids.</param>
    [Theory]
    [MemberData(nameof(Gsa0002Cases))]
    public void TranslatedGsa0002_AgreesWithTheCSharpExpectation(string markedSnippet, string[] ids)
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(markedSnippet);
        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);

        string analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedAnalyzer(
            workDirectory.FullName, "ReflectionTypeComparisonAnalyzer.cs", "TranslatedGsa0002");
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers =
            GSharpAnalyzerHost.Load(new[] { analyzerDll }, out ImmutableArray<Diagnostic> hostDiagnostics);
        Assert.Empty(hostDiagnostics);
        GSharpDiagnosticAnalyzer analyzer = Assert.Single(analyzers);

        GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, result.GsWithMarkers, ids);
    }

    // A migrated analyzer that reads IInvocationOperation.TargetMethod.ReturnType.
    // The map lowers that to `CalledFunction.Type`, so the call-site symbol
    // surface must carry `Type` — a bare `Symbol` does not, and this source
    // failed to bind with `GS0158: Cannot find member Type`.
    private const string ReturnTypeAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ReturnTypeAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST3920A"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterOperationAction(AnalyzeCall, OperationKind.Invocation);

    private static void AnalyzeCall(OperationAnalysisContext context)
    {
        var operation = (IInvocationOperation)context.Operation;
        if (operation.TargetMethod.ReturnType.Name == ""Int32"" && operation.TargetMethod.OverriddenMethod is null)
        {
            context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
        }
    }
}
";

    // The same registration, with the kinds named INDIRECTLY. cs2gs cannot fan
    // these out, and the one-to-one fallback would emit a registration that
    // binds, runs, and is dispatched zero times over imported code — the exact
    // silence #3920 exists to remove.
    private const string IndirectKindsAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class IndirectKindsAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST3920B"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    private static readonly OperationKind[] Kinds = new[] { OperationKind.BinaryOperator };

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterOperationAction(AnalyzeBinary, Kinds);

    private static void AnalyzeBinary(OperationAnalysisContext context)
    {
        var operation = (IBinaryOperation)context.Operation;
        context.ReportDiagnostic(Diagnostic.Create(Rule, operation.Syntax.GetLocation()));
    }
}
";

    // A registration for a kind with no fan-out row, spelled DIRECTLY. The
    // enum rename is the whole answer here, so the indirection guard must not
    // fire: trading a silent wrong answer for a loud wrong one is not a fix.
    private const string DirectUnmappedKindAnalyzerSource = @"
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Sample;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ConversionAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        ""TEST3920C"", ""T"", ""M"", ""Testing"", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
        => context.RegisterOperationAction(AnalyzeConversion, OperationKind.Conversion);

    private static void AnalyzeConversion(OperationAnalysisContext context)
        => context.ReportDiagnostic(Diagnostic.Create(Rule, context.Operation.Syntax.GetLocation()));
}
";

    /// <summary>
    /// Widening the NODE side must not narrow the SYMBOL side (PR #3963
    /// review): <c>TargetMethod.ReturnType</c> and <c>TargetMethod.OverriddenMethod</c>
    /// are mapped members, so the call-site symbol surface has to carry them.
    /// Typed as bare <c>Symbol</c> this bound with
    /// <c>GS0158: Cannot find member Type</c>; the assertion is that the
    /// translated analyzer BINDS, which is falsifiable by construction.
    /// </summary>
    [Fact]
    public void MappedTargetMethodMembers_StillBindOnTheSharedCalleeSurface()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(ReturnTypeAnalyzerSource);

        Assert.Contains("operation.CalledFunction.Type", printed, StringComparison.Ordinal);
        Assert.Contains("operation.CalledFunction.OverriddenMethod", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertBinds(printed);
    }

    /// <summary>
    /// A registration whose kinds are named indirectly cannot be fanned out,
    /// and a quiet one-to-one fallback would reintroduce #3920 in a shape that
    /// compiles, runs, and reports nothing. It is a loud gap instead: a wrong
    /// answer that announces itself beats a wrong answer that does not.
    /// </summary>
    [Fact]
    public void IndirectlyNamedOperationKinds_AreALoudGapRatherThanASilentOneToOne()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(IndirectKindsAnalyzerSource);

        TranslationDiagnostic gap = Assert.Single(
            diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Equal("CS2GS-GAP", gap.DiagnosticId);
        Assert.Contains("RegisterOperationAction", gap.Message, StringComparison.Ordinal);

        // The falsifier for the guard itself: the emitted registration really
        // is the incomplete one, so silence here would have been a real bug
        // rather than a theoretical one.
        Assert.Contains("RegisterBoundNodeAction(AnalyzeBinary, Kinds)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ClrBinaryOperatorExpression", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The falsifier for the guard's REACH: a kind spelled directly but
    /// carrying no fan-out row still translates through the plain enum rename.
    /// A guard that fired here would turn every unrelated operation-kind
    /// registration into a spurious gap.
    /// </summary>
    [Fact]
    public void DirectlyNamedKindWithoutAFanOutRow_IsNotAGap()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) =
            TranslateAnalyzerSource(DirectUnmappedKindAnalyzerSource);

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("BoundNodeKind.ConversionExpression", printed, StringComparison.Ordinal);
    }

    /// <summary>Translates one analyzer source in ADR-0169 analyzer mode.</summary>
    /// <param name="source">The C# analyzer source.</param>
    /// <returns>The printed G# and the translation diagnostics.</returns>
    private static (string Printed, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateAnalyzerSource(
        string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Analyzer.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        LoadedDocument document = project.Documents
            .Single(d => Path.GetFileName(d.FilePath) == "Analyzer.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
        return (printed, context.Diagnostics.ToList());
    }

    /// <summary>Binds printed G# against the real GSharp.Core.</summary>
    /// <param name="printed">The printed G# source.</param>
    private static void AssertBinds(string printed)
    {
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, "analyzer.gs"));
        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree) { IsLibrary = true };
        var errors = tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .Select(d => d.Id + ": " + d.Message)
            .ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors));
    }
}
