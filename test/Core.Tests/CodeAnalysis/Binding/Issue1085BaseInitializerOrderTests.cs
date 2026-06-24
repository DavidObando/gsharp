// <copyright file="Issue1085BaseInitializerOrderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1085: constructing a class that declares an explicit <c>init(...)</c>
/// inside a base-initializer (<c>: base(...)</c>) must bind correctly regardless
/// of the order in which the source files are processed. The base-initializer
/// argument expressions are bound in a deferred pass that runs after every
/// declared type's explicit constructors are populated, so a constructed type
/// declared in a file processed AFTER the caller no longer resolves against an
/// empty constructor shell (which previously produced a spurious GS0144).
/// </summary>
public class Issue1085BaseInitializerOrderTests
{
    private const string CallerFile = """
        package p
        open class Base(h H, x int32) { }
        class Derived : Base {
            init() : base(H(1), 0) { }
        }
        """;

    private const string DefinitionFile = """
        package p
        class H {
            init(v int32) { }
        }
        """;

    [Fact]
    public void BaseInitializerArgument_ConstructsTypeFromLaterFile_CompilesCleanly()
    {
        // Caller file FIRST — the constructed type `H` is declared in a file
        // processed afterwards. This is the failing order from #1085.
        var scope = BindSources(CallerFile, DefinitionFile);

        Assert.Empty(scope.Diagnostics);
    }

    [Fact]
    public void BaseInitializerArgument_DefinitionFileFirst_StillCompilesCleanly()
    {
        // The already-working order must keep working.
        var scope = BindSources(DefinitionFile, CallerFile);

        Assert.Empty(scope.Diagnostics);
    }

    [Fact]
    public void BaseInitializerArgument_ConstructedTypeHasMultipleOverloads_CompilesCleanly()
    {
        var definitionWithOverloads = """
            package p
            class H {
                init(v int32) { }
                init(v int32, w int32) { }
            }
            """;

        var scope = BindSources(CallerFile, definitionWithOverloads);

        Assert.Empty(scope.Diagnostics);
    }

    [Fact]
    public void BaseInitializerArgument_AcrossPackages_CallerFirst_CompilesCleanly()
    {
        var caller = """
            package p
            import q
            open class Base(h H, x int32) { }
            class Derived : Base {
                init() : base(H(1), 0) { }
            }
            """;

        var definition = """
            package q
            class H {
                init(v int32) { }
            }
            """;

        var scope = BindSources(caller, definition);

        Assert.Empty(scope.Diagnostics);
    }

    private static BoundGlobalScope BindSources(params string[] sources)
    {
        var trees = ImmutableArray.CreateRange(
            System.Linq.Enumerable.Select(sources, s => SyntaxTree.Parse(SourceText.From(s))));
        return Binder.BindGlobalScope(previous: null, trees);
    }
}
