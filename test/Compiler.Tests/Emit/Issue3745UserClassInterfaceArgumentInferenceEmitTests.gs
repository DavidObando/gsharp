// <copyright file="Issue3745UserClassInterfaceArgumentInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Reflection.Metadata
import Xunit

/// Issue #3745 — a user-declared G# class has no CLR `Type` while it is
/// being compiled, so `GetEffectiveArgumentClrTypeForOverloadResolution`
/// erased it to the imported BASE type, or to `System.Object` when it has
/// no imported base. The implemented imported INTERFACES were dropped, and they
/// are the only evidence an imported generic method has for inferring a type
/// parameter that occurs solely inside an interface-typed parameter. The
/// canonical case is
/// `MethodDefinition.DecodeSignature<TType, TGenericContext>(
/// ISignatureTypeProvider<TType, TGenericContext>, TGenericContext)`
/// called with a G#-declared provider: `TType` received no bound at all,
/// inference failed, and the whole call reported
/// `GS0159 Cannot find function DecodeSignature.`
///
/// Issue #1423 already projected a user class to its most-derived implemented
/// CLR interface for an extension method's RECEIVER; this extends the identical
/// projection to ORDINARY arguments. It is the largest family in the migrated
/// `test/Compiler.Tests` compile wall (13 of 20 errors, counting the
/// `GS0158` member lookups that cascade off the failed call's error type).
open class Issue3745UserClassInterfaceArgumentInferenceEmitTests {
    /// The minimal repro reduced from
    /// `test/Compiler.Tests/LanguageConformance/NormalizedIlDump.cs`: a G#
    /// class implementing `ISignatureTypeProvider[string, object]` passed
    /// as an ordinary argument to the imported generic instance method
    /// `MethodDefinition.DecodeSignature`. The test EXECUTES the decode
    /// against this test assembly's own metadata, so it proves the inferred
    /// `TType = string` reaches emit and not merely the binder.
    @Fact
    func UserClassImplementingImportedInterface_InfersGenericArgument_Runs() {
        const source = (`package i3745provider
import System
import System.Collections.Immutable
import System.IO
import System.Reflection.Metadata
import System.Reflection.PortableExecutable

class NameProvider3745 : ISignatureTypeProvider[string, object] {
    func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[]"
    func GetByReferenceType(elementType string) string -> "ref " + elementType
    func GetFunctionPointerType(signature MethodSignature[string]) string -> "fnptr"
    func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType + "<...>"
    func GetGenericMethodParameter(genericContext object, index int32) string -> "m" + index.ToString()
    func GetGenericTypeParameter(genericContext object, index int32) string -> "t" + index.ToString()
    func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType
    func GetPinnedType(elementType string) string -> elementType
    func GetPointerType(elementType string) string -> elementType + "*"
    func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()
    func GetSZArrayType(elementType string) string -> elementType + "[]"
    func GetTypeFromDefinition(metadataReader MetadataReader, handle TypeDefinitionHandle, rawTypeKind uint8) string -> "def"
    func GetTypeFromReference(metadataReader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) string -> "ref"

    func GetTypeFromSpecification(
        metadataReader MetadataReader,
        genericContext object,
        handle TypeSpecificationHandle,
        rawTypeKind uint8) string -> "spec"
}

func Main() {
    let path = Environment.GetCommandLineArgs()[0]
    using let stream = File.OpenRead(path)
    using let pe = PEReader(stream)
    let reader = pe.GetMetadataReader()
    let provider = NameProvider3745()
    for handle in reader.MethodDefinitions {
        let method = reader.GetMethodDefinition(handle)
        if reader.GetString(method.Name) == "Main" {
            // ` + "`" + `sig` + "`" + ` is MethodSignature[string] only when TType was
            // inferred from the provider's implemented interface.
            let sig = method.DecodeSignature(provider, nil)
            Console.WriteLine(sig.ReturnType)
            return
        }
    }

    Console.WriteLine("not-found")
}`)
        Assert.Equal("Void${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3745_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                // System.Reflection.Metadata is not in gsc's default reference set.
                let args = []string{
                    "/out:" + dllPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/r:" + typeof(MetadataReader).Assembly.Location,
                    "/r:" + typeof(ImmutableArray).Assembly.Location,
                    srcPath
                }
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
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add(dllPath)
                using let process Process? = Process.Start(psi)
                Assert.NotNull(process)
                let stdout = process!!.StandardOutput.ReadToEnd()
                let stderr = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, (`exited ` + "${process!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }
    }
}
