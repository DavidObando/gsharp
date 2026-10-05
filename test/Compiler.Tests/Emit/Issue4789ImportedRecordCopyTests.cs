// <copyright file="Issue4789ImportedRecordCopyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.Tests;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #4789: imported direct bases must initialize and copy the base subobject.</summary>
/// <remarks>
/// ADR-0154: the same final test assembly fails against the product with the
/// imported-base resolver exactly reverted (CallCtor/ThisUninitReturn), and
/// passes after restoring it. Explicit IEquatable from the original report
/// is deliberately omitted: equality is unrelated to invoking the copy ctor.
/// </remarks>
public sealed class Issue4789ImportedRecordCopyTests
{
    [Fact]
    public void ImportedGenericRecord_CopyConstructorVerifiesAndPreservesBaseState()
    {
        using var contract = new CSharpFixture("""
            namespace ImportedEq;
            public record Root<T>
            {
                public int Tag;
                public Root(int tag) => Tag = tag;
            }
            """);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var leafPath = fixture.Compile("""
            package ImportedEq
            import System
            public data class Leaf[T any](Extra int32) : Root[T](0)
            """, "Leaf", executable: false, "/r:" + contract.AssemblyPath);

        IlVerifier.Verify(contract.AssemblyPath);
        IlVerifier.Verify(leafPath, new[] { contract.AssemblyPath });
        var assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, leafPath);
        var leaf = (assemblies[1].GetType("ImportedEq.Leaf`1")
            ?? throw new InvalidOperationException("Missing leaf.")).MakeGenericType(typeof(string));
        var original = Activator.CreateInstance(leaf, new object[] { 7 })
            ?? throw new InvalidOperationException("Missing original.");
        var tag = leaf.GetField("Tag") ?? throw new InvalidOperationException("Missing base field.");
        tag.SetValue(original, 41);
        var clone = leaf.GetMethod("<Clone>$") ?? throw new InvalidOperationException("Missing clone.");
        var copy = clone.Invoke(original, null);
        Assert.NotNull(copy);
        Assert.NotSame(original, copy);
        Assert.Equal(41, tag.GetValue(copy));
        Assert.Equal(7, leaf.GetProperty("Extra")?.GetValue(copy));
    }

    [Theory]
    [InlineData("Root[T]", "Leaf[T any]")]
    [InlineData("Reordered[U, T]", "Leaf[T any, U any]")]
    public void ImportedCopy_UsesDirectOwnerAndCopiesOnceBeforeDerivedState(string baseType, string leafType)
    {
        using var contract = new CSharpFixture("""
            namespace ImportedCopy;
            public record Root<T>
            {
                public static int PrimaryCalls;
                public static int CopyCalls;
                public int Tag;
                public object Payload;
                public T Value = default;
                public readonly object Identity;
                public int Observed;
                public virtual int ReadExtra() => -1;
                public Root(int tag) {
                    PrimaryCalls++;
                    Tag = tag;
                    Payload = new object();
                    Identity = new object();
                }
                protected Root(Root<T> original) {
                    CopyCalls++;
                    Tag = original.Tag;
                    Payload = original.Payload;
                    Value = original.Value;
                    Identity = original.Identity;
                    Observed = ReadExtra();
                }
            }
            public record Reordered<A, B> : Root<B>
            {
                public static int DirectCopies;
                public Reordered(int tag) : base(tag) { }
                protected Reordered(Reordered<A, B> original) : base(original) { DirectCopies++; }
                protected Reordered(Root<B> unrelated) : base(unrelated) { Tag = -1; }
            }
            """);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "Leaf.ref.dll");
        var leafPath = fixture.Compile($$"""
            package ImportedCopy
            import System
            public data class {{leafType}}(Extra int32) : {{baseType}}(0) {
                public override func ReadExtra() int32 -> this.Extra
            }
            """,
            "Leaf", executable: false, "/assemblyname:Leaf", "/r:" + contract.AssemblyPath, "/refout:" + reference);
        IlVerifier.Verify(contract.AssemblyPath);
        IlVerifier.Verify(leafPath, new[] { contract.AssemblyPath });

        var closedLeaf = baseType.StartsWith("Reordered", StringComparison.Ordinal) ? "Leaf<string, int>" : "Leaf<string>";
        using var caller = new CSharpFixture($$"""
            using System;
            using ImportedCopy;
            public static class Caller
            {
                public static string Run()
                {
                    var original = new {{closedLeaf}}(7);
                    original.Tag = 41;
                    original.Value = "owner-vector";
                    var copy = original with { Extra = 13 };
                    if (ReferenceEquals(copy, original) || copy.Tag != 41 || original.Tag != 41
                        || original.Extra != 7 || copy.Extra != 13
                        || !ReferenceEquals(copy.Payload, original.Payload)
                        || !ReferenceEquals(copy.Identity, original.Identity) || copy.Value != "owner-vector"
                        || copy.Observed != 0
                        || Root<string>.CopyCalls != 1 || Root<string>.PrimaryCalls != 1)
                        throw new Exception("Copy lost state, identity, order or once-only execution.");
                    copy.Tag = 99;
                    if (original.Tag != 41) throw new Exception("Copy aliases the base subobject.");
                    return "base-state/identity/value/once-only";
                }
            }
            """, new[]
            {
                Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(contract.AssemblyPath),
                Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(reference),
            });
        IlVerifier.Verify(caller.AssemblyPath, new[] { contract.AssemblyPath, leafPath });
        var assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, leafPath, caller.AssemblyPath);
        var leaf = assemblies[1].GetTypes().Single(type => type.Name.StartsWith("Leaf`", StringComparison.Ordinal));
        leaf = leaf.MakeGenericType(leaf.GetGenericArguments().Length == 1
            ? new[] { typeof(string) } : new[] { typeof(string), typeof(int) });
        var copyConstructor = Assert.Single(leaf.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic),
            constructor => constructor.GetParameters().Length == 1 && constructor.GetParameters()[0].ParameterType == leaf);
        var body = copyConstructor.GetMethodBody()?.GetILAsByteArray()
            ?? throw new InvalidOperationException("Missing copy body.");
        Assert.Equal(new byte[] { 0x02, 0x03, 0x28 }, body.Take(3).ToArray());
        var target = copyConstructor.Module.ResolveMethod(BitConverter.ToInt32(body, 3), leaf.GetGenericArguments(), null);
        Assert.Equal(leaf.BaseType, target?.DeclaringType);
        Assert.Equal(leaf.BaseType, Assert.Single(target?.GetParameters()
            ?? throw new InvalidOperationException("Missing base copy target.")).ParameterType);
        Assert.Equal(assemblies[0].ManifestModule, target?.Module);
        Assert.True(leaf.GetField("Identity")?.IsInitOnly);
        Assert.Equal(
            "base-state/identity/value/once-only",
            assemblies[2].GetType("Caller")?.GetMethod("Run")?.Invoke(null, null));
        if (baseType.StartsWith("Reordered", StringComparison.Ordinal))
        {
            Assert.Equal(new[] { typeof(int), typeof(string) }, leaf.BaseType?.GetGenericArguments());
            Assert.Equal(1, leaf.BaseType?.GetField("DirectCopies")?.GetValue(null));
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("private NoCopy(NoCopy original) { }")]
    [InlineData("private protected NoCopy(NoCopy original) { }")]
    [InlineData("internal NoCopy(NoCopy original) { }")]
    public void ImportedBaseWithoutAccessibleCopy_FailsWithoutAssembly(string constructor)
    {
        using var contract = new CSharpFixture($$"""
            namespace ImportedCopy;
            public class NoCopy {
                public NoCopy(int tag) { }
                {{constructor}}
            }
            """);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "Rejected.ref.dll");
        var (code, output) = fixture.TryCompile("""
            package ImportedCopy
            public data class Rejected(Value int32) : NoCopy(0)
            """, "Rejected", executable: false, "/r:" + contract.AssemblyPath, "/refout:" + reference);
        Assert.NotEqual(0, code);
        Assert.Contains("GS9998", output, StringComparison.Ordinal);
        Assert.True(output.Contains("no accessible copy constructor for imported direct base", StringComparison.Ordinal), output);
        Assert.Contains("Rejected.gs(", output, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")));
        Assert.False(File.Exists(reference));
    }

    [Fact]
    public void SameNamedForeignParameter_IsNotTheDirectBaseCopyContract()
    {
        using var foreign = new CSharpFixture("""
            namespace ImportedEq;
            public record Root<T> { public Root(int tag) { } }
            """);
        using var contract = new CSharpFixture("""
            extern alias foreign;
            namespace ImportedEq;
            public record Root<T> {
                public int Tag;
                public Root(int tag) => Tag = tag;
                public Root(foreign::ImportedEq.Root<T> other) => Tag = -1;
            }
            """, new[]
            {
                Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(
                    foreign.AssemblyPath,
                    new Microsoft.CodeAnalysis.MetadataReferenceProperties(
                        aliases: System.Collections.Immutable.ImmutableArray.Create("foreign"))),
            });
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var path = fixture.Compile("""
            package ImportedEq
            public data class Leaf[T any](Extra int32) : Root[T](0)
            """, "Leaf", executable: false, "/r:" + contract.AssemblyPath, "/r:" + foreign.AssemblyPath);
        IlVerifier.Verify(path, new[] { contract.AssemblyPath, foreign.AssemblyPath });
        var leaf = (EmittedFixture.LoadTogether(foreign.AssemblyPath, contract.AssemblyPath, path)[2]
            .GetType("ImportedEq.Leaf`1") ?? throw new InvalidOperationException("Missing module-identity leaf."))
            .MakeGenericType(typeof(string));
        var original = Activator.CreateInstance(leaf, new object[] { 7 });
        var tag = leaf.GetField("Tag") ?? throw new InvalidOperationException("Missing selected base field.");
        tag.SetValue(original, 41);
        var copy = leaf.GetMethod("<Clone>$")?.Invoke(original, null);
        Assert.NotNull(copy);
        Assert.Equal(41, tag.GetValue(copy));
    }

    [Fact]
    public void FriendVisibleCopyConstructor_UsesExistingVisibilityPolicy()
    {
        using var contract = new CSharpFixture("""
            [assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CopyFriend")]
            namespace ImportedCopy;
            public class FriendBase {
                public int Tag;
                public FriendBase(int tag) => Tag = tag;
                internal FriendBase(FriendBase original) => Tag = original.Tag;
            }
            """);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var path = fixture.Compile("""
            package ImportedCopy
            public data class Leaf(Extra int32) : FriendBase(0)
            """, "Friend", executable: false, "/assemblyname:CopyFriend", "/r:" + contract.AssemblyPath);
        IlVerifier.Verify(path, new[] { contract.AssemblyPath });
        var leaf = EmittedFixture.LoadTogether(contract.AssemblyPath, path)[1].GetType("ImportedCopy.Leaf")
            ?? throw new InvalidOperationException("Missing friend leaf.");
        var original = Activator.CreateInstance(leaf, new object[] { 7 });
        var tag = leaf.GetField("Tag") ?? throw new InvalidOperationException("Missing friend base field.");
        tag.SetValue(original, 41);
        var copy = leaf.GetMethod("<Clone>$")?.Invoke(original, null);
        Assert.NotNull(copy);
        Assert.NotSame(original, copy);
        Assert.Equal(41, tag.GetValue(copy));
    }

    [Theory]
    [InlineData("public data class Leaf(Extra int32)", 0)]
    [InlineData("public data class Leaf(Extra int32) : System.Object", 0)]
    [InlineData("public open data class Root[T any](Tag int32)\npublic data class Leaf(Extra int32) : Root[string](0)", 41)]
    [InlineData("public open data class Root[T any](Tag int32)\npublic open class Middle[T any](State int32) : Root[T](0)\npublic data class Leaf(Extra int32) : Middle[string](3)", 41)]
    public void ObjectAndSourceBaseCopies_RemainVerifiable(string declaration, int expectedTag)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var path = fixture.Compile("package CopyControl\n" + declaration, "Control", executable: false);
        IlVerifier.Verify(path);
        var leaf = EmittedFixture.Load(path).GetType("CopyControl.Leaf")
            ?? throw new InvalidOperationException("Missing control leaf.");
        var original = Activator.CreateInstance(leaf, new object[] { 7 })
            ?? throw new InvalidOperationException("Missing control instance.");
        var tag = leaf.GetProperty("Tag");
        if (tag != null)
        {
            tag.SetValue(original, expectedTag);
        }

        var copy = leaf.GetMethod("<Clone>$")?.Invoke(original, null);
        Assert.NotNull(copy);
        Assert.NotSame(original, copy);
        Assert.Equal(7, leaf.GetProperty("Extra")?.GetValue(copy));
        if (tag != null)
        {
            Assert.Equal(expectedTag, tag.GetValue(copy));
        }
    }
}
