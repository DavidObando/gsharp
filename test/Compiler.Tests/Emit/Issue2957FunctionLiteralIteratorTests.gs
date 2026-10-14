// <copyright file="Issue2957FunctionLiteralIteratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2957: iterator function literals must receive iterator state-machine
/// plans before their hosted bodies reach emission.
class Issue2957FunctionLiteralIteratorTests {
    @Theory
    @MemberData("Cases")
    func IteratorLiteral_LoadsAndRuns(name string, source string, expectedOutput string) {
        let assemblyPath = Compile(name, source)
        IlVerifier.Verify(assemblyPath)
        Assert.NotEmpty(EmittedFixture.Load(assemblyPath).GetTypes())
        Assert.Equal(expectedOutput, RunBounded(name, assemblyPath))
    }

    @Fact
    func GenericReceiverStateMachineMemberSignatures_UseSourceTypeParameterOrdinals() {
        const name = "GenericStateMachineMemberSignatures"
        const source = `package GenericSignatures
import System

class Factory[T any] {
    func make[U any]() (T, U) -> sequence[U] {
        return func(first T, second U) sequence[U] {
            yield second
        }
    }
}

for value in Factory[int32]().make[string]()(42, "ok") {
    Console.WriteLine(value)
}`
        let assemblyPath = Compile(name, source)
        {
            using let stream = File.OpenRead(assemblyPath)
            {
                using let peReader = PEReader(stream)
                let metadata = peReader.GetMetadataReader()
                let stateMachine = metadata
                    .TypeDefinitions
                    .Select(metadata.GetTypeDefinition)
                    .Single(
                    (type TypeDefinition) -> metadata.GetString(type.Name).Contains(">d__", StringComparison.Ordinal)
                )
                Assert.Equal(2, stateMachine.GetGenericParameters().Count)
                AssertFieldTypeParameterOrdinal(metadata, stateMachine, "<>3__first", 0)
                AssertFieldTypeParameterOrdinal(metadata, stateMachine, "<>3__second", 1)
                AssertFieldTypeParameterOrdinal(metadata, stateMachine, "<>2__current", 1)
                AssertMemberReferenceTypeParameterEncoding(
                    metadata,
                    "<>3__first",
                    SignatureTypeCode.GenericTypeParameter,
                    0
                )
                AssertMemberReferenceTypeParameterEncoding(
                    metadata,
                    "<>3__second",
                    SignatureTypeCode.GenericTypeParameter,
                    1
                )
                let currentOrdinal = stateMachine
                    .GetMethods()
                    .Select(metadata.GetMethodDefinition)
                    .Where((method MethodDefinition) -> metadata.GetString(method.Name) == "get_Current")
                    .Select(
                    func (method MethodDefinition) int32? {
                        return ReadMethodReturnTypeParameterOrdinal(metadata, method)
                    }
                )
                    .Single((ordinal int32?) -> (ordinal != nil))
                Assert.Equal(1, currentOrdinal)
            }
        }
        IlVerifier.Verify(assemblyPath)
        Assert.NotEmpty(EmittedFixture.Load(assemblyPath).GetTypes())
        Assert.Equal("ok${Environment.NewLine}", RunBounded(name, assemblyPath))
    }

