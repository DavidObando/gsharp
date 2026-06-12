// <copyright file="ChannelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 5.4 / 5.5 — <c>chan T</c> type, <c>make(chan T[, cap])</c>,
/// send <c>ch &lt;- v</c>, receive <c>&lt;-ch</c>, and <c>close(ch)</c>
/// in the interpreter.
/// </summary>
public class ChannelTests
{
    [Fact]
    public void MakeChannel_AndSendRecv_Roundtrip()
    {
        var source = @"
let ch = make(chan int32, 1)
ch <- 7
let v = <-ch
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void MakeChannel_Unbounded_Binds()
    {
        var source = @"
let ch = make(chan string)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Close_OnChannel_Binds()
    {
        var source = @"
let ch = make(chan int32, 1)
close(ch)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Receive_FromClosedChannel_ReturnsZero()
    {
        var source = @"
let ch = make(chan int32, 1)
close(ch)
let v = <-ch
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Send_ToNonChannel_Diagnoses()
    {
        var source = @"
let x = 1
x <- 2
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("channel"));
    }

    [Fact]
    public void Receive_FromNonChannel_Diagnoses()
    {
        var source = @"
let x = 1
let v = <-x
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("channel"));
    }

    [Fact]
    public void Close_OnNonChannel_Diagnoses()
    {
        var source = @"
let x = 1
close(x)
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("channel"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        // ADR-0082 / issue #722: every Go-flavored concurrency form is
        // gated behind `import Gsharp.Extensions.Go`. These tests focus on
        // bind/recv/close behaviour rather than the gate, so prepend the
        // import once for the whole class. The dedicated
        // Issue722GoExtensionsImportGateTests cover the gate explicitly.
        var fullSource = "import Gsharp.Extensions.Go\n" + source;
        var tree = SyntaxTree.Parse(SourceText.From(fullSource));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
