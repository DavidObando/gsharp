// <copyright file="Issue698DeinitParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #698 / ADR-0068: parser-level tests for the Swift-style
/// <c>deinit { … }</c> destructor declaration.
/// </summary>
public class Issue698DeinitParserTests
{
    [Fact]
    public void ParsesBareDeinit_OnClass()
    {
        const string source = """
            package P
            type Resource class {
                var Handle int32 = 0
                deinit {
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.NotNull(structDecl.Deinitializer);
        Assert.Equal(SyntaxKind.DeinitDeclaration, structDecl.Deinitializer.Kind);
        Assert.NotNull(structDecl.Deinitializer.Body);
        Assert.Empty(structDecl.Deinitializer.Body.Statements);
    }

    [Fact]
    public void DeinitBody_ContainsStatements()
    {
        const string source = """
            package P
            import System
            type Resource class {
                var Tag string = ""
                deinit {
                    Console.WriteLine(Tag)
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structDecl = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        Assert.NotNull(structDecl.Deinitializer);
        Assert.Single(structDecl.Deinitializer.Body.Statements);
    }

    [Fact]
    public void DeinitOnStruct_ProducesGS0289()
    {
        const string source = """
            package P
            type Point struct {
                var X int32 = 0
                deinit {
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        var diags = tree.Diagnostics;
        Assert.NotEmpty(diags);
        Assert.Contains(diags, d => d.Id == "GS0289");
    }

    [Fact]
    public void DuplicateDeinit_ProducesGS0290()
    {
        const string source = """
            package P
            type Resource class {
                var Handle int32 = 0
                deinit {
                }
                deinit {
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        var diags = tree.Diagnostics;
        Assert.Contains(diags, d => d.Id == "GS0290");
    }

    [Fact]
    public void DeinitWithParameters_ProducesGS0291()
    {
        const string source = """
            package P
            type Resource class {
                var Handle int32 = 0
                deinit(x int32) {
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        var diags = tree.Diagnostics;
        Assert.Contains(diags, d => d.Id == "GS0291");
    }

    [Fact]
    public void DeinitWithReturnType_ProducesGS0292()
    {
        const string source = """
            package P
            type Resource class {
                var Handle int32 = 0
                deinit int32 {
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        var diags = tree.Diagnostics;
        Assert.Contains(diags, d => d.Id == "GS0292");
    }
}
