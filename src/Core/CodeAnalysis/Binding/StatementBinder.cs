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
        Func<FunctionSymbol> getCurrentFunction)
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
            default:
                throw new Exception($"Unexpected syntax {syntax.Kind}");
        }
    }

    internal BoundStatement BindBlockStatement(BlockStatementSyntax syntax)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        scope = new BoundScope(scope);

        BindBlockStatements(syntax.Statements, 0, statements);

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
        if (statement is not BoundIfStatement ifStmt)
        {
            return;
        }

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

            if (!structType.TryGetFieldIncludingInherited(fieldName, out var field, out var declaringType))
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
                    var (leftThen, _) = TryClassifyTypeTestNarrowing(binary.Left);
                    var (rightThen, _) = TryClassifyTypeTestNarrowing(binary.Right);
                    var combinedThen = MergeNarrowingFrames(leftThen, rightThen);
                    if (combinedThen == null || combinedThen.Count == 0)
                    {
                        return (null, null);
                    }

                    return (combinedThen, null);
                }
        }

        return (null, null);
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
        // Phase 3.C.4: recognise the canonical narrowing patterns. We support
        // only single-variable guards here; conjunctions, disjunctions and
        // pattern-based narrowing are deferred.
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

        foreach (var caseSyntax in syntax.Cases)
        {
            if (caseSyntax.IsDefault)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(caseSyntax.Keyword.Location);
                }

                hasDefault = true;
                arms.Add(new BoundPatternSwitchArm(null, pattern: null, BindBlockStatement(caseSyntax.Body)));
                continue;
            }

            scope = new BoundScope(scope);
            var pattern = patterns.BindPattern(caseSyntax.Value, switchType);
            if (pattern is BoundDiscardPattern)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(caseSyntax.Value.Location);
                }

                hasDefault = true;
            }

            var frame = TryClassifyPatternNarrowing(discriminant, pattern);
            var body = BindStatementWithNarrowing(caseSyntax.Body, frame);
            scope = scope.Parent;
            arms.Add(new BoundPatternSwitchArm(null, pattern, body));
        }

        var boundArms = arms.ToImmutable();
        ExhaustivenessAnalyzer.AnalyzeSwitchStatement(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            scope.GetDeclaredStructs(),
            Diagnostics);

        return new BoundPatternSwitchStatement(null, discriminant, boundArms);
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

        return new BoundTryStatement(syntax, tryBlock, catches.ToImmutable(), finallyBlock);
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

    private BoundStatement BindAwaitForRangeStatement(AwaitForRangeStatementSyntax syntax)
    {
        // Phase 5.8 / ADR-0023: `await for v := range stream { … }`.
        // The stream operand must be an `IAsyncEnumerable[T]` (a CLR type
        // that exposes a `GetAsyncEnumerator` method). The value variable
        // is typed as the stream's element `T`. The interpreter handles
        // the underlying `MoveNextAsync`/`Current`/`DisposeAsync` cycle
        // synchronously (matching Phase 5.1's `await` lowering). The
        // async-aware lowering and emit are deferred.
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
        var body = BindStatement(syntax.Body);
        scope = scope.Parent;

        return new BoundAwaitForRangeStatement(null, variable, stream, body);
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

        var clr = type?.ClrType;
        if (clr == null)
        {
            return TypeSymbol.FromClrType(typeof(object));
        }

        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var def = clr.GetGenericTypeDefinition();
            if (def == typeof(System.Collections.Generic.IEnumerable<>) ||
                def == typeof(System.Collections.Generic.IEnumerator<>))
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
        scope = new BoundScope(scope);

        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForInfiniteStatement(null, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForEllipsisStatement(ForEllipsisStatementSyntax syntax)
    {
        var lowerBound = bindExpressionWithTargetType(syntax.LowerBound, TypeSymbol.Int32);
        var upperBound = bindExpressionWithTargetType(syntax.UpperBound, TypeSymbol.Int32);

        scope = new BoundScope(scope);

        var variable = bindLocalVariable(syntax.Identifier, isReadOnly: false, type: TypeSymbol.Int32);
        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForEllipsisStatement(null, variable, lowerBound, upperBound, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForRangeStatement(ForRangeStatementSyntax syntax)
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

        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        return new BoundForRangeStatement(syntax, keyVariable, valueVariable, collection, iterationKind, body, breakLabel, continueLabel);
    }

    private BoundStatement BindForConditionStatement(ForConditionStatementSyntax syntax)
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

        var condition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool);
        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");
        var checkLabel = new BoundLabel($"check{binderCtx.LabelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundGotoStatement(syntax, checkLabel));
        statements.Add(new BoundLabelStatement(syntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(syntax, continueLabel));
        statements.Add(new BoundLabelStatement(syntax, checkLabel));
        statements.Add(new BoundConditionalGotoStatement(syntax, bodyLabel, condition, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(syntax, breakLabel));

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private BoundStatement BindForClauseStatement(ForClauseStatementSyntax syntax)
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
        var body = BindLoopBody(syntax.Body, out var breakLabel, out var continueLabel);

        scope = scope.Parent;

        var bodyLabel = new BoundLabel($"body{binderCtx.LabelCounter}");
        var checkLabel = new BoundLabel($"check{binderCtx.LabelCounter}");

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (init != null)
        {
            statements.Add(init);
        }

        statements.Add(new BoundGotoStatement(syntax, checkLabel));
        statements.Add(new BoundLabelStatement(syntax, bodyLabel));
        statements.Add(body);
        statements.Add(new BoundLabelStatement(syntax, continueLabel));
        if (post != null)
        {
            statements.Add(post);
        }

        statements.Add(new BoundLabelStatement(syntax, checkLabel));
        if (condition == null)
        {
            statements.Add(new BoundGotoStatement(syntax, bodyLabel));
        }
        else
        {
            statements.Add(new BoundConditionalGotoStatement(syntax, bodyLabel, condition, jumpIfTrue: true));
        }

        statements.Add(new BoundLabelStatement(syntax, breakLabel));

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private BoundStatement BindLoopBody(StatementSyntax body, out BoundLabel breakLabel, out BoundLabel continueLabel)
    {
        binderCtx.LabelCounter++;
        breakLabel = new BoundLabel($"break{binderCtx.LabelCounter}");
        continueLabel = new BoundLabel($"continue{binderCtx.LabelCounter}");

        binderCtx.LoopStack.Push((breakLabel, continueLabel));
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

        var expression = syntax.Expression == null ? null : bindExpression(syntax.Expression);

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
}
