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
            binderCtx.CurrentFallthroughTarget = null;
            if (endsInFallthrough && caseIndex < syntax.Cases.Length - 1)
            {
                var nextArmEntry = armEntryLabels[caseIndex + 1];
                if (nextArmEntry == null)
                {
                    nextArmEntry = new BoundLabel($"switchArm{switchOrdinal}_{caseIndex + 1}");
                    armEntryLabels[caseIndex + 1] = nextArmEntry;
                }

                binderCtx.CurrentFallthroughTarget = nextArmEntry;
            }

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
            initialized,
            NilGuardedResource(usingLowering.Declaration.Variable));
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
            initialized,
            NilGuardedResource(declaration.Variable));
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
        // Gate: await using let requires an async (or suspending) context.
        if (function == null || !function.IsAsyncOrSuspending)
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

        var tryStmt = BuildCleanupTryStatement(ImmutableArray<BoundStatement>.Empty, defer.Cleanup, shieldCleanup: true);
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

        // ADR-0174 D4/D5: the goroutine, not the spawning function, consumes
        // a suspending operand's ValueTask — unwrap the caller-side completion
        // (implicit await or root bridge) the call binder applied.
        if (expression is BoundAwaitExpression awaited)
        {
            expression = awaited.Expression;
        }
        else if (expression is BoundImportedCallExpression { Function.Name: "Wait" } bridge
            && bridge.Function.ImportedClass.ClassType.FullName == "Gsharp.Concurrency.Blocking"
            && bridge.Arguments.Length == 1)
        {
            expression = bridge.Arguments[0];
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

        if (!binderCtx.ChannelRuntime.IsAvailable)
        {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(syntax.Expression.Location, "Gsharp.Concurrency.GoroutineRuntime");
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var sink = binderCtx.ScopeFrames.Count > 0 ? new BoundVariableExpression(null, binderCtx.ScopeFrames.Peek()) : null;
        return new BoundGoStatement(syntax, binderCtx.ChannelRuntime.ShapeGoOperand(expression), sink);
    }

    private BoundStatement BindChannelSendStatement(ChannelSendStatementSyntax syntax)
    {
        // ADR-0174 D1/D2: `ch <- v` lowers to ChannelOps.Send<T>(ch, v, default).
        // Any channel-shaped handle may be sent on except a receive-only
        // `in chan[T]` (GS0549) — this is what makes ownership checkable.
        var channel = bindExpression(syntax.Channel);
        if (channel is BoundErrorExpression)
        {
            return new BoundExpressionStatement(syntax, channel);
        }

        if (!ChannelTypeSymbol.TryGetChannelShape(channel.Type, out var elementType, out var direction, out _))
        {
            Diagnostics.ReportSendTargetIsNotChannel(syntax.Channel.Location, channel.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        if (direction == ChannelDirection.In)
        {
            Diagnostics.ReportSendOnReceiveOnlyChannel(syntax.LeftArrowToken.Location, channel.Type);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var value = conversions.BindConversion(syntax.Value, elementType);
        if (!binderCtx.ChannelRuntime.IsAvailable)
        {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(syntax.LeftArrowToken.Location, ChannelRuntimeBinder.ChanTypeName);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        return binderCtx.ChannelRuntime.BindSend(syntax, channel, value, elementType, direction, binderCtx.AmbientContext());
    }

    private BoundStatement BindSelectStatement(SelectStatementSyntax syntax)
    {
        // Phase 5.6 / ADR-0022: select statement orchestrating channel ops.
        // ADR-0174 D2: arms accept any channel-shaped handle; the operand is
        // viewed through its `chan[T]` / `in chan[T]` / `out chan[T]` symbol so
        // the (wave-1, pre-D8) select emitter sees one representation.
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

            if (caseSyntax.CaseKind == SelectCaseKind.Cancelled)
            {
                // ADR-0174 D8: `case cancelled` has no operand — it observes the
                // ambient context. Whether there is one to observe is settled by
                // the suspension pass (GS0557), which knows which functions end
                // up carrying a context.
                var cancelledGuard = BindSelectArmGuard(caseSyntax);
                var cancelledBody = BindStatement(caseSyntax.Body);
                bound.Add(new BoundSelectCase(
                    SelectCaseKind.Cancelled,
                    channel: null,
                    value: null,
                    variable: null,
                    cancelledGuard,
                    Invariant.Required(cancelledBody, "a cancelled select case has a bound body")));
                continue;
            }

            if (caseSyntax.CaseKind is SelectCaseKind.AwaitBind or SelectCaseKind.AwaitDiscard)
            {
                bound.Add(BindSelectAwaitCase(caseSyntax));
                continue;
            }

            // A send arm references a channel; a receive arm may reference
            // anything selectable (ADR-0174 D8/D9), which is how `case
            // <-after(d)` works without the library's timers pretending to be
            // channels.
            var channelSyntax = Invariant.Required(caseSyntax.Channel, "a non-default select case has a channel");
            var channelExpr = bindExpression(channelSyntax);
            ChannelTypeSymbol? chan = null;
            TypeSymbol? selectableElement = null;
            if (channelExpr is not BoundErrorExpression
                && caseSyntax.CaseKind != SelectCaseKind.Send
                && !ChannelTypeSymbol.TryGetChannelShape(channelExpr.Type, out _, out _, out _)
                && binderCtx.ChannelRuntime.IsAvailable
                && binderCtx.ChannelRuntime.TryGetSelectableElement(channelExpr.Type, out var selectable))
            {
                selectableElement = selectable;
            }
            else if (channelExpr is not BoundErrorExpression
                && ChannelTypeSymbol.TryGetChannelShape(channelExpr.Type, out var armElement, out var armDirection, out _))
            {
                if (caseSyntax.CaseKind == SelectCaseKind.Send && armDirection == ChannelDirection.In)
                {
                    Diagnostics.ReportSendOnReceiveOnlyChannel(channelSyntax.Location, channelExpr.Type);
                }
                else if (caseSyntax.CaseKind != SelectCaseKind.Send && armDirection == ChannelDirection.Out)
                {
                    Diagnostics.ReportReceiveFromSendOnlyChannel(channelSyntax.Location, channelExpr.Type);
                }
                else
                {
                    chan = ChannelTypeSymbol.Get(armElement, armDirection);
                    if (channelExpr.Type != chan)
                    {
                        channelExpr = new BoundConversionExpression(null, chan, channelExpr);
                    }
                }
            }

            if (channelExpr is BoundErrorExpression || (chan == null && selectableElement == null))
            {
                if (chan == null && channelExpr is not BoundErrorExpression
                    && !ChannelTypeSymbol.TryGetChannelShape(channelExpr.Type, out _, out _, out _))
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

            // The guard is bound here, before a receive arm opens its scope, so
            // `case let v = <-ch when v > 0` cannot see `v`: the guard decides
            // whether the arm is registered at all, long before any value
            // arrives (ADR-0174 D8).
            var guard = BindSelectArmGuard(caseSyntax);

            if (caseSyntax.CaseKind == SelectCaseKind.Send)
            {
                valueExpr = conversions.BindConversion(
                    Invariant.Required(caseSyntax.Value, "send select cases have a value expression"),
                    Invariant.Required(chan, "a send arm binds a channel, never a selectable").ElementType);
                body = Invariant.Required(BindStatement(caseSyntax.Body), "a send select case has a bound body");
            }
            else if (caseSyntax.CaseKind == SelectCaseKind.ReceiveBind)
            {
                // Introduce a scope so the bound variable is visible only inside
                // the case body — matches `for v := range` lexical hygiene.
                scope = new BoundScope(scope);
                var identifier = Invariant.Required(caseSyntax.Identifier, "a receive-bind select case has an identifier");
                var bindElement = selectableElement ?? Invariant.Required(chan, "a channel arm binds a channel type").ElementType;
                variable = new LocalVariableSymbol(identifier.ValueText, isReadOnly: true, bindElement, declaringSyntax: identifier);
                if (!scope.TryDeclareVariable(variable))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, identifier.ValueText);
                }

                body = Invariant.Required(BindStatement(caseSyntax.Body), "a receive-bind select case has a bound body");

                scope = scope.Pop();
            }
            else
            {
                // ReceiveDiscard
                body = Invariant.Required(BindStatement(caseSyntax.Body), "a receive-discard select case has a bound body");
            }

            bound.Add(new BoundSelectCase(caseSyntax.CaseKind, channelExpr, valueExpr, variable, guard, body));
        }

        ReportChannelsTalkingToThemselves(bound);
        }
        finally
        {
            binderCtx.LoopStack.Pop();
        }

        var lowered = LowerSelectStatement(syntax, bound.ToImmutable());
        if (binderCtx.UsedBreakLabels.Contains(selectBreakLabel))
        {
            return new BoundBlockStatement(
                syntax,
                ImmutableArray.Create<BoundStatement>(lowered, new BoundLabelStatement(null, selectBreakLabel)));
        }

        return lowered;
    }

    // ADR-0174 D8: an arm's `when` guard. It is evaluated once, when the select
    // is entered, and a false guard keeps the arm out of the waiter entirely —
    // which is how G# spells Go's "set the channel to nil to disable the arm".
    private BoundExpression? BindSelectArmGuard(SelectCaseSyntax caseSyntax)
    {
        if (caseSyntax.Guard is not { } guardSyntax)
        {
            return null;
        }

        var guard = bindExpression(guardSyntax);
        if (guard is BoundErrorExpression)
        {
            return null;
        }

        if (guard.Type != TypeSymbol.Bool)
        {
            Diagnostics.ReportSelectArmGuardIsNotBoolean(guardSyntax.Location, guard.Type);
            return null;
        }

        return guard;
    }

    // ADR-0174 D8: `case await task { … }` and `case let v = await task { … }`.
    // The arm joins the select through `SelectWaiter.AddTask`, so the operand
    // must be a `Task` or `Task[T]` — the only shape the waiter can attach a
    // claiming continuation to.
    private BoundSelectCase BindSelectAwaitCase(SelectCaseSyntax caseSyntax)
    {
        var taskSyntax = Invariant.Required(caseSyntax.Channel, "an await select case has a task expression");
        var task = bindExpression(taskSyntax);
        var guard = BindSelectArmGuard(caseSyntax);
        TypeSymbol? result = null;
        var recognized = task is BoundErrorExpression;
        if (task is not BoundErrorExpression)
        {
            if (task.Type?.ClrType?.FullName == "System.Threading.Tasks.Task")
            {
                recognized = true;
            }
            else if (AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(task.Type ?? TypeSymbol.Error, out var awaited, out var isValueTask)
                && !isValueTask)
            {
                recognized = true;
                result = awaited;
            }
            else
            {
                Diagnostics.ReportTypeIsNotAwaitable(taskSyntax.Location, task.Type ?? TypeSymbol.Error);
            }
        }

        if (!recognized || caseSyntax.CaseKind == SelectCaseKind.AwaitDiscard)
        {
            var discardBody = BindStatement(caseSyntax.Body);
            return new BoundSelectCase(
                caseSyntax.CaseKind,
                task,
                value: null,
                variable: null,
                guard,
                Invariant.Required(discardBody, "an await select case has a bound body"));
        }

        // `case let v = await task`: `v` is visible only inside the arm body,
        // exactly as a receive arm's binding is.
        scope = new BoundScope(scope);
        var identifier = Invariant.Required(caseSyntax.Identifier, "an await-bind select case has an identifier");
        var variable = new LocalVariableSymbol(
            identifier.ValueText,
            isReadOnly: true,
            result ?? TypeSymbol.Error,
            declaringSyntax: identifier);
        if (!scope.TryDeclareVariable(variable))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, identifier.ValueText);
        }

        var body = Invariant.Required(BindStatement(caseSyntax.Body), "an await-bind select case has a bound body");
        scope = scope.Pop();
        return new BoundSelectCase(caseSyntax.CaseKind, task, value: null, variable, guard, body);
    }

    // ADR-0174 D8 / GS0564: a select that both sends to and receives from one
    // channel can complete by talking to itself, which is almost never what the
    // author meant. Reported on the second arm, once per channel.
    private void ReportChannelsTalkingToThemselves(ImmutableArray<BoundSelectCase>.Builder cases)
    {
        var sent = new Dictionary<VariableSymbol, int>();
        var received = new Dictionary<VariableSymbol, int>();
        for (var i = 0; i < cases.Count; i++)
        {
            // A receive operand is wrapped in the `in chan[T]` view conversion
            // and a send operand is not, so the comparison is on the symbol.
            if (Unwrap(cases[i].Channel) is not BoundVariableExpression { Variable: { } symbol } operand)
            {
                continue;
            }

            var (mine, theirs) = cases[i].CaseKind == SelectCaseKind.Send ? (sent, received) : (received, sent);
            if (theirs.ContainsKey(symbol))
            {
                // The conversion wrapper carries no syntax, so the span comes
                // from the operand underneath it.
                Diagnostics.ReportSelectChannelSentAndReceived(
                    operand.Syntax?.Location
                        ?? Invariant.Required(cases[i].Body.Syntax, "a select arm has a body").Location,
                    symbol.Name);
                theirs.Remove(symbol);
                continue;
            }

            mine.TryAdd(symbol, i);
        }

        static BoundExpression? Unwrap(BoundExpression? expression)
            => expression is BoundConversionExpression conversion ? Unwrap(conversion.Expression) : expression;
    }

    /// <summary>
    /// ADR-0174 D8: lowers <c>select</c> onto the runtime's <c>SelectWaiter</c>.
    /// The operands are evaluated once, then every arm is registered on one
    /// waiter, which probes them in uniform-random order and — only if none is
    /// ready — parks on all of them at once. That replaces the old
    /// probe-in-source-order, <c>Task.WhenAny</c>, re-probe-the-winner shape,
    /// which was both unfair and unable to transfer a value atomically.
    /// </summary>
    /// <remarks>
    /// The emitted shape is:
    /// <code>
    /// let ch_i = &lt;operand&gt;                 // once, left to right
    /// var winner = -1; var again = true
    /// loop:
    ///   let w = SelectWaiter.Rent(n, ctx)
    ///   try {
    ///     w.AddReceive[T](ch_i, i) / w.AddSend[T](ch_i, v_i, i)
    ///     winner = w.Wait()                 // or w.TryNow() when a default arm exists
    ///     again = w.NeedsReprobe            // a foreign arm lost its value to a thief
    ///     if !again { v_i = w.TakeValue[T]() }
    ///   } finally { w.Return() }
    ///   if again goto loop
    /// if winner == i { body_i } … else { default body }
    /// </code>
    /// <c>Wait</c> is the blocking form; inside a state machine the async
    /// lowering turns it into an awaited <c>WaitAsync</c>, exactly as it does
    /// for a scope's join, so a parked select holds no thread.
    /// </remarks>
    /// <param name="syntax">The select syntax.</param>
    /// <param name="cases">The bound arms.</param>
    /// <returns>The lowered statement.</returns>
    private BoundStatement LowerSelectStatement(SelectStatementSyntax syntax, ImmutableArray<BoundSelectCase> cases)
    {
        if (!EnsureChannelRuntimeForSelect(syntax))
        {
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var runtime = binderCtx.ChannelRuntime;
        var shapes = new (TypeSymbol? Element, ChannelDirection Direction, bool Selectable)[cases.Length];
        for (var i = 0; i < cases.Length; i++)
        {
            if (cases[i].IsDefault || cases[i].CaseKind == SelectCaseKind.Cancelled)
            {
                continue;
            }

            if (cases[i].Channel is not { } channel)
            {
                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
            }

            if (cases[i].CaseKind is SelectCaseKind.AwaitBind or SelectCaseKind.AwaitDiscard)
            {
                // The element is the task's result type, or null for a bare
                // `Task` whose completion carries no value.
                shapes[i] = (cases[i].Variable?.Type, ChannelDirection.In, false);
            }
            else if (ChannelTypeSymbol.TryGetChannelShape(channel.Type, out var element, out var direction, out _))
            {
                shapes[i] = (element, direction, false);
            }
            else if (runtime.TryGetSelectableElement(channel.Type, out var selectableElement))
            {
                // A receive arm over an `ISelectable[T]` — the library's timers
                // (ADR-0174 D9), which join a select without pretending to be
                // channels.
                shapes[i] = (selectableElement, ChannelDirection.In, true);
            }
            else
            {
                // A recovery arm: the diagnostic is already reported, and emit
                // never runs for a program that has one.
                return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
            }
        }

        var id = System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        // The operands are evaluated once, left to right, before any arm is
        // attempted — re-evaluating a channel expression per probe would be
        // observable (D8 step 1).
        var channelLocals = new VariableSymbol?[cases.Length];
        var valueLocals = new VariableSymbol?[cases.Length];
        var guardLocals = new VariableSymbol?[cases.Length];
        var armCount = 0;
        for (var i = 0; i < cases.Length; i++)
        {
            if (cases[i].IsDefault)
            {
                continue;
            }

            armCount++;
            if (cases[i].Channel is { } channel)
            {
                var channelLocal = new LocalVariableSymbol($"<select$ch${id}${i}>", isReadOnly: true, channel.Type!);
                scope.TryDeclareVariable(channelLocal);
                channelLocals[i] = channelLocal;
                statements.Add(new BoundVariableDeclaration(null, channelLocal, channel));
            }

            if (cases[i].CaseKind == SelectCaseKind.Send)
            {
                var value = Invariant.Required(cases[i].Value, "a send select arm binds a value");
                var valueLocal = new LocalVariableSymbol($"<select$value${id}${i}>", isReadOnly: true, value.Type!);
                scope.TryDeclareVariable(valueLocal);
                valueLocals[i] = valueLocal;
                statements.Add(new BoundVariableDeclaration(null, valueLocal, value));
            }

            // The guard is evaluated exactly once, here, outside the reprobe
            // loop: an arm's enablement cannot change under the select's feet.
            if (cases[i].Guard is { } guard)
            {
                var guardLocal = new LocalVariableSymbol($"<select$guard${id}${i}>", isReadOnly: true, TypeSymbol.Bool);
                scope.TryDeclareVariable(guardLocal);
                guardLocals[i] = guardLocal;
                statements.Add(new BoundVariableDeclaration(null, guardLocal, guard));
            }
        }

        var winner = new LocalVariableSymbol($"<select$winner${id}>", isReadOnly: false, TypeSymbol.Int32);
        scope.TryDeclareVariable(winner);
        statements.Add(new BoundVariableDeclaration(null, winner, new BoundLiteralExpression(null, -1, TypeSymbol.Int32)));

        var again = new LocalVariableSymbol($"<select$again${id}>", isReadOnly: false, TypeSymbol.Bool);
        scope.TryDeclareVariable(again);
        statements.Add(new BoundVariableDeclaration(null, again, new BoundLiteralExpression(null, true, TypeSymbol.Bool)));

        // A bound receive arm's variable is declared out here and assigned from
        // the waiter, so the arm body — which runs after the waiter is returned
        // — still sees it.
        for (var i = 0; i < cases.Length; i++)
        {
            if (cases[i].Variable is { } bindVariable)
            {
                statements.Add(new BoundVariableDeclaration(null, bindVariable, new BoundDefaultExpression(null, bindVariable.Type)));
            }
        }

        var hasDefault = cases.Any(static c => c.IsDefault);
        var waiter = new LocalVariableSymbol($"<select$waiter${id}>", isReadOnly: true, runtime.SelectWaiterType);
        scope.TryDeclareVariable(waiter);

        var attempt = ImmutableArray.CreateBuilder<BoundStatement>();
        for (var i = 0; i < cases.Length; i++)
        {
            BoundExpression register;
            if (cases[i].CaseKind == SelectCaseKind.Cancelled)
            {
                register = runtime.BindSelectAddCancelled(waiter, cases[i].Body.Syntax?.Parent, i);
            }
            else if (channelLocals[i] is not { } channelLocal)
            {
                continue;
            }
            else if (cases[i].CaseKind is SelectCaseKind.AwaitBind or SelectCaseKind.AwaitDiscard)
            {
                register = runtime.BindSelectAddTask(waiter, new BoundVariableExpression(null, channelLocal), shapes[i].Element, i);
            }
            else
            {
                var value = valueLocals[i] is { } valueLocal ? new BoundVariableExpression(null, valueLocal) : null;
                register = runtime.BindSelectAdd(
                    waiter,
                    new BoundVariableExpression(null, channelLocal),
                    value,
                    Invariant.Required(shapes[i].Element, "a channel arm has an element type"),
                    shapes[i].Direction,
                    i,
                    shapes[i].Selectable);
            }

            BoundStatement registration = new BoundExpressionStatement(null, register);
            if (guardLocals[i] is { } guardLocal)
            {
                // A disabled arm is simply never registered, so it can never win
                // and its body is unreachable — the same shape as Go's nil
                // channel, without the nil.
                registration = new BoundIfStatement(
                    null,
                    new BoundVariableExpression(null, guardLocal),
                    registration,
                    elseStatement: null);
            }

            attempt.Add(registration);
        }

        attempt.Add(new BoundExpressionStatement(
            null,
            new BoundAssignmentExpression(
                null,
                winner,
                hasDefault ? runtime.BindSelectTryNow(waiter) : runtime.BindSelectWait(waiter))));
        attempt.Add(new BoundExpressionStatement(
            null,
            new BoundAssignmentExpression(null, again, runtime.BindSelectNeedsReprobe(waiter))));

        var takes = ImmutableArray.CreateBuilder<BoundStatement>();
        for (var i = 0; i < cases.Length; i++)
        {
            if (cases[i].Variable is not { } bindVariable)
            {
                continue;
            }

            takes.Add(new BoundIfStatement(
                null,
                ArmIs(winner, i),
                new BoundExpressionStatement(
                    null,
                    new BoundAssignmentExpression(
                        null,
                        bindVariable,
                        runtime.BindSelectTakeValue(waiter, Invariant.Required(shapes[i].Element, "a binding arm has an element type")))),
                elseStatement: null));
        }

        if (takes.Count > 0)
        {
            attempt.Add(new BoundIfStatement(
                null,
                new BoundUnaryExpression(
                    null,
                    Invariant.Required(BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool), "'!' is defined for bool"),
                    new BoundVariableExpression(null, again)),
                new BoundBlockStatement(null, takes.ToImmutable()),
                elseStatement: null));
        }

        var loopLabel = new BoundLabel($"selectProbe{id}");
        statements.Add(new BoundLabelStatement(null, loopLabel));
        statements.Add(new BoundVariableDeclaration(null, waiter, runtime.BindSelectRent(syntax, armCount, binderCtx.AmbientContext())));
        statements.Add(new BoundTryStatement(
            null,
            new BoundBlockStatement(null, attempt.ToImmutable()),
            ImmutableArray<BoundCatchClause>.Empty,
            new BoundBlockStatement(
                null,
                ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, runtime.BindSelectReturn(waiter))))));
        statements.Add(new BoundConditionalGotoStatement(null, loopLabel, new BoundVariableExpression(null, again), jumpIfTrue: true));

        // Dispatch, outside the waiter's lifetime: `winner` is the arm that
        // transferred, or -1 when a `default` arm exists and nothing was ready.
        BoundStatement? dispatch = null;
        var needsElse = !hasDefault;
        for (var i = cases.Length - 1; i >= 0; i--)
        {
            if (cases[i].IsDefault)
            {
                dispatch = cases[i].Body;
                continue;
            }

            if (needsElse)
            {
                // Without a `default` arm the wait only returns once an arm has
                // transferred, so the last arm is unconditional. Saying so keeps
                // definite-return analysis exact: a select whose every arm
                // returns is a select that returns (issue #2890).
                dispatch = cases[i].Body;
                needsElse = false;
                continue;
            }

            dispatch = new BoundIfStatement(null, ArmIs(winner, i), cases[i].Body, dispatch);
        }

        if (dispatch != null)
        {
            statements.Add(dispatch);
        }

        return new BoundBlockStatement(syntax, statements.ToImmutable());

        BoundExpression ArmIs(VariableSymbol winnerLocal, int arm)
            => new BoundBinaryExpression(
                null,
                new BoundVariableExpression(null, winnerLocal),
                Invariant.Required(
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    "'==' is defined for int32"),
                new BoundLiteralExpression(null, arm, TypeSymbol.Int32));
    }

    private bool EnsureChannelRuntimeForSelect(SelectStatementSyntax syntax)
    {
        if (binderCtx.ChannelRuntime.IsAvailable)
        {
            return true;
        }

        Diagnostics.ReportTargetFrameworkMemberUnavailable(syntax.SelectKeyword.Location, "Gsharp.Concurrency.SelectWaiter");
        return false;
    }

    // ADR-0174 D15 / GS0569: reports every read of one of this block's
    // `async let` bindings that reached the bound tree. `await name` never
    // does — BindAwaitExpression replaces it with a read of the cell — so
    // anything left here is a use of a value that may not have arrived.
    private void ReportAsyncLetReadsWithoutAwait(BoundStatement body, List<AsyncLetVariableSymbol> cells)
    {
        if (cells.Count == 0)
        {
            return;
        }

        var walker = new AsyncLetReadWalker(cells);
        walker.Visit(body);
        foreach (var (variable, location) in walker.Reads)
        {
            Diagnostics.ReportAsyncLetReadWithoutAwait(location, variable.Name);
        }
    }

    private BoundStatement BindScopeStatement(ScopeStatementSyntax syntax)
    {
        // ADR-0174 D5/D6: `scope { body }` lowers to
        //   let <frame> = ScopeFrame.Enter(ambient)
        //   let ctx = <frame>.Context
        //   var <ex> Exception = default
        //   try { body } catch (Exception <caught>) { <ex> = <caught> } finally { <frame>.Exit(<ex>) }
        // The frame is the completion sink every `go` in the body reports to;
        // Exit joins them, cancels siblings on the first failure, and throws per
        // the D6 precedence table (the body's exception unwrapped, or a
        // ScopeException). In a suspending body the async pipeline awaits
        // ExitAsync instead of blocking on Exit.
        if (!binderCtx.ChannelRuntime.IsAvailable)
        {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(syntax.ScopeKeyword.Location, "Gsharp.Concurrency.ScopeFrame");
            return BindErrorStatement();
        }

        var exceptionType = ResolveExceptionType();
        if (exceptionType == null)
        {
            Diagnostics.ReportUndefinedType(syntax.ScopeKeyword.Location, "System.Exception");
            return BindErrorStatement();
        }

        var runtime = binderCtx.ChannelRuntime;
        var id = System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter);
        var frame = new LocalVariableSymbol($"<scope$frame${id}>", isReadOnly: true, runtime.ScopeFrameType);
        scope.TryDeclareVariable(frame);
        var bodyException = new LocalVariableSymbol($"<scope$ex${id}>", isReadOnly: false, exceptionType);
        scope.TryDeclareVariable(bodyException);

        // A nested scope's context is linked to the enclosing scope's `ctx` (ADR-0174 D6): cancelling the
        // outer block cancels the inner one, and `ctx.Parent` is the outer context.
        var ambient = binderCtx.ScopeFrames.Count > 0 ? runtime.BindScopeContext(binderCtx.ScopeFrames.Peek()) : null;

        scope = new BoundScope(scope);
        var contextToken = new SyntaxToken(syntax.SyntaxTree, SyntaxKind.IdentifierToken, syntax.ScopeKeyword.Span.Start, "ctx", "ctx");
        var context = bindLocalVariable(contextToken, isReadOnly: true, type: runtime.ContextType);
        binderCtx.ScopeFrames.Push(frame);
        binderCtx.ScopeContexts.Push(context);
        var cells = new List<AsyncLetVariableSymbol>();
        binderCtx.AsyncLetCells.Push(cells);
        BoundStatement body;
        try
        {
            body = Invariant.Required(BindStatement(syntax.Body), "a scope statement has a bound body");
        }
        finally
        {
            binderCtx.AsyncLetCells.Pop();
            binderCtx.ScopeContexts.Pop();
            binderCtx.ScopeFrames.Pop();
        }

        // GS0569, the catch-all: `BindVariableReference` rejects a bare name,
        // but a receiver position (`a.ToString()`) resolves the symbol through
        // a different path. A read that survived into the bound tree is one
        // that was never spelled `await`.
        ReportAsyncLetReadsWithoutAwait(body, cells);

        // ADR-0174 D15: a binding nobody read still started work. The block
        // cancels and joins it at exit — the failure is not dropped — and says
        // so, because starting work only to cancel it is rarely intended.
        foreach (var cell in cells)
        {
            if (!cell.WasAwaited)
            {
                Diagnostics.ReportAsyncLetNeverAwaited(
                    Invariant.Required(cell.DeclaringSyntax, "an async-let binding is declared by an identifier").Location,
                    cell.Name);
            }
        }

        scope = scope.Pop();

        var caught = new LocalVariableSymbol($"<scope$caught${id}>", isReadOnly: true, exceptionType);
        var catchBody = new BoundBlockStatement(
            syntax,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(syntax, new BoundAssignmentExpression(syntax, bodyException, new BoundVariableExpression(syntax, caught)))));
        var cleanup = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var cell in cells)
        {
            cleanup.Add(new BoundExpressionStatement(syntax, runtime.BindAsyncLetCancelIfUnread(cell.Cell)));
        }

        cleanup.Add(new BoundExpressionStatement(syntax, runtime.BindScopeExit(frame, bodyException)));
        var finallyBody = new BoundBlockStatement(syntax, cleanup.ToImmutable());
        var tryStatement = new BoundTryStatement(
            syntax,
            new BoundBlockStatement(syntax, ImmutableArray.Create(body)),
            ImmutableArray.Create(new BoundCatchClause(exceptionType, caught, catchBody, exitsThroughFinally: true)),
            finallyBody);

        return new BoundBlockStatement(
            syntax,
            ImmutableArray.Create<BoundStatement>(
                new BoundVariableDeclaration(syntax, frame, runtime.BindScopeEnter(syntax, ambient)),
                new BoundVariableDeclaration(syntax, context, runtime.BindScopeContext(frame)),
                new BoundVariableDeclaration(syntax, bodyException, new BoundDefaultExpression(syntax, exceptionType)),
                tryStatement));
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

    private sealed class AsyncLetReadWalker : BoundTreeWalker
    {
        private readonly List<AsyncLetVariableSymbol> cells;

        public AsyncLetReadWalker(List<AsyncLetVariableSymbol> cells)
        {
            this.cells = cells;
        }

        public List<(AsyncLetVariableSymbol Variable, TextLocation Location)> Reads { get; } = new();

        public override void VisitExpression(BoundExpression? node)
        {
            if (node is BoundVariableExpression { Variable: AsyncLetVariableSymbol binding } read
                && cells.Contains(binding)
                && (read.Syntax?.Location ?? binding.DeclaringSyntax?.Location) is { } location)
            {
                Reads.Add((binding, location));
            }

            base.VisitExpression(node);
        }
    }
}
