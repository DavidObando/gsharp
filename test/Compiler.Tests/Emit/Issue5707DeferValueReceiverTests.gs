// <copyright file="Issue5707DeferValueReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

class Issue5707DeferValueReceiverTests {
    @Fact
    func Fields_PreserveStorageAndCaptureReferenceOwnersEagerly() {
        AssertRuns(`import System
import System.Runtime.CompilerServices
struct Counter {
    var n int32
    func Bump() { n++ }
}
struct Outer { var inner Counter }
class Host {
    var counter Counter
    var outer Outer
    var pair (Counter, int32)
    func Deferred() { defer counter.Bump() }
}
func Run() {
    let original = Host()
    let other = Host()
    var host = original
    {
        defer host.counter.Bump()
        defer host.outer.inner.Bump()
        defer host.pair.Item1.Bump()
        host = other
        original.counter.n = 10
    }
    original.Deferred()
    Console.WriteLine(original.counter.n)
    Console.WriteLine(original.outer.inner.n)
    Console.WriteLine(original.pair.Item1.n)
    Console.WriteLine(other.counter.n + other.outer.inner.n + other.pair.Item1.n)
    let box = StrongBox[Counter]()
    { defer box.Value.Bump() }
    Console.WriteLine(box.Value.n)
}
Run()`, "12\n1\n1\n0\n1\n")
    }

    @Fact
    func ArrayElements_CaptureArrayAndIndexBeforeArgumentsAndProbeEagerly() {
        AssertRuns(`import System
struct Counter {
    var n int32
    func Bump(amount int32) { n += amount }
}
struct Outer { var inner Counter }
func Amount() int32 {
    Console.WriteLine("argument")
    return 3
}
func Run() {
    let original = []Outer{Outer{}, Outer{}}
    var arr = original
    var i = 0
    {
        defer arr[i].inner.Bump(Amount())
        arr = []Outer{Outer{}, Outer{}}
        i = 1
        original[0].inner.n = 10
        Console.WriteLine("body")
    }
    Console.WriteLine(original[0].inner.n)
    Console.WriteLine(original[1].inner.n)
    Console.WriteLine(arr[0].inner.n + arr[1].inner.n)
    try {
        defer original[9].inner.Bump(Amount())
        Console.WriteLine("unreachable")
    } catch (IndexOutOfRangeException) {
        Console.WriteLine("bad index")
    }
}
Run()`, "argument\nbody\n13\n0\n0\nbad index\n")
    }

    @Fact
    func Variables_KeepLocalParameterRefAndStaticStorage() {
        AssertRuns(`import System
struct Counter {
    var n int32
    func Bump() { n++ }
}
class Host {
    shared { var counter Counter }
}
func ByRef(ref counter Counter) { defer counter.Bump() }
func ByValue(counter Counter) int32 {
    { defer counter.Bump() }
    return counter.n
}
func Run() {
    var c = Counter{}
    let read = func() int32 { return c.n }
    {
        defer c.Bump()
        c.n = 10
    }
    Console.WriteLine(read())
    ByRef(ref c)
    Console.WriteLine(c.n)
    Console.WriteLine(ByValue(c))
    let items = []Counter{Counter{}}
    let ref alias = items[0]
    { defer alias.Bump() }
    Console.WriteLine(items[0].n)
    {
        defer global.Bump()
        defer Host.counter.Bump()
    }
    Console.WriteLine(global.n)
    Console.WriteLine(Host.counter.n)
}
var global Counter
Run()`, "11\n12\n13\n1\n1\n1\n")
    }

    @Fact
    func GenericStorage_SnapshotsReferenceInstantiationsButNotValueInstantiations() {
        AssertRuns(`import System
interface ICounter { func Bump(); }
struct Counter : ICounter {
    var n int32
    func Bump() { n++ }
}
class RefCounter : ICounter {
    var n int32
    func Bump() { n++ }
}
func Run[T ICounter](ref value T, replacement T) {
    defer value.Bump()
    value = replacement
}
func Test() {
    var value = Counter{}
    Run[Counter](ref value, Counter{n: 10})
    Console.WriteLine(value.n)
    let original = RefCounter()
    let other = RefCounter()
    var reference = original
    Run[RefCounter](ref reference, other)
    Console.WriteLine(original.n)
    Console.WriteLine(other.n)
}
Test()`, "11\n1\n0\n")
    }

    @Fact
    func RvalueAndReferenceReceivers_StillEvaluateEagerly() {
        AssertRuns(`import System
struct Counter {
    var n int32
    func Bump() {
        n++
        Console.WriteLine(n)
    }
}
class Host {
    var n int32
    func Bump() {
        n++
        Console.WriteLine(n)
    }
}
func Make() Counter {
    Console.WriteLine("make")
    return Counter{n: 3}
}
func Run() {
    let first = Host()
    var host = first
    var counter = Counter{n: 20}
    {
        defer Make().Bump()
        defer host.Bump()
        defer ({ counter }).Bump()
        counter.n = 30
        host = Host{n: 10}
        Console.WriteLine("body")
    }
    Console.WriteLine(first.n)
    Console.WriteLine(host.n)
    Console.WriteLine(counter.n)
}
Run()`, "make\nbody\n21\n1\n4\n1\n10\n30\n")
    }

