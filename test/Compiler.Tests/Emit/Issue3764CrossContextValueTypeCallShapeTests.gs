// <copyright file="Issue3764CrossContextValueTypeCallShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #3764 (regression from #3754 / #3730). The emitter decided
/// "value-type receiver — `call` through a managed pointer" versus
/// "reference receiver — `callvirt` on the value" by asking the receiver's
/// CLR type (cref:Type.IsValueType) directly.
///
/// That property is not a metadata fact. Every implementation answers it by
/// comparing the type's base against the <em>asking context's</em>
/// `System.ValueType`, which inside a
/// (cref:System.Reflection.MetadataLoadContext) means the
/// `System.ValueType` of that context's <em>core assembly</em>. A struct
/// that reached the compilation from some other assembly therefore answers
/// `false` — silently, no exception — and the emitter chose
/// `callvirt` plus a by-value receiver for a struct's instance call.
///
/// #3754 moved `DefaultInterpolatedStringHandler` resolution off a host
/// `typeof` and onto `ReferenceResolver.TryResolveType`, which is
/// what first steered a real compile into that state: a `netstandard`
/// target does not declare the handler, so the resolver's host fallback
/// supplies the definition out of `System.Private.CoreLib` while the
/// context's core assembly stays `netstandard`. Every interpolated string
/// in `src/Sdk/Gsharp.NET.Sdk` then emitted
/// `[CallVirtOnValueType]` + `[StackUnexpected]` IL. The compile
/// reported success; only ILVerify caught it.
///
/// Issue #3769 subsequently removed this handler from the emit path entirely:
/// the resolver fallback remains observable, while interpolation lowers to
/// target-compatible composite formatting and executes without referencing the
/// host core library.
open class Issue3764CrossContextValueTypeCallShapeTests {
    /// The predicate underneath the emit decision, asked about the exact type
    /// that reaches the emitter. The closure's core assembly is
    /// `netstandard` and the handler is answered out of the host's
    /// `System.Private.CoreLib`, so the two questions disagree unless the
    /// value-type question is asked in a cross-context-safe way.
    @Fact
    func HandlerFromOutsideTheClosuresCoreAssembly_IsAValueType() {
        using let workspace = Issue3764CrossContextValueTypeCallShapeTests.Workspace()
        using let resolver = ReferenceResolver.WithReferences(workspace.NetStandardClosureWithDependency())
        Assert.True(
            resolver.TryResolveType(
                "System.Runtime.CompilerServices.DefaultInterpolatedStringHandler",
                out var handler
            ),
            "the fixture's netstandard closure did not surface a handler at all; " +
                "the differential below would be vacuous"
        )
        // Anti-vacuity: the point of the fixture is that the handler is NOT the
        // target framework's own type. If a future netstandard pack declares
        // one, this fixture no longer reproduces #3764 and must be re-aimed
        // rather than silently passing.
        Assert.Equal("System.Private.CoreLib", handler.Assembly.GetName().Name)
        Assert.True(resolver.IsHostFallback(handler))
        Assert.False(DefaultInterpolatedStringHandlerShape.TryResolve(resolver, out _, out _))
        // Only a value type can be by-ref-like. Both answers must agree.
        Assert.True(ClrTypeUtilities.IsByRefLike(handler))
        Assert.True(ClrTypeUtilities.IsValueTypeSafe(handler))
    }

    /// The resolver can see the host handler, but the emitted target must not.
    /// The interpolation uses `String.Format` from the target closure.
    @Fact
    func InterpolationAgainstANetStandardTarget_DoesNotReferenceTheHostHandler() {
        using let workspace = Issue3764CrossContextValueTypeCallShapeTests.Workspace()
        let probe = workspace.CompileProbe()
        using let stream = File.OpenRead(probe)
        using let pe = PEReader(stream)
        let metadata = pe.GetMetadataReader()
        Assert.DoesNotContain(
            metadata.TypeReferences.Select(metadata.GetTypeReference),
            (type TypeReference) -> metadata.GetString(type.Name) == HandlerTypeName
        )
        let format = Assert.Single(
            metadata.MemberReferences.Select(metadata.GetMemberReference),
            (member MemberReference) -> metadata.GetString(member.Name) == "Format" &&
                member
                .Parent
                .Kind == HandleKind.TypeReference &&
                metadata.GetString(metadata.GetTypeReference(TypeReferenceHandle(member.Parent)).Name) == "String"
        )
        let stringType = metadata.GetTypeReference(TypeReferenceHandle(format.Parent))
        Assert.Equal(HandleKind.AssemblyReference, stringType.ResolutionScope.Kind)
        Assert.NotEqual(
            "System.Private.CoreLib",
            metadata.GetString(metadata.GetAssemblyReference(AssemblyReferenceHandle(stringType.ResolutionScope)).Name)
        )
    }

