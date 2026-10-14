// <copyright file="BoundStackAllocExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// ADR-0124 / issues #1024, #1057, #1041: a bound stack-allocation expression
/// in G#-style array grammar `stackalloc [n]T`. Lowers to a CIL
/// `localloc` over `n * sizeof(T)` bytes. The result is either a
/// `System.Span<T>` constructed over the allocated memory (the
/// safe form, (cref:IsPointerForm) = `false`) or the
/// raw `T*` pointer to that memory (the unsafe form,
/// (cref:IsPointerForm) = `true`, only produced inside
/// an `unsafe` context with an unmanaged-pointer target type).
///
/// When an initializer is present (`stackalloc [n]T{a, b, …}` or the
/// count-inferred `stackalloc []T{a, b, …}`), (cref:Count) is the
/// initializer length and (cref:InitializerElements) carries the
/// (element-typed, conversion-bound) values that are stored into the block via
/// scaled indirect writes (issue #1041).
class BoundStackAllocExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundStackAllocExpression) class.
    /// @param syntax The originating syntax.
    /// @param resultType The result type (`Span<T>` or `T*`).
    /// @param elementType The blittable element type `T`.
    /// @param count The element-count expression (int32).
    /// @param isPointerForm Whether the result is the raw `T*` pointer.
    /// @param initializerElements The initializer element values, or empty when there is no initializer.
    init(
        syntax SyntaxNode?,
        resultType TypeSymbol,
        elementType TypeSymbol,
        count BoundExpression,
        isPointerForm bool,
        initializerElements ImmutableArray[BoundExpression] = default(ImmutableArray[BoundExpression])
    ) : base(syntax) {
        ResultType = resultType ?? throw ArgumentNullException("resultType")
        ElementType = elementType ?? throw ArgumentNullException("elementType")
        Count = count ?? throw ArgumentNullException("count")
        IsPointerForm = isPointerForm
        InitializerElements = if initializerElements.IsDefault {
            ImmutableArray[BoundExpression].Empty
        } else {
            initializerElements
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.StackAllocExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> ResultType

    /// Gets the result type (`Span<T>` or `T*`).
    prop ResultType TypeSymbol {
        get;
    }

    /// Gets the blittable element type `T`.
    prop ElementType TypeSymbol {
        get;
    }

    /// Gets the element-count expression (int32).
    prop Count BoundExpression {
        get;
    }

    /// Gets a value indicating whether the result is the raw `T*` pointer (unsafe form).
    prop IsPointerForm bool {
        get;
    }

    /// Gets the initializer element values, or empty when there is no initializer (issue #1041).
    prop InitializerElements ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets a value indicating whether an initializer is present.
    prop HasInitializer bool -> !InitializerElements.IsDefaultOrEmpty
}
