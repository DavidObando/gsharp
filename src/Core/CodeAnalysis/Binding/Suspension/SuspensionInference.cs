// <copyright file="SuspensionInference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding.Suspension;

/// <summary>
/// ADR-0174 D4: the coloring is <em>inferred</em>. After every body is bound,
/// this pass finds the functions that perform a suspension point — a channel
/// operation, or a call to a function that suspends — and marks them
/// <see cref="SuspendingKind.Inferred"/>, iterating to a fixed point over the
/// call graph so mutual recursion converges. It then rewrites every body so a
/// call to a newly-suspending function is typed <c>ValueTask[R]</c> and
/// completed the way the binder completes a call to a declared
/// <c>suspend func</c>: an implicit await inside a suspending or <c>async</c>
/// body, a blocking root bridge (GS0558) elsewhere.
/// </summary>
/// <remarks>
/// <para>Inference stops at the ADR's boundaries: the synthesized entry point
/// (the root that blocks once), <c>async</c> functions (their task is
/// observable), virtual, abstract and overriding methods, interface members
/// and their implementations, constructors, accessors, operators, P/Invoke
/// stubs, <c>unsafe</c> functions and bodies containing a <c>fixed</c> pin (raw
/// pointers cannot live in a state machine), iterators, <c>Dispose</c>, and
/// function literals. A suspension
/// point inside one of those keeps the blocking lowering; GS0558 names the
/// residual blocking bridges. A <c>go</c> operand does not color its caller,
/// and a channel operation inside a <c>lock</c> body does not either (the
/// monitor is thread-affine).</para>
/// <para>Discrimination witnesses (ADR-0154): a mutant that runs a single
/// pass instead of iterating breaks
/// <c>SuspensionInferenceTests.MutualRecursion_Converges</c>; a mutant that
/// colors through a <c>go</c> operand breaks
/// <c>SuspensionInferenceTests.GoOperand_DoesNotColorTheCaller</c>; a mutant
/// that skips the lambda-body rewrite breaks
/// <c>Adr0174InferredSuspensionEmitTests.Lambda_CallingAnInferredFunction_Runs</c>.</para>
/// </remarks>
internal static class SuspensionInference
{
    /// <summary>Runs inference and the call rewrite over a bound program's bodies.</summary>
    /// <param name="bodies">Every function body, keyed by symbol; rewritten in place.</param>
    /// <param name="entryPoint">The program's entry point — synthesized or a user <c>Main</c> — which is the root that blocks and never suspends.</param>
    /// <param name="references">The compilation's reference resolver; when the channel runtime does not resolve nothing can suspend and the pass is a no-op.</param>
    /// <param name="diagnostics">Receives GS0558 and the re-run async analyses' diagnostics.</param>
    /// <returns>The set of functions the pass marked <see cref="SuspendingKind.Inferred"/>.</returns>
    public static ImmutableHashSet<FunctionSymbol> Run(
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder bodies,
        FunctionSymbol? entryPoint,
        ReferenceResolver? references,
        ImmutableArray<Diagnostic>.Builder diagnostics)
    {
        if (references == null)
        {
            return ImmutableHashSet<FunctionSymbol>.Empty;
        }

        var runtime = new ChannelRuntimeBinder(references);
        if (!runtime.IsAvailable)
        {
            return ImmutableHashSet<FunctionSymbol>.Empty;
        }

        var ordered = bodies.Keys.OrderBy(SortKey, StringComparer.Ordinal).ToList();
        var facts = new Dictionary<FunctionSymbol, SuspensionPointCollector.Facts>();
        foreach (var function in ordered)
        {
            facts[function] = SuspensionPointCollector.Collect(bodies[function]);
        }

        var inferred = new HashSet<FunctionSymbol>();
        var changed = true;
        while (changed)
        {
            changed = false;
            foreach (var function in ordered)
            {
                if (function.IsSuspending || function.IsAsync || ReferenceEquals(function, entryPoint) || IsBoundary(function, bodies[function]))
                {
                    continue;
                }

                var own = facts[function];
                if (own.HasDirectPoint || own.Callees.Any(static callee => callee.IsSuspending))
                {
                    function.SuspendingKind = SuspendingKind.Inferred;
                    function.AsyncReturnsValueTask = true;
                    inferred.Add(function);
                    changed = true;
                }
            }
        }

        var bag = new DiagnosticBag();
        var newlySuspending = inferred.ToImmutableHashSet();
        foreach (var function in ordered)
        {
            var body = bodies[function];
            var rewritten = SuspendingCallRewriter.Rewrite(body, function, ReferenceEquals(function, entryPoint), newlySuspending, runtime, bag);
            if (!ReferenceEquals(rewritten, body))
            {
                SyntaxAnchoringWalker.Anchor(rewritten, function.Declaration);
                bodies[function] = rewritten;
            }

            if (newlySuspending.Contains(function))
            {
                // The async-only analyses ran while this body was still plain.
                RefStructAsyncLivenessAnalyzer.Analyze(rewritten.PreEmitAnalysisBody ?? rewritten, function, bag);
            }
        }

        diagnostics.AddRange(bag);
        return newlySuspending;
    }

