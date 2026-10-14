// <copyright file="Adr0169AnalyzerDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading
import Xunit

/// Covers the ADR-0169 (cref:GSharpAnalyzerDriver): per-kind dispatch,
/// crash containment (GS9300), unsupported-ID suppression (GS9304),
/// disabled-by-default filtering, generated-code skipping, time budget
/// (GS9302), and cancellation.
open class Adr0169AnalyzerDriverTests {
    @Fact
    func SyntaxNodeAction_FiresPerMatchingKind_WithSemanticModel() {
        let probe = SyntaxProbeAnalyzer()
        let produced = Run(Source, probe)
        Assert.Equal(2, probe.Nodes.Count)
        Assert.All(probe.Nodes, (n SyntaxNode) -> Assert.Equal(SyntaxKind.CallExpression, n.Kind))
        Assert.Equal(2, produced.Count((d Diagnostic) -> d.Id == "PROBE001"))
        Assert.True(probe.SawSemanticModel)
    }

    @Fact
    func SymbolAction_FiresForFunctionsAndFields() {
        let probe = SymbolProbeAnalyzer()
        Run(Source, probe)
        Assert.Contains("Add", probe.FunctionNames)
        Assert.Contains("Main", probe.FunctionNames)
        Assert.Contains("entries", probe.FieldNames)
    }

    @Fact
    func BoundNodeAction_FiresForCallExpressions() {
        let probe = BoundNodeProbeAnalyzer()
        Run(Source, probe)
        Assert.True(probe.CallCount >= 1)
        Assert.Contains(probe.ContainingFunctions, (name string) -> name == "Main")
    }

    @Fact
    func TreeSemanticModelAndCompilationActions_FireInOrder() {
        let probe = LifecycleProbeAnalyzer()
        Run(Source, probe)
        Assert.Equal([]string{"start", "tree", "semanticModel", "end", "compilation"}, probe.Events)
    }

    @Fact
    func ThrowingAnalyzer_IsDisabledWithGs9300_AndSiblingContinues() {
        let throwing = ThrowingAnalyzer()
        let sibling = SyntaxProbeAnalyzer()
        let produced = Run(Source, throwing, sibling)
        Assert.Single(produced.Where((d Diagnostic) -> d.Id == "GS9300"))
        Assert.Equal(1, throwing.Invocations)
        Assert.Equal(2, sibling.Nodes.Count)
    }

    @Fact
    func UnsupportedDiagnosticId_IsSuppressedWithGs9304() {
        let produced = Run(Source, UnsupportedIdAnalyzer())
        Assert.Single(produced.Where((d Diagnostic) -> d.Id == "GS9304"))
        Assert.DoesNotContain(produced, (d Diagnostic) -> d.Id == "ROGUE001")
    }

    @Fact
    func DisabledByDefaultRule_IsDropped() {
        let produced = Run(Source, DisabledRuleAnalyzer())
        Assert.DoesNotContain(produced, (d Diagnostic) -> d.Id == "PROBE002")
    }

    @Fact
    func GeneratedTree_IsSkipped_UnlessAnalyzeFlagSet() {
        let silent = SyntaxProbeAnalyzer()
        RunWithFileName(Source, "app.g.gs", silent)
        Assert.Empty(silent.Nodes)
        let analyzing = SyntaxProbeAnalyzer(GeneratedCodeAnalysisFlags.Analyze)
        let produced = RunWithFileName(Source, "app.g.gs", analyzing)
        Assert.Equal(2, analyzing.Nodes.Count)
        // Analyze without ReportDiagnostics: callbacks ran, reports suppressed.
        Assert.DoesNotContain(produced, (d Diagnostic) -> d.Id == "PROBE001")
    }

