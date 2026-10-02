// <copyright file="GSharpSourceSyntaxTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests;

/// <summary>
/// The G# half of the source guards must key diagnostic sites exactly as the C#
/// scan does, or distinct sites collapse into one shape after the cut-over and
/// a duplicated diagnostic message shape passes DiagnosticIdUniquenessTests.
/// </summary>
public class GSharpSourceSyntaxTests
{
    private const string Source = """
        package Shapes

        class First {
            init() {
                let d = Diagnostic(nil, "GS0001", 1)
            }
        }

        class Second {
            init() {
                let d = Diagnostic(nil, "GS0001", 2)
            }

            prop Value int32 {
                get {
                    let d = Diagnostic(nil, "GS0001", 3)
                    return 0
                }
                set {
                    let d = Diagnostic(nil, "GS0001", 4)
                }
            }

            func Make() {
                let d = Diagnostic(nil, "GS0001", 5)
            }
        }
        """;

    /// <summary>
    /// Two constructors in different types and a property's get and set each
    /// keep their own key, matching the C# scan (type name for constructors,
    /// <c>Property.get</c>/<c>Property.set</c> for accessors).
    /// </summary>
    [Fact]
    public void NearestMemberName_KeepsConstructorsAndAccessorsDistinct()
    {
        string path = Path.Combine(AppContext.BaseDirectory, "gsharp-source-syntax-" + Guid.NewGuid().ToString("N") + ".gs");
        File.WriteAllText(path, Source);
        try
        {
            var tree = SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(Source, path));
            var keys = tree.Root.DescendantNodes()
                .OfType<CallExpressionSyntax>()
                .Where(call => GSharpSourceSyntax.SimpleName(call) == "Diagnostic")
                .Select(GSharpSourceSyntax.NearestMemberName)
                .OrderBy(key => key, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(new[] { "First", "Make", "Second", "Value.get", "Value.set" }, keys);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
