// <copyright file="Issue3673NullableReceiverExtensionInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3673: an imported generic extension method whose <c>this</c>
/// parameter is <c>Nullable&lt;T&gt;</c> must infer <c>T</c> from a value-typed
/// nullable receiver even when no user argument mentions <c>T</c>. The
/// extension-call argument vector presents slot 0 as
/// <c>NullableTypeSymbol.ClrType</c>, which is the *underlying* CLR type, so
/// the binder additionally retries with the lifted <c>Nullable&lt;T&gt;</c>
/// shape. This is what <c>Gsharp.Extensions.Optional.OrThrow</c> needs.
/// </summary>
public class Issue3673NullableReceiverExtensionInferenceTests
{
    [Fact]
    public void ReceiverOnlyInference_ValueTypedNullable_Binds()
    {
        const string source = """
            package Probe
            import GSharp.Core.Tests.Fixtures

            func Run() {
                let v int32? = 7
                let unwrapped = v.UnwrapOrThrow3673("missing")
            }
            """;

        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void ReceiverOnlyInference_ReferenceTypedNullable_Binds()
    {
        const string source = """
            package Probe
            import GSharp.Core.Tests.Fixtures

            func Run() {
                let s string? = "x"
                let unwrapped = s.UnwrapOrThrow3673("missing")
            }
            """;

        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void ArgumentDrivenInference_ValueTypedNullable_StillBinds()
    {
        const string source = """
            package Probe
            import GSharp.Core.Tests.Fixtures

            func Run() {
                let v int32? = 7
                let value = v.UnwrapOrElse3673(1)
            }
            """;

        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void UnderlyingTypedExtension_OnNullableReceiver_StillBinds()
    {
        // The lifted retry runs only after the unlifted receiver shape has
        // already failed, so an extension declared over the underlying value
        // type keeps binding exactly as it did before issue #3673.
        const string source = """
            package Probe
            import GSharp.Core.Tests.Fixtures

            func Run() {
                let v int32? = 7
                let doubled = v.Double3673()
            }
            """;

        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void UnknownExtensionName_OnNullableReceiver_StillReportsError()
    {
        const string source = """
            package Probe
            import GSharp.Core.Tests.Fixtures

            func Run() {
                let v int32? = 7
                let missing = v.NoSuchExtension3673("missing")
            }
            """;

        Assert.Contains(BindDiagnostics(source), d => d.IsError);
    }

    private static void AssertBindsWithoutErrors(string source)
        => Assert.DoesNotContain(BindDiagnostics(source), d => d.IsError);

    private static ImmutableArray<Diagnostic> BindDiagnostics(string source)
    {
        // Load the test assembly (which carries the issue #3673 fixture) plus
        // the BCL through a MetadataLoadContext, matching how the migrated
        // Extensions.Tests app sees Gsharp.Extensions.dll.
        List<string> paths = [typeof(Fixtures.Issue3673NullableReceiverExtensions).Assembly.Location];
        if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string tpa && !string.IsNullOrEmpty(tpa))
        {
            paths.AddRange(tpa.Split(Path.PathSeparator).Where(p => !string.IsNullOrWhiteSpace(p) && File.Exists(p)));
        }

        using var resolver = ReferenceResolver.WithReferences(paths.Distinct(StringComparer.OrdinalIgnoreCase));
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }
}
