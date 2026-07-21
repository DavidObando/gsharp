// <copyright file="Issue2638DeepImportedBaseLookupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2638DeepImportedBaseLookupTests
{
    [Fact]
    public void PartialAggregateWalk_FindsDeepPublicMemberOnce()
    {
        var type = new PartialAggregateType(typeof(Leaf));

        var methods = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(type, nameof(Root.Apply));

        Assert.Single(methods);
        Assert.Equal(typeof(Root), methods[0].DeclaringType);
    }

    [Fact]
    public void DeepOverloads_DifferingByGenericArity_AreNotDeduplicated()
    {
        Assert.Equal(
            2,
            MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
                new PartialAggregateType(typeof(Leaf)),
                nameof(Root.Generic)).Count);
    }

    [Theory]
    [InlineData("Protected")]
    [InlineData(nameof(Root.Internal))]
    [InlineData("Private")]
    public void DeepNonPublicMembers_AreExcluded(string name)
    {
        Assert.Empty(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(
            new PartialAggregateType(typeof(Leaf)),
            name));
    }

    private class Root
    {
        public string Apply(string value) => value;

        public void Generic()
        {
        }

        public void Generic<T>()
        {
        }

        protected void Protected()
        {
        }

        internal void Internal()
        {
        }

        private void Private()
        {
        }
    }

    private class Mid : Root
    {
        public void Distractor()
        {
        }
    }

    private sealed class Leaf : Mid
    {
    }

    private sealed class PartialAggregateType : TypeDelegator
    {
        private readonly Type delegatedType;

        public PartialAggregateType(Type delegatedType)
            : base(delegatedType)
        {
            this.delegatedType = delegatedType;
        }

        public override MethodInfo[] GetMethods(BindingFlags bindingAttr)
        {
            var methods = base.GetMethods(bindingAttr);
            return (bindingAttr & BindingFlags.DeclaredOnly) == 0
                ? methods.Where(method => method.Name == nameof(Mid.Distractor)).ToArray()
                : methods;
        }

        public override Type BaseType => delegatedType.BaseType;
    }
}
