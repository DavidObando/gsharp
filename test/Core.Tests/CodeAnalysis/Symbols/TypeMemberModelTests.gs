// <copyright file="TypeMemberModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0112 Phase 3: unit coverage for the canonical member-resolution layer
/// ((cref:TypeMemberModel)) — by-name lookup across kinds, the
/// inheritance walk, static/instance filters, overload sets with signature
/// dedup, and enumeration for completion.
open class TypeMemberModelTests {
    @Fact
    func LookupMember_InstanceProperty_Found() {
        let animal = GetStruct("Animal")
        let member Symbol? = TypeMemberModel.LookupMember(animal, "Name", MemberQuery.All)
        Assert.IsType[PropertySymbol](member)
    }

    @Fact
    func LookupMember_InheritedProperty_Found() {
        let animal = GetStruct("Animal")
        let member Symbol? = TypeMemberModel.LookupMember(animal, "BaseProp", MemberQuery.All)
        Assert.IsType[PropertySymbol](member)
    }

    @Fact
    func LookupMember_StaticField_Found() {
        let animal = GetStruct("Animal")
        let member Symbol? = TypeMemberModel.LookupMember(animal, "Count", MemberQuery.All)
        Assert.IsType[FieldSymbol](member)
    }

    @Fact
    func LookupMember_InstanceMethod_Found() {
        let animal = GetStruct("Animal")
        let member Symbol? = TypeMemberModel.LookupMember(animal, "Speak", MemberQuery.All)
        Assert.IsType[FunctionSymbol](member)
    }

    @Fact
    func LookupMember_StaticOnlyQuery_DoesNotFindInstanceMember() {
        let animal = GetStruct("Animal")
        let member Symbol? = TypeMemberModel.LookupMember(animal, "Name", MemberQuery.Static())
        Assert.Null(member)
    }

    @Fact
    func LookupMember_InstanceOnlyQuery_DoesNotFindStaticMember() {
        let animal = GetStruct("Animal")
        let member Symbol? = TypeMemberModel.LookupMember(animal, "Count", MemberQuery.Instance())
        Assert.Null(member)
    }

    @Fact
    func LookupMember_NotInheritedQuery_DoesNotWalkBaseChain() {
        let animal = GetStruct("Animal")
        let query = MemberQuery(includeInstance: true, includeStatic: true, includeInherited: false, MemberKinds.All)
        Assert.Null(TypeMemberModel.LookupMember(animal, "BaseProp", query))
        Assert.NotNull(TypeMemberModel.LookupMember(animal, "Name", query))
    }

    @Fact
    func GetMethods_InstanceOverloadSet_ReturnsAllOverloads() {
        let animal = GetStruct("Animal")
        let methods = TypeMemberModel.GetMethods(animal, "Speak", MemberQuery.Instance())
        Assert.Equal(2, methods.Length)
        Assert.All(methods, (m FunctionSymbol) -> Assert.Equal("Speak", m.Name))
    }

    @Fact
    func GetMethods_StaticOverloadSet_ReturnsAllOverloads() {
        let animal = GetStruct("Animal")
        let methods = TypeMemberModel.GetMethods(animal, "Make", MemberQuery.Static())
        Assert.Equal(2, methods.Length)
    }

    @Fact
    func ConstructorIntrospection_StaysSeparateFromOrdinaryMembers() {
        let animal = GetStruct("Animal")
        Assert.Equal(2, animal.GetConstructors().Length)
        Assert.All(animal.GetConstructors(), (constructor FunctionSymbol) -> Assert.Equal(".ctor", constructor.Name))
        Assert.DoesNotContain(animal.GetMembers(), (member Symbol) -> member.Name == ".ctor")
        Assert.Contains(animal.GetMembers(), (member Symbol) -> member.Name == "Make")
    }

    @Fact
    func GetMethods_InheritedMethod_Found() {
        let animal = GetStruct("Animal")
        let methods = TypeMemberModel.GetMethods(animal, "BaseMethod", MemberQuery.Instance())
        Assert.Single(methods)
    }

    @Fact
    func GetMethods_ShadowedMethod_DedupedToSingleSignature() {
        let animal = GetStruct("Animal")
        // Both Base and Animal declare `Shadowed() int32`; the derived one hides
        // the base entry, so the overload set contains exactly one.
        let methods = TypeMemberModel.GetMethods(animal, "Shadowed", MemberQuery.Instance())
        Assert.Single(methods)
    }

    @Fact
    func TryGetStaticField_Found() {
        let animal = GetStruct("Animal")
        Assert.True(TypeMemberModel.TryGetStaticField(animal, "Count", out var field))
        Assert.Equal("Count", field.Name)
    }

