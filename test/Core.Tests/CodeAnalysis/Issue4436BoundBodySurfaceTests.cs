// <copyright file="Issue4436BoundBodySurfaceTests.cs" company="GSharp">
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
/// Issue #4436 (ADR-0169): the bound-body surface follows Roslyn's operation
/// tree, not the compiler walker, where the two differ.
/// </summary>
public class Issue4436BoundBodySurfaceTests
{
    private const string Source = @"package App

class Box {
    prop Value int32 { get { return 1 } }
}

func Add(left int32, right int32) int32 {
    return left + right
}

func Outer() int32 {
    var total int32 = 0
    total = Add(1, 2)
    let f = func() int32 {
        return Add(3, 4)
    }
    let o object = total
    let b = o is int32
    return f()
}
";

    private static readonly DiagnosticDescriptor ProbeRule = new(
        "PROBE4436", "Probe", "Probe '{0}'.", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    [Fact]
    public void Descendants_EnterFunctionLiteralBodies()
    {
        // The walker keeps a function literal opaque; Roslyn's operation block
        // contains the lambda's body, so both calls to Add are descendants.
        var kinds = OuterDescendants(Run(Source, GeneratedCodeAnalysisFlags.None));

        Assert.Equal(2, kinds.Count(kind => kind == BoundNodeKind.CallExpression));
    }

    [Fact]
    public void ChildNodes_OfAnAssignment_AreTargetThenValue()
    {
        var probe = Run(Source, GeneratedCodeAnalysisFlags.None);
        var assignment = probe.Bodies["Outer"].SelectMany(b => b.Descendants()).OfType<BoundAssignmentExpression>().Single();

        Assert.Equal(
            new[] { BoundNodeKind.VariableExpression, BoundNodeKind.CallExpression },
            assignment.ChildNodes.Select(n => n.Kind));
        Assert.Same(assignment.Target, assignment.ChildNodes[0]);
    }

    [Fact]
    public void ChildNodes_OfAPlainTypeTest_AreTheOperandOnly()
    {
        var probe = Run(Source, GeneratedCodeAnalysisFlags.None);
        var test = probe.Bodies["Outer"].SelectMany(b => b.Descendants()).OfType<BoundIsExpression>().Single();

        Assert.Equal(new[] { BoundNodeKind.VariableExpression }, test.ChildNodes.Select(n => n.Kind));
        Assert.DoesNotContain(OuterDescendants(probe), kind => kind == BoundNodeKind.TypePattern);
    }

    [Fact]
    public void BoundBodyAction_SkipsSynthesizedAccessorsOfAGeneratedTree()
    {
        // A generated property's accessors have no declaration; their bodies
        // still come from the generated tree.
        var skipping = RunFile(Source, "app.g.gs", GeneratedCodeAnalysisFlags.None);
        Assert.True(skipping.Bodies.Count == 0, string.Join(",", skipping.Owners.Select(o => o.Name + "/" + o.MethodKind)));

        var analyzing = RunFile(Source, "app.g.gs", GeneratedCodeAnalysisFlags.Analyze);
        Assert.Contains(analyzing.Owners, owner => owner.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet);
    }

    [Fact]
    public void BoundBodyAction_RunsOnFieldInitializers_OwnedByTheField()
    {
        // Roslyn runs operation-block actions on field-initializer blocks.
        // G# keeps initializers outside every function body, the
        // constructor's included, so they are dispatched on their own.
        const string source = @"package App

func Add(left int32, right int32) int32 {
    return left + right
}

class Holder {
    var count int32 = Add(5, 6)
    shared {
        let Seed int32 = Add(7, 8)
    }
    init() {
    }
}
";
        var probe = Run(source, GeneratedCodeAnalysisFlags.None);

        Assert.Equal(new[] { "Seed", "count" }, probe.FieldOwners.OrderBy(n => n, System.StringComparer.Ordinal));
        Assert.All(probe.FieldOwners, name =>
            Assert.Contains(probe.Bodies[name].SelectMany(b => b.DescendantsAndSelf()), n => n.Kind == BoundNodeKind.CallExpression));
    }

    [Fact]
    public void AnAccessorKeepsThePropertyThatFirstClaimedIt()
    {
        // A constructed generic property reuses its definition's accessors;
        // repointing them would lose the definition's attributes.
        var getter = new FunctionSymbol("get_Value", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int32);
        var definition = NewProperty();
        var constructed = NewProperty();

        definition.GetterSymbol = getter;
        constructed.GetterSymbol = getter;
        Assert.Same(definition, getter.AssociatedSymbol);

        definition.GetterSymbol = null;
        Assert.Null(getter.AssociatedSymbol);
    }

    private static PropertySymbol NewProperty()
        => new(
            "Value",
            TypeSymbol.Int32,
            Accessibility.Public,
            hasGetter: true,
            hasSetter: false,
            isAutoProperty: false,
            isVirtual: false,
            isOverride: false);

    private static List<BoundNodeKind> OuterDescendants(BodyProbe probe)
        => probe.Bodies["Outer"].SelectMany(b => b.Descendants()).Select(n => n.Kind).ToList();

    private static BodyProbe Run(string source, GeneratedCodeAnalysisFlags flags) => RunFile(source, "app.gs", flags);

    private static BodyProbe RunFile(string source, string fileName, GeneratedCodeAnalysisFlags flags)
    {
        var probe = new BodyProbe(flags);
        var tree = SyntaxTree.Parse(SourceText.From(source, fileName));
        var compilation = new Compilation(tree);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
        GSharpAnalyzerDriver.Run(compilation, ImmutableArray.Create<GSharpDiagnosticAnalyzer>(probe));
        return probe;
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class BodyProbe : GSharpDiagnosticAnalyzer
    {
        private readonly GeneratedCodeAnalysisFlags flags;

        public BodyProbe(GeneratedCodeAnalysisFlags flags) => this.flags = flags;

        public Dictionary<string, ImmutableArray<BoundNode>> Bodies { get; } = new();

        public List<FunctionSymbol> Owners { get; } = new();

        public List<string> FieldOwners { get; } = new();

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.ConfigureGeneratedCodeAnalysis(flags);
            context.RegisterBoundBodyAction(ctx =>
            {
                if (ctx.OwningFunction is { } function)
                {
                    Owners.Add(function);
                }
                else
                {
                    FieldOwners.Add(ctx.OwningSymbol.Name);
                }

                Bodies[ctx.OwningSymbol.Name] = ctx.Bodies;
            });
        }
    }
}
