// <copyright file="GMember.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Base type for a member that may appear in a type body or, where the grammar
/// allows, at the top level (functions and variables).
/// </summary>
public abstract class GMember : GNode
{
}

/// <summary>
/// A field or top-level variable declaration. Fields require a binding keyword
/// and a type (ADR-0067, ADR-0115 §B.3/§B.11); top-level variables may infer
/// the type from an initializer.
/// </summary>
public sealed class FieldDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FieldDeclaration"/> class.
    /// </summary>
    /// <param name="binding">The binding keyword.</param>
    /// <param name="name">The field name.</param>
    /// <param name="type">The field type (optional only for inferred top-level variables).</param>
    /// <param name="initializer">The optional initializer expression.</param>
    /// <param name="visibility">The accessibility.</param>
    /// <param name="attributes">The field attributes.</param>
    public FieldDeclaration(
        BindingKind binding,
        string name,
        GTypeReference type = null,
        GExpression initializer = null,
        Visibility visibility = Visibility.Default,
        IReadOnlyList<AttributeUse> attributes = null)
    {
        Binding = binding;
        Name = name;
        Type = type;
        Initializer = initializer;
        Visibility = visibility;
        Attributes = attributes ?? new List<AttributeUse>();
    }

    /// <summary>Gets the binding keyword.</summary>
    public BindingKind Binding { get; }

    /// <summary>Gets the field name.</summary>
    public string Name { get; }

    /// <summary>Gets the field type.</summary>
    public GTypeReference Type { get; }

    /// <summary>Gets the optional initializer expression.</summary>
    public GExpression Initializer { get; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; }

    /// <summary>Gets the field attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }
}

/// <summary>
/// A property accessor (ADR-0051, ADR-0115 §B.11). A bodyless accessor renders
/// as a signature-only contract; a bodied accessor renders its block.
/// </summary>
public sealed class PropertyAccessor : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PropertyAccessor"/> class.
    /// </summary>
    /// <param name="kind">The accessor kind.</param>
    /// <param name="body">The optional accessor body.</param>
    /// <param name="setterParameterName">The setter value parameter name (e.g. <c>v</c>).</param>
    /// <param name="expressionBody">The optional single-statement arrow body (issue #1278 / ADR-0131); when set the accessor renders as <c>get -&gt; expr</c> / <c>set -&gt; expr</c>.</param>
    public PropertyAccessor(AccessorKind kind, BlockStatement body = null, string setterParameterName = null, GStatement expressionBody = null)
    {
        Kind = kind;
        Body = body;
        SetterParameterName = setterParameterName;
        ExpressionBody = expressionBody;
    }

    /// <summary>Gets the accessor kind.</summary>
    public AccessorKind Kind { get; }

    /// <summary>Gets the optional accessor body.</summary>
    public BlockStatement Body { get; }

    /// <summary>Gets the setter value parameter name.</summary>
    public string SetterParameterName { get; }

    /// <summary>
    /// Gets the optional single-statement arrow body (issue #1278 / ADR-0131).
    /// When non-null the accessor renders as an expression-bodied accessor
    /// <c>get -&gt; expr</c> / <c>set -&gt; expr</c> rather than a block body.
    /// </summary>
    public GStatement ExpressionBody { get; }
}

/// <summary>
/// A property (ADR-0051, ADR-0115 §B.11). With no accessors it is an
/// auto-property <c>prop Name T</c>; otherwise the accessor bodies are rendered.
/// </summary>
public sealed class PropertyDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PropertyDeclaration"/> class.
    /// </summary>
    /// <param name="name">The property name.</param>
    /// <param name="type">The property type.</param>
    /// <param name="accessors">The accessors; empty for an auto-property.</param>
    /// <param name="visibility">The accessibility.</param>
    /// <param name="isOpen">Whether the property is <c>open</c> (virtual).</param>
    /// <param name="isOverride">Whether the property is an <c>override</c>.</param>
    /// <param name="attributes">The property attributes.</param>
    /// <param name="indexerParameters">The index parameters for an indexer member (ADR-0118); empty for an ordinary property.</param>
    /// <param name="expressionBody">The optional single-statement arrow body for an expression-bodied read-only property/indexer (issue #1278 / ADR-0131); when set the member renders as <c>prop Name T -&gt; expr</c>.</param>
    public PropertyDeclaration(
        string name,
        GTypeReference type,
        IReadOnlyList<PropertyAccessor> accessors = null,
        Visibility visibility = Visibility.Default,
        bool isOpen = false,
        bool isOverride = false,
        IReadOnlyList<AttributeUse> attributes = null,
        IReadOnlyList<Parameter> indexerParameters = null,
        GStatement expressionBody = null)
    {
        Name = name;
        Type = type;
        Accessors = accessors ?? new List<PropertyAccessor>();
        Visibility = visibility;
        IsOpen = isOpen;
        IsOverride = isOverride;
        Attributes = attributes ?? new List<AttributeUse>();
        IndexerParameters = indexerParameters ?? new List<Parameter>();
        ExpressionBody = expressionBody;
    }

    /// <summary>Gets the property name.</summary>
    public string Name { get; }

    /// <summary>Gets the property type.</summary>
    public GTypeReference Type { get; }

    /// <summary>Gets the accessors; empty for an auto-property.</summary>
    public IReadOnlyList<PropertyAccessor> Accessors { get; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; }

    /// <summary>Gets a value indicating whether the property is <c>open</c>.</summary>
    public bool IsOpen { get; }

    /// <summary>Gets a value indicating whether the property is an <c>override</c>.</summary>
    public bool IsOverride { get; }

    /// <summary>Gets the property attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }

    /// <summary>Gets the index parameters for an indexer member (ADR-0118); empty for an ordinary property.</summary>
    public IReadOnlyList<Parameter> IndexerParameters { get; }

    /// <summary>Gets a value indicating whether this property is an indexer member (<c>prop this[...]</c>).</summary>
    public bool IsIndexer => IndexerParameters.Count > 0;

    /// <summary>
    /// Gets the optional single-statement arrow body (issue #1278 / ADR-0131).
    /// When non-null the property/indexer renders as an expression-bodied
    /// read-only member <c>prop Name T -&gt; expr</c> rather than an accessor list.
    /// </summary>
    public GStatement ExpressionBody { get; }
}

