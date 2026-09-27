// <copyright file="Issue4457AnalyzerNodeDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #4457: bound-node actions follow Roslyn's operation-tree traversal.
/// </summary>
public class Issue4457AnalyzerNodeDispatchTests
{
    private static readonly DiagnosticDescriptor ProbeRule = new(
        "PROBE4457", "Probe", "Probe.", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    [Fact]
    public void NodeActions_EnterFunctionLiterals_AndVisitAssignmentTargetBeforeValue()
    {
        const string source = @"package App

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
";
        var probe = Run(source);

        Assert.Equal(
            new[]
            {
                "assign:total",
                "variable:total",
                "call:Mark",
                "call:Mark",
                "call:Mark",
                "variable:total",
            },
            probe.Events);
        Assert.Equal(new[] { "Outer", "Outer", "Outer" }, probe.MarkContainingFunctions);
    }

    [Fact]
    public void NodeActions_KeepPlainTypeTestPatternOpaque()
    {
        const string source = @"package App

func Test(value object) bool {
    return value is int32
}
";
        var probe = Run(source);

        Assert.Equal(new[] { "variable:value" }, probe.Events);
    }

    [Fact]
    public void TopLevelFunctionLiteral_IsDispatchedOnceByItsEnclosingEntryPoint()
    {
        const string source = @"package App

func Mark(value int32) int32 {
    return value
}

Mark(1)
let nested = func() int32 {
    return Mark(2)
}
";
        var probe = Run(source);

        Assert.Equal(new[] { "call:Mark", "call:Mark" }, probe.Events);
        Assert.Equal(new[] { "<Main>$", "<Main>$" }, probe.MarkContainingFunctions);
    }

    [Fact]
    public void MixedTopLevelTrees_FilterGeneratedNodesIndividually()
    {
        const string generated = @"package App

Mark(1)
let generatedNested = func() int32 {
    return Mark(2)
}
";
        const string user = @"package App

func Mark(value int32) int32 {
    return value
}

Mark(3)
let userNested = func() int32 {
    return Mark(4)
}
";
        var probe = Run(
            SyntaxTree.Parse(SourceText.From(generated, "generated.g.gs")),
            SyntaxTree.Parse(SourceText.From(user, "app.gs")));

        Assert.Equal(new[] { "call:Mark", "call:Mark" }, probe.Events);
        Assert.Equal(new[] { "<Main>$", "<Main>$" }, probe.MarkContainingFunctions);
    }

    private static ProbeAnalyzer Run(string source)
        => Run(SyntaxTree.Parse(SourceText.From(source, "app.gs")));

    private static ProbeAnalyzer Run(params SyntaxTree[] trees)
    {
        var probe = new ProbeAnalyzer();
        var compilation = new Compilation(trees);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
        GSharpAnalyzerDriver.Run(compilation, ImmutableArray.Create<GSharpDiagnosticAnalyzer>(probe));
        return probe;
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class ProbeAnalyzer : GSharpDiagnosticAnalyzer
    {
        public List<string> Events { get; } = new();

        public List<string> MarkContainingFunctions { get; } = new();

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterBoundNodeAction(
                Analyze,
                BoundNodeKind.AssignmentExpression,
                BoundNodeKind.VariableExpression,
                BoundNodeKind.CallExpression,
                BoundNodeKind.TypePattern);
        }

        private void Analyze(BoundNodeAnalysisContext context)
        {
            switch (context.BoundNode)
            {
                case BoundAssignmentExpression assignment
                    when context.ContainingFunction?.Name == "Outer" && assignment.Variable.Name == "total":
                    Events.Add("assign:total");
                    break;
                case BoundVariableExpression variable
                    when context.ContainingFunction?.Name == "Outer" && variable.Variable.Name == "total":
                    Events.Add($"variable:{variable.Variable.Name}");
                    break;
                case BoundVariableExpression variable
                    when context.ContainingFunction?.Name == "Test" && variable.Variable.Name == "value":
                    Events.Add("variable:value");
                    break;
                case BoundCallOperationExpression call when call.CalledFunction.Name == "Mark":
                    Events.Add("call:Mark");
                    MarkContainingFunctions.Add(context.ContainingFunction?.Name ?? "<none>");
                    break;
                case BoundTypePattern:
                    Events.Add("type-pattern");
                    break;
            }
        }
    }
}
