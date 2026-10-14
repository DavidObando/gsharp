// <copyright file="Issue3945WrittenFacadeCallColoringTests.cs" company="GSharp">
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
import System.Text
import Xunit

/// Issue #3945: ADR-0174 D4 suspension inference colored a function that merely
/// CALLED the blocking facade by name — `ChannelOps.Receive2(ch, token)` —
/// exactly as if it had written a channel operator. Coloring prepends a hidden
/// leading `Context` parameter (D7) and retypes the return as
/// `ValueTask`, so a parameterless method silently acquired an argument.
/// @remarks Why it stayed invisible: the ABI change is meant to be invisible, and
/// inside G# it is. It became observable only where something reflects over the
/// signature. In the #3501 self-migration, migrated
/// `test/Extensions.Tests` translates four C# tests that drain a channel
/// through the facade, and xUnit rejected all four at discovery with
/// "[Fact] methods are not allowed to have parameters" — the app's only
/// test-parity fingerprint, and one of the two banked apps holding the gate
/// below its floor.
///
/// The distinction the fix restores: every facade call the BINDER lowers
/// from a channel operator is bound with a cancellation the binder supplied
/// (the uncancellable default token, or an enclosing `scope`'s
/// `Context`) precisely so the suspension pass can retarget it onto the
/// ambient context. A call the AUTHOR wrote with its own token has already
/// chosen its cancellation — the pass leaves the body untouched — so coloring
/// the caller was pure ABI cost with no corresponding rewrite.
///
/// Discrimination (ADR-0154): the operator control
/// `OperatorReceive` must STILL be colored, so a mutant that stops
/// coloring facade calls altogether fails as surely as one that colors written
/// ones. The written and operator forms sit in one program and compile
/// together, so the two paths cannot be satisfied by a blanket answer. Every
/// case compiles, IL-verifies AND runs: on this effort a wrong fix has passed a
/// binding-only assertion, and a defect has IL-verified clean yet failed at
/// load.
open class Issue3945WrittenFacadeCallColoringTests {
    /// The behavioural half: all three methods run and print what they were
    /// written to print. A written facade call still performs the receive — the
    /// fix changes who carries the context, not what the call does.
    @Fact
    func WrittenFacadeCall_StillReceives_AndTheProgramRuns() {
        let (_, lines) = CompileVerifyAndRun()
        Assert.Equal([]string{"w=7:True", "o=9:True", "n=ok"}, lines)
    }

    /// The encoding half: "the method has no parameters" is a metadata fact no
    /// behavioural assertion can name, and it is the exact fact xUnit reads.
    /// Asserted against the emitted signature blob, which is what
    /// (cref:MethodBase.GetParameters) reports.
    @Fact
    func WrittenFacadeCall_KeepsItsSignature_WhileTheOperatorFormIsStillColored() {
        let (assemblyPath, _) = CompileVerifyAndRun()
        let written = SignatureOf(assemblyPath, "Probe", "WrittenFacadeCall")
        let operatorForm = SignatureOf(assemblyPath, "Probe", "OperatorReceive")
        let plain = SignatureOf(assemblyPath, "Probe", "NoChannelOp")
        // The regression: this was `1 [Context] -> ValueTask`.
        Assert.Equal(0, written.ParameterCount)
        Assert.Equal("Void", written.ReturnType)
        // Discrimination: the operator form MUST still gain the hidden context.
        Assert.Equal(1, operatorForm.ParameterCount)
        Assert.Equal("Context", operatorForm.ParameterTypes[0])
        Assert.Equal(0, plain.ParameterCount)
        Assert.Equal("Void", plain.ReturnType)
    }

    /// Decodes a signature blob to type NAMES: the assertions here are about
    /// arity and the identity of the hidden parameter, not full type identity.
    private class NameOnlySignatureProvider : ISignatureTypeProvider[string, object] {
        func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[]"

        func GetByReferenceType(elementType string) string -> elementType + "&"

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "fnptr"

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<" +
            string.Join(",", typeArguments) + ">"

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType

        func GetPinnedType(elementType string) string -> elementType

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetSZArrayType(elementType string) string -> elementType + "[]"

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
        ) string -> "typespec"
    }

    shared {
        private const Source string = (`package main

import System
import System.Threading
import Gsharp.Concurrency
import System.Threading.Channels

class Probe {
    // The regressed shape: a parameterless method — an xUnit ` + "`" + `[Fact]` + "`" + `
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
p.NoChannelOp()`)

        private func SignatureOf(assemblyPath string, typeName string, methodName string)(
            ParameterCount int32,
            ParameterTypes[]string,
            ReturnType string
        ) {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            let provider = NameOnlySignatureProvider()
            for typeHandle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(typeHandle)
                if reader.GetString(type.Name) != typeName {
                    continue
                }
                for methodHandle in type.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    if reader.GetString(method.Name) != methodName {
                        continue
                    }
                    let signature = method.DecodeSignature(provider, genericContext: nil)
                    return (signature.ParameterTypes.Length, signature.ParameterTypes.ToArray(), signature.ReturnType)
                }
            }
            throw InvalidOperationException("$typeName::$methodName not found in $assemblyPath")
        }

        private func CompileVerifyAndRun()(AssemblyPath string, Lines[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_3945_facade_").FullName
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, Source)
            let outPath = Path.Combine(tempDir, "Program.dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            let psi = ProcessStartInfo("dotnet", "\"$outPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            Assert.True(process.WaitForExit(60_000), "the sample timed out")
            Assert.True(process.ExitCode == 0, (`the sample exited ` + "${process.ExitCode}" + `:
` + "$output"))
            let lines = output
                .ToString()
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            return (outPath, lines)
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            if AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is not string tpa || tpa.Length == 0 {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
