// <copyright file="Issue5591GoArgumentEvaluationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import GSharp.Compiler
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
` + Prelude + `
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

    override func Report(tag string, v int32) { Log.Add(tag + " derived " + v.ToString()) }

    func Next(tag string) int32 {
        order += tag
        return order.Length
    }
    func Three(a int32, b int32, c int32) { Log.Add("positional " + a.ToString() + b.ToString() + c.ToString()) }
    func Pair(a int32, b int32) { Log.Add("named a=" + a.ToString() + " b=" + b.ToString()) }
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
        scope {
            go target.Report("method", count)
            go sink.Put("interface", count)
            go handler(count)
            go Three(Next("a"), Next("b"), Next("c"))
            go Pair(b: Next("d"), a: Next("e"))
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
boxed local 41
callee first 41
explicit 41
inferred old
interface A 41
method first 41
named a=5 b=4
order abcde|
positional 123
suspending 7
`)
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
struct Counter {
    var n int32
    func Bump() { n++ }
    func Add(delta int32) { n += delta }
}
class Holder {
    var counter Counter
    var pair (Counter, int32) = (Counter{}, 0)
}

class Spawner {
    var counter Counter
    var holder Holder = Holder()
    var box StrongBox[Counter] = StrongBox[Counter](Counter{})
    var items []Counter = []Counter{Counter{}, Counter{}}
    var pairs [](Counter, int32) = [](Counter, int32){(Counter{}, 0), (Counter{}, 0)}
    var index int32 = 1
    var probed string = ""

    func Step(tag string) int32 {
        probed += tag
        return 1
    }

    func Run(release ManualResetEventSlim) {
        let originalHolder = holder
        let originalBox = box
        let originalItems = items
        let originalPairs = pairs
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
            go holder.pair.Item1.Bump()
            go box.Value.Bump()
            go items[index].Bump()
            go pairs[index].Item1.Bump()
            holder = Holder()
            box = StrongBox[Counter](Counter{})
            items = []Counter{Counter{}, Counter{}}
            pairs = [](Counter, int32){(Counter{}, 0), (Counter{}, 0)}
            index = 0
            release.Set()
        }
        Log.Add("box original=" + originalBox.Value.n.ToString() + " replacement=" + box.Value.n.ToString())
        Log.Add("field " + counter.n.ToString())
        Log.Add("holder original=" + originalHolder.counter.n.ToString() + " replacement=" + holder.counter.n.ToString())
        Log.Add("items original=" + originalItems[0].n.ToString() + originalItems[1].n.ToString() + " replacement=" + items[0].n.ToString() + items[1].n.ToString())
        Log.Add("pairs original=" + originalPairs[0].Item1.n.ToString() + originalPairs[1].Item1.n.ToString() + " replacement=" + pairs[0].Item1.n.ToString() + pairs[1].Item1.n.ToString())
        Log.Add("probed " + probed)
        Log.Add("tuple original=" + originalHolder.pair.Item1.n.ToString() + " replacement=" + holder.pair.Item1.n.ToString())
    }
}

RestrictPool()
Blocked((release ManualResetEventSlim) -> Spawner().Run(release))
`
        AssertRuns(source, "ValueTypeReceiver", `box original=1 replacement=0
field 1
holder original=1 replacement=0
items original=01 replacement=00
pairs original=01 replacement=00
probed index-threw;holder-threw;box-threw;
tuple original=1 replacement=0
`)
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
        Assert.Contains("GS9011", refOutput, StringComparison.Ordinal)
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
