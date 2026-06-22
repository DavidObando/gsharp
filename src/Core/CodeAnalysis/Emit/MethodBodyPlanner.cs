// <copyright file="MethodBodyPlanner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'public' members should come before 'private' members (organized by entry point, then helpers)
#pragma warning disable SA1611 // Element parameters should be documented (mechanically lifted from ReflectionMetadataEmitter; original methods were private)
#pragma warning disable SA1615 // Element return value should be documented (mechanically lifted from ReflectionMetadataEmitter; original methods were private)
#pragma warning disable SA1116 // The parameters should begin on the line after the declaration (preserves original formatting; reformat would break diff readability)

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-12: per-method-body planning surface. Owns the orchestrators that
/// run <see cref="SlotPlanner"/>'s collector classes against a method body
/// in dependency order and produce the slot/local/label/scratch tables that
/// <see cref="MethodBodyEmitter"/>'s prelude consumes.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-4 introduced <see cref="SlotPlanner"/> as the home of the 16
/// bound-tree-walker collector classes. This file is its companion: it
/// hosts the per-method orchestration (<c>CollectLocalsAndLabels</c>,
/// <c>CollectStatements</c>, <c>CollectPatternSwitchSlots</c>, the three
/// <c>Walk*</c> forwarders, <c>RegisterConstructedTypeAliases</c>,
/// <c>CollectConstValues</c>/<c>WalkStmtsForConsts</c>, the
/// <c>CollectLocalInfo</c>/<c>CollectLocalConstantInfo</c> PDB-shape
/// helpers, and the state-machine wiring helpers
/// <c>AddIteratorInterfaceImplementations</c>,
/// <c>AddAsyncIteratorInterfaceImplementations</c>,
/// <c>GetSmPackage</c>, and <c>TryGetUserKickoffReceiverHandle</c>).
/// </para>
/// <para>
/// What stays on <see cref="ReflectionMetadataEmitter"/>: the
/// <c>NeedsRvalueReceiverSpill</c> family of three predicates remain on
/// the root because they form the delegate that the root's constructor
/// supplies to <see cref="SlotPlanner"/> (lifecycle ordering — the
/// planner cannot itself depend on the slot planner via the same delegate
/// without a bootstrap cycle).
/// </para>
/// <para>
/// Like every other PR-E-* component, <see cref="MethodBodyPlanner"/> is
/// <c>internal sealed</c> and constructor-injected. It receives the same
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>, and
/// <see cref="SlotPlanner"/> as siblings plus delegate callbacks for the
/// few root helpers it queries (<see cref="ReflectionMetadataEmitter"/>'s
/// <c>GetTypeReference</c>, <c>GetTypeHandleForMember</c>) and a
/// back-reference to the shared <c>lambdaBodies</c> dictionary and the
/// <see cref="StateMachineEmitter"/> instance for plan lookups.
/// </para>
/// </remarks>
internal sealed class MethodBodyPlanner
{
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly SlotPlanner slotPlanner;
    private readonly Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies;
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;
    private readonly Func<Type, EntityHandle> getTypeHandleForMember;
    private readonly Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol;

    private StateMachineEmitter stateMachines;

    public MethodBodyPlanner(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        SlotPlanner slotPlanner,
        Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<Type, EntityHandle> getTypeHandleForMember,
        Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.slotPlanner = slotPlanner ?? throw new ArgumentNullException(nameof(slotPlanner));
        this.lambdaBodies = lambdaBodies ?? throw new ArgumentNullException(nameof(lambdaBodies));
        this.getTypeReference = getTypeReference ?? throw new ArgumentNullException(nameof(getTypeReference));
        this.getTypeHandleForMember = getTypeHandleForMember ?? throw new ArgumentNullException(nameof(getTypeHandleForMember));
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw new ArgumentNullException(nameof(encodeTypeSymbol));
    }

    /// <summary>
    /// Late-binds the <see cref="StateMachineEmitter"/>. <c>TryGetUserKickoffReceiverHandle</c>
    /// consults <c>stateMachines.AsyncStateMachinePlans</c>, and that
    /// component is created in <c>EmitCore</c> *after* this planner, so
    /// the wiring is completed via a setter rather than the constructor.
    /// </summary>
    public void SetStateMachines(StateMachineEmitter stateMachines)
    {
        this.stateMachines = stateMachines ?? throw new ArgumentNullException(nameof(stateMachines));
    }

