// <copyright file="Issue1924CompositeTypeArgumentInExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1924: a composite type argument (an array/slice shape `[]T`, or
/// a dotted/qualified name `Outer.Inner`) parsed fine in TYPE position
/// (`var x []Task[int32]`, per issue #1046 / #526) but failed with
/// GS0005 ("Unexpected token <CloseSquareBracketToken>, expected
/// <IdentifierToken>") in EXPRESSION position for the array-of-generic
/// literal (`[]Task[int32]{ … }`) and array-of-qualified-name literal
/// (`[]Outer.Inner{ … }`).
///
/// Root cause: `ParseArrayCreationExpression`'s flat-identifier fast path
/// matched the element type as a single (cref:SyntaxToken) and jumped
/// straight to the `{` initializer, never consuming a trailing
/// `[T, ...]` type-argument list or `.Member` qualifier tail on the
/// element name. The nested/jagged-element path (issue #1046) already routes
/// through the general `ParseTypeClause()`, which handles both shapes
/// (see `Issue1046JaggedArrayParserTests.Slice_OfGenericName_StillParses_Flat`
/// and `Slice_OfQualifiedName_StillParses_Flat` for the TYPE-position
/// equivalents); the fix widens the "route through `ParseTypeClause()`"
/// condition to also fire when the element identifier is followed by `[`
/// or `.`, generalizing the fix to the whole family of composite type
/// arguments (not just the two examples from the issue body).
///
/// The other reported repro, `List[[]object]{ … }` (a composite array
/// type ARGUMENT to a generic collection literal, as opposed to an array-OF-
/// generic literal), already parsed correctly before this fix — the
/// generic-call-site disambiguation (`LooksLikeGenericCallSite` /
/// `TryScanTypeClause`) already recurses into a bracketed type argument
/// that itself starts with `[]`. Coverage for that shape is included here
/// too, to lock in the whole family per the issue's "generalize, don't
/// special-case" convention.
open class Issue1924CompositeTypeArgumentInExpressionParserTests {
    @Fact
    func ArrayOfGeneric_Literal_Parses_WithNestedElementTypeClause() {
        // The exact repro from the issue body: `[]Task[int32]{…}`.
        let creation = GetArrayCreation("[]Task[int32]{Foo(), Bar()}")
        Assert.True(creation.HasNestedElementTypeClause)
        Assert.Null(creation.ElementTypeIdentifier)
        Assert.Equal(2, creation.Elements!!.Count)
        let elementType TypeClauseSyntax? = creation.ElementTypeClause
        Assert.Equal("Task", elementType!!.Identifier!!.Text)
        Assert.True(elementType!!.HasTypeArguments)
        Assert.Single(elementType!!.TypeArguments!!)
        Assert.Equal("int32", elementType!!.TypeArguments!![0].Identifier!!.Text)
    }

    @Fact
    func ArrayOfGeneric_Literal_WithMultipleTypeArguments_Parses() {
        let creation = GetArrayCreation("[]Dictionary[string, int32]{Make()}")
        Assert.True(creation.HasNestedElementTypeClause)
        Assert.Equal("Dictionary", creation.ElementTypeClause!!.Identifier!!.Text)
        Assert.Equal(2, creation.ElementTypeClause!!.TypeArguments!!.Count)
    }

    @Fact
    func ArrayOfQualifiedName_Literal_Parses_WithNestedElementTypeClause() {
        let creation = GetArrayCreation("[]Outer.Inner{Make()}")
        Assert.True(creation.HasNestedElementTypeClause)
        Assert.Null(creation.ElementTypeIdentifier)
        let elementType TypeClauseSyntax? = creation.ElementTypeClause
        Assert.Equal("Outer.Inner", elementType!!.DottedName)
    }

    @Fact
    func SizedArrayOfGeneric_Literal_Parses() {
        let creation = GetArrayCreation("[2]Task[int32]{Foo(), Bar()}")
        Assert.False(creation.IsRuntimeLengthAllocation)
        Assert.True(creation.HasNestedElementTypeClause)
        Assert.Equal("Task", creation.ElementTypeClause!!.Identifier!!.Text)
    }

    @Fact
    func ArrayOfGeneric_NoInitializer_RuntimeAllocationForm_Parses() {
        let creation = GetArrayCreation("[n]Task[int32]")
        Assert.True(creation.IsRuntimeLengthAllocation)
        Assert.True(creation.HasNestedElementTypeClause)
        Assert.False(creation.HasInitializer)
        Assert.Equal("Task", creation.ElementTypeClause!!.Identifier!!.Text)
    }

    // ---- Regression: existing plain-identifier element forms are unaffected. ----
    @Fact
    func ArrayOfPlainIdentifier_Literal_StillParses_Flat() {
        let creation = GetArrayCreation("[]int32{1, 2, 3}")
        Assert.False(creation.HasNestedElementTypeClause)
        Assert.Equal("int32", creation.ElementTypeIdentifier!!.Text)
        Assert.Equal(3, creation.Elements!!.Count)
    }

    @Fact
    func ArrayOfNullableIdentifier_Literal_StillParses() {
        let tree = SyntaxTree.Parse(`package P
let x = []int32?{1, 2}
`)
        Assert.Empty(tree.Diagnostics)
    }

    // ---- The other reported shape: a composite array TYPE ARGUMENT to a ----
    // ---- generic collection literal (`List[[]object]{…}`).              ----
    @Fact
    func GenericCollectionLiteral_WithArrayTypeArgument_Parses() {
        const source = `
package P
func Use() {
    var a1 = []object{1, "two"}
    var xs = List[[]object]{a1, a1}
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func GenericCollectionLiteral_WithArrayTypeArgument_ParsesAsCollectionInitializer() {
        const source = `
package P
func Use() {
    var a1 = []object{1}
    var xs = List[[]object]{a1}
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let xsDecl = fn.Body!!
            .Statements
            .OfType[VariableDeclarationSyntax]()
            .Single((d VariableDeclarationSyntax) -> d.Identifier.Text == "xs")
        let init = Assert.IsType[CollectionInitializerExpressionSyntax](xsDecl.Initializer)
        let target = Assert.IsType[CallExpressionSyntax](init.Target)
        Assert.Equal("List", target.Identifier.Text)
        Assert.NotNull(target.TypeArgumentList)
        let typeArg = Assert.Single(target.TypeArgumentList!!.Arguments)
        Assert.True(typeArg.IsSlice)
        Assert.Equal("object", typeArg.Identifier!!.Text)
    }

    shared {
        private func GetArrayCreation(initializer string) ArrayCreationExpressionSyntax {
            let tree = SyntaxTree.Parse((`package P
let x = ` + "$initializer" + `
`))
            Assert.Empty(tree.Diagnostics)
            let decl = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return Assert.IsType[ArrayCreationExpressionSyntax](decl.Initializer)
        }
    }
}
