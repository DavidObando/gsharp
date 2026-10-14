// <copyright file="GSharpSourceSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Issue #4656: the G# half of the source guards that walk the compiler's own
/// syntax. Before the cut-over they parse C# with Roslyn; after it the sources
/// are G#, and these helpers answer the same questions with the compiler's own
/// parser. Every helper is deliberately small and mirrors one Roslyn idiom the
/// guards already use.
internal shared class GSharpSourceSyntax {
    /// Parses one G# source file. Compiler sources (anything under
    /// `src/Core`) must parse cleanly: a file the parser recovered from
    /// could hide the very references a guard is counting. Elsewhere under
    /// `src/` the tree also holds project templates and editor test
    /// fixtures that are not meant to parse on their own, so those are read
    /// with the parser's recovery.
    /// @param path The `.gs` file.
    /// @returns The syntax tree.
    internal func Parse(path string) SyntaxTree {
        let tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(path), path))
        let errors = tree.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError).ToList()
        let compilerSource = TestSource.RelativeStem(path).StartsWith("src/Core/", StringComparison.Ordinal)
        if compilerSource && errors.Count > 0 {
            throw InvalidOperationException(("$path" + ` does not parse, so a source guard cannot trust what it finds there:
  `) + string.Join("\n  ", errors.Take(5)))
        }
        return tree
    }

    /// Every reference to a name in expression position: a plain name
    /// (`x`, a method group) or a call by name (`F(...)`,
    /// `this.F(...)`). Declarations are not references. The analogue of
    /// Roslyn's `IdentifierNameSyntax` walk.
    /// @param root The subtree to walk.
    /// @returns Each referencing node with the name it references.
    internal func NameReferences(root SyntaxNode) sequence[(Node SyntaxNode, Name string)] {
        for node in root.DescendantNodesAndSelf() {
            switch node {
                case name is NameExpressionSyntax {
                    yield(node, name.IdentifierToken.Text)
                }
                case call is CallExpressionSyntax when call.Callee == nil && call.ConversionTypeClause == nil {
                    yield(node, call.Identifier.Text)
                }
            }
        }
    }

    /// Whether a node sits inside `nameof(...)`, which names a member without using it.
    /// @param node The node.
    /// @returns `true` inside `nameof`.
    internal func IsInNameOf(node SyntaxNode) bool -> node.Ancestors().Any(
        (ancestor SyntaxNode) -> ancestor is NameOfExpressionSyntax
    )

    /// The simple name an expression ends in: the called name of a call, the
    /// right part of a member access, or a plain name. Empty otherwise.
    /// @param expression The expression.
    /// @returns The name, or an empty string.
    internal func SimpleName(expression SyntaxNode?) string -> switch expression {
        case call is CallExpressionSyntax when call.Callee == nil &&
            call.ConversionTypeClause == nil: call
            .Identifier
            .Text
        case access is AccessorExpressionSyntax: SimpleName(access.RightPart)
        case name is NameExpressionSyntax: name.IdentifierToken.Text
        default: string.Empty
    }

    /// The value of a string literal expression, or `null`.
    /// @param expression The expression.
    /// @returns The string value.
    internal func StringLiteral(expression SyntaxNode?) string? -> if expression is LiteralExpressionSyntax{
        Value: string value
    } {
        value
    } else {
        default(string?)
    }

    /// The member that contains [`node`](paramref), as `Type.Member`,
    /// using the OUTERMOST member under the type, the way Roslyn's
    /// `MemberDeclarationSyntax` ancestor walk treats a lambda or local
    /// function as part of its enclosing method.
    /// @param node The node.
    /// @returns `Type.Member`.
    internal func ContainingMember(node SyntaxNode) string {
        var member string? = nil
        for ancestor in node.Ancestors() {
            let type string? = TypeName(ancestor)
            if type != nil {
                return type + "." + (member ?? "<type>")
            }
            member = MemberName(ancestor) ?? member
        }
        return "<top-level>." + (member ?? "<none>")
    }

    /// The shape key of the nearest enclosing member, mapped exactly like the
    /// C# scan's `GetEnclosingMemberName` (DiagnosticIdUniquenessTests), so
    /// distinct sites stay distinct in both languages: a function (local ones
    /// included) by its name, a constructor by its containing type's name, an
    /// accessor body as `Property.get` / `Property.set`. Anything else
    /// keeps walking outward, and outside every member it is `<top-level>`.
    /// @param node The node.
    /// @returns The member's shape key.
    internal func NearestMemberName(node SyntaxNode) string {
        for ancestor in node.Ancestors() {
            switch ancestor {
                case function is FunctionDeclarationSyntax {
                    return function.Identifier.Text
                }
                case ConstructorDeclarationSyntax {
                    return ancestor
                        .Ancestors()
                        .Select(TypeName)
                        .FirstOrDefault((name string?) -> name != nil) ??
                        "<top-level>"
                }
                case accessor is PropertyAccessorSyntax {
                    let property = accessor.Ancestors().OfType[PropertyDeclarationSyntax]().FirstOrDefault()
                    return (property?.Identifier.Text ?? string.Empty) + "." + accessor.AccessorKeyword.Text
                }
            }
        }
        return "<top-level>"
    }

    private func MemberName(node SyntaxNode) string? -> switch node {
        case function is FunctionDeclarationSyntax: function.Identifier.Text
        case _ is ConstructorDeclarationSyntax: ".ctor"
        case property is PropertyDeclarationSyntax: property.Identifier.Text
        case field is FieldDeclarationSyntax: field.Identifier.Text
        case eventDeclaration is EventDeclarationSyntax: eventDeclaration.Identifier.Text
        default: default(string?)
    }

    // G#'s syntax has no ClassDeclarationSyntax: the parser represents both
    // `class` and `struct` declarations as StructDeclarationSyntax (see its
    // `structKeyword` parameter), so this covers every class in the tree.
    private func TypeName(node SyntaxNode) string? -> switch node {
        case type is StructDeclarationSyntax: type.Identifier.Text
        case type is InterfaceDeclarationSyntax: type.Identifier.Text
        case type is EnumDeclarationSyntax: type.Identifier.Text
        default: default(string?)
    }
}
