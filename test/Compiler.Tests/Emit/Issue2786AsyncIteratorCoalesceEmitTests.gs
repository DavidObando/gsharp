// <copyright file="Issue2786AsyncIteratorCoalesceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Runtime.Loader
import System.Threading.Tasks
import Xunit

class Issue2786AsyncIteratorCoalesceEmitTests {
    @Fact
    func AsyncIteratorCalls_KeepEnumerableTypeAcrossBranching_VerifyAndRun() {
        const source = `package Issue2786
import System
import System.Collections.Generic
import System.Threading.Tasks

interface StreamProvider {
    func Values() IAsyncEnumerable[int32];
    func Forward() IAsyncEnumerable[int32] { return Values() }
}

class Provider : StreamProvider {
    async func Values() IAsyncEnumerable[int32] {
        await Task.CompletedTask
        yield 8
    }
}

class Streams {
    async func InstanceEmpty() IAsyncEnumerable[int32] {
        await Task.CompletedTask
    }
    async func InstanceOne() IAsyncEnumerable[int32] {
        await Task.CompletedTask
        yield 1
    }
    shared {
        async func Empty() IAsyncEnumerable[int32] {
            await Task.CompletedTask
        }
        async func One() IAsyncEnumerable[int32] {
            await Task.CompletedTask
            yield 1
        }
        async func GenericEmpty[T any]() IAsyncEnumerable[T] {
            await Task.CompletedTask
        }
        async func GenericOne[T any](value T) IAsyncEnumerable[T] {
            await Task.CompletedTask
            yield value
        }
        func SyncOne() IEnumerable[int32] {
            yield 3
        }
        func SyncWrapper() IEnumerable[int32] {
            Console.WriteLine("sync-wrapper")
            return SyncOne()
        }
        async func Value() int32 {
            await Task.CompletedTask
            return 42
        }
        async func Work() {
            await Task.CompletedTask
        }
        private var fallbackCalls int32
        async func Coalesce(value int32?) int32 {
            return value ?? await Fallback()
        }
        private async func Fallback() int32 {
            fallbackCalls += 1
            await Task.CompletedTask
            return 9
        }
        func FallbackCalls() int32 -> fallbackCalls
    }

    func LeftCall() IAsyncEnumerable[int32] -> Streams.Empty() ?? Streams.One()
    func RightCall(value IAsyncEnumerable[int32]?) IAsyncEnumerable[int32] -> value ?? Streams.Empty()
    func NullableReceiver(value Streams?) IAsyncEnumerable[int32] -> value?.InstanceOne() ?? Streams.Empty()
    func NullableEmpty(value Streams?) IAsyncEnumerable[int32] -> value?.InstanceEmpty() ?? Streams.One()
    func Direct() IAsyncEnumerable[int32] -> Streams.Empty()
    func Conditional(flag bool) IAsyncEnumerable[int32] -> flag ? Streams.Empty() : Streams.One()
    func GenericNested[T any](flag bool, value T) IAsyncEnumerable[T] -> flag ? Streams.GenericEmpty[T]() : Streams.GenericOne[T](value)
    func SyncControl(value IEnumerable[int32]?) IEnumerable[int32] -> value ?? Streams.SyncWrapper()
}

async func Count[T any](values IAsyncEnumerable[T]) int32 {
    var count = 0
    await for value in values { count += 1 }
    return count
}
func CountSync[T any](values IEnumerable[T]) int32 {
    var count = 0
    for value in values { count += 1 }
    return count
}

let streams = Streams()
Console.WriteLine("left=" + Count[int32](streams.LeftCall()).GetAwaiter().GetResult().ToString())
Console.WriteLine("right=" + Count[int32](streams.RightCall(nil)).GetAwaiter().GetResult().ToString())
Console.WriteLine("receiver-present=" + Count[int32](streams.NullableReceiver(streams)).GetAwaiter().GetResult().ToString())
Console.WriteLine("receiver-nil=" + Count[int32](streams.NullableReceiver(nil)).GetAwaiter().GetResult().ToString())
Console.WriteLine("nullable-empty-present=" + Count[int32](streams.NullableEmpty(streams)).GetAwaiter().GetResult().ToString())
Console.WriteLine("nullable-empty-nil=" + Count[int32](streams.NullableEmpty(nil)).GetAwaiter().GetResult().ToString())
Console.WriteLine("direct=" + Count[int32](streams.Direct()).GetAwaiter().GetResult().ToString())
Console.WriteLine("conditional-empty=" + Count[int32](streams.Conditional(true)).GetAwaiter().GetResult().ToString())
Console.WriteLine("conditional-one=" + Count[int32](streams.Conditional(false)).GetAwaiter().GetResult().ToString())
Console.WriteLine("generic-empty=" + Count[int32](streams.GenericNested[int32](true, 7)).GetAwaiter().GetResult().ToString())
Console.WriteLine("generic-one=" + Count[int32](streams.GenericNested[int32](false, 7)).GetAwaiter().GetResult().ToString())
let provider StreamProvider = Provider()
Console.WriteLine("dim=" + Count[int32](provider.Forward()).GetAwaiter().GetResult().ToString())
Console.WriteLine("sync=" + CountSync[int32](streams.SyncControl(nil)).ToString())
Console.WriteLine("value=" + Streams.Value().GetAwaiter().GetResult().ToString())
Streams.Work().GetAwaiter().GetResult()
Console.WriteLine("work=done")
Console.WriteLine("coalesce-present=" + Streams.Coalesce(7).GetAwaiter().GetResult().ToString())
Console.WriteLine("fallback-calls=" + Streams.FallbackCalls().ToString())
Console.WriteLine("coalesce-nil=" + Streams.Coalesce(nil).GetAwaiter().GetResult().ToString())
Console.WriteLine("fallback-calls=" + Streams.FallbackCalls().ToString())`
        using let result = Compile(source)
        IlVerifier.Verify(result.OutputPath)
        AssertMetadataReturnTypes(result.OutputPath)
        Assert.Equal(`left=0
right=0
receiver-present=1
receiver-nil=0
nullable-empty-present=0
nullable-empty-nil=1
direct=0
conditional-empty=0
conditional-one=1
generic-empty=0
generic-one=1
dim=1
sync-wrapper
sync=1
value=42
work=done
coalesce-present=7
fallback-calls=0
coalesce-nil=9
fallback-calls=1
`, Run(result.OutputPath))
    }

