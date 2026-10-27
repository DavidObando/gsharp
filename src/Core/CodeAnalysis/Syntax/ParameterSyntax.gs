// <copyright file="ParameterSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a parameter in the language.
@SyntaxChildSourceOrder
partial class ParameterSyntax : SyntaxNode {
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private var scopedModifier SyntaxToken?

    private var refKindModifier SyntaxToken?
    private var equalsToken SyntaxToken?
    private var defaultValue ExpressionSyntax?

    /// Initializes a new instance of the (cref:ParameterSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The parameter identifier.
    /// @param ellipsisToken Optional `...` token preceding the type clause for variadic parameters (Phase
    /// 4.8).
    /// @param type The parameter type.
    init(syntaxTree SyntaxTree, identifier SyntaxToken, ellipsisToken SyntaxToken?, type TypeClauseSyntax?) : base(
        syntaxTree
    ) {
        Identifier = identifier
        EllipsisToken = ellipsisToken
        Type = type
        Annotations = ImmutableArray[AnnotationSyntax].Empty
    }

    /// Initializes a new instance of the (cref:ParameterSyntax) class for a non-variadic parameter.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The parameter identifier.
    /// @param type The parameter type.
    convenience init(syntaxTree SyntaxTree, identifier SyntaxToken, type TypeClauseSyntax?) {
        init(syntaxTree, identifier, nil, type)
    }

    /// Initializes a new instance of the (cref:ParameterSyntax) class
    /// for a DESTRUCTURED arrow-lambda parameter (ADR-0185) — `Identifier`
    /// and `Type` are both `null` and
    /// (cref:DeconstructionPattern) carries the
    /// `(name1 T1, name2 T2, ...)` pattern instead. Only
    /// (cref:Parser.ParseLambdaParameter) ever constructs this shape
    /// (ADR-0185 Decision point 2: every OTHER surface that shares
    /// `Parser.Members.cs`'s `ParseParameter` — named functions,
    /// primary constructors, indexers, receiver clauses, `init`
    /// declarations, event payloads — never sees a null (cref:Identifier)).
    /// @param syntaxTree The parent syntax tree.
    /// @param deconstructionPattern The destructuring pattern this parameter binds.
    init(syntaxTree SyntaxTree, deconstructionPattern TupleDeconstructionPatternSyntax) : base(syntaxTree) {
        Identifier = nil
        EllipsisToken = nil
        Type = nil
        DeconstructionPattern = deconstructionPattern
        Annotations = ImmutableArray[AnnotationSyntax].Empty
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.Parameter

    /// Gets the Kotlin-style annotations (ADR-0047) attached to this parameter.
    /// Empty when the parameter has no `@` lead-ins. Populated by the
    /// parser via (cref:WithAnnotations).
    prop Annotations ImmutableArray[AnnotationSyntax] {
        get;
        private set;
    }

    /// Gets the parameter identifier, or `null` for a
    /// destructured parameter (ADR-0185) — see (cref:DeconstructionPattern).
    /// Every non-lambda parameter production (`Parser.Members.cs`'s
    /// `ParseParameter`) always sets this; only a destructured
    /// arrow-lambda parameter leaves it null.
    prop Identifier SyntaxToken? {
        get;
    }

    /// Gets the `(name1 T1, name2 T2, ...)` tuple-destructuring pattern
    /// (ADR-0185) this parameter binds, or `null` for an
    /// ordinary single-identifier parameter. Exactly one of
    /// (cref:Identifier)/(cref:DeconstructionPattern) is
    /// non-null. Only (cref:Parser.ParseLambdaParameter) ever
    /// produces a non-null value here (ADR-0185 Decision point 2).
    prop DeconstructionPattern TupleDeconstructionPatternSyntax? {
        get;
    }

    /// Gets a value indicating whether this is a destructured parameter (ADR-0185).
    prop IsDestructured bool -> DeconstructionPattern != nil

    /// Gets the optional `...` token marking the parameter as variadic (Phase 4.8).
    prop EllipsisToken SyntaxToken? {
        get;
    }

    /// Gets the parameter type. Always `null` for a
    /// destructured parameter (ADR-0185) — see (cref:DeconstructionPattern).
    prop Type TypeClauseSyntax? {
        get;
    }

    /// Gets a value indicating whether this is a variadic parameter (Phase 4.8).
    prop IsVariadic bool -> EllipsisToken != nil

    /// Gets or sets the optional `scoped` contextual modifier token (ADR-0058 / issue #376).
    /// When non-null, the parameter is `scoped` — its safe-to-escape scope is restricted to
    /// the current function body and the value may not be returned.
    /// Assigned by the parser; `null` otherwise.
    prop ScopedModifier SyntaxToken? {
        get -> scopedModifier
        set {
            scopedModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this parameter carries the `scoped` modifier (ADR-0058).
    prop IsScoped bool -> ScopedModifier != nil

    /// Gets or sets the ADR-0060 optional `ref`, `out`, or `in` contextual modifier preceding the parameter
    /// identifier. The modifier carries the CLR ref-kind contract for this parameter; it composes with
    /// (cref:ScopedModifier) (which precedes it). Assigned by the parser; `null` otherwise.
    prop RefKindModifier SyntaxToken? {
        get -> refKindModifier
        set {
            refKindModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this parameter carries a `ref`/`out`/`in` modifier (ADR-0060).
    prop HasRefKindModifier bool -> RefKindModifier != nil

    /// Gets or sets the ADR-0063 `=` token preceding the default-value expression.
    /// When non-null the parameter declares a default value, making it optional at call sites.
    prop EqualsToken SyntaxToken? {
        get -> equalsToken
        set {
            equalsToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the ADR-0063 default-value expression for an optional parameter.
    /// Restricted by the binder to a compile-time constant representable in CLR
    /// parameter metadata (numeric/bool/char/string/enum constant, or `nil`
    /// for a nullable/reference? type).
    prop DefaultValue ExpressionSyntax? {
        get -> defaultValue
        set {
            defaultValue = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this parameter declares a default value (ADR-0063).
    prop HasDefaultValue bool -> EqualsToken != nil && DefaultValue != nil

    /// Attaches the given annotation list to this parameter and returns this same instance for fluent
    /// parser use.
    /// @param annotations The annotation list to attach (may be empty).
    /// @returns This same (cref:ParameterSyntax), with (cref:Annotations) updated.
    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) ParameterSyntax {
        Annotations = if annotations.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            annotations
        }
        InvalidateCachedSpan()
        return this
    }
}
