// <copyright file="Issue4938TypeClauseScannerParityTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import Xunit

/// Issue #4938: `LooksLikeGenericCallSite` decides whether `name[...]` is a
/// generic call by running the speculative scanner `TryScanTypeClauseCore`
/// over each bracketed argument. The scanner is a hand-written twin of the
/// real `ParseTypeClause`, and the two drifted: the scanner had no branch for
/// the raw function-pointer clause `unmanaged[CC] (T) -> R`, so
/// `cast[unmanaged[Cdecl] () -> int32](address)` parsed as an indexer on a
/// variable `cast` (GS0125 / GS0130).
///
/// These tests pin parity between the two. Every type-clause production
/// `ParseTypeClause` accepts has a row in (cref:Forms); each row must parse
/// cleanly in a type annotation AND be recognised by the scanner as the
/// single type argument of `cast[T](x)`. The coverage test reflects over
/// (cref:TypeClauseSyntax) so a new production (a new token slot or `Is*`
/// shape) fails here until it gets a row, and with it a scanner check.
open class Issue4938TypeClauseScannerParityTests {
    @Theory
    @InlineData("unmanaged[Cdecl] () -> int32")
    @InlineData("unmanaged[Cdecl]() -> int32")
    @InlineData("unmanaged[Stdcall] (int32, *uint8) -> void")
    @InlineData("unmanaged () -> int32")
    @InlineData("unmanaged (nint, nint) -> nint")
    @InlineData("unmanaged[Cdecl, SuppressGCTransition] (nint) -> nint")
    @InlineData("unmanaged[Cdecl] (unmanaged[Cdecl] (int32) -> int32) -> int32")
    @InlineData("unmanaged[Cdecl] () -> int32?")
    @InlineData("(unmanaged[Cdecl] () -> int32)?")
    @InlineData("[]unmanaged[Cdecl] () -> int32")
    @InlineData("unmanaged[Cdecl] (nint, *uint8) -> *void")
    func Cast_To_FunctionPointer_Parses_As_Generic_Call(typeText string) {
        let (tree, call) = ParseCast(typeText)
        AssertNoErrors(tree)
        let argument = Assert.Single(call.TypeArgumentList!!.Arguments)
        AssertWholeTypeArgument(call, typeText)
        Assert.Contains(
            argument.DescendantNodesAndSelf().OfType[TypeClauseSyntax](),
            (clause TypeClauseSyntax) -> clause.IsFunctionPointer && !clause.IsManagedFunctionPointer
        )
    }

    @Fact
    func Cast_To_FunctionPointer_Keeps_The_Whole_Signature_On_The_Type_Argument() {
        let (tree, call) = ParseCast("unmanaged[Cdecl, SuppressGCTransition] (int32, nint) -> uint8")
        AssertNoErrors(tree)
        let argument = Assert.Single(call.TypeArgumentList!!.Arguments)
        Assert.True(argument.IsFunctionPointer)
        Assert.Equal("Cdecl", argument.CallingConventionIdentifierToken!!.Text)
        Assert.Equal(2, argument.FunctionParameterTypes!!.Count)
        Assert.Equal("uint8", argument.ReturnTypeClause!!.Identifier!!.Text)
        let operand = Assert.IsType[NameExpressionSyntax](Assert.Single(call.Arguments))
        Assert.Equal("address", operand.IdentifierToken.Text)
    }

    @Fact
    func Array_Of_FunctionPointer_Annotation_Nests_The_FunctionPointer_Element() {
        // Issue #4938 audit: the array-element dispatch in ParseTypeClauseCore
        // sent every identifier-headed element down the flat named-type path,
        // so `[]unmanaged[Cdecl] () -> int32` read `unmanaged` as the element's
        // type name (GS0113) and `int32` as a stray expression (GS0125).
        let clause = ParseAnnotation("[]unmanaged[Cdecl] () -> int32", out var tree)
        AssertNoErrors(tree)
        Assert.True(clause.IsArray)
        let element = clause.ArrayElementType!!
        Assert.True(element.IsFunctionPointer)
        Assert.Equal("Cdecl", element.CallingConventionIdentifierToken!!.Text)
        Assert.Equal("int32", element.ReturnTypeClause!!.Identifier!!.Text)
    }

    @Theory
    @MemberData("FormRows")
    func Every_TypeClause_Form_Parses_Clean_As_An_Annotation(typeText string) {
        let clause = ParseAnnotation(typeText, out var tree)
        AssertNoErrors(tree)
        Assert.NotNull(clause)
        // The type clause consumed the whole written type: nothing was left
        // over to start another statement. (Clause spans are not used here;
        // a parenthesised clause's span omits its own parentheses.)
        Assert.Single(tree.Root.Members)
    }

