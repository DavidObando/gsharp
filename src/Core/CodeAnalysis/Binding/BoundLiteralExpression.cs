// <copyright file="BoundLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound literal expression.
/// </summary>
public sealed class BoundLiteralExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLiteralExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="value">The value.</param>
    public BoundLiteralExpression(SyntaxNode syntax, object value)
        : this(syntax, value, InferType(value))
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLiteralExpression"/> class with an explicit type.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="value">The runtime value.</param>
    /// <param name="type">The static type.</param>
    public BoundLiteralExpression(SyntaxNode syntax, object value, TypeSymbol type)
        : base(syntax)
    {
        Value = value;
        Type = type;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.LiteralExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the value.
    /// </summary>
    public object Value { get; }

    private static TypeSymbol InferType(object value)
    {
        if (value == null)
        {
            return TypeSymbol.Null;
        }

        // ADR-0044: lexer-produced literal tokens carry their typed CLR value.
        // BoundLiteralExpression reads that CLR type back as the static
        // GSharp type so e.g. `1L` binds as `long` and `1.5` as `float64`.
        switch (value)
        {
            case bool _: return TypeSymbol.Bool;
            case sbyte _: return TypeSymbol.SByte;
            case byte _: return TypeSymbol.Byte;
            case short _: return TypeSymbol.Short;
            case ushort _: return TypeSymbol.UShort;
            case int _: return TypeSymbol.Int;
            case uint _: return TypeSymbol.UInt;
            case long _: return TypeSymbol.Long;
            case ulong _: return TypeSymbol.ULong;
            case nint _: return TypeSymbol.NInt;
            case nuint _: return TypeSymbol.NUInt;
            case float _: return TypeSymbol.Float32;
            case double _: return TypeSymbol.Float64;
            case decimal _: return TypeSymbol.Decimal;
            case char _: return TypeSymbol.Char;
            case string _: return TypeSymbol.String;
        }

        throw new Exception($"Unexpected literal '{value}' of type {value.GetType()}");
    }
}
