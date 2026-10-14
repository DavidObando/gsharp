// <copyright file="Issue2280AwaitForPatternAsyncEnumerableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2280: `await for x in stream.ConfigureAwait(false) { ... }`
/// failed to bind with GS0134 because
/// `System.Runtime.CompilerServices.ConfiguredCancelableAsyncEnumerable<T>`
/// (returned by `IAsyncEnumerable<T>.ConfigureAwait(bool)`) implements
/// no interfaces at all — it is a fully duck-typed (pattern-based) async
/// enumerable per the C# `await foreach` spec: a parameterless
/// `GetAsyncEnumerator()` whose enumerator exposes `Current` and
/// `MoveNextAsync() -> ConfiguredValueTaskAwaitable<bool>` (not
/// `ValueTask<bool>`), and disposes via a pattern
/// `DisposeAsync() -> ConfiguredValueTaskAwaitable` (not
/// `IAsyncDisposable`).
///
/// These end-to-end tests pin the fix at runtime for: (1) the exact issue
/// repro (`.ConfigureAwait(false)` on an `IAsyncEnumerable[T]`), (2)
/// a fully hand-rolled duck-typed async enumerable with no interfaces
/// anywhere in its shape, proving the fix generalizes beyond
/// `ConfiguredCancelableAsyncEnumerable[T]` to the full C# pattern, and
/// (3) a regression guard for the pre-existing plain
/// `IAsyncEnumerable[T]` interface path.
open class Issue2280AwaitForPatternAsyncEnumerableEmitTests {
    @Fact
    func AwaitFor_ConfigureAwaitFalse_On_IAsyncEnumerable_Compiles_And_Runs() {
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Numbers() IAsyncEnumerable[int32] {
    yield 1
    await Task.Yield()
    yield 2
}

async func Run() {
    var sum = 0
    await for n in Numbers().ConfigureAwait(false) {
        sum = sum + n
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        let (assembly, stdout) = CompileRunCapture(source)
        Assert.Equal("3", stdout.Trim())
    }

    @Fact
    func AwaitFor_ConfigureAwaitFalse_Break_Disposes_Enumerator() {
        // Early `break` must still route through the pattern-based
        // DisposeAsync() (a ConfiguredValueTaskAwaitable, not IAsyncDisposable).
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Numbers() IAsyncEnumerable[int32] {
    yield 1
    await Task.Yield()
    yield 2
    await Task.Yield()
    yield 3
}

async func Run() {
    var sum = 0
    await for n in Numbers().ConfigureAwait(false) {
        sum = sum + n
        if n == 2 {
            break
        }
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        let (assembly, stdout) = CompileRunCapture(source)
        Assert.Equal("3", stdout.Trim())
    }

    @Fact
    func AwaitFor_PlainIAsyncEnumerable_Regression_Compiles_And_Runs() {
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Numbers() IAsyncEnumerable[int32] {
    yield 1
    await Task.Yield()
    yield 2
}

async func Run() {
    var sum = 0
    await for n in Numbers() {
        sum = sum + n
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        let (assembly, stdout) = CompileRunCapture(source)
        Assert.Equal("3", stdout.Trim())
    }

    @Fact
    func AwaitFor_FullyDuckTypedCustomAsyncEnumerable_Compiles_And_Runs() {
        // A custom C# helper library whose entire await-foreach surface —
        // the enumerable's GetAsyncEnumerator(), the enumerator's
        // MoveNextAsync()/Current/DisposeAsync(), and the awaitables
        // MoveNextAsync()/DisposeAsync() return — implements NO interfaces
        // except the minimal INotifyCompletion the C# awaiter pattern itself
        // requires. This proves the fix is the general pattern-based
        // `await foreach` shape, not a ConfiguredCancelableAsyncEnumerable[T]
        // special case.
        let helperLibPath = BuildCustomDuckTypedAsyncEnumerableLibrary()
        let source = `package Probe
import System
import CustomAsyncDuck

async func Run() {
    var sum = 0
    var stream = Factory.Create()
    await for n in stream {
        sum = sum + n
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        let (assembly, stdout) = CompileRunCapture(source, extraReferences: []string{helperLibPath})
        Assert.Equal("6", stdout.Trim())
    }

    shared {
        private func BuildCustomDuckTypedAsyncEnumerableLibrary() string {
            const HelperSource = `using System;
using System.Runtime.CompilerServices;

namespace CustomAsyncDuck
{
    public struct MoveNextAwaiter : ICriticalNotifyCompletion
    {
        private readonly bool result;

        public MoveNextAwaiter(bool result) => this.result = result;

        public bool IsCompleted => true;

        public bool GetResult() => this.result;

        public void OnCompleted(Action continuation) => continuation();

        public void UnsafeOnCompleted(Action continuation) => continuation();
    }

    public struct MoveNextAwaitable
    {
        private readonly bool result;

        public MoveNextAwaitable(bool result) => this.result = result;

        public MoveNextAwaiter GetAwaiter() => new MoveNextAwaiter(this.result);
    }

    public struct DisposeAwaiter : ICriticalNotifyCompletion
    {
        public bool IsCompleted => true;

        public void GetResult()
        {
        }

        public void OnCompleted(Action continuation) => continuation();

        public void UnsafeOnCompleted(Action continuation) => continuation();
    }

    public struct DisposeAwaitable
    {
        public DisposeAwaiter GetAwaiter() => new DisposeAwaiter();
    }

    // Implements NO interfaces at all (not IAsyncDisposable).
    public sealed class CustomAsyncEnumerator
    {
        private readonly int[] items;
        private int index = -1;
        public bool Disposed;

        public CustomAsyncEnumerator(int[] items) => this.items = items;

        public int Current => this.items[this.index];

        public MoveNextAwaitable MoveNextAsync()
        {
            this.index++;
            return new MoveNextAwaitable(this.index < this.items.Length);
        }

        public DisposeAwaitable DisposeAsync()
        {
            this.Disposed = true;
            return new DisposeAwaitable();
        }
    }

    // Implements NO interfaces at all (not IAsyncEnumerable[T]).
    public sealed class CustomAsyncEnumerable
    {
        private readonly int[] items;

        public CustomAsyncEnumerable(int[] items) => this.items = items;

        public CustomAsyncEnumerator GetAsyncEnumerator() => new CustomAsyncEnumerator(this.items);
    }

    public static class Factory
    {
        public static CustomAsyncEnumerable Create() => new CustomAsyncEnumerable(new[] { 1, 2, 3 });
    }
}`
            let tree = CSharpSyntaxTree.ParseText(HelperSource, CSharpParseOptions(LanguageVersion.Latest))
            let references = RuntimeReferencePaths().Select(
                (p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "CustomAsyncDuck",
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let dir = Directory.CreateTempSubdirectory("gs_2280_helperlib_").FullName
            let path = Path.Combine(dir, "CustomAsyncDuck.dll")
            {
                using let stream = File.Create(path)
                let result = compilation.Emit(stream)
                if !result.Success {
                    let diagnostics = string.Join(
                        Environment.NewLine,
                        result.Diagnostics.Select((d Diagnostic) -> d.ToString())
                    )
                    throw InvalidOperationException((`Failed to compile helper library:
` + "$diagnostics"))
                }
            }
            return path
        }

        private func RuntimeReferencePaths() IReadOnlyList[string] {
            let tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty
            return tpa
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where((p string) -> p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
                .ToList()
        }

        private func CompileRunCapture(source string, extraReferences[]?string = nil)(
            assembly Assembly,
            stdout string
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_2280_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            if extraReferences != nil {
                for reference in extraReferences {
                    args.Add("/r:" + reference)
                }
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath, extraReferences)
            // The helper assemblies aren't on the default load path, so load them
            // into the same context as the program that references them — the
            // runtime probes for them while invoking <Main>$. (An
            // AppDomain.AssemblyResolve hook cannot serve this: it only answers
            // for the default context, and handing it an assembly from another
            // context fails with "operation is not supported".)
            let assembly = if extraReferences == nil || extraReferences.Length == 0 {
                EmittedFixture.Load(outPath)
            } else {
                EmittedFixture.LoadTogether(extraReferences.Append(outPath).ToArray())[^1]
            }
            // Run the entry point and capture stdout
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let captured = StringWriter()
            let prevOut2 = Console.Out
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(prevOut2)
            }
            return (assembly, captured.ToString().ReplaceLineEndings(Environment.NewLine))
        }
    }
}
