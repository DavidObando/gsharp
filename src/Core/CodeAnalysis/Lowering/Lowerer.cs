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
            // goto end
            // else:
            // <else>
            // end:
            var elseLabel = GenerateLabel();
            var endLabel = GenerateLabel();

            var gotoFalse = new BoundConditionalGotoStatement(null, elseLabel, node.Condition, false);
            var gotoEndStatement = new BoundGotoStatement(null, endLabel);
            var elseLabelStatement = new BoundLabelStatement(null, elseLabel);
            var endLabelStatement = new BoundLabelStatement(null, endLabel);
            var result = new BoundBlockStatement(
                null,
                ImmutableArray.Create<BoundStatement>(
                gotoFalse,
                node.ThenStatement,
                gotoEndStatement,
                elseLabelStatement,
                node.ElseStatement,
                endLabelStatement));
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

        var lowered = LowerAwaitForRange(node.ValueVariable, stream, body);
        return RewriteStatement(lowered);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewritePropertyAccessExpression(BoundPropertyAccessExpression node)
    {
        // ADR-0051: auto-properties lower to backing field access, but ONLY when
        // we are inside the declaring type. From outside the type, the backing
        // field is private so we must go through the accessor method (callvirt).
        if (node.Property.IsAutoProperty && node.Property.BackingField != null
            && this.declaringType != null && node.StructType == this.declaringType)
        {
            return new BoundFieldAccessExpression(null, node.Receiver, node.StructType, node.Property.BackingField);
        }

        // Computed properties (or external access) remain as BoundPropertyAccessExpression —
        // the interpreter evaluates the getter body and the emitter emits a call to get_X.
        return base.RewritePropertyAccessExpression(node);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewritePropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
    {
        // ADR-0051: auto-properties lower to backing field assignment, but ONLY
        // when we are inside the declaring type (same rationale as read access).
        if (node.Property.IsAutoProperty && node.Property.BackingField != null
            && this.declaringType != null && node.StructType == this.declaringType)
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

    private BoundStatement LowerAwaitForRange(VariableSymbol valueVariable, BoundExpression stream, BoundStatement body)
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

        if (asyncEnumerableInterface == null)
        {
            return new BoundExpressionStatement(null, new BoundErrorExpression(null));
        }

        var elementClr = asyncEnumerableInterface.GetGenericArguments()[0];
        var enumeratorClr = typeof(System.Collections.Generic.IAsyncEnumerator<>).MakeGenericType(elementClr);
        var valueTaskBoolClr = typeof(System.Threading.Tasks.ValueTask<>).MakeGenericType(typeof(bool));

        var getAsyncEnumerator = asyncEnumerableInterface.GetMethod(
            "GetAsyncEnumerator",
            new[] { typeof(System.Threading.CancellationToken) });
        var moveNextAsync = enumeratorClr.GetMethod("MoveNextAsync", System.Type.EmptyTypes);
        var currentProperty = enumeratorClr.GetProperty("Current");
        var disposeAsync = typeof(System.IAsyncDisposable).GetMethod("DisposeAsync", System.Type.EmptyTypes);

        if (getAsyncEnumerator == null || moveNextAsync == null || currentProperty == null || disposeAsync == null)
        {
            return new BoundExpressionStatement(null, new BoundErrorExpression(null));
        }

        var cancellationTokenType = TypeSymbol.FromClrType(typeof(System.Threading.CancellationToken));
        var enumeratorType = TypeSymbol.FromClrType(enumeratorClr);
        var valueTaskBoolType = TypeSymbol.FromClrType(valueTaskBoolClr);
        var valueTaskType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.ValueTask));
        var currentType = TypeSymbol.FromClrType(currentProperty.PropertyType);

        var enumeratorSymbol = new LocalVariableSymbol("$awaitEnum", isReadOnly: true, type: enumeratorType);
        var enumeratorExpr = new BoundVariableExpression(null, enumeratorSymbol);
        var getEnumCall = new BoundImportedInstanceCallExpression(
            null,
            stream,
            getAsyncEnumerator,
            enumeratorType,
            ImmutableArray.Create<BoundExpression>(new BoundDefaultExpression(null, cancellationTokenType)));
        var enumeratorDecl = new BoundVariableDeclaration(null, enumeratorSymbol, getEnumCall);

        var startLabel = GenerateLabel();
        var endLabel = GenerateLabel();
        var moreSymbol = new LocalVariableSymbol("$more", isReadOnly: false, type: TypeSymbol.Bool);

        var moveNextCall = new BoundImportedInstanceCallExpression(
            null,
            enumeratorExpr,
            moveNextAsync,
            valueTaskBoolType,
            ImmutableArray<BoundExpression>.Empty);
        var moveNextAwait = new BoundAwaitExpression(null, moveNextCall, TypeSymbol.Bool);
        var moreDecl = new BoundVariableDeclaration(null, moreSymbol, moveNextAwait);

        var currentAccess = new BoundClrPropertyAccessExpression(null, enumeratorExpr, currentProperty, currentType);
        var assignValue = new BoundExpressionStatement(
            null,
            new BoundAssignmentExpression(null, valueVariable, currentAccess));

        var tryStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        tryStatements.Add(new BoundLabelStatement(null, startLabel));
        tryStatements.Add(moreDecl);
        tryStatements.Add(new BoundConditionalGotoStatement(null, endLabel, new BoundVariableExpression(null, moreSymbol), jumpIfTrue: false));
        tryStatements.Add(assignValue);
        tryStatements.Add(body);
        tryStatements.Add(new BoundGotoStatement(null, startLabel));
        tryStatements.Add(new BoundLabelStatement(null, endLabel));
        var tryBlock = new BoundBlockStatement(null, tryStatements.ToImmutable());

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
            var kvpClr = currentAccess.Type.ClrType;
            var keyProp = kvpClr.GetProperty("Key");
            var valueProp = kvpClr.GetProperty("Value");
            var kvpSymbol = new LocalVariableSymbol("$kvp", isReadOnly: true, type: TypeSymbol.FromClrType(kvpClr));
            statements.Add(new BoundVariableDeclaration(node.Syntax, kvpSymbol, currentAccess));
            var kvpExpr = new BoundVariableExpression(node.Syntax, kvpSymbol);

            if (node.KeyVariable != null)
            {
                statements.Add(new BoundVariableDeclaration(
                    node.Syntax,
                    node.KeyVariable,
                    new BoundClrPropertyAccessExpression(node.Syntax, kvpExpr, keyProp, TypeSymbol.FromClrType(keyProp.PropertyType))));
            }

            statements.Add(new BoundVariableDeclaration(
                node.Syntax,
                node.ValueVariable,
                new BoundClrPropertyAccessExpression(node.Syntax, kvpExpr, valueProp, TypeSymbol.FromClrType(valueProp.PropertyType))));
        }
        else
        {
            if (node.KeyVariable != null)
            {
                statements.Add(new BoundVariableDeclaration(node.Syntax, node.KeyVariable, new BoundVariableExpression(node.Syntax, indexSymbol)));
            }

            statements.Add(new BoundVariableDeclaration(node.Syntax, node.ValueVariable, currentAccess));
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

    private static BoundExpression TryBuildEnumeratorDisposeCall(LocalVariableSymbol enumeratorSymbol)
    {
        var clrType = enumeratorSymbol.Type?.ClrType;
        if (clrType == null)
        {
            return null;
        }

        if (!typeof(System.IDisposable).IsAssignableFrom(clrType))
        {
            return null;
        }

        var disposeMethod = typeof(System.IDisposable).GetMethod("Dispose", System.Type.EmptyTypes);
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
        walker.RewriteStatement(body);
        return walker.Found;
    }

    private static bool TryBuildGetEnumeratorCall(
        BoundExpression collection,
        out BoundExpression getEnumeratorCall,
        out TypeSymbol enumeratorType)
    {
        var clrType = collection.Type.ClrType;
        if (clrType != null)
        {
            var getEnumerator = clrType.GetMethod(
                "GetEnumerator",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                binder: null,
                types: System.Type.EmptyTypes,
                modifiers: null);
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

    private static bool TryBuildMoveNextAndCurrent(
        TypeSymbol enumeratorType,
        out System.Func<BoundExpression, BoundExpression> moveNextCallFactory,
        out System.Func<BoundExpression, BoundExpression> currentAccessFactory)
    {
        var enumeratorClr = enumeratorType.ClrType;
        if (enumeratorClr != null)
        {
            var moveNext = enumeratorClr.GetMethod(
                "MoveNext",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                binder: null,
                types: System.Type.EmptyTypes,
                modifiers: null)
                ?? typeof(System.Collections.IEnumerator).GetMethod("MoveNext", System.Type.EmptyTypes);
            var currentMember = (System.Reflection.MemberInfo)enumeratorClr.GetProperty(
                    "Current",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
                ?? (System.Reflection.MemberInfo)enumeratorClr.GetField("Current", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
                ?? typeof(System.Collections.IEnumerator).GetProperty("Current");
            if (moveNext != null && currentMember != null)
            {
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
                    GetClrMemberType(currentMember));
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
            else if (current is BoundPatternSwitchStatement ps)
            {
                var flatArms = ImmutableArray.CreateBuilder<BoundPatternSwitchArm>(ps.Arms.Length);
                foreach (var arm in ps.Arms)
                {
                    flatArms.Add(new BoundPatternSwitchArm(null, arm.Pattern, Flatten(arm.Body)));
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

    private sealed class YieldOrAwaitDetector : BoundTreeRewriter
    {
        public bool Found { get; private set; }

        protected override BoundStatement RewriteYieldStatement(BoundYieldStatement node)
        {
            this.Found = true;
            return node;
        }

        protected override BoundExpression RewriteAwaitExpression(BoundAwaitExpression node)
        {
            this.Found = true;
            return node;
        }
    }
}
