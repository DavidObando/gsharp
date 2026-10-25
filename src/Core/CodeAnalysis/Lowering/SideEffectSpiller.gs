// <copyright file="SideEffectSpiller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import BindingBinder = GSharp.Core.CodeAnalysis.Binding.Binder
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Issue #452: a general lowering pass that spills side-effecting
/// sub-expressions into fresh temp locals at every bound-tree context
/// that would otherwise re-emit the sub-expression more than once.
/// @remarks Side-effect duplication has been a recurring class of emit bugs:
/// short-circuit operators (P0-1), array / map / CLR-indexer
/// assignments (P1-1), user and CLR property assignments (P1-2), and
/// ref-local hoisting across `await` boundaries (P1-12) all had
/// emit-site bugs where a sub-expression with observable side effects
/// (a counter increment, a `Console.Write`, a property getter that
/// mutates state) fired twice instead of once. Each was patched at the
/// emit site; this pass closes the door on the entire bug class by
/// guaranteeing that the bound tree the emitter sees never contains a
/// side-effecting expression in a position that the emit pipeline
/// duplicates.
///
/// The pass runs once, after binding / interpolated-string lowering and
/// before the async / iterator state-machine rewriters and IL emission.
/// For each "duplicating context" (currently: assignments through an
/// array index, a CLR indexer, a user property, or a CLR property), it
/// inspects each sub-expression that the emit pipeline historically
/// re-emitted. When a sub-expression has observable side effects per
/// (cref:SideEffectAnalyzer.HasObservableSideEffect(BoundExpression)),
/// the entire assignment is rewritten into a
/// (cref:BoundBlockExpression) of the form:
///
/// ```
/// {
/// var $tmp0 = <side-effecting receiver / index>
/// var $tmp1 = <side-effecting value>
/// ...
/// <original assignment with $tmpN substituted in>
/// }
/// ```
///
/// The emit pipeline sees only (cref:BoundVariableExpression)
/// reads in the substituted positions, so any subsequent emit-site
/// duplication is a no-op (loading a local twice has no observable
/// effect). The pre-existing emit-site spill code (which dups the
/// stored value into a slot to recover the assignment expression's
/// result) remains as defense in depth.
///
/// The pass is intentionally additive: it only inserts wrappers and
/// never alters the meaning of existing expressions. Expressions that
/// are already side-effect-free (literals, variable reads, pure
/// arithmetic on pure operands) are left untouched, so the lowered
/// tree size grows only where duplication risk was real.
internal class SideEffectSpiller : NestedFunctionBodyRewriter {
    private var counter int32
    private let tempPrefix string

