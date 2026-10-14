// <copyright file="ResxIdentifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Resx

import GSharp.Core.Resx
import System.Collections.Generic
import Xunit

open class ResxIdentifierTests {
    @Fact
    func ToPropertyIdentifier_SimpleKey_PassesThrough() {
        let used = HashSet[string]()
        Assert.Equal("Greeting", ResxIdentifier.ToPropertyIdentifier("Greeting", used))
    }

    @Fact
    func ToPropertyIdentifier_InvalidCharacters_AreReplacedWithUnderscore() {
        let used = HashSet[string]()
        Assert.Equal("Some_Key_With_Spaces", ResxIdentifier.ToPropertyIdentifier("Some Key With Spaces", used))
    }

    @Fact
    func ToPropertyIdentifier_LeadingDigit_IsPrefixedWithUnderscore() {
        let used = HashSet[string]()
        Assert.Equal("_1Item", ResxIdentifier.ToPropertyIdentifier("1Item", used))
    }

    @Fact
    func ToPropertyIdentifier_ReservedKeyword_GetsNumericSuffix() {
        let used = HashSet[string]()
        Assert.Equal("class1", ResxIdentifier.ToPropertyIdentifier("class", used))
    }

    @Fact
    func ToPropertyIdentifier_CollidesWithFixedAccessor_GetsNumericSuffix() {
        let used = HashSet[string]{"ResourceManager"}
        Assert.Equal("ResourceManager1", ResxIdentifier.ToPropertyIdentifier("ResourceManager", used))
    }

    @Fact
    func ToPropertyIdentifier_DuplicateSanitizedNames_AreDisambiguated() {
        let used = HashSet[string]()
        let first = ResxIdentifier.ToPropertyIdentifier("A B", used)
        let second = ResxIdentifier.ToPropertyIdentifier("A.B", used)
        Assert.Equal("A_B", first)
        Assert.Equal("A_B1", second)
    }
}
