// <copyright file="Adr0199RecordAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
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
    func AbstractBaseSlot_IsSatisfiedBySynthesizedDerivedDataClassPrintMembers() {
        const source = `package W
import System
import System.Text

abstract data class Shape(Id int32) {
    protected open func PrintMembers(builder StringBuilder) bool;
}
data class Square(Side int32) : Shape(2)`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let square = assembly.GetTypes().Single((t Type) -> t.Name == "Square")
        let all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        let slot = Assert.Single(square.GetMethods(all), (m MethodInfo) -> m.Name == "PrintMembers")
        Assert.True(
            slot.IsFamily && slot.IsVirtual && (slot.Attributes & MethodAttributes.NewSlot) == 0 && !slot.IsFinal
        )
        Assert.Equal("Square { Side = 5 }", Activator.CreateInstance(square, 5)!!.ToString())
    }

    @Fact
    func ImportedNonDataIntermediary_BetweenImportedRecordAndDataClass_PreservesInheritedPrintMembersSlot() {
        const extSource = `package Ext4877
import System.Text

public open data class Root(Id int32)
public open class CustomMiddle : Root {
    public init(id int32) : base(id) {}
    protected init(original CustomMiddle) : base(original.Id) {}
    protected open override func PrintMembers(builder StringBuilder) bool {
        builder.Append("CustomMiddle: ")
        return base.PrintMembers(builder)
    }
}
public open class PassThroughMiddle : Root {
    public init(id int32) : base(id) {}
    protected init(original PassThroughMiddle) : base(original.Id) {}
}
public open data class GenericRoot[T](Item T)
public open class GenericMiddle[T] : GenericRoot[T] {
    public init(item T) : base(item) {}
    protected init(original GenericMiddle[T]) : base(original.Item) {}
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4877_").FullName
        try {
            let extSrcPath = Path.Combine(tempDir, "Ext4877.gs")
            let extPath = Path.Combine(tempDir, "Ext4877.dll")
            File.WriteAllText(extSrcPath, extSource)
            let extExit = Program.Main(
                []string{
                    "/out:" + extPath,
                    "/assemblyname:Ext4877",
                    "/target:library",
                    "/targetframework:net10.0",
                    extSrcPath
                }
            )
            Assert.Equal(0, extExit)
            let extBytes = File.ReadAllBytes(extPath)
            const gsSource = `package W
import Ext4877

data class CustomLeaf(Side int32) : CustomMiddle(1)
data class PassThroughLeaf(Side int32) : PassThroughMiddle(2)
data class GenericLeaf(Side int32) : GenericMiddle[string]("tag")

func Run() string {
    return "${CustomLeaf(5)}|${PassThroughLeaf(6)}|${GenericLeaf(7)}"
}`
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, gsSource)
            let exit = Program.Main(
                []string{
                    "/out:" + outPath,
                    "/assemblyname:test",
                    "/target:library",
                    "/targetframework:net10.0",
                    "/reference:" + extPath,
                    srcPath
                }
            )
            Assert.Equal(0, exit)
            IlVerifier.Verify(outPath, []string{extPath})
            let outBytes = File.ReadAllBytes(outPath)
            let alc = System
                .Runtime
                .Loader
                .AssemblyLoadContext("Issue4877_" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                using let extLoadStream = MemoryStream(extBytes)
                alc.LoadFromStream(extLoadStream)
                using let outLoadStream = MemoryStream(outBytes)
                let asm = alc.LoadFromStream(outLoadStream)
                let declared = BindingFlags.Instance |
                BindingFlags.Public |
                BindingFlags.NonPublic |
                BindingFlags.DeclaredOnly
                for typeName in[]string{"W.CustomLeaf", "W.PassThroughLeaf", "W.GenericLeaf"} {
                    let leafType = asm.GetType(typeName, throwOnError: true)!!
                    let slot = Assert.Single(leafType.GetMethods(declared), (m MethodInfo) -> m.Name == "PrintMembers")
                    Assert.True(
                        slot.IsFamily &&
                            slot.IsVirtual &&
                            (slot.Attributes & MethodAttributes.NewSlot) == 0 &&
                            !slot.IsFinal
                    )
                }
                let result = asm.GetType("W.<Program>", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)
                Assert.Equal(
                    "CustomLeaf { CustomMiddle: Id = 1, Side = 5 }|PassThroughLeaf { Id = 2, Side = 6 }|GenericLeaf { Item = tag, Side = 7 }",
                    result
                )
            } finally {
                alc.Unload()
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
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

    @Fact
    func InheritedPositionalProperty_NestedReversedOrder_AndPrivateGetterControls() {
        const source = `package W

data class Token(Kind int32)

class Outer {
    data class DerivedBeforeBase(Name string, Value int32) : BaseAfterDerived(Name)
    data class QualifiedDerivedBeforeBase(Name string, Value int32) : Bases.NestedBase(Name)
    data class PackageQualifiedDerived(Name string, Value int32) : W.Outer.BaseAfterDerived(Name)
    unsafe data class GenericDerivedBeforeNonGenericBase[Token](Name string, Payload Token) : NonGenericBaseWithToken(Name)
    open data class NonGenericBaseWithToken(Name string) {
        var Tag Token = Token(7)
    }
    class Holder {
        class BaseAfterDerived
        data class HolderDerived(Name string, Value int32) : Outer.BaseAfterDerived(Name)
    }
    class Left {
        data class D(Name string, Value int32) : Outer.Right.B(Name)
        open data class A(Name string)
    }
    class Right {
        data class E(Name string, Value int32) : Outer.Left.A(Name)
        open data class B(Name string)
    }
    data class Message[T](Name string, Data T) : Message(Name)
    open data class Message(Name string)
    data class EscapedDerived(Name string, Value int32) : $event(Name)
    open data class $event(Name string)
    open data class BaseAfterDerived(Name string)
    class Bases {
        open data class NestedBase(Name string)
    }

    shared {
        func EnclosingUnpack(item DerivedFromProtectedGetter) string {
            let (v, e) = item
            return "${v}:${e}"
        }
    }
}

open class BaseWithPrivateGetter {
    prop Hidden int32 { private get; set; }
}

data class DerivedFromPrivateGetter(Hidden int32, Extra int32) : BaseWithPrivateGetter()

open class BaseWithProtectedGetter {
    protected prop Value int32 { get; set; }
    init(v int32) {
        Value = v
    }
}

data class DerivedFromProtectedGetter(Value int32, Extra int32) : BaseWithProtectedGetter(Value) {
    init(seed DerivedFromProtectedGetter) : base(0) {
        let (sv, se) = seed
        Value = sv + 1
        Extra = se + 1
    }
}

open data class TupleBase(Pair (X int32, Y int32))
data class TupleDerived(Pair (Left int32, Right int32), Extra int32) : TupleBase(Pair)

interface IValueCarrier {
    prop Value int32 { get; }
}

data class DerivedWithExplicitInterface(Value int32, Extra int32) : BaseWithProtectedGetter(Value), IValueCarrier {
    prop (IValueCarrier) Value int32 -> Value
}

open data class HiddenBase(Value int32)
open class HiddenMiddle : HiddenBase(31) {
    var Value string = "middle"
}
data class DerivedBehindField(Value int32, Extra int32) : HiddenMiddle()

open data class FixedArrBase(Items [2]int32)
data class FixedArrDerived(Items [3]int32, Extra int32) : FixedArrBase([2]int32{1, 2})

open class ExplicitOnlyBase : IValueCarrier {
    prop (IValueCarrier) Value int32 -> 99
}
data class DerivedOverExplicitOnly(Value int32) : ExplicitOnlyBase()

open class ExplicitMiddle : HiddenBase(41), IValueCarrier {
    init(v int32) : super(v) {}
    prop (IValueCarrier) Value int32 -> 99
}
data class DerivedOverExplicitMiddle(Value int32, Extra int32) : ExplicitMiddle(Value)

open data class GenBase[T](Value T)
open data class GenMiddle(Value int32) : GenBase[int32](Value)
data class GenLeaf(Extra int32) : GenMiddle(0)

class SiblingConstructingDerived : BaseWithProtectedGetter {
    init() : super(0) {}
    func Make() DerivedFromProtectedGetter -> DerivedFromProtectedGetter{Value: 42, Extra: 8}
}

func Run() string {
    let d = Outer.DerivedBeforeBase("ok", 7)
    let (n, v) = d
    let q = Outer.QualifiedDerivedBeforeBase("qual", 8)
    let (qn, qv) = q
    let msg = Outer.Message[int32]("msg", 99)
    let (mn, md) = msg
    let esc = Outer.EscapedDerived("ev", 3)
    let (en, ev) = esc
    let p = DerivedFromPrivateGetter(99, 5)
    let (h, e) = p
    let prot = DerivedFromProtectedGetter{Value: 15, Extra: 25}
    let protNext = DerivedFromProtectedGetter(prot)
    let (pv, pe) = protNext
    let unpacked = Outer.EnclosingUnpack(prot)
    let td = TupleDerived((3, 4), 10)
    let (pair, te) = td
    let gd = Outer.GenericDerivedBeforeNonGenericBase[string]("tok", "payload")
    let explicitCarrier IValueCarrier = DerivedWithExplicitInterface(51, 52)
    let behind = DerivedBehindField(61, 62)
    let (bv, be) = behind
    let fa = FixedArrDerived([3]int32{10, 20, 30}, 5)
    let (faItems, faExtra) = fa
    let eo = DerivedOverExplicitOnly(77)
    let (eov) = eo
    let em = DerivedOverExplicitMiddle(88, 89)
    let (emv, eme) = em
    let gl = GenLeaf{Extra: 1, Value: 2}
    let sibConstructed = SiblingConstructingDerived().Make()
    let sibUnpacked = Outer.EnclosingUnpack(sibConstructed)
    return "${d}|${n}:${v}|${q}|${qn}:${qv}|${msg}|${mn}:${md}|${esc}|${en}:${ev}|${p}|${h}:${e}|${unpacked}|${pv}:${pe}|${pair.Left}:${pair.Right}:${te}|${gd.Name}:${gd.Payload}:${gd.Tag.Kind}|${explicitCarrier.Value}|${behind.Value}:${bv}:${be}|${faItems[0]}:${faItems[2]}:${faExtra}|${eo.Value}:${eov}|${em.Value}:${emv}:${eme}|${gl.Value}:${gl.Extra}|${sibUnpacked}"
}`
        let assembly = Adr0199RecordAbiWitness.CompileGSharp(source)
        let declared = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        let nestedDerived = assembly.GetType("W.Outer+DerivedBeforeBase", throwOnError: true)!!
        Assert.DoesNotContain(nestedDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let genericBeforeNonGeneric = assembly.GetType(
            "W.Outer+GenericDerivedBeforeNonGenericBase`1",
            throwOnError: true
        )!!
        Assert.DoesNotContain(genericBeforeNonGeneric.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let nonGenericBase = assembly.GetType("W.Outer+NonGenericBaseWithToken", throwOnError: true)!!
        Assert.Equal("W.Token", nonGenericBase.GetField("Tag")!!.FieldType.FullName)
        let behindFieldType = assembly.GetType("W.DerivedBehindField", throwOnError: true)!!
        Assert.Contains(behindFieldType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Value")
        let fixedArrDerivedType = assembly.GetType("W.FixedArrDerived", throwOnError: true)!!
        Assert.Contains(fixedArrDerivedType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Items")
        let explicitOnlyDerivedType = assembly.GetType("W.DerivedOverExplicitOnly", throwOnError: true)!!
        Assert.Contains(explicitOnlyDerivedType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Value")
        let explicitMiddleDerivedType = assembly.GetType("W.DerivedOverExplicitMiddle", throwOnError: true)!!
        Assert.DoesNotContain(explicitMiddleDerivedType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Value")
        const safeBaseLeakCheck = `package W
class Outer {
    unsafe data class UnsafeDerived(Name string) : SafeBase(Name)
    open data class SafeBase(Name string) {
        func BadPtr(x *int32) int32 -> 0
    }
}`
        let (safeExit, safeOut) = Adr0199RecordAbiWitness.TryCompileGSharp(safeBaseLeakCheck)
        Assert.NotEqual(0, safeExit)
        Assert.Contains("GS0243", safeOut, StringComparison.Ordinal)
        const missingProtectedInterfaceCheck = `package W
interface I { prop Value int32 { get; } }
open class B {
    protected prop Value int32 { get; set; }
    init(v int32) { Value = v }
}
data class D(Value int32) : B(Value), I`
        let (ifaceExit, ifaceOut) = Adr0199RecordAbiWitness.TryCompileGSharp(missingProtectedInterfaceCheck)
        Assert.NotEqual(0, ifaceExit)
        Assert.Contains("GS0187", ifaceOut, StringComparison.Ordinal)
        const nullableBaseToNonNullDerivedCheck = `package W
open data class B(Name string?)
data class D(Name string, Value int32) : B(nil)`
        let (nullExit, nullOut) = Adr0199RecordAbiWitness.TryCompileGSharp(nullableBaseToNonNullDerivedCheck)
        Assert.NotEqual(0, nullExit)
        Assert.Contains("GS0155", nullOut, StringComparison.Ordinal)
        const nestedNullableBaseCheck = `package W
import System.Collections.Generic
open data class B(Items List[string?])
data class D(Items List[string], Value int32) : B(Items)`
        let (nestedNullExit, nestedNullOut) = Adr0199RecordAbiWitness.TryCompileGSharp(nestedNullableBaseCheck)
        Assert.NotEqual(0, nestedNullExit)
        Assert.Contains("GS0155", nestedNullOut, StringComparison.Ordinal)
        const nestedTupleInContainerCheck = `package W
import System.Collections.Generic
open data class B(Items List[(Name string, Id int32)])
data class D(Items List[(Name string?, Id int32)], Value int32) : B(Items)`
        let (nestedTupleExit, nestedTupleOut) = Adr0199RecordAbiWitness.TryCompileGSharp(nestedTupleInContainerCheck)
        Assert.NotEqual(0, nestedTupleExit)
        Assert.Contains("GS0155", nestedTupleOut, StringComparison.Ordinal)
        let qualifiedDerived = assembly.GetType("W.Outer+QualifiedDerivedBeforeBase", throwOnError: true)!!
        Assert.DoesNotContain(qualifiedDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let packageQualifiedDerived = assembly.GetType("W.Outer+PackageQualifiedDerived", throwOnError: true)!!
        Assert.DoesNotContain(packageQualifiedDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let holderDerived = assembly.GetType("W.Outer+Holder+HolderDerived", throwOnError: true)!!
        Assert.DoesNotContain(holderDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let leftDerived = assembly.GetType("W.Outer+Left+D", throwOnError: true)!!
        Assert.DoesNotContain(leftDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let rightDerived = assembly.GetType("W.Outer+Right+E", throwOnError: true)!!
        Assert.DoesNotContain(rightDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let genericMessageDerived = assembly.GetType("W.Outer+Message`1", throwOnError: true)!!
        Assert.DoesNotContain(genericMessageDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let escapedDerived = assembly.GetType("W.Outer+EscapedDerived", throwOnError: true)!!
        Assert.DoesNotContain(escapedDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
        let privateGetterDerived = assembly.GetType("W.DerivedFromPrivateGetter", throwOnError: true)!!
        Assert.Contains(privateGetterDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Hidden")
        let protectedGetterDerived = assembly.GetType("W.DerivedFromProtectedGetter", throwOnError: true)!!
        Assert.DoesNotContain(protectedGetterDerived.GetProperties(declared), (p PropertyInfo) -> p.Name == "Value")
        Assert.Equal(
            "DerivedBeforeBase { Name = ok, Value = 7 }|ok:7|QualifiedDerivedBeforeBase { Name = qual, Value = 8 }|qual:8|Message { Name = msg, Data = 99 }|msg:99|EscapedDerived { Name = ev, Value = 3 }|ev:3|DerivedFromPrivateGetter { Hidden = 99, Extra = 5 }|99:5|15:25|16:26|3:4:10|tok:payload:7|51|61:61:62|10:30:5|77:77|88:88:89|2:1|42:8",
            Adr0199RecordAbiWitness.Invoke(assembly, "Run")
        )
    }

    @Fact
    func ExplicitPositionalReplacement_OnDerivedDataClass_StillValidatesTypeCompatibility() {
        const invalidReplacement = `package W

open data class Base(Value int32)
data class Child(Value int32) : Base(Value) {
    prop Value string { get; init; }
}`
        let (exitCode, output) = Adr0199RecordAbiWitness.TryCompileGSharp(invalidReplacement)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0155", output, StringComparison.Ordinal)
    }

    @Fact
    func ImportedClrBasePositionalProperty_ChecksTypeAndVisibility_AndSupportsLiterals() {
        const csharpLib = `namespace ExtLib;
public record ClrBase
{
    private int _refVal;
    public ClrBase() { }
    public ClrBase(int value) { Value = value; _refVal = value; }
    public int Value { get; init; }
    public ref int RefVal => ref _refVal;
    public int IntProp => 10;
    internal int InternalProp => 20;
    private protected int PrivateProtectedProp => 30;
}
public record ClrGenericBase<T>(T Value);
public record ClrProtGetBase
{
    public ClrProtGetBase(int value) { Value = value; }
    public int Value { protected get; init; }
}
public record ClrProtSetBase
{
    public ClrProtSetBase(int value) { Value = value; }
    public int Value { get; protected set; }
}
public record ClrMiddleWithField : ClrBase
{
    public new string Value = "clr-middle";
    public ClrMiddleWithField() : base(31) { }
}
#nullable disable
public record ClrObliviousBase(string Name);
#nullable restore`
        let tempDir = Directory.CreateTempSubdirectory("gs_adr0199_clrbase_").FullName
        try {
            let extPath = Path.Combine(tempDir, "ExtLib.dll")
            let references = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                (path string) -> Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(path)
            )
            let csharpCompilation = Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpCompilation
                .Create(
                "ExtLib",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(csharpLib)},
                references,
                Microsoft
                    .CodeAnalysis
                    .CSharp
                    .CSharpCompilationOptions(Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary)
            )
            using let extStream = MemoryStream()
            Assert.True(csharpCompilation.Emit(extStream).Success)
            let extBytes = extStream.ToArray()
            File.WriteAllBytes(extPath, extBytes)
            const friendCSharpLib = `[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("test")]
namespace FriendLib;
public record FriendPrivProtSetBase
{
    public FriendPrivProtSetBase(int value) { Value = value; }
    public int Value { get; private protected set; }
}
public record FriendProtInternalSetBase
{
    public FriendProtInternalSetBase(int value) { Value = value; }
    public int Value { get; protected internal set; }
}`
            let friendPath = Path.Combine(tempDir, "FriendLib.dll")
            let friendCompilation = Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpCompilation
                .Create(
                "FriendLib",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(friendCSharpLib)},
                references,
                Microsoft
                    .CodeAnalysis
                    .CSharp
                    .CSharpCompilationOptions(Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary)
            )
            using let friendStream = MemoryStream()
            Assert.True(friendCompilation.Emit(friendStream).Success)
            let friendBytes = friendStream.ToArray()
            File.WriteAllBytes(friendPath, friendBytes)
            let gsSource = `package W
import ExtLib
import FriendLib

data class ReusesValue(Value int32, Extra int32) : ClrBase(Value) {
    init() : base(11) {
        Extra = 22
    }
}
data class ReusesRefVal(RefVal int32, Extra int32) : ClrBase(RefVal)
data class GenericReusesValue[T](Value T) : ClrGenericBase[T](Value)
data class ReusesProtGet(Value int32, Extra int32) : ClrProtGetBase(Value)
data class ReusesProtSet(Value int32, Extra int32) : ClrProtSetBase(Value) {
    func WithUpdated(v int32) ReusesProtSet -> this.copy(Value: v)
}
open data class ProtSetMiddle : ClrProtSetBase {
    init() : base(0) {}
    init(v int32) : base(v) {}
    func UpdateChild(d ReusesProtSetViaMiddle, v int32) ReusesProtSetViaMiddle -> d.copy(Value: v)
}
data class ReusesProtSetViaMiddle(Value int32, Extra int32) : ProtSetMiddle(Value)
data class ReusesPrivProtSet(Value int32, Extra int32) : FriendPrivProtSetBase(Value) {
    func WithUpdated(v int32) ReusesPrivProtSet -> this.copy(Value: v)
}
data class ReusesProtInternalSet(Value int32, Extra int32) : FriendProtInternalSetBase(Value)
interface IClrValue {
    prop Value int32 { get; }
}
data class ReusesValueWithExplicit(Value int32, Extra int32) : ClrBase(Value), IClrValue {
    prop (IClrValue) Value int32 -> Value + 100
    func SpreadSelf() SpreadTarget -> SpreadTarget{...this}
}
data class ReusesObliviousAsNullable(Name string?, Extra int32) : ClrObliviousBase(Name)
data class BehindClrField(Value int32, Extra int32) : ClrMiddleWithField()
data class DifferentType(IntProp string, Extra int32) : ClrBase()
data class InaccessibleGetters(InternalProp int32, PrivateProtectedProp int32) : ClrBase()
class SpreadTarget {
    var Value int32
    var Extra int32
}
class SpreadRefTarget {
    var RefVal int32
    var Extra int32
}

func Run() string {
    let a = ReusesValue{}
    let b = ReusesValue{Value: 42, Extra: 7}
    let (bv, be) = b
    let spread = SpreadTarget{...b}
    let refSource = ReusesRefVal(55, 66)
    let spreadRef = SpreadRefTarget{...refSource}
    let refMatched = (refSource is { RefVal: 55, Extra: 66 }) && !(refSource is { RefVal: 0 })
    let pg = ReusesProtGet(12, 34)
    let (pgv, pge) = pg
    let ps = ReusesProtSet(70, 80).WithUpdated(90)
    let psm = ProtSetMiddle(0).UpdateChild(ReusesProtSetViaMiddle(10, 20), 30)
    let pps = ReusesPrivProtSet(50, 60).WithUpdated(95)
    let pis = ReusesProtInternalSet(40, 50).copy(Value: 45)
    let exprTree System.Linq.Expressions.Expression[System.Func[ReusesValue, int32]] = (rv ReusesValue) -> rv.Value
    let exprVal = exprTree.Compile().Invoke(b)
    let rve = ReusesValueWithExplicit{Value: 2, Extra: 3}.copy(Value: 4)
    let rveIface IClrValue = rve
    let rveMatched = (rve is { Value: 4, Extra: 3 }) && !(rve is { Value: 104 })
    let rveSpreadExt = SpreadTarget{...rve}
    let rveSpreadSelf = rve.SpreadSelf()
    let obNull = ReusesObliviousAsNullable(nil, 7)
    let (obn, obe) = obNull
    let bf = BehindClrField(81, 82)
    let (bfv, bfe) = bf
    let ctorDefault = ReusesValue()
    let gen = GenericReusesValue{Value: 77}
    let c = DifferentType("hello", 9)
    let (ci, ce) = c
    let d = InaccessibleGetters(1, 2)
    let (di, dp) = d
    return "${a.Value}:${a.Extra}|${bv}:${be}|${spread.Value}:${spread.Extra}|${spreadRef.RefVal}:${spreadRef.Extra}:${refMatched}|${pgv}:${pge}|${ps.Value}:${ps.Extra}|${psm.Value}:${psm.Extra}|${pps.Value}:${pps.Extra}|${pis.Value}:${pis.Extra}:${exprVal}|${rve.Value}:${rve.Extra}:${rveIface.Value}:${rveMatched}:${rveSpreadExt.Value}:${rveSpreadSelf.Value}|${obn ?? "nil"}:${obe}|${bf.Value}:${bfv}:${bfe}|${ctorDefault.Value}:${ctorDefault.Extra}|${gen.Value}|${ci}:${ce}|${di}:${dp}"
}`
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, gsSource)
            let exit = Program.Main(
                []string{
                    "/out:" + outPath,
                    "/assemblyname:test",
                    "/target:library",
                    "/targetframework:net10.0",
                    "/reference:" + extPath,
                    "/reference:" + friendPath,
                    srcPath
                }
            )
            Assert.Equal(0, exit)
            IlVerifier.Verify(outPath, []string{extPath, friendPath})
            let badFriendSrcPath = Path.Combine(tempDir, "bad_friend.gs")
            let badFriendOutPath = Path.Combine(tempDir, "bad_dir", "test.dll")
            Directory.CreateDirectory(Path.GetDirectoryName(badFriendOutPath)!!)
            File.WriteAllText(badFriendSrcPath, `package W
import FriendLib
data class ReusesPrivProtSet(Value int32, Extra int32) : FriendPrivProtSetBase(Value)
func Bad() ReusesPrivProtSet -> ReusesPrivProtSet(1, 2).copy(Value: 3)`)
            let badFriendExit = Program.Main(
                []string{
                    "/out:" + badFriendOutPath,
                    "/assemblyname:test",
                    "/target:library",
                    "/targetframework:net10.0",
                    "/reference:" + friendPath,
                    badFriendSrcPath
                }
            )
            Assert.NotEqual(0, badFriendExit)
            let badReceiverSrcPath = Path.Combine(tempDir, "bad_receiver.gs")
            let badReceiverOutPath = Path.Combine(tempDir, "bad_receiver.dll")
            File.WriteAllText(badReceiverSrcPath, `package W
import ExtLib
open data class ProtSetMiddle : ClrProtSetBase {
    init() : base(0) {}
    init(v int32) : base(v) {}
}
data class ReusesProtSetViaMiddle(Value int32, Extra int32) : ProtSetMiddle(Value)
class ProtSetSibling : ClrProtSetBase {
    init(v int32) : base(v) {}
    func Bad(d ReusesProtSetViaMiddle) ReusesProtSetViaMiddle -> d.copy(Value: 2)
}`)
            let badReceiverExit = Program.Main(
                []string{
                    "/out:" + badReceiverOutPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/reference:" + extPath,
                    badReceiverSrcPath
                }
            )
            Assert.NotEqual(0, badReceiverExit)
            let outBytes = File.ReadAllBytes(outPath)
            let declared = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            let alc = System
                .Runtime
                .Loader
                .AssemblyLoadContext("Issue4874ClrBase_" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                using let extLoadStream = MemoryStream(extBytes)
                alc.LoadFromStream(extLoadStream)
                using let friendLoadStream = MemoryStream(friendBytes)
                alc.LoadFromStream(friendLoadStream)
                using let outLoadStream = MemoryStream(outBytes)
                let asm = alc.LoadFromStream(outLoadStream)
                let reusesType = asm.GetType("W.ReusesValue", throwOnError: true)!!
                Assert.DoesNotContain(reusesType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Value")
                let protGetType = asm.GetType("W.ReusesProtGet", throwOnError: true)!!
                Assert.DoesNotContain(protGetType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Value")
                let protSetType = asm.GetType("W.ReusesProtSet", throwOnError: true)!!
                Assert.DoesNotContain(protSetType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Value")
                let obNullType = asm.GetType("W.ReusesObliviousAsNullable", throwOnError: true)!!
                Assert.DoesNotContain(obNullType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Name")
                let behindClrFieldType = asm.GetType("W.BehindClrField", throwOnError: true)!!
                Assert.Contains(behindClrFieldType.GetProperties(declared), (p PropertyInfo) -> p.Name == "Value")
                let diffType = asm.GetType("W.DifferentType", throwOnError: true)!!
                Assert.Contains(diffType.GetProperties(declared), (p PropertyInfo) -> p.Name == "IntProp")
                let inaccType = asm.GetType("W.InaccessibleGetters", throwOnError: true)!!
                Assert.Contains(inaccType.GetProperties(declared), (p PropertyInfo) -> p.Name == "InternalProp")
                Assert.Contains(inaccType.GetProperties(declared), (p PropertyInfo) -> p.Name == "PrivateProtectedProp")
                let result = asm.GetType("W.<Program>", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)
                Assert.Equal(
                    "0:0|42:7|42:7|55:66:True|12:34|90:80|30:20|95:60|45:50:42|4:3:104:True:4:4|nil:7|81:81:82|11:22|77|hello:9|1:2",
                    result
                )
            } finally {
                alc.Unload()
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func OmittedOptionalGenericDelegateArguments_AndSynthesizedRecordCompilerGeneratedMetadata() {
        const source = `package Additional
import System

delegate NamedCallback[T]() T;

func Accept[T](callback(() -> T)? = nil) bool -> callback == nil
func AcceptNamed[T](callback NamedCallback[T]? = nil) bool -> callback == nil
func AcceptWithSeed[T](seed T, callback(() -> T)? = nil) T -> if callback == nil { seed } else { callback() }

func (self string) ExtAccept[T](callback(() -> T)? = nil) string -> if callback == nil { self } else { "called" }

public class Implicit {}
public class Explicit { public init() {} }
public data class Record(Value int32) {
    public func MethodAccept[T](callback(() -> T)? = nil) int32 -> if callback == nil { this.Value } else { 0 }
    public func MethodVariadic[T](items ...T) int32 -> items.Length
    shared {
        public func StaticAccept[T](callback(() -> T)? = nil) string -> if callback == nil { "static" } else { "called" }
        public func StaticVariadic[T](items ...T) int32 -> items.Length
    }
}

public partial class Late {}
/// Late summary.
public partial class Late {}

/// Early summary.
public partial class Early {}
public partial class Early {}

/// Control summary.
public class Control {}

public func Invoke() string {
    let r = Record(42)
    return "${Accept[string]()}|${AcceptNamed[string]()}|${AcceptWithSeed("seed")}|${"ext".ExtAccept[string]()}|${r.MethodAccept[string]()}|${Record.StaticAccept[string]()}|${r.MethodVariadic[int32]()}|${Record.StaticVariadic[int32]()}"
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_5760_5761_5762_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "Additional.gs")
            let outPath = Path.Combine(tempDir, "Additional.dll")
            let pdbPath = Path.Combine(tempDir, "Additional.pdb")
            let docPath = Path.Combine(tempDir, "Additional.xml")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = Program.Main(
                    []string{
                        "/out:" + outPath,
                        "/assemblyname:Additional",
                        "/target:library",
                        "/targetframework:net10.0",
                        "/debug:portable",
                        "/doc:" + docPath,
                        srcPath
                    }
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exit == 0, "${compileOut}${compileErr}")
            IlVerifier.Verify(outPath)
            let assembly = EmittedFixture.Load(outPath)
            Assert.Equal("True|True|seed|ext|42|static|0|0", Adr0199RecordAbiWitness.Invoke(assembly, "Invoke"))

            using let peStream = File.OpenRead(outPath)
            using let pe = PEReader(peStream)
            let metadata = pe.GetMetadataReader()
            using let pdbStream = File.OpenRead(pdbPath)
            using let pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
            let pdb = pdbProvider.GetMetadataReader()

            let GetMethodSummary = func (typeName string, methodName string, paramCount int32)(
                Attributes[]string,
                SequencePoints int32
            ) {
                let typeDef = metadata
                    .TypeDefinitions
                    .Select(metadata.GetTypeDefinition)
                    .Single((t TypeDefinition) -> metadata.GetString(t.Name) == typeName)
                for methodHandle in typeDef.GetMethods() {
                    let method = metadata.GetMethodDefinition(methodHandle)
                    if metadata.GetString(method.Name) != methodName || method.GetParameters().Count != paramCount {
                        continue
                    }
                    let attrs = method
                        .GetCustomAttributes()
                        .Select(
                        func (attrHandle CustomAttributeHandle) string {
                            let attr = metadata.GetCustomAttribute(attrHandle)
                            if attr.Constructor.Kind != HandleKind.MemberReference {
                                return attr.Constructor.Kind.ToString()
                            }
                            let parent = metadata.GetMemberReference(cast[MemberReferenceHandle](attr.Constructor))
                                .Parent
                            if parent.Kind != HandleKind.TypeReference {
                                return parent.Kind.ToString()
                            }
                            let attrType = metadata.GetTypeReference(cast[TypeReferenceHandle](parent))
                            return metadata.GetString(attrType.Namespace) + "." + metadata.GetString(attrType.Name)
                        }
                    )
                        .ToArray()
                    let debugHandle = System
                        .Reflection
                        .Metadata
                        .Ecma335
                        .MetadataTokens
                        .MethodDebugInformationHandle(
                        System.Reflection.Metadata.Ecma335.MetadataTokens.GetRowNumber(methodHandle)
                    )
                    let points = pdb.GetMethodDebugInformation(debugHandle).GetSequencePoints().Count()
                    return (attrs, points)
                }
                throw InvalidOperationException("Missing $typeName.$methodName/$paramCount")
            }

            let implicitCtor = GetMethodSummary("Implicit", ".ctor", 0)
            Assert.Empty(implicitCtor.Attributes)
            Assert.Equal(0, implicitCtor.SequencePoints)

            let explicitCtor = GetMethodSummary("Explicit", ".ctor", 0)
            Assert.Empty(explicitCtor.Attributes)
            Assert.Equal(2, explicitCtor.SequencePoints)

            for (methodName, paramCount) in[](string, int32){
                ("GetHashCode", 0),
                ("ToString", 0),
                ("Deconstruct", 1),
                ("PrintMembers", 1),
                ("Equals", 1),
                ("op_Equality", 2),
                ("op_Inequality", 2),
                ("<Clone>$$", 0),
                ("get_EqualityContract", 0),
                ("get_Value", 0),
                ("set_Value", 1)
            } {
                let summary = GetMethodSummary("Record", methodName, paramCount)
                Assert.Contains("System.Runtime.CompilerServices.CompilerGeneratedAttribute", summary.Attributes)
                Assert.Equal(0, summary.SequencePoints)
            }

            let docXml = File.ReadAllText(docPath)
            Assert.Contains("<member name=\"T:Additional.Early\">", docXml, StringComparison.Ordinal)
            Assert.Contains("Early summary.", docXml, StringComparison.Ordinal)
            Assert.Contains("<member name=\"T:Additional.Late\">", docXml, StringComparison.Ordinal)
            Assert.Contains("Late summary.", docXml, StringComparison.Ordinal)
            Assert.Contains("<member name=\"T:Additional.Control\">", docXml, StringComparison.Ordinal)
            Assert.Contains("Control summary.", docXml, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
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
