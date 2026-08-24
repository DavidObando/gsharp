// <copyright file="StatementBinder.Blocks.cs" company="GSharp">
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

internal sealed partial class StatementBinder
{
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
        Dictionary<AccessPath, TypeSymbol>? mergedExitFrame = null;
        var mergeFailed = false;

        // Issue #3501 A3: (a) an unlabeled `break` inside an arm exits the
        // switch — push a LoopStack frame whose ContinueLabel is null so
        // `continue` still binds to the enclosing loop; (b) an arm whose
        // body ENDS in `fallthrough` jumps to the NEXT arm's body-entry
        // label, skipping that arm's pattern test and guard (Go semantics).
        binderCtx.LabelCounter++;
        var switchOrdinal = binderCtx.LabelCounter;
        var switchBreakLabel = new BoundLabel($"switchBreak{switchOrdinal}");
        var armEntryLabels = new BoundLabel?[syntax.Cases.Length];
        var savedFallthroughTarget = binderCtx.CurrentFallthroughTarget;
        var savedFallthroughAnchor = binderCtx.CurrentFallthroughAnchor;
        binderCtx.LoopStack.Push((null, switchBreakLabel, null));
        try
        {
        for (var caseIndex = 0; caseIndex < syntax.Cases.Length; caseIndex++)
        {
            var caseSyntax = syntax.Cases[caseIndex];

            // Issue #3501 A3: arm the fallthrough context for this arm. The
            // one legal position is the body's last statement; a trailing
            // fallthrough in a non-final arm targets the next arm's entry
            // label (created on demand, prepended when that arm binds).
            var trailingStatement = caseSyntax.Body.Statements.Length > 0
                ? caseSyntax.Body.Statements[caseSyntax.Body.Statements.Length - 1]
                : null;
            var endsInFallthrough = trailingStatement is FallthroughStatementSyntax;
            binderCtx.CurrentFallthroughAnchor = endsInFallthrough ? trailingStatement : null;
            binderCtx.CurrentFallthroughTarget = endsInFallthrough && caseIndex < syntax.Cases.Length - 1
                ? armEntryLabels[caseIndex + 1] ??= new BoundLabel($"switchArm{switchOrdinal}_{caseIndex + 1}")
                : null;

            if (caseSyntax.IsDefault)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(caseSyntax.Keyword.Location);
                }

                hasDefault = true;
                var defaultBody = BindBlockStatement(caseSyntax.Body);
                defaultBody = PrependArmEntryLabel(defaultBody, armEntryLabels[caseIndex]);
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
            var caseValue = Invariant.Required(caseSyntax.Value, "a non-default switch case has a pattern value");
            var pattern = patterns.BindPattern(caseValue, switchType);

            // Issue #3501 A3: a fallthrough INTO this arm skips its pattern
            // test — pattern bindings and guards would run unassigned/
            // unevaluated, so such targets are rejected. Pattern-declared
            // variables live in the arm scope just pushed above.
            if (armEntryLabels[caseIndex] != null
                && (scope.GetDeclaredVariables().Length > 0 || caseSyntax.Guard != null))
            {
                var previousCase = syntax.Cases[caseIndex - 1];
                var fallthroughKeyword = previousCase.Body.Statements[previousCase.Body.Statements.Length - 1];
                Diagnostics.ReportFallthroughTargetHasBindings(fallthroughKeyword.Location);
            }

            // Issue #991: a guarded arm (`when <bool>`) can always fail at
            // runtime, so a guarded discard `case _ when …` does NOT act as a
            // default/total arm.
            var guardSyntax = caseSyntax.Guard;
            var hasGuard = guardSyntax != null;
            if (pattern is BoundDiscardPattern && !hasGuard)
            {
                if (hasDefault)
                {
                    Diagnostics.ReportDuplicateSwitchDefault(caseValue.Location);
                }

                hasDefault = true;
            }

            var frame = TryClassifyPatternNarrowing(discriminant, pattern);
            BoundExpression? guard = null;
            if (hasGuard)
            {
                guard = BindGuardExpressionWithNarrowing(
                    Invariant.Required(guardSyntax, "a guarded switch case has a guard expression"),
                    frame);
            }

            // ADR-0166: the arm body runs only when the guard was true, so the
            // guard's when-true pattern variables (`when x.Tag is string tag`)
            // are in scope there.
            var (guardWhenTrue, _) = PatternVariables.Classify(guard);
            var body = PatternVariables.BindInScope(
                binderCtx,
                guardWhenTrue,
                () =>
                {
                    return BindStatementWithNarrowing(caseSyntax.Body, frame);
                });

            scope = scope.Pop();
            body = PrependArmEntryLabel(body, armEntryLabels[caseIndex]);
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
                mergedExitFrame = new Dictionary<AccessPath, TypeSymbol>(frame);
                continue;
            }

