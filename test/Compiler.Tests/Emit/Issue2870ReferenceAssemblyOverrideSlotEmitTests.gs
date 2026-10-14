// <copyright file="Issue2870ReferenceAssemblyOverrideSlotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Generic
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
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
