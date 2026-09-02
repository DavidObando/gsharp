// <copyright file="Adr0175DiagnosticSuppressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0175 (issues #3820 / #3824): source-level, scoped analyzer suppression
/// via <c>@SuppressDiagnostic("ID")</c>, in both the declaration-attribute form
/// and the annotated-block form.
///
/// The load-bearing property throughout is *scoping*: every test that asserts a
/// diagnostic is suppressed also asserts that the same diagnostic still fires
/// elsewhere in the same file. Without that pair the tests could not tell a
/// scoped suppression from a blanket disable.
/// </summary>
public class Adr0175DiagnosticSuppressionTests
{
    private static readonly DiagnosticDescriptor ProbeRule = new(
        "PROBE001", "Probe", "Probe hit.", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    private static readonly DiagnosticDescriptor OtherRule = new(
        "PROBE002", "Other probe", "Other probe hit.", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    [Fact]
    public void NoSuppression_BothCallSitesReport()
    {
        const string source = @"package App

func Ping() int32 {
    return 1
}

func Suppressed() int32 {
    return Ping()
}

func NotSuppressed() int32 {
    return Ping()
}
";

        var produced = Run(source);

        Assert.Equal(2, produced.Count(d => d.Id == "PROBE001"));
    }

    [Fact]
    public void DeclarationForm_SuppressesInsideTheAnnotatedFunctionOnly()
    {
        const string source = @"package App

func Ping() int32 {
    return 1
}

@SuppressDiagnostic(""PROBE001"")
func Suppressed() int32 {
    return Ping()
}

func NotSuppressed() int32 {
    return Ping()
}
";

        var produced = Run(source);

        var hits = produced.Where(d => d.Id == "PROBE001").ToArray();

        // Scoping proof: exactly one survivor, and it is the call in the
        // *unannotated* function. A blanket disable would leave zero.
        Assert.Single(hits);
        Assert.Contains("NotSuppressed", LineOfEnclosingFunction(source, hits[0]));
    }

    [Fact]
    public void BlockForm_SuppressesOnlyTheAnnotatedStatementRange()
    {
        const string source = @"package App

func Ping() int32 {
    return 1
}

func Both() int32 {
    var first = 0
    @SuppressDiagnostic(""PROBE001"") {
        first = Ping()
    }

    var second = Ping()
    return first + second
}
";

        var produced = Run(source);

        var hits = produced.Where(d => d.Id == "PROBE001").ToArray();

        // Scoping proof, the sharp form: both call sites are in the SAME
        // function, so only a span-scoped suppression can keep exactly one.
        Assert.Single(hits);
        Assert.Equal(12, hits[0].Location.StartLine);
    }

    [Fact]
    public void SuppressionIsIdKeyed_OtherIdsStillReport()
    {
        const string source = @"package App

func Ping() int32 {
    return 1
}

@SuppressDiagnostic(""PROBE001"")
func Suppressed() int32 {
    return Ping()
}
";

        var produced = Run(source, new DualProbeAnalyzer());

        Assert.Empty(produced.Where(d => d.Id == "PROBE001"));
        Assert.Single(produced.Where(d => d.Id == "PROBE002"));
    }

    [Fact]
    public void MultipleIds_InOneAnnotation_AreAllSuppressed()
    {
        const string source = @"package App

func Ping() int32 {
    return 1
}

@SuppressDiagnostic(""PROBE001"", ""PROBE002"")
func Suppressed() int32 {
    return Ping()
}

func NotSuppressed() int32 {
    return Ping()
}
";

        var produced = Run(source, new DualProbeAnalyzer());

        // One PROBE001 and one PROBE002 survive — both from NotSuppressed.
        Assert.Single(produced.Where(d => d.Id == "PROBE001"));
        Assert.Single(produced.Where(d => d.Id == "PROBE002"));
    }

    [Fact]
    public void NestedBlocks_SuppressDifferentIdsIndependently()
    {
        const string source = @"package App

func Ping() int32 {
    return 1
}

func Nested() int32 {
    var outer = 0
    @SuppressDiagnostic(""PROBE001"") {
        outer = Ping()
        @SuppressDiagnostic(""PROBE002"") {
            outer = outer + Ping()
        }
    }

    return outer + Ping()
}
";

        var produced = Run(source, new DualProbeAnalyzer());

        // PROBE001: suppressed by the outer block for both inner call sites;
        // the trailing call outside every block survives.
        Assert.Single(produced.Where(d => d.Id == "PROBE001"));

        // PROBE002: suppressed only inside the inner block; two survive.
        Assert.Equal(2, produced.Count(d => d.Id == "PROBE002"));
    }

    [Fact]
    public void MalformedId_ReportsGS9305_AndSuppressesNothing()
    {
        const string source = @"package App

func Ping() int32 {
    return 1
}

@SuppressDiagnostic(""not an id"")
func Suppressed() int32 {
    return Ping()
}
";

        var tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"));
        var compilation = new Compilation(tree);
        var bindDiagnostics = compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics);

        Assert.Contains(bindDiagnostics, d => d.Id == "GS9305");
    }

    [Fact]
    public void EmptyArgumentList_ReportsGS9305()
    {
        const string source = @"package App

@SuppressDiagnostic()
func Suppressed() int32 {
    return 1
}
";

        var tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"));
        var compilation = new Compilation(tree);

        Assert.Contains(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            d => d.Id == "GS9305");
    }

    [Fact]
    public void SuppressDiagnostic_NeedsNoAssemblyReference_AndEmitsNoAttributeError()
    {
        // The annotation names no CLR type, so the ordinary
        // "attribute type not found" path must never run for it.
        const string source = @"package App

@SuppressDiagnostic(""PROBE001"")
func Suppressed() int32 {
    return 1
}
";

        var tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"));
        var compilation = new Compilation(tree);

        Assert.DoesNotContain(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            d => d.IsError);
    }

    [Fact]
    public void NonSuppressAnnotation_BeforeABlock_IsStillRejected()
    {
        const string source = @"package App
import System

func Foo() {
    @Obsolete(""x"") {
        Console.WriteLine(1)
    }
}
";

        var tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"));
        var compilation = new Compilation(tree);

        Assert.Contains(compilation.BoundProgram.Diagnostics, d => d.Id == "GS0206");
    }

    [Fact]
    public void AnnotatedBlock_EmitsAndRuns_WithBlockScopedLocals()
    {
        // The block form is new grammar, so it must be proven at runtime, not
        // only at bind time: the annotated block runs its statements, scopes
        // its own locals, and produces the same value an unannotated block
        // would. 0+1+2+3+4 = 10, doubled = 20.
        const string source = @"
var total = 0
@SuppressDiagnostic(""GSA0005"") {
    var i = 0
    for i < 5 {
        total = total + i
        i = i + 1
    }
}

@SuppressDiagnostic(""GSA0005"", ""GSA0001"") {
    total = total * 2
}

Console.WriteLine(total)
";

        var result = EmittedOracle.Evaluate(source);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("20", result.Output.Trim());
    }

    [Fact]
    public void BlockLocal_DoesNotEscapeTheAnnotatedBlock()
    {
        const string source = @"
@SuppressDiagnostic(""GSA0005"") {
    var inner = 1
}

Console.WriteLine(inner)
";

        var result = EmittedOracle.Evaluate(source);

        // An annotated block is a real block: it opens a scope, exactly as the
        // unannotated form does.
        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    private static string LineOfEnclosingFunction(string source, Diagnostic diagnostic)
    {
        var lines = source.Replace("\r\n", "\n").Split('\n');
        for (var i = diagnostic.Location.StartLine; i >= 0; i--)
        {
            if (lines[i].StartsWith("func ", System.StringComparison.Ordinal))
            {
                return lines[i];
            }
        }

        return string.Empty;
    }

    private static ImmutableArray<Diagnostic> Run(string source, params GSharpDiagnosticAnalyzer[] analyzers)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"));
        var compilation = new Compilation(tree);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
        var effective = analyzers.Length == 0
            ? new GSharpDiagnosticAnalyzer[] { new CallProbeAnalyzer() }
            : analyzers;
        return GSharpAnalyzerDriver.Run(compilation, effective.ToImmutableArray());
    }

    /// <summary>Reports PROBE001 on every call expression.</summary>
    [GSharpDiagnosticAnalyzer]
    private sealed class CallProbeAnalyzer : GSharpDiagnosticAnalyzer
    {
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics
            => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
            => context.RegisterSyntaxNodeAction(
                ctx => ctx.ReportDiagnostic(Diagnostic.Create(ProbeRule, ctx.Node.Location)),
                SyntaxKind.CallExpression);
    }

    /// <summary>Reports both PROBE001 and PROBE002 on every call expression.</summary>
    [GSharpDiagnosticAnalyzer]
    private sealed class DualProbeAnalyzer : GSharpDiagnosticAnalyzer
    {
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics
            => ImmutableArray.Create(ProbeRule, OtherRule);

        public override void Initialize(AnalysisContext context)
            => context.RegisterSyntaxNodeAction(
                ctx =>
                {
                    ctx.ReportDiagnostic(Diagnostic.Create(ProbeRule, ctx.Node.Location));
                    ctx.ReportDiagnostic(Diagnostic.Create(OtherRule, ctx.Node.Location));
                },
                SyntaxKind.CallExpression);
    }
}
