// <copyright file="SpillSequenceSpiller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Rewrites an async method body so that every <see cref="BoundAwaitExpression"/>
/// appears only at statement top-level — either as a <see cref="BoundExpressionStatement"/>
/// or as the RHS of a <see cref="BoundVariableDeclaration"/> (or assignment to a spill temp).
/// Sub-expressions whose values must survive an await are lifted into spill locals.
/// After this pass, <see cref="MoveNextBodyRewriter"/> can process every await as
/// a simple top-level statement without concern for evaluation order of siblings.
/// </summary>
/// <remarks>
/// <para>This implementation handles:
/// <list type="bullet">
/// <item><description>Binary expressions (arithmetic/comparison) with await in either operand.</description></item>
/// <item><description>Short-circuit operators (<c>&amp;&amp;</c>, <c>||</c>) with await on the right.</description></item>
/// <item><description>Method calls (user, imported, imported-instance, CLR static/instance/ctor,
/// indirect, function-pointer) with await in the receiver/target and/or arguments.</description></item>
/// <item><description>Variable declarations and return statements with nested await.</description></item>
/// <item><description>Conversion expressions wrapping an await.</description></item>
/// <item><description>Ternary/conditional expressions with await in the condition and/or an arm
/// (issue #1619) — only the taken arm's await actually runs, via an if/else expansion
/// mirroring the short-circuit logical-operator spill.</description></item>
/// <item><description>Index expressions, array/tuple/struct/map literals, stack-alloc, append,
/// len/cap, is/as, field/property access and assignment, and CLR interop operators/indexers
/// with await in any operand (issue #1619) — each spilled left-to-right like a call's
/// argument list.</description></item>
/// <item><description>Switch expressions with await in the governing expression and/or an arm
/// value (issue #1619 completion) — spilled via an index-selecting rebuild of the switch (so
/// pattern-matching/guard semantics run unmodified against a spilled discriminant) followed by
/// an if/else-chain expansion keyed off the selected arm index, so only the taken arm's await
/// runs, mirroring the ternary spill.</description></item>
/// <item><description>Null-conditional access (<c>?.</c>) expressions with await in the receiver
/// and/or the when-not-null continuation (issue #1619 completion) — the receiver is spilled
/// once into the capture local/field and the continuation runs only on the non-nil path,
/// via an if/else expansion when the continuation itself contains await.</description></item>
/// <item><description>Conditional address-of expressions with await in a conditionally-selected
/// operand (ADR-0061; issue #1619 completion) — each operand's nested await is spilled behind a
/// conditional-goto guard so only the selected branch's side effects run, then the original
/// <see cref="Binding.BoundConditionalAddressExpression"/> node is rebuilt from the (now
/// await-free) operands so the existing branch-and-take-address emitter performs the final,
/// correct addressing — no byref-typed value is ever carried across the branch join.</description></item>
/// </list></para>
/// <para>Deferred cases (emit a diagnostic if encountered):
/// <list type="bullet">
/// <item><description>Ref/out arguments containing await.</description></item>
/// <item><description>Value-type receivers of instance methods containing await in arguments.</description></item>
/// <item><description>A switch-expression arm <c>when</c> guard containing await (issue #1619) —
/// guards must be re-evaluated for every candidate arm during dispatch, so an await inside a
/// guard would need to re-run (and re-suspend) for each pattern tried; this requires a fuller
/// per-guard suspension protocol that is out of scope here, so it remains diagnostic-gated.</description></item>
/// </list></para>
/// </remarks>
public static class SpillSequenceSpiller
{
    /// <summary>
    /// Rewrites <paramref name="body"/> so that all awaits are at statement top-level.
    /// </summary>
    /// <param name="body">The lowered async method body.</param>
    /// <returns>The spilled body (no <see cref="BoundSpillSequenceExpression"/> nodes survive).</returns>
    public static BoundBlockStatement Rewrite(BoundBlockStatement body)
    {
        if (!AsyncBoundTreeQueries.HasAwait(body))
        {
            return body;
        }

        var spiller = new Spiller();
        var result = spiller.RewriteBlock(body);
        return result;
    }

    /// <summary>
    /// Issue #3355: lifts block expressions containing <c>yield</c> statements
    /// to statement level before iterator state-machine rewriting. This keeps
    /// suspension points from branching out while a parent expression has
    /// partially populated the IL evaluation stack.
    /// </summary>
    /// <param name="body">Lowered iterator body.</param>
    /// <returns>Body with yield-bearing block expressions lifted to statement level.</returns>
    public static BoundBlockStatement RewriteIteratorBlocks(BoundBlockStatement body)
    {
        if (!HasYieldInBlockExpression(body))
        {
            return body;
        }

        return new Spiller(includeYieldInBlockExpressions: true).RewriteBlock(body);
    }

    /// <summary>
    /// Issue #3355: lifts block expressions containing non-local control flow
    /// before emission so return/goto paths never abandon a partially-filled
    /// parent-expression evaluation stack.
    /// </summary>
    /// <param name="body">Lowered function body.</param>
    /// <returns>Body with control-flow-bearing block expressions lifted to statement level.</returns>
    public static BoundBlockStatement RewriteControlFlowBlocks(BoundBlockStatement body)
    {
        if (!HasControlFlowInBlockExpression(body))
        {
            return body;
        }

        return new Spiller(includeControlFlowInBlockExpressions: true).RewriteBlock(body);
    }

    private static bool HasYieldInBlockExpression(BoundNode node, Dictionary<BoundNode, bool>? memo = null)
    {
        if (memo != null && memo.TryGetValue(node, out var cached))
        {
            return cached;
        }

        var walker = new YieldInBlockExpressionWalker();
        walker.Visit(node);
        memo?.Add(node, walker.Found);
        return walker.Found;
    }

    private static bool HasControlFlowInBlockExpression(BoundNode node, Dictionary<BoundNode, bool>? memo = null)
    {
        if (memo != null && memo.TryGetValue(node, out var cached))
        {
            return cached;
        }

        var walker = new ControlFlowInBlockExpressionWalker();
        walker.Visit(node);
        memo?.Add(node, walker.Found);
        return walker.Found;
    }

    private sealed class YieldInBlockExpressionWalker : BoundTreeWalker
    {
        private int blockExpressionDepth;

        public bool Found { get; private set; }

        protected override void VisitBlockExpression(BoundBlockExpression node)
        {
            blockExpressionDepth++;
            base.VisitBlockExpression(node);
            blockExpressionDepth--;
        }

        protected override void VisitYieldStatement(BoundYieldStatement node)
        {
            if (blockExpressionDepth > 0)
            {
                Found = true;
            }
        }
    }

    private sealed class ControlFlowInBlockExpressionWalker : BoundTreeWalker
    {
        private int blockExpressionDepth;

        public bool Found { get; private set; }

        public override void VisitStatement(BoundStatement? node)
        {
            if (node == null)
            {
                return;
            }

            if (blockExpressionDepth > 0
                && node.Kind is BoundNodeKind.GotoStatement
                    or BoundNodeKind.ConditionalGotoStatement
                    or BoundNodeKind.ReturnStatement
                    or BoundNodeKind.ThrowStatement
                    or BoundNodeKind.YieldStatement)
            {
                Found = true;
            }

            base.VisitStatement(node);
        }

        protected override void VisitBlockExpression(BoundBlockExpression node)
        {
            blockExpressionDepth++;
            base.VisitBlockExpression(node);
            blockExpressionDepth--;
        }
    }

    private sealed class Spiller
    {
        // Reference-keyed "does this subtree contain an await" cache shared by every
        // HasAwait probe this Spiller instance makes. RewriteStatementToList/SpillExpression
        // re-query the same child nodes at every recursion level; without this memo that
        // was an O(n^2) re-walk of the tree for an async body with n nodes (issue #1625).
        // Safe across the whole pass because rewriting always produces new node instances
        // (see BoundTreeRewriter) — a memoized entry is never observed for a mutated node.
        private readonly Dictionary<BoundNode, bool> awaitMemo = AsyncBoundTreeQueries.CreateHasAwaitMemo();
        private readonly Dictionary<BoundNode, bool> yieldInBlockMemo = [];
        private readonly Dictionary<BoundNode, bool> controlFlowInBlockMemo = [];
        private readonly bool includeYieldInBlockExpressions;
        private readonly bool includeControlFlowInBlockExpressions;

        // Issue #3592: each spiller pass names its temps in its own domain
        // ("c" = control-flow block lifting, "y" = iterator block lifting,
        // "" = the async await spiller) so passes running over the SAME method
        // body never mint two same-named locals with different types — the
        // async state machine maps hoisted locals to fields by name.
        private readonly string spillTempDomain;

        private int spillOrdinal;

        public Spiller(
            bool includeYieldInBlockExpressions = false,
            bool includeControlFlowInBlockExpressions = false)
        {
            this.includeYieldInBlockExpressions = includeYieldInBlockExpressions;
            this.includeControlFlowInBlockExpressions = includeControlFlowInBlockExpressions;
            this.spillTempDomain =
                includeControlFlowInBlockExpressions ? "c" :
                includeYieldInBlockExpressions ? "y" :
                string.Empty;
        }

        public BoundBlockStatement RewriteBlock(BoundBlockStatement block)
        {
            var builder = ImmutableArray.CreateBuilder<BoundStatement>();
            var changed = false;

            foreach (var statement in block.Statements)
            {
                var rewritten = RewriteStatementToList(statement, builder);
                if (rewritten)
                {
                    changed = true;
                }
            }

            if (!changed)
            {
                return block;
            }

            return new BoundBlockStatement(null, builder.ToImmutable());
        }

        /// <summary>
        /// Rewrites a statement, flattening any spill sequences into the builder.
        /// Returns true if anything changed.
        /// </summary>
        private bool RewriteStatementToList(BoundStatement statement, ImmutableArray<BoundStatement>.Builder builder)
        {
            switch (statement)
            {
                case BoundVariableDeclaration decl:
                    return RewriteVariableDeclaration(decl, builder);

                case BoundExpressionStatement exprStmt:
                    return RewriteExpressionStatement(exprStmt, builder);

                case BoundReturnStatement ret:
                    return RewriteReturnStatement(ret, builder);

                case BoundThrowStatement throwStatement:
                    return RewriteThrowStatement(throwStatement, builder);

                case BoundYieldStatement yieldStatement:
                    return RewriteYieldStatement(yieldStatement, builder);

                case BoundGoStatement goStatement:
                    return RewriteGoStatement(goStatement, builder);

                case BoundSelectStatement selectStatement:
                    return RewriteSelectStatement(selectStatement, builder);

                case BoundPatternSwitchStatement patternSwitchStatement:
                    return RewritePatternSwitchStatement(patternSwitchStatement, builder);

                case BoundScopeStatement scopeStatement:
                    return RewriteScopeStatement(scopeStatement, builder);

                case BoundIfStatement ifStmt:
                    return RewriteIfStatement(ifStmt, builder);

                case BoundConditionalGotoStatement condGoto:
                    return RewriteConditionalGotoStatement(condGoto, builder);

                case BoundTryStatement tryStmt:
                    return RewriteTryStatement(tryStmt, builder);

                case BoundBlockStatement nested:
                    var rewritten = RewriteBlock(nested);
                    builder.Add(rewritten);
                    return rewritten != nested;

                case BoundFixedStatement fixedStmt:
                    return RewriteFixedStatement(fixedStmt, builder);

                // Statements that are await-free leaves at this point in the pipeline.
                // Each is either structurally unable to contain a BoundExpression child,
                // or its expressions have been pre-spilled / lowered away by an earlier pass
                // (AsyncExceptionHandlerRewriter, Lowerer, iterator rewriter).
                case BoundLabelStatement:
                case BoundGotoStatement:
                case BoundAwaitSequencePoint:
                case BoundLocalFunctionDeclaration:
                    // Issue #1886: a generic local function's literal body is a
                    // separate lexical scope (mirrors BoundTreeRewriter's
                    // RewriteFunctionLiteralExpression) lowered independently
                    // when hosted for emission — nothing here to spill.
                    builder.Add(statement);
                    return false;

                default:
                    EmitDiagnosticException.Throw(
                        statement.Syntax,
                        $"SpillSequenceSpiller: unhandled BoundStatement kind '{statement.Kind}'.");
                    return false; // unreachable
            }
        }

        private bool RewriteScopeStatement(
            BoundScopeStatement scopeStatement,
            ImmutableArray<BoundStatement>.Builder builder)
        {
            var bodyBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
            if (!RewriteStatementToList(scopeStatement.Body, bodyBuilder))
            {
                builder.Add(scopeStatement);
                return false;
            }

            var body = bodyBuilder.Count == 1
                ? bodyBuilder[0]
                : new BoundBlockStatement(null, bodyBuilder.ToImmutable());
            builder.Add(new BoundScopeStatement(scopeStatement.Syntax, body));
            return true;
        }

        private bool RewriteVariableDeclaration(BoundVariableDeclaration decl, ImmutableArray<BoundStatement>.Builder builder)
        {
            if (decl.Initializer == null || !HasAwait(decl.Initializer))
            {
                builder.Add(decl);
                return false;
            }

            var spilled = SpillExpression(decl.Initializer);
            FlushSideEffects(spilled, builder);
            builder.Add(new BoundVariableDeclaration(null, decl.Variable, spilled.Value));
            return true;
        }

