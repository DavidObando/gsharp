// <copyright file="ResxIdentifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.Resx;
using Xunit;

namespace GSharp.Core.Tests.Resx;

public class ResxIdentifierTests
{
    [Fact]
    public void ToPropertyIdentifier_SimpleKey_PassesThrough()
    {
        var used = new HashSet<string>();
        Assert.Equal("Greeting", ResxIdentifier.ToPropertyIdentifier("Greeting", used));
    }

    [Fact]
    public void ToPropertyIdentifier_InvalidCharacters_AreReplacedWithUnderscore()
    {
        var used = new HashSet<string>();
        Assert.Equal("Some_Key_With_Spaces", ResxIdentifier.ToPropertyIdentifier("Some Key With Spaces", used));
    }

    [Fact]
    public void ToPropertyIdentifier_LeadingDigit_IsPrefixedWithUnderscore()
    {
        var used = new HashSet<string>();
        Assert.Equal("_1Item", ResxIdentifier.ToPropertyIdentifier("1Item", used));
    }

    [Fact]
    public void ToPropertyIdentifier_ReservedKeyword_GetsNumericSuffix()
    {
        var used = new HashSet<string>();
        Assert.Equal("class1", ResxIdentifier.ToPropertyIdentifier("class", used));
    }

    [Fact]
    public void ToPropertyIdentifier_CollidesWithFixedAccessor_GetsNumericSuffix()
    {
        var used = new HashSet<string> { "ResourceManager" };
        Assert.Equal("ResourceManager1", ResxIdentifier.ToPropertyIdentifier("ResourceManager", used));
    }

    [Fact]
    public void ToPropertyIdentifier_DuplicateSanitizedNames_AreDisambiguated()
    {
        var used = new HashSet<string>();
        var first = ResxIdentifier.ToPropertyIdentifier("A B", used);
        var second = ResxIdentifier.ToPropertyIdentifier("A.B", used);

        Assert.Equal("A_B", first);
        Assert.Equal("A_B1", second);
    }
}