    @Theory
    @MemberData("FormRows")
    func Every_TypeClause_Form_Is_Scanned_As_A_Cast_Type_Argument(typeText string) {
        let (tree, call) = ParseCast(typeText)
        AssertNoErrors(tree)
        Assert.Single(call.TypeArgumentList!!.Arguments)
        AssertWholeTypeArgument(call, typeText)
    }

    @Fact
    func Every_TypeClause_Shape_Has_A_Form_Row() {
        // Reflect over every token slot and `Is*` shape predicate of
        // TypeClauseSyntax; each must be exercised by at least one row of
        // Forms (on the annotation's root clause or any nested clause). A new
        // production adds a slot or a predicate, so it lands here until a row
        // — and therefore a scanner-parity check — is added for it.
        let properties = typeof(TypeClauseSyntax)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where(
            (property PropertyInfo) -> property.GetIndexParameters()
                .Length == 0 &&
                (
                property.PropertyType == typeof(SyntaxToken) ||
                    (property.PropertyType == typeof(bool) && property.Name.StartsWith("Is", StringComparison.Ordinal))
            )
        )
            .ToArray()
        Assert.NotEmpty(properties)
        Assert.Contains(properties, (property PropertyInfo) -> property.Name == "UnmanagedKeyword")
        let covered = HashSet[string](StringComparer.Ordinal)
        for typeText in Forms {
            let root = ParseAnnotation(typeText, out var tree)
            AssertNoErrors(tree)
            for clause in root.DescendantNodesAndSelf().OfType[TypeClauseSyntax]() {
                for property in properties {
                    let value = property.GetValue(clause)
                    if value is bool flag {
                        if flag {
                            covered.Add(property.Name)
                        }
                    } else if value != nil {
                        covered.Add(property.Name)
                    }
                }
            }
        }
        let missing = properties
            .Select((property PropertyInfo) -> property.Name)
            .Where((name string) -> !covered.Contains(name) && !NotAFormOfItsOwn.Contains(name))
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
        Assert.True(missing.Length == 0, "TypeClauseSyntax shapes with no row in Forms: " + string.Join(", ", missing))
    }

    @Theory
    @InlineData("*int32")
    @InlineData("**uint8")
    @InlineData("*func(*int32) int32")
    @InlineData("[]*uint8")
    @InlineData("unmanaged[Cdecl] () -> (*uint8)")
    @InlineData("(*int32)")
    @InlineData("*func() *uint8")
    func Cast_To_Pointer_Parses_As_Generic_Call_Without_GS0521(typeText string) {
        // ADR-0167: `cast` is reserved in call position, so its bracket is a
        // conversion target rather than a CLR generic instantiation. Pointer
        // and function-pointer targets are therefore legal there and must
        // not report GS0521.
        let (tree, call) = ParseCast(typeText)
        AssertNoErrors(tree)
        Assert.Single(call.TypeArgumentList!!.Arguments)
        AssertWholeTypeArgument(call, typeText)
    }

    @Fact
    func Pointer_Shaped_Index_On_A_Non_Cast_Name_Stays_An_Indexer() {
        // `*p` is ALSO a dereference expression, so outside the reserved
        // `cast` intrinsic `xs[*p](y)` must stay an indexer-then-call.
        let tree = Parse("let probe = xs[*p](y)\n")
        AssertNoErrors(tree)
        let initializer = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
            .Initializer
        Assert.False(initializer is CallExpressionSyntax{TypeArgumentList: TypeArgumentListSyntax})
        Assert.Empty(initializer!!.DescendantNodesAndSelf().OfType[TypeArgumentListSyntax]())
    }

    @Theory
    @InlineData("receiver.cast[*p](y)")
    @InlineData("receiver?.cast[*p](y)")
    @InlineData("receiver->cast[*p](y)")
    func Member_Named_Cast_Is_Not_The_Intrinsic(expression string) {
        // Only the unqualified `cast[T](x)` is the reserved intrinsic. A
        // member named `cast` keeps the ordinary generic-argument rules, so
        // `*p` there is still a dereference inside an indexer. (`p->m` is
        // pointer member access only inside an unsafe context.)
        let tree = Parse("unsafe func probe() {\n    let v = " + expression + "\n}\n")
        AssertNoErrors(tree)
        Assert.Empty(tree.Root.DescendantNodesAndSelf().OfType[TypeArgumentListSyntax]())
    }

    @Fact
    func Variable_Named_Cast_Indexed_By_A_Dereference_Stays_An_Indexer() {
        // ADR-0167 reserves `cast` only in call position. Indexing a
        // variable named `cast` with `*p` and then accessing a member is not
        // a call, so the pointer permission must not turn `[*p]` into a type
        // argument list (which would also report GS0521).
        let tree = Parse("unsafe func count(cast [][]int32, p *int32) int32 {\n    return cast[*p].Length\n}\n")
        AssertNoErrors(tree)
        Assert.Empty(tree.Root.DescendantNodesAndSelf().OfType[TypeArgumentListSyntax]())
    }

