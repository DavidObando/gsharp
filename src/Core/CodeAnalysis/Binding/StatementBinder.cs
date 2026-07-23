// <copyright file="StatementBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-7. Owns all per-statement-kind
/// binding logic: dispatch (<see cref="BindStatement"/>), block bodies, locals
/// and deconstruction, control flow (<c>if</c>, <c>switch</c>, <c>for</c>
/// family, <c>break</c>/<c>continue</c>/<c>return</c>), effects (<c>try</c>,
/// <c>throw</c>, <c>using</c>, <c>defer</c>, <c>go</c>, channel send,
/// <c>select</c>, <c>yield</c>, <c>scope</c>), and the expression-statement
/// fall-through. Type-system narrowing helpers (nil-guard, MemberNotNullWhen
/// merging, pattern narrowing) ride along because they are only consumed by
/// statement binders. Expression binding remains on <see cref="Binder"/> and is
/// invoked via the delegate callbacks supplied to the constructor; the two
/// symbol-construction <c>BindVariableDeclaration</c> overloads (used pervasively
/// across non-statement contexts) also stay on <see cref="Binder"/> and are
/// invoked through delegate callbacks here.
/// </summary>
internal sealed partial class StatementBinder
{
    private static bool IsDiscard(SyntaxToken token) => token.Text == "_";

    /// <summary>Signature for the root <see cref="ExpressionBinder.BindExpression(ExpressionSyntax, bool)"/> entry point.</summary>
    /// <param name="syntax">The expression syntax to bind.</param>
    /// <param name="canBeVoid">Whether the expression is permitted to have <c>void</c> type.</param>
    /// <returns>The bound expression.</returns>
    internal delegate BoundExpression BindExpressionDelegate(ExpressionSyntax syntax, bool canBeVoid = false);

    /// <summary>Signature for the root binder's <c>BindExpression(syntax, targetType)</c> overload.</summary>
    /// <param name="syntax">The expression syntax to bind.</param>
    /// <param name="targetType">The target type used to drive conversion.</param>
    /// <returns>The bound expression, possibly converted to the target type.</returns>
    internal delegate BoundExpression BindExpressionWithTargetTypeDelegate(ExpressionSyntax syntax, TypeSymbol targetType);

    /// <summary>Signature for <c>BindVariableDeclaration(SyntaxToken, bool, TypeSymbol)</c> on <see cref="Binder"/>.</summary>
    /// <param name="identifier">The identifier token introducing the variable.</param>
    /// <param name="isReadOnly">Whether the variable is read-only (<c>let</c>).</param>
    /// <param name="type">The declared/inferred type of the variable.</param>
    /// <returns>The resulting variable symbol.</returns>
    internal delegate VariableSymbol BindLocalVariableDelegate(SyntaxToken identifier, bool isReadOnly, TypeSymbol type);

    /// <summary>Signature for <c>BindVariableDeclaration(SyntaxToken, bool, TypeSymbol, Accessibility)</c>.</summary>
    /// <param name="identifier">The identifier token introducing the variable.</param>
    /// <param name="isReadOnly">Whether the variable is read-only (<c>let</c>).</param>
    /// <param name="type">The declared/inferred type of the variable.</param>
    /// <param name="accessibility">The declared accessibility of the variable.</param>
    /// <returns>The resulting variable symbol.</returns>
    internal delegate VariableSymbol BindLocalVariableWithAccessibilityDelegate(SyntaxToken identifier, bool isReadOnly, TypeSymbol type, Accessibility accessibility);

    /// <summary>Signature for the simplified attribute-binding callback used only by local variable declarations.</summary>
    /// <param name="annotations">The annotations attached to the declaration.</param>
    /// <param name="positionDescription">Human-readable position description used for diagnostics.</param>
    /// <returns>The bound attributes.</returns>
    internal delegate ImmutableArray<BoundAttribute> BindVariableDeclarationAttributesDelegate(ImmutableArray<AnnotationSyntax> annotations, string positionDescription);

