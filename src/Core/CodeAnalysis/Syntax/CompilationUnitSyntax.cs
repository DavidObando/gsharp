// <copyright file="CompilationUnitSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System.Collections.Immutable;

    /// <summary>
    /// Represents a compilation unit in the language.
    /// </summary>
    public class CompilationUnitSyntax : SyntaxNode
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="CompilationUnitSyntax"/> class.
        /// </summary>
        /// <param name="members">The members of this compilation unit.</param>
        /// <param name="endOfFileToken">The end of file token.</param>
        public CompilationUnitSyntax(ImmutableArray<MemberSyntax> members, SyntaxToken endOfFileToken)
        {
            Members = members;
            EndOfFileToken = endOfFileToken;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.CompilationUnit;

        /// <summary>
        /// Gets the members of this compilation unit.
        /// </summary>
        public ImmutableArray<MemberSyntax> Members { get; }

        /// <summary>
        /// Gets the end of file token of this compilation unit.
        /// </summary>
        public SyntaxToken EndOfFileToken { get; }
    }
}