    internal init(tempPrefix string) {
        this.tempPrefix = tempPrefix
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteStructLiteralExpression(node BoundStructLiteralExpression) BoundExpression {
        let type = node.StructType
        if node.IsZeroInitialization ||
            node.CopySource != nil ||
            node.CallsPrimaryConstructor ||
            !type.HasDeclaredPrimaryConstructor ||
            !type.NeedsSynthesizedValueStructDefaultCtor {
            return base.RewriteStructLiteralExpression(node)
        }
        // Primary parameters belong to the owning constructor, not the literal
        // site. Capture supplied values in lexical order before mapping them to
        // parameters; constructor-owned declaration expressions run only there.
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let supplied = Dictionary[FieldSymbol, BoundExpression]()
        let remaining = ImmutableArray.CreateBuilder[BoundFieldInitializer]()
        let primaryArguments = node.GetPrimaryConstructorArguments()
        let primaryFields = HashSet[FieldSymbol]()
        for argument in primaryArguments {
            primaryFields.Add(argument.Field)
        }
        for initializer in node.Initializers {
            if initializer.IsDeclarationInitializer {
                continue
            }
            var value = this.RewriteExpression(initializer.Value)
            let target FieldSymbol? = initializer.Field ?? initializer.Property?.BackingField
            if target != nil && primaryFields.Contains(target) {
                value = this.MaybeSpill(value, true, "primary", statements)
                supplied[target] = value
                continue
            }
            remaining.Add(initializer with{Value = value})
        }
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](type.PrimaryConstructorParameters.Length)
        for argument in primaryArguments {
            // Omitted primary fields retain the composite literal's CLR zero.
            arguments.Add(
                (
                    if supplied.TryGetValue(argument.Field, out var value) {
                        value
                    } else {
                        argument.Value
                    }
                )
            )
        }
        let construction = BoundConstructorCallExpression(node.Syntax, type, arguments.MoveToImmutable())
        let receiver = cast[BoundVariableExpression](this.MaybeSpill(construction, true, "constructed", statements))
        for initializer in remaining {
            let assignment BoundExpression = if initializer.Field != nil {
                cast[BoundExpression](
                    BoundFieldAssignmentExpression(
                        node.Syntax,
                        receiver.Variable,
                        initializer.FieldDeclaringType ?? type,
                        initializer.Field,
                        initializer.Value
                    )
                )
            } else {
                cast[BoundExpression](
                    BoundPropertyAssignmentExpression(
                        node.Syntax,
                        receiver,
                        type,
                        Invariant.Required(
                            initializer.Property,
                            "a literal initializer has a field or property",
                            expression: "initializer.Property"
                        ),
                        initializer.Value
                    )
                )
            }
            statements.Add(BoundExpressionStatement(node.Syntax, assignment))
        }
        return BoundBlockExpression(node.Syntax, statements.ToImmutable(), receiver)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteFunctionPointerInvocationExpression(
        node BoundFunctionPointerInvocationExpression
    ) BoundExpression {
        let rewritten = cast[BoundFunctionPointerInvocationExpression](
            base.RewriteFunctionPointerInvocationExpression(node)
        )
        if rewritten.Arguments.IsDefaultOrEmpty {
            return rewritten
        }
        // `calli` requires arguments below the pointer on the IL stack, while
        // source order evaluates the pointer first. Capture it before arguments
        // so a member owner is evaluated exactly once at the correct point.
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let pointer = this.MaybeSpill(rewritten.Pointer, true, "fnptr", statements)
        let invocation = BoundFunctionPointerInvocationExpression(
            rewritten.Syntax,
            pointer,
            rewritten.Arguments,
            rewritten.FunctionPointerType
        )
        return BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), invocation)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteIndexAssignmentExpression(node BoundIndexAssignmentExpression) BoundExpression {
        // Rewrite children first so any nested duplicating contexts inside
        // the index or value are themselves spilled bottom-up.
        let rewritten = cast[BoundIndexAssignmentExpression](base.RewriteIndexAssignmentExpression(node))
        let spillIndex = rewritten.Indices.Any(SideEffectAnalyzer.HasObservableSideEffect)
        let spillValue = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Value)
        if !spillIndex && !spillValue {
            return rewritten
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        var target = rewritten.TargetExpression ??
            BoundVariableExpression(rewritten.Syntax, BoundNodeForm.VariableTarget(rewritten))
        target = this.MaybeSpill(target, true, "coll", statements)
        let indices = ImmutableArray.CreateBuilder[BoundExpression](rewritten.Indices.Length)
        for candidate in rewritten.Indices {
            indices.Add(this.MaybeSpill(candidate, true, "idx", statements))
        }
        let rewrittenIndices = indices.MoveToImmutable()
        let value = this.MaybeSpill(rewritten.Value, spillValue, "val", statements)
        // Target and every index must be captured before value evaluation.
        // A later call can mutate even a previously pure variable or field
        // read, so spilling only effectful operands breaks left-to-right order.
        let assignment = BoundIndexAssignmentExpression.WithExpressionTarget(
            rewritten.Syntax,
            target,
            rewrittenIndices,
            value,
            rewritten.Type
        )
        return BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteClrIndexAssignmentExpression(
        node BoundClrIndexAssignmentExpression
    ) BoundExpression {
        let rewritten = cast[BoundClrIndexAssignmentExpression](base.RewriteClrIndexAssignmentExpression(node))
        var anyArgSideEffect = false
        for var i = 0; i < rewritten.Arguments.Length && !anyArgSideEffect; i++ {
            anyArgSideEffect = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Arguments[i])
        }
        let spillValue = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Value)
        if !anyArgSideEffect && !spillValue {
            return rewritten
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let argsBuilder = ImmutableArray.CreateBuilder[BoundExpression](rewritten.Arguments.Length)
        for var i = 0; i < rewritten.Arguments.Length; i++ {
            let arg = rewritten.Arguments[i]
            let spilled = this.MaybeSpill(arg, SideEffectAnalyzer.HasObservableSideEffect(arg), "arg$i", statements)
            argsBuilder.Add(spilled)
        }
        let value = this.MaybeSpill(rewritten.Value, spillValue, "val", statements)
        // Same form preservation as the slice/array path above.
        let assignment = if rewritten.TargetExpression != nil {
            BoundClrIndexAssignmentExpression.WithExpressionTarget(
                rewritten.Syntax,
                rewritten.TargetExpression,
                rewritten.Indexer,
                argsBuilder.ToImmutable(),
                value,
                rewritten.Type,
                rewritten.ConstrainedReceiverTypeParameter,
                rewritten.ConstrainedInterfaceType
            )
        } else {
            BoundClrIndexAssignmentExpression(
                rewritten.Syntax,
                BoundNodeForm.VariableTarget(rewritten),
                rewritten.Indexer,
                argsBuilder.ToImmutable(),
                value,
                rewritten.Type,
                rewritten.ConstrainedReceiverTypeParameter,
                rewritten.ConstrainedInterfaceType
            )
        }
        return BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewritePropertyAssignmentExpression(
        node BoundPropertyAssignmentExpression
    ) BoundExpression {
        let rewritten = cast[BoundPropertyAssignmentExpression](base.RewritePropertyAssignmentExpression(node))
        // ADR-0156 Phase 2 (issue #3185): a prior-cell submission global (or
        // a field chain rooted at one) is pure, re-evaluable, addressable
        // storage — spilling it to a temp would silently redirect the write
        // into the copy. Issue #3292: the same holds for a value-typed
        // array/slice element chain (`ps[0]`, `qs[0].B2`): the emitter roots
        // the write at the element address (`ldelema`), so only the
        // side-effecting collection/index sub-expressions are spilled (see
        // SpillStorageReceiverParts), never the element value itself.
        let spillReceiver = rewritten.Receiver != nil &&
            !IsInPlaceStorageWriteReceiver(rewritten.Receiver) &&
            (
            SideEffectAnalyzer.HasObservableSideEffect(rewritten.Receiver) ||
                BindingBinder.IsReferenceTypeForConstraint(rewritten.Receiver.Type) &&
                !IsStableLocalRead(rewritten.Receiver) &&
                SideEffectAnalyzer.HasObservableSideEffect(rewritten.Value)
        )
        var value = rewritten.Value
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        var receiver = rewritten.Receiver
        if spillReceiver {
            receiver = this.MaybeSpill(
                Invariant.Required(
                    rewritten.Receiver,
                    "a spilled property assignment has a receiver",
                    expression: "rewritten.Receiver"
                ),
                true,
                "recv",
                statements
            )
            // Issue #1688: a compound assignment (`getObj().P += x`) lowers
            // to `assign(receiver, get(receiver) OP rhs)` — the SAME
            // receiver node appears both as the assignment's own receiver
            // and nested inside `value` as the read side. Spilling only
            // the copy above and leaving the nested read pointing at the
            // original (still side-effecting) receiver expression would
            // evaluate it a second time. Substitute every occurrence of
            // the shared receiver inside `value` with the freshly spilled
            // temp so both sides observe exactly one evaluation.
            value = ReceiverSubstitutionRewriter.Replace(
                value,
                Invariant.Required(
                    rewritten.Receiver,
                    "a spilled property assignment has a receiver",
                    expression: "rewritten.Receiver"
                ),
                Invariant.Required(
                    receiver,
                    "a spilled property assignment produces a receiver",
                    expression: "receiver"
                )
            )
        } else if rewritten.Receiver != nil && IsInPlaceStorageWriteReceiver(rewritten.Receiver) {
            // Capture the chain's components, never its stored value, and
            // substitute the rebuilt receiver on both sides of a compound write.
            receiver = this.CapturePropertyStorageReceiver(
                Invariant.Required(
                    rewritten.Receiver,
                    "an element write has a receiver",
                    expression: "rewritten.Receiver"
                ),
                statements
            )
            if !object.ReferenceEquals(receiver, rewritten.Receiver) {
                value = ReceiverSubstitutionRewriter.Replace(value, rewritten.Receiver!!, receiver)
            }
        }
        let spillValue = SideEffectAnalyzer.HasObservableSideEffect(value)
        if spillValue && !spillReceiver {
            this.ProbeStorageReceiver(receiver, statements)
        }
        if !spillReceiver && !spillValue && object.ReferenceEquals(receiver, rewritten.Receiver) {
            return rewritten
        }
        value = this.MaybeSpill(value, spillValue, "val", statements)
        let assignment = BoundPropertyAssignmentExpression(
            rewritten.Syntax,
            receiver,
            rewritten.StructType,
            rewritten.Property,
            value,
            rewritten.SubstitutedType,
            rewritten.InterfaceType
        )
        return BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteClrPropertyAssignmentExpression(
        node BoundClrPropertyAssignmentExpression
    ) BoundExpression {
        let rewritten = cast[BoundClrPropertyAssignmentExpression](base.RewriteClrPropertyAssignmentExpression(node))
        // ADR-0156 Phase 2 (issue #3185): see RewritePropertyAssignmentExpression —
        // an addressable submission-global receiver chain must not be spilled.
        // Issue #3292: an addressable array/slice element chain likewise —
        // only its side-effecting collection/index parts are hoisted.
        // A static member write has no receiver at all (see the remarks on
        // BoundClrPropertyAssignmentExpression), so both spill decisions are
        // nested under one null test rather than repeating it.
        let original BoundExpression? = rewritten.Receiver
        let spillReceiver = original != nil &&
            !IsInPlaceStorageWriteReceiver(original) &&
            (
            SideEffectAnalyzer.HasObservableSideEffect(original) || BindingBinder.IsReferenceTypeForConstraint(
                original.Type
            ) &&
                !IsStableLocalRead(original) &&
                SideEffectAnalyzer.HasObservableSideEffect(rewritten.Value)
        )
        var value = rewritten.Value
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        var receiver = original
        if original != nil && spillReceiver {
            receiver = this.MaybeSpill(original, true, "recv", statements)
            // Issue #1688: same double-eval hazard as the user-property
            // path above, for CLR properties (`obj.ClrProp += x`).
            value = ReceiverSubstitutionRewriter.Replace(value, original, receiver)
        } else if original != nil && IsInPlaceStorageWriteReceiver(original) {
            // Once-only evaluation for the storage chain (see
            // RewritePropertyAssignmentExpression).
            receiver = this.CapturePropertyStorageReceiver(original, statements)
            if !object.ReferenceEquals(receiver, original) {
                value = ReceiverSubstitutionRewriter.Replace(value, original, receiver)
            }
        }
        let spillValue = SideEffectAnalyzer.HasObservableSideEffect(value)
        if spillValue && !spillReceiver {
            this.ProbeStorageReceiver(receiver, statements)
        }
        if !spillReceiver && !spillValue && object.ReferenceEquals(receiver, rewritten.Receiver) {
            return rewritten
        }
        value = this.MaybeSpill(value, spillValue, "val", statements)
        let assignment = BoundClrPropertyAssignmentExpression(
            rewritten.Syntax,
            receiver,
            rewritten.Member,
            value,
            rewritten.Type,
            rewritten.StaticContainerType,
            rewritten.ConstrainedReceiverTypeParameter,
            rewritten.ConstrainedInterfaceType
        )
        return BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment)
    }

    // GSA0005: The rebuild is reached only after `rewritten.ReceiverExpression == null`
    // returns, so this is the expression-receiver form: Receiver and
    // InterfaceType are null on this path by construction.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    @SuppressDiagnostic("GSA0005")
    protected override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
        let rewritten = cast[BoundFieldAssignmentExpression](base.RewriteFieldAssignmentExpression(node))
        // Issue #3292: a struct-field write whose expression receiver is an
        // addressable array/slice element chain (`ps[i].X = v`,
        // `qs[i].B2.C op= v`) is emitted through the element address
        // (`ldelema` + `ldflda`…), and a compound form re-emits that chain
        // on both the read and write sides. Hoist any side-effecting
        // collection/index sub-expression into a temp and substitute the
        // rebuilt (pure) chain into both sides so each part is evaluated
        // exactly once. Class receivers and plain variable receivers keep
        // their existing emit-side handling.
        if rewritten.ReceiverExpression == nil || !IsInPlaceStorageWriteReceiver(rewritten.ReceiverExpression) {
            return rewritten
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let receiver = this.SpillStorageReceiverParts(rewritten.ReceiverExpression!!, statements)
        if object.ReferenceEquals(receiver, rewritten.ReceiverExpression) {
            return rewritten
        }
        let value = ReceiverSubstitutionRewriter.Replace(rewritten.Value, rewritten.ReceiverExpression!!, receiver)
        let assignment = BoundFieldAssignmentExpression.WithExpressionReceiver(
            rewritten.Syntax,
            receiver,
            BoundNodeForm.DeclaringType(rewritten),
            rewritten.Field,
            value,
            rewritten.ResultType
        )
        return BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment)
    }

