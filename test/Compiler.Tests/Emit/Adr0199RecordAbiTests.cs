// <copyright file="Adr0199RecordAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0199: a <c>data class</c> / <c>data struct</c> synthesizes the C#
/// record ABI. Every test compares against a C# <c>record</c> compiled with
/// Roslyn (metadata shape and <c>ToString</c> text), or asserts a behavior the
/// previous Kotlin-format / no-<c>PrintMembers</c> / no-<c>IEquatable</c>
/// emission cannot satisfy (ADR-0154: they go red on the pre-change commit).
/// </summary>
public class Adr0199RecordAbiTests
{
    private const string CSharpWitness = """
        #nullable enable
        public sealed record SealedRoot(int X, string? Y);
        public record OpenRoot(int X);
        public record OpenDerived(int Z) : OpenRoot(1);
        public sealed record SealedDerived(int W) : OpenRoot(1);
        public record struct RS(int X, int Y);
        public sealed record EmptyC();
        public record struct EmptyS();
        public sealed record Gen<T>(T Value);
        public sealed record Order { public int Late; public int Early { get; init; } public int Mid; private int hidden; public int Shown = 4; public int Hidden2() => hidden; }
        public sealed record Prices(double Amount, double? Missing, string? Label);
        """;

    private const string GSharpWitness = """
        package W
        import System

        data class SealedRoot(X int32, Y string?)
        open data class OpenRoot(X int32)
        open data class OpenDerived(Z int32) : OpenRoot(1)
        data class SealedDerived(W int32) : OpenRoot(1)
        data struct RS(X int32, Y int32)
        data class EmptyC()
        data struct EmptyS()
        data class Gen[T](Value T)
        data class Order {
            var Late int32
            prop Early int32
            var Mid int32
            private var hidden int32
            var Shown int32 = 4
        }
        data class Prices(Amount float64, Missing float64?, Label string?)
        """;

    private static readonly Lazy<Assembly> Roslyn = new(() => Adr0199RecordAbiWitness.CompileCSharp(CSharpWitness));
    private static readonly Lazy<Assembly> GSharp = new(() => Adr0199RecordAbiWitness.CompileGSharp(GSharpWitness));

    public static TheoryData<string> AbiShapes() => new()
    {
        "SealedRoot",
        "OpenRoot",
        "OpenDerived",
        "SealedDerived",
        "RS",
        "EmptyC",
        "EmptyS",
        "Gen`1",
    };

    [Theory]
    [MemberData(nameof(AbiShapes))]
    public void DataType_SynthesizesTheRoslynRecordMemberTable(string name)
    {
        var expected = Adr0199RecordAbiWitness.Describe(Roslyn.Value.GetTypes().Single(t => t.Name == name));
        var actual = Adr0199RecordAbiWitness.Describe(GSharp.Value.GetTypes().Single(t => t.Name == name));
        Assert.Equal(expected, actual);
        Assert.Contains("PrintMembers(StringBuilder builder)", actual, StringComparison.Ordinal);
        Assert.Contains("interface IEquatable<", actual, StringComparison.Ordinal);
    }

    [Fact]
    public void PrintMembers_ShapeFollowsTheFourClassCases()
    {
        MethodInfo Slot(string name) => GSharp.Value.GetTypes().Single(t => t.Name == name)
            .GetMethod("PrintMembers", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)!;

        var sealedRoot = Slot("SealedRoot");
        Assert.True(sealedRoot.IsPrivate);
        Assert.False(sealedRoot.IsVirtual);
        var openRoot = Slot("OpenRoot");
        Assert.True(openRoot.IsFamily && openRoot.IsVirtual && (openRoot.Attributes & MethodAttributes.NewSlot) != 0);
        var openDerived = Slot("OpenDerived");
        Assert.True(openDerived.IsFamily && openDerived.IsVirtual && (openDerived.Attributes & MethodAttributes.NewSlot) == 0 && !openDerived.IsFinal);
        var sealedDerived = Slot("SealedDerived");
        Assert.True(sealedDerived.IsFamily && sealedDerived.IsVirtual && (sealedDerived.Attributes & MethodAttributes.NewSlot) == 0 && !sealedDerived.IsFinal);
        var structSlot = Slot("RS");
        Assert.True(structSlot.IsPrivate && !structSlot.IsVirtual);
    }