        private bool RewriteExpressionStatement(BoundExpressionStatement exprStmt, ImmutableArray<BoundStatement>.Builder builder)
        {
            if (!HasAwait(exprStmt.Expression))
            {
                builder.Add(exprStmt);
                return false;
            }

            // A direct await is already in the shape MoveNext consumes only when
            // its operand contains no nested await. `await F(await G())` still
            // needs its inner call argument spilled before the outer await.
            var topLevelAwait = exprStmt.Expression as BoundAwaitExpression;
            if (topLevelAwait is not null
                && !HasAwait(topLevelAwait.Expression))
            {
                builder.Add(exprStmt);
                return false;
            }

            // Same rule for `x = await ...`: a nested await in the awaited
            // operand still requires recursive spilling.
            var assignment = exprStmt.Expression as BoundAssignmentExpression;
            var assignedAwait = assignment?.Expression as BoundAwaitExpression;
            if (assignedAwait is not null
                && !HasAwait(assignedAwait.Expression))
            {
                builder.Add(exprStmt);
                return false;
            }

            var spilled = SpillExpression(exprStmt.Expression);
            FlushSideEffects(spilled, builder);
            if (spilled.Value is not BoundLiteralExpression)
            {
                builder.Add(new BoundExpressionStatement(null, spilled.Value));
            }

            return true;
        }

        private bool RewriteReturnStatement(BoundReturnStatement ret, ImmutableArray<BoundStatement>.Builder builder)
        {
            if (ret.Expression == null || !HasAwait(ret.Expression))
            {
                builder.Add(ret);
                return false;
            }

            // Always spill: even a direct `return await X` must be lifted into
            // `var __tmp = await X; return __tmp` so MoveNextBodyRewriter can
            // recognize the await as a top-level variable-declaration shape.
            // Leaving a BoundAwaitExpression as the direct return expression
            // would leak an un-rewritten await to the emitter (issue #132).
            var spilled = SpillExpression(ret.Expression);
            FlushSideEffects(spilled, builder);
            builder.Add(new BoundReturnStatement(null, spilled.Value));
            return true;
        }

        private bool RewriteThrowStatement(
            BoundThrowStatement throwStatement,
            ImmutableArray<BoundStatement>.Builder builder)
        {
            if (!HasAwait(throwStatement.Expression))
            {
                builder.Add(throwStatement);
                return false;
            }

            var spilled = SpillExpression(throwStatement.Expression);
            FlushSideEffects(spilled, builder);
            builder.Add(new BoundThrowStatement(
                null,
                spilled.Value,
                throwStatement.DiagnosticDescriptor));
            return true;
        }

        private bool RewriteYieldStatement(
            BoundYieldStatement yieldStatement,
            ImmutableArray<BoundStatement>.Builder builder)
        {
            if (!HasAwait(yieldStatement.Expression))
            {
                builder.Add(yieldStatement);
                return false;
            }

            var spilled = SpillExpression(yieldStatement.Expression);
            FlushSideEffects(spilled, builder);
            builder.Add(new BoundYieldStatement(null, spilled.Value));
            return true;
        }

        private bool RewritePatternSwitchStatement(
            BoundPatternSwitchStatement switchStatement,
            ImmutableArray<BoundStatement>.Builder builder)
        {
            var changed = false;
            var discriminant = switchStatement.Discriminant;
            if (HasAwait(discriminant))
            {
                var spilled = SpillExpression(discriminant);
                FlushSideEffects(spilled, builder);
                discriminant = spilled.Value;
                changed = true;
            }

            var arms = ImmutableArray.CreateBuilder<BoundPatternSwitchArm>(switchStatement.Arms.Length);
            foreach (var arm in switchStatement.Arms)
            {
                var guard = arm.Guard;
                if (guard != null && HasAwait(guard))
                {
                    guard = SpillSwitchGuard(guard, "switch-statement");
                    changed = true;
                }

                var bodyBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
                var bodyChanged = RewriteStatementToList(arm.Body, bodyBuilder);
                var body = bodyChanged
                    ? bodyBuilder.Count == 1
                        ? bodyBuilder[0]
                        : new BoundBlockStatement(null, bodyBuilder.ToImmutable())
                    : arm.Body;
                changed |= bodyChanged;
                arms.Add(new BoundPatternSwitchArm(arm.Syntax, arm.Pattern, guard, body));
            }

            if (!changed)
            {
                builder.Add(switchStatement);
                return false;
            }

            builder.Add(new BoundPatternSwitchStatement(
                switchStatement.Syntax,
                discriminant,
                arms.MoveToImmutable(),
                switchStatement.IsExhaustive));
            return true;
        }

        private BoundExpression SpillSwitchGuard(BoundExpression guard, string switchKind)
        {
            if (AsyncBoundTreeQueries.HasAwait(guard, awaitMemo))
            {
                var anchor = guard.Syntax ?? AsyncBoundTreeQueries.FindFirstAwaitSyntax(guard);
                EmitDiagnosticException.Throw(
                    anchor,
                    $"'await' inside a {switchKind} 'when' guard is not yet supported across a suspension point.");
            }

            var spilled = SpillExpression(guard);
            return new BoundBlockExpression(null, spilled.SideEffects, spilled.Value);
        }

        private bool RewriteSelectStatement(
            BoundSelectStatement selectStatement,
            ImmutableArray<BoundStatement>.Builder builder)
        {
            var spillHeader = selectStatement.Cases.Any(selectCase =>
                (selectCase.Channel != null && HasAwait(selectCase.Channel))
                || (selectCase.Value != null && HasAwait(selectCase.Value)));
            var changed = spillHeader;
            var cases = ImmutableArray.CreateBuilder<BoundSelectCase>(selectStatement.Cases.Length);

            foreach (var selectCase in selectStatement.Cases)
            {
                var channel = selectCase.Channel;
                if (spillHeader && channel != null)
                {
                    channel = SpillAndCaptureSelectOperand(channel, builder);
                }

                var value = selectCase.Value;
                if (spillHeader && value != null)
                {
                    value = SpillAndCaptureSelectOperand(value, builder);
                }

                var bodyBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
                var bodyChanged = RewriteStatementToList(selectCase.Body, bodyBuilder);
                var body = bodyChanged
                    ? bodyBuilder.Count == 1
                        ? bodyBuilder[0]
                        : new BoundBlockStatement(null, bodyBuilder.ToImmutable())
                    : selectCase.Body;
                changed |= bodyChanged;
                cases.Add(new BoundSelectCase(
                    selectCase.CaseKind,
                    channel,
                    value,
                    selectCase.Variable,
                    body));
            }

            if (!changed)
            {
                builder.Add(selectStatement);
                return false;
            }

            builder.Add(new BoundSelectStatement(selectStatement.Syntax, cases.MoveToImmutable()));
            return true;
        }

        private BoundExpression SpillAndCaptureSelectOperand(
            BoundExpression expression,
            ImmutableArray<BoundStatement>.Builder builder)
        {
            if (HasAwait(expression))
            {
                var spilled = SpillExpression(expression);
                FlushSideEffects(spilled, builder);
                expression = spilled.Value;
            }

            var temp = MakeSpillTemp(expression.Type);
            builder.Add(new BoundVariableDeclaration(null, temp, expression));
            return new BoundVariableExpression(null, temp);
        }

        private bool RewriteGoStatement(
            BoundGoStatement goStatement,
            ImmutableArray<BoundStatement>.Builder builder)
        {
            if (!HasAwait(goStatement.Expression))
            {
                builder.Add(goStatement);
                return false;
            }

            var spilled = SpillExpression(goStatement.Expression);
            FlushSideEffects(spilled, builder);
            builder.Add(new BoundGoStatement(null, spilled.Value));
            return true;
        }

        private bool RewriteFixedStatement(
            BoundFixedStatement fixedStatement,
            ImmutableArray<BoundStatement>.Builder builder)
        {
            var pinnedSource = fixedStatement.PinnedSource;
            var sourceChanged = false;
            if (HasAwait(pinnedSource))
            {
                var spilledSource = SpillExpression(pinnedSource);
                FlushSideEffects(spilledSource, builder);
                pinnedSource = spilledSource.Value;
                sourceChanged = true;
            }

            var fixedBody = fixedStatement.Body is BoundBlockStatement fixedBlock
                ? RewriteBlock(fixedBlock)
                : fixedStatement.Body;
            var rebuilt = !sourceChanged && fixedBody == fixedStatement.Body
                ? fixedStatement
                : new BoundFixedStatement(
                    fixedStatement.Syntax,
                    fixedStatement.PinKind,
                    fixedStatement.PinnedVariable,
                    fixedStatement.PointerVariable,
                    pinnedSource,
                    fixedBody,
                    fixedStatement.SourceVariable);
            builder.Add(rebuilt);
            return rebuilt != fixedStatement;
        }

        private bool RewriteIfStatement(BoundIfStatement ifStmt, ImmutableArray<BoundStatement>.Builder builder)
        {
            // Spill the condition if it contains an await.
            BoundExpression condition = ifStmt.Condition;
            var conditionChanged = false;

            if (HasAwait(condition))
            {
                var spilledCond = SpillExpression(condition);
                FlushSideEffects(spilledCond, builder);
                condition = spilledCond.Value;
                conditionChanged = true;
            }

            // Recursively rewrite branches.
            var thenBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
            var thenChanged = RewriteStatementToList(ifStmt.ThenStatement, thenBuilder);
            var thenStmt = thenChanged
                ? (thenBuilder.Count == 1 ? thenBuilder[0] : new BoundBlockStatement(null, thenBuilder.ToImmutable()))
                : ifStmt.ThenStatement;

            BoundStatement? elseStmt = ifStmt.ElseStatement;
            var elseChanged = false;
            if (elseStmt != null)
            {
                var elseBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
                elseChanged = RewriteStatementToList(elseStmt, elseBuilder);
                if (elseChanged)
                {
                    elseStmt = elseBuilder.Count == 1 ? elseBuilder[0] : new BoundBlockStatement(null, elseBuilder.ToImmutable());
                }
            }

            if (!conditionChanged && !thenChanged && !elseChanged)
            {
                builder.Add(ifStmt);
                return false;
            }

            builder.Add(new BoundIfStatement(null, condition, thenStmt, elseStmt));
            return true;
        }

        /// <summary>
        /// Spills awaits that appear inside a <see cref="BoundConditionalGotoStatement"/>
        /// condition. By the time the spiller runs, the Lowerer and the statement
        /// binder have already desugared <c>if</c>/<c>while</c>/<c>for</c>/<c>do-while</c>
        /// statements into label/goto form, so an await embedded in a branch or loop
        /// condition lives here rather than in a <see cref="BoundIfStatement"/>
        /// (issue #1266). Without this case the condition await leaked un-rewritten to
        /// the emitter, which threw <c>GS9998</c>.
        /// </summary>
        /// <remarks>
        /// The spilled side-effects (including the await suspension points) are emitted
        /// immediately before the conditional goto. For loops the binder places the
        /// loop's <c>check:</c> label directly ahead of this conditional goto, so the
        /// spilled condition computation sits inside the loop and is re-evaluated on
        /// every iteration — preserving while/for/do-while re-evaluation semantics. The
        /// <see cref="SpillExpression"/> call also handles short-circuiting
        /// <c>&amp;&amp;</c>/<c>||</c> conditions (see <c>SpillLogicalAnd</c>/
        /// <c>SpillLogicalOr</c>), so a right-operand await only runs when the left
        /// operand requires it.
        /// </remarks>
        private bool RewriteConditionalGotoStatement(BoundConditionalGotoStatement gotoStmt, ImmutableArray<BoundStatement>.Builder builder)
        {
            if (!HasAwait(gotoStmt.Condition))
            {
                builder.Add(gotoStmt);
                return false;
            }

            var spilled = SpillExpression(gotoStmt.Condition);
            FlushSideEffects(spilled, builder);
            builder.Add(new BoundConditionalGotoStatement(null, gotoStmt.Label, spilled.Value, gotoStmt.JumpIfTrue));
            return true;
        }

        /// <summary>
        /// Spills sub-expression awaits nested inside a <see cref="BoundTryStatement"/>'s
        /// protected block (and, defensively, its handler/finally blocks). Awaits in the
        /// try body are legal suspension points that <see cref="MoveNextBodyRewriter"/>
        /// handles once they sit at statement top-level, but they only reach that form
        /// if the spiller descends into the try region. Treating the try as an opaque
        /// await-free leaf (the prior behaviour) left a sub-expression await such as
        /// <c>F(await G())</c> unspilled, leaking a <see cref="BoundAwaitExpression"/>
        /// into the emitted MoveNext body.
        /// </summary>
        private bool RewriteTryStatement(BoundTryStatement tryStmt, ImmutableArray<BoundStatement>.Builder builder)
        {
            var tryBlock = RewriteNestedBody(tryStmt.TryBlock, out var tryChanged);

            var catchesChanged = false;
            var catchBuilder = ImmutableArray.CreateBuilder<BoundCatchClause>(tryStmt.CatchClauses.Length);
            foreach (var clause in tryStmt.CatchClauses)
            {
                var body = RewriteNestedBody(clause.Body, out var clauseChanged);
                catchesChanged |= clauseChanged;
                catchBuilder.Add(clauseChanged
                    ? new BoundCatchClause(clause.ExceptionType, clause.Variable, body)
                    : clause);
            }

            var finallyBlock = RewriteNestedBody(tryStmt.FinallyBlock, out var finallyChanged);

            if (!tryChanged && !catchesChanged && !finallyChanged)
            {
                builder.Add(tryStmt);
                return false;
            }

            builder.Add(new BoundTryStatement(
                tryStmt.Syntax,
                tryBlock,
                catchesChanged ? catchBuilder.ToImmutable() : tryStmt.CatchClauses,
                finallyBlock));
            return true;
        }

