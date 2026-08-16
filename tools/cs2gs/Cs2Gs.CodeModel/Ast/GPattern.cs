// <copyright file="GPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Base type for a G# pattern (spec §Pattern matching). Patterns are shared by
/// switch arms and native boolean <c>is</c> expressions. A
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
/// A type pattern binding the subject to a designator when it has the given
/// runtime type (spec §Pattern matching, <c>TypePattern</c>). Two spellings
/// exist: the switch form <c>case d is Dog:</c> and the ADR-0166 designation
/// form <c>Dog d</c> / <c>Dog { Name: "Rex" } d</c>, which is the only form a
/// boolean <c>is</c> accepts and the one that preserves C# pattern syntax.
/// </summary>
public sealed class TypePattern : GPattern
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TypePattern"/> class.
    /// </summary>
    /// <param name="designator">The bound variable name (<c>_</c> for none).</param>
    /// <param name="type">The matched type.</param>
    /// <param name="suffix">The optional property-pattern suffix (<c>Dog { Name: "Rex" }</c>).</param>
    /// <param name="designationAfterType">
    /// <see langword="true"/> to print the ADR-0166 spelling <c>Type designator</c>;
    /// <see langword="false"/> for the switch spelling <c>designator is Type</c>.
    /// </param>
    public TypePattern(
        string designator,
        GTypeReference type,
        PropertyPattern suffix = null,
        bool designationAfterType = false)
    {
        Designator = designator;
        Type = type;
        Suffix = suffix;
        DesignationAfterType = designationAfterType;
    }

    /// <summary>Gets the bound variable name.</summary>
    public string Designator { get; }

    /// <summary>Gets the matched type.</summary>
    public GTypeReference Type { get; }

    /// <summary>Gets the optional property-pattern suffix matched against the narrowed value.</summary>
    public PropertyPattern Suffix { get; }

    /// <summary>
    /// Gets a value indicating whether the designator prints after the type
    /// (ADR-0166 <c>Type name</c>) rather than before it (<c>name is Type</c>).
    /// </summary>
    public bool DesignationAfterType { get; }
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
    /// <param name="designator">
    /// The optional ADR-0166 designation printed after the closing brace
    /// (<c>{ Length: &gt; 0 } text</c>), binding the matched non-nil value.
    /// </param>
    public PropertyPattern(IReadOnlyList<PropertyPatternField> fields, string designator = null)
    {
        Fields = fields ?? new List<PropertyPatternField>();
        Designator = designator;
    }

    /// <summary>Gets the property field patterns.</summary>
    public IReadOnlyList<PropertyPatternField> Fields { get; }

    /// <summary>Gets the optional designation that names the matched value, or <see langword="null"/>.</summary>
    public string Designator { get; }
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
