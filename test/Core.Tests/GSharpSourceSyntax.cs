// <copyright file="GSharpSourceSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.Tests;

/// <summary>
/// Issue #4656: the G# half of the source guards that walk the compiler's own
/// syntax. Before the cut-over they parse C# with Roslyn; after it the sources
/// are G#, and these helpers answer the same questions with the compiler's own
/// parser. Every helper is deliberately small and mirrors one Roslyn idiom the
/// guards already use.
/// </summary>
internal static class GSharpSourceSyntax
{
    /// <summary>
    /// Parses one G# source file. Compiler sources (anything under
    /// <c>src/Core</c>) must parse cleanly: a file the parser recovered from
    /// could hide the very references a guard is counting. Elsewhere under
    /// <c>src/</c> the tree also holds project templates and editor test
    /// fixtures that are not meant to parse on their own, so those are read
    /// with the parser's recovery.
    /// </summary>
    /// <param name="path">The <c>.gs</c> file.</param>
    /// <returns>The syntax tree.</returns>
    internal static SyntaxTree Parse(string path)
    {
        var tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(path), path));
        var errors = tree.Diagnostics.Where(diagnostic => diagnostic.IsError).ToList();
        bool compilerSource = TestSource.RelativeStem(path).StartsWith("src/Core/", StringComparison.Ordinal);
        if (compilerSource && errors.Count > 0)
        {
            throw new InvalidOperationException(
                $"{path} does not parse, so a source guard cannot trust what it finds there:\n  "
                + string.Join("\n  ", errors.Take(5)));
        }

        return tree;
    }

    /// <summary>
    /// Every reference to a name in expression position: a plain name
    /// (<c>x</c>, a method group) or a call by name (<c>F(...)</c>,
    /// <c>this.F(...)</c>). Declarations are not references. The analogue of
    /// Roslyn's <c>IdentifierNameSyntax</c> walk.
    /// </summary>
    /// <param name="root">The subtree to walk.</param>
    /// <returns>Each referencing node with the name it references.</returns>
    internal static IEnumerable<(SyntaxNode Node, string Name)> NameReferences(SyntaxNode root)
    {
        foreach (var node in root.DescendantNodesAndSelf())
        {
            switch (node)
            {
                case NameExpressionSyntax name:
                    yield return (node, name.IdentifierToken.Text);
                    break;
                case CallExpressionSyntax call when call.Callee is null && call.ConversionTypeClause is null:
                    yield return (node, call.Identifier.Text);
                    break;
            }
        }
    }

    /// <summary>Whether a node sits inside <c>nameof(...)</c>, which names a member without using it.</summary>
    /// <param name="node">The node.</param>
    /// <returns><see langword="true"/> inside <c>nameof</c>.</returns>
    internal static bool IsInNameOf(SyntaxNode node) =>
        node.Ancestors().Any(ancestor => ancestor is NameOfExpressionSyntax);

    /// <summary>
    /// The simple name an expression ends in: the called name of a call, the
    /// right part of a member access, or a plain name. Empty otherwise.
    /// </summary>
    /// <param name="expression">The expression.</param>
    /// <returns>The name, or an empty string.</returns>
    internal static string SimpleName(SyntaxNode? expression) => expression switch
    {
        CallExpressionSyntax call when call.Callee is null && call.ConversionTypeClause is null => call.Identifier.Text,
        AccessorExpressionSyntax access => SimpleName(access.RightPart),
        NameExpressionSyntax name => name.IdentifierToken.Text,
        _ => string.Empty,
    };

    /// <summary>The value of a string literal expression, or <see langword="null"/>.</summary>
    /// <param name="expression">The expression.</param>
    /// <returns>The string value.</returns>
    internal static string? StringLiteral(SyntaxNode? expression) =>
        expression is LiteralExpressionSyntax { Value: string value } ? value : null;

    /// <summary>
    /// The member that contains <paramref name="node"/>, as <c>Type.Member</c>,
    /// using the OUTERMOST member under the type, the way Roslyn's
    /// <c>MemberDeclarationSyntax</c> ancestor walk treats a lambda or local
    /// function as part of its enclosing method.
    /// </summary>
    /// <param name="node">The node.</param>
    /// <returns><c>Type.Member</c>.</returns>
    internal static string ContainingMember(SyntaxNode node)
    {
        string? member = null;
        foreach (var ancestor in node.Ancestors())
        {
            string? type = TypeName(ancestor);
            if (type is not null)
            {
                return type + "." + (member ?? "<type>");
            }

            member = MemberName(ancestor) ?? member;
        }

        return "<top-level>." + (member ?? "<none>");
    }

    /// <summary>
    /// The shape key of the nearest enclosing member, mapped exactly like the
    /// C# scan's <c>GetEnclosingMemberName</c> (DiagnosticIdUniquenessTests), so
    /// distinct sites stay distinct in both languages: a function (local ones
    /// included) by its name, a constructor by its containing type's name, an
    /// accessor body as <c>Property.get</c> / <c>Property.set</c>. Anything else
    /// keeps walking outward, and outside every member it is <c>&lt;top-level&gt;</c>.
    /// </summary>
    /// <param name="node">The node.</param>
    /// <returns>The member's shape key.</returns>
    internal static string NearestMemberName(SyntaxNode node)
    {
        foreach (var ancestor in node.Ancestors())
        {
            switch (ancestor)
            {
                case FunctionDeclarationSyntax function:
                    return function.Identifier.Text;
                case ConstructorDeclarationSyntax:
                    return ancestor.Ancestors().Select(TypeName).FirstOrDefault(name => name is not null) ?? "<top-level>";
                case PropertyAccessorSyntax accessor:
                    var property = accessor.Ancestors().OfType<PropertyDeclarationSyntax>().FirstOrDefault();
                    return (property?.Identifier.Text ?? string.Empty) + "." + accessor.AccessorKeyword.Text;
            }
        }

        return "<top-level>";
    }

    private static string? MemberName(SyntaxNode node) => node switch
    {
        FunctionDeclarationSyntax function => function.Identifier.Text,
        ConstructorDeclarationSyntax => ".ctor",
        PropertyDeclarationSyntax property => property.Identifier.Text,
        FieldDeclarationSyntax field => field.Identifier.Text,
        EventDeclarationSyntax eventDeclaration => eventDeclaration.Identifier.Text,
        _ => null,
    };

    // G#'s syntax has no ClassDeclarationSyntax: the parser represents both
    // `class` and `struct` declarations as StructDeclarationSyntax (see its
    // `structKeyword` parameter), so this covers every class in the tree.
    private static string? TypeName(SyntaxNode node) => node switch
    {
        StructDeclarationSyntax type => type.Identifier.Text,
        InterfaceDeclarationSyntax type => type.Identifier.Text,
        EnumDeclarationSyntax type => type.Identifier.Text,
        _ => null,
    };
}
