// <copyright file="Issue1208SafeHandlePInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Emit coverage for ADR-0086 §2 / issue #1208: a P/Invoke whose parameter or
/// return type is `System.Runtime.InteropServices.SafeHandle` (or a derived
/// type such as `Microsoft.Win32.SafeHandles.SafeFileHandle`) lowers to a
/// `PinvokeImpl` MethodDef whose signature references the real handle type
/// via a TypeRef, so the CLR marshaller performs the handle ref-count /
/// lifetime bookkeeping. kernel32 is not callable off-Windows, so these tests
/// only assert on the emitted metadata, not on runtime invocation.
open class Issue1208SafeHandlePInvokeEmitTests {
    @Fact
    func SafeHandle_Param_And_SafeFileHandle_Return_ReferenceRealTypesInSignature() {
        const source = `package P
import System.Runtime.InteropServices
import Microsoft.Win32.SafeHandles

unsafe class C {
    shared {
        @DllImport("kernel32", SetLastError: true, CharSet: 3)
        func CreateFile(name string, a uint32, b uint32, c uint32, d uint32, e uint32, f int32) SafeFileHandle;

        @DllImport("kernel32", SetLastError: true)
        func ReadFile(handle SafeHandle, pBuffer *void, n int32, pRead *int32, ov int32) bool;
    }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_safehandle_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            let provider = Issue1208SafeHandlePInvokeEmitTests.NameSignatureProvider(md)
            var sawCreateFile = false
            var sawReadFile = false
            for h in md.MethodDefinitions {
                let m = md.GetMethodDefinition(h)
                let name = md.GetString(m.Name)
                if name == "CreateFile" {
                    sawCreateFile = true
                    Assert.True(
                        (m.Attributes & MethodAttributes.PinvokeImpl) == MethodAttributes.PinvokeImpl,
                        "CreateFile should carry PinvokeImpl"
                    )
                    let sig = m.DecodeSignature(provider, genericContext: nil)
                    Assert.Equal("Microsoft.Win32.SafeHandles.SafeFileHandle", sig.ReturnType)
                } else if name == "ReadFile" {
                    sawReadFile = true
                    Assert.True(
                        (m.Attributes & MethodAttributes.PinvokeImpl) == MethodAttributes.PinvokeImpl,
                        "ReadFile should carry PinvokeImpl"
                    )
                    let sig = m.DecodeSignature(provider, genericContext: nil)
                    Assert.Equal("System.Runtime.InteropServices.SafeHandle", sig.ParameterTypes[0])
                }
            }
            Assert.True(sawCreateFile, "expected an emitted P/Invoke method named CreateFile")
            Assert.True(sawReadFile, "expected an emitted P/Invoke method named ReadFile")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    /// Minimal (cref:ISignatureTypeProvider{TType, TGenericContext}) that
    /// renders each referenced type as its full CLR name so the test can assert
    /// the emitted P/Invoke signature points at the real SafeHandle types.
    private class NameSignatureProvider : ISignatureTypeProvider[string, object] {
        private let reader MetadataReader

        init(reader MetadataReader) {
            this.reader = reader
        }

        func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[]"

        func GetByReferenceType(elementType string) string -> "ref " + elementType

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "fnptr"

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<...>"

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType

        func GetPinnedType(elementType string) string -> elementType

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetTypeFromDefinition(
            metadataReader MetadataReader,
            handle TypeDefinitionHandle,
            rawTypeKind uint8
        ) string {
            let def = metadataReader.GetTypeDefinition(handle)
            let ns = metadataReader.GetString(def.Namespace)
            let name = metadataReader.GetString(def.Name)
            return if string.IsNullOrEmpty(ns) {
                name
            } else {
                ns + "." + name
            }
        }

        func GetTypeFromReference(metadataReader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) string {
            let typeRef = metadataReader.GetTypeReference(handle)
            let ns = metadataReader.GetString(typeRef.Namespace)
            let name = metadataReader.GetString(typeRef.Name)
            return if string.IsNullOrEmpty(ns) {
                name
            } else {
                ns + "." + name
            }
        }

        func GetTypeFromSpecification(
            metadataReader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> "spec"
    }

    shared {
        private func CompileOrThrow(srcPath string, outPath string, target string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }
    }
}