    /// Verification and execution, because "it compiled" was not sufficient to
    /// catch the original leak. Running proves the target-compatible fallback
    /// preserves interpolation output.
    @Fact
    func InterpolationAgainstANetStandardTarget_VerifiesAndRuns() {
        using let workspace = Issue3764CrossContextValueTypeCallShapeTests.Workspace()
        let probe = workspace.CompileProbe()
        IlVerifier.Verify(probe)
        let context = AssemblyLoadContext("gs3764-${Guid.NewGuid():N}", isCollectible: true)
        try {
            let assembly = context.LoadFromAssemblyPath(probe)
            let formatter Type? = assembly.GetType("Probe.Formatter", throwOnError: true)
            let instance object? = Activator.CreateInstance(formatter!!)
            let describe MethodInfo? = formatter!!.GetMethod("Describe", BindingFlags.Public | BindingFlags.Instance)
            Assert.NotNull(describe)
            Assert.Equal("name=widget count=  07!", describe!!.Invoke(instance, []object{"widget", 7}))
        } finally {
            context.Unload()
        }
    }

    /// A temporary directory holding the fixture's compiled dependency and
    /// probe, plus the netstandard reference closure they are built against.
    private class Workspace : IDisposable {
        private let directory string = Directory.CreateTempSubdirectory("gs_issue3764_").FullName
        private var dependency string?

        /// The reference closure that reproduces #3764: the SDK's
        /// `NETStandard.Library.Ref` targeting pack — which declares no
        /// `DefaultInterpolatedStringHandler`, so the compilation's core
        /// assembly is `netstandard` — together with one ordinary
        /// (non-framework) library, the way any real project references a
        /// NuGet dependency.
        /// @returns The reference paths.
        func NetStandardClosureWithDependency() IReadOnlyList[string] {
            this.dependency ??= this.Compile(
                "dependency",
                Issue3764CrossContextValueTypeCallShapeTests.DependencySource,
                NetStandardReferencePack()
            )
            return NetStandardReferencePack().Append(this.dependency!!).ToList()
        }

        /// Compiles (cref:ProbeSource) against that closure.
        /// @returns The emitted assembly's path.
        func CompileProbe() string -> this.Compile(
            "probe",
            Issue3764CrossContextValueTypeCallShapeTests.ProbeSource,
            this.NetStandardClosureWithDependency()
        )

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        func Dispose() {
            try {
                Directory.Delete(this.directory, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }

        private func Compile(name string, source string, references IEnumerable[string]) string {
            let sourcePath = Path.Combine(this.directory, name + ".gs")
            let outputPath = Path.Combine(this.directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            let arguments = List[string]{
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:netstandard2.0",
                "/nowarn:GS9100"
            }
            for reference in references {
                arguments.Add("/reference:" + reference)
            }
            arguments.Add(sourcePath)
            using let standardOutput = StringWriter()
            using let standardError = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(standardOutput)
            Console.SetError(standardError)
            try {
                let exitCode = Program.Main(arguments.ToArray())
                Assert.True(exitCode == 0, (`compiling '` + "$name" + `' failed (` + "$exitCode" + `):
` + "$standardOutput" + `
` + "$standardError"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return outputPath
        }

        shared {
            /// The `NETStandard.Library.Ref` targeting pack that ships inside
            /// the .NET SDK, so the fixture needs no extra install. Mirrors
            /// `Issue3730InterpolatedStringHandlerTargetFrameworkTests`.
            /// @returns The targeting pack's reference assemblies.
            private func NetStandardReferencePack() IEnumerable[string] {
                let runtimeDirectory string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                Assert.False(string.IsNullOrEmpty(runtimeDirectory), "host runtime directory not resolvable")
                let dotnetRoot string? = Directory.GetParent(runtimeDirectory!!)?.Parent?.Parent?.FullName
                Assert.False(string.IsNullOrEmpty(dotnetRoot), "dotnet root not resolvable")
                let packRoot = Path.Combine(dotnetRoot!!, "packs", "NETStandard.Library.Ref")
                Assert.True(Directory.Exists(packRoot), "targeting pack root '$packRoot' missing")
                let referenceDirectory string? = Directory
                    .EnumerateDirectories(packRoot)
                    .OrderBy((version string) -> version, StringComparer.Ordinal)
                    .Select(
                    (version string) -> Directory
                        .EnumerateDirectories(Path.Combine(version, "ref"))
                        .OrderBy((framework string) -> framework, StringComparer.Ordinal)
                        .LastOrDefault()
                )
                    .LastOrDefault((candidate string) -> candidate != nil)
                Assert.False(
                    string.IsNullOrEmpty(referenceDirectory),
                    "no netstandard reference directory under '$packRoot'"
                )
                return Directory.EnumerateFiles(referenceDirectory!!, "*.dll")
            }
        }
    }

    shared {
        private const HandlerTypeName string = "DefaultInterpolatedStringHandler"

        private const ProbeSource string = `package Probe

class Formatter {
    func Describe(name string, count int32) string {
        return "name=${name} count=${count,4:D2}!"
    }
}`

        // A library with no BCL identity of its own. Its only job is to make the
        // reference set look like a real project's: the resolver folds the host's
        // runtime assemblies into the visible surface once the references include
        // anything that is not itself a framework assembly (ReferenceResolver
        // .WithReferences), which is what lets a type absent from the target
        // framework be answered out of the host's System.Private.CoreLib.
        private const DependencySource string = `package Dependency

class Marker {
    func Value() int32 {
        return 1
    }
}`
    }
}
