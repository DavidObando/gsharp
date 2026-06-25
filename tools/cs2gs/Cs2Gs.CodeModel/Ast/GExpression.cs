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
/// A single element of a <see cref="CollectionInitializerExpression"/>:
/// a bare element, a <c>key: value</c> pair, or an <c>[key] = value</c>
/// indexer entry (ADR-0117).
/// </summary>
public sealed class CollectionInitializerElement : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CollectionInitializerElement"/>
    /// class representing a bare element <c>e</c>.
    /// </summary>
    /// <param name="value">The element expression.</param>
    public CollectionInitializerElement(GExpression value)
    {
        Kind = CollectionInitializerElementKind.Expression;
        Value = value;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="CollectionInitializerElement"/>
    /// class representing a <c>key: value</c> pair or an <c>[key] = value</c>
    /// indexer entry.
    /// </summary>
    /// <param name="key">The key expression.</param>
    /// <param name="value">The value expression.</param>
    /// <param name="indexed">
    /// <see langword="true"/> for an <c>[key] = value</c> indexer entry;
    /// <see langword="false"/> for a <c>key: value</c> pair.
    /// </param>
    public CollectionInitializerElement(GExpression key, GExpression value, bool indexed)
    {
        Kind = indexed
            ? CollectionInitializerElementKind.Indexed
            : CollectionInitializerElementKind.Keyed;
        Key = key;
        Value = value;
    }

    /// <summary>Gets the element kind.</summary>
    public CollectionInitializerElementKind Kind { get; }

    /// <summary>Gets the key expression, or <see langword="null"/> for a bare element.</summary>
    public GExpression Key { get; }

    /// <summary>Gets the value expression.</summary>
    public GExpression Value { get; }
}

/// <summary>
/// A collection initializer <c>Target{ elements }</c> — e.g.
/// <c>List[int32]{1, 2, 3}</c> or <c>Dictionary[string, int32]{ "a": 1 }</c>
/// (ADR-0117). <see cref="Target"/> is the construction call.
/// </summary>
public sealed class CollectionInitializerExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CollectionInitializerExpression"/> class.
    /// </summary>
    /// <param name="target">The construction-call target.</param>
    /// <param name="elements">The collection elements.</param>
    public CollectionInitializerExpression(GExpression target, IReadOnlyList<CollectionInitializerElement> elements = null)
    {
        Target = target;
        Elements = elements ?? new List<CollectionInitializerElement>();
    }

    /// <summary>Gets the construction-call target.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the collection elements.</summary>
    public IReadOnlyList<CollectionInitializerElement> Elements { get; }
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
/// A postfix non-null assertion <c>operand!!</c> — the G# analogue of the C#
/// null-forgiving operator <c>operand!</c> (spec: "Postfix <c>!!</c> asserts
/// non-null").
/// </summary>
public sealed class NonNullAssertionExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="NonNullAssertionExpression"/> class.
    /// </summary>
    /// <param name="operand">The asserted operand.</param>
    public NonNullAssertionExpression(GExpression operand)
    {
        Operand = operand;
    }

    /// <summary>Gets the asserted operand.</summary>
    public GExpression Operand { get; }
}

/// <summary>
/// A value-producing increment/decrement expression — postfix <c>x++</c> /
/// <c>x--</c> or prefix <c>++x</c> / <c>--x</c> (gsc issue #1027). G# now models
/// inc/dec as expressions, so they may appear in value positions (e.g. inside a
/// short-circuit condition) where no statement seam can hoist them.
/// </summary>
public sealed class IncrementDecrementExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IncrementDecrementExpression"/> class.
    /// </summary>
    /// <param name="operand">The operand being mutated.</param>
    /// <param name="op">The operator token (<c>++</c> or <c>--</c>).</param>
    /// <param name="isPrefix">Whether the operator precedes the operand.</param>
    public IncrementDecrementExpression(GExpression operand, string op, bool isPrefix)
    {
        Operand = operand;
        Operator = op;
        IsPrefix = isPrefix;
    }

    /// <summary>Gets the operand being mutated.</summary>
    public GExpression Operand { get; }

    /// <summary>Gets the operator token.</summary>
    public string Operator { get; }

    /// <summary>Gets a value indicating whether the operator precedes the operand.</summary>
    public bool IsPrefix { get; }
}

