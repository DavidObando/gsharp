// <copyright file="DeferStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 7.1 / ADR-0030 — <c>defer</c> and shared block-scope cleanup lowering.
/// </summary>
public class DeferStatementTests
{
    [Fact]
    public void Defer_SingleDeferRunsAtBlockExit()
    {
        var result = Evaluate(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    defer DeferFixture.Record(""after"")
    DeferFixture.Record(""before"")
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("before,after", result.Value);
    }

    [Fact]
    public void Defer_MultipleDefersRunLifo()
    {
        var result = Evaluate(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    defer DeferFixture.Record(""first"")
    defer DeferFixture.Record(""second"")
    defer DeferFixture.Record(""third"")
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("third,second,first", result.Value);
    }

    [Fact]
    public void Defer_ArgumentsEvaluateEagerly()
    {
        var result = Evaluate(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    var x = 1
    defer DeferFixture.RecordNumber(x)
    x = 2
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("1", result.Value);
    }

    [Fact]
    public void Defer_InstanceReceiverEvaluatesEagerly()
    {
        // Issue #1635 / ADR-0030: `defer r.Close()` must capture the receiver
        // `r` at the defer point. Reassigning `r` afterwards must not change
        // which instance the deferred call runs against.
        var result = Evaluate(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

class Recorder(Name string) {
    func Close() {
        DeferFixture.Record(Name)
    }
}

DeferFixture.Reset()
{
    var r = Recorder(""orig"")
    defer r.Close()
    r = Recorder(""other"")
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("orig", result.Value);
    }

    [Fact]
    public void Defer_IndirectCallTargetEvaluatesEagerly()
    {
        // Issue #1635 / ADR-0030: `defer g()` through a function value must
        // capture the function value at the defer point. Reassigning `g`
        // afterwards must not change which function runs at scope exit.
        var result = Evaluate(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    var g = func() { DeferFixture.Record(""orig"") }
    defer g()
    g = func() { DeferFixture.Record(""other"") }
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("orig", result.Value);
    }

    [Fact]
    public void Defer_ReceiverProducedByCallEvaluatesAtDeferPoint()
    {
        // Issue #1635 / ADR-0030: `defer getX().M()` must evaluate `getX()`
        // eagerly at the defer point, not at scope exit. Observed via
        // side-effect ordering: the "get" event must precede "body", and the
        // deferred "close" event must come last.
        var result = Evaluate(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

class Recorder(Name string) {
    func Close() {
        DeferFixture.Record(""close-"" + Name)
    }
}

func getRecorder() Recorder {
    DeferFixture.Record(""get"")
    return Recorder(""x"")
}

DeferFixture.Reset()
{
    defer getRecorder().Close()
    DeferFixture.Record(""body"")
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("get,body,close-x", result.Value);
    }

    [Fact]
    public void Defer_RunsOnException()
    {
        var result = Evaluate(@"
import System
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
try {
    {
        defer DeferFixture.Record(""defer"")
        DeferFixture.ThrowNow()
    }
} catch (e Exception) {
    DeferFixture.Record(""catch"")
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("defer,catch", result.Value);
    }

    [Fact]
    public void Defer_NonCallOperandDiagnoses()
    {
        var result = Evaluate(@"
defer 42
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'defer'"));
    }

    [Fact]
    public void Defer_CallWithOutArgument_ReportsGS0460()
    {
        // Issue #1635 NB-1: a by-ref (ref/out/in) argument's bound value is
        // the ADDRESS of its target storage. Eager capture spilling that
        // address into an ordinary readonly local is not a meaningful by-ref
        // capture, so `defer` on such a call is rejected rather than
        // mis-compiled.
        var result = Evaluate(@"
import System
import System.Collections.Generic

var dict = Dictionary[string, int32]()
dict[""key""] = 42
var value = 0
defer dict.TryGetValue(""key"", &value)
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0460");
    }

    [Fact]
    public void Using_DisposeProtectsSubsequentThrowingStatements()
    {
        var result = Evaluate(@"
import System
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
try {
    {
        using let d = DeferFixture.Open(""dispose"")
        DeferFixture.ThrowNow()
    }
} catch (e Exception) {
    DeferFixture.Record(""catch"")
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("dispose,catch", result.Value);
    }

    [Fact]
    public void DeferAndUsing_InterleaveInLifoOrder()
    {
        var result = Evaluate(@"
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    defer DeferFixture.Record(""defer-1"")
    using let u1 = DeferFixture.Open(""using-1"")
    defer DeferFixture.Record(""defer-2"")
    using let u2 = DeferFixture.Open(""using-2"")
    DeferFixture.Record(""body"")
}
DeferFixture.Snapshot()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("body,using-2,defer-2,using-1,defer-1", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}

/// <summary>Side-effect helpers exposed to GSharp defer tests.</summary>
public static class DeferFixture
{
    private static readonly List<string> Events = new List<string>();

    /// <summary>Clears the recorded event log.</summary>
    public static void Reset() => Events.Clear();

    /// <summary>Records one event.</summary>
    /// <param name="value">The value to record.</param>
    public static void Record(string value) => Events.Add(value);

    /// <summary>Records an integer event.</summary>
    /// <param name="value">The value to record.</param>
    public static void RecordNumber(int value) => Events.Add(value.ToString());

    /// <summary>Gets the recorded events as a comma-separated string.</summary>
    /// <returns>The current event log.</returns>
    public static string Snapshot() => string.Join(",", Events);

    /// <summary>Creates a disposable that records an event from <see cref="IDisposable.Dispose"/>.</summary>
    /// <param name="value">The value to record on disposal.</param>
    /// <returns>A disposable event recorder.</returns>
    public static IDisposable Open(string value) => new RecordingDisposable(value);

    /// <summary>Throws a test exception.</summary>
    /// <exception cref="InvalidOperationException">Always thrown.</exception>
    public static void ThrowNow() => throw new InvalidOperationException("boom");

    private sealed class RecordingDisposable : IDisposable
    {
        private readonly string value;

        public RecordingDisposable(string value)
        {
            this.value = value;
        }

        public void Dispose() => Events.Add(value);
    }
}
