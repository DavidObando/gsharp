// <copyright file="Issue3764CrossContextValueTypeCallShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3764 (regression from #3754 / #3730). The emitter decided
/// "value-type receiver — <c>call</c> through a managed pointer" versus
/// "reference receiver — <c>callvirt</c> on the value" by asking the receiver's
/// CLR type <see cref="Type.IsValueType"/> directly.
/// <para>
/// That property is not a metadata fact. Every implementation answers it by
/// comparing the type's base against the <em>asking context's</em>
/// <c>System.ValueType</c>, which inside a
/// <see cref="System.Reflection.MetadataLoadContext"/> means the
/// <c>System.ValueType</c> of that context's <em>core assembly</em>. A struct
/// that reached the compilation from some other assembly therefore answers
/// <see langword="false"/> — silently, no exception — and the emitter chose
/// <c>callvirt</c> plus a by-value receiver for a struct's instance call.
/// </para>
/// <para>
/// #3754 moved <c>DefaultInterpolatedStringHandler</c> resolution off a host
/// <c>typeof</c> and onto <c>ReferenceResolver.TryResolveType</c>, which is
/// what first steered a real compile into that state: a <c>netstandard</c>
/// target does not declare the handler, so the resolver's host fallback
/// supplies the definition out of <c>System.Private.CoreLib</c> while the
/// context's core assembly stays <c>netstandard</c>. Every interpolated string
/// in <c>src/Sdk/Gsharp.NET.Sdk</c> then emitted
/// <c>[CallVirtOnValueType]</c> + <c>[StackUnexpected]</c> IL. The compile
/// reported success; only ILVerify caught it.
/// </para>
/// <para>
/// Issue #3769 subsequently removed this handler from the emit path entirely:
/// the resolver fallback remains observable, while interpolation lowers to
/// target-compatible composite formatting and executes without referencing the
/// host core library.
/// </para>
/// </summary>
public class Issue3764CrossContextValueTypeCallShapeTests
{
    private const string HandlerTypeName = "DefaultInterpolatedStringHandler";

    private const string ProbeSource = """
        package Probe

        class Formatter {
            func Describe(name string, count int32) string {
                return "name=${name} count=${count,4:D2}!"
            }
        }
        """;

    // A library with no BCL identity of its own. Its only job is to make the
    // reference set look like a real project's: the resolver folds the host's
    // runtime assemblies into the visible surface once the references include
    // anything that is not itself a framework assembly (ReferenceResolver
    // .WithReferences), which is what lets a type absent from the target
    // framework be answered out of the host's System.Private.CoreLib.
    private const string DependencySource = """
        package Dependency

        class Marker {
            func Value() int32 {
                return 1
            }
        }
        """;

    /// <summary>
    /// The predicate underneath the emit decision, asked about the exact type
    /// that reaches the emitter. The closure's core assembly is
    /// <c>netstandard</c> and the handler is answered out of the host's
    /// <c>System.Private.CoreLib</c>, so the two questions disagree unless the
    /// value-type question is asked in a cross-context-safe way.
    /// </summary>
    [Fact]
    public void HandlerFromOutsideTheClosuresCoreAssembly_IsAValueType()
    {
        using var workspace = new Workspace();
        using var resolver = ReferenceResolver.WithReferences(workspace.NetStandardClosureWithDependency());

        Assert.True(
            resolver.TryResolveType(
                "System.Runtime.CompilerServices.DefaultInterpolatedStringHandler",
                out var handler),
            "the fixture's netstandard closure did not surface a handler at all; "
            + "the differential below would be vacuous");

        // Anti-vacuity: the point of the fixture is that the handler is NOT the
        // target framework's own type. If a future netstandard pack declares
        // one, this fixture no longer reproduces #3764 and must be re-aimed
        // rather than silently passing.
        Assert.Equal("System.Private.CoreLib", handler.Assembly.GetName().Name);
        Assert.True(resolver.IsHostFallback(handler));
        Assert.False(DefaultInterpolatedStringHandlerShape.TryResolve(resolver, out _, out _));

        // Only a value type can be by-ref-like. Both answers must agree.
        Assert.True(ClrTypeUtilities.IsByRefLike(handler));
        Assert.True(ClrTypeUtilities.IsValueTypeSafe(handler));
    }

    /// <summary>
    /// The resolver can see the host handler, but the emitted target must not.
    /// The interpolation uses <c>String.Format</c> from the target closure.
    /// </summary>
    [Fact]
    public void InterpolationAgainstANetStandardTarget_DoesNotReferenceTheHostHandler()
    {
        using var workspace = new Workspace();
        var probe = workspace.CompileProbe();

        using var stream = File.OpenRead(probe);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();

        Assert.DoesNotContain(
            metadata.TypeReferences.Select(metadata.GetTypeReference),
            type => metadata.GetString(type.Name) == HandlerTypeName);
        var format = Assert.Single(
            metadata.MemberReferences.Select(metadata.GetMemberReference),
            member => metadata.GetString(member.Name) == "Format"
                && member.Parent.Kind == HandleKind.TypeReference
                && metadata.GetString(metadata.GetTypeReference((TypeReferenceHandle)member.Parent).Name) == "String");
        var stringType = metadata.GetTypeReference((TypeReferenceHandle)format.Parent);
        Assert.Equal(HandleKind.AssemblyReference, stringType.ResolutionScope.Kind);
        Assert.NotEqual(
            "System.Private.CoreLib",
            metadata.GetString(metadata.GetAssemblyReference((AssemblyReferenceHandle)stringType.ResolutionScope).Name));
    }

