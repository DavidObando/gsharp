// <copyright file="BaseConstructorInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #306: describes an explicit base-constructor invocation declared on a
/// GSharp <c>class</c> via the <c>: Base(args)</c> initializer syntax. It carries
/// the bound argument expressions plus the resolved target constructor so the
/// emitter can forward the arguments to the base <c>.ctor</c> instead of chaining
/// to a (possibly non-existent) parameterless base constructor.
/// </summary>
public sealed class BaseConstructorInitializer
{
    /// <summary>Initializes a new instance of the <see cref="BaseConstructorInitializer"/> class targeting an imported CLR base constructor.</summary>
    /// <param name="arguments">The bound, conversion-applied argument expressions.</param>
    /// <param name="clrConstructor">The resolved imported CLR base constructor.</param>
    public BaseConstructorInitializer(ImmutableArray<BoundExpression> arguments, ConstructorInfo clrConstructor)
        : this(arguments, clrConstructor, ImmutableArray<RefKind>.Empty)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BaseConstructorInitializer"/> class targeting an imported CLR base constructor, with per-argument by-reference passing modes.</summary>
    /// <param name="arguments">The bound, conversion-applied argument expressions.</param>
    /// <param name="clrConstructor">The resolved imported CLR base constructor.</param>
    /// <param name="argumentRefKinds">The by-reference passing mode of each argument (issue #306, item 2: <c>ref</c>/<c>out</c>/<c>in</c> base-constructor parameters).</param>
    public BaseConstructorInitializer(ImmutableArray<BoundExpression> arguments, ConstructorInfo clrConstructor, ImmutableArray<RefKind> argumentRefKinds)
    {
        Arguments = arguments;
        ClrConstructor = clrConstructor;
        GSharpBaseType = null;
        ArgumentRefKinds = argumentRefKinds.IsDefault ? ImmutableArray<RefKind>.Empty : argumentRefKinds;
    }

    /// <summary>Initializes a new instance of the <see cref="BaseConstructorInitializer"/> class targeting a GSharp base class constructor.</summary>
    /// <param name="arguments">The bound, conversion-applied argument expressions.</param>
    /// <param name="gsharpBaseType">The GSharp base class whose primary constructor is targeted.</param>
    public BaseConstructorInitializer(ImmutableArray<BoundExpression> arguments, StructSymbol gsharpBaseType)
    {
        Arguments = arguments;
        ClrConstructor = null;
        GSharpBaseType = gsharpBaseType;
        ArgumentRefKinds = ImmutableArray<RefKind>.Empty;
    }

    /// <summary>Gets the by-reference passing mode of each forwarded argument (issue #306, item 2). Empty when every argument is passed by value.</summary>
    public ImmutableArray<RefKind> ArgumentRefKinds { get; }

    /// <summary>Gets the bound argument expressions forwarded to the base constructor (already converted to the target parameter types).</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>Gets the resolved imported CLR base constructor, or <c>null</c> when the base class is a GSharp type.</summary>
    public ConstructorInfo ClrConstructor { get; }

    /// <summary>Gets the GSharp base class whose constructor is targeted, or <c>null</c> when the base class is an imported CLR type.</summary>
    public StructSymbol GSharpBaseType { get; }

    /// <summary>Gets a value indicating whether the targeted base constructor lives on an imported CLR type.</summary>
    public bool IsClrBase => ClrConstructor != null;

    /// <summary>
    /// Produces a copy of this initializer targeting the same base constructor but
    /// carrying a different forwarded argument list. Used by the emit-path lowerers
    /// (e.g. interpolated-string lowering) to replace base-initializer arguments
    /// with their lowered forms while preserving the resolved target and ref kinds.
    /// </summary>
    /// <param name="arguments">The replacement bound argument expressions.</param>
    /// <returns>A new <see cref="BaseConstructorInitializer"/> with the supplied arguments.</returns>
    public BaseConstructorInitializer WithArguments(ImmutableArray<BoundExpression> arguments)
    {
        return IsClrBase
            ? new BaseConstructorInitializer(arguments, ClrConstructor, ArgumentRefKinds)
            : new BaseConstructorInitializer(arguments, GSharpBaseType);
    }
}
