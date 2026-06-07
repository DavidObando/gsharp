// <copyright file="Issue526NestedTypeClauseParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #526: the parser must accept dotted-qualifier names in any type-clause
/// position (variable declaration type, parameter type, return type, base-type
/// clause, etc.) so a nested CLR type such as <c>Outer.Inner</c> is reachable.
/// These tests focus on the grammar/parser layer only — type resolution
/// is covered by end-to-end emit tests in test/Compiler.Tests/Emit/.
/// </summary>
public class Issue526NestedTypeClauseParserTests
{
    [Fact]
    public void VarDeclaration_With_DottedQualifier_TypeClause_ParsesWithoutDiagnostics()
    {
        // The exact shape from the issue body: `var x Outer.INested = nil`
        // used to surface two GS0005 (unexpected `<DotToken>`) errors; after
        // the fix it parses cleanly into a single TypeClauseSyntax with one
        // qualifier segment.
        const string source = @"
package P
func Use() {
    var x Outer.INested = nil
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var varDecl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        var type = varDecl.TypeClause;
        Assert.NotNull(type);
        Assert.Equal("Outer", type.Identifier.Text);
        Assert.True(type.HasQualifier);
        Assert.Single(type.QualifierIdentifierTokens);
        Assert.Equal("INested", type.QualifierIdentifierTokens[0].Text);
        Assert.Equal("Outer.INested", type.DottedName);
    }

    [Fact]
    public void VarDeclaration_With_ThreeLevel_DottedQualifier_Parses()
    {
        // Three-level nesting `A.B.C` parses as one type clause carrying two
        // qualifier segments, with the dotted name reconstructable from the
        // identifier + qualifier tokens.
        const string source = @"
package P
func Use() {
    var x A.B.C = nil
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var varDecl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        var type = varDecl.TypeClause;
        Assert.Equal("A", type.Identifier.Text);
        Assert.Equal(2, type.QualifierIdentifierTokens.Length);
        Assert.Equal("B", type.QualifierIdentifierTokens[0].Text);
        Assert.Equal("C", type.QualifierIdentifierTokens[1].Text);
        Assert.Equal("A.B.C", type.DottedName);
    }

    [Fact]
    public void BaseClause_With_DottedQualifier_Parses()
    {
        // `type Impl class : Outer.INested { … }` used to fail in the shared
        // base-type parsing path. Base entries are now full TypeClauseSyntax
        // nodes so dotted (and generic) forms are preserved structurally.
        const string source = @"
package P
type Impl class : Outer.INested {
    func Compute() int32 { return 42 }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var typeDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Equal("Impl", typeDecl.Identifier.Text);
        Assert.True(typeDecl.HasBaseType);
        Assert.Single(typeDecl.BaseTypeClauses);
        Assert.Equal("Outer.INested", typeDecl.BaseTypeClauses[0].DottedName);
    }

    [Fact]
    public void BaseClause_With_GenericInterface_Parses()
    {
        const string source = @"
package P
import System

type Impl class : IComparable[string] {
    func CompareTo(value object) int32 { return 0 }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var typeDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.True(typeDecl.HasBaseType);
        Assert.Single(typeDecl.BaseTypeClauses);
        var baseType = typeDecl.BaseTypeClauses[0];
        Assert.Equal("IComparable", baseType.DottedName);
        Assert.True(baseType.HasTypeArguments);
        Assert.Single(baseType.TypeArguments);
        Assert.Equal("string", baseType.TypeArguments[0].DottedName);
    }

    [Fact]
    public void GenericDeclaration_BaseClause_UsesTypeParameter_Parses()
    {
        const string source = @"
package P
import System.Collections.Generic

type MyGeneric[T any] class : IEnumerable[T] {
    func GetEnumerator() IEnumerator[T] { return nil }
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var typeDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.NotNull(typeDecl.TypeParameterList);
        Assert.True(typeDecl.HasBaseType);
        Assert.Single(typeDecl.BaseTypeClauses);
        var baseType = typeDecl.BaseTypeClauses[0];
        Assert.Equal("IEnumerable", baseType.DottedName);
        Assert.True(baseType.HasTypeArguments);
        Assert.Single(baseType.TypeArguments);
        Assert.Equal("T", baseType.TypeArguments[0].DottedName);
    }

    [Fact]
    public void Function_Parameter_With_DottedQualifier_Parses()
    {
        const string source = @"
package P
func Run(x Outer.INested) {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Single(fn.Parameters);
        var param = fn.Parameters[0];
        Assert.Equal("Outer", param.Type.Identifier.Text);
        Assert.Equal("Outer.INested", param.Type.DottedName);
    }

    [Fact]
    public void Function_ReturnType_With_DottedQualifier_Parses()
    {
        const string source = @"
package P
func Make() Outer.INested {
    return nil
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.NotNull(fn.Type);
        Assert.Equal("Outer.INested", fn.Type.DottedName);
    }

    [Fact]
    public void DottedQualifier_With_Nullable_Suffix_Parses()
    {
        // The trailing `?` still attaches to the deepest segment.
        const string source = @"
package P
func Use() {
    var x Outer.INested? = nil
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var varDecl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        var type = varDecl.TypeClause;
        Assert.True(type.HasQualifier);
        Assert.True(type.IsNullable);
        Assert.Equal("Outer.INested", type.DottedName);
    }

    [Fact]
    public void DottedQualifier_With_TypeArguments_AttachesToDeepestSegment()
    {
        // `Outer.Generic[int32]` — type-argument list attaches to the deepest
        // segment of the qualifier chain.
        const string source = @"
package P
func Use() {
    var x Outer.Generic[int32] = nil
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var varDecl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        var type = varDecl.TypeClause;
        Assert.True(type.HasQualifier);
        Assert.True(type.HasTypeArguments);
        Assert.Equal("Generic", type.QualifierIdentifierTokens[^1].Text);
        Assert.Single(type.TypeArguments);
    }

    [Fact]
    public void SimpleIdentifier_TypeClause_HasNoQualifier()
    {
        // Regression guard: a plain single-identifier type clause must not
        // accidentally pick up a qualifier chain (verifies the dot-lookahead
        // is gated on a following IdentifierToken so we never miscount a
        // following member access as part of the type).
        const string source = @"
package P
func Use() {
    var x int32 = 0
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var varDecl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        var type = varDecl.TypeClause;
        Assert.Equal("int32", type.Identifier.Text);
        Assert.False(type.HasQualifier);
        Assert.Empty(type.QualifierIdentifierTokens);
        Assert.Equal("int32", type.DottedName);
    }
}
