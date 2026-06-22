// <copyright file="GExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Base type for a G# expression.
/// </summary>
public abstract class GExpression : GNode
{
}

/// <summary>
/// A literal expression. The width of a numeric value is conveyed by the type
/// clause, not the literal text (ADR-0115 §B.12).
/// </summary>
public sealed class LiteralExpression : GExpression
{
    private LiteralExpression(LiteralKind kind, string value)
    {
        Kind = kind;
        Value = value;
    }

    /// <summary>Gets the literal kind.</summary>
    public LiteralKind Kind { get; }

    /// <summary>Gets the raw, unquoted literal value (for string/char this is the inner text).</summary>
    public string Value { get; }

    /// <summary>Creates an integer literal.</summary>
    /// <param name="value">The integer text.</param>
    /// <returns>The literal.</returns>
    public static LiteralExpression Int(string value) => new LiteralExpression(LiteralKind.Int, value);

    /// <summary>Creates a floating-point literal.</summary>
    /// <param name="value">The float text.</param>
    /// <returns>The literal.</returns>
    public static LiteralExpression Float(string value) => new LiteralExpression(LiteralKind.Float, value);

    /// <summary>Creates a string literal from its unescaped inner text.</summary>
    /// <param name="value">The unescaped inner text.</param>
    /// <returns>The literal.</returns>
    public static LiteralExpression String(string value) => new LiteralExpression(LiteralKind.String, value);

    /// <summary>Creates a character literal from its unescaped inner text.</summary>
    /// <param name="value">The unescaped inner text.</param>
    /// <returns>The literal.</returns>
    public static LiteralExpression Char(string value) => new LiteralExpression(LiteralKind.Char, value);

    /// <summary>Creates a boolean literal.</summary>
    /// <param name="value">The boolean value.</param>
    /// <returns>The literal.</returns>
    public static LiteralExpression Bool(bool value) => new LiteralExpression(LiteralKind.Bool, value ? "true" : "false");

    /// <summary>Creates the null literal (<c>nil</c>).</summary>
    /// <returns>The literal.</returns>
    public static LiteralExpression Null() => new LiteralExpression(LiteralKind.Null, "nil");
}

/// <summary>
/// A bare identifier reference.
/// </summary>
public sealed class IdentifierExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IdentifierExpression"/> class.
    /// </summary>
    /// <param name="name">The identifier name (preserved verbatim, ADR-0115 §B.12).</param>
    public IdentifierExpression(string name)
    {
        Name = name;
    }

    /// <summary>Gets the identifier name.</summary>
    public string Name { get; }
}

/// <summary>
/// The <c>this</c> expression.
/// </summary>
public sealed class ThisExpression : GExpression
{
}

/// <summary>
/// A member-access expression <c>target.Name</c>.
/// </summary>
public sealed class MemberAccessExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MemberAccessExpression"/> class.
    /// </summary>
    /// <param name="target">The receiver expression.</param>
    /// <param name="memberName">The member name.</param>
    public MemberAccessExpression(GExpression target, string memberName)
    {
        Target = target;
        MemberName = memberName;
    }

    /// <summary>Gets the receiver expression.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the member name.</summary>
    public string MemberName { get; }
}

/// <summary>
/// An invocation <c>target(args)</c> with optional bracket type arguments
/// (<c>target[T](args)</c>, ADR-0115 §B.7).
/// </summary>
public sealed class InvocationExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="InvocationExpression"/> class.
    /// </summary>
    /// <param name="target">The callee expression.</param>
    /// <param name="arguments">The argument expressions.</param>
    /// <param name="typeArguments">The explicit bracket type arguments, if any.</param>
    public InvocationExpression(
        GExpression target,
        IReadOnlyList<GExpression> arguments = null,
        IReadOnlyList<GTypeReference> typeArguments = null)
    {
        Target = target;
        Arguments = arguments ?? new List<GExpression>();
        TypeArguments = typeArguments ?? new List<GTypeReference>();
    }

    /// <summary>Gets the callee expression.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the argument expressions.</summary>
    public IReadOnlyList<GExpression> Arguments { get; }

    /// <summary>Gets the explicit bracket type arguments.</summary>
    public IReadOnlyList<GTypeReference> TypeArguments { get; }
}

