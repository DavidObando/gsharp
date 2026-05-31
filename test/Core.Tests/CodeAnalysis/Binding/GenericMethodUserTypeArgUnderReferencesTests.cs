// <copyright file="GenericMethodUserTypeArgUnderReferencesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #320: imported generic methods called with an
/// explicit <em>user-defined</em> type as the type argument
/// (<c>Array.Empty[Clock]()</c>, <c>Activator.CreateInstance[Clock]()</c>,
/// <c>provider.GetService[Clock]()</c>) must resolve when references are supplied
/// explicitly (the SDK <c>/r:</c> build path), which loads them into an isolated
/// <see cref="System.Reflection.MetadataLoadContext"/>.
/// <para>
/// A user-defined type is a <see cref="StructSymbol"/> with a <c>null</c>
/// <c>ClrType</c> during binding, so the explicit type-argument resolution path
/// rejected it before ever attempting <c>MakeGenericMethod</c>, producing
/// <c>GS0159: Cannot find function</c>. The fix closes the open generic method
/// with a <c>System.Object</c> placeholder (so applicability checking succeeds)
/// while carrying the real user-type symbols to the emitter, which encodes the
/// true user-type token in the method specification.
/// </para>
/// </summary>
public class GenericMethodUserTypeArgUnderReferencesTests
{
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Array).Assembly.Location,
            typeof(System.Activator).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Linq.Enumerable).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            MetadataLoadContextResolver());
        var program = Binder.BindProgram(globalScope, MetadataLoadContextResolver());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    [Fact]
    public void Static_Generic_Method_With_UserType_Arg_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
            import System

            type Clock class {
            }

            func main() {
                var arr = Array.Empty[Clock]()
                Console.WriteLine(arr.Length)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Activator_CreateInstance_With_UserType_Arg_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
            import System

            type Clock class {
                Ticks int32
                func Read() int32 {
                    return Ticks
                }
            }

            func main() {
                var c = Activator.CreateInstance[Clock]()
                Console.WriteLine(c.Read())
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void BclType_Arg_Still_Resolves_Under_Explicit_References()
    {
        // Regression guard for issue #311: an all-BCL explicit type argument must
        // continue to bind exactly as before the user-type placeholder change.
        var source = """
            package App
            import System

            func main() {
                var arr = Array.Empty[string]()
                Console.WriteLine(arr.Length)
            }
            """;

        Assert.Empty(Bind(source));
    }
}