/// <summary>
/// A function or method (ADR-0024/ADR-0079, ADR-0115 §B.5). When
/// <see cref="Receiver"/> is set the declaration renders as a receiver-clause
/// extension function on a non-owned type; otherwise it is an in-body method on
/// an owned type (or a top-level function). A <see langword="null"/>
/// <see cref="Body"/> renders the bodyless <c>;</c> form (interface/abstract).
/// </summary>
public sealed class MethodDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MethodDeclaration"/> class.
    /// </summary>
    /// <param name="name">The method name.</param>
    /// <param name="parameters">The parameters.</param>
    /// <param name="returnType">The return type, or <see langword="null"/> for void.</param>
    /// <param name="body">The body, or <see langword="null"/> for the bodyless form.</param>
    /// <param name="typeParameters">The generic type parameters.</param>
    /// <param name="receiver">The receiver clause for an extension function.</param>
    /// <param name="visibility">The accessibility.</param>
    /// <param name="isOpen">Whether the method is <c>open</c> (virtual).</param>
    /// <param name="isOverride">Whether the method is an <c>override</c>.</param>
    /// <param name="isAsync">Whether the method is asynchronous.</param>
    /// <param name="attributes">The method attributes.</param>
    /// <param name="expressionBody">The optional single-statement arrow body for an expression-bodied method/function (issue #1278 / ADR-0131); when set the member renders as <c>func F(...) T -&gt; expr</c>.</param>
    public MethodDeclaration(
        string name,
        IReadOnlyList<Parameter> parameters = null,
        GTypeReference returnType = null,
        BlockStatement body = null,
        IReadOnlyList<TypeParameter> typeParameters = null,
        Receiver receiver = null,
        Visibility visibility = Visibility.Default,
        bool isOpen = false,
        bool isOverride = false,
        bool isAsync = false,
        IReadOnlyList<AttributeUse> attributes = null,
        GStatement expressionBody = null)
    {
        Name = name;
        Parameters = parameters ?? new List<Parameter>();
        ReturnType = returnType;
        Body = body;
        TypeParameters = typeParameters ?? new List<TypeParameter>();
        Receiver = receiver;
        Visibility = visibility;
        IsOpen = isOpen;
        IsOverride = isOverride;
        IsAsync = isAsync;
        Attributes = attributes ?? new List<AttributeUse>();
        ExpressionBody = expressionBody;
    }

    /// <summary>Gets the method name.</summary>
    public string Name { get; }

    /// <summary>Gets the parameters.</summary>
    public IReadOnlyList<Parameter> Parameters { get; }

    /// <summary>Gets the return type, or <see langword="null"/> for void.</summary>
    public GTypeReference ReturnType { get; }

    /// <summary>Gets the body, or <see langword="null"/> for the bodyless form.</summary>
    public BlockStatement Body { get; }

    /// <summary>Gets the generic type parameters.</summary>
    public IReadOnlyList<TypeParameter> TypeParameters { get; }

    /// <summary>Gets the receiver clause, or <see langword="null"/> for an in-body method.</summary>
    public Receiver Receiver { get; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; }

    /// <summary>Gets a value indicating whether the method is <c>open</c>.</summary>
    public bool IsOpen { get; }

    /// <summary>Gets a value indicating whether the method is an <c>override</c>.</summary>
    public bool IsOverride { get; }

    /// <summary>Gets a value indicating whether the method is asynchronous.</summary>
    public bool IsAsync { get; }

    /// <summary>Gets the method attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }

    /// <summary>
    /// Gets the optional single-statement arrow body (issue #1278 / ADR-0131).
    /// When non-null the method/function renders as an expression-bodied member
    /// <c>func F(...) T -&gt; expr</c> rather than a block body.
    /// </summary>
    public GStatement ExpressionBody { get; }
}