/// <summary>
/// An element-access expression <c>target[index]</c>.
/// </summary>
public sealed class IndexExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IndexExpression"/> class.
    /// </summary>
    /// <param name="target">The indexed expression.</param>
    /// <param name="index">The index expression.</param>
    public IndexExpression(GExpression target, GExpression index)
    {
        Target = target;
        Index = index;
    }

    /// <summary>Gets the indexed expression.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the index expression.</summary>
    public GExpression Index { get; }
}

/// <summary>
/// A field initializer inside a composite literal (<c>Name: value</c>).
/// </summary>
public sealed class FieldInitializer : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FieldInitializer"/> class.
    /// </summary>
    /// <param name="name">The field name.</param>
    /// <param name="value">The field value.</param>
    public FieldInitializer(string name, GExpression value)
    {
        Name = name;
        Value = value;
    }

    /// <summary>Gets the field name.</summary>
    public string Name { get; }

    /// <summary>Gets the field value.</summary>
    public GExpression Value { get; }
}

/// <summary>
/// A composite (object) literal <c>Type{X: 1, Y: 2}</c>.
/// </summary>
public sealed class CompositeLiteralExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CompositeLiteralExpression"/> class.
    /// </summary>
    /// <param name="type">The type being constructed.</param>
    /// <param name="fieldInitializers">The field initializers.</param>
    public CompositeLiteralExpression(GTypeReference type, IReadOnlyList<FieldInitializer> fieldInitializers = null)
    {
        Type = type;
        FieldInitializers = fieldInitializers ?? new List<FieldInitializer>();
    }

    /// <summary>Gets the type being constructed.</summary>
    public GTypeReference Type { get; }

    /// <summary>Gets the field initializers.</summary>
    public IReadOnlyList<FieldInitializer> FieldInitializers { get; }
}

/// <summary>
/// An array/slice literal <c>[]T{a, b, c}</c>.
/// </summary>
public sealed class ArrayLiteralExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ArrayLiteralExpression"/> class.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <param name="elements">The element expressions.</param>
    public ArrayLiteralExpression(GTypeReference elementType, IReadOnlyList<GExpression> elements = null)
    {
        ElementType = elementType;
        Elements = elements ?? new List<GExpression>();
    }

    /// <summary>Gets the element type.</summary>
    public GTypeReference ElementType { get; }

    /// <summary>Gets the element expressions.</summary>
    public IReadOnlyList<GExpression> Elements { get; }
}

/// <summary>
/// A width-bearing numeric/value conversion written in the canonical G#
/// conversion-call form <c>Type(expr)</c> (spec §Types and values; e.g.
/// <c>uint8(5)</c>, <c>int32(expr)</c>). The C# explicit cast <c>(int)expr</c>
/// maps here (ADR-0115 §B.12); the CLR truncates toward zero for
/// floating→integral conversions, matching C# cast semantics.
/// </summary>
public sealed class ConversionExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ConversionExpression"/> class.
    /// </summary>
    /// <param name="targetType">The conversion target type.</param>
    /// <param name="operand">The value being converted.</param>
    public ConversionExpression(GTypeReference targetType, GExpression operand)
    {
        TargetType = targetType;
        Operand = operand;
    }

    /// <summary>Gets the conversion target type.</summary>
    public GTypeReference TargetType { get; }

    /// <summary>Gets the value being converted.</summary>
    public GExpression Operand { get; }
}

/// <summary>
/// A copy/update expression <c>expr with { Field = value, ... }</c> for data
/// structs / data classes (spec §Struct literals; ADR-0115 §B.4). Note the
/// update fields use <c>=</c> (not the <c>:</c> of a composite literal).
/// </summary>
public sealed class WithExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="WithExpression"/> class.
    /// </summary>
    /// <param name="target">The source value being copied.</param>
    /// <param name="updates">The field updates (may be empty for <c>with { }</c>).</param>
    public WithExpression(GExpression target, IReadOnlyList<FieldInitializer> updates = null)
    {
        Target = target;
        Updates = updates ?? new List<FieldInitializer>();
    }

    /// <summary>Gets the source value being copied.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the field updates.</summary>
    public IReadOnlyList<FieldInitializer> Updates { get; }
}