    @Fact
    func RefReturnsConditionalAddressesAndBlockReceivers_KeepSelectedStorage() {
        AssertRuns(`import System
struct Counter {
    var n int32
    func Bump() { n++ }
}
class Host { var counter Counter }
func Get(h Host) ref Counter {
    Console.WriteLine("ref")
    return ref h.counter
}
func Run() {
    let first = Host()
    let other = Host()
    var choose = true
    var index = 0
    let items = []Counter{Counter{}, Counter{}}
    {
        defer Get(first).Bump()
        defer (*&(choose ? first.counter : other.counter)).Bump()
        defer items[^1].Bump()
        defer items[{
            Console.WriteLine("block")
            index
        }].Bump()
        choose = false
        index = 1
    }
    Console.WriteLine(first.counter.n)
    Console.WriteLine(other.counter.n)
    Console.WriteLine(items[0].n)
    Console.WriteLine(items[1].n)
}
Run()`, "ref\nblock\n2\n0\n1\n1\n")
    }

    @Fact
    func Narrowing_StorageCaptureHasOnlyOperandEffects() {
        AssertRuns(`import System
interface ICounter { func Bump(); }
struct Counter : ICounter {
    var n int32
    func Bump() {
        n++
        text = nil
    }
}
func Run[T ICounter](ref value T) int32 {
    if text == nil { return 0 }
    defer value.Bump()
    return text.Length
}
var text string? = "abc"
var counter Counter
Console.WriteLine(Run[Counter](ref counter))
Console.WriteLine(counter.n)
Console.WriteLine(text == nil)`, "3\n1\nTrue\n")
    }

    @Fact
    func AsyncAndIteratorCleanups_KeepStorageAcrossSuspension() {
        AssertRuns(`import System
import System.Threading.Tasks
struct Counter {
    var n int32
    func Bump() { n++ }
}
class Host { var counter Counter }
async func RunAsync(h Host) Task {
    defer h.counter.Bump()
    var local = Counter{}
    {
        defer local.Bump()
        await Task.Delay(1)
    }
    Console.WriteLine(local.n)
}
func Iterate(h Host) sequence[int32] {
    defer h.counter.Bump()
    yield 1
}
let host = Host()
RunAsync(host).GetAwaiter().GetResult()
for value in Iterate(host) { Console.WriteLine(value) }
Console.WriteLine(host.counter.n)`, "1\n1\n2\n")
    }

    @Fact
    func NarrowedBoxes_CaptureTheSelectedReferenceNotTheMutableSlot() {
        AssertRuns(`import System
struct Counter {
    var n int32
    func Bump() { n++ }
}
class Box {
    let value object
    init(value object) { this.value = value }
}
func Run(replacement object) {
    var value object = Counter{}
    let original = value
    if value is Counter {
        defer value.Bump()
        value = replacement
    }
    if original is Counter c { Console.WriteLine(c.n) }
    if replacement is Counter c { Console.WriteLine(c.n) }
}
Run("changed")
Run(Counter{n: 10})
let box = Box(Counter{})
if box.value is Counter {
    defer box.value.Bump()
}
if box.value is Counter c { Console.WriteLine(c.n) }`, "1\n1\n10\n1\n")
    }

    @Fact
    func BlockValues_WithRefReturningTailsStillCopyTheValue() {
        AssertRuns(`import System
struct Counter {
    var n int32
    func Bump() { n++ }
}
class Host { var counter Counter }
func Get(h Host) ref Counter { return ref h.counter }
func Run() {
    let host = Host()
    {
        defer ({ Get(host) }).Bump()
        host.counter.n = 10
    }
    Console.WriteLine(host.counter.n)
    { defer (*&({ Get(host) })).Bump() }
    Console.WriteLine(host.counter.n)
}
Run()`, "10\n11\n")
    }

    @Fact
    func ReadOnlyRefReturns_KeepNativeImportedAndGenericReferentsReadOnly() {
        AssertRuns(`import System
interface ICounter { func Bump(); }
struct Counter : ICounter {
    var n int32
    func Bump() { n++ }
}
class Host[T] { var value T }
func Read(h Host[Counter]) ref readonly Counter { return ref h.value }
func ReadGeneric[T](h Host[T]) ref readonly T { return ref h.value }
func Generic[T ICounter](h Host[T]) { defer ReadGeneric(h).Bump() }
func Run() {
    let host = Host[Counter]()
    { defer Read(host).Bump() }
    Generic(host)
    Console.WriteLine(host.value.n)
    let items = []Counter{Counter{n: 4}}
    let view = ReadOnlySpan[Counter](items)
    { defer view[0].Bump() }
    Console.WriteLine(items[0].n)
}
Run()`, "0\n4\n")
    }

