// <copyright file="Issue3883AsyncMainMetadataTests.cs" company="GSharp">
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
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3883: gsc used to erase the `Task` from an `async func Main`
/// in metadata. `Binder.ResolveEntryPoint` (#1996) treats ANY static
/// `Main` as an entry-point candidate — even under
/// `/target:library` — and the emitter then rewrote that method's own
/// signature to the CLR entry-point shape (#1904), so consumers in another
/// assembly saw a synchronous `int32` method. The failure surfaced as a
/// masking `GS0159 Cannot find function ConfigureAwait` at the caller,
/// never naming the rewritten signature.
///
/// The fix follows csc: a library resolves no entry point at all, and an
/// executable keeps its authored `Main` Task-shaped while a SEPARATE
/// synthesized `<Main>$` stub carries the CLR entry-point shape and
/// drives the task to completion.
///
/// Every assertion here is cross-assembly or reflective on purpose: the
/// same-assembly call path binds against the source symbol rather than the
/// emitted one, so it stayed green throughout the defect and hides it
/// completely.
open class Issue3883AsyncMainMetadataTests {
    /// The reflection proof from the issue. A `/target:library` has no
    /// entry point to resolve, so an `async func Main` in it is an
    /// ordinary member and must keep `Task<int32>` — exactly like
    /// the `Sibling` control that differs only in its NAME.
    @Fact
    func AsyncMainInLibrary_KeepsItsTaskInMetadata() {
        using let work = Issue3883AsyncMainMetadataTests.Workspace()
        let libPath = work.CompileLibrary("Probe.Lib.dll", "Lib.gs", ClassScopedAsyncMainLibrary)
        Assert.Equal("System.Threading.Tasks.Task`1<Int32>", ReturnTypeOf(libPath, "Runner", "Main"))
        // Anti-vacuity control: `Sibling` was ALWAYS Task-shaped, so a fix that
        // broke async return encoding generally would fail here too.
        Assert.Equal("System.Threading.Tasks.Task`1<String>", ReturnTypeOf(libPath, "Runner", "Sibling"))
        // A library must carry no PE entry point at all.
        Assert.Equal(0, EntryPointToken(libPath))
        IlVerifier.Verify(libPath, Array.Empty[string]())
    }

    /// The discriminating test: another assembly awaits the library's
    /// `Main`. On origin/main this does not even compile
    /// (`GS0159 Cannot find function ConfigureAwait`, because
    /// `Runner.Main()` had become `int32`); it must now compile, RUN,
    /// and produce the awaited value.
    @Fact
    func ConsumerInAnotherAssembly_CanAwaitTheLibrarysAsyncMain() {
        using let work = Issue3883AsyncMainMetadataTests.Workspace()
        let libPath = work.CompileLibrary("Probe.Lib.dll", "Lib.gs", ClassScopedAsyncMainLibrary)
        let stdout = work.CompileAndRunApp("Probe.Consumer.dll", "Consumer.gs", `package Probe.Consumer

import System
import Probe.Lib

async func Sum() int32 {
    let value = await Runner.Main().ConfigureAwait(false)
    return value + 1
}

Console.WriteLine(Sum().GetAwaiter().GetResult())`, []string{libPath})
        Assert.Equal("42" + Environment.NewLine, stdout)
    }

    /// An executable's authored class-scoped `Main` keeps its
    /// `Task<T>` and gains a sibling `<Main>$` stub that
    /// is the real PE entry point — csc's shape. The stub must live on the SAME
    /// type: its body is a second async kickoff over a state machine that is a
    /// private nested type of that class, so a `<Program>`-hosted
    /// stub fails the CLR's field-access check at run time
    /// (`FieldAccessException`), which is why this test RUNS the program.
    @Fact
    func AsyncMainInExecutable_KeepsItsTaskAndGetsASeparateEntryPointStub() {
        using let work = Issue3883AsyncMainMetadataTests.Workspace()
        let appPath = work.CompileApp("Probe.ClsApp.dll", "ClsApp.gs", ClassScopedAsyncMainApp, Array.Empty[string]())
        Assert.Equal("System.Threading.Tasks.Task`1<Int32>", ReturnTypeOf(appPath, "Program", "Main"))
        Assert.Equal("Int32", ReturnTypeOf(appPath, "Program", "<Main>$$"))
        Assert.Equal(TokenOf(appPath, "Program", "<Main>$$"), EntryPointToken(appPath))
        IlVerifier.Verify(appPath, Array.Empty[string]())
        Assert.Equal("class main ran" + Environment.NewLine, work.Run(appPath, expectedExitCode: 5))
    }

