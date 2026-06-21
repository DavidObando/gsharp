// <copyright file="TypeMemberModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0112 Phase 3: unit coverage for the canonical member-resolution layer
/// (<see cref="TypeMemberModel"/>) — by-name lookup across kinds, the
/// inheritance walk, static/instance filters, overload sets with signature
/// dedup, and enumeration for completion.
/// </summary>
public class TypeMemberModelTests
{
    private const string Source = @"package P

open class Base {
    prop BaseProp int32
    var baseField int32
    func BaseMethod() int32 { return 1 }
    func Shadowed() int32 { return 0 }
}

open class Animal : Base {
    prop Name string
    var legs int32
    func Speak() string { return ""..."" }
    func Speak(loud bool) string { return ""!"" }
    func Shadowed() int32 { return 1 }

    shared {
        var Count int32
        prop Kind string
        func Make() Animal { return Animal{} }
        func Make(name string) Animal { return Animal{} }
    }
}
";

    [Fact]
    public void LookupMember_InstanceProperty_Found()
    {
        var animal = GetStruct("Animal");
        var member = TypeMemberModel.LookupMember(animal, "Name", MemberQuery.All);
        Assert.IsType<PropertySymbol>(member);
    }

    [Fact]
    public void LookupMember_InheritedProperty_Found()
    {
        var animal = GetStruct("Animal");
        var member = TypeMemberModel.LookupMember(animal, "BaseProp", MemberQuery.All);
        Assert.IsType<PropertySymbol>(member);
    }

    [Fact]
    public void LookupMember_StaticField_Found()
    {
        var animal = GetStruct("Animal");
        var member = TypeMemberModel.LookupMember(animal, "Count", MemberQuery.All);
        Assert.IsType<FieldSymbol>(member);
    }

    [Fact]
    public void LookupMember_InstanceMethod_Found()
    {
        var animal = GetStruct("Animal");
        var member = TypeMemberModel.LookupMember(animal, "Speak", MemberQuery.All);
        Assert.IsType<FunctionSymbol>(member);
    }

    [Fact]
    public void LookupMember_StaticOnlyQuery_DoesNotFindInstanceMember()
    {
        var animal = GetStruct("Animal");
        var member = TypeMemberModel.LookupMember(animal, "Name", MemberQuery.Static());
        Assert.Null(member);
    }

    [Fact]
    public void LookupMember_InstanceOnlyQuery_DoesNotFindStaticMember()
    {
        var animal = GetStruct("Animal");
        var member = TypeMemberModel.LookupMember(animal, "Count", MemberQuery.Instance());
        Assert.Null(member);
    }

    [Fact]
    public void LookupMember_NotInheritedQuery_DoesNotWalkBaseChain()
    {
        var animal = GetStruct("Animal");
        var query = new MemberQuery(includeInstance: true, includeStatic: true, includeInherited: false, MemberKinds.All);
        Assert.Null(TypeMemberModel.LookupMember(animal, "BaseProp", query));
        Assert.NotNull(TypeMemberModel.LookupMember(animal, "Name", query));
    }

    [Fact]
    public void GetMethods_InstanceOverloadSet_ReturnsAllOverloads()
    {
        var animal = GetStruct("Animal");
        var methods = TypeMemberModel.GetMethods(animal, "Speak", MemberQuery.Instance());
        Assert.Equal(2, methods.Length);
        Assert.All(methods, m => Assert.Equal("Speak", m.Name));
    }

    [Fact]
    public void GetMethods_StaticOverloadSet_ReturnsAllOverloads()
    {
        var animal = GetStruct("Animal");
        var methods = TypeMemberModel.GetMethods(animal, "Make", MemberQuery.Static());
        Assert.Equal(2, methods.Length);
    }

    [Fact]
    public void GetMethods_InheritedMethod_Found()
    {
        var animal = GetStruct("Animal");
        var methods = TypeMemberModel.GetMethods(animal, "BaseMethod", MemberQuery.Instance());
        Assert.Single(methods);
    }

    [Fact]
    public void GetMethods_ShadowedMethod_DedupedToSingleSignature()
    {
        var animal = GetStruct("Animal");
        // Both Base and Animal declare `Shadowed() int32`; the derived one hides
        // the base entry, so the overload set contains exactly one.
        var methods = TypeMemberModel.GetMethods(animal, "Shadowed", MemberQuery.Instance());
        Assert.Single(methods);
    }

    [Fact]
    public void TryGetStaticField_Found()
    {
        var animal = GetStruct("Animal");
        Assert.True(TypeMemberModel.TryGetStaticField(animal, "Count", out var field));
        Assert.Equal("Count", field.Name);
    }

    [Fact]
    public void TryGetProperty_WalksBaseChain()
    {
        var animal = GetStruct("Animal");
        Assert.True(TypeMemberModel.TryGetProperty(animal, "BaseProp", out var prop));
        Assert.Equal("BaseProp", prop.Name);
    }

    [Fact]
    public void EnumerateMembers_Instance_IncludesInheritedFieldsPropertiesMethods()
    {
        var animal = GetStruct("Animal");
        var names = TypeMemberModel.EnumerateMembers(animal, MemberQuery.Instance())
            .Select(m => m.Name)
            .ToHashSet();
        Assert.Contains("Name", names);
        Assert.Contains("Speak", names);
        Assert.Contains("BaseProp", names);
        Assert.Contains("BaseMethod", names);
        Assert.DoesNotContain("Count", names); // static excluded
    }

    [Fact]
    public void EnumerateMembers_Static_ExcludesInstanceAndBaseChain()
    {
        var animal = GetStruct("Animal");
        var names = TypeMemberModel.EnumerateMembers(animal, MemberQuery.Static())
            .Select(m => m.Name)
            .ToHashSet();
        Assert.Contains("Count", names);
        Assert.Contains("Kind", names);
        Assert.Contains("Make", names);
        Assert.DoesNotContain("Name", names);
        Assert.DoesNotContain("BaseProp", names);
    }

    private static StructSymbol GetStruct(string name)
    {
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);
        return (StructSymbol)compilation.GlobalScope.Structs.Single(s => s.Name == name);
    }
}
