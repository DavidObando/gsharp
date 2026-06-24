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
internal sealed class StatementBinder
{
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
        Func<LambdaExpressionSyntax, FunctionTypeSymbol, BoundExpression> bindLambdaWithTargetType = null)
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
            case SyntaxKind.WhileStatement:
                return BindWhileStatement((WhileStatementSyntax)syntax);
            case SyntaxKind.DoWhileStatement:
                return BindDoWhileStatement((DoWhileStatementSyntax)syntax);
            case SyntaxKind.LabeledStatement:
                return BindLabeledStatement((LabeledStatementSyntax)syntax);
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
        using (binderCtx.PushUnsafeContext(entersUnsafe))
        {
            BindBlockStatements(syntax.Statements, 0, statements);
        }

        scope = scope.Parent;

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private void BindBlockStatements(ImmutableArray<StatementSyntax> statementSyntaxes, int startIndex, ImmutableArray<BoundStatement>.Builder statements)
    {
        // Issue #208: push a persistent narrowing frame for this statement list.
        // After each call statement whose method carries [MemberNotNull], the
        // named fields are added to this frame and remain narrowed for all
        // subsequent statements in the block (until assignment invalidates them).
        var memberNotNullFrame = new Dictionary<VariableSymbol, TypeSymbol>();
        binderCtx.NarrowedVariables.Add(memberNotNullFrame);
        try
        {
            for (var i = startIndex; i < statementSyntaxes.Length; i++)
            {
                var statementSyntax = statementSyntaxes[i];

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
                    BindBlockStatements(statementSyntaxes, i + 1, innerStatements);
                    statements.Add(BuildCleanupTryStatement(innerStatements.ToImmutable(), defer.Cleanup));
                    return;
                }

                if (statementSyntax is UsingStatementSyntax usingSyntax)
                {
                    var usingLowering = BindUsingStatementInBlock(usingSyntax);
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

                    InvalidateNarrowingsForAssignedVariables(statementSyntax);
                    var innerStatements = ImmutableArray.CreateBuilder<BoundStatement>();
                    BindBlockStatements(statementSyntaxes, i + 1, innerStatements);
                    statements.Add(BuildCleanupTryStatement(innerStatements.ToImmutable(), usingLowering.Cleanup));
                    return;
                }

                if (statementSyntax is AwaitUsingStatementSyntax awaitUsingSyntax)
                {
                    var awaitUsingLowering = BindAwaitUsingStatementInBlock(awaitUsingSyntax);
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

                    InvalidateNarrowingsForAssignedVariables(statementSyntax);
                    var innerStatements = ImmutableArray.CreateBuilder<BoundStatement>();
                    BindBlockStatements(statementSyntaxes, i + 1, innerStatements);
                    statements.Add(BuildCleanupTryStatement(innerStatements.ToImmutable(), awaitUsingLowering.Cleanup));
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
            }
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    /// <summary>
    /// If <paramref name="statement"/> is a call expression statement whose
    /// called function carries <c>[MemberNotNull("_f", …)]</c>, narrows each
    /// named field (via its <see cref="ImplicitFieldVariableSymbol"/>) to its
    /// underlying non-nullable type in <paramref name="frame"/>.
    /// </summary>
    private void ApplyMemberNotNullNarrowings(BoundStatement statement, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        BoundExpression callExpr = null;
        if (statement is BoundExpressionStatement exprStmt)
        {
            callExpr = exprStmt.Expression;
        }

        if (callExpr == null)
        {
            return;
        }

        ImmutableArray<string> memberNames;
        switch (callExpr)
        {
            case BoundCallExpression userCall:
                if (!KnownAttributes.TryGetMemberNotNullMembers(userCall.Function.Attributes, out memberNames))
                {
                    return;
                }

                break;

            case BoundImportedCallExpression importedCall:
                if (!ClrNullability.TryGetMemberNotNullMembers(importedCall.Function.Method, out memberNames))
                {
                    return;
                }

                break;

            case BoundImportedInstanceCallExpression instanceCall:
                if (!ClrNullability.TryGetMemberNotNullMembers(instanceCall.Method, out memberNames))
                {
                    return;
                }

                break;

            case BoundUserInstanceCallExpression userInstanceCall:
                if (!KnownAttributes.TryGetMemberNotNullMembers(userInstanceCall.Method.Attributes, out memberNames))
                {
                    return;
                }

                break;

            default:
                return;
        }

        foreach (var name in memberNames)
        {
            NarrowFieldIfNullable(name, frame);
        }
    }

    /// <summary>
    /// Looks up <paramref name="fieldName"/> in the current scope. If it
    /// resolves to an <see cref="ImplicitFieldVariableSymbol"/> whose declared
    /// type is nullable, adds a narrowing entry to <paramref name="frame"/>
    /// that maps the symbol to its underlying non-nullable type.
    /// </summary>
    private void NarrowFieldIfNullable(string fieldName, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        if (scope.TryLookupSymbol(fieldName) is ImplicitFieldVariableSymbol fieldVar
            && fieldVar.Type is NullableTypeSymbol nullable)
        {
            frame[fieldVar] = nullable.UnderlyingType;
        }
    }

    private BoundTryStatement BuildCleanupTryStatement(ImmutableArray<BoundStatement> protectedStatements, BoundExpression cleanup)
    {
        var tryBlock = new BoundBlockStatement(null, protectedStatements);
        var finallyBlock = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, cleanup)));
        return new BoundTryStatement(null, tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);
    }

    private void InvalidateNarrowingsForAssignedVariables(SyntaxNode statementSyntax)
    {
        if (binderCtx.NarrowedVariables.Count == 0)
        {
            return;
        }

        var assignedNames = new HashSet<string>();
        CollectAssignedNames(statementSyntax, assignedNames);
        if (assignedNames.Count == 0)
        {
            return;
        }

        // Resolve each name through the current scope and drop any matching
        // narrowing from ALL active frames. We don't need to be conservative
        // about scope shadowing: the narrowed variable lives in an outer scope,
        // so an inner shadowing declaration with the same name will resolve to a
        // different symbol, and the narrowing will simply not be triggered.
        // Issue #208: iterate ALL frames (not just the top) because the
        // memberNotNullFrame sits above the if-condition frames; dropping from
        // only the top would miss narrowings added by if-condition analysis.
        foreach (var name in assignedNames)
        {
            if (scope.TryLookupSymbol(name) is VariableSymbol v)
            {
                for (var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i--)
                {
                    binderCtx.NarrowedVariables[i].Remove(v);
                }
            }
        }
    }

    private static void CollectAssignedNames(SyntaxNode node, HashSet<string> assigned)
    {
        switch (node)
        {
            case AssignmentExpressionSyntax a:
                assigned.Add(a.IdentifierToken.Text);
                break;
            case MultiAssignmentStatementSyntax m:
                foreach (var t in m.Targets)
                {
                    if (t is NameExpressionSyntax ne)
                    {
                        assigned.Add(ne.IdentifierToken.Text);
                    }
                }

                break;
        }

        foreach (var child in node.GetChildren())
        {
            CollectAssignedNames(child, assigned);
        }
    }

    /// <summary>
    /// ADR-0069 / issue #700: when the bound statement is an
    /// <see cref="BoundIfStatement"/> whose then-branch unconditionally
    /// exits the enclosing block, and whose else-frame (recorded by
    /// <see cref="BindIfStatement"/>) is non-empty, merge that frame into
    /// <paramref name="persistentFrame"/> so subsequent statements in the
    /// enclosing block see the narrowing.
    /// </summary>
    private void ApplyEarlyExitNarrowings(BoundStatement statement, Dictionary<VariableSymbol, TypeSymbol> persistentFrame)
    {
        if (statement is BoundIfStatement ifStmt)
        {
            if (!binderCtx.PendingEarlyExitFrames.TryGetValue(ifStmt, out var elseFrame))
            {
                return;
            }

            binderCtx.PendingEarlyExitFrames.Remove(ifStmt);

            // Only apply the lift if the then-branch unconditionally exits.
            // Falling through means the variable could still be of any type
            // that satisfies the original condition, so the else-frame is not
            // a safe post-condition.
            if (!EndsInUnconditionalExit(ifStmt.ThenStatement))
            {
                return;
            }

            foreach (var kv in elseFrame)
            {
                persistentFrame[kv.Key] = kv.Value;
            }

            return;
        }

        // ADR-0069 addendum / issue #712: post-switch narrowing lift. When
        // every non-exiting arm contributes the same narrowing on the
        // discriminator, propagate that narrowing into the enclosing block.
        if (statement is BoundPatternSwitchStatement switchStmt
            && binderCtx.PendingSwitchExitFrames.TryGetValue(switchStmt, out var switchFrame))
        {
            binderCtx.PendingSwitchExitFrames.Remove(switchStmt);

            foreach (var kv in switchFrame)
            {
                persistentFrame[kv.Key] = kv.Value;
            }
        }
    }

    /// <summary>
    /// ADR-0069 / issue #700: structurally determine whether the given
    /// bound statement unconditionally transfers control out of its
    /// enclosing block (return / throw / unconditional goto, which covers
    /// the lowered shapes of <c>break</c> and <c>continue</c>). A block
    /// counts when its last statement does any of those; an
    /// <see cref="BoundIfStatement"/> counts only if both arms do.
    /// </summary>
    private static bool EndsInUnconditionalExit(BoundStatement statement)
    {
        switch (statement)
        {
            case BoundReturnStatement:
            case BoundThrowStatement:
                return true;

            case BoundGotoStatement:
                // `break`/`continue` lower to BoundGotoStatement before this
                // helper runs; an explicit `goto` likewise transfers
                // control unconditionally.
                return true;

            case BoundBlockStatement block:
                if (block.Statements.IsDefaultOrEmpty)
                {
                    return false;
                }

                return EndsInUnconditionalExit(block.Statements[block.Statements.Length - 1]);

            case BoundIfStatement nested:
                if (nested.ElseStatement == null)
                {
                    return false;
                }

                return EndsInUnconditionalExit(nested.ThenStatement)
                    && EndsInUnconditionalExit(nested.ElseStatement);

            case BoundPatternSwitchStatement nestedSwitch:
                {
                    // ADR-0069 addendum / issue #712: a switch unconditionally
                    // exits when every arm (including default) does, and it
                    // covers every input the discriminator can take — i.e.,
                    // a default arm exists. Without a default the switch
                    // can fall through past every arm without entering any.
                    var hasDefault = false;
                    foreach (var arm in nestedSwitch.Arms)
                    {
                        if (arm.Pattern == null || arm.Pattern is BoundDiscardPattern)
                        {
                            hasDefault = true;
                        }

                        if (!EndsInUnconditionalExit(arm.Body))
                        {
                            return false;
                        }
                    }

                    return hasDefault;
                }

            default:
                return false;
        }
    }

    private BoundStatement BindVariableDeclaration(VariableDeclarationSyntax syntax)
    {
        // Issue #491 (ADR-0060 follow-up): a `let ref` / `var ref` declaration introduces a
        // ref-aliasing local. The local's IL slot stores a managed pointer (`T&`) into the
        // initializer's lvalue; the symbol's static type remains `T` and reads/writes through
        // the local are implicitly indirected by the lowering & emitter. The slot itself
        // never carries a `const` value, so the assignability of the alias matches the
        // mutability of the aliased lvalue (writes through the alias write the storage).
        if (syntax.HasRefKindModifier)
        {
            return BindRefAliasLocalDeclaration(syntax);
        }

        var isReadOnly = syntax.Keyword?.Kind == SyntaxKind.ConstKeyword
            || syntax.Keyword?.Kind == SyntaxKind.LetKeyword;
        var type = bindTypeClause(syntax.TypeClause);

        BoundExpression convertedInitializer;
        TypeSymbol variableType;
        if (syntax.Initializer == null)
        {
            // Bare `var x T` declaration: the variable is initialized to the
            // type's default value (Go-style zero value). The parser only
            // produces a null initializer when a type clause is present.
            variableType = type ?? TypeSymbol.Error;
            convertedInitializer = new BoundDefaultExpression(syntax, variableType);
        }
        else
        {
            // ADR-0055 Tier 4: an interpolated-string initializer whose declared
            // type is IFormattable/FormattableString lowers to
            // FormattableStringFactory.Create rather than an eager string.
            if (type != null
                && syntax.Initializer is InterpolatedStringExpressionSyntax interpolatedInit
                && isFormattableStringTargetType(type))
            {
                variableType = type;
                convertedInitializer = bindInterpolatedStringAsFormattable(interpolatedInit, type);
            }
            else if (type != null
                && syntax.Initializer is LambdaExpressionSyntax targetTypedLambda
                && bindLambdaWithTargetType != null
                && MemberLookup.TryGetDelegateFunctionTypeFromSymbol(type, out var targetFnType))
            {
                // ADR-0076 / issue #716: when a binding has an explicit
                // function-type and is initialised with an arrow lambda,
                // bind the lambda with the target shape so omitted
                // parameter type clauses are filled in from the target's
                // slots. The conversion that follows is identity for a
                // matching lambda shape; for a mismatch the regular
                // conversion diagnostic still fires.
                //
                // Issue #951: the target shape is extracted via
                // TryGetDelegateFunctionTypeFromSymbol so it also covers an
                // explicit CLR delegate binding type (e.g.
                // `let f Func[int32, int32] = (x) -> x + 1`), not just the
                // canonical `(int32) -> int32` function-type clause.
                variableType = type;
                var lambda = bindLambdaWithTargetType(targetTypedLambda, targetFnType);
                convertedInitializer = conversions.BindConversion(syntax.Initializer.Location, lambda, variableType);
            }
            else if (type is PointerTypeSymbol && syntax.Initializer is StackAllocExpressionSyntax)
            {
                // ADR-0124 / issue #1024: `var p *T = stackalloc [n]T` inside
                // an unsafe context yields the raw `T*` pointer. The target
                // pointer type must be threaded into the stackalloc binder so
                // it selects the pointer form rather than the default Span<T>.
                variableType = type;
                convertedInitializer = bindExpressionWithTargetType(syntax.Initializer, type);
            }
            else if (type != null && syntax.Initializer is DefaultExpressionSyntax defaultInit && defaultInit.TypeClause == null)
            {
                // ADR-0100 / issue #795: bare `default` initializer takes
                // its type from the declared variable type. We bind to a
                // BoundDefaultExpression of that type directly so the
                // emitter sees the value-type zero-init shape and the
                // interpreter mirrors it. The eager
                // `bindExpression(syntax.Initializer)` path would report
                // GS0362 because the kind dispatch has no target type.
                variableType = type;
                convertedInitializer = new BoundDefaultExpression(defaultInit, variableType);
            }
            else
            {
                var initializer = bindExpression(syntax.Initializer);
                variableType = type ?? initializer.Type;
                convertedInitializer = conversions.BindConversion(syntax.Initializer.Location, initializer, variableType);
            }
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var variable = bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly, variableType, accessibility);

        // ADR-0058 / issue #376: propagate `scoped` modifier from syntax to the local symbol,
        // or infer function-local escape scope from the initializer (STE data-flow propagation).
        if (variable is LocalVariableSymbol localVar)
        {
            if (syntax.IsScoped)
            {
                localVar.IsScoped = true;
            }
            else if ((TypeSymbol.IsByRefLike(variableType) || variableType is ByRefTypeSymbol) && convertedInitializer != null)
            {
                // Infer scoped from initializer: if the initializer is rooted in a
                // scoped variable, the new local inherits function-local STE/RSTE.
                localVar.IsScoped = HasFunctionLocalEscapeScope(convertedInitializer);
            }
        }

        // Issue #367: a by-ref-like (`ref struct`) local is legal in an ordinary
        // function, but an async function or an iterator hoists every local into
        // a heap-allocated state machine, which the CLR forbids for a by-ref-like
        // type. A top-level (global) variable is emitted as a static field, which
        // is likewise heap-rooted and forbidden. Reject the declaration in those
        // contexts.
        if (TypeSymbol.IsByRefLike(variableType))
        {
            if (function == null || function.IsTopLevelEntryPoint)
            {
                Diagnostics.ReportByRefLikeEscape(syntax.Identifier.Location, variableType, "be declared as a top-level variable (it would be emitted as a heap-rooted static field)");
            }
            else if (function.IsAsync || isIteratorReturnType(function.Type))
            {
                var context = function.IsAsync ? "an async function" : "an iterator";
                Diagnostics.ReportByRefLikeEscape(syntax.Identifier.Location, variableType, $"be declared as a local in {context} (it would be hoisted into the state machine)");
            }
        }

        // Issue #187 / ADR-0047 §3: bind any `@Foo` annotations and attach
        // them to the variable symbol so #175 use-site diagnostics
        // (e.g. `@Obsolete`) fire when the variable is read or written.
        // Globals (`GlobalVariableSymbol`) will eventually round-trip these
        // to CLR `CustomAttribute` rows on their backing static field; for
        // locals the attributes carry compiler-recognised semantics only.
        if (variable != null && !syntax.Annotations.IsDefaultOrEmpty)
        {
            var positionDescription = variable is GlobalVariableSymbol
                ? "a top-level variable declaration"
                : "a local variable declaration";
            var boundAttrs = bindVariableDeclarationAttributes(syntax.Annotations, positionDescription);
            variable.SetAttributes(boundAttrs);
        }

        // Issue #216: a `const` declaration whose converted initializer is a
        // literal expression carries a compile-time ConstantValue. The emitter
        // uses this to skip IL slot allocation and emit a LocalConstant PDB row.
        object constValue = null;
        if (syntax.Keyword?.Kind == SyntaxKind.ConstKeyword
            && convertedInitializer is BoundLiteralExpression litExpr)
        {
            constValue = litExpr.Value;
        }

        return new BoundVariableDeclaration(syntax, variable, convertedInitializer, constValue);
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): binds a <c>let ref name [T] = lvalue</c> or
    /// <c>var ref name [T] = lvalue</c> declaration. The local is recorded with
    /// <see cref="RefKind.Ref"/> and its initializer is normalized to a
    /// <see cref="BoundAddressOfExpression"/> over the aliased lvalue so the emitter / interpreter
    /// can populate the alias slot with a managed pointer at the declaration site and
    /// route subsequent reads/writes through the indirection.
    /// </summary>
    private BoundStatement BindRefAliasLocalDeclaration(VariableDeclarationSyntax syntax)
    {
        var refModifierLoc = syntax.RefKindModifier.Location;
        var declaredType = bindTypeClause(syntax.TypeClause);

        // `const ref` is rejected: a `const` binding is a compile-time constant,
        // not a runtime storage slot, so there is no storage to alias.
        if (syntax.Keyword?.Kind == SyntaxKind.ConstKeyword)
        {
            Diagnostics.ReportRefLocalCannotBeDeclaredHere(refModifierLoc, syntax.Identifier.Text, "a 'const' binding");
        }

        // An initializer is required: the local must alias an existing lvalue.
        if (syntax.Initializer == null)
        {
            Diagnostics.ReportRefLocalRhsMustBeLvalue(refModifierLoc, "<missing>");
            var errorVar = bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly: false, declaredType ?? TypeSymbol.Error, resolveAccessibility(syntax.AccessibilityModifier));
            return new BoundVariableDeclaration(syntax, errorVar, new BoundErrorExpression(null));
        }

        var initializer = bindExpression(syntax.Initializer);
        if (initializer is BoundErrorExpression)
        {
            var errorVar = bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly: false, declaredType ?? TypeSymbol.Error, resolveAccessibility(syntax.AccessibilityModifier));
            return new BoundVariableDeclaration(syntax, errorVar, initializer);
        }

        // Validate the RHS is a writable lvalue: a variable that is not read-only,
        // a field/property access, an indexer access, or a managed-pointer dereference.
        // The same restrictions that govern `&expr` apply here (issue #491 / ADR-0039 §3).
        var rhsValid = true;
        if (initializer is BoundVariableExpression bve && bve.Variable.IsReadOnly)
        {
            // Aliasing a read-only binding would let the alias mutate it; mirror
            // the existing `&readonly` rejection (GS9005 / GS0242 for `in`).
            if (bve.Variable is ParameterSymbol inParam && inParam.RefKind == RefKind.In)
            {
                Diagnostics.ReportCannotAssignToInParameter(refModifierLoc, inParam.Name);
            }
            else
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(refModifierLoc, bve.Variable.Name);
            }

            rhsValid = false;
        }
        else if (!isLvalue(initializer))
        {
            var exprText = syntax.Initializer.ToString();
            Diagnostics.ReportRefLocalRhsMustBeLvalue(refModifierLoc, exprText);
            rhsValid = false;
        }

        // Pointee type: the user may write an explicit type clause that must match
        // the initializer's static type; otherwise infer from the initializer.
        var pointeeType = initializer.Type ?? TypeSymbol.Error;
        if (declaredType != null && rhsValid && pointeeType != TypeSymbol.Error && declaredType != pointeeType)
        {
            Diagnostics.ReportCannotConvert(syntax.Initializer.Location, pointeeType, declaredType);
            rhsValid = false;
        }

        var slotType = declaredType ?? pointeeType;

        // Context restrictions: a ref-aliasing local cannot escape its declaring
        // function frame. The CLR cannot encode a managed pointer as a static
        // field (top-level / `customize` partial) or as a hoisted state-machine
        // field (`async`/iterator functions).
        if (function == null || function.IsTopLevelEntryPoint)
        {
            Diagnostics.ReportRefLocalCannotBeDeclaredHere(refModifierLoc, syntax.Identifier.Text, "a top-level variable (it would be emitted as a heap-rooted static field)");
            rhsValid = false;
        }
        else if (function.IsAsync || isIteratorReturnType(function.Type))
        {
            var context = function.IsAsync ? "a local in an async function" : "a local in an iterator";
            Diagnostics.ReportRefLocalCannotBeDeclaredHere(refModifierLoc, syntax.Identifier.Text, context + " (it would be hoisted into the state machine)");
            rhsValid = false;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var variable = bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly: false, slotType, accessibility);
        if (variable is LocalVariableSymbol localVar)
        {
            // The alias slot itself is function-local; never returnable.
            localVar.RefKind = RefKind.Ref;
            localVar.IsScoped = true;
        }

        // Annotations attach to the symbol unchanged (e.g. @Obsolete on a top-level
        // alias would still be observed if it ever became legal at top level).
        if (variable != null && !syntax.Annotations.IsDefaultOrEmpty)
        {
            var positionDescription = "a local variable declaration";
            var boundAttrs = bindVariableDeclarationAttributes(syntax.Annotations, positionDescription);
            variable.SetAttributes(boundAttrs);
        }

        // Lower the initializer to BoundAddressOfExpression so the emitter
        // populates the alias slot with the managed pointer (§5 / §6 of ADR-0060).
        BoundExpression boundInitializer = rhsValid
            ? new BoundAddressOfExpression(syntax.Initializer, initializer)
            : new BoundErrorExpression(null);

        return new BoundVariableDeclaration(syntax, variable, boundInitializer);
    }

    private BoundStatement BindTupleDeconstructionStatement(TupleDeconstructionStatementSyntax syntax)
    {
        // Phase 4.5: `let (a, b, ...) = expr`. Phase 7.3 extends the RHS from
        // tuple-only to data structs, preserving single-eval via a synthetic local.
        var initializer = bindExpression(syntax.Initializer);
        if (initializer.Type == TypeSymbol.Error)
        {
            return new BoundExpressionStatement(syntax, initializer);
        }

        if (initializer.Type is TupleTypeSymbol tupleType)
        {
            if (syntax.Identifiers.Count != tupleType.Arity)
            {
                Diagnostics.ReportDeconstructionFieldCountMismatch(syntax.CloseParenToken.Location, tupleType.Arity, syntax.Identifiers.Count);
                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
            }

            var tempName = $"<tuple{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
            var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, tupleType);
            scope.TryDeclareVariable(tempVar);

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));

            for (var i = 0; i < syntax.Identifiers.Count; i++)
            {
                var idTok = syntax.Identifiers[i];
                var elemType = tupleType.ElementTypes[i];
                var elemVar = bindLocalVariable(idTok, isReadOnly: true, elemType);
                var access = new BoundTupleElementAccessExpression(null, new BoundVariableExpression(null, tempVar), tupleType, i);
                statements.Add(new BoundVariableDeclaration(syntax, elemVar, access));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        if (initializer.Type is StructSymbol structType && (structType.IsData || structType.IsInline))
        {
            var fields = structType.Fields;
            if (syntax.Identifiers.Count != fields.Length)
            {
                Diagnostics.ReportDeconstructionFieldCountMismatch(syntax.CloseParenToken.Location, fields.Length, syntax.Identifiers.Count);
                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
            }

            var tempName = $"<data{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
            var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
            scope.TryDeclareVariable(tempVar);

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));
            for (var i = 0; i < syntax.Identifiers.Count; i++)
            {
                var idTok = syntax.Identifiers[i];
                var field = fields[i];
                var elemVar = bindLocalVariable(idTok, isReadOnly: true, field.Type);
                var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), structType, field);
                statements.Add(new BoundVariableDeclaration(syntax, elemVar, access));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenParenToken.Location, initializer.Type);
        return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
    }

    private BoundStatement BindNamedDeconstructionStatement(NamedDeconstructionStatementSyntax syntax)
    {
        var initializer = bindExpression(syntax.Initializer);
        if (initializer.Type == TypeSymbol.Error)
        {
            return new BoundExpressionStatement(syntax, initializer);
        }

        if (!(initializer.Type is StructSymbol structType) || (!structType.IsData && !structType.IsInline))
        {
            Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenBraceToken.Location, initializer.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var tempName = $"<data{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, structType);
        scope.TryDeclareVariable(tempVar);

        var seen = new HashSet<string>();
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, tempVar, initializer));
        foreach (var fieldSyntax in syntax.Fields)
        {
            var fieldName = fieldSyntax.FieldIdentifier.Text;
            if (!seen.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            if (!TypeMemberModel.TryGetFieldIncludingInherited(structType, fieldName, MemberQuery.Instance(MemberKinds.Field), out var field, out var declaringType))
            {
                Diagnostics.ReportUnableToFindMember(fieldSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            var variable = bindLocalVariable(fieldSyntax.LocalIdentifier, isReadOnly: true, field.Type);
            var access = new BoundFieldAccessExpression(null, new BoundVariableExpression(null, tempVar), declaringType, field);
            statements.Add(new BoundVariableDeclaration(syntax, variable, access));
        }

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private BoundStatement BindIfStatement(IfStatementSyntax syntax)
    {
        if (syntax.Initializer == null)
        {
            var condition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool);

            // Phase 3.C.4/6.6: recognise one top-level nullable guard. Boolean
            // conjunction/disjunction flow (for example `s != nil && IsValid(s)`)
            // is intentionally deferred for the nil-guard classifier.
            var (thenNarrow, elseNarrow) = TryClassifyNilGuard(condition);
            if (thenNarrow == null && elseNarrow == null)
            {
                (thenNarrow, elseNarrow) = TryClassifyBoolCallNarrowing(condition);
            }

            // ADR-0069 / issue #700: smart-cast type-test narrowing on
            // `x is T`, `x !is T`, and `&&` chains thereof. Compose with the
            // nullable / `[NotNullWhen]` frames computed above so a condition
            // that combines both styles narrows on both axes.
            var (typeThen, typeElse) = TryClassifyTypeTestNarrowing(condition);
            thenNarrow = MergeNarrowingFrames(thenNarrow, typeThen);
            elseNarrow = MergeNarrowingFrames(elseNarrow, typeElse);

            var thenStatement = BindStatementWithNarrowing(syntax.ThenStatement, thenNarrow);
            var elseStatement = syntax.ElseClause == null ? null : BindStatementWithNarrowing(syntax.ElseClause.ElseStatement, elseNarrow);
            var result = new BoundIfStatement(syntax, condition, thenStatement, elseStatement);

            // ADR-0069 / issue #700: record the else-frame so `BindBlockStatements`
            // can lift it into the enclosing block when the then-branch ends in
            // an unconditional exit (`return`/`throw`/`break`/`continue`).
            if (elseNarrow != null && elseNarrow.Count > 0)
            {
                binderCtx.PendingEarlyExitFrames[result] = elseNarrow;
            }

            return result;
        }

        // `if init; cond { then } else { else }` lowers to a block that
        // scopes the initializer to both arms:
        //   {
        //     <init>
        //     if cond { then } else { else }
        //   }
        scope = new BoundScope(scope);

        var initStatement = BindStatement(syntax.Initializer);
        var initCondition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool);

        var (initThenNarrow, initElseNarrow) = TryClassifyNilGuard(initCondition);
        if (initThenNarrow == null && initElseNarrow == null)
        {
            (initThenNarrow, initElseNarrow) = TryClassifyBoolCallNarrowing(initCondition);
        }

        var (initTypeThen, initTypeElse) = TryClassifyTypeTestNarrowing(initCondition);
        initThenNarrow = MergeNarrowingFrames(initThenNarrow, initTypeThen);
        initElseNarrow = MergeNarrowingFrames(initElseNarrow, initTypeElse);

        var initThen = BindStatementWithNarrowing(syntax.ThenStatement, initThenNarrow);
        var initElse = syntax.ElseClause == null ? null : BindStatementWithNarrowing(syntax.ElseClause.ElseStatement, initElseNarrow);

        scope = scope.Parent;

        var inner = new BoundIfStatement(syntax, initCondition, initThen, initElse);
        if (initElseNarrow != null && initElseNarrow.Count > 0)
        {
            binderCtx.PendingEarlyExitFrames[inner] = initElseNarrow;
        }

        return new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(initStatement, inner));
    }

    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0071 / issue #708: `if let` and `guard let` binding statements.
    //
    //  Both forms strip one layer of nullability from the right-hand-side
    //  expression and introduce a fresh local for it. The lowering is
    //  expressed entirely in terms of existing bound-node kinds so the
    //  rewriter / walker / printer / spiller / emitter / interpreter
    //  surface needs no updates.
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// ADR-0071 / issue #708: bind <c>if let</c> as a self-contained block
    /// containing the synthesized let-declarations and a nested if whose
    /// condition is the nil-guard. Multi-binding forms with an else-arm use
    /// a synthesized <c>bool</c> flag so the else-block appears in the
    /// bound tree exactly once.
    /// </summary>
    private BoundStatement BindIfLetStatement(IfLetStatementSyntax syntax)
    {
        var bindings = syntax.Bindings.ToImmutableArray();

        // Push a new scope to contain the synthesized locals. The locals
        // declared from the bindings only need to be visible inside the
        // then-branch, so a single block-scoped lifetime is correct.
        scope = new BoundScope(scope);

        var localsForFrame = new List<(VariableSymbol Variable, TypeSymbol Underlying)>(bindings.Length);
        var declStatements = ImmutableArray.CreateBuilder<BoundStatement>(bindings.Length);
        var anyValid = false;
        foreach (var binding in bindings)
        {
            var (variable, underlying, decl) = BindIfLetBindingClause(binding);
            declStatements.Add(decl);
            if (variable != null && underlying != null)
            {
                localsForFrame.Add((variable, underlying));
                anyValid = true;
            }
        }

        // Build the nil-test condition: `_b0 != nil && _b1 != nil && …`.
        // Each variable expression carries its underlying narrowing type so
        // that read sites inside the then-branch see the non-null type.
        BoundExpression nilCheck = BuildNilCheckChain(syntax, localsForFrame);

        // Build the narrowing frame so the then-block sees each binding at
        // its non-null underlying type. The else-block does NOT see the
        // narrowing — the bindings are not even in scope there.
        Dictionary<VariableSymbol, TypeSymbol> thenFrame = null;
        if (localsForFrame.Count > 0)
        {
            thenFrame = new Dictionary<VariableSymbol, TypeSymbol>(localsForFrame.Count);
            foreach (var (variable, underlying) in localsForFrame)
            {
                thenFrame[variable] = underlying;
            }
        }

        var thenStatement = BindStatementWithNarrowing(syntax.ThenStatement, thenFrame);

        // Pop the scope BEFORE binding the else clause so the bindings are
        // not visible inside it (ADR-0071: bindings are then-only).
        scope = scope.Parent;
        var elseStatement = syntax.ElseClause == null ? null : BindStatement(syntax.ElseClause.ElseStatement);

        // If no binding survived (every initializer was an error), just
        // return the synthesized block so the user still sees diagnostics
        // but no synthetic if-shape leaks.
        if (!anyValid)
        {
            return new BoundBlockStatement(syntax, declStatements.ToImmutable());
        }

        BoundStatement core;
        if (syntax.ElseClause == null || localsForFrame.Count <= 1)
        {
            // No else, or a single binding (which fits the natural shape
            // without needing a matched-flag): build a simple if/else.
            core = new BoundIfStatement(syntax, nilCheck, thenStatement, elseStatement);
        }
        else
        {
            // Multi-binding with an else: route through a synthesized
            // `bool _matched` flag so the else block runs exactly once and
            // is duplicated zero times in the bound tree.
            //
            // var __ifLet_matched_<pos> = false
            // let a = e0; if a != nil { let b = e1; if b != nil { ... if zN != nil { __matched = true; <then> } } }
            // if !__matched { <else> }
            var flagName = $"<ifLetMatched{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
            var flagVar = new LocalVariableSymbol(flagName, isReadOnly: false, TypeSymbol.Bool);
            scope.TryDeclareVariable(flagVar);

            var flagDecl = new BoundVariableDeclaration(syntax, flagVar, new BoundLiteralExpression(syntax, false, TypeSymbol.Bool));
            var setFlag = new BoundExpressionStatement(
                syntax,
                new BoundAssignmentExpression(syntax, flagVar, new BoundLiteralExpression(syntax, true, TypeSymbol.Bool)));
            var combinedThen = new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(setFlag, thenStatement));
            var matchIf = new BoundIfStatement(syntax, nilCheck, combinedThen, elseStatement: null);

            var notFlag = new BoundUnaryExpression(syntax, BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool), new BoundVariableExpression(syntax, flagVar));
            var elseIf = new BoundIfStatement(syntax, notFlag, elseStatement, elseStatement: null);

            var sequenced = ImmutableArray.CreateBuilder<BoundStatement>(declStatements.Count + 3);
            sequenced.Add(flagDecl);
            sequenced.AddRange(declStatements);
            sequenced.Add(matchIf);
            sequenced.Add(elseIf);
            return new BoundBlockStatement(syntax, sequenced.ToImmutable());
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>(declStatements.Count + 1);
        statements.AddRange(declStatements);
        statements.Add(core);
        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    /// <summary>
    /// ADR-0071 / issue #708: bind a single <c>let name [T] = expr</c>
    /// binding clause inside an <c>if let</c> or <c>guard let</c> header.
    /// Returns the synthesized variable (or <c>null</c> when the clause is
    /// erroneous), its underlying non-null type, and the resulting decl.
    /// The variable is declared in the binder's current scope; callers
    /// control that scope to scope the binding to a then-block or to the
    /// enclosing block as appropriate.
    /// </summary>
    private (VariableSymbol Variable, TypeSymbol Underlying, BoundStatement Declaration) BindIfLetBindingClause(IfLetBindingClauseSyntax binding)
    {
        TypeSymbol declaredUnderlying = null;
        if (binding.TypeClause != null)
        {
            declaredUnderlying = bindTypeClause(binding.TypeClause);

            // The author wrote `if let s string = …`: they declared the
            // underlying (non-null) type. A nullable spelling would be
            // self-defeating — reject it through the standard
            // initializer-type diagnostic by widening to the nullable.
            if (declaredUnderlying is NullableTypeSymbol declaredNullable)
            {
                declaredUnderlying = declaredNullable.UnderlyingType;
            }
        }

        var initializerExpr = bindExpression(binding.Initializer);
        var initializerType = initializerExpr.Type;

        if (initializerType == TypeSymbol.Error)
        {
            var errorVar = bindLocalVariable(binding.Identifier, isReadOnly: true, declaredUnderlying ?? TypeSymbol.Error);
            return (null, null, new BoundVariableDeclaration(binding, errorVar, initializerExpr));
        }

        // ADR-0071: the right-hand side must be of nullable type so the
        // binding has something to strip. A non-nullable RHS is GS0296.
        TypeSymbol underlying;
        TypeSymbol nullableStorageType;
        if (initializerType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
            nullableStorageType = nullable;
        }
        else if (initializerType == TypeSymbol.Null)
        {
            // A bare `nil` literal — there's no narrowing to do; bind to
            // the declared underlying type if available, otherwise error.
            if (declaredUnderlying == null)
            {
                Diagnostics.ReportIfLetInitializerMustBeNullable(binding.Initializer.Location, binding.Identifier.Text, initializerType);
                var errorVar = bindLocalVariable(binding.Identifier, isReadOnly: true, TypeSymbol.Error);
                return (null, null, new BoundVariableDeclaration(binding, errorVar, initializerExpr));
            }

            underlying = declaredUnderlying;
            nullableStorageType = NullableTypeSymbol.Get(declaredUnderlying);
        }
        else
        {
            Diagnostics.ReportIfLetInitializerMustBeNullable(binding.Initializer.Location, binding.Identifier.Text, initializerType);
            var errorVar = bindLocalVariable(binding.Identifier, isReadOnly: true, declaredUnderlying ?? initializerType);
            return (null, null, new BoundVariableDeclaration(binding, errorVar, initializerExpr));
        }

        // If the user gave an explicit type clause, the underlying type
        // they wrote must match (or be a conversion-target of) the RHS's
        // underlying. We route through the existing conversion classifier
        // for an apples-to-apples diagnostic.
        if (declaredUnderlying != null)
        {
            var conv = conversions.BindConversion(binding.Initializer.Location, initializerExpr, NullableTypeSymbol.Get(declaredUnderlying));
            initializerExpr = conv;
            underlying = declaredUnderlying;
            nullableStorageType = NullableTypeSymbol.Get(declaredUnderlying);
        }

        // The synthesized binding is `let name <nullable> = expr`. The
        // user observes it at the underlying type via the existing
        // narrowing path (NarrowedType on each read site).
        var variable = bindLocalVariable(binding.Identifier, isReadOnly: true, nullableStorageType);
        var declaration = new BoundVariableDeclaration(binding, variable, initializerExpr);
        return (variable, underlying, declaration);
    }

    /// <summary>
    /// ADR-0071 / issue #708: build a left-folded `&amp;&amp;` chain of
    /// <c>variable != nil</c> tests for the given bindings. With a single
    /// binding this is just <c>variable != nil</c>.
    /// </summary>
    private static BoundExpression BuildNilCheckChain(SyntaxNode syntax, List<(VariableSymbol Variable, TypeSymbol Underlying)> bindings)
    {
        BoundExpression result = null;
        foreach (var (variable, _) in bindings)
        {
            var read = new BoundVariableExpression(syntax, variable);
            var nilLiteral = new BoundLiteralExpression(syntax, null, TypeSymbol.Null);
            var neqOp = BoundBinaryOperator.Bind(SyntaxKind.BangEqualsToken, variable.Type, TypeSymbol.Null);
            BoundExpression test = new BoundBinaryExpression(syntax, read, neqOp, nilLiteral);
            if (result == null)
            {
                result = test;
            }
            else
            {
                var andOp = BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool);
                result = new BoundBinaryExpression(syntax, result, andOp, test);
            }
        }

        return result;
    }

    /// <summary>
    /// ADR-0071 / issue #708: standalone fallback for binding
    /// <c>guard let</c> when it appears outside a block (for example as a
    /// stray statement at the top of a function body when the outer
    /// dispatch routes through <see cref="BindStatement"/>). The normal
    /// path goes through <see cref="BindGuardLetStatementInBlock"/>, which
    /// integrates with the enclosing block's narrowing frame.
    /// </summary>
    private BoundStatement BindGuardLetStatement(GuardLetStatementSyntax syntax)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var pseudoFrame = new Dictionary<VariableSymbol, TypeSymbol>();
        BindGuardLetStatementInBlock(syntax, statements, pseudoFrame);
        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    /// <summary>
    /// ADR-0071 / issue #708: bind <c>guard let</c> into the enclosing
    /// statement builder so the synthesized locals and the narrowings
    /// extend the enclosing block. Each binding becomes a let-decl
    /// followed by an `if x == nil { else }` whose else-block is the
    /// user's exit clause; the existing
    /// <see cref="ApplyEarlyExitNarrowings"/> path lifts each binding's
    /// non-nil narrowing into <paramref name="persistentFrame"/>.
    /// </summary>
    private void BindGuardLetStatementInBlock(
        GuardLetStatementSyntax syntax,
        ImmutableArray<BoundStatement>.Builder statements,
        Dictionary<VariableSymbol, TypeSymbol> persistentFrame)
    {
        // Bind the else block once up-front strictly to validate that it
        // unconditionally exits the enclosing scope (GS0297). We then
        // re-bind it for each binding arm because the ControlFlowGraph
        // builder demands that each BoundStatement appear at most once
        // in the tree (it keys block lookup by statement identity).
        var probeElse = BindStatement(syntax.ElseStatement);
        if (!EndsInUnconditionalExit(probeElse))
        {
            Diagnostics.ReportGuardLetElseMustExit(syntax.ElseStatement.Location);
        }

        foreach (var binding in syntax.Bindings)
        {
            var (variable, underlying, decl) = BindIfLetBindingClause(binding);
            statements.Add(decl);
            if (variable == null || underlying == null)
            {
                continue;
            }

            // Bind a fresh copy of the else block for this arm so that the
            // ControlFlowGraph builder sees a unique BoundStatement
            // instance per arm.
            var armElse = BindStatement(syntax.ElseStatement);

            // Build `if <var> == nil { else }`.
            var read = new BoundVariableExpression(binding, variable);
            var nilLiteral = new BoundLiteralExpression(binding, null, TypeSymbol.Null);
            var eqOp = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, variable.Type, TypeSymbol.Null);
            var condition = new BoundBinaryExpression(binding, read, eqOp, nilLiteral);
            var ifStmt = new BoundIfStatement(binding, condition, armElse, elseStatement: null);

            // Manually thread the persistent-frame narrowing for this
            // binding. We *cannot* round-trip through
            // ApplyEarlyExitNarrowings because that helper consumes
            // entries from PendingEarlyExitFrames keyed by the if node;
            // we have the data inline here, so just promote directly.
            persistentFrame[variable] = underlying;
            statements.Add(ifStmt);
        }
    }

    private static Dictionary<VariableSymbol, TypeSymbol> MergeNarrowingFrames(
        Dictionary<VariableSymbol, TypeSymbol> a,
        Dictionary<VariableSymbol, TypeSymbol> b)
    {
        if (a == null || a.Count == 0)
        {
            return (b == null || b.Count == 0) ? null : b;
        }

        if (b == null || b.Count == 0)
        {
            return a;
        }

        var merged = new Dictionary<VariableSymbol, TypeSymbol>(a);
        foreach (var kv in b)
        {
            // Later (more specific) wins on conflict. The type-test path passes
            // its frame as `b`, so a type-test narrowing supersedes a coincident
            // nil-guard narrowing on the same variable.
            merged[kv.Key] = kv.Value;
        }

        return merged;
    }

    /// <summary>
    /// ADR-0069 / issue #700: classify <c>is</c> / <c>!is</c> tests (and
    /// <c>&amp;&amp;</c> chains thereof) on a local-variable or parameter
    /// receiver into per-branch narrowing frames.
    /// </summary>
    /// <param name="condition">The bound condition expression.</param>
    /// <returns>A pair of narrowing frames — the first applies to the
    /// then-branch, the second to the else-branch. Either may be
    /// <c>null</c> if the corresponding branch has no narrowing.</returns>
    private (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) TryClassifyTypeTestNarrowing(BoundExpression condition)
    {
        switch (condition)
        {
            case BoundIsExpression isExpr:
                {
                    if (!IsNarrowableVariable(isExpr.Expression, out var target))
                    {
                        return (null, null);
                    }

                    var targetType = isExpr.TargetType;
                    if (targetType == null || targetType == TypeSymbol.Error)
                    {
                        return (null, null);
                    }

                    // `x is T` narrows `x` to `T` in the then-branch. The
                    // else-branch carries no narrowing: failing the type test
                    // tells us nothing more about the variable's type.
                    var narrowed = StripNullable(targetType);
                    if (!IsStrictlyNarrower(target.Type, narrowed))
                    {
                        return (null, null);
                    }

                    return (new Dictionary<VariableSymbol, TypeSymbol> { [target] = narrowed }, null);
                }

            case BoundUnaryExpression unary when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation:
                {
                    var (inThen, inElse) = TryClassifyTypeTestNarrowing(unary.Operand);
                    return (inElse, inThen);
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd:
                {
                    // De Morgan for `&&`: then = thenL ∧ thenR (both true → both narrowings apply).
                    // The else frame is intentionally dropped — either operand could have been
                    // the false one, so we cannot single out a per-variable narrowing.
                    var (leftThen, _) = TryClassifyTypeTestNarrowing(binary.Left);
                    var (rightThen, _) = TryClassifyTypeTestNarrowing(binary.Right);
                    var combinedThen = MergeNarrowingFrames(leftThen, rightThen);
                    if (combinedThen == null || combinedThen.Count == 0)
                    {
                        return (null, null);
                    }

                    return (combinedThen, null);
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr:
                {
                    // ADR-0069 addendum / issue #712: De Morgan dual of `&&` for `||`.
                    // For `A || B`:
                    //   • then = intersection of thenL and thenR — only narrowings present
                    //     in BOTH operands' then-frames with the same target type survive
                    //     (canonical example: `x is T || x is T` keeps `{x → T}`).
                    //   • else = elseL ∧ elseR — when the whole `||` is false, BOTH operands
                    //     were false, so both negative narrowings apply.
                    var (leftThen, leftElse) = TryClassifyTypeTestNarrowing(binary.Left);
                    var (rightThen, rightElse) = TryClassifyTypeTestNarrowing(binary.Right);

                    var combinedThen = IntersectNarrowingFrames(leftThen, rightThen);
                    var combinedElse = MergeNarrowingFrames(leftElse, rightElse);

                    if ((combinedThen == null || combinedThen.Count == 0)
                        && (combinedElse == null || combinedElse.Count == 0))
                    {
                        return (null, null);
                    }

                    return (combinedThen, combinedElse);
                }
        }

        return (null, null);
    }

    /// <summary>
    /// ADR-0069 addendum / issue #712: intersect two narrowing frames. Only
    /// variables present in both frames AND narrowed to the same type
    /// survive. Used by the <c>||</c> then-frame classifier where a
    /// narrowing is only sound if both operands prove the same fact.
    /// </summary>
    private static Dictionary<VariableSymbol, TypeSymbol> IntersectNarrowingFrames(
        Dictionary<VariableSymbol, TypeSymbol> a,
        Dictionary<VariableSymbol, TypeSymbol> b)
    {
        if (a == null || a.Count == 0 || b == null || b.Count == 0)
        {
            return null;
        }

        Dictionary<VariableSymbol, TypeSymbol> result = null;
        foreach (var kv in a)
        {
            if (b.TryGetValue(kv.Key, out var other) && other == kv.Value)
            {
                result ??= new Dictionary<VariableSymbol, TypeSymbol>();
                result[kv.Key] = kv.Value;
            }
        }

        return result;
    }

    private static bool IsNarrowableVariable(BoundExpression expr, out VariableSymbol variable)
    {
        variable = null;
        if (expr is not BoundVariableExpression bve)
        {
            return false;
        }

        // ADR-0069 narrows locals and parameters only — never fields,
        // properties, or implicit-field/property reads. Those receivers
        // can be mutated by aliasing or another thread between the test
        // and the use, so narrowing would be unsound.
        if (bve.Variable is LocalVariableSymbol or ParameterSymbol)
        {
            variable = bve.Variable;
            return true;
        }

        return false;
    }

    /// <summary>
    /// ADR-0069 addendum / issue #712: stability rule for switch-pattern
    /// narrowing. We narrow non-mutable receivers — locals, parameters,
    /// and read-only globals (<c>let</c>). Mutable globals are excluded
    /// because they can be reassigned between the test and the use under
    /// aliasing or another thread.
    /// </summary>
    private static bool IsStableNarrowableVariable(VariableSymbol variable)
    {
        return variable switch
        {
            LocalVariableSymbol => true,
            GlobalVariableSymbol g => g.IsReadOnly,
            _ => false,
        };
    }

    private static TypeSymbol StripNullable(TypeSymbol type)
    {
        return type is NullableTypeSymbol nullable ? nullable.UnderlyingType : type;
    }

    private static bool IsStrictlyNarrower(TypeSymbol declared, TypeSymbol candidate)
    {
        if (candidate == null || candidate == TypeSymbol.Error)
        {
            return false;
        }

        if (declared == candidate)
        {
            return false;
        }

        // Stripping the nullable wrapper alone counts as narrowing
        // (`string? → string`).
        if (declared is NullableTypeSymbol declaredNullable && declaredNullable.UnderlyingType == candidate)
        {
            return true;
        }

        // For any other shape, accept it as a narrowing as long as the
        // declared and candidate types are distinct. The runtime `is`
        // test has already proved that the value is of the candidate
        // type, so binder-time soundness is satisfied regardless of
        // whether the candidate is a strict subtype in the type
        // hierarchy.
        return true;
    }

    private (Dictionary<VariableSymbol, TypeSymbol> NonNil, Dictionary<VariableSymbol, TypeSymbol> Nil) TryClassifyNilGuard(BoundExpression condition)
    {
        // ADR-0069 addendum / issue #712: compose nil-guard classification across
        // `!`, `&&`, and `||` so guards like `if a == nil || cond { ... } else { use(a) }`
        // narrow `a` to its non-nullable underlying type in the else-branch.
        switch (condition)
        {
            case BoundUnaryExpression unary when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation:
                {
                    var (inThen, inElse) = TryClassifyNilGuard(unary.Operand);
                    return (inElse, inThen);
                }

            case BoundBinaryExpression bin when bin.Op.Kind == BoundBinaryOperatorKind.LogicalAnd:
                {
                    var (leftThen, _) = TryClassifyNilGuard(bin.Left);
                    var (rightThen, _) = TryClassifyNilGuard(bin.Right);
                    var combinedThen = MergeNarrowingFrames(leftThen, rightThen);
                    if (combinedThen == null || combinedThen.Count == 0)
                    {
                        return (null, null);
                    }

                    return (combinedThen, null);
                }

            case BoundBinaryExpression bin when bin.Op.Kind == BoundBinaryOperatorKind.LogicalOr:
                {
                    var (leftThen, leftElse) = TryClassifyNilGuard(bin.Left);
                    var (rightThen, rightElse) = TryClassifyNilGuard(bin.Right);
                    var combinedThen = IntersectNarrowingFrames(leftThen, rightThen);
                    var combinedElse = MergeNarrowingFrames(leftElse, rightElse);
                    if ((combinedThen == null || combinedThen.Count == 0)
                        && (combinedElse == null || combinedElse.Count == 0))
                    {
                        return (null, null);
                    }

                    return (combinedThen, combinedElse);
                }
        }

        // Phase 3.C.4: recognise the canonical narrowing patterns. We support
        // only single-variable guards here at the leaf; conjunctions, disjunctions
        // and pattern-based narrowing compose via the cases above.
        if (condition is not BoundBinaryExpression be)
        {
            return (null, null);
        }

        VariableSymbol target = null;
        if (be.Left is BoundVariableExpression lv && IsNilLiteral(be.Right))
        {
            target = lv.Variable;
        }
        else if (be.Right is BoundVariableExpression rv && IsNilLiteral(be.Left))
        {
            target = rv.Variable;
        }

        if (target == null || target.Type is not NullableTypeSymbol nullable)
        {
            return (null, null);
        }

        var underlying = nullable.UnderlyingType;
        Dictionary<VariableSymbol, TypeSymbol> nonNilFrame = null;
        Dictionary<VariableSymbol, TypeSymbol> nilFrame = null;
        if (be.Op.Kind == BoundBinaryOperatorKind.NotEquals)
        {
            nonNilFrame = new Dictionary<VariableSymbol, TypeSymbol> { [target] = underlying };
        }
        else if (be.Op.Kind == BoundBinaryOperatorKind.Equals)
        {
            nilFrame = new Dictionary<VariableSymbol, TypeSymbol> { [target] = underlying };
        }

        return (nonNilFrame, nilFrame);
    }

    private (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) TryClassifyBoolCallNarrowing(BoundExpression condition)
    {
        var negate = false;
        var inner = condition;
        if (inner is BoundUnaryExpression unary && unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation)
        {
            negate = true;
            inner = unary.Operand;
        }

        if (inner is BoundImportedCallExpression importedCall && importedCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyImportedBoolCallNarrowing(importedCall, negate);
            MergeClrMemberNotNullWhenNarrowings(importedCall.Function.Method, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundImportedInstanceCallExpression importedInstanceCall && importedInstanceCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyImportedMethodBoolCallNarrowing(importedInstanceCall.Method.GetParameters(), importedInstanceCall.Arguments, negate);
            MergeClrMemberNotNullWhenNarrowings(importedInstanceCall.Method, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundCallExpression userCall && userCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyUserBoolCallNarrowing(userCall, negate);
            MergeUserMemberNotNullWhenNarrowings(userCall.Function.Attributes, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundUserInstanceCallExpression userInstanceCall && userInstanceCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = (default(Dictionary<VariableSymbol, TypeSymbol>), default(Dictionary<VariableSymbol, TypeSymbol>));
            MergeUserMemberNotNullWhenNarrowings(userInstanceCall.Method.Attributes, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        return (null, null);
    }

    // Issue #208: merge [MemberNotNullWhen] field narrowings from a CLR-imported method.
    private void MergeClrMemberNotNullWhenNarrowings(
        System.Reflection.MethodInfo method,
        bool negate,
        ref Dictionary<VariableSymbol, TypeSymbol> thenFrame,
        ref Dictionary<VariableSymbol, TypeSymbol> elseFrame)
    {
        if (!ClrNullability.TryGetMemberNotNullWhenData(method, out var returnValue, out var members))
        {
            return;
        }

        var narrowThen = returnValue != negate;
        var frame = narrowThen ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>()) : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
        foreach (var name in members)
        {
            NarrowFieldIfNullable(name, frame);
        }
    }

    // Issue #208: merge [MemberNotNullWhen] field narrowings from a user-declared method.
    private void MergeUserMemberNotNullWhenNarrowings(
        ImmutableArray<BoundAttribute> attributes,
        bool negate,
        ref Dictionary<VariableSymbol, TypeSymbol> thenFrame,
        ref Dictionary<VariableSymbol, TypeSymbol> elseFrame)
    {
        if (attributes.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var attr in attributes)
        {
            if (!KnownAttributes.TryGetMemberNotNullWhenData(attr, out var returnValue, out var members))
            {
                continue;
            }

            var narrowThen = returnValue != negate;
            var frame = narrowThen ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>()) : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
            foreach (var name in members)
            {
                NarrowFieldIfNullable(name, frame);
            }
        }
    }

    private static (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) ClassifyImportedBoolCallNarrowing(BoundImportedCallExpression call, bool negate)
        => ClassifyImportedMethodBoolCallNarrowing(call.Function.Method.GetParameters(), call.Arguments, negate);
    private static (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) ClassifyImportedMethodBoolCallNarrowing(
        ParameterInfo[] parameters,
        ImmutableArray<BoundExpression> arguments,
        bool negate)
    {
        Dictionary<VariableSymbol, TypeSymbol> thenFrame = null;
        Dictionary<VariableSymbol, TypeSymbol> elseFrame = null;
        var count = Math.Min(parameters.Length, arguments.Length);
        for (var i = 0; i < count; i++)
        {
            var parameter = parameters[i];

            // [MaybeNullWhen(rv)] on a non-nullable argument widens the caller's
            // variable to its nullable counterpart on the arm where the call returns
            // rv. The argument may be a plain variable or an address-of expression
            // (&var) when the CLR parameter is declared `out T`.
            if (ClrNullability.TryGetMaybeNullWhen(parameter, out var maybeNullWhenReturnValue))
            {
                var rawArg = arguments[i];
                var widenArg = rawArg is BoundAddressOfExpression addrOf ? addrOf.Operand : rawArg;
                if (widenArg is BoundVariableExpression widenVarExpr
                    && widenVarExpr.Variable.Type is not NullableTypeSymbol
                    && widenVarExpr.Variable.Type != TypeSymbol.Null)
                {
                    var widenThen = maybeNullWhenReturnValue != negate;
                    var widenFrame = widenThen
                        ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>())
                        : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
                    widenFrame[widenVarExpr.Variable] = NullableTypeSymbol.Get(widenVarExpr.Variable.Type);
                }

                continue;
            }

            if (!ClrNullability.TryGetNotNullWhen(parameter, out var returnValue)
                || arguments[i] is not BoundVariableExpression variableExpression
                || variableExpression.Variable.Type is not NullableTypeSymbol nullable)
            {
                continue;
            }

            var narrowThen = returnValue != negate;
            var frame = narrowThen ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>()) : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
            frame[variableExpression.Variable] = nullable.UnderlyingType;
        }

        return (thenFrame, elseFrame);
    }

    private static (Dictionary<VariableSymbol, TypeSymbol> Then, Dictionary<VariableSymbol, TypeSymbol> Else) ClassifyUserBoolCallNarrowing(BoundCallExpression call, bool negate)
    {
        // Issue #178 / ADR-0047 §6: a user-declared function may carry the
        // same [NotNullWhen] / [MaybeNullWhen] postconditions C# uses.
        // Recognition is type-identity based via KnownAttributes so renaming
        // or shadowing the source name cannot bypass the narrowing rule.
        var parameters = call.Function.Parameters;
        Dictionary<VariableSymbol, TypeSymbol> thenFrame = null;
        Dictionary<VariableSymbol, TypeSymbol> elseFrame = null;
        var count = Math.Min(parameters.Length, call.Arguments.Length);
        for (var i = 0; i < count; i++)
        {
            var parameter = parameters[i];
            var attributes = parameter.Attributes;
            if (attributes.IsDefaultOrEmpty)
            {
                continue;
            }

            var notNullWhenReturnValue = (bool?)null;
            var maybeNullWhenReturnValue = (bool?)null;
            foreach (var attribute in attributes)
            {
                if (KnownAttributes.TryGetNotNullWhenReturnValue(attribute, out var rv))
                {
                    notNullWhenReturnValue = rv;
                }
                else if (KnownAttributes.TryGetMaybeNullWhenReturnValue(attribute, out var mrv))
                {
                    maybeNullWhenReturnValue = mrv;
                }
            }

            var argExpr = call.Arguments[i];

            // [NotNullWhen(rv)]: narrow a nullable argument to its underlying
            // non-nullable type on the arm where the call returns rv.
            if (notNullWhenReturnValue is bool returnValue
                && argExpr is BoundVariableExpression narrowVarExpr
                && narrowVarExpr.Variable.Type is NullableTypeSymbol nullable)
            {
                var narrowThen = returnValue != negate;
                var frame = narrowThen
                    ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>())
                    : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
                frame[narrowVarExpr.Variable] = nullable.UnderlyingType;
            }

            // [MaybeNullWhen(rv)]: widen a non-nullable argument to its nullable
            // counterpart on the arm where the call returns rv.
            if (maybeNullWhenReturnValue is bool widenReturnValue
                && argExpr is BoundVariableExpression widenVarExpr
                && widenVarExpr.Variable.Type is not NullableTypeSymbol
                && widenVarExpr.Variable.Type != TypeSymbol.Null)
            {
                var widenThen = widenReturnValue != negate;
                var widenFrame = widenThen
                    ? (thenFrame ??= new Dictionary<VariableSymbol, TypeSymbol>())
                    : (elseFrame ??= new Dictionary<VariableSymbol, TypeSymbol>());
                widenFrame[widenVarExpr.Variable] = NullableTypeSymbol.Get(widenVarExpr.Variable.Type);
            }
        }

        return (thenFrame, elseFrame);
    }

    internal static bool IsNilLiteral(BoundExpression expr)
    {
        while (expr is BoundConversionExpression conversion)
        {
            expr = conversion.Expression;
        }

        return expr is BoundLiteralExpression lit && lit.Type == TypeSymbol.Null;
    }

    internal static Dictionary<VariableSymbol, TypeSymbol> TryClassifyPatternNarrowing(BoundExpression discriminant, BoundPattern pattern)
    {
        if (discriminant is not BoundVariableExpression variableExpression || pattern == null)
        {
            return null;
        }

        // ADR-0069 addendum / issue #712: only narrow non-mutable receivers
        // (locals, parameters, and read-only globals). Mutable globals could
        // be reassigned between the test and the use under aliasing or
        // another thread, mirroring ADR-0069's stability rule.
        if (!IsStableNarrowableVariable(variableExpression.Variable))
        {
            return null;
        }

        var variable = variableExpression.Variable;
        TypeSymbol narrowedType = null;
        switch (pattern)
        {
            case BoundTypePattern typePattern:
                narrowedType = typePattern.TargetType;
                break;
            case BoundConstantPattern constantPattern when variable.Type is NullableTypeSymbol nullable && !IsNilLiteral(constantPattern.Value):
                narrowedType = nullable.UnderlyingType;
                break;
            case BoundDiscardPattern:
                break;
            case BoundBinaryPattern binaryPattern when binaryPattern.IsConjunction:
                // Issue #992: `and` — both sub-patterns hold, so the union of
                // their narrowings is sound.
                {
                    var left = TryClassifyPatternNarrowing(discriminant, binaryPattern.Left);
                    var right = TryClassifyPatternNarrowing(discriminant, binaryPattern.Right);
                    return MergeNarrowingFrames(left, right);
                }

            case BoundBinaryPattern binaryPattern:
                // Issue #992: `or` — only narrowings proven by BOTH branches
                // (same variable, same type) survive. This keeps the smart-cast
                // sound: `x is Cat or x is Dog` narrows nothing.
                {
                    var left = TryClassifyPatternNarrowing(discriminant, binaryPattern.Left);
                    var right = TryClassifyPatternNarrowing(discriminant, binaryPattern.Right);
                    return IntersectNarrowingFrames(left, right);
                }

            case BoundNotPattern:
                // Issue #992: `not P` tells us P did NOT match, which carries no
                // positive narrowing.
                break;
            case BoundRelationalPattern:
            case BoundPropertyPattern:
            case BoundListPattern:
                // These patterns can imply non-nullness in some cases, but this
                // phase keeps narrowing to simple type and non-nil constant arms.
                break;
        }

        return narrowedType == null ? null : new Dictionary<VariableSymbol, TypeSymbol> { [variable] = narrowedType };
    }

    private BoundStatement BindStatementWithNarrowing(StatementSyntax syntax, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        if (frame == null)
        {
            return BindStatement(syntax);
        }

        binderCtx.NarrowedVariables.Add(frame);
        try
        {
            return BindStatement(syntax);
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    // Issue #991: bind a switch-arm `when` guard as a boolean expression under
    // the arm's pattern-narrowing frame. A non-bool guard surfaces the standard
    // conversion diagnostic.
    private BoundExpression BindGuardExpressionWithNarrowing(ExpressionSyntax syntax, Dictionary<VariableSymbol, TypeSymbol> frame)
    {
        if (frame == null)
        {
            return bindExpressionWithTargetType(syntax, TypeSymbol.Bool);
        }

        binderCtx.NarrowedVariables.Add(frame);
        try
        {
            return bindExpressionWithTargetType(syntax, TypeSymbol.Bool);
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    private BoundStatement BindMultiAssignmentStatement(MultiAssignmentStatementSyntax syntax)
    {
        var targets = syntax.Targets.ToImmutableArray();
        var values = syntax.Values.ToImmutableArray();

        if (targets.Length != values.Length)
        {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, values.Length);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var isShortDecl = syntax.OperatorToken.Kind == SyntaxKind.ColonEqualsToken;

        if (isShortDecl)
        {
            for (var i = 0; i < targets.Length; i++)
            {
                var nameExpr = (NameExpressionSyntax)targets[i];
                var initializer = bindExpression(values[i]);
                var variable = bindLocalVariable(nameExpr.IdentifierToken, isReadOnly: false, type: initializer.Type);
                statements.Add(new BoundVariableDeclaration(syntax, variable, initializer));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        // Plain assignment: evaluate every RHS into a fresh temp, then assign each temp to its target.
        // This is the semantics Go specifies for `a, b = b, a` and friends.
        var temps = ImmutableArray.CreateBuilder<VariableSymbol>(targets.Length);
        var basePos = syntax.OperatorToken.Position;
        for (var i = 0; i < values.Length; i++)
        {
            var initializer = bindExpression(values[i]);
            var tempName = $"<>m_{basePos}_{i}";
            var temp = function == null
                ? (VariableSymbol)new GlobalVariableSymbol(tempName, isReadOnly: true, initializer.Type)
                : new LocalVariableSymbol(tempName, isReadOnly: true, initializer.Type);
            scope.TryDeclareVariable(temp);
            temps.Add(temp);
            statements.Add(new BoundVariableDeclaration(syntax, temp, initializer));
        }

        for (var i = 0; i < targets.Length; i++)
        {
            var nameExpr = (NameExpressionSyntax)targets[i];
            var name = nameExpr.IdentifierToken.Text;
            var variable = bindVariableReference(name, nameExpr.IdentifierToken.Location);
            if (variable == null)
            {
                continue;
            }

            if (variable.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            var tempRef = new BoundVariableExpression(null, temps[i]);
            var converted = conversions.BindConversion(values[i].Location, tempRef, variable.Type);
            statements.Add(new BoundExpressionStatement(syntax, new BoundAssignmentExpression(null, variable, converted)));
        }

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private BoundStatement BindSwitchStatement(SwitchStatementSyntax syntax)
    {
        var discriminant = bindExpression(syntax.Expression);
        var switchType = discriminant.Type;
        if (switchType == TypeSymbol.Error)
        {
            return BindErrorStatement();
        }

        var arms = ImmutableArray.CreateBuilder<BoundPatternSwitchArm>(syntax.Cases.Length);
        var hasDefault = false;

        // ADR-0069 addendum / issue #712: track each non-exiting arm's
        // discriminator narrowing so we can lift a common post-switch
        // narrowing into the enclosing block when every fall-through arm
        // contributes the same `{discriminator → T}` mapping. Arms that
        // end in an unconditional exit (return/throw/break/continue) do
        // not contribute to the merge — they remove themselves from the
        // post-switch dataflow.
        var hasAnyFallThroughArm = false;
        Dictionary<VariableSymbol, TypeSymbol> mergedExitFrame = null;
        var mergeFailed = false;

        foreach (var caseSyntax in syntax.Cases)
        {
            if (caseSyntax.IsDefault)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(caseSyntax.Keyword.Location);
                }

                hasDefault = true;
                var defaultBody = BindBlockStatement(caseSyntax.Body);
                arms.Add(new BoundPatternSwitchArm(null, pattern: null, guard: null, defaultBody));

                if (!EndsInUnconditionalExit(defaultBody))
                {
                    // A default arm that falls through carries no narrowing
                    // on the discriminator (we can't observe any specific
                    // type), so it defeats the merge unconditionally.
                    hasAnyFallThroughArm = true;
                    mergeFailed = true;
                }

                continue;
            }

            scope = new BoundScope(scope);
            var pattern = patterns.BindPattern(caseSyntax.Value, switchType);

            // Issue #991: a guarded arm (`when <bool>`) can always fail at
            // runtime, so a guarded discard `case _ when …` does NOT act as a
            // default/total arm.
            var hasGuard = caseSyntax.Guard != null;
            if (pattern is BoundDiscardPattern && !hasGuard)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(caseSyntax.Value.Location);
                }

                hasDefault = true;
            }

            var frame = TryClassifyPatternNarrowing(discriminant, pattern);
            BoundExpression guard = null;
            if (hasGuard)
            {
                guard = BindGuardExpressionWithNarrowing(caseSyntax.Guard, frame);
            }

            var body = BindStatementWithNarrowing(caseSyntax.Body, frame);
            scope = scope.Parent;
            arms.Add(new BoundPatternSwitchArm(null, pattern, guard, body));

            // Issue #991: a guarded arm may not actually run even when its
            // pattern matches, so it cannot contribute a reliable post-switch
            // narrowing. Conservatively defeat the narrowing merge.
            if (hasGuard)
            {
                mergeFailed = true;
            }

            if (mergeFailed)
            {
                continue;
            }

            if (EndsInUnconditionalExit(body))
            {
                continue;
            }

            hasAnyFallThroughArm = true;

            if (frame == null || frame.Count == 0)
            {
                // Fall-through arm with no narrowing — nothing to lift.
                mergeFailed = true;
                continue;
            }

            if (mergedExitFrame == null)
            {
                mergedExitFrame = new Dictionary<VariableSymbol, TypeSymbol>(frame);
                continue;
            }

            // Intersect with the running merge. Only variables narrowed to
            // the same type by every fall-through arm survive.
            var next = new Dictionary<VariableSymbol, TypeSymbol>();
            foreach (var kv in frame)
            {
                if (mergedExitFrame.TryGetValue(kv.Key, out var existing) && existing == kv.Value)
                {
                    next[kv.Key] = kv.Value;
                }
            }

            if (next.Count == 0)
            {
                mergeFailed = true;
                mergedExitFrame = null;
            }
            else
            {
                mergedExitFrame = next;
            }
        }

        var boundArms = arms.ToImmutable();
        ExhaustivenessAnalyzer.AnalyzeSwitchStatement(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            scope.GetDeclaredStructs(),
            Diagnostics);

        var result = new BoundPatternSwitchStatement(null, discriminant, boundArms);

        // ADR-0069 addendum / issue #712: park the merged narrowing on the
        // bound switch so the enclosing block walker can lift it. Only do
        // so when at least one arm fell through (otherwise the switch
        // itself unconditionally exits and the post-switch dataflow is
        // unreachable). Also require the switch to be exhaustive — if a
        // non-matching value escapes the switch without entering any arm,
        // the discriminator's type is unchanged and we must not narrow.
        if (!mergeFailed && hasAnyFallThroughArm && mergedExitFrame != null && mergedExitFrame.Count > 0
            && SwitchHandlesAllValues(boundArms, switchType))
        {
            binderCtx.PendingSwitchExitFrames[result] = mergedExitFrame;
        }

        return result;
    }

    /// <summary>
    /// ADR-0069 addendum / issue #712: a switch is "exhaustive enough" for
    /// post-switch narrowing when it has a default arm OR its declared
    /// arm set covers every input the discriminator can take. We
    /// conservatively require either a default/discard arm — anything
    /// else is treated as non-exhaustive and we skip the lift. The
    /// exhaustiveness analyzer already reports a separate diagnostic for
    /// truly-non-exhaustive switches; this check only guards the
    /// narrowing lift.
    /// </summary>
    private static bool SwitchHandlesAllValues(ImmutableArray<BoundPatternSwitchArm> arms, TypeSymbol discriminantType)
    {
        foreach (var arm in arms)
        {
            if ((arm.Pattern == null || arm.Pattern is BoundDiscardPattern) && arm.Guard == null)
            {
                return true;
            }
        }

        // No default — we cannot prove the post-switch frame is safe.
        return false;
    }

    private BoundStatement BindTryStatement(TryStatementSyntax syntax)
    {
        var tryBlock = BindBlockStatement(syntax.TryBlock);

        var exceptionType = ResolveExceptionType();
        if (exceptionType == null)
        {
            Diagnostics.ReportUndefinedType(syntax.TryKeyword.Location, "System.Exception");
            return BindErrorStatement();
        }

        var catches = ImmutableArray.CreateBuilder<BoundCatchClause>();
        foreach (var catchSyntax in syntax.CatchClauses)
        {
            var catchType = exceptionType;
            if (catchSyntax.TypeClause != null)
            {
                var declared = bindTypeClause(catchSyntax.TypeClause);
                if (declared != null)
                {
                    catchType = declared;
                }
            }

            scope = new BoundScope(scope);
            var variable = bindLocalVariable(catchSyntax.Identifier, isReadOnly: true, type: catchType);
            var body = BindBlockStatement(catchSyntax.Body);
            scope = scope.Parent;

            catches.Add(new BoundCatchClause(catchType, variable, body));
        }

        BoundStatement finallyBlock = null;
        if (syntax.FinallyClause != null)
        {
            finallyBlock = BindBlockStatement(syntax.FinallyClause.Body);
        }

        if (catches.Count == 0 && finallyBlock == null)
        {
            Diagnostics.ReportTryWithoutCatchOrFinally(syntax.TryKeyword.Location);
            return BindErrorStatement();
        }

        // Issue #836: a `yield` lexically inside a `try` block that also
        // has any `catch` clause is rejected (C# §15.14 / ECMA-335). The
        // iterator state machine cannot safely resume into a protected
        // region from a synthesized dispatch when that region also acts
        // as a CLR exception handler frame. Pure `try`/`finally` around
        // `yield` is supported and lowered by IteratorMoveNextBodyBuilder.
        if (catches.Count > 0
            && function != null
            && isIteratorReturnType(function.Type)
            && YieldFinder.ContainsYieldInOwnTryBlock(tryBlock))
        {
            foreach (var yieldLocation in YieldFinder.GetYieldLocationsInOwnTryBlock(tryBlock))
            {
                Diagnostics.ReportYieldInsideTryWithCatch(yieldLocation);
            }
        }

        return new BoundTryStatement(syntax, tryBlock, catches.ToImmutable(), finallyBlock);
    }

    /// <summary>
    /// Walker that locates <c>yield</c> statements lexically inside a
    /// bound block, but does not descend into nested function bodies
    /// (lambdas / local functions). Issue #836.
    /// </summary>
    private sealed class YieldFinder : BoundTreeWalker
    {
        private readonly List<TextLocation> locations = new List<TextLocation>();

        public static bool ContainsYieldInOwnTryBlock(BoundStatement tryBlock)
        {
            var walker = new YieldFinder();
            walker.VisitStatement(tryBlock);
            return walker.locations.Count > 0;
        }

        public static IReadOnlyList<TextLocation> GetYieldLocationsInOwnTryBlock(BoundStatement tryBlock)
        {
            var walker = new YieldFinder();
            walker.VisitStatement(tryBlock);
            return walker.locations;
        }

        protected override void VisitYieldStatement(BoundYieldStatement node)
        {
            // Prefer the `yield` keyword's location; fall back to the
            // full statement syntax location if available.
            if (node.Syntax is YieldStatementSyntax yieldSyntax)
            {
                this.locations.Add(yieldSyntax.YieldKeyword.Location);
            }
            else if (node.Syntax != null)
            {
                this.locations.Add(node.Syntax.Location);
            }
        }
    }

    private BoundStatement BindThrowStatement(ThrowStatementSyntax syntax)
    {
        var expression = bindExpression(syntax.Expression);
        var exceptionType = ResolveExceptionType();
        if (exceptionType != null && expression.Type != TypeSymbol.Error)
        {
            var argClr = expression.Type?.ClrType;

            // Issue #319: a GSharp class that inherits an imported CLR Exception
            // type has no concrete ClrType until emit time, but its
            // ImportedBaseType (walked transitively) is what determines
            // assignability to System.Exception.
            if (argClr == null && expression.Type is StructSymbol throwStruct)
            {
                for (var t = throwStruct; t != null; t = t.BaseClass)
                {
                    if (t.ImportedBaseType?.ClrType is System.Type clrBase)
                    {
                        argClr = clrBase;
                        break;
                    }
                }
            }

            if (argClr == null || !ClrTypeUtilities.IsAssignableByName(exceptionType.ClrType, argClr))
            {
                Diagnostics.ReportCannotConvert(syntax.Expression.Location, expression.Type ?? TypeSymbol.Error, exceptionType);
                return BindErrorStatement();
            }
        }

        return new BoundThrowStatement(syntax, expression);
    }

    private BoundStatement BindUsingStatement(UsingStatementSyntax syntax)
    {
        var usingLowering = BindUsingStatementInBlock(syntax);
        if (usingLowering.Cleanup == null)
        {
            return usingLowering.ErrorStatement;
        }

        var tryStmt = BuildCleanupTryStatement(ImmutableArray<BoundStatement>.Empty, usingLowering.Cleanup);
        return new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(usingLowering.Declaration, tryStmt));
    }

    private (BoundVariableDeclaration Declaration, BoundExpression Cleanup, BoundStatement ErrorStatement) BindUsingStatementInBlock(UsingStatementSyntax syntax)
    {
        var declaration = (BoundVariableDeclaration)BindVariableDeclaration(syntax.Declaration);
        var disposeCall = conversions.TryBuildDisposeCall(declaration.Variable, syntax.UsingKeyword.Location);
        if (disposeCall == null)
        {
            return (declaration, null, BindErrorStatement());
        }

        return (declaration, disposeCall, null);
    }

    private BoundStatement BindAwaitUsingStatement(AwaitUsingStatementSyntax syntax)
    {
        var awaitUsingLowering = BindAwaitUsingStatementInBlock(syntax);
        if (awaitUsingLowering.Cleanup == null)
        {
            return awaitUsingLowering.ErrorStatement;
        }

        var tryStmt = BuildCleanupTryStatement(ImmutableArray<BoundStatement>.Empty, awaitUsingLowering.Cleanup);
        return new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(awaitUsingLowering.Declaration, tryStmt));
    }

    private (BoundVariableDeclaration Declaration, BoundExpression Cleanup, BoundStatement ErrorStatement) BindAwaitUsingStatementInBlock(AwaitUsingStatementSyntax syntax)
    {
        // Gate: await using let requires an async context.
        if (function == null || !function.IsAsync)
        {
            Diagnostics.ReportAwaitUsingOutsideAsyncFunction(syntax.AwaitKeyword.Location);
            return (null, null, BindErrorStatement());
        }

        var declaration = (BoundVariableDeclaration)BindVariableDeclaration(syntax.Declaration);
        var disposeAsyncCall = conversions.TryBuildDisposeAsyncCall(declaration.Variable, syntax.AwaitKeyword.Location);
        if (disposeAsyncCall == null)
        {
            return (declaration, null, BindErrorStatement());
        }

        return (declaration, disposeAsyncCall, null);
    }

    private BoundStatement BindDeferStatement(DeferStatementSyntax syntax)
    {
        var defer = BindDeferStatementInBlock(syntax);
        if (defer.Cleanup == null)
        {
            return defer.ErrorStatement;
        }

        var tryStmt = BuildCleanupTryStatement(ImmutableArray<BoundStatement>.Empty, defer.Cleanup);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.AddRange(defer.PrefixStatements);
        statements.Add(tryStmt);
        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private (ImmutableArray<BoundStatement> PrefixStatements, BoundExpression Cleanup, BoundStatement ErrorStatement) BindDeferStatementInBlock(DeferStatementSyntax syntax)
    {
        var expression = bindExpression(syntax.Expression, canBeVoid: true);
        if (expression is BoundErrorExpression)
        {
            return (ImmutableArray<BoundStatement>.Empty, null, new BoundExpressionStatement(null, expression));
        }

        if (!IsDeferableCall(expression))
        {
            Diagnostics.ReportDeferOperandIsNotACall(syntax.Expression.Location);
            return (ImmutableArray<BoundStatement>.Empty, null, new BoundExpressionStatement(null, new BoundErrorExpression(null)));
        }

        var prefix = ImmutableArray.CreateBuilder<BoundStatement>();
        var capturedCall = CaptureDeferArguments(expression, prefix);
        return (prefix.ToImmutable(), capturedCall, null);
    }

    private static bool IsDeferableCall(BoundExpression expression)
        => expression is BoundCallExpression or
            BoundIndirectCallExpression or
            BoundUserInstanceCallExpression or
            BoundImportedCallExpression or
            BoundImportedInstanceCallExpression;
    private BoundExpression CaptureDeferArguments(BoundExpression expression, ImmutableArray<BoundStatement>.Builder prefix)
    {
        switch (expression)
        {
            case BoundCallExpression call:
                return new BoundCallExpression(null, call.Function, CaptureArguments(call.Arguments, prefix), call.ReturnType);
            case BoundIndirectCallExpression call:
                return new BoundIndirectCallExpression(null, call.Target, call.FunctionType, CaptureArguments(call.Arguments, prefix));
            case BoundUserInstanceCallExpression call:
                return new BoundUserInstanceCallExpression(null, call.Receiver, call.Method, CaptureArguments(call.Arguments, prefix), call.Type);
            case BoundImportedCallExpression call:
                return new BoundImportedCallExpression(null, call.Function, CaptureArguments(call.Arguments, prefix));
            case BoundImportedInstanceCallExpression call:
                return new BoundImportedInstanceCallExpression(null, call.Receiver, call.Method, call.Type, CaptureArguments(call.Arguments, prefix));
            default:
                throw new InvalidOperationException($"Unexpected deferred expression: {expression.Kind}");
        }
    }

    private ImmutableArray<BoundExpression> CaptureArguments(ImmutableArray<BoundExpression> arguments, ImmutableArray<BoundStatement>.Builder prefix)
    {
        if (arguments.IsEmpty)
        {
            return arguments;
        }

        var capturedArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        foreach (var argument in arguments)
        {
            var variable = new LocalVariableSymbol($"$defer$arg${binderCtx.DeferArgumentCounter++}", isReadOnly: true, argument.Type ?? TypeSymbol.Error);
            scope.TryDeclareVariable(variable);
            prefix.Add(new BoundVariableDeclaration(null, variable, argument));
            capturedArguments.Add(new BoundVariableExpression(null, variable));
        }

        return capturedArguments.ToImmutable();
    }

    private BoundStatement BindGoStatement(GoStatementSyntax syntax)
    {
        // ADR-0082 / issue #722: gate the `go expr` statement on
        // `import Gsharp.Extensions.Go`. Report GS0316 if the import is
        // missing, then continue binding so downstream diagnostics about
        // the operand's call-shape still surface.
        binderCtx.ReportIfGoExtensionsImportMissing(syntax, syntax.GoKeyword.Location, "go");

        var expression = bindExpression(syntax.Expression);

        if (expression is BoundErrorExpression)
        {
            return new BoundExpressionStatement(syntax, expression);
        }

        if (expression is not BoundCallExpression and
            not BoundIndirectCallExpression and
            not BoundUserInstanceCallExpression and
            not BoundImportedCallExpression and
            not BoundImportedInstanceCallExpression)
        {
            Diagnostics.ReportGoOperandIsNotACall(syntax.Expression.Location);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        return new BoundGoStatement(syntax, expression);
    }

    private BoundStatement BindChannelSendStatement(ChannelSendStatementSyntax syntax)
    {
        // Phase 5.5 / ADR-0022: `ch <- v` send statement.
        // ADR-0082 / issue #722: gate on `import Gsharp.Extensions.Go`.
        binderCtx.ReportIfGoExtensionsImportMissing(syntax, syntax.LeftArrowToken.Location, "<- (send)");

        var channel = bindExpression(syntax.Channel);
        if (channel is BoundErrorExpression)
        {
            return new BoundExpressionStatement(syntax, channel);
        }

        if (channel.Type is not ChannelTypeSymbol chan)
        {
            Diagnostics.ReportSendTargetIsNotChannel(syntax.Channel.Location, channel.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var value = conversions.BindConversion(syntax.Value, chan.ElementType);
        return new BoundChannelSendStatement(syntax, channel, value);
    }

    private BoundStatement BindSelectStatement(SelectStatementSyntax syntax)
    {
        // Phase 5.6 / ADR-0022: select statement orchestrating channel ops.
        // ADR-0082 / issue #722: gate on `import Gsharp.Extensions.Go`.
        binderCtx.ReportIfGoExtensionsImportMissing(syntax, syntax.SelectKeyword.Location, "select");

        if (syntax.Cases.Length == 0)
        {
            Diagnostics.ReportSelectWithNoCases(syntax.SelectKeyword.Location);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var bound = ImmutableArray.CreateBuilder<BoundSelectCase>();
        var sawDefault = false;
        foreach (var caseSyntax in syntax.Cases)
        {
            if (caseSyntax.CaseKind == SelectCaseKind.Default)
            {
                if (sawDefault)
                {
                    Diagnostics.ReportSelectDuplicateDefault(caseSyntax.Keyword.Location);
                }

                sawDefault = true;
                var defaultBody = BindStatement(caseSyntax.Body);
                bound.Add(new BoundSelectCase(SelectCaseKind.Default, channel: null, value: null, variable: null, defaultBody));
                continue;
            }

            // All non-default arms reference a channel.
            var channelExpr = bindExpression(caseSyntax.Channel);
            ChannelTypeSymbol chan = channelExpr.Type as ChannelTypeSymbol;
            if (channelExpr is BoundErrorExpression || chan == null)
            {
                if (chan == null && channelExpr is not BoundErrorExpression)
                {
                    if (caseSyntax.CaseKind == SelectCaseKind.Send)
                    {
                        Diagnostics.ReportSendTargetIsNotChannel(caseSyntax.Channel.Location, channelExpr.Type);
                    }
                    else
                    {
                        Diagnostics.ReportReceiveOperandIsNotChannel(caseSyntax.Channel.Location, channelExpr.Type);
                    }
                }

                // Best-effort recover: bind the body anyway so further
                // diagnostics surface.
                var recoveredBody = BindStatement(caseSyntax.Body);
                bound.Add(new BoundSelectCase(caseSyntax.CaseKind, channelExpr, value: null, variable: null, recoveredBody));
                continue;
            }

            BoundExpression valueExpr = null;
            VariableSymbol variable = null;
            BoundStatement body;

            if (caseSyntax.CaseKind == SelectCaseKind.Send)
            {
                valueExpr = conversions.BindConversion(caseSyntax.Value, chan.ElementType);
                body = BindStatement(caseSyntax.Body);
            }
            else if (caseSyntax.CaseKind == SelectCaseKind.ReceiveBind)
            {
                // Introduce a scope so the bound variable is visible only inside
                // the case body — matches `for v := range` lexical hygiene.
                scope = new BoundScope(scope);
                variable = new LocalVariableSymbol(caseSyntax.Identifier.Text, isReadOnly: true, chan.ElementType, declaringSyntax: caseSyntax.Identifier);
                if (!scope.TryDeclareVariable(variable))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(caseSyntax.Identifier.Location, caseSyntax.Identifier.Text);
                }

                body = BindStatement(caseSyntax.Body);
                scope = scope.Parent;
            }
            else
            {
                // ReceiveDiscard
                body = BindStatement(caseSyntax.Body);
            }

            bound.Add(new BoundSelectCase(caseSyntax.CaseKind, channelExpr, valueExpr, variable, body));
        }

        return new BoundSelectStatement(syntax, bound.ToImmutable());
    }

    private BoundStatement BindScopeStatement(ScopeStatementSyntax syntax)
    {
        // Phase 5.7 / ADR-0022: structured concurrency. The body's `go`
        // statements register with the scope at evaluation time; the binder
        // itself just wraps the body. Open a fresh lexical scope so any
        // future implicit binding (e.g. `ctx`) can be introduced without
        // leaking into the enclosing function.
        scope = new BoundScope(scope);
        var body = BindStatement(syntax.Body);
        scope = scope.Parent;
        return new BoundScopeStatement(syntax, body);
    }

    // ADR-0125 / issue #1026: binds a `fixed name *T = source { … }` pinning
    // statement. Pins a managed array (`[]T` → `&a[0]`) or string (→ char-data
    // pointer) for the duration of the block and binds an unmanaged pointer
    // `*T` into element 0. The pointer is a CLR pinned local at emit time.
    private BoundStatement BindFixedStatement(FixedStatementSyntax syntax)
    {
        // A `fixed` statement yields a raw unmanaged pointer, so it is legal
        // only inside an `unsafe` context — consistent with ADR-0122's gating
        // (outside `unsafe`, `*T` would denote a *managed* by-ref, not a
        // pinnable pointer). Reject up front with GS0400.
        if (!binderCtx.InUnsafeContext)
        {
            Diagnostics.ReportFixedRequiresUnsafeContext(syntax.FixedKeyword.Location);
        }

        // Open a fresh lexical scope: the pointer binding (and any inner
        // declarations) live only for the duration of the pinned block.
        scope = new BoundScope(scope);
        try
        {
            var pointerType = bindTypeClause(syntax.TypeClause);
            var source = bindExpression(syntax.PinnedSource);

            FixedPinKind pinKind;
            TypeSymbol elementType;
            TypeSymbol pinnedUnderlying;
            if (source.Type is SliceTypeSymbol sliceType)
            {
                // Slice-pin form (`[]T`, the cs2gs mapping of C# `T[]`): the
                // CLR backing is a single-dimensional array `T[]`, so we pin
                // the array reference (`T[] pinned`) and derive `&a[0]` via
                // `ldelema` — exactly as C# does for `fixed (T* p = arr)`.
                pinKind = FixedPinKind.Array;
                elementType = sliceType.ElementType;
                pinnedUnderlying = sliceType;
            }
            else if (source.Type is ArrayTypeSymbol arrayType)
            {
                // Fixed-size array form (`[N]T`), also CLR-backed by `T[]`.
                pinKind = FixedPinKind.Array;
                elementType = arrayType.ElementType;
                pinnedUnderlying = arrayType;
            }
            else if (source.Type == TypeSymbol.String)
            {
                // String-pin form: pin the `string` reference itself
                // (`string pinned`) and derive the char-data pointer via
                // `RuntimeHelpers.OffsetToStringData` (the classic lowering),
                // which avoids a `modreq`-bearing `GetPinnableReference` ref.
                pinKind = FixedPinKind.String;
                elementType = TypeSymbol.Char;
                pinnedUnderlying = TypeSymbol.String;
            }
            else
            {
                Diagnostics.ReportFixedSourceNotPinnable(
                    syntax.PinnedSource.Location, source.Type?.Name ?? "?");

                var errorPointerType = pointerType is PointerTypeSymbol
                    ? pointerType
                    : PointerTypeSymbol.Get(TypeSymbol.UInt8);
                var errorPointer = bindLocalVariable(syntax.Identifier, isReadOnly: true, errorPointerType);
                var errorBody = BindStatement(syntax.Body);
                return new BoundFixedStatement(
                    syntax,
                    FixedPinKind.Array,
                    new LocalVariableSymbol("$pin$error", isReadOnly: false, TypeSymbol.Error),
                    errorPointer,
                    source,
                    errorBody);
            }

            // The declared pointer's pointee must match the buffer's element
            // type. `char`/`uint16` are interchangeable for the string form
            // (both are 16-bit), matching C#'s `char*`. On mismatch, fall back
            // to the buffer's element type and report it as not pinnable.
            var resolvedElementType = elementType;
            if (pointerType is PointerTypeSymbol declaredPtr && declaredPtr.PointeeType?.ClrType != null)
            {
                var declaredPointee = declaredPtr.PointeeType;
                var matches = elementType.ClrType != null
                    && (declaredPointee.ClrType.IsSameAs(elementType.ClrType)
                        || (pinKind == FixedPinKind.String && declaredPointee.ClrType.IsSameAs(typeof(ushort))));
                if (matches)
                {
                    resolvedElementType = declaredPointee;
                }
                else
                {
                    Diagnostics.ReportFixedSourceNotPinnable(
                        syntax.PinnedSource.Location, source.Type?.Name ?? "?");
                }
            }

            var pointerVariable = bindLocalVariable(
                syntax.Identifier, isReadOnly: true, PointerTypeSymbol.Get(resolvedElementType));

            // Synthetic pinned local — wrapped in a PinnedTypeSymbol so the
            // emitter sets the `pinned` flag on its local-signature slot.
            var pinnedVariable = new LocalVariableSymbol(
                $"$pin${pointerVariable.Name}", isReadOnly: false, new PinnedTypeSymbol(pinnedUnderlying));

            var body = BindStatement(syntax.Body);

            return new BoundFixedStatement(syntax, pinKind, pinnedVariable, pointerVariable, source, body);
        }
        finally
        {
            scope = scope.Parent;
        }
    }

    private BoundStatement BindAwaitForRangeStatement(AwaitForRangeStatementSyntax syntax)
    {
        return BindAwaitForRangeStatementCore(syntax, labelName: null, originatingSyntax: syntax);
    }

    private BoundStatement BindAwaitForRangeStatementCore(AwaitForRangeStatementSyntax syntax, string labelName, SyntaxNode originatingSyntax)
    {
        // Phase 5.8 / ADR-0023: `await for v := range stream { … }`.
        // The stream operand must be an `IAsyncEnumerable[T]` (a CLR type
        // that exposes a `GetAsyncEnumerator` method). The value variable
        // is typed as the stream's element `T`. Issue #937: the loop body
        // is bound through BindLoopBody so that `break`, `continue`, and
        // labeled break/continue resolve to the loop's synthesized labels —
        // achieving parity with the synchronous `for … in` loop.
        var stream = bindExpression(syntax.Stream);
        if (stream is BoundErrorExpression)
        {
            return new BoundExpressionStatement(syntax, stream);
        }

        if (!MemberLookup.TryGetAsyncEnumerableElementType(stream.Type, out var elementType))
        {
            Diagnostics.ReportTypeIsNotAsyncEnumerable(syntax.Stream.Location, stream.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        scope = new BoundScope(scope);
        var variable = bindLocalVariable(syntax.Identifier, isReadOnly: false, type: elementType);
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);
        scope = scope.Parent;

        return new BoundAwaitForRangeStatement(originatingSyntax, variable, stream, body, breakLabel, continueLabel);
    }

    private BoundStatement BindYieldStatement(YieldStatementSyntax syntax)
    {
        // ADR-0040: `yield <expr>` — only valid in an iterator function.
        if (function == null || !isIteratorReturnType(function.Type))
        {
            Diagnostics.ReportYieldOutsideIteratorFunction(syntax.YieldKeyword.Location);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var elementType = GetIteratorElementType(function.Type);
        var expression = bindExpression(syntax.Expression);
        if (expression.Type != null && elementType != null && expression.Type != elementType)
        {
            expression = conversions.BindConversion(syntax.Expression.Location, expression, elementType);
        }

        return new BoundYieldStatement(syntax, expression);
    }

    private static TypeSymbol GetIteratorElementType(TypeSymbol type)
    {
        if (type is SequenceTypeSymbol seq)
        {
            return seq.ElementType;
        }

        // Issue #798: `async sequence[T]` (ADR-0041) is AsyncSequenceTypeSymbol;
        // surface its ElementType the same way SequenceTypeSymbol does so
        // `yield` accepts the symbolic T rather than collapsing to `object`
        // through the type-erased ClrType.
        if (type is AsyncSequenceTypeSymbol aseq)
        {
            return aseq.ElementType;
        }

        // #313 / issue #798: when the iterator return type is an
        // `ImportedTypeSymbol` constructed over symbolic type arguments
        // (e.g. `IEnumerable[T]` / `IAsyncEnumerable[T]` inside a generic
        // function), prefer the symbolic TypeArguments[0] over the
        // type-erased ClrType form (`IEnumerable<object>`). Otherwise the
        // element type collapses to `object`, and `yield v` where `v: T`
        // fails to bind because the binder doesn't accept the implicit
        // `T → object` conversion ("Cannot convert type 'T' to 'object'").
        if (type is ImportedTypeSymbol importedSym
            && importedSym.OpenDefinition != null
            && !importedSym.TypeArguments.IsDefaultOrEmpty)
        {
            var def = importedSym.OpenDefinition;
            if (def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IEnumerator`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
            {
                return importedSym.TypeArguments[0];
            }
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return TypeSymbol.FromClrType(typeof(object));
        }

        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var def = clr.GetGenericTypeDefinition();
            if (def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IEnumerator`1")
            {
                return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
            }

            // Async iterators: IAsyncEnumerable<T> / IAsyncEnumerator<T>
            if (def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
            {
                return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
            }
        }

        return TypeSymbol.FromClrType(typeof(object));
    }

    private TypeSymbol ResolveExceptionType()
    {
        if (scope.References.TryResolveType("System.Exception", out var t))
        {
            return TypeSymbol.FromClrType(t);
        }

        return null;
    }

    private BoundStatement BindForInfiniteStatement(ForInfiniteStatementSyntax syntax)
    {
        return BindForInfiniteStatementCore(syntax, syntax.Body, labelName: null);
    }

    /// <summary>
    /// Binds a <c>for { body }</c> infinite loop, with optional ADR-0070 label.
    /// </summary>
    /// <param name="originatingSyntax">Originating syntax for diagnostics.</param>
    /// <param name="bodySyntax">The loop body.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <returns>The bound for-infinite statement.</returns>
    private BoundStatement BindForInfiniteStatementCore(SyntaxNode originatingSyntax, StatementSyntax bodySyntax, string labelName)
    {
        scope = new BoundScope(scope);

        var body = BindLoopBody(bodySyntax, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForInfiniteStatement(null, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForEllipsisStatement(ForEllipsisStatementSyntax syntax)
    {
        return BindForEllipsisStatementCore(syntax, syntax, labelName: null);
    }

    private BoundStatement BindForEllipsisStatementCore(ForEllipsisStatementSyntax syntax, SyntaxNode originatingSyntax, string labelName)
    {
        var lowerBound = bindExpressionWithTargetType(syntax.LowerBound, TypeSymbol.Int32);
        var upperBound = bindExpressionWithTargetType(syntax.UpperBound, TypeSymbol.Int32);

        scope = new BoundScope(scope);

        var variable = bindLocalVariable(syntax.Identifier, isReadOnly: false, type: TypeSymbol.Int32);
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForEllipsisStatement(null, variable, lowerBound, upperBound, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForRangeStatement(ForRangeStatementSyntax syntax)
    {
        return BindForRangeStatementCore(syntax, labelName: null, originatingSyntax: syntax);
    }

    /// <summary>
    /// Core for-range binder; accepts an optional ADR-0070 label name that is
    /// pushed onto the loop stack so a nested <c>break label</c> / <c>continue
    /// label</c> resolves to this loop's targets.
    /// </summary>
    /// <param name="syntax">The for-range syntax.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <param name="originatingSyntax">Syntax node used for the resulting bound node.</param>
    /// <returns>The bound for-range statement.</returns>
    private BoundStatement BindForRangeStatementCore(ForRangeStatementSyntax syntax, string labelName, SyntaxNode originatingSyntax)
    {
        var collection = bindExpression(syntax.Collection);

        // Decide iteration strategy and element/key types based on the
        // collection type.
        ForRangeKind iterationKind;
        TypeSymbol keyType;
        TypeSymbol valueType;
        switch (collection.Type)
        {
            case ArrayTypeSymbol arr:
                iterationKind = ForRangeKind.Indexed;
                keyType = TypeSymbol.Int32;
                valueType = arr.ElementType;
                break;
            case SliceTypeSymbol slice:
                iterationKind = ForRangeKind.Indexed;
                keyType = TypeSymbol.Int32;
                valueType = slice.ElementType;
                break;

            // Issue #209: NullabilityAnnotatedTypeSymbol carries inner-position nullable
            // flags; extract element/key/value types using those flags so that
            // `for k, v := range dict` sees the proper nullable types.
            case NullabilityAnnotatedTypeSymbol annotated when annotated.ClrType != null:
                // Issue #520: CLR SZ arrays (`T[]`) implement IEnumerable<T> via
                // runtime magic but `Array.GetEnumerator()` returns the non-generic
                // IEnumerator whose Current is System.Object. Routing them through
                // the Enumerable path would assign a boxed reference into the
                // value-typed loop variable (the pointer's low 32 bits surface as
                // garbage). Use the Indexed path instead so we emit `ldelem <T>`
                // with the array's actual element type — same lowering C#'s
                // `foreach (T x in arr)` produces.
                if (annotated.ClrType.IsArray && annotated.ClrType.GetArrayRank() == 1)
                {
                    iterationKind = ForRangeKind.Indexed;
                    keyType = TypeSymbol.Int32;
                    valueType = annotated.GetTypeArgumentSymbolForClrType(annotated.ClrType.GetElementType());
                }
                else if (MemberLookup.TryGetClrDictionaryTypes(annotated.ClrType, out var aDKey, out var aDVal))
                {
                    iterationKind = ForRangeKind.Dictionary;
                    keyType = annotated.GetTypeArgumentSymbolForClrType(aDKey);
                    valueType = annotated.GetTypeArgumentSymbolForClrType(aDVal);
                }
                else if (MemberLookup.TryGetClrEnumerableElementType(annotated.ClrType, out var aElemType))
                {
                    iterationKind = ForRangeKind.Enumerable;
                    keyType = TypeSymbol.Int32;
                    valueType = annotated.GetTypeArgumentSymbolForClrType(aElemType);
                }
                else if (MemberLookup.TryGetClrPatternEnumerableElementType(annotated.ClrType, out var aPatternElemType))
                {
                    iterationKind = ForRangeKind.PatternEnumerator;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(aPatternElemType);
                }
                else
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                    return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
                }

                break;

            // Issue #774: an open generic receiver such as `IEnumerable[T]`,
            // `Dictionary[K, V]`, or a user `MyList[T]` carries symbolic
            // type arguments on the ImportedTypeSymbol while its ClrType is
            // erased to the corresponding `<object>` shape. Probe the
            // OpenDefinition for the enumerable / dictionary shape and map
            // each open CLR type argument back to the symbolic argument so
            // the loop variable's type is the user's `T` (not `object`).
            //
            // Issue #939: this path must also fire when the symbolic type
            // argument is a *same-compilation* user `class`/`data struct`
            // (e.g. `List[Item]`). Such arguments are not type parameters, so
            // `HasTypeParameterArgument` is false, yet their CLR type is still
            // erased to `<object>` on the closed `ClrType`. Mirror the indexer
            // path's `MapErasedIndexerElementType` substitutability test so the
            // loop variable recovers the member-bearing user `Item` symbol
            // rather than the erased `object`.
            case ImportedTypeSymbol openImp when openImp.OpenDefinition != null && openImp.HasSubstitutableTypeArgument:
                if (MemberLookup.TryGetClrDictionaryTypes(openImp.OpenDefinition, out var openDKey, out var openDVal))
                {
                    iterationKind = ForRangeKind.Dictionary;
                    keyType = MapOpenClrTypeToSymbolic(openDKey, openImp);
                    valueType = MapOpenClrTypeToSymbolic(openDVal, openImp);
                }
                else if (MemberLookup.TryGetClrEnumerableElementType(openImp.OpenDefinition, out var openElemType))
                {
                    iterationKind = ForRangeKind.Enumerable;
                    keyType = TypeSymbol.Int32;
                    valueType = MapOpenClrTypeToSymbolic(openElemType, openImp);
                }
                else if (MemberLookup.TryGetClrPatternEnumerableElementType(openImp.OpenDefinition, out var openPatternElemType))
                {
                    iterationKind = ForRangeKind.PatternEnumerator;
                    keyType = TypeSymbol.Int32;
                    valueType = MapOpenClrTypeToSymbolic(openPatternElemType, openImp);
                }
                else
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                    return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
                }

                break;
            case ImportedTypeSymbol imp when imp.ClrType != null:
                // Issue #520: CLR SZ arrays (`T[]`) — see the matching note in the
                // NullabilityAnnotatedTypeSymbol branch above. Detect first and
                // route to the Indexed path so iteration emits `ldelem <T>`
                // (type-aware) rather than walking a boxing IEnumerator.
                if (imp.ClrType.IsArray && imp.ClrType.GetArrayRank() == 1)
                {
                    iterationKind = ForRangeKind.Indexed;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(imp.ClrType.GetElementType());
                }
                else if (MemberLookup.TryGetClrDictionaryTypes(imp.ClrType, out var dKey, out var dVal))
                {
                    iterationKind = ForRangeKind.Dictionary;
                    keyType = TypeSymbol.FromClrType(dKey);
                    valueType = TypeSymbol.FromClrType(dVal);
                }
                else if (MemberLookup.TryGetClrEnumerableElementType(imp.ClrType, out var elemType))
                {
                    iterationKind = ForRangeKind.Enumerable;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(elemType);
                }
                else if (MemberLookup.TryGetClrPatternEnumerableElementType(imp.ClrType, out var patternElemType))
                {
                    iterationKind = ForRangeKind.PatternEnumerator;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.FromClrType(patternElemType);
                }
                else
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                    return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
                }

                break;
            case StructSymbol userType when MemberLookup.TryGetUserPatternEnumerableElementType(userType, out var userElemType):
                iterationKind = ForRangeKind.PatternEnumerator;
                keyType = TypeSymbol.Int32;
                valueType = userElemType;
                break;
            case SequenceTypeSymbol seq:
                // ADR-0040: sequence[T] is IEnumerable[T] — iterate via Enumerable strategy.
                iterationKind = ForRangeKind.Enumerable;
                keyType = TypeSymbol.Int32;
                valueType = seq.ElementType;
                break;
            default:
                // Issue #537: `string` is iterable over `char` via its indexer
                // and Length property — same fast-path C# uses for
                // `foreach (char c in str)`.
                if (collection.Type == TypeSymbol.String)
                {
                    iterationKind = ForRangeKind.Indexed;
                    keyType = TypeSymbol.Int32;
                    valueType = TypeSymbol.Char;
                    break;
                }

                if (collection.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportTypeNotIndexable(syntax.Collection.Location, collection.Type);
                }

                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        scope = new BoundScope(scope);

        VariableSymbol keyVariable = null;
        VariableSymbol valueVariable;
        if (syntax.SecondIdentifier != null)
        {
            keyVariable = bindLocalVariable(syntax.FirstIdentifier, isReadOnly: false, type: keyType);
            valueVariable = bindLocalVariable(syntax.SecondIdentifier, isReadOnly: false, type: valueType);
        }
        else
        {
            // `for v := range coll` — single var binds the value/element.
            valueVariable = bindLocalVariable(syntax.FirstIdentifier, isReadOnly: false, type: valueType);
        }

        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForRangeStatement(originatingSyntax, keyVariable, valueVariable, collection, iterationKind, body, breakLabel, continueLabel);
    }

    /// <summary>
    /// Issue #774: maps an open generic CLR <see cref="Type"/> (such as the
    /// element type extracted from <c>IEnumerable&lt;TParam&gt;</c>) back to
    /// the symbolic <see cref="TypeSymbol"/> carried on
    /// <paramref name="openImp"/>'s <see cref="ImportedTypeSymbol.TypeArguments"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For a generic parameter declared on <see cref="ImportedTypeSymbol.OpenDefinition"/>,
    /// the result is the symbolic argument at the same ordinal — e.g. the
    /// <c>T</c> in <c>IEnumerable[T]</c> becomes the function-level
    /// <see cref="TypeParameterSymbol"/> <c>T</c>.
    /// </para>
    /// <para>
    /// For a constructed generic type whose arguments transitively reference
    /// open parameters (e.g. <c>KeyValuePair&lt;TKey, TValue&gt;</c> on
    /// <c>Dictionary&lt;TKey, TValue&gt;</c>), the helper recurses and
    /// reconstructs the closed shape via <see cref="ImportedTypeSymbol.GetConstructed"/>
    /// so downstream emit keeps the symbolic projection.
    /// </para>
    /// <para>
    /// For anything else (closed primitive, unrelated CLR type, unmapped
    /// parameter), falls back to <see cref="TypeSymbol.FromClrType"/>.
    /// </para>
    /// </remarks>
    /// <summary>
    /// Issue #774: maps an open generic CLR <see cref="Type"/> back to the
    /// matching symbolic <see cref="TypeSymbol"/> on
    /// <paramref name="openImp"/>. Thin local wrapper kept so the existing
    /// case body reads cleanly; the implementation lives on
    /// <see cref="MemberLookup"/> so the lowerer can reuse it when
    /// synthesising symbolic enumerator types.
    /// </summary>
    /// <param name="openClr">The open CLR type to map.</param>
    /// <param name="openImp">The receiver carrying symbolic type arguments.</param>
    /// <returns>The mapped <see cref="TypeSymbol"/>.</returns>
    private static TypeSymbol MapOpenClrTypeToSymbolic(Type openClr, ImportedTypeSymbol openImp)
        => MemberLookup.MapOpenClrTypeToSymbolic(openClr, openImp);

    private BoundStatement BindForConditionStatement(ForConditionStatementSyntax syntax)
    {
        return BindForConditionStatementCore(syntax, syntax.Condition, syntax.Body, labelName: null);
    }

    /// <summary>
    /// Core <c>for cond { body }</c> binder; accepts an optional ADR-0070 label.
    /// </summary>
    /// <param name="originatingSyntax">Originating syntax for diagnostics.</param>
    /// <param name="conditionSyntax">Loop condition.</param>
    /// <param name="bodySyntax">Loop body.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <returns>The lowered bound block.</returns>
    private BoundStatement BindForConditionStatementCore(
        SyntaxNode originatingSyntax,
        ExpressionSyntax conditionSyntax,
        StatementSyntax bodySyntax,
        string labelName)
    {
        // Lowers to:
        //   {
        //     goto checkLabel
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     checkLabel:
        //     if cond goto bodyLabel
        //     breakLabel:
        //   }
        scope = new BoundScope(scope);

        var condition = bindExpressionWithTargetType(conditionSyntax, TypeSymbol.Bool);
        var body = BindLoopBody(bodySyntax, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");
        var checkLabel = new BoundLabel($"check{binderCtx.LabelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundGotoStatement(originatingSyntax, checkLabel));
        statements.Add(new BoundLabelStatement(originatingSyntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(originatingSyntax, continueLabel));
        statements.Add(new BoundLabelStatement(originatingSyntax, checkLabel));
        statements.Add(new BoundConditionalGotoStatement(originatingSyntax, bodyLabel, condition, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(originatingSyntax, breakLabel));

        return new BoundBlockStatement(originatingSyntax, statements.ToImmutable());
    }

    private BoundStatement BindForClauseStatement(ForClauseStatementSyntax syntax)
    {
        return BindForClauseStatementCore(syntax, syntax, labelName: null);
    }

    /// <summary>
    /// Core C-style <c>for init; cond; post { body }</c> binder; accepts an
    /// optional ADR-0070 label.
    /// </summary>
    /// <param name="syntax">The for-clause syntax.</param>
    /// <param name="originatingSyntax">Syntax used for bound-node diagnostics.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <returns>The lowered bound block.</returns>
    private BoundStatement BindForClauseStatementCore(ForClauseStatementSyntax syntax, SyntaxNode originatingSyntax, string labelName)
    {
        // Lowers to:
        //   {
        //     <init>?
        //     goto checkLabel
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     <post>?
        //     checkLabel:
        //     [if cond] goto bodyLabel
        //     breakLabel:
        //   }
        scope = new BoundScope(scope);

        var init = syntax.Initializer == null ? null : BindStatement(syntax.Initializer);
        var condition = syntax.Condition == null ? null : bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool);
        var post = syntax.Post == null ? null : BindStatement(syntax.Post);
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");
        var checkLabel = new BoundLabel($"check{binderCtx.LabelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (init != null)
        {
            statements.Add(init);
        }

        statements.Add(new BoundGotoStatement(originatingSyntax, checkLabel));
        statements.Add(new BoundLabelStatement(originatingSyntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(originatingSyntax, continueLabel));
        if (post != null)
        {
            statements.Add(post);
        }

        statements.Add(new BoundLabelStatement(originatingSyntax, checkLabel));
        if (condition == null)
        {
            statements.Add(new BoundGotoStatement(originatingSyntax, bodyLabel));
        }
        else
        {
            statements.Add(new BoundConditionalGotoStatement(originatingSyntax, bodyLabel, condition, jumpIfTrue: true));
        }

        statements.Add(new BoundLabelStatement(originatingSyntax, breakLabel));

        return new BoundBlockStatement(originatingSyntax, statements.ToImmutable());
    }

    private BoundStatement BindWhileStatement(WhileStatementSyntax syntax)
    {
        // ADR-0070: `while cond { body }` shares the lowering of `for cond { body }`.
        return BindForConditionStatementCore(syntax, syntax.Condition, syntax.Body, labelName: null);
    }

    private BoundStatement BindDoWhileStatement(DoWhileStatementSyntax syntax)
    {
        return BindDoWhileStatementCore(syntax, syntax.Body, syntax.Condition, labelName: null);
    }

    /// <summary>
    /// Lowers a <c>do { body } while cond</c> (or labeled equivalent) to the
    /// canonical post-test goto/label block (ADR-0070). The body runs once
    /// unconditionally before the first condition test.
    /// </summary>
    /// <param name="originatingSyntax">The originating syntax node (used for diagnostics).</param>
    /// <param name="bodySyntax">The loop body statement.</param>
    /// <param name="conditionSyntax">The loop condition expression.</param>
    /// <param name="labelName">The ADR-0070 loop label, or <see langword="null"/>.</param>
    /// <returns>The bound block statement representing the lowered loop.</returns>
    private BoundStatement BindDoWhileStatementCore(
        SyntaxNode originatingSyntax,
        StatementSyntax bodySyntax,
        ExpressionSyntax conditionSyntax,
        string labelName)
    {
        // Lowers to:
        //   {
        //     bodyLabel:
        //     <body>
        //     continueLabel:
        //     if cond goto bodyLabel
        //     breakLabel:
        //   }
        scope = new BoundScope(scope);

        var condition = bindExpressionWithTargetType(conditionSyntax, TypeSymbol.Bool);
        var body = BindLoopBody(bodySyntax, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundLabelStatement(originatingSyntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(originatingSyntax, continueLabel));
        statements.Add(new BoundConditionalGotoStatement(originatingSyntax, bodyLabel, condition, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(originatingSyntax, breakLabel));

        return new BoundBlockStatement(originatingSyntax, statements.ToImmutable());
    }

    private BoundStatement BindLabeledStatement(LabeledStatementSyntax syntax)
    {
        var labelName = syntax.LabelIdentifier.Text;
        var inner = syntax.Statement;

        // ADR-0070: only loops may carry a label.
        if (!IsLabelableLoop(inner))
        {
            Diagnostics.ReportLabelOnNonLoopStatement(syntax.LabelIdentifier.Location, labelName);

            // Drop the label and bind the inner statement on its own so
            // downstream diagnostics surface naturally.
            return BindStatement(inner);
        }

        // ADR-0070: a label that shadows an enclosing live loop's label is a
        // warning — the inner label wins for break/continue resolution.
        foreach (var frame in binderCtx.LoopStack)
        {
            if (frame.LabelName == labelName)
            {
                Diagnostics.ReportLabelShadowsEnclosingLoop(syntax.LabelIdentifier.Location, labelName);
                break;
            }
        }

        return inner.Kind switch
        {
            SyntaxKind.WhileStatement =>
                BindForConditionStatementCore(syntax, ((WhileStatementSyntax)inner).Condition, ((WhileStatementSyntax)inner).Body, labelName),
            SyntaxKind.DoWhileStatement =>
                BindDoWhileStatementCore(syntax, ((DoWhileStatementSyntax)inner).Body, ((DoWhileStatementSyntax)inner).Condition, labelName),
            SyntaxKind.ForInfiniteStatement =>
                BindForInfiniteStatementCore(syntax, ((ForInfiniteStatementSyntax)inner).Body, labelName),
            SyntaxKind.ForEllipsisStatement =>
                BindForEllipsisStatementCore((ForEllipsisStatementSyntax)inner, syntax, labelName),
            SyntaxKind.ForConditionStatement =>
                BindForConditionStatementCore(syntax, ((ForConditionStatementSyntax)inner).Condition, ((ForConditionStatementSyntax)inner).Body, labelName),
            SyntaxKind.ForClauseStatement =>
                BindForClauseStatementCore((ForClauseStatementSyntax)inner, syntax, labelName),
            SyntaxKind.ForRangeStatement =>
                BindForRangeStatementCore((ForRangeStatementSyntax)inner, labelName, syntax),
            SyntaxKind.AwaitForRangeStatement =>
                BindAwaitForRangeStatementCore((AwaitForRangeStatementSyntax)inner, labelName, syntax),
            _ => BindStatement(inner),
        };
    }

    private static bool IsLabelableLoop(StatementSyntax stmt)
    {
        return stmt.Kind switch
        {
            SyntaxKind.WhileStatement => true,
            SyntaxKind.DoWhileStatement => true,
            SyntaxKind.ForInfiniteStatement => true,
            SyntaxKind.ForEllipsisStatement => true,
            SyntaxKind.ForConditionStatement => true,
            SyntaxKind.ForClauseStatement => true,
            SyntaxKind.ForRangeStatement => true,
            SyntaxKind.AwaitForRangeStatement => true,
            _ => false,
        };
    }

    private BoundStatement BindLabeledForRange(LabeledStatementSyntax labelSyntax, ForRangeStatementSyntax inner, string labelName)
    {
        return BindForRangeStatementCore(inner, labelName, labelSyntax);
    }

    /// <summary>
    /// Binds a loop body while pushing the loop's break/continue labels (and
    /// optional ADR-0070 label name) onto <see cref="BinderContext.LoopStack"/>.
    /// </summary>
    /// <param name="body">The loop body statement.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <param name="breakLabel">The synthesized break label.</param>
    /// <param name="continueLabel">The synthesized continue label.</param>
    private BoundStatement BindLoopBody(
        StatementSyntax body,
        string labelName,
        out BoundLabel breakLabel,
        out BoundLabel continueLabel)
    {
        binderCtx.LabelCounter++;
        breakLabel = new BoundLabel($"break{binderCtx.LabelCounter}");
        continueLabel = new BoundLabel($"continue{binderCtx.LabelCounter}");

        binderCtx.LoopStack.Push((labelName, breakLabel, continueLabel));
        var boundBody = BindStatement(body);
        binderCtx.LoopStack.Pop();

        return boundBody;
    }

    private BoundStatement BindBreakStatement(BreakStatementSyntax syntax)
    {
        if (binderCtx.LoopStack.Count == 0)
        {
            Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text);
            return BindErrorStatement();
        }

        if (syntax.LabelIdentifier != null)
        {
            var name = syntax.LabelIdentifier.Text;
            foreach (var frame in binderCtx.LoopStack)
            {
                if (frame.LabelName == name)
                {
                    return new BoundGotoStatement(syntax, frame.BreakLabel);
                }
            }

            Diagnostics.ReportUnknownLoopLabel(syntax.LabelIdentifier.Location, syntax.Keyword.Text, name);
            return BindErrorStatement();
        }

        var breakLabel = binderCtx.LoopStack.Peek().BreakLabel;
        return new BoundGotoStatement(syntax, breakLabel);
    }

    private BoundStatement BindContinueStatement(ContinueStatementSyntax syntax)
    {
        if (binderCtx.LoopStack.Count == 0)
        {
            Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text);
            return BindErrorStatement();
        }

        if (syntax.LabelIdentifier != null)
        {
            var name = syntax.LabelIdentifier.Text;
            foreach (var frame in binderCtx.LoopStack)
            {
                if (frame.LabelName == name)
                {
                    return new BoundGotoStatement(syntax, frame.ContinueLabel);
                }
            }

            Diagnostics.ReportUnknownLoopLabel(syntax.LabelIdentifier.Location, syntax.Keyword.Text, name);
            return BindErrorStatement();
        }

        var continueLabel = binderCtx.LoopStack.Peek().ContinueLabel;
        return new BoundGotoStatement(syntax, continueLabel);
    }

    private BoundStatement BindReturnStatement(ReturnStatementSyntax syntax)
    {
        // ADR-0055 Tier 4: returning an interpolated string where the function's
        // declared type is IFormattable/FormattableString lowers to
        // FormattableStringFactory.Create instead of an eager string.
        if (syntax.Expression is InterpolatedStringExpressionSyntax interpolatedReturn
            && function != null
            && function.Type != TypeSymbol.Void
            && isFormattableStringTargetType(function.Type))
        {
            return new BoundReturnStatement(syntax, bindInterpolatedStringAsFormattable(interpolatedReturn, function.Type));
        }

        // ADR-0100 / issue #795: a bare `return default` takes its type
        // from the enclosing function's declared return type. We special-
        // case it here so the kind dispatcher does not see a bare default
        // without a target and report GS0362. Inferred-return lambdas
        // (function.IsReturnTypeInferred) cannot resolve a target yet, so
        // GS0362 still fires there — the user must write the explicit
        // `default(T)` form when the lambda's return type is being
        // inferred.
        BoundExpression expression;
        if (syntax.Expression is DefaultExpressionSyntax bareReturnDefault
            && bareReturnDefault.TypeClause == null
            && function != null
            && !function.IsReturnTypeInferred
            && function.Type != TypeSymbol.Void)
        {
            expression = new BoundDefaultExpression(bareReturnDefault, function.Type);
        }
        else
        {
            expression = syntax.Expression == null ? null : bindExpression(syntax.Expression);
        }

        // Issue #490 (ADR-0060 follow-up): validate the `return ref` / `return` form
        // against the function's declared return ref-kind. Then, for ref returns, wrap
        // the operand in a BoundAddressOfExpression and run lvalue + escape-scope checks.
        var isRefReturn = false;
        if (function != null)
        {
            var fnIsRefReturning = function.ReturnRefKind == RefKind.Ref;

            if (syntax.IsRefReturn && !fnIsRefReturning)
            {
                Diagnostics.ReportRefReturnInNonRefReturningFunction(
                    syntax.RefKeyword.Location,
                    function.Name);
            }
            else if (!syntax.IsRefReturn && fnIsRefReturning && syntax.Expression != null)
            {
                // The function is ref-returning but the statement omits `ref`.
                Diagnostics.ReportRefReturnRequiredOnRefReturningFunction(
                    syntax.ReturnKeyword.Location,
                    function.Name);
            }
            else if (syntax.IsRefReturn && fnIsRefReturning)
            {
                isRefReturn = true;
            }
        }

        if (function == null)
        {
            Diagnostics.ReportInvalidReturn(syntax.ReturnKeyword.Location);
        }
        else if (function.IsReturnTypeInferred)
        {
            // ADR-0076 / issue #716: arrow-lambda binding deferred return-type
            // resolution to a post-bind pass. The expression has been bound,
            // but we deliberately skip the void / declared-return-type check
            // and the eager conversion; the lambda binder collects the bound
            // expressions, computes the inferred return type (common-type
            // across all return paths and the trailing block expression, if
            // any), and applies a single conversion pass to each return-
            // statement expression once the return type is known.
        }
        else
        {
            if (function.Type == TypeSymbol.Void)
            {
                if (expression != null)
                {
                    Diagnostics.ReportInvalidReturnExpression(syntax.Expression.Location, function.Name);
                }
            }
            else
            {
                if (expression == null)
                {
                    Diagnostics.ReportMissingReturnExpression(syntax.ReturnKeyword.Location, function.Type);
                }
                else
                {
                    expression = conversions.BindConversion(syntax.Expression.Location, expression, function.Type);
                }
            }
        }

        if (expression != null)
        {
            // ADR-0039 §4 / ADR-0058: a managed-pointer (*T) value cannot be returned from
            // a function — the callee's stack frame (containing the pointed-to variable) is
            // invalid after the function returns. Diagnose with GS9004.
            // Exception (issue #490): a ref-returning function legitimately yields T&; the
            // managed-pointer wrap happens via the synthesized BoundAddressOfExpression below.
            if (expression.Type is ByRefTypeSymbol && !isRefReturn)
            {
                Diagnostics.ReportByRefCannotEscape(
                    syntax.Expression.Location,
                    "a managed pointer (*T) cannot be returned from a function; managed references must not outlive their declaring scope");
            }

            // ADR-0058 / issue #376: a ref struct value with function-local escape scope
            // cannot be returned. This covers:
            // - direct reference to a `scoped` parameter or local
            // - value derived from a scoped source through constructor, member access, etc.
            if (TypeSymbol.IsByRefLike(expression.Type) && HasFunctionLocalEscapeScope(expression))
            {
                Diagnostics.ReportByRefLikeEscape(
                    syntax.Expression.Location,
                    expression.Type,
                    "be returned from a function (value has function-local safe-to-escape scope due to a `scoped` source)");
            }
        }

        // Issue #490: convert a `return ref <lvalue>` into a BoundAddressOfExpression so the
        // emitter knows to take the address (ldloca / ldarga / ldflda / ldelema) and the
        // method signature returns T&. Validate lvalue-ness and ref-safe-to-escape scope.
        if (isRefReturn && expression != null && expression.Type != TypeSymbol.Error)
        {
            if (!IsLvalueForRefReturn(expression))
            {
                Diagnostics.ReportRefReturnRequiresLvalue(syntax.Expression.Location);
            }
            else if (HasFunctionLocalRefScope(expression))
            {
                Diagnostics.ReportRefReturnEscapesLocalScope(syntax.Expression.Location);
            }

            expression = new BoundAddressOfExpression(syntax.Expression, expression);
        }

        return new BoundReturnStatement(syntax, expression, isRefReturn);
    }

    /// <summary>
    /// Issue #490: returns true when <paramref name="expr"/> denotes a stable lvalue whose
    /// address can be safely taken for a <c>return ref</c>.
    /// </summary>
    private static bool IsLvalueForRefReturn(BoundExpression expr)
    {
        switch (expr)
        {
            case BoundVariableExpression:
                return true;
            case BoundFieldAccessExpression:
                return true;
            case BoundIndexExpression:
                return true;
            case BoundDereferenceExpression:
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #490: returns true when <paramref name="expr"/>'s ref-safe-to-escape scope is
    /// function-local — i.e. the underlying storage dies at function exit and cannot be
    /// returned as a managed pointer. ADR-0058 conservative single-pass propagation:
    /// returning a local variable, a <c>scoped</c> parameter, a field of a local, or any
    /// expression rooted in those is rejected. Returning a parameter (non-<c>scoped</c>) or
    /// a field/element of one is permitted (the caller's slot outlives the callee).
    /// </summary>
    private static bool HasFunctionLocalRefScope(BoundExpression expr)
    {
        switch (expr)
        {
            case BoundVariableExpression v:
                // Plain locals die with the frame; non-scoped parameters / globals survive.
                if (v.Variable is ParameterSymbol p)
                {
                    return p.IsScoped;
                }

                if (v.Variable is GlobalVariableSymbol)
                {
                    return false;
                }

                // Any other LocalVariableSymbol (let/var inside the function body) is local-scope.
                return v.Variable is LocalVariableSymbol;
            case BoundFieldAccessExpression fa:
                // Reference type fields live in a heap object — safe regardless of receiver scope.
                if (fa.Receiver.Type is StructSymbol s && s.IsClass)
                {
                    return false;
                }

                // Static field: lives on the type, safe.
                if (fa.Receiver == null)
                {
                    return false;
                }

                // Value-type field: inherits the receiver's storage scope.
                return HasFunctionLocalRefScope(fa.Receiver);
            case BoundIndexExpression idx:
                // Array / slice elements live on the heap (System.Array / underlying buffer);
                // the element's storage outlives the function frame regardless of the local
                // alias used to reach it.
                return false;
            case BoundDereferenceExpression deref:
                // *p has whatever scope `p` itself yields; conservative — if p is a local
                // variable of *T, its current value points into the local frame.
                return HasFunctionLocalRefScope(deref.Operand);
            default:
                return true;
        }
    }

    private BoundStatement BindExpressionStatement(ExpressionStatementSyntax syntax)
    {
        var expression = bindExpression(syntax.Expression, canBeVoid: true);
        return new BoundExpressionStatement(syntax, expression);
    }

    // ADR-0058 / issue #376: determines whether a bound expression has function-local
    // safe-to-escape scope. Used by the return-statement check and by STE propagation
    // through initializers to detect when a ref struct value is rooted in a scoped source.
    private static bool HasFunctionLocalEscapeScope(BoundExpression expression)
    {
        switch (expression)
        {
            // Direct reference to a scoped variable (parameter or local).
            case BoundVariableExpression varExpr:
                return varExpr.Variable is LocalVariableSymbol local && local.IsScoped;

            // Conversion (implicit/explicit) preserves STE of the inner expression.
            case BoundConversionExpression conv:
                return HasFunctionLocalEscapeScope(conv.Expression);

            // User-defined constructor: if any argument is a scoped ref struct, the
            // result inherits function-local STE (conservative).
            case BoundConstructorCallExpression ctor:
                foreach (var arg in ctor.Arguments)
                {
                    if (TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg))
                    {
                        return true;
                    }
                }

                return false;

            // CLR constructor call: same conservative rule.
            case BoundClrConstructorCallExpression clrCtor:
                foreach (var arg in clrCtor.Arguments)
                {
                    if (TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg))
                    {
                        return true;
                    }
                }

                return false;

            // Field/member access on a scoped receiver: if the receiver is scoped
            // and the result type is a ref struct, the result is also function-local.
            case BoundFieldAccessExpression fieldAccess:
                if (fieldAccess.Receiver != null && TypeSymbol.IsByRefLike(fieldAccess.Receiver.Type))
                {
                    return HasFunctionLocalEscapeScope(fieldAccess.Receiver);
                }

                return false;

            // User instance call (method on a user struct): if the receiver is scoped
            // and the result is a ref struct, the result inherits function-local STE.
            case BoundUserInstanceCallExpression userCall:
                if (userCall.Receiver != null && TypeSymbol.IsByRefLike(userCall.Receiver.Type)
                    && HasFunctionLocalEscapeScope(userCall.Receiver))
                {
                    return true;
                }

                foreach (var arg in userCall.Arguments)
                {
                    if (TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg))
                    {
                        return true;
                    }
                }

                return false;

            // Imported (CLR) instance call: same rule as user instance call.
            case BoundImportedInstanceCallExpression importedCall:
                if (importedCall.Receiver != null && TypeSymbol.IsByRefLike(importedCall.Receiver.Type)
                    && HasFunctionLocalEscapeScope(importedCall.Receiver))
                {
                    return true;
                }

                foreach (var arg in importedCall.Arguments)
                {
                    if (TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg))
                    {
                        return true;
                    }
                }

                return false;

            // Static/imported calls: check arguments only.
            case BoundCallExpression call:
                foreach (var arg in call.Arguments)
                {
                    if (TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg))
                    {
                        return true;
                    }
                }

                return false;

            case BoundImportedCallExpression importedStatic:
                foreach (var arg in importedStatic.Arguments)
                {
                    if (TypeSymbol.IsByRefLike(arg.Type) && HasFunctionLocalEscapeScope(arg))
                    {
                        return true;
                    }
                }

                return false;

            default:
                return false;
        }
    }

    /// <summary>
    /// ADR-0072 / issue #709: binds a null-coalescing compound assignment
    /// statement <c>target ??= value</c>. The target must be an assignable
    /// expression of nullable type; the result is desugared to
    /// <c>if read(target) == nil { write(target) = value }</c>. Any
    /// non-trivial receiver of the target is captured into a synthetic local
    /// before the test so that <c>obj.field ??= …</c> does not evaluate
    /// <c>obj</c> twice. The right-hand side is evaluated only when the
    /// target reads as nil.
    /// </summary>
    private BoundStatement BindNullCoalescingAssignmentStatement(NullCoalescingAssignmentStatementSyntax syntax)
    {
        // Bind the LHS as a read-side expression. This decides the lvalue
        // shape (variable / field / property / indexer) we need to mirror
        // on the write side, and surfaces the type to validate nullability.
        var boundRead = bindExpression(syntax.Target, false);
        if (boundRead is BoundErrorExpression || boundRead.Type == TypeSymbol.Error)
        {
            _ = bindExpression(syntax.Value, false);
            return new BoundExpressionStatement(syntax, boundRead);
        }

        if (boundRead.Type is not NullableTypeSymbol nullableType)
        {
            Diagnostics.ReportNullCoalescingAssignmentTargetNotNullable(syntax.OperatorToken.Location, boundRead.Type);
            _ = bindExpression(syntax.Value, false);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        // Bind the RHS, converting it to the LHS's nullable type so the
        // author can write either an underlying-typed value (which lifts
        // via the implicit T -> T? conversion) or another nullable value.
        var boundRhs = bindExpressionWithTargetType(syntax.Value, nullableType);
        if (boundRhs is BoundErrorExpression || boundRhs.Type == TypeSymbol.Error)
        {
            return new BoundExpressionStatement(syntax, boundRhs);
        }

        var preStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        var (read, write) = TryBuildNullCoalescingReadWrite(syntax, boundRead, boundRhs, preStatements);
        if (read == null || write == null)
        {
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        // Condition: read == nil. Routes through the existing nil-compare
        // operator so any value-type Nullable<T> lowering is handled in the
        // same code path as `x == nil` elsewhere.
        var nilLiteral = new BoundLiteralExpression(syntax, null, TypeSymbol.Null);
        var eqOp = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, read.Type, TypeSymbol.Null);
        BoundExpression condition = new BoundBinaryExpression(syntax, read, eqOp, nilLiteral);

        var thenStmt = new BoundExpressionStatement(syntax, write);
        BoundStatement ifStmt = new BoundIfStatement(syntax, condition, thenStmt, elseStatement: null);

        if (preStatements.Count == 0)
        {
            return ifStmt;
        }

        preStatements.Add(ifStmt);
        return new BoundBlockStatement(syntax, preStatements.ToImmutable());
    }

    /// <summary>
    /// ADR-0072 / issue #709: builds the read+write pair for a
    /// <c>??=</c> target by inspecting the bound read form. Non-trivial
    /// receivers are spilled into synthetic locals (declared in the
    /// current scope and prepended to <paramref name="preStatements"/>)
    /// so the receiver is evaluated exactly once. Returns
    /// <c>(null, null)</c> with a diagnostic when the target shape is
    /// not assignable or the target is read-only.
    /// </summary>
    private (BoundExpression Read, BoundExpression Write) TryBuildNullCoalescingReadWrite(
        NullCoalescingAssignmentStatementSyntax syntax,
        BoundExpression boundRead,
        BoundExpression boundRhs,
        ImmutableArray<BoundStatement>.Builder preStatements)
    {
        switch (boundRead)
        {
            case BoundVariableExpression varExpr:
            {
                if (varExpr.Variable.IsReadOnly)
                {
                    Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, varExpr.Variable.Name);
                    return (null, null);
                }

                var write = new BoundAssignmentExpression(syntax, varExpr.Variable, boundRhs);
                return (boundRead, write);
            }

            case BoundFieldAccessExpression fieldAccess:
            {
                // Issue #947: a read-only (`let`) instance field may be written
                // by a compound assignment inside the declaring type's
                // constructor when the receiver is `this`; everywhere else the
                // read-only field write remains a GS0127 error.
                if (fieldAccess.Field.IsReadOnly)
                {
                    var fn = this.function;
                    var inCtor = fn != null && fn.Name == ".ctor" && fn.ThisParameter != null && !fieldAccess.Field.IsStatic;
                    var receiverIsThis = fieldAccess.Receiver == null
                        || (fieldAccess.Receiver is BoundVariableExpression rbve
                            && fn?.ThisParameter != null
                            && ReferenceEquals(rbve.Variable, fn.ThisParameter));
                    var declaredByThisType = fieldAccess.StructType == null
                        || fn?.ReceiverType == null
                        || ReferenceEquals(fieldAccess.StructType, fn.ReceiverType);
                    if (!inCtor || !receiverIsThis || !declaredByThisType)
                    {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, fieldAccess.Field.Name);
                        return (null, null);
                    }
                }

                var receiver = CaptureReceiver(syntax, fieldAccess.Receiver, preStatements);
                var read = new BoundFieldAccessExpression(syntax, receiver, fieldAccess.StructType, fieldAccess.Field);

                // Use the VariableSymbol-based constructor: every receiver
                // captured by CaptureReceiver is a BoundVariableExpression
                // (either the original simple variable or a synthetic local
                // that holds the spilled receiver). The interpreter and the
                // existing rewriters all assume this shape for the simple
                // receiver path; routing through ReceiverExpression bypasses
                // the interpreter's class-field write logic (issue #709).
                var write = new BoundFieldAssignmentExpression(syntax, receiver.Variable, fieldAccess.StructType, fieldAccess.Field, boundRhs);
                return (read, write);
            }

            case BoundPropertyAccessExpression propAccess:
            {
                if (!propAccess.Property.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, propAccess.Property.Name);
                    return (null, null);
                }

                // Issue #946: a compound assignment (`+=` / `??=`) to an
                // init-only property is only legal during object initialization.
                if (propAccess.Property.IsInitOnly)
                {
                    var fn = this.function;
                    var inInitContext = fn != null && (fn.Name == ".ctor" || fn.IsInitOnlySetter);
                    var receiverIsThis = propAccess.Receiver == null
                        || (propAccess.Receiver is BoundVariableExpression rbve
                            && fn?.ThisParameter != null
                            && ReferenceEquals(rbve.Variable, fn.ThisParameter));
                    if (!inInitContext || !receiverIsThis)
                    {
                        Diagnostics.ReportInitOnlyPropertyAssignment(syntax.OperatorToken.Location, propAccess.Property.Name);
                        return (null, null);
                    }
                }

                var receiver = propAccess.Receiver == null
                    ? null
                    : CaptureReceiver(syntax, propAccess.Receiver, preStatements);
                var read = new BoundPropertyAccessExpression(syntax, receiver, propAccess.StructType, propAccess.Property);
                var write = new BoundPropertyAssignmentExpression(syntax, receiver, propAccess.StructType, propAccess.Property, boundRhs);
                return (read, write);
            }

            case BoundClrPropertyAccessExpression clrPropAccess:
            {
                // For CLR properties, writability is enforced when the
                // assignment is built — we mirror the assignment path here
                // so the same diagnostic surfaces on `??=` targets.
                if (clrPropAccess.Member is System.Reflection.PropertyInfo propInfo && !propInfo.CanWrite)
                {
                    Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, propInfo.Name);
                    return (null, null);
                }

                if (clrPropAccess.Member is System.Reflection.FieldInfo fieldInfo && (fieldInfo.IsInitOnly || fieldInfo.IsLiteral))
                {
                    Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, fieldInfo.Name);
                    return (null, null);
                }

                var receiver = clrPropAccess.Receiver == null
                    ? null
                    : CaptureReceiver(syntax, clrPropAccess.Receiver, preStatements);
                var read = new BoundClrPropertyAccessExpression(syntax, receiver, clrPropAccess.Member, clrPropAccess.Type);
                var write = new BoundClrPropertyAssignmentExpression(syntax, receiver, clrPropAccess.Member, boundRhs, clrPropAccess.Type);
                return (read, write);
            }

            case BoundIndexExpression idx:
            {
                // Spill both the target collection and the index expression
                // so neither is re-evaluated.
                var target = CaptureReceiver(syntax, idx.Target, preStatements);
                var index = CaptureReceiver(syntax, idx.Index, preStatements);
                var read = new BoundIndexExpression(syntax, target, index, idx.Type);
                var write = new BoundIndexAssignmentExpression(syntax, target.Variable, index, boundRhs, idx.Type);
                return (read, write);
            }

            case BoundClrIndexExpression clrIdx:
            {
                if (!clrIdx.Indexer.CanWrite)
                {
                    Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, clrIdx.Indexer.Name);
                    return (null, null);
                }

                var target = CaptureReceiver(syntax, clrIdx.Target, preStatements);
                var argsBuilder = ImmutableArray.CreateBuilder<BoundExpression>(clrIdx.Arguments.Length);
                foreach (var arg in clrIdx.Arguments)
                {
                    argsBuilder.Add(CaptureReceiver(syntax, arg, preStatements));
                }

                var args = argsBuilder.ToImmutable();
                var read = new BoundClrIndexExpression(syntax, target, clrIdx.Indexer, args, clrIdx.Type);
                var write = new BoundClrIndexAssignmentExpression(syntax, target.Variable, clrIdx.Indexer, args, boundRhs, clrIdx.Type);
                return (read, write);
            }

            default:
                Diagnostics.ReportNullCoalescingAssignmentInvalidTarget(syntax.OperatorToken.Location);
                return (null, null);
        }
    }

    /// <summary>
    /// ADR-0072 / issue #709: captures a non-trivial receiver expression
    /// into a synthetic read-only local declared in the current scope so
    /// the receiver is evaluated exactly once across the read+test+write
    /// triple. Simple variable references are returned unchanged because
    /// they have no observable side effects. Always returns a
    /// <see cref="BoundVariableExpression"/> so callers can use the
    /// variable-receiver constructors on field / index assignments — the
    /// expression-receiver overloads bypass interpreter write logic
    /// (issue #709).
    /// </summary>
    private BoundVariableExpression CaptureReceiver(
        NullCoalescingAssignmentStatementSyntax syntax,
        BoundExpression receiver,
        ImmutableArray<BoundStatement>.Builder preStatements)
    {
        if (receiver is BoundVariableExpression bve)
        {
            return bve;
        }

        var name = $"<ncaRecv{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var local = new LocalVariableSymbol(name, isReadOnly: true, receiver.Type);
        scope.TryDeclareVariable(local);
        var declaration = new BoundVariableDeclaration(syntax, local, receiver);
        preStatements.Add(declaration);
        return new BoundVariableExpression(syntax, local);
    }
}
