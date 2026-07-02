// <copyright file="Issue1621ConstructedGenericCacheKeyTests.cs" company="GSharp">
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
/// Issue #1621 regression coverage: constructed-generic caches (<see cref="StructSymbol"/>,
/// <see cref="InterfaceSymbol"/>, <see cref="DelegateTypeSymbol"/>) used to key on a stringified
/// <c>RuntimeHelpers.GetHashCode</c> per type argument. That hash is at most 31 bits and is NOT an
/// identity — two distinct, live <see cref="TypeSymbol"/> instances can collide, which would make
/// <c>Construct(def, [B])</c> silently return a cached instantiation for a different argument
/// <c>A</c>. The fix (<see cref="TypeArgsKey"/>) compares type-argument vectors by REFERENCE
/// identity per element instead, so the cache can never conflate two distinct arguments regardless
/// of what their identity hashes happen to be.
/// </summary>
public class Issue1621ConstructedGenericCacheKeyTests
{
    private const string Source = @"package P

class Box[T] {
    var field T
}
";

    [Fact]
    public void TypeArgsKey_Equals_IsReferenceIdentityPerElement_NotHashBased()
    {
        var keyInt = new TypeArgsKey(ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var keyBool = new TypeArgsKey(ImmutableArray.Create<TypeSymbol>(TypeSymbol.Bool));
        var keyIntAgain = new TypeArgsKey(ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));

        // Distinct type arguments must never compare equal, no matter what their
        // RuntimeHelpers.GetHashCode values happen to be.
        Assert.False(keyInt.Equals(keyBool));

        // The same argument reference, wrapped independently, must still compare equal.
        Assert.True(keyInt.Equals(keyIntAgain));
    }

    [Fact]
    public void Construct_WithDistinctTypeArguments_NeverAliasesDistinctInstantiations()
    {
        var box = GetStruct("Box");

        var boxInt = StructSymbol.Construct(box, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var boxBool = StructSymbol.Construct(box, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Bool));
        var boxIntAgain = StructSymbol.Construct(box, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));

        Assert.NotSame(boxInt, boxBool);
        Assert.Same(boxInt, boxIntAgain);
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
