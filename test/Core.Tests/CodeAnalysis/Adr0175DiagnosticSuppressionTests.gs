// <copyright file="Adr0175DiagnosticSuppressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0175 (issues #3820 / #3824): source-level, scoped analyzer suppression
/// via `@SuppressDiagnostic("ID")`, in both the declaration-attribute form
/// and the annotated-block form.
///
/// The load-bearing property throughout is *scoping*: every test that asserts a
/// diagnostic is suppressed also asserts that the same diagnostic still fires
/// elsewhere in the same file. Without that pair the tests could not tell a
/// scoped suppression from a blanket disable.
open class Adr0175DiagnosticSuppressionTests {
    @Fact
    func NoSuppression_BothCallSitesReport() {
        const source = `package App

func Ping() int32 {
    return 1
}

func Suppressed() int32 {
    return Ping()
}

func NotSuppressed() int32 {
    return Ping()
}
`
        let produced = Run(source)
        Assert.Equal(2, produced.Count((d Diagnostic) -> d.Id == "PROBE001"))
    }

    @Fact
    func DeclarationForm_SuppressesInsideTheAnnotatedFunctionOnly() {
        const source = `package App

func Ping() int32 {
    return 1
}

@SuppressDiagnostic("PROBE001")
func Suppressed() int32 {
    return Ping()
}

func NotSuppressed() int32 {
    return Ping()
}
`
        let produced = Run(source)
        let hits = produced.Where((d Diagnostic) -> d.Id == "PROBE001").ToArray()
        // Scoping proof: exactly one survivor, and it is the call in the
        // *unannotated* function. A blanket disable would leave zero.
        Assert.Single(hits)
        Assert.Contains("NotSuppressed", LineOfEnclosingFunction(source, hits[0]))
    }

    @Fact
    func BlockForm_SuppressesOnlyTheAnnotatedStatementRange() {
        const source = `package App

func Ping() int32 {
    return 1
}

func Both() int32 {
    var first = 0
    @SuppressDiagnostic("PROBE001") {
        first = Ping()
    }

    var second = Ping()
    return first + second
}
`
        let produced = Run(source)
        let hits = produced.Where((d Diagnostic) -> d.Id == "PROBE001").ToArray()
        // Scoping proof, the sharp form: both call sites are in the SAME
        // function, so only a span-scoped suppression can keep exactly one.
        Assert.Single(hits)
        Assert.Equal(12, hits[0].Location.StartLine)
    }

    @Fact
    func SuppressionIsIdKeyed_OtherIdsStillReport() {
        const source = `package App

func Ping() int32 {
    return 1
}

@SuppressDiagnostic("PROBE001")
func Suppressed() int32 {
    return Ping()
}
`
        let produced = Run(source, DualProbeAnalyzer())
        Assert.Empty(produced.Where((d Diagnostic) -> d.Id == "PROBE001"))
        Assert.Single(produced.Where((d Diagnostic) -> d.Id == "PROBE002"))
    }

    @Fact
    func MultipleIds_InOneAnnotation_AreAllSuppressed() {
        const source = `package App

func Ping() int32 {
    return 1
}

@SuppressDiagnostic("PROBE001", "PROBE002")
func Suppressed() int32 {
    return Ping()
}

func NotSuppressed() int32 {
    return Ping()
}
`
        let produced = Run(source, DualProbeAnalyzer())
        // One PROBE001 and one PROBE002 survive — both from NotSuppressed.
        Assert.Single(produced.Where((d Diagnostic) -> d.Id == "PROBE001"))
        Assert.Single(produced.Where((d Diagnostic) -> d.Id == "PROBE002"))
    }

    @Fact
    func NestedBlocks_SuppressDifferentIdsIndependently() {
        const source = `package App

func Ping() int32 {
    return 1
}

func Nested() int32 {
    var outer = 0
    @SuppressDiagnostic("PROBE001") {
        outer = Ping()
        @SuppressDiagnostic("PROBE002") {
            outer = outer + Ping()
        }
    }

    return outer + Ping()
}
`
        let produced = Run(source, DualProbeAnalyzer())
        // PROBE001: suppressed by the outer block for both inner call sites;
        // the trailing call outside every block survives.
        Assert.Single(produced.Where((d Diagnostic) -> d.Id == "PROBE001"))
        // PROBE002: suppressed only inside the inner block; two survive.
        Assert.Equal(2, produced.Count((d Diagnostic) -> d.Id == "PROBE002"))
    }

