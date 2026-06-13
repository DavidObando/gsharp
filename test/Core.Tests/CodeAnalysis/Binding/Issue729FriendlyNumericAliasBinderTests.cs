// <copyright file="Issue729FriendlyNumericAliasBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #729 / ADR-0098 — friendly numeric type aliases. Confirms each alias
/// (<c>int</c>, <c>uint</c>, <c>long</c>, <c>ulong</c>, <c>short</c>,
/// <c>ushort</c>, <c>byte</c>, <c>sbyte</c>, <c>float</c>, <c>double</c>)
/// resolves to the canonical width-bearing <see cref="TypeSymbol"/> in every
/// type-clause position (variable, parameter, return, generic argument,
/// array element). Also pins the diagnostic-stability promise: existing
/// code that already uses width-bearing names continues to bind without
/// new diagnostics, and a user-defined <c>type int = …</c> is still
/// rejected as shadowing a primitive name.
/// </summary>
public class Issue729FriendlyNumericAliasBinderTests
{
    public static IEnumerable<object[]> AliasCases => new[]
    {
        new object[] { "int", TypeSymbol.Int32 },
        new object[] { "uint", TypeSymbol.UInt32 },
        new object[] { "long", TypeSymbol.Int64 },
        new object[] { "ulong", TypeSymbol.UInt64 },
        new object[] { "short", TypeSymbol.Int16 },
        new object[] { "ushort", TypeSymbol.UInt16 },
        new object[] { "byte", TypeSymbol.UInt8 },
        new object[] { "sbyte", TypeSymbol.Int8 },
        new object[] { "float", TypeSymbol.Float32 },
        new object[] { "double", TypeSymbol.Float64 },
    };