    /// Same for a package-scope `async func Main`, whose row lives on the
    /// package's `<Program>` type rather than a user class.
    @Fact
    func PackageScopeAsyncMain_KeepsItsTaskAndGetsASeparateEntryPointStub() {
        using let work = Issue3883AsyncMainMetadataTests.Workspace()
        let appPath = work.CompileApp("Probe.PkgApp.dll", "PkgApp.gs", PackageScopedAsyncMainApp, Array.Empty[string]())
        Assert.Equal("System.Threading.Tasks.Task`1<Int32>", ReturnTypeOf(appPath, "<Program>", "Main"))
        Assert.Equal("Int32", ReturnTypeOf(appPath, "<Program>", "<Main>$$"))
        Assert.Equal(TokenOf(appPath, "<Program>", "<Main>$$"), EntryPointToken(appPath))
        IlVerifier.Verify(appPath, Array.Empty[string]())
        Assert.Equal("pkg main ran" + Environment.NewLine, work.Run(appPath, expectedExitCode: 7))
    }

    /// A SYNC `Main` is untouched by this change: it keeps its own name
    /// and row as the entry point, with no `<Main>$` stub. Without
    /// this guard the fix could have renamed every entry point.
    @Fact
    func SyncMain_IsUnchanged_NoStubAndNoRename() {
        using let work = Issue3883AsyncMainMetadataTests.Workspace()
        let appPath = work.CompileApp("Probe.SyncApp.dll", "SyncApp.gs", `package Probe.SyncApp

import System

class Program {
    shared {
        public func Main() int32 {
            Console.WriteLine("sync main ran")
            return 9
        }
    }
}`, Array.Empty[string]())
        Assert.Equal("Int32", ReturnTypeOf(appPath, "Program", "Main"))
        Assert.DoesNotContain("<Main>$$", MethodNames(appPath), StringComparer.Ordinal)
        Assert.Equal(TokenOf(appPath, "Program", "Main"), EntryPointToken(appPath))
        Assert.Equal("sync main ran" + Environment.NewLine, work.Run(appPath, expectedExitCode: 9))
    }

    /// Top-level statements still lower to the synthesized `<Main>$`
    /// with the CLR entry-point signature — issue #1904's behaviour, which this
    /// change must not disturb (there is no authored declaration to preserve).
    @Fact
    func TopLevelAwait_StillRewritesTheSynthesizedEntryPointInPlace() {
        using let work = Issue3883AsyncMainMetadataTests.Workspace()
        let appPath = work.CompileApp("Probe.TlsApp.dll", "TlsApp.gs", `package Probe.TlsApp

import System
import System.Threading.Tasks

await Task.Yield()
Console.WriteLine("tls ran")`, Array.Empty[string]())
        Assert.Equal("Void", ReturnTypeOf(appPath, "<Program>", "<Main>$$"))
        Assert.Equal("tls ran" + Environment.NewLine, work.Run(appPath, expectedExitCode: 0))
    }

    /// Renders metadata signature types as short display strings for the
    /// assertions above.
    private class SignatureNames : ISignatureTypeProvider[string, object] {
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

        func GetTypeFromDefinition(reader MetadataReader, handle TypeDefinitionHandle, rawTypeKind uint8) string {
            let definition = reader.GetTypeDefinition(handle)
            let ns = reader.GetString(definition.Namespace)
            let name = reader.GetString(definition.Name)
            return if ns.Length == 0 {
                name
            } else {
                ns + "." + name
            }
        }

        func GetTypeFromReference(reader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) string {
            let reference = reader.GetTypeReference(handle)
            let ns = reader.GetString(reference.Namespace)
            let name = reader.GetString(reference.Name)
            return if ns.Length == 0 {
                name
            } else {
                ns + "." + name
            }
        }

        func GetTypeFromSpecification(
            reader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> reader
            .GetTypeSpecification(handle).DecodeSignature(this, genericContext)

        shared {
            internal let Instance SignatureNames = SignatureNames()
        }
    }

    /// A throwaway directory that compiles G# sources with the in-process gsc
    /// entry point and runs the results out of process.
    private class Workspace : IDisposable {
        private let root string = Directory.CreateTempSubdirectory("gs_issue3883_").FullName
        func CompileLibrary(outputName string, fileName string, source string) string -> this.CompileCore(
            outputName,
            fileName,
            source,
            "/target:library",
            Array.Empty[string]()
        )

