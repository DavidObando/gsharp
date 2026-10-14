// <copyright file="BoundPropertyPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound property pattern.
class BoundPropertyPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundPropertyPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param fields The field patterns.
    init(syntax SyntaxNode?, type TypeSymbol, fields ImmutableArray[BoundPropertyPatternField]) : base(syntax, type) {
        Fields = fields
        if type is NullableTypeSymbol nullable && NullableLifting.IsAnyValueTypeNullable(nullable) {
            UnwrappedVariable = LocalVariableSymbol(
                "<property-pattern-value>",
                isReadOnly: true,
                nullable.UnderlyingType
            )
        }
        // Field reads are side-effect free and keep the existing direct emit path.
        // Capture only when a getter must run once or Nullable<T> needs an address.
        for field in fields {
            if field.IsProperty {
                InputVariable = LocalVariableSymbol("<property-pattern-input>", isReadOnly: true, type)
                break
            }
        }
        if InputVariable == nil && UnwrappedVariable != nil {
            InputVariable = LocalVariableSymbol("<property-pattern-input>", isReadOnly: true, type)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.PropertyPattern

    /// Gets the field patterns.
    prop Fields ImmutableArray[BoundPropertyPatternField] {
        get;
    }

    /// Gets the temporary holding the pattern input when a getter or nullable value requires capture.
    prop InputVariable LocalVariableSymbol? {
        get;
    }

    /// Gets the unwrapped nullable value-type temporary, when required.
    prop UnwrappedVariable LocalVariableSymbol? {
        get;
    }
}
