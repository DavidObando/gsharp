// <copyright file="AsyncStateMachineRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// First-stage async state-machine lowering orchestrator.
/// </summary>
/// <remarks>
/// This scaffold wires together the already-landed async emit building blocks:
/// it creates the synthesized state-machine type, materializes the field map,
/// allocates deterministic await resume states, and links the kickoff method to
/// its state machine. It intentionally does not rewrite the kickoff body or
/// relax <see cref="AsyncEmitPrecheck"/> yet; later slices consume the returned
/// plans to build the kickoff stub and <c>MoveNext</c> body.
/// </remarks>
public static class AsyncStateMachineRewriter
{
    /// <summary>
    /// Builds state-machine plans for every async function in
    /// <paramref name="program"/>.
    /// </summary>
    /// <param name="program">The bound program to inspect.</param>
    /// <param name="references">The compilation reference resolver.</param>
    /// <returns>A rewrite result containing the original program and one plan
    /// per async function whose builder could be resolved.</returns>
    public static AsyncStateMachineRewriteResult Rewrite(BoundProgram program, ReferenceResolver references)
    {
        if (program == null)
        {
            throw new ArgumentNullException(nameof(program));
        }

        var plans = ImmutableArray.CreateBuilder<AsyncStateMachinePlan>();
        var ordinalsByScopeAndName = new Dictionary<string, int>();

        foreach (var pair in program.Functions.OrderBy(pair => GetFunctionSortKey(program, pair.Key), StringComparer.Ordinal))
        {
            var function = pair.Key;
            if (!function.IsAsync)
            {
                continue;
            }

            // Skip async iterators — they are handled by the async iterator rewriter.
            if (IsAsyncIteratorFunction(function))
            {
                continue;
            }

            var ordinal = AllocateTypeOrdinal(program, function, ordinalsByScopeAndName);

            // Lift awaits out of catch/finally handlers before spilling.
            var exhRewritten = AsyncExceptionHandlerRewriter.Rewrite(pair.Value);

            // Run the spill spiller to lift sub-expression awaits to statement top-level.
            var spilledBody = SpillSequenceSpiller.Rewrite(exhRewritten);

            // Eliminate ref locals (byref pointers) that cannot be hoisted into
            // state-machine fields. Inlines operand expressions at each use site.
            var refHoisted = RefInitializationHoister.Rewrite(spilledBody);

            var stateMachine = AsyncStateMachineTypeBuilder.Build(function, refHoisted, references, ordinal);
            if (stateMachine == null)
            {
                function.StateMachineType = null;
                continue;
            }

            var fieldMap = AsyncStateMachineFieldMap.Create(stateMachine, refHoisted);
            var awaitStates = AwaitStateCollector.Allocate(refHoisted);
            var kickoffPlan = KickoffBodyBuilder.Build(function, fieldMap);
            var moveNextPlan = MoveNextBodyBuilder.Build(refHoisted, awaitStates);
            function.StateMachineType = stateMachine;

            plans.Add(new AsyncStateMachinePlan(function, refHoisted, stateMachine, fieldMap, awaitStates, kickoffPlan, moveNextPlan));
        }

        return new AsyncStateMachineRewriteResult(program, plans.ToImmutable());
    }

    /// <summary>
    /// Builds a state-machine plan for a single async lambda function.
    /// Used by the emitter after closure synthesis has produced the final
    /// lambda body.
    /// </summary>
    /// <param name="function">The lambda's function symbol (must have IsAsync == true).</param>
    /// <param name="body">The lambda body (already closure-rewritten if captures exist).</param>
    /// <param name="references">The compilation reference resolver.</param>
    /// <param name="packageName">The host package name for ordinal allocation.</param>
    /// <returns>A plan, or null if the builder could not be resolved.</returns>
    public static AsyncStateMachinePlan RewriteSingle(
        FunctionSymbol function,
        BoundBlockStatement body,
        ReferenceResolver references,
        string packageName)
    {
        if (function == null || !function.IsAsync)
        {
            return null;
        }

        var ordinalsByScopeAndName = new Dictionary<string, int>();
        var key = (packageName ?? string.Empty) + ":" + function.Name;
        ordinalsByScopeAndName.TryGetValue(key, out var ordinal);
        ordinalsByScopeAndName[key] = ordinal + 1;

        var exhRewritten = AsyncExceptionHandlerRewriter.Rewrite(body);
        var spilledBody = SpillSequenceSpiller.Rewrite(exhRewritten);
        var refHoisted = RefInitializationHoister.Rewrite(spilledBody);

        var stateMachine = AsyncStateMachineTypeBuilder.Build(function, refHoisted, references, ordinal);
        if (stateMachine == null)
        {
            function.StateMachineType = null;
            return null;
        }

        var fieldMap = AsyncStateMachineFieldMap.Create(stateMachine, refHoisted);
        var awaitStates = AwaitStateCollector.Allocate(refHoisted);
        var kickoffPlan = KickoffBodyBuilder.Build(function, fieldMap);
        var moveNextPlan = MoveNextBodyBuilder.Build(refHoisted, awaitStates);
        function.StateMachineType = stateMachine;

        return new AsyncStateMachinePlan(function, refHoisted, stateMachine, fieldMap, awaitStates, kickoffPlan, moveNextPlan);
    }