    @Fact
    func TimeBudget_DisablesSlowAnalyzer_WithGs9302() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"))
        let compilation = Compilation(tree)
        let produced = GSharpAnalyzerDriver.Run(
            compilation,
            ImmutableArray.Create[GSharpDiagnosticAnalyzer](SlowAnalyzer()),
            AnalyzerOptions{TimeBudgetMilliseconds: 1}
        )
        Assert.Single(produced.Where((d Diagnostic) -> d.Id == "GS9302"))
    }

    @Fact
    func PreCancelledToken_CancelsTheRun() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"))
        let compilation = Compilation(tree)
        using let cts = CancellationTokenSource()
        cts.Cancel()
        Assert.ThrowsAny[OperationCanceledException](
            func () object? {
                return GSharpAnalyzerDriver.Run(
                    compilation,
                    ImmutableArray.Create[GSharpDiagnosticAnalyzer](SyntaxProbeAnalyzer()),
                    cancellationToken: cts.Token
                )
            }
        )
    }

    @GSharpDiagnosticAnalyzer
    private class SyntaxProbeAnalyzer : GSharpDiagnosticAnalyzer {
        private let flags GeneratedCodeAnalysisFlags

        convenience init() {
            init(GeneratedCodeAnalysisFlags.None)
        }

        init(flags GeneratedCodeAnalysisFlags) {
            Nodes = List[SyntaxNode]()
            this.flags = flags
        }

        prop Nodes List[SyntaxNode] {
            get;
        }

        prop SawSemanticModel bool {
            get;
            private set;
        }

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0169AnalyzerDriverTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.ConfigureGeneratedCodeAnalysis(flags)
            context.EnableConcurrentExecution()
            context.RegisterSyntaxNodeAction(
                (ctx SyntaxNodeAnalysisContext) -> {
                    Nodes.Add(ctx.Node)
                    SawSemanticModel |= ctx.SemanticModel != nil
                    ctx.ReportDiagnostic(
                        Diagnostic.Create(Adr0169AnalyzerDriverTests.ProbeRule, ctx.Node.Location, ctx.Node.Kind)
                    )
                },
                SyntaxKind.CallExpression
            )
        }
    }

    @GSharpDiagnosticAnalyzer
    private class SymbolProbeAnalyzer : GSharpDiagnosticAnalyzer {
        init() {
            FunctionNames = List[string]()
            FieldNames = List[string]()
        }

        prop FunctionNames List[string] {
            get;
        }

        prop FieldNames List[string] {
            get;
        }

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0169AnalyzerDriverTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.RegisterSymbolAction(
                (ctx SymbolAnalysisContext) -> {
                    if ctx.Symbol is FunctionSymbol {
                        FunctionNames.Add(ctx.Symbol.Name)
                    } else {
                        FieldNames.Add(ctx.Symbol.Name)
                    }
                },
                SymbolKind.Function,
                SymbolKind.Field
            )
        }
    }

    @GSharpDiagnosticAnalyzer
    private class BoundNodeProbeAnalyzer : GSharpDiagnosticAnalyzer {
        init() {
            ContainingFunctions = List[string]()
        }

        prop CallCount int32 {
            get;
            private set;
        }

        prop ContainingFunctions List[string] {
            get;
        }

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0169AnalyzerDriverTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.RegisterBoundNodeAction(
                (ctx BoundNodeAnalysisContext) -> {
                    CallCount++
                    if ctx.ContainingFunction is {} function {
                        ContainingFunctions.Add(function.Name)
                    }
                },
                BoundNodeKind.CallExpression
            )
        }
    }

    @GSharpDiagnosticAnalyzer
    private class LifecycleProbeAnalyzer : GSharpDiagnosticAnalyzer {
        init() {
            Events = List[string]()
        }

        prop Events List[string] {
            get;
        }

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0169AnalyzerDriverTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.RegisterCompilationStartAction(
                (startCtx CompilationStartAnalysisContext) -> {
                    Events.Add("start")
                    startCtx.RegisterCompilationEndAction((_ CompilationAnalysisContext) -> Events.Add("end"))
                }
            )
            context.RegisterSyntaxTreeAction((_ SyntaxTreeAnalysisContext) -> Events.Add("tree"))
            context.RegisterSemanticModelAction((_ SemanticModelAnalysisContext) -> Events.Add("semanticModel"))
            context.RegisterCompilationAction((_ CompilationAnalysisContext) -> Events.Add("compilation"))
        }
    }

    @GSharpDiagnosticAnalyzer
    private class ThrowingAnalyzer : GSharpDiagnosticAnalyzer {
        prop Invocations int32 {
            get;
            private set;
        }

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0169AnalyzerDriverTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.RegisterSyntaxNodeAction(
                (_ SyntaxNodeAnalysisContext) -> {
                    Invocations++
                    throw InvalidOperationException("boom")
                },
                SyntaxKind.CallExpression
            )
        }
    }

    @GSharpDiagnosticAnalyzer
    private class UnsupportedIdAnalyzer : GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0169AnalyzerDriverTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.RegisterSyntaxNodeAction(
                (ctx SyntaxNodeAnalysisContext) -> ctx.ReportDiagnostic(Diagnostic.Create(Rogue, ctx.Node.Location)),
                SyntaxKind.CallExpression
            )
        }

        shared {
            private let Rogue DiagnosticDescriptor = DiagnosticDescriptor(
                "ROGUE001",
                "Rogue",
                "Undeclared rule.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )
        }
    }

    @GSharpDiagnosticAnalyzer
    private class DisabledRuleAnalyzer : GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0169AnalyzerDriverTests.DisabledRule
        )

        override func Initialize(context AnalysisContext) {
            context.RegisterSyntaxNodeAction(
                (ctx SyntaxNodeAnalysisContext) -> ctx.ReportDiagnostic(
                    Diagnostic.Create(Adr0169AnalyzerDriverTests.DisabledRule, ctx.Node.Location)
                ),
                SyntaxKind.CallExpression
            )
        }
    }

    @GSharpDiagnosticAnalyzer
    private class SlowAnalyzer : GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Adr0169AnalyzerDriverTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.RegisterSyntaxTreeAction((_ SyntaxTreeAnalysisContext) -> Thread.Sleep(25))
        }
    }

    shared {
        private const Source string = `package App
import System

class Cache {
    var entries int32
}

func Add(left int32, right int32) int32 {
    return left + right
}

func Main() {
    var total = Add(1, 2)
    Console.WriteLine(total)
}
`

        private let ProbeRule DiagnosticDescriptor = DiagnosticDescriptor(
            "PROBE001",
            "Probe",
            "Probe hit '{0}'.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )
        private let DisabledRule DiagnosticDescriptor = DiagnosticDescriptor(
            "PROBE002",
            "Disabled probe",
            "Should never surface.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: false
        )
        private func Run(source string, analyzers ...GSharpDiagnosticAnalyzer) ImmutableArray[
            Diagnostic
        ] -> RunWithFileName(source, "app.gs", analyzers)

        private func RunWithFileName(
            source string,
            fileName string,
            analyzers ...GSharpDiagnosticAnalyzer
        ) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source, fileName))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
            return GSharpAnalyzerDriver.Run(compilation, analyzers.ToImmutableArray())
        }
    }
}
