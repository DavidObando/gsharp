// <copyright file="BaseConstructorInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import System.Collections.Immutable
import System.Reflection

/// Issue #306: describes an explicit base-constructor invocation declared on a
/// GSharp `class` via the `: Base(args)` initializer syntax. It carries
/// the bound argument expressions plus the resolved target constructor so the
/// emitter can forward the arguments to the base `.ctor` instead of chaining
/// to a (possibly non-existent) parameterless base constructor.
class BaseConstructorInitializer {
    /// Initializes a new instance of the (cref:BaseConstructorInitializer) class targeting an imported CLR
    /// base constructor.
    /// @param arguments The bound, conversion-applied argument expressions.
    /// @param clrConstructor The resolved imported CLR base constructor.
    convenience init(arguments ImmutableArray[BoundExpression], clrConstructor ConstructorInfo) {
        init(arguments, clrConstructor, ImmutableArray[RefKind].Empty)
    }

    /// Initializes a new instance of the (cref:BaseConstructorInitializer) class targeting an imported CLR
    /// base constructor, with per-argument by-reference passing modes.
    /// @param arguments The bound, conversion-applied argument expressions.
    /// @param clrConstructor The resolved imported CLR base constructor.
    /// @param argumentRefKinds The by-reference passing mode of each argument (issue #306, item 2:
    /// `ref`/`out`/`in` base-constructor parameters).
    init(
        arguments ImmutableArray[BoundExpression],
        clrConstructor ConstructorInfo,
        argumentRefKinds ImmutableArray[RefKind]
    ) {
        Arguments = arguments
        ClrConstructor = clrConstructor
        GSharpBaseType = nil
        ArgumentRefKinds = if argumentRefKinds.IsDefault {
            ImmutableArray[RefKind].Empty
        } else {
            argumentRefKinds
        }
    }

    /// Initializes a new instance of the (cref:BaseConstructorInitializer) class targeting a GSharp base
    /// class constructor.
    /// @param arguments The bound, conversion-applied argument expressions.
    /// @param gsharpBaseType The GSharp base class whose primary constructor is targeted.
    convenience init(arguments ImmutableArray[BoundExpression], gsharpBaseType StructSymbol) {
        init(arguments, gsharpBaseType, nil)
    }

    /// Initializes a new instance of the (cref:BaseConstructorInitializer)
    /// class targeting a specific explicit `init(...)` constructor declared on a GSharp base class (issue
    /// #1060).
    /// @param arguments The bound, conversion-applied argument expressions.
    /// @param gsharpBaseType The GSharp base class whose constructor is targeted.
    /// @param gsharpConstructor The resolved explicit base-class constructor, or `null` to target the
    /// primary constructor.
    init(arguments ImmutableArray[BoundExpression], gsharpBaseType StructSymbol, gsharpConstructor ConstructorSymbol?) {
        Arguments = arguments
        ClrConstructor = nil
        GSharpBaseType = gsharpBaseType
        GSharpConstructor = gsharpConstructor
        ArgumentRefKinds = ImmutableArray[RefKind].Empty
    }

    /// Gets the by-reference passing mode of each forwarded argument (issue #306, item 2). Empty when every
    /// argument is passed by value.
    prop ArgumentRefKinds ImmutableArray[RefKind] {
        get;
    }

    /// Gets the bound argument expressions forwarded to the base constructor (already converted to the
    /// target parameter types).
    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets the resolved imported CLR base constructor, or `null` when the base class is a GSharp type.
    prop ClrConstructor ConstructorInfo? {
        get;
    }

    /// Gets the GSharp base class whose constructor is targeted, or `null` when the base class is an
    /// imported CLR type.
    prop GSharpBaseType StructSymbol? {
        get;
    }

    /// Gets the resolved explicit `init(...)` constructor on the GSharp base class
    /// that this initializer targets, or `null` when the target is the base class's
    /// primary constructor (or the base is an imported CLR type) (issue #1060).
    prop GSharpConstructor ConstructorSymbol? {
        get;
    }

    /// Gets a value indicating whether the targeted base constructor lives on an imported CLR type.
    prop IsClrBase bool -> ClrConstructor != nil

    /// Produces a copy of this initializer targeting the same base constructor but
    /// carrying a different forwarded argument list. Used by the emit-path lowerers
    /// (e.g. interpolated-string lowering) to replace base-initializer arguments
    /// with their lowered forms while preserving the resolved target and ref kinds.
    /// @param arguments The replacement bound argument expressions.
    /// @returns A new (cref:BaseConstructorInitializer) with the supplied arguments.
    func WithArguments(arguments ImmutableArray[BoundExpression]) BaseConstructorInitializer {
        if ClrConstructor is {} clrConstructor {
            return BaseConstructorInitializer(arguments, clrConstructor, ArgumentRefKinds)
        }
        return BaseConstructorInitializer(
            arguments,
            Invariant.Required(
                GSharpBaseType,
                "a G# base initializer has a G# base type",
                expression: "GSharpBaseType"
            ),
            GSharpConstructor
        )
    }
}