/// <summary>
/// A <c>stackalloc [count]ElemType</c> expression (gsc issues #1024, #1057,
/// #1041) in G#-style array grammar (the bracketed count first, then the
/// element type). In a safe context this yields a <c>Span&lt;T&gt;</c>;
/// targeting a raw pointer inside an <c>unsafe</c> context yields <c>T*</c>.
/// An optional brace-delimited initializer supplies the element values.
/// </summary>
public sealed class StackAllocExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StackAllocExpression"/> class.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <param name="count">The element-count expression.</param>
    /// <param name="elements">The optional initializer element values.</param>
    public StackAllocExpression(GTypeReference elementType, GExpression count, IReadOnlyList<GExpression> elements = null)
    {
        ElementType = elementType;
        Count = count;
        Elements = elements;
    }

    /// <summary>Gets the element type.</summary>
    public GTypeReference ElementType { get; }

    /// <summary>Gets the element-count expression.</summary>
    public GExpression Count { get; }

    /// <summary>Gets the optional initializer element values, or <see langword="null"/> when there is no initializer.</summary>
    public IReadOnlyList<GExpression> Elements { get; }
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
/// A lambda (ADR-0074). An expression body renders as the arrow form
/// <c>(x int32) -&gt; expr</c> (an expression-block); a block body renders as the
/// function-literal form <c>func (x int32) RetType { … }</c> (a statement-block),
/// which handles control flow and supplies an explicit <see cref="ReturnType"/> for
/// value-returning literals.
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
    /// <param name="returnType">
    /// The explicit return type for a function-literal block body
    /// (<see cref="IsFunctionLiteral"/> is <see langword="true"/>), or
    /// <see langword="null"/> when the block returns no value (void), the body is an
    /// expression, or the lambda renders as the arrow form. The function-literal form
    /// <c>func (params) RetType { … }</c> needs the explicit return type so a
    /// value-returning literal is not inferred as <c>void</c>; an arrow lambda
    /// (ADR-0128) infers its return type, so none is required.
    /// </param>
    /// <param name="isFunctionLiteral">
    /// When <see langword="true"/>, a block body renders as the G# function-literal
    /// form <c>func (params) RetType { … }</c> (used for C# local functions, which are
    /// not arrow lambdas). When <see langword="false"/> (the default), a block body
    /// renders as the idiomatic arrow form <c>(params) -&gt; { … }</c> (ADR-0128 /
    /// issue #1172), whose statement-block body reaches parity with func literals.
    /// </param>
    public LambdaExpression(
        IReadOnlyList<Parameter> parameters,
        GExpression expressionBody = null,
        BlockStatement blockBody = null,
        bool isAsync = false,
        GTypeReference returnType = null,
        bool isFunctionLiteral = false)
    {
        Parameters = parameters ?? new List<Parameter>();
        ExpressionBody = expressionBody;
        BlockBody = blockBody;
        IsAsync = isAsync;
        ReturnType = returnType;
        IsFunctionLiteral = isFunctionLiteral;
    }

    /// <summary>Gets the lambda parameters.</summary>
    public IReadOnlyList<Parameter> Parameters { get; }

    /// <summary>Gets the single-expression body, or <see langword="null"/> for a block body.</summary>
    public GExpression ExpressionBody { get; }

    /// <summary>Gets the block body, or <see langword="null"/> for an expression body.</summary>
    public BlockStatement BlockBody { get; }

    /// <summary>Gets a value indicating whether the lambda is asynchronous.</summary>
    public bool IsAsync { get; }

    /// <summary>
    /// Gets the explicit return type for a function-literal block body, or
    /// <see langword="null"/> when the block is void, the body is an expression, or
    /// the lambda renders as the arrow form (whose return type is inferred).
    /// </summary>
    public GTypeReference ReturnType { get; }

    /// <summary>
    /// Gets a value indicating whether a block body renders as the G#
    /// function-literal form <c>func (params) RetType { … }</c> (true, for C# local
    /// functions) rather than the idiomatic arrow form <c>(params) -&gt; { … }</c>
    /// (false, the default — ADR-0128 / issue #1172).
    /// </summary>
    public bool IsFunctionLiteral { get; }
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
    /// <param name="guard">The optional <c>when</c> guard expression, or <see langword="null"/>.</param>
    public SwitchArm(GPattern pattern, GExpression body, GExpression guard = null)
    {
        Pattern = pattern;
        Body = body;
        Guard = guard;
    }

    /// <summary>Gets the arm pattern, or <see langword="null"/> for the <c>default</c> arm.</summary>
    public GPattern Pattern { get; }

    /// <summary>Gets the result expression.</summary>
    public GExpression Body { get; }

    /// <summary>Gets the optional <c>when</c> guard expression, or <see langword="null"/> when the arm has no guard.</summary>
    public GExpression Guard { get; }
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

