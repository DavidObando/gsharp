// <copyright file="MethodBodyPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import GSharp.Core.CodeAnalysis
import System.Collections
import System.Runtime.CompilerServices
import System.Threading.Tasks.Sources

/// PR-E-12: per-method-body planning surface. Owns the orchestrators that
/// run (cref:SlotPlanner)'s collector classes against a method body
/// in dependency order and produce the slot/local/label/scratch tables that
/// (cref:MethodBodyEmitter)'s prelude consumes.
/// @remarks PR-E-4 introduced (cref:SlotPlanner) as the home of the 16
/// bound-tree-walker collector classes. This file is its companion: it
/// hosts the per-method orchestration (`CollectLocalsAndLabels`,
/// `CollectStatements`, `CollectPatternSwitchSlots`, the three
/// `Walk*` forwarders, `RegisterConstructedTypeAliases`,
/// `CollectConstValues`/`WalkStmtsForConsts`, the
/// `CollectLocalInfo`/`CollectLocalConstantInfo` PDB-shape
/// helpers, and the state-machine wiring helpers
/// `AddIteratorInterfaceImplementations`,
/// `AddAsyncIteratorInterfaceImplementations`,
/// `GetSmPackage`, and `TryGetUserKickoffReceiverHandle`).
///
/// What stays on (cref:ReflectionMetadataEmitter): the
/// `NeedsRvalueReceiverSpill` family of three predicates remain on
/// the root because they form the delegate that the root's constructor
/// supplies to (cref:SlotPlanner) (lifecycle ordering — the
/// planner cannot itself depend on the slot planner via the same delegate
/// without a bootstrap cycle).
///
/// Like every other PR-E-* component, (cref:MethodBodyPlanner) is
/// `internal sealed` and constructor-injected. It receives the same
/// (cref:EmitContext), (cref:MetadataTokenCache), and
/// (cref:SlotPlanner) as siblings plus delegate callbacks for the
/// few root helpers it queries ((cref:ReflectionMetadataEmitter)'s
/// `GetTypeReference`, `GetTypeHandleForMember`) and a
/// back-reference to the shared `lambdaBodies` dictionary and the
/// (cref:StateMachineEmitter) instance for plan lookups.
internal class MethodBodyPlanner {
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let slotPlanner SlotPlanner
    private let lambdaBodies Dictionary[FunctionSymbol, BoundBlockStatement]
    private let getTypeReference(Type) -> TypeReferenceHandle
    private let getTypeHandleForMember(Type) -> EntityHandle
    private let encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void
    private var stateMachines StateMachineEmitter?

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        slotPlanner SlotPlanner,
        lambdaBodies Dictionary[FunctionSymbol, BoundBlockStatement],
        getTypeReference(Type) -> TypeReferenceHandle,
        getTypeHandleForMember(Type) -> EntityHandle,
        encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void
    ) {
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.slotPlanner = slotPlanner ?? throw ArgumentNullException("slotPlanner")
        this.lambdaBodies = lambdaBodies ?? throw ArgumentNullException("lambdaBodies")
        this.getTypeReference = getTypeReference ?? throw ArgumentNullException("getTypeReference")
        this.getTypeHandleForMember = getTypeHandleForMember ?? throw ArgumentNullException("getTypeHandleForMember")
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw ArgumentNullException("encodeTypeSymbol")
    }

    /// Gets the state-machine emitter. Null only between construction and the
    /// wiring step in `ReflectionMetadataEmitter`, which runs before any
    /// body is planned.
    private prop StateMachines StateMachineEmitter -> Invariant.Required(
        this.stateMachines,
        "ReflectionMetadataEmitter wires the state-machine emitter into the planner before any body is planned",
        expression: "this.stateMachines"
    )

    /// Late-binds the (cref:StateMachineEmitter). `TryGetUserKickoffReceiverHandle`
    /// consults `stateMachines.AsyncStateMachinePlans`, and that
    /// component is created in `EmitCore` *after* this planner, so
    /// the wiring is completed via a setter rather than the constructor.
    func SetStateMachines(stateMachines StateMachineEmitter) {
        this.stateMachines = stateMachines ?? throw ArgumentNullException("stateMachines")
    }

    /// Resolves the package that a state-machine type's kickoff belongs to,
    /// for determining which `<Program>` TypeDef it nests inside.
    func GetSmPackage(
        smSym StructSymbol,
        packages ImmutableArray[PackageSymbol],
        entryPointPackage PackageSymbol?
    ) PackageSymbol? {
        // Try the SM's packageName to find the matching package.
        if smSym.PackageName != nil {
            for pkg in packages {
                if pkg.Name == smSym.PackageName {
                    return pkg
                }
            }
        }
        return entryPointPackage ??
            (
            if packages.IsDefaultOrEmpty {
                default(PackageSymbol?)
            } else {
                packages[0]
            }
        )
    }

    /// Issue #502: when an async kickoff method is declared as an instance or
    /// static member of a user-defined class, its synthesized state-machine
    /// type must be nested inside that class — not the per-package
    /// `<Program>` — so the kickoff method retains CLR access to
    /// the SM's `NestedPrivate` fields (most importantly
    /// `<>t__builder`). Lambda SMs already nest inside their
    /// closure class; this helper covers the named-method case.
    /// @param smSym The synthesized state-machine struct or class.
    /// @param enclosingHandle Set to the receiver type's TypeDef handle when applicable.
    /// @returns `true` when the SM should nest under a user receiver type.
    func TryGetUserKickoffReceiverHandle(smSym StructSymbol, out enclosingHandle TypeDefinitionHandle) bool {
        enclosingHandle = default(TypeDefinitionHandle)
        var kickoff FunctionSymbol? = nil
        for plan in this.StateMachines.AsyncStateMachinePlans {
            if object.ReferenceEquals(plan.StateMachine.MaterializeAsStructSymbol(), smSym) {
                kickoff = plan.KickoffMethod
                break
            }
        }
        // Issue #641: also check sync iterator and async iterator SM classes.
        if kickoff == nil {
            for kvp in this.StateMachines.IteratorStateMachineInfos {
                if object.ReferenceEquals(kvp.Key, smSym) {
                    kickoff = kvp.Value.Plan.Function
                    break
                }
            }
        }
        if kickoff == nil {
            for kvp in this.StateMachines.AsyncIteratorInfos {
                if object.ReferenceEquals(kvp.Key, smSym) {
                    kickoff = kvp.Value.Function
                    break
                }
            }
        }
        if kickoff == nil {
            return false
        }
        // Instance methods (ReceiverType set) and shared-block static methods
        // (StaticOwnerType set) both live on a user-defined class TypeDef.
        let owner StructSymbol? = (kickoff.ReceiverType as StructSymbol) ?? (kickoff.StaticOwnerType as StructSymbol)
        if owner == nil {
            return false
        }
        return this.cache.StructTypeDefs.TryGetValue(owner, out enclosingHandle)
    }

    /// The symbol counterpart of (cref:TryGetUserKickoffReceiverHandle):
    /// the user class or struct an async state machine is nested in, for
    /// building its serialized metadata name (ADR-0174 P3-8).
    /// @param smSym The state-machine struct.
    /// @param owner The declaring user type, when the kickoff is one of its methods.
    /// @returns `true` when the kickoff lives on a user type with an emitted TypeDef.
    func TryGetUserKickoffReceiverSymbol(smSym StructSymbol, @NotNullWhen(true) out owner StructSymbol?) bool {
        owner = nil
        var kickoff FunctionSymbol? = nil
        for plan in this.StateMachines.AsyncStateMachinePlans {
            if object.ReferenceEquals(plan.StateMachine.MaterializeAsStructSymbol(), smSym) {
                kickoff = plan.KickoffMethod
                break
            }
        }
        if kickoff == nil {
            return false
        }
        let candidate StructSymbol? = (kickoff.ReceiverType as StructSymbol) ??
            (kickoff.StaticOwnerType as StructSymbol)
        if candidate == nil || !this.cache.StructTypeDefs.ContainsKey(candidate) {
            return false
        }
        owner = candidate
        return true
    }

    func CollectLocalsAndLabels(
        body BoundBlockStatement,
        function FunctionSymbol?,
        locals Dictionary[VariableSymbol, int32],
        localTypes List[TypeSymbol],
        labels Dictionary[BoundLabel, LabelHandle],
        structLiteralSlots Dictionary[BoundStructLiteralExpression, int32],
        defaultExpressionSlots Dictionary[BoundDefaultExpression, int32],
        mapIndexSlots Dictionary[BoundIndexExpression, int32],
        patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32],
        typePatternScratchSlots Dictionary[BoundTypePattern, int32],
        switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)],
        channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)],
        receiverSpillSlots Dictionary[BoundExpression, int32],
        indexAssignmentValueSlots Dictionary[BoundExpression, int32],
        liftedBinarySlots Dictionary[BoundExpression, LiftedBinarySlots],
        nullableCoalesceSpillSlots Dictionary[BoundBinaryExpression, int32],
        il InstructionEncoder,
        stackAllocResultSlots Dictionary[BoundStackAllocExpression, int32]? = nil,
        plannerScratch PlannerScratch? = nil
    ) {
        let scratch = plannerScratch ?? PlannerScratch()
        CompilationMeasurements.Count(
            if scratch.Clears > 0 {
                "emit.planner-scratch.reused"
            } else {
                "emit.planner-scratch.fresh"
            }
        )
        this.CollectStatements(body.Statements, function, locals, localTypes, labels, il, pass: 1)
        this.CollectBlockExpressionLocals(body, locals, localTypes)
        this.CollectStatements(body.Statements, function, locals, localTypes, labels, il, pass: 2)
        // Phase B: pattern switch statements bring three classes of locals
        // into the host method:
        //   * one discriminant temp per switch (typed as the discriminant
        //     expression's type),
        //   * one object-typed scratch per type pattern (holds the isinst
        //     result before the brfalse to the next-arm label),
        //   * any locals declared by arm bodies and by the type-pattern
        //     arm-local bindings — these need pre-allocation because the
        //     pre-scan above does not descend into pattern-switch arms.
        this.CollectPatternSwitchSlots(
            body.Statements,
            locals,
            localTypes,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots
        )
        // Phase 3.C.3b: each `?.` access introduces a synthetic capture
        // local in the bound tree; pre-allocate a slot for it.
        for nc in this.CollectNullConditionalCaptures(body, scratch) {
            if !locals.ContainsKey(nc.Capture) {
                locals[nc.Capture] = localTypes.Count
                localTypes.Add(nc.Capture.Type)
            }
            // P2-7 / Issue #421: value-type access results need a
            // Nullable<T> result slot so the nil branch can emit
            // `ldloca; initobj Nullable<T>; ldloc` and so the not-null
            // branch can wrap the raw T via `newobj Nullable<T>::.ctor(!0)`.
            if nc.ResultSlot != nil && !locals.ContainsKey(nc.ResultSlot) {
                locals[nc.ResultSlot] = localTypes.Count
                localTypes.Add(nc.ResultSlot!!.Type)
            }
            // Issue #1700: a value-type `Nullable<T>` receiver (e.g. a
            // struct/enum `T?`) cannot share `nc.Capture`'s slot — that slot
            // is declared as the unwrapped `T` (so member-access binding
            // resolves against `T`, not `Nullable<T>`), but the receiver
            // expression pushes the real `Nullable<T>` wrapper. Storing that
            // wrapper into the `T`-typed capture slot, then `brtrue`-ing the
            // reloaded `T` struct, is invalid IL (ilverify StackUnexpected)
            // regardless of whether an `await` is involved — this is the
            // root cause, not just the await-spilled shape. Pre-allocate a
            // second, `Nullable<T>`-typed scratch slot (keyed by nc.Receiver,
            // mirroring the `!!`/`??` value-type spill slots) so the emitter
            // can store the real wrapper, probe `HasValue` off its address,
            // and only then unwrap into `nc.Capture` on the non-nil path.
            if nc.Receiver.Type is NullableTypeSymbol receiverNullable && NullableLifting.IsAnyValueTypeNullable(
                receiverNullable
            ) &&
                !receiverSpillSlots
                .ContainsKey(nc.Receiver) {
                let wrapperSlot = localTypes.Count
                localTypes.Add(nc.Receiver.Type)
                receiverSpillSlots[nc.Receiver] = wrapperSlot
            }
        }
        for literal in this.CollectStructLiterals(body, scratch) {
            // Class literals do not need a pre-allocated local slot — they
            // use newobj rather than initobj-into-a-slot.
            if literal.StructType.IsClass {
                continue
            }
            let slot = localTypes.Count
            localTypes.Add(literal.StructType)
            Debug.Assert(
                !structLiteralSlots.ContainsKey(literal),
                "Bound struct literal node aliased across emit positions; rekey structLiteralSlots by (node, parentContext) if lowering ever shares nodes."
            )
            structLiteralSlots[literal] = slot
        }
        // Phase 3.A.4 emit: each map index READ lowers to a Dictionary.TryGetValue
        // pattern that needs a V-typed scratch local for the out parameter so that
        // missing keys yield the Go zero value (matching the interpreter).
        for idx in this.CollectMapIndexReads(body, scratch) {
            let slot = localTypes.Count
            localTypes.Add(idx.Type)
            Debug.Assert(
                !mapIndexSlots.ContainsKey(idx),
                "Bound map index expression aliased across emit positions; rekey mapIndexSlots by (node, parentContext) if lowering ever shares nodes."
            )
            mapIndexSlots[idx] = slot
        }
        // BoundDefaultExpression for non-primitive value types needs a temp local
        // for the ldloca/initobj/ldloc pattern (push-as-value path).
        // Issue #774: type-parameter and erased open-generic defaults also need
        // a slot — at compile time we don't know whether the substituted
        // argument is a reference or value type, and `ldnull` is invalid for
        // any value-type instantiation. The `ldloca tmp; initobj T; ldloc tmp`
        // shape zero-inits the storage uniformly (null for ref types, zeroed
        // bytes for value types) and IL-verifies for every closed argument.
        for def in this.CollectDefaultExpressions(body, scratch) {
            let needsSlot = ReflectionMetadataEmitter.IsValueTypeSymbol(def.Type) ||
                def.Type is TypeParameterSymbol ||
                (def.Type is ImportedTypeSymbol erasedGen && erasedGen.HasTypeParameterArgument) ||
                (def.Type is NullableTypeSymbol nullableDef && nullableDef.UnderlyingType is TypeParameterSymbol)
            if !needsSlot {
                continue
            }
            // Primitive value types (int, bool) are handled with ldc.i4.0 — no slot needed.
            if def.Type == TypeSymbol.Int32 || def.Type == TypeSymbol.Bool {
                continue
            }
            let slot = localTypes.Count
            localTypes.Add(def.Type)
            Debug.Assert(
                !defaultExpressionSlots.ContainsKey(def),
                "Bound default expression aliased across emit positions; rekey defaultExpressionSlots by (node, parentContext) if lowering ever shares nodes."
            )
            defaultExpressionSlots[def] = slot
        }
        // ADR-0124 / issue #1024: each `stackalloc [n]T` needs an int32 scratch
        // local to hold the element count. The count is evaluated once into the
        // temp; the emitter then reads it for both the byte-size computation
        // (count * sizeof(T) feeding `localloc`) and, for the safe Span<T> form,
        // the `Span<T>(void*, int)` length argument (the pointer produced by
        // `localloc` must sit beneath the length on the stack, and CIL has no
        // swap). Reuse receiverSpillSlots — keyed by the stackalloc node it
        // cannot collide with any receiver/assignment spill.
        for sa in this.CollectStackAllocs(body, scratch) {
            if receiverSpillSlots.ContainsKey(sa) {
                continue
            }
            let slot = localTypes.Count
            localTypes.Add(TypeSymbol.Int32)
            receiverSpillSlots[sa] = slot
        }
        // Issue #1522: a `stackalloc` used as a sub-expression (method/ctor
        // argument, or any operand evaluated with a non-empty stack) must be
        // spilled to a result local so its `localloc` runs at an empty stack
        // (ECMA-335 III.3.47). Reserve a result-typed local — `Span<T>` for the
        // safe form or `T*`/`void*` for the pointer form — for every stackalloc
        // that is NOT in a statement-root (stack-empty) position. The emitter
        // materialises the localloc into this local at an empty-stack point and
        // then loads it at the original operand position. `.locals init`
        // zero-inits the block and the localloc lifetime is the whole frame, so
        // spilling the Span/pointer to a local is safe.
        if stackAllocResultSlots != nil {
            let rootStackAllocs = this.CollectRootStackAllocs(body, scratch)
            for sa in this.CollectStackAllocs(body, scratch) {
                if rootStackAllocs.Contains(sa) || stackAllocResultSlots.ContainsKey(sa) {
                    continue
                }
                let slot = localTypes.Count
                localTypes.Add(sa.Type)
                stackAllocResultSlots[sa] = slot
            }
        }
        for receiver in this.CollectReceiverSpills(body, function, locals, scratch) {
            if receiverSpillSlots.ContainsKey(receiver) {
                continue
            }
            let slot = localTypes.Count
            localTypes.Add(receiver.Type)
            receiverSpillSlots[receiver] = slot
        }
        // Issue #418 (P1-1): each index-assignment expression needs a scratch
        // local typed as the value's type. The emit sites use dup + stloc tmp
        // + store + ldloc tmp so the index/argument expressions are evaluated
        // exactly once even though the assignment expression's result is the
        // assigned value.
        for ixa in this.CollectIndexAssignmentValueSpills(body, scratch) {
            if indexAssignmentValueSlots.ContainsKey(ixa) {
                continue
            }
            let slot = localTypes.Count
            localTypes.Add(ixa.Type)
            indexAssignmentValueSlots[ixa] = slot
        }
        // Issue #418 (P1-2): property and CLR-property assignments yield the
        // assigned value as their expression result. Previously the emitter
        // re-evaluated the receiver and called the getter to produce that
        // result, evaluating any side-effecting receiver expression twice
        // (e.g. `Make().P = v` invoked `Make()` for the setter, then again
        // for the getter). Pre-allocate a value-typed local for each such
        // assignment so the emitter can `dup; stloc tmp; call set_X; ldloc
        // tmp` instead. The slot is keyed by the assignment expression so it
        // does not collide with receiver-spill entries (which are keyed by
        // the receiver subexpression).
        for assn in this.CollectAssignmentValueSpills(body, scratch) {
            if receiverSpillSlots.ContainsKey(assn) {
                continue
            }
            let slot = localTypes.Count
            localTypes.Add(assn.Type)
            receiverSpillSlots[assn] = slot
        }
        // Issue #504 / #2544: `!!` and lifted unary operators on a value-type
        // `Nullable<T>` need a `Nullable<T>` spill so emit can call
        // HasValue/get_Value from its address. Reuse receiverSpillSlots — the
        // dictionary already aggregates several distinct-by-node-identity
        // scratch-slot kinds (receiver spills and assignment-value spills).
        //
        // Issue #1591: the slot is keyed by the unwrap's OPERAND node, NOT by
        // the BoundUnaryExpression node itself. When the smart-cast-narrowed
        // `!!` result is used as the receiver of a value-type instance call
        // (`x.ToString()` after an `if x == nil` guard), the receiver-spill
        // collector above independently keys an underlying-`T`-typed
        // ldloca-address slot on the SAME BoundUnaryExpression node. Keying
        // the unwrap on the unary node too made the two slots collapse into
        // one (the receiver-address `T` slot won, being collected first), so
        // the `get_Value` spill stored the `Nullable<T>` struct into a `T`
        // slot and read a default-initialized value — silently printing the
        // underlying type's default (0 / first enum member). Keying on the
        // operand node keeps the `Nullable<T>` spill slot distinct from the
        // receiver-address slot. The slot is typed as the operand's
        // NullableTypeSymbol, which `EncodeTypeSymbol` lowers to
        // `System.Nullable<T>` in the local-sig blob.
        for unwrap in this.CollectNullableValueTypeUnwraps(body, scratch) {
            if receiverSpillSlots.ContainsKey(unwrap.Operand) {
                continue
            }
            let slot = localTypes.Count
            localTypes.Add(unwrap.Operand.Type)
            receiverSpillSlots[unwrap.Operand] = slot
        }
        // Issue #519 / #752 / ADR-0084 L3: `??` whose LHS is a value-type
        // `Nullable<T>` lowers at emit time to a HasValue/GetValueOrDefault
        // sequence that needs a `Nullable<T>`-typed temp slot (it cannot
        // use `dup; brtrue`, which is invalid IL for value-type stack
        // shapes). The slot is keyed by the binary expression node and
        // typed as the LHS's NullableTypeSymbol so EncodeTypeSymbol emits
        // the proper `System.Nullable<T>` token.
        //
        // The slot lives in its OWN dictionary (separate from
        // `receiverSpillSlots`) because the same binary node may also be
        // the receiver of an instance call — `(v ?? 0).ToString()` — in
        // which case the receiver-spill collector independently
        // allocates an underlying-`T`-typed slot to take `ldloca` of the
        // call receiver. Conflating the two slots in one dictionary
        // produced invalid IL (issue #752): the receiver slot's type
        // overwrote the Nullable<T> spill type and the HasValue call
        // received the wrong receiver address.
        for coalesce in this.CollectNullableValueTypeCoalesces(body, scratch) {
            if nullableCoalesceSpillSlots.ContainsKey(coalesce) {
                continue
            }
            let slot = localTypes.Count
            localTypes.Add(coalesce.Left.Type)
            nullableCoalesceSpillSlots[coalesce] = slot
        }
        // PR N-4 / §6.1 / C# §7.3.7: lifted binary operators over a value-
        // type Nullable<T>. Each call site needs two Nullable<T>-typed
        // operand slots (LHS, RHS) so the emitter can take their addresses
        // for `call get_HasValue` / `call get_Value`. Arithmetic / bitwise
        // operators additionally need a Nullable<R>-typed result slot for
        // the null-branch `ldloca; initobj Nullable<R>; ldloc` shape;
        // equality / ordering operators return bool and need no result
        // slot. The slot bundle is keyed by the lifted expression node
        // (a BoundBinaryExpression from the built-in operator table, or —
        // issue #2388 — a BoundClrBinaryOperatorExpression from a
        // nullable-lifted Stream C/D custom operator) and stored in
        // liftedBinarySlots so the emitter can look it up at lowering time.
        // Skip nodes already owned by other collectors (NullCoalesce uses
        // receiverSpillSlots) to avoid double allocation.
        for lifted in this.CollectLiftedBinaryOperators(body, scratch) {
            if liftedBinarySlots.ContainsKey(lifted) {
                continue
            }
            let (liftedLeft, liftedRight, liftedType) = DecomposeLiftedBinary(lifted)
            let lhsSlot = localTypes.Count
            localTypes.Add(liftedLeft.Type)
            // `value-type Nullable<T> == nil` / `!= nil` only needs an
            // LHS spill slot; the RHS is the `nil` literal (no temp
            // required) and the result is bool (no result slot). Issue
            // #2388: a lifted BoundClrBinaryOperatorExpression never has a
            // `nil` RHS (see IsLiftedValueTypeClrBinary), so this branch is
            // only ever taken for the built-in-operator-table shape.
            var rhsSlot = -1
            var resultSlot = -1
            if liftedRight.Type != TypeSymbol.Null {
                rhsSlot = localTypes.Count
                localTypes.Add(liftedRight.Type)
                if liftedType is NullableTypeSymbol {
                    resultSlot = localTypes.Count
                    localTypes.Add(liftedType)
                }
            }
            liftedBinarySlots[lifted] = LiftedBinarySlots(lhsSlot, rhsSlot, resultSlot)
        }
        // Issues #1236/#3518/#4741: each lifted Nullable<T1> -> Nullable<T2>
        // conversion needs two consecutive scratch slots — the source
        // Nullable<T1> (spilled so the emitter can take its address for
        // get_HasValue / get_Value) and a result Nullable<T2> (to
        // initobj a default value on the null branch). The slot index of the
        // source is stored in receiverSpillSlots (already an aggregate of
        // distinct-by-node scratch-slot kinds); the emitter derives the result
        // slot as source + 1. Reference-result lifts share the source spill;
        // type-parameter results use a typed default, others produce ldnull.
        // Skip nodes already owned by another collector.
        for conversion in this.CollectNullableValueTypeConversions(body, scratch) {
            if receiverSpillSlots.ContainsKey(conversion) {
                continue
            }
            let source = switch conversion {
                case builtIn is BoundConversionExpression: builtIn.Expression
                case clr is BoundClrConversionCallExpression: clr.Source
                default: throw InvalidOperationException(
                    "Unexpected lifted nullable conversion node '${conversion.Kind}'."
                )
            }
            let srcSlot = localTypes.Count
            localTypes.Add(source.Type)
            localTypes.Add(conversion.Type)
            receiverSpillSlots[conversion] = srcSlot
        }
    }

    // Phase B: walks the bound body to find every BoundPatternSwitchStatement
    // (including those nested inside arm bodies, if/for branches, try/catch
    // blocks, and BoundBlockExpression statement lists). For each switch,
    // pre-allocates:
    //   * one local slot for the discriminant temp,
    //   * one object-typed scratch slot per TypePattern under any arm,
    //   * arm-local TypePattern.Variable slots, and
    //   * any locals declared inside arm body BoundBlockStatements.
    private func CollectPatternSwitchSlots(
        statements ImmutableArray[BoundStatement],
        locals Dictionary[VariableSymbol, int32],
        localTypes List[TypeSymbol],
        patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32],
        typePatternScratchSlots Dictionary[BoundTypePattern, int32],
        switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)],
        channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)]
    ) {
        for s in statements {
            this.WalkForPatternSwitches(
                s,
                locals,
                localTypes,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots
            )
        }
    }

    private func WalkForPatternSwitches(
        statement BoundStatement,
        locals Dictionary[VariableSymbol, int32],
        localTypes List[TypeSymbol],
        patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32],
        typePatternScratchSlots Dictionary[BoundTypePattern, int32],
        switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)],
        channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)]
    ) {
        // Issue #418 (P1-3): the legacy bespoke switch missed many expression
        // kinds (tuple/map literals, ?., CLR calls/indexers/properties,
        // indirect calls, nested switch expressions, etc.). Use a default-
        // recurse walker so every BoundExpression kind is visited and any
        // nested pattern switch / switch expression / channel op / scope /
        // select gets its slot pre-allocated.
        this.slotPlanner.RunPatternSwitchAllocator(
            statement,
            locals,
            localTypes,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots
        )
    }

    private func CollectBlockExpressionLocals(
        body BoundBlockStatement,
        locals Dictionary[VariableSymbol, int32],
        localTypes List[TypeSymbol]
    ) {
        let collected = List[VariableSymbol]()
        this.slotPlanner.CollectBlockExpressionLocals(body, collected)
        for variable in collected {
            if !locals.ContainsKey(variable) {
                locals[variable] = localTypes.Count
                localTypes.Add(
                    if variable is LocalVariableSymbol{RefKind: not RefKind.None} alias {
                        cast[TypeSymbol](ByRefTypeSymbol.Get(alias.Type))
                    } else {
                        variable.Type
                    }
                )
            }
        }
    }

    private func CollectStructLiterals(body BoundBlockStatement, scratch PlannerScratch) IEnumerable[
        BoundStructLiteralExpression
    ] {
        let list = scratch.StructLiterals
        list.Clear()
        for s in body.Statements {
            this.slotPlanner.CollectStructLiterals(s, list)
        }
        return list
    }

    // Phase 4 emit parity (E1): walk every user function body to collect all
    // BoundFunctionLiteralExpression nodes. Class instance method bodies are
    // included too. The collector uses BoundTreeRewriter so it reaches every
    // expression position; the base rewriter does not descend into the lambda's
    // body (separate lexical scope), so we recurse on Body explicitly to find
    // nested lambdas.
    func CollectFunctionLiterals() List[BoundFunctionLiteralExpression] -> this.slotPlanner.CollectFunctionLiterals()

    func CollectGoStatements() List[BoundGoStatement] -> this.slotPlanner.CollectGoStatements()

    // Phase 4 emit parity (F2, type-erased generic user types): discover
    // every constructed StructSymbol referenced in the bound program
    // (function bodies, class methods, and lambda bodies) and alias it to
    // its definition's TypeDef, ctor, primary-ctor, and per-field FieldDef
    // rows. Emission sites can then do plain dictionary lookups regardless
    // of whether the type is open, constructed, or already a non-generic
    // symbol.
    func RegisterConstructedTypeAliases() {
        let collector = ClosureEmitter.ConstructedTypeCollector()
        // Issue #4663: deterministic order, never identity-hash order.
        for kvp in BoundProgramOrder.Functions(this.emitCtx.Program) {
            collector.RewriteStatement(kvp.Value)
        }
        for body in this.lambdaBodies.Values {
            collector.RewriteStatement(body)
        }
        for constructed in collector.Constructed {
            let def StructSymbol? = constructed.Definition
            if def == nil || def == constructed {
                continue
            }
            if this.cache.StructTypeDefs.TryGetValue(def, out var td) {
                this.cache.StructTypeDefs[constructed] = td
            }
            if this.cache.ClassCtorHandles.TryGetValue(def, out var cc) {
                this.cache.ClassCtorHandles[constructed] = cc
            }
            if this.cache.ClassPrimaryCtorHandles.TryGetValue(def, out var pc) {
                this.cache.ClassPrimaryCtorHandles[constructed] = pc
            }
            for cf in constructed.Fields {
                var df FieldSymbol? = nil
                for candidate in def.Fields {
                    if candidate.Name == cf.Name {
                        df = candidate
                        break
                    }
                }
                if df != nil && this.cache.StructFieldDefs.TryGetValue(df, out var fd) {
                    this.cache.StructFieldDefs[cf] = fd
                }
            }
        }
    }

    func AddIteratorInterfaceImplementations(smClass StructSymbol, info StateMachineEmitter.IteratorStateMachineInfo) {
        let elementType = info.Plan.ElementType
        let typeDef = this.cache.StructTypeDefs[smClass]
        // Issue #810: when the iterator's element type contains an outer
        // method type parameter (now remapped to a class-level Var on the
        // SM), encode `IEnumerable<T>` / `IEnumerator<T>` as a TypeSpec
        // whose argument flows through EncodeTypeSymbol (which honours the
        // active iterator-state-machine remap pushed by the SM-class emit
        // loop in RME — outer-method TPs translate to Var(idx)). For closed
        // element types we keep the original CLR-erased path so existing
        // closed-iterator behaviour is unchanged.
        // Issue #990: a user-declared element type (a `class` or `data
        // struct` emitted in this same assembly) has no ClrType, so the
        // CLR-erased `MakeGenericType(elementType.ClrType ?? object)` path
        // below would record `IEnumerable<object>` / `IEnumerator<object>`
        // on the SM class. That makes `shapes()` (signature
        // `IEnumerable<Shape>`) return a value whose runtime type only
        // implements `IEnumerable<object>` — invalid under generic
        // invariance (ilverify StackUnexpected). Route such element types
        // through the symbolic TypeSpec encoder (which emits a real
        // reference to the user TypeDef) so the interface rows carry the
        // strongly-typed `IEnumerable<Shape>` / `IEnumerator<Shape>`.
        // Hold the reified CLR element type rather than a bare
        // `needs symbolic` flag: the reified branch below needs the value, and
        // a separate bool cannot carry the fact that it is present.
        let elementClr Type? = if TypeSymbol.RequiresSymbolicProjection(elementType) ||
            (elementType is NullableTypeSymbol and {UnderlyingType: {ClrType: {IsValueType: true}}}) {
            default(Type?)
        } else {
            elementType.ClrType
        }
        var enumerableHandle EntityHandle
        var enumeratorHandle EntityHandle
        if elementClr == nil {
            enumerableHandle = this.BuildGenericInterfaceTypeSpec(
                typeof(System.Collections.Generic.IEnumerable[_]),
                elementType
            )
            enumeratorHandle = this.BuildGenericInterfaceTypeSpec(
                typeof(System.Collections.Generic.IEnumerator[_]),
                elementType
            )
        } else {
            enumerableHandle = this.getTypeHandleForMember(
                typeof(System.Collections.Generic.IEnumerable[_]).MakeGenericType(elementClr)
            )
            enumeratorHandle = this.getTypeHandleForMember(
                typeof(System.Collections.Generic.IEnumerator[_]).MakeGenericType(elementClr)
            )
        }
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, enumerableHandle)
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, enumeratorHandle)
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, this.getTypeReference(typeof(IDisposable)))
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, this.getTypeReference(typeof(IEnumerable)))
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, this.getTypeReference(typeof(IEnumerator)))
    }

    /// Issue #810: builds a `TypeSpec` handle encoding
    /// [`openDef`](paramref)<[`elementType`](paramref)>
    /// where the element type is encoded through
    /// (cref:SignatureEncoder.EncodeTypeSymbol) so the
    /// active iterator-state-machine remap (outer-method TP →
    /// class-TP Var(idx)) is honoured. Used by
    /// (cref:AddIteratorInterfaceImplementations).
    private func BuildGenericInterfaceTypeSpec(openDef Type, elementType TypeSymbol) EntityHandle {
        let openHandle = this.getTypeReference(openDef)
        let sigBlob = BlobBuilder()
        let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
        let gi = encoder.GenericInstantiation(openHandle, genericArgumentCount: 1, isValueType: false)
        this.encodeTypeSymbol(gi.AddArgument(), elementType)
        return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    func AddAsyncIteratorInterfaceImplementations(smClass StructSymbol, plan AsyncIteratorPlan) {
        let elementType = plan.ElementType
        let typeDef = this.cache.StructTypeDefs[smClass]
        // Issue #1002/#3412 (parallel to #990): an element containing a
        // same-compilation user type can have no ClrType or an object-erased
        // constructed ClrType, so the CLR-projected
        // `MakeGenericType(elementType.ClrType ?? object)` path below would
        // record `IAsyncEnumerable<object>` / `IAsyncEnumerator<object>` on
        // the SM class. That makes `shapes()` (signature
        // `IAsyncEnumerable<Shape>`) return a value whose runtime type only
        // implements `IAsyncEnumerable<object>` — invalid under generic
        // invariance (ilverify StackUnexpected). Route such element types
        // through the symbolic TypeSpec encoder so the interface rows
        // carry the strongly-typed `IAsyncEnumerable<Shape>` /
        // `IAsyncEnumerator<Shape>`.
        // See AddIteratorInterfaceImplementations: hold the reified CLR element
        // type rather than a `needs symbolic` flag.
        let elementClr Type? = if TypeSymbol.RequiresSymbolicProjection(elementType) ||
            (elementType is NullableTypeSymbol and {UnderlyingType: {ClrType: {IsValueType: true}}}) {
            default(Type?)
        } else {
            elementType.ClrType
        }
        var asyncEnumeratorHandle EntityHandle
        var asyncEnumerableHandle EntityHandle
        if elementClr == nil {
            asyncEnumeratorHandle = this.BuildGenericInterfaceTypeSpec(
                typeof(System.Collections.Generic.IAsyncEnumerator[_]),
                elementType
            )
            asyncEnumerableHandle = this.BuildGenericInterfaceTypeSpec(
                typeof(System.Collections.Generic.IAsyncEnumerable[_]),
                elementType
            )
        } else {
            asyncEnumeratorHandle = this.getTypeHandleForMember(
                typeof(System.Collections.Generic.IAsyncEnumerator[_]).MakeGenericType(elementClr)
            )
            asyncEnumerableHandle = this.getTypeHandleForMember(
                typeof(System.Collections.Generic.IAsyncEnumerable[_]).MakeGenericType(elementClr)
            )
        }
        // IAsyncEnumerator<T>
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, asyncEnumeratorHandle)
        // IAsyncDisposable
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, this.getTypeHandleForMember(typeof(IAsyncDisposable)))
        if plan.IsEnumerable {
            // IAsyncEnumerable<T>
            this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, asyncEnumerableHandle)
        }
        // IValueTaskSource<bool>
        this
            .emitCtx
            .Metadata
            .AddInterfaceImplementation(typeDef, this.getTypeHandleForMember(typeof(IValueTaskSource[bool])))
        // IAsyncStateMachine (required by AsyncIteratorMethodBuilder.MoveNext<TSM> constraint)
        this
            .emitCtx
            .Metadata
            .AddInterfaceImplementation(typeDef, this.getTypeHandleForMember(typeof(IAsyncStateMachine)))
    }

    private func CollectStatements(
        statements ImmutableArray[BoundStatement],
        function FunctionSymbol?,
        locals Dictionary[VariableSymbol, int32],
        localTypes List[TypeSymbol],
        labels Dictionary[BoundLabel, LabelHandle],
        il InstructionEncoder,
        pass int32
    ) {
        for s in statements {
            if pass == 1 {
                switch s {
                    case decl is BoundVariableDeclaration {
                        // Issue #191: a GlobalVariableSymbol with a registered
                        // FieldDef stores into <Program>'s static field via
                        // stsfld; do not also allocate a local slot for it.
                        if decl.Variable is GlobalVariableSymbol gv && this.cache.GlobalFieldDefs.ContainsKey(gv) {
                            break
                        }
                        // Issue #216: compile-time const bindings are inlined at
                        // every read site — no IL slot is needed.
                        if decl.ConstantValue != nil {
                            break
                        }
                        RegisterLocal(decl.Variable, locals, localTypes)
                    }
                    case lbl is BoundLabelStatement {
                        RegisterLabel(lbl.Label, labels, il)
                    }
                    case fx is BoundFixedStatement {
                        if fx.Body is BoundBlockStatement fxBlock {
                            this.CollectStatements(fxBlock.Statements, function, locals, localTypes, labels, il, pass)
                        }
                    }
                    case ps is BoundPatternSwitchStatement {
                        // Issue #1515: the label/local pre-pass must descend into
                        // pattern-switch arm bodies. Loop lowering (and other
                        // label-generating constructs) inside an arm emits branch
                        // labels (Label*, check*, continue/break) that
                        // EmitPatternSwitchStatement later branches to; without this
                        // recursion those labels are never DefineLabel'd and the
                        // `labels[target]` lookup throws KeyNotFoundException.
                        // Nested locals declared inside arm bodies are also
                        // allocated here, but the `!locals.ContainsKey` guards keep
                        // this consistent with CollectPatternSwitchSlots (which
                        // separately allocates the switch discriminant temp, type-
                        // pattern scratch slots and pattern-binding locals).
                        for arm in ps.Arms {
                            this.CollectArmBody(arm.Body, function, locals, localTypes, labels, il, pass)
                        }
                    }
                    case t is BoundTryStatement {
                        this.CollectStatements(
                            (cast[BoundBlockStatement](t.TryBlock)).Statements,
                            function,
                            locals,
                            localTypes,
                            labels,
                            il,
                            pass
                        )
                        for clause in t.CatchClauses {
                            // Issue #420 (P3-6): tolerate an elided catch variable
                            // in the local-slot pre-pass (the corresponding emit-
                            // time path in EmitCatchClauses emits a defensive
                            // `pop` to maintain stack balance).
                            if clause.Variable != nil && !locals.ContainsKey(clause.Variable) {
                                locals[clause.Variable] = localTypes.Count
                                localTypes.Add(clause.Variable!!.Type)
                            }
                            this.CollectStatements(
                                (cast[BoundBlockStatement](clause.Body)).Statements,
                                function,
                                locals,
                                localTypes,
                                labels,
                                il,
                                pass
                            )
                        }
                        if t.FinallyBlock != nil {
                            this.CollectStatements(
                                (cast[BoundBlockStatement](t.FinallyBlock)).Statements,
                                function,
                                locals,
                                localTypes,
                                labels,
                                il,
                                pass
                            )
                        }
                    }
                    case nestedBlock is BoundBlockStatement {
                        this.CollectStatements(nestedBlock.Statements, function, locals, localTypes, labels, il, pass)
                    }
                }
            } else {
                switch s {
                    case g is BoundGotoStatement {
                        RegisterLabel(g.Label, labels, il)
                    }
                    case cg is BoundConditionalGotoStatement {
                        RegisterLabel(cg.Label, labels, il)
                    }
                    case fx is BoundFixedStatement {
                        if fx.Body is BoundBlockStatement fxBlock {
                            this.CollectStatements(fxBlock.Statements, function, locals, localTypes, labels, il, pass)
                        }
                    }
                    case ps is BoundPatternSwitchStatement {
                        // Issue #1515: register goto/conditional-goto labels emitted
                        // by constructs nested inside pattern-switch arm bodies (see
                        // the pass==1 branch above for the full rationale).
                        for arm in ps.Arms {
                            this.CollectArmBody(arm.Body, function, locals, localTypes, labels, il, pass)
                        }
                    }
                    case t is BoundTryStatement {
                        this.CollectStatements(
                            (cast[BoundBlockStatement](t.TryBlock)).Statements,
                            function,
                            locals,
                            localTypes,
                            labels,
                            il,
                            pass
                        )
                        for clause in t.CatchClauses {
                            this.CollectStatements(
                                (cast[BoundBlockStatement](clause.Body)).Statements,
                                function,
                                locals,
                                localTypes,
                                labels,
                                il,
                                pass
                            )
                        }
                        if t.FinallyBlock != nil {
                            this.CollectStatements(
                                (cast[BoundBlockStatement](t.FinallyBlock)).Statements,
                                function,
                                locals,
                                localTypes,
                                labels,
                                il,
                                pass
                            )
                        }
                    }
                    case nestedBlock is BoundBlockStatement {
                        this.CollectStatements(nestedBlock.Statements, function, locals, localTypes, labels, il, pass)
                    }
                }
            }
        }
    }

    /// Issue #1515: recurse the label/local pre-pass into a pattern-switch arm
    /// body. Arm bodies are normally (cref:BoundBlockStatement), but a
    /// non-block statement is tolerated by wrapping it so that any nested
    /// label-generating construct (loops, nested switches, try/finally, scope,
    /// select, fixed, …) at any depth is still visited.
    private func CollectArmBody(
        armBody BoundStatement?,
        function FunctionSymbol?,
        locals Dictionary[VariableSymbol, int32],
        localTypes List[TypeSymbol],
        labels Dictionary[BoundLabel, LabelHandle],
        il InstructionEncoder,
        pass int32
    ) {
        if armBody == nil {
            return
        }
        if armBody is BoundBlockStatement armBlock {
            this.CollectStatements(armBlock.Statements, function, locals, localTypes, labels, il, pass)
        } else {
            this.CollectStatements(ImmutableArray.Create(armBody), function, locals, localTypes, labels, il, pass)
        }
    }

    private func CollectMapIndexReads(root BoundNode, scratch PlannerScratch) IEnumerable[BoundIndexExpression] {
        let sink = scratch.MapIndexReads
        sink.Clear()
        this.slotPlanner.CollectMapIndexReads(cast[BoundStatement](root), sink)
        return sink
    }

    private func CollectIndexAssignmentValueSpills(root BoundNode, scratch PlannerScratch) IEnumerable[
        BoundExpression
    ] {
        let sink = scratch.IndexAssignmentValueSpills
        sink.Clear()
        this.slotPlanner.CollectIndexAssignmentValueSpills(cast[BoundStatement](root), sink)
        return sink
    }

    private func CollectDefaultExpressions(root BoundNode, scratch PlannerScratch) IEnumerable[BoundDefaultExpression] {
        let sink = scratch.DefaultExpressions
        sink.Clear()
        this.slotPlanner.CollectDefaultExpressions(cast[BoundStatement](root), sink)
        return sink
    }

    private func CollectStackAllocs(root BoundNode, scratch PlannerScratch) IEnumerable[BoundStackAllocExpression] {
        let sink = scratch.StackAllocs
        sink.Clear()
        this.slotPlanner.CollectStackAllocs(cast[BoundStatement](root), sink)
        return sink
    }

    private func CollectRootStackAllocs(root BoundNode, scratch PlannerScratch) HashSet[BoundStackAllocExpression] {
        let sink = scratch.RootStackAllocs
        sink.Clear()
        this.slotPlanner.CollectRootStackAllocs(cast[BoundStatement](root), sink)
        return sink
    }

    private func CollectReceiverSpills(
        root BoundNode,
        function FunctionSymbol?,
        locals IReadOnlyDictionary[VariableSymbol, int32],
        scratch PlannerScratch
    ) IEnumerable[BoundExpression] {
        let sink = scratch.ReceiverSpills
        sink.Clear()
        this.slotPlanner.CollectReceiverSpills(cast[BoundStatement](root), function, locals, sink)
        return sink
    }

    // Issue #418 (P1-2): collect every property and CLR-property assignment
    // expression in the body. The slot allocator pairs each with a temp local
    // so the emitter can spill the assigned value (`dup; stloc tmp; setter;
    // ldloc tmp`) instead of re-evaluating the receiver and calling the
    // getter to recover the expression result.
    private func CollectAssignmentValueSpills(root BoundNode, scratch PlannerScratch) IEnumerable[BoundExpression] {
        let sink = scratch.AssignmentValueSpills
        sink.Clear()
        this.slotPlanner.CollectAssignmentValueSpills(cast[BoundStatement](root), sink)
        return sink
    }

    // Issue #504: each `!!` applied to a value-type `Nullable<T>` lowers at
    // emit time to `stloc tmp; ldloca tmp; call Nullable<T>::get_Value`. The
    // temp slot must be typed as `Nullable<T>` (so the local-sig blob encodes
    // the struct) and pre-allocated alongside the other body-emit scratch
    // locals so it appears in the locals signature.
    private func CollectNullableValueTypeUnwraps(root BoundNode, scratch PlannerScratch) IEnumerable[
        BoundUnaryExpression
    ] {
        let sink = scratch.NullableUnwraps
        sink.Clear()
        this.slotPlanner.CollectNullableValueTypeUnwraps(cast[BoundStatement](root), sink)
        return sink
    }

    // Issue #519: each `??` whose LHS is a value-type `Nullable<T>` lowers at
    // emit time to a HasValue branch that needs a `Nullable<T>`-typed temp
    // slot. The slot is keyed by the binary expression node and typed as the
    // LHS's NullableTypeSymbol so `EncodeTypeSymbol` emits the proper
    // `System.Nullable<T>` token in the local-sig blob.
    private func CollectNullableValueTypeCoalesces(root BoundNode, scratch PlannerScratch) IEnumerable[
        BoundBinaryExpression
    ] {
        let sink = scratch.NullableCoalesces
        sink.Clear()
        this.slotPlanner.CollectNullableValueTypeCoalesces(cast[BoundStatement](root), sink)
        return sink
    }

    // PR N-4 / §6.1 / C# §7.3.7: each lifted binary operator over a
    // value-type Nullable<T> lowers at emit time to a HasValue / get_Value
    // sequence that needs two Nullable<T>-typed temp slots (one per
    // operand). Arithmetic / bitwise forms additionally need a
    // Nullable<R>-typed result slot so the null branch can initobj a
    // default Nullable<R> and load it as a value.
    //
    // Issue #2388: widened to `BoundExpression` so a nullable-lifted Stream
    // C/D `BoundClrBinaryOperatorExpression` (custom-equality operator on
    // `Nullable<T>` operands) shares the same slot bundle as the built-in
    // operator table's `BoundBinaryExpression` shape.
    internal func CollectLiftedBinaryOperators(root BoundNode, scratch PlannerScratch) IEnumerable[BoundExpression] {
        let sink = scratch.LiftedBinaryOperators
        sink.Clear()
        this.slotPlanner.CollectLiftedBinaryOperators(cast[BoundStatement](root), sink)
        return sink
    }

    internal func CollectNullableValueTypeConversions(root BoundNode, scratch PlannerScratch) IEnumerable[
        BoundExpression
    ] {
        let sink = scratch.NullableConversions
        sink.Clear()
        this.slotPlanner.CollectNullableValueTypeConversions(cast[BoundStatement](root), sink)
        return sink
    }

    private func CollectNullConditionalCaptures(node BoundNode, scratch PlannerScratch) IEnumerable[
        BoundNullConditionalAccessExpression
    ] {
        let list = scratch.NullConditionals
        list.Clear()
        this.slotPlanner.CollectNullConditional(node, list)
        return list
    }

    shared {
        /// Allocates only body-owned slots and labels. The caller must first prove primitive-body eligibility.
        func CollectIndependentLocalsAndLabels(
            body BoundBlockStatement,
            locals Dictionary[VariableSymbol, int32],
            localTypes List[TypeSymbol],
            labels Dictionary[BoundLabel, LabelHandle],
            il InstructionEncoder
        ) {
            CollectIndependentStatements(body.Statements, locals, localTypes, labels, il, pass: 1)
            CollectIndependentStatements(body.Statements, locals, localTypes, labels, il, pass: 2)
        }

        private func CollectIndependentStatements(
            statements ImmutableArray[BoundStatement],
            locals Dictionary[VariableSymbol, int32],
            localTypes List[TypeSymbol],
            labels Dictionary[BoundLabel, LabelHandle],
            il InstructionEncoder,
            pass int32
        ) {
            for statement in statements {
                switch statement {
                    case block is BoundBlockStatement {
                        CollectIndependentStatements(block.Statements, locals, localTypes, labels, il, pass)
                    }
                    case declaration is BoundVariableDeclaration {
                        if declaration.Variable is not LocalVariableSymbol{RefKind: RefKind.None} &&
                            declaration.Variable is not ParameterSymbol{RefKind: RefKind.None} {
                            throw InvalidOperationException(
                                "Independent local planning cannot allocate shared or by-ref storage."
                            )
                        }
                        if pass == 1 && declaration.ConstantValue == nil {
                            RegisterLocal(declaration.Variable, locals, localTypes)
                        }
                    }
                    case label is BoundLabelStatement {
                        if pass == 1 {
                            RegisterLabel(label.Label, labels, il)
                        }
                    }
                    case branch is BoundGotoStatement {
                        if pass == 2 {
                            RegisterLabel(branch.Label, labels, il)
                        }
                    }
                    case branch is BoundConditionalGotoStatement {
                        if pass == 2 {
                            RegisterLabel(branch.Label, labels, il)
                        }
                    }
                    case BoundExpressionStatement, BoundReturnStatement { }
                    default {
                        throw InvalidOperationException("Unexpected independent statement '${statement.Kind}'.")
                    }
                }
            }
        }

        private func RegisterLocal(
            variable VariableSymbol,
            locals Dictionary[VariableSymbol, int32],
            localTypes List[TypeSymbol]
        ) {
            if locals.ContainsKey(variable) {
                return
            }
            locals[variable] = localTypes.Count
            localTypes.Add(
                if variable is LocalVariableSymbol local && local.RefKind != RefKind.None {
                    ByRefTypeSymbol.Get(local.Type)
                } else {
                    variable.Type
                }
            )
        }

        private func RegisterLabel(
            label BoundLabel,
            labels Dictionary[BoundLabel, LabelHandle],
            il InstructionEncoder
        ) {
            if !labels.ContainsKey(label) {
                labels[label] = il.DefineLabel()
            }
        }

        /// Converts the per-method `locals` dictionary used during IL emit
        /// into a stable, slot-ordered list suitable for the Portable PDB
        /// `LocalVariable` table. Compiler-generated names (synthesized by
        /// lowering) are reported with (cref:LocalInfo.IsCompilerGenerated)
        /// set so debuggers can hide them from the locals window.
        func CollectLocalInfo(locals Dictionary[VariableSymbol, int32]?) IReadOnlyList[LocalInfo] {
            if locals == nil || locals.Count == 0 {
                return Array.Empty[LocalInfo]()
            }
            let result = List[LocalInfo](locals.Count)
            for kvp in locals {
                var name = kvp.Key.Name ?? string.Empty
                let isGenerated = name.Length == 0 || name[0] == '<' || name[0] == '$' || name.Contains('$')
                if isGenerated && name.Length == 0 {
                    // Anonymous slot — give it a deterministic placeholder so the
                    // PDB row is still valid (debuggers ignore hidden names).
                    name = "<slot" + kvp.Value.ToString() + ">"
                }
                result.Add(LocalInfo(kvp.Value, name, isGenerated))
            }
            result.Sort((a LocalInfo, b LocalInfo) -> a.SlotIndex.CompareTo(b.SlotIndex))
            return result
        }

        /// Converts the per-method `constValues` dictionary into a list of
        /// (cref:LocalConstantInfo) descriptors for the Portable PDB
        /// `LocalConstant` table. Each entry corresponds to one compile-time
        /// `const` binding that occupied no IL slot.
        func CollectLocalConstantInfo(constValues Dictionary[VariableSymbol, object]?) IReadOnlyList[
            LocalConstantInfo
        ] {
            if constValues == nil || constValues.Count == 0 {
                return Array.Empty[LocalConstantInfo]()
            }
            let result = List[LocalConstantInfo](constValues.Count)
            for kvp in constValues {
                result.Add(LocalConstantInfo(kvp.Key.Name ?? string.Empty, kvp.Value))
            }
            return result
        }

        /// Pre-scans [`body`](paramref) and populates
        /// [`constValues`](paramref) with every `const`-declared local
        /// that has a compile-time (cref:BoundVariableDeclaration.ConstantValue).
        /// Called once before (cref:CollectLocalsAndLabels) so that
        /// (cref:MethodBodyEmitter) can inline those values instead of loading
        /// from a slot.
        func CollectConstValues(body BoundStatement, constValues Dictionary[VariableSymbol, object]) {
            WalkStmtsForConsts(body, constValues)
        }

        private func WalkStmtsForConsts(stmt BoundStatement, result Dictionary[VariableSymbol, object]) {
            switch stmt {
                case vd is BoundVariableDeclaration when vd.ConstantValue != nil {
                    result[vd.Variable] = vd.ConstantValue!!
                }
                case block is BoundBlockStatement {
                    for s in block.Statements {
                        WalkStmtsForConsts(s, result)
                    }
                }
                case ifs is BoundIfStatement {
                    WalkStmtsForConsts(ifs.ThenStatement, result)
                    if ifs.ElseStatement != nil {
                        WalkStmtsForConsts(ifs.ElseStatement, result)
                    }
                }
                case t is BoundTryStatement {
                    WalkStmtsForConsts(t.TryBlock, result)
                    for clause in t.CatchClauses {
                        WalkStmtsForConsts(clause.Body, result)
                    }
                    if t.FinallyBlock != nil {
                        WalkStmtsForConsts(t.FinallyBlock, result)
                    }
                }
                case ps is BoundPatternSwitchStatement {
                    for arm in ps.Arms {
                        if arm.Body != nil {
                            WalkStmtsForConsts(arm.Body, result)
                        }
                    }
                }
            }
        }

        // Issue #2388: a lifted binary node is either the built-in operator
        // table's BoundBinaryExpression or a nullable-lifted Stream C/D
        // BoundClrBinaryOperatorExpression; both shapes expose the same
        // Left/Right/Type triple the slot allocator needs, but neither shares a
        // common base-class accessor for Left/Right, so decompose explicitly.
        private func DecomposeLiftedBinary(lifted BoundExpression)(
            Left BoundExpression,
            Right BoundExpression,
            Type TypeSymbol
        ) -> switch lifted {
            case be is BoundBinaryExpression: (be.Left, be.Right, be.Type)
            case ce is BoundClrBinaryOperatorExpression: (ce.Left, ce.Right, ce.Type)
            default: throw InvalidOperationException(
                "DecomposeLiftedBinary: unexpected lifted binary node kind '${lifted.Kind}'."
            )
        }
    }
}
