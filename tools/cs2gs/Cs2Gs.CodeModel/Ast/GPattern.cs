// <copyright file="GPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Base type for a G# <c>switch</c> pattern (spec §Pattern matching). A
/// <see langword="null"/> pattern in a <see cref="SwitchArm"/> denotes the
/// <c>default</c> arm.
/// </summary>
public abstract class GPattern : GNode
{
}

/// <summary>
/// A constant pattern <c>case 0:</c> / <c>case "x":</c> matching a literal value
/// (spec §Pattern matching, <c>ConstantPattern</c>).
/// </summary>
public sealed class ConstantPattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ConstantPattern"/> class.
    /// </summary>
    /// <param name="value">The constant value expression.</param>
    public ConstantPattern(GExpression value)
    {
        Value = value;
    }

    /// <summary>Gets the constant value expression.</summary>
    public GExpression Value { get; }
}

/// <summary>
/// A relational pattern <c>case &lt; 10:</c> matching against a comparison
/// operator and bound (spec §Pattern matching, <c>RelationalPattern</c>).
/// </summary>
public sealed class RelationalPattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="RelationalPattern"/> class.
    /// </summary>
    /// <param name="op">The relational operator token (e.g. <c>&lt;</c>).</param>
    /// <param name="value">The bound expression.</param>
    public RelationalPattern(string op, GExpression value)
    {
        Operator = op;
        Value = value;
    }

    /// <summary>Gets the relational operator token.</summary>
    public string Operator { get; }

    /// <summary>Gets the bound expression.</summary>
    public GExpression Value { get; }
}

/// <summary>
/// A type pattern <c>case d is Dog:</c> binding the subject to a designator when
/// it has the given runtime type (spec §Pattern matching, <c>TypePattern</c>).
/// </summary>
public sealed class TypePattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TypePattern"/> class.
    /// </summary>
    /// <param name="designator">The bound variable name.</param>
    /// <param name="type">The matched type.</param>
    public TypePattern(string designator, GTypeReference type)
    {
        Designator = designator;
        Type = type;
    }

    /// <summary>Gets the bound variable name.</summary>
    public string Designator { get; }

    /// <summary>Gets the matched type.</summary>
    public GTypeReference Type { get; }
}

/// <summary>
/// One field of a property pattern (<c>X: &lt;pattern&gt;</c>).
/// </summary>
public sealed class PropertyPatternField : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PropertyPatternField"/> class.
    /// </summary>
    /// <param name="name">The property name.</param>
    /// <param name="pattern">The nested pattern the property must match.</param>
    public PropertyPatternField(string name, GPattern pattern)
    {
        Name = name;
        Pattern = pattern;
    }

    /// <summary>Gets the property name.</summary>
    public string Name { get; }

    /// <summary>Gets the nested pattern.</summary>
    public GPattern Pattern { get; }
}

/// <summary>
/// A property pattern <c>case { X: 0, Y: 0 }:</c> matching the subject's members
/// against nested patterns (spec §Pattern matching, <c>PropertyPattern</c>).
/// </summary>
public sealed class PropertyPattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PropertyPattern"/> class.
    /// </summary>
    /// <param name="fields">The property field patterns.</param>
    public PropertyPattern(IReadOnlyList<PropertyPatternField> fields)
    {
        Fields = fields ?? new List<PropertyPatternField>();
    }

    /// <summary>Gets the property field patterns.</summary>
    public IReadOnlyList<PropertyPatternField> Fields { get; }
}

/// <summary>
/// A discard pattern <c>case _:</c> matching any value (spec §Pattern matching,
/// <c>DiscardPattern</c>).
/// </summary>
public sealed class DiscardPattern : GPattern
{
}

/// <summary>
/// A binary pattern combinator — a conjunction (<c>and</c>) or disjunction
/// (<c>or</c>) of two sub-patterns (issue #992, spec §Pattern matching,
/// <c>BinaryPattern</c>).
/// </summary>
public sealed class BinaryPattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BinaryPattern"/> class.
    /// </summary>
    /// <param name="isConjunction"><see langword="true"/> for <c>and</c>; <see langword="false"/> for <c>or</c>.</param>
    /// <param name="left">The left sub-pattern.</param>
    /// <param name="right">The right sub-pattern.</param>
    public BinaryPattern(bool isConjunction, GPattern left, GPattern right)
    {
        IsConjunction = isConjunction;
        Left = left;
        Right = right;
    }

    /// <summary>Gets a value indicating whether this is an <c>and</c> (conjunction) pattern.</summary>
    public bool IsConjunction { get; }

    /// <summary>Gets the left sub-pattern.</summary>
    public GPattern Left { get; }

    /// <summary>Gets the right sub-pattern.</summary>
    public GPattern Right { get; }
}

/// <summary>
/// A negated pattern <c>not &lt;pattern&gt;</c> (issue #992, spec §Pattern
/// matching, <c>NotPattern</c>).
/// </summary>
public sealed class NotPattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="NotPattern"/> class.
    /// </summary>
    /// <param name="pattern">The negated sub-pattern.</param>
    public NotPattern(GPattern pattern)
    {
        Pattern = pattern;
    }

    /// <summary>Gets the negated sub-pattern.</summary>
    public GPattern Pattern { get; }
}

/// <summary>
/// A parenthesized pattern <c>( &lt;pattern&gt; )</c> used to override
/// combinator precedence (issue #992, spec §Pattern matching).
/// </summary>
public sealed class ParenthesizedPattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ParenthesizedPattern"/> class.
    /// </summary>
    /// <param name="pattern">The inner pattern.</param>
    public ParenthesizedPattern(GPattern pattern)
    {
        Pattern = pattern;
    }

    /// <summary>Gets the inner pattern.</summary>
    public GPattern Pattern { get; }
}

/// <summary>
/// A list pattern <c>[1, .., 4]</c> matching an array/slice element-by-element,
/// with at most one <see cref="SlicePattern"/> element (issue #1889, spec
/// §Pattern matching, <c>ListPattern</c>).
/// </summary>
public sealed class ListPattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ListPattern"/> class.
    /// </summary>
    /// <param name="elements">The element patterns, in source order.</param>
    public ListPattern(IReadOnlyList<GPattern> elements)
    {
        Elements = elements ?? new List<GPattern>();
    }

    /// <summary>Gets the element patterns, in source order.</summary>
    public IReadOnlyList<GPattern> Elements { get; }
}

/// <summary>
/// A slice ("rest") subpattern inside a <see cref="ListPattern"/>, e.g. the
/// <c>..</c> in <c>[1, .., 4]</c> — a discard slice, a named capture
/// <c>..rest</c> binding the middle slice to a new <c>[]T</c> variable, or a
/// nested sub-pattern matched against the middle slice (issue #1889, spec
/// §Pattern matching, <c>SlicePattern</c>).
/// </summary>
public sealed class SlicePattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SlicePattern"/> class.
    /// </summary>
    /// <param name="designator">The capture name, or <see langword="null"/> for a discard/nested-pattern slice.</param>
    /// <param name="pattern">The nested sub-pattern matched against the slice, or <see langword="null"/>.</param>
    public SlicePattern(string designator, GPattern pattern = null)
    {
        Designator = designator;
        Pattern = pattern;
    }

    /// <summary>Gets the capture name, or <see langword="null"/>.</summary>
    public string Designator { get; }

    /// <summary>Gets the nested sub-pattern matched against the slice, or <see langword="null"/>.</summary>
    public GPattern Pattern { get; }
}
