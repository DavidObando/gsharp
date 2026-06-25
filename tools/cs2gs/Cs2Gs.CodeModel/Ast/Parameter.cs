// <copyright file="Parameter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// A formal parameter <c>name Type</c>, optionally variadic (<c>name ...T</c>),
/// ref-kinded (<c>ref</c>/<c>out</c>/<c>in</c>), or with a default value.
/// </summary>
public sealed class Parameter : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Parameter"/> class.
    /// </summary>
    /// <param name="name">The parameter name.</param>
    /// <param name="type">The parameter type (for a variadic param this is the element type).</param>
    /// <param name="isVariadic">Whether the parameter is variadic (<c>...T</c>).</param>
    /// <param name="refKind">The optional ref-kind modifier (<c>ref</c>/<c>out</c>/<c>in</c>).</param>
    /// <param name="defaultValue">The optional default value.</param>
    /// <param name="attributes">Optional per-parameter attributes.</param>
    public Parameter(
        string name,
        GTypeReference type,
        bool isVariadic = false,
        string refKind = null,
        GExpression defaultValue = null,
        IReadOnlyList<AttributeUse> attributes = null)
    {
        Name = name;
        Type = type;
        IsVariadic = isVariadic;
        RefKind = refKind;
        DefaultValue = defaultValue;
        Attributes = attributes ?? new List<AttributeUse>();
    }

    /// <summary>Gets the parameter name.</summary>
    public string Name { get; }

    /// <summary>Gets the parameter type (element type when variadic).</summary>
    public GTypeReference Type { get; }

    /// <summary>Gets a value indicating whether the parameter is variadic.</summary>
    public bool IsVariadic { get; }

    /// <summary>Gets the optional ref-kind modifier.</summary>
    public string RefKind { get; }

    /// <summary>Gets the optional default value.</summary>
    public GExpression DefaultValue { get; }

    /// <summary>Gets the per-parameter attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }
}

/// <summary>
/// A generic type parameter and its constraints, rendered inside the bracket
/// section (ADR-0020/ADR-0097, ADR-0115 §B.7). The legacy slot carries a single
/// constraint name (<c>any</c>, <c>comparable</c>, or an interface); the flag
/// constraints (<c>class</c>, <c>struct</c>, <c>init()</c>) are repeatable.
/// </summary>
public sealed class TypeParameter : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TypeParameter"/> class.
    /// </summary>
    /// <param name="name">The type-parameter name.</param>
    /// <param name="legacyConstraint">The legacy single-slot constraint, if any.</param>
    /// <param name="flagConstraints">The repeatable flag constraints, in order.</param>
    /// <param name="variance">The variance marker.</param>
    public TypeParameter(
        string name,
        string legacyConstraint = null,
        IReadOnlyList<string> flagConstraints = null,
        Variance variance = Variance.None)
    {
        Name = name;
        LegacyConstraint = legacyConstraint;
        FlagConstraints = flagConstraints ?? new List<string>();
        Variance = variance;
    }

    /// <summary>Gets the type-parameter name.</summary>
    public string Name { get; }

    /// <summary>Gets the legacy single-slot constraint, if any.</summary>
    public string LegacyConstraint { get; }

    /// <summary>Gets the repeatable flag constraints (<c>class</c>, <c>struct</c>, <c>init()</c>).</summary>
    public IReadOnlyList<string> FlagConstraints { get; }

    /// <summary>Gets the variance marker.</summary>
    public Variance Variance { get; }
}

/// <summary>
/// A named or positional argument inside an attribute application
/// (<c>"x"</c> or <c>EntryPoint: "x"</c>).
/// </summary>
public sealed class AttributeArgument : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AttributeArgument"/> class.
    /// </summary>
    /// <param name="value">The argument value.</param>
    /// <param name="name">The optional argument name (named-argument form).</param>
    public AttributeArgument(GExpression value, string name = null)
    {
        Value = value;
        Name = name;
    }

    /// <summary>Gets the optional argument name.</summary>
    public string Name { get; }

    /// <summary>Gets the argument value.</summary>
    public GExpression Value { get; }
}

/// <summary>
/// An attribute application <c>@Name(args)</c> with an optional use-site target
/// (ADR-0047, ADR-0115 §B.11). One per line, order preserved.
/// </summary>
public sealed class AttributeUse : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AttributeUse"/> class.
    /// </summary>
    /// <param name="name">The (possibly dotted) attribute name.</param>
    /// <param name="arguments">The attribute arguments.</param>
    /// <param name="target">The optional use-site target (e.g. <c>return</c>, <c>field</c>).</param>
    public AttributeUse(string name, IReadOnlyList<AttributeArgument> arguments = null, string target = null)
    {
        Name = name;
        Arguments = arguments ?? new List<AttributeArgument>();
        Target = target;
    }

    /// <summary>Gets the (possibly dotted) attribute name.</summary>
    public string Name { get; }

    /// <summary>Gets the attribute arguments.</summary>
    public IReadOnlyList<AttributeArgument> Arguments { get; }

    /// <summary>Gets the optional use-site target.</summary>
    public string Target { get; }
}

/// <summary>
/// A receiver clause <c>(name Type)</c> for an extension function on a
/// non-owned type (ADR-0019/ADR-0079, ADR-0115 §B.5).
/// </summary>
public sealed class Receiver : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Receiver"/> class.
    /// </summary>
    /// <param name="name">The receiver parameter name.</param>
    /// <param name="type">The non-owned receiver type.</param>
    public Receiver(string name, GTypeReference type)
    {
        Name = name;
        Type = type;
    }

    /// <summary>Gets the receiver parameter name.</summary>
    public string Name { get; }

    /// <summary>Gets the non-owned receiver type.</summary>
    public GTypeReference Type { get; }
}
