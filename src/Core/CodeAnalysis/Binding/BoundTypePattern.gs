// <copyright file="BoundTypePattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound type pattern.
class BoundTypePattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundTypePattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param targetType The target type.
    /// @param variable The introduced variable.
    convenience init(syntax SyntaxNode?, type TypeSymbol, targetType TypeSymbol, variable LocalVariableSymbol) {
        init(syntax, type, targetType, variable, variable.Name != "_", nil)
    }

    /// Initializes a new instance of the (cref:BoundTypePattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param targetType The target type.
    /// @param variable The local that receives the narrowed value.
    /// @param hasBinding Whether [`variable`](paramref) is source-visible.
    /// @param propertyPattern The optional recursive property-pattern suffix.
    init(
        syntax SyntaxNode?,
        type TypeSymbol,
        targetType TypeSymbol,
        variable LocalVariableSymbol,
        hasBinding bool,
        propertyPattern BoundPropertyPattern?
    ) : base(syntax, type) {
        TargetType = targetType
        Variable = variable
        HasBinding = hasBinding
        PropertyPattern = propertyPattern
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.TypePattern

    /// Gets the type tested by this pattern.
    prop TargetType TypeSymbol {
        get;
    }

    /// Gets the variable introduced by this pattern.
    prop Variable LocalVariableSymbol {
        get;
    }

    /// Gets a value indicating whether (cref:Variable) is source-visible.
    prop HasBinding bool {
        get;
    }

    /// Gets the optional recursive property-pattern suffix.
    prop PropertyPattern BoundPropertyPattern? {
        get;
    }
}
