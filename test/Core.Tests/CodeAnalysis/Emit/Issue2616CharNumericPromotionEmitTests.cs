// <copyright file="Issue2616CharNumericPromotionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>Issue #2616 emitter proof for the exact Oahu subtraction.</summary>
public class Issue2616CharNumericPromotionEmitTests
{
    [Fact]
    public void ExactOahuKeyCharSubtraction_EmitsAndExecutesAsInt32()
    {
        const string Source = """
            package Oahu.Cli.Tui
            import System

            func tabIndex(key ConsoleKeyInfo) int32 {
                let idx = key.KeyChar - '1'
                return idx
            }
            """;

        using var pe = new MemoryStream();
        var result = new Compilation(SyntaxTree.Parse(SourceText.From(Source))).Emit(pe);
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        pe.Position = 0;
        var context = new AssemblyLoadContext(nameof(ExactOahuKeyCharSubtraction_EmitsAndExecutesAsInt32), isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(pe);
            var method = assembly.GetTypes().SelectMany(t => t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                .Single(m => m.Name == "tabIndex");
            Assert.Equal(4, method.Invoke(null, new object[] { new ConsoleKeyInfo('5', ConsoleKey.D5, false, false, false) }));
        }
        finally
        {
            context.Unload();
        }
    }

    [Fact]
    public void CheckedLiftedCharCompound_EmitsOverflowCheck()
    {
        const string Source = """
            package P

            func add(charValue char?) char? {
                var result = charValue
                checked {
                    result += 65536
                }
                return result
            }

            func addOperator(charValue char?, amount uint32?) char? {
                var result = charValue
                checked {
                    result += amount
                }
                return result
            }

            func addDecimal(charValue char?, amount decimal?) char? {
                var result = charValue
                checked {
                    result += amount
                }
                return result
            }
            """;

        using var pe = new MemoryStream();
        var result = new Compilation(SyntaxTree.Parse(SourceText.From(Source))).Emit(pe);
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        pe.Position = 0;
        var context = new AssemblyLoadContext(nameof(CheckedLiftedCharCompound_EmitsOverflowCheck), isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(pe);
            var methods = assembly.GetTypes().SelectMany(t => t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic));
            AssertOverflow(methods.Single(m => m.Name == "add"), (char?)'A');
            AssertOverflow(methods.Single(m => m.Name == "addOperator"), (char?)'A', (uint?)uint.MaxValue);
            AssertOverflow(methods.Single(m => m.Name == "addDecimal"), (char?)'A', (decimal?)65536m);
        }
        finally
        {
            context.Unload();
        }

        static void AssertOverflow(MethodInfo method, params object[] arguments)
        {
            var exception = Assert.Throws<TargetInvocationException>(() => method.Invoke(null, arguments));
            Assert.IsType<OverflowException>(exception.InnerException);
        }
    }
}