    @Fact
    func MalformedId_ReportsGS9305_AndSuppressesNothing() {
        const source = `package App

func Ping() int32 {
    return 1
}

@SuppressDiagnostic("not an id")
func Suppressed() int32 {
    return Ping()
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
        let compilation = Compilation(tree)
        let bindDiagnostics = compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics)
        Assert.Contains(bindDiagnostics, (d Diagnostic) -> d.Id == "GS9305")
    }

    @Fact
    func EmptyArgumentList_ReportsGS9305() {
        const source = `package App

@SuppressDiagnostic()
func Suppressed() int32 {
    return 1
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
        let compilation = Compilation(tree)
        Assert.Contains(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            (d Diagnostic) -> d.Id == "GS9305"
        )
    }

    @Fact
    func SuppressDiagnostic_NeedsNoAssemblyReference_AndEmitsNoAttributeError() {
        // The annotation names no CLR type, so the ordinary
        // "attribute type not found" path must never run for it.
        const source = `package App

@SuppressDiagnostic("PROBE001")
func Suppressed() int32 {
    return 1
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
        let compilation = Compilation(tree)
        Assert.DoesNotContain(
            compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics),
            (d Diagnostic) -> d.IsError
        )
    }

    @Fact
    func NonSuppressAnnotation_BeforeABlock_IsStillRejected() {
        const source = `package App
import System

func Foo() {
    @Obsolete("x") {
        Console.WriteLine(1)
    }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
        let compilation = Compilation(tree)
        Assert.Contains(compilation.BoundProgram.Diagnostics, (d Diagnostic) -> d.Id == "GS0206")
    }

    @Fact
    func AnnotatedBlock_EmitsAndRuns_WithBlockScopedLocals() {
        // The block form is new grammar, so it must be proven at runtime, not
        // only at bind time: the annotated block runs its statements, scopes
        // its own locals, and produces the same value an unannotated block
        // would. 0+1+2+3+4 = 10, doubled = 20.
        const source = `
var total = 0
@SuppressDiagnostic("GSA0005") {
    var i = 0
    for i < 5 {
        total = total + i
        i = i + 1
    }
}

@SuppressDiagnostic("GSA0005", "GSA0001") {
    total = total * 2
}

Console.WriteLine(total)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("20", result.Output.Trim())
    }

    @Fact
    func BlockLocal_DoesNotEscapeTheAnnotatedBlock() {
        const source = `
@SuppressDiagnostic("GSA0005") {
    var inner = 1
}

Console.WriteLine(inner)
`
        let result = EmittedOracle.Evaluate(source)
        // An annotated block is a real block: it opens a scope, exactly as the
        // unannotated form does.
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    /// Reports PROBE001 on every call expression.
    @GSharpDiagnosticAnalyzer
    private class CallProbeAnalyzer : GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0175DiagnosticSuppressionTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) -> context.RegisterSyntaxNodeAction(
            (ctx SyntaxNodeAnalysisContext) -> ctx.ReportDiagnostic(
                Diagnostic.Create(Adr0175DiagnosticSuppressionTests.ProbeRule, ctx.Node.Location)
            ),
            SyntaxKind.CallExpression
        )
    }

    /// Reports both PROBE001 and PROBE002 on every call expression.
    @GSharpDiagnosticAnalyzer
    private class DualProbeAnalyzer : GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0175DiagnosticSuppressionTests.ProbeRule,
            Adr0175DiagnosticSuppressionTests.OtherRule
        )

        override func Initialize(context AnalysisContext) -> context.RegisterSyntaxNodeAction(
            (ctx SyntaxNodeAnalysisContext) -> {
                ctx.ReportDiagnostic(Diagnostic.Create(Adr0175DiagnosticSuppressionTests.ProbeRule, ctx.Node.Location))
                ctx.ReportDiagnostic(Diagnostic.Create(Adr0175DiagnosticSuppressionTests.OtherRule, ctx.Node.Location))
            },
            SyntaxKind.CallExpression
        )
    }

    shared {
        private let ProbeRule DiagnosticDescriptor = DiagnosticDescriptor(
            "PROBE001",
            "Probe",
            "Probe hit.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )
        private let OtherRule DiagnosticDescriptor = DiagnosticDescriptor(
            "PROBE002",
            "Other probe",
            "Other probe hit.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )

        private func LineOfEnclosingFunction(source string, diagnostic Diagnostic) string {
            let lines = source.Replace("\r\n", "\n").Split('\n')
            for var i = diagnostic.Location.StartLine; i >= 0; i-- {
                if lines[i].StartsWith("func ", StringComparison.Ordinal) {
                    return lines[i]
                }
            }
            return string.Empty
        }

        private func Run(source string, analyzers ...GSharpDiagnosticAnalyzer) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source, "app.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
            let effective = if analyzers.Length == 0 {
                []GSharpDiagnosticAnalyzer{CallProbeAnalyzer()}
            } else {
                analyzers
            }
            return GSharpAnalyzerDriver.Run(compilation, effective.ToImmutableArray())
        }
    }
}
