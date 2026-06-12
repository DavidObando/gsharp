// <copyright file="ImportedTypeInFunctionBodyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests: imports of non-<c>System.*</c> namespaces must resolve
/// inside function and method bodies, not only in top-level statements.
/// <para>
/// Previously <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver)"/>
/// rebuilt the function-body parent scope with <c>references: null</c>, so those
/// scopes fell back to <see cref="ReferenceResolver.Default"/> (core/System
/// assemblies only). Types from referenced libraries or third-party packages
/// (e.g. <c>Xunit.Assert</c>) therefore failed to resolve inside bodies even
/// though they resolved at top level. The resolver is now threaded through.
/// </para>
/// </summary>
public class ImportedTypeInFunctionBodyTests
{
    private static ReferenceResolver FixtureResolver()
    {
        var fixturePath = typeof(ImportedGreeter).Assembly.Location;
        return ReferenceResolver.WithReferences(new[] { fixturePath });
    }

    private static ImmutableArray<Diagnostic> BindBodies(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            FixtureResolver());
        var program = Binder.BindProgram(globalScope, FixtureResolver());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    [Fact]
    public void ImportedType_Constructed_In_FreeFunction_Body_Resolves()
    {
        var source = """
            package Demo
            import GSharp.Core.Tests.Fixtures

            func Run() string {
                var g = ImportedGreeter()
                return g.Greet("world")
            }
            """;

        Assert.Empty(BindBodies(source));
    }

    [Fact]
    public void ImportedType_Constructed_In_Class_Method_Body_Resolves()
    {
        var source = """
            package Demo
            import GSharp.Core.Tests.Fixtures

            class Host {
                func Run() string {
                    var g = ImportedGreeter()
                    return g.Greet("world")
                }
            }
            """;

        Assert.Empty(BindBodies(source));
    }
}
