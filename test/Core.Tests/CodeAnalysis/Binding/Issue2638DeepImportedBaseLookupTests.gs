// <copyright file="Issue2638DeepImportedBaseLookupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import System
import System.Linq
import System.Reflection
import Xunit

class Issue2638DeepImportedBaseLookupTests {
    @Fact
    func PartialAggregateWalk_FindsDeepPublicMemberOnce() {
        let type = PartialAggregateType(typeof(Issue2638DeepImportedBaseLookupTests.Leaf))
        let methods = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(type, "Apply")
        Assert.Single(methods)
        Assert.Equal(typeof(Root), methods[0].DeclaringType)
    }

    @Fact
    func DeepOverloads_DifferingByGenericArity_AreNotDeduplicated() {
        Assert.Equal(
            2,
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                PartialAggregateType(typeof(Issue2638DeepImportedBaseLookupTests.Leaf)),
                "Generic"
            )
                .Count
        )
    }

    @Theory
    @InlineData("Protected")
    @InlineData("Internal")
    @InlineData("Private")
    func DeepNonPublicMembers_AreExcluded(name string) {
        Assert.Empty(
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                PartialAggregateType(typeof(Issue2638DeepImportedBaseLookupTests.Leaf)),
                name
            )
        )
    }

    private open class Root {
        func Apply(value string) string -> value

        func Generic() { }

        func Generic[T]() { }

        protected func Protected() { }

        internal func Internal() { }

        private func Private() { }
    }

    private open class Mid : Root {
        func Distractor() { }
    }

    private class Leaf : Mid { }

    private class PartialAggregateType : TypeDelegator {
        private let delegatedType Type

        init(delegatedType Type) : base(delegatedType) {
            this.delegatedType = delegatedType
        }

        override func GetMethods(bindingAttr BindingFlags)[]MethodInfo {
            let methods = base.GetMethods(bindingAttr)
            return if (bindingAttr & BindingFlags.DeclaredOnly) == 0 {
                methods.Where((method MethodInfo) -> method.Name == "Distractor").ToArray()
            } else {
                methods
            }
        }

        override prop BaseType Type? -> delegatedType.BaseType
    }
}
