// <copyright file="Issue5591GoArgumentEvaluationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #5591: `go f(args)` evaluates the function value, the receiver and
/// every argument on the spawning goroutine, in source order, before the work
/// item is queued (ADR-0174 D5). Each program holds the only thread-pool
/// worker until the spawner has queued its goroutines and changed the state
/// they read, so a child that evaluates its own operands deterministically
/// sees the changed state. Children record lines that the spawner prints in
/// sorted order after the scope joins them.
open class Issue5591GoArgumentEvaluationTests {
    /// The issue's program: a `?.`/`??` argument and a field argument are
    /// read before the fields change, and the `?.` capture local is the
    /// spawner's, so the child never dereferences a nil capture.
    @Fact
    func NullConditionalAndFieldArguments_AreEvaluatedOnTheSpawner() {
        let source = `package Issue5591Tokens
` + Prelude + `
class Receiver {
    var source CancellationTokenSource?
    var count int32 = 41

    func Run(label string, next CancellationTokenSource?, release ManualResetEventSlim) {
        try {
            scope {
                go Work(label, source?.Token ?? CancellationToken.None)
                go Record(label, this.count)
                source = next
                count++
                release.Set()
            }
        } catch (failure Exception) {
            Log.Add(label + ": " + (failure.InnerException ?? failure).GetType().Name)
        }
    }

    private func Work(label string, token CancellationToken) ->
        Log.Add(label + ": cancellable=" + token.CanBeCanceled.ToString() + ", cancelled=" + token.IsCancellationRequested.ToString())

    private func Record(label string, value int32) -> Log.Add(label + ": count=" + value.ToString())
}

func RunCase(label string, original CancellationTokenSource?, replacement CancellationTokenSource?) {
    let receiver = Receiver()
    receiver.source = original
    Blocked((release ManualResetEventSlim) -> receiver.Run(label, replacement, release))
}

RestrictPool()
using let original = CancellationTokenSource()
using let replacement = CancellationTokenSource()
replacement.Cancel()
RunCase("clear", original, nil)
RunCase("replace", original, replacement)
RunCase("nil", nil, nil)
RunCase("stable", original, original)
`
        AssertRuns(source, "NullConditionalAndFieldArguments", `clear: cancellable=True, cancelled=False
clear: count=41
replace: cancellable=True, cancelled=False
replace: count=41
nil: cancellable=False, cancelled=False
nil: count=41
stable: cancellable=True, cancelled=False
stable: count=41
`)
    }

