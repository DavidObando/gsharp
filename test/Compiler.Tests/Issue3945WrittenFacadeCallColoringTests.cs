// <copyright file="Issue3945WrittenFacadeCallColoringTests.cs" company="GSharp">
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
using System.Text;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3945: ADR-0174 D4 suspension inference colored a function that merely
/// CALLED the blocking facade by name — <c>ChannelOps.Receive2(ch, token)</c> —
/// exactly as if it had written a channel operator. Coloring prepends a hidden
/// leading <c>Context</c> parameter (D7) and retypes the return as
/// <c>ValueTask</c>, so a parameterless method silently acquired an argument.
/// </summary>
/// <remarks>
/// <para>Why it stayed invisible: the ABI change is meant to be invisible, and
/// inside G# it is. It became observable only where something reflects over the
/// signature. In the #3501 self-migration, migrated
/// <c>test/Extensions.Tests</c> translates four C# tests that drain a channel
/// through the facade, and xUnit rejected all four at discovery with
/// "[Fact] methods are not allowed to have parameters" — the app's only
/// test-parity fingerprint, and one of the two banked apps holding the gate
/// below its floor.</para>
/// <para>The distinction the fix restores: every facade call the BINDER lowers
/// from a channel operator is bound with a cancellation the binder supplied
/// (the uncancellable default token, or an enclosing <c>scope</c>'s
/// <c>Context</c>) precisely so the suspension pass can retarget it onto the
/// ambient context. A call the AUTHOR wrote with its own token has already
/// chosen its cancellation — the pass leaves the body untouched — so coloring
/// the caller was pure ABI cost with no corresponding rewrite.</para>
/// <para>Discrimination (ADR-0154): the operator control
/// <c>OperatorReceive</c> must STILL be colored, so a mutant that stops
/// coloring facade calls altogether fails as surely as one that colors written
/// ones. The written and operator forms sit in one program and compile
/// together, so the two paths cannot be satisfied by a blanket answer. Every
/// case compiles, IL-verifies AND runs: on this effort a wrong fix has passed a
/// binding-only assertion, and a defect has IL-verified clean yet failed at
/// load.</para>
/// </remarks>
public class Issue3945WrittenFacadeCallColoringTests
{
    private const string Source = """
        package main

        import System
        import System.Threading
        import Gsharp.Concurrency
        import System.Threading.Channels

        class Probe {
            // The regressed shape: a parameterless method — an xUnit `[Fact]`
            // shape — whose only channel work is a facade call the author wrote
            // out, with a token the author chose.
            func WrittenFacadeCall() {
                let ch = Chan[int32](1)
                ch.TrySend(7)
                let (value, ok) = ChannelOps.Receive2(ch, CancellationToken.None)
                Console.WriteLine("w=" + value.ToString() + ":" + ok.ToString())
            }

            // Control that passed BEFORE the fix: a channel OPERATOR still
            // colors its caller, which is the whole point of ADR-0174 D4.
            func OperatorReceive() {
                let ch = Chan[int32](1)
                ch.TrySend(9)
                let (value, ok) = <-ch
                Console.WriteLine("o=" + value.ToString() + ":" + ok.ToString())
            }

            // Control: a body with no channel operation is never colored.
            func NoChannelOp() {
                Console.WriteLine("n=ok")
            }
        }

        let p = Probe()
        p.WrittenFacadeCall()
        p.OperatorReceive()
        p.NoChannelOp()
        """;

    /// <summary>
    /// The behavioural half: all three methods run and print what they were
    /// written to print. A written facade call still performs the receive — the
    /// fix changes who carries the context, not what the call does.
    /// </summary>
    [Fact]
    public void WrittenFacadeCall_StillReceives_AndTheProgramRuns()
    {
        var (_, lines) = CompileVerifyAndRun();

        Assert.Equal(new[] { "w=7:True", "o=9:True", "n=ok" }, lines);
    }

    /// <summary>
    /// The encoding half: "the method has no parameters" is a metadata fact no
    /// behavioural assertion can name, and it is the exact fact xUnit reads.
    /// Asserted against the emitted signature blob, which is what
    /// <see cref="MethodBase.GetParameters"/> reports.
    /// </summary>
    [Fact]
    public void WrittenFacadeCall_KeepsItsSignature_WhileTheOperatorFormIsStillColored()
    {
        var (assemblyPath, _) = CompileVerifyAndRun();

        var written = SignatureOf(assemblyPath, "Probe", "WrittenFacadeCall");
        var operatorForm = SignatureOf(assemblyPath, "Probe", "OperatorReceive");
        var plain = SignatureOf(assemblyPath, "Probe", "NoChannelOp");

        // The regression: this was `1 [Context] -> ValueTask`.
        Assert.Equal(0, written.ParameterCount);
        Assert.Equal("Void", written.ReturnType);

        // Discrimination: the operator form MUST still gain the hidden context.
        Assert.Equal(1, operatorForm.ParameterCount);
        Assert.Equal("Context", operatorForm.ParameterTypes[0]);

        Assert.Equal(0, plain.ParameterCount);
        Assert.Equal("Void", plain.ReturnType);
    }

    private static (int ParameterCount, string[] ParameterTypes, string ReturnType) SignatureOf(
        string assemblyPath,
        string typeName,
        string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();
        var provider = new NameOnlySignatureProvider();

        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var type = reader.GetTypeDefinition(typeHandle);
            if (reader.GetString(type.Name) != typeName)
            {
                continue;
            }

            foreach (var methodHandle in type.GetMethods())
            {
                var method = reader.GetMethodDefinition(methodHandle);
                if (reader.GetString(method.Name) != methodName)
                {
                    continue;
                }

                var signature = method.DecodeSignature(provider, genericContext: null);
                return (
                    signature.ParameterTypes.Length,
                    signature.ParameterTypes.ToArray(),
                    signature.ReturnType);
            }
        }

        throw new InvalidOperationException($"{typeName}::{methodName} not found in {assemblyPath}");
    }

    private static (string AssemblyPath, string[] Lines) CompileVerifyAndRun()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3945_facade_").FullName;
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, Source);
        var outPath = Path.Combine(tempDir, "Program.dll");

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(compileExit == 0, $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);

        var psi = new ProcessStartInfo("dotnet", $"\"{outPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = tempDir,
        };

        using var process = Process.Start(psi) ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        Assert.True(process.WaitForExit(60_000), "the sample timed out");
        Assert.True(process.ExitCode == 0, $"the sample exited {process.ExitCode}:\n{output}");

        var lines = output.ToString()
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .ToArray();

        return (outPath, lines);
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is not string tpa || tpa.Length == 0)
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }

    /// <summary>
    /// Decodes a signature blob to type NAMES: the assertions here are about
    /// arity and the identity of the hidden parameter, not full type identity.
    /// </summary>
    private sealed class NameOnlySignatureProvider : ISignatureTypeProvider<string, object>
    {
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";

        public string GetGenericInstantiation(string genericType, System.Collections.Immutable.ImmutableArray<string> typeArguments)
            => genericType + "<" + string.Join(",", typeArguments) + ">";

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
            => reader.GetString(reader.GetTypeDefinition(handle).Name);

        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
            => reader.GetString(reader.GetTypeReference(handle).Name);

        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
            => "typespec";
    }
}
