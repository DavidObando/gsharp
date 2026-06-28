// <copyright file="ImplicitConversionKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

/// <summary>
/// Classification of an implicit conversion from one CLR type to another.
/// Lower ordinal values are "better" conversions and win in tie-breaking.
/// </summary>
public enum ImplicitConversionKind
{
    /// <summary>No conversion exists.</summary>
    None = 0,

    /// <summary>Identity conversion (same type).</summary>
    Identity = 1,

    /// <summary>Numeric widening conversion (e.g. int to long).</summary>
    NumericWidening = 2,

    /// <summary>Reference conversion (e.g. derived to base).</summary>
    Reference = 3,

    /// <summary>Boxing conversion (value type to object).</summary>
    Boxing = 4,

    /// <summary>Nullable wrapping conversion (T to T?).</summary>
    NullableWrap = 5,

    /// <summary>User-defined implicit conversion operator.</summary>
    UserDefinedImplicit = 6,

    /// <summary>Interpolated string handler conversion.</summary>
    InterpolatedStringHandler = 7,

    /// <summary>Interpolated string to formattable string conversion.</summary>
    InterpolatedStringToFormattable = 8,

    /// <summary>Lambda to void-returning delegate conversion.</summary>
    LambdaToVoidDelegate = 9,

    /// <summary>Delegate return type covariance conversion.</summary>
    DelegateReturnCovariance = 10,

    /// <summary>Delegate structural match conversion.</summary>
    DelegateStructuralMatch = 11,

    /// <summary>Delegate return type numeric widening conversion.</summary>
    DelegateReturnNumericWidening = 12,

    /// <summary>Constant narrowing conversion (e.g. int to byte).</summary>
    ConstantNarrowing = 13,
}
