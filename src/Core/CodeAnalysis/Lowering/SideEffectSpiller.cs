// <copyright file="SideEffectSpiller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Issue #452: a general lowering pass that spills side-effecting
/// sub-expressions into fresh temp locals at every bound-tree context
/// that would otherwise re-emit the sub-expression more than once.
/// </summary>
/// <remarks>
/// <para>
/// Side-effect duplication has been a recurring class of emit bugs:
/// short-circuit operators (P0-1), array / map / CLR-indexer
/// assignments (P1-1), user and CLR property assignments (P1-2), and
/// ref-local hoisting across <c>await</c> boundaries (P1-12) all had
/// emit-site bugs where a sub-expression with observable side effects
/// (a counter increment, a <c>Console.Write</c>, a property getter that
/// mutates state) fired twice instead of once. Each was patched at the
/// emit site; this pass closes the door on the entire bug class by
/// guaranteeing that the bound tree the emitter sees never contains a
/// side-effecting expression in a position that the emit pipeline
/// duplicates.
/// </para>
/// <para>
/// The pass runs once, after binding / interpolated-string lowering and
/// before the async / iterator state-machine rewriters and IL emission.
/// For each "duplicating context" (currently: assignments through an
/// array index, a CLR indexer, a user property, or a CLR property), it
/// inspects each sub-expression that the emit pipeline historically
/// re-emitted. When a sub-expression has observable side effects per
/// <see cref="SideEffectAnalyzer.HasObservableSideEffect(BoundExpression)"/>,
/// the entire assignment is rewritten into a
/// <see cref="BoundBlockExpression"/> of the form:
/// </para>
/// <code>
/// {
///     var $tmp0 = &lt;side-effecting receiver / index&gt;
///     var $tmp1 = &lt;side-effecting value&gt;
///     ...
///     &lt;original assignment with $tmpN substituted in&gt;
/// }
/// </code>
/// <para>
/// The emit pipeline sees only <see cref="BoundVariableExpression"/>
/// reads in the substituted positions, so any subsequent emit-site
/// duplication is a no-op (loading a local twice has no observable
/// effect). The pre-existing emit-site spill code (which dups the
/// stored value into a slot to recover the assignment expression's
/// result) remains as defense in depth.
/// </para>
/// <para>
/// The pass is intentionally additive: it only inserts wrappers and
/// never alters the meaning of existing expressions. Expressions that
/// are already side-effect-free (literals, variable reads, pure
/// arithmetic on pure operands) are left untouched, so the lowered
/// tree size grows only where duplication risk was real.
/// </para>
/// </remarks>
internal sealed class SideEffectSpiller : NestedFunctionBodyRewriter
{
    private const string TempPrefix = "<>spill";

    private int counter;

    private SideEffectSpiller()
    {
    }

