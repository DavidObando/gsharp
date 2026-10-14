// <copyright file="Adr0174SuspendCrossAssemblyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import Gsharp.Concurrency
import MetadataParameter = System.Reflection.Metadata.Parameter
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import System.Threading
import Xunit

/// ADR-0174 D4 across an assembly boundary: a `suspend func` compiled
/// into a library is a `ValueTask<R>` method carrying
/// `[Suspending]`; a G# consumer reads that from metadata, sees the
/// logical `R`, awaits implicitly inside a suspending caller, and blocks
/// through the root bridge (GS0558) inside a plain function — with no analysis
/// of the library re-run.
/// @remarks Discrimination witness (ADR-0154): a mutant that ignores the attribute on
/// import breaks (cref:SuspendFunc_InALibrary_IsAwaitedImplicitly_ByAConsumer)
/// — the consumer then sees `ValueTask[int32]` where it expects
/// `int32` and fails to compile.
open class Adr0174SuspendCrossAssemblyTests {
    @Fact
    func SuspendFunc_InALibrary_IsAwaitedImplicitly_ByAConsumer() {
        let (exit, output, compileLog) = CompileAndRun(`package App
import System
import Lib

suspend func twice(ch chan[int32]) int32 {
    return take(ch) + take(ch)
}

let ch = chan[int32](2)
put(ch, 2)
put(ch, 4)
Console.WriteLine(twice(ch))`)
        Assert.True(exit == 0, compileLog)
        Assert.DoesNotContain("GS0558", compileLog)
        Assert.Equal("6", output.Trim())
    }

    @Fact
    func SuspendFunc_InALibrary_CalledFromAPlainFunction_IsInferred_NoWarning() {
        // A plain caller of an imported suspending function becomes suspending
        // by inference (D4), so no bridge and no GS0558 remain.
        let (exit, output, compileLog) = CompileAndRun(`package App
import System
import Lib

func plain(ch chan[int32]) int32 {
    return take(ch) * 10
}

let ch = chan[int32](1)
put(ch, 3)
Console.WriteLine(plain(ch))`)
        Assert.True(exit == 0, compileLog)
        Assert.DoesNotContain("GS0558", compileLog)
        Assert.Equal("30", output.Trim())
    }

    @Fact
    func SuspendFunc_InALibrary_CalledFromAnOverridableMethod_BlocksAndWarns() {
        // An `open` method is an inference boundary: the call blocks through
        // the root bridge and GS0558 says so.
        let (exit, output, compileLog) = CompileAndRun(`package App
import System
import Lib

open class Reader {
    open func Read(ch chan[int32]) int32 {
        return take(ch) * 10
    }
}

let ch = chan[int32](1)
put(ch, 3)
Console.WriteLine(Reader().Read(ch))`)
        Assert.True(exit == 0, compileLog)
        Assert.Contains("GS0558", compileLog)
        Assert.Equal("30", output.Trim())
    }