        func CompileApp(
            outputName string,
            fileName string,
            source string,
            references IReadOnlyList[string]
        ) string -> this.CompileCore(outputName, fileName, source, "/target:exe", references)

        func CompileAndRunApp(
            outputName string,
            fileName string,
            source string,
            references IReadOnlyList[string]
        ) string {
            let appPath = this.CompileApp(outputName, fileName, source, references)
            return this.Run(appPath, expectedExitCode: 0)
        }

        func Run(appPath string, expectedExitCode int32) string {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = this.root
            }
            psi.ArgumentList.Add("exec")
            psi.ArgumentList.Add("--runtimeconfig")
            psi.ArgumentList.Add(Path.ChangeExtension(appPath, ".runtimeconfig.json"))
            psi.ArgumentList.Add(appPath)
            using let process = Process.Start(psi) ?? throw InvalidOperationException("failed to start dotnet exec")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(60_000), "dotnet exec timed out")
            Assert.True(
                process.ExitCode == expectedExitCode,
                (`expected exit ` + "$expectedExitCode" + `, got ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        func Dispose() {
            try {
                Directory.Delete(this.root, recursive: true)
            } catch (IOException) {
                // A best-effort cleanup; a locked file must not fail the test.

            } catch (UnauthorizedAccessException) {
                // Same.

            }
        }

        private func CompileCore(
            outputName string,
            fileName string,
            source string,
            targetSwitch string,
            references IReadOnlyList[string]
        ) string {
            let sourcePath = Path.Combine(this.root, fileName)
            let outputPath = Path.Combine(this.root, outputName)
            File.WriteAllText(sourcePath, source)
            let args = List[string]{"/out:" + outputPath, targetSwitch, "/targetframework:net10.0", "/nowarn:GS9100"}
            for reference in ReferenceClosure.TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            for reference in references {
                args.Add("/reference:" + reference)
            }
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed for ` + "$outputName" + `:
` + "$stdout" + "$stderr"))
            return outputPath
        }
    }

    shared {
        private const ClassScopedAsyncMainLibrary string = `package Probe.Lib

import System
import System.Threading.Tasks

class Runner {
    shared {
        public async func Main() int32 {
            await Task.Yield()
            return 41
        }

        public async func Sibling() string {
            await Task.Yield()
            return "sibling"
        }
    }
}`

        private const PackageScopedAsyncMainApp string = `package Probe.PkgApp

import System
import System.Threading.Tasks

async func Main() int32 {
    await Task.Yield()
    Console.WriteLine("pkg main ran")
    return 7
}`

        private const ClassScopedAsyncMainApp string = `package Probe.ClsApp

import System
import System.Threading.Tasks

class Program {
    shared {
        public async func Main() int32 {
            await Task.Yield()
            Console.WriteLine("class main ran")
            return 5
        }
    }
}`

        private func ReturnTypeOf(assemblyPath string, typeName string, methodName string) string -> Methods(
            assemblyPath
        )
            .Single(
            (m(Type string, Method string, ReturnType string, Token int32)) -> m.Type == typeName &&
                m.Method == methodName
        )
            .ReturnType

        private func TokenOf(assemblyPath string, typeName string, methodName string) int32 -> Methods(assemblyPath)
            .Single(
            (m(Type string, Method string, ReturnType string, Token int32)) -> m.Type == typeName &&
                m.Method == methodName
        )
            .Token

        private func MethodNames(assemblyPath string) IEnumerable[string] -> Methods(assemblyPath).Select(
            (m(Type string, Method string, ReturnType string, Token int32)) -> m.Method
        )
            .ToList()

        private func Methods(assemblyPath string) List[(Type string, Method string, ReturnType string, Token int32)] {
            let result = List[(Type string, Method string, ReturnType string, Token int32)]()
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            for typeHandle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(typeHandle)
                let typeName = reader.GetString(type.Name)
                for methodHandle in type.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    let signature = method.DecodeSignature(SignatureNames.Instance, genericContext: nil)
                    result.Add(
                        (
                            typeName,
                            reader.GetString(method.Name),
                            signature.ReturnType,
                            MetadataTokens.GetToken(methodHandle)
                        )
                    )
                }
            }
            return result
        }

        private func EntryPointToken(assemblyPath string) int32 {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            return peReader.PEHeaders.CorHeader!!.EntryPointTokenOrRelativeVirtualAddress
        }
    }
}