    /// <summary>
    /// Converts the per-method <c>locals</c> dictionary used during IL emit
    /// into a stable, slot-ordered list suitable for the Portable PDB
    /// <c>LocalVariable</c> table. Compiler-generated names (synthesized by
    /// lowering) are reported with <see cref="LocalInfo.IsCompilerGenerated"/>
    /// set so debuggers can hide them from the locals window.
    /// </summary>
    public static IReadOnlyList<LocalInfo> CollectLocalInfo(Dictionary<VariableSymbol, int> locals)
    {
        if (locals == null || locals.Count == 0)
        {
            return System.Array.Empty<LocalInfo>();
        }

        var result = new List<LocalInfo>(locals.Count);
        foreach (var kvp in locals)
        {
            var name = kvp.Key.Name ?? string.Empty;
            var isGenerated = name.Length == 0
                || name[0] == '<'
                || name[0] == '$'
                || name.Contains('$');
            if (isGenerated && name.Length == 0)
            {
                // Anonymous slot — give it a deterministic placeholder so the
                // PDB row is still valid (debuggers ignore hidden names).
                name = "<slot" + kvp.Value + ">";
            }

            result.Add(new LocalInfo(kvp.Value, name, isGenerated));
        }

        result.Sort((a, b) => a.SlotIndex.CompareTo(b.SlotIndex));
        return result;
    }

    /// <summary>
    /// Converts the per-method <c>constValues</c> dictionary into a list of
    /// <see cref="LocalConstantInfo"/> descriptors for the Portable PDB
    /// <c>LocalConstant</c> table. Each entry corresponds to one compile-time
    /// <c>const</c> binding that occupied no IL slot.
    /// </summary>
    public static IReadOnlyList<LocalConstantInfo> CollectLocalConstantInfo(Dictionary<VariableSymbol, object> constValues)
    {
        if (constValues == null || constValues.Count == 0)
        {
            return System.Array.Empty<LocalConstantInfo>();
        }

        var result = new List<LocalConstantInfo>(constValues.Count);
        foreach (var kvp in constValues)
        {
            result.Add(new LocalConstantInfo(kvp.Key.Name ?? string.Empty, kvp.Value));
        }

        return result;
    }

    /// <summary>
    /// Pre-scans <paramref name="body"/> and populates
    /// <paramref name="constValues"/> with every <c>const</c>-declared local
    /// that has a compile-time <see cref="BoundVariableDeclaration.ConstantValue"/>.
    /// Called once before <see cref="CollectLocalsAndLabels"/> so that
    /// <see cref="MethodBodyEmitter"/> can inline those values instead of loading
    /// from a slot.
    /// </summary>
    public static void CollectConstValues(BoundStatement body, Dictionary<VariableSymbol, object> constValues)
    {
        WalkStmtsForConsts(body, constValues);
    }

    private static void WalkStmtsForConsts(BoundStatement stmt, Dictionary<VariableSymbol, object> result)
    {
        switch (stmt)
        {
            case BoundVariableDeclaration vd when vd.ConstantValue != null:
                result[vd.Variable] = vd.ConstantValue;
                break;
            case BoundBlockStatement block:
                foreach (var s in block.Statements)
                {
                    WalkStmtsForConsts(s, result);
                }

                break;
            case BoundIfStatement ifs:
                WalkStmtsForConsts(ifs.ThenStatement, result);
                if (ifs.ElseStatement != null)
                {
                    WalkStmtsForConsts(ifs.ElseStatement, result);
                }

                break;
            case BoundTryStatement t:
                WalkStmtsForConsts(t.TryBlock, result);
                foreach (var clause in t.CatchClauses)
                {
                    WalkStmtsForConsts(clause.Body, result);
                }

                if (t.FinallyBlock != null)
                {
                    WalkStmtsForConsts(t.FinallyBlock, result);
                }

                break;
            case BoundPatternSwitchStatement ps:
                foreach (var arm in ps.Arms)
                {
                    if (arm.Body != null)
                    {
                        WalkStmtsForConsts(arm.Body, result);
                    }
                }

                break;
            case BoundScopeStatement sc:
                WalkStmtsForConsts(sc.Body, result);
                break;
            case BoundSelectStatement sel:
                foreach (var arm in sel.Cases)
                {
                    if (arm.Body != null)
                    {
                        WalkStmtsForConsts(arm.Body, result);
                    }
                }

                break;
        }
    }

    /// <summary>
    /// Resolves the package that a state-machine type's kickoff belongs to,
    /// for determining which <c>&lt;Program&gt;</c> TypeDef it nests inside.
    /// </summary>
    public PackageSymbol GetSmPackage(StructSymbol smSym, ImmutableArray<PackageSymbol> packages, PackageSymbol entryPointPackage)
    {
        // Try the SM's packageName to find the matching package.
        if (smSym.PackageName != null)
        {
            foreach (var pkg in packages)
            {
                if (pkg.Name == smSym.PackageName)
                {
                    return pkg;
                }
            }
        }

        return entryPointPackage ?? (packages.IsDefaultOrEmpty ? null : packages[0]);
    }

