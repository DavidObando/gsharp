// <copyright file="Issue3907AllowNullParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3907: `@AllowNull` on a parameter. C# gives a declaration two
/// nullability contracts, an INPUT one and an OUTPUT one;
/// `[AllowNull] T value` says "this input accepts `null` even though
/// its type is not nullable". ADR-0155 gives a G# declaration a single
/// nullability, so for a REFERENCE type cs2gs widens the declaration to
/// `T?` (issue #3694) and the two agree — but an UNCONSTRAINED type
/// parameter has no such widening, so the attribute is the whole contract and
/// gsc had to honour it. It did not: it had no `AllowNull` support at all,
/// and `ReceiveResult<T>`'s `([AllowNull] T value, bool ok)`
/// constructor rejected the `T?` the channels runtime passes it.
/// @remarks The fix is deliberately ANNOTATION-ONLY. Widening the parameter's own
/// type would make a value-type `T` emit a `Nullable<T>`
/// signature slot where `T` is expected — wrong IL that ILVerify does NOT
/// catch, because the metadata is internally consistent and simply describes a
/// different method. (cref:AllowNullParameter_EmitsTheBareTypeNotNullable)
/// reads the emitted signature back and pins exactly that.
///
/// Witnesses of discrimination (ADR-0154): a parameter WITHOUT the
/// annotation still rejects a `T?` argument, and a value-type nullable
/// (`int32?` at an `@AllowNull int32` slot) stays rejected — it
/// really is a `Nullable<int32>` on the stack, and C# rejects it
/// too. A mutant that relaxes unconditionally fails both.
open class Issue3907AllowNullParameterTests {
    @Fact
    func AllowNullParameter_AcceptsANilCarryingArgumentAndRuns() {
        let source = BoxSource + `
let cs = Closed[string]()
Console.WriteLine("closed-string=" + cs.Ok.ToString() + ":" + (if cs.Value == nil { "nil" } else { "set" }))
let ci = Closed[int32]()
Console.WriteLine("closed-int=" + ci.Ok.ToString() + ":" + ci.Value.ToString())
let ds = Delivered[string]("hi")
Console.WriteLine("delivered-string=" + ds.Ok.ToString() + ":" + ds.Value)
let di = Delivered[int32](7)
Console.WriteLine("delivered-int=" + di.Ok.ToString() + ":" + di.Value.ToString())
Console.WriteLine("done")
`
        let lines = CompileVerifyAndRun(source, out _)
        // The nil really reaches the field, and the value-type instantiation
        // stores the element's zero value rather than a lifted `Nullable`.
        Assert.Contains("closed-string=False:nil", lines)
        Assert.Contains("closed-int=False:0", lines)
        Assert.Contains("delivered-string=True:hi", lines)
        Assert.Contains("delivered-int=True:7", lines)
        Assert.Equal("done", lines[^1])
    }

    @Fact
    func AllowNullParameter_EmitsTheBareTypeNotNullable() {
        // THE failure mode this fix was written to avoid. `@AllowNull` must
        // change what the ARGUMENT conversion accepts and nothing else; if it
        // widened the parameter's declared type instead, `Box[T]`'s constructor
        // would take `Nullable<T>` and every caller compiled against it would
        // be calling a method that does not exist in the shape they expect.
        // ILVerify cannot see that — the assembly is internally consistent —
        // so the signature is read back out of the emitted metadata.
        let source = BoxSource + `
Console.WriteLine("done")
`
        let _ = CompileVerifyAndRun(source, out var assemblyPath)
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        let boxType = reader
            .TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single((t TypeDefinition) -> reader.GetString(t.Name).StartsWith("Box", StringComparison.Ordinal))
        let ctor = boxType
            .GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single((m MethodDefinition) -> reader.GetString(m.Name) == ".ctor")
        let signature = ctor.DecodeSignature(SignatureText(), genericContext: nil)
        Assert.Equal(2, signature.ParameterTypes.Length)
        // `!0` is the type parameter itself. Anything mentioning Nullable — in
        // particular `valuetype [System.Runtime]System.Nullable`1<!0>` — is the
        // wrong-IL bug.
        Assert.Equal("!0", signature.ParameterTypes[0])
        Assert.DoesNotContain("Nullable", signature.ParameterTypes[0], StringComparison.Ordinal)
        Assert.Equal("bool", signature.ParameterTypes[1])
    }

    @Fact
    func WithoutTheAnnotation_ANilCarryingArgumentIsStillRejected() {
        // Anti-vacuity guard: the ONLY thing that admits the `T?` argument is
        // the annotation. Passes both before and after the fix.
        const source = `
package Demo

import System

struct Plain[T] {
    let Value T

    init(value T) {
        Value = value
    }
}

func Make[T]() Plain[T] {
    var v T? = nil
    return Plain[T](v)
}

Console.WriteLine("unreachable")
`
        let log = CompileExpectingFailure(source)
        Assert.Contains("GS0154", log, StringComparison.Ordinal)
    }

