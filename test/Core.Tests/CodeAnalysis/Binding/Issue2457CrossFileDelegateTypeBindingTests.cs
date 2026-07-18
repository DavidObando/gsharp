// <copyright file="Issue2457CrossFileDelegateTypeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2457: named delegate signatures bind against the complete declaration
/// symbol table rather than the syntax-tree prefix processed so far.
/// </summary>
public class Issue2457CrossFileDelegateTypeBindingTests
{
    private const string Delegates = """
        package Demo
        import System.Collections.Generic

        type Work[T ICancellation] = delegate func(
            cancellation ICancellation,
            values List[ConfigurationTokenResult]) Dictionary[string, ConfigurationTokenResult]
        internal type GetResult = delegate func() ConfigurationTokenResult
        """;

    private const string Types = """
        package Demo

        interface ICancellation {}
        internal data class ConfigurationTokenResult(Value string) {}
        """;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void SamePackageTypes_ResolveInDelegateConstraintsParametersAndReturns_RegardlessOfFileOrder(bool delegateFirst)
    {
        var sources = delegateFirst ? new[] { Delegates, Types } : new[] { Types, Delegates };

        AssertNoErrors(sources);
    }

    [Fact]
    public void PublicImportedCrossPackageTypes_ResolveInDelegateSignature()
    {
        const string shared = """
            package Shared

            interface IConstraint {}
            data class Result(Value string) {}
            """;
        const string consumer = """
            package Consumer
            import Shared
            import System.Collections.Generic

            type Convert[T IConstraint] = delegate func(value Result) List[Result]
            """;

        AssertNoErrors(new[] { consumer, shared });
    }

    [Fact]
    public void SamePackageInternalType_IsVisibleToDelegateInAnotherFile()
    {
        const string consumer = """
            package Demo

            internal type Read = delegate func(value Hidden) Hidden
            """;
        const string hidden = """
            package Demo

            internal class Hidden {}
            """;

        AssertNoErrors(new[] { consumer, hidden });
    }

    [Fact]
    public void UnrelatedFileImport_DoesNotMakeDelegateReferenceAmbiguous()
    {
        const string left = """
            package Left

            class Result {}
            """;
        const string right = """
            package Right

            class Result {}
            """;
        const string delegates = """
            package Consumer
            import Left

            type Read = delegate func() Result
            """;
        const string unrelated = """
            package Unrelated
            import Right

            class Marker {}
            """;

        AssertNoErrors(new[] { right, left, unrelated, delegates });
    }

    [Fact]
    public void MissingDelegateSignatureType_StillReportsUndefinedType()
    {
        const string source = """
            package Demo

            type Read = delegate func(value Missing) Missing
            """;

        var errors = Errors(new[] { source }).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0113");
    }

    [Fact]
    public void AmbiguousImportedDelegateSignatureType_StillReportsAmbiguity()
    {
        const string left = """
            package Left

            class Result {}
            """;
        const string right = """
            package Right

            class Result {}
            """;
        const string consumer = """
            package Consumer
            import Left
            import Right

            type Read = delegate func() Result
            """;

        var errors = Errors(new[] { left, right, consumer }).ToArray();

        Assert.Contains(errors, d => d.Id == "GS0496");
    }

    private static void AssertNoErrors(string[] sources)
        => Assert.DoesNotContain(Errors(sources), _ => true);

    private static IEnumerable<Diagnostic> Errors(string[] sources)
    {
        var trees = sources.Select(source => SyntaxTree.Parse(SourceText.From(source))).ToArray();
        var compilation = new Compilation(trees) { IsLibrary = true };
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError);
    }
}