    /// Every operand position: a method value's receiver, an interface
    /// receiver, a function-typed field as the callee, side-effecting
    /// arguments (positional and named, in source order), generic calls,
    /// an async callee that awaits in the child, a `base` call, an argument
    /// that calls a suspending function, and a local that a function literal
    /// also captures.
    @Fact
    func CalleeReceiverAndArguments_AreEvaluatedOnceInSourceOrder() {
        let source = `package Issue5591Operands
import System.Runtime.CompilerServices
` + Prelude + `
struct Counter {
    var n int32
}
interface ISink {
    func Put(tag string, v int32);
}
class SinkA : ISink {
    func Put(tag string, v int32) { Log.Add(tag + " A " + v.ToString()) }
}
class SinkB : ISink {
    func Put(tag string, v int32) { Log.Add(tag + " B " + v.ToString()) }
}
open class Base {
    open func Report(tag string, v int32) { Log.Add(tag + " base " + v.ToString()) }
}
class Target {
    let name string
    init(name string) { this.name = name }
    func Report(tag string, v int32) { Log.Add(tag + " " + name + " " + v.ToString()) }
}

suspend func Fetch(ch chan[int32]) int32 {
    return <-ch
}

class Spawner : Base {
    var count int32 = 41
    var target Target = Target("first")
    var sink ISink = SinkA()
    var handler Action[int32] = (v int32) -> Log.Add("callee first " + v.ToString())
    var label string = "old"
    var order string = ""
    var spanCreated int32 = 0
    var posSpanCreated int32 = 0

    override func Report(tag string, v int32) { Log.Add(tag + " derived " + v.ToString()) }

    func Next(tag string) int32 {
        order += tag
        return order.Length
    }
    func MakeSpanString() string {
        spanCreated = 4
        return "abcd"
    }
    func ReadSpanCreated() int32 -> spanCreated
    func MakePosSpanString() string {
        posSpanCreated = 5
        return "abcde"
    }
    func ReadPosSpanCreated() int32 -> posSpanCreated
    func Three(a int32, b int32, c int32) { Log.Add("positional " + a.ToString() + b.ToString() + c.ToString()) }
    func Pair(a int32, b int32) { Log.Add("named a=" + a.ToString() + " b=" + b.ToString()) }
    func ConsumeSpan(value ReadOnlySpan[char], extra int32) { Log.Add("named-span len=" + value.Length.ToString() + " extra=" + extra.ToString()) }
    func ConsumeSpan3(value ReadOnlySpan[char], extra int32, last int32) {
        Log.Add("named-span3 len=" + value.Length.ToString() + " extra=" + extra.ToString() + " last=" + last.ToString())
    }
    func Show[T](tag string, value T) { Log.Add(tag + " " + value.ToString()) }
    async func Later(v int32) {
        await Task.Yield()
        Log.Add("async " + v.ToString())
    }

    func Run(release ManualResetEventSlim) {
        let ch = chan[int32](1)
        ch <- 7
        var local = 41
        let bump = func() { local = 99 }
        let box = StrongBox[int32](0)
        scope {
            go target.Report("method", count)
            go sink.Put("interface", count)
            go handler(count)
            go Three(Next("a"), Next("b"), Next("c"))
            go Pair(b: Next("d"), a: Next("e"))
            go Pair(b: Next("f"), a: Next("g"))
            go ConsumeSpan(extra: Next("h"), value: label.AsSpan())
            go Show("span-block", {
                let s = (order += "i").AsSpan()
                let n = s.Length
                n
            })
            go ConsumeSpan({
                let _ = Next("j")
                let s = "abcd".AsSpan()
                box.Value = s.Length
                let m = box.Value
                Log.Add("box-in-block " + m.ToString())
                let n = s.Length
                let len = n
                s.Slice(0, len)
            }, 11)
            go ConsumeSpan({
                let _ = Next("k")
                var c = Counter{}
                let s = "abc".AsSpan()
                c.n = s.Length
                s
            }, 12)
            go ConsumeSpan3(extra: Next("l"), value: MakeSpanString().AsSpan(), last: ReadSpanCreated())
            go ConsumeSpan(MakePosSpanString().AsSpan(), ReadPosSpanCreated())
            go Show("inferred", label)
            go Show[int32]("explicit", count)
            go Later(count)
            go base.Report("base", count)
            go Show("suspending", Fetch(ch))
            go Show("boxed local", local)
            order += "|"
            bump()
            count++
            target = Target("second")
            sink = SinkB()
            handler = (v int32) -> Log.Add("callee second " + v.ToString())
            label = "new"
            release.Set()
        }
        Log.Add("order " + order)
    }
}

RestrictPool()
Blocked((release ManualResetEventSlim) -> Spawner().Run(release))
`
        AssertRuns(source, "CalleeReceiverAndArguments", `async 41
base base 41
box-in-block 4
boxed local 41
callee first 41
explicit 41
inferred old
interface A 41
method first 41
named a=5 b=4
named a=7 b=6
named-span len=3 extra=12
named-span len=3 extra=8
named-span len=4 extra=11
named-span len=5 extra=5
named-span3 len=4 extra=12 last=4
order abcdefghijkl|
positional 123
span-block 9
suspending 7
`)
    }