    /// <summary>ADR-0174 D4 "where inference stops": functions whose signature inference may not change.</summary>
    /// <param name="function">The function.</param>
    /// <param name="body">Its bound body.</param>
    /// <returns><see langword="true"/> when the function keeps its declared coloring whatever its body does.</returns>
    internal static bool IsBoundary(FunctionSymbol function, BoundBlockStatement body)
    {
        if (function.IsTopLevelEntryPoint
            || function.Declaration == null
            || function.IsOpen
            || function.IsOverride
            || function.IsAbstract
            || function.IsPInvoke
            || function.IsUnsafe
            || function.IsSpecialName
            || function.OverriddenMethod != null
            || function.ExternalOverriddenMethod != null
            || function.ExplicitInterfaceMember != null
            || function.ExplicitInterfaceSlot != null)
        {
            return true;
        }

        var name = function.Name;
        if (name == ".ctor"
            || name.StartsWith("get_", StringComparison.Ordinal)
            || name.StartsWith("set_", StringComparison.Ordinal)
            || name.StartsWith("op_", StringComparison.Ordinal)
            || name.StartsWith("add_", StringComparison.Ordinal)
            || name.StartsWith("remove_", StringComparison.Ordinal))
        {
            return true;
        }

        if (function.IsInstanceMethod && name == "Dispose" && function.Parameters.IsDefaultOrEmpty)
        {
            return true;
        }

        if (function.ReceiverType is InterfaceSymbol)
        {
            return true;
        }

        // An implementation of an interface member occupies a slot whose
        // signature the interface fixed; a same-named, same-arity method on a
        // type that implements that interface is treated as that slot.
        if (function.ReceiverType is StructSymbol owner && ImplementsInterfaceMember(owner, function))
        {
            return true;
        }

        return IteratorDetection.ContainsYield(body) || ContainsFixed(body);
    }

    private static bool ContainsFixed(BoundStatement body)
    {
        var finder = new FixedFinder();
        finder.Visit(body);
        return finder.Found;
    }

    private static bool ImplementsInterfaceMember(StructSymbol owner, FunctionSymbol function)
    {
        foreach (var iface in owner.Interfaces)
        {
            foreach (var method in iface.Methods)
            {
                if (method.Name == function.Name && method.Parameters.Length == function.Parameters.Length)
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static string SortKey(FunctionSymbol function)
    {
        var parameterTypes = string.Join(",", function.Parameters.Select(static p => p.Type?.Name ?? string.Empty));
        return (function.Package?.Name ?? string.Empty) + ":" + (function.ReceiverType?.Name ?? string.Empty) + ":" + function.Name + ":" + function.Parameters.Length + ":" + parameterTypes;
    }

    private sealed class FixedFinder : BoundTreeWalker
    {
        public bool Found { get; private set; }

        protected override void VisitFixedStatement(BoundFixedStatement node)
        {
            Found = true;
            base.VisitFixedStatement(node);
        }
    }
}
