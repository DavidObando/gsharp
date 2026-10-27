// <copyright file="Issue2870ReferenceAssemblyOverrideSlotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #2870 — `MemberDefEmitter.EmitPropertyGetter`/`EmitPropertySetter`
/// tested `IsVirtual` before `IsOverride`. The two flags are
/// independent (`IsVirtual` means "declared `open`",
/// `IsOverride` means "overrides a base property"), so an
/// `open override prop` set both, took the virtual branch, and wrongly
/// acquired `NewSlot`.
///
/// The implementation assembly routes computed-body accessors through
/// `FunctionEmitter` and got this right, so the defect only surfaced on
/// the path that emits every property here: the metadata-only
/// (`/refout`) emit. MSBuild passes the REFERENCE assembly to downstream
/// compilations, so a consumer saw the override as a fresh virtual, which made
/// `PropertySymbol.IsAbstract` true, marked the declaring type abstract,
/// and produced `GS0386` at every construction site.
open class Issue2870ReferenceAssemblyOverrideSlotEmitTests {
    @Theory
    @InlineData("nullablecopy5296.ref.dll")
    @InlineData("unrelated.contract.dll")
    @InlineData("bridge.contract.dll")
    func TransitiveSignaturesResolveExplicitReferenceIdentityRegardlessOfFileName(referenceFileName string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
            .Split(Path.PathSeparator)
            .Where(
            (path string) -> string.Equals(
                Path.GetDirectoryName(path),
                runtimeDirectory,
                StringComparison.OrdinalIgnoreCase
            )
        )
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        Assert.NotEmpty(references)
        let contracts = Path.Combine(fixture.Directory, "contracts")
        Directory.CreateDirectory(contracts)
        let producer = Path.Combine(fixture.Directory, "nullablecopy5296.dll")
        let producerReference = Path.Combine(contracts, referenceFileName)
        let bridge = Path.Combine(fixture.Directory, "LiteralBridge5419.dll")
        let bridgeContracts = Path.Combine(contracts, "bridge")
        Directory.CreateDirectory(bridgeContracts)
        let bridgeReference = Path.Combine(bridgeContracts, "bridge.contract.dll")
        let producerResult = CompileStandalone(
            fixture.Directory,
            "nullablecopy5296",
            "package nullablecopy5296\npublic data class C[T](Value T)",
            references,
            "/refout:" + producerReference
        )
        Assert.True(producerResult.Code == 0, producerResult.Diagnostics)
        let bridgeResult = CompileStandalone(fixture.Directory, "LiteralBridge5419", `package LiteralBridge5419
import nullablecopy5296
public class Bridge { shared { public func Make() C[string?] -> C[string?](nil) } }`, references, "/r:" +
                producer, "/refout:" + bridgeReference)
        Assert.True(bridgeResult.Code == 0, bridgeResult.Diagnostics)
        let verifierReferences = references.Concat([]string{producer, bridge}).ToArray()
        for image in[]string{producer, producerReference, bridge, bridgeReference} {
            VerifyStrictImage(image, verifierReferences)
        }
        let producerBytes = File.ReadAllBytes(producerReference)
        let bridgeBytes = File.ReadAllBytes(bridgeReference)
        const consumer = `import LiteralBridge5419
let value = Bridge.Make()
System.Console.WriteLine(value.Value == nil)`
        for useReferences in[]bool{false, true} {
            let extra = []string{
                "/target:exe",
                "/r:" + if useReferences {
                    bridgeReference
                } else {
                    bridge
                },
                "/r:" + if useReferences {
                    producerReference
                } else {
                    producer
                },
                "/refout:" + Path.Combine(fixture.Directory, "Consumer.ref.dll")
            }
            let result = CompileStandalone(fixture.Directory, "Consumer", consumer, references, extra)
            Assert.True(result.Code == 0, result.Diagnostics)
            Assert.DoesNotContain("nullablecopy5296,", result.Diagnostics, StringComparison.Ordinal)
            let image = Path.Combine(fixture.Directory, "Consumer.dll")
            let firstImage = File.ReadAllBytes(image)
            let firstPdb = File.ReadAllBytes(Path.ChangeExtension(image, ".pdb"))
            let firstReference = File.ReadAllBytes(Path.Combine(fixture.Directory, "Consumer.ref.dll"))
            let repeat = CompileStandalone(fixture.Directory, "Consumer", consumer, references, extra)
            Assert.True(repeat.Code == 0, repeat.Diagnostics)
            Assert.Equal(firstImage, File.ReadAllBytes(image))
            Assert.Equal(firstPdb, File.ReadAllBytes(Path.ChangeExtension(image, ".pdb")))
            Assert.Equal(firstReference, File.ReadAllBytes(Path.Combine(fixture.Directory, "Consumer.ref.dll")))
            VerifyStrictImage(image, verifierReferences)
            Assert.Equal(Encoding.UTF8.GetBytes("True" + Environment.NewLine), fixture.RunBytes(image))
        }
        Assert.Equal(producerBytes, File.ReadAllBytes(producerReference))
        Assert.Equal(bridgeBytes, File.ReadAllBytes(bridgeReference))
        let rejected = CompileStandalone(
            fixture.Directory,
            "Rejected",
            consumer,
            references,
            "/target:exe",
            "/r:" + bridgeReference,
            "/refout:" + Path.Combine(fixture.Directory, "Rejected.ref.dll")
        )
        Assert.NotEqual(0, rejected.Code)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.ref.dll")))
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.pdb")))
        let errors = Regex.Matches(rejected.Diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`)
        Assert.Equal(2, errors.Count)
        Assert.Equal("GS0159", errors[0].Groups[5].Value)
        Assert.Equal("(2,20,2,26): error GS0159:", errors[0].Value)
        Assert.Equal("GS0158", errors[1].Groups[5].Value)
        Assert.Equal("(3,32,3,37): error GS0158:", errors[1].Value)
        Assert.Contains("warning GS9100:", rejected.Diagnostics, StringComparison.Ordinal)
        Assert.Contains("nullablecopy5296", rejected.Diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func OverridingDataClassProperty_HasNoNewSlotInEitherAssembly() {
        const source = `package i2870a

open data class CallbackChallenge {
    open prop Kind string {
        get;
    }
}

open data class CaptchaChallenge(ImageBytes []uint8) : CallbackChallenge {
    open override prop Kind string -> "captcha"
}`
        let (implementation, reference) = CompileWithReference(source, "i2870a.dll")
        AssertNoNewSlot(implementation, "CaptchaChallenge", "get_Kind")
        AssertNoNewSlot(reference, "CaptchaChallenge", "get_Kind")
        AssertNewSlot(implementation, "CallbackChallenge", "get_Kind")
        AssertNewSlot(reference, "CallbackChallenge", "get_Kind")
    }

    @Fact
    func OverridingClassProperty_HasNoNewSlotInEitherAssembly() {
        const source = `package i2870b

open class Shape {
    open prop Name string {
        get;
    }
}

open class Square : Shape {
    open override prop Name string -> "square"
}`
        let (implementation, reference) = CompileWithReference(source, "i2870b.dll")
        AssertNoNewSlot(implementation, "Square", "get_Name")
        AssertNoNewSlot(reference, "Square", "get_Name")
    }

    @Fact
    func OverridingSettableProperty_HasNoNewSlotInEitherAssembly() {
        // The setter emitter carries the same ordering bug as the getter.
        const source = `package i2870c

open class Holder {
    open prop Value string {
        get;
        set;
    }
}

open class Derived : Holder {
    private var backing string = ""

    open override prop Value string {
        get -> this.backing
        set { this.backing = value }
    }
}`
        let (implementation, reference) = CompileWithReference(source, "i2870c.dll")
        AssertNoNewSlot(implementation, "Derived", "get_Value")
        AssertNoNewSlot(implementation, "Derived", "set_Value")
        AssertNoNewSlot(reference, "Derived", "get_Value")
        AssertNoNewSlot(reference, "Derived", "set_Value")
    }

    @Fact
    func ConsumerCompilingAgainstReferenceAssembly_CanConstructTheOverridingType() {
        // End-to-end guard: this is exactly what MSBuild does for a
        // ProjectReference, and what produced GS0386 in the Oahu migration.
        const library = `package i2870lib

open data class CallbackChallenge {
    open prop Kind string {
        get;
    }
}

open data class CaptchaChallenge(ImageBytes []uint8) : CallbackChallenge {
    open override prop Kind string -> "captcha"
}`
        const consumer = `package i2870d
import i2870lib

func Main() {
    let c = CaptchaChallenge([]uint8{1, 2})
    System.Console.WriteLine(c.Kind)
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_2870_consumer_").FullName
        try {
            let libSrc = Path.Combine(tempDir, "i2870lib.gs")
            let libDll = Path.Combine(tempDir, "impl", "i2870lib.dll")
            let libRef = Path.Combine(tempDir, "ref", "i2870lib.dll")
            Directory.CreateDirectory(Path.GetDirectoryName(libDll)!!)
            Directory.CreateDirectory(Path.GetDirectoryName(libRef)!!)
            File.WriteAllText(libSrc, library)
            Compile(
                []string{"/out:" + libDll, "/refout:" + libRef, "/target:library", "/targetframework:net10.0", libSrc}
            )
            let consumerSrc = Path.Combine(tempDir, "consumer.gs")
            File.WriteAllText(consumerSrc, consumer)
            // Compiling against the REFERENCE assembly is the case that broke.
            Compile(
                []string{
                    "/out:" + Path.Combine(tempDir, "consumer.dll"),
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/r:" + libRef,
                    consumerSrc
                }
            )
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func NonOverridingVirtualProperty_KeepsNewSlot() {
        // Control: a property that genuinely introduces a virtual slot must
        // still carry NewSlot in both assemblies.
        const source = `package i2870e

open class Root {
    open prop Tag string -> "root"
}`
        let (implementation, reference) = CompileWithReference(source, "i2870e.dll")
        AssertNewSlot(implementation, "Root", "get_Tag")
        AssertNewSlot(reference, "Root", "get_Tag")
    }

    shared {
        private func VerifyStrictImage(image string, references[]string) {
            var report = string.Empty
            IlVerifier.Verify(
                image,
                references,
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
        }

        private func CompileStandalone(
            directory string,
            name string,
            source string,
            references[]string,
            extra ...string
        )(Code int32, Diagnostics string) {
            let sourcePath = Path.Combine(directory, name + ".gs")
            File.WriteAllText(sourcePath, source)
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = directory
            }
            for argument in[]string{
                typeof(Program).Assembly.Location,
                "/target:library",
                "/targetframework:net10.0",
                "/deterministic+",
                "/debug:portable",
                "/out:" + Path.Combine(directory, name + ".dll"),
                sourcePath
            }
                .Concat(references.Select((path string) -> "/r:" + path)).Concat(extra) {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start)!!
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("Standalone compiler exceeded its deadline.")
            }
            return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
        }

        private func AssertNoNewSlot(assemblyPath string, typeName string, methodName string) {
            let attributes = ReadMethodAttributes(assemblyPath, typeName, methodName)
            Assert.True(
                (attributes & MethodAttributes.Virtual) != 0,
                "$typeName::$methodName in '${Path.GetFileName(assemblyPath)}' should be virtual but is $attributes."
            )
            Assert.True(
                (attributes & MethodAttributes.NewSlot) == 0,
                "$typeName::$methodName in '${Path.GetFileName(assemblyPath)}' overrides a base slot " +
                    "and must not carry NewSlot, but is $attributes."
            )
        }

        private func AssertNewSlot(assemblyPath string, typeName string, methodName string) {
            let attributes = ReadMethodAttributes(assemblyPath, typeName, methodName)
            Assert.True(
                (attributes & MethodAttributes.NewSlot) != 0,
                "$typeName::$methodName in '${Path.GetFileName(assemblyPath)}' introduces a virtual slot " +
                    "and must carry NewSlot, but is $attributes."
            )
        }

        private func ReadMethodAttributes(assemblyPath string, typeName string, methodName string) MethodAttributes {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            for typeHandle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(typeHandle)
                if !string.Equals(reader.GetString(type.Name), typeName, StringComparison.Ordinal) {
                    continue
                }
                for methodHandle in type.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    if string.Equals(reader.GetString(method.Name), methodName, StringComparison.Ordinal) {
                        return method.Attributes
                    }
                }
            }
            throw InvalidOperationException("'$typeName::$methodName' not found in '$assemblyPath'.")
        }

        private func CompileWithReference(source string, outputName string)(Implementation string, Reference string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_2870_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, outputName)
            let refPath = Path.Combine(
                tempDir,
                Path.GetFileNameWithoutExtension(outputName) + ".ref" + Path.GetExtension(outputName)
            )
            File.WriteAllText(srcPath, source)
            Compile(
                []string{
                    "/out:" + outPath,
                    "/refout:" + refPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    srcPath
                }
            )
            return (outPath, refPath)
        }

        private func Compile(args[]string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }
    }
}