    @Fact
    func GlobalValueTypeReceivers_UseLiveStorageButArgumentsCaptureValues() {
        let source = `package Issue5708Globals
` + Prelude + `
struct Counter {
    var n int32
    func Bump() { n++ }
}
struct Outer { var inner Counter }
var global Counter
var nested Outer
var value Counter = Counter{n: 7}
var text string = "old"
class Holder {
    shared {
        var staticCounter Counter
        func Spawn() {
            scope { go staticCounter.Bump() }
        }
    }
}
class Target {
    let name string
    init(name string) { this.name = name }
    func Report() { Log.Add("receiver " + name) }
}
var target Target = Target("first")
func Print(n int32) { Log.Add("argument " + n.ToString()) }
func Inc(ref n int32) { n++ }
func PrintSpan(span ReadOnlySpan[char], n int32) {
    Log.Add("span " + span.Length.ToString() + " scalar " + n.ToString())
}
func Run(release ManualResetEventSlim) {
    scope {
        go global.Bump()
        go nested.inner.Bump()
        go Holder.staticCounter.Bump()
        go Print(value.n)
        go target.Report()
        go PrintSpan(text.AsSpan(), value.n)
        go {
            var local = 0
            Inc(&local)
            Log.Add("child ref " + local.ToString())
        }
        value.n = 99
        text = "changed"
        target = Target("second")
        release.Set()
    }
    Log.Add("global " + global.n.ToString())
    Log.Add("nested " + nested.inner.n.ToString())
    Log.Add("static " + Holder.staticCounter.n.ToString())
}
RestrictPool()
Blocked((release ManualResetEventSlim) -> Run(release))
Holder.Spawn()
Console.WriteLine("bare static " + Holder.staticCounter.n.ToString())
`
        AssertRuns(source, "Issue5708GlobalStorage", `argument 7
child ref 1
global 1
nested 1
receiver first
span 3 scalar 7
static 1
bare static 2
`)
    }

