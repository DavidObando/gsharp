// <copyright file="Issue4777InheritedDataEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class Issue4777InheritedDataEqualityTests
{
    [Fact]
    public void NativeClrTypedCallsWithoutInterface_CompareMostDerivedFieldsAndPreservePlainMethods()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            package NoInterface
            public open data class Root(Tag int32)
            public open data class Middle(Tag int32, Value int32) : Root(Tag)
            public data class Leaf(Tag int32, Value int32, Extra int32) : Middle(Tag, Value)
            public class Plain {
                public func Equals(other Plain?) bool -> false
            }
            """)) { IsLibrary = true };
        using var image = new MemoryStream();
        var result = compilation.Emit(image);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        image.Position = 0;
        var context = new AssemblyLoadContext(nameof(Issue4777InheritedDataEqualityTests), isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(image);
            var root = assembly.GetType("NoInterface.Root", throwOnError: true);
            var middle = assembly.GetType("NoInterface.Middle", throwOnError: true);
            var leaf = assembly.GetType("NoInterface.Leaf", throwOnError: true);
            var plain = assembly.GetType("NoInterface.Plain", throwOnError: true);
            Assert.Empty(root.GetInterfaces());
            Assert.Empty(leaf.GetInterfaces());
            Assert.Empty(plain.GetInterfaces());
            var slot = middle.GetMethod("Equals", new[] { root });
            Assert.NotNull(slot);
            Assert.True(slot.IsVirtual);
            Assert.True(slot.IsFinal);
            Assert.Equal(root, slot.GetBaseDefinition().DeclaringType);
            var first = Activator.CreateInstance(leaf, 1, 2, 3);
            var different = Activator.CreateInstance(leaf, 1, 2, 4);
            var same = Activator.CreateInstance(leaf, 1, 2, 3);
            foreach (var owner in new[] { root, middle, leaf })
            {
                var equals = owner.GetMethod("Equals", new[] { owner });
                Assert.NotNull(equals);
                Assert.Equal(false, equals.Invoke(first, new[] { different }));
                Assert.Equal(true, equals.Invoke(first, new[] { same }));
                Assert.Equal(true, equals.Invoke(first, new[] { first }));
                Assert.Equal(false, equals.Invoke(first, new object[] { null }));
            }

            var ordinary = plain.GetMethod("Equals", new[] { plain });
            Assert.NotNull(ordinary);
            Assert.False(ordinary.IsVirtual);
        }
        finally
        {
            context.Unload();
        }
    }

    [Fact]
    public void UserAuthoredTypedBaseOverride_RemainsReserved()
    {
        var result = EmittedOracle.Evaluate("""
            open data class Root(Tag int32)
            data class Leaf(Tag int32, Extra int32) : Root(Tag) {
                public override func Equals(other Root?) bool -> false
            }
            0
            """);
        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0232");
        Assert.Contains("Data class 'Leaf' synthesizes member 'Equals'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("class Plain : IEquatable[Plain] {}")]
    [InlineData("data class Wrong(Value int32) : IEquatable[string]")]
    public void CompilerOwnedEquality_DoesNotSatisfyWrongOrPlainContract(string declaration)
    {
        var compilation = new Compilation(SyntaxTree.Parse("import System\n" + declaration)) { IsLibrary = true };
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        Assert.Contains(diagnostics, d => d.Id == "GS0187");
    }
}
