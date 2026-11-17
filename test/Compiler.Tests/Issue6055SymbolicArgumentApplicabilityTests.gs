package GSharp.Compiler.Tests

import System
import System.IO
import System.Text
import Xunit

class Issue6055SymbolicArgumentApplicabilityTests {
    @Fact
    func ClosedSourceArguments_UseSymbolicConversionsAcrossErasureSurrogates() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`using System.Collections.Generic;
namespace Contracts6055;
public sealed class Sink<T> {
    public Sink(IDictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Sink(object? values) { Count = -1; }
    public int Count { get; }
    public static int Read(IDictionary<string, T>? values) => values?.Count ?? 99;
    public static int Read(object? values) => -1;
    public static void Clear(ref Dictionary<string, T> values) => values.Clear();
}`, "Contract6055")
        let dll = fixture.Compile(`import System
import System.Collections.Generic
import Contracts6055
internal enum Failure { Suspension, NestedClosure }
class State {
    init() { Failures = Dictionary[string, Failure](StringComparer.Ordinal) }
    prop Failures Dictionary[string, Failure] { get; }
    var Reads int32
    prop Snapshot Dictionary[string, Failure] {
        get {
            Reads++
            return Failures
        }
    }
}
let state = State()
let empty = Dictionary[string, Failure](state.Failures, StringComparer.Ordinal)
Console.WriteLine(empty.Count)
state.Failures.Add("failure", Failure.NestedClosure)
let copy = Dictionary[string, Failure](state.Snapshot, StringComparer.Ordinal)
let local = Dictionary[string, Failure](StringComparer.Ordinal)
local.Add("failure", Failure.Suspension)
let localCopy = Dictionary[string, Failure](local, StringComparer.Ordinal)
Console.WriteLine(copy["failure"] == Failure.NestedClosure)
Console.WriteLine(localCopy["failure"] == Failure.Suspension)
Console.WriteLine(state.Reads)
Console.WriteLine(Sink[Failure](state.Failures).Count)
Console.WriteLine(Sink[Failure].Read(state.Failures))
Console.WriteLine(Sink[Failure](local).Count)
Console.WriteLine(Sink[Failure].Read(local))
Console.WriteLine(Sink[Failure].Read(nil))
Console.WriteLine(object.ReferenceEquals(copy.Comparer, StringComparer.Ordinal))
copy.Clear()
Console.WriteLine(state.Failures.Count)
var writable Dictionary[string, Failure] = state.Failures
Sink[Failure].Clear(&writable)
Console.WriteLine(state.Failures.Count)
`, "Source6055", executable: true, "/r:" + contract)
        IlVerifier.Verify(dll, []string{contract})
        let native = fixture.CompileCSharpExecutable(`using System;
using System.Collections.Generic;
internal enum Failure { Suspension, NestedClosure }
class State {
    public Dictionary<string, Failure> Failures { get; } = new(StringComparer.Ordinal);
    public int Reads;
    public Dictionary<string, Failure> Snapshot { get { Reads++; return Failures; } }
}
class P {
    static void Main() {
        var state = new State();
        var empty = new Dictionary<string, Failure>(state.Failures, StringComparer.Ordinal);
        Console.WriteLine(empty.Count);
        state.Failures.Add("failure", Failure.NestedClosure);
        var copy = new Dictionary<string, Failure>(state.Snapshot, StringComparer.Ordinal);
        var local = new Dictionary<string, Failure>(StringComparer.Ordinal);
        local.Add("failure", Failure.Suspension);
        var localCopy = new Dictionary<string, Failure>(local, StringComparer.Ordinal);
        Console.WriteLine(copy["failure"] == Failure.NestedClosure);
        Console.WriteLine(localCopy["failure"] == Failure.Suspension);
        Console.WriteLine(state.Reads);
        Console.WriteLine(new Sink<Failure>(state.Failures).Count);
        Console.WriteLine(Sink<Failure>.Read(state.Failures));
        Console.WriteLine(new Sink<Failure>(local).Count);
        Console.WriteLine(Sink<Failure>.Read(local));
        Console.WriteLine(Sink<Failure>.Read(null));
        Console.WriteLine(ReferenceEquals(copy.Comparer, StringComparer.Ordinal));
        copy.Clear();
        Console.WriteLine(state.Failures.Count);
        Dictionary<string, Failure> writable = state.Failures;
        Sink<Failure>.Clear(ref writable);
        Console.WriteLine(state.Failures.Count);
    }
}
public sealed class Sink<T> {
    public Sink(IDictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Sink(object? values) { Count = -1; }
    public int Count { get; }
    public static int Read(IDictionary<string, T>? values) => values?.Count ?? 99;
    public static int Read(object? values) => -1;
    public static void Clear(ref Dictionary<string, T> values) => values.Clear();
}`, "Native6055")
        IlVerifier.Verify(native)
        File.Copy(Path.ChangeExtension(dll, ".runtimeconfig.json"), Path.ChangeExtension(native, ".runtimeconfig.json"))
        let expected = Encoding.UTF8.GetBytes(
            "0\nTrue\nTrue\n1\n1\n1\n1\n1\n99\nTrue\n1\n0\n".Replace("\n", Environment.NewLine)
        )
        Assert.Equal(expected, fixture.RunBytes(native))
        Assert.Equal(expected, fixture.RunBytes(dll))
        for target in[]string{"Other", "object"} {
            let (code, diagnostics) = fixture.TryCompile(`import System
import System.Collections.Generic
enum Failure { Suspension }
enum Other { Suspension }
class State {
    init() { Values = Dictionary[string, Failure]() }
    prop Values Dictionary[string, Failure] { get; }
}
let copy = Dictionary[string, TARGET](State().Values, StringComparer.Ordinal)
`.Replace("TARGET", target), "Reject6055", executable: true)
            Assert.True(code != 0, target + ": " + diagnostics)
            Assert.Contains("Reject6055.gs(9,12,9,22): error GS0267", diagnostics)
        }
    }
}
