// <copyright file="Issue4807ImportedRecordAdmissionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.Tests
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Compiler.Tests

/// Issue #4807: imported record bases use their actual CLR inheritance eligibility.
/// @remarks ADR-0154: the unchanged final oracle rejects the accepted-main product at
/// ordinary and closed-generic admission (GS0181 and GS0213), while symbolic
/// generic admission and sealed/source-closed rejection remain controls.
/// Restoring the fixed product passes the same constructor/copy runtime oracles.
class Issue4807ImportedRecordAdmissionTests {
    @Theory
    @InlineData("Root", "Leaf", "Leaf")
    @InlineData("Root[string]", "Leaf", "Leaf")
    @InlineData("Root[T]", "Leaf[T any]", "Leaf<string>")
    func NativeNonsealedRecord_AdmitsInheritanceAndPreservesConstructorAndCopyOwner(
        baseType string,
        declaration string,
        closedLeaf string
    ) {
        using let contract = CSharpFixture(`namespace LoudImported;
public record Root(int Tag);
public record Root<T>(int Tag);`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let path = fixture.Compile((`package LoudImported
public data class ` + "$declaration" + `(Extra int32) : ` + "$baseType" + `(0)`), "Leaf", executable: false, "/assemblyname:Leaf", "/r:" +
                contract.AssemblyPath)
        IlVerifier.Verify(contract.AssemblyPath)
        IlVerifier.Verify(path, []string{contract.AssemblyPath})
        using let caller = CSharpFixture((`using System;
using LoudImported;
public static class Caller
{
    public static string Run()
    {
        var original = new ` + "$closedLeaf" + `(7);
        if (original.Tag != 0 || original.Extra != 7)
            throw new Exception("Wrong primary constructor or derived storage.");
        original = original with { Tag = 41 };
        var copy = original with { Extra = 13 };
        if (ReferenceEquals(original, copy) || copy.Tag != 41 || copy.Extra != 13
            || original.Tag != 41 || original.Extra != 7)
            throw new Exception("Copy did not preserve independent base/derived state.");
        return "native-base/primary/copy";
    }
}`), []PortableExecutableReference{
                MetadataReference.CreateFromFile(contract.AssemblyPath),
                MetadataReference.CreateFromFile(path)
            })
        IlVerifier.Verify(caller.AssemblyPath, []string{contract.AssemblyPath, path})
        let assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, path, caller.AssemblyPath)
        var leaf = assemblies[1].GetTypes().Single(
            (type Type) -> type.Name.StartsWith("Leaf", StringComparison.Ordinal)
        )
        if leaf.IsGenericTypeDefinition {
            leaf = leaf.MakeGenericType(typeof(string))
        }
        let expectedBase Type? = if baseType == "Root" {
            assemblies[0].GetType("LoudImported.Root")
        } else {
            assemblies[0].GetType("LoudImported.Root`1")?.MakeGenericType(typeof(string))
        }
        Assert.NotNull(expectedBase)
        Assert.Equal(expectedBase, leaf.BaseType)
        Assert.False(expectedBase!!.IsSealed)
        Assert.Equal(assemblies[0].ManifestModule, leaf.GetProperty("Tag")?.Module)
        Assert.Equal(expectedBase, leaf.GetProperty("Tag")?.DeclaringType)
        let tagStorage FieldInfo? = expectedBase!!.GetField(
            "<Tag>k__BackingField",
            BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(tagStorage)
        Assert.True(tagStorage!!.IsInitOnly)
        Assert.Equal(assemblies[0].ManifestModule, tagStorage!!.Module)
        let copyConstructor = Assert.Single(
            leaf.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic),
            (constructor ConstructorInfo) -> constructor.GetParameters()
                .Length == 1 &&
                constructor
                .GetParameters()[0]
                .ParameterType == leaf
        )
        let body = copyConstructor.GetMethodBody()?.GetILAsByteArray() ??
            throw InvalidOperationException("Missing copy constructor.")
        Assert.Equal([]uint8{0x02, 0x03, 0x28}, body.Take(3).ToArray())
        let target MethodBase? = copyConstructor.Module.ResolveMethod(
            BitConverter.ToInt32(body, 3),
            leaf.GetGenericArguments(),
            nil
        )
        Assert.Equal(expectedBase, target?.DeclaringType)
        Assert.Equal(
            expectedBase,
            Assert.Single(target?.GetParameters() ?? throw InvalidOperationException("Missing direct copy target."))
                .ParameterType
        )
        Assert.Equal(assemblies[0].ManifestModule, target?.Module)
        Assert.Equal("native-base/primary/copy", assemblies[2].GetType("Caller")?.GetMethod("Run")?.Invoke(nil, nil))
    }

    @Theory
    @InlineData("Root", "Leaf")
    @InlineData("Root[string]", "Leaf")
    @InlineData("Root[T]", "Leaf[T any]")
    func NativeSealedRecord_RejectsInheritanceWithoutImage(baseType string, declaration string) {
        using let contract = CSharpFixture(`namespace LoudImported;
public sealed record Root(int Tag);
public sealed record Root<T>(int Tag);`)
        IlVerifier.Verify(contract.AssemblyPath)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile((`package LoudImported
public data class ` + "$declaration" + `(Extra int32) : ` + "$baseType" + `(0)`), "Rejected", executable: false, "/r:" +
                contract.AssemblyPath)
        Assert.NotEqual(0, code)
        Assert.Matches("Rejected\\.gs\\(2,\\d+,2,\\d+\\): error GS(0157|0181):", output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
    }

    @Fact
    func SourceClosedRecord_StillRequiresOpen() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package LoudImported
public data class Root(Tag int32)
public data class Leaf(Extra int32) : Root(0)`, "SourceClosed", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("SourceClosed.gs(3,39,3,43): error GS0181", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "SourceClosed.dll")))
    }
}
