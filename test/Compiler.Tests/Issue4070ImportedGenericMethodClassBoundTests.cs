// <copyright file="Issue4070ImportedGenericMethodClassBoundTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Xunit;

namespace GSharp.Compiler.Tests;

public class Issue4070ImportedGenericMethodClassBoundTests
{
    [Fact]
    public void ExactIssue4086Repro_ExplicitAndInferredCallsSelectGenericOverload()
    {
        const string csSource = """
            namespace HelperLib2;

            public class DisposableBase : System.IDisposable
            {
                public void Dispose()
                {
                }
            }

            public static class Overloads
            {
                public static string Take<T>(T value)
                    where T : System.IDisposable
                    => "generic-disposable";

                public static string Take(object value)
                    => "object";
            }
            """;

        const string gsSource = """
            package P
            import System
            import HelperLib2

            func explicitCall[T DisposableBase](value T) string {
                return Overloads.Take[T](value)
            }

            func inferredCall[T DisposableBase](value T) string {
                return Overloads.Take(value)
            }

            var value = DisposableBase()
            Console.WriteLine(explicitCall[DisposableBase](value))
            Console.WriteLine(inferredCall[DisposableBase](value))
            """;

        Assert.Equal(
            $"generic-disposable{Environment.NewLine}generic-disposable{Environment.NewLine}",
            ImportedMemberMatrixTests.CompileAndRunWithSiblingCs(
                csSource,
                gsSource,
                "HelperLib2"));
    }
}
