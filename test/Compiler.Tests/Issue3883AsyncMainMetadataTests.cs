// <copyright file="Issue3883AsyncMainMetadataTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3883: gsc used to erase the <c>Task</c> from an <c>async func Main</c>
/// in metadata. <c>Binder.ResolveEntryPoint</c> (#1996) treats ANY static
/// <c>Main</c> as an entry-point candidate — even under
/// <c>/target:library</c> — and the emitter then rewrote that method's own
/// signature to the CLR entry-point shape (#1904), so consumers in another
/// assembly saw a synchronous <c>int32</c> method. The failure surfaced as a
/// masking <c>GS0159 Cannot find function ConfigureAwait</c> at the caller,
/// never naming the rewritten signature.
/// <para>
/// The fix follows csc: a library resolves no entry point at all, and an
/// executable keeps its authored <c>Main</c> Task-shaped while a SEPARATE
/// synthesized <c>&lt;Main&gt;$</c> stub carries the CLR entry-point shape and
/// drives the task to completion.
/// </para>
/// <para>
/// Every assertion here is cross-assembly or reflective on purpose: the
/// same-assembly call path binds against the source symbol rather than the
/// emitted one, so it stayed green throughout the defect and hides it
/// completely.
/// </para>
/// </summary>
public class Issue3883AsyncMainMetadataTests
{
    private const string ClassScopedAsyncMainLibrary = """
        package Probe.Lib

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
        }
        """;

    private const string PackageScopedAsyncMainApp = """
        package Probe.PkgApp

        import System
        import System.Threading.Tasks

        async func Main() int32 {
            await Task.Yield()
            Console.WriteLine("pkg main ran")
            return 7
        }
        """;

    private const string ClassScopedAsyncMainApp = """
        package Probe.ClsApp

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
        }
        """;

    /// <summary>
    /// The reflection proof from the issue. A <c>/target:library</c> has no
    /// entry point to resolve, so an <c>async func Main</c> in it is an
    /// ordinary member and must keep <c>Task&lt;int32&gt;</c> — exactly like
    /// the <c>Sibling</c> control that differs only in its NAME.
    /// </summary>
    [Fact]
    public void AsyncMainInLibrary_KeepsItsTaskInMetadata()
    {
        using var work = new Workspace();
        string libPath = work.CompileLibrary("Probe.Lib.dll", "Lib.gs", ClassScopedAsyncMainLibrary);

        Assert.Equal("System.Threading.Tasks.Task`1<Int32>", ReturnTypeOf(libPath, "Runner", "Main"));

        // Anti-vacuity control: `Sibling` was ALWAYS Task-shaped, so a fix that
        // broke async return encoding generally would fail here too.
        Assert.Equal("System.Threading.Tasks.Task`1<String>", ReturnTypeOf(libPath, "Runner", "Sibling"));

        // A library must carry no PE entry point at all.
        Assert.Equal(0, EntryPointToken(libPath));
        IlVerifier.Verify(libPath, Array.Empty<string>());
    }

    /// <summary>
    /// The discriminating test: another assembly awaits the library's
    /// <c>Main</c>. On origin/main this does not even compile
    /// (<c>GS0159 Cannot find function ConfigureAwait</c>, because
    /// <c>Runner.Main()</c> had become <c>int32</c>); it must now compile, RUN,
    /// and produce the awaited value.
    /// </summary>
    [Fact]
    public void ConsumerInAnotherAssembly_CanAwaitTheLibrarysAsyncMain()
    {
        using var work = new Workspace();
        string libPath = work.CompileLibrary("Probe.Lib.dll", "Lib.gs", ClassScopedAsyncMainLibrary);

        string stdout = work.CompileAndRunApp(
            "Probe.Consumer.dll",
            "Consumer.gs",
            """
            package Probe.Consumer

            import System
            import Probe.Lib

            async func Sum() int32 {
                let value = await Runner.Main().ConfigureAwait(false)
                return value + 1
            }

            Console.WriteLine(Sum().GetAwaiter().GetResult())
            """,
            new[] { libPath });

        Assert.Equal("42" + Environment.NewLine, stdout);
    }

