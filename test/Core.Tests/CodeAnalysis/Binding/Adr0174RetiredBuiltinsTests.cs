// <copyright file="Adr0174RetiredBuiltinsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D12/D13: the Go-style built-ins <c>len</c>, <c>cap</c>,
/// <c>append</c>, <c>delete</c> and <c>close</c> are retired. A bare call
/// reports GS0566 at the call, and the guidance names the member the operand
/// actually has — computed for the site, so pasting it in place of the
/// retired call compiles clean (the Phase 2 gate). The names stay free for
/// users: a user-defined function of the same name is an ordinary call. The
/// <c>Gsharp.Extensions.Go</c> gate is gone with them — no import is needed
/// for any channel program, and the old import is an ordinary unresolved
/// import.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that reports GS0566 before
/// consulting the scope breaks <see cref="UserDefinedLen_Wins"/>; a mutant
/// that names <c>.Length</c> for every receiver breaks
/// <see cref="Len_OnMap_NamesCount"/> and <see cref="Len_OnChannel_NamesLengthMethod"/>,
/// whose replacements would then fail to compile in
/// <see cref="EveryReplacement_CompilesClean"/>.
/// </remarks>
public class Adr0174RetiredBuiltinsTests
{
    [Theory]
    [InlineData("len(xs)", "use 'xs.Length' instead.")]
    [InlineData("cap(xs)", "'xs.Length'")]
    [InlineData("append(xs, 4)", "call 'xs.Add(4)' instead.")]
    public void SliceBuiltins_ReportGS0566_AtTheCall(string call, string guidance)
    {
        var source = $$"""
            package P
            func main() {
                var xs = []int32{1, 2, 3}
                let r = {{call}}
            }
            """;
        var (diagnostics, _) = Bind(source);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0566", diagnostic.Id);
        Assert.Contains(guidance, diagnostic.Message);
        Assert.Equal(call, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void Len_OnMap_NamesCount()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let m = map[string, int32]{"a": 1}
                let n = len(m)
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0566", diagnostic.Id);
        Assert.Contains("use 'm.Count' instead.", diagnostic.Message);
    }

    [Fact]
    public void Delete_OnMap_NamesRemove()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let m = map[string, int32]{"a": 1}
                delete(m, "a")
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0566", diagnostic.Id);
        Assert.Contains("use 'm.Remove(\"a\")' instead.", diagnostic.Message);
    }

    [Fact]
    public void Len_OnChannel_NamesLengthMethod()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let ch = chan[int32](2)
                let n = len(ch)
                let c = cap(ch)
            }
            """);

        Assert.Equal(2, diagnostics.Length);
        Assert.All(diagnostics, d => Assert.Equal("GS0566", d.Id));
        Assert.Contains(diagnostics, d => d.Message.Contains("use 'ch.Length()' instead."));
        Assert.Contains(diagnostics, d => d.Message.Contains("use 'ch.Capacity' instead."));
    }

    [Fact]
    public void Close_NamesTheMember()
    {
        var (diagnostics, _) = Bind("""
            package P
            func main() {
                let ch = chan[int32](1)
                close(ch)
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0566", diagnostic.Id);
        Assert.Contains("use 'ch.Close()' instead.", diagnostic.Message);
    }

    [Fact]
    public void EveryReplacement_CompilesClean()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Replacements
            import System.Collections.Generic
            let xs = []int32{1, 2, 3}
            let m = map[string, int32]{"a": 1, "b": 2}
            let ch = chan[int32](2)
            ch <- 1
            let grown = List[int32]()
            grown.Add(4)
            m.Remove("a")
            let total = xs.Length * 1000 + m.Count * 100 + ch.Length() * 10 + ch.Capacity + grown[0]
            ch.Close()
            total
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3116, result.Value);
    }

    [Fact]
    public void UserDefinedLen_Wins()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174UserLen
            func len(xs []int32) int32 {
                return xs.Length * 10
            }
            let xs = []int32{1, 2, 3}
            len(xs)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(30, result.Value);
    }

    [Fact]
    public void UserDefinedClose_Wins()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174UserClose
            func close(door string) string {
                return door + " closed"
            }
            close("front")
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("front closed", result.Value);
    }

    [Fact]
    public void ChannelProgram_NeedsNoImport()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174NoImport
            func produce(w out chan[int32]) {
                w <- 20
                w <- 22
                w.Close()
            }
            let ch = chan[int32](2)
            go produce(ch)
            var sum = 0
            for v in ch {
                sum = sum + v
            }
            sum
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GoExtensionsNamespace_NoLongerExists()
    {
        // An import of a namespace nothing declares is accepted silently (it
        // is how a project imports a namespace a later reference will
        // supply), so the observable fact is that the marker type the
        // namespace used to carry is gone — and that no gate diagnostic
        // fires for the import.
        var (diagnostics, _) = Bind("""
            package P
            import Gsharp.Extensions.Go
            func main() {
                let marker = GoExtensions()
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Contains("GoExtensions", diagnostic.Message);
        Assert.DoesNotContain(diagnostics, d => d.Id is "GS0316" or "GS0317");
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, Compilation Compilation) Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return (EmittedOracle.CompileDiagnostics(compilation), compilation);
    }
}
