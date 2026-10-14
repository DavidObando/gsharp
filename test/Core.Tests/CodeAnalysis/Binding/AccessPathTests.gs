// <copyright file="AccessPathTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import System
import System.Collections.Immutable
import System.Reflection
import Xunit

open class AccessPathTests {
    @Fact
    func MembersExposeTypedPathMemberCollection() {
        let property PropertyInfo? = typeof(AccessPath).GetProperty("Members")
        Assert.NotNull(property)
        Assert.Equal(typeof(ImmutableArray[PathMember]), property!!.PropertyType)
    }

    @Fact
    func ClrMemberIdentityUsesModuleAndMetadataToken() {
        let intProperty PropertyInfo? = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.AccessPathTests+GenericFixture`1")
            .MakeGenericType(typeof(int32))
            .GetProperty("Value")
        let stringProperty PropertyInfo? = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.AccessPathTests+GenericFixture`1")
            .MakeGenericType(typeof(string))
            .GetProperty("Value")
        Assert.NotNull(intProperty)
        Assert.NotNull(stringProperty)
        Assert.NotSame(intProperty, stringProperty)
        let root = LocalVariableSymbol("value", isReadOnly: true, TypeSymbol.Object)
        let first = AccessPath.ForVariable(root).Append(intProperty!!)
        let second = AccessPath.ForVariable(root).Append(stringProperty!!)
        // Closed generic instantiations share metadata identity; root identity fixes the constructed receiver type.
        Assert.Equal(first, second)
        Assert.True(first.StartsWith(second))
        Assert.Equal(first.GetHashCode(), second.GetHashCode())
    }
}
