// <copyright file="Issue910NestedTypeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #910 / ADR-0110: parser-level tests for nested type declarations
/// (<c>class</c> / <c>struct</c> / <c>interface</c> / <c>enum</c>) declared
/// inside a <c>class</c> or <c>struct</c> body. Before this change the
/// aggregate-member grammar had no production for nested types, so each one
/// was misparsed as a malformed field and produced a misleading error cascade.
/// </summary>
public class Issue910NestedTypeParserTests
{
    [Fact]
    public void NestedClassInClass_ParsesWithoutDiagnostics()
    {
        const string source = """
            package P
            class Outer {
                class Inner {
                    func Hello() string {
                        return "hi"
                    }
                }

                func Make() string {
                    let i = Inner()
                    return i.Hello()
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var nested = Assert.Single(outer.NestedTypes);
        var inner = Assert.IsType<StructDeclarationSyntax>(nested);
        Assert.True(inner.IsClass);
        Assert.Equal("Inner", inner.Identifier.Text);
    }

    [Fact]
    public void NestedStructInStruct_ParsesWithoutDiagnostics()
    {
        const string source = """
            package P
            struct Outer {
                struct Inner {
                    var X int32 = 0
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var nested = Assert.Single(outer.NestedTypes);
        var inner = Assert.IsType<StructDeclarationSyntax>(nested);
        Assert.False(inner.IsClass);
        Assert.Equal("Inner", inner.Identifier.Text);
    }

    [Fact]
    public void NestedStructInClass_ParsesWithoutDiagnostics()
    {
        const string source = """
            package P
            class Outer {
                struct Inner {
                    var X int32 = 0
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var inner = Assert.IsType<StructDeclarationSyntax>(Assert.Single(outer.NestedTypes));
        Assert.False(inner.IsClass);
    }

    [Fact]
    public void NestedClassInStruct_ParsesWithoutDiagnostics()
    {
        const string source = """
            package P
            struct Outer {
                class Inner {
                    func Hello() string {
                        return "hi"
                    }
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var inner = Assert.IsType<StructDeclarationSyntax>(Assert.Single(outer.NestedTypes));
        Assert.True(inner.IsClass);
    }

    [Fact]
    public void NestedInterfaceInClass_ParsesWithoutDiagnostics()
    {
        const string source = """
            package P
            class Outer {
                interface IInner {
                    func Hello() string;
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var inner = Assert.IsType<InterfaceDeclarationSyntax>(Assert.Single(outer.NestedTypes));
        Assert.Equal("IInner", inner.Identifier.Text);
    }

    [Fact]
    public void NestedEnumInClass_ParsesWithoutDiagnostics()
    {
        const string source = """
            package P
            class Outer {
                enum Color {
                    Red,
                    Green,
                    Blue,
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var inner = Assert.IsType<EnumDeclarationSyntax>(Assert.Single(outer.NestedTypes));
        Assert.Equal("Color", inner.Identifier.Text);
    }

    [Fact]
    public void NestedEnumInStruct_ParsesWithoutDiagnostics()
    {
        const string source = """
            package P
            struct Outer {
                enum Color {
                    Red,
                    Green,
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.IsType<EnumDeclarationSyntax>(Assert.Single(outer.NestedTypes));
    }

    [Fact]
    public void RecursivelyNestedTypes_Parse()
    {
        const string source = """
            package P
            class Outer {
                class Middle {
                    class Inner {
                        func N() int32 {
                            return 7
                        }
                    }
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var middle = Assert.IsType<StructDeclarationSyntax>(Assert.Single(outer.NestedTypes));
        var inner = Assert.IsType<StructDeclarationSyntax>(Assert.Single(middle.NestedTypes));
        Assert.Equal("Inner", inner.Identifier.Text);
    }

    [Fact]
    public void NestedTypeWithAccessibilityModifier_Parses()
    {
        const string source = """
            package P
            class Outer {
                private class Inner {
                    var X int32 = 0
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var inner = Assert.IsType<StructDeclarationSyntax>(Assert.Single(outer.NestedTypes));
        Assert.NotNull(inner.AccessibilityModifier);
        Assert.Equal(SyntaxKind.PrivateKeyword, inner.AccessibilityModifier.Kind);
    }

    [Fact]
    public void EnclosingTypeMembersStillParse_AlongsideNestedType()
    {
        const string source = """
            package P
            class Outer {
                var Count int32 = 0

                class Inner {
                    var X int32 = 0
                }

                func Bump() int32 {
                    return Count
                }
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.Single(outer.NestedTypes);
        Assert.Single(outer.Fields);
        Assert.Single(outer.Methods);
    }
}
