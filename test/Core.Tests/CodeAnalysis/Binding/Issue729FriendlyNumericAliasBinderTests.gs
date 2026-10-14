// <copyright file="Issue729FriendlyNumericAliasBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #729 / ADR-0098 — friendly numeric type aliases. Confirms each alias
/// (`int`, `uint`, `long`, `ulong`, `short`,
/// `ushort`, `byte`, `sbyte`, `float`, `double`)
/// resolves to the canonical width-bearing (cref:TypeSymbol) in every
/// type-clause position (variable, parameter, return, generic argument,
/// array element). Also pins the diagnostic-stability promise: existing
/// code that already uses width-bearing names continues to bind without
/// new diagnostics, and a user-defined `type int = …` is still
/// rejected as shadowing a primitive name.
open class Issue729FriendlyNumericAliasBinderTests {
    @Theory
    @MemberData("AliasCases")
    func LetBinding_WithAliasTypeClause_ResolvesToCanonical(alias string, canonical TypeSymbol) {
        // `let x int = 1` must produce a binding whose declared type is
        // `int32` (the canonical width-bearing TypeSymbol), not a fresh
        // alias symbol. Diagnostics MUST stay empty: aliases are valid
        // type-clause spellings and need no additional error or warning.
        let result = Evaluate((`
let x ` + "$alias" + ` = ` + "${DefaultLiteral(alias)}" + `
`))
        Assert.Empty(result.Diagnostics)
        let variable VariableSymbol? = LookupGlobalVariable(result.Compilation, "x")
        Assert.NotNull(variable)
        Assert.Same(canonical, variable!!.Type)
    }

