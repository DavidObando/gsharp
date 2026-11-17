package GSharp.Compiler.Tests

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue6055SymbolicArgumentApplicabilityTests {
    @Fact
    func ClosedSourceArguments_UseSymbolicConversionsAcrossErasureSurrogates() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource, "Contract6055")
        let dll = fixture.Compile(`import System
import System.Collections.Generic
import Contracts6055
internal enum Failure { Suspension, NestedClosure }
class Values : Dictionary[string, Failure] {}
func ReadNullable(values Values?) int32 -> Sink[Failure].Read(values)
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
Console.WriteLine(Exact[Failure](state.Failures).Count)
Console.WriteLine(Sink[Failure].Read(nil))
Console.WriteLine(ReadNullable(nil))
Console.WriteLine(ReadNullable(Values()))
var optional Failure? = Failure.Suspension
Console.WriteLine(Sink[Failure].Read(optional))
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
class Values : Dictionary<string, Failure> {}
class State {
    public Dictionary<string, Failure> Failures { get; } = new(StringComparer.Ordinal);
    public int Reads;
    public Dictionary<string, Failure> Snapshot { get { Reads++; return Failures; } }
}
class P {
    static int ReadNullable(Values? values) => Sink<Failure>.Read(values);
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
        Console.WriteLine(new Exact<Failure>(state.Failures).Count);
        Console.WriteLine(Sink<Failure>.Read(null));
        Console.WriteLine(ReadNullable(null));
        Console.WriteLine(ReadNullable(new Values()));
        Failure? optional = Failure.Suspension;
        Console.WriteLine(Sink<Failure>.Read(optional));
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
}
public sealed class Exact<T> {
    public Exact(Dictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Exact(params Dictionary<string, T>[] values) { Count = values.Length; }
    public int Count { get; }
}`, "Native6055")
        IlVerifier.Verify(native)
        File.Copy(Path.ChangeExtension(dll, ".runtimeconfig.json"), Path.ChangeExtension(native, ".runtimeconfig.json"))
        let expected = Encoding.UTF8.GetBytes(
            "0\nTrue\nTrue\n1\n1\n1\n1\n1\n1\n99\n99\n0\n-1\nTrue\n1\n0\n".Replace("\n", Environment.NewLine)
        )
        Assert.Equal(expected, fixture.RunBytes(native))
        Assert.Equal(expected, fixture.RunBytes(dll))
        for target in[]string{"Other", "object", "int32"} {
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
            AssertNativeRejects(
                "Dictionary<string, " +
                    (
                    if target == "int32" {
                        "int"
                    } else {
                        target
                    }
                ) +
                    ">",
                "new State().Values, StringComparer.Ordinal",
                contract
            )
        }
    }

    @Theory
    @InlineData("State().Values")
    @InlineData("State().Values, State().Values")
    func ErasedClrIdentity_DoesNotAdmitInvariantArguments(arguments string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource, "Contract6056")
        let (code, diagnostics) = fixture.TryCompile(`import Contracts6055
import System.Collections.Generic
enum Failure { Suspension }
class State {
    init() { Values = Dictionary[string, Failure]() }
    prop Values Dictionary[string, Failure] { get; }
}
let copy = Exact[int32](ARGUMENTS)
`.Replace("ARGUMENTS", arguments), "Reject6056", executable: true, "/r:" + contract)
        Assert.True(code != 0, diagnostics)
        Assert.Contains("Reject6056.gs(8,12,8,17): error GS0267", diagnostics)
        AssertNativeRejects("Exact<int>", arguments.Replace("State()", "new State()"), contract)
    }

    shared {
        private func AssertNativeRejects(target string, arguments string, contract string) {
            let source = `using System;
using System.Collections.Generic;
using Contracts6055;
enum Failure { Suspension }
enum Other { Suspension }
class State {
    public Dictionary<string, Failure> Values { get; } = new();
}
class Check { static void Main() { var copy = new TARGET(ARGUMENTS); } }
`.Replace("TARGET", target).Replace("ARGUMENTS", arguments)
            let references = cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
                .Split(Path.PathSeparator)
                .Append(contract)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
            let compilation = CSharpCompilation.Create(
                "NativeRejected6056",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.ConsoleApplication)
            )
            let errors = compilation
                .GetDiagnostics()
                .Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
                .ToArray()
            Assert.NotEmpty(errors)
            Assert.All(errors, (diagnostic Diagnostic) -> Assert.Equal("CS1503", diagnostic.Id))
        }

        private const ContractSource string = `using System.Collections.Generic;
namespace Contracts6055;
public sealed class Sink<T> {
    public Sink(IDictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Sink(object? values) { Count = -1; }
    public int Count { get; }
    public static int Read(IDictionary<string, T>? values) => values?.Count ?? 99;
    public static int Read(object? values) => -1;
    public static void Clear(ref Dictionary<string, T> values) => values.Clear();
}
public sealed class Exact<T> {
    public Exact(Dictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Exact(params Dictionary<string, T>[] values) { Count = values.Length; }
    public int Count { get; }
}`
    }
}
