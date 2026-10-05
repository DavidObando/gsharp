// <copyright file="Issue4777ImportedRecordEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Imported direct record equality uses the same base contract as source inheritance.</summary>
public sealed class Issue4777ImportedRecordEqualityTests
{
    private readonly ITestOutputHelper output;

    public Issue4777ImportedRecordEqualityTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Theory]
    [InlineData(false, "inherited")]
    [InlineData(false, "derived")]
    [InlineData(false, "equal")]
    [InlineData(true, "inherited")]
    [InlineData(true, "derived")]
    [InlineData(true, "equal")]
    public void NativeConsumer_ImportedSymbolicBasePreservesBothFieldSets(bool reordered, string difference)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        using var fixture = new NativeSliceLanguageTests.Fixture();
        try
        {
            var root = CompileNative(fixture.Directory, "RootContracts", """
                namespace ImportedEquality;
                public record Root<T> {
                    public int Tag;
                    public T? Value;
                    public Root(int tag) => Tag = tag;
                }
                public record Reordered<A, B> : Root<B> {
                    public A? Owner;
                    public Reordered(int tag) : base(tag) { }
                }
                """);
            var declaration = reordered ? "Leaf[T any, U any]" : "Leaf[T any]";
            var baseType = reordered ? "Reordered[U, T]" : "Root[T]";
            var selfType = reordered ? "Leaf[T, U]" : "Leaf[T]";
            var closedLeaf = reordered ? "Leaf<string, int>" : "Leaf<string>";
            var closedBase = reordered ? "Reordered<int, string>" : "Root<string>";
            var nativeDeclaration = reordered ? "Leaf<T, U>" : "Leaf<T>";
            var nativeBase = reordered ? "Reordered<U, T>" : "Root<T>";
            var reference = Path.Combine(fixture.Directory, "Contracts.ref.dll");
            var library = fixture.Compile($$"""
                package ImportedEquality
                import System
                public data class {{declaration}}(Extra int32) : {{baseType}}(0), IEquatable[{{selfType}}]
                """, "Contracts", executable: false,
                "/assemblyname:Contracts", "/r:" + root, "/refout:" + reference, "/debug:portable");
            var nativeDirectory = Path.Combine(fixture.Directory, "native");
            Directory.CreateDirectory(nativeDirectory);
            var native = CompileNative(nativeDirectory, "Contracts", $$"""
                [assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
                namespace ImportedEquality;
                public sealed record {{nativeDeclaration}}(int Extra) : {{nativeBase}}(0);
                """, root);
            var consumer = CompileNative(fixture.Directory, "Consumer", $$"""
                using System;
                using System.Collections.Generic;
                using ImportedEquality;
                public static class Consumer {
                    public static string Run(string difference) {
                        var first = new {{closedLeaf}}(7) { Tag = 41, Value = "base-value" };
                        var second = new {{closedLeaf}}(difference == "derived" ? 8 : 7) {
                            Tag = difference == "inherited" ? 42 : 41, Value = "base-value"
                        };
                        bool equal = difference == "equal";
                        Root<string> receiver = first;
                        {{closedBase}} direct = first;
                        Func<Root<string>?, bool> baseGroup = receiver.Equals;
                        Func<{{closedBase}}?, bool> directGroup = direct.Equals;
                        Func<{{closedLeaf}}?, bool> selfGroup = first.Equals;
                        Func<object?, bool> objectGroup = first.Equals;
                        bool[] comparisons = {
                            first.Equals(second), ((object)first).Equals(second),
                            receiver.Equals(second), ((IEquatable<Root<string>>)first).Equals(second),
                            ((IEquatable<{{closedLeaf}}>)first).Equals(second),
                            baseGroup(second), selfGroup(second), objectGroup(second),
                            EqualityComparer<Root<string>>.Default.Equals(first, second),
                            first == second, !(first != second),
                            direct.Equals(second), ((IEquatable<{{closedBase}}>)first).Equals(second),
                            directGroup(second)
                        };
                        for (int i = 0; i < comparisons.Length; i++)
                            if (comparisons[i] != equal) throw new Exception(difference + ":path" + i);
                        if (first.Equals(({{closedLeaf}}?)null) || receiver.Equals(null)
                            || baseGroup(null) || directGroup(null) || selfGroup(null) || objectGroup(null)
                            || first == null || null == first || !(first != null))
                            throw new Exception("null control");
                        {{closedLeaf}}? absent = null;
                        if (!(absent == null) || absent != null) throw new Exception("null operator control");
                        if (first.Tag != 41 || first.Extra != 7 || first.Value != "base-value")
                            throw new Exception("field control");
                        return difference + ":14-dispatch/null/field-controls";
                    }
                }
                """, root, reference);
            foreach (var image in new[] { root, native, library })
            {
                IlVerifier.Verify(image, new[] { root });
            }

            IlVerifier.Verify(consumer, new[] { root, native });
            IlVerifier.Verify(consumer, new[] { root, library });
            var expected = difference + ":14-dispatch/null/field-controls";
            Assert.Equal(expected, RunConsumer(root, native, consumer, difference));
            Assert.Equal(expected, RunConsumer(root, library, consumer, difference));
            this.output.WriteLine("SAME native consumer SHA256=" + Hash(consumer));
            this.output.WriteLine("gsc image SHA256=" + Hash(library));
            if (difference == "equal")
            {
                return;
            }

            var assemblies = EmittedFixture.LoadTogether(root, library);
            var leaf = assemblies[1].GetTypes().Single(type => type.Name.StartsWith("Leaf`", StringComparison.Ordinal));
            leaf = leaf.MakeGenericType(reordered ? new[] { typeof(string), typeof(int) } : new[] { typeof(string) });
            var directBase = leaf.BaseType ?? throw new InvalidOperationException("Missing direct base.");
            var slot = leaf.GetMethod("Equals", BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly,
                null, new[] { directBase }, null) ?? throw new InvalidOperationException("Missing imported typed-base override.");
            Assert.True(slot.IsVirtual && slot.IsFinal);
            Assert.Equal(0, (int)(slot.Attributes & MethodAttributes.NewSlot));
            Assert.Equal(directBase, slot.GetBaseDefinition().DeclaringType);
            var parameter = Assert.Single(slot.GetParameters());
            Assert.Equal("other", parameter.Name);
            Assert.Equal(NullabilityState.Nullable, new NullabilityInfoContext().Create(parameter).ReadState);
            if (reordered)
            {
                Assert.Equal(new[] { typeof(int), typeof(string) }, directBase.GetGenericArguments());
            }

            var selfEquals = leaf.GetMethod("Equals", new[] { leaf })
                ?? throw new InvalidOperationException("Missing self equality.");
            var instructions = IlInstructionReader.Read(selfEquals.GetMethodBody()?.GetILAsByteArray()
                ?? throw new InvalidOperationException("Missing self equality body."));
            var baseCall = Assert.Single(instructions, instruction =>
                instruction.MetadataToken is int token
                && selfEquals.Module.ResolveMethod(token, leaf.GetGenericArguments(), null) is { } target
                && target.Name == "Equals" && target.DeclaringType == directBase);
            Assert.Equal(OpCodes.Call, baseCall.OpCode);
            Assert.Equal(EqualityRows(library), EqualityRows(reference));
        }
        finally
        {
            PreserveEvidence(fixture.Directory, (reordered ? "reordered-" : "generic-") + difference);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SourceOnlyBase_OrdinaryAndGenericDispatchRemainStructural(bool generic)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        using var fixture = new NativeSliceLanguageTests.Fixture();
        try
        {
            var root = generic ? "Root[T any]" : "Root";
            var leaf = generic ? "Leaf[T any]" : "Leaf";
            var baseType = generic ? "Root[T]" : "Root";
            var closed = generic ? "Leaf[string]" : "Leaf";
            var library = fixture.Compile($$"""
                package SourceEquality
                import System
                public open data class {{root}}(Tag int32)
                public data class {{leaf}}(Tag int32, Extra int32) : {{baseType}}(Tag)
                public func Check() bool {
                    let first = {{closed}}(41, 7)
                    let same = {{closed}}(41, 7)
                    let inherited = {{closed}}(42, 7)
                    let derived = {{closed}}(41, 8)
                    let receiver {{(generic ? "Root[string]" : "Root")}} = first
                    let equals Func[{{(generic ? "Root[string]" : "Root")}}?, bool] = receiver.Equals
                    return first.Equals(same) && !first.Equals(inherited) && !first.Equals(derived)
                        && receiver.Equals(same) && !receiver.Equals(inherited) && !receiver.Equals(derived)
                        && equals(same) && !equals(inherited) && !equals(derived) && !equals(nil)
                        && first == same && first != inherited && first != derived
                }
                """, "SourceControls", executable: false);
            IlVerifier.Verify(library);
            var check = EmittedFixture.Load(library).GetTypes()
                .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static))
                .Single(method => method.Name == "Check");
            Assert.Equal(true, check.Invoke(null, null));
        }
        finally
        {
            PreserveEvidence(fixture.Directory, generic ? "source-generic" : "source-ordinary");
        }
    }

    private static string CompileNative(string directory, string name, string source, params string[] references)
    {
        var sourcePath = Path.Combine(directory, name + ".cs");
        var imagePath = Path.Combine(directory, name + ".dll");
        File.WriteAllText(sourcePath, source, Encoding.UTF8);
        var compilation = CSharpCompilation.Create(name,
            new[] { CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8, SourceHashAlgorithm.Sha256), path: sourcePath) },
            ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => MetadataReference.CreateFromFile(path))
                .Concat(references.Select(path => MetadataReference.CreateFromFile(path))),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable, deterministic: true));
        using var image = File.Create(imagePath);
        using var pdb = File.Create(Path.ChangeExtension(imagePath, ".pdb"));
        var result = compilation.Emit(image, pdb,
            options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        Assert.True(pdb.Length > 0);
        return imagePath;
    }

    private static object RunConsumer(string root, string library, string consumer, string difference)
    {
        var assemblies = EmittedFixture.LoadTogether(root, library, consumer);
        return (assemblies[2].GetType("Consumer")?.GetMethod("Run")
            ?? throw new InvalidOperationException("Missing native consumer.")).Invoke(null, new object[] { difference });
    }

    private static string[] EqualityRows(string path)
    {
        using var stream = File.OpenRead(path);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var rows = metadata.TypeDefinitions.SelectMany(handle => metadata.GetTypeDefinition(handle).GetMethods())
            .Select(handle => metadata.GetMethodDefinition(handle))
            .Where(method => metadata.GetString(method.Name) == "Equals")
            .Select(method => method.Attributes + "|" + Convert.ToHexString(metadata.GetBlobBytes(method.Signature))
                + "|" + string.Join(";", method.GetParameters().Select(handle =>
                {
                    var parameter = metadata.GetParameter(handle);
                    return metadata.GetString(parameter.Name) + ":"
                        + string.Join(",", parameter.GetCustomAttributes().Select(attribute =>
                            Convert.ToHexString(metadata.GetBlobBytes(metadata.GetCustomAttribute(attribute).Value))));
                }))).ToArray();
        Assert.Equal(3, rows.Length);
        var implementations = metadata.TypeDefinitions
            .SelectMany(handle => metadata.GetTypeDefinition(handle).GetMethodImplementations())
            .Select(handle => metadata.GetMethodImplementation(handle))
            .Where(implementation => implementation.MethodDeclaration.Kind == HandleKind.MemberReference)
            .Select(implementation => metadata.GetMemberReference((MemberReferenceHandle)implementation.MethodDeclaration))
            .Where(member => metadata.GetString(member.Name) == "Equals").ToArray();
        Assert.NotEmpty(implementations);
        Assert.Contains(implementations, member => member.Parent.Kind == HandleKind.TypeSpecification);
        return rows;
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    private static void PreserveEvidence(string directory, string name)
    {
        var root = Environment.GetEnvironmentVariable("GSHARP_4778_EVIDENCE_ROOT");
        if (string.IsNullOrEmpty(root))
        {
            return;
        }

        var destination = Path.Combine(root, name);
        foreach (var path in Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(directory, path));
            Directory.CreateDirectory(Path.GetDirectoryName(target) ?? throw new InvalidOperationException("Missing evidence directory."));
            File.Copy(path, target, overwrite: true);
        }
    }
}
