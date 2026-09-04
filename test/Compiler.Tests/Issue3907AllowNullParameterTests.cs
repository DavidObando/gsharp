// <copyright file="Issue3907AllowNullParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3907: <c>@AllowNull</c> on a parameter. C# gives a declaration two
/// nullability contracts, an INPUT one and an OUTPUT one;
/// <c>[AllowNull] T value</c> says "this input accepts <c>null</c> even though
/// its type is not nullable". ADR-0155 gives a G# declaration a single
/// nullability, so for a REFERENCE type cs2gs widens the declaration to
/// <c>T?</c> (issue #3694) and the two agree — but an UNCONSTRAINED type
/// parameter has no such widening, so the attribute is the whole contract and
/// gsc had to honour it. It did not: it had no <c>AllowNull</c> support at all,
/// and <c>ReceiveResult&lt;T&gt;</c>'s <c>([AllowNull] T value, bool ok)</c>
/// constructor rejected the <c>T?</c> the channels runtime passes it.
/// </summary>
/// <remarks>
/// <para>The fix is deliberately ANNOTATION-ONLY. Widening the parameter's own
/// type would make a value-type <c>T</c> emit a <c>Nullable&lt;T&gt;</c>
/// signature slot where <c>T</c> is expected — wrong IL that ILVerify does NOT
/// catch, because the metadata is internally consistent and simply describes a
/// different method. <see cref="AllowNullParameter_EmitsTheBareTypeNotNullable"/>
/// reads the emitted signature back and pins exactly that.</para>
/// <para>Witnesses of discrimination (ADR-0154): a parameter WITHOUT the
/// annotation still rejects a <c>T?</c> argument, and a value-type nullable
/// (<c>int32?</c> at an <c>@AllowNull int32</c> slot) stays rejected — it
/// really is a <c>Nullable&lt;int32&gt;</c> on the stack, and C# rejects it
/// too. A mutant that relaxes unconditionally fails both.</para>
/// </remarks>
public class Issue3907AllowNullParameterTests
{
    // The `ReceiveResult<T>` shape from src/Sdk/Gsharp.Runtime.Channels, cut
    // down to the parts that matter: an `@AllowNull T` constructor parameter, a
    // `T?` value flowing into it, and both a reference and a value-type
    // instantiation of the same generic code.
    private const string BoxSource = @"
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
";

    [Fact]
    public void AllowNullParameter_AcceptsANilCarryingArgumentAndRuns()
    {
        var source = BoxSource + @"
let cs = Closed[string]()
Console.WriteLine(""closed-string="" + cs.Ok.ToString() + "":"" + (if cs.Value == nil { ""nil"" } else { ""set"" }))
let ci = Closed[int32]()
Console.WriteLine(""closed-int="" + ci.Ok.ToString() + "":"" + ci.Value.ToString())
let ds = Delivered[string](""hi"")
Console.WriteLine(""delivered-string="" + ds.Ok.ToString() + "":"" + ds.Value)
let di = Delivered[int32](7)
Console.WriteLine(""delivered-int="" + di.Ok.ToString() + "":"" + di.Value.ToString())
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source, out _);