    @Theory
    @InlineData("receiver.cast[unmanaged[Cdecl] () -> int32](address)")
    @InlineData("cast[unmanaged[Cdecl] () -> int32]{}")
    @InlineData("Make[unmanaged[Cdecl] () -> int32](address)")
    @InlineData("Make[*func() int32](address)")
    func FunctionPointer_Type_Argument_Outside_The_Cast_Call_Reports_GS0521(expression string) {
        // Only the called `cast[T](x)` intrinsic waives GS0521; an ordinary
        // generic instantiation (and a `cast[T]{…}` composite) still cannot
        // take a pointer or function-pointer type argument.
        let tree = Parse("let probe = " + expression + "\n")
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0521")
    }

    shared {
        /// One spelling per production of `ParseTypeClauseCore`, including
        /// the nested and suffixed shapes that historically drifted.
        private let Forms[]string = []string{
            "int32",
            "int32?",
            "System.Collections.Generic.List[int32]",
            "List[int32].Enumerator",
            "Dictionary[string, List[int32]]",
            "[]int32",
            "[3]int32",
            "[,]int32",
            "[][]int32",
            "[]?int32",
            "[]?[]int32",
            "[]int32?",
            "(int32, string)",
            "(int32, string)?",
            "(line int32, column int32)",
            "(int32) -> string",
            "(...int32) -> void",
            "((int32) -> string)?",
            "func(int32) string",
            "async (int32) -> string",
            "async func(int32) string",
            "sequence[int32]",
            "async sequence[int32]",
            "map[string, int32]",
            "chan[int32]",
            "chan[int32]?",
            "in chan[int32]",
            "out chan[int32]",
            "readonly slice[int32]",
            "span[int32]",
            "readonly span[int32]",
            "[]readonly span[int32]",
            "(readonly span[int32]) -> int32",
            "(int32, readonly span[int32]) -> int32",
            "readonly managed[int32]",
            "*func(int32) int32",
            "unmanaged[Cdecl] (int32) -> int32",
            "unmanaged (int32) -> int32",
            "unmanaged[Cdecl, SuppressGCTransition] () -> void",
            "(unmanaged[Cdecl] () -> int32)?",
            "[]unmanaged[Cdecl] () -> int32",
            "[](unmanaged[Cdecl] () -> int32)",
            "unmanaged[Cdecl] (nint, *uint8) -> *void",
            "*int32",
            "*int32?",
            "**uint8"
        }

        /// Shapes that are not productions of their own, with the reason.
        private let NotAFormOfItsOwn HashSet[string] = HashSet[string](
            []string{
                // The retired `chan T` spelling reports GS0567 by design.
                "IsLegacyChanSpelling"
            },
            StringComparer.Ordinal
        )

        private const AnnotationPrefix string = "var probe "
        private const CastPrefix string = "let probe = cast["

        /// Parse errors only: the deprecated `func(T) R` spelling (still a
        /// production, GS0303) carries a warning by design.
        private func AssertNoErrors(tree SyntaxTree) {
            Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.IsError)
        }

        /// The scanner took the whole written type as the single type
        /// argument: its list closes right after the type text.
        private func AssertWholeTypeArgument(call CallExpressionSyntax, typeText string) {
            let list = call.TypeArgumentList!!
            Assert.Equal(CastPrefix.Length - 1, list.OpenBracketToken.Span.Start)
            Assert.Equal(CastPrefix.Length + typeText.Length, list.CloseBracketToken.Span.Start)
        }

        func FormRows() sequence[[]object] {
            for form in Forms {
                yield[]object{form}
            }
        }

        private func Parse(source string) SyntaxTree -> SyntaxTree.Parse(SourceText.From(source, "Test.gs"))

        private func ParseAnnotation(typeText string, out tree SyntaxTree) TypeClauseSyntax {
            tree = Parse(AnnotationPrefix + typeText + "\n")
            let declaration = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return declaration.TypeClause!!
        }

        private func ParseCastOrNil(typeText string)(Tree SyntaxTree, Call CallExpressionSyntax?) {
            let tree = Parse(CastPrefix + typeText + "](address)\n")
            let declaration = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return (tree, declaration.Initializer as CallExpressionSyntax)
        }

        private func ParseCast(typeText string)(Tree SyntaxTree, Call CallExpressionSyntax) {
            let (tree, call) = ParseCastOrNil(typeText)
            let generic = Assert.IsType[CallExpressionSyntax](call)
            Assert.Equal("cast", generic.Identifier.Text)
            Assert.NotNull(generic.TypeArgumentList)
            return (tree, generic)
        }
    }
}