        /// <summary>
        /// Spills a try/catch/finally sub-block. Returns the rewritten body and
        /// reports whether anything changed.
        /// </summary>
        [return: NotNullIfNotNull(nameof(body))]
        private BoundStatement? RewriteNestedBody(BoundStatement? body, out bool changed)
        {
            if (body == null)
            {
                changed = false;
                return null;
            }

            if (body is BoundBlockStatement block)
            {
                var rewritten = RewriteBlock(block);
                changed = !ReferenceEquals(rewritten, block);
                return rewritten;
            }

            var nestedBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
            changed = RewriteStatementToList(body, nestedBuilder);
            if (!changed)
            {
                return body;
            }

            return nestedBuilder.Count == 1
                ? nestedBuilder[0]
                : new BoundBlockStatement(body.Syntax, nestedBuilder.ToImmutable());
        }

        /// <summary>
        /// Core spilling: recursively visit an expression, returning a
        /// <see cref="BoundSpillSequenceExpression"/> whose Value has no
        /// embedded awaits (they've all been lifted out as side-effect statements).
        /// If the expression has no awaits, returns a trivial spill sequence.
        /// </summary>
        private BoundSpillSequenceExpression SpillExpression(BoundExpression expression)
        {
            switch (expression)
            {
                case BoundAwaitExpression awaitExpr:
                    return SpillAwait(awaitExpr);

                case BoundBinaryExpression binary:
                    return SpillBinary(binary);

                case BoundCallExpression call:
                    return SpillCall(call);

                case BoundConstrainedStaticCallExpression cstatic:
                    return SpillConstrainedStaticCall(cstatic);

                case BoundImportedCallExpression importedCall:
                    return SpillImportedCall(importedCall);

                case BoundImportedInstanceCallExpression instanceCall:
                    return SpillImportedInstanceCall(instanceCall);

                case BoundConversionExpression conv:
                    return SpillConversion(conv);

                case BoundAssignmentExpression assign:
                    return SpillAssignment(assign);

                case BoundFieldAssignmentExpression fieldAssign:
                    return SpillFieldAssignment(fieldAssign);

                case BoundIndexAssignmentExpression indexAssign:
                    return SpillIndexAssignment(indexAssign);

                case BoundUnaryExpression unary:
                    return SpillUnary(unary);

                case BoundUserInstanceCallExpression userInstance:
                    return SpillUserInstanceCall(userInstance);
                case BoundBaseInterfaceCallExpression baseInterface:
                    return SpillBaseInterfaceCall(baseInterface);
                case BoundBaseClassCallExpression baseClass:
                    return SpillBaseClassCall(baseClass);

                case BoundBlockExpression block:
                    return SpillBlockExpression(block);

                // Conditional (ternary) expression — issue #1619. Arms are
                // conditionally evaluated, so an await in an arm mirrors the
                // short-circuit if/else expansion used by SpillLogicalAnd/Or
                // rather than the plain left-to-right spill of SpillBinary.
                case BoundConditionalExpression conditional:
                    return SpillConditional(conditional);

                // Index expression — issue #1619 (arr[await idx()]).
                case BoundIndexExpression index:
                    return SpillIndex(index);

                // CLR interop calls/ctors/operators — issue #1619. Arguments
                // (and, where present, a receiver/pointer) are spilled
                // left-to-right exactly like the user-call spill paths above.
                case BoundClrStaticCallExpression clrStatic:
                    return SpillClrStaticCall(clrStatic);
                case BoundClrConstructorCallExpression clrCtor:
                    return SpillClrConstructorCall(clrCtor);
                case BoundConstructorCallExpression ctorCall:
                    return SpillConstructorCall(ctorCall);
                case BoundConstructorChainingExpression ctorChain:
                    return SpillConstructorChaining(ctorChain);
                case BoundIndirectCallExpression indirectCall:
                    return SpillIndirectCall(indirectCall);
                case BoundFunctionPointerInvocationExpression fpInvoke:
                    return SpillFunctionPointerInvocation(fpInvoke);
                case BoundClrIndexExpression clrIndex:
                    return SpillClrIndex(clrIndex);
                case BoundClrIndexAssignmentExpression clrIndexAssign:
                    return SpillClrIndexAssignment(clrIndexAssign);
                case BoundClrPropertyAccessExpression clrPropAccess:
                    return SpillClrPropertyAccess(clrPropAccess);
                case BoundClrPropertyAssignmentExpression clrPropAssign:
                    var propertyReceiver = clrPropAssign.Receiver;
                    if (propertyReceiver == null)
                    {
                        return SpillOneOperand(
                            clrPropAssign,
                            clrPropAssign.Value,
                            value => new BoundClrPropertyAssignmentExpression(
                                null,
                                null,
                                clrPropAssign.Member,
                                value,
                                clrPropAssign.Type,
                                clrPropAssign.StaticContainerType,
                                clrPropAssign.ConstrainedReceiverTypeParameter,
                                clrPropAssign.ConstrainedInterfaceType));
                    }

                    return SpillTwoOperand(
                        clrPropAssign,
                        propertyReceiver,
                        clrPropAssign.Value,
                        (recv, val) => new BoundClrPropertyAssignmentExpression(
                            null,
                            recv,
                            clrPropAssign.Member,
                            val,
                            clrPropAssign.Type,
                            clrPropAssign.StaticContainerType,
                            clrPropAssign.ConstrainedReceiverTypeParameter,
                            clrPropAssign.ConstrainedInterfaceType));
                case BoundClrBinaryOperatorExpression clrBinary:
                    // Issue #2388: preserve whichever of Method (imported CLR
                    // type) / Function (nullable-lifted same-compilation
                    // struct operator) the original node carried.
                    return SpillTwoOperand(
                        clrBinary,
                        clrBinary.Left,
                        clrBinary.Right,
                        (l, r) => clrBinary.Function != null
                            ? new BoundClrBinaryOperatorExpression(null, clrBinary.OperatorKind, l, r, clrBinary.Function, clrBinary.FunctionOwnerType, clrBinary.Type)
                            : new BoundClrBinaryOperatorExpression(null, clrBinary.OperatorKind, l, r, clrBinary.Method, clrBinary.Type));
                case BoundClrUnaryOperatorExpression clrUnary:
                    return SpillOneOperand(
                        clrUnary,
                        clrUnary.Operand,
                        operand => new BoundClrUnaryOperatorExpression(null, clrUnary.OperatorKind, operand, clrUnary.Method, clrUnary.Type));
                case BoundClrConversionCallExpression clrConv:
                    return SpillOneOperand(
                        clrConv,
                        clrConv.Source,
                        src => clrConv.Function != null
                            ? new BoundClrConversionCallExpression(
                                null,
                                src,
                                clrConv.Function,
                                clrConv.FunctionOwnerType,
                                clrConv.Type)
                            : new BoundClrConversionCallExpression(
                                null,
                                src,
                                Invariant.Required(clrConv.Method, "an imported conversion carries a CLR method"),
                                clrConv.Type));
                case BoundClrEventSubscriptionExpression clrEventSub:
                    if (clrEventSub.Receiver == null)
                    {
                        return SpillOneOperand(
                            clrEventSub,
                            clrEventSub.Handler,
                            handler => new BoundClrEventSubscriptionExpression(
                                null,
                                receiver: null,
                                clrEventSub.Event,
                                handler,
                                clrEventSub.IsAdd,
                                clrEventSub.ConstrainedReceiverTypeParameter,
                                clrEventSub.ConstrainedInterfaceType,
                                clrEventSub.EventContainingType));
                    }

                    return SpillTwoOperand(
                        clrEventSub,
                        clrEventSub.Receiver,
                        clrEventSub.Handler,
                        (recv, handler) => new BoundClrEventSubscriptionExpression(
                            null,
                            recv,
                            clrEventSub.Event,
                            handler,
                            clrEventSub.IsAdd,
                            clrEventSub.ConstrainedReceiverTypeParameter,
                            clrEventSub.ConstrainedInterfaceType,
                            clrEventSub.EventContainingType));
                case BoundEventSubscriptionExpression eventSub:
                    if (eventSub.Receiver == null)
                    {
                        return SpillOneOperand(
                            eventSub,
                            eventSub.Handler,
                            handler => new BoundEventSubscriptionExpression(
                                null,
                                receiver: null,
                                eventSub.StructType,
                                eventSub.Event,
                                handler,
                                eventSub.IsAdd));
                    }

                    return SpillTwoOperand(
                        eventSub,
                        eventSub.Receiver,
                        eventSub.Handler,
                        (recv, handler) => new BoundEventSubscriptionExpression(null, recv, eventSub.StructType, eventSub.Event, handler, eventSub.IsAdd));

                case BoundFieldAccessExpression fieldAccess:
                    return SpillFieldAccess(fieldAccess);
                case BoundPropertyAccessExpression propAccess:
                    if (propAccess.Receiver == null)
                    {
                        return Trivial(propAccess);
                    }

                    return SpillOneOperand(
                        propAccess,
                        propAccess.Receiver,
                        receiver => new BoundPropertyAccessExpression(
                            null,
                            receiver,
                            propAccess.StructType,
                            propAccess.Property,
                            propAccess.SubstitutedType,
                            propAccess.NarrowedType,
                            propAccess.InterfaceType));
                case BoundPropertyAssignmentExpression propAssign:
                    if (propAssign.Receiver == null)
                    {
                        return SpillOneOperand(
                            propAssign,
                            propAssign.Value,
                            value => new BoundPropertyAssignmentExpression(
                                null,
                                receiver: null,
                                propAssign.StructType,
                                propAssign.Property,
                                value,
                                propAssign.SubstitutedType,
                                propAssign.InterfaceType));
                    }

                    return SpillTwoOperand(
                        propAssign,
                        propAssign.Receiver,
                        propAssign.Value,
                        (recv, val) => new BoundPropertyAssignmentExpression(
                            null,
                            recv,
                            propAssign.StructType,
                            propAssign.Property,
                            val,
                            propAssign.SubstitutedType,
                            propAssign.InterfaceType));
                case BoundTupleLiteralExpression tupleLiteral:
                    return SpillTupleLiteral(tupleLiteral);
                case BoundTupleElementAccessExpression tupleAccess:
                    return SpillOneOperand(
                        tupleAccess,
                        tupleAccess.Receiver,
                        recv => new BoundTupleElementAccessExpression(null, recv, tupleAccess.TupleType, tupleAccess.Index));
                case BoundInterpolatedStringExpression interpolated:
                    return SpillInterpolatedString(interpolated);
                case BoundArrayCreationExpression arrayCreation:
                    return SpillArrayCreation(arrayCreation);
                case BoundStackAllocExpression stackAlloc:
                    return SpillStackAlloc(stackAlloc);
                case BoundLenExpression len:
                    return SpillOneOperand(
                        len,
                        len.Operand,
                        operand => new BoundLenExpression(null, operand));
                case BoundStructLiteralExpression structLiteral:
                    return SpillStructLiteral(structLiteral);
                case BoundMapLiteralExpression mapLiteral:
                    return SpillMapLiteral(mapLiteral);
                case BoundIsExpression isExpr:
                    return SpillOneOperand(
                        isExpr,
                        isExpr.Expression,
                        operand => new BoundIsExpression(null, operand, isExpr.Pattern));
                case BoundAsExpression asExpr:
                    return SpillOneOperand(
                        asExpr,
                        asExpr.Expression,
                        operand => new BoundAsExpression(null, operand, asExpr.TargetType));
                case BoundThrowExpression throwExpr:
                    return SpillOneOperand(
                        throwExpr,
                        throwExpr.Expression,
                        operand => new BoundThrowExpression(null, operand));
                case BoundAddressOfExpression addressOf:
                    return SpillOneOperand(
                        addressOf,
                        addressOf.Operand,
                        operand => new BoundAddressOfExpression(null, operand));
                case BoundDereferenceExpression dereference:
                    return SpillOneOperand(
                        dereference,
                        dereference.Operand,
                        operand => new BoundDereferenceExpression(null, operand));
                case BoundIndirectAssignmentExpression indirectAssign:
                    return SpillTwoOperand(
                        indirectAssign,
                        indirectAssign.Pointer,
                        indirectAssign.Value,
                        (ptr, val) => new BoundIndirectAssignmentExpression(null, ptr, val));

                // Switch expression — issue #1619 completion. The governing
                // (discriminant) expression and each arm's result are spilled
                // via a two-phase index dispatch (see SpillSwitch); only a
                // `when`-guard containing `await` remains diagnostic-gated
                // (see SpillSwitch for why).
                case BoundSwitchExpression switchExpr:
                    return SpillSwitch(switchExpr);

                // Null-conditional access (`?.`) — issue #1619 completion.
                // Mirrors SpillConditional: the receiver is always evaluated,
                // but the (possibly await-containing) access only runs on
                // the non-nil path.
                case BoundNullConditionalAccessExpression nullConditional:
                    return SpillNullConditionalAccess(nullConditional);

                // Conditional address-of (ADR-0061) — issue #1619 completion.
                // Same if/else shape as SpillConditional, but the selected
                // branch's lvalue address is taken only after its own await
                // (if any) has resolved.
                case BoundConditionalAddressExpression condAddr:
                    return SpillConditionalAddress(condAddr);

                // Expression kinds that are trivial for spilling — they are either
                // leaf nodes (no BoundExpression children that could contain an await)
                // or their children are structurally unable to hold an await at this
                // point in the pipeline. If HasAwait(expression) returned true at the
                // caller but control reaches here, a spiller blind spot exists for
                // this kind. The throw in the default arm surfaces it as a GS9998
                // instead of silently producing invalid IL.
                case BoundLiteralExpression:
                case BoundVariableExpression:
                case BoundDefaultExpression:
                case BoundTypeParameterConstructionExpression:
                case BoundTypeOfExpression:
                case BoundSizeOfExpression:
                case BoundFunctionPointerFromMethodExpression:
                case BoundMethodGroupExpression:
                case BoundClrMethodGroupExpression:
                case BoundFunctionLiteralExpression:
                case BoundErrorExpression:
                case BoundSpillSequenceExpression:
                case BoundStateMachineAwaitOnCompleted:
                case BoundStateMachineBuilderMoveNext:
                    return Trivial(expression);

                default:
                    EmitDiagnosticException.Throw(
                        expression.Syntax,
                        $"SpillSequenceSpiller: unhandled BoundExpression kind '{expression.Kind}'.");
                    return null; // unreachable
            }
        }

