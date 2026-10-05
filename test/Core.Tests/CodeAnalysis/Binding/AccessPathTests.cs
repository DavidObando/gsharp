// <copyright file="AccessPathTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class AccessPathTests
{
    [Fact]
    public void MembersExposeTypedPathMemberCollection()
    {
        var property = typeof(AccessPath).GetProperty(nameof(AccessPath.Members));

        Assert.NotNull(property);
        Assert.Equal(typeof(ImmutableArray<PathMember>), property.PropertyType);
    }

    [Fact]
    public void ClrMemberIdentityUsesModuleAndMetadataToken()
    {
        var intProperty = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.AccessPathTests+GenericFixture`1").MakeGenericType(typeof(int)).GetProperty("Value");
        var stringProperty = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.AccessPathTests+GenericFixture`1").MakeGenericType(typeof(string)).GetProperty("Value");

        Assert.NotNull(intProperty);
        Assert.NotNull(stringProperty);
        Assert.NotSame(intProperty, stringProperty);

        var root = new LocalVariableSymbol("value", isReadOnly: true, TypeSymbol.Object);
        var first = AccessPath.ForVariable(root).Append(intProperty);
        var second = AccessPath.ForVariable(root).Append(stringProperty);

        // Closed generic instantiations share metadata identity; root identity fixes the constructed receiver type.
        Assert.Equal(first, second);
        Assert.True(first.StartsWith(second));
        Assert.Equal(first.GetHashCode(), second.GetHashCode());
    }
}
