// <copyright file="SharedBlockSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a `shared { … }` block inside a struct/class body (ADR-0053).
/// Groups static member declarations (fields, properties, events, methods).
class SharedBlockSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:SharedBlockSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param sharedKeyword The contextual `shared` identifier token.
    /// @param openBraceToken The opening brace.
    /// @param fields The field declarations.
    /// @param properties The property declarations.
    /// @param events The event declarations.
    /// @param methods The method declarations.
    /// @param initBlocks The `init { … }` static-initializer blocks (ADR-0140 / issue #2131).
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        sharedKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        properties ImmutableArray[PropertyDeclarationSyntax],
        events ImmutableArray[EventDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        initBlocks ImmutableArray[StaticInitializerBlockSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        SharedKeyword = sharedKeyword
        OpenBraceToken = openBraceToken
        Fields = fields
        Properties = properties
        Events = events
        Methods = methods
        InitBlocks = initBlocks
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SharedBlock

    /// Gets the contextual `shared` identifier token.
    prop SharedKeyword SyntaxToken {
        get;
    }

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the field declarations.
    prop Fields ImmutableArray[FieldDeclarationSyntax] {
        get;
    }

    /// Gets the property declarations.
    prop Properties ImmutableArray[PropertyDeclarationSyntax] {
        get;
    }

    /// Gets the event declarations.
    prop Events ImmutableArray[EventDeclarationSyntax] {
        get;
    }

    /// Gets the method declarations.
    prop Methods ImmutableArray[FunctionDeclarationSyntax] {
        get;
    }

    /// Gets the `init { … }` static-initializer blocks (ADR-0140 / issue #2131).
    prop InitBlocks ImmutableArray[StaticInitializerBlockSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