/// <summary>
/// An <c>if</c> expression used in value position
/// (<c>if cond { thenExpr } else { elseExpr }</c>; ADR-0064, issue #711,
/// sample <c>IfExpression.gs</c>). The canonical G# form for a C# conditional
/// (ternary) expression <c>cond ? a : b</c> (ADR-0115 §B).
/// </summary>
public sealed class IfExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IfExpression"/> class.
    /// </summary>
    /// <param name="condition">The condition expression.</param>
    /// <param name="thenExpression">The value of the then-branch.</param>
    /// <param name="elseExpression">The value of the else-branch.</param>
    public IfExpression(GExpression condition, GExpression thenExpression, GExpression elseExpression)
    {
        Condition = condition;
        ThenExpression = thenExpression;
        ElseExpression = elseExpression;
    }

    /// <summary>Gets the condition expression.</summary>
    public GExpression Condition { get; }

    /// <summary>Gets the then-branch value expression.</summary>
    public GExpression ThenExpression { get; }

    /// <summary>Gets the else-branch value expression.</summary>
    public GExpression ElseExpression { get; }
}

/// <summary>
/// An <c>out</c>-argument declaration passed to a method's <c>out</c> parameter
/// (ADR-0115 §B; sample <c>TryParseOutVar.gs</c>). Renders the inline
/// declaration forms <c>out var x</c>, <c>out let x</c>, or the discard
/// <c>out _</c>. A C# <c>out</c> argument naming a pre-declared variable maps
/// instead to the address-of form <c>&amp;x</c> (a <see cref="UnaryExpression"/>).
/// </summary>
public sealed class OutArgumentExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="OutArgumentExpression"/> class.
    /// </summary>
    /// <param name="keyword">The leading keyword (<c>out var</c>, <c>out let</c>, or <c>out</c>).</param>
    /// <param name="name">The declared local name, or <c>_</c> for a discard.</param>
    public OutArgumentExpression(string keyword, string name)
    {
        Keyword = keyword;
        Name = name;
    }

    /// <summary>Gets the leading keyword.</summary>
    public string Keyword { get; }

    /// <summary>Gets the declared local name (or <c>_</c>).</summary>
    public string Name { get; }
}

/// <summary>
/// A <c>typeof(T)</c> expression (spec §Primary expressions; ADR-0115 §B). The
/// C# <c>typeof(T)</c> maps directly to the identically-spelled G# form, whose
/// argument is a type clause rather than an expression.
/// </summary>
public sealed class TypeOfExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TypeOfExpression"/> class.
    /// </summary>
    /// <param name="type">The type whose runtime <c>System.Type</c> is taken.</param>
    public TypeOfExpression(GTypeReference type)
    {
        Type = type;
    }

    /// <summary>Gets the type whose runtime token is taken.</summary>
    public GTypeReference Type { get; }
}

