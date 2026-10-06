// <copyright file="Issue4807ImportedRecordAdmissionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.Tests;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #4807: imported record bases use their actual CLR inheritance eligibility.</summary>
/// <remarks>
/// ADR-0154: the unchanged final oracle rejects the accepted-main product at
/// ordinary and closed-generic admission (GS0181 and GS0213), while symbolic
/// generic admission and sealed/source-closed rejection remain controls.
/// Restoring the fixed product passes the same constructor/copy runtime oracles.
/// </remarks>
public sealed class Issue4807ImportedRecordAdmissionTests
{
    [Theory]
    [InlineData("Root", "Leaf", "Leaf")]
    [InlineData("Root[string]", "Leaf", "Leaf")]
    [InlineData("Root[T]", "Leaf[T any]", "Leaf<string>")]
    public void NativeNonsealedRecord_AdmitsInheritanceAndPreservesConstructorAndCopyOwner(
        string baseType, string declaration, string closedLeaf)
    {
        using var contract = new CSharpFixture("""
            namespace LoudImported;
            public record Root(int Tag);
            public record Root<T>(int Tag);
            """);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var path = fixture.Compile($$"""
            package LoudImported
            public data class {{declaration}}(Extra int32) : {{baseType}}(0)
            """, "Leaf", executable: false, "/assemblyname:Leaf", "/r:" + contract.AssemblyPath);
        IlVerifier.Verify(contract.AssemblyPath);
        IlVerifier.Verify(path, new[] { contract.AssemblyPath });

        using var caller = new CSharpFixture($$"""
            using System;
            using LoudImported;
            public static class Caller
            {
                public static string Run()
                {
                    var original = new {{closedLeaf}}(7);
                    if (original.Tag != 0 || original.Extra != 7)
                        throw new Exception("Wrong primary constructor or derived storage.");
                    original = original with { Tag = 41 };
                    var copy = original with { Extra = 13 };
                    if (ReferenceEquals(original, copy) || copy.Tag != 41 || copy.Extra != 13
                        || original.Tag != 41 || original.Extra != 7)
                        throw new Exception("Copy did not preserve independent base/derived state.");
                    return "native-base/primary/copy";
                }
            }
            """, new[]
            {
                MetadataReference.CreateFromFile(contract.AssemblyPath),
                MetadataReference.CreateFromFile(path),
            });
        IlVerifier.Verify(caller.AssemblyPath, new[] { contract.AssemblyPath, path });
        var assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, path, caller.AssemblyPath);
        var leaf = assemblies[1].GetTypes().Single(type => type.Name.StartsWith("Leaf", StringComparison.Ordinal));
        if (leaf.IsGenericTypeDefinition)
        {
            leaf = leaf.MakeGenericType(typeof(string));
        }

        var expectedBase = baseType == "Root"
            ? assemblies[0].GetType("LoudImported.Root")
            : assemblies[0].GetType("LoudImported.Root`1")?.MakeGenericType(typeof(string));
        Assert.NotNull(expectedBase);
        Assert.Equal(expectedBase, leaf.BaseType);
        Assert.False(expectedBase.IsSealed);
        Assert.Equal(assemblies[0].ManifestModule, leaf.GetProperty("Tag")?.Module);
        Assert.Equal(expectedBase, leaf.GetProperty("Tag")?.DeclaringType);
        var tagStorage = expectedBase.GetField("<Tag>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(tagStorage);
        Assert.True(tagStorage.IsInitOnly);
        Assert.Equal(assemblies[0].ManifestModule, tagStorage.Module);
        var copyConstructor = Assert.Single(leaf.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic),
            constructor => constructor.GetParameters().Length == 1 && constructor.GetParameters()[0].ParameterType == leaf);
        var body = copyConstructor.GetMethodBody()?.GetILAsByteArray()
            ?? throw new InvalidOperationException("Missing copy constructor.");
        Assert.Equal(new byte[] { 0x02, 0x03, 0x28 }, body.Take(3).ToArray());
        var target = copyConstructor.Module.ResolveMethod(BitConverter.ToInt32(body, 3), leaf.GetGenericArguments(), null);
        Assert.Equal(expectedBase, target?.DeclaringType);
        Assert.Equal(expectedBase, Assert.Single(target?.GetParameters()
            ?? throw new InvalidOperationException("Missing direct copy target.")).ParameterType);
        Assert.Equal(assemblies[0].ManifestModule, target?.Module);
        Assert.Equal("native-base/primary/copy", assemblies[2].GetType("Caller")?.GetMethod("Run")?.Invoke(null, null));
    }

    [Theory]
    [InlineData("Root", "Leaf")]
    [InlineData("Root[string]", "Leaf")]
    [InlineData("Root[T]", "Leaf[T any]")]
    public void NativeSealedRecord_RejectsInheritanceWithoutImage(string baseType, string declaration)
    {
        using var contract = new CSharpFixture("""
            namespace LoudImported;
            public sealed record Root(int Tag);
            public sealed record Root<T>(int Tag);
            """);
        IlVerifier.Verify(contract.AssemblyPath);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile($$"""
            package LoudImported
            public data class {{declaration}}(Extra int32) : {{baseType}}(0)
            """, "Rejected", executable: false, "/r:" + contract.AssemblyPath);
        Assert.NotEqual(0, code);
        Assert.Matches(@"Rejected\.gs\(2,\d+,2,\d+\): error GS(0157|0181):", output);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")));
    }

    [Fact]
    public void SourceClosedRecord_StillRequiresOpen()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile("""
            package LoudImported
            public data class Root(Tag int32)
            public data class Leaf(Extra int32) : Root(0)
            """, "SourceClosed", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("SourceClosed.gs(3,39,3,43): error GS0181", output, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "SourceClosed.dll")));
    }
}
