// <copyright file="Issue3745UserClassInterfaceArgumentInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3745 — a user-declared G# class has no CLR <c>Type</c> while it is
/// being compiled, so <c>GetEffectiveArgumentClrTypeForOverloadResolution</c>
/// erased it to the imported BASE type, or to <c>System.Object</c> when it has
/// no imported base. The implemented imported INTERFACES were dropped, and they
/// are the only evidence an imported generic method has for inferring a type
/// parameter that occurs solely inside an interface-typed parameter. The
/// canonical case is
/// <c>MethodDefinition.DecodeSignature&lt;TType, TGenericContext&gt;(
/// ISignatureTypeProvider&lt;TType, TGenericContext&gt;, TGenericContext)</c>
/// called with a G#-declared provider: <c>TType</c> received no bound at all,
/// inference failed, and the whole call reported
/// <c>GS0159 Cannot find function DecodeSignature.</c>
/// <para>
/// Issue #1423 already projected a user class to its most-derived implemented
/// CLR interface for an extension method's RECEIVER; this extends the identical
/// projection to ORDINARY arguments. It is the largest family in the migrated
/// <c>test/Compiler.Tests</c> compile wall (13 of 20 errors, counting the
/// <c>GS0158</c> member lookups that cascade off the failed call's error type).
/// </para>
/// </summary>
public class Issue3745UserClassInterfaceArgumentInferenceEmitTests
{
    /// <summary>
    /// The minimal repro reduced from
    /// <c>test/Compiler.Tests/LanguageConformance/NormalizedIlDump.cs</c>: a G#
    /// class implementing <c>ISignatureTypeProvider[string, object]</c> passed
    /// as an ordinary argument to the imported generic instance method
    /// <c>MethodDefinition.DecodeSignature</c>. The test EXECUTES the decode
    /// against this test assembly's own metadata, so it proves the inferred
    /// <c>TType = string</c> reaches emit and not merely the binder.
    /// </summary>
    [Fact]
    public void UserClassImplementingImportedInterface_InfersGenericArgument_Runs()
    {
        const string source = """
            package i3745provider
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
                        // `sig` is MethodSignature[string] only when TType was
                        // inferred from the provider's implemented interface.
                        let sig = method.DecodeSignature(provider, nil)
                        Console.WriteLine(sig.ReturnType)
                        return
                    }
                }

                Console.WriteLine("not-found")
            }
            """;

        Assert.Equal($"Void{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3745_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            // System.Reflection.Metadata is not in gsc's default reference set.
            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/r:" + typeof(MetadataReader).Assembly.Location,
                "/r:" + typeof(System.Collections.Immutable.ImmutableArray).Assembly.Location,
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add(dllPath);

            using var process = Process.Start(psi);
            Assert.NotNull(process);
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }
}