    internal func CapturePropertyStorageReceiver(
        receiver BoundExpression,
        statements ImmutableArray[BoundStatement].Builder,
        captureComponents bool = false
    ) BoundExpression {
        return CaptureRuntimeGenericStorageReceiver(
            this.SpillStorageReceiverParts(receiver, statements, captureComponents),
            receiver.Syntax,
            statements,
            (role string, isReadOnly bool, storageType TypeSymbol) ->
            LocalVariableSymbol("${this.tempPrefix}$role${this.counter++}", isReadOnly, storageType)
        )
    }

    internal func ProbeStorageReceiver(receiver BoundExpression?, statements ImmutableArray[BoundStatement].Builder) {
        if receiver != nil && receiver is not BoundVariableExpression && IsInPlaceStorageWriteReceiver(receiver) {
            statements.Add(BoundExpressionStatement(nil, BoundAddressOfExpression(nil, receiver)))
        }
    }

    /// Rewrites an addressable receiver chain (see
    /// (cref:IsInPlaceStorageWriteReceiver)), hoisting each unstable reference
    /// owner or side-effecting collection/index sub-expression into a fresh temp
    /// local appended to [`statements`](paramref). The chain SHAPE is
    /// preserved so the emitter still
    /// recognises it as addressable; only the leaf value producers are
    /// replaced by pure variable reads. Returns the original instance when
    /// nothing needed spilling.
    /// @param receiver The element receiver chain to rewrite.
    /// @param statements The statement-list builder receiving temp declarations.
    /// @returns The rewritten (or original) receiver.
    private func SpillStorageReceiverParts(
        receiver BoundExpression,
        statements ImmutableArray[BoundStatement].Builder,
        captureComponents bool = false
    ) BoundExpression {
        if IsOpaqueStorageReceiver(receiver) {
            let local = LocalVariableSymbol(
                "${this.tempPrefix}storage${this.counter++}",
                isReadOnly: false,
                receiver.Type,
                receiver.Syntax
            )
            return CaptureOpaqueStorageReceiver(receiver, receiver.Syntax, statements, local)
        }
        switch receiver {
            case BoundDereferenceExpression{Operand: BoundAddressOfExpression address} {
                return this.SpillStorageReceiverParts(address.Operand, statements, captureComponents: true)
            }
            case tuple is BoundTupleElementAccessExpression {
                // Capture owners and indices before the RHS, without copying tuple storage.
                let owner = this.SpillStorageReceiverParts(tuple.Receiver, statements, captureComponents: true)
                return if object.ReferenceEquals(owner, tuple.Receiver) {
                    tuple
                } else {
                    BoundTupleElementAccessExpression(tuple.Syntax, owner, tuple.TupleType, tuple.Index)
                }
            }
            case dereference is BoundDereferenceExpression when dereference.Operand is BoundConditionalAddressExpression {
                let address = cast[BoundConditionalAddressExpression](dereference.Operand)
                let condition = this.MaybeSpill(
                    address.Condition,
                    !IsStableLocalRead(address.Condition),
                    "select",
                    statements
                )
                let trueStatements = ImmutableArray.CreateBuilder[BoundStatement]()
                let whenTrue = this.SpillStorageReceiverParts(address.WhenTrueOperand, trueStatements, true)
                let falseStatements = ImmutableArray.CreateBuilder[BoundStatement]()
                let whenFalse = this.SpillStorageReceiverParts(address.WhenFalseOperand, falseStatements, true)
                // Capture only the selected branch's components, never its address.
                if trueStatements.Count != 0 {
                    let skip = BoundLabel("${this.tempPrefix}skip${this.counter++}")
                    statements.Add(BoundConditionalGotoStatement(nil, skip, condition, jumpIfTrue: false))
                    statements.AddRange(trueStatements)
                    statements.Add(BoundLabelStatement(nil, skip))
                }
                if falseStatements.Count != 0 {
                    let skip = BoundLabel("${this.tempPrefix}skip${this.counter++}")
                    statements.Add(BoundConditionalGotoStatement(nil, skip, condition, jumpIfTrue: true))
                    statements.AddRange(falseStatements)
                    statements.Add(BoundLabelStatement(nil, skip))
                }
                let captured = BoundConditionalAddressExpression(
                    address.Syntax,
                    condition,
                    whenTrue,
                    whenFalse,
                    address.PointeeType
                )
                return BoundDereferenceExpression(dereference.Syntax, captured)
            }
            case element is BoundIndexExpression {
                {
                    let target = this.MaybeSpill(
                        element.Target,
                        captureComponents || SideEffectAnalyzer.HasObservableSideEffect(element.Target),
                        "coll",
                        statements
                    )
                    let indices = ImmutableArray.CreateBuilder[BoundExpression](element.Indices.Length)
                    var changed = !object.ReferenceEquals(target, element.Target)
                    for candidate in element.Indices {
                        let index = this.MaybeSpill(
                            candidate,
                            captureComponents || SideEffectAnalyzer.HasObservableSideEffect(candidate),
                            "idx",
                            statements
                        )
                        indices.Add(index)
                        changed |= !object.ReferenceEquals(index, candidate)
                    }
                    if !changed {
                        return element
                    }
                    return BoundIndexExpression(element.Syntax, target, indices.MoveToImmutable(), element.Type)
                }
            }
            case fieldLink is BoundFieldAccessExpression when fieldLink.Receiver != nil {
                {
                    let owner = fieldLink.Receiver!!
                    let inner = if GSharp.Core.CodeAnalysis.Binding.Binder.IsReferenceTypeForConstraint(owner.Type) {
                        this.MaybeSpill(owner, !IsStableLocalRead(owner), "owner", statements)
                    } else {
                        this.SpillStorageReceiverParts(owner, statements, captureComponents)
                    }
                    if object.ReferenceEquals(inner, fieldLink.Receiver) {
                        return fieldLink
                    }
                    return BoundFieldAccessExpression(
                        fieldLink.Syntax,
                        inner,
                        BoundNodeForm.DeclaringType(fieldLink),
                        fieldLink.Field,
                        fieldLink.SubstitutedType,
                        fieldLink.NarrowedType
                    )
                }
            }
            case clrLink is BoundClrPropertyAccessExpression when clrLink.Receiver != nil {
                {
                    let owner = clrLink.Receiver!!
                    let inner = if GSharp.Core.CodeAnalysis.Binding.Binder.IsReferenceTypeForConstraint(owner.Type) {
                        this.MaybeSpill(owner, !IsStableLocalRead(owner), "owner", statements)
                    } else {
                        this.SpillStorageReceiverParts(owner, statements, captureComponents)
                    }
                    if object.ReferenceEquals(inner, clrLink.Receiver) {
                        return clrLink
                    }
                    return BoundClrPropertyAccessExpression(
                        clrLink.Syntax,
                        inner,
                        clrLink.Member,
                        clrLink.Type,
                        clrLink.StaticContainerType,
                        clrLink.ConstrainedReceiverTypeParameter,
                        clrLink.ConstrainedInterfaceType,
                        clrLink.IsAddressableStaticField,
                        clrLink.IsReadOnlySubmissionGlobal
                    )
                }
            }
            default {
                return receiver
            }
        }
    }