    private readonly BinderContext binderCtx;
    private readonly ConversionClassifier conversions;
    private readonly PatternBinder patterns;
    private readonly BindExpressionDelegate bindExpression;
    private readonly BindExpressionWithTargetTypeDelegate bindExpressionWithTargetType;
    private readonly Func<TypeClauseSyntax, TypeSymbol> bindTypeClause;
    private readonly BindLocalVariableDelegate bindLocalVariable;
    private readonly BindLocalVariableWithAccessibilityDelegate bindLocalVariableWithAccessibility;
    private readonly Func<string, TextLocation, VariableSymbol> bindVariableReference;
    private readonly Func<InterpolatedStringExpressionSyntax, TypeSymbol, BoundExpression> bindInterpolatedStringAsFormattable;
    private readonly Func<TypeSymbol, bool> isFormattableStringTargetType;
    private readonly Func<BoundExpression, bool> isLvalue;
    private readonly Func<TypeSymbol, bool> isIteratorReturnType;
    private readonly Func<SyntaxToken, Accessibility> resolveAccessibility;
    private readonly BindVariableDeclarationAttributesDelegate bindVariableDeclarationAttributes;
    private readonly Func<FunctionSymbol> getCurrentFunction;
    private readonly Func<LambdaExpressionSyntax, FunctionTypeSymbol, BoundExpression> bindLambdaWithTargetType;
    private readonly Func<VariableDeclarationSyntax, BoundStatement> bindGenericLocalFunctionDeclaration;
    private readonly Action<TextLocation, string, BoundFunctionLiteralExpression> checkNonGenericLocalFunctionEnclosingTypeParameterReference;
    private readonly Stack<SyntaxNode> exceptionHandlerRegions = new();
    private readonly Dictionary<string, ImmutableArray<SyntaxNode>> userLabelHandlerRegions =
        new(StringComparer.Ordinal);
    private readonly List<(string LabelName, TextLocation Location, ImmutableArray<SyntaxNode> SourceRegions)>
        userGotoHandlerRegions = new();
    private int usingInitializationFlagCount;

    public StatementBinder(
        BinderContext binderCtx,
        ConversionClassifier conversions,
        PatternBinder patterns,
        BindExpressionDelegate bindExpression,
        BindExpressionWithTargetTypeDelegate bindExpressionWithTargetType,
        Func<TypeClauseSyntax, TypeSymbol> bindTypeClause,
        BindLocalVariableDelegate bindLocalVariable,
        BindLocalVariableWithAccessibilityDelegate bindLocalVariableWithAccessibility,
        Func<string, TextLocation, VariableSymbol> bindVariableReference,
        Func<InterpolatedStringExpressionSyntax, TypeSymbol, BoundExpression> bindInterpolatedStringAsFormattable,
        Func<TypeSymbol, bool> isFormattableStringTargetType,
        Func<BoundExpression, bool> isLvalue,
        Func<TypeSymbol, bool> isIteratorReturnType,
        Func<SyntaxToken, Accessibility> resolveAccessibility,
        BindVariableDeclarationAttributesDelegate bindVariableDeclarationAttributes,
        Func<FunctionSymbol> getCurrentFunction,
        Func<LambdaExpressionSyntax, FunctionTypeSymbol, BoundExpression> bindLambdaWithTargetType = null,
        Func<VariableDeclarationSyntax, BoundStatement> bindGenericLocalFunctionDeclaration = null,
        Action<TextLocation, string, BoundFunctionLiteralExpression> checkNonGenericLocalFunctionEnclosingTypeParameterReference = null)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.conversions = conversions ?? throw new ArgumentNullException(nameof(conversions));
        this.patterns = patterns ?? throw new ArgumentNullException(nameof(patterns));
        this.bindExpression = bindExpression ?? throw new ArgumentNullException(nameof(bindExpression));
        this.bindExpressionWithTargetType = bindExpressionWithTargetType ?? throw new ArgumentNullException(nameof(bindExpressionWithTargetType));
        this.bindTypeClause = bindTypeClause ?? throw new ArgumentNullException(nameof(bindTypeClause));
        this.bindLocalVariable = bindLocalVariable ?? throw new ArgumentNullException(nameof(bindLocalVariable));
        this.bindLocalVariableWithAccessibility = bindLocalVariableWithAccessibility ?? throw new ArgumentNullException(nameof(bindLocalVariableWithAccessibility));
        this.bindVariableReference = bindVariableReference ?? throw new ArgumentNullException(nameof(bindVariableReference));
        this.bindInterpolatedStringAsFormattable = bindInterpolatedStringAsFormattable ?? throw new ArgumentNullException(nameof(bindInterpolatedStringAsFormattable));
        this.isFormattableStringTargetType = isFormattableStringTargetType ?? throw new ArgumentNullException(nameof(isFormattableStringTargetType));
        this.isLvalue = isLvalue ?? throw new ArgumentNullException(nameof(isLvalue));
        this.isIteratorReturnType = isIteratorReturnType ?? throw new ArgumentNullException(nameof(isIteratorReturnType));
        this.resolveAccessibility = resolveAccessibility ?? throw new ArgumentNullException(nameof(resolveAccessibility));
        this.bindVariableDeclarationAttributes = bindVariableDeclarationAttributes ?? throw new ArgumentNullException(nameof(bindVariableDeclarationAttributes));
        this.getCurrentFunction = getCurrentFunction ?? throw new ArgumentNullException(nameof(getCurrentFunction));
        this.bindLambdaWithTargetType = bindLambdaWithTargetType;
        this.bindGenericLocalFunctionDeclaration = bindGenericLocalFunctionDeclaration;
        this.checkNonGenericLocalFunctionEnclosingTypeParameterReference = checkNonGenericLocalFunctionEnclosingTypeParameterReference;
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private BoundScope scope
#pragma warning restore SA1300
    {
        get => binderCtx.RootScope;
        set => binderCtx.RootScope = value;
    }

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private FunctionSymbol function => getCurrentFunction();
#pragma warning restore SA1300