    /// <summary>
    /// Produces a copy of <paramref name="program"/> with side-effecting
    /// sub-expressions in duplicating contexts spilled into temp locals.
    /// Returns the original instance unchanged when no spill was needed.
    /// </summary>
    /// <param name="program">The bound program to lower.</param>
    /// <returns>The lowered program (or the original when nothing changed).</returns>
    public static BoundProgram Lower(BoundProgram program)
    {
        var spiller = new SideEffectSpiller();
        var changed = false;

        var functions = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        foreach (var pair in program.Functions)
        {
            var newBody = (BoundBlockStatement)spiller.RewriteStatement(pair.Value);
            functions[pair.Key] = newBody;
            changed |= newBody != pair.Value;
        }

        var statement = (BoundBlockStatement)spiller.RewriteStatement(program.Statement);
        changed |= statement != program.Statement;

        if (!changed)
        {
            return program;
        }

        return new BoundProgram(
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
            program.Delegates)
        {
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
        };
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteFunctionPointerInvocationExpression(
        BoundFunctionPointerInvocationExpression node)
    {
        var rewritten = (BoundFunctionPointerInvocationExpression)base.RewriteFunctionPointerInvocationExpression(node);
        if (rewritten.Arguments.IsDefaultOrEmpty)
        {
            return rewritten;
        }

        // `calli` requires arguments below the pointer on the IL stack, while
        // source order evaluates the pointer first. Capture it before arguments
        // so a member owner is evaluated exactly once at the correct point.
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var pointer = this.MaybeSpill(rewritten.Pointer, true, "fnptr", statements);
        var invocation = new BoundFunctionPointerInvocationExpression(
            rewritten.Syntax,
            pointer,
            rewritten.Arguments,
            rewritten.FunctionPointerType);
        return new BoundBlockExpression(
            rewritten.Syntax,
            statements.ToImmutable(),
            invocation);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        // Rewrite children first so any nested duplicating contexts inside
        // the index or value are themselves spilled bottom-up.
        var rewritten = (BoundIndexAssignmentExpression)base.RewriteIndexAssignmentExpression(node);

        var spillIndex = rewritten.Indices.Any(SideEffectAnalyzer.HasObservableSideEffect);
        var spillValue = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Value);
        if (!spillIndex && !spillValue)
        {
            return rewritten;
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var target = rewritten.TargetExpression
            ?? new BoundVariableExpression(
                rewritten.Syntax,
                BoundNodeForm.VariableTarget(rewritten));
        target = this.MaybeSpill(target, true, "coll", statements);

        var indices = ImmutableArray.CreateBuilder<BoundExpression>(rewritten.Indices.Length);
        foreach (var candidate in rewritten.Indices)
        {
            indices.Add(this.MaybeSpill(
                candidate,
                true,
                "idx",
                statements));
        }

        var rewrittenIndices = indices.MoveToImmutable();
        var value = this.MaybeSpill(rewritten.Value, spillValue, "val", statements);

        // Target and every index must be captured before value evaluation.
        // A later call can mutate even a previously pure variable or field
        // read, so spilling only effectful operands breaks left-to-right order.
        var assignment = BoundIndexAssignmentExpression.WithExpressionTarget(
            rewritten.Syntax,
            target,
            rewrittenIndices,
            value,
            rewritten.Type);

        return new BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
    {
        var rewritten = (BoundClrIndexAssignmentExpression)base.RewriteClrIndexAssignmentExpression(node);

        var anyArgSideEffect = false;
        for (var i = 0; i < rewritten.Arguments.Length && !anyArgSideEffect; i++)
        {
            anyArgSideEffect = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Arguments[i]);
        }

        var spillValue = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Value);
        if (!anyArgSideEffect && !spillValue)
        {
            return rewritten;
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var argsBuilder = ImmutableArray.CreateBuilder<BoundExpression>(rewritten.Arguments.Length);
        for (var i = 0; i < rewritten.Arguments.Length; i++)
        {
            var arg = rewritten.Arguments[i];
            var spilled = this.MaybeSpill(
                arg,
                SideEffectAnalyzer.HasObservableSideEffect(arg),
                $"arg{i}",
                statements);
            argsBuilder.Add(spilled);
        }

        var value = this.MaybeSpill(rewritten.Value, spillValue, "val", statements);

        // Same form preservation as the slice/array path above.
        var assignment = rewritten.TargetExpression != null
            ? BoundClrIndexAssignmentExpression.WithExpressionTarget(
                rewritten.Syntax,
                rewritten.TargetExpression,
                rewritten.Indexer,
                argsBuilder.ToImmutable(),
                value,
                rewritten.Type,
                rewritten.ConstrainedReceiverTypeParameter,
                rewritten.ConstrainedInterfaceType)
            : new BoundClrIndexAssignmentExpression(
                rewritten.Syntax,
                BoundNodeForm.VariableTarget(rewritten),
                rewritten.Indexer,
                argsBuilder.ToImmutable(),
                value,
                rewritten.Type,
                rewritten.ConstrainedReceiverTypeParameter,
                rewritten.ConstrainedInterfaceType);

        return new BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewritePropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
    {
        var rewritten = (BoundPropertyAssignmentExpression)base.RewritePropertyAssignmentExpression(node);

        // ADR-0156 Phase 2 (issue #3185): a prior-cell submission global (or
        // a field chain rooted at one) is pure, re-evaluable, addressable
        // storage — spilling it to a temp would silently redirect the write
        // into the copy. Issue #3292: the same holds for a value-typed
        // array/slice element chain (`ps[0]`, `qs[0].B2`): the emitter roots
        // the write at the element address (`ldelema`), so only the
        // side-effecting collection/index sub-expressions are spilled (see
        // SpillElementChainParts), never the element value itself.
        var spillReceiver = rewritten.Receiver != null
            && SideEffectAnalyzer.HasObservableSideEffect(rewritten.Receiver)
            && !BoundClrPropertyAccessExpression.IsAddressableSubmissionFieldChain(rewritten.Receiver)
            && !IsInPlaceElementWriteReceiver(rewritten.Receiver);
        var value = rewritten.Value;
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        var receiver = rewritten.Receiver;
        if (spillReceiver)
        {
            receiver = this.MaybeSpill(
                Invariant.Required(rewritten.Receiver, "a spilled property assignment has a receiver"),
                true,
                "recv",
                statements);

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
                Invariant.Required(rewritten.Receiver, "a spilled property assignment has a receiver"),
                Invariant.Required(receiver, "a spilled property assignment produces a receiver"));
        }
        else if (rewritten.Receiver != null && IsInPlaceElementWriteReceiver(rewritten.Receiver))
        {
            // Issue #3292: once-only evaluation for the element chain — the
            // emitter re-emits the collection/index pair on both the read
            // and write sides of a compound write, so any side-effecting
            // sub-expression is hoisted into a temp first and the rebuilt
            // (pure) chain is substituted into both sides.
            receiver = this.SpillElementChainParts(
                Invariant.Required(rewritten.Receiver, "an element write has a receiver"),
                statements);
            if (!ReferenceEquals(receiver, rewritten.Receiver))
            {
                value = ReceiverSubstitutionRewriter.Replace(value, rewritten.Receiver, receiver);
            }
        }

        var spillValue = SideEffectAnalyzer.HasObservableSideEffect(value);
        if (!spillReceiver && !spillValue && ReferenceEquals(receiver, rewritten.Receiver))
        {
            return rewritten;
        }

        value = this.MaybeSpill(value, spillValue, "val", statements);

        var assignment = new BoundPropertyAssignmentExpression(
            rewritten.Syntax,
            receiver,
            rewritten.StructType,
            rewritten.Property,
            value);

        return new BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
    {
        var rewritten = (BoundClrPropertyAssignmentExpression)base.RewriteClrPropertyAssignmentExpression(node);

        // ADR-0156 Phase 2 (issue #3185): see RewritePropertyAssignmentExpression —
        // an addressable submission-global receiver chain must not be spilled.
        // Issue #3292: an addressable array/slice element chain likewise —
        // only its side-effecting collection/index parts are hoisted.
        // A static member write has no receiver at all (see the remarks on
        // BoundClrPropertyAssignmentExpression), so both spill decisions are
        // nested under one null test rather than repeating it.
        var original = rewritten.Receiver;
        var spillReceiver = original != null
            && SideEffectAnalyzer.HasObservableSideEffect(original)
            && !BoundClrPropertyAccessExpression.IsAddressableSubmissionFieldChain(original)
            && !IsInPlaceElementWriteReceiver(original);
        var value = rewritten.Value;
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        var receiver = original;
        if (original != null && spillReceiver)
        {
            receiver = this.MaybeSpill(original, true, "recv", statements);

            // Issue #1688: same double-eval hazard as the user-property
            // path above, for CLR properties (`obj.ClrProp += x`).
            value = ReceiverSubstitutionRewriter.Replace(value, original, receiver);
        }
        else if (original != null && IsInPlaceElementWriteReceiver(original))
        {
            // Issue #3292: once-only evaluation for the element chain (see
            // RewritePropertyAssignmentExpression).
            receiver = this.SpillElementChainParts(original, statements);
            if (!ReferenceEquals(receiver, original))
            {
                value = ReceiverSubstitutionRewriter.Replace(value, original, receiver);
            }
        }

        var spillValue = SideEffectAnalyzer.HasObservableSideEffect(value);
        if (!spillReceiver && !spillValue && ReferenceEquals(receiver, rewritten.Receiver))
        {
            return rewritten;
        }

        value = this.MaybeSpill(value, spillValue, "val", statements);

        var assignment = new BoundClrPropertyAssignmentExpression(
            rewritten.Syntax,
            receiver,
            rewritten.Member,
            value,
            rewritten.Type,
            rewritten.StaticContainerType,
            rewritten.ConstrainedReceiverTypeParameter,
            rewritten.ConstrainedInterfaceType);

        return new BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment);
    }

    /// <inheritdoc/>
    // GSA0005: The rebuild is reached only after `rewritten.ReceiverExpression == null`
    // returns, so this is the expression-receiver form: Receiver and
    // InterfaceType are null on this path by construction.
    #pragma warning disable GSA0005
    protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        var rewritten = (BoundFieldAssignmentExpression)base.RewriteFieldAssignmentExpression(node);

        // Issue #3292: a struct-field write whose expression receiver is an
        // addressable array/slice element chain (`ps[i].X = v`,
        // `qs[i].B2.C op= v`) is emitted through the element address
        // (`ldelema` + `ldflda`…), and a compound form re-emits that chain
        // on both the read and write sides. Hoist any side-effecting
        // collection/index sub-expression into a temp and substitute the
        // rebuilt (pure) chain into both sides so each part is evaluated
        // exactly once. Class receivers and plain variable receivers keep
        // their existing emit-side handling.
        if (rewritten.ReceiverExpression == null
            || !IsInPlaceElementWriteReceiver(rewritten.ReceiverExpression))
        {
            return rewritten;
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var receiver = this.SpillElementChainParts(rewritten.ReceiverExpression, statements);
        if (ReferenceEquals(receiver, rewritten.ReceiverExpression))
        {
            return rewritten;
        }

        var value = ReceiverSubstitutionRewriter.Replace(rewritten.Value, rewritten.ReceiverExpression, receiver);
        var assignment = BoundFieldAssignmentExpression.WithExpressionReceiver(
            rewritten.Syntax,
            receiver,
            BoundNodeForm.DeclaringType(rewritten),
            rewritten.Field,
            value,
            rewritten.ResultType);

        return new BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment);
    }
    #pragma warning restore GSA0005