    [Theory]
    [InlineData("SealedRoot", new object[] { 1, null })]
    [InlineData("OpenDerived", new object[] { 2 })]
    [InlineData("SealedDerived", new object[] { 5 })]
    [InlineData("RS", new object[] { 3, 4 })]
    [InlineData("EmptyC", new object[] { })]
    [InlineData("EmptyS", new object[] { })]
    [InlineData("Order", new object[] { })]
    [InlineData("Prices", new object[] { 1.5, null, null })]
    public void ToString_MatchesRoslynRecordFormat_UnderTheCurrentCulture(string name, object[] arguments)
    {
        Roslyn.Value.GetTypes().Single(t => t.Name == name);
        string Render(Assembly assembly)
        {
            var type = assembly.GetTypes().Single(t => t.Name == name);
            var instance = type.IsValueType && arguments.Length == 0
                ? Activator.CreateInstance(type)!
                : Activator.CreateInstance(type, arguments)!;
            return instance.ToString()!;
        }

        var previous = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = new CultureInfo("de-DE");
        try
        {
            var expected = Render(Roslyn.Value);
            var actual = Render(GSharp.Value);
            Assert.Equal(expected, actual);
            Assert.Contains(" { ", actual, StringComparison.Ordinal);
        }
        finally
        {
            CultureInfo.CurrentCulture = previous;
        }
    }

