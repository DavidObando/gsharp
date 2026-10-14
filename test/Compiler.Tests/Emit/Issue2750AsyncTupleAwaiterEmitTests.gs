// <copyright file="Issue2750AsyncTupleAwaiterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

class Issue2750AsyncTupleAwaiterEmitTests {
    @Fact
    func Await_TaskOfTuple_VerifiesAndRuns() {
        const helperSource = `using System;
using System.Net.Http;
using System.Threading.Tasks;

namespace ImportedTuples;

public static class TupleApi
{
    public static async Task<(Uri Address, HttpResponseMessage Response)> FetchAsync()
    {
        await Task.Yield();
        return (new Uri("https://example.test"), new HttpResponseMessage());
    }

    public static async Task<(
        int One, int Two, int Three, int Four,
        int Five, int Six, int Seven, int Eight)> NamedEightAsync()
    {
        await Task.Yield();
        return (1, 2, 3, 4, 5, 6, 7, 8);
    }

    public static async Task<(T, T, T, T, T, T, T, T)> GenericEightAsync<T>(T value)
    {
        await Task.Yield();
        return (value, value, value, value, value, value, value, value);
    }
}`
        const source = `package Issue2750

import System
import System.Net.Http
import System.Threading.Tasks
import ImportedTuples

async func NullablePairAsync() (Uri?, HttpResponseMessage?) {
    await Task.Yield()
    return (Uri("https://nullable.test"), HttpResponseMessage())
}

async func FinalAddressAsync() Uri? {
    await Task.Yield()
    return Uri("https://final.test")
}

async func TripleAsync() (int32, string, bool) {
    await Task.Yield()
    return (3, "triple", true)
}

async func SevenAsync() (int32, int32, int32, int32, int32, int32, int32) {
    await Task.Yield()
    return (1, 2, 3, 4, 5, 6, 7)
}

async func EightAsync() (int32, int32, int32, int32, int32, int32, int32, int32) {
    await Task.Yield()
    return (1, 2, 3, 4, 5, 6, 7, 8)
}

async func NineAsync() (int32, int32, int32, int32, int32, int32, int32, int32, int32) {
    await Task.Yield()
    return (1, 2, 3, 4, 5, 6, 7, 8, 9)
}

async func FifteenAsync() (int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32, int32) {
    await Task.Yield()
    return (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)
}

async func NestedAsync() ((int32, string), (bool, float64)) {
    await Task.Yield()
    return ((4, "nested"), (true, 2.5))
}

async func GenericPairAsync[T](value T) (T, T) {
    await Task.Yield()
    return (value, value)
}

async func RunAsync() Uri? {
    let firstAddress = await Task.FromResult(Uri("https://first.test"))
    Console.WriteLine(firstAddress.Host)
    let (address, response) = await TupleApi.FetchAsync()
    Console.WriteLine(address.Host)
    response.Dispose()
    let (number, text) = await Task.FromResult((8, "generic"))
    Console.WriteLine(text)
    let (nullableAddress, nullableResponse) = await NullablePairAsync()
    Console.WriteLine(nullableAddress!!.Host)
    nullableResponse!!.Dispose()
    let (three, tripleText, flag) = await TripleAsync()
    Console.WriteLine("$three:$tripleText:$flag")
    let (_, _, _, _, _, _, seven) = await SevenAsync()
    Console.WriteLine(seven)
    let eight = await EightAsync()
    Console.WriteLine(eight.Item8)
    let nine = await NineAsync()
    Console.WriteLine(nine.Item9)
    let fifteen = await FifteenAsync()
    Console.WriteLine(fifteen.Item15)
    let namedEight = await TupleApi.NamedEightAsync()
    Console.WriteLine(namedEight.Item8)
    let nested = await NestedAsync()
    Console.WriteLine("${nested.Item1.Item2}:${nested.Item2.Item2}")
    let (genericLeft, genericRight) = await GenericPairAsync[string]("generic-pair")
    Console.WriteLine("$genericLeft:$genericRight")
    let genericEight = await TupleApi.GenericEightAsync[string]("unused")
    Console.WriteLine(number)
    return await FinalAddressAsync()
}

Console.WriteLine(RunAsync().GetAwaiter().GetResult()!!.Host)`
        Assert.Equal(
            "first.test${Environment.NewLine}example.test${Environment.NewLine}generic${Environment.NewLine}nullable.test${Environment.NewLine}3:triple:True${Environment.NewLine}7${Environment.NewLine}8${Environment.NewLine}9${Environment.NewLine}15${Environment.NewLine}8${Environment.NewLine}nested:2.5${Environment.NewLine}generic-pair:generic-pair${Environment.NewLine}8${Environment.NewLine}final.test${Environment.NewLine}",
            CompileVerifyAndRun(source, helperSource)
        )
    }

    @Fact
    func Await_DistinctNonTupleSymbolicResults_VerifiesAndRuns() {
        const source = `package Issue2750Controls

import System
import System.Threading.Tasks

class Box(Value string) { }

async func BoxAsync() Box? {
    await Task.Yield()
    return Box("box")
}

async func AddressAsync() Uri? {
    await Task.Yield()
    return Uri("https://control.test")
}

async func RunAsync() Uri? {
    let box = await BoxAsync()
    Console.WriteLine(box!!.Value)
    let number = await Task.FromResult(42)
    Console.WriteLine(number)
    return await AddressAsync()
}

Console.WriteLine(RunAsync().GetAwaiter().GetResult()!!.Host)`
        Assert.Equal(
            "box${Environment.NewLine}42${Environment.NewLine}control.test${Environment.NewLine}",
            CompileVerifyAndRun(source)
        )
    }

    shared {
        private func CompileVerifyAndRun(source string, helperSource string? = nil) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2750Emit")
            Directory.CreateDirectory(directory)
            let helperPath string? = if helperSource == nil {
                default(string?)
            } else {
                BuildHelper(directory, helperSource)
            }
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0"}
                if helperPath != nil {
                    args.Add("/r:" + helperPath)
                }
                args.Add(sourcePath)
                let exitCode = Program.Main(args.ToArray())
                Assert.True(exitCode == 0, "compile failed ($exitCode):${Environment.NewLine}$stdout$stderr")
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            IlVerifier.Verify(
                outputPath,
                if helperPath == nil {
                    default([]?string)
                } else {
                    []string{helperPath}
                }
            )
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                        outputPath
                    },
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            let output = process!!.StandardOutput.ReadToEnd()
            let error = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process!!.ExitCode == 0, error)
            return output.ReplaceLineEndings(Environment.NewLine)
        }

        private func BuildHelper(directory string, source string) string {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where(File.Exists)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "ImportedTuples",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, "ImportedTuples.dll")
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }
    }
}