    /// <summary>
    /// Issue #3292: whether <paramref name="receiver"/> is a value-typed
    /// member-write receiver chain the emitter roots at an array-backed
    /// element address (<c>ldelema</c> + <c>ldflda</c>…): zero or more
    /// value-typed field links over an array/slice element load. Such a
    /// receiver must NOT be spilled to a temp — the write must reach the
    /// element's storage — but its collection/index sub-expressions may be
    /// (see <see cref="SpillElementChainParts"/>).
    /// </summary>
    /// <param name="receiver">The candidate receiver expression.</param>
    /// <returns><see langword="true"/> for an addressable element chain.</returns>
    private static bool IsInPlaceElementWriteReceiver(BoundExpression receiver)
    {
        while (true)
        {
            if (receiver == null || Binding.Binder.IsReferenceTypeForConstraint(receiver.Type))
            {
                return false;
            }

            switch (receiver)
            {
                case BoundIndexExpression element:
                    return element.IsArrayBackedElementAccess;
                case BoundFieldAccessExpression fieldLink when fieldLink.Receiver != null:
                    receiver = fieldLink.Receiver;
                    continue;
                case BoundClrPropertyAccessExpression { Member: FieldInfo } clrLink when clrLink.Receiver != null:
                    receiver = clrLink.Receiver;
                    continue;
                default:
                    return false;
            }
        }
    }