    shared {
        func Cases() sequence[[]object] {
            yield Case("ExactRepro", `package Repro
import System

let values = func() sequence[int32] { yield 2 }
for value in values() {
    Console.WriteLine(value)
}`, "2\n")
            yield Case("NestedLiteral", `package Nested
import System

let outer = func() () -> sequence[int32] {
    return func() sequence[int32] { yield 3 }
}

for value in outer()() {
    Console.WriteLine(value)
}`, "3\n")
            yield Case("CapturedLocalAcrossYield", `package Capture
import System

func make(start int32) () -> sequence[int32] {
    return func() sequence[int32] {
        yield start
        Console.WriteLine(start)
        yield start + 1
    }
}

for value in make(4)() {
    Console.WriteLine(value)
}`, `4
4
5
`)
            yield Case("GenericStateMachineSignatureRemap", `package Generic
import System

func make[T any]() (T) -> sequence[T] {
    return func(value T) sequence[T] { yield value }
}

for value in make[string]()("ok") {
    Console.WriteLine(value)
}`, "ok\n")
            yield Case("LoweredForInEnumerator", `package ForIn
import System

let values = func() sequence[int32] {
    for value in []int32{4, 5} {
        yield value
    }
}

for value in values() {
    Console.WriteLine(value)
}`, `4
5
`)
            yield Case("LoweredForInEnumeratorWithCapture", `package ForInCapture
import System

func make(offset int32) () -> sequence[int32] {
    return func() sequence[int32] {
        for value in []int32{4, 5} {
            yield offset + value
        }
    }
}

for value in make(100)() {
    Console.WriteLine(value)
}`, `104
105
`)
            yield Case("LoweredForEllipsisCounter", `package ForEllipsis
import System

let values = func() sequence[int32] {
    for value in 0 ... 2 {
        yield value
    }
}

for value in values() {
    Console.WriteLine(value)
}`, `0
1
`)
            yield Case("GenericStateMachineElementTokenRemap", `package GenericToken
import System

func make[T any]() (T) -> sequence[T] {
    return func(value T) sequence[T] {
        let copy = []T{value}
        yield copy[0]
    }
}

for value in make[int32]()(42) {
    Console.WriteLine(value)
}`, "42\n")
            yield Case("ImmediatelyInvoked", `package Immediate
import System

for value in (func() sequence[int32] { yield 7 })() {
    Console.WriteLine(value)
}`, "7\n")
            yield Case("NamedFunctionGuard", `package Named
import System

func values() sequence[int32] { yield 9 }
for value in values() {
    Console.WriteLine(value)
}`, "9\n")
        }

        private func Case(name string, source string, expectedOutput string)[]object -> []object{
            name,
            source,
            expectedOutput
        }

        private func AssertFieldTypeParameterOrdinal(
            metadata MetadataReader,
            stateMachine TypeDefinition,
            fieldName string,
            expectedOrdinal int32
        ) {
            let field = stateMachine
                .GetFields()
                .Select(metadata.GetFieldDefinition)
                .Single((candidate FieldDefinition) -> metadata.GetString(candidate.Name) == fieldName)
            var signature = metadata.GetBlobReader(field.Signature)
            Assert.Equal(SignatureKind.Field, signature.ReadSignatureHeader().Kind)
            Assert.Equal(SignatureTypeCode.GenericTypeParameter, signature.ReadSignatureTypeCode())
            Assert.Equal(expectedOrdinal, signature.ReadCompressedInteger())
            Assert.Equal(0, signature.RemainingBytes)
        }

        private func AssertMemberReferenceTypeParameterEncoding(
            metadata MetadataReader,
            memberName string,
            expectedCode SignatureTypeCode,
            expectedOrdinal int32
        ) {
            for handle in metadata.MemberReferences {
                let member = metadata.GetMemberReference(handle)
                if metadata.GetString(member.Name) != memberName {
                    continue
                }
                var signature = metadata.GetBlobReader(member.Signature)
                if signature.ReadSignatureHeader()
                    .Kind == SignatureKind.Field &&
                    signature.ReadSignatureTypeCode() == expectedCode &&
                    signature.ReadCompressedInteger() == expectedOrdinal &&
                    ParentUsesGenericTypeArguments(metadata, member.Parent) {
                    return
                }
            }
            Assert.Fail("Member reference '$memberName' did not encode $expectedCode($expectedOrdinal).")
        }

        /// The state-machine field's MemberRef must be parented at a TypeSpec that
        /// instantiates the state machine over a TYPE PARAMETER — never over an
        /// erased `object`, which is the failure #2957 guards against.
        /// @remarks Issue #3933 changed WHICH KIND of parameter that is, and the change is
        /// the point of that fix. This lambda is capture-free and lexically inside
        /// `Factory[T]`, so it used to be hoisted to a static method on
        /// `<Program>` and generic-promoted (#2118), making the kickoff's
        /// self-instantiation read `<Invoke>d__2<!!0, !!1>` —
        /// generic METHOD parameters. It is now hosted on a display class nested
        /// inside `Factory`1` and reified over its parameters, so `Invoke`
        /// is an instance method of a generic type and the same TypeSpec correctly
        /// reads `<Invoke>d__2<!0, !1>`. The ordinals — what this
        /// test is actually about — are unchanged.
        /// @param metadata The metadata reader.
        /// @param parent The MemberRef's parent handle.
        /// @returns `true` when the parent is a TypeSpec instantiated over a type parameter.
        private func ParentUsesGenericTypeArguments(metadata MetadataReader, parent EntityHandle) bool {
            const GenericInstance uint8 = uint8(0x15)
            const GenericTypeParameter uint8 = uint8(0x13)
            if parent.Kind != HandleKind.TypeSpecification {
                return false
            }
            let specification = metadata.GetTypeSpecification(TypeSpecificationHandle(parent))
            var signature = metadata.GetBlobReader(specification.Signature)
            if signature.ReadByte() != GenericInstance {
                return false
            }
            signature.ReadByte()
            signature.ReadCompressedInteger()
            return signature.ReadCompressedInteger() > 0 && signature.ReadByte() == GenericTypeParameter
        }

        private func ReadMethodReturnTypeParameterOrdinal(metadata MetadataReader, method MethodDefinition) int32? {
            var signature = metadata.GetBlobReader(method.Signature)
            var header = signature.ReadSignatureHeader()
            if header.IsGeneric {
                signature.ReadCompressedInteger()
            }
            signature.ReadCompressedInteger()
            if signature.ReadSignatureTypeCode() != SignatureTypeCode.GenericTypeParameter {
                return nil
            }
            return signature.ReadCompressedInteger()
        }

        private func Compile(name string, source string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2957FunctionLiteralIteratorTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, ("$name" + `: gsc failed:
` + "$stdout" + `
` + "$stderr"))
            return assemblyPath
        }

        private func RunBounded(name string, assemblyPath string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let stdoutTask = process!!.StandardOutput.ReadToEndAsync()
            let stderrTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(5_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                Assert.True(process!!.WaitForExit(5_000), "$name: child did not stop after kill")
            }
            let stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(exited, "$name: emitted program timed out")
            Assert.True(process!!.ExitCode == 0, ("$name" + `: emitted program failed:
` + "$stderr"))
            return stdout
        }
    }
}
