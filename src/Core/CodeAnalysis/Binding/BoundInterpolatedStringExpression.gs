// <copyright file="BoundInterpolatedStringExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// ADR-0055 (Phase 2): a first-class bound node for an interpolated string
/// literal. Carries an ordered list of (cref:BoundInterpolatedStringPart)
/// — each either literal text or a `{ value, alignment, format }` hole —
/// so that the tree-walk interpreter and the IL emitter can render the string
/// correctly and identically from one representation.
/// @remarks The node's static type is always (cref:TypeSymbol.String). Lowering
/// happens late, not in the binder:
/// - the historical tree-walking evaluator (deleted in ADR-0156 Phase 3c) rendered the node directly
/// via composite formatting (alignment + format, current culture), and
/// - the IL emitter lowers it (issue #368) to the C# 10
/// `System.Runtime.CompilerServices.DefaultInterpolatedStringHandler` pattern: construct the? handler,
/// call `AppendLiteral`/ `AppendFormatted<T>` in order, then `ToStringAndClear()`.
/// Routing lowering late (rather than the legacy eager binder `+`-chain)
/// also fixes the #366 memory-unsafe-IL crash class.
class BoundInterpolatedStringExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundInterpolatedStringExpression) class.
    /// @param syntax The originating syntax.
    /// @param parts The ordered literal/hole parts.
    convenience init(syntax SyntaxNode?, parts ImmutableArray[BoundInterpolatedStringPart]) {
        init(syntax, parts, nil)
    }

    /// Initializes a new instance of the (cref:BoundInterpolatedStringExpression) class.
    /// @param syntax The originating syntax.
    /// @param parts The ordered literal/hole parts.
    /// @param handler Issue #368: the user-defined `[InterpolatedStringHandler]` target this
    /// interpolation is converted to, or `null` for the default
    /// `string` result.
    init(
        syntax SyntaxNode?,
        parts ImmutableArray[BoundInterpolatedStringPart],
        handler InterpolatedStringHandlerInfo?
    ) : base(syntax) {
        Parts = parts
        Handler = handler
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.InterpolatedStringExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> Handler?.HandlerType ?? TypeSymbol.String

    /// Gets the ordered literal/hole parts.
    prop Parts ImmutableArray[BoundInterpolatedStringPart] {
        get;
    }

    /// Gets the user-defined interpolated-string-handler target (issue #368),
    /// or `null` when this interpolation produces a plain
    /// `string`.
    prop Handler InterpolatedStringHandlerInfo? {
        get;
    }

    /// Returns a copy of this node with a different handler target and parts.
    /// @param parts The replacement parts.
    /// @param handler The replacement handler target (may be `null`).
    /// @returns The updated node.
    func Update(
        parts ImmutableArray[BoundInterpolatedStringPart],
        handler InterpolatedStringHandlerInfo?
    ) BoundInterpolatedStringExpression -> BoundInterpolatedStringExpression(Syntax, parts, handler)
}
