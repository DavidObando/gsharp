// <copyright file="Issue989GenericPropertySubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #989 regression coverage at the member-resolution layer: constructing
/// a generic class with a concrete type argument must carry the property table
/// across with the property type substituted, so a generic auto-property
/// <c>prop Value T</c> resolves on <c>Box[int32]</c> as <c>int32</c> — the same
/// behavior a generic field already had. Before the fix
/// <see cref="StructSymbol"/> construction substituted only fields, so
/// <see cref="TypeMemberModel.TryGetProperty(TypeSymbol, string, out PropertySymbol)"/>
/// returned <see langword="false"/> on the constructed type (the binder then
/// reported GS0158).
/// </summary>
public class Issue989GenericPropertySubstitutionTests
{
    private const string Source = @"package P

class Box[T] {
    prop Value T { get; set; }
    var field T
}
";

    [Fact]
    public void Construct_GenericAutoProperty_SubstitutesPropertyType()
    {
        var box = GetStruct("Box");
        var constructed = StructSymbol.Construct(box, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));

        Assert.True(TypeMemberModel.TryGetProperty(constructed, "Value", out var prop));
        Assert.Same(TypeSymbol.Int32, prop.Type);
    }

    [Fact]
    public void Construct_GenericProperty_MatchesGenericFieldSubstitution()
    {
        var box = GetStruct("Box");
        var constructed = StructSymbol.Construct(box, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));

        Assert.True(TypeMemberModel.TryGetFieldIncludingInherited(
            constructed,
            "field",
            MemberQuery.Instance(MemberKinds.Field),
            out var field,
            out _));
        Assert.True(TypeMemberModel.TryGetProperty(constructed, "Value", out var prop));

        // The property type now substitutes exactly like the field type.
        Assert.Same(field.Type, prop.Type);
        Assert.Same(TypeSymbol.Int32, prop.Type);
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