    @Fact
    func GenericArrayReceivers_ProbeTheSelectedRuntimeKindWithoutBreakingCovariance() {
        AssertRuns(`import System
interface ICounter { func Bump(amount int32); }
class RefCounter : ICounter {
    var n int32
    func Bump(amount int32) { n += amount }
}
struct Counter : ICounter {
    var n int32
    func Bump(amount int32) { n += amount }
}
func Amount() int32 {
    Console.WriteLine("argument")
    return 2
}
func Run[T ICounter](items []T, index int32) {
    defer items[index].Bump(Amount())
    Console.WriteLine("body")
}
let original = []RefCounter{RefCounter()}
let covariant = cast[[]ICounter](original)
Run[ICounter](covariant, 0)
Console.WriteLine(original[0].n)
let values = []Counter{Counter{}}
Run[Counter](values, 0)
Console.WriteLine(values[0].n)
try {
    Run[ICounter](covariant, 9)
} catch (IndexOutOfRangeException) {
    Console.WriteLine("bad index")
}`, "argument\nbody\n2\nargument\nbody\n2\nbad index\n")
    }

    @Fact
    func GenericBoxViews_UseTypedAddressesForValueAndReferenceInstantiations() {
        AssertRuns(`import System
import System.Threading.Tasks
interface ICounter { func Bump(); }
struct Counter : ICounter {
    var n int32
    func Bump() { n++ }
}
class RefCounter : ICounter {
    var n int32
    func Bump() { n++ }
}
func Run[T ICounter](input object, replacement object) {
    var value = input
    if value is T {
        defer value.Bump()
        value = replacement
    }
}
func RunStruct[T ICounter struct](value object) {
    if value is T { defer value.Bump() }
}
async func RunAsync[T ICounter](value object) Task {
    if value is T {
        defer value.Bump()
        await Task.Delay(1)
    }
}
var boxed object = Counter{}
Run[Counter](boxed, "changed")
if boxed is Counter c { Console.WriteLine(c.n) }
RunStruct[Counter](boxed)
if boxed is Counter c { Console.WriteLine(c.n) }
RunAsync[Counter](boxed).GetAwaiter().GetResult()
if boxed is Counter c { Console.WriteLine(c.n) }
let original = RefCounter()
let other = RefCounter()
Run[RefCounter](original, other)
Console.WriteLine(original.n)
Console.WriteLine(other.n)`, "1\n2\n3\n1\n0\n")
    }

    @Fact
    func GenericLetBindings_KeepTheirShallowReferenceCapability() {
        AssertRuns(`import System
interface ICounter { func Bump(); }
struct Counter : ICounter {
    var n int32
    func Bump() { n++ }
}
class RefCounter : ICounter {
    var n int32
    func Bump() { n++ }
}
func Local[T ICounter](value T) T {
    let local = value
    { defer local.Bump() }
    return local
}
Console.WriteLine(Local[Counter](Counter{}).n)
Console.WriteLine(Local[RefCounter](RefCounter()).n)`, "1\n1\n")
    }

    @Fact
    func NullableBoxedReceivers_CaptureVariableAndSourceFieldReferences() {
        using let fixture = CSharpFixture(`#nullable enable
namespace Imported5707 {
    public struct Counter {
        public int n;
        public void Bump() { n++; }
    }
}`)
        AssertRuns(`import System
import Imported5707
class SourceBox {
    let value object?
    init(value object?) { this.value = value }
}
func Run(replacement object?) {
    var value object? = Counter()
    let original = value
    if value is Counter {
        defer value.Bump()
        value = replacement
    }
    if original is Counter c { Console.WriteLine(c.n) }
}
Run("changed")
Run(Counter())
Run(nil)
let source = SourceBox(Counter())
if source.value is Counter {
    defer source.value.Bump()
}
if source.value is Counter c { Console.WriteLine(c.n) }
`, "1\n1\n1\n1\n", fixture.AssemblyPath)
    }

    shared {
        private func AssertRuns(source string, expected string, references ...string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue5707", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let args = List[string]{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                for reference in references {
                    args.Add("/reference:" + reference)
                    File.Copy(reference, Path.Combine(directory, Path.GetFileName(reference)))
                }
                using let log = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                var exitCode int32
                Console.SetOut(log)
                Console.SetError(log)
                try {
                    exitCode = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.True(exitCode == 0, log.ToString())
                IlVerifier.Verify(assemblyPath, references)
                using let process = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {assemblyPath},
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                ) ??
                    throw InvalidOperationException("could not start dotnet")
                let output = process.StandardOutput.ReadToEndAsync()
                let error = process.StandardError.ReadToEndAsync()
                let exited = process.WaitForExit(30000)
                if !exited {
                    process.Kill(entireProcessTree: true)
                    process.WaitForExit()
                }
                Assert.True(exited, "emitted program timed out")
                Assert.True(process.ExitCode == 0, error.GetAwaiter().GetResult())
                Assert.Equal(expected, output.GetAwaiter().GetResult().ReplaceLineEndings("\n"))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
