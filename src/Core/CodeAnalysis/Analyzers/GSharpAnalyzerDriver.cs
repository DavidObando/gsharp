// <copyright file="GSharpAnalyzerDriver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// Runs <see cref="GSharpDiagnosticAnalyzer"/>s over a bound compilation
/// (ADR-0169). Dispatch order: initialize → compilation-start actions →
/// syntax-tree actions and a kind-bucketed syntax walk per tree → symbol
/// actions over declared symbols → a kind-bucketed bound-tree walk per
/// function body → semantic-model actions per tree → compilation-end and
/// compilation actions. Execution is sequential; an analyzer that throws is
/// disabled for the rest of the run (GS9300), and one that exceeds the
/// optional time budget is disabled with GS9302.
/// </summary>
public sealed class GSharpAnalyzerDriver
{
    private readonly Compilation.Compilation compilation;
    private readonly AnalyzerOptions options;
    private readonly CancellationToken cancellationToken;
    private readonly AnalyzerRegistry registry = new();
    private readonly DiagnosticBag diagnostics = new();
    private readonly HashSet<GSharpDiagnosticAnalyzer> disabled = new();
    private readonly Dictionary<GSharpDiagnosticAnalyzer, Stopwatch> elapsed = new();
    private readonly Dictionary<GSharpDiagnosticAnalyzer, ImmutableHashSet<string>> supportedIds = new();
    private readonly HashSet<(GSharpDiagnosticAnalyzer Owner, string Id)> reportedUnsupported = new();

    private GSharpAnalyzerDriver(Compilation.Compilation compilation, AnalyzerOptions options, CancellationToken cancellationToken)
    {
        this.compilation = compilation;
        this.options = options;
        this.cancellationToken = cancellationToken;
    }

    /// <summary>
    /// Runs the given analyzers over the compilation and returns the
    /// diagnostics they produced (plus any GS93xx host diagnostics). The
    /// compilation's cached <see cref="Compilation.Compilation.BoundProgram"/>
    /// is used, so running after emit does not re-bind.
    /// </summary>
    /// <param name="compilation">The compilation to analyze.</param>
    /// <param name="analyzers">The analyzers to run.</param>
    /// <param name="options">Optional host options.</param>
    /// <param name="cancellationToken">Cancels the run between trees, symbols, and bodies.</param>
    /// <returns>The produced diagnostics, in dispatch order.</returns>
    public static ImmutableArray<Diagnostic> Run(
        Compilation.Compilation compilation,
        ImmutableArray<GSharpDiagnosticAnalyzer> analyzers,
        AnalyzerOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        if (analyzers.IsDefaultOrEmpty)
        {
            return ImmutableArray<Diagnostic>.Empty;
        }

        var driver = new GSharpAnalyzerDriver(compilation, options ?? new AnalyzerOptions(), cancellationToken);
        driver.RunCore(analyzers);
        return driver.diagnostics.ToImmutableArray();
    }

    private void RunCore(ImmutableArray<GSharpDiagnosticAnalyzer> analyzers)
    {
        foreach (var analyzer in analyzers)
        {
            elapsed[analyzer] = new Stopwatch();
            supportedIds[analyzer] = Guarded(analyzer, () => analyzer.SupportedDiagnostics.Select(d => d.Id).ToImmutableHashSet())
                ?? ImmutableHashSet<string>.Empty;
            Guarded(analyzer, () => analyzer.Initialize(new AnalysisContext(registry, analyzer)));
        }

        foreach (var entry in registry.CompilationStartActions.ToArray())
        {
            var context = new CompilationStartAnalysisContext(registry, entry.Owner, compilation, cancellationToken);
            Guarded(entry.Owner, () => entry.Action(context));
        }

        // Force binding once; everything below reads the cached results.
        _ = compilation.GlobalScope;
        var program = compilation.BoundProgram;

        DispatchSyntax();
        DispatchSymbols(program);
        DispatchBoundNodes(program);
        DispatchSemanticModels();

        foreach (var entry in registry.CompilationEndActions.Concat(registry.CompilationActions))
        {
            var context = new CompilationAnalysisContext(compilation, Sink(entry.Owner), cancellationToken);
            Guarded(entry.Owner, () => entry.Action(context));
        }
    }

    private void DispatchSyntax()
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var isGenerated = IsGeneratedTree(tree);

