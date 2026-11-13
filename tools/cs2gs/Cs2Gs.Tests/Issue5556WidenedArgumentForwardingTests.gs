// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

class Issue5556WidenedArgumentForwardingTests {
    @Theory
    @InlineData("Receiver().stored", "bras")
    @InlineData("Receiver().Value", "brgas")
    @InlineData("Receiver().Read()", "brcas")
    func WidenedOrigin_ForwardsThroughNamedArgumentOnce(origin string, trace string) {
        let source = `
#nullable enable
using System;
public class Node { }
public class Holder {
    private readonly Node stored;
    private static string trace = "";
    public Holder(Node value) { stored = value; }
    private Holder Receiver() { trace += "r"; return this; }
    private Node Value { get { trace += "g"; return stored; } }
    private Node Read() { trace += "c"; return stored; }
    private static int Before() { trace += "b"; return 1; }
    private static int After() { trace += "a"; return 2; }
    private static string Sink(int first, Node value, int last = 0) {
        GC.KeepAlive(value);
        trace += "s";
        return "forwarded";
    }
    private string Use() => Sink(Before(), value: ORIGIN, last: After());
    public static void Main() => Console.Write(new Holder(null!).Use() + "|" + trace);
}
`.Replace("ORIGIN", origin)
        let expected = "forwarded|" + trace
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                Issue5581ExpandedParamsNullElementsTests.AssertSuccessfulTarget(directory, compiled, expected)
                Assert.Contains("init(value Node?)", printed)
                Assert.Contains("stored Node?", printed)
                Assert.DoesNotContain("!!", printed)
            },
            expected
        )
    }

    @Fact
    func WidenedOrigins_ForwardIntoReducedReceiverAndExpandedElements() {
        let source = `
#nullable enable
using System;
using System.Collections.Generic;
public class Node { }
public static class Extensions {
    public static string Observe(this Node value) => value == null ? "null" : "value";
}
public class Holder {
    private readonly Node stored;
    private readonly string text;
    public Holder(Node value, string text) { stored = value; this.text = text; }
    private Node Read() => stored;
    private string ReadText() => text;
    private static int Count(params Node[] values) => values.Length;
    private static int CountList(params List<string> values) => values.Count;
    private string Use() => Read().Observe() + "|" + Count(stored) + "|" + CountList(ReadText());
    public static void Main() => Console.Write(new Holder(null!, null!).Use());
}
`
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                Issue5581ExpandedParamsNullElementsTests.AssertSuccessfulTarget(directory, compiled, "null|1|1")
                Assert.Contains("stored Node?", printed)
                Assert.Contains("values ...Node?", printed)
                Assert.Contains("values ...List[string?]", printed)
                Assert.DoesNotContain("!!", printed)
            },
            "null|1|1"
        )
    }

    @Fact
    func EmittedReference_ConstructedInheritedOriginsKeepTheirDeclarationIdentity() {
        let source = `
#nullable enable
using System;
using Demo;
public static class Probe {
    private static string Sink(Node node) { GC.KeepAlive(node); return "forwarded"; }
    private static string Sink(int value) => "wrong";
    public static void Main() {
        var producer = new Producer<int>(null!);
        Console.Write(Sink(producer.Stored) + "|" + Sink(producer.Value) + "|" + Sink(producer.Read()));
    }
}
`
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                Issue5581ExpandedParamsNullElementsTests.AssertSuccessfulTarget(
                    directory,
                    compiled,
                    "forwarded|forwarded|forwarded",
                    Path.Combine(directory, "Library.dll")
                )
                Issue5581ExpandedParamsNullElementsTests.AssertStrictIl(Path.Combine(directory, "Library.dll"))
                Assert.Contains("Sink(node Node?)", printed)
                Assert.DoesNotContain("!!", printed)
            },
            "forwarded|forwarded|forwarded",
            `
#nullable enable
namespace Demo {
    public class Node { }
    public class Base<T> {
        public readonly Node Stored;
        public Base(Node value) { Stored = value; }
        public Node Value => Stored;
        public Node Read() => Stored;
    }
    public class Producer<T> : Base<T> {
        public Producer(Node value) : base(value) { }
    }
}
`,
            referenceTypeName: "Demo.Base`1",
            referenceMemberName: "Read"
        )
    }

    @Fact
    func UnsafeReadInReachedCallee_PinsTheOriginAndKeepsTheAuthoredNil() {
        let source = `
#nullable enable
using System;
public class Holder {
    private readonly string stored;
    public Holder(string value) { stored = value; }
    private string Value => stored;
    private static int Sink(string value) => int.Parse(value);
    private int Use() => Sink(Value);
    public static void Main() => Console.Write(new Holder(null!).Use());
}
`
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                AssertPinnedNil(directory, printed, compiled)
                Assert.DoesNotContain("string?", printed)
            }
        )
    }

    @Theory
    @InlineData("IsNullOrEmpty")
    @InlineData("IsNullOrWhiteSpace")
    func StringGuard_KeepsNilAwayFromEffectfulReceiverArguments(guardMethod string) {
        let source = `
#nullable enable
using System;
using System.IO;
public class Holder {
    private readonly string stored;
    public Holder(string value) { stored = value; }
    private static bool Sink(string value) {
        if (string.GUARD(value) || !value.EndsWith(".g.gs", StringComparison.Ordinal)) {
            return false;
        }
        return value.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Length > 0;
    }
    private bool Use() => Sink(stored);
    public static void Main() => Console.Write(new Holder(null!).Use());
}
`.Replace("GUARD", guardMethod)
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                Issue5581ExpandedParamsNullElementsTests.AssertSuccessfulTarget(directory, compiled, "False")
                Assert.Contains("Sink(value string?)", printed)
            },
            "False"
        )
    }

    @Fact
    func SameNamedUserMethod_DoesNotProveAStringGuard() {
        let source = `
#nullable enable
using System;
public static class Guards {
    public static bool IsNullOrEmpty(string? value) => false;
}
public class Holder {
    private readonly string stored;
    private static string trace = "";
    public Holder(string value) { stored = value; }
    private static int Argument() { trace += "a"; return 1; }
    private static void Sink(string value) {
        if (Guards.IsNullOrEmpty(value)) { return; }
        GC.KeepAlive(value.PadLeft(Argument()));
    }
    private void Use() => Sink(stored);
    public static void Main() {
        try { new Holder(null!).Use(); }
        catch (NullReferenceException) { Console.Write(trace); }
    }
}
`
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                AssertPinnedNil(directory, printed, compiled)
            },
            "a"
        )
    }

    @Fact
    func UserEquality_DoesNotProveAnEffectfulReceiverNonNull() {
        let source = `
#nullable enable
using System;
public class Node {
    public static bool operator ==(Node? left, Node? right) => false;
    public static bool operator !=(Node? left, Node? right) => true;
    public override bool Equals(object? other) => ReferenceEquals(this, other);
    public override int GetHashCode() => 0;
    public void Touch(int value) { }
}
public class Holder {
    private readonly Node stored;
    private static string trace = "";
    public Holder(Node value) { stored = value; }
    private static int Argument() { trace += "a"; return 1; }
    private static void Sink(Node value) {
        trace += "s";
        if (value != null && true) { value.Touch(Argument()); }
    }
    private void Use() => Sink(stored);
    public static void Main() {
        try { new Holder(null!).Use(); }
        catch (NullReferenceException) { Console.Write(trace); }
    }
}
`
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                AssertPinnedNil(directory, printed, compiled)
            },
            "sa"
        )
    }

    @Theory
    @InlineData("Node", "value.Touch(Argument());", false)
    @InlineData("Node", "GC.KeepAlive(value[Argument()]);", false)
    @InlineData("Node", "value.Value = Argument();", false)
    @InlineData("Node[]", "GC.KeepAlive(value[Argument()]);", false)
    @InlineData("Node", "value.Convert(1);", false)
    @InlineData("Node", "value.Touch(1);", true)
    @InlineData("Node", "GC.KeepAlive(value[0]);", true)
    @InlineData("Node", "value.Value = 1;", true)
    @InlineData("Node[]", "GC.KeepAlive(value[0]);", true)
    func DereferenceReadProof_PreservesEffectsOrPinsTheOrigin(payload string, body string, acceptsNil bool) {
        let source = `
#nullable enable
using System;
public class Node {
    public int Value;
    public void Touch(int value) { }
    public void Convert(Token value) { }
    public int this[int index] => index;
}
public class Token {
    public static implicit operator Token(int value) { Holder.Argument(); return new Token(); }
}
public class Holder {
    private readonly PAYLOAD stored;
    private static string trace = "";
    public Holder(PAYLOAD value) { stored = value; }
    public static int Argument() { trace += "a"; return 1; }
    private static void Sink(PAYLOAD value) { trace += "s"; BODY }
    private void Use() => Sink(stored);
    public static void Main() {
        try { new Holder(null!).Use(); }
        catch (NullReferenceException) { Console.Write(trace); }
    }
}
`.Replace("PAYLOAD", payload).Replace("BODY", body)
        Issue5581ExpandedParamsNullElementsTests.WithTranslation(
            source,
            (directory string, printed string, compiled ProcessRunResult) -> {
                if acceptsNil {
                    Issue5581ExpandedParamsNullElementsTests.AssertSuccessfulTarget(directory, compiled, "s")
                } else {
                    AssertPinnedNil(directory, printed, compiled)
                }
            },
            if acceptsNil {
                "s"
            } else {
                "sa"
            }
        )
    }

    shared {
        private func AssertPinnedNil(directory string, printed string, compiled ProcessRunResult) {
            Assert.False(compiled.TimedOut, compiled.Output)
            Assert.NotEqual(0, compiled.ExitCode)
            Assert.False(File.Exists(Path.Combine(directory, "Target.dll")))
            let call = printed.IndexOf("Holder(nil)", StringComparison.Ordinal)
            Assert.True(call >= 0, printed)
            let offset = call + "Holder(".Length
            let before = printed.Substring(0, offset)
            let line = before.Count((value char) -> value == '\n') + 1
            let column = offset - before.LastIndexOf('\n')
            let errors = Regex
                .Matches(compiled.Output, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`)
                .Select(
                (match_ Match) -> string.Join(
                    ",",
                    Enumerable.Range(1, 5).Select((index int32) -> match_.Groups[index].Value)
                )
            )
                .ToArray()
            Assert.NotEmpty(errors)
            Assert.Equal([]string{"$line,$column,$line,${column + 3},GS0154"}, errors)
        }
    }
}
