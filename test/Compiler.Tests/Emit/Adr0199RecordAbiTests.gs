// <copyright file="Adr0199RecordAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Tests
import System
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// ADR-0199: a `data class` / `data struct` synthesizes the C#
/// record ABI. Every test compares against a C# `record` compiled with
/// Roslyn (metadata shape and `ToString` text), or asserts a behavior the
/// previous Kotlin-format / no-`PrintMembers` / no-`IEquatable`
/// emission cannot satisfy (ADR-0154: they go red on the pre-change commit).
open class Adr0199RecordAbiTests {
    @Theory
    @MemberData("AbiShapes")
    func DataType_SynthesizesTheRoslynRecordMemberTable(name string) {
        let expected = Adr0199RecordAbiWitness.Describe(Roslyn.Value.GetTypes().Single((t Type) -> t.Name == name))
        let actual = Adr0199RecordAbiWitness.Describe(GSharp.Value.GetTypes().Single((t Type) -> t.Name == name))
        Assert.Equal(expected, actual)
        Assert.Contains("PrintMembers(StringBuilder builder)", actual, StringComparison.Ordinal)
        Assert.Contains("interface IEquatable<", actual, StringComparison.Ordinal)
    }

    @Fact
    func PrintMembers_ShapeFollowsTheFourClassCases() {
        let Slot = func (name string) MethodInfo {
            return GSharp
                .Value
                .GetTypes()
                .Single((t Type) -> t.Name == name)
                .GetMethod(
                "PrintMembers",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            )!!
        }
        let sealedRoot = Slot("SealedRoot")
        Assert.True(sealedRoot.IsPrivate)
        Assert.False(sealedRoot.IsVirtual)
        let openRoot = Slot("OpenRoot")
        Assert.True(openRoot.IsFamily && openRoot.IsVirtual && (openRoot.Attributes & MethodAttributes.NewSlot) != 0)
        let openDerived = Slot("OpenDerived")
        Assert.True(
            openDerived.IsFamily &&
                openDerived.IsVirtual &&
                (openDerived.Attributes & MethodAttributes.NewSlot) == 0 &&
                !openDerived.IsFinal
        )
        let sealedDerived = Slot("SealedDerived")
        Assert.True(
            sealedDerived.IsFamily &&
                sealedDerived.IsVirtual &&
                (sealedDerived.Attributes & MethodAttributes.NewSlot) == 0 &&
                !sealedDerived.IsFinal
        )
        let structSlot = Slot("RS")
        Assert.True(structSlot.IsPrivate && !structSlot.IsVirtual)
    }

    @Theory
    @InlineData("SealedRoot", []object? {1, nil})
    @InlineData("OpenDerived", []object{2})
    @InlineData("SealedDerived", []object{5})
    @InlineData("RS", []object{3, 4})
    @InlineData("EmptyC", []object{})
    @InlineData("EmptyS", []object{})
    @InlineData("Order", []object{})
    @InlineData("Prices", []object? {1.5, nil, nil})
    func ToString_MatchesRoslynRecordFormat_UnderTheCurrentCulture(name string, arguments[]object) {
        Roslyn.Value.GetTypes().Single((t Type) -> t.Name == name)
        let Render = func (assembly Assembly) string {
            let type = assembly.GetTypes().Single((t Type) -> t.Name == name)
            let instance = if type.IsValueType && arguments.Length == 0 {
                Activator.CreateInstance(type)!!
            } else {
                Activator.CreateInstance(type, arguments)!!
            }
            return instance.ToString()!!
        }
        let previous = CultureInfo.CurrentCulture
        CultureInfo.CurrentCulture = CultureInfo("de-DE")
        try {
            let expected = Render(Roslyn.Value)
            let actual = Render(GSharp.Value)
            Assert.Equal(expected, actual)
            Assert.Contains(" { ", actual, StringComparison.Ordinal)
        } finally {
            CultureInfo.CurrentCulture = previous
        }
    }

