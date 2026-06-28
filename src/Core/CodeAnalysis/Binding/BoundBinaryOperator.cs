// <copyright file="BoundBinaryOperator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound binary operator.
/// </summary>
public sealed class BoundBinaryOperator
{
    private static readonly TypeSymbol[] SignedIntegralTypes =
    {
        TypeSymbol.Int8, TypeSymbol.Int16, TypeSymbol.Int32, TypeSymbol.Int64, TypeSymbol.NInt,
    };

    private static readonly TypeSymbol[] UnsignedIntegralTypes =
    {
        TypeSymbol.UInt8, TypeSymbol.UInt16, TypeSymbol.UInt32, TypeSymbol.UInt64, TypeSymbol.NUInt,
    };

    private static readonly TypeSymbol[] FloatingPointTypes =
    {
        TypeSymbol.Float32, TypeSymbol.Float64,
    };

    private static BoundBinaryOperator[] supportedOperators = BuildSupportedOperators();

    private BoundBinaryOperator(SyntaxKind syntaxKind, BoundBinaryOperatorKind kind, TypeSymbol type)
        : this(syntaxKind, kind, type, type, type)
    {
    }

    private BoundBinaryOperator(SyntaxKind syntaxKind, BoundBinaryOperatorKind kind, TypeSymbol operandType, TypeSymbol resultType)
        : this(syntaxKind, kind, operandType, operandType, resultType)
    {
    }

    private BoundBinaryOperator(SyntaxKind syntaxKind, BoundBinaryOperatorKind kind, TypeSymbol leftType, TypeSymbol rightType, TypeSymbol resultType)
    {
        SyntaxKind = syntaxKind;
        Kind = kind;
        LeftType = leftType;
        RightType = rightType;
        Type = resultType;
    }

    /// <summary>
    /// Gets the syntax kind.
    /// </summary>
    public SyntaxKind SyntaxKind { get; }

    /// <summary>
    /// Gets the bound binary operator kind.
    /// </summary>
    public BoundBinaryOperatorKind Kind { get; }

    /// <summary>
    /// Gets the left type symbol.
    /// </summary>
    public TypeSymbol LeftType { get; }

    /// <summary>
    /// Gets the right type symbol.
    /// </summary>
    public TypeSymbol RightType { get; }

