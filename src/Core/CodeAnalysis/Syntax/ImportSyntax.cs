// <copyright file="ImportSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System.Collections.Immutable;
    using System.Linq;

    /// <summary>
    /// Represents an import declaration in the language.
    /// </summary>
    public sealed class ImportSyntax : MemberSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ImportSyntax"/> class.
        /// </summary>
        /// <param name="importKeyword">The import keyword.</param>
        /// <param name="identifiers">The identifiers.</param>
        public ImportSyntax(
            SyntaxToken importKeyword,
            ImmutableArray<SyntaxToken> identifiers)
        {
            ImportKeyword = importKeyword;
            IdentifiersWithDots = identifiers;
            Identifiers = identifiers.Where(t => t.Kind == SyntaxKind.IdentifierToken).ToImmutableArray();
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.ImportDeclaration;

        /// <summary>
        /// Gets the import keyword.
        /// </summary>
        public SyntaxToken ImportKeyword { get; }

        /// <summary>
        /// Gets the import statement identifiers, excluding dots.
        /// </summary>
        public ImmutableArray<SyntaxToken> Identifiers { get; }

        /// <summary>
        /// Gets the import statement identifiers, including dots.
        /// </summary>
        public ImmutableArray<SyntaxToken> IdentifiersWithDots { get; }
    }
}