        /// <summary>
        /// Spills a <see cref="BoundBlockExpression"/> (e.g. an interpolated
        /// string lowered to the handler pattern, issue #368) by flattening its
        /// statements through the statement rewriter — lifting any awaits to
        /// statement level — and then spilling the trailing value expression.
        /// The hole pre-evaluation in <c>InterpolatedStringHandlerLowerer</c>
        /// guarantees awaits precede the (possibly ByRefLike) handler local, so
        /// no handler local is live across a suspension after this flattening.
        /// </summary>
        private BoundSpillSequenceExpression SpillBlockExpression(BoundBlockExpression block)
        {
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();
            foreach (var statement in block.Statements)
            {
                RewriteStatementToList(statement, sideEffects);
            }

            var valueSpill = SpillExpression(block.Expression);
            sideEffects.AddRange(valueSpill.SideEffects);

            return new BoundSpillSequenceExpression(
                null,
                valueSpill.Locals,
                sideEffects.ToImmutable(),
                valueSpill.Value);
        }

        private BoundSpillSequenceExpression SpillAwait(BoundAwaitExpression awaitExpr)
        {
            // First, spill the inner expression of the await (e.g. the Task).
            BoundSpillSequenceExpression? innerSpill = null;
            BoundExpression innerExpr = awaitExpr.Expression;

            if (HasAwait(awaitExpr.Expression))
            {
                innerSpill = SpillExpression(awaitExpr.Expression);
                innerExpr = innerSpill.Value;
            }

            var awaitNode = new BoundAwaitExpression(null, innerExpr, awaitExpr.Type, awaitExpr.AwaiterTypeSymbol);

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            if (innerSpill != null)
            {
                locals.AddRange(innerSpill.Locals);
                sideEffects.AddRange(innerSpill.SideEffects);
            }

            if (awaitExpr.Type == TypeSymbol.Void)
            {
                sideEffects.Add(new BoundExpressionStatement(null, awaitNode));
                return new BoundSpillSequenceExpression(
                    null,
                    locals.ToImmutable(),
                    sideEffects.ToImmutable(),
                    new BoundLiteralExpression(null, 0, TypeSymbol.Void));
            }

            // Create a spill temp for a value-producing await result.
            var spillLocal = MakeSpillTemp(awaitExpr.Type);
            locals.Add(spillLocal);
            sideEffects.Add(new BoundVariableDeclaration(null, spillLocal, awaitNode));

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, spillLocal));
        }

        private BoundSpillSequenceExpression SpillBinary(BoundBinaryExpression binary)
        {
            // Short-circuit operators: expand into if/else.
            if (binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd)
            {
                return SpillLogicalAnd(binary);
            }

            if (binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr)
            {
                return SpillLogicalOr(binary);
            }

            if (binary.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
            {
                return SpillNullCoalesce(binary);
            }

            var leftHasAwait = HasAwait(binary.Left);
            var rightHasAwait = HasAwait(binary.Right);

            if (!leftHasAwait && !rightHasAwait)
            {
                return Trivial(binary);
            }

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression left;
            if (leftHasAwait)
            {
                var spilledLeft = SpillExpression(binary.Left);
                locals.AddRange(spilledLeft.Locals);
                sideEffects.AddRange(spilledLeft.SideEffects);
                left = spilledLeft.Value;
            }
            else
            {
                left = binary.Left;
            }

            // If right has await, the left must be spilled to a temp
            // (unless it's a pure constant or simple variable read).
            if (rightHasAwait && !CanDeferAcrossLift(left))
            {
                var leftTemp = MakeSpillTemp(left.Type);
                locals.Add(leftTemp);
                sideEffects.Add(new BoundVariableDeclaration(null, leftTemp, left));
                left = new BoundVariableExpression(null, leftTemp);
            }

            BoundExpression right;
            if (rightHasAwait)
            {
                var spilledRight = SpillExpression(binary.Right);
                locals.AddRange(spilledRight.Locals);
                sideEffects.AddRange(spilledRight.SideEffects);
                right = spilledRight.Value;
            }
            else
            {
                right = binary.Right;
            }

            var value = new BoundBinaryExpression(null, left, binary.Op, right);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(value);
            }

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillLogicalAnd(BoundBinaryExpression binary)
        {
            // a && (await b) => { var tmp = false; if (a) goto evalRight; goto end; evalRight: tmp = await b; end: VALUE=tmp }
            var resultLocal = MakeSpillTemp(binary.Type);
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            // Spill the left side.
            BoundExpression left = binary.Left;
            if (HasAwait(binary.Left))
            {
                var spilledLeft = SpillExpression(binary.Left);
                locals.AddRange(spilledLeft.Locals);
                sideEffects.AddRange(spilledLeft.SideEffects);
                left = spilledLeft.Value;
            }

            var evalRightLabel = MakeLabel();
            var endLabel = MakeLabel();

            // if (left) goto evalRight
            sideEffects.Add(new BoundConditionalGotoStatement(null, evalRightLabel, left, jumpIfTrue: true));

            // tmp = false; goto end
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, new BoundLiteralExpression(null, false))));
            sideEffects.Add(new BoundGotoStatement(null, endLabel));

            // evalRight: tmp = await b
            sideEffects.Add(new BoundLabelStatement(null, evalRightLabel));
            var spilledRight = SpillExpression(binary.Right);
            locals.AddRange(spilledRight.Locals);
            sideEffects.AddRange(spilledRight.SideEffects);
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, spilledRight.Value)));

            // end:
            sideEffects.Add(new BoundLabelStatement(null, endLabel));

            locals.Add(resultLocal);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, resultLocal));
        }

        private BoundSpillSequenceExpression SpillNullCoalesce(BoundBinaryExpression binary)
        {
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            var spilledLeft = SpillExpression(binary.Left);
            locals.AddRange(spilledLeft.Locals);
            sideEffects.AddRange(spilledLeft.SideEffects);

            var leftLocal = MakeSpillTemp(binary.Left.Type);
            locals.Add(leftLocal);
            sideEffects.Add(new BoundVariableDeclaration(null, leftLocal, spilledLeft.Value));

            var resultLocal = MakeSpillTemp(binary.Type);
            locals.Add(resultLocal);
            var useLeftLabel = MakeLabel();
            var endLabel = MakeLabel();
            sideEffects.Add(new BoundConditionalGotoStatement(
                null,
                useLeftLabel,
                new BoundVariableExpression(null, leftLocal),
                jumpIfTrue: true));

            var spilledRight = SpillExpression(binary.Right);
            locals.AddRange(spilledRight.Locals);
            sideEffects.AddRange(spilledRight.SideEffects);
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, spilledRight.Value)));
            sideEffects.Add(new BoundGotoStatement(null, endLabel));

            sideEffects.Add(new BoundLabelStatement(null, useLeftLabel));
            BoundExpression leftValue = new BoundVariableExpression(null, leftLocal);
            if (leftLocal.Type is NullableTypeSymbol)
            {
                var unwrapOp = Invariant.Required(
                    BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, leftLocal.Type),
                    "the left operand of null coalescing is nullable and always supports `!!`");
                leftValue = new BoundUnaryExpression(null, unwrapOp, leftValue);
            }

            if (leftValue.Type != binary.Type)
            {
                leftValue = new BoundConversionExpression(null, binary.Type, leftValue);
            }

            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, leftValue)));
            sideEffects.Add(new BoundLabelStatement(null, endLabel));

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, resultLocal));
        }

        private BoundSpillSequenceExpression SpillLogicalOr(BoundBinaryExpression binary)
        {
            // a || (await b) => { var tmp = true; if (a) goto end; tmp = await b; end: VALUE=tmp }
            var resultLocal = MakeSpillTemp(binary.Type);
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression left = binary.Left;
            if (HasAwait(binary.Left))
            {
                var spilledLeft = SpillExpression(binary.Left);
                locals.AddRange(spilledLeft.Locals);
                sideEffects.AddRange(spilledLeft.SideEffects);
                left = spilledLeft.Value;
            }

            var endLabel = MakeLabel();

            // if (left) { tmp = true; goto end }
            sideEffects.Add(new BoundConditionalGotoStatement(null, endLabel, left, jumpIfTrue: true));

            // else: tmp = await b
            var spilledRight = SpillExpression(binary.Right);
            locals.AddRange(spilledRight.Locals);
            sideEffects.AddRange(spilledRight.SideEffects);
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, spilledRight.Value)));
            var skipTrueLabel = MakeLabel();
            sideEffects.Add(new BoundGotoStatement(null, skipTrueLabel));

            // end:  (jumped to when left is true)
            sideEffects.Add(new BoundLabelStatement(null, endLabel));
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, new BoundLiteralExpression(null, true))));

            // skipTrue:
            sideEffects.Add(new BoundLabelStatement(null, skipTrueLabel));

            locals.Add(resultLocal);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, resultLocal));
        }

        private BoundSpillSequenceExpression SpillCall(BoundCallExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundCallExpression(null, call.Function, args.ToImmutable(), call.ReturnType, call.IsConditionalElided)
            {
                StaticGenericOwnerType = call.StaticGenericOwnerType,
                StaticGenericInterfaceOwnerType = call.StaticGenericInterfaceOwnerType,
                MethodTypeArguments = call.MethodTypeArguments,
            };
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillConstrainedStaticCall(BoundConstrainedStaticCallExpression call)
        {
            // ADR-0089 / issue #755: structurally identical to BoundCallExpression
            // for spilling — no receiver expression to evaluate, just argument
            // evaluation order needs preserving across awaits.
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            // Issue #3525: the imported-CLR-interface shape carries a
            // MethodInfo (ClrMethod) instead of a FunctionSymbol (InterfaceMethod).
            var value = call.InterfaceMethod != null
                ? new BoundConstrainedStaticCallExpression(
                    call.Syntax,
                    call.TypeParameter,
                    call.InterfaceMethod,
                    args.ToImmutable(),
                    call.ReturnType)
                : new BoundConstrainedStaticCallExpression(
                    call.Syntax,
                    call.TypeParameter,
                    call.ClrMethod!,
                    args.ToImmutable(),
                    call.ArgumentRefKinds,
                    call.ReturnType,
                    call.ConstrainedInterfaceType!);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillImportedCall(BoundImportedCallExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundImportedCallExpression(
                null,
                call.Function,
                args.ToImmutable(),
                call.ArgumentRefKinds,
                call.TypeArgumentSymbols,
                call.StaticContainerType);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        /// <summary>
        /// Shared receiver+argument spilling used by every instance-call
        /// spill (<see cref="SpillImportedInstanceCall"/>, <see cref="SpillUserInstanceCall"/>,
        /// <see cref="SpillBaseInterfaceCall"/>, <see cref="SpillBaseClassCall"/>):
        /// spill the receiver if it (or any argument) contains an await, then
        /// spill the argument list itself.
        /// </summary>
        private (ImmutableArray<LocalVariableSymbol> Locals, ImmutableArray<BoundStatement> SideEffects, BoundExpression Receiver, ImmutableArray<BoundExpression> Args) SpillReceiverAndArguments(
            BoundExpression receiver, ImmutableArray<BoundExpression> arguments)
        {
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            // Spill the receiver if args contain an await.
            var argsHaveAwait = false;
            foreach (var arg in arguments)
            {
                if (HasAwait(arg))
                {
                    argsHaveAwait = true;
                    break;
                }
            }

            if (HasAwait(receiver))
            {
                var spilledReceiver = SpillExpression(receiver);
                locals.AddRange(spilledReceiver.Locals);
                sideEffects.AddRange(spilledReceiver.SideEffects);
                receiver = spilledReceiver.Value;
            }

            if (argsHaveAwait && !CanDeferAcrossLift(receiver))
            {
                var recvTemp = MakeSpillTemp(receiver.Type);
                locals.Add(recvTemp);
                sideEffects.Add(new BoundVariableDeclaration(null, recvTemp, receiver));
                receiver = new BoundVariableExpression(null, recvTemp);
            }

            var (argLocals, argSideEffects, args) = SpillArgumentList(arguments);
            locals.AddRange(argLocals);
            sideEffects.AddRange(argSideEffects);

            return (locals.ToImmutable(), sideEffects.ToImmutable(), receiver, args.ToImmutable());
        }

        private BoundSpillSequenceExpression SpillImportedInstanceCall(BoundImportedInstanceCallExpression call)
        {
            var (locals, sideEffects, receiver, args) = SpillReceiverAndArguments(call.Receiver, call.Arguments);
            if (locals.IsEmpty && sideEffects.IsEmpty)
            {
                return Trivial(call);
            }

            var value = new BoundImportedInstanceCallExpression(
                null,
                receiver,
                call.Method,
                call.Type,
                args,
                call.ArgumentRefKinds,
                call.TypeArgumentSymbols,
                call.ConstrainedReceiverTypeParameter,
                call.ConstrainedInterfaceType,
                call.IsNonVirtualBaseCall);
            return new BoundSpillSequenceExpression(null, locals, sideEffects, value);
        }

        private BoundSpillSequenceExpression SpillUserInstanceCall(BoundUserInstanceCallExpression call)
        {
            var (locals, sideEffects, receiver, args) = SpillReceiverAndArguments(call.Receiver, call.Arguments);
            if (locals.IsEmpty && sideEffects.IsEmpty)
            {
                return Trivial(call);
            }

            var value = new BoundUserInstanceCallExpression(
                null,
                receiver,
                call.Method,
                args,
                call.Type,
                call.ConstrainedReceiverTypeParameter,
                call.ConstrainedInterfaceType)
            {
                MethodTypeArguments = call.MethodTypeArguments,
            };
            return new BoundSpillSequenceExpression(null, locals, sideEffects, value);
        }

        private BoundSpillSequenceExpression SpillBaseInterfaceCall(BoundBaseInterfaceCallExpression call)
        {
            var (locals, sideEffects, receiver, args) = SpillReceiverAndArguments(call.Receiver, call.Arguments);
            if (locals.IsEmpty && sideEffects.IsEmpty)
            {
                return Trivial(call);
            }

            var value = new BoundBaseInterfaceCallExpression(null, receiver, call.Interface, call.Method, args);
            return new BoundSpillSequenceExpression(null, locals, sideEffects, value);
        }

        private BoundSpillSequenceExpression SpillBaseClassCall(BoundBaseClassCallExpression call)
        {
            var (locals, sideEffects, receiver, args) = SpillReceiverAndArguments(call.Receiver, call.Arguments);
            if (locals.IsEmpty && sideEffects.IsEmpty)
            {
                return Trivial(call);
            }

            var value = new BoundBaseClassCallExpression(null, receiver, call.BaseClass, call.Method, args, call.Type, call.Property, call.IsSetterAccessor);
            return new BoundSpillSequenceExpression(null, locals, sideEffects, value);
        }

        private BoundSpillSequenceExpression SpillConversion(BoundConversionExpression conv)
        {
            if (!HasAwait(conv.Expression))
            {
                return Trivial(conv);
            }

            var spilled = SpillExpression(conv.Expression);
            var value = new BoundConversionExpression(null, conv.Type, spilled.Value);
            return new BoundSpillSequenceExpression(
                null,
                spilled.Locals,
                spilled.SideEffects,
                value);
        }

        private BoundSpillSequenceExpression SpillAssignment(BoundAssignmentExpression assign)
        {
            if (!HasAwait(assign.Expression))
            {
                return Trivial(assign);
            }

            var spilled = SpillExpression(assign.Expression);
            var value = new BoundAssignmentExpression(null, assign.Variable, spilled.Value);
            return new BoundSpillSequenceExpression(
                null,
                spilled.Locals,
                spilled.SideEffects,
                value);
        }

        private BoundSpillSequenceExpression SpillFieldAssignment(BoundFieldAssignmentExpression assign)
        {
            // Receiver is a VariableSymbol — already a stable local read, no spilling needed.
            // Only the RHS Value can contain an await.
            if (!HasAwait(assign.Value))
            {
                return Trivial(assign);
            }

            var spilled = SpillExpression(assign.Value);

            // Issue #3333 / #1644: an interface static field write has a null
            // Receiver and StructType, and carries the owning interface in
            // InterfaceType. Rebuilding it through the variable-receiver
            // constructor drops that, and the emitter parents the field at the
            // open-generic TypeDef instead of a TypeSpec.
            var value = assign.InterfaceType != null
                ? new BoundFieldAssignmentExpression(
                    null,
                    assign.Field,
                    assign.InterfaceType,
                    spilled.Value,
                    assign.ResultType)
                : new BoundFieldAssignmentExpression(
                    null,
                    assign.Receiver,
                    BoundNodeForm.DeclaringType(assign),
                    assign.Field,
                    spilled.Value,
                    assign.ResultType);
            return new BoundSpillSequenceExpression(
                null,
                spilled.Locals,
                spilled.SideEffects,
                value);
        }

        private BoundSpillSequenceExpression SpillIndexAssignment(BoundIndexAssignmentExpression assign)
        {
            var combined = ImmutableArray.CreateBuilder<BoundExpression>(assign.Indices.Length + 2);
            var targetExpression = assign.TargetExpression
                ?? new BoundVariableExpression(null, BoundNodeForm.VariableTarget(assign));
            combined.Add(targetExpression);
            combined.AddRange(assign.Indices);
            combined.Add(assign.Value);
            var (locals, sideEffects, spilled) = SpillArgumentList(
                combined.MoveToImmutable(),
                spillEveryPreAwaitOperand: IsRectangularArrayType(targetExpression.Type));
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(assign);
            }

            var target = spilled[0];
            var offset = 1;

            var indices = ImmutableArray.CreateBuilder<BoundExpression>(assign.Indices.Length);
            for (var i = 0; i < assign.Indices.Length; i++)
            {
                indices.Add(spilled[offset++]);
            }

            var rhs = spilled[offset];
            var value = BoundIndexAssignmentExpression.WithExpressionTarget(
                null,
                target,
                indices.MoveToImmutable(),
                rhs,
                assign.Type);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillUnary(BoundUnaryExpression unary)
        {
            if (!HasAwait(unary.Operand))
            {
                return Trivial(unary);
            }

            var spilled = SpillExpression(unary.Operand);
            var value = new BoundUnaryExpression(null, unary.Op, spilled.Value);
            return new BoundSpillSequenceExpression(
                null,
                spilled.Locals,
                spilled.SideEffects,
                value);
        }

        /// <summary>
        /// Spills a ternary/conditional expression (issue #1619). Unlike a
        /// plain binary expression, only one of <c>WhenTrue</c>/<c>WhenFalse</c>
        /// executes at runtime, so an await in an arm must not run
        /// unconditionally. This mirrors the if/else-with-goto expansion used
        /// by <see cref="SpillLogicalAnd"/>/<see cref="SpillLogicalOr"/>: the
        /// condition (if it itself has an await) is spilled unconditionally
        /// first, then each arm's side effects are guarded behind a label so
        /// only the taken arm's await(s) actually run.
        /// </summary>
        private BoundSpillSequenceExpression SpillConditional(BoundConditionalExpression conditional)
        {
            var conditionHasAwait = HasAwait(conditional.Condition);
            var trueHasAwait = HasAwait(conditional.WhenTrue);
            var falseHasAwait = HasAwait(conditional.WhenFalse);

            if (!conditionHasAwait && !trueHasAwait && !falseHasAwait)
            {
                return Trivial(conditional);
            }

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression condition = conditional.Condition;
            if (conditionHasAwait)
            {
                var spilledCondition = SpillExpression(conditional.Condition);
                locals.AddRange(spilledCondition.Locals);
                sideEffects.AddRange(spilledCondition.SideEffects);
                condition = spilledCondition.Value;
            }

            // Null exactly when the conditional is void: testing resultLocal
            // rather than a separate bool is what lets the analyzer see the
            // local is present wherever it is assigned or read.
            var resultLocal = conditional.Type == TypeSymbol.Void ? null : MakeSpillTemp(conditional.Type);
            var elseLabel = MakeLabel();
            var endLabel = MakeLabel();

            // if (!condition) goto else
            sideEffects.Add(new BoundConditionalGotoStatement(null, elseLabel, condition, jumpIfTrue: false));

            // then: result = whenTrue (spilled — only runs if condition was true)
            var spilledTrue = SpillExpression(conditional.WhenTrue);
            locals.AddRange(spilledTrue.Locals);
            sideEffects.AddRange(spilledTrue.SideEffects);
            if (resultLocal != null)
            {
                sideEffects.Add(new BoundExpressionStatement(
                    null,
                    new BoundAssignmentExpression(null, resultLocal, spilledTrue.Value)));
            }
            else if (spilledTrue.Value is not BoundLiteralExpression)
            {
                sideEffects.Add(new BoundExpressionStatement(null, spilledTrue.Value));
            }

            sideEffects.Add(new BoundGotoStatement(null, endLabel));

            // else: result = whenFalse (spilled — only runs if condition was false)
            sideEffects.Add(new BoundLabelStatement(null, elseLabel));
            var spilledFalse = SpillExpression(conditional.WhenFalse);
            locals.AddRange(spilledFalse.Locals);
            sideEffects.AddRange(spilledFalse.SideEffects);
            if (resultLocal != null)
            {
                sideEffects.Add(new BoundExpressionStatement(
                    null,
                    new BoundAssignmentExpression(null, resultLocal, spilledFalse.Value)));
            }
            else if (spilledFalse.Value is not BoundLiteralExpression)
            {
                sideEffects.Add(new BoundExpressionStatement(null, spilledFalse.Value));
            }

            // end:
            sideEffects.Add(new BoundLabelStatement(null, endLabel));

            if (resultLocal == null)
            {
                return new BoundSpillSequenceExpression(
                    null,
                    locals.ToImmutable(),
                    sideEffects.ToImmutable(),
                    new BoundLiteralExpression(null, 0, TypeSymbol.Void));
            }

            locals.Add(resultLocal);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, resultLocal));
        }

        /// <summary>
        /// Spills a switch expression (issue #1619 completion). A guard
        /// (<c>when</c> clause) containing <c>await</c> stays diagnostic-gated:
        /// a false guard must fall through to the next arm's pattern test, and
        /// replicating that retry as bound-tree control flow would mean
        /// re-implementing the whole pattern-matching decision tree
        /// (<see cref="Emit.MethodBodyEmitter.EmitPattern"/> and friends) instead
        /// of reusing it — a duplication this pass avoids for every other kind.
        /// The discriminant and each arm's result value, however, are fully
        /// spillable: this method reuses the existing (unmodified) pattern-match
        /// dispatch to select which arm matched — by building a second,
        /// award-free "index" switch whose arms carry the same
        /// patterns/guards but return the arm's ordinal instead of its real
        /// result — and only then evaluates the *selected* arm's (possibly
        /// awaiting) result, via an if/else-if chain on the stored index. Any
        /// locals a pattern binds (e.g. <c>case Point(var x, var y)</c>) are
        /// still assigned by the (unmodified, reused) pattern test itself, so
        /// they remain visible to the result-evaluation chain.
        /// </summary>
        private BoundSpillSequenceExpression SpillSwitch(BoundSwitchExpression switchExpr)
        {
            var discriminantHasAwait = HasAwait(switchExpr.Discriminant);
            var anyGuardHasAwait = false;
            var anyResultHasAwait = false;
            var rewrittenArms = ImmutableArray.CreateBuilder<BoundSwitchExpressionArm>(switchExpr.Arms.Length);
            foreach (var arm in switchExpr.Arms)
            {
                var guard = arm.Guard;
                if (guard != null && HasAwait(guard))
                {
                    anyGuardHasAwait = true;
                    guard = SpillSwitchGuard(guard, "switch-expression");
                }

                if (HasAwait(arm.Result))
                {
                    anyResultHasAwait = true;
                }

                rewrittenArms.Add(new BoundSwitchExpressionArm(arm.Syntax, arm.Pattern, guard, arm.Result));
            }

            if (!discriminantHasAwait && !anyGuardHasAwait && !anyResultHasAwait)
            {
                return Trivial(switchExpr);
            }

            var arms = rewrittenArms.MoveToImmutable();

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            var discriminant = switchExpr.Discriminant;
            if (discriminantHasAwait)
            {
                var spilledDiscriminant = SpillExpression(switchExpr.Discriminant);
                locals.AddRange(spilledDiscriminant.Locals);
                sideEffects.AddRange(spilledDiscriminant.SideEffects);
                discriminant = spilledDiscriminant.Value;
            }

            if (!anyResultHasAwait)
            {
                // Only the discriminant needed spilling — no arm result has an
                // await, so the existing opaque pattern-dispatch emission can
                // still own arm selection and result evaluation unmodified.
                var rebuiltSwitch = new BoundSwitchExpression(null, discriminant, arms, switchExpr.Type);
                return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), rebuiltSwitch);
            }

            // Phase 1: reuse the unmodified pattern/guard machinery to select
            // which arm matched, via a synthetic switch expression whose arms
            // return their own ordinal (an await-free int) instead of the real
            // (possibly awaiting) result.
            var indexArms = ImmutableArray.CreateBuilder<BoundSwitchExpressionArm>(arms.Length);
            for (var i = 0; i < arms.Length; i++)
            {
                var arm = arms[i];
                indexArms.Add(new BoundSwitchExpressionArm(null, arm.Pattern, arm.Guard, new BoundLiteralExpression(null, i)));
            }

            var indexSwitch = new BoundSwitchExpression(null, discriminant, indexArms.ToImmutable(), TypeSymbol.Int32);
            var armIndexLocal = MakeSpillTemp(TypeSymbol.Int32);
            locals.Add(armIndexLocal);
            sideEffects.Add(new BoundVariableDeclaration(null, armIndexLocal, indexSwitch));

            // Phase 2: dispatch on the stored arm index, evaluating only the
            // selected arm's (possibly awaiting) result.
            var resultLocal = MakeSpillTemp(switchExpr.Type);
            var endLabel = MakeLabel();
            var eqOperator = Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 equality operator exists for spill dispatch");
            var firstArmResultDeclared = false;

            for (var i = 0; i < arms.Length; i++)
            {
                var arm = arms[i];
                var nextArmLabel = MakeLabel();

                var isSelected = new BoundBinaryExpression(
                    null,
                    new BoundVariableExpression(null, armIndexLocal),
                    eqOperator,
                    new BoundLiteralExpression(null, i));
                sideEffects.Add(new BoundConditionalGotoStatement(null, nextArmLabel, isSelected, jumpIfTrue: false));

                var spilledResult = SpillExpression(arm.Result);
                locals.AddRange(spilledResult.Locals);
                sideEffects.AddRange(spilledResult.SideEffects);

                if (!firstArmResultDeclared)
                {
                    // Declare resultLocal where the selected arm first assigns
                    // it, avoiding a redundant default initialization.
                    sideEffects.Add(new BoundVariableDeclaration(null, resultLocal, spilledResult.Value));
                    firstArmResultDeclared = true;
                }
                else
                {
                    sideEffects.Add(new BoundExpressionStatement(
                        null,
                        new BoundAssignmentExpression(null, resultLocal, spilledResult.Value)));
                }

                sideEffects.Add(new BoundGotoStatement(null, endLabel));
                sideEffects.Add(new BoundLabelStatement(null, nextArmLabel));
            }

            sideEffects.Add(new BoundLabelStatement(null, endLabel));

            locals.Add(resultLocal);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, resultLocal));
        }

        /// <summary>
        /// Spills a null-conditional access (<c>?.</c>) expression (issue #1619
        /// completion). Mirrors <see cref="SpillConditional"/>: the receiver is
        /// always evaluated (spilled unconditionally if it has an await), but
        /// <see cref="BoundNullConditionalAccessExpression.WhenNotNull"/> — and
        /// any await inside it — must only run on the non-nil path, so that
        /// path is expanded into explicit if/else statements instead of
        /// letting the opaque single-expression emission
        /// (<c>EmitNullConditionalAccess</c>) own it. The not-null branch
        /// reuses the general-purpose conversion emitter (rather than
        /// duplicating <c>EmitNullConditionalAccess</c>'s bespoke
        /// Nullable-wrap IL) to lift a value-typed result into
        /// <see cref="BoundNullConditionalAccessExpression.Type"/> when needed.
        /// </summary>
        private BoundSpillSequenceExpression SpillNullConditionalAccess(BoundNullConditionalAccessExpression nc)
        {
            // Issue #1700: a value-type `Nullable<T>` receiver (BCL, user
            // struct/enum) needs the statement-based (declare + goto/label)
            // rebuild below UNCONDITIONALLY — even when neither the receiver
            // nor WhenNotNull contains an await. `nc.Capture` is declared as
            // the unwrapped `T` (so member-access binding resolves against
            // `T`), so it can never directly hold the real `Nullable<T>`
            // receiver value. The shared variable emitter routes hoisted
            // captures to state-machine fields (issue #2771), but it cannot
            // reconcile this wrapper/unwrapped type mismatch.
            var isValueTypeNullableReceiver = nc.Receiver.Type is NullableTypeSymbol ncReceiverNullable
                && NullableLifting.IsAnyValueTypeNullable(ncReceiverNullable);

            var receiverHasAwait = HasAwait(nc.Receiver);
            var whenNotNullHasAwait = HasAwait(nc.WhenNotNull);

            if (!isValueTypeNullableReceiver && !receiverHasAwait && !whenNotNullHasAwait)
            {
                return Trivial(nc);
            }

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            var receiver = nc.Receiver;
            if (receiverHasAwait)
            {
                var spilledReceiver = SpillExpression(nc.Receiver);
                locals.AddRange(spilledReceiver.Locals);
                sideEffects.AddRange(spilledReceiver.SideEffects);
                receiver = spilledReceiver.Value;
            }

            if (!isValueTypeNullableReceiver && !whenNotNullHasAwait)
            {
                // Reference-type (or non-nullable-collapse) receiver, only
                // the receiver needed spilling — WhenNotNull is still
                // await-free. The emitter's shared variable load/store path
                // preserves nc.Capture whether it remains local or is hoisted.
                var rebuiltNc = new BoundNullConditionalAccessExpression(null, receiver, nc.Capture, nc.WhenNotNull, nc.Type, nc.ResultSlot);
                return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), rebuiltNc);
            }

            // Either WhenNotNull has an await (must run only on the non-nil
            // path, needing explicit if/else control flow) or the receiver
            // is a value-type Nullable<T> (needing the wrapper-local +
            // guard + `!!` unwrap shape regardless of await). Since this
            // path replaces the BoundNullConditionalAccessExpression node
            // entirely, nc.Capture is no longer discoverable by the
            // emitter's CollectNullConditionalCaptures walk (which only
            // finds the local through a surviving node of that kind) — it
            // must be registered as a spill local explicitly here or its
            // slot never gets planned.
            //
            // Issue #1700: a value-type `Nullable<T>` receiver cannot reuse
            // `nc.Capture` (declared as unwrapped `T`) to hold the raw
            // receiver, nor can a `T`-typed variable read be branched on
            // directly (both are the same StackUnexpected mismatch as the
            // reference-type Leg-1 case above). Route it through its own
            // `Nullable<T>`-typed wrapper local instead: declare
            // `wrapper := receiver`, guard on `wrapper` (its Nullable<T>
            // type makes EmitConditionalGotoProbe take the box-probe path),
            // then unwrap `wrapper` into `nc.Capture` via `!!`
            // (NullAssertion) only once the guard confirms HasValue — `!!`'s
            // emit path already has full, pre-existing support for user
            // struct/enum and BCL value-type Nullable<T> operands
            // (NullableValueTypeUnwrapCollector auto-slots any such node it
            // finds in the tree), so no new emitter plumbing is needed here.
            LocalVariableSymbol? wrapperLocal = null;
            BoundExpression guardCondition;
            if (isValueTypeNullableReceiver)
            {
                wrapperLocal = MakeSpillTemp(receiver.Type);
                locals.Add(wrapperLocal);
                sideEffects.Add(new BoundVariableDeclaration(null, wrapperLocal, receiver));

                locals.Add((LocalVariableSymbol)nc.Capture);
                sideEffects.Add(new BoundVariableDeclaration(null, (LocalVariableSymbol)nc.Capture, new BoundDefaultExpression(null, nc.Capture.Type)));
                guardCondition = new BoundVariableExpression(null, wrapperLocal);
            }
            else
            {
                // Declare the capture with the real receiver value so the
                // following null guard observes that value directly.
                locals.Add((LocalVariableSymbol)nc.Capture);
                sideEffects.Add(new BoundVariableDeclaration(null, (LocalVariableSymbol)nc.Capture, receiver));
                guardCondition = new BoundVariableExpression(null, nc.Capture);
            }

            // Null exactly when the chain is void -- see SpillConditional.
            var resultLocal = ReferenceEquals(nc.Type, TypeSymbol.Void) ? null : MakeSpillTemp(nc.Type);

            var nonNullLabel = MakeLabel();
            var endLabel = MakeLabel();

            // if (capture/wrapper) goto nonNull   (brtrue — reference/Nullable non-nil check)
            sideEffects.Add(new BoundConditionalGotoStatement(null, nonNullLabel, guardCondition, jumpIfTrue: true));

            // nil branch
            if (resultLocal != null)
            {
                sideEffects.Add(new BoundVariableDeclaration(null, resultLocal, new BoundDefaultExpression(null, nc.Type)));
            }

            sideEffects.Add(new BoundGotoStatement(null, endLabel));

            // non-null branch
            sideEffects.Add(new BoundLabelStatement(null, nonNullLabel));

            if (wrapperLocal != null)
            {
                var unwrapOp = Invariant.Required(
                    BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, wrapperLocal.Type),
                    "the wrapper local is a nullable value type, for which the operator table always binds `!!`");
                var unwrap = new BoundUnaryExpression(null, unwrapOp, new BoundVariableExpression(null, wrapperLocal));
                sideEffects.Add(new BoundExpressionStatement(null, new BoundAssignmentExpression(null, nc.Capture, unwrap)));
            }

            var spilledWhenNotNull = SpillExpression(nc.WhenNotNull);
            locals.AddRange(spilledWhenNotNull.Locals);
            sideEffects.AddRange(spilledWhenNotNull.SideEffects);

            if (resultLocal == null)
            {
                sideEffects.Add(new BoundExpressionStatement(null, spilledWhenNotNull.Value));
            }
            else
            {
                var value = spilledWhenNotNull.Value;

                // ResultSlot != null marks a value-typed access result whose
                // WhenNotNull sub-tree pushes the raw underlying value, which
                // must be lifted into the Nullable<T>/nc.Type shape — unless
                // it's already a Nullable<T> itself (ADR-0073 chained `?.`).
                if (nc.ResultSlot != null && value.Type is not NullableTypeSymbol)
                {
                    value = new BoundConversionExpression(null, nc.Type, value);
                }

                sideEffects.Add(new BoundExpressionStatement(null, new BoundAssignmentExpression(null, resultLocal, value)));
            }

            sideEffects.Add(new BoundLabelStatement(null, endLabel));

            if (resultLocal != null)
            {
                locals.Add(resultLocal);
            }

            var resultValue = resultLocal == null
                ? (BoundExpression)new BoundLiteralExpression(null, null, TypeSymbol.Void)
                : new BoundVariableExpression(null, resultLocal);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                resultValue);
        }

        /// <summary>
        /// Spills a conditional address-of expression (ADR-0061; issue #1619
        /// completion). Unlike <see cref="SpillConditional"/>'s ternary case,
        /// the *result* here is a managed pointer (<c>T&amp;</c>), which
        /// cannot be carried across the if/else join in a plain spill temp:
        /// <see cref="RefInitializationHoister"/> — the pass that runs
        /// immediately after this one — eliminates every <c>T&amp;</c>-typed
        /// local by re-deriving its address from a *single* declaration-site
        /// template at every use site, since state-machine field hoisting
        /// can never hold a managed pointer. A local reassigned differently
        /// in each branch (one address in the "then" arm, a different one in
        /// the "else" arm) breaks that single-template assumption — the
        /// hoister only tracks the last template it walks over lexically,
        /// so it would silently rewrite every read to whichever branch's
        /// address expression appears last in the statement list, regardless
        /// of which branch actually ran (this was caught by
        /// <c>Await_In_Conditional_Address_Condition_Selects_Correct_RefBranch</c>
        /// failing with the wrong branch's value).
        /// <para>
        /// The fix: never store the address itself across the join. Only the
        /// (plain-typed, non-byref) sub-expressions that an await could be
        /// nested inside — e.g. an indexer's index, a field access's receiver
        /// — are spilled, and only inside a guard that runs solely when that
        /// operand is the one selected (so its await never fires on the
        /// unchosen branch). The two (possibly-rebuilt) lvalue trees are then
        /// fed back into a fresh <see cref="BoundConditionalAddressExpression"/>
        /// so the existing, unmodified <c>EmitConditionalAddress</c> emitter
        /// still performs the actual branch-and-take-address IL — it just
        /// re-evaluates the (already spilled, side-effect-free) condition a
        /// second time and reads whichever branch's temps were populated.
        /// </para>
        /// </summary>
        private BoundSpillSequenceExpression SpillConditionalAddress(BoundConditionalAddressExpression condAddr)
        {
            var conditionHasAwait = HasAwait(condAddr.Condition);
            var trueHasAwait = HasAwait(condAddr.WhenTrueOperand);
            var falseHasAwait = HasAwait(condAddr.WhenFalseOperand);

            if (!conditionHasAwait && !trueHasAwait && !falseHasAwait)
            {
                return Trivial(condAddr);
            }

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            // If the condition contains an await, spill it exactly once, up
            // front, so the guards/rebuild below reference the resulting
            // value rather than re-running the await.
            var condition = condAddr.Condition;
            if (conditionHasAwait)
            {
                var spilledCondition = SpillExpression(condAddr.Condition);
                locals.AddRange(spilledCondition.Locals);
                sideEffects.AddRange(spilledCondition.SideEffects);
                condition = spilledCondition.Value;
            }

            // The condition is read up to three times below: the "then"
            // guard, the "else" guard, and the rebuilt
            // BoundConditionalAddressExpression that EmitConditionalAddress
            // re-evaluates. If it isn't already side-effect-free, materialize
            // it into a spill temp exactly once here so a side effect in the
            // condition (e.g. a method call) can't fire more than once.
            if (!CanDeferAcrossLift(condition))
            {
                var condTemp = MakeSpillTemp(condition.Type);
                locals.Add(condTemp);
                sideEffects.Add(new BoundVariableDeclaration(null, condTemp, condition));
                condition = new BoundVariableExpression(null, condTemp);
            }

            var trueOperand = condAddr.WhenTrueOperand;
            if (trueHasAwait)
            {
                // Guard: only spill (and evaluate any nested await) when this
                // branch is the one that will actually be selected.
                var skipTrueLabel = MakeLabel();
                sideEffects.Add(new BoundConditionalGotoStatement(null, skipTrueLabel, condition, jumpIfTrue: false));

                var spilledTrue = SpillExpression(condAddr.WhenTrueOperand);
                locals.AddRange(spilledTrue.Locals);
                sideEffects.AddRange(spilledTrue.SideEffects);
                trueOperand = spilledTrue.Value;

                sideEffects.Add(new BoundLabelStatement(null, skipTrueLabel));
            }

            var falseOperand = condAddr.WhenFalseOperand;
            if (falseHasAwait)
            {
                var skipFalseLabel = MakeLabel();
                sideEffects.Add(new BoundConditionalGotoStatement(null, skipFalseLabel, condition, jumpIfTrue: true));

                var spilledFalse = SpillExpression(condAddr.WhenFalseOperand);
                locals.AddRange(spilledFalse.Locals);
                sideEffects.AddRange(spilledFalse.SideEffects);
                falseOperand = spilledFalse.Value;

                sideEffects.Add(new BoundLabelStatement(null, skipFalseLabel));
            }

            // Rebuild the original node kind so the existing (unmodified)
            // EmitConditionalAddress emitter still owns the actual
            // branch-and-take-address IL — it never sees a byref local.
            var value = new BoundConditionalAddressExpression(null, condition, trueOperand, falseOperand, condAddr.PointeeType);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillIndex(BoundIndexExpression index)
        {
            var combined = ImmutableArray.CreateBuilder<BoundExpression>(index.Indices.Length + 1);
            combined.Add(index.Target);
            combined.AddRange(index.Indices);
            var (locals, sideEffects, spilled) = SpillArgumentList(
                combined.MoveToImmutable(),
                spillEveryPreAwaitOperand: IsRectangularArrayType(index.Target.Type));
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(index);
            }

            var indices = ImmutableArray.CreateBuilder<BoundExpression>(index.Indices.Length);
            for (var i = 1; i < spilled.Count; i++)
            {
                indices.Add(spilled[i]);
            }

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundIndexExpression(null, spilled[0], indices.MoveToImmutable(), index.Type));
        }

        private BoundSpillSequenceExpression SpillClrStaticCall(BoundClrStaticCallExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundClrStaticCallExpression(null, call.Method, call.Type, args.ToImmutable(), call.ArgumentRefKinds);
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillClrConstructorCall(BoundClrConstructorCallExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundClrConstructorCallExpression(call.Syntax, call.ClrType, call.Constructor, args.ToImmutable(), call.Type, call.ArgumentRefKinds);
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillConstructorCall(BoundConstructorCallExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundConstructorCallExpression(call.Syntax, call.StructType, args.ToImmutable(), call.SelectedConstructor);
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillConstructorChaining(BoundConstructorChainingExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundConstructorChainingExpression(call.Syntax, call.SelectedConstructor, args.ToImmutable());
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        /// <summary>
        /// Spills a target/pointer expression together with a following
        /// argument list, preserving the rule that the target is evaluated
        /// before any argument (issue #1619). Used for indirect calls,
        /// function-pointer invocations, and CLR indexers.
        /// </summary>
        private BoundSpillSequenceExpression SpillTargetAndArguments(
            BoundExpression original,
            BoundExpression target,
            ImmutableArray<BoundExpression> arguments,
            Func<BoundExpression, ImmutableArray<BoundExpression>, BoundExpression> rebuild)
        {
            var combined = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length + 1);
            combined.Add(target);
            combined.AddRange(arguments);

            var (locals, sideEffects, spilledCombined) = SpillArgumentList(combined.ToImmutable());
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(original);
            }

            var spilledTarget = spilledCombined[0];
            var spilledArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
            for (var i = 1; i < spilledCombined.Count; i++)
            {
                spilledArgs.Add(spilledCombined[i]);
            }

            var value = rebuild(spilledTarget, spilledArgs.ToImmutable());
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillIndirectCall(BoundIndirectCallExpression call)
        {
            return SpillTargetAndArguments(
                call,
                call.Target,
                call.Arguments,
                (target, arguments) => new BoundIndirectCallExpression(
                    null,
                    target,
                    call.FunctionType,
                    arguments,
                    call.ArgumentRefKinds));
        }

        private BoundSpillSequenceExpression SpillFunctionPointerInvocation(BoundFunctionPointerInvocationExpression call)
        {
            return SpillTargetAndArguments(
                call,
                call.Pointer,
                call.Arguments,
                (pointer, arguments) => new BoundFunctionPointerInvocationExpression(
                    null,
                    pointer,
                    arguments,
                    call.FunctionPointerType));
        }

        private BoundSpillSequenceExpression SpillClrIndex(BoundClrIndexExpression index)
        {
            return SpillTargetAndArguments(
                index,
                index.Target,
                index.Arguments,
                (target, arguments) => new BoundClrIndexExpression(
                    null,
                    target,
                    index.Indexer,
                    arguments,
                    index.Type));
        }

        private BoundSpillSequenceExpression SpillClrIndexAssignment(BoundClrIndexAssignmentExpression assign)
        {
            // Target is a stable VariableSymbol (not a BoundExpression) — only
            // the indexer arguments and the assigned value can hold an await.
            var combined = ImmutableArray.CreateBuilder<BoundExpression>(assign.Arguments.Length + 1);
            combined.AddRange(assign.Arguments);
            combined.Add(assign.Value);

            var (locals, sideEffects, spilled) = SpillArgumentList(combined.ToImmutable());
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(assign);
            }

            var spilledArgs = ImmutableArray.CreateBuilder<BoundExpression>(assign.Arguments.Length);
            for (var i = 0; i < assign.Arguments.Length; i++)
            {
                spilledArgs.Add(spilled[i]);
            }

            var spilledValue = spilled[assign.Arguments.Length];
            var value = assign.TargetExpression != null
                ? BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    assign.TargetExpression,
                    assign.Indexer,
                    spilledArgs.ToImmutable(),
                    spilledValue,
                    assign.Type,
                    assign.ConstrainedReceiverTypeParameter,
                    assign.ConstrainedInterfaceType)
                : new BoundClrIndexAssignmentExpression(
                    null,
                    BoundNodeForm.VariableTarget(assign),
                    assign.Indexer,
                    spilledArgs.ToImmutable(),
                    spilledValue,
                    assign.Type,
                    assign.ConstrainedReceiverTypeParameter,
                    assign.ConstrainedInterfaceType);
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillClrPropertyAccess(BoundClrPropertyAccessExpression access)
        {
            // Receiver is null for a static member access — nothing to spill.
            if (access.Receiver == null)
            {
                return Trivial(access);
            }

            return SpillOneOperand(
                access,
                access.Receiver,
                recv => new BoundClrPropertyAccessExpression(null, recv, access.Member, access.Type, access.StaticContainerType));
        }

        private BoundSpillSequenceExpression SpillFieldAccess(BoundFieldAccessExpression fieldAccess)
        {
            // Receiver is null for an interface-static field read — nothing to spill.
            if (fieldAccess.Receiver == null)
            {
                return Trivial(fieldAccess);
            }

            return SpillOneOperand(
                fieldAccess,
                fieldAccess.Receiver,
                recv => new BoundFieldAccessExpression(
                    null,
                    recv,
                    BoundNodeForm.DeclaringType(fieldAccess),
                    fieldAccess.Field,
                    fieldAccess.SubstitutedType,
                    fieldAccess.NarrowedType));
        }

        private BoundSpillSequenceExpression SpillTupleLiteral(BoundTupleLiteralExpression tupleLiteral)
        {
            var (locals, sideEffects, elements) = SpillArgumentList(tupleLiteral.Elements);
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(tupleLiteral);
            }

            var value = new BoundTupleLiteralExpression(null, tupleLiteral.TupleType, elements.ToImmutable());
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        /// <summary>
        /// Spills an interpolated string's holes. By this point in the
        /// pipeline most interpolated strings have already been lowered to
        /// the handler pattern (a <see cref="BoundBlockExpression"/>, handled
        /// by <see cref="SpillBlockExpression"/>); this path only fires for
        /// interpolated strings that reach the spiller in their raw
        /// part-list form (issue #1619).
        /// </summary>
        private BoundSpillSequenceExpression SpillInterpolatedString(BoundInterpolatedStringExpression interpolated)
        {
            var holeIndices = new List<int>();
            var holeValues = ImmutableArray.CreateBuilder<BoundExpression>();
            for (var i = 0; i < interpolated.Parts.Length; i++)
            {
                var part = interpolated.Parts[i];
                if (part.IsHole)
                {
                    holeIndices.Add(i);
                    holeValues.Add(part.Value);
                }
            }

            var (locals, sideEffects, spilledHoles) = SpillArgumentList(holeValues.ToImmutable());
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(interpolated);
            }

            var parts = ImmutableArray.CreateBuilder<BoundInterpolatedStringPart>(interpolated.Parts.Length);
            parts.AddRange(interpolated.Parts);
            for (var i = 0; i < holeIndices.Count; i++)
            {
                var partIndex = holeIndices[i];
                parts[partIndex] = parts[partIndex].WithValue(spilledHoles[i]);
            }

            var value = new BoundInterpolatedStringExpression(null, parts.ToImmutable(), interpolated.Handler);
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillArrayCreation(BoundArrayCreationExpression arrayCreation)
        {
            if (arrayCreation.DimensionExpressions.Length > 1
                && arrayCreation.ContainerType is RectangularArrayTypeSymbol rectangular)
            {
                if (!arrayCreation.Elements.IsDefaultOrEmpty
                    && arrayCreation.RectangularLengths.Length == rectangular.Rank)
                {
                    var (initializerLocals, initializerSideEffects, spilledDimensions) = SpillArgumentList(
                        arrayCreation.DimensionExpressions,
                        spillEveryPreAwaitOperand: true);
                    var arrayTemp = MakeSpillTemp(rectangular);
                    initializerLocals.Add(arrayTemp);
                    initializerSideEffects.Add(
                        new BoundVariableDeclaration(
                            null,
                            arrayTemp,
                            BoundArrayCreationExpression.CreateRectangular(
                                null,
                                rectangular,
                                spilledDimensions.MoveToImmutable())));
                    var arrayReference = new BoundVariableExpression(null, arrayTemp);

                    for (var flatIndex = 0; flatIndex < arrayCreation.Elements.Length; flatIndex++)
                    {
                        var element = arrayCreation.Elements[flatIndex];
                        if (HasAwait(element))
                        {
                            var spilledElement = SpillExpression(element);
                            initializerLocals.AddRange(spilledElement.Locals);
                            initializerSideEffects.AddRange(spilledElement.SideEffects);
                            element = spilledElement.Value;
                        }

                        var indices = ImmutableArray.CreateBuilder<BoundExpression>(rectangular.Rank);
                        var remainder = flatIndex;
                        for (var dimension = 0; dimension < rectangular.Rank; dimension++)
                        {
                            var stride = 1;
                            for (var trailing = dimension + 1; trailing < rectangular.Rank; trailing++)
                            {
                                stride *= arrayCreation.RectangularLengths[trailing];
                            }

                            var index = stride == 0 ? 0 : remainder / stride;
                            remainder = stride == 0 ? 0 : remainder % stride;
                            indices.Add(new BoundLiteralExpression(null, index, TypeSymbol.Int32));
                        }

                        initializerSideEffects.Add(
                            new BoundExpressionStatement(
                                null,
                                BoundIndexAssignmentExpression.WithExpressionTarget(
                                    null,
                                    arrayReference,
                                    indices.MoveToImmutable(),
                                    element,
                                    rectangular.ElementType)));
                    }

                    return new BoundSpillSequenceExpression(
                        null,
                        initializerLocals.ToImmutable(),
                        initializerSideEffects.ToImmutable(),
                        arrayReference);
                }

                var operands = ImmutableArray.CreateBuilder<BoundExpression>(
                    arrayCreation.DimensionExpressions.Length + arrayCreation.Elements.Length);
                operands.AddRange(arrayCreation.DimensionExpressions);
                operands.AddRange(arrayCreation.Elements);
                var (rectangularLocals, rectangularSideEffects, spilled) = SpillArgumentList(
                    operands.MoveToImmutable(),
                    spillEveryPreAwaitOperand: true);
                if (rectangularLocals.Count == 0 && rectangularSideEffects.Count == 0)
                {
                    return Trivial(arrayCreation);
                }

                var dimensions = spilled
                    .Take(arrayCreation.DimensionExpressions.Length)
                    .ToImmutableArray();
                var rectangularElements = spilled
                    .Skip(arrayCreation.DimensionExpressions.Length)
                    .ToImmutableArray();
                return new BoundSpillSequenceExpression(
                    null,
                    rectangularLocals.ToImmutable(),
                    rectangularSideEffects.ToImmutable(),
                    BoundArrayCreationExpression.CreateRectangular(
                        null,
                        rectangular,
                        dimensions,
                        rectangularElements,
                        arrayCreation.RectangularLengths));
            }

            if (arrayCreation.LengthExpression != null)
            {
                return SpillOneOperand(
                    arrayCreation,
                    arrayCreation.LengthExpression,
                    length => new BoundArrayCreationExpression(null, arrayCreation.ContainerType, length));
            }

            var (locals, sideEffects, elements) = SpillArgumentList(arrayCreation.Elements);
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(arrayCreation);
            }

            var value = new BoundArrayCreationExpression(null, arrayCreation.ContainerType, elements.ToImmutable());
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillStackAlloc(BoundStackAllocExpression stackAlloc)
        {
            var combined = ImmutableArray.CreateBuilder<BoundExpression>(stackAlloc.InitializerElements.Length + 1);
            combined.Add(stackAlloc.Count);
            combined.AddRange(stackAlloc.InitializerElements);

            var (locals, sideEffects, spilled) = SpillArgumentList(combined.ToImmutable());
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(stackAlloc);
            }

            var spilledCount = spilled[0];
            var spilledElements = ImmutableArray.CreateBuilder<BoundExpression>(stackAlloc.InitializerElements.Length);
            for (var i = 1; i < spilled.Count; i++)
            {
                spilledElements.Add(spilled[i]);
            }

            var value = new BoundStackAllocExpression(null, stackAlloc.ResultType, stackAlloc.ElementType, spilledCount, stackAlloc.IsPointerForm, spilledElements.ToImmutable());
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillStructLiteral(BoundStructLiteralExpression structLiteral)
        {
            var values = ImmutableArray.CreateBuilder<BoundExpression>(structLiteral.Initializers.Length);
            foreach (var init in structLiteral.Initializers)
            {
                values.Add(init.Value);
            }

            var (locals, sideEffects, spilledValues) = SpillArgumentList(values.ToImmutable());
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(structLiteral);
            }

            var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>(structLiteral.Initializers.Length);
            for (var i = 0; i < structLiteral.Initializers.Length; i++)
            {
                var original = structLiteral.Initializers[i];
                initializers.Add(original.Field != null
                    ? new BoundFieldInitializer(original.Field, spilledValues[i], original.FieldDeclaringType)
                    : new BoundFieldInitializer(
                        Invariant.Required(
                            original.Property,
                            "a field initializer targets either a field or a property, and Field was null"),
                        spilledValues[i]));
            }

            var value = new BoundStructLiteralExpression(null, structLiteral.StructType, initializers.ToImmutable());
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        private BoundSpillSequenceExpression SpillMapLiteral(BoundMapLiteralExpression mapLiteral)
        {
            var kvExprs = ImmutableArray.CreateBuilder<BoundExpression>(mapLiteral.Entries.Length * 2);
            foreach (var entry in mapLiteral.Entries)
            {
                kvExprs.Add(entry.Key);
                kvExprs.Add(entry.Value);
            }

            var (locals, sideEffects, spilledKv) = SpillArgumentList(kvExprs.ToImmutable());
            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(mapLiteral);
            }

            var entries = ImmutableArray.CreateBuilder<BoundMapEntry>(mapLiteral.Entries.Length);
            for (var i = 0; i < mapLiteral.Entries.Length; i++)
            {
                entries.Add(new BoundMapEntry(spilledKv[i * 2], spilledKv[(i * 2) + 1]));
            }

            var value = new BoundMapLiteralExpression(null, mapLiteral.MapType, entries.ToImmutable());
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        /// <summary>
        /// Spills a single-operand expression: if the operand has no await,
        /// returns the original expression unchanged (trivial); otherwise
        /// spills the operand and rebuilds via <paramref name="rebuild"/>.
        /// </summary>
        private BoundSpillSequenceExpression SpillOneOperand(
            BoundExpression original,
            BoundExpression operand,
            Func<BoundExpression, BoundExpression> rebuild)
        {
            if (!HasAwait(operand))
            {
                return Trivial(original);
            }

            var spilled = SpillExpression(operand);
            var value = rebuild(spilled.Value);
            return new BoundSpillSequenceExpression(null, spilled.Locals, spilled.SideEffects, value);
        }

        /// <summary>
        /// Spills two operands evaluated eagerly, left-to-right (no short
        /// circuiting) — mirrors the non-logical path of <see cref="SpillBinary"/>
        /// and <see cref="SpillIndexAssignment"/>. If the second operand has
        /// an await, the first is spilled to a stable temp first (unless it's
        /// already pure/constant) so its value survives the suspension.
        /// </summary>
        private BoundSpillSequenceExpression SpillTwoOperand(
            BoundExpression original,
            BoundExpression a,
            BoundExpression b,
            Func<BoundExpression, BoundExpression, BoundExpression> rebuild)
        {
            var aHasAwait = HasAwait(a);
            var bHasAwait = HasAwait(b);

            if (!aHasAwait && !bHasAwait)
            {
                return Trivial(original);
            }

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression left = a;
            if (aHasAwait)
            {
                var spilledA = SpillExpression(a);
                locals.AddRange(spilledA.Locals);
                sideEffects.AddRange(spilledA.SideEffects);
                left = spilledA.Value;
            }

            if (bHasAwait && !CanDeferAcrossLift(left))
            {
                var temp = MakeSpillTemp(left.Type);
                locals.Add(temp);
                sideEffects.Add(new BoundVariableDeclaration(null, temp, left));
                left = new BoundVariableExpression(null, temp);
            }

            BoundExpression right = b;
            if (bHasAwait)
            {
                var spilledB = SpillExpression(b);
                locals.AddRange(spilledB.Locals);
                sideEffects.AddRange(spilledB.SideEffects);
                right = spilledB.Value;
            }

            var value = rebuild(left, right);
            return new BoundSpillSequenceExpression(null, locals.ToImmutable(), sideEffects.ToImmutable(), value);
        }

        /// <summary>
        /// Spills a list of arguments. When argument K contains an await,
        /// all previous arguments (0..K-1) that are not pure/constant are
        /// spilled to temps to preserve evaluation order.
        /// </summary>
        private (ImmutableArray<LocalVariableSymbol>.Builder Locals,
                 ImmutableArray<BoundStatement>.Builder SideEffects,
                 ImmutableArray<BoundExpression>.Builder Args) SpillArgumentList(
            ImmutableArray<BoundExpression> arguments,
            bool spillEveryPreAwaitOperand = false)
        {
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();
            var args = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);

            // First pass: determine which args have await. Cache the per-argument
            // result in a set so the main loop below reuses it instead of
            // re-walking each argument's subtree a second time (issue #1625).
            var awaitIndices = new List<int>();
            var argsWithAwait = new HashSet<int>();
            for (var i = 0; i < arguments.Length; i++)
            {
                if (HasAwait(arguments[i]))
                {
                    awaitIndices.Add(i);
                    argsWithAwait.Add(i);
                }
            }

            if (awaitIndices.Count == 0)
            {
                // No awaits in arguments.
                for (var i = 0; i < arguments.Length; i++)
                {
                    args.Add(arguments[i]);
                }

                return (locals, sideEffects, args);
            }

            // We need to spill. Process args left-to-right.
            var firstAwaitIdx = awaitIndices[0];

            for (var i = 0; i < arguments.Length; i++)
            {
                var arg = arguments[i];

                if (argsWithAwait.Contains(i))
                {
                    // Spill this argument's await.
                    var spilledArg = SpillExpression(arg);
                    locals.AddRange(spilledArg.Locals);
                    sideEffects.AddRange(spilledArg.SideEffects);
                    var hasLaterAwait = false;
                    foreach (var awaitIndex in awaitIndices)
                    {
                        hasLaterAwait |= awaitIndex > i;
                    }

                    if (hasLaterAwait && !CanDeferAcrossLift(spilledArg.Value))
                    {
                        var temp = MakeSpillTemp(arg.Type);
                        locals.Add(temp);
                        sideEffects.Add(new BoundVariableDeclaration(null, temp, spilledArg.Value));
                        args.Add(new BoundVariableExpression(null, temp));
                    }
                    else
                    {
                        args.Add(spilledArg.Value);
                    }
                }
                else if (i < firstAwaitIdx
                    && (spillEveryPreAwaitOperand || !CanDeferAcrossLift(arg)))
                {
                    // This arg precedes an await — spill to temp.
                    var temp = MakeSpillTemp(arg.Type);
                    locals.Add(temp);
                    sideEffects.Add(new BoundVariableDeclaration(null, temp, arg));
                    args.Add(new BoundVariableExpression(null, temp));
                }
                else if (i > firstAwaitIdx
                    && (spillEveryPreAwaitOperand || !CanDeferAcrossLift(arg)))
                {
                    // Between awaits, we also need to check if there's a
                    // later await that would require this to be spilled.
                    var needsSpill = false;
                    foreach (var awIdx in awaitIndices)
                    {
                        if (awIdx > i)
                        {
                            needsSpill = true;
                            break;
                        }
                    }

                    if (needsSpill)
                    {
                        var temp = MakeSpillTemp(arg.Type);
                        locals.Add(temp);
                        sideEffects.Add(new BoundVariableDeclaration(null, temp, arg));
                        args.Add(new BoundVariableExpression(null, temp));
                    }
                    else
                    {
                        args.Add(arg);
                    }
                }
                else
                {
                    args.Add(arg);
                }
            }

            return (locals, sideEffects, args);
        }

        private static bool IsRectangularArrayType(TypeSymbol type)
            => type is RectangularArrayTypeSymbol
                || (type.ClrType is { IsArray: true } clrArray && clrArray.GetArrayRank() > 1);

        private LocalVariableSymbol MakeSpillTemp(TypeSymbol type)
        {
            var name = GeneratedNames.SpillTempField(spillOrdinal++, spillTempDomain);
            return new LocalVariableSymbol(name, isReadOnly: false, type);
        }

        private BoundLabel MakeLabel()
        {
            return new BoundLabel($"<>spill_label{spillOrdinal++}");
        }

        private static bool CanDeferAcrossLift(BoundExpression expression)
            => expression is BoundLiteralExpression or BoundDefaultExpression;

        private static BoundSpillSequenceExpression Trivial(BoundExpression value)
        {
            return new BoundSpillSequenceExpression(
                null,
                ImmutableArray<LocalVariableSymbol>.Empty,
                ImmutableArray<BoundStatement>.Empty,
                value);
        }

        private static void FlushSideEffects(BoundSpillSequenceExpression spill, ImmutableArray<BoundStatement>.Builder builder)
        {
            // Emit variable declarations for the spill locals (they need IL slots).
            foreach (var local in spill.Locals)
            {
                // Only emit a declaration if the local isn't already declared as part
                // of the side-effects (the await spill already uses BoundVariableDeclaration).
                var alreadyDeclared = false;
                foreach (var stmt in spill.SideEffects)
                {
                    if (stmt is BoundVariableDeclaration decl && decl.Variable == local)
                    {
                        alreadyDeclared = true;
                        break;
                    }
                }

                if (!alreadyDeclared)
                {
                    builder.Add(new BoundVariableDeclaration(null, local, new BoundDefaultExpression(null, local.Type)));
                }
            }

            foreach (var stmt in spill.SideEffects)
            {
                builder.Add(stmt);
            }
        }

        private bool HasAwait(BoundStatement statement)
            => AsyncBoundTreeQueries.HasAwait(statement, awaitMemo)
                || (includeYieldInBlockExpressions && HasYieldInBlockExpression(statement, yieldInBlockMemo))
                || (includeControlFlowInBlockExpressions && HasControlFlowInBlockExpression(statement, controlFlowInBlockMemo));

        private bool HasAwait(BoundExpression expression)
            => AsyncBoundTreeQueries.HasAwait(expression, awaitMemo)
                || (includeYieldInBlockExpressions && HasYieldInBlockExpression(expression, yieldInBlockMemo))
                || (includeControlFlowInBlockExpressions && HasControlFlowInBlockExpression(expression, controlFlowInBlockMemo));
    }
}
