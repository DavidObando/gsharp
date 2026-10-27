// <copyright file="SlotPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq

/// Owns the per-emit family of (cref:BoundTreeWalker) collectors
/// that pre-allocate IL slots for every bound-node kind whose lowering
/// needs a scratch local. The collectors are independent walkers — none
/// of them emits IL — and their outputs (slot dictionaries keyed by
/// bound-node identity) feed the body emitter's `ldloc/stloc` sites.
/// @remarks PR-E-4 extracts the 16 nested collector classes (and the
/// per-construct slot dictionaries they populate) out of
/// (cref:ReflectionMetadataEmitter) into this dedicated component.
/// The slot dictionaries themselves continue to live on the
/// `ReflectionMetadataEmitter.BodyEmitter` nested type because they
/// are per-method-emit and are passed into the collectors at use sites
/// rather than owned long-term. The defensive
/// `Debug.Assert(!structLiteralSlots.ContainsKey(...))`-style
/// allocation-site assertions therefore remain in
/// `ReflectionMetadataEmitter`'s `CollectLocalsAndLabels` for
/// now; `SlotDictionaryAliasingAssertionTests` globs every
/// `*.cs` file under `src/Core/CodeAnalysis/Emit/` and so
/// remains green regardless of which sibling file ends up housing each
/// substring.
///
/// Two collectors required a small contract change to break their direct
/// dependency on the root emitter:
///
/// - (cref:PatternSwitchSlotAllocator) now takes a (cref:MetadataTokenCache) directly instead of an
/// (cref:ReflectionMetadataEmitter) back-reference. It only ever read `cache.GlobalFieldDefs`.
/// - (cref:ReceiverSpillCollector) now takes a
/// `Func<BoundExpression, FunctionSymbol, IReadOnlyDictionary<VariableSymbol, int>, bool>` delegate
/// that the emitter binds to its existing `NeedsRvalueReceiverSpill` method.
///
/// `ConstructedTypeCollector` is intentionally NOT moved here: it is
/// a `BoundTreeRewriter` tied to the closure/display-class synthesis
/// path and belongs with PR-E-9 `ClosureEmitter`.
internal class SlotPlanner {
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let needsRvalueReceiverSpill(
        BoundExpression,
        FunctionSymbol?,
        IReadOnlyDictionary[VariableSymbol, int32]
    ) -> bool

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        needsRvalueReceiverSpill(BoundExpression, FunctionSymbol?, IReadOnlyDictionary[VariableSymbol, int32]) -> bool
    ) {
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.needsRvalueReceiverSpill = needsRvalueReceiverSpill ??
            throw ArgumentNullException("needsRvalueReceiverSpill")
    }

    // ─────────────────────────── entry points ───────────────────────────
    func CollectStructLiterals(node BoundNode, sink List[BoundStructLiteralExpression]) -> StructLiteralCollector(
        sink
    ).Visit(node)

    func CollectNullConditional(
        node BoundNode,
        sink List[BoundNullConditionalAccessExpression]
    ) -> NullConditionalCollector(sink).Visit(node)

    func CollectBlockExpressionLocals(body BoundBlockStatement, sink List[VariableSymbol]) {
        let collector = BlockExpressionLocalCollector()
        collector.Visit(body)
        sink.AddRange(collector.Variables)
    }

    func CollectExpressionBlockLabels(node BoundNode, sink HashSet[BoundLabel]) -> ExpressionBlockLabelCollector(
        sink
    ).Visit(node)

    func CollectFunctionLiterals() List[BoundFunctionLiteralExpression] {
        let sink = List[BoundFunctionLiteralExpression]()
        let collector = LambdaCollector(sink)
        // Issue #598: iterate Program.Functions in deterministic order
        // (source-position, then name) so lambda literals are collected in a
        // stable sequence regardless of ImmutableDictionary iteration order.
        // Issues #598/#4663: deterministic order, never identity-hash order.
        for kvp in BoundProgramOrder.Functions(this.emitCtx.Program) {
            collector.Visit(kvp.Value)
        }
        // Issue #4663: deterministic order, never identity-hash order.
        for entry in BoundProgramOrder.Initializers(this.emitCtx.Program) {
            let plan = entry.Value
            collector.Visit(plan.Prologue)
            for argument in plan.Arguments {
                collector.Visit(argument)
            }
            collector.Visit(plan.Body)
        }
        for type in this
            .emitCtx
            .Program
            .Structs
            .OrderBy((s StructSymbol) -> s.Declaration?.Span.Start ?? int32.MaxValue)
            .ThenBy((s StructSymbol) -> s.Name, StringComparer.Ordinal) {
            // Issue #2716: instance initializers are injected into constructors
            // after MethodDef planning, so discover their lambdas here.
            let allInstanceInitializerPathsArePlanned = this.AllInstanceInitializerPathsArePlanned(type)
            for field in type.Fields {
                if !allInstanceInitializerPathsArePlanned && type.InstanceFieldInitializers.TryGetValue(
                    field,
                    out var initializer
                ) {
                    collector.Visit(initializer)
                }
            }
            for field in type.StaticFields {
                if !this
                    .emitCtx
                    .Program
                    .Initializers
                    .ContainsKey((type, true)) &&
                    type
                    .StaticFieldInitializers
                    .TryGetValue(field, out var initializer) {
                    collector.Visit(initializer)
                }
            }
            for statement in if this.emitCtx.Program.Initializers.ContainsKey((type, true)) {
                ImmutableArray[BoundStatement].Empty
            } else {
                type.StaticInitializerStatements
            } {
                collector.Visit(statement)
            }
            // Issue #3355: base-constructor arguments can now contain native
            // block expressions whose tail is a lambda. These arguments live
            // on constructor symbols rather than in Program.Functions, so they
            // must participate in MethodDef planning explicitly.
            if !this
                .emitCtx
                .Program
                .Initializers
                .ContainsKey((type, false)) &&
                type.BaseConstructorInitializer is {} primaryBaseInitializer {
                for argument in primaryBaseInitializer.Arguments {
                    collector.Visit(argument)
                }
            }
            for constructor in type.ExplicitConstructors {
                if this
                    .emitCtx
                    .Program
                    .Initializers
                    .ContainsKey((constructor.Function, false)) ||
                    constructor.BaseInitializer is not{} baseInitializer {
                    continue
                }
                for argument in baseInitializer.Arguments {
                    collector.Visit(argument)
                }
            }
        }
        for type in this
            .emitCtx
            .Program
            .Interfaces
            .OrderBy((i InterfaceSymbol) -> i.Declaration?.Span.Start ?? int32.MaxValue)
            .ThenBy((i InterfaceSymbol) -> i.Name, StringComparer.Ordinal) {
            for field in type.StaticFields {
                if !this
                    .emitCtx
                    .Program
                    .Initializers
                    .ContainsKey((type, true)) &&
                    type
                    .StaticFieldInitializers
                    .TryGetValue(field, out var initializer) {
                    collector.Visit(initializer)
                }
            }
        }
        return sink
    }

    func CollectGoStatements() List[BoundGoStatement] {
        let sink = List[BoundGoStatement]()
        let collector = GoStatementCollector(sink)
        // Issue #598: iterate Program.Functions in deterministic order.
        // Issues #598/#4663: deterministic order, never identity-hash order.
        for kvp in BoundProgramOrder.Functions(this.emitCtx.Program) {
            collector.Visit(kvp.Value)
        }
        // Issue #4663: deterministic order, never identity-hash order.
        for entry in BoundProgramOrder.Initializers(this.emitCtx.Program) {
            let plan = entry.Value
            collector.Visit(plan.Prologue)
            for argument in plan.Arguments {
                collector.Visit(argument)
            }
            collector.Visit(plan.Body)
        }
        return sink
    }

    // PR #4273 (Copilot review): the collector itself moved to
    // Binding.GoCapturedVariableCollector so StatementBinder.BindGoStatement
    // can run the identical capture walk at BIND time (feeding
    // ClosureCaptureLegalityChecker) instead of only here at emit time,
    // where a rejected capture (GS9010/GS9011) would have nowhere to report.
    func CollectCapturedVariables(expression BoundExpression) ImmutableArray[
        VariableSymbol
    ] -> GoCapturedVariableCollector.CollectCapturedVariables(expression)

    func CollectDefaultExpressions(
        root BoundStatement,
        sink List[BoundDefaultExpression]
    ) -> DefaultExpressionCollector(sink).Visit(root)

    func CollectStackAllocs(root BoundStatement, sink List[BoundStackAllocExpression]) -> StackAllocCollector(
        sink
    ).Visit(root)

    // Issue #1522: collects the `stackalloc` nodes that occupy a stack-empty
    // (statement-root) position — the whole value of an expression statement, a
    // `return`, a local `var`-declaration initializer, or the right-hand side of
    // a local-variable assignment. Those emit their `localloc` with an empty
    // evaluation stack and are therefore already valid. Every OTHER stackalloc
    // is a sub-expression (a method/ctor argument or nested operand) that would
    // otherwise emit `localloc` while a receiver or prior arguments sit on the
    // stack (ECMA-335 III.3.47 violation, ilverify `LocallocStackNotEmpty`) and
    // must be spilled to a result local at an empty-stack point first.
    func CollectRootStackAllocs(
        root BoundStatement,
        sink HashSet[BoundStackAllocExpression]
    ) -> RootStackAllocCollector(sink).Visit(root)

    func CollectReceiverSpills(
        root BoundStatement,
        function FunctionSymbol?,
        locals IReadOnlyDictionary[VariableSymbol, int32],
        sink List[BoundExpression]
    ) -> ReceiverSpillCollector(this.needsRvalueReceiverSpill, function, locals, sink).Visit(root)

    func CollectMapIndexReads(root BoundStatement, sink List[BoundIndexExpression]) -> MapIndexReadCollector(
        sink
    ).Visit(root)

    func CollectIndexAssignmentValueSpills(
        root BoundStatement,
        sink List[BoundExpression]
    ) -> IndexAssignmentValueSpillCollector(sink).Visit(root)

    func CollectAssignmentValueSpills(root BoundStatement, sink List[BoundExpression]) -> AssignmentValueSpillCollector(
        sink
    ).Visit(root)

    func CollectNullableValueTypeUnwraps(
        root BoundStatement,
        sink List[BoundUnaryExpression]
    ) -> NullableValueTypeUnwrapCollector(sink).Visit(root)

    func CollectNullableValueTypeCoalesces(
        root BoundStatement,
        sink List[BoundBinaryExpression]
    ) -> NullableValueTypeCoalesceCollector(sink).Visit(root)

    // Issue #2388: widened from `List<BoundBinaryExpression>` to
    // `List<BoundExpression>` so the same collector/slot machinery also
    // catches a nullable-lifted `BoundClrBinaryOperatorExpression` (Stream
    // C/D custom-equality operators on `Nullable<T>` operands), not just the
    // built-in operator table's `BoundBinaryExpression` shape.
    func CollectLiftedBinaryOperators(root BoundStatement, sink List[BoundExpression]) -> LiftedBinaryOperatorCollector(
        sink
    ).Visit(root)

    func CollectNullableValueTypeConversions(
        root BoundStatement,
        sink List[BoundExpression]
    ) -> NullableValueTypeConversionCollector(sink).Visit(root)

    func RunPatternSwitchAllocator(
        node BoundNode,
        locals Dictionary[VariableSymbol, int32],
        localTypes List[TypeSymbol],
        patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32],
        typePatternScratchSlots Dictionary[BoundTypePattern, int32],
        switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)],
        channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)]
    ) {
        let allocator = PatternSwitchSlotAllocator(
            this.cache,
            locals,
            localTypes,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots
        )
        allocator.Visit(node)
    }

    private func AllInstanceInitializerPathsArePlanned(type StructSymbol) bool {
        var hasPath = false
        for constructor in type.ExplicitConstructors {
            if constructor.IsConvenience {
                continue
            }
            hasPath = true
            let owner = if constructor.IsSynthesizedFromPrimaryConstructor {
                cast[Symbol](type)
            } else {
                cast[Symbol](constructor.Function)
            }
            if !this.emitCtx.Program.Initializers.ContainsKey((owner, false)) {
                return false
            }
        }
        if !hasPath || type.NeedsSynthesizedValueStructDefaultCtor {
            if !this.emitCtx.Program.Initializers.ContainsKey((type, false)) {
                return false
            }
        }
        return true
    }

    // ─────────────────────────── collectors ───────────────────────────
    private class PatternSwitchSlotAllocator : BoundTreeWalker {
        private let cache MetadataTokenCache
        private let locals Dictionary[VariableSymbol, int32]
        private let localTypes List[TypeSymbol]
        private let patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32]
        private let typePatternScratchSlots Dictionary[BoundTypePattern, int32]
        private let switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)]
        private let channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)]

        init(
            cache MetadataTokenCache,
            locals Dictionary[VariableSymbol, int32],
            localTypes List[TypeSymbol],
            patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32],
            typePatternScratchSlots Dictionary[BoundTypePattern, int32],
            switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)],
            channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)]
        ) {
            this.cache = cache
            this.locals = locals
            this.localTypes = localTypes
            this.patternSwitchSlots = patternSwitchSlots
            this.typePatternScratchSlots = typePatternScratchSlots
            this.switchExpressionSlots = switchExpressionSlots
            this.channelOpSlots = channelOpSlots
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if node is BoundIsExpression isExpression && !isExpression.IsSimpleTypeTest {
                AllocatePatternLocal(isExpression.InputVariable, this.locals, this.localTypes)
                AllocatePatternBindings(
                    isExpression.Pattern,
                    this.locals,
                    this.localTypes,
                    this.typePatternScratchSlots
                )
            }
            base.VisitExpression(node)
        }

        protected override func VisitPatternSwitchStatement(node BoundPatternSwitchStatement) {
            if !this.patternSwitchSlots.ContainsKey(node) {
                let discriminantSlot = this.localTypes.Count
                this.localTypes.Add(node.Discriminant.Type)
                this.patternSwitchSlots[node] = discriminantSlot
            }
            VisitExpression(node.Discriminant)
            for arm in node.Arms {
                if arm.Pattern != nil {
                    AllocatePatternBindings(arm.Pattern, this.locals, this.localTypes, this.typePatternScratchSlots)
                    VisitPattern(arm.Pattern)
                }
                if arm.Guard != nil {
                    VisitExpression(arm.Guard)
                }
                VisitStatement(arm.Body)
            }
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            // Issue #216: const decls have no IL slot.
            // Issue #191: top-level globals are emitted as static fields on
            // <Program>; do not allocate a local slot for them when they
            // appear nested inside a switch arm / scope.
            if node.ConstantValue == nil && !this.locals.ContainsKey(node.Variable) &&
                !(node.Variable is GlobalVariableSymbol gv && this.cache.GlobalFieldDefs.ContainsKey(gv)) {
                this.locals[node.Variable] = this.localTypes.Count
                // Issue #491 (ADR-0060 follow-up): a ref-aliasing local's IL slot
                // is the managed pointer `T&`, not the pointee `T`. Recording the
                // slot type as ByRefTypeSymbol routes encoding through the byref
                // local-sig path (EncodeLocalVariableType).
                if node.Variable is LocalVariableSymbol lvs && lvs.RefKind != RefKind.None {
                    this.localTypes.Add(ByRefTypeSymbol.Get(lvs.Type))
                } else {
                    this.localTypes.Add(node.Variable.Type)
                }
            }
            base.VisitVariableDeclaration(node)
        }

        // ADR-0060: an inline `out var name`, `out let name`, or `out _` argument
        // synthesises a local in the binder without a corresponding
        // BoundVariableDeclaration statement. Pick the local up here when we see
        // its address taken so the emitter has a slot to ldloca from.
        protected override func VisitAddressOfExpression(node BoundAddressOfExpression) {
            if node.Operand is BoundVariableExpression bve &&
                bve.Variable is LocalVariableSymbol lvs &&
                !(lvs is ParameterSymbol) &&
                !this
                .locals
                .ContainsKey(lvs) {
                this.locals[lvs] = this.localTypes.Count
                this.localTypes.Add(lvs.Type)
            }
            base.VisitAddressOfExpression(node)
        }

        // ADR-0125 / issue #1026: allocate IL slots for a `fixed` statement's
        // synthetic pinned local and its user-visible `*T` pointer local. The
        // pinned local's slot type is a PinnedTypeSymbol so the local-signature
        // encoder sets the `pinned` flag. Order matters only for readability;
        // both are referenced by slot index from EmitFixedStatement.
        protected override func VisitFixedStatement(node BoundFixedStatement) {
            if !this.locals.ContainsKey(node.PinnedVariable) {
                this.locals[node.PinnedVariable] = this.localTypes.Count
                this.localTypes.Add(node.PinnedVariable.Type)
            }
            if !this.locals.ContainsKey(node.PointerVariable) {
                this.locals[node.PointerVariable] = this.localTypes.Count
                this.localTypes.Add(node.PointerVariable.Type)
            }
            // ADR-0125 / issue #1043: the span-like (PinnableReference) form holds
            // the source value in a synthetic local whose address feeds the
            // `GetPinnableReference()` call; allocate its slot too.
            if node.SourceVariable != nil && !this.locals.ContainsKey(node.SourceVariable) {
                this.locals[node.SourceVariable] = this.localTypes.Count
                this.localTypes.Add(node.SourceVariable!!.Type)
            }
            base.VisitFixedStatement(node)
        }

        protected override func VisitSwitchExpression(node BoundSwitchExpression) {
            if !this.switchExpressionSlots.ContainsKey(node) {
                // A void or never-typed switch has no result slot (-1); see
                // SwitchExpressionHasResult.
                let resultSlot = if SwitchExpressionHasResult(node) {
                    this.localTypes.Count
                } else {
                    -1
                }
                if resultSlot >= 0 {
                    this.localTypes.Add(node.Type)
                }
                let discrSlot = this.localTypes.Count
                this.localTypes.Add(node.Discriminant.Type)
                this.switchExpressionSlots[node] = (resultSlot, discrSlot)
            }
            VisitExpression(node.Discriminant)
            for arm in node.Arms {
                if arm.Pattern != nil {
                    AllocatePatternBindings(arm.Pattern, this.locals, this.localTypes, this.typePatternScratchSlots)
                    VisitPattern(arm.Pattern)
                }
                if arm.Guard != nil {
                    VisitExpression(arm.Guard)
                }
                VisitExpression(arm.Result)
            }
        }

        shared {
            private func ConstructChannelOperationType(openDefinition Type, elementType TypeSymbol) TypeSymbol {
                let closedCarrier = openDefinition.MakeGenericType(
                    MethodBodyEmitter.ResolveChannelElementClrType(elementType)
                )
                return if MethodBodyEmitter.ChannelElementNeedsSymbolicType(elementType) {
                    cast[TypeSymbol](
                        ImportedTypeSymbol.GetConstructed(
                            closedCarrier,
                            openDefinition,
                            ImmutableArray.Create(elementType)
                        )
                    )
                } else {
                    TypeSymbol.FromClrTypeWithoutNullability(closedCarrier, NullabilityFreeReason.CompilerProduced)
                }
            }

            private func AllocatePatternBindings(
                pattern BoundPattern,
                locals Dictionary[VariableSymbol, int32],
                localTypes List[TypeSymbol],
                typePatternScratchSlots Dictionary[BoundTypePattern, int32]
            ) {
                switch pattern {
                    case BoundDiscardPattern{Variable: not nil} varPattern {
                        AllocatePatternLocal(varPattern.Variable!!, locals, localTypes)
                    }
                    case tp is BoundTypePattern {
                        if !typePatternScratchSlots.ContainsKey(tp) {
                            let scratch = localTypes.Count
                            localTypes.Add(
                                TypeSymbol.FromClrTypeWithoutNullability(
                                    typeof(object),
                                    NullabilityFreeReason.TypeLiteral
                                )
                            )
                            typePatternScratchSlots[tp] = scratch
                        }
                        if !locals.ContainsKey(tp.Variable) {
                            locals[tp.Variable] = localTypes.Count
                            localTypes.Add(tp.Variable.Type)
                        }
                        if tp.PropertyPattern != nil {
                            AllocatePatternBindings(tp.PropertyPattern, locals, localTypes, typePatternScratchSlots)
                        }
                    }
                    case pp is BoundPropertyPattern {
                        if pp.InputVariable != nil {
                            AllocatePatternLocal(pp.InputVariable, locals, localTypes)
                        }
                        if pp.UnwrappedVariable != nil {
                            AllocatePatternLocal(pp.UnwrappedVariable, locals, localTypes)
                        }
                        for field in pp.Fields {
                            if field.ValueVariable != nil {
                                AllocatePatternLocal(field.ValueVariable, locals, localTypes)
                            }
                            AllocatePatternBindings(field.Pattern, locals, localTypes, typePatternScratchSlots)
                        }
                    }
                    case lp is BoundListPattern {
                        if lp.InputVariable != nil {
                            AllocatePatternLocal(lp.InputVariable, locals, localTypes)
                        }
                        for elem in lp.Elements {
                            AllocatePatternBindings(elem, locals, localTypes, typePatternScratchSlots)
                        }
                    }
                    case slice is BoundSlicePattern {
                        // Issue #1505: the captured / synthesized slice local holds the
                        // materialized middle slice; allocate its slot and recurse into
                        // any sub-pattern matched against that slice.
                        if slice.Variable != nil && !locals.ContainsKey(slice.Variable) {
                            locals[slice.Variable] = localTypes.Count
                            localTypes.Add(slice.Variable!!.Type)
                        }
                        if slice.Pattern != nil {
                            AllocatePatternBindings(slice.Pattern, locals, localTypes, typePatternScratchSlots)
                        }
                    }
                    case bp is BoundBinaryPattern {
                        AllocatePatternBindings(bp.Left, locals, localTypes, typePatternScratchSlots)
                        AllocatePatternBindings(bp.Right, locals, localTypes, typePatternScratchSlots)
                    }
                    case np is BoundNotPattern {
                        AllocatePatternBindings(np.Pattern, locals, localTypes, typePatternScratchSlots)
                    }
                }
            }

            private func AllocatePatternLocal(
                variable LocalVariableSymbol,
                locals Dictionary[VariableSymbol, int32],
                localTypes List[TypeSymbol]
            ) {
                if !locals.ContainsKey(variable) {
                    locals[variable] = localTypes.Count
                    localTypes.Add(variable.Type)
                }
            }
        }
    }

    private class StructLiteralCollector : BoundTreeWalker {
        private let sink List[BoundStructLiteralExpression]

        init(sink List[BoundStructLiteralExpression]) {
            this.sink = sink
        }

        protected override func VisitStructLiteralExpression(node BoundStructLiteralExpression) {
            this.sink.Add(node)
            base.VisitStructLiteralExpression(node)
        }
    }

    private class NullConditionalCollector : BoundTreeWalker {
        private let sink List[BoundNullConditionalAccessExpression]

        init(sink List[BoundNullConditionalAccessExpression]) {
            this.sink = sink
        }

        protected override func VisitNullConditionalAccessExpression(node BoundNullConditionalAccessExpression) {
            this.sink.Add(node)
            base.VisitNullConditionalAccessExpression(node)
        }
    }

    private class BlockExpressionLocalCollector : BoundTreeWalker {
        init() {
            Variables = List[VariableSymbol]()
        }

        prop Variables List[VariableSymbol] {
            get;
        }

        protected override func VisitBlockExpression(node BoundBlockExpression) {
            for statement in node.Statements {
                if statement is BoundVariableDeclaration declaration {
                    this.Variables.Add(declaration.Variable)
                }
            }
            base.VisitBlockExpression(node)
        }
    }

    // Walks an arbitrary bound sub-tree and records every BoundLabelStatement
    // label it discovers. Implemented as a BoundTreeWalker subclass so it
    // automatically descends through every statement and expression kind
    // (including BoundBlockExpression, BoundSpillSequenceExpression, etc.)
    // without having to enumerate them by hand.
    private class ExpressionBlockLabelCollector : BoundTreeWalker {
        private let sink HashSet[BoundLabel]

        init(sink HashSet[BoundLabel]) {
            this.sink = sink
        }

        override func VisitStatement(node BoundStatement?) {
            if node == nil {
                return
            }
            if node is BoundLabelStatement label {
                this.sink.Add(label.Label)
                return
            }
            base.VisitStatement(node)
        }
    }

    private class LambdaCollector : BoundTreeWalker {
        private let sink List[BoundFunctionLiteralExpression]
        private let seen HashSet[BoundFunctionLiteralExpression] = HashSet[BoundFunctionLiteralExpression]()

        init(sink List[BoundFunctionLiteralExpression]) {
            this.sink = sink
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if node is BoundFunctionLiteralExpression lambda {
                if !this.seen.Add(lambda) {
                    return
                }
                this.sink.Add(lambda)
                this.VisitStatement(lambda.Body)
                return
            }
            base.VisitExpression(node)
        }
    }

    private class GoStatementCollector : BoundTreeWalker {
        private let sink List[BoundGoStatement]
        private let seen HashSet[BoundGoStatement] = HashSet[BoundGoStatement]()

        init(sink List[BoundGoStatement]) {
            this.sink = sink
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            // Override the base dispatch so we descend into the body of any
            // BoundFunctionLiteralExpression we encounter — go statements
            // need to discover nested go statements inside lambda bodies too.
            if node is BoundFunctionLiteralExpression lambda {
                this.VisitStatement(lambda.Body)
                return
            }
            base.VisitExpression(node)
        }

        protected override func VisitGoStatement(node BoundGoStatement) {
            if this.seen.Add(node) {
                this.sink.Add(node)
            }
            base.VisitGoStatement(node)
        }
    }

    private class DefaultExpressionCollector : BoundTreeWalker {
        private let sink List[BoundDefaultExpression]

        init(sink List[BoundDefaultExpression]) {
            this.sink = sink
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if node is BoundDefaultExpression de {
                this.sink.Add(de)
                return
            }
            base.VisitExpression(node)
        }
    }

    private class StackAllocCollector : BoundTreeWalker {
        private let sink List[BoundStackAllocExpression]

        init(sink List[BoundStackAllocExpression]) {
            this.sink = sink
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if node is BoundStackAllocExpression sa {
                this.sink.Add(sa)
            }
            base.VisitExpression(node)
        }
    }

    // Issue #1522: marks the stackalloc nodes that are emitted at an empty
    // evaluation stack (statement-root positions) so the planner/emitter can
    // spill every OTHER (sub-expression) stackalloc to a result local.
    private class RootStackAllocCollector : BoundTreeWalker {
        private let sink HashSet[BoundStackAllocExpression]

        init(sink HashSet[BoundStackAllocExpression]) {
            this.sink = sink
        }

        override func VisitStatement(node BoundStatement?) {
            if node == nil {
                return
            }
            switch node {
                case es is BoundExpressionStatement {
                    // A bare `stackalloc` statement, or a local-variable
                    // assignment `x = stackalloc …` (the RHS of an assignment to
                    // a VariableSymbol is emitted at an empty stack).
                    this.AddIfStackAlloc(es.Expression)
                    if es.Expression is BoundAssignmentExpression asn {
                        this.AddIfStackAlloc(asn.Expression)
                    }
                }
                case rs is BoundReturnStatement {
                    this.AddIfStackAlloc(rs.Expression)
                }
                case vd is BoundVariableDeclaration {
                    this.AddIfStackAlloc(vd.Initializer)
                }
                default { }
            }
            base.VisitStatement(node)
        }

        private func AddIfStackAlloc(expression BoundExpression?) {
            if expression is BoundStackAllocExpression sa {
                this.sink.Add(sa)
            }
        }
    }

    private class ReceiverSpillCollector : BoundTreeWalker {
        override func VisitExpression(node BoundExpression?) {
            if node is BoundUtf8StringExpression && !this.sink.Contains(node) {
                this.sink.Add(node)
            }
            base.VisitExpression(node)
        }

        private let needsRvalueReceiverSpill(
            BoundExpression,
            FunctionSymbol?,
            IReadOnlyDictionary[VariableSymbol, int32]
        ) -> bool
        private let function FunctionSymbol?
        private let locals IReadOnlyDictionary[VariableSymbol, int32]
        private let sink List[BoundExpression]

        init(
            needsRvalueReceiverSpill(
                BoundExpression,
                FunctionSymbol?,
                IReadOnlyDictionary[VariableSymbol, int32]
            ) -> bool,
            function FunctionSymbol?,
            locals IReadOnlyDictionary[VariableSymbol, int32],
            sink List[BoundExpression]
        ) {
            this.needsRvalueReceiverSpill = needsRvalueReceiverSpill
            this.function = function
            this.locals = locals
            this.sink = sink
        }

        protected override func VisitImportedInstanceCallExpression(node BoundImportedInstanceCallExpression) {
            this.AddIfNeeded(node.Receiver)
            base.VisitImportedInstanceCallExpression(node)
        }

        protected override func VisitUserInstanceCallExpression(node BoundUserInstanceCallExpression) {
            this.AddIfNeeded(node.Receiver)
            base.VisitUserInstanceCallExpression(node)
        }

        protected override func VisitClrPropertyAccessExpression(node BoundClrPropertyAccessExpression) {
            if node.Receiver != nil {
                this.AddIfNeeded(node.Receiver)
            }
            base.VisitClrPropertyAccessExpression(node)
        }

        protected override func VisitClrPropertyAssignmentExpression(node BoundClrPropertyAssignmentExpression) {
            if node.Receiver != nil {
                this.AddIfNeeded(node.Receiver)
                this.AddIfCompoundReused(node.Receiver!!, node.Value)
            }
            base.VisitClrPropertyAssignmentExpression(node)
        }

        // Issue #1688: a field assignment through an expression-based receiver
        // (issue #567 / ADR-0112) whose Value re-reads the SAME receiver node —
        // the shape TryBindChainedCompoundAssignment produces for
        // `getObj().Field += x` (the compound RHS embeds a
        // BoundFieldAccessExpression over the identical receiver instance) —
        // must preserve receiver identity across read and write. Reference
        // receivers are cached directly; addressable value-type fields cache
        // their owning receiver so the write still targets original storage.
        protected override func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
            if node.ReceiverExpression != nil {
                this.AddIfCompoundReused(node.ReceiverExpression, node.Value)
            }
            base.VisitFieldAssignmentExpression(node)
        }

        // Issue #418 (P1-5): G# computed/auto properties also need the spill
        // infrastructure when the receiver is a non-addressable struct rvalue
        // (e.g. `makePoint(5, 6).Sum`, `getOuter().Inner.Length`).
        protected override func VisitPropertyAccessExpression(node BoundPropertyAccessExpression) {
            if node.Receiver != nil {
                this.AddIfNeeded(node.Receiver)
            }
            base.VisitPropertyAccessExpression(node)
        }

        protected override func VisitPropertyAssignmentExpression(node BoundPropertyAssignmentExpression) {
            if node.Receiver != nil {
                this.AddIfNeeded(node.Receiver)
                this.AddIfCompoundReused(node.Receiver!!, node.Value)
            }
            base.VisitPropertyAssignmentExpression(node)
        }

        protected override func VisitClrEventSubscriptionExpression(node BoundClrEventSubscriptionExpression) {
            if node.Receiver != nil {
                this.AddIfNeeded(node.Receiver)
            }
            base.VisitClrEventSubscriptionExpression(node)
        }

        protected override func VisitEventSubscriptionExpression(node BoundEventSubscriptionExpression) {
            if node.Receiver != nil {
                this.AddIfNeeded(node.Receiver)
            }
            base.VisitEventSubscriptionExpression(node)
        }

        protected override func VisitClrIndexExpression(node BoundClrIndexExpression) {
            this.AddIfNeeded(node.Target)
            base.VisitClrIndexExpression(node)
        }

        protected override func VisitClrIndexAssignmentExpression(node BoundClrIndexAssignmentExpression) {
            if node.TargetExpression != nil {
                this.AddIfNeeded(node.TargetExpression)
            }
            base.VisitClrIndexAssignmentExpression(node)
        }

        protected override func VisitTupleElementAccessExpression(node BoundTupleElementAccessExpression) {
            this.AddIfNeeded(node.Receiver)
            base.VisitTupleElementAccessExpression(node)
        }

        protected override func VisitClrMethodGroupExpression(node BoundClrMethodGroupExpression) {
            if node.Receiver != nil {
                this.AddIfNeeded(node.Receiver)
            }
            base.VisitClrMethodGroupExpression(node)
        }

        protected override func VisitMethodGroupExpression(node BoundMethodGroupExpression) {
            // ADR-0112: a user instance method group captures an rvalue receiver
            // (e.g. a struct produced by a call). Spill it so the emitter can take
            // its address / box it for the delegate target.
            if node.Receiver != nil {
                this.AddIfNeeded(node.Receiver)
            }
            base.VisitMethodGroupExpression(node)
        }

        private func AddIfNeeded(receiver BoundExpression) {
            if this.needsRvalueReceiverSpill(receiver, this.function, this.locals) {
                this.sink.Add(receiver)
            }
        }

        // Issue #1688: a compound member assignment (`getObj().F += x` /
        // `getObj().P += x`) binds the receiver ONCE (TryBindChainedCompoundAssignment
        // / TryBindChainedClrCompoundAssignment reuse the same BoundExpression
        // instance for the read side embedded in `value` and the write side on
        // the assignment node itself). A trivial receiver (a local, parameter,
        // global, or `this` — all represented as BoundVariableExpression) has no
        // side effect and no observable identity to preserve, so re-emitting it
        // is harmless and needs no temp. Any other receiver shape (a call, an
        // indexer, a chained member access, etc.) must be spilled to a temp and
        // evaluated exactly once — otherwise a side-effecting or non-idempotent
        // receiver expression runs twice and the read/write can target two
        // different instances.
        private func AddIfCompoundReused(receiver BoundExpression, value BoundExpression) {
            if receiver is BoundVariableExpression {
                return
            }
            let found = ReceiverReuseWalker.ContainsReceiverReference(value, receiver)
            if !found {
                return
            }
            // Pointer field syntax unwraps `*p` before emit. Cache the pointer
            // operand itself so both the field read and write reuse one value.
            if receiver is BoundDereferenceExpression dereference && TypeSymbol.IsUnmanagedPointer(
                dereference.Operand.Type
            ) {
                this.sink.Add(dereference.Operand)
                return
            }
            // An addressable value-type field must stay in its owning storage:
            // caching the field value would turn the write into a temp-local
            // mutation. Cache the side-effecting owner instead, then let
            // EmitFieldAddress rebuild the same address for read and write.
            if receiver is BoundFieldAccessExpression fieldAccess && ReflectionMetadataEmitter.IsValueTypeSymbol(
                receiver.Type
            ) &&
                !this
                .needsRvalueReceiverSpill(receiver, this.function, this.locals) {
                if fieldAccess.Receiver != nil {
                    this.AddIfCompoundReused(fieldAccess.Receiver, value)
                }
                return
            }
            this.sink.Add(receiver)
        }
    }

    // Issue #1688: walks a compound-assignment's bound RHS (the lowered
    // `<field/property access> OP rhs` expression) looking for a field/property
    // read whose receiver is the SAME BoundExpression instance as the outer
    // assignment's receiver — the shape the compound-assignment binder helpers
    // produce. Used by ReceiverSpillCollector.AddIfCompoundReused to decide
    // whether the receiver needs a once-only spill.
    private class ReceiverReuseWalker : BoundTreeWalker {
        private let target BoundExpression

        private init(target BoundExpression) {
            this.target = target
        }

        private prop Found bool

        protected override func VisitFieldAccessExpression(node BoundFieldAccessExpression) {
            this.CheckReceiver(node.Receiver)
            base.VisitFieldAccessExpression(node)
        }

        protected override func VisitPropertyAccessExpression(node BoundPropertyAccessExpression) {
            this.CheckReceiver(node.Receiver)
            base.VisitPropertyAccessExpression(node)
        }

        protected override func VisitClrPropertyAccessExpression(node BoundClrPropertyAccessExpression) {
            this.CheckReceiver(node.Receiver)
            base.VisitClrPropertyAccessExpression(node)
        }

        private func CheckReceiver(receiver BoundExpression?) {
            if receiver != nil && object.ReferenceEquals(receiver, this.target) {
                this.Found = true
            }
        }

        shared {
            func ContainsReceiverReference(tree BoundExpression, target BoundExpression) bool {
                let walker = ReceiverReuseWalker(target)
                walker.Visit(tree)
                return walker.Found
            }
        }
    }

    private class MapIndexReadCollector : BoundTreeWalker {
        private let sink List[BoundIndexExpression]

        init(sink List[BoundIndexExpression]) {
            this.sink = sink
        }

        protected override func VisitIndexExpression(node BoundIndexExpression) {
            if node.Target.Type is MapTypeSymbol {
                this.sink.Add(node)
            }
            base.VisitIndexExpression(node)
        }
    }

    // Issue #418 (P1-1): collects every index-assignment expression so the body
    // emitter can pre-allocate a scratch slot of the value's type. The emit sites
    // use a dup + stloc tmp + store + ldloc tmp pattern to avoid re-evaluating
    // the index/argument expressions when producing the assignment's result.
    private class IndexAssignmentValueSpillCollector : BoundTreeWalker {
        private let sink List[BoundExpression]

        init(sink List[BoundExpression]) {
            this.sink = sink
        }

        protected override func VisitIndexAssignmentExpression(node BoundIndexAssignmentExpression) {
            this.sink.Add(node)
            base.VisitIndexAssignmentExpression(node)
        }

        protected override func VisitClrIndexAssignmentExpression(node BoundClrIndexAssignmentExpression) {
            this.sink.Add(node)
            base.VisitClrIndexAssignmentExpression(node)
        }
    }

    // Issue #418 (P1-2): walker that collects every BoundPropertyAssignment /
    // BoundClrPropertyAssignment expression so the slot allocator can give
    // each one a value-temp local for the dup/stloc spill described in
    // CollectAssignmentValueSpills.
    private class AssignmentValueSpillCollector : BoundTreeWalker {
        private let sink List[BoundExpression]

        init(sink List[BoundExpression]) {
            this.sink = sink
        }

        protected override func VisitPropertyAssignmentExpression(node BoundPropertyAssignmentExpression) {
            this.sink.Add(node)
            base.VisitPropertyAssignmentExpression(node)
        }

        protected override func VisitClrPropertyAssignmentExpression(node BoundClrPropertyAssignmentExpression) {
            this.sink.Add(node)
            base.VisitClrPropertyAssignmentExpression(node)
        }

        // Issue #1614: a field assignment through an expression-based
        // receiver (issue #567: closure-boxing lowers `variable.Field = v`
        // to `boxLocal.Value.Field = v`; ADR-0112 chained assignment binds
        // `a.B.C = v` the same way) is the only field-assignment shape whose
        // receiver is an arbitrary, potentially side-effecting expression.
        // The emitter used to evaluate it twice — once for `stfld`, once
        // more afterwards to `ldfld` the just-stored value back out as the
        // expression result — invoking any receiver side effect (e.g. a
        // factory call) twice. Mirror the property-assignment fix (issue
        // #418 P1-2): pre-allocate a value-typed temp so the emitter can
        // `dup; stloc tmp; stfld; ldloc tmp` instead of re-evaluating the
        // receiver. The simple-variable-receiver overloads below are
        // unaffected — reloading a variable has no side effects.
        protected override func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
            if node.ReceiverExpression != nil {
                this.sink.Add(node)
            }
            base.VisitFieldAssignmentExpression(node)
        }

        // ADR-0060 / issue #491: assignments to ref-kind parameters or to
        // ref-aliasing locals lower to `<addr>; value; dup; stloc tmp; stind`.
        // To preserve the assignment-as-expression result semantics without
        // a re-read, the emitter spills the value to a temp local.
        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            if node.Variable is ParameterSymbol ps && ps.RefKind != RefKind.None {
                this.sink.Add(node)
            } else if node.Variable is LocalVariableSymbol lvs && lvs.RefKind != RefKind.None {
                this.sink.Add(node)
            }
            base.VisitAssignmentExpression(node)
        }

        // ADR-0060: an explicit `*p = v` indirect-assignment expression spills
        // its value to a temp for the same reason.
        protected override func VisitIndirectAssignmentExpression(node BoundIndirectAssignmentExpression) {
            this.sink.Add(node)
            base.VisitIndirectAssignmentExpression(node)
        }
    }

    // Issue #504 + Issue #831: walks the bound tree collecting every
    // `BoundUnaryExpression` whose operator is `NullAssertion` (`!!`)
    // and whose operand requires an emit-time spill slot. Two shapes
    // qualify:
    //
    //   * Value-type `Nullable<T>` operand — the emitter spills the
    //     struct to a slot and calls `Nullable<T>::get_Value` (which
    //     yields the underlying `T` or throws `InvalidOperationException`).
    //
    //   * Open-type-parameter operand whose binder-typed shape is `T?`
    //     or bare `T` (after a smart-cast that narrowed `T?` to `T`),
    //     where T is NOT struct-constrained. The bare `!!T` stack value
    //     cannot be probed via `dup; brtrue` either — the verifier
    //     rejects branching on an opaque type-parameter slot. The
    //     emitter instead stores the operand to a `T`-typed slot,
    //     probes its non-nullness via `box !!T; brtrue nonNull`, throws
    //     on null, and reloads the slot on the non-null path.
    //
    // Reference-type `!!` over a concrete reference (string?, Func<T>?,
    // sequence[T], ...) uses the existing `dup; brtrue; throw NRE`
    // pattern and needs no slot.
    private class NullableValueTypeUnwrapCollector : BoundTreeWalker {
        private let sink List[BoundUnaryExpression]

        init(sink List[BoundUnaryExpression]) {
            this.sink = sink
        }

        protected override func VisitUnaryExpression(node BoundUnaryExpression) {
            // Issue #2544: non-identity lifted unary operators need the same
            // Nullable<T>-typed spill slot as `!!` so emit can branch on
            // HasValue and unwrap the present value exactly once.
            if node
                .Op
                .Kind != BoundUnaryOperatorKind.NullAssertion &&
                node
                .Op
                .Kind != BoundUnaryOperatorKind.Identity &&
                node
                .Operand
                .Type is NullableTypeSymbol liftedOperand &&
                node.Type is NullableTypeSymbol &&
                NullableLifting.IsValueTypeNullable(liftedOperand) {
                this.sink.Add(node)
            }
            if node.Op.Kind == BoundUnaryOperatorKind.NullAssertion {
                var needsSlot = false
                if node.Operand.Type is NullableTypeSymbol n {
                    needsSlot = n
                        .UnderlyingType
                        ?.ClrType is {IsValueType: true} ||
                        (n.UnderlyingType is TypeParameterSymbol tp && !tp.HasValueTypeConstraint) ||
                        NullableLifting.RequiresSymbolicNullableGetValue(n)
                } else if node.Operand.Type is TypeParameterSymbol bare && !bare.HasValueTypeConstraint {
                    // Issue #831: smart-cast may narrow `self T?` to bare
                    // `T` after a preceding `if self == nil { return }`
                    // guard, but the runtime value still needs the
                    // verifiable `box; brtrue` shape rather than the
                    // direct `dup; brtrue` over an opaque `!!T` slot.
                    needsSlot = true
                }
                if needsSlot {
                    this.sink.Add(node)
                }
            }
            base.VisitUnaryExpression(node)
        }
    }

    // Issue #519: walks the bound tree collecting every `BoundBinaryExpression`
    // whose operator is `NullCoalesce` (`??`) and whose LHS needs an emit-time
    // spill slot. Several shapes qualify:
    //
    //   * Value-type `Nullable<T>` LHS — the emitter spills the LHS once and
    //     calls `Nullable<T>::get_HasValue` / `get_Value` off the slot's
    //     address (since `dup; brtrue` is invalid IL for struct stack values).
    //
    //   * Issue #831: open-type-parameter `T?` LHS where T is NOT
    //     struct-constrained (class-constrained or unconstrained). The bare
    //     `!!T` stack value cannot be probed with `dup; brtrue` either —
    //     the verifier rejects branching on an opaque type-parameter slot
    //     because it cannot prove T is a reference type at the signature
    //     layer. The slot is typed as `T?` (which encodes as bare `!!T` per
    //     `ReflectionMetadataEmitter.GetElementTypeToken`), and the emitter
    //     probes its non-nullness via `box !!T; brfalse fallback`.
    //
    //   * Issue #1578 / #2333: `Nullable<T>` LHS where T is a user-declared
    //     value-kind struct/enum, or an open type parameter constrained to
    //     `struct`. Neither has a runtime ClrType during emit, so the emitter
    //     spills to a `Nullable<T>` slot and probes non-nullness via
    //     `box Nullable<T>; brfalse fallback` off the symbolically-encoded
    //     TypeSpec, unwrapping via the symbolic `get_Value` MemberRef.
    //
    // Reference-type `??` over a concrete reference type (string?, Func<T>?,
    // sequence[T], etc.) uses the existing `dup; brtrue; pop; rhs` pattern
    // and needs no slot.
    private class NullableValueTypeCoalesceCollector : BoundTreeWalker {
        private let sink List[BoundBinaryExpression]

        init(sink List[BoundBinaryExpression]) {
            this.sink = sink
        }

        protected override func VisitBinaryExpression(node BoundBinaryExpression) {
            if node.Op.Kind == BoundBinaryOperatorKind.NullCoalesce {
                var needsSlot = false
                if node.Left.Type is NullableTypeSymbol n {
                    needsSlot = n
                        .UnderlyingType
                        ?.ClrType is {IsValueType: true} ||
                        (n.UnderlyingType is TypeParameterSymbol tp && !tp.HasValueTypeConstraint) ||
                        NullableLifting.RequiresSymbolicNullableGetValue(n)
                } else if SlotPlanner.IsReferenceTypeParameterCoalesceProbe(node, out _) {
                    // Issue #1516: bare reference-typed type-parameter LHS
                    // (e.g. `x as T ?? fallback` where `T : SomeClass`,
                    // interface-constrained, or unconstrained). The LHS
                    // type is the bare `T`, not `T?`, so the value-type
                    // and `NullableTypeSymbol(TP)` cases above miss it.
                    needsSlot = true
                }
                if needsSlot {
                    this.sink.Add(node)
                }
            }
            base.VisitBinaryExpression(node)
        }
    }

    // PR N-4 / §6.1 / C# §7.3.7: walks the bound tree collecting every
    // BoundBinaryExpression that is a lifted operator over a value-type
    // Nullable<T>. The emitter needs a fixed set of scratch slots per
    // lifted operator site:
    //   * one Nullable<T>-typed slot for the LHS spill (so the emitter can
    //     take its address for call get_HasValue / get_Value),
    //   * one Nullable<T>-typed slot for the RHS spill (same reason),
    //   * one Nullable<R>-typed slot for the result when the operator
    //     produces Nullable<R> (arithmetic / bitwise). The slot is used to
    //     initobj a default Nullable<R> on the "null" branch and then load
    //     it as a value. The slot is NOT allocated for lifted equality /
    //     ordering, whose result is bool.
    // Mirrors NullableValueTypeCoalesceCollector but yields a richer
    // per-node slot bundle.
    private class LiftedBinaryOperatorCollector : BoundTreeWalker {
        private let sink List[BoundExpression]

        init(sink List[BoundExpression]) {
            this.sink = sink
        }

        protected override func VisitBinaryExpression(node BoundBinaryExpression) {
            if IsLiftedValueTypeBinary(node) {
                this.sink.Add(node)
            }
            base.VisitBinaryExpression(node)
        }

        // Issue #2388: a Stream C/D custom-operator call
        // (BoundClrBinaryOperatorExpression) needs the identical LhsSlot /
        // RhsSlot spill-and-HasValue-branch treatment as the built-in
        // operator table's BoundBinaryExpression above when its operands
        // were nullable-lifted by TryLiftNullableClrOperatorOperands (both
        // sides converted to a matching Nullable<T>). Sharing the sink /
        // slot dictionary lets EmitClrBinaryOperator reuse the exact same
        // LiftedBinarySlots lookup as EmitBinary.
        protected override func VisitClrBinaryOperatorExpression(node BoundClrBinaryOperatorExpression) {
            if IsLiftedValueTypeClrBinary(node) {
                this.sink.Add(node)
            }
            base.VisitClrBinaryOperatorExpression(node)
        }

        shared {
            private func IsLiftedValueTypeClrBinary(node BoundClrBinaryOperatorExpression) bool {
                // The binder only ever produces this node with BOTH operands
                // already Nullable<T>-converted when lifting applies (mixed-mode
                // wraps the bare side); a plain (non-lifted) Stream C/D call site
                // never has a NullableTypeSymbol operand at all. Nil comparisons
                // (`T? == nil`) never reach Stream C/D in the first place — the
                // built-in IsNullCompare arm binds those directly as a plain
                // BoundBinaryExpression before Stream C/D is even attempted — so
                // there is no Form-2 "nil" case to mirror here, unlike
                // IsLiftedValueTypeBinary above.
                // Issue #2399: mirror the binder's canonical effective-storage
                // test. A nullable reference annotation over a same-compilation
                // class must not allocate Nullable<T> spill/result slots.
                return node.Left.Type is NullableTypeSymbol left && NullableLifting.IsAnyValueTypeNullable(left) &&
                    node
                    .Right
                    .Type is NullableTypeSymbol right &&
                    NullableLifting.IsAnyValueTypeNullable(right)
            }

            private func IsLiftedValueTypeBinary(node BoundBinaryExpression) bool {
                // Form 1: classic lifted form — both LHS and RHS are
                // value-type Nullable<T> wrapping the same underlying. The
                // lifted binder arm enforces this; the mixed-mode binder
                // lift inserts an implicit `T -> T?` conversion for the
                // non-nullable side before binding the operator.
                //
                // Form 2: `value-type Nullable<T> == nil` / `!= nil` — bound
                // by the IsNullCompare arm with left=Nullable<T>, right=Null.
                // Without slot allocation the bottom of EmitBinary would
                // load the LHS as a struct value and the RHS as `ldnull`
                // and then emit `ceq` — an `InvalidProgramException` at
                // runtime. Treating this as a lifted form lets the emitter
                // spill the LHS once and consult `HasValue`.
                //
                // Issue #3626: a bare `ClrType.IsValueType` probe misses a
                // `Nullable<TupleTypeSymbol>` whose ClrType is symbolic-null
                // (e.g. a tuple element carries a nullable-reference-type
                // annotation like `string?`, or was decoded from an imported
                // signature) — `NullableLifting.IsValueTypeNullable` is the
                // canonical predicate that already special-cases tuples for
                // exactly this reason.
                let leftIsValueNullable = node
                    .Left
                    .Type is NullableTypeSymbol left &&
                    NullableLifting.IsValueTypeNullable(left)
                if !leftIsValueNullable {
                    return false
                }
                if node.Right.Type == TypeSymbol.Null {
                    return (node.Op.Kind is BoundBinaryOperatorKind.Equals or BoundBinaryOperatorKind.NotEquals)
                }
                if node.Right.Type is not NullableTypeSymbol rightNullable {
                    return false
                }
                // Same-type nullable (e.g. int32? + int32?, enum? | enum?) or
                // heterogeneous nullable for §11.10 enum arithmetic (e.g.
                // enum? + int32?, enum? - enum? → int32?). Both sides must be
                // value-type nullable; heterogeneous pairs are allowed because
                // the EnumOperatorTable permits different-typed operands.
                let leftNullable = cast[NullableTypeSymbol](node.Left.Type)
                if leftNullable != rightNullable && !NullableLifting.IsValueTypeNullable(rightNullable) {
                    return false
                }
                // Exclude operators whose value-type Nullable<T> emit is already
                // owned by dedicated collectors (NullCoalesce, NullAssertion).
                switch node.Op.Kind {
                    case BoundBinaryOperatorKind.Sum,
                    BoundBinaryOperatorKind.Difference,
                    BoundBinaryOperatorKind.Product,
                    BoundBinaryOperatorKind.Quotient,
                    BoundBinaryOperatorKind.Remainder,
                    BoundBinaryOperatorKind.BitwiseAnd,
                    BoundBinaryOperatorKind.BitwiseOr,
                    BoundBinaryOperatorKind.BitwiseXor,
                    BoundBinaryOperatorKind.BitClear,
                    BoundBinaryOperatorKind.ShiftLeft,
                    BoundBinaryOperatorKind.ShiftRight,
                    BoundBinaryOperatorKind.UnsignedShiftRight,
                    BoundBinaryOperatorKind.Equals,
                    BoundBinaryOperatorKind.NotEquals,
                    BoundBinaryOperatorKind.Less,
                    BoundBinaryOperatorKind.LessOrEquals,
                    BoundBinaryOperatorKind.Greater,
                    BoundBinaryOperatorKind.GreaterOrEquals {
                        return true
                    }
                    default {
                        return false
                    }
                }
            }
        }
    }

    // Issues #1236/#3518/#4741: lifted conversions spill a nullable value
    // source; value results additionally need a slot for default construction.
    private class NullableValueTypeConversionCollector : BoundTreeWalker {
        private let sink List[BoundExpression]

        init(sink List[BoundExpression]) {
            this.sink = sink
        }

        protected override func VisitConversionExpression(node BoundConversionExpression) {
            if IsLiftedNullableConversion(node.Expression.Type, node.Type) {
                this.sink.Add(node)
            }
            base.VisitConversionExpression(node)
        }

        protected override func VisitClrConversionCallExpression(node BoundClrConversionCallExpression) {
            if node.IsLifted {
                this.sink.Add(node)
            }
            base.VisitClrConversionCallExpression(node)
        }

        shared {
            private func IsLiftedNullableConversion(
                source TypeSymbol,
                target TypeSymbol
            ) bool -> source is NullableTypeSymbol from &&
                target is NullableTypeSymbol to &&
                from
                .UnderlyingType
                ?.ClrType is {IsValueType: true} &&
                to
                .UnderlyingType
                ?.ClrType is {IsValueType: true} &&
                from.UnderlyingType != to.UnderlyingType
        }
    }

    shared {
        // Issue #4966 (ADR-0202): whether a switch expression carries a value
        // in a result slot. A void switch (discarded position) and a switch
        // whose every arm exits (`never`) have none. The planner and the
        // emitter both call this so they agree on the slot.
        internal func SwitchExpressionHasResult(node BoundSwitchExpression) bool -> node.Type != TypeSymbol.Void &&
            node.Type != TypeSymbol.Never

        // Issue #1516: a `??` whose LHS is a bare reference-typed type
        // parameter (NOT wrapped in a `NullableTypeSymbol`). This shape arises
        // from `x as T ?? fallback` because `BoundAsExpression.Type` for a
        // reference target is the bare `T`. The opaque `!!T` stack value cannot
        // be probed with `dup; brtrue` (ECMA-335 III.1.8), so — exactly like
        // the Issue #831 `NullableTypeSymbol(TP)` path — the emitter spills the
        // LHS to a `T`-typed scratch slot and probes via `box !!T; brfalse`.
        // The collector and emitter both call this helper so they agree
        // precisely on which nodes need a pre-allocated slot.
        internal func IsReferenceTypeParameterCoalesceProbe(
            node BoundBinaryExpression,
            @NotNullWhen(true) out typeParameter TypeParameterSymbol?
        ) bool {
            if node
                .Op
                .Kind == BoundBinaryOperatorKind.NullCoalesce &&
                node
                .Left
                .Type is TypeParameterSymbol tp &&
                !tp.HasValueTypeConstraint {
                typeParameter = tp
                return true
            }
            typeParameter = nil
            return false
        }
    }
}

/// PR N-4 / §6.1 / C# §7.3.7: per-(cref:BoundBinaryExpression)
/// bundle of pre-allocated local slot indices that the body emitter
/// consumes when lowering a lifted binary operator over a value-type
/// `Nullable<T>`. Pre-allocated by (cref:SlotPlanner)'s
/// lifted-binary walker and stored in the per-method
/// `liftedBinarySlots` dictionary.
internal class LiftedBinarySlots {
    init(lhsSlot int32, rhsSlot int32, resultSlot int32) {
        this.LhsSlot = lhsSlot
        this.RhsSlot = rhsSlot
        this.ResultSlot = resultSlot
    }

    /// Gets the slot holding the spilled LHS `Nullable<T>`.
    prop LhsSlot int32 {
        get;
    }

    /// Gets the slot holding the spilled RHS `Nullable<T>`.
    prop RhsSlot int32 {
        get;
    }

    /// Gets the slot holding the result `Nullable<R>`, or `-1`
    /// when the lifted operator returns `bool` (equality / ordering).
    prop ResultSlot int32 {
        get;
    }
}