    /// <summary>
    /// Issue #502: when an async kickoff method is declared as an instance or
    /// static member of a user-defined class, its synthesized state-machine
    /// type must be nested inside that class — not the per-package
    /// <c>&lt;Program&gt;</c> — so the kickoff method retains CLR access to
    /// the SM's <c>NestedPrivate</c> fields (most importantly
    /// <c>&lt;&gt;t__builder</c>). Lambda SMs already nest inside their
    /// closure class; this helper covers the named-method case.
    /// </summary>
    /// <param name="smSym">The synthesized state-machine struct or class.</param>
    /// <param name="enclosingHandle">Set to the receiver type's TypeDef handle when applicable.</param>
    /// <returns><see langword="true"/> when the SM should nest under a user receiver type.</returns>
    public bool TryGetUserKickoffReceiverHandle(StructSymbol smSym, out TypeDefinitionHandle enclosingHandle)
    {
        enclosingHandle = default;
        FunctionSymbol kickoff = null;
        foreach (var plan in this.stateMachines.AsyncStateMachinePlans)
        {
            if (ReferenceEquals(plan.StateMachine.MaterializeAsStructSymbol(), smSym))
            {
                kickoff = plan.KickoffMethod;
                break;
            }
        }

        // Issue #641: also check sync iterator and async iterator SM classes.
        if (kickoff == null)
        {
            foreach (var kvp in this.stateMachines.IteratorStateMachineInfos)
            {
                if (ReferenceEquals(kvp.Key, smSym))
                {
                    kickoff = kvp.Value.Plan.Function;
                    break;
                }
            }
        }

        if (kickoff == null)
        {
            foreach (var kvp in this.stateMachines.AsyncIteratorInfos)
            {
                if (ReferenceEquals(kvp.Key, smSym))
                {
                    kickoff = kvp.Value.Function;
                    break;
                }
            }
        }

        if (kickoff == null)
        {
            return false;
        }

        // Instance methods (ReceiverType set) and shared-block static methods
        // (StaticOwnerType set) both live on a user-defined class TypeDef.
        var owner = (kickoff.ReceiverType as StructSymbol)
            ?? (kickoff.StaticOwnerType as StructSymbol);
        if (owner == null)
        {
            return false;
        }

        return this.cache.StructTypeDefs.TryGetValue(owner, out enclosingHandle);
    }

    public void CollectLocalsAndLabels(
        BoundBlockStatement body,
        FunctionSymbol function,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundLabel, LabelHandle> labels,
        Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots,
        Dictionary<BoundStructLiteralExpression, int> structLiteralSlots,
        Dictionary<BoundDefaultExpression, int> defaultExpressionSlots,
        Dictionary<BoundIndexExpression, int> mapIndexSlots,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots,
        Dictionary<BoundExpression, int> receiverSpillSlots,
        Dictionary<BoundExpression, int> indexAssignmentValueSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
        Dictionary<BoundBinaryExpression, LiftedBinarySlots> liftedBinarySlots,
        Dictionary<BoundBinaryExpression, int> nullableCoalesceSpillSlots,
        InstructionEncoder il)
    {
        this.CollectStatements(body.Statements, function, locals, localTypes, labels, appendSlots, il, pass: 1);
        this.CollectBlockExpressionLocals(body, locals, localTypes);
        this.CollectStatements(body.Statements, function, locals, localTypes, labels, appendSlots, il, pass: 2);

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
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            goEnclosingScopes);

        // Phase 3.C.3b: each `?.` access introduces a synthetic capture
        // local in the bound tree; pre-allocate a slot for it.
        foreach (var nc in this.CollectNullConditionalCaptures(body))
        {
            if (!locals.ContainsKey(nc.Capture))
            {
                locals[nc.Capture] = localTypes.Count;
                localTypes.Add(nc.Capture.Type);
            }

            // P2-7 / Issue #421: value-type access results need a
            // Nullable<T> result slot so the nil branch can emit
            // `ldloca; initobj Nullable<T>; ldloc` and so the not-null
            // branch can wrap the raw T via `newobj Nullable<T>::.ctor(!0)`.
            if (nc.ResultSlot != null && !locals.ContainsKey(nc.ResultSlot))
            {
                locals[nc.ResultSlot] = localTypes.Count;
                localTypes.Add(nc.ResultSlot.Type);
            }
        }

        foreach (var append in this.CollectAppends(body))
        {
            var srcSlot = localTypes.Count;
            localTypes.Add(append.SliceType);
            var dstSlot = localTypes.Count;
            localTypes.Add(append.SliceType);
            appendSlots[append] = (srcSlot, dstSlot);
        }

        foreach (var literal in this.CollectStructLiterals(body))
        {
            // Class literals do not need a pre-allocated local slot — they
            // use newobj rather than initobj-into-a-slot.
            if (literal.StructType.IsClass)
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(literal.StructType);
            Debug.Assert(!structLiteralSlots.ContainsKey(literal), "Bound struct literal node aliased across emit positions; rekey structLiteralSlots by (node, parentContext) if lowering ever shares nodes.");
            structLiteralSlots[literal] = slot;
        }

        // Phase 3.A.4 emit: each map index READ lowers to a Dictionary.TryGetValue
        // pattern that needs a V-typed scratch local for the out parameter so that
        // missing keys yield the Go zero value (matching the interpreter).
        foreach (var idx in this.CollectMapIndexReads(body))
        {
            var slot = localTypes.Count;
            localTypes.Add(idx.Type);
            Debug.Assert(!mapIndexSlots.ContainsKey(idx), "Bound map index expression aliased across emit positions; rekey mapIndexSlots by (node, parentContext) if lowering ever shares nodes.");
            mapIndexSlots[idx] = slot;
        }