    @Fact
    func HiddenContext_IsTheLastParameter_OptionalWithANullDefault() {
        // The ABI contract every foreign caller depends on: the context D7
        // threads is appended, not inserted, and it is optional — so a caller
        // written against the declared signature still binds.
        let tempDir = Directory.CreateTempSubdirectory("gs_0174_abi_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            let log = Compile(tempDir, "Lib.gs", ClassLibrary, libPath, "/target:library")
            Assert.True(File.Exists(libPath), "library compile failed:\n" + log)
            using let stream = File.OpenRead(libPath)
            using let peReader = PEReader(stream)
            let metadata = peReader.GetMetadataReader()
            let take = metadata
                .MethodDefinitions
                .Select(metadata.GetMethodDefinition)
                .Single((m MethodDefinition) -> metadata.GetString(m.Name) == "Take")
            let parameters = take
                .GetParameters()
                .Select(metadata.GetParameter)
                .OrderBy((p MetadataParameter) -> p.SequenceNumber)
                .ToList()
            let hidden = parameters[^1]
            Assert.Equal("<>ctx", metadata.GetString(hidden.Name))
            Assert.True(hidden.Attributes.HasFlag(ParameterAttributes.Optional))
            Assert.True(hidden.Attributes.HasFlag(ParameterAttributes.HasDefault))
            Assert.False(hidden.GetDefaultValue().IsNil)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func CSharpConsumer_CallsTheDeclaredSignature_AndMayPassAContext() {
        let tempDir = Directory.CreateTempSubdirectory("gs_0174_csharp_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            let log = Compile(tempDir, "Lib.gs", ClassLibrary, libPath, "/target:library")
            Assert.True(File.Exists(libPath), "library compile failed:\n" + log)
            const ConsumerSource = `using System;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Lib;

public static class Consumer
{
    public static async Task<int> Main()
    {
        var ch = new Chan<int>(4);
        var reader = new Reader();

        // Exactly the signatures the G# source declares: the
        // hidden context is optional, so C# omits it.
        await reader.Fill(ch, 3);
        Console.WriteLine("first=" + await reader.Take(ch));

        // ... and a C# caller that wants cancellation passes one.
        using var ctx = Context.None.WithCancel();
        Console.WriteLine("second=" + await reader.Take(ch, ctx));
        return 0;
    }
}`
            let references = TrustedPlatformAssemblies()
                .Concat([]string{libPath, Path.Combine(tempDir, "Gsharp.Runtime.Channels.dll")})
                .Where(File.Exists)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Consumer",
                []SyntaxTree{CSharpSyntaxTree.ParseText(ConsumerSource)},
                references,
                CSharpCompilationOptions(OutputKind.ConsoleApplication)
            )
            let consumerPath = Path.Combine(tempDir, "Consumer.dll")
            let result = compilation.Emit(consumerPath)
            Assert.True(
                result.Success,
                "C# consumer must compile against the G# signatures:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            let runtimeConfig = "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":" +
                "{\"name\":\"Microsoft.NETCore.App\",\"version\":\"" +
                Environment
                .Version
                .ToString(3) + "\"}}}"
            File.WriteAllText(Path.Combine(tempDir, "Consumer.runtimeconfig.json"), runtimeConfig)
            let (exit, output) = RunDotnet(consumerPath)
            Assert.Equal(0, exit)
            Assert.Contains("first=1", output, StringComparison.Ordinal)
            Assert.Contains("second=2", output, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func SuspendMethod_OfAnImportedBase_CalledThroughBase_IsAwaitedAndVerifies() {
        // Issue #4392: `base.M()` on a suspending method of a base class in
        // another assembly. The imported base call was never completed, so it
        // stayed typed ValueTask[string] and `"(" + base.M(x)` did not bind.
        // It is awaited now, from the suspending member, from a function
        // literal in it (through a forwarder) and from a plain member (the
        // blocking bridge), and the result verifies.
        const BaseLibrary = `package Lib

public open class Greeter {
    public open suspend func Greet(x int32) string {
        return "Greeter$x"
    }
}`
        const AppSource = `package App
import System
import Lib

class Loud : Greeter {
    suspend func Twice(x int32) string {
        let f = () -> base.Greet(x + 1)
        return "(" + base.Greet(x) + "," + f() + "," + Greet(x + 2) + ")"
    }

    func Plain() string {
        return base.Greet(9)
    }
}

suspend func run() string {
    let g = Loud()
    return g.Twice(1) + " " + g.Plain()
}

Console.WriteLine(run())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4392_xasm_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            let libLog = Compile(tempDir, "Lib.gs", BaseLibrary, libPath, "/target:library")
            Assert.True(File.Exists(libPath), "library compile failed:\n" + libLog)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(tempDir, "App.gs", AppSource, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), "app compile failed:\n" + appLog)
            IlVerifier.Verify(appPath, []string{libPath, Path.Combine(tempDir, "Gsharp.Runtime.Channels.dll")})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, output)
            Assert.Equal("(Greeter1,Greeter2,Greeter3) Greeter9", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func SuspendMethod_OfAnImportedBase_CalledThroughBase_ObservesTheCallersContext() {
        // Issue #4392 (review): `base.M()` on an imported suspending method
        // passes the caller's context, so cancelling the caller's scope
        // reaches the base method's `select`. Without it the base method ran
        // under `Context.None`, never saw the cancellation and waited forever
        // on a channel nobody sends to.
        const BaseLibrary = `package Lib

public open class Waiter {
    public open suspend func Wait(ch chan[int32]) string {
        var outcome = "none"
        select {
        case cancelled {
            outcome = "cancelled"
        }
        case <-ch {
            outcome = "received"
        }
        }
        return outcome
    }
}`
        const AppSource = `package App
import System
import Lib

class Relay : Waiter {
    suspend func Forward(ch chan[int32]) string {
        return base.Wait(ch)
    }
}

suspend func run() string {
    var outcome = "none"
    scope {
        let never = chan[int32](1)
        ctx.TryCancel()
        outcome = Relay().Forward(never)
    }
    return outcome
}

Console.WriteLine(run())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4392_ctx_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            let libLog = Compile(tempDir, "Lib.gs", BaseLibrary, libPath, "/target:library")
            Assert.True(File.Exists(libPath), "library compile failed:\n" + libLog)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(tempDir, "App.gs", AppSource, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), "app compile failed:\n" + appLog)
            IlVerifier.Verify(appPath, []string{libPath, Path.Combine(tempDir, "Gsharp.Runtime.Channels.dll")})
            let (exit, output) = RunDotnet(appPath, TimeSpan.FromSeconds(60))
            Assert.True(exit == 0, output)
            Assert.Equal("cancelled", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func SuspendOverrides_OfImportedVirtualAndAbstractMethods_UseLogicalSignatures() {
        // Issue #4413 / ADR-0154 witness: before the fix both suspend
        // overrides report GS0185 because imported signatures expose the
        // physical ValueTask return and hidden Context parameter.
        const BaseLibrary = `package Lib

public open class Base {
    public open suspend func Format[T](value T) string {
        return "base:$value"
    }

    public open suspend func Required(value string?) string;

    public open func Plain(value int32) string {
        return "plain:$value"
    }
}`
        const AppSource = `package App
import System
import Lib

class Derived : Base {
    public override suspend func Format[T](value T) string {
        return "derived(" + base.Format[T](value) + ")"
    }

    public override suspend func Required(value string?) string {
        return "required:$value"
    }

    public override func Plain(value int32) string {
        return "derived-" + base.Plain(value)
    }
}

suspend func run() {
    let value Base = Derived()
    Console.WriteLine(value.Format[string]("x"))
    Console.WriteLine(value.Required("y"))
    Console.WriteLine(value.Plain(7))
}

run()`
        let tempDir = Directory.CreateTempSubdirectory("gs_4413_override_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            let libLog = Compile(tempDir, "Lib.gs", BaseLibrary, libPath, "/target:library")
            Assert.True(File.Exists(libPath), "library compile failed:\n" + libLog)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(tempDir, "App.gs", AppSource, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), "app compile failed:\n" + appLog)
            Assert.DoesNotContain("GS0185", appLog, StringComparison.Ordinal)
            IlVerifier.Verify(appPath, []string{libPath, Path.Combine(tempDir, "Gsharp.Runtime.Channels.dll")})
            {
                using let stream = File.OpenRead(appPath)
                {
                    using let peReader = PEReader(stream)
                    let metadata = peReader.GetMetadataReader()
                    let derived = metadata
                        .TypeDefinitions
                        .Select(metadata.GetTypeDefinition)
                        .Single((type TypeDefinition) -> metadata.GetString(type.Name) == "Derived")
                    Assert.Equal(3, derived.GetMethodImplementations().Count)
                }
            }
            let assemblies = EmittedFixture.LoadTogether(
                libPath,
                Path.Combine(tempDir, "Gsharp.Runtime.Channels.dll"),
                appPath
            )
            let derivedType = assemblies[^1].GetType("App.Derived")!!
            AssertPhysicalSuspendOverride(derivedType.GetMethod("Format")!!, "Lib.Base", logicalParameterCount: 1)
            AssertPhysicalSuspendOverride(derivedType.GetMethod("Required")!!, "Lib.Base", logicalParameterCount: 1)
            let plain = derivedType.GetMethod("Plain")!!
            Assert.Equal(typeof(string), plain.ReturnType)
            Assert.Single(plain.GetParameters())
            Assert.Equal("Lib.Base", plain.GetBaseDefinition().DeclaringType!!.FullName)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, output)
            Assert.Equal(
                []string{"derived(base:x)", "required:y", "derived-plain:7"},
                output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func ImportedSuspendOverride_GenuineSignatureMismatch_StillReportsGS0185() {
        const BaseLibrary = `package Lib

public open class Base {
    public open suspend func Format[T](value T) string {
        return "$value"
    }

    public open suspend func Covariant() object {
        return "base"
    }
}`
        const AppSource = `package App
import Lib

class Broken : Base {
    override suspend func Format[T, U](value T) string {
        return "$value"
    }

    override suspend func Covariant() string {
        return "derived"
    }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_4413_mismatch_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            let libLog = Compile(tempDir, "Lib.gs", BaseLibrary, libPath, "/target:library")
            Assert.True(File.Exists(libPath), "library compile failed:\n" + libLog)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(tempDir, "App.gs", AppSource, appPath, "/target:library", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), "mismatched override unexpectedly compiled")
            Assert.Equal(2, appLog.Split("GS0185", StringSplitOptions.None).Length - 1)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func ImportedSuspendOverride_RejectsPhysicalAbiColoringMismatches() {
        const ClrBaseSource = `using System.Threading.Tasks;
using Gsharp.Concurrency;

namespace ClrLib;

public class OrdinaryBase
{
    public virtual ValueTask<string> Format(string value) => new(value);
}

public class MalformedBase
{
    [Suspending]
    public virtual ValueTask<string> Format(string value) => new(value);
}`
        const SuspendAppSource = `package App
import ClrLib

class BadOrdinary : OrdinaryBase {
    override suspend func Format(value string) string {
        return value
    }
}

class BadMalformed : MalformedBase {
    override suspend func Format(value string) string {
        return value
    }
}`
        const GSharpBaseSource = `package Lib

public open class SuspendBase {
    public open suspend func Format(value string) string {
        return value
    }
}`
        const PlainAppSource = `package App
import System.Threading.Tasks
import Lib

class BadPlain : SuspendBase {
    override func Format(value string) ValueTask[string] {
        return ValueTask[string](value)
    }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_4413_coloring_").FullName
        try {
            let clrLibPath = Path.Combine(tempDir, "ClrLib.dll")
            CompileCSharpLibrary(ClrBaseSource, clrLibPath)
            let suspendAppPath = Path.Combine(tempDir, "SuspendApp.dll")
            let suspendLog = Compile(
                tempDir,
                "SuspendApp.gs",
                SuspendAppSource,
                suspendAppPath,
                "/target:library",
                "/reference:" + clrLibPath
            )
            Assert.False(File.Exists(suspendAppPath), "ABI-mismatched suspend overrides unexpectedly compiled")
            Assert.Equal(2, suspendLog.Split("GS0185", StringSplitOptions.None).Length - 1)
            let gsLibPath = Path.Combine(tempDir, "Lib.dll")
            let libLog = Compile(tempDir, "Lib.gs", GSharpBaseSource, gsLibPath, "/target:library")
            Assert.True(File.Exists(gsLibPath), "library compile failed:\n" + libLog)
            let plainAppPath = Path.Combine(tempDir, "PlainApp.dll")
            let plainLog = Compile(
                tempDir,
                "PlainApp.gs",
                PlainAppSource,
                plainAppPath,
                "/target:library",
                "/reference:" + gsLibPath
            )
            Assert.False(File.Exists(plainAppPath), "plain override of a suspend slot unexpectedly compiled")
            Assert.Contains("GS0185", plainLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func SuspendOverride_InTheSameCompilation_RemainsValid() {
        let (exit, output, compileLog) = CompileAndRun(`package App
import System

open class Base {
    open suspend func Format(value string?) string {
        return "base:$value"
    }
}

class Derived : Base {
    override suspend func Format(value string?) string {
        return "derived(" + base.Format(value) + ")"
    }
}

let value Base = Derived()
Console.WriteLine(value.Format("same"))`)
        Assert.True(exit == 0, compileLog + output)
        Assert.DoesNotContain("GS0185", compileLog, StringComparison.Ordinal)
        Assert.Equal("derived(base:same)", output.Trim())
    }

    shared {
        private const Library string = `package Lib

public suspend func take(ch chan[int32]) int32 {
    return <-ch
}

public suspend func put(ch chan[int32], v int32) {
    ch <- v
}`

        private const ClassLibrary string = `package Lib
public class Reader {
    public func Take(ch in chan[int32]) int32 {
        return <-ch
    }

    public func Fill(ch out chan[int32], n int32) {
        for i in 1 ... n + 1 {
            ch <- i
        }
    }
}`

        private func AssertPhysicalSuspendOverride(
            method MethodInfo?,
            expectedBaseType string,
            logicalParameterCount int32
        ) {
            Assert.Equal("System.Threading.Tasks.ValueTask`1", method!!.ReturnType.GetGenericTypeDefinition().FullName)
            Assert.Equal(typeof(string), method!!.ReturnType.GetGenericArguments()[0])
            let parameters = method!!.GetParameters()
            Assert.Equal(logicalParameterCount + 1, parameters.Length)
            Assert.Equal("<>ctx", parameters[^1].Name)
            Assert.Equal("Gsharp.Concurrency.Context", parameters[^1].ParameterType.FullName)
            Assert.Equal(expectedBaseType, method!!.GetBaseDefinition().DeclaringType!!.FullName)
        }

        private func CompileCSharpLibrary(source string, outputPath string) {
            let references = TrustedPlatformAssemblies()
                .Append(typeof(SuspendingAttribute).Assembly.Location)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(outputPath),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(outputPath)
            Assert.True(
                result.Success,
                "C# library compile failed:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
                )
            )
        }

        private func CompileAndRun(appSource string)(Exit int32, Output string, CompileLog string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_0174_xasm_").FullName
            try {
                let libPath = Path.Combine(tempDir, "Lib.dll")
                let libLog = Compile(tempDir, "Lib.gs", Library, libPath, "/target:library")
                Assert.True(File.Exists(libPath), "library compile failed:\n" + libLog)
                let appPath = Path.Combine(tempDir, "App.dll")
                let appLog = Compile(tempDir, "App.gs", appSource, appPath, "/target:exe", "/reference:" + libPath)
                if !File.Exists(appPath) {
                    return (-1, string.Empty, appLog)
                }
                let (exit, output) = RunDotnet(appPath)
                return (exit, output, appLog)
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) -> RunDotnet(
            assemblyPath,
            Timeout.InfiniteTimeSpan
        )

        private func RunDotnet(assemblyPath string, timeout TimeSpan)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(timeout) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                return (-1, "timed out after " + timeout.ToString() + ":\n" + stdout.Result + stderr.Result)
            }
            process.WaitForExit()
            output.Append(stdout.Result)
            output.Append(stderr.Result)
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
