// <copyright file="BoundScopeNullKeyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import Xunit

open class BoundScopeNullKeyTests {
    // A null symbol name must never reach a Dictionary key, which would throw
    // ArgumentNullException ("Value cannot be null. (Parameter 'key')") and crash the
    // whole language-server request (diagnostics, inlay hints, semantic tokens, code lens).
    @Fact
    func TryLookupSymbol_NullName_ReturnsNullWithoutThrowing() {
        let scope_ = BoundScope(nil, ReferenceResolver.Default())
        let result Symbol? = scope_.TryLookupSymbol(nil)
        Assert.Null(result)
    }

    @Fact
    func TryLookupTypeAlias_NullName_ReturnsFalseWithoutThrowing() {
        let scope_ = BoundScope(nil, ReferenceResolver.Default())
        let found = scope_.TryLookupTypeAlias(nil, out var type)
        Assert.False(found)
        Assert.Null(type)
    }

    @Fact
    func TryDeclareTypeAlias_NullName_ReturnsFalseWithoutThrowing() {
        let scope_ = BoundScope(nil, ReferenceResolver.Default())
        let declared = scope_.TryDeclareTypeAlias(nil, TypeSymbol.Int32)
        Assert.False(declared)
    }
}
