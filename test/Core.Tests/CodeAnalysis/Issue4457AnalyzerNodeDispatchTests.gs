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
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4457: bound-node actions follow Roslyn's operation-tree traversal.
open class Issue4457AnalyzerNodeDispatchTests {
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
            switch context.BoundNode {
                case assignment is BoundAssignmentExpression when context
                    .ContainingFunction
                    ?.Name == "Outer" &&
                    assignment
                    .Variable
                    .Name == "total" {
                    Events.Add("assign:total")
                }
                case variable is BoundVariableExpression when context
                    .ContainingFunction
                    ?.Name == "Outer" &&
                    variable
                    .Variable
                    .Name == "total" {
                    Events.Add("variable:${variable.Variable.Name}")
                }
                case variable is BoundVariableExpression when context
                    .ContainingFunction
                    ?.Name == "Test" &&
                    variable
                    .Variable
                    .Name == "value" {
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
            let probe = ProbeAnalyzer()
            let compilation = Compilation(trees)
            Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
            GSharpAnalyzerDriver.Run(compilation, ImmutableArray.Create[GSharpDiagnosticAnalyzer](probe))
            return probe
        }
    }
}