    /// Optionally spills [`expression`](paramref) into a fresh local
    /// when [`shouldSpill`](paramref) is set, appending a
    /// (cref:BoundVariableDeclaration) to [`statements`](paramref)
    /// and returning a (cref:BoundVariableExpression) reading the
    /// new local. When [`shouldSpill`](paramref) is false the
    /// original expression is returned unchanged.
    /// @param expression The expression to potentially spill.
    /// @param shouldSpill Whether a spill is required.
    /// @param role A short identifier used in the temp name for readability.
    /// @param statements The statement-list builder to append the declaration to.
    /// @returns The expression to use in the rewritten position.
    private func MaybeSpill(
        expression BoundExpression,
        shouldSpill bool,
        role string,
        statements ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        if !shouldSpill {
            return expression
        }
        let local = LocalVariableSymbol(
            "${this.tempPrefix}$role${this.counter++}",
            isReadOnly: true,
            type: expression.Type
        )
        statements.Add(BoundVariableDeclaration(expression.Syntax, local, expression))
        return BoundVariableExpression(expression.Syntax, local)
    }

    /// Issue #1688: rewrites a bound expression tree, replacing every
    /// reference-equal occurrence of a shared receiver node with a
    /// replacement expression (typically a read of the temp local it was
    /// just spilled into). Used to keep the nested read embedded in a
    /// compound assignment's `value` in sync with the receiver copy
    /// the assignment itself was rewritten to use.
    private class ReceiverSubstitutionRewriter : BoundTreeRewriter {
        private let target BoundExpression
        private let replacement BoundExpression