            // Intersect with the running merge. Only variables narrowed to
            // the same type by every fall-through arm survive.
            var next = new Dictionary<AccessPath, TypeSymbol>();
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
        }
        finally
        {
            binderCtx.LoopStack.Pop();
            binderCtx.CurrentFallthroughTarget = savedFallthroughTarget;
            binderCtx.CurrentFallthroughAnchor = savedFallthroughAnchor;
        }

        var boundArms = arms.ToImmutable();
        var isExhaustive = ExhaustivenessAnalyzer.AnalyzeSwitchStatement(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            scope.GetDeclaredStructs(),
            Diagnostics);

        var result = new BoundPatternSwitchStatement(null, discriminant, boundArms, isExhaustive);

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

        // Issue #3501 A3: when an arm actually used `break`, its goto targets
        // the statement position right after the switch — append the label
        // there. Switches with no arm-level break keep their bare shape (so
        // exhaustive all-arms-return switches still read as unconditional
        // exits to the all-paths-return check).
        if (binderCtx.UsedBreakLabels.Contains(switchBreakLabel))
        {
            return new BoundBlockStatement(
                syntax,
                ImmutableArray.Create<BoundStatement>(result, new BoundLabelStatement(null, switchBreakLabel)));
        }

        return result;
    }

    /// <summary>
    /// Issue #3501 A3: prepends the arm's body-entry label — the target a
    /// <c>fallthrough</c> in the PREVIOUS arm jumps to — when one was
    /// requested; returns the body unchanged otherwise.
    /// </summary>
    private static BoundStatement PrependArmEntryLabel(BoundStatement body, BoundLabel? entryLabel)
    {
        if (entryLabel == null)
        {
            return body;
        }

        return new BoundBlockStatement(
            body.Syntax,
            ImmutableArray.Create<BoundStatement>(new BoundLabelStatement(null, entryLabel), body));
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
            exceptionHandlerRegions.Push(catchSyntax);
            BoundStatement body;
            try
            {
                body = BindBlockStatement(catchSyntax.Body);
            }
            finally
            {
                exceptionHandlerRegions.Pop();
            }

            scope = scope.Pop();

            catches.Add(new BoundCatchClause(catchType, variable, body));
        }

        BoundStatement? finallyBlock = null;
        if (syntax.FinallyClause != null)
        {
            exceptionHandlerRegions.Push(syntax.FinallyClause);
            try
            {
                finallyBlock = BindBlockStatement(syntax.FinallyClause.Body);
            }
            finally
            {
                exceptionHandlerRegions.Pop();
            }
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
            return Invariant.Required(usingLowering.ErrorStatement, "an invalid using lowering has an error statement");
        }

        var cleanup = usingLowering.Cleanup;
        var initialized = Invariant.Required(usingLowering.Initialized, "a valid using lowering has an initialization flag");
        var tryStmt = BuildCleanupTryStatement(
            ImmutableArray<BoundStatement>.Empty,
            cleanup,
            initialized);
        return new BoundBlockStatement(
            syntax,
            ImmutableArray.Create<BoundStatement>(
                Invariant.Required(usingLowering.InitializedDeclaration, "a valid using lowering has an initialization declaration"),
                usingLowering.Declaration,
                BuildInitializedAssignment(initialized),
                tryStmt));
    }

    private (
        BoundVariableDeclaration? InitializedDeclaration,
        BoundVariableDeclaration Declaration,
        VariableSymbol? Initialized,
        BoundExpression? Cleanup,
        BoundStatement? ErrorStatement) BindUsingStatementInBlock(UsingStatementSyntax syntax)
    {
        var declaration = (BoundVariableDeclaration)BindVariableDeclaration(syntax.Declaration);
        var disposeCall = conversions.TryBuildDisposeCall(declaration.Variable, syntax.UsingKeyword.Location);
        if (disposeCall == null)
        {
            return (null, declaration, null, null, BindErrorStatement());
        }

        var initialized = new LocalVariableSymbol(
            "<>usingInitialized" + usingInitializationFlagCount++,
            isReadOnly: false,
            TypeSymbol.Bool);
        var initializedDeclaration = new BoundVariableDeclaration(
            null,
            initialized,
            new BoundLiteralExpression(null, false));
        return (initializedDeclaration, declaration, initialized, disposeCall, null);
    }

    private BoundStatement BindAwaitUsingStatement(AwaitUsingStatementSyntax syntax)
    {
        var awaitUsingLowering = BindAwaitUsingStatementInBlock(syntax);
        if (awaitUsingLowering.Cleanup == null)
        {
            return Invariant.Required(awaitUsingLowering.ErrorStatement, "an invalid await using lowering has an error statement");
        }

        var cleanup = awaitUsingLowering.Cleanup;
        var initialized = Invariant.Required(awaitUsingLowering.Initialized, "a valid await using lowering has an initialization flag");
        var declaration = Invariant.Required(awaitUsingLowering.Declaration, "a valid await using lowering has a declaration");
        var tryStmt = BuildCleanupTryStatement(
            ImmutableArray<BoundStatement>.Empty,
            cleanup,
            initialized);
        return new BoundBlockStatement(
            syntax,
            ImmutableArray.Create<BoundStatement>(
                Invariant.Required(awaitUsingLowering.InitializedDeclaration, "a valid await using lowering has an initialization declaration"),
                declaration,
                BuildInitializedAssignment(initialized),
                tryStmt));
    }

    private (
        BoundVariableDeclaration? InitializedDeclaration,
        BoundVariableDeclaration? Declaration,
        VariableSymbol? Initialized,
        BoundExpression? Cleanup,
        BoundStatement? ErrorStatement) BindAwaitUsingStatementInBlock(AwaitUsingStatementSyntax syntax)
    {
        // Gate: await using let requires an async context.
        if (function == null || !function.IsAsync)
        {
            Diagnostics.ReportAwaitUsingOutsideAsyncFunction(syntax.AwaitKeyword.Location);
            return (null, null, null, null, BindErrorStatement());
        }

        var declaration = (BoundVariableDeclaration)BindVariableDeclaration(syntax.Declaration);
        var disposeAsyncCall = conversions.TryBuildDisposeAsyncCall(declaration.Variable, syntax.AwaitKeyword.Location);
        if (disposeAsyncCall == null)
        {
            return (null, declaration, null, null, BindErrorStatement());
        }

        var initialized = new LocalVariableSymbol(
            "<>usingInitialized" + usingInitializationFlagCount++,
            isReadOnly: false,
            TypeSymbol.Bool);
        var initializedDeclaration = new BoundVariableDeclaration(
            null,
            initialized,
            new BoundLiteralExpression(null, false));
        return (initializedDeclaration, declaration, initialized, disposeAsyncCall, null);
    }

    private BoundStatement BindDeferStatement(DeferStatementSyntax syntax)
    {
        var defer = BindDeferStatementInBlock(syntax);
        if (defer.Cleanup == null)
        {
            return Invariant.Required(defer.ErrorStatement, "an invalid defer lowering has an error statement");
        }

        var tryStmt = BuildCleanupTryStatement(ImmutableArray<BoundStatement>.Empty, defer.Cleanup);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.AddRange(defer.PrefixStatements);
        statements.Add(tryStmt);
        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    private (ImmutableArray<BoundStatement> PrefixStatements, BoundExpression? Cleanup, BoundStatement? ErrorStatement) BindDeferStatementInBlock(DeferStatementSyntax syntax)
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

        // Issue #1635 NB-1: a by-ref (ref/out/in) argument's bound value IS the
        // address of its target storage (a BoundAddressOfExpression /
        // BoundConditionalAddressExpression). Eager capture spills each
        // argument's *value* into a fresh readonly local, which for a by-ref
        // argument would spill the address into an ordinary (non-ref) local —
        // not supported by the emitter and not a meaningful by-ref capture.
        // Reject rather than silently mis-defer.
        if (HasByRefArgument(expression))
        {
            Diagnostics.ReportDeferOperandHasByRefArgument(syntax.Expression.Location);
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

    // A ref/out/in argument is bound as the ADDRESS of its target storage —
    // a BoundAddressOfExpression or BoundConditionalAddressExpression — for
    // every deferable call kind (user function, imported function/method).
    // Detecting the argument shape directly (rather than only consulting
    // ArgumentRefKinds, which not every call kind historically carried) catches every
    // by-ref argument regardless of which call kind wraps it.
    private static bool HasByRefArgument(BoundExpression expression)
    {
        var arguments = expression switch
        {
            BoundCallExpression call => call.Arguments,
            BoundImportedCallExpression call => call.Arguments,
            BoundUserInstanceCallExpression call => call.Arguments,
            BoundImportedInstanceCallExpression call => call.Arguments,
            BoundIndirectCallExpression call => call.Arguments,
            _ => ImmutableArray<BoundExpression>.Empty,
        };

        foreach (var argument in arguments)
        {
            if (argument is BoundAddressOfExpression or BoundConditionalAddressExpression)
            {
                return true;
            }
        }

        return false;
    }

    // ADR-0030 / issue #1635 (NB-1 follow-up): rebuild the deferred call with the
    // SAME node kind and EVERY metadata property the original call carried —
    // constrained-interface dispatch info, explicit type arguments, non-virtual
    // base-call marking, ref-kind annotations, static generic owner types, etc.
    // Only the receiver/target and arguments change (to the captured `$defer$`
    // locals); nothing else may be dropped or the deferred call can emit wrong
    // dispatch or invalid metadata.
    private BoundExpression CaptureDeferArguments(BoundExpression expression, ImmutableArray<BoundStatement>.Builder prefix)
    {
        switch (expression)
        {
            case BoundCallExpression call:
                return new BoundCallExpression(null, call.Function, CaptureArguments(call.Arguments, prefix), call.ReturnType, call.IsConditionalElided)
                {
                    StaticGenericOwnerType = call.StaticGenericOwnerType,
                    StaticGenericInterfaceOwnerType = call.StaticGenericInterfaceOwnerType,
                    MethodTypeArguments = call.MethodTypeArguments,
                };
            case BoundIndirectCallExpression call:
                return new BoundIndirectCallExpression(null, CaptureExpression(call.Target, prefix), call.FunctionType, CaptureArguments(call.Arguments, prefix), call.ArgumentRefKinds);
            case BoundUserInstanceCallExpression call:
                return new BoundUserInstanceCallExpression(
                    null,
                    CaptureExpression(call.Receiver, prefix),
                    call.Method,
                    CaptureArguments(call.Arguments, prefix),
                    call.Type,
                    call.ConstrainedReceiverTypeParameter,
                    call.ConstrainedInterfaceType)
                {
                    MethodTypeArguments = call.MethodTypeArguments,
                };
            case BoundImportedCallExpression call:
                return new BoundImportedCallExpression(
                    null,
                    call.Function,
                    CaptureArguments(call.Arguments, prefix),
                    call.ArgumentRefKinds,
                    call.TypeArgumentSymbols,
                    call.StaticContainerType);
            case BoundImportedInstanceCallExpression call:
                return new BoundImportedInstanceCallExpression(
                    null,
                    CaptureExpression(call.Receiver, prefix),
                    call.Method,
                    call.Type,
                    CaptureArguments(call.Arguments, prefix),
                    call.ArgumentRefKinds,
                    call.TypeArgumentSymbols,
                    call.ConstrainedReceiverTypeParameter,
                    call.ConstrainedInterfaceType,
                    call.IsNonVirtualBaseCall);
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
            capturedArguments.Add(CaptureExpression(argument, prefix));
        }

        return capturedArguments.ToImmutable();
    }

    // ADR-0030 / issue #1635: `defer` evaluates the call target eagerly (function value,
    // receiver, and arguments), then invokes it at scope exit. Spill the receiver/indirect
    // target the same way arguments are spilled, so reassigning it afterwards can't change
    // which value the deferred call runs against.
    private BoundExpression CaptureExpression(BoundExpression expression, ImmutableArray<BoundStatement>.Builder prefix)
    {
        var variable = new LocalVariableSymbol($"$defer$arg${binderCtx.DeferArgumentCounter++}", isReadOnly: true, expression.Type ?? TypeSymbol.Error);
        scope.TryDeclareVariable(variable);
        prefix.Add(new BoundVariableDeclaration(null, variable, expression));
        return new BoundVariableExpression(null, variable);
    }

    private BoundStatement BindGoStatement(GoStatementSyntax syntax)
    {
        // ADR-0082 / issue #722: gate the `go expr` statement on
        // `import Gsharp.Extensions.Go`. Report GS0316 if the import is
        // missing, then continue binding so downstream diagnostics about
        // the operand's call-shape still surface.
        binderCtx.ReportIfGoExtensionsImportMissing(syntax, syntax.GoKeyword.Location, "go");

        // Issue #3304: the spawned call's result is discarded (ADR-0022), so
        // a void-returning operand is the natural goroutine shape — bind with
        // canBeVoid so GS0124 does not force `return 0` boilerplate onto
        // goroutine bodies. Non-call operands are still rejected below
        // (GS0137), and the emit path already wraps a non-Task operand in an
        // Action-shaped thunk whose body is an expression statement.
        var expression = bindExpression(syntax.Expression, canBeVoid: true);

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

        // Issue #3501 A3: Go alignment — an unlabeled `break` inside a select
        // arm exits the SELECT (same frame shape as switch: null ContinueLabel
        // keeps `continue` bound to the enclosing loop).
        binderCtx.LabelCounter++;
        var selectBreakLabel = new BoundLabel($"selectBreak{binderCtx.LabelCounter}");
        binderCtx.LoopStack.Push((null, selectBreakLabel, null));
        try
        {
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
                bound.Add(new BoundSelectCase(
                    SelectCaseKind.Default,
                    channel: null,
                    value: null,
                    variable: null,
                    Invariant.Required(defaultBody, "a select case has a bound body")));
                continue;
            }

            // All non-default arms reference a channel.
            var channelSyntax = Invariant.Required(caseSyntax.Channel, "a non-default select case has a channel");
            var channelExpr = bindExpression(channelSyntax);
            var chan = channelExpr.Type as ChannelTypeSymbol;
            if (channelExpr is BoundErrorExpression || chan == null)
            {
                if (chan == null && channelExpr is not BoundErrorExpression)
                {
                    if (caseSyntax.CaseKind == SelectCaseKind.Send)
                    {
                        Diagnostics.ReportSendTargetIsNotChannel(channelSyntax.Location, channelExpr.Type);
                    }
                    else
                    {
                        Diagnostics.ReportReceiveOperandIsNotChannel(channelSyntax.Location, channelExpr.Type);
                    }
                }

                // Best-effort recover: bind the body anyway so further
                // diagnostics surface.
                var recoveredBody = BindStatement(caseSyntax.Body);
                bound.Add(new BoundSelectCase(
                    caseSyntax.CaseKind,
                    channelExpr,
                    value: null,
                    variable: null,
                    Invariant.Required(recoveredBody, "a recovered select case has a bound body")));
                continue;
            }

            BoundExpression? valueExpr = null;
            VariableSymbol? variable = null;
            BoundStatement body;

            if (caseSyntax.CaseKind == SelectCaseKind.Send)
            {
                valueExpr = conversions.BindConversion(
                    Invariant.Required(caseSyntax.Value, "send select cases have a value expression"),
                    chan.ElementType);
                body = Invariant.Required(BindStatement(caseSyntax.Body), "a send select case has a bound body");
            }
            else if (caseSyntax.CaseKind == SelectCaseKind.ReceiveBind)
            {
                // Introduce a scope so the bound variable is visible only inside
                // the case body — matches `for v := range` lexical hygiene.
                scope = new BoundScope(scope);
                var identifier = Invariant.Required(caseSyntax.Identifier, "a receive-bind select case has an identifier");
                variable = new LocalVariableSymbol(identifier.Text, isReadOnly: true, chan.ElementType, declaringSyntax: identifier);
                if (!scope.TryDeclareVariable(variable))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, identifier.Text);
                }

                body = Invariant.Required(BindStatement(caseSyntax.Body), "a receive-bind select case has a bound body");

                scope = scope.Pop();
            }
            else
            {
                // ReceiveDiscard
                body = Invariant.Required(BindStatement(caseSyntax.Body), "a receive-discard select case has a bound body");
            }

            bound.Add(new BoundSelectCase(caseSyntax.CaseKind, channelExpr, valueExpr, variable, body));
        }
        }
        finally
        {
            binderCtx.LoopStack.Pop();
        }

        var selectResult = new BoundSelectStatement(syntax, bound.ToImmutable());
        if (binderCtx.UsedBreakLabels.Contains(selectBreakLabel))
        {
            return new BoundBlockStatement(
                syntax,
                ImmutableArray.Create<BoundStatement>(selectResult, new BoundLabelStatement(null, selectBreakLabel)));
        }

        return selectResult;
    }

    private BoundStatement BindScopeStatement(ScopeStatementSyntax syntax)
    {
        // Phase 5.7 / ADR-0022: structured concurrency. The body's `go`
        // statements register with the scope at evaluation time; the binder
        // itself just wraps the body. Open a fresh lexical scope so any
        // future implicit binding (e.g. `ctx`) can be introduced without
        // leaking into the enclosing function.
        scope = new BoundScope(scope);
        var body = Invariant.Required(BindStatement(syntax.Body), "a scope statement has a bound body");

        scope = scope.Pop();
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

        ReportSuspensionPointsInFixedBody(syntax.Body);

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
            else if (TryGetPinnableReference(source.Type, out _, out var pinnableElementClr))
            {
                // ADR-0125 / issue #1043: span-like pin form — any type exposing a
                // public instance `ref T GetPinnableReference()` (canonically
                // `System.Span[T]` / `System.ReadOnlySpan[T]`). Pin the `T&`
                // returned by `GetPinnableReference()` into a `T& pinned` local and
                // derive the `*T` via `conv.u`, mirroring C# `fixed (T* p = span)`.
                // `ReadOnlySpan[T].GetPinnableReference()` returns `ref readonly T`
                // (a `modreq(InAttribute)` ref-return); the method-reference
                // encoder reproduces that modreq (see EncodeReturnClr).
                pinKind = FixedPinKind.PinnableReference;
                elementType = ResolvePinnableElementType(
                    source.Type,
                    Invariant.Required(pinnableElementClr, "a successful pinnable lookup has an element type"));
                pinnedUnderlying = ByRefTypeSymbol.Get(elementType);
            }
            else
            {
                Diagnostics.ReportFixedSourceNotPinnable(
                    syntax.PinnedSource.Location, source.Type?.Name ?? "?");

                var errorPointerType = pointerType is PointerTypeSymbol
                    ? pointerType
                    : PointerTypeSymbol.Get(TypeSymbol.UInt8);
                var errorPointer = bindLocalVariable(syntax.Identifier, isReadOnly: true, errorPointerType);
                var errorBody = Invariant.Required(BindStatement(syntax.Body), "a fixed statement has a bound body");
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

            // Span-like form only: a synthetic local holding the source value,
            // whose address (`ldloca`) feeds the `GetPinnableReference()` call.
            VariableSymbol? sourceVariable = null;
            if (pinKind == FixedPinKind.PinnableReference)
            {
                sourceVariable = new LocalVariableSymbol(
                    $"$pinsrc${pointerVariable.Name}",
                    isReadOnly: false,
                    Invariant.Required(source.Type, "a fixed source has a type"));
            }

            var body = Invariant.Required(BindStatement(syntax.Body), "a fixed statement has a bound body");

            return new BoundFixedStatement(syntax, pinKind, pinnedVariable, pointerVariable, source, body, sourceVariable);
        }
        finally
        {
            scope = scope.Pop();
        }
    }

    private void ReportSuspensionPointsInFixedBody(SyntaxNode node)
    {
        if (node == null
            || node is FunctionLiteralExpressionSyntax
                or LambdaExpressionSyntax
                or FixedStatementSyntax)
        {
            return;
        }

        switch (node)
        {
            case AwaitExpressionSyntax or AwaitForRangeStatementSyntax or AwaitUsingStatementSyntax:
                Diagnostics.ReportFixedStatementCannotSuspend(node.Location, "await");
                break;
            case YieldStatementSyntax yieldStatement:
                Diagnostics.ReportFixedStatementCannotSuspend(
                    yieldStatement.YieldKeyword.Location,
                    yieldStatement.YieldKeyword.Text);
                break;
        }

        foreach (var child in node.GetChildren())
        {
            ReportSuspensionPointsInFixedBody(child);
        }
    }

    // ADR-0125 / issue #1043: detect a span-like pin source — a type exposing a
    // public instance `ref T GetPinnableReference()` (canonically `System.Span[T]`
    // / `System.ReadOnlySpan[T]`). Returns the resolved method and the ref-return
    // element CLR type (`T`). Used to enable the `GetPinnableReference` pin kind.
    private static bool TryGetPinnableReference(
        TypeSymbol sourceType,
        out System.Reflection.MethodInfo? method,
        out System.Type? elementClrType)
    {
        method = null;
        elementClrType = null;

        var clrType = sourceType?.ClrType;
        if (clrType == null)
        {
            return false;
        }

        System.Reflection.MethodInfo? found;
        try
        {
            found = clrType.GetMethod(
                "GetPinnableReference",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance,
                binder: null,
                types: System.Type.EmptyTypes,
                modifiers: null);
        }
        catch (System.Reflection.AmbiguousMatchException)
        {
            return false;
        }

        if (found == null || !found.ReturnType.IsByRef)
        {
            return false;
        }

        method = found;
        elementClrType = found.ReturnType.GetElementType();
        return elementClrType != null;
    }

    // Issue #2838: recover the SYMBOLIC element type of a span-like pin source.
    // `TryGetPinnableReference` resolves through `sourceType.ClrType`, which for
    // a `Span[T]` inside a generic method is the type-erased `Span<object>` — so
    // its ref-return element is `System.Object`, not `T`. Binding the pointer as
    // `*object` produced a `pinned object&` local and, because an erased pointee
    // is not recognized as a value type, an 8-byte pointer-arithmetic stride for
    // every instantiation. Re-resolve the method on the OPEN definition (whose
    // ref-return is `!0`) and map that back through the receiver's real type
    // arguments. Falls back to the CLR element type for non-generic and fully
    // closed sources, preserving existing behavior.
    private static TypeSymbol ResolvePinnableElementType(TypeSymbol sourceType, System.Type pinnableElementClr)
    {
        if (sourceType is ImportedTypeSymbol { OpenDefinition: not null } imported
            && !imported.TypeArguments.IsDefaultOrEmpty)
        {
            System.Reflection.MethodInfo? openMethod = null;
            try
            {
                openMethod = imported.OpenDefinition.GetMethod(
                    "GetPinnableReference",
                    System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance,
                    binder: null,
                    types: System.Type.EmptyTypes,
                    modifiers: null);
            }
            catch (System.Reflection.AmbiguousMatchException)
            {
                openMethod = null;
            }

            var openElement = openMethod?.ReturnType.IsByRef == true
                ? openMethod.ReturnType.GetElementType()
                : null;
            if (openElement != null)
            {
                var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openElement, imported);
                if (mapped != null)
                {
                    return mapped;
                }
            }
        }

        return TypeSymbol.FromClrType(pinnableElementClr);
    }

    private BoundStatement BindAwaitForRangeStatement(AwaitForRangeStatementSyntax syntax)
    {
        return BindAwaitForRangeStatementCore(syntax, labelName: null, originatingSyntax: syntax);
    }

    private BoundStatement BindAwaitForRangeStatementCore(AwaitForRangeStatementSyntax syntax, string? labelName, SyntaxNode originatingSyntax)
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
            Diagnostics.ReportTypeIsNotAsyncEnumerable(syntax.Stream.Location, stream.Type ?? TypeSymbol.Error);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        scope = new BoundScope(scope);
        var variable = bindLocalVariable(
            syntax.Identifier,
            isReadOnly: false,
            type: Invariant.Required(elementType, "an async enumerable has an element type"));
        var body = BindLoopBody(syntax.Body, labelName, out var breakLabel, out var continueLabel);

        scope = scope.Pop();

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

        // Issue #3501: `yield break` terminates the iterator. Bind it as the
        // bare return the iterator MoveNext builders already lower to a jump
        // to the shared end label (state = -1, return false) — both the sync
        // rewriter and the async-iterator rewriter document exactly this
        // meaning for an expressionless return inside an iterator body.
        if (syntax.BreakKeyword != null)
        {
            return new BoundReturnStatement(syntax, expression: null);
        }

        var elementType = GetIteratorElementType(function.Type);
        ExpressionSyntax expressionSyntax = Invariant.Required(
            syntax.Expression,
            "a yield statement without a break keyword carries an expression");
        var expression = bindExpression(expressionSyntax);
        if (expression.Type != null && elementType != null && expression.Type != elementType)
        {
            expression = conversions.BindConversion(expressionSyntax.Location, expression, elementType);
        }

        return new BoundYieldStatement(syntax, expression);
    }
}