    @Fact
    func TryGetProperty_WalksBaseChain() {
        let animal = GetStruct("Animal")
        Assert.True(TypeMemberModel.TryGetProperty(animal, "BaseProp", out var prop))
        Assert.Equal("BaseProp", prop.Name)
    }

    @Fact
    func TryGetFieldIncludingInherited_OwnField_ReturnsDeclaringType() {
        let animal = GetStruct("Animal")
        Assert.True(
            TypeMemberModel.TryGetFieldIncludingInherited(
                animal,
                "legs",
                MemberQuery.Instance(),
                out var field,
                out var declaring
            )
        )
        Assert.Equal("legs", field.Name)
        Assert.Equal("Animal", declaring.Name)
    }

    @Fact
    func TryGetFieldIncludingInherited_InheritedField_ReturnsBaseDeclaringType() {
        let animal = GetStruct("Animal")
        Assert.True(
            TypeMemberModel.TryGetFieldIncludingInherited(
                animal,
                "baseField",
                MemberQuery.Instance(),
                out var field,
                out var declaring
            )
        )
        Assert.Equal("baseField", field.Name)
        Assert.Equal("Base", declaring.Name)
    }

    @Fact
    func TryGetFieldIncludingInherited_StaticField_Found() {
        let animal = GetStruct("Animal")
        Assert.True(
            TypeMemberModel.TryGetFieldIncludingInherited(
                animal,
                "Count",
                MemberQuery.Static(),
                out var field,
                out var declaring
            )
        )
        Assert.Equal("Count", field.Name)
        Assert.Equal("Animal", declaring.Name)
    }

    @Fact
    func TryGetFieldIncludingInherited_InstanceQuery_DoesNotFindStatic() {
        let animal = GetStruct("Animal")
        Assert.False(
            TypeMemberModel.TryGetFieldIncludingInherited(animal, "Count", MemberQuery.Instance(), out _, out _)
        )
    }

    @Fact
    func TryGetFieldIncludingInherited_NotInheritedQuery_DoesNotWalkBaseChain() {
        let animal = GetStruct("Animal")
        let query = MemberQuery(includeInstance: true, includeStatic: false, includeInherited: false, MemberKinds.Field)
        Assert.False(TypeMemberModel.TryGetFieldIncludingInherited(animal, "baseField", query, out _, out _))
    }

    @Fact
    func EnumerateMembers_Interface_SurfacesInstanceAndStaticMembers() {
        let shape = GetInterface("IShape")
        let names = TypeMemberModel.EnumerateMembers(shape, MemberQuery.All).Select((m Symbol) -> m.Name).ToHashSet()
        Assert.Contains("Area", names)
        Assert.Contains("Describe", names)
        Assert.Contains("Create", names)
    }

    @Fact
    func EnumerateMembers_Interface_StaticOnly_ExcludesInstance() {
        let shape = GetInterface("IShape")
        let names = TypeMemberModel
            .EnumerateMembers(shape, MemberQuery.Static())
            .Select((m Symbol) -> m.Name)
            .ToHashSet()
        Assert.Contains("Create", names)
        Assert.DoesNotContain("Describe", names)
        Assert.DoesNotContain("Area", names)
    }

    @Fact
    func ConstructedInterfaceDataMembersShareCanonicalLookupAndEnumeration() {
        let tree = SyntaxTree.Parse(SourceText.From(`import System
interface IBox[T] {
    prop Value T { get; set; }
    event Changed Action
}
interface Child : IBox[int32] { }`))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let child = compilation.GlobalScope.Interfaces.Single((s InterfaceSymbol) -> s.Name == "Child")
        let constructed = child.BaseInterfaces.Single()
        Assert.True(TypeMemberModel.TryGetPropertyWithOwner(constructed, "Value", out var property, out _))
        Assert.True(TypeMemberModel.TryGetEvent(constructed, "Changed", out var eventSymbol))
        Assert.Equal(
            []Symbol{property, eventSymbol},
            TypeMemberModel.EnumerateMembers(
                constructed,
                MemberQuery.Instance(MemberKinds.Property | MemberKinds.Event)
            )
                .ToArray()
        )
        Assert.Same(property, TypeMemberModel.LookupMember(constructed, "Value", MemberQuery.Instance()))
        Assert.Same(eventSymbol, TypeMemberModel.LookupMember(constructed, "Changed", MemberQuery.Instance()))
    }

