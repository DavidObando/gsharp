// <copyright file="SideEffectSpiller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
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

        var statement = program.Statement;
        if (statement != null)
        {
            var newStatement = (BoundBlockStatement)spiller.RewriteStatement(statement);
            changed |= newStatement != statement;
            statement = newStatement;
        }

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
        };
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        // Rewrite children first so any nested duplicating contexts inside
        // the index or value are themselves spilled bottom-up.
        var rewritten = (BoundIndexAssignmentExpression)base.RewriteIndexAssignmentExpression(node);

        var spillIndex = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Index);
        var spillValue = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Value);
        if (!spillIndex && !spillValue)
        {
            return rewritten;
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var index = this.MaybeSpill(rewritten.Index, spillIndex, "idx", statements);
        var value = this.MaybeSpill(rewritten.Value, spillValue, "val", statements);

        var assignment = new BoundIndexAssignmentExpression(
            rewritten.Syntax,
            rewritten.Target,
            index,
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

        var assignment = new BoundClrIndexAssignmentExpression(
            rewritten.Syntax,
            rewritten.Target,
            rewritten.Indexer,
            argsBuilder.ToImmutable(),
            value,
            rewritten.Type);

        return new BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewritePropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
    {
        var rewritten = (BoundPropertyAssignmentExpression)base.RewritePropertyAssignmentExpression(node);

        var spillReceiver = SideEffectAnalyzer.HasObservableSideEffect(rewritten.Receiver);
        var value = rewritten.Value;
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        var receiver = rewritten.Receiver;
        if (spillReceiver)
        {
            receiver = this.MaybeSpill(rewritten.Receiver, true, "recv", statements);

            // Issue #1688: a compound assignment (`getObj().P += x`) lowers
            // to `assign(receiver, get(receiver) OP rhs)` — the SAME
            // receiver node appears both as the assignment's own receiver
            // and nested inside `value` as the read side. Spilling only
            // the copy above and leaving the nested read pointing at the
            // original (still side-effecting) receiver expression would
            // evaluate it a second time. Substitute every occurrence of
            // the shared receiver inside `value` with the freshly spilled
            // temp so both sides observe exactly one evaluation.
            value = ReceiverSubstitutionRewriter.Replace(value, rewritten.Receiver, receiver);
        }

        var spillValue = SideEffectAnalyzer.HasObservableSideEffect(value);
        if (!spillReceiver && !spillValue)
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

        var spillReceiver = rewritten.Receiver != null
            && SideEffectAnalyzer.HasObservableSideEffect(rewritten.Receiver);
        var value = rewritten.Value;
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        var receiver = rewritten.Receiver;
        if (spillReceiver)
        {
            receiver = this.MaybeSpill(rewritten.Receiver, true, "recv", statements);

            // Issue #1688: same double-eval hazard as the user-property
            // path above, for CLR properties (`obj.ClrProp += x`).
            value = ReceiverSubstitutionRewriter.Replace(value, rewritten.Receiver, receiver);
        }

        var spillValue = SideEffectAnalyzer.HasObservableSideEffect(value);
        if (!spillReceiver && !spillValue)
        {
            return rewritten;
        }

        value = this.MaybeSpill(value, spillValue, "val", statements);

        var assignment = new BoundClrPropertyAssignmentExpression(
            rewritten.Syntax,
            receiver,
            rewritten.Member,
            value,
            rewritten.Type);

        return new BoundBlockExpression(rewritten.Syntax, statements.ToImmutable(), assignment);
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