    private BoundStatement BindErrorStatement()
    {
        return new BoundExpressionStatement(null, new BoundErrorExpression(null));
    }

    internal BoundStatement BindStatement(StatementSyntax syntax)
    {
        switch (syntax.Kind)
        {
            case SyntaxKind.CommentToken:
                // comments don't need to be bound
                return null;
            case SyntaxKind.BlockStatement:
                return BindBlockStatement((BlockStatementSyntax)syntax);
            case SyntaxKind.VariableDeclaration:
                return BindVariableDeclaration((VariableDeclarationSyntax)syntax);
            case SyntaxKind.IfStatement:
                return BindIfStatement((IfStatementSyntax)syntax);
            case SyntaxKind.IfLetStatement:
                return BindIfLetStatement((IfLetStatementSyntax)syntax);
            case SyntaxKind.GuardLetStatement:
                return BindGuardLetStatement((GuardLetStatementSyntax)syntax);
            case SyntaxKind.ForInfiniteStatement:
                return BindForInfiniteStatement((ForInfiniteStatementSyntax)syntax);
            case SyntaxKind.ForEllipsisStatement:
                return BindForEllipsisStatement((ForEllipsisStatementSyntax)syntax);
            case SyntaxKind.ForConditionStatement:
                return BindForConditionStatement((ForConditionStatementSyntax)syntax);
            case SyntaxKind.ForClauseStatement:
                return BindForClauseStatement((ForClauseStatementSyntax)syntax);
            case SyntaxKind.ForRangeStatement:
                return BindForRangeStatement((ForRangeStatementSyntax)syntax);
            case SyntaxKind.ForTupleRangeStatement:
                return BindForTupleRangeStatement((ForTupleRangeStatementSyntax)syntax);
            case SyntaxKind.WhileStatement:
                return BindWhileStatement((WhileStatementSyntax)syntax);
            case SyntaxKind.LockStatement:
                return BindLockStatement((LockStatementSyntax)syntax);
            case SyntaxKind.DoWhileStatement:
                return BindDoWhileStatement((DoWhileStatementSyntax)syntax);
            case SyntaxKind.LabeledStatement:
                return BindLabeledStatement((LabeledStatementSyntax)syntax);
            case SyntaxKind.GotoStatement:
                return BindGotoStatement((GotoStatementSyntax)syntax);
            case SyntaxKind.BreakStatement:
                return BindBreakStatement((BreakStatementSyntax)syntax);
            case SyntaxKind.ContinueStatement:
                return BindContinueStatement((ContinueStatementSyntax)syntax);
            case SyntaxKind.ReturnStatement:
                return BindReturnStatement((ReturnStatementSyntax)syntax);
            case SyntaxKind.ExpressionStatement:
                return BindExpressionStatement((ExpressionStatementSyntax)syntax);
            case SyntaxKind.MultiAssignmentStatement:
                return BindMultiAssignmentStatement((MultiAssignmentStatementSyntax)syntax);
            case SyntaxKind.SwitchStatement:
                return BindSwitchStatement((SwitchStatementSyntax)syntax);
            case SyntaxKind.TryStatement:
                return BindTryStatement((TryStatementSyntax)syntax);
            case SyntaxKind.ThrowStatement:
                return BindThrowStatement((ThrowStatementSyntax)syntax);
            case SyntaxKind.UsingStatement:
                return BindUsingStatement((UsingStatementSyntax)syntax);
            case SyntaxKind.DeferStatement:
                return BindDeferStatement((DeferStatementSyntax)syntax);
            case SyntaxKind.GoStatement:
                return BindGoStatement((GoStatementSyntax)syntax);
            case SyntaxKind.ChannelSendStatement:
                return BindChannelSendStatement((ChannelSendStatementSyntax)syntax);
            case SyntaxKind.SelectStatement:
                return BindSelectStatement((SelectStatementSyntax)syntax);
            case SyntaxKind.ScopeStatement:
                return BindScopeStatement((ScopeStatementSyntax)syntax);
            case SyntaxKind.FixedStatement:
                return BindFixedStatement((FixedStatementSyntax)syntax);
            case SyntaxKind.AwaitForRangeStatement:
                return BindAwaitForRangeStatement((AwaitForRangeStatementSyntax)syntax);
            case SyntaxKind.AwaitUsingStatement:
                return BindAwaitUsingStatement((AwaitUsingStatementSyntax)syntax);
            case SyntaxKind.YieldStatement:
                return BindYieldStatement((YieldStatementSyntax)syntax);
            case SyntaxKind.TupleDeconstructionStatement:
                return BindTupleDeconstructionStatement((TupleDeconstructionStatementSyntax)syntax);
            case SyntaxKind.NamedDeconstructionStatement:
                return BindNamedDeconstructionStatement((NamedDeconstructionStatementSyntax)syntax);
            case SyntaxKind.NullCoalescingAssignmentStatement:
                return BindNullCoalescingAssignmentStatement((NullCoalescingAssignmentStatementSyntax)syntax);
            default:
                throw new Exception($"Unexpected syntax {syntax.Kind}");
        }
    }