    @Fact
    func AllowNullOnAValueTypeParameter_StillRejectsAValueTypeNullable() {
        // The other half of the guard, and the reason the relaxation is gated
        // on `NullableLifting.IsAnyValueTypeNullable`. `int32?` really IS a
        // `Nullable<int32>` on the evaluation stack, so admitting it at an
        // `int32` slot would be a stack-shape error, not an annotation. C#
        // rejects the same call.
        const source = `
package Demo

import System
import System.Diagnostics.CodeAnalysis

struct ValueBox {
    let Value int32

    init(@AllowNull value int32) {
        Value = value
    }
}

func Make(v int32?) ValueBox {
    return ValueBox(v)
}

Console.WriteLine("unreachable")
`
        let log = CompileExpectingFailure(source)
        Assert.Contains("GS0154", log, StringComparison.Ordinal)
    }

    /// Minimal (cref:ISignatureTypeProvider{TType, TGenericContext}) that
    /// renders a signature element as ILAsm-ish text, so the assertion above can
    /// name the exact shape it requires without depending on a reflection
    /// context.
    private class SignatureText : ISignatureTypeProvider[string, object] {
        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> switch typeCode {
            case PrimitiveTypeCode.Boolean: "bool"
            case PrimitiveTypeCode.Int32: "int32"
            case PrimitiveTypeCode.String: "string"
            case PrimitiveTypeCode.Object: "object"
            case PrimitiveTypeCode.Void: "void"
            default: typeCode.ToString()
        }

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetTypeFromDefinition(
            reader MetadataReader,
            handle TypeDefinitionHandle,
            rawTypeKind uint8
        ) string -> reader.GetString(reader.GetTypeDefinition(handle).Name)

        func GetTypeFromReference(
            reader MetadataReader,
            handle TypeReferenceHandle,
            rawTypeKind uint8
        ) string -> reader.GetString(reader.GetTypeReference(handle).Name)

        func GetTypeFromSpecification(
            reader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> reader
            .GetTypeSpecification(handle).DecodeSignature(this, genericContext)

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<" +
            string.Join(",", typeArguments) + ">"

        func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[]"

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetByReferenceType(elementType string) string -> elementType + "&"

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetPinnedType(elementType string) string -> elementType

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "fnptr"

        func GetTypeFromSerializedName(name string) string -> name

        func GetUnderlyingEnumType(type string) PrimitiveTypeCode -> PrimitiveTypeCode.Int32

        func IsSystemType(type string) bool -> false
    }

    shared {
        // The `ReceiveResult<T>` shape from src/Sdk/Gsharp.Runtime.Channels, cut
        // down to the parts that matter: an `@AllowNull T` constructor parameter, a
        // `T?` value flowing into it, and both a reference and a value-type
        // instantiation of the same generic code.
        private const BoxSource string = `
package Demo

import System
import System.Diagnostics.CodeAnalysis

struct Box[T] {
    let Value T
    let Ok bool

    init(@AllowNull value T, ok bool) {
        Value = value
        Ok = ok
    }
}

func Closed[T]() Box[T] {
    var v T? = nil
    return Box[T](v, false)
}

func Delivered[T](value T) Box[T] {
    return Box[T](value, true)
}
`

        private func CompileVerifyAndRun(source string, out assemblyPath string)[]string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3907_allownull_").FullName
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, "Program.dll")
            assemblyPath = outPath
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
            let (compileExit, compileLog) = RunCompiler(args)
            Assert.True(compileExit == 0, (`gsc failed:
` + "$compileLog"))
            IlVerifier.Verify(outPath)
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            psi.ArgumentList.Add("exec")
            psi.ArgumentList.Add("--runtimeconfig")
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
            psi.ArgumentList.Add(outPath)
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc!!.ExitCode == 0, (`sample exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine).Split(
                Environment.NewLine,
                StringSplitOptions.RemoveEmptyEntries
            )
        }

        private func CompileExpectingFailure(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3907_allownull_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "Program.gs")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + Path.Combine(tempDir, "Program.dll"),
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath
                }
                let (compileExit, compileLog) = RunCompiler(args)
                Assert.True(compileExit != 0, (`gsc unexpectedly succeeded:
` + "$compileLog"))
                return compileLog
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func RunCompiler(args List[string])(Exit int32, Log string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                let exit = Program.Main(args.ToArray())
                return (exit, compileOut.ToString() + "\n" + compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }
    }
}
