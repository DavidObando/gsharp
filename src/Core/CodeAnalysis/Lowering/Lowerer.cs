// <copyright file="Lowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Bound tree lowerer. It simplifies the AST.
/// </summary>
public sealed class Lowerer : BoundTreeRewriter
{
    // The type whose body is currently being lowered. When non-null, auto-property
    // access on this type is lowered to direct backing-field access (the accessor
    // is inside the type and has access to its private fields). When null (e.g.
    // top-level statements), auto-property access remains as property access so
    // the emitter generates callvirt get_/set_ — avoiding FieldAccessException.
    private readonly StructSymbol declaringType;

    private int labelCount;

    // Issue #419 (P0-2): nesting depth of the try / catch / finally regions
    // currently being lowered. ECMA-335 forbids `ret` from inside a protected
    // region; the only legal exit is `leave`. When the depth is positive, any
    // BoundReturnStatement encountered is rewritten to store its value into a
    // synthetic temp local (if non-void) and `goto` a synthetic method-exit
    // label placed lexically OUTSIDE every protected region. The emitter
    // already translates a goto crossing a protected-region boundary into the
    // CIL `leave` opcode, so this rewrite is enough to keep the generated IL
    // verifiable.
    private int tryNestingDepth;
    private LocalVariableSymbol returnValueLocal;
    private BoundLabel methodExitLabel;
    private bool hasRewrittenReturnsInProtectedRegions;

    private Lowerer(StructSymbol declaringType = null)
    {
        this.declaringType = declaringType;
    }

    /// <summary>
    /// Produces a lowered version of the supplied bound statement.
    /// </summary>
    /// <param name="statement">The bound statement.</param>
    /// <returns>A lowered version of the bound statement.</returns>
    public static BoundBlockStatement Lower(BoundStatement statement)
    {
        var lowerer = new Lowerer();
        var result = lowerer.RewriteStatement(statement);
        result = lowerer.WrapWithMethodExitEpilogue(result);
        return Flatten(result);
    }

    /// <summary>
    /// Produces a lowered version of the supplied bound statement within the
    /// context of a declaring type. Auto-property access on the declaring type
    /// is lowered to direct backing-field access; access from outside the type
    /// is left as property access (emitted as callvirt get_/set_).
    /// </summary>
    /// <param name="statement">The bound statement.</param>
    /// <param name="declaringType">The type whose member body is being lowered.</param>
    /// <returns>A lowered version of the bound statement.</returns>
    public static BoundBlockStatement Lower(BoundStatement statement, StructSymbol declaringType)
    {
        var lowerer = new Lowerer(declaringType);
        var result = lowerer.RewriteStatement(statement);
        result = lowerer.WrapWithMethodExitEpilogue(result);
        return Flatten(result);
    }

    /// <inheritdoc/>
    /// <remarks>
    /// Issue #419 (P0-2): tracks try / catch / finally nesting depth so
    /// <see cref="RewriteReturnStatement(BoundReturnStatement)"/> can detect a
    /// return that crosses a protected-region boundary and rewrite it into a
    /// store-to-temp + goto-exit pair. ECMA-335 forbids emitting <c>ret</c>
    /// from inside a protected region; the only legal exit is <c>leave</c>,
    /// which the emitter produces automatically for a goto whose target lies
    /// outside the innermost protected region.
    /// </remarks>
    protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
    {
        this.tryNestingDepth++;
        try
        {
            return base.RewriteTryStatement(node);
        }
        finally
        {
            this.tryNestingDepth--;
        }
    }

    /// <inheritdoc/>
    /// <remarks>
    /// Issue #1615: <c>scope { }</c> bodies are emitted as a protected
    /// (try/finally) region so spawned tasks are always awaited — see
    /// <c>MethodBodyEmitter.EmitScopeStatement</c>. A <c>return</c> lexically
    /// inside a scope must therefore get the same store-to-temp +
    /// goto-exit rewrite as a return inside a real try block, so counts
    /// toward <see cref="tryNestingDepth"/> just like <see cref="RewriteTryStatement"/>.
    /// </remarks>
    protected override BoundStatement RewriteScopeStatement(BoundScopeStatement node)
    {
        this.tryNestingDepth++;
        try
        {
            return base.RewriteScopeStatement(node);
        }
        finally
        {
            this.tryNestingDepth--;
        }
    }