    internal BoundStatement BindBlockStatement(BlockStatementSyntax syntax)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        scope = new BoundScope(scope);

        // ADR-0122 / issue #1014: an `unsafe { … }` block enters an unsafe
        // context for the duration of its statements. The body of an
        // `unsafe func` (or any method of an `unsafe` type) is likewise an
        // unsafe context — its top-level block carries no `unsafe` keyword, so
        // consult the current function's unsafe flag as well.
        var entersUnsafe = syntax.IsUnsafe || (function?.IsUnsafe ?? false);

        // Issue #1881: a `checked { … }` / `unchecked { … }` block establishes
        // the named overflow context for its statements; an ordinary block
        // leaves the enclosing context untouched (unlike `unsafe`, there is no
        // ambient default to fall back to).
        using var checkedScope = syntax.IsChecked || syntax.IsUnchecked
            ? binderCtx.PushCheckedContext(syntax.IsChecked)
            : default;
        using (binderCtx.PushUnsafeContext(entersUnsafe))
        {
            BindBlockStatements(syntax.Statements, 0, statements);
        }

        scope = scope.Parent;

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    internal ImmutableArray<BoundStatement> BindStatementList(
        ImmutableArray<StatementSyntax> statementSyntaxes,
        Action<StatementSyntax> beforeBind = null,
        Func<BoundStatement> trailingStatement = null)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        BindBlockStatements(statementSyntaxes, 0, statements, beforeBind, trailingStatement);
        return statements.ToImmutable();
    }

    private void BindBlockStatements(
        ImmutableArray<StatementSyntax> statementSyntaxes,
        int startIndex,
        ImmutableArray<BoundStatement>.Builder statements,
        Action<StatementSyntax> beforeBind = null,
        Func<BoundStatement> trailingStatement = null)
    {
        // Issue #208: push a persistent narrowing frame for this statement list.
        // After each call statement whose method carries [MemberNotNull], the
        // named fields are added to this frame and remain narrowed for all
        // subsequent statements in the block (until assignment invalidates them).
        var memberNotNullFrame = new Dictionary<AccessPath, TypeSymbol>();
        binderCtx.NarrowedVariables.Add(memberNotNullFrame);
        try
        {
            for (var i = startIndex; i < statementSyntaxes.Length; i++)
            {
                var statementSyntax = statementSyntaxes[i];
                beforeBind?.Invoke(statementSyntax);

                if (statementSyntax is DeferStatementSyntax deferSyntax)
                {
                    var defer = BindDeferStatementInBlock(deferSyntax);
                    statements.AddRange(defer.PrefixStatements);
                    if (defer.Cleanup == null)
                    {
                        statements.Add(defer.ErrorStatement);
                        InvalidateNarrowingsForAssignedVariables(statementSyntax);
                        continue;
                    }

                    InvalidateNarrowingsForAssignedVariables(statementSyntax);
                    var innerStatements = ImmutableArray.CreateBuilder<BoundStatement>();
                    BindBlockStatements(statementSyntaxes, i + 1, innerStatements, beforeBind, trailingStatement);
                    statements.Add(BuildCleanupTryStatement(innerStatements.ToImmutable(), defer.Cleanup));
                    return;
                }

                if (statementSyntax is UsingStatementSyntax usingSyntax)
                {
                    var usingLowering = BindUsingStatementInBlock(usingSyntax);
                    if (usingLowering.InitializedDeclaration != null)
                    {
                        statements.Add(usingLowering.InitializedDeclaration);
                    }

                    if (usingLowering.Declaration != null)
                    {
                        statements.Add(usingLowering.Declaration);
                    }

                    if (usingLowering.Cleanup == null)
                    {
                        statements.Add(usingLowering.ErrorStatement);
                        InvalidateNarrowingsForAssignedVariables(statementSyntax);
                        continue;
                    }

                    statements.Add(BuildInitializedAssignment(usingLowering.Initialized));
                    InvalidateNarrowingsForAssignedVariables(statementSyntax);
                    var innerStatements = ImmutableArray.CreateBuilder<BoundStatement>();
                    BindBlockStatements(statementSyntaxes, i + 1, innerStatements, beforeBind, trailingStatement);
                    statements.Add(BuildCleanupTryStatement(
                        innerStatements.ToImmutable(),
                        usingLowering.Cleanup,
                        usingLowering.Initialized));
                    return;
                }

                if (statementSyntax is AwaitUsingStatementSyntax awaitUsingSyntax)
                {
                    var awaitUsingLowering = BindAwaitUsingStatementInBlock(awaitUsingSyntax);
                    if (awaitUsingLowering.InitializedDeclaration != null)
                    {
                        statements.Add(awaitUsingLowering.InitializedDeclaration);
                    }

                    if (awaitUsingLowering.Declaration != null)
                    {
                        statements.Add(awaitUsingLowering.Declaration);
                    }

                    if (awaitUsingLowering.Cleanup == null)
                    {
                        statements.Add(awaitUsingLowering.ErrorStatement);
                        InvalidateNarrowingsForAssignedVariables(statementSyntax);
                        continue;
                    }

                    statements.Add(BuildInitializedAssignment(awaitUsingLowering.Initialized));
                    InvalidateNarrowingsForAssignedVariables(statementSyntax);
                    var innerStatements = ImmutableArray.CreateBuilder<BoundStatement>();
                    BindBlockStatements(statementSyntaxes, i + 1, innerStatements, beforeBind, trailingStatement);
                    statements.Add(BuildCleanupTryStatement(
                        innerStatements.ToImmutable(),
                        awaitUsingLowering.Cleanup,
                        awaitUsingLowering.Initialized));
                    return;
                }

                // ADR-0071 / issue #708: `guard let` extends the enclosing block's
                // scope with the new bindings. Inline the per-binding decl + nil-
                // check pairs directly into the enclosing statement list so that
                // (a) the synthesized variables live for the rest of the block and
                // (b) `ApplyEarlyExitNarrowings` lifts each binding's non-nil
                // narrowing into the persistent block frame for subsequent reads.
                if (statementSyntax is GuardLetStatementSyntax guardLetSyntax)
                {
                    BindGuardLetStatementInBlock(guardLetSyntax, statements, memberNotNullFrame);
                    InvalidateNarrowingsForAssignedVariables(statementSyntax);
                    continue;
                }

                var statement = BindStatement(statementSyntax);
                statements.Add(statement);

                // Issue #208: after binding a call statement, apply any
                // [MemberNotNull] post-condition narrowings to the persistent frame.
                ApplyMemberNotNullNarrowings(statement, memberNotNullFrame);

                // ADR-0069 / issue #700: lift the else-frame of an
                // `if x !is T { return }` (or any if whose then-branch
                // ends in an unconditional exit) into the enclosing
                // block's persistent frame, so subsequent reads in this
                // block see the narrowing.
                ApplyEarlyExitNarrowings(statement, memberNotNullFrame);

                // Phase 3.C.4: mutation invalidates the narrowing. After binding
                // a statement that writes to a narrowed variable, drop its
                // narrowing from the current frame so subsequent reads in this
                // block see the variable at its declared (nullable) type again.
                InvalidateNarrowingsForAssignedVariables(statementSyntax);

                // Issue #1123: assignment-based smart cast. After invalidation
                // (which clears any stale narrowing on the assigned variable),
                // re-narrow a nullable `var` local that was just assigned a
                // statically non-nullable value, so subsequent reads in this
                // block — and nested blocks — see the non-nullable type until a
                // later mutation invalidates it again. Runs last so it wins over
                // the invalidation pass for the same statement.
                ApplyAssignmentNarrowing(statement, memberNotNullFrame);

                // Issue #2159: `if`-join narrowing. After invalidation (which
                // drops any narrowing the `if` mutates), lift a nullable `var`
                // local that both the then- and else-branch leave non-null into
                // the persistent frame, so subsequent reads see the non-nullable
                // type. Runs after invalidation for the same reason as the
                // assignment narrowing above.
                ApplyIfJoinNarrowings(statement, memberNotNullFrame);
            }

            if (trailingStatement != null)
            {
                statements.Add(trailingStatement());
            }
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    private static BoundExpressionStatement BuildInitializedAssignment(
        VariableSymbol initialized,
        bool value = true)
        => new(
            null,
            new BoundAssignmentExpression(
                null,
                initialized,
                new BoundLiteralExpression(null, value)));

    private BoundTryStatement BuildCleanupTryStatement(
        ImmutableArray<BoundStatement> protectedStatements,
        BoundExpression cleanup,
        VariableSymbol initialized = null)
    {
        var tryBlock = new BoundBlockStatement(null, protectedStatements);
        BoundStatement cleanupStatement = new BoundExpressionStatement(null, cleanup);
        if (initialized != null)
        {
            cleanupStatement = new BoundBlockStatement(
                null,
                ImmutableArray.Create<BoundStatement>(
                    BuildInitializedAssignment(initialized, value: false),
                    cleanupStatement));
            cleanupStatement = new BoundIfStatement(
                null,
                new BoundVariableExpression(null, initialized),
                cleanupStatement,
                elseStatement: null);
        }

        var finallyBlock = new BoundBlockStatement(null, ImmutableArray.Create(cleanupStatement));
        return new BoundTryStatement(null, tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);
    }
}