    /// <summary>
    /// Issue #3292: rewrites an addressable element receiver chain (see
    /// <see cref="IsInPlaceElementWriteReceiver"/>), hoisting each
    /// side-effecting collection or index sub-expression into a fresh temp
    /// local appended to <paramref name="statements"/>. The chain SHAPE is
    /// preserved (field links over an element load) so the emitter still
    /// recognises it as addressable; only the leaf value producers are
    /// replaced by pure variable reads. Returns the original instance when
    /// nothing needed spilling.
    /// </summary>
    /// <param name="receiver">The element receiver chain to rewrite.</param>
    /// <param name="statements">The statement-list builder receiving temp declarations.</param>
    /// <returns>The rewritten (or original) receiver.</returns>
    private BoundExpression SpillElementChainParts(
        BoundExpression receiver,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        switch (receiver)
        {
            case BoundIndexExpression element:
            {
                var target = this.MaybeSpill(
                    element.Target,
                    SideEffectAnalyzer.HasObservableSideEffect(element.Target),
                    "coll",
                    statements);
                var indices = ImmutableArray.CreateBuilder<BoundExpression>(element.Indices.Length);
                var changed = !ReferenceEquals(target, element.Target);
                foreach (var candidate in element.Indices)
                {
                    var index = this.MaybeSpill(
                        candidate,
                        SideEffectAnalyzer.HasObservableSideEffect(candidate),
                        "idx",
                        statements);
                    indices.Add(index);
                    changed |= !ReferenceEquals(index, candidate);
                }

                if (!changed)
                {
                    return element;
                }

                return new BoundIndexExpression(element.Syntax, target, indices.MoveToImmutable(), element.Type);
            }

            case BoundFieldAccessExpression fieldLink when fieldLink.Receiver != null:
            {
                var inner = this.SpillElementChainParts(fieldLink.Receiver, statements);
                if (ReferenceEquals(inner, fieldLink.Receiver))
                {
                    return fieldLink;
                }

                return new BoundFieldAccessExpression(
                    fieldLink.Syntax,
                    inner,
                    BoundNodeForm.DeclaringType(fieldLink),
                    fieldLink.Field,
                    fieldLink.SubstitutedType,
                    fieldLink.NarrowedType);
            }

            case BoundClrPropertyAccessExpression clrLink when clrLink.Receiver != null:
            {
                var inner = this.SpillElementChainParts(clrLink.Receiver, statements);
                if (ReferenceEquals(inner, clrLink.Receiver))
                {
                    return clrLink;
                }

                return new BoundClrPropertyAccessExpression(
                    clrLink.Syntax,
                    inner,
                    clrLink.Member,
                    clrLink.Type,
                    clrLink.StaticContainerType,
                    clrLink.ConstrainedReceiverTypeParameter,
                    clrLink.ConstrainedInterfaceType,
                    clrLink.IsAddressableStaticField,
                    clrLink.IsReadOnlySubmissionGlobal);
            }

            default:
                return receiver;
        }
    }

