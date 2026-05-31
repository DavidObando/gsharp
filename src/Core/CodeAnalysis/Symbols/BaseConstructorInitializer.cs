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
    {
        Arguments = arguments;
        ClrConstructor = clrConstructor;
        GSharpBaseType = null;
    }

    /// <summary>Initializes a new instance of the <see cref="BaseConstructorInitializer"/> class targeting a GSharp base class constructor.</summary>
    /// <param name="arguments">The bound, conversion-applied argument expressions.</param>
    /// <param name="gsharpBaseType">The GSharp base class whose primary constructor is targeted.</param>
    public BaseConstructorInitializer(ImmutableArray<BoundExpression> arguments, StructSymbol gsharpBaseType)
    {
        Arguments = arguments;
        ClrConstructor = null;
        GSharpBaseType = gsharpBaseType;
    }

    /// <summary>Gets the bound argument expressions forwarded to the base constructor (already converted to the target parameter types).</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>Gets the resolved imported CLR base constructor, or <c>null</c> when the base class is a GSharp type.</summary>
    public ConstructorInfo ClrConstructor { get; }

    /// <summary>Gets the GSharp base class whose constructor is targeted, or <c>null</c> when the base class is an imported CLR type.</summary>
    public StructSymbol GSharpBaseType { get; }

    /// <summary>Gets a value indicating whether the targeted base constructor lives on an imported CLR type.</summary>
    public bool IsClrBase => ClrConstructor != null;
}
