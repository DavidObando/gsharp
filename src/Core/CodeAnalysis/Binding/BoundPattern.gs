// <copyright file="BoundPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System

/// Base class for bound switch patterns.
abstract class BoundPattern : BoundNode {
    /// Initializes a new instance of the (cref:BoundPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    protected init(syntax SyntaxNode?, type TypeSymbol) : base(syntax) {
        Type = type
    }

    /// Gets the discriminant type the pattern was bound against.
    prop Type TypeSymbol {
        get;
    }

    /// Gets a conservative input-read count, capped at two for lazy element caching.
    internal prop InputReadCount int32 {
        get {
            switch this {
                case discard is BoundDiscardPattern {
                    return if discard.Variable == nil {
                        0
                    } else {
                        1
                    }
                }
                case binary is BoundBinaryPattern {
                    return Math.Min(2, binary.Left.InputReadCount + binary.Right.InputReadCount)
                }
                case negated is BoundNotPattern {
                    return negated.Pattern.InputReadCount
                }
                case property is BoundPropertyPattern {
                    if property.InputVariable != nil {
                        return 1
                    }
                    var count = if property.Type is NullableTypeSymbol ||
                        (!property.Type.IsValueType && !(property.Type is TupleTypeSymbol)) {
                        1
                    } else {
                        0
                    }
                    for field in property.Fields {
                        count = Math.Min(2, count + field.Pattern.InputReadCount)
                    }
                    return count
                }
                case list is BoundListPattern {
                    return if list.IndexerProperty != nil {
                        1
                    } else {
                        2
                    }
                }
                default {
                    return 1
                }
            }
        }
    }
}