    /// <inheritdoc/>
    /// <remarks>
    /// Issue #419 (P0-2): rewrites <c>return</c> statements that appear
    /// lexically inside a try / catch / finally region. The original
    /// <c>BoundReturnStatement</c> is replaced with a store to a synthetic
    /// temp local (omitted when the return is value-less) followed by a goto
    /// to the synthesized method-exit label. The emitter's protected-region
    /// goto handling then translates the goto into the CIL <c>leave</c> the
    /// runtime requires. The matching label + final <c>return $tmp;</c>
    /// epilogue is appended by <c>WrapWithMethodExitEpilogue</c>.
    /// </remarks>
    protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
    {
        var rewritten = (BoundReturnStatement)base.RewriteReturnStatement(node);
        if (this.tryNestingDepth == 0)
        {
            return rewritten;
        }

        this.hasRewrittenReturnsInProtectedRegions = true;
        if (this.methodExitLabel == null)
        {
            this.methodExitLabel = GenerateLabel();
        }

        var stmts = ImmutableArray.CreateBuilder<BoundStatement>();
        if (rewritten.Expression != null)
        {
            // First non-void return seen — bind the temp's type. Subsequent
            // value-returning rewrites reuse the same local; the binder has
            // already enforced a single return type for the enclosing
            // function, so all expressions are assignment-compatible with it.
            if (this.returnValueLocal == null)
            {
                this.returnValueLocal = new LocalVariableSymbol(
                    "$returnTemp",
                    isReadOnly: false,
                    type: rewritten.Expression.Type);
            }

            var assignment = new BoundAssignmentExpression(
                null,
                this.returnValueLocal,
                rewritten.Expression);
            stmts.Add(new BoundExpressionStatement(null, assignment));
        }

        stmts.Add(new BoundGotoStatement(null, this.methodExitLabel));
        return new BoundBlockStatement(null, stmts.ToImmutable());
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteIfStatement(BoundIfStatement node)
    {
        if (node.ElseStatement == null)
        {
            // if <condition>
            //      <then>
            //
            // ---->
            //
            // gotoFalse <condition> end
            // <then>
            // end:
            var endLabel = GenerateLabel();
            var gotoFalse = new BoundConditionalGotoStatement(null, endLabel, node.Condition, false);
            var endLabelStatement = new BoundLabelStatement(null, endLabel);
            var result = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(gotoFalse, node.ThenStatement, endLabelStatement));
            return RewriteStatement(result);
        }
        else
        {
            // if <condition>
            //      <then>
            // else
            //      <else>
            //
            // ---->
            //
            // gotoFalse <condition> else
            // <then>
            // goto end          // omitted when <then> ends unconditionally
            // else:
            // <else>
            // end:              // omitted when the `goto end` above was omitted
            //
            // Issue #737: the naive shape above emits a dead `goto end` and a
            // trailing `end:` label whenever the then-arm terminates (return /
            // throw / unconditional goto). When the if-else is the last
            // statement of a method body AND the else-arm also terminates, the
            // `end:` label resolves to an offset past the final `ret`. The
            // CLR rejects any `br` to past-end-of-body with
            // `InvalidProgramException`, so the assembly cannot JIT. Lower the
            // then-arm first to inspect its terminator behavior, then omit
            // both the dead `goto end` and the dangling `end:` label when the
            // then-arm can never fall through. (The condition and else-arm
            // are still lowered via the inner BoundBlockStatement's recursive
            // RewriteStatement walk.)
            var elseLabel = GenerateLabel();
            var elseLabelStatement = new BoundLabelStatement(null, elseLabel);
            var gotoFalse = new BoundConditionalGotoStatement(null, elseLabel, node.Condition, false);

            var loweredThen = this.RewriteStatement(node.ThenStatement);
            var thenCanFallThrough = !EndsInUnconditionalTransfer(loweredThen);

            var builder = ImmutableArray.CreateBuilder<BoundStatement>();
            builder.Add(gotoFalse);
            builder.Add(loweredThen);

            if (thenCanFallThrough)
            {
                var endLabel = GenerateLabel();
                builder.Add(new BoundGotoStatement(null, endLabel));
                builder.Add(elseLabelStatement);
                builder.Add(node.ElseStatement);
                builder.Add(new BoundLabelStatement(null, endLabel));
            }
            else
            {
                builder.Add(elseLabelStatement);
                builder.Add(node.ElseStatement);
            }

            var result = new BoundBlockStatement(null, builder.ToImmutable());
            return RewriteStatement(result);
        }
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteForInfiniteStatement(BoundForInfiniteStatement node)
    {
        // for
        //     <body>
        //
        // ---->
        //
        // {
        //     continue:
        //     <body>
        //     goto continue
        //     break:
        // }
        var continueLabelStatement = new BoundLabelStatement(null, node.ContinueLabel);
        var gotoContinue = new BoundGotoStatement(null, node.ContinueLabel);
        var breakLabelStatement = new BoundLabelStatement(null, node.BreakLabel);

        var result = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
            continueLabelStatement,
            node.Body,
            gotoContinue,
            breakLabelStatement));
        return RewriteStatement(result);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteForEllipsisStatement(BoundForEllipsisStatement node)
    {
        // for <var> := <lower> ... <upper>
        //      <body>
        //
        // ---->
        //
        // {
        //     var <var> = <lower>
        //     const upperBound = <upper>
        //     var step = 1
        //     if <var> greaterthan upperBound {
        //          step = -1
        //     }
        //     goto start
        //     body:
        //     <body>
        //     continue:
        //     <var> = <var> + step
        //     start:
        //     gotoTrue ((step > 0 && lower < upper) || (step < 0 && lower > upper)) body
        //     break:
        // }
        var variableDeclaration = new BoundVariableDeclaration(null, node.Variable, node.LowerBound);
        var upperBoundSymbol = new LocalVariableSymbol("upperBound", isReadOnly: true, type: TypeSymbol.Int32);
        var upperBoundDeclaration = new BoundVariableDeclaration(null, upperBoundSymbol, node.UpperBound);
        var stepBoundSymbol = new LocalVariableSymbol("step", isReadOnly: false, type: TypeSymbol.Int32);
        var stepBoundDeclaration = new BoundVariableDeclaration(
            null,
            variable: stepBoundSymbol,
            initializer: new BoundLiteralExpression(null, 1));
        var variableExpression = new BoundVariableExpression(null, node.Variable);
        var upperBoundExpression = new BoundVariableExpression(null, upperBoundSymbol);
        var stepBoundExpression = new BoundVariableExpression(null, stepBoundSymbol);
        var ifLowerIsGreaterThanUpperExpression = new BoundBinaryExpression(
            null,
            left: variableExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32),
            right: upperBoundExpression);
        var stepBoundAssingment = new BoundExpressionStatement(
            null,
            expression: new BoundAssignmentExpression(
                null,
                variable: stepBoundSymbol,
                expression: new BoundLiteralExpression(null, -1)));
        var ifLowerIsGreaterThanUpperIfStatement = new BoundIfStatement(
            null,
            condition: ifLowerIsGreaterThanUpperExpression,
            thenStatement: stepBoundAssingment,
            elseStatement: null);
        var startLabel = GenerateLabel();
        var gotoStart = new BoundGotoStatement(null, startLabel);
        var bodyLabel = GenerateLabel();
        var bodyLabelStatement = new BoundLabelStatement(null, bodyLabel);
        var continueLabelStatement = new BoundLabelStatement(null, node.ContinueLabel);
        var increment = new BoundExpressionStatement(
            null,
            expression: new BoundAssignmentExpression(
                null,
                variable: node.Variable,
                expression: new BoundBinaryExpression(
                    null,
                    left: variableExpression,
                    op: BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    right: stepBoundExpression)));
        var startLabelStatement = new BoundLabelStatement(null, startLabel);
        var zeroLiteralExpression = new BoundLiteralExpression(null, 0);
        var stepGreaterThanZeroExpression = new BoundBinaryExpression(
            null,
            left: stepBoundExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32),
            right: zeroLiteralExpression);
        var lowerLessThanUpperExpression = new BoundBinaryExpression(
            null,
            left: variableExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32),
            right: upperBoundExpression);
        var positiveStepAndLowerLessThanUpper = new BoundBinaryExpression(
            null,
            left: stepGreaterThanZeroExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
            right: lowerLessThanUpperExpression);
        var stepLessThanZeroExpression = new BoundBinaryExpression(
            null,
            left: stepBoundExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32),
            right: zeroLiteralExpression);
        var lowerGreaterThanUpperExpression = new BoundBinaryExpression(
            null,
            left: variableExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32),
            right: upperBoundExpression);
        var negativeStepAndLowerGreaterThanUpper = new BoundBinaryExpression(
            null,
            left: stepLessThanZeroExpression,
            op: BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
            right: lowerGreaterThanUpperExpression);
        var condition = new BoundBinaryExpression(
            null,
            positiveStepAndLowerLessThanUpper,
            BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool),
            negativeStepAndLowerGreaterThanUpper);
        var gotoTrue = new BoundConditionalGotoStatement(null, bodyLabel, condition, jumpIfTrue: true);
        var breakLabelStatement = new BoundLabelStatement(null, node.BreakLabel);

        var result = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
            variableDeclaration,
            upperBoundDeclaration,
            stepBoundDeclaration,
            ifLowerIsGreaterThanUpperIfStatement,
            gotoStart,
            bodyLabelStatement,
            node.Body,
            continueLabelStatement,
            increment,
            startLabelStatement,
            gotoTrue,
            breakLabelStatement));
        return RewriteStatement(result);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteForRangeStatement(BoundForRangeStatement node)
    {
        // for [<k>,] <v> := range <coll>
        //     <body>
        //
        // ---->  (kind-dependent lowering — see helpers below)
        //
        // For arrays/slices (Indexed): index-based iteration using
        // BoundIndexExpression + BoundLenExpression.
        // For CLR dictionaries and enumerables: iterator-based iteration
        // using GetEnumerator()/MoveNext()/Current resolved by reflection.
        BoundStatement lowered = node.IterationKind switch
        {
            ForRangeKind.Indexed => LowerIndexedRange(node),
            ForRangeKind.Dictionary => LowerCollectionRange(node, isDictionary: true),
            ForRangeKind.Enumerable => LowerCollectionRange(node, isDictionary: false),
            ForRangeKind.PatternEnumerator => LowerCollectionRange(node, isDictionary: false),
            _ => throw new System.InvalidOperationException($"Unknown ForRangeKind {node.IterationKind}"),
        };

        return RewriteStatement(lowered);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteAwaitForRangeStatement(BoundAwaitForRangeStatement node)
    {
        // Phase 5.8 / ADR-0023 — issue #148: desugar
        //   await for v in stream { <body> }
        // into the equivalent try/finally with an awaiting MoveNextAsync
        // loop and an awaiting DisposeAsync. After the rewrite, the
        // AsyncStateMachineRewriter pipeline (AsyncExceptionHandlerRewriter
        // + SpillSequenceSpiller + MoveNextBodyRewriter) handles the
        // resulting awaits — including the await inside the finally
        // (Pattern B in AsyncExceptionHandlerRewriter).
        //
        // {
        //   var __enum = stream.GetAsyncEnumerator(default(CancellationToken))
        //   try {
        //     start:
        //     var __more = await __enum.MoveNextAsync()
        //     gotoFalse __more, end
        //     v = __enum.Current
        //     <body>
        //     goto start
        //     end:
        //   } finally {
        //     await __enum.DisposeAsync()
        //   }
        // }
        var stream = RewriteExpression(node.Stream);
        var body = RewriteStatement(node.Body);

        var lowered = LowerAwaitForRange(node.ValueVariable, stream, body, node.BreakLabel, node.ContinueLabel);
        return RewriteStatement(lowered);
    }

    /// <inheritdoc/>
    /// <summary>
    /// Issue #948: a <c>const</c> field read has no runtime storage — inline it
    /// as the compile-time constant literal so all downstream paths (value
    /// loads, value-type method-call receivers needing an address, etc.) treat
    /// it uniformly. Matches C# const-read semantics.
    /// </summary>
    /// <param name="node">The field-access node.</param>
    /// <returns>A literal for const fields; otherwise the base rewrite.</returns>
    protected override BoundExpression RewriteFieldAccessExpression(BoundFieldAccessExpression node)
    {
        if (node.Field.IsConst)
        {
            return new BoundLiteralExpression(null, node.Field.ConstantValue, node.Field.Type);
        }

        return base.RewriteFieldAccessExpression(node);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewritePropertyAccessExpression(BoundPropertyAccessExpression node)
    {
        // ADR-0051: auto-properties lower to backing field access, but ONLY when
        // we are inside the type that DIRECTLY declares the property. The backing
        // field is private (DeclarationBinder), so it is only legal to touch from
        // its exact declaring type. Issue #1486: an INHERITED auto-property read
        // from a derived method must instead dispatch through the accessor
        // (callvirt get_X) — node.StructType is the receiver's static type, not
        // the property's declaring type, so it cannot gate this on its own.
        if (node.Property.IsAutoProperty && node.Property.BackingField != null
            && this.declaringType != null && DeclaresPropertyDirectly(this.declaringType, node.Property))
        {
            return new BoundFieldAccessExpression(null, node.Receiver, node.StructType, node.Property.BackingField, node.NarrowedType);
        }

        // Computed properties (or external access) remain as BoundPropertyAccessExpression —
        // the interpreter evaluates the getter body and the emitter emits a call to get_X.
        return base.RewritePropertyAccessExpression(node);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewritePropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
    {
        // ADR-0051: auto-properties lower to backing field assignment, but ONLY
        // when we are inside the type that DIRECTLY declares the property (same
        // private-backing-field rationale as read access). Issue #1486: writing
        // an INHERITED auto-property from a derived method must dispatch through
        // the accessor (callvirt set_X) instead of touching the base's private
        // backing field.
        if (node.Property.IsAutoProperty && node.Property.BackingField != null
            && this.declaringType != null && DeclaresPropertyDirectly(this.declaringType, node.Property))
        {
            var value = RewriteExpression(node.Value);

            // Issue #263: static auto-property assignment — lower to static field assignment.
            if (node.Receiver == null)
            {
                return new BoundFieldAssignmentExpression(null, receiver: null, node.StructType, node.Property.BackingField, value);
            }

            if (node.Receiver is BoundVariableExpression varExpr)
            {
                return new BoundFieldAssignmentExpression(null, varExpr.Variable, node.StructType, node.Property.BackingField, value);
            }
        }

        // Computed properties (or non-variable receivers, or external access)
        // remain as BoundPropertyAssignmentExpression.
        return base.RewritePropertyAssignmentExpression(node);
    }

    /// <summary>
    /// Issue #1486: determines whether <paramref name="type"/> DIRECTLY declares
    /// <paramref name="prop"/> (an own, non-inherited property), so the private
    /// backing field is legally accessible. <see cref="StructSymbol.Properties"/>
    /// lists only own properties. On a constructed generic instance the property
    /// is a substituted clone, but <see cref="PropertySymbol.BackingField"/> is
    /// carried by reference from the definition, so it gives a stable identity to
    /// match against the type's own properties for any base/derived depth and for
    /// both generic and non-generic types.
    /// </summary>
    private static bool DeclaresPropertyDirectly(StructSymbol type, PropertySymbol prop)
    {
        if (type == null || prop == null)
        {
            return false;
        }

        foreach (var own in type.Properties)
        {
            if (ReferenceEquals(own, prop))
            {
                return true;
            }

            if (prop.BackingField != null && ReferenceEquals(own.BackingField, prop.BackingField))
            {
                return true;
            }
        }

        return false;
    }

    private BoundStatement LowerAwaitForRange(VariableSymbol valueVariable, BoundExpression stream, BoundStatement body, BoundLabel breakLabel, BoundLabel continueLabel)
    {
        var streamClr = stream.Type?.ClrType;
        if (streamClr == null)
        {
            return new BoundExpressionStatement(null, new BoundErrorExpression(null));
        }

        System.Type asyncEnumerableInterface = null;
        if (streamClr.IsGenericType &&
            !streamClr.IsGenericTypeDefinition &&
            streamClr.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1")
        {
            asyncEnumerableInterface = streamClr;
        }
        else
        {
            foreach (var iface in streamClr.GetInterfaces())
            {
                if (iface.IsGenericType &&
                    !iface.IsGenericTypeDefinition &&
                    iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1")
                {
                    asyncEnumerableInterface = iface;
                    break;
                }
            }
        }

        // Issue #652: resolve all helper types from the same MetadataLoadContext
        // as the stream type. Using typeof(...) here would yield host-runtime types
        // that cannot be mixed with MLC-loaded types in MakeGenericType/GetMethod
        // calls, causing ArgumentException ("Type must be a type provided by the
        // MetadataLoadContext").  Instead, derive everything from the interface and
        // method signatures that are already in the correct context.
        System.Reflection.MethodInfo getAsyncEnumerator;
        System.Reflection.MethodInfo moveNextAsync;
        System.Reflection.MemberInfo currentMember;
        if (asyncEnumerableInterface != null)
        {
            // Fast path: GetAsyncEnumerator is the sole method on IAsyncEnumerable<T>.
            getAsyncEnumerator = asyncEnumerableInterface.GetMethod("GetAsyncEnumerator");
            if (getAsyncEnumerator == null)
            {
                return new BoundExpressionStatement(null, new BoundErrorExpression(null));
            }

            var ifaceEnumeratorClr = getAsyncEnumerator.ReturnType;
            moveNextAsync = ifaceEnumeratorClr.GetMethod("MoveNextAsync");
            currentMember = ifaceEnumeratorClr.GetProperty("Current");
        }
        else if (!MemberLookup.TryResolveClrPatternAsyncEnumerator(streamClr, out getAsyncEnumerator, out moveNextAsync, out currentMember))
        {
            // Issue #2280: neither the `IAsyncEnumerable[T]` interface nor
            // the duck-typed `await foreach` pattern (a public instance
            // `GetAsyncEnumerator(...)` whose enumerator exposes
            // `MoveNextAsync()`/`Current`) is present — e.g.
            // `System.Runtime.CompilerServices.ConfiguredCancelableAsyncEnumerable[T]`
            // (from `IAsyncEnumerable[T].ConfigureAwait(false)`) qualifies
            // via this fallback since it implements no interfaces at all.
            // The binder already validated one of the two shapes exists, so
            // this branch should not be reachable for well-typed programs.
            return new BoundExpressionStatement(null, new BoundErrorExpression(null));
        }

        if (moveNextAsync == null || currentMember == null)
        {
            return new BoundExpressionStatement(null, new BoundErrorExpression(null));
        }

        // Issue #2280: `DisposeAsync` may be reached through the
        // `IAsyncDisposable` interface (the common case for compiler-
        // generated iterators), or — for a fully duck-typed enumerator such
        // as `ConfiguredCancelableAsyncEnumerable[T].Enumerator`, which
        // implements no interfaces — as a plain public instance method found
        // directly on the enumerator type. Per the C# spec, when neither
        // shape is present the loop performs no disposal at all (rather than
        // failing to bind), so `disposeAsync` is allowed to stay null here.
        var enumeratorClr = getAsyncEnumerator.ReturnType;
        System.Reflection.MethodInfo disposeAsync = null;
        foreach (var iface in enumeratorClr.GetInterfaces())
        {
            if (iface.FullName == "System.IAsyncDisposable")
            {
                disposeAsync = iface.GetMethod("DisposeAsync");
                break;
            }
        }

        if (disposeAsync == null)
        {
            disposeAsync = enumeratorClr.GetMethod(
                "DisposeAsync",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                binder: null,
                types: System.Type.EmptyTypes,
                modifiers: null);
        }

        // The awaited result type of MoveNextAsync()/DisposeAsync() — from
        // their actual return types (MLC context). These may be
        // `ValueTask<bool>`/`ValueTask` (the interface shape) or a
        // duck-typed awaitable such as `ConfiguredValueTaskAwaitable<bool>`/
        // `ConfiguredValueTaskAwaitable` (the pattern shape produced by
        // `.ConfigureAwait(false)`) — `BoundAwaitExpression`'s lowering
        // (`AwaitableShape.Resolve`) already resolves the
        // `GetAwaiter`/`IsCompleted`/`GetResult` triple structurally for any
        // CLR type, so no special-casing is needed here beyond using the
        // real return type instead of a hardcoded `ValueTask`.
        var valueTaskBoolClr = moveNextAsync.ReturnType;
        var valueTaskBoolType = TypeSymbol.FromClrType(valueTaskBoolClr);

        // GetAsyncEnumerator's arity: either the interface's single optional
        // `CancellationToken` parameter, or the fully duck-typed parameterless
        // overload (e.g. `ConfiguredCancelableAsyncEnumerable[T].GetAsyncEnumerator()`).
        var getAsyncEnumeratorParams = getAsyncEnumerator.GetParameters();
        ImmutableArray<BoundExpression> getEnumeratorArgs;
        if (getAsyncEnumeratorParams.Length == 0)
        {
            getEnumeratorArgs = ImmutableArray<BoundExpression>.Empty;
        }
        else
        {
            var paramType = TypeSymbol.FromClrType(getAsyncEnumeratorParams[0].ParameterType);
            getEnumeratorArgs = ImmutableArray.Create<BoundExpression>(new BoundDefaultExpression(null, paramType));
        }

        // Issue #1002 (parallel to #774 for sync `for-in`): when the stream
        // is a symbolic `ImportedTypeSymbol IAsyncEnumerable[Shape]` whose
        // `Shape` is a same-compilation user type, the closed CLR shape is
        // erased to `IAsyncEnumerable<object>` and the discovered
        // `enumeratorClr` becomes `IAsyncEnumerator<object>`. Reading
        // `Current` from that closed property yields `object`, which the
        // verifier rejects when stored into the strongly-typed
        // `valueVariable` (Shape) — even though the runtime tolerates the
        // reference. Synthesize a symbolic `IAsyncEnumerator[Shape]` so
        // the BoundClrPropertyAccessExpression carries the user's `Shape`,
        // mirroring the synchronous symbolic-open path. Pattern-based
        // wrappers can be erased too, so recover their open enumerator and
        // Current shapes through the stream's symbolic arguments.
        TypeSymbol enumeratorType;
        TypeSymbol currentType;
        if (stream.Type is ImportedTypeSymbol streamImp
            && streamImp.HasSubstitutableTypeArgument
            && streamImp.OpenDefinition != null
            && streamImp.OpenDefinition.FullName == "System.Collections.Generic.IAsyncEnumerable`1"
            && streamImp.TypeArguments.Length == 1)
        {
            var elementSym = streamImp.TypeArguments[0];
            enumeratorType = ImportedTypeSymbol.GetConstructed(
                enumeratorClr,
                typeof(System.Collections.Generic.IAsyncEnumerator<>),
                ImmutableArray.Create<TypeSymbol>(elementSym));
            currentType = elementSym;
        }
        else if (stream.Type is ImportedTypeSymbol patternImp
            && patternImp.OpenDefinition != null
            && !patternImp.TypeArguments.IsDefaultOrEmpty
            && MemberLookup.TryResolveClrPatternAsyncEnumerator(
                patternImp.OpenDefinition,
                out var openGetAsyncEnumerator,
                out _,
                out var openCurrentMember))
        {
            enumeratorType = MemberLookup.MapOpenClrTypeToSymbolic(openGetAsyncEnumerator.ReturnType, patternImp);
            var openCurrentType = openCurrentMember switch
            {
                System.Reflection.PropertyInfo property => property.PropertyType,
                System.Reflection.FieldInfo field => field.FieldType,
                _ => null,
            };
            currentType = openCurrentType == null
                ? valueVariable.Type
                : MemberLookup.MapOpenClrTypeToSymbolic(openCurrentType, patternImp);
        }
        else
        {
            enumeratorType = TypeSymbol.FromClrType(enumeratorClr);
            currentType = GetClrMemberType(currentMember);
        }

        var enumeratorSymbol = new LocalVariableSymbol("$awaitEnum", isReadOnly: true, type: enumeratorType);
        var enumeratorExpr = new BoundVariableExpression(null, enumeratorSymbol);
        var getEnumCall = new BoundImportedInstanceCallExpression(
            null,
            stream,
            getAsyncEnumerator,
            enumeratorType,
            getEnumeratorArgs);
        var enumeratorDecl = new BoundVariableDeclaration(null, enumeratorSymbol, getEnumCall);

        // Issue #937: the loop's continue label sits at the MoveNextAsync
        // step (so `continue` advances to the next element) and the break
        // label sits at the loop exit, still inside the try so the finally's
        // DisposeAsync await runs when `break` leaves the loop.
        var startLabel = continueLabel;
        var endLabel = breakLabel;
        var moreSymbol = new LocalVariableSymbol("$more", isReadOnly: false, type: TypeSymbol.Bool);

        var moveNextCall = new BoundImportedInstanceCallExpression(
            null,
            enumeratorExpr,
            moveNextAsync,
            valueTaskBoolType,
            ImmutableArray<BoundExpression>.Empty);
        var moveNextAwait = new BoundAwaitExpression(null, moveNextCall, TypeSymbol.Bool);
        var moreDecl = new BoundVariableDeclaration(null, moreSymbol, moveNextAwait);

        var currentAccess = new BoundClrPropertyAccessExpression(null, enumeratorExpr, currentMember, currentType);

        // The iteration binding is a fresh lexical local on every pass.
        var assignValue = new BoundVariableDeclaration(null, valueVariable, currentAccess);

        var tryStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        tryStatements.Add(new BoundLabelStatement(null, startLabel));
        tryStatements.Add(moreDecl);
        tryStatements.Add(new BoundConditionalGotoStatement(null, endLabel, new BoundVariableExpression(null, moreSymbol), jumpIfTrue: false));
        tryStatements.Add(assignValue);
        tryStatements.Add(body);
        tryStatements.Add(new BoundGotoStatement(null, startLabel));
        tryStatements.Add(new BoundLabelStatement(null, endLabel));
        var tryBlock = new BoundBlockStatement(null, tryStatements.ToImmutable());

        if (disposeAsync == null)
        {
            // Issue #2280: no `IAsyncDisposable`/pattern `DisposeAsync()` at
            // all — per the C# spec the loop performs no disposal (matches
            // `await foreach`'s own behavior for such enumerators).
            return new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(enumeratorDecl, tryBlock));
        }

        var valueTaskClr = disposeAsync.ReturnType;
        var valueTaskType = TypeSymbol.FromClrType(valueTaskClr);
        var disposeCall = new BoundImportedInstanceCallExpression(
            null,
            enumeratorExpr,
            disposeAsync,
            valueTaskType,
            ImmutableArray<BoundExpression>.Empty);
        var disposeAwait = new BoundAwaitExpression(null, disposeCall, TypeSymbol.Void);
        var finallyBlock = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, disposeAwait)));

        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);

        return new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(enumeratorDecl, tryStmt));
    }

    private BoundStatement LowerIndexedRange(BoundForRangeStatement node)
    {
        // {
        //   var __coll = <collection>
        //   var __i = 0
        //   goto start
        //   body:
        //   <key> = __i   (only if key var present)
        //   <value> = __coll[__i]
        //   <body>
        //   continue:
        //   __i = __i + 1
        //   start:
        //   gotoTrue (__i < len(__coll)) body
        //   break:
        // }
        var collectionSymbol = new LocalVariableSymbol("$coll", isReadOnly: true, type: node.Collection.Type);
        var collectionDecl = new BoundVariableDeclaration(null, collectionSymbol, node.Collection);
        var collectionExpr = new BoundVariableExpression(null, collectionSymbol);

        var indexSymbol = new LocalVariableSymbol("$i", isReadOnly: false, type: TypeSymbol.Int32);
        var indexDecl = new BoundVariableDeclaration(null, indexSymbol, new BoundLiteralExpression(null, 0));
        var indexExpr = new BoundVariableExpression(null, indexSymbol);

        var startLabel = GenerateLabel();
        var bodyLabel = GenerateLabel();

        var perIterationStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (node.KeyVariable != null)
        {
            perIterationStatements.Add(new BoundVariableDeclaration(null, node.KeyVariable, indexExpr));
        }

        perIterationStatements.Add(new BoundVariableDeclaration(
            null,
            node.ValueVariable,
            new BoundIndexExpression(null, collectionExpr, indexExpr, node.ValueVariable.Type)));

        perIterationStatements.Add(node.Body);

        var increment = new BoundExpressionStatement(
            null,
            new BoundAssignmentExpression(
                null,
                indexSymbol,
                new BoundBinaryExpression(
                    null,
                    indexExpr,
                    BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    new BoundLiteralExpression(null, 1))));

        var hasMore = new BoundBinaryExpression(
            null,
            indexExpr,
            BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32),
            new BoundLenExpression(null, collectionExpr));

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(collectionDecl);
        statements.Add(indexDecl);
        statements.Add(new BoundGotoStatement(null, startLabel));
        statements.Add(new BoundLabelStatement(null, bodyLabel));
        statements.AddRange(perIterationStatements);
        statements.Add(new BoundLabelStatement(null, node.ContinueLabel));
        statements.Add(increment);
        statements.Add(new BoundLabelStatement(null, startLabel));
        statements.Add(new BoundConditionalGotoStatement(null, bodyLabel, hasMore, jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(null, node.BreakLabel));
        return new BoundBlockStatement(null, statements.ToImmutable());
    }

    private BoundStatement LowerCollectionRange(BoundForRangeStatement node, bool isDictionary)
    {
        // {
        //   var __enum = <coll>.GetEnumerator()
        //   var __i = 0    (only for Enumerable when keyVar is present)
        //   goto start
        //   body:
        //   <key> = __i  OR  __enum.Current.Key      (depending on kind)
        //   <value> = __enum.Current  OR  __enum.Current.Value
        //   <body>
        //   continue:
        //   __i = __i + 1   (only for Enumerable when keyVar is present)
        //   start:
        //   gotoTrue __enum.MoveNext() body
        //   break:
        // }
        if (!TryBuildGetEnumeratorCall(node.Collection, out var getEnumCall, out var enumeratorType))
        {
            // Defensive: bail out unchanged if we can't resolve. The
            // binder already validated this case, so this shouldn't fire.
            return new BoundExpressionStatement(node.Syntax, new BoundErrorExpression(node.Syntax));
        }

        if (!TryBuildMoveNextAndCurrent(enumeratorType, out var moveNextCallFactory, out var currentAccessFactory))
        {
            return new BoundExpressionStatement(node.Syntax, new BoundErrorExpression(node.Syntax));
        }

        var enumeratorSymbol = new LocalVariableSymbol("$enum", isReadOnly: true, type: enumeratorType);
        var enumeratorDecl = new BoundVariableDeclaration(node.Syntax, enumeratorSymbol, getEnumCall);
        var enumeratorExpr = new BoundVariableExpression(node.Syntax, enumeratorSymbol);

        var startLabel = GenerateLabel();
        var bodyLabel = GenerateLabel();

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(enumeratorDecl);

        LocalVariableSymbol indexSymbol = null;
        if (!isDictionary && node.KeyVariable != null)
        {
            indexSymbol = new LocalVariableSymbol("$i", isReadOnly: false, type: TypeSymbol.Int32);
            statements.Add(new BoundVariableDeclaration(node.Syntax, indexSymbol, new BoundLiteralExpression(node.Syntax, 0)));
        }

        statements.Add(new BoundGotoStatement(node.Syntax, startLabel));
        statements.Add(new BoundLabelStatement(node.Syntax, bodyLabel));

        var currentAccess = currentAccessFactory(enumeratorExpr);

        if (isDictionary)
        {
            // Issue #1328: a single-identifier dictionary iteration
            // (`for kv in dict`) binds the whole `KeyValuePair[K, V]` element —
            // there is no key variable, so assign `Current` (the pair) directly
            // to the loop variable. The two-var form (`for k, v in dict`)
            // continues to destructure into `Current.Key` / `Current.Value`.
            if (node.KeyVariable == null)
            {
                statements.Add(new BoundVariableDeclaration(
                    node.Syntax,
                    node.ValueVariable,
                    ConvertEnumeratorCurrent(currentAccess, node.ValueVariable.Type)));
            }
            else
            {
                // Issue #774: when `currentAccess.Type` is a symbolic open
                // KeyValuePair[K, V] (because the receiver was an open
                // `Dictionary[K, V]`), the closed CLR `Key`/`Value` properties
                // both report `object`. Honour the symbolic arguments so the
                // synthesised key/value declarations carry the user's `K`/`V`.
                var kvpType = currentAccess.Type;
                var kvpClr = kvpType.ClrType;
                var keyProp = kvpClr.GetProperty("Key");
                var valueProp = kvpClr.GetProperty("Value");

                TypeSymbol keyAccessType = TypeSymbol.FromClrType(keyProp.PropertyType);
                TypeSymbol valueAccessType = TypeSymbol.FromClrType(valueProp.PropertyType);
                if (kvpType is ImportedTypeSymbol kvpImp
                    && kvpImp.HasSubstitutableTypeArgument
                    && kvpImp.TypeArguments.Length == 2)
                {
                    keyAccessType = kvpImp.TypeArguments[0];
                    valueAccessType = kvpImp.TypeArguments[1];
                }

                var kvpSymbol = new LocalVariableSymbol("$kvp", isReadOnly: true, type: kvpType);
                statements.Add(new BoundVariableDeclaration(node.Syntax, kvpSymbol, currentAccess));
                var kvpExpr = new BoundVariableExpression(node.Syntax, kvpSymbol);

                statements.Add(new BoundVariableDeclaration(
                    node.Syntax,
                    node.KeyVariable,
                    new BoundClrPropertyAccessExpression(node.Syntax, kvpExpr, keyProp, keyAccessType)));

                statements.Add(new BoundVariableDeclaration(
                    node.Syntax,
                    node.ValueVariable,
                    new BoundClrPropertyAccessExpression(node.Syntax, kvpExpr, valueProp, valueAccessType)));
            }
        }
        else
        {
            if (node.KeyVariable != null)
            {
                statements.Add(new BoundVariableDeclaration(node.Syntax, node.KeyVariable, new BoundVariableExpression(node.Syntax, indexSymbol)));
            }

            statements.Add(new BoundVariableDeclaration(
                node.Syntax,
                node.ValueVariable,
                ConvertEnumeratorCurrent(currentAccess, node.ValueVariable.Type)));
        }

        statements.Add(node.Body);
        statements.Add(new BoundLabelStatement(node.Syntax, node.ContinueLabel));

        if (indexSymbol != null)
        {
            var indexExpr = new BoundVariableExpression(node.Syntax, indexSymbol);
            statements.Add(new BoundExpressionStatement(
                node.Syntax,
                new BoundAssignmentExpression(
                    node.Syntax,
                    indexSymbol,
                    new BoundBinaryExpression(
                        node.Syntax,
                        indexExpr,
                        BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        new BoundLiteralExpression(node.Syntax, 1)))));
        }

        statements.Add(new BoundLabelStatement(node.Syntax, startLabel));
        statements.Add(new BoundConditionalGotoStatement(node.Syntax, bodyLabel, moveNextCallFactory(enumeratorExpr), jumpIfTrue: true));
        statements.Add(new BoundLabelStatement(node.Syntax, node.BreakLabel));

        // Wrap the iteration in try-finally so the enumerator is disposed
        // on early break, return, or exception — matching C# foreach. We
        // only emit the disposer when the enumerator implements IDisposable
        // (e.g. all synthesized iterator state machines do). The enumerator
        // variable declaration is moved into an outer scope so its handle
        // is still in scope in the finally.
        //
        // We skip the wrap when the loop body itself contains a yield or
        // await: in those cases the enclosing function is rewritten as an
        // iterator or async state machine, and that pipeline does not yet
        // generally handle protected regions around its suspension points.
        // Avoiding the wrap here preserves the pre-existing behavior for
        // those callers while still adding Dispose coverage for the common
        // case (plain foreach over an enumerable).
        var disposeCall = TryBuildEnumeratorDisposeCall(enumeratorSymbol);
        if (disposeCall != null && !BodyContainsYieldOrAwait(node.Body))
        {
            // Outer block:
            //   var $enum = coll.GetEnumerator();
            //   try { ... loop body ... } finally { $enum.Dispose(); }
            var loopStatements = statements.ToImmutable();

            // Drop the enumeratorDecl from the loop body — it lives outside the try.
            // (It was added at index 0.)
            var withoutEnumDecl = ImmutableArray.CreateRange(System.Linq.Enumerable.Skip(loopStatements, 1));

            var tryBlock = new BoundBlockStatement(node.Syntax, withoutEnumDecl);
            var finallyBlock = new BoundBlockStatement(
                node.Syntax,
                ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(node.Syntax, disposeCall)));
            var tryFinally = new BoundTryStatement(
                node.Syntax,
                tryBlock,
                ImmutableArray<BoundCatchClause>.Empty,
                finallyBlock);

            return new BoundBlockStatement(
                node.Syntax,
                ImmutableArray.Create<BoundStatement>(enumeratorDecl, tryFinally));
        }

        return new BoundBlockStatement(node.Syntax, statements.ToImmutable());
    }

    private static BoundExpression ConvertEnumeratorCurrent(BoundExpression current, TypeSymbol elementType)
    {
        return current.Type == TypeSymbol.Object || current.Type?.ClrType.IsSameAs(typeof(object)) == true
            ? new BoundConversionExpression(current.Syntax, elementType, current)
            : current;
    }

    private static BoundExpression TryBuildEnumeratorDisposeCall(LocalVariableSymbol enumeratorSymbol)
    {
        var clrType = enumeratorSymbol.Type?.ClrType;
        if (clrType == null)
        {
            return null;
        }

        System.Reflection.MethodInfo disposeMethod = null;

        // Pattern-based dispose for struct enumerators: prefer the type's
        // own public parameterless Dispose() so we get a direct `call` on
        // a managed pointer to the struct (no boxing). This matches how
        // Roslyn lowers `foreach` over List<T>/Dictionary<K,V> etc., and
        // is important because the IDisposable-typed call would box the
        // enumerator on every iteration of an enclosing loop nest.
        if (clrType.IsValueType)
        {
            var ownDispose = clrType.GetMethod(
                "Dispose",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                binder: null,
                types: System.Type.EmptyTypes,
                modifiers: null);
            if (ownDispose != null && ownDispose.ReturnType.IsSameAs(typeof(void)))
            {
                disposeMethod = ownDispose;
            }
        }

        // Fall back to the IDisposable interface dispatch when the
        // enumerator is a reference type, or when it is a value type that
        // implements IDisposable only via explicit interface. (The latter
        // boxes — but pattern-based dispose simply isn't available for
        // those.)
        if (disposeMethod == null)
        {
            if (!typeof(System.IDisposable).IsAssignableFrom(clrType))
            {
                return null;
            }

            disposeMethod = typeof(System.IDisposable).GetMethod("Dispose", System.Type.EmptyTypes);
        }

        if (disposeMethod == null)
        {
            return null;
        }

        var receiver = new BoundVariableExpression(null, enumeratorSymbol);
        return new BoundImportedInstanceCallExpression(
            null,
            receiver,
            disposeMethod,
            TypeSymbol.Void,
            ImmutableArray<BoundExpression>.Empty);
    }

    private static bool BodyContainsYieldOrAwait(BoundStatement body)
    {
        var walker = new YieldOrAwaitDetector();
        walker.Visit(body);
        return walker.Found;
    }

    private static bool TryBuildGetEnumeratorCall(
        BoundExpression collection,
        out BoundExpression getEnumeratorCall,
        out TypeSymbol enumeratorType)
    {
        // Issue #774: when the receiver is an open generic shape carrying an
        // in-scope type parameter (e.g. `IEnumerable[T]`, `sequence[T]`,
        // `Dictionary[K, V]`), the closed CLR shape is erased to `object` and
        // its native `GetEnumerator()` would yield `IEnumerator<object>` /
        // a struct enumerator typed against `object`. That collapses the loop
        // variable to `object` and forces a verifier-broken `unbox.any` on
        // every `Current` read. Synthesize a symbolic
        // `IEnumerator[ElementSym]` enumerator instead so the rest of the
        // loop lowers with the user's `T` (or `KeyValuePair[K, V]`) intact.
        if (TryBuildSymbolicOpenGetEnumeratorCall(collection, out getEnumeratorCall, out enumeratorType))
        {
            return true;
        }

        var clrType = collection.Type.ClrType;
        if (clrType != null)
        {
            var getEnumerator = ResolveGetEnumerator(clrType);
            if (getEnumerator != null)
            {
                enumeratorType = TypeSymbol.FromClrType(getEnumerator.ReturnType);
                getEnumeratorCall = new BoundImportedInstanceCallExpression(
                    null,
                    collection,
                    getEnumerator,
                    enumeratorType,
                    ImmutableArray<BoundExpression>.Empty);
                return true;
            }
        }

        if (collection.Type is StructSymbol userType &&
            userType.TryGetMethodIncludingInherited("GetEnumerator", out var userGetEnumerator) &&
            userGetEnumerator.Parameters.Length == 0)
        {
            enumeratorType = userGetEnumerator.Type;
            getEnumeratorCall = new BoundUserInstanceCallExpression(
                null,
                collection,
                userGetEnumerator,
                ImmutableArray<BoundExpression>.Empty);
            return true;
        }

        getEnumeratorCall = null;
        enumeratorType = null;
        return false;
    }

    /// <summary>
    /// Issue #774: builds a <c>GetEnumerator()</c> call against a symbolic
    /// open-generic receiver (a <see cref="SequenceTypeSymbol"/> /
    /// <see cref="AsyncSequenceTypeSymbol"/> with a null <c>ClrType</c>, or an
    /// <see cref="ImportedTypeSymbol"/> with
    /// <see cref="ImportedTypeSymbol.HasTypeParameterArgument"/>). Produces a
    /// symbolic <c>IEnumerator[ElementSym]</c> typed
    /// <see cref="ImportedTypeSymbol"/> so the rest of the loop lowering
    /// (Current access, key/value extraction) carries the user's symbolic
    /// argument instead of the erased <c>object</c> shape.
    /// </summary>
    private static bool TryBuildSymbolicOpenGetEnumeratorCall(
        BoundExpression collection,
        out BoundExpression getEnumeratorCall,
        out TypeSymbol enumeratorType)
    {
        getEnumeratorCall = null;
        enumeratorType = null;

        var collectionType = collection.Type;
        System.Type openDef;
        ImmutableArray<TypeSymbol> typeArguments;

        switch (collectionType)
        {
            case SequenceTypeSymbol seq when seq.ClrType == null:
                openDef = typeof(System.Collections.Generic.IEnumerable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(seq.ElementType);
                break;
            case ImportedTypeSymbol imp when imp.HasSubstitutableTypeArgument && imp.OpenDefinition != null:
                openDef = imp.OpenDefinition;
                typeArguments = imp.TypeArguments;
                break;
            default:
                return false;
        }

        // Determine the IEnumerable<X> element CLR type from the open
        // definition. For Dictionary[K, V] we deliberately route through
        // IEnumerable<KeyValuePair<TKey, TValue>>.GetEnumerator() instead of
        // Dictionary<,>.GetEnumerator() (which returns a nested struct
        // Enumerator that complicates symbolic emit on every Current/Key/Value
        // read). The minor allocation cost is acceptable; correctness wins.
        System.Type openElementClr;
        if (openDef.FullName == "System.Collections.Generic.IEnumerable`1")
        {
            openElementClr = openDef.GetGenericArguments()[0];
        }
        else if (!MemberLookup.TryGetClrEnumerableElementType(openDef, out openElementClr))
        {
            return false;
        }

        var elementSym = MemberLookup.MapOpenClrTypeToSymbolic(openElementClr, openDef, typeArguments);
        if (elementSym == TypeSymbol.Error)
        {
            return false;
        }

        // Resolve GetEnumerator() on the closed `IEnumerable<object>` shape;
        // the symbolic MemberRef helper on the emit side re-encodes the
        // parent TypeSpec against the symbolic element so the runtime call
        // dispatches to `IEnumerable<TElement>::GetEnumerator()`.
        var enumerableClosed = typeof(System.Collections.Generic.IEnumerable<object>);
        var getEnumerator = enumerableClosed.GetMethod(
            "GetEnumerator",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
            binder: null,
            types: System.Type.EmptyTypes,
            modifiers: null);
        if (getEnumerator == null)
        {
            return false;
        }

        var enumeratorClosed = typeof(System.Collections.Generic.IEnumerator<object>);
        enumeratorType = ImportedTypeSymbol.GetConstructed(
            enumeratorClosed,
            typeof(System.Collections.Generic.IEnumerator<>),
            ImmutableArray.Create<TypeSymbol>(elementSym));

        getEnumeratorCall = new BoundImportedInstanceCallExpression(
            null,
            collection,
            getEnumerator,
            enumeratorType,
            ImmutableArray<BoundExpression>.Empty);
        return true;
    }

    /// <summary>
    /// Resolves the best <c>GetEnumerator()</c> method on a CLR type,
    /// searching implemented interfaces when the type itself (e.g. an
    /// interface like <c>IReadOnlyList&lt;T&gt;</c>) does not directly
    /// declare the method. Prefers the generic
    /// <c>IEnumerable&lt;T&gt;.GetEnumerator()</c> over the non-generic one.
    /// </summary>
    private static System.Reflection.MethodInfo ResolveGetEnumerator(System.Type clrType)
    {
        // First: direct lookup on the type itself (works for concrete types).
        var direct = clrType.GetMethod(
            "GetEnumerator",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
            binder: null,
            types: System.Type.EmptyTypes,
            modifiers: null);
        if (direct != null)
        {
            return direct;
        }

        // For interfaces (e.g. IReadOnlyList<T>, ICollection<T>), the method
        // lives on a parent interface. Search for the generic IEnumerable<T>
        // first (so we get the strongly-typed IEnumerator<T>), then fall back
        // to non-generic IEnumerable.
        // NOTE: We compare by name rather than by Type identity because the
        // referenced BCL types may come from a different assembly load context
        // than the compiler's own runtime.
        System.Reflection.MethodInfo nonGenericFallback = null;
        foreach (var iface in clrType.GetInterfaces())
        {
            if (iface.IsGenericType &&
                iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
            {
                return iface.GetMethod(
                    "GetEnumerator",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                    binder: null,
                    types: System.Type.EmptyTypes,
                    modifiers: null);
            }

            if (iface.FullName == "System.Collections.IEnumerable")
            {
                nonGenericFallback = iface.GetMethod(
                    "GetEnumerator",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                    binder: null,
                    types: System.Type.EmptyTypes,
                    modifiers: null);
            }
        }

        // Also check if the type itself is the generic IEnumerable<T>.
        if (clrType.IsGenericType &&
            clrType.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
        {
            return clrType.GetMethod(
                "GetEnumerator",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                binder: null,
                types: System.Type.EmptyTypes,
                modifiers: null);
        }

        if (clrType.FullName == "System.Collections.IEnumerable")
        {
            return clrType.GetMethod(
                "GetEnumerator",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                binder: null,
                types: System.Type.EmptyTypes,
                modifiers: null);
        }

        return nonGenericFallback;
    }

    private static bool TryBuildMoveNextAndCurrent(
        TypeSymbol enumeratorType,
        out System.Func<BoundExpression, BoundExpression> moveNextCallFactory,
        out System.Func<BoundExpression, BoundExpression> currentAccessFactory)
    {
        var enumeratorClr = enumeratorType.ClrType;
        if (enumeratorClr != null)
        {
            var moveNext = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
                    enumeratorClr, "MoveNext", System.Type.EmptyTypes)
                ?? typeof(System.Collections.IEnumerator).GetMethod("MoveNext", System.Type.EmptyTypes);
            var currentMember = (System.Reflection.MemberInfo)MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces(
                    enumeratorClr, "Current")
                ?? (System.Reflection.MemberInfo)enumeratorClr.GetField("Current", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
                ?? typeof(System.Collections.IEnumerator).GetProperty("Current");
            if (moveNext != null && currentMember != null)
            {
                // Issue #774: when iterating an open generic receiver the
                // synthesised enumerator type is the symbolic
                // `IEnumerator[ElementSym]` whose ClrType is erased to
                // `IEnumerator<object>`. The closed `Current` getter reports
                // `object`, which would collapse the loop variable's type and
                // re-introduce the bug we fixed in the binder. Use the
                // enumerator's symbolic type argument instead so the
                // BoundClrPropertyAccessExpression carries the user's `T`.
                TypeSymbol currentType = null;
                if (enumeratorType is ImportedTypeSymbol enumImp
                    && enumImp.HasSubstitutableTypeArgument
                    && !enumImp.TypeArguments.IsDefaultOrEmpty)
                {
                    currentType = enumImp.TypeArguments[0];
                }

                currentType ??= GetClrMemberType(currentMember);

                moveNextCallFactory = receiver => new BoundImportedInstanceCallExpression(
                    null,
                    receiver,
                    moveNext,
                    TypeSymbol.Bool,
                    ImmutableArray<BoundExpression>.Empty);
                currentAccessFactory = receiver => new BoundClrPropertyAccessExpression(
                    null,
                    receiver,
                    currentMember,
                    currentType);
                return true;
            }
        }

        if (enumeratorType is StructSymbol userEnumerator &&
            userEnumerator.TryGetMethodIncludingInherited("MoveNext", out var userMoveNext) &&
            userMoveNext.Parameters.Length == 0 &&
            userMoveNext.Type == TypeSymbol.Bool &&
            userEnumerator.TryGetField("Current", out var currentField))
        {
            moveNextCallFactory = receiver => new BoundUserInstanceCallExpression(
                null,
                receiver,
                userMoveNext,
                ImmutableArray<BoundExpression>.Empty);
            currentAccessFactory = receiver => new BoundFieldAccessExpression(null, receiver, userEnumerator, currentField);
            return true;
        }

        moveNextCallFactory = null;
        currentAccessFactory = null;
        return false;
    }

    private static TypeSymbol GetClrMemberType(System.Reflection.MemberInfo member)
    {
        return member switch
        {
            System.Reflection.PropertyInfo property => TypeSymbol.FromClrType(property.PropertyType),
            System.Reflection.FieldInfo field => TypeSymbol.FromClrType(field.FieldType),
            _ => TypeSymbol.Error,
        };
    }

    /// <summary>
    /// Issue #737: returns <see langword="true"/> when control flow falling
    /// off the end of <paramref name="statement"/> is unreachable because the
    /// last (non-label) statement is an unconditional control transfer.
    /// Conservative — only the obvious leaf shapes are recognized; a
    /// <see langword="false"/> result is always safe (the caller emits the
    /// trailing <c>goto end</c> + <c>end:</c> pair). The check looks past
    /// trailing label statements because labels emit no IL of their own.
    /// </summary>
    /// <param name="statement">The statement to inspect.</param>
    /// <returns><see langword="true"/> when the statement provably ends in
    /// <c>return</c>, <c>throw</c>, or an unconditional <c>goto</c>; otherwise
    /// <see langword="false"/>.</returns>
    private static bool EndsInUnconditionalTransfer(BoundStatement statement)
    {
        switch (statement)
        {
            case BoundReturnStatement:
            case BoundThrowStatement:
            case BoundGotoStatement:
                return true;
            case BoundBlockStatement block:
                {
                    for (int i = block.Statements.Length - 1; i >= 0; i--)
                    {
                        var s = block.Statements[i];
                        if (s is BoundLabelStatement)
                        {
                            continue;
                        }

                        return EndsInUnconditionalTransfer(s);
                    }

                    return false;
                }

            default:
                return false;
        }
    }

    private static BoundBlockStatement Flatten(BoundStatement statement)
    {
        var builder = ImmutableArray.CreateBuilder<BoundStatement>();
        var stack = new Stack<BoundStatement>();
        stack.Push(statement);

        while (stack.Count > 0)
        {
            var current = stack.Pop();

            if (current is BoundBlockStatement block)
            {
                foreach (var s in block.Statements.Reverse())
                {
                    stack.Push(s);
                }
            }
            else if (current is BoundTryStatement t)
            {
                var flatTry = Flatten(t.TryBlock);
                var flatCatches = ImmutableArray.CreateBuilder<BoundCatchClause>();
                foreach (var clause in t.CatchClauses)
                {
                    flatCatches.Add(new BoundCatchClause(clause.ExceptionType, clause.Variable, Flatten(clause.Body)));
                }

                var flatFinally = t.FinallyBlock == null ? null : (BoundStatement)Flatten(t.FinallyBlock);
                builder.Add(new BoundTryStatement(null, flatTry, flatCatches.ToImmutable(), flatFinally));
            }
            else if (current is BoundScopeStatement scope)
            {
                // Phase 5.7: flatten the scope body so the evaluator's flat-statement
                // walker sees lowered gotos/conditionals instead of nested blocks.
                var flatScopeBody = Flatten(scope.Body);
                builder.Add(new BoundScopeStatement(null, flatScopeBody));
            }
            else if (current is BoundFixedStatement fixedStmt)
            {
                // ADR-0125 / issue #1026: flatten the fixed body so the emitter
                // sees a flat statement list (lowered gotos/conditionals) inside
                // the pinned region; the pin prologue/epilogue wrap it at emit.
                var flatFixedBody = Flatten(fixedStmt.Body);
                builder.Add(new BoundFixedStatement(
                    fixedStmt.Syntax,
                    fixedStmt.PinKind,
                    fixedStmt.PinnedVariable,
                    fixedStmt.PointerVariable,
                    fixedStmt.PinnedSource,
                    flatFixedBody,
                    fixedStmt.SourceVariable));
            }
            else if (current is BoundPatternSwitchStatement ps)
            {
                var flatArms = ImmutableArray.CreateBuilder<BoundPatternSwitchArm>(ps.Arms.Length);
                foreach (var arm in ps.Arms)
                {
                    flatArms.Add(new BoundPatternSwitchArm(null, arm.Pattern, arm.Guard, Flatten(arm.Body)));
                }

                builder.Add(new BoundPatternSwitchStatement(null, ps.Discriminant, flatArms.ToImmutable()));
            }
            else if (current is BoundSelectStatement sel)
            {
                // Phase 5.6: flatten each case body for the same reason.
                var flatCases = ImmutableArray.CreateBuilder<BoundSelectCase>(sel.Cases.Length);
                foreach (var arm in sel.Cases)
                {
                    var flatArmBody = Flatten(arm.Body);
                    flatCases.Add(new BoundSelectCase(arm.CaseKind, arm.Channel, arm.Value, arm.Variable, flatArmBody));
                }

                builder.Add(new BoundSelectStatement(null, flatCases.ToImmutable()));
            }
            else
            {
                builder.Add(current);
            }
        }

        return new BoundBlockStatement(null, builder.ToImmutable());
    }

    private BoundLabel GenerateLabel()
    {
        var name = $"Label{++labelCount}";
        return new BoundLabel(name);
    }

    /// <summary>
    /// Issue #419 (P0-2): when at least one return was rewritten as a goto by
    /// <see cref="RewriteReturnStatement(BoundReturnStatement)"/>, append the
    /// synthetic method-exit label and a terminating <c>return</c> that
    /// reloads the temp (or has no expression for void-returning functions).
    /// The temp is declared at the very top of the method so the emitter's
    /// locals collector allocates a slot for it; the <c>default(T)</c>
    /// initializer makes the slot definitely-assigned and avoids verifier
    /// complaints on unreachable fall-through paths.
    /// </summary>
    private BoundStatement WrapWithMethodExitEpilogue(BoundStatement body)
    {
        if (!this.hasRewrittenReturnsInProtectedRegions)
        {
            return body;
        }

        var stmts = ImmutableArray.CreateBuilder<BoundStatement>();
        if (this.returnValueLocal != null)
        {
            stmts.Add(new BoundVariableDeclaration(
                null,
                this.returnValueLocal,
                new BoundDefaultExpression(null, this.returnValueLocal.Type)));
        }

        stmts.Add(body);
        stmts.Add(new BoundLabelStatement(null, this.methodExitLabel));

        BoundExpression retExpr = this.returnValueLocal == null
            ? null
            : new BoundVariableExpression(null, this.returnValueLocal);
        stmts.Add(new BoundReturnStatement(null, retExpr));

        return new BoundBlockStatement(null, stmts.ToImmutable());
    }

    private sealed class YieldOrAwaitDetector : BoundTreeWalker
    {
        public bool Found { get; private set; }

        protected override void VisitYieldStatement(BoundYieldStatement node)
        {
            this.Found = true;
        }

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            this.Found = true;
        }
    }
}
