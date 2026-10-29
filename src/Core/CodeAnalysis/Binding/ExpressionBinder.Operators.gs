// <copyright file="ExpressionBinder.Operators.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Numerics
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Diagnostics
import System.Threading

internal partial class ExpressionBinder {
    private func BindUnaryExpression(syntax UnaryExpressionSyntax) BoundExpression {
        // Phase 5.5 / ADR-0022: prefix `<-ch` is a channel-receive expression,
        // not a unary operator. Route to a dedicated binder so the operator
        // table doesn't need a per-element-type entry.
        if syntax.OperatorToken.Kind == SyntaxKind.LeftArrowToken {
            return BindChannelReceiveExpression(syntax)
        }
        // ADR-0039: `&expr` — address-of (managed by-ref pointer).
        if syntax.OperatorToken.Kind == SyntaxKind.AmpersandToken {
            return BindAddressOfExpression(syntax)
        }
        // ADR-0039: `*expr` — dereference a by-ref pointer.
        if syntax.OperatorToken.Kind == SyntaxKind.StarToken {
            return BindDereferenceExpression(syntax)
        }
        // Issue #3684 (family F14) / ECMA-334 §12.9.3: the lexer types a
        // decimal literal one past int.MaxValue as `uint32` (it does not fit
        // int32), so `-2147483648` — plain `int32.MinValue`, and how every C#
        // corpus spells it — bound as a negation of uint32 and was rejected
        // outright with GS0128 (`-` is not defined for uint32). C# resolves
        // this at the token level: a decimal literal whose value is exactly
        // 2^31 and which sits IMMEDIATELY under a unary minus is an `int32`.
        // The enum-member folder (DeclarationBinder.TryFoldEnumMemberValue,
        // issue #1912) already carried this rule; mirror it for the general
        // expression position so the two agree.
        if syntax
            .OperatorToken
            .Kind == SyntaxKind.MinusToken &&
            syntax.Operand is LiteralExpressionSyntax{Value: uint32 negatedMagnitude} &&
            negatedMagnitude == uint32(int32.MaxValue) +
            uint32(1) {
            return BoundLiteralExpression(nil, int32.MinValue, TypeSymbol.Int32)
        }
        var boundOperand = BindExpression(syntax.Operand)
        if boundOperand.Type == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        // Issue #2616 / ECMA-334 §14.2.6.1: char participates in unary numeric
        // promotion as int32. Promote before operator lookup so the bound
        // operand, operator signature, evaluator value, and emitted stack type
        // all agree; recording a char operand with an int32 result would leave
        // the interpreter operating on a boxed Char.
        if TryGetPromotedCharUnaryType(syntax.OperatorToken.Kind, boundOperand.Type, out var promotedUnaryType) {
            boundOperand = conversions.BindConversion(
                syntax.Operand.Location,
                boundOperand,
                Invariant.Required(
                    promotedUnaryType,
                    "a promoted char operand has a target type",
                    expression: "promotedUnaryType"
                )
            )
        }
        ReportNullAssertionIfRedundant(syntax.OperatorToken, boundOperand)
        // ADR-0186 §6: a user-written `!!` over a `T!` operand IS §4's
        // coercion, spelled explicitly — "the explicit spelling of a
        // conversion the compiler would otherwise perform implicitly at the
        // same point". It therefore gets §4's attributable message too, so a
        // migrated corpus's existing `!!` does not silently produce a worse
        // diagnostic than the implicit coercion beside it would have.
        // `--platform-nil-checks=off` does NOT reach here: the switch governs
        // checks the compiler *inserts*, never one the author wrote — hence
        // `suppressible: false`.
        if syntax.OperatorToken.Kind == SyntaxKind.BangBangToken && boundOperand.Type is PlatformTypeSymbol {
            return binderCtx.InsertPlatformCheck(
                boundOperand,
                syntax.OperatorToken.Location,
                "an explicit '!!'",
                suppressible: false
            )
        }
        let boundOperator BoundUnaryOperator? = BoundUnaryOperator.Bind(syntax.OperatorToken.Kind, boundOperand.Type)
        if boundOperator == nil {
            // Stream D: try user-defined `func (a T) operator <op>() R` on the
            // operand's user type. Issue #2377: the operator is a static,
            // SpecialName `op_*` method on the struct/class (StaticMethods),
            // NOT an instance method — the receiver-clause `a` is preserved
            // only as the operator's first formal parameter (Parameters[0],
            // Parameters.Length==1 for unary ops). Extension-function
            // fallback (non-owned receiver types) also covered.
            let userOpName string? = OperatorNames.TryGetUnaryName(syntax.OperatorToken.Kind)
            if userOpName != nil && boundOperand.Type != nil {
                var userOp FunctionSymbol? = nil
                if boundOperand.Type is StructSymbol operandStruct &&
                    TypeMemberModel.TryGetStaticMethodIncludingInherited(operandStruct, userOpName, out var structOp) {
                    userOp = structOp
                } else if $scope.TryLookupExtensionFunction(boundOperand.Type, userOpName, out var extOp) {
                    userOp = extOp
                }
                if userOp != nil && userOp.Parameters.Length == 1 {
                    let convertedOperand = conversions.BindConversion(
                        syntax.Operand.Location,
                        boundOperand,
                        userOp.Parameters[0].Type
                    )
                    return BoundCallExpression(nil, userOp, ImmutableArray.Create(convertedOperand))
                }
            }
            // Stream C: fall back to a public-static unary `op_*` method on
            // the operand's CLR type (`-time`, `~bits`, ...).
            var ambiguous = false
            if boundOperand.Type?.ClrType != nil && ClrOperatorResolution.TryResolveUnary(
                syntax.OperatorToken.Kind,
                boundOperand.Type,
                out var clrMethod,
                out ambiguous
            ) {
                return BoundClrUnaryOperatorExpression(
                    nil,
                    syntax.OperatorToken.Kind,
                    boundOperand,
                    clrMethod!!,
                    ClrNullability.GetReturnTypeSymbol(clrMethod!!)
                )
            } else if ambiguous {
                Diagnostics.ReportAmbiguousOverload(
                    syntax.OperatorToken.Location,
                    syntax.OperatorToken.Text,
                    candidateCount: 2
                )
                return BoundErrorExpression(nil)
            }
            Diagnostics.ReportUndefinedUnaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                boundOperand.Type ?? TypeSymbol.Error
            )
            return BoundErrorExpression(nil)
        }
        // Issue #2023: unary negation on an integral operand bound inside a
        // `checked` context traps on overflow (e.g. `checked(-int.MinValue)`),
        // mirroring #1881's checked Sum/Difference/Product. Mirroring
        // BoundBinaryExpression, the flag is threaded unconditionally from
        // the current checked/unchecked context; every operator kind other
        // than Negation (and Negation over float/double/decimal, which never
        // overflows) simply ignores it downstream.
        return BoundUnaryExpression(nil, boundOperator, boundOperand, binderCtx.IsCheckedContext)
    }

    /// Issue #3501 (!! reduction): reports GS0536 when a user-written
    /// `!!` asserts a value whose bound type — narrowing included, since
    /// reads come back with their narrowed type — is already non-nullable.
    /// The assertion is then a no-op the author (or cs2gs's polish pass,
    /// which strips exactly these spans) can drop. Shared by every syntax
    /// path that binds a user `!!`.
    /// @param operatorToken The `!!` operator token.
    /// @param operand The bound operand.
    private func ReportNullAssertionIfRedundant(operatorToken SyntaxToken, operand BoundExpression) {
        // Generated trees (`.g.gs`) are rewritten on every build — advisory
        // polish warnings there are pure noise nobody can act on, the same
        // reason the ADR-0169 analyzer driver skips generated code.
        if operatorToken.Location.FileName?.EndsWith(".g.gs", StringComparison.OrdinalIgnoreCase) == true {
            return
        }
        // ADR-0186 §6/§7: a `T!` operand is NEVER redundant. The value may
        // genuinely be nil — that is what oblivious means — and the assertion
        // is the explicit spelling of the `T! -> T` coercion ADR-0186 §4 would
        // otherwise insert implicitly at the same point, emitting the same
        // check. Flagging it would tell an author (and cs2gs's polish pass,
        // which strips exactly these spans) to delete a real runtime guard.
        if operatorToken.Kind == SyntaxKind.BangBangToken &&
            operand.Type != nil &&
            operand.Type != TypeSymbol.Error &&
            !(operand.Type is NullableTypeSymbol) &&
            !(operand.Type is PlatformTypeSymbol) {
            Diagnostics.ReportRedundantNullAssertion(operatorToken.Location)
        }
    }

    /// ADR-0039: Binds `&expr` — takes managed pointer to an lvalue.
    private func BindAddressOfExpression(syntax UnaryExpressionSyntax) BoundExpression {
        // ADR-0061: `&(cond ? a : b)` and `&cond ? a : b` (parser tail
        // form). Dispatch to the conditional ref-argument binder, which
        // produces a BoundConditionalAddressExpression of type `T&`.
        // The operand may be wrapped in parens by the parser; unwrap.
        var rawOperand = syntax.Operand
        while rawOperand is ParenthesizedExpressionSyntax pen {
            rawOperand = pen.Expression
        }
        if rawOperand is ConditionalRefArgumentExpressionSyntax condOperand {
            return conversions.BindConditionalRefArgument(condOperand, outerModifier: nil)
        }
        // ADR-0062: a general conditional expression as the operand of `&`
        // binds to the conditional-address path (preserving ADR-0061 byref
        // safety) when both arms are lvalues of a common pointee type.
        if rawOperand is ConditionalExpressionSyntax generalCond {
            return BindConditionalAddressFromGeneral(generalCond, outerModifier: nil)
        }
        let operand = BindExpression(syntax.Operand)
        if operand is BoundErrorExpression {
            return operand
        }
        // ADR-0122 §9 / issue #1035: `&StaticMethod` produces a managed
        // function-pointer value (CIL `ldftn`). The operand binds to a method
        // group; we accept a single static, non-generic user function and
        // synthesise its managed function-pointer type from the signature.
        if operand is BoundMethodGroupExpression methodGroup {
            if !binderCtx.InUnsafeContext {
                Diagnostics.ReportFunctionPointerAddressOfMismatch(
                    syntax.OperatorToken.Location,
                    "taking the address of a method as a function pointer requires an 'unsafe' context"
                )
                return BoundErrorExpression(nil)
            }
            if methodGroup.Candidates.Length != 1 || methodGroup.Function == nil {
                Diagnostics.ReportFunctionPointerAddressOfMismatch(
                    syntax.OperatorToken.Location,
                    "the method is overloaded; '&Method' requires a single, unambiguous method"
                )
                return BoundErrorExpression(nil)
            }
            let target = methodGroup.Function
            if methodGroup.Receiver != nil || target!!.IsInstanceMethod {
                Diagnostics.ReportFunctionPointerAddressOfMismatch(
                    syntax.OperatorToken.Location,
                    "only a static or free function can be taken as a function pointer (instance methods are not supported)"
                )
                return BoundErrorExpression(nil)
            }
            if target!!.IsGeneric {
                Diagnostics.ReportFunctionPointerAddressOfMismatch(
                    syntax.OperatorToken.Location,
                    "a generic method cannot be taken as a function pointer"
                )
                return BoundErrorExpression(nil)
            }
            // Issue #2067: `&Foo.Private` (method-group-to-delegate /
            // function-pointer conversion) must enforce the declaring
            // struct's `protected`/`private` accessibility the same way
            // BindUserInstanceCall does for regular calls (issue #2058) —
            // this is a separate binder path (ldftn), so it needs its own gate.
            if target!!.StaticOwnerType is StructSymbol methodDeclaringType && !AccessibilityChecker.IsAccessible(
                target!!.Accessibility,
                methodDeclaringType,
                getCurrentFunction()
            ) {
                Diagnostics.ReportMemberInaccessible(
                    syntax.OperatorToken.Location,
                    target!!.Name,
                    methodDeclaringType.Name,
                    target!!.Accessibility
                )
            }
            let fpParamTypes = ImmutableArray.CreateBuilder[TypeSymbol](target!!.Parameters.Length)
            for p in target!!.Parameters {
                fpParamTypes.Add(p.Type)
            }
            let fpType = FunctionPointerTypeSymbol.GetManaged(
                fpParamTypes.MoveToImmutable(),
                target!!.Type ?? TypeSymbol.Void
            )
            return BoundFunctionPointerFromMethodExpression(nil, target!!, fpType)
        }
        // GS9005: cannot take address of a constant binding. General block
        // expressions preserve the trailing lvalue's mutability contract.
        if TryGetReadOnlyAddressTarget(operand, out var readOnlyVariable) {
            // ADR-0060: address-of an `in` parameter would let callers write
            // through the pointer, defeating the read-only contract. Report
            // GS0237 instead of the generic "cannot take address of constant".
            if readOnlyVariable is ParameterSymbol inParam && inParam.RefKind == RefKind.In {
                Diagnostics.ReportCannotAssignToInParameter(syntax.OperatorToken.Location, inParam.Name)
            } else {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.OperatorToken.Location, readOnlyVariable.Name)
            }
            return BoundErrorExpression(nil)
        }
        // Lvalue check.
        if RefCapabilities.IsReadOnlyStorage(operand) {
            Diagnostics.ReportCannotTakeAddressOfConstant(syntax.OperatorToken.Location, syntax.Operand.ToString())
            return BoundErrorExpression(nil)
        }
        if !IsLvalue(operand) {
            let exprText = syntax.Operand.ToString()
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.OperatorToken.Location, exprText)
            return BoundErrorExpression(nil)
        }
        return BoundAddressOfExpression(nil, operand, unmanaged: binderCtx.InUnsafeContext)
    }

    /// ADR-0039: Binds `*expr` — dereferences a managed pointer.
    private func BindDereferenceExpression(syntax UnaryExpressionSyntax) BoundExpression {
        // ADR-0122 §3 / issue #1033: `*void(expr)` is the cast to the
        // void-element pointer `*void` (the form cs2gs emits for a C#
        // `(void*)expr`, mirroring the `*uint8(p)` ≡ `(byte*)p` form). Because
        // `void` cannot bind as a value-producing conversion call, recognise
        // the syntactic shape `* void ( expr )` directly and reinterpret it as
        // a cast to `*void`. Handled before binding the operand so it is never
        // mistaken for a (rejected) dereference of a `*void` value.
        if binderCtx.InUnsafeContext &&
            syntax.Operand is CallExpressionSyntax voidCast &&
            voidCast
            .Identifier
            .Kind == SyntaxKind.IdentifierToken &&
            voidCast
            .Identifier
            .ValueText == "void" &&
            voidCast.TypeArgumentList == nil &&
            voidCast.NullableQuestionToken == nil &&
            voidCast
            .Arguments
            .Count == 1 {
            return conversions.BindConversion(
                voidCast.Arguments[0],
                PointerTypeSymbol.Get(TypeSymbol.Void),
                allowExplicit: true
            )
        }
        // ADR-0122 §4 / issue #1034: `*Point(expr)` is the cast to a pointer to
        // a blittable user struct `*Point` — the struct analogue of the
        // primitive `*uint8(p)` cast and the `*void(p)` form. Because a struct
        // type name binds as a construction/conversion call rather than a
        // numeric conversion, recognise the syntactic shape `* IDENT ( expr )`
        // where IDENT names a blittable value struct in scope, and reinterpret
        // it as a cast to `*Struct`. Restricted to a pointer / native-int
        // argument so an ordinary struct construction `Point(x)` is unaffected.
        if binderCtx.InUnsafeContext &&
            syntax.Operand is CallExpressionSyntax structCast &&
            structCast
            .Identifier
            .Kind == SyntaxKind.IdentifierToken &&
            structCast.TypeArgumentList == nil &&
            structCast.NullableQuestionToken == nil &&
            structCast
            .Arguments
            .Count == 1 &&
            lookupType(structCast.Identifier.ValueText) is {} castTarget &&
            BlittableDetector
            .IsBlittableValueStructPointee(castTarget) {
            let castArg = BindExpression(structCast.Arguments[0])
            if castArg.Type is PointerTypeSymbol ||
                castArg.Type == TypeSymbol.NInt ||
                castArg.Type == TypeSymbol.NUInt ||
                castArg.Type == TypeSymbol.Int64 ||
                castArg.Type == TypeSymbol.UInt64 {
                return BoundConversionExpression(nil, PointerTypeSymbol.Get(castTarget), castArg)
            }
        }
        let operand = BindExpression(syntax.Operand)
        if operand is BoundErrorExpression {
            return operand
        }
        // ADR-0122 / issue #1014: inside an unsafe context, `*<type>(expr)`
        // (e.g. `*uint8(p)`, the form cs2gs emits for a C# `(byte*)p` cast)
        // parses as a dereference of a conversion-call. Reinterpret it as a
        // *cast* to the unmanaged pointer type `*T`: reuse the inner operand of
        // the conversion (so we do NOT truncate, e.g. an `nint` to a byte) and
        // retarget it to `*T`. This never masks a real dereference — a value
        // produced by a numeric conversion is never a pointer.
        //
        // Issue #1925: the cast-recognition below must only fire for the
        // actual `* IDENT ( expr )` cast syntax, not for an arbitrary operand
        // that merely *binds* to a BoundConversionExpression. Pointer
        // arithmetic (`p + i`) lowers to a BoundConversionExpression back to
        // the pointer type (see LowerPointerOffset), so a genuine dereference
        // of a parenthesized pointer-arithmetic expression like `*(p + i)`
        // also binds its operand to a BoundConversionExpression whose Type is
        // the pointer type `*T` — without a syntax-shape guard this was
        // mistaken for a `*T(expr)` cast and rewrapped as `**T`.
        if binderCtx.InUnsafeContext &&
            syntax.Operand is CallExpressionSyntax &&
            operand is BoundConversionExpression conv &&
            conv.Type is {} pointee &&
            (TypeSymbol.IsLegalPointeeType(pointee) || BlittableDetector.IsBlittableValueStructPointee(pointee)) {
            return BoundConversionExpression(nil, PointerTypeSymbol.Get(pointee), conv.Expression)
        }
        // ADR-0122 §3 / issue #1033: a true `*void` pointer carries no element
        // type and cannot be dereferenced directly; it must first be cast to a
        // typed pointer `*T` (e.g. `*int32(p)`).
        if TypeSymbol.IsVoidPointer(operand.Type) {
            Diagnostics.ReportVoidPointerOperationNotAllowed(syntax.OperatorToken.Location, "dereference")
            return BoundErrorExpression(nil)
        }
        if ManagedReferenceTypes.TryGetElement(operand.Type, out _, out _) {
            let borrow = BorrowManagedReference(operand, syntax)
            return if borrow is BoundErrorExpression {
                borrow
            } else {
                cast[BoundExpression](BoundDereferenceExpression(syntax, borrow))
            }
        }
        if !TypeSymbol.TryGetPointeeType(operand.Type, out _) {
            Diagnostics.ReportUndefinedUnaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                operand.Type
            )
            return BoundErrorExpression(nil)
        }
        return BoundDereferenceExpression(nil, operand)
    }

    /// ADR-0122 / issues #1014 and #3286: lowers unmanaged-pointer arithmetic
    /// and native pointer comparisons. Returns `null` when the
    /// operator/operand shape is not a supported pointer operation, so the
    /// caller falls back to the normal (error-reporting) path.
    /// @param syntax The binary expression syntax.
    /// @param left The bound left operand.
    /// @param right The bound right operand.
    /// @returns The lowered bound expression, or `null`.
    private func TryBindPointerBinaryExpression(
        syntax BinaryExpressionSyntax,
        left BoundExpression,
        right BoundExpression
    ) BoundExpression? -> TryBindPointerBinaryOperation(
        syntax.OperatorToken.Kind,
        syntax.OperatorToken.Location,
        left,
        right
    )

    /// ADR-0122 / issue #1014: lowers a pointer arithmetic or comparison
    /// operation given the base operator token kind (not tied to a
    /// (cref:BinaryExpressionSyntax)), so that both the binary form
    /// `p + i` and the compound-assignment form `p += i` (issue
    /// #2175) share the SAME pointer lowering. Returns `null`
    /// when the operator/operand shape is not a supported pointer operation.
    /// @param operatorKind The base binary operator token kind.
    /// @param operatorLocation The source location used for diagnostics.
    /// @param left The bound left operand.
    /// @param right The bound right operand.
    /// @returns The lowered bound expression, or `null`.
    private func TryBindPointerBinaryOperation(
        operatorKind SyntaxKind,
        operatorLocation TextLocation,
        left BoundExpression,
        right BoundExpression
    ) BoundExpression? {
        let leftPtr PointerTypeSymbol? = left.Type as PointerTypeSymbol
        let rightPtr PointerTypeSymbol? = right.Type as PointerTypeSymbol
        switch operatorKind {
            case SyntaxKind.PlusToken {
                // ADR-0122 §3 / issue #1033: a `*void` pointer has no element
                // size, so it cannot be advanced by arithmetic. Reject with
                // GS0403 (cast to a typed pointer `*T` first).
                if TypeSymbol.IsVoidPointer(left.Type) || TypeSymbol.IsVoidPointer(right.Type) {
                    Diagnostics.ReportVoidPointerOperationNotAllowed(operatorLocation, "perform arithmetic on")
                    return BoundErrorExpression(nil)
                }
                if leftPtr != nil && rightPtr == nil && IsPointerOffsetType(right.Type) {
                    return LowerPointerOffset(left, leftPtr, right, subtract: false)
                }
                if rightPtr != nil && leftPtr == nil && IsPointerOffsetType(left.Type) {
                    return LowerPointerOffset(right, rightPtr, left, subtract: false)
                }
                return nil
            }
            case SyntaxKind.MinusToken {
                // ADR-0122 §3 / issue #1033: pointer offset (`p - i`) and
                // pointer difference (`p - q`) both require a known element
                // size, so a `*void` operand is rejected (GS0403).
                if TypeSymbol.IsVoidPointer(left.Type) || TypeSymbol.IsVoidPointer(right.Type) {
                    Diagnostics.ReportVoidPointerOperationNotAllowed(operatorLocation, "perform arithmetic on")
                    return BoundErrorExpression(nil)
                }
                if leftPtr != nil && rightPtr == nil && IsPointerOffsetType(right.Type) {
                    return LowerPointerOffset(left, leftPtr, right, subtract: true)
                }
                // ADR-0122 / issue #1032: pointer difference `p - q` for two
                // operands of the SAME pointer type `*T` yields the scaled
                // element count as `nint`: ((nint)p - (nint)q) / sizeof(T).
                // Mismatched pointer types `*T - *U` fall through to the
                // normal error path (GS0129), matching C#.
                if leftPtr != nil && rightPtr != nil && leftPtr.PointeeType == rightPtr.PointeeType {
                    return LowerPointerDifference(left, right, leftPtr)
                }
                return nil
            }
            case SyntaxKind.EqualsEqualsToken,
            SyntaxKind.BangEqualsToken,
            SyntaxKind.LessToken,
            SyntaxKind.LessOrEqualsToken,
            SyntaxKind.GreaterToken,
            SyntaxKind.GreaterOrEqualsToken {
                return LowerPointerComparison(operatorKind, left, right)
            }
            default {
                return nil
            }
        }
    }

    private func LowerPointerOffset(
        pointer BoundExpression,
        pointerType PointerTypeSymbol,
        offset BoundExpression,
        subtract bool
    ) BoundExpression {
        let sizeExpr = PointeeSizeAsNint(pointerType.PointeeType, out var isOne)
        let offsetNint = if offset.Type == TypeSymbol.NInt {
            offset
        } else {
            cast[BoundExpression](BoundConversionExpression(nil, TypeSymbol.NInt, offset))
        }
        var scaled = offsetNint
        if !isOne {
            let mulOp = Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.StarToken, TypeSymbol.NInt, TypeSymbol.NInt),
                "native-int multiplication is a built-in operator",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.StarToken, TypeSymbol.NInt, TypeSymbol.NInt)"
            )
            scaled = BoundBinaryExpression(nil, offsetNint, mulOp, sizeExpr)
        }
        let pointerNint = BoundConversionExpression(nil, TypeSymbol.NInt, pointer)
        let addKind = if subtract {
            SyntaxKind.MinusToken
        } else {
            SyntaxKind.PlusToken
        }
        let addOp = Invariant.Required(
            BoundBinaryOperator.Bind(addKind, TypeSymbol.NInt, TypeSymbol.NInt),
            "native-int addition is a built-in operator",
            expression: "BoundBinaryOperator.Bind(addKind, TypeSymbol.NInt, TypeSymbol.NInt)"
        )
        let resultNint = BoundBinaryExpression(nil, pointerNint, addOp, scaled)
        return BoundConversionExpression(nil, pointerType, resultNint)
    }

    /// ADR-0122 / issue #1032: lowers a pointer difference `p - q` (both
    /// operands the same unmanaged pointer type `*T`) to the scaled
    /// element count as (cref:TypeSymbol.NInt):
    /// `((nint)p - (nint)q) / sizeof(T)`. Both pointers are native-int
    /// sized, so the byte difference is a signed `nint` subtraction and
    /// the divide by the static pointee size is a signed integer division,
    /// matching the C# `T*` difference semantics.
    /// @param left The bound left pointer operand.
    /// @param right The bound right pointer operand.
    /// @param pointerType The common pointer type `*T`.
    /// @returns The lowered `nint` element-count expression.
    private func LowerPointerDifference(
        left BoundExpression,
        right BoundExpression,
        pointerType PointerTypeSymbol
    ) BoundExpression {
        let leftNint = BoundConversionExpression(nil, TypeSymbol.NInt, left)
        let rightNint = BoundConversionExpression(nil, TypeSymbol.NInt, right)
        let subOp = Invariant.Required(
            BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.NInt, TypeSymbol.NInt),
            "native-int subtraction is a built-in operator",
            expression: "BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.NInt, TypeSymbol.NInt)"
        )
        let byteDiff = BoundBinaryExpression(nil, leftNint, subOp, rightNint)
        let sizeExpr = PointeeSizeAsNint(pointerType.PointeeType, out var isOne)
        if isOne {
            return byteDiff
        }
        let divOp = Invariant.Required(
            BoundBinaryOperator.Bind(SyntaxKind.SlashToken, TypeSymbol.NInt, TypeSymbol.NInt),
            "native-int division is a built-in operator",
            expression: "BoundBinaryOperator.Bind(SyntaxKind.SlashToken, TypeSymbol.NInt, TypeSymbol.NInt)"
        )
        return BoundBinaryExpression(nil, byteDiff, divOp, sizeExpr)
    }

    private func LowerPointerComparison(
        operatorKind SyntaxKind,
        left BoundExpression,
        right BoundExpression
    ) BoundExpression? {
        if !CanLowerPointerComparisonOperand(left.Type) || !CanLowerPointerComparisonOperand(right.Type) {
            return nil
        }
        let pointerType = if left.Type == TypeSymbol.Null {
            right.Type
        } else {
            left.Type
        }
        let leftNint = ToNativeIntForPointerComparison(left, pointerType)
        let rightNint = ToNativeIntForPointerComparison(right, pointerType)
        let op BoundBinaryOperator? = BoundBinaryOperator.Bind(operatorKind, TypeSymbol.NInt, TypeSymbol.NInt)
        if op == nil {
            return nil
        }
        return BoundBinaryExpression(nil, leftNint, op, rightNint)
    }

    private func ToNativeIntForPointerComparison(operand BoundExpression, pointerType TypeSymbol) BoundExpression {
        if operand.Type == TypeSymbol.NInt {
            return operand
        }
        // `nil` becomes a null pointer (zero native int) before the comparison.
        if operand.Type == TypeSymbol.Null {
            let nullPointer = BoundConversionExpression(nil, pointerType, operand)
            return BoundConversionExpression(nil, TypeSymbol.NInt, nullPointer)
        }
        return BoundConversionExpression(nil, TypeSymbol.NInt, operand)
    }

    /// Issue #1018: binds a throw-expression `throw expr` in value position to a
    /// (cref:BoundThrowExpression) whose static type is the bottom
    /// ((cref:TypeSymbol.Never)) type. The thrown operand is validated to
    /// be a `System.Exception` (or derived), mirroring the throw-statement's
    /// existing rule ((cref:StatementBinder)).
    private func BindThrowExpression(syntax ThrowExpressionSyntax) BoundExpression {
        let expression = BindExpression(syntax.Expression)
        if expression is BoundErrorExpression {
            return BoundErrorExpression(nil)
        }
        let exceptionType TypeSymbol? = ResolveExceptionType()
        if exceptionType != nil && expression.Type != TypeSymbol.Error {
            var argClr Type? = expression.Type?.ClrType
            // Issue #319: a GSharp class that inherits an imported CLR Exception
            // type has no concrete ClrType until emit time; walk its
            // ImportedBaseType transitively to determine assignability.
            if argClr == nil && expression.Type is StructSymbol throwStruct {
                for t in throwStruct.GetHierarchy() {
                    if t.ImportedBaseType?.ClrType is Type clrBase {
                        argClr = clrBase
                        break
                    }
                }
            }
            if argClr == nil || !ClrTypeUtilities.IsAssignableByName(exceptionType.ClrType, argClr) {
                Diagnostics.ReportCannotConvert(
                    syntax.Expression.Location,
                    expression.Type ?? TypeSymbol.Error,
                    exceptionType
                )
                return BoundErrorExpression(nil)
            }
        }
        return BoundThrowExpression(nil, expression)
    }

    /// Issue #1018: resolves the `System.Exception` type symbol used to
    /// validate the operand of a throw-expression. Mirrors
    /// (cref:StatementBinder.ResolveExceptionType).
    private func ResolveExceptionType() TypeSymbol? {
        if $scope.References!!.TryResolveType("System.Exception", out var t) {
            return TypeSymbol.FromClrTypeWithoutNullability(t, NullabilityFreeReason.TypeLiteral)
        }
        return nil
    }

    private func BindConditionalExpression(
        syntax ConditionalExpressionSyntax
    ) BoundExpression -> BindConditionalExpression(syntax, targetType: nil)

    private func BindConditionalExpression(syntax ConditionalExpressionSyntax, targetType TypeSymbol?) BoundExpression {
        // Issue #1238: when this conditional is a bare call/constructor argument
        // whose target parameter type is not yet known, the argument-binding
        // loop set DeferTargetlessConditional so a no-common-type unification
        // failure (e.g. a `nil`/narrower arm that needs the parameter's nullable
        // type to widen) is deferred rather than reported here. Consume the flag
        // immediately so nested sub-expressions bind with normal semantics.
        let deferOnFailure = targetType == nil && binderCtx.DeferTargetlessConditional
        this.binderCtx.DeferTargetlessConditional = false
        let diagMark = Diagnostics.Count
        let condition = BindExpression(syntax.Condition, TypeSymbol.Bool)
        // ADR-0100 / issue #795: a bare `default` branch takes its type
        // from the sibling branch. Bind whichever branch is typed first so
        // we have a concrete target type for the bare default. When both
        // branches are bare `default` the common type is unknown and the
        // expression is invalid.
        let trueIsBareDefault = syntax.WhenTrue is DefaultExpressionSyntax tDef && tDef.TypeClause == nil
        let falseIsBareDefault = syntax.WhenFalse is DefaultExpressionSyntax fDef && fDef.TypeClause == nil
        // Issue #4964: each branch is bound under the same smart-cast frames
        // the equivalent if-expression uses (`s != nil ? s.Length : 0`), so
        // the two conditional forms narrow identically.
        let (whenTrueNarrowing, whenFalseNarrowing) = ClassifyConditionalNarrowing(condition)
        // ADR-0166: each branch sees the pattern variables the condition
        // definitely assigns on that branch (`x is T t ? t.Name : "none"`).
        let (patternWhenTrue, patternWhenFalse) = PatternVariables.Classify(condition)
        let bindWhenTrue = func (branchTargetType TypeSymbol?) BoundExpression {
            return BindWithPatternVariables(
                patternWhenTrue,
                () -> {
                    return BindExpressionWithNarrowing(syntax.WhenTrue, whenTrueNarrowing, branchTargetType)
                }
            )
        }
        let bindWhenFalse = func (branchTargetType TypeSymbol?) BoundExpression {
            return BindWithPatternVariables(
                patternWhenFalse,
                () -> {
                    return BindExpressionWithNarrowing(syntax.WhenFalse, whenFalseNarrowing, branchTargetType)
                }
            )
        }
        var whenTrue BoundExpression
        var whenFalse BoundExpression
        if targetType != nil {
            whenTrue = bindWhenTrue(targetType)
            whenFalse = bindWhenFalse(targetType)
        } else if trueIsBareDefault && falseIsBareDefault {
            Diagnostics.ReportBareDefaultNoTargetType(
                (cast[DefaultExpressionSyntax](syntax.WhenTrue)).DefaultKeyword.Location
            )
            return BoundErrorExpression(nil)
        } else if trueIsBareDefault {
            whenFalse = bindWhenFalse(nil)
            if whenFalse is BoundErrorExpression {
                return BoundErrorExpression(nil)
            }
            whenTrue = BoundDefaultExpression(syntax.WhenTrue, whenFalse.Type)
        } else if falseIsBareDefault {
            whenTrue = bindWhenTrue(nil)
            if whenTrue is BoundErrorExpression {
                return BoundErrorExpression(nil)
            }
            whenFalse = BoundDefaultExpression(syntax.WhenFalse, whenTrue.Type)
        } else {
            whenTrue = bindWhenTrue(nil)
            whenFalse = bindWhenFalse(nil)
        }
        if condition is BoundErrorExpression || whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression {
            return BoundErrorExpression(nil)
        }
        TryAdaptConditionalIntegerLiteralArm(&whenTrue, &whenFalse)
        let resultType TypeSymbol? = ComputeConditionalResultType(whenTrue.Type, whenFalse.Type, targetType)
        if resultType == nil {
            if deferOnFailure {
                Diagnostics.TruncateTo(diagMark)
                return BoundErrorExpression(syntax)
            }
            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?"
            )
            return BoundErrorExpression(nil)
        }
        let convertedTrue = ConvertConditionalBranch(syntax.WhenTrue.Location, whenTrue, resultType)
        let convertedFalse = ConvertConditionalBranch(syntax.WhenFalse.Location, whenFalse, resultType)
        if convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression {
            if deferOnFailure {
                Diagnostics.TruncateTo(diagMark)
                return BoundErrorExpression(syntax)
            }
            return BoundErrorExpression(nil)
        }
        return BoundConditionalExpression(nil, condition, convertedTrue, convertedFalse, resultType)
    }

    /// Issue #669: binds an if-expression to a (cref:BoundConditionalExpression)
    /// (the same bound node used by the ternary operator). Multi-statement blocks
    /// are lowered to (cref:BoundBlockExpression) wrapping the final value.
    private func BindIfExpression(syntax IfExpressionSyntax) BoundExpression -> BindIfExpression(
        syntax,
        targetType: nil,
        canBeVoid: false
    )

    private func BindIfExpression(
        syntax IfExpressionSyntax,
        targetType TypeSymbol?,
        canBeVoid bool = false
    ) BoundExpression {
        // A tail if/else in a discarded lambda/statement position may have
        // void call or await arms; value-producing contexts keep the default.
        // Issue #1238: defer a no-common-type unification failure when this
        // if-expression is a bare argument awaiting its parameter target type
        // (see BindConditionalExpression for the full rationale). Consume the
        // flag immediately so nested sub-expressions bind normally.
        let deferOnFailure = targetType == nil && binderCtx.DeferTargetlessConditional
        this.binderCtx.DeferTargetlessConditional = false
        let diagMark = Diagnostics.Count
        // An if-expression in value position must have an else branch.
        // Issue #4966 §2 (ADR-0202): where the value is discarded (`canBeVoid`:
        // a void arrow body, a lambda body, an expression statement) there is
        // no value to produce, so an `if` without `else` is the void `if`,
        // exactly as the equivalent block body's if statement is.
        let elseSyntax = syntax.ElseExpression
        if elseSyntax == nil && !canBeVoid {
            Diagnostics.ReportIfExpressionMissingElse(syntax.IfKeyword.Location)
            return BoundErrorExpression(nil)
        }
        if syntax.Initializer is not StatementSyntax initializer {
            return BindIfExpressionBranches(syntax, targetType, canBeVoid, deferOnFailure, diagMark)
        }
        // Issue #4962: `if init; cond { … } else { … }` scopes the initializer
        // exactly as BindIfStatement does for the statement form. It is
        // visible in the condition and in every branch, including an
        // `else if` chain, and not after the expression. It runs once, before
        // the condition:
        //   { init; cond ? then : else }
        return BindInBlockExpressionScope(
            () -> {
                let (statements, value) = BindStatementsBeforeValue(
                    ImmutableArray.Create[StatementSyntax](initializer),
                    syntax,
                    () -> BindIfExpressionBranches(syntax, targetType, canBeVoid, deferOnFailure, diagMark)
                )
                if value is BoundErrorExpression {
                    return value
                }
                return BoundBlockExpression(nil, statements, value)
            }
        )
    }

    /// Binds the condition and branches of an if-expression, after any
    /// initializer is in scope.
    /// @param syntax The if-expression.
    /// @param targetType The contextual target type, or `null`.
    /// @param canBeVoid Whether the branches may be void (a discarded tail).
    /// @param deferOnFailure Whether a no-common-type failure is deferred for overload resolution
    /// (issue #1238).
    /// @param diagMark The diagnostic count to truncate to when deferring.
    /// @returns The bound conditional, or an error expression.
    private func BindIfExpressionBranches(
        syntax IfExpressionSyntax,
        targetType TypeSymbol?,
        canBeVoid bool,
        deferOnFailure bool,
        diagMark int32
    ) BoundExpression {
        // Issue #4966 (ADR-0202): nil only for the void `if` of a discarded
        // position; BindIfExpression rejects it elsewhere (GS0276).
        let elseSyntax = syntax.ElseExpression
        let condition = BindExpression(syntax.Condition, TypeSymbol.Bool)
        let (whenTrueNarrowing, whenFalseNarrowing) = ClassifyConditionalNarrowing(condition)
        // ADR-0166: each arm also sees the pattern variables the condition
        // definitely assigns on that arm.
        let (patternWhenTrue, patternWhenFalse) = PatternVariables.Classify(condition)
        let bindWhenTrue() -> BoundExpression = () -> {
            return BindBlockExpressionValue(syntax.ThenBlock, canBeVoid, targetType)
        }
        let bindWhenFalse() -> BoundExpression = () -> {
            return if elseSyntax == nil {
                cast[BoundExpression](BoundLiteralExpression(syntax, value: 0, TypeSymbol.Void))
            } else {
                BindIfExpressionElseBranch(elseSyntax, canBeVoid, targetType)
            }
        }
        let bindWhenTrueNarrowed() -> BoundExpression = () -> {
            return BindWithNarrowing(whenTrueNarrowing, bindWhenTrue)
        }
        let bindWhenFalseNarrowed() -> BoundExpression = () -> {
            return BindWithNarrowing(whenFalseNarrowing, bindWhenFalse)
        }
        var whenTrue = BindWithPatternVariables(patternWhenTrue, bindWhenTrueNarrowed)
        var whenFalse = BindWithPatternVariables(patternWhenFalse, bindWhenFalseNarrowed)
        if condition is BoundErrorExpression || whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression {
            return BoundErrorExpression(nil)
        }
        if elseSyntax == nil || IsVoidInDiscardedPosition(canBeVoid, []BoundExpression{whenTrue, whenFalse}) {
            // The void `if` (see above and IsVoidInDiscardedPosition): branch
            // values, if any, are discarded like an if statement's.
            return BoundConditionalExpression(
                nil,
                condition,
                DiscardValue(whenTrue),
                DiscardValue(whenFalse),
                TypeSymbol.Void
            )
        }
        TryAdaptConditionalIntegerLiteralArm(&whenTrue, &whenFalse)
        let resultType TypeSymbol? = ComputeConditionalResultType(whenTrue.Type, whenFalse.Type, targetType)
        if resultType == nil {
            if deferOnFailure {
                Diagnostics.TruncateTo(diagMark)
                return BoundErrorExpression(syntax)
            }
            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?"
            )
            return BoundErrorExpression(nil)
        }
        let convertedTrue = ConvertConditionalBranch(syntax.ThenBlock.Location, whenTrue, resultType)
        let convertedFalse = ConvertConditionalBranch(elseSyntax.Location, whenFalse, resultType)
        if convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression {
            if deferOnFailure {
                Diagnostics.TruncateTo(diagMark)
                return BoundErrorExpression(syntax)
            }
            return BoundErrorExpression(nil)
        }
        return BoundConditionalExpression(nil, condition, convertedTrue, convertedFalse, resultType)
    }

    /// Issue #4966 (ADR-0202): the one rule for an if-, if-let- or
    /// switch-expression in a position whose value may be discarded
    /// ([`canBeVoid`](paramref): an expression statement, a void arrow body,
    /// a lambda body). When any branch is void there is no common value, so
    /// the construct is the void one — its statement form's meaning — and
    /// the other branches' values are discarded. (Without this, `if c {
    /// list.Remove(x) } else { list.Clear() }` in a void lambda reported
    /// GS0263 although the identical if statement compiles.) Branches that
    /// all produce values keep their common type, so a lambda whose body ends
    /// in such an if/else still returns it (ADR-0128).
    /// @param canBeVoid Whether the position may be void.
    /// @param branches The bound branch values.
    /// @returns `true` when the construct is the void one.
    private func IsVoidInDiscardedPosition(canBeVoid bool, branches IEnumerable[BoundExpression]) bool {
        if !canBeVoid {
            return false
        }
        for branch in branches {
            if branch.Type == TypeSymbol.Void {
                return true
            }
        }
        return false
    }

    /// Issue #4966 (ADR-0202): reports GS0362 for each unresolved bare
    /// `default` placeholder that [`value`](paramref) yields — the value itself,
    /// a block expression's tail, a conditional's branch or a switch arm, recursively.
    /// @param value The value of a discarded position.
    /// @returns `true` when any was reported.
    private func ReportUnresolvedBareDefaults(value BoundExpression?) bool {
        switch value {
            case BoundDefaultExpression{
                Type: var defaultType,
                Syntax: DefaultExpressionSyntax bareDefault
            } when defaultType ==
            TypeSymbol.Error && bareDefault.TypeClause == nil {
                Diagnostics.ReportBareDefaultNoTargetType(bareDefault.Location)
                return true
            }
            case block is BoundBlockExpression {
                return ReportUnresolvedBareDefaults(block.Expression)
            }
            case conditional is BoundConditionalExpression {
                let inTrue = ReportUnresolvedBareDefaults(conditional.WhenTrue)
                let inFalse = ReportUnresolvedBareDefaults(conditional.WhenFalse)
                return inTrue || inFalse
            }
            case switchExpression is BoundSwitchExpression {
                var reported = false
                for arm in switchExpression.Arms {
                    reported = ReportUnresolvedBareDefaults(arm.Result) || reported
                }
                return reported
            }
            default {
                return false
            }
        }
    }

    /// Issue #4966 (ADR-0202): turns [`value`](paramref) into a void
    /// expression for a position whose value is discarded (the void `if`, a
    /// void switch-expression arm). A void or never-typed value is returned as
    /// is; any other value is evaluated as an expression statement.
    private func DiscardValue(value BoundExpression) BoundExpression {
        // A bare `default` takes its type from a target, and a discarded
        // position has none: report it rather than leave the untyped
        // placeholder to the emitter (GS0362, as for any targetless `default`),
        // also when it is the tail of a block or a branch inside the value.
        if ReportUnresolvedBareDefaults(value) {
            return BoundErrorExpression(nil)
        }
        if value.Type == TypeSymbol.Void || value.Type == TypeSymbol.Never || value.Type == TypeSymbol.Error {
            return value
        }
        return BoundBlockExpression(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, value)),
            BoundLiteralExpression(nil, value: 0, TypeSymbol.Void)
        )
    }

    /// Binds the else branch of an if-expression: either a nested if-expression
    /// (`else if` chain) or a block expression.
    private func BindIfExpressionElseBranch(
        elseSyntax ExpressionSyntax,
        canBeVoid bool = false,
        targetType TypeSymbol? = nil
    ) BoundExpression {
        if elseSyntax is IfExpressionSyntax nestedIf {
            return BindIfExpression(nestedIf, targetType, canBeVoid)
        }
        // ADR-0151: `… else if let a = e { … } else { … }` chains a plain
        // if-expression into the binding form (and vice versa, via
        // BindIfLetElseBranch), so both else-branch binders accept both kinds.
        if elseSyntax is IfLetExpressionSyntax nestedIfLet {
            return BindIfLetExpression(nestedIfLet, targetType, canBeVoid)
        }
        if elseSyntax is BlockExpressionSyntax block {
            return BindBlockExpressionValue(block, canBeVoid, targetType)
        }
        // Should not happen from well-formed parse trees.
        return BoundErrorExpression(nil)
    }

    private func BindWithNarrowing(
        narrowing Dictionary[AccessPath, TypeSymbol]?,
        bind() -> BoundExpression
    ) BoundExpression {
        if narrowing == nil {
            return bind()
        }
        binderCtx.PushNarrowingFrame(narrowing)
        try {
            return bind()
        } finally {
            binderCtx.EndNarrowingProof()
        }
    }

    /// Binds a block-with-trailing-expression in value position. If the block
    /// has no trailing expression, reports a diagnostic. The result is either
    /// the bound trailing expression (when there are no prefix statements), or
    /// a (cref:BoundBlockExpression) wrapping the prefix statements and
    /// the trailing value.
    private func BindBlockExpressionParts(
        statements ImmutableArray[StatementSyntax],
        expression ExpressionSyntax,
        canBeVoid bool,
        targetType TypeSymbol? = nil
    )(Statements ImmutableArray[BoundStatement], Expression BoundExpression) {
        let BindTrailingExpression = func () BoundExpression {
            return if targetType == nil {
                BindExpression(expression, canBeVoid)
            } else {
                BindExpression(expression, targetType)
            }
        }
        return BindStatementsBeforeValue(statements, expression, BindTrailingExpression)
    }

    /// Binds [`statements`](paramref) in order and then, with their
    /// declarations still in scope, the value produced by
    /// [`bindValue`](paramref). A block expression's tail and an
    /// if-expression's initializer (issue #4962) both use it, so the prefix
    /// statements of either bind exactly like the statements of a block.
    /// @param statements The prefix statements.
    /// @param valueSyntax The syntax the synthesized nodes for the value are attributed to.
    /// @param bindValue Binds the value after the prefix statements.
    /// @returns The bound prefix statements and the bound value.
    private func BindStatementsBeforeValue(
        statements ImmutableArray[StatementSyntax],
        valueSyntax ExpressionSyntax,
        bindValue() -> BoundExpression
    )(Statements ImmutableArray[BoundStatement], Expression BoundExpression) {
        if !statements.Any(
            (statement StatementSyntax) -> statement is UsingStatementSyntax ||
                statement is AwaitUsingStatementSyntax ||
                statement is DeferStatementSyntax
        ) {
            var fastBoundExpression BoundExpression? = nil
            var sentinel BoundStatement? = nil
            var fastBoundStatements = bindStatementList(
                statements,
                () -> {
                    fastBoundExpression = bindValue()
                    sentinel = BoundExpressionStatement(nil, BoundLiteralExpression(nil, value: 0, TypeSymbol.Void))
                    return sentinel
                }
            )
            if sentinel != nil && fastBoundStatements.Length > 0 && object.ReferenceEquals(
                fastBoundStatements[^1],
                sentinel
            ) {
                fastBoundStatements = fastBoundStatements.RemoveAt(fastBoundStatements.Length - 1)
            }
            return (
                fastBoundStatements,
                Invariant.Required(
                    fastBoundExpression,
                    "a block trailing expression was bound by the statement-list callback",
                    expression: "fastBoundExpression"
                )
            )
        }
        var boundExpression BoundExpression? = nil
        var result VariableSymbol? = nil
        let bindTrailingStatement() -> BoundStatement = () -> {
            var value = bindValue()
            // Cleanup replaces a tail with a result-local read. Diagnose an
            // unresolved value before that replacement hides its defaults.
            if value.Type == TypeSymbol.Error && ReportUnresolvedBareDefaults(value) {
                value = BoundErrorExpression(nil)
            }
            boundExpression = value
            // Issue #4965 (ADR-0202): a `never` tail (every path exits) has no
            // value to keep across the cleanup region either.
            if value is BoundErrorExpression || value.Type == TypeSymbol.Void || value.Type == TypeSymbol.Never {
                return BoundExpressionStatement(valueSyntax, value)
            }
            let resultVariable = LocalVariableSymbol(
                "<blockResult${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: true,
                value.Type ?? TypeSymbol.Error
            )
            result = resultVariable
            $scope.TryDeclareVariable(resultVariable)
            return BoundVariableDeclaration(valueSyntax, resultVariable, value)
        }
        let boundStatements = bindStatementList(statements, bindTrailingStatement)
        let resultExpression = if result != nil {
            cast[BoundExpression](BoundVariableExpression(valueSyntax, result))
        } else {
            (
                if boundExpression is BoundErrorExpression {
                    boundExpression
                } else if boundExpression?.Type == TypeSymbol.Never {
                    // The unreachable value after the exiting tail (see
                    // BindValuelessBlockExpression).
                    cast[BoundExpression](BoundThrowExpression(nil, BoundLiteralExpression(nil, value: nil)))
                } else {
                    cast[BoundExpression](BoundLiteralExpression(valueSyntax, value: 0, TypeSymbol.Void))
                }
            )
        }
        return (boundStatements, resultExpression)
    }

    private func BindBlockExpressionValue(
        syntax BlockExpressionSyntax,
        canBeVoid bool = false,
        targetType TypeSymbol? = nil,
        preserveEmptyBlock bool = false
    ) BoundExpression -> BindInBlockExpressionScope(
        () -> {
            return BindBlockExpressionValueCore(syntax, canBeVoid, targetType, preserveEmptyBlock)
        }
    )

    private func BindBlockExpressionValueCore(
        syntax BlockExpressionSyntax,
        canBeVoid bool,
        targetType TypeSymbol?,
        preserveEmptyBlock bool
    ) BoundExpression {
        if syntax.Expression == nil {
            return BindValuelessBlockExpression(syntax, canBeVoid)
        }
        // If there are no prefix statements, just bind the expression directly.
        if syntax.Statements.IsDefaultOrEmpty {
            let expression = if targetType == nil {
                BindExpression(syntax.Expression!!, canBeVoid)
            } else {
                BindExpression(syntax.Expression!!, targetType)
            }
            return if preserveEmptyBlock && !(expression is BoundErrorExpression) {
                cast[BoundExpression](BoundBlockExpression(syntax, ImmutableArray[BoundStatement].Empty, expression))
            } else {
                expression
            }
        }
        // Bind prefix statements.
        let (boundStatements, boundExpression) = BindBlockExpressionParts(
            syntax.Statements,
            Invariant.Required(
                syntax.Expression,
                "a block value has a trailing expression",
                expression: "syntax.Expression"
            ),
            canBeVoid,
            targetType
        )
        if IsDeferredBranchyArgumentPlaceholder(boundExpression, out _) {
            return BoundErrorExpression(syntax)
        }
        if boundExpression is BoundErrorExpression {
            return boundExpression
        }
        return BoundBlockExpression(syntax, boundStatements, boundExpression)
    }

    /// Issue #4965 / #4966 (ADR-0202): binds a block expression that has no
    /// trailing value. Two cases need no value, and they are the only ones:
    ///
    /// - The block's end is unreachable — it ends in `return`, `throw`,
    ///   `rethrow`, `break`, `continue` or `goto` (see
    ///   (cref:StatementBinder.BlockEndIsUnreachable)). Its type is then the
    ///   bottom type `never`, exactly like a throw expression's, so it unifies
    ///   with any sibling branch, arm or target type. Its never-produced value
    ///   is an unreachable `throw nil` trap after the exiting statement, which
    ///   every later stage already understands as a throw expression.
    /// - The block is in a position whose value is discarded
    ///   ([`canBeVoid`](paramref): an expression statement, a void arrow body,
    ///   a lambda body), where it is a void block, as the equivalent block
    ///   statement is.
    ///
    /// Anything else still reports GS0277.
    private func BindValuelessBlockExpression(syntax BlockExpressionSyntax, canBeVoid bool) BoundExpression {
        let statements = if syntax.Statements.IsDefaultOrEmpty {
            ImmutableArray[BoundStatement].Empty
        } else {
            bindStatementList(syntax.Statements, nil)
        }
        if StatementBinder.BlockEndIsUnreachable(statements) {
            let unreachableValue = BoundThrowExpression(nil, BoundLiteralExpression(nil, value: nil))
            return BoundBlockExpression(syntax, statements, unreachableValue)
        }
        if canBeVoid {
            return BoundBlockExpression(syntax, statements, BoundLiteralExpression(syntax, value: 0, TypeSymbol.Void))
        }
        Diagnostics.ReportBlockExpressionMissingTrailingExpression(syntax.CloseBraceToken.Location)
        return BoundErrorExpression(nil)
    }

    private func BindInBlockExpressionScope(bind() -> BoundExpression) BoundExpression {
        $scope = BoundScope($scope)
        try {
            return bind()
        } finally {
            $scope = $scope.Pop()
        }
    }

    /// ADR-0074 / issue #714: binds the body of an arrow lambda
    /// `(p T) -> body`. The body is either a single expression
    /// (returned as the lambda's value) or a brace-delimited block
    /// expression. Unlike (cref:BindBlockExpressionValue), a block
    /// body without a trailing expression is permitted — it produces a
    /// (cref:TypeSymbol.Void)-returning lambda.
    /// @param bodySyntax The lambda body syntax.
    /// @param targetType Optional contextual return type for a nested
    /// lambda used directly as the body or trailing block expression.
    /// @returns The bound body expression. (cref:TypeSymbol.Void) is
    /// allowed; a missing-trailing-expression block lowers to a
    /// (cref:BoundBlockExpression) whose trailing expression is a
    /// synthesized (cref:BoundLiteralExpression) placeholder of type
    /// (cref:TypeSymbol.Void).
    internal func BindLambdaBodyExpression(bodySyntax ExpressionSyntax, targetType TypeSymbol? = nil) BoundExpression {
        if bodySyntax is BlockExpressionSyntax block {
            let trailingTarget = if block.Expression != nil && IsNestedLambdaExpression(block.Expression) {
                targetType
            } else {
                default(TypeSymbol?)
            }
            return BindInBlockExpressionScope(
                () -> {
                    return BindLambdaBlockBodyExpression(block, trailingTarget)
                }
            )
        }
        return if targetType == nil || !IsNestedLambdaExpression(bodySyntax) {
            BindExpression(bodySyntax, canBeVoid: true)
        } else {
            BindExpression(bodySyntax, targetType)
        }
    }

    private func BindLambdaBlockBodyExpression(block BlockExpressionSyntax, targetType TypeSymbol?) BoundExpression {
        // Lambda body block: a missing trailing expression means a void
        // lambda. Bind any prefix statements; if there is a trailing
        // expression, use it as the value; otherwise the value is void.
        if block.Expression == nil {
            let voidStatements = if block.Statements.IsDefaultOrEmpty {
                ImmutableArray[BoundStatement].Empty
            } else {
                bindStatementList(block.Statements, nil)
            }
            if voidStatements.Length == 0 {
                return BoundLiteralExpression(block, value: 0, TypeSymbol.Void)
            }
            return BoundBlockExpression(block, voidStatements, BoundLiteralExpression(block, value: 0, TypeSymbol.Void))
        }
        let (boundStatements, trailing) = BindBlockExpressionParts(
            block.Statements,
            Invariant.Required(
                block.Expression,
                "a value-returning lambda block has a trailing expression",
                expression: "block.Expression"
            ),
            canBeVoid: true,
            targetType
        )
        if boundStatements.Length == 0 {
            return trailing
        }
        return BoundBlockExpression(block, boundStatements, trailing)
    }

    /// Issue #1232: value-producing if/conditional ergonomics. When exactly one
    /// branch is a compile-time constant integer literal and the OTHER branch is
    /// a (non-literal) integer-typed expression, adapt the literal to that
    /// integer type when its value is representable there — mirroring the
    /// constant-integer-literal adaptation that `BindBinaryExpression`
    /// performs for binary operands (#1144). This lets idiomatic forms such as
    /// `if cond { someUint32 } else { 0 }` (and the equivalent
    /// `cond ? someUint32 : 0`) unify on the wider arm's type without an
    /// explicit cast on the `0`, exactly as C# does. An out-of-range literal
    /// is left unchanged so the no-common-type path still reports GS0263.
    private func TryAdaptConditionalIntegerLiteralArm(ref whenTrue BoundExpression, ref whenFalse BoundExpression) {
        if whenTrue is BoundLiteralExpression trueLit &&
            IsIntegerLiteralValue(trueLit.Value) &&
            !(whenFalse is BoundLiteralExpression) &&
            IsIntegerType(whenFalse.Type) &&
            TryAdaptIntegerLiteral(trueLit.Value, whenFalse.Type, out var adaptedTrue) {
            whenTrue = BoundLiteralExpression(whenTrue.Syntax, adaptedTrue)
        } else if whenFalse is BoundLiteralExpression falseLit &&
            IsIntegerLiteralValue(falseLit.Value) &&
            !(whenTrue is BoundLiteralExpression) &&
            IsIntegerType(whenTrue.Type) &&
            TryAdaptIntegerLiteral(falseLit.Value, whenTrue.Type, out var adaptedFalse) {
            whenFalse = BoundLiteralExpression(whenFalse.Syntax, adaptedFalse)
        }
    }

    private func ConvertConditionalBranch(
        location TextLocation,
        branch BoundExpression,
        target TypeSymbol?
    ) BoundExpression {
        // Issue #1496: a bare `default` arm is bound to a placeholder
        // `BoundDefaultExpression(syntax, TypeSymbol.Error)` (see
        // BindDefaultExpression) that must acquire the concrete conditional
        // result type before emit. The `?:` path pre-types this from the
        // sibling arm, but the if-expression path (BindIfExpression) does not,
        // so the placeholder would otherwise reach the early-out below and
        // surface to the emitter as an `Error`-typed node — which emits a
        // bogus `ldnull` instead of a zero-initialized value of the merge
        // target (`initobj` for value types / type parameters / nullable open
        // generics). Materialise it against the computed merge target here so
        // BOTH `if` and `?:` (and any future caller) are covered. This runs
        // before the `branch.Type == TypeSymbol.Error` early-out, which is kept
        // for genuine error cascades where `target` is itself Error/Void.
        if branch is BoundDefaultExpression bareDefault &&
            bareDefault.Type == TypeSymbol.Error &&
            target != nil &&
            target != TypeSymbol.Error &&
            target != TypeSymbol.Void {
            return BoundDefaultExpression(bareDefault.Syntax, target)
        }
        if target == TypeSymbol.Error || branch.Type == TypeSymbol.Error {
            return branch
        }
        // Issue #1018: a throw-expression branch (bottom `never` type) is left
        // as-is — it produces no value to convert, and the emitter leaves the
        // merge point unreachable from this branch.
        if branch.Type == TypeSymbol.Never {
            return branch
        }
        if object.ReferenceEquals(branch.Type, target) {
            return branch
        }
        return conversions.BindConversion(
            location,
            branch,
            Invariant.Required(target, "a conditional branch has a result type", expression: "target")
        )
    }

    private func BindChannelReceiveExpression(syntax UnaryExpressionSyntax) BoundExpression {
        // ADR-0174 D1/D3: `<-ch` lowers to ChannelOps.Receive<T>(ch, default) —
        // the element's zero value on a closed channel, delivered without an
        // exception. The operand may be any channel-shaped handle (D2's matrix);
        // a send-only `out chan[T]` cannot be received from (GS0550).
        var operand = BindExpression(syntax.Operand)
        if operand is BoundErrorExpression {
            return operand
        }
        // ADR-0186 §4: a receive requires a non-null channel, so a platform
        // operand is checked (and unwrapped) here, like any other receiver.
        operand = binderCtx.InsertPlatformCheck(operand, syntax.Operand.Location, "a channel receive operand")
        if !ChannelTypeSymbol.TryGetChannelShape(operand.Type, out var elementType, out var direction, out _) {
            Diagnostics.ReportReceiveOperandIsNotChannel(syntax.Operand.Location, operand.Type)
            return BoundErrorExpression(nil)
        }
        if direction == ChannelDirection.Out {
            Diagnostics.ReportReceiveFromSendOnlyChannel(syntax.OperatorToken.Location, operand.Type)
            return BoundErrorExpression(nil)
        }
        if !EnsureChannelRuntime(syntax.OperatorToken.Location) {
            return BoundErrorExpression(nil)
        }
        return binderCtx.ChannelRuntime.BindReceive(syntax, operand, elementType, direction, binderCtx.AmbientContext())
    }

    /// ADR-0174 D1: every channel operation lowers onto `Gsharp.Runtime.Channels`;
    /// when that assembly is not in the reference set the construct cannot be
    /// emitted, and the existing target-framework diagnostic names the missing type.
    /// @param location Where to anchor the diagnostic.
    /// @returns `true` when the runtime is available.
    internal func EnsureChannelRuntime(location TextLocation) bool {
        if binderCtx.ChannelRuntime.IsAvailable {
            return true
        }
        Diagnostics.ReportTargetFrameworkMemberUnavailable(location, ChannelRuntimeBinder.ChanTypeName)
        return false
    }

    private func BindBinaryExpression(syntax BinaryExpressionSyntax) BoundExpression -> BindBinaryExpression(
        syntax,
        coalesceTargetType: nil
    )

    private func BindBinaryExpression(syntax BinaryExpressionSyntax, coalesceTargetType TypeSymbol?) BoundExpression {
        // Issue #1480: when a `??` argument has no contextual target type and the
        // overload binder requested deferral (DeferTargetlessConditional), a
        // no-common-type failure is parked as a placeholder retaining the syntax
        // rather than reported, then re-bound once the parameter type is known.
        // Consume the flag immediately so nested sub-expressions bind normally.
        let deferTargetlessCoalesce = syntax
            .OperatorToken
            .Kind == SyntaxKind.QuestionQuestionToken &&
            coalesceTargetType == nil &&
            binderCtx.DeferTargetlessConditional
        if syntax.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken {
            this.binderCtx.DeferTargetlessConditional = false
        }
        let coalesceDiagMark = Diagnostics.Count
        var boundLeft = if coalesceTargetType != nil &&
            syntax
            .OperatorToken
            .Kind == SyntaxKind.QuestionQuestionToken &&
            IsTargetDependentExpressionSyntax(syntax.Left) {
            BindExpression(syntax.Left, coalesceTargetType)
        } else {
            BindExpression(syntax.Left)
        }
        // ADR-0069 / issue #700: `&&` short-circuits — the right operand is
        // only evaluated when the left operand was true. Thread any
        // narrowing implied by the left operand into the right-operand
        // binder so `x is T && f(x)` binds `f(x)` with `x` narrowed to `T`.
        //
        // ADR-0069 addendum / issue #712: `||` short-circuits too — the
        // right operand is only evaluated when the left operand was false.
        // Thread the left's else-frame (its negative narrowing) so
        // `!(x is T) || f(x)` binds `f(x)` with `x` narrowed to `T`.
        //
        // ADR-0166: the same short-circuit regions scope pattern variables —
        // `x is T t && t.Length > 0` binds `t.Length` with `t` in scope, and
        // `!(x is T t) || t.Length > 0` likewise through the negation.
        var boundRight BoundExpression
        if syntax.OperatorToken.Kind == SyntaxKind.AmpersandAmpersandToken {
            let rightFrame = TryClassifyTypeTestNarrowingForAnd(boundLeft)
            let (leftWhenTrue, _) = PatternVariables.Classify(boundLeft)
            boundRight = BindWithPatternVariables(
                leftWhenTrue,
                () -> {
                    return BindExpressionWithNarrowing(syntax.Right, rightFrame)
                }
            )
            ReportDuplicatePatternVariables(PatternVariables.Classify(boundRight).WhenTrue, leftWhenTrue)
        } else if syntax.OperatorToken.Kind == SyntaxKind.PipePipeToken {
            let rightFrame = TryClassifyTypeTestNarrowingForOr(boundLeft)
            let (_, leftWhenFalse) = PatternVariables.Classify(boundLeft)
            boundRight = BindWithPatternVariables(
                leftWhenFalse,
                () -> {
                    return BindExpressionWithNarrowing(syntax.Right, rightFrame)
                }
            )
            ReportDuplicatePatternVariables(PatternVariables.Classify(boundRight).WhenFalse, leftWhenFalse)
        } else if coalesceTargetType != nil &&
            syntax
            .OperatorToken
            .Kind == SyntaxKind.QuestionQuestionToken &&
            IsTargetDependentExpressionSyntax(syntax.Right) {
            boundRight = BindExpression(syntax.Right, coalesceTargetType)
        } else {
            boundRight = BindExpression(syntax.Right)
        }
        if syntax
            .OperatorToken
            .Kind == SyntaxKind.PlusToken &&
            boundLeft is BoundUtf8StringExpression leftUtf8 &&
            boundRight is BoundUtf8StringExpression rightUtf8 &&
            SyntaxFacts.IsUtf8LiteralRepresentation(syntax.Left) && SyntaxFacts.IsUtf8LiteralRepresentation(
            syntax.Right
        ) {
            if leftUtf8.Bytes.Length > int32.MaxValue - 1 - rightUtf8.Bytes.Length {
                Diagnostics.ReportInvalidUtf8StringLiteral(syntax.Location, "The combined backing data is too large.")
                return BoundErrorExpression(syntax)
            }
            return BoundUtf8StringExpression(
                syntax,
                leftUtf8.Bytes.AddRange(rightUtf8.Bytes),
                leftUtf8.Type,
                leftUtf8.CreateSpan,
                leftUtf8.Slice
            )
        }
        if boundLeft.Type == TypeSymbol.Error || boundRight.Type == TypeSymbol.Error {
            if TryBindDelegateCombinationOperator(
                syntax.OperatorToken.Kind,
                &boundLeft,
                &boundRight,
                syntax.Left.Location,
                syntax.Right.Location,
                out var delegateOperator
            ) {
                return BoundBinaryExpression(
                    nil,
                    boundLeft,
                    Invariant.Required(
                        delegateOperator,
                        "a successful delegate bind produces an operator",
                        expression: "delegateOperator"
                    ),
                    boundRight
                )
            }
            return BoundErrorExpression(nil)
        }
        let nativeEqualityLeftType = if boundLeft.Type is NullableTypeSymbol nullableNativeLeft {
            nullableNativeLeft.UnderlyingType
        } else {
            boundLeft.Type
        }
        let nativeEqualityRightType = if boundRight.Type is NullableTypeSymbol nullableNativeRight {
            nullableNativeRight.UnderlyingType
        } else {
            boundRight.Type
        }
        if (
            ManagedReferenceTypes.TryGetElement(nativeEqualityLeftType, out _, out _) &&
                !ManagedReferenceTypes.IsCompatible(nativeEqualityLeftType.ClrType)
        ) ||
            (
            ManagedReferenceTypes.TryGetElement(nativeEqualityRightType, out _, out _) &&
                !ManagedReferenceTypes.IsCompatible(nativeEqualityRightType.ClrType)
        ) {
            Diagnostics.ReportManagedReference(
                syntax.Location,
                "reference the matching Gsharp.Runtime.Values runtime; the managed-reference ABI is incompatible"
            )
            return BoundErrorExpression(syntax)
        }
        if (syntax.OperatorToken.Kind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken) &&
            ManagedReferenceTypes.TryGetElement(nativeEqualityLeftType, out _, out var leftReadOnlyManaged) &&
            ManagedReferenceTypes
            .TryGetElement(nativeEqualityRightType, out _, out var rightReadOnlyManaged) {
            if leftReadOnlyManaged != rightReadOnlyManaged || ManagedReferenceTypes.HaveIncompatibleElements(
                nativeEqualityLeftType,
                nativeEqualityRightType
            ) {
                Diagnostics.ReportManagedReference(
                    syntax.OperatorToken.Location,
                    "location equality requires identical referent permissions and type; use SameLocation to compare permissions"
                )
                return BoundErrorExpression(syntax)
            }
            let name = if syntax.OperatorToken.Kind == SyntaxKind.EqualsEqualsToken {
                "op_Equality"
            } else {
                "op_Inequality"
            }
            let method = Invariant.Required(
                Invariant.Required(
                    nativeEqualityLeftType.ClrType,
                    "managed handles have a CLR type",
                    expression: "nativeEqualityLeftType.ClrType"
                )
                    .GetMethod(name),
                "the runtime declares location equality",
                expression: "Invariant.Required(nativeEqualityLeftType.ClrType, \"managed handles have a CLR type\").GetMethod(name)"
            )
            return BoundClrBinaryOperatorExpression(
                syntax,
                syntax.OperatorToken.Kind,
                boundLeft,
                boundRight,
                method,
                TypeSymbol.Bool
            )
        }
        if (syntax.OperatorToken.Kind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken) &&
            NativeSliceTypes.TryGetElement(nativeEqualityLeftType, out _, out var leftReadOnly) &&
            NativeSliceTypes
            .TryGetElement(nativeEqualityRightType, out _, out var rightReadOnly) {
            if leftReadOnly != rightReadOnly || NativeSliceTypes.HaveIncompatibleElements(
                nativeEqualityLeftType,
                nativeEqualityRightType
            ) {
                Diagnostics.ReportUndefinedBinaryOperator(
                    syntax.OperatorToken.Location,
                    syntax.OperatorToken.Text,
                    boundLeft.Type,
                    boundRight.Type
                )
                return BoundErrorExpression(syntax)
            }
            let methodName = if syntax.OperatorToken.Kind == SyntaxKind.EqualsEqualsToken {
                "op_Equality"
            } else {
                "op_Inequality"
            }
            let clrType = Invariant.Required(
                nativeEqualityLeftType.ClrType,
                "the enclosing TryGetElement success establishes the native CLR type",
                expression: "nativeEqualityLeftType.ClrType"
            )
            let method = Invariant.Required(
                clrType.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static),
                "TryGetElement selects the SDK Slice/ReadOnlySlice definition, whose ABI declares both equality operators",
                expression: "clrType.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static)"
            )
            TryLiftNullableClrOperatorOperands(
                syntax.OperatorToken.Kind,
                &boundLeft,
                &boundRight,
                syntax.Left.Location,
                syntax.Right.Location,
                nativeEqualityLeftType,
                nativeEqualityLeftType,
                TypeSymbol.Bool,
                hasByRefSignature: false,
                out _
            )
            return BoundClrBinaryOperatorExpression(
                syntax,
                syntax.OperatorToken.Kind,
                boundLeft,
                boundRight,
                method,
                TypeSymbol.Bool
            )
        }
        // ADR-0122 / issue #1014: pointer arithmetic (`p + i`, `i + p`, `p - i`)
        // and pointer comparison (`==`, `!=`, `<`, …) inside an unsafe context.
        // Lowered to native-int (`nint`) arithmetic/comparison plus pointer
        // reinterpret conversions — no dedicated bound node is required.
        if (boundLeft.Type is PointerTypeSymbol or FunctionPointerTypeSymbol) ||
            (boundRight.Type is PointerTypeSymbol or FunctionPointerTypeSymbol) {
            let pointerResult BoundExpression? = TryBindPointerBinaryExpression(syntax, boundLeft, boundRight)
            if pointerResult != nil {
                return pointerResult
            }
        }
        if (
            syntax
                .OperatorToken
                .Kind == SyntaxKind.EqualsEqualsToken ||
                syntax
                .OperatorToken
                .Kind == SyntaxKind.BangEqualsToken
        ) &&
            (
            (boundRight.Type == TypeSymbol.Null && IsExplicitlyNonNullImportedResult(boundLeft)) ||
                (boundLeft.Type == TypeSymbol.Null && IsExplicitlyNonNullImportedResult(boundRight))
        ) {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                boundLeft.Type,
                boundRight.Type
            )
            return BoundErrorExpression(nil)
        }
        // Issue #3501 / ADR-0171: tuple `==` / `!=` desugars to element-wise
        // comparison. Tuples never match the built-in table or a user
        // `operator` (the structural tuple type cannot declare one), so this
        // arm short-circuits the whole chain. One tuple against a non-tuple
        // deliberately falls through (→ GS0129).
        if ((syntax.OperatorToken.Kind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken)) &&
            boundLeft.Type is TupleTypeSymbol &&
            boundRight.Type is TupleTypeSymbol {
            return BindTupleEquality(syntax, boundLeft, boundRight)
        }
        var boundOperator BoundBinaryOperator? = BindBinaryOperatorWithNumericAdaptation(
            syntax.OperatorToken.Kind,
            &boundLeft,
            &boundRight,
            syntax.Left.Location,
            syntax.Right.Location
        )
        // Issue #1480: target-typed null-coalescing. When `a ?? b` has no natural
        // common operand type (so the standard bind produced no operator) but the
        // consuming context supplies a target type both operands implicitly
        // convert to (e.g. sibling classes `A`/`B` each implementing `IShape`,
        // coalesced where an `IShape` is expected), synthesize a NullCoalesce
        // operator whose result is the target type. The operand conversions to
        // the target are inserted by the NullCoalesce tail below; the emitter's
        // interface-merge cast (#1480) realigns each branch's stack type.
        if boundOperator == nil &&
            syntax
            .OperatorToken
            .Kind == SyntaxKind.QuestionQuestionToken &&
            TryBindTargetTypedNullCoalesce(boundLeft, boundRight, coalesceTargetType, out var targetTypedCoalesce) {
            boundOperator = targetTypedCoalesce
        }
        if boundOperator == nil {
            // Streams D + C: user-defined `operator` methods then CLR `op_*`
            // methods, shared with the compound-assignment path (issue #1554).
            let fallback BoundExpression? = TryBindBinaryWithUserAndClrFallback(
                syntax.OperatorToken.Kind,
                &boundLeft,
                &boundRight,
                syntax.Left.Location,
                syntax.Right.Location,
                out var ambiguous
            )
            if fallback != nil {
                return fallback
            }
            if ambiguous {
                Diagnostics.ReportAmbiguousOverload(
                    syntax.OperatorToken.Location,
                    syntax.OperatorToken.Text,
                    candidateCount: 2
                )
                return BoundErrorExpression(nil)
            }
            // Issue #1480: a `??` whose operands share no natural common type and
            // has no contextual target is deferred (rather than reported as
            // GS0129) when it is a bare call/constructor argument awaiting its
            // parameter type — the argument-binding loop set
            // DeferTargetlessConditional. The retained syntax is re-bound with
            // the parameter type as its target by FinalizeBranchyArgument.
            if deferTargetlessCoalesce {
                Diagnostics.TruncateTo(coalesceDiagMark)
                return BoundErrorExpression(syntax)
            }
            // Issue #2188: reference equality (`==` / `!=`) between two reference
            // types the built-in table's homogeneous arms did not cover — e.g. a
            // nullable reference (`object?`, `string?`, `T?`), a base/interface
            // reference, or a reference-constrained type parameter (`[T class …]`)
            // against another reference. Both operands compare by reference
            // identity, exactly as `object == object` does. This is tried LAST —
            // after built-in, user-defined, and CLR `op_*` resolution — so a
            // user-declared `operator ==` on a reference type always takes
            // precedence. Value-type operands (whose `T?` erases to
            // `Nullable<T>`) are excluded, so an unconstrained or
            // `struct`-constrained `T?` still reports GS0129.
            if (
                syntax
                    .OperatorToken
                    .Kind == SyntaxKind.EqualsEqualsToken ||
                    syntax
                    .OperatorToken
                    .Kind == SyntaxKind.BangEqualsToken
            ) &&
                BoundBinaryOperator.IsReferenceEqualityOperand(boundLeft.Type) &&
                BoundBinaryOperator
                .IsReferenceEqualityOperand(boundRight.Type) {
                let referenceOperator = BoundBinaryOperator.MakeReferenceEquality(
                    syntax.OperatorToken.Kind,
                    boundLeft.Type,
                    boundRight.Type
                )
                return BoundBinaryExpression(nil, boundLeft, referenceOperator, boundRight, binderCtx.IsCheckedContext)
            }
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                boundLeft.Type,
                boundRight.Type
            )
            return BoundErrorExpression(nil)
        }
        // Issue #1239 / C# §12.15: when `??` computes a best common type that
        // differs from the right operand's type (a reference upcast / interface
        // implementation or a numeric widening), insert the implicit conversion
        // on the right operand so both branches of the coalesce leave a value of
        // the operator's result type. The left operand's non-null value is
        // converted to the result type by the emitter / evaluator when the
        // result widened the left's underlying numeric type (e.g.
        // `int32? ?? int64` → `int64`); reference upcasts need no IL conversion
        // because they are representation-preserving.
        if boundOperator.Kind == BoundBinaryOperatorKind.NullCoalesce &&
            (boundRight is BoundMethodGroupExpression || boundRight is BoundClrMethodGroupExpression) {
            // Issue #4065: even when the natural method-group type is already
            // identical to the coalesce result, the left delegate operand is
            // the contextual target that makes the right group a value.
            boundRight = conversions.BindConversion(syntax.Right.Location, boundRight, boundOperator.Type)
        } else if boundOperator.Kind == BoundBinaryOperatorKind.NullCoalesce &&
            boundRight.Type != boundOperator.Type &&
            boundRight.Type != TypeSymbol.Never {
            boundRight = conversions.BindConversion(syntax.Right.Location, boundRight, boundOperator.Type)
        }
        // Issue #3317 / ADR-0159: with sound empty-instance zero values, a nil
        // comparison whose non-nil operand's STATIC type is a bare (non-`?`)
        // magic collection type — `map[K, V]`, `[]T`, `[N]T`, or `chan T`
        // (which GS0520 forces to be explicitly initialized) — is statically
        // constant: `== nil` is always false, `!= nil` always true. Warn
        // (GS0523) so dead checks (typically Go porting artifacts) surface;
        // `?`-typed slots and interop values surfaced as `T?` are the
        // comparison's real use case and never match the bare-type test.
        // v1 scope decisions (documented in docs/diagnostics.md):
        //   * static-type-based only, keyed on the DECLARED type — an operand
        //     smart-cast from `T?` to `T` (a narrowed read) does not warn, so
        //     the redundant-re-check nuance is left as a future refinement;
        //   * `sequence[T]` is excluded — its nil comparison predates ADR-0159
        //     (#796) and bare sequence values commonly cross interop
        //     boundaries;
        //   * the ADR-0159 explicit `= default` honesty clause can
        //     reintroduce nil into a bare slot (issue #3319 closed the
        //     other former corner — a bare struct-typed local's own
        //     magic-collection fields); warning severity (suppressible via
        //     /nowarn:GS0523) is the accepted trade for that corner.
        if (boundOperator.Kind is BoundBinaryOperatorKind.Equals or BoundBinaryOperatorKind.NotEquals) {
            let nilCompareOperand BoundExpression? = if boundRight.Type == TypeSymbol.Null &&
                boundLeft.Type != TypeSymbol.Null {
                boundLeft
            } else {
                (
                    if boundLeft.Type == TypeSymbol.Null && boundRight.Type != TypeSymbol.Null {
                        boundRight
                    } else {
                        default(BoundExpression?)
                    }
                )
            }
            if nilCompareOperand != nil && IsBareMagicCollectionNilCompareOperand(nilCompareOperand) {
                Diagnostics.ReportNilComparisonAlwaysConstant(
                    syntax.Location,
                    nilCompareOperand.Type,
                    if boundOperator.Kind == BoundBinaryOperatorKind.Equals {
                        "false"
                    } else {
                        "true"
                    }
                )
            }
        }
        // Issue #3217: canonicalize a `nil` literal on the LEFT of `==` / `!=`
        // (`nil != x`) to the nil-on-right form (`x != nil`). The operator
        // table's null-compare arm binds both orders symmetrically, but the
        // entire downstream nil-comparison machinery — the lifted-slot
        // planner's Form 2 (`Nullable<T> op nil`), EmitLiftedNullableBinary,
        // and the user-enum / type-parameter nil arms — matches only the
        // nil-on-right shape, so a Null-typed LEFT operand fell through to
        // the emitter's generic `ceq` tail and produced unverifiable IL
        // (InvalidProgramException at runtime). Swapping is semantics-
        // preserving: equality is symmetric and the `nil` literal is a pure
        // constant, so the reordering of operand evaluation is unobservable.
        if (
            boundOperator.Kind == BoundBinaryOperatorKind.Equals ||
                boundOperator.Kind == BoundBinaryOperatorKind.NotEquals
        ) &&
            boundLeft.Type == TypeSymbol.Null &&
            boundRight.Type != TypeSymbol
            .Null {
            let mirrored BoundBinaryOperator? = BoundBinaryOperator.Bind(
                syntax.OperatorToken.Kind,
                boundRight.Type,
                boundLeft.Type
            )
            if mirrored != nil {
                boundLeft, boundRight = boundRight, boundLeft
                boundOperator = mirrored
            }
        }
        // Issue #1881: Sum/Difference/Product bound inside a `checked`
        // context trap on overflow; every other operator kind ignores the
        // flag (comparisons, bitwise ops, etc. never overflow-check).
        return BoundBinaryExpression(nil, boundLeft, boundOperator!!, boundRight, binderCtx.IsCheckedContext)
    }

    /// Issue #2388: when a Stream C/D binary operator resolves against a
    /// value-type operand that is (or should be) wrapped in a nullable
    /// `Nullable<T>` — either operand is already
    /// (cref:NullableTypeSymbol), or the OTHER operand is — lifts both
    /// operands up to a matching `Nullable<T>` (mixed-mode: the
    /// bare non-nullable side is wrapped) and computes the operator's lifted
    /// result type. Returns `false` when no lifting applies
    /// (plain non-nullable call site, unchanged behavior).
    /// @param opKind The operator token.
    /// @param left The bound left operand; replaced with its `Nullable<T>`-converted form when lifting
    /// applies.
    /// @param right The bound right operand; replaced with its `Nullable<T>`-converted form when lifting
    /// applies.
    /// @param leftLocation The left operand's source location (for the wrapping conversion).
    /// @param rightLocation The right operand's source location (for the wrapping conversion).
    /// @param leftParameterType The resolved operator's left parameter type.
    /// @param rightParameterType The resolved operator's right parameter type.
    /// @param naturalResultType The operator's own (non-lifted) result type.
    /// @param hasByRefSignature Whether any parameter or the return is passed by reference.
    /// @param liftedResultType The lifted result type: `bool` for comparisons,
    /// `Nullable<naturalResultType>` otherwise.
    /// @returns `true` when lifting applies and
    /// [`left`](paramref)/[`right`](paramref)/[`liftedResultType`](paramref) were updated.
    private func TryLiftNullableClrOperatorOperands(
        opKind SyntaxKind,
        ref left BoundExpression,
        ref right BoundExpression,
        leftLocation TextLocation,
        rightLocation TextLocation,
        leftParameterType TypeSymbol,
        rightParameterType TypeSymbol,
        naturalResultType TypeSymbol,
        hasByRefSignature bool,
        out liftedResultType TypeSymbol?
    ) bool {
        liftedResultType = nil
        // Issue #2399: use the canonical effective-storage predicate rather
        // than treating every Nullable<StructSymbol> as System.Nullable<T>.
        // StructSymbol also represents classes, whose `T?` is only a nullable
        // reference annotation; routing one through the lifted value-type
        // spill/HasValue pipeline produces invalid metadata/IL. The canonical
        // predicate includes CLR value types, same-compilation value structs,
        // and struct-constrained type parameters while excluding classes.
        let leftIsNullableValueType = left.Type is NullableTypeSymbol leftNullable &&
            NullableLifting.IsAnyValueTypeNullable(leftNullable)
        let rightIsNullableValueType = right.Type is NullableTypeSymbol rightNullable &&
            NullableLifting.IsAnyValueTypeNullable(rightNullable)
        if !leftIsNullableValueType && !rightIsNullableValueType {
            return false
        }
        // CLR lifting is defined only for by-value, non-nullable value-type
        // parameters. Comparisons must return bool; other operators must
        // return a by-value, non-nullable value type so their result can lift.
        if hasByRefSignature ||
            !IsNonNullableValueTypeOperatorSlot(leftParameterType) ||
            !IsNonNullableValueTypeOperatorSlot(rightParameterType) ||
            (
            if IsClrOperatorLiftedToBool(opKind) {
                naturalResultType != TypeSymbol.Bool
            } else {
                !IsNonNullableValueTypeOperatorSlot(naturalResultType)
            }
        ) {
            return false
        }
        // Issue #3518: lift to the resolved signature, not each operand's
        // original type; overload resolution may have selected numeric widening.
        let leftLiftedType = NullableTypeSymbol.Get(leftParameterType)
        let rightLiftedType = NullableTypeSymbol.Get(rightParameterType)
        left = conversions.BindConversion(leftLocation, left, leftLiftedType)
        right = conversions.BindConversion(rightLocation, right, rightLiftedType)
        liftedResultType = if IsClrOperatorLiftedToBool(opKind) {
            cast[TypeSymbol](TypeSymbol.Bool)
        } else {
            cast[TypeSymbol](NullableTypeSymbol.Get(naturalResultType))
        }
        return true
    }

    /// Issue #2834 / ADR-0035: resolves a user-defined compound-assignment
    /// operator (`func (b Bag) operator +=(n int32)` or the equivalent
    /// in-body `public func operator +=(n int32)`) for
    /// `target op= value` and produces the direct instance call
    /// `target.op_XxxAssignment(value)`.
    /// @remarks Unlike a binary operator, a compound-assignment operator is an
    /// INSTANCE, `void`-returning method that mutates the
    /// receiver in place — the same shape C# 14 uses, so the two languages
    /// consume each other's declarations. It is therefore never rewritten to
    /// `target = target op value`; the resolved call IS the assignment.
    ///
    /// Resolution is attempted BEFORE the built-in / binary-operator path so a
    /// type that declares both `operator +` and `operator +=` gets
    /// the in-place form for `+=`, matching C#. When the type declares no
    /// compound operator this returns `null` and the caller
    /// falls back to the ordinary `lhs = lhs op rhs` rewrite.
    /// @param compoundOperatorKind The compound-assignment token kind (`+=`, …).
    /// @param target The bound left-hand operand (the mutated receiver).
    /// @param value The bound right-hand operand.
    /// @param valueLocation The source location of the right-hand operand.
    /// @returns The bound in-place operator call, or `null` when none applies.
    private func TryBindUserCompoundAssignmentOperator(
        compoundOperatorKind SyntaxKind,
        target BoundExpression,
        value BoundExpression?,
        valueLocation TextLocation
    ) BoundExpression? {
        let operatorName string? = OperatorNames.TryGetCompoundAssignmentName(compoundOperatorKind)
        if operatorName == nil || target?.Type == nil || value == nil {
            return nil
        }
        // A `T?` receiver never gets the in-place operator: mutating through a
        // possibly-nil reference is exactly what `!!` exists to make explicit.
        if target.Type is not StructSymbol targetStruct {
            return nil
        }
        if !TypeMemberModel.TryGetMethodIncludingInherited(targetStruct, operatorName, out var op) ||
            op == nil ||
            op.IsStatic {
            return nil
        }
        // A receiver-clause declaration (`func (b Bag) operator +=(n int32)`)
        // carries its receiver in Parameters[0]; the in-body form does not.
        let parameterOffset = if op.ExplicitReceiverParameter == nil {
            0
        } else {
            1
        }
        if op.Parameters.Length != parameterOffset + 1 {
            return nil
        }
        let parameterType = targetStruct.SubstituteMemberType(op.Parameters[parameterOffset].Type) ??
            op
            .Parameters[parameterOffset]
            .Type
        if !Conversion.Classify(value.Type, parameterType).Exists {
            return nil
        }
        let convertedValue = conversions.BindConversion(valueLocation, value, parameterType)
        return BoundUserInstanceCallExpression(nil, target, op, ImmutableArray.Create(convertedValue), TypeSymbol.Void)
    }

    /// Issue #1554: shared fallback that resolves a binary operator via the
    /// user-defined operator path (Stream D) and then the CLR `op_*` path
    /// (Stream C), in that order, for both the plain binary expression
    /// (`lhs op rhs`) and the compound-assignment (`lhs op= rhs`)
    /// paths. It is invoked only after the built-in numeric operator has failed
    /// to bind, so that a compound assignment falls back to exactly the same
    /// user/BCL operator resolution that the equivalent binary expression uses.
    /// @param opKind The base binary operator token kind.
    /// @param left The bound left operand (adapted by the built-in attempt).
    /// @param right The bound right operand (adapted by the built-in attempt).
    /// @param leftLocation The source location of the left operand.
    /// @param rightLocation The source location of the right operand.
    /// @param ambiguous Set to `true` when CLR operator resolution found multiple equally-applicable
    /// candidates.
    /// @returns The bound user/CLR operator call, or `null` when neither resolves.
    private func TryBindBinaryWithUserAndClrFallback(
        opKind SyntaxKind,
        ref left BoundExpression,
        ref right BoundExpression,
        leftLocation TextLocation,
        rightLocation TextLocation,
        out ambiguous bool
    ) BoundExpression? {
        ambiguous = false
        // Stream D: try user-defined `func (a T) operator <op>(b U) R` on
        // either operand's user type. Issue #2377: the operator is a static,
        // SpecialName `op_*` method on the struct/class (StaticMethods),
        // NOT an instance method — the receiver clause is preserved only as
        // the operator's first formal parameter (Parameters[0], so binary ops
        // have Parameters.Length == 2 regardless of which operand declared
        // the operator).
        //
        // Issue #2388: the lookup unwraps a `Nullable<T>` operand to `T` so a
        // custom-equality struct's operator is found even when compared as
        // `T? == T?` — without the unwrap, `left.Type is StructSymbol` never
        // matches a `NullableTypeSymbol` and the comparison fell straight
        // through to an "operator undefined" diagnostic (GS0129).
        let userOpName string? = OperatorNames.TryGetBinaryName(opKind)
        if userOpName != nil {
            let leftStructType StructSymbol? = if left.Type is NullableTypeSymbol leftNullableForStruct {
                leftNullableForStruct.UnderlyingType as StructSymbol
            } else {
                left.Type as StructSymbol
            }
            let rightStructType StructSymbol? = if right.Type is NullableTypeSymbol rightNullableForStruct {
                rightNullableForStruct.UnderlyingType as StructSymbol
            } else {
                right.Type as StructSymbol
            }
            var userOp FunctionSymbol? = nil
            var userOpOwner StructSymbol? = nil
            if leftStructType != nil && TypeMemberModel.TryGetStaticMethodIncludingInherited(
                leftStructType,
                userOpName,
                out var leftOp,
                out var leftOwner
            ) {
                userOp = leftOp
                userOpOwner = leftOwner
            } else if rightStructType != nil && TypeMemberModel.TryGetStaticMethodIncludingInherited(
                rightStructType,
                userOpName,
                out var rightOp,
                out var rightOwner
            ) {
                userOp = rightOp
                userOpOwner = rightOwner
            } else if left.Type != nil && $scope.TryLookupExtensionFunction(left.Type, userOpName, out var leftExt) {
                userOp = leftExt
            } else if right.Type != nil && $scope.TryLookupExtensionFunction(right.Type, userOpName, out var rightExt) {
                userOp = rightExt
            }
            if userOp != nil && userOp.Parameters.Length == 2 {
                // Issue #2400: StaticMethods on a constructed generic struct
                // intentionally expose the definition's FunctionSymbol. Close
                // its parameter/result types in the declaring construction so
                // overload applicability and the bound call use Box[int32],
                // not the open Box[T] signature.
                let leftParameterType = userOpOwner?.SubstituteMemberType(userOp.Parameters[0].Type) ??
                    userOp
                    .Parameters[0]
                    .Type
                let rightParameterType = userOpOwner?.SubstituteMemberType(userOp.Parameters[1].Type) ??
                    userOp
                    .Parameters[1]
                    .Type
                let resultType = userOpOwner?.SubstituteMemberType(userOp.Type) ?? userOp.Type
                let hasByRefSignature = userOp.Parameters.Any((p ParameterSymbol) -> p.RefKind != RefKind.None) ||
                    userOp.ReturnRefKind != RefKind.None
                if CanApplyLiftedUserOperator(left.Type, leftParameterType) &&
                    CanApplyLiftedUserOperator(right.Type, rightParameterType) &&
                    TryLiftNullableClrOperatorOperands(
                    opKind,
                    &left,
                    &right,
                    leftLocation,
                    rightLocation,
                    leftParameterType,
                    rightParameterType,
                    resultType,
                    hasByRefSignature,
                    out var liftedResultType
                ) {
                    return BoundClrBinaryOperatorExpression(
                        nil,
                        opKind,
                        left,
                        right,
                        userOp,
                        userOpOwner,
                        Invariant.Required(
                            liftedResultType,
                            "a lifted operator has a result type",
                            expression: "liftedResultType"
                        )
                    )
                }
                if hasByRefSignature {
                    return nil
                }
                let convertedLeft = conversions.BindConversion(leftLocation, left, leftParameterType)
                let convertedRight = conversions.BindConversion(rightLocation, right, rightParameterType)
                return BoundCallExpression(
                    nil,
                    userOp,
                    ImmutableArray.Create(convertedLeft, convertedRight),
                    resultType
                ){
                    StaticGenericOwnerType = if userOpOwner != nil &&
                        (
                        !userOpOwner
                            .TypeArguments
                            .IsDefaultOrEmpty ||
                            !(userOpOwner.Definition ?? userOpOwner)
                            .TypeParameters
                            .IsDefaultOrEmpty
                    ) {
                        userOpOwner
                    } else {
                        default(StructSymbol?)
                    }
                }
            }
        }
        // Stream C: fall back to a public-static `op_*` method on either
        // operand's CLR type (TimeSpan + TimeSpan, BigInteger * int, ...).
        if (left.Type?.ClrType != nil || right.Type?.ClrType != nil) && ClrOperatorResolution.TryResolveBinary(
            opKind,
            left.Type,
            right.Type,
            out var clrMethod,
            out ambiguous
        ) {
            let clrParameters = clrMethod!!.GetParameters()
            let leftParameterType = ClrNullability.GetParameterTypeSymbol(clrParameters[0])
            let rightParameterType = ClrNullability.GetParameterTypeSymbol(clrParameters[1])
            let hasByRefSignature = clrParameters.Any((p ParameterInfo) -> p.ParameterType.IsByRef) ||
                clrMethod!!
                .ReturnType
                .IsByRef
            // Issue #2388: `ClrOperatorResolution` matches on
            // `TypeSymbol.ClrType`, which for a `NullableTypeSymbol` wrapping
            // a value type is already the UNDERLYING CLR type (see
            // `NullableTypeSymbol`'s constructor) — so this lookup "succeeds"
            // for `DateTime? == DateTime?` too, resolving
            // `DateTime.op_Equality(DateTime, DateTime)` even though the
            // bound operands remain `Nullable<DateTime>`-typed. Emitting
            // `EmitExpression(left); EmitExpression(right); call` then left a
            // `Nullable<T>` on the stack where the callee expects a bare `T`
            // — exactly the ilverify `StackUnexpected` this issue reports.
            // Detect that shape here and lift both operands (mixed-mode: wrap
            // a bare non-nullable side) so the emitter's lifted-binary slot
            // machinery (`LiftedBinarySlots` / `EmitLiftedNullableClrBinary`)
            // spills, HasValue-branches, and unwraps before calling the
            // resolved method — mirroring exactly how the built-in operator
            // table already lifts `int32? + int32?` et al.
            if TryLiftNullableClrOperatorOperands(
                opKind,
                &left,
                &right,
                leftLocation,
                rightLocation,
                leftParameterType,
                rightParameterType,
                ClrNullability.GetReturnTypeSymbol(clrMethod!!),
                hasByRefSignature,
                out var liftedClrResultType
            ) {
                return BoundClrBinaryOperatorExpression(
                    nil,
                    opKind,
                    left,
                    right,
                    clrMethod,
                    Invariant.Required(
                        liftedClrResultType,
                        "a lifted CLR operator has a result type",
                        expression: "liftedClrResultType"
                    )
                )
            }
            if hasByRefSignature {
                return nil
            }
            // Issue #3518: resolution considers every implicit conversion, so
            // materialize each one before emitting the resolved method call.
            // Keep CLR-compatible nil/reference-nullability shapes unchanged;
            // their language conversions intentionally are not implicit.
            var convertedLeft = left
            var convertedRight = right
            if !TryApplyClrOperatorOperandConversion(left, leftParameterType, leftLocation, out convertedLeft) ||
                !TryApplyClrOperatorOperandConversion(right, rightParameterType, rightLocation, out convertedRight) {
                return nil
            }
            left = convertedLeft
            right = convertedRight
            return BoundClrBinaryOperatorExpression(
                nil,
                opKind,
                left,
                right,
                clrMethod,
                ClrNullability.GetReturnTypeSymbol(clrMethod!!)
            )
        }
        return nil
    }

    private func TryApplyClrOperatorOperandConversion(
        operand BoundExpression,
        parameterType TypeSymbol,
        location TextLocation,
        out converted BoundExpression
    ) bool {
        converted = operand
        if parameterType is ByRefTypeSymbol {
            return false
        }
        if Conversion.Classify(operand.Type, parameterType).IsImplicit {
            converted = conversions.BindConversion(location, operand, parameterType)
            return !(converted is BoundErrorExpression)
        }
        let sourceIsValueNullable = operand.Type is NullableTypeSymbol sourceNullable &&
            NullableLifting.IsAnyValueTypeNullable(sourceNullable)
        let targetIsValueNullable = parameterType is NullableTypeSymbol targetNullable &&
            NullableLifting.IsAnyValueTypeNullable(targetNullable)
        if (!sourceIsValueNullable || targetIsValueNullable) &&
            ConversionClassifier
            .HasUserDefinedImplicitConversionForTypes(operand.Type, parameterType) {
            converted = conversions.BindConversion(location, operand, parameterType)
            return !(converted is BoundErrorExpression)
        }
        return (operand.Type == TypeSymbol.Null && Conversion.IsReferenceLikeTarget(parameterType)) ||
            TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(operand.Type, parameterType)
    }

    /// Issue #1480: attempts to bind a target-typed null-coalescing operator.
    /// Succeeds when a non-null contextual [`target`](paramref) is supplied
    /// and BOTH operands implicitly convert to it — the left operand's non-null
    /// underlying type and the right operand's type. This covers the C# §12.15
    /// target-typed case where the two operands share no natural common type but
    /// the result is consumed at a type both convert to (e.g. sibling classes
    /// each implementing a common interface). A `never` (throw) right
    /// operand is left to the normal `x ?? throw` path.
    /// @param boundLeft The bound left operand.
    /// @param boundRight The bound right operand.
    /// @param target The contextual target type, or `null`.
    /// @param op The synthesized NullCoalesce operator on success.
    /// @returns `true` when a target-typed operator was built.
    private func TryBindTargetTypedNullCoalesce(
        boundLeft BoundExpression,
        boundRight BoundExpression,
        target TypeSymbol?,
        out op BoundBinaryOperator?
    ) bool {
        op = nil
        if target == nil ||
            target == TypeSymbol.Error ||
            target == TypeSymbol.Void ||
            boundLeft.Type == TypeSymbol.Error ||
            boundRight.Type == TypeSymbol.Error ||
            boundRight.Type == TypeSymbol.Never {
            return false
        }
        let leftUnderlying TypeSymbol? = if boundLeft.Type is NullableTypeSymbol leftNullable {
            leftNullable.UnderlyingType
        } else {
            boundLeft.Type
        }
        if leftUnderlying == nil || leftUnderlying == TypeSymbol.Null {
            return false
        }
        let leftConv = Conversion.Classify(leftUnderlying, target)
        let rightConv = Conversion.Classify(boundRight.Type, target)
        if leftConv.Exists && leftConv.IsImplicit && rightConv.Exists && rightConv.IsImplicit {
            op = BoundBinaryOperator.MakeNullCoalesce(boundLeft.Type, boundRight.Type, target)
            return true
        }
        return false
    }

    /// Issue #1246: shared operand adaptation for binding a binary operator.
    /// Attempts an exact per-type bind first, then — when that fails — applies
    /// the same adaptations `BindBinaryExpression` performs, including
    /// delegate target typing (#3792), constant-integer-literal adaptation
    /// (#1144), directional implicit integer widening (#1150), the value-type
    /// and heterogeneous nullable mixed-mode lifts, and lifted (nullable)
    /// numeric widening (#1236).
    /// Any inserted conversions mutate [`boundLeft`](paramref) /
    /// [`boundRight`](paramref) in place. This is factored out so compound
    /// assignment (`a op= b`) widens its right operand exactly like the
    /// equivalent binary expression `a op b`. Returns the bound operator,
    /// or `null` when no numeric adaptation makes the operator
    /// bind (the caller then reports GS0129 or tries user/CLR operator
    /// fallbacks).
    private func BindBinaryOperatorWithNumericAdaptation(
        operatorKind SyntaxKind,
        ref boundLeft BoundExpression,
        ref boundRight BoundExpression,
        leftLocation TextLocation,
        rightLocation TextLocation
    ) BoundBinaryOperator? {
        var boundOperator BoundBinaryOperator? = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
        if boundOperator == nil &&
            TryBindDelegateCombinationOperator(
            operatorKind,
            &boundLeft,
            &boundRight,
            leftLocation,
            rightLocation,
            out var delegateOperator
        ) {
            return delegateOperator
        }
        // Issue #3463: C# defines string concatenation with char operands in
        // either order. Keep char-to-string adaptation local to `+` rather
        // than introducing a general implicit char -> string conversion.
        //
        // Issue #4324 / ADR-0186 §6: the string side may be `string!` as well
        // as `string`/`string?`. Testing only the `?` wrapper made
        // `obliviousString + 'c'` (and `s += 'c'` on a `string!` local)
        // report GS0129 while `obliviousString + "x"` bound — the char arm
        // was the one concatenation path that never learned about `T!`.
        if boundOperator == nil && operatorKind == SyntaxKind.PlusToken {
            if GetReferenceNullabilityUnderlying(boundLeft.Type) == TypeSymbol.String &&
                boundRight.Type == TypeSymbol
                .Char {
                boundRight = ConvertStringConcatCharOperand(boundRight, rightLocation)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            } else if boundLeft.Type == TypeSymbol.Char &&
                GetReferenceNullabilityUnderlying(boundRight.Type) == TypeSymbol
                .String {
                boundLeft = ConvertStringConcatCharOperand(boundLeft, leftLocation)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            }
        }
        if (
            operatorKind == SyntaxKind.ShiftLeftToken ||
                operatorKind == SyntaxKind.ShiftRightToken ||
                operatorKind == SyntaxKind.UnsignedShiftRightToken
        ) &&
            (
            GetNullableUnderlying(boundLeft.Type) == TypeSymbol.Char ||
                GetNullableUnderlying(boundRight.Type) == TypeSymbol.Char
        ) {
            if GetNullableUnderlying(boundLeft.Type) == TypeSymbol.Char {
                let promotedLeftType = if boundLeft.Type is NullableTypeSymbol {
                    cast[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.Int32))
                } else {
                    TypeSymbol.Int32
                }
                boundLeft = conversions.BindConversion(leftLocation, boundLeft, promotedLeftType)
            }
            if GetNullableUnderlying(boundRight.Type) == TypeSymbol.Char {
                let promotedRightType = if boundRight.Type is NullableTypeSymbol {
                    cast[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.Int32))
                } else {
                    TypeSymbol.Int32
                }
                boundRight = conversions.BindConversion(rightLocation, boundRight, promotedRightType)
            }
            boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
        }
        // Issue #2616 / ECMA-334 §14.2.6.2: char is promoted by the standard
        // binary numeric-promotion rules, not closed under char arithmetic.
        // Insert real numeric conversions before binding so all downstream
        // consumers observe the promoted operand types.
        if (boundOperator == nil || IsPromotedCharOperator(operatorKind)) &&
            TryGetPromotedCharBinaryType(operatorKind, boundLeft.Type, boundRight.Type, out var promotedBinaryType) {
            let promotedOperator BoundBinaryOperator? = BoundBinaryOperator.Bind(
                operatorKind,
                Invariant.Required(
                    promotedBinaryType,
                    "a promoted char operator has a type",
                    expression: "promotedBinaryType"
                ),
                Invariant.Required(
                    promotedBinaryType,
                    "a promoted char operator has a type",
                    expression: "promotedBinaryType"
                )
            )
            if promotedOperator != nil {
                let promotedType = Invariant.Required(
                    promotedBinaryType,
                    "a promoted char operator has a type",
                    expression: "promotedBinaryType"
                )
                boundLeft = conversions.BindConversion(leftLocation, boundLeft, promotedType)
                boundRight = conversions.BindConversion(rightLocation, boundRight, promotedType)
                boundOperator = promotedOperator
            }
        }
        // Issue #1923: boxed-constant equality (`answer == 42` where `answer`
        // is typed `object`). The operator table only registers the
        // homogeneous `object == object -> bool` arm, so a non-`object`
        // operand (e.g. an `int32` constant on the other side) previously
        // fell through to GS0129 "operator not defined for 'object' and
        // 'int32'" even though C# boxes the value-type operand and compares
        // by reference identity. When exactly one side is `object` and the
        // OTHER side has an implicit (boxing) conversion to `object`, box it
        // and rebind the homogeneous `object == object` operator.
        if boundOperator == nil &&
            (operatorKind == SyntaxKind.EqualsEqualsToken || operatorKind == SyntaxKind.BangEqualsToken) {
            if boundLeft.Type == TypeSymbol.Object && boundRight.Type != TypeSymbol.Object && Conversion.Classify(
                boundRight.Type,
                TypeSymbol.Object
            )
                .IsImplicit {
                boundRight = conversions.BindConversion(rightLocation, boundRight, TypeSymbol.Object)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            } else if boundRight.Type == TypeSymbol.Object &&
                boundLeft.Type != TypeSymbol.Object &&
                Conversion
                .Classify(boundLeft.Type, TypeSymbol.Object).IsImplicit {
                boundLeft = conversions.BindConversion(leftLocation, boundLeft, TypeSymbol.Object)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            }
        }
        // Issue #2226: C# §12.12 enum equality against the literal `0`. Per
        // C# §10.2.4, the INTEGER LITERAL `0` (or any constant expression
        // whose compile-time value is zero, e.g. a folded unary `-0`) is the
        // one integer value that implicitly converts to ANY enum type
        // without a cast — servicing the common flags idiom
        // `(mode & X) != 0`, where the `&` of two same-typed flags produces
        // an enum-typed result that must then compare against `0`. Any OTHER
        // integer constant/expression against an enum is still rejected
        // (GS0129), matching C#: this does not extend to `enum == 1` or
        // `enum == someIntVariable`.
        if boundOperator == nil &&
            (operatorKind == SyntaxKind.EqualsEqualsToken || operatorKind == SyntaxKind.BangEqualsToken) {
            if EnumOperatorTable.IsEnumType(boundLeft.Type) && !EnumOperatorTable.IsEnumType(boundRight.Type) &&
                TryGetConstantIntegerValue(boundRight, out var rightZero) &&
                rightZero.IsZero &&
                TryAdaptIntegerLiteral(
                rightZero,
                EnumOperatorTable.GetUnderlyingType(boundLeft.Type),
                out var rightZeroValue
            ) {
                boundRight = BoundLiteralExpression(boundRight.Syntax, rightZeroValue, boundLeft.Type)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            } else if EnumOperatorTable.IsEnumType(boundRight.Type) && !EnumOperatorTable.IsEnumType(boundLeft.Type) &&
                TryGetConstantIntegerValue(boundLeft, out var leftZero) &&
                leftZero.IsZero &&
                TryAdaptIntegerLiteral(
                leftZero,
                EnumOperatorTable.GetUnderlyingType(boundRight.Type),
                out var leftZeroValue
            ) {
                boundLeft = BoundLiteralExpression(boundLeft.Syntax, leftZeroValue, boundRight.Type)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            }
        }
        // Issues #1144 / #5415: adapt an integer literal to the other operand's
        // integer type when its value is representable (ADR-0129).
        // The other operand can also be a literal. Out-of-range values remain unadapted.
        // Integer-valued enum members must retain their enum static types.
        if boundOperator == nil && IsIntegerType(boundLeft.Type) && IsIntegerType(boundRight.Type) {
            if boundLeft is BoundLiteralExpression leftLit &&
                IsIntegerLiteralValue(leftLit.Value) &&
                TryAdaptIntegerLiteral(leftLit.Value, boundRight.Type, out var adaptedLeftValue) {
                boundLeft = BoundLiteralExpression(boundLeft.Syntax, adaptedLeftValue)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            } else if boundRight is BoundLiteralExpression rightLit &&
                IsIntegerLiteralValue(rightLit.Value) &&
                TryAdaptIntegerLiteral(rightLit.Value, boundLeft.Type, out var adaptedRightValue) {
                boundRight = BoundLiteralExpression(boundRight.Syntax, adaptedRightValue)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            }
        }
        // Issue #4350: ordinary numeric widening is not integer-only. C# permits
        // `double += 1`, `float + int`, and the `++` desugaring over a floating
        // target. Widen the operand whose numeric type implicitly converts to
        // the other, then bind the homogeneous operator.
        if boundOperator == nil &&
            IsNumericPrimitiveType(boundLeft.Type) &&
            IsNumericPrimitiveType(boundRight.Type) &&
            (IsFloatingOrDecimalType(boundLeft.Type) || IsFloatingOrDecimalType(boundRight.Type)) &&
            boundLeft.Type != boundRight
            .Type {
            if Conversion.Classify(boundRight.Type, boundLeft.Type).IsImplicit {
                boundRight = conversions.BindConversion(rightLocation, boundRight, boundLeft.Type)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            } else if Conversion.Classify(boundLeft.Type, boundRight.Type).IsImplicit {
                boundLeft = conversions.BindConversion(leftLocation, boundLeft, boundRight.Type)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            }
        }
        // Issue #1232: shift-count widening. C# allows the shift COUNT (the RHS
        // of `<<` / `>>` / `<<=` / `>>=`) to be any integer that implicitly
        // converts to `int` (sbyte/byte/short/ushort/char), promoting it to
        // int32; the left operand alone determines the result type. G#'s shift
        // operators take an `int32` count, so a narrower-order count previously
        // produced GS0129. When the count's integer type implicitly widens to
        // int32, widen it and re-bind rather than erroring. Counts that do NOT
        // implicitly convert to int32 (uint32/int64/uint64/nint/nuint) still
        // error — matching C#, which also rejects those count types. This must
        // run BEFORE the generic directional widening below, which would
        // otherwise widen the count to the LEFT operand's type and leave the
        // shift unbound.
        if boundOperator == nil &&
            (
            operatorKind == SyntaxKind.ShiftLeftToken ||
                operatorKind == SyntaxKind.ShiftRightToken ||
                operatorKind == SyntaxKind.UnsignedShiftRightToken
        ) &&
            IsIntegerType(boundLeft.Type) &&
            (IsIntegerType(boundRight.Type) || boundRight.Type == TypeSymbol.Char) &&
            boundRight.Type != TypeSymbol.Int32 &&
            Conversion
            .Classify(boundRight.Type, TypeSymbol.Int32).IsImplicit {
            boundRight = conversions.BindConversion(rightLocation, boundRight, TypeSymbol.Int32)
            boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
        }
        // Issue #1150: directional implicit integer widening between two TYPED
        // integer operands. When the initial per-type operator bind failed and
        // NEITHER operand is a constant integer literal, but exactly one
        // operand's integer type implicitly, losslessly widens to the OTHER
        // operand's integer type, widen the narrower operand and re-bind. When
        // NEITHER operand widens to the other the operator stays unbound.
        if boundOperator == nil &&
            !(boundLeft is BoundLiteralExpression) &&
            !(boundRight is BoundLiteralExpression) &&
            IsIntegerType(boundLeft.Type) &&
            IsIntegerType(boundRight.Type) &&
            boundLeft.Type != boundRight
            .Type {
            if Conversion.Classify(boundLeft.Type, boundRight.Type).IsImplicit {
                boundLeft = conversions.BindConversion(leftLocation, boundLeft, boundRight.Type)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            } else if Conversion.Classify(boundRight.Type, boundLeft.Type).IsImplicit {
                boundRight = conversions.BindConversion(rightLocation, boundRight, boundLeft.Type)
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
            }
        }
        // PR N-4 / §6.1 / C# §7.3.7: mixed-mode lift. When one operand is a
        // value-type Nullable<T> and the other is its underlying T, lift T to T?
        // and re-bind the homogeneous lifted operator.
        if boundOperator == nil {
            if boundLeft.Type is NullableTypeSymbol leftNullable &&
                leftNullable
                .UnderlyingType
                ?.ClrType is {IsValueType: true} &&
                boundRight.Type == leftNullable
                .UnderlyingType {
                let lifted BoundBinaryOperator? = BoundBinaryOperator.Bind(operatorKind, leftNullable, leftNullable)
                if lifted != nil {
                    boundRight = conversions.BindConversion(rightLocation, boundRight, leftNullable)
                    boundOperator = lifted
                }
            } else if boundRight.Type is NullableTypeSymbol rightNullable &&
                rightNullable
                .UnderlyingType
                ?.ClrType is {IsValueType: true} &&
                boundLeft.Type == rightNullable
                .UnderlyingType {
                let lifted BoundBinaryOperator? = BoundBinaryOperator.Bind(operatorKind, rightNullable, rightNullable)
                if lifted != nil {
                    boundLeft = conversions.BindConversion(leftLocation, boundLeft, rightNullable)
                    boundOperator = lifted
                }
            }
        }
        // 6.6 / §6.1: mixed-mode lift for heterogeneous nullable operands.
        if boundOperator == nil {
            if boundLeft.Type is NullableTypeSymbol leftN2 &&
                !(boundRight.Type is NullableTypeSymbol) &&
                boundRight
                .Type
                ?.ClrType is {IsValueType: true} {
                let rightLifted = NullableTypeSymbol.Get(boundRight.Type)
                let lifted BoundBinaryOperator? = BoundBinaryOperator.Bind(operatorKind, leftN2, rightLifted)
                if lifted != nil {
                    boundRight = conversions.BindConversion(rightLocation, boundRight, rightLifted)
                    boundOperator = lifted
                }
            } else if boundRight.Type is NullableTypeSymbol rightN2 &&
                !(boundLeft.Type is NullableTypeSymbol) &&
                boundLeft
                .Type
                ?.ClrType is {IsValueType: true} {
                let leftLifted = NullableTypeSymbol.Get(boundLeft.Type)
                let lifted BoundBinaryOperator? = BoundBinaryOperator.Bind(operatorKind, leftLifted, rightN2)
                if lifted != nil {
                    boundLeft = conversions.BindConversion(leftLocation, boundLeft, leftLifted)
                    boundOperator = lifted
                }
            }
        }
        // Issue #1236: lifted (nullable) numeric widening + constant-integer-
        // literal adaptation on the UNDERLYING numeric types when at least one
        // operand is a value-type Nullable<T>.
        if boundOperator == nil && (boundLeft.Type is NullableTypeSymbol || boundRight.Type is NullableTypeSymbol) {
            let leftUnderlying TypeSymbol? = if boundLeft.Type is NullableTypeSymbol leftNum {
                leftNum.UnderlyingType
            } else {
                boundLeft.Type
            }
            let rightUnderlying TypeSymbol? = if boundRight.Type is NullableTypeSymbol rightNum {
                rightNum.UnderlyingType
            } else {
                boundRight.Type
            }
            var commonUnderlying TypeSymbol? = nil
            if leftUnderlying != nil && rightUnderlying != nil {
                if boundLeft is BoundLiteralExpression leftNumLit &&
                    IsIntegerLiteralValue(leftNumLit.Value) &&
                    !(boundRight is BoundLiteralExpression) &&
                    IsIntegerType(rightUnderlying) &&
                    TryAdaptIntegerLiteral(leftNumLit.Value, rightUnderlying, out var adaptedLeftNum) {
                    boundLeft = BoundLiteralExpression(boundLeft.Syntax, adaptedLeftNum)
                    commonUnderlying = rightUnderlying
                } else if boundRight is BoundLiteralExpression rightNumLit &&
                    IsIntegerLiteralValue(rightNumLit.Value) &&
                    !(boundLeft is BoundLiteralExpression) &&
                    IsIntegerType(leftUnderlying) &&
                    TryAdaptIntegerLiteral(rightNumLit.Value, leftUnderlying, out var adaptedRightNum) {
                    boundRight = BoundLiteralExpression(boundRight.Syntax, adaptedRightNum)
                    commonUnderlying = leftUnderlying
                } else if IsIntegerType(leftUnderlying) &&
                    IsIntegerType(rightUnderlying) &&
                    leftUnderlying != rightUnderlying &&
                    !(boundLeft is BoundLiteralExpression) &&
                    !(boundRight is BoundLiteralExpression) {
                    if Conversion.Classify(leftUnderlying, rightUnderlying).IsImplicit {
                        commonUnderlying = rightUnderlying
                    } else if Conversion.Classify(rightUnderlying, leftUnderlying).IsImplicit {
                        commonUnderlying = leftUnderlying
                    }
                } else if IsNumericPrimitiveType(leftUnderlying) &&
                    IsNumericPrimitiveType(rightUnderlying) &&
                    (IsFloatingOrDecimalType(leftUnderlying) || IsFloatingOrDecimalType(rightUnderlying)) &&
                    leftUnderlying != rightUnderlying {
                    if Conversion.Classify(rightUnderlying, leftUnderlying).IsImplicit {
                        commonUnderlying = leftUnderlying
                    } else if Conversion.Classify(leftUnderlying, rightUnderlying).IsImplicit {
                        commonUnderlying = rightUnderlying
                    }
                }
            }
            if commonUnderlying != nil {
                // Adapted constants can bind directly, especially `T? ?? constant`.
                // Try that shape before lifting a non-null fallback to `T?` (#5395).
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type)
                if boundOperator != nil {
                    return boundOperator
                }
                let commonNullable = NullableTypeSymbol.Get(commonUnderlying)
                let lifted BoundBinaryOperator? = BoundBinaryOperator.Bind(operatorKind, commonNullable, commonNullable)
                if lifted != nil {
                    boundLeft = conversions.BindConversion(leftLocation, boundLeft, commonNullable)
                    boundRight = conversions.BindConversion(rightLocation, boundRight, commonNullable)
                    boundOperator = lifted
                }
            }
        }
        return boundOperator
    }

    private func TryBindDelegateCombinationOperator(
        operatorKind SyntaxKind,
        ref left BoundExpression,
        ref right BoundExpression,
        leftLocation TextLocation,
        rightLocation TextLocation,
        out op BoundBinaryOperator?
    ) bool {
        op = nil
        if operatorKind != SyntaxKind.PlusToken && operatorKind != SyntaxKind.MinusToken {
            return false
        }
        var leftDelegate TypeSymbol? = GetConcreteDelegateType(left.Type)
        var rightDelegate TypeSymbol? = GetConcreteDelegateType(right.Type)
        var target TypeSymbol? = nil
        if leftDelegate != nil && IsUnresolvedMethodGroup(right) {
            right = conversions.BindConversion(rightLocation, right, leftDelegate)
            if right is BoundErrorExpression {
                return false
            }
            rightDelegate = GetConcreteDelegateType(right.Type)
        } else if rightDelegate != nil && IsUnresolvedMethodGroup(left) {
            left = conversions.BindConversion(leftLocation, left, rightDelegate)
            if left is BoundErrorExpression {
                return false
            }
            leftDelegate = GetConcreteDelegateType(left.Type)
        }
        if leftDelegate != nil && rightDelegate != nil {
            if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(leftDelegate, rightDelegate) {
                target = leftDelegate
            } else if rightDelegate is FunctionTypeSymbol &&
                !(leftDelegate is FunctionTypeSymbol) &&
                Conversion
                .Classify(right.Type, leftDelegate).IsImplicit {
                target = leftDelegate
                right = conversions.BindConversion(rightLocation, right, target)
            } else if leftDelegate is FunctionTypeSymbol &&
                !(rightDelegate is FunctionTypeSymbol) &&
                Conversion
                .Classify(left.Type, rightDelegate).IsImplicit {
                target = rightDelegate
                left = conversions.BindConversion(leftLocation, left, target)
            }
        } else if leftDelegate != nil && right.Type == TypeSymbol.Null {
            target = leftDelegate
        } else if rightDelegate != nil && left.Type == TypeSymbol.Null {
            target = rightDelegate
        }
        if target == nil {
            return false
        }
        let resultType = if operatorKind == SyntaxKind.MinusToken ||
            (MayBeNilDelegateOperand(left.Type) && MayBeNilDelegateOperand(right.Type)) {
            cast[TypeSymbol](NullableTypeSymbol.Get(target))
        } else {
            target
        }
        op = BoundBinaryOperator.MakeDelegateCombination(operatorKind, left.Type, right.Type, resultType)
        return true
    }

    private func ConvertStringConcatCharOperand(expression BoundExpression, location TextLocation) BoundExpression {
        return switch expression {
            case BoundLiteralExpression{Value: char value}: cast[BoundExpression](
                BoundLiteralExpression(expression.Syntax, value.ToString())
            )
            default: ConvertToString(expression, location)
        }
    }

    shared {
        private func IsPointerOffsetType(type TypeSymbol) bool -> type == TypeSymbol.Int8 ||
            type == TypeSymbol.UInt8 ||
            type == TypeSymbol.Int16 ||
            type == TypeSymbol.UInt16 ||
            type == TypeSymbol.Int32 ||
            type == TypeSymbol.UInt32 ||
            type == TypeSymbol.Int64 ||
            type == TypeSymbol.UInt64 ||
            type == TypeSymbol.NInt ||
            type == TypeSymbol.NUInt

        private func StaticPointeeSize(pointee TypeSymbol) int32 {
            // Issue #2838: an open type parameter has no compile-time size, so
            // IsStructPointee must route it to the runtime `sizeof` opcode instead.
            Debug.Assert(!(pointee is TypeParameterSymbol), "open type-parameter pointee reached StaticPointeeSize")
            if pointee == TypeSymbol.Int8 || pointee == TypeSymbol.UInt8 || pointee == TypeSymbol.Bool {
                return 1
            }
            if pointee == TypeSymbol.Int16 || pointee == TypeSymbol.UInt16 || pointee == TypeSymbol.Char {
                return 2
            }
            if pointee == TypeSymbol.Int32 || pointee == TypeSymbol.UInt32 || pointee == TypeSymbol.Float32 {
                return 4
            }
            if pointee == TypeSymbol.Int64 || pointee == TypeSymbol.UInt64 || pointee == TypeSymbol.Float64 {
                return 8
            }
            // nint/nuint and pointer-to-pointer are pointer-sized; the supported
            // execution targets are 64-bit.
            return nint.Size
        }

        /// ADR-0122 §4 / issue #1034. Returns whether [`pointee`](paramref) is a
        /// pointee whose unmanaged size is not a known compile-time constant — so
        /// pointer arithmetic must scale by the emitted CIL `sizeof` opcode
        /// rather than a literal.
        ///
        /// Issue #2838: an open type parameter (`*T` under
        /// `where T : unmanaged`) belongs in this bucket. A
        /// `TypeParameterSymbol` carries no (cref:TypeSymbol.ClrType)
        /// at all, so it matched neither the struct case nor the value-type case
        /// and fell through to (cref:StaticPointeeSize), silently scaling by
        /// `nint.Size` (8) for EVERY instantiation. That produced no
        /// diagnostic and no exception, just wrong answers for any `T` whose
        /// size is not 8. The size is only known per-instantiation at runtime, so
        /// it must always come from `sizeof !!T`.
        private func IsStructPointee(pointee TypeSymbol) bool -> pointee is TypeParameterSymbol ||
            pointee is StructSymbol &&
            pointee.IsClass == false ||
            (
            !(pointee is StructSymbol) &&
                !(pointee is PointerTypeSymbol) &&
                pointee?.ClrType is {IsValueType: true} &&
                !TypeSymbol.IsLegalPointeeType(pointee)
        )

        /// ADR-0122 §3-§4 / issues #1014, #1032, #1034. Builds an `nint`-typed
        /// expression for the size of a pointee. For a blittable struct pointee it
        /// emits the runtime `sizeof(T)` (size unknown at G# compile time); for
        /// a primitive/pointer pointee it is the static compile-time byte size.
        /// [`isOne`](paramref) reports the static-size==1 fast path (no scaling).
        private func PointeeSizeAsNint(pointee TypeSymbol, out isOne bool) BoundExpression {
            if IsStructPointee(pointee) {
                isOne = false
                return BoundConversionExpression(nil, TypeSymbol.NInt, BoundSizeOfExpression(nil, pointee))
            }
            let size = StaticPointeeSize(pointee)
            isOne = size == 1
            return BoundConversionExpression(nil, TypeSymbol.NInt, BoundLiteralExpression(nil, size, TypeSymbol.Int32))
        }

        private func CanLowerPointerComparisonOperand(type TypeSymbol) bool -> type == TypeSymbol.Null ||
            Conversion
            .Classify(type, TypeSymbol.NInt).Exists

        /// Issue #4964: computes the smart-cast narrowing frames that a
        /// conditional's condition implies for each branch. The if-expression
        /// (`if c { a } else { b }`) and the conditional operator (`c ? a : b`)
        /// are two spellings of one value form, and both bind their branches
        /// under these frames, so the two cannot narrow differently.
        /// The `if let` expression's guard shares these frames (ADR-0201).
        ///
        /// Issue #2640 introduced the frames for the if-expression: a top-level
        /// nil guard (`x != nil`, `x == nil`, nullable value types included),
        /// merged with the type-test and short-circuit frames of
        /// `ClassifyTypeTestNarrowing` (`x is T`, `!`, `&&`, `||`).
        /// @param condition The bound condition.
        /// @returns The frame for the branch taken when the condition is true,
        /// and the frame for the branch taken when it is false. Either may be
        /// `nil` when that branch narrows nothing.
        private func ClassifyConditionalNarrowing(condition BoundExpression)(
            WhenTrue Dictionary[AccessPath, TypeSymbol]?,
            WhenFalse Dictionary[AccessPath, TypeSymbol]?
        ) {
            var whenTrueNarrowing Dictionary[AccessPath, TypeSymbol]? = nil
            var whenFalseNarrowing Dictionary[AccessPath, TypeSymbol]? = nil
            if SmartCastStability.TryClassifyNilGuardLeaf(
                condition,
                restrictBareVariableToLocalsAndParams: false,
                referenceNullableOnly: false,
                out var target,
                out var underlying,
                out var nonNilWhenTrue
            ) &&
                target != nil &&
                underlying != nil {
                let frame = Dictionary[AccessPath, TypeSymbol]{[target] = underlying}
                if nonNilWhenTrue {
                    whenTrueNarrowing = frame
                } else {
                    whenFalseNarrowing = frame
                }
            }
            let (typeWhenTrue, typeWhenFalse) = ClassifyTypeTestNarrowing(condition)
            return (
                MergeIfExpressionNarrowing(whenTrueNarrowing, typeWhenTrue),
                MergeIfExpressionNarrowing(whenFalseNarrowing, typeWhenFalse)
            )
        }

        private func MergeIfExpressionNarrowing(
            first Dictionary[AccessPath, TypeSymbol]?,
            second Dictionary[AccessPath, TypeSymbol]?
        ) Dictionary[AccessPath, TypeSymbol]? {
            if first == nil || first.Count == 0 {
                return second
            }
            if second == nil || second.Count == 0 {
                return first
            }
            let merged = Dictionary[AccessPath, TypeSymbol](first)
            for pair in second {
                merged[pair.Key] = pair.Value
            }
            return merged
        }

        private func IsNestedLambdaExpression(syntax ExpressionSyntax) bool {
            var syntax = syntax
            while syntax is ParenthesizedExpressionSyntax parenthesized {
                syntax = parenthesized.Expression
            }
            return switch syntax {
                case _ is LambdaExpressionSyntax: true
                case BlockExpressionSyntax{Expression: {} tail}: IsNestedLambdaExpression(tail)
                case conditional is ConditionalExpressionSyntax: IsNestedLambdaExpression(conditional.WhenTrue) ||
                    IsNestedLambdaExpression(conditional.WhenFalse)
                case ifExpression is IfExpressionSyntax: IsNestedLambdaExpression(ifExpression.ThenBlock) ||
                    (ifExpression.ElseExpression != nil && IsNestedLambdaExpression(ifExpression.ElseExpression))
                case ifLetExpression is IfLetExpressionSyntax: IsNestedLambdaExpression(ifLetExpression.ThenBlock) ||
                    (ifLetExpression.ElseExpression != nil && IsNestedLambdaExpression(ifLetExpression.ElseExpression))
                case switchExpression is SwitchExpressionSyntax: switchExpression.Arms.Any(
                    (arm SwitchExpressionArmSyntax) -> IsNestedLambdaExpression(arm.Result)
                )
                case binary is BinaryExpressionSyntax when binary
                    .OperatorToken
                    .Kind == SyntaxKind.QuestionQuestionToken: IsNestedLambdaExpression(binary.Left) ||
                    IsNestedLambdaExpression(binary.Right)
                default: false
            }
        }

        /// Issue #1158: computes the conditional/if-expression result type using the
        /// same target-typing + best-common-type machinery as switch-expressions, in
        /// the following priority order (first non-null wins):
        /// 1. Target-typing — when an explicit, valid target type is supplied and BOTH arms implicitly convert
        /// to it (C# 9+ target-typed conditional).
        /// 2. The existing pairwise (cref:ComputeConditionalCommonType) (identity, never/null lift, one-way
        /// implicit, ADR-0037 numeric tie-break).
        /// 3. Best-common-type (least-upper-bound) across the two arms — unifies sibling subtypes to their
        /// shared base/interface.
        /// Returns `null` only when none of the three yield a type, so
        /// the caller reports GS0263.
        /// @param left The true-arm type.
        /// @param right The false-arm type.
        /// @param targetType The optional target type (C#-style target-typing), or `null`.
        /// @returns The chosen result type, or `null`.
        private func ComputeConditionalResultType(
            left TypeSymbol?,
            right TypeSymbol?,
            targetType TypeSymbol?
        ) TypeSymbol? {
            if left == nil || right == nil {
                return nil
            }
            // (a) Target-typing: honor an explicit, valid target when both arms
            // implicitly convert to it.
            if targetType != nil &&
                targetType != TypeSymbol.Error &&
                targetType != TypeSymbol.Void &&
                AllArmsImplicitlyConvertTo([]TypeSymbol{left, right}, targetType) {
                return targetType
            }
            // (b) Existing pairwise common type (identity, never/null, one-way
            // implicit, numeric tie-break). DO NOT alter this method's behavior.
            let pairwise TypeSymbol? = ComputeConditionalCommonType(left, right)
            if pairwise != nil {
                return UnionArmNullability(pairwise, left, right)
            }
            // (c) Best-common-type (least-upper-bound) fallback: unify sibling
            // subtypes to their shared base/interface.
            return UnionArmNullability(ComputeBestCommonType([]TypeSymbol{left, right}), left, right)
        }

        /// Issue #1428: the least-upper-bound of two conditional/if-expression arms
        /// must UNION the nullable annotation of both arms, independent of arm order.
        /// The pairwise/best-common routines can return a non-nullable type when one
        /// arm is non-nullable and the other is reference-convertible to it (e.g.
        /// arm0 `T`, arm1 `T?` for a reference/interface `T`, where
        /// both arms are mutually implicitly convertible), dropping the nullable
        /// annotation that the second arm contributed. This lifts the chosen result
        /// to its nullable form whenever EITHER arm is nullable, mirroring C# where
        /// `cond ? e : null` (and the reversed form) both yield `T?`.
        /// @param result The chosen common type (may be `null`).
        /// @param left The true-arm type.
        /// @param right The false-arm type.
        /// @returns The result lifted to nullable when either arm is nullable; otherwise [`result`](paramref).
        private func UnionArmNullability(result TypeSymbol?, left TypeSymbol?, right TypeSymbol?) TypeSymbol? {
            if result == nil ||
                result == TypeSymbol.Error ||
                result == TypeSymbol.Never ||
                result is NullableTypeSymbol {
                return result
            }
            if left is NullableTypeSymbol || right is NullableTypeSymbol {
                return NullableTypeSymbol.Get(result)
            }
            // ADR-0186 §3, type unification: lub(`T!`, `T`) is `T!`, lub(`T!`,
            // `T!`) is `T!`, and lub(`T!`, `T?`) is `T?` — which the arm above
            // already produced, because it runs first.
            //
            // The governing principle is that AN EXPLICIT STATEMENT ALWAYS BEATS
            // THE ABSENCE OF ONE, and the ADR is emphatic that this is
            // deliberately NOT symmetric absorption: `T?` wins, `T` does not. A
            // `T` arm asserts non-nullness for *that* branch only and says nothing
            // whatever about the platform branch, so promoting the union to `T`
            // would silently convert an unknown into a guarantee — at a point
            // where §4 would then insert no check, because no `T! -> T` coercion
            // would appear anywhere.
            if !(result is PlatformTypeSymbol) && (left is PlatformTypeSymbol || right is PlatformTypeSymbol) {
                return PlatformTypeSymbol.Get(result)
            }
            return result
        }

        /// ADR-0062: chooses a common result type for two conditional branches
        /// using the following ordered rules (mirroring the ADR §2 common-type
        /// procedure):
        /// 1. Identity (`Tx == Ty`).
        /// 2. One-way implicit conversion (`Tx → Ty` but not `Ty → Tx`, or vice versa).
        /// 3. Both convertible implicitly — pick the wider via the numeric tie-break rule (ADR-0037) when both
        /// are numeric; otherwise no common type.
        /// 4. `nil` compatibility — when one arm is the nil/null sentinel and the other is reference- or
        /// nullable-compatible, use the other arm's type.
        /// Returns `null` when no common type exists.
        /// @param left The true-arm type.
        /// @param right The false-arm type.
        /// @returns The chosen common type, or `null`.
        private func ComputeConditionalCommonType(left TypeSymbol?, right TypeSymbol?) TypeSymbol? {
            if left == nil || right == nil {
                return nil
            }
            if left == TypeSymbol.Error || right == TypeSymbol.Error {
                return TypeSymbol.Error
            }
            // Issue #1018: a throw-expression branch has the bottom (`never`) type,
            // which is convertible to any type. The conditional's result type is the
            // sibling branch's type. When BOTH branches throw, the result is `never`
            // too (e.g. `cond ? throw a : throw b`).
            if left == TypeSymbol.Never {
                return right
            }
            if right == TypeSymbol.Never {
                return left
            }
            // Identity.
            if object.ReferenceEquals(left, right) {
                return left
            }
            // Nil/null compatibility: when one arm is the null sentinel and the
            // other is non-null, pick the non-null. The conversion machinery
            // accepts the trivial null → reference/nullable widening. Issue #1151:
            // when the other arm is a non-nullable value type `T`, the unified type
            // must be `T?` so the value arm is lifted and the nil arm becomes the
            // null `T?` (reference and already-nullable arms are left unchanged).
            if left == TypeSymbol.Null {
                return LiftForNilArm(right)
            }
            if right == TypeSymbol.Null {
                return LiftForNilArm(left)
            }
            let leftToRight = Conversion.Classify(left, right)
            let rightToLeft = Conversion.Classify(right, left)
            let leftImplicit = leftToRight.IsImplicit || HasImportedUserDefinedImplicitConversion(left, right)
            let rightImplicit = rightToLeft.IsImplicit || HasImportedUserDefinedImplicitConversion(right, left)
            // Identity already handled; treat IsIdentity here as implicit too.
            if leftImplicit && !rightImplicit {
                return right
            }
            if rightImplicit && !leftImplicit {
                return left
            }
            if leftImplicit && rightImplicit {
                // ADR-0037 numeric tie-break: prefer the wider canonical numeric
                // target when both arms are numeric.
                let widened TypeSymbol? = TryNumericTieBreak(left, right)
                if widened != nil {
                    return widened
                }
                // Both convert to each other and neither is numeric — they're
                // effectively identical; pick the left arm deterministically.
                return left
            }
            return nil
        }

        private func HasImportedUserDefinedImplicitConversion(source TypeSymbol, target TypeSymbol) bool {
            if source.ClrType == nil || target.ClrType == nil {
                return false
            }
            return ConversionClassifier.HasUserDefinedImplicitConversionForTypes(source, target)
        }

        /// Issues #1151 and #4316: the join of a `nil` arm and a non-nullable arm `T` is `T?`, so a
        /// value type lifts to `Nullable<T>` and a reference type takes the nullable annotation. The
        /// join carries the `nil`, so no context has to supply a target for it. A `T!`, a `T?` and a
        /// type that cannot hold `nil` (an unconstrained type parameter) stay as they are.
        /// @param type The non-nil arm's type.
        /// @returns The nullable form of [`type`](paramref) when `nil` can join it; otherwise [`type`](paramref).
        private func LiftForNilArm(type TypeSymbol?) TypeSymbol? {
            if type == nil || type is NullableTypeSymbol || type is PlatformTypeSymbol {
                return type
            }
            if type.ClrType is {IsValueType: true} || Conversion.IsReferenceLikeTarget(type) ||
                type is TypeParameterSymbol{DependentBoundProvesReferenceType: true} {
                return NullableTypeSymbol.Get(type)
            }
            return type
        }

        /// ADR-0037-style numeric tie-break: when both arms are numeric primitives,
        /// pick the wider canonical type using a simple rank. Returns
        /// `null` when either type isn't a recognised primitive.
        private func TryNumericTieBreak(a TypeSymbol, b TypeSymbol) TypeSymbol? {
            let ra = NumericRank(a)
            let rb = NumericRank(b)
            if ra == 0 || rb == 0 {
                return nil
            }
            return if ra >= rb {
                a
            } else {
                b
            }
        }

        private func NumericRank(t TypeSymbol) int32 {
            if t == TypeSymbol.Int8 || t == TypeSymbol.UInt8 {
                return 1
            }
            if t == TypeSymbol.Int16 || t == TypeSymbol.UInt16 {
                return 2
            }
            if t == TypeSymbol.Int32 || t == TypeSymbol.UInt32 {
                return 3
            }
            if t == TypeSymbol.Int64 || t == TypeSymbol.UInt64 {
                return 4
            }
            if t == TypeSymbol.Float32 {
                return 5
            }
            if t == TypeSymbol.Float64 {
                return 6
            }
            return 0
        }

        /// Issue #3317 / ADR-0159: true when a nil-comparison operand warrants the
        /// GS0523 "always false/true" warning — its static type is a bare
        /// (non-`?`) magic collection type with a sound non-nil guarantee
        /// (`map[K, V]`, `[]T`, `[N]T`, `chan T`) AND it is
        /// not a smart-cast-narrowed read of a `?`-declared slot (v1 is
        /// declared-static-type based; the redundant-re-check nuance is a future
        /// refinement).
        /// @param operand The non-nil side of the comparison.
        /// @returns Whether GS0523 should be reported.
        private func IsBareMagicCollectionNilCompareOperand(operand BoundExpression) bool {
            // ADR-0186 §6: GS0523 must not fire for a PLATFORM-typed magic
            // collection — `map[K, V]!` can genuinely be nil, so the comparison is
            // not dead code. That holds by construction rather than by a new arm:
            // a `PlatformTypeSymbol` is none of the kinds listed below, so the
            // test declines before it reaches the "a bare collection can never be
            // nil" premise. Recorded here because the property is load-bearing and
            // a future widening of this list (e.g. to "anything reference-backed")
            // would silently break it.
            if operand.Type is not(
                MapTypeSymbol or SliceTypeSymbol or ArrayTypeSymbol or RectangularArrayTypeSymbol or ChannelTypeSymbol
            ) {
                return false
            }
            return switch operand {
                case variable is BoundVariableExpression: variable.NarrowedType == nil
                case field is BoundFieldAccessExpression: field.NarrowedType == nil
                case property is BoundPropertyAccessExpression: property.NarrowedType == nil
                default: true
            }
        }

        private func IsExplicitlyNonNullImportedResult(expression BoundExpression) bool {
            // Issue #3727: the metadata answer describes the DECLARED return type,
            // which for a generic method is the open type parameter — `T Read<T>(ref
            // T location)` carries no nullable annotation there, because its
            // nullability is supplied by the type argument at each call site. The
            // binder has already substituted it: `Volatile.Read(&x)` over an `x C?`
            // really does produce a `C?`, and comparing that against `nil` is the
            // whole point of the call. So an operand the binder itself typed
            // nullable is never an "explicitly non-null" result, whatever the open
            // declaration says.
            if expression.Type is NullableTypeSymbol {
                return false
            }
            // ADR-0186 §6/§7: a platform result is the exact opposite of an
            // "explicitly non-null" one — nobody stated anything about it, which
            // is why `x == nil` on a `T!` must be legal and GS0129 must not fire.
            // This predicate is the reason it otherwise does: it asks "is this a
            // nullable result?" by testing `is not NullableTypeSymbol`, and a
            // platform wrapper is not one, so an oblivious result read as `T!`
            // was classified as explicitly non-null and the comparison rejected
            // outright — before `BoundBinaryOperator.Bind`'s nil-compare arm was
            // ever consulted.
            //
            // This is the shape ADR-0186's cost estimate warns about: 636
            // `NullableTypeSymbol` sites, each one a decision about whether
            // `PlatformTypeSymbol` belongs beside it. Most do not. A site that
            // asks "does this admit nil?" does.
            if expression.Type is PlatformTypeSymbol {
                return false
            }
            let method MethodInfo? = switch expression {
                case instanceCall is BoundImportedInstanceCallExpression: instanceCall.Method
                case staticCall is BoundImportedCallExpression: staticCall.Function.Method
                default: default(MethodInfo?)
            }
            return method?.ReturnType is {IsValueType: false} && ClrNullability.GetReturnTypeSymbol(method!!) is not(
                NullableTypeSymbol or PlatformTypeSymbol
            )
        }

        /// Issue #2388: true for the six comparison operators whose C# lifted
        /// form always yields a plain (non-nullable) `bool` — `nil == nil`
        /// is true, a HasValue mismatch is false/true, and two present operands
        /// unwrap and delegate to the underlying operator. Every other
        /// Stream C/D operator (arithmetic, bitwise) lifts to `Nullable<R>`
        /// instead, propagating a "no value" operand as a null result.
        private func IsClrOperatorLiftedToBool(opKind SyntaxKind) bool -> switch opKind {
            case SyntaxKind.EqualsEqualsToken or
                SyntaxKind.BangEqualsToken or
                SyntaxKind.LessToken or
                SyntaxKind.LessOrEqualsToken or
                SyntaxKind.GreaterToken or
                SyntaxKind.GreaterOrEqualsToken: true
            default: false
        }

        private func IsNonNullableValueTypeOperatorSlot(type TypeSymbol) bool {
            return !(type is NullableTypeSymbol) &&
                !(type is ByRefTypeSymbol) &&
                type != TypeSymbol.Void &&
                !TypeSymbol.IsByRefLike(type) &&
                (
                type.IsValueType ||
                    type is StructSymbol &&
                    type.IsClass == false ||
                    type is EnumSymbol ||
                    type is TupleTypeSymbol ||
                    type is TypeParameterSymbol &&
                    type.HasValueTypeConstraint == true
            )
        }

        private func CanApplyLiftedUserOperator(operandType TypeSymbol?, parameterType TypeSymbol) bool {
            let underlyingOperand = Invariant.Required(
                if operandType is NullableTypeSymbol nullable {
                    nullable.UnderlyingType
                } else {
                    operandType
                },
                "an operator operand has a type",
                expression: `operandType is NullableTypeSymbol nullable
                ? nullable.UnderlyingType
                : operandType`
            )
            let conversion = Conversion.Classify(underlyingOperand, parameterType)
            return (conversion.Exists && conversion.IsImplicit) ||
                ConversionClassifier.HasUserDefinedImplicitConversionForTypes(underlyingOperand, parameterType)
        }

        private func IsNumericPrimitiveType(type TypeSymbol) bool -> type
            ?.ClrType
            ?.FullName is string fullName &&
            NumericWideningLattice.IsNumericPrimitive(fullName)

        private func IsFloatingOrDecimalType(type TypeSymbol) bool -> type == TypeSymbol.Float32 ||
            type == TypeSymbol.Float64 ||
            type == TypeSymbol.Decimal

        private func GetConcreteDelegateType(type TypeSymbol) TypeSymbol? {
            let candidate = if type is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                type
            }
            if (candidate is FunctionTypeSymbol or DelegateTypeSymbol) {
                return candidate
            }
            let clrType = candidate.ClrType
            if !ClrTypeUtilities.IsDelegateType(clrType) {
                return nil
            }
            return if (clrType?.FullName is "System.Delegate" or "System.MulticastDelegate") {
                default(TypeSymbol?)
            } else {
                candidate
            }
        }

        private func MayBeNilDelegateOperand(type TypeSymbol) bool -> type == TypeSymbol.Null ||
            type is NullableTypeSymbol

        private func IsUnresolvedMethodGroup(
            expression BoundExpression
        ) bool -> expression is BoundMethodGroupExpression ||
            expression is BoundClrMethodGroupExpression &&
            expression.ResolvedMethod == nil

        private func TryGetPromotedCharUnaryType(
            operatorKind SyntaxKind,
            operandType TypeSymbol,
            out promotedType TypeSymbol?
        ) bool {
            let nullable NullableTypeSymbol? = operandType as NullableTypeSymbol
            if (nullable?.UnderlyingType ?? operandType) == TypeSymbol.Char &&
                (
                operatorKind == SyntaxKind.PlusToken ||
                    operatorKind == SyntaxKind.MinusToken ||
                    operatorKind == SyntaxKind.TildeToken
            ) {
                promotedType = if nullable == nil {
                    TypeSymbol.Int32
                } else {
                    cast[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.Int32))
                }
                return true
            }
            promotedType = nil
            return false
        }

        private func TryGetPromotedCharBinaryType(
            operatorKind SyntaxKind,
            leftType TypeSymbol,
            rightType TypeSymbol,
            out promotedType TypeSymbol?
        ) bool {
            promotedType = nil
            if !IsPromotedCharOperator(operatorKind) {
                return false
            }
            let leftNullable NullableTypeSymbol? = leftType as NullableTypeSymbol
            let rightNullable NullableTypeSymbol? = rightType as NullableTypeSymbol
            let left = leftNullable?.UnderlyingType ?? leftType
            let right = rightNullable?.UnderlyingType ?? rightType
            if left != TypeSymbol.Char && right != TypeSymbol.Char {
                return false
            }
            let other = if left == TypeSymbol.Char {
                right
            } else {
                left
            }
            var target TypeSymbol
            if other == TypeSymbol.Decimal {
                target = TypeSymbol.Decimal
            } else if other == TypeSymbol.Float64 {
                target = TypeSymbol.Float64
            } else if other == TypeSymbol.Float32 {
                target = TypeSymbol.Float32
            } else if other == TypeSymbol.UInt64 {
                target = TypeSymbol.UInt64
            } else if other == TypeSymbol.Int64 {
                target = TypeSymbol.Int64
            } else if other == TypeSymbol.UInt32 {
                target = TypeSymbol.UInt32
            } else if other == TypeSymbol.NInt {
                target = TypeSymbol.NInt
            } else if other == TypeSymbol.NUInt {
                target = TypeSymbol.NUInt
            } else if other == TypeSymbol.Char || IsIntegerType(other) {
                target = TypeSymbol.Int32
            } else {
                return false
            }
            promotedType = if leftNullable != nil || rightNullable != nil {
                cast[TypeSymbol](NullableTypeSymbol.Get(target))
            } else {
                target
            }
            return true
        }

        private func IsPromotedCharOperator(operatorKind SyntaxKind) bool -> operatorKind == SyntaxKind.PlusToken ||
            operatorKind == SyntaxKind.MinusToken ||
            operatorKind == SyntaxKind.StarToken ||
            operatorKind == SyntaxKind.SlashToken ||
            operatorKind == SyntaxKind.PercentToken ||
            operatorKind == SyntaxKind.AmpersandToken ||
            operatorKind == SyntaxKind.PipeToken ||
            operatorKind == SyntaxKind.HatToken ||
            operatorKind == SyntaxKind.AmpersandHatToken ||
            operatorKind == SyntaxKind.EqualsEqualsToken ||
            operatorKind == SyntaxKind.BangEqualsToken ||
            operatorKind == SyntaxKind.LessToken ||
            operatorKind == SyntaxKind.LessOrEqualsToken ||
            operatorKind == SyntaxKind.GreaterToken ||
            operatorKind == SyntaxKind.GreaterOrEqualsToken

        private func GetNullableUnderlying(type TypeSymbol) TypeSymbol? -> if type is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            type
        }

        // Issue #4324: strips either reference-nullability wrapper — `T?` or
        // ADR-0186's platform `T!` — for operand tests that are about the
        // underlying type rather than about whether the value may be nil.
        private func GetReferenceNullabilityUnderlying(type TypeSymbol) TypeSymbol? -> switch type {
            case nullable is NullableTypeSymbol: nullable.UnderlyingType
            case platform is PlatformTypeSymbol: platform.UnderlyingType
            default: type
        }

        // issue #1144: the ten G# integer primitive types (signed + unsigned,
        // including the native-int pair). Membership mirrors the integral sets in
        // BoundBinaryOperator.
        internal func IsIntegerType(type TypeSymbol?) bool {
            return type == TypeSymbol.Int8 ||
                type == TypeSymbol.Int16 ||
                type == TypeSymbol.Int32 ||
                type == TypeSymbol.Int64 ||
                type == TypeSymbol.NInt ||
                type == TypeSymbol.UInt8 ||
                type == TypeSymbol.UInt16 ||
                type == TypeSymbol.UInt32 ||
                type == TypeSymbol.UInt64 ||
                type == TypeSymbol.NUInt
        }

        // issue #1144: true when the boxed literal value is a compile-time constant
        // INTEGER (excludes char/bool/float/decimal/string/enum, which never adapt).
        internal func IsIntegerLiteralValue(value object?) bool {
            return (value is int8 or uint8 or int16 or uint16 or int32 or uint32 or int64 or uint64 or nint or nuint)
        }

        // issue #1183: widen a boxed integer literal value to a sign-agnostic
        // BigInteger carrier so the full int64/uint64 range round-trips.
        internal func ToBigInteger(value object?) BigInteger {
            return switch value {
                case s is int8: BigInteger(s)
                case b is uint8: BigInteger(b)
                case s is int16: BigInteger(s)
                case u is uint16: BigInteger(u)
                case i is int32: BigInteger(i)
                case u is uint32: BigInteger(u)
                case l is int64: BigInteger(l)
                case u is uint64: BigInteger(u)
                case n is nint: BigInteger(int64(n))
                case n is nuint: BigInteger(uint64(n))
                default: default(BigInteger)
            }
        }

        // issue #1183: C# §10.2.11 constant-expression support. Extract the
        // compile-time integer value of a constant integer expression — a bare
        // integer literal or a unary +/- applied (recursively) to one. Returns
        // false for any non-constant or non-integer expression so the caller
        // falls back to the ordinary (explicit) numeric conversion classification.
        internal func TryGetConstantIntegerValue(expression BoundExpression, out value BigInteger) bool {
            value = default(BigInteger)
            switch expression {
                case lit is BoundLiteralExpression when IsIntegerLiteralValue(lit.Value) {
                    value = ToBigInteger(lit.Value)
                    return true
                }
                case BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.Identity}} identity {
                    return TryGetConstantIntegerValue(identity.Operand, out value)
                }
                case BoundUnaryExpression{
                    Op: {Kind: BoundUnaryOperatorKind.Negation}
                } negation when TryGetConstantIntegerValue(negation.Operand, out var inner) {
                    value = -inner
                    return true
                }
                default {
                    return false
                }
            }
        }

        // issue #1144: try to adapt a constant integer literal to the target integer
        // type. Uses BigInteger as a wide, sign-agnostic carrier so the full uint64
        // range is handled, and range-checks against the target's min/max before
        // producing a boxed value whose CLR type maps (via BoundLiteralExpression's
        // InferType) to EXACTLY the target type. Native ints are range-tested
        // conservatively as int64 (nint) / uint64 (nuint) so the result is stable
        // regardless of the host process pointer width.
        internal func TryAdaptIntegerLiteral(value object?, target TypeSymbol?, out converted object?) bool {
            converted = nil
            if !IsIntegerLiteralValue(value) {
                return false
            }
            return TryAdaptIntegerLiteral(ToBigInteger(value), target, out converted)
        }

        // issue #1183: BigInteger-carrier overload shared by the constant-expression
        // narrowing path (which folds unary +/- before classifying) and the boxed
        // literal adaptation above. Range-checks against the target integer type's
        // min/max before producing a boxed value whose CLR type maps (via
        // BoundLiteralExpression.InferType) to EXACTLY the target type.
        internal func TryAdaptIntegerLiteral(v BigInteger, target TypeSymbol?, out converted object?) bool {
            converted = nil
            var min BigInteger
            var max BigInteger
            if target == TypeSymbol.Int8 {
                min = int8.MinValue
                max = int8.MaxValue
            } else if target == TypeSymbol.UInt8 {
                min = uint8.MinValue
                max = uint8.MaxValue
            } else if target == TypeSymbol.Int16 {
                min = int16.MinValue
                max = int16.MaxValue
            } else if target == TypeSymbol.UInt16 {
                min = uint16.MinValue
                max = uint16.MaxValue
            } else if target == TypeSymbol.Int32 {
                min = int32.MinValue
                max = int32.MaxValue
            } else if target == TypeSymbol.UInt32 {
                min = uint32.MinValue
                max = uint32.MaxValue
            } else if target == TypeSymbol.Int64 || target == TypeSymbol.NInt {
                min = int64.MinValue
                max = int64.MaxValue
            } else if target == TypeSymbol.UInt64 || target == TypeSymbol.NUInt {
                min = uint64.MinValue
                max = uint64.MaxValue
            } else {
                return false
            }
            if v < min || v > max {
                return false
            }
            if target == TypeSymbol.Int8 {
                converted = int8(v)
            } else if target == TypeSymbol.UInt8 {
                converted = uint8(v)
            } else if target == TypeSymbol.Int16 {
                converted = int16(v)
            } else if target == TypeSymbol.UInt16 {
                converted = uint16(v)
            } else if target == TypeSymbol.Int32 {
                converted = int32(v)
            } else if target == TypeSymbol.UInt32 {
                converted = uint32(v)
            } else if target == TypeSymbol.Int64 {
                converted = int64(v)
            } else if target == TypeSymbol.UInt64 {
                converted = uint64(v)
            } else if target == TypeSymbol.NInt {
                converted = nint(int64(v))
            } else {
                converted = nuint(uint64(v))
            }
            return true
        }

        // Issue #1281: C# §10.2.11 implicit constant expression conversion at a CALL
        // SITE. A constant integer argument (an integer literal, or unary +/- over
        // one) whose value lies within the parameter's integer type range converts
        // implicitly with no cast — exactly as at a declaration/assignment target
        // (ADR-0129, handled in ConversionClassifier.BindConversion). This predicate
        // lets overload resolution accept such an argument before it reaches
        // BindConversion (which then re-materialises the correctly-typed literal),
        // so e.g. `f(5)` binds to a `uint16`/`uint32` parameter the same way
        // `var x uint16 = 5` already does. Non-constant operands and `char` targets
        // are excluded, matching C# (char is not a §10.2.11 destination type, and a
        // non-constant narrowing/cross-sign value still requires an explicit cast).
        internal func IsImplicitConstantNarrowingArgument(argument BoundExpression?, parameterType TypeSymbol?) bool {
            return TryAdaptConstantInteger(argument, parameterType, out _, out _)
        }

        /// Adapts a representable integer constant before an optional value-nullable lift.
        /// @param argument The constant expression.
        /// @param target The declared destination type.
        /// @param converted The adapted integer value.
        /// @param integerType The integer type before lifting.
        /// @returns True when the constant fits the integer destination.
        internal func TryAdaptConstantInteger(
            argument BoundExpression?,
            target TypeSymbol?,
            out converted object?,
            out integerType TypeSymbol
        ) bool {
            converted = nil
            integerType = if target is NullableTypeSymbol nullable && NullableLifting.IsAnyValueTypeNullable(nullable) {
                nullable.UnderlyingType
            } else {
                target ?? TypeSymbol.Error
            }
            return argument != nil &&
                IsIntegerType(argument.Type) &&
                IsIntegerType(integerType) &&
                TryGetConstantIntegerValue(argument, out var value) &&
                TryAdaptIntegerLiteral(value, integerType, out converted)
        }

        // Issue #1311: builds the per-call constant-narrowing applicability hook for
        // imported/BCL overload resolution (ClrOverloadResolution.Resolve). The hook
        // receives the source-argument index (into argTypes) and the candidate's CLR
        // parameter type; it returns true when the corresponding bound argument is a
        // constant integer expression whose value fits that (possibly narrower /
        // cross-sign) integer parameter — i.e. the same §10.2.11 rule applied on the
        // user-method path. `argumentOffset` accounts for a synthesised leading
        // receiver slot (imported extension calls pass [receiver, args…], offset 1).
        internal func MakeConstantNarrowingArgumentCheck(
            boundArguments IReadOnlyList[BoundExpression]?,
            argumentOffset int32 = 0
        )((int32, Type) -> bool)? {
            if boundArguments == nil {
                return nil
            }
            return (index int32, parameterType Type?) -> {
                let argIndex = index - argumentOffset
                if argIndex < 0 || argIndex >= boundArguments.Count || parameterType == nil {
                    return false
                }
                var effectiveParameterType = parameterType
                // A constant literal can never bind by-ref; peel defensively so a
                // by-ref parameter maps to its element type rather than a managed
                // pointer (which TypeSymbol.FromClrType cannot represent).
                if effectiveParameterType.IsByRef {
                    effectiveParameterType = Invariant.Required(
                        effectiveParameterType.GetElementType(),
                        "a by-ref parameter has an element type",
                        expression: "effectiveParameterType.GetElementType()"
                    )
                }
                if ClrNullability.ContainsFunctionPointer(effectiveParameterType) || effectiveParameterType.IsPointer {
                    return false
                }
                return IsImplicitConstantNarrowingArgument(
                    boundArguments[argIndex],
                    TypeSymbol.FromClrTypeWithoutNullability(
                        effectiveParameterType,
                        NullabilityFreeReason.IdentityComparison
                    )
                )
            }
        }

        // Issue #4054: a same-compilation type has no CLR identity while binding,
        // so its overload-resolution argument is an erasure surrogate (usually
        // object). Keep the real symbol available only for the narrow question the
        // CLR classifier cannot answer: whether this candidate parameter is reached
        // through an implicit user conversion. Imported arguments stay entirely on
        // the established CLR path, and an erased argument with no such conversion
        // gains no applicability.
        internal func MakeSymbolicArgumentConversionClassifier(
            boundArguments IReadOnlyList[BoundExpression]?,
            argumentOffset int32 = 0,
            nativeConversions ConversionClassifier? = nil
        )((int32, Type, ParameterInfo) -> ClrOverloadResolution.ImplicitConversionKind?)? {
            let DeclaresImplicitOperator = func (type TypeSymbol) bool {
                var type = type
                while type is NullableTypeSymbol nullable {
                    type = nullable.UnderlyingType
                }
                return type is StructSymbol owner && owner.StaticMethods.Any(
                    (method FunctionSymbol) -> string.Equals(method.Name, "op_Implicit", StringComparison.Ordinal) &&
                        method
                        .Parameters
                        .Length == 1
                )
            }
            if boundArguments == nil {
                return nil
            }
            return (index int32, clrParameterType Type?, parameter ParameterInfo) -> {
                let argIndex = index - argumentOffset
                if argIndex < 0 ||
                    argIndex >= boundArguments.Count ||
                    clrParameterType == nil ||
                    clrParameterType.IsByRef {
                    return nil
                }
                let sourceType = boundArguments[argIndex].Type
                var nativeTarget = ClrNullability.GetParameterTypeSymbol(parameter)
                if parameter.ParameterType.IsArray && !ClrTypeUtilities.AreSame(
                    parameter.ParameterType,
                    clrParameterType
                ) {
                    nativeTarget = nativeTarget.GetElementPositions()[0]
                }
                if NativeProtocolOperations.GetProtocol(nativeTarget) != nil {
                    return if nativeConversions?.ClassifyArgumentConversion(sourceType, nativeTarget)
                        .IsImplicit == true {
                        if sourceType == nativeTarget {
                            ClrOverloadResolution.ImplicitConversionKind.Identity
                        } else {
                            ClrOverloadResolution.ImplicitConversionKind.Reference
                        }
                    } else {
                        ClrOverloadResolution.ImplicitConversionKind.None
                    }
                }
                if sourceType.ClrType != nil || !TypeSymbol.ContainsSameCompilationUserType(sourceType) ||
                    !DeclaresImplicitOperator(sourceType) {
                    return nil
                }
                // ADR-0193: applicability compares bare shapes; argument lowering retains declaration nullability.
                let targetType = nativeTarget.StripToBareShape()
                let standard = Conversion.ClassifyNonStructural(sourceType, targetType)
                if standard.IsIdentity {
                    return ClrOverloadResolution.ImplicitConversionKind.Identity
                }
                if standard.IsImplicit {
                    return if (sourceType is StructSymbol and {IsClass: false} or EnumSymbol or NullableTypeSymbol) {
                        ClrOverloadResolution.ImplicitConversionKind.Boxing
                    } else {
                        ClrOverloadResolution.ImplicitConversionKind.Reference
                    }
                }
                let hasUserDefined = ConversionClassifier.HasUserDefinedImplicitConversionForTypes(
                    sourceType,
                    targetType
                )
                // Lifted symbolic operators are not yet materialized by CLR
                // argument lowering, so they must remain inapplicable here.
                return if sourceType is NullableTypeSymbol sourceNullable &&
                    targetType is NullableTypeSymbol targetNullable &&
                    NullableLifting.IsAnyValueTypeNullable(sourceNullable) && NullableLifting.IsAnyValueTypeNullable(
                    targetNullable
                ) &&
                    hasUserDefined {
                    ClrOverloadResolution.ImplicitConversionKind.None
                } else {
                    (
                        if hasUserDefined {
                            ClrOverloadResolution.ImplicitConversionKind.UserDefinedImplicit
                        } else {
                            ClrOverloadResolution.ImplicitConversionKind.None
                        }
                    )
                }
            }
        }

        // ADR-0148: imported overload resolution works on CLR Type surrogates and
        // cannot see a G# argument's symbolic public shape. Supply that context as
        // a call-local applicability callback; by-ref parameters remain excluded.
        internal func MakeStructuralProjectionArgumentCheck(
            boundArguments IReadOnlyList[BoundExpression]?,
            argumentOffset int32 = 0,
            nativeConversions ConversionClassifier? = nil
        )((int32, Type) -> bool)? {
            if boundArguments == nil {
                return nil
            }
            return (index int32, clrParameterType Type?) -> {
                let argIndex = index - argumentOffset
                if argIndex < 0 ||
                    argIndex >= boundArguments.Count ||
                    clrParameterType == nil ||
                    clrParameterType.IsByRef ||
                    ClrNullability.ContainsFunctionPointer(clrParameterType) || clrParameterType.IsPointer {
                    return false
                }
                let sourceType = boundArguments[argIndex].Type
                let targetType = TypeSymbol.FromClrTypeWithoutNullability(
                    clrParameterType,
                    NullabilityFreeReason.IdentityComparison
                )
                if NativeProtocolOperations.GetProtocol(targetType) != nil {
                    return nativeConversions?.ClassifyArgumentConversion(sourceType, targetType).IsImplicit == true
                }
                return Conversion.ClassifyNonStructural(sourceType, targetType)
                    .IsImplicit ||
                    StructuralProjectionPlanner.CanProject(sourceType, targetType) ||
                    IsApplicableIgnoringReferenceNullability(sourceType, targetType)
            }
        }

        // Issue #3989: the SUBTRACTIVE twin of the callback above. Applicability
        // ranks imported candidates on CLR shapes, and an element declared in the
        // current compilation (or an in-scope type parameter) has none:
        // `MemberLookup.TryProjectErasedClrType` presents `Pair` as
        // `System.Object`, so a `List[Pair]` argument arrives as `List<object>`
        // and matches a parameter that GENUINELY is `List<object>` by identity. At
        // the erased level the two are indistinguishable — which is the whole
        // point of the erasure, and is what lets `[]Pair{…}.Count()` reach LINQ —
        // so applicability has to get a second opinion from the one layer that can
        // still see the real types.
        //
        // This callback is that opinion: given the source-argument index and the
        // candidate's CLOSED parameter type, it reports whether the argument's REAL
        // type has no conversion to that parameter at all. `ClrOverloadResolution`
        // asks it only at a slot that could NOT have acquired its `object` by
        // erasure (`IsErasedGenericParameterSlot`), so an inferred generic slot —
        // `Count[TSource](IEnumerable[TSource])`, `M[T](List[T])` — is never
        // second-guessed and keeps binding exactly as before.
        //
        // Three narrowings keep this off every path it has no business on:
        // an argument whose own shape was not erased cannot have matched by
        // accident; a top-level `object` parameter accepts everything anyway, and
        // the unsound match is always an erased `object` standing in a NESTED
        // position; and EXISTING — not merely IMPLICIT — is the bar, mirroring
        // `ConversionClassifier.BindClrParameterConversions`, which re-binds CLR
        // arguments with `allowExplicit: true` and would therefore accept an
        // explicit conversion this check must not have already refused. No measured
        // row turns on that distinction after the first two narrowings; it is the
        // permissive choice, taken so this check can only ever remove a candidate
        // the layer below could not have emitted anyway.
        //
        // What is left is exactly the pair that has NOTHING to emit, which before
        // this check was pushed raw: ILVerify StackUnexpected, and at run time a
        // hard failure (a `[]Pair` reaching a genuine `IEnumerable<object>`
        // parameter throws `EntryPointNotFoundException` from inside the callee,
        // because CLR variance does not reach a value-type element).
        internal func MakeErasedArgumentMismatchCheck(
            boundArguments IReadOnlyList[BoundExpression]?,
            argumentOffset int32 = 0
        )((int32, Type) -> bool)? {
            if boundArguments == nil {
                return nil
            }
            return (index int32, clrParameterType Type) -> {
                let argIndex = index - argumentOffset
                return argIndex >= 0 &&
                    argIndex < boundArguments.Count &&
                    IsErasedArgumentApplicabilityMismatch(boundArguments[argIndex].Type, clrParameterType)
            }
        }

        // Issue #4026 (review finding): the PRECISE form of the erased-slot
        // question, for a call that supplied explicit type arguments.
        //
        // The genuineness flags answer it per SLOT — "did this call pin every
        // method type parameter this parameter mentions with a type that has a CLR
        // identity of its own?" — and that is exact only when the answer is all-or-
        // nothing. `TakeMap[ImportedBase, Derived](map[Derived, Derived]{})` pins
        // `K` genuinely and `V` not, so the slot stays "possibly erased" and the
        // GENUINE invariant `K` mismatch is waived along with it: the MethodSpec is
        // emitted over `Dictionary<ImportedBase, Derived>` while a
        // `Dictionary<Derived, Derived>` is pushed, ILVerify `StackUnexpected`. No
        // CLR-level correlation can see this — the argument's erased key is
        // `ImportedBase`, which is exactly what the pin says — so the question has
        // to be asked on the REAL symbols.
        //
        // This callback asks it: substitute the call's own type-argument SYMBOLS
        // into the candidate's OPEN parameter, giving the parameter type the
        // emitted MethodSpec will actually have, and report whether the argument's
        // REAL type has no conversion to it. Asked at the slot, never inside
        // another callback, so the #3989 exemption still governs which slots it is
        // asked about at all.
        //
        // It declines to answer wherever it cannot see the whole picture, because a
        // wrong "no conversion" removes a candidate that binds today:
        //   - a lambda / arrow argument, whose delegate conversion is decided by
        //     machinery this classifier does not model — and which is the
        //     `Task.ContinueWith[TResult](Func[Task, TResult])` shape that broke a
        //     per-position rewrite of the erasure gate twice already (#4004, #4019);
        //   - a member of a CONSTRUCTED generic type, whose parameter also mentions
        //     type-LEVEL parameters this vector says nothing about;
        //   - a params-expanded or by-ref slot, and any substitution that leaves a
        //     type parameter behind.
        internal func MakeExplicitTypeArgumentMismatchCheck(
            boundArguments IReadOnlyList[BoundExpression]?,
            typeArgSymbols ImmutableArray[TypeSymbol],
            argumentOffset int32 = 0
        )((int32, MethodBase) -> bool)? {
            if boundArguments == nil || typeArgSymbols.IsDefaultOrEmpty {
                return nil
            }
            // Only the MIXED list has anything for this check to say. When every
            // type argument is genuine the per-slot flags already answer exactly
            // (the slot is not erased, and the established #3989/#4006 verdict on
            // the CLR shapes governs); when NONE is, the call is the ordinary
            // erasure the flags exempt and this check must stay silent — asking
            // `Conversion` there refuses calls that bind today, because a symbolic
            // comparison does not model G# function types meeting imported delegate
            // shapes inside a constructed generic
            // (`Base.Make[Derived](List[((Derived) -> void)])`,
            // `Issue2857ExplicitGenericLambdaProjectReferenceEmitTests`, measured).
            // So this fires only where one position is genuinely pinned beside one
            // that is not, which is precisely the gap the per-slot flag leaves.
            var anyGenuine = false
            var anySurrogate = false
            for typeArgument in typeArgSymbols {
                if typeArgument != nil && !TypeSymbol.ContainsSameCompilationUserType(typeArgument) &&
                    !TypeSymbol.ContainsTypeParameter(typeArgument) {
                    anyGenuine = true
                } else {
                    anySurrogate = true
                }
            }
            if !anyGenuine || !anySurrogate {
                return nil
            }
            let nullableTypeArgSymbols = ImmutableArray.CreateRange(
                typeArgSymbols,
                (symbol TypeSymbol) -> cast[TypeSymbol?](symbol)
            )
            return (index int32, rawCandidate MethodBase) -> {
                let argIndex = index - argumentOffset
                if argIndex < 0 ||
                    argIndex >= boundArguments.Count ||
                    boundArguments[argIndex].Type is not{} argumentType ||
                    argumentType is FunctionTypeSymbol ||
                    rawCandidate is not MethodInfo candidate ||
                    candidate.DeclaringType is {IsGenericType: true} {
                    return false
                }
                let openMethod MethodInfo? = if candidate.IsGenericMethodDefinition {
                    candidate
                } else {
                    (
                        if candidate.IsGenericMethod {
                            candidate.GetGenericMethodDefinition()
                        } else {
                            default(MethodInfo?)
                        }
                    )
                }
                if openMethod == nil || openMethod.GetGenericArguments().Length != nullableTypeArgSymbols.Length {
                    return false
                }
                let parameters = openMethod.GetParameters()
                if index >= parameters.Length || parameters[index].ParameterType.IsByRef {
                    return false
                }
                let realParameter TypeSymbol? = MemberLookup.GetClrOpenParameterPointeeTypeSymbol(
                    parameters[index],
                    openDefinition: nil,
                    typeArguments: ImmutableArray[TypeSymbol].Empty,
                    openMethod: openMethod,
                    methodTypeArguments: nullableTypeArgSymbols
                )
                if realParameter == nil || object.ReferenceEquals(realParameter, TypeSymbol.Error) ||
                    TypeSymbol.ContainsTypeParameter(realParameter) {
                    return false
                }
                return !Conversion.Classify(argumentType, realParameter).Exists
            }
        }

        /// Issue #3989: whether [`sourceType`](paramref) reached
        /// [`clrParameterType`](paramref) only because its own CLR projection
        /// was erased, with no conversion between the real types to emit.
        /// @param sourceType The argument's real (symbolic) type.
        /// @param clrParameterType The candidate's closed parameter type.
        /// @returns True when the erased match is spurious.
        internal func IsErasedArgumentApplicabilityMismatch(sourceType TypeSymbol?, clrParameterType Type?) bool {
            if sourceType == nil ||
                clrParameterType == nil ||
                clrParameterType.IsByRef ||
                clrParameterType.IsPointer ||
                clrParameterType.ContainsGenericParameters {
                return false
            }
            // Only an argument that HAS an erasure can have matched through one.
            if !TypeSymbol.ContainsTypeParameter(sourceType) && !TypeSymbol.ContainsSameCompilationUserType(
                sourceType
            ) {
                return false
            }
            // An erasure can only be MISTAKEN for the parameter where the parameter
            // has an erasure SURROGATE in the position the erasure filled — that
            // is, nested inside a constructed generic (or an array element).
            // (`object` was the only surrogate this test knew about until #4006;
            // see below.) A parameter that
            // genuinely is `object` accepts the argument for real; and a parameter
            // with no surrogate in it at all (`System.Array`, the non-generic
            // `IEnumerable`/`ICollection`/`IList`/`IDictionary`, `int`,
            // `Exception`, `IComparable`) was matched on the argument's own CLR
            // shape, which erasure did not invent — a `map[string, Pair]` really is
            // an `IDictionary` and a user `enum` really is an `int`, whatever their
            // elements are. Only the nested position is suspect, which is exactly
            // the invariant-generic-over-an-erased-element shape the issue reports.
            //
            // One limit of this test, measured, not costing a program: it is per
            // PARAMETER where the precise unit is per POSITION. A parameter
            // declared `Dictionary[T, List[object]]` is exempted whole, though its
            // nested `List<object>` is genuine. Reading the candidate's OPEN
            // declaration position by position was implemented and REVERTED —
            // `Task.ContinueWith[TResult](Func[Task, TResult])` has the identical
            // shape, one concrete nested position beside one open one, so it
            // rejected every lambda passed to such a slot. Suspicion can be made
            // per position; the VERDICT below cannot, because `Conversion.Classify`
            // answers on the whole parameter. The exempted case is refused a few
            // steps later by `BindClrParameterConversions` (`GS0155`) and emits
            // nothing, so the imprecision is diagnostic quality, not soundness.
            //
            // Issue #4006 closed two gaps this comment used to describe as one
            // unreachable hole.
            //
            // FIRST, `object` is not the only erasure surrogate: a same-compilation
            // CLASS erases to its IMPORTED BASE, so a `map[string, Derived]`
            // presents as `Dictionary<string, ImportedBase>` and matched a
            // parameter that GENUINELY is `Dictionary<string, ImportedBase>` by
            // IDENTITY — a nested position with no `object` anywhere in it, which
            // this test used to wave through. The surrogate set is therefore
            // derived from the ARGUMENT rather than hard-wired to `object`. A
            // `map[string, ImportedBase]` that really holds imported bases has no
            // erased element, so it never reaches this test at all (the erasure
            // precondition above declines it), and a parameter carrying an imported
            // type this argument did not erase into is still exempt.
            //
            // SECOND, the reported `List[Derived]` repro never reached this check
            // at all, and widening the surrogate set alone would NOT have closed
            // it: `ClassifyImplicit(List<ImportedBase>, List<object>)` came back
            // `None`, and this check is consulted only where the CLR comparison
            // ALREADY matched. It was admitted by the `conv == None` fallback
            // instead — the ADR-0148 `structuralProjectionArgumentCheck`, which
            // asks `StructuralProjectionPlanner.CanProject` directly and gets a
            // nonsense yes (two `List`s share a parameterless constructor and a
            // `Capacity`) for a pair `Conversion` refuses outright, so nothing was
            // emitted and the raw list was pushed. `ClrOverloadResolution` now asks
            // this same question on that arm too.
            //
            // Narrowing the ADR-0148 callback itself was tried first and REVERTED:
            // requiring `Conversion.Classify(...).Exists` there also refused
            // `enumAction(List[Mode]{…})` at a `System.Action[List[Mode]]`, whose
            // `Invoke` parameter erases to `List<int>` — a slot that DID come from
            // erasure, and exactly what `IsErasedGenericParameterSlot` exists to
            // exempt. A callback sees only `(argumentIndex, closedParameterType)`
            // and so cannot apply that exemption; the verdict has to be asked at
            // the SLOT, which is where this check is asked from.
            if !ContainsNestedErasureSurrogate(clrParameterType, CollectErasureSurrogates(sourceType)) {
                return false
            }
            let targetType TypeSymbol? = TypeSymbol.FromClrTypeWithoutNullability(
                clrParameterType,
                NullabilityFreeReason.IdentityComparison
            )
            if targetType == nil {
                return false
            }
            // `StructuralProjectionPlanner.CanProject` is deliberately NOT consulted.
            // A projection is only ever PLANNED from the `conv == None` arm of
            // applicability (that is what `structuralProjectionArgumentCheck` is
            // for); once the CLR comparison has already answered, no projection node
            // is produced and the raw value is pushed. Treating "a projection would
            // have been possible" as acceptance here would therefore accept exactly
            // the pairs that emit the invalid IL this check exists to stop.
            return !Conversion.Classify(sourceType, targetType).Exists
        }

        /// Issue #3989 / #4006: whether [`type`](paramref) carries one of
        /// [`surrogates`](paramref) in a NESTED position — a constructed
        /// generic's type argument, or an array's element — at any depth.
        /// @remarks This is the shape an erased argument can be confused with. An element
        /// with no CLR identity erases to a SURROGATE inside the argument's own
        /// constructed shape (`List[Pair]` presents as
        /// `List<object>`, `[]Pair` as `object[]`,
        /// `map[string, Derived]` as
        /// `Dictionary<string, ImportedBase>`), so only a parameter with
        /// that surrogate in the matching position can have been reached by the
        /// erasure rather than by the argument's real shape.
        /// @param type The candidate parameter type.
        /// @param surrogates The argument's erasure surrogates.
        /// @returns True when a surrogate appears nested inside the type.
        private func ContainsNestedErasureSurrogate(type Type, surrogates IReadOnlyCollection[Type]) bool {
            if type.IsArray {
                let element Type? = type.GetElementType()
                return element != nil &&
                    (IsErasureSurrogate(element, surrogates) || ContainsNestedErasureSurrogate(element, surrogates))
            }
            if !type.IsGenericType || type.IsGenericTypeDefinition {
                return false
            }
            for argument in type.GetGenericArguments() {
                if IsErasureSurrogate(argument, surrogates) || ContainsNestedErasureSurrogate(argument, surrogates) {
                    return true
                }
            }
            return false
        }

        /// Issue #4006: whether [`candidate`](paramref) is one of the CLR
        /// types the argument's erased elements could have presented as.
        /// @param candidate A nested position of the parameter type.
        /// @param surrogates The argument's erasure surrogates.
        /// @returns True when the position could have been filled by an erasure.
        private func IsErasureSurrogate(candidate Type, surrogates IReadOnlyCollection[Type]) bool {
            for surrogate in surrogates {
                if ClrTypeUtilities.AreSame(candidate, surrogate) {
                    return true
                }
            }
            return false
        }

        /// Issue #4006: the CLR types [`sourceType`](paramref)'s own erased
        /// elements present as.
        /// @remarks `object` is always in the set: it is what an in-scope type
        /// parameter and a same-compilation struct/interface/delegate erase to, and
        /// it is the only surrogate #3989 knew about. A same-compilation CLASS
        /// erases to its IMPORTED BASE instead
        /// (`MemberLookup.TryProjectErasedClrType`), which is how a
        /// `map[string, Derived]` reached a genuine
        /// `Dictionary<string, ImportedBase>` parameter by identity with
        /// no `object` in sight.
        ///
        /// In practice the set is exactly
        /// `{ object } ∪ { the imported base of each same-compilation CLASS in
        /// the argument }`: an in-scope type parameter, a same-compilation
        /// struct, interface or named delegate all erase to `object`, which is
        /// already present. A same-compilation ENUM is deliberately EXCLUDED: it
        /// erases to `int`, and treating every nested `int` position as
        /// suspect is both far too broad and unnecessary — a `List[MyEnum]` at
        /// a `List<int>` parameter is already refused by
        /// `MemberLookup.ExcludeErasureOnlyEnumCandidates`, which drops those
        /// candidates before applicability runs.
        ///
        /// Deriving it from the ARGUMENT rather than from a fixed list is
        /// what keeps the suspicion as narrow as the erasure that caused it: a
        /// parameter mentioning an imported type this argument did not erase into
        /// is untouched.
        ///
        /// Suspicion is not a verdict. A `[]Derived` trips this test at
        /// an `ImportedBase[]` parameter just as a `map[string, Derived]`
        /// does at a `Dictionary<string, ImportedBase>` one — and keeps
        /// binding, because CLR arrays are COVARIANT and
        /// `Conversion.Classify` therefore finds a real conversion to emit.
        /// Invariance is what makes the map case unsound, not the erasure.
        /// @param sourceType The argument's real (symbolic) type.
        /// @returns The erasure surrogates, always including `object`.
        private func CollectErasureSurrogates(sourceType TypeSymbol?) IReadOnlyCollection[Type] {
            let surrogates = List[Type]{typeof(object)}
            let Collect = func (type TypeSymbol) {
                // A same-compilation CLASS, and only that: it is the one leaf whose
                // surrogate is a REAL imported type rather than `object`, so it is
                // the one that can make a genuine parameter look like an erasure.
                // A same-compilation ENUM erases to `int`, and adding `int` to the
                // set would make every nested `int` position suspect for any
                // argument that happens to carry a user enum — measured to break
                // `Issue2889`'s `enumAction(List[Mode]{…})`, an imported delegate
                // whose invocation is not this gate's business at all.
                if type is StructSymbol &&
                    type.IsClass == true &&
                    type.ClrType == nil &&
                    MemberLookup.TryProjectErasedClrType(type, out var erased) && !ClrTypeUtilities.AreSame(
                    erased,
                    typeof(object)
                ) {
                    surrogates.Add(erased!!)
                    return
                }
                for inner in TypeSymbol.GetWrappedTypes(type) {
                    Collect(inner)
                }
            }
            if sourceType != nil {
                Collect(sourceType)
            }
            return surrogates
        }

        /// Issue #3992: whether [`sourceType`](paramref) would be applicable
        /// at the imported parameter [`targetType`](paramref) once the
        /// deliberate CLR-boundary leniency about a REFERENCE annotation is
        /// applied — i.e. whether the argument's non-nullable form is applicable.
        /// @remarks Applicability ALREADY ignores the annotation on the CLR path:
        /// `NullableTypeSymbol.ClrType` relays its underlying, so a
        /// `chan[int32]?` argument is presented to
        /// `ClrOverloadResolution` as `Chan<int>` and reaches a
        /// `Channel[int32]` parameter by ordinary CLR assignability, exactly
        /// as a `string?` reaches a `string` parameter. Only the ADR-0148
        /// SYMBOLIC fallback — the callback above, which exists because CLR
        /// surrogates cannot see a G# argument's structural shape — re-asked the
        /// question on the still-annotated symbol, and so re-introduced an
        /// annotation the rest of the boundary had already dropped.
        ///
        /// That mattered only where no CLR relation links the two shapes,
        /// which is precisely the ADR-0174 D2 channel view: no base class or
        /// interface links `Chan<T>` to `ChannelWriter<T>`,
        /// so a NON-GENERIC `Plain.W(ChannelWriter[int32])` was ranked only
        /// here. The annotation-dropping conversion the boundary then applies is
        /// classified EXPLICIT on purpose (that is what keeps a G#-DECLARED
        /// `chan[int32]` parameter reporting GS0154), and this callback asked
        /// for an IMPLICIT one — so the candidate was dropped before the
        /// conversion was ever reached, and `Plain.W(c)` reported GS0159 for a
        /// `chan[int32]?` while binding for a `chan[int32]`. The generic
        /// half of the same asymmetry was fixed by #3995's
        /// `ChannelViewAppliesAtErasedGenericSlot`, which never sees the
        /// annotation because it works on erased CLR shapes — which is why #3992
        /// was narrowed to the non-generic parameter rather than closed.
        ///
        /// Scope is deliberately narrow. Only a REFERENCE nullable is
        /// peeled, so a value-type `Nullable<T>` keeps its own lifted
        /// rules (#3673); `StructuralProjectionPlanner.CanProject` is NOT
        /// re-asked; and nothing becomes applicable whose non-nullable form was
        /// not already applicable. `BindClrParameterConversions` passes
        /// `allowExplicit: true` for CLR arguments, so the conversion this
        /// admits is one that call path was always willing to perform, and the
        /// leniency stays confined to CLR boundaries.
        /// @param sourceType The bound argument's type.
        /// @param targetType The imported parameter's type.
        /// @returns `true` when only a reference annotation stood in the way.
        internal func IsApplicableIgnoringReferenceNullability(
            sourceType TypeSymbol?,
            targetType TypeSymbol?
        ) bool -> sourceType is NullableTypeSymbol referenceNullable &&
            targetType != nil &&
            !(targetType is NullableTypeSymbol) &&
            Conversion.IsReferenceLikeTarget(referenceNullable.UnderlyingType) && Conversion.ClassifyNonStructural(
            referenceNullable.UnderlyingType,
            targetType
        )
            .IsImplicit

        internal func MakeDelegateRefKindArgumentCheck(
            boundArguments IReadOnlyList[BoundExpression]?,
            argumentOffset int32 = 0
        )((int32, Type) -> bool?)? {
            if boundArguments == nil {
                return nil
            }
            return (index int32, clrParameterType Type?) -> {
                let argIndex = index - argumentOffset
                if argIndex < 0 ||
                    argIndex >= boundArguments.Count ||
                    clrParameterType == nil ||
                    !ClrTypeUtilities.IsDelegateType(clrParameterType) {
                    return nil
                }
                if !DelegateRefKindUtilities.TryGetSourceParameterRefKinds(
                    boundArguments[argIndex],
                    out var sourceRefKinds
                ) {
                    return nil
                }
                let targetInvoke MethodInfo? = clrParameterType.GetMethodSafe("Invoke")
                if targetInvoke == nil {
                    return nil
                }
                let targetRefKinds = DelegateRefKindUtilities.GetParameterRefKinds(targetInvoke)
                return if sourceRefKinds.Length == targetRefKinds.Length {
                    sourceRefKinds.SequenceEqual(targetRefKinds)
                } else {
                    nil
                }
            }
        }
    }
}