/// <summary>
/// A <c>default(T)</c> / bare <c>default</c> expression (ADR-0100; spec
/// §Primary expressions). The C# <c>default(T)</c> maps to <c>default(T)</c>;
/// the C# target-typed <c>default</c> literal maps to the bare <c>default</c>
/// form, whose type is supplied by the surrounding context.
/// </summary>
public sealed class DefaultValueExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DefaultValueExpression"/> class.
    /// </summary>
    /// <param name="type">The explicit type, or <c>null</c> for the bare form.</param>
    public DefaultValueExpression(GTypeReference type = null)
    {
        Type = type;
    }

    /// <summary>Gets the explicit target type, or <c>null</c> for bare <c>default</c>.</summary>
    public GTypeReference Type { get; }
}

/// <summary>
/// A type used in expression position — the right operand of an <c>as</c> or
/// <c>is</c> type test (e.g. <c>o as []object</c>, <c>o is string</c>). Renders
/// the canonical G# type clause (slices as <c>[]T</c>, generics as <c>T[U]</c>).
/// </summary>
public sealed class TypeExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TypeExpression"/> class.
    /// </summary>
    /// <param name="type">The referenced type.</param>
    public TypeExpression(GTypeReference type)
    {
        Type = type;
    }

    /// <summary>Gets the referenced type.</summary>
    public GTypeReference Type { get; }
}

/// <summary>
/// The empty receiver placeholder at the head of a null-conditional
/// continuation (<c>?.b</c>, <c>?[i]</c>, <c>?.M()</c>). It renders as the empty
/// string so the enclosing member-access / index / invocation emits the bare
/// <c>.b</c> / <c>[i]</c> / <c>.M()</c> tail that follows the <c>?</c>.
/// </summary>
public sealed class ConditionalReceiverExpression : GExpression
{
}

/// <summary>
/// A null-conditional access <c>target?{whenNotNull}</c> — the C#
/// <c>a?.b</c>, <c>a?.b()</c>, <c>a?[i]</c> forms, which map directly to the
/// identically-spelled G# null-conditional member / index / call (spec
/// §Member access and indexing). The <see cref="WhenNotNull"/> continuation is
/// rooted at a <see cref="ConditionalReceiverExpression"/> so it renders as the
/// bare <c>.b</c> / <c>[i]</c> / <c>.b()</c> tail.
/// </summary>
public sealed class ConditionalAccessExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ConditionalAccessExpression"/> class.
    /// </summary>
    /// <param name="target">The receiver tested for null.</param>
    /// <param name="whenNotNull">The continuation evaluated when the receiver is non-null.</param>
    public ConditionalAccessExpression(GExpression target, GExpression whenNotNull)
    {
        Target = target;
        WhenNotNull = whenNotNull;
    }

    /// <summary>Gets the receiver tested for null.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the non-null continuation.</summary>
    public GExpression WhenNotNull { get; }
}

/// <summary>
/// A C# <c>throw</c> expression used in value position (<c>a ?? throw e</c>,
/// <c>cond ? a : throw e</c>, a <c>switch</c> arm value). G# supports
/// throw-as-expression natively (issue #1153), so it renders as a bare
/// <c>throw e</c> in coalesce-RHS, switch-arm, and ternary positions. In the one
/// position gsc rejects a bare throw — the sole trailing value of an
/// if-expression block branch (GS0277) — it is emitted as a throw STATEMENT
/// followed by a value-producing typed tail: <c>throw e\n default(T)</c>.
/// </summary>
public sealed class ThrowExpression : GExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ThrowExpression"/> class.
    /// </summary>
    /// <param name="operand">The thrown exception value.</param>
    /// <param name="resultType">
    /// The type the surrounding if-expression block branch expects, used for the
    /// value-producing <c>default(T)</c> tail. May be <see langword="null"/> when
    /// no type is resolvable, in which case a bare <c>default</c> is emitted.
    /// </param>
    public ThrowExpression(GExpression operand, GTypeReference resultType)
    {
        Operand = operand;
        ResultType = resultType;
    }

    /// <summary>Gets the thrown exception value.</summary>
    public GExpression Operand { get; }

    /// <summary>Gets the result type used for the if-expression block branch tail.</summary>
    public GTypeReference ResultType { get; }
}