    @Fact
    func ToString_UsesTheCurrentCulture_NotTheInvariantCulture() {
        let type = GSharp.Value.GetTypes().Single((t Type) -> t.Name == "Prices")
        let instance = Activator.CreateInstance(type, 1.5, nil, nil)!!
        let previous = CultureInfo.CurrentCulture
        try {
            CultureInfo.CurrentCulture = CultureInfo("de-DE")
            Assert.Equal("Prices { Amount = 1,5, Missing = , Label =  }", instance.ToString())
            CultureInfo.CurrentCulture = CultureInfo.InvariantCulture
            Assert.Equal("Prices { Amount = 1.5, Missing = , Label =  }", instance.ToString())
        } finally {
            CultureInfo.CurrentCulture = previous
        }
    }

    @Fact
    func ToString_PrintsPublicMembersInDeclarationOrder_AndSkipsPrivateOnes() {
        let order = GSharp.Value.GetTypes().Single((t Type) -> t.Name == "Order")
        Assert.Equal("Order { Late = 0, Early = 0, Mid = 0, Shown = 4 }", Activator.CreateInstance(order)!!.ToString())
    }

    @Fact
    func ToString_OfDerivedType_IncludesInheritedMembersFromBasePrintMembers() {
        let derived = GSharp.Value.GetTypes().Single((t Type) -> t.Name == "SealedDerived")
        Assert.Equal("SealedDerived { X = 1, W = 7 }", Activator.CreateInstance(derived, 7)!!.ToString())
    }

    @Fact
    func ToString_OfGenericType_PrintsTheSimpleName() {
        let generic = GSharp.Value.GetTypes().Single((t Type) -> t.Name == "Gen`1").MakeGenericType(typeof(string))
        Assert.Equal("Gen { Value = a }", Activator.CreateInstance(generic, "a")!!.ToString())
        let empty = Activator.CreateInstance(generic, []object? {nil})!!
        Assert.Equal("Gen { Value =  }", empty.ToString())
    }

    @Fact
    func DataTypes_ImplementIEquatableOfSelf_ThroughTheTypedEqualsSlot() {
        for type in GSharp
            .Value
            .GetTypes()
            .Where((t Type) -> (t.Name is "SealedRoot" or "OpenRoot" or "RS" or "EmptyS")) {
            let equatable = typeof(IEquatable[_]).MakeGenericType(type)
            Assert.True(equatable.IsAssignableFrom(type), type.Name)
            let map_ = type.GetInterfaceMap(equatable)
            Assert.Equal("Equals", map_.TargetMethods[0].Name)
            Assert.Equal(type, map_.TargetMethods[0].GetParameters()[0].ParameterType)
        }
    }

