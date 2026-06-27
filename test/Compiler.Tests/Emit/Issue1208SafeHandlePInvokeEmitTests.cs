// <copyright file="Issue1208SafeHandlePInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Emit coverage for ADR-0086 §2 / issue #1208: a P/Invoke whose parameter or
/// return type is <c>System.Runtime.InteropServices.SafeHandle</c> (or a derived
/// type such as <c>Microsoft.Win32.SafeHandles.SafeFileHandle</c>) lowers to a
/// <c>PinvokeImpl</c> MethodDef whose signature references the real handle type
/// via a TypeRef, so the CLR marshaller performs the handle ref-count /
/// lifetime bookkeeping. kernel32 is not callable off-Windows, so these tests
/// only assert on the emitted metadata, not on runtime invocation.
/// </summary>
public class Issue1208SafeHandlePInvokeEmitTests
{
    [Fact]
    public void SafeHandle_Param_And_SafeFileHandle_Return_ReferenceRealTypesInSignature()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices
            import Microsoft.Win32.SafeHandles

            unsafe class C {
                shared {
                    @DllImport("kernel32", SetLastError: true, CharSet: 3)
                    func CreateFile(name string, a uint32, b uint32, c uint32, d uint32, e uint32, f int32) SafeFileHandle;

                    @DllImport("kernel32", SetLastError: true)
                    func ReadFile(handle SafeHandle, pBuffer *void, n int32, pRead *int32, ov int32) bool;
                }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_safehandle_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();
            var provider = new NameSignatureProvider(md);

            var sawCreateFile = false;
            var sawReadFile = false;
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                var name = md.GetString(m.Name);
                if (name == "CreateFile")
                {
                    sawCreateFile = true;
                    Assert.True(
                        (m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == System.Reflection.MethodAttributes.PinvokeImpl,
                        "CreateFile should carry PinvokeImpl");
                    var sig = m.DecodeSignature(provider, genericContext: null);
                    Assert.Equal("Microsoft.Win32.SafeHandles.SafeFileHandle", sig.ReturnType);
                }
                else if (name == "ReadFile")
                {
                    sawReadFile = true;
                    Assert.True(
                        (m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == System.Reflection.MethodAttributes.PinvokeImpl,
                        "ReadFile should carry PinvokeImpl");
                    var sig = m.DecodeSignature(provider, genericContext: null);
                    Assert.Equal("System.Runtime.InteropServices.SafeHandle", sig.ParameterTypes[0]);
                }
            }

            Assert.True(sawCreateFile, "expected an emitted P/Invoke method named CreateFile");
            Assert.True(sawReadFile, "expected an emitted P/Invoke method named ReadFile");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void CompileOrThrow(string srcPath, string outPath, string target)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }

    /// <summary>
    /// Minimal <see cref="ISignatureTypeProvider{TType, TGenericContext}"/> that
    /// renders each referenced type as its full CLR name so the test can assert
    /// the emitted P/Invoke signature points at the real SafeHandle types.
    /// </summary>
    private sealed class NameSignatureProvider : ISignatureTypeProvider<string, object>
    {
        private readonly MetadataReader reader;

        public NameSignatureProvider(MetadataReader reader)
        {
            this.reader = reader;
        }

        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";

        public string GetByReferenceType(string elementType) => "ref " + elementType;

        public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";

        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) => genericType + "<...>";

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetTypeFromDefinition(MetadataReader metadataReader, TypeDefinitionHandle handle, byte rawTypeKind)
        {
            var def = metadataReader.GetTypeDefinition(handle);
            var ns = metadataReader.GetString(def.Namespace);
            var name = metadataReader.GetString(def.Name);
            return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
        }

        public string GetTypeFromReference(MetadataReader metadataReader, TypeReferenceHandle handle, byte rawTypeKind)
        {
            var typeRef = metadataReader.GetTypeReference(handle);
            var ns = metadataReader.GetString(typeRef.Namespace);
            var name = metadataReader.GetString(typeRef.Name);
            return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
        }

        public string GetTypeFromSpecification(MetadataReader metadataReader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind) => "spec";
    }
}
