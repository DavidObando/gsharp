// <copyright file="ExpressionBinder.Access.Indexing.2.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
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
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{


    private BoundExpression BindRangeSlice(BoundExpression target, RangeExpressionSyntax range, TextLocation targetLocation)
    {
        if (target is BoundErrorExpression || target.Type == TypeSymbol.Error || target.Type == null)
        {
            if (range.LowerBound != null)
            {
                _ = BindExpression(range.LowerBound);
            }

            if (range.UpperBound != null)
            {
                _ = BindExpression(range.UpperBound);
            }

            return new BoundErrorExpression(null);
        }

        var arrayElement = GetArraySliceElementType(target.Type);
        if (arrayElement != null)
        {
            return BindArraySlice(target, range, arrayElement);
        }

        if (target.Type == TypeSymbol.String)
        {
            return BindStringSlice(target, range);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindRangeIndexer(clrType, out var rangeIndexer))
            {
                return BindRangeIndexerSlice(target, range, rangeIndexer);
            }

            if (TryFindSliceShape(clrType, out var lengthMember, out var sliceMethod))
            {
                return BindSpanLikeSlice(target, range, lengthMember, sliceMethod);
            }
        }

        Diagnostics.ReportTypeNotSliceable(range.Location, target.Type);
        return new BoundErrorExpression(null);
    }

    private LocalVariableSymbol DeclareRangeTemp(string role, TypeSymbol type, BoundExpression initializer, ImmutableArray<BoundStatement>.Builder statements)
    {
        var name = "$slice_" + role + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var local = new LocalVariableSymbol(name, isReadOnly: true, type: type);
        scope.TryDeclareVariable(local);
        statements.Add(new BoundVariableDeclaration(null, local, initializer));
        return local;
    }

    // Issue #1022: bind a single range bound to an int32 offset. A from-end
    // marker `^n` lowers to `srcLen - n`; a missing bound uses
    // <paramref name="defaultValue"/>; otherwise the bound is the plain value.
    private BoundExpression BindRangeBoundValue(ExpressionSyntax boundSyntax, Func<BoundExpression> srcLenRef, BoundExpression defaultValue)
    {
        if (boundSyntax == null)
        {
            return defaultValue;
        }

        if (boundSyntax is FromEndIndexExpressionSyntax fromEnd)
        {
            var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
            var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
            return new BoundBinaryExpression(null, srcLenRef(), subtractOp, offset);
        }

        return conversions.BindConversion(boundSyntax, TypeSymbol.Int32);
    }

    private BoundExpression BindRangeIndexerSlice(BoundExpression target, RangeExpressionSyntax range, PropertyInfo indexer)
    {
        var rangeValue = BuildSystemRangeValue(range);
        var resultType = TypeSymbol.FromClrType(indexer.PropertyType);
        return new BoundClrIndexExpression(range, target, indexer, ImmutableArray.Create(rangeValue), resultType);
    }

    // Issue #1016/#1022/#1038: construct a `System.Range` value from a range
    // expression's bounds. Each bound becomes a `System.Index`: an open lower
    // defaults to the start (`Index(0, fromEnd: false)`), an open upper to the
    // end (`Index(0, fromEnd: true)`), a `^n` marker to `Index(n, fromEnd:
    // true)`, and a plain value `v` to `Index(v, fromEnd: false)`. Shared by the
    // `this[System.Range]` indexer-slice path (#1016) and the standalone range
    // value `let r = 1..3` (#1038).
    private BoundExpression BuildSystemRangeValue(RangeExpressionSyntax range)
    {
        var indexCtor = typeof(System.Index).GetConstructor(new[] { typeof(int), typeof(bool) });
        var rangeCtor = typeof(System.Range).GetConstructor(new[] { typeof(System.Index), typeof(System.Index) });
        var indexSym = TypeSymbol.FromClrType(typeof(System.Index));
        var rangeSym = TypeSymbol.FromClrType(typeof(System.Range));

        BoundExpression MakeIndex(ExpressionSyntax boundSyntax, bool defaultFromEnd)
        {
            // Issue #1022: a `^n` bound becomes System.Index(n, fromEnd: true);
            // the System.Range value resolves the concrete offset at runtime.
            if (boundSyntax is FromEndIndexExpressionSyntax fromEnd)
            {
                var endValue = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
                return new BoundClrConstructorCallExpression(
                    null,
                    typeof(System.Index),
                    indexCtor,
                    ImmutableArray.Create<BoundExpression>(endValue, new BoundLiteralExpression(null, true)),
                    indexSym);
            }

            var value = boundSyntax != null
                ? conversions.BindConversion(boundSyntax, TypeSymbol.Int32)
                : new BoundLiteralExpression(null, 0);
            return new BoundClrConstructorCallExpression(
                null,
                typeof(System.Index),
                indexCtor,
                ImmutableArray.Create<BoundExpression>(value, new BoundLiteralExpression(null, defaultFromEnd)),
                indexSym);
        }

        // Open lower defaults to the start (0, from-start); open upper defaults
        // to the end (^0, i.e. value 0 from-end).
        var startIndex = MakeIndex(range.LowerBound, defaultFromEnd: false);
        var endIndex = range.UpperBound != null
            ? MakeIndex(range.UpperBound, defaultFromEnd: false)
            : MakeIndex(null, defaultFromEnd: true);

        return new BoundClrConstructorCallExpression(
            null,
            typeof(System.Range),
            rangeCtor,
            ImmutableArray.Create<BoundExpression>(startIndex, endIndex),
            rangeSym);
    }

    // Issue #1038: bind a standalone range expression (`let r = 1..3`) to a
    // constructed `System.Range` value. A leading `^` at the very start is
    // genuinely ambiguous with the one's-complement unary operator, so the
    // parser reads `^a..` as `(~a)..`; reject that here (GS0410) so the from-end
    // intent isn't silently misread — use an indexer (`arr[^a..]`) or
    // parenthesise the complement (`(^a)..`).
    private BoundExpression BindStandaloneRange(RangeExpressionSyntax range)
    {
        if (range.LowerBound is UnaryExpressionSyntax leadingUnary
            && leadingUnary.OperatorToken.Kind == SyntaxKind.HatToken)
        {
            Diagnostics.ReportFromEndMarkerNotAllowedInStandaloneRange(leadingUnary.OperatorToken.Location);
            _ = BindExpression(leadingUnary.Operand);
            if (range.UpperBound != null)
            {
                _ = BindExpression(range.UpperBound is FromEndIndexExpressionSyntax fe ? fe.Operand : range.UpperBound);
            }

            return new BoundErrorExpression(range);
        }

        return BuildSystemRangeValue(range);
    }

    // Issue #1038: slice a target by a runtime `System.Range` value (`a[r]`,
    // where `r : System.Range`). Mirrors the syntactic `a[1..3]` shapes from
    // #1016 but reads the concrete `start`/`length` from the range value via
    // `System.Index.GetOffset(length)` rather than from syntactic bounds:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> new T[len] + Array.Copy.
    //   - `string` -> Substring(start, len).
    //   - span-like types (`int Length`/`Count` + `Slice(int, int)`).
    //   - a type exposing `this[System.Range]` -> call it with the value directly.
    private BoundExpression BindRangeValueSlice(BoundExpression target, BoundExpression rangeValue, TextLocation targetLocation)
    {
        var arrayElement = GetArraySliceElementType(target.Type);
        if (arrayElement != null)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                target,
                rangeValue,
                src => new BoundLenExpression(null, src),
                statements);

            var resultType = SliceTypeSymbol.Get(arrayElement);
            var dstLocal = DeclareRangeTemp("dst", resultType, new BoundArrayCreationExpression(null, resultType, lenRef), statements);
            var dstRef = new BoundVariableExpression(null, dstLocal);

            var copyMethod = typeof(System.Array).GetMethod(
                "Copy",
                new[] { typeof(System.Array), typeof(int), typeof(System.Array), typeof(int), typeof(int) });
            var copyCall = new BoundClrStaticCallExpression(
                null,
                copyMethod,
                TypeSymbol.Void,
                ImmutableArray.Create<BoundExpression>(srcRef, startRef, dstRef, new BoundLiteralExpression(null, 0), lenRef));
            statements.Add(new BoundExpressionStatement(null, copyCall));

            return new BoundBlockExpression(null, statements.ToImmutable(), new BoundVariableExpression(null, dstLocal));
        }

        if (target.Type == TypeSymbol.String)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                target,
                rangeValue,
                src => new BoundLenExpression(null, src),
                statements);

            var substring = typeof(string).GetMethod("Substring", new[] { typeof(int), typeof(int) });
            var call = new BoundImportedInstanceCallExpression(
                null,
                srcRef,
                substring,
                TypeSymbol.String,
                ImmutableArray.Create<BoundExpression>(startRef, lenRef));
            return new BoundBlockExpression(null, statements.ToImmutable(), call);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindRangeIndexer(clrType, out var rangeIndexer))
            {
                var resultType = TypeSymbol.FromClrType(rangeIndexer.PropertyType);
                return new BoundClrIndexExpression(null, target, rangeIndexer, ImmutableArray.Create(rangeValue), resultType);
            }

            if (TryFindSliceShape(clrType, out var lengthMember, out var sliceMethod))
            {
                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                    target,
                    rangeValue,
                    src => new BoundClrPropertyAccessExpression(null, src, lengthMember, TypeSymbol.Int32),
                    statements);

                var returnType = TypeSymbol.FromClrType(sliceMethod.ReturnType);
                var call = new BoundImportedInstanceCallExpression(
                    null,
                    srcRef,
                    sliceMethod,
                    returnType,
                    ImmutableArray.Create<BoundExpression>(startRef, lenRef));
                return new BoundBlockExpression(null, statements.ToImmutable(), call);
            }
        }

        Diagnostics.ReportTypeNotSliceable(targetLocation, target.Type);
        return new BoundErrorExpression(null);
    }

    // Issue #1038: a `System.Range`-typed value used as an index argument
    // (`a[r]`) slices the target. Uses ClrTypeUtilities.IsSameAs per the issue
    // #835 guard against reference-identity typeof comparisons.
    private static bool IsSystemRangeType(TypeSymbol type)
    {
        return type?.ClrType != null && type.ClrType.IsSameAs(typeof(System.Range));
    }

    private static bool TryFindRangeIndexer(Type clrType, out PropertyInfo indexer)
    {
        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(System.Range)))
            {
                indexer = property;
                return true;
            }
        }

        indexer = null;
        return false;
    }

    // Issue #1022: a type that exposes a `this[System.Index]` indexer can serve
    // a from-end index directly (the indexer resolves `^n` at runtime).
    private static bool TryFindIndexIndexer(Type clrType, out PropertyInfo indexer)
    {
        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(System.Index)))
            {
                indexer = property;
                return true;
            }
        }

        indexer = null;
        return false;
    }

    // Issue #1022: a type with an `int Length`/`int Count` property and a
    // `this[int]` indexer (string, List<T>, span-like) can serve a from-end
    // index as `this[Length - n]`.
    private static bool TryFindCountedIntIndexer(Type clrType, out MemberInfo lengthMember, out PropertyInfo intIndexer)
    {
        lengthMember = null;
        intIndexer = null;

        var lengthProp = clrType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance);
        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            lengthProp = clrType.GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
        }

        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            return false;
        }

        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(int)))
            {
                lengthMember = lengthProp;
                intIndexer = property;
                return true;
            }
        }

        return false;
    }

    // Issue #1279: array/slice element access accepts any integer-typed index
    // (matching C#). Integer types that implicitly widen to int32
    // (int8/uint8/int16/uint16/char/int32) convert to int32; the wider integer
    // types (uint32/int64/uint64/nint/nuint) convert to native int (nint),
    // which CIL ldelem/stelem/ldelema accept as the index operand. Non-integer
    // indices fall through to the int32 conversion, which reports GS0156.
    private static bool IsWideIntegerIndexType(TypeSymbol type) =>
        type == TypeSymbol.UInt32 || type == TypeSymbol.Int64 || type == TypeSymbol.UInt64
        || type == TypeSymbol.NInt || type == TypeSymbol.NUInt;

    private BoundExpression ConvertArrayElementIndex(TextLocation location, BoundExpression boundIndex)
    {
        if (IsWideIntegerIndexType(boundIndex.Type))
        {
            return conversions.BindConversion(location, boundIndex, TypeSymbol.NInt, allowExplicit: true);
        }

        return conversions.BindConversion(location, boundIndex, TypeSymbol.Int32);
    }

    // Issue #1279: `string` char-indexing (`s[i]`) lowers to the CLR
    // `get_Chars(int32)` accessor, so any integer index converts to int32 (an
    // explicit narrowing for the wider integer types). Non-integer indices
    // report GS0156 via the implicit int32 conversion.
    private BoundExpression ConvertStringCharIndex(TextLocation location, BoundExpression boundIndex)
    {
        return conversions.BindConversion(
            location, boundIndex, TypeSymbol.Int32, allowExplicit: IsWideIntegerIndexType(boundIndex.Type));
    }

    // Issue #1279: bind an array/slice element index from syntax. A
    // default/interpolated index carries no natural type, so it keeps the
    // historical target-typed int32 conversion; every other index is bound and
    // then converted via the integer-aware element-index rule above.
    private BoundExpression BindArrayElementIndex(ExpressionSyntax indexSyntax)
    {
        if (indexSyntax is DefaultExpressionSyntax || indexSyntax is InterpolatedStringExpressionSyntax)
        {
            return conversions.BindConversion(indexSyntax, TypeSymbol.Int32);
        }

        var boundIndex = BindExpression(indexSyntax);
        if (boundIndex is BoundErrorExpression)
        {
            return boundIndex;
        }

        return ConvertArrayElementIndex(indexSyntax.Location, boundIndex);
    }

    private static TypeSymbol GetIndexElementType(TypeSymbol type)
    {
        return type switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,

            // Issue #664: CLR T[] arrays (e.g. result of string.Split) are indexable.
            ImportedTypeSymbol imp when imp.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => TypeSymbol.FromClrType(clr.GetElementType()),
            NullabilityAnnotatedTypeSymbol annot when annot.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => annot.GetTypeArgumentSymbolForClrType(clr.GetElementType()),
            _ => null,
        };
    }
}