/// <summary>
/// A tuple literal <c>(a, b, c)</c> (spec §Primary expressions, <c>TupleLiteral</c>).
/// A tuple literal always has at least two elements.
/// </summary>
public sealed class TupleLiteralExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TupleLiteralExpression"/> class.
    /// </summary>
    /// <param name="elements">The tuple element expressions.</param>
    public TupleLiteralExpression(IReadOnlyList<GExpression> elements)
    {
        Elements = elements ?? new List<GExpression>();
    }

    /// <summary>Gets the tuple element expressions.</summary>
    public IReadOnlyList<GExpression> Elements { get; }
}

/// <summary>
/// A binary operation <c>left op right</c>.
/// </summary>
public sealed class BinaryExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BinaryExpression"/> class.
    /// </summary>
    /// <param name="left">The left operand.</param>
    /// <param name="op">The operator token (e.g. <c>+</c>, <c>==</c>).</param>
    /// <param name="right">The right operand.</param>
    public BinaryExpression(GExpression left, string op, GExpression right)
    {
        Left = left;
        Operator = op;
        Right = right;
    }

    /// <summary>Gets the left operand.</summary>
    public GExpression Left { get; }

    /// <summary>Gets the operator token.</summary>
    public string Operator { get; }

    /// <summary>Gets the right operand.</summary>
    public GExpression Right { get; }
}

/// <summary>
/// A prefix unary operation <c>op operand</c> (e.g. <c>-x</c>, <c>!flag</c>).
/// </summary>
public sealed class UnaryExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="UnaryExpression"/> class.
    /// </summary>
    /// <param name="op">The operator token.</param>
    /// <param name="operand">The operand.</param>
    public UnaryExpression(string op, GExpression operand)
    {
        Operator = op;
        Operand = operand;
    }

    /// <summary>Gets the operator token.</summary>
    public string Operator { get; }

    /// <summary>Gets the operand.</summary>
    public GExpression Operand { get; }
}

/// <summary>
/// A parenthesized expression <c>(inner)</c>.
/// </summary>
public sealed class ParenthesizedExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ParenthesizedExpression"/> class.
    /// </summary>
    /// <param name="inner">The inner expression.</param>
    public ParenthesizedExpression(GExpression inner)
    {
        Inner = inner;
    }

    /// <summary>Gets the inner expression.</summary>
    public GExpression Inner { get; }
}

/// <summary>
/// An arrow lambda <c>(x int32) -&gt; body</c> (ADR-0074). The body is either
/// a single expression or a brace-delimited block.
/// </summary>
public sealed class LambdaExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LambdaExpression"/> class.
    /// </summary>
    /// <param name="parameters">The lambda parameters.</param>
    /// <param name="expressionBody">The single-expression body, when present.</param>
    /// <param name="blockBody">The block body, when present.</param>
    /// <param name="isAsync">Whether the lambda is asynchronous.</param>
    public LambdaExpression(
        IReadOnlyList<Parameter> parameters,
        GExpression expressionBody = null,
        BlockStatement blockBody = null,
        bool isAsync = false)
    {
        Parameters = parameters ?? new List<Parameter>();
        ExpressionBody = expressionBody;
        BlockBody = blockBody;
        IsAsync = isAsync;
    }

    /// <summary>Gets the lambda parameters.</summary>
    public IReadOnlyList<Parameter> Parameters { get; }

    /// <summary>Gets the single-expression body, or <see langword="null"/> for a block body.</summary>
    public GExpression ExpressionBody { get; }

    /// <summary>Gets the block body, or <see langword="null"/> for an expression body.</summary>
    public BlockStatement BlockBody { get; }

    /// <summary>Gets a value indicating whether the lambda is asynchronous.</summary>
    public bool IsAsync { get; }
}

/// <summary>
/// An <c>await</c> expression <c>await operand</c> (ADR-0115 §B; samples
/// <c>AsyncTask.gs</c>, <c>AsyncAwaitInLoop.gs</c>). Suspends until the awaited
/// task completes and yields its result.
/// </summary>
public sealed class AwaitExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AwaitExpression"/> class.
    /// </summary>
    /// <param name="operand">The awaited operand.</param>
    public AwaitExpression(GExpression operand)
    {
        Operand = operand;
    }

    /// <summary>Gets the awaited operand.</summary>
    public GExpression Operand { get; }
}

