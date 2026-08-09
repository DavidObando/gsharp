// <copyright file="SharedBlockSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>shared { … }</c> block inside a struct/class body (ADR-0053).
/// Groups static member declarations (fields, properties, events, methods).
/// </summary>
public sealed class SharedBlockSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SharedBlockSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="sharedKeyword">The contextual <c>shared</c> identifier token.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="fields">The field declarations.</param>
    /// <param name="properties">The property declarations.</param>
    /// <param name="events">The event declarations.</param>
    /// <param name="methods">The method declarations.</param>
    /// <param name="initBlocks">The <c>init { … }</c> static-initializer blocks (ADR-0140 / issue #2131).</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public SharedBlockSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken sharedKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        ImmutableArray<PropertyDeclarationSyntax> properties,
        ImmutableArray<EventDeclarationSyntax> events,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        ImmutableArray<StaticInitializerBlockSyntax> initBlocks,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        SharedKeyword = sharedKeyword;
        OpenBraceToken = openBraceToken;
        Fields = fields;
        Properties = properties;
        Events = events;
        Methods = methods;
        InitBlocks = initBlocks;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SharedBlock;

    /// <summary>Gets the contextual <c>shared</c> identifier token.</summary>
    public SyntaxToken SharedKeyword { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the field declarations.</summary>
    public ImmutableArray<FieldDeclarationSyntax> Fields { get; }

    /// <summary>Gets the property declarations.</summary>
    public ImmutableArray<PropertyDeclarationSyntax> Properties { get; }

    /// <summary>Gets the event declarations.</summary>
    public ImmutableArray<EventDeclarationSyntax> Events { get; }

    /// <summary>Gets the method declarations.</summary>
    public ImmutableArray<FunctionDeclarationSyntax> Methods { get; }

    /// <summary>Gets the <c>init { … }</c> static-initializer blocks (ADR-0140 / issue #2131).</summary>
    public ImmutableArray<StaticInitializerBlockSyntax> InitBlocks { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
