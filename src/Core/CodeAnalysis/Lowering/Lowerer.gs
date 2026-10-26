// <copyright file="Lowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import System
import System.Collections
import System.Reflection

/// Bound tree lowerer. It simplifies the AST.
class Lowerer : BoundTreeRewriter {
    // The type whose body is currently being lowered. When non-null, auto-property
    // access on this type is lowered to direct backing-field access (the accessor
    // is inside the type and has access to its private fields). When null (e.g.
    // top-level statements), auto-property access remains as property access so
    // the emitter generates callvirt get_/set_ — avoiding FieldAccessException.
    private let declaringType StructSymbol?

    private var labelCount int32

    // Issue #419 (P0-2): nesting depth of the try / catch / finally regions
    // currently being lowered. ECMA-335 forbids `ret` from inside a protected
    // region; the only legal exit is `leave`. When the depth is positive, any
    // BoundReturnStatement encountered is rewritten to store its value into a
    // synthetic temp local (if non-void) and `goto` a synthetic method-exit
    // label placed lexically OUTSIDE every protected region. The emitter
    // already translates a goto crossing a protected-region boundary into the
    // CIL `leave` opcode, so this rewrite is enough to keep the generated IL
    // verifiable.
    private var tryNestingDepth int32

    private var returnValueLocal LocalVariableSymbol?
    private var methodExitLabel BoundLabel?
    private var hasRewrittenReturnsInProtectedRegions bool

    private init(declaringType StructSymbol? = nil) {
        this.declaringType = declaringType
    }

    /// @remarks Issue #419 (P0-2): tracks try / catch / finally nesting depth so
    /// (cref:RewriteReturnStatement(BoundReturnStatement)) can detect a
    /// return that crosses a protected-region boundary and rewrite it into a
    /// store-to-temp + goto-exit pair. ECMA-335 forbids emitting `ret`
    /// from inside a protected region; the only legal exit is `leave`,
    /// which the emitter produces automatically for a goto whose target lies
    /// outside the innermost protected region.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
        this.tryNestingDepth++
        try {
            return base.RewriteTryStatement(node)
        } finally {
            this.tryNestingDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewritePatternSwitchStatement(node BoundPatternSwitchStatement) BoundStatement {
        let discriminant = RewriteExpression(node.Discriminant)
        if discriminant is not BoundLiteralExpression literal || node.Arms.Any(
            (arm BoundPatternSwitchArm) -> arm.Guard != nil
        ) ||
            node
            .Arms
            .Any(HasFallthroughEntryLabel) {
            // Issue #3501 A3: an arm carrying a fallthrough entry label is a
            // goto target from the PREVIOUS arm — the constant fast path
            // keeps only one arm's body, so the label (and the fallthrough
            // chain) would vanish. Keep the full switch shape.
            return base.RewritePatternSwitchStatement(node)
        }
        var defaultArm BoundPatternSwitchArm? = nil
        for arm in node.Arms {
            if arm.IsDefault {
                defaultArm = arm
                continue
            }
            if !(RewritePattern(arm.Pattern!!) is BoundConstantPattern{Value: BoundLiteralExpression patternLiteral}) {
                return base.RewritePatternSwitchStatement(node)
            }
            let matches = if literal.Type == TypeSymbol.Float32 {
                literal.Value is float32 leftF32 && patternLiteral.Value is float32 rightF32 && leftF32 == rightF32
            } else {
                (
                    if literal.Type == TypeSymbol.Float64 {
                        literal.Value is float64 leftF64 &&
                            patternLiteral.Value is float64 rightF64 &&
                            leftF64 == rightF64
                    } else {
                        object.Equals(literal.Value, patternLiteral.Value)
                    }
                )
            }
            if matches {
                return RewriteStatement(arm.Body)
            }
        }
        return if defaultArm == nil {
            cast[BoundStatement](BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty))
        } else {
            RewriteStatement(defaultArm.Body)
        }
    }

