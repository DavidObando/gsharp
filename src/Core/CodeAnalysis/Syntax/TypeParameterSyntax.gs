// <copyright file="TypeParameterSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// A single type parameter in a generic declaration, e.g. `T any` in
/// `func Map[T any, U any](…)` (Phase 4.1 / ADR-0020).
partial class TypeParameterSyntax : SyntaxNode {
    private var constraintType TypeClauseSyntax?

    /// Initializes a new instance of the (cref:TypeParameterSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param varianceModifier Optional `in`/`out` variance contextual keyword (ADR-0021); only valid on
    /// interface type parameters.
    /// @param identifier The type-parameter identifier token (e.g. `T`).
    /// @param constraint Optional constraint identifier (e.g. `any`); when `null`, the parameter is
    /// unconstrained (treated as `any`).
    convenience init(
        syntaxTree SyntaxTree,
        varianceModifier SyntaxToken?,
        identifier SyntaxToken,
        constraint SyntaxToken?
    ) {
        init(
            syntaxTree,
            varianceModifier,
            identifier,
            constraint,
            nil,
            default(SeparatedSyntaxList[TypeClauseSyntax]?),
            nil
        )
    }

    /// Initializes a new instance of the (cref:TypeParameterSyntax) class with an optional generic
    /// type-argument list on the interface constraint (ADR-0089 / issue #755).
    /// @param syntaxTree The parent syntax tree.
    /// @param varianceModifier Optional `in`/`out` variance contextual keyword.
    /// @param identifier The type-parameter identifier token.
    /// @param constraint Optional constraint identifier (e.g. `IAdd`).
    /// @param constraintTypeArgumentOpenBracketToken Optional opening `[` of the constraint's type-argument
    /// list.
    /// @param constraintTypeArguments Optional comma-separated list of type-argument clauses for the
    /// constraint (e.g. `[T]` in `IAdd[T]`).
    /// @param constraintTypeArgumentCloseBracketToken Optional closing `]` of the constraint's
    /// type-argument list.
    convenience init(
        syntaxTree SyntaxTree,
        varianceModifier SyntaxToken?,
        identifier SyntaxToken,
        constraint SyntaxToken?,
        constraintTypeArgumentOpenBracketToken SyntaxToken?,
        constraintTypeArguments SeparatedSyntaxList[TypeClauseSyntax]?,
        constraintTypeArgumentCloseBracketToken SyntaxToken?
    ) {
        init(
            syntaxTree,
            varianceModifier,
            identifier,
            constraint,
            constraintTypeArgumentOpenBracketToken,
            constraintTypeArguments,
            constraintTypeArgumentCloseBracketToken,
            nil,
            nil,
            nil,
            nil,
            nil
        )
    }

    /// Initializes a new instance of the (cref:TypeParameterSyntax) class with optional `class` / `struct`
    /// / `init()` constraints (ADR-0097 / issue #775; constraint keyword renamed from `new()` to `init()`
    /// by issue #997).
    /// @param syntaxTree The parent syntax tree.
    /// @param varianceModifier Optional variance contextual keyword.
    /// @param identifier The type-parameter identifier token.
    /// @param constraint Optional legacy constraint identifier (`any`, `comparable`, or a sealed-interface
    /// name).
    /// @param constraintTypeArgumentOpenBracketToken Optional opening `[` of the constraint's type-argument
    /// list.
    /// @param constraintTypeArguments Optional comma-separated list of type-argument clauses for the
    /// constraint.
    /// @param constraintTypeArgumentCloseBracketToken Optional closing `]` of the constraint's
    /// type-argument list.
    /// @param classConstraintKeyword Optional `class` keyword token (ADR-0097).
    /// @param structConstraintKeyword Optional `struct` keyword token (ADR-0097).
    /// @param initConstraintKeyword Optional `init` contextual keyword token (ADR-0097 / issue #997); when
    /// set, the parens MUST also be set.
    /// @param initConstraintOpenParenToken Optional `(` token of the `init()` constraint (issue #997).
    /// @param initConstraintCloseParenToken Optional `)` token of the `init()` constraint (issue #997).
    convenience init(
        syntaxTree SyntaxTree,
        varianceModifier SyntaxToken?,
        identifier SyntaxToken,
        constraint SyntaxToken?,
        constraintTypeArgumentOpenBracketToken SyntaxToken?,
        constraintTypeArguments SeparatedSyntaxList[TypeClauseSyntax]?,
        constraintTypeArgumentCloseBracketToken SyntaxToken?,
        classConstraintKeyword SyntaxToken?,
        structConstraintKeyword SyntaxToken?,
        initConstraintKeyword SyntaxToken?,
        initConstraintOpenParenToken SyntaxToken?,
        initConstraintCloseParenToken SyntaxToken?
    ) {
        init(
            syntaxTree,
            varianceModifier,
            identifier,
            constraint,
            constraintTypeArgumentOpenBracketToken,
            constraintTypeArguments,
            constraintTypeArgumentCloseBracketToken,
            classConstraintKeyword,
            structConstraintKeyword,
            initConstraintKeyword,
            initConstraintOpenParenToken,
            initConstraintCloseParenToken,
            nil
        )
    }

