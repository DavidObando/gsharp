// <copyright file="Issue5273GenericCallbackInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.IO
import System.Linq
import Xunit

class Issue5273GenericCallbackInferenceTests {
    @Theory
    @InlineData("DispatchProbe().Read()")
    @InlineData("Free(CALLBACK)")
    @InlineData("DispatchProbe().Invoke(CALLBACK)")
    @InlineData("DispatchProbe.StaticInvoke(CALLBACK)")
    @InlineData("int32(0).InvokeExtension(CALLBACK)")
    func NestedGenericLambdaReturnKeepsItsTypeAndRunsOnce(invocation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let call = invocation.Replace(
            "CALLBACK",
            "() -> Task.FromResult(Uri(DispatchProbe.Next()))",
            StringComparison.Ordinal
        )
        let reader = if invocation == "DispatchProbe().Read()" {
            `public func Read() Task[Uri] {
        let result = Main(() -> Task.FromResult(Uri(DispatchProbe.Next())))
        return result
    }`
        } else {
            string.Empty
        }
        let source = (`package Callback5273
import System
import System.Threading.Tasks
func Free[T](call Func[T]) T -> call()
func (self int32) InvokeExtension[T](call Func[T]) T -> call()
class DispatchProbe {
    private func Main[T](call Func[T]) T -> call()
    ` + reader + `
    public func Invoke[T](call Func[T]) T -> call()
    shared {
        public var Calls int32 = 0
        public func Next() string {
            Calls += 1
            return "content://org.goo.probe/document"
        }
        public func StaticInvoke[T](call Func[T]) T -> call()
    }
}
func Main() {
    let result = ` + call + `
    let typed Task[Uri] = result
    Console.WriteLine(typed.Result.AbsoluteUri)
    Console.WriteLine(DispatchProbe.Calls)
}`)
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let dll = fixture.Compile(source, "Callback5273", true, references)
        IlVerifier.Verify(dll)
        Assert.Equal("content://org.goo.probe/document\n1\n", fixture.Run(dll))
    }

