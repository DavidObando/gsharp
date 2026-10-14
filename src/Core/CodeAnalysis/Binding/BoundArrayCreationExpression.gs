// <copyright file="BoundArrayCreationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// Bound array or slice creation expression — `[N]T{e1, e2, …}`
/// for arrays and `[]T{e1, e2, …}` for slices.
class BoundArrayCreationExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundArrayCreationExpression) class.
    /// @param syntax The originating syntax.
    /// @param containerType The array or slice type symbol.
    /// @param elements The bound element initialisers.
    init(syntax SyntaxNode?, containerType TypeSymbol, elements ImmutableArray[BoundExpression]) : base(syntax) {
        DimensionExpressions = ImmutableArray[BoundExpression].Empty
        RectangularLengths = ImmutableArray[int32].Empty
        ContainerType = containerType ?? throw ArgumentNullException("containerType")
        Elements = elements
        ElementType = switch containerType {
            case arr is ArrayTypeSymbol: arr.ElementType
            case slice is SliceTypeSymbol: slice.ElementType
            case rectangular is RectangularArrayTypeSymbol: rectangular.ElementType
            default: throw ArgumentException(
                "Unsupported container type ${containerType.Name} for array/slice creation.",
                "containerType"
            )
        }
    }

    /// Initializes a new instance of the (cref:BoundArrayCreationExpression)
    /// class for a zero-initialised array/slice of a runtime-computed length
    /// (issue #1016 slicing). The result is an array of [`lengthExpression`](paramref)
    /// default-valued elements; no element initialisers are supplied.
    /// @param syntax The originating syntax.
    /// @param containerType The array or slice type symbol.
    /// @param lengthExpression The runtime length expression (int32).
    convenience init(syntax SyntaxNode?, containerType TypeSymbol, lengthExpression BoundExpression) {
        init(
            syntax,
            containerType,
            ImmutableArray.Create(lengthExpression),
            ImmutableArray[BoundExpression].Empty,
            ImmutableArray[int32].Empty
        )
    }

    /// Initializes a new instance of the (cref:BoundArrayCreationExpression) class.
    private init(
        syntax SyntaxNode?,
        containerType TypeSymbol,
        dimensionExpressions ImmutableArray[BoundExpression],
        elements ImmutableArray[BoundExpression],
        rectangularLengths ImmutableArray[int32]
    ) : base(syntax) {
        DimensionExpressions = ImmutableArray[BoundExpression].Empty
        RectangularLengths = ImmutableArray[int32].Empty
        ContainerType = containerType ?? throw ArgumentNullException("containerType")
        Elements = elements
        DimensionExpressions = dimensionExpressions
        RectangularLengths = rectangularLengths
        LengthExpression = if dimensionExpressions.IsDefaultOrEmpty {
            default(BoundExpression?)
        } else {
            dimensionExpressions[0]
        }
        ElementType = switch containerType {
            case arr is ArrayTypeSymbol: arr.ElementType
            case slice is SliceTypeSymbol: slice.ElementType
            case rectangular is RectangularArrayTypeSymbol: rectangular.ElementType
            default: throw ArgumentException(
                "Unsupported container type ${containerType.Name} for array/slice creation.",
                "containerType"
            )
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ArrayCreationExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> ContainerType

    /// Gets the array or slice type symbol.
    prop ContainerType TypeSymbol {
        get;
    }

    /// Gets the element type.
    prop ElementType TypeSymbol {
        get;
    }

    /// Gets the runtime length expression for a zero-initialised array/slice
    /// (issue #1016 slicing), or `null` when the array is built
    /// from explicit (cref:Elements) initialisers.
    prop LengthExpression BoundExpression? {
        get;
    }

    /// Gets the bound element initialisers.
    prop Elements ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets runtime dimensions in evaluation order.
    prop DimensionExpressions ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets constant dimensions used to map flat initializer elements.
    prop RectangularLengths ImmutableArray[int32] {
        get;
    }

    shared {
        /// Creates a runtime-sized rectangular-array allocation.
        /// @param syntax Originating syntax.
        /// @param containerType Rectangular array type.
        /// @param dimensionExpressions Bound dimensions.
        /// @param elements Flat row-major initializer elements.
        /// @param rectangularLengths Constant dimensions for initializer mapping.
        /// @returns Bound rectangular allocation.
        func CreateRectangular(
            syntax SyntaxNode?,
            containerType RectangularArrayTypeSymbol,
            dimensionExpressions ImmutableArray[BoundExpression],
            elements ImmutableArray[BoundExpression] = default(ImmutableArray[BoundExpression]),
            rectangularLengths ImmutableArray[int32] = default(ImmutableArray[int32])
        ) BoundArrayCreationExpression -> BoundArrayCreationExpression(
            syntax,
            containerType,
            dimensionExpressions,
            if elements.IsDefault {
                ImmutableArray[BoundExpression].Empty
            } else {
                elements
            },
            if rectangularLengths.IsDefault {
                ImmutableArray[int32].Empty
            } else {
                rectangularLengths
            }
        )
    }
}
