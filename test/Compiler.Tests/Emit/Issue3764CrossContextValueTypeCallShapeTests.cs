// <copyright file="Issue3764CrossContextValueTypeCallShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
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
/// These tests pin the <em>emitted call shape</em> and execute the result.
/// Asserting that the handler merely resolves — which is what #3754's own
/// fixture asserted — passes on the bug.
/// </para>
/// </summary>
public class Issue3764CrossContextValueTypeCallShapeTests
{
    private const string HandlerTypeName = "DefaultInterpolatedStringHandler";

    private const string ProbeSource = """
        package Probe

        class Formatter {
            func Describe(name string, count int32) string {
                return "name=${name} count=${count}!"
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

        // Only a value type can be by-ref-like. Both answers must agree.
        Assert.True(ClrTypeUtilities.IsByRefLike(handler));
        Assert.True(ClrTypeUtilities.IsValueTypeSafe(handler));
    }

    /// <summary>
    /// The emitted shape. A struct's instance method takes <c>this</c> as a
    /// managed pointer: the receiver must be loaded by address and the call
    /// must be a non-virtual <c>call</c>. On the bug every one of these was a
    /// <c>callvirt</c> over the handler value.
    /// </summary>
    [Fact]
    public void InterpolationAgainstANetStandardTarget_CallsTheHandlerByAddress()
    {
        using var workspace = new Workspace();
        var probe = workspace.CompileProbe();

        var (calls, loadsAddress) = ReadHandlerCallShape(probe, "Formatter", "Describe");

        // Anti-vacuity: the method really did lower onto the handler.
        Assert.NotEmpty(calls);
        Assert.All(calls, call => Assert.Equal(OpCodes.Call, call.OpCode));
        Assert.DoesNotContain(calls, call => call.OpCode == OpCodes.Callvirt);
        Assert.True(loadsAddress, "the handler local was never loaded by address (ldloca)");
    }

    /// <summary>
    /// Verification and execution, because "it compiled" is exactly the signal
    /// that failed here. ILVerify rejects the bug's IL
    /// (<c>CallVirtOnValueType</c>); running it proves the handler is actually
    /// driven through a managed pointer rather than a reinterpreted value.
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
                "name=widget count=7!",
                describe.Invoke(instance, new object[] { "widget", 7 }));
        }
        finally
        {
            context.Unload();
        }
    }

    /// <summary>
    /// Returns every call instruction in the named method that targets a
    /// <c>DefaultInterpolatedStringHandler</c> member, plus whether the body
    /// ever loads a local's address (the receiver form a struct's instance call
    /// requires).
    /// </summary>
    /// <param name="assemblyPath">The emitted assembly.</param>
    /// <param name="typeName">The declaring type's simple name.</param>
    /// <param name="methodName">The method to decode.</param>
    /// <returns>The handler-targeting call instructions and the address-load flag.</returns>
    private static (IReadOnlyList<IlInstruction> Calls, bool LoadsAddress) ReadHandlerCallShape(
        string assemblyPath,
        string typeName,
        string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();

        var method = metadata.TypeDefinitions
            .Select(metadata.GetTypeDefinition)
            .Where(type => metadata.GetString(type.Name) == typeName)
            .SelectMany(type => type.GetMethods())
            .Select(metadata.GetMethodDefinition)
            .Single(candidate => metadata.GetString(candidate.Name) == methodName);

        var il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes();
        Assert.NotNull(il);

        var handlerTokens = HandlerMemberTokens(metadata);
        var instructions = IlInstructionReader.Read(il);

        var calls = instructions
            .Where(instruction =>
                (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt)
                && instruction.MetadataToken is { } token
                && handlerTokens.Contains(token))
            .ToList();

        var loadsAddress = instructions.Any(instruction =>
            instruction.OpCode == OpCodes.Ldloca || instruction.OpCode == OpCodes.Ldloca_S);

        return (calls, loadsAddress);
    }

    /// <summary>
    /// The metadata tokens of every member reference (and generic
    /// instantiation of one) whose parent type is the interpolated-string
    /// handler.
    /// </summary>
    /// <param name="metadata">The emitted assembly's metadata.</param>
    /// <returns>The handler member tokens.</returns>
    private static HashSet<int> HandlerMemberTokens(MetadataReader metadata)
    {
        var tokens = new HashSet<int>();

        foreach (var handle in metadata.MemberReferences)
        {
            var member = metadata.GetMemberReference(handle);
            if (member.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }

            var parent = metadata.GetTypeReference((TypeReferenceHandle)member.Parent);
            if (metadata.GetString(parent.Name) == HandlerTypeName)
            {
                tokens.Add(MetadataTokens.GetToken(handle));
            }
        }

        var methodSpecCount = metadata.GetTableRowCount(TableIndex.MethodSpec);
        for (var row = 1; row <= methodSpecCount; row++)
        {
            var handle = MetadataTokens.MethodSpecificationHandle(row);
            var parent = metadata.GetMethodSpecification(handle).Method;
            if (tokens.Contains(MetadataTokens.GetToken(parent)))
            {
                tokens.Add(MetadataTokens.GetToken(handle));
            }
        }

        return tokens;
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