/// <summary>
/// An explicit constructor <c>init(params) [: base(args)] { … }</c>
/// (ADR-0065, ADR-0115 §B.11).
/// </summary>
public sealed class ConstructorDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ConstructorDeclaration"/> class.
    /// </summary>
    /// <param name="parameters">The constructor parameters.</param>
    /// <param name="body">The constructor body.</param>
    /// <param name="baseArguments">The base-constructor arguments, or <see langword="null"/> for no chaining.</param>
    /// <param name="visibility">The accessibility.</param>
    /// <param name="attributes">The constructor attributes.</param>
    /// <param name="isConvenience">Whether this is a delegating <c>convenience init</c>.</param>
    public ConstructorDeclaration(
        IReadOnlyList<Parameter> parameters,
        BlockStatement body,
        IReadOnlyList<GExpression> baseArguments = null,
        Visibility visibility = Visibility.Default,
        IReadOnlyList<AttributeUse> attributes = null,
        bool isConvenience = false)
    {
        Parameters = parameters ?? new List<Parameter>();
        Body = body;
        BaseArguments = baseArguments;
        Visibility = visibility;
        Attributes = attributes ?? new List<AttributeUse>();
        IsConvenience = isConvenience;
    }

    /// <summary>
    /// Gets a value indicating whether this is a <c>convenience init</c> that
    /// delegates to another initializer of the same class (ADR-0065). The
    /// delegation call (<c>init(args)</c>) is the first statement of the body.
    /// </summary>
    public bool IsConvenience { get; }

    /// <summary>Gets the constructor parameters.</summary>
    public IReadOnlyList<Parameter> Parameters { get; }

    /// <summary>Gets the constructor body.</summary>
    public BlockStatement Body { get; }

    /// <summary>Gets the base-constructor arguments, or <see langword="null"/> for no chaining.</summary>
    public IReadOnlyList<GExpression> BaseArguments { get; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; }

    /// <summary>Gets the constructor attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }
}

/// <summary>
/// A <c>shared { … }</c> block grouping static members on a class, struct, or
/// interface (ADR-0053/ADR-0089, ADR-0115 §B.11).
/// </summary>
public sealed class SharedBlock : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SharedBlock"/> class.
    /// </summary>
    /// <param name="members">The static members.</param>
    public SharedBlock(IReadOnlyList<GMember> members)
    {
        Members = members ?? new List<GMember>();
    }

    /// <summary>Gets the static members.</summary>
    public IReadOnlyList<GMember> Members { get; }
}

/// <summary>
/// A class finalizer / destructor mapped to the canonical G# <c>deinit { … }</c>
/// form (ADR-0068; class-only, no parameters or return type). Maps the C#
/// <c>~Type() { … }</c> destructor.
/// </summary>
public sealed class DestructorDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DestructorDeclaration"/> class.
    /// </summary>
    /// <param name="body">The finalizer body.</param>
    /// <param name="attributes">The finalizer attributes.</param>
    public DestructorDeclaration(BlockStatement body, IReadOnlyList<AttributeUse> attributes = null)
    {
        Body = body;
        Attributes = attributes ?? new List<AttributeUse>();
    }

    /// <summary>Gets the finalizer body.</summary>
    public BlockStatement Body { get; }

    /// <summary>Gets the finalizer attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }
}

/// <summary>
/// A field-like event declaration <c>event Name Type</c> (spec §Members,
/// <c>EventDecl</c>; ADR-0115 §B). The C# form
/// <c>public event EventHandler&lt;T&gt;? X;</c> maps to the canonical G#
/// name-then-type ordering with no accessor body; the nullable annotation on the
/// delegate type is dropped because a field-like event is nil-initialized.
/// </summary>
public sealed class EventDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EventDeclaration"/> class.
    /// </summary>
    /// <param name="name">The event name.</param>
    /// <param name="type">The handler/delegate type.</param>
    /// <param name="visibility">The accessibility.</param>
    /// <param name="attributes">The event attributes.</param>
    public EventDeclaration(
        string name,
        GTypeReference type,
        Visibility visibility = Visibility.Default,
        IReadOnlyList<AttributeUse> attributes = null)
    {
        Name = name;
        Type = type;
        Visibility = visibility;
        Attributes = attributes ?? new List<AttributeUse>();
    }

    /// <summary>Gets the event name.</summary>
    public string Name { get; }

    /// <summary>Gets the handler/delegate type.</summary>
    public GTypeReference Type { get; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; }

    /// <summary>Gets the event attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }
}