        // BoundDefaultExpression for non-primitive value types needs a temp local
        // for the ldloca/initobj/ldloc pattern (push-as-value path).
        // Issue #774: type-parameter and erased open-generic defaults also need
        // a slot — at compile time we don't know whether the substituted
        // argument is a reference or value type, and `ldnull` is invalid for
        // any value-type instantiation. The `ldloca tmp; initobj T; ldloc tmp`
        // shape zero-inits the storage uniformly (null for ref types, zeroed
        // bytes for value types) and IL-verifies for every closed argument.
        foreach (var def in this.CollectDefaultExpressions(body))
        {
            var needsSlot = ReflectionMetadataEmitter.IsValueTypeSymbol(def.Type)
                || def.Type is TypeParameterSymbol
                || (def.Type is ImportedTypeSymbol erasedGen && erasedGen.HasTypeParameterArgument)

                // Issue #814 / ADR-0084 §L5: `default(T?)` over an open type
                // parameter — either `[T struct]` (encoded as Nullable<!!T>)
                // or `[T class]` (encoded as bare !!T) — needs the same
                // ldloca/initobj/ldloc slot path as a closed value-type
                // default. The type-parameter case is required because
                // ldnull → !!T is rejected by the IL verifier even with
                // a `class` constraint.
                || (def.Type is NullableTypeSymbol nullableDef
                    && nullableDef.UnderlyingType is TypeParameterSymbol);
            if (!needsSlot)
            {
                continue;
            }

            // Primitive value types (int, bool) are handled with ldc.i4.0 — no slot needed.
            if (def.Type == TypeSymbol.Int32 || def.Type == TypeSymbol.Bool)
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(def.Type);
            Debug.Assert(!defaultExpressionSlots.ContainsKey(def), "Bound default expression aliased across emit positions; rekey defaultExpressionSlots by (node, parentContext) if lowering ever shares nodes.");
            defaultExpressionSlots[def] = slot;
        }

        foreach (var receiver in this.CollectReceiverSpills(body, function, locals))
        {
            if (receiverSpillSlots.ContainsKey(receiver))
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(receiver.Type);
            receiverSpillSlots[receiver] = slot;
        }

