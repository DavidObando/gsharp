// <copyright file="Issue4789ImportedRecordCopyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.Tests
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import System.Collections.Immutable

/// Issue #4789: imported direct bases must initialize and copy the base subobject.
/// @remarks ADR-0154: the same final test assembly fails against the product with the
/// imported-base resolver exactly reverted (CallCtor/ThisUninitReturn), and
/// passes after restoring it. Explicit IEquatable from the original report
/// is deliberately omitted: equality is unrelated to invoking the copy ctor.
class Issue4789ImportedRecordCopyTests {
    @Fact
    func ImportedGenericRecord_CopyConstructorVerifiesAndPreservesBaseState() {
        using let contract = CSharpFixture(`namespace ImportedEq;
public record Root<T>
{
    public int Tag;
    public Root(int tag) => Tag = tag;
}`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let leafPath = fixture.Compile(`package ImportedEq
import System
public data class Leaf[T any](Extra int32) : Root[T](0)`, "Leaf", executable: false, "/r:" + contract.AssemblyPath)
        IlVerifier.Verify(contract.AssemblyPath)
        IlVerifier.Verify(leafPath, []string{contract.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, leafPath)
        let leaf = (
            assemblies[1].GetType("ImportedEq.Leaf`1") ?? throw InvalidOperationException("Missing leaf.")
        ).MakeGenericType(typeof(string))
        let original = Activator.CreateInstance(leaf, []object{7}) ??
            throw InvalidOperationException("Missing original.")
        let tag = leaf.GetField("Tag") ?? throw InvalidOperationException("Missing base field.")
        tag.SetValue(original, 41)
        let clone = leaf.GetMethod("<Clone>$$") ?? throw InvalidOperationException("Missing clone.")
        let copy object? = clone.Invoke(original, nil)
        Assert.NotNull(copy)
        Assert.NotSame(original, copy)
        Assert.Equal(41, tag.GetValue(copy))
        Assert.Equal(7, leaf.GetProperty("Extra")?.GetValue(copy))
    }

    @Theory
    @InlineData("Root[T]", "Leaf[T any]")
    @InlineData("Reordered[U, T]", "Leaf[T any, U any]")
    func ImportedCopy_UsesDirectOwnerAndCopiesOnceBeforeDerivedState(baseType string, leafType string) {
        using let contract = CSharpFixture(`namespace ImportedCopy;
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
}`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Leaf.ref.dll")
        let leafPath = fixture.Compile((`package ImportedCopy
import System
public data class ` + "$leafType" + `(Extra int32) : ` + "$baseType" + `(0) {
    public override func ReadExtra() int32 -> this.Extra
}`), "Leaf", executable: false, "/assemblyname:Leaf", "/r:" + contract.AssemblyPath, "/refout:" + reference)
        IlVerifier.Verify(contract.AssemblyPath)
        IlVerifier.Verify(leafPath, []string{contract.AssemblyPath})
        let closedLeaf = if baseType.StartsWith("Reordered", StringComparison.Ordinal) {
            "Leaf<string, int>"
        } else {
            "Leaf<string>"
        }
        using let caller = CSharpFixture((`using System;
using ImportedCopy;
public static class Caller
{
    public static string Run()
    {
        var original = new ` + "$closedLeaf" + `(7);
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
}`), []PortableExecutableReference{
                MetadataReference.CreateFromFile(contract.AssemblyPath),
                MetadataReference.CreateFromFile(reference)
            })
        IlVerifier.Verify(caller.AssemblyPath, []string{contract.AssemblyPath, leafPath})
        let assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, leafPath, caller.AssemblyPath)
        var leaf = assemblies[1].GetTypes().Single(
            (type Type) -> type.Name.StartsWith("Leaf`", StringComparison.Ordinal)
        )
        leaf = leaf.MakeGenericType(
            if leaf.GetGenericArguments().Length == 1 {
                []Type{typeof(string)}
            } else {
                []Type{typeof(string), typeof(int32)}
            }
        )
        let copyConstructor = Assert.Single(
            leaf.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic),
            (constructor ConstructorInfo) -> constructor.GetParameters()
                .Length == 1 &&
                constructor
                .GetParameters()[0]
                .ParameterType == leaf
        )
        let body = copyConstructor.GetMethodBody()?.GetILAsByteArray() ??
            throw InvalidOperationException("Missing copy body.")
        Assert.Equal([]uint8{0x02, 0x03, 0x28}, body.Take(3).ToArray())
        let target MethodBase? = copyConstructor.Module.ResolveMethod(
            BitConverter.ToInt32(body, 3),
            leaf.GetGenericArguments(),
            nil
        )
        Assert.Equal(leaf.BaseType, target?.DeclaringType)
        Assert.Equal(
            leaf.BaseType,
            Assert.Single(target?.GetParameters() ?? throw InvalidOperationException("Missing base copy target."))
                .ParameterType
        )
        Assert.Equal(assemblies[0].ManifestModule, target?.Module)
        Assert.True(leaf.GetField("Identity")?.IsInitOnly)
        Assert.Equal(
            "base-state/identity/value/once-only",
            assemblies[2].GetType("Caller")?.GetMethod("Run")?.Invoke(nil, nil)
        )
        if baseType.StartsWith("Reordered", StringComparison.Ordinal) {
            Assert.Equal([]Type{typeof(int32), typeof(string)}, leaf.BaseType?.GetGenericArguments())
            Assert.Equal(1, leaf.BaseType?.GetField("DirectCopies")?.GetValue(nil))
        }
    }

    @Theory
    @InlineData("")
    @InlineData("private NoCopy(NoCopy original) { }")
    @InlineData("private protected NoCopy(NoCopy original) { }")
    @InlineData("internal NoCopy(NoCopy original) { }")
    func ImportedBaseWithoutAccessibleCopy_FailsWithoutAssembly(constructor string) {
        using let contract = CSharpFixture((`namespace ImportedCopy;
public class NoCopy {
    public NoCopy(int tag) { }
    ` + "$constructor" + `
}`))
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Rejected.pdb")
        let (code, output) = fixture.TryCompile(
            "package ImportedCopy\npublic data class Rejected(Value int32) : NoCopy(0)",
            "Rejected",
            executable: false,
            "/r:" + contract.AssemblyPath,
            "/refout:" + reference,
            "/pdb:" + pdb
        )
        Assert.NotEqual(0, code)
        let errors = output
            .Split([]char{'\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
            .Where((line string) -> line.Contains("error GS", StringComparison.Ordinal))
            .ToArray()
        Assert.Single(errors)
        let source = Path.Combine(fixture.Directory, "Rejected.gs")
        Assert.Equal(
            "$source(2,1,2,52): error GS9998: InvalidOperationException: Class 'Rejected' has no accessible copy constructor for imported direct base 'ImportedCopy.NoCopy'.",
            errors[0]
        )
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(reference))
        Assert.False(File.Exists(pdb))
    }

    @Fact
    func SameNamedForeignParameter_IsNotTheDirectBaseCopyContract() {
        using let foreign = CSharpFixture("namespace ImportedEq;\npublic record Root<T> { public Root(int tag) { } }")
        using let contract = CSharpFixture(`extern alias foreign;
namespace ImportedEq;
public record Root<T> {
    public int Tag;
    public Root(int tag) => Tag = tag;
    public Root(foreign::ImportedEq.Root<T> other) => Tag = -1;
}`, []PortableExecutableReference{
                MetadataReference.CreateFromFile(
                    foreign.AssemblyPath,
                    MetadataReferenceProperties(aliases: ImmutableArray.Create("foreign"))
                )
            })
        using let fixture = NativeSliceLanguageTests.Fixture()
        let path = fixture.Compile(
            "package ImportedEq\npublic data class Leaf[T any](Extra int32) : Root[T](0)",
            "Leaf",
            executable: false,
            "/r:" + contract.AssemblyPath,
            "/r:" + foreign.AssemblyPath
        )
        IlVerifier.Verify(path, []string{contract.AssemblyPath, foreign.AssemblyPath})
        let leaf = (
            EmittedFixture.LoadTogether(foreign.AssemblyPath, contract.AssemblyPath, path)[2].GetType(
                "ImportedEq.Leaf`1"
            ) ??
                throw InvalidOperationException("Missing module-identity leaf.")
        ).MakeGenericType(typeof(string))
        let original object? = Activator.CreateInstance(leaf, []object{7})
        let tag = leaf.GetField("Tag") ?? throw InvalidOperationException("Missing selected base field.")
        tag.SetValue(original, 41)
        let copy object? = leaf.GetMethod("<Clone>$$")?.Invoke(original, nil)
        Assert.NotNull(copy)
        Assert.Equal(41, tag.GetValue(copy))
    }

    @Fact
    func FriendVisibleCopyConstructor_UsesExistingVisibilityPolicy() {
        using let contract = CSharpFixture(`[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CopyFriend")]
namespace ImportedCopy;
public class FriendBase {
    public int Tag;
    public FriendBase(int tag) => Tag = tag;
    internal FriendBase(FriendBase original) => Tag = original.Tag;
}`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let path = fixture.Compile(
            "package ImportedCopy\npublic data class Leaf(Extra int32) : FriendBase(0)",
            "Friend",
            executable: false,
            "/assemblyname:CopyFriend",
            "/r:" + contract.AssemblyPath
        )
        IlVerifier.Verify(path, []string{contract.AssemblyPath})
        let leaf = EmittedFixture.LoadTogether(contract.AssemblyPath, path)[1].GetType("ImportedCopy.Leaf") ??
            throw InvalidOperationException("Missing friend leaf.")
        let original object? = Activator.CreateInstance(leaf, []object{7})
        let tag = leaf.GetField("Tag") ?? throw InvalidOperationException("Missing friend base field.")
        tag.SetValue(original, 41)
        let copy object? = leaf.GetMethod("<Clone>$$")?.Invoke(original, nil)
        Assert.NotNull(copy)
        Assert.NotSame(original, copy)
        Assert.Equal(41, tag.GetValue(copy))
    }

    @Theory
    @InlineData("public data class Leaf(Extra int32)", int32(0))
    @InlineData("public data class Leaf(Extra int32) : System.Object", int32(0))
    @InlineData(
        "public open data class Root[T any](Tag int32)\npublic data class Leaf(Extra int32) : Root[string](0)",
        int32(41)
    )
    @InlineData(`public open data class Root[T any](Tag int32)
public open class Middle[T any](State int32) : Root[T](0)
public data class Leaf(Extra int32) : Middle[string](3)`, int32(41))
    func ObjectAndSourceBaseCopies_RemainVerifiable(declaration string, expectedTag int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let path = fixture.Compile("package CopyControl\n" + declaration, "Control", executable: false)
        IlVerifier.Verify(path)
        let leaf = EmittedFixture.Load(path).GetType("CopyControl.Leaf") ??
            throw InvalidOperationException("Missing control leaf.")
        let original = Activator.CreateInstance(leaf, []object{7}) ??
            throw InvalidOperationException("Missing control instance.")
        let tag PropertyInfo? = leaf.GetProperty("Tag")
        if tag != nil {
            tag.SetValue(original, expectedTag)
        }
        let copy object? = leaf.GetMethod("<Clone>$$")?.Invoke(original, nil)
        Assert.NotNull(copy)
        Assert.NotSame(original, copy)
        Assert.Equal(7, leaf.GetProperty("Extra")?.GetValue(copy))
        if tag != nil {
            Assert.Equal(expectedTag, tag.GetValue(copy))
        }
    }
}
