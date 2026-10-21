// <copyright file="IteratorRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Iterators

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq

/// Rewrites iterator functions (those containing `yield` statements) into
/// state-machine classes implementing `IEnumerable<T>` and
/// `IEnumerator<T>` (ADR-0040).
shared class IteratorRewriter {
    private class NestedIteratorCollector : NestedFunctionBodyRewriter {
        private let plans ImmutableArray[IteratorStateMachinePlan].Builder

        init(plans ImmutableArray[IteratorStateMachinePlan].Builder) {
            this.plans = plans
        }

        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            IteratorRewriter.AddPlan(node.Function, node.Body, this.plans)
            return base.RewriteFunctionLiteralExpression(node)
        }
    }

    private class YieldStateCollector : BoundTreeWalker {
        private let states ImmutableDictionary[BoundYieldStatement, int32].Builder = ImmutableDictionary.CreateBuilder[
            BoundYieldStatement,
            int32
        ]()
        private var nextState int32 = 1
        prop States ImmutableDictionary[BoundYieldStatement, int32] -> states.ToImmutable()

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            states.Add(node, nextState)
            nextState++
        }
    }

    private class LocalCollector : BoundTreeWalker {
        init() {
            Locals = List[VariableSymbol]()
        }

        prop Locals List[VariableSymbol] {
            get;
        }

        protected override func VisitTypePattern(node BoundTypePattern) {
            if node.HasBinding {
                Add(node.Variable)
            }
            base.VisitTypePattern(node)
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            // Skip ref-struct (ByRef-like) locals — e.g. the synthesized
            // DefaultInterpolatedStringHandler emitted for interpolated strings
            // (ADR-0055 / issue #368). A ByRef-like type cannot be an instance
            // field, so it must stay a MoveNext local rather than be hoisted.
            // Issue #1919: use the metadata-load-safe TypeSymbol.IsByRefLike
            // helper — a raw Type.IsByRefLike read throws NotSupportedException
            // for a cross-context TypeBuilderInstantiation (e.g. a delegate
            // local closed over a MetadataLoadContext type under gsc's
            // `/reference:` mode).
            Add(node.Variable)
            base.VisitVariableDeclaration(node)
        }

        protected override func VisitAddressOfExpression(node BoundAddressOfExpression) {
            if node.Operand is BoundVariableExpression variable &&
                !(variable.Variable is ParameterSymbol) &&
                !TypeSymbol.IsByRefLike(variable.Variable.Type) {
                Add(variable.Variable)
            }
            base.VisitAddressOfExpression(node)
        }

        private func Add(variable VariableSymbol) {
            // Issue #4222: a native `let ref`/`var ref` alias local
            // (RefKind != None) is excluded from hoisting for the same
            // reason a by-ref-like local is — its CLR local slot is a
            // managed pointer (see SlotPlanner), which the CLR forbids as a
            // state-machine field. RefStructAsyncLivenessAnalyzer proves at
            // bind time that it is never live across a `yield`, so leaving
            // it un-hoisted (a plain MoveNext-body local) is safe.
            let isNativeRefAlias = variable is LocalVariableSymbol local && local.RefKind != RefKind.None
            if !TypeSymbol.IsByRefLike(variable.Type) && !isNativeRefAlias && !Locals.Contains(variable) {
                Locals.Add(variable)
            }
        }
    }

    /// Scans the bound program for iterator functions and builds rewrite plans.
    /// @param program The bound program.
    /// @returns The rewrite result containing plans for each iterator function.
    func Rewrite(program BoundProgram?) IteratorRewriteResult {
        if program == nil {
            throw ArgumentNullException("program")
        }
        let plans = ImmutableArray.CreateBuilder[IteratorStateMachinePlan]()
        let nestedCollector = NestedIteratorCollector(plans)
        // Issue #4663: the name order ties for same-named functions; break ties stably.
        for pair in program
            .Functions
            .OrderBy((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name, StringComparer.Ordinal)
            .ThenBy(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key,
            SymbolSourceOrderComparer.Instance
        ) {
            let function = pair.Key
            let body = pair.Value
            AddPlan(function, body, plans)
            nestedCollector.RewriteStatement(body)
        }
        return IteratorRewriteResult(program, plans.ToImmutable())
    }

    internal func TryBuildPlan(
        function FunctionSymbol,
        body BoundBlockStatement,
        @NotNullWhen(true) out plan IteratorStateMachinePlan?
    ) bool {
        let elementType TypeSymbol? = GetIteratorElementType(function.Type, out _)
        if !IteratorDetection.ContainsYield(body) || AsyncIteratorDetection.IsAsyncIteratorFunction(function, body) ||
            elementType == nil {
            plan = nil
            return false
        }
        let spilledBody = SpillSequenceSpiller.RewriteIteratorBlocks(body)
        plan = BuildPlan(function, spilledBody, elementType)
        return true
    }

    private func AddPlan(
        function FunctionSymbol,
        body BoundBlockStatement,
        plans ImmutableArray[IteratorStateMachinePlan].Builder
    ) {
        if TryBuildPlan(function, body, out var plan) {
            plans.Add(plan)
        }
    }

    internal func ReturnsEnumerable(type TypeSymbol) bool {
        return GetIteratorElementType(type, out var returnsEnumerable) != nil && returnsEnumerable
    }

    private func GetIteratorElementType(type TypeSymbol, out returnsEnumerable bool) TypeSymbol? {
        returnsEnumerable = false
        var type = type
        // ADR-0186 §9: see PlatformTypeSymbol.StripTopLevel.
        type = PlatformTypeSymbol.StripTopLevel(type)
        if type is SequenceTypeSymbol seq {
            returnsEnumerable = true
            return seq.ElementType
        }
        // Issue #810: prefer the symbolic type argument when the function's
        // return type is a constructed `ImportedTypeSymbol` (e.g.
        // `IEnumerable[T]` with `T` an open method type parameter). The
        // ClrType path below erases T to `object` and loses the
        // generic-parameter identity we need for the state-machine class.
        // Issue #806: compare via FullName so the check survives the
        // BuildTask MetadataLoadContext path (host-process `typeof()` is
        // not reference-equal to types loaded into a separate context).
        if type is ImportedTypeSymbol imported &&
            !imported
            .TypeArguments
            .IsDefaultOrEmpty &&
            imported.OpenDefinition != nil &&
            (
            imported
                .OpenDefinition
                .FullName == "System.Collections.Generic.IEnumerable`1" ||
                imported
                .OpenDefinition
                .FullName == "System.Collections.Generic.IEnumerator`1"
        ) {
            returnsEnumerable = imported.OpenDefinition.FullName == "System.Collections.Generic.IEnumerable`1"
            return imported.TypeArguments[0]
        }
        let clr Type? = type?.ClrType
        if clr == nil {
            return nil
        }
        if clr.IsGenericType && !clr.IsGenericTypeDefinition {
            let def = clr.GetGenericTypeDefinition()
            if def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IEnumerator`1" {
                returnsEnumerable = def.FullName == "System.Collections.Generic.IEnumerable`1"
                return TypeSymbol.FromClrTypeWithoutNullability(
                    clr.GetGenericArguments()[0],
                    NullabilityFreeReason.TypeStructure
                )
            }
        }
        if clr.FullName == "System.Collections.IEnumerable" || clr.FullName == "System.Collections.IEnumerator" {
            returnsEnumerable = clr.FullName == "System.Collections.IEnumerable"
            return TypeSymbol.FromClrTypeWithoutNullability(typeof(object), NullabilityFreeReason.TypeLiteral)
        }
        return nil
    }

    private func BuildPlan(
        function FunctionSymbol,
        body BoundStatement,
        elementType TypeSymbol
    ) IteratorStateMachinePlan {
        // Collect yields and assign states.
        let yieldCollector = IteratorRewriter.YieldStateCollector()
        yieldCollector.Visit(body)
        let yieldStates = yieldCollector.States
        // Collect hoisted locals (locals that are live across yield points).
        let hoistedLocals = CollectHoistedLocals(body)
        return IteratorStateMachinePlan(function, body, elementType, yieldStates, hoistedLocals)
    }

    private func CollectHoistedLocals(body BoundStatement) ImmutableArray[VariableSymbol] {
        // Simple approach: hoist all locals declared in the body.
        // A more precise analysis would only hoist those live across yields.
        let collector = LocalCollector()
        collector.Visit(body)
        return collector.Locals.ToImmutableArray()
    }
}