    /// <summary>
    /// An executable's authored class-scoped <c>Main</c> keeps its
    /// <c>Task&lt;T&gt;</c> and gains a sibling <c>&lt;Main&gt;$</c> stub that
    /// is the real PE entry point — csc's shape. The stub must live on the SAME
    /// type: its body is a second async kickoff over a state machine that is a
    /// private nested type of that class, so a <c>&lt;Program&gt;</c>-hosted
    /// stub fails the CLR's field-access check at run time
    /// (<c>FieldAccessException</c>), which is why this test RUNS the program.
    /// </summary>
    [Fact]
    public void AsyncMainInExecutable_KeepsItsTaskAndGetsASeparateEntryPointStub()
    {
        using var work = new Workspace();
        string appPath = work.CompileApp("Probe.ClsApp.dll", "ClsApp.gs", ClassScopedAsyncMainApp, Array.Empty<string>());

        Assert.Equal("System.Threading.Tasks.Task`1<Int32>", ReturnTypeOf(appPath, "Program", "Main"));
        Assert.Equal("Int32", ReturnTypeOf(appPath, "Program", "<Main>$"));
        Assert.Equal(TokenOf(appPath, "Program", "<Main>$"), EntryPointToken(appPath));

        IlVerifier.Verify(appPath, Array.Empty<string>());
        Assert.Equal("class main ran" + Environment.NewLine, work.Run(appPath, expectedExitCode: 5));
    }

    /// <summary>
    /// Same for a package-scope <c>async func Main</c>, whose row lives on the
    /// package's <c>&lt;Program&gt;</c> type rather than a user class.
    /// </summary>
    [Fact]
    public void PackageScopeAsyncMain_KeepsItsTaskAndGetsASeparateEntryPointStub()
    {
        using var work = new Workspace();
        string appPath = work.CompileApp("Probe.PkgApp.dll", "PkgApp.gs", PackageScopedAsyncMainApp, Array.Empty<string>());

        Assert.Equal("System.Threading.Tasks.Task`1<Int32>", ReturnTypeOf(appPath, "<Program>", "Main"));
        Assert.Equal("Int32", ReturnTypeOf(appPath, "<Program>", "<Main>$"));
        Assert.Equal(TokenOf(appPath, "<Program>", "<Main>$"), EntryPointToken(appPath));

        IlVerifier.Verify(appPath, Array.Empty<string>());
        Assert.Equal("pkg main ran" + Environment.NewLine, work.Run(appPath, expectedExitCode: 7));
    }

    /// <summary>
    /// A SYNC <c>Main</c> is untouched by this change: it keeps its own name
    /// and row as the entry point, with no <c>&lt;Main&gt;$</c> stub. Without
    /// this guard the fix could have renamed every entry point.
    /// </summary>
    [Fact]
    public void SyncMain_IsUnchanged_NoStubAndNoRename()
    {
        using var work = new Workspace();
        string appPath = work.CompileApp(
            "Probe.SyncApp.dll",
            "SyncApp.gs",
            """
            package Probe.SyncApp

            import System

            class Program {
                shared {
                    public func Main() int32 {
                        Console.WriteLine("sync main ran")
                        return 9
                    }
                }
            }
            """,
            Array.Empty<string>());

        Assert.Equal("Int32", ReturnTypeOf(appPath, "Program", "Main"));
        Assert.DoesNotContain("<Main>$", MethodNames(appPath), StringComparer.Ordinal);
        Assert.Equal(TokenOf(appPath, "Program", "Main"), EntryPointToken(appPath));
        Assert.Equal("sync main ran" + Environment.NewLine, work.Run(appPath, expectedExitCode: 9));
    }

    /// <summary>
    /// Top-level statements still lower to the synthesized <c>&lt;Main&gt;$</c>
    /// with the CLR entry-point signature — issue #1904's behaviour, which this
    /// change must not disturb (there is no authored declaration to preserve).
    /// </summary>
    [Fact]
    public void TopLevelAwait_StillRewritesTheSynthesizedEntryPointInPlace()
    {
        using var work = new Workspace();
        string appPath = work.CompileApp(
            "Probe.TlsApp.dll",
            "TlsApp.gs",
            """
            package Probe.TlsApp

            import System
            import System.Threading.Tasks

            await Task.Yield()
            Console.WriteLine("tls ran")
            """,
            Array.Empty<string>());

        Assert.Equal("Void", ReturnTypeOf(appPath, "<Program>", "<Main>$"));
        Assert.Equal("tls ran" + Environment.NewLine, work.Run(appPath, expectedExitCode: 0));
    }

    private static string ReturnTypeOf(string assemblyPath, string typeName, string methodName)
        => Methods(assemblyPath).Single(m => m.Type == typeName && m.Method == methodName).ReturnType;

