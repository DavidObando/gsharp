// <copyright file="ImportAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 1.4: <c>import alias = path</c> introduces an alias for the imported
/// namespace. Member access through the alias resolves to the same CLR types
/// the un-aliased import would.
/// </summary>
public class ImportAliasTests
{
    [Fact]
    public void Aliased_Import_Resolves_Through_Alias()
    {
        var diagnostics = Bind("import sys = System\n\nfunc F() {\n sys.Console.WriteLine(\"hi\")\n }\n");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Plain_Import_Still_Works()
    {
        var diagnostics = Bind("import System\n\nfunc F() {\n Console.WriteLine(\"hi\")\n }\n");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Alias_Symbol_Has_Distinct_Name_And_Target()
    {
        var tree = SyntaxTree.Parse(SourceText.From("import sys = System\n\nfunc F() {}\n"));
        Assert.Empty(tree.Diagnostics);

        var importSyntax = tree.Root.Members.OfType<ImportSyntax>().Single();
        Assert.NotNull(importSyntax.AliasIdentifier);
        Assert.Equal("sys", importSyntax.AliasIdentifier.Text);
        Assert.Equal("System", importSyntax.Identifiers.Single().Text);
    }

    [Fact]
    public void Aliased_Dotted_Path_Resolves()
    {
        var diagnostics = Bind("import io = System.IO\n\nfunc F() {\n io.Directory.GetCurrentDirectory()\n }\n");
        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// A C# <c>using R = Some.Type;</c> alias whose target is a *type* (not a
    /// namespace) must let a bare <c>R.StaticMember</c> resolve to that type's
    /// static member. The alias target itself names the type, and the accessor's
    /// right part is a static member of it — so the member access binds without a
    /// "cannot find type R" error.
    /// </summary>
    [Fact]
    public void Aliased_Type_Resolves_Static_Member_Access()
    {
        var diagnostics = Bind("import R = System.Console\n\nfunc F() {\n R.WriteLine(\"hi\")\n }\n");
        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