    private class CompilationResult : IDisposable {
        init(directory string, outputPath string) {
            Directory = directory
            OutputPath = outputPath
        }

        prop Directory string {
            get;
        }

        prop OutputPath string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func AssertMetadataReturnTypes(outputPath string) {
            let loadContext = AssemblyLoadContext("Issue2786AsyncIteratorCoalesceEmitTests", isCollectible: true)
            using let pe = File.OpenRead(outputPath)
            let assembly = loadContext.LoadFromStream(pe)
            let streams = assembly.GetType("Issue2786.Streams", throwOnError: true)!!
            for name in[]string{
                "InstanceEmpty",
                "InstanceOne",
                "Empty",
                "One",
                "LeftCall",
                "RightCall",
                "NullableReceiver",
                "NullableEmpty",
                "Direct",
                "Conditional"
            } {
                Assert.Equal(typeof(IAsyncEnumerable[int32]), GetMethod(streams, name).ReturnType)
            }
            for name in[]string{"GenericEmpty", "GenericOne", "GenericNested"} {
                let returnType = GetMethod(streams, name).ReturnType
                Assert.True(returnType.IsGenericType)
                Assert.Equal(typeof(IAsyncEnumerable[_]), returnType.GetGenericTypeDefinition())
                Assert.True(returnType.GetGenericArguments()[0].IsGenericParameter)
            }
            Assert.Equal(typeof(IEnumerable[int32]), GetMethod(streams, "SyncWrapper").ReturnType)
            Assert.Equal(typeof(IEnumerable[int32]), GetMethod(streams, "SyncControl").ReturnType)
            Assert.Equal(typeof(Task[int32]), GetMethod(streams, "Value").ReturnType)
            Assert.Equal(typeof(Task), GetMethod(streams, "Work").ReturnType)
            let provider = assembly.GetType("Issue2786.StreamProvider", throwOnError: true)!!
            Assert.Equal(typeof(IAsyncEnumerable[int32]), GetMethod(provider, "Values").ReturnType)
            Assert.Equal(typeof(IAsyncEnumerable[int32]), GetMethod(provider, "Forward").ReturnType)
            loadContext.Unload()
        }

        private func GetMethod(type Type, name string) MethodInfo -> type.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        ) ??
            throw InvalidOperationException("Missing method $name.")

        private func Compile(source string) Issue2786AsyncIteratorCoalesceEmitTests.CompilationResult {
            let directory = Path.Combine(
                Directory.GetCurrentDirectory(),
                "out",
                "test-artifacts",
                "issue2786-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{
                        "/out:" + outputPath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/nowarn:GS9100",
                        sourcePath
                    }
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
            return Issue2786AsyncIteratorCoalesceEmitTests.CompilationResult(directory, outputPath)
        }

        private func Run(outputPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(outputPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(outputPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