    @Fact
    func DeclaredSelfEquatable_IsNotRepeated_AndAnonymousLiteralsStillImplementIt() {
        const source = `package W
import System

data class Declared(X int32) : IEquatable[Declared]
data struct DeclaredStruct(X int32) : IEquatable[DeclaredStruct]
data class Plain(X int32)
func Build() string {
    let anonymous = data object { let Name = "n" }
    let plainAnonymous = object { let Name = "n" }
    return anonymous.ToString() + plainAnonymous.ToString()
}`
        let directory = Directory.CreateTempSubdirectory("gs_adr0199_eq_").FullName
        try {
            let path = Adr0199RecordAbiWitness.CompileGSharpToPath(source, directory)
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            var checkedTypes = 0
            for typeHandle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(typeHandle)
                let name = reader.GetString(type.Name)
                if name == "Declared" || name == "DeclaredStruct" || name == "Plain" || name.StartsWith(
                    "<>AnonymousType",
                    StringComparison.Ordinal
                ) {
                    // Each of these lists exactly one interface: IEquatable<Self>, once.
                    Assert.True(
                        type.GetInterfaceImplementations().Count == 1,
                        "$name has ${type.GetInterfaceImplementations().Count} InterfaceImpl rows."
                    )
                    checkedTypes++
                }
            }
            Assert.Equal(5, checkedTypes)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func AnonymousLiterals_AdoptTheCSharpAnonymousTypeFormat_WithoutRecordMembers() {
        const shapes = `package W
func Build() string {
    let record = data object { let Name = "David"; let Count = 2 }
    let plain = object { let Name = "David"; let Count = 2 }
    return record.ToString() + plain.ToString()
}`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(shapes)
        Assert.Equal(
            "{ Name = David, Count = 2 }{ Name = David, Count = 2 }",
            Adr0199RecordAbiWitness.Invoke(assembly, "Build")
        )
        let anonymous = assembly
            .GetTypes()
            .Where((t Type) -> t.Name.StartsWith("<>AnonymousType", StringComparison.Ordinal))
            .ToArray()
        Assert.Equal(2, anonymous.Length)
        let all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        for type in anonymous {
            Assert.DoesNotContain(type.GetMethods(all), (m MethodInfo) -> (m.Name is "PrintMembers" or "<Clone>$$"))
            Assert.DoesNotContain(
                type.GetConstructors(all),
                (c ConstructorInfo) -> c.GetParameters() is [{ParameterType: var p}] && p == type
            )
        }
    }

    @Fact
    func HandWrittenPrintMembers_ReplacesTheSynthesizedSlot_AndDerivedTypesCallIt() {
        const source = `package W
import System
import System.Text

open data class Base(Id int32) {
    protected open func PrintMembers(builder StringBuilder) bool {
        builder.Append("custom")
        return true
    }
}
data class Derived(Other int32) : Base(1)`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        let baseType = assembly.GetTypes().Single((t Type) -> t.Name == "Base")
        let slot = Assert.Single(baseType.GetMethods(all), (m MethodInfo) -> m.Name == "PrintMembers")
        Assert.True(
            slot.IsFamily && slot.IsVirtual && (slot.Attributes & MethodAttributes.NewSlot) != 0 && !slot.IsFinal
        )
        Assert.Equal("Base { custom }", Activator.CreateInstance(baseType, 9)!!.ToString())
        let derived = assembly.GetTypes().Single((t Type) -> t.Name == "Derived")
        Assert.Equal("Derived { custom, Other = 3 }", Activator.CreateInstance(derived, 3)!!.ToString())
    }

    @Fact
    func HandWrittenPrintMembersOverride_CanCallTheCompilerOwnedBaseSlot() {
        const source = `package W
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
}`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        let derived = assembly.GetTypes().Single((t Type) -> t.Name == "Derived")
        let slot = Assert.Single(derived.GetMethods(all), (m MethodInfo) -> m.Name == "PrintMembers")
        Assert.True(
            slot.IsFamily && slot.IsVirtual && (slot.Attributes & MethodAttributes.NewSlot) == 0 && !slot.IsFinal
        )
        Assert.Equal("Derived { <Id = 7> }", Activator.CreateInstance(derived, 1)!!.ToString())
    }

    @Fact
    func GenericBase_ContributesItsMembersThroughTheConstructedBaseSlot() {
        const source = `package W
open data class GenericBase[T](BaseValue T)
data class GenericChild(Own int32) : GenericBase[int32](1)`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let child = assembly.GetTypes().Single((t Type) -> t.Name == "GenericChild")
        Assert.Equal("GenericChild { BaseValue = 1, Own = 5 }", Activator.CreateInstance(child, 5)!!.ToString())
    }

    @Fact
    func AbstractDataClass_SynthesizesAProtectedVirtualPrintMembersWithABody() {
        const source = `package W
import System.Text

abstract data class Shape(Id int32)
data class Circle(R int32) : Shape(1)
abstract data class Custom(Id int32) {
    protected open func PrintMembers(builder StringBuilder) bool -> false
}`
        let directory = Directory.CreateTempSubdirectory("gs_adr0199_abstract_").FullName
        try {
            let path = Adr0199RecordAbiWitness.CompileGSharpToPath(source, directory)
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            let shape = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((t TypeDefinition) -> reader.GetString(t.Name) == "Shape")
            let printMembers = shape
                .GetMethods()
                .Select(reader.GetMethodDefinition)
                .Single((m MethodDefinition) -> reader.GetString(m.Name) == "PrintMembers")
            Assert.True((printMembers.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Family)
            Assert.True((printMembers.Attributes & MethodAttributes.Virtual) != 0)
            Assert.True((printMembers.Attributes & MethodAttributes.NewSlot) != 0)
            Assert.True((printMembers.Attributes & MethodAttributes.Abstract) == 0)
            Assert.NotEqual(0, printMembers.RelativeVirtualAddress)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let circle = assembly.GetTypes().Single((t Type) -> t.Name == "Circle")
        Assert.Equal("Circle { Id = 1, R = 2 }", Activator.CreateInstance(circle, 2)!!.ToString())
    }

    @Fact
    func IntermediaryClassOverride_IsWhatADerivedDataClassCallsAsBase() {
        const source = `package W
import System
import System.Text

open data class Base(Id int32)
open class Middle : Base(1) {
    protected open override func PrintMembers(builder StringBuilder) bool {
        builder.Append("middle")
        return true
    }
}
data class Leaf(Z int32) : Middle`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let leaf = assembly.GetTypes().Single((t Type) -> t.Name == "Leaf")
        Assert.Equal("Leaf { middle, Z = 3 }", Activator.CreateInstance(leaf, 3)!!.ToString())
    }

    @Fact
    func SealedIntermediaryOverride_CannotBeOverriddenBySynthesis() {
        const source = `package W
import System
import System.Text

open data class Base(Id int32)
open class Middle : Base(1) {
    protected override func PrintMembers(builder StringBuilder) bool -> true
}
data class Leaf(Z int32) : Middle`
        let (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0184", output, StringComparison.Ordinal)
    }

    @Fact
    func SharedPrintMembers_OfTheSlotShape_IsRejectedWithGS0623() {
        const source = `package W
import System.Text

data class Item(Id int32) {
    shared {
        func PrintMembers(builder StringBuilder) bool -> true
    }
}`
        let (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0623", output, StringComparison.Ordinal)
    }

    @Fact
    func ReadonlyValueTypeField_IsCopiedBeforeAMutatingToStringRuns() {
        const csharp = `public struct Counter { public int Count; public override string ToString() => (++Count).ToString(); }
public sealed record Item { public readonly Counter Value; public Counter Open; }`
        const gsharp = `package W
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
}`
        let Twice = func (assembly Assembly) string {
            let item object? = Activator.CreateInstance(assembly.GetTypes().Single((t Type) -> t.Name == "Item"))
            return item!!.ToString() + "|" + item!!.ToString()
        }
        let expected = Twice(Adr0199RecordAbiWitness.CompileCSharp(csharp))
        Assert.Equal("Item { Value = 1, Open = 1 }|Item { Value = 1, Open = 2 }", expected)
        Assert.Equal(expected, Twice(Adr0199RecordAbiWitness.CompileGSharp(gsharp)))
    }

    @Fact
    func PartialDataClass_PrintsMembersInMergedFileOrder() {
        let padding = string.Concat(Enumerable.Repeat("// padding so this member sits later in its file\n", 20))
        let assembly = Adr0199RecordAbiWitness.CompileGSharpFiles(("a.gs", "package W\n" + padding + `partial data class P {
    var FromA int32
}
`), ("b.gs", `package W
partial data class P {
    var FromB int32
}
`))
        let type = assembly.GetTypes().Single((t Type) -> t.Name == "P")
        Assert.Equal("P { FromA = 0, FromB = 0 }", Activator.CreateInstance(type)!!.ToString())
    }

    @Fact
    func IntermediaryWithAnUnrelatedPrintMembersShape_IsNotTheInheritedSlot() {
        const source = `package W
import System
import System.Text

open data class Base(Id int32)
open class Middle : Base(1) {
    protected open func PrintMembers(builder StringBuilder) int32 -> 5
}
data class Leaf(Z int32) : Middle`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let leaf = assembly.GetTypes().Single((t Type) -> t.Name == "Leaf")
        Assert.Equal("Leaf { Id = 1, Z = 3 }", Activator.CreateInstance(leaf, 3)!!.ToString())
    }

    @Fact
    func HandWrittenSlotWithoutOpen_StillAcceptsADerivedOverride() {
        const source = `package W
import System
import System.Text

open data class Base(Id int32) {
    protected func PrintMembers(builder StringBuilder) bool {
        builder.Append("base")
        return true
    }
}
open data class Derived(Z int32) : Base(1) {
    protected override func PrintMembers(builder StringBuilder) bool {
        builder.Append("derived")
        return true
    }
}
data class Leaf(Y int32) : Derived(2)`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let leaf = assembly.GetTypes().Single((t Type) -> t.Name == "Leaf")
        Assert.Equal("Leaf { derived, Y = 4 }", Activator.CreateInstance(leaf, 4)!!.ToString())
    }

    @Fact
    func ExplicitInterfacePrintMembers_CoexistsWithTheSynthesizedRecordSlot() {
        const source = `package W
import System.Text

interface IPrinter {
    func PrintMembers(builder StringBuilder) bool;
}
data class Open(Id int32) : IPrinter {
    func (IPrinter) PrintMembers(builder StringBuilder) bool -> false
}`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        let type = assembly.GetTypes().Single((t Type) -> t.Name == "Open")
        let slot = Assert.Single(type.GetMethods(all), (m MethodInfo) -> m.Name == "PrintMembers")
        Assert.True(slot.IsPrivate)
        Assert.Equal("Open { Id = 4 }", Activator.CreateInstance(type, 4)!!.ToString())
    }

    @Fact
    func RefReturningProperty_PrintsItsValue() {
        const csharp = "public sealed record Item { private int f = 3; private string s = \"x\"; public ref int P => ref f; public ref string S => ref s; }"
        const gsharp = `package W
data class Item {
    private var f int32 = 3
    private var s string = "x"
    prop P ref int32 { get { return ref f } }
    prop S ref string { get { return ref s } }
}`
        let expected string? = Activator.CreateInstance(
            Adr0199RecordAbiWitness.CompileCSharp(csharp).GetType("Item")!!
        )!!.ToString()
        Assert.Equal("Item { P = 3, S = x }", expected)
        let actual string? = Activator.CreateInstance(
            Adr0199RecordAbiWitness.CompileGSharp(gsharp).GetTypes().Single((t Type) -> t.Name == "Item")
        )!!.ToString()
        Assert.Equal(expected, actual)
    }

    @Fact
    func HandWrittenPrivateSlot_OnASealedType_StaysNonVirtualWhateverTheModifiers() {
        const source = `package W
import System.Text

data class Item(Id int32) {
    private open func PrintMembers(builder StringBuilder) bool -> false
}`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        let type = assembly.GetTypes().Single((t Type) -> t.Name == "Item")
        let slot = Assert.Single(type.GetMethods(all), (m MethodInfo) -> m.Name == "PrintMembers")
        Assert.True(slot.IsPrivate && !slot.IsVirtual)
        Assert.Equal("Item { }", Activator.CreateInstance(type, 1)!!.ToString())
    }

    @Fact
    func ReadonlyRefProperty_IsCopiedBeforeAMutatingToStringRuns() {
        const csharp = `public struct Counter { public int Count; public override string ToString() => (++Count).ToString(); }
public sealed record Item { private Counter c; public ref readonly Counter R => ref c; public Counter V => c; }`
        const gsharp = `package W
import System

struct Counter {
    var Count int32
    override func ToString() string {
        this.Count = this.Count + 1
        return this.Count.ToString()
    }
}
data class Item {
    private var c Counter
    prop R ref readonly Counter { get { return ref c } }
}`
        let Twice = func (assembly Assembly) string {
            let item object? = Activator.CreateInstance(assembly.GetTypes().Single((t Type) -> t.Name == "Item"))
            return item!!.ToString() + "|" + item!!.ToString()
        }
        let expectedText = Twice(Adr0199RecordAbiWitness.CompileCSharp(csharp))
        Assert.StartsWith("Item { R = 1", expectedText, StringComparison.Ordinal)
        Assert.Contains("|Item { R = 1", expectedText, StringComparison.Ordinal)
        Assert.Equal("Item { R = 1 }|Item { R = 1 }", Twice(Adr0199RecordAbiWitness.CompileGSharp(gsharp)))
    }

    @Fact
    func SuspendingFunctionNamedPrintMembers_IsNotTheSynchronousSlot() {
        const source = `package W
import System.Text

data class Item(Id int32) {
    suspend func PrintMembers(builder StringBuilder) bool -> true
}`
        let (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0623", output, StringComparison.Ordinal)
    }

    @Fact
    func HandWrittenSlot_MustSayOverrideExactlyWhenTheBaseHasOne() {
        const derivedWithoutOverride = `package W
import System.Text

open data class Base(Id int32)
data class Derived(Z int32) : Base(1) {
    protected func PrintMembers(builder StringBuilder) bool -> true
}`
        let (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(derivedWithoutOverride)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0623", output, StringComparison.Ordinal)
        const rootWithOverride = `package W
import System.Text

open data class Base(Id int32) {
    protected override func PrintMembers(builder StringBuilder) bool -> true
}`
        let (rootExit, rootOutput) = Adr0199RecordAbiWitness.TryCompileGSharp(rootWithOverride)
        Assert.NotEqual(0, rootExit)
        Assert.Contains("GS0623", rootOutput, StringComparison.Ordinal)
    }

    @Fact
    func HandWrittenOverride_BindsAgainstASynthesizedOverrideFurtherUpTheChain() {
        const source = `package W
import System
import System.Text

open data class Base(Id int32)
open data class Derived(Z int32) : Base(1)
data class Leaf(Y int32) : Derived(2) {
    protected override func PrintMembers(builder StringBuilder) bool {
        builder.Append("leaf")
        return true
    }
}`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let leaf = assembly.GetTypes().Single((t Type) -> t.Name == "Leaf")
        Assert.Equal("Leaf { leaf }", Activator.CreateInstance(leaf, 3)!!.ToString())
    }

    @Fact
    func AbstractBaseSlot_IsOverriddenByAHandWrittenSlot_AndTheAbstractBodyIsNeverCalled() {
        const source = `package W
import System
import System.Text

abstract data class Shape(Id int32) {
    protected open func PrintMembers(builder StringBuilder) bool;
}
data class Circle(R int32) : Shape(1) {
    protected override func PrintMembers(builder StringBuilder) bool {
        builder.Append("circle")
        return true
    }
}`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        Assert.Equal(
            "Circle { circle }",
            Activator.CreateInstance(assembly.GetTypes().Single((t Type) -> t.Name == "Circle"), 3)!!.ToString()
        )
    }

    @Fact
    func SuspendingIntermediarySlot_IsNotTheInheritedSlot() {
        const source = `package W
import System
import System.Text

open class Middle {
    protected open suspend func PrintMembers(builder StringBuilder) bool -> true
}
data class Leaf(Z int32) : Middle`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let leaf = assembly.GetTypes().Single((t Type) -> t.Name == "Leaf")
        Assert.Equal("Leaf { Z = 3 }", Activator.CreateInstance(leaf, 3)!!.ToString())
    }

    @Fact
    func HandWrittenPrintMembers_OfTheWrongShape_IsRejectedWithGS0623() {
        const source = `package W
import System.Text

data class Item(Id int32) {
    func PrintMembers(builder StringBuilder) bool -> true
}`
        let (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0623", output, StringComparison.Ordinal)
    }

    shared {
        private const CSharpWitness string = `#nullable enable
public sealed record SealedRoot(int X, string? Y);
public record OpenRoot(int X);
public record OpenDerived(int Z) : OpenRoot(1);
public sealed record SealedDerived(int W) : OpenRoot(1);
public record struct RS(int X, int Y);
public sealed record EmptyC();
public record struct EmptyS();
public sealed record Gen<T>(T Value);
public sealed record Order { public int Late; public int Early { get; init; } public int Mid; private int hidden; public int Shown = 4; public int Hidden2() => hidden; }
public sealed record Prices(double Amount, double? Missing, string? Label);`

        private const GSharpWitness string = `package W
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
data class Prices(Amount float64, Missing float64?, Label string?)`

        private let Roslyn Lazy[Assembly] = Lazy[Assembly](() -> Adr0199RecordAbiWitness.CompileCSharp(CSharpWitness))
        private let GSharp Lazy[Assembly] = Lazy[Assembly](() -> Adr0199RecordAbiWitness.CompileGSharp(GSharpWitness))
        func AbiShapes() TheoryData[string] -> TheoryData[string]{
            "SealedRoot",
            "OpenRoot",
            "OpenDerived",
            "SealedDerived",
            "RS",
            "EmptyC",
            "EmptyS",
            "Gen`1"
        }
    }
}
