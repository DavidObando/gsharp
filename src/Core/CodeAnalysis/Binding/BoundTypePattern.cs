// <copyright file="BoundTypePattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound type pattern.</summary>
public sealed class BoundTypePattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundTypePattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    /// <param name="targetType">The target type.</param>
    /// <param name="variable">The introduced variable.</param>
    public BoundTypePattern(SyntaxNode? syntax, TypeSymbol type, TypeSymbol targetType, LocalVariableSymbol variable)
        : this(
            syntax,
            type,
            targetType,
            variable,
            hasBinding: variable.Name != "_",
            propertyPattern: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundTypePattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    /// <param name="targetType">The target type.</param>
    /// <param name="variable">The local that receives the narrowed value.</param>
    /// <param name="hasBinding">Whether <paramref name="variable"/> is source-visible.</param>
    /// <param name="propertyPattern">The optional recursive property-pattern suffix.</param>
    public BoundTypePattern(
        SyntaxNode? syntax,
        TypeSymbol type,
        TypeSymbol targetType,
        LocalVariableSymbol variable,
        bool hasBinding,
        BoundPropertyPattern? propertyPattern)
        : base(syntax, type)
    {
        TargetType = targetType;
        Variable = variable;
        HasBinding = hasBinding;
        PropertyPattern = propertyPattern;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.TypePattern;

    /// <summary>Gets the type tested by this pattern.</summary>
    public TypeSymbol TargetType { get; }

    /// <summary>Gets the variable introduced by this pattern.</summary>
    public LocalVariableSymbol Variable { get; }

    /// <summary>Gets a value indicating whether <see cref="Variable"/> is source-visible.</summary>
    public bool HasBinding { get; }

    /// <summary>Gets the optional recursive property-pattern suffix.</summary>
    public BoundPropertyPattern? PropertyPattern { get; }
}
