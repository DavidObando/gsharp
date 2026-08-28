// <copyright file="StatementBinder.Jumps.cs" company="GSharp">
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
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class StatementBinder
{
    private BoundStatement BindGotoStatement(GotoStatementSyntax syntax)
    {
        var labelName = syntax.LabelIdentifier.ValueText;
        var label = GetOrCreateUserLabelForGoto(labelName, syntax.LabelIdentifier.Location);
        userGotoHandlerRegions.Add((
            labelName,
            syntax.LabelIdentifier.Location,
            exceptionHandlerRegions.Reverse().ToImmutableArray()));
        return new BoundGotoStatement(syntax, label);
    }

    /// <summary>
    /// Issue #1884: resolves the <see cref="BoundLabel"/> a <c>goto</c>
    /// targets, creating a placeholder up front when the label has not been
    /// declared yet (a forward reference — the label may appear later in the
    /// same function). The placeholder is recorded in
    /// <see cref="BinderContext.UnresolvedGotoLabels"/> until
    /// <see cref="DefineUserLabel"/> declares it; <see cref="FinalizeUserLabels"/>
    /// reports GS0469 for any name still unresolved once the function finishes
    /// binding.
    /// </summary>
    private BoundLabel GetOrCreateUserLabelForGoto(string labelName, TextLocation location)
    {
        if (binderCtx.UserLabels.TryGetValue(labelName, out var label))
        {
            return label;
        }

        label = new BoundLabel(labelName);
        binderCtx.UserLabels[labelName] = label;
        binderCtx.UnresolvedGotoLabels[labelName] = location;
        return label;
    }

    /// <summary>
    /// Issue #1884: declares a <c>goto</c> label at a <c>label: statement</c>
    /// site, reusing any placeholder created by an earlier forward-referencing
    /// <c>goto</c> (<see cref="GetOrCreateUserLabelForGoto"/>). A second
    /// declaration of the same name in the same function is GS0470.
    /// </summary>
    private BoundLabel DefineUserLabel(string labelName, TextLocation location)
    {
        if (!binderCtx.DefinedUserLabels.Add(labelName))
        {
            Diagnostics.ReportDuplicateGotoLabel(location, labelName);
            return binderCtx.UserLabels[labelName];
        }

        userLabelHandlerRegions[labelName] = exceptionHandlerRegions.Reverse().ToImmutableArray();
        binderCtx.UnresolvedGotoLabels.Remove(labelName);
        if (!binderCtx.UserLabels.TryGetValue(labelName, out var label))
        {
            label = new BoundLabel(labelName);
            binderCtx.UserLabels[labelName] = label;
        }

        return label;
    }

    /// <summary>
    /// Issue #1884: reports GS0469 for every <c>goto</c> target that is still
    /// unresolved once the enclosing function has finished binding. Called
    /// once per function-equivalent binding session (a plain function/method/
    /// constructor/accessor body, or — for top-level statements — once after
    /// all global statements share the synthesized entry point's body).
    /// </summary>
    internal void FinalizeUserLabels()
    {
        foreach (var entry in binderCtx.UnresolvedGotoLabels)
        {
            Diagnostics.ReportUndefinedGotoLabel(entry.Value, entry.Key);
        }

        foreach (var branch in userGotoHandlerRegions)
        {
            if (userLabelHandlerRegions.TryGetValue(branch.LabelName, out var targetRegions)
                && !IsHandlerRegionPrefix(targetRegions, branch.SourceRegions))
            {
                Diagnostics.ReportGotoIntoExceptionHandler(branch.Location, branch.LabelName);
            }
        }

        binderCtx.UnresolvedGotoLabels.Clear();
        userGotoHandlerRegions.Clear();
        userLabelHandlerRegions.Clear();
    }

    private static bool IsHandlerRegionPrefix(
        ImmutableArray<SyntaxNode> targetRegions,
        ImmutableArray<SyntaxNode> sourceRegions)
    {
        if (targetRegions.Length > sourceRegions.Length)
        {
            return false;
        }

        for (var i = 0; i < targetRegions.Length; i++)
        {
            if (!ReferenceEquals(targetRegions[i], sourceRegions[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Binds a loop body while pushing the loop's break/continue labels (and
    /// optional ADR-0070 label name) onto <see cref="BinderContext.LoopStack"/>.
    /// </summary>
    /// <param name="body">The loop body statement.</param>
    /// <param name="labelName">The ADR-0070 label, or <see langword="null"/>.</param>
    /// <param name="breakLabel">The synthesized break label.</param>
    /// <param name="continueLabel">The synthesized continue label.</param>
    /// <param name="inheritedNarrowingFrameCount">Number of active frames whose
    /// narrowings predate this loop iteration.</param>
    /// <param name="backEdgeTail">Optional post/condition evaluation executed
    /// between body completion and the next iteration.</param>
    /// <param name="backEdgeCondition">Optional condition that must be true
    /// before control reaches the next iteration.</param>
    private BoundStatement BindLoopBody(
        StatementSyntax body,
        string? labelName,
        out BoundLabel breakLabel,
        out BoundLabel continueLabel,
        int inheritedNarrowingFrameCount = -1,
        BoundStatement? backEdgeTail = null,
        BoundExpression? backEdgeCondition = null)
    {
        inheritedNarrowingFrameCount = inheritedNarrowingFrameCount < 0
            ? binderCtx.NarrowedVariables.Count
            : inheritedNarrowingFrameCount;
        if (!HasActiveNarrowings(inheritedNarrowingFrameCount))
        {
            return BindCore(out breakLabel, out continueLabel);
        }

        var diagnosticCount = Diagnostics.Count;
        var narrowingSnapshots = binderCtx.NarrowedVariables
            .Select(frame => new Dictionary<AccessPath, TypeSymbol>(frame))
            .ToArray();
        var pendingEarlyExitFrames = binderCtx.PendingEarlyExitFrames.ToArray();
        var pendingSwitchExitFrames = binderCtx.PendingSwitchExitFrames.ToArray();
        var definedUserLabels = binderCtx.DefinedUserLabels.ToArray();
        var userGotoHandlerSnapshot = userGotoHandlerRegions.ToArray();
        var syntheticLocalCounter = binderCtx.SyntheticLocalCounter;

        static void RestoreDictionary<TKey, TValue>(
            Dictionary<TKey, TValue> destination,
            KeyValuePair<TKey, TValue>[] snapshot)
            where TKey : notnull
        {
            destination.Clear();
            foreach (var entry in snapshot)
            {
                destination.Add(entry.Key, entry.Value);
            }
        }

        static void RestoreSet<T>(HashSet<T> destination, T[] snapshot)
        {
            destination.Clear();
            foreach (var item in snapshot)
            {
                destination.Add(item);
            }
        }

        // Issue #2943: first bind supplies exact assignment symbols and lowered
        // control flow. If a write can reach the back-edge, restore speculative
        // state, remove only inherited narrowings, and bind the body again.
        var firstBody = BindCore(out var firstBreakLabel, out var firstContinueLabel);
        var mutations = CollectLoopBackEdgeMutations(
            firstBody,
            firstBreakLabel,
            firstContinueLabel,
            backEdgeTail,
            backEdgeCondition);
        var narrowingInvalidations = CollectInheritedNarrowingInvalidations(
            mutations,
            mutations.MayMutateMemberPaths,
            inheritedNarrowingFrameCount,
            narrowingSnapshots);
        if (narrowingInvalidations.Count == 0)
        {
            breakLabel = firstBreakLabel;
            continueLabel = firstContinueLabel;
            return firstBody;
        }

        Diagnostics.TruncateTo(diagnosticCount);
        for (var i = 0; i < narrowingSnapshots.Length; i++)
        {
            var frame = binderCtx.NarrowedVariables[i];
            frame.Clear();
            foreach (var entry in narrowingSnapshots[i])
            {
                frame.Add(entry.Key, entry.Value);
            }
        }

        RestoreDictionary(binderCtx.PendingEarlyExitFrames, pendingEarlyExitFrames);
        RestoreDictionary(binderCtx.PendingSwitchExitFrames, pendingSwitchExitFrames);
        RestoreSet(binderCtx.DefinedUserLabels, definedUserLabels);
        userGotoHandlerRegions.Clear();
        foreach (var region in userGotoHandlerSnapshot)
        {
            userGotoHandlerRegions.Add(region);
        }

        binderCtx.SyntheticLocalCounter = syntheticLocalCounter;

        InvalidateInheritedNarrowings(narrowingInvalidations);
        return BindCore(out breakLabel, out continueLabel);

        BoundStatement BindCore(out BoundLabel localBreakLabel, out BoundLabel localContinueLabel)
        {
            binderCtx.LabelCounter++;
            localBreakLabel = new BoundLabel($"break{binderCtx.LabelCounter}");
            localContinueLabel = new BoundLabel($"continue{binderCtx.LabelCounter}");

            binderCtx.LoopStack.Push((labelName, localBreakLabel, localContinueLabel));
            try
            {
                return Invariant.Required(BindStatement(body), "a loop body has a bound statement");
            }
            finally
            {
                binderCtx.LoopStack.Pop();
            }
        }
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
            var name = syntax.LabelIdentifier.ValueText;
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

        // Issue #3501 A3: the top frame may be a switch (C#/Go alignment —
        // an unlabeled `break` in a switch arm exits the switch, not the
        // enclosing loop). Record the target so the switch appends its
        // break-label statement only when actually jumped to.
        var breakLabel = binderCtx.LoopStack.Peek().BreakLabel;
        binderCtx.UsedBreakLabels.Add(breakLabel);
        return new BoundGotoStatement(syntax, breakLabel);
    }

    /// <summary>
    /// Issue #3501 A3: binds a <c>fallthrough</c> statement (Go semantics).
    /// Legal only as the LAST statement of a non-final switch arm's body —
    /// <c>BindSwitchStatement</c> arms the anchor/target context per arm —
    /// and lowers to a goto targeting the next arm's body-entry label,
    /// skipping that arm's pattern test and guard.
    /// </summary>
    private BoundStatement BindFallthroughStatement(FallthroughStatementSyntax syntax)
    {
        if (!ReferenceEquals(syntax, binderCtx.CurrentFallthroughAnchor))
        {
            Diagnostics.ReportFallthroughNotSupported(syntax.Keyword.Location);
            return BindErrorStatement();
        }

        if (binderCtx.CurrentFallthroughTarget is not { } target)
        {
            // Well-placed, but this is the switch's final arm — there is no
            // next body to fall into.
            Diagnostics.ReportFallthroughInFinalArm(syntax.Keyword.Location);
            return BindErrorStatement();
        }

        return new BoundGotoStatement(syntax, target);
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
            var name = syntax.LabelIdentifier.ValueText;
            foreach (var frame in binderCtx.LoopStack)
            {
                if (frame.LabelName == name && frame.ContinueLabel is { } labeledContinue)
                {
                    return new BoundGotoStatement(syntax, labeledContinue);
                }
            }

            Diagnostics.ReportUnknownLoopLabel(syntax.LabelIdentifier.Location, syntax.Keyword.Text, name);
            return BindErrorStatement();
        }

        // Issue #3501 A3: skip switch frames (null ContinueLabel) — `continue`
        // inside a switch arm still targets the enclosing loop, as in C#/Go.
        foreach (var frame in binderCtx.LoopStack)
        {
            if (frame.ContinueLabel is { } continueLabel)
            {
                return new BoundGotoStatement(syntax, continueLabel);
            }
        }

        Diagnostics.ReportInvalidBreakOrContinue(syntax.Keyword.Location, syntax.Keyword.Text);
        return BindErrorStatement();
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
        BoundExpression? expression;
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
            // Issue #1112 / #1158: a `return switch { … }`, `return if … `, or
            // `return cond ? … : …` honors the function's declared return type
            // as the target type so the result type can unify to the return type
            // (C#-style target-typing) before the conversion below.
            var returnExpression = syntax.Expression;
            while (returnExpression is ParenthesizedExpressionSyntax parenthesized)
            {
                returnExpression = parenthesized.Expression;
            }

            var targetTypesLambdaReturn = returnExpression is LambdaExpressionSyntax lambdaReturn
                && (function == null
                    || !MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(function.Type, out _)
                    || OverloadResolver.ContainsTargetDependentLambda(lambdaReturn));
            if ((targetTypesLambdaReturn
                    || returnExpression is SwitchExpressionSyntax
                    || returnExpression is IfExpressionSyntax
                    || returnExpression is IfLetExpressionSyntax
                    || returnExpression is ConditionalExpressionSyntax
                    || returnExpression is BlockExpressionSyntax
                    || IsNullCoalescingExpression(returnExpression))
                && function != null
                && !function.IsReturnTypeInferred
                && function.Type != TypeSymbol.Void
                && function.Type != TypeSymbol.Error)
            {
                expression = bindExpressionWithTargetType(
                    Invariant.Required(syntax.Expression, "a target-typed return has an expression"),
                    function.Type);
            }
            else
            {
                expression = syntax.Expression == null ? null : bindExpression(syntax.Expression);
            }
        }

        // Issue #490 (ADR-0060 follow-up): validate the `return ref` / `return` form
        // against the function's declared return ref-kind. Then, for ref returns, wrap
        // the operand in a BoundAddressOfExpression and run lvalue + escape-scope checks.
        var isRefReturn = false;
        if (function != null && !function.IsExpressionInitializer)
        {
            var fnIsRefReturning = function.ReturnRefKind == RefKind.Ref;

            if (syntax.IsRefReturn && !fnIsRefReturning)
            {
                Diagnostics.ReportRefReturnInNonRefReturningFunction(
                    Invariant.Required(syntax.RefKeyword, "a ref return has a ref keyword").Location,
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

        if (function?.IsExpressionInitializer == true)
        {
            if (syntax.Expression == null)
            {
                Diagnostics.ReportInvalidReturn(syntax.ReturnKeyword.Location);
            }
            else
            {
                Diagnostics.ReportInvalidReturnExpression(
                    syntax.Expression.Location,
                    function.Name);
            }
        }
        else if (function == null)
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
                    Diagnostics.ReportInvalidReturnExpression(
                        Invariant.Required(syntax.Expression, "a return expression is present").Location,
                        function.Name);
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
                    expression = conversions.BindConversion(
                        Invariant.Required(syntax.Expression, "a return expression is present").Location,
                        expression,
                        function.Type);
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
                    Invariant.Required(syntax.Expression, "a by-ref return expression is present").Location,
                    "a managed pointer (*T) cannot be returned from a function; managed references must not outlive their declaring scope");
            }

            // ADR-0058 / issue #376: a ref struct value with function-local escape scope
            // cannot be returned. This covers:
            // - direct reference to a `scoped` parameter or local
            // - value derived from a scoped source through constructor, member access, etc.
            if (TypeSymbol.IsByRefLike(expression.Type) && HasFunctionLocalEscapeScope(expression))
            {
                Diagnostics.ReportByRefLikeEscape(
                    Invariant.Required(syntax.Expression, "a by-ref-like return expression is present").Location,
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
                Diagnostics.ReportRefReturnRequiresLvalue(
                    Invariant.Required(syntax.Expression, "a ref return expression is present").Location);
            }
            else if (HasFunctionLocalRefScope(expression))
            {
                Diagnostics.ReportRefReturnEscapesLocalScope(
                    Invariant.Required(syntax.Expression, "a ref return expression is present").Location);
            }

            expression = expression is BoundBlockExpression block
                ? new BoundBlockExpression(
                    syntax.Expression,
                    block.Statements,
                    new BoundAddressOfExpression(syntax.Expression, block.Expression))
                : new BoundAddressOfExpression(syntax.Expression, expression);
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
            case BoundBlockExpression block:
                return IsLvalueForRefReturn(block.Expression);
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
                if (fa.Receiver is { Type: StructSymbol s } && s.IsClass)
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
            case BoundBlockExpression block:
                return HasFunctionLocalRefScope(block.Expression);
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

        var nullableType = boundRead.Type as NullableTypeSymbol;
        var isNonNullableReferenceTarget = nullableType == null
            && Conversion.IsReferenceLikeTarget(boundRead.Type)
            && boundRead is BoundIndexExpression or BoundClrIndexExpression;
        if (nullableType == null && !isNonNullableReferenceTarget)
        {
            Diagnostics.ReportNullCoalescingAssignmentTargetNotNullable(syntax.OperatorToken.Location, boundRead.Type);
            _ = bindExpression(syntax.Value, false);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        // Bind the RHS, converting it to the LHS's nullable type so the
        // author can write either an underlying-typed value (which lifts
        // via the implicit T -> T? conversion) or another nullable value.
        var rhsTargetType = nullableType ?? boundRead.Type;
        var boundRhs = bindExpressionWithTargetType(syntax.Value, rhsTargetType);
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
        BoundExpression conditionRead = read;
        if (isNonNullableReferenceTarget)
        {
            conditionRead = new BoundConversionExpression(
                syntax,
                NullableTypeSymbol.Get(read.Type),
                read);
        }

        var nilLiteral = new BoundLiteralExpression(syntax, null, TypeSymbol.Null);
        var eqOp = Invariant.Required(
            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, conditionRead.Type, TypeSymbol.Null),
            "a nullable coalescing assignment target supports nil comparison");
        BoundExpression condition = new BoundBinaryExpression(syntax, conditionRead, eqOp, nilLiteral);

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
    private (BoundExpression? Read, BoundExpression? Write) TryBuildNullCoalescingReadWrite(
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
                if (fieldAccess.InterfaceType != null)
                {
                    if (fieldAccess.Field.IsReadOnly)
                    {
                        Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, fieldAccess.Field.Name);
                        return (null, null);
                    }

                    var interfaceRead = new BoundFieldAccessExpression(
                        syntax,
                        fieldAccess.Field,
                        fieldAccess.InterfaceType,
                        fieldAccess.SubstitutedType);
                    var interfaceWrite = new BoundFieldAssignmentExpression(
                        syntax,
                        fieldAccess.Field,
                        fieldAccess.InterfaceType,
                        boundRhs,
                        fieldAccess.SubstitutedType);
                    return (interfaceRead, interfaceWrite);
                }

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

                // Issue #2043: a static field's bound read has a null
                // Receiver (there is no instance to dereference); only
                // capture a receiver local when one actually exists. Calling
                // CaptureReceiver unconditionally NREs on receiver.Type for
                // the static case.
                var receiver = fieldAccess.Receiver == null
                    ? null
                    : CaptureReceiver(syntax, fieldAccess.Receiver, preStatements);
                var read = new BoundFieldAccessExpression(
                    syntax,
                    receiver,
                    Invariant.Required(fieldAccess.StructType, "a user field access has a declaring struct type"),
                    fieldAccess.Field);

                // Use the VariableSymbol-based constructor: every receiver
                // captured by CaptureReceiver is a BoundVariableExpression
                // (either the original simple variable or a synthetic local
                // that holds the spilled receiver). The interpreter and the
                // existing rewriters all assume this shape for the simple
                // receiver path; routing through ReceiverExpression bypasses
                // the interpreter's class-field write logic (issue #709).
                var write = new BoundFieldAssignmentExpression(
                    syntax,
                    receiver?.Variable,
                    Invariant.Required(fieldAccess.StructType, "a user field assignment has a declaring struct type"),
                    fieldAccess.Field,
                    boundRhs);
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
                var read = new BoundPropertyAccessExpression(
                    syntax,
                    receiver,
                    propAccess.StructType,
                    propAccess.Property,
                    propAccess.SubstitutedType,
                    propAccess.NarrowedType,
                    propAccess.InterfaceType);
                var write = new BoundPropertyAssignmentExpression(
                    syntax,
                    receiver,
                    propAccess.StructType,
                    propAccess.Property,
                    boundRhs,
                    propAccess.SubstitutedType,
                    propAccess.InterfaceType);
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
                var read = new BoundClrPropertyAccessExpression(
                    syntax,
                    receiver,
                    clrPropAccess.Member,
                    clrPropAccess.Type,
                    clrPropAccess.StaticContainerType,
                    clrPropAccess.ConstrainedReceiverTypeParameter,
                    clrPropAccess.ConstrainedInterfaceType);
                var write = new BoundClrPropertyAssignmentExpression(
                    syntax,
                    receiver,
                    clrPropAccess.Member,
                    boundRhs,
                    clrPropAccess.Type,
                    clrPropAccess.StaticContainerType,
                    clrPropAccess.ConstrainedReceiverTypeParameter,
                    clrPropAccess.ConstrainedInterfaceType);
                return (read, write);
            }

            case BoundIndexExpression idx:
            {
                // Spill target and every index so none is re-evaluated.
                var target = CaptureReceiver(syntax, idx.Target, preStatements, forceCapture: true);
                var indices = ImmutableArray.CreateBuilder<BoundExpression>(idx.Indices.Length);
                foreach (var index in idx.Indices)
                {
                    indices.Add(CaptureReceiver(syntax, index, preStatements, forceCapture: true));
                }

                var capturedIndices = indices.MoveToImmutable();
                var read = new BoundIndexExpression(syntax, target, capturedIndices, idx.Type);
                var write = new BoundIndexAssignmentExpression(
                    syntax,
                    target.Variable,
                    capturedIndices,
                    boundRhs,
                    idx.Type);
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
        ImmutableArray<BoundStatement>.Builder preStatements,
        bool forceCapture = false)
    {
        if (!forceCapture && receiver is BoundVariableExpression bve)
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
