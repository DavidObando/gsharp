// <copyright file="Issue1621ConstructedGenericCacheKeyTests.cs" company="GSharp">
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

/// Issue #1621 regression coverage: constructed-generic caches ((cref:StructSymbol),
/// (cref:InterfaceSymbol), (cref:DelegateTypeSymbol)) used to key on a stringified
/// `RuntimeHelpers.GetHashCode` per type argument. That hash is at most 31 bits and is NOT an
/// identity — two distinct, live (cref:TypeSymbol) instances can collide, which would make
/// `Construct(def, [B])` silently return a cached instantiation for a different argument
/// `A`. The fix ((cref:TypeArgsKey)) compares type-argument vectors by REFERENCE
/// identity per element instead, so the cache can never conflate two distinct arguments regardless
/// of what their identity hashes happen to be.
open class Issue1621ConstructedGenericCacheKeyTests {
    @Fact
    func TypeArgsKey_Equals_IsReferenceIdentityPerElement_NotHashBased() {
        let keyInt = TypeArgsKey(ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        let keyBool = TypeArgsKey(ImmutableArray.Create[TypeSymbol](TypeSymbol.Bool))
        let keyIntAgain = TypeArgsKey(ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        // Distinct type arguments must never compare equal, no matter what their
        // RuntimeHelpers.GetHashCode values happen to be.
        Assert.False(keyInt.Equals(keyBool))
        // The same argument reference, wrapped independently, must still compare equal.
        Assert.True(keyInt.Equals(keyIntAgain))
    }

    @Fact
    func Construct_WithDistinctTypeArguments_NeverAliasesDistinctInstantiations() {
        let box = GetStruct("Box")
        let boxInt = StructSymbol.Construct(box, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        let boxBool = StructSymbol.Construct(box, ImmutableArray.Create[TypeSymbol](TypeSymbol.Bool))
        let boxIntAgain = StructSymbol.Construct(box, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.NotSame(boxInt, boxBool)
        Assert.Same(boxInt, boxIntAgain)
    }

    shared {
        private const Source string = `package P

class Box[T] {
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