        // The nil really reaches the field, and the value-type instantiation
        // stores the element's zero value rather than a lifted `Nullable`.
        Assert.Contains("closed-string=False:nil", lines);
        Assert.Contains("closed-int=False:0", lines);
        Assert.Contains("delivered-string=True:hi", lines);
        Assert.Contains("delivered-int=True:7", lines);
        Assert.Equal("done", lines[^1]);
    }

    [Fact]
    public void AllowNullParameter_EmitsTheBareTypeNotNullable()
    {
        // THE failure mode this fix was written to avoid. `@AllowNull` must
        // change what the ARGUMENT conversion accepts and nothing else; if it
        // widened the parameter's declared type instead, `Box[T]`'s constructor
        // would take `Nullable<T>` and every caller compiled against it would
        // be calling a method that does not exist in the shape they expect.
        // ILVerify cannot see that — the assembly is internally consistent —
        // so the signature is read back out of the emitted metadata.
        var source = BoxSource + @"
Console.WriteLine(""done"")
";

        _ = CompileVerifyAndRun(source, out var assemblyPath);

        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();

        var boxType = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(t => reader.GetString(t.Name).StartsWith("Box", StringComparison.Ordinal));

        var ctor = boxType.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single(m => reader.GetString(m.Name) == ".ctor");

        var signature = ctor.DecodeSignature(new SignatureText(), genericContext: null);

        Assert.Equal(2, signature.ParameterTypes.Length);

        // `!0` is the type parameter itself. Anything mentioning Nullable — in
        // particular `valuetype [System.Runtime]System.Nullable`1<!0>` — is the
        // wrong-IL bug.
        Assert.Equal("!0", signature.ParameterTypes[0]);
        Assert.DoesNotContain("Nullable", signature.ParameterTypes[0], StringComparison.Ordinal);
        Assert.Equal("bool", signature.ParameterTypes[1]);
    }

    [Fact]
    public void WithoutTheAnnotation_ANilCarryingArgumentIsStillRejected()
    {
        // Anti-vacuity guard: the ONLY thing that admits the `T?` argument is
        // the annotation. Passes both before and after the fix.
        const string source = @"
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

Console.WriteLine(""unreachable"")
";

        var log = CompileExpectingFailure(source);

        Assert.Contains("GS0154", log, StringComparison.Ordinal);
    }

    [Fact]
    public void AllowNullOnAValueTypeParameter_StillRejectsAValueTypeNullable()
    {
        // The other half of the guard, and the reason the relaxation is gated
        // on `NullableLifting.IsAnyValueTypeNullable`. `int32?` really IS a
        // `Nullable<int32>` on the evaluation stack, so admitting it at an
        // `int32` slot would be a stack-shape error, not an annotation. C#
        // rejects the same call.
        const string source = @"
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

Console.WriteLine(""unreachable"")
";

        var log = CompileExpectingFailure(source);

        Assert.Contains("GS0154", log, StringComparison.Ordinal);
    }

    private static string[] CompileVerifyAndRun(string source, out string assemblyPath)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_allownull_").FullName;
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);
        var outPath = Path.Combine(tempDir, "Program.dll");
        assemblyPath = outPath;

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
            srcPath,
        };

        var (compileExit, compileLog) = RunCompiler(args);
        Assert.True(compileExit == 0, $"gsc failed:\n{compileLog}");

        IlVerifier.Verify(outPath);

        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = tempDir,
        };
        psi.ArgumentList.Add("exec");
        psi.ArgumentList.Add("--runtimeconfig");
        psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
        psi.ArgumentList.Add(outPath);

        using var proc = Process.Start(psi);
        var stdout = proc!.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

        return stdout
            .ReplaceLineEndings(Environment.NewLine)
            .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
    }

    private static string CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_allownull_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + Path.Combine(tempDir, "Program.dll"),
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            var (compileExit, compileLog) = RunCompiler(args);
            Assert.True(compileExit != 0, $"gsc unexpectedly succeeded:\n{compileLog}");
            return compileLog;
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
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private static (int Exit, string Log) RunCompiler(List<string> args)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            var exit = Program.Main(args.ToArray());
            return (exit, compileOut + "\n" + compileErr);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }

    /// <summary>
    /// Minimal <see cref="ISignatureTypeProvider{TType, TGenericContext}"/> that
    /// renders a signature element as ILAsm-ish text, so the assertion above can
    /// name the exact shape it requires without depending on a reflection
    /// context.
    /// </summary>
    private sealed class SignatureText : ISignatureTypeProvider<string, object>
    {
        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode switch
        {
            PrimitiveTypeCode.Boolean => "bool",
            PrimitiveTypeCode.Int32 => "int32",
            PrimitiveTypeCode.String => "string",
            PrimitiveTypeCode.Object => "object",
            PrimitiveTypeCode.Void => "void",
            _ => typeCode.ToString(),
        };

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
            => reader.GetString(reader.GetTypeDefinition(handle).Name);

        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
            => reader.GetString(reader.GetTypeReference(handle).Name);

        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
            => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

        public string GetGenericInstantiation(string genericType, System.Collections.Immutable.ImmutableArray<string> typeArguments)
            => genericType + "<" + string.Join(",", typeArguments) + ">";

        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPinnedType(string elementType) => elementType;

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

        public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";

        public string GetTypeFromSerializedName(string name) => name;

        public PrimitiveTypeCode GetUnderlyingEnumType(string type) => PrimitiveTypeCode.Int32;

        public bool IsSystemType(string type) => false;
    }
}
