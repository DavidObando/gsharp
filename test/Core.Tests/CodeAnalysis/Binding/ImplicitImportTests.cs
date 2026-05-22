// <copyright file="ImplicitImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 1.5: an implicit <c>import System</c> is seeded by default so common
/// BCL types (Console, String, ...) resolve without an explicit import. The
/// behaviour is opt-out via the <c>implicitSystemImport</c> parameter.
/// </summary>
public class ImplicitImportTests
{
    [Fact]
    public void Console_Resolves_Without_Explicit_Import()
    {
        var diagnostics = Bind("func F() {\n Console.WriteLine(\"hi\")\n }\n", useImplicit: true);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Console_Does_Not_Resolve_When_Implicit_Disabled()
    {
        var diagnostics = Bind("func F() {\n Console.WriteLine(\"hi\")\n }\n", useImplicit: false);
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void Explicit_Import_Coexists_With_Implicit()
    {
        // Same import declared explicitly + implicitly must not error.
        var diagnostics = Bind("import System\n\nfunc F() {\n Console.WriteLine(\"hi\")\n }\n", useImplicit: true);
        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source, bool useImplicit)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), references: null, implicitSystemImport: useImplicit);
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