    @Theory
    @InlineData("Inc(&x)")
    @InlineData("Out(&x)")
    @InlineData("worker.RefMethod(&x)")
    @InlineData("Read(x)")
    func ByReferenceGoArguments_AreRejectedByTheDriver(operand string) {
        let source = `package Issue5708Driver
func Inc(ref slot int32) { slot++ }
func Out(out slot int32) { slot = 1 }
func Read(in slot int32) int32 -> slot
class Worker { func RefMethod(ref slot int32) { slot++ } }
var x = 0
let worker = Worker()
scope {
    go ` + operand + `
}
`
        let (exitCode, output) = TryCompile(source, "Issue5708ByRef")
        Assert.NotEqual(0, exitCode)
        Assert.Contains(
            "(9,8,9," + (8 + operand.Length).ToString() + "): error GS0460",
            output,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }

    /// A value-type receiver is storage: the containers that locate it (the
    /// object holding the field or CLR field, the tuple element chain, the
    /// array and its index) are evaluated and validated on the spawner before
    /// the call's arguments, and the call still mutates that storage rather
    /// than a copy.
    @Fact
    func ValueTypeReceiver_LocationIsEvaluatedOnTheSpawner() {
        let source = `package Issue5591Receivers
import System.Runtime.CompilerServices
` + Prelude + `
struct Counter : IDisposable {
    var n int32
    func Bump() { n++ }
    func Add(delta int32) { n += delta }
    func Read(delta int32) { Log.Add("static-ro " + (n + delta).ToString()) }
    func Dispose() { n++ }
}
class DisposableBox : IDisposable {
    var n int32
    func Dispose() { n++ }
}
class Holder {
    var counter Counter
    var pair (Counter, int32) = (Counter{}, 0)
}
class GenericHolder[T] {
    var item T
    init(item T) { this.item = item }
}
class InitLog {
    shared {
        var order string = ""
        func Step(tag string) int32 {
            order += tag
            return 1
        }
    }
}
class StaticStore {
    shared {
        var counter Counter
        let readonlyCounter Counter = Counter{n: 5}
        init {
            InitLog.order += "cctor;"
        }
    }
}
class StaticReadonlyStore {
    shared {
        let readonlyCounter Counter = Counter{n: 5}
        init {
            InitLog.order += "ro-cctor;"
        }
    }
}
class CondStaticA {
    shared {
        var counter Counter
        init {
            InitLog.order += "condA-cctor;"
        }
    }
}
class CondStaticB {
    shared {
        var counter Counter
        init {
            InitLog.order += "condB-cctor;"
        }
    }
}

func RunDefault[T IDisposable]() {
    scope {
        go default(T).Dispose()
    }
}

func RunConstrained[T IDisposable](items []T, holder GenericHolder[T], replacement T, release ManualResetEventSlim) {
    var current T = items[0]
    let replace = func() { current = replacement }
    scope {
        go items[0].Dispose()
        go holder.item.Dispose()
        go current.Dispose()
        items[0] = replacement
        holder.item = replacement
        replace()
        release.Set()
    }
}

class Spawner {
    var counter Counter
    var holder Holder = Holder()
    var altHolder Holder = Holder()
    var choose bool = true
    var box StrongBox[Counter] = StrongBox[Counter](Counter{})
    var items []Counter = []Counter{Counter{}, Counter{}}
    var pairs [](Counter, int32) = [](Counter, int32){(Counter{}, 0), (Counter{}, 0)}
    var index int32 = 1
    var probed string = ""

    func Step(tag string) int32 {
        probed += tag
        return 1
    }

    func PickFirst() Holder {
        probed += "first;"
        return holder
    }

    func PickSecond() Holder {
        probed += "second;"
        return altHolder
    }

    func Run(release ManualResetEventSlim) {
        let originalHolder = holder
        let originalAltHolder = altHolder
        let originalBox = box
        let originalItems = items
        let originalPairs = pairs
        let genericStructs = []Counter{Counter{}}
        let genericStructHolder = GenericHolder[Counter](Counter{})
        let originalClass = DisposableBox()
        let replacementClass = DisposableBox()
        let genericClasses = []DisposableBox{originalClass}
        let genericClassHolder = GenericHolder[DisposableBox](originalClass)
        var nilHolder Holder? = nil
        var nilBox StrongBox[Counter]? = nil
        try {
            go items[99].Add(Step("bad-index"))
        } catch (ex IndexOutOfRangeException) {
            probed += "index-threw;"
        }
        try {
            go nilHolder!!.counter.Add(Step("nil-holder"))
        } catch (ex NullReferenceException) {
            probed += "holder-threw;"
        }
        try {
            go nilBox!!.Value.Add(Step("nil-box"))
        } catch (ex NullReferenceException) {
            probed += "box-threw;"
        }
        scope {
            go counter.Bump()
            go holder.counter.Bump()
            go (*&(choose ? PickFirst().counter : PickSecond().counter)).Bump()
            go holder.pair.Item1.Bump()
            go box.Value.Bump()
            go items[index].Bump()
            go (*&items[^1]).Bump()
            go pairs[index].Item1.Bump()
            go genericStructs[0].Dispose()
            go genericStructHolder.item.Dispose()
            go genericClasses[0].Dispose()
            go genericClassHolder.item.Dispose()
            go StaticStore.counter.Add(InitLog.Step("arg;"))
            go StaticReadonlyStore.readonlyCounter.Read(InitLog.Step("ro;"))
            go (*&(choose ? CondStaticA.counter : CondStaticB.counter)).Add(InitLog.Step("cond-arg;"))
            choose = false
            holder = Holder()
            altHolder = Holder()
            box = StrongBox[Counter](Counter{})
            items = []Counter{Counter{}, Counter{}}
            pairs = [](Counter, int32){(Counter{}, 0), (Counter{}, 0)}
            genericClasses[0] = replacementClass
            genericClassHolder.item = replacementClass
            index = 0
            release.Set()
        }
        Log.Add("box original=" + originalBox.Value.n.ToString() + " replacement=" + box.Value.n.ToString())
        Log.Add("conditional first=" + originalHolder.counter.n.ToString() + " second=" + originalAltHolder.counter.n.ToString())
        Log.Add("field " + counter.n.ToString())
        Log.Add("generic class original=" + originalClass.n.ToString() + " replacement=" + replacementClass.n.ToString())
        Log.Add("generic struct array=" + genericStructs[0].n.ToString() + " field=" + genericStructHolder.item.n.ToString())
        Log.Add("holder original=" + originalHolder.counter.n.ToString() + " replacement=" + holder.counter.n.ToString())
        Log.Add("items original=" + originalItems[0].n.ToString() + originalItems[1].n.ToString() + " replacement=" + items[0].n.ToString() + items[1].n.ToString())
        Log.Add("pairs original=" + originalPairs[0].Item1.n.ToString() + originalPairs[1].Item1.n.ToString() + " replacement=" + pairs[0].Item1.n.ToString() + pairs[1].Item1.n.ToString())
        Log.Add("probed " + probed)
        Log.Add("static " + InitLog.order + StaticStore.counter.n.ToString() + CondStaticA.counter.n.ToString())
        Log.Add("tuple original=" + originalHolder.pair.Item1.n.ToString() + " replacement=" + holder.pair.Item1.n.ToString())
    }
}

RestrictPool()
RunDefault[Counter]()
Blocked((release ManualResetEventSlim) -> Spawner().Run(release))
let constrainedStructs = []Counter{Counter{}}
let constrainedStructHolder = GenericHolder[Counter](Counter{})
Blocked((release ManualResetEventSlim) -> RunConstrained(constrainedStructs, constrainedStructHolder, Counter{n: 10}, release))
Console.WriteLine("constrained struct array=" + constrainedStructs[0].n.ToString() + " field=" + constrainedStructHolder.item.n.ToString())
let constrainedOriginal = DisposableBox()
let constrainedReplacement = DisposableBox()
let constrainedClasses = []DisposableBox{constrainedOriginal}
let constrainedClassHolder = GenericHolder[DisposableBox](constrainedOriginal)
Blocked((release ManualResetEventSlim) -> RunConstrained(constrainedClasses, constrainedClassHolder, constrainedReplacement, release))
Console.WriteLine("constrained class original=" + constrainedOriginal.n.ToString() + " replacement=" + constrainedReplacement.n.ToString())
`
        AssertRuns(source, "ValueTypeReceiver", `box original=1 replacement=0
conditional first=2 second=0
field 1
generic class original=2 replacement=0
generic struct array=1 field=1
holder original=2 replacement=0
items original=02 replacement=00
pairs original=01 replacement=00
probed index-threw;holder-threw;box-threw;first;
static cctor;arg;ro-cctor;ro;condA-cctor;cond-arg;11
static-ro 6
tuple original=1 replacement=0
constrained struct array=11 field=11
constrained class original=3 replacement=0
`)
    }

    /// Rebuilt `go` calls keep their syntax anchor, member group, and static
    /// qualifier so `SemanticModel` queries resolve the call and its target.
    @Fact
    func SemanticModel_ResolvesGoCalls() {
        let source = `package Issue5591SemanticModel
import System
class Worker {
    func Run(x int32) int32 -> x + 1
    shared {
        func Start(x int32) int32 -> x + 2
    }
}
func Top(x int32) int32 -> x + 3
let w = Worker()
var n = 1
scope {
    go Top(n)
    go w.Run(n)
    go Worker.Start(n)
    go Console.WriteLine(n)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "test.gs"))
        let compilation = Compilation(tree){RecordMemberGroups = true}
        let model = compilation.GetSemanticModel(tree)
        let calls = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Where(
            (c CallExpressionSyntax) -> c
                .Identifier
                .Text == "Top" ||
                c
                .Identifier
                .Text == "Run" ||
                c
                .Identifier
                .Text == "Start" ||
                c
                .Identifier
                .Text == "WriteLine"
        )
            .ToArray()
        Assert.Equal(4, calls.Length)
        for call in calls {
            Assert.NotNull(model.GetBoundNode(call))
            Assert.Equal(call.Identifier.Text, model.GetSymbolInfo(call).Symbol?.Name)
            Assert.NotEmpty(model.GetMemberGroup(call))
        }
        let qualifiers = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "Worker")
            .ToArray()
        Assert.Single(qualifiers)
        Assert.Equal("Worker", model.GetSymbolInfo(qualifiers[0]).Symbol?.Name)
    }

    /// A ref-returning receiver cannot safely escape into the goroutine
    /// closure (GS9011), and an explicit `await` nested under an implicit
    /// suspending completion inside a `go` argument still reports GS0576.
    @Fact
    func InvalidGoOperands_ReportDiagnostics() {
        let refReceiverSource = `package Issue5591RefReceiver
struct Counter {
    var n int32
    func Bump() { n++ }
}
class Holder {
    var counter Counter
    prop Slot ref Counter { get { return ref counter } }
}
func At(items []Counter, index int32) ref Counter {
    return ref items[index]
}
let items = []Counter{Counter{}}
let holder = Holder()
scope {
    go At(items, 0).Bump()
    go holder.Slot.Bump()
}
`
        let (refExit, refOutput) = TryCompile(refReceiverSource, "InvalidRefReceiver")
        Assert.NotEqual(0, refExit)
        Assert.Contains("(16,8,16,27): error GS9011", refOutput, StringComparison.Ordinal)
        Assert.Contains("(17,8,17,26): error GS9011", refOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", refOutput, StringComparison.Ordinal)

        let nestedAwaitSource = `package Issue5591NestedAwait
import System.Threading.Tasks
suspend func Identity(value int32) int32 {
    return value
}
func Consume(value int32) {
}
async func Run() Task {
    scope {
        go Consume(Identity(await Task.FromResult(1)))
    }
}
await Run()
`
        let (awaitExit, awaitOutput) = TryCompile(nestedAwaitSource, "InvalidNestedAwait")
        Assert.NotEqual(0, awaitExit)
        Assert.Contains("GS0576", awaitOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", awaitOutput, StringComparison.Ordinal)
    }

    /// `async let` still evaluates its initializer in the child, but the
    /// locals that a `?.` and a type pattern declare inside it are the
    /// child's own, not uninitialized copies of the spawner's.
    @Fact
    func AsyncLet_NullConditionalAndPatternLocalsBelongToTheChild() {
        let source = `package Issue5591AsyncLet
import System
import System.Threading

class Host {
    var source CancellationTokenSource? = CancellationTokenSource()
    func Get(token CancellationToken) int32 -> if token.CanBeCanceled { 1 } else { 0 }
    func Twice(v int32) int32 -> v * 2
    func Run(o object) {
        scope {
            async let cancellable = Get(source?.Token ?? CancellationToken.None)
            async let length = Twice(o is string text ? text.Length : 0)
            Console.WriteLine("cancellable " + (await cancellable).ToString())
            Console.WriteLine("length " + (await length).ToString())
        }
    }
}

Host().Run("abcd")
`
        AssertRuns(source, "AsyncLetLocals", `cancellable 1
length 8
`)
    }

    shared {
        private const Prelude string = `import System
import System.Collections.Concurrent
import System.Linq
import System.Threading
import System.Threading.Tasks

class Log {
    shared {
        let Lines ConcurrentQueue[string] = ConcurrentQueue[string]()
        func Add(line string) { Lines.Enqueue(line) }
        func Flush() {
            for line in Lines.OrderBy((s string) -> s, StringComparer.Ordinal) {
                Console.WriteLine(line)
            }
            Lines.Clear()
        }
    }
}

func HoldWorker(started ManualResetEventSlim, release ManualResetEventSlim) {
    started.Set()
    release.Wait()
}

func Blocked(body Action[ManualResetEventSlim]) {
    using let started = ManualResetEventSlim(false)
    using let release = ManualResetEventSlim(false)
    go HoldWorker(started, release)
    started.Wait()
    body(release)
    Log.Flush()
}

func RestrictPool() {
    ThreadPool.SetMinThreads(1, 1)
    if !ThreadPool.SetMaxThreads(1, 1) {
        throw Exception("Could not restrict the thread pool")
    }
}
`

        private func AssertRuns(source string, name string, expected string) {
            let assemblyPath = Compile(source, name)
            for var i = 0; i < 3; i++ {
                Assert.Equal(expected.ReplaceLineEndings(Environment.NewLine), RunBounded(assemblyPath, name))
            }
            IlVerifier.Verify(assemblyPath)
        }

        private func Compile(source string, name string) string {
            let (exitCode, output, assemblyPath) = RunGsc(source, name)
            Assert.True(exitCode == 0, ("$name" + `: gsc failed:
` + "$output"))
            return assemblyPath
        }

        private func TryCompile(source string, name string)(ExitCode int32, Output string) {
            let (exitCode, output, _) = RunGsc(source, name)
            return (exitCode, output)
        }

        private func RunGsc(source string, name string)(ExitCode int32, Output string, AssemblyPath string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue5591GoArgumentEvaluationTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            return (exitCode, stdout.ToString() + "\n" + stderr.ToString(), assemblyPath)
        }

        private func RunBounded(assemblyPath string, name string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let outputTask = process!!.StandardOutput.ReadToEndAsync()
            let errorTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(20_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            Assert.True(exited, "$name: emitted program timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            Assert.True(process!!.ExitCode == 0, ("$name" + `: emitted program failed:
` + "$error" + `
` + "$output"))
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