    /// <summary>
    /// Optionally spills <paramref name="expression"/> into a fresh local
    /// when <paramref name="shouldSpill"/> is set, appending a
    /// <see cref="BoundVariableDeclaration"/> to <paramref name="statements"/>
    /// and returning a <see cref="BoundVariableExpression"/> reading the
    /// new local. When <paramref name="shouldSpill"/> is false the
    /// original expression is returned unchanged.
    /// </summary>
    /// <param name="expression">The expression to potentially spill.</param>
    /// <param name="shouldSpill">Whether a spill is required.</param>
    /// <param name="role">A short identifier used in the temp name for readability.</param>
    /// <param name="statements">The statement-list builder to append the declaration to.</param>
    /// <returns>The expression to use in the rewritten position.</returns>
    private BoundExpression MaybeSpill(
        BoundExpression expression,
        bool shouldSpill,
        string role,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        if (!shouldSpill)
        {
            return expression;
        }

        var local = new LocalVariableSymbol(
            $"{TempPrefix}{role}{this.counter++}",
            isReadOnly: true,
            type: expression.Type);
        statements.Add(new BoundVariableDeclaration(expression.Syntax, local, expression));
        return new BoundVariableExpression(expression.Syntax, local);
    }

    /// <summary>
    /// Issue #1688: rewrites a bound expression tree, replacing every
    /// reference-equal occurrence of a shared receiver node with a
    /// replacement expression (typically a read of the temp local it was
    /// just spilled into). Used to keep the nested read embedded in a
    /// compound assignment's <c>value</c> in sync with the receiver copy
    /// the assignment itself was rewritten to use.
    /// </summary>
    private sealed class ReceiverSubstitutionRewriter : BoundTreeRewriter
    {
        private readonly BoundExpression target;
        private readonly BoundExpression replacement;

        private ReceiverSubstitutionRewriter(BoundExpression target, BoundExpression replacement)
        {
            this.target = target;
            this.replacement = replacement;
        }

        public static BoundExpression Replace(BoundExpression tree, BoundExpression target, BoundExpression replacement)
        {
            var rewriter = new ReceiverSubstitutionRewriter(target, replacement);
            return rewriter.RewriteExpression(tree);
        }

        // Intercepting the single generic dispatch point (rather than each
        // Rewrite*AccessExpression override) means every parent-node
        // reconstruction still goes through the normal Rewrite* overrides,
        // which already know how to preserve NarrowedType / InterfaceType /
        // StaticContainerType — no risk of silently dropping a field here.
        protected override BoundExpression RewriteExpression(BoundExpression node)
        {
            return ReferenceEquals(node, this.target) ? this.replacement : base.RewriteExpression(node);
        }
    }
}