        // Issue #418 (P1-1): each index-assignment expression needs a scratch
        // local typed as the value's type. The emit sites use dup + stloc tmp
        // + store + ldloc tmp so the index/argument expressions are evaluated
        // exactly once even though the assignment expression's result is the
        // assigned value.
        foreach (var ixa in this.CollectIndexAssignmentValueSpills(body))
        {
            if (indexAssignmentValueSlots.ContainsKey(ixa))
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(ixa.Type);
            indexAssignmentValueSlots[ixa] = slot;
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
        foreach (var assn in this.CollectAssignmentValueSpills(body))
        {
            if (receiverSpillSlots.ContainsKey(assn))
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(assn.Type);
            receiverSpillSlots[assn] = slot;
        }

        // Issue #504: `!!` on a value-type `Nullable<T>` lowers to a
        // `stloc tmp; ldloca tmp; call Nullable<T>::get_Value` sequence; the
        // temp must be typed as `Nullable<T>` (not the unwrapped T). Reuse
        // receiverSpillSlots — the dictionary already aggregates several
        // distinct-by-node-identity scratch-slot kinds (receiver spills and
        // assignment-value spills) and BoundUnaryExpression keys cannot
        // collide with either. The slot is typed as the operand's
        // NullableTypeSymbol, which `EncodeTypeSymbol` lowers to
        // `System.Nullable<T>` in the local-sig blob.
        foreach (var unwrap in this.CollectNullableValueTypeUnwraps(body))
        {
            if (receiverSpillSlots.ContainsKey(unwrap))
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(unwrap.Operand.Type);
            receiverSpillSlots[unwrap] = slot;
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
        foreach (var coalesce in this.CollectNullableValueTypeCoalesces(body))
        {
            if (nullableCoalesceSpillSlots.ContainsKey(coalesce))
            {
                continue;
            }

            var slot = localTypes.Count;
            localTypes.Add(coalesce.Left.Type);
            nullableCoalesceSpillSlots[coalesce] = slot;
        }

        // PR N-4 / §6.1 / C# §7.3.7: lifted binary operators over a value-
        // type Nullable<T>. Each call site needs two Nullable<T>-typed
        // operand slots (LHS, RHS) so the emitter can take their addresses
        // for `call get_HasValue` / `call get_Value`. Arithmetic / bitwise
        // operators additionally need a Nullable<R>-typed result slot for
        // the null-branch `ldloca; initobj Nullable<R>; ldloc` shape;
        // equality / ordering operators return bool and need no result
        // slot. The slot bundle is keyed by the BoundBinaryExpression
        // node and stored in liftedBinarySlots so the emitter can look it
        // up at lowering time. Skip nodes already owned by other
        // collectors (NullCoalesce uses receiverSpillSlots) to avoid
        // double allocation.
        foreach (var lifted in this.CollectLiftedBinaryOperators(body))
        {
            if (liftedBinarySlots.ContainsKey(lifted))
            {
                continue;
            }

            var lhsSlot = localTypes.Count;
            localTypes.Add(lifted.Left.Type);

            // `value-type Nullable<T> == nil` / `!= nil` only needs an
            // LHS spill slot; the RHS is the `nil` literal (no temp
            // required) and the result is bool (no result slot).
            int rhsSlot = -1;
            int resultSlot = -1;
            if (lifted.Right.Type != TypeSymbol.Null)
            {
                rhsSlot = localTypes.Count;
                localTypes.Add(lifted.Right.Type);

                if (lifted.Type is NullableTypeSymbol)
                {
                    resultSlot = localTypes.Count;
                    localTypes.Add(lifted.Type);
                }
            }

            liftedBinarySlots[lifted] = new LiftedBinarySlots(lhsSlot, rhsSlot, resultSlot);
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
    private void CollectPatternSwitchSlots(
        ImmutableArray<BoundStatement> statements,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes)
    {
        foreach (var s in statements)
        {
            this.WalkForPatternSwitches(
                s,
                locals,
                localTypes,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                goEnclosingScopes,
                currentScope: null);
        }
    }

    private void WalkForPatternSwitches(
        BoundStatement statement,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots,
        Dictionary<BoundTypePattern, int> typePatternScratchSlots,
        Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots,
        Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots,
        Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots,
        Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots,
        Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes,
        BoundScopeStatement currentScope)
    {
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
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            goEnclosingScopes,
            currentScope);
    }

    private void CollectBlockExpressionLocals(BoundBlockStatement body, Dictionary<VariableSymbol, int> locals, List<TypeSymbol> localTypes)
    {
        var collected = new List<VariableSymbol>();
        this.slotPlanner.CollectBlockExpressionLocals(body, collected);
        foreach (var variable in collected)
        {
            if (!locals.ContainsKey(variable))
            {
                locals[variable] = localTypes.Count;
                localTypes.Add(variable.Type);
            }
        }
    }

    private IEnumerable<BoundStructLiteralExpression> CollectStructLiterals(BoundBlockStatement body)
    {
        var list = new List<BoundStructLiteralExpression>();
        foreach (var s in body.Statements)
        {
            this.slotPlanner.CollectStructLiterals(s, list);
        }

        return list;
    }

    // Phase 4 emit parity (E1): walk every user function body to collect all
    // BoundFunctionLiteralExpression nodes. Class instance method bodies are
    // included too. The collector uses BoundTreeRewriter so it reaches every
    // expression position; the base rewriter does not descend into the lambda's
    // body (separate lexical scope), so we recurse on Body explicitly to find
    // nested lambdas.
    public List<BoundFunctionLiteralExpression> CollectFunctionLiterals()
        => this.slotPlanner.CollectFunctionLiterals();

    public List<BoundGoStatement> CollectGoStatements()
        => this.slotPlanner.CollectGoStatements();

    // Phase 4 emit parity (F2, type-erased generic user types): discover
    // every constructed StructSymbol referenced in the bound program
    // (function bodies, class methods, and lambda bodies) and alias it to
    // its definition's TypeDef, ctor, primary-ctor, and per-field FieldDef
    // rows. Emission sites can then do plain dictionary lookups regardless
    // of whether the type is open, constructed, or already a non-generic
    // symbol.
    public void RegisterConstructedTypeAliases()
    {
        var collector = new ClosureEmitter.ConstructedTypeCollector();
        foreach (var kvp in this.emitCtx.Program.Functions)
        {
            collector.RewriteStatement(kvp.Value);
        }

        foreach (var body in this.lambdaBodies.Values)
        {
            collector.RewriteStatement(body);
        }

        foreach (var constructed in collector.Constructed)
        {
            var def = constructed.Definition;
            if (def == null || def == constructed)
            {
                continue;
            }

            if (this.cache.StructTypeDefs.TryGetValue(def, out var td))
            {
                this.cache.StructTypeDefs[constructed] = td;
            }

            if (this.cache.ClassCtorHandles.TryGetValue(def, out var cc))
            {
                this.cache.ClassCtorHandles[constructed] = cc;
            }

            if (this.cache.ClassPrimaryCtorHandles.TryGetValue(def, out var pc))
            {
                this.cache.ClassPrimaryCtorHandles[constructed] = pc;
            }

            foreach (var cf in constructed.Fields)
            {
                FieldSymbol df = null;
                foreach (var candidate in def.Fields)
                {
                    if (candidate.Name == cf.Name)
                    {
                        df = candidate;
                        break;
                    }
                }

                if (df != null && this.cache.StructFieldDefs.TryGetValue(df, out var fd))
                {
                    this.cache.StructFieldDefs[cf] = fd;
                }
            }
        }
    }

    public void AddIteratorInterfaceImplementations(StructSymbol smClass, StateMachineEmitter.IteratorStateMachineInfo info)
    {
        var elementType = info.Plan.ElementType;
        var typeDef = this.cache.StructTypeDefs[smClass];

        // Issue #810: when the iterator's element type contains an outer
        // method type parameter (now remapped to a class-level Var on the
        // SM), encode `IEnumerable<T>` / `IEnumerator<T>` as a TypeSpec
        // whose argument flows through EncodeTypeSymbol (which honours the
        // active iterator-state-machine remap pushed by the SM-class emit
        // loop in RME — outer-method TPs translate to Var(idx)). For closed
        // element types we keep the original CLR-erased path so existing
        // closed-iterator behaviour is unchanged.
        var elementContainsTp = ContainsTypeParameter(elementType);
        EntityHandle enumerableHandle;
        EntityHandle enumeratorHandle;
        if (elementContainsTp)
        {
            enumerableHandle = this.BuildGenericInterfaceTypeSpec(typeof(System.Collections.Generic.IEnumerable<>), elementType);
            enumeratorHandle = this.BuildGenericInterfaceTypeSpec(typeof(System.Collections.Generic.IEnumerator<>), elementType);
        }
        else
        {
            var elementClr = elementType.ClrType ?? typeof(object);
            enumerableHandle = this.getTypeHandleForMember(typeof(System.Collections.Generic.IEnumerable<>).MakeGenericType(elementClr));
            enumeratorHandle = this.getTypeHandleForMember(typeof(System.Collections.Generic.IEnumerator<>).MakeGenericType(elementClr));
        }

        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, enumerableHandle);
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, enumeratorHandle);
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, this.getTypeReference(typeof(System.IDisposable)));
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, this.getTypeReference(typeof(System.Collections.IEnumerable)));
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef, this.getTypeReference(typeof(System.Collections.IEnumerator)));
    }

    /// <summary>
    /// Issue #810: builds a <c>TypeSpec</c> handle encoding
    /// <paramref name="openDef"/>&lt;<paramref name="elementType"/>&gt;
    /// where the element type is encoded through
    /// <see cref="ReflectionMetadataEmitter.EncodeTypeSymbol"/> so the
    /// active iterator-state-machine remap (outer-method TP →
    /// class-TP Var(idx)) is honoured. Used by
    /// <see cref="AddIteratorInterfaceImplementations"/>.
    /// </summary>
    private EntityHandle BuildGenericInterfaceTypeSpec(Type openDef, TypeSymbol elementType)
    {
        var openHandle = this.getTypeReference(openDef);
        var sigBlob = new BlobBuilder();
        var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
        var gi = encoder.GenericInstantiation(openHandle, genericArgumentCount: 1, isValueType: false);
        this.encodeTypeSymbol(gi.AddArgument(), elementType);
        return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #810: recursively returns true if <paramref name="t"/>
    /// directly or transitively references a <see cref="TypeParameterSymbol"/>.
    /// Used to decide between TypeSpec and CLR-erased interface
    /// implementations for the iterator SM class.
    /// </summary>
    private static bool ContainsTypeParameter(TypeSymbol t)
    {
        switch (t)
        {
            case null:
                return false;
            case TypeParameterSymbol:
                return true;
            case ArrayTypeSymbol a:
                return ContainsTypeParameter(a.ElementType);
            case SliceTypeSymbol s:
                return ContainsTypeParameter(s.ElementType);
            case SequenceTypeSymbol seq:
                return ContainsTypeParameter(seq.ElementType);
            case AsyncSequenceTypeSymbol aseq:
                return ContainsTypeParameter(aseq.ElementType);
            case NullableTypeSymbol nu:
                return ContainsTypeParameter(nu.UnderlyingType);
            case ImportedTypeSymbol it when !it.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in it.TypeArguments)
                {
                    if (ContainsTypeParameter(arg))
                    {
                        return true;
                    }
                }

                return false;
            case StructSymbol st when !st.TypeArguments.IsDefaultOrEmpty:
                foreach (var arg in st.TypeArguments)
                {
                    if (ContainsTypeParameter(arg))
                    {
                        return true;
                    }
                }

                return false;
            case TupleTypeSymbol tup:
                // Issue #813: a value-tuple element type mentioning an
                // outer-method TP must also drive the symbolic
                // `IEnumerable<…>` / `IEnumerator<…>` interface
                // implementations on the iterator SM class so the
                // TypeSpec carries `ValueTuple<…, !0>` instead of the
                // type-erased `IEnumerable<object>`. Without this the
                // SM's interface row references the wrong shape and a
                // for-in over `Indexed[int32](source)` throws
                // `EntryPointNotFoundException` from the runtime's
                // `IEnumerable<(int32,T)>.GetEnumerator()` lookup.
                foreach (var elem in tup.ElementTypes)
                {
                    if (ContainsTypeParameter(elem))
                    {
                        return true;
                    }
                }

                return false;
            default:
                return false;
        }
    }

    public void AddAsyncIteratorInterfaceImplementations(StructSymbol smClass, AsyncIteratorPlan plan)
    {
        var elementClr = plan.ElementType.ClrType ?? typeof(object);
        var typeDef = this.cache.StructTypeDefs[smClass];

        // IAsyncEnumerator<T>
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef,
            this.getTypeHandleForMember(typeof(System.Collections.Generic.IAsyncEnumerator<>).MakeGenericType(elementClr)));

        // IAsyncDisposable
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef,
            this.getTypeHandleForMember(typeof(System.IAsyncDisposable)));

        if (plan.IsEnumerable)
        {
            // IAsyncEnumerable<T>
            this.emitCtx.Metadata.AddInterfaceImplementation(typeDef,
                this.getTypeHandleForMember(typeof(System.Collections.Generic.IAsyncEnumerable<>).MakeGenericType(elementClr)));
        }

        // IValueTaskSource<bool>
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef,
            this.getTypeHandleForMember(typeof(System.Threading.Tasks.Sources.IValueTaskSource<bool>)));

        // IAsyncStateMachine (required by AsyncIteratorMethodBuilder.MoveNext<TSM> constraint)
        this.emitCtx.Metadata.AddInterfaceImplementation(typeDef,
            this.getTypeHandleForMember(typeof(System.Runtime.CompilerServices.IAsyncStateMachine)));
    }

    private void CollectStatements(
        ImmutableArray<BoundStatement> statements,
        FunctionSymbol function,
        Dictionary<VariableSymbol, int> locals,
        List<TypeSymbol> localTypes,
        Dictionary<BoundLabel, LabelHandle> labels,
        Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots,
        InstructionEncoder il,
        int pass)
    {
        foreach (var s in statements)
        {
            if (pass == 1)
            {
                switch (s)
                {
                    case BoundVariableDeclaration decl:
                        // Issue #191: a GlobalVariableSymbol with a registered
                        // FieldDef stores into <Program>'s static field via
                        // stsfld; do not also allocate a local slot for it.
                        if (decl.Variable is GlobalVariableSymbol gv && this.cache.GlobalFieldDefs.ContainsKey(gv))
                        {
                            break;
                        }

                        // Issue #216: compile-time const bindings are inlined at
                        // every read site — no IL slot is needed.
                        if (decl.ConstantValue != null)
                        {
                            break;
                        }

                        if (!locals.ContainsKey(decl.Variable))
                        {
                            locals[decl.Variable] = localTypes.Count;

                            // Issue #491 (ADR-0060 follow-up): a ref-aliasing local's IL
                            // slot is a managed pointer `T&`, not the pointee `T`.
                            // Recording the slot type as ByRefTypeSymbol routes encoding
                            // through the byref local-sig path (EncodeLocalVariableType).
                            if (decl.Variable is LocalVariableSymbol lvs && lvs.RefKind != RefKind.None)
                            {
                                localTypes.Add(ByRefTypeSymbol.Get(lvs.Type));
                            }
                            else
                            {
                                localTypes.Add(decl.Variable.Type);
                            }
                        }

                        break;
                    case BoundLabelStatement lbl:
                        if (!labels.ContainsKey(lbl.Label))
                        {
                            labels[lbl.Label] = il.DefineLabel();
                        }

                        break;
                    case BoundScopeStatement sc when sc.Body is BoundBlockStatement scBlock:
                        this.CollectStatements(scBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                    case BoundSelectStatement sel:
                        foreach (var arm in sel.Cases)
                        {
                            if (arm.Variable != null && !locals.ContainsKey(arm.Variable))
                            {
                                locals[arm.Variable] = localTypes.Count;
                                localTypes.Add(arm.Variable.Type);
                            }

                            if (arm.Body is BoundBlockStatement armBlock)
                            {
                                this.CollectStatements(armBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                            }
                        }

                        break;
                    case BoundTryStatement t:
                        this.CollectStatements(((BoundBlockStatement)t.TryBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        foreach (var clause in t.CatchClauses)
                        {
                            // Issue #420 (P3-6): tolerate an elided catch variable
                            // in the local-slot pre-pass (the corresponding emit-
                            // time path in EmitCatchClauses emits a defensive
                            // `pop` to maintain stack balance).
                            if (clause.Variable != null && !locals.ContainsKey(clause.Variable))
                            {
                                locals[clause.Variable] = localTypes.Count;
                                localTypes.Add(clause.Variable.Type);
                            }

                            this.CollectStatements(((BoundBlockStatement)clause.Body).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        if (t.FinallyBlock != null)
                        {
                            this.CollectStatements(((BoundBlockStatement)t.FinallyBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        break;
                    case BoundBlockStatement nestedBlock:
                        this.CollectStatements(nestedBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                }
            }
            else
            {
                switch (s)
                {
                    case BoundGotoStatement g:
                        if (!labels.ContainsKey(g.Label))
                        {
                            labels[g.Label] = il.DefineLabel();
                        }

                        break;
                    case BoundConditionalGotoStatement cg:
                        if (!labels.ContainsKey(cg.Label))
                        {
                            labels[cg.Label] = il.DefineLabel();
                        }

                        break;
                    case BoundScopeStatement sc when sc.Body is BoundBlockStatement scBlock:
                        this.CollectStatements(scBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                    case BoundSelectStatement sel:
                        foreach (var arm in sel.Cases)
                        {
                            if (arm.Body is BoundBlockStatement armBlock)
                            {
                                this.CollectStatements(armBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                            }
                        }

                        break;
                    case BoundTryStatement t:
                        this.CollectStatements(((BoundBlockStatement)t.TryBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        foreach (var clause in t.CatchClauses)
                        {
                            this.CollectStatements(((BoundBlockStatement)clause.Body).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        if (t.FinallyBlock != null)
                        {
                            this.CollectStatements(((BoundBlockStatement)t.FinallyBlock).Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        }

                        break;
                    case BoundBlockStatement nestedBlock:
                        this.CollectStatements(nestedBlock.Statements, function, locals, localTypes, labels, appendSlots, il, pass);
                        break;
                }
            }
        }
    }

    private IEnumerable<BoundAppendExpression> CollectAppends(BoundNode node)
    {
        var list = new List<BoundAppendExpression>();
        this.slotPlanner.CollectAppends(node, list);
        return list;
    }

    private IEnumerable<BoundIndexExpression> CollectMapIndexReads(BoundNode root)
    {
        var sink = new List<BoundIndexExpression>();
        this.slotPlanner.CollectMapIndexReads((BoundStatement)root, sink);
        return sink;
    }

    private IEnumerable<BoundExpression> CollectIndexAssignmentValueSpills(BoundNode root)
    {
        var sink = new List<BoundExpression>();
        this.slotPlanner.CollectIndexAssignmentValueSpills((BoundStatement)root, sink);
        return sink;
    }

    private IEnumerable<BoundDefaultExpression> CollectDefaultExpressions(BoundNode root)
    {
        var sink = new List<BoundDefaultExpression>();
        this.slotPlanner.CollectDefaultExpressions((BoundStatement)root, sink);
        return sink;
    }

    private IEnumerable<BoundExpression> CollectReceiverSpills(
        BoundNode root,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        var sink = new List<BoundExpression>();
        this.slotPlanner.CollectReceiverSpills((BoundStatement)root, function, locals, sink);
        return sink;
    }

    // Issue #418 (P1-2): collect every property and CLR-property assignment
    // expression in the body. The slot allocator pairs each with a temp local
    // so the emitter can spill the assigned value (`dup; stloc tmp; setter;
    // ldloc tmp`) instead of re-evaluating the receiver and calling the
    // getter to recover the expression result.
    private IEnumerable<BoundExpression> CollectAssignmentValueSpills(BoundNode root)
    {
        var sink = new List<BoundExpression>();
        this.slotPlanner.CollectAssignmentValueSpills((BoundStatement)root, sink);
        return sink;
    }

    // Issue #504: each `!!` applied to a value-type `Nullable<T>` lowers at
    // emit time to `stloc tmp; ldloca tmp; call Nullable<T>::get_Value`. The
    // temp slot must be typed as `Nullable<T>` (so the local-sig blob encodes
    // the struct) and pre-allocated alongside the other body-emit scratch
    // locals so it appears in the locals signature.
    private IEnumerable<BoundUnaryExpression> CollectNullableValueTypeUnwraps(BoundNode root)
    {
        var sink = new List<BoundUnaryExpression>();
        this.slotPlanner.CollectNullableValueTypeUnwraps((BoundStatement)root, sink);
        return sink;
    }

    // Issue #519: each `??` whose LHS is a value-type `Nullable<T>` lowers at
    // emit time to a HasValue branch that needs a `Nullable<T>`-typed temp
    // slot. The slot is keyed by the binary expression node and typed as the
    // LHS's NullableTypeSymbol so `EncodeTypeSymbol` emits the proper
    // `System.Nullable<T>` token in the local-sig blob.
    private IEnumerable<BoundBinaryExpression> CollectNullableValueTypeCoalesces(BoundNode root)
    {
        var sink = new List<BoundBinaryExpression>();
        this.slotPlanner.CollectNullableValueTypeCoalesces((BoundStatement)root, sink);
        return sink;
    }

    // PR N-4 / §6.1 / C# §7.3.7: each lifted binary operator over a
    // value-type Nullable<T> lowers at emit time to a HasValue / get_Value
    // sequence that needs two Nullable<T>-typed temp slots (one per
    // operand). Arithmetic / bitwise forms additionally need a
    // Nullable<R>-typed result slot so the null branch can initobj a
    // default Nullable<R> and load it as a value.
    internal IEnumerable<BoundBinaryExpression> CollectLiftedBinaryOperators(BoundNode root)
    {
        var sink = new List<BoundBinaryExpression>();
        this.slotPlanner.CollectLiftedBinaryOperators((BoundStatement)root, sink);
        return sink;
    }

    private IEnumerable<BoundNullConditionalAccessExpression> CollectNullConditionalCaptures(BoundNode node)
    {
        var list = new List<BoundNullConditionalAccessExpression>();
        this.slotPlanner.CollectNullConditional(node, list);
        return list;
    }
}