            foreach (var entry in registry.SyntaxTreeActions)
            {
                if (SkipsGenerated(entry.Owner, isGenerated))
                {
                    continue;
                }

                var context = new SyntaxTreeAnalysisContext(tree, Sink(entry.Owner), cancellationToken);
                Guarded(entry.Owner, () => entry.Action(context));
            }

            if (registry.SyntaxNodeActions.Count == 0)
            {
                continue;
            }

            var model = compilation.GetSemanticModel(tree);
            var walker = new DispatchingSyntaxWalker(this, model, isGenerated);
            walker.Visit(tree.Root);
        }
    }

    private void DispatchSymbols(BoundProgram program)
    {
        if (registry.SymbolActions.Count == 0)
        {
            return;
        }

        foreach (var symbol in EnumerateDeclaredSymbols(program))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!registry.SymbolActions.TryGetValue(symbol.Kind, out var entries))
            {
                continue;
            }

            foreach (var entry in entries)
            {
                var context = new SymbolAnalysisContext(symbol, compilation, Sink(entry.Owner), cancellationToken);
                Guarded(entry.Owner, () => entry.Action(context));
            }
        }
    }

    private void DispatchBoundNodes(BoundProgram program)
    {
        if (registry.BoundNodeActions.Count == 0)
        {
            return;
        }

        foreach (var (function, body) in program.Functions)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var isGenerated = function.Declaration is { } declaration && IsGeneratedTree(declaration.SyntaxTree);
            new DispatchingBoundTreeWalker(this, function, isGenerated).Visit(body);
        }

        new DispatchingBoundTreeWalker(this, containingFunction: null, isGenerated: false).Visit(program.Statement);
    }

    private void DispatchSemanticModels()
    {
        if (registry.SemanticModelActions.Count == 0)
        {
            return;
        }

        foreach (var tree in compilation.SyntaxTrees)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var isGenerated = IsGeneratedTree(tree);
            var model = compilation.GetSemanticModel(tree);
            foreach (var entry in registry.SemanticModelActions)
            {
                if (SkipsGenerated(entry.Owner, isGenerated))
                {
                    continue;
                }

                var context = new SemanticModelAnalysisContext(model, Sink(entry.Owner), cancellationToken);
                Guarded(entry.Owner, () => entry.Action(context));
            }
        }
    }

    private static IEnumerable<Symbol> EnumerateDeclaredSymbols(BoundProgram program)
    {
        foreach (var function in program.Functions.Keys)
        {
            yield return function;
        }

        foreach (var global in program.Globals)
        {
            yield return global;
        }

        foreach (var declaredEnum in program.Enums)
        {
            yield return declaredEnum;
        }

        foreach (var declaredDelegate in program.Delegates)
        {
            yield return declaredDelegate;
        }

        foreach (var declaredInterface in program.Interfaces)
        {
            yield return declaredInterface;
        }

        foreach (var declaredStruct in program.Structs)
        {
            yield return declaredStruct;

            foreach (var field in declaredStruct.Fields.Concat(declaredStruct.StaticFields).Concat(declaredStruct.ConstFields))
            {
                yield return field;
            }

            foreach (var property in declaredStruct.Properties.Concat(declaredStruct.StaticProperties))
            {
                yield return property;
            }

            foreach (var declaredEvent in declaredStruct.Events.Concat(declaredStruct.StaticEvents))
            {
                yield return declaredEvent;
            }
        }
    }

    private static bool IsGeneratedTree(SyntaxTree tree)
        => tree.Text.FileName?.EndsWith(".g.gs", StringComparison.OrdinalIgnoreCase) == true;

    private bool SkipsGenerated(GSharpDiagnosticAnalyzer owner, bool isGenerated)
        => isGenerated
           && (!registry.GeneratedCodeFlags.TryGetValue(owner, out var flags)
               || (flags & GeneratedCodeAnalysisFlags.Analyze) == 0);

    private Action<Diagnostic> Sink(GSharpDiagnosticAnalyzer owner)
        => diagnostic => Report(owner, diagnostic);

    private void Report(GSharpDiagnosticAnalyzer owner, Diagnostic diagnostic)
    {
        if (disabled.Contains(owner))
        {
            return;
        }

        if (!supportedIds[owner].Contains(diagnostic.Id))
        {
            if (reportedUnsupported.Add((owner, diagnostic.Id)))
            {
                diagnostics.Report(Diagnostic.Create(
                    DiagnosticDescriptors.AnalyzerUnsupportedDiagnosticId,
                    default,
                    owner.GetType().Name,
                    diagnostic.Id));
            }

            return;
        }

        if (diagnostic.Descriptor is { IsEnabledByDefault: false })
        {
            return;
        }

        if (diagnostic.Location.Text is { FileName: { } fileName }
            && fileName.EndsWith(".g.gs", StringComparison.OrdinalIgnoreCase)
            && (!registry.GeneratedCodeFlags.TryGetValue(owner, out var flags)
                || (flags & GeneratedCodeAnalysisFlags.ReportDiagnostics) == 0))
        {
            return;
        }

        diagnostics.Report(diagnostic);
    }

    private void Guarded(GSharpDiagnosticAnalyzer owner, Action action)
        => Guarded<object?>(owner, () =>
        {
            action();
            return null;
        });

    private T? Guarded<T>(GSharpDiagnosticAnalyzer owner, Func<T> action)
    {
        if (disabled.Contains(owner))
        {
            return default;
        }

        var watch = elapsed[owner];
        watch.Start();
        try
        {
            return action();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            disabled.Add(owner);
            diagnostics.Report(Diagnostic.Create(
                DiagnosticDescriptors.AnalyzerThrewException,
                default,
                owner.GetType().Name,
                ex.GetType().Name,
                ex.Message));
            return default;
        }
        finally
        {
            watch.Stop();
            if (options.TimeBudgetMilliseconds is { } budget
                && watch.ElapsedMilliseconds > budget
                && disabled.Add(owner))
            {
                diagnostics.Report(Diagnostic.Create(
                    DiagnosticDescriptors.AnalyzerExceededTimeBudget,
                    default,
                    owner.GetType().Name,
                    budget));
            }
        }
    }

    /// <summary>
    /// Walks a syntax tree dispatching node actions from the registry's
    /// kind buckets.
    /// </summary>
    private sealed class DispatchingSyntaxWalker : GSharpSyntaxWalker
    {
        private readonly GSharpAnalyzerDriver driver;
        private readonly SemanticModel model;
        private readonly bool isGenerated;

        public DispatchingSyntaxWalker(GSharpAnalyzerDriver driver, SemanticModel model, bool isGenerated)
        {
            this.driver = driver;
            this.model = model;
            this.isGenerated = isGenerated;
        }

        public override void Visit(SyntaxNode? node)
        {
            if (node is not null and not SyntaxToken
                && driver.registry.SyntaxNodeActions.TryGetValue(node.Kind, out var entries))
            {
                foreach (var entry in entries)
                {
                    if (driver.SkipsGenerated(entry.Owner, isGenerated))
                    {
                        continue;
                    }

                    var context = new SyntaxNodeAnalysisContext(node, model, driver.Sink(entry.Owner), driver.cancellationToken);
                    driver.Guarded(entry.Owner, () => entry.Action(context));
                }
            }

            base.Visit(node);
        }
    }

    /// <summary>
    /// Walks a bound body dispatching bound-node actions from the registry's
    /// kind buckets.
    /// </summary>
    private sealed class DispatchingBoundTreeWalker : BoundTreeWalker
    {
        private readonly GSharpAnalyzerDriver driver;
        private readonly FunctionSymbol? containingFunction;
        private readonly bool isGenerated;

        public DispatchingBoundTreeWalker(GSharpAnalyzerDriver driver, FunctionSymbol? containingFunction, bool isGenerated)
        {
            this.driver = driver;
            this.containingFunction = containingFunction;
            this.isGenerated = isGenerated;
        }

        // Dispatch happens in the three typed dispatchers only; overriding
        // Visit as well would double-dispatch the root of each walk (Visit
        // forwards to VisitStatement/VisitExpression/VisitPattern).
        public override void VisitStatement(BoundStatement? node)
        {
            Dispatch(node);
            base.VisitStatement(node);
        }

        public override void VisitExpression(BoundExpression? node)
        {
            Dispatch(node);
            base.VisitExpression(node);
        }

        public override void VisitPattern(BoundPattern? node)
        {
            Dispatch(node);
            base.VisitPattern(node);
        }

        private void Dispatch(BoundNode? node)
        {
            if (node is null || !driver.registry.BoundNodeActions.TryGetValue(node.Kind, out var entries))
            {
                return;
            }

            foreach (var entry in entries)
            {
                if (driver.SkipsGenerated(entry.Owner, isGenerated))
                {
                    continue;
                }

                var context = new BoundNodeAnalysisContext(node, containingFunction, driver.compilation, driver.Sink(entry.Owner), driver.cancellationToken);
                driver.Guarded(entry.Owner, () => entry.Action(context));
            }
        }
    }
}