/// Result of running the iterator rewriter.
class IteratorRewriteResult {
    /// Initializes a new instance of the (cref:IteratorRewriteResult) class.
    init(program BoundProgram, plans ImmutableArray[IteratorStateMachinePlan]) {
        Program = program
        Plans = plans
    }

    /// Gets the original program.
    prop Program BoundProgram {
        get;
    }

    /// Gets the iterator state machine plans.
    prop Plans ImmutableArray[IteratorStateMachinePlan] {
        get;
    }
}

/// Holds the plan for rewriting a single iterator function into a state machine.
class IteratorStateMachinePlan {
    /// Initializes a new instance of the (cref:IteratorStateMachinePlan) class.
    init(
        function FunctionSymbol,
        body BoundStatement,
        elementType TypeSymbol,
        yieldStates ImmutableDictionary[BoundYieldStatement, int32],
        hoistedLocals ImmutableArray[VariableSymbol]
    ) {
        Function = function
        Body = body
        ElementType = elementType
        YieldStates = yieldStates
        HoistedLocals = hoistedLocals
    }

    /// Gets the original iterator function.
    prop Function FunctionSymbol {
        get;
    }

    /// Gets the original function body.
    prop Body BoundStatement {
        get;
    }

    /// Gets the element type produced by this iterator.
    prop ElementType TypeSymbol {
        get;
    }

    /// Gets the yield statement to state mapping.
    prop YieldStates ImmutableDictionary[BoundYieldStatement, int32] {
        get;
    }

    /// Gets the locals that must be hoisted to state machine fields.
    prop HoistedLocals ImmutableArray[VariableSymbol] {
        get;
    }
}
