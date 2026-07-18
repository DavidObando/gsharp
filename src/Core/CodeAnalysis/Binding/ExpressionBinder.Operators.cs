// <copyright file="ExpressionBinder.Operators.cs" company="GSharp">
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
using System.Numerics;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{
    private BoundExpression BindUnaryExpression(UnaryExpressionSyntax syntax)
    {
        // Phase 5.5 / ADR-0022: prefix `<-ch` is a channel-receive expression,
        // not a unary operator. Route to a dedicated binder so the operator
        // table doesn't need a per-element-type entry.
        if (syntax.OperatorToken.Kind == SyntaxKind.LeftArrowToken)
        {
            return BindChannelReceiveExpression(syntax);
        }

        // ADR-0039: `&expr` — address-of (managed by-ref pointer).
        if (syntax.OperatorToken.Kind == SyntaxKind.AmpersandToken)
        {
            return BindAddressOfExpression(syntax);
        }

        // ADR-0039: `*expr` — dereference a by-ref pointer.
        if (syntax.OperatorToken.Kind == SyntaxKind.StarToken)
        {
            return BindDereferenceExpression(syntax);
        }

        var boundOperand = BindExpression(syntax.Operand);

        if (boundOperand.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var boundOperator = BoundUnaryOperator.Bind(syntax.OperatorToken.Kind, boundOperand.Type);

        if (boundOperator == null)
        {
            // Stream D: try user-defined `func (a T) operator <op>() R` on the
            // operand's user type. Issue #2377: the operator is a static,
            // SpecialName `op_*` method on the struct/class (StaticMethods),
            // NOT an instance method — the receiver-clause `a` is preserved
            // only as the operator's first formal parameter (Parameters[0],
            // Parameters.Length==1 for unary ops). Extension-function
            // fallback (non-owned receiver types) also covered.
            var userOpName = OperatorNames.TryGetUnaryName(syntax.OperatorToken.Kind);
            if (userOpName != null && boundOperand.Type != null)
            {
                FunctionSymbol userOp = null;
                if (boundOperand.Type is StructSymbol operandStruct && TypeMemberModel.TryGetStaticMethodIncludingInherited(operandStruct, userOpName, out var structOp))
                {
                    userOp = structOp;
                }
                else if (scope.TryLookupExtensionFunction(boundOperand.Type, userOpName, out var extOp))
                {
                    userOp = extOp;
                }

                if (userOp != null && userOp.Parameters.Length == 1)
                {
                    var convertedOperand = conversions.BindConversion(syntax.Operand.Location, boundOperand, userOp.Parameters[0].Type);
                    return new BoundCallExpression(null, userOp, ImmutableArray.Create(convertedOperand));
                }
            }

            // Stream C: fall back to a public-static unary `op_*` method on
            // the operand's CLR type (`-time`, `~bits`, ...).
            var ambiguous = false;
            if (boundOperand.Type?.ClrType != null
                && ClrOperatorResolution.TryResolveUnary(syntax.OperatorToken.Kind, boundOperand.Type, out var clrMethod, out ambiguous))
            {
                return new BoundClrUnaryOperatorExpression(
                    null,
                    syntax.OperatorToken.Kind,
                    boundOperand,
                    clrMethod,
                    TypeSymbol.FromClrType(clrMethod.ReturnType));
            }
            else if (ambiguous)
            {
                Diagnostics.ReportAmbiguousOverload(syntax.OperatorToken.Location, syntax.OperatorToken.Text, candidateCount: 2);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportUndefinedUnaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundOperand.Type);
            return new BoundErrorExpression(null);
        }

        // Issue #2023: unary negation on an integral operand bound inside a
        // `checked` context traps on overflow (e.g. `checked(-int.MinValue)`),
        // mirroring #1881's checked Sum/Difference/Product. Mirroring
        // BoundBinaryExpression, the flag is threaded unconditionally from
        // the current checked/unchecked context; every operator kind other
        // than Negation (and Negation over float/double/decimal, which never
        // overflows) simply ignores it downstream.
        return new BoundUnaryExpression(null, boundOperator, boundOperand, binderCtx.IsCheckedContext);
    }

    /// <summary>ADR-0039: Binds <c>&amp;expr</c> — takes managed pointer to an lvalue.</summary>
    private BoundExpression BindAddressOfExpression(UnaryExpressionSyntax syntax)
    {
        // ADR-0061: `&(cond ? a : b)` and `&cond ? a : b` (parser tail
        // form). Dispatch to the conditional ref-argument binder, which
        // produces a BoundConditionalAddressExpression of type `T&`.
        // The operand may be wrapped in parens by the parser; unwrap.
        var rawOperand = syntax.Operand;
        while (rawOperand is ParenthesizedExpressionSyntax pen)
        {
            rawOperand = pen.Expression;
        }

        if (rawOperand is ConditionalRefArgumentExpressionSyntax condOperand)
        {
            return conversions.BindConditionalRefArgument(condOperand, outerModifier: null);
        }

        // ADR-0062: a general conditional expression as the operand of `&`
        // binds to the conditional-address path (preserving ADR-0061 byref
        // safety) when both arms are lvalues of a common pointee type.
        if (rawOperand is ConditionalExpressionSyntax generalCond)
        {
            return BindConditionalAddressFromGeneral(generalCond, outerModifier: null);
        }

        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        // ADR-0122 §9 / issue #1035: `&StaticMethod` produces a managed
        // function-pointer value (CIL `ldftn`). The operand binds to a method
        // group; we accept a single static, non-generic user function and
        // synthesise its managed function-pointer type from the signature.
        if (operand is BoundMethodGroupExpression methodGroup)
        {
            if (!binderCtx.InUnsafeContext)
            {
                Diagnostics.ReportFunctionPointerAddressOfMismatch(
                    syntax.OperatorToken.Location,
                    "taking the address of a method as a function pointer requires an 'unsafe' context");
                return new BoundErrorExpression(null);
            }

            if (methodGroup.Candidates.Length != 1 || methodGroup.Function == null)
            {
                Diagnostics.ReportFunctionPointerAddressOfMismatch(
                    syntax.OperatorToken.Location,
                    "the method is overloaded; '&Method' requires a single, unambiguous method");
                return new BoundErrorExpression(null);
            }

            var target = methodGroup.Function;
            if (methodGroup.Receiver != null || target.IsInstanceMethod)
            {
                Diagnostics.ReportFunctionPointerAddressOfMismatch(
                    syntax.OperatorToken.Location,
                    "only a static or free function can be taken as a function pointer (instance methods are not supported)");
                return new BoundErrorExpression(null);
            }

            if (target.IsGeneric)
            {
                Diagnostics.ReportFunctionPointerAddressOfMismatch(
                    syntax.OperatorToken.Location,
                    "a generic method cannot be taken as a function pointer");
                return new BoundErrorExpression(null);
            }

            // Issue #2067: `&Foo.Private` (method-group-to-delegate /
            // function-pointer conversion) must enforce the declaring
            // struct's `protected`/`private` accessibility the same way
            // BindUserInstanceCall does for regular calls (issue #2058) —
            // this is a separate binder path (ldftn), so it needs its own gate.
            if (target.StaticOwnerType is StructSymbol methodDeclaringType
                && !AccessibilityChecker.IsAccessible(target.Accessibility, methodDeclaringType, getCurrentFunction()))
            {
                Diagnostics.ReportMemberInaccessible(syntax.OperatorToken.Location, target.Name, methodDeclaringType.Name, target.Accessibility);
            }

            var fpParamTypes = ImmutableArray.CreateBuilder<TypeSymbol>(target.Parameters.Length);
            foreach (var p in target.Parameters)
            {
                fpParamTypes.Add(p.Type);
            }

            var fpType = FunctionPointerTypeSymbol.GetManaged(fpParamTypes.MoveToImmutable(), target.Type ?? TypeSymbol.Void);
            return new BoundFunctionPointerFromMethodExpression(null, target, fpType);
        }

        // GS9005: cannot take address of a constant binding.
        if (operand is BoundVariableExpression bve && bve.Variable.IsReadOnly)
        {
            // ADR-0060: address-of an `in` parameter would let callers write
            // through the pointer, defeating the read-only contract. Report
            // GS0237 instead of the generic "cannot take address of constant".
            if (bve.Variable is ParameterSymbol inParam && inParam.RefKind == RefKind.In)
            {
                Diagnostics.ReportCannotAssignToInParameter(syntax.OperatorToken.Location, inParam.Name);
            }
            else
            {
                Diagnostics.ReportCannotTakeAddressOfConstant(syntax.OperatorToken.Location, bve.Variable.Name);
            }

            return new BoundErrorExpression(null);
        }

        // Lvalue check.
        if (!IsLvalue(operand))
        {
            var exprText = syntax.Operand.ToString();
            Diagnostics.ReportCannotTakeAddressOfNonLvalue(syntax.OperatorToken.Location, exprText);
            return new BoundErrorExpression(null);
        }

        if (operand is BoundBlockExpression block)
        {
            return new BoundBlockExpression(
                null,
                block.Statements,
                new BoundAddressOfExpression(null, block.Expression, unmanaged: binderCtx.InUnsafeContext));
        }

        return new BoundAddressOfExpression(null, operand, unmanaged: binderCtx.InUnsafeContext);
    }

    /// <summary>ADR-0039: Binds <c>*expr</c> — dereferences a managed pointer.</summary>
    private BoundExpression BindDereferenceExpression(UnaryExpressionSyntax syntax)
    {
        // ADR-0122 §3 / issue #1033: `*void(expr)` is the cast to the
        // void-element pointer `*void` (the form cs2gs emits for a C#
        // `(void*)expr`, mirroring the `*uint8(p)` ≡ `(byte*)p` form). Because
        // `void` cannot bind as a value-producing conversion call, recognise
        // the syntactic shape `* void ( expr )` directly and reinterpret it as
        // a cast to `*void`. Handled before binding the operand so it is never
        // mistaken for a (rejected) dereference of a `*void` value.
        if (binderCtx.InUnsafeContext
            && syntax.Operand is CallExpressionSyntax voidCast
            && voidCast.Identifier.Kind == SyntaxKind.IdentifierToken
            && voidCast.Identifier.Text == "void"
            && voidCast.TypeArgumentList == null
            && voidCast.NullableQuestionToken == null
            && voidCast.Arguments.Count == 1)
        {
            return conversions.BindConversion(voidCast.Arguments[0], PointerTypeSymbol.Get(TypeSymbol.Void), allowExplicit: true);
        }

        // ADR-0122 §4 / issue #1034: `*Point(expr)` is the cast to a pointer to
        // a blittable user struct `*Point` — the struct analogue of the
        // primitive `*uint8(p)` cast and the `*void(p)` form. Because a struct
        // type name binds as a construction/conversion call rather than a
        // numeric conversion, recognise the syntactic shape `* IDENT ( expr )`
        // where IDENT names a blittable value struct in scope, and reinterpret
        // it as a cast to `*Struct`. Restricted to a pointer / native-int
        // argument so an ordinary struct construction `Point(x)` is unaffected.
        if (binderCtx.InUnsafeContext
            && syntax.Operand is CallExpressionSyntax structCast
            && structCast.Identifier.Kind == SyntaxKind.IdentifierToken
            && structCast.TypeArgumentList == null
            && structCast.NullableQuestionToken == null
            && structCast.Arguments.Count == 1
            && scope.TryLookupTypeAlias(structCast.Identifier.Text, out var castTarget)
            && BlittableDetector.IsBlittableValueStructPointee(castTarget))
        {
            var castArg = BindExpression(structCast.Arguments[0]);
            if (castArg.Type is PointerTypeSymbol
                || castArg.Type == TypeSymbol.NInt || castArg.Type == TypeSymbol.NUInt
                || castArg.Type == TypeSymbol.Int64 || castArg.Type == TypeSymbol.UInt64)
            {
                return new BoundConversionExpression(null, PointerTypeSymbol.Get(castTarget), castArg);
            }
        }

        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
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
        if (binderCtx.InUnsafeContext
            && syntax.Operand is CallExpressionSyntax
            && operand is BoundConversionExpression conv
            && conv.Type is { } pointee
            && (TypeSymbol.IsLegalPointeeType(pointee) || BlittableDetector.IsBlittableValueStructPointee(pointee)))
        {
            return new BoundConversionExpression(null, PointerTypeSymbol.Get(pointee), conv.Expression);
        }

        // ADR-0122 §3 / issue #1033: a true `*void` pointer carries no element
        // type and cannot be dereferenced directly; it must first be cast to a
        // typed pointer `*T` (e.g. `*int32(p)`).
        if (TypeSymbol.IsVoidPointer(operand.Type))
        {
            Diagnostics.ReportVoidPointerOperationNotAllowed(syntax.OperatorToken.Location, "dereference");
            return new BoundErrorExpression(null);
        }

        if (!TypeSymbol.TryGetPointeeType(operand.Type, out _))
        {
            Diagnostics.ReportUndefinedUnaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, operand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundDereferenceExpression(null, operand);
    }

    /// <summary>
    /// ADR-0122 / issue #1014: lowers a pointer arithmetic or comparison
    /// binary expression where at least one operand is an unmanaged pointer
    /// (<see cref="PointerTypeSymbol"/>). Returns <see langword="null"/> when
    /// the operator/operand shape is not a supported pointer operation, so the
    /// caller falls back to the normal (error-reporting) path.
    /// </summary>
    /// <param name="syntax">The binary expression syntax.</param>
    /// <param name="left">The bound left operand.</param>
    /// <param name="right">The bound right operand.</param>
    /// <returns>The lowered bound expression, or <see langword="null"/>.</returns>
    private BoundExpression TryBindPointerBinaryExpression(BinaryExpressionSyntax syntax, BoundExpression left, BoundExpression right) =>
        TryBindPointerBinaryOperation(syntax.OperatorToken.Kind, syntax.OperatorToken.Location, left, right);

    /// <summary>
    /// ADR-0122 / issue #1014: lowers a pointer arithmetic or comparison
    /// operation given the base operator token kind (not tied to a
    /// <see cref="BinaryExpressionSyntax"/>), so that both the binary form
    /// <c>p + i</c> and the compound-assignment form <c>p += i</c> (issue
    /// #2175) share the SAME pointer lowering. Returns <see langword="null"/>
    /// when the operator/operand shape is not a supported pointer operation.
    /// </summary>
    /// <param name="operatorKind">The base binary operator token kind.</param>
    /// <param name="operatorLocation">The source location used for diagnostics.</param>
    /// <param name="left">The bound left operand.</param>
    /// <param name="right">The bound right operand.</param>
    /// <returns>The lowered bound expression, or <see langword="null"/>.</returns>
    private BoundExpression TryBindPointerBinaryOperation(SyntaxKind operatorKind, TextLocation operatorLocation, BoundExpression left, BoundExpression right)
    {
        var leftPtr = left.Type as PointerTypeSymbol;
        var rightPtr = right.Type as PointerTypeSymbol;
        switch (operatorKind)
        {
            case SyntaxKind.PlusToken:
                // ADR-0122 §3 / issue #1033: a `*void` pointer has no element
                // size, so it cannot be advanced by arithmetic. Reject with
                // GS0403 (cast to a typed pointer `*T` first).
                if (TypeSymbol.IsVoidPointer(left.Type) || TypeSymbol.IsVoidPointer(right.Type))
                {
                    Diagnostics.ReportVoidPointerOperationNotAllowed(operatorLocation, "perform arithmetic on");
                    return new BoundErrorExpression(null);
                }

                if (leftPtr != null && rightPtr == null && IsPointerOffsetType(right.Type))
                {
                    return LowerPointerOffset(left, leftPtr, right, subtract: false);
                }

                if (rightPtr != null && leftPtr == null && IsPointerOffsetType(left.Type))
                {
                    return LowerPointerOffset(right, rightPtr, left, subtract: false);
                }

                return null;

            case SyntaxKind.MinusToken:
                // ADR-0122 §3 / issue #1033: pointer offset (`p - i`) and
                // pointer difference (`p - q`) both require a known element
                // size, so a `*void` operand is rejected (GS0403).
                if (TypeSymbol.IsVoidPointer(left.Type) || TypeSymbol.IsVoidPointer(right.Type))
                {
                    Diagnostics.ReportVoidPointerOperationNotAllowed(operatorLocation, "perform arithmetic on");
                    return new BoundErrorExpression(null);
                }

                if (leftPtr != null && rightPtr == null && IsPointerOffsetType(right.Type))
                {
                    return LowerPointerOffset(left, leftPtr, right, subtract: true);
                }

                // ADR-0122 / issue #1032: pointer difference `p - q` for two
                // operands of the SAME pointer type `*T` yields the scaled
                // element count as `nint`: ((nint)p - (nint)q) / sizeof(T).
                // Mismatched pointer types `*T - *U` fall through to the
                // normal error path (GS0129), matching C#.
                if (leftPtr != null && rightPtr != null && leftPtr.PointeeType == rightPtr.PointeeType)
                {
                    return LowerPointerDifference(left, right, leftPtr);
                }

                return null;

            case SyntaxKind.EqualsEqualsToken:
            case SyntaxKind.BangEqualsToken:
            case SyntaxKind.LessToken:
            case SyntaxKind.LessOrEqualsToken:
            case SyntaxKind.GreaterToken:
            case SyntaxKind.GreaterOrEqualsToken:
                return LowerPointerComparison(operatorKind, left, right);

            default:
                return null;
        }
    }

    private static bool IsPointerOffsetType(TypeSymbol type) =>
        type == TypeSymbol.Int8 || type == TypeSymbol.UInt8
        || type == TypeSymbol.Int16 || type == TypeSymbol.UInt16
        || type == TypeSymbol.Int32 || type == TypeSymbol.UInt32
        || type == TypeSymbol.Int64 || type == TypeSymbol.UInt64
        || type == TypeSymbol.NInt || type == TypeSymbol.NUInt;

    private static int StaticPointeeSize(TypeSymbol pointee)
    {
        if (pointee == TypeSymbol.Int8 || pointee == TypeSymbol.UInt8 || pointee == TypeSymbol.Bool)
        {
            return 1;
        }

        if (pointee == TypeSymbol.Int16 || pointee == TypeSymbol.UInt16 || pointee == TypeSymbol.Char)
        {
            return 2;
        }

        if (pointee == TypeSymbol.Int32 || pointee == TypeSymbol.UInt32 || pointee == TypeSymbol.Float32)
        {
            return 4;
        }

        if (pointee == TypeSymbol.Int64 || pointee == TypeSymbol.UInt64 || pointee == TypeSymbol.Float64)
        {
            return 8;
        }

        // nint/nuint and pointer-to-pointer are pointer-sized; the supported
        // execution targets are 64-bit.
        return nint.Size;
    }

    /// <summary>
    /// ADR-0122 §4 / issue #1034. Returns whether <paramref name="pointee"/> is a
    /// user/value struct pointee whose unmanaged size is not a known compile-time
    /// constant — so pointer arithmetic must scale by the emitted CIL
    /// <c>sizeof</c> opcode rather than a literal.
    /// </summary>
    private static bool IsStructPointee(TypeSymbol pointee) =>
        pointee is StructSymbol { IsClass: false }
        || (pointee is not StructSymbol and not PointerTypeSymbol
            && pointee?.ClrType is { IsValueType: true }
            && !TypeSymbol.IsLegalPointeeType(pointee));

    /// <summary>
    /// ADR-0122 §3-§4 / issues #1014, #1032, #1034. Builds an <c>nint</c>-typed
    /// expression for the size of a pointee. For a blittable struct pointee it
    /// emits the runtime <c>sizeof(T)</c> (size unknown at G# compile time); for
    /// a primitive/pointer pointee it is the static compile-time byte size.
    /// <paramref name="isOne"/> reports the static-size==1 fast path (no scaling).
    /// </summary>
    private static BoundExpression PointeeSizeAsNint(TypeSymbol pointee, out bool isOne)
    {
        if (IsStructPointee(pointee))
        {
            isOne = false;
            return new BoundConversionExpression(null, TypeSymbol.NInt, new BoundSizeOfExpression(null, pointee));
        }

        var size = StaticPointeeSize(pointee);
        isOne = size == 1;
        return new BoundConversionExpression(null, TypeSymbol.NInt, new BoundLiteralExpression(null, size, TypeSymbol.Int32));
    }

    private BoundExpression LowerPointerOffset(BoundExpression pointer, PointerTypeSymbol pointerType, BoundExpression offset, bool subtract)
    {
        var sizeExpr = PointeeSizeAsNint(pointerType.PointeeType, out var isOne);
        BoundExpression offsetNint = offset.Type == TypeSymbol.NInt
            ? offset
            : new BoundConversionExpression(null, TypeSymbol.NInt, offset);

        BoundExpression scaled = offsetNint;
        if (!isOne)
        {
            var mulOp = BoundBinaryOperator.Bind(SyntaxKind.StarToken, TypeSymbol.NInt, TypeSymbol.NInt);
            scaled = new BoundBinaryExpression(null, offsetNint, mulOp, sizeExpr);
        }

        var pointerNint = new BoundConversionExpression(null, TypeSymbol.NInt, pointer);
        var addKind = subtract ? SyntaxKind.MinusToken : SyntaxKind.PlusToken;
        var addOp = BoundBinaryOperator.Bind(addKind, TypeSymbol.NInt, TypeSymbol.NInt);
        var resultNint = new BoundBinaryExpression(null, pointerNint, addOp, scaled);
        return new BoundConversionExpression(null, pointerType, resultNint);
    }

    /// <summary>
    /// ADR-0122 / issue #1032: lowers a pointer difference <c>p - q</c> (both
    /// operands the same unmanaged pointer type <c>*T</c>) to the scaled
    /// element count as <see cref="TypeSymbol.NInt"/>:
    /// <c>((nint)p - (nint)q) / sizeof(T)</c>. Both pointers are native-int
    /// sized, so the byte difference is a signed <c>nint</c> subtraction and
    /// the divide by the static pointee size is a signed integer division,
    /// matching the C# <c>T*</c> difference semantics.
    /// </summary>
    /// <param name="left">The bound left pointer operand.</param>
    /// <param name="right">The bound right pointer operand.</param>
    /// <param name="pointerType">The common pointer type <c>*T</c>.</param>
    /// <returns>The lowered <c>nint</c> element-count expression.</returns>
    private BoundExpression LowerPointerDifference(BoundExpression left, BoundExpression right, PointerTypeSymbol pointerType)
    {
        var leftNint = new BoundConversionExpression(null, TypeSymbol.NInt, left);
        var rightNint = new BoundConversionExpression(null, TypeSymbol.NInt, right);
        var subOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.NInt, TypeSymbol.NInt);
        var byteDiff = new BoundBinaryExpression(null, leftNint, subOp, rightNint);

        var sizeExpr = PointeeSizeAsNint(pointerType.PointeeType, out var isOne);
        if (isOne)
        {
            return byteDiff;
        }

        var divOp = BoundBinaryOperator.Bind(SyntaxKind.SlashToken, TypeSymbol.NInt, TypeSymbol.NInt);
        return new BoundBinaryExpression(null, byteDiff, divOp, sizeExpr);
    }

    private BoundExpression LowerPointerComparison(SyntaxKind operatorKind, BoundExpression left, BoundExpression right)
    {
        var pointerType = (left.Type as PointerTypeSymbol) ?? (right.Type as PointerTypeSymbol);
        var leftNint = ToNativeIntForPointerComparison(left, pointerType);
        var rightNint = ToNativeIntForPointerComparison(right, pointerType);
        var op = BoundBinaryOperator.Bind(operatorKind, TypeSymbol.NInt, TypeSymbol.NInt);
        if (op == null)
        {
            return null;
        }

        return new BoundBinaryExpression(null, leftNint, op, rightNint);
    }

    private BoundExpression ToNativeIntForPointerComparison(BoundExpression operand, PointerTypeSymbol pointerType)
    {
        if (operand.Type == TypeSymbol.NInt)
        {
            return operand;
        }

        // `nil` becomes a null pointer (zero native int) before the comparison.
        if (operand.Type == TypeSymbol.Null && pointerType != null)
        {
            var nullPointer = new BoundConversionExpression(null, pointerType, operand);
            return new BoundConversionExpression(null, TypeSymbol.NInt, nullPointer);
        }

        return new BoundConversionExpression(null, TypeSymbol.NInt, operand);
    }

    /// <summary>
    /// Issue #1018: binds a throw-expression `throw expr` in value position to a
    /// <see cref="BoundThrowExpression"/> whose static type is the bottom
    /// (<see cref="TypeSymbol.Never"/>) type. The thrown operand is validated to
    /// be a <c>System.Exception</c> (or derived), mirroring the throw-statement's
    /// existing rule (<see cref="StatementBinder"/>).
    /// </summary>
    private BoundExpression BindThrowExpression(ThrowExpressionSyntax syntax)
    {
        var expression = BindExpression(syntax.Expression);
        if (expression is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        var exceptionType = ResolveExceptionType();
        if (exceptionType != null && expression.Type != TypeSymbol.Error)
        {
            var argClr = expression.Type?.ClrType;

            // Issue #319: a GSharp class that inherits an imported CLR Exception
            // type has no concrete ClrType until emit time; walk its
            // ImportedBaseType transitively to determine assignability.
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
                return new BoundErrorExpression(null);
            }
        }

        return new BoundThrowExpression(null, expression);
    }

    /// <summary>
    /// Issue #1018: resolves the <c>System.Exception</c> type symbol used to
    /// validate the operand of a throw-expression. Mirrors
    /// <see cref="StatementBinder.ResolveExceptionType"/>.
    /// </summary>
    private TypeSymbol ResolveExceptionType()
    {
        if (scope.References.TryResolveType("System.Exception", out var t))
        {
            return TypeSymbol.FromClrType(t);
        }

        return null;
    }

    private BoundExpression BindConditionalExpression(ConditionalExpressionSyntax syntax)
        => BindConditionalExpression(syntax, targetType: null);

    private BoundExpression BindConditionalExpression(ConditionalExpressionSyntax syntax, TypeSymbol targetType)
    {
        // Issue #1238: when this conditional is a bare call/constructor argument
        // whose target parameter type is not yet known, the argument-binding
        // loop set DeferTargetlessConditional so a no-common-type unification
        // failure (e.g. a `nil`/narrower arm that needs the parameter's nullable
        // type to widen) is deferred rather than reported here. Consume the flag
        // immediately so nested sub-expressions bind with normal semantics.
        var deferOnFailure = targetType == null && binderCtx.DeferTargetlessConditional;
        binderCtx.DeferTargetlessConditional = false;
        var diagMark = Diagnostics.Count;

        var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);

        // ADR-0100 / issue #795: a bare `default` branch takes its type
        // from the sibling branch. Bind whichever branch is typed first so
        // we have a concrete target type for the bare default. When both
        // branches are bare `default` the common type is unknown and the
        // expression is invalid.
        var trueIsBareDefault = syntax.WhenTrue is DefaultExpressionSyntax tDef && tDef.TypeClause == null;
        var falseIsBareDefault = syntax.WhenFalse is DefaultExpressionSyntax fDef && fDef.TypeClause == null;

        BoundExpression whenTrue;
        BoundExpression whenFalse;
        if (trueIsBareDefault && falseIsBareDefault)
        {
            Diagnostics.ReportBareDefaultNoTargetType(((DefaultExpressionSyntax)syntax.WhenTrue).DefaultKeyword.Location);
            return new BoundErrorExpression(null);
        }
        else if (trueIsBareDefault)
        {
            whenFalse = BindExpression(syntax.WhenFalse);
            if (whenFalse is BoundErrorExpression)
            {
                return new BoundErrorExpression(null);
            }

            whenTrue = new BoundDefaultExpression(syntax.WhenTrue, whenFalse.Type);
        }
        else if (falseIsBareDefault)
        {
            whenTrue = BindExpression(syntax.WhenTrue);
            if (whenTrue is BoundErrorExpression)
            {
                return new BoundErrorExpression(null);
            }

            whenFalse = new BoundDefaultExpression(syntax.WhenFalse, whenTrue.Type);
        }
        else
        {
            whenTrue = BindExpression(syntax.WhenTrue);
            whenFalse = BindExpression(syntax.WhenFalse);
        }

        if (condition is BoundErrorExpression || whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        TryAdaptConditionalIntegerLiteralArm(ref whenTrue, ref whenFalse);

        var resultType = ComputeConditionalResultType(whenTrue.Type, whenFalse.Type, targetType);
        if (resultType == null)
        {
            if (deferOnFailure)
            {
                Diagnostics.TruncateTo(diagMark);
                return new BoundErrorExpression(syntax);
            }

            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        var convertedTrue = ConvertConditionalBranch(syntax.WhenTrue.Location, whenTrue, resultType);
        var convertedFalse = ConvertConditionalBranch(syntax.WhenFalse.Location, whenFalse, resultType);
        if (convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression)
        {
            if (deferOnFailure)
            {
                Diagnostics.TruncateTo(diagMark);
                return new BoundErrorExpression(syntax);
            }

            return new BoundErrorExpression(null);
        }

        return new BoundConditionalExpression(null, condition, convertedTrue, convertedFalse, resultType);
    }

    /// <summary>
    /// Issue #669: binds an if-expression to a <see cref="BoundConditionalExpression"/>
    /// (the same bound node used by the ternary operator). Multi-statement blocks
    /// are lowered to <see cref="BoundBlockExpression"/> wrapping the final value.
    /// </summary>
    private BoundExpression BindIfExpression(IfExpressionSyntax syntax)
        => BindIfExpression(syntax, targetType: null);

    private BoundExpression BindIfExpression(IfExpressionSyntax syntax, TypeSymbol targetType)
    {
        // Issue #1238: defer a no-common-type unification failure when this
        // if-expression is a bare argument awaiting its parameter target type
        // (see BindConditionalExpression for the full rationale). Consume the
        // flag immediately so nested sub-expressions bind normally.
        var deferOnFailure = targetType == null && binderCtx.DeferTargetlessConditional;
        binderCtx.DeferTargetlessConditional = false;
        var diagMark = Diagnostics.Count;

        // An if-expression in value position must have an else branch.
        if (syntax.ElseExpression == null)
        {
            Diagnostics.ReportIfExpressionMissingElse(syntax.IfKeyword.Location);
            return new BoundErrorExpression(null);
        }

        var condition = BindExpression(syntax.Condition, TypeSymbol.Bool);

        var whenTrue = BindBlockExpressionValue(syntax.ThenBlock);
        var whenFalse = BindIfExpressionElseBranch(syntax.ElseExpression);

        if (condition is BoundErrorExpression || whenTrue is BoundErrorExpression || whenFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        TryAdaptConditionalIntegerLiteralArm(ref whenTrue, ref whenFalse);

        var resultType = ComputeConditionalResultType(whenTrue.Type, whenFalse.Type, targetType);
        if (resultType == null)
        {
            if (deferOnFailure)
            {
                Diagnostics.TruncateTo(diagMark);
                return new BoundErrorExpression(syntax);
            }

            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        var convertedTrue = ConvertConditionalBranch(syntax.ThenBlock.Location, whenTrue, resultType);
        var convertedFalse = ConvertConditionalBranch(syntax.ElseExpression.Location, whenFalse, resultType);
        if (convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression)
        {
            if (deferOnFailure)
            {
                Diagnostics.TruncateTo(diagMark);
                return new BoundErrorExpression(syntax);
            }

            return new BoundErrorExpression(null);
        }

        return new BoundConditionalExpression(null, condition, convertedTrue, convertedFalse, resultType);
    }

    /// <summary>
    /// Binds the else branch of an if-expression: either a nested if-expression
    /// (<c>else if</c> chain) or a block expression.
    /// </summary>
    private BoundExpression BindIfExpressionElseBranch(ExpressionSyntax elseSyntax)
    {
        if (elseSyntax is IfExpressionSyntax nestedIf)
        {
            return BindIfExpression(nestedIf);
        }

        if (elseSyntax is BlockExpressionSyntax block)
        {
            return BindBlockExpressionValue(block);
        }

        // Should not happen from well-formed parse trees.
        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// Binds a block-with-trailing-expression in value position. If the block
    /// has no trailing expression, reports a diagnostic. The result is either
    /// the bound trailing expression (when there are no prefix statements), or
    /// a <see cref="BoundBlockExpression"/> wrapping the prefix statements and
    /// the trailing value.
    /// </summary>
    private BoundExpression BindBlockExpressionValue(BlockExpressionSyntax syntax)
    {
        if (syntax.Expression == null)
        {
            Diagnostics.ReportBlockExpressionMissingTrailingExpression(syntax.CloseBraceToken.Location);
            return new BoundErrorExpression(null);
        }

        // If there are no prefix statements, just bind the expression directly.
        if (syntax.Statements.IsDefaultOrEmpty)
        {
            return BindExpression(syntax.Expression);
        }

        // Bind prefix statements.
        var boundStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var stmt in syntax.Statements)
        {
            var boundStmt = bindStatement(stmt);
            boundStatements.Add(boundStmt);
        }

        var boundExpression = BindExpression(syntax.Expression);
        if (boundExpression is BoundErrorExpression)
        {
            return boundExpression;
        }

        return new BoundBlockExpression(null, boundStatements.ToImmutable(), boundExpression);
    }

    /// <summary>
    /// ADR-0074 / issue #714: binds the body of an arrow lambda
    /// <c>(p T) -&gt; body</c>. The body is either a single expression
    /// (returned as the lambda's value) or a brace-delimited block
    /// expression. Unlike <see cref="BindBlockExpressionValue"/>, a block
    /// body without a trailing expression is permitted — it produces a
    /// <see cref="TypeSymbol.Void"/>-returning lambda.
    /// </summary>
    /// <param name="bodySyntax">The lambda body syntax.</param>
    /// <returns>The bound body expression. <see cref="TypeSymbol.Void"/> is
    /// allowed; a missing-trailing-expression block lowers to a
    /// <see cref="BoundBlockExpression"/> whose trailing expression is a
    /// synthesized <see cref="BoundLiteralExpression"/> placeholder of type
    /// <see cref="TypeSymbol.Void"/>.</returns>
    internal BoundExpression BindLambdaBodyExpression(ExpressionSyntax bodySyntax)
    {
        if (bodySyntax is BlockExpressionSyntax block)
        {
            // Lambda body block: a missing trailing expression means a void
            // lambda. Bind any prefix statements; if there is a trailing
            // expression, use it as the value; otherwise the value is void.
            var boundStatements = ImmutableArray.CreateBuilder<BoundStatement>();
            if (!block.Statements.IsDefaultOrEmpty)
            {
                foreach (var stmt in block.Statements)
                {
                    boundStatements.Add(bindStatement(stmt));
                }
            }

            if (block.Expression == null)
            {
                // No trailing expression — surface as a void-returning body.
                // Re-package the prefix statements via a BoundBlockExpression
                // wrapping a synthetic void placeholder; the LambdaBinder
                // treats void bodies by emitting an ExpressionStatement +
                // void return.
                if (boundStatements.Count == 0)
                {
                    // Empty body `{ }` — synthesize a no-op void expression.
                    return new BoundLiteralExpression(bodySyntax, value: 0, TypeSymbol.Void);
                }

                return new BoundBlockExpression(
                    bodySyntax,
                    boundStatements.ToImmutable(),
                    new BoundLiteralExpression(bodySyntax, value: 0, TypeSymbol.Void));
            }

            var trailing = BindExpression(block.Expression, canBeVoid: true);
            if (boundStatements.Count == 0)
            {
                return trailing;
            }

            return new BoundBlockExpression(bodySyntax, boundStatements.ToImmutable(), trailing);
        }

        return BindExpression(bodySyntax, canBeVoid: true);
    }

    /// <summary>
    /// Issue #1158: computes the conditional/if-expression result type using the
    /// same target-typing + best-common-type machinery as switch-expressions, in
    /// the following priority order (first non-null wins):
    /// <list type="number">
    ///   <item><description>Target-typing — when an explicit, valid target type is supplied and BOTH arms implicitly convert to it (C# 9+ target-typed conditional).</description></item>
    ///   <item><description>The existing pairwise <see cref="ComputeConditionalCommonType"/> (identity, never/null lift, one-way implicit, ADR-0037 numeric tie-break).</description></item>
    ///   <item><description>Best-common-type (least-upper-bound) across the two arms — unifies sibling subtypes to their shared base/interface.</description></item>
    /// </list>
    /// Returns <see langword="null"/> only when none of the three yield a type, so
    /// the caller reports GS0263.
    /// </summary>
    /// <param name="left">The true-arm type.</param>
    /// <param name="right">The false-arm type.</param>
    /// <param name="targetType">The optional target type (C#-style target-typing), or <see langword="null"/>.</param>
    /// <returns>The chosen result type, or <see langword="null"/>.</returns>
    private static TypeSymbol ComputeConditionalResultType(TypeSymbol left, TypeSymbol right, TypeSymbol targetType)
    {
        // (a) Target-typing: honor an explicit, valid target when both arms
        // implicitly convert to it.
        if (targetType != null
            && targetType != TypeSymbol.Error
            && targetType != TypeSymbol.Void
            && AllArmsImplicitlyConvertTo(new[] { left, right }, targetType))
        {
            return targetType;
        }

        // (b) Existing pairwise common type (identity, never/null, one-way
        // implicit, numeric tie-break). DO NOT alter this method's behavior.
        var pairwise = ComputeConditionalCommonType(left, right);
        if (pairwise != null)
        {
            return UnionArmNullability(pairwise, left, right);
        }

        // (c) Best-common-type (least-upper-bound) fallback: unify sibling
        // subtypes to their shared base/interface.
        return UnionArmNullability(ComputeBestCommonType(new[] { left, right }), left, right);
    }

    /// <summary>
    /// Issue #1428: the least-upper-bound of two conditional/if-expression arms
    /// must UNION the nullable annotation of both arms, independent of arm order.
    /// The pairwise/best-common routines can return a non-nullable type when one
    /// arm is non-nullable and the other is reference-convertible to it (e.g.
    /// arm0 <c>T</c>, arm1 <c>T?</c> for a reference/interface <c>T</c>, where
    /// both arms are mutually implicitly convertible), dropping the nullable
    /// annotation that the second arm contributed. This lifts the chosen result
    /// to its nullable form whenever EITHER arm is nullable, mirroring C# where
    /// <c>cond ? e : null</c> (and the reversed form) both yield <c>T?</c>.
    /// </summary>
    /// <param name="result">The chosen common type (may be <see langword="null"/>).</param>
    /// <param name="left">The true-arm type.</param>
    /// <param name="right">The false-arm type.</param>
    /// <returns>The result lifted to nullable when either arm is nullable; otherwise <paramref name="result"/>.</returns>
    private static TypeSymbol UnionArmNullability(TypeSymbol result, TypeSymbol left, TypeSymbol right)
    {
        if (result == null
            || result == TypeSymbol.Error
            || result == TypeSymbol.Never
            || result is NullableTypeSymbol)
        {
            return result;
        }

        if (left is NullableTypeSymbol || right is NullableTypeSymbol)
        {
            return NullableTypeSymbol.Get(result);
        }

        return result;
    }

    /// <summary>
    /// Issue #1232: value-producing if/conditional ergonomics. When exactly one
    /// branch is a compile-time constant integer literal and the OTHER branch is
    /// a (non-literal) integer-typed expression, adapt the literal to that
    /// integer type when its value is representable there — mirroring the
    /// constant-integer-literal adaptation that <c>BindBinaryExpression</c>
    /// performs for binary operands (#1144). This lets idiomatic forms such as
    /// <c>if cond { someUint32 } else { 0 }</c> (and the equivalent
    /// <c>cond ? someUint32 : 0</c>) unify on the wider arm's type without an
    /// explicit cast on the <c>0</c>, exactly as C# does. An out-of-range literal
    /// is left unchanged so the no-common-type path still reports GS0263.
    /// </summary>
    private void TryAdaptConditionalIntegerLiteralArm(ref BoundExpression whenTrue, ref BoundExpression whenFalse)
    {
        if (whenTrue is BoundLiteralExpression trueLit
            && IsIntegerLiteralValue(trueLit.Value)
            && whenFalse is not BoundLiteralExpression
            && IsIntegerType(whenFalse.Type)
            && TryAdaptIntegerLiteral(trueLit.Value, whenFalse.Type, out var adaptedTrue))
        {
            whenTrue = new BoundLiteralExpression(whenTrue.Syntax, adaptedTrue);
        }
        else if (whenFalse is BoundLiteralExpression falseLit
            && IsIntegerLiteralValue(falseLit.Value)
            && whenTrue is not BoundLiteralExpression
            && IsIntegerType(whenTrue.Type)
            && TryAdaptIntegerLiteral(falseLit.Value, whenTrue.Type, out var adaptedFalse))
        {
            whenFalse = new BoundLiteralExpression(whenFalse.Syntax, adaptedFalse);
        }
    }

    /// <summary>
    /// ADR-0062: chooses a common result type for two conditional branches
    /// using the following ordered rules (mirroring the ADR §2 common-type
    /// procedure):
    /// <list type="number">
    ///   <item><description>Identity (<c>Tx == Ty</c>).</description></item>
    ///   <item><description>One-way implicit conversion (<c>Tx → Ty</c> but not <c>Ty → Tx</c>, or vice versa).</description></item>
    ///   <item><description>Both convertible implicitly — pick the wider via the numeric tie-break rule (ADR-0037) when both are numeric; otherwise no common type.</description></item>
    ///   <item><description><c>nil</c> compatibility — when one arm is the nil/null sentinel and the other is reference- or nullable-compatible, use the other arm's type.</description></item>
    /// </list>
    /// Returns <see langword="null"/> when no common type exists.
    /// </summary>
    /// <param name="left">The true-arm type.</param>
    /// <param name="right">The false-arm type.</param>
    /// <returns>The chosen common type, or <see langword="null"/>.</returns>
    private static TypeSymbol ComputeConditionalCommonType(TypeSymbol left, TypeSymbol right)
    {
        if (left == null || right == null)
        {
            return null;
        }

        if (left == TypeSymbol.Error || right == TypeSymbol.Error)
        {
            return TypeSymbol.Error;
        }

        // Issue #1018: a throw-expression branch has the bottom (`never`) type,
        // which is convertible to any type. The conditional's result type is the
        // sibling branch's type. When BOTH branches throw, the result is `never`
        // too (e.g. `cond ? throw a : throw b`).
        if (left == TypeSymbol.Never)
        {
            return right;
        }

        if (right == TypeSymbol.Never)
        {
            return left;
        }

        // Identity.
        if (ReferenceEquals(left, right))
        {
            return left;
        }

        // Nil/null compatibility: when one arm is the null sentinel and the
        // other is non-null, pick the non-null. The conversion machinery
        // accepts the trivial null → reference/nullable widening. Issue #1151:
        // when the other arm is a non-nullable value type `T`, the unified type
        // must be `T?` so the value arm is lifted and the nil arm becomes the
        // null `T?` (reference and already-nullable arms are left unchanged).
        if (left == TypeSymbol.Null)
        {
            return LiftForNilArm(right);
        }

        if (right == TypeSymbol.Null)
        {
            return LiftForNilArm(left);
        }

        var leftToRight = Conversion.Classify(left, right);
        var rightToLeft = Conversion.Classify(right, left);

        bool leftImplicit = leftToRight.IsImplicit;
        bool rightImplicit = rightToLeft.IsImplicit;

        // Identity already handled; treat IsIdentity here as implicit too.
        if (leftImplicit && !rightImplicit)
        {
            return right;
        }

        if (rightImplicit && !leftImplicit)
        {
            return left;
        }

        if (leftImplicit && rightImplicit)
        {
            // ADR-0037 numeric tie-break: prefer the wider canonical numeric
            // target when both arms are numeric.
            var widened = TryNumericTieBreak(left, right);
            if (widened != null)
            {
                return widened;
            }

            // Both convert to each other and neither is numeric — they're
            // effectively identical; pick the left arm deterministically.
            return left;
        }

        return null;
    }

    /// <summary>
    /// Issue #1151: lifts a non-nullable value type to its nullable form when it
    /// is unified with a <c>nil</c> arm in an if/switch-expression. A value type
    /// <c>T</c> becomes <c>T?</c> so the value arm can be lifted and the nil arm
    /// can become the null <c>T?</c>. Reference types already legally hold
    /// <c>nil</c>, and already-nullable types are idempotent, so both are
    /// returned unchanged.
    /// </summary>
    /// <param name="type">The non-nil arm's type.</param>
    /// <returns><c>T?</c> for a non-nullable value type <c>T</c>; otherwise <paramref name="type"/>.</returns>
    private static TypeSymbol LiftForNilArm(TypeSymbol type)
    {
        if (type is not NullableTypeSymbol && type?.ClrType is { IsValueType: true })
        {
            return NullableTypeSymbol.Get(type);
        }

        return type;
    }

    /// <summary>
    /// ADR-0037-style numeric tie-break: when both arms are numeric primitives,
    /// pick the wider canonical type using a simple rank. Returns
    /// <see langword="null"/> when either type isn't a recognised primitive.
    /// </summary>
    private static TypeSymbol TryNumericTieBreak(TypeSymbol a, TypeSymbol b)
    {
        int ra = NumericRank(a);
        int rb = NumericRank(b);
        if (ra == 0 || rb == 0)
        {
            return null;
        }

        return ra >= rb ? a : b;
    }

    private static int NumericRank(TypeSymbol t)
    {
        if (t == TypeSymbol.Int8 || t == TypeSymbol.UInt8)
        {
            return 1;
        }

        if (t == TypeSymbol.Int16 || t == TypeSymbol.UInt16)
        {
            return 2;
        }

        if (t == TypeSymbol.Int32 || t == TypeSymbol.UInt32)
        {
            return 3;
        }

        if (t == TypeSymbol.Int64 || t == TypeSymbol.UInt64)
        {
            return 4;
        }

        if (t == TypeSymbol.Float32)
        {
            return 5;
        }

        if (t == TypeSymbol.Float64)
        {
            return 6;
        }

        return 0;
    }

    private BoundExpression ConvertConditionalBranch(TextLocation location, BoundExpression branch, TypeSymbol target)
    {
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
        if (branch is BoundDefaultExpression bareDefault
            && bareDefault.Type == TypeSymbol.Error
            && target != null
            && target != TypeSymbol.Error
            && target != TypeSymbol.Void)
        {
            return new BoundDefaultExpression(bareDefault.Syntax, target);
        }

        if (target == TypeSymbol.Error || branch.Type == TypeSymbol.Error)
        {
            return branch;
        }

        // Issue #1018: a throw-expression branch (bottom `never` type) is left
        // as-is — it produces no value to convert, and the emitter leaves the
        // merge point unreachable from this branch.
        if (branch.Type == TypeSymbol.Never)
        {
            return branch;
        }

        if (ReferenceEquals(branch.Type, target))
        {
            return branch;
        }

        return conversions.BindConversion(location, branch, target);
    }

    private BoundExpression BindChannelReceiveExpression(UnaryExpressionSyntax syntax)
    {
        // ADR-0082 / issue #722: gate the `<-ch` receive expression on
        // `import Gsharp.Extensions.Go`.
        binderCtx.ReportIfGoExtensionsImportMissing(syntax, syntax.OperatorToken.Location, "<- (receive)");

        var operand = BindExpression(syntax.Operand);
        if (operand is BoundErrorExpression)
        {
            return operand;
        }

        if (operand.Type is not ChannelTypeSymbol chan)
        {
            Diagnostics.ReportReceiveOperandIsNotChannel(syntax.Operand.Location, operand.Type);
            return new BoundErrorExpression(null);
        }

        return new BoundChannelReceiveExpression(null, operand, chan.ElementType);
    }

    private BoundExpression BindBinaryExpression(BinaryExpressionSyntax syntax)
        => BindBinaryExpression(syntax, coalesceTargetType: null);

    private BoundExpression BindBinaryExpression(BinaryExpressionSyntax syntax, TypeSymbol coalesceTargetType)
    {
        // Issue #1480: when a `??` argument has no contextual target type and the
        // overload binder requested deferral (DeferTargetlessConditional), a
        // no-common-type failure is parked as a placeholder retaining the syntax
        // rather than reported, then re-bound once the parameter type is known.
        // Consume the flag immediately so nested sub-expressions bind normally.
        var deferTargetlessCoalesce = syntax.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken
            && coalesceTargetType == null
            && binderCtx.DeferTargetlessConditional;
        if (syntax.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken)
        {
            binderCtx.DeferTargetlessConditional = false;
        }

        var coalesceDiagMark = Diagnostics.Count;

        var boundLeft = BindExpression(syntax.Left);

        // ADR-0069 / issue #700: `&&` short-circuits — the right operand is
        // only evaluated when the left operand was true. Thread any
        // narrowing implied by the left operand into the right-operand
        // binder so `x is T && f(x)` binds `f(x)` with `x` narrowed to `T`.
        //
        // ADR-0069 addendum / issue #712: `||` short-circuits too — the
        // right operand is only evaluated when the left operand was false.
        // Thread the left's else-frame (its negative narrowing) so
        // `!(x is T) || f(x)` binds `f(x)` with `x` narrowed to `T`.
        BoundExpression boundRight;
        if (syntax.OperatorToken.Kind == SyntaxKind.AmpersandAmpersandToken)
        {
            var rightFrame = TryClassifyTypeTestNarrowingForAnd(boundLeft);
            boundRight = BindExpressionWithNarrowing(syntax.Right, rightFrame);
        }
        else if (syntax.OperatorToken.Kind == SyntaxKind.PipePipeToken)
        {
            var rightFrame = TryClassifyTypeTestNarrowingForOr(boundLeft);
            boundRight = BindExpressionWithNarrowing(syntax.Right, rightFrame);
        }
        else
        {
            boundRight = BindExpression(syntax.Right);
        }

        if (boundLeft.Type == TypeSymbol.Error || boundRight.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        // ADR-0122 / issue #1014: pointer arithmetic (`p + i`, `i + p`, `p - i`)
        // and pointer comparison (`==`, `!=`, `<`, …) inside an unsafe context.
        // Lowered to native-int (`nint`) arithmetic/comparison plus pointer
        // reinterpret conversions — no dedicated bound node is required.
        if (boundLeft.Type is PointerTypeSymbol || boundRight.Type is PointerTypeSymbol)
        {
            var pointerResult = TryBindPointerBinaryExpression(syntax, boundLeft, boundRight);
            if (pointerResult != null)
            {
                return pointerResult;
            }
        }

        var boundOperator = BindBinaryOperatorWithNumericAdaptation(
            syntax.OperatorToken.Kind,
            ref boundLeft,
            ref boundRight,
            syntax.Left.Location,
            syntax.Right.Location);

        // Issue #1480: target-typed null-coalescing. When `a ?? b` has no natural
        // common operand type (so the standard bind produced no operator) but the
        // consuming context supplies a target type both operands implicitly
        // convert to (e.g. sibling classes `A`/`B` each implementing `IShape`,
        // coalesced where an `IShape` is expected), synthesize a NullCoalesce
        // operator whose result is the target type. The operand conversions to
        // the target are inserted by the NullCoalesce tail below; the emitter's
        // interface-merge cast (#1480) realigns each branch's stack type.
        if (boundOperator == null
            && syntax.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken
            && TryBindTargetTypedNullCoalesce(boundLeft, boundRight, coalesceTargetType, out var targetTypedCoalesce))
        {
            boundOperator = targetTypedCoalesce;
        }

        if (boundOperator == null)
        {
            // Streams D + C: user-defined `operator` methods then CLR `op_*`
            // methods, shared with the compound-assignment path (issue #1554).
            var fallback = TryBindBinaryWithUserAndClrFallback(
                syntax.OperatorToken.Kind,
                ref boundLeft,
                ref boundRight,
                syntax.Left.Location,
                syntax.Right.Location,
                out var ambiguous);
            if (fallback != null)
            {
                return fallback;
            }

            if (ambiguous)
            {
                Diagnostics.ReportAmbiguousOverload(syntax.OperatorToken.Location, syntax.OperatorToken.Text, candidateCount: 2);
                return new BoundErrorExpression(null);
            }

            // Issue #1480: a `??` whose operands share no natural common type and
            // has no contextual target is deferred (rather than reported as
            // GS0129) when it is a bare call/constructor argument awaiting its
            // parameter type — the argument-binding loop set
            // DeferTargetlessConditional. The retained syntax is re-bound with
            // the parameter type as its target by FinalizeBranchyArgument.
            if (deferTargetlessCoalesce)
            {
                Diagnostics.TruncateTo(coalesceDiagMark);
                return new BoundErrorExpression(syntax);
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
            if ((syntax.OperatorToken.Kind == SyntaxKind.EqualsEqualsToken
                    || syntax.OperatorToken.Kind == SyntaxKind.BangEqualsToken)
                && BoundBinaryOperator.IsReferenceEqualityOperand(boundLeft.Type)
                && BoundBinaryOperator.IsReferenceEqualityOperand(boundRight.Type))
            {
                var referenceOperator = BoundBinaryOperator.MakeReferenceEquality(
                    syntax.OperatorToken.Kind,
                    boundLeft.Type,
                    boundRight.Type);
                return new BoundBinaryExpression(null, boundLeft, referenceOperator, boundRight, binderCtx.IsCheckedContext);
            }

            Diagnostics.ReportUndefinedBinaryOperator(syntax.OperatorToken.Location, syntax.OperatorToken.Text, boundLeft.Type, boundRight.Type);
            return new BoundErrorExpression(null);
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
        if (boundOperator.Kind == BoundBinaryOperatorKind.NullCoalesce
            && boundRight.Type != boundOperator.Type
            && boundRight.Type != TypeSymbol.Never)
        {
            boundRight = conversions.BindConversion(syntax.Right.Location, boundRight, boundOperator.Type);
        }

        // Issue #1881: Sum/Difference/Product bound inside a `checked`
        // context trap on overflow; every other operator kind ignores the
        // flag (comparisons, bitwise ops, etc. never overflow-check).
        return new BoundBinaryExpression(null, boundLeft, boundOperator, boundRight, binderCtx.IsCheckedContext);
    }

    /// <summary>
    /// Issue #2388: true for the six comparison operators whose C# lifted
    /// form always yields a plain (non-nullable) <c>bool</c> — <c>nil == nil</c>
    /// is true, a HasValue mismatch is false/true, and two present operands
    /// unwrap and delegate to the underlying operator. Every other
    /// Stream C/D operator (arithmetic, bitwise) lifts to <c>Nullable&lt;R&gt;</c>
    /// instead, propagating a "no value" operand as a null result.
    /// </summary>
    private static bool IsClrOperatorLiftedToBool(SyntaxKind opKind) => opKind switch
    {
        SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken
            or SyntaxKind.LessToken or SyntaxKind.LessOrEqualsToken
            or SyntaxKind.GreaterToken or SyntaxKind.GreaterOrEqualsToken => true,
        _ => false,
    };

    /// <summary>
    /// Issue #2388: when a Stream C/D binary operator resolves against a
    /// value-type operand that is (or should be) wrapped in a nullable
    /// <c>Nullable&lt;T&gt;</c> — either operand is already
    /// <see cref="NullableTypeSymbol"/>, or the OTHER operand is — lifts both
    /// operands up to a matching <c>Nullable&lt;T&gt;</c> (mixed-mode: the
    /// bare non-nullable side is wrapped) and computes the operator's lifted
    /// result type. Returns <see langword="false"/> when no lifting applies
    /// (plain non-nullable call site, unchanged behavior).
    /// </summary>
    /// <param name="opKind">The operator token.</param>
    /// <param name="left">The bound left operand; replaced with its <c>Nullable&lt;T&gt;</c>-converted form when lifting applies.</param>
    /// <param name="right">The bound right operand; replaced with its <c>Nullable&lt;T&gt;</c>-converted form when lifting applies.</param>
    /// <param name="leftLocation">The left operand's source location (for the wrapping conversion).</param>
    /// <param name="rightLocation">The right operand's source location (for the wrapping conversion).</param>
    /// <param name="naturalResultType">The operator's own (non-lifted) result type.</param>
    /// <param name="liftedResultType">The lifted result type: <c>bool</c> for comparisons, <c>Nullable&lt;naturalResultType&gt;</c> otherwise.</param>
    /// <returns><see langword="true"/> when lifting applies and <paramref name="left"/>/<paramref name="right"/>/<paramref name="liftedResultType"/> were updated.</returns>
    private bool TryLiftNullableClrOperatorOperands(
        SyntaxKind opKind,
        ref BoundExpression left,
        ref BoundExpression right,
        TextLocation leftLocation,
        TextLocation rightLocation,
        TypeSymbol naturalResultType,
        out TypeSymbol liftedResultType)
    {
        liftedResultType = null;

        bool leftIsNullableValueType = left.Type is NullableTypeSymbol leftNullable
            && leftNullable.UnderlyingType?.ClrType is { IsValueType: true };
        bool rightIsNullableValueType = right.Type is NullableTypeSymbol rightNullable
            && rightNullable.UnderlyingType?.ClrType is { IsValueType: true };

        // A struct-typed same-compilation operand has no static ClrType, so
        // the `IsValueType: true` check above never matches it directly —
        // detect that shape via NullableTypeSymbol alone (any nullable
        // wrapper) so `MyStruct? == MyStruct?` (Stream D) also lifts.
        bool leftIsNullableStruct = left.Type is NullableTypeSymbol leftStructNullable
            && leftStructNullable.UnderlyingType is StructSymbol;
        bool rightIsNullableStruct = right.Type is NullableTypeSymbol rightStructNullable
            && rightStructNullable.UnderlyingType is StructSymbol;

        leftIsNullableValueType |= leftIsNullableStruct;
        rightIsNullableValueType |= rightIsNullableStruct;

        if (!leftIsNullableValueType && !rightIsNullableValueType)
        {
            return false;
        }

        var leftLiftedType = leftIsNullableValueType ? (NullableTypeSymbol)left.Type : NullableTypeSymbol.Get(left.Type);
        var rightLiftedType = rightIsNullableValueType ? (NullableTypeSymbol)right.Type : NullableTypeSymbol.Get(right.Type);

        left = conversions.BindConversion(leftLocation, left, leftLiftedType);
        right = conversions.BindConversion(rightLocation, right, rightLiftedType);

        liftedResultType = IsClrOperatorLiftedToBool(opKind)
            ? (TypeSymbol)TypeSymbol.Bool
            : NullableTypeSymbol.Get(naturalResultType);
        return true;
    }

    /// <summary>
    /// Issue #1554: shared fallback that resolves a binary operator via the
    /// user-defined operator path (Stream D) and then the CLR <c>op_*</c> path
    /// (Stream C), in that order, for both the plain binary expression
    /// (<c>lhs op rhs</c>) and the compound-assignment (<c>lhs op= rhs</c>)
    /// paths. It is invoked only after the built-in numeric operator has failed
    /// to bind, so that a compound assignment falls back to exactly the same
    /// user/BCL operator resolution that the equivalent binary expression uses.
    /// </summary>
    /// <param name="opKind">The base binary operator token kind.</param>
    /// <param name="left">The bound left operand (adapted by the built-in attempt).</param>
    /// <param name="right">The bound right operand (adapted by the built-in attempt).</param>
    /// <param name="leftLocation">The source location of the left operand.</param>
    /// <param name="rightLocation">The source location of the right operand.</param>
    /// <param name="ambiguous">Set to <see langword="true"/> when CLR operator resolution found multiple equally-applicable candidates.</param>
    /// <returns>The bound user/CLR operator call, or <see langword="null"/> when neither resolves.</returns>
    private BoundExpression TryBindBinaryWithUserAndClrFallback(
        SyntaxKind opKind,
        ref BoundExpression left,
        ref BoundExpression right,
        TextLocation leftLocation,
        TextLocation rightLocation,
        out bool ambiguous)
    {
        ambiguous = false;

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
        var userOpName = OperatorNames.TryGetBinaryName(opKind);
        if (userOpName != null)
        {
            var leftStructType = left.Type is NullableTypeSymbol leftNullableForStruct
                ? leftNullableForStruct.UnderlyingType as StructSymbol
                : left.Type as StructSymbol;
            var rightStructType = right.Type is NullableTypeSymbol rightNullableForStruct
                ? rightNullableForStruct.UnderlyingType as StructSymbol
                : right.Type as StructSymbol;

            FunctionSymbol userOp = null;
            if (leftStructType != null && TypeMemberModel.TryGetStaticMethodIncludingInherited(leftStructType, userOpName, out var leftOp))
            {
                userOp = leftOp;
            }
            else if (rightStructType != null && TypeMemberModel.TryGetStaticMethodIncludingInherited(rightStructType, userOpName, out var rightOp))
            {
                userOp = rightOp;
            }
            else if (left.Type != null && scope.TryLookupExtensionFunction(left.Type, userOpName, out var leftExt))
            {
                userOp = leftExt;
            }
            else if (right.Type != null && scope.TryLookupExtensionFunction(right.Type, userOpName, out var rightExt))
            {
                userOp = rightExt;
            }

            if (userOp != null && userOp.Parameters.Length == 2)
            {
                if (TryLiftNullableClrOperatorOperands(opKind, ref left, ref right, leftLocation, rightLocation, userOp.Type, out var liftedResultType))
                {
                    return new BoundClrBinaryOperatorExpression(null, opKind, left, right, userOp, liftedResultType);
                }

                var convertedLeft = conversions.BindConversion(leftLocation, left, userOp.Parameters[0].Type);
                var convertedRight = conversions.BindConversion(rightLocation, right, userOp.Parameters[1].Type);
                return new BoundCallExpression(null, userOp, ImmutableArray.Create(convertedLeft, convertedRight));
            }
        }

        // Stream C: fall back to a public-static `op_*` method on either
        // operand's CLR type (TimeSpan + TimeSpan, BigInteger * int, ...).
        if ((left.Type?.ClrType != null || right.Type?.ClrType != null)
            && ClrOperatorResolution.TryResolveBinary(opKind, left.Type, right.Type, out var clrMethod, out ambiguous))
        {
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
            if (TryLiftNullableClrOperatorOperands(opKind, ref left, ref right, leftLocation, rightLocation, TypeSymbol.FromClrType(clrMethod.ReturnType), out var liftedClrResultType))
            {
                return new BoundClrBinaryOperatorExpression(null, opKind, left, right, clrMethod, liftedClrResultType);
            }

            return new BoundClrBinaryOperatorExpression(
                null,
                opKind,
                left,
                right,
                clrMethod,
                TypeSymbol.FromClrType(clrMethod.ReturnType));
        }

        return null;
    }

    /// <summary>
    /// Issue #1480: attempts to bind a target-typed null-coalescing operator.
    /// Succeeds when a non-null contextual <paramref name="target"/> is supplied
    /// and BOTH operands implicitly convert to it — the left operand's non-null
    /// underlying type and the right operand's type. This covers the C# §12.15
    /// target-typed case where the two operands share no natural common type but
    /// the result is consumed at a type both convert to (e.g. sibling classes
    /// each implementing a common interface). A <c>never</c> (throw) right
    /// operand is left to the normal <c>x ?? throw</c> path.
    /// </summary>
    /// <param name="boundLeft">The bound left operand.</param>
    /// <param name="boundRight">The bound right operand.</param>
    /// <param name="target">The contextual target type, or <see langword="null"/>.</param>
    /// <param name="op">The synthesized NullCoalesce operator on success.</param>
    /// <returns><see langword="true"/> when a target-typed operator was built.</returns>
    private bool TryBindTargetTypedNullCoalesce(BoundExpression boundLeft, BoundExpression boundRight, TypeSymbol target, out BoundBinaryOperator op)
    {
        op = null;
        if (target == null
            || target == TypeSymbol.Error
            || target == TypeSymbol.Void
            || boundLeft.Type == TypeSymbol.Error
            || boundRight.Type == TypeSymbol.Error
            || boundRight.Type == TypeSymbol.Never)
        {
            return false;
        }

        var leftUnderlying = boundLeft.Type is NullableTypeSymbol leftNullable ? leftNullable.UnderlyingType : boundLeft.Type;
        if (leftUnderlying == null || leftUnderlying == TypeSymbol.Null)
        {
            return false;
        }

        var leftConv = Conversion.Classify(leftUnderlying, target);
        var rightConv = Conversion.Classify(boundRight.Type, target);
        if (leftConv.Exists && leftConv.IsImplicit && rightConv.Exists && rightConv.IsImplicit)
        {
            op = BoundBinaryOperator.MakeNullCoalesce(boundLeft.Type, boundRight.Type, target);
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1246: shared numeric-operand adaptation for binding a binary
    /// operator. Attempts an exact per-type bind first, then — when that fails —
    /// applies, in order, the same adaptations <c>BindBinaryExpression</c>
    /// performs: constant-integer-literal adaptation (#1144), directional
    /// implicit integer widening (#1150), the value-type and heterogeneous
    /// nullable mixed-mode lifts, and lifted (nullable) numeric widening (#1236).
    /// Any inserted conversions mutate <paramref name="boundLeft"/> /
    /// <paramref name="boundRight"/> in place. This is factored out so compound
    /// assignment (<c>a op= b</c>) widens its right operand exactly like the
    /// equivalent binary expression <c>a op b</c>. Returns the bound operator,
    /// or <see langword="null"/> when no numeric adaptation makes the operator
    /// bind (the caller then reports GS0129 or tries user/CLR operator
    /// fallbacks).
    /// </summary>
    private BoundBinaryOperator BindBinaryOperatorWithNumericAdaptation(
        SyntaxKind operatorKind,
        ref BoundExpression boundLeft,
        ref BoundExpression boundRight,
        TextLocation leftLocation,
        TextLocation rightLocation)
    {
        var boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);

        // Issue #1923: boxed-constant equality (`answer == 42` where `answer`
        // is typed `object`). The operator table only registers the
        // homogeneous `object == object -> bool` arm, so a non-`object`
        // operand (e.g. an `int32` constant on the other side) previously
        // fell through to GS0129 "operator not defined for 'object' and
        // 'int32'" even though C# boxes the value-type operand and compares
        // by reference identity. When exactly one side is `object` and the
        // OTHER side has an implicit (boxing) conversion to `object`, box it
        // and rebind the homogeneous `object == object` operator.
        if (boundOperator == null && (operatorKind == SyntaxKind.EqualsEqualsToken || operatorKind == SyntaxKind.BangEqualsToken))
        {
            if (boundLeft.Type == TypeSymbol.Object
                && boundRight.Type != TypeSymbol.Object
                && Conversion.Classify(boundRight.Type, TypeSymbol.Object).IsImplicit)
            {
                boundRight = conversions.BindConversion(rightLocation, boundRight, TypeSymbol.Object);
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
            }
            else if (boundRight.Type == TypeSymbol.Object
                && boundLeft.Type != TypeSymbol.Object
                && Conversion.Classify(boundLeft.Type, TypeSymbol.Object).IsImplicit)
            {
                boundLeft = conversions.BindConversion(leftLocation, boundLeft, TypeSymbol.Object);
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
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
        if (boundOperator == null && (operatorKind == SyntaxKind.EqualsEqualsToken || operatorKind == SyntaxKind.BangEqualsToken))
        {
            if (EnumOperatorTable.IsEnumType(boundLeft.Type)
                && !EnumOperatorTable.IsEnumType(boundRight.Type)
                && TryGetConstantIntegerValue(boundRight, out var rightZero)
                && rightZero.IsZero
                && TryAdaptIntegerLiteral(rightZero, EnumOperatorTable.GetUnderlyingType(boundLeft.Type), out var rightZeroValue))
            {
                boundRight = new BoundLiteralExpression(boundRight.Syntax, rightZeroValue, boundLeft.Type);
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
            }
            else if (EnumOperatorTable.IsEnumType(boundRight.Type)
                && !EnumOperatorTable.IsEnumType(boundLeft.Type)
                && TryGetConstantIntegerValue(boundLeft, out var leftZero)
                && leftZero.IsZero
                && TryAdaptIntegerLiteral(leftZero, EnumOperatorTable.GetUnderlyingType(boundRight.Type), out var leftZeroValue))
            {
                boundLeft = new BoundLiteralExpression(boundLeft.Syntax, leftZeroValue, boundRight.Type);
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
            }
        }

        // issue #1144: constant integer-literal adaptation (C#-style
        // constant-expression conversion). When exactly one operand is a
        // compile-time constant integer literal and the OTHER operand is a
        // (non-literal) integer type, the literal implicitly adapts to that
        // integer type provided its value is representable there. An OUT-OF-RANGE
        // literal is NOT adapted, so the GS0129 path still reports an error.
        if (boundOperator == null)
        {
            if (boundLeft is BoundLiteralExpression leftLit
                && IsIntegerLiteralValue(leftLit.Value)
                && boundRight is not BoundLiteralExpression
                && IsIntegerType(boundRight.Type)
                && TryAdaptIntegerLiteral(leftLit.Value, boundRight.Type, out var adaptedLeftValue))
            {
                boundLeft = new BoundLiteralExpression(boundLeft.Syntax, adaptedLeftValue);
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
            }
            else if (boundRight is BoundLiteralExpression rightLit
                && IsIntegerLiteralValue(rightLit.Value)
                && boundLeft is not BoundLiteralExpression
                && IsIntegerType(boundLeft.Type)
                && TryAdaptIntegerLiteral(rightLit.Value, boundLeft.Type, out var adaptedRightValue))
            {
                boundRight = new BoundLiteralExpression(boundRight.Syntax, adaptedRightValue);
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
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
        if (boundOperator == null
            && (operatorKind == SyntaxKind.ShiftLeftToken || operatorKind == SyntaxKind.ShiftRightToken || operatorKind == SyntaxKind.UnsignedShiftRightToken)
            && IsIntegerType(boundLeft.Type)
            && (IsIntegerType(boundRight.Type) || boundRight.Type == TypeSymbol.Char)
            && boundRight.Type != TypeSymbol.Int32
            && Conversion.Classify(boundRight.Type, TypeSymbol.Int32).IsImplicit)
        {
            boundRight = conversions.BindConversion(rightLocation, boundRight, TypeSymbol.Int32);
            boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
        }

        // Issue #1150: directional implicit integer widening between two TYPED
        // integer operands. When the initial per-type operator bind failed and
        // NEITHER operand is a constant integer literal, but exactly one
        // operand's integer type implicitly, losslessly widens to the OTHER
        // operand's integer type, widen the narrower operand and re-bind. When
        // NEITHER operand widens to the other the operator stays unbound.
        if (boundOperator == null
            && boundLeft is not BoundLiteralExpression
            && boundRight is not BoundLiteralExpression
            && IsIntegerType(boundLeft.Type)
            && IsIntegerType(boundRight.Type)
            && boundLeft.Type != boundRight.Type)
        {
            if (Conversion.Classify(boundLeft.Type, boundRight.Type).IsImplicit)
            {
                boundLeft = conversions.BindConversion(leftLocation, boundLeft, boundRight.Type);
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
            }
            else if (Conversion.Classify(boundRight.Type, boundLeft.Type).IsImplicit)
            {
                boundRight = conversions.BindConversion(rightLocation, boundRight, boundLeft.Type);
                boundOperator = BoundBinaryOperator.Bind(operatorKind, boundLeft.Type, boundRight.Type);
            }
        }

        // PR N-4 / §6.1 / C# §7.3.7: mixed-mode lift. When one operand is a
        // value-type Nullable<T> and the other is its underlying T, lift T to T?
        // and re-bind the homogeneous lifted operator.
        if (boundOperator == null)
        {
            if (boundLeft.Type is NullableTypeSymbol leftNullable
                && leftNullable.UnderlyingType?.ClrType is { IsValueType: true }
                && boundRight.Type == leftNullable.UnderlyingType)
            {
                var lifted = BoundBinaryOperator.Bind(operatorKind, leftNullable, leftNullable);
                if (lifted != null)
                {
                    boundRight = conversions.BindConversion(rightLocation, boundRight, leftNullable);
                    boundOperator = lifted;
                }
            }
            else if (boundRight.Type is NullableTypeSymbol rightNullable
                && rightNullable.UnderlyingType?.ClrType is { IsValueType: true }
                && boundLeft.Type == rightNullable.UnderlyingType)
            {
                var lifted = BoundBinaryOperator.Bind(operatorKind, rightNullable, rightNullable);
                if (lifted != null)
                {
                    boundLeft = conversions.BindConversion(leftLocation, boundLeft, rightNullable);
                    boundOperator = lifted;
                }
            }
        }

        // 6.6 / §6.1: mixed-mode lift for heterogeneous nullable operands.
        if (boundOperator == null)
        {
            if (boundLeft.Type is NullableTypeSymbol leftN2
                && boundRight.Type is not NullableTypeSymbol
                && boundRight.Type?.ClrType is { IsValueType: true })
            {
                var rightLifted = NullableTypeSymbol.Get(boundRight.Type);
                var lifted = BoundBinaryOperator.Bind(operatorKind, leftN2, rightLifted);
                if (lifted != null)
                {
                    boundRight = conversions.BindConversion(rightLocation, boundRight, rightLifted);
                    boundOperator = lifted;
                }
            }
            else if (boundRight.Type is NullableTypeSymbol rightN2
                && boundLeft.Type is not NullableTypeSymbol
                && boundLeft.Type?.ClrType is { IsValueType: true })
            {
                var leftLifted = NullableTypeSymbol.Get(boundLeft.Type);
                var lifted = BoundBinaryOperator.Bind(operatorKind, leftLifted, rightN2);
                if (lifted != null)
                {
                    boundLeft = conversions.BindConversion(leftLocation, boundLeft, leftLifted);
                    boundOperator = lifted;
                }
            }
        }

        // Issue #1236: lifted (nullable) numeric widening + constant-integer-
        // literal adaptation on the UNDERLYING numeric types when at least one
        // operand is a value-type Nullable<T>.
        if (boundOperator == null
            && (boundLeft.Type is NullableTypeSymbol || boundRight.Type is NullableTypeSymbol))
        {
            var leftUnderlying = boundLeft.Type is NullableTypeSymbol leftNum ? leftNum.UnderlyingType : boundLeft.Type;
            var rightUnderlying = boundRight.Type is NullableTypeSymbol rightNum ? rightNum.UnderlyingType : boundRight.Type;
            TypeSymbol commonUnderlying = null;

            if (leftUnderlying != null && rightUnderlying != null)
            {
                if (boundLeft is BoundLiteralExpression leftNumLit
                    && IsIntegerLiteralValue(leftNumLit.Value)
                    && boundRight is not BoundLiteralExpression
                    && IsIntegerType(rightUnderlying)
                    && TryAdaptIntegerLiteral(leftNumLit.Value, rightUnderlying, out var adaptedLeftNum))
                {
                    boundLeft = new BoundLiteralExpression(boundLeft.Syntax, adaptedLeftNum);
                    commonUnderlying = rightUnderlying;
                }
                else if (boundRight is BoundLiteralExpression rightNumLit
                    && IsIntegerLiteralValue(rightNumLit.Value)
                    && boundLeft is not BoundLiteralExpression
                    && IsIntegerType(leftUnderlying)
                    && TryAdaptIntegerLiteral(rightNumLit.Value, leftUnderlying, out var adaptedRightNum))
                {
                    boundRight = new BoundLiteralExpression(boundRight.Syntax, adaptedRightNum);
                    commonUnderlying = leftUnderlying;
                }
                else if (IsIntegerType(leftUnderlying)
                    && IsIntegerType(rightUnderlying)
                    && leftUnderlying != rightUnderlying
                    && boundLeft is not BoundLiteralExpression
                    && boundRight is not BoundLiteralExpression)
                {
                    if (Conversion.Classify(leftUnderlying, rightUnderlying).IsImplicit)
                    {
                        commonUnderlying = rightUnderlying;
                    }
                    else if (Conversion.Classify(rightUnderlying, leftUnderlying).IsImplicit)
                    {
                        commonUnderlying = leftUnderlying;
                    }
                }
            }

            if (commonUnderlying != null)
            {
                var commonNullable = NullableTypeSymbol.Get(commonUnderlying);
                var lifted = BoundBinaryOperator.Bind(operatorKind, commonNullable, commonNullable);
                if (lifted != null)
                {
                    boundLeft = conversions.BindConversion(leftLocation, boundLeft, commonNullable);
                    boundRight = conversions.BindConversion(rightLocation, boundRight, commonNullable);
                    boundOperator = lifted;
                }
            }
        }

        return boundOperator;
    }

    // issue #1144: the ten G# integer primitive types (signed + unsigned,
    // including the native-int pair). Membership mirrors the integral sets in
    // BoundBinaryOperator.
    internal static bool IsIntegerType(TypeSymbol type)
    {
        return type == TypeSymbol.Int8 || type == TypeSymbol.Int16 || type == TypeSymbol.Int32
            || type == TypeSymbol.Int64 || type == TypeSymbol.NInt
            || type == TypeSymbol.UInt8 || type == TypeSymbol.UInt16 || type == TypeSymbol.UInt32
            || type == TypeSymbol.UInt64 || type == TypeSymbol.NUInt;
    }

    // issue #1144: true when the boxed literal value is a compile-time constant
    // INTEGER (excludes char/bool/float/decimal/string/enum, which never adapt).
    internal static bool IsIntegerLiteralValue(object value)
    {
        return value is sbyte or byte or short or ushort or int or uint or long or ulong or nint or nuint;
    }

    // issue #1183: widen a boxed integer literal value to a sign-agnostic
    // BigInteger carrier so the full int64/uint64 range round-trips.
    internal static BigInteger ToBigInteger(object value)
    {
        return value switch
        {
            sbyte s => s,
            byte b => b,
            short s => s,
            ushort u => u,
            int i => i,
            uint u => u,
            long l => l,
            ulong u => u,
            nint n => (long)n,
            nuint n => (ulong)n,
            _ => default,
        };
    }

    // issue #1183: C# §10.2.11 constant-expression support. Extract the
    // compile-time integer value of a constant integer expression — a bare
    // integer literal or a unary +/- applied (recursively) to one. Returns
    // false for any non-constant or non-integer expression so the caller
    // falls back to the ordinary (explicit) numeric conversion classification.
    internal static bool TryGetConstantIntegerValue(BoundExpression expression, out BigInteger value)
    {
        value = default;
        switch (expression)
        {
            case BoundLiteralExpression lit when IsIntegerLiteralValue(lit.Value):
                value = ToBigInteger(lit.Value);
                return true;
            case BoundUnaryExpression { Op.Kind: BoundUnaryOperatorKind.Identity } identity:
                return TryGetConstantIntegerValue(identity.Operand, out value);
            case BoundUnaryExpression { Op.Kind: BoundUnaryOperatorKind.Negation } negation
                when TryGetConstantIntegerValue(negation.Operand, out var inner):
                value = -inner;
                return true;
            default:
                return false;
        }
    }

    // issue #1144: try to adapt a constant integer literal to the target integer
    // type. Uses BigInteger as a wide, sign-agnostic carrier so the full uint64
    // range is handled, and range-checks against the target's min/max before
    // producing a boxed value whose CLR type maps (via BoundLiteralExpression's
    // InferType) to EXACTLY the target type. Native ints are range-tested
    // conservatively as int64 (nint) / uint64 (nuint) so the result is stable
    // regardless of the host process pointer width.
    internal static bool TryAdaptIntegerLiteral(object value, TypeSymbol target, out object converted)
    {
        converted = null;
        if (!IsIntegerLiteralValue(value))
        {
            return false;
        }

        return TryAdaptIntegerLiteral(ToBigInteger(value), target, out converted);
    }

    // issue #1183: BigInteger-carrier overload shared by the constant-expression
    // narrowing path (which folds unary +/- before classifying) and the boxed
    // literal adaptation above. Range-checks against the target integer type's
    // min/max before producing a boxed value whose CLR type maps (via
    // BoundLiteralExpression.InferType) to EXACTLY the target type.
    internal static bool TryAdaptIntegerLiteral(BigInteger v, TypeSymbol target, out object converted)
    {
        converted = null;
        BigInteger min;
        BigInteger max;
        if (target == TypeSymbol.Int8)
        {
            min = sbyte.MinValue;
            max = sbyte.MaxValue;
        }
        else if (target == TypeSymbol.UInt8)
        {
            min = byte.MinValue;
            max = byte.MaxValue;
        }
        else if (target == TypeSymbol.Int16)
        {
            min = short.MinValue;
            max = short.MaxValue;
        }
        else if (target == TypeSymbol.UInt16)
        {
            min = ushort.MinValue;
            max = ushort.MaxValue;
        }
        else if (target == TypeSymbol.Int32)
        {
            min = int.MinValue;
            max = int.MaxValue;
        }
        else if (target == TypeSymbol.UInt32)
        {
            min = uint.MinValue;
            max = uint.MaxValue;
        }
        else if (target == TypeSymbol.Int64 || target == TypeSymbol.NInt)
        {
            min = long.MinValue;
            max = long.MaxValue;
        }
        else if (target == TypeSymbol.UInt64 || target == TypeSymbol.NUInt)
        {
            min = ulong.MinValue;
            max = ulong.MaxValue;
        }
        else
        {
            return false;
        }

        if (v < min || v > max)
        {
            return false;
        }

        if (target == TypeSymbol.Int8)
        {
            converted = (sbyte)v;
        }
        else if (target == TypeSymbol.UInt8)
        {
            converted = (byte)v;
        }
        else if (target == TypeSymbol.Int16)
        {
            converted = (short)v;
        }
        else if (target == TypeSymbol.UInt16)
        {
            converted = (ushort)v;
        }
        else if (target == TypeSymbol.Int32)
        {
            converted = (int)v;
        }
        else if (target == TypeSymbol.UInt32)
        {
            converted = (uint)v;
        }
        else if (target == TypeSymbol.Int64)
        {
            converted = (long)v;
        }
        else if (target == TypeSymbol.UInt64)
        {
            converted = (ulong)v;
        }
        else if (target == TypeSymbol.NInt)
        {
            converted = (nint)(long)v;
        }
        else
        {
            converted = (nuint)(ulong)v;
        }

        return true;
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
    internal static bool IsImplicitConstantNarrowingArgument(BoundExpression argument, TypeSymbol parameterType)
    {
        return argument != null
            && parameterType != null
            && IsIntegerType(parameterType)
            && TryGetConstantIntegerValue(argument, out var value)
            && TryAdaptIntegerLiteral(value, parameterType, out _);
    }

    // Issue #1311: builds the per-call constant-narrowing applicability hook for
    // imported/BCL overload resolution (OverloadResolution.Resolve). The hook
    // receives the source-argument index (into argTypes) and the candidate's CLR
    // parameter type; it returns true when the corresponding bound argument is a
    // constant integer expression whose value fits that (possibly narrower /
    // cross-sign) integer parameter — i.e. the same §10.2.11 rule applied on the
    // user-method path. `argumentOffset` accounts for a synthesised leading
    // receiver slot (imported extension calls pass [receiver, args…], offset 1).
    internal static Func<int, System.Type, bool> MakeConstantNarrowingArgumentCheck(
        IReadOnlyList<BoundExpression> boundArguments,
        int argumentOffset = 0)
    {
        if (boundArguments == null)
        {
            return null;
        }

        return (index, clrParameterType) =>
        {
            var argIndex = index - argumentOffset;
            if (argIndex < 0 || argIndex >= boundArguments.Count || clrParameterType == null)
            {
                return false;
            }

            // A constant literal can never bind by-ref; peel defensively so a
            // by-ref parameter maps to its element type rather than a managed
            // pointer (which TypeSymbol.FromClrType cannot represent).
            if (clrParameterType.IsByRef)
            {
                clrParameterType = clrParameterType.GetElementType();
            }

            return IsImplicitConstantNarrowingArgument(boundArguments[argIndex], TypeSymbol.FromClrType(clrParameterType));
        };
    }

    // ADR-0148: imported overload resolution works on CLR Type surrogates and
    // cannot see a G# argument's symbolic public shape. Supply that context as
    // a call-local applicability callback; by-ref parameters remain excluded.
    internal static Func<int, System.Type, bool> MakeStructuralProjectionArgumentCheck(
        IReadOnlyList<BoundExpression> boundArguments,
        int argumentOffset = 0)
    {
        if (boundArguments == null)
        {
            return null;
        }

        return (index, clrParameterType) =>
        {
            var argIndex = index - argumentOffset;
            if (argIndex < 0
                || argIndex >= boundArguments.Count
                || clrParameterType == null
                || clrParameterType.IsByRef)
            {
                return false;
            }

            return StructuralProjectionPlanner.CanProject(
                boundArguments[argIndex].Type,
                TypeSymbol.FromClrType(clrParameterType));
        };
    }
}
