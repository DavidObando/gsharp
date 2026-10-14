// <copyright file="Issue2667AsyncVoidImportedBaseReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2667: imported non-virtual base calls in async instance methods must
/// run through a receiver-safe forwarder instead of using the hoisted
/// `<>4__this` field directly as the call's special `this`.
class Issue2667AsyncVoidImportedBaseReceiverEmitTests {
    @Fact
    func AppMainWindowAsyncVoidOnOpened_MoveNext_ILVerifiesAndRuns() {
        using let fixture = Issue2667AsyncVoidImportedBaseReceiverEmitTests.Fixture()
        let result = fixture.Compile(`package Oahu.App.Avalonia
import System
import System.Threading.Tasks
import Avalonia.Controls

open class MainWindow : Window {
    protected override async func OnOpened(e EventArgs) void {
        base.OnOpened(e)
        await Task.CompletedTask
        Console.WriteLine("async-opened")
    }
}

MainWindow().Open()`)
        Assert.Equal(
            "base-opened${Environment.NewLine}async-opened${Environment.NewLine}",
            fixture.Run(result.OutputPath)
        )
        let assembly = EmittedFixture.Load(result.OutputPath)
        let mainWindow = assembly.GetType("Oahu.App.Avalonia.MainWindow")!!
        Assert.Equal(
            typeof(Void),
            mainWindow.GetMethod("OnOpened", BindingFlags.Instance | BindingFlags.NonPublic)!!.ReturnType
        )
        Assert.Contains(
            mainWindow.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly),
            (method MethodInfo) -> method.Name.StartsWith("<>n__", StringComparison.Ordinal)
        )
        Assert.Contains(
            mainWindow.GetNestedTypes(BindingFlags.NonPublic),
            (type Type) -> type.Name.Contains("<OnOpened>d__", StringComparison.Ordinal)
        )
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{fixture.LibraryPath})
    }

    @Fact
    func NonAsyncImportedBaseCall_DoesNotSynthesizeForwarder() {
        using let fixture = Issue2667AsyncVoidImportedBaseReceiverEmitTests.Fixture()
        let result = fixture.Compile(`package Issue2667.Sync
import System
import Avalonia.Controls

open class MainWindow : Window {
    protected override func OnOpened(e EventArgs) {
        base.OnOpened(e)
        Console.WriteLine("sync-opened")
    }
}

MainWindow().Open()`)
        Assert.Equal(
            "base-opened${Environment.NewLine}sync-opened${Environment.NewLine}",
            fixture.Run(result.OutputPath)
        )
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{fixture.LibraryPath})
        AssertNoForwarder(result.OutputPath, "Issue2667.Sync.MainWindow")
    }

    @Fact
    func CapturedAsyncVoidLiteral_InsideAsyncMethod_ILVerifiesAndRuns() {
        using let fixture = Issue2667AsyncVoidImportedBaseReceiverEmitTests.Fixture()
        let result = fixture.Compile(`package Issue2667.CapturedLiteral
import System
import System.Threading.Tasks

async func Run() {
    let seed = 7
    let handler EventHandler = async func (sender object?, e EventArgs) void {
        await Task.Delay(1)
        Console.WriteLine(seed)
    }

    handler(nil, EventArgs.Empty)
    await Task.Delay(100)
}

Run().Wait()`)
        Assert.Equal("7${Environment.NewLine}", fixture.Run(result.OutputPath))
        IlVerifier.Verify(result.OutputPath)
    }

    @Fact
    func AsyncOrdinaryVirtualCall_PreservesDispatchWithoutForwarder() {
        using let fixture = Issue2667AsyncVoidImportedBaseReceiverEmitTests.Fixture()
        let result = fixture.Compile(`package Issue2667.Virtual
import System
import System.Threading.Tasks
import Avalonia.Controls

open class MainWindow : Window {
    override func Describe() string -> "derived"

    public async func DescribeAsync() string {
        await Task.CompletedTask
        return Describe()
    }
}

Console.WriteLine(MainWindow().DescribeAsync().Result)`)
        Assert.Equal("derived${Environment.NewLine}", fixture.Run(result.OutputPath))
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{fixture.LibraryPath})
        AssertNoForwarder(result.OutputPath, "Issue2667.Virtual.MainWindow")
    }

    private class Fixture : IDisposable {
        private let directory string = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2667AsyncVoidImportedBaseReceiverEmitTests",
            Guid.NewGuid().ToString("N")
        )

        init() {
            Directory.CreateDirectory(directory)
            LibraryPath = Path.Combine(directory, "Avalonia.Controls.dll")
            EmitLibrary(LibraryPath)
        }

        prop LibraryPath string {
            get;
        }

        func Compile(source string) Issue2667AsyncVoidImportedBaseReceiverEmitTests.CompileResult {
            let sourcePath = Path.Combine(directory, "App.gs")
            let outputPath = Path.Combine(directory, "App.dll")
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
                        "/reference:" + LibraryPath,
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
            return Issue2667AsyncVoidImportedBaseReceiverEmitTests.CompileResult(outputPath)
        }

        func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        func Dispose() {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }

        shared {
            private func EmitLibrary(path string) {
                let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                    Path.PathSeparator
                )
                    .Select((file string) -> MetadataReference.CreateFromFile(file))
                let compilation = CSharpCompilation.Create(
                    "Avalonia.Controls",
                    []SyntaxTree{
                        CSharpSyntaxTree.ParseText(Issue2667AsyncVoidImportedBaseReceiverEmitTests.FixtureSource)
                    },
                    references,
                    CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                let result = compilation.Emit(path)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
        }
    }

    private data class CompileResult(OutputPath string) : IEquatable[
        Issue2667AsyncVoidImportedBaseReceiverEmitTests.CompileResult
    ] { }

    shared {
        private const FixtureSource string = `using System;

namespace Avalonia.Controls;

public class Window
{
    public void Open() => OnOpened(EventArgs.Empty);
    protected virtual void OnOpened(EventArgs e) => Console.WriteLine("base-opened");
    public virtual string Describe() => "base";
}`

        private func AssertNoForwarder(assemblyPath string, typeName string) {
            let type = EmittedFixture.Load(assemblyPath).GetType(typeName)!!
            Assert.DoesNotContain(
                type.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly),
                (method MethodInfo) -> method.Name.StartsWith("<>n__", StringComparison.Ordinal)
            )
        }
    }
}
