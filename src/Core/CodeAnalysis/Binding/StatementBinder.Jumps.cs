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

    /// <summary>
    /// Issue #4285: syntactic (pre-binding) check for whether
    /// <paramref name="node"/> — a function/lambda/local-function BODY, or
    /// any subtree of one — contains any user-written <c>goto</c> statement
    /// or non-loop <c>label:</c> declaration, i.e. any construct that
    /// participates in this function's own goto/label namespace (see
    /// <see cref="DefineUserLabel"/> / <see cref="GetOrCreateUserLabelForGoto"/>).
    /// A <c>label:</c> on a loop (ADR-0070, <see cref="IsLabelableLoop"/>) is
    /// excluded: it only names the loop for <c>break</c>/<c>continue</c> and
    /// is never a valid <c>goto</c> target — only <see cref="DefineUserLabel"/>
    /// populates <see cref="BinderContext.UserLabels"/>, and
    /// <c>BindLabeledStatement</c> never calls it for a loop label — so a
    /// loop label alone cannot create the reachability hazard this check
    /// guards against.
    /// <para>
    /// Does not descend into a nested function-literal or arrow-lambda body
    /// (<see cref="FunctionLiteralExpressionSyntax"/>,
    /// <see cref="LambdaExpressionSyntax"/>): those get their own fresh
    /// goto/label namespace and their own fresh
    /// <see cref="BinderContext.FunctionContainsUserGotoOrLabel"/>, computed
    /// separately by <c>LambdaBinder.EnterNestedFrame</c> when THEIR body is
    /// bound, matching ADR-0070's "label namespace is local to the enclosing
    /// function" rule.
    /// </para>
    /// <para>
    /// Likewise does not descend into a <see cref="FunctionDeclarationSyntax"/>
    /// or <see cref="EventDeclarationSyntax"/> (ADR-0146 "rich" anonymous
    /// object literal method/event members, still present as raw syntax
    /// inline in the enclosing expression even though
    /// <c>Binder.IsRichAnonymousObject</c> binds them via a synthesized
    /// struct declaration): those members are bound as their own,
    /// independent functions through the ordinary struct-method bind path
    /// (one of the <c>Binder.cs</c> call sites that already computes its own
    /// <see cref="BinderContext.FunctionContainsUserGotoOrLabel"/>), so a
    /// <c>goto</c>/label inside one must not mark the syntactically
    /// enclosing OUTER function as goto-bearing too — that would
    /// incorrectly over-suppress the outer function's own, otherwise-valid
    /// narrowing lifts.
    /// </para>
    /// <para>
    /// Used to populate <see cref="BinderContext.FunctionContainsUserGotoOrLabel"/>
    /// once per function-equivalent binding session, which
    /// <see cref="ApplyEarlyExitNarrowings"/> consults to conservatively
    /// suppress the early-exit / post-switch narrowing lift for the WHOLE
    /// body whenever the function contains any goto/label at all, rather
    /// than pinpointing which SPECIFIC lift site a given <c>goto</c> can
    /// actually reach. See the comment on
    /// <see cref="ApplyEarlyExitNarrowings"/> for why a more precise
    /// CFG-based reachability check is a valid future refinement, not
    /// required for this fix.
    /// </para>
    /// </summary>
    internal static bool ContainsUserGotoOrLabel(SyntaxNode? node)
    {
        switch (node)
        {
            case null:
                return false;

            case GotoStatementSyntax:
                return true;

            case LabeledStatementSyntax labeled when !IsLabelableLoop(labeled.Statement):
                return true;

            case FunctionLiteralExpressionSyntax:
            case LambdaExpressionSyntax:
            case FunctionDeclarationSyntax:
            case EventDeclarationSyntax:
                return false;
        }

        foreach (var child in node.GetChildren())
        {
            if (ContainsUserGotoOrLabel(child))
            {
                return true;
            }
        }

        return false;
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
    /// <param name="bindIteration">Optional binder for a repeated header and
    /// body, so both are rebound after inherited narrowing is invalidated.</param>
    private BoundStatement BindLoopBody(
        StatementSyntax body,
        string? labelName,
        out BoundLabel breakLabel,
        out BoundLabel continueLabel,
        int inheritedNarrowingFrameCount = -1,
        BoundStatement? backEdgeTail = null,
        BoundExpression? backEdgeCondition = null,
        Func<(BoundStatement Body, BoundStatement? Tail, BoundExpression? Condition)>? bindIteration = null)
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
                if (bindIteration != null)
                {
                    var iteration = bindIteration();
                    backEdgeTail = iteration.Tail;
                    backEdgeCondition = iteration.Condition;
                    return iteration.Body;
                }

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
            var fnIsRefReturning = function.ReturnRefKind != RefKind.None;

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
            if (!IsLvalueForRefReturn(expression)
                || (function?.ReturnRefKind == RefKind.Ref && RefCapabilities.IsReadOnlyStorage(expression)))
            {
                Diagnostics.ReportRefReturnRequiresLvalue(
                    Invariant.Required(syntax.Expression, "a ref return expression is present").Location);
            }
            else if (HasFunctionLocalRefScope(expression))
            {
                // ADR-0184 (the CS8170 analogue): when the reference is rooted at
                // the enclosing struct member's own receiver, GS0254's
                // "function-local storage" wording is actively misleading — the
                // storage belongs to the CALLER, the member simply has not opted
                // out of the implicit `scoped` on `this`. Name the remedy instead.
                var location = Invariant.Required(syntax.Expression, "a ref return expression is present").Location;

                // GS0589 stays first: the two conditions are provably disjoint
                // (IsRootedAtReceiver requires a `this` root, and a struct
                // `this` is never a read-only reference), but the existing
                // ordering is what the current tests pin.
                if (IsRootedAtReceiver(expression))
                {
                    Diagnostics.ReportUnscopedRefRequiredForInstanceState(location);
                }
                else if (IsDefensivelyCopiedReceiverForwarding(expression))
                {
                    // ADR-0184 amendment: the defensive copy is invisible in
                    // the user's source, so GS0254's "function-local storage"
                    // would point at storage the author never wrote. GS0591
                    // names the copy and the remedy instead.
                    Diagnostics.ReportRefReturnThroughDefensivelyCopiedReceiver(location);
                }
                else
                {
                    Diagnostics.ReportRefReturnEscapesLocalScope(location);
                }
            }

            expression = expression is BoundBlockExpression block
                ? new BoundBlockExpression(
                    syntax.Expression,
                    block.Statements,
                    new BoundAddressOfExpression(syntax.Expression, block.Expression, unmanaged: false, isReadOnly: function?.ReturnRefKind == RefKind.RefReadOnly))
                : new BoundAddressOfExpression(syntax.Expression, expression, unmanaged: false, isReadOnly: function?.ReturnRefKind == RefKind.RefReadOnly);
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
            case BoundClrPropertyAccessExpression { Member: System.Reflection.FieldInfo }:
            case BoundIndexExpression:
                return ExpressionBinder.IsLvalue(expr);
            case BoundDereferenceExpression:
                return true;
            case BoundBlockExpression block:
                return IsLvalueForRefReturn(block.Expression);

            // Issue #4224: `return ref At(...)` — forwarding a native
            // ref-returning call/property read. Delegates to the same
            // classifier ExpressionBinder.IsLvalue uses so the two
            // classifiers do not drift (root cause #2 of issue #4224).
            case BoundCallExpression:
            case BoundUserInstanceCallExpression:
            case BoundPropertyAccessExpression:
                return ExpressionBinder.IsLvalue(expr);
            default:
                return false;
        }
    }

    /// <summary>
    /// ADR-0184: returns true when <paramref name="expr"/> ultimately reads the
    /// enclosing member's own receiver — <c>this.&lt;field&gt;</c>, a nested
    /// <c>this.a.b</c> chain, or the bare-name spelling that lowers to one — as
    /// opposed to a local, a parameter, or heap storage. Distinguishes the
    /// <c>@UnscopedRef</c>-shaped rejection (GS0589) from the generic
    /// escaping-local rejection (GS0254); the walk mirrors
    /// <see cref="HasFunctionLocalRefScope"/>'s own value-type receiver
    /// recursion, so the two agree on which root a reference came from.
    /// </summary>
    /// <param name="expr">The bound <c>return ref</c> operand.</param>
    /// <returns><see langword="true"/> when the reference is rooted at the receiver.</returns>
    private static bool IsRootedAtReceiver(BoundExpression expr)
        => expr switch
        {
            BoundVariableExpression { Variable: ParameterSymbol { IsReceiverParameter: true } } => true,
            BoundFieldAccessExpression { Receiver: { } fieldReceiver } =>
                !Binder.IsReferenceTypeForConstraint(fieldReceiver.Type) && IsRootedAtReceiver(fieldReceiver),
            BoundClrPropertyAccessExpression { Member: System.Reflection.FieldInfo, Receiver: { } clrReceiver } =>
                !Binder.IsReferenceTypeForConstraint(clrReceiver.Type) && IsRootedAtReceiver(clrReceiver),
            BoundBlockExpression block => IsRootedAtReceiver(block.Expression),
            BoundConditionalAddressExpression conditional =>
                IsRootedAtReceiver(conditional.WhenTrueOperand) || IsRootedAtReceiver(conditional.WhenFalseOperand),
            _ => false,
        };

    /// <summary>
    /// ADR-0184 amendment (caller side): true when <paramref name="expr"/>
    /// forwards a reference out of a ref-returning member whose VALUE-TYPE
    /// receiver the emitter replaces with a defensive COPY in a function-local
    /// temp — see <see cref="RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy"/>,
    /// the single rule this and the three emitter copy sites now share. The
    /// member's own <c>return ref</c> was validated against ITS receiver, which
    /// the caller then substitutes; any reference into the receiver's own
    /// storage therefore points at a temp that dies at function exit. Real csc
    /// rejects the C# analogue (CS8156).
    /// <para>
    /// Deliberately EXCLUDES the Span-shaped CLR indexer branch: that result
    /// points into the ENCAPSULATED BUFFER the receiver merely wraps, not into
    /// the receiver's own storage, so copying the receiver (its pointer and
    /// length) does not disturb the referent at all — issue #4265's premise,
    /// still correct. The exclusion lapses exactly when the CLR author marked
    /// the indexer <c>[UnscopedRef]</c>, which declares the opposite.
    /// </para>
    /// <para>
    /// The <c>BoundDereferenceExpression</c> arm is load bearing for DIAGNOSTIC
    /// SELECTION only, never for soundness: <c>ConversionClassifier.AutoDereferenceRefReturn</c>
    /// wraps every imported/CLR ref-returning member read in one, so without it
    /// the CLR-indexer case below is still correctly REJECTED (hook A sees the
    /// unwrapped node through <see cref="HasFunctionLocalRefScope"/>'s own
    /// dereference recursion) but is reported as the generic GS0254 instead of
    /// GS0591. Adding it cannot over-reject: this predicate is consulted only
    /// after <see cref="HasFunctionLocalRefScope"/> has already said no.
    /// </para>
    /// </summary>
    /// <param name="expr">The bound <c>return ref</c> operand.</param>
    /// <returns><see langword="true"/> when the forward crosses a defensively copied receiver.</returns>
    private static bool IsDefensivelyCopiedReceiverForwarding(BoundExpression expr)
    {
        switch (expr)
        {
            case BoundBlockExpression block:
                return IsDefensivelyCopiedReceiverForwarding(block.Expression);

            case BoundDereferenceExpression dereference:
                return IsDefensivelyCopiedReceiverForwarding(dereference.Operand);

            case BoundConditionalAddressExpression conditional:
                return IsDefensivelyCopiedReceiverForwarding(conditional.WhenTrueOperand)
                    || IsDefensivelyCopiedReceiverForwarding(conditional.WhenFalseOperand);

            // Own-storage CLR indexer only — mirrors the ELSE arm of
            // HasFunctionLocalRefScope's BoundClrIndexExpression case exactly,
            // so the two agree on which indexers read the receiver's own
            // storage and which read an encapsulated buffer.
            case BoundClrIndexExpression clrIndex
                when !TypeSymbol.IsByRefLike(clrIndex.Target.Type)
                    || RefCapabilities.IsUnscopedRefIndexerGetter(clrIndex.Indexer):
                return !Binder.IsReferenceTypeForConstraint(clrIndex.Target.Type)
                    && RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(
                        clrIndex.Target,
                        clrIndex.Indexer.GetMethod is { } getter && RefCapabilities.IsReadOnlyMethod(getter));

            default:
                // isReadOnlyMember is omitted (defaults false): G# has no
                // `readonly func`, so a NATIVE ref-returning member is never
                // exempt from the copy. A future `readonly` member feature MUST
                // thread it through here.
                return RefCapabilities.TryGetRefReturnEscapeSources(expr, out var receiver, out _, out _)
                    && receiver != null
                    && !Binder.IsReferenceTypeForConstraint(receiver.Type)
                    && RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(receiver);
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
                // NOTE: this also covers a by-value byref-like (ref struct, e.g. Span<T>)
                // parameter's OWN storage — its fields are a function-local copy exactly
                // like any other by-value struct. Only the REFERENT such a value
                // encapsulates (Span<T>'s backing pointer) gets caller scope; see
                // HasFunctionLocalReferentScope below (issue #4265) for that narrower case.
                if (v.Variable is ParameterSymbol p)
                {
                    // ADR-0184 / issue #376: an `@UnscopedRef` struct member's
                    // receiver is the one RefKind.None parameter whose storage
                    // is NOT a function-local by-value slot — the CLR passes a
                    // struct's `this` as `ref S`, so its ref-safe-context is the
                    // caller's once the member opts out of the implicit `scoped`.
                    return p.IsScoped || (p.RefKind == RefKind.None && !p.IsUnscopedRefReceiver);
                }

                if (v.Variable is GlobalVariableSymbol)
                {
                    return false;
                }

                // Any other LocalVariableSymbol (let/var inside the function body) is local-scope.
                return v.Variable is LocalVariableSymbol local
                    && (local.RefKind == RefKind.None || local.IsScoped);
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
            case BoundClrPropertyAccessExpression { Member: System.Reflection.FieldInfo } field:
                return field.Receiver != null
                    && !Binder.IsReferenceTypeForConstraint(field.Receiver.Type)
                    && HasFunctionLocalRefScope(field.Receiver);

            // Issue #4265: a CLR indexer's `ref`/`ref readonly` result (e.g.
            // Span<T>/ReadOnlySpan<T>'s indexer) DEREFERENCES a reference the
            // target already encapsulates (its backing pointer) — unlike an
            // ordinary field access, which reads the target's OWN storage
            // slot. A reference-type target is heap-backed regardless of
            // scope; a byref-like (ref struct) target's encapsulated
            // referent gets HasFunctionLocalReferentScope's caller-scope
            // treatment below. A plain value-type target (never actually
            // reached in practice — a CLR indexer's target is always a
            // reference type or a byref-like BCL type such as Span<T> —
            // kept for symmetry/defense-in-depth) still inherits its own
            // storage scope via the ordinary recursive walk.
            //
            // SOUNDNESS GUARD (found in review of #4265, before merge): the
            // "encapsulated referent" premise holds for Span<T>-shaped
            // indexers, which never expose a ref into their OWN receiver's
            // storage — but nothing in the CLR type system enforces that.
            // An externally-compiled ref struct can legally declare a
            // getter marked [UnscopedRef] (System.Diagnostics.CodeAnalysis)
            // that returns `ref` to one of ITS OWN fields — the exact
            // Acc.Total shape this file's other #4265 guard exists to
            // reject, just authored in a referenced assembly instead of
            // natively. Real C# tracks this precisely: forwarding such a
            // member through a by-value parameter is rejected (CS8166),
            // because [UnscopedRef] inverts the receiver's contribution
            // from safe-to-escape (caller scope) to ref-safe-context
            // (function-local). Confirmed by direct repro: without this
            // guard, `func M(buf RingBuffer) ref int32 { return ref buf[0] }`
            // over such a type compiled clean and the returned reference
            // pointed at dead stack memory (an intervening call's locals
            // silently overwrote the "aliased" value on read-back).
            // RefCapabilities.IsUnscopedRefIndexerGetter inspects the
            // resolved indexer (both the property and its getter — C#
            // allows the attribute on either) for that attribute so this
            // path falls back to the strict HasFunctionLocalRefScope
            // treatment exactly when the CLR author has declared the same
            // intent @UnscopedRef signals for a native G# member.
            case BoundClrIndexExpression clrIndex:
                if (NativeSliceTypes.TryGetElement(clrIndex.Target.Type, out _, out _))
                {
                    return false;
                }

                // ADR-0184 amendment (hook A): an [UnscopedRef] CLR indexer
                // reached through a READ-ONLY reference is copied before the
                // call exactly like a native member would be, so its result
                // aliases the copy. The Span-shaped branch below is unaffected
                // — IsDefensivelyCopiedReceiverForwarding excludes it.
                if (IsDefensivelyCopiedReceiverForwarding(clrIndex))
                {
                    return true;
                }

                return TypeSymbol.IsByRefLike(clrIndex.Target.Type)
                    && !RefCapabilities.IsUnscopedRefIndexerGetter(clrIndex.Indexer)
                    ? HasFunctionLocalReferentScope(clrIndex.Target)
                    : !Binder.IsReferenceTypeForConstraint(clrIndex.Target.Type)
                        && HasFunctionLocalRefScope(clrIndex.Target);
            case BoundDereferenceExpression deref:
                // A pointer parameter's referent is not its by-value parameter slot.
                // Local pointers conservatively retain function-local scope.
                return deref.Operand is BoundVariableExpression { Variable: ParameterSymbol pointerParameter }
                    ? pointerParameter.IsScoped
                    : HasFunctionLocalRefScope(deref.Operand);
            case BoundBlockExpression block:
                return HasFunctionLocalRefScope(block.Expression);
            case BoundConditionalAddressExpression condAddr:
                return HasFunctionLocalRefScope(condAddr.WhenTrueOperand)
                    || HasFunctionLocalRefScope(condAddr.WhenFalseOperand);

            // Issue #4224 (root cause #4): a native ref-returning call/property
            // read escapes only as far as the storage it could be forwarding —
            // its instance receiver (a struct receiver's storage), any
            // ref/in/out argument's underlying storage, and (issue #4265)
            // any non-`scoped` by-value byref-like argument's encapsulated
            // referent. The callee's OWN `return ref` was already validated
            // against this same scope check when the callee itself was
            // bound, so a plain (non-byref-like) by-value parameter or a
            // class receiver can never be the source of the returned
            // reference; only a borrowed (ref/in/out, non-`scoped`)
            // argument, a struct receiver, or a by-value byref-like
            // argument's referent can.
            default:
                if (RefCapabilities.TryGetRefReturnEscapeSources(
                    expr, out var callReceiver, out var byRefArguments, out var byValueByRefLikeArguments))
                {
                    // ADR-0184 amendment (hook B): checked BEFORE the receiver's
                    // own storage scope, because a defensively copied receiver
                    // is function-local even when the storage it was copied
                    // FROM is the caller's — and, per C#'s narrowest-of rule,
                    // even when the reference ultimately comes from one of the
                    // ref arguments below rather than from the receiver.
                    if (IsDefensivelyCopiedReceiverForwarding(expr))
                    {
                        return true;
                    }

                    if (callReceiver != null
                        && !Binder.IsReferenceTypeForConstraint(callReceiver.Type)
                        && HasFunctionLocalRefScope(callReceiver))
                    {
                        return true;
                    }

                    foreach (var argument in byRefArguments)
                    {
                        if (HasFunctionLocalRefScope(argument))
                        {
                            return true;
                        }
                    }

                    // Issue #4265: a by-value byref-like argument is checked against
                    // its REFERENT's scope, not its own storage's scope — see
                    // HasFunctionLocalReferentScope. Using HasFunctionLocalRefScope
                    // here instead (like the ref/in/out arguments above) would be
                    // WRONG in the other direction: it would reject every such
                    // forwarding chain outright, since a plain by-value parameter is
                    // always function-local by that check's own (correct, for a
                    // field access) rule.
                    foreach (var argument in byValueByRefLikeArguments)
                    {
                        if (HasFunctionLocalReferentScope(argument))
                        {
                            return true;
                        }
                    }

                    return false;
                }

                return true;
        }
    }

    /// <summary>
    /// Issue #4265: the ref-safe-to-escape scope of the REFERENT a by-value
    /// byref-like (ref struct, e.g. <c>Span[T]</c>) value encapsulates — as
    /// opposed to <see cref="HasFunctionLocalRefScope"/>, which answers for
    /// the value's OWN storage (its fields; see that method's
    /// <c>BoundFieldAccessExpression</c> case, which this does not change).
    /// Mirrors the <c>BoundDereferenceExpression</c> pointer-parameter case
    /// in <see cref="HasFunctionLocalRefScope"/> exactly: a non-scoped
    /// by-value parameter's encapsulated reference is caller-supplied (the
    /// caller already guaranteed its lifetime by constructing/passing the
    /// value), so only a directly-named non-scoped parameter is
    /// caller-scoped here; any other shape (a local, a nested call result,
    /// ...) conservatively falls back to the function-local-by-default walk,
    /// since this compiler does not yet track how a ref-struct LOCAL's own
    /// encapsulated reference was constructed (e.g. <c>stackalloc</c> vs.
    /// wrapping a heap array) with C#'s full precision.
    /// </summary>
    private static bool HasFunctionLocalReferentScope(BoundExpression expr)
        => expr is BoundVariableExpression { Variable: ParameterSymbol p }
            ? p.IsScoped
            : HasFunctionLocalRefScope(expr);

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
            //
            // ADR-0184 D1 (conformance fix): the enclosing member's RECEIVER is
            // excluded. `this` carries an implicit `scoped` on its REF-safe-context
            // only — its VALUE-scope (safe-to-escape) is the caller's context, since
            // the receiver's value was produced by, and outlives, the call. Real C#
            // draws exactly this split, so `return this;` BY VALUE out of a
            // `ref struct` instance method is legal with or without `@UnscopedRef`;
            // the pre-ADR-0184 code conflated the two and reported GS0219 for it.
            case BoundVariableExpression varExpr:
                return varExpr.Variable is LocalVariableSymbol local
                    && local.IsScoped
                    && local is not ParameterSymbol { IsReceiverParameter: true };

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

        // ADR-0186 §6: `??=` accepts a `T!` left operand and GS0298 does not
        // fire. GS0298 exists to reject a target that can never be nil, and a
        // platform target genuinely can be — that is what oblivious means.
        // The target's `T?` view drives the rest of this method unchanged:
        // the two wrappers share one CLR representation (§1), so the
        // synthesized `read == nil` test and the write-back are identical.
        if (nullableType == null && boundRead.Type is PlatformTypeSymbol platformTarget)
        {
            nullableType = NullableTypeSymbol.Get(platformTarget.UnderlyingType);
        }

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
