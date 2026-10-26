// <copyright file="AsyncStateMachineRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// First-stage async state-machine lowering orchestrator.
/// @remarks This scaffold wires together the already-landed async emit building blocks:
/// it creates the synthesized state-machine type, materializes the field map,
/// allocates deterministic await resume states, and links the kickoff method to
/// its state machine. It intentionally does not rewrite the kickoff body or
/// relax (cref:AsyncEmitPrecheck) yet; later slices consume the returned
/// plans to build the kickoff stub and `MoveNext` body.
shared class AsyncStateMachineRewriter {
    // Liveness diagnostics and emission must see the same explicit and implicit suspension points.
    internal func PrepareBody(body BoundBlockStatement, references ReferenceResolver?) BoundBlockStatement {
        let channelAwaited = ChannelOperationRewriter.Rewrite(body, references)
        let exhRewritten = AsyncExceptionHandlerRewriter.Rewrite(channelAwaited)
        return SpillSequenceSpiller.Rewrite(exhRewritten)
    }

    private class AwaitStateCollector : BoundTreeWalker {
        private let allocator ResumableStateAllocator = ResumableStateAllocator()
        private let states ImmutableDictionary[BoundAwaitExpression, int32].Builder = ImmutableDictionary.CreateBuilder[
            BoundAwaitExpression,
            int32
        ]()

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            states.Add(node, allocator.AllocateAwaitState())
            base.VisitAwaitExpression(node)
        }

        shared {
            func Allocate(body BoundStatement) ImmutableDictionary[BoundAwaitExpression, int32] {
                let collector = AsyncStateMachineRewriter.AwaitStateCollector()
                collector.Visit(body)
                return collector.states.ToImmutable()
            }
        }
    }

    /// Builds state-machine plans for every async function in
    /// [`program`](paramref).
    /// @param program The bound program to inspect.
    /// @param references The compilation reference resolver, or
    /// `null` when none is available, in which case no builder
    /// resolves and no plan is produced.
    /// @returns A rewrite result containing the original program and one plan
    /// per async function whose builder could be resolved.
    func Rewrite(program BoundProgram?, references ReferenceResolver?) AsyncStateMachineRewriteResult {
        if program == nil {
            throw ArgumentNullException("program")
        }
        let plans = ImmutableArray.CreateBuilder[AsyncStateMachinePlan]()
        let ordinalsByScopeAndName = Dictionary[string, int32]()
        // Issue #4663: the key ties for same-named, same-signature methods on
        // different types; break ties in source order, never hash order.
        for pair in program
            .Functions
            .OrderBy(
            (pair KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> GetFunctionSortKey(program, pair.Key),
            StringComparer.Ordinal
        )
            .ThenBy(
            (pair KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> pair.Key,
            SymbolSourceOrderComparer.Instance
        ) {
            let function = pair.Key
            if !function.IsAsyncOrSuspending {
                continue
            }
            // Skip async iterators — they are handled by the async iterator rewriter.
            if AsyncIteratorDetection.IsAsyncIteratorFunction(function, pair.Value) {
                continue
            }
            let ordinal = AllocateTypeOrdinal(program, function, ordinalsByScopeAndName)
            let spilledBody = PrepareBody(pair.Value, references)
            // Eliminate ref locals (byref pointers) that cannot be hoisted into
            // state-machine fields. Inlines operand expressions at each use site.
            let refHoisted = RefInitializationHoister.Rewrite(spilledBody)
            let stateMachine SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(
                function,
                refHoisted,
                references,
                ordinal
            )
            if stateMachine == nil {
                function.StateMachineType = nil
                continue
            }
            let fieldMap = AsyncStateMachineFieldMap.Create(stateMachine, refHoisted)
            let awaitStates = AsyncStateMachineRewriter.AwaitStateCollector.Allocate(refHoisted)
            let kickoffPlan = KickoffBodyBuilder.Build(function, fieldMap)
            let moveNextPlan = MoveNextBodyBuilder.Build(refHoisted, awaitStates)
            function.StateMachineType = stateMachine
            plans.Add(
                AsyncStateMachinePlan(
                    function,
                    refHoisted,
                    stateMachine,
                    fieldMap,
                    awaitStates,
                    kickoffPlan,
                    moveNextPlan
                )
            )
        }
        return AsyncStateMachineRewriteResult(program, plans.ToImmutable())
    }

    /// Builds a state-machine plan for a single async lambda function.
    /// Used by the emitter after closure synthesis has produced the final
    /// lambda body.
    /// @param function The lambda's function symbol (must have IsAsync == true).
    /// @param body The lambda body (already closure-rewritten if captures exist).
    /// @param references The compilation reference resolver.
    /// @param packageName The host package name for ordinal allocation.
    /// @returns A plan, or null if the builder could not be resolved.
    func RewriteSingle(
        function FunctionSymbol?,
        body BoundBlockStatement,
        references ReferenceResolver?,
        packageName string
    ) AsyncStateMachinePlan? {
        if function == nil || !function.IsAsyncOrSuspending {
            return nil
        }
        let ordinalsByScopeAndName = Dictionary[string, int32]()
        let key = (packageName ?? string.Empty) + ":" + function.Name
        ordinalsByScopeAndName.TryGetValue(key, out var ordinal)
        ordinalsByScopeAndName[key] = ordinal + 1
        let spilledBody = PrepareBody(body, references)
        let refHoisted = RefInitializationHoister.Rewrite(spilledBody)
        let stateMachine SynthesizedStateMachineType? = AsyncStateMachineTypeBuilder.Build(
            function,
            refHoisted,
            references,
            ordinal
        )
        if stateMachine == nil {
            function.StateMachineType = nil
            return nil
        }
        let fieldMap = AsyncStateMachineFieldMap.Create(stateMachine, refHoisted)
        let awaitStates = AsyncStateMachineRewriter.AwaitStateCollector.Allocate(refHoisted)
        let kickoffPlan = KickoffBodyBuilder.Build(function, fieldMap)
        let moveNextPlan = MoveNextBodyBuilder.Build(refHoisted, awaitStates)
        function.StateMachineType = stateMachine
        return AsyncStateMachinePlan(
            function,
            refHoisted,
            stateMachine,
            fieldMap,
            awaitStates,
            kickoffPlan,
            moveNextPlan
        )
    }

    private func AllocateTypeOrdinal(
        program BoundProgram,
        function FunctionSymbol,
        ordinalsByScopeAndName Dictionary[string, int32]
    ) int32 {
        let packageName = function.Package?.Name ?? program.PackageName ?? string.Empty
        let key = packageName + ":" + function.Name
        ordinalsByScopeAndName.TryGetValue(key, out var ordinal)
        ordinalsByScopeAndName[key] = ordinal + 1
        return ordinal
    }

    private func GetFunctionSortKey(program BoundProgram, function FunctionSymbol) string {
        let packageName = function.Package?.Name ?? program.PackageName ?? string.Empty
        let parameterTypes = string.Join(
            ",",
            function.Parameters.Select((parameter ParameterSymbol) -> parameter.Type?.Name ?? string.Empty)
        )
        return packageName + ":" + function.Name + ":" + function.Parameters.Length.ToString() + ":" + parameterTypes
    }
}

/// Result of running the async state-machine rewriter scaffold.
class AsyncStateMachineRewriteResult {
    /// Initializes a new instance of the (cref:AsyncStateMachineRewriteResult) class.
    /// @param program The program passed to the rewriter.
    /// @param stateMachines The synthesized state-machine plans.
    init(program BoundProgram, stateMachines ImmutableArray[AsyncStateMachinePlan]) {
        Program = program
        StateMachines = stateMachines
    }

    /// Gets the bound program passed to the rewriter.
    prop Program BoundProgram {
        get;
    }

    /// Gets the synthesized state-machine plans.
    prop StateMachines ImmutableArray[AsyncStateMachinePlan] {
        get;
    }
}

/// Captures the synthesized artifacts for one async kickoff method.
class AsyncStateMachinePlan {
    /// Initializes a new instance of the (cref:AsyncStateMachinePlan) class.
    /// @param kickoffMethod The original async kickoff method.
    /// @param loweredBody The lowered body that will become `MoveNext`.
    /// @param stateMachine The synthesized state-machine type.
    /// @param fieldMap The state-machine field map.
    /// @param awaitResumeStates Resume-state numbers keyed by await expression.
    /// @param kickoffPlan The planned kickoff body shape.
    /// @param moveNextPlan The planned `MoveNext` body shape.
    init(
        kickoffMethod FunctionSymbol,
        loweredBody BoundBlockStatement,
        stateMachine SynthesizedStateMachineType,
        fieldMap AsyncStateMachineFieldMap,
        awaitResumeStates ImmutableDictionary[BoundAwaitExpression, int32],
        kickoffPlan KickoffBodyPlan,
        moveNextPlan MoveNextBodyPlan
    ) {
        KickoffMethod = kickoffMethod ?? throw ArgumentNullException("kickoffMethod")
        LoweredBody = loweredBody ?? throw ArgumentNullException("loweredBody")
        StateMachine = stateMachine ?? throw ArgumentNullException("stateMachine")
        FieldMap = fieldMap ?? throw ArgumentNullException("fieldMap")
        AwaitResumeStates = awaitResumeStates ?? ImmutableDictionary[BoundAwaitExpression, int32].Empty
        KickoffPlan = kickoffPlan ?? throw ArgumentNullException("kickoffPlan")
        MoveNextPlan = moveNextPlan ?? throw ArgumentNullException("moveNextPlan")
    }

    /// Gets the original async kickoff method.
    prop KickoffMethod FunctionSymbol {
        get;
    }

    /// Gets the lowered body that will become `MoveNext`.
    prop LoweredBody BoundBlockStatement {
        get;
    }

    /// Gets the synthesized state-machine type.
    prop StateMachine SynthesizedStateMachineType {
        get;
    }

    /// Gets the state-machine field map.
    prop FieldMap AsyncStateMachineFieldMap {
        get;
    }

    /// Gets await resume-state numbers keyed by await expression.
    prop AwaitResumeStates ImmutableDictionary[BoundAwaitExpression, int32] {
        get;
    }

    /// Gets the planned kickoff body shape.
    prop KickoffPlan KickoffBodyPlan {
        get;
    }

    /// Gets the planned `MoveNext` body shape.
    prop MoveNextPlan MoveNextBodyPlan {
        get;
    }
}