    [Theory]
    [MemberData(nameof(AliasCases))]
    public void LetBinding_WithAliasTypeClause_ResolvesToCanonical(string alias, TypeSymbol canonical)
    {
        // `let x int = 1` must produce a binding whose declared type is
        // `int32` (the canonical width-bearing TypeSymbol), not a fresh
        // alias symbol. Diagnostics MUST stay empty: aliases are valid
        // type-clause spellings and need no additional error or warning.
        var result = Evaluate($@"
let x {alias} = {DefaultLiteral(alias)}
");

        Assert.Empty(result.Diagnostics);
        var variable = LookupGlobalVariable(result.Compilation, "x");
        Assert.NotNull(variable);
        Assert.Same(canonical, variable.Type);
    }

    [Theory]
    [MemberData(nameof(AliasCases))]
    public void Function_ParameterAndReturnAliases_ResolveToCanonical(string alias, TypeSymbol canonical)
    {
        // Parameter and return-type positions both go through the same
        // `LookupType` table, but we exercise them explicitly so the
        // contract is visible in tests rather than implied.
        var result = Evaluate($@"
func id(x {alias}) {alias} {{ return x }}
");

        Assert.Empty(result.Diagnostics);
        var fn = result.Compilation.GlobalScope.Functions.Single(f => f.Name == "id");
        Assert.Same(canonical, fn.Parameters[0].Type);
        Assert.Same(canonical, fn.Type);
    }

    [Theory]
    [MemberData(nameof(AliasCases))]
    public void ArrayElementType_AliasResolvesToCanonical(string alias, TypeSymbol canonical)
    {
        // Slice / array element type positions: `[]int` must resolve to a
        // slice of `int32`, ensuring the alias is recognised by
        // BindTypeClause's element-type recursion (not only the outer
        // type-clause path).
        var result = Evaluate($@"
let xs []{alias} = []{alias}{{ {DefaultLiteral(alias)} }}
");

        Assert.Empty(result.Diagnostics);
        var variable = LookupGlobalVariable(result.Compilation, "xs");
        Assert.NotNull(variable);
        Assert.IsType<SliceTypeSymbol>(variable.Type);
        var element = ((SliceTypeSymbol)variable.Type).ElementType;
        Assert.Same(canonical, element);
    }

    [Theory]
    [MemberData(nameof(AliasCases))]
    public void GenericTypeArgument_AliasResolvesToCanonical(string alias, TypeSymbol canonical)
    {
        // Generic type-argument positions: `Box[int]` must resolve the
        // alias the same way as `Box[int32]`. We declare a tiny generic
        // helper so we do not depend on any imported CLR type.
        var result = Evaluate($@"
struct Box[T any] {{
    var Value T
}}

let b Box[{alias}] = Box[{alias}]{{ Value: {DefaultLiteral(alias)} }}
");

        Assert.Empty(result.Diagnostics);
        var variable = LookupGlobalVariable(result.Compilation, "b");
        Assert.NotNull(variable);

        // The generic-applied type's TypeArguments[0] must be the
        // canonical width-bearing TypeSymbol.
        var typeArg = ExtractFirstGenericArgument(variable.Type);
        Assert.Same(canonical, typeArg);
    }

    [Fact]
    public void CanonicalNames_ContinueToResolveUnchanged()
    {
        // Diagnostic-stability promise: any program written entirely in
        // canonical width-bearing names binds clean and is unaffected by
        // the new alias table.
        var result = Evaluate(@"
let i int32 = 1
let l int64 = 2L
let b uint8 = uint8(3)
let f float32 = 4.0F
let d float64 = 5.0
func add(a int32, b int32) int32 { return a + b }
");

        Assert.Empty(result.Diagnostics);
        Assert.Same(TypeSymbol.Int32, LookupGlobalVariable(result.Compilation, "i").Type);
        Assert.Same(TypeSymbol.Int64, LookupGlobalVariable(result.Compilation, "l").Type);
        Assert.Same(TypeSymbol.UInt8, LookupGlobalVariable(result.Compilation, "b").Type);
        Assert.Same(TypeSymbol.Float32, LookupGlobalVariable(result.Compilation, "f").Type);
        Assert.Same(TypeSymbol.Float64, LookupGlobalVariable(result.Compilation, "d").Type);
    }

    [Fact]
    public void MixedAliasAndCanonical_AreInterchangeable()
    {
        // An alias parameter calling a canonical-typed function (and
        // vice-versa) must bind without any conversion diagnostic — they
        // refer to the same TypeSymbol instance, so overload and
        // conversion machinery treats them as identical.
        var result = Evaluate(@"
func canonical(x int32) int32 { return x + 1 }
func alias(x int) int { return canonical(x) }
let a int = alias(10)
let b int32 = canonical(a)
");

        Assert.Empty(result.Diagnostics);
        Assert.Same(TypeSymbol.Int32, LookupGlobalVariable(result.Compilation, "a").Type);
        Assert.Same(TypeSymbol.Int32, LookupGlobalVariable(result.Compilation, "b").Type);
    }

    [Theory]
    [InlineData("int")]
    [InlineData("uint")]
    [InlineData("long")]
    [InlineData("ulong")]
    [InlineData("short")]
    [InlineData("ushort")]
    [InlineData("byte")]
    [InlineData("sbyte")]
    [InlineData("float")]
    [InlineData("double")]
    public void TypeAliasDeclaration_ShadowingFriendlyAlias_IsRejected(string alias)
    {
        // ADR-0098 pins aliases as reserved primitive type names rather
        // than identifier-resolution fallbacks — the same protection that
        // already prevents `type int32 = string` rejects `type int = string`.
        var result = Evaluate($@"
type {alias} = string
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0102");
    }

    private static string DefaultLiteral(string alias)
    {
        // Use an explicit cast to the alias so the literal's type matches
        // the expected variable / element / field type without depending on
        // numeric-conversion behaviour the binder might apply only in some
        // positions (e.g. constant-int-in-range folding).
        return $"{alias}(1)";
    }

    private static VariableSymbol LookupGlobalVariable(Compilation compilation, string name)
        => compilation.GlobalScope.Variables.FirstOrDefault(v => v.Name == name);

    private static TypeSymbol ExtractFirstGenericArgument(TypeSymbol type)
    {
        if (type is StructSymbol structSymbol && !structSymbol.TypeArguments.IsDefaultOrEmpty)
        {
            return structSymbol.TypeArguments[0];
        }

        if (type is ImportedTypeSymbol importedSymbol && !importedSymbol.TypeArguments.IsDefaultOrEmpty)
        {
            return importedSymbol.TypeArguments[0];
        }

        return null;
    }

    private static (EvaluationResult Result, Compilation Compilation) EvaluateInternal(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return (result, compilation);
    }

    private static EvaluationResultWithCompilation Evaluate(string source)
    {
        var (result, compilation) = EvaluateInternal(source);
        return new EvaluationResultWithCompilation(result, compilation);
    }

    /// <summary>
    /// Lightweight wrapper so tests can keep the existing concise pattern of
    /// <c>var result = Evaluate(...)</c> while also reaching the
    /// <see cref="Compilation"/> needed to inspect bound types.
    /// </summary>
    private sealed class EvaluationResultWithCompilation
    {
        public EvaluationResultWithCompilation(EvaluationResult inner, Compilation compilation)
        {
            Inner = inner;
            Compilation = compilation;
        }

        public EvaluationResult Inner { get; }

        public Compilation Compilation { get; }

        public System.Collections.Immutable.ImmutableArray<Diagnostic> Diagnostics => Inner.Diagnostics;
    }
}