    @Fact
    func InterfacePropertyQueriesSeparateInheritedInstanceAndDeclaredStaticMembers() {
        let tree = SyntaxTree.Parse(SourceText.From(`interface Base {
    prop Inherited int32 { get; }
    shared { prop BaseStatic int32 { get { return 9 } } }
}
interface Child : Base {
    prop Local int32 { get; }
    shared { prop Declared int32 { get { return 3 } } }
}`))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let child = compilation.GlobalScope.Interfaces.Single((s InterfaceSymbol) -> s.Name == "Child")
        Assert.Null(TypeMemberModel.LookupMember(child, "BaseStatic", MemberQuery.Instance()))
        Assert.Null(TypeMemberModel.LookupMember(child, "Declared", MemberQuery.Instance()))
        Assert.NotNull(TypeMemberModel.LookupMember(child, "Declared", MemberQuery.Static()))
        Assert.Null(TypeMemberModel.LookupMember(child, "BaseStatic", MemberQuery.Static()))
        Assert.Equal(
            []string{"Local", "Inherited"},
            TypeMemberModel
                .EnumerateMembers(child, MemberQuery.Instance(MemberKinds.Property))
                .Select((m Symbol) -> m.Name)
                .ToArray()
        )
        Assert.Equal(
            []string{"Declared"},
            TypeMemberModel
                .EnumerateMembers(child, MemberQuery.Static(MemberKinds.Property))
                .Select((m Symbol) -> m.Name)
                .ToArray()
        )
    }

    @Fact
    func EnumerateMembers_Enum_SurfacesMembers() {
        let color = GetEnum("Color")
        let names = TypeMemberModel.EnumerateMembers(color, MemberQuery.All).Select((m Symbol) -> m.Name).ToHashSet()
        Assert.Contains("Red", names)
        Assert.Contains("Green", names)
        Assert.Contains("Blue", names)
    }

    @Fact
    func EnumerateMembers_Enum_InstanceOnly_IsEmpty() {
        let color = GetEnum("Color")
        Assert.Empty(TypeMemberModel.EnumerateMembers(color, MemberQuery.Instance()))
    }

    @Fact
    func TryGetProperty_ResolvesAcrossInheritance() {
        let animal = GetStruct("Animal")
        Assert.True(TypeMemberModel.TryGetProperty(animal, "Name", out var nameProp))
        Assert.NotNull(nameProp)
        Assert.True(TypeMemberModel.TryGetProperty(animal, "BaseProp", out var baseProp))
        Assert.NotNull(baseProp)
        Assert.False(TypeMemberModel.TryGetProperty(animal, "Missing", out var missingProp))
        Assert.Null(missingProp)
    }

    @Fact
    func EnumerateMembers_Instance_IncludesInheritedFieldsPropertiesMethods() {
        let animal = GetStruct("Animal")
        let names = TypeMemberModel
            .EnumerateMembers(animal, MemberQuery.Instance())
            .Select((m Symbol) -> m.Name)
            .ToHashSet()
        Assert.Contains("Name", names)
        Assert.Contains("Speak", names)
        Assert.Contains("BaseProp", names)
        Assert.Contains("BaseMethod", names)
        Assert.DoesNotContain("Count", names) // static excluded

    }

    @Fact
    func EnumerateMembers_Static_ExcludesInstanceAndBaseChain() {
        let animal = GetStruct("Animal")
        let names = TypeMemberModel
            .EnumerateMembers(animal, MemberQuery.Static())
            .Select((m Symbol) -> m.Name)
            .ToHashSet()
        Assert.Contains("Count", names)
        Assert.Contains("Kind", names)
        Assert.Contains("Make", names)
        Assert.DoesNotContain("Name", names)
        Assert.DoesNotContain("BaseProp", names)
    }

    shared {
        private const Source string = `package P

open class Base {
    prop BaseProp int32
    var baseField int32
    func BaseMethod() int32 { return 1 }
    func Shadowed() int32 { return 0 }
}

open class Animal : Base {
    prop Name string
    var legs int32
    init() { }
    init(name string) { }
    func Speak() string { return "..." }
    func Speak(loud bool) string { return "!" }
    func Shadowed() int32 { return 1 }

    shared {
        var Count int32
        prop Kind string
        func Make() Animal { return Animal{} }
        func Make(name string) Animal { return Animal{} }
    }
}

interface IShape {
    prop Area int32 { get }
    func Describe() string;
    shared {
        func Create() string;
    }
}

enum Color {
    Red,
    Green,
    Blue,
}
`

        private func GetStruct(name string) StructSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(Source))
            let compilation = Compilation(tree)
            Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
            return cast[StructSymbol](compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == name))
        }

        private func GetInterface(name string) InterfaceSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(Source))
            let compilation = Compilation(tree)
            Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
            return compilation.GlobalScope.Interfaces.Single((s InterfaceSymbol) -> s.Name == name)
        }

        private func GetEnum(name string) EnumSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(Source))
            let compilation = Compilation(tree)
            Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
            return compilation.GlobalScope.Enums.Single((s EnumSymbol) -> s.Name == name)
        }
    }
}
