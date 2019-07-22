// <copyright file="PackageSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a package declaration in the language.
    /// </summary>
    public sealed class PackageSyntax : MemberSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="PackageSyntax"/> class.
        /// </summary>
        /// <param name="packageKeyword">The package keyword.</param>
        /// <param name="identifier">The package name.</param>
        public PackageSyntax(
            SyntaxToken packageKeyword,
            SyntaxToken identifier)
        {
            PackageKeyword = packageKeyword;
            Identifier = identifier;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.PackageDeclaration;

        /// <summary>
        /// Gets the package keyword.
        /// </summary>
        public SyntaxToken PackageKeyword { get; }

        /// <summary>
        /// Gets the function identifier.
        /// </summary>
        public SyntaxToken Identifier { get; }
    }
}
