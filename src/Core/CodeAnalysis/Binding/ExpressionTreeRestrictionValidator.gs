// <copyright file="ExpressionTreeRestrictionValidator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Reflection

/// Issue #2130: validates that a lambda being converted to
/// `System.Linq.Expressions.Expression<TDelegate>` only uses the
/// subset of language constructs G# lowers to expression-tree factory calls.
internal shared class ExpressionTreeRestrictionValidator {
    func Validate(literal BoundFunctionLiteralExpression?, targetType TypeSymbol, diagnostics DiagnosticBag?) {
        if literal == nil || diagnostics == nil {
            return
        }
        if !MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(targetType, out var delegateType) ||
            !MemberLookup
            .TryGetDelegateFunctionTypeFromSymbol(delegateType!!, out _) {
            diagnostics.ReportExpressionTreeTargetMustBeDelegate(
                if literal.Syntax != nil {
                    literal.Syntax!!.Location
                } else {
                    literal.Function.Declaration?.Location ?? default(TextLocation)
                },
                targetType ?? TypeSymbol.Error
            )
            return
        }
        if literal.Syntax is LambdaExpressionSyntax lambdaSyntax {
            if lambdaSyntax.IsAsync {
                diagnostics.ReportExpressionTreeUnsupported(
                    lambdaSyntax.AsyncModifier?.Location ?? default(TextLocation),
                    "an async lambda"
                )
            }
            if lambdaSyntax.Body is BlockExpressionSyntax {
                diagnostics.ReportExpressionTreeUnsupported(lambdaSyntax.Body.Location, "a statement body")
            }
        }
        for parameter in literal.Function.Parameters {
            if parameter.Name == "_" {
                diagnostics.ReportExpressionTreeUnsupported(
                    parameter.DeclaringSyntax?.Location ?? literal.Syntax?.Location ?? default(TextLocation),
                    "a discard parameter"
                )
            }
            if parameter.RefKind != RefKind.None {
                diagnostics.ReportExpressionTreeUnsupported(
                    parameter.DeclaringSyntax?.Location ?? literal.Syntax?.Location ?? default(TextLocation),
                    "a '${parameter.RefKind.ToString().ToLowerInvariant()}' parameter"
                )
            }
            if parameter.IsVariadic {
                diagnostics.ReportExpressionTreeUnsupported(
                    parameter.DeclaringSyntax?.Location ?? literal.Syntax?.Location ?? default(TextLocation),
                    "a variadic parameter"
                )
            }
            if TypeSymbol.IsByRefLike(parameter.Type) || (parameter.Type is ByRefTypeSymbol or PointerTypeSymbol) {
                diagnostics.ReportExpressionTreeUnsupported(
                    parameter.DeclaringSyntax?.Location ?? literal.Syntax?.Location ?? default(TextLocation),
                    "the restricted type '${parameter.Type}'"
                )
            }
        }
        ValidateStatement(literal.Body, diagnostics)
    }

    private func ValidateStatement(statement BoundStatement?, diagnostics DiagnosticBag) {
        switch statement {
            case nil {
                return
            }
            case block is BoundBlockStatement {
                for child in block.Statements {
                    ValidateStatement(child, diagnostics)
                }
                return
            }
            case ret is BoundReturnStatement {
                ValidateExpression(ret.Expression, diagnostics)
                return
            }
            case exprStmt is BoundExpressionStatement {
                ValidateExpression(exprStmt.Expression, diagnostics)
                return
            }
            default {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(statement!!.Syntax), "a statement")
                return
            }
        }
    }

    /// ADR-0186 §4: validates a RECEIVER, eliding the platform nil check the
    /// binder inserted on it.
    ///
    /// §4 says the inserted check is <em>redundant where the runtime's own
    /// check fires</em>, and names that as a reason to <b>elide</b> it: "The
    /// CLR's own check on a `callvirt`/`ldfld` receiver makes the
    /// inserted check redundant where it fires, which is a reason to elide it
    /// as an optimization." Inside an expression-tree lambda gsc emits no IL
    /// at all — the access becomes `Expression.Property`/`Field`/a
    /// call node — and `System.Linq.Expressions` dereferences the
    /// instance when the tree is evaluated, throwing
    /// `NullReferenceException` at exactly the same point. The failure
    /// is preserved; only G#'s message is lost.
    ///
    /// This is the narrow half of a change Copilot review on the flip PR was
    /// right to push back on. Removing the rejection wholesale would drop
    /// checks §4 genuinely requires — an argument, a store, a return, or a
    /// lambda result inside the tree has nothing dereferencing it, and those
    /// still report `GS0473`. What forced the question is that rejecting
    /// <em>receivers</em> is a build break on ordinary code: any oblivious
    /// reference member touched inside a LINQ-to-`IQueryable` lambda
    /// inserts a receiver check, so `.Where(b -> b.Conversion.AccountId
    /// == id)` stopped compiling the moment the default flipped
    /// (`Issue2661ExpressionTreeNullablePipelineTests`). It is also not
    /// a regression: under ADR-0136 that receiver is `T?`, cs2gs writes
    /// an explicit `!!`, and the same lowering erases it.
    ///
    /// <b>"The tree dereferences it" is measured, not assumed.</b> Review
    /// objected that `Expression.Call` on a non-virtual method may emit
    /// `call`, which does not reject a null `this`, so a member
    /// that never touches its receiver could complete on a nil — losing the
    /// failure entirely rather than merely its message. That is exactly the
    /// enumeration ADR-0186 §4 demands (its own receiver exemption was
    /// falsified by one), so it was run rather than argued. A compiled tree
    /// over a <b>sealed</b> class, through both a field receiver and a
    /// property receiver, into both an auto-property and a getter that
    /// provably never reads `this`:
    ///
    /// ```xmldoc
    /// <list type="table">
    /// <listheader><term>shape</term><description>result</description></listheader>
    /// <item><term>property receiver → auto-property</term><description><c>NullReferenceException</c></description></item>
    /// <item><term>property receiver → <c>this</c>-free getter</term><description><c>NullReferenceException</c></description></item>
    /// <item><term>field receiver → auto-property</term><description><c>NullReferenceException</c></description></item>
    /// <item><term>field receiver → <c>this</c>-free getter</term><description><c>NullReferenceException</c></description></item>
    /// </list>
    /// ```
    ///
    /// All four throw: `System.Linq.Expressions`' compiler emits the
    /// dereferencing form for instance member access regardless of
    /// virtuality, exactly as `csc` does and for the same reason. The
    /// objection is well-posed and empirically false for
    /// `Expression.Compile()`; for an `IQueryable` provider that
    /// never compiles the tree, the receiver has no runtime existence at all
    /// and no check could be meaningful either way.
    /// `Adr0186PlatformTypeBindingTests.Section4_AnElidedReceiverCheck_Still_Throws_When_TheTreeRuns`
    /// keeps that a live assertion rather than a comment.
    ///
    /// The residual — a receiver failing with the runtime's unattributed
    /// message instead of G#'s — is tracked as <b>#4352</b>.
    /// @param receiver The receiver expression, possibly `null`.
    /// @param diagnostics The bag to report into.
    private func ValidateReceiver(receiver BoundExpression?, diagnostics DiagnosticBag) {
        if receiver is BoundUnaryExpression check &&
            check
            .Op
            .Kind == BoundUnaryOperatorKind.NullAssertion &&
            check
            .Operand
            .Type is PlatformTypeSymbol {
            ValidateExpression(check.Operand, diagnostics)
            return
        }
        ValidateExpression(receiver, diagnostics)
    }

    private func ValidateExpression(expression BoundExpression?, diagnostics DiagnosticBag) {
        if expression == nil {
            return
        }
        if (expression.Type is ByRefTypeSymbol or PointerTypeSymbol) || TypeSymbol.IsByRefLike(expression.Type) {
            diagnostics.ReportExpressionTreeUnsupported(
                LocationOf(expression.Syntax),
                "the restricted type '${expression.Type}'"
            )
        }
        switch expression {
            case BoundErrorExpression,
            BoundLiteralExpression,
            BoundVariableExpression,
            BoundDefaultExpression,
            BoundTypeOfExpression {
                return
            }
            case BoundFunctionLiteralExpression {
                // Nested delegate-valued lambdas are allowed; they become
                // Expression.Constant(delegateValue, typeof(DelegateType)).
                return
            }
            case conversion is BoundConversionExpression {
                if conversion.Expression is BoundFunctionLiteralExpression nestedLiteral &&
                    MemberLookup
                    .TryGetExpressionTreeDelegateTypeFromSymbol(conversion.Type, out _) {
                    Validate(nestedLiteral, conversion.Type, diagnostics)
                    return
                }
                if conversion.Expression.Type is TupleTypeSymbol || conversion.Type is TupleTypeSymbol {
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(conversion.Syntax), "a tuple conversion")
                }
                ValidateExpression(conversion.Expression, diagnostics)
                return
            }
            case unary is BoundUnaryExpression {
                if (unary.Op.Kind is BoundUnaryOperatorKind.ReferenceOf or BoundUnaryOperatorKind.DereferenceOf) {
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(unary.Syntax), "an unsafe pointer operation")
                } else if unary
                    .Op
                    .Kind == BoundUnaryOperatorKind.NullAssertion &&
                    unary
                    .Operand
                    .Type is PlatformTypeSymbol {
                    // ADR-0186 §4: a null assertion over a PLATFORM operand is
                    // the one reference-typed `!!` that is not pure static
                    // annotation. It lowers to a real
                    // `dup; brtrue; pop; newobj; throw`, and
                    // `ExpressionTreeLowerer.BuildUnaryExpression` erases every
                    // `NullAssertion` node on the reasoning directly below —
                    // correct for a real `T?`, wrong here. Erased, the boundary
                    // silently disappears inside an expression-tree lambda: no
                    // check, no message, no diagnostic.
                    //
                    // Rejected rather than represented. `System.Linq.Expressions`
                    // has no throw-on-nil-and-yield-the-value form that
                    // preserves G#'s contract AND survives translation by an
                    // `IQueryable` provider, which is why the nullable
                    // value-type case below is rejected too rather than
                    // lowered.
                    //
                    // REACHED ONLY FOR A NON-RECEIVER COERCION. A platform
                    // check sitting on the RECEIVER of a member access, call
                    // or index is elided by `ValidateReceiver` before it gets
                    // here — see the reasoning there. Step 3 briefly removed
                    // this rejection outright, which was wrong: Copilot review
                    // pointed out that it silently drops a check §4 and the
                    // release note both promise, and that open question 13
                    // covers signature relations rather than expression-level
                    // conversions. The receiver elision is the narrow,
                    // ADR-sanctioned part of that change; this rejection is
                    // the part that had to come back.
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(unary.Syntax),
                        "a nullability-oblivious value used where a non-null type is required"
                    )
                } else if unary
                    .Op
                    .Kind == BoundUnaryOperatorKind.NullAssertion &&
                    !unary.IsConversionUnwrap &&
                    IsNullableValueTypeAssertion(unary) {
                    // Issue #3349: `!!` is only unrepresentable in an expression
                    // tree when it strips a nullable VALUE type — `T?` to `T` is a
                    // real CLR conversion (`Nullable<T>.Value`) with no
                    // System.Linq.Expressions counterpart that preserves G#'s
                    // throw-on-nil contract. Over a REFERENCE type it is pure
                    // static annotation: the CLR has no distinct `T?`, and
                    // `Expression.TypeAs(x, T)` already has type `T`, so the
                    // assertion erases to nothing and the tree is unaffected.
                    // Banning it there made a downcast unwritable inside an
                    // expression-tree lambda once `as T` started yielding `T?`,
                    // since narrowing the result requires `!!` and no other
                    // spelling exists.
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(unary.Syntax),
                        "a null-assertion operator on a nullable value type"
                    )
                }
                ValidateExpression(unary.Operand, diagnostics)
                return
            }
            case binary is BoundBinaryExpression {
                if binary.Op.IsDelegateCombination {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(binary.Syntax),
                        "a delegate combination operator"
                    )
                } else if binary
                    .Op
                    .Kind == BoundBinaryOperatorKind.NullCoalesce &&
                    (binary.Left is BoundLiteralExpression and {Value: nil} or BoundDefaultExpression) {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(binary.Syntax),
                        "a coalescing operator with a null/default left operand"
                    )
                }
                ValidateExpression(binary.Left, diagnostics)
                ValidateExpression(binary.Right, diagnostics)
                return
            }
            case conditional is BoundConditionalExpression {
                ValidateExpression(conditional.Condition, diagnostics)
                ValidateExpression(conditional.WhenTrue, diagnostics)
                ValidateExpression(conditional.WhenFalse, diagnostics)
                return
            }
            case field is BoundFieldAccessExpression {
                ValidateReceiver(field.Receiver, diagnostics)
                return
            }
            case property is BoundPropertyAccessExpression {
                ValidateReceiver(property.Receiver, diagnostics)
                return
            }
            case clrProperty is BoundClrPropertyAccessExpression {
                ValidateReceiver(clrProperty.Receiver, diagnostics)
                return
            }
            case index is BoundIndexExpression {
                ValidateReceiver(index.Target, diagnostics)
                for indexExpression in index.Indices {
                    ValidateExpression(indexExpression, diagnostics)
                }
                return
            }
            case clrIndex is BoundClrIndexExpression {
                ValidateReceiver(clrIndex.Target, diagnostics)
                for argument in clrIndex.Arguments {
                    ValidateExpression(argument, diagnostics)
                }
                return
            }
            case array is BoundArrayCreationExpression {
                if !array.DimensionExpressions.IsDefaultOrEmpty {
                    for dimension in array.DimensionExpressions {
                        ValidateExpression(dimension, diagnostics)
                    }
                } else {
                    ValidateExpression(array.LengthExpression, diagnostics)
                }
                if array.Type is RectangularArrayTypeSymbol && !array.Elements.IsDefaultOrEmpty {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(array.Syntax),
                        "a rectangular-array initializer"
                    )
                }
                for element in array.Elements {
                    ValidateExpression(element, diagnostics)
                }
                return
            }
            case ctor is BoundConstructorCallExpression {
                for argument in ctor.Arguments {
                    ValidateExpression(argument, diagnostics)
                }
                return
            }
            case clrCtor is BoundClrConstructorCallExpression {
                for argument in clrCtor.Arguments {
                    ValidateExpression(argument, diagnostics)
                }
                return
            }
            case call is BoundCallExpression {
                if call.Function.StaticOwnerType == nil {
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(call.Syntax), "a top-level function call")
                    return
                }
                ValidateArguments(call.Arguments, call.Function.Parameters, diagnostics)
                return
            }
            case userCall is BoundUserInstanceCallExpression {
                ValidateReceiver(userCall.Receiver, diagnostics)
                ValidateArguments(userCall.Arguments, userCall.Method.Parameters, diagnostics)
                return
            }
            case importedCall is BoundImportedCallExpression {
                ValidateClrArguments(
                    importedCall.Arguments,
                    importedCall.ArgumentRefKinds,
                    importedCall.Function.Method,
                    diagnostics
                )
                return
            }
            case importedInstanceCall is BoundImportedInstanceCallExpression {
                if importedInstanceCall
                    .Method
                    .Name == "<Clone>$$" &&
                    importedInstanceCall.Syntax is WithExpressionSyntax {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(importedInstanceCall.Syntax),
                        "an imported data copy"
                    )
                    return
                }
                ValidateReceiver(importedInstanceCall.Receiver, diagnostics)
                ValidateClrArguments(
                    importedInstanceCall.Arguments,
                    importedInstanceCall.ArgumentRefKinds,
                    importedInstanceCall.Method,
                    diagnostics
                )
                return
            }
            case clrStaticCall is BoundClrStaticCallExpression {
                ValidateClrArguments(
                    clrStaticCall.Arguments,
                    clrStaticCall.ArgumentRefKinds,
                    clrStaticCall.Method,
                    diagnostics
                )
                return
            }
            case clrBinary is BoundClrBinaryOperatorExpression {
                ValidateExpression(clrBinary.Left, diagnostics)
                ValidateExpression(clrBinary.Right, diagnostics)
                return
            }
            case clrUnary is BoundClrUnaryOperatorExpression {
                ValidateExpression(clrUnary.Operand, diagnostics)
                return
            }
            case conversion is BoundClrConversionCallExpression {
                ValidateExpression(conversion.Source, diagnostics)
                return
            }
            case isExpression is BoundIsExpression {
                if !isExpression.IsSimpleTypeTest {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(expression.Syntax),
                        "a general pattern 'is' expression"
                    )
                    return
                }
                ValidateExpression(isExpression.Expression, diagnostics)
                return
            }
            case asExpression is BoundAsExpression {
                ValidateExpression(asExpression.Expression, diagnostics)
                return
            }
            case BoundAssignmentExpression,
            BoundFieldAssignmentExpression,
            BoundPropertyAssignmentExpression,
            BoundClrPropertyAssignmentExpression,
            BoundIndexAssignmentExpression,
            BoundClrIndexAssignmentExpression,
            BoundIndirectAssignmentExpression {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "an assignment operator")
                return
            }
            case BoundAwaitExpression {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "an await expression")
                return
            }
            case BoundNullConditionalAccessExpression {
                diagnostics.ReportExpressionTreeUnsupported(
                    LocationOf(expression.Syntax),
                    "a null-propagating operator"
                )
                return
            }
            case BoundThrowExpression {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a throw expression")
                return
            }
            case BoundSwitchExpression {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a switch expression")
                return
            }
            case BoundTupleLiteralExpression, BoundTupleElementAccessExpression {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a tuple expression")
                return
            }
            case BoundMapLiteralExpression {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a map/dictionary literal")
                return
            }
            case BoundInterpolatedStringExpression {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "an interpolated string")
                return
            }
            case BoundAddressOfExpression,
            BoundDereferenceExpression,
            BoundFunctionPointerFromMethodExpression,
            BoundFunctionPointerInvocationExpression,
            BoundSizeOfExpression {
                diagnostics.ReportExpressionTreeUnsupported(
                    LocationOf(expression.Syntax),
                    "an unsafe pointer operation"
                )
                return
            }
            case BoundMethodGroupExpression, BoundClrMethodGroupExpression {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a method group")
                return
            }
            case structLiteral is BoundStructLiteralExpression {
                if structLiteral.CopySource != nil {
                    if structLiteral.StructType.ClrType != nil {
                        diagnostics.ReportExpressionTreeUnsupported(
                            LocationOf(expression.Syntax),
                            "an imported data copy"
                        )
                        return
                    }
                    ValidateExpression(structLiteral.CopySource, diagnostics)
                }
                // User-declared struct/class composite literals (`Point{X:
                // 1, Y: 2}`) are legal inside expression-tree lambdas, for
                // the same reason object initializers are (see
                // TryValidateObjectInitializer below): only the member
                // value expressions need validating. (Issue #2224:
                // anonymous-class literals — `object { let ... }` — are
                // bound as BoundConstructorCallExpression instead, validated
                // above, since their get-only-auto-property shape compiles
                // to a primary-constructor call, same as C#'s `new { ... }`.)
                for initializer in structLiteral.Initializers {
                    ValidateExpression(initializer.Value, diagnostics)
                }
                return
            }
            case block is BoundBlockExpression {
                if BoundStructLiteralExpression.IsStagedConstruction(block) {
                    for declaration BoundVariableDeclaration in block.Statements {
                        ValidateExpression(declaration.Initializer, diagnostics)
                    }
                    ValidateExpression(block.Expression, diagnostics)
                    return
                }
                if TryValidateObjectInitializer(block, diagnostics) {
                    return
                }
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a block expression")
                return
            }
            default {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "'${expression.Kind}'")
                return
            }
        }
    }

    private func ValidateArguments(
        arguments ImmutableArray[BoundExpression],
        parameters ImmutableArray[ParameterSymbol],
        diagnostics DiagnosticBag
    ) {
        for var i = 0; i < arguments.Length; i++ {
            if i < parameters.Length && parameters[i].RefKind != RefKind.None {
                diagnostics.ReportExpressionTreeUnsupported(
                    LocationOf(arguments[i].Syntax),
                    "a '${parameters[i].RefKind.ToString().ToLowerInvariant()}' argument"
                )
            }
            ValidateExpression(arguments[i], diagnostics)
        }
    }

    private func ValidateClrArguments(
        arguments ImmutableArray[BoundExpression],
        argumentRefKinds ImmutableArray[RefKind],
        method MethodBase?,
        diagnostics DiagnosticBag
    ) {
        if method != nil && (method.CallingConvention & CallingConventions.VarArgs) != 0 {
            diagnostics.ReportExpressionTreeUnsupported(
                if arguments.Length > 0 {
                    LocationOf(arguments[0].Syntax)
                } else {
                    default(TextLocation)
                },
                "a varargs call"
            )
        }
        for var i = 0; i < arguments.Length; i++ {
            if !argumentRefKinds.IsDefaultOrEmpty &&
                i < argumentRefKinds.Length &&
                argumentRefKinds[i] != RefKind
                .None {
                diagnostics.ReportExpressionTreeUnsupported(
                    LocationOf(arguments[i].Syntax),
                    "a '${argumentRefKinds[i].ToString().ToLowerInvariant()}' argument"
                )
            }
            ValidateExpression(arguments[i], diagnostics)
        }
    }

    private func LocationOf(syntax SyntaxNode?) TextLocation -> if syntax != nil {
        syntax.Location
    } else {
        default(TextLocation)
    }

    private func TryValidateObjectInitializer(block BoundBlockExpression, diagnostics DiagnosticBag) bool {
        if !TryMatchObjectInitializer(
            block,
            out var receiver,
            out var initializer,
            out var statements,
            out var captures
        ) {
            return false
        }
        for capture in captures {
            ValidateExpression(capture.Initializer, diagnostics)
        }
        ValidateExpression(initializer, diagnostics)
        for statement in statements {
            if statement is not BoundExpressionStatement expressionStatement {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(statement.Syntax), "a block expression")
                return true
            }
            switch expressionStatement.Expression {
                case field is BoundFieldAssignmentExpression when ReferencesReceiver(field, receiver) {
                    ValidateExpression(field.Value, diagnostics)
                }
                case property is BoundPropertyAssignmentExpression when ReferencesReceiver(
                    property.Receiver,
                    receiver
                ) {
                    ValidateExpression(property.Value, diagnostics)
                }
                case clrProperty is BoundClrPropertyAssignmentExpression when ReferencesReceiver(
                    clrProperty.Receiver,
                    receiver
                ) {
                    ValidateExpression(clrProperty.Value, diagnostics)
                }
                case importedCall is BoundImportedInstanceCallExpression when ReferencesReceiver(
                    importedCall.Receiver,
                    receiver
                ) {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(expressionStatement.Expression.Syntax),
                        "a collection initializer"
                    )
                    return true
                }
                case userCall is BoundUserInstanceCallExpression when ReferencesReceiver(userCall.Receiver, receiver) {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(expressionStatement.Expression.Syntax),
                        "a collection initializer"
                    )
                    return true
                }
                case clrIndexAssignment is BoundClrIndexAssignmentExpression when ReferencesReceiver(
                    clrIndexAssignment,
                    receiver
                ) {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(expressionStatement.Expression.Syntax),
                        "a collection initializer"
                    )
                    return true
                }
                case indexAssignment is BoundIndexAssignmentExpression when ReferencesReceiver(
                    indexAssignment,
                    receiver
                ) {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(expressionStatement.Expression.Syntax),
                        "a collection initializer"
                    )
                    return true
                }
                default {
                    diagnostics.ReportExpressionTreeUnsupported(
                        LocationOf(expressionStatement.Expression.Syntax),
                        "a block expression"
                    )
                    return true
                }
            }
        }
        return true
    }

    private func TryMatchObjectInitializer(
        block BoundBlockExpression,
        out receiver VariableSymbol?,
        out initializer BoundExpression?,
        out statements ImmutableArray[BoundStatement],
        out captures ImmutableArray[BoundVariableDeclaration]
    ) bool {
        receiver = nil
        initializer = nil
        statements = default(ImmutableArray[BoundStatement])
        captures = default(ImmutableArray[BoundVariableDeclaration])
        if block.Expression is not BoundVariableExpression result {
            return false
        }
        let leading = ImmutableArray.CreateBuilder[BoundVariableDeclaration]()
        for var index = 0; index < block.Statements.Length; index++ {
            if block.Statements[index] is not BoundVariableDeclaration{Initializer: not nil} declaration ||
                declaration.Syntax is VariableDeclarationSyntax {
                return false
            }
            if object.ReferenceEquals(declaration.Variable, result.Variable) {
                if leading.Count != 0 &&
                    declaration.Initializer is not(BoundStructLiteralExpression and {CopySource: not nil}) {
                    return false
                }
                receiver = declaration.Variable
                initializer = declaration.Initializer
                statements = block.Statements.RemoveRange(0, index + 1)
                captures = leading.ToImmutable()
                return true
            }
            leading.Add(declaration)
        }
        return false
    }

    // Issue #3349: true when `unary`'s null-assertion strips a nullable VALUE
    // type, which is a real CLR conversion an expression tree cannot represent.
    // A reference-type assertion is annotation-only and erases cleanly, so it is
    // permitted (see the GS0473 site above). An unconstrained type parameter is
    // treated conservatively as a value type: it may be instantiated with one.
    private func IsNullableValueTypeAssertion(unary BoundUnaryExpression) bool {
        let underlying = if unary.Operand.Type is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            unary.Operand.Type
        }
        return underlying is TypeParameterSymbol &&
            underlying.HasReferenceTypeConstraint == false ||
            ReflectionMetadataEmitter.IsValueTypeSymbol(underlying)
    }

    private func ReferencesReceiver(
        expression BoundExpression?,
        receiver VariableSymbol?
    ) bool -> expression is BoundVariableExpression variable &&
        object.ReferenceEquals(variable.Variable, receiver)

    private func ReferencesReceiver(
        assignment BoundFieldAssignmentExpression,
        receiver VariableSymbol?
    ) bool -> object.ReferenceEquals(assignment.Receiver, receiver) ||
        ReferencesReceiver(assignment.ReceiverExpression, receiver)

    private func ReferencesReceiver(
        assignment BoundClrIndexAssignmentExpression,
        receiver VariableSymbol?
    ) bool -> object.ReferenceEquals(assignment.Target, receiver) ||
        ReferencesReceiver(assignment.TargetExpression, receiver)

    private func ReferencesReceiver(
        assignment BoundIndexAssignmentExpression,
        receiver VariableSymbol?
    ) bool -> object.ReferenceEquals(assignment.Target, receiver) ||
        ReferencesReceiver(assignment.TargetExpression, receiver)
}
