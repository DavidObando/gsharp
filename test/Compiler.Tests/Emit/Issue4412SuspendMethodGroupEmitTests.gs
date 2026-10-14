// <copyright file="Issue4412SuspendMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Gsharp.Concurrency
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4412: suspend method groups capture context through a verifier-safe thunk.
/// @remarks ADR-0154 witness: on the parent commit the direct and base cases fail
/// ILVerify with two DelegateCtor errors, while the imported structural
/// conversion reports GS0218 because its hidden context parameter is counted
/// as a source parameter.
@Collection("Issue4412Console")
class Issue4412SuspendMethodGroupEmitTests {
    @Fact
    func SuspendMethodGroupWithDeclaredContext_PreservesDelegateIdentity() {
        const source = `package Issue4412NoHiddenContext
import System
import Gsharp.Concurrency

delegate ExplicitContextRunner(value int32, ctx Context) System.Threading.Tasks.ValueTask[int32];

class C {
    suspend func Explicit(value int32, ctx Context) int32 {
        return value + 1
    }
}

let c = C()
var explicitFirst ExplicitContextRunner = c.Explicit
var explicitSecond ExplicitContextRunner = c.Explicit
Console.WriteLine(object.Equals(explicitFirst, explicitSecond))
Console.WriteLine(explicitFirst(1, Context.None).AsTask().GetAwaiter().GetResult())`
        let directory = PrepareDirectory("SuspendMethodGroupWithDeclaredContext_PreservesDelegateIdentity")
        try {
            let outputPath = Compile(directory, "App", source, "/target:exe")
            IlVerifier.Verify(outputPath, []string{Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("True${Environment.NewLine}2${Environment.NewLine}", Run(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func InferredSuspendMethodGroupWithDeclaredContext_VerifiesAndRuns() {
        const source = `package Issue4412InferredDeclaredContext
import System
import System.Threading.Tasks
import Gsharp.Concurrency

func Inferred(value int32, ctx Context) int32 {
    return await Task.FromResult(value + 1)
}

let callback = Inferred
Console.WriteLine(callback(1, Context.None))`
        let directory = PrepareDirectory("InferredSuspendMethodGroupWithDeclaredContext_VerifiesAndRuns")
        try {
            let outputPath = Compile(directory, "App", source, "/target:exe")
            IlVerifier.Verify(outputPath, []string{Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("2${Environment.NewLine}", Run(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func DirectInstanceAndBaseSuspendMethodGroups_VerifyAndRun() {
        const source = `package Issue4412
import System

delegate Runner(value int32) System.Threading.Tasks.ValueTask[int32];

open class A {
    open suspend func M(value int32) int32 {
        return value + 1
    }

    suspend func Wait(ch chan[int32]) string {
        select {
        case cancelled {
            return "cancelled"
        }
        case <-ch {
            return "received"
        }
        }
    }
}

class B : A {
    override suspend func M(value int32) int32 {
        return value + 10
    }

    suspend func BaseDelegate(value int32) int32 {
        let f = base.M
        return await f(value)
    }
}

suspend func run() {
    let a A = B()
    let direct = a.M
    Console.WriteLine(direct(1))
    var named Runner = a.M
    Console.WriteLine(await named(2))
    Console.WriteLine(B().BaseDelegate(1))
    scope {
        let wait = a.Wait
        ctx.TryCancel()
        Console.WriteLine(await wait(chan[int32](1)))
    }
}

run()`
        let directory = PrepareDirectory("DirectInstanceAndBaseSuspendMethodGroups_VerifyAndRun")
        try {
            let outputPath = Compile(directory, "App", source, "/target:exe")
            IlVerifier.Verify(outputPath, []string{Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal(
                "11${Environment.NewLine}12${Environment.NewLine}2${Environment.NewLine}cancelled${Environment.NewLine}",
                Run(outputPath)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedInstanceSuspendMethodGroup_VerifiesAndRuns() {
        const library = `package Lib

public open class A {
    public open suspend func M(value int32) int32 {
        return value + 1
    }

    public suspend func Wait(ch chan[int32]) string {
        select {
        case cancelled {
            return "cancelled"
        }
        case <-ch {
            return "received"
        }
        }
    }
}`
        const app = `package App
import System
import Lib

suspend func run() {
    let direct (int32) -> System.Threading.Tasks.ValueTask[int32] = A().M
    Console.WriteLine(await direct(1))
    scope {
        let wait (chan[int32]) -> System.Threading.Tasks.ValueTask[string] = A().Wait
        ctx.TryCancel()
        Console.WriteLine(await wait(chan[int32](1)))
    }
}

run()`
        let directory = PrepareDirectory("ImportedInstanceSuspendMethodGroup_VerifiesAndRuns")
        try {
            let libraryPath = Compile(directory, "Lib", library, "/target:library")
            let appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath)
            IlVerifier.Verify(appPath, []string{libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("2${Environment.NewLine}cancelled${Environment.NewLine}", Run(appPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedStaticAndExtensionSuspendMethodGroups_VerifyAndRun() {
        const library = `package Lib

public class Number {
    public let value int32
    public init(value int32) {
        this.value = value
    }
}

public suspend func Twice(value int32) int32 {
    return value * 2
}

public suspend func (number Number) Add(value int32) int32 {
    return number.value + value
}`
        const app = `package App
import System
import System.Linq
import Lib

func Register[T](callback (int32) -> T) T {
    return callback(11)
}

class Holder {
    let instanceCallback (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
    shared {
        let sharedCallback (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
    }
}

suspend func run() {
    let values = []int32{7}
    for task in Enumerable.Select(values, Twice) {
        Console.WriteLine(await task)
    }
    let twice (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
    let add (int32) -> System.Threading.Tasks.ValueTask[int32] = Number(10).Add
    Console.WriteLine(await twice(3))
    Console.WriteLine(await add(4))
    Console.WriteLine(await Register(Twice))
}

let top (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
Console.WriteLine(top(5).AsTask().GetAwaiter().GetResult())
Console.WriteLine(Holder.sharedCallback(8).AsTask().GetAwaiter().GetResult())
Console.WriteLine(Holder().instanceCallback(9).AsTask().GetAwaiter().GetResult())
run()`
        let directory = PrepareDirectory("ImportedStaticAndExtensionSuspendMethodGroups_VerifyAndRun")
        try {
            let libraryPath = Compile(directory, "Lib", library, "/target:library")
            let appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath)
            IlVerifier.Verify(appPath, []string{libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal(
                "10${Environment.NewLine}16${Environment.NewLine}18${Environment.NewLine}14${Environment.NewLine}6${Environment.NewLine}14${Environment.NewLine}22${Environment.NewLine}",
                Run(appPath)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedByRefSuspendMethodGroup_VerifiesAndRuns() {
        const library = `using System.Threading.Tasks;
using Gsharp.Concurrency;

namespace Interop;

public sealed class Box { }
public delegate ValueTask<int> RefRunner(ref int value);
public delegate void GenericRefAction<T>(ref T value);
public delegate void GenericRefValueAction<T>(ref int target, T value);
public delegate ValueTask<int> ValueRunner(int value);

public static class Api
{
    [Suspending]
    public static ValueTask<int> Increment(ref int value, Context ctx4412)
    {
        value++;
        return new ValueTask<int>(value);
    }

    public static void Clear<T>(this Box box, ref T value) => value = default!;

    public static void Set<T>(this Box box, ref int target, T value) =>
        target = value is int number ? number : -1;

    [Suspending]
    public static ValueTask<int> Echo(int value, Context ctx4412) =>
        new(value);
}`
        const app = `package App
import System
import System.Linq
import Interop

func Register[T](callback (int32) -> T) T {
    return callback(11)
}

suspend func run() {
    var value = 4
    let callback RefRunner = Api.Increment
    Console.WriteLine(await callback(ref value))
    Console.WriteLine(value)
    let clear GenericRefAction[int32] = Box().Clear
    clear(ref value)
    Console.WriteLine(value)
    let set GenericRefValueAction[int32] = Box().Set
    set(ref value, 42)
    Console.WriteLine(value)
    let echo ValueRunner = Api.Echo
    Console.WriteLine(await echo(6))
    let values = []int32{7}
    for task in Enumerable.Select(values, Api.Echo) {
        Console.WriteLine(await task)
    }
    Console.WriteLine(await Register(Api.Echo))
}

run()`
        let directory = PrepareDirectory("ImportedByRefSuspendMethodGroup_VerifiesAndRuns")
        try {
            let libraryPath = CompileCSharpLibrary(directory, "Interop", library)
            let appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath)
            IlVerifier.Verify(appPath, []string{libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal(
                "5${Environment.NewLine}5${Environment.NewLine}0${Environment.NewLine}42${Environment.NewLine}6${Environment.NewLine}7${Environment.NewLine}11${Environment.NewLine}",
                Run(appPath)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedByRefSuspendMethodGroup_StillChecksByValueSlots() {
        const library = `using System.Threading.Tasks;
using Gsharp.Concurrency;

namespace Interop;

public delegate ValueTask<int> RefObjectRunner(ref int value, object extra);

public static class Api
{
    [Suspending]
    public static ValueTask<int> IncrementText(ref int value, string extra, Context ctx4412) =>
        new(value + extra.Length);
}`
        const app = `package App
import Interop

let callback RefObjectRunner = Api.IncrementText`
        let directory = PrepareDirectory("ImportedByRefSuspendMethodGroup_StillChecksByValueSlots")
        try {
            let libraryPath = CompileCSharpLibrary(directory, "Interop", library)
            let diagnostics = CompileExpectingError(
                directory,
                "App",
                app,
                "/target:library",
                "/reference:" + libraryPath
            )
            Assert.Contains("GS0218", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedGenericExtensionSuspendMethodGroup_IgnoresHiddenContextDuringInference() {
        const library = `using System.Threading.Tasks;
using Gsharp.Concurrency;

namespace Interop;

public sealed class Box<T> { }
public delegate ValueTask<int> ValueRunner(int value);

public static class Extensions
{
    [Suspending]
    public static ValueTask<int> Identity<T>(this Box<T> box, int value, Context ctx4412) =>
        new(value);
}`
        const app = `package App
import System
import Interop

suspend func run() {
    let callback ValueRunner = Box[int32]().Identity
    Console.WriteLine(await callback(8))
}

run()`
        let directory = PrepareDirectory(
            "ImportedGenericExtensionSuspendMethodGroup_IgnoresHiddenContextDuringInference"
        )
        try {
            let libraryPath = CompileCSharpLibrary(directory, "Interop", library)
            let appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath)
            IlVerifier.Verify(appPath, []string{libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("8${Environment.NewLine}", Run(appPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedGenericExtensionMethodGroup_IsClosedAgainstDelegateShape() {
        const library = `using System.Threading.Tasks;
using Gsharp.Concurrency;

namespace Interop;

public sealed class Box { }
public delegate ValueTask<bool> ValuePredicate(int value);

public static class Extensions
{
    [Suspending]
    public static ValueTask<bool> Accept<T>(this Box box, T value, Context ctx4412) =>
        new(true);
}`
        const app = `package App
import System
import Interop

suspend func run() {
    let callback ValuePredicate = Box().Accept
    Console.WriteLine(await callback(9))
}

run()`
        let directory = PrepareDirectory("ImportedGenericExtensionMethodGroup_IsClosedAgainstDelegateShape")
        try {
            let libraryPath = CompileCSharpLibrary(directory, "Interop", library)
            let appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath)
            IlVerifier.Verify(appPath, []string{libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("True${Environment.NewLine}", Run(appPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ImportedSuspendOverloadRanking_IgnoresHiddenContext() {
        const library = `using System.Threading.Tasks;
using Gsharp.Concurrency;

namespace Interop;

public delegate ValueTask<string> StringRunner(string value);

public static class Api
{
    public static ValueTask<string> Pick(object value) =>
        new("normal");

    [Suspending]
    public static ValueTask<string> Pick(string value, Context ctx4412) =>
        new("suspend");
}`
        const app = `package App
import System
import Interop

suspend func run() {
    let callback StringRunner = Api.Pick
    Console.WriteLine(await callback("value"))
}

run()`
        let directory = PrepareDirectory("ImportedSuspendOverloadRanking_IgnoresHiddenContext")
        try {
            let libraryPath = CompileCSharpLibrary(directory, "Interop", library)
            let appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath)
            IlVerifier.Verify(appPath, []string{libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("suspend${Environment.NewLine}", Run(appPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func StaticInitializerSuspendMethodGroups_VerifyAndRun() {
        const source = `package Issue4412
import System
import System.Threading.Tasks

suspend func Declared(value int32) int32 {
    return value + 1
}

func Inferred(value int32) int32 {
    return await Task.FromResult(value + 2)
}

class Holder {
    shared {
        var Result int32
        init {
            let declared = Declared
            let inferred = Inferred
            Result = declared(3).AsTask().GetAwaiter().GetResult() + inferred(4)
        }
    }
}

Console.WriteLine(Holder.Result)`
        let directory = PrepareDirectory("StaticInitializerSuspendMethodGroups_VerifyAndRun")
        try {
            let outputPath = Compile(directory, "App", source, "/target:exe")
            IlVerifier.Verify(outputPath, []string{Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("10${Environment.NewLine}", Run(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func UnresolvedSuspendMethodGroupInStaticInitializer_ReportsWithoutCrashing() {
        const source = `package Issue4412

suspend func Pick(value int32) int32 {
    return value
}

func Pick(value string) string {
    return value
}

class Holder {
    shared {
        init {
            let callback = Pick
        }
    }
}`
        let directory = PrepareDirectory("UnresolvedSuspendMethodGroupInStaticInitializer_ReportsWithoutCrashing")
        try {
            let diagnostics = CompileExpectingError(directory, "App", source, "/target:library")
            Assert.Contains("GS0582", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func SourceSuspendMethodWithByRefParameter_IsRejectedBeforeAdapterEmission() {
        const source = `package Issue4412
import System.Threading.Tasks

delegate RefRunner(ref value int32) ValueTask[int32];

suspend func Increment(ref value int32) int32 {
    value++
    return value
}

let callback RefRunner = Increment`
        let directory = PrepareDirectory("SourceSuspendMethodWithByRefParameter_IsRejectedBeforeAdapterEmission")
        try {
            let diagnostics = CompileExpectingError(directory, "App", source, "/target:library")
            Assert.Contains("GS0422", diagnostics, StringComparison.Ordinal)
            Assert.Contains("suspend function", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func InferredSuspendMethodWithByRefParameter_IsRejectedBeforeAdapterEmission() {
        const source = `package Issue4412
import System.Threading.Tasks

func Increment(ref value int32) int32 {
    value++
    return await Task.FromResult(value)
}`
        let directory = PrepareDirectory("InferredSuspendMethodWithByRefParameter_IsRejectedBeforeAdapterEmission")
        try {
            let diagnostics = CompileExpectingError(directory, "App", source, "/target:library")
            Assert.Contains("GS0422", diagnostics, StringComparison.Ordinal)
            Assert.Contains("newly inferred suspending function", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func SuspendMethodGroupInsideAsyncLet_CapturesCellContext() {
        const source = `package Issue4412
import System

suspend func Value() int32 {
    return 7
}

suspend func Invoke(callback () -> System.Threading.Tasks.ValueTask[int32]) int32 {
    return await callback()
}

func run() {
    scope {
        async let result = Invoke(Value)
        Console.WriteLine(await result)
    }
}

run()`
        let directory = PrepareDirectory("SuspendMethodGroupInsideAsyncLet_CapturesCellContext")
        try {
            let outputPath = Compile(directory, "App", source, "/target:exe")
            IlVerifier.Verify(outputPath, []string{Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("7${Environment.NewLine}", Run(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func InferredSuspendMethodGroup_VerifiesAndRuns() {
        const source = `package Issue4412
import System
import System.Threading.Tasks

func Take(ch chan[int32]) int32 {
    return <-ch
}

suspend func AddOne(value int32) int32 {
    return value + 1
}

class Holder {
    let take (chan[int32]) -> int32 = Take

    suspend func AddOne(value int32) int32 {
        return value + 1
    }
}

func Make() Holder {
    return await Task.FromResult(Holder())
}

let ch = chan[int32](1)
ch <- 42
let addOne = AddOne
let take = Take
Console.WriteLine(addOne(1))
Console.WriteLine(take(ch))
let second = chan[int32](1)
second <- 43
Console.WriteLine(Holder().take(second))
let receiverMethod = Make().AddOne
Console.WriteLine(receiverMethod(4))`
        let directory = PrepareDirectory("InferredSuspendMethodGroup_VerifiesAndRuns")
        try {
            let outputPath = Compile(directory, "App", source, "/target:exe")
            IlVerifier.Verify(outputPath, []string{Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal(
                "2${Environment.NewLine}42${Environment.NewLine}43${Environment.NewLine}5${Environment.NewLine}",
                Run(outputPath)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func GenericStaticSuspendMethodGroup_PreservesConstructedOwner() {
        const source = `package Issue4412
import System

class Box[T] {
    shared {
        suspend func Identity(value T) T {
            return value
        }
    }
}

suspend func run() {
    let identity (int32) -> System.Threading.Tasks.ValueTask[int32] = Box[int32].Identity
    Console.WriteLine(await identity(9))
}

run()`
        let directory = PrepareDirectory("GenericStaticSuspendMethodGroup_PreservesConstructedOwner")
        try {
            let outputPath = Compile(directory, "App", source, "/target:exe")
            IlVerifier.Verify(outputPath, []string{Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal("9${Environment.NewLine}", Run(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func BaseConstructorSuspendMethodGroups_VerifyAndRun() {
        const source = `package Issue4412
import System
import Gsharp.Concurrency

delegate AsyncRunner(value int32) System.Threading.Tasks.ValueTask[int32];
delegate ContextRunner(ch chan[int32]) System.Threading.Tasks.ValueTask[string];

suspend func Twice(value int32) int32 {
    return value * 2
}

suspend func ContextState(ch chan[int32]) string {
    select {
    case cancelled {
        return "cancelled"
    }
    case <-ch {
        return "received"
    }
    default {
        return "live"
    }
    }
}

func Take(ch chan[int32]) int32 {
    return <-ch
}

open class AsyncBase {
    let callback AsyncRunner
    init(callback AsyncRunner) {
        this.callback = callback
    }
    func Run(value int32) int32 {
        return callback(value).AsTask().GetAwaiter().GetResult()
    }
}

class PrimaryAsync : AsyncBase(Twice) { }
class ExplicitAsync : AsyncBase {
    init() : base(Twice) { }
}

open class ContextBase {
    let callback ContextRunner
    init(callback ContextRunner) {
        this.callback = callback
    }
    func Run(ch chan[int32]) string {
        return callback(ch).AsTask().GetAwaiter().GetResult()
    }
}

class PrimaryContext(ctx Context) : ContextBase(ContextState) {
    let fieldCallback ContextRunner = ContextState
    func RunField(ch chan[int32]) string {
        return fieldCallback(ch).AsTask().GetAwaiter().GetResult()
    }
}

open class SyncBase {
    let callback (chan[int32]) -> int32
    init(callback (chan[int32]) -> int32) {
        this.callback = callback
    }
    func Run(ch chan[int32]) int32 {
        return callback(ch)
    }
}

class PrimarySync : SyncBase(Take) { }
class ExplicitSync : SyncBase {
    init() : base(Take) { }
}

Console.WriteLine(PrimaryAsync().Run(3))
Console.WriteLine(ExplicitAsync().Run(4))
scope {
    let never = chan[int32](1)
    let primary = PrimaryContext(ctx)
    ctx.TryCancel()
    Console.WriteLine(primary.Run(never))
    Console.WriteLine(primary.RunField(never))
}
let first = chan[int32](1)
first <- 5
Console.WriteLine(PrimarySync().Run(first))
let second = chan[int32](1)
second <- 6
Console.WriteLine(ExplicitSync().Run(second))`
        let directory = PrepareDirectory("BaseConstructorSuspendMethodGroups_VerifyAndRun")
        try {
            let outputPath = Compile(directory, "App", source, "/target:exe")
            IlVerifier.Verify(outputPath, []string{Path.Combine(directory, "Gsharp.Runtime.Channels.dll")})
            Assert.Equal(
                "6${Environment.NewLine}8${Environment.NewLine}cancelled${Environment.NewLine}cancelled${Environment.NewLine}5${Environment.NewLine}6${Environment.NewLine}",
                Run(outputPath)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func PrepareDirectory(name string) string {
            let path = Path.Combine(AppContext.BaseDirectory, name)
            if Directory.Exists(path) {
                Directory.Delete(path, recursive: true)
            }
            Directory.CreateDirectory(path)
            return path
        }

        private func Compile(directory string, assemblyName string, source string, extra ...string) string {
            let sourcePath = Path.Combine(directory, assemblyName + ".gs")
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            let arguments = List[string]{"/out:" + outputPath, "/targetframework:net10.0"}
            arguments.AddRange(extra)
            arguments.AddRange(TrustedPlatformAssemblies().Select((reference string) -> ("/reference:" + reference)))
            arguments.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(
                File.Exists(outputPath) && FileInfo(outputPath).Length > int64(0),
                stdout.ToString() + stderr.ToString()
            )
            return outputPath
        }

        private func CompileCSharpLibrary(directory string, assemblyName string, source string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .Append(MetadataReference.CreateFromFile(typeof(Context).Assembly.Location))
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            let result = compilation.Emit(outputPath)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            RewriteMetadataString(outputPath, "ctx4412", "<>ctx")
            return outputPath
        }

        private func RewriteMetadataString(assemblyPath string, from string, to string) {
            let bytes = File.ReadAllBytes(assemblyPath)
            let source = Encoding.UTF8.GetBytes(from + "\u0000")
            let replacement = Encoding.UTF8.GetBytes(to + "\u0000")
            Assert.True(replacement.Length <= source.Length)
            let matches = Enumerable
                .Range(0, bytes.Length - source.Length + 1)
                .Where((offset int32) -> bytes.AsSpan(offset, source.Length).SequenceEqual(source))
                .ToArray()
            Assert.Single(matches)
            Array.Clear(bytes, matches[0], source.Length)
            replacement.CopyTo(bytes, matches[0])
            File.WriteAllBytes(assemblyPath, bytes)
        }

        private func CompileExpectingError(
            directory string,
            assemblyName string,
            source string,
            extra ...string
        ) string {
            let sourcePath = Path.Combine(directory, assemblyName + ".gs")
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            let arguments = List[string]{"/out:" + outputPath, "/targetframework:net10.0"}
            arguments.AddRange(extra)
            arguments.AddRange(TrustedPlatformAssemblies().Select((reference string) -> ("/reference:" + reference)))
            arguments.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.False(File.Exists(outputPath))
            return stdout.ToString() + stderr.ToString()
        }

        private func Run(assemblyPath string) string {
            using let process = Process.Start(
                ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
                }
            ) ??
                throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(milliseconds: 30_000) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                process.WaitForExit()
                Assert.Fail("timed out after 30s")
            }
            let output = stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult()
            Assert.Equal(0, process.ExitCode)
            return output.ReplaceLineEndings(Environment.NewLine)
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(value) {
                Enumerable.Empty[string]()
            } else {
                value!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }
    }
}

@CollectionDefinition("Issue4412Console", DisableParallelization = true)
class Issue4412ConsoleCollection { }
