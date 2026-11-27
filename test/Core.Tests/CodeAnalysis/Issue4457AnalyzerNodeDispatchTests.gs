// <copyright file="Issue4457AnalyzerNodeDispatchTests.cs" company="GSharp">
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
import Xunit

/// Issue #4457: bound-node actions follow Roslyn's operation-tree traversal.
open class Issue4457AnalyzerNodeDispatchTests {
    @Theory
    @InlineData("Debug.WriteLine(Compute(value))", false)
    @InlineData("Debug.WriteLine(Compute(value))", true)
    @InlineData("Make(value).Log(Compute(value))", false)
    @InlineData("Make(value).Log(Compute(value))", true)
    @InlineData("MaybeMake(value)?.Log(Compute(value))", false)
    @InlineData("MaybeMake(value)?.Log(Compute(value))", true)
    @InlineData("Build(value).LogSlice(Compute(value))", false)
    @InlineData("Build(value).LogSlice(Compute(value))", true)
    func NodeActions_VisitActiveConditionalOperandsAndOriginalReceiverPreludes(call string, enabled bool) {
        let source = `import System.Diagnostics
class Sink { @Conditional("DEBUG") func Log(value int32) {} }
@Conditional("DEBUG") func (self slice[int32]) LogSlice(value int32) {}
func Compute(value int32) int32 -> value
func Make(value int32) Sink -> Sink()
func MaybeMake(value int32) Sink? -> Sink()
func Build(value int32) slice[int32] -> slice[int32]{value}
func Read(value int32) {
    CALL
    @If(false) { Missing(Compute(absent)) }
}`.Replace("CALL", call, StringComparison.Ordinal)
        let tree = SyntaxTree.Parse(SourceText.From(source, "active-operands.gs"))
        let compilation = Compilation(tree){
            IsLibrary = true,
            PreprocessorSymbols = if enabled {
                ImmutableHashSet.Create("DEBUG")
            } else {
                ImmutableHashSet[string].Empty
            }
        }
        let probe = Run(compilation)
        let model = compilation.GetSemanticModel(tree)
        let read = tree
            .Root
            .Members
            .OfType[FunctionDeclarationSyntax]()
            .Single((node FunctionDeclarationSyntax) -> node.Identifier.Text == "Read")
        let activeComputeStart = source.IndexOf("Compute(value)", StringComparison.Ordinal)
        let activeCall = read
            .DescendantNodesAndSelf()
            .OfType[CallExpressionSyntax]()
            .Single((node CallExpressionSyntax) -> node.Span.Start == activeComputeStart)
        let boundCompute = Assert.IsAssignableFrom[BoundCallOperationExpression](model.GetBoundNode(activeCall))
        Assert.Equal(TypeSymbol.Int32, model.GetTypeInfo(activeCall).Type)
        let callbacks = probe
            .RetainedNodes
            .OfType[BoundCallOperationExpression]()
            .Where((node BoundCallOperationExpression) -> node.CalledFunction.Name == "Compute")
            .ToArray()
        let callback = Assert.Single(callbacks)
        Assert.Same(boundCompute, callback)
        Assert.Equal(activeComputeStart, callback.Syntax!!.Span.Start)
        Assert.Equal("Compute(value)".Length, callback.Syntax!!.Span.Length)

        let outer = read
            .DescendantNodesAndSelf()
            .OfType[CallExpressionSyntax]()
            .Single((node CallExpressionSyntax) -> node.Identifier.Text is "WriteLine" or "Log" or "LogSlice")
        let operation = Assert.IsAssignableFrom[BoundExpression](model.GetBoundNode(outer))
        var callOperation = operation
        while callOperation is BoundBlockExpression block {
            callOperation = block.Expression
        }
        let conditional = Assert.IsAssignableFrom[BoundCallOperationExpression](callOperation)
        Assert.Equal(!enabled, conditional.IsElidedConditionalCall)
        if !enabled && call.StartsWith("Build(", StringComparison.Ordinal) {
            Assert.NotEmpty(conditional.ElidedSourceStatements)
        }
        Assert.Same(
            boundCompute,
            Assert.Single(
                operation
                    .Descendants()
                    .OfType[BoundCallOperationExpression]()
                    .Where((node BoundCallOperationExpression) -> node.CalledFunction.Name == "Compute")
            )
        )
        Assert.Same(
            boundCompute,
            Assert.Single(
                operation
                    .ChildNodes
                    .SelectMany((node BoundNode) -> node.DescendantsAndSelf())
                    .OfType[BoundCallOperationExpression]()
                    .Where((node BoundCallOperationExpression) -> node.CalledFunction.Name == "Compute")
            )
        )

        let expectedValues = read
            .DescendantNodesAndSelf()
            .OfType[NameExpressionSyntax]()
            .Where((node NameExpressionSyntax) -> node.IdentifierToken.Text == "value")
            .Select((node NameExpressionSyntax) -> node.Span.Start)
            .OrderBy((start int32) -> start)
            .ToArray()
        Assert.Equal(
            if call.StartsWith("Debug.", StringComparison.Ordinal) {
                1
            } else {
                2
            },
            expectedValues.Length
        )
        Assert.Equal(
            expectedValues,
            probe
                .RetainedNodes
                .OfType[BoundVariableExpression]()
                .Where((node BoundVariableExpression) -> node.Variable.Name == "value")
                .Select((node BoundVariableExpression) -> node.Syntax!!.Span.Start)
                .OrderBy((start int32) -> start)
                .ToArray()
        )
        if !call.StartsWith("Debug.", StringComparison.Ordinal) {
            let factory = Assert.Single(
                probe
                    .RetainedNodes
                    .OfType[BoundCallOperationExpression]()
                    .Where(
                    (node BoundCallOperationExpression) -> node.CalledFunction.Name is "Make" or "MaybeMake" or "Build"
                )
            )
            Assert.Equal(source.IndexOf(call, StringComparison.Ordinal), factory.Syntax!!.Span.Start)
            Assert.Equal(call.IndexOf(')') + 1, factory.Syntax!!.Span.Length)
        }
        let inactiveCompute = read
            .DescendantNodesAndSelf()
            .OfType[CallExpressionSyntax]()
            .Single(
            (node CallExpressionSyntax) -> node.Identifier.Text == "Compute" && node.Span.Start != activeComputeStart
        )
        Assert.False(compilation.IsActive(inactiveCompute))
        Assert.Null(model.GetBoundNode(inactiveCompute))
        Assert.DoesNotContain(
            probe.RetainedNodes,
            (node BoundNode) -> node.Syntax?.Span.Start == inactiveCompute.Span.Start
        )
    }