/// <summary>
/// One arm of a <see cref="SwitchExpression"/>: a pattern (or <c>default</c>
/// when <see cref="Pattern"/> is <see langword="null"/>) and the result
/// expression it yields.
/// </summary>
public sealed class SwitchArm : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SwitchArm"/> class.
    /// </summary>
    /// <param name="pattern">The arm pattern, or <see langword="null"/> for the <c>default</c> arm.</param>
    /// <param name="body">The result expression.</param>
    public SwitchArm(GPattern pattern, GExpression body)
    {
        Pattern = pattern;
        Body = body;
    }

    /// <summary>Gets the arm pattern, or <see langword="null"/> for the <c>default</c> arm.</summary>
    public GPattern Pattern { get; }

    /// <summary>Gets the result expression.</summary>
    public GExpression Body { get; }
}

/// <summary>
/// A <c>switch</c> expression <c>switch subject { case &lt;pattern&gt;: &lt;expr&gt; … default: &lt;expr&gt; }</c>
/// (spec §Pattern matching; samples <c>SwitchExpression.gs</c>). Used in
/// expression position (assignable / returnable).
/// </summary>
public sealed class SwitchExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SwitchExpression"/> class.
    /// </summary>
    /// <param name="subject">The value being matched.</param>
    /// <param name="arms">The ordered arms.</param>
    public SwitchExpression(GExpression subject, IReadOnlyList<SwitchArm> arms)
    {
        Subject = subject;
        Arms = arms ?? new List<SwitchArm>();
    }

    /// <summary>Gets the value being matched.</summary>
    public GExpression Subject { get; }

    /// <summary>Gets the ordered arms.</summary>
    public IReadOnlyList<SwitchArm> Arms { get; }
}

/// <summary>
/// One segment of an interpolated string: either literal text or a hole.
/// </summary>
public sealed class InterpolationPart : GNode
{
    private InterpolationPart(string text, GExpression expression, string alignment, string format)
    {
        Text = text;
        Expression = expression;
        Alignment = alignment;
        Format = format;
    }

    /// <summary>Gets the literal (unescaped) text for a text segment, else <see langword="null"/>.</summary>
    public string Text { get; }

    /// <summary>Gets the hole expression for a hole segment, else <see langword="null"/>.</summary>
    public GExpression Expression { get; }

    /// <summary>Gets the optional alignment specifier for a hole.</summary>
    public string Alignment { get; }

    /// <summary>Gets the optional format specifier for a hole.</summary>
    public string Format { get; }

    /// <summary>Gets a value indicating whether this part is a hole.</summary>
    public bool IsHole => Expression != null;

    /// <summary>Creates a literal-text part from its unescaped text.</summary>
    /// <param name="text">The unescaped text.</param>
    /// <returns>The part.</returns>
    public static InterpolationPart Literal(string text) => new InterpolationPart(text, null, null, null);

    /// <summary>Creates a hole part.</summary>
    /// <param name="expression">The hole expression.</param>
    /// <param name="alignment">The optional alignment specifier.</param>
    /// <param name="format">The optional format specifier.</param>
    /// <returns>The part.</returns>
    public static InterpolationPart Hole(GExpression expression, string alignment = null, string format = null) =>
        new InterpolationPart(null, expression, alignment, format);
}

/// <summary>
/// An interpolated string (ADR-0055, ADR-0115 §B.9). Every G# string literal is
/// interpolation-capable, so there is no <c>$</c> prefix; holes use
/// <c>${expr}</c> (or <c>$ident</c> for a bare identifier) and a literal
/// <c>$</c> in surrounding text is escaped to <c>$$</c>.
/// </summary>
public sealed class InterpolatedStringExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="InterpolatedStringExpression"/> class.
    /// </summary>
    /// <param name="parts">The ordered segments.</param>
    public InterpolatedStringExpression(IReadOnlyList<InterpolationPart> parts)
    {
        Parts = parts ?? new List<InterpolationPart>();
    }

    /// <summary>Gets the ordered segments.</summary>
    public IReadOnlyList<InterpolationPart> Parts { get; }
}