    private static int TokenOf(string assemblyPath, string typeName, string methodName)
        => Methods(assemblyPath).Single(m => m.Type == typeName && m.Method == methodName).Token;

    private static IEnumerable<string> MethodNames(string assemblyPath)
        => Methods(assemblyPath).Select(m => m.Method).ToList();

    private static List<(string Type, string Method, string ReturnType, int Token)> Methods(string assemblyPath)
    {
        var result = new List<(string Type, string Method, string ReturnType, int Token)>();
        using FileStream stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        MetadataReader reader = peReader.GetMetadataReader();
        foreach (TypeDefinitionHandle typeHandle in reader.TypeDefinitions)
        {
            TypeDefinition type = reader.GetTypeDefinition(typeHandle);
            string typeName = reader.GetString(type.Name);
            foreach (MethodDefinitionHandle methodHandle in type.GetMethods())
            {
                MethodDefinition method = reader.GetMethodDefinition(methodHandle);
                MethodSignature<string> signature = method.DecodeSignature(SignatureNames.Instance, genericContext: null);
                result.Add((
                    typeName,
                    reader.GetString(method.Name),
                    signature.ReturnType,
                    MetadataTokens.GetToken(methodHandle)));
            }
        }

        return result;
    }

    private static int EntryPointToken(string assemblyPath)
    {
        using FileStream stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        return peReader.PEHeaders.CorHeader.EntryPointTokenOrRelativeVirtualAddress;
    }

    /// <summary>
    /// Renders metadata signature types as short display strings for the
    /// assertions above.
    /// </summary>
    private sealed class SignatureNames : ISignatureTypeProvider<string, object>
    {
        internal static readonly SignatureNames Instance = new();

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
        {
            TypeDefinition definition = reader.GetTypeDefinition(handle);
            string ns = reader.GetString(definition.Namespace);
            string name = reader.GetString(definition.Name);
            return ns.Length == 0 ? name : ns + "." + name;
        }

        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
        {
            TypeReference reference = reader.GetTypeReference(handle);
            string ns = reader.GetString(reference.Namespace);
            string name = reader.GetString(reference.Name);
            return ns.Length == 0 ? name : ns + "." + name;
        }

        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
            => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
    }

    /// <summary>
    /// A throwaway directory that compiles G# sources with the in-process gsc
    /// entry point and runs the results out of process.
    /// </summary>
    private sealed class Workspace : IDisposable
    {
        private readonly string root = Directory.CreateTempSubdirectory("gs_issue3883_").FullName;

        public string CompileLibrary(string outputName, string fileName, string source)
            => this.CompileCore(outputName, fileName, source, "/target:library", Array.Empty<string>());

        public string CompileApp(string outputName, string fileName, string source, IReadOnlyList<string> references)
            => this.CompileCore(outputName, fileName, source, "/target:exe", references);

        public string CompileAndRunApp(
            string outputName,
            string fileName,
            string source,
            IReadOnlyList<string> references)
        {
            string appPath = this.CompileApp(outputName, fileName, source, references);
            return this.Run(appPath, expectedExitCode: 0);
        }

        public string Run(string appPath, int expectedExitCode)
        {
            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = this.root,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(appPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(appPath);

            using Process process = Process.Start(psi)
                ?? throw new InvalidOperationException("failed to start dotnet exec");
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(60_000), "dotnet exec timed out");
            Assert.True(
                process.ExitCode == expectedExitCode,
                $"expected exit {expectedExitCode}, got {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(this.root, recursive: true);
            }
            catch (IOException)
            {
                // A best-effort cleanup; a locked file must not fail the test.
            }
            catch (UnauthorizedAccessException)
            {
                // Same.
            }
        }

        private string CompileCore(
            string outputName,
            string fileName,
            string source,
            string targetSwitch,
            IReadOnlyList<string> references)
        {
            string sourcePath = Path.Combine(this.root, fileName);
            string outputPath = Path.Combine(this.root, outputName);
            File.WriteAllText(sourcePath, source);

            var args = new List<string>
            {
                "/out:" + outputPath,
                targetSwitch,
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (string reference in ReferenceClosure.TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            foreach (string reference in references)
            {
                args.Add("/reference:" + reference);
            }

            args.Add(sourcePath);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            TextWriter previousOut = Console.Out;
            TextWriter previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed for {outputName}:\n{stdout}{stderr}");
            return outputPath;
        }
    }
}