    /// <summary>
    /// Verification and execution, because "it compiled" was not sufficient to
    /// catch the original leak. Running proves the target-compatible fallback
    /// preserves interpolation output.
    /// </summary>
    [Fact]
    public void InterpolationAgainstANetStandardTarget_VerifiesAndRuns()
    {
        using var workspace = new Workspace();
        var probe = workspace.CompileProbe();

        IlVerifier.Verify(probe);

        var context = new AssemblyLoadContext($"gs3764-{Guid.NewGuid():N}", isCollectible: true);
        try
        {
            var assembly = context.LoadFromAssemblyPath(probe);
            var formatter = assembly.GetType("Probe.Formatter", throwOnError: true);
            var instance = Activator.CreateInstance(formatter);
            var describe = formatter.GetMethod("Describe", BindingFlags.Public | BindingFlags.Instance);
            Assert.NotNull(describe);

            Assert.Equal(
                "name=widget count=  07!",
                describe.Invoke(instance, new object[] { "widget", 7 }));
        }
        finally
        {
            context.Unload();
        }
    }

    /// <summary>
    /// A temporary directory holding the fixture's compiled dependency and
    /// probe, plus the netstandard reference closure they are built against.
    /// </summary>
    private sealed class Workspace : IDisposable
    {
        private readonly string directory =
            Directory.CreateTempSubdirectory("gs_issue3764_").FullName;

        private string dependency;

        /// <summary>
        /// The reference closure that reproduces #3764: the SDK's
        /// <c>NETStandard.Library.Ref</c> targeting pack — which declares no
        /// <c>DefaultInterpolatedStringHandler</c>, so the compilation's core
        /// assembly is <c>netstandard</c> — together with one ordinary
        /// (non-framework) library, the way any real project references a
        /// NuGet dependency.
        /// </summary>
        /// <returns>The reference paths.</returns>
        public IReadOnlyList<string> NetStandardClosureWithDependency()
        {
            this.dependency ??= this.Compile(
                "dependency",
                DependencySource,
                NetStandardReferencePack());

            return NetStandardReferencePack().Append(this.dependency).ToList();
        }

        /// <summary>Compiles <see cref="ProbeSource"/> against that closure.</summary>
        /// <returns>The emitted assembly's path.</returns>
        public string CompileProbe()
            => this.Compile("probe", ProbeSource, this.NetStandardClosureWithDependency());

        /// <inheritdoc/>
        public void Dispose()
        {
            try
            {
                Directory.Delete(this.directory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        /// <summary>
        /// The <c>NETStandard.Library.Ref</c> targeting pack that ships inside
        /// the .NET SDK, so the fixture needs no extra install. Mirrors
        /// <c>Issue3730InterpolatedStringHandlerTargetFrameworkTests</c>.
        /// </summary>
        /// <returns>The targeting pack's reference assemblies.</returns>
        private static IEnumerable<string> NetStandardReferencePack()
        {
            var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
            Assert.False(string.IsNullOrEmpty(runtimeDirectory), "host runtime directory not resolvable");

            var dotnetRoot = Directory.GetParent(runtimeDirectory)?.Parent?.Parent?.FullName;
            Assert.False(string.IsNullOrEmpty(dotnetRoot), "dotnet root not resolvable");

            var packRoot = Path.Combine(dotnetRoot, "packs", "NETStandard.Library.Ref");
            Assert.True(Directory.Exists(packRoot), $"targeting pack root '{packRoot}' missing");

            var referenceDirectory = Directory
                .EnumerateDirectories(packRoot)
                .OrderBy(version => version, StringComparer.Ordinal)
                .Select(version => Directory
                    .EnumerateDirectories(Path.Combine(version, "ref"))
                    .OrderBy(framework => framework, StringComparer.Ordinal)
                    .LastOrDefault())
                .LastOrDefault(candidate => candidate != null);
            Assert.False(
                string.IsNullOrEmpty(referenceDirectory),
                $"no netstandard reference directory under '{packRoot}'");

            return Directory.EnumerateFiles(referenceDirectory, "*.dll");
        }

        private string Compile(string name, string source, IEnumerable<string> references)
        {
            var sourcePath = Path.Combine(this.directory, name + ".gs");
            var outputPath = Path.Combine(this.directory, name + ".dll");
            File.WriteAllText(sourcePath, source);

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:netstandard2.0",

                // The targeting pack's facades name desktop-only assemblies
                // that no netstandard project supplies either; the warning is
                // about the fixture's reference list, not the code under test.
                "/nowarn:GS9100",
            };

            foreach (var reference in references)
            {
                arguments.Add("/reference:" + reference);
            }

            arguments.Add(sourcePath);

            using var standardOutput = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOutput);
            Console.SetError(standardError);
            try
            {
                var exitCode = Program.Main(arguments.ToArray());
                Assert.True(
                    exitCode == 0,
                    $"compiling '{name}' failed ({exitCode}):\n{standardOutput}\n{standardError}");
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            return outputPath;
        }
    }
}