    @Fact
    func NamedDelegateInfersThroughItsNestedReturnSignature() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`using System;
namespace Contracts5273;
public delegate Tuple<T> Factory<T>(int value);`, "Contracts5273")
        let references = ReferenceClosure
            .RefPackAssemblies()
            .Select((path string) -> "/r:" + path)
            .Append("/r:" + library)
            .ToArray()
        let dll = fixture.Compile(`package NamedCallback5273
import System
import Contracts5273
func Create[T](factory Factory[T]) T -> factory(42).Item1
func Main() {
    let result = Create((value int32) -> Tuple.Create(Uri("content://org.goo.probe/" + value.ToString())))
    let typed Uri = result
    Console.WriteLine(typed.AbsoluteUri)
}`, "NamedCallback5273", true, references)
        IlVerifier.Verify(dll, []string{library})
        Assert.Equal("content://org.goo.probe/42\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("[]T", "[]string{\"str\"}", "5,15,5,30")
    @InlineData("[1]T", "[1]string{\"str\"}", "5,15,5,31")
    @InlineData("List[T]", "List[string]()", "5,15,5,29")
    func ConflictingExactEvidenceRetainsTheEarlierArgumentContract(
        laterType string,
        laterArgument string,
        location string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let source = "package ConflictingBounds5273\nimport System.Collections.Generic\nfunc Show[T](source T, later " +
            laterType +
            ") { }\nfunc Main() {\n    Show(131, " +
            laterArgument +
            ")\n}"
        let (code, output) = fixture.TryCompile(source, "ConflictingBounds5273", true, references)
        Assert.NotEqual(0, code)
        Assert.True(
            output.Contains("ConflictingBounds5273.gs(" + location + "): error GS0154:", StringComparison.Ordinal),
            output
        )
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "ConflictingBounds5273.dll")))
    }

    @Theory
    @InlineData("Func[T, bool]", false)
    @InlineData("Func[T, bool]", true)
    @InlineData("(T) -> bool", false)
    @InlineData("(T) -> bool", true)
    func CallbackInputsDoNotWidenValueOrOutputEvidence(callbackType string, callbackFirst bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let parameters = if callbackFirst {
            "predicate " + callbackType + ", value T"
        } else {
            "value T, predicate " + callbackType
        }
        let arguments = if callbackFirst {
            "(value Base) -> Probe.Accept(value), Derived()"
        } else {
            "Derived(), (value Base) -> Probe.Accept(value)"
        }
        let source = (`package CallbackBounds5273
import System
open class Base { }
class Derived : Base {
    public func Tag() string -> "derived"
}
class Probe {
    shared {
        public var Calls int32 = 0
        public func Accept(value Base) bool {
            Calls += 1
            return true
        }
    }
}
func Keep[T](` + parameters + `) T {
    if !predicate(value) { throw Exception("rejected") }
    return value
}
func FromOutput[T](predicate ` + callbackType + `, factory Func[T]) T -> factory()
func FromInput[T](predicate ` + callbackType + `) string -> typeof(T).Name
func FromInputs[T](first ` + callbackType + `, second ` + callbackType + `) string -> typeof(T).Name
func FromNestedInput[T](value T, predicate Func[Func[T, bool], bool]) string -> typeof(T).Name
func Join[T](first T, second T) T -> second
func Main() {
    let derived Derived = Keep(` + arguments + `)
    Console.WriteLine(derived.Tag())
    Console.WriteLine(Probe.Calls)
    let output Derived = FromOutput((value Base) -> true, () -> Derived())
    Console.WriteLine(output.Tag())
    Console.WriteLine(FromInput((value Base) -> true))
    Console.WriteLine(FromInputs((value Base) -> true, (value Derived) -> true))
    Console.WriteLine(FromNestedInput(Derived(), (predicate Func[Base, bool]) -> true))
    let joined Base = Join(Derived(), Base())
    Console.WriteLine(joined.GetType().Name)
}`)
        let dll = fixture.Compile(source, "CallbackBounds5273", true, references)
        IlVerifier.Verify(dll)
        Assert.Equal("derived\n1\nderived\nBase\nDerived\nBase\nBase\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("Host[Base].Accept(List[Derived](), 0)", "16,23,16,38")
    @InlineData("Host[Base]().AcceptInstance(List[Derived](), 0)", "16,33,16,48")
    @InlineData("Host[Derived].AcceptValue(Base(), 0)", "16,31,16,37")
    @InlineData("Host[Derived]().AcceptValueInstance(Base(), 0)", "16,41,16,47")
    func MethodInferenceCannotReplaceFixedOwnerArguments(invocation string, location string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let declarations = `package FixedOwner5273
import System
import System.Collections.Generic
open class Base { }
class Derived : Base { }
class Host[T] {
    shared {
        public func Accept[U](items List[T], marker U) U -> marker
        public func AcceptValue[U](value T, marker U) U -> marker
        public func Shadow[T](value T) T -> value
    }
    public func AcceptInstance[U](items List[T], marker U) U -> marker
    public func AcceptValueInstance[U](value T, marker U) U -> marker
}`
        let source = declarations + "\nfunc Main() {\n    " + invocation + "\n}"
        let (code, output) = fixture.TryCompile(source, "FixedOwner5273", true, references)
        Assert.NotEqual(0, code)
        Assert.True(
            output.Contains("FixedOwner5273.gs(" + location + "): error GS0154:", StringComparison.Ordinal),
            output
        )
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "FixedOwner5273.dll")))
        let dll = fixture.Compile(declarations + `
func Main() {
    let first string = Host[Base].Accept(List[Base](), "static")
    let second int32 = Host[Derived]().AcceptInstance(List[Derived](), 17)
    let third string = Host[Base].Shadow("distinct")
    let fourth string = Host[Base]().AcceptValueInstance(Derived(), "derived")
    Console.WriteLine(first)
    Console.WriteLine(second)
    Console.WriteLine(third)
    Console.WriteLine(fourth)
}`, "FixedOwnerControls5273", true, references)
        IlVerifier.Verify(dll)
        Assert.Equal("static\n17\ndistinct\nderived\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("[]T", false)
    @InlineData("[]T", true)
    @InlineData("[1]T", false)
    @InlineData("[1]T", true)
    @InlineData("chan[T]", false)
    @InlineData("chan[T]", true)
    @InlineData("[,]T", false)
    @InlineData("[,]T", true)
    func InvariantCallbackElementsSupplyExactBounds(container string, callbackFirst bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let concrete = container.Replace("T", "Base", StringComparison.Ordinal)
        let callback = "predicate (" + container + ") -> bool"
        let parameters = if callbackFirst {
            callback + ", value T"
        } else {
            "value T, " + callback
        }
        let arguments = if callbackFirst {
            "predicate, Derived()"
        } else {
            "Derived(), predicate"
        }
        let source = (`package InvariantCallback5273
import System
open class Base { }
class Derived : Base { }
func Keep[T](` + parameters + `) T {
    Console.WriteLine(typeof(T).Name)
    return value
}
func FromInput[T](` + callback + `) string -> typeof(T).Name
func Main() {
    let predicate (` + concrete + `) -> bool = (items ` + concrete + `) -> true
    let result = Keep(` + arguments + `)
    Console.WriteLine(result.GetType().Name)
    Console.WriteLine(FromInput(predicate))
}`)
        let dll = fixture.Compile(source, "InvariantCallback5273", true, references)
        IlVerifier.Verify(dll)
        Assert.Equal("Base\nDerived\nBase\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("Func[T]")
    @InlineData("() -> T")
    func ThrowOnlyCallbackWithoutTypeEvidenceReportsInferenceFailure(callbackType string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let source = (`package RejectNever5273
import System
func Invoke[T](callback ` + callbackType + `) int32 -> 0
func Main() {
    Invoke(() -> throw Exception())
}`)
        let (code, output) = fixture.TryCompile(source, "RejectNever5273", true, references)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("RejectNever5273.gs(5,5,5,11): error GS0151:", StringComparison.Ordinal), output)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectNever5273.dll")))
    }

    @Fact
    func ThrowOnlyCallbackKeepsOtherSignatureEvidenceAndExplicitContext() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let dll = fixture.Compile(`package ContextualNever5273
import System
func FromInput[T](callback Func[T, T]) int32 -> 7
func Seeded[T](callback Func[T], value T) T -> callback()
func Main() {
    Console.WriteLine(FromInput((value int32) -> throw Exception("unused")))
    try {
        Seeded(() -> throw Exception("inferred"), 42)
    } catch (ex Exception) {
        Console.WriteLine(ex.Message)
    }
    try {
        Seeded[int32](() -> throw Exception("explicit"), 43)
    } catch (ex Exception) {
        Console.WriteLine(ex.Message)
    }
}`, "ContextualNever5273", true, references)
        IlVerifier.Verify(dll)
        Assert.Equal("7\ninferred\nexplicit\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("() -> throw Exception()")
    @InlineData("() -> (() -> throw Exception())")
    @InlineData("(1, () -> throw Exception())")
    func NestedThrowOnlyCallbackWithoutTypeEvidenceReportsInferenceFailure(result string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let source = (`package RejectNestedNever5273
import System
func Invoke[T](callback Func[T]) int32 -> 0
func Main() {
    Invoke(() -> ` + result + `)
}`)
        let (code, output) = fixture.TryCompile(source, "RejectNestedNever5273", true, references)
        Assert.NotEqual(0, code)
        Assert.True(
            output.Contains("RejectNestedNever5273.gs(5,5,5,11): error GS0151:", StringComparison.Ordinal),
            output
        )
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectNestedNever5273.dll")))
    }

    @Fact
    func NestedThrowOnlyCallbackKeepsUsefulEvidenceAndLegalVoidReturns() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceClosure.RefPackAssemblies().Select((path string) -> "/r:" + path).ToArray()
        let dll = fixture.Compile(`package ContextualNestedNever5273
import System
import System.Threading.Tasks
func FromInput[T](callback Func[T, T]) int32 -> 7
func Seeded[T](callback Func[T], value T) T -> callback()
func Identity[T](value T) T -> value
func Main() {
    Console.WriteLine(FromInput((value Func[int32]) -> (() -> throw Exception("unused"))))
    let inferred = Seeded(() -> (() -> throw Exception("inferred")), () -> 42)
    try {
        inferred()
    } catch (ex Exception) {
        Console.WriteLine(ex.Message)
    }
    let explicit = Seeded[Func[int32]](() -> (() -> throw Exception("explicit")), () -> 43)
    try {
        explicit()
    } catch (ex Exception) {
        Console.WriteLine(ex.Message)
    }
    let action = Identity(() -> Console.WriteLine("void"))
    action()
    let task = Identity(Task.FromResult(() -> throw Exception("task")))
    try {
        task.Result()
    } catch (ex Exception) {
        Console.WriteLine(ex.Message)
    }
}`, "ContextualNestedNever5273", true, references)
        IlVerifier.Verify(dll)
        Assert.Equal("7\ninferred\nexplicit\nvoid\ntask\n", fixture.Run(dll))
    }
}
