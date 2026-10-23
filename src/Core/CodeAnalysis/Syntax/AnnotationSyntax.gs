// <copyright file="AnnotationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable
import System.Text

/// Represents a Kotlin-style annotation lead-in (ADR-0047): an
/// `@` token optionally followed by a use-site target qualifier
/// (`field:`, `param:`, `return:`, …), a dotted attribute
/// name, and an optional argument list.
///
/// Examples:
/// - `@Serializable`
/// - `@Obsolete("use Bar")`
/// - `@field:NonSerialized`
/// - `@System.Diagnostics.Conditional("DEBUG")`
/// Phase 1 / issue #141 only models the surface syntax; the binder (Phase 2)
/// will resolve the dotted name through the C#-style
/// `Foo` / `FooAttribute` lookup and the emitter (Phase 3) will
/// write the corresponding `CustomAttribute` metadata row.
partial class AnnotationSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:AnnotationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param atToken The leading `@` token.
    /// @param target Optional use-site target qualifier (e.g. `field:`); `null` when the annotation uses
    /// the default target for its declaration position.
    /// @param nameSegments The dotted attribute-name path. The first segment is the leftmost identifier;
    /// dots are interleaved into [`dotTokens`](paramref).
    /// @param dotTokens The `.` tokens that separate name segments. Always `nameSegments.Length - 1`
    /// entries (possibly empty).
    /// @param openParenthesisToken Optional opening `(` token. Non-`null` iff an argument list was
    /// supplied.
    /// @param arguments The positional / named-argument list (per ADR-0047 §1). Empty when no argument list
    /// was supplied.
    /// @param closeParenthesisToken Optional closing `)` token. Non-`null` iff
    /// [`openParenthesisToken`](paramref) is non-`null`.
    /// @param typeArgumentOpenBracketToken Issue #1913: the opening `[` of a C#11-style generic attribute's
    /// type-argument list (e.g. `@Tag[int32]`), or `null` when the attribute name carries none.
    /// @param typeArguments The generic attribute's type-argument list, or the default value when none is
    /// present.
    /// @param typeArgumentCloseBracketToken The closing `]` of the type-argument list, or `null` when none
    /// is present.
    init(
        syntaxTree SyntaxTree,
        atToken SyntaxToken,
        target AnnotationTargetSyntax?,
        nameSegments ImmutableArray[SyntaxToken],
        dotTokens ImmutableArray[SyntaxToken],
        openParenthesisToken SyntaxToken?,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesisToken SyntaxToken?,
        typeArgumentOpenBracketToken SyntaxToken? = nil,
        typeArguments SeparatedSyntaxList[TypeClauseSyntax]? = nil,
        typeArgumentCloseBracketToken SyntaxToken? = nil
    ) : base(syntaxTree) {
        AtToken = atToken
        Target = target
        NameSegments = nameSegments
        DotTokens = dotTokens
        OpenParenthesisToken = openParenthesisToken
        Arguments = arguments
        CloseParenthesisToken = closeParenthesisToken
        TypeArgumentOpenBracketToken = typeArgumentOpenBracketToken
        TypeArguments = typeArguments
        TypeArgumentCloseBracketToken = typeArgumentCloseBracketToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.Annotation

    /// Gets the leading `@` token.
    prop AtToken SyntaxToken {
        get;
    }

    /// Gets the optional use-site target qualifier; `null` when none is supplied (annotation uses the
    /// default? target).
    prop Target AnnotationTargetSyntax? {
        get;
    }

    /// Gets the dotted attribute-name segments (the leftmost identifier is at index 0).
    prop NameSegments ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the `.` tokens that separate (cref:NameSegments).
    prop DotTokens ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the optional opening `(` of the argument list; `null` when no parenthesised argument list was
    /// supplied.
    prop OpenParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the (possibly empty) annotation argument list.
    prop Arguments SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the optional closing `)` of the argument list; `null` when no parenthesised argument list was
    /// supplied.
    prop CloseParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the opening `[` of a C#11-style generic attribute's type-argument list (issue #1913), or `null`
    /// when none is present.
    prop TypeArgumentOpenBracketToken SyntaxToken? {
        get;
    }

    /// Gets the generic attribute's type-argument list (issue #1913); the default value when none is
    /// present.
    prop TypeArguments SeparatedSyntaxList[TypeClauseSyntax]? {
        get;
    }

    /// Gets the closing `]` of the type-argument list (issue #1913), or `null` when none is present.
    prop TypeArgumentCloseBracketToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this annotation carries a parenthesised argument list.
    prop HasArgumentList bool -> OpenParenthesisToken != nil

    /// Gets a value indicating whether this annotation carries a generic type-argument list (issue #1913,
    /// e.g. `@Tag[int32]`).
    prop HasTypeArgumentList bool -> TypeArgumentOpenBracketToken != nil

    /// Gets the dotted attribute name as a string (e.g. `"System.Diagnostics.Conditional"`).
    /// @remarks ADR-0170 / issue #3610: segments use (cref:SyntaxToken.ValueText)
    /// so an escaped spelling (`@$class(...)` naming an attribute class
    /// declared `class $class`) resolves by its semantic name.
    /// @returns The flattened dotted name; segments are joined with `.`.
    func GetNameText() string {
        if NameSegments.Length == 1 {
            return NameSegments[0].ValueText
        }
        let sb = StringBuilder()
        for var i = 0; i < NameSegments.Length; i++ {
            if i > 0 {
                sb.Append('.')
            }
            sb.Append(NameSegments[i].ValueText)
        }
        return sb.ToString()
    }
}
