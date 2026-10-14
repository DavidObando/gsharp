// <copyright file="BoundLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System

/// Bound literal expression.
class BoundLiteralExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundLiteralExpression) class.
    /// @param syntax The originating syntax.
    /// @param value The value, or `null` for the `nil` literal.
    convenience init(syntax SyntaxNode?, value object?) {
        init(syntax, value, InferType(value))
    }

    /// Initializes a new instance of the (cref:BoundLiteralExpression) class with an explicit type.
    /// @param syntax The originating syntax.
    /// @param value The runtime value, or `null` for the `nil` literal.
    /// @param type The static type.
    init(syntax SyntaxNode?, value object?, type TypeSymbol) : base(syntax) {
        Value = value
        _type = type
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.LiteralExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the value, or `null` for the `nil` literal (whose
    /// (cref:BoundExpression.Type) is `TypeSymbol.Null`). The emitter
    /// and the narrowing analysis both test this.
    prop Value object? {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ConstantValue OptionalValue -> OptionalValue(true, Value)

    shared {
        private func InferType(value object?) TypeSymbol {
            if value == nil {
                return TypeSymbol.Null
            }
            // ADR-0044: lexer-produced literal tokens carry their typed CLR value.
            // BoundLiteralExpression reads that CLR type back as the static
            // GSharp type so e.g. `1L` binds as `long` and `1.5` as `float64`.
            switch value {
                case _ is bool {
                    return TypeSymbol.Bool
                }
                case _ is int8 {
                    return TypeSymbol.Int8
                }
                case _ is uint8 {
                    return TypeSymbol.UInt8
                }
                case _ is int16 {
                    return TypeSymbol.Int16
                }
                case _ is uint16 {
                    return TypeSymbol.UInt16
                }
                case _ is int32 {
                    return TypeSymbol.Int32
                }
                case _ is uint32 {
                    return TypeSymbol.UInt32
                }
                case _ is int64 {
                    return TypeSymbol.Int64
                }
                case _ is uint64 {
                    return TypeSymbol.UInt64
                }
                case _ is nint {
                    return TypeSymbol.NInt
                }
                case _ is nuint {
                    return TypeSymbol.NUInt
                }
                case _ is float32 {
                    return TypeSymbol.Float32
                }
                case _ is float64 {
                    return TypeSymbol.Float64
                }
                case _ is decimal {
                    return TypeSymbol.Decimal
                }
                case _ is char {
                    return TypeSymbol.Char
                }
                case _ is string {
                    return TypeSymbol.String
                }
            }
            throw Exception("Unexpected literal '$value' of type ${value.GetType()}")
        }
    }
}