    [Fact]
    public void ToString_UsesTheCurrentCulture_NotTheInvariantCulture()
    {
        var type = GSharp.Value.GetTypes().Single(t => t.Name == "Prices");
        var instance = Activator.CreateInstance(type, 1.5, null, null)!;
        var previous = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("de-DE");
            Assert.Equal("Prices { Amount = 1,5, Missing = , Label =  }", instance.ToString());
            CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
            Assert.Equal("Prices { Amount = 1.5, Missing = , Label =  }", instance.ToString());
        }
        finally
        {
            CultureInfo.CurrentCulture = previous;
        }
    }

    [Fact]
    public void ToString_PrintsPublicMembersInDeclarationOrder_AndSkipsPrivateOnes()
    {
        var order = GSharp.Value.GetTypes().Single(t => t.Name == "Order");
        Assert.Equal("Order { Late = 0, Early = 0, Mid = 0, Shown = 4 }", Activator.CreateInstance(order)!.ToString());
    }

    [Fact]
    public void ToString_OfDerivedType_IncludesInheritedMembersFromBasePrintMembers()
    {
        var derived = GSharp.Value.GetTypes().Single(t => t.Name == "SealedDerived");
        Assert.Equal("SealedDerived { X = 1, W = 7 }", Activator.CreateInstance(derived, 7)!.ToString());
    }

    [Fact]
    public void ToString_OfGenericType_PrintsTheSimpleName()
    {
        var generic = GSharp.Value.GetTypes().Single(t => t.Name == "Gen`1").MakeGenericType(typeof(string));
        Assert.Equal("Gen { Value = a }", Activator.CreateInstance(generic, "a")!.ToString());
        var empty = Activator.CreateInstance(generic, new object[] { null })!;
        Assert.Equal("Gen { Value =  }", empty.ToString());
    }

    [Fact]
    public void DataTypes_ImplementIEquatableOfSelf_ThroughTheTypedEqualsSlot()
    {
        foreach (var type in GSharp.Value.GetTypes().Where(t => t.Name is "SealedRoot" or "OpenRoot" or "RS" or "EmptyS"))
        {
            var equatable = typeof(IEquatable<>).MakeGenericType(type);
            Assert.True(equatable.IsAssignableFrom(type), type.Name);
            var map = type.GetInterfaceMap(equatable);
            Assert.Equal("Equals", map.TargetMethods[0].Name);
            Assert.Equal(type, map.TargetMethods[0].GetParameters()[0].ParameterType);
        }
    }

    [Fact]
    public void DeclaredSelfEquatable_IsNotRepeated_AndAnonymousLiteralsStillImplementIt()
    {
        const string source = """
            package W
            import System

            data class Declared(X int32) : IEquatable[Declared]
            data struct DeclaredStruct(X int32) : IEquatable[DeclaredStruct]
            data class Plain(X int32)
            func Build() string {
                let anonymous = data object { let Name = "n" }
                let plainAnonymous = object { let Name = "n" }
                return anonymous.ToString() + plainAnonymous.ToString()
            }
            """;
        var directory = Directory.CreateTempSubdirectory("gs_adr0199_eq_").FullName;
        try
        {
            var path = Adr0199RecordAbiWitness.CompileGSharpToPath(source, directory);
            using var stream = File.OpenRead(path);
            using var pe = new PEReader(stream);
            var reader = pe.GetMetadataReader();
            var checkedTypes = 0;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var type = reader.GetTypeDefinition(typeHandle);
                var name = reader.GetString(type.Name);
                if (name is "Declared" or "DeclaredStruct" or "Plain" || name.StartsWith("<>AnonymousType", StringComparison.Ordinal))
                {
                    // Each of these lists exactly one interface: IEquatable<Self>, once.
                    Assert.True(
                        type.GetInterfaceImplementations().Count == 1,
                        $"{name} has {type.GetInterfaceImplementations().Count} InterfaceImpl rows.");
                    checkedTypes++;
                }
            }

            Assert.Equal(5, checkedTypes);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void AnonymousLiterals_AdoptTheCSharpAnonymousTypeFormat_WithoutRecordMembers()
    {
        const string shapes = """
            package W
            func Build() string {
                let record = data object { let Name = "David"; let Count = 2 }
                let plain = object { let Name = "David"; let Count = 2 }
                return record.ToString() + plain.ToString()
            }
            """;
        var assembly = Adr0199RecordAbiWitness.CompileGSharp(shapes);
        Assert.Equal(
            "{ Name = David, Count = 2 }{ Name = David, Count = 2 }",
            Adr0199RecordAbiWitness.Invoke(assembly, "Build"));
        var anonymous = assembly.GetTypes().Where(t => t.Name.StartsWith("<>AnonymousType", StringComparison.Ordinal)).ToArray();
        Assert.Equal(2, anonymous.Length);
        var all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        foreach (var type in anonymous)
        {
            Assert.DoesNotContain(type.GetMethods(all), m => m.Name is "PrintMembers" or "<Clone>$");
            Assert.DoesNotContain(type.GetConstructors(all), c => c.GetParameters() is [{ ParameterType: var p }] && p == type);
        }
    }

    [Fact]
    public void HandWrittenPrintMembers_ReplacesTheSynthesizedSlot_AndDerivedTypesCallIt()
    {
        const string source = """
            package W
            import System
            import System.Text

            open data class Base(Id int32) {
                protected open func PrintMembers(builder StringBuilder) bool {
                    builder.Append("custom")
                    return true
                }
            }
            data class Derived(Other int32) : Base(1)
            """;
        var assembly = Adr0199RecordAbiWitness.CompileGSharp(source);
        var all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        var baseType = assembly.GetTypes().Single(t => t.Name == "Base");
        var slot = Assert.Single(baseType.GetMethods(all), m => m.Name == "PrintMembers");
        Assert.True(slot.IsFamily && slot.IsVirtual && (slot.Attributes & MethodAttributes.NewSlot) != 0 && !slot.IsFinal);
        Assert.Equal("Base { custom }", Activator.CreateInstance(baseType, 9)!.ToString());
        var derived = assembly.GetTypes().Single(t => t.Name == "Derived");
        Assert.Equal("Derived { custom, Other = 3 }", Activator.CreateInstance(derived, 3)!.ToString());
    }

    [Fact]
    public void HandWrittenPrintMembersOverride_CanCallTheCompilerOwnedBaseSlot()
    {
        const string source = """
            package W
            import System
            import System.Text

            open data class Base(Id int32)
            data class Derived(Other int32) : Base(7) {
                protected override func PrintMembers(builder StringBuilder) bool {
                    builder.Append("<")
                    base.PrintMembers(builder)
                    builder.Append(">")
                    return true
                }
            }
            """;
        var assembly = Adr0199RecordAbiWitness.CompileGSharp(source);
        var all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        var derived = assembly.GetTypes().Single(t => t.Name == "Derived");
        var slot = Assert.Single(derived.GetMethods(all), m => m.Name == "PrintMembers");
        Assert.True(slot.IsFamily && slot.IsVirtual && (slot.Attributes & MethodAttributes.NewSlot) == 0 && !slot.IsFinal);
        Assert.Equal("Derived { <Id = 7> }", Activator.CreateInstance(derived, 1).ToString());
    }

    [Fact]
    public void GenericBase_ContributesItsMembersThroughTheConstructedBaseSlot()
    {
        const string source = """
            package W
            open data class GenericBase[T](BaseValue T)
            data class GenericChild(Own int32) : GenericBase[int32](1)
            """;
        var assembly = Adr0199RecordAbiWitness.CompileGSharp(source);
        var child = assembly.GetTypes().Single(t => t.Name == "GenericChild");
        Assert.Equal("GenericChild { BaseValue = 1, Own = 5 }", Activator.CreateInstance(child, 5).ToString());
    }

    [Fact]
    public void AbstractDataClass_SynthesizesAProtectedVirtualPrintMembersWithABody()
    {
        const string source = """
            package W
            import System.Text

            abstract data class Shape(Id int32)
            data class Circle(R int32) : Shape(1)
            abstract data class Custom(Id int32) {
                protected open func PrintMembers(builder StringBuilder) bool -> false
            }
            """;
        var directory = Directory.CreateTempSubdirectory("gs_adr0199_abstract_").FullName;
        try
        {
            var path = Adr0199RecordAbiWitness.CompileGSharpToPath(source, directory);
            using var stream = File.OpenRead(path);
            using var pe = new PEReader(stream);
            var reader = pe.GetMetadataReader();
            var shape = reader.TypeDefinitions.Select(reader.GetTypeDefinition).Single(t => reader.GetString(t.Name) == "Shape");
            var printMembers = shape.GetMethods().Select(reader.GetMethodDefinition).Single(m => reader.GetString(m.Name) == "PrintMembers");
            Assert.True((printMembers.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Family);
            Assert.True((printMembers.Attributes & MethodAttributes.Virtual) != 0);
            Assert.True((printMembers.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.True((printMembers.Attributes & MethodAttributes.Abstract) == 0);
            Assert.NotEqual(0, printMembers.RelativeVirtualAddress);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }

        var assembly = Adr0199RecordAbiWitness.CompileGSharp(source);
        var circle = assembly.GetTypes().Single(t => t.Name == "Circle");
        Assert.Equal("Circle { Id = 1, R = 2 }", Activator.CreateInstance(circle, 2).ToString());
    }

    [Fact]
    public void IntermediaryClassOverride_IsWhatADerivedDataClassCallsAsBase()
    {
        const string source = """
            package W
            import System
            import System.Text

            open data class Base(Id int32)
            open class Middle : Base(1) {
                protected open override func PrintMembers(builder StringBuilder) bool {
                    builder.Append("middle")
                    return true
                }
            }
            data class Leaf(Z int32) : Middle
            """;
        var assembly = Adr0199RecordAbiWitness.CompileGSharp(source);
        var leaf = assembly.GetTypes().Single(t => t.Name == "Leaf");
        Assert.Equal("Leaf { middle, Z = 3 }", Activator.CreateInstance(leaf, 3).ToString());
    }

    [Fact]
    public void SealedIntermediaryOverride_CannotBeOverriddenBySynthesis()
    {
        const string source = """
            package W
            import System
            import System.Text

            open data class Base(Id int32)
            open class Middle : Base(1) {
                protected override func PrintMembers(builder StringBuilder) bool -> true
            }
            data class Leaf(Z int32) : Middle
            """;
        var (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0184", output, StringComparison.Ordinal);
    }

    [Fact]
    public void SharedPrintMembers_OfTheSlotShape_IsRejectedWithGS0623()
    {
        const string source = """
            package W
            import System.Text

            data class Item(Id int32) {
                shared {
                    func PrintMembers(builder StringBuilder) bool -> true
                }
            }
            """;
        var (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0623", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadonlyValueTypeField_IsCopiedBeforeAMutatingToStringRuns()
    {
        const string csharp = """
            public struct Counter { public int Count; public override string ToString() => (++Count).ToString(); }
            public sealed record Item { public readonly Counter Value; public Counter Open; }
            """;
        const string gsharp = """
            package W
            import System

            struct Counter {
                var Count int32
                override func ToString() string {
                    this.Count = this.Count + 1
                    return this.Count.ToString()
                }
            }
            data class Item {
                let Value Counter
                var Open Counter
            }
            """;
        string Twice(Assembly assembly)
        {
            var item = Activator.CreateInstance(assembly.GetTypes().Single(t => t.Name == "Item"));
            return item.ToString() + "|" + item.ToString();
        }

        var expected = Twice(Adr0199RecordAbiWitness.CompileCSharp(csharp));
        Assert.Equal("Item { Value = 1, Open = 1 }|Item { Value = 1, Open = 2 }", expected);
        Assert.Equal(expected, Twice(Adr0199RecordAbiWitness.CompileGSharp(gsharp)));
    }

    [Fact]
    public void PartialDataClass_PrintsMembersInMergedFileOrder()
    {
        var padding = string.Concat(Enumerable.Repeat("// padding so this member sits later in its file\n", 20));
        var assembly = Adr0199RecordAbiWitness.CompileGSharpFiles(
            ("a.gs", "package W\n" + padding + "partial data class P {\n    var FromA int32\n}\n"),
            ("b.gs", "package W\npartial data class P {\n    var FromB int32\n}\n"));
        var type = assembly.GetTypes().Single(t => t.Name == "P");
        Assert.Equal("P { FromA = 0, FromB = 0 }", Activator.CreateInstance(type).ToString());
    }

    [Fact]
    public void IntermediaryWithAnUnrelatedPrintMembersShape_IsNotTheInheritedSlot()
    {
        const string source = """
            package W
            import System
            import System.Text

            open data class Base(Id int32)
            open class Middle : Base(1) {
                protected open func PrintMembers(builder StringBuilder) int32 -> 5
            }
            data class Leaf(Z int32) : Middle
            """;
        var assembly = Adr0199RecordAbiWitness.CompileGSharp(source);
        var leaf = assembly.GetTypes().Single(t => t.Name == "Leaf");
        Assert.Equal("Leaf { Id = 1, Z = 3 }", Activator.CreateInstance(leaf, 3).ToString());
    }

    [Fact]
    public void HandWrittenPrintMembers_OfTheWrongShape_IsRejectedWithGS0623()
    {
        const string source = """
            package W
            import System.Text

            data class Item(Id int32) {
                func PrintMembers(builder StringBuilder) bool -> true
            }
            """;
        var (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0623", output, StringComparison.Ordinal);
    }
}