    @Fact
    func NodeActions_EnterFunctionLiterals_AndVisitAssignmentTargetBeforeValue() {
        const source = `package App

func Mark(value int32) int32 {
    return value
}

func Outer() int32 {
    var total int32 = 0
    total = Mark(1)
    let lambda = func() int32 {
        return Mark(2)
    }
    let local[T] = func(value T) int32 {
        return Mark(3)
    }
    return total
}
`
        let probe = Run(source)
        Assert.Equal(
            []string{"assign:total", "variable:total", "call:Mark", "call:Mark", "call:Mark", "variable:total"},
            probe.Events
        )
        Assert.Equal([]string{"Outer", "Outer", "Outer"}, probe.MarkContainingFunctions)
    }

    @Fact
    func NodeActions_KeepPlainTypeTestPatternOpaque() {
        const source = `package App

func Test(value object) bool {
    return value is int32
}
`
        let probe = Run(source)
        Assert.Equal([]string{"variable:value"}, probe.Events)
    }

    @Fact
    func TopLevelFunctionLiteral_IsDispatchedOnceByItsEnclosingEntryPoint() {
        const source = `package App

func Mark(value int32) int32 {
    return value
}

Mark(1)
let nested = func() int32 {
    return Mark(2)
}
`
        let probe = Run(source)
        Assert.Equal([]string{"call:Mark", "call:Mark"}, probe.Events)
        Assert.Equal([]string{"<Main>$$", "<Main>$$"}, probe.MarkContainingFunctions)
        Assert.Equal(2, probe.TopLevelBlockCount)
    }