        private init(target BoundExpression, replacement BoundExpression) {
            this.target = target
            this.replacement = replacement
        }

        // Intercepting the single generic dispatch point (rather than each
        // Rewrite*AccessExpression override) means every parent-node
        // reconstruction still goes through the normal Rewrite* overrides,
        // which already know how to preserve NarrowedType / InterfaceType /
        // StaticContainerType — no risk of silently dropping a field here.
        protected override func RewriteExpression(node BoundExpression) BoundExpression {
            return if object.ReferenceEquals(node, this.target) {
                this.replacement
            } else {
                base.RewriteExpression(node)
            }
        }

        shared {
            func Replace(tree BoundExpression, target BoundExpression, replacement BoundExpression) BoundExpression {
                let rewriter = ReceiverSubstitutionRewriter(target, replacement)
                return rewriter.RewriteExpression(tree)
            }
        }
    }

    shared {
        internal func SubstituteReceiver(
            tree BoundExpression,
            receiver BoundExpression,
            replacement BoundExpression
        ) BoundExpression -> ReceiverSubstitutionRewriter.Replace(tree, receiver, replacement)

        internal func CaptureOpaqueStorageReceiver(
            storage BoundExpression,
            anchor SyntaxNode?,
            statements ImmutableArray[BoundStatement].Builder,
            local LocalVariableSymbol
        ) BoundExpression {
            local.RefKind = RefKind.Ref
            local.ManagedReferenceOrigin = storage
            statements.Add(BoundVariableDeclaration(anchor, local, BoundAddressOfExpression(anchor, storage)))
            return BoundVariableExpression(storage.Syntax, local)
        }

        internal func CaptureRuntimeGenericStorageReceiver(
            storage BoundExpression,
            anchor SyntaxNode?,
            statements ImmutableArray[BoundStatement].Builder,
            declareLocal(string, bool, TypeSymbol) -> LocalVariableSymbol
        ) BoundExpression {
            if storage.Type is not TypeParameterSymbol parameter ||
                parameter.HasValueTypeConstraint ||
                BindingBinder.IsReferenceTypeForConstraint(parameter) {
                return storage
            }
            // Snapshot reference instantiations, but reconstruct value-type storage after the RHS.
            let systemType = ImportedTypeSymbol.GetWithoutNullability(typeof(Type), NullabilityFreeReason.TypeLiteral)
            let kind = declareLocal("Recv", true, TypeSymbol.Bool)
            statements.Add(
                BoundVariableDeclaration(
                    anchor,
                    kind,
                    BoundClrPropertyAccessExpression(
                        anchor,
                        BoundTypeOfExpression(anchor, parameter, systemType),
                        Invariant.Required(typeof(Type).GetProperty("IsValueType"), "System.Type exposes IsValueType"),
                        TypeSymbol.Bool
                    )
                )
            )
            let isValueType = BoundVariableExpression(anchor, kind)
            let snapshot = declareLocal("Generic", false, parameter)
            statements.Add(
                BoundVariableDeclaration(
                    anchor,
                    snapshot,
                    BoundConditionalExpression(
                        anchor,
                        isValueType,
                        BoundDefaultExpression(anchor, parameter),
                        storage,
                        parameter
                    )
                )
            )
            return BoundDereferenceExpression(
                storage.Syntax,
                BoundConditionalAddressExpression(
                    anchor,
                    isValueType,
                    storage,
                    BoundVariableExpression(anchor, snapshot),
                    parameter
                )
            )
        }

        private const TempPrefix string = "<>spill"

        /// Produces a copy of [`program`](paramref) with side-effecting
        /// sub-expressions in duplicating contexts spilled into temp locals.
        /// Returns the original instance unchanged when no spill was needed.
        /// @param program The bound program to lower.
        /// @returns The lowered program (or the original when nothing changed).
        func Lower(program BoundProgram) BoundProgram {
            let spiller = SideEffectSpiller(TempPrefix)
            var changed = false
            let functions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
            // Issue #4663: deterministic order, never identity-hash order.
            for pair in BoundProgramOrder.Functions(program) {
                let newBody = cast[BoundBlockStatement](spiller.RewriteStatement(pair.Value))
                functions[pair.Key] = newBody
                changed |= newBody != pair.Value
            }
            let statement = cast[BoundBlockStatement](spiller.RewriteStatement(program.Statement))
            changed |= statement != program.Statement
            let initializers = program.Initializers.ToBuilder()
            // Issue #4663: deterministic order, never identity-hash order.
            for pair in BoundProgramOrder.Initializers(program) {
                initializers[pair.Key] = pair.Value.Rewrite(spiller.RewriteExpression, spiller.RewriteStatement)
                changed |= initializers[pair.Key] != pair.Value
            }
            if !changed {
                return program
            }
            return BoundProgram(
                program.EntryPointPackage,
                program.Packages,
                program.Diagnostics,
                functions.ToImmutable(),
                program.EntryPoint,
                statement,
                program.Structs,
                program.Interfaces,
                program.Enums,
                program.Globals,
                program.Delegates
            ){
                Initializers = initializers.ToImmutable(),
                Imports = program.Imports,
                FriendAssemblies = program.FriendAssemblies,
                AssemblyAttributes = program.AssemblyAttributes,
                ModuleAttributes = program.ModuleAttributes,
                NativeProtocols = program.NativeProtocols
            }
        }

        // A readonly ref alias can still observe writes through another alias.
        private func IsStableLocalRead(expression BoundExpression) bool -> expression is BoundVariableExpression{
            Variable: LocalVariableSymbol{IsReadOnly: true, RefKind: RefKind.None}
        }

        private func IsOpaqueStorageReceiver(expression BoundExpression?) bool -> switch expression {
            case block is BoundBlockExpression: IsOpaqueStorageReceiver(block.Expression)
            case dereference is BoundDereferenceExpression: IsOpaqueStorageReceiver(dereference.Operand)
            case {} expression: RefCapabilities.IsRefReturningAccess(expression)
            default: false
        }

        /// Whether [`receiver`](paramref) denotes value storage rather than
        /// a copy: field/element chains and captured conditional addresses.
        /// Only reference owners and collection/index components may be spilled
        /// (see (cref:SpillStorageReceiverParts)).
        /// @param receiver The candidate receiver expression.
        /// @returns `true` for an addressable element chain.
        internal func IsInPlaceStorageWriteReceiver(receiver BoundExpression?) bool {
            var receiver = receiver
            while true {
                if receiver == nil ||
                    GSharp
                    .Core
                    .CodeAnalysis
                    .Binding
                    .Binder
                    .IsReferenceTypeForConstraint(receiver.Type) {
                    return false
                }
                switch receiver {
                    case BoundDereferenceExpression{Operand: BoundAddressOfExpression address} {
                        receiver = address.Operand
                        continue
                    }
                    case tuple is BoundTupleElementAccessExpression {
                        receiver = tuple.Receiver
                        continue
                    }
                    case element is BoundIndexExpression {
                        return element.IsArrayBackedElementAccess
                    }
                    case BoundVariableExpression {
                        return true
                    }
                    case BoundDereferenceExpression{
                        Operand: BoundVariableExpression{Variable: LocalVariableSymbol{IsReadOnly: true}}
                    } {
                        return true
                    }
                    case BoundDereferenceExpression{Operand: BoundConditionalAddressExpression} conditional {
                        let address = cast[BoundConditionalAddressExpression](conditional.Operand)
                        return IsInPlaceStorageWriteReceiver(address.WhenTrueOperand) &&
                            IsInPlaceStorageWriteReceiver(address.WhenFalseOperand)
                    }
                    case fieldLink is BoundFieldAccessExpression when fieldLink.Receiver != nil {
                        let owner = fieldLink.Receiver!!
                        if GSharp.Core.CodeAnalysis.Binding.Binder.IsReferenceTypeForConstraint(owner.Type) {
                            return true
                        }
                        receiver = owner
                        continue
                    }
                    case BoundClrPropertyAccessExpression{Member: FieldInfo} clrLink {
                        if clrLink.Receiver == nil {
                            return true
                        }
                        let owner = clrLink.Receiver
                        if GSharp.Core.CodeAnalysis.Binding.Binder.IsReferenceTypeForConstraint(owner.Type) {
                            return true
                        }
                        receiver = owner
                        continue
                    }
                    default {
                        return IsOpaqueStorageReceiver(receiver)
                    }
                }
            }
        }
    }
}