    /// <summary>
    /// Gets the bound binary operator type symbol.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>
    /// Binds a syntax kind and a type symbol to the corresponding bound binary operator, or
    /// null if the syntax kind isn't a binary operator, or is not a supported binary operator.
    /// </summary>
    /// <param name="syntaxKind">The syntax kind.</param>
    /// <param name="leftType">The left type symbol.</param>
    /// <param name="rightType">The right type symbol.</param>
    /// <returns>A bound unary operator.</returns>
    public static BoundBinaryOperator Bind(SyntaxKind syntaxKind, TypeSymbol leftType, TypeSymbol rightType)
    {
        foreach (var op in supportedOperators)
        {
            if (op.SyntaxKind == syntaxKind && op.LeftType == leftType && op.RightType == rightType)
            {
                return op;
            }
        }

        // Phase 4.2 / ADR-0020: `==` / `!=` on a `comparable`-constrained type parameter.
        // Allowed only when both operands are the SAME type-parameter symbol whose
        // constraint is `Comparable`. (`any` falls through to "operator undefined".)
        //
        // Issue #614 audit: intentionally a single arm — only 2 operators (== / !=)
        // gated by a narrow type-parameter predicate. No combinatorial growth risk;
        // a table would add indirection without reducing duplication.
        if ((syntaxKind == SyntaxKind.EqualsEqualsToken || syntaxKind == SyntaxKind.BangEqualsToken)
            && leftType is TypeParameterSymbol ltp && ltp == rightType
            && ltp.Constraint == TypeParameterConstraint.Comparable)
        {
            var cmpKind = syntaxKind == SyntaxKind.EqualsEqualsToken
                ? BoundBinaryOperatorKind.Equals
                : BoundBinaryOperatorKind.NotEquals;
            return new BoundBinaryOperator(syntaxKind, cmpKind, ltp, ltp, TypeSymbol.Bool);
        }

        // Issues #534, #574, and 6.6 unification: all C# §11.10 enum
        // operators (==, !=, <, <=, >, >=, |, &, ^, + underlying,
        // - underlying, - enum) drive through the single EnumOperatorTable.
        // Adding a new enum-supported operator group is a one-row change in
        // that table — no new arm here.
        if (EnumOperatorTable.TryBindBinary(syntaxKind, leftType, rightType, out var enumKind, out var enumResultType))
        {
            return new BoundBinaryOperator(syntaxKind, enumKind, leftType, rightType, enumResultType);
        }

        // Issue #1298: lifted equality / inequality over a nullable user-defined
        // enum (`E? == E`, `E? != E`, `E? == E?`, …). A user-declared
        // EnumSymbol has no static CLR type, so the generic value-type lifted
        // arms further below (gated on `UnderlyingType.ClrType.IsValueType`)
        // skip it, and BCL nullable enums never reach here because their
        // underlying carries a real ClrType. Bind the comparison directly to
        // `bool` whenever both operands denote the SAME user enum and at least
        // one side is its nullable form; the emitter lowers it via
        // `box Nullable<E>` + `Object.Equals` (C# `Nullable<T>` lifted
        // equality semantics). Operands are left unlifted so each side boxes
        // with its own type token. Non-nullable `E == E` is already handled by
        // the EnumOperatorTable arm above; `E? == nil` by the IsNullCompare arm
        // below.
        if (syntaxKind == SyntaxKind.EqualsEqualsToken || syntaxKind == SyntaxKind.BangEqualsToken)
        {
            var leftEnum = leftType is NullableTypeSymbol leftNullableEnum
                ? leftNullableEnum.UnderlyingType as EnumSymbol
                : leftType as EnumSymbol;
            var rightEnum = rightType is NullableTypeSymbol rightNullableEnum
                ? rightNullableEnum.UnderlyingType as EnumSymbol
                : rightType as EnumSymbol;
            var eitherNullable = leftType is NullableTypeSymbol || rightType is NullableTypeSymbol;
            if (leftEnum != null && rightEnum != null && leftEnum == rightEnum && eitherNullable)
            {
                var enumCmpKind = syntaxKind == SyntaxKind.EqualsEqualsToken
                    ? BoundBinaryOperatorKind.Equals
                    : BoundBinaryOperatorKind.NotEquals;
                return new BoundBinaryOperator(syntaxKind, enumCmpKind, leftType, rightType, TypeSymbol.Bool);
            }
        }

        // Phase 3.B.2 / ADR-0029 + ADR-0033: structural == / != on data and inline struct values.
        //
        // Issue #614 audit: intentionally a single arm — only 2 operators (== / !=)
        // restricted to user-declared struct types with IsData or IsInline. The type
        // test (`is StructSymbol`) is structural, not table-friendly.
        if (leftType is StructSymbol ls && rightType is StructSymbol rs && ls == rs && (ls.IsData || ls.IsInline))
        {
            if (syntaxKind == SyntaxKind.EqualsEqualsToken)
            {
                return new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, ls, ls, TypeSymbol.Bool);
            }

            if (syntaxKind == SyntaxKind.BangEqualsToken)
            {
                return new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, ls, ls, TypeSymbol.Bool);
            }
        }

        // Phase 3.C.2 / ADR-0001: == and != against nil for any nullable type.
        //
        // Issue #614 audit: intentionally a single arm — only 2 operators (== / !=)
        // with a symmetric null-sentinel predicate. No growth dimension; the nil
        // comparison semantic is fixed.
        if ((syntaxKind == SyntaxKind.EqualsEqualsToken || syntaxKind == SyntaxKind.BangEqualsToken) &&
            (IsNullCompare(leftType, rightType) || IsNullCompare(rightType, leftType)))
        {
            var kind = syntaxKind == SyntaxKind.EqualsEqualsToken ? BoundBinaryOperatorKind.Equals : BoundBinaryOperatorKind.NotEquals;
            return new BoundBinaryOperator(syntaxKind, kind, leftType, rightType, TypeSymbol.Bool);
        }

        // Issue #941 / ADR-0001: null-coalescing `??` returns the left if
        // non-nil, otherwise the right. Type is the underlying of the left
        // side (when the right is the same underlying or is itself nullable
        // with that underlying).
        //
        // Issue #614 audit: intentionally a single arm — there is only ONE
        // null-coalescing operator token; no combinatorial dimension to tabulate.
        if (syntaxKind == SyntaxKind.QuestionQuestionToken)
        {
            TypeSymbol leftUnderlying = leftType is NullableTypeSymbol leftNullable ? leftNullable.UnderlyingType : leftType;
            TypeSymbol rightUnderlying = rightType is NullableTypeSymbol rightNullable ? rightNullable.UnderlyingType : rightType;

            // Issue #1018: `x ?? throw e`. The RHS is a throw-expression whose
            // bottom (`never`) type is convertible to anything, so the result is
            // the left operand stripped of its nullability (the non-null value).
            if (rightType == TypeSymbol.Never)
            {
                return new BoundBinaryOperator(syntaxKind, BoundBinaryOperatorKind.NullCoalesce, leftType, rightType, leftUnderlying);
            }

            if (leftType == TypeSymbol.Null)
            {
                return new BoundBinaryOperator(syntaxKind, BoundBinaryOperatorKind.NullCoalesce, leftType, rightType, rightType);
            }

            if (leftUnderlying == rightUnderlying)
            {
                var result = rightType is NullableTypeSymbol ? (TypeSymbol)NullableTypeSymbol.Get(leftUnderlying) : leftUnderlying;
                return new BoundBinaryOperator(syntaxKind, BoundBinaryOperatorKind.NullCoalesce, leftType, rightType, result);
            }

            // Issue #1239 / C# §12.15: best common type. When the underlyings
            // differ but a valid implicit conversion exists between them, `??`
            // computes the best common type instead of requiring an exact match:
            //   * if the right operand implicitly converts to the left's non-null
            //     type A0 (reference downcast target, numeric widening source),
            //     the result is A0 (e.g. `int32? ?? uint16` → `int32`);
            //   * otherwise, if A0 implicitly converts to the right operand's
            //     type, the result is the right type (reference upcast / interface
            //     implementation, e.g. `Foo? ?? IFoo` → `IFoo`, or numeric
            //     widening, e.g. `int32? ?? int64` → `int64`).
            // Restricted to a non-nullable right operand so the result is a plain
            // (non-nullable) type; ExpressionBinder.BindBinaryExpression inserts
            // the operand conversions required for correct emit/evaluation. A
            // mismatched nullable right operand still falls through to GS0129
            // (unchanged behaviour) because lifted nullable numeric conversions
            // are not part of the implicit-conversion lattice.
            if (rightType is not NullableTypeSymbol
                && leftUnderlying != null
                && rightUnderlying != null
                && leftType != TypeSymbol.Error
                && rightType != TypeSymbol.Error)
            {
                TypeSymbol common = null;
                var rightToLeft = Conversion.Classify(rightUnderlying, leftUnderlying);
                if (rightToLeft.Exists && rightToLeft.IsImplicit)
                {
                    common = leftUnderlying;
                }
                else
                {
                    var leftToRight = Conversion.Classify(leftUnderlying, rightUnderlying);
                    if (leftToRight.Exists && leftToRight.IsImplicit)
                    {
                        common = rightUnderlying;
                    }
                }

                if (common != null)
                {
                    return new BoundBinaryOperator(syntaxKind, BoundBinaryOperatorKind.NullCoalesce, leftType, rightType, common);
                }
            }
        }

        // PR N-4 / §6.1 / C# §7.3.7: lifted binary operators over a
        // value-type Nullable<T>. Triggered when both operands are
        // NullableTypeSymbol wrapping the SAME value-type underlying.
        // (Mixed `T? op T` is handled in BindBinaryExpression by lifting
        // the non-nullable side to T? via an implicit conversion before
        // re-binding.) Arithmetic / bitwise lift to T?; equality and
        // ordering lift to bool. Shifts are intentionally excluded —
        // they take a non-matching int rhs and are rarely used on
        // nullables; falling through here leaves them as a non-fatal
        // "operator undefined" diagnostic at user-source level.
        //
        // Issue #614 audit: intentionally a single arm — this is a generic
        // lifting meta-algorithm that already handles ALL liftable operator
        // kinds uniformly via IsLiftableKind(). It delegates to the main Bind
        // for the underlying form, so it has no per-operator duplication to
        // tabulate.
        if (leftType is NullableTypeSymbol lN
            && rightType is NullableTypeSymbol rN
            && lN == rN
            && lN.UnderlyingType?.ClrType is { IsValueType: true })
        {
            // Look up the underlying-form operator. If it does not exist
            // (e.g. the user wrote `+` on `bool?`, which has no underlying
            // form), there is no lifted form either.
            var underlyingOp = Bind(syntaxKind, lN.UnderlyingType, rN.UnderlyingType);
            if (underlyingOp != null && IsLiftableKind(underlyingOp.Kind))
            {
                TypeSymbol liftedResult = IsLiftedToBoolKind(underlyingOp.Kind)
                    ? (TypeSymbol)TypeSymbol.Bool
                    : NullableTypeSymbol.Get(underlyingOp.Type);
                return new BoundBinaryOperator(syntaxKind, underlyingOp.Kind, leftType, rightType, liftedResult);
            }
        }

        // 6.6 / §6.1: lifted binary for heterogeneous nullable operands
        // (enum? + underlying?, underlying? + enum?, enum? - enum?→underlying?).
        // The same-type arm above handles enum? == enum? and enum? | enum?;
        // this arm handles the §11.10 arithmetic rules where both sides
        // are nullable but wrap DIFFERENT underlying types.
        //
        // Issue #614 audit: same rationale as the homogeneous nullable arm
        // above — a generic lifting meta-algorithm, not per-operator duplication.
        if (leftType is NullableTypeSymbol lHet
            && rightType is NullableTypeSymbol rHet
            && lHet != rHet
            && lHet.UnderlyingType?.ClrType is { IsValueType: true }
            && rHet.UnderlyingType?.ClrType is { IsValueType: true })
        {
            var underlyingOp = Bind(syntaxKind, lHet.UnderlyingType, rHet.UnderlyingType);
            if (underlyingOp != null && IsLiftableKind(underlyingOp.Kind))
            {
                TypeSymbol liftedResult = IsLiftedToBoolKind(underlyingOp.Kind)
                    ? (TypeSymbol)TypeSymbol.Bool
                    : NullableTypeSymbol.Get(underlyingOp.Type);
                return new BoundBinaryOperator(syntaxKind, underlyingOp.Kind, leftType, rightType, liftedResult);
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #1333: returns <see langword="true"/> when <paramref name="type"/>
    /// is a reference type (or a generic type parameter that is a reference at
    /// runtime) so that comparing it to <c>nil</c> with <c>==</c> / <c>!=</c>
    /// (or matching it against a <c>nil</c> constant pattern) is meaningful.
    /// Non-nullable value types — numeric/bool/char/enum/struct and
    /// <c>struct</c>-constrained type parameters — return <see langword="false"/>.
    /// </summary>
    /// <param name="type">The non-<c>nil</c> operand type to classify.</param>
    /// <returns><see langword="true"/> for reference-typed operands.</returns>
    internal static bool IsReferenceTypeNilComparable(TypeSymbol type)
    {
        if (type is null)
        {
            return false;
        }

        // A generic type parameter is a managed reference at runtime unless it
        // is `struct`-constrained. `class`-constrained and unconstrained
        // parameters can hold null, so the nil-comparison is meaningful;
        // `[T struct]` is a value type and stays rejected.
        if (type is TypeParameterSymbol tp)
        {
            return !tp.HasValueTypeConstraint;
        }

        // `object` and `string` are reference types that the constraint
        // helper does not special-case (they are plain TypeSymbols, not
        // ImportedTypeSymbols).
        if (type == TypeSymbol.Object || type == TypeSymbol.String)
        {
            return true;
        }

        return Binder.IsReferenceTypeForConstraint(type);
    }

    /// <summary>
    /// PR N-4: returns true for operator kinds that have a lifted
    /// counterpart per C# §7.3.7 — arithmetic, bitwise, equality, and
    /// ordering. Logical short-circuit (&amp;&amp;, ||), null-coalesce, and
    /// shift operators are excluded; the former two require the user-
    /// defined `true`/`false` operator surface, null-coalesce is itself
    /// the way to consume a nullable, and shifts are bound on a non-
    /// matching int rhs which the simple matching arm cannot lift.
    /// </summary>
    private static bool IsLiftableKind(BoundBinaryOperatorKind kind)
    {
        switch (kind)
        {
            case BoundBinaryOperatorKind.Sum:
            case BoundBinaryOperatorKind.Difference:
            case BoundBinaryOperatorKind.Product:
            case BoundBinaryOperatorKind.Quotient:
            case BoundBinaryOperatorKind.Remainder:
            case BoundBinaryOperatorKind.BitwiseAnd:
            case BoundBinaryOperatorKind.BitwiseOr:
            case BoundBinaryOperatorKind.BitwiseXor:
            case BoundBinaryOperatorKind.BitClear:
            case BoundBinaryOperatorKind.Equals:
            case BoundBinaryOperatorKind.NotEquals:
            case BoundBinaryOperatorKind.Less:
            case BoundBinaryOperatorKind.LessOrEquals:
            case BoundBinaryOperatorKind.Greater:
            case BoundBinaryOperatorKind.GreaterOrEquals:
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// PR N-4: returns true for operator kinds whose lifted form has
    /// result type <c>bool</c> rather than <c>Nullable&lt;R&gt;</c>
    /// (equality and ordering, per C# §7.3.7).
    /// </summary>
    private static bool IsLiftedToBoolKind(BoundBinaryOperatorKind kind)
    {
        switch (kind)
        {
            case BoundBinaryOperatorKind.Equals:
            case BoundBinaryOperatorKind.NotEquals:
            case BoundBinaryOperatorKind.Less:
            case BoundBinaryOperatorKind.LessOrEquals:
            case BoundBinaryOperatorKind.Greater:
            case BoundBinaryOperatorKind.GreaterOrEquals:
                return true;
            default:
                return false;
        }
    }

    private static bool IsNullCompare(TypeSymbol nullableOrUnderlying, TypeSymbol nullCandidate)
    {
        if (nullCandidate != TypeSymbol.Null)
        {
            return false;
        }

        if (nullableOrUnderlying == TypeSymbol.Null || nullableOrUnderlying is NullableTypeSymbol)
        {
            return true;
        }

        // Issue #796 / #1333: extend `== nil` / `!= nil` to reference-shaped
        // types whose CLR representation is a managed reference. The binder
        // already accepts `T? == nil` for any nullable wrapper; the language
        // has no `T?` spelling for these structural shapes (and the defensive
        // `x == nil` / `x != nil` pattern is legal on any reference even when
        // it is not null-annotated, because a CLR reference can still be null
        // at runtime — default field value, uninitialised auto-property,
        // interop). Allow the comparison directly. Emit falls through to the
        // generic `ldnull; ceq` path (verifier-clean for any reference), or to
        // the `box; ldnull; ceq` path for open type parameters.
        //
        // Covered shapes (all references at the CLR level): user classes,
        // interfaces, imported reference types, arrays, slices, maps, channels,
        // delegates, anonymous functions, sequences, `string`, `object`, and
        // `class`-constrained or unconstrained generic type parameters.
        // Non-nullable value types (numeric/bool/char/enum/struct and
        // `struct`-constrained type parameters) are intentionally excluded so
        // a meaningless `int32 == nil` still reports GS0129.
        return IsReferenceTypeNilComparable(nullableOrUnderlying);
    }

    private static BoundBinaryOperator[] BuildSupportedOperators()
    {
        var list = new System.Collections.Generic.List<BoundBinaryOperator>();

        // ADR-0044: every integral primitive supports the full arithmetic,
        // comparison, bitwise, and shift operator set, closed under its own
        // type (sbyte + sbyte → sbyte, long + long → long, …). Cross-type
        // promotion happens through explicit casts.
        foreach (var t in SignedIntegralTypes)
        {
            AddIntegralOperators(list, t);
        }

        foreach (var t in UnsignedIntegralTypes)
        {
            AddIntegralOperators(list, t);
        }

        // Floating-point primitives support arithmetic + comparison, but
        // not bitwise or shifts.
        foreach (var t in FloatingPointTypes)
        {
            AddArithmeticAndComparisonOperators(list, t);
        }

        // Decimal mirrors the floating-point shape but is emitted through
        // System.Decimal's operator methods (handled by the emitter).
        AddArithmeticAndComparisonOperators(list, TypeSymbol.Decimal);

        // char is comparison-only at its own type: char + char would have to
        // widen to int in C#'s rules, and the binder does not yet promote
        // across types here. Users can write `int(c1) + int(c2)` explicitly.
        AddComparisonOperators(list, TypeSymbol.Char);

        // Bool operators (unchanged behaviour, kept here for one source of truth).
        list.Add(new BoundBinaryOperator(SyntaxKind.AmpersandToken, BoundBinaryOperatorKind.BitwiseAnd, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.AmpersandAmpersandToken, BoundBinaryOperatorKind.LogicalAnd, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.PipeToken, BoundBinaryOperatorKind.BitwiseOr, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.PipePipeToken, BoundBinaryOperatorKind.LogicalOr, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.HatToken, BoundBinaryOperatorKind.BitwiseXor, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.Bool));

        // String operators (concatenation + equality through BCL helpers).
        list.Add(new BoundBinaryOperator(SyntaxKind.PlusToken, BoundBinaryOperatorKind.Sum, TypeSymbol.String));
        list.Add(new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.String, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.String, TypeSymbol.Bool));

        // ADR-0045: `object` reference equality.
        list.Add(new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.Object, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.Object, TypeSymbol.Bool));

        return list.ToArray();
    }

    private static void AddArithmeticAndComparisonOperators(System.Collections.Generic.List<BoundBinaryOperator> list, TypeSymbol t)
    {
        list.Add(new BoundBinaryOperator(SyntaxKind.PlusToken, BoundBinaryOperatorKind.Sum, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.MinusToken, BoundBinaryOperatorKind.Difference, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.StarToken, BoundBinaryOperatorKind.Product, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.SlashToken, BoundBinaryOperatorKind.Quotient, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.PercentToken, BoundBinaryOperatorKind.Remainder, t));
        AddComparisonOperators(list, t);
    }

    private static void AddIntegralOperators(System.Collections.Generic.List<BoundBinaryOperator> list, TypeSymbol t)
    {
        AddArithmeticAndComparisonOperators(list, t);
        list.Add(new BoundBinaryOperator(SyntaxKind.AmpersandToken, BoundBinaryOperatorKind.BitwiseAnd, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.PipeToken, BoundBinaryOperatorKind.BitwiseOr, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.HatToken, BoundBinaryOperatorKind.BitwiseXor, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.AmpersandHatToken, BoundBinaryOperatorKind.BitClear, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.ShiftLeftToken, BoundBinaryOperatorKind.ShiftLeft, t, TypeSymbol.Int32, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.ShiftRightToken, BoundBinaryOperatorKind.ShiftRight, t, TypeSymbol.Int32, t));
    }

    private static void AddComparisonOperators(System.Collections.Generic.List<BoundBinaryOperator> list, TypeSymbol t)
    {
        list.Add(new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.LessToken, BoundBinaryOperatorKind.Less, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.LessOrEqualsToken, BoundBinaryOperatorKind.LessOrEquals, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.GreaterToken, BoundBinaryOperatorKind.Greater, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.GreaterOrEqualsToken, BoundBinaryOperatorKind.GreaterOrEquals, t, t, TypeSymbol.Bool));
    }
}