    @Fact
    func MixedTopLevelTrees_FilterGeneratedNodesIndividually() {
        let AssertMixedTreeDispatch = func (probe ProbeAnalyzer) {
            Assert.Equal([]string{"call:Mark", "call:Mark"}, probe.Events)
            Assert.Equal([]string{"<Main>$$", "<Main>$$"}, probe.MarkContainingFunctions)
            Assert.Equal(2, probe.TopLevelBlockCount)
        }
        const generated = `package App

Mark(1)
let generatedNested = func() int32 {
    return Mark(2)
}
`
        const user = `package App

func Mark(value int32) int32 {
    return value
}

Mark(3)
let userNested = func() int32 {
    return Mark(4)
}
`
        let generatedTree = SyntaxTree.Parse(SourceText.From(generated, "generated.g.gs"))
        let userTree = SyntaxTree.Parse(SourceText.From(user, "app.gs"))
        AssertMixedTreeDispatch(Run(generatedTree, userTree))
        AssertMixedTreeDispatch(Run(userTree, generatedTree))
    }

    @GSharpDiagnosticAnalyzer
    private class ProbeAnalyzer : GSharpDiagnosticAnalyzer {
        init() {
            Events = List[string]()
            MarkContainingFunctions = List[string]()
            RetainedNodes = List[BoundNode]()
        }

        prop RetainedNodes List[BoundNode] {
            get;
        }

        prop Events List[string] {
            get;
        }

        prop MarkContainingFunctions List[string] {
            get;
        }

        prop TopLevelBlockCount int32 {
            get;
            private set;
        }

        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(
            Issue4457AnalyzerNodeDispatchTests.ProbeRule
        )

        override func Initialize(context AnalysisContext) {
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None)
            context.RegisterBoundNodeAction(
                Analyze,
                BoundNodeKind.AssignmentExpression,
                BoundNodeKind.VariableExpression,
                BoundNodeKind.CallExpression,
                BoundNodeKind.TypePattern,
                BoundNodeKind.BlockStatement
            )
        }

        private func Analyze(context BoundNodeAnalysisContext) {
            if context.ContainingFunction?.Name == "Read" {
                RetainedNodes.Add(context.BoundNode)
            }
            switch context.BoundNode {
                case assignment is BoundAssignmentExpression when context.ContainingFunction?.Name == "Outer" &&
                    assignment.Variable.Name == "total" {
                    Events.Add("assign:total")
                }
                case variable is BoundVariableExpression when context.ContainingFunction?.Name == "Outer" &&
                    variable.Variable.Name == "total" {
                    Events.Add("variable:${variable.Variable.Name}")
                }
                case variable is BoundVariableExpression when context.ContainingFunction?.Name == "Test" &&
                    variable.Variable.Name == "value" {
                    Events.Add("variable:value")
                }
                case call is BoundCallOperationExpression when call.CalledFunction.Name == "Mark" {
                    Events.Add("call:Mark")
                    MarkContainingFunctions.Add(context.ContainingFunction?.Name ?? "<none>")
                }
                case BoundTypePattern {
                    Events.Add("type-pattern")
                }
                case _ is BoundBlockStatement when context.ContainingFunction?.Name == "<Main>$$" {
                    TopLevelBlockCount++
                }
            }
        }
    }

    shared {
        private let ProbeRule DiagnosticDescriptor = DiagnosticDescriptor(
            "PROBE4457",
            "Probe",
            "Probe.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )
        private func Run(source string) ProbeAnalyzer -> Run(SyntaxTree.Parse(SourceText.From(source, "app.gs")))

        private func Run(trees ...SyntaxTree) ProbeAnalyzer {
            let compilation = Compilation(trees)
            return Run(compilation)
        }

        private func Run(compilation Compilation) ProbeAnalyzer {
            let probe = ProbeAnalyzer()
            Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
            GSharpAnalyzerDriver.Run(compilation, ImmutableArray.Create[GSharpDiagnosticAnalyzer](probe))
            return probe
        }
    }
}
