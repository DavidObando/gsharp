// <copyright file="Adr0169AnalyzerDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
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
/// Covers the ADR-0169 <see cref="GSharpAnalyzerDriver"/>: per-kind dispatch,
/// crash containment (GS9300), unsupported-ID suppression (GS9304),
/// disabled-by-default filtering, generated-code skipping, time budget
/// (GS9302), and cancellation.
/// </summary>
public class Adr0169AnalyzerDriverTests
{
    private const string Source = @"package App
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
";

    private static readonly DiagnosticDescriptor ProbeRule = new(
        "PROBE001", "Probe", "Probe hit '{0}'.", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    private static readonly DiagnosticDescriptor DisabledRule = new(
        "PROBE002", "Disabled probe", "Should never surface.", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: false);

    [Fact]
    public void SyntaxNodeAction_FiresPerMatchingKind_WithSemanticModel()
    {
        var probe = new SyntaxProbeAnalyzer();

        var produced = Run(Source, probe);

        Assert.Equal(2, probe.Nodes.Count);
        Assert.All(probe.Nodes, n => Assert.Equal(SyntaxKind.CallExpression, n.Kind));
        Assert.Equal(2, produced.Count(d => d.Id == "PROBE001"));
        Assert.True(probe.SawSemanticModel);
    }

    [Fact]
    public void SymbolAction_FiresForFunctionsAndFields()
    {
        var probe = new SymbolProbeAnalyzer();

        Run(Source, probe);

        Assert.Contains("Add", probe.FunctionNames);
        Assert.Contains("Main", probe.FunctionNames);
        Assert.Contains("entries", probe.FieldNames);
    }

    [Fact]
    public void BoundNodeAction_FiresForCallExpressions()
    {
        var probe = new BoundNodeProbeAnalyzer();

        Run(Source, probe);

        Assert.True(probe.CallCount >= 1);
        Assert.Contains(probe.ContainingFunctions, name => name == "Main");
    }

    [Fact]
    public void TreeSemanticModelAndCompilationActions_FireInOrder()
    {
        var probe = new LifecycleProbeAnalyzer();

        Run(Source, probe);

        Assert.Equal(new[] { "start", "tree", "semanticModel", "end", "compilation" }, probe.Events);
    }

    [Fact]
    public void ThrowingAnalyzer_IsDisabledWithGs9300_AndSiblingContinues()
    {
        var throwing = new ThrowingAnalyzer();
        var sibling = new SyntaxProbeAnalyzer();

        var produced = Run(Source, throwing, sibling);

        Assert.Single(produced.Where(d => d.Id == "GS9300"));
        Assert.Equal(1, throwing.Invocations);
        Assert.Equal(2, sibling.Nodes.Count);
    }

    [Fact]
    public void UnsupportedDiagnosticId_IsSuppressedWithGs9304()
    {
        var produced = Run(Source, new UnsupportedIdAnalyzer());

        Assert.Single(produced.Where(d => d.Id == "GS9304"));
        Assert.DoesNotContain(produced, d => d.Id == "ROGUE001");
    }

    [Fact]
    public void DisabledByDefaultRule_IsDropped()
    {
        var produced = Run(Source, new DisabledRuleAnalyzer());

        Assert.DoesNotContain(produced, d => d.Id == "PROBE002");
    }

    [Fact]
    public void GeneratedTree_IsSkipped_UnlessAnalyzeFlagSet()
    {
        var silent = new SyntaxProbeAnalyzer();
        RunWithFileName(Source, "app.g.gs", silent);
        Assert.Empty(silent.Nodes);

        var analyzing = new SyntaxProbeAnalyzer(GeneratedCodeAnalysisFlags.Analyze);
        var produced = RunWithFileName(Source, "app.g.gs", analyzing);
        Assert.Equal(2, analyzing.Nodes.Count);

        // Analyze without ReportDiagnostics: callbacks ran, reports suppressed.
        Assert.DoesNotContain(produced, d => d.Id == "PROBE001");
    }

    [Fact]
    public void TimeBudget_DisablesSlowAnalyzer_WithGs9302()
    {
        var tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"));
        var compilation = new Compilation(tree);

        var produced = GSharpAnalyzerDriver.Run(
            compilation,
            ImmutableArray.Create<GSharpDiagnosticAnalyzer>(new SlowAnalyzer()),
            new AnalyzerOptions { TimeBudgetMilliseconds = 1 });

        Assert.Single(produced.Where(d => d.Id == "GS9302"));
    }

    [Fact]
    public void PreCancelledToken_CancelsTheRun()
    {
        var tree = SyntaxTree.Parse(SourceText.From(Source, "app.gs"));
        var compilation = new Compilation(tree);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Assert.ThrowsAny<OperationCanceledException>(() => GSharpAnalyzerDriver.Run(
            compilation,
            ImmutableArray.Create<GSharpDiagnosticAnalyzer>(new SyntaxProbeAnalyzer()),
            cancellationToken: cts.Token));
    }

    private static ImmutableArray<Diagnostic> Run(string source, params GSharpDiagnosticAnalyzer[] analyzers)
        => RunWithFileName(source, "app.gs", analyzers);

    private static ImmutableArray<Diagnostic> RunWithFileName(string source, string fileName, params GSharpDiagnosticAnalyzer[] analyzers)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, fileName));
        var compilation = new Compilation(tree);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
        return GSharpAnalyzerDriver.Run(compilation, analyzers.ToImmutableArray());
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class SyntaxProbeAnalyzer : GSharpDiagnosticAnalyzer
    {
        private readonly GeneratedCodeAnalysisFlags flags;

        public SyntaxProbeAnalyzer()
            : this(GeneratedCodeAnalysisFlags.None)
        {
        }

        public SyntaxProbeAnalyzer(GeneratedCodeAnalysisFlags flags) => this.flags = flags;

        public List<SyntaxNode> Nodes { get; } = new();

        public bool SawSemanticModel { get; private set; }

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.ConfigureGeneratedCodeAnalysis(flags);
            context.EnableConcurrentExecution();
            context.RegisterSyntaxNodeAction(
                ctx =>
                {
                    Nodes.Add(ctx.Node);
                    SawSemanticModel |= ctx.SemanticModel is not null;
                    ctx.ReportDiagnostic(Diagnostic.Create(ProbeRule, ctx.Node.Location, ctx.Node.Kind));
                },
                SyntaxKind.CallExpression);
        }
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class SymbolProbeAnalyzer : GSharpDiagnosticAnalyzer
    {
        public List<string> FunctionNames { get; } = new();

        public List<string> FieldNames { get; } = new();

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSymbolAction(
                ctx =>
                {
                    if (ctx.Symbol is FunctionSymbol)
                    {
                        FunctionNames.Add(ctx.Symbol.Name);
                    }
                    else
                    {
                        FieldNames.Add(ctx.Symbol.Name);
                    }
                },
                SymbolKind.Function,
                SymbolKind.Field);
        }
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class BoundNodeProbeAnalyzer : GSharpDiagnosticAnalyzer
    {
        public int CallCount { get; private set; }

        public List<string> ContainingFunctions { get; } = new();

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.RegisterBoundNodeAction(
                ctx =>
                {
                    CallCount++;
                    if (ctx.ContainingFunction is { } function)
                    {
                        ContainingFunctions.Add(function.Name);
                    }
                },
                BoundNodeKind.CallExpression);
        }
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class LifecycleProbeAnalyzer : GSharpDiagnosticAnalyzer
    {
        public List<string> Events { get; } = new();

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.RegisterCompilationStartAction(startCtx =>
            {
                Events.Add("start");
                startCtx.RegisterCompilationEndAction(_ => Events.Add("end"));
            });
            context.RegisterSyntaxTreeAction(_ => Events.Add("tree"));
            context.RegisterSemanticModelAction(_ => Events.Add("semanticModel"));
            context.RegisterCompilationAction(_ => Events.Add("compilation"));
        }
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class ThrowingAnalyzer : GSharpDiagnosticAnalyzer
    {
        public int Invocations { get; private set; }

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSyntaxNodeAction(
                _ =>
                {
                    Invocations++;
                    throw new InvalidOperationException("boom");
                },
                SyntaxKind.CallExpression);
        }
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class UnsupportedIdAnalyzer : GSharpDiagnosticAnalyzer
    {
        private static readonly DiagnosticDescriptor Rogue = new(
            "ROGUE001", "Rogue", "Undeclared rule.", "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSyntaxNodeAction(
                ctx => ctx.ReportDiagnostic(Diagnostic.Create(Rogue, ctx.Node.Location)),
                SyntaxKind.CallExpression);
        }
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class DisabledRuleAnalyzer : GSharpDiagnosticAnalyzer
    {
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(DisabledRule);

        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSyntaxNodeAction(
                ctx => ctx.ReportDiagnostic(Diagnostic.Create(DisabledRule, ctx.Node.Location)),
                SyntaxKind.CallExpression);
        }
    }

    [GSharpDiagnosticAnalyzer]
    private sealed class SlowAnalyzer : GSharpDiagnosticAnalyzer
    {
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(ProbeRule);

        public override void Initialize(AnalysisContext context)
        {
            context.RegisterSyntaxTreeAction(_ => Thread.Sleep(25));
        }
    }
}