    /// @remarks Issue #419 (P0-2): rewrites `return` statements that appear
    /// lexically inside a try / catch / finally region. The original
    /// `BoundReturnStatement` is replaced with a store to a synthetic
    /// temp local (omitted when the return is value-less) followed by a goto
    /// to the synthesized method-exit label. The emitter's protected-region
    /// goto handling then translates the goto into the CIL `leave` the
    /// runtime requires. The matching label + final `return $tmp;`
    /// epilogue is appended by `WrapWithMethodExitEpilogue`.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
        let rewritten = cast[BoundReturnStatement](base.RewriteReturnStatement(node))
        if this.tryNestingDepth == 0 {
            return rewritten
        }
        this.hasRewrittenReturnsInProtectedRegions = true
        if this.methodExitLabel == nil {
            this.methodExitLabel = GenerateLabel()
        }
        let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
        if rewritten.Expression != nil {
            // First non-void return seen — bind the temp's type. Subsequent
            // value-returning rewrites reuse the same local; the binder has
            // already enforced a single return type for the enclosing
            // function, so all expressions are assignment-compatible with it.
            if this.returnValueLocal == nil {
                this.returnValueLocal = LocalVariableSymbol(
                    "$$returnTemp",
                    isReadOnly: false,
                    type: rewritten.Expression.Type
                )
            }
            let assignment = BoundAssignmentExpression(nil, this.returnValueLocal!!, rewritten.Expression!!)
            stmts.Add(BoundExpressionStatement(nil, assignment))
        }
        stmts.Add(BoundGotoStatement(nil, this.methodExitLabel!!))
        return BoundBlockStatement(nil, stmts.ToImmutable())
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteIfStatement(node BoundIfStatement) BoundStatement {
        if node.ElseStatement == nil {
            // if <condition>
            //      <then>
            //
            // ---->
            //
            // gotoFalse <condition> end
            // <then>
            // end:
            let endLabel = GenerateLabel()
            let gotoFalse = BoundConditionalGotoStatement(nil, endLabel, node.Condition, false)
            let endLabelStatement = BoundLabelStatement(nil, endLabel)
            let result = BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](gotoFalse, node.ThenStatement, endLabelStatement)
            )
            return RewriteStatement(result)
        } else {
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
            let elseLabel = GenerateLabel()
            let elseLabelStatement = BoundLabelStatement(nil, elseLabel)
            let gotoFalse = BoundConditionalGotoStatement(nil, elseLabel, node.Condition, false)
            let loweredThen = this.RewriteStatement(node.ThenStatement)
            let thenCanFallThrough = !EndsInUnconditionalTransfer(loweredThen)
            let builder = ImmutableArray.CreateBuilder[BoundStatement]()
            builder.Add(gotoFalse)
            builder.Add(loweredThen)
            if thenCanFallThrough {
                let endLabel = GenerateLabel()
                builder.Add(BoundGotoStatement(nil, endLabel))
                builder.Add(elseLabelStatement)
                builder.Add(node.ElseStatement!!)
                builder.Add(BoundLabelStatement(nil, endLabel))
            } else {
                builder.Add(elseLabelStatement)
                builder.Add(node.ElseStatement!!)
            }
            let result = BoundBlockStatement(nil, builder.ToImmutable())
            return RewriteStatement(result)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteForInfiniteStatement(node BoundForInfiniteStatement) BoundStatement {
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
        let continueLabelStatement = BoundLabelStatement(nil, node.ContinueLabel)
        let gotoContinue = BoundGotoStatement(nil, node.ContinueLabel)
        let breakLabelStatement = BoundLabelStatement(nil, node.BreakLabel)
        let result = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](continueLabelStatement, node.Body, gotoContinue, breakLabelStatement)
        )
        return RewriteStatement(result)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteForEllipsisStatement(node BoundForEllipsisStatement) BoundStatement {
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
        let isCaptured = CaptureBoxingRewriter.IsCaptured(node.Body, node.Variable)
        let controlVariable = if isCaptured {
            cast[VariableSymbol](LocalVariableSymbol("ellipsis", isReadOnly: false, type: TypeSymbol.Int32))
        } else {
            node.Variable
        }
        let variableDeclaration = BoundVariableDeclaration(nil, controlVariable, node.LowerBound)
        let upperBoundSymbol = LocalVariableSymbol("upperBound", isReadOnly: true, type: TypeSymbol.Int32)
        let upperBoundDeclaration = BoundVariableDeclaration(nil, upperBoundSymbol, node.UpperBound)
        let stepBoundSymbol = LocalVariableSymbol("step", isReadOnly: false, type: TypeSymbol.Int32)
        let stepBoundDeclaration = BoundVariableDeclaration(
            nil,
            variable: stepBoundSymbol,
            initializer: BoundLiteralExpression(nil, 1)
        )
        let variableExpression = BoundVariableExpression(nil, controlVariable)
        let upperBoundExpression = BoundVariableExpression(nil, upperBoundSymbol)
        let stepBoundExpression = BoundVariableExpression(nil, stepBoundSymbol)
        let ifLowerIsGreaterThanUpperExpression = BoundBinaryExpression(
            nil,
            left: variableExpression,
            op: Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 comparison operator exists for range lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32)"
            ),
            right: upperBoundExpression
        )
        let stepBoundAssingment = BoundExpressionStatement(
            nil,
            expression: BoundAssignmentExpression(
                nil,
                variable: stepBoundSymbol,
                expression: BoundLiteralExpression(nil, -1)
            )
        )
        let ifLowerIsGreaterThanUpperIfStatement = BoundIfStatement(
            nil,
            condition: ifLowerIsGreaterThanUpperExpression,
            thenStatement: stepBoundAssingment,
            elseStatement: nil
        )
        let startLabel = GenerateLabel()
        let gotoStart = BoundGotoStatement(nil, startLabel)
        let bodyLabel = GenerateLabel()
        let bodyLabelStatement = BoundLabelStatement(nil, bodyLabel)
        let continueLabelStatement = BoundLabelStatement(nil, node.ContinueLabel)
        let iterationVariableDeclaration BoundVariableDeclaration? = if isCaptured {
            BoundVariableDeclaration(nil, node.Variable, variableExpression)
        } else {
            default(BoundVariableDeclaration?)
        }
        let copyIterationVariableBack BoundExpressionStatement? = if isCaptured {
            BoundExpressionStatement(
                nil,
                BoundAssignmentExpression(nil, controlVariable, BoundVariableExpression(nil, node.Variable))
            )
        } else {
            default(BoundExpressionStatement?)
        }
        let increment = BoundExpressionStatement(
            nil,
            expression: BoundAssignmentExpression(
                nil,
                variable: controlVariable,
                expression: BoundBinaryExpression(
                    nil,
                    left: variableExpression,
                    op: Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        "int32 addition operator exists for range lowering",
                        expression: "BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                    ),
                    right: stepBoundExpression
                )
            )
        )
        let startLabelStatement = BoundLabelStatement(nil, startLabel)
        let zeroLiteralExpression = BoundLiteralExpression(nil, 0)
        let stepGreaterThanZeroExpression = BoundBinaryExpression(
            nil,
            left: stepBoundExpression,
            op: Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 comparison operator exists for range lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32)"
            ),
            right: zeroLiteralExpression
        )
        let lowerLessThanUpperExpression = BoundBinaryExpression(
            nil,
            left: variableExpression,
            op: Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 comparison operator exists for range lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32)"
            ),
            right: upperBoundExpression
        )
        let positiveStepAndLowerLessThanUpper = BoundBinaryExpression(
            nil,
            left: stepGreaterThanZeroExpression,
            op: Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
                "boolean conjunction operator exists for range lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool)"
            ),
            right: lowerLessThanUpperExpression
        )
        let stepLessThanZeroExpression = BoundBinaryExpression(
            nil,
            left: stepBoundExpression,
            op: Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 comparison operator exists for range lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32)"
            ),
            right: zeroLiteralExpression
        )
        let lowerGreaterThanUpperExpression = BoundBinaryExpression(
            nil,
            left: variableExpression,
            op: Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 comparison operator exists for range lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.GreaterToken, TypeSymbol.Int32, TypeSymbol.Int32)"
            ),
            right: upperBoundExpression
        )
        let negativeStepAndLowerGreaterThanUpper = BoundBinaryExpression(
            nil,
            left: stepLessThanZeroExpression,
            op: Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
                "boolean conjunction operator exists for range lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool)"
            ),
            right: lowerGreaterThanUpperExpression
        )
        let condition = BoundBinaryExpression(
            nil,
            positiveStepAndLowerLessThanUpper,
            Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool),
                "boolean disjunction operator exists for range lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool)"
            ),
            negativeStepAndLowerGreaterThanUpper
        )
        let gotoTrue = BoundConditionalGotoStatement(nil, bodyLabel, condition, jumpIfTrue: true)
        let breakLabelStatement = BoundLabelStatement(nil, node.BreakLabel)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(variableDeclaration)
        statements.Add(upperBoundDeclaration)
        statements.Add(stepBoundDeclaration)
        statements.Add(ifLowerIsGreaterThanUpperIfStatement)
        statements.Add(gotoStart)
        statements.Add(bodyLabelStatement)
        if iterationVariableDeclaration != nil {
            statements.Add(iterationVariableDeclaration)
        }
        statements.Add(node.Body)
        statements.Add(continueLabelStatement)
        if copyIterationVariableBack != nil {
            statements.Add(copyIterationVariableBack)
        }
        statements.Add(increment)
        statements.Add(startLabelStatement)
        statements.Add(gotoTrue)
        statements.Add(breakLabelStatement)
        let result = BoundBlockStatement(nil, statements.ToImmutable())
        return RewriteStatement(result)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteForRangeStatement(node BoundForRangeStatement) BoundStatement {
        // for [<k>,] <v> := range <coll>
        //     <body>
        //
        // ---->  (kind-dependent lowering — see helpers below)
        //
        // For arrays/slices (Indexed): index-based iteration using
        // BoundIndexExpression + BoundLenExpression.
        // For CLR dictionaries and enumerables: iterator-based iteration
        // using GetEnumerator()/MoveNext()/Current resolved by reflection.
        let lowered = switch node.IterationKind {
            case ForRangeKind.Indexed: LowerIndexedRange(node)
            case ForRangeKind.Dictionary: LowerCollectionRange(node, isDictionary: true)
            case ForRangeKind.Enumerable: LowerCollectionRange(node, isDictionary: false)
            case ForRangeKind.PatternEnumerator: LowerCollectionRange(node, isDictionary: false)
            default: throw InvalidOperationException("Unknown ForRangeKind ${node.IterationKind}")
        }
        return RewriteStatement(lowered)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteAwaitForRangeStatement(node BoundAwaitForRangeStatement) BoundStatement {
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
        let stream = RewriteExpression(node.Stream)
        let body = RewriteStatement(node.Body)
        let lowered = LowerAwaitForRange(node.ValueVariable, stream, body, node.BreakLabel, node.ContinueLabel)
        return RewriteStatement(lowered)
    }

    /// Issue #948: inline a `const` field read as its compile-time value so
    /// downstream value loads and value-type method-call receivers treat it
    /// uniformly. Matches C# const-read semantics.
    /// @param node The field-access node.
    /// @returns A literal for const fields; otherwise the base rewrite.
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteFieldAccessExpression(node BoundFieldAccessExpression) BoundExpression {
        if node.Field.IsConst {
            let literal = BoundLiteralExpression(node.Syntax, node.Field.ConstantValue, node.Field.Type)
            node.CopyStaticQualifierTo(literal)
            return literal
        }
        return base.RewriteFieldAccessExpression(node)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewritePropertyAccessExpression(node BoundPropertyAccessExpression) BoundExpression {
        // ADR-0051: auto-properties lower to backing field access, but ONLY when
        // we are inside the type that DIRECTLY declares the property. The backing
        // field is private (DeclarationBinder), so it is only legal to touch from
        // its exact declaring type. Issue #1486: an INHERITED auto-property read
        // from a derived method must instead dispatch through the accessor
        // (callvirt get_X) — node.StructType is the receiver's static type, not
        // the property's declaring type, so it cannot gate this on its own.
        if node
            .Property
            .IsAutoProperty &&
            node
            .Property
            .BackingField != nil &&
            this.declaringType != nil &&
            DeclaresPropertyDirectly(this.declaringType, node.Property) {
            return BoundFieldAccessExpression(
                node.Syntax,
                node.Receiver,
                node.StructType,
                node.Property.BackingField!!,
                node.SubstitutedType ?? node.Property.Type,
                node.NarrowedType
            )
        }
        // Computed properties (or external access) remain as BoundPropertyAccessExpression —
        // the interpreter evaluates the getter body and the emitter emits a call to get_X.
        return base.RewritePropertyAccessExpression(node)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewritePropertyAssignmentExpression(
        node BoundPropertyAssignmentExpression
    ) BoundExpression {
        // ADR-0051: auto-properties lower to backing field assignment, but ONLY
        // when we are inside the type that DIRECTLY declares the property (same
        // private-backing-field rationale as read access). Issue #1486: writing
        // an INHERITED auto-property from a derived method must dispatch through
        // the accessor (callvirt set_X) instead of touching the base's private
        // backing field.
        if node
            .Property
            .IsAutoProperty &&
            node
            .Property
            .BackingField != nil &&
            this.declaringType != nil &&
            DeclaresPropertyDirectly(this.declaringType, node.Property) {
            let value = RewriteExpression(node.Value)
            // Issue #263: static auto-property assignment — lower to static field assignment.
            if node.Receiver == nil {
                return BoundFieldAssignmentExpression(
                    nil,
                    receiver: nil,
                    Invariant.Required(
                        node.StructType,
                        "an auto-property assignment has a declaring type",
                        expression: "node.StructType"
                    ),
                    node.Property.BackingField!!,
                    value
                )
            }
            if node.Receiver is BoundVariableExpression varExpr {
                return BoundFieldAssignmentExpression(
                    nil,
                    varExpr.Variable,
                    Invariant.Required(
                        node.StructType,
                        "an auto-property assignment has a declaring type",
                        expression: "node.StructType"
                    ),
                    node.Property.BackingField!!,
                    value
                )
            }
        }
        // Computed properties (or non-variable receivers, or external access)
        // remain as BoundPropertyAssignmentExpression.
        return base.RewritePropertyAssignmentExpression(node)
    }

    private func LowerAwaitForRange(
        valueVariable VariableSymbol,
        stream BoundExpression,
        body BoundStatement,
        breakLabel BoundLabel,
        continueLabel BoundLabel
    ) BoundStatement {
        var streamClr Type? = stream.Type?.ClrType
        // Issue #4020: an `async sequence[T]` IS `IAsyncEnumerable[T]`
        // (ADR-0041), but its `ClrType` cannot be trusted to answer reflection
        // for it, in EITHER of the two ways
        // `AsyncSequenceTypeSymbol.MakeClrType` can fail. It is null when the
        // element has no CLR backing at all (an in-scope type parameter, a
        // same-compilation class), which left `await for v in s` over an OPEN
        // `async sequence[T]` parameter dead-ending while the closed
        // `async sequence[int32]` spelling iterated. And — the trap #4023
        // documents, and the reason this is NOT a `ClrType == null` test — it
        // is NON-null but useless when the element is merely IMPORTED
        // (`async sequence[DateTime]`, `async sequence[List[int32]]`,
        // `async sequence[ImportedBase]`): closing the host
        // `IAsyncEnumerable<>` over a MetadataLoadContext argument answers a
        // `TypeBuilderInstantiation` whose `GetMethod("GetAsyncEnumerator")`
        // throws `NotSupportedException`, which surfaced as GS9998.
        //
        // So every `AsyncSequenceTypeSymbol` takes the symbolic path, exactly
        // as every `SequenceTypeSymbol` already does in
        // `TryBuildSymbolicOpenGetEnumeratorCall` — whose own comment gives
        // this same reason, and which is why the SYNCHRONOUS
        // `for v in sequence[DateTime]` never had either half of this bug. The
        // type-ERASED `IAsyncEnumerable<object>` drives reflection while the
        // element stays symbolic, which is the #1002 shape the arms below
        // already handle.
        var asyncSequenceElement TypeSymbol? = nil
        if stream.Type is AsyncSequenceTypeSymbol asyncSequenceStream {
            asyncSequenceElement = asyncSequenceStream.ElementType
            streamClr = typeof(IAsyncEnumerable[object])
        }
        if streamClr == nil {
            return BoundExpressionStatement(nil, BoundErrorExpression(nil))
        }
        var asyncEnumerableInterface Type? = nil
        if streamClr.IsGenericType && !streamClr.IsGenericTypeDefinition && streamClr.GetGenericTypeDefinition()
            .FullName == "System.Collections.Generic.IAsyncEnumerable`1" {
            asyncEnumerableInterface = streamClr
        } else {
            for iface in streamClr.GetInterfaces() {
                if iface.IsGenericType && !iface.IsGenericTypeDefinition && iface.GetGenericTypeDefinition()
                    .FullName == "System.Collections.Generic.IAsyncEnumerable`1" {
                    asyncEnumerableInterface = iface
                    break
                }
            }
        }
        // Issue #652: resolve all helper types from the same MetadataLoadContext
        // as the stream type. Using typeof(...) here would yield host-runtime types
        // that cannot be mixed with MLC-loaded types in MakeGenericType/GetMethod
        // calls, causing ArgumentException ("Type must be a type provided by the
        // MetadataLoadContext").  Instead, derive everything from the interface and
        // method signatures that are already in the correct context.
        var getAsyncEnumerator MethodInfo?
        var moveNextAsync MethodInfo?
        var currentMember MemberInfo?
        if asyncEnumerableInterface != nil {
            // Fast path: GetAsyncEnumerator is the sole method on IAsyncEnumerable<T>.
            getAsyncEnumerator = asyncEnumerableInterface.GetMethod("GetAsyncEnumerator")
            if getAsyncEnumerator == nil {
                return BoundExpressionStatement(nil, BoundErrorExpression(nil))
            }
            let ifaceEnumeratorClr = getAsyncEnumerator.ReturnType
            moveNextAsync = ifaceEnumeratorClr.GetMethod("MoveNextAsync")
            currentMember = ifaceEnumeratorClr.GetProperty("Current")
        } else if !MemberLookup.TryResolveClrPatternAsyncEnumerator(
            streamClr,
            out getAsyncEnumerator,
            out moveNextAsync,
            out currentMember
        ) {
            // Issue #2280: neither the `IAsyncEnumerable[T]` interface nor
            // the duck-typed `await foreach` pattern (a public instance
            // `GetAsyncEnumerator(...)` whose enumerator exposes
            // `MoveNextAsync()`/`Current`) is present — e.g.
            // `System.Runtime.CompilerServices.ConfiguredCancelableAsyncEnumerable[T]`
            // (from `IAsyncEnumerable[T].ConfigureAwait(false)`) qualifies
            // via this fallback since it implements no interfaces at all.
            // The binder already validated one of the two shapes exists, so
            // this branch should not be reachable for well-typed programs.
            return BoundExpressionStatement(nil, BoundErrorExpression(nil))
        }
        if moveNextAsync == nil || currentMember == nil {
            return BoundExpressionStatement(nil, BoundErrorExpression(nil))
        }
        // Issue #2280: `DisposeAsync` may be reached through the
        // `IAsyncDisposable` interface (the common case for compiler-
        // generated iterators), or — for a fully duck-typed enumerator such
        // as `ConfiguredCancelableAsyncEnumerable[T].Enumerator`, which
        // implements no interfaces — as a plain public instance method found
        // directly on the enumerator type. Per the C# spec, when neither
        // shape is present the loop performs no disposal at all (rather than
        // failing to bind), so `disposeAsync` is allowed to stay null here.
        let enumeratorClr = getAsyncEnumerator.ReturnType
        var disposeAsync MethodInfo? = nil
        for iface in enumeratorClr.GetInterfaces() {
            if iface.FullName == "System.IAsyncDisposable" {
                disposeAsync = iface.GetMethod("DisposeAsync")
                break
            }
        }
        if disposeAsync == nil {
            disposeAsync = enumeratorClr.GetMethod(
                "DisposeAsync",
                BindingFlags.Instance | BindingFlags.Public,
                binder: nil,
                types: Type.EmptyTypes,
                modifiers: nil
            )
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
        let valueTaskBoolClr = moveNextAsync.ReturnType
        let valueTaskBoolType = ClrNullability.GetReturnTypeSymbol(moveNextAsync).StripToBareShape()
        // GetAsyncEnumerator's arity: either the interface's single optional
        // `CancellationToken` parameter, or the fully duck-typed parameterless
        // overload (e.g. `ConfiguredCancelableAsyncEnumerable[T].GetAsyncEnumerator()`).
        let getAsyncEnumeratorParams = getAsyncEnumerator.GetParameters()
        var getEnumeratorArgs ImmutableArray[BoundExpression]
        if getAsyncEnumeratorParams.Length == 0 {
            getEnumeratorArgs = ImmutableArray[BoundExpression].Empty
        } else {
            let paramType = ClrNullability.GetParameterTypeSymbol(getAsyncEnumeratorParams[0]).StripToBareShape()
            getEnumeratorArgs = ImmutableArray.Create[BoundExpression](BoundDefaultExpression(nil, paramType))
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
        var enumeratorType TypeSymbol
        var currentType TypeSymbol
        if asyncSequenceElement != nil {
            // Issue #4020: the `async sequence[T]` case set up above.
            // `enumeratorClr` is the erased `IAsyncEnumerator<object>`; carry
            // the real element alongside it so `Current` types the loop
            // variable as the element rather than `object`.
            enumeratorType = ImportedTypeSymbol.GetConstructed(
                enumeratorClr,
                typeof(System.Collections.Generic.IAsyncEnumerator[_]),
                ImmutableArray.Create(asyncSequenceElement)
            )
            currentType = asyncSequenceElement
        } else if stream.Type is ImportedTypeSymbol streamImp &&
            streamImp.HasSubstitutableTypeArgument &&
            streamImp.OpenDefinition != nil &&
            streamImp
            .OpenDefinition
            .FullName == "System.Collections.Generic.IAsyncEnumerable`1" &&
            streamImp
            .TypeArguments
            .Length == 1 {
            let elementSym = streamImp.TypeArguments[0]
            enumeratorType = ImportedTypeSymbol.GetConstructed(
                enumeratorClr,
                typeof(System.Collections.Generic.IAsyncEnumerator[_]),
                ImmutableArray.Create[TypeSymbol](elementSym)
            )
            currentType = elementSym
        } else if stream.Type is ImportedTypeSymbol patternImp &&
            patternImp.OpenDefinition != nil &&
            !patternImp
            .TypeArguments
            .IsDefaultOrEmpty &&
            MemberLookup
            .TryResolveClrPatternAsyncEnumerator(
            patternImp.OpenDefinition,
            out var openGetAsyncEnumerator,
            out _,
            out var openCurrentMember
        ) {
            // ADR-0193 Phase 2: the lowered locals take the bare enumerator
            // shape; the Current read takes the merged element the binder
            // gave the loop variable (MemberLookup.TryGetAsyncEnumerableElementType).
            enumeratorType = MemberLookup.GetClrOpenMethodReturnTypeSymbol(
                openGetAsyncEnumerator!!,
                patternImp.OpenDefinition,
                patternImp.TypeArguments
            )
                .StripToBareShape()
            currentType = if (openCurrentMember is PropertyInfo or FieldInfo) {
                MemberLookup.GetClrMemberValueTypeSymbol(
                    openCurrentMember!!,
                    patternImp.OpenDefinition,
                    patternImp.TypeArguments
                )
            } else {
                valueVariable.Type
            }
        } else {
            enumeratorType = ClrNullability.GetReturnTypeSymbol(getAsyncEnumerator).StripToBareShape()
            currentType = GetClrMemberType(currentMember)
        }
        let enumeratorSymbol = LocalVariableSymbol("$$awaitEnum", isReadOnly: true, type: enumeratorType)
        let enumeratorExpr = BoundVariableExpression(nil, enumeratorSymbol)
        let getEnumCall = BoundImportedInstanceCallExpression(
            nil,
            stream,
            getAsyncEnumerator,
            enumeratorType,
            getEnumeratorArgs
        )
        let enumeratorDecl = BoundVariableDeclaration(nil, enumeratorSymbol, getEnumCall)
        // Issue #937: the loop's continue label sits at the MoveNextAsync
        // step (so `continue` advances to the next element) and the break
        // label sits at the loop exit, still inside the try so the finally's
        // DisposeAsync await runs when `break` leaves the loop.
        let startLabel = continueLabel
        let endLabel = breakLabel
        let moreSymbol = LocalVariableSymbol("$$more", isReadOnly: false, type: TypeSymbol.Bool)
        let moveNextCall = BoundImportedInstanceCallExpression(
            nil,
            enumeratorExpr,
            moveNextAsync,
            valueTaskBoolType,
            ImmutableArray[BoundExpression].Empty
        )
        let moveNextAwait = BoundAwaitExpression(nil, moveNextCall, TypeSymbol.Bool)
        let moreDecl = BoundVariableDeclaration(nil, moreSymbol, moveNextAwait)
        let currentAccess = BoundClrPropertyAccessExpression(nil, enumeratorExpr, currentMember, currentType)
        // The iteration binding is a fresh lexical local on every pass.
        let assignValue = BoundVariableDeclaration(nil, valueVariable, currentAccess)
        let tryStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        tryStatements.Add(BoundLabelStatement(nil, startLabel))
        tryStatements.Add(moreDecl)
        tryStatements.Add(
            BoundConditionalGotoStatement(nil, endLabel, BoundVariableExpression(nil, moreSymbol), jumpIfTrue: false)
        )
        tryStatements.Add(assignValue)
        tryStatements.Add(body)
        tryStatements.Add(BoundGotoStatement(nil, startLabel))
        tryStatements.Add(BoundLabelStatement(nil, endLabel))
        let tryBlock = BoundBlockStatement(nil, tryStatements.ToImmutable())
        if disposeAsync == nil {
            // Issue #2280: no `IAsyncDisposable`/pattern `DisposeAsync()` at
            // all — per the C# spec the loop performs no disposal (matches
            // `await foreach`'s own behavior for such enumerators).
            return BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](enumeratorDecl, tryBlock))
        }
        let valueTaskClr = disposeAsync.ReturnType
        let valueTaskType = ClrNullability.GetReturnTypeSymbol(disposeAsync).StripToBareShape()
        let disposeCall = BoundImportedInstanceCallExpression(
            nil,
            enumeratorExpr,
            disposeAsync,
            valueTaskType,
            ImmutableArray[BoundExpression].Empty
        )
        let disposeAwait = BoundAwaitExpression(nil, disposeCall, TypeSymbol.Void)
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, disposeAwait))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock)
        return BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](enumeratorDecl, tryStmt))
    }

    private func LowerIndexedRange(node BoundForRangeStatement) BoundStatement {
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
        let collectionSymbol = LocalVariableSymbol("$$coll", isReadOnly: true, type: node.Collection.Type)
        let collectionDecl = BoundVariableDeclaration(nil, collectionSymbol, node.Collection)
        let collectionExpr = BoundVariableExpression(nil, collectionSymbol)
        let indexSymbol = LocalVariableSymbol("$$i", isReadOnly: false, type: TypeSymbol.Int32)
        let indexDecl = BoundVariableDeclaration(nil, indexSymbol, BoundLiteralExpression(nil, 0))
        let indexExpr = BoundVariableExpression(nil, indexSymbol)
        let startLabel = GenerateLabel()
        let bodyLabel = GenerateLabel()
        let perIterationStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        if node.KeyVariable != nil {
            perIterationStatements.Add(BoundVariableDeclaration(nil, node.KeyVariable, indexExpr))
        }
        perIterationStatements.Add(
            BoundVariableDeclaration(
                nil,
                node.ValueVariable,
                BoundIndexExpression(nil, collectionExpr, indexExpr, node.ValueVariable.Type)
            )
        )
        perIterationStatements.Add(node.Body)
        let increment = BoundExpressionStatement(
            nil,
            BoundAssignmentExpression(
                nil,
                indexSymbol,
                BoundBinaryExpression(
                    nil,
                    indexExpr,
                    Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        "int32 addition operator exists for collection lowering",
                        expression: "BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                    ),
                    BoundLiteralExpression(nil, 1)
                )
            )
        )
        let hasMore = BoundBinaryExpression(
            nil,
            indexExpr,
            Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 comparison operator exists for collection lowering",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.LessToken, TypeSymbol.Int32, TypeSymbol.Int32)"
            ),
            BoundLenExpression(nil, collectionExpr)
        )
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(collectionDecl)
        statements.Add(indexDecl)
        statements.Add(BoundGotoStatement(nil, startLabel))
        statements.Add(BoundLabelStatement(nil, bodyLabel))
        statements.AddRange(perIterationStatements)
        statements.Add(BoundLabelStatement(nil, node.ContinueLabel))
        statements.Add(increment)
        statements.Add(BoundLabelStatement(nil, startLabel))
        statements.Add(BoundConditionalGotoStatement(nil, bodyLabel, hasMore, jumpIfTrue: true))
        statements.Add(BoundLabelStatement(nil, node.BreakLabel))
        return BoundBlockStatement(nil, statements.ToImmutable())
    }

    private func LowerCollectionRange(node BoundForRangeStatement, isDictionary bool) BoundStatement {
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
        if !TryBuildGetEnumeratorCall(node.Collection, out var getEnumCall, out var enumeratorType) {
            // Defensive: bail out unchanged if we can't resolve. The
            // binder already validated this case, so this shouldn't fire.
            return BoundExpressionStatement(node.Syntax, BoundErrorExpression(node.Syntax))
        }
        if !TryBuildMoveNextAndCurrent(enumeratorType, out var moveNextCallFactory, out var currentAccessFactory) {
            return BoundExpressionStatement(node.Syntax, BoundErrorExpression(node.Syntax))
        }
        let enumeratorSymbol = LocalVariableSymbol("$$enum", isReadOnly: true, type: enumeratorType)
        let enumeratorDecl = BoundVariableDeclaration(node.Syntax, enumeratorSymbol, getEnumCall)
        let enumeratorExpr = BoundVariableExpression(node.Syntax, enumeratorSymbol)
        let startLabel = GenerateLabel()
        let bodyLabel = GenerateLabel()
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(enumeratorDecl)
        var indexSymbol LocalVariableSymbol? = nil
        if !isDictionary && node.KeyVariable != nil {
            indexSymbol = LocalVariableSymbol("$$i", isReadOnly: false, type: TypeSymbol.Int32)
            statements.Add(BoundVariableDeclaration(node.Syntax, indexSymbol, BoundLiteralExpression(node.Syntax, 0)))
        }
        statements.Add(BoundGotoStatement(node.Syntax, startLabel))
        statements.Add(BoundLabelStatement(node.Syntax, bodyLabel))
        let currentAccess = currentAccessFactory(enumeratorExpr)
        if isDictionary {
            // Issue #1328: a single-identifier dictionary iteration
            // (`for kv in dict`) binds the whole `KeyValuePair[K, V]` element —
            // there is no key variable, so assign `Current` (the pair) directly
            // to the loop variable. The two-var form (`for k, v in dict`)
            // continues to destructure into `Current.Key` / `Current.Value`.
            if node.KeyVariable == nil {
                statements.Add(
                    BoundVariableDeclaration(
                        node.Syntax,
                        node.ValueVariable,
                        ConvertEnumeratorCurrent(currentAccess, node.ValueVariable.Type)
                    )
                )
            } else {
                // Issue #774: when `currentAccess.Type` is a symbolic open
                // KeyValuePair[K, V] (because the receiver was an open
                // `Dictionary[K, V]`), the closed CLR `Key`/`Value` properties
                // both report `object`. Honour the symbolic arguments so the
                // synthesised key/value declarations carry the user's `K`/`V`.
                let kvpType = currentAccess.Type
                let kvpClr = Invariant.Required(
                    kvpType.ClrType,
                    "a KeyValuePair has a CLR representation",
                    expression: "kvpType.ClrType"
                )
                let keyProp = Invariant.Required(
                    kvpClr.GetProperty("Key"),
                    "KeyValuePair<K, V> declares a public Key property",
                    expression: "kvpClr.GetProperty(\"Key\")"
                )
                let valueProp = Invariant.Required(
                    kvpClr.GetProperty("Value"),
                    "KeyValuePair<K, V> declares a public Value property",
                    expression: "kvpClr.GetProperty(\"Value\")"
                )
                var keyAccessType = ClrNullability.GetPropertyTypeSymbol(keyProp)
                var valueAccessType = ClrNullability.GetPropertyTypeSymbol(valueProp)
                if kvpType is ImportedTypeSymbol kvpImp &&
                    kvpImp.HasSubstitutableTypeArgument &&
                    kvpImp
                    .TypeArguments
                    .Length == 2 {
                    keyAccessType = kvpImp.TypeArguments[0]
                    valueAccessType = kvpImp.TypeArguments[1]
                }
                let kvpSymbol = LocalVariableSymbol("$$kvp", isReadOnly: true, type: kvpType)
                statements.Add(BoundVariableDeclaration(node.Syntax, kvpSymbol, currentAccess))
                let kvpExpr = BoundVariableExpression(node.Syntax, kvpSymbol)
                statements.Add(
                    BoundVariableDeclaration(
                        node.Syntax,
                        node.KeyVariable!!,
                        BoundClrPropertyAccessExpression(node.Syntax, kvpExpr, keyProp, keyAccessType)
                    )
                )
                statements.Add(
                    BoundVariableDeclaration(
                        node.Syntax,
                        node.ValueVariable,
                        BoundClrPropertyAccessExpression(node.Syntax, kvpExpr, valueProp, valueAccessType)
                    )
                )
            }
        } else {
            if node.KeyVariable != nil && indexSymbol != nil {
                statements.Add(
                    BoundVariableDeclaration(
                        node.Syntax,
                        node.KeyVariable,
                        BoundVariableExpression(node.Syntax, indexSymbol)
                    )
                )
            }
            statements.Add(
                BoundVariableDeclaration(
                    node.Syntax,
                    node.ValueVariable,
                    ConvertEnumeratorCurrent(currentAccess, node.ValueVariable.Type)
                )
            )
        }
        statements.Add(node.Body)
        statements.Add(BoundLabelStatement(node.Syntax, node.ContinueLabel))
        if indexSymbol != nil {
            let indexExpr = BoundVariableExpression(node.Syntax, indexSymbol)
            statements.Add(
                BoundExpressionStatement(
                    node.Syntax,
                    BoundAssignmentExpression(
                        node.Syntax,
                        indexSymbol,
                        BoundBinaryExpression(
                            node.Syntax,
                            indexExpr,
                            Invariant.Required(
                                BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32),
                                "int32 addition operator exists for enumerator lowering",
                                expression: "BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                            ),
                            BoundLiteralExpression(node.Syntax, 1)
                        )
                    )
                )
            )
        }
        statements.Add(BoundLabelStatement(node.Syntax, startLabel))
        statements.Add(
            BoundConditionalGotoStatement(node.Syntax, bodyLabel, moveNextCallFactory(enumeratorExpr), jumpIfTrue: true)
        )
        statements.Add(BoundLabelStatement(node.Syntax, node.BreakLabel))
        // Wrap the iteration in try-finally so the enumerator is disposed
        // on early break, return, or exception — matching C# foreach. We
        // only emit the disposer when the enumerator implements IDisposable
        // (e.g. all synthesized iterator state machines do). The enumerator
        // variable declaration is moved into an outer scope so its handle
        // is still in scope in the finally.
        //
        // The state-machine planners must see this region before allocating
        // suspension states. Their resume dispatch and finally guards keep
        // the enumerator alive across yield/await and dispose it on exit.
        let disposeCall BoundExpression? = TryBuildEnumeratorDisposeCall(enumeratorSymbol)
        if disposeCall != nil {
            // Outer block:
            //   var $enum = coll.GetEnumerator();
            //   try { ... loop body ... } finally { $enum.Dispose(); }
            let loopStatements = statements.ToImmutable()
            // Drop the enumeratorDecl from the loop body — it lives outside the try.
            // (It was added at index 0.)
            let withoutEnumDecl = ImmutableArray.CreateRange(Enumerable.Skip(loopStatements, 1))
            let tryBlock = BoundBlockStatement(node.Syntax, withoutEnumDecl)
            let finallyBlock = BoundBlockStatement(
                node.Syntax,
                ImmutableArray.Create[BoundStatement](BoundExpressionStatement(node.Syntax, disposeCall))
            )
            let tryFinally = BoundTryStatement(
                node.Syntax,
                tryBlock,
                ImmutableArray[BoundCatchClause].Empty,
                finallyBlock
            )
            return BoundBlockStatement(node.Syntax, ImmutableArray.Create[BoundStatement](enumeratorDecl, tryFinally))
        }
        return BoundBlockStatement(node.Syntax, statements.ToImmutable())
    }

    private func RewriteProtectedRegionEntries(statement BoundStatement) BoundBlockStatement {
        var flattened = Flatten(statement)
        let preEmitAnalysisBody = Flatten(ProtectedRegionBranchRewriter.Rewrite(flattened))
        if this.returnValueLocal != nil {
            let exceptionType = typeof(InvalidOperationException)
            let constructor = Invariant.Required(
                exceptionType.GetConstructor([]Type{typeof(string)}),
                "System.InvalidOperationException declares the single-string-argument constructor",
                expression: "exceptionType.GetConstructor(new[] { typeof(string) })"
            )
            let statements = ImmutableArray.CreateBuilder[BoundStatement](flattened.Statements.Length + 1)
            for current in flattened.Statements {
                if current is BoundLabelStatement label && object.ReferenceEquals(label.Label, this.methodExitLabel) {
                    statements.Add(
                        BoundThrowStatement(
                            nil,
                            BoundClrConstructorCallExpression(
                                nil,
                                exceptionType,
                                constructor,
                                ImmutableArray.Create[BoundExpression](
                                    BoundLiteralExpression(nil, DiagnosticDescriptors.NonVoidFallthroughGuardMessage)
                                ),
                                TypeSymbol.FromClrTypeWithoutNullability(
                                    exceptionType,
                                    NullabilityFreeReason.TypeLiteral
                                )
                            ),
                            DiagnosticDescriptors.AllPathsMustReturn
                        )
                    )
                }
                statements.Add(current)
            }
            flattened = BoundBlockStatement(flattened.Syntax, statements.ToImmutable())
        }
        flattened = FinallyExitRewriter.Rewrite(flattened)
        let emittedBody = Flatten(ProtectedRegionBranchRewriter.Rewrite(flattened))
        return BoundBlockStatement(emittedBody.Syntax, emittedBody.Statements, preEmitAnalysisBody)
    }

    private func GenerateLabel() BoundLabel {
        let name = "Label${(labelCount += 1)}"
        return BoundLabel(name)
    }

    /// Issue #419 (P0-2): when at least one return was rewritten as a goto by
    /// (cref:RewriteReturnStatement(BoundReturnStatement)), append the
    /// synthetic method-exit label and a terminating `return` that
    /// reloads the temp (or has no expression for void-returning functions).
    /// The temp is declared at the very top of the method so the emitter's
    /// locals collector allocates a slot for it; the `default(T)`
    /// initializer makes the slot definitely-assigned and avoids verifier
    /// complaints on unreachable fall-through paths.
    private func WrapWithMethodExitEpilogue(body BoundStatement) BoundStatement {
        if !this.hasRewrittenReturnsInProtectedRegions {
            return body
        }
        let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
        if this.returnValueLocal != nil {
            stmts.Add(
                BoundVariableDeclaration(
                    nil,
                    this.returnValueLocal!!,
                    BoundDefaultExpression(nil, this.returnValueLocal!!.Type)
                )
            )
        }
        stmts.Add(body)
        stmts.Add(
            BoundLabelStatement(
                nil,
                Invariant.Required(
                    this.methodExitLabel,
                    "hasRewrittenReturnsInProtectedRegions is set only by RewriteReturnStatement, which creates the exit label in the same block",
                    expression: "this.methodExitLabel"
                )
            )
        )
        let retExpr BoundExpression? = if this.returnValueLocal == nil {
            default(BoundVariableExpression?)
        } else {
            BoundVariableExpression(nil, this.returnValueLocal!!)
        }
        stmts.Add(BoundReturnStatement(nil, retExpr))
        return BoundBlockStatement(nil, stmts.ToImmutable())
    }

    shared {
        /// Produces a lowered version of the supplied bound statement.
        /// @param statement The bound statement.
        /// @returns A lowered version of the bound statement.
        func Lower(statement BoundStatement) BoundBlockStatement {
            let lowerer = Lowerer()
            var result = lowerer.RewriteStatement(statement)
            result = lowerer.WrapWithMethodExitEpilogue(result)
            let protectedResult = lowerer.RewriteProtectedRegionEntries(result)
            return SpillSequenceSpiller.RewriteControlFlowBlocks(protectedResult)
        }

        /// Produces a lowered version of the supplied bound statement within the
        /// context of a declaring type. Auto-property access on the declaring type
        /// is lowered to direct backing-field access; access from outside the type
        /// is left as property access (emitted as callvirt get_/set_).
        /// @param statement The bound statement.
        /// @param declaringType The type whose member body is being lowered.
        /// @returns A lowered version of the bound statement.
        func Lower(statement BoundStatement, declaringType StructSymbol) BoundBlockStatement {
            let lowerer = Lowerer(declaringType)
            var result = lowerer.RewriteStatement(statement)
            result = lowerer.WrapWithMethodExitEpilogue(result)
            let protectedResult = lowerer.RewriteProtectedRegionEntries(result)
            return SpillSequenceSpiller.RewriteControlFlowBlocks(protectedResult)
        }

        /// Issue #1486: determines whether [`type`](paramref) DIRECTLY declares
        /// [`prop`](paramref) (an own, non-inherited property), so the private
        /// backing field is legally accessible. (cref:StructSymbol.Properties)
        /// lists only own properties. On a constructed generic instance the property
        /// is a substituted clone, but (cref:PropertySymbol.BackingField) is
        /// carried by reference from the definition, so it gives a stable identity to
        /// match against the type's own properties for any base/derived depth and for
        /// both generic and non-generic types.
        private func DeclaresPropertyDirectly(type StructSymbol?, prop PropertySymbol?) bool {
            if type == nil || prop == nil {
                return false
            }
            for own in type.Properties {
                if object.ReferenceEquals(own, prop) {
                    return true
                }
                if prop.BackingField != nil && object.ReferenceEquals(own.BackingField, prop.BackingField) {
                    return true
                }
            }
            return false
        }

        private func ConvertEnumeratorCurrent(current BoundExpression, elementType TypeSymbol) BoundExpression {
            return if current.Type == TypeSymbol.Object || current.Type?.ClrType.IsSameAs(typeof(object)) == true {
                cast[BoundExpression](BoundConversionExpression(current.Syntax, elementType, current))
            } else {
                current
            }
        }

        private func TryBuildEnumeratorDisposeCall(enumeratorSymbol LocalVariableSymbol) BoundExpression? {
            let clrType Type? = enumeratorSymbol.Type?.ClrType
            if clrType == nil {
                return nil
            }
            var disposeMethod MethodInfo? = nil
            // Pattern-based dispose for struct enumerators: prefer the type's
            // own public parameterless Dispose() so we get a direct `call` on
            // a managed pointer to the struct (no boxing). This matches how
            // Roslyn lowers `foreach` over List<T>/Dictionary<K,V> etc., and
            // is important because the IDisposable-typed call would box the
            // enumerator on every iteration of an enclosing loop nest.
            if clrType.IsValueType {
                let ownDispose MethodInfo? = clrType.GetMethod(
                    "Dispose",
                    BindingFlags.Instance | BindingFlags.Public,
                    binder: nil,
                    types: Type.EmptyTypes,
                    modifiers: nil
                )
                if ownDispose != nil && ownDispose.ReturnType.IsSameAs(typeof(Void)) {
                    disposeMethod = ownDispose
                }
            }
            // Fall back to the IDisposable interface dispatch when the
            // enumerator is a reference type, or when it is a value type that
            // implements IDisposable only via explicit interface. (The latter
            // boxes — but pattern-based dispose simply isn't available for
            // those.)
            if disposeMethod == nil {
                // Issue #3501: a byref-like enumerator (Span<T>.Enumerator) can
                // report IDisposable on modern runtimes (ref structs implement
                // interfaces since .NET 9), but the interface dispatch below
                // boxes — invalid IL for a byref-like type. Roslyn likewise
                // emits no disposal for the span pattern enumerator.
                if ClrTypeUtilities.IsByRefLike(clrType) {
                    return nil
                }
                // Issue #3708: `typeof(IDisposable).IsAssignableFrom(clrType)` is
                // unconditionally false when `clrType` comes from a
                // MetadataLoadContext — i.e. for every imported enumerator in a
                // `/reference:`-based compile — so this guard used to suppress the
                // `finally` for `File.ReadLines(...)`, `Directory.EnumerateFiles(...)`,
                // `xs.Where(...)` and friends, leaking the handle. Resolve
                // `IDisposable` (and its `Dispose`) out of the receiver's own
                // reflection context instead, matching the MLC-safe sibling arm above.
                let disposableInterface Type? = FindDisposableInterface(clrType)
                if disposableInterface == nil {
                    return nil
                }
                disposeMethod = disposableInterface.GetMethodSafe("Dispose", Type.EmptyTypes)
            }
            if disposeMethod == nil {
                return nil
            }
            let receiver = BoundVariableExpression(nil, enumeratorSymbol)
            return BoundImportedInstanceCallExpression(
                nil,
                receiver,
                disposeMethod,
                TypeSymbol.Void,
                ImmutableArray[BoundExpression].Empty
            )
        }

        /// Issue #3708: returns the `System.IDisposable` interface as seen from
        /// [`clrType`](paramref)'s own reflection context, or `null`
        /// when the type does not implement it. Walking the receiver's transitive
        /// interface set by name is safe across the live-runtime /
        /// (cref:System.Reflection.MetadataLoadContext) boundary, where
        /// `typeof(IDisposable).IsAssignableFrom(...)` always answers
        /// `false`, and it yields the interface handle that the
        /// `Dispose` lookup must be rooted in so the emitted member reference
        /// resolves in the same context as the receiver.
        /// @param clrType The enumerator's CLR type (live or MLC).
        /// @returns The context-matched `System.IDisposable`, or `null`.
        private func FindDisposableInterface(clrType Type) Type? {
            if clrType.IsInterface && clrType.FullName == "System.IDisposable" {
                return clrType
            }
            for iface in ClrTypeUtilities.SafeGetInterfaces(clrType) {
                if iface.FullName == "System.IDisposable" {
                    return iface
                }
            }
            return nil
        }

        private func TryBuildGetEnumeratorCall(
            collection BoundExpression,
            @NotNullWhen(true) out getEnumeratorCall BoundExpression?,
            @NotNullWhen(true) out enumeratorType TypeSymbol?
        ) bool {
            // Issue #774: when the receiver is an open generic shape carrying an
            // in-scope type parameter (e.g. `IEnumerable[T]`, `sequence[T]`,
            // `Dictionary[K, V]`), the closed CLR shape is erased to `object` and
            // its native `GetEnumerator()` would yield `IEnumerator<object>` /
            // a struct enumerator typed against `object`. That collapses the loop
            // variable to `object` and forces a verifier-broken `unbox.any` on
            // every `Current` read. Synthesize a symbolic
            // `IEnumerator[ElementSym]` enumerator instead so the rest of the
            // loop lowers with the user's `T` (or `KeyValuePair[K, V]`) intact.
            if TryBuildSymbolicOpenGetEnumeratorCall(collection, out getEnumeratorCall, out enumeratorType) {
                return true
            }
            if collection.Type is RectangularArrayTypeSymbol {
                let getEnumerator MethodInfo? = typeof(Array).GetMethod(
                    "GetEnumerator",
                    BindingFlags.Instance | BindingFlags.Public,
                    binder: nil,
                    types: Type.EmptyTypes,
                    modifiers: nil
                )
                if getEnumerator != nil {
                    enumeratorType = ClrNullability.GetReturnTypeSymbol(getEnumerator).StripToBareShape()
                    getEnumeratorCall = BoundImportedInstanceCallExpression(
                        nil,
                        collection,
                        getEnumerator,
                        enumeratorType!!,
                        ImmutableArray[BoundExpression].Empty
                    )
                    return true
                }
            }
            let clrType Type? = collection.Type.ClrType
            if clrType != nil {
                let getEnumerator MethodInfo? = MemberLookup.ResolveGetEnumerator(clrType, out _)
                if getEnumerator != nil {
                    enumeratorType = MemberLookup.GetClrMethodReturnTypeSymbol(collection.Type, getEnumerator)
                        .StripToBareShape()
                    getEnumeratorCall = BoundImportedInstanceCallExpression(
                        nil,
                        collection,
                        getEnumerator,
                        enumeratorType!!,
                        ImmutableArray[BoundExpression].Empty
                    )
                    return true
                }
            }
            if collection.Type is StructSymbol userType && userType.TryGetMethodIncludingInherited(
                "GetEnumerator",
                out var userGetEnumerator
            ) &&
                userGetEnumerator!!
                .Parameters
                .Length == 0 {
                enumeratorType = userType.SubstituteMemberType(userGetEnumerator!!.Type)
                getEnumeratorCall = BoundUserInstanceCallExpression(
                    nil,
                    collection,
                    userGetEnumerator!!,
                    ImmutableArray[BoundExpression].Empty
                )
                // ADR-0186 §9: a GetEnumerator declared in an oblivious scope
                // returns a platform enumerator (`NumberEnumerator!`). The binder
                // (MemberLookup.TryGetUserPatternEnumerableElementType) reads its
                // shape through the wrapper, and so must the MoveNext/Current probe
                // below, which recognises only a bare StructSymbol. An oblivious
                // GetEnumerator may legally return nil, and the loop dereferences
                // the enumerator at once, so this is an ADR-0186 §4 coercion:
                // checked and unwrapped in one step.
                if enumeratorType is PlatformTypeSymbol platformEnumerator {
                    enumeratorType = platformEnumerator.UnderlyingType
                    getEnumeratorCall = PlatformCoercion.InsertCheck(
                        getEnumeratorCall!!,
                        collection.Syntax?.Location,
                        "a pattern enumerator returned by GetEnumerator"
                    )
                }
                return true
            }
            getEnumeratorCall = nil
            enumeratorType = nil
            return false
        }

        /// Issue #774: builds a `GetEnumerator()` call against a symbolic
        /// open-generic receiver (a (cref:SequenceTypeSymbol) /
        /// (cref:AsyncSequenceTypeSymbol) with a null `ClrType`, or an
        /// (cref:ImportedTypeSymbol) with
        /// (cref:ImportedTypeSymbol.HasTypeParameterArgument)). Produces a
        /// symbolic `IEnumerator[ElementSym]` typed
        /// (cref:ImportedTypeSymbol) so the rest of the loop lowering
        /// (Current access, key/value extraction) carries the user's symbolic
        /// argument instead of the erased `object` shape.
        private func TryBuildSymbolicOpenGetEnumeratorCall(
            collection BoundExpression,
            @NotNullWhen(true) out getEnumeratorCall BoundExpression?,
            @NotNullWhen(true) out enumeratorType TypeSymbol?
        ) bool {
            getEnumeratorCall = nil
            enumeratorType = nil
            let collectionType = collection.Type
            var openDef Type?
            var typeArguments ImmutableArray[TypeSymbol]
            switch collectionType {
                case seq is SequenceTypeSymbol {
                    openDef = typeof(System.Collections.Generic.IEnumerable[_])
                    typeArguments = ImmutableArray.Create[TypeSymbol](seq.ElementType)
                }
                case imp is ImportedTypeSymbol when imp.HasSubstitutableTypeArgument && imp.OpenDefinition != nil {
                    openDef = imp.OpenDefinition
                    typeArguments = imp.TypeArguments
                }
                case openMap is MapTypeSymbol when openMap.ClrType == nil &&
                    MemberLookup
                    .TryGetSymbolicOpenMapReceiverView(openMap, out var mapView) {
                    openDef = mapView!!.OpenDefinition
                    typeArguments = mapView!!.TypeArguments
                }
                default {
                    return false
                }
            }
            if openDef == nil {
                return false
            }
            // Issue #4907: a collection whose public `GetEnumerator()` returns a
            // nested struct enumerator over the same element type iterates through
            // that struct, as C# does. The interface route below boxes the
            // enumerator on every loop.
            if collectionType is ImportedTypeSymbol structEnumeratorReceiver &&
                TryBuildSymbolicStructGetEnumeratorCall(
                collection,
                structEnumeratorReceiver,
                openDef,
                typeArguments,
                out getEnumeratorCall,
                out enumeratorType
            ) {
                return true
            }
            // Determine the IEnumerable<X> element CLR type from the open
            // definition. Collections outside the struct-enumerator list route
            // through the IEnumerable<T> interface call, which allocates the
            // enumerator.
            var openElementClr Type?
            if openDef.FullName == "System.Collections.Generic.IEnumerable`1" {
                openElementClr = openDef.GetGenericArguments()[0]
            } else if !MemberLookup.TryGetClrEnumerableElementType(openDef, out openElementClr) {
                return false
            }
            let elementSym = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                Invariant.Required(
                    openElementClr,
                    "an enumerable type has an element type",
                    expression: "openElementClr"
                ),
                openDef,
                typeArguments,
                NullabilityFreeReason.TypeStructure
            )
            if elementSym == TypeSymbol.Error {
                return false
            }
            // Resolve GetEnumerator() on the closed `IEnumerable<object>` shape;
            // the symbolic MemberRef helper on the emit side re-encodes the
            // parent TypeSpec against the symbolic element so the runtime call
            // dispatches to `IEnumerable<TElement>::GetEnumerator()`.
            let enumerableClosed = typeof(IEnumerable[object])
            let getEnumerator MethodInfo? = enumerableClosed.GetMethod(
                "GetEnumerator",
                BindingFlags.Instance | BindingFlags.Public,
                binder: nil,
                types: Type.EmptyTypes,
                modifiers: nil
            )
            if getEnumerator == nil {
                return false
            }
            let enumeratorClosed = typeof(IEnumerator[object])
            enumeratorType = ImportedTypeSymbol.GetConstructed(
                enumeratorClosed,
                typeof(System.Collections.Generic.IEnumerator[_]),
                ImmutableArray.Create[TypeSymbol](elementSym)
            )
            getEnumeratorCall = BoundImportedInstanceCallExpression(
                nil,
                collection,
                getEnumerator,
                enumeratorType!!,
                ImmutableArray[BoundExpression].Empty
            )
            return true
        }

        /// Issue #4907: the generic collections whose nested struct `Enumerator`
        /// the symbolic for-in path may call directly. Each one declares a public
        /// parameterless `GetEnumerator()` returning a nested value-type
        /// `Enumerator` generic over the collection's own type parameters, and
        /// that enumerator yields the same elements as the `IEnumerable<T>`
        /// implementation. Any other collection keeps the interface route.
        ///
        /// Issue #5151: `Span<T>` and `ReadOnlySpan<T>` are admitted too. They
        /// are by-ref-like, so they have no interface route, and the closed
        /// erased fallback would type their enumerator as
        /// `Span<object>.Enumerator`. Other by-ref-like collections keep the
        /// closed route: their enumerator shape is not known.
        private func IsStructEnumeratorCollection(openDef Type) bool {
            let fullName = openDef.FullName
            return fullName == "System.Span`1" ||
                fullName == "System.ReadOnlySpan`1" ||
                fullName == "System.Collections.Generic.List`1" ||
                fullName == "System.Collections.Generic.Dictionary`2" ||
                fullName == "System.Collections.Generic.HashSet`1" ||
                fullName == "System.Collections.Immutable.ImmutableArray`1"
        }

        /// Issue #5193: reads the enumerator type that the OPEN collection's
        /// public `GetEnumerator()` returns, and maps its type arguments onto the
        /// receiver's own arguments. Each argument of the open return type must
        /// be a type parameter of the collection itself. A closed argument, or
        /// a parameter of another owner, gives no mapping, so the caller keeps
        /// the closed route. This covers an enumerator that permutes the
        /// arguments, such as `Swap<A, B>` returning `Swap<B, A>.Enumerator`.
        /// @param openDef The open generic collection definition.
        /// @param typeArguments The receiver's symbolic type arguments.
        /// @param enumeratorArguments The symbolic arguments of the enumerator type.
        /// @returns The open generic enumerator definition, or `null` when the shape does not match.
        private func MapOpenEnumeratorArguments(
            openDef Type,
            typeArguments ImmutableArray[TypeSymbol],
            out enumeratorArguments ImmutableArray[TypeSymbol]
        ) Type? {
            enumeratorArguments = default(ImmutableArray[TypeSymbol])
            let openGetEnumerator MethodInfo? = MemberLookup.ResolveGetEnumerator(openDef, out _)
            if openGetEnumerator == nil {
                return nil
            }
            let openReturn = openGetEnumerator.ReturnType
            if !openReturn.IsValueType || !openReturn.IsGenericType || openReturn.IsGenericTypeDefinition {
                return nil
            }
            let openReturnArguments = openReturn.GetGenericArguments()
            let mapped = ImmutableArray.CreateBuilder[TypeSymbol](openReturnArguments.Length)
            for argument in openReturnArguments {
                if !argument.IsGenericParameter ||
                    argument.DeclaringMethod != nil ||
                    argument.DeclaringType != openDef ||
                    argument.GenericParameterPosition >= typeArguments.Length {
                    return nil
                }
                mapped.Add(typeArguments[argument.GenericParameterPosition])
            }
            enumeratorArguments = mapped.MoveToImmutable()
            return openReturn.GetGenericTypeDefinition()
        }

        /// Issue #4907: builds a `GetEnumerator()` call that returns the nested
        /// struct enumerator of [`receiver`](paramref), typed as the symbolic
        /// `Enumerator` over the receiver's own type arguments so the loop
        /// variable keeps the element symbol. Returns `false` (leaving the
        /// interface route to run) unless the shape matches exactly.
        private func TryBuildSymbolicStructGetEnumeratorCall(
            collection BoundExpression,
            receiver ImportedTypeSymbol,
            openDef Type,
            typeArguments ImmutableArray[TypeSymbol],
            @NotNullWhen(true) out getEnumeratorCall BoundExpression?,
            @NotNullWhen(true) out enumeratorType TypeSymbol?
        ) bool {
            getEnumeratorCall = nil
            enumeratorType = nil
            let erasedCollection Type? = receiver.ClrType
            if erasedCollection == nil ||
                !(IsStructEnumeratorCollection(openDef) || ClrTypeUtilities.IsByRefLike(openDef)) {
                return false
            }
            let getEnumerator MethodInfo? = MemberLookup.ResolveGetEnumerator(erasedCollection, out _)
            if getEnumerator == nil {
                return false
            }
            let erasedEnumerator = getEnumerator.ReturnType
            if !erasedEnumerator.IsValueType || typeArguments.Length != openDef.GetGenericArguments().Length {
                return false
            }
            let openEnumerator Type? = MapOpenEnumeratorArguments(openDef, typeArguments, out var enumeratorArguments)
            if openEnumerator == nil {
                return false
            }
            enumeratorType = ImportedTypeSymbol.GetConstructed(erasedEnumerator, openEnumerator, enumeratorArguments)
            getEnumeratorCall = BoundImportedInstanceCallExpression(
                nil,
                collection,
                getEnumerator,
                enumeratorType!!,
                ImmutableArray[BoundExpression].Empty
            )
            return true
        }

        private func TryBuildMoveNextAndCurrent(
            enumeratorType TypeSymbol,
            @NotNullWhen(true) out moveNextCallFactory((BoundExpression) -> BoundExpression)?,
            @NotNullWhen(true) out currentAccessFactory((BoundExpression) -> BoundExpression)?
        ) bool {
            let enumeratorClr Type? = enumeratorType.ClrType
            if enumeratorClr != nil {
                let moveNext MethodInfo? = MemberLookup.SafeGetMethodIncludingSelfAndInterfaces(
                    enumeratorClr,
                    "MoveNext",
                    Type.EmptyTypes
                ) ??
                    typeof(IEnumerator).GetMethod("MoveNext", Type.EmptyTypes)
                let currentMember MemberInfo? = cast[MemberInfo?](
                    MemberLookup.SafeGetPropertyIncludingSelfAndInterfaces(enumeratorClr, "Current")
                ) ??
                    cast[MemberInfo?](enumeratorClr.GetField("Current", BindingFlags.Instance | BindingFlags.Public)) ??
                    typeof(IEnumerator).GetProperty("Current")
                if moveNext != nil && currentMember != nil {
                    // Project the declared Current member; generic argument order does not identify the element type.
                    let currentType = switch currentMember {
                        case property is PropertyInfo: MemberLookup.GetClrPropertyTypeSymbol(enumeratorType, property)
                        case field is FieldInfo: MemberLookup.GetClrFieldTypeSymbol(enumeratorType, field)
                        default: GetClrMemberType(currentMember)
                    }
                    let createMoveNextCall(BoundExpression) -> BoundExpression = (receiver BoundExpression) -> {
                        return BoundImportedInstanceCallExpression(
                            nil,
                            receiver,
                            moveNext,
                            TypeSymbol.Bool,
                            ImmutableArray[BoundExpression].Empty
                        )
                    }
                    moveNextCallFactory = createMoveNextCall
                    currentAccessFactory = (receiver BoundExpression) -> {
                        // Issue #3501 / ADR-0056 §1: a ref-struct enumerator's
                        // `Current` is `ref T` (Span<T>.Enumerator); the loop
                        // variable observes the pointee, so the read auto-
                        // dereferences (the emitter's ldind), matching the
                        // binder-side element typing.
                        return ConversionClassifier.AutoDereferenceRefReturn(
                            BoundClrPropertyAccessExpression(nil, receiver, currentMember, currentType)
                        )
                    }
                    return true
                }
            }
            if enumeratorType is StructSymbol userEnumerator && userEnumerator.TryGetMethodIncludingInherited(
                "MoveNext",
                out var userMoveNext
            ) &&
                userMoveNext!!
                .Parameters
                .Length == 0 &&
                userMoveNext!!.Type == TypeSymbol.Bool &&
                MemberLookup
                .TryGetUserEnumeratorCurrent(userEnumerator, out var currentMember, out var currentType) {
                moveNextCallFactory = (receiver BoundExpression) -> {
                    return BoundUserInstanceCallExpression(
                        nil,
                        receiver,
                        userMoveNext!!,
                        ImmutableArray[BoundExpression].Empty
                    )
                }
                currentAccessFactory = (receiver BoundExpression) -> {
                    return if currentMember is PropertySymbol property {
                        cast[BoundExpression](
                            BoundPropertyAccessExpression(nil, receiver, userEnumerator, property, currentType, nil)
                        )
                    } else {
                        BoundFieldAccessExpression(
                            nil,
                            receiver,
                            userEnumerator,
                            cast[FieldSymbol](currentMember!!),
                            currentType,
                            nil
                        )
                    }
                }
                return true
            }
            moveNextCallFactory = nil
            currentAccessFactory = nil
            return false
        }

        /// Issue #3501 / ADR-0193 Phase 2: a pattern enumerator's `Current`
        /// member read through the funnel, with its top-level reference
        /// nullability dropped for the lowered access node. A ref-returning member
        /// (Span<T>.Enumerator's `Current` is `ref T`) reads as a
        /// (cref:ByRefTypeSymbol), so ADR-0056 §1 auto-dereference sees a
        /// managed pointer and inserts the load-indirect.
        private func GetClrMemberType(member MemberInfo) TypeSymbol -> MemberLookup.GetClrMemberValueTypeSymbol(member)
            .StripToBareShape()

        /// Issue #737: returns `true` when control flow falling
        /// off the end of [`statement`](paramref) is unreachable because the
        /// last (non-label) statement is an unconditional control transfer.
        /// Conservative — only the obvious leaf shapes are recognized; a
        /// `false` result is always safe (the caller emits the
        /// trailing `goto end` + `end:` pair). The check looks past
        /// trailing label statements because labels emit no IL of their own.
        /// @param statement The statement to inspect.
        /// @returns `true` when the statement provably ends in
        /// `return`, `throw`, or an unconditional `goto`; otherwise
        /// `false`.
        private func EndsInUnconditionalTransfer(statement BoundStatement) bool {
            switch statement {
                case BoundReturnStatement, BoundThrowStatement, BoundRethrowStatement, BoundGotoStatement {
                    return true
                }
                case fixedStatement is BoundFixedStatement {
                    return EndsInUnconditionalTransfer(fixedStatement.Body)
                }
                case block is BoundBlockStatement {
                    // A trailing label is a reachable continuation for branches
                    // inside the block, so the block can fall through even when
                    // the statement preceding that label is a throw/goto. Keeping
                    // that continuation preserves the branch around a later else
                    // arm when async catch awaits resume (#2781).
                    return block
                        .Statements
                        .Length > 0 &&
                        !(block.Statements[block.Statements.Length - 1] is BoundLabelStatement) &&
                        EndsInUnconditionalTransfer(block.Statements[block.Statements.Length - 1])
                }
                default {
                    return false
                }
            }
        }

        internal func Flatten(statement BoundStatement) BoundBlockStatement {
            let builder = ImmutableArray.CreateBuilder[BoundStatement]()
            let stack = Stack[BoundStatement]()
            stack.Push(statement)
            while stack.Count > 0 {
                let current = stack.Pop()
                if current is BoundBlockStatement block {
                    for s in block.Statements.Reverse() {
                        stack.Push(s)
                    }
                } else if current is BoundTryStatement t {
                    let flatTry = Flatten(t.TryBlock)
                    let flatCatches = ImmutableArray.CreateBuilder[BoundCatchClause]()
                    for clause in t.CatchClauses {
                        flatCatches.Add(clause.WithBody(Flatten(clause.Body)))
                    }
                    let flatFinally = if t.FinallyBlock == nil {
                        default(BoundStatement?)
                    } else {
                        cast[BoundStatement](Flatten(t.FinallyBlock))
                    }
                    builder.Add(BoundTryStatement(nil, flatTry, flatCatches.ToImmutable(), flatFinally))
                } else if current is BoundFixedStatement fixedStmt {
                    // ADR-0125 / issue #1026: flatten the fixed body so the emitter
                    // sees a flat statement list (lowered gotos/conditionals) inside
                    // the pinned region; the pin prologue/epilogue wrap it at emit.
                    let flatFixedBody = Flatten(fixedStmt.Body)
                    builder.Add(
                        BoundFixedStatement(
                            fixedStmt.Syntax,
                            fixedStmt.PinKind,
                            fixedStmt.PinnedVariable,
                            fixedStmt.PointerVariable,
                            fixedStmt.PinnedSource,
                            flatFixedBody,
                            fixedStmt.SourceVariable
                        )
                    )
                } else if current is BoundPatternSwitchStatement ps {
                    let flatArms = ImmutableArray.CreateBuilder[BoundPatternSwitchArm](ps.Arms.Length)
                    for arm in ps.Arms {
                        flatArms.Add(BoundPatternSwitchArm(nil, arm.Pattern, arm.Guard, Flatten(arm.Body)))
                    }
                    builder.Add(
                        BoundPatternSwitchStatement(nil, ps.Discriminant, flatArms.ToImmutable(), ps.IsExhaustive)
                    )
                } else {
                    builder.Add(current)
                }
            }
            return BoundBlockStatement(nil, builder.ToImmutable())
        }

        /// Issue #3501 A3: true when the arm's body starts with the synthesized
        /// `switchArm…` body-entry label a `fallthrough` in the
        /// previous arm jumps to (see `StatementBinder.BindSwitchStatement`).
        private func HasFallthroughEntryLabel(arm BoundPatternSwitchArm) bool -> arm.Body is BoundBlockStatement{
            Statements: [BoundLabelStatement{Label: {Name: {} labelName}}, ..]
        } &&
            labelName.StartsWith("switchArm", StringComparison.Ordinal)
    }
}