    @Theory
    @MemberData("AliasCases")
    func Function_ParameterAndReturnAliases_ResolveToCanonical(alias string, canonical TypeSymbol) {
        // Parameter and return-type positions both go through the same
        // `LookupType` table, but we exercise them explicitly so the
        // contract is visible in tests rather than implied.
        let result = Evaluate((`
func id(x ` + "$alias" + `) ` + "$alias" + ` { return x }
`))
        Assert.Empty(result.Diagnostics)
        let fn = result.Compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "id")
        Assert.Same(canonical, fn.Parameters[0].Type)
        Assert.Same(canonical, fn.Type)
    }

    @Theory
    @MemberData("AliasCases")
    func ArrayElementType_AliasResolvesToCanonical(alias string, canonical TypeSymbol) {
        // Slice / array element type positions: `[]int` must resolve to a
        // slice of `int32`, ensuring the alias is recognised by
        // BindTypeClause's element-type recursion (not only the outer
        // type-clause path).
        let result = Evaluate((`
let xs []` + "$alias" + ` = []` + "$alias" + `{ ` + "${DefaultLiteral(alias)}" + ` }
`))
        Assert.Empty(result.Diagnostics)
        let variable VariableSymbol? = LookupGlobalVariable(result.Compilation, "xs")
        Assert.NotNull(variable)
        Assert.IsType[SliceTypeSymbol](variable!!.Type)
        let element = (cast[SliceTypeSymbol](variable!!.Type)).ElementType
        Assert.Same(canonical, element)
    }

    @Theory
    @MemberData("AliasCases")
    func GenericTypeArgument_AliasResolvesToCanonical(alias string, canonical TypeSymbol) {
        // Generic type-argument positions: `Box[int]` must resolve the
        // alias the same way as `Box[int32]`. We declare a tiny generic
        // helper so we do not depend on any imported CLR type.
        let result = Evaluate((`
struct Box[T any] {
    var Value T
}

let b Box[` + "$alias" + `] = Box[` + "$alias" + `]{ Value: ` + "${DefaultLiteral(alias)}" + ` }
`))
        Assert.Empty(result.Diagnostics)
        let variable VariableSymbol? = LookupGlobalVariable(result.Compilation, "b")
        Assert.NotNull(variable)
        // The generic-applied type's TypeArguments[0] must be the
        // canonical width-bearing TypeSymbol.
        let typeArg TypeSymbol? = ExtractFirstGenericArgument(variable!!.Type)
        Assert.Same(canonical, typeArg)
    }

    @Fact
    func CanonicalNames_ContinueToResolveUnchanged() {
        // Diagnostic-stability promise: any program written entirely in
        // canonical width-bearing names binds clean and is unaffected by
        // the new alias table.
        let result = Evaluate(`
let i int32 = 1
let l int64 = 2L
let b uint8 = uint8(3)
let f float32 = 4.0F
let d float64 = 5.0
func add(a int32, b int32) int32 { return a + b }
`)
        Assert.Empty(result.Diagnostics)
        Assert.Same(TypeSymbol.Int32, LookupGlobalVariable(result.Compilation, "i")!!.Type)
        Assert.Same(TypeSymbol.Int64, LookupGlobalVariable(result.Compilation, "l")!!.Type)
        Assert.Same(TypeSymbol.UInt8, LookupGlobalVariable(result.Compilation, "b")!!.Type)
        Assert.Same(TypeSymbol.Float32, LookupGlobalVariable(result.Compilation, "f")!!.Type)
        Assert.Same(TypeSymbol.Float64, LookupGlobalVariable(result.Compilation, "d")!!.Type)
    }

    @Fact
    func MixedAliasAndCanonical_AreInterchangeable() {
        // An alias parameter calling a canonical-typed function (and
        // vice-versa) must bind without any conversion diagnostic — they
        // refer to the same TypeSymbol instance, so overload and
        // conversion machinery treats them as identical.
        let result = Evaluate(`
func canonical(x int32) int32 { return x + 1 }
func alias(x int) int { return canonical(x) }
let a int = alias(10)
let b int32 = canonical(a)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Same(TypeSymbol.Int32, LookupGlobalVariable(result.Compilation, "a")!!.Type)
        Assert.Same(TypeSymbol.Int32, LookupGlobalVariable(result.Compilation, "b")!!.Type)
    }

    @Theory
    @InlineData("int")
    @InlineData("uint")
    @InlineData("long")
    @InlineData("ulong")
    @InlineData("short")
    @InlineData("ushort")
    @InlineData("byte")
    @InlineData("sbyte")
    @InlineData("float")
    @InlineData("double")
    func TypeAliasDeclaration_ShadowingFriendlyAlias_IsRejected(alias string) {
        // ADR-0098 pins aliases as reserved primitive type names rather
        // than identifier-resolution fallbacks — the same protection that
        // already prevents `type int32 = string` rejects `type int = string`.
        let result = Evaluate((`
type ` + "$alias" + ` = string
`))
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    /// Lightweight wrapper so tests can keep the existing concise pattern of
    /// `var result = Evaluate(...)` while also reaching the
    /// (cref:Compilation) needed to inspect bound types.
    private class EvaluationResultWithCompilation {
        init(diagnostics ImmutableArray[Diagnostic], compilation Compilation) {
            Diagnostics = diagnostics
            Compilation = compilation
        }

        prop Diagnostics ImmutableArray[Diagnostic] {
            get;
        }

        prop Compilation Compilation {
            get;
        }
    }

    shared {
        prop AliasCases IEnumerable[[]object] -> [][]object{
            []object{"int", TypeSymbol.Int32},
            []object{"uint", TypeSymbol.UInt32},
            []object{"long", TypeSymbol.Int64},
            []object{"ulong", TypeSymbol.UInt64},
            []object{"short", TypeSymbol.Int16},
            []object{"ushort", TypeSymbol.UInt16},
            []object{"byte", TypeSymbol.UInt8},
            []object{"sbyte", TypeSymbol.Int8},
            []object{"float", TypeSymbol.Float32},
            []object{"double", TypeSymbol.Float64}
        }

        private func DefaultLiteral(alias string) string {
            // Use an explicit cast to the alias so the literal's type matches
            // the expected variable / element / field type without depending on
            // numeric-conversion behaviour the binder might apply only in some
            // positions (e.g. constant-int-in-range folding).
            return "$alias(1)"
        }

        private func LookupGlobalVariable(compilation Compilation, name string) VariableSymbol? -> compilation
            .GlobalScope
            .Variables
            .FirstOrDefault((v VariableSymbol) -> v.Name == name)

        private func ExtractFirstGenericArgument(type TypeSymbol) TypeSymbol? {
            if type is StructSymbol structSymbol && !structSymbol.TypeArguments.IsDefaultOrEmpty {
                return structSymbol.TypeArguments[0]
            }
            if type is ImportedTypeSymbol importedSymbol && !importedSymbol.TypeArguments.IsDefaultOrEmpty {
                return importedSymbol.TypeArguments[0]
            }
            return nil
        }

        // Binder-inspection helper (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's bound
        // state; nothing needs to run.
        private func Evaluate(source string) EvaluationResultWithCompilation {
            let syntaxTree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(syntaxTree)
            let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
            return EvaluationResultWithCompilation(diagnostics, compilation)
        }
    }
}