    /// Initializes a new instance of the (cref:TypeParameterSyntax) class with an optional `unmanaged`
    /// constraint (issue #1336).
    /// @param syntaxTree The parent syntax tree.
    /// @param varianceModifier Optional variance contextual keyword.
    /// @param identifier The type-parameter identifier token.
    /// @param constraint Optional legacy constraint identifier (`any`, `comparable`, or a sealed-interface
    /// name).
    /// @param constraintTypeArgumentOpenBracketToken Optional opening `[` of the constraint's type-argument
    /// list.
    /// @param constraintTypeArguments Optional comma-separated list of type-argument clauses for the
    /// constraint.
    /// @param constraintTypeArgumentCloseBracketToken Optional closing `]` of the constraint's
    /// type-argument list.
    /// @param classConstraintKeyword Optional `class` keyword token (ADR-0097).
    /// @param structConstraintKeyword Optional `struct` keyword token (ADR-0097).
    /// @param initConstraintKeyword Optional `init` contextual keyword token (ADR-0097 / issue #997); when
    /// set, the parens MUST also be set.
    /// @param initConstraintOpenParenToken Optional `(` token of the `init()` constraint (issue #997).
    /// @param initConstraintCloseParenToken Optional `)` token of the `init()` constraint (issue #997).
    /// @param unmanagedConstraintKeyword Optional `unmanaged` contextual keyword token (issue #1336).
    init(
        syntaxTree SyntaxTree,
        varianceModifier SyntaxToken?,
        identifier SyntaxToken,
        constraint SyntaxToken?,
        constraintTypeArgumentOpenBracketToken SyntaxToken?,
        constraintTypeArguments SeparatedSyntaxList[TypeClauseSyntax]?,
        constraintTypeArgumentCloseBracketToken SyntaxToken?,
        classConstraintKeyword SyntaxToken?,
        structConstraintKeyword SyntaxToken?,
        initConstraintKeyword SyntaxToken?,
        initConstraintOpenParenToken SyntaxToken?,
        initConstraintCloseParenToken SyntaxToken?,
        unmanagedConstraintKeyword SyntaxToken?
    ) : base(syntaxTree) {
        VarianceModifier = varianceModifier
        Identifier = identifier
        Constraint = constraint
        ConstraintTypeArgumentOpenBracketToken = constraintTypeArgumentOpenBracketToken
        ConstraintTypeArguments = constraintTypeArguments
        ConstraintTypeArgumentCloseBracketToken = constraintTypeArgumentCloseBracketToken
        ClassConstraintKeyword = classConstraintKeyword
        StructConstraintKeyword = structConstraintKeyword
        InitConstraintKeyword = initConstraintKeyword
        InitConstraintOpenParenToken = initConstraintOpenParenToken
        InitConstraintCloseParenToken = initConstraintCloseParenToken
        UnmanagedConstraintKeyword = unmanagedConstraintKeyword
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TypeParameter

    /// Gets the optional variance modifier token (`in` / `out`); Phase 4.3 / ADR-0021.
    prop VarianceModifier SyntaxToken? {
        get;
    }

    /// Gets the type-parameter identifier token.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional constraint identifier token (e.g. `any`, `comparable`, or a sealed-interface
    /// name).
    prop Constraint SyntaxToken? {
        get;
    }

    /// Gets the optional fully-parsed constraint type clause used when the constraint names a
    /// <em>qualified</em> (dotted) type — e.g. `Oahu.Decrypt.INewSplitCallback[TCallback]`.
    /// When set, (cref:Constraint) still holds the first-segment identifier (for
    /// `any`/`comparable` dispatch and error locations), while this clause carries the
    /// full dotted name and per-segment generic arguments so the binder resolves it directly
    /// rather than reconstructing it from (cref:Constraint) + (cref:ConstraintTypeArguments).
    /// The parser assigns this after construction, so the setter invalidates any cached span.
    prop ConstraintType TypeClauseSyntax? {
        get -> constraintType
        internal set {
            constraintType = value
            InvalidateCachedSpan()
        }
    }

    /// Gets the optional opening `[` of the constraint's generic type-argument list (ADR-0089).
    prop ConstraintTypeArgumentOpenBracketToken SyntaxToken? {
        get;
    }

    /// Gets the optional generic type-argument list applied to the constraint (e.g. `[T]` in `IAdd[T]`).
    /// Empty/default when the constraint is a bare identifier (ADR-0089).
    prop ConstraintTypeArguments SeparatedSyntaxList[TypeClauseSyntax]? {
        get;
    }

    /// Gets the optional closing `]` of the constraint's generic type-argument list (ADR-0089).
    prop ConstraintTypeArgumentCloseBracketToken SyntaxToken? {
        get;
    }

    /// Gets the optional `class` keyword token introducing a reference-type constraint (ADR-0097 / issue
    /// #775).
    prop ClassConstraintKeyword SyntaxToken? {
        get;
    }

    /// Gets the optional `struct` keyword token introducing a non-nullable value-type constraint (ADR-0097
    /// / issue #775).
    prop StructConstraintKeyword SyntaxToken? {
        get;
    }

    /// Gets the optional `init` contextual keyword token of an `init()` default-constructor constraint
    /// (ADR-0097 / issue #775; renamed from `new()` by issue #997).
    prop InitConstraintKeyword SyntaxToken? {
        get;
    }

    /// Gets the optional opening `(` of the `init()` constraint (issue #997).
    prop InitConstraintOpenParenToken SyntaxToken? {
        get;
    }

    /// Gets the optional closing `)` of the `init()` constraint (issue #997).
    prop InitConstraintCloseParenToken SyntaxToken? {
        get;
    }

    /// Gets the optional `unmanaged` contextual keyword token introducing an unmanaged-type constraint
    /// (issue #1336).
    prop UnmanagedConstraintKeyword SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this type parameter carries a generic-instance constraint
    /// (ADR-0089).
    prop HasConstraintTypeArguments bool -> ConstraintTypeArgumentOpenBracketToken != nil

    /// Gets a value indicating whether this type parameter carries a `class` constraint (ADR-0097).
    prop HasClassConstraint bool -> ClassConstraintKeyword != nil

    /// Gets a value indicating whether this type parameter carries a `struct` constraint (ADR-0097).
    prop HasStructConstraint bool -> StructConstraintKeyword != nil

    /// Gets a value indicating whether this type parameter carries an `init()` constraint (ADR-0097 / issue
    /// #997).
    prop HasInitConstraint bool -> InitConstraintKeyword != nil

    /// Gets a value indicating whether this type parameter carries an `unmanaged` constraint (issue #1336).
    prop HasUnmanagedConstraint bool -> UnmanagedConstraintKeyword != nil
}
