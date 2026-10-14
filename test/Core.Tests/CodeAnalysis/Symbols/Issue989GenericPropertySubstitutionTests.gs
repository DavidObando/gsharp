// <copyright file="Issue989GenericPropertySubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #989 regression coverage at the member-resolution layer: constructing
/// a generic class with a concrete type argument must carry the property table
/// across with the property type substituted, so a generic auto-property
/// `prop Value T` resolves on `Box[int32]` as `int32` — the same
/// behavior a generic field already had. Before the fix
/// (cref:StructSymbol) construction substituted only fields, so
/// (cref:TypeMemberModel.TryGetProperty(TypeSymbol, string, out PropertySymbol))
/// returned `false` on the constructed type (the binder then
/// reported GS0158).
open class Issue989GenericPropertySubstitutionTests {
    @Fact
    func Construct_GenericAutoProperty_SubstitutesPropertyType() {
        let box = GetStruct("Box")
        let constructed = StructSymbol.Construct(box, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.True(TypeMemberModel.TryGetProperty(constructed, "Value", out var prop))
        Assert.Same(TypeSymbol.Int32, prop.Type)
    }

    @Fact
    func Construct_GenericProperty_MatchesGenericFieldSubstitution() {
        let box = GetStruct("Box")
        let constructed = StructSymbol.Construct(box, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.True(
            TypeMemberModel.TryGetFieldIncludingInherited(
                constructed,
                "field",
                MemberQuery.Instance(MemberKinds.Field),
                out var field,
                out _
            )
        )
        Assert.True(TypeMemberModel.TryGetProperty(constructed, "Value", out var prop))
        // The property type now substitutes exactly like the field type.
        Assert.Same(field.Type, prop.Type)
        Assert.Same(TypeSymbol.Int32, prop.Type)
    }

    shared {
        private const Source string = `package P

class Box[T] {
    prop Value T { get; set; }
    var field T
}
`

        private func GetStruct(name string) StructSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(Source))
            let compilation = Compilation(tree)
            Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
            return cast[StructSymbol](compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == name))
        }
    }
}