    private static int AllocateTypeOrdinal(
        BoundProgram program,
        FunctionSymbol function,
        Dictionary<string, int> ordinalsByScopeAndName)
    {
        var packageName = function.Package?.Name ?? program.PackageName ?? string.Empty;
        var key = packageName + ":" + function.Name;
        ordinalsByScopeAndName.TryGetValue(key, out var ordinal);
        ordinalsByScopeAndName[key] = ordinal + 1;
        return ordinal;
    }

    private static string GetFunctionSortKey(BoundProgram program, FunctionSymbol function)
    {
        var packageName = function.Package?.Name ?? program.PackageName ?? string.Empty;
        var parameterTypes = string.Join(",", function.Parameters.Select(parameter => parameter.Type?.Name ?? string.Empty));
        return packageName + ":" + function.Name + ":" + function.Parameters.Length + ":" + parameterTypes;
    }

    private static bool IsAsyncIteratorFunction(FunctionSymbol function)
    {
        var clr = function.Type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return false;
        }

        var def = clr.GetGenericTypeDefinition();
        var fullName = def?.FullName;
        return fullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerator`1";
    }

    private sealed class AwaitStateCollector : BoundTreeWalker
    {
        private readonly ResumableStateAllocator allocator = new();
        private readonly ImmutableDictionary<BoundAwaitExpression, int>.Builder states =
            ImmutableDictionary.CreateBuilder<BoundAwaitExpression, int>();

        public static ImmutableDictionary<BoundAwaitExpression, int> Allocate(BoundStatement body)
        {
            var collector = new AwaitStateCollector();
            collector.Visit(body);
            return collector.states.ToImmutable();
        }

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            states.Add(node, allocator.AllocateAwaitState());
            base.VisitAwaitExpression(node);
        }
    }
}

/// <summary>
/// Result of running the async state-machine rewriter scaffold.
/// </summary>
public sealed class AsyncStateMachineRewriteResult
{
    /// <summary>Initializes a new instance of the <see cref="AsyncStateMachineRewriteResult"/> class.</summary>
    /// <param name="program">The program passed to the rewriter.</param>
    /// <param name="stateMachines">The synthesized state-machine plans.</param>
    public AsyncStateMachineRewriteResult(BoundProgram program, ImmutableArray<AsyncStateMachinePlan> stateMachines)
    {
        Program = program;
        StateMachines = stateMachines;
    }

    /// <summary>Gets the bound program passed to the rewriter.</summary>
    public BoundProgram Program { get; }

    /// <summary>Gets the synthesized state-machine plans.</summary>
    public ImmutableArray<AsyncStateMachinePlan> StateMachines { get; }
}

/// <summary>
/// Captures the synthesized artifacts for one async kickoff method.
/// </summary>
public sealed class AsyncStateMachinePlan
{
    /// <summary>Initializes a new instance of the <see cref="AsyncStateMachinePlan"/> class.</summary>
    /// <param name="kickoffMethod">The original async kickoff method.</param>
    /// <param name="loweredBody">The lowered body that will become <c>MoveNext</c>.</param>
    /// <param name="stateMachine">The synthesized state-machine type.</param>
    /// <param name="fieldMap">The state-machine field map.</param>
    /// <param name="awaitResumeStates">Resume-state numbers keyed by await expression.</param>
    /// <param name="kickoffPlan">The planned kickoff body shape.</param>
    /// <param name="moveNextPlan">The planned <c>MoveNext</c> body shape.</param>
    public AsyncStateMachinePlan(
        FunctionSymbol kickoffMethod,
        BoundBlockStatement loweredBody,
        SynthesizedStateMachineType stateMachine,
        AsyncStateMachineFieldMap fieldMap,
        ImmutableDictionary<BoundAwaitExpression, int> awaitResumeStates,
        KickoffBodyPlan kickoffPlan,
        MoveNextBodyPlan moveNextPlan)
    {
        KickoffMethod = kickoffMethod ?? throw new ArgumentNullException(nameof(kickoffMethod));
        LoweredBody = loweredBody ?? throw new ArgumentNullException(nameof(loweredBody));
        StateMachine = stateMachine ?? throw new ArgumentNullException(nameof(stateMachine));
        FieldMap = fieldMap ?? throw new ArgumentNullException(nameof(fieldMap));
        AwaitResumeStates = awaitResumeStates ?? ImmutableDictionary<BoundAwaitExpression, int>.Empty;
        KickoffPlan = kickoffPlan ?? throw new ArgumentNullException(nameof(kickoffPlan));
        MoveNextPlan = moveNextPlan ?? throw new ArgumentNullException(nameof(moveNextPlan));
    }

    /// <summary>Gets the original async kickoff method.</summary>
    public FunctionSymbol KickoffMethod { get; }

    /// <summary>Gets the lowered body that will become <c>MoveNext</c>.</summary>
    public BoundBlockStatement LoweredBody { get; }

    /// <summary>Gets the synthesized state-machine type.</summary>
    public SynthesizedStateMachineType StateMachine { get; }

    /// <summary>Gets the state-machine field map.</summary>
    public AsyncStateMachineFieldMap FieldMap { get; }

    /// <summary>Gets await resume-state numbers keyed by await expression.</summary>
    public ImmutableDictionary<BoundAwaitExpression, int> AwaitResumeStates { get; }

    /// <summary>Gets the planned kickoff body shape.</summary>
    public KickoffBodyPlan KickoffPlan { get; }

    /// <summary>Gets the planned <c>MoveNext</c> body shape.</summary>
    public MoveNextBodyPlan MoveNextPlan { get; }
}
